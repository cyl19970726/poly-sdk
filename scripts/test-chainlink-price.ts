/**
 * Test Chainlink on-chain price query vs Binance REST API
 * Also: get reference price for currently active BTC 15m market
 */

import { ethers } from 'ethers';
import 'dotenv/config';

const CHAINLINK_BTC_USD = '0xc907E116054Ad103354f2D350FD2514433D57F6f';
const AGGREGATOR_ABI = [
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function getRoundData(uint80 _roundId) view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function decimals() view returns (uint8)',
  'function description() view returns (string)',
];

async function getChainlinkPriceAtTime(feed: ethers.Contract, decimalsNum: number, targetTimeSec: number, latestRoundId: ethers.BigNumber): Promise<{ price: number; updatedAt: number; roundId: ethers.BigNumber; iterations: number } | null> {
  let iterations = 0;
  for (let i = 0; i < 200; i++) {
    const roundId = latestRoundId.sub(i);
    try {
      iterations++;
      const data = await feed.getRoundData(roundId);
      const updatedAt = data.updatedAt.toNumber();
      if (updatedAt <= targetTimeSec) {
        const price = data.answer.toNumber() / 10 ** decimalsNum;
        return { price, updatedAt, roundId, iterations };
      }
    } catch {
      break;
    }
  }
  return null;
}

async function main() {
  const rpc = process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com';
  const provider = new ethers.providers.JsonRpcProvider(rpc);
  const feed = new ethers.Contract(CHAINLINK_BTC_USD, AGGREGATOR_ABI, provider);

  console.log('=== Chainlink BTC/USD on Polygon ===\n');

  const [decimals, description] = await Promise.all([
    feed.decimals(),
    feed.description(),
  ]);
  const decimalsNum = decimals;
  console.log(`Feed: ${description}, Decimals: ${decimalsNum}`);

  // Get latest round
  const latest = await feed.latestRoundData();
  const latestPrice = latest.answer.toNumber() / 10 ** decimalsNum;
  const latestUpdatedAt = latest.updatedAt.toNumber();
  const latestRoundId = latest.roundId;
  const ageSeconds = Math.floor(Date.now() / 1000) - latestUpdatedAt;

  console.log(`\nLatest Round:`);
  console.log(`  Round ID:   ${latestRoundId.toString()}`);
  console.log(`  Price:      $${latestPrice.toFixed(2)}`);
  console.log(`  Updated At: ${new Date(latestUpdatedAt * 1000).toISOString()}`);
  console.log(`  Age:        ${ageSeconds}s ago`);

  // Get last 10 rounds for update frequency
  console.log(`\nLast 10 rounds:`);
  const rounds: { price: number; updatedAt: number }[] = [];
  for (let i = 0; i < 10; i++) {
    try {
      const roundId = latestRoundId.sub(i);
      const data = await feed.getRoundData(roundId);
      const price = data.answer.toNumber() / 10 ** decimalsNum;
      const updatedAt = data.updatedAt.toNumber();
      rounds.push({ price, updatedAt });
      const gap = i > 0 ? rounds[i - 1].updatedAt - updatedAt : 0;
      console.log(`  #${i}: $${price.toFixed(2)}  ${new Date(updatedAt * 1000).toISOString()}  ${i > 0 ? `(${gap}s gap)` : '(latest)'}`);
    } catch {
      break;
    }
  }

  if (rounds.length >= 2) {
    const gaps = [];
    for (let i = 0; i < rounds.length - 1; i++) {
      gaps.push(rounds[i].updatedAt - rounds[i + 1].updatedAt);
    }
    const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    console.log(`  Avg interval: ${avg.toFixed(1)}s, Min: ${Math.min(...gaps)}s, Max: ${Math.max(...gaps)}s`);
  }

  // Binance current price
  console.log(`\n=== Binance BTC/USDT ===`);
  const resp = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT');
  const binData = (await resp.json()) as { price: string };
  const binPrice = parseFloat(binData.price);
  console.log(`  Current: $${binPrice.toFixed(2)}`);
  console.log(`  Diff from Chainlink: $${Math.abs(latestPrice - binPrice).toFixed(2)} (${((Math.abs(latestPrice - binPrice) / binPrice) * 100).toFixed(4)}%)`);

  // Find currently active BTC 15m market
  console.log(`\n=== Active BTC 15m Market Reference Price ===`);

  // 15m markets end at :00, :15, :30, :45
  const now = Date.now();
  const nowSec = Math.floor(now / 1000);
  const fifteenMin = 15 * 60;
  // Next 15-min boundary
  const nextEnd = Math.ceil(nowSec / fifteenMin) * fifteenMin;
  const marketEndSec = nextEnd;
  const marketOpenSec = marketEndSec - fifteenMin;
  const minutesLeft = (marketEndSec - nowSec) / 60;

  console.log(`  Market end:  ${new Date(marketEndSec * 1000).toISOString()} (${minutesLeft.toFixed(1)}min left)`);
  console.log(`  Market open: ${new Date(marketOpenSec * 1000).toISOString()}`);

  // Get Chainlink price at market open time
  console.log(`\n  Looking up Chainlink price at market open time...`);
  const startSearch = Date.now();
  const refResult = await getChainlinkPriceAtTime(feed, decimalsNum, marketOpenSec, latestRoundId);
  const searchMs = Date.now() - startSearch;

  if (refResult) {
    console.log(`  Chainlink ref price: $${refResult.price.toFixed(2)}`);
    console.log(`  Round updated at:    ${new Date(refResult.updatedAt * 1000).toISOString()}`);
    console.log(`  Delta from open:     ${marketOpenSec - refResult.updatedAt}s before market open`);
    console.log(`  Iterations:          ${refResult.iterations}`);
    console.log(`  Search time:         ${searchMs}ms`);
  } else {
    console.log(`  FAILED to find reference price (searched ${searchMs}ms)`);
  }

  // Also get Binance kline at market open time for comparison
  const klineResp = await fetch(
    `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&startTime=${marketOpenSec * 1000}&limit=1`
  );
  const klines = (await klineResp.json()) as any[];
  if (klines.length > 0) {
    const openPrice = parseFloat(klines[0][1]);
    const closePrice = parseFloat(klines[0][4]);
    console.log(`\n  Binance at open:    $${openPrice.toFixed(2)} (open) / $${closePrice.toFixed(2)} (close)`);
    if (refResult) {
      console.log(`  Chainlink vs Binance: $${Math.abs(refResult.price - openPrice).toFixed(2)} (${((Math.abs(refResult.price - openPrice) / openPrice) * 100).toFixed(4)}%)`);
    }
  }

  // Current BTC delta from reference
  if (refResult) {
    const delta = ((binPrice - refResult.price) / refResult.price) * 100;
    console.log(`\n  Current BTC delta from ref: ${delta > 0 ? '+' : ''}${delta.toFixed(4)}%`);
    console.log(`  If delta > 0 → UP likely, if delta < 0 → DOWN likely`);
  }
}

main().catch(console.error);
