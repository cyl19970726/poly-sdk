/**
 * OrderManager Quick Test - Create & Cancel a Single Order
 *
 * Quick verification that OrderManager works end-to-end:
 * 1. Create a limit order
 * 2. Verify auto-watch
 * 3. Listen for events
 * 4. Cancel after 10 seconds
 *
 * Usage:
 * PRIVATE_KEY=0x... npx tsx scripts/test-order-manager-quick.ts
 *
 * Optional parameters:
 * - MARKET_CONDITION_ID: Market condition ID (default: auto-find active BTC market)
 * - TOKEN_ID: Token ID to trade
 * - PRICE: Order price (default: 0.45 - low price to avoid fill)
 * - SIZE: Order size (default: 10)
 */

import { OrderManager } from '../../src/index.js';

const PRIVATE_KEY = process.env.PRIVATE_KEY;

if (!PRIVATE_KEY) {
  console.error('Error: PRIVATE_KEY environment variable is required');
  console.error('');
  console.error('Please set PRIVATE_KEY in your .env file or as environment variable:');
  console.error('  PRIVATE_KEY=0x... npx tsx scripts/ordermanager/quick-test.ts');
  console.error('');
  process.exit(1);
}

async function main() {
  console.log('='.repeat(60));
  console.log('OrderManager Quick Test');
  console.log('='.repeat(60));
  console.log('');

  // Initialize OrderManager
  console.log('Initializing OrderManager...');
  const orderMgr = new OrderManager({
    privateKey: PRIVATE_KEY,
    mode: 'hybrid',
    debug: true,
  });

  // Setup event listeners
  const events: string[] = [];

  orderMgr.on('order_created', (order) => {
    events.push('order_created');
    console.log('✓ [EVENT] order_created:', order.id);
  });

  orderMgr.on('status_change', (event) => {
    events.push('status_change');
    console.log(`✓ [EVENT] status_change: ${event.orderId} | ${event.from} → ${event.to}`);
  });

  orderMgr.on('order_opened', (order) => {
    events.push('order_opened');
    console.log('✓ [EVENT] order_opened:', order.id);
  });

  orderMgr.on('order_filled', (event) => {
    events.push('order_filled');
    console.log('✓ [EVENT] order_filled:', event.orderId, '| Size:', event.fill.size, '@ Price:', event.fill.price);
  });

  orderMgr.on('order_cancelled', (event) => {
    events.push('order_cancelled');
    console.log('✓ [EVENT] order_cancelled:', event.orderId);
  });

  orderMgr.on('transaction_submitted', (event) => {
    events.push('transaction_submitted');
    console.log('✓ [EVENT] transaction_submitted:', event.transactionHash);
  });

  orderMgr.on('transaction_confirmed', (event) => {
    events.push('transaction_confirmed');
    console.log('✓ [EVENT] transaction_confirmed:', event.transactionHash, '| Block:', event.blockNumber);
  });

  orderMgr.on('error', (error) => {
    events.push('error');
    console.error('✗ [EVENT] error:', error.message);
  });

  // Start OrderManager
  try {
    await orderMgr.start();
    console.log('OrderManager started');
    console.log('');
  } catch (error) {
    console.error('Failed to start OrderManager:', error);
    throw error;
  }

  // Use specified market or default to BTC 15-min Up/Down market
  let tokenId = process.env.TOKEN_ID;
  let conditionId = process.env.MARKET_CONDITION_ID;

  if (!tokenId || !conditionId) {
    // Default to active BTC 15-minute Up/Down market (high liquidity)
    conditionId = '0x4e605132e536d51c37a28cdc0ac77e48c77d8e2251743d4eae3309165dee7d34';
    tokenId = '114556380551836029874371622136300870993278600643770464506059877822810208153399'; // Up token

    console.log('Using default market: Bitcoin Up or Down - January 14, 11:15AM-11:30AM ET');
    console.log('Condition ID:', conditionId);
    console.log('Token ID (Up):', tokenId);
    console.log('Current Up price: 0.465');
    console.log('');
  }

  // Create order
  // Use low price (0.40) to avoid immediate fill (current Up price: 0.465)
  const price = parseFloat(process.env.PRICE || '0.40');
  const size = parseInt(process.env.SIZE || '10', 10);

  console.log('Creating order...');
  console.log(`- Token: ${tokenId}`);
  console.log(`- Side: BUY`);
  console.log(`- Price: ${price}`);
  console.log(`- Size: ${size}`);
  console.log('');

  let result;
  try {
    result = await orderMgr.createOrder({
      tokenId,
      side: 'BUY',
      price,
      size,
      orderType: 'GTC',
    });
  } catch (error) {
    console.error('\nOrder creation threw error:');
    console.error('Error type:', error instanceof Error ? error.constructor.name : typeof error);
    console.error('Error message:', error instanceof Error ? error.message : String(error));
    console.error('Error stack:', error instanceof Error ? error.stack : 'No stack');
    throw error;
  }

  if (!result.success || !result.orderId) {
    throw new Error(`Order creation failed: ${result.errorMsg}`);
  }

  const orderId = result.orderId;
  console.log('✓ Order created:', orderId);
  console.log('');

  // Verify auto-watch (check immediately after creation, before status updates)
  const watchedOrdersImmediate = orderMgr.getWatchedOrders();
  if (!watchedOrdersImmediate.some(o => o.id === orderId)) {
    throw new Error('Order not auto-watched!');
  }

  console.log('✓ Order auto-watched');
  console.log('');

  // Wait for events (10 seconds)
  console.log('Waiting for events (10 seconds)...');
  await new Promise(resolve => setTimeout(resolve, 10000));
  console.log('');

  // Check order status
  const order = await orderMgr.getOrder(orderId);
  if (!order) {
    throw new Error('Order not found!');
  }

  console.log('Order status:', order.status);
  console.log('Filled size:', order.filledSize);
  console.log('Remaining size:', order.remainingSize);
  console.log('');

  // Try to cancel order (will fail if already filled)
  console.log('Attempting to cancel order...');
  const cancelResult = await orderMgr.cancelOrder(orderId);

  if (cancelResult.success) {
    console.log('✓ Order cancelled');
  } else {
    console.log(`ℹ️  Cancellation skipped: ${cancelResult.errorMsg || 'Order already filled'}`);
  }
  console.log('');

  // Wait for cancellation event (if applicable)
  await new Promise(resolve => setTimeout(resolve, 3000));

  // Stop OrderManager
  orderMgr.stop();
  console.log('OrderManager stopped');
  console.log('');

  // Summary
  console.log('='.repeat(60));
  console.log('Test Summary');
  console.log('='.repeat(60));
  console.log('');
  console.log(`Events received: ${events.length}`);
  console.log('Event types:');
  const eventCounts = events.reduce((acc, e) => {
    acc[e] = (acc[e] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  for (const [type, count] of Object.entries(eventCounts)) {
    console.log(`  - ${type}: ${count}`);
  }

  console.log('');

  // Verify minimum expected events (smart validation based on order status)
  const requiredEvents = ['order_created'];

  // If order filled, expect status_change or order_filled
  if (order.status === 'filled') {
    if (!events.includes('status_change') && !events.includes('order_filled')) {
      console.error('❌ Missing events: Expected status_change or order_filled for filled order');
      process.exit(1);
    }
  } else if (order.status === 'cancelled') {
    requiredEvents.push('order_cancelled');
  }

  const missingEvents = requiredEvents.filter(e => !events.includes(e));

  if (missingEvents.length > 0) {
    console.error('❌ Missing required events:', missingEvents.join(', '));
    process.exit(1);
  }

  console.log('✓ All expected events received for order status:', order.status);
  console.log('');
  console.log('✅ Test PASSED');
  console.log('');
}

main().catch((error) => {
  console.error('');
  console.error('❌ Test FAILED');
  console.error('');
  console.error('Error:', error.message);
  console.error('');
  process.exit(1);
});
