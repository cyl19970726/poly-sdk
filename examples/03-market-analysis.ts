/**
 * Example 3: Market Analysis & Arbitrage Detection
 *
 * This example demonstrates:
 * - Getting multiple markets' orderbooks
 * - Detecting arbitrage opportunities
 * - Analyzing market depth and imbalance
 *
 * Run: npx ts-node examples/03-market-analysis.ts
 */

import { PolymarketSDK, getBinaryTokens } from '../src/index.js';

async function main() {
  console.log('=== Market Analysis & Arbitrage Detection ===\n');

  const sdk = new PolymarketSDK();

  // 1. Get trending markets for analysis
  console.log('1. Fetching trending markets...');
  const markets = await sdk.gammaApi.getTrendingMarkets(10);
  console.log(`   Found ${markets.length} trending markets\n`);

  // 2. Analyze each market for arbitrage
  console.log('2. Analyzing markets for arbitrage opportunities...\n');

  const arbitrageOpportunities = [];

  for (const market of markets) {
    try {
      console.log(`   Checking: ${market.question.slice(0, 60)}...`);

      // Get unified market for token IDs
      const unifiedMarket = await sdk.getMarket(market.conditionId);
      if (!getBinaryTokens(unifiedMarket.tokens)) {
        console.log('     Skipping (market is not binary)\n');
        continue;
      }

      // Get orderbook
      const orderbook = await sdk.getOrderbook(market.conditionId);

      // Check for arbitrage
      const arb = await sdk.detectArbitrage(market.conditionId, 0.001); // 0.1% threshold

      if (arb) {
        console.log(`     ** ARBITRAGE FOUND **`);
        console.log(`     Type: ${arb.type}`);
        console.log(`     Profit: ${(arb.profit * 100).toFixed(3)}%`);
        console.log(`     Action: ${arb.action}`);
        arbitrageOpportunities.push({
          market: market.question,
          slug: market.slug,
          ...arb,
        });
      } else {
        console.log(`     No arbitrage (ask sum: ${orderbook.summary.askSum.toFixed(4)}, bid sum: ${orderbook.summary.bidSum.toFixed(4)})`);
      }
      console.log('');

    } catch (error) {
      console.log(`     Error: ${(error as Error).message}\n`);
    }
  }

  // 3. Summary
  console.log('=== Summary ===\n');

  if (arbitrageOpportunities.length > 0) {
    console.log(`Found ${arbitrageOpportunities.length} arbitrage opportunities:\n`);
    for (const opp of arbitrageOpportunities) {
      console.log(`- ${opp.market.slice(0, 60)}...`);
      console.log(`  Slug: ${opp.slug}`);
      console.log(`  Type: ${opp.type}, Profit: ${(opp.profit * 100).toFixed(3)}%`);
      console.log('');
    }
  } else {
    console.log('No arbitrage opportunities found (this is normal in efficient markets)');
  }

  // 4. Analyze market depth
  console.log('\n=== Market Depth Analysis ===\n');

  for (const market of markets.slice(0, 3)) {
    try {
      const orderbook = await sdk.getOrderbook(market.conditionId);

      console.log(`Market: ${market.question.slice(0, 50)}...`);
      console.log(`  Total Bid Depth: $${orderbook.summary.totalBidDepth.toFixed(2)}`);
      console.log(`  Total Ask Depth: $${orderbook.summary.totalAskDepth.toFixed(2)}`);
      console.log(`  Imbalance Ratio: ${orderbook.summary.imbalanceRatio.toFixed(2)}`);

      if (orderbook.summary.imbalanceRatio > 1.5) {
        console.log(`  ** HIGH BUY PRESSURE (ratio > 1.5) **`);
      } else if (orderbook.summary.imbalanceRatio < 0.67) {
        console.log(`  ** HIGH SELL PRESSURE (ratio < 0.67) **`);
      }
      console.log('');
    } catch {
      // Skip errors
    }
  }

  console.log('=== Done ===');
}

main().catch(console.error);
