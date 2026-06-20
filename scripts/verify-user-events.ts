#!/usr/bin/env npx tsx
/**
 * Verify User Events - Subscribe to Polymarket user events via WebSocket
 *
 * This script tests the subscribeUserEvents functionality to:
 * 1. Verify we can authenticate and subscribe to user events
 * 2. See what data is provided for order events (PLACEMENT, UPDATE, CANCELLATION)
 * 3. See what data is provided for trade events (MATCHED, MINED, CONFIRMED, etc.)
 *
 * Usage:
 *   PRIVATE_KEY=0x... npx tsx scripts/verify-user-events.ts
 *
 * The script will run indefinitely, logging all events. Press Ctrl+C to stop.
 */

import { RealtimeServiceV2, UserOrder, UserTrade } from '../src/services/realtime-service-v2.js';
import { ClobClient } from '@polymarket/clob-client-v2';
import { Wallet } from 'ethers';

// Event tracking
const events: {
  type: 'order' | 'trade';
  timestamp: number;
  data: UserOrder | UserTrade;
}[] = [];

function formatTimestamp(ts: number): string {
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 23);
}

function logOrder(order: UserOrder) {
  const time = formatTimestamp(order.timestamp);
  console.log(`\n┌─────────────────────────────────────────────────────────────────┐`);
  console.log(`│ ORDER EVENT: ${order.eventType.padEnd(48)} │`);
  console.log(`├─────────────────────────────────────────────────────────────────┤`);
  console.log(`│ Time:      ${time.padEnd(51)} │`);
  console.log(`│ OrderId:   ${order.orderId.slice(0, 51).padEnd(51)} │`);
  console.log(`│ Market:    ${order.market.slice(0, 51).padEnd(51)} │`);
  console.log(`│ Asset:     ${order.asset.slice(0, 51).padEnd(51)} │`);
  console.log(`│ Side:      ${order.side.padEnd(51)} │`);
  console.log(`│ Price:     ${order.price.toString().padEnd(51)} │`);
  console.log(`│ Size:      ${order.originalSize.toString().padEnd(51)} │`);
  console.log(`│ Matched:   ${order.sizeMatched.toString().padEnd(51)} │`);
  console.log(`└─────────────────────────────────────────────────────────────────┘`);

  events.push({ type: 'order', timestamp: order.timestamp, data: order });
}

function logTrade(trade: UserTrade) {
  const time = formatTimestamp(trade.timestamp);
  const statusColor =
    trade.status === 'CONFIRMED'
      ? '\x1b[32m' // green
      : trade.status === 'FAILED'
        ? '\x1b[31m' // red
        : trade.status === 'RETRYING'
          ? '\x1b[33m' // yellow
          : '\x1b[36m'; // cyan
  const reset = '\x1b[0m';

  console.log(`\n┌─────────────────────────────────────────────────────────────────┐`);
  console.log(`│ TRADE EVENT: ${statusColor}${trade.status.padEnd(48)}${reset} │`);
  console.log(`├─────────────────────────────────────────────────────────────────┤`);
  console.log(`│ Time:      ${time.padEnd(51)} │`);
  console.log(`│ TradeId:   ${trade.tradeId.slice(0, 51).padEnd(51)} │`);
  console.log(`│ Market:    ${trade.market.slice(0, 51).padEnd(51)} │`);
  console.log(`│ Outcome:   ${trade.outcome.padEnd(51)} │`);
  console.log(`│ Side:      ${trade.side.padEnd(51)} │`);
  console.log(`│ Price:     ${trade.price.toString().padEnd(51)} │`);
  console.log(`│ Size:      ${trade.size.toString().padEnd(51)} │`);
  if (trade.transactionHash) {
    console.log(`│ TxHash:    ${trade.transactionHash.slice(0, 51).padEnd(51)} │`);
    console.log(`│ Polygonscan: https://polygonscan.com/tx/${trade.transactionHash.slice(0, 10)}...   │`);
  }
  console.log(`└─────────────────────────────────────────────────────────────────┘`);

  events.push({ type: 'trade', timestamp: trade.timestamp, data: trade });
}

async function main() {
  const privateKey = process.env.PRIVATE_KEY;

  if (!privateKey) {
    console.error('❌ Please set environment variable: PRIVATE_KEY=0x...');
    process.exit(1);
  }

  console.log('╔══════════════════════════════════════════════════════════════════╗');
  console.log('║          POLYMARKET USER EVENTS VERIFICATION                     ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝\n');

  // Create wallet and get address
  const wallet = new Wallet(privateKey);
  const address = wallet.address;
  console.log(`📍 Wallet: ${address}`);

  // Create CLOB API credentials
  console.log('\n🔐 Creating CLOB API credentials...');

  const clobClient = new ClobClient({
    host: 'https://clob.polymarket.com',
    chain: 137, // Polygon mainnet
    signer: wallet,
  });

  // Derive API credentials
  const creds = await clobClient.createOrDeriveApiCreds();
  console.log(`   API Key: ${creds.key.slice(0, 20)}...`);

  // Initialize RealtimeService
  console.log('\n🔌 Connecting to Polymarket WebSocket...');
  const service = new RealtimeServiceV2({ debug: true });

  // Connection status
  service.on('connected', () => {
    console.log('✅ WebSocket connected');
  });

  service.on('disconnected', () => {
    console.log('❌ WebSocket disconnected');
  });

  service.on('error', (error) => {
    console.error('❌ WebSocket error:', error);
  });

  // Connect
  await service.connect();

  // Subscribe to user events
  console.log('\n📡 Subscribing to user events...');

  const subscription = service.subscribeUserEvents(
    {
      key: creds.key,
      secret: creds.secret,
      passphrase: creds.passphrase,
    },
    {
      onOrder: logOrder,
      onTrade: logTrade,
      onError: (error) => {
        console.error('❌ Subscription error:', error);
      },
    }
  );

  console.log(`   Subscription ID: ${subscription.id}`);
  console.log('\n════════════════════════════════════════════════════════════════════');
  console.log('🎧 Listening for user events...');
  console.log('   - Order events: PLACEMENT, UPDATE, CANCELLATION');
  console.log('   - Trade events: MATCHED, MINED, CONFIRMED, RETRYING, FAILED');
  console.log('');
  console.log('💡 To generate events, place an order using:');
  console.log('   npx tsx scripts/verify-order-lifecycle.ts');
  console.log('');
  console.log('Press Ctrl+C to stop.');
  console.log('════════════════════════════════════════════════════════════════════\n');

  // Keep running until Ctrl+C
  let running = true;
  process.on('SIGINT', () => {
    running = false;
    console.log('\n\n════════════════════════════════════════════════════════════════════');
    console.log('SUMMARY');
    console.log('════════════════════════════════════════════════════════════════════');
    console.log(`Total events received: ${events.length}`);
    console.log(`  - Order events: ${events.filter((e) => e.type === 'order').length}`);
    console.log(`  - Trade events: ${events.filter((e) => e.type === 'trade').length}`);

    if (events.length > 0) {
      console.log('\nEvent timeline:');
      for (const event of events) {
        const data = event.data;
        if (event.type === 'order') {
          const order = data as UserOrder;
          console.log(`  ${formatTimestamp(event.timestamp)} ORDER ${order.eventType}`);
        } else {
          const trade = data as UserTrade;
          console.log(
            `  ${formatTimestamp(event.timestamp)} TRADE ${trade.status}${trade.transactionHash ? ` (${trade.transactionHash.slice(0, 10)}...)` : ''}`
          );
        }
      }
    }

    console.log('════════════════════════════════════════════════════════════════════\n');

    subscription.unsubscribe();
    service.disconnect();
    process.exit(0);
  });

  // Keep alive
  while (running) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
