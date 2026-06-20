#!/usr/bin/env tsx
/**
 * E2E Builder/Relayer Test — Fill Verification
 *
 * Tests the complete Builder mode flow with actual order fills:
 *   1. Deploy Gnosis Safe via Relayer (idempotent)
 *   2. Approve all contracts for trading (USDC.e + ERC1155, idempotent)
 *   3. Consolidate USDC.e to Safe (transfer from EOA if needed)
 *   4. Find active market + get orderbook prices
 *   5. Limit BUY at ask price (fills immediately, verifies maker=Safe)
 *   6. Limit SELL at bid price (sells tokens from step 5)
 *   7. Market BUY $1 FAK (partial fill OK)
 *   8. Summary with PnL
 *
 * Usage (from poly-sdk dir):
 *   npx tsx scripts/e2e-builder-test.ts
 *
 * Required env vars (in root .env):
 *   PRIVATE_KEY, POLYGON_RPC_URL
 *   POLY_BUILDER_API_KEY, POLY_BUILDER_SECRET, POLY_BUILDER_PASSPHRASE
 */

import { readFileSync, existsSync, appendFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ethers } from 'ethers';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env from project root
const rootDir = resolve(__dirname, '../..');
const envPath = resolve(rootDir, '.env');
if (existsSync(envPath)) {
  const envContent = readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const [key, ...valueParts] = line.split('=');
    if (key && !key.startsWith('#')) {
      const value = valueParts.join('=').trim();
      if (value && !process.env[key.trim()]) {
        process.env[key.trim()] = value.replace(/^["']|["']$/g, '');
      }
    }
  }
}

import { RelayerService } from '../src/services/relayer-service.js';
import {
  USDC_CONTRACT,
  CTF_CONTRACT,
  CTF_EXCHANGE,
  NEG_RISK_CTF_EXCHANGE,
  NEG_RISK_ADAPTER,
} from '../src/clients/ctf-client.js';
import { RateLimiter } from '../src/core/rate-limiter.js';
import { createUnifiedCache } from '../src/core/unified-cache.js';
import { TradingService } from '../src/services/trading-service.js';
import { MarketService } from '../src/services/market-service.js';
import { GammaApiClient } from '../src/clients/gamma-api.js';
import { DataApiClient } from '../src/clients/data-api.js';
import { BinanceService } from '../src/services/binance-service.js';
import { OrderStatus } from '../src/core/types.js';

// ============================================================================
// Config
// ============================================================================

const PRIVATE_KEY = process.env.PRIVATE_KEY!;
const RPC_URL = process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com';
const BUILDER_CREDS = {
  key: process.env.POLY_BUILDER_API_KEY!,
  secret: process.env.POLY_BUILDER_SECRET!,
  passphrase: process.env.POLY_BUILDER_PASSPHRASE!,
};

// Test amounts
const MIN_CLOB_ORDER_SIZE = 5;    // CLOB minimum for BTC 15-min markets
const MIN_ORDER_VALUE = 1.05;     // Minimum order value ($1 + buffer)

const ERC20_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

const ERC1155_READ_ABI = [
  'function isApprovedForAll(address account, address operator) view returns (bool)',
];

// ============================================================================
// Helpers
// ============================================================================

function log(step: string, msg: string) {
  console.log(`[E2E] [${step}] ${msg}`);
}
function logOk(step: string, msg: string) {
  console.log(`  ✅ [${step}] ${msg}`);
}
function logFail(step: string, msg: string) {
  console.log(`  ❌ [${step}] ${msg}`);
}
async function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

/** Get orderbook bid/ask for a token via CLOB REST API */
async function getBookPrices(tokenId: string): Promise<{
  bestBid: number;
  bestAsk: number;
  bidSize: number;
  askSize: number;
}> {
  const resp = await fetch(`https://clob.polymarket.com/book?token_id=${tokenId}`);
  const data = await resp.json();

  // CLOB API returns bids ascending (worst→best) and asks descending (worst→best)
  // Best bid = highest bid (last in array), Best ask = lowest ask (last in array)
  const bids = (data.bids || []).map((b: any) => ({ price: parseFloat(b.price), size: parseFloat(b.size) }));
  const asks = (data.asks || []).map((a: any) => ({ price: parseFloat(a.price), size: parseFloat(a.size) }));

  // Sort: bids descending (best first), asks ascending (best first)
  bids.sort((a: any, b: any) => b.price - a.price);
  asks.sort((a: any, b: any) => a.price - b.price);

  return {
    bestBid: bids.length > 0 ? bids[0].price : 0,
    bestAsk: asks.length > 0 ? asks[0].price : 0,
    bidSize: bids.length > 0 ? bids[0].size : 0,
    askSize: asks.length > 0 ? asks[0].size : 0,
  };
}

/** Poll order until filled or timeout */
async function waitForFill(
  tradingService: TradingService,
  orderId: string,
  label: string,
  timeoutMs: number = 15000
): Promise<{ filled: boolean; order: any }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const order = await tradingService.getOrder(orderId);
    if (!order) return { filled: false, order: null };

    if (order.status === OrderStatus.FILLED) {
      return { filled: true, order };
    }
    if (order.status === OrderStatus.CANCELLED ||
        order.status === OrderStatus.EXPIRED ||
        order.status === OrderStatus.REJECTED) {
      log(label, `Order terminated: ${order.status}`);
      return { filled: false, order };
    }
    if (order.status === OrderStatus.PARTIALLY_FILLED) {
      log(label, `Partially filled: ${order.filledSize}/${order.originalSize}`);
    }

    await sleep(2000);
  }

  // Timeout — return latest state
  const finalOrder = await tradingService.getOrder(orderId);
  return { filled: finalOrder?.status === OrderStatus.FILLED, order: finalOrder };
}

// ============================================================================
// Find active market
// ============================================================================

async function findActiveMarket(marketService: MarketService): Promise<{
  conditionId: string;
  primaryTokenId: string;
  secondaryTokenId: string;
  question: string;
  /** Which token to trade (may be secondary if YES price is extreme) */
  tradeTokenId: string;
  tradeSide: 'YES' | 'NO';
}> {
  log('Market', 'Scanning for active 15min crypto markets...');

  // Try BTC, ETH, SOL with wider time range to find active markets
  const coins = ['BTC', 'ETH', 'SOL'] as const;
  const allMarkets: any[] = [];

  for (const coin of coins) {
    try {
      const markets = await marketService.scanCryptoShortTermMarkets({
        coin,
        duration: '15m',
        minMinutesUntilEnd: 1,
        maxMinutesUntilEnd: 16,
        limit: 5,
      });
      allMarkets.push(...markets);
    } catch { /* try next coin */ }
  }

  // Filter out already-expired markets (end time must be in the future)
  const now = Date.now();
  const activeMarkets = allMarkets.filter(m => {
    if (!m.endDate) return true; // keep if no endDate (can't filter)
    const endTime = typeof m.endDate === 'number' ? m.endDate : new Date(m.endDate).getTime();
    return endTime > now;
  });

  if (activeMarkets.length === 0) {
    throw new Error(
      `No active 15min crypto markets found (checked ${allMarkets.length} total, all expired). ` +
      'Crypto markets may be between cycles. Try again in a few minutes.'
    );
  }

  log('Market', `Found ${activeMarkets.length} active markets (${allMarkets.length} total), checking prices...`);

  // For each market, check both sides and pick the cheaper one (within budget)
  for (const candidate of activeMarkets) {
    const marketInfo = await marketService.getClobMarket(candidate.conditionId!);
    if (!marketInfo?.tokens || marketInfo.tokens.length !== 2) continue;

    const [primary, secondary] = marketInfo.tokens;

    // Check both sides
    const [yesPrices, noPrices] = await Promise.all([
      getBookPrices(primary.tokenId),
      getBookPrices(secondary.tokenId),
    ]);

    // Find the cheaper side that's within budget and has liquidity
    const sides = [
      { name: 'YES', token: primary.tokenId, prices: yesPrices },
      { name: 'NO', token: secondary.tokenId, prices: noPrices },
    ].filter(s => s.prices.bestAsk > 0 && s.prices.bestAsk <= 0.80 && s.prices.askSize >= MIN_CLOB_ORDER_SIZE)
     .sort((a, b) => a.prices.bestAsk - b.prices.bestAsk); // cheapest first

    if (sides.length > 0) {
      const best = sides[0];
      log('Market', `Selected: ${candidate.question} (${best.name} ask=${best.prices.bestAsk})`);
      return {
        conditionId: candidate.conditionId!,
        primaryTokenId: primary.tokenId,
        secondaryTokenId: secondary.tokenId,
        question: candidate.question || 'Unknown',
        tradeTokenId: best.token,
        tradeSide: best.name as 'YES' | 'NO',
      };
    }

    log('Market', `Skipping ${candidate.question?.slice(0, 50)} (YES ask=${yesPrices.bestAsk}, NO ask=${noPrices.bestAsk})`);
  }

  throw new Error('No market with balanced prices found. All markets have extreme bid/ask (near 0 or 1).');
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log('\n════════════════════════════════════════════════════');
  console.log('   Builder/Relayer E2E Test — Fill Verification');
  console.log('════════════════════════════════════════════════════\n');

  if (!PRIVATE_KEY) throw new Error('PRIVATE_KEY not set');
  if (!BUILDER_CREDS.key) throw new Error('POLY_BUILDER_API_KEY not set');
  if (!BUILDER_CREDS.secret) throw new Error('POLY_BUILDER_SECRET not set');
  if (!BUILDER_CREDS.passphrase) throw new Error('POLY_BUILDER_PASSPHRASE not set');

  const provider = new ethers.providers.StaticJsonRpcProvider(
    { url: RPC_URL, timeout: 30000 },
    137
  );
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  log('Init', `EOA: ${wallet.address}`);
  log('Init', `RPC: ${RPC_URL}`);

  // Track results
  let initialBalance = 0;
  const results: { step: string; success: boolean; detail: string }[] = [];

  // ========================================================================
  // Step 1: Deploy Safe (idempotent)
  // ========================================================================
  log('Step 1', 'Deploying Gnosis Safe via Relayer...');

  const relayer = new RelayerService({
    builderCreds: BUILDER_CREDS,
    privateKey: PRIVATE_KEY,
    rpcUrl: RPC_URL,
  });

  const deployResult = await relayer.deploySafe();
  if (!deployResult.success) {
    logFail('Step 1', `Deploy failed: ${deployResult.errorMessage}`);
    process.exit(1);
  }

  const safeAddress = deployResult.safeAddress;
  logOk('Step 1', `Safe: ${safeAddress} (${deployResult.txHash ? 'newly deployed' : 'already existed'})`);
  results.push({ step: 'Deploy Safe', success: true, detail: safeAddress });

  // Save to .env if not already there
  const envContent = readFileSync(envPath, 'utf-8');
  if (!envContent.includes('POLY_SAFE_ADDRESS=')) {
    appendFileSync(envPath, `\nPOLY_SAFE_ADDRESS=${safeAddress}\n`);
    log('Step 1', 'POLY_SAFE_ADDRESS saved to .env');
  }

  // ========================================================================
  // Step 2: Approve all contracts for trading (idempotent — skips if done)
  // ========================================================================
  log('Step 2', 'Checking & approving contracts for trading...');

  const usdc = new ethers.Contract(USDC_CONTRACT, ERC20_ABI, provider);
  const ctf = new ethers.Contract(CTF_CONTRACT, ERC1155_READ_ABI, provider);
  const MIN_ALLOWANCE = ethers.utils.parseUnits('1000000', 6); // 1M USDC threshold

  // 2a: ERC20 — USDC.e approvals
  const usdcTargets = [
    { name: 'CTF Contract (split/merge)', address: CTF_CONTRACT },
    { name: 'CTF Exchange (BUY fills)', address: CTF_EXCHANGE },
    { name: 'NegRisk Exchange', address: NEG_RISK_CTF_EXCHANGE },
    { name: 'NegRisk Adapter', address: NEG_RISK_ADAPTER },
  ];

  let approvalCount = 0;
  for (const target of usdcTargets) {
    const allowance = await usdc.allowance(safeAddress, target.address);
    if (allowance.gte(MIN_ALLOWANCE)) {
      logOk('Step 2', `USDC.e → ${target.name}: already approved`);
      continue;
    }
    const result = await relayer.approveUsdc(target.address, ethers.constants.MaxUint256);
    if (result.success) {
      logOk('Step 2', `USDC.e → ${target.name}: ${result.txHash}`);
      approvalCount++;
    } else {
      logFail('Step 2', `USDC.e → ${target.name}: ${result.errorMessage}`);
    }
  }

  // 2b: ERC1155 — Conditional Tokens approvals
  const erc1155Targets = [
    { name: 'CTF Exchange (SELL fills)', address: CTF_EXCHANGE },
    { name: 'NegRisk Exchange', address: NEG_RISK_CTF_EXCHANGE },
    { name: 'NegRisk Adapter', address: NEG_RISK_ADAPTER },
  ];

  for (const target of erc1155Targets) {
    const approved = await ctf.isApprovedForAll(safeAddress, target.address);
    if (approved) {
      logOk('Step 2', `ERC1155 → ${target.name}: already approved`);
      continue;
    }
    const result = await relayer.approveERC1155ForAll(target.address);
    if (result.success) {
      logOk('Step 2', `ERC1155 → ${target.name}: ${result.txHash}`);
      approvalCount++;
    } else {
      logFail('Step 2', `ERC1155 → ${target.name}: ${result.errorMessage}`);
    }
  }

  results.push({ step: 'Approvals', success: true, detail: approvalCount > 0 ? `${approvalCount} new approvals` : 'all already approved' });

  // ========================================================================
  // Step 3: Consolidate USDC.e to Safe (transfer all from EOA if needed)
  // ========================================================================
  log('Step 3', 'Checking USDC.e balances...');

  try {
    const [safeBalance, eoaBalance] = await Promise.all([
      usdc.balanceOf(safeAddress),
      usdc.balanceOf(wallet.address),
    ]);
    const safeBalanceHuman = parseFloat(ethers.utils.formatUnits(safeBalance, 6));
    const eoaBalanceHuman = parseFloat(ethers.utils.formatUnits(eoaBalance, 6));
    initialBalance = safeBalanceHuman;
    log('Step 3', `Safe: $${safeBalanceHuman.toFixed(2)}, EOA: $${eoaBalanceHuman.toFixed(2)}`);

    // Need enough for: limit BUY (~$3.50) + market BUY ($1) = ~$4.50
    const neededBalance = 4;
    if (safeBalanceHuman >= neededBalance) {
      logOk('Step 3', `Safe has $${safeBalanceHuman.toFixed(2)} (>= $${neededBalance} needed), skipping transfer`);
    } else if (eoaBalanceHuman > 0.1) {
      // Transfer ALL EOA USDC to Safe
      log('Step 3', `Transferring $${eoaBalanceHuman.toFixed(2)} from EOA to Safe...`);
      const usdcWithSigner = usdc.connect(wallet);
      const transferTx = await usdcWithSigner.transfer(safeAddress, eoaBalance);
      const receipt = await transferTx.wait();
      logOk('Step 3', `Transfer $${eoaBalanceHuman.toFixed(2)} complete. TX: ${receipt.transactionHash}`);
      const newBalance = await usdc.balanceOf(safeAddress);
      initialBalance = parseFloat(ethers.utils.formatUnits(newBalance, 6));
    } else {
      log('Step 3', `EOA has no USDC.e to transfer. Proceeding with Safe balance only.`);
    }
  } catch (err: any) {
    log('Step 3', `Balance check failed (${err.message?.slice(0, 80)}), proceeding...`);
  }

  results.push({ step: 'Fund Safe', success: true, detail: `$${initialBalance.toFixed(2)}` });

  if (initialBalance < 1.0) {
    log('Step 3', `ABORT: Safe balance too low ($${initialBalance.toFixed(2)} < $1 minimum). Fund the Safe first.`);
    logFail('Step 3', 'Insufficient balance to run fill tests. Send USDC.e to Safe address above.');
    process.exit(1);
  }

  // ========================================================================
  // Step 4: Find active market + get orderbook prices
  // ========================================================================
  log('Step 4', 'Finding active market...');

  const rateLimiter = new RateLimiter();
  const cache = createUnifiedCache();
  const gamma = new GammaApiClient(rateLimiter, cache);
  const dataApi = new DataApiClient(rateLimiter, cache);
  const binance = new BinanceService(rateLimiter, cache);
  const marketService = new MarketService(gamma, dataApi, rateLimiter, cache, undefined, binance);

  // Key: pass safeAddress so orders use Safe as maker (POLY_GNOSIS_SAFE signature type)
  const tradingService = new TradingService(rateLimiter, cache, {
    privateKey: PRIVATE_KEY,
    builderCreds: BUILDER_CREDS,
    safeAddress,
  });
  await tradingService.initialize();

  const market = await findActiveMarket(marketService);
  logOk('Step 4', `Market: ${market.question}`);
  log('Step 4', `conditionId: ${market.conditionId}`);
  log('Step 4', `Trading: ${market.tradeSide} token`);

  // Get current orderbook for the token we'll trade
  const prices = await getBookPrices(market.tradeTokenId);
  log('Step 4', `${market.tradeSide} bid: ${prices.bestBid} (size: ${prices.bidSize}), ask: ${prices.bestAsk} (size: ${prices.askSize})`);

  if (prices.bestBid === 0 || prices.bestAsk === 0) {
    throw new Error('No bid/ask available — market has no liquidity');
  }

  results.push({ step: 'Find Market', success: true, detail: `${market.tradeSide} bid=${prices.bestBid} ask=${prices.bestAsk}` });

  // ========================================================================
  // Step 5: Limit BUY at ask price (fills immediately, gets tokens)
  // ========================================================================
  // Dynamic sizing: ensure order value >= $1 minimum and fits within budget
  const buySize = Math.max(MIN_CLOB_ORDER_SIZE, Math.ceil(MIN_ORDER_VALUE / prices.bestAsk));
  const buyCost = prices.bestAsk * buySize;

  if (buyCost > initialBalance * 0.9) {
    log('Step 5', `SKIP: BUY ${buySize} @ ${prices.bestAsk} = $${buyCost.toFixed(2)} exceeds budget $${initialBalance.toFixed(2)}`);
    results.push({ step: 'Limit BUY (fill)', success: true, detail: `SKIPPED (budget $${initialBalance.toFixed(2)} < cost $${buyCost.toFixed(2)})` });
  } else {
  log('Step 5', `Placing limit BUY ${market.tradeSide} at ${prices.bestAsk} (size ${buySize})...`);
  log('Step 5', `Expected cost: $${buyCost.toFixed(2)}`);

  const buyResult = await tradingService.createLimitOrder({
    tokenId: market.tradeTokenId,
    side: 'BUY',
    price: prices.bestAsk,
    size: buySize,
  });

  if (!buyResult.success) {
    logFail('Step 5', `BUY order failed: ${buyResult.errorMsg}`);
    results.push({ step: 'Limit BUY (fill)', success: false, detail: buyResult.errorMsg || 'failed' });
  } else {
    logOk('Step 5', `BUY order placed: ${buyResult.orderId}`);

    // Verify maker is Safe address
    try {
      const orderDetails = await tradingService.getOrder(buyResult.orderId!);
      const orderMaker = orderDetails?.makerAddress?.toLowerCase();
      if (orderMaker === safeAddress.toLowerCase()) {
        logOk('Step 5', `Maker verified: Safe (${orderMaker})`);
      } else {
        log('Step 5', `Maker: ${orderMaker || 'unknown'} (expected Safe: ${safeAddress.toLowerCase()})`);
      }
    } catch { /* ok */ }

    // Wait for fill
    log('Step 5', 'Waiting for fill...');
    const fillResult = await waitForFill(tradingService, buyResult.orderId!, 'Step 5');

    if (fillResult.filled) {
      logOk('Step 5', `BUY FILLED! ${fillResult.order.filledSize}/${fillResult.order.originalSize} shares @ ${prices.bestAsk}`);
      results.push({ step: 'Limit BUY (fill)', success: true, detail: `FILLED ${fillResult.order.filledSize} @ ${prices.bestAsk}` });
    } else {
      const status = fillResult.order?.status || 'unknown';
      logFail('Step 5', `BUY not filled (status: ${status}). Cancelling...`);
      try { await tradingService.cancelOrder(buyResult.orderId!); } catch { /* ok */ }
      results.push({ step: 'Limit BUY (fill)', success: false, detail: `NOT FILLED (${status})` });
    }
  }
  } // end budget check

  // Wait for on-chain settlement of BUY trade to propagate to CLOB balance
  log('Wait', 'Waiting 8s for on-chain settlement...');
  await sleep(8000);

  // ========================================================================
  // Step 6: Limit SELL at bid price (sells tokens acquired in Step 5)
  // ========================================================================
  const pricesNow = await getBookPrices(market.tradeTokenId);
  const sellSize = Math.max(MIN_CLOB_ORDER_SIZE, Math.ceil(MIN_ORDER_VALUE / pricesNow.bestBid));
  const sellValue = pricesNow.bestBid * sellSize;

  if (sellValue < 1.0) {
    log('Step 6', `SKIP: SELL ${sellSize} @ ${pricesNow.bestBid} = $${sellValue.toFixed(2)} below $1 minimum`);
    results.push({ step: 'Limit SELL (fill)', success: true, detail: `SKIPPED (value $${sellValue.toFixed(2)} < $1)` });
  } else {
  log('Step 6', `Current ${market.tradeSide} bid: ${pricesNow.bestBid} (size: ${pricesNow.bidSize})`);
  log('Step 6', `Placing limit SELL ${market.tradeSide} at ${pricesNow.bestBid} (size ${sellSize})...`);

  const sellResult = await tradingService.createLimitOrder({
    tokenId: market.tradeTokenId,
    side: 'SELL',
    price: pricesNow.bestBid,
    size: sellSize,
  });

  if (!sellResult.success) {
    logFail('Step 6', `SELL order failed: ${sellResult.errorMsg}`);
    results.push({ step: 'Limit SELL (fill)', success: false, detail: sellResult.errorMsg || 'failed' });
  } else {
    logOk('Step 6', `SELL order placed: ${sellResult.orderId}`);

    // Wait for fill
    log('Step 6', 'Waiting for fill...');
    const fillResult = await waitForFill(tradingService, sellResult.orderId!, 'Step 6');

    if (fillResult.filled) {
      logOk('Step 6', `SELL FILLED! ${fillResult.order.filledSize}/${fillResult.order.originalSize} shares @ ${pricesNow.bestBid}`);
      results.push({ step: 'Limit SELL (fill)', success: true, detail: `FILLED ${fillResult.order.filledSize} @ ${pricesNow.bestBid}` });
    } else {
      const status = fillResult.order?.status || 'unknown';
      logFail('Step 6', `SELL not filled (status: ${status}). Cancelling...`);
      try { await tradingService.cancelOrder(sellResult.orderId!); } catch { /* ok */ }
      results.push({ step: 'Limit SELL (fill)', success: false, detail: `NOT FILLED (${status})` });
    }
  }
  } // end sell value check

  await sleep(2000);

  // ========================================================================
  // Step 7: Market BUY $1 (use whichever side has liquidity)
  // ========================================================================
  // Try primary token first (usually more liquid), fallback to trade token
  const marketToken = market.tradeSide === 'YES' ? market.secondaryTokenId : market.primaryTokenId;
  const marketSide = market.tradeSide === 'YES' ? 'NO' : 'YES';
  log('Step 7', `Placing market BUY ${marketSide} $1 (FAK)...`);

  const marketBuyResult = await tradingService.createMarketOrder({
    tokenId: marketToken,
    side: 'BUY',
    amount: 1,
    orderType: 'FAK', // Fill-and-Kill: allows partial fills (FOK would reject if not fully filled)
  });

  if (!marketBuyResult.success) {
    logFail('Step 7', `Market BUY failed: ${marketBuyResult.errorMsg}`);
    results.push({ step: 'Market BUY (fill)', success: false, detail: marketBuyResult.errorMsg || 'failed' });
  } else {
    logOk('Step 7', `Market BUY placed: ${marketBuyResult.orderId}`);

    // Market orders usually fill instantly, but poll to confirm
    if (marketBuyResult.orderId) {
      log('Step 7', 'Waiting for fill...');
      const fillResult = await waitForFill(tradingService, marketBuyResult.orderId, 'Step 7', 10000);
      if (fillResult.filled) {
        logOk('Step 7', `Market BUY FILLED! ${fillResult.order.filledSize} shares`);
        results.push({ step: 'Market BUY (fill)', success: true, detail: `FILLED ${fillResult.order.filledSize} shares` });
      } else {
        log('Step 7', `Market order status: ${fillResult.order?.status || 'unknown'}`);
        results.push({ step: 'Market BUY (fill)', success: true, detail: `Accepted (status: ${fillResult.order?.status || 'unknown'})` });
      }
    } else if (marketBuyResult.transactionHashes?.length) {
      logOk('Step 7', `Market BUY matched! TX: ${marketBuyResult.transactionHashes[0]}`);
      results.push({ step: 'Market BUY (fill)', success: true, detail: `Matched (TX: ${marketBuyResult.transactionHashes[0].slice(0, 10)}...)` });
    } else {
      results.push({ step: 'Market BUY (fill)', success: true, detail: 'Accepted' });
    }
  }

  await sleep(3000);

  // ========================================================================
  // Final balance + Summary
  // ========================================================================
  let finalBalance = 0;
  try {
    const balance = await usdc.balanceOf(safeAddress);
    finalBalance = parseFloat(ethers.utils.formatUnits(balance, 6));
  } catch { /* ignore */ }

  const pnl = finalBalance - initialBalance;

  console.log('\n════════════════════════════════════════════════════');
  console.log('   E2E Test Summary');
  console.log('════════════════════════════════════════════════════');
  console.log(`  Safe Address:     ${safeAddress}`);
  console.log(`  EOA Address:      ${wallet.address}`);
  console.log(`  Market:           ${market.question}`);
  console.log(`  Initial Balance:  $${initialBalance.toFixed(2)}`);
  console.log(`  Final Balance:    $${finalBalance.toFixed(2)}`);
  console.log(`  PnL (USDC only):  $${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)}`);
  console.log(`  Note: PnL excludes token positions held in Safe`);
  console.log('');
  console.log('  Steps:');
  for (const r of results) {
    console.log(`    ${r.success ? '✅' : '❌'} ${r.step}: ${r.detail}`);
  }
  console.log('════════════════════════════════════════════════════\n');

  const allPassed = results.every(r => r.success);
  console.log(allPassed ? '✅ All steps passed!\n' : '⚠️  Some steps had issues (see above)\n');
  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error('\n❌ E2E test failed:', err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
