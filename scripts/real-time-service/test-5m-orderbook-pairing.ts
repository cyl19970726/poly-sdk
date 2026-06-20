#!/usr/bin/env npx tsx
/**
 * 观察 5m 市场 WebSocket orderbook 推送模式
 *
 * 目的: 验证 YES/NO orderbook 是否成对到达，记录时间间隔和价格互补性。
 * 用于 ST-3 数据恢复方案验证。
 *
 * Usage:
 *   npx tsx scripts/real-time-service/test-5m-orderbook-pairing.ts
 */

import { RealtimeServiceV2 } from '../../src/services/realtime-service-v2.js';
import { MarketService } from '../../src/services/market-service.js';
import { GammaApiClient } from '../../src/clients/gamma-api.js';
import { RateLimiter } from '../../src/core/rate-limiter.js';
import { createUnifiedCache } from '../../src/core/unified-cache.js';
import type { OrderbookSnapshot } from '../../src/services/realtime-service-v2.js';

const DURATION_MS = 20_000; // 20 seconds

function log(msg: string) {
  const ts = new Date().toISOString().split('T')[1].replace('Z', '');
  console.log(`[${ts}] ${msg}`);
}

async function findActive5mMarket() {
  log('Scanning for active BTC 5m markets...');
  const rateLimiter = new RateLimiter();
  const cache = createUnifiedCache();
  const gammaApi = new GammaApiClient(rateLimiter, cache);
  const marketService = new MarketService(gammaApi, undefined, rateLimiter, cache);

  const markets = await marketService.scanCryptoShortTermMarkets({
    duration: '5m',
    minMinutesUntilEnd: 1,
    maxMinutesUntilEnd: 6,
    coin: 'BTC',
    limit: 3,
  });

  if (markets.length === 0) throw new Error('No active BTC 5m markets found');

  const market = markets[0];
  const clobMarket = await marketService.getClobMarket(market.conditionId);
  if (!clobMarket || clobMarket.tokens.length < 2) throw new Error('Failed to get tokens');

  return {
    conditionId: market.conditionId,
    question: market.question,
    yesTokenId: clobMarket.tokens[0].tokenId,
    noTokenId: clobMarket.tokens[1].tokenId,
  };
}

async function main() {
  console.log('='.repeat(60));
  console.log('5m Orderbook Pairing Observation');
  console.log('='.repeat(60));

  const market = await findActive5mMarket();
  log(`Market: ${market.question}`);
  log(`YES token: ${market.yesTokenId.slice(0, 20)}...`);
  log(`NO token:  ${market.noTokenId.slice(0, 20)}...`);

  const realtime = new RealtimeServiceV2({ debug: false });

  // Track orderbook events for pairing analysis
  interface BookEvent {
    time: number;
    tokenId: string;
    side: 'YES' | 'NO';
    bestBid: number;
    bestAsk: number;
    bidsCount: number;
    asksCount: number;
  }

  const events: BookEvent[] = [];

  realtime.on('orderbook', (book: OrderbookSnapshot) => {
    const isYes = book.tokenId === market.yesTokenId;
    const side = isYes ? 'YES' : 'NO';
    const bestBid = book.bids[0]?.price ?? 0;
    const bestAsk = book.asks[0]?.price ?? 0;
    const now = Date.now();

    events.push({
      time: now,
      tokenId: book.tokenId,
      side,
      bestBid: typeof bestBid === 'string' ? parseFloat(bestBid) : bestBid,
      bestAsk: typeof bestAsk === 'string' ? parseFloat(bestAsk) : bestAsk,
      bidsCount: book.bids.length,
      asksCount: book.asks.length,
    });

    // Show live
    const lastEvent = events.length >= 2 ? events[events.length - 2] : null;
    let pairInfo = '';
    if (lastEvent && lastEvent.side !== side) {
      const gap = now - lastEvent.time;
      const sum = (typeof bestBid === 'number' ? bestBid : parseFloat(String(bestBid)))
                + lastEvent.bestBid;
      pairInfo = ` ← PAIR (gap=${gap}ms, bidSum=${sum.toFixed(3)})`;
    }

    log(`${side.padEnd(3)} | bid=${String(bestBid).padEnd(5)} ask=${String(bestAsk).padEnd(5)} | depths: ${book.bids.length}/${book.asks.length}${pairInfo}`);
  });

  // Connect
  realtime.connect();
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Connection timeout')), 10_000);
    realtime.once('connected', () => { clearTimeout(timeout); resolve(); });
  });

  log('Subscribing...');
  const sub = realtime.subscribeMarkets([market.yesTokenId, market.noTokenId]);

  // Wait
  await new Promise(resolve => setTimeout(resolve, DURATION_MS));

  sub.unsubscribe();
  realtime.disconnect();

  // Pairing analysis
  console.log('\n' + '='.repeat(60));
  console.log('PAIRING ANALYSIS');
  console.log('='.repeat(60));

  let pairs = 0;
  let totalGap = 0;
  const gaps: number[] = [];

  for (let i = 1; i < events.length; i++) {
    if (events[i].side !== events[i - 1].side) {
      const gap = events[i].time - events[i - 1].time;
      const sum = events[i].bestBid + events[i - 1].bestBid;
      if (gap < 100 && sum > 0.90 && sum < 1.10) {
        pairs++;
        totalGap += gap;
        gaps.push(gap);
      }
    }
  }

  const yesCount = events.filter(e => e.side === 'YES').length;
  const noCount = events.filter(e => e.side === 'NO').length;

  console.log(`Total events:     ${events.length}`);
  console.log(`YES events:       ${yesCount}`);
  console.log(`NO events:        ${noCount}`);
  console.log(`Detected pairs:   ${pairs}`);
  console.log(`Pair rate:        ${(pairs / Math.max(1, Math.min(yesCount, noCount)) * 100).toFixed(1)}%`);
  if (gaps.length > 0) {
    gaps.sort((a, b) => a - b);
    console.log(`Gap median:       ${gaps[Math.floor(gaps.length / 2)]}ms`);
    console.log(`Gap max:          ${gaps[gaps.length - 1]}ms`);
    console.log(`Gap avg:          ${(totalGap / gaps.length).toFixed(1)}ms`);
  }

  // Show first 10 events for manual inspection
  console.log('\n--- First 10 events ---');
  for (const e of events.slice(0, 10)) {
    const ts = new Date(e.time).toISOString().split('T')[1].replace('Z', '');
    console.log(`  ${ts} | ${e.side.padEnd(3)} | bid=${e.bestBid.toFixed(2)} ask=${e.bestAsk.toFixed(2)} | depths=${e.bidsCount}/${e.asksCount}`);
  }
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
