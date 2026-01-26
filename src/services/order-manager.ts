/**
 * OrderManager - Unified Order Creation and Monitoring
 *
 * Core Design Philosophy:
 * - Unifies order creation + lifecycle monitoring in one component
 * - Encapsulates all Polymarket-specific details (USDC.e, tick size, tokenId, CTF, Polygon)
 * - Provides complete lifecycle events (CLOB match → tx submit → on-chain confirm)
 * - Auto-validates orders before submission (market state, balance, precision)
 * - Auto-watches orders after creation
 *
 * ============================================================================
 * ORDER TYPES AND LIFECYCLE
 * ============================================================================
 *
 * Polymarket supports 4 order types, each with different lifecycle patterns:
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ LIMIT ORDERS (createOrder)                                             │
 * ├─────────────────────────────────────────────────────────────────────────┤
 * │                                                                         │
 * │ GTC (Good Till Cancelled) - Default limit order                        │
 * │ ─────────────────────────────────────────────────────────────────────── │
 * │ Lifecycle: PENDING → OPEN → PARTIALLY_FILLED* → FILLED or CANCELLED    │
 * │ Duration:  seconds → minutes → hours → days (until filled/cancelled)   │
 * │                                                                         │
 * │   ┌─────────┐    placed     ┌──────┐   partial    ┌──────────────────┐ │
 * │   │ PENDING │ ───────────→ │ OPEN │ ──────────→ │ PARTIALLY_FILLED │ │
 * │   └─────────┘              └──────┘             └──────────────────┘ │
 * │        │                       │                        │            │
 * │        │ reject                │ cancel                 │ fill/cancel│
 * │        ↓                       ↓                        ↓            │
 * │   ┌──────────┐           ┌───────────┐            ┌────────┐        │
 * │   │ REJECTED │           │ CANCELLED │            │ FILLED │        │
 * │   └──────────┘           └───────────┘            └────────┘        │
 * │                                                                       │
 * │ GTD (Good Till Date) - Limit order with expiration                   │
 * │ ─────────────────────────────────────────────────────────────────────  │
 * │ Lifecycle: Same as GTC, but auto-expires at specified time           │
 * │ Duration:  seconds → specified expiration time                        │
 * │ Additional terminal state: EXPIRED (when expiration time reached)    │
 * │                                                                         │
 * ├─────────────────────────────────────────────────────────────────────────┤
 * │ MARKET ORDERS (createMarketOrder)                                      │
 * ├─────────────────────────────────────────────────────────────────────────┤
 * │                                                                         │
 * │ FOK (Fill Or Kill) - Must fill completely or cancel immediately       │
 * │ ───────────────────────────────────────────────────────────────────────│
 * │ Lifecycle: PENDING → FILLED (success) or PENDING → CANCELLED (fail)   │
 * │ Duration:  milliseconds (instant execution)                           │
 * │ Key: NO partial fills - all or nothing                                │
 * │                                                                         │
 * │   ┌─────────┐    full fill    ┌────────┐                              │
 * │   │ PENDING │ ─────────────→ │ FILLED │                              │
 * │   └─────────┘                └────────┘                              │
 * │        │                                                               │
 * │        │ cannot fill completely                                        │
 * │        ↓                                                               │
 * │   ┌───────────┐                                                        │
 * │   │ CANCELLED │  (filledSize = 0)                                     │
 * │   └───────────┘                                                        │
 * │                                                                         │
 * │ FAK (Fill And Kill) - Fill what's available, cancel the rest          │
 * │ ───────────────────────────────────────────────────────────────────────│
 * │ Lifecycle: PENDING → FILLED or PENDING → CANCELLED (with partial fill)│
 * │ Duration:  milliseconds (instant execution)                           │
 * │ Key: May have partial fills, remainder is cancelled immediately       │
 * │                                                                         │
 * │   ┌─────────┐    full fill    ┌────────┐                              │
 * │   │ PENDING │ ─────────────→ │ FILLED │                              │
 * │   └─────────┘                └────────┘                              │
 * │        │                                                               │
 * │        │ partial fill + cancel rest                                    │
 * │        ↓                                                               │
 * │   ┌───────────┐                                                        │
 * │   │ CANCELLED │  (filledSize > 0, cancelledSize > 0)                  │
 * │   └───────────┘                                                        │
 * │                                                                         │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * ============================================================================
 * WHY ORDERMANAGER SUPPORTS ALL ORDER TYPES
 * ============================================================================
 *
 * The key insight is that despite different lifecycles, all order types share
 * the same underlying status model and event stream:
 *
 * 1. UNIFIED STATUS MODEL
 *    All orders use the same OrderStatus enum: PENDING, OPEN, PARTIALLY_FILLED,
 *    FILLED, CANCELLED, EXPIRED. The difference is which transitions are valid
 *    and how quickly they occur.
 *
 * 2. SAME WEBSOCKET/POLLING EVENTS
 *    RealtimeServiceV2's `clob_user` topic emits the same USER_ORDER and
 *    USER_TRADE events for all order types. The eventType field indicates:
 *    - PLACEMENT: Order entered the system
 *    - UPDATE: Order was modified (fill, partial fill)
 *    - CANCELLATION: Order was cancelled
 *
 * 3. STATUS TRANSITION VALIDATION
 *    The isValidStatusTransition() function handles all valid paths:
 *    - GTC/GTD: PENDING → OPEN → PARTIALLY_FILLED → FILLED/CANCELLED
 *    - FOK: PENDING → FILLED or PENDING → CANCELLED (no PARTIALLY_FILLED)
 *    - FAK: PENDING → FILLED or PENDING → CANCELLED (filledSize may be > 0)
 *
 * 4. TERMINAL STATE HANDLING
 *    All order types eventually reach a terminal state (FILLED, CANCELLED,
 *    EXPIRED). OrderManager auto-unwatches orders when they reach terminal
 *    states, regardless of order type.
 *
 * 5. FILL EVENT DETECTION
 *    Whether fills come rapidly (FOK/FAK) or slowly (GTC/GTD), the same
 *    fill detection logic works: compare filledSize changes and emit
 *    order_partially_filled or order_filled events.
 *
 * Key differences in behavior:
 * ┌─────────────┬─────────────────────────────────────────────────────────┐
 * │ Order Type  │ Behavior                                                │
 * ├─────────────┼─────────────────────────────────────────────────────────┤
 * │ GTC/GTD     │ May emit many events over long time (hours/days)       │
 * │             │ watchOrder() monitors until filled/cancelled/expired    │
 * ├─────────────┼─────────────────────────────────────────────────────────┤
 * │ FOK/FAK     │ Emit 1-2 events almost instantly (milliseconds)        │
 * │             │ watchOrder() monitors briefly, auto-unwatches quickly   │
 * └─────────────┴─────────────────────────────────────────────────────────┘
 *
 * ============================================================================
 * PLATFORM-SPECIFIC IMPLEMENTATION
 * ============================================================================
 *
 * This is a Polymarket-specific implementation. The design allows future extraction
 * to interfaces if supporting multiple prediction markets, but for now we focus on
 * clean encapsulation with Polymarket details in private methods.
 *
 * @example
 * ```typescript
 * const orderMgr = new OrderManager({
 *   privateKey: '0x...',
 *   rateLimiter,
 *   cache,
 * });
 *
 * await orderMgr.start();
 *
 * // Listen to complete lifecycle
 * orderMgr.on('order_opened', (order) => {
 *   console.log('Order live in orderbook');
 * });
 *
 * orderMgr.on('order_filled', (event) => {
 *   console.log(`Filled: ${event.fill.size} @ ${event.fill.price}`);
 * });
 *
 * orderMgr.on('transaction_confirmed', (event) => {
 *   console.log(`On-chain settled: ${event.transactionHash}`);
 * });
 *
 * // Create limit order (GTC by default)
 * const limitResult = await orderMgr.createOrder({
 *   tokenId: '0x...',
 *   side: 'BUY',
 *   price: 0.52,
 *   size: 100,
 * });
 *
 * // Create market order (FOK - fill completely or cancel)
 * const fokResult = await orderMgr.createMarketOrder({
 *   tokenId: '0x...',
 *   side: 'BUY',
 *   amount: 50, // $50 USDC
 *   orderType: 'FOK',
 * });
 *
 * // Create market order (FAK - fill what's available)
 * const fakResult = await orderMgr.createMarketOrder({
 *   tokenId: '0x...',
 *   side: 'BUY',
 *   amount: 50,
 *   orderType: 'FAK',
 * });
 * ```
 */

import { EventEmitter } from 'events';
import { ethers } from 'ethers';
import { TradingService, type LimitOrderParams, type MarketOrderParams, type Order, type OrderResult } from './trading-service.js';
import type { RealtimeServiceV2, UserOrder, UserTrade } from './realtime-service-v2.js';
import { RateLimiter } from '../core/rate-limiter.js';
import { createUnifiedCache } from '../core/unified-cache.js';
import type { UnifiedCache } from '../core/unified-cache.js';
import { OrderStatus } from '../core/types.js';
import { mapApiStatusToInternal, isTerminalStatus, isValidStatusTransition } from '../core/order-status.js';
import { PolymarketError, ErrorCode } from '../core/errors.js';

// ============================================================================
// Configuration & Types
// ============================================================================

export interface OrderManagerConfig {
  /** Private key for signing transactions */
  privateKey: string;
  /** Rate limiter for API calls */
  rateLimiter: RateLimiter;
  /** Cache for market metadata */
  cache: UnifiedCache;
  /** Chain ID (default: 137 Polygon mainnet) */
  chainId?: number;
  /** Detection mode for order status tracking */
  mode?: 'websocket' | 'polling' | 'hybrid';
  /** Polling interval in ms (default: 5000) */
  pollingInterval?: number;
  /** RPC URL for Polygon provider (for settlement tracking) */
  polygonRpcUrl?: string;
}

/**
 * Watched order state
 * Internal tracking structure for monitoring order lifecycle
 */
interface WatchedOrder {
  orderId: string;
  order: Order;
  /** Metadata for strategy context */
  metadata?: OrderMetadata;
  /** Last known status (for detecting transitions) */
  lastStatus: OrderStatus;
  /** Polling interval ID (if in polling mode) */
  pollingIntervalId?: NodeJS.Timeout;
}

/**
 * Optional metadata for order tracking
 * Can be used by strategies to attach context
 */
export interface OrderMetadata {
  strategyId?: string;
  marketSlug?: string;
  notes?: string;
  [key: string]: unknown;
}

/**
 * Market metadata cache entry (Polymarket-specific)
 * Used to reduce API calls and validate orders
 */
interface MarketMetadata {
  conditionId: string;
  tokenIds: string[];
  active: boolean;
  closed: boolean;
  tickSize: string;
  minOrderSize: string;
  cachedAt: number;
}

// ============================================================================
// Event Types
// ============================================================================

/**
 * Order status change event
 * Emitted whenever an order transitions between states
 */
export interface OrderStatusChangeEvent {
  orderId: string;
  from: OrderStatus;
  to: OrderStatus;
  order: Order;
  timestamp: number;
  reason?: string;
}

/**
 * Fill event
 * Emitted when an order receives a fill (partial or complete)
 */
export interface FillEvent {
  orderId: string;
  order: Order;
  fill: {
    tradeId: string;
    size: number;
    price: number;
    fee: number;
    timestamp: number;
    transactionHash?: string;
  };
  cumulativeFilled: number;
  remainingSize: number;
  isCompleteFill: boolean;
}

/**
 * Transaction submitted event (Polymarket-specific)
 * Emitted when a trade has a transaction hash
 */
export interface TransactionEvent {
  orderId: string;
  tradeId: string;
  transactionHash: string;
  timestamp: number;
}

/**
 * On-chain settlement event (Polymarket-specific)
 * Emitted when transaction is confirmed on Polygon
 */
export interface SettlementEvent {
  orderId: string;
  tradeId: string;
  transactionHash: string;
  blockNumber: number;
  gasUsed: string;
  timestamp: number;
}

/**
 * Cancellation event
 */
export interface CancelEvent {
  orderId: string;
  order: Order;
  filledSize: number;
  cancelledSize: number;
  reason: 'user' | 'system';
  timestamp: number;
}

/**
 * Expiration event (for GTD orders)
 */
export interface ExpireEvent {
  orderId: string;
  order: Order;
  filledSize: number;
  expiredSize: number;
  expirationTime: number;
  timestamp: number;
}

/**
 * Rejection event (order failed validation)
 */
export interface RejectEvent {
  orderId?: string;
  params: LimitOrderParams;
  reason: string;
  timestamp: number;
}

// ============================================================================
// OrderHandle Types
// ============================================================================

/**
 * Status of an order as seen through the OrderHandle.
 * Maps to OrderStatus enum values but as a string union for ergonomic usage.
 */
export type OrderHandleStatus = 'created' | 'open' | 'partially_filled' | 'filled' | 'cancelled' | 'rejected' | 'expired';

/**
 * Terminal result returned when awaiting an OrderHandle.
 */
export interface OrderFinalResult {
  status: 'filled' | 'cancelled' | 'rejected' | 'expired';
  order: Order | null;
  fills: FillEvent[];
  reason?: string;
}

/**
 * Fluent, chainable handle for an order's lifecycle.
 *
 * Implements PromiseLike so callers can `await` for terminal state.
 * Provides chainable lifecycle callbacks and cancel() for control.
 *
 * @example
 * ```typescript
 * const handle = orderManager.placeOrder({ tokenId, side: 'BUY', price: 0.52, size: 100 });
 *
 * handle
 *   .onAccepted((order) => console.log('Live:', order.id))
 *   .onPartialFill((fill) => console.log('Partial:', fill.fill.size))
 *   .onFilled((fill) => console.log('Done!'));
 *
 * const result = await handle;
 * console.log(result.status, result.fills.length);
 * ```
 */
export interface OrderHandle extends PromiseLike<OrderFinalResult> {
  /** Called when the order is accepted and open in the orderbook */
  onAccepted(handler: (order: Order) => void): this;
  /** Called on each partial fill */
  onPartialFill(handler: (fill: FillEvent) => void): this;
  /** Called when the order is fully filled */
  onFilled(handler: (fill: FillEvent) => void): this;
  /** Called if the order is rejected (validation/API failure) */
  onRejected(handler: (reason: string) => void): this;
  /** Called if the order is cancelled */
  onCancelled(handler: (order: Order) => void): this;
  /** Called if the order expires (GTD) */
  onExpired(handler: (order: Order) => void): this;

  /** Cancel the order. Returns true if cancellation succeeded. */
  cancel(): Promise<boolean>;

  /** The order ID (available after API acceptance, undefined before) */
  readonly orderId: string | undefined;
  /** Current status of the order */
  readonly status: OrderHandleStatus;
}

// ============================================================================
// OrderHandleImpl
// ============================================================================

type HandleEvent = 'accepted' | 'partial_fill' | 'filled' | 'rejected' | 'cancelled' | 'expired';

/**
 * Internal implementation of OrderHandle.
 *
 * Lifecycle:
 * 1. Constructor receives orderManager ref and an executor function
 * 2. Status starts at 'created'
 * 3. Executor is invoked immediately (fire-and-forget)
 * 4. On success: stores orderId, subscribes to OrderManager events
 * 5. On rejection: transitions to 'rejected', resolves promise
 * 6. On terminal events: resolves promise, removes listeners
 */
export class OrderHandleImpl implements OrderHandle {
  private _orderId: string | undefined;
  private _status: OrderHandleStatus = 'created';
  private _fills: FillEvent[] = [];
  private _order: Order | null = null;
  private _reason: string | undefined;

  private _resolve!: (result: OrderFinalResult) => void;
  private _promise: Promise<OrderFinalResult>;

  private _handlers: Map<HandleEvent, Array<(...args: any[]) => void>> = new Map();
  private _eventCleanup: (() => void) | null = null;

  constructor(
    private orderManager: OrderManager,
    private executor: () => Promise<OrderResult>,
  ) {
    this._promise = new Promise<OrderFinalResult>((resolve) => {
      this._resolve = resolve;
    });

    // Fire-and-forget execution
    this.execute();
  }

  // ===== PromiseLike implementation =====

  then<TResult1 = OrderFinalResult, TResult2 = never>(
    onfulfilled?: ((value: OrderFinalResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this._promise.then(onfulfilled, onrejected);
  }

  // ===== Chainable lifecycle callbacks =====

  onAccepted(handler: (order: Order) => void): this {
    this.addHandler('accepted', handler);
    return this;
  }

  onPartialFill(handler: (fill: FillEvent) => void): this {
    this.addHandler('partial_fill', handler);
    return this;
  }

  onFilled(handler: (fill: FillEvent) => void): this {
    this.addHandler('filled', handler);
    return this;
  }

  onRejected(handler: (reason: string) => void): this {
    this.addHandler('rejected', handler);
    return this;
  }

  onCancelled(handler: (order: Order) => void): this {
    this.addHandler('cancelled', handler);
    return this;
  }

  onExpired(handler: (order: Order) => void): this {
    this.addHandler('expired', handler);
    return this;
  }

  // ===== Operations =====

  async cancel(): Promise<boolean> {
    if (!this._orderId) return false;
    if (this.isTerminal()) return false;

    const result = await this.orderManager.cancelOrder(this._orderId);
    return result.success;
  }

  // ===== State query =====

  get orderId(): string | undefined {
    return this._orderId;
  }

  get status(): OrderHandleStatus {
    return this._status;
  }

  // ===== Private implementation =====

  private async execute(): Promise<void> {
    try {
      const result = await this.executor();

      if (!result.success || !result.orderId) {
        // Order rejected by API or validation
        this._status = 'rejected';
        this._reason = result.errorMsg || 'Order rejected';
        this.invokeHandlers('rejected', this._reason);
        this._resolve({
          status: 'rejected',
          order: null,
          fills: [],
          reason: this._reason,
        });
        return;
      }

      // Store orderId and subscribe to events
      this._orderId = result.orderId;
      this.subscribeToEvents();
    } catch (error) {
      // Unexpected error during execution
      this._status = 'rejected';
      this._reason = error instanceof Error ? error.message : String(error);
      this.invokeHandlers('rejected', this._reason);
      this._resolve({
        status: 'rejected',
        order: null,
        fills: [],
        reason: this._reason,
      });
    }
  }

  private subscribeToEvents(): void {
    const onOpened = (order: Order) => {
      if (order.id !== this._orderId) return;
      this._status = 'open';
      this._order = order;
      this.invokeHandlers('accepted', order);
    };

    const onPartialFill = (fill: FillEvent) => {
      if (fill.orderId !== this._orderId) return;
      this._status = 'partially_filled';
      this._order = fill.order;
      this._fills.push(fill);
      this.invokeHandlers('partial_fill', fill);
    };

    const onFilled = (fill: FillEvent) => {
      if (fill.orderId !== this._orderId) return;
      this._status = 'filled';
      this._order = fill.order;
      this._fills.push(fill);
      this.invokeHandlers('filled', fill);
      this.resolveTerminal('filled');
    };

    const onCancelled = (event: CancelEvent) => {
      if (event.orderId !== this._orderId) return;
      this._status = 'cancelled';
      this._order = event.order;
      this.invokeHandlers('cancelled', event.order);
      this.resolveTerminal('cancelled', 'Order cancelled');
    };

    const onExpired = (event: ExpireEvent) => {
      if (event.orderId !== this._orderId) return;
      this._status = 'expired';
      this._order = event.order;
      this.invokeHandlers('expired', event.order);
      this.resolveTerminal('expired', 'Order expired');
    };

    const onRejected = (event: RejectEvent) => {
      if (event.orderId !== this._orderId) return;
      this._status = 'rejected';
      this._reason = event.reason;
      this.invokeHandlers('rejected', event.reason);
      this.resolveTerminal('rejected', event.reason);
    };

    this.orderManager.on('order_opened', onOpened);
    this.orderManager.on('order_partially_filled', onPartialFill);
    this.orderManager.on('order_filled', onFilled);
    this.orderManager.on('order_cancelled', onCancelled);
    this.orderManager.on('order_expired', onExpired);
    this.orderManager.on('order_rejected', onRejected);

    this._eventCleanup = () => {
      this.orderManager.removeListener('order_opened', onOpened);
      this.orderManager.removeListener('order_partially_filled', onPartialFill);
      this.orderManager.removeListener('order_filled', onFilled);
      this.orderManager.removeListener('order_cancelled', onCancelled);
      this.orderManager.removeListener('order_expired', onExpired);
      this.orderManager.removeListener('order_rejected', onRejected);
    };
  }

  private resolveTerminal(status: 'filled' | 'cancelled' | 'rejected' | 'expired', reason?: string): void {
    this.cleanup();
    this._resolve({
      status,
      order: this._order,
      fills: this._fills,
      reason,
    });
  }

  private cleanup(): void {
    if (this._eventCleanup) {
      this._eventCleanup();
      this._eventCleanup = null;
    }
  }

  private isTerminal(): boolean {
    return this._status === 'filled' || this._status === 'cancelled' || this._status === 'rejected' || this._status === 'expired';
  }

  private addHandler(event: HandleEvent, handler: (...args: any[]) => void): void {
    if (!this._handlers.has(event)) {
      this._handlers.set(event, []);
    }
    this._handlers.get(event)!.push(handler);
  }

  private invokeHandlers(event: HandleEvent, ...args: any[]): void {
    const handlers = this._handlers.get(event);
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        handler(...args);
      } catch {
        // Swallow handler errors to avoid breaking the lifecycle
      }
    }
  }
}

// ============================================================================
// OrderManager Implementation
// ============================================================================

export class OrderManager extends EventEmitter {
  // ========== Polymarket Service Dependencies ==========
  private tradingService: TradingService;
  private realtimeService: RealtimeServiceV2 | null = null;
  private polygonProvider: ethers.providers.Provider | null = null;

  // ========== Configuration ==========
  private config: Required<OrderManagerConfig>;
  private initialized = false;

  // ========== Monitoring State ==========
  private watchedOrders: Map<string, WatchedOrder> = new Map();
  private processedEvents: Set<string> = new Set();
  private mode: 'websocket' | 'polling' | 'hybrid';

  // ========== Market Metadata Cache (Polymarket-specific) ==========
  private marketCache: Map<string, MarketMetadata> = new Map();

  constructor(config: OrderManagerConfig) {
    super();

    this.config = {
      ...config,
      chainId: config.chainId ?? 137,
      mode: config.mode ?? 'hybrid',
      pollingInterval: config.pollingInterval ?? 5000,
      polygonRpcUrl: config.polygonRpcUrl ?? 'https://polygon-rpc.com',
    };

    this.mode = this.config.mode;

    // Create default RateLimiter and Cache if not provided
    const rateLimiter = config.rateLimiter || new RateLimiter();
    const cache = config.cache || createUnifiedCache();

    // Initialize TradingService (always needed)
    this.tradingService = new TradingService(
      rateLimiter,
      cache,
      {
        privateKey: config.privateKey,
        chainId: this.config.chainId,
      }
    );
  }

  // ============================================================================
  // Lifecycle Management
  // ============================================================================

  /**
   * Initialize OrderManager
   * - Initializes TradingService
   * - Optionally initializes RealtimeService (for WebSocket mode)
   * - Optionally initializes Polygon provider (for settlement tracking)
   */
  async start(): Promise<void> {
    if (this.initialized) return;

    // Initialize TradingService
    await this.tradingService.initialize();

    // Initialize Polygon provider for settlement tracking
    // (Polymarket-specific: tracks CTF token transfers on Polygon)
    if (this.config.polygonRpcUrl) {
      this.polygonProvider = new ethers.providers.JsonRpcProvider(this.config.polygonRpcUrl);
    }

    this.initialized = true;
    this.emit('initialized');
  }

  /**
   * Stop OrderManager
   * - Unwatch all orders
   * - Disconnect WebSocket (if connected)
   */
  stop(): void {
    // Stop all polling
    for (const watched of this.watchedOrders.values()) {
      if (watched.pollingIntervalId) {
        clearInterval(watched.pollingIntervalId);
      }
    }

    // Disconnect WebSocket
    if (this.realtimeService) {
      this.realtimeService.disconnect();
      this.realtimeService = null;
    }

    this.watchedOrders.clear();
    this.processedEvents.clear();
    this.initialized = false;

    this.emit('stopped');
  }

  // ============================================================================
  // Public API - Order Operations
  // ============================================================================

  /**
   * Create and submit a limit order
   *
   * Auto-validates (Polymarket-specific):
   * - Market state (active, not closed)
   * - USDC.e balance
   * - Tick size (0.01)
   * - Minimum size (5 shares)
   * - Minimum value ($1)
   *
   * Auto-watches: Starts monitoring immediately after creation
   *
   * @param params Order parameters
   * @param metadata Optional metadata for tracking
   * @returns Order result with orderId or error
   */
  async createOrder(
    params: LimitOrderParams,
    metadata?: OrderMetadata
  ): Promise<OrderResult> {
    this.ensureInitialized();

    // Validate order (Polymarket-specific checks)
    try {
      await this.validateOrder(params);
    } catch (error) {
      const rejectEvent: RejectEvent = {
        params,
        reason: error instanceof Error ? error.message : String(error),
        timestamp: Date.now(),
      };
      this.emit('order_rejected', rejectEvent);

      return {
        success: false,
        errorMsg: rejectEvent.reason,
      };
    }

    // Submit order via TradingService
    const result = await this.tradingService.createLimitOrder(params);

    if (result.success && result.orderId) {
      // Auto-watch the order
      this.watchOrder(result.orderId, metadata);

      // Emit order_created event
      this.emit('order_created', {
        id: result.orderId,
        status: OrderStatus.PENDING,
        tokenId: params.tokenId,
        side: params.side,
        price: params.price,
        originalSize: params.size,
        filledSize: 0,
        remainingSize: params.size,
        associateTrades: [],
        createdAt: Date.now(),
      } as Order);
    }

    return result;
  }

  /**
   * Create and submit a market order (FOK or FAK)
   *
   * Market order lifecycle:
   * - FOK (Fill Or Kill): Must fill completely or cancels immediately
   *   PENDING → FILLED (success) or PENDING → CANCELLED (failed to fill)
   * - FAK (Fill And Kill): Fills what it can, cancels the rest
   *   PENDING → PARTIALLY_FILLED + CANCELLED (partial) or PENDING → FILLED (complete)
   *
   * Auto-validates (Polymarket-specific):
   * - Minimum value ($1)
   *
   * Auto-watches: Starts monitoring immediately after creation
   * Note: Market orders typically complete very quickly (within seconds)
   *
   * @param params Market order parameters
   * @param metadata Optional metadata for tracking
   * @returns Order result with orderId or error
   */
  async createMarketOrder(
    params: MarketOrderParams,
    metadata?: OrderMetadata
  ): Promise<OrderResult> {
    this.ensureInitialized();

    // Validate market order (Polymarket-specific checks)
    try {
      await this.validateMarketOrder(params);
    } catch (error) {
      const rejectEvent: RejectEvent = {
        params: params as any, // MarketOrderParams is compatible enough
        reason: error instanceof Error ? error.message : String(error),
        timestamp: Date.now(),
      };
      this.emit('order_rejected', rejectEvent);

      return {
        success: false,
        errorMsg: rejectEvent.reason,
      };
    }

    // Submit market order via TradingService
    const result = await this.tradingService.createMarketOrder(params);

    if (result.success && result.orderId) {
      // Auto-watch the order
      this.watchOrder(result.orderId, {
        ...metadata,
        orderType: params.orderType || 'FOK', // Track order type for lifecycle handling
      });

      // Emit order_created event
      this.emit('order_created', {
        id: result.orderId,
        status: OrderStatus.PENDING,
        tokenId: params.tokenId,
        side: params.side,
        price: params.price || 0, // Market orders may not have a fixed price
        originalSize: params.amount, // For market orders, amount is in USDC
        filledSize: 0,
        remainingSize: params.amount,
        associateTrades: [],
        createdAt: Date.now(),
        orderType: params.orderType || 'FOK',
      } as Order & { orderType: string });
    }

    return result;
  }

  /**
   * Cancel an order
   * Auto-unwatches after cancellation
   */
  async cancelOrder(orderId: string): Promise<OrderResult> {
    this.ensureInitialized();

    const result = await this.tradingService.cancelOrder(orderId);

    if (result.success) {
      // Unwatch order (will stop polling/listening)
      this.unwatchOrder(orderId);
    }

    return result;
  }

  /**
   * Get order details
   * Fetches from TradingService (CLOB API)
   */
  async getOrder(orderId: string): Promise<Order | null> {
    this.ensureInitialized();
    return this.tradingService.getOrder(orderId);
  }

  /**
   * Create multiple orders in batch
   * Auto-watches all successfully created orders
   */
  async createBatchOrders(
    orders: LimitOrderParams[],
    metadata?: OrderMetadata
  ): Promise<OrderResult> {
    this.ensureInitialized();

    const result = await this.tradingService.createBatchOrders(orders);

    if (result.success && result.orderIds) {
      // Auto-watch all created orders
      for (const orderId of result.orderIds) {
        this.watchOrder(orderId, metadata);
      }
    }

    return result;
  }

  // ============================================================================
  // Public API - OrderHandle (Fluent Lifecycle)
  // ============================================================================

  /**
   * Place a limit order and return a fluent OrderHandle.
   *
   * The handle is PromiseLike - await it for the terminal result.
   * Chain lifecycle callbacks for real-time updates.
   *
   * @param params Limit order parameters
   * @param metadata Optional metadata for tracking
   * @returns OrderHandle - chainable, awaitable order lifecycle
   *
   * @example
   * ```typescript
   * const handle = orderManager.placeOrder({
   *   tokenId: '0x...',
   *   side: 'BUY',
   *   price: 0.52,
   *   size: 100,
   * });
   *
   * handle
   *   .onAccepted((order) => console.log('Live:', order.id))
   *   .onFilled((fill) => console.log('Done!'));
   *
   * const result = await handle;
   * ```
   */
  placeOrder(params: LimitOrderParams, metadata?: OrderMetadata): OrderHandle {
    return new OrderHandleImpl(
      this,
      () => this.createOrder(params, metadata),
    );
  }

  /**
   * Place a market order (FOK/FAK) and return a fluent OrderHandle.
   *
   * @param params Market order parameters
   * @param metadata Optional metadata for tracking
   * @returns OrderHandle - chainable, awaitable order lifecycle
   *
   * @example
   * ```typescript
   * const result = await orderManager.placeMarketOrder({
   *   tokenId: '0x...',
   *   side: 'BUY',
   *   amount: 50,
   *   orderType: 'FOK',
   * });
   * console.log(result.status); // 'filled' or 'cancelled'
   * ```
   */
  placeMarketOrder(params: MarketOrderParams, metadata?: OrderMetadata): OrderHandle {
    return new OrderHandleImpl(
      this,
      () => this.createMarketOrder(params, metadata),
    );
  }

  // ============================================================================
  // Public API - Order Monitoring
  // ============================================================================

  /**
   * Manually watch an order
   * Used for monitoring externally-created orders
   *
   * @param orderId Order ID to watch
   * @param metadata Optional metadata
   */
  watchOrder(orderId: string, metadata?: OrderMetadata): void {
    if (this.watchedOrders.has(orderId)) {
      return; // Already watching
    }

    // Create initial watched state
    const watched: WatchedOrder = {
      orderId,
      order: {
        id: orderId,
        status: OrderStatus.PENDING,
        tokenId: '',
        side: 'BUY',
        price: 0,
        originalSize: 0,
        filledSize: 0,
        remainingSize: 0,
        associateTrades: [],
        createdAt: Date.now(),
      },
      metadata,
      lastStatus: OrderStatus.PENDING,
    };

    this.watchedOrders.set(orderId, watched);

    // Start monitoring based on mode
    if (this.mode === 'websocket' || this.mode === 'hybrid') {
      // Fire and forget - WebSocket connection is lazy initialized
      this.ensureWebSocketConnected().catch(err => {
        this.emit('error', new Error(`Failed to establish WebSocket connection: ${err.message}`));
      });
    }

    if (this.mode === 'polling' || this.mode === 'hybrid') {
      this.startPolling(orderId);
    }

    this.emit('watch_started', orderId);
  }

  /**
   * Stop watching an order
   */
  unwatchOrder(orderId: string): void {
    const watched = this.watchedOrders.get(orderId);
    if (!watched) return;

    // Stop polling if active
    if (watched.pollingIntervalId) {
      clearInterval(watched.pollingIntervalId);
    }

    this.watchedOrders.delete(orderId);
    this.emit('watch_stopped', orderId);
  }

  /**
   * Get all watched orders
   */
  getWatchedOrders(): Order[] {
    return Array.from(this.watchedOrders.values()).map((w) => w.order);
  }

  /**
   * Get watched order by ID
   */
  getWatchedOrder(orderId: string): Order | undefined {
    return this.watchedOrders.get(orderId)?.order;
  }

  // ============================================================================
  // Private - Order Validation (Polymarket-specific)
  // ============================================================================

  /**
   * Validate order parameters before submission
   * All checks here are Polymarket-specific
   */
  private async validateOrder(params: LimitOrderParams): Promise<void> {
    // 1. Tick size validation (Polymarket: 0.01)
    // Use integer math to avoid floating point precision issues
    const priceInCents = Math.round(params.price * 100);
    const epsilon = 0.001; // Tolerance for floating point errors
    if (Math.abs(priceInCents - params.price * 100) > epsilon) {
      throw new PolymarketError(
        ErrorCode.ORDER_REJECTED,
        `Price must be multiple of 0.01 tick size (got ${params.price})`
      );
    }

    // 2. Minimum size validation (Polymarket: 5 shares)
    if (params.size < 5) {
      throw new PolymarketError(
        ErrorCode.ORDER_REJECTED,
        `Size must be at least 5 shares (got ${params.size})`
      );
    }

    // 3. Minimum value validation (Polymarket: $1)
    const orderValue = params.price * params.size;
    if (orderValue < 1) {
      throw new PolymarketError(
        ErrorCode.ORDER_REJECTED,
        `Order value must be at least $1 (got $${orderValue.toFixed(2)})`
      );
    }

    // Note: Balance and market state checks would require additional service dependencies
    // For now, we rely on TradingService validation
  }

  /**
   * Validate market order parameters before submission
   * Market orders have simpler validation than limit orders
   */
  private async validateMarketOrder(params: MarketOrderParams): Promise<void> {
    // 1. Minimum value validation (Polymarket: $1)
    if (params.amount < 1) {
      throw new PolymarketError(
        ErrorCode.ORDER_REJECTED,
        `Order amount must be at least $1 (got $${params.amount.toFixed(2)})`
      );
    }

    // 2. Validate order type if specified
    if (params.orderType && !['FOK', 'FAK'].includes(params.orderType)) {
      throw new PolymarketError(
        ErrorCode.ORDER_REJECTED,
        `Invalid market order type: ${params.orderType}. Must be FOK or FAK.`
      );
    }

    // Note: Price validation is optional for market orders
    // If price is provided, it's used as a limit price (max for BUY, min for SELL)
  }

  // ============================================================================
  // Private - WebSocket Monitoring (Polymarket-specific)
  // ============================================================================

  /**
   * Ensure WebSocket connection is established
   * Lazy initialization of RealtimeService
   */
  private async ensureWebSocketConnected(): Promise<void> {
    if (this.realtimeService) return;

    // Import and initialize RealtimeServiceV2
    // (We use dynamic import to avoid circular dependencies)
    const { RealtimeServiceV2 } = await import('./realtime-service-v2.js');
    this.realtimeService = new RealtimeServiceV2({ autoReconnect: true });

    // Connect to WebSocket
    if (this.realtimeService) {
      this.realtimeService.connect();
    }

    // Subscribe to user events (requires credentials)
    const credentials = this.tradingService.getCredentials();
    if (credentials && this.realtimeService) {
      // Map ApiCredentials (key) to ClobApiKeyCreds (apiKey) format
      const clobAuth = {
        apiKey: credentials.key,
        secret: credentials.secret,
        passphrase: credentials.passphrase,
      };
      this.realtimeService.subscribeUserEvents(clobAuth, {
        onOrder: this.handleUserOrder.bind(this),
        onTrade: this.handleUserTrade.bind(this),
      });
    }
  }

  /**
   * Handle USER_ORDER WebSocket event (Polymarket-specific)
   * Triggered on: PLACEMENT, UPDATE, CANCELLATION
   */
  private handleUserOrder(userOrder: UserOrder): void {
    const watched = this.watchedOrders.get(userOrder.orderId);
    if (!watched) return; // Not watching this order

    // Deduplicate events
    const eventKey = `order_${userOrder.orderId}_${userOrder.timestamp}_${userOrder.eventType}`;
    if (this.processedEvents.has(eventKey)) return;
    this.processedEvents.add(eventKey);

    // Update order state
    watched.order.price = userOrder.price;
    watched.order.originalSize = userOrder.originalSize;
    watched.order.filledSize = userOrder.matchedSize;
    watched.order.remainingSize = userOrder.originalSize - userOrder.matchedSize;

    // Infer new status
    let newStatus = watched.lastStatus;

    if (userOrder.eventType === 'PLACEMENT') {
      newStatus = OrderStatus.OPEN;
    } else if (userOrder.eventType === 'UPDATE') {
      if (userOrder.matchedSize > 0) {
        newStatus =
          userOrder.matchedSize >= userOrder.originalSize
            ? OrderStatus.FILLED
            : OrderStatus.PARTIALLY_FILLED;
      }
    } else if (userOrder.eventType === 'CANCELLATION') {
      newStatus = OrderStatus.CANCELLED;
    }

    // Emit status change if changed
    if (newStatus !== watched.lastStatus) {
      this.emitStatusChange(watched, newStatus, 'websocket');
    }
  }

  /**
   * Handle USER_TRADE WebSocket event (Polymarket-specific)
   * Triggered when: MATCHED, MINED, CONFIRMED
   *
   * Order lookup priority:
   * 1. takerOrderId - if we placed a market order (FOK/FAK) or taker limit order
   * 2. makerOrders[].orderId - if our limit order was matched as maker
   */
  private async handleUserTrade(userTrade: UserTrade): Promise<void> {
    // Find the watched order using takerOrderId or makerOrders
    let watched: WatchedOrder | undefined;

    // Priority 1: Check if we're the taker
    if (userTrade.takerOrderId) {
      watched = this.watchedOrders.get(userTrade.takerOrderId);
    }

    // Priority 2: Check if we're a maker
    if (!watched && userTrade.makerOrders) {
      for (const maker of userTrade.makerOrders) {
        watched = this.watchedOrders.get(maker.orderId);
        if (watched) break;
      }
    }

    if (!watched) return;

    // Deduplicate events
    const eventKey = `trade_${userTrade.tradeId}_${userTrade.status}_${userTrade.timestamp}`;
    if (this.processedEvents.has(eventKey)) return;
    this.processedEvents.add(eventKey);

    // Emit fill event
    // Calculate remaining size after this fill
    const remainingAfterFill = watched.order.originalSize - (watched.order.filledSize + userTrade.size);
    // Complete fill if: sum >= originalSize OR remaining is zero/negative
    // Note: For market orders (FOK/FAK), originalSize is in USDC but filledSize is in shares,
    // causing remainingAfterFill to be negative. This is still a complete fill.
    const isCompleteFill = watched.order.filledSize + userTrade.size >= watched.order.originalSize ||
      remainingAfterFill <= 0;

    const fillEvent: FillEvent = {
      orderId: watched.orderId,
      order: watched.order,
      fill: {
        tradeId: userTrade.tradeId,
        size: userTrade.size,
        price: userTrade.price,
        fee: 0, // Fee info not in UserTrade
        timestamp: userTrade.timestamp,
        transactionHash: userTrade.transactionHash,
      },
      cumulativeFilled: watched.order.filledSize + userTrade.size,
      remainingSize: watched.order.originalSize - (watched.order.filledSize + userTrade.size),
      isCompleteFill,
    };

    if (isCompleteFill) {
      this.emit('order_filled', fillEvent);
    } else {
      this.emit('order_partially_filled', fillEvent);
    }

    // If trade has transaction hash, emit transaction event
    if (userTrade.transactionHash) {
      const txEvent: TransactionEvent = {
        orderId: watched.orderId,
        tradeId: userTrade.tradeId,
        transactionHash: userTrade.transactionHash,
        timestamp: Date.now(),
      };
      this.emit('transaction_submitted', txEvent);

      // Start tracking settlement on Polygon
      if (userTrade.status === 'CONFIRMED') {
        await this.trackSettlement(userTrade.tradeId, userTrade.transactionHash, watched.orderId);
      }
    }
  }

  // ============================================================================
  // Private - Polling Monitoring
  // ============================================================================

  /**
   * Start polling for order status
   * Fallback mechanism when WebSocket is unavailable
   */
  private startPolling(orderId: string): void {
    const watched = this.watchedOrders.get(orderId);
    if (!watched || watched.pollingIntervalId) return;

    const poll = async () => {
      try {
        const order = await this.tradingService.getOrder(orderId);
        if (order) {
          this.updateWatchedOrder(orderId, order);
        }
      } catch (error) {
        this.emit('error', new Error(`Polling error for ${orderId}: ${error}`));
      }
    };

    // Initial poll
    poll();

    // Set up interval
    watched.pollingIntervalId = setInterval(poll, this.config.pollingInterval);
  }

  /**
   * Update watched order from polling result
   * Detects both status changes and fill changes
   */
  private updateWatchedOrder(orderId: string, freshOrder: Order): void {
    const watched = this.watchedOrders.get(orderId);
    if (!watched) return;

    const oldStatus = watched.lastStatus;
    const oldFilledSize = watched.order.filledSize;
    const newStatus = freshOrder.status;
    const newFilledSize = freshOrder.filledSize;

    // Detect fill changes (size increased)
    // Only emit if this is an actual increase from a previously known state
    if (newFilledSize > oldFilledSize && oldFilledSize >= 0) {
      const fillDelta = newFilledSize - oldFilledSize;
      // Check for complete fill using status (preferred) or remainingSize
      // Note: For market orders (FOK/FAK), remainingSize may be negative due to unit mismatch
      // (originalSize is in USDC, filledSize is in shares), so we rely on status
      const isCompleteFill = freshOrder.status === OrderStatus.FILLED ||
        freshOrder.remainingSize === 0 ||
        freshOrder.remainingSize <= 0;

      // Deduplicate fill events using fill size as key
      const eventKey = `fill_${orderId}_${newFilledSize}`;
      if (!this.processedEvents.has(eventKey)) {
        this.processedEvents.add(eventKey);

        // Estimate fill price from order price or calculate from avg
        // Note: OpenOrder doesn't have avgFillPrice, so we use order.price as estimate
        const estimatedPrice = freshOrder.price;

        const fillEvent: FillEvent = {
          orderId,
          order: freshOrder,
          fill: {
            tradeId: freshOrder.associateTrades[freshOrder.associateTrades.length - 1] || `polling_${Date.now()}`,
            size: fillDelta,
            price: estimatedPrice,
            fee: 0, // Fee info not available in polling
            timestamp: Date.now(),
          },
          cumulativeFilled: newFilledSize,
          remainingSize: freshOrder.remainingSize,
          isCompleteFill,
        };

        if (isCompleteFill) {
          this.emit('order_filled', fillEvent);
        } else {
          this.emit('order_partially_filled', fillEvent);
        }
      }
    }

    // Update order
    watched.order = freshOrder;

    // Emit status change if changed
    // Pass flag to prevent duplicate fill events
    if (newStatus !== oldStatus) {
      this.emitStatusChange(watched, newStatus, 'polling', newFilledSize > oldFilledSize);
    }
  }

  // ============================================================================
  // Private - Status Change Emission
  // ============================================================================

  /**
   * Emit status change event with appropriate specific events
   * @param fillAlreadyEmitted - Set to true if fill event was already emitted (to prevent duplicates)
   */
  private emitStatusChange(
    watched: WatchedOrder,
    newStatus: OrderStatus,
    source: 'websocket' | 'polling',
    fillAlreadyEmitted = false
  ): void {
    const oldStatus = watched.lastStatus;

    // Validate transition
    if (!isValidStatusTransition(oldStatus, newStatus)) {
      this.emit(
        'error',
        new Error(`Invalid status transition: ${oldStatus} → ${newStatus} for ${watched.orderId}`)
      );
      return;
    }

    // Update status
    watched.lastStatus = newStatus;
    watched.order.status = newStatus;
    watched.order.updatedAt = Date.now();

    // Emit generic status_change event
    const changeEvent: OrderStatusChangeEvent = {
      orderId: watched.orderId,
      from: oldStatus,
      to: newStatus,
      order: watched.order,
      timestamp: Date.now(),
      reason: source,
    };
    this.emit('status_change', changeEvent);

    // Emit specific events
    if (newStatus === OrderStatus.OPEN) {
      this.emit('order_opened', watched.order);
    } else if (newStatus === OrderStatus.FILLED && !fillAlreadyEmitted) {
      // Only emit fill event if not already emitted (from polling fill detection)
      this.emit('order_filled', {
        orderId: watched.orderId,
        order: watched.order,
        fill: {
          tradeId: watched.order.associateTrades[watched.order.associateTrades.length - 1] || '',
          size: watched.order.filledSize,
          price: watched.order.price,
          fee: 0,
          timestamp: Date.now(),
        },
        cumulativeFilled: watched.order.filledSize,
        remainingSize: 0,
        isCompleteFill: true,
      } as FillEvent);
    } else if (newStatus === OrderStatus.CANCELLED) {
      const cancelEvent: CancelEvent = {
        orderId: watched.orderId,
        order: watched.order,
        filledSize: watched.order.filledSize,
        cancelledSize: watched.order.remainingSize,
        reason: 'user',
        timestamp: Date.now(),
      };
      this.emit('order_cancelled', cancelEvent);
    } else if (newStatus === OrderStatus.EXPIRED) {
      const expireEvent: ExpireEvent = {
        orderId: watched.orderId,
        order: watched.order,
        filledSize: watched.order.filledSize,
        expiredSize: watched.order.remainingSize,
        expirationTime: watched.order.expiration || 0,
        timestamp: Date.now(),
      };
      this.emit('order_expired', expireEvent);
    }

    // Auto-unwatch terminal states
    if (isTerminalStatus(newStatus)) {
      this.unwatchOrder(watched.orderId);
    }
  }

  // ============================================================================
  // Private - Chain Settlement Tracking (Polymarket-specific)
  // ============================================================================

  /**
   * Track transaction settlement on Polygon blockchain
   * Waits for on-chain confirmation and emits transaction_confirmed event
   */
  private async trackSettlement(
    tradeId: string,
    transactionHash: string,
    orderId: string
  ): Promise<void> {
    if (!this.polygonProvider) {
      return; // No provider configured
    }

    try {
      // Wait for 1 confirmation
      const receipt = await this.polygonProvider.waitForTransaction(transactionHash, 1);

      if (receipt) {
        const settlementEvent: SettlementEvent = {
          orderId,
          tradeId,
          transactionHash,
          blockNumber: receipt.blockNumber,
          gasUsed: receipt.gasUsed.toString(),
          timestamp: Date.now(),
        };

        this.emit('transaction_confirmed', settlementEvent);
      }
    } catch (error) {
      this.emit(
        'error',
        new Error(`Settlement tracking failed for ${transactionHash}: ${error}`)
      );
    }
  }

  // ============================================================================
  // Private - Utilities
  // ============================================================================

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new PolymarketError(
        ErrorCode.ORDER_FAILED,
        'OrderManager not initialized. Call start() first.'
      );
    }
  }
}
