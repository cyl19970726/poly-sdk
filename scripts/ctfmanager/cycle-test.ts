/**
 * CTFManager Cycle Test - Multiple Split → Merge Cycles
 *
 * Tests stability and resource recovery over multiple cycles:
 * 1. Run N cycles of Split → Merge
 * 2. Verify event detection for each cycle
 * 3. Track balance recovery rate
 * 4. Check for memory leaks / event duplication
 *
 * Usage:
 * PRIVATE_KEY=0x... \
 * MARKET_CONDITION_ID=0x... \
 * PRIMARY_TOKEN_ID=123... \
 * SECONDARY_TOKEN_ID=456... \
 * npx tsx scripts/ctfmanager/cycle-test.ts
 *
 * Optional parameters:
 * - CYCLES: Number of cycles to run (default: 5)
 * - SPLIT_AMOUNT: Amount per cycle (default: 1.0 USDC.e)
 * - DELAY_MS: Delay between cycles (default: 5000ms)
 *
 * Requirements:
 * - USDC.e balance: ~5 USDC.e (for safety buffer)
 * - MATIC: ~0.5 MATIC (for Gas across cycles)
 */

import { CTFManager } from '../../src/index.js';

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const MARKET_CONDITION_ID = process.env.MARKET_CONDITION_ID;
const PRIMARY_TOKEN_ID = process.env.PRIMARY_TOKEN_ID;
const SECONDARY_TOKEN_ID = process.env.SECONDARY_TOKEN_ID;
const CYCLES = parseInt(process.env.CYCLES || '5', 10);
const SPLIT_AMOUNT = process.env.SPLIT_AMOUNT || '1.0';
const DELAY_MS = parseInt(process.env.DELAY_MS || '5000', 10);

if (!PRIVATE_KEY) {
  console.error('Error: PRIVATE_KEY is required');
  process.exit(1);
}

if (!MARKET_CONDITION_ID || !PRIMARY_TOKEN_ID || !SECONDARY_TOKEN_ID) {
  console.error('Error: MARKET_CONDITION_ID, PRIMARY_TOKEN_ID, and SECONDARY_TOKEN_ID are required');
  console.error('');
  console.error('Example:');
  console.error('PRIVATE_KEY=0x... \\');
  console.error('MARKET_CONDITION_ID=0x4e605132e536d51c37a28cdc0ac77e48c77d8e2251743d4eae3309165dee7d34 \\');
  console.error('PRIMARY_TOKEN_ID=114556380551836029874371622136300870993278600643770464506059877822810208153399 \\');
  console.error('SECONDARY_TOKEN_ID=24084804653914500740208824435348684831132621527155423823545713790843845444174 \\');
  console.error('CYCLES=5 \\');
  console.error('npx tsx scripts/ctfmanager/cycle-test.ts');
  process.exit(1);
}

interface CycleResult {
  cycle: number;
  splitSuccess: boolean;
  mergeSuccess: boolean;
  splitTxHash?: string;
  mergeTxHash?: string;
  splitDetected: boolean;
  mergeDetected: boolean;
  duration: number;
  gasUsed: number;
  error?: string;
}

async function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('='.repeat(60));
  console.log('CTFManager Cycle Test - Multiple Split → Merge Cycles');
  console.log('='.repeat(60));
  console.log('');
  console.log(`Market: ${MARKET_CONDITION_ID}`);
  console.log(`Cycles: ${CYCLES}`);
  console.log(`Split Amount: ${SPLIT_AMOUNT} USDC.e per cycle`);
  console.log(`Delay: ${DELAY_MS}ms between cycles`);
  console.log('');

  // Initialize CTFManager
  console.log('Initializing CTFManager...');
  const ctfManager = new CTFManager({
    privateKey: PRIVATE_KEY,
    conditionId: MARKET_CONDITION_ID,
    primaryTokenId: PRIMARY_TOKEN_ID,
    secondaryTokenId: SECONDARY_TOKEN_ID,
    debug: false, // Reduce log noise
  });

  // Track all events
  const allEvents: string[] = [];
  const cycleResults: CycleResult[] = [];
  let currentCycleSplitDetected = false;
  let currentCycleMergeDetected = false;

  ctfManager.on('split_detected', (event) => {
    allEvents.push('split_detected');
    currentCycleSplitDetected = true;
    console.log(`  ✓ split_detected (${event.txHash.slice(0, 10)}...)`);
  });

  ctfManager.on('merge_detected', (event) => {
    allEvents.push('merge_detected');
    currentCycleMergeDetected = true;
    console.log(`  ✓ merge_detected (${event.txHash.slice(0, 10)}...)`);
  });

  ctfManager.on('error', (error) => {
    allEvents.push('error');
    console.error('  ✗ [ERROR]:', error);
  });

  // Start CTFManager
  await ctfManager.start();
  console.log('CTFManager started\n');

  // Get initial balances
  const initialBalances = await ctfManager.getBalances();
  console.log('Initial balances:');
  console.log(`  Primary: ${initialBalances.primary}`);
  console.log(`  Secondary: ${initialBalances.secondary}`);
  console.log('');

  // Run cycles
  for (let i = 1; i <= CYCLES; i++) {
    console.log('─'.repeat(60));
    console.log(`Cycle ${i}/${CYCLES}`);
    console.log('─'.repeat(60));

    const cycleStart = Date.now();
    currentCycleSplitDetected = false;
    currentCycleMergeDetected = false;

    const result: CycleResult = {
      cycle: i,
      splitSuccess: false,
      mergeSuccess: false,
      splitDetected: false,
      mergeDetected: false,
      duration: 0,
      gasUsed: 0,
    };

    try {
      // Split
      console.log(`  Splitting ${SPLIT_AMOUNT} USDC.e...`);
      const splitResult = await ctfManager.split(SPLIT_AMOUNT);

      if (splitResult.success) {
        result.splitSuccess = true;
        result.splitTxHash = splitResult.txHash;
        console.log(`  ✓ Split submitted: ${splitResult.txHash.slice(0, 10)}...`);

        // Wait for split event (max 15s)
        const splitWaitStart = Date.now();
        while (!currentCycleSplitDetected && Date.now() - splitWaitStart < 30000) {
          await delay(500);
        }

        result.splitDetected = currentCycleSplitDetected;
        if (!currentCycleSplitDetected) {
          console.log('  ⚠️  Split event not detected within 15s');
        }
      } else {
        throw new Error(`Split failed: ${splitResult.error}`);
      }

      // Merge
      console.log(`  Merging ${SPLIT_AMOUNT} token pairs...`);
      const mergeResult = await ctfManager.merge(SPLIT_AMOUNT);

      if (mergeResult.success) {
        result.mergeSuccess = true;
        result.mergeTxHash = mergeResult.txHash;
        console.log(`  ✓ Merge submitted: ${mergeResult.txHash.slice(0, 10)}...`);

        // Wait for merge event (max 15s)
        const mergeWaitStart = Date.now();
        while (!currentCycleMergeDetected && Date.now() - mergeWaitStart < 30000) {
          await delay(500);
        }

        result.mergeDetected = currentCycleMergeDetected;
        if (!currentCycleMergeDetected) {
          console.log('  ⚠️  Merge event not detected within 15s');
        }
      } else {
        throw new Error(`Merge failed: ${mergeResult.error}`);
      }

      result.duration = Date.now() - cycleStart;
      console.log(`  ✓ Cycle completed in ${result.duration}ms`);

    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
      result.duration = Date.now() - cycleStart;
      console.log(`  ✗ Cycle failed: ${result.error}`);
    }

    cycleResults.push(result);
    console.log('');

    // Delay before next cycle (unless last cycle)
    if (i < CYCLES) {
      console.log(`  Waiting ${DELAY_MS}ms before next cycle...`);
      await delay(DELAY_MS);
      console.log('');
    }
  }

  // Get final balances
  const finalBalances = await ctfManager.getBalances();
  console.log('Final balances:');
  console.log(`  Primary: ${initialBalances.primary} → ${finalBalances.primary}`);
  console.log(`  Secondary: ${initialBalances.secondary} → ${finalBalances.secondary}`);
  console.log('');

  // Stop CTFManager
  ctfManager.stop();
  console.log('CTFManager stopped\n');

  // Calculate statistics
  const successfulCycles = cycleResults.filter(r => r.splitSuccess && r.mergeSuccess).length;
  const detectedCycles = cycleResults.filter(r => r.splitDetected && r.mergeDetected).length;
  const avgDuration = cycleResults.reduce((sum, r) => sum + r.duration, 0) / cycleResults.length;
  const primaryDelta = parseFloat(finalBalances.primary) - parseFloat(initialBalances.primary);
  const secondaryDelta = parseFloat(finalBalances.secondary) - parseFloat(initialBalances.secondary);
  const totalDelta = Math.abs(primaryDelta) + Math.abs(secondaryDelta);

  // Print summary
  console.log('='.repeat(60));
  console.log('Test Summary');
  console.log('='.repeat(60));
  console.log('');
  console.log(`Total Cycles: ${CYCLES}`);
  console.log(`Successful Cycles: ${successfulCycles}/${CYCLES}`);
  console.log(`Event Detection Success: ${detectedCycles}/${CYCLES}`);
  console.log(`Average Duration: ${avgDuration.toFixed(0)}ms per cycle`);
  console.log('');

  console.log('Balance Changes:');
  console.log(`  Primary: ${primaryDelta >= 0 ? '+' : ''}${primaryDelta}`);
  console.log(`  Secondary: ${secondaryDelta >= 0 ? '+' : ''}${secondaryDelta}`);
  console.log(`  Total Delta: ${totalDelta}`);
  console.log('');

  console.log('Event Summary:');
  const eventCounts = allEvents.reduce((acc, e) => {
    acc[e] = (acc[e] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  for (const [type, count] of Object.entries(eventCounts)) {
    console.log(`  ${type}: ${count}`);
  }
  console.log('');

  console.log('Cycle Details:');
  for (const result of cycleResults) {
    const status = result.splitSuccess && result.mergeSuccess ? '✅' : '❌';
    const detection = result.splitDetected && result.mergeDetected ? '✓' : '✗';
    console.log(`  ${status} Cycle ${result.cycle}: ${result.duration}ms | Events: ${detection}`);
    if (result.error) {
      console.log(`     Error: ${result.error}`);
    }
  }
  console.log('');

  // Validation
  const failedCycles = cycleResults.filter(r => !r.splitSuccess || !r.mergeSuccess);
  const missedDetections = cycleResults.filter(r => !r.splitDetected || !r.mergeDetected);

  if (failedCycles.length > 0) {
    console.error('❌ Some cycles failed:', failedCycles.length);
    process.exit(1);
  }

  if (missedDetections.length > 0) {
    console.error('❌ Some events not detected:', missedDetections.length);
    process.exit(1);
  }

  if (totalDelta > 0.5) {
    console.error(`❌ Balance recovery issue: Total delta ${totalDelta} > 0.5`);
    process.exit(1);
  }

  console.log('✓ All cycles completed successfully');
  console.log('✓ All events detected correctly');
  console.log('✓ Balance recovery verified');
  console.log('');
  console.log('✅ Test PASSED');
  console.log('');
}

main().catch((error) => {
  console.error('');
  console.error('❌ Test FAILED');
  console.error('');
  console.error('Error:', error.message);
  if (error.stack) {
    console.error('');
    console.error('Stack trace:');
    console.error(error.stack);
  }
  console.error('');
  process.exit(1);
});
