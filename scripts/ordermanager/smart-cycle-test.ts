/**
 * OrderManager Smart Cycle Test
 *
 * 智能资金循环测试：
 * 1. 买入 Yes/Up token (低价)
 * 2. 卖出 Yes/Up token (回收资金)
 * 3. 买入 No/Down token (低价)
 * 4. 卖出 No/Down token (回收资金)
 * 5. 重复循环，测试各种场景
 *
 * 策略：
 * - 使用最小金额 (5 shares)
 * - 买入价格低于市场价 (确保成交)
 * - 卖出价格高于市场价 (快速卖出)
 * - 每次循环后资金恢复
 *
 * Usage:
 * PRIVATE_KEY=0x... npx tsx scripts/ordermanager/smart-cycle-test.ts
 */

import { OrderManager } from '../../src/index.js';

const PRIVATE_KEY = process.env.PRIVATE_KEY;

if (!PRIVATE_KEY) {
  console.error('Error: PRIVATE_KEY environment variable is required');
  console.error('Please set it in .env file or pass as environment variable');
  process.exit(1);
}

// BTC 15-min market (Bitcoin Up or Down - January 14, 11:45AM-12:00PM ET)
const TEST_MARKET = {
  conditionId: '0xced1eea66b483c0a4438b1067a02e0747570945e4163108c7ca4ec15f098a5ad',
  upTokenId: '18578596720498755385885295057347881881173812076287828669272129527927363439045',
  downTokenId: '86620063778050570947764231066599001025994898325708023258322733918402857563478',
  upPrice: 0.455,
  downPrice: 0.545,
};

interface CycleResult {
  cycle: number;
  action: string;
  orderId?: string;
  status: 'success' | 'partial' | 'failed';
  capitalUsed: number;
  capitalRecovered: number;
  duration: number;
  error?: string;
}

const results: CycleResult[] = [];
const events: string[] = [];

function log(message: string) {
  console.log(`[CYCLE] ${message}`);
}

async function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function buyCycle(
  orderMgr: OrderManager,
  cycleNum: number,
  tokenId: string,
  side: 'Up' | 'Down'
): Promise<void> {
  const start = Date.now();

  try {
    // Buy at low price (below market) - will fill immediately
    const buyPrice = side === 'Up' ? 0.40 : 0.45; // Low enough to fill
    const size = 10;

    log(`\nCycle ${cycleNum}: Buy ${side} @ ${buyPrice}`);

    const buyResult = await orderMgr.createOrder({
      tokenId,
      side: 'BUY',
      price: buyPrice,
      size,
      orderType: 'GTC',
    });

    if (!buyResult.success || !buyResult.orderId) {
      throw new Error(`Buy failed: ${buyResult.errorMsg}`);
    }

    log(`  ✓ Buy order: ${buyResult.orderId}`);

    // Wait for fill
    await delay(3000);

    // Check order status
    const order = await orderMgr.getOrder(buyResult.orderId);
    if (!order) {
      throw new Error('Order not found');
    }

    log(`  Status: ${order.status}, Filled: ${order.filledSize}/${order.originalSize}`);

    if (order.status === 'filled' || order.filledSize > 0) {
      // Now sell the tokens to recover capital
      await delay(1000);

      const sellPrice = side === 'Up' ? 0.45 : 0.50; // Higher than buy price
      log(`  Selling ${order.filledSize} shares @ ${sellPrice}...`);

      const sellResult = await orderMgr.createOrder({
        tokenId,
        side: 'SELL',
        price: sellPrice,
        size: order.filledSize,
        orderType: 'GTC',
      });

      if (sellResult.success) {
        log(`  ✓ Sell order: ${sellResult.orderId}`);

        // Wait for sell to complete
        await delay(3000);

        const sellOrder = await orderMgr.getOrder(sellResult.orderId!);
        if (sellOrder?.status === 'open') {
          // Cancel if not filled
          await orderMgr.cancelOrder(sellResult.orderId!);
          log(`  ℹ️  Sell cancelled (not filled)`);
        } else {
          log(`  ✓ Sell completed`);
        }
      }

      const duration = Date.now() - start;
      results.push({
        cycle: cycleNum,
        action: `Buy+Sell ${side}`,
        orderId: buyResult.orderId,
        status: 'success',
        capitalUsed: buyPrice * size,
        capitalRecovered: sellPrice * order.filledSize,
        duration,
      });

      log(`  ✅ Cycle ${cycleNum} complete (${duration}ms)`);
    } else {
      // Not filled, cancel
      await orderMgr.cancelOrder(buyResult.orderId);
      log(`  ℹ️  Not filled, cancelled`);

      results.push({
        cycle: cycleNum,
        action: `Buy ${side} (cancelled)`,
        orderId: buyResult.orderId,
        status: 'partial',
        capitalUsed: 0,
        capitalRecovered: 0,
        duration: Date.now() - start,
      });
    }
  } catch (error) {
    log(`  ❌ Error: ${error instanceof Error ? error.message : String(error)}`);

    results.push({
      cycle: cycleNum,
      action: `Buy ${side} (failed)`,
      status: 'failed',
      capitalUsed: 0,
      capitalRecovered: 0,
      duration: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function main() {
  log('='.repeat(60));
  log('OrderManager Smart Cycle Test');
  log('Strategy: Buy → Sell → Repeat (Capital循环)');
  log('='.repeat(60));

  const orderMgr = new OrderManager({
    privateKey: PRIVATE_KEY,
    mode: 'hybrid',
    debug: false,
  });

  // Event listeners
  orderMgr.on('order_created', () => events.push('order_created'));
  orderMgr.on('order_opened', () => events.push('order_opened'));
  orderMgr.on('order_filled', () => events.push('order_filled'));
  orderMgr.on('order_cancelled', () => events.push('order_cancelled'));

  await orderMgr.start();
  log('OrderManager started\n');

  // === Cycle 1: Buy Up, Sell Up ===
  await buyCycle(orderMgr, 1, TEST_MARKET.upTokenId, 'Up');
  await delay(2000);

  // === Cycle 2: Buy Down, Sell Down ===
  await buyCycle(orderMgr, 2, TEST_MARKET.downTokenId, 'Down');
  await delay(2000);

  // === Cycle 3: Buy Up again ===
  await buyCycle(orderMgr, 3, TEST_MARKET.upTokenId, 'Up');
  await delay(2000);

  // === Cycle 4: Mixed - Cancel instead of sell ===
  log(`\nCycle 4: Buy Up + Cancel (testing cancel path)`);
  const start4 = Date.now();
  try {
    const result = await orderMgr.createOrder({
      tokenId: TEST_MARKET.upTokenId,
      side: 'BUY',
      price: 0.30, // Very low, won't fill
      size: 5,
      orderType: 'GTC',
    });

    if (result.success && result.orderId) {
      log(`  ✓ Order created: ${result.orderId}`);
      await delay(3000);

      const cancelResult = await orderMgr.cancelOrder(result.orderId);
      if (cancelResult.success) {
        log(`  ✓ Order cancelled`);
        results.push({
          cycle: 4,
          action: 'Buy Up (cancel test)',
          orderId: result.orderId,
          status: 'success',
          capitalUsed: 0,
          capitalRecovered: 0,
          duration: Date.now() - start4,
        });
      }
    }
  } catch (error) {
    log(`  ❌ Error: ${error instanceof Error ? error.message : String(error)}`);
  }

  await delay(2000);

  // === Cycle 5: Batch buy test ===
  log(`\nCycle 5: Batch buy (2 orders)`);
  const start5 = Date.now();
  try {
    const batchResult = await orderMgr.createBatchOrders([
      {
        tokenId: TEST_MARKET.upTokenId,
        side: 'BUY',
        price: 0.40,
        size: 5,
        orderType: 'GTC',
      },
      {
        tokenId: TEST_MARKET.downTokenId,
        side: 'BUY',
        price: 0.45,
        size: 5,
        orderType: 'GTC',
      },
    ]);

    if (batchResult.success && batchResult.orderIds) {
      log(`  ✓ Batch created: ${batchResult.orderIds.length} orders`);
      await delay(3000);

      // Cancel all
      for (const orderId of batchResult.orderIds) {
        await orderMgr.cancelOrder(orderId);
      }

      log(`  ✓ All cancelled`);
      results.push({
        cycle: 5,
        action: 'Batch buy (2 orders)',
        status: 'success',
        capitalUsed: 0,
        capitalRecovered: 0,
        duration: Date.now() - start5,
      });
    }
  } catch (error) {
    log(`  ❌ Error: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Stop
  orderMgr.stop();
  log('\n\nOrderManager stopped\n');

  // === Summary ===
  log('='.repeat(60));
  log('Cycle Test Results');
  log('='.repeat(60));

  const successful = results.filter(r => r.status === 'success').length;
  const partial = results.filter(r => r.status === 'partial').length;
  const failed = results.filter(r => r.status === 'failed').length;

  const totalUsed = results.reduce((sum, r) => sum + r.capitalUsed, 0);
  const totalRecovered = results.reduce((sum, r) => sum + r.capitalRecovered, 0);
  const netCost = totalUsed - totalRecovered;

  log('');
  for (const result of results) {
    const icon = result.status === 'success' ? '✅' : result.status === 'partial' ? '⚠️' : '❌';
    log(`${icon} Cycle ${result.cycle}: ${result.action}`);
    log(`   Duration: ${result.duration}ms`);
    if (result.capitalUsed > 0) {
      log(`   Capital: ${result.capitalUsed.toFixed(2)} → ${result.capitalRecovered.toFixed(2)} USDC`);
      log(`   Net: ${(result.capitalRecovered - result.capitalUsed).toFixed(2)} USDC`);
    }
    if (result.error) {
      log(`   Error: ${result.error}`);
    }
  }

  log('');
  log(`Total Cycles: ${results.length}`);
  log(`Success: ${successful}, Partial: ${partial}, Failed: ${failed}`);
  log(`Capital Used: ${totalUsed.toFixed(2)} USDC`);
  log(`Capital Recovered: ${totalRecovered.toFixed(2)} USDC`);
  log(`Net Cost: ${netCost.toFixed(2)} USDC (fees + spread)`);

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
  log(`\n✅ Smart Cycle Test Complete`);
  log(`Tested: Buy→Sell循环, Cancellation, Batch orders`);
  log(`Recovery Rate: ${totalUsed > 0 ? ((totalRecovered / totalUsed) * 100).toFixed(1) : 'N/A'}%\n`);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
