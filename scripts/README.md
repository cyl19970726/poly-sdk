# Poly-SDK Scripts

Utility scripts for testing and operating with Polymarket.

## Environment Setup

### Private Key Configuration

**Method 1: Using .env file (Recommended)**

Create a `.env` file in the `packages/poly-sdk/` directory:

```bash
cd packages/poly-sdk
cp .env.example .env
# Edit .env file and add your private key
```

`.env` file content:
```bash
PRIVATE_KEY=0x...your-private-key...
```

**Method 2: Pass as environment variable**

```bash
PRIVATE_KEY=0x... npx tsx scripts/ordermanager/quick-test.ts
```

⚠️ **Security Notes:**
- `.env` file is in `.gitignore` and will NOT be committed
- **NEVER** hardcode private keys in code files
- **NEVER** commit files containing private keys
- Use test wallets with minimal funds

---

## Directory Structure

```
scripts/
├── approvals/          # ERC20/ERC1155 approval scripts
├── deposit/            # USDC deposit and swap scripts
├── trading/            # Order and position management
├── wallet/             # Wallet balance and verification
├── verify/             # API verification tests
└── research/           # Market research and analysis
```

---

## Scripts Reference

### `approvals/` - Token Approvals

| Script | Description |
|--------|-------------|
| `check-allowance.ts` | Check USDC allowance for CTF Exchange |
| `check-all-allowances.ts` | Check all token allowances at once |
| `check-ctf-approval.ts` | Check CTF/ERC1155 approval status |
| `approve-neg-risk.ts` | Approve USDC for Neg Risk Exchange |
| `approve-erc1155.ts` | Approve ERC1155 for CTF Exchange |
| `approve-neg-risk-erc1155.ts` | Approve ERC1155 for Neg Risk Exchange |

```bash
# Check all allowances
npx tsx scripts/approvals/check-all-allowances.ts

# Approve for neg risk markets
npx tsx scripts/approvals/approve-neg-risk.ts
```

---

### `deposit/` - Deposits & Swaps

| Script | Description |
|--------|-------------|
| `deposit-native-usdc.ts` | Deposit Native USDC via Bridge |
| `deposit-usdc.ts` | Deposit USDC.e directly |
| `swap-usdc-to-usdce.ts` | Swap Native USDC → USDC.e on DEX |

```bash
# Check deposit address and status
npx tsx scripts/deposit/deposit-native-usdc.ts check

# Deposit $50 via Bridge
npx tsx scripts/deposit/deposit-native-usdc.ts deposit 50
```

**Important:** USDC.e is required for Polymarket CTF operations. Native USDC must be swapped or bridged first.

---

### `trading/` - Orders & Positions

| Script | Description |
|--------|-------------|
| `check-orders.ts` | View open orders and recent trades |
| `test-order.ts` | Test order placement |
| `sell-nvidia-positions.ts` | Sell specific positions |

```bash
# Check open orders
npx tsx scripts/trading/check-orders.ts

# Test order placement
npx tsx scripts/trading/test-order.ts
```

---

### `wallet/` - Wallet Management

| Script | Description |
|--------|-------------|
| `check-wallet-balances.ts` | Check all wallet balances |
| `verify-wallet-tools.ts` | Verify wallet MCP tools |
| `test-wallet-operations.ts` | Test wallet operations |

```bash
# Check balances
npx tsx scripts/wallet/check-wallet-balances.ts
```

---

### `verify/` - API Verification

| Script | Description |
|--------|-------------|
| `verify-all-apis.ts` | Verify all API endpoints |
| `test-search-mcp.ts` | Test MCP search tools |
| `test-approve-trading.ts` | Test trading approvals |

```bash
# Verify all APIs work
npx tsx scripts/verify/verify-all-apis.ts
```

---

### `research/` - Market Research

| Script | Description |
|--------|-------------|
| `research-markets.ts` | ARB/MM/Hybrid market analysis |

```bash
# Find arbitrage and MM opportunities
npx tsx scripts/research/research-markets.ts
```

---

## Important Concepts

### USDC Types

| Token | Address | Use |
|-------|---------|-----|
| USDC.e (Bridged) | `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` | **Required for CTF** |
| Native USDC | `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359` | Must swap to USDC.e |

### Effective Prices

Polymarket orderbooks have mirroring:
- Buying YES @ P = Selling NO @ (1-P)

```
effectiveBuyYes = min(YES.bestAsk, 1 - NO.bestBid)
effectiveBuyNo = min(NO.bestAsk, 1 - YES.bestBid)
```

### Arbitrage Detection

| Type | Condition | Action |
|------|-----------|--------|
| Long | `effectiveBuyYes + effectiveBuyNo < 1` | Buy both, merge |
| Short | `effectiveSellYes + effectiveSellNo > 1` | Split, sell both |

---

## Test Suites

### OrderManager Tests (`ordermanager/`)

Tests for unified order creation and lifecycle monitoring.

| Script | Description | USDC.e | Duration |
|--------|-------------|--------|----------|
| `quick-test.ts` | Create & cancel single order | ~1 USDC | ~20s |
| `minimal-loop-test.ts` | Loop test with minimal amounts | ~1.5 USDC | ~60s |
| `balanced-test.ts` | Balanced test for limited funds | ~1.64 USDC | ~40s |
| `smart-cycle-test.ts` | Buy → Sell cycle test | ~2 USDC | ~120s |
| `full-e2e.ts` | Complete order lifecycle | ~5 USDC | ~5min |

**Run tests:**
```bash
# Quick test (recommended first)
npx tsx scripts/ordermanager/quick-test.ts

# Minimal loop
npx tsx scripts/ordermanager/minimal-loop-test.ts

# Full E2E
npx tsx scripts/ordermanager/full-e2e.ts
```

### CTFManager Tests (`ctfmanager/`)

Tests for CTF operations (split/merge/redeem) with event monitoring.

| Script | Description | USDC.e | MATIC | Duration |
|--------|-------------|--------|-------|----------|
| `quick-test.ts` | Split → Merge cycle | ~2 USDC | ~0.1 | ~20s |
| `cycle-test.ts` | Multiple cycle stability | ~5 USDC | ~0.5 | ~60s |
| `full-e2e.ts` | Complete with Redeem | ~5 USDC | ~0.2 | 3min+ |

**Run tests:**
```bash
# Quick test (recommended first)
MARKET_CONDITION_ID=0x... \
PRIMARY_TOKEN_ID=123... \
SECONDARY_TOKEN_ID=456... \
npx tsx scripts/ctfmanager/quick-test.ts

# Cycle test
CYCLES=5 npx tsx scripts/ctfmanager/cycle-test.ts

# Full E2E (requires market settlement)
SKIP_REDEEM=false npx tsx scripts/ctfmanager/full-e2e.ts
```

**Note:** CTFManager tests are more economical than OrderManager tests because Split→Merge cycles recover 99.9% of funds (only Gas consumed).

**Detailed documentation:**
- OrderManager: [docs/guides/order-lifecycle.md](../docs/guides/order-lifecycle.md)
- CTFManager: [scripts/ctfmanager/README.md](./ctfmanager/README.md)
