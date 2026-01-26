#!/usr/bin/env npx tsx
/**
 * Raw WebSocket test - using CORRECT Polymarket subscription format
 *
 * Based on: https://docs.polymarket.com/developers/CLOB/websocket/wss-overview
 *
 * Correct format:
 * {
 *   "type": "MARKET",
 *   "assets_ids": ["token_id_1", "token_id_2"]
 * }
 *
 * Event types: book, price_change, last_trade_price, tick_size_change, best_bid_ask
 */

import WebSocket from 'ws';

const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

// BTC 15m market tokens - Updated 2026-01-25 13:47 UTC
const TOKENS = [
  '25277404356707310161798602515808201481481744584949230338976302233391973216142',
  '91448880401329757714051366744469443332543649083819146392495161247259882428715',
];

async function main() {
  console.log('Connecting to:', WS_URL);

  const ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    console.log('Connected!');

    // CORRECT Polymarket subscription format
    const sub = {
      type: 'MARKET',
      assets_ids: TOKENS,
    };

    console.log('Sending subscription:', JSON.stringify(sub, null, 2));
    ws.send(JSON.stringify(sub));
  });

  ws.on('message', (data) => {
    const str = data.toString();
    console.log('Received message:', str.slice(0, 500));
    if (str.length > 500) {
      console.log('... (truncated, total length:', str.length, ')');
    }
  });

  ws.on('pong', () => {
    console.log('Received pong');
  });

  ws.on('close', (code, reason) => {
    console.log('Closed:', code, reason.toString());
  });

  ws.on('error', (err) => {
    console.error('Error:', err.message);
  });

  // Send ping after 5 seconds
  setTimeout(() => {
    console.log('Sending ping...');
    ws.ping();
  }, 5000);

  // Close after 30 seconds
  setTimeout(() => {
    console.log('Closing...');
    ws.close();
    process.exit(0);
  }, 30000);
}

main().catch(console.error);
