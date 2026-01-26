/**
 * Estimate Data Size for 15-minute Market
 *
 * Collects real data for 30 seconds and extrapolates to 15 minutes.
 *
 * Run: npx tsx scripts/orderbooks/estimate-data-size.ts
 */

import WebSocket from 'ws';
import { PolymarketSDK } from '../../src/index.js';

const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const COLLECT_SECONDS = 30;
const MARKET_DURATION_SECONDS = 15 * 60; // 15 minutes

interface MessageStats {
  count: number;
  totalBytes: number;
  samples: string[];
}

async function main() {
  console.log('=== Data Size Estimation for 15-minute Market ===\n');

  // 1. Get market tokens
  console.log('1. Finding an active BTC 15-minute market...');
  const sdk = new PolymarketSDK();
  const cryptoMarkets = await sdk.markets.scanCryptoShortTermMarkets({
    coin: 'BTC',
    duration: '15m',
    limit: 1,
  });

  if (cryptoMarkets.length === 0) {
    console.log('No markets found');
    return;
  }

  const gammaMarket = cryptoMarkets[0];
  const market = await sdk.markets.getMarket(gammaMarket.conditionId);
  const tokenIds = market.tokens.map((t) => t.tokenId);

  console.log(`   Market: ${market.question.slice(0, 60)}...`);
  console.log(`   Tokens: ${tokenIds.length} (subscribing to both)\n`);

  // 2. Collect data
  console.log(`2. Collecting data for ${COLLECT_SECONDS} seconds...\n`);

  const stats: Record<string, MessageStats> = {
    book: { count: 0, totalBytes: 0, samples: [] },
    price_change: { count: 0, totalBytes: 0, samples: [] },
    last_trade_price: { count: 0, totalBytes: 0, samples: [] },
  };

  const ws = new WebSocket(WS_URL);

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.close();
      resolve();
    }, COLLECT_SECONDS * 1000);

    ws.on('open', () => {
      console.log('   Connected, subscribing to both tokens...');
      ws.send(JSON.stringify({ assets_ids: tokenIds, type: 'market' }));
    });

    ws.on('message', (data) => {
      const raw = data.toString();
      const bytes = Buffer.byteLength(raw, 'utf8');

      try {
        const msg = JSON.parse(raw);
        const eventType = msg.event_type || 'unknown';

        if (stats[eventType]) {
          stats[eventType].count++;
          stats[eventType].totalBytes += bytes;
          if (stats[eventType].samples.length < 3) {
            stats[eventType].samples.push(raw);
          }
        }
      } catch {
        // ignore
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    ws.on('close', () => {
      clearTimeout(timeout);
      resolve();
    });
  });

  // 3. Calculate estimates
  console.log('\n=== Results ===\n');

  const multiplier = MARKET_DURATION_SECONDS / COLLECT_SECONDS;
  let totalEstimatedBytes = 0;

  console.log(`Collected in ${COLLECT_SECONDS} seconds:\n`);

  for (const [type, data] of Object.entries(stats)) {
    if (data.count === 0) continue;

    const avgBytes = data.totalBytes / data.count;
    const estimatedCount = Math.round(data.count * multiplier);
    const estimatedBytes = data.totalBytes * multiplier;
    totalEstimatedBytes += estimatedBytes;

    console.log(`  ${type}:`);
    console.log(`    - Count: ${data.count} msgs (${(data.count / COLLECT_SECONDS).toFixed(1)}/sec)`);
    console.log(`    - Total: ${(data.totalBytes / 1024).toFixed(1)} KB`);
    console.log(`    - Avg size: ${avgBytes.toFixed(0)} bytes/msg`);
    console.log(`    - 15min estimate: ${estimatedCount.toLocaleString()} msgs, ${(estimatedBytes / 1024 / 1024).toFixed(2)} MB`);
    console.log();
  }

  console.log('=== Total Estimates for 15-minute Market ===\n');
  console.log(`  Raw JSON: ${(totalEstimatedBytes / 1024 / 1024).toFixed(2)} MB`);
  console.log(`  JSONL (newline per msg): ~${(totalEstimatedBytes / 1024 / 1024 * 1.01).toFixed(2)} MB`);
  console.log(`  Gzipped (est ~10x compression): ~${(totalEstimatedBytes / 1024 / 1024 / 10).toFixed(2)} MB`);

  // Show sample sizes
  console.log('\n=== Sample Message Sizes ===\n');
  for (const [type, data] of Object.entries(stats)) {
    if (data.samples.length > 0) {
      const sample = data.samples[0];
      console.log(`  ${type}: ${Buffer.byteLength(sample, 'utf8')} bytes`);
    }
  }

  console.log('\n=== Done ===');
}

main().catch(console.error);
