#!/usr/bin/env npx tsx
/**
 * Quick test for RealTimeDataClient
 *
 * Dynamically scans for active BTC 15m markets and tests:
 * 1. Connection stability
 * 2. Orderbook (book) events
 * 3. Price change events
 * 4. Last trade price events
 *
 * Usage:
 *   npx tsx scripts/real-time-service/test-realtime-quick.ts
 */

import { RealtimeServiceV2 } from '../../src/services/realtime-service-v2.js';
import { MarketService } from '../../src/services/market-service.js';
import { GammaApiClient } from '../../src/clients/gamma-api.js';
import { RateLimiter } from '../../src/core/rate-limiter.js';
import { createUnifiedCache } from '../../src/core/unified-cache.js';
import type { OrderbookSnapshot, LastTradeInfo, PriceChange } from '../../src/services/realtime-service-v2.js';

// ============================================================================
// Configuration
// ============================================================================

const DURATION_MS = 30_000; // 30 seconds
const COIN: 'BTC' | 'ETH' | 'SOL' | 'XRP' | 'all' = 'BTC'; // Can be BTC, ETH, SOL, XRP, all

// ============================================================================
// Stats
// ============================================================================

interface Stats {
  bookEvents: number;
  priceChangeEvents: number;
  lastTradeEvents: number;
  errors: string[];
  lastOrderbook: OrderbookSnapshot | null;
  upPrices: number[];
  downPrices: number[];
}

const stats: Stats = {
  bookEvents: 0,
  priceChangeEvents: 0,
  lastTradeEvents: 0,
  errors: [],
  lastOrderbook: null,
  upPrices: [],
  downPrices: [],
};

// ============================================================================
// Logging
// ============================================================================

function log(message: string): void {
  const ts = new Date().toISOString().split('T')[1].replace('Z', '');
  console.log(`[${ts}] ${message}`);
}

// ============================================================================
// Market Discovery
// ============================================================================

interface MarketTokens {
  conditionId: string;
  question: string;
  upTokenId: string;
  downTokenId: string;
  minutesUntilEnd: number;
}

async function findActiveMarket(): Promise<MarketTokens> {
  log(`Scanning for active ${COIN} 15m markets...`);

  // Create dependencies for MarketService
  const rateLimiter = new RateLimiter();
  const cache = createUnifiedCache();
  const gammaApi = new GammaApiClient(rateLimiter, cache);

  const marketService = new MarketService(gammaApi, undefined, rateLimiter, cache);
  const markets = await marketService.scanCryptoShortTermMarkets({
    duration: '15m',
    minMinutesUntilEnd: 2,
    maxMinutesUntilEnd: 16,
    coin: COIN,
    limit: 5,
  });

  if (markets.length === 0) {
    throw new Error(`No active ${COIN} 15m markets found. Try again in a few minutes.`);
  }

  const market = markets[0];
  log(`Found: ${market.question}`);
  log(`  Minutes until end: ${market.minutesUntilEnd}`);
  log(`  Current prices: Up=${market.outcomePrices[0]} Down=${market.outcomePrices[1]}`);

  // Get token IDs from CLOB API
  const clobMarket = await marketService.getClobMarket(market.conditionId);
  if (!clobMarket || clobMarket.tokens.length < 2) {
    throw new Error('Failed to get market tokens');
  }

  // tokens[0] = primary (Up), tokens[1] = secondary (Down)
  return {
    conditionId: market.conditionId,
    question: market.question,
    upTokenId: clobMarket.tokens[0].tokenId,
    downTokenId: clobMarket.tokens[1].tokenId,
    minutesUntilEnd: market.maxMinutesUntilEnd,
  };
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log('='.repeat(60));
  console.log('RealTimeDataClient Quick Test');
  console.log('='.repeat(60));
  console.log(`Duration: ${DURATION_MS / 1000} seconds`);
  console.log('');

  // Find active market
  const market = await findActiveMarket();
  console.log('');
  console.log(`Up Token: ${market.upTokenId.slice(0, 20)}...`);
  console.log(`Down Token: ${market.downTokenId.slice(0, 20)}...`);
  console.log('');

  const realtime = new RealtimeServiceV2({ debug: true });

  // Event handlers
  realtime.on('connected', () => log('Connected!'));
  realtime.on('disconnected', () => log('Disconnected!'));

  realtime.on('orderbook', (book: OrderbookSnapshot) => {
    stats.bookEvents++;
    stats.lastOrderbook = book;
    const isUp = book.tokenId === market.upTokenId;
    const outcome = isUp ? 'Up' : 'Down';
    const bestBid = book.bids[0]?.price ?? 'N/A';
    const bestAsk = book.asks[0]?.price ?? 'N/A';
    log(`📗 Book [${outcome}]: bids=${book.bids.length} asks=${book.asks.length} (best: ${bestBid}/${bestAsk})`);

    // Track prices for validation
    if (book.bids[0]) {
      const price = parseFloat(book.bids[0].price);
      if (isUp) stats.upPrices.push(price);
      else stats.downPrices.push(price);
    }
  });

  realtime.on('priceChange', (change: PriceChange) => {
    stats.priceChangeEvents++;
    log(`📊 PriceChange: ${change.changes.length} level(s) changed`);
  });

  realtime.on('lastTrade', (trade: LastTradeInfo) => {
    stats.lastTradeEvents++;
    log(`💰 LastTrade: ${trade.side} ${trade.size} @ ${trade.price}`);
  });

  // Connect
  log('Connecting...');
  realtime.connect();

  // Wait for connection
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Connection timeout')), 10_000);
    realtime.once('connected', () => {
      clearTimeout(timeout);
      resolve();
    });
  });

  // Subscribe
  log(`Subscribing to ${COIN} 15m market...`);
  const subscription = realtime.subscribeMarkets([market.upTokenId, market.downTokenId]);

  // Wait
  log(`Waiting ${DURATION_MS / 1000} seconds for data...`);
  await new Promise(resolve => setTimeout(resolve, DURATION_MS));

  // Cleanup
  subscription.unsubscribe();
  realtime.disconnect();

  // Results
  console.log('');
  console.log('='.repeat(60));
  console.log('RESULTS');
  console.log('='.repeat(60));
  console.log('');

  console.log('Event Counts:');
  console.log(`  📗 Book events: ${stats.bookEvents}`);
  console.log(`  📊 PriceChange events: ${stats.priceChangeEvents}`);
  console.log(`  💰 LastTrade events: ${stats.lastTradeEvents}`);
  console.log('');

  // Validate data
  let validationPassed = true;
  const validations: string[] = [];

  // 1. Should have received book events
  if (stats.bookEvents >= 2) {
    validations.push('✅ Book events received (Up + Down)');
  } else if (stats.bookEvents > 0) {
    validations.push('⚠️ Only partial book events received');
  } else {
    validations.push('❌ No book events received');
    validationPassed = false;
  }

  // 2. Should have received price changes (active market)
  if (stats.priceChangeEvents > 0) {
    validations.push(`✅ PriceChange events received (${stats.priceChangeEvents})`);
  } else {
    validations.push('⚠️ No PriceChange events (market may be quiet)');
  }

  // 3. Check price validity
  if (stats.upPrices.length > 0 && stats.downPrices.length > 0) {
    const avgUp = stats.upPrices.reduce((a, b) => a + b, 0) / stats.upPrices.length;
    const avgDown = stats.downPrices.reduce((a, b) => a + b, 0) / stats.downPrices.length;
    const sum = avgUp + avgDown;

    console.log('Price Analysis:');
    console.log(`  Avg Up price: ${avgUp.toFixed(4)}`);
    console.log(`  Avg Down price: ${avgDown.toFixed(4)}`);
    console.log(`  Sum (should be ~1.0): ${sum.toFixed(4)}`);
    console.log('');

    if (sum >= 0.95 && sum <= 1.05) {
      validations.push(`✅ Price sum valid: ${sum.toFixed(4)} (expected ~1.0)`);
    } else {
      validations.push(`⚠️ Price sum unusual: ${sum.toFixed(4)} (expected ~1.0)`);
    }
  }

  // 4. Orderbook validation
  if (stats.lastOrderbook) {
    const book = stats.lastOrderbook;

    // Check bids are sorted descending
    let bidsValid = true;
    for (let i = 1; i < book.bids.length; i++) {
      if (parseFloat(book.bids[i].price) > parseFloat(book.bids[i - 1].price)) {
        bidsValid = false;
        break;
      }
    }

    // Check asks are sorted ascending
    let asksValid = true;
    for (let i = 1; i < book.asks.length; i++) {
      if (parseFloat(book.asks[i].price) < parseFloat(book.asks[i - 1].price)) {
        asksValid = false;
        break;
      }
    }

    if (bidsValid && asksValid) {
      validations.push('✅ Orderbook sorting valid');
    } else {
      validations.push('❌ Orderbook sorting invalid');
      validationPassed = false;
    }
  }

  console.log('Validations:');
  for (const v of validations) {
    console.log(`  ${v}`);
  }
  console.log('');

  // Final result
  const passed = validationPassed && stats.bookEvents > 0;
  console.log('='.repeat(60));
  console.log(`TEST ${passed ? 'PASSED ✅' : 'FAILED ❌'}`);
  console.log('='.repeat(60));

  process.exit(passed ? 0 : 1);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
