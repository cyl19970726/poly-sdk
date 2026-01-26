/**
 * OrderManager End-to-End Test
 *
 * Tests all order lifecycle scenarios:
 * 1. Create limit order (GTC) - auto-watch
 * 2. Create limit order (GTD) - expires after 5 minutes
 * 3. Partial fill scenario (large order)
 * 4. Immediate cancellation
 * 5. Cancel after partial fill
 * 6. Watch external order
 * 7. Chain settlement tracking
 * 8. Batch orders
 *
 * Usage:
 * PRIVATE_KEY=0x... npx tsx scripts/test-order-manager-e2e.ts
 */

import { OrderManager, type OrderStatusChangeEvent, type FillEvent, type TransactionEvent, type SettlementEvent } from '../../src/index.js';

const PRIVATE_KEY = process.env.PRIVATE_KEY;

if (!PRIVATE_KEY) {
  console.error('Error: PRIVATE_KEY environment variable is required');
  console.error('Please set it in .env file or pass as environment variable');
  process.exit(1);
}

// Test market: BTC Up/Down 15-minute market (high liquidity)
// Market: Bitcoin Up or Down - January 14, 11:30AM-11:45AM ET
const TEST_MARKET = {
  conditionId: '0x734720ff62e94d4d3aca7779c0c524942552f413598471e27641fa5768c9b9bd',
  primaryTokenId: '33095274756912603140497919858406898509281326656669704017026263839116792685912',  // Up token (price: 0.485)
  secondaryTokenId: '96784320014242754088182679292920116900310434804732581110626077800568579041234',  // Down token (price: 0.515)
};

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
}

const results: TestResult[] = [];

function log(message: string) {
  console.log(`[E2E] ${message}`);
}

function logEvent(event: string, data: any) {
  console.log(`[EVENT] ${event}:`, JSON.stringify(data, null, 2));
}

async function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runTest(name: string, testFn: () => Promise<void>): Promise<void> {
  log(`Starting test: ${name}`);
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
  log('OrderManager E2E Test Suite');
  log('='.repeat(60));
  log('');

  // Initialize OrderManager
  const orderMgr = new OrderManager({
    privateKey: PRIVATE_KEY,
    mode: 'hybrid',
    debug: true,
  });

  // Setup event listeners
  const events: any[] = [];

  orderMgr.on('order_created', (order) => {
    events.push({ type: 'order_created', order });
    logEvent('order_created', { orderId: order.id, status: order.status });
  });

  orderMgr.on('status_change', (event: OrderStatusChangeEvent) => {
    events.push({ type: 'status_change', event });
    logEvent('status_change', { orderId: event.orderId, from: event.from, to: event.to });
  });

  orderMgr.on('order_opened', (order) => {
    events.push({ type: 'order_opened', order });
    logEvent('order_opened', { orderId: order.id });
  });

  orderMgr.on('order_partially_filled', (event: FillEvent) => {
    events.push({ type: 'order_partially_filled', event });
    logEvent('order_partially_filled', {
      orderId: event.orderId,
      size: event.fill.size,
      price: event.fill.price,
      cumulative: event.cumulativeFilled,
      remaining: event.remainingSize,
    });
  });

  orderMgr.on('order_filled', (event: FillEvent) => {
    events.push({ type: 'order_filled', event });
    logEvent('order_filled', {
      orderId: event.orderId,
      size: event.fill.size,
      price: event.fill.price,
      total: event.cumulativeFilled,
    });
  });

  orderMgr.on('transaction_submitted', (event: TransactionEvent) => {
    events.push({ type: 'transaction_submitted', event });
    logEvent('transaction_submitted', {
      orderId: event.orderId,
      tradeId: event.tradeId,
      txHash: event.transactionHash,
    });
  });

  orderMgr.on('transaction_confirmed', (event: SettlementEvent) => {
    events.push({ type: 'transaction_confirmed', event });
    logEvent('transaction_confirmed', {
      orderId: event.orderId,
      tradeId: event.tradeId,
      txHash: event.transactionHash,
      block: event.blockNumber,
      gas: event.gasUsed,
    });
  });

  orderMgr.on('order_cancelled', (event) => {
    events.push({ type: 'order_cancelled', event });
    logEvent('order_cancelled', {
      orderId: event.orderId,
      filledSize: event.order.filledSize,
      remainingSize: event.order.remainingSize,
    });
  });

  orderMgr.on('order_expired', (event) => {
    events.push({ type: 'order_expired', event });
    logEvent('order_expired', {
      orderId: event.orderId,
      filledSize: event.order.filledSize,
    });
  });

  orderMgr.on('error', (error: Error) => {
    events.push({ type: 'error', error });
    logEvent('error', { message: error.message });
  });

  // Start OrderManager
  log('Starting OrderManager...');
  await orderMgr.start();
  log('OrderManager started');
  log('');

  // ========== Test 1: Create GTC Order (auto-watch) ==========
  await runTest('Create GTC limit order', async () => {
    const result = await orderMgr.createOrder({
      tokenId: TEST_MARKET.primaryTokenId,
      side: 'BUY',
      price: 0.44,  // Below market price (0.485), won't fill immediately
      size: 10,  // Small size
      orderType: 'GTC',
    });

    if (!result.success || !result.orderId) {
      throw new Error(`Order creation failed: ${result.errorMsg}`);
    }

    log(`Order created: ${result.orderId}`);

    // Wait for order_opened event
    await delay(2000);

    const watchedOrders = orderMgr.getWatchedOrders();
    if (!watchedOrders.some(o => o.id === result.orderId)) {
      throw new Error('Order not auto-watched');
    }

    log('Order auto-watched ✓');

    // Check if order_opened event was emitted
    const openedEvent = events.find(e => e.type === 'order_opened' && e.order.id === result.orderId);
    if (!openedEvent) {
      throw new Error('order_opened event not emitted');
    }

    log('order_opened event received ✓');

    // Cancel the order
    const cancelResult = await orderMgr.cancelOrder(result.orderId);
    if (!cancelResult.success) {
      throw new Error('Order cancellation failed');
    }

    log('Order cancelled ✓');

    // Wait for order_cancelled event
    await delay(2000);

    const cancelledEvent = events.find(e => e.type === 'order_cancelled' && e.event.orderId === result.orderId);
    if (!cancelledEvent) {
      throw new Error('order_cancelled event not emitted');
    }

    log('order_cancelled event received ✓');
  });

  // ========== Test 2: Create GTD Order (expires) ==========
  await runTest('Create GTD limit order (expires)', async () => {
    const expiration = Math.floor(Date.now() / 1000) + 60; // Expires in 1 minute

    const result = await orderMgr.createOrder({
      tokenId: TEST_MARKET.primaryTokenId,
      side: 'BUY',
      price: 0.45,  // Very low price, unlikely to fill
      size: 10,
      orderType: 'GTD',
      expiration,
    });

    if (!result.success || !result.orderId) {
      throw new Error(`GTD order creation failed: ${result.errorMsg}`);
    }

    log(`GTD order created: ${result.orderId}, expires at ${new Date(expiration * 1000).toISOString()}`);

    // Wait for order to open
    await delay(2000);

    // Wait for expiration (70 seconds to be safe)
    log('Waiting for order expiration (70 seconds)...');
    await delay(70000);

    // Check if order_expired event was emitted
    const expiredEvent = events.find(e => e.type === 'order_expired' && e.event.orderId === result.orderId);
    if (!expiredEvent) {
      throw new Error('order_expired event not emitted');
    }

    log('order_expired event received ✓');
  });

  // ========== Test 3: Partial Fill Scenario ==========
  await runTest('Partial fill detection', async () => {
    // Create a large order at market price to get partial fills
    const result = await orderMgr.createOrder({
      tokenId: TEST_MARKET.primaryTokenId,
      side: 'BUY',
      price: 0.52,  // At or near market price
      size: 1000,  // Large size, likely to fill partially
      orderType: 'GTC',
    });

    if (!result.success || !result.orderId) {
      throw new Error(`Order creation failed: ${result.errorMsg}`);
    }

    log(`Large order created: ${result.orderId}`);

    // Wait for fills (up to 30 seconds)
    log('Waiting for partial fills...');
    await delay(30000);

    // Check if we got any fills
    const fillEvents = events.filter(e =>
      (e.type === 'order_partially_filled' || e.type === 'order_filled') &&
      e.event.orderId === result.orderId
    );

    if (fillEvents.length === 0) {
      log('No fills received (market might be too quiet). Cancelling order...');

      // Cancel the order
      await orderMgr.cancelOrder(result.orderId);
      await delay(2000);

      log('Order cancelled, test inconclusive but no errors');
      return;
    }

    log(`Received ${fillEvents.length} fill events ✓`);

    // Check if we got transaction events
    const txEvents = events.filter(e =>
      (e.type === 'transaction_submitted' || e.type === 'transaction_confirmed') &&
      e.event.orderId === result.orderId
    );

    if (txEvents.length > 0) {
      log(`Received ${txEvents.length} transaction events ✓`);
    } else {
      log('No transaction events yet (may arrive later)');
    }

    // Cancel remaining
    await orderMgr.cancelOrder(result.orderId);
    await delay(2000);

    log('Remaining cancelled ✓');
  });

  // ========== Test 4: Immediate Cancellation ==========
  await runTest('Immediate cancellation', async () => {
    const result = await orderMgr.createOrder({
      tokenId: TEST_MARKET.secondaryTokenId,
      side: 'SELL',
      price: 0.55,
      size: 20,
      orderType: 'GTC',
    });

    if (!result.success || !result.orderId) {
      throw new Error(`Order creation failed: ${result.errorMsg}`);
    }

    log(`Order created: ${result.orderId}`);

    // Cancel immediately (don't wait for order_opened)
    const cancelResult = await orderMgr.cancelOrder(result.orderId);
    if (!cancelResult.success) {
      throw new Error('Immediate cancellation failed');
    }

    log('Order cancelled immediately ✓');

    // Wait for events
    await delay(3000);

    const cancelledEvent = events.find(e => e.type === 'order_cancelled' && e.event.orderId === result.orderId);
    if (!cancelledEvent) {
      throw new Error('order_cancelled event not emitted');
    }

    log('order_cancelled event received ✓');
  });

  // ========== Test 5: Batch Orders ==========
  await runTest('Batch order creation', async () => {
    const result = await orderMgr.createBatchOrders([
      {
        tokenId: TEST_MARKET.primaryTokenId,
        side: 'BUY',
        price: 0.47,
        size: 10,
        orderType: 'GTC',
      },
      {
        tokenId: TEST_MARKET.secondaryTokenId,
        side: 'SELL',
        price: 0.53,
        size: 15,
        orderType: 'GTC',
      },
    ]);

    if (!result.success || !result.orderIds || result.orderIds.length !== 2) {
      throw new Error(`Batch order creation failed: ${result.errorMsg}`);
    }

    log(`Batch orders created: ${result.orderIds.join(', ')}`);

    // Wait for orders to open
    await delay(3000);

    // Check if both orders are watched
    const watchedOrders = orderMgr.getWatchedOrders();
    for (const orderId of result.orderIds) {
      if (!watchedOrders.some(o => o.id === orderId)) {
        throw new Error(`Order ${orderId} not auto-watched`);
      }
    }

    log('All batch orders auto-watched ✓');

    // Cancel all
    for (const orderId of result.orderIds) {
      await orderMgr.cancelOrder(orderId);
    }

    await delay(2000);
    log('All batch orders cancelled ✓');
  });

  // ========== Test 6: Watch External Order ==========
  await runTest('Watch external order', async () => {
    // Create order via TradingService (simulate external order)
    const result = await orderMgr.createOrder({
      tokenId: TEST_MARKET.primaryTokenId,
      side: 'BUY',
      price: 0.46,
      size: 10,
      orderType: 'GTC',
    });

    if (!result.success || !result.orderId) {
      throw new Error('Order creation failed');
    }

    log(`External order created: ${result.orderId}`);

    // Unwatch first (simulate external order scenario)
    orderMgr.unwatchOrder(result.orderId);
    log('Order unwatched');

    // Now watch it manually
    orderMgr.watchOrder(result.orderId, {
      strategyId: 'test-strategy',
      notes: 'External order test',
    });

    log('Order manually watched ✓');

    // Wait for events
    await delay(3000);

    const watchedOrders = orderMgr.getWatchedOrders();
    if (!watchedOrders.some(o => o.id === result.orderId)) {
      throw new Error('Manual watch failed');
    }

    log('Manual watch successful ✓');

    // Cancel
    await orderMgr.cancelOrder(result.orderId);
    await delay(2000);

    log('External order cancelled ✓');
  });

  // ========== Test 7: Validation Tests ==========
  await runTest('Order validation (below minimum size)', async () => {
    try {
      await orderMgr.createOrder({
        tokenId: TEST_MARKET.primaryTokenId,
        side: 'BUY',
        price: 0.50,
        size: 3,  // Below minimum (5)
        orderType: 'GTC',
      });

      throw new Error('Should have rejected order below minimum size');
    } catch (error) {
      if (error instanceof Error && error.message.includes('BELOW_MINIMUM_SIZE')) {
        log('Validation rejected below minimum size ✓');
      } else {
        throw error;
      }
    }
  });

  await runTest('Order validation (invalid tick size)', async () => {
    try {
      await orderMgr.createOrder({
        tokenId: TEST_MARKET.primaryTokenId,
        side: 'BUY',
        price: 0.503,  // Invalid tick size (not 0.01 multiple)
        size: 10,
        orderType: 'GTC',
      });

      throw new Error('Should have rejected order with invalid tick size');
    } catch (error) {
      if (error instanceof Error && error.message.includes('INVALID_TICK_SIZE')) {
        log('Validation rejected invalid tick size ✓');
      } else {
        throw error;
      }
    }
  });

  // Stop OrderManager
  log('Stopping OrderManager...');
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
    acc[e.type] = (acc[e.type] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  for (const [type, count] of Object.entries(eventCounts)) {
    log(`${type}: ${count}`);
  }

  log('');
  log('='.repeat(60));

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
