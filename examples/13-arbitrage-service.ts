#!/usr/bin/env npx tsx
/**
 * Example 13: ArbitrageService - Complete Workflow
 *
 * Demonstrates the full arbitrage workflow:
 * 1. Scan markets for opportunities
 * 2. Start real-time monitoring
 * 3. Auto-execute arbitrage
 * 4. Stop and clear positions
 *
 * Environment variables:
 *   POLY_PRIVKEY - Private key for trading (optional for scan-only mode)
 *
 * Run with:
 *   pnpm example:arb-service
 *
 * Or scan-only (no trading):
 *   npx tsx examples/13-arbitrage-service.ts --scan-only
 */

import { ArbitrageService } from '../src/index.js';

// Parse arguments
const args = process.argv.slice(2);
const SCAN_ONLY = args.includes('--scan-only');
const RUN_DURATION = parseInt(args.find(a => a.startsWith('--duration='))?.split('=')[1] || '60') * 1000; // default 60s

async function main() {
  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║              ArbitrageService - Complete Workflow              ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');
  console.log();

  const privateKey = process.env.POLY_PRIVKEY;

  if (!privateKey && !SCAN_ONLY) {
    console.log('No POLY_PRIVKEY provided. Running in scan-only mode.\n');
  }

  // ========== Initialize ArbitrageService ==========
  const arbService = new ArbitrageService({
    privateKey: SCAN_ONLY ? undefined : privateKey,
    profitThreshold: 0.005,  // 0.5% minimum profit
    minTradeSize: 5,         // $5 minimum
    maxTradeSize: 100,       // $100 maximum
    autoExecute: !SCAN_ONLY && !!privateKey,
    enableLogging: true,

    // Rebalancer config
    enableRebalancer: !SCAN_ONLY && !!privateKey,
    minUsdcRatio: 0.2,
    maxUsdcRatio: 0.8,
    targetUsdcRatio: 0.5,
    imbalanceThreshold: 5,
    rebalanceInterval: 10000,
    rebalanceCooldown: 30000,

    // Execution safety
    sizeSafetyFactor: 0.8,
    autoFixImbalance: true,
  });

  // ========== Set up event listeners ==========
  arbService.on('opportunity', (opp) => {
    console.log(`\n🎯 ${opp.type.toUpperCase()} ARB: ${opp.profitPercent.toFixed(2)}%`);
    console.log(`   ${opp.description}`);
    console.log(`   Recommended size: ${opp.recommendedSize.toFixed(2)}, Est profit: $${opp.estimatedProfit.toFixed(2)}`);
  });

  arbService.on('execution', (result) => {
    if (result.success) {
      console.log(`\n✅ Execution succeeded!`);
      console.log(`   Type: ${result.type}, Size: ${result.size.toFixed(2)}`);
      console.log(`   Profit: $${result.profit.toFixed(2)}`);
      console.log(`   Time: ${result.executionTimeMs}ms`);
    } else {
      console.log(`\n❌ Execution failed: ${result.error}`);
    }
  });

  arbService.on('rebalance', (result) => {
    if (result.success) {
      console.log(`\n🔄 Rebalance: ${result.action.type} ${result.action.amount.toFixed(2)}`);
      console.log(`   Reason: ${result.action.reason}`);
    } else {
      console.log(`\n⚠️ Rebalance failed: ${result.error}`);
    }
  });

  arbService.on('balanceUpdate', (balance) => {
    console.log(`\n💰 Balance: USDC=${balance.usdc.toFixed(2)}, YES=${balance.yesTokens.toFixed(2)}, NO=${balance.noTokens.toFixed(2)}`);
  });

  arbService.on('error', (error) => {
    console.error(`\n🚨 Error: ${error.message}`);
  });

  // ========== Step 1: Scan Markets ==========
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('Step 1: Scanning markets for arbitrage opportunities...');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const scanResults = await arbService.scanMarkets(
    {
      minVolume24h: 5000,
      limit: 50,
      feeAware: true,
      feeEstimateSize: 1,
      liquidityRole: 'taker',
    },
    0.003  // 0.3% min net profit for scanning
  );

  const opportunities = scanResults.filter(r => r.arbType !== 'none');

  console.log(`\nFound ${opportunities.length} opportunities out of ${scanResults.length} markets scanned\n`);

  if (opportunities.length > 0) {
    console.log('Top 5 opportunities:');
    console.log('┌──────────────────────────────────────────────────────────────────┐');
    for (const r of opportunities.slice(0, 5)) {
      console.log(`│ ${r.market.name.slice(0, 50).padEnd(50)} │`);
      console.log(`│   ${r.arbType.toUpperCase()} +${r.profitPercent.toFixed(2)}% net  Gross: ${((r.grossProfitRate ?? 0) * 100).toFixed(2)}%  Fees: ${(r.totalFees ?? 0).toFixed(5)} │`);
      console.log(`│   Size: ${r.availableSize.toFixed(0)}  Vol: $${r.volume24h.toLocaleString().padEnd(10)} │`);
      console.log(`├──────────────────────────────────────────────────────────────────┤`);
    }
    console.log('└──────────────────────────────────────────────────────────────────┘');
  }

  if (SCAN_ONLY || opportunities.length === 0) {
    console.log('\n✅ Scan complete.');
    if (SCAN_ONLY) {
      console.log('   (Running in scan-only mode, not starting arbitrage)');
    }
    if (opportunities.length === 0) {
      console.log('   (No profitable opportunities found)');
    }
    return;
  }

  // ========== Step 2: Start Arbitrage ==========
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('Step 2: Starting arbitrage on best market...');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const best = opportunities[0];
  console.log(`Selected: ${best.market.name}`);
  console.log(`Type: ${best.arbType.toUpperCase()}, Net Profit: +${best.profitPercent.toFixed(2)}%`);
  console.log(`Gross: ${((best.grossProfitRate ?? 0) * 100).toFixed(2)}%, Fees: ${(best.totalFees ?? 0).toFixed(5)} pUSD/${best.feeEstimateSize ?? 1}\n`);

  await arbService.start(best.market);

  // ========== Step 3: Run for duration ==========
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(`Step 3: Running for ${RUN_DURATION / 1000} seconds...`);
  console.log('═══════════════════════════════════════════════════════════════\n');
  console.log('Monitoring for arbitrage opportunities...');
  console.log('(Press Ctrl+C to stop early)\n');

  // Handle graceful shutdown
  let stopped = false;
  const shutdown = async () => {
    if (stopped) return;
    stopped = true;
    console.log('\n\nShutting down...');
    await cleanup();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Wait for duration
  await new Promise(resolve => setTimeout(resolve, RUN_DURATION));

  // ========== Step 4: Stop and Clear ==========
  async function cleanup() {
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('Step 4: Stopping and clearing positions...');
    console.log('═══════════════════════════════════════════════════════════════\n');

    await arbService.stop();

    // Print stats
    const stats = arbService.getStats();
    console.log('Session Statistics:');
    console.log(`  Opportunities detected: ${stats.opportunitiesDetected}`);
    console.log(`  Executions attempted: ${stats.executionsAttempted}`);
    console.log(`  Executions succeeded: ${stats.executionsSucceeded}`);
    console.log(`  Total profit: $${stats.totalProfit.toFixed(2)}`);
    console.log(`  Running time: ${(stats.runningTimeMs / 1000).toFixed(0)}s`);

    // Clear positions
    if (privateKey) {
      console.log('\nClearing positions...');
      const clearResult = await arbService.clearPositions(best.market, false);

      console.log(`\nPosition status:`);
      console.log(`  Market status: ${clearResult.marketStatus}`);
      console.log(`  YES balance: ${clearResult.yesBalance.toFixed(4)}`);
      console.log(`  NO balance: ${clearResult.noBalance.toFixed(4)}`);
      console.log(`  Expected recovery: $${clearResult.totalUsdcRecovered.toFixed(2)}`);

      if (clearResult.actions.length > 0) {
        console.log(`\nPlanned actions:`);
        for (const action of clearResult.actions) {
          console.log(`  - ${action.type}: ${action.amount.toFixed(4)} → ~$${action.usdcResult.toFixed(2)}`);
        }
        console.log('\n(Run with --execute-clear to actually clear positions)');
      }
    }

    console.log('\n✅ Done!');
  }

  await cleanup();
}

main().catch(console.error);
