/**
 * Unit tests for Fix-E: RealtimeServiceV2 propagates injected logger
 * down to its 3 child RealTimeDataClient instances (MARKET / USER / LIVE_DATA).
 *
 * Context: task-fix-market-data-ws-subscribe Fix-E (2026-05-08).
 *
 * Pre-fix: hosts injected `logger:` into RealtimeServiceV2, which stored it
 * on `this.config.logger` and used it in `logAlways()`. But the 3
 * RealTimeDataClient children created in `connect()` did NOT receive the
 * logger — their internal `log()` would fall back to `_sdkLog` (no-op until
 * setLogger() called). Result: WS-layer events like `Pong timeout - connection
 * dead`, `Status changed: DISCONNECTED`, `Handling dead connection` stayed
 * invisible.
 *
 * Fix: forward `this.config.logger` into all 3 `new RealTimeDataClient(...)`
 * calls inside `connect()`.
 *
 * These tests verify the constructor of RealTimeDataClient receives the
 * logger by mocking the realtime-data-client module.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Capture all RealTimeDataClient ctor calls. Mock factory must be hoisted to
// the top of the module. We track them in a module-level array.
const ctorCalls: Array<Record<string, unknown>> = [];

vi.mock('../../realtime/realtime-data-client.js', async () => {
  // We replace the RealTimeDataClient class with a tracking stub. Other
  // exports (types) are not needed at runtime since realtime-service-v2
  // imports the class via realtime/index.ts (the named import gets
  // intercepted by this mock for the realtime-data-client.js path).
  return {
    RealTimeDataClient: vi.fn().mockImplementation(function (config: Record<string, unknown>) {
      ctorCalls.push(config);
      // Return a stub that satisfies the interface used inside connect().
      return {
        connect: vi.fn(),
        disconnect: vi.fn(),
        forceReconnect: vi.fn(),
        subscribe: vi.fn(),
        unsubscribe: vi.fn(),
        subscribeMarket: vi.fn(),
        unsubscribeMarket: vi.fn(),
        subscribeUser: vi.fn(),
        subscribeCryptoPrices: vi.fn(),
        unsubscribeCryptoPrices: vi.fn(),
        subscribeCryptoChainlinkPrices: vi.fn(),
        unsubscribeCryptoChainlinkPrices: vi.fn(),
        isConnected: vi.fn(() => true),
        getStatus: vi.fn(() => 'CONNECTED'),
      };
    }),
  };
});

import { RealtimeServiceV2 } from '../../services/realtime-service-v2.js';

function makeMockLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe('RealtimeServiceV2 — Fix-E logger propagation to RealTimeDataClient children', () => {
  beforeEach(() => {
    ctorCalls.length = 0;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('forwards `logger` into all 3 RealTimeDataClient ctors when host injects logger into RealtimeServiceV2', async () => {
    const logger = makeMockLogger();
    const service = new RealtimeServiceV2({
      debug: false,
      autoReconnect: false,
      logger,
    });

    // Kick off connect() — we don't actually wait for the WS promise to
    // resolve (the mock RealTimeDataClient doesn't fire onConnect callbacks),
    // we just need the constructor calls to happen synchronously.
    service.connect().catch(() => {
      /* expected — promise rejects on connection timeout, not relevant for this test */
    });

    // All 3 children should have been instantiated (MARKET / USER / LIVE_DATA)
    expect(ctorCalls).toHaveLength(3);

    // Every child should have received the same logger reference
    for (const cfg of ctorCalls) {
      expect(cfg.logger).toBe(logger);
    }
  });

  it('does not forward `logger` (undefined) when host omits logger — backward compatible', async () => {
    const service = new RealtimeServiceV2({
      debug: false,
      autoReconnect: false,
      // no logger
    });

    service.connect().catch(() => {
      /* expected — promise rejects on connection timeout */
    });

    expect(ctorCalls).toHaveLength(3);
    for (const cfg of ctorCalls) {
      expect(cfg.logger).toBeUndefined();
    }
  });
});
