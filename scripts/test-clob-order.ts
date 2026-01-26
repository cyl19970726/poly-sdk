#!/usr/bin/env npx tsx
/**
 * 真实下单/撤单测试
 *
 * Usage:
 *   PRIVATE_KEY=0x... npx tsx scripts/test-clob-order.ts
 */

import { PolymarketSDK } from '../src/index.js';

async function main() {
  const privateKey = process.env.PRIVATE_KEY;

  if (!privateKey) {
    console.error('❌ 请设置环境变量: PRIVATE_KEY=0x...');
    process.exit(1);
  }

  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║     真实下单/撤单测试                                        ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  // 初始化 SDK
  const sdk = new PolymarketSDK({
    privateKey,
    chainId: 137,
  });

  await sdk.initialize();
  const address = sdk.tradingService.getAddress();
  console.log(`钱包: ${address}\n`);

  // 获取余额
  const balance = await sdk.tradingService.getBalanceAllowance('COLLATERAL');
  const usdcBalance = parseFloat(balance.balance) / 1e6;
  console.log(`USDC 余额: $${usdcBalance.toFixed(2)}\n`);

  if (usdcBalance < 5) {
    console.log('⚠️  余额不足 $5，跳过下单测试');
    return;
  }

  // 获取市场 - Fed 市场 Yes 价格很低 (0.35%), 适合测试
  const conditionId = '0x7c6c69d91b21cbbea08a13d0ad51c0e96a956045aaadc77bce507c6b0475b66e';
  const market = await sdk.markets.getClobMarket(conditionId);

  if (!market) {
    console.log('❌ 市场不可用');
    return;
  }

  const tokenId = market.tokens[0].tokenId;
  const currentPrice = market.tokens[0].price;
  console.log(`市场: ${market.question.slice(0, 60)}...`);
  console.log(`当前价格: ${(currentPrice * 100).toFixed(2)}%`);
  console.log(`Token: ${tokenId.slice(0, 25)}...\n`);

  // 下单 - 远低于当前价格，不会成交
  // 当前价格约 0.35%，我们用 0.1% 的价格
  const testPrice = 0.001;  // 0.1%
  const testSize = 1000;    // 1000 shares @ $0.001 = $1 value

  console.log('═══════════════════════════════════════════════════════════');
  console.log(`📝 下单: BUY ${testSize} shares @ $${testPrice}`);
  console.log(`   订单价值: $${(testPrice * testSize).toFixed(2)}`);
  console.log('═══════════════════════════════════════════════════════════\n');

  const orderResult = await sdk.tradingService.createLimitOrder({
    tokenId,
    side: 'BUY',
    price: testPrice,
    size: testSize,
  });

  console.log('📦 下单结果:');
  console.log(`   Success: ${orderResult.success}`);

  if (orderResult.orderId) {
    console.log(`   Order ID: ${orderResult.orderId}`);

    // 验证订单存在
    console.log('\n📋 验证订单...');
    const orders = await sdk.tradingService.getOpenOrders();
    const myOrder = orders.find(o => o.id === orderResult.orderId);
    if (myOrder) {
      console.log(`   ✅ 订单已挂: ${myOrder.side} ${myOrder.originalSize} @ $${myOrder.price}`);
    } else {
      console.log('   ⚠️  订单未在列表中（可能已成交或取消）');
    }

    // 撤单
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log(`📝 撤单: ${orderResult.orderId}`);
    console.log('═══════════════════════════════════════════════════════════\n');

    const cancelResult = await sdk.tradingService.cancelOrder(orderResult.orderId);
    console.log(`   Success: ${cancelResult.success}`);

    // 验证撤单
    console.log('\n📋 验证撤单...');
    const ordersAfter = await sdk.tradingService.getOpenOrders();
    const stillExists = ordersAfter.find(o => o.id === orderResult.orderId);
    if (!stillExists) {
      console.log('   ✅ 订单已撤销');
    } else {
      console.log('   ⚠️  订单仍然存在');
    }

  } else if (orderResult.errorMsg) {
    console.log(`   Error: ${orderResult.errorMsg}`);
  }

  console.log('\n════════════════════════════════════════════════════════════════');
  console.log('测试完成！');
  console.log('════════════════════════════════════════════════════════════════');
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
