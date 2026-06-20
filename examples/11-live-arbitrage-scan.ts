/**
 * Example 12: Live Arbitrage Scan
 *
 * This script scans real Polymarket markets for arbitrage opportunities.
 * It uses only read operations (no trading) to safely test the arbitrage detection.
 *
 * Features demonstrated:
 * - Real market data fetching
 * - Arbitrage opportunity detection
 * - Gas cost estimation
 * - Pre-flight checks simulation
 *
 * Run with:
 *   pnpm example:live-arb
 */

import { PolymarketSDK, checkArbitrage } from '../src/index.js';

async function main() {
  console.log('=== Live Arbitrage Market Scan ===\n');
  console.log('Scanning real Polymarket markets for arbitrage opportunities...\n');

  // Initialize SDK (no credentials needed for read operations)
  const sdk = new PolymarketSDK();

  // ===== 1. Fetch Active Markets =====
  console.log('1. Fetching active markets...\n');

  const markets = await sdk.gammaApi.getMarkets({
    closed: false,
    active: true,
    limit: 50,
  });

  console.log(`   Found ${markets.length} active markets\n`);

  // ===== 2. Analyze Each Market for Arbitrage =====
  console.log('2. Analyzing markets for arbitrage opportunities...\n');

  const opportunities: Array<{
    question: string;
    slug: string;
    conditionId: string;
    yesOutcome: string;
    noOutcome: string;
    type: 'long' | 'short';
    yesAsk: number;
    noAsk: number;
    yesBid: number;
    noBid: number;
    askSum: number;
    bidSum: number;
    longArbProfit: number;
    shortArbProfit: number;
    spread: number;
    volume24h: number;
  }> = [];

  let analyzed = 0;
  let errors = 0;

  for (const market of markets) {
    if (!market.conditionId) continue;

    try {
      const orderbook = await sdk.markets.getProcessedOrderbook(market.conditionId);

      analyzed++;

      // Check for any arbitrage
      const arb = checkArbitrage(
        orderbook.yes.ask,
        orderbook.no.ask,
        orderbook.yes.bid,
        orderbook.no.bid
      );

      // Store all markets for analysis (even with negative arb profit)
      // This helps us understand market efficiency
      if (orderbook.yes.ask > 0 && orderbook.no.ask > 0) {
        const yesOutcome = market.outcomes?.[0] || 'Outcome 1';
        const noOutcome = market.outcomes?.[1] || 'Outcome 2';
        opportunities.push({
          question: market.question?.slice(0, 60) || 'Unknown',
          slug: market.slug || '',
          conditionId: market.conditionId,
          yesOutcome,
          noOutcome,
          type: arb?.type || (orderbook.summary.longArbProfit > orderbook.summary.shortArbProfit ? 'long' : 'short'),
          yesAsk: orderbook.yes.ask,
          noAsk: orderbook.no.ask,
          yesBid: orderbook.yes.bid,
          noBid: orderbook.no.bid,
          askSum: orderbook.summary.askSum,
          bidSum: orderbook.summary.bidSum,
          longArbProfit: orderbook.summary.longArbProfit,
          shortArbProfit: orderbook.summary.shortArbProfit,
          spread: orderbook.summary.yesSpread,
          volume24h: market.volume24hr || 0,
        });
      }

      // Progress indicator
      if (analyzed % 10 === 0) {
        process.stdout.write(`   Analyzed ${analyzed}/${markets.length} markets...\r`);
      }
    } catch {
      errors++;
    }
  }

  console.log(`\n   Completed: ${analyzed} markets analyzed, ${errors} errors\n`);

  // ===== 3. Sort and Display Results =====
  console.log('3. Top Arbitrage Opportunities:\n');

  // Sort by best opportunity (max of long or short profit)
  opportunities.sort((a, b) => {
    const aMax = Math.max(a.longArbProfit, a.shortArbProfit);
    const bMax = Math.max(b.longArbProfit, b.shortArbProfit);
    return bMax - aMax;
  });

  // Display top 10
  const top10 = opportunities.slice(0, 10);

  if (top10.length === 0) {
    console.log('   No markets found with significant spread');
  } else {
    console.log('   ┌────────────────────────────────────────────────────────────────┐');
    console.log('   │ Market Analysis (Top 10 by potential profit)                  │');
    console.log('   ├────────────────────────────────────────────────────────────────┤');

    for (const opp of top10) {
      const maxProfit = Math.max(opp.longArbProfit, opp.shortArbProfit);
      const arbType = opp.longArbProfit > opp.shortArbProfit ? 'LONG' : 'SHORT';
      const isProfitable = maxProfit > 0;

      console.log(`   │ ${opp.question.padEnd(60)} │`);
      console.log(`   │                                                                │`);
      console.log(`   │   YES/${opp.yesOutcome}: ask=${opp.yesAsk.toFixed(4)} bid=${opp.yesBid.toFixed(4)}                               │`);
      console.log(`   │   NO/${opp.noOutcome}: ask=${opp.noAsk.toFixed(4)} bid=${opp.noBid.toFixed(4)}                               │`);
      console.log(`   │   Sum: askSum=${opp.askSum.toFixed(4)} bidSum=${opp.bidSum.toFixed(4)}                      │`);
      console.log(`   │   ${arbType} Profit: ${(maxProfit * 100).toFixed(2)}% ${isProfitable ? '✅' : '❌'}                                     │`);
      console.log(`   │   24h Volume: $${opp.volume24h.toLocaleString()}                                       │`);
      console.log(`   ├────────────────────────────────────────────────────────────────┤`);
    }

    console.log('   └────────────────────────────────────────────────────────────────┘');
  }

  // ===== 4. Check for Actual Profitable Opportunities =====
  console.log('\n4. Profitable Opportunities (> 0% profit):\n');

  const profitable = opportunities.filter(
    (opp) => opp.longArbProfit > 0 || opp.shortArbProfit > 0
  );

  if (profitable.length === 0) {
    console.log('   No profitable arbitrage opportunities found.');
    console.log('   This is normal - markets are usually efficient.\n');
    console.log('   ┌─────────────────────────────────────────────────────────────────┐');
    console.log('   │ Why no arbitrage?                                               │');
    console.log('   │                                                                 │');
    console.log('   │ 1. Market makers actively close arbitrage gaps                  │');
    console.log('   │ 2. Gas costs (~$0.01-0.05) eat into small profits              │');
    console.log('   │ 3. Trading fees reduce effective profit                        │');
    console.log('   │ 4. Opportunities disappear in milliseconds                     │');
    console.log('   │                                                                 │');
    console.log('   │ Successful arbitrage requires:                                  │');
    console.log('   │ - Very fast execution                                          │');
    console.log('   │ - Optimized gas usage                                          │');
    console.log('   │ - Significant capital ($1000+)                                 │');
    console.log('   └─────────────────────────────────────────────────────────────────┘');
  } else {
    console.log(`   Found ${profitable.length} profitable opportunities:\n`);

    for (const opp of profitable) {
      const arbType = opp.longArbProfit > opp.shortArbProfit ? 'LONG' : 'SHORT';
      const profit = Math.max(opp.longArbProfit, opp.shortArbProfit);

      console.log(`   🎯 ${arbType} ARB: ${(profit * 100).toFixed(2)}% profit`);
      console.log(`      Market: ${opp.question}`);
      console.log(`      Condition ID: ${opp.conditionId}`);

      if (arbType === 'LONG') {
        console.log(`      Strategy: Buy YES@${opp.yesAsk.toFixed(4)} + NO@${opp.noAsk.toFixed(4)} = ${opp.askSum.toFixed(4)} → Merge for $1`);
      } else {
        console.log(`      Strategy: Split $1 → Sell YES@${opp.yesBid.toFixed(4)} + NO@${opp.noBid.toFixed(4)} = ${opp.bidSum.toFixed(4)}`);
      }
      console.log('');
    }
  }

  // ===== 5. Market Efficiency Analysis =====
  console.log('\n5. Market Efficiency Summary:\n');

  if (opportunities.length === 0) {
    console.log('   No markets analyzed with valid orderbooks.\n');
  } else {
    const avgAskSum = opportunities.reduce((sum, o) => sum + o.askSum, 0) / opportunities.length;
    const avgBidSum = opportunities.reduce((sum, o) => sum + o.bidSum, 0) / opportunities.length;
    const avgSpread = opportunities.reduce((sum, o) => sum + o.spread, 0) / opportunities.length;

    const closestToLongArb = opportunities.reduce((closest, o) =>
      Math.abs(1 - o.askSum) < Math.abs(1 - closest.askSum) ? o : closest
    );

    const closestToShortArb = opportunities.reduce((closest, o) =>
      Math.abs(1 - o.bidSum) < Math.abs(1 - closest.bidSum) ? o : closest
    );

    console.log(`   Average Ask Sum: ${avgAskSum.toFixed(4)} (ideal for long arb: < 1.0)`);
    console.log(`   Average Bid Sum: ${avgBidSum.toFixed(4)} (ideal for short arb: > 1.0)`);
    console.log(`   Average Spread:  ${(avgSpread * 100).toFixed(2)}%`);
    console.log('');
    console.log(`   Closest to Long Arb:  ${closestToLongArb.question.slice(0, 40)}...`);
    console.log(`                         askSum = ${closestToLongArb.askSum.toFixed(4)}, profit = ${(closestToLongArb.longArbProfit * 100).toFixed(2)}%`);
    console.log('');
    console.log(`   Closest to Short Arb: ${closestToShortArb.question.slice(0, 40)}...`);
    console.log(`                         bidSum = ${closestToShortArb.bidSum.toFixed(4)}, profit = ${(closestToShortArb.shortArbProfit * 100).toFixed(2)}%`);
  }

  console.log('\n=== Scan Complete ===\n');
}

main().catch(console.error);
