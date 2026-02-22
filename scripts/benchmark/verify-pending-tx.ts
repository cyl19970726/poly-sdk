#!/usr/bin/env npx tsx
/**
 * Phase 0.5c v2: Verify Pending TX detection latency
 *
 * FIXED: Use raw WebSocket with `newPendingTransactions: true` to get
 * full TX objects directly via WSS push. NO getTransaction() RPC calls.
 *
 * Previous version used ethers.js `provider.on('pending')` which only
 * returns TX hashes, requiring a separate getTransaction() call for each
 * of ~3000 pending TXs per round — creating massive RPC backlog that
 * inflated measured latency from ~2-5s to ~10s+.
 *
 * Method:
 *   1. Connect raw WSS with `newPendingTransactions: true` (full TX objects)
 *   2. Connect CLOB WS user channel
 *   3. Place a fillable order on a crypto market
 *   4. Race: WS MATCHED event vs Mempool pending TX detection
 *   5. Report both latencies using match_time as ground truth
 *
 * Usage:
 *   cd poly-sdk && npx tsx scripts/benchmark/verify-pending-tx.ts
 *   cd poly-sdk && npx tsx scripts/benchmark/verify-pending-tx.ts --rounds=5
 */

import * as fs from 'fs';
import * as path from 'path';
import { ethers } from 'ethers';
import WebSocket from 'ws';

// Load .env
const envPath = path.resolve(import.meta.dirname || '.', '../../.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

import { PolymarketSDK } from '../../src/index.js';
import type { UserTrade } from '../../src/services/realtime-service-v2.js';
import {
  ROUTER_ADDRESSES,
  MATCH_ORDERS_SELECTOR,
  decodeMatchOrdersCalldata,
  extractTraderAddresses,
} from '../../src/utils/calldata-decoder.js';

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const MEMPOOL_WSS_RPC = process.env.MEMPOOL_WSS_RPC;
if (!PRIVATE_KEY) { console.error('PRIVATE_KEY required'); process.exit(1); }
if (!MEMPOOL_WSS_RPC) { console.error('MEMPOOL_WSS_RPC required'); process.exit(1); }

const ROUNDS = parseInt(process.argv.find(a => a.startsWith('--rounds='))?.split('=')[1] || '3');
const walletAddress = new ethers.Wallet(PRIVATE_KEY).address.toLowerCase();

interface RoundData {
  round: number;
  orderPlacedAt: number;
  wsMatchedAt: number | null;
  wsMatchTime: number | null;
  mempoolDetectedAt: number | null;
  mempoolTxHash: string | null;
  mempoolDetails: string | null;
  // Derived
  wsLatencyFromMatch: number | null;       // wsMatchedAt - wsMatchTime
  mempoolLatencyFromMatch: number | null;  // mempoolDetectedAt - wsMatchTime
  mempoolLatencyFromOrder: number | null;  // mempoolDetectedAt - orderPlacedAt
}

// ============================================================
// Raw WebSocket mempool subscriber
// ============================================================

interface MempoolSubscriber {
  ws: WebSocket;
  onSettlementTx: ((t0: number, txHash: string, txTo: string, txData: string) => void) | null;
  pendingTxCount: number;
  settlementTxCount: number;
  close: () => void;
}

function createMempoolSubscriber(wssUrl: string): Promise<MempoolSubscriber> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wssUrl);
    const sub: MempoolSubscriber = {
      ws,
      onSettlementTx: null,
      pendingTxCount: 0,
      settlementTxCount: 0,
      close: () => { ws.close(); },
    };

    ws.on('error', (err) => {
      console.log(`   ⚠️ Mempool WSS error: ${err.message}`);
    });

    ws.on('open', () => {
      // Subscribe with `true` to get FULL TX objects, not just hashes
      ws.send(JSON.stringify({
        id: 1,
        jsonrpc: '2.0',
        method: 'eth_subscribe',
        params: ['newPendingTransactions', true],
      }));
    });

    let subscribed = false;

    ws.on('message', (raw) => {
      const t0 = Date.now(); // Record timestamp IMMEDIATELY on message arrival

      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      // Handle subscription confirmation
      if (msg.id === 1 && msg.result) {
        subscribed = true;
        resolve(sub);
        return;
      }

      // Handle subscription data (pending TX)
      if (msg.method === 'eth_subscription' && msg.params?.result) {
        const tx = msg.params.result;
        sub.pendingTxCount++;

        // Local filter: only Router contracts
        const txTo = (tx.to || '').toLowerCase();
        if (!ROUTER_ADDRESSES.has(txTo)) return;

        // Local filter: only matchOrders selector
        const txInput = tx.input || tx.data || '';
        if (!txInput.startsWith(MATCH_ORDERS_SELECTOR)) return;

        sub.settlementTxCount++;
        const txHash = tx.hash || 'unknown';

        // Callback with the timestamp recorded when WSS message arrived
        if (sub.onSettlementTx) {
          sub.onSettlementTx(t0, txHash, txTo, txInput);
        }
      }
    });

    // Timeout for subscription
    setTimeout(() => {
      if (!subscribed) {
        reject(new Error('Mempool WSS subscription timeout (5s)'));
        ws.close();
      }
    }, 5000);
  });
}

// ============================================================
// Main
// ============================================================

async function main() {
  console.log(`\n=== Phase 0.5c v2: Pending TX Detection (Raw WSS, ${ROUNDS} rounds) ===\n`);
  console.log(`Wallet: ${walletAddress}`);
  console.log(`Mempool WSS: ${MEMPOOL_WSS_RPC!.replace(/\/[^/]+$/, '/***')}`);
  console.log(`Method: eth_subscribe("newPendingTransactions", true) — full TX objects, 0 RPC calls`);

  const sdk = new PolymarketSDK({ privateKey: PRIVATE_KEY! });
  const results: RoundData[] = [];

  // 1. Connect mempool WSS with full TX subscription
  console.log('\n1. Connecting mempool WSS (full TX mode)...');
  const mempool = await createMempoolSubscriber(MEMPOOL_WSS_RPC!);
  console.log('   ✅ Mempool WSS connected + subscribed');

  // 2. Connect WS + auth
  console.log('\n2. Connecting CLOB WS...');
  const realtimeService = sdk.realtime;
  await realtimeService.connect();
  await sdk.tradingService.initialize();
  const creds = sdk.tradingService.getCredentials();
  if (!creds) { console.error('No credentials'); process.exit(1); }
  console.log('   ✅ CLOB WS connected');

  // 3. Sync CLOB balance
  console.log('\n3. Syncing CLOB balance...');
  try {
    await sdk.tradingService.updateBalanceAllowance();
    console.log('   ✅ Balance synced');
  } catch (err: any) {
    console.log(`   ⚠️ Balance sync failed: ${err.message}`);
  }

  // Pre-flight: sell any existing position to recover USDC
  console.log('\n4. Pre-flight: checking for existing positions to sell...');
  for (const coin of ['BTC', 'ETH', 'SOL', 'XRP'] as const) {
    try {
      const markets = await sdk.markets.scanCryptoShortTermMarkets({
        coin, duration: '15m', minMinutesUntilEnd: 1, maxMinutesUntilEnd: 16, limit: 3,
      });
      for (const m of markets) {
        const resolved = await sdk.markets.resolveMarketTokens(m.conditionId);
        if (!resolved) continue;
        // Try to sell primary token (Up/Yes)
        const ob = await sdk.markets.getOrderbook(m.conditionId);
        const bestBid = ob.yes.bid;
        if (bestBid && bestBid > 0.05) {
          const sellPrice = Math.round(Math.max(0.01, bestBid - 0.03) * 100) / 100;
          try {
            const sellResult = await sdk.tradingService.createLimitOrder({
              tokenId: resolved.primaryTokenId,
              side: 'SELL',
              price: sellPrice,
              size: 5,
              orderType: 'FOK',
            });
            if (sellResult.success) {
              console.log(`   ✅ Sold 5 shares of ${coin} at ${sellPrice} (bid was ${bestBid})`);
              await new Promise(r => setTimeout(r, 2000));
            }
          } catch {}
        }
      }
    } catch {}
  }
  try { await sdk.tradingService.updateBalanceAllowance(); } catch {}
  console.log('   Pre-flight done\n');

  // Run rounds
  for (let round = 1; round <= ROUNDS; round++) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`  ROUND ${round}/${ROUNDS}`);
    console.log(`${'='.repeat(60)}`);

    // Find active market
    console.log('\n   Finding active market...');
    let market = null;
    for (const coin of ['BTC', 'ETH', 'SOL', 'XRP'] as const) {
      const markets = await sdk.markets.scanCryptoShortTermMarkets({
        coin,
        duration: '15m',
        minMinutesUntilEnd: 1,
        maxMinutesUntilEnd: 16,
        limit: 1,
      });
      if (markets.length > 0) {
        market = markets[0];
        break;
      }
    }
    if (!market) {
      console.log('   ⚠️ No active market, waiting 30s...');
      await new Promise(r => setTimeout(r, 30000));
      for (const coin of ['BTC', 'ETH', 'SOL', 'XRP'] as const) {
        const markets = await sdk.markets.scanCryptoShortTermMarkets({
          coin, duration: '15m', minMinutesUntilEnd: 1, maxMinutesUntilEnd: 16, limit: 1,
        });
        if (markets.length > 0) { market = markets[0]; break; }
      }
      if (!market) { console.log('   ❌ Still no market, skipping round'); continue; }
    }
    console.log(`   Market: ${market.question}`);

    // Resolve token + orderbook
    const resolved = await sdk.markets.resolveMarketTokens(market.conditionId);
    if (!resolved) { console.log('   ❌ Failed to resolve'); continue; }
    const tokenId = resolved.primaryTokenId;
    const orderbook = await sdk.markets.getOrderbook(market.conditionId);
    const bestAsk = orderbook.yes.ask;
    if (!bestAsk || bestAsk <= 0) { console.log('   ❌ No asks'); continue; }

    const fillablePrice = Math.round(Math.min(0.60, bestAsk + 0.02) * 100) / 100;
    const minSize = Math.ceil(1.0 / fillablePrice);
    const orderSize = Math.max(5, minSize);
    console.log(`   Ask: ${bestAsk}, fill price: ${fillablePrice}, size: ${orderSize}`);

    // Setup round state
    const roundData: RoundData = {
      round,
      orderPlacedAt: 0,
      wsMatchedAt: null,
      wsMatchTime: null,
      mempoolDetectedAt: null,
      mempoolTxHash: null,
      mempoolDetails: null,
      wsLatencyFromMatch: null,
      mempoolLatencyFromMatch: null,
      mempoolLatencyFromOrder: null,
    };

    // WS trade listener
    let wsResolve: (() => void) | null = null;
    const wsPromise = new Promise<void>(r => { wsResolve = r; });
    let gotMatched = false;

    const sub = realtimeService.subscribeUserEvents(
      { apiKey: creds.key, secret: creds.secret, passphrase: creds.passphrase },
      {
        onTrade: (trade: UserTrade) => {
          if (trade.status === 'MATCHED' && !gotMatched) {
            gotMatched = true;
            roundData.wsMatchedAt = Date.now();
            roundData.wsMatchTime = trade.matchTime ?? null;
            console.log(`   [WS MATCHED] at ${roundData.wsMatchedAt}, matchTime=${trade.matchTime}`);
            wsResolve?.();
          }
        },
        onOrder: () => {},
      }
    );

    // Mempool listener for this round
    let mempoolResolve: (() => void) | null = null;
    const mempoolPromise = new Promise<void>(r => { mempoolResolve = r; });
    let gotMempool = false;
    mempool.pendingTxCount = 0;
    mempool.settlementTxCount = 0;

    // Round-scoped flag to prevent cross-round leaking
    const roundId = round;
    mempool.onSettlementTx = (t0: number, txHash: string, _txTo: string, txInput: string) => {
      if (gotMempool || roundId !== round) return;

      // Decode calldata to check if our wallet is involved
      const decoded = decodeMatchOrdersCalldata(txInput);
      if (decoded) {
        const addresses = extractTraderAddresses(decoded);
        const hasWallet = addresses.includes(walletAddress);
        if (hasWallet) {
          gotMempool = true;
          roundData.mempoolDetectedAt = t0; // Use timestamp from WSS message arrival, not now
          roundData.mempoolTxHash = txHash;
          roundData.mempoolDetails = `taker=${decoded.takerOrder.maker.slice(0, 10)} makers=${decoded.makerOrders.length}`;
          console.log(`   [MEMPOOL] at ${t0} (recorded on WSS arrival), tx=${txHash.slice(0, 16)}... (${roundData.mempoolDetails})`);
          mempoolResolve?.();
        }
      } else if (txInput.toLowerCase().includes(walletAddress.slice(2).toLowerCase())) {
        // Fallback: raw string match
        gotMempool = true;
        roundData.mempoolDetectedAt = t0;
        roundData.mempoolTxHash = txHash;
        roundData.mempoolDetails = 'raw match in calldata';
        console.log(`   [MEMPOOL] at ${t0} (recorded on WSS arrival), tx=${txHash.slice(0, 16)}... (raw match)`);
        mempoolResolve?.();
      }
    };

    await new Promise(r => setTimeout(r, 1000));

    // Place order
    console.log(`   Placing order...`);
    roundData.orderPlacedAt = Date.now();
    const result = await sdk.tradingService.createLimitOrder({
      tokenId,
      side: 'BUY',
      price: fillablePrice,
      size: orderSize,
      orderType: 'GTC',
    });
    const orderApiMs = Date.now() - roundData.orderPlacedAt;
    console.log(`   Order: success=${result.success}, latency=${orderApiMs}ms`);

    if (!result.success) {
      console.log(`   ❌ Order failed: ${result.errorMsg}`);
      sub.unsubscribe();
      mempool.onSettlementTx = null;
      continue;
    }

    // Wait for both (with timeout)
    console.log(`   Waiting for WS MATCHED + Mempool detection (30s timeout)...`);
    const timeout = new Promise<void>(r => setTimeout(r, 30000));
    await Promise.race([
      Promise.all([wsPromise, mempoolPromise]),
      timeout,
    ]);

    // Extra wait if one is missing
    if (!gotMatched || !gotMempool) {
      await new Promise(r => setTimeout(r, 5000));
    }

    // Compute derived latencies
    if (roundData.wsMatchedAt && roundData.wsMatchTime) {
      roundData.wsLatencyFromMatch = roundData.wsMatchedAt - roundData.wsMatchTime;
    }
    if (roundData.mempoolDetectedAt && roundData.wsMatchTime) {
      roundData.mempoolLatencyFromMatch = roundData.mempoolDetectedAt - roundData.wsMatchTime;
    }
    if (roundData.mempoolDetectedAt) {
      roundData.mempoolLatencyFromOrder = roundData.mempoolDetectedAt - roundData.orderPlacedAt;
    }

    results.push(roundData);

    // Print round summary
    console.log(`\n   --- Round ${round} Summary ---`);
    console.log(`   WS MATCHED:  ${roundData.wsMatchedAt ? `${roundData.wsLatencyFromMatch}ms (from match_time)` : 'NOT DETECTED'}`);
    console.log(`   Mempool:     ${roundData.mempoolDetectedAt ? `${roundData.mempoolLatencyFromMatch}ms (from match_time), ${roundData.mempoolLatencyFromOrder}ms (from order)` : 'NOT DETECTED'}`);
    console.log(`   Pending TXs seen: ${mempool.pendingTxCount}, Settlement TXs: ${mempool.settlementTxCount}`);

    // Cleanup round
    sub.unsubscribe();
    mempool.onSettlementTx = null;

    // Sell position to recover USDC for next round
    if (round < ROUNDS) {
      console.log('\n   Selling position to recover USDC...');
      try {
        // Re-check orderbook for best bid
        const ob = await sdk.markets.getOrderbook(market.conditionId);
        const bestBid = ob.yes.bid;
        if (bestBid && bestBid > 0) {
          const sellPrice = Math.round(Math.max(0.01, bestBid - 0.02) * 100) / 100;
          const sellResult = await sdk.tradingService.createLimitOrder({
            tokenId,
            side: 'SELL',
            price: sellPrice,
            size: orderSize,
            orderType: 'FOK',
          });
          console.log(`   Sell: success=${sellResult.success}, price=${sellPrice}`);
        } else {
          console.log(`   ⚠️ No bids to sell into`);
        }
        // Wait for settlement + balance update
        await new Promise(r => setTimeout(r, 3000));
        try { await sdk.tradingService.updateBalanceAllowance(); } catch {}
      } catch (err: any) {
        console.log(`   ⚠️ Sell failed: ${err.message}`);
      }
      console.log('   Waiting 5s before next round...');
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  // Final summary
  console.log(`\n\n${'='.repeat(60)}`);
  console.log(`  FINAL RESULTS (${results.length} rounds)`);
  console.log(`${'='.repeat(60)}\n`);

  console.log('| Round | WS MATCHED (from match_time) | Mempool (from match_time) | Mempool (from order) | Mempool Detected |');
  console.log('|-------|------------------------------|---------------------------|----------------------|------------------|');
  for (const r of results) {
    const ws = r.wsLatencyFromMatch != null ? `${r.wsLatencyFromMatch}ms` : 'N/A';
    const mp = r.mempoolLatencyFromMatch != null ? `${r.mempoolLatencyFromMatch}ms` : 'N/A';
    const mpOrd = r.mempoolLatencyFromOrder != null ? `${r.mempoolLatencyFromOrder}ms` : 'N/A';
    const det = r.mempoolDetectedAt != null ? '✅' : '❌';
    console.log(`| ${r.round}     | ${ws.padEnd(28)} | ${mp.padEnd(25)} | ${mpOrd.padEnd(20)} | ${det.padEnd(16)} |`);
  }

  // Averages
  const wsDeltas = results.filter(r => r.wsLatencyFromMatch != null).map(r => r.wsLatencyFromMatch!);
  const mpDeltas = results.filter(r => r.mempoolLatencyFromMatch != null).map(r => r.mempoolLatencyFromMatch!);
  const mpDetected = results.filter(r => r.mempoolDetectedAt != null).length;

  console.log('\n--- Averages ---');
  if (wsDeltas.length > 0) {
    console.log(`WS MATCHED:  avg=${Math.round(wsDeltas.reduce((a, b) => a + b, 0) / wsDeltas.length)}ms, min=${Math.min(...wsDeltas)}ms, max=${Math.max(...wsDeltas)}ms`);
  }
  if (mpDeltas.length > 0) {
    console.log(`Mempool:     avg=${Math.round(mpDeltas.reduce((a, b) => a + b, 0) / mpDeltas.length)}ms, min=${Math.min(...mpDeltas)}ms, max=${Math.max(...mpDeltas)}ms`);
  }
  console.log(`Mempool detection rate: ${mpDetected}/${results.length} (${Math.round(mpDetected / results.length * 100)}%)`);

  // Winner analysis
  let wsWins = 0, mpWins = 0, ties = 0;
  for (const r of results) {
    if (r.wsLatencyFromMatch != null && r.mempoolLatencyFromMatch != null) {
      if (r.wsLatencyFromMatch < r.mempoolLatencyFromMatch) wsWins++;
      else if (r.mempoolLatencyFromMatch < r.wsLatencyFromMatch) mpWins++;
      else ties++;
    }
  }
  console.log(`\nWinner: WS=${wsWins}, Mempool=${mpWins}, Tie=${ties}`);

  // Cleanup
  realtimeService.disconnect();
  mempool.close();
  process.exit(0);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
