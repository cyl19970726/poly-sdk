/**
 * Test RealtimeServiceV2 Orderbook Stream Continuity
 *
 * Verifies that orderbook updates are received continuously after subscription,
 * not just the initial snapshot. Uses a known active market.
 *
 * Usage:
 *   npx tsx scripts/orderbooks/test-orderbook-stream.ts [--market btc|esports] [--duration 60]
 *
 * Default: BTC 15-minute market, 60 seconds duration
 */

import { RealtimeServiceV2 } from '../../src/services/realtime-service-v2.js';
import { PolymarketSDK } from '../../src/index.js';

// Parse CLI args
const args = process.argv.slice(2);
const marketType = args.includes('--market') ? args[args.indexOf('--market') + 1] : 'btc';
const duration = args.includes('--duration')
  ? parseInt(args[args.indexOf('--duration') + 1], 10) * 1000
  : 60_000;

// Esports market tokens (Vitality vs Team Falcons - Moneyline)
const ESPORTS_TOKENS = {
  primary: '3049829309603608341962198527062774594178319811085249111170041589596951202510',
  secondary: '54112833807081167723011760010256662577146156186293106187905285283994117496813',
  name: 'CS2 Vitality vs Team Falcons (Moneyline)',
};

interface EventLog {
  timestamp: number;
  elapsed: number;
  type: 'orderbook' | 'lastTrade' | 'priceChange' | 'disconnect' | 'reconnect';
  assetId?: string;
  bestBid?: number;
  bestAsk?: number;
  bidsCount?: number;
  asksCount?: number;
  price?: number;
  size?: number;
}

async function getMarketTokens(): Promise<{ primary: string; secondary: string; name: string }> {
  if (marketType === 'esports') {
    return ESPORTS_TOKENS;
  }

  // Find active BTC 15-minute market
  const sdk = new PolymarketSDK();
  const markets = await sdk.markets.scanCryptoShortTermMarkets({
    coin: 'BTC',
    duration: '15m',
    limit: 1,
  });

  if (markets.length === 0) {
    throw new Error('No BTC 15-minute markets found');
  }

  const market = await sdk.markets.getMarket(markets[0].conditionId);
  return {
    primary: market.tokens[0].tokenId,
    secondary: market.tokens[1].tokenId,
    name: market.question.slice(0, 60),
  };
}

async function main() {
  console.log('=== RealtimeServiceV2 Orderbook Stream Test ===\n');
  console.log(`Market type: ${marketType}`);
  console.log(`Duration: ${duration / 1000}s\n`);

  // 1. Get tokens
  console.log('1. Getting market tokens...');
  const tokens = await getMarketTokens();
  console.log(`   Market: ${tokens.name}`);
  console.log(`   Primary:   ${tokens.primary.slice(0, 30)}...`);
  console.log(`   Secondary: ${tokens.secondary.slice(0, 30)}...\n`);

  // 2. Connect
  console.log('2. Connecting RealtimeServiceV2...');
  const realtime = new RealtimeServiceV2({ debug: false });

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Connection timeout (10s)')), 10000);
    realtime.once('connected', () => {
      clearTimeout(timeout);
      resolve();
    });
    realtime.connect();
  });
  console.log('   Connected!\n');

  // 3. Subscribe and collect events
  console.log(`3. Subscribing to orderbook for ${duration / 1000}s...\n`);

  const startTime = Date.now();
  const events: EventLog[] = [];
  let disconnects = 0;

  // Track disconnects
  realtime.on('disconnected', () => {
    disconnects++;
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    events.push({ timestamp: Date.now(), elapsed: parseFloat(elapsed), type: 'disconnect' });
    console.log(`   [${elapsed}s] ⚠ DISCONNECTED (#${disconnects})`);
  });

  realtime.on('connected', () => {
    if (events.length > 0) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      events.push({ timestamp: Date.now(), elapsed: parseFloat(elapsed), type: 'reconnect' });
      console.log(`   [${elapsed}s] ✓ RECONNECTED`);
    }
  });

  const sub = realtime.subscribeMarket(tokens.primary, tokens.secondary, {
    onOrderbook: (book) => {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const bestBid = book.bids[0]?.price ?? 0;
      const bestAsk = book.asks[0]?.price ?? 0;

      events.push({
        timestamp: Date.now(),
        elapsed: parseFloat(elapsed),
        type: 'orderbook',
        assetId: book.assetId.slice(0, 20),
        bestBid,
        bestAsk,
        bidsCount: book.bids.length,
        asksCount: book.asks.length,
      });

      const tokenLabel = book.assetId === tokens.primary ? 'PRI' : 'SEC';
      console.log(
        `   [${elapsed}s] orderbook ${tokenLabel} | bid:${bestBid.toFixed(2)} ask:${bestAsk.toFixed(2)} | ${book.bids.length}b/${book.asks.length}a`
      );
    },
    onLastTrade: (trade) => {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      events.push({
        timestamp: Date.now(),
        elapsed: parseFloat(elapsed),
        type: 'lastTrade',
        assetId: trade.assetId.slice(0, 20),
        price: trade.price,
        size: trade.size,
      });

      const tokenLabel = trade.assetId === tokens.primary ? 'PRI' : 'SEC';
      console.log(
        `   [${elapsed}s] trade     ${tokenLabel} | ${trade.side} ${trade.size.toFixed(1)} @ ${trade.price.toFixed(3)}`
      );
    },
    onPriceChange: (change) => {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      events.push({
        timestamp: Date.now(),
        elapsed: parseFloat(elapsed),
        type: 'priceChange',
        assetId: change.assetId.slice(0, 20),
        price: change.price,
      });
    },
  });

  // Wait for duration
  await new Promise((resolve) => setTimeout(resolve, duration));

  // 4. Print summary
  console.log('\n=== Summary ===\n');

  const obEvents = events.filter((e) => e.type === 'orderbook');
  const tradeEvents = events.filter((e) => e.type === 'lastTrade');
  const priceEvents = events.filter((e) => e.type === 'priceChange');

  console.log(`Duration: ${(duration / 1000).toFixed(0)}s`);
  console.log(`Disconnects: ${disconnects}`);
  console.log(`Orderbook events: ${obEvents.length} (${(obEvents.length / (duration / 1000)).toFixed(2)}/sec)`);
  console.log(`Trade events: ${tradeEvents.length}`);
  console.log(`Price change events: ${priceEvents.length}`);

  // Gap analysis - find periods with no events
  if (obEvents.length > 1) {
    console.log('\n=== Gap Analysis (orderbook) ===\n');

    let maxGap = 0;
    let maxGapStart = 0;
    const gaps: Array<{ start: number; end: number; gap: number }> = [];

    for (let i = 1; i < obEvents.length; i++) {
      const gap = obEvents[i].elapsed - obEvents[i - 1].elapsed;
      if (gap > maxGap) {
        maxGap = gap;
        maxGapStart = obEvents[i - 1].elapsed;
      }
      if (gap > 5) {
        gaps.push({ start: obEvents[i - 1].elapsed, end: obEvents[i].elapsed, gap });
      }
    }

    console.log(`Max gap between orderbook events: ${maxGap.toFixed(1)}s (at ${maxGapStart.toFixed(1)}s)`);

    if (gaps.length > 0) {
      console.log(`\nGaps > 5s:`);
      gaps.forEach((g) => {
        console.log(`   ${g.start.toFixed(1)}s → ${g.end.toFixed(1)}s (${g.gap.toFixed(1)}s gap)`);
      });
    } else {
      console.log('No gaps > 5s detected - stream is continuous!');
    }

    // First event timing
    console.log(`\nFirst orderbook event at: ${obEvents[0].elapsed.toFixed(1)}s after subscribe`);

    // Check if events only come after disconnect
    if (disconnects > 0) {
      const firstDisconnect = events.find((e) => e.type === 'disconnect');
      const eventsBeforeDisconnect = obEvents.filter(
        (e) => e.elapsed < (firstDisconnect?.elapsed ?? Infinity)
      );
      const eventsAfterDisconnect = obEvents.filter(
        (e) => e.elapsed >= (firstDisconnect?.elapsed ?? Infinity)
      );
      console.log(`\nEvents before first disconnect: ${eventsBeforeDisconnect.length}`);
      console.log(`Events after first disconnect: ${eventsAfterDisconnect.length}`);

      if (eventsBeforeDisconnect.length <= 2 && eventsAfterDisconnect.length > 5) {
        console.log('\n⚠ BUG CONFIRMED: Only initial snapshot received before disconnect!');
        console.log('   Updates only flow after reconnection.');
      }
    }
  } else if (obEvents.length === 0) {
    console.log('\n⚠ No orderbook events received at all!');
  } else {
    console.log('\nOnly 1 orderbook event - insufficient data for gap analysis.');
  }

  // Cleanup
  sub.unsubscribe();
  realtime.disconnect();
  console.log('\n=== Done ===');
  process.exit(0);
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
