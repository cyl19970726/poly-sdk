#!/usr/bin/env npx tsx
/**
 * E2E Test: Market Order (FOK/FAK) Lifecycle
 *
 * This script tests real market orders on Polymarket to verify:
 * 1. FOK order creation and lifecycle (PENDING → FILLED or PENDING → CANCELLED)
 * 2. FAK order creation and lifecycle (partial fills + cancellation)
 * 3. WebSocket event monitoring during order lifecycle
 *
 * IMPORTANT: This uses real money! Use small amounts for testing.
 *
 * Usage:
 *   PRIVATE_KEY=0x... npx tsx scripts/ordermanager/test-market-order-lifecycle.ts
 *
 * Or with specific test:
 *   PRIVATE_KEY=0x... npx tsx scripts/ordermanager/test-market-order-lifecycle.ts --fok-only
 *   PRIVATE_KEY=0x... npx tsx scripts/ordermanager/test-market-order-lifecycle.ts --fak-only
 */

import { ClobClient, Chain } from '@polymarket/clob-client';
import { Wallet } from 'ethers';
import { OrderManager } from '../../src/services/order-manager.js';
import { GammaApiClient } from '../../src/clients/gamma-api.js';
import { RateLimiter } from '../../src/core/rate-limiter.js';
import { createUnifiedCache } from '../../src/core/unified-cache.js';
import { OrderStatus } from '../../src/core/types.js';
import type { FillEvent } from '../../src/services/order-manager.js';

// ============================================================================
// Configuration
// ============================================================================

const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) {
  console.error('❌ PRIVATE_KEY environment variable is required');
  process.exit(1);
}

// Test amount in USDC - keep small!
const TEST_AMOUNT_USDC = 1.5; // $1.5 minimum to meet $1 requirement

const CLOB_HOST = 'https://clob.polymarket.com';

// ============================================================================
// Helper Functions
// ============================================================================

function formatTimestamp(ts: number): string {
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 23);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================================
// Test Runner
// ============================================================================

interface TestResult {
  name: string;
  success: boolean;
  events: string[];
  duration: number;
  error?: string;
}

async function runTest(
  name: string,
  testFn: () => Promise<void>
): Promise<TestResult> {
  const startTime = Date.now();
  const events: string[] = [];

  console.log(`\n${'='.repeat(60)}`);
  console.log(`🧪 Test: ${name}`);
  console.log('='.repeat(60));

  try {
    await testFn();
    return {
      name,
      success: true,
      events,
      duration: Date.now() - startTime,
    };
  } catch (error) {
    return {
      name,
      success: false,
      events,
      duration: Date.now() - startTime,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ============================================================================
// Main Test
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  const fokOnly = args.includes('--fok-only');
  const fakOnly = args.includes('--fak-only');

  console.log('🚀 Market Order Lifecycle E2E Test');
  console.log(`   Test amount: $${TEST_AMOUNT_USDC}`);
  console.log(`   FOK only: ${fokOnly}`);
  console.log(`   FAK only: ${fakOnly}`);

  // Initialize services
  const rateLimiter = new RateLimiter({
    requestsPerSecond: 5,
    requestsPerMinute: 100,
  });
  const cache = createUnifiedCache({ maxSize: 1000, ttl: 30000 });

  // Use GammaApiClient to find trending markets
  const gammaApi = new GammaApiClient(rateLimiter, cache);

  // Find an active market with good liquidity
  console.log('\n📊 Finding active market...');
  const trendingMarkets = await gammaApi.getTrendingMarkets(10);

  if (trendingMarkets.length === 0) {
    console.error('❌ No active markets found');
    process.exit(1);
  }

  // Find a market with reasonable prices (not too close to 0 or 1)
  // GammaApiClient already parses the arrays
  const testMarket = trendingMarkets.find(m => {
    const prices = m.outcomePrices as number[];
    return prices && prices.some(p => p > 0.1 && p < 0.9);
  }) || trendingMarkets[0];

  console.log(`   Selected: ${testMarket.question.slice(0, 60)}...`);
  console.log(`   Condition ID: ${testMarket.conditionId}`);

  // Use CLOB API to get token IDs (they're not in Gamma API response)
  const wallet = new Wallet(PRIVATE_KEY);
  const clobClient = new ClobClient(CLOB_HOST, Chain.POLYGON, wallet);

  console.log('   Fetching market details from CLOB API...');
  const clobMarket = await clobClient.getMarket(testMarket.conditionId);

  if (!clobMarket || !clobMarket.tokens || clobMarket.tokens.length < 2) {
    console.error('❌ Could not get market tokens from CLOB API');
    process.exit(1);
  }

  const tokens = clobMarket.tokens;
  console.log(`   Tokens: ${tokens[0].outcome}=${tokens[0].price}, ${tokens[1].outcome}=${tokens[1].price}`);

  // Choose the cheaper token (more shares per dollar)
  const cheaperToken = tokens[0].price < tokens[1].price ? tokens[0] : tokens[1];
  const cheaperTokenId = cheaperToken.token_id;
  const cheaperOutcome = cheaperToken.outcome;
  const cheaperPrice = cheaperToken.price;

  console.log(`   Testing with: ${cheaperOutcome} @ ${cheaperPrice}`);

  // Initialize OrderManager
  const orderManager = new OrderManager({
    privateKey: PRIVATE_KEY,
    rateLimiter,
    cache,
    mode: 'hybrid', // Use both WebSocket and polling
    pollingInterval: 1000,
  });

  await orderManager.start();

  // Setup event listeners
  const allEvents: Array<{ type: string; data: any; timestamp: number }> = [];

  orderManager.on('order_created', (order) => {
    const event = { type: 'order_created', data: order, timestamp: Date.now() };
    allEvents.push(event);
    console.log(`   📝 [${formatTimestamp(event.timestamp)}] ORDER_CREATED: ${order.id}`);
    console.log(`      Type: ${(order as any).orderType || 'N/A'}, Status: ${order.status}`);
  });

  orderManager.on('status_change', (change) => {
    const event = { type: 'status_change', data: change, timestamp: Date.now() };
    allEvents.push(event);
    console.log(`   🔄 [${formatTimestamp(event.timestamp)}] STATUS_CHANGE: ${change.from} → ${change.to}`);
  });

  orderManager.on('order_partially_filled', (fill: FillEvent) => {
    const event = { type: 'order_partially_filled', data: fill, timestamp: Date.now() };
    allEvents.push(event);
    console.log(`   💰 [${formatTimestamp(event.timestamp)}] PARTIAL_FILL: ${fill.fill.size} @ ${fill.fill.price}`);
    console.log(`      Cumulative: ${fill.cumulativeFilled}, Remaining: ${fill.remainingSize}`);
  });

  orderManager.on('order_filled', (fill: FillEvent) => {
    const event = { type: 'order_filled', data: fill, timestamp: Date.now() };
    allEvents.push(event);
    console.log(`   ✅ [${formatTimestamp(event.timestamp)}] FILLED: ${fill.fill.size} @ ${fill.fill.price}`);
    console.log(`      Total filled: ${fill.cumulativeFilled}`);
  });

  orderManager.on('order_cancelled', (cancel) => {
    const event = { type: 'order_cancelled', data: cancel, timestamp: Date.now() };
    allEvents.push(event);
    console.log(`   ❌ [${formatTimestamp(event.timestamp)}] CANCELLED`);
    console.log(`      Filled: ${cancel.filledSize}, Cancelled: ${cancel.cancelledSize}`);
  });

  orderManager.on('order_rejected', (reject) => {
    const event = { type: 'order_rejected', data: reject, timestamp: Date.now() };
    allEvents.push(event);
    console.log(`   ⛔ [${formatTimestamp(event.timestamp)}] REJECTED: ${reject.reason}`);
  });

  const results: TestResult[] = [];

  try {
    // ========================================================================
    // Test 1: FOK Order
    // ========================================================================
    if (!fakOnly) {
      const fokResult = await runTest('FOK Market Order', async () => {
        console.log('\n   Creating FOK order...');
        allEvents.length = 0; // Clear events

        const result = await orderManager.createMarketOrder({
          tokenId: cheaperTokenId,
          side: 'BUY',
          amount: TEST_AMOUNT_USDC,
          orderType: 'FOK',
        });

        if (!result.success) {
          throw new Error(`Order creation failed: ${result.errorMsg}`);
        }

        console.log(`   Order ID: ${result.orderId}`);
        console.log('   Waiting for order lifecycle...');

        // Wait for order to complete (FOK should be fast)
        const startWait = Date.now();
        const maxWait = 30000; // 30 seconds max

        while (Date.now() - startWait < maxWait) {
          const order = await orderManager.getOrder(result.orderId!);
          if (order && (order.status === OrderStatus.FILLED || order.status === OrderStatus.CANCELLED)) {
            console.log(`   Final status: ${order.status}`);
            console.log(`   Filled: ${order.filledSize} / ${order.originalSize}`);
            break;
          }
          await sleep(500);
        }

        // Summary
        console.log(`\n   📊 Events received: ${allEvents.length}`);
        for (const e of allEvents) {
          console.log(`      - ${e.type}`);
        }
      });
      results.push(fokResult);
    }

    // ========================================================================
    // Test 2: FAK Order
    // ========================================================================
    if (!fokOnly) {
      const fakResult = await runTest('FAK Market Order', async () => {
        console.log('\n   Creating FAK order...');
        allEvents.length = 0;

        const result = await orderManager.createMarketOrder({
          tokenId: cheaperTokenId,
          side: 'BUY',
          amount: TEST_AMOUNT_USDC,
          orderType: 'FAK',
        });

        if (!result.success) {
          throw new Error(`Order creation failed: ${result.errorMsg}`);
        }

        console.log(`   Order ID: ${result.orderId}`);
        console.log('   Waiting for order lifecycle...');

        // Wait for order to complete
        const startWait = Date.now();
        const maxWait = 30000;

        while (Date.now() - startWait < maxWait) {
          const order = await orderManager.getOrder(result.orderId!);
          if (order && (order.status === OrderStatus.FILLED || order.status === OrderStatus.CANCELLED)) {
            console.log(`   Final status: ${order.status}`);
            console.log(`   Filled: ${order.filledSize} / ${order.originalSize}`);
            break;
          }
          await sleep(500);
        }

        // Summary
        console.log(`\n   📊 Events received: ${allEvents.length}`);
        for (const e of allEvents) {
          console.log(`      - ${e.type}`);
        }
      });
      results.push(fakResult);
    }

  } finally {
    // Cleanup
    console.log('\n🧹 Cleaning up...');
    orderManager.stop();
  }

  // ========================================================================
  // Summary
  // ========================================================================
  console.log('\n' + '='.repeat(60));
  console.log('📋 TEST SUMMARY');
  console.log('='.repeat(60));

  let allPassed = true;
  for (const result of results) {
    const status = result.success ? '✅' : '❌';
    console.log(`${status} ${result.name} (${result.duration}ms)`);
    if (!result.success) {
      console.log(`   Error: ${result.error}`);
      allPassed = false;
    }
  }

  console.log('\n' + (allPassed ? '✅ All tests passed!' : '❌ Some tests failed'));
  process.exit(allPassed ? 0 : 1);
}

main().catch(console.error);
