import { describe, it, expect, vi } from 'vitest';
import { TradingService } from '../../services/trading-service.js';
import { RateLimiter } from '../../core/rate-limiter.js';
import { createUnifiedCache } from '../../core/unified-cache.js';

const VALID_PK = '0x' + '1'.repeat(64);
const VALID_BUILDER_CODE = '0x' + 'c'.repeat(64);

function makeService(fakeClient: Record<string, unknown>) {
  const service = new TradingService(new RateLimiter(), createUnifiedCache(), {
    privateKey: VALID_PK,
    builderCode: VALID_BUILDER_CODE,
    safeAddress: '0x' + 'a'.repeat(40),
  });
  (service as any).initialized = true;
  (service as any).clobClient = fakeClient;
  return service;
}

describe('TradingService presigned orders', () => {
  it('presignMarketOrder creates a signed payload without posting', async () => {
    const createMarketOrder = vi.fn(async () => ({ salt: 'signed' }));
    const postOrder = vi.fn();
    const service = makeService({ createMarketOrder, postOrder });

    const presigned = await service.presignMarketOrder({
      tokenId: 'token-1',
      side: 'BUY',
      amount: 3,
      price: 0.5,
      orderType: 'FAK',
      tickSize: '0.001',
      negRisk: false,
    }, { key: 'key-1', ttlMs: 250 });

    expect(presigned.key).toBe('key-1');
    expect(presigned.kind).toBe('market');
    expect(presigned.orderType).toBe('FAK');
    expect(presigned.fingerprint.walletMode).toBe('builder_safe');
    expect(presigned.fingerprint.maker).toBe('0x' + 'a'.repeat(40));
    expect(createMarketOrder).toHaveBeenCalledTimes(1);
    expect(postOrder).not.toHaveBeenCalled();
  });

  it('postPresignedOrder posts exactly the provided signed payload once', async () => {
    const signedOrder = { salt: 'signed' };
    const postOrder = vi.fn(async () => ({
      success: true,
      orderID: 'clob-order-1',
      status: 'matched',
    }));
    const service = makeService({ postOrder });

    const result = await service.postPresignedOrder({
      key: 'key-1',
      kind: 'market',
      orderType: 'FAK',
      signedOrder: signedOrder as any,
      fingerprint: {
        tokenId: 'token-1',
        side: 'BUY',
        orderType: 'FAK',
        amount: 3,
        walletMode: 'builder_safe',
        maker: '0x' + 'a'.repeat(40),
        signer: '0x' + 'b'.repeat(40),
        signatureType: 2,
      },
      createdAt: Date.now(),
      telemetry: {
        startedAt: Date.now(),
        totalMs: 0,
      },
    });

    expect(result.success).toBe(true);
    expect(result.orderId).toBe('clob-order-1');
    expect(result.telemetry?.presignHit).toBe(true);
    expect(result.telemetry?.signAndBuildMs).toBe(0);
    expect(postOrder).toHaveBeenCalledWith(signedOrder, 'FAK', false);
  });

  it('createLimitOrder forwards postOnly to CLOB createAndPostOrder', async () => {
    const createAndPostOrder = vi.fn(async () => ({
      success: true,
      orderID: 'limit-order-1',
      status: 'live',
    }));
    const service = makeService({ createAndPostOrder });

    const result = await service.createLimitOrder({
      tokenId: 'token-1',
      side: 'BUY',
      price: 0.5,
      size: 10,
      orderType: 'GTC',
      tickSize: '0.01',
      negRisk: false,
      postOnly: true,
    });

    expect(result.success).toBe(true);
    expect(createAndPostOrder).toHaveBeenCalledWith(
      {
        tokenID: 'token-1',
        side: 'BUY',
        price: 0.5,
        size: 10,
        expiration: 0,
      },
      { tickSize: '0.01', negRisk: false },
      'GTC',
      true
    );
  });

  it('presignLimitOrder preserves postOnly and postPresignedOrder forwards it', async () => {
    const signedOrder = { salt: 'signed-limit' };
    const createOrder = vi.fn(async () => signedOrder);
    const postOrder = vi.fn(async () => ({
      success: true,
      orderID: 'limit-order-1',
      status: 'live',
    }));
    const service = makeService({ createOrder, postOrder });

    const presigned = await service.presignLimitOrder({
      tokenId: 'token-1',
      side: 'SELL',
      price: 0.55,
      size: 10,
      orderType: 'GTD',
      expiration: 1234567890,
      tickSize: '0.01',
      negRisk: false,
      postOnly: true,
    }, { key: 'limit-key-1' });

    expect(presigned.postOnly).toBe(true);
    expect(presigned.fingerprint.postOnly).toBe(true);

    const result = await service.postPresignedOrder(presigned);

    expect(result.success).toBe(true);
    expect(createOrder).toHaveBeenCalledWith(
      {
        tokenID: 'token-1',
        side: 'SELL',
        price: 0.55,
        size: 10,
        expiration: 1234567890,
      },
      { tickSize: '0.01', negRisk: false }
    );
    expect(postOrder).toHaveBeenCalledWith(signedOrder, 'GTD', true);
  });

  it('createBatchOrders passes postOnly as a batch-level flag when every order is post-only', async () => {
    const createOrder = vi.fn(async () => ({ salt: 'signed' }));
    const postOrders = vi.fn(async () => [
      { success: true, orderID: 'batch-order-1' },
      { success: true, orderID: 'batch-order-2' },
    ]);
    const service = makeService({
      createOrder,
      postOrders,
      getTickSize: vi.fn(async () => '0.01'),
      getNegRisk: vi.fn(async () => false),
    });

    const result = await service.createBatchOrders([
      { tokenId: 'token-1', side: 'BUY', price: 0.5, size: 10, postOnly: true },
      { tokenId: 'token-2', side: 'SELL', price: 0.55, size: 10, postOnly: true },
    ]);

    expect(result.success).toBe(true);
    expect(postOrders).toHaveBeenCalledWith(
      [
        { order: { salt: 'signed' }, orderType: 'GTC' },
        { order: { salt: 'signed' }, orderType: 'GTC' },
      ],
      true
    );
  });

  it('createBatchOrders rejects mixed postOnly values because CLOB only accepts a batch-level flag', async () => {
    const postOrders = vi.fn();
    const service = makeService({ postOrders });

    const result = await service.createBatchOrders([
      { tokenId: 'token-1', side: 'BUY', price: 0.5, size: 10, postOnly: true },
      { tokenId: 'token-2', side: 'SELL', price: 0.55, size: 10 },
    ]);

    expect(result.success).toBe(false);
    expect(result.errorMsg).toMatch(/Batch postOnly must be consistent/);
    expect(postOrders).not.toHaveBeenCalled();
  });

  it('blocks duplicate post of the same presigned object before CLOB', async () => {
    const postOrder = vi.fn(async () => ({ success: true, orderID: 'clob-order-1' }));
    const service = makeService({ postOrder });
    const presigned = {
      key: 'key-1',
      kind: 'market' as const,
      orderType: 'FAK' as const,
      signedOrder: { salt: 'signed' } as any,
      fingerprint: {
        tokenId: 'token-1',
        side: 'BUY' as const,
        orderType: 'FAK' as const,
        amount: 3,
        walletMode: 'builder_safe',
        maker: '0x' + 'a'.repeat(40),
        signer: '0x' + 'b'.repeat(40),
        signatureType: 2,
      },
      createdAt: Date.now(),
      telemetry: { startedAt: Date.now(), totalMs: 0 },
    };

    await service.postPresignedOrder(presigned);
    const second = await service.postPresignedOrder(presigned);

    expect(second.success).toBe(false);
    expect(second.errorMsg).toMatch(/already been used/);
    expect(postOrder).toHaveBeenCalledTimes(1);
  });

  it('fingerprints deposit-wallet identity with POLY_1271 maker/funder', () => {
    const depositWallet = '0x' + 'd'.repeat(40);
    const service = new TradingService(new RateLimiter(), createUnifiedCache(), {
      privateKey: VALID_PK,
      builderCode: VALID_BUILDER_CODE,
      walletMode: 'deposit_wallet',
      signatureType: 3,
      funderAddress: depositWallet,
    });

    const identity = service.getWalletIdentity();

    expect(identity.walletMode).toBe('deposit_wallet');
    expect(identity.maker).toBe(depositWallet);
    expect(identity.funder).toBe(depositWallet);
    expect(identity.signatureType).toBe(3);
    expect(identity.builderCode).toBe(VALID_BUILDER_CODE);
  });

  it('rejects deposit-wallet mode without an explicit maker/funder', () => {
    const service = new TradingService(new RateLimiter(), createUnifiedCache(), {
      privateKey: VALID_PK,
      builderCode: VALID_BUILDER_CODE,
      walletMode: 'deposit_wallet',
    });

    expect(() => service.getWalletIdentity()).toThrow(/deposit_wallet wallet mode requires funderAddress/);
  });
});
