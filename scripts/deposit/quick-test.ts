#!/usr/bin/env npx tsx
/**
 * Quick test for deposit functionality
 *
 * Usage:
 *   PRIVATE_KEY=0x... RPC_URL=https://... npx tsx scripts/deposit/quick-test.ts
 */

import { OnchainService, BridgeClient } from '../../src/index.js';

const PRIVATE_KEY = process.env.PRIVATE_KEY!;
const RPC_URL = process.env.RPC_URL;

async function main() {
  const onchain = new OnchainService({
    privateKey: PRIVATE_KEY,
    rpcUrl: RPC_URL
  });
  const bridge = new BridgeClient();

  console.log('Wallet:', onchain.getAddress());

  // Check balances
  console.log('\n--- Balances ---');
  const balances = await onchain.getTokenBalances();
  console.log('  MATIC:       ', balances.matic);
  console.log('  Native USDC: ', balances.usdc);
  console.log('  USDC.e:      ', balances.usdcE);

  // Check allowances
  console.log('\n--- Trading Status ---');
  const allowances = await onchain.checkAllowances();
  console.log('  Trading Ready:', allowances.tradingReady ? '✓' : '✗');
  if (allowances.issues.length > 0) {
    console.log('  Issues:', allowances.issues.join(', '));
  }

  // Check deposit addresses
  console.log('\n--- Deposit Addresses ---');
  const addresses = await bridge.createDepositAddresses(onchain.getAddress());
  console.log('  EVM:', addresses.address.evm);
  console.log('  SVM:', addresses.address.svm);
  console.log('  BTC:', addresses.address.btc);

  // Check deposit status
  console.log('\n--- Deposit History ---');
  const transactions = await bridge.getDepositStatus(addresses.address.evm);
  if (transactions.length === 0) {
    console.log('  No deposits found');
  } else {
    console.log(`  Found ${transactions.length} deposit(s):`);
    for (const tx of transactions.slice(0, 5)) {
      const date = new Date(tx.createdTimeMs).toLocaleString();
      const amountUsd = parseInt(tx.fromAmountBaseUnit) / 1e6;
      console.log(`  - ${tx.status}: $${amountUsd.toFixed(2)} (${date})`);
    }
  }
}

main().catch(console.error);
