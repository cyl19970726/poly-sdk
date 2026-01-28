/**
 * Market Service
 *
 * Provides market data and analysis:
 * - Market info and discovery
 * - Orderbook data and analysis
 * - K-Line aggregation from trade data
 * - Spread analysis
 * - Arbitrage detection
 */

import {
  ClobClient,
  Side as ClobSide,
  Chain,
  PriceHistoryInterval,
  type OrderBookSummary,
} from '@polymarket/clob-client';
import { Wallet } from 'ethers';
import { DataApiClient, Trade } from '../clients/data-api.js';
import { GammaApiClient, GammaMarket } from '../clients/gamma-api.js';
import type { UnifiedCache } from '../core/unified-cache.js';
import { CACHE_TTL } from '../core/unified-cache.js';
import { RateLimiter, ApiType } from '../core/rate-limiter.js';
import { PolymarketError, ErrorCode } from '../core/errors.js';
import type {
  UnifiedMarket,
  MarketToken as UnifiedMarketToken,
  ProcessedOrderbook,
  EffectivePrices,
  ArbitrageOpportunity,
  KLineInterval,
  KLineCandle,
  DualKLineData,
  SpreadDataPoint,
  RealtimeSpreadAnalysis,
  Side,
  Orderbook,
  UnderlyingAsset,
  TokenUnderlyingCorrelation,
  TokenUnderlyingDataPoint,
  PricePoint,
  PriceLineSpreadPoint,
  DualPriceLineData,
} from '../core/types.js';
import type { BinanceService, BinanceInterval } from './binance-service.js';

// CLOB Host
const CLOB_HOST = 'https://clob.polymarket.com';

// Chain IDs
export const POLYGON_MAINNET = 137;

/**
 * Normalize timestamp to milliseconds.
 * Polymarket API sometimes returns timestamps in seconds.
 * Timestamps < 1e12 (year ~2001 in ms) are assumed to be in seconds.
 */
function normalizeTimestamp(ts: number): number {
  return ts < 1e12 ? ts * 1000 : ts;
}

// Mapping from underlying asset to Binance symbol
const UNDERLYING_TO_SYMBOL = {
  BTC: 'BTCUSDT',
  ETH: 'ETHUSDT',
  SOL: 'SOLUSDT',
} as const;

// Map from KLineInterval to BinanceInterval (Binance doesn't support 30s or 12h)
const KLINE_TO_BINANCE_INTERVAL: Partial<Record<KLineInterval, BinanceInterval>> = {
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '30m': '30m',
  '1h': '1h',
  '4h': '4h',
  '1d': '1d',
};

// ============================================================================
// Types
// ============================================================================

// Side and Orderbook are imported from core/types.ts
// Re-export for backward compatibility
export type { Side, Orderbook } from '../core/types.js';

export type PriceHistoryIntervalString = '1h' | '6h' | '1d' | '1w' | 'max';

export interface PriceHistoryParams {
  tokenId: string;
  interval?: PriceHistoryIntervalString;
  startTs?: number;
  endTs?: number;
  fidelity?: number;
}

// PricePoint is now in core/types.ts - re-export for backward compatibility
export type { PricePoint } from '../core/types.js';

export interface MarketServiceConfig {
  /** Private key for CLOB client auth (optional, for authenticated endpoints) */
  privateKey?: string;
  /** Chain ID (default: Polygon mainnet 137) */
  chainId?: number;
}

// Internal type for CLOB market data
interface ClobMarket {
  condition_id: string;
  question_id?: string;
  market_slug: string;
  question: string;
  description?: string;
  tokens: Array<{
    token_id: string;
    outcome: string;
    price: number;
    winner?: boolean;
  }>;
  active: boolean;
  closed: boolean;
  accepting_orders: boolean;
  end_date_iso?: string | null;
  neg_risk?: boolean;
  minimum_order_size?: number;
  minimum_tick_size?: number;
}

/**
 * CLOB Market type (from CLOB API)
 *
 * This represents the raw market data from the CLOB API.
 * For merged market data with volume/liquidity, use UnifiedMarket from core/types.ts.
 */
export interface Market {
  conditionId: string;
  questionId?: string;
  marketSlug: string;
  question: string;
  description?: string;
  tokens: MarketToken[];
  active: boolean;
  closed: boolean;
  acceptingOrders: boolean;
  endDateIso?: string | null;
  negRisk?: boolean;
  minimumOrderSize?: number;
  minimumTickSize?: number;
}

/**
 * Token in a CLOB market
 * Same structure as MarketToken in core/types.ts
 */
export interface MarketToken {
  tokenId: string;
  outcome: string;
  price: number;
  winner?: boolean;
}

/**
 * Resolved market tokens with outcome names
 *
 * Uses `primary`/`secondary` naming to be market-agnostic:
 * - Yes/No markets: primary=Yes, secondary=No
 * - Up/Down markets: primary=Up, secondary=Down
 * - Team markets: primary=Team1, secondary=Team2
 *
 * This follows the BinaryTokens pattern in core/types.ts
 */
export interface ResolvedMarketTokens {
  /** Primary outcome token ID (index 0: Yes/Up/Team1) */
  primaryTokenId: string;
  /** Secondary outcome token ID (index 1: No/Down/Team2) */
  secondaryTokenId: string;
  /** Outcome names for display [primary, secondary] */
  outcomes: [string, string];
  /** Primary outcome name (e.g., "Yes", "Up") */
  primaryOutcome: string;
  /** Secondary outcome name (e.g., "No", "Down") */
  secondaryOutcome: string;
}

// ============================================================================
// MarketService Implementation
// ============================================================================

export class MarketService {
  private clobClient: ClobClient | null = null;
  private initialized = false;

  constructor(
    private gammaApi: GammaApiClient | undefined,
    private dataApi: DataApiClient | undefined,
    private rateLimiter: RateLimiter,
    private cache: UnifiedCache,
    private config?: MarketServiceConfig,
    private binanceService?: BinanceService
  ) {}

  // ============================================================================
  // Initialization
  // ============================================================================

  private async ensureInitialized(): Promise<ClobClient> {
    if (!this.initialized || !this.clobClient) {
      const chainId = (this.config?.chainId || POLYGON_MAINNET) as Chain;

      if (this.config?.privateKey) {
        // Authenticated client
        const wallet = new Wallet(this.config.privateKey);
        this.clobClient = new ClobClient(CLOB_HOST, chainId, wallet);
      } else {
        // Read-only client (no auth needed for market data)
        this.clobClient = new ClobClient(CLOB_HOST, chainId);
      }
      this.initialized = true;
    }
    return this.clobClient!;
  }

  // ============================================================================
  // CLOB Market Data Methods
  // ============================================================================

  /**
   * Get market from CLOB by condition ID
   */
  async getClobMarket(conditionId: string): Promise<Market | null> {
    const cacheKey = `clob:market:${conditionId}`;
    return this.cache.getOrSet(cacheKey, CACHE_TTL.MARKET_INFO, async () => {
      const client = await this.ensureInitialized();
      return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
        try {
          const market = await client.getMarket(conditionId);
          if (!market || !market.tokens) {
            return null;
          }
          return this.normalizeClobMarket(market as ClobMarket);
        } catch (error) {
          // Handle 404 "market not found" gracefully
          if (error && typeof error === 'object' && 'status' in error && (error as { status: number }).status === 404) {
            return null;
          }
          throw error;
        }
      });
    });
  }

  /**
   * Resolve market tokens from CLOB API
   *
   * This method fetches the actual token IDs from the CLOB API,
   * which are different from the calculated positionIds in standard CTF.
   *
   * ## Why This Method Exists
   *
   * Polymarket CLOB markets use custom ERC-1155 token IDs that are different
   * from the standard CTF calculated positionIds:
   *
   * ```
   * Standard CTF:  positionId = keccak256(USDC + keccak256(0x0 + conditionId + indexSet))
   * Polymarket:    tokenId = custom value from CLOB API (e.g., "25064375110792...")
   * ```
   *
   * This method provides the actual tokenIds needed for CTF operations
   * (split, merge, redeem) on Polymarket markets.
   *
   * ## Usage with CTFClient
   *
   * Since CTFClient uses legacy `yesTokenId`/`noTokenId` naming,
   * you need to convert when calling CTF methods:
   *
   * ```typescript
   * const resolved = await sdk.markets.resolveMarketTokens(conditionId);
   * if (resolved) {
   *   const tokenIds = {
   *     yesTokenId: resolved.primaryTokenId,
   *     noTokenId: resolved.secondaryTokenId,
   *   };
   *   await ctfClient.redeemByTokenIds(conditionId, tokenIds);
   * }
   * ```
   *
   * @param conditionId - Market condition ID (0x...)
   * @returns Resolved token IDs with outcome names, or null if not found
   */
  async resolveMarketTokens(conditionId: string): Promise<ResolvedMarketTokens | null> {
    try {
      const market = await this.getClobMarket(conditionId);
      if (!market?.tokens?.length || market.tokens.length < 2) {
        return null;
      }

      const primary = market.tokens[0];
      const secondary = market.tokens[1];

      return {
        primaryTokenId: primary.tokenId,
        secondaryTokenId: secondary.tokenId,
        outcomes: [primary.outcome, secondary.outcome],
        primaryOutcome: primary.outcome,
        secondaryOutcome: secondary.outcome,
      };
    } catch {
      return null;
    }
  }

  /**
   * Get multiple markets from CLOB
   */
  async getClobMarkets(nextCursor?: string): Promise<{ markets: Market[]; nextCursor: string }> {
    const client = await this.ensureInitialized();
    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      const result = await client.getMarkets(nextCursor);
      return {
        markets: (result.data as ClobMarket[]).map(m => this.normalizeClobMarket(m)),
        nextCursor: result.next_cursor,
      };
    });
  }

  /**
   * Get orderbook for a single token
   */
  async getTokenOrderbook(tokenId: string): Promise<Orderbook> {
    const client = await this.ensureInitialized();
    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      const book = await client.getOrderBook(tokenId) as OrderBookSummary;

      const bids = (book.bids || [])
        .map((l: { price: string; size: string }) => ({
          price: parseFloat(l.price),
          size: parseFloat(l.size),
        }))
        .sort((a, b) => b.price - a.price);

      const asks = (book.asks || [])
        .map((l: { price: string; size: string }) => ({
          price: parseFloat(l.price),
          size: parseFloat(l.size),
        }))
        .sort((a, b) => a.price - b.price);

      return {
        tokenId: book.asset_id,
        assetId: book.asset_id, // Backward compatibility
        bids,
        asks,
        timestamp: parseInt(book.timestamp || '0', 10) || Date.now(),
        market: book.market,
        hash: book.hash,
      };
    });
  }

  /**
   * Get orderbooks for multiple tokens
   */
  async getTokenOrderbooks(
    params: Array<{ tokenId: string; side: Side }>
  ): Promise<Map<string, Orderbook>> {
    const client = await this.ensureInitialized();
    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      const bookParams = params.map(p => ({
        token_id: p.tokenId,
        side: p.side === 'BUY' ? ClobSide.BUY : ClobSide.SELL,
      }));
      const books = await client.getOrderBooks(bookParams);
      const result = new Map<string, Orderbook>();

      for (const book of books) {
        const bids = (book.bids || [])
          .map((l: { price: string; size: string }) => ({
            price: parseFloat(l.price),
            size: parseFloat(l.size),
          }))
          .sort((a, b) => b.price - a.price);

        const asks = (book.asks || [])
          .map((l: { price: string; size: string }) => ({
            price: parseFloat(l.price),
            size: parseFloat(l.size),
          }))
          .sort((a, b) => a.price - b.price);

        result.set(book.asset_id, {
          tokenId: book.asset_id,
          assetId: book.asset_id, // Backward compatibility
          bids,
          asks,
          timestamp: parseInt(book.timestamp || '0', 10) || Date.now(),
          market: book.market,
          hash: book.hash,
        });
      }

      return result;
    });
  }

  /**
   * Get processed orderbook with arbitrage analysis for a market
   */
  async getProcessedOrderbook(conditionId: string): Promise<ProcessedOrderbook> {
    const market = await this.getClobMarket(conditionId);
    if (!market) {
      throw new PolymarketError(ErrorCode.MARKET_NOT_FOUND, `Market not found: ${conditionId}`);
    }
    // Use index-based access instead of name-based (supports Yes/No, Up/Down, Team1/Team2, etc.)
    const yesToken = market.tokens[0];  // primary outcome
    const noToken = market.tokens[1];   // secondary outcome

    if (!yesToken || !noToken) {
      throw new PolymarketError(ErrorCode.INVALID_RESPONSE, 'Missing tokens in market');
    }

    const [yesBook, noBook] = await Promise.all([
      this.getTokenOrderbook(yesToken.tokenId),
      this.getTokenOrderbook(noToken.tokenId),
    ]);

    return this.processOrderbooks(yesBook, noBook, yesToken.tokenId, noToken.tokenId);
  }

  /**
   * Get price history for a token
   */
  async getPricesHistory(params: PriceHistoryParams): Promise<PricePoint[]> {
    const client = await this.ensureInitialized();
    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      const intervalMap: Record<PriceHistoryIntervalString, PriceHistoryInterval> = {
        '1h': PriceHistoryInterval.ONE_HOUR,
        '6h': PriceHistoryInterval.SIX_HOURS,
        '1d': PriceHistoryInterval.ONE_DAY,
        '1w': PriceHistoryInterval.ONE_WEEK,
        'max': PriceHistoryInterval.MAX,
      };

      const history = await client.getPricesHistory({
        market: params.tokenId,
        interval: params.interval ? intervalMap[params.interval] : undefined,
        startTs: params.startTs,
        endTs: params.endTs,
        fidelity: params.fidelity,
      });

      const historyArray = Array.isArray(history)
        ? history
        : (history as { history?: Array<{ t: number; p: number }> })?.history || [];

      return historyArray.map((pt: { t: number; p: number }) => ({
        timestamp: pt.t,
        price: pt.p,
      }));
    });
  }

  /**
   * Get midpoint price for a token
   */
  async getMidpoint(tokenId: string): Promise<number> {
    const client = await this.ensureInitialized();
    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      const midpoint = await client.getMidpoint(tokenId);
      return Number(midpoint);
    });
  }

  /**
   * Get spread for a token
   */
  async getSpread(tokenId: string): Promise<number> {
    const client = await this.ensureInitialized();
    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      const spread = await client.getSpread(tokenId);
      return Number(spread);
    });
  }

  /**
   * Get last trade price for a token
   */
  async getLastTradePrice(tokenId: string): Promise<number> {
    const client = await this.ensureInitialized();
    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      const price = await client.getLastTradePrice(tokenId);
      return Number(price);
    });
  }

  // ============================================================================
  // Unified Market Access
  // ============================================================================

  /**
   * Get market by slug or condition ID
   */
  async getMarket(identifier: string): Promise<UnifiedMarket> {
    const isConditionId = identifier.startsWith('0x') || /^\d+$/.test(identifier);

    if (isConditionId) {
      return this.getMarketByConditionId(identifier);
    } else {
      return this.getMarketBySlug(identifier);
    }
  }

  private async getMarketBySlug(slug: string): Promise<UnifiedMarket> {
    if (!this.gammaApi) {
      throw new PolymarketError(ErrorCode.INVALID_CONFIG, 'GammaApiClient is required for slug-based lookups');
    }
    const gammaMarket = await this.gammaApi.getMarketBySlug(slug);
    if (!gammaMarket) {
      throw new PolymarketError(ErrorCode.MARKET_NOT_FOUND, `Market not found: ${slug}`);
    }

    try {
      const clobMarket = await this.getClobMarket(gammaMarket.conditionId);
      if (clobMarket) {
        return this.mergeMarkets(gammaMarket, clobMarket);
      }
      return this.fromGammaMarket(gammaMarket);
    } catch {
      return this.fromGammaMarket(gammaMarket);
    }
  }

  private async getMarketByConditionId(conditionId: string): Promise<UnifiedMarket> {
    // Try to get data from both sources for best accuracy
    let clobMarket: Market | null = null;
    let gammaMarket: GammaMarket | null = null;

    // Try CLOB first (authoritative for trading data)
    try {
      clobMarket = await this.getClobMarket(conditionId);
    } catch {
      // CLOB failed, continue to try Gamma
    }

    // Always try Gamma for accurate slug and metadata (if available)
    if (this.gammaApi) {
      try {
        gammaMarket = await this.gammaApi.getMarketByConditionId(conditionId);
      } catch {
        // Gamma failed
      }
    }

    // Merge if both available (preferred)
    if (gammaMarket && clobMarket) {
      return this.mergeMarkets(gammaMarket, clobMarket);
    }

    // Gamma only - still useful for metadata
    if (gammaMarket) {
      return this.fromGammaMarket(gammaMarket);
    }

    // CLOB only - slug might be stale, add warning
    if (clobMarket) {
      const market = this.fromClobMarket(clobMarket);
      // Check if slug looks stale (doesn't match question keywords)
      const questionWords = clobMarket.question.toLowerCase().split(/\s+/).slice(0, 3);
      const slugWords = clobMarket.marketSlug.toLowerCase().split('-');
      const hasMatchingWord = questionWords.some(qw =>
        slugWords.some(sw => sw.includes(qw) || qw.includes(sw))
      );
      if (!hasMatchingWord && clobMarket.marketSlug.length > 0) {
        // Slug appears stale, use conditionId as fallback identifier
        market.slug = `market-${conditionId.slice(0, 10)}`;
      }
      return market;
    }

    throw new PolymarketError(ErrorCode.MARKET_NOT_FOUND, `Market not found: ${conditionId}`);
  }

  // ===== K-Line: Price Lines (from /prices-history API) =====

  /**
   * Get price line for a market outcome from /prices-history API.
   *
   * This returns pre-computed price points from the CLOB API,
   * suitable for lightweight price charts. For OHLCV candles
   * aggregated from trade data, use `getKLinesOHLCV()` instead.
   *
   * @param conditionId - Market condition ID
   * @param interval - Price history interval (1h, 6h, 1d, 1w, max)
   * @param options - Query options
   * @param options.fidelity - Number of price points to return
   * @param options.startTs - Start timestamp (Unix seconds)
   * @param options.endTs - End timestamp (Unix seconds)
   * @param options.outcomeIndex - Outcome index (0 = primary, 1 = secondary; default: 0)
   *
   * @example
   * ```typescript
   * // Get 1-day price line for primary outcome
   * const prices = await sdk.markets.getKLines(conditionId, '1d');
   *
   * // Get secondary outcome with fidelity
   * const noLine = await sdk.markets.getKLines(conditionId, '1h', {
   *   outcomeIndex: 1,
   *   fidelity: 100,
   * });
   * ```
   */
  async getKLines(
    conditionId: string,
    interval: PriceHistoryIntervalString,
    options?: {
      fidelity?: number;
      startTs?: number;
      endTs?: number;
      outcomeIndex?: number;
    }
  ): Promise<PricePoint[]> {
    const outcomeIndex = options?.outcomeIndex ?? 0;
    const resolved = await this.resolveMarketTokens(conditionId);
    if (!resolved) {
      throw new PolymarketError(ErrorCode.MARKET_NOT_FOUND, `Cannot resolve tokens for market: ${conditionId}`);
    }

    const tokenId = outcomeIndex === 0 ? resolved.primaryTokenId : resolved.secondaryTokenId;

    const points = await this.getPricesHistory({
      tokenId,
      interval,
      fidelity: options?.fidelity,
      startTs: options?.startTs,
      endTs: options?.endTs,
    });

    // If no data returned, try fallback with 'max' interval (market may be closed)
    if (points.length === 0 && interval !== 'max') {
      const market = await this.getClobMarket(conditionId);
      if (market?.closed) {
        return this.getPricesHistory({
          tokenId,
          interval: 'max',
          fidelity: options?.fidelity,
        });
      }
    }

    return points;
  }

  /**
   * Get dual price lines (primary + secondary) from /prices-history API.
   *
   * Fetches price history for both outcomes in parallel and optionally
   * computes spread analysis. For OHLCV dual candles from trade data,
   * use `getDualKLinesOHLCV()` instead.
   *
   * @param conditionId - Market condition ID
   * @param interval - Price history interval (1h, 6h, 1d, 1w, max)
   * @param options - Query options
   *
   * @example
   * ```typescript
   * const dual = await sdk.markets.getDualKLines(conditionId, '1d');
   * console.log(dual.primary.length);     // Primary outcome price points
   * console.log(dual.secondary.length);   // Secondary outcome price points
   * console.log(dual.spreadAnalysis);     // Spread analysis
   * ```
   */
  async getDualKLines(
    conditionId: string,
    interval: PriceHistoryIntervalString,
    options?: {
      fidelity?: number;
      startTs?: number;
      endTs?: number;
    }
  ): Promise<DualPriceLineData> {
    const resolved = await this.resolveMarketTokens(conditionId);
    if (!resolved) {
      throw new PolymarketError(ErrorCode.MARKET_NOT_FOUND, `Cannot resolve tokens for market: ${conditionId}`);
    }

    const sharedOpts = {
      fidelity: options?.fidelity,
      startTs: options?.startTs,
      endTs: options?.endTs,
    };

    const [primary, secondary] = await Promise.all([
      this.getKLines(conditionId, interval, { ...sharedOpts, outcomeIndex: 0 }),
      this.getKLines(conditionId, interval, { ...sharedOpts, outcomeIndex: 1 }),
    ]);

    const spreadAnalysis = this.analyzePriceLineSpread(primary, secondary);

    return {
      conditionId,
      interval,
      fidelity: options?.fidelity,
      primary,
      secondary,
      outcomes: resolved.outcomes,
      spreadAnalysis,
    };
  }

  // ===== K-Line: OHLCV Candles (from Data API /trades) =====

  /**
   * Get OHLCV K-Line candles for a market (single token).
   *
   * Aggregates raw trade data into OHLCV candles. For lightweight
   * price charts from /prices-history, use `getKLines()` instead.
   *
   * @param conditionId - Market condition ID
   * @param interval - K-line interval (1s, 5s, 15s, 30s, 1m, 5m, 15m, 30m, 1h, 4h, 12h, 1d)
   * @param options - Query options
   * @param options.limit - Maximum number of trades to fetch for aggregation (default: 1000)
   * @param options.tokenId - Filter by specific token ID
   * @param options.outcomeIndex - Filter by outcome index (0 = primary, 1 = secondary)
   * @param options.startTimestamp - Start timestamp (Unix ms) - filter trades after this time
   * @param options.endTimestamp - End timestamp (Unix ms) - filter trades before this time
   * @param options.paginate - Use paginated fetching for more complete data (default: false)
   * @param options.maxTrades - Maximum trades when paginating (default: 5000)
   *
   * @example
   * ```typescript
   * // Get 5s candles for the last 15 minutes
   * const now = Date.now();
   * const candles = await sdk.markets.getKLinesOHLCV(conditionId, '5s', {
   *   startTimestamp: now - 15 * 60 * 1000,
   *   endTimestamp: now,
   * });
   *
   * // Get all available trades with pagination
   * const allCandles = await sdk.markets.getKLinesOHLCV(conditionId, '1h', {
   *   paginate: true,
   *   maxTrades: 5000,
   * });
   * ```
   */
  async getKLinesOHLCV(
    conditionId: string,
    interval: KLineInterval,
    options?: {
      limit?: number;
      tokenId?: string;
      outcomeIndex?: number;
      startTimestamp?: number;
      endTimestamp?: number;
      paginate?: boolean;
      maxTrades?: number;
    }
  ): Promise<KLineCandle[]> {
    if (!this.dataApi) {
      throw new PolymarketError(ErrorCode.INVALID_CONFIG, 'DataApiClient is required for K-Line OHLCV data');
    }

    let trades;
    if (options?.paginate) {
      trades = await this.dataApi.getAllTrades({
        market: conditionId,
        startTimestamp: options?.startTimestamp,
        endTimestamp: options?.endTimestamp,
      }, options?.maxTrades || 5000);
    } else {
      trades = await this.dataApi.getTrades({
        market: conditionId,
        limit: options?.limit || 1000,
        startTimestamp: options?.startTimestamp,
        endTimestamp: options?.endTimestamp,
      });
    }

    // Filter by token/outcome if specified
    let filteredTrades = trades;
    if (options?.tokenId) {
      filteredTrades = trades.filter((t) => t.asset === options.tokenId);
    } else if (options?.outcomeIndex !== undefined) {
      filteredTrades = trades.filter((t) => t.outcomeIndex === options.outcomeIndex);
    }

    return this.aggregateToKLines(filteredTrades, interval);
  }

  /**
   * Get dual OHLCV K-Lines (YES + NO tokens) from trade data.
   *
   * Aggregates raw trade data into dual OHLCV candles with spread analysis
   * and optional real-time orderbook data. For lightweight dual price lines
   * from /prices-history, use `getDualKLines()` instead.
   *
   * @param conditionId - Market condition ID
   * @param interval - K-line interval (1s, 5s, 15s, 30s, 1m, 5m, 15m, 30m, 1h, 4h, 12h, 1d)
   * @param options - Query options
   * @param options.limit - Maximum number of trades to fetch for aggregation (default: 1000)
   * @param options.startTimestamp - Start timestamp (Unix ms) - filter trades after this time
   * @param options.endTimestamp - End timestamp (Unix ms) - filter trades before this time
   * @param options.paginate - Use paginated fetching for more complete data (default: false)
   * @param options.maxTrades - Maximum trades when paginating (default: 5000)
   *
   * @example
   * ```typescript
   * // Get 15s dual K-lines for a 15-minute market
   * const now = Date.now();
   * const data = await sdk.markets.getDualKLinesOHLCV(conditionId, '15s', {
   *   startTimestamp: now - 15 * 60 * 1000,
   *   endTimestamp: now,
   * });
   * console.log(`Up candles: ${data.yes.length}, Down candles: ${data.no.length}`);
   * ```
   */
  async getDualKLinesOHLCV(
    conditionId: string,
    interval: KLineInterval,
    options?: {
      limit?: number;
      startTimestamp?: number;
      endTimestamp?: number;
      paginate?: boolean;
      maxTrades?: number;
    }
  ): Promise<DualKLineData> {
    if (!this.dataApi) {
      throw new PolymarketError(ErrorCode.INVALID_CONFIG, 'DataApiClient is required for K-Line OHLCV data');
    }
    const market = await this.getMarket(conditionId);

    let trades;
    if (options?.paginate) {
      trades = await this.dataApi.getAllTrades({
        market: conditionId,
        startTimestamp: options?.startTimestamp,
        endTimestamp: options?.endTimestamp,
      }, options?.maxTrades || 5000);
    } else {
      trades = await this.dataApi.getTrades({
        market: conditionId,
        limit: options?.limit || 1000,
        startTimestamp: options?.startTimestamp,
        endTimestamp: options?.endTimestamp,
      });
    }

    // Separate trades by outcome using index (more reliable than name matching)
    // outcomeIndex 0 = primary (Yes/Up/Team1), outcomeIndex 1 = secondary (No/Down/Team2)
    const yesTrades = trades.filter((t) => t.outcomeIndex === 0);
    const noTrades = trades.filter((t) => t.outcomeIndex === 1);

    const yesCandles = this.aggregateToKLines(yesTrades, interval);
    const noCandles = this.aggregateToKLines(noTrades, interval);

    // Get current orderbook for real-time spread analysis
    let currentOrderbook: ProcessedOrderbook | undefined;
    let realtimeSpread: RealtimeSpreadAnalysis | undefined;
    try {
      currentOrderbook = await this.getProcessedOrderbook(conditionId);
      realtimeSpread = this.calculateRealtimeSpread(currentOrderbook);
    } catch {
      // Orderbook not available
    }

    // Calculate historical spread from trade close prices (for backtesting)
    const spreadAnalysis = this.analyzeHistoricalSpread(yesCandles, noCandles);

    return {
      conditionId,
      interval,
      market,
      yes: yesCandles,
      no: noCandles,
      spreadAnalysis,      // Historical (trade-based)
      realtimeSpread,      // Real-time (orderbook-based)
      currentOrderbook,
    };
  }

  // ===== Token vs Underlying Correlation =====

  /**
   * Get aligned K-line data for token and underlying asset
   *
   * This method fetches K-line data from both Polymarket (token prices)
   * and Binance (underlying asset prices), aligns them by timestamp,
   * and optionally calculates Pearson correlation coefficients.
   *
   * @param conditionId - Market condition ID
   * @param underlying - Underlying asset (BTC, ETH, SOL)
   * @param interval - K-line interval (must be supported by both Poly and Binance)
   * @param options - Optional parameters
   * @returns Aligned data with optional correlation coefficients
   *
   * @example
   * ```typescript
   * const data = await marketService.getTokenUnderlyingData(
   *   '0x123...',
   *   'BTC',
   *   '1h',
   *   { limit: 100, calculateCorrelation: true }
   * );
   *
   * // Access aligned data
   * for (const point of data.data) {
   *   console.log(`${point.timestamp}: Up=${point.upPrice}, BTC=${point.underlyingPrice}`);
   * }
   *
   * // Check correlation
   * if (data.correlation) {
   *   console.log(`Correlation: ${data.correlation.upVsUnderlying}`);
   * }
   * ```
   */
  async getTokenUnderlyingData(
    conditionId: string,
    underlying: UnderlyingAsset,
    interval: KLineInterval,
    options?: {
      limit?: number;
      calculateCorrelation?: boolean;
    }
  ): Promise<TokenUnderlyingCorrelation> {
    // Validate BinanceService is available
    if (!this.binanceService) {
      throw new PolymarketError(
        ErrorCode.INVALID_CONFIG,
        'BinanceService is required for token-underlying correlation analysis'
      );
    }

    // Validate interval is supported by Binance
    const binanceInterval = KLINE_TO_BINANCE_INTERVAL[interval];
    if (!binanceInterval) {
      throw new PolymarketError(
        ErrorCode.INVALID_CONFIG,
        `Interval ${interval} is not supported for correlation analysis. ` +
        `Supported intervals: ${Object.keys(KLINE_TO_BINANCE_INTERVAL).join(', ')}`
      );
    }

    const limit = options?.limit || 500;

    // Fetch data in parallel
    const [dualKLines, binanceKLines] = await Promise.all([
      this.getDualKLinesOHLCV(conditionId, interval, { limit }),
      this.binanceService.getKLines(
        UNDERLYING_TO_SYMBOL[underlying],
        binanceInterval,
        { limit }
      ),
    ]);

    // Create maps for quick lookup
    const upMap = new Map(dualKLines.yes.map(c => [c.timestamp, c.close]));
    const downMap = new Map(dualKLines.no.map(c => [c.timestamp, c.close]));
    const binanceMap = new Map(binanceKLines.map(c => [c.timestamp, c.close]));

    // Get all unique timestamps and sort them
    const allTimestamps = new Set([
      ...upMap.keys(),
      ...downMap.keys(),
      ...binanceMap.keys(),
    ]);
    const sortedTimestamps = [...allTimestamps].sort((a, b) => a - b);

    // Find the first Binance price for calculating percentage change
    const firstBinancePrice = binanceKLines.length > 0 ? binanceKLines[0].close : 0;

    // Align data points
    const alignedData: TokenUnderlyingDataPoint[] = [];
    let lastUpPrice: number | undefined;
    let lastDownPrice: number | undefined;
    let lastBinancePrice: number | undefined;

    for (const timestamp of sortedTimestamps) {
      // Get prices, falling back to previous values if not available
      const upPrice = upMap.get(timestamp) ?? this.findNearestPrice(timestamp, upMap, sortedTimestamps);
      const downPrice = downMap.get(timestamp) ?? this.findNearestPrice(timestamp, downMap, sortedTimestamps);
      const binancePrice = binanceMap.get(timestamp) ?? this.findNearestPrice(timestamp, binanceMap, sortedTimestamps);

      // Update last known prices
      if (upPrice !== undefined) lastUpPrice = upPrice;
      if (downPrice !== undefined) lastDownPrice = downPrice;
      if (binancePrice !== undefined) lastBinancePrice = binancePrice;

      // Skip if we don't have underlying price
      if (lastBinancePrice === undefined) continue;

      const priceSum = (lastUpPrice !== undefined && lastDownPrice !== undefined)
        ? lastUpPrice + lastDownPrice
        : undefined;

      const underlyingChange = firstBinancePrice > 0
        ? ((lastBinancePrice - firstBinancePrice) / firstBinancePrice) * 100
        : 0;

      alignedData.push({
        timestamp,
        upPrice: lastUpPrice,
        downPrice: lastDownPrice,
        priceSum,
        underlyingPrice: lastBinancePrice,
        underlyingChange,
      });
    }

    // Calculate correlation if requested
    let correlation: TokenUnderlyingCorrelation['correlation'];
    if (options?.calculateCorrelation && alignedData.length >= 2) {
      correlation = this.calculatePearsonCorrelation(alignedData);
    }

    return {
      conditionId,
      underlying,
      interval,
      data: alignedData,
      correlation,
    };
  }

  /**
   * Find the nearest available price for a timestamp
   */
  private findNearestPrice(
    targetTimestamp: number,
    priceMap: Map<number, number>,
    sortedTimestamps: number[]
  ): number | undefined {
    if (priceMap.size === 0) return undefined;

    // Find the nearest timestamp that has a price
    let nearestTimestamp: number | undefined;
    let minDiff = Infinity;

    for (const ts of sortedTimestamps) {
      if (priceMap.has(ts)) {
        const diff = Math.abs(ts - targetTimestamp);
        if (diff < minDiff) {
          minDiff = diff;
          nearestTimestamp = ts;
        }
      }
    }

    return nearestTimestamp !== undefined ? priceMap.get(nearestTimestamp) : undefined;
  }

  /**
   * Calculate Pearson correlation coefficients
   */
  private calculatePearsonCorrelation(
    data: TokenUnderlyingDataPoint[]
  ): TokenUnderlyingCorrelation['correlation'] {
    // Filter data points that have all required prices
    const upData = data.filter(d => d.upPrice !== undefined && d.underlyingPrice !== undefined);
    const downData = data.filter(d => d.downPrice !== undefined && d.underlyingPrice !== undefined);

    const upVsUnderlying = this.pearson(
      upData.map(d => d.upPrice!),
      upData.map(d => d.underlyingPrice)
    );

    const downVsUnderlying = this.pearson(
      downData.map(d => d.downPrice!),
      downData.map(d => d.underlyingPrice)
    );

    return {
      upVsUnderlying,
      downVsUnderlying,
    };
  }

  /**
   * Calculate Pearson correlation coefficient between two arrays
   * Returns a value between -1 and 1
   */
  private pearson(x: number[], y: number[]): number {
    const n = Math.min(x.length, y.length);
    if (n < 2) return 0;

    // Calculate means
    let sumX = 0, sumY = 0;
    for (let i = 0; i < n; i++) {
      sumX += x[i];
      sumY += y[i];
    }
    const meanX = sumX / n;
    const meanY = sumY / n;

    // Calculate correlation
    let numerator = 0;
    let sumSqX = 0;
    let sumSqY = 0;

    for (let i = 0; i < n; i++) {
      const dx = x[i] - meanX;
      const dy = y[i] - meanY;
      numerator += dx * dy;
      sumSqX += dx * dx;
      sumSqY += dy * dy;
    }

    const denominator = Math.sqrt(sumSqX * sumSqY);
    if (denominator === 0) return 0;

    return numerator / denominator;
  }

  /**
   * Aggregate trades into K-Line candles
   *
   * Note: Polymarket API may return timestamps in seconds or milliseconds.
   * This function normalizes all timestamps to milliseconds for consistent handling.
   */
  private aggregateToKLines(trades: Trade[], interval: KLineInterval): KLineCandle[] {
    const intervalMs = getIntervalMs(interval);
    const buckets = new Map<number, Trade[]>();

    // Group trades into time buckets
    // Normalize timestamp to milliseconds (API sometimes returns seconds)
    for (const trade of trades) {
      const tradeTs = normalizeTimestamp(trade.timestamp);
      const bucketTime = Math.floor(tradeTs / intervalMs) * intervalMs;
      const bucket = buckets.get(bucketTime) || [];
      bucket.push(trade);
      buckets.set(bucketTime, bucket);
    }

    // Convert buckets to candles
    const candles: KLineCandle[] = [];
    for (const [timestamp, bucketTrades] of buckets) {
      if (bucketTrades.length === 0) continue;

      // Sort by normalized timestamp for correct open/close
      bucketTrades.sort((a, b) => normalizeTimestamp(a.timestamp) - normalizeTimestamp(b.timestamp));

      const prices = bucketTrades.map((t) => t.price);
      const buyTrades = bucketTrades.filter((t) => t.side === 'BUY');
      const sellTrades = bucketTrades.filter((t) => t.side === 'SELL');

      candles.push({
        timestamp,
        open: bucketTrades[0].price,
        high: Math.max(...prices),
        low: Math.min(...prices),
        close: bucketTrades[bucketTrades.length - 1].price,
        volume: bucketTrades.reduce((sum, t) => sum + t.size * t.price, 0),
        tradeCount: bucketTrades.length,
        buyVolume: buyTrades.reduce((sum, t) => sum + t.size * t.price, 0),
        sellVolume: sellTrades.reduce((sum, t) => sum + t.size * t.price, 0),
      });
    }

    return candles.sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Analyze historical spread from trade close prices (for backtesting)
   *
   * This uses trade close prices, not orderbook bid/ask.
   * Useful for:
   * - Historical analysis / backtesting
   * - Understanding past price movements
   * - Identifying patterns when orderbook data unavailable
   */
  private analyzeHistoricalSpread(
    yesCandles: KLineCandle[],
    noCandles: KLineCandle[]
  ): SpreadDataPoint[] {
    const yesMap = new Map(yesCandles.map((c) => [c.timestamp, c]));
    const noMap = new Map(noCandles.map((c) => [c.timestamp, c]));

    const allTimestamps = [...new Set([...yesMap.keys(), ...noMap.keys()])].sort();

    let lastYes = 0.5;
    let lastNo = 0.5;
    const analysis: SpreadDataPoint[] = [];

    for (const ts of allTimestamps) {
      const yesCandle = yesMap.get(ts);
      const noCandle = noMap.get(ts);

      if (yesCandle) lastYes = yesCandle.close;
      if (noCandle) lastNo = noCandle.close;

      const priceSum = lastYes + lastNo;
      const priceSpread = priceSum - 1;

      // Determine arb opportunity based on price deviation
      // Note: This is indicative only - actual arb requires orderbook analysis
      let arbOpportunity: 'LONG' | 'SHORT' | '' = '';
      if (priceSpread < -0.005) arbOpportunity = 'LONG';   // Sum < 0.995
      else if (priceSpread > 0.005) arbOpportunity = 'SHORT'; // Sum > 1.005

      analysis.push({
        timestamp: ts,
        yesPrice: lastYes,
        noPrice: lastNo,
        priceSum,
        priceSpread,
        arbOpportunity,
      });
    }

    return analysis;
  }

  /**
   * Analyze spread from price line data (from /prices-history API).
   *
   * Aligns primary and secondary price points by timestamp and computes
   * the sum and deviation from 1.0 at each aligned point.
   */
  private analyzePriceLineSpread(
    primary: PricePoint[],
    secondary: PricePoint[]
  ): PriceLineSpreadPoint[] {
    const primaryMap = new Map(primary.map(p => [p.timestamp, p.price]));
    const secondaryMap = new Map(secondary.map(p => [p.timestamp, p.price]));

    const allTimestamps = [...new Set([...primaryMap.keys(), ...secondaryMap.keys()])].sort((a, b) => a - b);

    let lastPrimary = 0.5;
    let lastSecondary = 0.5;
    const analysis: PriceLineSpreadPoint[] = [];

    for (const ts of allTimestamps) {
      const pPrice = primaryMap.get(ts);
      const sPrice = secondaryMap.get(ts);

      if (pPrice !== undefined) lastPrimary = pPrice;
      if (sPrice !== undefined) lastSecondary = sPrice;

      const priceSum = lastPrimary + lastSecondary;

      analysis.push({
        timestamp: ts,
        primaryPrice: lastPrimary,
        secondaryPrice: lastSecondary,
        priceSum,
        priceSpread: priceSum - 1,
      });
    }

    return analysis;
  }

  /**
   * Calculate real-time spread from orderbook (for live trading)
   *
   * This uses orderbook bid/ask prices for accurate arbitrage detection.
   * Useful for:
   * - Real-time arbitrage execution
   * - Live trading decisions
   * - Accurate profit calculations
   */
  private calculateRealtimeSpread(orderbook: ProcessedOrderbook): RealtimeSpreadAnalysis {
    const { yes, no, summary } = orderbook;

    // Determine arbitrage opportunity
    let arbOpportunity: 'LONG' | 'SHORT' | '' = '';
    let arbProfitPercent = 0;

    if (summary.longArbProfit > 0.001) {  // > 0.1% threshold
      arbOpportunity = 'LONG';
      arbProfitPercent = summary.longArbProfit * 100;
    } else if (summary.shortArbProfit > 0.001) {  // > 0.1% threshold
      arbOpportunity = 'SHORT';
      arbProfitPercent = summary.shortArbProfit * 100;
    }

    return {
      timestamp: Date.now(),
      // Orderbook prices
      yesBid: yes.bid,
      yesAsk: yes.ask,
      noBid: no.bid,
      noAsk: no.ask,
      // Spread metrics
      askSum: summary.askSum,
      bidSum: summary.bidSum,
      askSpread: summary.askSum - 1,
      bidSpread: summary.bidSum - 1,
      // Arbitrage
      longArbProfit: summary.longArbProfit,
      shortArbProfit: summary.shortArbProfit,
      arbOpportunity,
      arbProfitPercent,
    };
  }

  /**
   * Get real-time spread analysis only (without K-lines)
   * Use this for quick arbitrage checks
   */
  async getRealtimeSpread(conditionId: string): Promise<RealtimeSpreadAnalysis> {
    const orderbook = await this.getProcessedOrderbook(conditionId);
    return this.calculateRealtimeSpread(orderbook);
  }

  // ===== Orderbook Analysis =====

  /**
   * Get processed orderbook with analytics (alias for getProcessedOrderbook)
   */
  async getOrderbook(conditionId: string): Promise<ProcessedOrderbook> {
    return this.getProcessedOrderbook(conditionId);
  }

  /**
   * Detect arbitrage opportunity
   *
   * 使用有效价格（考虑镜像订单）计算套利机会
   * 详细原理见: docs/01-polymarket-orderbook-arbitrage.md
   */
  async detectArbitrage(conditionId: string, threshold = 0.005): Promise<ArbitrageOpportunity | null> {
    const orderbook = await this.getOrderbook(conditionId);
    const { effectivePrices } = orderbook.summary;

    if (orderbook.summary.longArbProfit > threshold) {
      return {
        type: 'long',
        profit: orderbook.summary.longArbProfit,
        // 使用有效价格描述实际操作
        action: `Buy YES @ ${effectivePrices.effectiveBuyYes.toFixed(4)} + NO @ ${effectivePrices.effectiveBuyNo.toFixed(4)}, Merge for $1`,
        expectedProfit: orderbook.summary.longArbProfit,
      };
    }

    if (orderbook.summary.shortArbProfit > threshold) {
      return {
        type: 'short',
        profit: orderbook.summary.shortArbProfit,
        // 使用有效价格描述实际操作
        action: `Split $1, Sell YES @ ${effectivePrices.effectiveSellYes.toFixed(4)} + NO @ ${effectivePrices.effectiveSellNo.toFixed(4)}`,
        expectedProfit: orderbook.summary.shortArbProfit,
      };
    }

    return null;
  }

  // ===== Market Discovery =====

  /**
   * Get trending markets
   */
  async getTrendingMarkets(limit = 20): Promise<GammaMarket[]> {
    if (!this.gammaApi) {
      throw new PolymarketError(ErrorCode.INVALID_CONFIG, 'GammaApiClient is required for trending markets');
    }
    return this.gammaApi.getTrendingMarkets(limit);
  }

  /**
   * Search markets
   */
  async searchMarkets(params: {
    active?: boolean;
    closed?: boolean;
    limit?: number;
    offset?: number;
    order?: string;
  }): Promise<GammaMarket[]> {
    if (!this.gammaApi) {
      throw new PolymarketError(ErrorCode.INVALID_CONFIG, 'GammaApiClient is required for market search');
    }
    return this.gammaApi.getMarkets(params);
  }

  /**
   * Scan for short-term crypto markets (Up/Down markets ending soon)
   *
   * ## Market Types
   * Polymarket has short-term crypto markets in two durations:
   * - **5-minute markets**: slug pattern `{coin}-updown-5m-{timestamp}`
   * - **15-minute markets**: slug pattern `{coin}-updown-15m-{timestamp}`
   *
   * ## Slug Pattern
   * The timestamp in the slug is the START time of the time window:
   * - 15-minute markets: `{coin}-updown-15m-{Math.floor(startTime / 900) * 900}`
   * - 5-minute markets: `{coin}-updown-5m-{Math.floor(startTime / 300) * 300}`
   *
   * Example: `btc-updown-15m-1767456000` starts at 1767456000 (16:00:00 UTC)
   * and ends 15 minutes later at 1767456900 (16:15:00 UTC)
   *
   * ## Supported Coins
   * - BTC (Bitcoin)
   * - ETH (Ethereum)
   * - SOL (Solana)
   * - XRP (Ripple)
   *
   * ## Market Lifecycle Rules
   * 1. Markets are created ahead of time (before they become tradeable)
   * 2. New markets may not have prices yet (show 0.5/0.5)
   * 3. When one market ends, the next one is already open for trading
   * 4. A market ending doesn't mean no price - it means resolution is pending
   *
   * ## Outcomes
   * All crypto short-term markets have:
   * - outcomes: ["Up", "Down"]
   * - Resolution based on price movement during the time window
   *
   * @param options - Scan options
   * @param options.minMinutesUntilEnd - Minimum minutes until market ends (default: 5)
   * @param options.maxMinutesUntilEnd - Maximum minutes until market ends (default: 60)
   * @param options.limit - Maximum number of markets to return (default: 20)
   * @param options.sortBy - Sort field: 'endDate' | 'volume' | 'liquidity' (default: 'endDate')
   * @param options.duration - Filter by duration: '5m' | '15m' | 'all' (default: 'all')
   * @param options.coin - Filter by coin: 'BTC' | 'ETH' | 'SOL' | 'XRP' | 'all' (default: 'all')
   * @returns Array of crypto short-term markets
   *
   * @example
   * ```typescript
   * // Find all 15-minute markets ending in 5-30 minutes
   * const markets = await sdk.markets.scanCryptoShortTermMarkets({
   *   minMinutesUntilEnd: 5,
   *   maxMinutesUntilEnd: 30,
   *   duration: '15m',
   * });
   *
   * // Find BTC 5-minute markets only
   * const btcMarkets = await sdk.markets.scanCryptoShortTermMarkets({
   *   coin: 'BTC',
   *   duration: '5m',
   * });
   * ```
   */
  async scanCryptoShortTermMarkets(options?: {
    minMinutesUntilEnd?: number;
    maxMinutesUntilEnd?: number;
    limit?: number;
    sortBy?: 'endDate' | 'volume' | 'liquidity';
    duration?: '5m' | '15m' | 'all';
    coin?: 'BTC' | 'ETH' | 'SOL' | 'XRP' | 'all';
  }): Promise<GammaMarket[]> {
    if (!this.gammaApi) {
      throw new PolymarketError(ErrorCode.INVALID_CONFIG, 'GammaApiClient is required for market scanning');
    }

    const {
      minMinutesUntilEnd = 5,
      maxMinutesUntilEnd = 60,
      limit = 20,
      sortBy = 'endDate',
      duration = 'all',
      coin = 'all',
    } = options ?? {};

    // Duration to interval seconds mapping
    const durationIntervals: Record<string, number> = {
      '5m': 300,   // 5 minutes in seconds
      '15m': 900,  // 15 minutes in seconds
    };

    // Supported coins
    const allCoins = ['btc', 'eth', 'sol', 'xrp'] as const;
    const targetCoins = coin === 'all' ? allCoins : [coin.toLowerCase()];

    // Target durations
    const targetDurations = duration === 'all' ? ['5m', '15m'] : [duration];

    // Calculate time slots to fetch
    const nowSeconds = Math.floor(Date.now() / 1000);
    const minEndSeconds = nowSeconds + minMinutesUntilEnd * 60;
    const maxEndSeconds = nowSeconds + maxMinutesUntilEnd * 60;

    // Generate slugs for all combinations
    const slugsToFetch: string[] = [];

    for (const dur of targetDurations) {
      const intervalSeconds = durationIntervals[dur];
      const durationStr = dur.replace('m', 'm'); // 5m or 15m

      // Calculate the current slot and extend to cover the time range
      // The slug timestamp is the START time, endTime = startTime + interval
      // So if we want markets ending after minEndSeconds:
      //   startTime + interval >= minEndSeconds => startTime >= minEndSeconds - interval
      // And ending before maxEndSeconds:
      //   startTime + interval <= maxEndSeconds => startTime <= maxEndSeconds - interval

      const minSlotStart = Math.floor((minEndSeconds - intervalSeconds) / intervalSeconds) * intervalSeconds;
      const maxSlotStart = Math.ceil(maxEndSeconds / intervalSeconds) * intervalSeconds;

      // Generate slots from minSlotStart to maxSlotStart
      for (let slotStart = minSlotStart; slotStart <= maxSlotStart; slotStart += intervalSeconds) {
        for (const coinName of targetCoins) {
          slugsToFetch.push(`${coinName}-updown-${durationStr}-${slotStart}`);
        }
      }
    }

    // Fetch markets in parallel batches
    const BATCH_SIZE = 10;
    const allMarkets: GammaMarket[] = [];

    for (let i = 0; i < slugsToFetch.length; i += BATCH_SIZE) {
      const batch = slugsToFetch.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(
        batch.map(async (slug) => {
          try {
            const markets = await this.gammaApi!.getMarkets({ slug, limit: 1 });
            return markets.length > 0 ? markets[0] : null;
          } catch {
            return null;
          }
        })
      );

      for (const market of results) {
        if (market && market.active && !market.closed) {
          allMarkets.push(market);
        }
      }
    }

    // Filter by end time range
    const nowMs = Date.now();
    const minEndTime = nowMs + minMinutesUntilEnd * 60 * 1000;
    const maxEndTime = nowMs + maxMinutesUntilEnd * 60 * 1000;

    const filteredMarkets = allMarkets.filter((market) => {
      const endTime = market.endDate ? new Date(market.endDate).getTime() : 0;
      return endTime >= minEndTime && endTime <= maxEndTime;
    });

    // Sort by preference
    if (sortBy === 'volume') {
      filteredMarkets.sort((a, b) => (b.volume24hr ?? 0) - (a.volume24hr ?? 0));
    } else if (sortBy === 'liquidity') {
      filteredMarkets.sort((a, b) => (b.liquidity ?? 0) - (a.liquidity ?? 0));
    } else {
      // Sort by endDate (soonest first)
      filteredMarkets.sort((a, b) => {
        const aEnd = a.endDate ? new Date(a.endDate).getTime() : Infinity;
        const bEnd = b.endDate ? new Date(b.endDate).getTime() : Infinity;
        return aEnd - bEnd;
      });
    }

    return filteredMarkets.slice(0, limit);
  }

  // ===== Market Signal Detection =====

  /**
   * Detect market signals (volume surge, depth imbalance, whale trades)
   */
  async detectMarketSignals(conditionId: string): Promise<
    Array<{
      type: 'volume_surge' | 'depth_imbalance' | 'whale_trade' | 'momentum';
      severity: 'low' | 'medium' | 'high';
      details: Record<string, unknown>;
    }>
  > {
    const signals: Array<{
      type: 'volume_surge' | 'depth_imbalance' | 'whale_trade' | 'momentum';
      severity: 'low' | 'medium' | 'high';
      details: Record<string, unknown>;
    }> = [];

    if (!this.dataApi) {
      throw new PolymarketError(ErrorCode.INVALID_CONFIG, 'DataApiClient is required for signal detection');
    }
    const market = await this.getMarket(conditionId);
    const orderbook = await this.getOrderbook(conditionId);
    const trades = await this.dataApi.getTradesByMarket(conditionId, 100);

    // Volume surge detection
    if (market.volume24hr && market.volume > 0) {
      const avgDaily = market.volume / 7; // Approximate
      const ratio = market.volume24hr / avgDaily;
      if (ratio > 2) {
        signals.push({
          type: 'volume_surge',
          severity: ratio > 5 ? 'high' : ratio > 3 ? 'medium' : 'low',
          details: { volume24hr: market.volume24hr, avgDaily, ratio },
        });
      }
    }

    // Depth imbalance detection
    if (orderbook.summary.imbalanceRatio > 1.5 || orderbook.summary.imbalanceRatio < 0.67) {
      const ratio = orderbook.summary.imbalanceRatio;
      signals.push({
        type: 'depth_imbalance',
        severity: ratio > 3 || ratio < 0.33 ? 'high' : 'medium',
        details: {
          imbalanceRatio: ratio,
          bidDepth: orderbook.summary.totalBidDepth,
          askDepth: orderbook.summary.totalAskDepth,
          direction: ratio > 1 ? 'BUY_PRESSURE' : 'SELL_PRESSURE',
        },
      });
    }

    // Whale trade detection
    const recentLargeTrades = trades.filter((t) => t.size * t.price > 1000);
    for (const trade of recentLargeTrades.slice(0, 3)) {
      const value = trade.size * trade.price;
      signals.push({
        type: 'whale_trade',
        severity: value > 10000 ? 'high' : value > 5000 ? 'medium' : 'low',
        details: {
          size: trade.size,
          price: trade.price,
          usdValue: value,
          side: trade.side,
          outcome: trade.outcome,
        },
      });
    }

    return signals;
  }

  // ===== Helper Methods =====

  private normalizeClobMarket(m: ClobMarket): Market {
    return {
      conditionId: m.condition_id,
      questionId: m.question_id,
      marketSlug: m.market_slug,
      question: m.question,
      description: m.description,
      tokens: m.tokens.map(t => ({
        tokenId: t.token_id,
        outcome: t.outcome,
        price: t.price,
        winner: t.winner,
      })),
      active: m.active,
      closed: m.closed,
      acceptingOrders: m.accepting_orders,
      endDateIso: m.end_date_iso,
      negRisk: m.neg_risk,
      minimumOrderSize: m.minimum_order_size,
      minimumTickSize: m.minimum_tick_size,
    };
  }

  private processOrderbooks(
    yesBook: Orderbook,
    noBook: Orderbook,
    yesTokenId?: string,
    noTokenId?: string
  ): ProcessedOrderbook {
    const yesBestBid = yesBook.bids[0]?.price || 0;
    const yesBestAsk = yesBook.asks[0]?.price || 1;
    const noBestBid = noBook.bids[0]?.price || 0;
    const noBestAsk = noBook.asks[0]?.price || 1;

    const yesBidDepth = yesBook.bids.reduce((sum, l) => sum + l.price * l.size, 0);
    const yesAskDepth = yesBook.asks.reduce((sum, l) => sum + l.price * l.size, 0);
    const noBidDepth = noBook.bids.reduce((sum, l) => sum + l.price * l.size, 0);
    const noAskDepth = noBook.asks.reduce((sum, l) => sum + l.price * l.size, 0);

    const askSum = yesBestAsk + noBestAsk;
    const bidSum = yesBestBid + noBestBid;

    // Effective prices (accounting for mirroring)
    const effectivePrices: EffectivePrices = {
      effectiveBuyYes: Math.min(yesBestAsk, 1 - noBestBid),
      effectiveBuyNo: Math.min(noBestAsk, 1 - yesBestBid),
      effectiveSellYes: Math.max(yesBestBid, 1 - noBestAsk),
      effectiveSellNo: Math.max(noBestBid, 1 - yesBestAsk),
    };

    const effectiveLongCost = effectivePrices.effectiveBuyYes + effectivePrices.effectiveBuyNo;
    const effectiveShortRevenue = effectivePrices.effectiveSellYes + effectivePrices.effectiveSellNo;

    const longArbProfit = 1 - effectiveLongCost;
    const shortArbProfit = effectiveShortRevenue - 1;

    const yesSpread = yesBestAsk - yesBestBid;

    return {
      yes: {
        bid: yesBestBid,
        ask: yesBestAsk,
        bidSize: yesBook.bids[0]?.size || 0,
        askSize: yesBook.asks[0]?.size || 0,
        bidDepth: yesBidDepth,
        askDepth: yesAskDepth,
        spread: yesSpread,
        tokenId: yesTokenId,
      },
      no: {
        bid: noBestBid,
        ask: noBestAsk,
        bidSize: noBook.bids[0]?.size || 0,
        askSize: noBook.asks[0]?.size || 0,
        bidDepth: noBidDepth,
        askDepth: noAskDepth,
        spread: noBestAsk - noBestBid,
        tokenId: noTokenId,
      },
      summary: {
        askSum,
        bidSum,
        effectivePrices,
        effectiveLongCost,
        effectiveShortRevenue,
        longArbProfit,
        shortArbProfit,
        totalBidDepth: yesBidDepth + noBidDepth,
        totalAskDepth: yesAskDepth + noAskDepth,
        imbalanceRatio: (yesBidDepth + noBidDepth) / (yesAskDepth + noAskDepth + 0.001),
        yesSpread,
      },
    };
  }

  private mergeMarkets(gamma: GammaMarket, clob: Market): UnifiedMarket {
    // Build tokens array from CLOB data, falling back to Gamma prices
    const tokens: UnifiedMarketToken[] = clob.tokens.map((t, index) => ({
      tokenId: t.tokenId,
      outcome: t.outcome,
      price: t.price || gamma.outcomePrices[index] || 0.5,
      winner: t.winner,
    }));

    return {
      conditionId: clob.conditionId,
      slug: gamma.slug,
      question: clob.question,
      description: clob.description || gamma.description,
      tokens,
      volume: gamma.volume,
      volume24hr: gamma.volume24hr,
      liquidity: gamma.liquidity,
      spread: gamma.spread,
      oneDayPriceChange: gamma.oneDayPriceChange,
      oneWeekPriceChange: gamma.oneWeekPriceChange,
      active: clob.active,
      closed: clob.closed,
      acceptingOrders: clob.acceptingOrders,
      endDate: clob.endDateIso ? new Date(clob.endDateIso) : new Date(),
      source: 'merged',
    };
  }

  private fromGammaMarket(gamma: GammaMarket): UnifiedMarket {
    // Create tokens from Gamma outcomes - use actual outcome names from gamma data
    // This supports Yes/No, Up/Down, Team1/Team2, Heads/Tails, etc.
    const outcomes = gamma.outcomes || ['Yes', 'No'];
    const tokens: UnifiedMarketToken[] = [
      { tokenId: '', outcome: outcomes[0], price: gamma.outcomePrices[0] || 0.5 },
      { tokenId: '', outcome: outcomes[1], price: gamma.outcomePrices[1] || 0.5 },
    ];

    return {
      conditionId: gamma.conditionId,
      slug: gamma.slug,
      question: gamma.question,
      description: gamma.description,
      tokens,
      volume: gamma.volume,
      volume24hr: gamma.volume24hr,
      liquidity: gamma.liquidity,
      spread: gamma.spread,
      oneDayPriceChange: gamma.oneDayPriceChange,
      oneWeekPriceChange: gamma.oneWeekPriceChange,
      active: gamma.active,
      closed: gamma.closed,
      acceptingOrders: !gamma.closed,
      endDate: gamma.endDate,
      source: 'gamma',
    };
  }

  private fromClobMarket(clob: Market): UnifiedMarket {
    // Convert CLOB tokens to UnifiedMarketToken format
    const tokens: UnifiedMarketToken[] = clob.tokens.map(t => ({
      tokenId: t.tokenId,
      outcome: t.outcome,
      price: t.price,
      winner: t.winner,
    }));

    return {
      conditionId: clob.conditionId,
      slug: clob.marketSlug,
      question: clob.question,
      description: clob.description,
      tokens,
      volume: 0,
      volume24hr: undefined,
      liquidity: 0,
      spread: undefined,
      active: clob.active,
      closed: clob.closed,
      acceptingOrders: clob.acceptingOrders,
      endDate: clob.endDateIso ? new Date(clob.endDateIso) : new Date(),
      source: 'clob',
    };
  }
}

// ===== Utility Functions =====

export function getIntervalMs(interval: KLineInterval): number {
  const map: Record<KLineInterval, number> = {
    // Second-level intervals (for 15-minute crypto markets)
    '1s': 1 * 1000,
    '5s': 5 * 1000,
    '15s': 15 * 1000,
    '30s': 30 * 1000,
    // Minute-level intervals
    '1m': 60 * 1000,
    '5m': 5 * 60 * 1000,
    '15m': 15 * 60 * 1000,
    '30m': 30 * 60 * 1000,
    // Hour-level intervals
    '1h': 60 * 60 * 1000,
    '4h': 4 * 60 * 60 * 1000,
    '12h': 12 * 60 * 60 * 1000,
    '1d': 24 * 60 * 60 * 1000,
  };
  return map[interval];
}
