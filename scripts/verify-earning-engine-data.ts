#!/usr/bin/env npx tsx
/**
 * Verify Earning Engine Data Flow
 *
 * 这个脚本验证 earning-engine 需要的所有 Polymarket 数据：
 * 1. 用户持仓（positions）
 * 2. 用户订单/交易历史（activity）
 * 3. 市场数据（markets, orderbook）
 * 4. 实时事件（WebSocket订阅）
 * 5. PnL 计算
 *
 * Usage:
 *   PRIVATE_KEY=0x... npx tsx scripts/verify-earning-engine-data.ts
 *
 * 输出:
 *   - 控制台日志
 *   - docs/verification-report.md
 */

import { Wallet } from 'ethers';
import { ClobClient } from '@polymarket/clob-client';
import { DataApiClient } from '../src/clients/data-api.js';
import { GammaApiClient } from '../src/clients/gamma-api.js';
import { RealtimeServiceV2 } from '../src/services/realtime-service-v2.js';
import * as fs from 'fs';
import * as path from 'path';

// Configuration
const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) {
  console.error('❌ PRIVATE_KEY environment variable required');
  process.exit(1);
}

const wallet = new Wallet(PRIVATE_KEY);
const address = wallet.address;

console.log(`
╔══════════════════════════════════════════════════════════════╗
║     Earning Engine Data Verification                         ║
╚══════════════════════════════════════════════════════════════╝

Testing wallet: ${address}

`);

// Report storage
interface VerificationResult {
  section: string;
  test: string;
  status: 'pass' | 'fail' | 'skip';
  message?: string;
  data?: any;
  error?: string;
}

const results: VerificationResult[] = [];

function addResult(section: string, test: string, status: 'pass' | 'fail' | 'skip', data?: any, error?: string) {
  results.push({
    section,
    test,
    status,
    message: status === 'pass' ? '✓ Passed' : status === 'fail' ? '✗ Failed' : '⊘ Skipped',
    data,
    error
  });

  const icon = status === 'pass' ? '✓' : status === 'fail' ? '✗' : '⊘';
  const color = status === 'pass' ? '\x1b[32m' : status === 'fail' ? '\x1b[31m' : '\x1b[33m';
  console.log(`${color}${icon}\x1b[0m [${section}] ${test}`);
  if (error) {
    console.log(`  Error: ${error}`);
  }
  if (data && status === 'pass') {
    console.log(`  Data:`, JSON.stringify(data, null, 2).substring(0, 200));
  }
}

// ==================================================================
// Section 1: User Positions (策略持仓数据)
// ==================================================================

async function verifyUserPositions() {
  console.log('\n=== Section 1: User Positions ===\n');

  try {
    const dataApi = new DataApiClient({ enableCache: false });

    // Test 1: Get open positions
    try {
      const positions = await dataApi.getTraderPositions(address, {
        limit: 10,
        sortBy: 'CASHPNL',
        sortDirection: 'DESC'
      });

      addResult('Positions', 'Get open positions', 'pass', {
        count: positions.length,
        samplePosition: positions[0] ? {
          market: positions[0].market,
          outcome: positions[0].outcome,
          size: positions[0].size,
          pnl: positions[0].pnl
        } : null
      });

      // Test 2: Verify PnL calculation
      if (positions.length > 0) {
        const pos = positions[0];
        const expectedPnl = pos.value - pos.cost;
        const actualPnl = pos.pnl;
        const match = Math.abs(expectedPnl - actualPnl) < 0.01;

        addResult(
          'Positions',
          'PnL calculation accuracy',
          match ? 'pass' : 'fail',
          { expected: expectedPnl, actual: actualPnl, diff: Math.abs(expectedPnl - actualPnl) },
          match ? undefined : 'PnL mismatch'
        );
      } else {
        addResult('Positions', 'PnL calculation accuracy', 'skip', null, 'No positions to verify');
      }

    } catch (error: any) {
      addResult('Positions', 'Get open positions', 'fail', null, error.message);
    }

    // Test 3: Get closed positions
    try {
      const closedPositions = await dataApi.getTraderClosedPositions(address, {
        limit: 5,
        sortBy: 'REALIZEDPNL',
        sortDirection: 'DESC'
      });

      addResult('Positions', 'Get closed positions', 'pass', {
        count: closedPositions.length,
        samplePosition: closedPositions[0] ? {
          market: closedPositions[0].market,
          realizedPnl: closedPositions[0].realizedPnL
        } : null
      });
    } catch (error: any) {
      addResult('Positions', 'Get closed positions', 'fail', null, error.message);
    }

  } catch (error: any) {
    addResult('Positions', 'Initialize Data API', 'fail', null, error.message);
  }
}

// ==================================================================
// Section 2: User Activity (订单和交易历史)
// ==================================================================

async function verifyUserActivity() {
  console.log('\n=== Section 2: User Activity ===\n');

  try {
    const dataApi = new DataApiClient({ enableCache: false });

    // Test 1: Get recent activity
    try {
      const activities = await dataApi.getTraderActivity(address, {
        limit: 20,
        fetchAll: false
      });

      const activityTypes = new Set(activities.map(a => a.type));

      addResult('Activity', 'Get recent activity', 'pass', {
        count: activities.length,
        types: Array.from(activityTypes),
        sample: activities[0] ? {
          type: activities[0].type,
          side: activities[0].side,
          outcome: activities[0].outcome,
          price: activities[0].price,
          size: activities[0].size
        } : null
      });

      // Test 2: Filter by type
      const trades = activities.filter(a => a.type === 'TRADE');
      addResult('Activity', 'Filter TRADE events', 'pass', {
        tradeCount: trades.length,
        totalCount: activities.length
      });

    } catch (error: any) {
      addResult('Activity', 'Get recent activity', 'fail', null, error.message);
    }

    // Test 3: Get trades only
    try {
      const trades = await dataApi.getTraderTrades(address, {
        limit: 10,
        side: undefined  // Both sides
      });

      addResult('Activity', 'Get trades only', 'pass', {
        count: trades.length,
        sample: trades[0] ? {
          market: trades[0].market,
          side: trades[0].side,
          price: trades[0].price,
          size: trades[0].size,
          timestamp: trades[0].timestamp
        } : null
      });
    } catch (error: any) {
      addResult('Activity', 'Get trades only', 'fail', null, error.message);
    }

  } catch (error: any) {
    addResult('Activity', 'Initialize Data API', 'fail', null, error.message);
  }
}

// ==================================================================
// Section 3: Market Data (市场信息和订单簿)
// ==================================================================

async function verifyMarketData() {
  console.log('\n=== Section 3: Market Data ===\n');

  try {
    const gammaApi = new GammaApiClient({ enableCache: false });

    // Test 1: Search markets
    try {
      const markets = await gammaApi.searchMarkets({
        query: 'BTC',
        active: true,
        limit: 5
      });

      addResult('Markets', 'Search markets', 'pass', {
        count: markets.length,
        sample: markets[0] ? {
          slug: markets[0].slug,
          question: markets[0].question,
          conditionId: markets[0].conditionId,
          volume: markets[0].volume
        } : null
      });

      // Test 2: Get market detail
      if (markets.length > 0) {
        try {
          const market = await gammaApi.getMarket(markets[0].conditionId);

          addResult('Markets', 'Get market detail', 'pass', {
            conditionId: market.conditionId,
            question: market.question,
            tokens: market.tokens.map(t => ({
              outcome: t.outcome,
              price: t.price,
              tokenId: t.token_id
            }))
          });

          // Test 3: Get orderbook
          try {
            const clobClient = new ClobClient(
              '137',  // Polygon mainnet
              wallet,
              {
                chainId: 137,
              }
            );

            const orderbook = await clobClient.getOrderBook(market.conditionId);

            addResult('Markets', 'Get orderbook', 'pass', {
              conditionId: market.conditionId,
              yesAsks: orderbook.asks.length,
              yesBids: orderbook.bids.length,
              bestAsk: orderbook.asks[0]?.price,
              bestBid: orderbook.bids[0]?.price,
              spread: orderbook.asks[0] && orderbook.bids[0]
                ? Number(orderbook.asks[0].price) - Number(orderbook.bids[0].price)
                : null
            });

          } catch (error: any) {
            addResult('Markets', 'Get orderbook', 'fail', null, error.message);
          }

        } catch (error: any) {
          addResult('Markets', 'Get market detail', 'fail', null, error.message);
        }
      } else {
        addResult('Markets', 'Get market detail', 'skip', null, 'No markets found');
        addResult('Markets', 'Get orderbook', 'skip', null, 'No markets found');
      }

    } catch (error: any) {
      addResult('Markets', 'Search markets', 'fail', null, error.message);
    }

  } catch (error: any) {
    addResult('Markets', 'Initialize Gamma API', 'fail', null, error.message);
  }
}

// ==================================================================
// Section 4: Real-time Events (WebSocket 订阅)
// ==================================================================

async function verifyRealtimeEvents(): Promise<void> {
  console.log('\n=== Section 4: Real-time Events ===\n');

  return new Promise((resolve) => {
    try {
      const realtimeService = new RealtimeServiceV2({
        chainId: '137',
        wallet,
      });

      let orderEventReceived = false;
      let tradeEventReceived = false;
      let timeout: NodeJS.Timeout;

      // Subscribe to user events
      realtimeService.subscribeUserEvents({
        onOrder: (order) => {
          if (!orderEventReceived) {
            orderEventReceived = true;
            addResult('Realtime', 'Receive order events', 'pass', {
              orderId: order.orderId,
              market: order.market,
              side: order.side,
              price: order.price,
              eventType: order.eventType
            });
          }
        },
        onTrade: (trade) => {
          if (!tradeEventReceived) {
            tradeEventReceived = true;
            addResult('Realtime', 'Receive trade events', 'pass', {
              tradeId: trade.tradeId,
              market: trade.market,
              side: trade.side,
              price: trade.price,
              size: trade.size,
              status: trade.status
            });
          }
        },
        onError: (error) => {
          addResult('Realtime', 'WebSocket connection', 'fail', null, error.message);
          resolve();
        }
      });

      addResult('Realtime', 'Subscribe to user events', 'pass', {
        wallet: address
      });

      // Wait for events (30 seconds max)
      timeout = setTimeout(() => {
        if (!orderEventReceived) {
          addResult('Realtime', 'Receive order events', 'skip', null, 'No order events in 30s (try trading first)');
        }
        if (!tradeEventReceived) {
          addResult('Realtime', 'Receive trade events', 'skip', null, 'No trade events in 30s (try trading first)');
        }

        realtimeService.close();
        resolve();
      }, 30000);

      // If both events received, exit early
      const checkComplete = setInterval(() => {
        if (orderEventReceived && tradeEventReceived) {
          clearInterval(checkComplete);
          clearTimeout(timeout);
          realtimeService.close();
          resolve();
        }
      }, 1000);

    } catch (error: any) {
      addResult('Realtime', 'Initialize Realtime Service', 'fail', null, error.message);
      resolve();
    }
  });
}

// ==================================================================
// Section 5: Account Value (账户余额)
// ==================================================================

async function verifyAccountValue() {
  console.log('\n=== Section 5: Account Value ===\n');

  try {
    const dataApi = new DataApiClient({ enableCache: false });

    // Test 1: Get total account value
    try {
      const accountValue = await dataApi.getAccountValue(address);

      addResult('Account', 'Get account value', 'pass', {
        totalValue: accountValue.total,
        markets: accountValue.markets.length,
        sample: accountValue.markets[0] ? {
          market: accountValue.markets[0].market,
          value: accountValue.markets[0].value
        } : null
      });

    } catch (error: any) {
      addResult('Account', 'Get account value', 'fail', null, error.message);
    }

    // Test 2: Get trader profile
    try {
      const profile = await dataApi.getTraderProfile(address);

      addResult('Account', 'Get trader profile', 'pass', {
        volume: profile.volumeTraded,
        pnl: profile.pnl,
        markets: profile.marketsTraded,
        avgPnl: profile.avgPnl,
        winRate: profile.winRate
      });

    } catch (error: any) {
      addResult('Account', 'Get trader profile', 'fail', null, error.message);
    }

  } catch (error: any) {
    addResult('Account', 'Initialize Data API', 'fail', null, error.message);
  }
}

// ==================================================================
// Generate Report
// ==================================================================

function generateReport() {
  console.log('\n\n=== Verification Summary ===\n');

  const sections = [...new Set(results.map(r => r.section))];

  let totalPass = 0;
  let totalFail = 0;
  let totalSkip = 0;

  for (const section of sections) {
    const sectionResults = results.filter(r => r.section === section);
    const pass = sectionResults.filter(r => r.status === 'pass').length;
    const fail = sectionResults.filter(r => r.status === 'fail').length;
    const skip = sectionResults.filter(r => r.status === 'skip').length;

    totalPass += pass;
    totalFail += fail;
    totalSkip += skip;

    console.log(`${section}:`);
    console.log(`  ✓ ${pass} passed`);
    if (fail > 0) console.log(`  ✗ ${fail} failed`);
    if (skip > 0) console.log(`  ⊘ ${skip} skipped`);
  }

  console.log(`\nTotal:`);
  console.log(`  ✓ ${totalPass} passed`);
  if (totalFail > 0) console.log(`  ✗ ${totalFail} failed`);
  if (totalSkip > 0) console.log(`  ⊘ ${totalSkip} skipped`);

  // Generate markdown report
  const reportPath = path.join(__dirname, '../docs/verification-report.md');
  const reportDir = path.dirname(reportPath);

  if (!fs.existsSync(reportDir)) {
    fs.mkdirSync(reportDir, { recursive: true });
  }

  let markdown = `# Earning Engine Data Verification Report\n\n`;
  markdown += `**Date**: ${new Date().toISOString()}\n`;
  markdown += `**Wallet**: ${address}\n\n`;
  markdown += `## Summary\n\n`;
  markdown += `| Status | Count |\n`;
  markdown += `|--------|-------|\n`;
  markdown += `| ✓ Passed | ${totalPass} |\n`;
  markdown += `| ✗ Failed | ${totalFail} |\n`;
  markdown += `| ⊘ Skipped | ${totalSkip} |\n\n`;

  for (const section of sections) {
    markdown += `## ${section}\n\n`;
    const sectionResults = results.filter(r => r.section === section);

    for (const result of sectionResults) {
      const icon = result.status === 'pass' ? '✓' : result.status === 'fail' ? '✗' : '⊘';
      markdown += `### ${icon} ${result.test}\n\n`;

      if (result.error) {
        markdown += `**Error**: ${result.error}\n\n`;
      }

      if (result.data) {
        markdown += `**Data**:\n\`\`\`json\n${JSON.stringify(result.data, null, 2)}\n\`\`\`\n\n`;
      }
    }
  }

  fs.writeFileSync(reportPath, markdown);
  console.log(`\n📄 Report saved to: ${reportPath}`);
}

// ==================================================================
// Main
// ==================================================================

async function main() {
  try {
    await verifyUserPositions();
    await verifyUserActivity();
    await verifyMarketData();
    await verifyRealtimeEvents();
    await verifyAccountValue();

    generateReport();

    const failCount = results.filter(r => r.status === 'fail').length;
    process.exit(failCount > 0 ? 1 : 0);

  } catch (error: any) {
    console.error('\n❌ Fatal error:', error);
    process.exit(1);
  }
}

main();
