# @catalyst-team/poly-sdk API Reference

Complete API documentation for the Polymarket SDK.

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Core Clients](#core-clients)
  - [PolymarketSDK](#polymarketsdk)
  - [ClobApiClient](#clobapiclient)
  - [GammaApiClient](#gammaapiclient)
  - [DataApiClient](#dataapiclient)
  - [TradingClient](#tradingclient)
  - [BridgeClient](#bridgeclient)
  - [CTFClient](#ctfclient)
  - [WebSocketManager](#websocketmanager)
- [Services](#services)
  - [MarketService](#marketservice)
  - [ArbitrageService](#arbitrageservice)
  - [RealtimeService](#realtimeservice)
  - [WalletService](#walletservice)
- [Utility Functions](#utility-functions)
- [Types](#types)
- [Error Handling](#error-handling)

---

## Installation

```bash
pnpm add @catalyst-team/poly-sdk
```

## Quick Start

```typescript
import { PolymarketSDK } from '@catalyst-team/poly-sdk';

const sdk = new PolymarketSDK();

// Get trending markets
const markets = await sdk.gammaApi.getTrendingMarkets(10);

// Get orderbook for a specific market
const orderbook = await sdk.clobApi.getProcessedOrderbook(markets[0].conditionId);

// Legacy gross signal. Use fee-aware helpers before execution.
console.log('Gross long arb profit:', orderbook.summary.longArbProfit);
```

---

## Core Clients

### PolymarketSDK

The main SDK class that provides access to all API clients.

```typescript
import { PolymarketSDK } from '@catalyst-team/poly-sdk';

const sdk = new PolymarketSDK(config?: PolymarketSDKConfig);
```

#### Constructor Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `config.chainId` | `number` | Polygon chain ID (137 = mainnet, 80002 = Amoy testnet) |
| `config.privateKey` | `string` | Private key for trading operations |
| `config.apiCredentials` | `ApiCredentials` | Pre-generated API credentials |

#### Properties

| Property | Type | Description |
|----------|------|-------------|
| `gammaApi` | `GammaApiClient` | Market discovery and metadata |
| `clobApi` | `ClobApiClient` | Orderbook and market data |
| `dataApi` | `DataApiClient` | Positions, trades, leaderboard |

---

### ClobApiClient

Central Limit Order Book (CLOB) API client for orderbook and market data.

```typescript
import { ClobApiClient, RateLimiter, Cache } from '@catalyst-team/poly-sdk';

const client = new ClobApiClient(
  rateLimiter: RateLimiter,
  cache: Cache,
  config?: {
    chainId?: number;
    signer?: unknown;
    creds?: ApiCredentials;
  }
);
```

#### Methods

##### `getMarket(conditionId: string): Promise<ClobMarket>`

Get market information by condition ID.

```typescript
const market = await client.getMarket('0x82ace55...');
console.log(market.question);          // "Will BTC reach $100k?"
console.log(market.tokens[0].tokenId); // YES token ID
console.log(market.tokens[1].tokenId); // NO token ID
```

**Parameters:**
- `conditionId` - The unique condition identifier for the market

**Returns:** `ClobMarket` object with market details and tokens

---

##### `getOrderbook(tokenId: string): Promise<Orderbook>`

Get raw orderbook for a specific token.

```typescript
const orderbook = await client.getOrderbook('21742633...');

console.log('Best bid:', orderbook.bids[0]?.price);  // e.g., 0.55
console.log('Best ask:', orderbook.asks[0]?.price);  // e.g., 0.57
console.log('Spread:', orderbook.asks[0]?.price - orderbook.bids[0]?.price);
```

**Parameters:**
- `tokenId` - The ERC-1155 token ID (YES or NO token)

**Returns:** `Orderbook` with sorted bids and asks

---

##### `getProcessedOrderbook(conditionId: string): Promise<ProcessedOrderbook>`

Get processed orderbook with complete market analysis and gross arbitrage calculations.

```typescript
const processed = await client.getProcessedOrderbook('0x82ace55...');

// Gross screen only. Fees are not included here.
if (processed.summary.longArbProfit > 0.003) {
  console.log('Gross long arb candidate');
  console.log('Buy YES @', processed.summary.effectivePrices.effectiveBuyYes);
  console.log('Buy NO @', processed.summary.effectivePrices.effectiveBuyNo);
  console.log('Gross profit:', processed.summary.longArbProfit * 100, '%');
}
```

**Parameters:**
- `conditionId` - The unique condition identifier for the market

**Returns:** `ProcessedOrderbook` with both YES/NO books and analytics

**Fee note:** `longArbProfit` and `shortArbProfit` are gross values. Use `MarketService.getFeeAwareProcessedOrderbook()`, `MarketService.detectArbitrageNet()`, or `TradingService.estimateBinaryArbitrageFees()` before alerting or execution.

**Important Notes:**

Polymarket orderbooks have a mirroring property:
- Buying YES @ P = Selling NO @ (1-P)
- Complementary liquidity can be matched through the opposite outcome view

Correct arbitrage calculation uses "effective prices":
- `effectiveBuyYes = min(YES.ask, 1 - NO.bid)`
- `effectiveBuyNo = min(NO.ask, 1 - YES.bid)`

---

### GammaApiClient

Market discovery and metadata API client.

```typescript
import { GammaApiClient, RateLimiter, Cache } from '@catalyst-team/poly-sdk';

const client = new GammaApiClient(rateLimiter: RateLimiter, cache: Cache);
```

#### Methods

##### `getMarkets(params?: MarketSearchParams): Promise<GammaMarket[]>`

Get markets with optional filters and sorting.

```typescript
// Get active markets sorted by 24h volume
const markets = await client.getMarkets({
  active: true,
  closed: false,
  order: 'volume24hr',
  ascending: false,
  limit: 50,
});

// Search by slug
const market = await client.getMarkets({
  slug: 'will-btc-reach-100k',
  limit: 1,
});
```

**MarketSearchParams:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `slug` | `string` | Filter by market slug |
| `conditionId` | `string` | Filter by condition ID |
| `active` | `boolean` | Filter by active status |
| `closed` | `boolean` | Filter by closed status |
| `limit` | `number` | Maximum results (default: 100) |
| `offset` | `number` | Pagination offset |
| `order` | `string` | Sort field: `volume24hr`, `liquidity`, `endDate` |
| `ascending` | `boolean` | Sort direction |

---

##### `getTrendingMarkets(limit?: number): Promise<GammaMarket[]>`

Get trending markets sorted by 24-hour volume.

```typescript
const trending = await client.getTrendingMarkets(10);

for (const market of trending) {
  console.log(`${market.question}`);
  console.log(`  24h Volume: $${market.volume24hr?.toLocaleString()}`);
  console.log(`  YES Price: ${(market.outcomePrices[0] * 100).toFixed(1)}%`);
}
```

---

##### `getEvents(params?): Promise<GammaEvent[]>`

Get events (market groupings) with optional filters.

```typescript
const events = await client.getEvents({ active: true, limit: 20 });
```

---

### DataApiClient

User data, positions, and leaderboard API client.

```typescript
import { DataApiClient, RateLimiter, Cache } from '@catalyst-team/poly-sdk';

const client = new DataApiClient(rateLimiter: RateLimiter, cache: Cache);
```

#### Methods

##### `getPositions(address: string): Promise<Position[]>`

Get positions for a wallet address.

```typescript
const positions = await client.getPositions('0x1234...');
for (const pos of positions) {
  console.log(`${pos.title}: ${pos.size} shares @ ${pos.avgPrice}`);
  console.log(`  PnL: $${pos.cashPnl?.toFixed(2)}`);
}
```

---

##### `getActivity(address: string, params?): Promise<Activity[]>`

Get trading activity for a wallet.

```typescript
const activity = await client.getActivity('0x1234...', { limit: 50 });
```

---

##### `getTrades(params?): Promise<Trade[]>`

Get recent trades, optionally filtered by market.

```typescript
const trades = await client.getTrades({ market: '0x82ace55...', limit: 100 });
```

---

##### `getLeaderboard(params?): Promise<LeaderboardPage>`

Get leaderboard rankings.

```typescript
const leaderboard = await client.getLeaderboard({ limit: 50, offset: 0 });
for (const entry of leaderboard.entries) {
  console.log(`#${entry.rank} ${entry.address}: $${entry.pnl.toFixed(2)}`);
}
```

---

### TradingClient

Trading operations client (requires authentication).

```typescript
import { TradingClient, RateLimiter } from '@catalyst-team/poly-sdk';

const client = new TradingClient(rateLimiter: RateLimiter, {
  privateKey: '0x...',
  chainId: 137,  // Polygon mainnet
});

await client.initialize();
```

#### Methods

##### `createOrder(params: OrderParams): Promise<OrderResult>`

Create and post a limit order.

```typescript
const result = await client.createOrder({
  tokenId: '21742633...',
  side: 'BUY',
  price: 0.55,
  size: 100,
  orderType: 'GTC',  // Good-til-cancelled
  postOnly: true,    // maker-only; rejected if it would cross the spread
});

if (result.success) {
  console.log('Order placed:', result.orderId);
}
```

**OrderParams:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `tokenId` | `string` | Token ID to trade |
| `side` | `'BUY' \| 'SELL'` | Order side |
| `price` | `number` | Price (0.001 - 0.999) |
| `size` | `number` | Size in shares |
| `orderType` | `'GTC' \| 'GTD'` | Order type (default: GTC) |
| `expiration` | `number` | Expiration for GTD orders (unix seconds) |
| `postOnly` | `boolean` | Optional maker-only flag for GTC/GTD limit orders. If the order would match immediately, CLOB rejects it instead of executing it. |

`postOnly` is not a market-order/IOC control. Use `createMarketOrder({ orderType: 'FOK' | 'FAK' })` when the intent is to immediately take resting liquidity; use `postOnly: true` when the intent is to quote as maker and avoid taker execution.

---

##### `createMarketOrder(params: MarketOrderParams): Promise<OrderResult>`

Create and post a market order.

```typescript
const result = await client.createMarketOrder({
  tokenId: '21742633...',
  side: 'BUY',
  amount: 50,  // $50 pUSD notional
  orderType: 'FOK',  // Fill-or-kill
});
```

---

##### `cancelOrder(orderId: string): Promise<OrderResult>`

Cancel an open order.

```typescript
await client.cancelOrder('0xabc123...');
```

---

##### `getOpenOrders(marketId?: string): Promise<Order[]>`

Get all open orders.

```typescript
const orders = await client.getOpenOrders();
console.log(`${orders.length} open orders`);
```

---

##### `getBalanceAllowance(assetType, tokenId?): Promise<{ balance, allowance }>`

Check balance and allowance.

```typescript
const { balance, allowance } = await client.getBalanceAllowance('COLLATERAL');
console.log(`USDC Balance: ${balance}`);
```

---

### BridgeClient

Cross-chain deposit client for funding your Polymarket account.

```typescript
import { BridgeClient } from '@catalyst-team/poly-sdk';

const bridge = new BridgeClient();
```

#### Key Concept: Universal Deposit Addresses

The Polymarket Bridge API returns **universal deposit addresses** by chain type:

- **EVM Address**: A single address works for ALL EVM chains (Ethereum, Polygon, Arbitrum, Base, Optimism)
- **Solana Address**: For Solana deposits
- **Bitcoin Address**: For Bitcoin deposits

This means you don't need a different address for each chain - the same EVM address accepts deposits from Ethereum, Polygon, Arbitrum, Base, and Optimism.

#### Supported Chains

| Chain | Chain ID | Min Deposit | Address Type |
|-------|----------|-------------|--------------|
| Ethereum | 1 | $10 | EVM |
| Polygon | 137 | $2 | EVM |
| Arbitrum | 42161 | $2 | EVM |
| Optimism | 10 | $2 | EVM |
| Base | 8453 | $2 | EVM |
| Solana | - | $5-10 | SVM |
| Bitcoin | - | $10+ | BTC |

#### Supported Tokens (Polygon)

| Token | Address | Description |
|-------|---------|-------------|
| Native USDC | `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359` | Circle's native USDC |
| USDC.e | `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` | Bridged USDC (PoS) |
| USDT | `0xc2132D05D31c914a87C6611C10748AEb04B58e8F` | Tether USD |
| DAI | `0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063` | Dai Stablecoin |
| WETH | `0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619` | Wrapped Ether |
| POL | Native | Polygon native token |

#### Methods

##### `getSupportedAssets(): Promise<BridgeSupportedAsset[]>`

Get all supported chains and tokens.

```typescript
const assets = await bridge.getSupportedAssets();

// Filter for Polygon assets
const polygonAssets = assets.filter(a => a.chainId === 137);
for (const asset of polygonAssets) {
  console.log(`${asset.tokenSymbol}: min $${asset.minDepositUsd}`);
}
```

---

##### `createDepositAddresses(walletAddress: string): Promise<CreateDepositResponse>`

Get universal deposit addresses for your wallet.

**API Response Format:**
```json
{
  "address": {
    "evm": "0x1234...",    // Works for ALL EVM chains
    "svm": "ABC123...",     // Solana address
    "btc": "bc1q..."        // Bitcoin address
  }
}
```

```typescript
const result = await bridge.createDepositAddresses('0xYourWallet');

console.log('EVM deposit address:', result.address.evm);    // All EVM chains
console.log('Solana deposit address:', result.address.svm); // Solana
console.log('Bitcoin deposit address:', result.address.btc); // Bitcoin
```

---

##### `getEvmDepositAddress(walletAddress: string): Promise<string>`

Get the universal EVM deposit address. **Recommended method.**

```typescript
const evmAddr = await bridge.getEvmDepositAddress('0xYourWallet');

// This address works for:
// - Ethereum USDC, ETH
// - Polygon Native USDC, USDC.e, MATIC
// - Arbitrum USDC, ETH
// - Base USDC, ETH
// - Optimism USDC, ETH
console.log(`Send to: ${evmAddr}`);
```

---

##### `getSolanaDepositAddress(walletAddress: string): Promise<string>`

Get the Solana deposit address.

```typescript
const solAddr = await bridge.getSolanaDepositAddress('0xYourWallet');
console.log(`Send SOL or USDC to: ${solAddr}`);
```

---

##### `getBtcDepositAddress(walletAddress: string): Promise<string>`

Get the Bitcoin deposit address.

```typescript
const btcAddr = await bridge.getBtcDepositAddress('0xYourWallet');
console.log(`Send BTC to: ${btcAddr}`);
```

---

##### `getDepositAddress(address, chainId, tokenSymbol): Promise<DepositAddress | null>` _(deprecated)_

> **Deprecated**: Use `getEvmDepositAddress()`, `getSolanaDepositAddress()`, or `getBtcDepositAddress()` instead.

---

##### `isSupported(chainId, tokenSymbol): Promise<boolean>`

Check if a chain/token combination is supported.

```typescript
const supported = await bridge.isSupported(137, 'USDC');
console.log(`Polygon USDC supported: ${supported}`);
```

---

##### `getMinDeposit(chainId, tokenSymbol): Promise<{ amount, usd } | null>`

Get minimum deposit amount.

```typescript
const min = await bridge.getMinDeposit(137, 'USDC');
if (min) {
  console.log(`Min deposit: ${min.amount} (~$${min.usd})`);
}
```

---

#### Deposit Flow Example

```typescript
import { providers, Wallet, Contract, utils } from 'ethers';
import { BridgeClient, BRIDGE_TOKENS } from '@catalyst-team/poly-sdk';

// 1. Setup
const provider = new providers.JsonRpcProvider('https://polygon-rpc.com');
const wallet = new Wallet(PRIVATE_KEY, provider);
const bridge = new BridgeClient();

// 2. Get EVM deposit address (works for all EVM chains)
const depositAddress = await bridge.getEvmDepositAddress(wallet.address);
console.log(`Deposit to: ${depositAddress}`);

// 3. Send Native USDC to the deposit address
const nativeUsdc = new Contract(
  BRIDGE_TOKENS.POLYGON_NATIVE_USDC,
  ['function transfer(address to, uint256 amount) returns (bool)'],
  wallet
);

const amount = utils.parseUnits('5.0', 6); // 5 USDC
const tx = await nativeUsdc.transfer(depositAddress, amount);
await tx.wait();

console.log('Deposit sent. Ensure the Polymarket account has pUSD before V2 trading.');
console.log('Bridge fee: ~0.16%');
```

---

### CTFClient

CTF (Conditional Token Framework) client for on-chain token operations.

```typescript
import { CTFClient } from '@catalyst-team/poly-sdk';

const ctf = new CTFClient({
  privateKey: '0x...',
  rpcUrl: 'https://polygon-rpc.com',
  chainId: 137,
});
```

#### Core Concepts

**Token IDs**: Each binary market has two outcome token IDs. In current Polymarket docs, `tokenId`, `assetId`, and CTF `positionId` all refer to the ERC-1155 outcome token ID.

**Important**: Prefer token IDs returned by Gamma/CLOB APIs for SDK workflows. Hand-calculating position IDs is valid only when collateral token, oracle, question ID, condition ID, and index set are all known for the correct V2 context.

#### Constants

```typescript
import {
  CTF_CONTRACT,         // 0x4D97DCd97eC945f40cF65F87097ACe5EA0476045
  PUSD_CONTRACT,        // 0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB
  COLLATERAL_CONTRACT,  // Alias for PUSD_CONTRACT
  USDC_E_CONTRACT,      // 0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174 (onramp/offramp)
  USDC_CONTRACT,        // Deprecated alias for PUSD_CONTRACT
  NEG_RISK_CTF_EXCHANGE, // 0xC5d563A36AE78145C45a50134d48A1215220f80a
  NEG_RISK_ADAPTER,     // 0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296
  USDC_DECIMALS,        // 6
} from '@catalyst-team/poly-sdk';
```

#### Methods

##### `split(conditionId: string, amount: number): Promise<SplitResult>`

Split pUSD into YES + NO tokens.

```typescript
// Split 10 pUSD into 10 YES + 10 NO
const result = await ctf.split('0xabc123...', 10);

console.log(`TX: ${result.txHash}`);
console.log(`Status: ${result.status}`);
```

---

##### `merge(conditionId: string, amount: number): Promise<MergeResult>`

Merge YES + NO tokens back into pUSD.

```typescript
// Merge 10 YES + 10 NO into 10 pUSD
const result = await ctf.merge('0xabc123...', 10);

console.log(`TX: ${result.txHash}`);
console.log(`pUSD received: ${result.usdcReceived}`);
```

---

##### `getPositionBalanceByTokenIds(conditionId: string, tokenIds: TokenIds): Promise<PositionBalance>`

Get token balances using CLOB token IDs. **Recommended method.**

```typescript
import type { TokenIds } from '@catalyst-team/poly-sdk';

// Get token IDs from CLOB API
const market = await clobApi.getMarket('0xabc123...');
const [yesToken, noToken] = market.tokens;
if (!yesToken || !noToken || market.tokens.length !== 2) {
  throw new Error('Expected binary market');
}

const tokenIds: TokenIds = {
  yesTokenId: yesToken.tokenId,
  noTokenId: noToken.tokenId,
};

const balance = await ctf.getPositionBalanceByTokenIds('0xabc123...', tokenIds);
console.log(`YES: ${balance.yesBalance}, NO: ${balance.noBalance}`);
```

---

##### `canMergeWithTokenIds(conditionId: string, tokenIds: TokenIds, amount: number): Promise<boolean>`

Check if merge is possible with given token balances.

```typescript
const canMerge = await ctf.canMergeWithTokenIds('0xabc123...', tokenIds, 5);
if (canMerge) {
  await ctf.merge('0xabc123...', 5);
}
```

---

##### `getPositionBalance(conditionId: string): Promise<PositionBalance>` _(deprecated)_

> **Deprecated**: Use `getPositionBalanceByTokenIds()` instead. This method hand-calculates position IDs and is easier to misuse when V2 collateral or market metadata are wrong.

---

##### `redeem(conditionId: string, outcome?: 'YES' | 'NO'): Promise<RedeemResult>`

Redeem winning tokens after market resolution. **For standard CTF markets only.**

⚠️ **WARNING**: This method uses calculated position IDs. For Polymarket CLOB markets, use `redeemByTokenIds()` instead.

```typescript
// ❌ Don't use for Polymarket - may fail to find balance
const result = await ctf.redeem(conditionId);
```

**When to use `redeem()`:**
- Standard Gnosis CTF markets (non-Polymarket)
- Markets where position IDs are calculated from conditionId
- Direct CTF contract interactions without CLOB

---

##### `redeemByTokenIds(conditionId: string, tokenIds: TokenIds, outcome?: 'YES' | 'NO'): Promise<RedeemResult>`

Redeem winning tokens using Polymarket token IDs. **Recommended for Polymarket.**

```typescript
// ✅ Use this for Polymarket CLOB markets
const tokenIds: TokenIds = {
  yesTokenId: '25064375110792967023484002819116042931016336431092144471807003884255851454283',
  noTokenId: '98190367690492181203391990709979106077460946443309150166954079213761598385827',
};

const result = await ctf.redeemByTokenIds(conditionId, tokenIds);
console.log(`Redeemed ${result.tokensRedeemed} ${result.outcome} tokens`);
console.log(`Received ${result.usdcReceived} pUSD`);
```

**Parameters:**
- `conditionId` - The market condition ID
- `tokenIds` - Polymarket token IDs from CLOB API
- `outcome` - Optional: 'YES' or 'NO'. Auto-detects winning outcome if not provided.

**Returns:** `RedeemResult` with transaction details

**Why use this method?**
- It uses the token IDs already returned by the market APIs
- It avoids local mistakes in collateral, condition, oracle, question, and index-set inputs
- It keeps SDK code aligned with CLOB/Gamma market metadata

---

##### `getMarketResolution(conditionId: string): Promise<MarketResolution>`

Check if a market is resolved and get the winning outcome.

```typescript
const resolution = await ctf.getMarketResolution(conditionId);
if (resolution.isResolved) {
  console.log(`Winner: ${resolution.winningOutcome}`); // 'YES' or 'NO'
}
```

---

##### `getPusdBalance(): Promise<string>`

Get pUSD balance, the V2 trading collateral.

```typescript
const balance = await ctf.getPusdBalance();
console.log(`pUSD: ${balance}`);
```

##### `getUsdcBalance(): Promise<string>` _(deprecated)_

Deprecated alias for `getPusdBalance()`. It no longer means USDC.e in CLOB V2.

##### `getUsdcEBalance(): Promise<string>`

Get USDC.e balance for onramp/offramp diagnostics.

---

#### Types

```typescript
interface TokenIds {
  yesTokenId: string;
  noTokenId: string;
}

interface PositionBalance {
  conditionId: string;
  yesBalance: string;
  noBalance: string;
  yesPositionId: string;
  noPositionId: string;
}

interface SplitResult {
  txHash: string;
  status: 'success' | 'failed';
  gasUsed: string;
  yesTokenId: string;
  noTokenId: string;
  amountSplit: string;
}

interface MergeResult {
  txHash: string;
  status: 'success' | 'failed';
  gasUsed: string;
  usdcReceived: string;
}

interface RedeemResult {
  success: boolean;
  txHash: string;
  outcome: 'YES' | 'NO';
  tokensRedeemed: string;
  usdcReceived: string;
  gasUsed: string;
}

interface MarketResolution {
  conditionId: string;
  isResolved: boolean;
  winningOutcome?: 'YES' | 'NO';
  payoutNumerators?: number[];
}
```

---

#### CTF Arbitrage Example

```typescript
import { CTFClient, ClobApiClient, TokenIds } from '@catalyst-team/poly-sdk';

const ctf = new CTFClient({ privateKey, rpcUrl, chainId: 137 });
const clobApi = new ClobApiClient(rateLimiter, cache);

// 1. Get market and token IDs
const market = await clobApi.getMarket(conditionId);
const [yesToken, noToken] = market.tokens;
if (!yesToken || !noToken || market.tokens.length !== 2) {
  throw new Error('Expected binary market');
}
const tokenIds: TokenIds = {
  yesTokenId: yesToken.tokenId,
  noTokenId: noToken.tokenId,
};

// 2. Get processed orderbook
const ob = await clobApi.getProcessedOrderbook(conditionId);

// 3. Check for long arbitrage (buy YES + NO, merge for profit)
if (ob.summary.longArbProfit > 0.005) {
  // Buy YES and NO tokens via CLOB
  // Then merge
  const balance = await ctf.getPositionBalanceByTokenIds(conditionId, tokenIds);
  const minBalance = Math.min(
    parseFloat(balance.yesBalance),
    parseFloat(balance.noBalance)
  );

  if (minBalance > 0) {
    const result = await ctf.merge(conditionId, minBalance);
    console.log(`Merged ${minBalance}, received ${result.usdcReceived} pUSD`);
  }
}

// 4. Check for short arbitrage (split, sell YES + NO for profit)
if (ob.summary.shortArbProfit > 0.005) {
  // Split pUSD into tokens
  await ctf.split(conditionId, 10);
  // Sell tokens via CLOB
}
```

---

### WebSocketManager

Real-time market data via WebSocket.

```typescript
import { WebSocketManager } from '@catalyst-team/poly-sdk';

const ws = new WebSocketManager({ enableLogging: true });
```

#### Methods

##### `subscribe(assetIds: string[]): Promise<void>`

Subscribe to market updates.

```typescript
ws.on('bookUpdate', (update) => {
  console.log(`Book update for ${update.assetId}`);
  console.log(`  Best bid: ${update.bids[0]?.price}`);
});

ws.on('priceUpdate', (update) => {
  console.log(`Price: ${update.price}`);
});

await ws.subscribe(['21742633...', '79707176...']);
```

---

##### `unsubscribe(assetIds: string[]): Promise<void>`

Unsubscribe from specific assets.

---

##### `unsubscribeAll(): Promise<void>`

Unsubscribe from all assets and cleanup.

---

## Services

### MarketService

High-level market analysis service.

```typescript
import { MarketService } from '@catalyst-team/poly-sdk';

const service = new MarketService(clobApi, gammaApi);

// Get market with full analysis
const analysis = await service.getMarketWithAnalysis('0x82ace55...');
```

#### Fee-aware orderbook analytics

```typescript
const book = await service.getFeeAwareProcessedOrderbook('0x82ace55...', {
  size: 10,
  liquidityRole: 'taker',
});

console.log('Gross long:', book.summary.longArbProfit);
console.log('Net long:', book.summary.feeAdjusted?.long.netProfit);
console.log('Long fees:', book.summary.feeAdjusted?.long.totalFees);

const netOpportunity = await service.detectArbitrageNet('0x82ace55...', {
  size: 10,
  threshold: 0.05, // pUSD for size=10
});
```

`detectArbitrage()` is still available as a gross-price screen. `detectArbitrageNet()` should be used for production alerts and execution gates.

---

### TradingService

Fee and order helpers for authenticated trading flows.

```typescript
const feeInfo = await trading.getMarketFeeInfo(yesTokenId, conditionId);

const estimate = await trading.estimateOrderFees({
  conditionId,
  tokenId: yesTokenId,
  side: 'BUY',
  price: 0.197,
  size: 6,
  liquidityRole: 'taker',
});

const binaryNet = await trading.estimateBinaryArbitrageFees({
  conditionId,
  yesTokenId,
  noTokenId,
  type: 'long',
  size: 10,
  yesPrice: 0.49,
  noPrice: 0.49,
  liquidityRole: 'taker',
});
```

Polymarket applies actual fees at match time. These methods are pre-trade estimates based on CLOB market info (`fd.r`, `fd.e`, `fd.to`, `mbf`, `tbf`). See [04-fees.md](04-fees.md).

---

### ArbitrageService

Arbitrage opportunity detection. Binary market scanning is fee-aware by default.

```typescript
import { ArbitrageService } from '@catalyst-team/poly-sdk';

const service = new ArbitrageService();

// Scan for opportunities
const opportunities = await service.scanMarkets({
  minVolume24h: 5000,
  limit: 50,
  feeAware: true,       // default
  feeEstimateSize: 1,
  liquidityRole: 'taker',
}, 0.003);              // 0.3% minimum net per share

for (const opp of opportunities) {
  console.log(`${opp.arbType} arb: ${opp.profitPercent.toFixed(2)}% net`);
  console.log(`gross=${opp.grossProfitRate}, fees=${opp.totalFees}`);
}
```

Set `feeAware: false` only when you intentionally want a gross prefilter. Multi-outcome / NegRisk scans are not covered by the binary scanner; aggregate those legs explicitly with `estimateMultiLegArbitrageFees()` after validating the event group.

---

### RealtimeService

High-level WebSocket subscription management.

```typescript
import { RealtimeService, WebSocketManager } from '@catalyst-team/poly-sdk';

const ws = new WebSocketManager();
const realtime = new RealtimeService(ws);

// Subscribe to a market pair
const sub = await realtime.subscribeMarket(yesTokenId, noTokenId, {
  onPairUpdate: (update) => {
    console.log(`YES: ${update.yes.price}, NO: ${update.no.price}`);
    console.log(`Spread: ${update.spread}`);
  },
});

// Later: unsubscribe
await sub.unsubscribe();
```

---

## Utility Functions

### `getEffectivePrices(yesAsk, yesBid, noAsk, noBid)`

Calculate effective prices accounting for orderbook mirroring.

```typescript
import { getEffectivePrices } from '@catalyst-team/poly-sdk';

const effective = getEffectivePrices(0.57, 0.55, 0.45, 0.43);
console.log('Effective buy YES:', effective.effectiveBuyYes);
console.log('Effective buy NO:', effective.effectiveBuyNo);
```

---

### `checkArbitrage(yesAsk, noAsk, yesBid, noBid)`

Check for gross arbitrage opportunities. This helper does not subtract CLOB fees.

```typescript
import { checkArbitrage } from '@catalyst-team/poly-sdk';

const arb = checkArbitrage(0.57, 0.55, 0.45, 0.43);
if (arb) {
  console.log(`${arb.type} opportunity: ${arb.profit * 100}%`);
}
```

---

### `checkArbitrageWithFees(yesAsk, noAsk, yesBid, noBid, params)`

Check for a net arbitrage candidate after estimated platform and builder fees.

```typescript
import { checkArbitrageWithFees } from '@catalyst-team/poly-sdk';

const arb = checkArbitrageWithFees(0.49, 0.48, 0.49, 0.48, {
  size: 10,
  rate: 0.03,
  exponent: 1,
  takerOnly: true,
  liquidityRole: 'taker',
});

if (arb) {
  console.log('Net profit:', arb.netProfit);
  console.log('Total fees:', arb.totalFees);
}
```

---

### `estimateOrderFees(params)` / `estimateBinaryArbitrageFees(params)` / `estimateMultiLegArbitrageFees(params)`

Pure fee estimators for tests and simulations. Use `TradingService` variants when you want the SDK to fetch live fee parameters from CLOB market info.

```typescript
import {
  estimateOrderFees,
  estimateBinaryArbitrageFees,
  estimateMultiLegArbitrageFees,
} from '@catalyst-team/poly-sdk';

const order = estimateOrderFees({
  side: 'BUY',
  price: 0.5,
  size: 100,
  rate: 0.03,
});

const pair = estimateBinaryArbitrageFees({
  type: 'long',
  size: 10,
  yesPrice: 0.49,
  noPrice: 0.49,
  rate: 0.03,
});

const multi = estimateMultiLegArbitrageFees({
  type: 'long',
  size: 10,
  legs: [
    { label: 'A', price: 0.25, rate: 0.03 },
    { label: 'B', price: 0.35, rate: 0.03 },
    { label: 'Any Other Score', price: 0.38, rate: 0.03 },
  ],
});
```

---

## Types

### ClobMarket

```typescript
interface ClobMarket {
  conditionId: string;      // Unique market identifier
  question: string;         // Market question
  description?: string;     // Resolution criteria
  marketSlug: string;       // URL-friendly slug
  tokens: ClobToken[];      // YES and NO tokens
  acceptingOrders: boolean; // Can accept orders
  endDateIso: string;       // ISO end date
  active: boolean;          // Is active
  closed: boolean;          // Is resolved
}
```

### ClobToken

```typescript
interface ClobToken {
  tokenId: string;  // ERC-1155 token ID
  outcome: string;  // "Yes" or "No"
  price: number;    // Current price (0-1)
}
```

### Orderbook

```typescript
interface Orderbook {
  bids: OrderbookLevel[];  // Sorted descending by price
  asks: OrderbookLevel[];  // Sorted ascending by price
  timestamp: number;       // Fetch timestamp (ms)
}

interface OrderbookLevel {
  price: number;  // Price (0.001-0.999)
  size: number;   // Size in shares
}
```

### ProcessedOrderbook

```typescript
interface ProcessedOrderbook {
  yes: {
    bid: number;
    ask: number;
    bidSize: number;
    askSize: number;
    bidDepth: number;
    askDepth: number;
    spread: number;
  };
  no: {
    bid: number;
    ask: number;
    bidSize: number;
    askSize: number;
    bidDepth: number;
    askDepth: number;
    spread: number;
  };
  summary: {
    askSum: number;
    bidSum: number;
    effectivePrices: {
      effectiveBuyYes: number;
      effectiveBuyNo: number;
      effectiveSellYes: number;
      effectiveSellNo: number;
    };
    effectiveLongCost: number;
    effectiveShortRevenue: number;
    longArbProfit: number;    // gross, fees not included
    shortArbProfit: number;   // gross, fees not included
    feeAdjusted?: {
      size: number;
      liquidityRole: 'maker' | 'taker';
      feeRate: number;
      feeExponent: number;
      takerOnly: boolean;
      builderMakerFeeBps: number;
      builderTakerFeeBps: number;
      long: {
        grossProfit: number;
        totalFees: number;
        netProfit: number;
        netProfitPerShare: number;
      };
      short: {
        grossProfit: number;
        totalFees: number;
        netProfit: number;
        netProfitPerShare: number;
      };
    };
    totalBidDepth: number;
    totalAskDepth: number;
    imbalanceRatio: number;
    yesSpread: number;
  };
}
```

### Position

```typescript
interface Position {
  asset: string;        // Token ID
  conditionId: string;  // Market ID
  outcome: string;      // "Yes" or "No"
  outcomeIndex: number; // 0 = Yes, 1 = No
  size: number;         // Shares held
  avgPrice: number;     // Average entry price
  curPrice?: number;    // Current price
  cashPnl?: number;     // Unrealized PnL in USDC
  percentPnl?: number;  // Unrealized PnL %
  realizedPnl?: number; // Realized PnL
  title: string;        // Market title
}
```

---

## Error Handling

The SDK uses `PolymarketError` for all errors.

```typescript
import { PolymarketError, ErrorCode } from '@catalyst-team/poly-sdk';

try {
  await client.getMarket('invalid-id');
} catch (error) {
  if (error instanceof PolymarketError) {
    switch (error.code) {
      case ErrorCode.NOT_FOUND:
        console.log('Market not found');
        break;
      case ErrorCode.RATE_LIMITED:
        console.log('Rate limited, retry later');
        break;
      case ErrorCode.API_ERROR:
        console.log('API error:', error.message);
        break;
    }
  }
}
```

### Error Codes

| Code | Description |
|------|-------------|
| `NOT_FOUND` | Resource not found (404) |
| `RATE_LIMITED` | Rate limit exceeded (429) |
| `UNAUTHORIZED` | Authentication required (401) |
| `FORBIDDEN` | Access denied (403) |
| `INVALID_RESPONSE` | Invalid API response |
| `API_ERROR` | General API error |
| `ORDER_FAILED` | Order placement failed |
| `NETWORK_ERROR` | Network connectivity issue |

---

## License

MIT
