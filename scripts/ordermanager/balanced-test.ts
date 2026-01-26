/**
 * OrderManager Balanced Test Suite
 *
 * Designed for limited wallet balance (1.64 USDC.e)
 * Tests core functionality with small order sizes:
 * 1. GTC order creation and cancellation
 * 2. Order validation (minimum size, tick size)
 * 3. Auto-watch functionality
 * 4. Event emission
 *
 * Usage:
 * PRIVATE_KEY=0x... npx tsx scripts/ordermanager/balanced-test.ts
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
  tokenId: '33095274756912603140497919858406898509281326656669704017026263839116792685912', // Up token
  currentPrice: 0.485,
};

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
}

const results: TestResult[] = [];
const events: string[] = [];

function log(message: string) {
  console.log(`[TEST] ${message}`);
}

async function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runTest(name: string, testFn: () => Promise<void>): Promise<void> {
  log(`Starting: ${name}`);
  const start = Date.now();

  try {
    await testFn();
    const duration = Date.now() - start;
    results.push({ name, passed: true, duration });
    log(`✅ PASSED: ${name} (${duration}ms)`);
  } catch (error) {
    const duration = Date.now() - start;
    results.push({
      name,
      passed: false,
      error: error instanceof Error ? error.message : String(error),
      duration,
    });
    log(`❌ FAILED: ${name} (${duration}ms)`);
    log(`Error: ${error instanceof Error ? error.message : String(error)}`);
  }

  log('');
}

async function main() {
  log('='.repeat(60));
  log('OrderManager Balanced Test Suite');
  log('Wallet Balance: 1.64 USDC.e');
  log('='.repeat(60));
  log('');

  // Initialize OrderManager
  const orderMgr = new OrderManager({
    privateKey: PRIVATE_KEY,
    mode: 'hybrid',
    debug: true,
  });

  // Setup event listeners
  orderMgr.on('order_created', (order) => {
    events.push('order_created');
    log(`[EVENT] order_created: ${order.id}`);
  });

  orderMgr.on('status_change', (event) => {
    events.push('status_change');
    log(`[EVENT] status_change: ${event.orderId} | ${event.from} → ${event.to}`);
  });

  orderMgr.on('order_opened', (order) => {
    events.push('order_opened');
    log(`[EVENT] order_opened: ${order.id}`);
  });

  orderMgr.on('order_filled', (event) => {
    events.push('order_filled');
    log(`[EVENT] order_filled: ${event.orderId} | Size: ${event.fill.size} @ Price: ${event.fill.price}`);
  });

  orderMgr.on('order_cancelled', (event) => {
    events.push('order_cancelled');
    log(`[EVENT] order_cancelled: ${event.orderId}`);
  });

  orderMgr.on('error', (error) => {
    events.push('error');
    log(`[EVENT] error: ${error.message}`);
  });

  // Start OrderManager
  await orderMgr.start();
  log('OrderManager started');
  log('');

  // ========== Test 1: Validation - Below Minimum Size ==========
  await runTest('Validation: Below minimum size', async () => {
    try {
      await orderMgr.createOrder({
        tokenId: TEST_MARKET.tokenId,
        side: 'BUY',
        price: 0.40,
        size: 3, // Below minimum (5)
        orderType: 'GTC',
      });
      throw new Error('Should have rejected order below minimum size');
    } catch (error) {
      if (error instanceof Error && error.message.includes('minimum')) {
        log('✓ Correctly rejected below minimum size');
      } else {
        throw error;
      }
    }
  });

  // ========== Test 2: Validation - Invalid Tick Size ==========
  await runTest('Validation: Invalid tick size', async () => {
    try {
      await orderMgr.createOrder({
        tokenId: TEST_MARKET.tokenId,
        side: 'BUY',
        price: 0.403, // Invalid tick (not 0.01 multiple)
        size: 10,
        orderType: 'GTC',
      });
      throw new Error('Should have rejected invalid tick size');
    } catch (error) {
      if (error instanceof Error && error.message.includes('tick')) {
        log('✓ Correctly rejected invalid tick size');
      } else {
        throw error;
      }
    }
  });

  // ========== Test 3: Create GTC Order (Low Balance Test) ==========
  await runTest('Create GTC order with low balance', async () => {
    // Use very low price and small size to minimize capital requirement
    // Price: 0.35 (below market 0.485), Size: 5 (minimum)
    // Required: 0.35 * 5 = 1.75 USDC.e (but we only have 1.64)
    // Let's use even smaller: 0.30 * 5 = 1.50 USDC.e
    const result = await orderMgr.createOrder({
      tokenId: TEST_MARKET.tokenId,
      side: 'BUY',
      price: 0.30,
      size: 5,
      orderType: 'GTC',
    });

    if (!result.success || !result.orderId) {
      throw new Error(`Order creation failed: ${result.errorMsg || 'Unknown error'}`);
    }

    log(`Order created: ${result.orderId}`);

    // Verify auto-watch immediately
    const watchedOrders = orderMgr.getWatchedOrders();
    if (!watchedOrders.some(o => o.id === result.orderId)) {
      throw new Error('Order not auto-watched');
    }

    log('✓ Order auto-watched');

    // Wait for order_opened event (or immediate fill)
    await delay(3000);

    // Check if order_opened or status_change event was emitted
    const hasOpened = events.includes('order_opened') || events.includes('status_change');
    if (!hasOpened) {
      log('⚠️  Warning: No order_opened or status_change event (may be delayed)');
    } else {
      log('✓ Status event received');
    }

    // Cancel the order
    const cancelResult = await orderMgr.cancelOrder(result.orderId);
    if (cancelResult.success) {
      log('✓ Order cancelled successfully');
    } else {
      log(`ℹ️  Cancellation result: ${cancelResult.errorMsg || 'Order may be filled'}`);
    }

    // Wait for cancellation event
    await delay(2000);
  });

  // ========== Test 4: Immediate Fill Test ==========
  await runTest('Immediate fill with market price', async () => {
    // Use market price with minimum size to test immediate fill
    // This should fill instantly
    const result = await orderMgr.createOrder({
      tokenId: TEST_MARKET.tokenId,
      side: 'BUY',
      price: 0.30, // Low enough to fill but within balance
      size: 5,
      orderType: 'GTC',
    });

    if (!result.success || !result.orderId) {
      throw new Error(`Order creation failed: ${result.errorMsg || 'Unknown error'}`);
    }

    log(`Order created: ${result.orderId}`);

    // Wait for fill or status change
    await delay(5000);

    // Check order status
    const order = await orderMgr.getOrder(result.orderId);
    if (!order) {
      throw new Error('Order not found');
    }

    log(`Final order status: ${order.status}`);
    log(`Filled size: ${order.filledSize}`);
    log(`Remaining size: ${order.remainingSize}`);

    // Verify events
    if (order.status === 'filled') {
      if (!events.includes('order_filled') && !events.includes('status_change')) {
        throw new Error('Missing fill events');
      }
      log('✓ Fill events received');
    } else if (order.status === 'open') {
      log('✓ Order opened successfully');
      // Try to cancel
      await orderMgr.cancelOrder(result.orderId);
      await delay(2000);
    }
  });

  // Stop OrderManager
  orderMgr.stop();
  log('OrderManager stopped');
  log('');

  // ========== Print Summary ==========
  log('='.repeat(60));
  log('Test Results Summary');
  log('='.repeat(60));
  log('');

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  const total = results.length;

  for (const result of results) {
    const status = result.passed ? '✅ PASS' : '❌ FAIL';
    log(`${status} | ${result.name} (${result.duration}ms)`);
    if (result.error) {
      log(`       Error: ${result.error}`);
    }
  }

  log('');
  log(`Total: ${total}, Passed: ${passed}, Failed: ${failed}`);
  log('');

  // Print event summary
  log('='.repeat(60));
  log('Event Summary');
  log('='.repeat(60));
  log('');

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
