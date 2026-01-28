/**
 * Example 6: Services Demo
 *
 * This example demonstrates the new service layer:
 * - WalletService for smart money analysis
 * - MarketService for K-Line and market signals
 *
 * Run: npx tsx examples/06-services-demo.ts
 */

import { PolymarketSDK, type KLineInterval } from '../src/index.js';

async function main() {
  console.log('=== Services Demo ===\n');

  const sdk = new PolymarketSDK();

  // ===== WalletService Demo =====
  console.log('--- WalletService Demo ---\n');

  // 1. Get top traders
  console.log('1. Getting top traders...');
  const topTraders = await sdk.wallets.getTopTraders(5);
  console.log(`   Found ${topTraders.length} top traders\n`);

  for (const trader of topTraders.slice(0, 3)) {
    console.log(`   Rank #${trader.rank}: ${trader.address.slice(0, 10)}...`);
    console.log(`   PnL: $${trader.pnl.toLocaleString()}`);
    console.log(`   Volume: $${trader.volume.toLocaleString()}\n`);
  }

  // 2. Get wallet profile
  if (topTraders.length > 0) {
    console.log('2. Getting wallet profile for top trader...');
    const profile = await sdk.wallets.getWalletProfile(topTraders[0].address);
    console.log(`   Address: ${profile.address.slice(0, 10)}...`);
    console.log(`   Total PnL: $${profile.totalPnL.toFixed(2)}`);
    console.log(`   Smart Score: ${profile.smartScore}/100`);
    console.log(`   Position Count: ${profile.positionCount}`);
    console.log(`   Last Active: ${profile.lastActiveAt.toLocaleString()}\n`);
  }

  // 3. Discover active wallets
  console.log('3. Discovering active wallets from recent trades...');
  const activeWallets = await sdk.wallets.discoverActiveWallets(5);
  console.log(`   Found ${activeWallets.length} active wallets:\n`);
  for (const wallet of activeWallets) {
    console.log(`   - ${wallet.address.slice(0, 10)}...: ${wallet.tradeCount} trades`);
  }

  // ===== MarketService Demo =====
  console.log('\n--- MarketService Demo ---\n');

  // 4. Get trending market
  console.log('4. Getting trending market...');
  const trendingMarkets = await sdk.markets.getTrendingMarkets(1);
  if (trendingMarkets.length === 0) {
    console.log('No trending markets found');
    return;
  }

  const market = trendingMarkets[0];
  console.log(`   Market: ${market.question.slice(0, 60)}...`);
  console.log(`   Condition ID: ${market.conditionId}\n`);

  // 5. Get unified market data
  console.log('5. Getting unified market data...');
  const unifiedMarket = await sdk.markets.getMarket(market.conditionId);
  console.log(`   Source: ${unifiedMarket.source}`);
  const yesToken = unifiedMarket.tokens.find(t => t.outcome === 'Yes');
  const noToken = unifiedMarket.tokens.find(t => t.outcome === 'No');
  console.log(`   YES Price: ${yesToken?.price}`);
  console.log(`   NO Price: ${noToken?.price}`);
  console.log(`   Volume 24hr: $${unifiedMarket.volume24hr?.toLocaleString() || 'N/A'}\n`);

  // 6. Get K-Lines (OHLCV from trade data)
  console.log('6. Getting K-Line OHLCV data...');
  const interval: KLineInterval = '1h';
  const klines = await sdk.markets.getKLinesOHLCV(market.conditionId, interval, { limit: 100 });
  console.log(`   Generated ${klines.length} candles (${interval} interval)\n`);

  if (klines.length > 0) {
    console.log('   Last 3 candles:');
    for (const candle of klines.slice(-3)) {
      const date = new Date(candle.timestamp).toLocaleString();
      console.log(`   [${date}] O:${candle.open.toFixed(3)} H:${candle.high.toFixed(3)} L:${candle.low.toFixed(3)} C:${candle.close.toFixed(3)} V:$${candle.volume.toFixed(0)}`);
    }
  }

  // 7. Get Dual K-Lines (OHLCV from trade data)
  console.log('\n7. Getting dual K-Lines OHLCV (YES + NO)...');
  const dualKlines = await sdk.markets.getDualKLinesOHLCV(market.conditionId, interval, { limit: 100 });
  console.log(`   YES Candles: ${dualKlines.yes.length}`);
  console.log(`   NO Candles: ${dualKlines.no.length}`);

  if (dualKlines.spreadAnalysis && dualKlines.spreadAnalysis.length > 0) {
    console.log('\n   Spread Analysis (last 3):');
    for (const point of dualKlines.spreadAnalysis.slice(-3)) {
      const date = new Date(point.timestamp).toLocaleString();
      console.log(`   [${date}] YES:${point.yesPrice.toFixed(3)} + NO:${point.noPrice.toFixed(3)} = ${point.priceSpread.toFixed(4)} ${point.arbOpportunity}`);
    }
  }

  // 8. Detect market signals
  console.log('\n8. Detecting market signals...');
  const signals = await sdk.markets.detectMarketSignals(market.conditionId);
  console.log(`   Found ${signals.length} signals:\n`);
  for (const signal of signals.slice(0, 5)) {
    console.log(`   - Type: ${signal.type}, Severity: ${signal.severity}`);
  }

  // 9. Check for arbitrage
  console.log('\n9. Checking for arbitrage...');
  const arb = await sdk.markets.detectArbitrage(market.conditionId, 0.001);
  if (arb) {
    console.log(`   Arbitrage found!`);
    console.log(`   Type: ${arb.type}, Profit: ${(arb.profit * 100).toFixed(3)}%`);
    console.log(`   Action: ${arb.action}`);
  } else {
    console.log('   No arbitrage opportunity found');
  }

  console.log('\n=== Done ===');
}

main().catch(console.error);
