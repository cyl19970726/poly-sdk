/**
 * E2E Copy Trading Test
 *
 * Tests enhanced SmartMoneyService.startAutoCopyTrading() with OrderManager integration.
 *
 * Setup:
 * - Target wallet (被跟单): 0xed1050F19F2D5890FF29c2f7416de97e68069171 (MCP wallet)
 * - Copy wallet (跟单方): 0x0F5988a267303f46b50912f176450491DF10476f (.env PRIVATE_KEY + Builder creds)
 *
 * Flow:
 * 1. Initialize SDK + OrderManager with Builder credentials
 * 2. Start SmartMoneyService with polling detection mode
 * 3. Configure limit order mode with price range filter
 * 4. Manually trigger a trade from MCP wallet
 * 5. Observe polling detection (~8.5s delay)
 * 6. Verify auto limit order placement via OrderManager
 * 7. Track OrderHandle lifecycle (accepted -> filled/rejected)
 *
 * Environment:
 * - PRIVATE_KEY: Copy wallet private key
 * - POLY_BUILDER_API_KEY, POLY_BUILDER_SECRET, POLY_BUILDER_PASSPHRASE: Builder credentials
 *
 * Usage (from poly-sdk dir):
 *   npx tsx scripts/test-copy-trading-e2e.ts
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env from project root (same pattern as e2e-builder-test.ts)
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

// Also load poly-sdk/.env (overrides root .env for PRIVATE_KEY etc.)
const sdkEnvPath = resolve(__dirname, '..', '.env');
if (existsSync(sdkEnvPath)) {
  const envContent = readFileSync(sdkEnvPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const [key, ...valueParts] = line.split('=');
    if (key && !key.startsWith('#')) {
      const value = valueParts.join('=').trim();
      if (value) {
        // poly-sdk/.env takes priority — overwrite
        process.env[key.trim()] = value.replace(/^["']|["']$/g, '');
      }
    }
  }
}

import { PolymarketSDK } from '../src/index.js';
import { OrderManager } from '../src/services/order-manager.js';
import { RateLimiter } from '../src/core/rate-limiter.js';
import { createUnifiedCache } from '../src/core/unified-cache.js';

// ============================================================================
// Configuration
// ============================================================================

const TARGET_WALLET = '0xc6B474B755B0FB14B6adD82d97e42B5CeeABf80b'; // User wallet
const COPY_WALLET = '0x0F5988a267303f46b50912f176450491DF10476f'; // Builder wallet

// Detection mode: 'polling' (Data API ~5s), 'mempool' (WSS ~442ms), or 'dual' (both + dedup)
const DETECTION_MODE = (process.env.DETECTION_MODE || 'polling') as 'polling' | 'mempool' | 'dual';

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const BUILDER_API_KEY = process.env.POLY_BUILDER_API_KEY;
const BUILDER_SECRET = process.env.POLY_BUILDER_SECRET;
const BUILDER_PASSPHRASE = process.env.POLY_BUILDER_PASSPHRASE;

// Validate env
if (!PRIVATE_KEY) {
  console.error('Missing PRIVATE_KEY in .env');
  process.exit(1);
}

if (!BUILDER_API_KEY || !BUILDER_SECRET || !BUILDER_PASSPHRASE) {
  console.error('Missing Builder credentials in .env');
  console.error('  Required: POLY_BUILDER_API_KEY, POLY_BUILDER_SECRET, POLY_BUILDER_PASSPHRASE');
  process.exit(1);
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log('========================================');
  console.log('Copy Trading E2E Test');
  console.log('========================================\n');

  console.log('Target wallet (被跟单):', TARGET_WALLET);
  console.log('Copy wallet (跟单方):', COPY_WALLET);
  console.log();

  // Initialize SDK
  const rateLimiter = new RateLimiter();
  const cache = createUnifiedCache();

  console.log('Initializing SDK...');
  const sdk = new PolymarketSDK({
    privateKey: PRIVATE_KEY,
    rateLimiter,
    cache,
    builderCreds: {
      key: BUILDER_API_KEY,
      secret: BUILDER_SECRET,
      passphrase: BUILDER_PASSPHRASE,
    },
    mempoolWssUrl: process.env.MEMPOOL_WSS_RPC,
  });

  console.log('Initializing OrderManager...');
  const orderManager = new OrderManager({
    privateKey: PRIVATE_KEY,
    rateLimiter,
    cache,
    polygonRpcUrl: process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com',
    builderCreds: {
      key: BUILDER_API_KEY,
      secret: BUILDER_SECRET,
      passphrase: BUILDER_PASSPHRASE,
    },
  });

  await orderManager.start();
  console.log('OrderManager started\n');

  // Catch unhandled errors from OrderManager (e.g., settlement tracking RPC errors)
  orderManager.on('error', (err: any) => {
    console.warn('[OM] Non-fatal error:', err.message || err);
  });

  // Setup event listeners
  let orderPlacedCount = 0;
  let orderFilledCount = 0;

  orderManager.on('order_opened', (event: any) => {
    console.log(`[OM] Order opened: ${event.order.id} @ ${event.order.price}`);
  });

  orderManager.on('order_filled', (event: any) => {
    console.log(`[OM] Order filled: ${event.orderId}, size=${event.fill.size} @ ${event.fill.price}`);
    orderFilledCount++;
  });

  orderManager.on('order_rejected', (event: any) => {
    console.log(`[OM] Order rejected: ${event.params.tokenId}, reason=${event.reason}`);
  });

  // Start auto copy trading
  console.log('Starting auto copy trading...');
  console.log('Settings:');
  console.log(`  Detection mode: ${DETECTION_MODE}`);
  console.log('  Order mode: limit');
  console.log('  Limit price offset: +0.01');
  console.log('  Price range: 0.05 - 0.95');
  console.log('  Size scale: 1.0 (same size)');
  console.log('  Max size per trade: $5');
  console.log('  Dry run: false (REAL TRADING)');
  if (DETECTION_MODE !== 'polling') {
    console.log(`  Mempool WSS: ${process.env.MEMPOOL_WSS_RPC ? 'configured' : '⚠️ NOT configured'}`);
  }
  console.log();

  const subscription = await sdk.smartMoney.startAutoCopyTrading({
    targetAddresses: [TARGET_WALLET],
    detectionMode: DETECTION_MODE,
    orderManager,
    orderMode: 'limit',
    limitPriceOffset: 0.01,
    priceRange: { min: 0.05, max: 0.95 },
    sizeScale: 1.0,
    maxSizePerTrade: 5,
    minTradeSize: 0.5,  // Lowered for small test orders
    dryRun: false, // REAL TRADING

    onOrderPlaced: (handle: any) => {
      orderPlacedCount++;
      console.log(`\n>> Order placed via OrderManager: ${handle.orderId || 'pending'}`);
    },

    onOrderFilled: (fill: any) => {
      console.log(`>> Fill event received: ${fill.fill.size} @ ${fill.fill.price}`);
    },

    onTrade: (trade: any, result: any) => {
      console.log(`\n>> Trade detected:`);
      console.log(`   Trader: ${trade.traderAddress}`);
      console.log(`   Side: ${trade.side}`);
      console.log(`   Size: ${trade.size} @ ${trade.price}`);
      console.log(`   Market: ${trade.marketSlug || trade.conditionId}`);
      console.log(`   Result: ${result.success ? 'success' : 'failed'}`);
      if (result.orderId) {
        console.log(`   Order ID: ${result.orderId}`);
      }
      if (result.errorMsg) {
        console.log(`   Error: ${result.errorMsg}`);
      }
    },

    onError: (error: Error) => {
      console.error('Error:', error.message);
    },
  });

  console.log(`Auto copy trading started (subscription: ${subscription.id})\n`);

  // Monitor stats
  console.log('========================================');
  console.log('Monitoring... (Press Ctrl+C to stop)');
  console.log('========================================\n');
  console.log('Waiting for target wallet to trade...');
  console.log('(Manually trigger a trade from MCP wallet now)');
  console.log();

  const statsInterval = setInterval(() => {
    const stats = subscription.getStats();
    console.log(`[${new Date().toISOString()}] Stats:`, {
      detected: stats.tradesDetected,
      executed: stats.tradesExecuted,
      skipped: stats.tradesSkipped,
      failed: stats.tradesFailed,
      filteredByPrice: stats.filteredByPrice || 0,
      spent: `$${stats.totalUsdcSpent.toFixed(2)}`,
    });
  }, 30000); // Every 30s

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n\nShutting down...');
    clearInterval(statsInterval);
    subscription.stop();
    orderManager.stop();
    sdk.smartMoney.disconnect();

    console.log('\nFinal Stats:');
    const finalStats = subscription.getStats();
    console.log('  Trades detected:', finalStats.tradesDetected);
    console.log('  Trades executed:', finalStats.tradesExecuted);
    console.log('  Trades skipped:', finalStats.tradesSkipped);
    console.log('  Trades failed:', finalStats.tradesFailed);
    console.log('  Filtered by price:', finalStats.filteredByPrice || 0);
    console.log('  Total USDC spent:', `$${finalStats.totalUsdcSpent.toFixed(2)}`);
    console.log('\nOrders:');
    console.log('  Orders placed:', orderPlacedCount);
    console.log('  Orders filled:', orderFilledCount);

    process.exit(0);
  });

  // Keep running
  await new Promise(() => {}); // Never resolves
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
