/**
 * Unit tests for RealtimeServiceV2 H0 fix (2026-05-03)
 *
 * Verifies that unsubscribe() explicitly calls client.unsubscribeMarket(tokenIds)
 * to send {operation: "unsubscribe", assets_ids: [...]} to the Polymarket WS server.
 *
 * Without this fix, server accumulates subscriptions → capacity exhausted →
 * silent drop → observed 38.5% crypto / 81% cs2 / 1.4% weather miss rate.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RealtimeServiceV2 } from '../../services/realtime-service-v2.js';

// Minimal mock for RealTimeDataClient — only the methods referenced in the H0 fix path
function makeMockClient() {
  return {
    unsubscribeMarket: vi.fn(),
    subscribeMarket: vi.fn(),
    subscribe: vi.fn(),
    send: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
}

describe('RealtimeServiceV2 — H0 fix: unsubscribe sends explicit UNSUBSCRIBE to server', () => {
  let service: RealtimeServiceV2;
  let mockClient: ReturnType<typeof makeMockClient>;

  beforeEach(() => {
    service = new RealtimeServiceV2({ debug: false, autoReconnect: false });
    mockClient = makeMockClient();

    // Inject mock client + set connected=true (bypasses real WS connection)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).client = mockClient;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).connected = true;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('calls client.unsubscribeMarket with the subscribed tokenIds when unsubscribe() is called', () => {
    const tokenIds = ['token-aaa', 'token-bbb'];

    const sub = service.subscribeMarkets(tokenIds, {});

    // Reset call count from subscribeMarkets (scheduleMergedMarketSubscription → timer)
    mockClient.unsubscribeMarket.mockClear();

    sub.unsubscribe();

    expect(mockClient.unsubscribeMarket).toHaveBeenCalledTimes(1);
    expect(mockClient.unsubscribeMarket).toHaveBeenCalledWith(tokenIds);
  });

  it('removes tokenIds from accumulatedMarketTokenIds after unsubscribe', () => {
    const tokenIds = ['token-ccc', 'token-ddd'];
    const sub = service.subscribeMarkets(tokenIds, {});

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const accumulated = (service as any).accumulatedMarketTokenIds as Set<string>;
    expect(accumulated.has('token-ccc')).toBe(true);
    expect(accumulated.has('token-ddd')).toBe(true);

    sub.unsubscribe();

    expect(accumulated.has('token-ccc')).toBe(false);
    expect(accumulated.has('token-ddd')).toBe(false);
  });

  it('does NOT call client.unsubscribeMarket when not connected (connected=false)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).connected = false;

    const tokenIds = ['token-eee'];
    const sub = service.subscribeMarkets(tokenIds, {});
    mockClient.unsubscribeMarket.mockClear();

    sub.unsubscribe();

    expect(mockClient.unsubscribeMarket).not.toHaveBeenCalled();
  });

  it('does NOT call client.unsubscribeMarket when client is null', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).client = null;

    const tokenIds = ['token-fff'];
    const sub = service.subscribeMarkets(tokenIds, {});

    sub.unsubscribe();

    // mock was already replaced with null — just verify no throw
    expect(mockClient.unsubscribeMarket).not.toHaveBeenCalled();
  });

  it('still removes subscription from internal map even if unsubscribeMarket throws', () => {
    mockClient.unsubscribeMarket.mockImplementation(() => {
      throw new Error('simulated WS send failure');
    });

    const tokenIds = ['token-ggg'];
    const sub = service.subscribeMarkets(tokenIds, {});

    // Should NOT throw
    expect(() => sub.unsubscribe()).not.toThrow();

    // Subscription should be removed from internal map
    expect(service.getActiveSubscriptions().find(s => s.id === sub.id)).toBeUndefined();
  });

  it('only unsubscribes tokens from the removed subscription, not other active subscriptions', () => {
    const tokenIds1 = ['token-111'];
    const tokenIds2 = ['token-222'];

    const sub1 = service.subscribeMarkets(tokenIds1, {});
    service.subscribeMarkets(tokenIds2, {});

    mockClient.unsubscribeMarket.mockClear();

    sub1.unsubscribe();

    // Should only unsubscribe token-111, not token-222
    expect(mockClient.unsubscribeMarket).toHaveBeenCalledTimes(1);
    expect(mockClient.unsubscribeMarket).toHaveBeenCalledWith(tokenIds1);

    // token-222 should still be in accumulated set
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const accumulated = (service as any).accumulatedMarketTokenIds as Set<string>;
    expect(accumulated.has('token-222')).toBe(true);
  });
});
