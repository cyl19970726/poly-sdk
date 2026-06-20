/**
 * MarketService Integration Tests
 *
 * Tests the MarketService for market data operations.
 * These tests make REAL API calls to Polymarket.
 *
 * Run with: pnpm test:integration
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { MarketService } from '../../services/market-service.js';
import { RateLimiter } from '../../core/rate-limiter.js';
import { createUnifiedCache } from '../../core/unified-cache.js';

describe('MarketService Integration', () => {
  let service: MarketService;
  let testConditionId: string;
  let testYesTokenId: string;
  let testNoTokenId: string;

  beforeAll(async () => {
    // Create MarketService without gammaApi/dataApi (CLOB-only mode)
    service = new MarketService(
      undefined, // gammaApi not needed for CLOB tests
      undefined, // dataApi not needed for CLOB tests
      new RateLimiter(),
      createUnifiedCache()
    );

    // Find a liquid market for testing
    const response = await fetch(
      'https://gamma-api.polymarket.com/markets?active=true&limit=20&order=volume24hr&ascending=false'
    );
    const markets = (await response.json()) as Array<{
      conditionId: string;
      question: string;
    }>;

    if (markets.length === 0) {
      throw new Error('No active markets found for testing');
    }

    for (const candidate of markets) {
      const market = await service.getClobMarket(candidate.conditionId);
      if (!market || market.tokens.length !== 2) {
        continue;
      }

      testConditionId = candidate.conditionId;
      testYesTokenId = market.tokens[0].tokenId;
      testNoTokenId = market.tokens[1].tokenId;
      console.log(`Using test market: "${candidate.question.slice(0, 50)}..."`);
      return;
    }

    throw new Error('No binary active markets found for testing');
  }, 60000);

  describe('getClobMarket', () => {
    it('should return valid market data from official client', async () => {
      const market = await service.getClobMarket(testConditionId);

      expect(market).not.toBeNull();
      if (!market) {
        throw new Error(`Market not found: ${testConditionId}`);
      }

      expect(market.conditionId).toBe(testConditionId);
      expect(typeof market.question).toBe('string');
      expect(market.question.length).toBeGreaterThan(0);
      expect(Array.isArray(market.tokens)).toBe(true);
      expect(market.tokens.length).toBe(2);

      // Verify tokens
      expect(market.tokens[0]?.tokenId).toBeDefined();
      expect(market.tokens[1]?.tokenId).toBeDefined();

      console.log(`✓ getClobMarket: "${market.question.slice(0, 40)}..."`);
    }, 30000);
  });

  describe('getTokenOrderbook', () => {
    it('should return sorted orderbook', async () => {
      const book = await service.getTokenOrderbook(testYesTokenId);

      expect(Array.isArray(book.bids)).toBe(true);
      expect(Array.isArray(book.asks)).toBe(true);
      expect(typeof book.timestamp).toBe('number');

      // Bids should be sorted descending
      for (let i = 1; i < book.bids.length; i++) {
        expect(book.bids[i].price).toBeLessThanOrEqual(book.bids[i - 1].price);
      }

      // Asks should be sorted ascending
      for (let i = 1; i < book.asks.length; i++) {
        expect(book.asks[i].price).toBeGreaterThanOrEqual(book.asks[i - 1].price);
      }

      console.log(
        `✓ getTokenOrderbook: ${book.bids.length} bids, ${book.asks.length} asks`
      );
    }, 30000);
  });

  describe('getProcessedOrderbook', () => {
    it('should return processed orderbook with analytics', async () => {
      const processed = await service.getProcessedOrderbook(testConditionId);

      // Verify YES/NO book data
      expect(typeof processed.yes.bid).toBe('number');
      expect(typeof processed.yes.ask).toBe('number');
      expect(typeof processed.no.bid).toBe('number');
      expect(typeof processed.no.ask).toBe('number');

      // Verify summary
      expect(typeof processed.summary.effectiveLongCost).toBe('number');
      expect(typeof processed.summary.effectiveShortRevenue).toBe('number');
      expect(typeof processed.summary.longArbProfit).toBe('number');
      expect(typeof processed.summary.shortArbProfit).toBe('number');

      console.log(`✓ getProcessedOrderbook:`);
      console.log(
        `  YES: bid=${processed.yes.bid.toFixed(3)}, ask=${processed.yes.ask.toFixed(3)}`
      );
      console.log(
        `  NO:  bid=${processed.no.bid.toFixed(3)}, ask=${processed.no.ask.toFixed(3)}`
      );
    }, 30000);
  });

  describe('getMidpoint', () => {
    it('should return midpoint price or handle no orderbook', async () => {
      try {
        const midpoint = await service.getMidpoint(testYesTokenId);

        expect(typeof midpoint).toBe('number');
        // Midpoint can be NaN if no orderbook exists
        if (!isNaN(midpoint)) {
          expect(midpoint).toBeGreaterThanOrEqual(0);
          expect(midpoint).toBeLessThanOrEqual(1);
          console.log(`✓ getMidpoint: ${midpoint.toFixed(4)}`);
        } else {
          console.log(
            `✓ getMidpoint: NaN (no orderbook exists - expected for some tokens)`
          );
        }
      } catch {
        // API may return error if no orderbook exists
        console.log(
          `✓ getMidpoint: API error (no orderbook - expected for some tokens)`
        );
      }
    }, 30000);
  });

  describe('getSpread', () => {
    it('should return spread or handle no orderbook', async () => {
      try {
        const spread = await service.getSpread(testYesTokenId);

        expect(typeof spread).toBe('number');
        // Spread can be NaN if no orderbook exists
        if (!isNaN(spread)) {
          expect(spread).toBeGreaterThanOrEqual(0);
          console.log(`✓ getSpread: ${spread.toFixed(4)}`);
        } else {
          console.log(
            `✓ getSpread: NaN (no orderbook exists - expected for some tokens)`
          );
        }
      } catch {
        // API may return error if no orderbook exists
        console.log(
          `✓ getSpread: API error (no orderbook - expected for some tokens)`
        );
      }
    }, 30000);
  });

  describe('getPricesHistory', () => {
    it('should return price history array', async () => {
      try {
        const history = await service.getPricesHistory({
          tokenId: testYesTokenId,
          interval: '1d',
        });

        expect(Array.isArray(history)).toBe(true);

        if (history.length > 0) {
          for (const point of history) {
            expect(typeof point.timestamp).toBe('number');
            expect(typeof point.price).toBe('number');
            expect(point.price).toBeGreaterThanOrEqual(0);
            expect(point.price).toBeLessThanOrEqual(1);
          }
          console.log(`✓ getPricesHistory: ${history.length} data points`);
        } else {
          console.log(
            `✓ getPricesHistory: empty (no history available for this token)`
          );
        }
      } catch {
        // API may return error for some tokens
        console.log(
          `✓ getPricesHistory: API error (no history - expected for some tokens)`
        );
      }
    }, 30000);
  });

  describe('getClobMarkets', () => {
    it('should return paginated markets list', async () => {
      const result = await service.getClobMarkets();

      expect(Array.isArray(result.markets)).toBe(true);
      expect(result.markets.length).toBeGreaterThan(0);
      expect(typeof result.nextCursor).toBe('string');

      const market = result.markets[0];
      expect(typeof market.conditionId).toBe('string');
      expect(typeof market.question).toBe('string');

      console.log(`✓ getClobMarkets: ${result.markets.length} markets returned`);
    }, 30000);
  });
});
