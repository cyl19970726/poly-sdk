#!/usr/bin/env npx tsx
/**
 * Copy-Trade Detection Latency Benchmark
 *
 * 对比 6 种交易检测方式的延迟，确定 copy-trading 策略的最优 DataSource 方案。
 *
 * 测试方法：
 * 1. 初始化 6 个检测器（并行）
 * 2. 用 hot wallet 在活跃市场下一笔小额限价单
 * 3. 等待成交，同时各检测器竞争检测
 * 4. 记录各方式的延迟 (t_detected - t_order_placed)
 * 5. 重复 N 轮取统计值
 *
 * 7 种检测方式：
 * 1. WS Market Channel (last_trade_price) — <100ms, 无交易者地址
 * 2. WS User Channel (USER_TRADE) — <200ms, 仅自己, 需 auth
 * 3. RPC Contract Events (OrderFilled) — ~2s (Polygon block), 有 maker/taker
 * 4. Mempool Pending TX (newPendingTransactions) — ~1-3s?, 有 maker/taker (from calldata)
 * 5. Subgraph (OrderFilledEvent) — 300-1500ms polling, 有 maker/taker
 * 6. Data API REST (/activity) — 200-800ms, 有地址
 * 7. SmartMoney Polling (5s interval) — 2-7s, 有地址
 *
 * Usage:
 *   PRIVATE_KEY=0x... npx tsx scripts/benchmark/copy-trade-detection-latency.ts
 *   PRIVATE_KEY=0x... npx tsx scripts/benchmark/copy-trade-detection-latency.ts --rounds=5
 */

import { ethers } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';

// Load .env file manually (dotenv not installed)
const envPath = path.resolve(import.meta.dirname || '.', '../../.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}
import { PolymarketSDK } from '../../src/index.js';
import type { LastTradeInfo, UserTrade } from '../../src/services/realtime-service-v2.js';
import {
  decodeMatchOrdersCalldata,
  isSettlementTx,
  extractTraderAddresses,
  MATCH_ORDERS_SELECTOR,
} from '../../src/utils/calldata-decoder.js';

// ========================================
// Configuration
// ========================================

const ROUNDS = parseInt(process.argv.find(a => a.startsWith('--rounds='))?.split('=')[1] || '3');
const ORDER_AMOUNT_USDC = 0.5; // ~$0.50 per round (budget-friendly)
const MIN_SHARES = 5; // Polymarket minimum order size
const POLYGON_RPC = process.env.POLYGON_RPC || 'wss://polygon-mainnet.g.alchemy.com/v2/demo';

// CTF Exchange addresses — events are emitted from these contracts
const CTF_EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
const NEG_RISK_CTF_EXCHANGE = '0xC5d563A36AE78145C45a50134d48A1215220f80a';

// Router addresses imported from src/utils/calldata-decoder.ts

// OrderFilled event signature from CTF Exchange
// event OrderFilled(bytes32 indexed orderHash, address indexed maker, address indexed taker, uint256 makerAssetId, uint256 takerAssetId, uint256 makerAmountFilled, uint256 takerAmountFilled, uint256 fee)
const ORDER_FILLED_TOPIC = ethers.utils.id(
  'OrderFilled(bytes32,address,address,uint256,uint256,uint256,uint256,uint256)'
);

// matchOrders calldata decoding imported from src/utils/calldata-decoder.ts
// Selector 0x2287e350 = FeeModule (Router) matchOrders with 7 params

// ========================================
// Types
// ========================================

interface DetectorResult {
  name: string;
  detected: boolean;
  latencyMs: number | null;
  hasTraderAddress: boolean;
  pushOrPoll: 'push' | 'poll';
  details?: string;
}

interface RoundResult {
  round: number;
  orderPlacedAt: number;
  orderFilledAt: number | null;
  /** CLOB server-side match timestamp (from WS USER_TRADE matchtime field) */
  matchTimeMs: number | null;
  tokenId: string;
  conditionId: string;
  detectors: DetectorResult[];
}

interface BenchmarkResult {
  timestamp: string;
  rounds: number;
  market: string;
  conditionId: string;
  orderAmount: number;
  results: RoundResult[];
  summary: DetectorSummary[];
}

interface DetectorSummary {
  name: string;
  detected: number;
  total: number;
  hasTraderAddress: boolean;
  pushOrPoll: 'push' | 'poll';
  avgMs: number | null;
  minMs: number | null;
  maxMs: number | null;
  p50Ms: number | null;
}

// ========================================
// Detector Setup
// ========================================

class DetectorManager {
  private detectors: Map<string, {
    detected: boolean;
    latencyMs: number | null;
    hasTraderAddress: boolean;
    pushOrPoll: 'push' | 'poll';
    details?: string;
  }> = new Map();

  private t0: number = 0;

  reset(t0: number) {
    this.t0 = t0;
    this.detectors.clear();
    // Initialize all detectors
    for (const name of [
      'WS Market Channel',
      'WS User Channel',
      'RPC Contract Events',
      'Mempool Pending TX',
      'Subgraph',
      'Data API REST',
      'SmartMoney Polling',
    ]) {
      this.detectors.set(name, {
        detected: false,
        latencyMs: null,
        hasTraderAddress: name !== 'WS Market Channel',
        pushOrPoll: ['WS Market Channel', 'WS User Channel', 'RPC Contract Events', 'Mempool Pending TX'].includes(name) ? 'push' : 'poll',
      });
    }
  }

  markDetected(name: string, details?: string) {
    const d = this.detectors.get(name);
    if (d && !d.detected) {
      d.detected = true;
      d.latencyMs = Date.now() - this.t0;
      d.details = details;
      console.log(`   [${name}] Detected! Latency: ${d.latencyMs}ms ${details ? `(${details})` : ''}`);
    }
  }

  allDetected(): boolean {
    return Array.from(this.detectors.values()).every(d => d.detected);
  }

  getResults(): DetectorResult[] {
    return Array.from(this.detectors.entries()).map(([name, d]) => ({
      name,
      ...d,
    }));
  }
}

// ========================================
// Main
// ========================================

async function main() {
  // Catch async WSS subscription errors from ethers v5 that are thrown
  // in the WebSocket onmessage handler (not emitted as 'error' events)
  process.on('uncaughtException', (err: Error) => {
    if (err.message.includes('No alive WS nodes')) {
      console.log(`   ⚠️ RPC WSS subscription failed (provider does not support log subscriptions)`);
      return; // Don't crash
    }
    // Re-throw other uncaught exceptions
    console.error('Uncaught exception:', err);
    process.exit(1);
  });

  // Validate environment
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    console.error('ERROR: PRIVATE_KEY environment variable required');
    console.error('Usage: PRIVATE_KEY=0x... npx tsx scripts/benchmark/copy-trade-detection-latency.ts');
    process.exit(1);
  }

  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════════╗');
  console.log('║     Copy-Trade Detection Latency Benchmark                      ║');
  console.log('╠══════════════════════════════════════════════════════════════════╣');
  console.log(`║  Rounds:    ${ROUNDS}                                                       ║`);
  console.log(`║  Amount:    $${ORDER_AMOUNT_USDC} per order                                          ║`);
  console.log('╚══════════════════════════════════════════════════════════════════╝');
  console.log('');

  // Initialize SDK (derives CLOB API creds from private key automatically)
  const sdk = new PolymarketSDK({ privateKey });
  await sdk.initialize();

  // Get derived API credentials for WS User Channel auth
  const derivedCreds = sdk.tradingService.getCredentials();
  const hasApiCreds = !!derivedCreds;
  console.log(`API Creds: ${hasApiCreds ? 'YES (derived from private key)' : 'NO (WS User Channel skipped)'}`);

  const wallet = new ethers.Wallet(privateKey);
  const walletAddress = wallet.address.toLowerCase();
  console.log(`Wallet: ${walletAddress}`);

  // Find an active market (use 15-min BTC market for high activity)
  console.log('\n🔍 Finding active market...');
  // Try BTC first, then any coin. Try all durations.
  let markets = await sdk.dipArb.scanUpcomingMarkets({
    coin: 'BTC',
    duration: 'all',
    minMinutesUntilEnd: 3,
    maxMinutesUntilEnd: 14,
    limit: 5,
  });
  if (markets.length === 0) {
    console.log('   No BTC markets, trying all coins...');
    markets = await sdk.dipArb.scanUpcomingMarkets({
      coin: 'all',
      duration: 'all',
      minMinutesUntilEnd: 3,
      maxMinutesUntilEnd: 14,
      limit: 5,
    });
  }
  // Markets are sorted by endTime (soonest first) by default

  if (markets.length === 0) {
    console.error('❌ No active markets found. Try again later.');
    process.exit(1);
  }

  const market = markets[0];
  console.log(`✅ Found: ${market.name}`);
  console.log(`   Condition: ${market.conditionId}`);
  console.log(`   UP Token:  ${market.upTokenId.slice(0, 30)}...`);
  console.log(`   DOWN Token: ${market.downTokenId.slice(0, 30)}...`);

  // Pick the cheaper token to minimize cost per order
  let targetTokenId = market.upTokenId;
  let isDownToken = false;
  try {
    const book = await sdk.getOrderbook(market.conditionId);
    if (book?.no?.ask > 0 && book?.yes?.ask > 0 && book.no.ask < book.yes.ask) {
      targetTokenId = market.downTokenId;
      isDownToken = true;
      console.log(`   Using DOWN token (cheaper: $${book.no.ask} vs $${book.yes.ask})`);
    } else {
      console.log(`   Using UP token ($${book?.yes?.ask || '?'})`);
    }
  } catch {
    console.log('   Using UP token (default)');
  }

  // Update CLOB balance allowance
  console.log('\n💰 Updating CLOB balance/allowance...');
  try {
    await sdk.tradingService.updateBalanceAllowance();
    console.log('   ✅ Balance updated');
  } catch (err: any) {
    console.log(`   ⚠️ Balance update failed: ${err.message}`);
  }

  // ========================================
  // Setup Detectors
  // ========================================

  const detectorManager = new DetectorManager();
  const roundResults: RoundResult[] = [];

  // --- 1. WS Market Channel ---
  console.log('\n📡 Setting up detectors...');
  console.log('   [1/7] WS Market Channel (last_trade_price)...');
  const realtimeService = sdk.realtime;
  try {
    await realtimeService.connect();
    console.log('   ✅ WS connected');
  } catch (err) {
    console.log(`   ⚠️ WS connection warning: ${(err as Error).message}`);
  }

  const marketSub = realtimeService.subscribeMarkets(
    [market.upTokenId, market.downTokenId],
    {
      onLastTrade: (trade: LastTradeInfo) => {
        if (trade.assetId === targetTokenId) {
          detectorManager.markDetected(
            'WS Market Channel',
            `price=${trade.price} side=${trade.side} size=${trade.size}`
          );
        }
      },
    }
  );

  // --- 2. WS User Channel ---
  // Track matchTime from USER_TRADE events (server-side CLOB match timestamp)
  let lastMatchTimeMs: number | null = null;

  if (hasApiCreds && derivedCreds) {
    console.log('   [2/7] WS User Channel (USER_TRADE)...');
    realtimeService.subscribeUserEvents(
      { apiKey: derivedCreds.key, secret: derivedCreds.secret, passphrase: derivedCreds.passphrase },
      {
        onTrade: (trade: UserTrade) => {
          // Capture matchTime for baseline measurement
          if (trade.matchTime) {
            lastMatchTimeMs = trade.matchTime;
          }
          detectorManager.markDetected(
            'WS User Channel',
            `status=${trade.status} price=${trade.price} matchTime=${trade.matchTime || 'N/A'}`
          );
        },
      }
    );
    // Wait a moment for user channel connection
    await new Promise(resolve => setTimeout(resolve, 2000));
    console.log('   ✅ WS User Channel subscribed');
  } else {
    console.log('   [2/7] WS User Channel — SKIPPED (no API creds)');
  }

  // --- 3. RPC Contract Events ---
  console.log('   [3/7] RPC Contract Events (OrderFilled)...');
  let rpcProvider: ethers.providers.WebSocketProvider | null = null;
  const rpcUrl = process.env.POLYGON_WSS_RPC;
  if (rpcUrl) {
    try {
      rpcProvider = new ethers.providers.WebSocketProvider(rpcUrl);

      // Handle connection errors gracefully
      rpcProvider.on('error', (err: Error) => {
        console.log(`   ⚠️ RPC provider error: ${err.message}`);
      });

      // Wait for the provider to be ready
      await rpcProvider.ready;

      // Listen for OrderFilled events on both exchanges
      // Note: use separate filters per address (ethers v5 ENS resolution bug with address arrays on non-ETH networks)
      const onOrderFilled = (log: ethers.providers.Log) => {
        // Decode maker/taker from indexed topics
        // topics[1] = orderHash, topics[2] = maker, topics[3] = taker
        const maker = log.topics[2] ? ethers.utils.getAddress('0x' + log.topics[2].slice(26)) : '';
        const taker = log.topics[3] ? ethers.utils.getAddress('0x' + log.topics[3].slice(26)) : '';
        const isSelf = maker.toLowerCase() === walletAddress || taker.toLowerCase() === walletAddress;

        if (isSelf) {
          detectorManager.markDetected(
            'RPC Contract Events',
            `maker=${maker.slice(0, 10)} taker=${taker.slice(0, 10)} block=${log.blockNumber}`
          );
        }
      };

      rpcProvider.on({ address: CTF_EXCHANGE, topics: [ORDER_FILLED_TOPIC] }, onOrderFilled);
      rpcProvider.on({ address: NEG_RISK_CTF_EXCHANGE, topics: [ORDER_FILLED_TOPIC] }, onOrderFilled);
      console.log(`   ✅ RPC Contract Events listener active (${rpcUrl.replace(/\/[^/]+$/, '/***')})`);
    } catch (err) {
      console.log(`   ⚠️ RPC Contract Events setup failed: ${(err as Error).message}`);
      rpcProvider = null;
    }
  } else {
    console.log('   ⚠️ RPC Contract Events — SKIPPED (set POLYGON_WSS_RPC for this detector)');
  }

  // --- 4. Mempool Pending TX ---
  console.log('   [4/7] Mempool Pending TX (newPendingTransactions)...');
  let mempoolProvider: ethers.providers.WebSocketProvider | null = null;
  const mempoolWssUrl = process.env.MEMPOOL_WSS_RPC;
  if (mempoolWssUrl) {
    try {
      mempoolProvider = new ethers.providers.WebSocketProvider(mempoolWssUrl);
      mempoolProvider.on('error', (err: Error) => {
        console.log(`   ⚠️ Mempool provider error: ${err.message}`);
      });
      await mempoolProvider.ready;

      // Subscribe to pending transactions — use imported isSettlementTx + decodeMatchOrdersCalldata
      mempoolProvider.on('pending', async (txHash: string) => {
        try {
          const tx = await mempoolProvider!.getTransaction(txHash);
          if (!tx || !isSettlementTx(tx.to)) return;

          // Decode matchOrders calldata to extract maker/taker addresses
          const decoded = decodeMatchOrdersCalldata(tx.data);
          if (decoded) {
            const allAddresses = extractTraderAddresses(decoded);
            if (allAddresses.includes(walletAddress)) {
              detectorManager.markDetected(
                'Mempool Pending TX',
                `txHash=${txHash.slice(0, 10)} taker=${decoded.takerOrder.maker.slice(0, 10)} makers=${decoded.makerOrders.length} tokenId=${decoded.takerOrder.tokenId.slice(0, 10)}...`
              );
            }
          } else if (tx.data && tx.data.toLowerCase().includes(walletAddress.slice(2).toLowerCase())) {
            // Fallback: raw string search for non-matchOrders settlement TXs (fillOrder, fillOrders)
            detectorManager.markDetected(
              'Mempool Pending TX',
              `txHash=${txHash.slice(0, 10)} to=${tx.to!.slice(0, 10)} nonce=${tx.nonce} (raw match)`
            );
          }
        } catch {
          // getTransaction may fail for already-mined TXs, ignore
        }
      });
      console.log(`   ✅ Mempool Pending TX listener active (${mempoolWssUrl.replace(/\/[^/]+$/, '/***')})`);
    } catch (err) {
      console.log(`   ⚠️ Mempool setup failed: ${(err as Error).message}`);
      mempoolProvider = null;
    }
  } else {
    console.log('   ⚠️ Mempool Pending TX — SKIPPED (set MEMPOOL_WSS_RPC for this detector)');
  }

  // --- 5. Subgraph Polling ---
  console.log('   [5/7] Subgraph (OrderFilledEvent polling)...');
  let subgraphPolling = true;
  const subgraphPollInterval = 500; // 500ms polling

  // --- 6. Data API REST Polling ---
  console.log('   [6/7] Data API REST (/activity polling)...');
  let dataApiPolling = true;
  const dataApiPollInterval = 1000; // 1s polling

  // --- 7. SmartMoney Polling ---
  console.log('   [7/7] SmartMoney Service (standard 5s polling)...');
  const smartMoneySub = sdk.smartMoney.subscribeSmartMoneyTrades(
    (trade) => {
      if (trade.traderAddress.toLowerCase() === walletAddress) {
        detectorManager.markDetected(
          'SmartMoney Polling',
          `side=${trade.side} size=${trade.size}`
        );
      }
    },
    { filterAddresses: [walletAddress] }
  );

  console.log('\n✅ All detectors ready\n');

  // ========================================
  // Run Rounds
  // ========================================

  for (let round = 1; round <= ROUNDS; round++) {
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`  ROUND ${round}/${ROUNDS}`);
    console.log(`${'═'.repeat(60)}\n`);

    // Get current best ask BEFORE starting detectors
    console.log('   📤 Preparing order...');
    let orderPrice = 0.5; // default
    try {
      const book = await sdk.getOrderbook(market.conditionId);
      const askPrice = isDownToken ? book?.no?.ask : book?.yes?.ask;
      if (askPrice && askPrice > 0) {
        orderPrice = askPrice;
      }
    } catch {
      // Use default
    }

    // Place a small BUY order at or slightly above best ask to get filled immediately
    const fillablePrice = Math.min(0.60, orderPrice + 0.02); // cap at 0.60 to control cost
    // Order value must be >= $1 (Polymarket minimum), so ensure size × price >= 1.0
    const minSizeForValue = Math.ceil(1.0 / fillablePrice);
    const orderSize = Math.max(MIN_SHARES, minSizeForValue);
    const estimatedCost = fillablePrice * orderSize;
    console.log(`   Price: ${fillablePrice}, Size: ${orderSize} shares ($${estimatedCost.toFixed(2)})`);

    // Skip round if too expensive (price spiked near market end)
    if (estimatedCost > 3.5) {
      console.log(`   ⚠️ Too expensive ($${estimatedCost.toFixed(2)} > $3.50), skipping round`);
      roundResults.push({
        round,
        orderPlacedAt: Date.now(),
        orderFilledAt: null,
        matchTimeMs: null,
        tokenId: targetTokenId,
        conditionId: market.conditionId,
        detectors: detectorManager.getResults(),
      });
      continue;
    }

    // Reset detectors and matchTime right before order placement
    // t0 = moment we send the order to the CLOB API
    lastMatchTimeMs = null;
    const t0 = Date.now();
    detectorManager.reset(t0);

    // Place order
    const orderResult = await sdk.tradingService.createLimitOrder({
      tokenId: targetTokenId,
      side: 'BUY',
      price: fillablePrice,
      size: orderSize,
      orderType: 'GTC',
    });

    const orderPlacedAt = Date.now();
    console.log(`   Order API returned in ${orderPlacedAt - t0}ms: ${orderResult.success ? '✅' : '❌'} ${orderResult.orderId || orderResult.errorMsg || ''}`);

    // Start Subgraph polling for this round (after order placement)
    const subgraphPollTimer = setInterval(async () => {
      if (!subgraphPolling) return;
      try {
        const fills = await sdk.subgraph.getOrderFilledEvents({
          first: 5,
          orderBy: 'timestamp',
          orderDirection: 'desc',
          where: {
            timestamp_gt: String(Math.floor(t0 / 1000) - 10),
          },
        });
        for (const fill of fills) {
          if (
            fill.maker.toLowerCase() === walletAddress ||
            fill.taker.toLowerCase() === walletAddress
          ) {
            detectorManager.markDetected(
              'Subgraph',
              `maker=${fill.maker.slice(0, 10)} taker=${fill.taker.slice(0, 10)} tx=${fill.transactionHash.slice(0, 10)}`
            );
          }
        }
      } catch {
        // Subgraph may be slow, ignore errors
      }
    }, subgraphPollInterval);

    // Start Data API polling for this round (after order placement)
    const dataApiPollTimer = setInterval(async () => {
      if (!dataApiPolling) return;
      try {
        const activities = await sdk.dataApi.getActivity(walletAddress, {
          type: 'TRADE',
          start: Math.floor(t0 / 1000) - 5,
          limit: 5,
          sortBy: 'TIMESTAMP',
          sortDirection: 'DESC',
        });
        for (const a of activities) {
          if (a.timestamp >= Math.floor(t0 / 1000) - 5) {
            detectorManager.markDetected(
              'Data API REST',
              `side=${a.side} size=${a.size} price=${a.price}`
            );
          }
        }
      } catch {
        // API may rate limit, ignore
      }
    }, dataApiPollInterval);

    if (!orderResult.success) {
      console.log(`   ⚠️ Order failed, skipping round: ${orderResult.errorMsg}`);
      clearInterval(subgraphPollTimer);
      clearInterval(dataApiPollTimer);

      roundResults.push({
        round,
        orderPlacedAt,
        orderFilledAt: null,
        matchTimeMs: null,
        tokenId: targetTokenId,
        conditionId: market.conditionId,
        detectors: detectorManager.getResults(),
      });
      continue;
    }

    // Wait for detectors (max 30s)
    console.log('\n   ⏳ Waiting for detectors...');
    const maxWaitMs = 30000;
    const startWait = Date.now();

    while (!detectorManager.allDetected() && Date.now() - startWait < maxWaitMs) {
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    const waitTime = Date.now() - startWait;
    console.log(`\n   ⏱️ Waited ${waitTime}ms. Detection complete.`);

    // Stop polling for this round
    clearInterval(subgraphPollTimer);
    clearInterval(dataApiPollTimer);

    // Record results — include matchTimeMs from WS User Channel (server-side CLOB match timestamp)
    roundResults.push({
      round,
      orderPlacedAt,
      orderFilledAt: orderPlacedAt, // approximate
      matchTimeMs: lastMatchTimeMs,
      tokenId: targetTokenId,
      conditionId: market.conditionId,
      detectors: detectorManager.getResults(),
    });

    // Print round results
    console.log(`\n   Round ${round} Results:`);
    console.log('   ' + '-'.repeat(70));
    console.log('   Method                    | Latency  | Address | Push/Poll | Status');
    console.log('   ' + '-'.repeat(70));
    for (const d of detectorManager.getResults()) {
      const lat = d.detected && d.latencyMs !== null ? `${d.latencyMs}ms`.padEnd(8) : 'N/A     ';
      const addr = d.hasTraderAddress ? 'YES    ' : 'NO     ';
      const push = d.pushOrPoll === 'push' ? 'Push    ' : 'Poll    ';
      const status = d.detected ? '✅' : '❌ (timeout)';
      console.log(`   ${d.name.padEnd(28)} | ${lat} | ${addr} | ${push}  | ${status}`);
    }

    // Wait between rounds
    if (round < ROUNDS) {
      console.log(`\n   ⏳ Waiting 5s before next round...`);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }

  // ========================================
  // Summary
  // ========================================

  console.log('\n\n');
  console.log('╔══════════════════════════════════════════════════════════════════╗');
  console.log('║                    BENCHMARK SUMMARY                            ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝');
  console.log('');

  const detectorNames = [
    'WS Market Channel',
    'WS User Channel',
    'RPC Contract Events',
    'Mempool Pending TX',
    'Subgraph',
    'Data API REST',
    'SmartMoney Polling',
  ];

  const summary: DetectorSummary[] = detectorNames.map(name => {
    const latencies: number[] = [];
    let detected = 0;
    let total = 0;
    let hasTraderAddress = false;
    let pushOrPoll: 'push' | 'poll' = 'poll';

    for (const round of roundResults) {
      const d = round.detectors.find(d => d.name === name);
      if (d) {
        total++;
        hasTraderAddress = d.hasTraderAddress;
        pushOrPoll = d.pushOrPoll;
        if (d.detected && d.latencyMs !== null) {
          detected++;
          latencies.push(d.latencyMs);
        }
      }
    }

    const sorted = [...latencies].sort((a, b) => a - b);

    return {
      name,
      detected,
      total,
      hasTraderAddress,
      pushOrPoll,
      avgMs: sorted.length > 0 ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null,
      minMs: sorted.length > 0 ? sorted[0] : null,
      maxMs: sorted.length > 0 ? sorted[sorted.length - 1] : null,
      p50Ms: sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : null,
    };
  });

  // Print summary table
  console.log('Method                    | Avg      | Min      | Max      | P50      | Addr | Mode | Detection');
  console.log('-'.repeat(95));
  for (const s of summary) {
    const avg = s.avgMs !== null ? `${s.avgMs.toFixed(0)}ms`.padEnd(8) : 'N/A     ';
    const min = s.minMs !== null ? `${s.minMs.toFixed(0)}ms`.padEnd(8) : 'N/A     ';
    const max = s.maxMs !== null ? `${s.maxMs.toFixed(0)}ms`.padEnd(8) : 'N/A     ';
    const p50 = s.p50Ms !== null ? `${s.p50Ms.toFixed(0)}ms`.padEnd(8) : 'N/A     ';
    const addr = s.hasTraderAddress ? 'YES ' : 'NO  ';
    const mode = s.pushOrPoll === 'push' ? 'Push' : 'Poll';
    const detection = `${s.detected}/${s.total}`;
    console.log(`${s.name.padEnd(25)} | ${avg} | ${min} | ${max} | ${p50} | ${addr} | ${mode} | ${detection}`);
  }

  console.log('');

  // matchTime baseline analysis
  const matchTimeDeltas: number[] = [];
  for (const r of roundResults) {
    if (r.matchTimeMs !== null) {
      const delta = r.matchTimeMs - r.orderPlacedAt;
      matchTimeDeltas.push(delta);
    }
  }
  if (matchTimeDeltas.length > 0) {
    const avgDelta = matchTimeDeltas.reduce((a, b) => a + b, 0) / matchTimeDeltas.length;
    console.log(`⏱️ matchTime Baseline (CLOB server-side match timestamp):`);
    console.log(`   Captured in ${matchTimeDeltas.length}/${roundResults.length} rounds`);
    console.log(`   avg(matchTime - orderPlacedAt) = ${avgDelta.toFixed(0)}ms`);
    console.log(`   This delta represents: client→CLOB→match latency`);
    console.log(`   For true detection latency: latency = Date.now() - matchTime (not - orderPlacedAt)`);
    console.log('');
  } else {
    console.log(`⏱️ matchTime Baseline: NOT CAPTURED (WS User Channel may not provide matchtime field)`);
    console.log('');
  }

  // DataSource architecture recommendation
  const viablePush = summary.filter(s =>
    s.hasTraderAddress && s.pushOrPoll === 'push' && s.detected > 0
  );
  const viablePoll = summary.filter(s =>
    s.hasTraderAddress && s.pushOrPoll === 'poll' && s.detected > 0
  );

  console.log('📋 Architecture Recommendation:');
  if (viablePush.length > 0) {
    const best = viablePush.sort((a, b) => (a.avgMs ?? Infinity) - (b.avgMs ?? Infinity))[0];
    console.log(`   Best push-based (has address): ${best.name} (avg ${best.avgMs?.toFixed(0)}ms)`);
  }
  if (viablePoll.length > 0) {
    const best = viablePoll.sort((a, b) => (a.avgMs ?? Infinity) - (b.avgMs ?? Infinity))[0];
    console.log(`   Best poll-based (has address): ${best.name} (avg ${best.avgMs?.toFixed(0)}ms)`);
  }

  const wsMarket = summary.find(s => s.name === 'WS Market Channel');
  if (wsMarket && wsMarket.avgMs !== null && viablePoll.length > 0) {
    const bestPoll = viablePoll.sort((a, b) => (a.avgMs ?? Infinity) - (b.avgMs ?? Infinity))[0];
    const hybridLatency = wsMarket.avgMs + (bestPoll.avgMs ?? 0);
    console.log(`   Hybrid (WS trigger + ${bestPoll.name}): ~${hybridLatency.toFixed(0)}ms estimated`);
  }

  // Save results
  const benchmarkResult: BenchmarkResult = {
    timestamp: new Date().toISOString(),
    rounds: ROUNDS,
    market: market.name,
    conditionId: market.conditionId,
    orderAmount: ORDER_AMOUNT_USDC,
    results: roundResults,
    summary,
  };

  const resultsDir = path.join(import.meta.dirname || '.', 'results');
  fs.mkdirSync(resultsDir, { recursive: true });

  const filename = `copy-trade-latency-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  const filepath = path.join(resultsDir, filename);
  fs.writeFileSync(filepath, JSON.stringify(benchmarkResult, null, 2));
  console.log(`\n📄 Results saved to: ${filepath}`);

  // Cleanup
  console.log('\n🧹 Cleaning up...');
  marketSub.unsubscribe();
  smartMoneySub.unsubscribe();
  subgraphPolling = false;
  dataApiPolling = false;

  if (rpcProvider) {
    await rpcProvider.destroy();
  }
  if (mempoolProvider) {
    await mempoolProvider.destroy();
  }

  sdk.stop();
  console.log('✅ Done');

  // Force exit after 3s (WebSocket cleanup can hang)
  setTimeout(() => process.exit(0), 3000);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
