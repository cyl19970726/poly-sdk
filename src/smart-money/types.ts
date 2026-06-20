/**
 * smart-money/types.ts
 *
 * All shared types for the smart-money module.
 * Extracted from smart-money-service.ts (V2 modularization).
 */

import type { OrderResult } from '../services/trading-service.js';
import type { DataApiClient, Position } from '../clients/data-api.js';

export type { OrderResult, DataApiClient, Position };

// ============================================================================
// Market Categorization Types
// ============================================================================

/**
 * Market category for classification
 */
export type MarketCategory =
  | 'crypto'
  | 'politics'
  | 'sports'
  | 'entertainment'
  | 'economics'
  | 'science'
  | 'other';

// ============================================================================
// Core Smart Money Types
// ============================================================================

/**
 * Smart Money wallet information
 */
export interface SmartMoneyWallet {
  address: string;
  name?: string;
  pnl: number;
  volume: number;
  score: number;
  rank?: number;
}

/**
 * Smart Money trade from Activity WebSocket
 */
export interface SmartMoneyTrade {
  traderAddress: string;
  traderName?: string;
  conditionId?: string;
  marketSlug?: string;
  side: 'BUY' | 'SELL';
  size: number;
  price: number;
  tokenId?: string;
  outcome?: string;
  txHash?: string;
  timestamp: number;
  isSmartMoney: boolean;
  smartMoneyInfo?: SmartMoneyWallet;
  /** 检测到交易的时间戳 (ms) */
  detectedAt?: number;
  /** 检测来源: polling (Data API) 或 mempool (WSS) */
  detectionSource?: 'polling' | 'mempool';
  /** 实际跟单股数（仅跟单执行后填充） */
  copySize?: number;
  /** 实际跟单价格（仅跟单执行后填充） */
  copyPrice?: number;
  /** 实际跟单总价值 USDC（仅跟单执行后填充） */
  copyValue?: number;
}

/**
 * Auto copy trading options
 */
export interface AutoCopyTradingOptions {
  /** Specific wallet addresses to follow */
  targetAddresses?: string[];
  /** Follow top N from leaderboard */
  topN?: number;

  /** Scale factor for size (0.1 = 10%) */
  sizeScale?: number;
  /** Maximum USDC per trade */
  maxSizePerTrade?: number;
  /** Maximum slippage (e.g., 0.03 = 3%) */
  maxSlippage?: number;
  /** Order type: FOK, FAK (market), GTC, GTD (limit) */
  orderType?: 'FOK' | 'FAK' | 'GTC' | 'GTD';
  /** Delay before executing (ms) */
  delay?: number;

  /** Minimum trade value to copy (USDC) */
  minTradeSize?: number;
  /** Only copy BUY or SELL trades */
  sideFilter?: 'BUY' | 'SELL';
  /** Custom trade filter — return true to copy, false to skip */
  tradeFilter?: (trade: SmartMoneyTrade) => boolean;

  /** Dry run mode */
  dryRun?: boolean;

  // ========== Phase 1: Detection Mode ==========

  /** Detection mode: 'polling' (Data API, ~5s), 'mempool' (WSS, ~2ms), 'dual' (both with dedup) */
  detectionMode?: 'polling' | 'mempool' | 'dual';

  // ========== Phase 2: Enhanced Execution ==========

  /** OrderManager instance (optional) — enables OrderHandle lifecycle tracking */
  orderManager?: any;

  /** Order mode: 'market' (default) or 'limit' */
  orderMode?: 'market' | 'limit';

  /** Limit mode price offset (relative to detected price)
   * BUY: limitPrice = detectedPrice + offset
   * SELL: limitPrice = detectedPrice - offset
   * Default: 0.01 (1 cent)
   */
  limitPriceOffset?: number;

  /** Price range filter (optional)
   * Skip trades where detected price is outside this range
   * Example: { min: 0.05, max: 0.95 } only follows 5%-95% price range
   */
  priceRange?: {
    min: number; // 0-1
    max: number; // 0-1
  };

  /** Split order count (limit mode only)
   * Split single order into N limit orders (via OrderManager.createBatchOrders)
   * Default: 1 (no split)
   * Max: 15 (Polymarket CLOB limit)
   */
  splitCount?: number;

  /** Split order price spread (only when splitCount > 1)
   * Price step between each split order, default 0.001 (0.1 cent)
   */
  splitSpread?: number;

  /** GTD order: remaining time in seconds. When 0, order expires immediately (invalid).
   * Only used when orderType is GTD.
   */
  gtdExpiration?: number;

  // ========== Retry ==========

  /** 下单失败重试次数（默认 3） */
  retryCount?: number;
  /** 重试间隔毫秒（默认 1000） */
  retryDelay?: number;

  // ========== Callbacks ==========

  /** Callbacks */
  onTrade?: (trade: SmartMoneyTrade, result: OrderResult) => void;
  onError?: (error: Error) => void;

  /** Order placed callback (OrderHandle available) */
  onOrderPlaced?: (handle: any) => void;

  /** Order filled callback (includes FillEvent details) */
  onOrderFilled?: (fill: any) => void;

  /** Async pre-order check — return true to proceed, false to skip.
   * Called after all sync filters pass but before order execution. */
  preOrderCheck?: (trade: SmartMoneyTrade) => Promise<boolean>;

  /** When true, SELL orders use our full token balance instead of copying the target's size.
   * Default: false */
  sellFullPosition?: boolean;
}

/**
 * Auto copy trading statistics
 */
export interface AutoCopyTradingStats {
  startTime: number;
  tradesDetected: number;
  tradesExecuted: number;
  tradesSkipped: number;
  tradesFailed: number;
  totalUsdcSpent: number;
  filteredByPrice?: number;
}

/**
 * Auto copy trading subscription
 */
export interface AutoCopyTradingSubscription {
  id: string;
  targetAddresses: string[];
  startTime: number;
  isActive: boolean;
  stats: AutoCopyTradingStats;
  stop: () => void;
  getStats: () => AutoCopyTradingStats;
}

/**
 * Service configuration
 */
export interface SmartMoneyServiceConfig {
  /** Minimum PnL to be considered Smart Money (default: $1000) */
  minPnl?: number;
  /** Cache TTL (default: 300000 = 5 min) */
  cacheTtl?: number;
  /** QuickNode WSS URL for mempool pending TX detection */
  mempoolWssUrl?: string;
  /** 调试日志模式，开启后打印跟单流程中的调试信息 (default: false) */
  debug?: boolean;
}

// ============================================================================
// Leaderboard & Report Types
// ============================================================================

/**
 * Leaderboard query options
 */
export interface LeaderboardOptions {
  /** Time period: 'day' | 'week' | 'month' | 'all' */
  period?: 'day' | 'week' | 'month' | 'all';
  /** Maximum entries (default: 50, max: 500) */
  limit?: number;
  /** Sort by: 'pnl' | 'volume' */
  sortBy?: 'pnl' | 'volume';
  /** Pagination offset (default: 0, max: 10000) */
  offset?: number;
}

/**
 * Smart Money Leaderboard entry (extended from PeriodLeaderboardEntry)
 */
export interface SmartMoneyLeaderboardEntry {
  address: string;
  rank: number;
  pnl: number;
  volume: number;
  tradeCount: number;
  userName?: string;
  profileImage?: string;
  xUsername?: string;
  verifiedBadge?: boolean;
  totalPnl: number;
  realizedPnl: number;
  unrealizedPnl: number;
  buyCount: number;
  sellCount: number;
  buyVolume: number;
  sellVolume: number;
  makerVolume: number;
  takerVolume: number;
}

/**
 * Leaderboard result with proper semantics
 */
export interface SmartMoneyLeaderboardResult {
  entries: SmartMoneyLeaderboardEntry[];
  hasMore: boolean;
  request: {
    offset: number;
    limit: number;
  };
}

/**
 * Period ranking info
 */
export interface PeriodRanking {
  rank: number;
  pnl: number;
  volume: number;
}

/**
 * Wallet report - comprehensive wallet analysis
 */
export interface WalletReport {
  address: string;
  generatedAt: Date;

  overview: {
    totalPnL: number;
    realizedPnL: number;
    unrealizedPnL: number;
    positionCount: number;
    tradeCount: number;
    smartScore: number;
    lastActiveAt: Date;
  };

  rankings: {
    daily: PeriodRanking | null;
    weekly: PeriodRanking | null;
    monthly: PeriodRanking | null;
    allTime: PeriodRanking | null;
  };

  performance: {
    winRate: number;
    winCount: number;
    lossCount: number;
    avgPositionSize: number;
    avgWinAmount: number;
    avgLossAmount: number;
    uniqueMarkets: number;
  };

  categoryBreakdown: Array<{
    category: string;
    positionCount: number;
    totalPnl: number;
  }>;

  topPositions: Array<{
    market: string;
    slug?: string;
    outcome: string;
    size: number;
    avgPrice: number;
    currentPrice?: number;
    pnl: number;
    percentPnl?: number;
  }>;

  recentTrades: Array<{
    timestamp: number;
    side: 'BUY' | 'SELL';
    size: number;
    price: number;
    usdcSize?: number;
    title?: string;
    slug?: string;
    outcome?: string;
    conditionId?: string;
  }>;

  activitySummary: {
    totalBuys: number;
    totalSells: number;
    buyVolume: number;
    sellVolume: number;
    activeMarketsCount: number;
  };
}

/**
 * Wallet comparison result
 */
export interface WalletComparison {
  period: 'day' | 'week' | 'month' | 'all';
  generatedAt: Date;
  wallets: Array<{
    address: string;
    userName?: string;
    rank: number | null;
    pnl: number;
    volume: number;
    positionCount: number;
    winRate: number;
  }>;
}

// ============================================================================
// Report Types (02-smart-money)
// ============================================================================

/**
 * Category color scheme for charts
 */
export const CATEGORY_COLORS: Record<MarketCategory, string> = {
  crypto: '#f7931a',
  politics: '#3b82f6',
  sports: '#22c55e',
  entertainment: '#a855f7',
  economics: '#eab308',
  science: '#06b6d4',
  other: '#6b7280',
};

/**
 * Category labels for display
 */
export const CATEGORY_LABELS: Record<MarketCategory, string> = {
  crypto: 'Crypto',
  politics: 'Politics',
  sports: 'Sports',
  entertainment: 'Entertainment',
  economics: 'Economics',
  science: 'Science',
  other: 'Other',
};

/**
 * Daily summary statistics
 */
export interface DailySummary {
  totalTrades: number;
  buyCount: number;
  sellCount: number;
  buyVolume: number;
  sellVolume: number;
  realizedPnL: number;
  positionsClosed: number;
  positionsOpened: number;
}

/**
 * Category statistics for breakdown
 */
export interface CategoryStats {
  category: MarketCategory;
  tradeCount: number;
  volume: number;
  pnl: number;
  percentage: number;
}

/**
 * Trade record for significant trades
 */
export interface TradeRecord {
  market: string;
  conditionId?: string;
  outcome: string;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  usdcValue: number;
  timestamp: Date;
}

/**
 * Position summary
 */
export interface PositionSummary {
  market: string;
  conditionId?: string;
  outcome: string;
  size: number;
  avgPrice: number;
}

/**
 * Closed market summary
 */
export interface ClosedMarketSummary {
  market: string;
  conditionId: string;
  outcome: string;
  realizedPnL: number;
  closePrice: number;
}

/**
 * Daily wallet report
 */
export interface DailyWalletReport {
  address: string;
  reportDate: string;  // "YYYY-MM-DD"
  generatedAt: Date;
  summary: DailySummary;
  categoryBreakdown: CategoryStats[];
  significantTrades: TradeRecord[];
  newPositions: PositionSummary[];
  closedMarkets: ClosedMarketSummary[];
}

/**
 * Data range for lifecycle report
 */
export interface DataRange {
  firstActivityAt: Date;
  lastActivityAt: Date;
  totalDays: number;
}

/**
 * Performance metrics
 */
export interface PerformanceMetrics {
  totalPnL: number;
  realizedPnL: number;
  unrealizedPnL: number;
  totalVolume: number;
  winRate: number;
  profitFactor: number;
  avgWin: number;
  avgLoss: number;
  maxWin: number;
  maxLoss: number;
  totalMarketsTraded: number;
  winningMarkets: number;
  losingMarkets: number;
}

/**
 * Market statistics for top/worst markets
 */
export interface MarketStats {
  market: string;
  conditionId: string;
  category: MarketCategory;
  pnl: number;
  volume: number;
  tradeCount: number;
  outcome: 'win' | 'lose' | 'open';
  avgPrice: number;
  closePrice?: number;
}

/**
 * Trading patterns analysis
 */
export interface TradingPatterns {
  avgTradesPerDay: number;
  avgTradesPerWeek: number;
  preferredSide: 'YES' | 'NO' | 'balanced';
  avgPositionSize: number;
  avgHoldingDays: number;
  topCategories: MarketCategory[];
  positionConcentration: number;
}

/**
 * Current positions summary
 */
export interface CurrentPositionsSummary {
  count: number;
  totalValue: number;
  unrealizedPnL: number;
  categories: CategoryStats[];
}

/**
 * Wallet lifecycle report
 */
export interface WalletLifecycleReport {
  address: string;
  generatedAt: Date;
  dataRange: DataRange;
  performance: PerformanceMetrics;
  categoryDistribution: CategoryStats[];
  topMarkets: MarketStats[];
  worstMarkets: MarketStats[];
  patterns: TradingPatterns;
  currentPositions: CurrentPositionsSummary;
}

/**
 * Pie chart slice
 */
export interface PieSlice {
  name: string;
  value: number;
  percentage: number;
  color: string;
}

/**
 * Pie chart data
 */
export interface PieChartData {
  name: string;
  data: PieSlice[];
  total: number;
}

/**
 * Bar chart item
 */
export interface BarItem {
  label: string;
  value: number;
  color: string;
}

/**
 * Bar chart data
 */
export interface BarChartData {
  name: string;
  data: BarItem[];
}

/**
 * Monthly PnL item
 */
export interface MonthlyPnLItem extends BarItem {
  month: string;
  pnl: number;
  tradeCount: number;
  cumulativePnL: number;
}

/**
 * Monthly PnL chart data
 */
export interface MonthlyPnLData extends BarChartData {
  data: MonthlyPnLItem[];
}

/**
 * Chart metadata
 */
export interface ChartMetadata {
  address: string;
  generatedAt: Date;
  dataRange: {
    from: Date;
    to: Date;
  };
}

/**
 * Wallet chart data
 */
export interface WalletChartData {
  tradeDistribution: PieChartData;
  positionDistribution: PieChartData;
  profitDistribution: PieChartData;
  monthlyPnL?: MonthlyPnLData;
  metadata: ChartMetadata;
}

/**
 * Report generation progress callback
 */
export type ReportProgressCallback = (progress: number, message: string) => void;

/**
 * Lifecycle report options
 */
export interface LifecycleReportOptions {
  onProgress?: ReportProgressCallback;
}

/**
 * Text report output
 */
export interface TextReport {
  address: string;
  generatedAt: Date;
  markdown: string;
  metrics: {
    totalPnL: number;
    winRate: number;
    profitFactor: number;
    totalMarketsTraded: number;
    totalDays: number;
  };
}

// ============================================================================
// V2: New types for position-polling and CopyEngine
// ============================================================================

/**
 * Position diff event from PositionTracker
 */
export type PositionDiff =
  | { type: 'new'; position: Position }
  | { type: 'increased'; position: Position; deltaUSDC: number }
  | { type: 'decreased'; position: Position; deltaUSDC: number }
  | { type: 'closed'; conditionId: string; outcome: string };

/**
 * Order request for CopyEngine
 */
export interface OrderRequest {
  conditionId: string;
  outcome: string;
  tokenId: string;
  side: 'BUY' | 'SELL';
  amount: number;           // USDC
  /** Required for GTC/GTD limit orders. For FOK/FAK market orders, used as slippage price. */
  price?: number;
  orderType: 'GTC' | 'GTD' | 'FOK' | 'FAK';
  retryCount?: number;
  retryFallback?: 'GTC' | 'FOK';
}

/**
 * Unified trade event from TradeMonitor (polling or mempool)
 */
export interface TradeEvent {
  address: string;
  conditionId?: string;
  outcome?: string;
  tokenId: string;
  side: 'BUY' | 'SELL';
  size: number;
  price: number;
  /** Unix ms — when the actual trade occurred (from activity API). Used for latency tracking. */
  timestamp: number;
  source: 'polling' | 'mempool';
  detectedAt: number;
  /** Market slug / title, if available (from polling). */
  marketSlug?: string;
  /** 链上 tx hash，来自 Activity.transactionHash（polling 模式）。
   *  用于 copy-trading 的 dedup（UNIQUE INDEX on copy_trades.source_tx_hash）。
   *  position 模式（PositionDiff）无此字段，属预期行为——PositionDiff 通过
   *  仓位快照 diff 检测变化，无对应的单笔 tx hash。
   */
  transactionHash?: string;
}

/**
 * Monitor options for TradeMonitor
 */
export interface MonitorOptions {
  pollIntervalMs?: number;
  mempoolWssUrl?: string;
  debug?: boolean;
}
