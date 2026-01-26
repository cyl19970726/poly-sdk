#!/usr/bin/env npx tsx
/**
 * Test: CLOB Credentials Independence
 *
 * 验证 CLOB API credentials 是否可以独立使用（不需要私钥）
 *
 * 假设：
 * 1. 首次需要私钥来派生 credentials
 * 2. 之后只需要 credentials 就能下单/撤单
 *
 * 测试流程：
 * 1. 用私钥派生 credentials
 * 2. 保存 credentials 到文件
 * 3. 用 credentials（不用私钥）创建新的 SDK 实例
 * 4. 测试下单/撤单操作
 *
 * Usage:
 *   PRIVATE_KEY=0x... npx tsx scripts/test-creds-only.ts
 */

import {
  PolymarketSDK,
  TradingService,
  RateLimiter,
  createUnifiedCache,
} from '../src/index.js';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';

const CREDS_FILE = join(process.cwd(), '.test-creds.json');

interface StoredCredentials {
  key: string;
  secret: string;
  passphrase: string;
  walletAddress: string;
  derivedAt: string;
}

async function deriveAndSaveCredentials(privateKey: string): Promise<StoredCredentials> {
  console.log('\n=== Step 1: 用私钥派生 Credentials ===\n');

  const sdk = new PolymarketSDK({
    privateKey,
    chainId: 137,
  });

  // 初始化会自动派生 credentials
  await sdk.initialize();

  const creds = sdk.tradingService.getCredentials();
  const address = sdk.tradingService.getAddress();

  if (!creds) {
    throw new Error('Failed to derive credentials');
  }

  console.log('✅ Credentials 派生成功:');
  console.log(`   Key: ${creds.key.slice(0, 10)}...`);
  console.log(`   Secret: ${creds.secret.slice(0, 10)}...`);
  console.log(`   Passphrase: ${creds.passphrase.slice(0, 10)}...`);
  console.log(`   Wallet: ${address}`);

  const stored: StoredCredentials = {
    key: creds.key,
    secret: creds.secret,
    passphrase: creds.passphrase,
    walletAddress: address,
    derivedAt: new Date().toISOString(),
  };

  // 保存到文件
  writeFileSync(CREDS_FILE, JSON.stringify(stored, null, 2));
  console.log(`\n💾 Credentials 已保存到: ${CREDS_FILE}`);

  return stored;
}

async function testCredsOnlyOperations(creds: StoredCredentials): Promise<void> {
  console.log('\n=== Step 2: 仅用 Credentials 测试操作 ===\n');

  // 创建只用 credentials 的 SDK（使用 dummy 私钥）
  // 关键：传入 creds 参数，SDK 不会尝试派生新的 credentials
  const sdk = new PolymarketSDK({
    privateKey: '0x' + '1'.repeat(64), // dummy key
    chainId: 137,
    creds: {
      key: creds.key,
      secret: creds.secret,
      passphrase: creds.passphrase,
    },
  });

  console.log('📡 尝试初始化 SDK（仅用 credentials）...');

  try {
    // 初始化 - 这里不应该派生新的 credentials，而是使用传入的
    await sdk.initialize();
    console.log('✅ SDK 初始化成功（仅用 credentials）');
  } catch (error: any) {
    console.error('❌ SDK 初始化失败:', error.message);
    return;
  }

  // 测试获取 open orders（读操作）
  console.log('\n📋 测试: 获取 Open Orders...');
  try {
    const orders = await sdk.tradingService.getOpenOrders();
    console.log(`✅ 获取 Open Orders 成功: ${orders.length} 个订单`);
  } catch (error: any) {
    console.error('❌ 获取 Open Orders 失败:', error.message);
  }

  // 测试获取 trades（读操作）
  console.log('\n📋 测试: 获取 Trades...');
  try {
    const trades = await sdk.tradingService.getTrades();
    console.log(`✅ 获取 Trades 成功: ${trades.length} 条交易`);
  } catch (error: any) {
    console.error('❌ 获取 Trades 失败:', error.message);
  }

  // 测试获取余额
  console.log('\n💰 测试: 获取 USDC 余额...');
  try {
    const balance = await sdk.tradingService.getBalanceAllowance('COLLATERAL');
    console.log(`✅ USDC 余额: $${parseFloat(balance.balance) / 1e6}`);
    console.log(`   Allowance: $${parseFloat(balance.allowance) / 1e6}`);
  } catch (error: any) {
    console.error('❌ 获取余额失败:', error.message);
  }

  console.log('\n=== 结论 ===');
  console.log('如果上面的读操作成功，说明 CLOB credentials 可以独立使用');
  console.log('注意：下单操作可能需要 wallet 地址匹配 credentials');
}

async function main() {
  const privateKey = process.env.PRIVATE_KEY;

  // 检查是否有已保存的 credentials
  if (existsSync(CREDS_FILE)) {
    console.log(`\n📂 发现已保存的 credentials: ${CREDS_FILE}`);
    const stored = JSON.parse(readFileSync(CREDS_FILE, 'utf-8')) as StoredCredentials;
    console.log(`   派生时间: ${stored.derivedAt}`);
    console.log(`   钱包地址: ${stored.walletAddress}`);

    // 直接测试 credentials
    await testCredsOnlyOperations(stored);
    return;
  }

  // 没有保存的 credentials，需要私钥来派生
  if (!privateKey) {
    console.error('❌ 需要 PRIVATE_KEY 环境变量来派生 credentials');
    console.error('   用法: PRIVATE_KEY=0x... npx tsx scripts/test-creds-only.ts');
    process.exit(1);
  }

  // 派生并保存
  const creds = await deriveAndSaveCredentials(privateKey);

  // 测试
  await testCredsOnlyOperations(creds);
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
