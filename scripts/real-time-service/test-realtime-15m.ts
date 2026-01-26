#!/usr/bin/env npx tsx
/**
 * Test RealTimeDataClient with 15-minute crypto markets
 *
 * This script verifies:
 * 1. Connection stability (ping/pong)
 * 2. Orderbook snapshots (agg_orderbook)
 * 3. Price change events (price_change)
 * 4. Last trade price events (last_trade_price)
 *
 * Usage:
 *   npx tsx scripts/real-time-service/test-realtime-15m.ts
 *   npx tsx scripts/real-time-service/test-realtime-15m.ts --duration 300  # 5 minutes
 *   npx tsx scripts/real-time-service/test-realtime-15m.ts --debug
 */

import { RealtimeServiceV2 } from '../../src/services/realtime-service-v2.js';
import { GammaApiClient } from '../../src/clients/gamma-api.js';
import { RateLimiter } from '../../src/core/rate-limiter.js';
import { createUnifiedCache } from '../../src/core/unified-cache.js';
import type { OrderbookSnapshot, LastTradeInfo, PriceChange } from '../../src/services/realtime-service-v2.js';

// ============================================================================
// Configuration
// ============================================================================

const args = process.argv.slice(2);
const DEBUG = args.includes('--debug');
const DURATION_MS = (() => {
  const idx = args.indexOf('--duration');
  if (idx !== -1 && args[idx + 1]) {
    return parseInt(args[idx + 1], 10) * 1000;
  }
  return 60_000; // Default 1 minute
})();

// ============================================================================
// Statistics Tracking
// ============================================================================

interface Stats {
  connected: boolean;
  connectionTime: number | null;
  reconnects: number;
  orderbookEvents: number;
  priceChangeEvents: number;
  lastTradeEvents: number;
  errors: string[];
  orderbooksByToken: Map<string, number>;
  lastOrderbooks: Map<string, OrderbookSnapshot>;
  lastTrades: Map<string, LastTradeInfo>;
}

const stats: Stats = {
  connected: false,
  connectionTime: null,
  reconnects: 0,
  orderbookEvents: 0,
  priceChangeEvents: 0,
  lastTradeEvents: 0,
  errors: [],
  orderbooksByToken: new Map(),
  lastOrderbooks: new Map(),
  lastTrades: new Map(),
};

// ============================================================================
// Logging Utilities
// ============================================================================

function log(message: string): void {
  const ts = new Date().toISOString().split('T')[1].replace('Z', '');
  console.log(`[${ts}] ${message}`);
}

function debug(message: string): void {
  if (DEBUG) {
    const ts = new Date().toISOString().split('T')[1].replace('Z', '');
    console.log(`[${ts}] [DEBUG] ${message}`);
  }
}

function error(message: string): void {
  const ts = new Date().toISOString().split('T')[1].replace('Z', '');
  console.error(`[${ts}] [ERROR] ${message}`);
  stats.errors.push(`${ts}: ${message}`);
}

// ============================================================================
// Data Validation
// ============================================================================

function validateOrderbook(book: OrderbookSnapshot): string[] {
  const issues: string[] = [];

  if (!book.tokenId && !book.assetId) {
    issues.push('Missing tokenId/assetId');
  }

  if (!book.market) {
    issues.push('Missing market (conditionId)');
  }

  if (!Array.isArray(book.bids)) {
    issues.push('bids is not an array');
  } else {
    // Check bids are sorted descending
    for (let i = 1; i < book.bids.length; i++) {
      if (book.bids[i].price > book.bids[i - 1].price) {
        issues.push(`bids not sorted descending at index ${i}`);
        break;
      }
    }
  }

  if (!Array.isArray(book.asks)) {
    issues.push('asks is not an array');
  } else {
    // Check asks are sorted ascending
    for (let i = 1; i < book.asks.length; i++) {
      if (book.asks[i].price < book.asks[i - 1].price) {
        issues.push(`asks not sorted ascending at index ${i}`);
        break;
      }
    }
  }

  if (typeof book.timestamp !== 'number' || book.timestamp <= 0) {
    issues.push(`Invalid timestamp: ${book.timestamp}`);
  }

  // Check timestamp is in milliseconds (should be > 1e12)
  if (book.timestamp < 1e12) {
    issues.push(`Timestamp appears to be in seconds, not ms: ${book.timestamp}`);
  }

  return issues;
}

function validateLastTrade(trade: LastTradeInfo): string[] {
  const issues: string[] = [];

  if (!trade.assetId) {
    issues.push('Missing assetId');
  }

  if (typeof trade.price !== 'number' || trade.price <= 0 || trade.price >= 1) {
    issues.push(`Invalid price: ${trade.price}`);
  }

  if (trade.side !== 'BUY' && trade.side !== 'SELL') {
    issues.push(`Invalid side: ${trade.side}`);
  }

  if (typeof trade.size !== 'number' || trade.size <= 0) {
    issues.push(`Invalid size: ${trade.size}`);
  }

  if (typeof trade.timestamp !== 'number' || trade.timestamp <= 0) {
    issues.push(`Invalid timestamp: ${trade.timestamp}`);
  }

  // Check timestamp is in milliseconds
  if (trade.timestamp < 1e12) {
    issues.push(`Timestamp appears to be in seconds, not ms: ${trade.timestamp}`);
  }

  return issues;
}

// ============================================================================
// Main Test
// ============================================================================

async function findActive15mMarkets(): Promise<{ yesTokenId: string; noTokenId: string; question: string }[]> {
  log('Finding active 15-minute crypto markets...');

  const rateLimiter = new RateLimiter();
  const cache = createUnifiedCache();
  const gammaApi = new GammaApiClient(rateLimiter, cache);

  // Search for Up/Down markets (15m crypto markets use "Up or Down" naming)
  const searches = ['Bitcoin Up or Down', 'Ethereum Up or Down', 'Solana Up or Down'];
  const markets: { yesTokenId: string; noTokenId: string; question: string }[] = [];

  for (const query of searches) {
    try {
      const results = await gammaApi.searchMarkets({ query, active: true });
      for (const market of results.slice(0, 2)) {
        // Filter for 15-minute markets specifically
        const is15m = market.slug?.includes('15m') || market.question?.includes('15');
        if (is15m && market.tokens && market.tokens.length >= 2) {
          markets.push({
            yesTokenId: market.tokens[0].token_id,
            noTokenId: market.tokens[1].token_id,
            question: market.question,
          });
        }
      }
    } catch (err) {
      debug(`Search "${query}" failed: ${err}`);
    }
  }

  if (markets.length === 0) {
    throw new Error('No active 15-minute markets found. Try running during active market hours.');
  }

  return markets.slice(0, 3); // Limit to 3 markets for testing
}

async function main() {
  console.log('='.repeat(60));
  console.log('RealTimeDataClient Test - 15 Minute Markets');
  console.log('='.repeat(60));
  console.log(`Duration: ${DURATION_MS / 1000} seconds`);
  console.log(`Debug: ${DEBUG}`);
  console.log('');

  // Find active markets
  const markets = await findActive15mMarkets();
  log(`Found ${markets.length} markets to subscribe:`);
  for (const m of markets) {
    log(`  - ${m.question.slice(0, 60)}...`);
  }
  console.log('');

  // Collect all token IDs
  const allTokenIds = markets.flatMap(m => [m.yesTokenId, m.noTokenId]);
  log(`Subscribing to ${allTokenIds.length} tokens`);

  // Create realtime service
  const realtime = new RealtimeServiceV2({ debug: DEBUG });

  // Set up event handlers
  realtime.on('connected', () => {
    stats.connected = true;
    stats.connectionTime = Date.now();
    log('Connected to WebSocket');
  });

  realtime.on('disconnected', () => {
    stats.connected = false;
    stats.reconnects++;
    log('Disconnected from WebSocket');
  });

  realtime.on('orderbook', (book: OrderbookSnapshot) => {
    stats.orderbookEvents++;
    const tokenId = book.tokenId || book.assetId;
    stats.orderbooksByToken.set(tokenId, (stats.orderbooksByToken.get(tokenId) || 0) + 1);
    stats.lastOrderbooks.set(tokenId, book);

    const issues = validateOrderbook(book);
    if (issues.length > 0) {
      error(`Orderbook validation failed for ${tokenId.slice(0, 10)}...: ${issues.join(', ')}`);
    }

    debug(`Orderbook: ${tokenId.slice(0, 10)}... bids=${book.bids.length} asks=${book.asks.length}`);
  });

  realtime.on('priceChange', (change: PriceChange) => {
    stats.priceChangeEvents++;
    debug(`PriceChange: ${change.assetId.slice(0, 10)}... changes=${change.changes.length}`);
  });

  realtime.on('lastTrade', (trade: LastTradeInfo) => {
    stats.lastTradeEvents++;
    stats.lastTrades.set(trade.assetId, trade);

    const issues = validateLastTrade(trade);
    if (issues.length > 0) {
      error(`LastTrade validation failed for ${trade.assetId.slice(0, 10)}...: ${issues.join(', ')}`);
    }

    debug(`LastTrade: ${trade.assetId.slice(0, 10)}... price=${trade.price} size=${trade.size} side=${trade.side}`);
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

  // Subscribe to markets
  log('Subscribing to markets...');
  const subscription = realtime.subscribeMarkets(allTokenIds, {
    onOrderbook: () => {}, // Handled by event emitter
    onPriceChange: () => {},
    onLastTrade: () => {},
  });

  // Progress logging
  const progressInterval = setInterval(() => {
    log(`Progress: orderbooks=${stats.orderbookEvents} priceChanges=${stats.priceChangeEvents} trades=${stats.lastTradeEvents}`);
  }, 10_000);

  // Run for specified duration
  log(`Running for ${DURATION_MS / 1000} seconds...`);
  await new Promise(resolve => setTimeout(resolve, DURATION_MS));

  // Cleanup
  clearInterval(progressInterval);
  subscription.unsubscribe();
  realtime.disconnect();

  // Print results
  console.log('');
  console.log('='.repeat(60));
  console.log('RESULTS');
  console.log('='.repeat(60));
  console.log('');

  console.log('Connection:');
  console.log(`  Connected: ${stats.connected ? 'Yes' : 'No'}`);
  console.log(`  Reconnects: ${stats.reconnects}`);
  console.log('');

  console.log('Events Received:');
  console.log(`  Orderbook (agg_orderbook): ${stats.orderbookEvents}`);
  console.log(`  Price Change (price_change): ${stats.priceChangeEvents}`);
  console.log(`  Last Trade (last_trade_price): ${stats.lastTradeEvents}`);
  console.log('');

  console.log('Orderbooks by Token:');
  for (const [tokenId, count] of stats.orderbooksByToken) {
    console.log(`  ${tokenId.slice(0, 20)}...: ${count} events`);
  }
  console.log('');

  console.log('Last Orderbook Snapshots:');
  for (const [tokenId, book] of stats.lastOrderbooks) {
    const bestBid = book.bids[0]?.price ?? 'N/A';
    const bestAsk = book.asks[0]?.price ?? 'N/A';
    const spread = typeof bestBid === 'number' && typeof bestAsk === 'number'
      ? ((bestAsk - bestBid) * 100).toFixed(2) + '%'
      : 'N/A';
    console.log(`  ${tokenId.slice(0, 20)}...: bid=${bestBid} ask=${bestAsk} spread=${spread}`);
  }
  console.log('');

  console.log('Last Trades:');
  for (const [tokenId, trade] of stats.lastTrades) {
    console.log(`  ${tokenId.slice(0, 20)}...: ${trade.side} ${trade.size} @ ${trade.price}`);
  }
  console.log('');

  if (stats.errors.length > 0) {
    console.log('Errors:');
    for (const err of stats.errors) {
      console.log(`  ${err}`);
    }
    console.log('');
  }

  // Summary
  const passed = stats.orderbookEvents > 0 && stats.errors.length === 0;
  console.log('='.repeat(60));
  console.log(`TEST ${passed ? 'PASSED' : 'FAILED'}`);
  console.log('='.repeat(60));

  process.exit(passed ? 0 : 1);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
