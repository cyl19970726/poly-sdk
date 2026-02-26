/**
 * Reference Price Analysis:
 * 1. Check Polymarket market description for settlement rules
 * 2. Compare Chainlink vs Binance prices at market open time across multiple markets
 * 3. Measure timing accuracy and price differences
 */

import { ethers } from 'ethers';

// ── Chainlink Config ──
const CHAINLINK_BTC_USD = '0xc907E116054Ad103354f2D350FD2514433D57F6f';
const ABI = [
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function getRoundData(uint80 _roundId) view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function decimals() view returns (uint8)',
];

// ── Gamma API ──
const GAMMA_API = 'https://gamma-api.polymarket.com';

async function fetchMarketDescription(): Promise<void> {
  console.log('═══ Part 1: Polymarket Market Description (Settlement Rules) ═══\n');

  // Search for an active BTC 15m market
  const resp = await fetch(`${GAMMA_API}/markets?tag=crypto&limit=5&active=true&closed=false`);
  const markets: any[] = await resp.json();

  const btc15m = markets.filter((m: any) =>
    (m.slug || '').includes('btc') && (m.slug || '').includes('15m')
  );

  if (btc15m.length === 0) {
    // Try searching with different query
    const resp2 = await fetch(`${GAMMA_API}/markets?slug_contains=btc-updown-15m&limit=5`);
    const markets2: any[] = await resp2.json();
    btc15m.push(...markets2);
  }

  if (btc15m.length > 0) {
    const m = btc15m[0];
    console.log(`Market: ${m.question}`);
    console.log(`Slug: ${m.slug}`);
    console.log(`EndDate: ${m.endDate || m.endDateIso}`);
    console.log(`\nFull Description:\n${m.description}\n`);
  } else {
    console.log('No active BTC 15m market found. Trying closed markets...');
    const resp3 = await fetch(`${GAMMA_API}/markets?slug_contains=btc-updown-15m&limit=1&closed=true`);
    const closed: any[] = await resp3.json();
    if (closed.length > 0) {
      console.log(`Market: ${closed[0].question}`);
      console.log(`\nFull Description:\n${closed[0].description}\n`);
    }
  }
}

async function compareHistoricalPrices(): Promise<void> {
  console.log('═══ Part 2: Chainlink vs Binance at Market Open Time ═══\n');

  const rpc = process.env.POLYGON_RPC_URL || 'https://polygon-bor-rpc.publicnode.com';
  const provider = new ethers.providers.JsonRpcProvider(rpc);
  const feed = new ethers.Contract(CHAINLINK_BTC_USD, ABI, provider);
  const dec = await feed.decimals();

  // Get current round to start backward search
  const latest = await feed.latestRoundData();
  let searchRoundId = latest.roundId;

  // Generate 10 historical market open times (last 2.5 hours, every 15 min)
  const nowSec = Math.floor(Date.now() / 1000);
  const q = 15 * 60;
  const currentEnd = Math.ceil(nowSec / q) * q;

  const results: Array<{
    openTime: string;
    clPrice: number;
    clTimestamp: number;
    clDelta: number;
    binPrice: number;
    diff: number;
    diffPct: number;
  }> = [];

  for (let i = 1; i <= 10; i++) {
    const marketEndSec = currentEnd - (i * q);
    const marketOpenSec = marketEndSec - q;

    // Find Chainlink price at market open (scan backwards from searchRoundId)
    let clPrice = 0;
    let clTimestamp = 0;
    let clRoundId = searchRoundId;
    let found = false;

    for (let j = 0; j < 300; j++) {
      const rid = searchRoundId.sub(j);
      try {
        const d = await feed.getRoundData(rid);
        const t = d.updatedAt.toNumber();
        if (t <= marketOpenSec) {
          clPrice = d.answer.toNumber() / 10 ** dec;
          clTimestamp = t;
          clRoundId = rid;
          found = true;
          // Update search start for next market (optimization: start from here)
          searchRoundId = rid;
          break;
        }
      } catch {
        break;
      }
    }

    if (!found) {
      console.log(`  Market ${new Date(marketOpenSec * 1000).toISOString()}: Chainlink data not found`);
      continue;
    }

    // Get Binance 1m kline at market open
    const kResp = await fetch(
      `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&startTime=${marketOpenSec * 1000}&limit=1`
    );
    const klines: any[] = await kResp.json();
    if (klines.length === 0) continue;

    const binOpen = parseFloat(klines[0][1]);  // kline open price
    const binClose = parseFloat(klines[0][4]); // kline close price (end of that minute)

    const diff = Math.abs(clPrice - binOpen);
    const diffPct = (diff / binOpen) * 100;

    results.push({
      openTime: new Date(marketOpenSec * 1000).toISOString(),
      clPrice,
      clTimestamp,
      clDelta: marketOpenSec - clTimestamp,
      binPrice: binOpen,
      diff,
      diffPct,
    });

    console.log(`  ${new Date(marketOpenSec * 1000).toISOString().slice(11, 19)}  CL=$${clPrice.toFixed(2)} (${marketOpenSec - clTimestamp}s before)  Bin=$${binOpen.toFixed(2)}  Diff=$${diff.toFixed(2)} (${diffPct.toFixed(4)}%)`);
  }

  // Summary
  if (results.length > 0) {
    const avgDiff = results.reduce((s, r) => s + r.diffPct, 0) / results.length;
    const maxDiff = Math.max(...results.map(r => r.diffPct));
    const avgClDelta = results.reduce((s, r) => s + r.clDelta, 0) / results.length;

    console.log(`\n  Summary (${results.length} markets):`);
    console.log(`  Avg CL-Bin diff: ${avgDiff.toFixed(4)}%`);
    console.log(`  Max CL-Bin diff: ${maxDiff.toFixed(4)}%`);
    console.log(`  Avg CL lag from open: ${avgClDelta.toFixed(1)}s`);
    console.log(`  Note: CL price is the last update BEFORE market open (up to ~33s stale)`);
  }
}

async function main() {
  await fetchMarketDescription();
  await compareHistoricalPrices();
}

main().catch(console.error);
