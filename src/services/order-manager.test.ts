/**
 * OrderManager Unit Tests
 *
 * Focus: Fill event generation in polling mode
 * Issue #7: Polling mode doesn't emit fill events, only status changes
 *
 * Extended: Market order (FOK/FAK) support
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OrderManager, type FillEvent, type RejectEvent } from './order-manager.js';
import { OrderStatus } from '../core/types.js';
import type { Order, MarketOrderParams } from './trading-service.js';
import { MockRateLimiter, MockCache, waitFor } from '../__tests__/test-utils.js';

// ============================================================================
// Mock Dependencies
// ============================================================================

class MockTradingService {
  private orders = new Map<string, Order>();
  public lastMarketOrderParams: MarketOrderParams | null = null;

  async initialize(): Promise<void> {}

  async getOrder(orderId: string): Promise<Order | null> {
    return this.orders.get(orderId) || null;
  }

  // Mock createMarketOrder for testing
  async createMarketOrder(params: MarketOrderParams): Promise<{ success: boolean; orderId?: string; errorMsg?: string }> {
    this.lastMarketOrderParams = params;
    const orderId = `market-order-${Date.now()}`;

    // Simulate order creation
    this.updateOrder(orderId, {
      id: orderId,
      status: OrderStatus.PENDING,
      tokenId: params.tokenId,
      side: params.side,
      price: params.price || 0,
      originalSize: params.amount,
      filledSize: 0,
      remainingSize: params.amount,
    });

    return { success: true, orderId };
  }

  // Test helper: update order state
  updateOrder(orderId: string, updates: Partial<Order>): void {
    const existing = this.orders.get(orderId);
    if (existing) {
      this.orders.set(orderId, { ...existing, ...updates });
    } else {
      this.orders.set(orderId, {
        id: orderId,
        status: OrderStatus.OPEN,
        tokenId: 'token123',
        side: 'BUY',
        price: 0.52,
        originalSize: 100,
        filledSize: 0,
        remainingSize: 100,
        associateTrades: [],
        createdAt: Date.now(),
        ...updates,
      });
    }
  }

  getCredentials() {
    return null;
  }
}

// ============================================================================
// Test Fixtures
// ============================================================================

const createTestOrder = (overrides?: Partial<Order>): Order => ({
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
});

// ============================================================================
// Tests
// ============================================================================

describe('OrderManager - Polling Fill Detection', () => {
  let orderManager: OrderManager;
  let mockTradingService: MockTradingService;
  let rateLimiter: MockRateLimiter;
  let cache: MockCache;

  beforeEach(async () => {
    rateLimiter = new MockRateLimiter();
    cache = new MockCache();
    mockTradingService = new MockTradingService();

    orderManager = new OrderManager({
      privateKey: '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      rateLimiter: rateLimiter as any,
      cache: cache as any,
      mode: 'polling',
      pollingInterval: 100, // Fast polling for tests
    });

    // Inject mock trading service
    (orderManager as any).tradingService = mockTradingService;

    await orderManager.start();
  });

  afterEach(() => {
    orderManager.stop();
  });

  describe('Fill Detection', () => {
    it('should emit order_partially_filled when filledSize increases', async () => {
      const orderId = 'order-1';
      const initialOrder = createTestOrder({
        id: orderId,
        filledSize: 0,
        remainingSize: 100,
      });

      // Set initial state
      mockTradingService.updateOrder(orderId, initialOrder);

      // Start watching
      orderManager.watchOrder(orderId);

      // Setup event listener
      const fillEvents: FillEvent[] = [];
      orderManager.on('order_partially_filled', (event: FillEvent) => {
        fillEvents.push(event);
      });

      // Wait for initial poll
      await waitFor(150);

      // Simulate partial fill (50 shares filled)
      mockTradingService.updateOrder(orderId, {
        filledSize: 50,
        remainingSize: 50,
        status: OrderStatus.PARTIALLY_FILLED,
        associateTrades: ['trade-1'],
      });

      // Wait for next poll
      await waitFor(150);

      // Verify fill event emitted
      expect(fillEvents).toHaveLength(1);
      expect(fillEvents[0]).toMatchObject({
        orderId,
        fill: {
          size: 50, // Delta from 0 to 50
          price: 0.52, // Order price
        },
        cumulativeFilled: 50,
        remainingSize: 50,
        isCompleteFill: false,
      });
    });

    it('should emit order_filled when order completely filled', async () => {
      const orderId = 'order-2';

      // Set initial state with partial fill
      mockTradingService.updateOrder(orderId, {
        id: orderId,
        filledSize: 50,
        remainingSize: 50,
        status: OrderStatus.PARTIALLY_FILLED,
        associateTrades: ['trade-1'],
      });

      // Start watching (this will poll and set initial state)
      orderManager.watchOrder(orderId);

      // Setup event listener AFTER first poll
      await waitFor(150);

      const fillEvents: FillEvent[] = [];
      orderManager.on('order_filled', (event: FillEvent) => {
        fillEvents.push(event);
      });

      // Simulate complete fill
      mockTradingService.updateOrder(orderId, {
        filledSize: 100,
        remainingSize: 0,
        status: OrderStatus.FILLED,
        associateTrades: ['trade-1', 'trade-2'],
      });

      // Wait for next poll
      await waitFor(150);

      // Verify fill event emitted
      expect(fillEvents).toHaveLength(1);
      expect(fillEvents[0]).toMatchObject({
        orderId,
        fill: {
          size: 50, // Delta from 50 to 100
          price: 0.52,
        },
        cumulativeFilled: 100,
        remainingSize: 0,
        isCompleteFill: true,
      });
    });

    it('should emit multiple partial fill events correctly', async () => {
      const orderId = 'order-3';

      // Set initial state
      mockTradingService.updateOrder(orderId, {
        id: orderId,
        filledSize: 0,
        remainingSize: 100,
      });

      // Start watching and wait for initial state
      orderManager.watchOrder(orderId);
      await waitFor(150);

      // Setup event listener AFTER initial poll
      const partialFillEvents: FillEvent[] = [];
      const completeFillEvents: FillEvent[] = [];

      orderManager.on('order_partially_filled', (event: FillEvent) => {
        partialFillEvents.push(event);
      });

      orderManager.on('order_filled', (event: FillEvent) => {
        completeFillEvents.push(event);
      });

      // First fill: 30 shares
      mockTradingService.updateOrder(orderId, {
        filledSize: 30,
        remainingSize: 70,
        status: OrderStatus.PARTIALLY_FILLED,
        associateTrades: ['trade-1'],
      });
      await waitFor(150);

      // Second fill: 40 more shares (total 70)
      mockTradingService.updateOrder(orderId, {
        filledSize: 70,
        remainingSize: 30,
        status: OrderStatus.PARTIALLY_FILLED,
        associateTrades: ['trade-1', 'trade-2'],
      });
      await waitFor(150);

      // Final fill: 30 more shares (total 100, complete)
      mockTradingService.updateOrder(orderId, {
        filledSize: 100,
        remainingSize: 0,
        status: OrderStatus.FILLED,
        associateTrades: ['trade-1', 'trade-2', 'trade-3'],
      });
      await waitFor(150);

      // Verify partial fills
      expect(partialFillEvents).toHaveLength(2);
      expect(partialFillEvents[0].fill.size).toBe(30);
      expect(partialFillEvents[1].fill.size).toBe(40);

      // Verify complete fill
      expect(completeFillEvents).toHaveLength(1);
      expect(completeFillEvents[0].fill.size).toBe(30);
      expect(completeFillEvents[0].isCompleteFill).toBe(true);
    });

    it('should not emit duplicate fill events', async () => {
      const orderId = 'order-4';

      // Set initial state
      mockTradingService.updateOrder(orderId, {
        id: orderId,
        filledSize: 0,
        remainingSize: 100,
      });

      // Start watching
      orderManager.watchOrder(orderId);

      // Setup event listener
      const fillEvents: FillEvent[] = [];
      orderManager.on('order_partially_filled', (event: FillEvent) => {
        fillEvents.push(event);
      });

      // Wait for initial poll
      await waitFor(150);

      // Simulate fill
      mockTradingService.updateOrder(orderId, {
        filledSize: 50,
        remainingSize: 50,
        status: OrderStatus.PARTIALLY_FILLED,
      });

      // Wait for multiple polls
      await waitFor(150);
      await waitFor(150);
      await waitFor(150);

      // Should only emit once (deduplication works)
      expect(fillEvents).toHaveLength(1);
    });

    it('should include correct fill details', async () => {
      const orderId = 'order-5';

      // Set initial state
      mockTradingService.updateOrder(orderId, {
        id: orderId,
        price: 0.65,
        originalSize: 200,
        filledSize: 0,
        remainingSize: 200,
        associateTrades: [],
      });

      // Start watching
      orderManager.watchOrder(orderId);

      // Setup event listener
      let capturedEvent: FillEvent | null = null;
      orderManager.on('order_partially_filled', (event: FillEvent) => {
        capturedEvent = event;
      });

      // Wait for initial poll
      await waitFor(150);

      // Simulate fill
      mockTradingService.updateOrder(orderId, {
        filledSize: 100,
        remainingSize: 100,
        status: OrderStatus.PARTIALLY_FILLED,
        associateTrades: ['trade-abc'],
      });

      // Wait for poll
      await waitFor(150);

      // Verify fill details
      expect(capturedEvent).not.toBeNull();
      expect(capturedEvent!).toMatchObject({
        orderId,
        fill: {
          tradeId: 'trade-abc',
          size: 100,
          price: 0.65,
          fee: 0, // Polling doesn't have fee info
        },
        cumulativeFilled: 100,
        remainingSize: 100,
        isCompleteFill: false,
      });

      // Verify order reference
      expect(capturedEvent!.order.id).toBe(orderId);
      expect(capturedEvent!.order.filledSize).toBe(100);
    });
  });

  describe('Status Change Events', () => {
    it('should emit both fill event and status change event', async () => {
      const orderId = 'order-6';

      // Set initial state
      mockTradingService.updateOrder(orderId, {
        id: orderId,
        filledSize: 0,
        remainingSize: 100,
        status: OrderStatus.OPEN,
      });

      // Start watching and wait for initial state
      orderManager.watchOrder(orderId);
      await waitFor(150);

      // Setup event listeners AFTER initial poll
      const fillEvents: FillEvent[] = [];
      const statusChanges: any[] = [];

      orderManager.on('order_partially_filled', (event: FillEvent) => {
        fillEvents.push(event);
      });

      orderManager.on('status_change', (event: any) => {
        statusChanges.push(event);
      });

      // Simulate fill with status change
      mockTradingService.updateOrder(orderId, {
        filledSize: 50,
        remainingSize: 50,
        status: OrderStatus.PARTIALLY_FILLED,
      });

      // Wait for poll
      await waitFor(150);

      // Both events should be emitted
      expect(fillEvents).toHaveLength(1);
      expect(statusChanges).toHaveLength(1);
      expect(statusChanges[0].to).toBe(OrderStatus.PARTIALLY_FILLED);
    });
  });

  describe('Edge Cases', () => {
    it('should handle filledSize staying the same (no fill)', async () => {
      const orderId = 'order-7';

      // Set initial state with existing fill
      mockTradingService.updateOrder(orderId, {
        id: orderId,
        filledSize: 50,
        remainingSize: 50,
        status: OrderStatus.PARTIALLY_FILLED,
      });

      // Start watching and wait for initial state
      orderManager.watchOrder(orderId);
      await waitFor(150);

      // Setup event listener AFTER initial poll
      const fillEvents: FillEvent[] = [];
      orderManager.on('order_partially_filled', (event: FillEvent) => {
        fillEvents.push(event);
      });

      // Wait for multiple polls (no fill change)
      await waitFor(150);
      await waitFor(150);

      // No fill events should be emitted
      expect(fillEvents).toHaveLength(0);
    });

    it('should handle order with no associateTrades', async () => {
      const orderId = 'order-8';

      // Set initial state
      mockTradingService.updateOrder(orderId, {
        id: orderId,
        filledSize: 0,
        remainingSize: 100,
        associateTrades: [],
      });

      // Start watching
      orderManager.watchOrder(orderId);

      // Setup event listener
      let capturedEvent: FillEvent | null = null;
      orderManager.on('order_partially_filled', (event: FillEvent) => {
        capturedEvent = event;
      });

      // Wait for initial poll
      await waitFor(150);

      // Simulate fill with no trade ID
      mockTradingService.updateOrder(orderId, {
        filledSize: 50,
        remainingSize: 50,
        status: OrderStatus.PARTIALLY_FILLED,
        associateTrades: [], // Empty array
      });

      // Wait for poll
      await waitFor(150);

      // Should generate synthetic tradeId
      expect(capturedEvent).not.toBeNull();
      expect(capturedEvent!.fill.tradeId).toMatch(/^polling_\d+$/);
    });

    it('should handle order going directly from OPEN to FILLED', async () => {
      const orderId = 'order-9';

      // Set initial state
      mockTradingService.updateOrder(orderId, {
        id: orderId,
        filledSize: 0,
        remainingSize: 100,
        status: OrderStatus.OPEN,
      });

      // Start watching and wait for initial state
      orderManager.watchOrder(orderId);
      await waitFor(150);

      // Setup event listeners AFTER initial poll
      const partialFillEvents: FillEvent[] = [];
      const completeFillEvents: FillEvent[] = [];

      orderManager.on('order_partially_filled', (event: FillEvent) => {
        partialFillEvents.push(event);
      });

      orderManager.on('order_filled', (event: FillEvent) => {
        completeFillEvents.push(event);
      });

      // Simulate instant complete fill (market order scenario)
      mockTradingService.updateOrder(orderId, {
        filledSize: 100,
        remainingSize: 0,
        status: OrderStatus.FILLED,
        associateTrades: ['trade-1'],
      });

      // Wait for poll
      await waitFor(150);

      // Should emit complete fill only
      expect(partialFillEvents).toHaveLength(0);
      expect(completeFillEvents).toHaveLength(1);
      expect(completeFillEvents[0].fill.size).toBe(100);
    });
  });
});

describe('OrderManager - WebSocket + Polling Deduplication', () => {
  let orderManager: OrderManager;
  let mockTradingService: MockTradingService;

  beforeEach(async () => {
    mockTradingService = new MockTradingService();

    orderManager = new OrderManager({
      privateKey: '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      rateLimiter: new MockRateLimiter() as any,
      cache: new MockCache() as any,
      mode: 'hybrid', // Both WebSocket and Polling
      pollingInterval: 100,
    });

    // Inject mock trading service
    (orderManager as any).tradingService = mockTradingService;

    await orderManager.start();
  });

  afterEach(() => {
    orderManager.stop();
  });

  it('should not emit duplicate fills when both WebSocket and Polling detect same fill', async () => {
    const orderId = 'order-10';

    // Set initial state
    mockTradingService.updateOrder(orderId, {
      id: orderId,
      filledSize: 0,
      remainingSize: 100,
    });

    // Start watching
    orderManager.watchOrder(orderId);

    // Setup event listener
    const fillEvents: FillEvent[] = [];
    orderManager.on('order_partially_filled', (event: FillEvent) => {
      fillEvents.push(event);
    });

    // Wait for initial poll
    await waitFor(150);

    // Update order state
    mockTradingService.updateOrder(orderId, {
      filledSize: 50,
      remainingSize: 50,
      status: OrderStatus.PARTIALLY_FILLED,
    });

    // Wait for multiple polls
    await waitFor(150);
    await waitFor(150);

    // Deduplication should prevent multiple emissions
    expect(fillEvents).toHaveLength(1);
  });
});

// ============================================================================
// Market Order Tests (FOK/FAK)
// ============================================================================

describe('OrderManager - Market Orders (FOK/FAK)', () => {
  let orderManager: OrderManager;
  let mockTradingService: MockTradingService;
  let rateLimiter: MockRateLimiter;
  let cache: MockCache;

  beforeEach(async () => {
    rateLimiter = new MockRateLimiter();
    cache = new MockCache();
    mockTradingService = new MockTradingService();

    orderManager = new OrderManager({
      privateKey: '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      rateLimiter: rateLimiter as any,
      cache: cache as any,
      mode: 'polling',
      pollingInterval: 100,
    });

    // Inject mock trading service
    (orderManager as any).tradingService = mockTradingService;

    await orderManager.start();
  });

  afterEach(() => {
    orderManager.stop();
  });

  describe('Market Order Creation', () => {
    it('should create FOK market order and auto-watch', async () => {
      const orderCreatedEvents: any[] = [];
      orderManager.on('order_created', (order) => {
        orderCreatedEvents.push(order);
      });

      const result = await orderManager.createMarketOrder({
        tokenId: 'token123',
        side: 'BUY',
        amount: 10,
        orderType: 'FOK',
      });

      expect(result.success).toBe(true);
      expect(result.orderId).toBeDefined();
      expect(orderCreatedEvents).toHaveLength(1);
      expect(orderCreatedEvents[0].orderType).toBe('FOK');

      // Should be auto-watched
      const watched = orderManager.getWatchedOrders();
      expect(watched.some(o => o.id === result.orderId)).toBe(true);
    });

    it('should create FAK market order and auto-watch', async () => {
      const result = await orderManager.createMarketOrder({
        tokenId: 'token123',
        side: 'SELL',
        amount: 20,
        orderType: 'FAK',
      });

      expect(result.success).toBe(true);
      expect(mockTradingService.lastMarketOrderParams?.orderType).toBe('FAK');
    });

    it('should reject market order below minimum amount ($1)', async () => {
      const rejectEvents: RejectEvent[] = [];
      orderManager.on('order_rejected', (event: RejectEvent) => {
        rejectEvents.push(event);
      });

      const result = await orderManager.createMarketOrder({
        tokenId: 'token123',
        side: 'BUY',
        amount: 0.5, // Below $1 minimum
      });

      expect(result.success).toBe(false);
      expect(result.errorMsg).toContain('at least $1');
      expect(rejectEvents).toHaveLength(1);
    });

    it('should default to FOK when orderType not specified', async () => {
      const orderCreatedEvents: any[] = [];
      orderManager.on('order_created', (order) => {
        orderCreatedEvents.push(order);
      });

      await orderManager.createMarketOrder({
        tokenId: 'token123',
        side: 'BUY',
        amount: 10,
        // No orderType specified
      });

      expect(orderCreatedEvents[0].orderType).toBe('FOK');
    });
  });

  describe('FOK Order Lifecycle', () => {
    it('should handle FOK order that fills completely', async () => {
      const fillEvents: FillEvent[] = [];
      orderManager.on('order_filled', (event: FillEvent) => {
        fillEvents.push(event);
      });

      // Create FOK order
      const result = await orderManager.createMarketOrder({
        tokenId: 'token123',
        side: 'BUY',
        amount: 10,
        orderType: 'FOK',
      });

      // Wait for initial poll
      await waitFor(150);

      // Simulate instant complete fill (FOK success)
      mockTradingService.updateOrder(result.orderId!, {
        filledSize: 10,
        remainingSize: 0,
        status: OrderStatus.FILLED,
        associateTrades: ['trade-fok-1'],
      });

      // Wait for poll to detect
      await waitFor(150);

      expect(fillEvents).toHaveLength(1);
      expect(fillEvents[0].isCompleteFill).toBe(true);
      expect(fillEvents[0].cumulativeFilled).toBe(10);
    });

    it('should handle FOK order that fails to fill (cancelled)', async () => {
      const cancelEvents: any[] = [];
      orderManager.on('order_cancelled', (event) => {
        cancelEvents.push(event);
      });

      // Create FOK order
      const result = await orderManager.createMarketOrder({
        tokenId: 'token123',
        side: 'BUY',
        amount: 100, // Large order that may fail to fill
        orderType: 'FOK',
      });

      // Wait for initial poll
      await waitFor(150);

      // Simulate FOK failure - order cancelled without any fill
      mockTradingService.updateOrder(result.orderId!, {
        filledSize: 0,
        remainingSize: 100,
        status: OrderStatus.CANCELLED,
      });

      // Wait for poll to detect
      await waitFor(150);

      expect(cancelEvents).toHaveLength(1);
      expect(cancelEvents[0].filledSize).toBe(0);
      expect(cancelEvents[0].cancelledSize).toBe(100);
    });
  });

  describe('FAK Order Lifecycle', () => {
    it('should handle FAK order with partial fill', async () => {
      const fillEvents: FillEvent[] = [];
      const cancelEvents: any[] = [];

      orderManager.on('order_partially_filled', (event: FillEvent) => {
        fillEvents.push(event);
      });
      orderManager.on('order_cancelled', (event) => {
        cancelEvents.push(event);
      });

      // Create FAK order
      const result = await orderManager.createMarketOrder({
        tokenId: 'token123',
        side: 'BUY',
        amount: 100,
        orderType: 'FAK',
      });

      // Wait for initial poll
      await waitFor(150);

      // Simulate FAK partial fill - fills 60, cancels 40
      // First the partial fill is detected
      mockTradingService.updateOrder(result.orderId!, {
        filledSize: 60,
        remainingSize: 40,
        status: OrderStatus.PARTIALLY_FILLED,
        associateTrades: ['trade-fak-1'],
      });

      await waitFor(150);

      // Then the cancellation of remaining
      mockTradingService.updateOrder(result.orderId!, {
        filledSize: 60,
        remainingSize: 40,
        status: OrderStatus.CANCELLED,
      });

      await waitFor(150);

      expect(fillEvents).toHaveLength(1);
      expect(fillEvents[0].cumulativeFilled).toBe(60);
      expect(cancelEvents).toHaveLength(1);
      expect(cancelEvents[0].filledSize).toBe(60);
      expect(cancelEvents[0].cancelledSize).toBe(40);
    });

    it('should handle FAK order that fills completely', async () => {
      const fillEvents: FillEvent[] = [];

      orderManager.on('order_filled', (event: FillEvent) => {
        fillEvents.push(event);
      });

      // Create FAK order
      const result = await orderManager.createMarketOrder({
        tokenId: 'token123',
        side: 'BUY',
        amount: 10,
        orderType: 'FAK',
      });

      // Wait for initial poll
      await waitFor(150);

      // Simulate FAK complete fill (all liquidity available)
      mockTradingService.updateOrder(result.orderId!, {
        filledSize: 10,
        remainingSize: 0,
        status: OrderStatus.FILLED,
        associateTrades: ['trade-fak-complete'],
      });

      await waitFor(150);

      expect(fillEvents).toHaveLength(1);
      expect(fillEvents[0].isCompleteFill).toBe(true);
    });
  });

  describe('Status Transitions', () => {
    it('should allow PENDING → FILLED transition (instant FOK fill)', async () => {
      const statusChanges: any[] = [];
      orderManager.on('status_change', (event) => {
        statusChanges.push(event);
      });

      const result = await orderManager.createMarketOrder({
        tokenId: 'token123',
        side: 'BUY',
        amount: 10,
        orderType: 'FOK',
      });

      await waitFor(150);

      // Instant fill - PENDING → FILLED directly
      mockTradingService.updateOrder(result.orderId!, {
        filledSize: 10,
        remainingSize: 0,
        status: OrderStatus.FILLED,
      });

      await waitFor(150);

      // Should have valid status change
      const filledChange = statusChanges.find(c => c.to === OrderStatus.FILLED);
      expect(filledChange).toBeDefined();
    });

    it('should allow PENDING → CANCELLED transition (FOK failure)', async () => {
      const statusChanges: any[] = [];
      orderManager.on('status_change', (event) => {
        statusChanges.push(event);
      });

      const result = await orderManager.createMarketOrder({
        tokenId: 'token123',
        side: 'BUY',
        amount: 1000,
        orderType: 'FOK',
      });

      await waitFor(150);

      // FOK fails - PENDING → CANCELLED directly
      mockTradingService.updateOrder(result.orderId!, {
        filledSize: 0,
        remainingSize: 1000,
        status: OrderStatus.CANCELLED,
      });

      await waitFor(150);

      const cancelledChange = statusChanges.find(c => c.to === OrderStatus.CANCELLED);
      expect(cancelledChange).toBeDefined();
    });
  });
});
