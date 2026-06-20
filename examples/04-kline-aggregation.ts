/**
 * Example 4: K-Line Aggregation from Trade Data
 *
 * This example demonstrates:
 * - Getting trade history for a market
 * - Aggregating trades into K-Line (OHLCV) candles
 * - Calculating dual-token K-Lines for binary markets
 *
 * Run: npx ts-node examples/04-kline-aggregation.ts
 */

import {
  PolymarketSDK,
  type Trade,
  type KLineInterval,
  getIntervalMs,
  getBinaryTokens,
} from '../src/index.js';

interface KLineCandle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  tradeCount: number;
  buyVolume: number;
  sellVolume: number;
}

function aggregateToKLines(trades: Trade[], interval: KLineInterval): KLineCandle[] {
  const intervalMs = getIntervalMs(interval);
  const buckets = new Map<number, Trade[]>();

  // Group trades into time buckets
  for (const trade of trades) {
    const bucketTime = Math.floor(trade.timestamp / intervalMs) * intervalMs;
    const bucket = buckets.get(bucketTime) || [];
    bucket.push(trade);
    buckets.set(bucketTime, bucket);
  }

  // Convert buckets to candles
  const candles: KLineCandle[] = [];
  for (const [timestamp, bucketTrades] of buckets) {
    if (bucketTrades.length === 0) continue;

    // Sort by timestamp for correct open/close
    bucketTrades.sort((a, b) => a.timestamp - b.timestamp);

    const prices = bucketTrades.map((t) => t.price);
    const buyTrades = bucketTrades.filter((t) => t.side === 'BUY');
    const sellTrades = bucketTrades.filter((t) => t.side === 'SELL');

    candles.push({
      timestamp,
      open: bucketTrades[0].price,
      high: Math.max(...prices),
      low: Math.min(...prices),
      close: bucketTrades[bucketTrades.length - 1].price,
      volume: bucketTrades.reduce((sum, t) => sum + t.size * t.price, 0),
      tradeCount: bucketTrades.length,
      buyVolume: buyTrades.reduce((sum, t) => sum + t.size * t.price, 0),
      sellVolume: sellTrades.reduce((sum, t) => sum + t.size * t.price, 0),
    });
  }

  return candles.sort((a, b) => a.timestamp - b.timestamp);
}

async function main() {
  console.log('=== K-Line Aggregation from Trade Data ===\n');

  const sdk = new PolymarketSDK();

  // 1. Get a trending market
  console.log('1. Fetching a trending market...');
  const markets = await sdk.gammaApi.getTrendingMarkets(1);

  if (markets.length === 0) {
    console.log('No trending markets found');
    return;
  }

  const market = markets[0];
  console.log(`   Selected: ${market.question}`);
  console.log(`   Condition ID: ${market.conditionId}\n`);

  // 2. Get trade history
  console.log('2. Fetching trade history...');
  const trades = await sdk.dataApi.getTradesByMarket(market.conditionId, 500);
  console.log(`   Found ${trades.length} trades\n`);

  if (trades.length === 0) {
    console.log('No trades found for this market');
    return;
  }

  // 3. Get token info
  console.log('3. Getting token info...');
  const unifiedMarket = await sdk.getMarket(market.conditionId);
  const binary = getBinaryTokens(unifiedMarket.tokens);
  if (!binary) {
    console.log('Selected market is not binary');
    return;
  }
  const [yesOutcome, noOutcome] = binary.outcomes;
  const yesToken = binary.primary;
  const noToken = binary.secondary;
  console.log(`   YES Token (${yesOutcome}): ${yesToken.tokenId.slice(0, 16)}...`);
  console.log(`   NO Token (${noOutcome}): ${noToken.tokenId.slice(0, 16)}...\n`);

  // 4. Separate trades by outcome index (primary vs secondary)
  const yesTrades = trades.filter((t) => t.outcomeIndex === 0);
  const noTrades = trades.filter((t) => t.outcomeIndex === 1);
  console.log(
    `4. Separated trades: YES/${yesOutcome}=${yesTrades.length}, NO/${noOutcome}=${noTrades.length}\n`
  );

  // 5. Aggregate into 1-hour candles
  const interval: KLineInterval = '1h';
  console.log(`5. Aggregating into ${interval} candles...\n`);

  const yesCandles = aggregateToKLines(yesTrades, interval);
  const noCandles = aggregateToKLines(noTrades, interval);

  console.log(`   YES Token K-Lines (${yesOutcome}, ${yesCandles.length} candles):`);
  for (const candle of yesCandles.slice(-5)) {
    const date = new Date(candle.timestamp).toLocaleString();
    console.log(
      `   [${date}] O:${candle.open.toFixed(3)} H:${candle.high.toFixed(3)} L:${candle.low.toFixed(3)} C:${candle.close.toFixed(3)} V:$${candle.volume.toFixed(0)} (${candle.tradeCount} trades)`
    );
  }

  console.log(`\n   NO Token K-Lines (${noOutcome}, ${noCandles.length} candles):`);
  for (const candle of noCandles.slice(-5)) {
    const date = new Date(candle.timestamp).toLocaleString();
    console.log(
      `   [${date}] O:${candle.open.toFixed(3)} H:${candle.high.toFixed(3)} L:${candle.low.toFixed(3)} C:${candle.close.toFixed(3)} V:$${candle.volume.toFixed(0)} (${candle.tradeCount} trades)`
    );
  }

  // 6. Calculate spread over time
  console.log(`\n6. Spread Analysis (YES/${yesOutcome}_price + NO/${noOutcome}_price):\n`);

  // Find matching timestamps
  const yesMap = new Map(yesCandles.map((c) => [c.timestamp, c]));
  const noMap = new Map(noCandles.map((c) => [c.timestamp, c]));

  const allTimestamps = [...new Set([...yesMap.keys(), ...noMap.keys()])].sort();
  let lastYes = 0.5;
  let lastNo = 0.5;

  for (const ts of allTimestamps.slice(-5)) {
    const date = new Date(ts).toLocaleString();
    const yesCandle = yesMap.get(ts);
    const noCandle = noMap.get(ts);

    if (yesCandle) lastYes = yesCandle.close;
    if (noCandle) lastNo = noCandle.close;

    const spread = lastYes + lastNo;
    const arbOpportunity = spread < 1 ? 'LONG ARB' : spread > 1 ? 'SHORT ARB' : '';

    console.log(
      `   [${date}] YES/${yesOutcome}:${lastYes.toFixed(3)} + NO/${noOutcome}:${lastNo.toFixed(3)} = ${spread.toFixed(4)} ${arbOpportunity}`
    );
  }

  console.log('\n=== Done ===');
}

main().catch(console.error);
