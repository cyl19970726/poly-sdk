#!/usr/bin/env npx tsx
/**
 * Test 15-minute market data consistency
 *
 * This script verifies:
 * 1. Both tokens (Up/Down) receive orderbook updates
 * 2. Spread calculation (should be ~1.0 for binary markets)
 * 3. Timestamp consistency
 * 4. Event frequency
 *
 * Usage:
 *   npx tsx scripts/real-time-service/test-15m-data-consistency.ts
 *   npx tsx scripts/real-time-service/test-15m-data-consistency.ts --coin BTC
 *   npx tsx scripts/real-time-service/test-15m-data-consistency.ts --duration 60
 */

import { RealtimeServiceV2 } from '../../src/services/realtime-service-v2.js';
import { GammaApiClient } from '../../src/clients/gamma-api.js';
import { RateLimiter } from '../../src/core/rate-limiter.js';
import { createUnifiedCache } from '../../src/core/unified-cache.js';
import type { OrderbookSnapshot } from '../../src/services/realtime-service-v2.js';

// ============================================================================
// Configuration
// ============================================================================

const args = process.argv.slice(2);
const COIN = (() => {
  const idx = args.indexOf('--coin');
  return idx !== -1 && args[idx + 1] ? args[idx + 1].toUpperCase() : 'BTC';
})();
const DURATION_MS = (() => {
  const idx = args.indexOf('--duration');
  if (idx !== -1 && args[idx + 1]) {
    return parseInt(args[idx + 1], 10) * 1000;
  }
  return 60_000; // Default 1 minute
})();

// ============================================================================
// Types
// ============================================================================

interface TokenStats {
  tokenId: string;
  outcome: string;
  updateCount: number;
  lastUpdate: OrderbookSnapshot | null;
  timestamps: number[];
  spreads: number[];
}

// ============================================================================
// Logging
// ============================================================================

function log(message: string): void {
  const ts = new Date().toISOString().split('T')[1].replace('Z', '');
  console.log(`[${ts}] ${message}`);
}

// ============================================================================
// Find 15m Market
// ============================================================================

async function findActive15mMarket(coin: string): Promise<{
  conditionId: string;
  question: string;
  upToken: { tokenId: string; outcome: string };
  downToken: { tokenId: string; outcome: string };
} | null> {
  const rateLimiter = new RateLimiter();
  const cache = createUnifiedCache();
  const gammaApi = new GammaApiClient(rateLimiter, cache);

  // Search for 15m market
  const query = `${coin} 15`;
  log(`Searching for: "${query}"`);

  const results = await gammaApi.searchMarkets({ query, active: true });

  for (const market of results) {
    // Check if it's a 15-minute Up/Down market
    const is15m = market.question?.includes('15') || market.slug?.includes('15');
    const isUpDown = market.tokens?.some(t => t.outcome === 'Up' || t.outcome === 'Down');

    if (is15m && isUpDown && market.tokens?.length >= 2) {
      const upToken = market.tokens.find(t => t.outcome === 'Up');
      const downToken = market.tokens.find(t => t.outcome === 'Down');

      if (upToken && downToken) {
        return {
          conditionId: market.condition_id,
          question: market.question,
          upToken: { tokenId: upToken.token_id, outcome: 'Up' },
          downToken: { tokenId: downToken.token_id, outcome: 'Down' },
        };
      }
    }
  }

  return null;
}

// ============================================================================
// Main Test
// ============================================================================

async function main() {
  console.log('='.repeat(60));
  console.log('15-Minute Market Data Consistency Test');
  console.log('='.repeat(60));
  console.log(`Coin: ${COIN}`);
  console.log(`Duration: ${DURATION_MS / 1000} seconds`);
  console.log('');

  // Find active market
  const market = await findActive15mMarket(COIN);

  if (!market) {
    console.error(`No active 15-minute ${COIN} market found!`);
    process.exit(1);
  }

  log(`Found market: ${market.question}`);
  log(`  Condition ID: ${market.conditionId}`);
  log(`  Up Token: ${market.upToken.tokenId.slice(0, 20)}...`);
  log(`  Down Token: ${market.downToken.tokenId.slice(0, 20)}...`);
  console.log('');

  // Initialize stats
  const upStats: TokenStats = {
    tokenId: market.upToken.tokenId,
    outcome: 'Up',
    updateCount: 0,
    lastUpdate: null,
    timestamps: [],
    spreads: [],
  };

  const downStats: TokenStats = {
    tokenId: market.downToken.tokenId,
    outcome: 'Down',
    updateCount: 0,
    lastUpdate: null,
    timestamps: [],
    spreads: [],
  };

  // Create realtime service
  const realtime = new RealtimeServiceV2({ debug: false });

  realtime.on('connected', () => {
    log('Connected to WebSocket');
  });

  // Subscribe to market
  realtime.connect();

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Connection timeout')), 10_000);
    realtime.once('connected', () => {
      clearTimeout(timeout);
      resolve();
    });
  });

  log('Subscribing to market...');

  realtime.subscribeMarket(market.upToken.tokenId, market.downToken.tokenId, {
    onOrderbook: (book: OrderbookSnapshot) => {
      const stats = book.tokenId === market.upToken.tokenId ? upStats : downStats;
      stats.updateCount++;
      stats.lastUpdate = book;
      stats.timestamps.push(book.timestamp);

      // Calculate spread
      if (book.bids.length > 0 && book.asks.length > 0) {
        const spread = book.asks[0].price - book.bids[0].price;
        stats.spreads.push(spread);
      }
    },

    onPairUpdate: ({ yes, no, spread }) => {
      // Log combined price
      log(`Pair Update: Up=${yes.price.toFixed(3)} Down=${no.price.toFixed(3)} Total=${spread.toFixed(3)}`);
    },
  });

  // Wait for initial data
  log('Waiting for initial data...');
  await new Promise(resolve => setTimeout(resolve, 5_000));

  // Run for specified duration
  log(`Running for ${DURATION_MS / 1000} seconds...`);

  const progressInterval = setInterval(() => {
    log(`Progress: Up=${upStats.updateCount} Down=${downStats.updateCount}`);
  }, 15_000);

  await new Promise(resolve => setTimeout(resolve, DURATION_MS));

  // Cleanup
  clearInterval(progressInterval);
  realtime.disconnect();

  // Analyze results
  console.log('');
  console.log('='.repeat(60));
  console.log('RESULTS');
  console.log('='.repeat(60));
  console.log('');

  console.log('Update Counts:');
  console.log(`  Up token: ${upStats.updateCount} updates`);
  console.log(`  Down token: ${downStats.updateCount} updates`);
  console.log('');

  // Calculate average spreads
  const upAvgSpread = upStats.spreads.length > 0
    ? (upStats.spreads.reduce((a, b) => a + b, 0) / upStats.spreads.length)
    : 0;
  const downAvgSpread = downStats.spreads.length > 0
    ? (downStats.spreads.reduce((a, b) => a + b, 0) / downStats.spreads.length)
    : 0;

  console.log('Average Bid-Ask Spreads:');
  console.log(`  Up token: ${(upAvgSpread * 100).toFixed(2)}%`);
  console.log(`  Down token: ${(downAvgSpread * 100).toFixed(2)}%`);
  console.log('');

  // Latest prices
  if (upStats.lastUpdate && downStats.lastUpdate) {
    const upBid = upStats.lastUpdate.bids[0]?.price ?? 0;
    const upAsk = upStats.lastUpdate.asks[0]?.price ?? 0;
    const downBid = downStats.lastUpdate.bids[0]?.price ?? 0;
    const downAsk = downStats.lastUpdate.asks[0]?.price ?? 0;

    console.log('Latest Orderbooks:');
    console.log(`  Up: bid=${upBid.toFixed(3)} ask=${upAsk.toFixed(3)}`);
    console.log(`  Down: bid=${downBid.toFixed(3)} ask=${downAsk.toFixed(3)}`);
    console.log('');

    // Calculate combined price (should be ~1.0)
    const combinedBid = upBid + downBid;
    const combinedAsk = upAsk + downAsk;
    console.log('Combined Prices (should be ~1.0):');
    console.log(`  Combined bid: ${combinedBid.toFixed(4)}`);
    console.log(`  Combined ask: ${combinedAsk.toFixed(4)}`);
    console.log('');
  }

  // Timestamp analysis
  console.log('Timestamp Analysis:');
  if (upStats.timestamps.length > 1) {
    const intervals = [];
    for (let i = 1; i < upStats.timestamps.length; i++) {
      intervals.push(upStats.timestamps[i] - upStats.timestamps[i - 1]);
    }
    const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    const maxInterval = Math.max(...intervals);
    console.log(`  Up token avg interval: ${(avgInterval / 1000).toFixed(2)}s`);
    console.log(`  Up token max interval: ${(maxInterval / 1000).toFixed(2)}s`);
  }
  if (downStats.timestamps.length > 1) {
    const intervals = [];
    for (let i = 1; i < downStats.timestamps.length; i++) {
      intervals.push(downStats.timestamps[i] - downStats.timestamps[i - 1]);
    }
    const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    const maxInterval = Math.max(...intervals);
    console.log(`  Down token avg interval: ${(avgInterval / 1000).toFixed(2)}s`);
    console.log(`  Down token max interval: ${(maxInterval / 1000).toFixed(2)}s`);
  }
  console.log('');

  // Verification
  const bothReceived = upStats.updateCount > 0 && downStats.updateCount > 0;
  const reasonableBalance = Math.abs(upStats.updateCount - downStats.updateCount) < Math.max(upStats.updateCount, downStats.updateCount) * 0.5;

  console.log('Verification:');
  console.log(`  [${bothReceived ? 'PASS' : 'FAIL'}] Both tokens received updates`);
  console.log(`  [${reasonableBalance ? 'PASS' : 'WARN'}] Reasonably balanced updates`);
  console.log('');

  const passed = bothReceived;

  console.log('='.repeat(60));
  console.log(`TEST ${passed ? 'PASSED' : 'FAILED'}`);
  console.log('='.repeat(60));

  process.exit(passed ? 0 : 1);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
