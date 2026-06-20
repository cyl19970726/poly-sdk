/**
 * Example 7: Real-time WebSocket
 *
 * This example demonstrates real-time price updates using RealtimeServiceV2:
 * - Connection management
 * - Market data subscriptions (orderbook, prices, trades)
 * - Crypto price subscriptions (BTC, ETH)
 *
 * Run: npx tsx examples/07-realtime-websocket.ts
 */

import { PolymarketSDK, RealtimeServiceV2, getBinaryTokens } from '../src/index.js';

async function main() {
  console.log('=== Real-time WebSocket Demo (V2) ===\n');

  const sdk = new PolymarketSDK();

  // 1. Get a trending market to subscribe to
  console.log('1. Getting trending market...');
  const trendingMarkets = await sdk.markets.getTrendingMarkets(1);
  if (trendingMarkets.length === 0) {
    console.log('No trending markets found');
    return;
  }

  const market = trendingMarkets[0];
  console.log(`   Market: ${market.question.slice(0, 60)}...`);
  console.log(`   Condition ID: ${market.conditionId}\n`);

  // 2. Get market details for token IDs
  console.log('2. Getting market details...');
  const unifiedMarket = await sdk.markets.getMarket(market.conditionId);
  const binary = getBinaryTokens(unifiedMarket.tokens);
  if (!binary) {
    console.log('No binary token pair available for this market');
    return;
  }
  const [yesOutcome, noOutcome] = binary.outcomes;
  const yesTokenId = binary.primary.tokenId;
  const noTokenId = binary.secondary.tokenId;
  console.log(`   YES Token (${yesOutcome}): ${yesTokenId.slice(0, 20)}...`);
  console.log(`   NO Token (${noOutcome}): ${noTokenId.slice(0, 20)}...`);
  console.log(`   Current YES Price (${yesOutcome}): ${binary.primary.price}`);
  console.log(`   Current NO Price (${noOutcome}): ${binary.secondary.price}\n`);

  // 3. Create RealtimeServiceV2 and connect
  console.log('3. Connecting to WebSocket...');
  const realtime = new RealtimeServiceV2({ debug: false });

  // Wait for connection
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Connection timeout')), 10000);

    realtime.once('connected', () => {
      clearTimeout(timeout);
      console.log('   Connected!\n');
      resolve();
    });

    realtime.connect();
  });

  // 4. Subscribe to market data
  console.log('4. Subscribing to market updates...');
  let updateCount = 0;
  const maxUpdates = 10;

  const subscription = realtime.subscribeMarket(yesTokenId, noTokenId, {
    onOrderbook: (book) => {
      updateCount++;
      const side = book.assetId === yesTokenId ? `YES/${yesOutcome}` : `NO/${noOutcome}`;
      const bestBid = book.bids[0];
      const bestAsk = book.asks[0];
      console.log(`   [${new Date().toLocaleTimeString()}] ${side} Book: Bid ${bestBid?.price.toFixed(4)} (${bestBid?.size.toFixed(0)}) | Ask ${bestAsk?.price.toFixed(4)} (${bestAsk?.size.toFixed(0)})`);
    },
    onPriceUpdate: (update) => {
      const side = update.assetId === yesTokenId ? `YES/${yesOutcome}` : `NO/${noOutcome}`;
      console.log(`   [${new Date().toLocaleTimeString()}] ${side} Price: ${update.price.toFixed(4)} (mid: ${update.midpoint.toFixed(4)}, spread: ${update.spread.toFixed(4)})`);
    },
    onLastTrade: (trade) => {
      const side = trade.assetId === yesTokenId ? `YES/${yesOutcome}` : `NO/${noOutcome}`;
      console.log(`   [${new Date().toLocaleTimeString()}] ${side} Trade: ${trade.side} ${trade.size} @ ${trade.price.toFixed(4)}`);
    },
    onPairUpdate: (update) => {
      const spread = update.spread;
      const arbSignal = spread < 0.99 ? 'ARB!' : spread > 1.01 ? 'ARB!' : 'OK';
      console.log(`   [${new Date().toLocaleTimeString()}] PAIR: YES/${yesOutcome} ${update.yes.price.toFixed(4)} + NO/${noOutcome} ${update.no.price.toFixed(4)} = ${spread.toFixed(4)} [${arbSignal}]`);
    },
    onError: (error) => {
      console.error(`   Error: ${error.message}`);
    },
  });

  console.log(`   Subscription ID: ${subscription.id}`);
  console.log(`   Subscribed to: ${subscription.tokenIds.length} tokens`);
  console.log(`\n   Waiting for updates (max ${maxUpdates})...\n`);

  // 5. Optionally subscribe to crypto prices (BTC, ETH)
  console.log('5. Subscribing to crypto prices...');
  const cryptoSub = realtime.subscribeCryptoPrices(['BTCUSDT', 'ETHUSDT'], {
    onPrice: (price) => {
      console.log(`   [${new Date().toLocaleTimeString()}] ${price.symbol}: $${price.price.toFixed(2)}`);
    },
  });
  console.log(`   Crypto subscription ID: ${cryptoSub.id}\n`);

  // 6. Wait for some updates
  await new Promise<void>((resolve) => {
    const interval = setInterval(() => {
      if (updateCount >= maxUpdates) {
        clearInterval(interval);
        resolve();
      }
    }, 500);

    // Timeout after 30 seconds
    setTimeout(() => {
      clearInterval(interval);
      resolve();
    }, 30000);
  });

  // 7. Check cached prices
  console.log('\n6. Cached prices:');
  const prices = realtime.getAllPrices();
  for (const [assetId, price] of prices) {
    const side = assetId === yesTokenId ? 'YES' : 'NO';
    console.log(`   ${side}: ${price.price.toFixed(4)}`);
  }

  // 8. Cleanup
  console.log('\n7. Cleaning up...');
  subscription.unsubscribe();
  cryptoSub.unsubscribe();
  realtime.disconnect();
  console.log('   Disconnected');

  console.log('\n=== Done ===');
}

main().catch(console.error);
