#!/usr/bin/env npx tsx
/**
 * Test: CLOB Credentials with Stored Address
 *
 * 验证 CLOB API 是否可以用 stored credentials + stored address 操作（不需要私钥）
 *
 * 关键发现：
 * - POLY_SIGNATURE = HMAC (用 creds.secret 计算，不需要私钥)
 * - POLY_ADDRESS = signer.getAddress() (来自 wallet)
 *
 * 假设：
 * 1. 如果能创建一个 mock signer，只提供 getAddress() 返回正确地址
 * 2. 那么 L2 CLOB 操作应该能工作（因为 HMAC 签名不需要私钥）
 *
 * 测试流程：
 * 1. 读取保存的 credentials（包含 wallet address）
 * 2. 创建 mock signer，getAddress() 返回保存的地址
 * 3. 直接使用 @polymarket/clob-client 测试 L2 操作
 */

import { ClobClient } from '@polymarket/clob-client';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const CREDS_FILE = join(process.cwd(), '.test-creds.json');
const CLOB_HOST = 'https://clob.polymarket.com';
const POLYGON_CHAIN_ID = 137;

interface StoredCredentials {
  key: string;
  secret: string;
  passphrase: string;
  walletAddress: string;
  derivedAt: string;
}

/**
 * 创建 Mock Signer
 *
 * 只提供 getAddress() 方法，不需要真实私钥
 * 用于验证 L2 HMAC 签名是否能独立工作
 */
function createMockSigner(address: string) {
  return {
    getAddress: async () => address,
    // 其他方法如果被调用会报错，这正是我们想验证的
    signMessage: async () => {
      throw new Error('Mock signer cannot sign messages - this operation requires private key');
    },
    signTransaction: async () => {
      throw new Error('Mock signer cannot sign transactions - this operation requires private key');
    },
    // 模拟 ethers Wallet 的 provider 属性
    provider: null,
    // 模拟 ethers Wallet 的 address 属性 (getter)
    get address() {
      return address;
    },
  };
}

async function testWithMockSigner(creds: StoredCredentials): Promise<void> {
  console.log('\n=== 测试: 使用 Mock Signer + Stored Credentials ===\n');
  console.log(`Credentials 钱包地址: ${creds.walletAddress}`);
  console.log(`Credentials 派生时间: ${creds.derivedAt}`);

  // 创建 mock signer
  const mockSigner = createMockSigner(creds.walletAddress);
  console.log('\n✅ 创建 Mock Signer (只有 getAddress()，无私钥)');

  // 使用 mock signer 创建 CLOB client
  console.log('\n📡 创建 CLOB Client...');

  try {
    // @ts-ignore - ClobClient 期望 Wallet 类型，但我们传入 mock signer
    const client = new ClobClient(
      CLOB_HOST,
      POLYGON_CHAIN_ID,
      mockSigner as any,
      {
        key: creds.key,
        secret: creds.secret,
        passphrase: creds.passphrase,
      }
    );

    console.log('✅ CLOB Client 创建成功');

    // 测试 L2 读操作 - getOpenOrders
    console.log('\n📋 测试 L2: 获取 Open Orders (需要认证)...');
    try {
      const orders = await client.getOpenOrders();
      console.log(`✅ 获取 Open Orders 成功: ${orders.length} 个订单`);
      if (orders.length > 0) {
        console.log(`   第一个订单: ${JSON.stringify(orders[0], null, 2).slice(0, 200)}...`);
      }
    } catch (error: any) {
      console.error('❌ 获取 Open Orders 失败:', error.message);
      // 打印响应详情
      if (error.response) {
        console.error('   Response status:', error.response.status);
        console.error('   Response data:', JSON.stringify(error.response.data, null, 2));
      }
    }

    // 测试 L2 读操作 - getTrades
    console.log('\n📋 测试 L2: 获取 Trades (需要认证)...');
    try {
      const trades = await client.getTrades();
      console.log(`✅ 获取 Trades 成功: ${trades.length} 条交易`);
    } catch (error: any) {
      console.error('❌ 获取 Trades 失败:', error.message);
    }

    // 测试 L2 读操作 - getBalanceAllowance
    console.log('\n💰 测试 L2: 获取 Balance (需要认证)...');
    try {
      const balance = await client.getBalanceAllowance({ asset_type: 'COLLATERAL' as any });
      console.log(`✅ Balance: ${parseFloat(balance.balance) / 1e6} USDC`);
      console.log(`   Allowance: ${parseFloat(balance.allowance) / 1e6} USDC`);
    } catch (error: any) {
      console.error('❌ 获取 Balance 失败:', error.message);
    }

  } catch (error: any) {
    console.error('❌ CLOB Client 创建失败:', error.message);
  }
}

async function testL1Operations(creds: StoredCredentials): Promise<void> {
  console.log('\n=== 测试: L1 操作 (需要签名) ===\n');

  const mockSigner = createMockSigner(creds.walletAddress);

  try {
    // @ts-ignore
    const client = new ClobClient(CLOB_HOST, POLYGON_CHAIN_ID, mockSigner as any);

    // 测试 deriveApiKey - 这是 L1 操作，需要 EIP-712 签名
    console.log('📝 测试 L1: deriveApiKey (需要 EIP-712 签名)...');
    try {
      const apiKey = await client.deriveApiKey();
      console.log('✅ deriveApiKey 成功:', apiKey);
    } catch (error: any) {
      console.log('❌ deriveApiKey 失败 (预期，因为 mock signer 不能签名)');
      console.log(`   错误: ${error.message}`);
    }
  } catch (error: any) {
    console.error('❌ 测试失败:', error.message);
  }
}

async function main() {
  // 检查是否有保存的 credentials
  if (!existsSync(CREDS_FILE)) {
    console.error(`❌ 未找到 credentials 文件: ${CREDS_FILE}`);
    console.error('   请先运行: PRIVATE_KEY=0x... npx tsx scripts/test-creds-only.ts');
    process.exit(1);
  }

  const creds = JSON.parse(readFileSync(CREDS_FILE, 'utf-8')) as StoredCredentials;

  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║     CLOB Credentials-Only 验证测试                           ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log('║  问题: 能否只用 credentials + address，不需要私钥？          ║');
  console.log('║  方案: 创建 mock signer，只提供 getAddress()                ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');

  // 测试 L2 操作（HMAC 签名，应该不需要私钥）
  await testWithMockSigner(creds);

  // 测试 L1 操作（EIP-712 签名，需要私钥）
  await testL1Operations(creds);

  console.log('\n=== 结论 ===\n');
  console.log('如果 L2 操作成功:');
  console.log('  → CLOB 下单/撤单可以只用 credentials + address');
  console.log('  → 私钥只在首次 derive 时需要');
  console.log('  → Privy Delegated Actions 只需处理 L1 (derive) 和 On-chain 操作');
  console.log('\n如果 L2 操作失败:');
  console.log('  → 每次 CLOB 操作都需要私钥');
  console.log('  → Privy Delegated Actions 需要处理所有操作');
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
