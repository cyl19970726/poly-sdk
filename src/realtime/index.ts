/**
 * Realtime Module
 *
 * Custom WebSocket client for Polymarket real-time data.
 * Replaces @polymarket/real-time-data-client.
 *
 * @see https://docs.polymarket.com/developers/CLOB/websocket/wss-overview
 * @see https://docs.polymarket.com/developers/CLOB/websocket/market-channel
 * @see https://docs.polymarket.com/developers/CLOB/websocket/user-channel
 */

export { RealTimeDataClient } from './realtime-data-client.js';

// Connection & Configuration
export {
  ConnectionStatus,
  WS_ENDPOINTS,
  type ChannelType,
  type ClobApiKeyCreds,
  type RealTimeDataClientConfig,
  type RealTimeDataClientInterface,
} from './types.js';

// Subscription Messages
export {
  type DynamicSubscription,
  type MarketSubscription,
  type SubscriptionMessage,
  type UserSubscription,
} from './types.js';

// Message Wrapper
export {
  type Message,
  type MarketEventType,
  type UserEventType,
  type CryptoPriceEventType,
} from './types.js';

// Market Channel Event Payloads
export {
  type OrderbookLevel,
  type BookEventPayload,
  type PriceChangeEntry,
  type PriceChangeEventPayload,
  type LastTradePriceEventPayload,
  type TickSizeChangeEventPayload,
  type BestBidAskEventPayload,
  type NewMarketEventPayload,
  type MarketResolvedEventPayload,
} from './types.js';

// User Channel Event Payloads
export {
  type TradeStatus,
  type OrderEventType,
  type MakerOrder,
  type TradeEventPayload,
  type AssociatedTrade,
  type OrderEventPayload,
} from './types.js';

// Crypto Price Event Payloads
export {
  type CryptoPriceEventPayload,
} from './types.js';
