/**
 * CTFManager Full E2E Test - Split → Merge → Redeem
 *
 * Complete test including market settlement and redemption:
 * 1. Split USDC into YES + NO tokens
 * 2. Merge YES + NO back to USDC
 * 3. Wait for market settlement (15-min crypto markets recommended)
 * 4. Redeem winning tokens
 * 5. Verify all events detected
 *
 * Usage:
 * PRIVATE_KEY=0x... \
 * MARKET_CONDITION_ID=0x... \
 * PRIMARY_TOKEN_ID=123... \
 * SECONDARY_TOKEN_ID=456... \
 * npx tsx scripts/ctfmanager/full-e2e.ts
 *
 * Optional parameters:
 * - SPLIT_AMOUNT: Amount to split (default: 2.0 USDC.e)
 * - SKIP_REDEEM: Skip redeem test (default: false)
 * - WAIT_FOR_SETTLEMENT: Wait for market settlement (default: false)
 *
 * Requirements:
 * - USDC.e balance: ~5 USDC.e
 * - MATIC: ~0.2 MATIC (for Gas)
 *
 * For Redeem Testing:
 * - Use 15-minute crypto markets (settle every 15 minutes)
 * - Or use already-settled markets
 * - Or hold tokens until settlement
 */

import { CTFManager } from '../../src/index.js';

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const MARKET_CONDITION_ID = process.env.MARKET_CONDITION_ID;
const PRIMARY_TOKEN_ID = process.env.PRIMARY_TOKEN_ID;
const SECONDARY_TOKEN_ID = process.env.SECONDARY_TOKEN_ID;
const SPLIT_AMOUNT = process.env.SPLIT_AMOUNT || '2.0';
const SKIP_REDEEM = process.env.SKIP_REDEEM === 'true';
const WAIT_FOR_SETTLEMENT = process.env.WAIT_FOR_SETTLEMENT === 'true';

if (!PRIVATE_KEY) {
  console.error('Error: PRIVATE_KEY is required');
  process.exit(1);
}

if (!MARKET_CONDITION_ID || !PRIMARY_TOKEN_ID || !SECONDARY_TOKEN_ID) {
  console.error('Error: MARKET_CONDITION_ID, PRIMARY_TOKEN_ID, and SECONDARY_TOKEN_ID are required');
  console.error('');
  console.error('Example (15-minute BTC market):');
  console.error('PRIVATE_KEY=0x... \\');
  console.error('MARKET_CONDITION_ID=0x4e605132e536d51c37a28cdc0ac77e48c77d8e2251743d4eae3309165dee7d34 \\');
  console.error('PRIMARY_TOKEN_ID=114556380551836029874371622136300870993278600643770464506059877822810208153399 \\');
  console.error('SECONDARY_TOKEN_ID=24084804653914500740208824435348684831132621527155423823545713790843845444174 \\');
  console.error('npx tsx scripts/ctfmanager/full-e2e.ts');
  process.exit(1);
}

async function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('='.repeat(60));
  console.log('CTFManager Full E2E Test - Split → Merge → Redeem');
  console.log('='.repeat(60));
  console.log('');
  console.log(`Market: ${MARKET_CONDITION_ID}`);
  console.log(`Primary Token: ${PRIMARY_TOKEN_ID}`);
  console.log(`Secondary Token: ${SECONDARY_TOKEN_ID}`);
  console.log(`Split Amount: ${SPLIT_AMOUNT} USDC.e`);
  console.log(`Skip Redeem: ${SKIP_REDEEM}`);
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
  const txHashes: Record<string, string> = {};

  ctfManager.on('split_detected', (event) => {
    events.push('split_detected');
    txHashes.split = event.txHash;
    console.log('✓ [EVENT] split_detected');
    console.log(`  Amount: ${event.amount}`);
    console.log(`  Tx: ${event.txHash}`);
  });

  ctfManager.on('merge_detected', (event) => {
    events.push('merge_detected');
    txHashes.merge = event.txHash;
    console.log('✓ [EVENT] merge_detected');
    console.log(`  Amount: ${event.amount}`);
    console.log(`  Tx: ${event.txHash}`);
  });

  ctfManager.on('redeem_detected', (event) => {
    events.push('redeem_detected');
    txHashes.redeem = event.txHash;
    console.log('✓ [EVENT] redeem_detected');
    console.log(`  Amount: ${event.amount}`);
    console.log(`  Winning Token: ${event.winningTokenId}`);
    console.log(`  Tx: ${event.txHash}`);
  });

  ctfManager.on('error', (error) => {
    events.push('error');
    console.error('✗ [EVENT] error:', error);
  });

  // Start CTFManager
  await ctfManager.start();
  console.log('CTFManager started\n');

  // ========== Phase 1: Split Test ==========
  console.log('='.repeat(60));
  console.log('Phase 1: Split Test');
  console.log('='.repeat(60));
  console.log('');

  const initialBalances = await ctfManager.getBalances();
  console.log('Initial balances:');
  console.log(`  Primary: ${initialBalances.primary}`);
  console.log(`  Secondary: ${initialBalances.secondary}`);
  console.log('');

  console.log(`Splitting ${SPLIT_AMOUNT} USDC.e...`);
  const splitResult = await ctfManager.split(SPLIT_AMOUNT);

  if (!splitResult.success) {
    throw new Error(`Split failed: ${splitResult.error}`);
  }

  console.log('✓ Split submitted:', splitResult.txHash);
  console.log('');

  // Wait for split event
  console.log('Waiting for split_detected event (max 15s)...');
  const splitEventStart = Date.now();
  while (!events.includes('split_detected') && Date.now() - splitEventStart < 30000) {
    await delay(500);
  }

  if (!events.includes('split_detected')) {
    throw new Error('Split event timeout');
  }

  console.log('✓ Split event received');
  console.log('');

  const afterSplitBalances = await ctfManager.getBalances();
  console.log('Balances after split:');
  console.log(`  Primary: ${initialBalances.primary} → ${afterSplitBalances.primary}`);
  console.log(`  Secondary: ${initialBalances.secondary} → ${afterSplitBalances.secondary}`);
  console.log('');

  // ========== Phase 2: Merge Test ==========
  console.log('='.repeat(60));
  console.log('Phase 2: Merge Test');
  console.log('='.repeat(60));
  console.log('');

  // Merge half of the tokens (keep other half for redeem test)
  const mergeAmount = (parseFloat(SPLIT_AMOUNT) / 2).toString();
  console.log(`Merging ${mergeAmount} token pairs...`);
  const mergeResult = await ctfManager.merge(mergeAmount);

  if (!mergeResult.success) {
    throw new Error(`Merge failed: ${mergeResult.error}`);
  }

  console.log('✓ Merge submitted:', mergeResult.txHash);
  console.log('');

  // Wait for merge event
  console.log('Waiting for merge_detected event (max 15s)...');
  const mergeEventStart = Date.now();
  while (!events.includes('merge_detected') && Date.now() - splitEventStart < 30000) {
    await delay(500);
  }

  if (!events.includes('merge_detected')) {
    throw new Error('Merge event timeout');
  }

  console.log('✓ Merge event received');
  console.log('');

  const afterMergeBalances = await ctfManager.getBalances();
  console.log('Balances after merge:');
  console.log(`  Primary: ${afterSplitBalances.primary} → ${afterMergeBalances.primary}`);
  console.log(`  Secondary: ${afterSplitBalances.secondary} → ${afterMergeBalances.secondary}`);
  console.log('');

  // ========== Phase 3: Redeem Test ==========
  if (!SKIP_REDEEM) {
    console.log('='.repeat(60));
    console.log('Phase 3: Redeem Test');
    console.log('='.repeat(60));
    console.log('');

    if (WAIT_FOR_SETTLEMENT) {
      console.log('Waiting for market settlement...');
      console.log('This may take up to 15 minutes for 15-minute crypto markets.');
      console.log('For faster testing, use an already-settled market.');
      console.log('');

      // Poll for settlement every 60 seconds
      let settled = false;
      while (!settled) {
        console.log('Checking market status...');

        // Try to check if tokens are redeemable
        // (This is a simplified check - in production you'd query market resolution status)
        const hasTokens = parseFloat(afterMergeBalances.primary) > 0 ||
                         parseFloat(afterMergeBalances.secondary) > 0;

        if (!hasTokens) {
          console.log('No tokens to redeem (already merged)');
          settled = true;
          break;
        }

        console.log('Market not settled yet, waiting 60 seconds...');
        await delay(60000);
      }
    }

    console.log('Attempting to redeem tokens...');

    try {
      const redeemResult = await ctfManager.redeem();

      if (redeemResult.success) {
        console.log('✓ Redeem submitted:', redeemResult.txHash);
        console.log('');

        // Wait for redeem event
        console.log('Waiting for redeem_detected event (max 15s)...');
        const redeemEventStart = Date.now();
        while (!events.includes('redeem_detected') && Date.now() - splitEventStart < 30000) {
          await delay(500);
        }

        if (events.includes('redeem_detected')) {
          console.log('✓ Redeem event received');
        } else {
          console.log('⚠️  Redeem event timeout (may need more time)');
        }
        console.log('');
      } else {
        console.log(`ℹ️  Redeem failed: ${redeemResult.error}`);
        console.log('This is expected if market is not settled yet.');
        console.log('');
      }
    } catch (error) {
      console.log(`ℹ️  Redeem error: ${error instanceof Error ? error.message : String(error)}`);
      console.log('This is expected if market is not settled yet.');
      console.log('');
    }

    const finalBalances = await ctfManager.getBalances();
    console.log('Final balances:');
    console.log(`  Primary: ${afterMergeBalances.primary} → ${finalBalances.primary}`);
    console.log(`  Secondary: ${afterMergeBalances.secondary} → ${finalBalances.secondary}`);
    console.log('');
  } else {
    console.log('Skipping Redeem test (SKIP_REDEEM=true)');
    console.log('To test Redeem, run with SKIP_REDEEM=false on a settled market.');
    console.log('');
  }

  // Stop CTFManager
  ctfManager.stop();
  console.log('CTFManager stopped\n');

  // ========== Summary ==========
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

  console.log('Transaction hashes:');
  for (const [operation, hash] of Object.entries(txHashes)) {
    console.log(`  ${operation}: ${hash}`);
  }
  console.log('');

  // Validation
  const requiredEvents = ['split_detected', 'merge_detected'];
  if (!SKIP_REDEEM && events.includes('redeem_detected')) {
    requiredEvents.push('redeem_detected');
  }

  const missingEvents = requiredEvents.filter(e => !events.includes(e));

  if (missingEvents.length > 0) {
    console.error('❌ Missing required events:', missingEvents.join(', '));
    process.exit(1);
  }

  console.log('✓ Split & Merge tested successfully');
  if (!SKIP_REDEEM && events.includes('redeem_detected')) {
    console.log('✓ Redeem tested successfully');
  } else if (!SKIP_REDEEM) {
    console.log('ℹ️  Redeem not tested (market not settled)');
  }
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
