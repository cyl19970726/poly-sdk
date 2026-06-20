# Fees and Net-Profit APIs

> **Status**: Production Reference
> **Last Updated**: 2026-06-20

This SDK models Polymarket CLOB V2 fees explicitly for quotes, budgeting, and arbitrage checks. Before this change, the repo could read some fee metadata, but most quote and arbitrage examples used gross prices only. Gross helpers remain for compatibility; execution and alerts should use the fee-aware APIs below.

## Official Model

Polymarket applies fees at match time. You do not include platform fee fields in the signed order payload. For markets with fees enabled, CLOB market info exposes:

```typescript
const info = await client.getClobMarketInfo(conditionId);

// Platform fee curve
info.fd.r;  // fee rate, for example 0.03
info.fd.e;  // curve exponent
info.fd.to; // taker-only flag

// Builder/base fee bps returned by CLOB
info.mbf;   // maker bps
info.tbf;   // taker bps
```

Platform fee estimate:

```text
platformFee = size * feeRate * price * (1 - price)
```

The SDK keeps `fd.e` in the model because CLOB returns it, but current markets typically use exponent `1`, which reduces to the formula above. Platform fees are taker-only when `fd.to === true`. `mbf` / `tbf` are applied by the SDK only when a nonzero builder code is configured; in no-builder mode they are ignored. Builder fees, when present, are additive and calculated on notional:

```text
builderFee = price * size * builderFeeBps / 10000
```

Fees are rounded to 5 decimals and values below `0.00001` round to zero.

## Maker / Post-Only

Polymarket supports post-only limit orders through the order submission API. In this SDK, set `postOnly: true` on `TradingService.createLimitOrder()` or `presignLimitOrder()` when the intent is maker-only quoting:

```typescript
await trading.createLimitOrder({
  tokenId,
  side: 'BUY',
  price: 0.49,
  size: 10,
  orderType: 'GTC',
  postOnly: true,
});
```

Post-only only applies to GTC/GTD limit orders. If the price would cross the spread and match immediately, CLOB rejects the order. It cannot be combined with FOK/FAK market orders, so it is not a way to immediately capture an observed spread. In fee estimates, use `liquidityRole: 'maker'` only for orders you genuinely expect to rest on the book; executable arbitrage that takes liquidity should remain `liquidityRole: 'taker'`.

## TradingService

Use `TradingService` when you have token IDs and want live market fee parameters.

```typescript
const feeInfo = await trading.getMarketFeeInfo(yesTokenId, conditionId);

const buyEstimate = await trading.estimateOrderFees({
  conditionId,
  tokenId: yesTokenId,
  side: 'BUY',
  price: 0.197,
  size: 6,
  liquidityRole: 'taker',
});

console.log(buyEstimate.notional);
console.log(buyEstimate.platformFee);
console.log(buyEstimate.builderFee);
console.log(buyEstimate.totalCost);
```

For a two-leg binary arbitrage path:

```typescript
const net = await trading.estimateBinaryArbitrageFees({
  conditionId,
  yesTokenId,
  noTokenId,
  type: 'long',
  size: 10,
  yesPrice: 0.49,
  noPrice: 0.49,
  liquidityRole: 'taker',
});

console.log(net.grossProfit);
console.log(net.totalFees);
console.log(net.netProfit);
```

## MarketService

Use `MarketService` when you start from a condition ID and want orderbook analytics with fee-adjusted summary fields.

```typescript
const book = await markets.getFeeAwareProcessedOrderbook(conditionId, {
  size: 10,
  liquidityRole: 'taker',
});

console.log(book.summary.longArbProfit);              // gross, legacy field
console.log(book.summary.feeAdjusted?.long.netProfit); // net after estimated fees
```

For alerts or execution gates, prefer `detectArbitrageNet()`:

```typescript
const opportunity = await markets.detectArbitrageNet(conditionId, {
  size: 10,
  threshold: 0.05, // pUSD for the configured size
});

if (opportunity) {
  console.log(opportunity.netProfit);
  console.log(opportunity.totalFees);
}
```

`detectArbitrage()` remains a gross-price screen. It is useful for cheap filtering, but it is not sufficient as an execution signal.

## ArbitrageService Scanner

`ArbitrageService.scanMarkets()` is fee-aware by default for binary markets. It calls `MarketService.getFeeAwareProcessedOrderbook()`, so `profitRate` and `profitPercent` are net of estimated platform and builder fees unless you explicitly pass `feeAware: false`.

```typescript
const results = await arb.scanMarkets({
  minVolume24h: 5000,
  feeAware: true,       // default
  feeEstimateSize: 1,   // keeps minProfit as a per-share threshold
  liquidityRole: 'taker',
}, 0.005);

console.log(results[0]?.grossProfitRate);
console.log(results[0]?.netProfitRate);
console.log(results[0]?.totalFees);
```

Use `feeAware: false` only for a cheap gross screen. Do not treat gross scan results as executable signals.

The live WebSocket monitor is also fee-aware by default. `start(market)` loads the market fee config before subscribing, and `checkOpportunity()` gates on net profit when `feeAware` is enabled:

```typescript
const arb = new ArbitrageService({
  profitThreshold: 0.005,
  feeAware: true,       // default
  liquidityRole: 'taker',
});
```

If fee config cannot be loaded in fee-aware mode, startup fails instead of falling back to gross checks.

## Pure Utilities

The package root exports pure helpers for tests, simulations, and custom services:

```typescript
import {
  calculatePlatformFee,
  calculateBuilderFee,
  estimateOrderFees,
  estimateBinaryArbitrageFees,
  estimateMultiLegArbitrageFees,
  checkArbitrageWithFees,
} from '@catalyst-team/poly-sdk';
```

Example:

```typescript
const result = checkArbitrageWithFees(
  yesAsk,
  yesBid,
  noAsk,
  noBid,
  {
    size: 10,
    rate: 0.03,
    exponent: 1,
    takerOnly: true,
    liquidityRole: 'taker',
  }
);
```

For exhaustive multi-outcome or NegRisk candidates, aggregate each leg with its own fee config:

```typescript
const estimate = estimateMultiLegArbitrageFees({
  type: 'long',
  size: 10,
  legs: markets.map((market) => ({
    conditionId: market.conditionId,
    tokenId: market.yesTokenId,
    label: market.outcome,
    price: market.bestAsk,
    rate: market.fee.rate,
    exponent: market.fee.exponent,
    takerOnly: market.fee.takerOnly,
    makerBps: market.fee.builderMakerFeeBps,
    takerBps: market.fee.builderTakerFeeBps,
  })),
});
```

This helper only aggregates prices and fees. The scanner must still prove that the candidate group is mutually exclusive and exhaustive, including any "Other" or bracket rules.

## Execution Notes

Net arbitrage should be modeled as:

```text
netProfit = grossProfit - platformFees - builderFees - gasOrRelayerCost - slippageBuffer - failureRiskBuffer
```

The SDK helpers cover platform and builder fees. Execution code still needs to account for gas or relayer cost, VWAP by depth, tick size, minimum order size, stale data, partial fill risk, and settlement state.

Post-only maker quoting can avoid taker execution, but it also means the order may not fill when the visible spread exists now. Treat post-only as a quoting/risk-control mode, not as the execution mode for immediate arbitrage.

Live testing on 2026-06-20 showed why this matters: buying 6 France 2026 World Cup YES at `0.197` and selling 6 at `0.196` had only `0.006` pUSD of visible spread loss, but the round trip cost about `0.06283` pUSD after CLOB taker fees. Fees dominated the one-tick spread.

Also note that a filled buy response can arrive before the conditional token balance is sellable through every CLOB/Data/on-chain view. A sell retry should wait for balance visibility instead of assuming the immediate fill response implies reusable inventory.
