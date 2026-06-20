/**
 * Example 1: Basic SDK Usage
 *
 * This example demonstrates:
 * - Getting trending markets from Gamma API
 * - Getting market details from unified API (Gamma + CLOB)
 * - Getting orderbook data
 *
 * Run: npx ts-node examples/01-basic-usage.ts
 */

import { PolymarketSDK, getBinaryTokens } from '../src/index.js';

async function main() {
  console.log('=== Polymarket SDK Basic Usage ===\n');

  const sdk = new PolymarketSDK();

  // 1. Get trending markets
  console.log('1. Fetching trending markets...');
  const trendingMarkets = await sdk.gammaApi.getTrendingMarkets(5);
  console.log(`   Found ${trendingMarkets.length} trending markets:\n`);

  for (const market of trendingMarkets) {
    const yesOutcome = market.outcomes[0] || 'Outcome 1';
    const noOutcome = market.outcomes[1] || 'Outcome 2';
    console.log(`   - ${market.question}`);
    console.log(`     Slug: ${market.slug}`);
    console.log(`     Volume: $${market.volume.toLocaleString()}`);
    console.log(`     24h Volume: $${market.volume24hr?.toLocaleString() || 'N/A'}`);
    console.log(
      `     Prices: YES/${yesOutcome}=${market.outcomePrices[0]?.toFixed(2)}, NO/${noOutcome}=${market.outcomePrices[1]?.toFixed(2)}`
    );
    console.log('');
  }

  // 2. Get unified market details (Gamma + CLOB merged)
  if (trendingMarkets.length > 0) {
    const firstMarket = trendingMarkets[0];
    console.log(`2. Getting unified market details for: ${firstMarket.slug}`);
    const unifiedMarket = await sdk.getMarket(firstMarket.slug);
    console.log(`   Question: ${unifiedMarket.question}`);
    console.log(`   Condition ID: ${unifiedMarket.conditionId}`);
    const binary = getBinaryTokens(unifiedMarket.tokens);
    if (!binary) {
      console.log('   Skipping orderbook demo (market is not binary)');
      return;
    }
    const [yesOutcome, noOutcome] = binary.outcomes;
    const yesToken = binary.primary;
    const noToken = binary.secondary;
    console.log(`   YES Token ID (${yesOutcome}): ${yesToken.tokenId}`);
    console.log(`   NO Token ID (${noOutcome}): ${noToken.tokenId}`);
    console.log(`   YES Price (${yesOutcome}): ${yesToken.price.toFixed(4)}`);
    console.log(`   NO Price (${noOutcome}): ${noToken.price.toFixed(4)}`);
    console.log(`   Source: ${unifiedMarket.source}`);
    console.log('');

    // 3. Get orderbook
    console.log('3. Getting orderbook...');
    const orderbook = await sdk.getOrderbook(unifiedMarket.conditionId);
    console.log(`   YES Best Bid (${yesOutcome}): ${orderbook.yes.bid.toFixed(4)} (size: ${orderbook.yes.bidSize.toFixed(2)})`);
    console.log(`   YES Best Ask (${yesOutcome}): ${orderbook.yes.ask.toFixed(4)} (size: ${orderbook.yes.askSize.toFixed(2)})`);
    console.log(`   YES Spread (${yesOutcome}): ${(orderbook.yes.spread * 100).toFixed(2)}%`);
    console.log('');
    console.log(`   NO Best Bid (${noOutcome}): ${orderbook.no.bid.toFixed(4)} (size: ${orderbook.no.bidSize.toFixed(2)})`);
    console.log(`   NO Best Ask (${noOutcome}): ${orderbook.no.ask.toFixed(4)} (size: ${orderbook.no.askSize.toFixed(2)})`);
    console.log(`   NO Spread (${noOutcome}): ${(orderbook.no.spread * 100).toFixed(2)}%`);
    console.log('');
    console.log(`   Ask Sum (YES+NO): ${orderbook.summary.askSum.toFixed(4)}`);
    console.log(`   Bid Sum (YES+NO): ${orderbook.summary.bidSum.toFixed(4)}`);
    console.log(`   Long Arb Profit: ${(orderbook.summary.longArbProfit * 100).toFixed(3)}%`);
    console.log(`   Short Arb Profit: ${(orderbook.summary.shortArbProfit * 100).toFixed(3)}%`);
    console.log(`   Imbalance Ratio: ${orderbook.summary.imbalanceRatio.toFixed(2)}`);
  }

  console.log('\n=== Done ===');
}

main().catch(console.error);
