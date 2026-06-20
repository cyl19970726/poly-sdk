#!/usr/bin/env node
/**
 * Minimal live trading smoke test.
 *
 * Flow:
 * 1. Initialize PolymarketSDK
 * 2. Check collateral balance
 * 3. Pick an active YES/NO market with a live orderbook
 * 4. Place the smallest possible GTC BUY below best bid
 * 5. Cancel the order immediately
 *
 * Usage:
 *   node --env-file=.env --import tsx scripts/trading/smoke-test-order.ts
 *
 * Required env:
 *   PRIVATE_KEY or POLYMARKET_PRIVATE_KEY
 *
 * Optional env:
 *   POLYMARKET_SIGNATURE_TYPE=1
 *   POLYMARKET_FUNDER=0x...
 *   TEST_CONDITION_ID=0x...
 *   TEST_TOKEN_ID=123...
 */

import { PolymarketSDK } from '../../src/index.js';

type SmokeTarget = {
  question: string;
  conditionId: string;
  tokenId: string;
  minimumOrderSize: number;
  bestBid: number;
  bestAsk: number;
};

const PRIVATE_KEY =
  process.env.PRIVATE_KEY ||
  process.env.POLY_PRIVKEY ||
  process.env.POLYMARKET_PRIVATE_KEY ||
  '';

const SIGNATURE_TYPE = Number(
  process.env.POLY_SIGNATURE_TYPE ||
    process.env.POLYMARKET_SIGNATURE_TYPE ||
    '0'
) as 0 | 1 | 2;

const FUNDER_ADDRESS =
  process.env.POLY_FUNDER ||
  process.env.POLYMARKET_FUNDER ||
  '';

const TEST_CONDITION_ID = process.env.TEST_CONDITION_ID || '';
const TEST_TOKEN_ID = process.env.TEST_TOKEN_ID || '';

function requireConfig(): void {
  if (!PRIVATE_KEY) {
    throw new Error('Missing PRIVATE_KEY / POLYMARKET_PRIVATE_KEY');
  }

  if (SIGNATURE_TYPE === 1 && !FUNDER_ADDRESS) {
    throw new Error('signatureType=1 requires POLYMARKET_FUNDER');
  }
}

async function resolveTarget(sdk: PolymarketSDK): Promise<SmokeTarget> {
  if (TEST_CONDITION_ID && TEST_TOKEN_ID) {
    const market = await sdk.markets.getClobMarket(TEST_CONDITION_ID);
    if (!market) {
      throw new Error(`Market not found for TEST_CONDITION_ID=${TEST_CONDITION_ID}`);
    }
    const orderbook = await sdk.markets.getProcessedOrderbook(TEST_CONDITION_ID);
    const token = market.tokens.find((item) => item.tokenId === TEST_TOKEN_ID);
    if (!token) {
      throw new Error(`Token ${TEST_TOKEN_ID} not found in market ${TEST_CONDITION_ID}`);
    }

    return {
      question: market.question,
      conditionId: market.conditionId,
      tokenId: token.tokenId,
      minimumOrderSize: market.minimumOrderSize ?? 5,
      bestBid: orderbook.yes.bid || 0,
      bestAsk: orderbook.yes.ask || 0,
    };
  }

  const markets = await sdk.gammaApi.getMarkets({
    closed: false,
    active: true,
    limit: 20,
  });

  for (const gammaMarket of markets) {
    if (!gammaMarket.conditionId) continue;

    const market = await sdk.markets.getClobMarket(gammaMarket.conditionId);
    if (!market || !market.acceptingOrders || market.closed) continue;

    const yesToken = market.tokens.find((item) => /^yes$/i.test(item.outcome));
    if (!yesToken) continue;

    try {
      const orderbook = await sdk.markets.getProcessedOrderbook(gammaMarket.conditionId);
      if (orderbook.yes.bid <= 0 || orderbook.yes.ask <= 0) continue;

      return {
        question: market.question,
        conditionId: market.conditionId,
        tokenId: yesToken.tokenId,
        minimumOrderSize: market.minimumOrderSize ?? 5,
        bestBid: orderbook.yes.bid,
        bestAsk: orderbook.yes.ask,
      };
    } catch {
      continue;
    }
  }

  throw new Error('No active YES/NO market with a live orderbook was found');
}

async function main(): Promise<void> {
  requireConfig();

  const sdk = new PolymarketSDK({
    privateKey: PRIVATE_KEY,
    signatureType: SIGNATURE_TYPE,
    funderAddress: FUNDER_ADDRESS || undefined,
    chainId: 137,
  });

  try {
    await sdk.initialize();

    const { balance } = await sdk.tradingService.getBalanceAllowance('COLLATERAL');
    const balanceUsdc = Number(balance) / 1e6;

    console.log(`Signer: ${sdk.tradingService.getAddress()}`);
    if (FUNDER_ADDRESS) {
      console.log(`Funder: ${FUNDER_ADDRESS}`);
    }
    console.log(`Collateral: ${balanceUsdc.toFixed(2)} USDC`);

    const target = await resolveTarget(sdk);
    const tickSize = Number(await sdk.tradingService.getTickSize(target.tokenId));
    const price = Math.max(
      tickSize,
      Math.floor(Math.max(target.bestBid - tickSize * 5, tickSize) / tickSize) * tickSize
    );
    const size = Math.max(target.minimumOrderSize, Math.ceil(1 / price));

    console.log(`Market: ${target.question}`);
    console.log(`Token: ${target.tokenId}`);
    console.log(`Best bid/ask: ${target.bestBid} / ${target.bestAsk}`);
    console.log(`Smoke order: BUY ${size} @ ${price}`);

    let result:
      | Awaited<ReturnType<typeof sdk.tradingService.createLimitOrder>>
      | undefined;

    for (let attempt = 1; attempt <= 3; attempt++) {
      result = await sdk.tradingService.createLimitOrder({
        tokenId: target.tokenId,
        side: 'BUY',
        price,
        size,
        orderType: 'GTC',
        minimumOrderSize: target.minimumOrderSize,
      });

      console.log(`Attempt ${attempt}: ${result.success ? 'success' : result.errorMsg}`);

      if (result.success || !result.errorMsg?.includes('service not ready')) {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, 1500));
    }

    if (!result?.success || !result.orderId) {
      throw new Error(result?.errorMsg || 'Failed to place smoke-test order');
    }

    const liveOrder = await sdk.tradingService.getOrder(result.orderId);
    console.log(`Order live: ${liveOrder.id} maker=${liveOrder.makerAddress}`);

    const cancel = await sdk.tradingService.cancelOrder(result.orderId);
    if (!cancel.success) {
      throw new Error(cancel.errorMsg || `Failed to cancel order ${result.orderId}`);
    }

    console.log(`Order canceled: ${result.orderId}`);
  } finally {
    sdk.stop();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
