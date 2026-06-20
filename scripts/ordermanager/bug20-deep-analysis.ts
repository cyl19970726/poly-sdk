#!/usr/bin/env npx tsx
/**
 * Bug 20 深度分析脚本
 *
 * 目的：记录所有 WebSocket USER_TRADE 事件的原始 payload，
 *       特别关注 matchedAmount 字段的行为。
 *
 * Bug 20 现象：
 * - WebSocket USER_TRADE 事件中，maker 订单的 `matchedAmount` 字段为 `0`
 * - 导致 fill 大小计算错误，进而造成本地 balance 与链上状态不同步
 *
 * 测试场景：
 * 1. maker-limit: 被动成交限价单（低于市场价，等待被吃）
 * 2. taker-limit: 主动成交限价单（高于市场价，立即成交）
 * 3. market-fok: FOK 市价单
 * 4. market-fak: FAK 市价单
 *
 * 运行：
 *   PRIVATE_KEY=0x... npx tsx scripts/ordermanager/bug20-deep-analysis.ts
 *
 * 可选参数：
 *   --scenario=maker-limit   只运行指定场景
 *   --timeout=60             等待成交的超时秒数（默认 60）
 *   --amount=1.5             每个订单的 USDC 金额（默认 1.5，最低 1）
 *
 * 余额要求：~$6 USDC.e（4 个场景 × $1.5）
 */

import { ClobClient, Chain } from '@polymarket/clob-client-v2';
import { Wallet } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';
import { OrderManager, type FillEvent } from '../../src/services/order-manager.js';
import { RealtimeServiceV2, type UserTrade, type MakerOrderInfo } from '../../src/services/realtime-service-v2.js';
import { GammaApiClient } from '../../src/clients/gamma-api.js';
import { RateLimiter } from '../../src/core/rate-limiter.js';
import { createUnifiedCache } from '../../src/core/unified-cache.js';
import { OrderStatus } from '../../src/core/types.js';

// ============================================================================
// Configuration
// ============================================================================

const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) {
  console.error('❌ PRIVATE_KEY environment variable is required');
  console.error('');
  console.error('Usage:');
  console.error('  PRIVATE_KEY=0x... npx tsx scripts/ordermanager/bug20-deep-analysis.ts');
  process.exit(1);
}

// Parse command line arguments
const args = process.argv.slice(2);
const getArg = (name: string, defaultValue: string): string => {
  const arg = args.find(a => a.startsWith(`--${name}=`));
  return arg ? arg.split('=')[1] : defaultValue;
};

const SCENARIO_FILTER = getArg('scenario', '');
const TIMEOUT_SECONDS = parseInt(getArg('timeout', '60'), 10);
// Polymarket minimum: $1 order value, 5 shares minimum
// Use $1.5 to have some buffer above the $1 minimum
const AMOUNT_USDC = parseFloat(getArg('amount', '1.5'));

const CLOB_HOST = 'https://clob.polymarket.com';

// ============================================================================
// Types
// ============================================================================

interface RawUserTradePayload {
  timestamp: number;
  scenarioName: string;
  orderId: string;
  payload: Record<string, unknown>;
}

interface ScenarioResult {
  name: string;
  description: string;
  orderId: string | null;
  orderType: string;
  side: 'BUY' | 'SELL';
  price?: number;
  size?: number;
  amount?: number;
  success: boolean;
  error?: string;
  rawTradeEvents: RawUserTradePayload[];
  fills: FillEvent[];
  finalStatus: OrderStatus | null;
  durationMs: number;
  matchedAmountAnalysis: {
    expected: number;
    actual: number;
    wasZero: boolean;
    fallbackApplied: boolean;
  } | null;
}

// ============================================================================
// Helper Functions
// ============================================================================

function formatTimestamp(ts: number): string {
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 23);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function log(message: string): void {
  console.log(`[${formatTimestamp(Date.now())}] ${message}`);
}

// ============================================================================
// Raw WebSocket Event Recorder
// ============================================================================

/**
 * Extended RealtimeService that records raw USER_TRADE payloads
 */
class RawEventRecorder {
  private rawEvents: RawUserTradePayload[] = [];
  private currentScenario: string = '';
  private watchedOrderIds: Set<string> = new Set();

  setCurrentScenario(name: string): void {
    this.currentScenario = name;
  }

  addWatchedOrder(orderId: string): void {
    this.watchedOrderIds.add(orderId);
  }

  removeWatchedOrder(orderId: string): void {
    this.watchedOrderIds.delete(orderId);
  }

  recordRawTradePayload(payload: Record<string, unknown>): void {
    // Check if this trade is for any of our watched orders
    const takerOrderId = payload.taker_order_id as string | undefined;
    const makerOrders = payload.maker_orders as Array<Record<string, unknown>> | undefined;

    let matchedOrderId: string | null = null;

    if (takerOrderId && this.watchedOrderIds.has(takerOrderId)) {
      matchedOrderId = takerOrderId;
    }

    if (!matchedOrderId && makerOrders) {
      for (const maker of makerOrders) {
        const orderId = maker.order_id as string;
        if (orderId && this.watchedOrderIds.has(orderId)) {
          matchedOrderId = orderId;
          break;
        }
      }
    }

    if (matchedOrderId) {
      this.rawEvents.push({
        timestamp: Date.now(),
        scenarioName: this.currentScenario,
        orderId: matchedOrderId,
        payload: { ...payload },
      });

      log(`📦 Raw USER_TRADE captured for order ${matchedOrderId.slice(0, 12)}...`);
      log(`   Payload: ${JSON.stringify(payload, null, 2)}`);
    }
  }

  getEventsForScenario(scenarioName: string): RawUserTradePayload[] {
    return this.rawEvents.filter(e => e.scenarioName === scenarioName);
  }

  getAllEvents(): RawUserTradePayload[] {
    return [...this.rawEvents];
  }

  clear(): void {
    this.rawEvents = [];
  }
}

// ============================================================================
// Main Test Runner
// ============================================================================

async function main() {
  log('🔬 Bug 20 Deep Analysis - WebSocket USER_TRADE matchedAmount Investigation');
  log(`   Scenario filter: ${SCENARIO_FILTER || 'all'}`);
  log(`   Timeout: ${TIMEOUT_SECONDS}s`);
  log(`   Amount per order: $${AMOUNT_USDC}`);
  log('');

  // Initialize services
  const rateLimiter = new RateLimiter();
  const cache = createUnifiedCache();
  const rawRecorder = new RawEventRecorder();

  // Find active market with good liquidity
  log('📊 Finding active market with liquidity...');
  const gammaApi = new GammaApiClient(rateLimiter, cache);
  const trendingMarkets = await gammaApi.getTrendingMarkets(20);

  // Find a 15-minute crypto market (high liquidity, frequent trades)
  let testMarket = trendingMarkets.find(m => {
    const question = m.question.toLowerCase();
    const prices = m.outcomePrices as number[];
    // Look for crypto markets with reasonable prices
    return (question.includes('bitcoin') || question.includes('btc') ||
            question.includes('ethereum') || question.includes('eth') ||
            question.includes('solana') || question.includes('sol')) &&
           question.includes('15') &&
           prices && prices.some(p => p > 0.2 && p < 0.8);
  });

  // Fallback to any market with reasonable prices
  if (!testMarket) {
    testMarket = trendingMarkets.find(m => {
      const prices = m.outcomePrices as number[];
      return prices && prices.some(p => p > 0.2 && p < 0.8);
    }) || trendingMarkets[0];
  }

  if (!testMarket) {
    log('❌ No suitable market found');
    process.exit(1);
  }

  log(`   Selected: ${testMarket.question.slice(0, 70)}...`);
  log(`   Condition ID: ${testMarket.conditionId}`);

  // Get token info from CLOB API
  const wallet = new Wallet(PRIVATE_KEY);
  // V2 SDK: options-bag constructor; `chain` replaces V1 `chainId`.
  const clobClient = new ClobClient({ host: CLOB_HOST, chain: Chain.POLYGON, signer: wallet });
  const clobMarket = await clobClient.getMarket(testMarket.conditionId);

  if (!clobMarket?.tokens || clobMarket.tokens.length < 2) {
    log('❌ Could not get market tokens from CLOB API');
    process.exit(1);
  }

  const tokens = clobMarket.tokens;
  log(`   Tokens: ${tokens[0].outcome}=${tokens[0].price}, ${tokens[1].outcome}=${tokens[1].price}`);

  // Initialize OrderManager with WebSocket
  const orderManager = new OrderManager({
    privateKey: PRIVATE_KEY,
    rateLimiter,
    cache,
    mode: 'hybrid',
    pollingInterval: 2000,
  });

  // Hook into the RealtimeServiceV2 to capture raw events
  // We'll do this by listening to internal events and using debug mode
  const fills: FillEvent[] = [];

  orderManager.on('order_partially_filled', (fill: FillEvent) => {
    fills.push(fill);
    log(`💰 PARTIAL_FILL: size=${fill.fill.size}, price=${fill.fill.price}`);
  });

  orderManager.on('order_filled', (fill: FillEvent) => {
    fills.push(fill);
    log(`✅ FILLED: size=${fill.fill.size}, price=${fill.fill.price}, cumulative=${fill.cumulativeFilled}`);
  });

  await orderManager.start();

  // Create a separate RealtimeService to capture raw events
  const rawWsClient = new RealtimeServiceV2({ autoReconnect: true, debug: false });

  // Wait for connection
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('WebSocket timeout')), 15000);
    rawWsClient.once('connected', () => {
      clearTimeout(timeout);
      resolve();
    });
    rawWsClient.connect();
  });

  // Subscribe to user events with raw recording
  const credentials = {
    apiKey: process.env.POLY_API_KEY || '',
    secret: process.env.POLY_API_SECRET || '',
    passphrase: process.env.POLY_PASSPHRASE || '',
  };

  // Get credentials from the trading service if available
  const tradingCredentials = (orderManager as any).tradingService?.getCredentials?.();
  if (tradingCredentials) {
    credentials.apiKey = tradingCredentials.key;
    credentials.secret = tradingCredentials.secret;
    credentials.passphrase = tradingCredentials.passphrase;
  }

  // Hook into the raw websocket client's internal handling
  // We need to intercept the raw payload before it's parsed
  const originalEmit = rawWsClient.emit.bind(rawWsClient);
  (rawWsClient as any).emit = function(event: string, ...args: any[]) {
    if (event === 'userTrade') {
      // This is already parsed, we need the raw payload
      // Let's record the parsed version for now
      const trade = args[0] as UserTrade;
      log(`🔍 Raw WebSocket USER_TRADE received:`);
      log(`   tradeId: ${trade.tradeId}`);
      log(`   takerOrderId: ${trade.takerOrderId || 'N/A'}`);
      log(`   size: ${trade.size}`);
      log(`   price: ${trade.price}`);
      log(`   status: ${trade.status}`);
      log(`   makerOrders: ${JSON.stringify(trade.makerOrders)}`);

      // Record for analysis
      if (trade.makerOrders) {
        for (const maker of trade.makerOrders) {
          log(`   └─ Maker ${maker.orderId.slice(0, 12)}...: matchedAmount=${maker.matchedAmount}, price=${maker.price}`);
        }
      }
    }
    return originalEmit(event, ...args);
  };

  await new Promise(resolve => setTimeout(resolve, 1000));

  rawWsClient.subscribeUserEvents(credentials, {
    onTrade: (trade: UserTrade) => {
      // Capture raw trade for the current scenario
      const payload: Record<string, unknown> = {
        trade_id: trade.tradeId,
        taker_order_id: trade.takerOrderId,
        size: trade.size,
        price: trade.price,
        status: trade.status,
        side: trade.side,
        market: trade.market,
        outcome: trade.outcome,
        transaction_hash: trade.transactionHash,
        maker_orders: trade.makerOrders?.map(m => ({
          order_id: m.orderId,
          matched_size: m.matchedAmount,
          price: m.price,
        })),
      };
      rawRecorder.recordRawTradePayload(payload);
    },
    onOrder: () => {},
  });

  await new Promise(resolve => setTimeout(resolve, 2000));
  log('');

  // ============================================================================
  // Test Scenarios
  // ============================================================================

  const results: ScenarioResult[] = [];

  // Helper to run a scenario
  async function runScenario(
    name: string,
    description: string,
    orderFn: () => Promise<{ orderId: string | null; orderType: string; side: 'BUY' | 'SELL'; price?: number; size?: number; amount?: number }>
  ): Promise<ScenarioResult> {
    if (SCENARIO_FILTER && SCENARIO_FILTER !== name) {
      log(`⏭️  Skipping scenario: ${name}`);
      return {
        name,
        description,
        orderId: null,
        orderType: 'SKIPPED',
        side: 'BUY',
        success: true,
        rawTradeEvents: [],
        fills: [],
        finalStatus: null,
        durationMs: 0,
        matchedAmountAnalysis: null,
      };
    }

    log(`\n${'='.repeat(70)}`);
    log(`🧪 Scenario: ${name}`);
    log(`   ${description}`);
    log('='.repeat(70));

    rawRecorder.setCurrentScenario(name);
    fills.length = 0;
    const startTime = Date.now();

    try {
      const orderInfo = await orderFn();

      if (!orderInfo.orderId) {
        return {
          name,
          description,
          ...orderInfo,
          success: false,
          error: 'Order creation failed',
          rawTradeEvents: [],
          fills: [],
          finalStatus: null,
          durationMs: Date.now() - startTime,
          matchedAmountAnalysis: null,
        };
      }

      rawRecorder.addWatchedOrder(orderInfo.orderId);
      log(`   Order ID: ${orderInfo.orderId}`);

      // Wait for order to complete or timeout
      const maxWait = TIMEOUT_SECONDS * 1000;
      const waitStart = Date.now();
      let finalStatus: OrderStatus | null = null;

      while (Date.now() - waitStart < maxWait) {
        const order = await orderManager.getOrder(orderInfo.orderId);
        if (order) {
          if (order.status === OrderStatus.FILLED ||
              order.status === OrderStatus.CANCELLED ||
              order.status === OrderStatus.EXPIRED) {
            finalStatus = order.status;
            log(`   Final status: ${finalStatus}`);
            log(`   Filled: ${order.filledSize} / ${order.originalSize}`);
            break;
          }
        }
        await sleep(1000);
        process.stdout.write('.');
      }
      console.log('');

      if (!finalStatus) {
        // Order still pending, cancel it
        log('   ⏰ Timeout - cancelling order...');
        await orderManager.cancelOrder(orderInfo.orderId);
        finalStatus = OrderStatus.CANCELLED;
      }

      rawRecorder.removeWatchedOrder(orderInfo.orderId);

      // Analyze matchedAmount from raw events
      const scenarioEvents = rawRecorder.getEventsForScenario(name);
      let matchedAmountAnalysis: ScenarioResult['matchedAmountAnalysis'] = null;

      if (scenarioEvents.length > 0) {
        const lastEvent = scenarioEvents[scenarioEvents.length - 1];
        const makerOrders = lastEvent.payload.maker_orders as Array<Record<string, unknown>> | undefined;

        if (makerOrders && makerOrders.length > 0) {
          const ourMaker = makerOrders.find(m => m.order_id === orderInfo.orderId);
          if (ourMaker) {
            const rawMatchedSize = ourMaker.matched_size as number;
            const tradeSize = lastEvent.payload.size as number;

            matchedAmountAnalysis = {
              expected: tradeSize,
              actual: rawMatchedSize,
              wasZero: rawMatchedSize === 0,
              fallbackApplied: rawMatchedSize === 0 && fills.length > 0 && fills[0].fill.size === tradeSize,
            };
          }
        }
      }

      return {
        name,
        description,
        ...orderInfo,
        success: true,
        rawTradeEvents: scenarioEvents,
        fills: [...fills],
        finalStatus,
        durationMs: Date.now() - startTime,
        matchedAmountAnalysis,
      };

    } catch (error) {
      rawRecorder.removeWatchedOrder('');
      return {
        name,
        description,
        orderId: null,
        orderType: 'ERROR',
        side: 'BUY',
        success: false,
        error: error instanceof Error ? error.message : String(error),
        rawTradeEvents: [],
        fills: [],
        finalStatus: null,
        durationMs: Date.now() - startTime,
        matchedAmountAnalysis: null,
      };
    }
  }

  // ========================================================================
  // Scenario 1: Maker Limit Order (Passive)
  // ========================================================================
  const makerResult = await runScenario(
    'maker-limit',
    'Low-priced BUY limit order that sits in orderbook waiting to be taken',
    async () => {
      const token = tokens[0]; // Use first token (usually Yes)
      const currentPrice = parseFloat(token.price);

      // Place order 0.03 below current price to be a maker
      const makerPrice = Math.max(0.01, currentPrice - 0.03);
      const roundedPrice = Math.round(makerPrice * 100) / 100;
      const size = Math.ceil(AMOUNT_USDC / roundedPrice);

      log(`   Creating maker order: BUY ${size} @ ${roundedPrice} (current: ${currentPrice})`);

      const result = await orderManager.createOrder({
        tokenId: token.token_id,
        side: 'BUY',
        price: roundedPrice,
        size,
        orderType: 'GTC',
      });

      return {
        orderId: result.orderId || null,
        orderType: 'GTC (maker)',
        side: 'BUY' as const,
        price: roundedPrice,
        size,
      };
    }
  );
  results.push(makerResult);

  // ========================================================================
  // Scenario 2: Taker Limit Order (Aggressive)
  // ========================================================================
  const takerResult = await runScenario(
    'taker-limit',
    'High-priced BUY limit order that crosses the spread and fills immediately',
    async () => {
      const token = tokens[0];
      const currentPrice = parseFloat(token.price);

      // Place order 0.02 above current price to be a taker
      const takerPrice = Math.min(0.99, currentPrice + 0.02);
      const roundedPrice = Math.round(takerPrice * 100) / 100;
      const size = Math.ceil(AMOUNT_USDC / roundedPrice);

      log(`   Creating taker order: BUY ${size} @ ${roundedPrice} (current: ${currentPrice})`);

      const result = await orderManager.createOrder({
        tokenId: token.token_id,
        side: 'BUY',
        price: roundedPrice,
        size,
        orderType: 'GTC',
      });

      return {
        orderId: result.orderId || null,
        orderType: 'GTC (taker)',
        side: 'BUY' as const,
        price: roundedPrice,
        size,
      };
    }
  );
  results.push(takerResult);

  // ========================================================================
  // Scenario 3: Market Order FOK
  // ========================================================================
  const fokResult = await runScenario(
    'market-fok',
    'Fill Or Kill market order - must fill completely or cancel',
    async () => {
      const token = tokens[0];

      log(`   Creating FOK market order: BUY $${AMOUNT_USDC}`);

      const result = await orderManager.createMarketOrder({
        tokenId: token.token_id,
        side: 'BUY',
        amount: AMOUNT_USDC,
        orderType: 'FOK',
      });

      return {
        orderId: result.orderId || null,
        orderType: 'FOK',
        side: 'BUY' as const,
        amount: AMOUNT_USDC,
      };
    }
  );
  results.push(fokResult);

  // ========================================================================
  // Scenario 4: Market Order FAK
  // ========================================================================
  const fakResult = await runScenario(
    'market-fak',
    'Fill And Kill market order - fills what it can, cancels the rest',
    async () => {
      const token = tokens[0];

      log(`   Creating FAK market order: BUY $${AMOUNT_USDC}`);

      const result = await orderManager.createMarketOrder({
        tokenId: token.token_id,
        side: 'BUY',
        amount: AMOUNT_USDC,
        orderType: 'FAK',
      });

      return {
        orderId: result.orderId || null,
        orderType: 'FAK',
        side: 'BUY' as const,
        amount: AMOUNT_USDC,
      };
    }
  );
  results.push(fakResult);

  // ========================================================================
  // Cleanup
  // ========================================================================
  log('\n🧹 Cleaning up...');
  orderManager.stop();
  rawWsClient.disconnect();

  // ========================================================================
  // Generate Report
  // ========================================================================
  log('\n' + '='.repeat(70));
  log('📋 BUG 20 ANALYSIS REPORT');
  log('='.repeat(70));

  const report: string[] = [];
  report.push('# Bug 20 Deep Analysis Report');
  report.push('');
  report.push(`Generated: ${new Date().toISOString()}`);
  report.push(`Market: ${testMarket.question.slice(0, 60)}...`);
  report.push(`Condition ID: ${testMarket.conditionId}`);
  report.push('');
  report.push('## Summary');
  report.push('');
  report.push('| Scenario | Status | matchedAmount=0? | Fallback Applied? | Fill Size |');
  report.push('|----------|--------|----------------|-------------------|-----------|');

  for (const result of results) {
    const status = result.success ? (result.finalStatus || 'N/A') : 'ERROR';
    const wasZero = result.matchedAmountAnalysis?.wasZero ? '⚠️ YES' : 'No';
    const fallback = result.matchedAmountAnalysis?.fallbackApplied ? '✅ Yes' : 'No';
    const fillSize = result.fills.length > 0 ? result.fills[0].fill.size.toString() : '-';

    report.push(`| ${result.name} | ${status} | ${wasZero} | ${fallback} | ${fillSize} |`);

    log(`\n📊 ${result.name}:`);
    log(`   Status: ${status}`);
    log(`   Duration: ${result.durationMs}ms`);

    if (result.matchedAmountAnalysis) {
      log(`   matchedAmount Analysis:`);
      log(`     - Expected: ${result.matchedAmountAnalysis.expected}`);
      log(`     - Actual: ${result.matchedAmountAnalysis.actual}`);
      log(`     - Was Zero: ${result.matchedAmountAnalysis.wasZero}`);
      log(`     - Fallback Applied: ${result.matchedAmountAnalysis.fallbackApplied}`);
    }

    if (result.rawTradeEvents.length > 0) {
      log(`   Raw Events: ${result.rawTradeEvents.length}`);
    }

    if (result.error) {
      log(`   Error: ${result.error}`);
    }
  }

  report.push('');
  report.push('## Detailed Raw Events');
  report.push('');

  for (const result of results) {
    if (result.rawTradeEvents.length > 0) {
      report.push(`### ${result.name}`);
      report.push('');
      report.push('```json');
      for (const event of result.rawTradeEvents) {
        report.push(JSON.stringify(event.payload, null, 2));
      }
      report.push('```');
      report.push('');
    }
  }

  report.push('## Bug 20 Analysis');
  report.push('');

  const bug20Occurrences = results.filter(r => r.matchedAmountAnalysis?.wasZero);
  if (bug20Occurrences.length > 0) {
    report.push('### ⚠️ Bug 20 Detected!');
    report.push('');
    report.push(`Found ${bug20Occurrences.length} scenario(s) where matchedAmount was 0:`);
    report.push('');
    for (const r of bug20Occurrences) {
      report.push(`- **${r.name}**: matchedAmount=0, expected=${r.matchedAmountAnalysis?.expected}`);
      report.push(`  - Fallback ${r.matchedAmountAnalysis?.fallbackApplied ? 'was applied successfully' : 'was NOT applied'}`);
    }
    report.push('');
    report.push('### Root Cause Hypothesis');
    report.push('');
    report.push('The Polymarket WebSocket API sometimes returns `matched_size: 0` for maker orders,');
    report.push('even when the trade has a non-zero size. This appears to happen when:');
    report.push('');
    report.push('1. The order is matched as a **maker** (passive fill)');
    report.push('2. The trade involves multiple maker orders in a single match');
    report.push('');
  } else {
    report.push('### ✅ No Bug 20 Occurrences');
    report.push('');
    report.push('All scenarios had correct matchedAmount values.');
    report.push('');
  }

  report.push('## Recommendations');
  report.push('');
  report.push('1. The fallback logic in `OrderManager.handleUserTrade` should remain in place');
  report.push('2. When `matchedAmount === 0` for a maker order, use `userTrade.size` as fallback');
  report.push('3. Log a warning when fallback is applied for monitoring purposes');
  report.push('4. Consider syncing with chain state periodically to detect drift');

  // Save report
  const reportPath = path.join(process.cwd(), 'scripts/ordermanager/bug20-report.md');
  fs.writeFileSync(reportPath, report.join('\n'));
  log(`\n📄 Report saved to: ${reportPath}`);

  // Final summary
  log('\n' + '='.repeat(70));
  const allPassed = results.every(r => r.success || r.orderType === 'SKIPPED');
  log(allPassed ? '✅ All scenarios completed successfully' : '❌ Some scenarios failed');

  process.exit(allPassed ? 0 : 1);
}

main().catch(error => {
  console.error('\n❌ Fatal error:', error);
  process.exit(1);
});
