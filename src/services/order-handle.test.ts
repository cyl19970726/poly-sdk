/**
 * OrderHandle Unit Tests
 *
 * Tests the fluent, chainable OrderHandle pattern:
 * - Happy path: created → open → filled
 * - Rejection path: created → rejected
 * - Cancel path: open → cancelled
 * - Partial fill path: open → partially_filled → filled
 * - Expired path: open → expired
 * - Chainable API
 * - Promise await semantics
 * - cancel() delegation
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import {
  OrderHandleImpl,
  type OrderHandle,
  type FillEvent,
  type CancelEvent,
  type ExpireEvent,
  type RejectEvent,
} from './order-manager.js';
import { OrderStatus } from '../core/types.js';
import type { Order, OrderResult } from './trading-service.js';

// ============================================================================
// Mock OrderManager
// ============================================================================

class MockOrderManager extends EventEmitter {
  public cancelOrderCalls: string[] = [];
  public cancelResult: OrderResult = { success: true };

  async cancelOrder(orderId: string): Promise<OrderResult> {
    this.cancelOrderCalls.push(orderId);
    return this.cancelResult;
  }

  async createOrder(): Promise<OrderResult> {
    return { success: true, orderId: 'test-order-1' };
  }
}

// ============================================================================
// Test Helpers
// ============================================================================

function createMockOrder(overrides?: Partial<Order>): Order {
  return {
    id: 'test-order-1',
    status: OrderStatus.OPEN,
    tokenId: 'token123',
    side: 'BUY',
    price: 0.52,
    originalSize: 100,
    filledSize: 0,
    remainingSize: 100,
    associateTrades: [],
    createdAt: Date.now(),
    ...overrides,
  };
}

function createFillEvent(orderId: string, overrides?: Partial<FillEvent>): FillEvent {
  return {
    orderId,
    order: createMockOrder({ id: orderId }),
    fill: {
      tradeId: 'trade-1',
      size: 100,
      price: 0.52,
      fee: 0,
      timestamp: Date.now(),
    },
    cumulativeFilled: 100,
    remainingSize: 0,
    isCompleteFill: true,
    ...overrides,
  };
}

/** Flush microtask queue to let async executor complete */
async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// ============================================================================
// Tests
// ============================================================================

describe('OrderHandleImpl', () => {
  let mockManager: MockOrderManager;

  beforeEach(() => {
    mockManager = new MockOrderManager();
  });

  describe('Happy path: created → open → filled', () => {
    it('should start with status "created"', () => {
      const handle = new OrderHandleImpl(
        mockManager as any,
        () => Promise.resolve({ success: true, orderId: 'order-1' }),
      );

      expect(handle.status).toBe('created');
      expect(handle.orderId).toBeUndefined();
    });

    it('should transition to "open" on order_opened event', async () => {
      const handle = new OrderHandleImpl(
        mockManager as any,
        () => Promise.resolve({ success: true, orderId: 'order-1' }),
      );

      await flushMicrotasks();

      expect(handle.orderId).toBe('order-1');

      // Emit order_opened
      mockManager.emit('order_opened', createMockOrder({ id: 'order-1' }));

      expect(handle.status).toBe('open');
    });

    it('should resolve with "filled" on order_filled event', async () => {
      const handle = new OrderHandleImpl(
        mockManager as any,
        () => Promise.resolve({ success: true, orderId: 'order-1' }),
      );

      await flushMicrotasks();

      // Emit filled
      const fillEvent = createFillEvent('order-1');
      mockManager.emit('order_filled', fillEvent);

      const result = await handle;
      expect(result.status).toBe('filled');
      expect(result.fills).toHaveLength(1);
      expect(result.order).not.toBeNull();
    });

    it('should call onAccepted and onFilled handlers', async () => {
      const accepted = vi.fn();
      const filled = vi.fn();

      const handle = new OrderHandleImpl(
        mockManager as any,
        () => Promise.resolve({ success: true, orderId: 'order-1' }),
      );

      handle.onAccepted(accepted).onFilled(filled);

      await flushMicrotasks();

      const order = createMockOrder({ id: 'order-1' });
      mockManager.emit('order_opened', order);
      expect(accepted).toHaveBeenCalledWith(order);

      const fillEvent = createFillEvent('order-1');
      mockManager.emit('order_filled', fillEvent);
      expect(filled).toHaveBeenCalledWith(fillEvent);
    });
  });

  describe('Rejection path', () => {
    it('should resolve with "rejected" when executor returns failure', async () => {
      const handle = new OrderHandleImpl(
        mockManager as any,
        () => Promise.resolve({ success: false, errorMsg: 'Insufficient balance' }),
      );

      const result = await handle;
      expect(result.status).toBe('rejected');
      expect(result.reason).toBe('Insufficient balance');
      expect(result.order).toBeNull();
      expect(result.fills).toHaveLength(0);
      expect(handle.status).toBe('rejected');
    });

    it('should resolve with "rejected" when executor throws', async () => {
      const handle = new OrderHandleImpl(
        mockManager as any,
        () => Promise.reject(new Error('Network error')),
      );

      const result = await handle;
      expect(result.status).toBe('rejected');
      expect(result.reason).toBe('Network error');
    });

    it('should call onRejected handler', async () => {
      const rejected = vi.fn();

      const handle = new OrderHandleImpl(
        mockManager as any,
        () => Promise.resolve({ success: false, errorMsg: 'Price too low' }),
      );

      handle.onRejected(rejected);

      await handle;
      expect(rejected).toHaveBeenCalledWith('Price too low');
    });

    it('should resolve with "rejected" when executor returns no orderId', async () => {
      const handle = new OrderHandleImpl(
        mockManager as any,
        () => Promise.resolve({ success: true }), // success but no orderId
      );

      const result = await handle;
      expect(result.status).toBe('rejected');
      expect(result.reason).toBe('Order rejected');
    });
  });

  describe('Cancel path', () => {
    it('should resolve with "cancelled" on order_cancelled event', async () => {
      const handle = new OrderHandleImpl(
        mockManager as any,
        () => Promise.resolve({ success: true, orderId: 'order-1' }),
      );

      await flushMicrotasks();

      const cancelEvent: CancelEvent = {
        orderId: 'order-1',
        order: createMockOrder({ id: 'order-1', status: OrderStatus.CANCELLED }),
        filledSize: 0,
        cancelledSize: 100,
        reason: 'user',
        timestamp: Date.now(),
      };
      mockManager.emit('order_cancelled', cancelEvent);

      const result = await handle;
      expect(result.status).toBe('cancelled');
      expect(result.reason).toBe('Order cancelled');
    });

    it('should call onCancelled handler', async () => {
      const cancelled = vi.fn();

      const handle = new OrderHandleImpl(
        mockManager as any,
        () => Promise.resolve({ success: true, orderId: 'order-1' }),
      );

      handle.onCancelled(cancelled);

      await flushMicrotasks();

      const cancelEvent: CancelEvent = {
        orderId: 'order-1',
        order: createMockOrder({ id: 'order-1' }),
        filledSize: 0,
        cancelledSize: 100,
        reason: 'user',
        timestamp: Date.now(),
      };
      mockManager.emit('order_cancelled', cancelEvent);

      await handle;
      expect(cancelled).toHaveBeenCalledWith(cancelEvent.order);
    });

    it('cancel() should delegate to orderManager.cancelOrder', async () => {
      const handle = new OrderHandleImpl(
        mockManager as any,
        () => Promise.resolve({ success: true, orderId: 'order-1' }),
      );

      await flushMicrotasks();

      const success = await handle.cancel();
      expect(success).toBe(true);
      expect(mockManager.cancelOrderCalls).toEqual(['order-1']);
    });

    it('cancel() should return false if no orderId yet', async () => {
      // Don't await - the executor hasn't resolved yet
      let resolveExecutor: (result: OrderResult) => void;
      const handle = new OrderHandleImpl(
        mockManager as any,
        () => new Promise((resolve) => { resolveExecutor = resolve; }),
      );

      const success = await handle.cancel();
      expect(success).toBe(false);
      expect(mockManager.cancelOrderCalls).toHaveLength(0);

      // Cleanup: resolve the executor to avoid hanging
      resolveExecutor!({ success: false, errorMsg: 'test cleanup' });
    });

    it('cancel() should return false if already in terminal state', async () => {
      const handle = new OrderHandleImpl(
        mockManager as any,
        () => Promise.resolve({ success: false, errorMsg: 'rejected' }),
      );

      await handle; // Wait for rejection

      const success = await handle.cancel();
      expect(success).toBe(false);
    });
  });

  describe('Partial fill path', () => {
    it('should track partial fills and resolve on final fill', async () => {
      const partialHandler = vi.fn();
      const filledHandler = vi.fn();

      const handle = new OrderHandleImpl(
        mockManager as any,
        () => Promise.resolve({ success: true, orderId: 'order-1' }),
      );

      handle.onPartialFill(partialHandler).onFilled(filledHandler);

      await flushMicrotasks();

      // First partial fill
      const partialFill = createFillEvent('order-1', {
        fill: { tradeId: 'trade-1', size: 50, price: 0.52, fee: 0, timestamp: Date.now() },
        cumulativeFilled: 50,
        remainingSize: 50,
        isCompleteFill: false,
      });
      mockManager.emit('order_partially_filled', partialFill);

      expect(handle.status).toBe('partially_filled');
      expect(partialHandler).toHaveBeenCalledWith(partialFill);

      // Second partial fill (completing the order)
      const finalFill = createFillEvent('order-1', {
        fill: { tradeId: 'trade-2', size: 50, price: 0.53, fee: 0, timestamp: Date.now() },
        cumulativeFilled: 100,
        remainingSize: 0,
        isCompleteFill: true,
      });
      mockManager.emit('order_filled', finalFill);

      const result = await handle;
      expect(result.status).toBe('filled');
      expect(result.fills).toHaveLength(2);
      expect(filledHandler).toHaveBeenCalledWith(finalFill);
    });
  });

  describe('Expired path', () => {
    it('should resolve with "expired" on order_expired event', async () => {
      const expiredHandler = vi.fn();

      const handle = new OrderHandleImpl(
        mockManager as any,
        () => Promise.resolve({ success: true, orderId: 'order-1' }),
      );

      handle.onExpired(expiredHandler);

      await flushMicrotasks();

      const expireEvent: ExpireEvent = {
        orderId: 'order-1',
        order: createMockOrder({ id: 'order-1', status: OrderStatus.EXPIRED }),
        filledSize: 30,
        expiredSize: 70,
        expirationTime: Date.now(),
        timestamp: Date.now(),
      };
      mockManager.emit('order_expired', expireEvent);

      const result = await handle;
      expect(result.status).toBe('expired');
      expect(result.reason).toBe('Order expired');
      expect(expiredHandler).toHaveBeenCalledWith(expireEvent.order);
    });
  });

  describe('Event filtering', () => {
    it('should ignore events for other order IDs', async () => {
      const filledHandler = vi.fn();

      const handle = new OrderHandleImpl(
        mockManager as any,
        () => Promise.resolve({ success: true, orderId: 'order-1' }),
      );

      handle.onFilled(filledHandler);

      await flushMicrotasks();

      // Emit event for a different order
      mockManager.emit('order_filled', createFillEvent('order-OTHER'));

      expect(filledHandler).not.toHaveBeenCalled();
      expect(handle.status).not.toBe('filled');
    });
  });

  describe('Chainable API', () => {
    it('all lifecycle methods return this for chaining', () => {
      const handle = new OrderHandleImpl(
        mockManager as any,
        () => Promise.resolve({ success: false, errorMsg: 'test' }),
      );

      const result = handle
        .onAccepted(() => {})
        .onPartialFill(() => {})
        .onFilled(() => {})
        .onRejected(() => {})
        .onCancelled(() => {})
        .onExpired(() => {});

      expect(result).toBe(handle);
    });
  });

  describe('PromiseLike semantics', () => {
    it('supports then()', async () => {
      const handle = new OrderHandleImpl(
        mockManager as any,
        () => Promise.resolve({ success: true, orderId: 'order-1' }),
      );

      await flushMicrotasks();
      mockManager.emit('order_filled', createFillEvent('order-1'));

      const status = await handle.then((r) => r.status);
      expect(status).toBe('filled');
    });

    it('supports chained then()', async () => {
      const handle = new OrderHandleImpl(
        mockManager as any,
        () => Promise.resolve({ success: true, orderId: 'order-1' }),
      );

      await flushMicrotasks();
      mockManager.emit('order_filled', createFillEvent('order-1'));

      const fillCount = await handle
        .then((r) => r.fills)
        .then((fills) => fills.length);

      expect(fillCount).toBe(1);
    });
  });

  describe('Event cleanup', () => {
    it('should remove listeners after terminal state', async () => {
      const handle = new OrderHandleImpl(
        mockManager as any,
        () => Promise.resolve({ success: true, orderId: 'order-1' }),
      );

      await flushMicrotasks();

      const listenersBefore = mockManager.listenerCount('order_filled');
      expect(listenersBefore).toBeGreaterThan(0);

      // Trigger terminal state
      mockManager.emit('order_filled', createFillEvent('order-1'));
      await handle;

      const listenersAfter = mockManager.listenerCount('order_filled');
      expect(listenersAfter).toBe(0);
    });

    it('should not subscribe if executor rejects', async () => {
      const handle = new OrderHandleImpl(
        mockManager as any,
        () => Promise.resolve({ success: false, errorMsg: 'fail' }),
      );

      await handle;

      expect(mockManager.listenerCount('order_filled')).toBe(0);
      expect(mockManager.listenerCount('order_opened')).toBe(0);
    });
  });

  describe('Handler error isolation', () => {
    it('should not break lifecycle if handler throws', async () => {
      const handle = new OrderHandleImpl(
        mockManager as any,
        () => Promise.resolve({ success: true, orderId: 'order-1' }),
      );

      handle.onFilled(() => {
        throw new Error('Handler error!');
      });

      await flushMicrotasks();
      mockManager.emit('order_filled', createFillEvent('order-1'));

      const result = await handle;
      expect(result.status).toBe('filled');
    });
  });
});
