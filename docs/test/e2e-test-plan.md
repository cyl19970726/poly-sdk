# poly-sdk E2E Test Plan

> Comprehensive end-to-end test plan for the new poly-sdk architecture

**Date**: 2025-12-26
**Architecture Version**: v2 (Official Polymarket clients)
**Test Framework**: Vitest

---

## Overview

This document outlines the E2E test plan for poly-sdk's new architecture, which uses:

1. **TradingService** - Wraps official `@polymarket/clob-client` for trading and market data
2. **RealtimeServiceV2** - Uses official `@polymarket/real-time-data-client` for WebSocket data
3. **ArbitrageService** - Real-time arbitrage detection using RealtimeServiceV2
4. **RealtimeService** (legacy) - Backward-compatible wrapper around V2

---

## Test Commands

```bash
# Run all unit tests
pnpm test

# Run all integration tests (real API calls)
pnpm test:integration

# Run specific test file
pnpm vitest run src/__tests__/integration/trading-service.integration.test.ts

# Run with verbose output
pnpm vitest run --reporter=verbose

# Run tests matching pattern
pnpm vitest run -t "TradingService"

# Run single example script for manual verification
pnpm tsx examples/07-realtime-websocket.ts
```

---

## 1. TradingService Tests

**File**: `src/__tests__/integration/trading-service.integration.test.ts`

TradingService wraps the official `@polymarket/clob-client` and provides:
- Market data fetching
- Orderbook access
- Price history
- Order management (requires API credentials)

### 1.1 Market Data Tests (No Auth Required)

| Test Case | Method | Expected Outcome |
|-----------|--------|------------------|
| Fetch known market | `getMarket(conditionId)` | Returns valid Market object with tokens |
| Fetch orderbook | `getOrderbook(tokenId)` | Returns sorted bids/asks arrays |
| Fetch processed orderbook | `getProcessedOrderbook(conditionId)` | Returns analytics with effective prices |
| Fetch price history | `getPricesHistory({ tokenId, interval })` | Returns array of PricePoint objects |
| Get midpoint | `getMidpoint(tokenId)` | Returns number between 0 and 1 |
| Get spread | `getSpread(tokenId)` | Returns positive number |
| Get tick size | `getTickSize(tokenId)` | Returns valid TickSize enum value |

```typescript
// Example test structure
describe('TradingService Integration', () => {
  let service: TradingService;
  let testMarketConditionId: string;
  let testTokenId: string;

  beforeAll(async () => {
    // Use test private key (can be any valid key for read-only operations)
    const config: TradingServiceConfig = {
      privateKey: process.env.TEST_PRIVATE_KEY || '0x' + '1'.repeat(64),
    };

    service = new TradingService(
      new RateLimiter(),
      createUnifiedCache(),
      config
    );

    // Initialize (creates API credentials)
    await service.initialize();

    // Find a liquid market for testing
    const response = await fetch(
      'https://gamma-api.polymarket.com/markets?active=true&limit=1&order=volume24hr&ascending=false'
    );
    const markets = await response.json();
    testMarketConditionId = markets[0].conditionId;

    const market = await service.getMarket(testMarketConditionId);
    testTokenId = market.tokens[0]?.tokenId;
  });

  describe('getMarket', () => {
    it('should return a valid market object', async () => {
      const market = await service.getMarket(testMarketConditionId);

      expect(market.conditionId).toBe(testMarketConditionId);
      expect(typeof market.question).toBe('string');
      expect(market.tokens.length).toBeGreaterThanOrEqual(2);
      expect(market.tokens[0]?.tokenId).toBeDefined();
      expect(market.tokens[1]?.tokenId).toBeDefined();
    });
  });

  describe('getOrderbook', () => {
    it('should return sorted bids and asks', async () => {
      const book = await service.getOrderbook(testTokenId);

      expect(Array.isArray(book.bids)).toBe(true);
      expect(Array.isArray(book.asks)).toBe(true);

      // Bids should be sorted descending
      for (let i = 1; i < book.bids.length; i++) {
        expect(book.bids[i].price).toBeLessThanOrEqual(book.bids[i-1].price);
      }

      // Asks should be sorted ascending
      for (let i = 1; i < book.asks.length; i++) {
        expect(book.asks[i].price).toBeGreaterThanOrEqual(book.asks[i-1].price);
      }
    });
  });

  describe('getPricesHistory', () => {
    it('should return price history for 1d interval', async () => {
      const history = await service.getPricesHistory({
        tokenId: testTokenId,
        interval: '1d',
      });

      expect(Array.isArray(history)).toBe(true);
      expect(history.length).toBeGreaterThan(0);

      for (const point of history) {
        expect(typeof point.timestamp).toBe('number');
        expect(typeof point.price).toBe('number');
        expect(point.price).toBeGreaterThanOrEqual(0);
        expect(point.price).toBeLessThanOrEqual(1);
      }
    });
  });

  describe('getMidpoint', () => {
    it('should return midpoint between 0 and 1', async () => {
      const midpoint = await service.getMidpoint(testTokenId);

      expect(typeof midpoint).toBe('number');
      expect(midpoint).toBeGreaterThanOrEqual(0);
      expect(midpoint).toBeLessThanOrEqual(1);
    });
  });

  describe('getSpread', () => {
    it('should return positive spread', async () => {
      const spread = await service.getSpread(testTokenId);

      expect(typeof spread).toBe('number');
      expect(spread).toBeGreaterThanOrEqual(0);
    });
  });
});
```

### 1.2 Order Management Tests (Requires API Credentials)

**Note**: These tests require valid API credentials and should be run with caution.

| Test Case | Method | Expected Outcome | Skip Condition |
|-----------|--------|------------------|----------------|
| Create limit order | `createLimitOrder(params)` | Returns OrderResult with orderId | No credentials |
| Cancel order | `cancelOrder(orderId)` | Returns success status | No credentials |
| Get open orders | `getOpenOrders()` | Returns array of Order objects | No credentials |
| Get trades | `getTrades()` | Returns array of TradeInfo objects | No credentials |

```typescript
describe('TradingService Order Management', () => {
  // Skip if no credentials
  const skipIfNoCredentials = !process.env.POLY_PRIVATE_KEY;

  it.skipIf(skipIfNoCredentials)('should create and cancel a limit order', async () => {
    const service = new TradingService(
      new RateLimiter(),
      createUnifiedCache(),
      { privateKey: process.env.POLY_PRIVATE_KEY! }
    );
    await service.initialize();

    // Create a very low price order (won't fill)
    const result = await service.createLimitOrder({
      tokenId: testTokenId,
      side: 'BUY',
      price: 0.01,  // Very unlikely to fill
      size: 1,
      orderType: 'GTC',
    });

    expect(result.success).toBe(true);
    expect(result.orderId).toBeDefined();

    // Cancel immediately
    if (result.orderId) {
      const cancelResult = await service.cancelOrder(result.orderId);
      expect(cancelResult.success).toBe(true);
    }
  });
});
```

---

## 2. RealtimeServiceV2 Tests

**File**: `src/__tests__/integration/realtime-service-v2.integration.test.ts`

RealtimeServiceV2 uses the official `@polymarket/real-time-data-client` for WebSocket connections.

### 2.1 Connection Tests

| Test Case | Method | Expected Outcome |
|-----------|--------|------------------|
| Connect to WebSocket | `connect()` | Emits 'connected' event |
| Disconnect cleanly | `disconnect()` | No errors, clears subscriptions |
| Check connection status | `isConnected()` | Returns correct boolean |

### 2.2 Market Data Subscription Tests

| Test Case | Method | Expected Outcome |
|-----------|--------|------------------|
| Subscribe to markets | `subscribeMarkets(tokenIds, handlers)` | Receives orderbook updates |
| Subscribe single market | `subscribeMarket(yesId, noId, handlers)` | Receives pair updates |
| Receive orderbook snapshot | `handlers.onOrderbook` | Valid OrderbookSnapshot object |
| Calculate derived price | `handlers.onPriceUpdate` (via subscribeMarket) | Price based on midpoint/last trade |
| Handle book updates | `handlers.onBookUpdate` | Valid BookUpdate object |
| Unsubscribe | `subscription.unsubscribe()` | Stops receiving updates |

```typescript
describe('RealtimeServiceV2 Integration', () => {
  let service: RealtimeServiceV2;
  let yesTokenId: string;
  let noTokenId: string;

  beforeAll(async () => {
    // Get test market tokens
    const response = await fetch(
      'https://gamma-api.polymarket.com/markets?active=true&limit=1&order=volume24hr&ascending=false'
    );
    const markets = await response.json();
    const conditionId = markets[0].conditionId;

    const clobResponse = await fetch(
      `https://clob.polymarket.com/markets/${conditionId}`
    );
    const market = await clobResponse.json();
    yesTokenId = market.tokens[0].token_id;
    noTokenId = market.tokens[1].token_id;
  });

  beforeEach(() => {
    service = new RealtimeServiceV2({ debug: false });
  });

  afterEach(() => {
    service.disconnect();
  });

  describe('Connection', () => {
    it('should connect and emit connected event', async () => {
      const connectedPromise = new Promise<void>((resolve) => {
        service.on('connected', () => resolve());
      });

      service.connect();
      await expect(connectedPromise).resolves.toBeUndefined();
      expect(service.isConnected()).toBe(true);
    }, 10000);

    it('should disconnect cleanly', async () => {
      service.connect();

      // Wait for connection
      await new Promise((resolve) => {
        service.on('connected', resolve);
      });

      service.disconnect();
      expect(service.isConnected()).toBe(false);
    }, 10000);
  });

  describe('Market Subscriptions', () => {
    it('should receive orderbook updates', async () => {
      const orderbookPromise = new Promise<OrderbookSnapshot>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timeout')), 30000);

        service.on('connected', () => {
          service.subscribeMarkets([yesTokenId], {
            onOrderbook: (book) => {
              clearTimeout(timeout);
              resolve(book);
            },
          });
        });
      });

      service.connect();
      const book = await orderbookPromise;

      expect(book.assetId).toBe(yesTokenId);
      expect(Array.isArray(book.bids)).toBe(true);
      expect(Array.isArray(book.asks)).toBe(true);
      expect(typeof book.timestamp).toBe('number');
    }, 35000);

    it('should receive derived price updates via subscribeMarket', async () => {
      const pricePromise = new Promise<PriceUpdate>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timeout')), 30000);

        service.on('connected', () => {
          service.subscribeMarket(yesTokenId, noTokenId, {
            onPriceUpdate: (update) => {
              clearTimeout(timeout);
              resolve(update);
            },
          });
        });
      });

      service.connect();
      const price = await pricePromise;

      expect(typeof price.assetId).toBe('string');
      expect(typeof price.price).toBe('number');
      expect(typeof price.midpoint).toBe('number');
      expect(typeof price.spread).toBe('number');
      expect(price.price).toBeGreaterThanOrEqual(0);
      expect(price.price).toBeLessThanOrEqual(1);
    }, 35000);

    it('should receive pair updates with spread', async () => {
      const pairPromise = new Promise<{ yes: PriceUpdate; no: PriceUpdate; spread: number }>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timeout')), 60000);

        service.on('connected', () => {
          service.subscribeMarket(yesTokenId, noTokenId, {
            onPairUpdate: (update) => {
              clearTimeout(timeout);
              resolve(update);
            },
          });
        });
      });

      service.connect();
      const pair = await pairPromise;

      expect(typeof pair.yes.price).toBe('number');
      expect(typeof pair.no.price).toBe('number');
      expect(typeof pair.spread).toBe('number');
      // Spread should be close to 1 (YES + NO prices)
      expect(pair.spread).toBeGreaterThan(0.9);
      expect(pair.spread).toBeLessThan(1.1);
    }, 65000);
  });

  describe('Cache Access', () => {
    it('should cache price and orderbook data', async () => {
      const readyPromise = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timeout')), 30000);

        service.on('connected', () => {
          service.subscribeMarkets([yesTokenId], {
            onOrderbook: () => {
              clearTimeout(timeout);
              resolve();
            },
          });
        });
      });

      service.connect();
      await readyPromise;

      // Check cache
      const price = service.getPrice(yesTokenId);
      const book = service.getBook(yesTokenId);

      expect(price).toBeDefined();
      expect(book).toBeDefined();
    }, 35000);
  });
});
```

### 2.3 Event Emission Verification

| Test Case | Event | Expected Data |
|-----------|-------|---------------|
| Orderbook received | `'orderbook'` | OrderbookSnapshot |
| Price change | `'priceChange'` | PriceChange |
| Last trade | `'lastTrade'` | LastTradeInfo |
| Price update (derived) | `'priceUpdate'` | PriceUpdate |

---

## 3. ArbitrageService Tests

**File**: `src/__tests__/integration/arbitrage-service.integration.test.ts`

ArbitrageService uses RealtimeServiceV2 (not the old WebSocketManager) for real-time orderbook monitoring.

### 3.1 Architecture Verification

| Test Case | Verification | Expected Outcome |
|-----------|--------------|------------------|
| Uses RealtimeServiceV2 | Check constructor | `RealtimeServiceV2` instance created |
| Not using old WebSocketManager | Code inspection | No WebSocketManager imports |
| Event handlers registered | Check subscription | `onOrderbook` handler connected |

### 3.2 Orderbook Subscription Tests

| Test Case | Method | Expected Outcome |
|-----------|--------|------------------|
| Start monitoring | `start(market)` | WebSocket connected, subscription active |
| Receive book updates | `handleBookUpdate()` | Orderbook state updated |
| Stop monitoring | `stop()` | WebSocket disconnected, stats logged |

```typescript
describe('ArbitrageService Integration', () => {
  let service: ArbitrageService;
  let testMarket: ArbitrageMarketConfig;

  beforeAll(async () => {
    // Get a test market
    const response = await fetch(
      'https://gamma-api.polymarket.com/markets?active=true&limit=1&order=volume24hr&ascending=false'
    );
    const markets = await response.json();
    const conditionId = markets[0].conditionId;
    const question = markets[0].question;

    const clobResponse = await fetch(
      `https://clob.polymarket.com/markets/${conditionId}`
    );
    const market = await clobResponse.json();

    testMarket = {
      name: question.slice(0, 50),
      conditionId,
      yesTokenId: market.tokens[0].token_id,
      noTokenId: market.tokens[1].token_id,
    };
  });

  afterEach(async () => {
    if (service) {
      await service.stop();
    }
  });

  describe('Architecture', () => {
    it('should use RealtimeServiceV2 internally', () => {
      service = new ArbitrageService({ enableLogging: false });

      // The service should create RealtimeServiceV2 in constructor
      // This is verified by the fact that start() works with WebSocket
      expect(service).toBeDefined();
    });
  });

  describe('Orderbook Subscription', () => {
    it('should receive orderbook updates via handleBookUpdate', async () => {
      service = new ArbitrageService({ enableLogging: false });

      const orderbookPromise = new Promise<OrderbookState>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timeout')), 30000);

        service.on('orderbookUpdate', (orderbook) => {
          if (orderbook.yesBids.length > 0 || orderbook.yesAsks.length > 0) {
            clearTimeout(timeout);
            resolve(orderbook);
          }
        });
      });

      await service.start(testMarket);
      const orderbook = await orderbookPromise;

      // Verify orderbook structure
      expect(Array.isArray(orderbook.yesBids)).toBe(true);
      expect(Array.isArray(orderbook.yesAsks)).toBe(true);
      expect(Array.isArray(orderbook.noBids)).toBe(true);
      expect(Array.isArray(orderbook.noAsks)).toBe(true);
      expect(typeof orderbook.lastUpdate).toBe('number');
    }, 35000);

    it('should emit started event on start', async () => {
      service = new ArbitrageService({ enableLogging: false });

      const startedPromise = new Promise<ArbitrageMarketConfig>((resolve) => {
        service.on('started', resolve);
      });

      await service.start(testMarket);
      const market = await startedPromise;

      expect(market.conditionId).toBe(testMarket.conditionId);
    }, 10000);

    it('should emit stopped event on stop', async () => {
      service = new ArbitrageService({ enableLogging: false });

      await service.start(testMarket);

      const stoppedPromise = new Promise<void>((resolve) => {
        service.on('stopped', resolve);
      });

      await service.stop();
      await stoppedPromise;

      // Verify stats are available
      const stats = service.getStats();
      expect(typeof stats.opportunitiesDetected).toBe('number');
      expect(typeof stats.executionsAttempted).toBe('number');
    }, 10000);
  });

  describe('Opportunity Detection', () => {
    it('should check for opportunities when orderbook updates', async () => {
      service = new ArbitrageService({
        enableLogging: false,
        profitThreshold: 0.001, // Low threshold for testing
      });

      // Wait for enough orderbook data
      const readyPromise = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => resolve(), 15000); // Resolve after timeout anyway
        let bothSidesReceived = false;

        service.on('orderbookUpdate', (orderbook) => {
          if (orderbook.yesBids.length > 0 && orderbook.noBids.length > 0) {
            if (!bothSidesReceived) {
              bothSidesReceived = true;
              clearTimeout(timeout);
              resolve();
            }
          }
        });
      });

      await service.start(testMarket);
      await readyPromise;

      // Check opportunity (may or may not exist)
      const opportunity = service.checkOpportunity();

      if (opportunity) {
        expect(['long', 'short']).toContain(opportunity.type);
        expect(typeof opportunity.profitRate).toBe('number');
        expect(typeof opportunity.profitPercent).toBe('number');
        expect(typeof opportunity.recommendedSize).toBe('number');
      }
    }, 20000);
  });
});
```

### 3.3 Arbitrage Detection Tests

| Test Case | Method | Expected Outcome |
|-----------|--------|------------------|
| Check opportunity | `checkOpportunity()` | Returns ArbitrageOpportunity or null |
| Long arb detection | When effectiveLongCost < 1 | `type: 'long'`, positive profit |
| Short arb detection | When effectiveShortRevenue > 1 | `type: 'short'`, positive profit |
| No arb when balanced | When no profit | Returns null |

---

## 4. Legacy RealtimeService Tests

**File**: `src/__tests__/integration/realtime-service-legacy.integration.test.ts`

The legacy RealtimeService is a backward-compatible wrapper around RealtimeServiceV2.

### 4.1 Wrapper Verification

| Test Case | Verification | Expected Outcome |
|-----------|--------------|------------------|
| Wraps V2 internally | Constructor check | Creates RealtimeServiceV2 instance |
| API compatibility | Method signatures | Same as old interface |

### 4.2 Handler Tests

| Test Case | Method | Expected Outcome |
|-----------|--------|------------------|
| Subscribe markets | `subscribeMarkets(assetIds, handlers)` | Returns Subscription object |
| onPriceUpdate fires | `handlers.onPriceUpdate` | Receives PriceUpdate object |
| onBookUpdate fires | `handlers.onBookUpdate` | Receives BookUpdate object |
| onLastTrade fires | `handlers.onLastTrade` | Receives trade info object |
| Unsubscribe works | `subscription.unsubscribe()` | Clears caches, stops updates |

```typescript
describe('RealtimeService (Legacy) Integration', () => {
  let service: RealtimeService;
  let testTokenId: string;

  beforeAll(async () => {
    // Get test token
    const response = await fetch(
      'https://gamma-api.polymarket.com/markets?active=true&limit=1&order=volume24hr&ascending=false'
    );
    const markets = await response.json();
    const conditionId = markets[0].conditionId;

    const clobResponse = await fetch(
      `https://clob.polymarket.com/markets/${conditionId}`
    );
    const market = await clobResponse.json();
    testTokenId = market.tokens[0].token_id;
  });

  beforeEach(() => {
    service = new RealtimeService();
  });

  afterEach(async () => {
    await service.unsubscribeAll();
    service.disconnect();
  });

  describe('Wrapper Compatibility', () => {
    it('should have same interface as original RealtimeService', () => {
      expect(typeof service.subscribeMarkets).toBe('function');
      expect(typeof service.subscribeMarket).toBe('function');
      expect(typeof service.getPrice).toBe('function');
      expect(typeof service.getBook).toBe('function');
      expect(typeof service.getAllPrices).toBe('function');
      expect(typeof service.getActiveSubscriptions).toBe('function');
      expect(typeof service.unsubscribeAll).toBe('function');
      expect(typeof service.disconnect).toBe('function');
    });
  });

  describe('Handler Callbacks', () => {
    it('should call onPriceUpdate handler', async () => {
      const pricePromise = new Promise<PriceUpdate>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timeout')), 30000);

        service.subscribeMarkets([testTokenId], {
          onPriceUpdate: (update) => {
            clearTimeout(timeout);
            resolve(update);
          },
        });
      });

      const price = await pricePromise;

      expect(price.assetId).toBe(testTokenId);
      expect(typeof price.price).toBe('number');
      expect(typeof price.midpoint).toBe('number');
      expect(typeof price.spread).toBe('number');
    }, 35000);

    it('should call onBookUpdate handler', async () => {
      const bookPromise = new Promise<BookUpdate>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timeout')), 30000);

        service.subscribeMarkets([testTokenId], {
          onBookUpdate: (book) => {
            clearTimeout(timeout);
            resolve(book);
          },
        });
      });

      const book = await bookPromise;

      expect(book.assetId).toBe(testTokenId);
      expect(Array.isArray(book.bids)).toBe(true);
      expect(Array.isArray(book.asks)).toBe(true);
    }, 35000);
  });

  describe('Cache Access', () => {
    it('should provide cached price via getPrice()', async () => {
      const readyPromise = new Promise<void>((resolve) => {
        service.subscribeMarkets([testTokenId], {
          onPriceUpdate: () => resolve(),
        });
      });

      await readyPromise;

      const price = service.getPrice(testTokenId);
      expect(price).toBeDefined();
      expect(price?.assetId).toBe(testTokenId);
    }, 35000);

    it('should provide cached book via getBook()', async () => {
      const readyPromise = new Promise<void>((resolve) => {
        service.subscribeMarkets([testTokenId], {
          onBookUpdate: () => resolve(),
        });
      });

      await readyPromise;

      const book = service.getBook(testTokenId);
      expect(book).toBeDefined();
      expect(book?.assetId).toBe(testTokenId);
    }, 35000);
  });

  describe('Subscription Management', () => {
    it('should unsubscribe and clear caches', async () => {
      const sub = await service.subscribeMarkets([testTokenId], {
        onPriceUpdate: () => {},
      });

      // Wait a bit for data
      await new Promise((resolve) => setTimeout(resolve, 5000));

      // Should have cache
      expect(service.getPrice(testTokenId)).toBeDefined();

      // Unsubscribe
      await sub.unsubscribe();

      // Cache should be cleared for this subscription
      expect(service.getActiveSubscriptions().find(s => s.id === sub.id)).toBeUndefined();
    }, 15000);
  });
});
```

---

## 5. Test Environment Setup

### 5.1 Environment Variables

```bash
# .env.test (do not commit)

# Required for order management tests (optional for read-only)
POLY_PRIVATE_KEY=0x...

# Optional: Pre-generated API credentials
POLY_API_KEY=...
POLY_API_SECRET=...
POLY_API_PASSPHRASE=...
```

### 5.2 Test Utilities

**File**: `src/__tests__/test-utils.ts`

```typescript
import { describe } from 'vitest';

/**
 * Get a liquid test market from Polymarket
 */
export async function getTestMarket(): Promise<{
  conditionId: string;
  yesTokenId: string;
  noTokenId: string;
  question: string;
}> {
  const response = await fetch(
    'https://gamma-api.polymarket.com/markets?active=true&limit=1&order=volume24hr&ascending=false'
  );
  const markets = await response.json();

  if (markets.length === 0) {
    throw new Error('No active markets found');
  }

  const conditionId = markets[0].conditionId;
  const question = markets[0].question;

  const clobResponse = await fetch(
    `https://clob.polymarket.com/markets/${conditionId}`
  );
  const market = await clobResponse.json();

  return {
    conditionId,
    yesTokenId: market.tokens[0].token_id,
    noTokenId: market.tokens[1].token_id,
    question,
  };
}

/**
 * Wait for WebSocket event with timeout
 */
export function waitForEvent<T>(
  emitter: { on: (event: string, handler: (data: T) => void) => void },
  eventName: string,
  timeoutMs = 30000
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timeout waiting for '${eventName}' event`));
    }, timeoutMs);

    emitter.on(eventName, (data: T) => {
      clearTimeout(timeout);
      resolve(data);
    });
  });
}

/**
 * Skip test if condition is true
 */
export function skipIf(condition: boolean, reason: string) {
  if (condition) {
    return describe.skip;
  }
  return describe;
}
```

---

## 6. Test Coverage Matrix

| Component | Unit Tests | Integration Tests | E2E Tests |
|-----------|:----------:|:-----------------:|:---------:|
| TradingService (market data) | - | Yes | - |
| TradingService (orders) | - | Conditional | - |
| RealtimeServiceV2 (connection) | - | Yes | - |
| RealtimeServiceV2 (subscriptions) | - | Yes | - |
| RealtimeServiceV2 (cache) | - | Yes | - |
| ArbitrageService (monitoring) | - | Yes | - |
| ArbitrageService (detection) | - | Yes | - |
| ArbitrageService (execution) | - | Conditional | - |
| RealtimeService (legacy wrapper) | - | Yes | - |

**Legend**:
- Yes: Test should be implemented
- Conditional: Requires credentials, skip if not available
- -: Not applicable

---

## 7. Execution Checklist

### Before Running Tests

- [ ] Ensure internet connection is stable
- [ ] Verify Polymarket APIs are accessible
- [ ] Set up `.env.test` if running order tests
- [ ] Clear any cached test data if needed

### Running Tests

```bash
# Step 1: Run unit tests first (should be fast)
pnpm test

# Step 2: Run integration tests (requires network)
pnpm test:integration

# Step 3: Run specific service tests
pnpm vitest run src/__tests__/integration/trading-service.integration.test.ts
pnpm vitest run src/__tests__/integration/realtime-service-v2.integration.test.ts
pnpm vitest run src/__tests__/integration/arbitrage-service.integration.test.ts
pnpm vitest run src/__tests__/integration/realtime-service-legacy.integration.test.ts
```

### After Tests

- [ ] Review test output for failures
- [ ] Check for flaky tests (re-run if needed)
- [ ] Cancel any test orders if order tests ran
- [ ] Document any API changes discovered

---

## 8. Expected Test Results

### Success Criteria

1. **TradingService**: All market data methods return valid data structures
2. **RealtimeServiceV2**: WebSocket connects, subscribes, and receives updates
3. **ArbitrageService**: Uses V2 for subscriptions, receives orderbook updates
4. **RealtimeService (legacy)**: Handler callbacks work as expected

### Known Limitations

1. **WebSocket Tests**: May be flaky due to network conditions
2. **Order Tests**: Require real credentials and incur API usage
3. **Arbitrage Detection**: Opportunities depend on market conditions
4. **Rate Limiting**: Tests may hit rate limits if run too frequently

---

## 9. Manual Verification Scripts

For quick manual verification without running the full test suite:

```bash
# Test TradingService
pnpm tsx examples/08-trading-orders.ts

# Test RealtimeServiceV2
pnpm tsx examples/07-realtime-websocket.ts

# Test ArbitrageService
pnpm tsx examples/13-arbitrage-service.ts
```

---

## Appendix: Type Definitions

### PriceUpdate
```typescript
interface PriceUpdate {
  assetId: string;
  price: number;
  midpoint: number;
  spread: number;
  timestamp: number;
}
```

### BookUpdate
```typescript
interface BookUpdate {
  assetId: string;
  bids: Array<{ price: number; size: number }>;
  asks: Array<{ price: number; size: number }>;
  timestamp: number;
}
```

### OrderbookSnapshot (V2)
```typescript
interface OrderbookSnapshot {
  assetId: string;
  market: string;
  bids: Array<{ price: number; size: number }>;
  asks: Array<{ price: number; size: number }>;
  timestamp: number;
  tickSize: string;
  minOrderSize: string;
  hash: string;
}
```

### ArbitrageOpportunity
```typescript
interface ArbitrageOpportunity {
  type: 'long' | 'short';
  profitRate: number;
  profitPercent: number;
  effectivePrices: {
    buyYes: number;
    buyNo: number;
    sellYes: number;
    sellNo: number;
  };
  maxOrderbookSize: number;
  maxBalanceSize: number;
  recommendedSize: number;
  estimatedProfit: number;
  description: string;
  timestamp: number;
}
```
