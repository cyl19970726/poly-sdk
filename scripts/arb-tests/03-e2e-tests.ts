#!/usr/bin/env npx tsx
/**
 * E2E Test Script for CTF Operations
 *
 * Tests complete workflow with real private key:
 * 1. Wallet connection and balance query
 * 2. CTF checkReadyForCTF()
 * 3. CTF Split operation (small amount: $5)
 * 4. CTF Merge operation (merge back the split tokens)
 * 5. clearPositions() dry run
 *
 * ⚠️ SAFETY:
 * - Uses small amounts ($5 max) for safety
 * - Always do dry run first for clearPositions
 * - Real on-chain transactions with real funds
 *
 * Environment:
 *   PRIVATE_KEY - Private key (from .env file)
 *   POLYGON_RPC_URL - Optional RPC URL (default: https://polygon-rpc.com)
 *
 * Run with:
 *   npx tsx scripts/arb-tests/03-e2e-tests.ts
 *
 * Based on:
 * - examples/10-ctf-operations.ts
 * - examples/13-arbitrage-service.ts
 */

import { config } from 'dotenv';
import path from 'path';
import {
  CTFClient,
  PolymarketSDK,
  ArbitrageService,
  CTF_CONTRACT,
  USDC_CONTRACT,
  NATIVE_USDC_CONTRACT,
  formatUSDC,
} from '../../src/index.js';
import type { ArbitrageMarketConfig, TokenIds } from '../../src/index.js';

// Load .env from package root
config({ path: path.resolve(process.cwd(), '.env') });

// ===== Configuration =====

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const RPC_URL = process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com';
const TEST_AMOUNT = '5'; // $5 for safety
const MIN_MATIC_BALANCE = 0.01; // Minimum MATIC for gas

// ===== Test State =====

interface TestResult {
  name: string;
  status: 'PASS' | 'FAIL' | 'SKIP';
  duration?: number;
  error?: string;
  data?: any;
}

const results: TestResult[] = [];
let ctfClient: CTFClient;
let sdk: PolymarketSDK;
let testMarket: ArbitrageMarketConfig | null = null;

// ===== Helper Functions =====

function printHeader(title: string) {
  console.log('\n' + '='.repeat(70));
  console.log(title);
  console.log('='.repeat(70));
}

function printSubHeader(title: string) {
  console.log('\n' + '-'.repeat(70));
  console.log(title);
  console.log('-'.repeat(70));
}

function logTest(name: string) {
  console.log(`\n[TEST] ${name}`);
}

function recordResult(name: string, status: 'PASS' | 'FAIL' | 'SKIP', duration?: number, error?: string, data?: any) {
  results.push({ name, status, duration, error, data });

  const statusSymbol = status === 'PASS' ? '✅' : status === 'FAIL' ? '❌' : '⏭️ ';
  const durationStr = duration !== undefined ? ` (${duration}ms)` : '';
  console.log(`${statusSymbol} ${name}${durationStr}`);

  if (error) {
    console.log(`   Error: ${error}`);
  }
}

function printSummary() {
  printHeader('TEST SUMMARY');

  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  const skipped = results.filter(r => r.status === 'SKIP').length;
  const total = results.length;

  console.log(`\nTotal: ${total} | Passed: ${passed} | Failed: ${failed} | Skipped: ${skipped}`);
  console.log('');

  results.forEach(r => {
    const statusSymbol = r.status === 'PASS' ? '✅' : r.status === 'FAIL' ? '❌' : '⏭️ ';
    console.log(`${statusSymbol} ${r.name}`);
    if (r.error) {
      console.log(`   ${r.error}`);
    }
  });

  console.log('');
  process.exit(failed > 0 ? 1 : 0);
}

// ===== Test Functions =====

async function test1_WalletConnection() {
  logTest('Test 1: Wallet Connection and Balance Query');
  const start = Date.now();

  try {
    if (!PRIVATE_KEY) {
      throw new Error('PRIVATE_KEY not set in .env file');
    }

    // Initialize CTF Client
    ctfClient = new CTFClient({
      privateKey: PRIVATE_KEY,
      rpcUrl: RPC_URL,
    });

    const address = ctfClient.getAddress();
    console.log(`   Wallet Address: ${address}`);
    console.log(`   RPC URL: ${RPC_URL}`);

    // Get balances
    const [usdcE, nativeUsdc, maticBigNumber] = await Promise.all([
      ctfClient.getUsdcBalance(),
      ctfClient.getNativeUsdcBalance(),
      ctfClient['provider'].getBalance(address),
    ]);

    // Convert BigNumber to ether string
    const matic = parseFloat((await import('ethers')).ethers.utils.formatEther(maticBigNumber));

    console.log(`\n   Balances:`);
    console.log(`   ├─ USDC.e (CTF):     $${parseFloat(usdcE).toFixed(4)}`);
    console.log(`   ├─ Native USDC:      $${parseFloat(nativeUsdc).toFixed(4)}`);
    console.log(`   └─ MATIC (gas):      ${matic.toFixed(4)}`);

    console.log(`\n   Contract Addresses:`);
    console.log(`   ├─ CTF:              ${CTF_CONTRACT}`);
    console.log(`   ├─ USDC.e:           ${USDC_CONTRACT}`);
    console.log(`   └─ Native USDC:      ${NATIVE_USDC_CONTRACT}`);

    // Validate minimum balances
    if (matic < MIN_MATIC_BALANCE) {
      throw new Error(`Insufficient MATIC for gas. Have: ${matic.toFixed(4)}, Need: ${MIN_MATIC_BALANCE}`);
    }

    recordResult('Test 1: Wallet Connection', 'PASS', Date.now() - start, undefined, {
      address,
      usdcE: parseFloat(usdcE),
      nativeUsdc: parseFloat(nativeUsdc),
      matic,
    });
  } catch (error) {
    recordResult('Test 1: Wallet Connection', 'FAIL', Date.now() - start, String(error));
    throw error;
  }
}

async function test2_CheckReadyForCTF() {
  logTest('Test 2: CTF checkReadyForCTF()');
  const start = Date.now();

  try {
    const readiness = await ctfClient.checkReadyForCTF(TEST_AMOUNT);

    console.log(`\n   CTF Readiness Check (for $${TEST_AMOUNT}):`);
    console.log(`   ├─ USDC.e Balance:   $${readiness.usdcEBalance}`);
    console.log(`   ├─ Native USDC:      $${readiness.nativeUsdcBalance}`);
    console.log(`   ├─ MATIC Balance:    ${readiness.maticBalance}`);
    console.log(`   └─ CTF Ready:        ${readiness.ready ? '✅ Yes' : '❌ No'}`);

    if (readiness.suggestion) {
      console.log(`\n   ⚠️  ${readiness.suggestion}`);
    }

    if (!readiness.ready) {
      recordResult('Test 2: CTF Readiness Check', 'SKIP', Date.now() - start, 'Not ready for CTF operations', readiness);
      return false;
    }

    recordResult('Test 2: CTF Readiness Check', 'PASS', Date.now() - start, undefined, readiness);
    return true;
  } catch (error) {
    recordResult('Test 2: CTF Readiness Check', 'FAIL', Date.now() - start, String(error));
    throw error;
  }
}

async function test3_FindActiveMarket() {
  logTest('Test 3: Find Active Market for Testing');
  const start = Date.now();

  try {
    sdk = new PolymarketSDK();

    // Find an active market with reasonable volume
    const markets = await sdk.gammaApi.getMarkets({
      closed: false,
      active: true,
      limit: 20,
    });

    if (markets.length === 0) {
      throw new Error('No active markets found');
    }

    // Find market with orderbook
    let selectedMarket = null;

    for (const market of markets) {
      try {
        const clobMarket = await sdk.clobApi.getMarket(market.conditionId);
        if (clobMarket.tokens.length !== 2) {
          continue;
        }

        const [yesToken, noToken] = clobMarket.tokens;

        if (clobMarket.active && clobMarket.acceptingOrders) {
          selectedMarket = {
            market,
            yesTokenId: yesToken.tokenId,
            noTokenId: noToken.tokenId,
          };
          break;
        }
      } catch {
        // Skip markets without orderbook
        continue;
      }
    }

    if (!selectedMarket) {
      throw new Error('No suitable market found with orderbook');
    }

    testMarket = {
      name: selectedMarket.market.question || 'Unknown Market',
      conditionId: selectedMarket.market.conditionId,
      yesTokenId: selectedMarket.yesTokenId,
      noTokenId: selectedMarket.noTokenId,
    };

    console.log(`\n   Selected Market:`);
    console.log(`   ├─ Question:         ${testMarket.name.slice(0, 50)}...`);
    console.log(`   ├─ Condition ID:     ${testMarket.conditionId}`);
    console.log(`   ├─ YES Token ID:     ${testMarket.yesTokenId.slice(0, 20)}...`);
    console.log(`   └─ NO Token ID:      ${testMarket.noTokenId.slice(0, 20)}...`);

    recordResult('Test 3: Find Active Market', 'PASS', Date.now() - start, undefined, {
      question: testMarket.name,
      conditionId: testMarket.conditionId,
    });
    return true;
  } catch (error) {
    recordResult('Test 3: Find Active Market', 'FAIL', Date.now() - start, String(error));
    return false;
  }
}

async function test4_SplitOperation() {
  logTest(`Test 4: CTF Split Operation ($${TEST_AMOUNT})`);
  const start = Date.now();

  try {
    if (!testMarket) {
      throw new Error('No test market available');
    }

    console.log(`\n   Splitting $${TEST_AMOUNT} USDC into YES + NO tokens...`);
    console.log(`   Market: ${testMarket.conditionId}`);

    // Check balance before
    const balanceBefore = await ctfClient.getUsdcBalance();
    console.log(`   Balance before: $${balanceBefore}`);

    // Execute split
    const splitResult = await ctfClient.split(testMarket.conditionId, TEST_AMOUNT);

    console.log(`\n   ✅ Split successful!`);
    console.log(`   ├─ TX Hash:          ${splitResult.txHash}`);
    console.log(`   ├─ Amount:           ${splitResult.amount} USDC`);
    console.log(`   ├─ YES Tokens:       ${splitResult.yesTokens}`);
    console.log(`   ├─ NO Tokens:        ${splitResult.noTokens}`);
    console.log(`   └─ Gas Used:         ${splitResult.gasUsed}`);

    // Check balance after
    const balanceAfter = await ctfClient.getUsdcBalance();
    const balanceChange = parseFloat(balanceBefore) - parseFloat(balanceAfter);
    console.log(`   Balance after:  $${balanceAfter} (spent: $${balanceChange.toFixed(4)})`);

    // Wait for blockchain to settle
    console.log(`\n   Waiting 2s for blockchain to settle...`);
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Verify token balances
    const tokenIds: TokenIds = {
      yesTokenId: testMarket.yesTokenId,
      noTokenId: testMarket.noTokenId,
    };

    const positions = await ctfClient.getPositionBalanceByTokenIds(testMarket.conditionId, tokenIds);
    console.log(`\n   Token Positions:`);
    console.log(`   ├─ YES Balance:      ${positions.yesBalance}`);
    console.log(`   └─ NO Balance:       ${positions.noBalance}`);

    recordResult('Test 4: CTF Split', 'PASS', Date.now() - start, undefined, {
      txHash: splitResult.txHash,
      amount: splitResult.amount,
      gasUsed: splitResult.gasUsed,
    });
    return true;
  } catch (error) {
    recordResult('Test 4: CTF Split', 'FAIL', Date.now() - start, String(error));
    return false;
  }
}

async function test5_MergeOperation() {
  logTest(`Test 5: CTF Merge Operation (merge back $${TEST_AMOUNT})`);
  const start = Date.now();

  try {
    if (!testMarket) {
      throw new Error('No test market available');
    }

    console.log(`\n   Merging ${TEST_AMOUNT} YES + ${TEST_AMOUNT} NO → $${TEST_AMOUNT} USDC...`);
    console.log(`   Market: ${testMarket.conditionId}`);

    // Check balance before
    const balanceBefore = await ctfClient.getUsdcBalance();
    console.log(`   USDC balance before: $${balanceBefore}`);

    // Execute merge
    const tokenIds: TokenIds = {
      yesTokenId: testMarket.yesTokenId,
      noTokenId: testMarket.noTokenId,
    };

    // Check token balances before merge
    const positionsBefore = await ctfClient.getPositionBalanceByTokenIds(testMarket.conditionId, tokenIds);
    console.log(`   Token positions before merge:`);
    console.log(`   ├─ YES:              ${positionsBefore.yesBalance}`);
    console.log(`   └─ NO:               ${positionsBefore.noBalance}`);

    const mergeResult = await ctfClient.mergeByTokenIds(
      testMarket.conditionId,
      tokenIds,
      TEST_AMOUNT
    );

    console.log(`\n   ✅ Merge successful!`);
    console.log(`   ├─ TX Hash:          ${mergeResult.txHash}`);
    console.log(`   ├─ Amount:           ${mergeResult.amount} pairs`);
    console.log(`   ├─ USDC Received:    $${mergeResult.usdcReceived}`);
    console.log(`   └─ Gas Used:         ${mergeResult.gasUsed}`);

    // Check balance after
    const balanceAfter = await ctfClient.getUsdcBalance();
    const balanceChange = parseFloat(balanceAfter) - parseFloat(balanceBefore);
    console.log(`   USDC balance after:  $${balanceAfter} (recovered: $${balanceChange.toFixed(4)})`);

    // Verify token balances
    const positions = await ctfClient.getPositionBalanceByTokenIds(testMarket.conditionId, tokenIds);
    console.log(`\n   Token Positions (remaining):`);
    console.log(`   ├─ YES Balance:      ${positions.yesBalance}`);
    console.log(`   └─ NO Balance:       ${positions.noBalance}`);

    recordResult('Test 5: CTF Merge', 'PASS', Date.now() - start, undefined, {
      txHash: mergeResult.txHash,
      usdcReceived: mergeResult.usdcReceived,
      gasUsed: mergeResult.gasUsed,
    });
    return true;
  } catch (error) {
    recordResult('Test 5: CTF Merge', 'FAIL', Date.now() - start, String(error));
    return false;
  }
}

async function test6_ClearPositionsDryRun() {
  logTest('Test 6: clearPositions() Dry Run');
  const start = Date.now();

  try {
    if (!testMarket) {
      throw new Error('No test market available');
    }

    // Initialize ArbitrageService for clearPositions
    const arbService = new ArbitrageService({
      privateKey: PRIVATE_KEY,
      rpcUrl: RPC_URL,
      enableLogging: false,
    });

    console.log(`\n   Running clearPositions dry run...`);
    console.log(`   Market: ${testMarket.name.slice(0, 50)}...`);

    // Execute dry run (execute = false)
    const clearResult = await arbService.clearPositions(testMarket, false);

    console.log(`\n   Clear Positions Analysis:`);
    console.log(`   ├─ Market Status:    ${clearResult.marketStatus}`);
    console.log(`   ├─ YES Balance:      ${clearResult.yesBalance.toFixed(4)}`);
    console.log(`   ├─ NO Balance:       ${clearResult.noBalance.toFixed(4)}`);
    console.log(`   ├─ Recovery Est:     $${clearResult.totalUsdcRecovered.toFixed(4)}`);
    console.log(`   └─ Actions Planned:  ${clearResult.actions.length}`);

    if (clearResult.actions.length > 0) {
      console.log(`\n   Planned Actions:`);
      clearResult.actions.forEach((action, i) => {
        console.log(`   ${i + 1}. ${action.type}: ${action.amount.toFixed(4)} → ~$${action.usdcResult.toFixed(4)}`);
      });
    } else {
      console.log(`\n   No actions needed (positions already clear)`);
    }

    recordResult('Test 6: clearPositions Dry Run', 'PASS', Date.now() - start, undefined, {
      yesBalance: clearResult.yesBalance,
      noBalance: clearResult.noBalance,
      actions: clearResult.actions.length,
      totalRecovery: clearResult.totalUsdcRecovered,
    });
    return true;
  } catch (error) {
    recordResult('Test 6: clearPositions Dry Run', 'FAIL', Date.now() - start, String(error));
    return false;
  }
}

// ===== Main Test Runner =====

async function main() {
  printHeader('E2E CTF Operations Test Suite');
  console.log('');
  console.log('⚠️  WARNING: This script executes real on-chain transactions!');
  console.log(`   Test amount: $${TEST_AMOUNT} (small for safety)`);
  console.log(`   RPC URL: ${RPC_URL}`);
  console.log('');

  try {
    // Test 1: Wallet Connection
    await test1_WalletConnection();

    // Test 2: CTF Readiness Check
    const isReady = await test2_CheckReadyForCTF();

    if (!isReady) {
      console.log('\n⚠️  Wallet not ready for CTF operations. Skipping remaining tests.');
      printSummary();
      return;
    }

    // Test 3: Find Active Market
    const hasMarket = await test3_FindActiveMarket();

    if (!hasMarket) {
      console.log('\n⚠️  No suitable market found. Skipping CTF operation tests.');
      printSummary();
      return;
    }

    // Test 4: Split Operation
    const splitSuccess = await test4_SplitOperation();

    if (!splitSuccess) {
      console.log('\n⚠️  Split failed. Skipping merge test.');
      printSummary();
      return;
    }

    // Test 5: Merge Operation
    await test5_MergeOperation();

    // Test 6: Clear Positions Dry Run
    await test6_ClearPositionsDryRun();

  } catch (error) {
    console.error('\n❌ Test suite failed:', error);
  } finally {
    printSummary();
  }
}

main().catch(console.error);
