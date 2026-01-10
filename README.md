# User Guide

> **Polymarket TypeScript SDK** - Complete solution for prediction market trading, smart money analysis, and market data. ➡️[About poly-sdk](./poly-sdk.md)

[![npm version](https://img.shields.io/npm/v/@catalyst-team/poly-sdk.svg)](https://www.npmjs.com/package/@catalyst-team/poly-sdk)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## 📖 About This Project

`poly-sdk` is a feature-complete TypeScript SDK for Polymarket prediction markets, providing:

- 🎯 **Trading Features** - Limit/market orders (GTC, GTD, FOK, FAK), order management, rewards tracking
- 📊 **Market Data** - Real-time prices, orderbooks, K-lines, trade history, market search
- 🧠 **Smart Money Analysis** - Track top traders, calculate P&L, identify high-performing wallets, copy trading strategies
- ⛓️ **On-chain Operations** - CTF (Split/Merge/Redeem), token approvals, DEX swaps
- 💰 **Arbitrage Tools** - Real-time arbitrage scanning, monitoring, and execution (production-ready)
- 🔴 **Real-time Push** - WebSocket real-time price and orderbook updates
- 🚀 **Production Ready** - Includes production-grade examples with complete error handling, logging, and monitoring

## ✨ Key Features

### 📚 13 Complete Examples
- **01-07**: Basic feature demos (market data, analysis, WebSocket)
- **08-10**: Trading and on-chain operations (requires private key)
- **11**: Arbitrage scanning (read-only)
- **12-13**: 🚀 **Production-grade arbitrage services** (with complete error handling, logging, monitoring)

### 🛠️ Utility Scripts Collection
- **Approval Management** - Token approval checking and setup
- **Deposit & Swap** - USDC deposit and swap tools
- **Trading Management** - Order and position management
- **Wallet Tools** - Balance checking and verification
- **Dip Arbitrage** - Automated trading strategies
- **Smart Money Copy Trading** - Automated copy trading system
- **Arbitrage Tools** - Arbitrage detection and execution
- **Market Research** - Market analysis and research tools

### 🚀 Production-Grade Features
- ✅ Structured logging system (JSON format)
- ✅ Configuration validation (startup checks)
- ✅ Error handling and retry mechanisms (exponential backoff)
- ✅ Trading limits and safety checks
- ✅ Metrics collection and monitoring
- ✅ Graceful shutdown and state saving

### 🎨 Developer Experience
- 📋 **CLI Command List Tool** - Quickly view all available commands
- 🔧 **Automated Installation Scripts** - One-click installation of all dependencies (Windows/Linux/macOS)
- 📖 **Complete Documentation** - Detailed user guide and API documentation
- 💡 **Rich Examples** - 13 examples covering all major features

## 📦 Project Structure

```
poly-sdk/
├── src/                    # SDK source code
│   ├── clients/           # Low-level clients (Gamma API, CLOB, CTF, etc.)
│   ├── services/          # High-level services (Trading, Market, Arbitrage, etc.)
│   └── utils/             # Utility functions
├── examples/              # Example code
│   ├── 01-11-*.ts         # Basic tutorial examples
│   ├── 12-13-*.ts         # Production-grade examples
│   └── config/            # Production-grade configuration modules
├── scripts/                # Utility scripts
│   ├── approvals/         # Token approvals
│   ├── trading/           # Trading management
│   ├── dip-arb/           # Dip arbitrage strategies
│   └── smart-money/        # Smart money copy trading
├── install.sh             # Linux/macOS installation script
├── install.ps1            # Windows installation script
└── list-commands.ts       # CLI command list tool
```

## 🎯 Use Cases

- 📈 **Quantitative Trading** - Automated trading strategies, arbitrage execution
- 🔍 **Market Analysis** - Market data acquisition, price analysis, trend monitoring
- 🧠 **Smart Money Tracking** - Identify high-performing traders, copy trading strategies
- 💰 **Arbitrage Trading** - Real-time arbitrage detection and execution
- 📊 **Data Research** - Market data collection and analysis

---

## 📋 Table of Contents

- [Supported Platforms](#supported-platforms)
- [Clone Project](#clone-project)
- [Quick Installation (Automated Scripts)](#quick-installation-automated-scripts)
- [Install Project Dependencies and Build](#install-project-dependencies-and-build)
- [Environment Configuration](#environment-configuration)
- [Run Examples](#run-examples)
- [Command List Tools](#command-list-tools)
- [Example Details](#example-details)
- [Using Utility Scripts](#using-utility-scripts)
- [Common Questions](#common-questions)

---

## 🖥️ Supported Platforms

- ![Windows](https://img.shields.io/badge/-Windows-0078D6?logo=windows&logoColor=white)
- ![macOS](https://img.shields.io/badge/-macOS-000000?logo=apple&logoColor=white)
- ![Linux](https://img.shields.io/badge/-Linux-FCC624?logo=linux&logoColor=black)
- ![WSL](https://img.shields.io/badge/-WSL-0078D6?logo=windows&logoColor=white) &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;➡️[How to Install WSL2 Ubuntu on Windows](https://medium.com/@cryptoguy_/在-windows-上安装-wsl2-和-ubuntu-a857dab92c3e)

---

## 🚀 Installation Guide

### 1️⃣ Clone Project

(Make sure you have `git` installed. If not, please refer to ➡️[Git Installation Tutorial](./安装git教程.md))

```bash
# Clone repository
git clone https://github.com/oxmoei/poly-sdk.git

# Enter project directory
cd poly-sdk

# (Optional) If you need to switch to the English branch, execute the following command.
git checkout EN
```

---

### 2️⃣ Quick Installation (Automated Scripts)

One-click check and installation of missing prerequisites.
- ✅ Install system dependencies
- ✅ Install Node.js LTS (via nvm)
- ✅ Install pnpm (multiple methods automatically tried)
- ✅ Automatically apply environment variable configuration
- ✅ Verify installation results

#### 📌 Linux / macOS / WSL Users

```bash
# Execute in project root directory
./install.sh
```

#### 📌 Windows Users

```powershell
# Run PowerShell as Administrator, then execute in project root directory
Set-ExecutionPolicy Bypass -Scope CurrentUser
.\install.ps1
```
---

### 3️⃣ Install Project Dependencies and Build Project

```bash
# Install all project dependencies
pnpm install

# Build project
pnpm run build
```

After building, TypeScript code will be compiled to the `dist/` directory.

---

### 4️⃣ Configure Environment Variables

Rename the `.env.example` file to `.env` and add the following content:

```env
POLYMARKET_PRIVATE_KEY=0xYourPrivateKey

# Optional: Arbitrage scan configuration
SCAN_INTERVAL_MS=5000
PROFIT_THRESHOLD=0.005
```

---

## ❇️ Usage

The project provides two CLI tools to help you quickly find and execute commands:

### 📌 Interactive CLI (Recommended)

Select and execute commands through a beautiful menu interface without memorizing commands.

```bash
# Use pnpm shortcut command (recommended)
pnpm cli

# Or run directly
npx tsx cli.ts
```

**Features**:
- ✅ **Interactive Menu** - Clear categorization and numbering for easy selection
- ✅ **Auto Execution** - Automatically runs corresponding commands after selection
- ✅ **Parameter Prompts** - Scripts requiring additional parameters will prompt for input
- ✅ **Private Key Detection** - Automatically detects if private key is needed and prompts
- ✅ **Beautiful Interface** - Colorful output, clear and readable

### 📌 Command List Viewing Tool

Quickly view detailed information about all available commands.

```bash
# Use pnpm shortcut command (recommended)
pnpm run list               # Display all commands (Examples + Scripts)


# Or run directly (no pnpm needed)
npx tsx list-commands.ts
```

**Features**:

- ✅ **Beautiful Interface**: Uses colorful output, clear and readable
- ✅ **Categorized Display**: Examples grouped by category, Scripts grouped by functional modules
- ✅ **Complete Information**: Shows description, usage, and authentication requirements for each command
- ✅ **Quick Reference**: Provides quick reference mode for common commands

### Output Example

Running `pnpm run list` will display:

- **Examples Section**: Grouped by category (read-only operations, trading operations, on-chain operations, arbitrage detection, arbitrage execution)
- **Scripts Section**: Grouped by functional modules (approvals, deposits, trading, wallet, arbitrage, etc.)
- **Quick Reference**: Quick list of common commands

Each command will display:
- 📝 Function description
- 💻 Run command (both pnpm and npx tsx methods)
- 🔐 Whether private key authentication is required

---

## 📚 Example Details

### Example Categories

| Category | Example Numbers | Requires Auth | Description |
|----------|----------------|---------------|-------------|
| **Read-only Operations** | 01-07 | ❌ No | Market data, analysis, WebSocket |
| **Trading Operations** | 08-09 | ✅ Yes | Order placement, order management, rewards tracking |
| **On-chain Operations** | 10 | ✅ Yes | Split/Merge/Redeem (requires USDC.e) |
| **Arbitrage Detection** | 11 | ❌ No | Scan arbitrage opportunities (basic version) |
| **Arbitrage Monitoring** | 12 🚀 | ❌ No | Production-grade arbitrage monitoring (continuous monitoring) |
| **Arbitrage Execution** | 13 🚀 | ✅ Yes | Production-grade arbitrage service (complete workflow) |

> 🚀 Mark indicates production-grade version with complete error handling, logging, monitoring, etc.

### Detailed Example Descriptions

#### 01 - Basic Usage (`01-basic-usage.ts`)

**Function**: Get trending markets, market details, and orderbook data

**Run**:
```bash
pnpm example:basic
```

**Output Example**:
- Trending markets list
- Market details (question, condition ID, token ID, prices)
- Orderbook data

**Code Highlights**:
```typescript
const sdk = new PolymarketSDK();
const trendingMarkets = await sdk.gammaApi.getTrendingMarkets(5);
const unifiedMarket = await sdk.getMarket(marketSlug);
const orderbook = await sdk.getOrderbook(conditionId);
```

---

#### 02 - Smart Money Analysis (`02-smart-money.ts`)

**Function**: Analyze wallet trading performance, identify high-return traders

**Run**:
```bash
pnpm example:smart-money
```

**Features Include**:
- Get top traders
- Calculate wallet P&L and win rate
- Identify high-performing wallets

---

#### 03 - Market Analysis (`03-market-analysis.ts`)

**Function**: Search and analyze markets

**Run**:
```bash
pnpm example:market-analysis
```

**Features Include**:
- Keyword search
- Filter by volume, liquidity
- Market spread analysis

---

#### 04 - K-line Aggregation (`04-kline-aggregation.ts`)

**Function**: Get price history data for chart display

**Run**:
```bash
pnpm example:kline
```

**Features Include**:
- Multi-timeframe candlesticks (1m, 5m, 1h, 1d)
- OHLCV data
- YES/NO dual token price tracking

---

#### 05 - Copy Trading Strategy (`05-follow-wallet-strategy.ts`)

**Function**: Simulate copy trading based on smart money signals

**Run**:
```bash
pnpm example:follow-wallet
```

**Features Include**:
- Monitor wallet activity
- Generate trading signals
- Backtest strategy performance

---

#### 06 - Services Demo (`06-services-demo.ts`)

**Function**: Demonstrate high-level service abstractions

**Run**:
```bash
pnpm example:services
```

**Features Include**:
- `WalletService` - Wallet analysis assistant
- `MarketService` - Market data aggregation

---

#### 07 - Real-time WebSocket (`07-realtime-websocket.ts`)

**Function**: Real-time market data streaming using `RealtimeServiceV2`

**Run**:
```bash
pnpm example:realtime
```

**Features Include**:
- Connect to Polymarket WebSocket (official client)
- Real-time orderbook updates
- Price change events
- Latest trade notifications
- Cryptocurrency price subscriptions (BTC, ETH)

**Code Example**:
```typescript
import { RealtimeServiceV2 } from '@catalyst-team/poly-sdk';

const realtime = new RealtimeServiceV2({ debug: false });
realtime.connect();

realtime.once('connected', () => {
  const sub = realtime.subscribeMarket(yesTokenId, noTokenId, {
    onOrderbook: (book) => console.log('Book:', book),
    onPriceUpdate: (update) => console.log('Price:', update),
  });
});
```

---

#### 08 - Trading Orders (`08-trading-orders.ts`) ⚠️ Requires Private Key

**Function**: Trading operations using `TradingService`

**Run**:
```bash
# Make sure POLYMARKET_PRIVATE_KEY is configured
pnpm example:trading
```

**Features Include**:
- Market data: `getMarket()`, `getOrderbook()`, `getPricesHistory()`
- Create limit/market orders: `createLimitOrder()`, `createMarketOrder()`
- Cancel orders: `cancelOrder()`, `cancelAllOrders()`
- Query order status: `getOpenOrders()`, `getTrades()`
- Rewards: `getCurrentRewards()`, `isOrderScoring()`

**Order Types**:
- **GTC** (Good Till Cancelled): Valid until cancelled
- **GTD** (Good Till Date): Valid until specified time
- **FOK** (Fill Or Kill): Fill completely or cancel
- **FAK** (Fill And Kill): Partial fill is acceptable

⚠️ **Note**: This example will not execute real trades by default; you need to uncomment the relevant code.

---

#### 09 - Rewards Tracking (`09-rewards-tracking.ts`) ⚠️ Requires Private Key

**Function**: Track liquidity provider rewards using `TradingService`

**Run**:
```bash
pnpm example:rewards
```

**Features Include**:
- Find markets with active rewards
- Check if orders are scoring
- Track daily earnings

---

#### 10 - CTF Operations (`10-ctf-operations.ts`) ⚠️ Requires Private Key + USDC.e

**Function**: On-chain token operations

**Run**:
```bash
# Make sure POLY_PRIVKEY is configured and wallet has USDC.e
pnpm example:ctf
```

**Important Note**: Use **USDC.e** (not native USDC)

| Token | Address | CTF Compatible |
|-------|---------|----------------|
| USDC.e | `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` | ✅ Yes |
| Native USDC | `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359` | ❌ No |

**Operation Types**:
- **Split**: USDC.e → YES + NO tokens
- **Merge**: YES + NO → USDC.e (arbitrage profit)
- **Redeem**: Winning tokens → USDC.e

---

#### 11 - Live Arbitrage Scan (`11-live-arbitrage-scan.ts`)

**Function**: Scan markets for arbitrage opportunities (read-only)

**Run**:
```bash
pnpm example:live-arb
```

**Features Include**:
- Get active markets
- Calculate effective prices
- Detect long/short arbitrage opportunities

---

#### 12 - Trending Arbitrage Monitor (`12-trending-arb-monitor.ts`) 🚀 Production-Grade

**Function**: Production-grade arbitrage monitoring service that continuously monitors trending markets for arbitrage opportunities

**Run**:
```bash
pnpm example:trending-arb
# Or
npx tsx examples/12-trending-arb-monitor.ts
```

**Production-Grade Features**:
- ✅ Structured logging system (JSON format, supports log levels)
- ✅ Configuration validation (validates all environment variables on startup)
- ✅ Error handling and retry mechanisms (exponential backoff)
- ✅ Metrics collection (monitors scan performance, opportunity detection, etc.)
- ✅ Result persistence (optional save to file)
- ✅ Graceful shutdown (saves state, cleans up resources)

**Features Include**:
- Real-time orderbook analysis
- Correct effective price calculation
- Configurable scan intervals
- Continuous monitoring of trending markets
- Automatic arbitrage opportunity detection and reporting

**Environment Variables**:
```bash
export SCAN_INTERVAL_MS=5000          # Scan interval (milliseconds)
export MIN_PROFIT_THRESHOLD=0.1       # Minimum profit threshold (%)
export MAX_MARKETS=20                 # Maximum markets to monitor
export MAX_CYCLES=0                   # Maximum scan cycles (0=unlimited)
export LOG_LEVEL=INFO                 # Log level
export RESULTS_FILE=./results.json     # Results save file (optional)
```

---

#### 13 - Complete Arbitrage Service (`13-arbitrage-service.ts`) 🚀 Production-Grade ⚠️ Requires Private Key

**Function**: Production-grade arbitrage service with complete arbitrage workflow, including automatic execution

**Run**:
```bash
pnpm example:arb-service
# Or
npx tsx examples/13-arbitrage-service.ts
# Scan mode (no trading)
npx tsx examples/13-arbitrage-service.ts --scan-only
# Custom runtime duration
npx tsx examples/13-arbitrage-service.ts --duration=300
```

**Production-Grade Features**:
- ✅ Structured logging system
- ✅ Configuration validation and trading limits
- ✅ Error handling and retry mechanisms
- ✅ Trading safety measures (daily limits, per-trade limits, balance checks)
- ✅ Metrics collection and monitoring
- ✅ Graceful shutdown and state saving

**Features Include**:
- **ArbitrageService**: High-level API for arbitrage detection and execution
- Market scanning with configurable conditions
- Real-time WebSocket monitoring
- Automatic execution with profit thresholds
- Position liquidation and settlement
- Automatic position rebalancing

**Environment Variables**:
```bash
export POLYMARKET_PRIVATE_KEY=0x...   # Private key (required)
export POLYGON_RPC_URL=https://...    # RPC URL (optional)
export PROFIT_THRESHOLD=0.005         # Minimum profit threshold (0.5%)
export MIN_TRADE_SIZE=5               # Minimum trade size (USDC)
export MAX_TRADE_SIZE=100             # Maximum trade size (USDC)
export DAILY_TRADE_LIMIT=1000         # Daily trade limit (USDC)
export SCAN_INTERVAL_MS=5000          # Scan interval (milliseconds)
export LOG_LEVEL=INFO                 # Log level
```

---

## 🛠️ Using Utility Scripts

> 💡 **Tip**: Not sure which script to run? Use `pnpm run list:scripts` to view a detailed list of all available scripts.

The `scripts/` directory contains a series of utility scripts for real trading operations, testing, and verification. These scripts are more complete and practical than the examples in `examples/` and can be used directly in production environments.

### Scripts Directory Structure

```
scripts/
├── approvals/          # Token approval scripts
├── deposit/            # USDC deposits and swaps
├── trading/           # Order and position management
├── wallet/            # Wallet balance and verification
├── verify/            # API verification tests
├── dip-arb/           # Dip arbitrage auto-trading
├── smart-money/       # Smart money tracking and copy trading
├── arb/               # Arbitrage tools
├── research/          # Market research and analysis
└── benchmark/         # Performance benchmarking
```

### Running Scripts

All scripts are run directly via `tsx`:

```bash
# Method 1: Use environment variables (recommended)
npx tsx scripts/xxx/script.ts

# Method 2: Pass environment variables inline
POLYMARKET_PRIVATE_KEY=0xYourPrivateKey npx tsx scripts/xxx/script.ts
```

### Main Script Categories

#### 1. Setup Scripts

##### `approvals/` - Token Approvals

Before starting to trade, you need to approve tokens to Polymarket contracts:

```bash
# Check all approval statuses
npx tsx scripts/approvals/check-all-allowances.ts

# Check USDC approval
npx tsx scripts/approvals/check-allowance.ts

# Check CTF/ERC1155 approval (important!)
npx tsx scripts/approvals/check-ctf-approval.ts

# Approve USDC to CTF Exchange
npx tsx scripts/approvals/check-allowance.ts approve

# Approve ERC1155 tokens (for trading YES/NO tokens)
npx tsx scripts/approvals/approve-erc1155.ts
```

**Important Note**: If not properly approved, orders will fail with "not enough balance / allowance".

##### `deposit/` - Deposits & Swaps

```bash
# Check deposit address and balance
npx tsx scripts/deposit/deposit-native-usdc.ts check

# Deposit native USDC via Bridge (auto-converts to USDC.e)
npx tsx scripts/deposit/deposit-native-usdc.ts deposit 50

# Swap native USDC to USDC.e (if you already have native USDC)
npx tsx scripts/deposit/swap-usdc-to-usdce.ts
```

**Important Note**: Polymarket CTF operations require **USDC.e**, not native USDC!

| Token | Address | CTF Compatible |
|-------|---------|----------------|
| USDC.e | `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` | ✅ Yes |
| Native USDC | `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359` | ❌ No |

#### 2. Trading Management Scripts

##### `trading/` - Order and Position Management

```bash
# View current orders and trade history
npx tsx scripts/trading/check-orders.ts

# Test order placement (GTC vs FOK)
npx tsx scripts/trading/test-order.ts
```

##### `wallet/` - Wallet Management

```bash
# Check wallet balances (USDC, MATIC, tokens, etc.)
npx tsx scripts/wallet/check-wallet-balances.ts

# Verify wallet tools
npx tsx scripts/wallet/verify-wallet-tools.ts

# Test wallet operations
npx tsx scripts/wallet/test-wallet-operations.ts
```

#### 3. Strategy Scripts

##### `dip-arb/` - Dip Arbitrage Auto-Trading

Dip arbitrage strategy for Polymarket 15-minute cryptocurrency UP/DOWN markets:

```bash
# Run ETH dip arbitrage (default)
npx tsx scripts/dip-arb/auto-trade.ts --eth

# Run BTC dip arbitrage
npx tsx scripts/dip-arb/auto-trade.ts --btc

# Run SOL dip arbitrage
npx tsx scripts/dip-arb/auto-trade.ts --sol

# Run XRP dip arbitrage
npx tsx scripts/dip-arb/auto-trade.ts --xrp

# Custom parameters
npx tsx scripts/dip-arb/auto-trade.ts --xrp --dip=0.35 --target=0.90 --shares=50

# Redeem positions from ended markets
npx tsx scripts/dip-arb/redeem-positions.ts
```

**Strategy Principle**:
- Detect price dips (e.g., 30% drop)
- Buy the dip side (Leg1)
- Wait for opposite side price to drop, then buy (Leg2)
- Lock profit: UP + DOWN = $1

**Log Files**: Each market generates a separate log file, stored in `/tmp/dip-arb-logs/`

##### `smart-money/` - Smart Money Tracking and Copy Trading

```bash
# E2E test: Full copy trading flow verification
npx tsx scripts/smart-money/01-e2e.ts

# Low-level test: Direct WebSocket + Trading API
npx tsx scripts/smart-money/02-e2e-low-level.ts

# Auto copy trading (full features)
npx tsx scripts/smart-money/04-auto-copy-trading.ts

# Simplified auto copy trading
npx tsx scripts/smart-money/05-auto-copy-simple.ts

# Real trading test (⚠️ executes real trades)
npx tsx scripts/smart-money/06-real-copy-test.ts
```

##### `arb/` - Arbitrage Tools

```bash
# Settle positions (after market ends)
npx tsx scripts/arb/settle-position.ts

# Execute merge operation
npx tsx scripts/arb/settle-position.ts --merge

# Settle specific market
npx tsx scripts/arb/settle-position.ts --merge --market map1

# Token rebalancer (maintain USDC/Token ratio)
npx tsx scripts/arb/token-rebalancer.ts
```

#### 4. Testing and Verification Scripts

##### `verify/` - API Verification

```bash
# Verify all API endpoints are working
npx tsx scripts/verify/verify-all-apis.ts

# Test trading approvals
npx tsx scripts/verify/test-approve-trading.ts

# Test Provider fixes
npx tsx scripts/verify/test-provider-fix.ts
```

##### `research/` - Market Research

```bash
# Find arbitrage and market making opportunities
npx tsx scripts/research/research-markets.ts
```

### Complete Usage Flow Examples

#### Scenario 1: First-Time Use - Prepare Trading Environment

```bash
# 1. Check wallet balances
npx tsx scripts/wallet/check-wallet-balances.ts

# 2. Deposit USDC (if needed)
npx tsx scripts/deposit/deposit-native-usdc.ts deposit 100

# 3. Check approval status
npx tsx scripts/approvals/check-all-allowances.ts

# 4. Approve tokens (if needed)
npx tsx scripts/approvals/check-ctf-approval.ts approve
npx tsx scripts/approvals/approve-erc1155.ts

# 5. Verify API connection
npx tsx scripts/verify/verify-all-apis.ts
```

#### Scenario 2: Execute Dip Arbitrage Strategy

```bash
# 1. Start auto-trading (ETH markets)
npx tsx scripts/dip-arb/auto-trade.ts --eth

# 2. View logs (in another terminal)
tail -f /tmp/dip-arb-logs/eth-updown-15m-*.log

# 3. After market ends, redeem positions
npx tsx scripts/dip-arb/redeem-positions.ts
```

#### Scenario 3: Smart Money Copy Trading

```bash
# 1. Test first (dry run mode)
# Edit scripts/smart-money/04-auto-copy-trading.ts, set DRY_RUN = true
npx tsx scripts/smart-money/04-auto-copy-trading.ts

# 2. After confirmation, set DRY_RUN = false to execute real trades
npx tsx scripts/smart-money/04-auto-copy-trading.ts
```

#### Scenario 4: Daily Management

```bash
# View current orders
npx tsx scripts/trading/check-orders.ts

# Check balances
npx tsx scripts/wallet/check-wallet-balances.ts

# Research market opportunities
npx tsx scripts/research/research-markets.ts
```

### Scripts Detailed Documentation

For more detailed documentation on scripts, please see:
- [scripts/README.md](scripts/README.md) - Complete scripts documentation
- [scripts/dip-arb/README.md](scripts/dip-arb/README.md) - Dip arbitrage strategy documentation
- [scripts/smart-money/README.md](scripts/smart-money/README.md) - Smart money copy trading documentation

### Production-Grade Example Notes

Examples 12-13 are **production-grade versions** with complete production environment features and can be used directly for production deployment.

**Production-Grade Features** (Examples 12-13):
- ✅ Structured logging system (JSON format, supports log levels)
- ✅ Configuration validation (validates all environment variables on startup)
- ✅ Error handling and retry mechanisms (exponential backoff)
- ✅ Trading limits and safety checks (Example 13)
- ✅ Metrics collection and monitoring
- ✅ Graceful shutdown and state saving

**Differences from Regular Examples**:

| Feature | Regular Examples (01-11) | Production-Grade Examples (12-13) |
|---------|-------------------------|----------------------------------|
| Logging | console.log | Structured JSON logging |
| Error Handling | Basic try-catch | Retry + exponential backoff |
| Configuration | Environment variables | Validation + defaults |
| Trading Safety | None | Limits + balance checks |
| Monitoring | None | Built-in metrics |
| Shutdown | Basic | Graceful cleanup |

> 💡 **Tip**: For arbitrage-related features, we recommend directly using Examples 12-13 (production-grade versions), which already include all features needed for production environments. For detailed usage, please refer to the example descriptions above.

---

## 🔍 Arbitrage Concept Explanation

Polymarket orderbooks have mirroring properties:
- **Buying YES @ P = Selling NO @ (1-P)**

Correct effective price calculation:
```
effectiveBuyYes = min(YES.ask, 1 - NO.bid)
effectiveBuyNo = min(NO.ask, 1 - YES.bid)
effectiveSellYes = max(YES.bid, 1 - NO.ask)
effectiveSellNo = max(NO.bid, 1 - YES.ask)
```

| Arbitrage Type | Condition | Action |
|----------------|-----------|--------|
| Long | `effectiveBuyYes + effectiveBuyNo < 1` | Buy both, merge to get $1 |
| Short | `effectiveSellYes + effectiveSellNo > 1` | Split $1, sell both |

---

## ❓ Common Questions

### Q1: How to use automated installation scripts?

**A**: The project provides two automated installation scripts:

**Linux/macOS**:
```bash
bash install.sh
```

**Windows** (requires administrator privileges):
```powershell
Set-ExecutionPolicy Bypass -Scope CurrentUser
.\install.ps1
```

The scripts will automatically install:
- System dependencies
- Node.js LTS
- pnpm
- Automatically apply environment variable configuration
- Verify installation results

**Common Issues**:
- **Linux/macOS**: If pnpm is not detected after installation, run `source ~/.bashrc` or `source ~/.zshrc`, or reopen the terminal
- **Windows**: Must run PowerShell as Administrator; if pnpm is not detected, restart PowerShell or manually run `npm install -g pnpm`
- If the script fails, you can manually install dependencies:
  - **Node.js**: Visit https://nodejs.org/ to download LTS version
  - **pnpm**: Run `npm install -g pnpm` or use `corepack enable && corepack prepare pnpm@latest --activate`

### Q2: How to get a private key?

**A**: The private key is your wallet private key, which can be exported from wallets like MetaMask. ⚠️ **Never share your private key**.

### Q3: Why do some examples require a private key?

**A**: The following operations require private key signing:
- Order placement (Example 08)
- On-chain operations (Example 10)
- Arbitrage execution (Example 13)

Read-only operations (market data, analysis) do not require a private key.

### Q4: How to distinguish USDC.e from native USDC?

**A**: 
- **USDC.e**: `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` - Used for CTF operations
- **Native USDC**: `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359` - Cannot be used for CTF

### Q5: "Module not found" error when running examples?

**A**: 
```bash
# Make sure dependencies are installed
pnpm install

# Make sure project is built
pnpm run build
```

### Q6: TypeScript type errors?

**A**: 
```bash
# Rebuild project
pnpm run build

# Check TypeScript version
npx tsc --version
```

### Q7: How to modify example code?

**A**: 
1. Directly edit `.ts` files in the `examples/` directory
2. Use `npx tsx` to run the modified file
3. Or use `pnpm example:xxx` to run (if script is configured)

### Q8: Will examples execute real trades?

**A**: 
- Examples 08, 10, 13 **may** execute real trades (depending on whether code is uncommented)
- Other examples are read-only operations
- **Recommendation**: Test on testnet or with small amounts first

### Q9: How to view all available pnpm scripts?

**A**: 
```bash
# View scripts in package.json
cat package.json | grep -A 20 '"scripts"'

# Or use pnpm
pnpm run

# Or use command list tool (recommended)
pnpm run list
```

### Q10: How to use the command list tool?

**A**: The project provides a CLI tool to quickly view all available commands:

```bash
# Display all commands
pnpm run list

# Display only Examples
pnpm run list:examples

# Display only Scripts
pnpm run list:scripts

# Quick reference
pnpm run list:quick
```

This tool displays all commands in a beautiful format, including:
- Function description
- Run command (both pnpm and npx tsx methods)
- Whether private key authentication is required
- Parameter descriptions (if any)

### Q11: What's the difference between Examples and Scripts?

**A**: 
- **Examples** (`examples/`): Tutorial examples demonstrating basic SDK usage, simple and clear code
- **Scripts** (`scripts/`): Utility tools with complete workflows, can be used directly in production environments

Recommendations:
- Learning SDK → Use `examples/`
- Actual trading → Use `scripts/`

### Q12: How to run Scripts?

**A**: 
```bash
# Set environment variables
export POLYMARKET_PRIVATE_KEY=0xYourPrivateKey

# Run script
npx tsx scripts/xxx/script.ts

# Or pass inline
POLYMARKET_PRIVATE_KEY=0xYourPrivateKey npx tsx scripts/xxx/script.ts
```

### Q13: Will Scripts execute real trades?

**A**: 
- **Yes**! Scripts are production-grade tools and will execute real trades
- **Recommendations**:
  1. Test with small amounts first
  2. Carefully read script comments and documentation
  3. Some scripts have `DRY_RUN` mode for testing first

### Q14: How to view detailed Scripts documentation?

**A**: 
- View `scripts/README.md` for complete list
- View README files in subdirectories (e.g., `scripts/dip-arb/README.md`)
- View comments in script files

---

## 📖 More Resources

- **Complete Documentation**: See [README.md](README.md) 
- **API Reference**: See [docs/02-API.md](docs/02-API.md)
- **Architecture Design**: See [docs/00-design.md](docs/00-design.md)
- **Arbitrage Explanation**: See [docs/01-polymarket-orderbook-arbitrage.md](docs/01-polymarket-orderbook-arbitrage.md)
- **Scripts Documentation**: See [scripts/README.md](scripts/README.md)
- **Examples Documentation**: See [examples/README.md](examples/README.md)

---

## 🆘 Get Help

If you encounter issues:

1. Check [GitHub Issues](https://github.com/catalyst-team/poly-sdk/issues)
2. Read [Complete Documentation](README.md)
3. Check comments in example code

---

## 📝 License

MIT License - See [LICENSE](LICENSE) file for details

---

☕ **Buy me a coffee (EVM):** `0xd9c5d6111983ea3692f1d29bec4ac7d6f723217a`

**Happy coding!** 🚀

