/**
 * Unit tests for RealtimeServiceV2 sub-ack timeout (Fix-B).
 *
 * Context: task-investigate-30pct-ob-miss (2026-05-08).
 *
 * The 60s pendingSubAck watchdog (realtime-service-v2.ts:724-748) is
 * supposed to log CRITICAL when a tokenId is subscribed but no inbound
 * event arrives within 60s. In production this NEVER fired despite tokens
 * going un-acked for 5+ minutes (zero "CRITICAL" hits across 7-day rotation
 * of market-data-crypto-out.log).
 *
 * Root cause: market-data instantiated RealtimeServiceV2 without a `logger:`
 * config, so logAlways() falls through to poly-sdk's internal createModuleLogger
 * which is a no-op until a host calls setLogger(). market-data never did.
 *
 * Fix: pass a structured logger into the constructor so logAlways() can route
 * to PM2 stdout.
 *
 * These tests verify the timer actually fires CRITICAL on the injected logger
 * when expected, and that ack arrival cancels the warning.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { RealtimeServiceV2 } from '../../services/realtime-service-v2.js';

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

function makeMockLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe('RealtimeServiceV2 — sub-ack timeout fires CRITICAL on injected logger (Fix-B)', () => {
  let service: RealtimeServiceV2;
  let mockClient: ReturnType<typeof makeMockClient>;
  let logger: ReturnType<typeof makeMockLogger>;

  beforeEach(() => {
    // Mock both setTimeout/clearTimeout AND Date.now() — the SUB_ACK_TIMEOUT_MS
    // check inside scheduleSubAckTimeoutCheck() compares Date.now() to the
    // recorded sentAt, so without faking Date the comparison uses real wall-clock
    // and the stale check returns false even after vi.advanceTimersByTime(60_000).
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    logger = makeMockLogger();
    service = new RealtimeServiceV2({ debug: false, autoReconnect: false, logger });
    mockClient = makeMockClient();

    // Inject mock client + connected=true to bypass real WS connection
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).client = mockClient;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).connected = true;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('emits a "WS sub sent" info log via the injected logger when subscribeMarkets is called', () => {
    service.subscribeMarkets(['token-aaa', 'token-bbb'], {});

    // scheduleMergedMarketSubscription has a 100ms debounce
    vi.advanceTimersByTime(100);

    // Find the "WS sub sent" info call (other info calls may exist for SDK chatter)
    const infoCalls = logger.info.mock.calls.map(c => String(c[0]));
    expect(infoCalls.some(m => m.includes('WS sub sent'))).toBe(true);
  });

  it('fires CRITICAL on the injected logger after 60s when no event arrives for the subscribed tokens', () => {
    service.subscribeMarkets(['silent-token-1', 'silent-token-2'], {});

    // Trigger merged subscription send (100ms debounce)
    vi.advanceTimersByTime(100);

    // Sanity: pendingSubAck must contain our tokens
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pending = (service as any).pendingSubAck as Map<string, number>;
    expect(pending.size).toBeGreaterThan(0);
    expect(pending.has('silent-token-1')).toBe(true);

    // No CRITICAL yet — within 60s window
    expect(logger.error).not.toHaveBeenCalled();

    // Advance well past the 60s boundary — CRITICAL must fire
    vi.advanceTimersByTime(61_000);
    expect(logger.error).toHaveBeenCalled();

    // Verify the message says CRITICAL and includes at least one un-acked token sample
    const errorMessages = logger.error.mock.calls.map(c => String(c[0]));
    const critMsg = errorMessages.find(m => m.includes('CRITICAL'));
    expect(critMsg).toBeDefined();
    expect(critMsg).toContain('NO ACK');
    expect(critMsg).toMatch(/silent-token|unacked_tokens: \d+/); // sample or count
  });

  it('does NOT fire CRITICAL when an inbound event arrives before the 60s timeout (ack cancels watchdog)', () => {
    service.subscribeMarkets(['quick-token'], {});

    // Trigger merged subscription send
    vi.advanceTimersByTime(100);

    // Simulate an inbound orderbook event for quick-token at t=10s.
    // observeMarketAck is private; we exercise it by emitting on the EE directly.
    const ee = service as unknown as EventEmitter;
    vi.advanceTimersByTime(10_000);
    // observeMarketAck is called from the orderbook handler in handleMessage;
    // call it directly via the private API since we don't run the real msg pipe.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).observeMarketAck('quick-token');

    // Advance past 60s — should NOT fire CRITICAL since the token was acked
    vi.advanceTimersByTime(60_000);

    const errorMessages = logger.error.mock.calls.map(c => String(c[0]));
    const critMsg = errorMessages.find(m => m.includes('CRITICAL'));
    expect(critMsg).toBeUndefined();

    // Sanity: confirm we silenced the EE listener leak warning by referencing ee
    expect(ee).toBeDefined();
  });

  it('fires CRITICAL only for un-acked tokens when SOME tokens ack and others do not', () => {
    service.subscribeMarkets(['acked-token', 'silent-token'], {});

    vi.advanceTimersByTime(100);

    // Ack only the first token at t=5s
    vi.advanceTimersByTime(5_000);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).observeMarketAck('acked-token');

    // Advance past 60s — CRITICAL should fire for silent-token only
    vi.advanceTimersByTime(60_000);

    const errorMessages = logger.error.mock.calls.map(c => String(c[0]));
    const critMsg = errorMessages.find(m => m.includes('CRITICAL'));
    expect(critMsg).toBeDefined();
    // Should reference the silent token in the sample
    expect(critMsg!).toContain('silent-token'.slice(-8));
    // Should NOT reference the acked token in the unacked sample
    // (we accept either: not present, OR if present we still don't fail the assertion
    // because slice(-8) of 'acked-token' is 'ed-token' which doesn't appear in
    // 'silent-token' tail 'nt-token' — different. Safe to assert non-presence.)
    expect(critMsg!).not.toContain('ed-token@'); // sample format: <last8>@<ageMs>ms
  });
});
