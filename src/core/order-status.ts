/**
 * Order Status Mapping and Utilities
 *
 * Converts between Polymarket CLOB API states and internal OrderStatus enum.
 * Provides helper functions for status validation and state transitions.
 */

import type { OpenOrder } from '@polymarket/clob-client';
import { OrderStatus } from './types.js';

/**
 * ============================================================================
 * Polymarket API Status Mapping
 * ============================================================================
 *
 * Polymarket CLOB API returns these statuses in OpenOrder.status:
 * - "live"      - Order active in orderbook
 * - "matched"   - Order has fills (partial or complete)
 * - "delayed"   - Order submitted but not yet active (rare)
 * - "cancelled" - Order cancelled
 * - "expired"   - GTD order expired (rare)
 *
 * Edge Cases:
 * 1. "matched" → partially_filled vs filled
 *    Decision: Compare size_matched with original_size
 *    - size_matched < original_size → partially_filled
 *    - size_matched == original_size → filled
 *
 * 2. "live" with size_matched > 0
 *    Decision: This shouldn't happen (API inconsistency), treat as partially_filled
 *
 * 3. Missing status field
 *    Decision: Default to 'open' (most common case)
 */

export interface OrderStatusMapping {
  apiStatus: string;
  sizeMatched: number;
  originalSize: number;
  internalStatus: OrderStatus;
}

/**
 * Map Polymarket API order to internal OrderStatus
 *
 * @param apiOrder - Raw order from Polymarket CLOB API
 * @returns Internal OrderStatus enum value
 *
 * @example
 * ```typescript
 * const apiOrder: OpenOrder = await client.getOrder(orderId);
 * const status = mapApiStatusToInternal(apiOrder);
 * console.log(status); // OrderStatus.OPEN or OrderStatus.FILLED
 * ```
 */
export function mapApiStatusToInternal(apiOrder: OpenOrder): OrderStatus {
  const apiStatus = apiOrder.status?.toLowerCase() || 'live';
  const originalSize = Number(apiOrder.original_size) || 0;
  const sizeMatched = Number(apiOrder.size_matched) || 0;

  // Handle "matched" status (could be partial or full)
  if (apiStatus === 'matched') {
    if (sizeMatched >= originalSize) {
      return OrderStatus.FILLED;
    }
    if (sizeMatched > 0) {
      return OrderStatus.PARTIALLY_FILLED;
    }
    // Matched but no size matched? Treat as open (API inconsistency)
    return OrderStatus.OPEN;
  }

  // Handle "live" status
  if (apiStatus === 'live') {
    // Check for fills (shouldn't happen but handle it)
    if (sizeMatched > 0) {
      return sizeMatched >= originalSize
        ? OrderStatus.FILLED
        : OrderStatus.PARTIALLY_FILLED;
    }
    return OrderStatus.OPEN;
  }

  // Handle "delayed" status
  if (apiStatus === 'delayed') {
    return OrderStatus.PENDING;
  }

  // Handle terminal states
  if (apiStatus === 'cancelled') {
    return OrderStatus.CANCELLED;
  }

  if (apiStatus === 'expired') {
    return OrderStatus.EXPIRED;
  }

  // Unknown status - log warning and default to open
  console.warn(`[OrderStatus] Unknown API status: ${apiStatus}, defaulting to OPEN`);
  return OrderStatus.OPEN;
}

/**
 * Map internal OrderStatus to Polymarket API status string
 * (Used for filtering API requests)
 *
 * @param status - Internal OrderStatus enum
 * @returns Polymarket API status string
 */
export function mapInternalStatusToApi(status: OrderStatus): string {
  switch (status) {
    case OrderStatus.PENDING:
      return 'delayed';
    case OrderStatus.OPEN:
      return 'live';
    case OrderStatus.PARTIALLY_FILLED:
    case OrderStatus.FILLED:
      return 'matched';
    case OrderStatus.CANCELLED:
      return 'cancelled';
    case OrderStatus.EXPIRED:
      return 'expired';
    case OrderStatus.REJECTED:
      // Rejected orders never reach API
      return 'rejected';
    default:
      return 'live';
  }
}

/**
 * ============================================================================
 * Status Helper Functions
 * ============================================================================
 */

/**
 * Check if order is in an active (non-terminal) state
 *
 * Active states can transition to other states.
 * Terminal states are final.
 *
 * @param status - Order status to check
 * @returns true if order is active
 */
export function isActiveStatus(status: OrderStatus): boolean {
  return (
    status === OrderStatus.PENDING ||
    status === OrderStatus.OPEN ||
    status === OrderStatus.PARTIALLY_FILLED
  );
}

/**
 * Check if order is in a terminal (final) state
 *
 * Terminal states: filled, cancelled, expired, rejected
 * These orders can no longer change state.
 *
 * @param status - Order status to check
 * @returns true if order is terminal
 */
export function isTerminalStatus(status: OrderStatus): boolean {
  return (
    status === OrderStatus.FILLED ||
    status === OrderStatus.CANCELLED ||
    status === OrderStatus.EXPIRED ||
    status === OrderStatus.REJECTED
  );
}

/**
 * Check if order is open (in orderbook)
 *
 * Open orders: pending, open, partially_filled
 * These orders can potentially be cancelled.
 *
 * @param status - Order status to check
 * @returns true if order is open
 */
export function isOrderOpen(status: OrderStatus): boolean {
  return (
    status === OrderStatus.PENDING ||
    status === OrderStatus.OPEN ||
    status === OrderStatus.PARTIALLY_FILLED
  );
}

/**
 * Check if order is fully filled
 *
 * @param status - Order status to check
 * @returns true if order is filled
 */
export function isOrderFilled(status: OrderStatus): boolean {
  return status === OrderStatus.FILLED;
}

/**
 * Check if order can be cancelled
 *
 * Orders can be cancelled if they are:
 * - open (in orderbook, no fills)
 * - partially_filled (some fills remaining)
 *
 * Orders cannot be cancelled if:
 * - pending (not yet submitted, just delete locally)
 * - filled (nothing to cancel)
 * - cancelled (already cancelled)
 * - expired (already expired)
 * - rejected (never reached exchange)
 *
 * @param status - Order status to check
 * @returns true if order can be cancelled via API
 */
export function canOrderBeCancelled(status: OrderStatus): boolean {
  return status === OrderStatus.OPEN || status === OrderStatus.PARTIALLY_FILLED;
}

/**
 * Calculate order fill progress
 *
 * @param originalSize - Original order size
 * @param filledSize - Filled size
 * @returns Fill percentage (0-100)
 *
 * @example
 * ```typescript
 * const progress = calculateOrderProgress(100, 75);
 * console.log(progress); // 75
 * ```
 */
export function calculateOrderProgress(originalSize: number, filledSize: number): number {
  if (originalSize <= 0) return 0;
  return Math.min(100, (filledSize / originalSize) * 100);
}

/**
 * Validate status transition
 *
 * Checks if a status transition is valid according to the state machine.
 *
 * Valid transitions:
 * - pending → open, partially_filled, filled, cancelled, expired, rejected
 *   (pending can skip to any state if order fills/cancels/expires immediately)
 * - open → partially_filled, filled, cancelled, expired
 * - partially_filled → filled, cancelled, expired
 * - (terminal states have no valid transitions)
 *
 * @param from - Current status
 * @param to - Target status
 * @returns true if transition is valid
 */
export function isValidStatusTransition(from: OrderStatus, to: OrderStatus): boolean {
  // Same status is always valid (no-op)
  if (from === to) return true;

  // Terminal states cannot transition
  if (isTerminalStatus(from)) return false;

  // Define valid transitions
  const validTransitions: Record<OrderStatus, OrderStatus[]> = {
    // PENDING can transition to any state (immediate fills/cancels/expires are possible)
    [OrderStatus.PENDING]: [
      OrderStatus.OPEN,
      OrderStatus.PARTIALLY_FILLED,
      OrderStatus.FILLED,
      OrderStatus.CANCELLED,
      OrderStatus.EXPIRED,
      OrderStatus.REJECTED,
    ],
    [OrderStatus.OPEN]: [
      OrderStatus.PARTIALLY_FILLED,
      OrderStatus.FILLED,
      OrderStatus.CANCELLED,
      OrderStatus.EXPIRED,
    ],
    [OrderStatus.PARTIALLY_FILLED]: [
      OrderStatus.FILLED,
      OrderStatus.CANCELLED,
      OrderStatus.EXPIRED,
    ],
    // Terminal states (no outgoing transitions)
    [OrderStatus.FILLED]: [],
    [OrderStatus.CANCELLED]: [],
    [OrderStatus.EXPIRED]: [],
    [OrderStatus.REJECTED]: [],
  };

  return validTransitions[from]?.includes(to) ?? false;
}

/**
 * Get human-readable status description
 *
 * @param status - Order status
 * @returns User-friendly description
 */
export function getStatusDescription(status: OrderStatus): string {
  const descriptions: Record<OrderStatus, string> = {
    [OrderStatus.PENDING]: 'Order created, awaiting submission',
    [OrderStatus.OPEN]: 'Active in orderbook',
    [OrderStatus.PARTIALLY_FILLED]: 'Partially filled',
    [OrderStatus.FILLED]: 'Fully filled',
    [OrderStatus.CANCELLED]: 'Cancelled',
    [OrderStatus.EXPIRED]: 'Expired',
    [OrderStatus.REJECTED]: 'Rejected',
  };

  return descriptions[status] || 'Unknown status';
}
