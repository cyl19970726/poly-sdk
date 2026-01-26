# Fix SDK Polling Fill Event Generation (Issue #7)

## Problem

Polling mode in OrderManager wasn't emitting fill events when orders were filled. It only emitted status change events, making it difficult for consumers to detect and track fills when WebSocket was unavailable.

## Root Cause

The `updateWatchedOrder()` method only compared order status changes but ignored changes in `filledSize`. When an order's filled size increased (indicating a new fill), no fill event was emitted.

## Solution

### 1. Enhanced `updateWatchedOrder()` Method

**Location**: `packages/poly-sdk/src/services/order-manager.ts:718-773`

Added fill detection logic:
- Compare `oldFilledSize` vs `newFilledSize`
- Calculate fill delta when size increases
- Emit `order_partially_filled` or `order_filled` events based on completion status
- Include fill details: size, price, tradeId, timestamp

**Key Features**:
- **Fill Delta Calculation**: Only emits the incremental fill, not cumulative
- **Deduplication**: Uses event key `fill_{orderId}_{newFilledSize}` to prevent duplicates
- **Price Estimation**: Uses order price as estimate (OpenOrder API doesn't provide avgFillPrice)
- **TradeId Handling**: Uses last associateTrade or generates synthetic `polling_{timestamp}`

### 2. Prevented Duplicate Emissions

**Location**: `packages/poly-sdk/src/services/order-manager.ts:783-788`

Modified `emitStatusChange()` to accept `fillAlreadyEmitted` parameter:
- When polling detects a fill, it sets this flag to `true`
- Prevents duplicate fill events when status transitions to `FILLED`
- Maintains backward compatibility for WebSocket path

## Changes Made

### Modified Files

1. **packages/poly-sdk/src/services/order-manager.ts**
   - Enhanced `updateWatchedOrder()` with fill detection (lines 718-773)
   - Updated `emitStatusChange()` signature with deduplication flag (lines 783-788)

2. **packages/poly-sdk/src/services/order-manager.test.ts** (NEW)
   - Comprehensive test suite covering fill detection
   - Tests for partial fills, complete fills, multiple fills
   - Edge case tests (no fills, instant fills, no tradeIds)
   - Deduplication tests for hybrid mode

## Test Coverage

### Test Scenarios

✅ **Fill Detection**
- Single partial fill detection
- Complete fill detection
- Multiple sequential fills
- Fill event deduplication

✅ **Fill Event Details**
- Correct delta calculation
- Price estimation from order
- TradeId extraction/generation
- Cumulative and remaining sizes

✅ **Status + Fill Events**
- Both events emit correctly
- No duplication between sources

✅ **Edge Cases**
- No fill changes (stable fillSize)
- Missing associateTrades array
- Instant complete fills (0 → 100%)
- Orders starting with existing fills

✅ **WebSocket + Polling Deduplication**
- Hybrid mode doesn't duplicate fills
- Event key deduplication works

### Test Results

```
 Test Files  1 passed (1)
      Tests  10 passed (10)
   Duration  4.46s
```

## API Changes

### No Breaking Changes

All changes are backward compatible. The existing API surface remains unchanged:

```typescript
// Existing event listeners work as before
orderManager.on('order_filled', (event: FillEvent) => {
  console.log(`Filled: ${event.fill.size} @ ${event.fill.price}`);
});

orderManager.on('order_partially_filled', (event: FillEvent) => {
  console.log(`Partial fill: ${event.fill.size} shares`);
});
```

### Enhanced Behavior

**Before**: Polling mode only emitted status changes
```typescript
// Only received status_change events
orderManager.on('status_change', (event) => {
  // Had to manually detect fills from status
});
```

**After**: Polling mode emits both status and fill events
```typescript
// Now receives dedicated fill events
orderManager.on('order_partially_filled', (event) => {
  console.log(`New fill: ${event.fill.size} shares`);
  console.log(`Total filled: ${event.cumulativeFilled}`);
  console.log(`Remaining: ${event.remainingSize}`);
});
```

## Implementation Notes

### Fill Price Estimation

The CLOB API's `OpenOrder` type doesn't include `avgFillPrice`, so we use the order's limit price as an estimate. This is acceptable because:

1. **Limit orders**: Fill at or better than limit price
2. **Polling context**: Price accuracy is less critical than WebSocket (which has actual trade data)
3. **Use case**: Most consumers care about fill detection, not exact price in polling mode

For exact fill prices, consumers should:
- Use WebSocket mode (provides actual trade prices)
- Query trade history via `getTrades()` method

### Deduplication Strategy

Two-level deduplication:

1. **Intra-source**: Within polling, uses `processedEvents` Set with key format `fill_{orderId}_{filledSize}`
2. **Inter-source**: Between polling and WebSocket, the same Set prevents duplicates in hybrid mode

Event keys persist in memory for the lifetime of the OrderManager instance.

## Migration Guide

### For Polling Mode Users

No code changes required! Fill events now work automatically:

```typescript
const orderManager = new OrderManager({
  privateKey: '0x...',
  rateLimiter,
  cache,
  mode: 'polling', // or 'hybrid'
  pollingInterval: 5000,
});

// These now work in polling mode:
orderManager.on('order_partially_filled', handlePartialFill);
orderManager.on('order_filled', handleCompleteFill);
```

### For Hybrid Mode Users

No changes needed. Deduplication ensures fills are only emitted once, regardless of source.

## Performance Impact

- **Minimal**: Only adds two number comparisons per poll
- **Memory**: Adds one entry to `processedEvents` Set per fill
- **Network**: No additional API calls

## Future Improvements

1. **Average Fill Price**: If CLOB API adds `avgFillPrice` to OpenOrder, use it instead of limit price
2. **Fill History**: Consider storing fill events for replay/recovery
3. **Cleanup**: Implement `processedEvents` Set cleanup for long-running instances

## Related Issues

- Resolves Issue #7: "Polling mode doesn't emit fill events"
- Improves parity between WebSocket and Polling modes
- Enhances DipArb strategy fill detection reliability
