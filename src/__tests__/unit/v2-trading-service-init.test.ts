/**
 * Unit tests for TradingService V2 initialization gating.
 *
 * Verifies the builder-code precedence (constructor config > env) and that
 * order placement entry-points fail fast when neither is supplied.
 *
 * We do NOT call `initialize()` here — that would hit the live CLOB API to
 * derive the L2 API key. Instead we exercise `ensureBuilderCode()` directly
 * via the public order entry-points (which short-circuit before any network
 * call when the builder code is missing).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TradingService } from '../../services/trading-service.js';
import { RateLimiter } from '../../core/rate-limiter.js';
import { createUnifiedCache } from '../../core/unified-cache.js';

const ENV_KEY = 'POLY_BUILDER_CODE';
const VALID_PK = '0x' + '1'.repeat(64);
const VALID_BUILDER_CODE = '0x' + 'c'.repeat(64);

function makeService(overrides: { builderCode?: string } = {}) {
  return new TradingService(new RateLimiter(), createUnifiedCache(), {
    privateKey: VALID_PK,
    ...overrides,
  });
}

describe('TradingService V2 — builder-code gating', () => {
  let prev: string | undefined;

  beforeEach(() => {
    prev = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
  });

  afterEach(() => {
    if (prev === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = prev;
    }
  });

  it('createLimitOrder throws when neither config nor env provides a builder code', async () => {
    const svc = makeService();
    // Use values that pass min-size/min-value validation so we reach the
    // builder-code check rather than short-circuiting earlier.
    await expect(
      svc.createLimitOrder({
        tokenId: '0xabc',
        side: 'BUY',
        price: 0.5,
        size: 10,
      })
    ).rejects.toThrow(/POLY_BUILDER_CODE/);
  });

  it('createMarketOrder throws when builder code is missing', async () => {
    const svc = makeService();
    await expect(
      svc.createMarketOrder({
        tokenId: '0xabc',
        side: 'BUY',
        amount: 10,
      })
    ).rejects.toThrow(/POLY_BUILDER_CODE/);
  });

  it('createBatchOrders throws when builder code is missing', async () => {
    const svc = makeService();
    await expect(
      svc.createBatchOrders([
        { tokenId: '0xabc', side: 'BUY', price: 0.5, size: 10 },
      ])
    ).rejects.toThrow(/POLY_BUILDER_CODE/);
  });

  it('skips builder check when validation rejects the order before signing', async () => {
    // Sub-minimum order size never reaches the builder-code gate; it returns
    // a structured error result instead.
    const svc = makeService();
    const result = await svc.createLimitOrder({
      tokenId: '0xabc',
      side: 'BUY',
      price: 0.5,
      size: 1, // below the 5-share default minimum
    });
    expect(result.success).toBe(false);
    expect(result.errorMsg).toMatch(/below Polymarket minimum/);
  });

  it('accepts builder code from constructor config (env not required)', () => {
    const svc = makeService({ builderCode: VALID_BUILDER_CODE });
    // ensureBuilderCode is private; reach it by calling the helper directly
    // via a no-op order setup. Simpler: inspect that constructing the service
    // and invoking the gate does not throw.
    expect(() => (svc as any).ensureBuilderCode()).not.toThrow();
  });

  it('accepts builder code from POLY_BUILDER_CODE env when config omits it', () => {
    process.env[ENV_KEY] = VALID_BUILDER_CODE;
    const svc = makeService();
    expect(() => (svc as any).ensureBuilderCode()).not.toThrow();
  });

  it('rejects malformed builder code from env even if config omits it', () => {
    process.env[ENV_KEY] = '0xnope';
    const svc = makeService();
    expect(() => (svc as any).ensureBuilderCode()).toThrow(/bytes32/);
  });
});

// NOTE: The 4 PolymarketSDK fail-fast tests covering `builderCreds` without
// `builderCode` were removed alongside the `PolymarketSDKConfig.builderCreds`
// field itself (chore/v2-cleanup-builder-creds, 2026-05-05). After the V2
// cutover that field carried no behaviour — HMAC creds are now consumed only
// by `RelayerService`, instantiated directly. The fail-fast guard had nothing
// left to guard.
