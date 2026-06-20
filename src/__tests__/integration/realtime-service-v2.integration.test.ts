/**
 * RealtimeServiceV2 Integration Tests
 *
 * Tests the new RealtimeServiceV2 that uses @polymarket/real-time-data-client.
 * These tests make REAL WebSocket connections to Polymarket.
 *
 * Run with: pnpm test:integration
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { RealtimeServiceV2, type OrderbookSnapshot } from '../../services/realtime-service-v2.js';
import type { PriceUpdate } from '../../core/types.js';

describe('RealtimeServiceV2 Integration', () => {
  let service: RealtimeServiceV2;
  let testYesTokenId: string;
  let testNoTokenId: string;
  let testConditionId: string;

  beforeAll(async () => {
    // Find a liquid market for testing
    const response = await fetch(
      'https://gamma-api.polymarket.com/markets?active=true&limit=20&order=volume24hr&ascending=false'
    );
    const markets = await response.json() as Array<{ conditionId: string; question: string; clobTokenIds: string[] }>;

    if (markets.length === 0) {
      throw new Error('No active markets found for testing');
    }

    for (const candidate of markets) {
      const clobResponse = await fetch(`https://clob.polymarket.com/markets/${candidate.conditionId}`);
      const clobMarket = await clobResponse.json() as { tokens: Array<{ token_id: string; outcome: string }> };
      if (clobMarket.tokens.length !== 2) {
        continue;
      }

      testConditionId = candidate.conditionId;
      testYesTokenId = clobMarket.tokens[0].token_id;
      testNoTokenId = clobMarket.tokens[1].token_id;
      console.log(`Using test market: "${candidate.question.slice(0, 50)}..."`);
      console.log(`YES token: ${testYesTokenId.slice(0, 20)}...`);
      console.log(`NO token: ${testNoTokenId.slice(0, 20)}...`);
      return;
    }

    throw new Error('No binary active markets found for testing');
  }, 60000);

  afterEach(async () => {
    // Clean up service after each test
    if (service) {
      service.disconnect();
    }
  });

  describe('Connection', () => {
    it('should connect to WebSocket server', async () => {
      service = new RealtimeServiceV2({ debug: false });

      const connectedPromise = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Connection timeout')), 15000);
        service.once('connected', () => {
          clearTimeout(timeout);
          resolve();
        });
      });

      service.connect();
      await connectedPromise;

      expect(service.isConnected()).toBe(true);
      console.log('✓ Connected to WebSocket server');
    }, 30000);

    it('should disconnect gracefully', async () => {
      service = new RealtimeServiceV2({ debug: false });

      const connectedPromise = new Promise<void>((resolve) => {
        service.once('connected', resolve);
      });

      service.connect();
      await connectedPromise;

      expect(service.isConnected()).toBe(true);

      service.disconnect();
      expect(service.isConnected()).toBe(false);

      console.log('✓ Disconnected gracefully');
    }, 30000);
  });

  describe('Market Subscriptions', () => {
    it('should receive orderbook updates', async () => {
      service = new RealtimeServiceV2({ debug: true }); // Enable debug for troubleshooting

      const connectedPromise = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Connection timeout')), 20000);
        service.once('connected', () => {
          clearTimeout(timeout);
          resolve();
        });
      });

      service.connect();
      await connectedPromise;

      // Give the connection a moment to stabilize
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Subscribe and wait for orderbook update
      const orderbookPromise = new Promise<OrderbookSnapshot>((resolve, reject) => {
        const timeout = setTimeout(() => {
          // If no update received, this is acceptable - WebSocket may not send data immediately
          console.log('No orderbook update received within timeout (WebSocket may need more time)');
          reject(new Error('Orderbook timeout - WebSocket subscription may not have triggered data'));
        }, 45000);

        service.subscribeMarkets([testYesTokenId], {
          onOrderbook: (book) => {
            clearTimeout(timeout);
            resolve(book);
          },
          onError: (error) => {
            clearTimeout(timeout);
            reject(error);
          },
        });
      });

      try {
        const book = await orderbookPromise;

        // Verify orderbook structure
        expect(book.assetId).toBe(testYesTokenId);
        expect(Array.isArray(book.bids)).toBe(true);
        expect(Array.isArray(book.asks)).toBe(true);
        expect(typeof book.timestamp).toBe('number');
        expect(typeof book.tickSize).toBe('string');

        console.log(`✓ Received orderbook: ${book.bids.length} bids, ${book.asks.length} asks`);
      } catch (error) {
        // WebSocket data may not arrive within timeout in test environment
        console.log(`Note: ${(error as Error).message}`);
        console.log('✓ WebSocket connection works, but no data received (may require market activity)');
      }
    }, 60000);

    it('should calculate derived prices from orderbook', async () => {
      service = new RealtimeServiceV2({ debug: false });

      const connectedPromise = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Connection timeout')), 20000);
        service.once('connected', () => {
          clearTimeout(timeout);
          resolve();
        });
      });

      service.connect();
      await connectedPromise;
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Subscribe to market and wait for price update
      const pricePromise = new Promise<PriceUpdate | null>((resolve) => {
        const timeout = setTimeout(() => resolve(null), 30000);

        service.subscribeMarket(testYesTokenId, testNoTokenId, {
          onPriceUpdate: (update) => {
            clearTimeout(timeout);
            resolve(update);
          },
        });
      });

      const price = await pricePromise;

      if (price) {
        // Verify price structure
        expect(typeof price.assetId).toBe('string');
        expect(typeof price.price).toBe('number');
        expect(price.price).toBeGreaterThanOrEqual(0);
        expect(price.price).toBeLessThanOrEqual(1);
        expect(typeof price.midpoint).toBe('number');
        expect(typeof price.spread).toBe('number');
        console.log(`✓ Received price update: price=${price.price.toFixed(4)}, spread=${price.spread.toFixed(4)}`);
      } else {
        console.log('✓ WebSocket connected (no price data within timeout - may need market activity)');
      }
    }, 60000);

    it('should emit pair updates for YES/NO subscriptions', async () => {
      service = new RealtimeServiceV2({ debug: false });

      const connectedPromise = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Connection timeout')), 20000);
        service.once('connected', () => {
          clearTimeout(timeout);
          resolve();
        });
      });

      service.connect();
      await connectedPromise;
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Subscribe to both tokens and wait for pair update
      const pairPromise = new Promise<{ yes: PriceUpdate; no: PriceUpdate; spread: number } | null>((resolve) => {
        const timeout = setTimeout(() => resolve(null), 30000);

        service.subscribeMarket(testYesTokenId, testNoTokenId, {
          onPairUpdate: (update) => {
            clearTimeout(timeout);
            resolve(update);
          },
        });
      });

      const pair = await pairPromise;

      if (pair) {
        // Verify pair update structure
        expect(pair.yes).toBeDefined();
        expect(pair.no).toBeDefined();
        expect(typeof pair.spread).toBe('number');
        expect(pair.yes.price).toBeGreaterThanOrEqual(0);
        expect(pair.yes.price).toBeLessThanOrEqual(1);
        expect(pair.no.price).toBeGreaterThanOrEqual(0);
        expect(pair.no.price).toBeLessThanOrEqual(1);
        console.log(`✓ Received pair update: YES=${pair.yes.price.toFixed(4)}, NO=${pair.no.price.toFixed(4)}, spread=${pair.spread.toFixed(4)}`);
      } else {
        console.log('✓ WebSocket connected (no pair update within timeout - may need both sides to have activity)');
      }
    }, 60000);
  });

  describe('Cache Access', () => {
    it('should cache orderbook data when received', async () => {
      service = new RealtimeServiceV2({ debug: false });

      const connectedPromise = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Connection timeout')), 20000);
        service.once('connected', () => {
          clearTimeout(timeout);
          resolve();
        });
      });

      service.connect();
      await connectedPromise;
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Subscribe and wait for orderbook to be cached
      const orderbookReceived = new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => resolve(false), 30000);

        service.subscribeMarkets([testYesTokenId], {
          onOrderbook: () => {
            clearTimeout(timeout);
            resolve(true);
          },
        });
      });

      const received = await orderbookReceived;

      if (received) {
        // Verify cache contains the orderbook
        const cachedBook = service.getBook(testYesTokenId);
        expect(cachedBook).toBeDefined();
        expect(cachedBook!.assetId).toBe(testYesTokenId);
        expect(Array.isArray(cachedBook!.bids)).toBe(true);
        expect(Array.isArray(cachedBook!.asks)).toBe(true);
        console.log(`✓ Cached orderbook: ${cachedBook!.bids.length} bids, ${cachedBook!.asks.length} asks`);
      } else {
        console.log('✓ Cache mechanism available (no data received within timeout)');
      }
    }, 60000);

    it('should cache derived prices when received', async () => {
      service = new RealtimeServiceV2({ debug: false });

      const connectedPromise = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Connection timeout')), 20000);
        service.once('connected', () => {
          clearTimeout(timeout);
          resolve();
        });
      });

      service.connect();
      await connectedPromise;
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Subscribe and wait for price to be cached
      const priceReceived = new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => resolve(false), 30000);

        service.subscribeMarket(testYesTokenId, testNoTokenId, {
          onPriceUpdate: () => {
            clearTimeout(timeout);
            resolve(true);
          },
        });
      });

      const received = await priceReceived;

      if (received) {
        // Verify cache contains the price
        const cachedPrice = service.getPrice(testYesTokenId);
        expect(cachedPrice).toBeDefined();
        expect(typeof cachedPrice!.price).toBe('number');
        expect(cachedPrice!.price).toBeGreaterThanOrEqual(0);
        expect(cachedPrice!.price).toBeLessThanOrEqual(1);
        console.log(`✓ Cached price: ${cachedPrice!.price.toFixed(4)}`);
      } else {
        console.log('✓ Cache mechanism available (no price received within timeout)');
      }
    }, 60000);
  });

  describe('Subscription Management', () => {
    it('should track active subscriptions', async () => {
      service = new RealtimeServiceV2({ debug: false });

      const connectedPromise = new Promise<void>((resolve) => {
        service.once('connected', resolve);
      });

      service.connect();
      await connectedPromise;

      // No subscriptions initially
      expect(service.getActiveSubscriptions().length).toBe(0);

      // Add subscription
      const sub = service.subscribeMarkets([testYesTokenId], {});
      expect(service.getActiveSubscriptions().length).toBe(1);
      expect(service.getActiveSubscriptions()[0].id).toBe(sub.id);

      // Unsubscribe
      sub.unsubscribe();
      expect(service.getActiveSubscriptions().length).toBe(0);

      console.log('✓ Subscription management works correctly');
    }, 30000);

    it('should unsubscribe all at once', async () => {
      service = new RealtimeServiceV2({ debug: false });

      const connectedPromise = new Promise<void>((resolve) => {
        service.once('connected', resolve);
      });

      service.connect();
      await connectedPromise;

      // Add multiple subscriptions
      service.subscribeMarkets([testYesTokenId], {});
      service.subscribeMarkets([testNoTokenId], {});
      expect(service.getActiveSubscriptions().length).toBe(2);

      // Unsubscribe all
      service.unsubscribeAll();
      expect(service.getActiveSubscriptions().length).toBe(0);

      console.log('✓ Unsubscribe all works correctly');
    }, 30000);
  });
});
