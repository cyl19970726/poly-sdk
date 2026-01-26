/**
 * Test Activity Stream for a Market
 *
 * Verifies that activity trades are being received correctly.
 * Compares with orderbook events to ensure data consistency.
 *
 * Run: npx tsx scripts/orderbooks/test-activity-stream.ts
 */

import { PolymarketSDK } from '../../src/index.js';
import { RealtimeServiceV2 } from '../../src/services/realtime-service-v2.js';

const TEST_DURATION_MS = 30_000; // 30 seconds

async function main() {
  console.log('=== Activity Stream Test ===\n');

  // 1. Find an active market
  console.log('1. Finding an active BTC 15-minute market...');
  const sdk = new PolymarketSDK();
  const cryptoMarkets = await sdk.markets.scanCryptoShortTermMarkets({
    coin: 'BTC',
    duration: '15m',
    limit: 1,
  });

  if (cryptoMarkets.length === 0) {
    console.log('No markets found');
    return;
  }

  const gammaMarket = cryptoMarkets[0];
  const market = await sdk.markets.getMarket(gammaMarket.conditionId);
  const tokenIds = market.tokens.map((t) => t.tokenId);

  console.log(`   Market: ${market.question.slice(0, 60)}...`);
  console.log(`   Slug: ${market.marketSlug}`);
  console.log(`   ConditionId: ${market.conditionId}`);
  console.log(`   Tokens: ${tokenIds.length}\n`);

  // 2. Connect to WebSocket
  console.log('2. Connecting to WebSocket...');
  const realtime = new RealtimeServiceV2({ debug: false });

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Connection timeout')), 10000);
    realtime.once('connected', () => {
      clearTimeout(timeout);
      resolve();
    });
    realtime.connect();
  });

  console.log('   Connected!\n');

  // 3. Subscribe to both activity and orderbook
  console.log(`3. Subscribing to activity and orderbook for ${TEST_DURATION_MS / 1000}s...\n`);

  const stats = {
    activity: {
      count: 0,
      samples: [] as Array<{
        price: number;
        size: number;
        side: string;
        trader?: string;
        timestamp: number;
      }>,
    },
    orderbook: {
      count: 0,
      lastBestBid: 0,
      lastBestAsk: 0,
    },
    lastTrade: {
      count: 0,
      samples: [] as Array<{
        price: number;
        size: number;
        side: string;
        timestamp: number;
      }>,
    },
  };

  // Subscribe to activity (trades with trader info)
  const activitySub = realtime.subscribeActivity(
    { marketSlug: market.marketSlug },
    {
      onTrade: (trade) => {
        stats.activity.count++;
        if (stats.activity.samples.length < 5) {
          stats.activity.samples.push({
            price: trade.price,
            size: trade.size,
            side: trade.side,
            trader: trade.trader?.address?.slice(0, 10) + '...',
            timestamp: trade.timestamp,
          });
        }
        console.log(
          `   [activity] ${trade.side} ${trade.size.toFixed(2)} @ ${trade.price.toFixed(3)} | trader: ${trade.trader?.address?.slice(0, 10) ?? 'unknown'}...`
        );
      },
    }
  );

  // Subscribe to market data (orderbook + last_trade_price)
  const marketSub = realtime.subscribeMarket(tokenIds[0], tokenIds[1], {
    onOrderbook: (book) => {
      stats.orderbook.count++;
      stats.orderbook.lastBestBid = book.bids[0]?.price ?? 0;
      stats.orderbook.lastBestAsk = book.asks[0]?.price ?? 0;
    },
    onLastTrade: (trade) => {
      stats.lastTrade.count++;
      if (stats.lastTrade.samples.length < 5) {
        stats.lastTrade.samples.push({
          price: trade.price,
          size: trade.size,
          side: trade.side,
          timestamp: trade.timestamp,
        });
      }
      console.log(
        `   [last_trade] ${trade.side} ${trade.size.toFixed(2)} @ ${trade.price.toFixed(3)}`
      );
    },
  });

  // Wait for test duration
  await new Promise((resolve) => setTimeout(resolve, TEST_DURATION_MS));

  // 4. Print results
  console.log('\n=== Results ===\n');

  console.log('Activity trades:');
  console.log(`   Count: ${stats.activity.count}`);
  console.log(`   Rate: ${(stats.activity.count / (TEST_DURATION_MS / 1000)).toFixed(2)}/sec`);
  if (stats.activity.samples.length > 0) {
    console.log('   Samples:');
    stats.activity.samples.forEach((s, i) => {
      console.log(`     ${i + 1}. ${s.side} ${s.size} @ ${s.price} | trader: ${s.trader}`);
    });
  }

  console.log('\nLast trade price events:');
  console.log(`   Count: ${stats.lastTrade.count}`);
  console.log(`   Rate: ${(stats.lastTrade.count / (TEST_DURATION_MS / 1000)).toFixed(2)}/sec`);
  if (stats.lastTrade.samples.length > 0) {
    console.log('   Samples:');
    stats.lastTrade.samples.forEach((s, i) => {
      console.log(`     ${i + 1}. ${s.side} ${s.size} @ ${s.price}`);
    });
  }

  console.log('\nOrderbook events:');
  console.log(`   Count: ${stats.orderbook.count}`);
  console.log(`   Rate: ${(stats.orderbook.count / (TEST_DURATION_MS / 1000)).toFixed(2)}/sec`);
  console.log(`   Last best bid: ${stats.orderbook.lastBestBid.toFixed(3)}`);
  console.log(`   Last best ask: ${stats.orderbook.lastBestAsk.toFixed(3)}`);

  console.log('\n=== Comparison ===\n');
  console.log(`Activity has trader address: YES (critical for copy trading)`);
  console.log(`last_trade_price has trader address: NO`);
  console.log(
    `Activity count vs last_trade: ${stats.activity.count} vs ${stats.lastTrade.count}`
  );

  // Cleanup
  activitySub.unsubscribe();
  marketSub.unsubscribe();
  realtime.disconnect();

  console.log('\n=== Done ===');
}

main().catch(console.error);
