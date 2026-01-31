#!/usr/bin/env npx tsx
/**
 * Test script to verify WebSocket user events subscription
 *
 * This script:
 * 1. Connects to Polymarket WebSocket
 * 2. Subscribes to user events (clob_user topic)
 * 3. Places a small order to trigger order events
 * 4. Cancels the order
 * 5. Verifies USER_ORDER events are received
 *
 * Usage:
 *   cd poly-sdk
 *   PRIVATE_KEY=0x... npx tsx scripts/test-websocket-subscription.ts
 */

import { ethers } from 'ethers';
import {
  RealtimeServiceV2,
  TradingService,
  MarketService,
  GammaApiClient,
  DataApiClient,
  RateLimiter,
  createUnifiedCache,
} from '../src/index.js';

const PRIVATE_KEY = process.env.PRIVATE_KEY;

if (!PRIVATE_KEY) {
  console.error('ERROR: PRIVATE_KEY environment variable is required');
  process.exit(1);
}

async function main() {
  console.log('\n=== WebSocket Subscription Test ===\n');

  // 1. Initialize services
  console.log('1. Initializing services...');
  const rateLimiter = new RateLimiter();
  const cache = createUnifiedCache();

  const realtimeService = new RealtimeServiceV2({
    debug: true, // Enable debug logging
  });

  const tradingService = new TradingService(rateLimiter, cache, {
    privateKey: PRIVATE_KEY,
  });

  // Initialize MarketService with all required dependencies
  const gammaApi = new GammaApiClient(rateLimiter);
  const dataApi = new DataApiClient(rateLimiter);
  const marketService = new MarketService(gammaApi, dataApi, rateLimiter, cache);

  // Get wallet address
  const wallet = new ethers.Wallet(PRIVATE_KEY);
  console.log(`   Wallet: ${wallet.address}`);

  // 2. Connect to WebSocket (wait for both market and user channels)
  console.log('\n2. Connecting to WebSocket...');

  // Set up listeners BEFORE connecting
  const marketConnectedPromise = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Market connection timeout')), 10000);
    realtimeService.once('connected', () => {
      clearTimeout(timeout);
      console.log('   ✓ Market channel connected');
      resolve();
    });
  });

  const userConnectedPromise = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('User channel connection timeout')), 10000);
    realtimeService.once('userConnected', () => {
      clearTimeout(timeout);
      console.log('   ✓ User channel connected');
      resolve();
    });
  });

  // Now connect
  realtimeService.connect();

  // Wait for both channels
  await Promise.all([marketConnectedPromise, userConnectedPromise]);

  // 3. Subscribe to user events
  console.log('\n3. Subscribing to user events...');

  // Initialize trading service to get credentials
  await tradingService.initialize();
  const credentials = tradingService.getCredentials();
  if (!credentials) {
    console.error('ERROR: Failed to get trading credentials');
    process.exit(1);
  }

  let userOrderCount = 0;
  let userTradeCount = 0;

  const subscription = realtimeService.subscribeUserEvents(
    {
      apiKey: credentials.key,
      secret: credentials.secret,
      passphrase: credentials.passphrase,
    },
    {
      onOrder: (order) => {
        userOrderCount++;
        console.log(`\n   ✓ USER_ORDER #${userOrderCount} received:`, {
          orderId: order.orderId.slice(0, 10) + '...',
          eventType: order.eventType,
          side: order.side,
          price: order.price,
          size: order.originalSize,
        });
      },
      onTrade: (trade) => {
        userTradeCount++;
        console.log(`\n   ✓ USER_TRADE #${userTradeCount} received:`, {
          tradeId: trade.tradeId.slice(0, 10) + '...',
          status: trade.status,
          size: trade.size,
          price: trade.price,
        });
      },
    }
  );
  console.log(`   Subscription ID: ${subscription.id}`);

  // Wait a moment for subscription to be acknowledged
  await new Promise((r) => setTimeout(r, 2000));

  // 4. Find an active crypto market using MarketService (within 15 minutes)
  console.log('\n4. Finding active crypto market (SOL/BTC/ETH, ends in 3-15 min)...');
  const markets = await marketService.scanCryptoShortTermMarkets({
    coin: 'SOL',
    duration: '15m',
    minMinutesUntilEnd: 3,
    maxMinutesUntilEnd: 15,
    limit: 1,
  });

  if (markets.length === 0) {
    console.log('   No active SOL market found, trying BTC...');
    const btcMarkets = await marketService.scanCryptoShortTermMarkets({
      coin: 'BTC',
      duration: '15m',
      minMinutesUntilEnd: 3,
      maxMinutesUntilEnd: 15,
      limit: 1,
    });
    if (btcMarkets.length > 0) {
      markets.push(...btcMarkets);
    }
  }

  if (markets.length === 0) {
    console.log('   No active BTC market found, trying ETH...');
    const ethMarkets = await marketService.scanCryptoShortTermMarkets({
      coin: 'ETH',
      duration: '15m',
      minMinutesUntilEnd: 3,
      maxMinutesUntilEnd: 15,
      limit: 1,
    });
    if (ethMarkets.length > 0) {
      markets.push(...ethMarkets);
    }
  }

  if (markets.length === 0) {
    console.log('   No active crypto market found');
    console.log('   Waiting for events anyway (15 seconds)...');
    await new Promise((r) => setTimeout(r, 15000));
  } else {
    const market = markets[0];
    const minutesUntilEnd = Math.round((market.endDate.getTime() - Date.now()) / 60000);
    console.log(`   Found: ${market.question.slice(0, 50)}...`);
    console.log(`   Condition ID: ${market.conditionId.slice(0, 20)}...`);
    console.log(`   Ends in: ${minutesUntilEnd} minutes`);

    // Resolve market to get token IDs
    console.log('   Resolving token IDs...');
    const resolved = await marketService.resolveMarketTokens(market.conditionId);
    if (!resolved) {
      console.log('   ✗ Failed to resolve market');
      await new Promise((r) => setTimeout(r, 15000));
    } else {
      const tokenId = resolved.primaryTokenId;
      console.log(`   Token ID: ${tokenId.slice(0, 20)}...`);

      // 5. Place a small test order
      console.log('\n5. Placing test order (will cancel immediately)...');
      try {
        const result = await tradingService.createLimitOrder({
          tokenId,
          side: 'BUY',
          price: 0.05, // Low price to avoid filling, but meet minimum value
          size: 25, // 25 * 0.05 = $1.25 > $1 minimum
          orderType: 'GTC',
        });

        if (result.success && result.orderId) {
          console.log(`   ✓ Order placed: ${result.orderId.slice(0, 20)}...`);

          // Wait for PLACEMENT event
          console.log('   Waiting for USER_ORDER PLACEMENT event (3 seconds)...');
          await new Promise((r) => setTimeout(r, 3000));

          // Cancel the order
          console.log('\n6. Cancelling order...');
          await tradingService.cancelOrder(result.orderId);
          console.log('   ✓ Order cancelled');

          // Wait for CANCELLATION event
          console.log('   Waiting for USER_ORDER CANCELLATION event (3 seconds)...');
          await new Promise((r) => setTimeout(r, 3000));
        } else {
          console.log(`   ✗ Order failed: ${result.errorMsg}`);
          console.log('   Waiting for any events (10 seconds)...');
          await new Promise((r) => setTimeout(r, 10000));
        }
      } catch (err) {
        console.log(`   ✗ Order error: ${err}`);
        console.log('   Waiting for any events (10 seconds)...');
        await new Promise((r) => setTimeout(r, 10000));
      }
    }
  }

  // 7. Summary
  console.log('\n=== Test Summary ===');
  console.log(`   USER_ORDER events received: ${userOrderCount}`);
  console.log(`   USER_TRADE events received: ${userTradeCount}`);

  if (userOrderCount === 0 && userTradeCount === 0) {
    console.log('\n   ⚠️ No events received. Possible issues:');
    console.log('   - WebSocket subscription may not be working');
    console.log('   - Server may not be sending events');
    console.log('   - Check the debug logs above for:');
    console.log('     [RealtimeService] Sending subscription: [{topic:"clob_user"...}]');
    console.log('     [RealtimeService] Received: clob_user:order');
  } else {
    console.log('\n   ✓ WebSocket subscription is working!');
  }

  // Cleanup
  console.log('\n7. Cleaning up...');
  subscription.unsubscribe();
  realtimeService.disconnect();
  console.log('   Done\n');

  process.exit(userOrderCount > 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
