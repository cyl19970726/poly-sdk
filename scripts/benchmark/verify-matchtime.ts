#!/usr/bin/env npx tsx
/**
 * Phase 0.5b: Verify matchtime field in WS USER_TRADE payload
 *
 * Minimal script to answer ONE question:
 *   Does Polymarket WS include `matchtime` in USER_TRADE events, and in what format?
 *
 * Method:
 *   1. Connect WS user channel
 *   2. Place a fillable order on a crypto market
 *   3. Log COMPLETE raw payload for each trade status (MATCHED/MINED/CONFIRMED)
 *   4. Report matchtime presence, format, and value
 *
 * Usage:
 *   cd poly-sdk && npx tsx scripts/benchmark/verify-matchtime.ts
 */

import * as fs from 'fs';
import * as path from 'path';

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

const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) {
  console.error('PRIVATE_KEY required');
  process.exit(1);
}

async function main() {
  console.log('\n=== Phase 0.5b: Verify matchtime in WS USER_TRADE ===\n');

  const sdk = new PolymarketSDK({ privateKey: PRIVATE_KEY! });

  // 1. Find a fillable crypto market
  console.log('1. Finding active crypto market...');
  let market = null;
  for (const coin of ['BTC', 'ETH', 'SOL'] as const) {
    const markets = await sdk.markets.scanCryptoShortTermMarkets({
      coin,
      duration: '15m',
      minMinutesUntilEnd: 5,
      maxMinutesUntilEnd: 14,
      limit: 1,
    });
    if (markets.length > 0) {
      market = markets[0];
      console.log(`   Found: ${market.question}`);
      break;
    }
  }
  if (!market) {
    console.error('   No active crypto market found. Try again later.');
    process.exit(1);
  }

  // 2. Resolve token IDs + get orderbook for fillable price
  console.log('\n2. Resolving market...');
  const resolved = await sdk.markets.resolveMarketTokens(market.conditionId);
  if (!resolved) {
    console.error('   Failed to resolve market');
    process.exit(1);
  }
  const tokenId = resolved.primaryTokenId;
  const orderbook = await sdk.markets.getOrderbook(market.conditionId);
  const bestAsk = orderbook.yes.ask;
  if (!bestAsk || bestAsk <= 0) {
    console.error('   No asks in orderbook');
    process.exit(1);
  }
  // Round to tick size 0.01
  const fillablePrice = Math.round(Math.min(0.60, bestAsk + 0.02) * 100) / 100;
  const minSize = Math.ceil(1.0 / fillablePrice);
  const orderSize = Math.max(5, minSize);
  console.log(`   Token: ${tokenId.slice(0, 20)}...`);
  console.log(`   Best ask: ${bestAsk}, fill price: ${fillablePrice}, size: ${orderSize}`);

  // 3. Connect WS + subscribe user events
  console.log('\n3. Connecting WS...');
  const realtimeService = sdk.realtime;

  // Intercept raw payload by monkey-patching handleUserMessage
  const rawPayloads: Array<{ type: string; payload: Record<string, unknown>; receivedAt: number }> = [];
  const origHandler = (realtimeService as any).handleUserMessage.bind(realtimeService);
  (realtimeService as any).handleUserMessage = (type: string, payload: Record<string, unknown>, timestamp: number) => {
    if (type === 'trade') {
      rawPayloads.push({ type, payload: { ...payload }, receivedAt: Date.now() });
      console.log(`\n   >>> RAW WS TRADE PAYLOAD (all keys):`);
      console.log(`   ${JSON.stringify(payload, null, 2)}`);
    }
    return origHandler(type, payload, timestamp);
  };

  await realtimeService.connect();
  console.log('   WS connected');

  await sdk.tradingService.initialize();
  const creds = sdk.tradingService.getCredentials();
  if (!creds) {
    console.error('   No credentials');
    process.exit(1);
  }

  const tradeEvents: UserTrade[] = [];

  const sub = realtimeService.subscribeUserEvents(
    { apiKey: creds.key, secret: creds.secret, passphrase: creds.passphrase },
    {
      onTrade: (trade: UserTrade) => {
        const now = Date.now();
        tradeEvents.push(trade);
        console.log(`\n   === USER_TRADE #${tradeEvents.length} (status=${trade.status}) ===`);
        console.log(`   SDK parsed fields:`);
        console.log(`     matchTime: ${trade.matchTime} (type: ${typeof trade.matchTime})`);
        console.log(`     timestamp: ${trade.timestamp}`);
        console.log(`     status:    ${trade.status}`);
        console.log(`     price:     ${trade.price}`);
        console.log(`     size:      ${trade.size}`);
        console.log(`     receivedAt: ${now} (Date.now())`);
        if (trade.matchTime) {
          const delta = now - trade.matchTime;
          console.log(`     delta(now - matchTime): ${delta}ms`);
        }
      },
      onOrder: () => {}, // ignore
    }
  );

  await new Promise(r => setTimeout(r, 2000));
  console.log('   WS ready');

  // 4. Place fillable order
  console.log(`\n4. Placing fillable order (price=${fillablePrice}, size=${orderSize})...`);
  const t0 = Date.now();
  const result = await sdk.tradingService.createLimitOrder({
    tokenId,
    side: 'BUY',
    price: fillablePrice,
    size: orderSize,
    orderType: 'GTC',
  });
  const t1 = Date.now();
  console.log(`   Order result: success=${result.success}, orderId=${result.orderId?.slice(0, 20)}...`);
  console.log(`   Order API latency: ${t1 - t0}ms`);

  if (!result.success) {
    console.error(`   Order failed: ${result.errorMsg}`);
    process.exit(1);
  }

  // 5. Wait for trade events (MATCHED → MINED → CONFIRMED, up to 60s)
  console.log('\n5. Waiting for trade events (up to 60s)...');
  const maxWait = 60000;
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    await new Promise(r => setTimeout(r, 500));
    // Check if we've seen CONFIRMED
    if (tradeEvents.some(t => t.status === 'CONFIRMED')) {
      console.log('   Got CONFIRMED status, done waiting.');
      break;
    }
  }

  // 6. Summary
  console.log('\n\n=== MATCHTIME VERIFICATION RESULT ===\n');
  console.log(`Total USER_TRADE events received: ${tradeEvents.length}`);
  console.log(`Raw payloads intercepted: ${rawPayloads.length}`);

  for (const t of tradeEvents) {
    console.log(`\n  Status: ${t.status}`);
    console.log(`    matchTime (SDK):  ${t.matchTime ?? 'undefined'} (${typeof t.matchTime})`);
    console.log(`    timestamp (SDK):  ${t.timestamp}`);
  }

  // Check raw payloads for matchtime
  console.log('\n--- Raw payload matchtime field ---');
  for (const rp of rawPayloads) {
    const mt = rp.payload.matchtime ?? rp.payload.match_time ?? (rp.payload as any).matchTime;
    console.log(`  Status: ${rp.payload.status}`);
    console.log(`    matchtime:   ${rp.payload.matchtime} (type: ${typeof rp.payload.matchtime})`);
    console.log(`    match_time:  ${rp.payload.match_time} (type: ${typeof rp.payload.match_time})`);
    console.log(`    timestamp:   ${rp.payload.timestamp} (type: ${typeof rp.payload.timestamp})`);
    console.log(`    last_update: ${rp.payload.last_update} (type: ${typeof rp.payload.last_update})`);
    console.log(`    ALL KEYS:    ${Object.keys(rp.payload).join(', ')}`);
    if (mt) {
      const mtMs = Number(mt) < 1e12 ? Number(mt) * 1000 : Number(mt);
      console.log(`    -> matchtime normalized: ${mtMs}ms = ${new Date(mtMs).toISOString()}`);
      console.log(`    -> delta(receivedAt - matchtime): ${rp.receivedAt - mtMs}ms`);
    }
  }

  const hasMatchtime = rawPayloads.some(rp => rp.payload.matchtime != null);
  const hasMatchTime2 = rawPayloads.some(rp => rp.payload.match_time != null);
  console.log(`\n=== VERDICT ===`);
  console.log(`  matchtime field present:  ${hasMatchtime ? 'YES' : 'NO'}`);
  console.log(`  match_time field present: ${hasMatchTime2 ? 'YES' : 'NO'}`);

  if (hasMatchtime || hasMatchTime2) {
    console.log(`  matchtime is available for accurate latency measurement`);
  } else {
    console.log(`  matchtime NOT found in WS payload -- need alternative approach`);
    console.log(`  Raw payload keys seen:`);
    for (const rp of rawPayloads) {
      console.log(`    [${rp.payload.status}]: ${Object.keys(rp.payload).join(', ')}`);
    }
  }

  // Cleanup
  sub.unsubscribe();
  realtimeService.disconnect();
  process.exit(0);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
