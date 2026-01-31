/**
 * TradingService
 *
 * Trading service using official @polymarket/clob-client.
 *
 * Provides:
 * - Order creation (limit, market)
 * - Order management (cancel, query)
 * - Rewards tracking
 * - Balance management
 *
 * Important: Polymarket enforces minimum order requirements:
 * - Minimum order size: 5 shares (MIN_ORDER_SIZE_SHARES)
 * - Minimum order value: $1 USDC (MIN_ORDER_VALUE_USDC)
 * Orders below these limits are validated and rejected before sending to API.
 *
 * Note: Market data methods have been moved to MarketService.
 */

import {
  ClobClient,
  Side as ClobSide,
  OrderType as ClobOrderType,
  Chain,
  type OpenOrder,
  type Trade as ClobTrade,
  type TickSize,
} from '@polymarket/clob-client';

import { Wallet } from 'ethers';
import { RateLimiter, ApiType } from '../core/rate-limiter.js';
import type { UnifiedCache } from '../core/unified-cache.js';
import { CACHE_TTL } from '../core/unified-cache.js';
import { PolymarketError, ErrorCode } from '../core/errors.js';
import type { Side, OrderType } from '../core/types.js';
import { OrderStatus } from '../core/types.js';
import {
  mapApiStatusToInternal,
  isOrderOpen,
  canOrderBeCancelled,
  calculateOrderProgress,
} from '../core/order-status.js';

// Chain IDs
export const POLYGON_MAINNET = 137;
export const POLYGON_AMOY = 80002;

// CLOB Host
const CLOB_HOST = 'https://clob.polymarket.com';

// ============================================================================
// Polymarket Order Minimums
// ============================================================================
// These are enforced by Polymarket's CLOB API. Orders below these limits will
// be rejected with errors like:
// - "invalid amount for a marketable BUY order ($X), min size: $1"
// - "Size (X) lower than the minimum: 5"
//
// NOTE: minimum_order_size is MARKET-SPECIFIC (retrieved via CLOB API):
// - SOL/BTC/ETH 15-minute markets: 5 shares
// - Sports markets: 15 shares
// - Some markets: 0 shares
// Use LimitOrderParams.minimumOrderSize to pass the market-specific value.
//
// Strategies should ensure orders meet these requirements BEFORE sending.
// ============================================================================

/** Minimum order value in USDC (price * size >= MIN_ORDER_VALUE) */
export const MIN_ORDER_VALUE_USDC = 1;

/** Default minimum order size in shares (fallback if market-specific value not provided) */
export const MIN_ORDER_SIZE_SHARES = 5;

// ============================================================================
// Types
// ============================================================================

// Side and OrderType are imported from core/types.ts
// Re-export for backward compatibility
export type { Side, OrderType } from '../core/types.js';

export interface ApiCredentials {
  key: string;
  secret: string;
  passphrase: string;
}

export interface TradingServiceConfig {
  /** Private key for signing */
  privateKey: string;
  /** Chain ID (default: Polygon mainnet 137) */
  chainId?: number;
  /** Pre-generated API credentials (optional) */
  credentials?: ApiCredentials;
}

// Order types
export interface LimitOrderParams {
  tokenId: string;
  side: Side;
  price: number;
  size: number;
  orderType?: 'GTC' | 'GTD';
  expiration?: number;
  /** Market-specific minimum order size (from CLOB API). Falls back to MIN_ORDER_SIZE_SHARES if not provided. */
  minimumOrderSize?: number;
}

export interface MarketOrderParams {
  tokenId: string;
  side: Side;
  amount: number;
  price?: number;
  orderType?: 'FOK' | 'FAK';
}

/**
 * Order representation with detailed status tracking
 *
 * Status Flow:
 * pending → open → partially_filled → filled
 *              ↓         ↓               (or)
 *          cancelled  cancelled       expired
 *
 * @see OrderStatus enum for detailed state documentation
 */
export interface Order {
  id: string;
  /** Current order status - see OrderStatus enum for state machine */
  status: OrderStatus;
  tokenId: string;
  side: Side;
  price: number;
  originalSize: number;
  filledSize: number;
  remainingSize: number;
  associateTrades: string[];
  createdAt: number;

  /**
   * Last update timestamp
   * Updated on: status change, new fill, cancellation
   */
  updatedAt?: number;

  /**
   * Expiration timestamp (for GTD orders)
   * undefined for GTC orders
   */
  expiration?: number;
}

export interface OrderResult {
  success: boolean;
  orderId?: string;
  orderIds?: string[];
  errorMsg?: string;
  transactionHashes?: string[];
}

export interface TradeInfo {
  id: string;
  tokenId: string;
  side: Side;
  price: number;
  size: number;
  fee: number;
  timestamp: number;
}

// Rewards types
export interface UserEarning {
  date: string;
  conditionId: string;
  assetAddress: string;
  makerAddress: string;
  earnings: number;
  assetRate: number;
}

export interface MarketReward {
  conditionId: string;
  question: string;
  marketSlug: string;
  eventSlug: string;
  rewardsMaxSpread: number;
  rewardsMinSize: number;
  tokens: Array<{ tokenId: string; outcome: string; price: number }>;
  rewardsConfig: Array<{
    assetAddress: string;
    startDate: string;
    endDate: string;
    ratePerDay: number;
    totalRewards: number;
  }>;
}

/**
 * Market reward configuration for a specific market
 */
export interface MarketRewardConfig {
  conditionId: string;
  question: string;
  /** Maximum qualifying spread for rewards */
  maxSpread: number;
  /** Minimum order size for rewards */
  minSize: number;
  /** Daily reward rate in USDC */
  dailyRate: number;
  /** Total reward pool in USDC */
  totalPool: number;
  /** Reward period start date */
  startDate: string;
  /** Reward period end date */
  endDate: string;
  /** Whether rewards are currently active */
  isActive: boolean;
}

/**
 * Parameters for Q-Score estimation
 */
export interface QScoreParams {
  /** Your bid-ask spread */
  spread: number;
  /** Maximum qualifying spread (from market rewards) */
  maxSpread: number;
  /** Order size in shares */
  orderSize: number;
  /** Whether quoting both sides (YES and NO) */
  isTwoSided?: boolean;
}

/**
 * Q-Score estimation result
 */
export interface QScoreEstimate {
  /** Raw Q-Score before two-sided multiplier */
  score: number;
  /** Effective score after multiplier */
  effectiveScore: number;
  /** Your spread */
  spread: number;
  /** Maximum qualifying spread */
  maxSpread: number;
  /** Order size */
  orderSize: number;
  /** Whether two-sided */
  isTwoSided: boolean;
  /** Estimated percentile ranking */
  percentile: 'top10' | 'top25' | 'top50' | 'average' | 'below_average' | 'below_threshold';
  /** Optimization suggestions */
  suggestions: string[];
}

/**
 * Rewards summary for a date range
 */
export interface RewardsSummary {
  startDate: string;
  endDate: string;
  /** Total earnings in USDC */
  totalEarnings: number;
  /** Average daily earnings */
  averageDailyEarnings: number;
  /** Number of markets earned from */
  marketCount: number;
  /** Best performing market */
  bestMarket: { conditionId: string; earnings: number };
  /** Number of days in range */
  totalDays: number;
}

/**
 * Top reward market information
 */
export interface TopRewardMarket {
  conditionId: string;
  question: string;
  marketSlug: string;
  /** Daily reward rate */
  dailyRate: number;
  /** Total reward pool */
  totalPool: number;
  /** Maximum qualifying spread */
  maxSpread: number;
  /** Minimum order size */
  minSize: number;
  /** Recommended spread for good Q-Score (40% of max) */
  recommendedSpread: number;
  /** Token information */
  tokens: Array<{ tokenId: string; outcome: string; price: number }>;
}

// ============================================================================
// TradingService Implementation
// ============================================================================

export class TradingService {
  private clobClient: ClobClient | null = null;
  private wallet: Wallet;
  private chainId: Chain;
  private credentials: ApiCredentials | null = null;
  private initialized = false;
  private tickSizeCache: Map<string, string> = new Map();
  private negRiskCache: Map<string, boolean> = new Map();

  constructor(
    private rateLimiter: RateLimiter,
    private cache: UnifiedCache,
    private config: TradingServiceConfig
  ) {
    this.wallet = new Wallet(config.privateKey);
    this.chainId = (config.chainId || POLYGON_MAINNET) as Chain;
    this.credentials = config.credentials || null;
  }

  // ============================================================================
  // Initialization
  // ============================================================================

  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Create CLOB client with L1 auth (wallet)
    this.clobClient = new ClobClient(CLOB_HOST, this.chainId, this.wallet);

    // Get or create API credentials
    // We use derive-first strategy (opposite of official createOrDeriveApiKey)
    // because most users already have a key, avoiding unnecessary 400 error logs.
    if (!this.credentials) {
      const creds = await this.deriveOrCreateApiKey();
      this.credentials = {
        key: creds.key,
        secret: creds.secret,
        passphrase: creds.passphrase,
      };
    }

    // Re-initialize with L2 auth (credentials)
    this.clobClient = new ClobClient(
      CLOB_HOST,
      this.chainId,
      this.wallet,
      {
        key: this.credentials.key,
        secret: this.credentials.secret,
        passphrase: this.credentials.passphrase,
      }
    );

    this.initialized = true;
  }

  /**
   * Try to derive existing API key first, create new one if not exists.
   * This is the reverse of official createOrDeriveApiKey() to avoid
   * 400 "Could not create api key" error log for existing keys.
   */
  private async deriveOrCreateApiKey(): Promise<{ key: string; secret: string; passphrase: string }> {
    // First try to derive existing key (most common case for existing users)
    const derived = await this.clobClient!.deriveApiKey();
    if (derived.key) {
      return derived;
    }

    // Derive failed (key doesn't exist), create new key (first-time users)
    const created = await this.clobClient!.createApiKey();
    if (!created.key) {
      throw new PolymarketError(
        ErrorCode.AUTH_FAILED,
        'Failed to create or derive API key. Wallet may not be registered on Polymarket.'
      );
    }
    return created;
  }

  private async ensureInitialized(): Promise<ClobClient> {
    if (!this.initialized || !this.clobClient) {
      await this.initialize();
    }
    return this.clobClient!;
  }

  // ============================================================================
  // Trading Helpers
  // ============================================================================

  /**
   * Get tick size for a token
   */
  async getTickSize(tokenId: string): Promise<TickSize> {
    if (this.tickSizeCache.has(tokenId)) {
      return this.tickSizeCache.get(tokenId)! as TickSize;
    }

    const client = await this.ensureInitialized();
    const tickSize = await client.getTickSize(tokenId);
    this.tickSizeCache.set(tokenId, tickSize);
    return tickSize;
  }

  /**
   * Check if token is neg risk
   */
  async isNegRisk(tokenId: string): Promise<boolean> {
    if (this.negRiskCache.has(tokenId)) {
      return this.negRiskCache.get(tokenId)!;
    }

    const client = await this.ensureInitialized();
    const negRisk = await client.getNegRisk(tokenId);
    this.negRiskCache.set(tokenId, negRisk);
    return negRisk;
  }

  // ============================================================================
  // Order Creation
  // ============================================================================

  /**
   * Create and post a limit order
   *
   * Note: Polymarket enforces minimum order requirements:
   * - Minimum size: 5 shares (MIN_ORDER_SIZE_SHARES)
   * - Minimum value: $1 USDC (MIN_ORDER_VALUE_USDC)
   *
   * Orders below these limits will be rejected by the API.
   */
  async createLimitOrder(params: LimitOrderParams): Promise<OrderResult> {
    // Validate minimum order requirements before sending to API
    // Use market-specific minimum if provided, otherwise fall back to global default
    const minOrderSize = params.minimumOrderSize ?? MIN_ORDER_SIZE_SHARES;
    if (params.size < minOrderSize) {
      return {
        success: false,
        errorMsg: `Order size (${params.size}) is below Polymarket minimum (${minOrderSize} shares)`,
      };
    }

    const orderValue = params.price * params.size;
    if (orderValue < MIN_ORDER_VALUE_USDC) {
      return {
        success: false,
        errorMsg: `Order value ($${orderValue.toFixed(2)}) is below Polymarket minimum ($${MIN_ORDER_VALUE_USDC})`,
      };
    }

    const client = await this.ensureInitialized();

    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      try {
        const [tickSize, negRisk] = await Promise.all([
          this.getTickSize(params.tokenId),
          this.isNegRisk(params.tokenId),
        ]);

        const orderType = params.orderType === 'GTD' ? ClobOrderType.GTD : ClobOrderType.GTC;

        const result = await client.createAndPostOrder(
          {
            tokenID: params.tokenId,
            side: params.side === 'BUY' ? ClobSide.BUY : ClobSide.SELL,
            price: params.price,
            size: params.size,
            expiration: params.expiration || 0,
          },
          { tickSize, negRisk },
          orderType
        );

        const success = result.success === true ||
          (result.success !== false &&
            ((result.orderID !== undefined && result.orderID !== '') ||
              (result.transactionsHashes !== undefined && result.transactionsHashes.length > 0)));

        return {
          success,
          orderId: result.orderID,
          orderIds: result.orderIDs,
          errorMsg: result.errorMsg,
          transactionHashes: result.transactionsHashes,
        };
      } catch (error) {
        return {
          success: false,
          errorMsg: `Order failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    });
  }

  /**
   * Create and post a market order
   *
   * Note: Polymarket enforces minimum order requirements:
   * - Minimum value: $1 USDC (MIN_ORDER_VALUE_USDC)
   *
   * Market orders below this limit will be rejected by the API.
   */
  async createMarketOrder(params: MarketOrderParams): Promise<OrderResult> {
    // Validate minimum order value before sending to API
    if (params.amount < MIN_ORDER_VALUE_USDC) {
      return {
        success: false,
        errorMsg: `Order amount ($${params.amount.toFixed(2)}) is below Polymarket minimum ($${MIN_ORDER_VALUE_USDC})`,
      };
    }

    const client = await this.ensureInitialized();

    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      try {
        const [tickSize, negRisk] = await Promise.all([
          this.getTickSize(params.tokenId),
          this.isNegRisk(params.tokenId),
        ]);

        const orderType = params.orderType === 'FAK' ? ClobOrderType.FAK : ClobOrderType.FOK;

        const result = await client.createAndPostMarketOrder(
          {
            tokenID: params.tokenId,
            side: params.side === 'BUY' ? ClobSide.BUY : ClobSide.SELL,
            amount: params.amount,
            price: params.price,
          },
          { tickSize, negRisk },
          orderType
        );

        const success = result.success === true ||
          (result.success !== false &&
            ((result.orderID !== undefined && result.orderID !== '') ||
              (result.transactionsHashes !== undefined && result.transactionsHashes.length > 0)));

        return {
          success,
          orderId: result.orderID,
          orderIds: result.orderIDs,
          errorMsg: result.errorMsg,
          transactionHashes: result.transactionsHashes,
        };
      } catch (error) {
        return {
          success: false,
          errorMsg: `Market order failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    });
  }

  /**
   * Create and post multiple limit orders in a batch
   *
   * Note: Polymarket enforces:
   * - Maximum 15 orders per batch
   * - Same minimum requirements as single orders (5 shares, $1 value)
   *
   * This method uses Polymarket's batch API (POST /orders) which submits
   * all orders in a single HTTP request, significantly faster than individual calls.
   *
   * @param orders - Array of limit order parameters (max 15)
   * @returns Batch result with individual order IDs or errors
   */
  async createBatchOrders(orders: LimitOrderParams[]): Promise<OrderResult> {
    // Validate batch size
    if (orders.length === 0) {
      return {
        success: false,
        errorMsg: 'Batch must contain at least one order',
      };
    }

    if (orders.length > 15) {
      return {
        success: false,
        errorMsg: `Batch size (${orders.length}) exceeds Polymarket maximum (15 orders)`,
      };
    }

    // Validate each order
    const validationErrors: string[] = [];
    for (let i = 0; i < orders.length; i++) {
      const order = orders[i];
      // Use market-specific minimum if provided, otherwise fall back to global default
      const minOrderSize = order.minimumOrderSize ?? MIN_ORDER_SIZE_SHARES;
      if (order.size < minOrderSize) {
        validationErrors.push(`Order ${i}: size (${order.size}) below minimum (${minOrderSize} shares)`);
      }
      const orderValue = order.price * order.size;
      if (orderValue < MIN_ORDER_VALUE_USDC) {
        validationErrors.push(`Order ${i}: value ($${orderValue.toFixed(2)}) below minimum ($${MIN_ORDER_VALUE_USDC})`);
      }
    }

    if (validationErrors.length > 0) {
      return {
        success: false,
        errorMsg: `Batch validation failed:\n${validationErrors.join('\n')}`,
      };
    }

    const client = await this.ensureInitialized();

    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      try {
        // Step 1: Get tick sizes and neg risk flags for all unique tokens
        const uniqueTokenIds = [...new Set(orders.map(o => o.tokenId))];
        const tokenMetadata = new Map<string, { tickSize: TickSize; negRisk: boolean }>();

        await Promise.all(
          uniqueTokenIds.map(async tokenId => {
            const [tickSize, negRisk] = await Promise.all([
              this.getTickSize(tokenId),
              this.isNegRisk(tokenId),
            ]);
            tokenMetadata.set(tokenId, { tickSize, negRisk });
          })
        );

        // Step 2: Create signed orders (without posting)
        const signedOrders = await Promise.all(
          orders.map(async order => {
            const metadata = tokenMetadata.get(order.tokenId)!;
            const orderType = order.orderType === 'GTD' ? ClobOrderType.GTD : ClobOrderType.GTC;

            return {
              signedOrder: await client.createOrder(
                {
                  tokenID: order.tokenId,
                  side: order.side === 'BUY' ? ClobSide.BUY : ClobSide.SELL,
                  price: order.price,
                  size: order.size,
                  expiration: order.expiration || 0,
                },
                {
                  tickSize: metadata.tickSize,
                  negRisk: metadata.negRisk,
                }
              ),
              orderType,
            };
          })
        );

        // Step 3: Batch submit all signed orders in a single request
        const batchArgs = signedOrders.map(({ signedOrder, orderType }) => ({
          order: signedOrder,
          orderType,
        }));

        const results = await client.postOrders(batchArgs);

        // Step 4: Process batch response
        const successfulOrderIds: string[] = [];
        const errors: string[] = [];

        if (Array.isArray(results)) {
          results.forEach((result, index) => {
            if (result.success === true || result.orderID) {
              if (result.orderID) {
                successfulOrderIds.push(result.orderID);
              }
            } else if (result.errorMsg) {
              errors.push(`Order ${index}: ${result.errorMsg}`);
            }
          });
        }

        const totalSuccess = successfulOrderIds.length;
        const totalFailed = orders.length - totalSuccess;

        return {
          success: totalSuccess > 0,
          orderIds: successfulOrderIds,
          errorMsg: errors.length > 0
            ? `Batch: ${totalSuccess} succeeded, ${totalFailed} failed.\n${errors.join('\n')}`
            : undefined,
        };
      } catch (error) {
        return {
          success: false,
          errorMsg: `Batch order failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    });
  }

  // ============================================================================
  // Order Management
  // ============================================================================

  /**
   * Get a single order by ID
   *
   * @param orderId - Order ID (hash)
   * @returns Order details or null if not found
   */
  async getOrder(orderId: string): Promise<Order | null> {
    const client = await this.ensureInitialized();

    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      try {
        const order = await client.getOrder(orderId);
        if (!order) return null;

        const originalSize = Number(order.original_size) || 0;
        const filledSize = Number(order.size_matched) || 0;
        return {
          id: order.id,
          status: mapApiStatusToInternal(order),
          tokenId: order.asset_id,
          side: order.side.toUpperCase() as Side,
          price: Number(order.price) || 0,
          originalSize,
          filledSize,
          remainingSize: originalSize - filledSize,
          associateTrades: order.associate_trades || [],
          createdAt: order.created_at,
          updatedAt: Date.now(),
          expiration: order.expiration ? Number(order.expiration) : undefined,
        };
      } catch (error) {
        // If order not found, return null instead of throwing
        if (error instanceof Error && error.message.includes('not found')) {
          return null;
        }
        throw new PolymarketError(
          ErrorCode.ORDER_FAILED,
          `Get order failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    });
  }

  async cancelOrder(orderId: string): Promise<OrderResult> {
    const client = await this.ensureInitialized();

    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      try {
        const result = await client.cancelOrder({ orderID: orderId });
        return { success: result.canceled ?? false, orderId };
      } catch (error) {
        throw new PolymarketError(
          ErrorCode.ORDER_FAILED,
          `Cancel failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    });
  }

  async cancelOrders(orderIds: string[]): Promise<OrderResult> {
    const client = await this.ensureInitialized();

    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      try {
        const result = await client.cancelOrders(orderIds);
        return { success: result.canceled ?? false, orderIds };
      } catch (error) {
        throw new PolymarketError(
          ErrorCode.ORDER_FAILED,
          `Cancel orders failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    });
  }

  async cancelAllOrders(): Promise<OrderResult> {
    const client = await this.ensureInitialized();

    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      try {
        const result = await client.cancelAll();
        return { success: result.canceled ?? false };
      } catch (error) {
        throw new PolymarketError(
          ErrorCode.ORDER_FAILED,
          `Cancel all failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    });
  }

  /**
   * Cancel orders by market or asset
   *
   * @param marketId - Market condition ID (optional)
   * @param assetId - Token ID (optional)
   * @returns Cancel result with canceled order IDs
   */
  async cancelMarketOrders(marketId?: string, assetId?: string): Promise<OrderResult> {
    const client = await this.ensureInitialized();

    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      try {
        const result = await client.cancelMarketOrders({ market: marketId, asset_id: assetId });
        return {
          success: (result.canceled?.length ?? 0) > 0 || Object.keys(result.not_canceled || {}).length === 0,
          orderIds: result.canceled,
        };
      } catch (error) {
        throw new PolymarketError(
          ErrorCode.ORDER_FAILED,
          `Cancel market orders failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    });
  }

  async getOpenOrders(marketId?: string): Promise<Order[]> {
    const client = await this.ensureInitialized();

    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      const orders = await client.getOpenOrders(marketId ? { market: marketId } : undefined);

      return orders.map((o: OpenOrder) => {
        const originalSize = Number(o.original_size) || 0;
        const filledSize = Number(o.size_matched) || 0;
        return {
          id: o.id,
          status: mapApiStatusToInternal(o),
          tokenId: o.asset_id,
          side: o.side.toUpperCase() as Side,
          price: Number(o.price) || 0,
          originalSize,
          filledSize,
          remainingSize: originalSize - filledSize,
          associateTrades: o.associate_trades || [],
          createdAt: o.created_at,
          updatedAt: Date.now(),
          expiration: o.expiration ? Number(o.expiration) : undefined,
        };
      });
    });
  }

  /**
   * Check if an order can be cancelled
   *
   * Orders can be cancelled if they are in OPEN or PARTIALLY_FILLED status.
   * Orders in terminal states (FILLED, CANCELLED, EXPIRED, REJECTED) or
   * PENDING state cannot be cancelled via API.
   *
   * @param orderId - Order ID to check
   * @returns Promise<boolean> - true if order can be cancelled
   *
   * @example
   * ```typescript
   * const canCancel = await sdk.trading.canCancelOrder(orderId);
   * if (canCancel) {
   *   await sdk.trading.cancelOrder(orderId);
   * }
   * ```
   */
  async canCancelOrder(orderId: string): Promise<boolean> {
    const order = await this.getOrder(orderId);
    if (!order) return false;
    return canOrderBeCancelled(order.status);
  }

  /**
   * Get order fill progress as percentage
   *
   * Returns the percentage of the order that has been filled (0-100).
   * Useful for tracking partial fills and displaying progress.
   *
   * @param orderId - Order ID to check
   * @returns Promise<number | null> - Fill percentage (0-100) or null if order not found
   *
   * @example
   * ```typescript
   * const progress = await sdk.trading.getOrderProgress(orderId);
   * if (progress !== null) {
   *   console.log(`Order ${progress.toFixed(1)}% filled`);
   * }
   * ```
   */
  async getOrderProgress(orderId: string): Promise<number | null> {
    const order = await this.getOrder(orderId);
    if (!order) return null;
    return calculateOrderProgress(order.originalSize, order.filledSize);
  }

  async getTrades(marketId?: string): Promise<TradeInfo[]> {
    const client = await this.ensureInitialized();

    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      const trades = await client.getTrades(marketId ? { market: marketId } : undefined);

      return trades.map((t: ClobTrade) => ({
        id: t.id,
        tokenId: t.asset_id,
        side: t.side as Side,
        price: Number(t.price) || 0,
        size: Number(t.size) || 0,
        fee: Number(t.fee_rate_bps) || 0,
        timestamp: Number(t.match_time) || Date.now(),
      }));
    });
  }

  // ============================================================================
  // Rewards
  // ============================================================================

  async isOrderScoring(orderId: string): Promise<boolean> {
    const client = await this.ensureInitialized();
    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      const result = await client.isOrderScoring({ order_id: orderId });
      return result.scoring;
    });
  }

  async areOrdersScoring(orderIds: string[]): Promise<Record<string, boolean>> {
    const client = await this.ensureInitialized();
    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      return await client.areOrdersScoring({ orderIds });
    });
  }

  async getEarningsForDay(date: string): Promise<UserEarning[]> {
    const client = await this.ensureInitialized();
    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      const earnings = await client.getEarningsForUserForDay(date);
      return earnings.map(e => ({
        date: e.date,
        conditionId: e.condition_id,
        assetAddress: e.asset_address,
        makerAddress: e.maker_address,
        earnings: e.earnings,
        assetRate: e.asset_rate,
      }));
    });
  }

  async getCurrentRewards(): Promise<MarketReward[]> {
    const client = await this.ensureInitialized();
    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      const rewards = await client.getCurrentRewards();
      return rewards.map(r => ({
        conditionId: r.condition_id,
        question: r.question,
        marketSlug: r.market_slug,
        eventSlug: r.event_slug,
        rewardsMaxSpread: r.rewards_max_spread,
        rewardsMinSize: r.rewards_min_size,
        tokens: r.tokens.map(t => ({
          tokenId: t.token_id,
          outcome: t.outcome,
          price: t.price,
        })),
        rewardsConfig: r.rewards_config.map(c => ({
          assetAddress: c.asset_address,
          startDate: c.start_date,
          endDate: c.end_date,
          ratePerDay: c.rate_per_day,
          totalRewards: c.total_rewards,
        })),
      }));
    });
  }

  /**
   * Get reward configuration for a specific market
   *
   * Returns maxSpread, minSize, dailyRate for Q-Score calculation.
   * Returns null if market has no active rewards.
   */
  async getMarketRewardConfig(conditionId: string): Promise<MarketRewardConfig | null> {
    const rewards = await this.getCurrentRewards();
    const market = rewards.find(r => r.conditionId === conditionId);

    if (!market) {
      return null;
    }

    // Find active reward config
    const now = new Date();
    const activeConfig = market.rewardsConfig.find(c => {
      const start = new Date(c.startDate);
      const end = new Date(c.endDate);
      return now >= start && now <= end;
    });

    return {
      conditionId: market.conditionId,
      question: market.question,
      maxSpread: market.rewardsMaxSpread,
      minSize: market.rewardsMinSize,
      dailyRate: activeConfig?.ratePerDay ?? 0,
      totalPool: activeConfig?.totalRewards ?? 0,
      startDate: activeConfig?.startDate ?? '',
      endDate: activeConfig?.endDate ?? '',
      isActive: !!activeConfig,
    };
  }

  /**
   * Estimate Q-Score for given parameters
   *
   * Q-Score = ((maxSpread - yourSpread) / maxSpread)² × orderSize
   *
   * Two-sided quotes get full score, one-sided gets 1/3.
   */
  estimateQScore(params: QScoreParams): QScoreEstimate {
    const { spread, maxSpread, orderSize, isTwoSided = true } = params;

    // If spread exceeds max, no score
    if (spread >= maxSpread || maxSpread <= 0) {
      return {
        score: 0,
        effectiveScore: 0,
        spread,
        maxSpread,
        orderSize,
        isTwoSided,
        percentile: 'below_threshold',
        suggestions: ['Your spread exceeds the maximum qualifying spread'],
      };
    }

    const ratio = (maxSpread - spread) / maxSpread;
    const baseScore = Math.pow(ratio, 2) * orderSize;

    // Two-sided gets full score, one-sided gets 1/3
    const multiplier = isTwoSided ? 1.0 : 1 / 3;
    const effectiveScore = baseScore * multiplier;

    // Estimate percentile based on typical spread distributions
    let percentile: QScoreEstimate['percentile'];
    const spreadRatio = spread / maxSpread;
    if (spreadRatio <= 0.2) percentile = 'top10';
    else if (spreadRatio <= 0.4) percentile = 'top25';
    else if (spreadRatio <= 0.6) percentile = 'top50';
    else if (spreadRatio <= 0.8) percentile = 'average';
    else percentile = 'below_average';

    // Generate suggestions
    const suggestions: string[] = [];
    if (!isTwoSided) {
      suggestions.push('Enable two-sided quoting for 3x reward multiplier');
    }
    if (spreadRatio > 0.5) {
      const tighterSpread = maxSpread * 0.4;
      suggestions.push(`Tightening spread to ${(tighterSpread * 100).toFixed(1)}% would significantly increase rewards`);
    }
    if (orderSize < 50) {
      suggestions.push('Increasing order size improves Q-Score proportionally');
    }

    return {
      score: baseScore,
      effectiveScore,
      spread,
      maxSpread,
      orderSize,
      isTwoSided,
      percentile,
      suggestions,
    };
  }

  /**
   * Get rewards summary for a date range
   *
   * Aggregates daily earnings into a summary.
   */
  async getRewardsSummary(startDate?: string, endDate?: string): Promise<RewardsSummary> {
    // Default to last 7 days
    const end = endDate ? new Date(endDate) : new Date();
    const start = startDate ? new Date(startDate) : new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);

    const earnings: UserEarning[] = [];
    const currentDate = new Date(start);

    // Fetch earnings for each day
    while (currentDate <= end) {
      const dateStr = currentDate.toISOString().split('T')[0];
      try {
        const dayEarnings = await this.getEarningsForDay(dateStr);
        earnings.push(...dayEarnings);
      } catch {
        // Skip days with no data
      }
      currentDate.setDate(currentDate.getDate() + 1);
    }

    // Aggregate by market
    const marketEarnings = new Map<string, number>();
    let totalEarnings = 0;

    for (const e of earnings) {
      totalEarnings += e.earnings;
      const current = marketEarnings.get(e.conditionId) || 0;
      marketEarnings.set(e.conditionId, current + e.earnings);
    }

    // Find best market
    let bestMarket = { conditionId: '', earnings: 0 };
    for (const [conditionId, amount] of marketEarnings) {
      if (amount > bestMarket.earnings) {
        bestMarket = { conditionId, earnings: amount };
      }
    }

    const days = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)));

    return {
      startDate: start.toISOString().split('T')[0],
      endDate: end.toISOString().split('T')[0],
      totalEarnings,
      averageDailyEarnings: totalEarnings / days,
      marketCount: marketEarnings.size,
      bestMarket,
      totalDays: days,
    };
  }

  /**
   * Get top reward markets ranked by daily rate
   *
   * Useful for finding the most profitable markets to make.
   */
  async getTopRewardMarkets(limit: number = 10): Promise<TopRewardMarket[]> {
    const rewards = await this.getCurrentRewards();

    return rewards
      .filter(r => r.rewardsConfig.some(c => {
        const now = new Date();
        const start = new Date(c.startDate);
        const end = new Date(c.endDate);
        return now >= start && now <= end;
      }))
      .map(r => {
        const activeConfig = r.rewardsConfig.find(c => {
          const now = new Date();
          return now >= new Date(c.startDate) && now <= new Date(c.endDate);
        });

        return {
          conditionId: r.conditionId,
          question: r.question,
          marketSlug: r.marketSlug,
          dailyRate: activeConfig?.ratePerDay ?? 0,
          totalPool: activeConfig?.totalRewards ?? 0,
          maxSpread: r.rewardsMaxSpread,
          minSize: r.rewardsMinSize,
          // Recommend spread at 40% of max for good Q-Score
          recommendedSpread: r.rewardsMaxSpread * 0.4,
          tokens: r.tokens,
        };
      })
      .sort((a, b) => b.dailyRate - a.dailyRate)
      .slice(0, limit);
  }

  // ============================================================================
  // Balance & Allowance
  // ============================================================================

  async getBalanceAllowance(
    assetType: 'COLLATERAL' | 'CONDITIONAL',
    tokenId?: string
  ): Promise<{ balance: string; allowance: string }> {
    const client = await this.ensureInitialized();
    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      const result = await client.getBalanceAllowance({
        asset_type: assetType as any,
        token_id: tokenId,
      });
      return { balance: result.balance, allowance: result.allowance };
    });
  }

  async updateBalanceAllowance(
    assetType: 'COLLATERAL' | 'CONDITIONAL',
    tokenId?: string
  ): Promise<void> {
    const client = await this.ensureInitialized();
    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      await client.updateBalanceAllowance({
        asset_type: assetType as any,
        token_id: tokenId,
      });
    });
  }

  // ============================================================================
  // Account Info
  // ============================================================================

  getAddress(): string {
    return this.wallet.address;
  }

  getWallet(): Wallet {
    return this.wallet;
  }

  getCredentials(): ApiCredentials | null {
    return this.credentials;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  getClobClient(): ClobClient | null {
    return this.clobClient;
  }

}
