#!/usr/bin/env npx tsx
/**
 * 真实 CLOB 操作测试
 *
 * 用真实私钥验证完整流程：
 * 1. 初始化 SDK（派生 credentials）
 * 2. 测试读操作
 * 3. 测试下单/撤单
 *
 * Usage:
 *   PRIVATE_KEY=0x... npx tsx scripts/test-clob-real.ts
 */

import { PolymarketSDK } from '../src/index.js';

async function main() {
  const privateKey = process.env.PRIVATE_KEY;

  if (!privateKey) {
    console.error('❌ 请设置环境变量: PRIVATE_KEY=0x...');
    process.exit(1);
  }

  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║     CLOB 完整流程真实测试                                    ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  // 1. 初始化 SDK
  console.log('=== Step 1: 初始化 SDK ===\n');
  const sdk = new PolymarketSDK({
    privateKey,
    chainId: 137,
  });

  await sdk.initialize();
  const address = sdk.tradingService.getAddress();
  const creds = sdk.tradingService.getCredentials();

  console.log(`✅ SDK 初始化成功`);
  console.log(`   钱包地址: ${address}`);
  console.log(`   API Key: ${creds?.key.slice(0, 15)}...`);

  // 2. 测试读操作
  console.log('\n=== Step 2: 测试读操作 ===\n');

  // 2.1 获取余额
  console.log('💰 获取 USDC 余额...');
  try {
    const balance = await sdk.tradingService.getBalanceAllowance('COLLATERAL');
    const usdcBalance = parseFloat(balance.balance) / 1e6;
    console.log(`   ✅ Balance: $${usdcBalance.toFixed(2)}`);
  } catch (e: any) {
    console.log(`   ❌ 失败: ${e.message}`);
  }

  // 2.2 获取订单
  console.log('\n📋 获取 Open Orders...');
  try {
    const orders = await sdk.tradingService.getOpenOrders();
    console.log(`   ✅ ${orders.length} 个挂单`);
    if (orders.length > 0) {
      console.log(`   第一个: ${orders[0].id.slice(0, 20)}... @ $${orders[0].price}`);
    }
  } catch (e: any) {
    console.log(`   ❌ 失败: ${e.message}`);
  }

  // 2.3 获取交易历史
  console.log('\n📊 获取 Trades...');
  try {
    const trades = await sdk.tradingService.getTrades();
    console.log(`   ✅ ${trades.length} 条交易`);
  } catch (e: any) {
    console.log(`   ❌ 失败: ${e.message}`);
  }

  // 3. 测试下单
  console.log('\n=== Step 3: 测试下单操作 ===\n');

  // 获取一个市场
  console.log('🔍 获取测试市场...');
  const conditionId = '0x7c6c69d91b21cbbea08a13d0ad51c0e96a956045aaadc77bce507c6b0475b66e';

  try {
    const market = await sdk.markets.getClobMarket(conditionId);
    if (!market || market.tokens.length < 2) {
      console.log('   ❌ 市场不可用');
      return;
    }

    const tokenId = market.tokens[0].tokenId;
    console.log(`   ✅ 市场: ${market.question.slice(0, 50)}...`);
    console.log(`   Token: ${tokenId.slice(0, 20)}...`);

    // 下单测试 - 极低价格，不会成交
    const testPrice = 0.001;
    const testSize = 100;

    console.log(`\n📝 下单测试 (BUY @ $${testPrice}, ${testSize} shares)...`);
    console.log(`   预期: 因余额不足或最小限制失败，但能验证签名流程`);

    const result = await sdk.tradingService.createLimitOrder({
      tokenId,
      side: 'BUY',
      price: testPrice,
      size: testSize,
    });

    console.log('\n📦 下单结果:');
    console.log(`   Success: ${result.success}`);
    if (result.orderId) {
      console.log(`   Order ID: ${result.orderId}`);

      // 撤单
      console.log('\n📝 撤单测试...');
      const cancelResult = await sdk.tradingService.cancelOrder(result.orderId);
      console.log(`   ✅ 撤单: ${cancelResult.success ? '成功' : '失败'}`);
    }
    if (result.errorMsg) {
      console.log(`   Error: ${result.errorMsg}`);
    }

  } catch (e: any) {
    console.log(`   ❌ 异常: ${e.message}`);
  }

  // 4. 总结
  console.log('\n════════════════════════════════════════════════════════════════');
  console.log('测试完成！');
  console.log('');
  console.log('关键发现:');
  console.log('1. SDK 初始化时自动派生 credentials (需要 EIP-712 签名)');
  console.log('2. 读操作 (getBalance/getOrders/getTrades) 只需 HMAC');
  console.log('3. 下单操作需要 EIP-712 签名订单数据');
  console.log('4. 撤单操作只需 HMAC (不需要额外签名)');
  console.log('════════════════════════════════════════════════════════════════');
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
