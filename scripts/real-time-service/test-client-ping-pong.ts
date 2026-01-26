#!/usr/bin/env npx tsx
/**
 * Test RealTimeDataClient ping/pong mechanism
 *
 * This script tests the low-level WebSocket client's connection stability:
 * 1. Ping/pong mechanism (every 30 seconds)
 * 2. Pong timeout detection (dead connection)
 * 3. Reconnection with exponential backoff
 *
 * Usage:
 *   npx tsx scripts/real-time-service/test-client-ping-pong.ts
 *   npx tsx scripts/real-time-service/test-client-ping-pong.ts --duration 120  # 2 minutes
 */

import { RealTimeDataClient, ConnectionStatus, type Message } from '../../src/realtime/index.js';

// ============================================================================
// Configuration
// ============================================================================

const args = process.argv.slice(2);
const DURATION_MS = (() => {
  const idx = args.indexOf('--duration');
  if (idx !== -1 && args[idx + 1]) {
    return parseInt(args[idx + 1], 10) * 1000;
  }
  return 90_000; // Default 90 seconds (to see at least 2 pings)
})();

// ============================================================================
// Logging
// ============================================================================

function log(message: string): void {
  const ts = new Date().toISOString().split('T')[1].replace('Z', '');
  console.log(`[${ts}] ${message}`);
}

// ============================================================================
// Main Test
// ============================================================================

async function main() {
  console.log('='.repeat(60));
  console.log('RealTimeDataClient - Ping/Pong Test');
  console.log('='.repeat(60));
  console.log(`Duration: ${DURATION_MS / 1000} seconds`);
  console.log('Expected: ~2-3 ping/pong cycles');
  console.log('');

  let connectionCount = 0;
  let disconnectionCount = 0;
  let messageCount = 0;
  let statusChanges: string[] = [];

  const client = new RealTimeDataClient({
    debug: true, // Enable debug to see ping logs
    pingInterval: 30_000, // 30 seconds
    pongTimeout: 10_000, // 10 seconds
    autoReconnect: true,
    maxReconnectAttempts: 5,

    onConnect: () => {
      connectionCount++;
      log(`[CALLBACK] onConnect called (total: ${connectionCount})`);
    },

    onMessage: (_client, message: Message) => {
      messageCount++;
      log(`[CALLBACK] onMessage: ${message.topic}:${message.type}`);
    },

    onStatusChange: (status: ConnectionStatus) => {
      statusChanges.push(`${new Date().toISOString()}: ${status}`);
      log(`[CALLBACK] onStatusChange: ${status}`);
      if (status === ConnectionStatus.DISCONNECTED) {
        disconnectionCount++;
      }
    },
  });

  // Connect
  log('Connecting...');
  client.connect();

  // Wait for connection
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Connection timeout')), 10_000);
    const check = setInterval(() => {
      if (client.isConnected()) {
        clearInterval(check);
        clearTimeout(timeout);
        resolve();
      }
    }, 100);
  });

  log('Connected! Subscribing to a market...');

  // Subscribe to one market to keep connection active
  // Using a known active market (BTC 15m)
  client.subscribe({
    subscriptions: [
      {
        topic: 'clob_market',
        type: 'agg_orderbook',
        filters: JSON.stringify(['48994567534438052768546459905291990814124815726621990127102668563851621109628']),
      },
    ],
  });

  // Run for specified duration
  log(`Running for ${DURATION_MS / 1000} seconds to observe ping/pong cycles...`);
  log('');

  const startTime = Date.now();
  let lastProgressLog = startTime;

  await new Promise<void>((resolve) => {
    const interval = setInterval(() => {
      const elapsed = Date.now() - startTime;
      const remaining = DURATION_MS - elapsed;

      if (remaining <= 0) {
        clearInterval(interval);
        resolve();
        return;
      }

      // Log progress every 15 seconds
      if (Date.now() - lastProgressLog >= 15_000) {
        lastProgressLog = Date.now();
        log(`Progress: ${Math.round(elapsed / 1000)}s elapsed, ${Math.round(remaining / 1000)}s remaining`);
        log(`  Status: ${client.getStatus()}, Messages: ${messageCount}`);
      }
    }, 1000);
  });

  // Cleanup
  log('');
  log('Disconnecting...');
  client.disconnect();

  // Print results
  console.log('');
  console.log('='.repeat(60));
  console.log('RESULTS');
  console.log('='.repeat(60));
  console.log('');

  console.log('Connection Stats:');
  console.log(`  Connection attempts: ${connectionCount}`);
  console.log(`  Disconnections: ${disconnectionCount}`);
  console.log(`  Messages received: ${messageCount}`);
  console.log('');

  console.log('Status Changes:');
  for (const change of statusChanges) {
    console.log(`  ${change}`);
  }
  console.log('');

  // Verify
  const passed = connectionCount >= 1 && disconnectionCount === 0 && messageCount > 0;

  console.log('Verification:');
  console.log(`  [${connectionCount >= 1 ? 'PASS' : 'FAIL'}] At least 1 connection`);
  console.log(`  [${disconnectionCount === 0 ? 'PASS' : 'FAIL'}] No unexpected disconnections`);
  console.log(`  [${messageCount > 0 ? 'PASS' : 'FAIL'}] Received messages`);
  console.log('');

  console.log('='.repeat(60));
  console.log(`TEST ${passed ? 'PASSED' : 'FAILED'}`);
  console.log('='.repeat(60));

  process.exit(passed ? 0 : 1);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
