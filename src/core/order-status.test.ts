import type { OpenOrder } from '@polymarket/clob-client-v2';
import { describe, expect, it } from 'vitest';
import {
  calculateOrderProgress,
  canOrderBeCancelled,
  isActiveStatus,
  isOrderOpen,
  isTerminalStatus,
  isValidStatusTransition,
  mapApiStatusToInternal,
  mapInternalStatusToApi,
} from './order-status.js';
import { OrderStatus } from './types.js';

function openOrder(status?: string, sizeMatched = '0', originalSize = '10'): OpenOrder {
  return {
    status,
    size_matched: sizeMatched,
    original_size: originalSize,
  } as unknown as OpenOrder;
}

describe('order status mapping', () => {
  it('maps matched orders by matched quantity', () => {
    expect(mapApiStatusToInternal(openOrder('matched', '10', '10'))).toBe(OrderStatus.FILLED);
    expect(mapApiStatusToInternal(openOrder('matched', '11', '10'))).toBe(OrderStatus.FILLED);
    expect(mapApiStatusToInternal(openOrder('matched', '4', '10'))).toBe(
      OrderStatus.PARTIALLY_FILLED,
    );
    expect(mapApiStatusToInternal(openOrder('matched', '0', '10'))).toBe(OrderStatus.OPEN);
  });

  it('does not infer full fill when original size is missing or invalid', () => {
    expect(mapApiStatusToInternal(openOrder('matched', '0', undefined as unknown as string))).toBe(
      OrderStatus.OPEN,
    );
    expect(mapApiStatusToInternal(openOrder('matched', '3', undefined as unknown as string))).toBe(
      OrderStatus.PARTIALLY_FILLED,
    );
    expect(mapApiStatusToInternal(openOrder('live', '3', 'not-a-number'))).toBe(
      OrderStatus.PARTIALLY_FILLED,
    );
    expect(mapApiStatusToInternal(openOrder('unmatched', '3', '0'))).toBe(
      OrderStatus.PARTIALLY_FILLED,
    );
  });

  it('maps live and unmatched as active order leaves', () => {
    expect(mapApiStatusToInternal(openOrder('LIVE', '0', '10'))).toBe(OrderStatus.OPEN);
    expect(mapApiStatusToInternal(openOrder('UnMatched', '0', '10'))).toBe(OrderStatus.OPEN);
    expect(mapApiStatusToInternal(openOrder(undefined, '0', '10'))).toBe(OrderStatus.OPEN);
  });

  it('uses fill quantity when active-looking API status reports fills', () => {
    expect(mapApiStatusToInternal(openOrder('live', '3', '10'))).toBe(
      OrderStatus.PARTIALLY_FILLED,
    );
    expect(mapApiStatusToInternal(openOrder('unmatched', '10', '10'))).toBe(
      OrderStatus.FILLED,
    );
  });

  it('maps delayed, cancelled, canceled, expired, and unknown statuses', () => {
    expect(mapApiStatusToInternal(openOrder('delayed', '0', '10'))).toBe(OrderStatus.PENDING);
    expect(mapApiStatusToInternal(openOrder('CANCELLED', '0', '10'))).toBe(
      OrderStatus.CANCELLED,
    );
    expect(mapApiStatusToInternal(openOrder('canceled', '0', '10'))).toBe(
      OrderStatus.CANCELLED,
    );
    expect(mapApiStatusToInternal(openOrder('expired', '0', '10'))).toBe(OrderStatus.EXPIRED);
    expect(mapApiStatusToInternal(openOrder('new-api-status', '0', '10'))).toBe(
      OrderStatus.OPEN,
    );
  });

  it('maps internal statuses back to Polymarket API status strings', () => {
    expect(mapInternalStatusToApi(OrderStatus.PENDING)).toBe('delayed');
    expect(mapInternalStatusToApi(OrderStatus.OPEN)).toBe('live');
    expect(mapInternalStatusToApi(OrderStatus.PARTIALLY_FILLED)).toBe('matched');
    expect(mapInternalStatusToApi(OrderStatus.FILLED)).toBe('matched');
    expect(mapInternalStatusToApi(OrderStatus.CANCELLED)).toBe('cancelled');
    expect(mapInternalStatusToApi(OrderStatus.EXPIRED)).toBe('expired');
    expect(mapInternalStatusToApi(OrderStatus.REJECTED)).toBe('rejected');
  });
});

describe('order status helpers', () => {
  it('classifies active, open, terminal, and cancelable states', () => {
    expect(isActiveStatus(OrderStatus.PENDING)).toBe(true);
    expect(isOrderOpen(OrderStatus.PARTIALLY_FILLED)).toBe(true);
    expect(canOrderBeCancelled(OrderStatus.PENDING)).toBe(false);
    expect(canOrderBeCancelled(OrderStatus.PARTIALLY_FILLED)).toBe(true);
    expect(isTerminalStatus(OrderStatus.FILLED)).toBe(true);
    expect(isTerminalStatus(OrderStatus.REJECTED)).toBe(true);
  });

  it('validates lifecycle transitions including partial-fill cancellation', () => {
    expect(isValidStatusTransition(OrderStatus.PENDING, OrderStatus.OPEN)).toBe(true);
    expect(isValidStatusTransition(OrderStatus.OPEN, OrderStatus.PARTIALLY_FILLED)).toBe(true);
    expect(isValidStatusTransition(OrderStatus.PARTIALLY_FILLED, OrderStatus.CANCELLED)).toBe(
      true,
    );
    expect(isValidStatusTransition(OrderStatus.FILLED, OrderStatus.CANCELLED)).toBe(false);
  });

  it('calculates fill progress defensively', () => {
    expect(calculateOrderProgress(10, 2.5)).toBe(25);
    expect(calculateOrderProgress(10, 15)).toBe(100);
    expect(calculateOrderProgress(0, 15)).toBe(0);
  });
});
