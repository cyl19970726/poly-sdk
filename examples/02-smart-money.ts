/**
 * Example 2: Smart Money Analysis
 *
 * This example demonstrates:
 * - Getting wallet positions
 * - Getting wallet activity (trades)
 * - Getting leaderboard data
 * - Discovering active wallets from recent trades
 *
 * Run: npx ts-node examples/02-smart-money.ts
 */

import { PolymarketSDK } from '../src/index.js';

async function main() {
  console.log('=== Smart Money Analysis ===\n');

  const sdk = new PolymarketSDK();

  // 1. Get leaderboard
  console.log('1. Fetching leaderboard (top 10)...');
  const leaderboard = await sdk.wallets.getTopTraders(10);
  console.log(`   Found ${leaderboard.length} top traders`);
  console.log('   Top 10 traders:\n');

  for (const entry of leaderboard.slice(0, 10)) {
    console.log(`   #${entry.rank} ${entry.address.slice(0, 8)}...${entry.address.slice(-6)}`);
    console.log(`       PnL: $${entry.pnl.toLocaleString()}`);
    console.log(`       Volume: $${entry.volume.toLocaleString()}`);
    if (entry.positions) console.log(`       Positions: ${entry.positions}`);
    if (entry.trades) console.log(`       Trades: ${entry.trades}`);
  }

  // 2. Get wallet positions for top trader
  if (leaderboard.length > 0) {
    const topTrader = leaderboard[0].address;
    console.log(`\n2. Getting positions for top trader: ${topTrader.slice(0, 8)}...`);

    const positions = await sdk.dataApi.getPositions(topTrader);
    console.log(`   Found ${positions.length} positions:\n`);

    for (const pos of positions.slice(0, 5)) {
      console.log(`   - ${pos.title || 'Unknown Market'}`);
      console.log(`     Outcome: ${pos.outcome}`);
      console.log(`     Size: ${pos.size.toFixed(2)}`);
      console.log(`     Avg Price: ${pos.avgPrice.toFixed(4)}`);
      console.log(`     Current Price: ${pos.curPrice?.toFixed(4) || 'N/A'}`);
      console.log(`     PnL: $${pos.cashPnl?.toFixed(2) || 'N/A'} (${pos.percentPnl?.toFixed(1) || 'N/A'}%)`);
      console.log('');
    }

    // 3. Get recent activity for top trader
    console.log(`3. Getting recent activity for top trader...`);
    const activity = await sdk.dataApi.getActivity(topTrader, { limit: 10 });
    console.log(`   Found ${activity.length} recent activities:\n`);

    for (const act of activity.slice(0, 5)) {
      const date = new Date(act.timestamp).toLocaleString();
      console.log(`   - [${date}] ${act.type} ${act.side}`);
      console.log(`     Size: ${act.size.toFixed(2)} @ ${act.price.toFixed(4)}`);
      console.log(`     Value: $${(act.usdcSize || 0).toFixed(2)}`);
      console.log(`     Outcome: ${act.outcome}`);
      console.log('');
    }
  }

  // 4. Discover active wallets from recent trades
  console.log('4. Discovering active wallets from recent trades...');
  const recentTrades = await sdk.dataApi.getTrades({ limit: 100 });
  console.log(`   Fetched ${recentTrades.length} recent trades`);

  // Count trades per wallet
  const walletCounts = new Map<string, number>();
  for (const trade of recentTrades) {
    if (trade.proxyWallet) {
      walletCounts.set(
        trade.proxyWallet,
        (walletCounts.get(trade.proxyWallet) || 0) + 1
      );
    }
  }

  // Sort by count
  const sortedWallets = [...walletCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  console.log('   Most active wallets in recent trades:\n');
  for (const [wallet, count] of sortedWallets) {
    console.log(`   - ${wallet.slice(0, 8)}...${wallet.slice(-6)}: ${count} trades`);
  }

  console.log('\n=== Done ===');
}

main().catch(console.error);
