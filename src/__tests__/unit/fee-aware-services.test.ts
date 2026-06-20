import { describe, it, expect, vi } from 'vitest';
import { TradingService } from '../../services/trading-service.js';
import { MarketService } from '../../services/market-service.js';
import { RateLimiter } from '../../core/rate-limiter.js';
import { createUnifiedCache } from '../../core/unified-cache.js';
import type { ProcessedOrderbook } from '../../core/types.js';

const VALID_PK = '0x' + '1'.repeat(64);
const VALID_BUILDER_CODE = '0x' + 'c'.repeat(64);

function makeTradingService(fakeClient: Record<string, unknown>) {
  const service = new TradingService(new RateLimiter(), createUnifiedCache(), {
    privateKey: VALID_PK,
    builderCode: VALID_BUILDER_CODE,
  });
  (service as any).initialized = true;
  (service as any).clobClient = fakeClient;
  return service;
}

function makeMarketService(fakeClient: Record<string, unknown> = {}, config: Record<string, unknown> = {}) {
  const service = new MarketService(
    undefined,
    undefined,
    new RateLimiter(),
    createUnifiedCache(),
    config as any
  );
  (service as any).initialized = true;
  (service as any).clobClient = fakeClient;
  return service;
}

function makeProcessedOrderbook(): ProcessedOrderbook {
  return {
    yes: {
      bid: 0.48,
      ask: 0.49,
      bidSize: 100,
      askSize: 100,
      bidDepth: 1000,
      askDepth: 1000,
      spread: 0.01,
      tokenId: 'yes-token',
    },
    no: {
      bid: 0.48,
      ask: 0.49,
      bidSize: 100,
      askSize: 100,
      bidDepth: 1000,
      askDepth: 1000,
      spread: 0.01,
      tokenId: 'no-token',
    },
    summary: {
      askSum: 0.98,
      bidSum: 0.96,
      effectivePrices: {
        effectiveBuyYes: 0.49,
        effectiveBuyNo: 0.49,
        effectiveSellYes: 0.51,
        effectiveSellNo: 0.51,
      },
      effectiveLongCost: 0.98,
      effectiveShortRevenue: 1.02,
      longArbProfit: 0.02,
      shortArbProfit: 0.02,
      totalBidDepth: 2000,
      totalAskDepth: 2000,
      imbalanceRatio: 1,
      yesSpread: 0.01,
    },
  };
}

describe('fee-aware service APIs', () => {
  describe('TradingService', () => {
    it('loads platform and builder fee config from CLOB market info', async () => {
      const getClobMarketInfo = vi.fn(async () => ({
        fd: { r: 0.04, e: 2, to: false },
        mbf: 3,
        tbf: 12,
      }));
      const service = makeTradingService({
        tokenConditionMap: {},
        feeInfos: {},
        getClobMarketInfo,
      });

      const feeInfo = await service.getMarketFeeInfo('yes-token', 'condition-1');

      expect(getClobMarketInfo).toHaveBeenCalledWith('condition-1');
      expect(feeInfo).toEqual({
        rate: 0.04,
        exponent: 2,
        takerOnly: false,
        builderMakerFeeBps: 3,
        builderTakerFeeBps: 12,
        source: 'clob_market_info',
      });
    });

    it('includes platform and builder fees in order estimates', async () => {
      const service = makeTradingService({
        tokenConditionMap: {},
        feeInfos: {},
        getClobMarketInfo: vi.fn(async () => ({
          fd: { r: 0.03, e: 1, to: true },
          mbf: 10,
          tbf: 25,
        })),
      });

      const estimate = await service.estimateOrderFees({
        conditionId: 'condition-1',
        tokenId: 'yes-token',
        side: 'BUY',
        price: 0.5,
        size: 100,
        liquidityRole: 'taker',
      });

      expect(estimate.notional).toBe(50);
      expect(estimate.platformFee).toBe(0.75);
      expect(estimate.builderFee).toBe(0.125);
      expect(estimate.totalFee).toBe(0.875);
      expect(estimate.totalCost).toBe(50.875);
    });

    it('does not apply market builder bps when no builder code is configured', async () => {
      const originalBuilderCode = process.env.POLY_BUILDER_CODE;
      delete process.env.POLY_BUILDER_CODE;
      try {
        const service = new TradingService(new RateLimiter(), createUnifiedCache(), {
          privateKey: VALID_PK,
        });
        (service as any).initialized = true;
        (service as any).clobClient = {
          tokenConditionMap: {},
          feeInfos: {},
          getClobMarketInfo: vi.fn(async () => ({
            fd: { r: 0.03, e: 1, to: true },
            mbf: 10,
            tbf: 25,
          })),
        };

        const estimate = await service.estimateOrderFees({
          conditionId: 'condition-1',
          tokenId: 'yes-token',
          side: 'BUY',
          price: 0.5,
          size: 100,
          liquidityRole: 'taker',
        });

        expect(estimate.platformFee).toBe(0.75);
        expect(estimate.builderFee).toBe(0);
        expect(estimate.totalFee).toBe(0.75);
      } finally {
        if (originalBuilderCode === undefined) {
          delete process.env.POLY_BUILDER_CODE;
        } else {
          process.env.POLY_BUILDER_CODE = originalBuilderCode;
        }
      }
    });

    it('throws when fee info cannot be loaded for a token', async () => {
      const service = makeTradingService({
        tokenConditionMap: {},
        feeInfos: {},
        getClobMarketInfo: vi.fn(async () => ({})),
      });

      await expect(
        service.getMarketFeeInfo('missing-token', 'condition-1')
      ).rejects.toThrow(/failed to load market fee info/);
    });
  });

  describe('MarketService', () => {
    it('parses market fee config from getClobMarketInfo', async () => {
      const getClobMarketInfo = vi.fn(async () => ({
        fd: { r: 0.05, e: 1, to: true },
        mbf: 2,
        tbf: 9,
      }));
      const service = makeMarketService({ getClobMarketInfo });

      const config = await service.getMarketFeeConfig('condition-1');

      expect(getClobMarketInfo).toHaveBeenCalledWith('condition-1');
      expect(config).toEqual({
        rate: 0.05,
        exponent: 1,
        takerOnly: true,
        builderMakerFeeBps: 0,
        builderTakerFeeBps: 0,
      });
    });

    it('includes market builder bps only when a nonzero builder code is configured', async () => {
      const getClobMarketInfo = vi.fn(async () => ({
        fd: { r: 0.05, e: 1, to: true },
        mbf: 2,
        tbf: 9,
      }));
      const service = makeMarketService({ getClobMarketInfo }, {
        builderCode: VALID_BUILDER_CODE,
      });

      const config = await service.getMarketFeeConfig('condition-1');

      expect(config.builderMakerFeeBps).toBe(2);
      expect(config.builderTakerFeeBps).toBe(9);
    });

    it('adds feeAdjusted net fields to processed orderbooks', async () => {
      const service = makeMarketService();
      vi.spyOn(service, 'getProcessedOrderbook').mockResolvedValue(makeProcessedOrderbook());
      vi.spyOn(service, 'getMarketFeeConfig').mockResolvedValue({
        rate: 0.03,
        exponent: 1,
        takerOnly: true,
        builderMakerFeeBps: 0,
        builderTakerFeeBps: 0,
      });

      const book = await service.getFeeAwareProcessedOrderbook('condition-1', {
        size: 10,
      });

      expect(book.summary.feeAdjusted?.size).toBe(10);
      expect(book.summary.feeAdjusted?.feeRate).toBe(0.03);
      expect(book.summary.feeAdjusted?.long.grossProfit).toBeCloseTo(0.2, 10);
      expect(book.summary.feeAdjusted?.long.totalFees).toBeCloseTo(0.14994, 5);
      expect(book.summary.feeAdjusted?.long.netProfit).toBeCloseTo(0.05006, 5);
      expect(book.summary.feeAdjusted?.short.netProfit).toBeCloseTo(0.05006, 5);
    });

    it('returns net arbitrage only when net profit clears threshold', async () => {
      const service = makeMarketService();
      vi.spyOn(service, 'getFeeAwareProcessedOrderbook').mockResolvedValue({
        ...makeProcessedOrderbook(),
        summary: {
          ...makeProcessedOrderbook().summary,
          feeAdjusted: {
            size: 10,
            liquidityRole: 'taker',
            feeRate: 0.03,
            feeExponent: 1,
            takerOnly: true,
            builderMakerFeeBps: 0,
            builderTakerFeeBps: 0,
            long: {
              grossProfit: 0.2,
              totalFees: 0.14994,
              netProfit: 0.05006,
              netProfitPerShare: 0.005006,
            },
            short: {
              grossProfit: 0.2,
              totalFees: 0.14994,
              netProfit: -0.01,
              netProfitPerShare: -0.001,
            },
          },
        },
      });

      await expect(
        service.detectArbitrageNet('condition-1', { size: 10, threshold: 0.06 })
      ).resolves.toBeNull();

      const opportunity = await service.detectArbitrageNet('condition-1', {
        size: 10,
        threshold: 0.05,
      });

      expect(opportunity?.type).toBe('long');
      expect(opportunity?.profit).toBeCloseTo(0.05006, 5);
      expect(opportunity?.totalFees).toBeCloseTo(0.14994, 5);
      expect(opportunity?.size).toBe(10);
    });
  });
});
