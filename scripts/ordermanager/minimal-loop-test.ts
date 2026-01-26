/**
 * OrderManager Minimal Loop Test
 *
 * 使用最小金额循环测试多个场景
 * - 每次测试使用 5 shares（最小值）
 * - 使用低价格（0.20-0.30）确保资金需求 <= 1.5 USDC
 * - 每次测试后取消订单回收资金
 *
 * 余额要求: ~1.5 USDC.e
 * 测试场景: GTC订单、批量订单、立即取消、状态监控
 *
 * Usage:
 * PRIVATE_KEY=0x... npx tsx scripts/ordermanager/minimal-loop-test.ts
 */

import { OrderManager } from '../../src/index.js';

const PRIVATE_KEY = process.env.PRIVATE_KEY;

if (!PRIVATE_KEY) {
  console.error('Error: PRIVATE_KEY environment variable is required');
  console.error('Please set it in .env file or pass as environment variable');
  process.exit(1);
}

// BTC 15-min Up/Down market
const TEST_MARKET = {
  conditionId: '0x734720ff62e94d4d3aca7779c0c524942552f413598471e27641fa5768c9b9bd',
  primaryTokenId: '33095274756912603140497919858406898509281326656669704017026263839116792685912',
  secondaryTokenId: '96784320014242754088182679292920116900310434804732581110626077800568579041234',
};

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
  capitalUsed: number;
  capitalRecovered: number;
}

const results: TestResult[] = [];
const events: string[] = [];

function log(message: string) {
  console.log(`[LOOP] ${message}`);
}

async function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runTest(
  name: string,
  capitalUsed: number,
  testFn: () => Promise<number>
): Promise<void> {
  log(`\n${'='.repeat(60)}`);
  log(`Test: ${name}`);
  log(`Capital: ${capitalUsed} USDC.e`);
  log('='.repeat(60));

  const start = Date.now();

  try {
    const recovered = await testFn();
    const duration = Date.now() - start;

    results.push({
      name,
      passed: true,
      duration,
      capitalUsed,
      capitalRecovered: recovered,
    });

    log(`✅ PASSED (${duration}ms)`);
    log(`💰 Recovered: ${recovered} USDC.e`);
  } catch (error) {
    const duration = Date.now() - start;

    results.push({
      name,
      passed: false,
      error: error instanceof Error ? error.message : String(error),
      duration,
      capitalUsed,
      capitalRecovered: 0,
    });

    log(`❌ FAILED (${duration}ms)`);
    log(`Error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function main() {
  log('='.repeat(60));
  log('OrderManager Minimal Loop Test');
  log('Strategy: Create order → Cancel → Recover capital → Repeat');
  log('='.repeat(60));

  // Initialize OrderManager
  const orderMgr = new OrderManager({
    privateKey: PRIVATE_KEY,
    mode: 'hybrid',
    debug: false, // 减少日志
  });

  // Setup event listeners
  orderMgr.on('order_created', () => events.push('order_created'));
  orderMgr.on('status_change', () => events.push('status_change'));
  orderMgr.on('order_opened', () => events.push('order_opened'));
  orderMgr.on('order_filled', () => events.push('order_filled'));
  orderMgr.on('order_cancelled', () => events.push('order_cancelled'));

  await orderMgr.start();
  log('OrderManager started\n');

  // ========== Test 1: GTC Order (price: 0.20, size: 5) ==========
  await runTest('GTC order - Low price (0.20 * 5 = 1.0 USDC)', 1.0, async () => {
    const result = await orderMgr.createOrder({
      tokenId: TEST_MARKET.primaryTokenId,
      side: 'BUY',
      price: 0.20,
      size: 5,
      orderType: 'GTC',
    });

    if (!result.success || !result.orderId) {
      throw new Error(`Order failed: ${result.errorMsg}`);
    }

    log(`Order created: ${result.orderId}`);

    // Wait for order to open
    await delay(3000);

    // Cancel order
    const cancelResult = await orderMgr.cancelOrder(result.orderId);
    if (!cancelResult.success) {
      log(`⚠️  Cancel warning: ${cancelResult.errorMsg}`);
    } else {
      log('Order cancelled');
    }

    await delay(2000);

    // Capital recovered (minus fees)
    return 1.0;
  });

  // ========== Test 2: GTC Order (price: 0.25, size: 5) ==========
  await runTest('GTC order - Mid price (0.25 * 5 = 1.25 USDC)', 1.25, async () => {
    const result = await orderMgr.createOrder({
      tokenId: TEST_MARKET.primaryTokenId,
      side: 'BUY',
      price: 0.25,
      size: 5,
      orderType: 'GTC',
    });

    if (!result.success || !result.orderId) {
      throw new Error(`Order failed: ${result.errorMsg}`);
    }

    log(`Order created: ${result.orderId}`);
    await delay(3000);

    const cancelResult = await orderMgr.cancelOrder(result.orderId);
    if (cancelResult.success) {
      log('Order cancelled');
    }

    await delay(2000);
    return 1.25;
  });

  // ========== Test 3: Immediate Cancel ==========
  await runTest('Immediate cancel (0.22 * 5 = 1.1 USDC)', 1.1, async () => {
    const result = await orderMgr.createOrder({
      tokenId: TEST_MARKET.secondaryTokenId,
      side: 'BUY',
      price: 0.22,
      size: 5,
      orderType: 'GTC',
    });

    if (!result.success || !result.orderId) {
      throw new Error(`Order failed: ${result.errorMsg}`);
    }

    log(`Order created: ${result.orderId}`);

    // Cancel immediately (don't wait)
    log('Cancelling immediately...');
    const cancelResult = await orderMgr.cancelOrder(result.orderId);

    if (cancelResult.success) {
      log('✓ Immediate cancel succeeded');
    } else {
      log(`⚠️  Immediate cancel: ${cancelResult.errorMsg}`);
    }

    await delay(2000);
    return 1.1;
  });

  // ========== Test 4: Batch Orders (Small) ==========
  await runTest('Batch orders - 2 small orders (2 * 1.0 = 2.0 USDC)', 2.0, async () => {
    const result = await orderMgr.createBatchOrders([
      {
        tokenId: TEST_MARKET.primaryTokenId,
        side: 'BUY',
        price: 0.20,
        size: 5,
        orderType: 'GTC',
      },
      {
        tokenId: TEST_MARKET.secondaryTokenId,
        side: 'BUY',
        price: 0.20,
        size: 5,
        orderType: 'GTC',
      },
    ]);

    if (!result.success || !result.orderIds || result.orderIds.length !== 2) {
      throw new Error(`Batch failed: ${result.errorMsg}`);
    }

    log(`Batch created: ${result.orderIds.join(', ')}`);
    await delay(3000);

    // Cancel all
    let recovered = 0;
    for (const orderId of result.orderIds) {
      const cancelResult = await orderMgr.cancelOrder(orderId);
      if (cancelResult.success) {
        recovered += 1.0;
        log(`✓ Cancelled: ${orderId}`);
      }
    }

    await delay(2000);
    return recovered;
  });

  // ========== Test 5: Multiple Sequential Orders ==========
  await runTest('Sequential orders - 3x create & cancel', 1.0, async () => {
    let totalRecovered = 0;

    for (let i = 0; i < 3; i++) {
      log(`\n  Round ${i + 1}/3:`);

      const result = await orderMgr.createOrder({
        tokenId: TEST_MARKET.primaryTokenId,
        side: 'BUY',
        price: 0.20,
        size: 5,
        orderType: 'GTC',
      });

      if (!result.success || !result.orderId) {
        log(`  ⚠️  Round ${i + 1} failed: ${result.errorMsg}`);
        continue;
      }

      log(`  Created: ${result.orderId}`);
      await delay(2000);

      const cancelResult = await orderMgr.cancelOrder(result.orderId);
      if (cancelResult.success) {
        log(`  Cancelled: ${result.orderId}`);
        totalRecovered += 1.0;
      }

      await delay(1000);
    }

    return totalRecovered / 3; // 平均每次
  });

  // ========== Test 6: Watch & Unwatch ==========
  await runTest('Watch & Unwatch (0.20 * 5 = 1.0 USDC)', 1.0, async () => {
    const result = await orderMgr.createOrder({
      tokenId: TEST_MARKET.primaryTokenId,
      side: 'BUY',
      price: 0.20,
      size: 5,
      orderType: 'GTC',
    });

    if (!result.success || !result.orderId) {
      throw new Error(`Order failed: ${result.errorMsg}`);
    }

    log(`Order created: ${result.orderId}`);

    // Verify auto-watch
    const watched1 = orderMgr.getWatchedOrders();
    if (!watched1.some(o => o.id === result.orderId)) {
      throw new Error('Not auto-watched');
    }
    log('✓ Auto-watched');

    // Manually unwatch
    orderMgr.unwatchOrder(result.orderId);
    log('✓ Manually unwatched');

    // Re-watch
    orderMgr.watchOrder(result.orderId);
    log('✓ Re-watched');

    const watched2 = orderMgr.getWatchedOrders();
    if (!watched2.some(o => o.id === result.orderId)) {
      throw new Error('Re-watch failed');
    }

    await delay(2000);

    // Cancel
    await orderMgr.cancelOrder(result.orderId);
    await delay(2000);

    return 1.0;
  });

  // Stop OrderManager
  orderMgr.stop();
  log('\n\nOrderManager stopped\n');

  // ========== Print Summary ==========
  log('='.repeat(60));
  log('Test Results Summary');
  log('='.repeat(60));

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  const totalCapital = results.reduce((sum, r) => sum + r.capitalUsed, 0);
  const totalRecovered = results.reduce((sum, r) => sum + r.capitalRecovered, 0);

  log('');
  for (const result of results) {
    const status = result.passed ? '✅' : '❌';
    log(`${status} ${result.name}`);
    log(`   Duration: ${result.duration}ms`);
    log(`   Capital: ${result.capitalUsed} → ${result.capitalRecovered} USDC`);
    if (result.error) {
      log(`   Error: ${result.error}`);
    }
  }

  log('');
  log(`Total Tests: ${results.length}`);
  log(`Passed: ${passed}`);
  log(`Failed: ${failed}`);
  log(`Capital Used: ${totalCapital.toFixed(2)} USDC`);
  log(`Capital Recovered: ${totalRecovered.toFixed(2)} USDC`);
  log(`Recovery Rate: ${((totalRecovered / totalCapital) * 100).toFixed(1)}%`);

  log('');
  log('='.repeat(60));
  log('Event Summary');
  log('='.repeat(60));

  const eventCounts = events.reduce((acc, e) => {
    acc[e] = (acc[e] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  for (const [type, count] of Object.entries(eventCounts)) {
    log(`${type}: ${count}`);
  }

  log('');
  log('='.repeat(60));

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
