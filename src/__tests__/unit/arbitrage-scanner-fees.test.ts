import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProcessedOrderbook } from '../../core/types.js';

const mocks = vi.hoisted(() => ({
  getMarkets: vi.fn(),
  getClobMarket: vi.fn(),
  getProcessedOrderbook: vi.fn(),
  getFeeAwareProcessedOrderbook: vi.fn(),
}));

vi.mock('../../clients/gamma-api.js', () => ({
  GammaApiClient: vi.fn().mockImplementation(() => ({
    getMarkets: mocks.getMarkets,
  })),
}));

vi.mock('../../services/market-service.js', () => ({
  MarketService: vi.fn().mockImplementation(() => ({
    getClobMarket: mocks.getClobMarket,
    getProcessedOrderbook: mocks.getProcessedOrderbook,
    getFeeAwareProcessedOrderbook: mocks.getFeeAwareProcessedOrderbook,
  })),
}));

import { ArbitrageService } from '../../services/arbitrage-service.js';

const TEST_MARKET = {
  name: 'Fee-aware binary market',
  conditionId: 'condition-1',
  yesTokenId: 'yes-token',
  noTokenId: 'no-token',
  outcomes: ['YES', 'NO'] as [string, string],
};

function makeOrderbook(overrides: Partial<ProcessedOrderbook['summary']> = {}): ProcessedOrderbook {
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
      ...overrides,
    },
  };
}

function setupMarket() {
  mocks.getMarkets.mockResolvedValue([
    {
      question: 'Fee-aware binary market',
      description: 'test market',
      conditionId: 'condition-1',
      outcomes: ['YES', 'NO'],
      volume24hr: 10000,
    },
  ]);
  mocks.getClobMarket.mockResolvedValue({
    tokens: [
      { tokenId: 'yes-token', outcome: 'YES' },
      { tokenId: 'no-token', outcome: 'NO' },
    ],
  });
}

describe('ArbitrageService fee-aware scanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupMarket();
  });

  it('uses fee-aware orderbooks by default and rejects gross-only candidates', async () => {
    mocks.getFeeAwareProcessedOrderbook.mockResolvedValue(makeOrderbook({
      longArbProfit: 0.01,
      shortArbProfit: -0.01,
      feeAdjusted: {
        size: 1,
        liquidityRole: 'taker',
        feeRate: 0.03,
        feeExponent: 1,
        takerOnly: true,
        builderMakerFeeBps: 0,
        builderTakerFeeBps: 0,
        long: {
          grossProfit: 0.01,
          totalFees: 0.01485,
          netProfit: -0.00485,
          netProfitPerShare: -0.00485,
        },
        short: {
          grossProfit: -0.01,
          totalFees: 0.01485,
          netProfit: -0.02485,
          netProfitPerShare: -0.02485,
        },
      },
    }));

    const service = new ArbitrageService({ enableLogging: false });
    const results = await service.scanMarkets({ minVolume24h: 1 }, 0.001);

    expect(mocks.getFeeAwareProcessedOrderbook).toHaveBeenCalledWith('condition-1', {
      size: 1,
      liquidityRole: 'taker',
    });
    expect(mocks.getProcessedOrderbook).not.toHaveBeenCalled();
    expect(results[0]?.arbType).toBe('none');
    expect(results[0]?.grossProfitRate).toBeCloseTo(0.01, 10);
    expect(results[0]?.netProfitRate).toBeCloseTo(-0.00485, 5);
    expect(results[0]?.profitRate).toBe(0);
  });

  it('can still run a gross-only scan when explicitly requested', async () => {
    mocks.getProcessedOrderbook.mockResolvedValue(makeOrderbook({
      longArbProfit: 0.01,
      shortArbProfit: -0.01,
    }));

    const service = new ArbitrageService({ enableLogging: false });
    const results = await service.scanMarkets({
      minVolume24h: 1,
      feeAware: false,
    }, 0.001);

    expect(mocks.getProcessedOrderbook).toHaveBeenCalledWith('condition-1');
    expect(mocks.getFeeAwareProcessedOrderbook).not.toHaveBeenCalled();
    expect(results[0]?.arbType).toBe('long');
    expect(results[0]?.profitRate).toBeCloseTo(0.01, 10);
    expect(results[0]?.feeAware).toBe(false);
  });

  it('selects the strongest net path, not the strongest gross path', async () => {
    mocks.getFeeAwareProcessedOrderbook.mockResolvedValue(makeOrderbook({
      longArbProfit: 0.02,
      shortArbProfit: 0.015,
      feeAdjusted: {
        size: 1,
        liquidityRole: 'taker',
        feeRate: 0.03,
        feeExponent: 1,
        takerOnly: true,
        builderMakerFeeBps: 0,
        builderTakerFeeBps: 0,
        long: {
          grossProfit: 0.02,
          totalFees: 0.019,
          netProfit: 0.001,
          netProfitPerShare: 0.001,
        },
        short: {
          grossProfit: 0.015,
          totalFees: 0.005,
          netProfit: 0.01,
          netProfitPerShare: 0.01,
        },
      },
    }));

    const service = new ArbitrageService({ enableLogging: false });
    const results = await service.scanMarkets({
      minVolume24h: 1,
      feeEstimateSize: 1,
    }, 0.005);

    expect(results[0]?.arbType).toBe('short');
    expect(results[0]?.grossProfitRate).toBeCloseTo(0.015, 10);
    expect(results[0]?.netProfitRate).toBeCloseTo(0.01, 10);
    expect(results[0]?.totalFees).toBeCloseTo(0.005, 10);
    expect(results[0]?.profitRate).toBeCloseTo(0.01, 10);
  });

  it('rejects live gross opportunities that are negative after fees', () => {
    const service = new ArbitrageService({
      enableLogging: false,
      feeAware: true,
      profitThreshold: 0.001,
      minTradeSize: 1,
      minTokenReserve: 1,
    });
    (service as any).market = TEST_MARKET;
    (service as any).marketFeeConfig = {
      rate: 0.03,
      exponent: 1,
      takerOnly: true,
      builderMakerFeeBps: 0,
      builderTakerFeeBps: 0,
    };
    (service as any).balance = {
      usdc: 100,
      yesTokens: 100,
      noTokens: 100,
      lastUpdate: Date.now(),
    };
    (service as any).orderbook = {
      yesBids: [{ price: 0.48, size: 100 }],
      yesAsks: [{ price: 0.495, size: 100 }],
      noBids: [{ price: 0.48, size: 100 }],
      noAsks: [{ price: 0.495, size: 100 }],
      lastUpdate: Date.now(),
    };

    expect(service.checkOpportunity()).toBeNull();
  });

  it('can run live gross opportunity checks when feeAware is disabled', () => {
    const service = new ArbitrageService({
      enableLogging: false,
      feeAware: false,
      profitThreshold: 0.001,
      minTradeSize: 1,
    });
    (service as any).market = TEST_MARKET;
    (service as any).balance = {
      usdc: 100,
      yesTokens: 0,
      noTokens: 0,
      lastUpdate: Date.now(),
    };
    (service as any).orderbook = {
      yesBids: [{ price: 0.48, size: 100 }],
      yesAsks: [{ price: 0.495, size: 100 }],
      noBids: [{ price: 0.48, size: 100 }],
      noAsks: [{ price: 0.495, size: 100 }],
      lastUpdate: Date.now(),
    };

    const opportunity = service.checkOpportunity();

    expect(opportunity?.type).toBe('long');
    expect(opportunity?.feeAware).toBe(false);
    expect(opportunity?.grossProfitRate).toBeCloseTo(0.01, 10);
    expect(opportunity?.profitRate).toBeCloseTo(0.01, 10);
  });
});
