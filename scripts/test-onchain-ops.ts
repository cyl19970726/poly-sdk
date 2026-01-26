#!/usr/bin/env npx tsx
/**
 * 链上操作测试 (split/merge/redeem)
 *
 * 这些操作都需要真实的 ETH 交易签名
 *
 * Usage:
 *   PRIVATE_KEY=0x... npx tsx scripts/test-onchain-ops.ts
 */

import { PolymarketSDK, OnchainService } from '../src/index.js';

async function main() {
  const privateKey = process.env.PRIVATE_KEY;

  if (!privateKey) {
    console.error('❌ 请设置环境变量: PRIVATE_KEY=0x...');
    process.exit(1);
  }

  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║     链上操作测试 (split/merge/redeem)                        ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  // 初始化 SDK
  const sdk = new PolymarketSDK({
    privateKey,
    chainId: 137,
  });

  await sdk.initialize();
  const address = sdk.tradingService.getAddress();
  console.log(`钱包: ${address}\n`);

  // 创建 OnchainService 用于链上操作
  const onchain = new OnchainService({ privateKey });

  // 1. 检查链上余额
  console.log('=== Step 1: 检查链上余额 ===\n');
  const balances = await onchain.getTokenBalances();
  console.log(`MATIC: ${balances.matic}`);
  console.log(`USDC (native): ${balances.usdc}`);
  console.log(`USDC.e (bridged): ${balances.usdcE}`);

  // 2. 检查授权状态
  console.log('\n=== Step 2: 检查授权状态 ===\n');
  const authStatus = await onchain.checkAllowances();

  console.log('ERC20 Allowances (USDC → Exchange):');
  for (const a of authStatus.erc20Allowances || []) {
    const name = (a.spender || a.contract || 'unknown').slice(0, 15) + '...';
    console.log(`  ${name}: ${a.hasEnough ? '✅' : '❌'}`);
  }

  console.log('\nERC1155 Approvals (CTF tokens):');
  for (const a of authStatus.erc1155Approvals || []) {
    const name = (a.operator || a.contract || 'unknown').slice(0, 15) + '...';
    console.log(`  ${name}: ${a.isApproved ? '✅' : '❌'}`);
  }

  console.log('\n整体状态:');
  console.log(`  Trading Ready: ${authStatus.tradingReady ? '✅' : '❌'}`);
  if (authStatus.issues?.length > 0) {
    console.log(`  Issues: ${authStatus.issues.join(', ')}`);
  }

  const allApproved = (authStatus.erc20Allowances || []).every(a => a.hasEnough) &&
                      (authStatus.erc1155Approvals || []).every(a => a.isApproved);

  if (!allApproved) {
    console.log('\n⚠️  部分授权未完成，链上操作可能失败');
  }

  // 3. 检查持仓
  console.log('\n=== Step 3: 检查当前持仓 ===\n');
  const positions = await sdk.dataApi.getPositions(address);
  console.log(`持仓数量: ${positions.length}`);

  if (positions.length > 0) {
    console.log('\n前 3 个持仓:');
    for (const pos of positions.slice(0, 3)) {
      console.log(`  - ${(pos.title || 'Unknown').slice(0, 40)}...`);
      console.log(`    Token: ${(pos.asset || 'N/A').slice(0, 20)}...`);
      console.log(`    Size: ${pos.size}`);
    }
  }

  // 4. 测试 CTF 操作 (只检查，不执行)
  console.log('\n=== Step 4: CTF 操作说明 ===\n');

  // 获取一个市场用于说明
  const conditionId = '0x7c6c69d91b21cbbea08a13d0ad51c0e96a956045aaadc77bce507c6b0475b66e';
  const resolved = await sdk.markets.resolveMarketTokens(conditionId);

  if (resolved) {
    console.log(`示例市场: ${conditionId.slice(0, 20)}...`);
    console.log(`  Primary Token (${resolved.primaryOutcome}): ${resolved.primaryTokenId.slice(0, 20)}...`);
    console.log(`  Secondary Token (${resolved.secondaryOutcome}): ${resolved.secondaryTokenId.slice(0, 20)}...`);
  }

  console.log('\n链上 CTF 操作:');
  console.log('┌─────────────────────────────────────────────────────────────────┐');
  console.log('│ 操作      │ 用途                    │ 签名需求              │');
  console.log('├─────────────────────────────────────────────────────────────────┤');
  console.log('│ split     │ USDC → YES + NO tokens │ ETH 交易签名          │');
  console.log('│ merge     │ YES + NO → USDC        │ ETH 交易签名          │');
  console.log('│ redeem    │ 胜利 token → USDC      │ ETH 交易签名          │');
  console.log('│ approve   │ 授权 exchange          │ ETH 交易签名          │');
  console.log('│ deposit   │ 充值到 Polymarket      │ ETH 交易签名          │');
  console.log('└─────────────────────────────────────────────────────────────────┘');

  // 5. 测试 split (如果有足够的 USDC.e)
  const usdceBalance = parseFloat(balances.usdcE || '0');

  if (usdceBalance >= 1) {
    console.log('\n=== Step 5: 测试 split 操作 ===\n');
    console.log(`USDC.e 余额: $${usdceBalance.toFixed(2)}`);
    console.log('⚠️  split 会消耗真实资金，跳过自动执行');
    console.log('\n手动测试命令:');
    console.log('```typescript');
    console.log(`await sdk.onchainService.split('${conditionId}', '1');  // split $1`);
    console.log('```');
  } else {
    console.log('\n=== Step 5: split 测试 (跳过) ===\n');
    console.log('⚠️  USDC.e 余额不足，无法测试 split');
  }

  // 6. 测试 merge (如果有持仓)
  if (positions.length > 0) {
    console.log('\n=== Step 6: 测试 merge 操作 ===\n');
    console.log('⚠️  merge 会消耗真实 tokens，跳过自动执行');
    console.log('\n手动测试命令 (需要同时持有 YES 和 NO):');
    console.log('```typescript');
    console.log(`await sdk.onchainService.merge('${positions[0].conditionId}', '1');`);
    console.log('```');
  }

  // 总结
  console.log('\n════════════════════════════════════════════════════════════════');
  console.log('链上操作总结:');
  console.log('');
  console.log('所有 CTF 操作都需要 ETH 交易签名:');
  console.log('  - split: 需要私钥签名交易');
  console.log('  - merge: 需要私钥签名交易');
  console.log('  - redeem: 需要私钥签名交易');
  console.log('');
  console.log('对于 Privy 集成:');
  console.log('  - 所有链上操作必须使用 Delegated Actions');
  console.log('  - 用户授权后，服务端通过 Privy Wallet API 签名');
  console.log('════════════════════════════════════════════════════════════════');
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
