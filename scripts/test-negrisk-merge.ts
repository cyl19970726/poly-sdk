#!/usr/bin/env npx tsx
/**
 * E2E Test: Merge via CTFClient (Standard + NegRisk)
 *
 * Tests mergeByTokenIds for both standard CTF and NegRisk markets.
 * Queries the CLOB API to determine if the market is NegRisk,
 * then passes the flag explicitly.
 *
 * Usage (with wallet system):
 *   WALLET_ADDRESS=0x752901... npx tsx scripts/test-negrisk-merge.ts
 *
 * Usage (with direct key):
 *   PRIVATE_KEY=0x... npx tsx scripts/test-negrisk-merge.ts
 *
 * Required env vars (from .env):
 *   - POLYGON_RPC_URL
 *   - WALLET_ENCRYPTION_KEY (when using WALLET_ADDRESS)
 *
 * Test flow:
 *   1. Query CLOB API to determine neg_risk flag
 *   2. Check balance at CLOB token IDs
 *   3. Merge small amount via mergeByTokenIds (passes isNegRisk explicitly)
 *   4. Verify balance decreased and USDC increased
 */

import { CTFClient } from '../src/clients/ctf-client.js';
import { resolve } from 'node:path';

// ======= Configuration =======

// Monoline FUT vs PV market (standard CTF, neg_risk=false)
const CONDITION_ID = '0x6498159d253a7f5c305264d0b68ca53bd8e30f9bd451a617d1bbc483b5b6f10a';
const TOKEN_IDS = {
  yesTokenId: '96604699770614701613304832744987771366565286043892398776344969979961648002024',
  noTokenId: '4293155955248146015788513757683601555029963724066356360902198499071458481627',
};

// Small test amount — will be capped by min(YES, NO) balance
const TEST_AMOUNT = '0.5';

async function queryNegRisk(tokenId: string): Promise<boolean> {
  try {
    const url = `https://clob.polymarket.com/markets/${tokenId}`;
    const resp = await fetch(url);
    if (!resp.ok) {
      console.warn(`CLOB API returned ${resp.status}, assuming neg_risk=false`);
      return false;
    }
    const data = await resp.json();
    const negRisk = data.neg_risk === true;
    console.log(`CLOB API neg_risk: ${negRisk} (condition: ${data.condition_id?.slice(0, 20)}...)`);
    return negRisk;
  } catch (error: any) {
    console.warn(`Failed to query CLOB API: ${error.message}, assuming neg_risk=false`);
    return false;
  }
}

async function resolveKey(): Promise<string> {
  // Option 1: Direct PRIVATE_KEY
  if (process.env.PRIVATE_KEY && !process.env.WALLET_ADDRESS) {
    return process.env.PRIVATE_KEY;
  }

  // Option 2: Resolve from wallet store
  const walletAddress = process.env.WALLET_ADDRESS;
  const encryptionKey = process.env.WALLET_ENCRYPTION_KEY;

  if (!walletAddress) {
    throw new Error('Set PRIVATE_KEY or WALLET_ADDRESS env var');
  }
  if (!encryptionKey) {
    throw new Error('WALLET_ENCRYPTION_KEY required when using WALLET_ADDRESS');
  }

  // Dynamic import to avoid hard dependency on wallet package
  const { HotWalletService } = await import('@catalyst-team/poly-sdk');
  const walletDir = resolve(process.cwd(), '..', 'wallets');
  const { FileWalletStore } = await import(resolve(process.cwd(), '..', 'wallet', 'dist', 'file-wallet-store.js'));
  const store = new FileWalletStore(resolve(walletDir, 'wallets.encrypted.json'));
  const service = new HotWalletService({
    encryptionKey,
    store,
    rpcUrl: process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com',
  });

  const key = await service.getPrivateKey(walletAddress);
  if (!key) throw new Error(`Wallet ${walletAddress} not found in store`);
  return key;
}

async function main() {
  const rpcUrl = process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com';
  const privateKey = await resolveKey();

  console.log('=== CTF Merge E2E Test ===\n');

  // Step 1: Query CLOB API for neg_risk flag
  const isNegRisk = await queryNegRisk(TOKEN_IDS.yesTokenId);

  const ctf = new CTFClient({ privateKey, rpcUrl });
  const address = ctf.getAddress();
  console.log(`Wallet: ${address}`);

  // Step 2: Check USDC balance
  const usdcBefore = await ctf.getUsdcBalance();
  console.log(`USDC.e balance: ${usdcBefore}`);

  // Step 3: Check token balance at CLOB token IDs
  const clobBalances = await ctf.getPositionBalanceByTokenIds(CONDITION_ID, TOKEN_IDS);
  console.log(`\nCLOB token balances:`);
  console.log(`  YES (${TOKEN_IDS.yesTokenId.slice(0, 10)}...): ${clobBalances.yesBalance}`);
  console.log(`  NO  (${TOKEN_IDS.noTokenId.slice(0, 10)}...): ${clobBalances.noBalance}`);

  // Step 4: Determine merge amount (min of YES, NO, TEST_AMOUNT)
  const yesBalance = parseFloat(clobBalances.yesBalance);
  const noBalance = parseFloat(clobBalances.noBalance);
  const pairable = Math.min(yesBalance, noBalance);
  const mergeAmount = Math.min(pairable, parseFloat(TEST_AMOUNT));

  if (mergeAmount < 0.01) {
    console.error(`\nInsufficient paired balance. YES=${yesBalance}, NO=${noBalance}, pairable=${pairable}`);
    process.exit(1);
  }

  // Step 5: Merge via mergeByTokenIds with explicit isNegRisk
  const mergeStr = mergeAmount.toFixed(6);
  console.log(`\n--- Merging ${mergeStr} tokens via mergeByTokenIds (negRisk: ${isNegRisk}) ---`);
  try {
    const result = await ctf.mergeByTokenIds(CONDITION_ID, TOKEN_IDS, mergeStr, isNegRisk);
    console.log(`\u2705 Merge succeeded!`);
    console.log(`  TX: ${result.txHash}`);
    console.log(`  Amount: ${result.amount}`);
    console.log(`  USDC received: ${result.usdcReceived}`);
    console.log(`  Gas used: ${result.gasUsed}`);
  } catch (error: any) {
    console.error(`\u274C Merge failed: ${error.message}`);
    process.exit(1);
  }

  // Step 6: Verify balance changes
  const usdcAfter = await ctf.getUsdcBalance();
  const clobBalancesAfter = await ctf.getPositionBalanceByTokenIds(CONDITION_ID, TOKEN_IDS);

  console.log(`\n--- Balance verification ---`);
  console.log(`USDC.e: ${usdcBefore} \u2192 ${usdcAfter} (diff: +${(parseFloat(usdcAfter) - parseFloat(usdcBefore)).toFixed(6)})`);
  console.log(`YES tokens: ${clobBalances.yesBalance} \u2192 ${clobBalancesAfter.yesBalance}`);
  console.log(`NO tokens:  ${clobBalances.noBalance} \u2192 ${clobBalancesAfter.noBalance}`);

  const usdcDiff = parseFloat(usdcAfter) - parseFloat(usdcBefore);
  if (usdcDiff >= mergeAmount * 0.99) {
    console.log(`\n\u2705 E2E test PASSED — merge works correctly!`);
  } else {
    console.log(`\n\u26A0\uFE0F  USDC increase (${usdcDiff.toFixed(6)}) less than expected (${mergeStr})`);
  }
}

main().catch(console.error);
