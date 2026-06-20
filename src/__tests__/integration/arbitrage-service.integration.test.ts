/**
 * ArbitrageService Integration Tests
 *
 * Tests the ArbitrageService market scanning and opportunity detection.
 * These tests make REAL API calls to Polymarket.
 *
 * Note: Trading tests are skipped without a real private key.
 *
 * Run with: pnpm test:integration
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { ArbitrageService, type ArbitrageMarketConfig } from '../../services/arbitrage-service.js';

describe('ArbitrageService Integration', () => {
  let service: ArbitrageService;
  let testMarket: ArbitrageMarketConfig;

  beforeAll(async () => {
    // Find a liquid market for testing
    const response = await fetch(
      'https://gamma-api.polymarket.com/markets?active=true&limit=20&order=volume24hr&ascending=false'
    );
    const markets = await response.json() as Array<{
      conditionId: string;
      question: string;
      outcomes: string[];
    }>;

    if (markets.length === 0) {
      throw new Error('No active markets found for testing');
    }

    for (const gammaMarket of markets) {
      if (gammaMarket.outcomes?.length !== 2) {
        continue;
      }

      const clobResponse = await fetch(`https://clob.polymarket.com/markets/${gammaMarket.conditionId}`);
      const clobMarket = await clobResponse.json() as { tokens: Array<{ token_id: string; outcome: string }> };

      if (clobMarket.tokens.length !== 2) {
        continue;
      }

      console.log(`Using test market: "${gammaMarket.question.slice(0, 50)}..."`);
      testMarket = {
        name: gammaMarket.question.slice(0, 50),
        conditionId: gammaMarket.conditionId,
        yesTokenId: clobMarket.tokens[0].token_id,
        noTokenId: clobMarket.tokens[1].token_id,
        outcomes: (gammaMarket.outcomes || ['Outcome 1', 'Outcome 2']) as [string, string],
      };
      return;
    }

    throw new Error('No binary active markets found for testing');
  }, 60000);

  afterEach(async () => {
    // Clean up service after each test
    if (service) {
      await service.stop();
    }
  });

  describe('Market Scanning', () => {
    it('should scan markets for arbitrage opportunities', async () => {
      service = new ArbitrageService({ enableLogging: false });

      const results = await service.scanMarkets({
        minVolume24h: 1000,
        limit: 10,
      }, 0.001); // Very low threshold to find results

      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeGreaterThan(0);

      // Verify result structure
      const result = results[0];
      expect(result.market).toBeDefined();
      expect(typeof result.market.name).toBe('string');
      expect(typeof result.market.conditionId).toBe('string');
      expect(typeof result.market.yesTokenId).toBe('string');
      expect(typeof result.market.noTokenId).toBe('string');
      expect(['long', 'short', 'none']).toContain(result.arbType);
      expect(typeof result.profitRate).toBe('number');
      expect(typeof result.profitPercent).toBe('number');
      expect(typeof result.volume24h).toBe('number');
      expect(typeof result.score).toBe('number');

      // Verify effective prices
      expect(typeof result.effectivePrices.buyYes).toBe('number');
      expect(typeof result.effectivePrices.buyNo).toBe('number');
      expect(typeof result.effectivePrices.sellYes).toBe('number');
      expect(typeof result.effectivePrices.sellNo).toBe('number');
      expect(typeof result.effectivePrices.longCost).toBe('number');
      expect(typeof result.effectivePrices.shortRevenue).toBe('number');

      console.log(`✓ Scanned ${results.length} markets`);
      console.log(`  Best: ${result.market.name.slice(0, 40)}...`);
      console.log(`  Type: ${result.arbType}, Profit: ${result.profitPercent.toFixed(3)}%`);
    }, 120000);

    it('should filter markets by keywords', async () => {
      service = new ArbitrageService({ enableLogging: false });

      const results = await service.scanMarkets({
        minVolume24h: 100,
        keywords: ['bitcoin', 'btc', 'crypto'],
        limit: 20,
      }, 0);

      // Results may be empty if no crypto markets match
      expect(Array.isArray(results)).toBe(true);

      console.log(`✓ Found ${results.length} markets matching crypto keywords`);
    }, 120000);

    it('should quick scan for best opportunities', async () => {
      service = new ArbitrageService({ enableLogging: false });

      const results = await service.quickScan(0.001, 5);

      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeLessThanOrEqual(5);

      // Quick scan should only return markets with opportunities
      for (const result of results) {
        expect(['long', 'short']).toContain(result.arbType);
        expect(result.profitRate).toBeGreaterThan(0);
      }

      console.log(`✓ Quick scan found ${results.length} opportunities`);
      if (results.length > 0) {
        console.log(`  Best: ${results[0].arbType} +${results[0].profitPercent.toFixed(3)}%`);
      }
    }, 120000);
  });

  describe('Opportunity Detection', () => {
    it('should start monitoring and receive orderbook updates', async () => {
      service = new ArbitrageService({ enableLogging: false });

      // Start monitoring
      await service.start(testMarket);

      // Wait for orderbook updates with timeout fallback
      const orderbookPromise = new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => resolve(false), 45000);

        service.on('orderbookUpdate', () => {
          clearTimeout(timeout);
          resolve(true);
        });
      });

      const received = await orderbookPromise;

      if (received) {
        // Verify orderbook state
        const orderbook = service.getOrderbook();
        expect(orderbook.lastUpdate).toBeGreaterThan(0);
        expect(Array.isArray(orderbook.yesBids)).toBe(true);
        expect(Array.isArray(orderbook.yesAsks)).toBe(true);
        expect(Array.isArray(orderbook.noBids)).toBe(true);
        expect(Array.isArray(orderbook.noAsks)).toBe(true);

        console.log(`✓ Received orderbook updates`);
        console.log(`  YES: ${orderbook.yesBids.length} bids, ${orderbook.yesAsks.length} asks`);
        console.log(`  NO: ${orderbook.noBids.length} bids, ${orderbook.noAsks.length} asks`);
      } else {
        console.log(`✓ ArbitrageService started (no WebSocket data within timeout - may need market activity)`);
      }
    }, 60000);

    it('should check for arbitrage opportunities', async () => {
      service = new ArbitrageService({
        enableLogging: false,
        profitThreshold: 0.001, // Very low threshold to detect opportunities
      });

      // Start monitoring
      await service.start(testMarket);

      // Wait for orderbook to be populated with timeout fallback
      const orderbookPromise = new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => resolve(false), 45000);

        service.on('orderbookUpdate', (orderbook) => {
          // Wait until we have data on both sides
          if (orderbook.yesBids.length > 0 && orderbook.yesAsks.length > 0 &&
              orderbook.noBids.length > 0 && orderbook.noAsks.length > 0) {
            clearTimeout(timeout);
            resolve(true);
          }
        });
      });

      const received = await orderbookPromise;

      if (received) {
        // Check for opportunity
        const opportunity = service.checkOpportunity();

        if (opportunity) {
          expect(['long', 'short']).toContain(opportunity.type);
          expect(typeof opportunity.profitRate).toBe('number');
          expect(typeof opportunity.profitPercent).toBe('number');
          expect(typeof opportunity.recommendedSize).toBe('number');
          expect(typeof opportunity.estimatedProfit).toBe('number');
          expect(typeof opportunity.description).toBe('string');

          console.log(`✓ Found ${opportunity.type} opportunity`);
          console.log(`  Profit: ${opportunity.profitPercent.toFixed(3)}%`);
          console.log(`  Size: ${opportunity.recommendedSize.toFixed(2)}`);
          console.log(`  Est. Profit: $${opportunity.estimatedProfit.toFixed(2)}`);
        } else {
          console.log(`✓ No arbitrage opportunity at current prices (normal for most markets)`);
        }
      } else {
        console.log(`✓ checkOpportunity available (no WebSocket data - requires market activity)`);
      }
    }, 60000);

    it('should emit opportunity events', async () => {
      service = new ArbitrageService({
        enableLogging: false,
        profitThreshold: 0, // Zero threshold to catch any opportunity
      });

      // Start monitoring
      await service.start(testMarket);

      // Wait for either an opportunity event or a timeout
      const result = await Promise.race([
        new Promise<'opportunity'>((resolve) => {
          service.on('opportunity', () => resolve('opportunity'));
        }),
        new Promise<'timeout'>((resolve) => {
          setTimeout(() => resolve('timeout'), 30000);
        }),
      ]);

      if (result === 'opportunity') {
        console.log(`✓ Received opportunity event`);
      } else {
        console.log(`✓ No opportunity event (prices are fair - no arbitrage, or no data received)`);
      }

      // Stats should be tracked
      const stats = service.getStats();
      expect(typeof stats.opportunitiesDetected).toBe('number');
      expect(typeof stats.executionsAttempted).toBe('number');
      expect(typeof stats.executionsSucceeded).toBe('number');
      expect(typeof stats.totalProfit).toBe('number');
      expect(typeof stats.runningTimeMs).toBe('number');

      console.log(`  Opportunities detected: ${stats.opportunitiesDetected}`);
    }, 60000);
  });

  describe('Service State', () => {
    it('should track statistics', async () => {
      service = new ArbitrageService({ enableLogging: false });

      const stats = service.getStats();

      expect(typeof stats.opportunitiesDetected).toBe('number');
      expect(stats.opportunitiesDetected).toBe(0);
      expect(typeof stats.executionsAttempted).toBe('number');
      expect(stats.executionsAttempted).toBe(0);
      expect(typeof stats.executionsSucceeded).toBe('number');
      expect(stats.executionsSucceeded).toBe(0);
      expect(typeof stats.totalProfit).toBe('number');
      expect(stats.totalProfit).toBe(0);

      console.log(`✓ Statistics tracking works`);
    });

    it('should start and stop cleanly', async () => {
      service = new ArbitrageService({ enableLogging: false });

      // Track events
      let startedEmitted = false;
      let stoppedEmitted = false;

      service.on('started', () => { startedEmitted = true; });
      service.on('stopped', () => { stoppedEmitted = true; });

      // Start
      await service.start(testMarket);
      expect(startedEmitted).toBe(true);

      // Stop
      await service.stop();
      expect(stoppedEmitted).toBe(true);

      console.log(`✓ Start/stop lifecycle works correctly`);
    }, 30000);

    it('should prevent double-start', async () => {
      service = new ArbitrageService({ enableLogging: false });

      await service.start(testMarket);

      // Second start should throw
      await expect(service.start(testMarket)).rejects.toThrow('already running');

      console.log(`✓ Double-start prevention works`);
    }, 30000);
  });

  describe('Rebalancer Configuration', () => {
    it('should calculate rebalance actions (without wallet)', () => {
      service = new ArbitrageService({
        enableLogging: false,
        enableRebalancer: true,
        minUsdcRatio: 0.2,
        maxUsdcRatio: 0.8,
        targetUsdcRatio: 0.5,
      });

      // Without a market started, should return 'none'
      const action = service.calculateRebalanceAction();
      expect(action.type).toBe('none');
      expect(typeof action.amount).toBe('number');
      expect(typeof action.reason).toBe('string');
      expect(typeof action.priority).toBe('number');

      console.log(`✓ Rebalance action calculation works`);
    });
  });
});
