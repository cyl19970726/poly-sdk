#!/usr/bin/env npx tsx
/**
 * Test Deposit Status API
 *
 * Tests the new BridgeClient deposit status methods:
 * - getSupportedAssets()
 * - createDepositAddresses()
 * - getDepositStatus()
 * - getLatestDeposit()
 *
 * Usage:
 *   npx tsx scripts/deposit/test-deposit-status.ts [wallet-address]
 *
 * If no wallet address is provided, uses a sample address.
 */

import { BridgeClient } from '../../src/index.js';

// Sample wallet for testing (can be any valid address)
const SAMPLE_WALLET = '0x56687bf447db6ffa42ffe2204a05edaa20f55839';

async function main() {
  const walletAddress = process.argv[2] || SAMPLE_WALLET;
  const bridge = new BridgeClient();

  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║           Bridge Deposit Status API Test                      ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  // ===== Test 1: Get Supported Assets =====
  console.log('1. Testing getSupportedAssets()...');
  try {
    const assets = await bridge.getSupportedAssets();
    console.log(`   ✓ Found ${assets.length} supported assets\n`);

    // Group by chain
    const byChain = new Map<string, typeof assets>();
    for (const asset of assets) {
      const list = byChain.get(asset.chainName) || [];
      list.push(asset);
      byChain.set(asset.chainName, list);
    }

    for (const [chain, chainAssets] of byChain) {
      console.log(`   ${chain}:`);
      for (const asset of chainAssets.slice(0, 3)) {
        console.log(`     - ${asset.tokenSymbol}: min $${asset.minDepositUsd}`);
      }
      if (chainAssets.length > 3) {
        console.log(`     ... and ${chainAssets.length - 3} more`);
      }
    }
    console.log();
  } catch (err) {
    console.log(`   ✗ Error: ${err instanceof Error ? err.message : err}\n`);
  }

  // ===== Test 2: Create Deposit Addresses =====
  console.log('2. Testing createDepositAddresses()...');
  let depositAddresses: Awaited<ReturnType<typeof bridge.createDepositAddresses>> | null = null;
  try {
    depositAddresses = await bridge.createDepositAddresses(walletAddress);
    console.log(`   ✓ Deposit addresses created for ${walletAddress}\n`);
    console.log(`   EVM:  ${depositAddresses.address.evm}`);
    console.log(`   SVM:  ${depositAddresses.address.svm}`);
    console.log(`   BTC:  ${depositAddresses.address.btc}\n`);
  } catch (err) {
    console.log(`   ✗ Error: ${err instanceof Error ? err.message : err}\n`);
  }

  // ===== Test 3: Get Deposit Status =====
  if (depositAddresses) {
    console.log('3. Testing getDepositStatus()...');
    try {
      const transactions = await bridge.getDepositStatus(depositAddresses.address.evm);
      console.log(`   ✓ Found ${transactions.length} transactions\n`);

      if (transactions.length > 0) {
        console.log('   Recent deposits:');
        for (const tx of transactions.slice(0, 5)) {
          const status = BridgeClient.getStatusDescription(tx.status);
          const date = new Date(tx.createdTimeMs).toISOString();
          console.log(`     - ${tx.status}: ${status}`);
          console.log(`       Amount: ${tx.fromAmountBaseUnit} (chain ${tx.fromChainId})`);
          console.log(`       Created: ${date}`);
          if (tx.txHash) {
            console.log(`       Tx: ${tx.txHash.slice(0, 20)}...`);
          }
          console.log();
        }
      } else {
        console.log('   No deposits found for this address.\n');
        console.log('   (This is expected if you haven\'t sent funds to the deposit address yet)\n');
      }
    } catch (err) {
      console.log(`   ✗ Error: ${err instanceof Error ? err.message : err}\n`);
    }

    // ===== Test 4: Get Latest Deposit =====
    console.log('4. Testing getLatestDeposit()...');
    try {
      const latest = await bridge.getLatestDeposit(depositAddresses.address.evm);
      if (latest) {
        console.log(`   ✓ Latest deposit found\n`);
        console.log(`   Status: ${latest.status}`);
        console.log(`   Description: ${BridgeClient.getStatusDescription(latest.status)}`);
      } else {
        console.log('   No deposits found.\n');
      }
    } catch (err) {
      console.log(`   ✗ Error: ${err instanceof Error ? err.message : err}\n`);
    }

    // ===== Test 5: Status Check Helpers =====
    console.log('5. Testing status check helpers...');
    try {
      const isCompleted = await bridge.isDepositCompleted(depositAddresses.address.evm);
      const isFailed = await bridge.isDepositFailed(depositAddresses.address.evm);
      console.log(`   isDepositCompleted: ${isCompleted}`);
      console.log(`   isDepositFailed: ${isFailed}\n`);
    } catch (err) {
      console.log(`   ✗ Error: ${err instanceof Error ? err.message : err}\n`);
    }
  }

  // ===== Test 6: Status Description Helper =====
  console.log('6. Testing getStatusDescription() (static)...');
  const statuses = [
    'DEPOSIT_DETECTED',
    'PROCESSING',
    'ORIGIN_TX_CONFIRMED',
    'SUBMITTED',
    'COMPLETED',
    'FAILED',
  ] as const;

  for (const status of statuses) {
    console.log(`   ${status.padEnd(20)} → ${BridgeClient.getStatusDescription(status)}`);
  }
  console.log();

  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║                    All Tests Complete                         ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
}

main().catch(console.error);
