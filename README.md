# @catalyst-team/poly-sdk

[![npm version](https://img.shields.io/npm/v/@catalyst-team/poly-sdk.svg)](https://www.npmjs.com/package/@catalyst-team/poly-sdk)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Unified TypeScript SDK for Polymarket** - Trading, market data, smart money analysis, and on-chain operations.

**Builder**: [@hhhx402](https://x.com/hhhx402) | **Project**: [Catalyst.fun](https://x.com/catalystdotfun)

[中文文档](README.zh-CN.md)

---

## Table of Contents

- [Overview](#overview)
- [Installation](#installation)
- [Architecture](#architecture)
- [Quick Start](#quick-start)
- [Services Guide](#services-guide)
  - [PolymarketSDK (Entry Point)](#polymarketsdk-entry-point)
  - [TradingService](#tradingservice)
  - [MarketService](#marketservice)
  - [OnchainService](#onchainservice)
  - [RealtimeServiceV2](#realtimeservicev2)
  - [WalletService](#walletservice)
  - [SmartMoneyService](#smartmoneyservice)
  - [ArbitrageService](#arbitrageservice)
  - [DipArbService](#diparbservice)
- [Low-Level Clients](#low-level-clients)
- [Breaking Changes (v0.3.0)](#breaking-changes-v030)
- [Examples](#examples)
- [API Reference](#api-reference)
- [License](#license)

---

## Overview

`@catalyst-team/poly-sdk` is a comprehensive TypeScript SDK that provides:

- **Trading** - Place limit/market orders (GTC, GTD, FOK, FAK)
- **Market Data** - Real-time prices, orderbooks, K-lines, historical trades
- **Smart Money Analysis** - Track top traders, calculate smart scores, follow wallet strategies
- **On-chain Operations** - CTF (split/merge/redeem), approvals, DEX swaps
- **Arbitrage Detection** - Real-time arbitrage scanning and execution
- **WebSocket Streaming** - Live price feeds and orderbook updates

### Key Features

| Feature | Description |
|---------|-------------|
| **Unified API** | Single SDK for all Polymarket APIs |
| **Type Safety** | Full TypeScript support with comprehensive types |
| **Rate Limiting** | Built-in rate limiting per API endpoint |
| **Caching** | TTL-based caching with pluggable adapters |
| **Error Handling** | Structured errors with auto-retry |

---

## Installation

```bash
pnpm add @catalyst-team/poly-sdk

# or
npm install @catalyst-team/poly-sdk

# or
yarn add @catalyst-team/poly-sdk
```

---

## Architecture

The SDK is organized into three layers:

```
poly-sdk Architecture
================================================================================

┌──────────────────────────────────────────────────────────────────────────────┐
│                              PolymarketSDK                                    │
│                            (Entry Point)                                      │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  Layer 3: High-Level Services (Recommended)                                   │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━                                      │
│  ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐                 │
│  │  TradingService │ │  MarketService  │ │ OnchainService  │                 │
│  │  ────────────── │ │  ────────────── │ │ ──────────────  │                 │
│  │  • Limit orders │ │  • K-lines      │ │ • Split/Merge   │                 │
│  │  • Market orders│ │  • Orderbook    │ │ • Redeem        │                 │
│  │  • Order mgmt   │ │  • Price history│ │ • Approvals     │                 │
│  │  • Rewards      │ │  • Arbitrage    │ │ • Swaps         │                 │
│  └─────────────────┘ └─────────────────┘ └─────────────────┘                 │
│                                                                               │
│  ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐                 │
│  │RealtimeServiceV2│ │  WalletService  │ │SmartMoneyService│                 │
│  │  ────────────── │ │  ────────────── │ │ ──────────────  │                 │
│  │  • WebSocket    │ │  • Profiles     │ │ • Top traders   │                 │
│  │  • Price feeds  │ │  • Smart scores │ │ • Copy trading  │                 │
│  │  • Book updates │ │  • Sell detect  │ │ • Signal detect │                 │
│  │  • User events  │ │  • PnL calc     │ │ • Leaderboard   │                 │
│  └─────────────────┘ └─────────────────┘ └─────────────────┘                 │
│                                                                               │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │                        ArbitrageService                                  │ │
│  │  ─────────────────────────────────────────────────────────────────────  │ │
│  │  • Market scanning  • Auto execution  • Rebalancer  • Smart clearing    │ │
│  └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                               │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │                         DipArbService                                    │ │
│  │  ─────────────────────────────────────────────────────────────────────  │ │
│  │  • 15m crypto UP/DOWN  • Dip detection  • Auto-rotate  • Background redeem│
│  └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                               │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  Layer 2: Low-Level Clients (Advanced Users / Raw API Access)                │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━                       │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐ │
│  │GammaApiClnt│ │DataApiClnt │ │SubgraphClnt│ │ CTFClient  │ │BridgeClient│ │
│  │ ────────── │ │ ────────── │ │ ────────── │ │ ────────── │ │ ────────── │ │
│  │ • Markets  │ │ • Positions│ │ • On-chain │ │ • Split    │ │ • Cross-   │ │
│  │ • Events   │ │ • Trades   │ │ • PnL      │ │ • Merge    │ │   chain    │ │
│  │ • Search   │ │ • Activity │ │ • OI       │ │ • Redeem   │ │ • Deposits │ │
│  └────────────┘ └────────────┘ └────────────┘ └────────────┘ └────────────┘ │
│                                                                               │
│  Uses Official Polymarket Clients:                                           │
│  • @polymarket/clob-client - Trading, orderbook, market data                 │
│  • @polymarket/real-time-data-client - WebSocket real-time updates           │
│                                                                               │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  Layer 1: Core Infrastructure                                                │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━                                                │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐ │
│  │RateLimiter │ │   Cache    │ │   Errors   │ │   Types    │ │Price Utils │ │
│  │ ────────── │ │ ────────── │ │ ────────── │ │ ────────── │ │ ────────── │ │
│  │ • Per-API  │ │ • TTL-based│ │ • Retry    │ │ • Unified  │ │ • Arb calc │ │
│  │ • Bottleneck│ │ • Pluggable│ │ • Codes    │ │ • K-lines  │ │ • Rounding │ │
│  └────────────┘ └────────────┘ └────────────┘ └────────────┘ └────────────┘ │
│                                                                               │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Service Responsibilities

| Service | Responsibility |
|---------|---------------|
| **PolymarketSDK** | Entry point, integrates all services |
| **TradingService** | Order management (place/cancel/query) |
| **MarketService** | Market data (orderbook/K-lines/search) |
| **OnchainService** | On-chain ops (split/merge/redeem/approve/swap) |
| **RealtimeServiceV2** | WebSocket real-time data |
| **WalletService** | Wallet/trader analysis |
| **SmartMoneyService** | Smart money tracking |
| **ArbitrageService** | Arbitrage detection & execution |
| **DipArbService** | Dip arbitrage for 15m crypto markets |

---

## Quick Start

### Basic Usage (Read-Only)

```typescript
import { PolymarketSDK } from '@catalyst-team/poly-sdk';

// No authentication needed for read operations
const sdk = new PolymarketSDK();

// Get market by slug or condition ID
const market = await sdk.getMarket('will-trump-win-2024');
console.log(`${market.question}`);
console.log(`YES: ${market.tokens.find(t => t.outcome === 'Yes')?.price}`);
console.log(`NO: ${market.tokens.find(t => t.outcome === 'No')?.price}`);

// Get processed orderbook with analytics
const orderbook = await sdk.getOrderbook(market.conditionId);
console.log(`Long Arb Profit: ${orderbook.summary.longArbProfit}`);
console.log(`Short Arb Profit: ${orderbook.summary.shortArbProfit}`);

// Detect arbitrage opportunities
const arb = await sdk.detectArbitrage(market.conditionId);
if (arb) {
  console.log(`${arb.type.toUpperCase()} ARB: ${(arb.profit * 100).toFixed(2)}% profit`);
  console.log(arb.action);
}
```

### With Authentication (Trading)

```typescript
import { PolymarketSDK } from '@catalyst-team/poly-sdk';

// Recommended: Use static factory method (one line to get started)
const sdk = await PolymarketSDK.create({
  privateKey: process.env.POLYMARKET_PRIVATE_KEY!,
});
// Ready to trade - SDK is initialized and WebSocket connected

// Place a limit order
const order = await sdk.tradingService.createLimitOrder({
  tokenId: yesTokenId,
  side: 'BUY',
  price: 0.45,
  size: 10,
  orderType: 'GTC',
});
console.log(`Order placed: ${order.id}`);

// Get open orders
const openOrders = await sdk.tradingService.getOpenOrders();
console.log(`Open orders: ${openOrders.length}`);

// Clean up when done
sdk.stop();
```

---

## Services Guide

### PolymarketSDK (Entry Point)

The main SDK class that integrates all services.

```typescript
import { PolymarketSDK } from '@catalyst-team/poly-sdk';

// ===== Method 1: Static Factory (Recommended) =====
// One line: new + initialize + connect + waitForConnection
const sdk = await PolymarketSDK.create({
  privateKey: '0x...', // Optional: for trading
  chainId: 137,        // Optional: Polygon mainnet (default)
});

// ===== Method 2: Using start() =====
// const sdk = new PolymarketSDK({ privateKey: '0x...' });
// await sdk.start();  // initialize + connect + waitForConnection

// ===== Method 3: Manual Step-by-Step (Full Control) =====
// const sdk = new PolymarketSDK({ privateKey: '0x...' });
// await sdk.initialize();       // Initialize trading service
// sdk.connect();                // Connect WebSocket
// await sdk.waitForConnection(); // Wait for connection

// Access services
sdk.tradingService  // Trading operations
sdk.markets         // Market data
sdk.wallets         // Wallet analysis
sdk.realtime        // WebSocket real-time data
sdk.smartMoney      // Smart money tracking & copy trading
sdk.dipArb          // Dip arbitrage for 15m crypto markets
sdk.dataApi         // Direct Data API access
sdk.gammaApi        // Direct Gamma API access
sdk.subgraph        // On-chain data via Goldsky

// Convenience methods
await sdk.getMarket(identifier);        // Get unified market
await sdk.getOrderbook(conditionId);    // Get processed orderbook
await sdk.detectArbitrage(conditionId); // Detect arb opportunity

// Clean up
sdk.stop();  // Disconnect all services
```

---

### TradingService

Order management using `@polymarket/clob-client`.

```typescript
import { TradingService } from '@catalyst-team/poly-sdk';

const trading = new TradingService(rateLimiter, cache, {
  privateKey: process.env.POLYMARKET_PRIVATE_KEY!,
});
await trading.initialize();

// ===== Limit Orders =====

// GTC: Good Till Cancelled
const gtcOrder = await trading.createLimitOrder({
  tokenId: yesTokenId,
  side: 'BUY',
  price: 0.45,
  size: 10,
  orderType: 'GTC',
});

// GTD: Good Till Date (expires at timestamp)
const gtdOrder = await trading.createLimitOrder({
  tokenId: yesTokenId,
  side: 'BUY',
  price: 0.45,
  size: 10,
  orderType: 'GTD',
  expiration: Math.floor(Date.now() / 1000) + 3600, // 1 hour
});

// ===== Market Orders =====

// FOK: Fill Or Kill (fill entirely or cancel)
const fokOrder = await trading.createMarketOrder({
  tokenId: yesTokenId,
  side: 'BUY',
  amount: 10, // $10 USDC
  orderType: 'FOK',
});

// FAK: Fill And Kill (partial fill ok)
const fakOrder = await trading.createMarketOrder({
  tokenId: yesTokenId,
  side: 'SELL',
  amount: 10, // 10 shares
  orderType: 'FAK',
});

// ===== Order Management =====
const openOrders = await trading.getOpenOrders();
await trading.cancelOrder(orderId);
await trading.cancelAllOrders();

// ===== Rewards (Market Making Incentives) =====
const isScoring = await trading.isOrderScoring(orderId);
const rewards = await trading.getCurrentRewards();
const earnings = await trading.getEarnings('2024-12-07');
```

---

### MarketService

Market data, K-lines, orderbook analysis.

```typescript
import { MarketService } from '@catalyst-team/poly-sdk';

// Get unified market
const market = await sdk.markets.getMarket('btc-100k-2024');

// Get K-Lines
const klines = await sdk.markets.getKLines(conditionId, '1h', { limit: 100 });

// Get dual K-Lines (YES + NO) with spread analysis
const dual = await sdk.markets.getDualKLines(conditionId, '1h');
console.log(dual.yes);              // YES token candles
console.log(dual.no);               // NO token candles
console.log(dual.spreadAnalysis);   // Historical spread (trade prices)
console.log(dual.realtimeSpread);   // Real-time spread (orderbook)

// Get processed orderbook
const orderbook = await sdk.markets.getProcessedOrderbook(conditionId);

// Quick real-time spread check
const spread = await sdk.markets.getRealtimeSpread(conditionId);
if (spread.longArbProfit > 0.005) {
  console.log(`Long arb: buy YES@${spread.yesAsk} + NO@${spread.noAsk}`);
}

// Detect market signals
const signals = await sdk.markets.detectMarketSignals(conditionId);
```

#### Understanding Polymarket Orderbook

**Important**: Polymarket orderbooks have a mirror property:

```
Buy YES @ P = Sell NO @ (1-P)
```

This means the **same order appears in both orderbooks**. Simple addition causes double-counting:

```typescript
// WRONG: Double counts mirror orders
const askSum = YES.ask + NO.ask;  // ~1.998, not ~1.0

// CORRECT: Use effective prices
import { getEffectivePrices, checkArbitrage } from '@catalyst-team/poly-sdk';

const effective = getEffectivePrices(yesAsk, yesBid, noAsk, noBid);
// effective.effectiveBuyYes = min(YES.ask, 1 - NO.bid)
// effective.effectiveBuyNo = min(NO.ask, 1 - YES.bid)

const arb = checkArbitrage(yesAsk, noAsk, yesBid, noBid);
if (arb) {
  console.log(`${arb.type} arb: ${(arb.profit * 100).toFixed(2)}% profit`);
}
```

---

### OnchainService

Unified interface for all on-chain operations: CTF + Approvals + Swaps.

```typescript
import { OnchainService } from '@catalyst-team/poly-sdk';

const onchain = new OnchainService({
  privateKey: process.env.POLYMARKET_PRIVATE_KEY!,
  rpcUrl: 'https://polygon-rpc.com', // optional
});

// Check if ready for CTF trading
const status = await onchain.checkReadyForCTF('100');
if (!status.ready) {
  console.log('Issues:', status.issues);
  await onchain.approveAll();
}

// ===== CTF Operations =====

// Split: USDC -> YES + NO tokens
const splitResult = await onchain.split(conditionId, '100');

// Merge: YES + NO -> USDC (for arbitrage)
const mergeResult = await onchain.mergeByTokenIds(conditionId, tokenIds, '100');

// Redeem: Winning tokens -> USDC (after resolution)
const redeemResult = await onchain.redeemByTokenIds(conditionId, tokenIds);

// ===== DEX Swaps (QuickSwap V3) =====

// Swap MATIC to USDC.e (required for CTF)
await onchain.swap('MATIC', 'USDC_E', '50');

// Get balances
const balances = await onchain.getBalances();
console.log(`USDC.e: ${balances.usdcE}`);
```

**Note**: Polymarket CTF requires **USDC.e** (0x2791...), not native USDC.

---

### RealtimeServiceV2

WebSocket real-time data using `@polymarket/real-time-data-client`.

```typescript
import { RealtimeServiceV2 } from '@catalyst-team/poly-sdk';

const realtime = new RealtimeServiceV2({
  autoReconnect: true,
  pingInterval: 5000,
});

// Connect and subscribe
realtime.connect();
realtime.subscribeMarket([yesTokenId, noTokenId]);

// Event-based API
realtime.on('priceUpdate', (update) => {
  console.log(`${update.assetId}: ${update.price}`);
  console.log(`Midpoint: ${update.midpoint}, Spread: ${update.spread}`);
});

realtime.on('bookUpdate', (update) => {
  // Orderbook is auto-normalized:
  // bids: descending (best first), asks: ascending (best first)
  console.log(`Best bid: ${update.bids[0]?.price}`);
  console.log(`Best ask: ${update.asks[0]?.price}`);
});

realtime.on('lastTrade', (trade) => {
  console.log(`Trade: ${trade.side} ${trade.size} @ ${trade.price}`);
});

// Get cached prices
const price = realtime.getPrice(yesTokenId);
const book = realtime.getBook(yesTokenId);

// Cleanup
realtime.disconnect();
```

---

### WalletService

Wallet analysis and smart money scoring.

```typescript
// Get top traders
const traders = await sdk.wallets.getTopTraders(10);

// Get wallet profile with smart score
const profile = await sdk.wallets.getWalletProfile('0x...');
console.log(`Smart Score: ${profile.smartScore}/100`);
console.log(`Win Rate: ${profile.winRate}%`);
console.log(`Total PnL: $${profile.totalPnL}`);

// Detect sell activity (for follow-wallet strategy)
const sellResult = await sdk.wallets.detectSellActivity(
  '0x...',
  conditionId,
  Date.now() - 24 * 60 * 60 * 1000 // since 24h ago
);
if (sellResult.isSelling) {
  console.log(`Sold ${sellResult.percentageSold}%`);
}

// Track group sell ratio
const groupSell = await sdk.wallets.trackGroupSellRatio(
  ['0x...', '0x...'],
  conditionId,
  peakValue,
  sinceTimestamp
);
```

---

### SmartMoneyService

Smart money detection and **real-time auto copy trading**.

```typescript
import { PolymarketSDK } from '@catalyst-team/poly-sdk';

// One line to get started (recommended)
const sdk = await PolymarketSDK.create({ privateKey: '0x...' });
// SDK is initialized and WebSocket connected

// Get smart money wallets
const wallets = await sdk.smartMoney.getSmartMoneyList(50);

// Check if address is smart money
const isSmartMoney = await sdk.smartMoney.isSmartMoney('0x...');

// Subscribe to smart money trades
const sub = sdk.smartMoney.subscribeSmartMoneyTrades(
  (trade) => {
    console.log(`${trade.traderName} ${trade.side} ${trade.outcome} @ $${trade.price}`);
  },
  { filterAddresses: ['0x...'], minSize: 10 }
);

// ===== Auto Copy Trading =====
// Real-time copy trading - when smart money trades, copy immediately

const subscription = await sdk.smartMoney.startAutoCopyTrading({
  // Target selection
  topN: 50,                    // Follow top 50 traders from leaderboard
  // targetAddresses: ['0x...'], // Or specify addresses directly

  // Order settings
  sizeScale: 0.1,              // Copy 10% of their trade size
  maxSizePerTrade: 10,         // Max $10 per trade
  maxSlippage: 0.03,           // 3% slippage tolerance
  orderType: 'FOK',            // FOK or FAK

  // Filters
  minTradeSize: 5,             // Only copy trades > $5
  sideFilter: 'BUY',           // Only copy BUY trades (optional)

  // Testing
  dryRun: true,                // Set false for real trades

  // Callbacks
  onTrade: (trade, result) => {
    console.log(`Copied ${trade.traderName}: ${result.success ? '✅' : '❌'}`);
  },
  onError: (error) => console.error(error),
});

console.log(`Tracking ${subscription.targetAddresses.length} wallets`);

// Get stats
const stats = subscription.getStats();
console.log(`Detected: ${stats.tradesDetected}, Executed: ${stats.tradesExecuted}`);

// Stop
subscription.stop();
sdk.stop();
```

> **Note**: Polymarket minimum order size is **$1**. Orders below $1 will be automatically skipped.

📁 **Full examples**: See [scripts/smart-money/](scripts/smart-money/) for complete working scripts:
- `04-auto-copy-trading.ts` - Full-featured auto copy trading
- `05-auto-copy-simple.ts` - Simplified SDK usage
- `06-real-copy-test.ts` - Real trading test

---

### ArbitrageService

Real-time arbitrage detection, execution, and position management.

```typescript
import { ArbitrageService } from '@catalyst-team/poly-sdk';

const arbService = new ArbitrageService({
  privateKey: process.env.POLY_PRIVKEY,
  profitThreshold: 0.005,  // 0.5% minimum profit
  minTradeSize: 5,         // $5 minimum
  maxTradeSize: 100,       // $100 maximum
  autoExecute: true,       // Auto-execute opportunities

  // Rebalancer: auto-maintain USDC/token ratio
  enableRebalancer: true,
  minUsdcRatio: 0.2,       // Min 20% USDC
  maxUsdcRatio: 0.8,       // Max 80% USDC
  targetUsdcRatio: 0.5,    // Target when rebalancing

  // Execution safety
  sizeSafetyFactor: 0.8,   // Use 80% of orderbook depth
  autoFixImbalance: true,  // Auto-fix partial fills
});

// Listen for events
arbService.on('opportunity', (opp) => {
  console.log(`${opp.type.toUpperCase()} ARB: ${opp.profitPercent.toFixed(2)}%`);
});

arbService.on('execution', (result) => {
  if (result.success) {
    console.log(`Executed: $${result.profit.toFixed(2)} profit`);
  }
});

// ===== Workflow =====

// 1. Scan markets for opportunities
const results = await arbService.scanMarkets({ minVolume24h: 5000 }, 0.005);

// 2. Start monitoring best market
const best = await arbService.findAndStart(0.005);
console.log(`Started: ${best.market.name} (+${best.profitPercent.toFixed(2)}%)`);

// 3. Run for a while...
await new Promise(r => setTimeout(r, 60 * 60 * 1000)); // 1 hour

// 4. Stop and clear positions
await arbService.stop();
const clearResult = await arbService.clearPositions(best.market, true);
console.log(`Recovered: $${clearResult.totalUsdcRecovered.toFixed(2)}`);
```

---

### DipArbService

**Dip Arbitrage** for Polymarket 15-minute crypto UP/DOWN markets (BTC, ETH, SOL, XRP).

**Strategy**: Detect sudden price dips → Buy dipped side (Leg1) → Wait for opposite to drop → Buy opposite (Leg2) → Lock profit (UP + DOWN = $1)

#### Quick Start

```bash
# One command to start auto trading
PRIVATE_KEY=0x... npx tsx scripts/dip-arb/auto-trade.ts
```

#### Features

| Feature | Description |
|---------|-------------|
| **Dip Detection** | Detects 15%+ price drops within 10s sliding window |
| **Two-Leg Execution** | Leg1 (buy dip) + Leg2 (buy opposite when cost < target) |
| **Auto-Rotate** | Automatically switches to next market when current ends |
| **Background Redeem** | Waits for Oracle resolution (~5min) then redeems winning positions |
| **WebSocket Reconnect** | Auto re-subscribes on disconnect |

#### Programmatic Usage

```typescript
import { PolymarketSDK } from '@catalyst-team/poly-sdk';

const sdk = new PolymarketSDK({ privateKey: '0x...' });

// Configure strategy
sdk.dipArb.updateConfig({
  shares: 10,              // Shares per trade
  sumTarget: 0.9,          // Leg2 triggers when cost ≤ 0.9 (11% profit)
  dipThreshold: 0.15,      // 15% dip triggers Leg1
  windowMinutes: 14,       // Trade window after round start
  autoExecute: true,       // Auto-execute signals
});

// Listen to events
sdk.dipArb.on('signal', (signal) => {
  console.log(`${signal.type}: ${signal.side} @ ${signal.price}`);
});

sdk.dipArb.on('execution', (result) => {
  console.log(`${result.leg} ${result.success ? '✅' : '❌'}`);
});

sdk.dipArb.on('roundComplete', (result) => {
  console.log(`Profit: $${result.profit?.toFixed(2)}`);
});

// Find and start monitoring
const market = await sdk.dipArb.findAndStart({
  coin: 'ETH',
  preferDuration: '15m',
});

// Enable auto-rotate with redemption
sdk.dipArb.enableAutoRotate({
  enabled: true,
  underlyings: ['ETH'],
  duration: '15m',
  settleStrategy: 'redeem',
  redeemWaitMinutes: 5,
});

// Get stats
const stats = sdk.dipArb.getStats();
console.log(`Signals: ${stats.signalsDetected}, L1: ${stats.leg1Filled}, L2: ${stats.leg2Filled}`);

// Cleanup
await sdk.dipArb.stop();
sdk.stop();
```

#### Events

| Event | Data | Description |
|-------|------|-------------|
| `started` | `DipArbMarketConfig` | Started monitoring market |
| `stopped` | - | Stopped monitoring |
| `newRound` | `{ roundId, upOpen, downOpen }` | New trading round |
| `signal` | `DipArbSignalEvent` | Leg1/Leg2 signal detected |
| `execution` | `DipArbExecutionResult` | Trade execution result |
| `roundComplete` | `{ profit, profitRate }` | Round finished |
| `rotate` | `{ reason, newMarket }` | Switched to new market |
| `settled` | `{ success, amountReceived }` | Position redeemed |

#### Scripts

```bash
# Auto trading (monitors + trades)
PRIVATE_KEY=0x... npx tsx scripts/dip-arb/auto-trade.ts

# Redeem ended positions
PRIVATE_KEY=0x... npx tsx scripts/dip-arb/redeem-positions.ts
```

---

## Low-Level Clients

For advanced users who need direct API access:

```typescript
import {
  DataApiClient,    // Positions, trades, leaderboard
  GammaApiClient,   // Markets, events, search
  SubgraphClient,   // On-chain data via Goldsky
  CTFClient,        // CTF contract operations
  BridgeClient,     // Cross-chain deposits
  SwapService,      // DEX swaps on Polygon
} from '@catalyst-team/poly-sdk';

// Data API
const positions = await sdk.dataApi.getPositions('0x...');
const trades = await sdk.dataApi.getTrades('0x...');
const leaderboard = await sdk.dataApi.getLeaderboard();

// Gamma API
const markets = await sdk.gammaApi.searchMarkets({ query: 'bitcoin' });
const trending = await sdk.gammaApi.getTrendingMarkets(10);
const events = await sdk.gammaApi.getEvents({ limit: 20 });

// Subgraph (on-chain data)
const userPositions = await sdk.subgraph.getUserPositions(address);
const isResolved = await sdk.subgraph.isConditionResolved(conditionId);
const globalOI = await sdk.subgraph.getGlobalOpenInterest();
```

---

## Breaking Changes (v0.3.0)

### `UnifiedMarket.tokens` is now an Array

**Before (v0.2.x)**:
```typescript
// Object with yes/no properties
const yesPrice = market.tokens.yes.price;
const noPrice = market.tokens.no.price;
```

**After (v0.3.0)**:
```typescript
// Array of MarketToken objects
const yesToken = market.tokens.find(t => t.outcome === 'Yes');
const noToken = market.tokens.find(t => t.outcome === 'No');

const yesPrice = yesToken?.price;
const noPrice = noToken?.price;
```

### Migration Guide

```typescript
// Helper function for migration
function getTokenPrice(market: UnifiedMarket, outcome: 'Yes' | 'No'): number {
  return market.tokens.find(t => t.outcome === outcome)?.price ?? 0;
}

// Usage
const yesPrice = getTokenPrice(market, 'Yes');
const noPrice = getTokenPrice(market, 'No');
```

**Why the change?** The array format better supports multi-outcome markets and is more consistent with the Polymarket API response format.

---

## Examples

Run examples with:

```bash
pnpm example:basic        # Basic usage
pnpm example:smart-money  # Smart money analysis
pnpm example:trading      # Trading orders
pnpm example:realtime     # WebSocket feeds
pnpm example:arb-service  # Arbitrage service
```

| Example | Description |
|---------|-------------|
| [01-basic-usage.ts](examples/01-basic-usage.ts) | Get markets, orderbooks, detect arbitrage |
| [02-smart-money.ts](examples/02-smart-money.ts) | Top traders, wallet profiles, smart scores |
| [03-market-analysis.ts](examples/03-market-analysis.ts) | Market signals, volume analysis |
| [04-kline-aggregation.ts](examples/04-kline-aggregation.ts) | Build OHLCV candles from trades |
| [05-follow-wallet-strategy.ts](examples/05-follow-wallet-strategy.ts) | Track smart money, detect exits |
| [06-services-demo.ts](examples/06-services-demo.ts) | All SDK services in action |
| [07-realtime-websocket.ts](examples/07-realtime-websocket.ts) | Live price feeds, orderbook updates |
| [08-trading-orders.ts](examples/08-trading-orders.ts) | GTC, GTD, FOK, FAK order types |
| [09-rewards-tracking.ts](examples/09-rewards-tracking.ts) | Market maker incentives, earnings |
| [10-ctf-operations.ts](examples/10-ctf-operations.ts) | Split, merge, redeem tokens |
| [11-live-arbitrage-scan.ts](examples/11-live-arbitrage-scan.ts) | Scan markets for opportunities |
| [12-trending-arb-monitor.ts](examples/12-trending-arb-monitor.ts) | Real-time trending monitor |
| [13-arbitrage-service.ts](examples/13-arbitrage-service.ts) | Full arbitrage workflow |
| [14-dip-arb-service.ts](examples/14-dip-arb-service.ts) | Dip arbitrage for 15m crypto |

**DipArb Scripts** (in `scripts/dip-arb/`):
| Script | Description |
|--------|-------------|
| [auto-trade.ts](scripts/dip-arb/auto-trade.ts) | One-click auto trading with rotation |
| [redeem-positions.ts](scripts/dip-arb/redeem-positions.ts) | Redeem ended market positions |

---

## API Reference

For detailed API documentation, see:

- [docs/00-design.md](docs/00-design.md) - Architecture design
- [docs/02-API.md](docs/02-API.md) - Complete API reference
- [docs/01-polymarket-orderbook-arbitrage.md](docs/01-polymarket-orderbook-arbitrage.md) - Orderbook mirror & arbitrage

### Type Exports

```typescript
import type {
  // Core types
  UnifiedMarket,
  MarketToken,
  ProcessedOrderbook,
  ArbitrageOpportunity,
  EffectivePrices,

  // Trading
  Side,
  OrderType,
  Order,
  OrderResult,
  LimitOrderParams,
  MarketOrderParams,

  // K-Lines
  KLineInterval,
  KLineCandle,
  DualKLineData,
  SpreadDataPoint,

  // WebSocket
  PriceUpdate,
  BookUpdate,
  OrderbookSnapshot,

  // Wallet
  WalletProfile,
  SellActivityResult,

  // Smart Money
  SmartMoneyWallet,
  SmartMoneyTrade,
  AutoCopyTradingOptions,
  AutoCopyTradingStats,
  AutoCopyTradingSubscription,

  // CTF
  SplitResult,
  MergeResult,
  RedeemResult,

  // Arbitrage
  ArbitrageMarketConfig,
  ArbitrageServiceConfig,
  ScanResult,
  ClearPositionResult,

  // DipArb
  DipArbServiceConfig,
  DipArbMarketConfig,
  DipArbSignalEvent,
  DipArbExecutionResult,
  DipArbRoundState,
  DipArbStats,
} from '@catalyst-team/poly-sdk';
```

---

## Dependencies

- `@polymarket/clob-client` - Official CLOB trading client
- `@polymarket/real-time-data-client` - Official WebSocket client
- `ethers@5` - Blockchain interactions
- `bottleneck` - Rate limiting

---

## ☕ Buy Me a Coffee

If this SDK helps you, consider supporting the development:

**Polygon (MATIC/USDC/USDT):** `0x58d2ff253998bc2f3b8f5bdbe9c52cad7b022739`

---

## License

MIT
