#!/usr/bin/env npx tsx
/**
 * Redeem Positions Script
 *
 * 赎回已结束市场的持仓
 *
 * Run with:
 *   npx tsx scripts/dip-arb/redeem-positions.ts
 */

import { PolymarketSDK, CTFClient } from '../../src/index.js';

const PRIVATE_KEY = process.env.PRIVATE_KEY;

// Normalize outcome names: Up/Yes = YES, Down/No = NO
function normalizeOutcome(outcome: string): 'YES' | 'NO' {
  const lower = outcome.toLowerCase();
  if (lower === 'up' || lower === 'yes') return 'YES';
  if (lower === 'down' || lower === 'no') return 'NO';
  return 'YES'; // default
}

// Check if user's position is winning
function isWinningPosition(userOutcome: string, payouts: number[]): boolean {
  const normalized = normalizeOutcome(userOutcome);
  // payouts[0] = YES/Up payout, payouts[1] = NO/Down payout
  if (normalized === 'YES') {
    return payouts[0] > 0;
  } else {
    return payouts[1] > 0;
  }
}

async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║           Redeem Positions - Ended Markets               ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');

  if (!PRIVATE_KEY) {
    console.error('Error: PRIVATE_KEY environment variable is required');
    process.exit(1);
  }

  // Initialize SDK
  console.log('Initializing SDK...');
  const sdk = new PolymarketSDK({
    privateKey: PRIVATE_KEY,
  });

  // Initialize CTF Client for redemption
  const ctf = new CTFClient({
    privateKey: PRIVATE_KEY,
    rpcUrl: 'https://polygon-rpc.com',
    chainId: 137,
  });

  // Initialize SDK
  await sdk.initialize();

  // Get wallet address
  const address = sdk.tradingService.getAddress();
  console.log(`Wallet: ${address}`);
  console.log('');

  // Get all positions (filter for redeemable ones)
  console.log('Fetching positions...');
  const allPositions = await sdk.dataApi.getPositions(address);
  console.log(`Found ${allPositions.length} total positions`);

  // Also get explicitly redeemable positions
  console.log('Checking for redeemable positions...');
  const redeemablePositions = await sdk.dataApi.getPositions(address, { redeemable: true });
  console.log(`Found ${redeemablePositions.length} resolved positions`);
  console.log('');

  // Use redeemable positions if available, otherwise check all
  const positions = redeemablePositions.length > 0 ? redeemablePositions : allPositions;

  // Group positions by condition ID to find both sides
  const positionsByCondition = new Map<string, typeof positions>();
  for (const pos of positions) {
    const existing = positionsByCondition.get(pos.conditionId) || [];
    existing.push(pos);
    positionsByCondition.set(pos.conditionId, existing);
  }

  // Check each position for redemption
  let resolved = 0;
  let winning = 0;
  let redeemed = 0;
  let lost = 0;
  let failed = 0;

  // Track processed condition IDs to avoid duplicate redemption attempts
  const processedConditions = new Set<string>();

  for (const position of positions) {
    const conditionId = position.conditionId;

    // Skip if already processed this condition
    if (processedConditions.has(conditionId)) {
      continue;
    }
    processedConditions.add(conditionId);

    const title = position.title || position.slug || conditionId.slice(0, 20);
    const outcome = position.outcome || 'Unknown';
    const size = position.size || 0;
    const tokenId = position.asset; // This is the Polymarket token ID

    // Skip if no position
    if (size <= 0) {
      continue;
    }

    console.log(`┌─────────────────────────────────────────────────────────┐`);
    console.log(`│ ${title.slice(0, 55)}`);
    console.log(`│ Condition: ${conditionId.slice(0, 40)}...`);
    console.log(`│ Your bet: ${outcome} | Size: ${size.toFixed(4)}`);

    try {
      // Check if market is resolved
      const resolution = await ctf.getMarketResolution(conditionId);

      if (!resolution.isResolved) {
        console.log(`│ Status: NOT RESOLVED (cannot redeem yet)`);
        console.log(`└─────────────────────────────────────────────────────────┘`);
        console.log('');
        continue;
      }

      resolved++;
      const payouts = resolution.payoutNumerators || [];
      const winningOutcome = payouts[0] > 0 ? 'Up/Yes' : 'Down/No';
      console.log(`│ Winner: ${winningOutcome} (payouts: ${JSON.stringify(payouts)})`);

      // Check if user won
      if (!isWinningPosition(outcome, payouts)) {
        lost++;
        console.log(`│ ❌ YOU LOST - Your ${outcome} tokens are worth $0`);
        console.log(`└─────────────────────────────────────────────────────────┘`);
        console.log('');
        continue;
      }

      winning++;
      console.log(`│ ✅ YOU WON! Attempting redemption...`);

      // Get all positions for this condition to find token IDs
      const conditionPositions = positionsByCondition.get(conditionId) || [];

      // Find YES and NO token IDs
      let yesTokenId: string | undefined;
      let noTokenId: string | undefined;

      for (const p of conditionPositions) {
        const normalized = normalizeOutcome(p.outcome);
        if (normalized === 'YES') {
          yesTokenId = p.asset;
        } else {
          noTokenId = p.asset;
        }
      }

      // If we don't have both token IDs, try to get from market info
      if (!yesTokenId || !noTokenId) {
        console.log(`│ Getting market token IDs...`);
        try {
          const market = await sdk.markets.getMarket(conditionId);
          if (market && market.tokens && market.tokens.length >= 2) {
            yesTokenId = yesTokenId || market.tokens[0]?.tokenId;
            noTokenId = noTokenId || market.tokens[1]?.tokenId;
          }
        } catch {
          console.log(`│ Could not get market info, using position token ID only`);
        }
      }

      // Try to redeem
      console.log(`│ Token: ${tokenId.slice(0, 30)}...`);

      const tokenIds = {
        yesTokenId: yesTokenId || tokenId,
        noTokenId: noTokenId || tokenId,
      };

      const result = await ctf.redeemByTokenIds(conditionId, tokenIds);

      if (result.success) {
        redeemed++;
        console.log(`│ ✅ REDEEMED!`);
        console.log(`│ TX: ${result.txHash}`);
        console.log(`│ Amount: $${result.usdcReceived}`);
      } else {
        failed++;
        console.log(`│ ❌ FAILED`);
      }
    } catch (error) {
      failed++;
      const msg = error instanceof Error ? error.message : String(error);
      console.log(`│ ❌ ERROR: ${msg}`);
    }

    console.log(`└─────────────────────────────────────────────────────────┘`);
    console.log('');

    // Small delay between redemptions
    await new Promise(r => setTimeout(r, 1000));
  }

  // Summary
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║                       SUMMARY                            ║');
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log(`║ Markets Checked:    ${processedConditions.size}`);
  console.log(`║ Resolved:           ${resolved}`);
  console.log(`║ Won:                ${winning}`);
  console.log(`║ Lost:               ${lost}`);
  console.log(`║ Redeemed:           ${redeemed}`);
  console.log(`║ Failed:             ${failed}`);
  console.log('╚══════════════════════════════════════════════════════════╝');

  sdk.stop();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
