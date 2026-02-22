/**
 * Full E2E Copy Trading Test — BUY + SELL Round Trip
 *
 * Controls BOTH wallets programmatically:
 * - Target wallet (被跟单方): places BUY and SELL orders on a 15m crypto market
 * - Copy wallet (跟单方): detects and auto-copies via SmartMoneyService + OrderManager
 *
 * Key Metric: match_time → copy_order_time latency
 *   match_time = target order matched on CLOB (from Data API activity.timestamp)
 *   copy_order_time = copy order placed via OrderManager
 *   The shorter this gap, the better.
 *
 * Usage (from poly-sdk dir):
 *   npx tsx scripts/test-copy-trading-full-e2e.ts
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env files
function loadEnv(path: string, overwrite = false) {
  if (!existsSync(path)) return;
  const content = readFileSync(path, 'utf-8');
  for (const line of content.split('\n')) {
    const [key, ...valueParts] = line.split('=');
    if (key && !key.startsWith('#')) {
      const value = valueParts.join('=').trim();
      if (value && (overwrite || !process.env[key.trim()])) {
        process.env[key.trim()] = value.replace(/^["']|["']$/g, '');
      }
    }
  }
}

loadEnv(resolve(__dirname, '../..', '.env'));
loadEnv(resolve(__dirname, '..', '.env'), true);

import { PolymarketSDK } from '../src/index.js';
import { OrderManager } from '../src/services/order-manager.js';
import { TradingService } from '../src/services/trading-service.js';
import { RelayerService } from '../src/services/relayer-service.js';
import { RateLimiter } from '../src/core/rate-limiter.js';
import { createUnifiedCache } from '../src/core/unified-cache.js';
import type { SmartMoneyTrade } from '../src/services/smart-money-service.js';

// ============================================================================
// Configuration
// ============================================================================

const COPY_PRIVATE_KEY = process.env.PRIVATE_KEY!;
const COPY_BUILDER = {
  key: process.env.POLY_BUILDER_API_KEY!,
  secret: process.env.POLY_BUILDER_SECRET!,
  passphrase: process.env.POLY_BUILDER_PASSPHRASE!,
};

const TARGET_PRIVATE_KEY = process.env.TARGET_PRIVATE_KEY!;
const TARGET_BUILDER = {
  key: process.env.TARGET_BUILDER_API_KEY!,
  secret: process.env.TARGET_BUILDER_SECRET!,
  passphrase: process.env.TARGET_BUILDER_PASSPHRASE!,
};

const DETECTION_MODE = (process.env.DETECTION_MODE || 'polling') as 'polling' | 'mempool' | 'dual';
const POLYGON_RPC_URL = process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com';

function validateEnv() {
  const required = [
    ['PRIVATE_KEY', COPY_PRIVATE_KEY],
    ['POLY_BUILDER_API_KEY', COPY_BUILDER.key],
    ['POLY_BUILDER_SECRET', COPY_BUILDER.secret],
    ['POLY_BUILDER_PASSPHRASE', COPY_BUILDER.passphrase],
    ['TARGET_PRIVATE_KEY', TARGET_PRIVATE_KEY],
    ['TARGET_BUILDER_API_KEY', TARGET_BUILDER.key],
    ['TARGET_BUILDER_SECRET', TARGET_BUILDER.secret],
    ['TARGET_BUILDER_PASSPHRASE', TARGET_BUILDER.passphrase],
  ];
  const missing = required.filter(([, v]) => !v).map(([k]) => k);
  if (missing.length > 0) {
    console.error('Missing:', missing.join(', '));
    process.exit(1);
  }
}

// ============================================================================
// Helpers
// ============================================================================

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const fmtTime = (ms: number) => new Date(ms).toISOString().split('T')[1].replace('Z', '');
const log = (tag: string, msg: string) => console.log(`[${fmtTime(Date.now())}] [${tag}] ${msg}`);

// ============================================================================
// Timing — the core metric
// ============================================================================

interface TimingRecord {
  phase: string;               // "BUY" or "SELL"
  targetPlaceTime: number;     // when we called createLimitOrder (local clock)
  matchTime?: number;          // trade.timestamp from Data API / mempool (CLOB match time)
  copyDetectTime?: number;     // when onTrade callback fired (local clock)
  copyOrderPlaceTime?: number; // when copy order was placed (local clock)
  copyFillTime?: number;       // when copy order was filled (local clock)
  targetOrderId?: string;
  copyOrderId?: string;
  success: boolean;
}

const timings: TimingRecord[] = [];

function printReport() {
  console.log('\n╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║                     E2E COPY TRADING REPORT                         ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝\n');

  console.log(`Detection Mode: ${DETECTION_MODE}`);
  console.log(`Test Time: ${new Date().toISOString()}\n`);

  // Table header
  console.log('┌──────────┬─────────────────┬─────────────────┬─────────────────┬──────────────┬──────────────┐');
  console.log('│ Phase    │ Target Matched  │ Copy Detected   │ Copy Ordered    │ Detect Δ (s) │ Order Δ (s)  │');
  console.log('├──────────┼─────────────────┼─────────────────┼─────────────────┼──────────────┼──────────────┤');

  for (const t of timings) {
    const matchStr = t.matchTime ? fmtTime(t.matchTime).slice(0, 12) : 'N/A'.padEnd(12);
    const detectStr = t.copyDetectTime ? fmtTime(t.copyDetectTime).slice(0, 12) : 'N/A'.padEnd(12);
    const orderStr = t.copyOrderPlaceTime ? fmtTime(t.copyOrderPlaceTime).slice(0, 12) : 'N/A'.padEnd(12);

    // Key latency: match_time → copy detect
    const detectDelta = (t.matchTime && t.copyDetectTime)
      ? ((t.copyDetectTime - t.matchTime) / 1000).toFixed(1)
      : 'N/A';

    // Key latency: match_time → copy order placed
    const orderDelta = (t.matchTime && t.copyOrderPlaceTime)
      ? ((t.copyOrderPlaceTime - t.matchTime) / 1000).toFixed(1)
      : 'N/A';

    console.log(
      `│ ${t.phase.padEnd(8)} │ ${matchStr.padEnd(15)} │ ${detectStr.padEnd(15)} │ ${orderStr.padEnd(15)} │ ${detectDelta.padStart(10)}s │ ${orderDelta.padStart(10)}s │`
    );
  }

  console.log('└──────────┴─────────────────┴─────────────────┴─────────────────┴──────────────┴──────────────┘');

  // Summary
  console.log('\nLatency Summary:');
  for (const t of timings) {
    const icon = t.success ? '✅' : '❌';
    if (t.matchTime && t.copyOrderPlaceTime) {
      const totalLatency = ((t.copyOrderPlaceTime - t.matchTime) / 1000).toFixed(1);
      console.log(`  ${icon} ${t.phase}: target_match → copy_order = ${totalLatency}s`);
      if (t.copyFillTime) {
        const fillLatency = ((t.copyFillTime - t.matchTime) / 1000).toFixed(1);
        console.log(`     target_match → copy_filled = ${fillLatency}s`);
      }
    } else if (!t.matchTime) {
      console.log(`  ${icon} ${t.phase}: NOT detected`);
    } else {
      console.log(`  ${icon} ${t.phase}: detected but copy order failed`);
    }
  }

  // Fill timing detail
  console.log('\nDetailed Timeline:');
  for (const t of timings) {
    console.log(`\n  ${t.phase}:`);
    console.log(`    1. Target placed order:   ${t.targetPlaceTime ? fmtTime(t.targetPlaceTime) : '-'} (local)`);
    console.log(`    2. Target matched (CLOB): ${t.matchTime ? fmtTime(t.matchTime) : '-'} (Data API timestamp)`);
    if (t.copyDetectTime) {
      console.log(`    3. Copy detected:         ${fmtTime(t.copyDetectTime)} (+${((t.copyDetectTime - (t.matchTime || t.targetPlaceTime)) / 1000).toFixed(1)}s)`);
    }
    if (t.copyOrderPlaceTime) {
      console.log(`    4. Copy order placed:     ${fmtTime(t.copyOrderPlaceTime)} (+${((t.copyOrderPlaceTime - (t.matchTime || t.targetPlaceTime)) / 1000).toFixed(1)}s)`);
    }
    if (t.copyFillTime) {
      console.log(`    5. Copy order filled:     ${fmtTime(t.copyFillTime)} (+${((t.copyFillTime - (t.matchTime || t.targetPlaceTime)) / 1000).toFixed(1)}s)`);
    }
    if (t.targetOrderId) console.log(`    Target order: ${t.targetOrderId}`);
    if (t.copyOrderId) console.log(`    Copy order:   ${t.copyOrderId}`);
  }
}

// ============================================================================
// Market Discovery
// ============================================================================

interface MarketInfo {
  conditionId: string;
  slug: string;
  question: string;
  tokenIdUp: string;
  tokenIdDown: string;
  priceUp: number;
  priceDown: number;
  minutesLeft: number;
}

async function discoverMarket(sdk: PolymarketSDK): Promise<MarketInfo> {
  log('MARKET', 'Searching for active 15m BTC market via scanCryptoShortTermMarkets...');

  // Option 1: Use env var override (for debugging specific market)
  const conditionOverride = process.env.MARKET_CONDITION_ID;
  let conditionId: string;
  let slug: string;
  let question: string;
  let gammaEndDate: Date | string | undefined;

  if (conditionOverride) {
    conditionId = conditionOverride;
    slug = process.env.MARKET_SLUG || conditionId;
    question = slug;
    gammaEndDate = undefined;
    log('MARKET', `Using env MARKET_CONDITION_ID: ${conditionId}`);
  } else {
    // Auto-discover via MarketService.scanCryptoShortTermMarkets()
    const markets = await sdk.markets.scanCryptoShortTermMarkets({
      coin: 'BTC',
      duration: '15m',
      minMinutesUntilEnd: 10,
      maxMinutesUntilEnd: 25,
      sortBy: 'endDate',
      limit: 10,
    });

    if (markets.length === 0) {
      throw new Error('No suitable 15m BTC market found. Try again shortly or set MARKET_CONDITION_ID in .env');
    }

    // Pick the soonest market (sorted by endDate)
    const picked = markets[0];
    conditionId = picked.conditionId;
    slug = picked.slug;
    question = picked.question;
    gammaEndDate = picked.endDate;
    const pickedEnd = picked.endDate ? new Date(picked.endDate).getTime() : 0;
    const pickedMinLeft = Math.round((pickedEnd - Date.now()) / 60000);
    log('MARKET', `Found ${markets.length} markets, picked: ${slug} (${pickedMinLeft} min left)`);
  }

  log('MARKET', `Question: ${question!}`);

  // Get token IDs + prices directly from CLOB REST API
  // (SDK's ClobClient may fail silently for some markets)
  const clobUrl = `https://clob.polymarket.com/markets/${conditionId!}`;
  const clobRes = await fetch(clobUrl);
  if (!clobRes.ok) throw new Error(`CLOB API error ${clobRes.status} for ${conditionId!}`);
  const clobData = await clobRes.json() as {
    tokens: { token_id: string; outcome: string; price: number }[];
    end_date_iso: string;
  };

  if (!clobData.tokens || clobData.tokens.length < 2) {
    throw new Error(`CLOB market has no tokens: ${conditionId!}`);
  }

  const upToken = clobData.tokens.find(t => t.outcome === 'Up') || clobData.tokens[0];
  const downToken = clobData.tokens.find(t => t.outcome === 'Down') || clobData.tokens[1];
  // Use Gamma endDate (CLOB end_date_iso is unreliable for crypto short-term markets)
  const endDateMs = gammaEndDate ? new Date(gammaEndDate).getTime() : Date.now() + 15 * 60000;
  const minutesLeft = Math.round((endDateMs - Date.now()) / 60000);

  const info: MarketInfo = {
    conditionId: conditionId!,
    slug: slug!,
    question: question!,
    tokenIdUp: upToken.token_id,
    tokenIdDown: downToken.token_id,
    priceUp: upToken.price,
    priceDown: downToken.price,
    minutesLeft,
  };

  log('MARKET', `Condition: ${info.conditionId}`);
  log('MARKET', `Up:   ...${info.tokenIdUp.slice(-10)} @ $${info.priceUp}`);
  log('MARKET', `Down: ...${info.tokenIdDown.slice(-10)} @ $${info.priceDown}`);
  log('MARKET', `Ends in: ${info.minutesLeft} min`);

  return info;
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  validateEnv();

  console.log('========================================');
  console.log('Full E2E Copy Trading Test');
  console.log(`Detection: ${DETECTION_MODE} | ${new Date().toISOString()}`);
  console.log('========================================\n');

  // ------------------------------------------------------------------
  // Step 1: Initialize Target (被跟单方)
  // ------------------------------------------------------------------
  log('SETUP', 'Initializing Target wallet...');
  const targetRelayer = new RelayerService({
    privateKey: TARGET_PRIVATE_KEY,
    builderCreds: TARGET_BUILDER,
    rpcUrl: POLYGON_RPC_URL,
  });
  const targetSafe = await targetRelayer.getSafeAddress();
  log('SETUP', `Target EOA:  ${targetRelayer.getSignerAddress()}`);
  log('SETUP', `Target Safe: ${targetSafe}`);

  const targetRL = new RateLimiter();
  const targetCache = createUnifiedCache();
  const targetTrading = new TradingService(targetRL, targetCache, {
    privateKey: TARGET_PRIVATE_KEY,
    builderCreds: TARGET_BUILDER,
    safeAddress: targetSafe,
  });
  await targetTrading.initialize();
  log('SETUP', 'Target TradingService ready (Builder mode)');

  // ------------------------------------------------------------------
  // Step 2: Initialize Copy (跟单方)
  // ------------------------------------------------------------------
  log('SETUP', 'Initializing Copy wallet...');
  const copyRelayer = new RelayerService({
    privateKey: COPY_PRIVATE_KEY,
    builderCreds: COPY_BUILDER,
    rpcUrl: POLYGON_RPC_URL,
  });
  const copySafe = await copyRelayer.getSafeAddress();
  log('SETUP', `Copy EOA:  ${copyRelayer.getSignerAddress()}`);
  log('SETUP', `Copy Safe: ${copySafe}`);

  const copyRL = new RateLimiter();
  const copyCache = createUnifiedCache();
  const copySdk = new PolymarketSDK({
    privateKey: COPY_PRIVATE_KEY,
    rateLimiter: copyRL,
    cache: copyCache,
    builderCreds: COPY_BUILDER,
    mempoolWssUrl: process.env.MEMPOOL_WSS_RPC,
  });

  const copyOM = new OrderManager({
    privateKey: COPY_PRIVATE_KEY,
    rateLimiter: copyRL,
    cache: copyCache,
    polygonRpcUrl: POLYGON_RPC_URL,
    builderCreds: COPY_BUILDER,
    safeAddress: copySafe,
  });
  await copyOM.start();
  log('SETUP', 'Copy OrderManager started');
  copyOM.on('error', (e: any) => log('OM', `err: ${e.message || e}`));

  // ------------------------------------------------------------------
  // Step 3: Discover market
  // ------------------------------------------------------------------
  const market = await discoverMarket(copySdk);

  // ------------------------------------------------------------------
  // Step 4: Diagnostic - verify Data API can see the target address
  // ------------------------------------------------------------------
  log('DIAG', `Verifying Data API for target: ${targetSafe}`);
  const diagUrl = `https://data-api.polymarket.com/activity?user=${targetSafe}&limit=3&type=TRADE`;
  const diagRes = await fetch(diagUrl);
  const diagData = await diagRes.json() as any[];
  log('DIAG', `Data API returned ${diagData.length} past activities for target Safe`);
  if (diagData.length > 0) {
    log('DIAG', `Latest: ${diagData[0].side} ${diagData[0].size} @ ${diagData[0].price} at ${diagData[0].timestamp} (${new Date(diagData[0].timestamp * 1000).toISOString()})`);
  }

  // ------------------------------------------------------------------
  // Step 5: Start Copy Trading
  // ------------------------------------------------------------------
  log('COPY', `Starting auto copy trading on ${targetSafe.slice(0, 10)}...`);
  log('COPY', `Detection: ${DETECTION_MODE} | limit GTC +0.02 | scale 1.0 | max $5`);

  let phase1Detected = false;
  let phase2Detected = false;
  let detectionCount = 0;

  const sub = await copySdk.smartMoney.startAutoCopyTrading({
    targetAddresses: [targetSafe],
    detectionMode: DETECTION_MODE,
    orderManager: copyOM,
    orderMode: 'limit',
    limitPriceOffset: 0.02,
    priceRange: { min: 0.05, max: 0.95 },
    sizeScale: 1.0,
    maxSizePerTrade: 5,
    minTradeSize: 0.1,
    dryRun: false,

    onTrade: (trade: SmartMoneyTrade, result: any) => {
      const now = Date.now();
      detectionCount++;
      // Match to timing record by order (first undetected)
      const timing = timings.find(t => !t.copyDetectTime);

      // trade.timestamp: Data API = unix seconds, Mempool = ms
      // Normalize to ms
      const matchTime = trade.timestamp < 1e12 ? trade.timestamp * 1000 : trade.timestamp;

      if (timing) {
        timing.matchTime = matchTime;
        timing.copyDetectTime = now;
        if (result.success) {
          timing.copyOrderPlaceTime = now;
          timing.copyOrderId = result.orderId;
          timing.success = true;
        }
      }

      const latency = matchTime ? ((now - matchTime) / 1000).toFixed(1) : '?';
      const icon = result.success ? '✅' : '❌';
      log('COPY', `${icon} ${trade.side} detected → ${result.success ? 'copied' : 'FAILED'} | match→order: ${latency}s | orderId: ${result.orderId || result.errorMsg}`);

      if (detectionCount === 1) phase1Detected = true;
      if (detectionCount >= 2) phase2Detected = true;
    },

    onOrderPlaced: (handle: any) => {
      log('COPY', `Order placed: ${handle.orderId || 'pending'}`);
    },

    onOrderFilled: (fill: any) => {
      const now = Date.now();
      for (const t of timings) {
        if (t.copyOrderPlaceTime && !t.copyFillTime) {
          t.copyFillTime = now;
          const latency = t.matchTime ? ((now - t.matchTime) / 1000).toFixed(1) : '?';
          log('COPY', `Order FILLED: ${fill.fill?.size} @ $${fill.fill?.price} | match→fill: ${latency}s`);
          break;
        }
      }
    },

    onError: (err: Error) => log('COPY', `Error: ${err.message}`),
  });

  log('COPY', `Subscription: ${sub.id}`);
  await sleep(3000);

  // ------------------------------------------------------------------
  // Step 5: Target trades — BUY Up + BUY Down
  //
  // Crypto 15m markets have extreme orderbooks (bids 0.01-0.05, asks 0.95-0.99).
  // SELL is impractical (5 shares × $0.01 = $0.05, below $1 min).
  // Instead we test two BUY trades: BUY "Up" then BUY "Down".
  // ------------------------------------------------------------------
  // Helper: fetch best bid/ask from CLOB orderbook
  async function getBookPrices(tokenId: string): Promise<{ bestBid: number; bestAsk: number }> {
    const res = await fetch(`https://clob.polymarket.com/book?token_id=${tokenId}`);
    const book = await res.json() as { bids: { price: string }[]; asks: { price: string }[] };
    const bestBid = book.bids?.[0] ? parseFloat(book.bids[0].price) : 0;
    const bestAsk = book.asks?.[0] ? parseFloat(book.asks[0].price) : 1;
    return { bestBid, bestAsk };
  }

  const BUY_SIZE = 5; // Polymarket minimum
  const waitMs = DETECTION_MODE === 'polling' ? 15000 : 8000;

  // ---- Phase 1: BUY Up ----
  console.log('\n── Phase 1: Target BUY "Up" ─────────────────────────────────\n');

  const bookUp = await getBookPrices(market.tokenIdUp);
  log('BOOK', `Up: bid=${bookUp.bestBid} ask=${bookUp.bestAsk}`);

  const buyUpPrice = bookUp.bestAsk;
  log('TARGET', `BUY ${BUY_SIZE} shares "Up" @ $${buyUpPrice} (GTC, taker at best ask, cost=$${(BUY_SIZE * buyUpPrice).toFixed(2)})`);

  const buyUpTiming: TimingRecord = { phase: 'BUY_UP', targetPlaceTime: Date.now(), success: false };
  timings.push(buyUpTiming);

  const buyUpResult = await targetTrading.createLimitOrder({
    tokenId: market.tokenIdUp,
    side: 'BUY',
    price: buyUpPrice,
    size: BUY_SIZE,
    orderType: 'GTC',
  });
  buyUpTiming.targetPlaceTime = Date.now();

  if (buyUpResult.success) {
    buyUpTiming.targetOrderId = buyUpResult.orderId;
    log('TARGET', `✅ BUY Up placed: ${buyUpResult.orderId}`);
  } else {
    log('TARGET', `❌ BUY Up failed: ${buyUpResult.errorMsg}`);
  }

  log('WAIT', `${waitMs / 1000}s for detection (${DETECTION_MODE})...`);
  await sleep(waitMs);

  // Diagnostic
  {
    const now = Math.floor(Date.now() / 1000);
    const checkUrl = `https://data-api.polymarket.com/activity?user=${targetSafe}&limit=5&type=TRADE&start=${now - 60}`;
    const checkRes = await fetch(checkUrl);
    const checkData = await checkRes.json() as any[];
    log('DIAG', `After BUY Up: Data API has ${checkData.length} recent trades (last 60s)`);
    for (const t of checkData.slice(0, 3)) {
      log('DIAG', `  ${t.side} ${t.size} @ ${t.price} ts=${t.timestamp}`);
    }
  }

  if (!phase1Detected) {
    log('WAIT', 'Phase 1 not detected, waiting 15s more...');
    await sleep(15000);
  }

  // ---- Phase 2: BUY Down ----
  console.log('\n── Phase 2: Target BUY "Down" ───────────────────────────────\n');

  const bookDown = await getBookPrices(market.tokenIdDown);
  log('BOOK', `Down: bid=${bookDown.bestBid} ask=${bookDown.bestAsk}`);

  const buyDownPrice = bookDown.bestAsk;
  log('TARGET', `BUY ${BUY_SIZE} shares "Down" @ $${buyDownPrice} (GTC, taker at best ask, cost=$${(BUY_SIZE * buyDownPrice).toFixed(2)})`);

  const buyDownTiming: TimingRecord = { phase: 'BUY_DOWN', targetPlaceTime: Date.now(), success: false };
  timings.push(buyDownTiming);

  const buyDownResult = await targetTrading.createLimitOrder({
    tokenId: market.tokenIdDown,
    side: 'BUY',
    price: buyDownPrice,
    size: BUY_SIZE,
    orderType: 'GTC',
  });
  buyDownTiming.targetPlaceTime = Date.now();

  if (buyDownResult.success) {
    buyDownTiming.targetOrderId = buyDownResult.orderId;
    log('TARGET', `✅ BUY Down placed: ${buyDownResult.orderId}`);
  } else {
    log('TARGET', `❌ BUY Down failed: ${buyDownResult.errorMsg}`);
  }

  log('WAIT', `${waitMs / 1000}s for detection...`);
  await sleep(waitMs);
  if (!phase2Detected) {
    log('WAIT', 'Phase 2 not detected, waiting 15s more...');
    await sleep(15000);
  }

  // ------------------------------------------------------------------
  // Step 7: Report
  // ------------------------------------------------------------------
  const stats = sub.getStats();

  console.log('\n── Stats ───────────────────────────────────────────────────\n');
  console.log(`Detection mode:    ${DETECTION_MODE}`);
  console.log(`Trades detected:   ${stats.tradesDetected}`);
  console.log(`Trades executed:   ${stats.tradesExecuted}`);
  console.log(`Trades skipped:    ${stats.tradesSkipped}`);
  console.log(`Trades failed:     ${stats.tradesFailed}`);
  console.log(`Filtered by price: ${stats.filteredByPrice || 0}`);
  console.log(`Total USDC spent:  $${stats.totalUsdcSpent.toFixed(2)}`);

  // Full timing report
  printReport();

  // ------------------------------------------------------------------
  // Cleanup
  // ------------------------------------------------------------------
  console.log('\nCleaning up...');
  sub.stop();
  copyOM.stop();
  copySdk.smartMoney.disconnect();

  // Cancel target orders (best effort)
  for (const res of [buyUpResult, buyDownResult]) {
    if (res.success && res.orderId) {
      await targetTrading.cancelOrder(res.orderId).catch(() => {});
    }
  }

  console.log('Done.\n');
  process.exit(0);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
