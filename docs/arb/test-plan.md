# ArbitrageService E2E Test Plan

> **Status**: In Progress
> **Date**: 2026-06-20
> **Author**: Claude Code

## Overview

This document outlines the comprehensive test plan for the ArbitrageService based on first principles understanding of the Polymarket arbitrage mechanism.

## First Principles: Understanding the Arbitrage Mechanism

### Core Concept: Mirror Orderbook

Polymarket orderbooks have a critical property that's often misunderstood:

```
Buy YES @ P = Sell NO @ (1-P)
```

This means complementary liquidity can be matched through the opposite outcome view. Naive addition of prices can double-count executable liquidity.

### Effective Prices

To correctly calculate arbitrage opportunities, we must use **effective prices**:

```typescript
// Long Arb (Buy both + Merge)
effectiveBuyYes = min(YES.ask, 1 - NO.bid)
effectiveBuyNo = min(NO.ask, 1 - YES.bid)
longCost = effectiveBuyYes + effectiveBuyNo
longProfit = 1 - longCost  // > 0 means arbitrage exists

// Short Arb (Split + Sell both)
effectiveSellYes = max(YES.bid, 1 - NO.ask)
effectiveSellNo = max(NO.bid, 1 - YES.ask)
shortRevenue = effectiveSellYes + effectiveSellNo
shortProfit = shortRevenue - 1  // > 0 means arbitrage exists
```

### Why We Need the Rebalancer

Arbitrage execution requires:
- **Long Arb**: pUSD to buy tokens
- **Short Arb**: YES + NO tokens to sell

The Rebalancer maintains the optimal ratio:
- pUSD < 20% → Merge tokens to recover pUSD
- pUSD > 80% → Split pUSD to create tokens

### Partial Fill Protection

When buying both YES and NO in parallel, one order might succeed while the other fails:
- `sizeSafetyFactor = 0.8` → Use only 80% of orderbook depth
- `autoFixImbalance = true` → Auto-sell excess if imbalance occurs
- `imbalanceThreshold = 5` → Trigger fix when YES-NO diff > $5

### Production Constraints

Arbitrage detection is only executable when it includes:
- depth-aware VWAP for the intended size, not just top-of-book
- net profit after CLOB platform fees and builder fees
- explicit data source freshness checks
- FOK/FAK or equivalent partial-fill protection
- post-only only for maker quoting, not immediate arbitrage execution
- NegRisk group validation before any multi-outcome sum strategy

---

## Test Hierarchy

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  Level 1: Unit Tests (No Network)                                            │
├─────────────────────────────────────────────────────────────────────────────┤
│  • getEffectivePrices() - Correct calculation of effective prices            │
│  • checkArbitrage() - Correct arbitrage detection                            │
│  • checkArbitrageWithFees() - Reject gross-only false positives               │
│  • estimateOrderFees() - Platform/builder fee math and rounding               │
│  • TradingService postOnly API passthrough and batch consistency              │
│  • no false positives from normal mirrored spread                             │
│  • VWAP/depth sizing for target notional                                      │
│  • calculateRebalanceAction() - Rebalance strategy logic                     │
├─────────────────────────────────────────────────────────────────────────────┤
│  Level 2: Integration Tests (Network, No Private Key)                        │
├─────────────────────────────────────────────────────────────────────────────┤
│  • scanMarkets() - Market scanning and filtering                             │
│  • WebSocket subscription - Real-time orderbook updates                      │
│  • checkOpportunity() - Opportunity detection with real data                 │
│  • getClobMarketInfo() fee config is loaded for executable candidates          │
│  • NegRisk group validation and stale/depth-missing rejection                 │
├─────────────────────────────────────────────────────────────────────────────┤
│  Level 3: E2E Tests (Real Market, With Private Key)                          │
├─────────────────────────────────────────────────────────────────────────────┤
│  • Wallet connection and balance query                                       │
│  • CTF Split/Merge operations                                                │
│  • Order execution (small amounts)                                           │
│  • FOK/FAK execution rejects unsafe partial fills                             │
│  • Rebalancer functionality                                                  │
│  • clearPositions() smart clearing                                           │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Test Cases

### Level 1: Unit Tests

#### Test 1.1: Effective Price Calculation
```typescript
// Input
yesAsk = 0.52, yesBid = 0.48
noAsk = 0.50, noBid = 0.46

// Expected
effectiveBuyYes = min(0.52, 1 - 0.46) = min(0.52, 0.54) = 0.52
effectiveBuyNo = min(0.50, 1 - 0.48) = min(0.50, 0.52) = 0.50
effectiveSellYes = max(0.48, 1 - 0.50) = max(0.48, 0.50) = 0.50
effectiveSellNo = max(0.46, 1 - 0.52) = max(0.46, 0.48) = 0.48
```

#### Test 1.2: Long Arbitrage Detection
```typescript
// Scenario: Long arb exists
yesAsk = 0.48, noAsk = 0.50, yesBid = 0.46, noBid = 0.48
longCost = 0.48 + 0.50 = 0.98 < 1.00
// Expected: longProfit = 0.02 (2%)
```

#### Test 1.3: Short Arbitrage Detection
```typescript
// Scenario: Short arb exists
yesBid = 0.52, noBid = 0.50, yesAsk = 0.54, noAsk = 0.52
shortRevenue = 0.52 + 0.50 = 1.02 > 1.00
// Expected: shortProfit = 0.02 (2%)
```

#### Test 1.4: No Arbitrage (Normal Market)
```typescript
// Normal efficient market
yesAsk = 0.52, yesBid = 0.48, noAsk = 0.52, noBid = 0.48
longCost ≈ 1.02-1.04
shortRevenue ≈ 0.96-0.98
// Expected: No arbitrage opportunity
```

#### Test 1.5: No False Positive From Mirrored Spread
```typescript
// Wide but normal mirrored market
yesBid = 0.40
yesAsk = 0.65
noAsk = 1 - yesBid // 0.60
noBid = 1 - yesAsk // 0.35

// Naive sums look far from 1:
askSum = 1.25
bidSum = 0.75

// Expected:
// longCost = 0.65 + 0.60 = 1.25, longProfit = -0.25
// shortRevenue = 0.40 + 0.35 = 0.75, shortProfit = -0.25
// checkArbitrage() returns null
```

#### Test 1.6: Depth-Aware VWAP
```typescript
// Target: buy 1000 YES
asks = [
  { price: 0.30, size: 5 },
  { price: 0.32, size: 1000 },
  { price: 0.35, size: 2000 },
]

// Expected:
// filled = 1000
// vwap = (0.30 * 5 + 0.32 * 995) / 1000 = 0.3199
// executable price is not 0.30
```

#### Test 1.7: Fee-Aware Arbitrage Rejection
```typescript
// Gross long candidate:
yesAsk = 0.495
noAsk = 0.495
grossProfitPerShare = 1 - (0.495 + 0.495) = 0.01

// With sports-style fee rate:
size = 10
feeRate = 0.03
estimatedFees ≈ 0.15
grossProfit = 0.10
netProfit ≈ -0.05

// Expected:
// checkArbitrage() may return a gross candidate
// checkArbitrageWithFees(..., { size, rate: 0.03 }) returns null
```

#### Test 1.8: Order Fee Estimate
```typescript
// 100 shares at 50c with fee rate 0.03:
platformFee = 100 * 0.03 * 0.5 * 0.5 = 0.75

// Expected:
// BUY totalCost = 50.75
// SELL netProceeds = 49.25
// Maker fill with takerOnly=true has platformFee = 0
```

#### Test 1.9: Post-Only API Passthrough
```typescript
// Expected:
// createLimitOrder({ orderType: 'GTC', postOnly: true }) calls
// client.createAndPostOrder(order, options, OrderType.GTC, true)
//
// presignLimitOrder({ postOnly: true }) stores postOnly in the PresignedOrder,
// and postPresignedOrder(presigned) calls client.postOrder(signed, orderType, true).
//
// createBatchOrders() rejects mixed postOnly values because CLOB postOrders()
// accepts a batch-level postOnly flag.
```

#### Test 1.10: Rebalance Action Calculation
```typescript
// Scenario: pUSD too low
usdc = 10, yesTokens = 80, noTokens = 80
usdcRatio = 10 / (10 + 80) = 0.11 < 0.20
// Expected: action = 'merge', reason = 'pUSD 11% < 20% min'

// Scenario: pUSD too high
usdc = 90, yesTokens = 10, noTokens = 10
usdcRatio = 90 / (90 + 10) = 0.90 > 0.80
// Expected: action = 'split', reason = 'pUSD 90% > 80% max'

// Scenario: Token imbalance
yesTokens = 60, noTokens = 45
imbalance = 15 > threshold(5)
// Expected: action = 'sell_yes', priority = 100 (highest)
```

---

### Level 2: Integration Tests

#### Test 2.1: Market Scanning
```typescript
const service = new ArbitrageService({ enableLogging: true });

const results = await service.scanMarkets({
  minVolume24h: 5000,
  limit: 20,
  feeAware: true,
  feeEstimateSize: 1,
  liquidityRole: 'taker'
}, 0.005);

// Verify:
// - Returns array of ScanResult
// - Each result has valid market config
// - Effective prices are calculated correctly
// - Default profitRate/profitPercent are net after estimated fees
// - grossProfitRate/netProfitRate/totalFees are populated
// - Any executable opportunity includes size and VWAP, not only top-of-book
// - Score is computed based on profit * volume
```

#### Test 2.2: WebSocket Monitoring
```typescript
const service = new ArbitrageService({ enableLogging: true });

// Find a market to monitor
const results = await service.quickScan(0, 1);
const market = results[0].market;

// Start monitoring (no private key = no execution)
await service.start(market);

// Wait for orderbook updates
await new Promise(resolve => setTimeout(resolve, 10000));

// Verify:
// - Orderbook state is populated
// - Events are emitted
const orderbook = service.getOrderbook();
// Should have bids/asks for both YES and NO
```

#### Test 2.3: Opportunity Detection
```typescript
// After monitoring for some time:
const opportunity = service.checkOpportunity();

// If opportunity exists:
// - type is 'long' or 'short'
// - profitRate > 0
// - recommendedSize respects config limits
// - description is accurate
// - stale or depth-missing books are rejected or marked nonExecutable
```

#### Test 2.4: NegRisk Group Validation
```typescript
const event = await gammaApi.getEvent(eventId);
const markets = event.markets;

// Verify before ΣYES strategy:
// - every market has negRisk === true
// - all markets share the same event / negRiskMarketId
// - outcome set includes the full mutually exclusive result space
// - resolution rules are consistent
// - ambiguous / void-prone markets are rejected
```

#### Test 2.5: Multi-Outcome Depth Check
```typescript
// For each market in a candidate NegRisk group:
// - load live orderbook for the YES token
// - load getClobMarketInfo(conditionId) for each leg's fd/mbf/tbf
// - compute VWAP for target size
// - use the thinnest leg to cap recommended size
// - compute net profit with estimateMultiLegArbitrageFees() plus gas/failure buffer

// Expected:
// - no opportunity is executable unless every leg has sufficient depth
// - profit is based on VWAP, not Gamma outcomePrices alone
// - positive gross ΣYES deviations can be rejected after fees
```

---

### Level 3: E2E Tests

#### Test 3.1: Wallet Connection
```typescript
const service = new ArbitrageService({
  privateKey: process.env.PRIVATE_KEY,
  enableLogging: true,
});

// Find a market
const results = await service.quickScan(0, 1);
await service.start(results[0].market);

// Verify:
const balance = service.getBalance();
console.log(`pUSD: ${balance.usdc}`);
console.log(`YES: ${balance.yesTokens}`);
console.log(`NO: ${balance.noTokens}`);

// Expected: All balance fields are populated
```

#### Test 3.2: CTF Split Operation
```typescript
import { CTFClient } from '@catalyst-team/poly-sdk';

const ctf = new CTFClient({
  privateKey: process.env.PRIVATE_KEY,
});

// Split a small amount
const splitResult = await ctf.split(conditionId, '5'); // $5 pUSD

// Verify:
// - txHash is returned
// - Balance now has 5 YES + 5 NO tokens
// - pUSD decreased by $5
```

#### Test 3.3: CTF Merge Operation
```typescript
// After split, merge back
const tokenIds = {
  yesTokenId: market.yesTokenId,
  noTokenId: market.noTokenId,
};

const mergeResult = await ctf.mergeByTokenIds(conditionId, tokenIds, '5');

// Verify:
// - txHash is returned
// - YES and NO tokens decreased by 5
// - pUSD increased by $5
```

#### Test 3.4: Order Execution
```typescript
// Buy a small amount of YES tokens
const buyResult = await tradingClient.createMarketOrder({
  tokenId: market.yesTokenId,
  side: 'BUY',
  amount: 5, // $5 pUSD notional
  orderType: 'FOK',
});

// Verify:
// - success is true
// - orderId is returned
// - Balance reflects the purchase
```

#### Test 3.5: Rebalancer
```typescript
const service = new ArbitrageService({
  privateKey: process.env.PRIVATE_KEY,
  enableRebalancer: true,
  minUsdcRatio: 0.2,
  maxUsdcRatio: 0.8,
  targetUsdcRatio: 0.5,
});

// Create imbalanced state (e.g., split all pUSD)
// Then let rebalancer run

// Verify:
// - Rebalance event is emitted
// - Balance moves toward target ratio
```

#### Test 3.6: Clear Positions
```typescript
// After some operations, clear all positions
const clearResult = await service.clearPositions(market, false);

console.log('Plan:', clearResult.actions);
console.log('Expected recovery:', clearResult.totalUsdcRecovered);

// If executing:
const executeResult = await service.clearPositions(market, true);
// - Merged tokens are recovered as pUSD
// - Unpaired tokens are sold
```

#### Test 3.7: Atomic Execution Guard
```typescript
// Submit a small multi-leg plan using FOK/FAK settings.
// Use a deliberately tight maxSlippageBps or oversized target to force rejection.

// Verify:
// - unsafe leg is cancelled/rejected
// - successful partial state is detected
// - auto-fix / clearPositions plan is produced if imbalance remains
// - no subsequent legs execute after minProfitAfterFees is violated
```

---

## Test Environment

### Configuration
```typescript
// .env file
PRIVATE_KEY=0x... // Test wallet private key

// Test parameters
MIN_TRADE_SIZE = 5     // Minimum $5 for safety
MAX_TRADE_SIZE = 20    // Maximum $20 for safety
PROFIT_THRESHOLD = 0   // Monitor all opportunities
```

### Safety Measures

1. **Small amounts only**: All tests use $5-20 amounts
2. **Monitor mode first**: Verify detection before execution
3. **High profit threshold**: Production should use 0.5%+
4. **Dry run first**: Use `execute = false` before real execution

---

## Execution Plan

### Phase 1: Unit Tests (No Network)
1. Create test file: `scripts/arb-tests/01-unit-tests.ts`
2. Test price utilities
3. Test rebalance logic
4. Verify all calculations match expected values

### Phase 2: Integration Tests (Network, No Execution)
1. Create test file: `scripts/arb-tests/02-integration-tests.ts`
2. Test market scanning
3. Test WebSocket monitoring
4. Verify opportunity detection on real data

### Phase 3: E2E Tests (Real Execution)
1. Create test file: `scripts/arb-tests/03-e2e-tests.ts`
2. Test wallet connection
3. Test CTF operations with small amounts
4. Test order execution with small amounts
5. Test clearPositions

### Phase 4: Full Flow Test
1. Create test file: `scripts/arb-tests/04-full-flow.ts`
2. Scan → Select → Monitor → Execute → Clear
3. Generate report

---

## Success Criteria

| Test Level | Criteria |
|------------|----------|
| Unit | All calculations match expected values |
| Unit | Mirrored spread scenarios do not produce false arbitrage |
| Unit | VWAP/depth sizing differs from top-of-book when first level is thin |
| Integration | Market scanning returns valid results |
| Integration | WebSocket receives orderbook updates |
| Integration | NegRisk groups are validated before multi-outcome pricing |
| Integration | Stale or incomplete orderbooks are not marked executable |
| E2E | Wallet balance is correctly queried |
| E2E | Split/Merge operations succeed |
| E2E | Order execution works |
| E2E | FOK/FAK guards prevent unsafe partial execution |
| E2E | clearPositions recovers funds |

---

## Risk Mitigation

1. **Financial Risk**: Test with small amounts ($5-20 max)
2. **Execution Risk**: Always dry-run first
3. **Network Risk**: Handle errors gracefully
4. **Timing Risk**: Use FOK/FAK orders to control partial fills
5. **Liquidity Risk**: Require depth-aware VWAP before execution
6. **Resolution Risk**: Validate NegRisk grouping and market rules

---

## Next Steps

1. [x] Create test plan document
2. [ ] Implement unit tests
3. [ ] Implement integration tests
4. [ ] Implement E2E tests
5. [ ] Generate test report
