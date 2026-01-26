/**
 * CTFManager Quick Test - Basic Split → Merge Cycle
 *
 * Quick verification that CTFManager works end-to-end:
 * 1. Split USDC into YES + NO tokens
 * 2. Verify split_detected event
 * 3. Merge YES + NO back to USDC
 * 4. Verify merge_detected event
 * 5. Check balance recovery
 *
 * Usage:
 * PRIVATE_KEY=0x... \
 * MARKET_CONDITION_ID=0x... \
 * PRIMARY_TOKEN_ID=123... \
 * SECONDARY_TOKEN_ID=456... \
 * npx tsx scripts/ctfmanager/quick-test.ts
 *
 * Optional parameters:
 * - SPLIT_AMOUNT: Amount to split (default: 1.0 USDC.e)
 *
 * Requirements:
 * - USDC.e balance: ~2 USDC.e (1 for split + buffer)
 * - MATIC: ~0.1 MATIC (for Gas)
 */

import { CTFManager } from '../../src/index.js';

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const MARKET_CONDITION_ID = process.env.MARKET_CONDITION_ID;
const PRIMARY_TOKEN_ID = process.env.PRIMARY_TOKEN_ID;
const SECONDARY_TOKEN_ID = process.env.SECONDARY_TOKEN_ID;
const SPLIT_AMOUNT = process.env.SPLIT_AMOUNT || '1.0';

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
  console.error('npx tsx scripts/ctfmanager/quick-test.ts');
  process.exit(1);
}

async function main() {
  console.log('='.repeat(60));
  console.log('CTFManager Quick Test - Split → Merge Cycle');
  console.log('='.repeat(60));
  console.log('');
  console.log(`Market: ${MARKET_CONDITION_ID}`);
  console.log(`Primary Token: ${PRIMARY_TOKEN_ID}`);
  console.log(`Secondary Token: ${SECONDARY_TOKEN_ID}`);
  console.log(`Split Amount: ${SPLIT_AMOUNT} USDC.e`);
  console.log('');

  // Initialize CTFManager
  console.log('Initializing CTFManager...');
  const ctfManager = new CTFManager({
    privateKey: PRIVATE_KEY,
    conditionId: MARKET_CONDITION_ID,
    primaryTokenId: PRIMARY_TOKEN_ID,
    secondaryTokenId: SECONDARY_TOKEN_ID,
    debug: true,
  });

  // Track events
  const events: string[] = [];
  let splitTxHash = '';
  let mergeTxHash = '';

  ctfManager.on('split_detected', (event) => {
    events.push('split_detected');
    splitTxHash = event.txHash;
    console.log('✓ [EVENT] split_detected');
    console.log(`  Amount: ${event.amount}`);
    console.log(`  Tx: ${event.txHash}`);
    console.log(`  Block: ${event.blockNumber}`);
  });

  ctfManager.on('merge_detected', (event) => {
    events.push('merge_detected');
    mergeTxHash = event.txHash;
    console.log('✓ [EVENT] merge_detected');
    console.log(`  Amount: ${event.amount}`);
    console.log(`  Tx: ${event.txHash}`);
    console.log(`  Block: ${event.blockNumber}`);
  });

  ctfManager.on('operation_detected', (event) => {
    events.push('operation_detected');
    console.log(`✓ [EVENT] operation_detected: ${event.type}`);
  });

  ctfManager.on('error', (error) => {
    events.push('error');
    console.error('✗ [EVENT] error:', error);
  });

  // Start CTFManager
  try {
    await ctfManager.start();
    console.log('CTFManager started');
    console.log('');
  } catch (error) {
    console.error('Failed to start CTFManager:', error);
    throw error;
  }

  // Get initial balances
  console.log('Getting initial balances...');
  const initialBalances = await ctfManager.getBalances();
  console.log(`Primary balance: ${initialBalances.primary}`);
  console.log(`Secondary balance: ${initialBalances.secondary}`);
  console.log('');

  // Step 1: Split USDC into tokens
  console.log(`Step 1: Splitting ${SPLIT_AMOUNT} USDC.e...`);
  const splitResult = await ctfManager.split(SPLIT_AMOUNT);

  if (!splitResult.success) {
    throw new Error(`Split failed: ${splitResult.error}`);
  }

  console.log('✓ Split transaction submitted:', splitResult.txHash);
  console.log('');

  // Wait for split event (should be ~1 second, but allow up to 30s for network delays)
  console.log('Waiting for split_detected event...');
  const splitEventTimeout = setTimeout(() => {
    if (!events.includes('split_detected')) {
      console.error('❌ Timeout: split_detected event not received within 30 seconds');
      throw new Error('Split detection timeout');
    }
  }, 30000);

  await new Promise(resolve => {
    const checkInterval = setInterval(() => {
      if (events.includes('split_detected')) {
        clearInterval(checkInterval);
        clearTimeout(splitEventTimeout);
        resolve(true);
      }
    }, 500);
  });

  console.log('');

  // Verify balances after split
  const afterSplitBalances = await ctfManager.getBalances();
  console.log('Balances after split:');
  console.log(`Primary: ${initialBalances.primary} → ${afterSplitBalances.primary}`);
  console.log(`Secondary: ${initialBalances.secondary} → ${afterSplitBalances.secondary}`);
  console.log('');

  // Step 2: Merge tokens back to USDC
  console.log(`Step 2: Merging ${SPLIT_AMOUNT} token pairs...`);
  const mergeResult = await ctfManager.merge(SPLIT_AMOUNT);

  if (!mergeResult.success) {
    throw new Error(`Merge failed: ${mergeResult.error}`);
  }

  console.log('✓ Merge transaction submitted:', mergeResult.txHash);
  console.log('');

  // Wait for merge event (allow up to 30s for network delays)
  console.log('Waiting for merge_detected event...');
  const mergeEventTimeout = setTimeout(() => {
    if (!events.includes('merge_detected')) {
      console.error('❌ Timeout: merge_detected event not received within 30 seconds');
      throw new Error('Merge detection timeout');
    }
  }, 30000);

  await new Promise(resolve => {
    const checkInterval = setInterval(() => {
      if (events.includes('merge_detected')) {
        clearInterval(checkInterval);
        clearTimeout(mergeEventTimeout);
        resolve(true);
      }
    }, 500);
  });

  console.log('');

  // Verify balances after merge
  const finalBalances = await ctfManager.getBalances();
  console.log('Final balances:');
  console.log(`Primary: ${afterSplitBalances.primary} → ${finalBalances.primary}`);
  console.log(`Secondary: ${afterSplitBalances.secondary} → ${finalBalances.secondary}`);
  console.log('');

  // Stop CTFManager
  ctfManager.stop();
  console.log('CTFManager stopped');
  console.log('');

  // Calculate balance changes
  const primaryDelta = parseFloat(finalBalances.primary) - parseFloat(initialBalances.primary);
  const secondaryDelta = parseFloat(finalBalances.secondary) - parseFloat(initialBalances.secondary);

  // Summary
  console.log('='.repeat(60));
  console.log('Test Summary');
  console.log('='.repeat(60));
  console.log('');
  console.log(`Events received: ${events.length}`);
  console.log('Event breakdown:');
  const eventCounts = events.reduce((acc, e) => {
    acc[e] = (acc[e] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  for (const [type, count] of Object.entries(eventCounts)) {
    console.log(`  - ${type}: ${count}`);
  }

  console.log('');
  console.log('Balance changes:');
  console.log(`  Primary: ${primaryDelta >= 0 ? '+' : ''}${primaryDelta}`);
  console.log(`  Secondary: ${secondaryDelta >= 0 ? '+' : ''}${secondaryDelta}`);
  console.log('');

  // Verify minimum expected events
  const requiredEvents = ['split_detected', 'merge_detected'];
  const missingEvents = requiredEvents.filter(e => !events.includes(e));

  if (missingEvents.length > 0) {
    console.error('❌ Missing required events:', missingEvents.join(', '));
    process.exit(1);
  }

  // Verify balance recovery (should be very close, only Gas consumed)
  const totalDelta = Math.abs(primaryDelta) + Math.abs(secondaryDelta);
  if (totalDelta > 0.1) {
    console.error(`❌ Balance recovery issue: Total delta ${totalDelta} > 0.1`);
    process.exit(1);
  }

  console.log('✓ All required events received');
  console.log('✓ Balance recovery verified (only Gas consumed)');
  console.log('');
  console.log('✅ Test PASSED');
  console.log('');
  console.log('Transaction hashes:');
  console.log(`  Split: ${splitTxHash}`);
  console.log(`  Merge: ${mergeTxHash}`);
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
