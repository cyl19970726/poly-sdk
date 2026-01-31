/**
 * RealTimeDataClient Types
 *
 * Type definitions for the custom WebSocket client that replaces
 * @polymarket/real-time-data-client.
 *
 * Based on official docs:
 * - https://docs.polymarket.com/developers/CLOB/websocket/wss-overview
 * - https://docs.polymarket.com/developers/CLOB/websocket/market-channel
 * - https://docs.polymarket.com/developers/CLOB/websocket/user-channel
 */

// ============================================================================
// Connection & Configuration
// ============================================================================

/**
 * Connection status enum
 */
export enum ConnectionStatus {
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
  DISCONNECTED = 'DISCONNECTED',
  RECONNECTING = 'RECONNECTING',
}

/**
 * CLOB API Key credentials for authenticated subscriptions (user channel)
 */
export interface ClobApiKeyCreds {
  apiKey: string;
  secret: string;
  passphrase: string;
}

/**
 * Channel type for WebSocket subscription
 */
export type ChannelType = 'MARKET' | 'USER';

/**
 * WebSocket URL endpoints
 */
export const WS_ENDPOINTS = {
  /** Market channel for orderbook and trade data */
  MARKET: 'wss://ws-subscriptions-clob.polymarket.com/ws/market',
  /** User channel for authenticated order/trade events */
  USER: 'wss://ws-subscriptions-clob.polymarket.com/ws/user',
  /** Live data channel for crypto prices and other real-time data */
  LIVE_DATA: 'wss://ws-live-data.polymarket.com',
} as const;

// ============================================================================
// Market Channel Event Types
// @see https://docs.polymarket.com/developers/CLOB/websocket/market-channel
// ============================================================================

/**
 * Market channel event types
 *
 * | Event Type        | Trigger                                      | Feature-flagged |
 * |-------------------|----------------------------------------------|-----------------|
 * | book              | Initial subscription or trade affects book   | No              |
 * | price_change      | New order placed or cancelled                | No              |
 * | last_trade_price  | Maker and taker orders match (trade exec)    | No              |
 * | tick_size_change  | Price > 0.96 or < 0.04 (precision change)    | No              |
 * | best_bid_ask      | Best bid or ask price changes                | Yes             |
 * | new_market        | Market creation                              | Yes             |
 * | market_resolved   | Market resolution                            | Yes             |
 */
export type MarketEventType =
  | 'book'             // Orderbook snapshot - triggered on subscribe or when trades affect orderbook
  | 'price_change'     // Price level change - triggered when order placed or cancelled
  | 'last_trade_price' // Trade execution - triggered when maker/taker orders match
  | 'tick_size_change' // Tick size adjustment - triggered when price > 0.96 or < 0.04
  | 'best_bid_ask'     // Best prices update - feature-flagged, triggered on best price change
  | 'new_market'       // Market created - feature-flagged, triggered on market creation
  | 'market_resolved'; // Market resolved - feature-flagged, triggered on market resolution

/**
 * Orderbook level (bid or ask)
 */
export interface OrderbookLevel {
  price: string;
  size: string;
}

/**
 * Book event payload - Orderbook snapshot
 * @event book
 * @trigger Initial subscription to a market or when trades affect the orderbook
 */
export interface BookEventPayload {
  /** Token ID (asset) */
  asset_id: string;
  /** Market condition ID */
  market: string;
  /** Orderbook hash for change detection */
  hash: string;
  /** Buy orders (bids) - sorted by price descending */
  bids: OrderbookLevel[];
  /** Sell orders (asks) - sorted by price ascending */
  asks: OrderbookLevel[];
  /** Timestamp in milliseconds */
  timestamp: string | number;
  /** Minimum tick size for orders */
  tick_size?: string;
  /** Minimum order size */
  min_order_size?: string;
}

/**
 * Single price change entry
 */
export interface PriceChangeEntry {
  /** Token ID */
  asset_id: string;
  /** Price level */
  price: string;
  /** Size at this price level */
  size: string;
  /** Order side: BUY or SELL */
  side: 'BUY' | 'SELL';
  /** Current best bid price */
  best_bid: string;
  /** Current best ask price */
  best_ask: string;
  /** Orderbook hash */
  hash?: string;
}

/**
 * Price change event payload
 * @event price_change
 * @trigger New order placement or order cancellation
 * @note Schema updating September 15, 2025 at 11 PM UTC
 */
export interface PriceChangeEventPayload {
  /** Market condition ID */
  market: string;
  /** Array of price level changes */
  price_changes: PriceChangeEntry[];
  /** Timestamp */
  timestamp?: string | number;
}

/**
 * Last trade price event payload
 * @event last_trade_price
 * @trigger Maker and taker orders match, creating a trade execution
 */
export interface LastTradePriceEventPayload {
  /** Token ID */
  asset_id: string;
  /** Market condition ID */
  market: string;
  /** Trade price */
  price: string;
  /** Trade side: BUY or SELL */
  side: 'BUY' | 'SELL';
  /** Trade size */
  size: string;
  /** Fee rate in basis points */
  fee_rate_bps: string;
  /** Timestamp in milliseconds */
  timestamp: string | number;
}

/**
 * Tick size change event payload
 * @event tick_size_change
 * @trigger Minimum tick size adjustment when price exceeds 0.96 or falls below 0.04
 */
export interface TickSizeChangeEventPayload {
  /** Token ID */
  asset_id: string;
  /** Market condition ID */
  market: string;
  /** Previous tick size */
  old_tick_size: string;
  /** New tick size */
  new_tick_size: string;
  /** Side affected */
  side: 'BUY' | 'SELL';
  /** Timestamp */
  timestamp: string | number;
}

/**
 * Best bid/ask event payload (feature-flagged)
 * @event best_bid_ask
 * @trigger Best bid or ask price changes
 */
export interface BestBidAskEventPayload {
  /** Token ID */
  asset_id: string;
  /** Market condition ID */
  market: string;
  /** Best bid price */
  best_bid: string;
  /** Best ask price */
  best_ask: string;
  /** Bid-ask spread */
  spread: string;
  /** Timestamp */
  timestamp: string | number;
}

/**
 * New market event payload (feature-flagged)
 * @event new_market
 * @trigger Market creation
 */
export interface NewMarketEventPayload {
  /** Market ID */
  id: string;
  /** Market question */
  question: string;
  /** Market condition ID */
  market: string;
  /** Market slug */
  slug: string;
  /** Market description */
  description: string;
  /** Token IDs for outcomes */
  assets_ids: string[];
  /** Outcome names */
  outcomes: string[];
  /** Related event message */
  event_message?: string;
  /** Timestamp */
  timestamp: string | number;
}

/**
 * Market resolved event payload (feature-flagged)
 * @event market_resolved
 * @trigger Market resolution occurs
 */
export interface MarketResolvedEventPayload extends NewMarketEventPayload {
  /** Winning token ID */
  winning_asset_id: string;
  /** Winning outcome name */
  winning_outcome: string;
}

// ============================================================================
// User Channel Event Types
// @see https://docs.polymarket.com/developers/CLOB/websocket/user-channel
// ============================================================================

/**
 * User channel event types
 *
 * | Event Type | Trigger                                                           |
 * |------------|-------------------------------------------------------------------|
 * | trade      | Market order matches, limit order included in trade, status change |
 * | order      | Order placed (PLACEMENT), partially matched (UPDATE), cancelled    |
 */
export type UserEventType =
  | 'trade'  // Trade status: MATCHED, MINED, CONFIRMED, RETRYING, FAILED
  | 'order'; // Order event: PLACEMENT, UPDATE, CANCELLATION

/**
 * Trade status values
 */
export type TradeStatus = 'MATCHED' | 'MINED' | 'CONFIRMED' | 'RETRYING' | 'FAILED';

/**
 * Order event type values
 */
export type OrderEventType = 'PLACEMENT' | 'UPDATE' | 'CANCELLATION';

/**
 * Maker order in a trade
 */
export interface MakerOrder {
  /** Maker order ID */
  order_id: string;
  /** Maker address */
  maker_address: string;
  /** Matched size */
  matched_amount: string;
  /** Fee paid */
  fee?: string;
}

/**
 * Trade event payload
 * @event trade
 * @trigger Emitted when a market order matches, a limit order is included in a trade,
 *          or subsequent status changes occur (MATCHED, MINED, CONFIRMED, RETRYING, FAILED)
 */
export interface TradeEventPayload {
  /** Token ID */
  asset_id: string;
  /** Trade ID */
  id: string;
  /** Market condition ID */
  market: string;
  /** Outcome name (e.g., "Yes", "No", "Up", "Down") */
  outcome: string;
  /** Trade price */
  price: string;
  /** Trade side: BUY or SELL */
  side: 'BUY' | 'SELL';
  /** Trade size */
  size: string;
  /** Trade status */
  status: TradeStatus;
  /** Array of maker orders involved */
  maker_orders: MakerOrder[];
  /** Taker order ID */
  taker_order_id: string;
  /** Trade owner address */
  trade_owner: string;
  /** Creation timestamp */
  timestamp: string | number;
  /** Last update timestamp */
  last_update: string | number;
}

/**
 * Associated trade reference
 */
export interface AssociatedTrade {
  /** Trade ID */
  trade_id: string;
  /** Matched size in this trade */
  matched_amount: string;
}

/**
 * Order event payload
 * @event order
 * @trigger Emitted during three scenarios:
 *          - PLACEMENT: when an order is initially placed
 *          - UPDATE: when portions of the order match
 *          - CANCELLATION: when the order is cancelled
 */
export interface OrderEventPayload {
  /** Token ID */
  asset_id: string;
  /** Order ID */
  id: string;
  /** Market condition ID */
  market: string;
  /** Outcome name */
  outcome: string;
  /** Order price */
  price: string;
  /** Order side: BUY or SELL */
  side: 'BUY' | 'SELL';
  /** Original order size */
  original_size: string;
  /** Size that has been matched */
  size_matched: string;
  /** Order owner address */
  order_owner: string;
  /** Owner address (alias) */
  owner: string;
  /** Event type: PLACEMENT, UPDATE, CANCELLATION */
  type: OrderEventType;
  /** Associated trades for this order */
  associate_trades: AssociatedTrade[];
  /** Timestamp */
  timestamp: string | number;
}

// ============================================================================
// Crypto Prices (RTDS)
// @see https://docs.polymarket.com/developers/RTDS/RTDS-crypto-prices
// ============================================================================

/**
 * Crypto price update payload
 * @topic crypto_prices (Binance) or crypto_prices_chainlink (Chainlink)
 * @trigger Real-time price updates from external data sources
 */
export interface CryptoPriceEventPayload {
  /** Symbol (e.g., 'btcusdt' for Binance, 'btc/usd' for Chainlink) */
  symbol: string;
  /** Price value */
  value: number;
  /** Price timestamp in milliseconds */
  timestamp: number;
}

/**
 * Crypto price event types
 */
export type CryptoPriceEventType = 'update';

// ============================================================================
// Subscription Messages
// ============================================================================

/**
 * Subscription message format for Polymarket WebSocket
 *
 * @deprecated Use the new subscription format directly (MarketSubscription, UserSubscription)
 */
export interface SubscriptionMessage {
  topic: string;
  type: string;
  filters?: string;
  clob_auth?: ClobApiKeyCreds;
}

/**
 * Initial market channel subscription format
 * @example { type: 'MARKET', assets_ids: ['token_id_1', 'token_id_2'] }
 */
export interface MarketSubscription {
  type: 'MARKET';
  assets_ids: string[];
}

/**
 * Initial user channel subscription format
 * @example { type: 'USER', auth: { apiKey, secret, passphrase }, markets: ['condition_id'] }
 */
export interface UserSubscription {
  type: 'USER';
  auth: ClobApiKeyCreds;
  markets?: string[]; // condition IDs to filter
}

/**
 * Dynamic subscription operation (after initial connection)
 * @example { operation: 'subscribe', assets_ids: ['new_token_id'] }
 */
export interface DynamicSubscription {
  operation: 'subscribe' | 'unsubscribe';
  assets_ids?: string[];
  markets?: string[];
}

// ============================================================================
// Message Wrapper
// ============================================================================

/**
 * Incoming WebSocket message wrapper
 *
 * All messages from the WebSocket are normalized to this format.
 * The payload structure depends on the topic and type.
 *
 * ## Market Channel Messages (topic: 'clob_market')
 *
 * | Type              | Payload Type                | Description                    |
 * |-------------------|-----------------------------|---------------------------------|
 * | book              | BookEventPayload            | Orderbook snapshot             |
 * | price_change      | PriceChangeEntry            | Individual price level change  |
 * | last_trade_price  | LastTradePriceEventPayload  | Trade execution                |
 * | tick_size_change  | TickSizeChangeEventPayload  | Tick size adjustment           |
 * | best_bid_ask      | BestBidAskEventPayload      | Best prices (feature-flagged)  |
 * | new_market        | NewMarketEventPayload       | Market created (feature-flagged)|
 * | market_resolved   | MarketResolvedEventPayload  | Market resolved (feature-flagged)|
 *
 * ## User Channel Messages (topic: 'clob_user')
 *
 * | Type   | Payload Type        | Description                              |
 * |--------|---------------------|------------------------------------------|
 * | trade  | TradeEventPayload   | Trade status (MATCHED/MINED/CONFIRMED)   |
 * | order  | OrderEventPayload   | Order event (PLACEMENT/UPDATE/CANCEL)    |
 *
 * ## Crypto Price Messages (topic: 'crypto_prices' | 'crypto_prices_chainlink')
 *
 * | Type   | Payload Type            | Description                          |
 * |--------|-------------------------|--------------------------------------|
 * | update | CryptoPriceEventPayload | Real-time price from Binance/Chainlink|
 */
export interface Message {
  /** Topic of the message: 'clob_market', 'clob_user', 'crypto_prices', or 'crypto_prices_chainlink' */
  topic: 'clob_market' | 'clob_user' | 'crypto_prices' | 'crypto_prices_chainlink' | string;
  /** Event type (e.g., book, price_change, order, trade, update) */
  type: MarketEventType | UserEventType | CryptoPriceEventType | string;
  /** Message timestamp (Unix ms) */
  timestamp: number;
  /** Raw payload - structure depends on topic/type */
  payload: Record<string, unknown>;
}

// ============================================================================
// Client Configuration & Interface
// ============================================================================

/**
 * RealTimeDataClient configuration
 */
export interface RealTimeDataClientConfig {
  /** WebSocket URL (default: market channel URL) */
  url?: string;
  /** Channel type - determines default URL if not specified */
  channel?: ChannelType;
  /** Connection callback */
  onConnect?: (client: RealTimeDataClientInterface) => void;
  /** Message callback - called for each parsed message */
  onMessage?: (client: RealTimeDataClientInterface, message: Message) => void;
  /** Status change callback */
  onStatusChange?: (status: ConnectionStatus) => void;
  /** Auto-reconnect on disconnect (default: true) */
  autoReconnect?: boolean;
  /** Ping interval in ms (default: 30000) */
  pingInterval?: number;
  /** Reconnect delay in ms (default: 1000, with exponential backoff) */
  reconnectDelay?: number;
  /** Max reconnect attempts (default: 10) */
  maxReconnectAttempts?: number;
  /** Pong timeout in ms - disconnect if no pong received (default: 10000) */
  pongTimeout?: number;
  /** Enable debug logging */
  debug?: boolean;
}

/**
 * Client interface for type safety in callbacks
 */
export interface RealTimeDataClientInterface {
  /** Connect to WebSocket server */
  connect(): void;
  /** Disconnect from WebSocket server */
  disconnect(): void;
  /** @deprecated Use subscribeMarket or subscribeUser instead */
  subscribe(msg: { subscriptions: SubscriptionMessage[] }): void;
  /** @deprecated Use unsubscribeMarket instead */
  unsubscribe(msg: { subscriptions: SubscriptionMessage[] }): void;
  /** Subscribe to market channel with token IDs */
  subscribeMarket(assetsIds: string[], isInitial?: boolean): void;
  /** Unsubscribe from market channel */
  unsubscribeMarket(assetsIds: string[]): void;
  /** Subscribe to user channel with authentication */
  subscribeUser(auth: ClobApiKeyCreds, markets?: string[]): void;
  /** Subscribe to Binance crypto prices (lowercase symbols: btcusdt, ethusdt, etc.) */
  subscribeCryptoPrices(symbols: string[]): void;
  /** Unsubscribe from Binance crypto prices */
  unsubscribeCryptoPrices(symbols: string[]): void;
  /** Subscribe to Chainlink crypto prices (lowercase slash-separated: btc/usd, eth/usd, etc.) */
  subscribeCryptoChainlinkPrices(symbols: string[]): void;
  /** Unsubscribe from Chainlink crypto prices */
  unsubscribeCryptoChainlinkPrices(symbols: string[]): void;
  /** Check if connected */
  isConnected(): boolean;
  /** Get current connection status */
  getStatus(): ConnectionStatus;
}
