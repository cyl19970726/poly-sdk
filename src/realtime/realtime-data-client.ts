/**
 * RealTimeDataClient
 *
 * Custom WebSocket client for Polymarket real-time data.
 * Replaces @polymarket/real-time-data-client with proper:
 * - RFC 6455 ping/pong mechanism
 * - Exponential backoff reconnection
 * - Full subscription management
 *
 * WebSocket Protocol (from official docs):
 * - URL: wss://ws-subscriptions-clob.polymarket.com/ws/market
 * - Initial subscription: { type: "MARKET", assets_ids: ["token_id_1", ...] }
 * - Dynamic subscribe: { operation: "subscribe", assets_ids: ["token_id_1"] }
 * - Dynamic unsubscribe: { operation: "unsubscribe", assets_ids: ["token_id_1"] }
 *
 * Event types: book, price_change, last_trade_price, tick_size_change, best_bid_ask
 *
 * @see https://docs.polymarket.com/developers/CLOB/websocket/wss-overview
 * @see https://docs.polymarket.com/developers/CLOB/websocket/market-channel
 */

import WebSocket from 'ws';
import {
  type RealTimeDataClientConfig,
  type RealTimeDataClientInterface,
  type SubscriptionMessage,
  type ClobApiKeyCreds,
  type Message,
  ConnectionStatus,
  WS_ENDPOINTS,
} from './types.js';

// Default to market channel
const DEFAULT_URL = WS_ENDPOINTS.MARKET;
const DEFAULT_PING_INTERVAL = 30_000; // 30 seconds
const DEFAULT_PONG_TIMEOUT = 10_000; // 10 seconds
const DEFAULT_RECONNECT_DELAY = 1_000; // 1 second
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 10;

export class RealTimeDataClient implements RealTimeDataClientInterface {
  private ws: WebSocket | null = null;
  private config: Required<Omit<RealTimeDataClientConfig, 'onConnect' | 'onMessage' | 'onStatusChange' | 'channel'>> & {
    onConnect?: RealTimeDataClientConfig['onConnect'];
    onMessage?: RealTimeDataClientConfig['onMessage'];
    onStatusChange?: RealTimeDataClientConfig['onStatusChange'];
  };

  private status: ConnectionStatus = ConnectionStatus.DISCONNECTED;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private pongReceived = true;
  private intentionalDisconnect = false;

  constructor(config: RealTimeDataClientConfig = {}) {
    // Determine URL: explicit URL > channel-based URL > default
    let url = config.url;
    if (!url) {
      if (config.channel === 'USER') {
        url = WS_ENDPOINTS.USER;
      } else {
        url = WS_ENDPOINTS.MARKET;
      }
    }

    this.config = {
      url,
      autoReconnect: config.autoReconnect ?? true,
      pingInterval: config.pingInterval ?? DEFAULT_PING_INTERVAL,
      reconnectDelay: config.reconnectDelay ?? DEFAULT_RECONNECT_DELAY,
      maxReconnectAttempts: config.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS,
      pongTimeout: config.pongTimeout ?? DEFAULT_PONG_TIMEOUT,
      debug: config.debug ?? false,
      onConnect: config.onConnect,
      onMessage: config.onMessage,
      onStatusChange: config.onStatusChange,
    };
  }

  /**
   * Connect to the WebSocket server
   */
  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
      this.log('Already connected or connecting');
      return;
    }

    this.intentionalDisconnect = false;
    this.setStatus(ConnectionStatus.CONNECTING);
    this.log(`Connecting to ${this.config.url}`);

    this.ws = new WebSocket(this.config.url);

    this.ws.on('open', this.handleOpen.bind(this));
    this.ws.on('message', this.handleMessage.bind(this));
    this.ws.on('close', this.handleClose.bind(this));
    this.ws.on('error', this.handleError.bind(this));
    this.ws.on('pong', this.handlePong.bind(this));
  }

  /**
   * Disconnect from the WebSocket server
   */
  disconnect(): void {
    this.log('Disconnecting...');
    this.intentionalDisconnect = true;
    this.cleanup();

    if (this.ws) {
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }

    this.setStatus(ConnectionStatus.DISCONNECTED);
  }

  /**
   * Subscribe to market data
   *
   * For initial subscription (when first connecting or adding new tokens):
   * { type: "MARKET", assets_ids: ["token_id_1", "token_id_2"] }
   *
   * For adding tokens to existing subscription:
   * { operation: "subscribe", assets_ids: ["token_id_3"] }
   *
   * @deprecated Use subscribeMarket() for the new API format
   */
  subscribe(msg: { subscriptions: SubscriptionMessage[] }): void {
    // Convert old format to new format for backwards compatibility
    const assetsIds: string[] = [];
    for (const sub of msg.subscriptions) {
      if (sub.filters) {
        try {
          const parsed = JSON.parse(sub.filters);
          if (Array.isArray(parsed)) {
            assetsIds.push(...parsed);
          }
        } catch {
          // Ignore parse errors
        }
      }
    }

    if (assetsIds.length > 0) {
      this.subscribeMarket(assetsIds);
    }
  }

  /**
   * Unsubscribe from market data
   *
   * Format: { operation: "unsubscribe", assets_ids: ["token_id_1"] }
   *
   * @deprecated Use unsubscribeMarket() for the new API format
   */
  unsubscribe(msg: { subscriptions: SubscriptionMessage[] }): void {
    // Convert old format to new format for backwards compatibility
    const assetsIds: string[] = [];
    for (const sub of msg.subscriptions) {
      if (sub.filters) {
        try {
          const parsed = JSON.parse(sub.filters);
          if (Array.isArray(parsed)) {
            assetsIds.push(...parsed);
          }
        } catch {
          // Ignore parse errors
        }
      }
    }

    if (assetsIds.length > 0) {
      this.unsubscribeMarket(assetsIds);
    }
  }

  /**
   * Subscribe to market data (new API)
   *
   * @param assetsIds - Array of token IDs to subscribe to
   * @param isInitial - If true, sends initial subscription format { type: "MARKET", ... }
   *                    If false, sends dynamic format { operation: "subscribe", ... }
   */
  subscribeMarket(assetsIds: string[], isInitial = true): void {
    if (isInitial) {
      // Initial subscription format
      const msg = {
        type: 'MARKET',
        assets_ids: assetsIds,
      };
      this.send(JSON.stringify(msg));
    } else {
      // Dynamic subscription format
      const msg = {
        operation: 'subscribe',
        assets_ids: assetsIds,
      };
      this.send(JSON.stringify(msg));
    }
  }

  /**
   * Unsubscribe from market data (new API)
   *
   * @param assetsIds - Array of token IDs to unsubscribe from
   */
  unsubscribeMarket(assetsIds: string[]): void {
    const msg = {
      operation: 'unsubscribe',
      assets_ids: assetsIds,
    };
    this.send(JSON.stringify(msg));
  }

  /**
   * Subscribe to user channel (requires authentication)
   *
   * User channel provides personal order and trade events.
   * Note: This requires connecting to the USER WebSocket endpoint.
   *
   * Format: { type: "USER", auth: { apiKey, secret, passphrase }, markets?: [...] }
   *
   * @param auth - CLOB API credentials
   * @param markets - Optional array of condition IDs to filter events
   */
  subscribeUser(auth: ClobApiKeyCreds, markets?: string[]): void {
    const msg: Record<string, unknown> = {
      type: 'USER',
      auth,
    };

    if (markets && markets.length > 0) {
      msg.markets = markets;
    }

    this.send(JSON.stringify(msg));
  }

  /**
   * Subscribe to Binance crypto prices
   *
   * Provides real-time price updates from Binance.
   * Symbols must be lowercase concatenated format (e.g., 'btcusdt', 'ethusdt').
   *
   * Format: { action: "subscribe", subscriptions: [{ topic: "crypto_prices", type: "update", filters: "btcusdt,ethusdt" }] }
   *
   * @param symbols - Array of Binance symbols in lowercase (e.g., ['btcusdt', 'ethusdt'])
   */
  subscribeCryptoPrices(symbols: string[]): void {
    if (symbols.length === 0) return;

    const msg = {
      action: 'subscribe',
      subscriptions: [
        {
          topic: 'crypto_prices',
          type: 'update',
          filters: symbols.join(','),
        },
      ],
    };

    this.send(JSON.stringify(msg));
  }

  /**
   * Unsubscribe from Binance crypto prices
   *
   * @param symbols - Array of Binance symbols to unsubscribe from
   */
  unsubscribeCryptoPrices(symbols: string[]): void {
    if (symbols.length === 0) return;

    const msg = {
      action: 'unsubscribe',
      subscriptions: [
        {
          topic: 'crypto_prices',
          type: 'update',
          filters: symbols.join(','),
        },
      ],
    };

    this.send(JSON.stringify(msg));
  }

  /**
   * Subscribe to Chainlink crypto prices
   *
   * Provides real-time price updates from Chainlink oracles.
   * Symbols must be lowercase slash-separated format (e.g., 'btc/usd', 'eth/usd').
   *
   * Format: { action: "subscribe", subscriptions: [{ topic: "crypto_prices_chainlink", type: "*", filters: "{\"symbol\":\"btc/usd\"}" }] }
   *
   * Note: Each symbol requires a separate subscription with JSON-stringified filter.
   *
   * @param symbols - Array of Chainlink symbols in lowercase (e.g., ['btc/usd', 'eth/usd'])
   */
  subscribeCryptoChainlinkPrices(symbols: string[]): void {
    if (symbols.length === 0) return;

    for (const symbol of symbols) {
      const msg = {
        action: 'subscribe',
        subscriptions: [
          {
            topic: 'crypto_prices_chainlink',
            type: '*',
            filters: JSON.stringify({ symbol }),
          },
        ],
      };

      this.send(JSON.stringify(msg));
    }
  }

  /**
   * Unsubscribe from Chainlink crypto prices
   *
   * @param symbols - Array of Chainlink symbols to unsubscribe from
   */
  unsubscribeCryptoChainlinkPrices(symbols: string[]): void {
    if (symbols.length === 0) return;

    for (const symbol of symbols) {
      const msg = {
        action: 'unsubscribe',
        subscriptions: [
          {
            topic: 'crypto_prices_chainlink',
            type: '*',
            filters: JSON.stringify({ symbol }),
          },
        ],
      };

      this.send(JSON.stringify(msg));
    }
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.status === ConnectionStatus.CONNECTED;
  }

  /**
   * Get current connection status
   */
  getStatus(): ConnectionStatus {
    return this.status;
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private send(data: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(data);
      this.log(`Sent: ${data.slice(0, 200)}${data.length > 200 ? '...' : ''}`);
    } else {
      this.log('Cannot send: WebSocket not open');
    }
  }

  private handleOpen(): void {
    this.log('WebSocket connected');
    this.reconnectAttempts = 0;
    this.pongReceived = true;
    this.setStatus(ConnectionStatus.CONNECTED);
    this.startPing();
    this.config.onConnect?.(this);
  }

  private handleMessage(data: WebSocket.RawData): void {
    try {
      const raw = data.toString();
      this.log(`Raw message: ${raw.slice(0, 200)}${raw.length > 200 ? '...' : ''}`);
      const parsed = JSON.parse(raw);

      // Handle different message formats from Polymarket CLOB WebSocket
      const messages = this.parseMessages(parsed);

      for (const message of messages) {
        this.config.onMessage?.(this, message);
      }
    } catch (err) {
      this.log(`Message parse error: ${err}`);
    }
  }

  /**
   * Parse incoming WebSocket messages into our Message format
   *
   * ## Market Channel Events (topic: 'clob_market')
   * @see https://docs.polymarket.com/developers/CLOB/websocket/market-channel
   *
   * | Event Type        | Format                                                    | Trigger                          |
   * |-------------------|-----------------------------------------------------------|----------------------------------|
   * | book              | Array: [{ market, asset_id, bids, asks, timestamp, hash }]| Initial subscribe or trade       |
   * | price_change      | { market, price_changes: [{ asset_id, price, size, ... }]}| Order placed or cancelled        |
   * | last_trade_price  | { market, asset_id, price, side, size, fee_rate_bps, ... }| Trade execution                  |
   * | tick_size_change  | { market, asset_id, old_tick_size, new_tick_size, ... }   | Price > 0.96 or < 0.04           |
   * | best_bid_ask      | { market, asset_id, best_bid, best_ask, spread, ... }     | Best price change (feature-flag) |
   * | new_market        | { id, question, market, slug, assets_ids, outcomes, ... } | Market creation (feature-flag)   |
   * | market_resolved   | { ..., winning_asset_id, winning_outcome }                | Market resolved (feature-flag)   |
   *
   * ## User Channel Events (topic: 'clob_user')
   * @see https://docs.polymarket.com/developers/CLOB/websocket/user-channel
   *
   * | Event Type | Format                                                          | Trigger                        |
   * |------------|-----------------------------------------------------------------|--------------------------------|
   * | trade      | { event_type: 'trade', status, side, price, size, maker_orders }| Order matched/mined/confirmed  |
   * | order      | { event_type: 'order', type, side, price, original_size, ... }  | Order placed/updated/cancelled |
   */
  private parseMessages(raw: unknown): Message[] {
    const messages: Message[] = [];

    // ========================================================================
    // Array messages (book snapshots from market channel)
    // ========================================================================
    if (Array.isArray(raw)) {
      for (const item of raw) {
        if (typeof item === 'object' && item !== null) {
          const book = item as Record<string, unknown>;
          // book event: Orderbook snapshot with bids/asks
          if ('bids' in book || 'asks' in book) {
            const timestamp = this.normalizeTimestamp(book.timestamp);
            messages.push({
              topic: 'clob_market',
              type: 'book',
              timestamp,
              payload: book,
            });
          }
        }
      }
      return messages;
    }

    // ========================================================================
    // Object messages
    // ========================================================================
    if (typeof raw === 'object' && raw !== null) {
      const obj = raw as Record<string, unknown>;
      const timestamp = this.normalizeTimestamp(obj.timestamp) || Date.now();

      // ----------------------------------------------------------------------
      // User Channel Events (check event_type field first)
      // ----------------------------------------------------------------------

      // trade event: Trade status updates (MATCHED, MINED, CONFIRMED, RETRYING, FAILED)
      if (obj.event_type === 'trade' || ('status' in obj && 'maker_orders' in obj)) {
        messages.push({
          topic: 'clob_user',
          type: 'trade',
          timestamp,
          payload: obj,
        });
        return messages;
      }

      // order event: Order placed (PLACEMENT), updated (UPDATE), or cancelled (CANCELLATION)
      if (obj.event_type === 'order' || ('original_size' in obj && 'size_matched' in obj)) {
        messages.push({
          topic: 'clob_user',
          type: 'order',
          timestamp,
          payload: obj,
        });
        return messages;
      }

      // ----------------------------------------------------------------------
      // Market Channel Events
      // ----------------------------------------------------------------------

      // price_change event: Order placed or cancelled (price level changes)
      if ('price_changes' in obj && Array.isArray(obj.price_changes)) {
        for (const change of obj.price_changes as Record<string, unknown>[]) {
          messages.push({
            topic: 'clob_market',
            type: 'price_change',
            timestamp,
            payload: {
              market: obj.market,
              ...change,
            },
          });
        }
        return messages;
      }

      // last_trade_price event: Trade execution (maker/taker matched)
      if ('fee_rate_bps' in obj || ('price' in obj && 'side' in obj && 'size' in obj && !('price_changes' in obj) && !('original_size' in obj))) {
        messages.push({
          topic: 'clob_market',
          type: 'last_trade_price',
          timestamp,
          payload: obj,
        });
        return messages;
      }

      // tick_size_change event: Tick size adjustment (price > 0.96 or < 0.04)
      if ('old_tick_size' in obj || 'new_tick_size' in obj) {
        messages.push({
          topic: 'clob_market',
          type: 'tick_size_change',
          timestamp,
          payload: obj,
        });
        return messages;
      }

      // best_bid_ask event: Best prices changed (feature-flagged)
      if ('best_bid' in obj && 'best_ask' in obj && 'spread' in obj && !('price_changes' in obj)) {
        messages.push({
          topic: 'clob_market',
          type: 'best_bid_ask',
          timestamp,
          payload: obj,
        });
        return messages;
      }

      // market_resolved event: Market resolution (feature-flagged)
      // Must check before new_market since it extends new_market fields
      if ('winning_asset_id' in obj || 'winning_outcome' in obj) {
        messages.push({
          topic: 'clob_market',
          type: 'market_resolved',
          timestamp,
          payload: obj,
        });
        return messages;
      }

      // new_market event: Market creation (feature-flagged)
      if ('question' in obj && 'slug' in obj && 'assets_ids' in obj && 'outcomes' in obj) {
        messages.push({
          topic: 'clob_market',
          type: 'new_market',
          timestamp,
          payload: obj,
        });
        return messages;
      }

      // book event: Single orderbook snapshot (fallback for non-array format)
      if ('bids' in obj || 'asks' in obj) {
        messages.push({
          topic: 'clob_market',
          type: 'book',
          timestamp,
          payload: obj,
        });
        return messages;
      }

      // ----------------------------------------------------------------------
      // Crypto Price Events (topic: crypto_prices or crypto_prices_chainlink)
      // @see https://docs.polymarket.com/developers/RTDS/RTDS-crypto-prices
      // ----------------------------------------------------------------------

      // crypto_prices or crypto_prices_chainlink: Real-time price updates
      if (obj.topic === 'crypto_prices' || obj.topic === 'crypto_prices_chainlink') {
        const payload = obj.payload as Record<string, unknown>;
        const priceTimestamp = this.normalizeTimestamp(payload?.timestamp) || timestamp;

        messages.push({
          topic: obj.topic as 'crypto_prices' | 'crypto_prices_chainlink',
          type: (obj.type as string) || 'update',
          timestamp: priceTimestamp,
          payload: payload || obj,
        });
        return messages;
      }

      // Unknown message - log for debugging
      this.log(`Unknown message format: ${JSON.stringify(obj).slice(0, 100)}`);
    }

    return messages;
  }

  /**
   * Normalize timestamp to milliseconds
   * Polymarket sends timestamps in seconds, need to convert to milliseconds
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

  private handleClose(code: number, reason: Buffer): void {
    this.log(`WebSocket closed: ${code} - ${reason.toString()}`);
    this.cleanup();

    if (this.intentionalDisconnect) {
      this.setStatus(ConnectionStatus.DISCONNECTED);
      return;
    }

    if (this.config.autoReconnect) {
      this.handleReconnect();
    } else {
      this.setStatus(ConnectionStatus.DISCONNECTED);
    }
  }

  private handleError(err: Error): void {
    this.log(`WebSocket error: ${err.message}`);
    // Don't set status here - the 'close' event will follow
  }

  private handlePong(): void {
    this.log('Received pong');
    this.pongReceived = true;
    this.clearPongTimeout();
  }

  // ============================================================================
  // Ping/Pong Mechanism
  // ============================================================================

  /**
   * Start periodic ping to keep connection alive
   *
   * Uses RFC 6455 WebSocket ping frames, which the server MUST respond to
   * with pong frames. If no pong is received within pongTimeout, we
   * consider the connection dead and reconnect.
   */
  private startPing(): void {
    this.stopPing();

    this.pingTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        this.log('Ping skipped: WebSocket not open');
        return;
      }

      if (!this.pongReceived) {
        this.log('Pong not received for previous ping - connection may be dead');
        this.handleDeadConnection();
        return;
      }

      this.pongReceived = false;
      this.ws.ping();
      this.log('Sent ping');

      // Set timeout for pong response
      this.setPongTimeout();
    }, this.config.pingInterval);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.clearPongTimeout();
  }

  private setPongTimeout(): void {
    this.clearPongTimeout();
    this.pongTimer = setTimeout(() => {
      if (!this.pongReceived) {
        this.log('Pong timeout - connection dead');
        this.handleDeadConnection();
      }
    }, this.config.pongTimeout);
  }

  private clearPongTimeout(): void {
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  private handleDeadConnection(): void {
    this.log('Handling dead connection');
    this.cleanup();

    if (this.ws) {
      this.ws.terminate(); // Force close
      this.ws = null;
    }

    if (this.config.autoReconnect && !this.intentionalDisconnect) {
      this.handleReconnect();
    } else {
      this.setStatus(ConnectionStatus.DISCONNECTED);
    }
  }

  // ============================================================================
  // Reconnection Logic
  // ============================================================================

  /**
   * Handle reconnection with exponential backoff
   * Delays: 1s, 2s, 4s, 8s, 16s, 32s, 64s, 128s, 256s, 512s (capped at maxReconnectAttempts)
   */
  private handleReconnect(): void {
    if (this.intentionalDisconnect) {
      return;
    }

    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
      this.log(`Max reconnect attempts (${this.config.maxReconnectAttempts}) reached`);
      this.setStatus(ConnectionStatus.DISCONNECTED);
      return;
    }

    const delay = this.config.reconnectDelay * Math.pow(2, this.reconnectAttempts);
    this.reconnectAttempts++;

    this.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.config.maxReconnectAttempts})`);
    this.setStatus(ConnectionStatus.RECONNECTING);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // ============================================================================
  // Utility Methods
  // ============================================================================

  private cleanup(): void {
    this.stopPing();
    this.cancelReconnect();
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status !== status) {
      this.status = status;
      this.log(`Status changed: ${status}`);
      this.config.onStatusChange?.(status);
    }
  }

  private log(message: string): void {
    if (this.config.debug) {
      console.log(`[RealTimeDataClient] ${message}`);
    }
  }
}
