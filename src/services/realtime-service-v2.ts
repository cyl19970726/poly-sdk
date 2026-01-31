/**
 * RealtimeService V2
 *
 * Comprehensive real-time data service using official @polymarket/real-time-data-client.
 *
 * Supports ALL available topics:
 * - clob_market: price_change, agg_orderbook, last_trade_price, tick_size_change, market_created, market_resolved
 * - clob_user: order, trade (requires authentication)
 * - activity: trades, orders_matched
 * - crypto_prices: update (BTC, ETH, etc.)
 * - equity_prices: update (AAPL, etc.)
 * - comments: comment_created, comment_removed, reaction_created, reaction_removed
 * - rfq: request_*, quote_*
 */

import { EventEmitter } from 'events';
import {
  RealTimeDataClient,
  type Message,
  type ClobApiKeyCreds,
  type RealTimeDataClientInterface,
  ConnectionStatus,
  WS_ENDPOINTS,
} from '../realtime/index.js';
import type { PriceUpdate, BookUpdate, Orderbook, OrderbookLevel } from '../core/types.js';

// ============================================================================
// Types
// ============================================================================

export interface RealtimeServiceConfig {
  /** Auto-reconnect on disconnect (default: true) */
  autoReconnect?: boolean;
  /** Ping interval in ms (default: 5000) */
  pingInterval?: number;
  /** Enable debug logging (default: false) */
  debug?: boolean;
}

// Market data types
/**
 * Extended orderbook snapshot from WebSocket with additional trading parameters.
 * Extends the base Orderbook type from core/types.ts.
 */
export interface OrderbookSnapshot extends Orderbook {
  /** Token ID (ERC-1155 token identifier, required in WebSocket context) */
  tokenId: string;
  /** @deprecated Use tokenId instead */
  assetId: string;
  /** Market condition ID (required in WebSocket context) */
  market: string;
  /** Tick size for price rounding */
  tickSize: string;
  /** Minimum order size */
  minOrderSize: string;
  /** Hash for change detection (required in WebSocket context) */
  hash: string;
}

export interface LastTradeInfo {
  assetId: string;
  price: number;
  side: 'BUY' | 'SELL';
  size: number;
  timestamp: number;
  /** Fee rate in basis points (e.g., 200 = 2%) */
  feeRateBps?: number;
}

export interface PriceChange {
  assetId: string;
  changes: Array<{ price: string; size: string }>;
  timestamp: number;
}

export interface TickSizeChange {
  assetId: string;
  oldTickSize: string;
  newTickSize: string;
  timestamp: number;
}

export interface BestBidAsk {
  assetId: string;
  market: string;
  bestBid: number;
  bestAsk: number;
  spread: number;
  timestamp: number;
}

export interface MarketEvent {
  conditionId: string;
  type: 'created' | 'resolved';
  data: Record<string, unknown>;
  timestamp: number;
}

// User data types (requires authentication)
export interface UserOrder {
  orderId: string;
  market: string;
  asset: string;
  side: 'BUY' | 'SELL';
  price: number;
  originalSize: number;
  matchedSize: number;
  eventType: 'PLACEMENT' | 'UPDATE' | 'CANCELLATION';
  timestamp: number;
}

/**
 * Maker order info from trade message
 */
export interface MakerOrderInfo {
  orderId: string;
  matchedSize: number;
  price: number;
}

export interface UserTrade {
  tradeId: string;
  market: string;
  outcome: string;
  price: number;
  size: number;
  side: 'BUY' | 'SELL';
  status: 'MATCHED' | 'MINED' | 'CONFIRMED' | 'RETRYING' | 'FAILED';
  timestamp: number;
  transactionHash?: string;
  /** Taker's order ID - use this to link trade to order */
  takerOrderId?: string;
  /** Maker orders involved in this trade */
  makerOrders?: MakerOrderInfo[];
}

// Activity types
/**
 * Activity trade from WebSocket
 *
 * 实测验证 (2025-12-28)：proxyWallet 和 name 是顶层字段，不在 trader 对象里
 */
export interface ActivityTrade {
  /** Token ID (用于下单) */
  asset: string;
  /** Market condition ID */
  conditionId: string;
  /** Event slug */
  eventSlug: string;
  /** Market slug (可用于过滤) */
  marketSlug: string;
  /** Outcome (Yes/No) */
  outcome: string;
  /** Trade price */
  price: number;
  /** Trade side */
  side: 'BUY' | 'SELL';
  /** Trade size in shares */
  size: number;
  /** Timestamp (Unix seconds) */
  timestamp: number;
  /** Transaction hash */
  transactionHash: string;

  // ========== 交易者信息 ==========

  /**
   * Trader info object - 用于 Copy Trading 过滤目标钱包
   *
   * 注意: 实测验证 (2025-12-28) 数据结构为:
   * {
   *   trader: { name: "username", address: "0x..." }
   * }
   * 而非顶层 proxyWallet
   */
  trader?: {
    /** 交易者用户名 */
    name?: string;
    /** 交易者钱包地址 - Copy Trading 过滤关键字段！ */
    address?: string;
  };
}

// External price types
export interface CryptoPrice {
  symbol: string;
  price: number;
  timestamp: number;
}

export interface EquityPrice {
  symbol: string;
  price: number;
  timestamp: number;
}

// Comment types
export interface Comment {
  id: string;
  parentEntityId: number;
  parentEntityType: 'Event' | 'Series';
  content?: string;
  author?: string;
  timestamp: number;
}

export interface Reaction {
  id: string;
  commentId: string;
  type: string;
  author?: string;
  timestamp: number;
}

// RFQ types
export interface RFQRequest {
  id: string;
  market: string;
  side: 'BUY' | 'SELL';
  size: number;
  status: 'created' | 'edited' | 'canceled' | 'expired';
  timestamp: number;
}

export interface RFQQuote {
  id: string;
  requestId: string;
  price: number;
  size: number;
  status: 'created' | 'edited' | 'canceled' | 'expired';
  timestamp: number;
}

// Subscription types
export interface Subscription {
  id: string;
  topic: string;
  type: string;
  unsubscribe: () => void;
}

export interface MarketSubscription extends Subscription {
  tokenIds: string[];
}

// Event handler types
export interface MarketDataHandlers {
  onOrderbook?: (book: OrderbookSnapshot) => void;
  onPriceChange?: (change: PriceChange) => void;
  onLastTrade?: (trade: LastTradeInfo) => void;
  onTickSizeChange?: (change: TickSizeChange) => void;
  onBestBidAsk?: (bestBidAsk: BestBidAsk) => void;
  onMarketEvent?: (event: MarketEvent) => void;
  onError?: (error: Error) => void;
}

export interface UserDataHandlers {
  onOrder?: (order: UserOrder) => void;
  onTrade?: (trade: UserTrade) => void;
  onError?: (error: Error) => void;
}

export interface ActivityHandlers {
  onTrade?: (trade: ActivityTrade) => void;
  onError?: (error: Error) => void;
}

export interface CryptoPriceHandlers {
  onPrice?: (price: CryptoPrice) => void;
  onError?: (error: Error) => void;
}

export interface EquityPriceHandlers {
  onPrice?: (price: EquityPrice) => void;
  onError?: (error: Error) => void;
}

// ============================================================================
// RealtimeServiceV2 Implementation
// ============================================================================

export class RealtimeServiceV2 extends EventEmitter {
  private client: RealTimeDataClient | null = null;
  /** Separate client for crypto prices (uses LIVE_DATA endpoint) */
  private cryptoClient: RealTimeDataClient | null = null;
  private config: RealtimeServiceConfig;
  private subscriptions: Map<string, Subscription> = new Map();
  private subscriptionIdCounter = 0;
  private connected = false;
  private cryptoConnected = false;

  // Subscription refresh timer: re-sends subscriptions shortly after they're added
  // This fixes a bug where initial subscriptions on a fresh connection only receive
  // the snapshot but no updates. Re-sending them "wakes up" the server.
  private subscriptionRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  // Track subscriptions that need to be refreshed (newly added on this connection)
  private pendingRefreshSubIds: Set<string> = new Set();

  // Connection generation counter: incremented on each new connection.
  // Used to avoid sending unsubscribe for stale subscriptions after reconnection.
  private connectionGeneration = 0;
  // Tracks which generation each subscription was last (re-)subscribed on
  private subscriptionGenerations: Map<string, number> = new Map();

  // Store subscription messages for reconnection
  private subscriptionMessages: Map<string, { subscriptions: Array<{ topic: string; type: string; filters?: string; clob_auth?: ClobApiKeyCreds }> }> = new Map();

  // Accumulated market token IDs - we merge all markets into a single subscription
  // to avoid server overwriting previous subscriptions with same topic+type
  private accumulatedMarketTokenIds: Set<string> = new Set();
  // Timer to batch market subscription updates
  private marketSubscriptionBatchTimer: ReturnType<typeof setTimeout> | null = null;

  // Caches
  private priceCache: Map<string, PriceUpdate> = new Map();
  private bookCache: Map<string, OrderbookSnapshot> = new Map();
  private lastTradeCache: Map<string, LastTradeInfo> = new Map();

  constructor(config: RealtimeServiceConfig = {}) {
    super();
    this.config = {
      autoReconnect: config.autoReconnect ?? true,
      pingInterval: config.pingInterval ?? 5000,
      debug: config.debug ?? false,
    };
  }

  // ============================================================================
  // Connection Management
  // ============================================================================

  /**
   * Connect to WebSocket server
   */
  connect(): this {
    if (this.client) {
      this.log('Already connected or connecting');
      return this;
    }

    // Main client for MARKET/USER channels
    this.client = new RealTimeDataClient({
      onConnect: this.handleConnect.bind(this),
      onMessage: this.handleMessage.bind(this),
      onStatusChange: this.handleStatusChange.bind(this),
      autoReconnect: this.config.autoReconnect,
      pingInterval: this.config.pingInterval,
      debug: this.config.debug,
    });

    // Crypto client for LIVE_DATA channel (crypto_prices)
    this.cryptoClient = new RealTimeDataClient({
      url: WS_ENDPOINTS.LIVE_DATA,
      onConnect: this.handleCryptoConnect.bind(this),
      onMessage: this.handleCryptoMessage.bind(this),
      onStatusChange: (status: ConnectionStatus) => {
        this.log(`Crypto client status: ${status}`);
        this.cryptoConnected = status === ConnectionStatus.CONNECTED;
      },
      autoReconnect: this.config.autoReconnect,
      pingInterval: this.config.pingInterval,
      debug: this.config.debug,
    });

    this.client.connect();
    this.cryptoClient.connect();
    return this;
  }

  /**
   * Disconnect from WebSocket server
   */
  disconnect(): void {
    this.cancelSubscriptionRefresh();
    this.cancelMarketSubscriptionBatch();

    if (this.client) {
      this.client.disconnect();
      this.client = null;
      this.connected = false;
    }

    if (this.cryptoClient) {
      this.cryptoClient.disconnect();
      this.cryptoClient = null;
      this.cryptoConnected = false;
    }

    this.subscriptions.clear();
    this.subscriptionMessages.clear();
    this.subscriptionGenerations.clear();
    this.accumulatedMarketTokenIds.clear();
  }

  private cancelMarketSubscriptionBatch(): void {
    if (this.marketSubscriptionBatchTimer) {
      clearTimeout(this.marketSubscriptionBatchTimer);
      this.marketSubscriptionBatchTimer = null;
    }
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.connected;
  }

  // ============================================================================
  // Market Data Subscriptions (clob_market)
  // ============================================================================

  /**
   * Subscribe to market data (orderbook, prices, trades)
   * @param tokenIds - Array of token IDs to subscribe to
   * @param handlers - Event handlers
   *
   * IMPORTANT: This method uses an accumulation strategy. Instead of sending
   * separate subscription messages for each market, we accumulate all token IDs
   * and send a single merged subscription. This prevents the server from
   * overwriting previous subscriptions (which happens when multiple messages
   * have the same topic+type but different filters).
   */
  subscribeMarkets(tokenIds: string[], handlers: MarketDataHandlers = {}): MarketSubscription {
    const subId = `market_${++this.subscriptionIdCounter}`;

    // Add new token IDs to accumulated set
    for (const tokenId of tokenIds) {
      this.accumulatedMarketTokenIds.add(tokenId);
    }

    // Schedule a batched subscription update (debounced)
    this.scheduleMergedMarketSubscription();

    // Register handlers (filtered by this subscription's tokenIds)
    const orderbookHandler = (book: OrderbookSnapshot) => {
      if (tokenIds.includes(book.assetId)) {
        handlers.onOrderbook?.(book);
      }
    };

    const priceChangeHandler = (change: PriceChange) => {
      if (tokenIds.includes(change.assetId)) {
        handlers.onPriceChange?.(change);
      }
    };

    const lastTradeHandler = (trade: LastTradeInfo) => {
      if (tokenIds.includes(trade.assetId)) {
        handlers.onLastTrade?.(trade);
      }
    };

    const tickSizeHandler = (change: TickSizeChange) => {
      if (tokenIds.includes(change.assetId)) {
        handlers.onTickSizeChange?.(change);
      }
    };

    const bestBidAskHandler = (bba: BestBidAsk) => {
      if (tokenIds.includes(bba.assetId)) {
        handlers.onBestBidAsk?.(bba);
      }
    };

    this.on('orderbook', orderbookHandler);
    this.on('priceChange', priceChangeHandler);
    this.on('lastTrade', lastTradeHandler);
    this.on('tickSizeChange', tickSizeHandler);
    this.on('bestBidAsk', bestBidAskHandler);

    const subscription: MarketSubscription = {
      id: subId,
      topic: 'clob_market',
      type: '*',
      tokenIds,
      unsubscribe: () => {
        this.off('orderbook', orderbookHandler);
        this.off('priceChange', priceChangeHandler);
        this.off('lastTrade', lastTradeHandler);
        this.off('tickSizeChange', tickSizeHandler);
        this.off('bestBidAsk', bestBidAskHandler);

        // Remove these token IDs from accumulated set
        for (const tokenId of tokenIds) {
          this.accumulatedMarketTokenIds.delete(tokenId);
        }

        // Re-subscribe with remaining tokens (or send empty to clear)
        this.scheduleMergedMarketSubscription();

        this.subscriptions.delete(subId);
      },
    };

    this.subscriptions.set(subId, subscription);
    return subscription;
  }

  /**
   * Schedule a merged market subscription update.
   * Debounces multiple rapid subscription changes into a single WebSocket message.
   */
  private scheduleMergedMarketSubscription(): void {
    // Clear existing timer
    if (this.marketSubscriptionBatchTimer) {
      clearTimeout(this.marketSubscriptionBatchTimer);
    }

    // Schedule subscription send after a short delay (100ms) to batch rapid changes
    this.marketSubscriptionBatchTimer = setTimeout(() => {
      this.marketSubscriptionBatchTimer = null;
      this.sendMergedMarketSubscription();
    }, 100);
  }

  /**
   * Send a single merged subscription containing all accumulated market token IDs.
   */
  private sendMergedMarketSubscription(): void {
    if (!this.client || !this.connected) {
      this.log('Cannot send merged subscription: not connected');
      return;
    }

    const allTokenIds = Array.from(this.accumulatedMarketTokenIds);

    if (allTokenIds.length === 0) {
      this.log('No market tokens to subscribe to');
      return;
    }

    const filterStr = JSON.stringify(allTokenIds);

    const subscriptions = [
      { topic: 'clob_market', type: 'agg_orderbook', filters: filterStr },
      { topic: 'clob_market', type: 'price_change', filters: filterStr },
      { topic: 'clob_market', type: 'last_trade_price', filters: filterStr },
      { topic: 'clob_market', type: 'tick_size_change', filters: filterStr },
      { topic: 'clob_market', type: 'best_bid_ask', filters: filterStr },
    ];

    const subMsg = { subscriptions };
    this.log(`Sending merged market subscription with ${allTokenIds.length} tokens`);
    this.client.subscribe(subMsg);

    // Store for reconnection (use a fixed key for the merged subscription)
    this.subscriptionMessages.set('__merged_market__', subMsg);
    this.subscriptionGenerations.set('__merged_market__', this.connectionGeneration);

    // Schedule refresh to ensure we receive updates (not just snapshot)
    this.scheduleSubscriptionRefresh('__merged_market__');
  }

  /**
   * Subscribe to a single market (YES + NO tokens)
   * Also emits derived price updates compatible with old API
   */
  subscribeMarket(
    yesTokenId: string,
    noTokenId: string,
    handlers: MarketDataHandlers & {
      onPriceUpdate?: (update: PriceUpdate) => void;
      onBookUpdate?: (update: BookUpdate) => void;
      onPairUpdate?: (update: { yes: PriceUpdate; no: PriceUpdate; spread: number }) => void;
    } = {}
  ): MarketSubscription {
    let lastYesUpdate: PriceUpdate | undefined;
    let lastNoUpdate: PriceUpdate | undefined;

    const checkPairUpdate = () => {
      if (lastYesUpdate && lastNoUpdate && handlers.onPairUpdate) {
        handlers.onPairUpdate({
          yes: lastYesUpdate,
          no: lastNoUpdate,
          spread: lastYesUpdate.price + lastNoUpdate.price,
        });
      }
    };

    return this.subscribeMarkets([yesTokenId, noTokenId], {
      onOrderbook: (book) => {
        handlers.onOrderbook?.(book);

        // Convert to BookUpdate for backward compatibility
        if (handlers.onBookUpdate) {
          const bookUpdate: BookUpdate = {
            assetId: book.assetId,
            bids: book.bids,
            asks: book.asks,
            timestamp: book.timestamp,
          };
          handlers.onBookUpdate(bookUpdate);
        }

        // Calculate derived price (Polymarket display logic)
        const priceUpdate = this.calculateDerivedPrice(book.assetId, book);
        if (priceUpdate) {
          this.priceCache.set(book.assetId, priceUpdate);

          if (book.assetId === yesTokenId) {
            lastYesUpdate = priceUpdate;
          } else if (book.assetId === noTokenId) {
            lastNoUpdate = priceUpdate;
          }

          handlers.onPriceUpdate?.(priceUpdate);
          this.emit('priceUpdate', priceUpdate);
          checkPairUpdate();
        }
      },
      onLastTrade: (trade) => {
        handlers.onLastTrade?.(trade);
        this.lastTradeCache.set(trade.assetId, trade);

        // Recalculate derived price with new last trade
        const book = this.bookCache.get(trade.assetId);
        if (book) {
          const priceUpdate = this.calculateDerivedPrice(trade.assetId, book);
          if (priceUpdate) {
            this.priceCache.set(trade.assetId, priceUpdate);

            if (trade.assetId === yesTokenId) {
              lastYesUpdate = priceUpdate;
            } else if (trade.assetId === noTokenId) {
              lastNoUpdate = priceUpdate;
            }

            handlers.onPriceUpdate?.(priceUpdate);
            this.emit('priceUpdate', priceUpdate);
            checkPairUpdate();
          }
        }
      },
      onPriceChange: handlers.onPriceChange,
      onTickSizeChange: handlers.onTickSizeChange,
      onError: handlers.onError,
    });
  }

  /**
   * Subscribe to market lifecycle events (creation, resolution)
   */
  subscribeMarketEvents(handlers: { onMarketEvent?: (event: MarketEvent) => void }): Subscription {
    const subId = `market_event_${++this.subscriptionIdCounter}`;

    const subscriptions = [
      { topic: 'clob_market', type: 'market_created' },
      { topic: 'clob_market', type: 'market_resolved' },
    ];

    this.sendSubscription({ subscriptions });

    const handler = (event: MarketEvent) => handlers.onMarketEvent?.(event);
    this.on('marketEvent', handler);

    const subscription: Subscription = {
      id: subId,
      topic: 'clob_market',
      type: 'lifecycle',
      unsubscribe: () => {
        this.off('marketEvent', handler);
        this.sendUnsubscription({ subscriptions });
        this.subscriptions.delete(subId);
      },
    };

    this.subscriptions.set(subId, subscription);
    return subscription;
  }

  // ============================================================================
  // User Data Subscriptions (clob_user) - Requires Authentication
  // ============================================================================

  /**
   * Subscribe to user order and trade events
   * @param credentials - CLOB API credentials
   * @param handlers - Event handlers
   */
  subscribeUserEvents(credentials: ClobApiKeyCreds, handlers: UserDataHandlers = {}): Subscription {
    const subId = `user_${++this.subscriptionIdCounter}`;

    const subscriptions = [
      { topic: 'clob_user', type: '*', clob_auth: credentials },
    ];

    const subMsg = { subscriptions };
    this.sendSubscription(subMsg);

    // Store for reconnection - critical for receiving USER_TRADE events after reconnect
    this.subscriptionMessages.set(subId, subMsg);
    this.subscriptionGenerations.set(subId, this.connectionGeneration);

    const orderHandler = (order: UserOrder) => handlers.onOrder?.(order);
    const tradeHandler = (trade: UserTrade) => handlers.onTrade?.(trade);

    this.on('userOrder', orderHandler);
    this.on('userTrade', tradeHandler);

    const subscription: Subscription = {
      id: subId,
      topic: 'clob_user',
      type: '*',
      unsubscribe: () => {
        this.off('userOrder', orderHandler);
        this.off('userTrade', tradeHandler);
        this.sendUnsubscription({ subscriptions }, subId);
        this.subscriptions.delete(subId);
        this.subscriptionMessages.delete(subId);
        this.subscriptionGenerations.delete(subId);
      },
    };

    this.subscriptions.set(subId, subscription);
    return subscription;
  }

  // ============================================================================
  // Activity Subscriptions (trades, orders_matched)
  // ============================================================================

  /**
   * Subscribe to trading activity for a market or event
   * @param filter - Event or market slug (optional - if empty, subscribes to all activity)
   * @param handlers - Event handlers
   */
  subscribeActivity(
    filter: { eventSlug?: string; marketSlug?: string } = {},
    handlers: ActivityHandlers = {}
  ): Subscription {
    const subId = `activity_${++this.subscriptionIdCounter}`;

    // Build filter object with snake_case keys (as expected by the server)
    // Only include filters if we have actual filter values
    const hasFilter = filter.eventSlug || filter.marketSlug;
    const filterObj: Record<string, string> = {};
    if (filter.eventSlug) filterObj.event_slug = filter.eventSlug;
    if (filter.marketSlug) filterObj.market_slug = filter.marketSlug;

    // Create subscription objects - only include filters field if we have filters
    const subscriptions = hasFilter
      ? [
          { topic: 'activity', type: 'trades', filters: JSON.stringify(filterObj) },
          { topic: 'activity', type: 'orders_matched', filters: JSON.stringify(filterObj) },
        ]
      : [
          { topic: 'activity', type: 'trades' },
          { topic: 'activity', type: 'orders_matched' },
        ];

    this.sendSubscription({ subscriptions });

    const handler = (trade: ActivityTrade) => handlers.onTrade?.(trade);
    this.on('activityTrade', handler);

    const subscription: Subscription = {
      id: subId,
      topic: 'activity',
      type: '*',
      unsubscribe: () => {
        this.off('activityTrade', handler);
        this.sendUnsubscription({ subscriptions });
        this.subscriptions.delete(subId);
      },
    };

    this.subscriptions.set(subId, subscription);
    return subscription;
  }

  /**
   * Subscribe to ALL trading activity across all markets (no filtering)
   * This is useful for Copy Trading - monitoring Smart Money across the platform
   * @param handlers - Event handlers
   */
  subscribeAllActivity(handlers: ActivityHandlers = {}): Subscription {
    return this.subscribeActivity({}, handlers);
  }

  // ============================================================================
  // Crypto Price Subscriptions
  // ============================================================================

  /**
   * Subscribe to crypto price updates (Binance)
   *
   * Uses lowercase symbols: 'btcusdt', 'ethusdt', 'solusdt', 'xrpusdt'
   *
   * @param symbols - Array of lowercase Binance symbols (e.g., ['btcusdt', 'ethusdt'])
   * @param handlers - Event handlers
   */
  subscribeCryptoPrices(symbols: string[], handlers: CryptoPriceHandlers = {}): Subscription {
    const subId = `crypto_${++this.subscriptionIdCounter}`;

    // Use custom RealTimeDataClient method
    if (this.cryptoClient) {
      this.cryptoClient.subscribeCryptoPrices(symbols);
    }

    const handler = (price: CryptoPrice) => {
      if (symbols.includes(price.symbol)) {
        handlers.onPrice?.(price);
      }
    };
    this.on('cryptoPrice', handler);

    const subscription: Subscription = {
      id: subId,
      topic: 'crypto_prices',
      type: 'update',
      unsubscribe: () => {
        this.off('cryptoPrice', handler);
        if (this.cryptoClient) {
          this.cryptoClient.unsubscribeCryptoPrices(symbols);
        }
        this.subscriptions.delete(subId);
      },
    };

    this.subscriptions.set(subId, subscription);
    return subscription;
  }

  /**
   * Subscribe to Chainlink crypto prices
   *
   * Uses lowercase slash-separated symbols: 'btc/usd', 'eth/usd', 'sol/usd', 'xrp/usd'
   *
   * @param symbols - Array of lowercase Chainlink symbols (e.g., ['btc/usd', 'eth/usd'])
   * @param handlers - Event handlers
   */
  subscribeCryptoChainlinkPrices(symbols: string[], handlers: CryptoPriceHandlers = {}): Subscription {
    const subId = `crypto_chainlink_${++this.subscriptionIdCounter}`;

    // Use custom RealTimeDataClient method
    if (this.cryptoClient) {
      this.cryptoClient.subscribeCryptoChainlinkPrices(symbols);
    }

    const handler = (price: CryptoPrice) => {
      if (symbols.includes(price.symbol)) {
        handlers.onPrice?.(price);
      }
    };
    this.on('cryptoChainlinkPrice', handler);

    const subscription: Subscription = {
      id: subId,
      topic: 'crypto_prices_chainlink',
      type: 'update',
      unsubscribe: () => {
        this.off('cryptoChainlinkPrice', handler);
        if (this.cryptoClient) {
          this.cryptoClient.unsubscribeCryptoChainlinkPrices(symbols);
        }
        this.subscriptions.delete(subId);
      },
    };

    this.subscriptions.set(subId, subscription);
    return subscription;
  }

  // ============================================================================
  // Equity Price Subscriptions
  // ============================================================================

  /**
   * Subscribe to equity price updates
   * @param symbols - Array of symbols (e.g., ['AAPL', 'GOOGL'])
   * @param handlers - Event handlers
   */
  subscribeEquityPrices(symbols: string[], handlers: EquityPriceHandlers = {}): Subscription {
    const subId = `equity_${++this.subscriptionIdCounter}`;

    const subscriptions = symbols.map(symbol => ({
      topic: 'equity_prices',
      type: 'update',
      filters: JSON.stringify({ symbol }),
    }));

    this.sendSubscription({ subscriptions });

    const handler = (price: EquityPrice) => {
      if (symbols.includes(price.symbol)) {
        handlers.onPrice?.(price);
      }
    };
    this.on('equityPrice', handler);

    const subscription: Subscription = {
      id: subId,
      topic: 'equity_prices',
      type: 'update',
      unsubscribe: () => {
        this.off('equityPrice', handler);
        this.sendUnsubscription({ subscriptions });
        this.subscriptions.delete(subId);
      },
    };

    this.subscriptions.set(subId, subscription);
    return subscription;
  }

  // ============================================================================
  // Comments Subscriptions
  // ============================================================================

  /**
   * Subscribe to comment and reaction events
   */
  subscribeComments(
    filter: { parentEntityId: number; parentEntityType: 'Event' | 'Series' },
    handlers: {
      onComment?: (comment: Comment) => void;
      onReaction?: (reaction: Reaction) => void;
    } = {}
  ): Subscription {
    const subId = `comments_${++this.subscriptionIdCounter}`;
    const filterStr = JSON.stringify({
      parentEntityID: filter.parentEntityId,
      parentEntityType: filter.parentEntityType,
    });

    const subscriptions = [
      { topic: 'comments', type: 'comment_created', filters: filterStr },
      { topic: 'comments', type: 'comment_removed', filters: filterStr },
      { topic: 'comments', type: 'reaction_created', filters: filterStr },
      { topic: 'comments', type: 'reaction_removed', filters: filterStr },
    ];

    this.sendSubscription({ subscriptions });

    const commentHandler = (comment: Comment) => handlers.onComment?.(comment);
    const reactionHandler = (reaction: Reaction) => handlers.onReaction?.(reaction);

    this.on('comment', commentHandler);
    this.on('reaction', reactionHandler);

    const subscription: Subscription = {
      id: subId,
      topic: 'comments',
      type: '*',
      unsubscribe: () => {
        this.off('comment', commentHandler);
        this.off('reaction', reactionHandler);
        this.sendUnsubscription({ subscriptions });
        this.subscriptions.delete(subId);
      },
    };

    this.subscriptions.set(subId, subscription);
    return subscription;
  }

  // ============================================================================
  // RFQ Subscriptions
  // ============================================================================

  /**
   * Subscribe to RFQ (Request for Quote) events
   */
  subscribeRFQ(handlers: {
    onRequest?: (request: RFQRequest) => void;
    onQuote?: (quote: RFQQuote) => void;
  } = {}): Subscription {
    const subId = `rfq_${++this.subscriptionIdCounter}`;

    const subscriptions = [
      { topic: 'rfq', type: 'request_created' },
      { topic: 'rfq', type: 'request_edited' },
      { topic: 'rfq', type: 'request_canceled' },
      { topic: 'rfq', type: 'request_expired' },
      { topic: 'rfq', type: 'quote_created' },
      { topic: 'rfq', type: 'quote_edited' },
      { topic: 'rfq', type: 'quote_canceled' },
      { topic: 'rfq', type: 'quote_expired' },
    ];

    this.sendSubscription({ subscriptions });

    const requestHandler = (request: RFQRequest) => handlers.onRequest?.(request);
    const quoteHandler = (quote: RFQQuote) => handlers.onQuote?.(quote);

    this.on('rfqRequest', requestHandler);
    this.on('rfqQuote', quoteHandler);

    const subscription: Subscription = {
      id: subId,
      topic: 'rfq',
      type: '*',
      unsubscribe: () => {
        this.off('rfqRequest', requestHandler);
        this.off('rfqQuote', quoteHandler);
        this.sendUnsubscription({ subscriptions });
        this.subscriptions.delete(subId);
      },
    };

    this.subscriptions.set(subId, subscription);
    return subscription;
  }

  // ============================================================================
  // Cache Access
  // ============================================================================

  /**
   * Get cached derived price for an asset
   */
  getPrice(assetId: string): PriceUpdate | undefined {
    return this.priceCache.get(assetId);
  }

  /**
   * Get all cached prices
   */
  getAllPrices(): Map<string, PriceUpdate> {
    return new Map(this.priceCache);
  }

  /**
   * Get cached orderbook for an asset
   */
  getBook(assetId: string): OrderbookSnapshot | undefined {
    return this.bookCache.get(assetId);
  }

  /**
   * Get cached last trade for an asset
   */
  getLastTrade(assetId: string): LastTradeInfo | undefined {
    return this.lastTradeCache.get(assetId);
  }

  // ============================================================================
  // Subscription Management
  // ============================================================================

  /**
   * Get all active subscriptions
   */
  getActiveSubscriptions(): Subscription[] {
    return Array.from(this.subscriptions.values());
  }

  /**
   * Unsubscribe from all
   */
  unsubscribeAll(): void {
    for (const sub of this.subscriptions.values()) {
      sub.unsubscribe();
    }
    this.subscriptions.clear();
    this.subscriptionMessages.clear();
    this.subscriptionGenerations.clear();
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Schedule a subscription refresh after a short delay.
   *
   * Problem: When subscriptions are sent right after connection, the server sometimes
   * only sends the initial snapshot but no subsequent updates. This appears to be a
   * server-side timing issue where the subscription "window" closes before updates flow.
   *
   * Solution: Re-send the subscription after 3 seconds. Polymarket's server apparently
   * accepts duplicate subscriptions and refreshes the stream. Unsubscribe doesn't work
   * (returns "Invalid request body"), so we just re-subscribe.
   *
   * Important: We do NOT cancel existing timers. If multiple subscriptions are added
   * within the 3-second window, they all get added to pendingRefreshSubIds and will
   * be refreshed together when the first timer fires. This ensures all markets get
   * refreshed, not just the last one.
   */
  private scheduleSubscriptionRefresh(subId: string): void {
    this.pendingRefreshSubIds.add(subId);

    // Only create a new timer if one doesn't exist
    // Don't cancel existing timer - it will refresh all pending subscriptions
    if (this.subscriptionRefreshTimer) {
      this.log(`Subscription ${subId} added to pending refresh (timer already scheduled)`);
      return;
    }

    // Schedule refresh after 3 seconds (enough time for initial snapshot to arrive)
    this.subscriptionRefreshTimer = setTimeout(() => {
      this.subscriptionRefreshTimer = null;

      if (!this.client || !this.connected || this.pendingRefreshSubIds.size === 0) {
        this.pendingRefreshSubIds.clear();
        return;
      }

      this.log(`Refreshing ${this.pendingRefreshSubIds.size} subscriptions (re-send)...`);

      for (const pendingSubId of this.pendingRefreshSubIds) {
        const msg = this.subscriptionMessages.get(pendingSubId);
        if (msg) {
          this.log(`Refresh: ${pendingSubId} - re-subscribe`);
          this.client.subscribe(msg);
        }
      }
      this.pendingRefreshSubIds.clear();
    }, 3000);
  }

  private cancelSubscriptionRefresh(): void {
    if (this.subscriptionRefreshTimer) {
      clearTimeout(this.subscriptionRefreshTimer);
      this.subscriptionRefreshTimer = null;
    }
    this.pendingRefreshSubIds.clear();
  }

  private handleConnect(_client: RealTimeDataClientInterface): void {
    this.connected = true;
    this.connectionGeneration++;
    this.log(`Connected to WebSocket server (generation ${this.connectionGeneration})`);

    // Re-subscribe to all active subscriptions on reconnect
    // Delay subscriptions by 1 second to let the connection stabilize.
    // This helps avoid the "snapshot only, no updates" bug.
    if (this.subscriptionMessages.size > 0) {
      this.log(`Re-subscribing to ${this.subscriptionMessages.size} subscriptions (delayed 1s)...`);
      setTimeout(() => {
        if (!this.client || !this.connected) return;
        for (const [subId, msg] of this.subscriptionMessages) {
          this.log(`Re-subscribing: ${subId}`);
          this.client?.subscribe(msg);
          // Update generation so unsubscribe knows it's valid on this connection
          this.subscriptionGenerations.set(subId, this.connectionGeneration);
        }
      }, 1000);
    }

    this.emit('connected');
  }

  private handleStatusChange(status: ConnectionStatus): void {
    this.log(`Connection status: ${status}`);

    if (status === ConnectionStatus.DISCONNECTED) {
      this.connected = false;
      this.cancelSubscriptionRefresh();
      this.cancelMarketSubscriptionBatch();
      this.emit('disconnected');
    } else if (status === ConnectionStatus.CONNECTED) {
      this.connected = true;
    }

    this.emit('statusChange', status);
  }

  private handleCryptoConnect(_client: RealTimeDataClientInterface): void {
    this.cryptoConnected = true;
    this.log('Connected to crypto prices WebSocket');
    this.emit('cryptoConnected');
  }

  private handleCryptoMessage(_client: RealTimeDataClientInterface, message: Message): void {
    this.log(`Crypto received: ${message.topic}:${message.type}`);

    const payload = message.payload as Record<string, unknown>;

    switch (message.topic) {
      case 'crypto_prices':
        this.handleCryptoPriceMessage(payload, message.timestamp);
        break;

      case 'crypto_prices_chainlink':
        this.handleCryptoChainlinkPriceMessage(payload, message.timestamp);
        break;

      default:
        this.log(`Unknown crypto topic: ${message.topic}`);
    }
  }

  private handleMessage(_client: RealTimeDataClientInterface, message: Message): void {
    this.log(`Received: ${message.topic}:${message.type}`);

    const payload = message.payload as Record<string, unknown>;

    switch (message.topic) {
      case 'clob_market':
        this.handleMarketMessage(message.type, payload, message.timestamp);
        break;

      case 'clob_user':
        this.handleUserMessage(message.type, payload, message.timestamp);
        break;

      case 'activity':
        this.handleActivityMessage(message.type, payload, message.timestamp);
        break;

      case 'crypto_prices':
        this.handleCryptoPriceMessage(payload, message.timestamp);
        break;

      case 'crypto_prices_chainlink':
        this.handleCryptoChainlinkPriceMessage(payload, message.timestamp);
        break;

      case 'equity_prices':
        this.handleEquityPriceMessage(payload, message.timestamp);
        break;

      case 'comments':
        this.handleCommentMessage(message.type, payload, message.timestamp);
        break;

      case 'rfq':
        this.handleRFQMessage(message.type, payload, message.timestamp);
        break;

      default:
        this.log(`Unknown topic: ${message.topic}`);
    }
  }

  /**
   * Handle market channel messages
   * @see https://docs.polymarket.com/developers/CLOB/websocket/market-channel
   *
   * Market channel events:
   * - book: Orderbook snapshot - triggered on subscribe or when trades affect orderbook
   * - price_change: Price level change - triggered when order placed or cancelled
   * - last_trade_price: Trade execution - triggered when maker/taker orders match
   * - tick_size_change: Tick size adjustment - triggered when price > 0.96 or < 0.04
   * - best_bid_ask: Best prices update (feature-flagged) - triggered on best price change
   * - new_market: Market created (feature-flagged) - triggered on market creation
   * - market_resolved: Market resolved (feature-flagged) - triggered on market resolution
   */
  private handleMarketMessage(type: string, payload: Record<string, unknown>, timestamp: number): void {
    switch (type) {
      case 'book': // New format from custom RealTimeDataClient
      case 'agg_orderbook': {
        // book event: Orderbook snapshot with bids/asks
        const items = Array.isArray(payload) ? payload : [payload];
        for (const item of items) {
          const book = this.parseOrderbook(item as Record<string, unknown>, timestamp);
          if (book.assetId) {
            this.bookCache.set(book.assetId, book);
            this.emit('orderbook', book);
          }
        }
        break;
      }

      case 'price_change': {
        const items = Array.isArray(payload) ? payload : [payload];
        for (const item of items) {
          const change = this.parsePriceChange(item as Record<string, unknown>, timestamp);
          if (change.assetId) {
            this.emit('priceChange', change);
          }
        }
        break;
      }

      case 'last_trade_price': {
        const items = Array.isArray(payload) ? payload : [payload];
        for (const item of items) {
          const trade = this.parseLastTrade(item as Record<string, unknown>, timestamp);
          if (trade.assetId) {
            this.lastTradeCache.set(trade.assetId, trade);
            this.emit('lastTrade', trade);
          }
        }
        break;
      }

      case 'tick_size_change': {
        // tick_size_change event: Tick size adjustment (price > 0.96 or < 0.04)
        // @see https://docs.polymarket.com/developers/CLOB/websocket/market-channel
        const change = this.parseTickSizeChange(payload, timestamp);
        this.emit('tickSizeChange', change);
        break;
      }

      case 'best_bid_ask': {
        // best_bid_ask event: Best prices changed (feature-flagged)
        // @see https://docs.polymarket.com/developers/CLOB/websocket/market-channel
        const bestPrices: BestBidAsk = {
          assetId: payload.asset_id as string || '',
          market: payload.market as string || '',
          bestBid: Number(payload.best_bid) || 0,
          bestAsk: Number(payload.best_ask) || 0,
          spread: Number(payload.spread) || 0,
          timestamp,
        };
        this.emit('bestBidAsk', bestPrices);
        break;
      }

      case 'new_market':
      case 'market_created': {
        // new_market event: Market creation (feature-flagged)
        // @see https://docs.polymarket.com/developers/CLOB/websocket/market-channel
        const event: MarketEvent = {
          conditionId: payload.market as string || payload.condition_id as string || '',
          type: 'created',
          data: payload,
          timestamp,
        };
        this.emit('marketEvent', event);
        break;
      }

      case 'market_resolved': {
        // market_resolved event: Market resolution (feature-flagged)
        // @see https://docs.polymarket.com/developers/CLOB/websocket/market-channel
        const event: MarketEvent = {
          conditionId: payload.market as string || payload.condition_id as string || '',
          type: 'resolved',
          data: payload,
          timestamp,
        };
        this.emit('marketEvent', event);
        break;
      }
    }
  }

  /**
   * Handle user channel messages
   * @see https://docs.polymarket.com/developers/CLOB/websocket/user-channel
   *
   * User channel events:
   * - order: Emitted when order placed (PLACEMENT), partially matched (UPDATE), or cancelled (CANCELLATION)
   * - trade: Emitted when market order matches, limit order included in trade, or status changes
   *          Status values: MATCHED, MINED, CONFIRMED, RETRYING, FAILED
   */
  private handleUserMessage(type: string, payload: Record<string, unknown>, timestamp: number): void {
    if (type === 'order') {
      // order event: Order placed (PLACEMENT), updated (UPDATE), or cancelled (CANCELLATION)
      const order: UserOrder = {
        orderId: payload.order_id as string || '',
        market: payload.market as string || '',
        asset: payload.asset as string || '',
        side: payload.side as 'BUY' | 'SELL',
        price: Number(payload.price) || 0,
        originalSize: Number(payload.original_size) || 0,
        matchedSize: Number(payload.matched_size) || 0,
        eventType: payload.event_type as 'PLACEMENT' | 'UPDATE' | 'CANCELLATION',
        timestamp,
      };
      this.emit('userOrder', order);
    } else if (type === 'trade') {
      // trade event: Trade status updates (MATCHED, MINED, CONFIRMED, RETRYING, FAILED)
      // Parse maker_orders array if present
      let makerOrders: MakerOrderInfo[] | undefined;
      if (Array.isArray(payload.maker_orders)) {
        makerOrders = (payload.maker_orders as Array<Record<string, unknown>>).map(m => ({
          orderId: m.order_id as string || '',
          matchedSize: Number(m.matched_size) || 0,
          price: Number(m.price) || 0,
        }));
      }

      const trade: UserTrade = {
        tradeId: payload.trade_id as string || '',
        market: payload.market as string || '',
        outcome: payload.outcome as string || '',
        price: Number(payload.price) || 0,
        size: Number(payload.size) || 0,
        side: payload.side as 'BUY' | 'SELL',
        status: payload.status as 'MATCHED' | 'MINED' | 'CONFIRMED' | 'RETRYING' | 'FAILED',
        timestamp,
        transactionHash: payload.transaction_hash as string | undefined,
        // New fields for order-trade linking
        takerOrderId: payload.taker_order_id as string | undefined,
        makerOrders,
      };
      this.emit('userTrade', trade);
    }
  }

  private handleActivityMessage(type: string, payload: Record<string, unknown>, timestamp: number): void {
    const trade: ActivityTrade = {
      asset: payload.asset as string || '',
      conditionId: payload.conditionId as string || '',
      eventSlug: payload.eventSlug as string || '',
      marketSlug: payload.slug as string || '',
      outcome: payload.outcome as string || '',
      price: Number(payload.price) || 0,
      side: payload.side as 'BUY' | 'SELL',
      size: Number(payload.size) || 0,
      timestamp: this.normalizeTimestamp(payload.timestamp) || timestamp,
      transactionHash: payload.transactionHash as string || '',
      trader: {
        name: payload.name as string | undefined,
        address: payload.proxyWallet as string | undefined,
      },
    };
    this.emit('activityTrade', trade);
  }

  private handleCryptoPriceMessage(payload: Record<string, unknown>, timestamp: number): void {
    const price: CryptoPrice = {
      symbol: payload.symbol as string || '',
      price: Number(payload.value) || 0,
      timestamp: this.normalizeTimestamp(payload.timestamp) || timestamp,
    };
    this.emit('cryptoPrice', price);
  }

  private handleCryptoChainlinkPriceMessage(payload: Record<string, unknown>, timestamp: number): void {
    const price: CryptoPrice = {
      symbol: payload.symbol as string || '',
      price: Number(payload.value) || 0,
      timestamp: this.normalizeTimestamp(payload.timestamp) || timestamp,
    };
    this.emit('cryptoChainlinkPrice', price);
  }

  private handleEquityPriceMessage(payload: Record<string, unknown>, timestamp: number): void {
    const price: EquityPrice = {
      symbol: payload.symbol as string || '',
      price: Number(payload.value) || 0,
      timestamp: this.normalizeTimestamp(payload.timestamp) || timestamp,
    };
    this.emit('equityPrice', price);
  }

  private handleCommentMessage(type: string, payload: Record<string, unknown>, timestamp: number): void {
    if (type.includes('comment')) {
      const comment: Comment = {
        id: payload.id as string || '',
        parentEntityId: payload.parentEntityID as number || 0,
        parentEntityType: payload.parentEntityType as 'Event' | 'Series',
        content: payload.content as string | undefined,
        author: payload.author as string | undefined,
        timestamp,
      };
      this.emit('comment', comment);
    } else if (type.includes('reaction')) {
      const reaction: Reaction = {
        id: payload.id as string || '',
        commentId: payload.commentId as string || '',
        type: payload.type as string || '',
        author: payload.author as string | undefined,
        timestamp,
      };
      this.emit('reaction', reaction);
    }
  }

  private handleRFQMessage(type: string, payload: Record<string, unknown>, timestamp: number): void {
    if (type.startsWith('request_')) {
      const status = type.replace('request_', '') as 'created' | 'edited' | 'canceled' | 'expired';
      const request: RFQRequest = {
        id: payload.id as string || '',
        market: payload.market as string || '',
        side: payload.side as 'BUY' | 'SELL',
        size: Number(payload.size) || 0,
        status,
        timestamp,
      };
      this.emit('rfqRequest', request);
    } else if (type.startsWith('quote_')) {
      const status = type.replace('quote_', '') as 'created' | 'edited' | 'canceled' | 'expired';
      const quote: RFQQuote = {
        id: payload.id as string || '',
        requestId: payload.request_id as string || '',
        price: Number(payload.price) || 0,
        size: Number(payload.size) || 0,
        status,
        timestamp,
      };
      this.emit('rfqQuote', quote);
    }
  }

  // Parsers

  private parseOrderbook(payload: Record<string, unknown>, timestamp: number): OrderbookSnapshot {
    const bidsRaw = payload.bids as Array<{ price: string; size: string }> || [];
    const asksRaw = payload.asks as Array<{ price: string; size: string }> || [];

    // Sort bids descending, asks ascending
    const bids = bidsRaw
      .map(l => ({ price: parseFloat(l.price), size: parseFloat(l.size) }))
      .sort((a, b) => b.price - a.price);

    const asks = asksRaw
      .map(l => ({ price: parseFloat(l.price), size: parseFloat(l.size) }))
      .sort((a, b) => a.price - b.price);

    const tokenId = payload.asset_id as string || '';
    return {
      tokenId,
      assetId: tokenId, // Backward compatibility
      market: payload.market as string || '',
      bids,
      asks,
      timestamp: this.normalizeTimestamp(payload.timestamp) || timestamp,
      tickSize: payload.tick_size as string || '0.01',
      minOrderSize: payload.min_order_size as string || '1',
      hash: payload.hash as string || '',
    };
  }

  private parsePriceChange(payload: Record<string, unknown>, timestamp: number): PriceChange {
    const changes = payload.price_changes as Array<{ price: string; size: string }> || [];
    return {
      assetId: payload.asset_id as string || '',
      changes,
      timestamp,
    };
  }

  private parseLastTrade(payload: Record<string, unknown>, timestamp: number): LastTradeInfo {
    const feeRateBps = payload.fee_rate_bps !== undefined ? Number(payload.fee_rate_bps) : undefined;
    return {
      assetId: payload.asset_id as string || '',
      price: parseFloat(payload.price as string) || 0,
      side: payload.side as 'BUY' | 'SELL' || 'BUY',
      size: parseFloat(payload.size as string) || 0,
      timestamp: this.normalizeTimestamp(payload.timestamp) || timestamp,
      feeRateBps: feeRateBps !== undefined && !isNaN(feeRateBps) ? feeRateBps : undefined,
    };
  }

  private parseTickSizeChange(payload: Record<string, unknown>, timestamp: number): TickSizeChange {
    return {
      assetId: payload.asset_id as string || '',
      oldTickSize: payload.old_tick_size as string || '',
      newTickSize: payload.new_tick_size as string || '',
      timestamp,
    };
  }

  /**
   * Calculate derived price using Polymarket's display logic:
   * - If spread <= 0.10: use midpoint
   * - If spread > 0.10: use last trade price
   */
  private calculateDerivedPrice(assetId: string, book: OrderbookSnapshot): PriceUpdate | null {
    if (book.bids.length === 0 || book.asks.length === 0) {
      return null;
    }

    const bestBid = book.bids[0].price;
    const bestAsk = book.asks[0].price;
    const spread = bestAsk - bestBid;
    const midpoint = (bestBid + bestAsk) / 2;

    const lastTrade = this.lastTradeCache.get(assetId);
    const lastTradePrice = lastTrade?.price ?? midpoint;

    // Polymarket display logic
    const displayPrice = spread <= 0.10 ? midpoint : lastTradePrice;

    return {
      assetId,
      price: displayPrice,
      midpoint,
      spread,
      timestamp: book.timestamp,
    };
  }

  private sendSubscription(msg: { subscriptions: Array<{ topic: string; type: string; filters?: string; clob_auth?: ClobApiKeyCreds }> }): void {
    if (this.client && this.connected) {
      // Log subscription details (redact credentials)
      const loggableSubs = msg.subscriptions.map(s => ({
        topic: s.topic,
        type: s.type,
        filters: s.filters,
        hasAuth: !!s.clob_auth,
      }));
      this.log(`Sending subscription: ${JSON.stringify(loggableSubs)}`);
      this.client.subscribe(msg);
    } else {
      this.log('Cannot subscribe: not connected');
    }
  }

  private sendUnsubscription(msg: { subscriptions: Array<{ topic: string; type: string; filters?: string }> }, subId?: string): void {
    if (!this.client || !this.connected) return;

    // If subId is provided, only send unsubscribe if subscription is on current connection.
    // After reconnect, stale subscriptions may not exist on the server (expired markets),
    // so sending unsubscribe would trigger "Invalid request body" errors.
    if (subId) {
      const subGeneration = this.subscriptionGenerations.get(subId);
      if (subGeneration !== undefined && subGeneration !== this.connectionGeneration) {
        this.log(`Skipping unsubscribe for ${subId}: stale (gen ${subGeneration} vs current ${this.connectionGeneration})`);
        this.subscriptionGenerations.delete(subId);
        return;
      }
      this.subscriptionGenerations.delete(subId);
    }

    this.client.unsubscribe(msg);
  }

  private log(message: string): void {
    if (this.config.debug) {
      console.log(`[RealtimeService] ${message}`);
    }
  }

  /**
   * Normalize timestamp to milliseconds
   * Polymarket WebSocket returns timestamps in seconds, need to convert to milliseconds
   */
  private normalizeTimestamp(ts: unknown): number {
    if (typeof ts === 'string') {
      const parsed = parseInt(ts, 10);
      if (isNaN(parsed)) return Date.now();
      // If timestamp is in seconds (< 1e12), convert to milliseconds
      return parsed < 1e12 ? parsed * 1000 : parsed;
    }
    if (typeof ts === 'number') {
      // If timestamp is in seconds (< 1e12), convert to milliseconds
      return ts < 1e12 ? ts * 1000 : ts;
    }
    return Date.now();
  }
}
