/**
 * Common types used across the SDK
 */

import type { CacheAdapter } from '@catalyst-team/cache';

// ===== Basic Trading Types =====

/**
 * Order side: BUY or SELL
 */
export type Side = 'BUY' | 'SELL';

/**
 * Order type for limit/market orders
 * - GTC: Good Till Cancelled (default for limit orders)
 * - GTD: Good Till Date (limit order with expiration)
 * - FOK: Fill Or Kill (market order, must fill completely or cancel)
 * - FAK: Fill And Kill (market order, fill what you can, cancel rest)
 */
export type OrderType = 'GTC' | 'FOK' | 'GTD' | 'FAK';

/**
 * ============================================================================
 * Order Status - Internal State Management
 * ============================================================================
 *
 * This SDK uses a 7-state enum for detailed order lifecycle tracking.
 * Polymarket CLOB API returns 4 states which are mapped to these internal states.
 *
 * State Flow (Happy Path):
 * ┌────────┐    submit    ┌──────┐    match    ┌─────────────────┐    full fill    ┌────────┐
 * │pending │ ───────────> │ open │ ─────────> │partially_filled │ ──────────────> │ filled │
 * └────────┘              └──────┘             └─────────────────┘                 └────────┘
 *
 * State Flow (Cancellation Path):
 * ┌────────┐                ┌───────────┐
 * │pending │ ─── reject ──> │ rejected  │
 * └────────┘                └───────────┘
 *     │
 *     │  ┌──────┐                ┌───────────┐
 *     └─>│ open │ ─── cancel ──> │cancelled  │
 *        └──────┘                └───────────┘
 *           │
 *           └─── expire ──────> ┌──────────┐
 *                                │ expired  │
 *                                └──────────┘
 *
 * State Mapping (Polymarket API → Internal):
 * - API "live"      → open (order in orderbook, no fills)
 * - API "matched"   → partially_filled (some fills) OR filled (fully filled)
 * - API "delayed"   → pending (order submitted but not yet in orderbook)
 * - API "cancelled" → cancelled
 * - API "expired"   → expired (if GTD order expires)
 * - (rejection)     → rejected (order failed validation, not in API)
 *
 * Terminal States: filled, cancelled, expired, rejected
 * Active States: pending, open, partially_filled
 *
 * @see https://docs.polymarket.com/#tag/Orders (Polymarket order states)
 * @see https://docs.polymarket.com/developers/CLOB/order-lifecycle (Order lifecycle)
 */
export enum OrderStatus {
  /**
   * pending - Order created locally but not yet submitted to exchange
   *
   * Transitions:
   * - → open (submission successful)
   * - → rejected (submission failed)
   *
   * Use case: Pre-submission validation, rate limiting queue
   */
  PENDING = 'pending',

  /**
   * open - Order submitted and active in orderbook, no fills yet
   *
   * Polymarket API status: "live"
   * Transitions:
   * - → partially_filled (first fill received)
   * - → filled (immediate full fill, rare)
   * - → cancelled (user cancels)
   * - → expired (GTD order expires)
   *
   * Use case: Active maker orders, liquidity provision
   */
  OPEN = 'open',

  /**
   * partially_filled - Order has received some fills but not complete
   *
   * Polymarket API status: "matched" (size_matched > 0 && size_matched < original_size)
   * Transitions:
   * - → filled (remaining size filled)
   * - → cancelled (user cancels remaining)
   * - → expired (GTD order expires with remaining)
   *
   * Use case: Large orders filling incrementally
   */
  PARTIALLY_FILLED = 'partially_filled',

  /**
   * filled - Order completely filled
   *
   * Polymarket API status: "matched" (size_matched == original_size)
   * Terminal state: No further transitions
   *
   * Use case: Successful order completion
   */
  FILLED = 'filled',

  /**
   * cancelled - Order cancelled by user or system
   *
   * Polymarket API status: "cancelled"
   * Terminal state: No further transitions
   *
   * Use case: User cancellation, strategy stop, position limit reached
   */
  CANCELLED = 'cancelled',

  /**
   * expired - GTD order expired before completion
   *
   * Polymarket API status: "expired" (or inferred from expiration timestamp)
   * Terminal state: No further transitions
   *
   * Use case: Time-limited orders
   */
  EXPIRED = 'expired',

  /**
   * rejected - Order rejected during submission (never reached exchange)
   *
   * Not returned by Polymarket API (local state only)
   * Terminal state: No further transitions
   *
   * Common reasons:
   * - Below minimum size/value ($1, 5 shares)
   * - Invalid price (out of tick size)
   * - Insufficient balance
   * - API validation error
   *
   * Use case: Pre-flight validation failures
   */
  REJECTED = 'rejected',
}

/**
 * Legacy string-based status type for backward compatibility
 * @deprecated Use OrderStatus enum instead
 */
export type OrderStatusString =
  | 'pending'
  | 'open'
  | 'partially_filled'
  | 'filled'
  | 'cancelled'
  | 'expired'
  | 'rejected';

/**
 * Base trade interface with common fields
 *
 * This is the minimal set of fields that all trade types share.
 * Specific trade types (Trade, TradeInfo, ActivityTrade, ParsedTrade)
 * extend this with source-specific fields.
 */
export interface BaseTrade {
  /** Trade side: BUY or SELL */
  side: Side;
  /** Trade price */
  price: number;
  /** Trade size (in shares/tokens) */
  size: number;
  /** Timestamp (Unix milliseconds) */
  timestamp: number;
}

// ===== Orderbook Types =====

/**
 * Price level in an orderbook
 */
export interface OrderbookLevel {
  price: number;
  size: number;
}

/**
 * Unified Orderbook type used across the SDK
 *
 * This is the base orderbook structure. Services may extend this
 * with additional fields (e.g., OrderbookSnapshot adds tickSize, minOrderSize).
 */
export interface Orderbook {
  /** Token ID (ERC-1155 token identifier) */
  tokenId?: string;
  /** @deprecated Use tokenId instead */
  assetId?: string;
  /** Bid levels (highest first) */
  bids: OrderbookLevel[];
  /** Ask levels (lowest first) */
  asks: OrderbookLevel[];
  /** Timestamp in milliseconds */
  timestamp: number;
  /** Market identifier (conditionId) */
  market?: string;
  /** Hash for change detection */
  hash?: string;
}

/**
 * SDK Configuration Options
 *
 * Allows dependency injection of cache adapters for API response caching.
 *
 * @example
 * ```typescript
 * import { createMemoryCache } from '@catalyst-team/cache';
 * import { PolymarketSDK } from '@catalyst-team/poly-sdk';
 *
 * // Use external cache adapter
 * const cache = createMemoryCache({ defaultTTL: 120 });
 * const sdk = new PolymarketSDK({ cache });
 *
 * // Or use default internal cache
 * const sdk2 = new PolymarketSDK();
 * ```
 */
export interface PolySDKOptions {
  /**
   * Optional external cache adapter for API response caching.
   * If not provided, the SDK will use its internal memory cache.
   *
   * Benefits of external cache:
   * - Can use Redis for multi-instance cache sharing
   * - Can configure custom TTL settings
   * - Can track cache hit/miss statistics
   */
  cache?: CacheAdapter;

  /**
   * Blockchain chain ID (default: 137 for Polygon mainnet)
   */
  chainId?: number;

  /**
   * Private key for trading operations (hex string starting with 0x)
   */
  privateKey?: string;

  /**
   * API credentials for trading
   */
  creds?: {
    key: string;
    secret: string;
    passphrase: string;
  };
}

// K-Line interval types
// Short intervals (1s, 5s, 15s) for 15-minute crypto markets
// Standard intervals (30s, 1m, 5m, 15m, 30m, 1h, 4h, 12h, 1d) for general use
export type KLineInterval = '1s' | '5s' | '15s' | '30s' | '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '12h' | '1d';

// K-Line candle data
export interface KLineCandle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  tradeCount: number;
  buyVolume: number;
  sellVolume: number;
}

/**
 * ============================================================================
 * Spread Analysis Types - Two Different Approaches
 * ============================================================================
 *
 * Polymarket 双代币模型：YES + NO = 1 USDC
 * 理想状态下，YES_price + NO_price = 1.0
 * 偏离 1.0 时可能存在套利机会
 *
 * 我们提供两种 Spread 分析方式，各有优劣：
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  SpreadDataPoint (历史分析)          │  RealtimeSpreadAnalysis (实时分析) │
 * ├─────────────────────────────────────────────────────────────────────────┤
 * │  数据源: 成交记录的收盘价              │  数据源: 订单簿的最优 bid/ask      │
 * │  YES_close + NO_close                │  YES_ask + NO_ask (买入成本)       │
 * │                                      │  YES_bid + NO_bid (卖出收入)       │
 * ├─────────────────────────────────────────────────────────────────────────┤
 * │  ✅ 可构建历史曲线                    │  ❌ 无法构建历史曲线*               │
 * │  ✅ Polymarket 保留成交历史           │  ❌ Polymarket 不保留盘口历史       │
 * │  ✅ 适合回测、模式识别                │  ✅ 适合实盘交易、套利执行          │
 * │  ⚠️ 反映已成交价格，非当前可成交价    │  ✅ 反映当前可立即成交的价格        │
 * │  ⚠️ 套利信号仅供参考                  │  ✅ 套利利润计算准确                │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * * 如需构建实时 Spread 的历史曲线，必须自行存储盘口快照数据
 *   参考: apps/api/src/services/spread-sampler.ts
 *
 * 核心区别说明：
 *
 * 1. 成交价 vs 盘口价
 *    - 成交价 (close): 过去某时刻实际成交的价格
 *    - 盘口价 (bid/ask): 当前市场上的最优挂单价格
 *    - 例: YES 最后成交 0.52，但当前 bid=0.50, ask=0.54
 *
 * 2. 为什么套利计算用盘口价更准确？
 *    - 套利需要同时买入 YES 和 NO
 *    - 必须用 ask 价（卖方挂单）计算买入成本
 *    - 成交价可能是 bid 方成交，不代表你能以该价买入
 *
 * 3. 为什么历史分析只能用成交价？
 *    - Polymarket CLOB API 不保存历史盘口数据
 *    - 只有成交记录 (trades) 有历史
 *    - 除非你自己运行 spread-sampler 持续采样盘口
 */

/**
 * 历史 Spread 分析（基于成交收盘价）
 *
 * 用途：
 * - 历史趋势分析、回测
 * - 识别价格偏离模式
 * - 当盘口数据不可用时的替代方案
 *
 * 局限：
 * - priceSpread 仅反映成交价偏离，非实际可套利空间
 * - arbOpportunity 仅为参考信号，实际套利需查看盘口
 *
 * 数据来源：Polymarket Data API /trades 历史成交记录
 */
export interface SpreadDataPoint {
  timestamp: number;
  yesPrice: number;      // YES 收盘价 (来自成交记录)
  noPrice: number;       // NO 收盘价 (来自成交记录)
  priceSum: number;      // YES + NO 收盘价之和
  priceSpread: number;   // priceSum - 1 (偏离均衡的程度)
  arbOpportunity: 'LONG' | 'SHORT' | '';  // 基于价格偏离的参考信号
}

/**
 * 实时 Spread 分析（基于订单簿 bid/ask）
 *
 * 用途：
 * - 实盘套利决策
 * - 精确计算套利利润
 * - 监控当前市场状态
 *
 * 局限：
 * - ❌ 无法构建历史曲线 - Polymarket 不保存盘口历史
 * - 如需历史数据，必须自行运行采样服务持续存储盘口快照
 *   参考实现: apps/api/src/services/spread-sampler.ts
 *
 * 数据来源：Polymarket CLOB API /book 实时订单簿
 *
 * 套利逻辑：
 * - Long Arb (多头套利): askSum < 1 时，买入 YES + NO 成本 < 1 USDC
 *   利润 = 1 - askSum，因为最终一方会 resolve 为 1 USDC
 *
 * - Short Arb (空头套利): bidSum > 1 时，卖出 YES + NO 收入 > 1 USDC
 *   利润 = bidSum - 1，需要先铸造代币对（成本 1 USDC）
 */
export interface RealtimeSpreadAnalysis {
  timestamp: number;

  // ===== 订单簿价格 =====
  yesBid: number;        // YES 最优买价 (你能卖出的价格)
  yesAsk: number;        // YES 最优卖价 (你能买入的价格)
  noBid: number;         // NO 最优买价
  noAsk: number;         // NO 最优卖价

  // ===== Spread 指标 =====
  askSum: number;        // YES_ask + NO_ask = 买入双边的总成本
  bidSum: number;        // YES_bid + NO_bid = 卖出双边的总收入
  askSpread: number;     // askSum - 1 (负值 = 多头套利空间)
  bidSpread: number;     // bidSum - 1 (正值 = 空头套利空间)

  // ===== 套利分析 =====
  longArbProfit: number;   // 1 - askSum，> 0 表示多头套利机会
  shortArbProfit: number;  // bidSum - 1，> 0 表示空头套利机会
  arbOpportunity: 'LONG' | 'SHORT' | '';  // 当前套利方向
  arbProfitPercent: number;  // 套利利润百分比
}

/**
 * 双代币 K 线数据（YES + NO）
 *
 * 包含两种 Spread 分析：
 * - spreadAnalysis: 历史曲线（基于成交价），可回溯
 * - realtimeSpread: 实时快照（基于盘口），仅当前时刻
 */
export interface DualKLineData {
  conditionId: string;
  interval: KLineInterval;
  market?: UnifiedMarket;
  yes: KLineCandle[];    // YES 代币 K 线
  no: KLineCandle[];     // NO 代币 K 线

  /**
   * 历史 Spread 分析（SpreadDataPoint[]）
   *
   * ✅ 可构建历史曲线 - 每个 K 线周期一个数据点
   * ⚠️ 基于成交价，套利信号仅供参考
   *
   * 用于：图表展示、趋势分析、回测
   */
  spreadAnalysis?: SpreadDataPoint[];

  /**
   * 实时 Spread 分析（RealtimeSpreadAnalysis）
   *
   * ✅ 套利计算准确 - 基于当前盘口 bid/ask
   * ❌ 仅当前时刻快照，无法构建历史曲线
   *
   * 如需实时 Spread 历史曲线，必须：
   * 1. 运行 spread-sampler 服务持续采样盘口
   * 2. 将快照存储到数据库
   * 3. 从数据库读取构建曲线
   *
   * 用于：实盘套利决策、当前市场状态展示
   */
  realtimeSpread?: RealtimeSpreadAnalysis;

  /** 完整订单簿数据（如需更多细节） */
  currentOrderbook?: ProcessedOrderbook;
}

/**
 * 有效价格（考虑镜像订单）
 *
 * Polymarket 的关键特性：买 YES @ P = 卖 NO @ (1-P)
 * 因此同一订单会在两个订单簿中出现
 *
 * 有效价格是考虑镜像后的最优价格：
 * - effectiveBuyYes = min(YES.ask, 1 - NO.bid)
 * - effectiveBuyNo = min(NO.ask, 1 - YES.bid)
 * - effectiveSellYes = max(YES.bid, 1 - NO.ask)
 * - effectiveSellNo = max(NO.bid, 1 - YES.ask)
 */
export interface EffectivePrices {
  effectiveBuyYes: number;   // 买 YES 的最低成本
  effectiveBuyNo: number;    // 买 NO 的最低成本
  effectiveSellYes: number;  // 卖 YES 的最高收入
  effectiveSellNo: number;   // 卖 NO 的最高收入
}

// Processed orderbook with analysis
export interface ProcessedOrderbook {
  yes: {
    bid: number;
    ask: number;
    bidSize: number;
    askSize: number;
    bidDepth: number;
    askDepth: number;
    spread: number;
    tokenId?: string;
  };
  no: {
    bid: number;
    ask: number;
    bidSize: number;
    askSize: number;
    bidDepth: number;
    askDepth: number;
    spread: number;
    tokenId?: string;
  };
  summary: {
    // 原始价格和（可能包含重复计算，仅供参考）
    askSum: number;
    bidSum: number;

    // 有效价格（考虑镜像订单，用于实际交易）
    effectivePrices: EffectivePrices;

    // 有效套利成本/收入
    effectiveLongCost: number;   // effectiveBuyYes + effectiveBuyNo
    effectiveShortRevenue: number; // effectiveSellYes + effectiveSellNo

    // 套利利润（基于有效价格）
    longArbProfit: number;   // 1 - effectiveLongCost，> 0 = 有套利
    shortArbProfit: number;  // effectiveShortRevenue - 1，> 0 = 有套利

    // 其他指标
    totalBidDepth: number;
    totalAskDepth: number;
    imbalanceRatio: number;

    // YES token 的 spread（由于镜像，这也反映了 NO 的情况）
    yesSpread: number;
  };
}

// Arbitrage opportunity
export interface ArbitrageOpportunity {
  type: 'long' | 'short';
  profit: number;
  action: string;
  expectedProfit: number;
}

// Price update from WebSocket
export interface PriceUpdate {
  assetId: string;
  price: number;
  midpoint: number;
  spread: number;
  timestamp: number;
}

// Book update from WebSocket
export interface BookUpdate {
  assetId: string;
  bids: Array<{ price: number; size: number }>;
  asks: Array<{ price: number; size: number }>;
  timestamp: number;
}

// ===== Market Types =====

/**
 * Token in a market (YES or NO outcome)
 */
export interface MarketToken {
  /** ERC-1155 token ID */
  tokenId: string;
  /** Outcome name (e.g., "Yes", "No") */
  outcome: string;
  /** Current price (0-1) */
  price: number;
  /** Whether this token won (after resolution) */
  winner?: boolean;
}

/**
 * Unified market type (merged from Gamma and CLOB)
 *
 * This is the primary market type used across the SDK.
 * It combines data from both Gamma API (volume, liquidity) and CLOB API (trading data).
 *
 * BREAKING CHANGE (v2.0): tokens is now an array instead of { yes, no } object.
 * Use tokens.find(t => t.outcome === 'Yes') to get specific outcomes.
 */
export interface UnifiedMarket {
  /** Market condition ID (primary identifier) */
  conditionId: string;
  /** URL-friendly slug */
  slug: string;
  /** Market question */
  question: string;
  /** Market description */
  description?: string;
  /**
   * Market tokens (YES/NO outcomes)
   * @example tokens.find(t => t.outcome === 'Yes')?.price
   */
  tokens: MarketToken[];
  /** Total volume (USDC) */
  volume: number;
  /** 24-hour volume (USDC) */
  volume24hr?: number;
  /** Liquidity depth (USDC) */
  liquidity: number;
  /** Bid-ask spread */
  spread?: number;
  /** 1-day price change (from Gamma API) */
  oneDayPriceChange?: number;
  /** 1-week price change (from Gamma API) */
  oneWeekPriceChange?: number;
  /** Whether market is active */
  active: boolean;
  /** Whether market is closed (resolved) */
  closed: boolean;
  /** Whether market is accepting orders */
  acceptingOrders: boolean;
  /** Market end date */
  endDate: Date;
  /** Data source indicator */
  source: 'gamma' | 'clob' | 'merged';
}

// ===== Binary Token Helpers =====

/**
 * Binary tokens for a market (primary/secondary instead of Yes/No)
 *
 * Polymarket supports various outcome names:
 * - Yes/No (standard binary markets)
 * - Up/Down (BTC price predictions)
 * - Team1/Team2 (sports matches)
 * - Heads/Tails (coin flips)
 *
 * Using index-based access (tokens[0], tokens[1]) is more reliable
 * than name-based access (outcome === 'Yes').
 */
export interface BinaryTokens {
  /** First outcome token (Yes/Up/Team1...) - corresponds to tokens[0] */
  primary: MarketToken;
  /** Second outcome token (No/Down/Team2...) - corresponds to tokens[1] */
  secondary: MarketToken;
  /** Outcome names [primary, secondary] for display purposes */
  outcomes: [string, string];
}

/**
 * Get binary tokens from a market's token array
 *
 * Uses index-based access which is stable across all outcome names.
 *
 * @param tokens - Market tokens array
 * @returns BinaryTokens or null if not a binary market
 *
 * @example
 * ```typescript
 * const market = await sdk.markets.getMarket('0x...');
 * const binary = getBinaryTokens(market.tokens);
 * if (binary) {
 *   console.log(`${binary.outcomes[0]} price: ${binary.primary.price}`);
 *   console.log(`${binary.outcomes[1]} price: ${binary.secondary.price}`);
 * }
 * ```
 */
export function getBinaryTokens(tokens: MarketToken[]): BinaryTokens | null {
  if (!tokens || tokens.length < 2) return null;
  return {
    primary: tokens[0],
    secondary: tokens[1],
    outcomes: [tokens[0].outcome, tokens[1].outcome],
  };
}

// Helper to convert interval to milliseconds
export function getIntervalMs(interval: KLineInterval): number {
  const map: Record<KLineInterval, number> = {
    '1s': 1 * 1000,
    '5s': 5 * 1000,
    '15s': 15 * 1000,
    '30s': 30 * 1000,
    '1m': 60 * 1000,
    '5m': 5 * 60 * 1000,
    '15m': 15 * 60 * 1000,
    '30m': 30 * 60 * 1000,
    '1h': 60 * 60 * 1000,
    '4h': 4 * 60 * 60 * 1000,
    '12h': 12 * 60 * 60 * 1000,
    '1d': 24 * 60 * 60 * 1000,
  };
  return map[interval];
}

// ===== Token vs Underlying Correlation Types =====

/**
 * Supported underlying assets for correlation analysis
 */
export type UnderlyingAsset = 'BTC' | 'ETH' | 'SOL';

/**
 * Single data point for token vs underlying correlation
 */
export interface TokenUnderlyingDataPoint {
  /** Timestamp (Unix ms) */
  timestamp: number;
  /** Primary token price (Up/Yes) from Polymarket trades */
  upPrice?: number;
  /** Secondary token price (Down/No) from Polymarket trades */
  downPrice?: number;
  /** Sum of token prices (should be close to 1.0) */
  priceSum?: number;
  /** Underlying asset price from Binance */
  underlyingPrice: number;
  /** Percentage change from first candle */
  underlyingChange: number;
}

/**
 * Correlation coefficients between token prices and underlying asset
 */
export interface TokenUnderlyingCorrelationCoefficients {
  /** Pearson correlation: Up token price vs underlying price */
  upVsUnderlying: number;
  /** Pearson correlation: Down token price vs underlying price */
  downVsUnderlying: number;
}

/**
 * Result of token vs underlying correlation analysis
 *
 * Aligns K-line data from Polymarket tokens (Up/Down) with underlying
 * asset prices from Binance (BTC/ETH/SOL) for correlation analysis.
 *
 * Use cases:
 * - Analyze how well prediction market tokens track underlying prices
 * - Identify divergences between token and underlying prices
 * - Backtest trading strategies based on correlation patterns
 *
 * @example
 * ```typescript
 * const correlation = await sdk.markets.getTokenUnderlyingData(
 *   '0x123...', // BTC prediction market
 *   'BTC',
 *   '1h',
 *   { calculateCorrelation: true }
 * );
 *
 * console.log(`Up token vs BTC correlation: ${correlation.correlation?.upVsUnderlying}`);
 * ```
 */
export interface TokenUnderlyingCorrelation {
  /** Market condition ID */
  conditionId: string;
  /** Underlying asset (BTC, ETH, SOL) */
  underlying: UnderlyingAsset;
  /** K-line interval */
  interval: KLineInterval;
  /** Aligned data points */
  data: TokenUnderlyingDataPoint[];
  /** Correlation coefficients (if calculated) */
  correlation?: TokenUnderlyingCorrelationCoefficients;
}
