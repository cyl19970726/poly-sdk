/**
 * BTC Price Source Comparison Analysis
 *
 * Compares 3 price sources across multiple BTC 15m markets:
 * 1. Binance BTC/USDT klines (1-minute candles)
 * 2. Chainlink On-chain BTC/USD (Polygon aggregator, ~32s updates)
 * 3. Polymarket YES token mid-price (from orderbook snapshots)
 *
 * For each market, aligns prices at key time points:
 * T=0 (market open), T+3min, T+5min, T+10min, T+14min (near end)
 *
 * Usage: npx tsx scripts/price-comparison-analysis.ts [--limit N] [--verbose]
 */

import { ethers } from 'ethers';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
try { await import('dotenv/config'); } catch { /* dotenv optional */ }

// ═══ Config ═══
const DATA_DIR = join(import.meta.dirname, '../../data-workers/market-data/data/catalyst');
const CATALOG_PATH = join(DATA_DIR, 'crypto-market-catalog.json');

const CHAINLINK_BTC_USD = '0xc907E116054Ad103354f2D350FD2514433D57F6f';
const CHAINLINK_ABI = [
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function getRoundData(uint80 _roundId) view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function decimals() view returns (uint8)',
];

const TIME_POINTS_MIN = [0, 1, 3, 5, 7, 10, 12, 14]; // minutes after market open

// ═══ Types ═══
interface PricePoint {
  timestamp: number; // ms
  price: number;
}

interface MarketComparison {
  conditionId: string;
  slug: string;
  marketOpenMs: number;
  marketEndMs: number;
  timePoints: Array<{
    minuteAfterOpen: number;
    timestampMs: number;
    binancePrice: number | null;
    chainlinkPrice: number | null;
    chainlinkUpdatedAt: number | null; // actual CL update time
    chainlinkLagSec: number | null; // seconds before this timepoint
    yesMidPrice: number | null;
    binVsChainlink: number | null; // % diff
    binVsChainlinkAbs: number | null; // $ diff
  }>;
  settlement: 'UP' | 'DOWN' | null;
  btcDelta: number | null; // % change open → end
}

// ═══ Binance kline fetcher ═══
async function fetchBinanceKlines(startMs: number, endMs: number): Promise<PricePoint[]> {
  const url = new URL('https://api.binance.com/api/v3/klines');
  url.searchParams.set('symbol', 'BTCUSDT');
  url.searchParams.set('interval', '1m');
  url.searchParams.set('startTime', String(startMs));
  url.searchParams.set('endTime', String(endMs));
  url.searchParams.set('limit', '1000');

  const resp = await fetch(url.toString());
  if (!resp.ok) throw new Error(`Binance API error: ${resp.status}`);

  const data = (await resp.json()) as number[][];
  return data.map((k) => ({
    timestamp: k[0] as number, // kline open time
    price: parseFloat(String(k[4])), // close price of 1m candle
  }));
}

function findBinancePrice(klines: PricePoint[], targetMs: number): number | null {
  // Find the kline whose open time is <= targetMs and closest
  let best: PricePoint | null = null;
  for (const k of klines) {
    if (k.timestamp <= targetMs) {
      best = k;
    } else {
      break;
    }
  }
  return best?.price ?? null;
}

// ═══ Chainlink on-chain query (binary search) ═══

/**
 * Binary search for the last Chainlink round with updatedAt <= targetSec.
 * Uses round offset estimation + binary search for O(log n) RPC calls.
 */
async function getChainlinkPriceAtTime(
  feed: ethers.Contract,
  decimalsNum: number,
  latestRoundId: ethers.BigNumber,
  latestUpdatedAt: number,
  targetSec: number,
): Promise<{ price: number; updatedAt: number } | null> {
  const deltaSec = latestUpdatedAt - targetSec;
  if (deltaSec <= 0) {
    // Target is in the future or at latest — use latest
    const d = await feed.latestRoundData();
    return { price: d.answer.toNumber() / 10 ** decimalsNum, updatedAt: d.updatedAt.toNumber() };
  }

  // Estimate offset: ~32s per round
  const estOffset = Math.floor(deltaSec / 32);

  // Binary search bounds: [lo, hi] as offset from latestRoundId
  // lo: definitely before target (larger offset = older round)
  // hi: definitely after target (smaller offset = newer round)
  let lo = Math.max(0, estOffset - Math.floor(estOffset * 0.15)); // ~15% closer
  let hi = estOffset + Math.floor(estOffset * 0.15) + 100;        // ~15% further + buffer

  // Verify bounds: lo should have updatedAt > targetSec (too recent), hi should have <= targetSec (too old)
  // Actually: lo = smaller offset = more recent round, hi = larger offset = older round
  // We want: round at offset lo has updatedAt > targetSec, round at offset hi has updatedAt <= targetSec

  // Binary search: find smallest offset where updatedAt <= targetSec
  let bestResult: { price: number; updatedAt: number } | null = null;
  let iterations = 0;

  while (lo <= hi && iterations < 40) {
    iterations++;
    const mid = Math.floor((lo + hi) / 2);
    const rid = latestRoundId.sub(mid);

    try {
      const d = await feed.getRoundData(rid);
      const t = d.updatedAt.toNumber();

      if (t <= targetSec) {
        // This round is at or before target — save and search for a more recent one
        bestResult = { price: d.answer.toNumber() / 10 ** decimalsNum, updatedAt: t };
        hi = mid - 1; // Try smaller offset (more recent)
      } else {
        // This round is after target — need older round
        lo = mid + 1; // Try larger offset (older)
      }
    } catch {
      // Round might not exist — try smaller offset
      hi = mid - 1;
    }
  }

  if (bestResult) {
    console.log(`    CL binary search: ${iterations} iterations for target ${new Date(targetSec * 1000).toISOString().slice(11,19)}`);
  }
  return bestResult;
}

async function getChainlinkPricesAtTimes(
  feed: ethers.Contract,
  decimalsNum: number,
  latestRoundId: ethers.BigNumber,
  latestUpdatedAt: number,
  targetTimestamps: number[], // unix seconds
): Promise<Map<number, { price: number; updatedAt: number }>> {
  const results = new Map<number, { price: number; updatedAt: number }>();

  for (const targetSec of targetTimestamps) {
    const result = await getChainlinkPriceAtTime(feed, decimalsNum, latestRoundId, latestUpdatedAt, targetSec);
    if (result) {
      results.set(targetSec, result);
    }
  }

  return results;
}

// ═══ Orderbook YES mid-price timeline ═══
function loadOrderbookTimeline(conditionId: string): PricePoint[] {
  const obDir = join(DATA_DIR, 'orderbook-events', conditionId);
  if (!existsSync(obDir)) return [];

  const files = readdirSync(obDir).filter(f => f.endsWith('.jsonl')).sort();
  if (files.length === 0) return [];

  // Collect all orderbook snapshots, find primary (YES) token
  const tokenPrices = new Map<string, PricePoint[]>();

  for (const file of files) {
    const lines = readFileSync(join(obDir, file), 'utf-8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const record = JSON.parse(line);
        if (record.type !== 'orderbook' || !record.tokenId) continue;

        const bestBid = record.bids?.length > 0 ? Math.max(...record.bids.map((b: any) => b.price)) : null;
        const bestAsk = record.asks?.length > 0 ? Math.min(...record.asks.map((a: any) => a.price)) : null;
        const mid = bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : null;

        if (mid != null && record.timestamp) {
          const arr = tokenPrices.get(record.tokenId) ?? [];
          arr.push({ timestamp: record.timestamp, price: mid });
          tokenPrices.set(record.tokenId, arr);
        }
      } catch { /* skip */ }
    }
  }

  if (tokenPrices.size === 0) return [];

  // Primary = token with higher end-mid (UP/YES token)
  let primaryId = '';
  let primaryEndMid = 0;
  for (const [tokenId, prices] of tokenPrices) {
    if (prices.length > 0) {
      const endMid = prices[prices.length - 1].price;
      if (endMid > primaryEndMid) {
        primaryEndMid = endMid;
        primaryId = tokenId;
      }
    }
  }

  return (tokenPrices.get(primaryId) ?? []).sort((a, b) => a.timestamp - b.timestamp);
}

function findYesMidPrice(timeline: PricePoint[], targetMs: number): number | null {
  // Find closest point within 30s
  let bestDist = Infinity;
  let bestPrice: number | null = null;
  for (const p of timeline) {
    const dist = Math.abs(p.timestamp - targetMs);
    if (dist < bestDist) {
      bestDist = dist;
      bestPrice = p.price;
    }
  }
  return bestDist < 60_000 ? bestPrice : null; // within 60s
}

// ═══ Main ═══
async function main() {
  const args = process.argv.slice(2);
  const limit = args.includes('--limit')
    ? parseInt(args[args.indexOf('--limit') + 1], 10)
    : 10;
  const verbose = args.includes('--verbose');

  console.log('═══ BTC Price Source Comparison Analysis ═══\n');

  // Load catalog
  const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf-8'));
  const allEntries = Array.isArray(catalog) ? catalog : catalog.markets ?? [];
  const btc15m = allEntries.filter((e: any) => e.coin === 'BTC' && e.duration === '15m');
  console.log(`BTC 15m markets in catalog: ${btc15m.length}`);

  // Filter to markets with local orderbook data
  const withData = btc15m.filter((e: any) =>
    existsSync(join(DATA_DIR, 'orderbook-events', e.conditionId)),
  );
  console.log(`With local orderbook data: ${withData.length}`);

  // Pick recent markets with enough data
  const candidates = withData
    .filter((e: any) => e.qualityEstimate !== 'LOW' || e.totalSizeBytes > 10000)
    .slice(0, limit * 2); // over-select in case some fail

  // Setup Chainlink
  const rpc = process.env.POLYGON_RPC_URL || 'https://polygon-bor-rpc.publicnode.com';
  const provider = new ethers.providers.JsonRpcProvider(rpc);
  const feed = new ethers.Contract(CHAINLINK_BTC_USD, CHAINLINK_ABI, provider);
  const decimalsNum = await feed.decimals();
  const latest = await feed.latestRoundData();
  const latestUpdatedAt = latest.updatedAt.toNumber();
  console.log(`Chainlink latest round: ${latest.roundId.toString()}, price: $${(latest.answer.toNumber() / 10 ** decimalsNum).toFixed(2)}, updatedAt: ${new Date(latestUpdatedAt * 1000).toISOString()}\n`);

  const results: MarketComparison[] = [];
  let processed = 0;

  for (const m of candidates) {
    if (processed >= limit) break;

    const slug = m.slug as string;
    const match = slug.match(/btc-updown-\d+m-(\d+)/);
    if (!match) continue;

    const slugTs = parseInt(match[1], 10);
    const marketOpenMs = slugTs * 1000;
    const marketEndMs = (slugTs + 900) * 1000;

    // Load orderbook timeline
    const yesMids = loadOrderbookTimeline(m.conditionId);
    if (yesMids.length < 3) {
      if (verbose) console.log(`  Skip ${slug}: only ${yesMids.length} orderbook points`);
      continue;
    }

    processed++;
    console.log(`[${processed}/${limit}] ${slug}`);
    console.log(`  Open: ${new Date(marketOpenMs).toISOString()}  End: ${new Date(marketEndMs).toISOString()}`);
    console.log(`  Orderbook points: ${yesMids.length}`);

    // Fetch Binance klines
    let binanceKlines: PricePoint[];
    try {
      binanceKlines = await fetchBinanceKlines(marketOpenMs - 60_000, marketEndMs + 60_000);
    } catch (err) {
      console.log(`  Binance fetch failed: ${err}`);
      continue;
    }

    // Query Chainlink at each time point
    const targetsSec = TIME_POINTS_MIN.map(min => Math.floor((marketOpenMs + min * 60_000) / 1000));
    let clPrices: Map<number, { price: number; updatedAt: number }>;
    try {
      clPrices = await getChainlinkPricesAtTimes(feed, decimalsNum, latest.roundId, latestUpdatedAt, targetsSec);
    } catch (err) {
      console.log(`  Chainlink query failed: ${err}`);
      continue;
    }

    // Build comparison
    const timePoints = TIME_POINTS_MIN.map(min => {
      const ts = marketOpenMs + min * 60_000;
      const tsSec = Math.floor(ts / 1000);

      const binPrice = findBinancePrice(binanceKlines, ts);
      const clData = clPrices.get(tsSec);
      const yesMid = findYesMidPrice(yesMids, ts);

      const binVsCl = binPrice != null && clData != null
        ? ((binPrice - clData.price) / clData.price) * 100
        : null;
      const binVsClAbs = binPrice != null && clData != null
        ? binPrice - clData.price
        : null;

      return {
        minuteAfterOpen: min,
        timestampMs: ts,
        binancePrice: binPrice,
        chainlinkPrice: clData?.price ?? null,
        chainlinkUpdatedAt: clData?.updatedAt ?? null,
        chainlinkLagSec: clData ? tsSec - clData.updatedAt : null,
        yesMidPrice: yesMid,
        binVsChainlink: binVsCl,
        binVsChainlinkAbs: binVsClAbs,
      };
    });

    // Settlement
    const refBin = timePoints[0].binancePrice;
    const endBin = timePoints[timePoints.length - 1].binancePrice;
    const settlement = refBin != null && endBin != null
      ? (endBin >= refBin ? 'UP' : 'DOWN') as const
      : null;
    const btcDelta = refBin != null && endBin != null
      ? ((endBin - refBin) / refBin) * 100
      : null;

    results.push({
      conditionId: m.conditionId,
      slug,
      marketOpenMs,
      marketEndMs,
      timePoints,
      settlement,
      btcDelta,
    });

    // Print per-market summary
    if (verbose) {
      console.log(`  Time   | Binance      | Chainlink    | CL Lag | Bin-CL Diff  | YES Mid`);
      console.log(`  -------|-------------|-------------|--------|-------------|--------`);
      for (const tp of timePoints) {
        const bin = tp.binancePrice != null ? `$${tp.binancePrice.toFixed(2)}` : 'N/A';
        const cl = tp.chainlinkPrice != null ? `$${tp.chainlinkPrice.toFixed(2)}` : 'N/A';
        const lag = tp.chainlinkLagSec != null ? `${tp.chainlinkLagSec}s` : 'N/A';
        const diff = tp.binVsChainlink != null ? `${tp.binVsChainlink > 0 ? '+' : ''}${tp.binVsChainlink.toFixed(4)}%` : 'N/A';
        const yes = tp.yesMidPrice != null ? tp.yesMidPrice.toFixed(3) : 'N/A';
        console.log(`  T+${String(tp.minuteAfterOpen).padStart(2)}m  | ${bin.padStart(11)} | ${cl.padStart(11)} | ${lag.padStart(6)} | ${diff.padStart(11)} | ${yes}`);
      }
    }

    console.log(`  Settlement: ${settlement}, BTC delta: ${btcDelta?.toFixed(4) ?? 'N/A'}%`);
    console.log();

    // Rate limit for Binance API
    await new Promise(r => setTimeout(r, 200));
  }

  // ═══ Aggregate Statistics ═══
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`Processed: ${results.length} markets\n`);

  // Binance vs Chainlink diff stats per time point
  console.log('── Binance vs Chainlink On-Chain Price Difference ──\n');
  console.log('Time    | Avg Diff %  | Max Diff %  | Avg |Diff| $  | Avg CL Lag');
  console.log('--------|------------|------------|-------------|----------');

  for (const min of TIME_POINTS_MIN) {
    const diffs = results
      .map(r => r.timePoints.find(tp => tp.minuteAfterOpen === min))
      .filter(tp => tp?.binVsChainlink != null)
      .map(tp => ({
        pct: tp!.binVsChainlink!,
        abs: Math.abs(tp!.binVsChainlinkAbs!),
        lag: tp!.chainlinkLagSec!,
      }));

    if (diffs.length === 0) continue;

    const avgPct = diffs.reduce((s, d) => s + d.pct, 0) / diffs.length;
    const maxPct = Math.max(...diffs.map(d => Math.abs(d.pct)));
    const avgAbs = diffs.reduce((s, d) => s + d.abs, 0) / diffs.length;
    const avgLag = diffs.reduce((s, d) => s + d.lag, 0) / diffs.length;

    console.log(`T+${String(min).padStart(2)}m   | ${(avgPct > 0 ? '+' : '') + avgPct.toFixed(4)}%  | ${maxPct.toFixed(4)}%  | $${avgAbs.toFixed(2).padStart(9)} | ${avgLag.toFixed(1)}s`);
  }

  // YES mid-price vs BTC delta correlation
  console.log('\n── YES Mid-Price vs BTC Direction ──\n');

  for (const min of [3, 5, 7, 10, 14]) {
    const pairs = results
      .filter(r => r.settlement != null)
      .map(r => {
        const tp = r.timePoints.find(t => t.minuteAfterOpen === min);
        return { yesMid: tp?.yesMidPrice, settlement: r.settlement };
      })
      .filter(p => p.yesMid != null);

    if (pairs.length === 0) continue;

    const upWins = pairs.filter(p => p.settlement === 'UP');
    const downWins = pairs.filter(p => p.settlement === 'DOWN');
    const avgYesWhenUp = upWins.length > 0
      ? upWins.reduce((s, p) => s + p.yesMid!, 0) / upWins.length : 0;
    const avgYesWhenDown = downWins.length > 0
      ? downWins.reduce((s, p) => s + p.yesMid!, 0) / downWins.length : 0;

    console.log(`T+${String(min).padStart(2)}m: YES mid when UP wins: ${avgYesWhenUp.toFixed(3)}, when DOWN wins: ${avgYesWhenDown.toFixed(3)} (n=${pairs.length})`);
  }

  // BTC delta distribution
  console.log('\n── BTC Price Delta Distribution (open → near-end) ──\n');
  const deltas = results.filter(r => r.btcDelta != null).map(r => r.btcDelta!);
  if (deltas.length > 0) {
    const sorted = [...deltas].sort((a, b) => a - b);
    console.log(`  Count: ${deltas.length}`);
    console.log(`  Mean: ${(deltas.reduce((s, d) => s + d, 0) / deltas.length).toFixed(4)}%`);
    console.log(`  Median: ${sorted[Math.floor(sorted.length / 2)].toFixed(4)}%`);
    console.log(`  Min: ${sorted[0].toFixed(4)}%`);
    console.log(`  Max: ${sorted[sorted.length - 1].toFixed(4)}%`);
    console.log(`  Std: ${Math.sqrt(deltas.reduce((s, d) => s + d * d, 0) / deltas.length - (deltas.reduce((s, d) => s + d, 0) / deltas.length) ** 2).toFixed(4)}%`);
    console.log(`  UP: ${deltas.filter(d => d >= 0).length}, DOWN: ${deltas.filter(d => d < 0).length}`);
  }

  // Save results
  const outPath = join(import.meta.dirname, '../../.claude/temp/price-comparison-results.json');
  writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\nResults saved to ${outPath}`);
}

main().catch(console.error);
