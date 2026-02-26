/**
 * SmartMoneyService
 *
 * 聪明钱监控和自动跟单服务
 *
 * 核心功能：
 * 1. 监听指定地址的交易 - subscribeSmartMoneyTrades()
 * 2. 自动跟单 - startAutoCopyTrading()
 * 3. 聪明钱信息获取 - getSmartMoneyList(), getSmartMoneyInfo()
 *
 * ============================================================================
 * 设计决策
 * ============================================================================
 *
 * ## 监控方式
 * 使用 Data API /activity 端点轮询，延迟 2-3秒，包含完整市场信息。
 *
 * ## 下单方式
 * | 方式 | 使用场景 | 特点 |
 * |------|---------|------|
 * | FOK | 小额跟单 | 全部成交或取消 |
 * | FAK | 大额跟单 | 部分成交也接受 |
 *
 * ## 轮询配置
 * - 默认间隔：5秒
 * - 监控 1-10 钱包：3-5秒轮询
 * - 监控 11-30 钱包：5-10秒轮询
 * - 监控 31+ 钱包：10-15秒轮询
 * - Data API 限流：300 req/min
 */

import WebSocket from 'ws';
import type { WalletService, TimePeriod, PeriodLeaderboardEntry } from './wallet-service.js';
import type { RealtimeServiceV2 } from './realtime-service-v2.js';
import type { TradingService, OrderResult } from './trading-service.js';
import type { Position, ClosedPosition, ClosedPositionsParams, DataApiClient, Activity } from '../clients/data-api.js';
import {
  ROUTER_ADDRESSES,
  MATCH_ORDERS_SELECTOR,
  decodeMatchOrdersCalldata,
  extractTraderAddresses,
  OrderSide,
} from '../utils/calldata-decoder.js';

// ============================================================================
// Market Categorization (exported utilities)
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

/**
 * Keywords for market categorization by category
 */
export const CATEGORY_KEYWORDS: Record<MarketCategory, RegExp> = {
  crypto: /\b(btc|bitcoin|eth|ethereum|sol|solana|xrp|crypto|doge|ada|matic)\b/i,
  politics: /\b(trump|biden|election|president|senate|congress|vote|political|maga|democrat|republican)\b/i,
  sports: /\b(nfl|nba|mlb|nhl|super bowl|world cup|championship|game|match|ufc|soccer|football|basketball)\b/i,
  economics: /\b(fed|interest rate|inflation|gdp|recession|economic|unemployment|cpi)\b/i,
  entertainment: /\b(oscar|grammy|movie|twitter|celebrity|entertainment|netflix|spotify)\b/i,
  science: /\b(spacex|nasa|ai|openai|google|apple|tesla|tech|technology|science)\b/i,
  other: /.*/, // Matches everything as fallback
};

/**
 * Categorize a market based on its title
 *
 * @param title - Market title to categorize
 * @returns The market category
 *
 * @example
 * ```typescript
 * import { categorizeMarket } from '@catalyst-team/poly-sdk';
 *
 * categorizeMarket('Will BTC hit $100k?'); // 'crypto'
 * categorizeMarket('Trump wins 2024?');    // 'politics'
 * categorizeMarket('Lakers win NBA?');     // 'sports'
 * categorizeMarket('Random event?');       // 'other'
 * ```
 */
export function categorizeMarket(title: string): MarketCategory {
  const lowerTitle = title.toLowerCase();

  // Check each category in priority order
  if (CATEGORY_KEYWORDS.crypto.test(lowerTitle)) return 'crypto';
  if (CATEGORY_KEYWORDS.politics.test(lowerTitle)) return 'politics';
  if (CATEGORY_KEYWORDS.sports.test(lowerTitle)) return 'sports';
  if (CATEGORY_KEYWORDS.economics.test(lowerTitle)) return 'economics';
  if (CATEGORY_KEYWORDS.entertainment.test(lowerTitle)) return 'entertainment';
  if (CATEGORY_KEYWORDS.science.test(lowerTitle)) return 'science';

  return 'other';
}

// ============================================================================
// Types
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
  orderManager?: any; // Will be typed as OrderManager when imported

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
   * Example: splitCount=3, splitSpread=0.01
   *   BUY: limitPrice, limitPrice+0.01, limitPrice+0.02
   *   SELL: limitPrice, limitPrice-0.01, limitPrice-0.02
   */
  splitSpread?: number;

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
  onOrderPlaced?: (handle: any) => void; // Will be typed as OrderHandle when imported

  /** Order filled callback (includes FillEvent details) */
  onOrderFilled?: (fill: any) => void; // Will be typed as FillEvent when imported

  /** Async pre-order check — return true to proceed, false to skip.
   * Called after all sync filters pass but before order execution.
   * Use for async checks like market volume / orderbook depth. */
  preOrderCheck?: (trade: SmartMoneyTrade) => Promise<boolean>;

  // ========== Sell Full Position ==========

  /** When true, SELL orders use our full token balance instead of copying the target's size.
   * Useful when copying makers — we may not hold the same amount, so we sell everything we have.
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
  filteredByPrice?: number; // Phase 2: count trades filtered by priceRange
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
}

// ============================================================================
// Leaderboard & Report Types
// ============================================================================

/**
 * Leaderboard query options
 */
export interface LeaderboardOptions {
  /** Time period: 'day' | 'week' | 'month' | 'all' */
  period?: TimePeriod;
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
  // 社交信息 (来自官方 API)
  xUsername?: string;       // Twitter/X 用户名
  verifiedBadge?: boolean;  // 是否已验证
  // Extended fields from PeriodLeaderboardEntry
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
 *
 * Note: Polymarket API doesn't return total count.
 */
export interface SmartMoneyLeaderboardResult {
  /** Leaderboard entries returned by the API */
  entries: SmartMoneyLeaderboardEntry[];
  /** Whether there may be more entries (entries.length === request.limit) */
  hasMore: boolean;
  /** Echo of request parameters for pagination convenience */
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
    // Market info
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
  period: TimePeriod;
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
  crypto: '#f7931a',      // Bitcoin orange
  politics: '#3b82f6',    // Blue
  sports: '#22c55e',      // Green
  entertainment: '#a855f7', // Purple
  economics: '#eab308',   // Yellow
  science: '#06b6d4',     // Cyan
  other: '#6b7280',       // Gray
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
  winRate: number;           // 0-1
  profitFactor: number;      // total profit / total loss
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
  positionConcentration: number;  // max single position share
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

/**
 * Trading style analysis
 */
interface TradingStyle {
  positionPreference: string;
  tradingFrequency: string;
  positionManagement: string;
  primaryFocus: string;
}

/**
 * Risk assessment
 */
interface RiskAssessment {
  concentrationRisk: string;
  drawdownRisk: string;
  overallRisk: string;
}

/**
 * Copy trading recommendation
 */
interface CopyRecommendation {
  verdict: string;
  reasoning: string;
  suitableMarkets: string[];
  avoidMarkets: string[];
  warnings: string[];
}

// ============================================================================
// SmartMoneyService
// ============================================================================

export class SmartMoneyService {
  private walletService: WalletService;
  private realtimeService: RealtimeServiceV2;
  private tradingService: TradingService;
  private dataApi: DataApiClient;
  private config: Required<SmartMoneyServiceConfig>;

  private smartMoneyCache: Map<string, SmartMoneyWallet> = new Map();
  private smartMoneySet: Set<string> = new Set();
  private cacheTimestamp: number = 0;

  // 轮询相关
  private pollIntervalId: NodeJS.Timeout | null = null;
  private lastCheckTimestamp: number = Math.floor(Date.now() / 1000);
  private seenTxHashes: Set<string> = new Set();
  private tradeHandlers: Set<(trade: SmartMoneyTrade) => void> = new Set();
  private targetWallets: string[] = [];
  private pollInterval: number = 5000; // 默认 5 秒

  // Mempool 相关
  private mempoolWs: WebSocket | null = null;
  private mempoolTargetAddresses: Set<string> = new Set();

  constructor(
    walletService: WalletService,
    realtimeService: RealtimeServiceV2,
    tradingService: TradingService,
    dataApi: DataApiClient,
    config: SmartMoneyServiceConfig = {}
  ) {
    this.walletService = walletService;
    this.realtimeService = realtimeService;
    this.tradingService = tradingService;
    this.dataApi = dataApi;

    this.config = {
      minPnl: config.minPnl ?? 1000,
      cacheTtl: config.cacheTtl ?? 300000,
      mempoolWssUrl: config.mempoolWssUrl ?? '',
    };
  }

  // ============================================================================
  // Polling Logic - 轮询逻辑
  // ============================================================================

  /**
   * Poll target wallets for new activities
   * @private
   */
  private async pollTargetWallets(): Promise<Activity[]> {
    if (this.targetWallets.length === 0) {
      return [];
    }

    const now = Math.floor(Date.now() / 1000);
    const start = this.lastCheckTimestamp;

    try {
      // 并发查询所有目标钱包
      const results = await Promise.all(
        this.targetWallets.map(async (wallet) => {
          try {
            return await this.dataApi.getActivity(wallet, {
              type: 'TRADE',
              start,
              limit: 100,
              sortBy: 'TIMESTAMP',
              sortDirection: 'DESC',
            });
          } catch (error) {
            console.error(`[SmartMoneyService] Failed to fetch activity for ${wallet}:`, error);
            return [];
          }
        })
      );

      // 更新时间戳 — 保留 10s 重叠窗口以应对 Data API 索引延迟
      // 依赖 seenTxHashes 去重避免重复处理
      const OVERLAP_SECONDS = 10;
      this.lastCheckTimestamp = Math.max(start, now - OVERLAP_SECONDS);

      // 合并结果并按时间排序
      return results
        .flat()
        .sort((a, b) => b.timestamp - a.timestamp);
    } catch (error) {
      console.error('[SmartMoneyService] Poll error:', error);
      return [];
    }
  }

  /**
   * Convert Activity to SmartMoneyTrade
   * @private
   */
  private activityToSmartMoneyTrade(activity: Activity): SmartMoneyTrade | null {
    const traderAddress = activity.proxyWallet?.toLowerCase();
    if (!traderAddress) {
      return null;
    }

    const isSmartMoney = this.smartMoneySet.has(traderAddress);

    return {
      traderAddress,
      traderName: activity.name,
      conditionId: activity.conditionId,
      marketSlug: activity.slug,
      side: activity.side,
      size: activity.size,
      price: activity.price,
      tokenId: activity.asset,
      outcome: activity.outcome,
      txHash: activity.transactionHash,
      timestamp: activity.timestamp,
      isSmartMoney,
      smartMoneyInfo: this.smartMoneyCache.get(traderAddress),
    };
  }

  /**
   * Start polling for target wallets
   * @private
   */
  private startPolling(): void {
    if (this.pollIntervalId) {
      return; // Already polling
    }

    // 根据钱包数量调整轮询间隔
    if (this.targetWallets.length <= 10) {
      this.pollInterval = 5000; // 5秒
    } else if (this.targetWallets.length <= 30) {
      this.pollInterval = 7000; // 7秒
    } else {
      this.pollInterval = 10000; // 10秒
    }

    this.pollIntervalId = setInterval(async () => {
      const activities = await this.pollTargetWallets();

      for (const activity of activities) {
        // 去重
        if (this.seenTxHashes.has(activity.transactionHash)) {
          continue;
        }
        this.seenTxHashes.add(activity.transactionHash);

        // 清理旧的 txHash（保留最近 1000 个）
        if (this.seenTxHashes.size > 1000) {
          const toRemove = Array.from(this.seenTxHashes).slice(0, 500);
          toRemove.forEach(hash => this.seenTxHashes.delete(hash));
        }

        // 转换为 SmartMoneyTrade
        const trade = this.activityToSmartMoneyTrade(activity);
        if (!trade) {
          continue;
        }
        trade.detectedAt = Date.now();
        trade.detectionSource = 'polling';

        // 通知所有 handlers
        for (const handler of this.tradeHandlers) {
          try {
            handler(trade);
          } catch (error) {
            console.error('[SmartMoneyService] Handler error:', error);
          }
        }
      }
    }, this.pollInterval);
  }

  /**
   * Stop polling
   * @private
   */
  private stopPolling(): void {
    if (this.pollIntervalId) {
      clearInterval(this.pollIntervalId);
      this.pollIntervalId = null;
    }
  }

  // ============================================================================
  // Mempool Detection - Mempool v2 Raw WSS 检测
  // ============================================================================

  /**
   * Start mempool monitor for pending TX detection (~442ms latency)
   * Ported from strategy-impl/src/copy-trading/wallet-monitor.ts
   */
  private startMempoolMonitor(): void {
    if (this.mempoolWs) {
      return; // Already connected
    }

    const wssUrl = this.config.mempoolWssUrl;
    if (!wssUrl) {
      console.warn('[SmartMoneyService] Mempool WSS URL not configured, skipping mempool monitor');
      return;
    }

    // Sync target addresses
    for (const addr of this.targetWallets) {
      this.mempoolTargetAddresses.add(addr.toLowerCase());
    }

    console.log('[SmartMoneyService] Starting Mempool v2 WSS monitor', {
      wssUrl: wssUrl.slice(0, 30) + '...',
      targets: this.mempoolTargetAddresses.size,
    });

    const ws = new WebSocket(wssUrl);
    this.mempoolWs = ws;

    ws.on('open', () => {
      console.log('[SmartMoneyService] Mempool WSS connected, subscribing to newPendingTransactions');
      ws.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_subscribe',
          params: ['newPendingTransactions', true], // true = full TX objects
        }),
      );
    });

    ws.on('message', (data: Buffer) => {
      this.handleMempoolMessage(data);
    });

    ws.on('error', (err: any) => {
      console.warn('[SmartMoneyService] Mempool WSS error:', err.message);
    });

    ws.on('close', () => {
      console.warn('[SmartMoneyService] Mempool WSS closed');
      this.mempoolWs = null;
    });
  }

  /**
   * Handle mempool pending TX message
   * Filters for Polymarket Router TXs, decodes calldata, matches target wallets
   */
  private handleMempoolMessage(data: Buffer): void {
    const t0 = Date.now();

    try {
      const msg = JSON.parse(data.toString());

      // Subscription confirmation
      if (msg.id === 1 && msg.result) {
        console.log('[SmartMoneyService] Mempool subscription confirmed', { subscriptionId: msg.result });
        return;
      }

      // New pending TX
      if (!msg.params?.result) return;
      const tx = msg.params.result;

      // Fast local filter: is settlement TX? (99%+ filtered out here)
      if (!tx.to || !ROUTER_ADDRESSES.has(tx.to.toLowerCase())) return;
      if (!tx.input || !tx.input.startsWith(MATCH_ORDERS_SELECTOR)) return;

      // Decode calldata
      const decoded = decodeMatchOrdersCalldata(tx.input);
      if (!decoded) return;

      // Extract trader addresses and match against targets
      const traders = extractTraderAddresses(decoded);
      const targetTrader = traders.find((addr: string) => this.mempoolTargetAddresses.has(addr));
      if (!targetTrader) return;

      // Dedup: check if we've already seen this txHash
      if (tx.hash && this.seenTxHashes.has(tx.hash)) return;
      if (tx.hash) {
        this.seenTxHashes.add(tx.hash);
        // Prune old hashes
        if (this.seenTxHashes.size > 1000) {
          const toRemove = Array.from(this.seenTxHashes).slice(0, 500);
          toRemove.forEach(hash => this.seenTxHashes.delete(hash));
        }
      }

      // Find the target's order (could be taker or maker)
      let targetOrder = decoded.takerOrder;
      if (decoded.takerOrder.maker !== targetTrader && decoded.takerOrder.signer !== targetTrader) {
        // Target is a maker, find their order
        const makerOrder = decoded.makerOrders.find(
          o => o.maker === targetTrader || o.signer === targetTrader,
        );
        if (makerOrder) targetOrder = makerOrder;
      }

      // Calculate price and size from order amounts
      // BUY (side=0): pay USDC (makerAmount) to get tokens (takerAmount)
      //   price = makerAmount / takerAmount
      //   size = takerAmount (token count)
      // SELL (side=1): sell tokens (makerAmount) to get USDC (takerAmount)
      //   price = takerAmount / makerAmount
      //   size = makerAmount (token count)
      const makerAmt = Number(targetOrder.makerAmount) / 1e6; // USDC has 6 decimals
      const takerAmt = Number(targetOrder.takerAmount) / 1e6;
      let price: number;
      let size: number;

      if (targetOrder.side === OrderSide.BUY) {
        price = makerAmt / takerAmt;
        size = takerAmt;
      } else {
        price = takerAmt / makerAmt;
        size = makerAmt;
      }

      const latency = Date.now() - t0;
      console.log('[SmartMoneyService] Mempool detection', {
        trader: targetTrader.slice(0, 10) + '...',
        txHash: tx.hash?.slice(0, 18) + '...',
        side: targetOrder.side === OrderSide.BUY ? 'BUY' : 'SELL',
        size: size.toFixed(2),
        price: price.toFixed(4),
        latency: `${latency}ms`,
      });

      // Build SmartMoneyTrade and notify handlers
      const now = Date.now();
      const trade: SmartMoneyTrade = {
        traderAddress: targetTrader,
        side: targetOrder.side === OrderSide.BUY ? 'BUY' : 'SELL',
        size,
        price,
        tokenId: targetOrder.tokenId,
        txHash: tx.hash,
        timestamp: now,
        isSmartMoney: this.smartMoneySet.has(targetTrader),
        smartMoneyInfo: this.smartMoneyCache.get(targetTrader),
        detectedAt: now,
        detectionSource: 'mempool',
        // conditionId, marketSlug, outcome not available from mempool
      };

      for (const handler of this.tradeHandlers) {
        try {
          handler(trade);
        } catch (error) {
          console.error('[SmartMoneyService] Handler error (mempool):', error);
        }
      }
    } catch {
      // Silently ignore parse errors for non-relevant messages
    }
  }

  /**
   * Stop mempool monitor
   */
  private stopMempoolMonitor(): void {
    if (this.mempoolWs) {
      this.mempoolWs.close();
      this.mempoolWs = null;
    }
  }

  // ============================================================================
  // Smart Money Info
  // ============================================================================

  /**
   * Get list of Smart Money wallets from leaderboard
   */
  async getSmartMoneyList(limit: number = 100): Promise<SmartMoneyWallet[]> {
    if (this.isCacheValid()) {
      return Array.from(this.smartMoneyCache.values());
    }

    const leaderboardPage = await this.walletService.getLeaderboard(0, limit);
    const entries = leaderboardPage.entries;

    const smartMoneyList: SmartMoneyWallet[] = [];

    for (let i = 0; i < entries.length; i++) {
      const trader = entries[i];
      if (trader.pnl < this.config.minPnl) continue;

      const wallet: SmartMoneyWallet = {
        address: trader.address.toLowerCase(),
        name: trader.userName,
        pnl: trader.pnl,
        volume: trader.volume,
        score: Math.min(100, Math.round((trader.pnl / 100000) * 50 + (trader.volume / 1000000) * 50)),
        rank: trader.rank ?? i + 1,
      };

      smartMoneyList.push(wallet);
      this.smartMoneyCache.set(wallet.address, wallet);
      this.smartMoneySet.add(wallet.address);
    }

    this.cacheTimestamp = Date.now();
    return smartMoneyList;
  }

  /**
   * Check if an address is Smart Money
   */
  async isSmartMoney(address: string): Promise<boolean> {
    const normalized = address.toLowerCase();
    if (this.isCacheValid()) {
      return this.smartMoneySet.has(normalized);
    }
    await this.getSmartMoneyList();
    return this.smartMoneySet.has(normalized);
  }

  /**
   * Get Smart Money info for an address
   */
  async getSmartMoneyInfo(address: string): Promise<SmartMoneyWallet | null> {
    const normalized = address.toLowerCase();
    if (this.isCacheValid() && this.smartMoneyCache.has(normalized)) {
      return this.smartMoneyCache.get(normalized)!;
    }
    await this.getSmartMoneyList();
    return this.smartMoneyCache.get(normalized) || null;
  }

  // ============================================================================
  // Trade Subscription - 监听交易
  // ============================================================================

  /**
   * Subscribe to trades from specific addresses
   *
   * Uses Data API polling (default 5s interval) for real-time trade monitoring.
   *
   * @example
   * ```typescript
   * const sub = smartMoneyService.subscribeSmartMoneyTrades(
   *   (trade) => {
   *     console.log(`${trade.traderName} ${trade.side} ${trade.size} @ ${trade.price}`);
   *   },
   *   { filterAddresses: ['0x1234...', '0x5678...'] }
   * );
   *
   * // Stop listening
   * sub.unsubscribe();
   * ```
   */
  subscribeSmartMoneyTrades(
    onTrade: (trade: SmartMoneyTrade) => void,
    options: {
      filterAddresses?: string[];
      minSize?: number;
      smartMoneyOnly?: boolean;
      detectionMode?: 'polling' | 'mempool' | 'dual';
    } = {}
  ): { id: string; unsubscribe: () => void } {
    // 创建过滤后的 handler
    const filteredHandler = (trade: SmartMoneyTrade) => {
      // Address filter
      if (options.filterAddresses && options.filterAddresses.length > 0) {
        const normalized = options.filterAddresses.map(a => a.toLowerCase());
        if (!normalized.includes(trade.traderAddress.toLowerCase())) {
          return;
        }
      }

      // Size filter
      if (options.minSize && trade.size < options.minSize) {
        return;
      }

      // Smart Money filter
      if (options.smartMoneyOnly && !trade.isSmartMoney) {
        return;
      }

      onTrade(trade);
    };

    this.tradeHandlers.add(filteredHandler);

    // Ensure cache is populated
    this.getSmartMoneyList().catch(() => {});

    // 更新目标钱包列表
    if (options.filterAddresses && options.filterAddresses.length > 0) {
      const normalized = options.filterAddresses.map(a => a.toLowerCase());
      this.targetWallets = [...new Set([...this.targetWallets, ...normalized])];
    }

    // 按 detectionMode 启动检测
    const mode = options.detectionMode ?? 'polling';
    if (mode === 'dual') {
      console.log('[SmartMoneyService] Dual detection: mempool (primary) + polling (fallback)');
      this.startMempoolMonitor();
      this.startPolling();
    } else if (mode === 'mempool') {
      this.startMempoolMonitor();
    } else {
      this.startPolling();
    }

    const subscriptionId = `smart_money_${Date.now()}`;

    return {
      id: subscriptionId,
      unsubscribe: () => {
        this.tradeHandlers.delete(filteredHandler);

        // 如果没有 handler 了，停止检测
        if (this.tradeHandlers.size === 0) {
          this.stopPolling();
          this.stopMempoolMonitor();
          this.targetWallets = [];
          this.mempoolTargetAddresses.clear();
          this.seenTxHashes.clear();
        }
      },
    };
  }

  // ============================================================================
  // Auto Copy Trading - 自动跟单
  // ============================================================================

  /**
   * Start auto copy trading - 自动跟单
   *
   * @example
   * ```typescript
   * const sub = await smartMoneyService.startAutoCopyTrading({
   *   targetAddresses: ['0x1234...'],
   *   // 或者跟踪排行榜前N名
   *   topN: 10,
   *
   *   sizeScale: 0.1,        // 10%
   *   maxSizePerTrade: 50,   // $50
   *   maxSlippage: 0.03,     // 3%
   *   orderType: 'FOK',
   *
   *   dryRun: true,          // 测试模式
   *
   *   onTrade: (trade, result) => console.log(result),
   * });
   *
   * // 停止
   * sub.stop();
   * ```
   */
  async startAutoCopyTrading(options: AutoCopyTradingOptions): Promise<AutoCopyTradingSubscription> {
    const startTime = Date.now();

    // Build target list
    let targetAddresses: string[] = [];

    if (options.targetAddresses?.length) {
      targetAddresses = options.targetAddresses.map(a => a.toLowerCase());
    }

    if (options.topN && options.topN > 0) {
      const smartMoneyList = await this.getSmartMoneyList(options.topN);
      const topAddresses = smartMoneyList.map(w => w.address);
      targetAddresses = [...new Set([...targetAddresses, ...topAddresses])];
    }

    if (targetAddresses.length === 0) {
      throw new Error('No target addresses. Use targetAddresses or topN.');
    }

    // Stats
    const stats: AutoCopyTradingStats = {
      startTime,
      tradesDetected: 0,
      tradesExecuted: 0,
      tradesSkipped: 0,
      tradesFailed: 0,
      totalUsdcSpent: 0,
      filteredByPrice: 0, // Phase 2
    };

    // Config
    const sizeScale = options.sizeScale ?? 0.1;
    const maxSizePerTrade = options.maxSizePerTrade ?? 50;
    const maxSlippage = options.maxSlippage ?? 0.03;
    const orderType = options.orderType ?? 'FOK';
    const minTradeSize = options.minTradeSize ?? 10;
    const sideFilter = options.sideFilter;
    const delay = options.delay ?? 0;
    const dryRun = options.dryRun ?? false;

    // Derive limit order type from orderType (GTC/GTD → limit, FOK/FAK → market)
    const limitOrderType: 'GTC' | 'GTD' = orderType === 'GTD' ? 'GTD' : 'GTC';
    const marketOrderType: 'FOK' | 'FAK' = orderType === 'FAK' ? 'FAK' : 'FOK';

    // Phase 2: Enhanced execution config
    // Auto-infer orderMode from orderType if not explicitly set
    const orderMode = options.orderMode ?? (orderType === 'GTC' || orderType === 'GTD' ? 'limit' : 'market');
    const limitPriceOffset = options.limitPriceOffset ?? 0.01;
    const splitCount = options.splitCount ?? 1;
    const splitSpread = options.splitSpread ?? 0.001;
    const retryCount = options.retryCount ?? 3;
    const retryDelay = options.retryDelay ?? 1000;

    // Subscribe
    const subscription = this.subscribeSmartMoneyTrades(
      async (trade: SmartMoneyTrade) => {
        stats.tradesDetected++;

        try {
          // Check target
          if (!targetAddresses.includes(trade.traderAddress.toLowerCase())) {
            return;
          }

          // Filters
          const tradeValue = trade.size * trade.price;
          if (tradeValue < minTradeSize) {
            stats.tradesSkipped++;
            return;
          }

          if (sideFilter && trade.side !== sideFilter) {
            stats.tradesSkipped++;
            return;
          }

          // Phase 2: Price range filter
          if (options.priceRange) {
            const { min, max } = options.priceRange;
            if (trade.price < min || trade.price > max) {
              stats.tradesSkipped++;
              stats.filteredByPrice = (stats.filteredByPrice || 0) + 1;
              return;
            }
          }

          // Custom trade filter
          if (options.tradeFilter && !options.tradeFilter(trade)) {
            stats.tradesSkipped++;
            return;
          }

          // Calculate size (Polymarket minimum: 5 shares)
          const MIN_SHARES = 5;
          let copySize = Math.max(MIN_SHARES, trade.size * sizeScale);
          let copyValue = copySize * trade.price;

          // Enforce max size
          if (copyValue > maxSizePerTrade) {
            copySize = maxSizePerTrade / trade.price;
            copyValue = maxSizePerTrade;
          }

          // Polymarket minimum order is $1
          const MIN_ORDER_SIZE = 1;
          if (copyValue < MIN_ORDER_SIZE) {
            stats.tradesSkipped++;
            return;
          }

          // Delay
          if (delay > 0) {
            await new Promise(resolve => setTimeout(resolve, delay));
          }

          // Token
          const tokenId = trade.tokenId;
          if (!tokenId) {
            stats.tradesSkipped++;
            return;
          }

          // Sell full position: override copySize with our actual token balance
          if (!dryRun && trade.side === 'SELL' && options.sellFullPosition) {
            try {
              const { balance: tokenBalance } = await this.tradingService.getBalanceAllowance('CONDITIONAL', tokenId);
              const availableShares = parseFloat(tokenBalance) / 1e6; // CTF tokens have 6 decimals
              if (availableShares < MIN_SHARES) {
                console.warn(`[Copy Trading] 持仓不足: tokenId=${tokenId.slice(0, 12)}... 持有 ${availableShares.toFixed(2)} shares — SKIP`);
                stats.tradesSkipped++;
                return;
              }
              copySize = availableShares;
              copyValue = copySize * trade.price;
              console.log(`[Copy Trading] 全仓卖出: ${copySize.toFixed(2)} shares @ $${trade.price.toFixed(4)}`);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              console.warn(`[Copy Trading] 查询持仓失败: ${msg} — 使用默认数量`);
            }
          }

          // Price with slippage
          const slippagePrice = trade.side === 'BUY'
            ? trade.price * (1 + maxSlippage)
            : trade.price * (1 - maxSlippage);

          const usdcAmount = copyValue; // Already calculated above

          // Pre-flight balance check (BUY only — check USDC collateral)
          if (!dryRun && trade.side === 'BUY') {
            try {
              const { balance } = await this.tradingService.getBalanceAllowance('COLLATERAL');
              const availableUsdc = parseFloat(balance) / 1e6; // USDC has 6 decimals
              if (availableUsdc < usdcAmount) {
                console.warn(`[Copy Trading] 余额不足: 需要 $${usdcAmount.toFixed(2)}，可用 $${availableUsdc.toFixed(2)}，跳过此交易`);
                stats.tradesSkipped++;
                return;
              }
            } catch {
              // Balance check failed — proceed with order (CLOB will reject if truly insufficient)
            }
          }

          // Pre-order async check (e.g., volume / orderbook depth)
          if (options.preOrderCheck) {
            try {
              const shouldProceed = await options.preOrderCheck(trade);
              if (!shouldProceed) {
                stats.tradesSkipped++;
                return;
              }
            } catch (checkErr) {
              // Check failed — proceed with order
              console.warn(`[Copy Trading] preOrderCheck error: ${checkErr instanceof Error ? checkErr.message : checkErr}`);
            }
          }

          // Execute
          let result: OrderResult = { success: false, errorMsg: 'Order not executed' };

          if (dryRun) {
            result = { success: true, orderId: `dry_run_${Date.now()}` };
            console.log('[DRY RUN]', {
              trader: trade.traderAddress.slice(0, 10),
              side: trade.side,
              market: trade.marketSlug,
              copy: { size: copySize.toFixed(2), usdc: usdcAmount.toFixed(2) },
              mode: orderMode,
            });
          } else {
            // Phase 2: Route selection with retry
            for (let attempt = 0; attempt <= retryCount; attempt++) {
              if (orderMode === 'limit') {
                // Limit Order path
                const limitPrice = this.calculateLimitPrice(trade.side, trade.price, limitPriceOffset);

                if (options.orderManager && splitCount === 1) {
                  // Single limit order via OrderManager (with lifecycle tracking) — no retry (OrderManager manages lifecycle)
                  const handle = options.orderManager.placeOrder({
                    tokenId,
                    side: trade.side,
                    price: limitPrice,
                    size: copySize,
                    orderType: limitOrderType,
                  });

                  // Notify via callback
                  if (options.onOrderPlaced) {
                    options.onOrderPlaced(handle);
                  }

                  // Register fill handlers
                  handle
                    .onFilled((fill: any) => {
                      stats.tradesExecuted++;
                      stats.totalUsdcSpent += copyValue;
                      if (options.onOrderFilled) {
                        options.onOrderFilled(fill);
                      }
                    })
                    .onRejected((reason: string) => {
                      stats.tradesFailed++;
                      console.warn('[Copy Trading] Order rejected:', reason);
                    });

                  result = { success: true, orderId: handle.orderId };
                  break; // OrderManager path: no retry
                } else if (splitCount > 1) {
                  // Split orders (via createBatchOrders)
                  try {
                    const orders = this.createSplitOrders({
                      tokenId,
                      side: trade.side,
                      basePrice: trade.price,
                      totalSize: copySize,
                      splitCount,
                      splitSpread,
                      limitPriceOffset,
                      orderType: limitOrderType,
                    });

                    result = await this.tradingService.createBatchOrders(orders);
                  } catch (error) {
                    result = {
                      success: false,
                      errorMsg: error instanceof Error ? error.message : String(error),
                    };
                  }
                } else {
                  // Single limit order via TradingService directly (no OrderManager)
                  result = await this.tradingService.createLimitOrder({
                    tokenId,
                    side: trade.side,
                    price: limitPrice,
                    size: copySize,
                    orderType: limitOrderType,
                  });
                }
              } else {
                // Market Order path (via TradingService)
                result = await this.tradingService.createMarketOrder({
                  tokenId,
                  side: trade.side,
                  amount: usdcAmount,
                  price: slippagePrice,
                  orderType: marketOrderType,
                });
              }

              // Retry logic: break on success or last attempt
              if (result.success || attempt >= retryCount) break;

              console.log(`[Copy Trading] 下单失败，${retryDelay}ms 后重试 (${attempt + 1}/${retryCount}): ${result.errorMsg ?? 'unknown error'}`);
              await new Promise(r => setTimeout(r, retryDelay));
            }
          }

          // Update stats (skip for OrderManager single limit orders — stats updated via handlers)
          if (!(options.orderManager && orderMode === 'limit' && splitCount === 1)) {
            if (result.success) {
              stats.tradesExecuted++;
              stats.totalUsdcSpent += usdcAmount;
            } else {
              stats.tradesFailed++;
            }
          }

          options.onTrade?.(trade, result);
        } catch (error) {
          stats.tradesFailed++;
          options.onError?.(error instanceof Error ? error : new Error(String(error)));
        }
      },
      { filterAddresses: targetAddresses, minSize: minTradeSize, detectionMode: options.detectionMode }
    );

    return {
      id: subscription.id,
      targetAddresses,
      startTime,
      isActive: true,
      stats,
      stop: () => subscription.unsubscribe(),
      getStats: () => ({ ...stats }),
    };
  }

  // ============================================================================
  // Leaderboard - 排行榜
  // ============================================================================

  /**
   * Get leaderboard by time period
   *
   * @example
   * ```typescript
   * // Get weekly top 100 by PnL
   * const leaderboard = await sdk.smartMoney.getLeaderboard({
   *   period: 'week',
   *   limit: 100,
   *   sortBy: 'pnl'
   * });
   * ```
   */
  async getLeaderboard(options: LeaderboardOptions = {}): Promise<SmartMoneyLeaderboardResult> {
    const period = options.period ?? 'week';
    const limit = Math.min(options.limit ?? 50, 500);
    const sortBy = options.sortBy ?? 'pnl';
    const offset = Math.min(options.offset ?? 0, 10000);

    const result = await this.walletService.fetchLeaderboardByPeriod(period, limit, sortBy, 'OVERALL', offset);

    const entries = result.entries.map(e => ({
      address: e.address,
      rank: e.rank,
      pnl: e.pnl,
      volume: e.volume,
      tradeCount: e.tradeCount,
      userName: e.userName,
      profileImage: e.profileImage,
      // 社交信息
      xUsername: e.xUsername,
      verifiedBadge: e.verifiedBadge,
      // Extended fields
      totalPnl: e.totalPnl,
      realizedPnl: e.realizedPnl,
      unrealizedPnl: e.unrealizedPnl,
      buyCount: e.buyCount,
      sellCount: e.sellCount,
      buyVolume: e.buyVolume,
      sellVolume: e.sellVolume,
      makerVolume: e.makerVolume,
      takerVolume: e.takerVolume,
    }));

    return {
      entries,
      hasMore: result.hasMore,
      request: result.request,
    };
  }

  // ============================================================================
  // Wallet Report - 钱包报告
  // ============================================================================

  /**
   * Generate comprehensive wallet report
   *
   * @example
   * ```typescript
   * const report = await sdk.smartMoney.getWalletReport('0x...');
   * console.log(report.overview.totalPnL);
   * console.log(report.rankings.weekly?.rank);
   * ```
   */
  async getWalletReport(address: string): Promise<WalletReport> {
    // Fetch all data in parallel
    const [
      profile,
      positions,
      activitySummary,
      dailyPnl,
      weeklyPnl,
      monthlyPnl,
      allTimePnl,
    ] = await Promise.all([
      this.walletService.getWalletProfile(address),
      this.walletService.getWalletPositions(address),
      this.walletService.getWalletActivity(address, 100),
      this.walletService.getUserPeriodPnl(address, 'day').catch(() => null),
      this.walletService.getUserPeriodPnl(address, 'week').catch(() => null),
      this.walletService.getUserPeriodPnl(address, 'month').catch(() => null),
      this.walletService.getUserPeriodPnl(address, 'all').catch(() => null),
    ]);

    // Calculate performance metrics
    const winningPositions = positions.filter(p => (p.cashPnl ?? 0) > 0);
    const losingPositions = positions.filter(p => (p.cashPnl ?? 0) < 0);

    // Use initialValue (cost basis) instead of currentValue (which is 0 for settled markets)
    const avgPositionSize = positions.length > 0
      ? positions.reduce((sum, p) => sum + (p.initialValue ?? (p.size * p.avgPrice)), 0) / positions.length
      : 0;

    const avgWinAmount = winningPositions.length > 0
      ? winningPositions.reduce((sum, p) => sum + (p.cashPnl ?? 0), 0) / winningPositions.length
      : 0;

    const avgLossAmount = losingPositions.length > 0
      ? Math.abs(losingPositions.reduce((sum, p) => sum + (p.cashPnl ?? 0), 0) / losingPositions.length)
      : 0;

    const uniqueMarkets = new Set(positions.map(p => p.conditionId)).size;

    // Category analysis
    const categoryStats = this.analyzeCategories(positions);

    // Recent trades
    const trades = activitySummary.activities.filter(a => a.type === 'TRADE');
    const recentTrades = trades.slice(0, 10);

    // Build rankings
    const toRanking = (entry: PeriodLeaderboardEntry | null): PeriodRanking | null => {
      if (!entry) return null;
      return { rank: entry.rank, pnl: entry.pnl, volume: entry.volume };
    };

    return {
      address,
      generatedAt: new Date(),

      overview: {
        totalPnL: profile.totalPnL,
        realizedPnL: profile.realizedPnL,
        unrealizedPnL: profile.unrealizedPnL,
        positionCount: positions.length,
        tradeCount: profile.tradeCount,
        smartScore: profile.smartScore,
        lastActiveAt: profile.lastActiveAt,
      },

      rankings: {
        daily: toRanking(dailyPnl),
        weekly: toRanking(weeklyPnl),
        monthly: toRanking(monthlyPnl),
        allTime: toRanking(allTimePnl),
      },

      performance: {
        winRate: positions.length > 0 ? (winningPositions.length / positions.length) * 100 : 0,
        winCount: winningPositions.length,
        lossCount: losingPositions.length,
        avgPositionSize,
        avgWinAmount,
        avgLossAmount,
        uniqueMarkets,
      },

      categoryBreakdown: categoryStats,

      topPositions: positions
        .sort((a, b) => Math.abs(b.cashPnl ?? 0) - Math.abs(a.cashPnl ?? 0))
        .slice(0, 10)
        .map(p => ({
          market: p.title,
          slug: p.slug,
          outcome: p.outcome,
          size: p.size,
          avgPrice: p.avgPrice,
          currentPrice: p.curPrice,
          pnl: p.cashPnl ?? 0,
          percentPnl: p.percentPnl,
        })),

      recentTrades: recentTrades.map(t => ({
        timestamp: t.timestamp,
        side: t.side,
        size: t.size,
        price: t.price,
        usdcSize: t.usdcSize,
        // Include market info for display
        title: t.title,
        slug: t.slug,
        outcome: t.outcome,
        conditionId: t.conditionId,
      })),

      activitySummary: {
        totalBuys: activitySummary.summary.totalBuys,
        totalSells: activitySummary.summary.totalSells,
        buyVolume: activitySummary.summary.buyVolume,
        sellVolume: activitySummary.summary.sellVolume,
        activeMarketsCount: activitySummary.summary.activeMarkets.length,
      },
    };
  }

  /**
   * Analyze position categories based on title keywords
   */
  private analyzeCategories(positions: Position[]): Array<{ category: string; positionCount: number; totalPnl: number }> {
    const categoryStats: Record<string, { count: number; totalPnl: number }> = {};

    for (const pos of positions) {
      const title = (pos.title || '').toLowerCase();
      let category = 'other';

      if (title.includes('trump') || title.includes('biden') || title.includes('election') || title.includes('president') || title.includes('congress')) {
        category = 'politics';
      } else if (title.includes('bitcoin') || title.includes('btc') || title.includes('eth') || title.includes('crypto') || title.includes('solana')) {
        category = 'crypto';
      } else if (title.includes('nba') || title.includes('nfl') || title.includes('soccer') || title.includes('football') || title.includes('ufc') || title.includes('mlb')) {
        category = 'sports';
      } else if (title.includes('fed') || title.includes('inflation') || title.includes('gdp') || title.includes('interest rate') || title.includes('unemployment')) {
        category = 'economy';
      } else if (title.includes('ai') || title.includes('openai') || title.includes('google') || title.includes('apple') || title.includes('tesla')) {
        category = 'tech';
      }

      if (!categoryStats[category]) {
        categoryStats[category] = { count: 0, totalPnl: 0 };
      }
      categoryStats[category].count++;
      categoryStats[category].totalPnl += (pos.cashPnl ?? 0);
    }

    return Object.entries(categoryStats)
      .map(([category, stats]) => ({
        category,
        positionCount: stats.count,
        totalPnl: stats.totalPnl,
      }))
      .sort((a, b) => b.positionCount - a.positionCount);
  }

  // ============================================================================
  // Wallet Comparison - 钱包对比
  // ============================================================================

  /**
   * Compare multiple wallets
   *
   * @example
   * ```typescript
   * const comparison = await sdk.smartMoney.compareWallets(
   *   ['0x111...', '0x222...', '0x333...'],
   *   { period: 'week' }
   * );
   * ```
   */
  async compareWallets(
    addresses: string[],
    options: { period?: TimePeriod } = {}
  ): Promise<WalletComparison> {
    const period = options.period ?? 'week';

    // Fetch data for all wallets in parallel
    const results = await Promise.all(
      addresses.map(async (address) => {
        const [periodPnl, positions] = await Promise.all([
          this.walletService.getUserPeriodPnl(address, period).catch(() => null),
          this.walletService.getWalletPositions(address).catch(() => []),
        ]);

        const winningPositions = positions.filter(p => (p.cashPnl ?? 0) > 0);
        const winRate = positions.length > 0
          ? (winningPositions.length / positions.length) * 100
          : 0;

        return {
          address,
          userName: periodPnl?.userName,
          rank: periodPnl?.rank ?? null,
          pnl: periodPnl?.pnl ?? 0,
          volume: periodPnl?.volume ?? 0,
          positionCount: positions.length,
          winRate,
        };
      })
    );

    // Sort by PnL descending
    results.sort((a, b) => b.pnl - a.pnl);

    return {
      period,
      generatedAt: new Date(),
      wallets: results,
    };
  }

  // ============================================================================
  // Report Generation (02-smart-money)
  // ============================================================================

  /**
   * Get daily wallet report
   *
   * @param address - Wallet address
   * @param date - Date for the report (default: today)
   *
   * @example
   * ```typescript
   * const report = await sdk.smartMoney.getDailyReport('0x...', new Date('2026-01-08'));
   * console.log(report.summary.realizedPnL);
   * ```
   */
  async getDailyReport(address: string, date?: Date): Promise<DailyWalletReport> {
    const targetDate = date || new Date();
    const dateStr = this.formatDate(targetDate);

    // Get start/end of day in Unix seconds
    const startOfDay = new Date(targetDate);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(targetDate);
    endOfDay.setHours(23, 59, 59, 999);

    const startTimestamp = Math.floor(startOfDay.getTime() / 1000);
    const endTimestamp = Math.floor(endOfDay.getTime() / 1000);

    // Fetch activities for the day
    const activitySummary = await this.walletService.getWalletActivity(address, {
      start: startTimestamp,
      end: endTimestamp,
      limit: 500,
    });

    // Fetch closed positions for the day
    const closedPositions = this.dataApi
      ? await this.dataApi.getClosedPositions(address, {
          sortBy: 'TIMESTAMP',
          sortDirection: 'DESC',
          limit: 50,
        })
      : [];

    // Filter closed positions for today
    const todaysClosed = closedPositions.filter(p => {
      const posDate = new Date(p.timestamp);
      return posDate >= startOfDay && posDate <= endOfDay;
    });

    // Calculate summary
    const trades = activitySummary.activities.filter(a => a.type === 'TRADE');
    const buys = trades.filter(t => t.side === 'BUY');
    const sells = trades.filter(t => t.side === 'SELL');

    const summary: DailySummary = {
      totalTrades: trades.length,
      buyCount: buys.length,
      sellCount: sells.length,
      buyVolume: buys.reduce((sum, t) => sum + (t.usdcSize || 0), 0),
      sellVolume: sells.reduce((sum, t) => sum + (t.usdcSize || 0), 0),
      realizedPnL: todaysClosed.reduce((sum, p) => sum + p.realizedPnl, 0),
      positionsClosed: todaysClosed.length,
      positionsOpened: buys.filter(b => {
        // Count unique new positions (approximate)
        return !sells.some(s => s.conditionId === b.conditionId);
      }).length,
    };

    // Calculate category breakdown
    const categoryBreakdown = this.calculateCategoryBreakdownFromActivities(trades);

    // Get significant trades (top 10 by value)
    const significantTrades: TradeRecord[] = trades
      .map(t => ({
        market: t.title || '',
        conditionId: t.conditionId,
        outcome: t.outcome || '',
        side: t.side as 'BUY' | 'SELL',
        price: t.price,
        size: t.size,
        usdcValue: t.usdcSize || t.size * t.price,
        timestamp: new Date(t.timestamp),
      }))
      .sort((a, b) => b.usdcValue - a.usdcValue)
      .slice(0, 10);

    // New positions
    const newPositions: PositionSummary[] = buys
      .filter(b => !sells.some(s => s.conditionId === b.conditionId))
      .slice(0, 10)
      .map(b => ({
        market: b.title || '',
        conditionId: b.conditionId,
        outcome: b.outcome || '',
        size: b.size,
        avgPrice: b.price,
      }));

    // Closed markets
    const closedMarkets: ClosedMarketSummary[] = todaysClosed.map(p => ({
      market: p.title,
      conditionId: p.conditionId,
      outcome: p.outcome,
      realizedPnL: p.realizedPnl,
      closePrice: p.curPrice,
    }));

    return {
      address,
      reportDate: dateStr,
      generatedAt: new Date(),
      summary,
      categoryBreakdown,
      significantTrades,
      newPositions,
      closedMarkets,
    };
  }

  /**
   * Get wallet lifecycle report
   *
   * @param address - Wallet address
   * @param options - Report options with progress callback
   *
   * @example
   * ```typescript
   * const report = await sdk.smartMoney.getLifecycleReport('0x...', {
   *   onProgress: (p, msg) => console.log(`${p * 100}%: ${msg}`)
   * });
   * console.log(report.performance.winRate);
   * ```
   */
  async getLifecycleReport(
    address: string,
    options?: LifecycleReportOptions
  ): Promise<WalletLifecycleReport> {
    const { onProgress } = options || {};

    // 1. Get basic info
    onProgress?.(0.1, 'Fetching profile...');
    const profile = await this.walletService.getWalletProfile(address);

    // 2. Get all closed positions (paginated)
    onProgress?.(0.2, 'Fetching closed positions...');
    const closedPositions = await this.fetchAllClosedPositions(address);

    // 3. Get current positions
    onProgress?.(0.6, 'Fetching current positions...');
    const currentPositions = await this.walletService.getWalletPositions(address);

    // 4. Calculate metrics
    onProgress?.(0.8, 'Calculating metrics...');
    const performance = this.calculatePerformanceMetricsFromClosed(closedPositions, currentPositions);
    const categoryDistribution = this.calculateCategoryDistributionFromClosed(closedPositions);
    const topMarkets = this.getTopMarkets(closedPositions, 10);
    const worstMarkets = this.getWorstMarkets(closedPositions, 10);
    const patterns = this.analyzeTradingPatterns(closedPositions, currentPositions);

    // 5. Determine data range
    let firstActivityAt = new Date();
    let lastActivityAt = new Date();
    let totalDays = 0;

    if (closedPositions.length > 0) {
      const timestamps = closedPositions.map(p => p.timestamp);
      firstActivityAt = new Date(Math.min(...timestamps));
      lastActivityAt = new Date(Math.max(...timestamps));
      totalDays = Math.ceil(
        (lastActivityAt.getTime() - firstActivityAt.getTime()) / (1000 * 60 * 60 * 24)
      );
    }

    // 6. Current positions summary
    const currentPosCategories = this.calculateCategoryDistributionFromPositions(currentPositions);
    const currentPositionsSummary: CurrentPositionsSummary = {
      count: currentPositions.length,
      totalValue: currentPositions.reduce((sum, p) => sum + (p.currentValue ?? p.size * (p.curPrice ?? 0)), 0),
      unrealizedPnL: currentPositions.reduce((sum, p) => sum + (p.cashPnl ?? 0), 0),
      categories: currentPosCategories,
    };

    onProgress?.(1.0, 'Report generated');

    return {
      address,
      generatedAt: new Date(),
      dataRange: {
        firstActivityAt,
        lastActivityAt,
        totalDays,
      },
      performance,
      categoryDistribution,
      topMarkets,
      worstMarkets,
      patterns,
      currentPositions: currentPositionsSummary,
    };
  }

  /**
   * Get wallet chart data
   *
   * @param address - Wallet address
   *
   * @example
   * ```typescript
   * const chartData = await sdk.smartMoney.getWalletChartData('0x...');
   * // Use chartData.tradeDistribution with recharts
   * ```
   */
  async getWalletChartData(address: string): Promise<WalletChartData> {
    // Fetch data
    const closedPositions = await this.fetchAllClosedPositions(address);
    const currentPositions = await this.walletService.getWalletPositions(address);

    // Trade distribution (by count)
    const tradeDistribution = this.buildPieChart(
      'Trade Distribution',
      closedPositions.map(p => ({ title: p.title, value: 1 })),
      'count'
    );

    // Position distribution (by value)
    const positionDistribution = this.buildPieChart(
      'Position Distribution',
      currentPositions.map(p => ({
        title: p.title,
        value: p.currentValue ?? p.size * (p.curPrice ?? 0),
      })),
      'value'
    );

    // Profit distribution (by PnL)
    const profitPositions = closedPositions.filter(p => p.realizedPnl > 0);
    const profitDistribution = this.buildPieChart(
      'Profit Distribution',
      profitPositions.map(p => ({ title: p.title, value: p.realizedPnl })),
      'pnl'
    );

    // Determine data range
    let fromDate = new Date();
    let toDate = new Date();
    if (closedPositions.length > 0) {
      const timestamps = closedPositions.map(p => p.timestamp);
      fromDate = new Date(Math.min(...timestamps));
      toDate = new Date(Math.max(...timestamps));
    }

    return {
      tradeDistribution,
      positionDistribution,
      profitDistribution,
      metadata: {
        address,
        generatedAt: new Date(),
        dataRange: { from: fromDate, to: toDate },
      },
    };
  }

  /**
   * Generate a text analysis report for a wallet
   *
   * @param address - Wallet address
   * @param options - Report options with progress callback
   *
   * @example
   * ```typescript
   * const textReport = await sdk.smartMoney.generateTextReport('0x...');
   * console.log(textReport.markdown);
   * ```
   */
  async generateTextReport(
    address: string,
    options?: LifecycleReportOptions
  ): Promise<TextReport> {
    const { onProgress } = options || {};

    // Get lifecycle report data
    onProgress?.(0.1, 'Fetching wallet data...');
    const report = await this.getLifecycleReport(address, {
      onProgress: (p, msg) => onProgress?.(0.1 + p * 0.7, msg),
    });

    // Get chart data for category distribution
    onProgress?.(0.8, 'Analyzing patterns...');
    const chartData = await this.getWalletChartData(address);

    // Generate text report
    onProgress?.(0.9, 'Generating report...');
    const markdown = this.buildTextReport(address, report, chartData);

    onProgress?.(1.0, 'Report complete');

    return {
      address,
      generatedAt: new Date(),
      markdown,
      metrics: {
        totalPnL: report.performance.realizedPnL + report.currentPositions.unrealizedPnL,
        winRate: report.performance.winRate,
        profitFactor: report.performance.profitFactor,
        totalMarketsTraded: report.performance.totalMarketsTraded,
        totalDays: report.dataRange.totalDays,
      },
    };
  }

  /**
   * Build markdown text report from data
   */
  private buildTextReport(
    address: string,
    report: WalletLifecycleReport,
    chartData: WalletChartData
  ): string {
    const { performance, categoryDistribution, topMarkets, worstMarkets, patterns, currentPositions, dataRange } = report;

    const totalPnL = performance.realizedPnL + currentPositions.unrealizedPnL;
    const formatPnL = (v: number) => v >= 0 ? `+$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : `-$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const formatPercent = (v: number) => `${(v * 100).toFixed(1)}%`;
    const formatDate = (d: Date) => d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });

    // Determine trading style
    const tradingStyle = this.analyzeTradingStyle(patterns, categoryDistribution);
    const riskAssessment = this.assessRisk(performance, patterns, categoryDistribution);
    const recommendation = this.generateRecommendation(performance, riskAssessment, tradingStyle);

    const sections: string[] = [];

    // Header
    sections.push(`# Wallet Analysis Report\n`);
    sections.push(`**Address**: \`${address.slice(0, 10)}...${address.slice(-8)}\``);
    sections.push(`**Report Date**: ${formatDate(new Date())}`);
    sections.push(`**Data Range**: ${formatDate(dataRange.firstActivityAt)} - ${formatDate(dataRange.lastActivityAt)} (${dataRange.totalDays} days)\n`);

    // Executive Summary
    sections.push(`## Executive Summary\n`);
    sections.push(`| Metric | Value |`);
    sections.push(`|--------|-------|`);
    sections.push(`| Total PnL | ${formatPnL(totalPnL)} |`);
    sections.push(`| Realized PnL | ${formatPnL(performance.realizedPnL)} |`);
    sections.push(`| Unrealized PnL | ${formatPnL(currentPositions.unrealizedPnL)} |`);
    sections.push(`| Win Rate | ${formatPercent(performance.winRate)} |`);
    sections.push(`| Profit Factor | ${performance.profitFactor.toFixed(2)} |`);
    sections.push(`| Markets Traded | ${performance.totalMarketsTraded} |`);
    sections.push(`| Current Positions | ${currentPositions.count} |`);
    sections.push(``);

    // Trading Style
    sections.push(`## Trading Style Analysis\n`);
    sections.push(`- **Position Preference**: ${tradingStyle.positionPreference}`);
    sections.push(`- **Trading Frequency**: ${tradingStyle.tradingFrequency}`);
    sections.push(`- **Position Management**: ${tradingStyle.positionManagement}`);
    sections.push(`- **Primary Focus**: ${tradingStyle.primaryFocus}`);
    sections.push(``);

    // Category Distribution
    sections.push(`## Market Category Distribution\n`);
    sections.push(`| Category | Trades | PnL | Share |`);
    sections.push(`|----------|--------|-----|-------|`);
    for (const cat of categoryDistribution.slice(0, 6)) {
      sections.push(`| ${CATEGORY_LABELS[cat.category]} | ${cat.tradeCount} | ${formatPnL(cat.pnl)} | ${cat.percentage.toFixed(1)}% |`);
    }
    sections.push(``);

    // Top Markets
    if (topMarkets.length > 0) {
      sections.push(`## Best Performing Markets\n`);
      for (let i = 0; i < Math.min(5, topMarkets.length); i++) {
        const m = topMarkets[i];
        sections.push(`${i + 1}. **${m.market}**: ${formatPnL(m.pnl)}`);
      }
      sections.push(``);
    }

    // Worst Markets
    if (worstMarkets.length > 0) {
      sections.push(`## Worst Performing Markets\n`);
      for (let i = 0; i < Math.min(5, worstMarkets.length); i++) {
        const m = worstMarkets[i];
        sections.push(`${i + 1}. **${m.market}**: ${formatPnL(m.pnl)}`);
      }
      sections.push(``);
    }

    // Risk Assessment
    sections.push(`## Risk Assessment\n`);
    sections.push(`- **Concentration Risk**: ${riskAssessment.concentrationRisk}`);
    sections.push(`- **Drawdown Risk**: ${riskAssessment.drawdownRisk}`);
    sections.push(`- **Overall Risk Level**: ${riskAssessment.overallRisk}`);
    sections.push(``);

    // Copy Trading Recommendation
    sections.push(`## Copy Trading Recommendation\n`);
    sections.push(`**Verdict**: ${recommendation.verdict}\n`);
    sections.push(`${recommendation.reasoning}\n`);
    if (recommendation.suitableMarkets.length > 0) {
      sections.push(`**Suitable Markets**: ${recommendation.suitableMarkets.join(', ')}`);
    }
    if (recommendation.avoidMarkets.length > 0) {
      sections.push(`**Markets to Avoid**: ${recommendation.avoidMarkets.join(', ')}`);
    }
    if (recommendation.warnings.length > 0) {
      sections.push(`\n**Warnings**:`);
      for (const w of recommendation.warnings) {
        sections.push(`- ${w}`);
      }
    }

    return sections.join('\n');
  }

  /**
   * Analyze trading style from patterns
   */
  private analyzeTradingStyle(
    patterns: TradingPatterns,
    categoryDistribution: CategoryStats[]
  ): TradingStyle {
    // Position preference
    let positionPreference: string;
    if (patterns.preferredSide === 'YES') {
      positionPreference = 'YES-biased (tends to bet on positive outcomes)';
    } else if (patterns.preferredSide === 'NO') {
      positionPreference = 'NO-biased (tends to bet against outcomes)';
    } else {
      positionPreference = 'Balanced (no strong directional bias)';
    }

    // Trading frequency
    let tradingFrequency: string;
    if (patterns.avgTradesPerDay > 10) {
      tradingFrequency = 'High-frequency (>10 trades/day)';
    } else if (patterns.avgTradesPerDay > 3) {
      tradingFrequency = 'Active (3-10 trades/day)';
    } else if (patterns.avgTradesPerDay > 1) {
      tradingFrequency = 'Moderate (1-3 trades/day)';
    } else {
      tradingFrequency = 'Low-frequency (<1 trade/day)';
    }

    // Position management
    let positionManagement: string;
    if (patterns.positionConcentration > 0.5) {
      positionManagement = 'Concentrated (high single-position exposure)';
    } else if (patterns.positionConcentration > 0.25) {
      positionManagement = 'Moderate diversification';
    } else {
      positionManagement = 'Well-diversified';
    }

    // Primary focus
    const topCategory = categoryDistribution[0];
    const primaryFocus = topCategory
      ? `${CATEGORY_LABELS[topCategory.category]} (${topCategory.percentage.toFixed(0)}% of trades)`
      : 'Diversified';

    return {
      positionPreference,
      tradingFrequency,
      positionManagement,
      primaryFocus,
    };
  }

  /**
   * Assess risk profile
   */
  private assessRisk(
    performance: PerformanceMetrics,
    patterns: TradingPatterns,
    categoryDistribution: CategoryStats[]
  ): RiskAssessment {
    // Concentration risk
    const topCategoryShare = categoryDistribution[0]?.percentage || 0;
    let concentrationRisk: string;
    if (topCategoryShare > 70) {
      concentrationRisk = 'High (>70% in single category)';
    } else if (topCategoryShare > 50) {
      concentrationRisk = 'Medium (50-70% in top category)';
    } else {
      concentrationRisk = 'Low (well diversified)';
    }

    // Drawdown risk
    const maxLossRatio = performance.maxLoss / Math.max(Math.abs(performance.realizedPnL), 1);
    let drawdownRisk: string;
    if (maxLossRatio > 0.5) {
      drawdownRisk = 'High (max loss >50% of total PnL)';
    } else if (maxLossRatio > 0.25) {
      drawdownRisk = 'Medium';
    } else {
      drawdownRisk = 'Low';
    }

    // Overall risk
    let overallRisk: string;
    if (performance.winRate < 0.4 || performance.profitFactor < 1) {
      overallRisk = 'HIGH - Unprofitable strategy';
    } else if (performance.winRate < 0.5 || performance.profitFactor < 1.5) {
      overallRisk = 'MEDIUM - Moderate performance';
    } else if (patterns.positionConcentration > 0.5) {
      overallRisk = 'MEDIUM - High concentration';
    } else {
      overallRisk = 'LOW - Solid track record';
    }

    return { concentrationRisk, drawdownRisk, overallRisk };
  }

  /**
   * Generate copy trading recommendation
   */
  private generateRecommendation(
    performance: PerformanceMetrics,
    risk: RiskAssessment,
    style: TradingStyle
  ): CopyRecommendation {
    const warnings: string[] = [];
    const suitableMarkets: string[] = [];
    const avoidMarkets: string[] = [];

    // Determine verdict
    let verdict: string;
    let reasoning: string;

    if (performance.winRate >= 0.6 && performance.profitFactor >= 1.5) {
      verdict = 'RECOMMENDED';
      reasoning = `This wallet shows consistent profitability with a ${(performance.winRate * 100).toFixed(0)}% win rate and ${performance.profitFactor.toFixed(1)}x profit factor. The trading pattern is suitable for copy trading.`;
    } else if (performance.winRate >= 0.5 && performance.profitFactor >= 1.2) {
      verdict = 'CAUTIOUSLY RECOMMENDED';
      reasoning = `This wallet is profitable but with moderate consistency. Consider following with smaller position sizes.`;
    } else if (performance.realizedPnL > 0) {
      verdict = 'NOT RECOMMENDED';
      reasoning = `While overall profitable, the low win rate (${(performance.winRate * 100).toFixed(0)}%) or profit factor (${performance.profitFactor.toFixed(1)}x) suggests inconsistent performance.`;
    } else {
      verdict = 'AVOID';
      reasoning = `This wallet has negative overall performance. Not suitable for copy trading.`;
    }

    // Add warnings
    if (risk.overallRisk.includes('HIGH')) {
      warnings.push('High risk profile detected');
    }
    if (performance.losingMarkets > performance.winningMarkets) {
      warnings.push('More losing markets than winning markets');
    }
    if (style.tradingFrequency.includes('High-frequency')) {
      warnings.push('High-frequency trading may incur significant fees when copying');
    }

    return {
      verdict,
      reasoning,
      suitableMarkets,
      avoidMarkets,
      warnings,
    };
  }

  // ============================================================================
  // Report Helper Methods
  // ============================================================================

  /**
   * Categorize market based on title keywords
   */
  private categorizeMarket(title: string): MarketCategory {
    const lowerTitle = title.toLowerCase();

    // Crypto
    if (/\b(btc|bitcoin|eth|ethereum|sol|solana|xrp|crypto|doge|ada|matic)\b/.test(lowerTitle)) {
      return 'crypto';
    }

    // Politics
    if (/\b(trump|biden|election|president|senate|congress|vote|political|maga|democrat|republican)\b/.test(lowerTitle)) {
      return 'politics';
    }

    // Sports
    if (/\b(nfl|nba|mlb|nhl|super bowl|world cup|championship|game|match|ufc|soccer|football|basketball)\b/.test(lowerTitle)) {
      return 'sports';
    }

    // Economics
    if (/\b(fed|interest rate|inflation|gdp|recession|economic|unemployment|cpi)\b/.test(lowerTitle)) {
      return 'economics';
    }

    // Entertainment
    if (/\b(oscar|grammy|movie|twitter|celebrity|entertainment|netflix|spotify)\b/.test(lowerTitle)) {
      return 'entertainment';
    }

    // Science
    if (/\b(spacex|nasa|ai|openai|google|apple|tesla|tech|technology|science)\b/.test(lowerTitle)) {
      return 'science';
    }

    return 'other';
  }

  /**
   * Fetch all closed positions with pagination
   */
  private async fetchAllClosedPositions(address: string): Promise<ClosedPosition[]> {
    if (!this.dataApi) {
      return [];
    }

    const allPositions: ClosedPosition[] = [];
    let offset = 0;
    const limit = 50;
    const maxIterations = 200; // Max 10000 positions

    for (let i = 0; i < maxIterations; i++) {
      const result = await this.dataApi.getClosedPositions(address, {
        limit,
        offset,
        sortBy: 'TIMESTAMP',
        sortDirection: 'DESC',
      });

      if (result.length === 0) break;

      allPositions.push(...result);
      offset += limit;

      // If less than limit returned, we've reached the end
      if (result.length < limit) break;
    }

    return allPositions;
  }

  /**
   * Calculate performance metrics from closed positions
   */
  private calculatePerformanceMetricsFromClosed(
    closedPositions: ClosedPosition[],
    currentPositions: Position[]
  ): PerformanceMetrics {
    const wins = closedPositions.filter(p => p.realizedPnl > 0);
    const losses = closedPositions.filter(p => p.realizedPnl < 0);

    const totalWinAmount = wins.reduce((sum, p) => sum + p.realizedPnl, 0);
    const totalLossAmount = Math.abs(losses.reduce((sum, p) => sum + p.realizedPnl, 0));

    const realizedPnL = closedPositions.reduce((sum, p) => sum + p.realizedPnl, 0);
    const unrealizedPnL = currentPositions.reduce((sum, p) => sum + (p.cashPnl ?? 0), 0);

    return {
      totalPnL: realizedPnL + unrealizedPnL,
      realizedPnL,
      unrealizedPnL,
      totalVolume: closedPositions.reduce((sum, p) => sum + p.totalBought, 0),
      winRate: closedPositions.length > 0 ? wins.length / closedPositions.length : 0,
      profitFactor: totalLossAmount > 0 ? totalWinAmount / totalLossAmount : totalWinAmount,
      avgWin: wins.length > 0 ? totalWinAmount / wins.length : 0,
      avgLoss: losses.length > 0 ? totalLossAmount / losses.length : 0,
      maxWin: wins.length > 0 ? Math.max(...wins.map(p => p.realizedPnl)) : 0,
      maxLoss: losses.length > 0 ? Math.max(...losses.map(p => Math.abs(p.realizedPnl))) : 0,
      totalMarketsTraded: closedPositions.length,
      winningMarkets: wins.length,
      losingMarkets: losses.length,
    };
  }

  /**
   * Calculate category distribution from closed positions
   */
  private calculateCategoryDistributionFromClosed(positions: ClosedPosition[]): CategoryStats[] {
    const categoryMap = new Map<MarketCategory, { count: number; volume: number; pnl: number }>();

    for (const pos of positions) {
      const category = this.categorizeMarket(pos.title);
      const current = categoryMap.get(category) || { count: 0, volume: 0, pnl: 0 };
      categoryMap.set(category, {
        count: current.count + 1,
        volume: current.volume + pos.totalBought,
        pnl: current.pnl + pos.realizedPnl,
      });
    }

    const total = positions.length;

    return Array.from(categoryMap.entries())
      .map(([category, stats]) => ({
        category,
        tradeCount: stats.count,
        volume: stats.volume,
        pnl: stats.pnl,
        percentage: total > 0 ? (stats.count / total) * 100 : 0,
      }))
      .sort((a, b) => b.tradeCount - a.tradeCount);
  }

  /**
   * Calculate category distribution from current positions
   */
  private calculateCategoryDistributionFromPositions(positions: Position[]): CategoryStats[] {
    const categoryMap = new Map<MarketCategory, { count: number; volume: number; pnl: number }>();

    for (const pos of positions) {
      const category = this.categorizeMarket(pos.title || '');
      const current = categoryMap.get(category) || { count: 0, volume: 0, pnl: 0 };
      categoryMap.set(category, {
        count: current.count + 1,
        volume: current.volume + (pos.currentValue ?? pos.size * (pos.curPrice ?? 0)),
        pnl: current.pnl + (pos.cashPnl ?? 0),
      });
    }

    const total = positions.length;

    return Array.from(categoryMap.entries())
      .map(([category, stats]) => ({
        category,
        tradeCount: stats.count,
        volume: stats.volume,
        pnl: stats.pnl,
        percentage: total > 0 ? (stats.count / total) * 100 : 0,
      }))
      .sort((a, b) => b.tradeCount - a.tradeCount);
  }

  /**
   * Calculate category breakdown from activity trades
   */
  private calculateCategoryBreakdownFromActivities(
    trades: Array<{ title?: string; usdcSize?: number; size: number; price: number }>
  ): CategoryStats[] {
    const categoryMap = new Map<MarketCategory, { count: number; volume: number }>();

    for (const trade of trades) {
      const category = this.categorizeMarket(trade.title || '');
      const current = categoryMap.get(category) || { count: 0, volume: 0 };
      categoryMap.set(category, {
        count: current.count + 1,
        volume: current.volume + (trade.usdcSize || trade.size * trade.price),
      });
    }

    const total = trades.length;

    return Array.from(categoryMap.entries())
      .map(([category, stats]) => ({
        category,
        tradeCount: stats.count,
        volume: stats.volume,
        pnl: 0, // Not available from trades
        percentage: total > 0 ? (stats.count / total) * 100 : 0,
      }))
      .sort((a, b) => b.tradeCount - a.tradeCount);
  }

  /**
   * Get top markets by PnL
   */
  private getTopMarkets(positions: ClosedPosition[], limit: number): MarketStats[] {
    return positions
      .filter(p => p.realizedPnl > 0)
      .sort((a, b) => b.realizedPnl - a.realizedPnl)
      .slice(0, limit)
      .map(p => ({
        market: p.title,
        conditionId: p.conditionId,
        category: this.categorizeMarket(p.title),
        pnl: p.realizedPnl,
        volume: p.totalBought,
        tradeCount: 1, // Each closed position is one market
        outcome: 'win' as const,
        avgPrice: p.avgPrice,
        closePrice: p.curPrice,
      }));
  }

  /**
   * Get worst markets by PnL
   */
  private getWorstMarkets(positions: ClosedPosition[], limit: number): MarketStats[] {
    return positions
      .filter(p => p.realizedPnl < 0)
      .sort((a, b) => a.realizedPnl - b.realizedPnl)
      .slice(0, limit)
      .map(p => ({
        market: p.title,
        conditionId: p.conditionId,
        category: this.categorizeMarket(p.title),
        pnl: p.realizedPnl,
        volume: p.totalBought,
        tradeCount: 1,
        outcome: 'lose' as const,
        avgPrice: p.avgPrice,
        closePrice: p.curPrice,
      }));
  }

  /**
   * Analyze trading patterns
   */
  private analyzeTradingPatterns(
    closedPositions: ClosedPosition[],
    currentPositions: Position[]
  ): TradingPatterns {
    // Calculate average trades per day/week
    let avgTradesPerDay = 0;
    let avgTradesPerWeek = 0;

    if (closedPositions.length > 0) {
      const timestamps = closedPositions.map(p => p.timestamp);
      const firstDate = new Date(Math.min(...timestamps));
      const lastDate = new Date(Math.max(...timestamps));
      const totalDays = Math.max(1, Math.ceil(
        (lastDate.getTime() - firstDate.getTime()) / (1000 * 60 * 60 * 24)
      ));
      avgTradesPerDay = closedPositions.length / totalDays;
      avgTradesPerWeek = avgTradesPerDay * 7;
    }

    // Determine preferred side
    const yesPositions = currentPositions.filter(p =>
      p.outcome?.toLowerCase() === 'yes' || p.outcome?.toLowerCase() === 'up'
    );
    const noPositions = currentPositions.filter(p =>
      p.outcome?.toLowerCase() === 'no' || p.outcome?.toLowerCase() === 'down'
    );

    let preferredSide: 'YES' | 'NO' | 'balanced' = 'balanced';
    if (yesPositions.length > noPositions.length * 1.5) {
      preferredSide = 'YES';
    } else if (noPositions.length > yesPositions.length * 1.5) {
      preferredSide = 'NO';
    }

    // Average position size
    const avgPositionSize = closedPositions.length > 0
      ? closedPositions.reduce((sum, p) => sum + p.totalBought, 0) / closedPositions.length
      : 0;

    // Top categories
    const categoryStats = this.calculateCategoryDistributionFromClosed(closedPositions);
    const topCategories = categoryStats
      .slice(0, 3)
      .map(c => c.category);

    // Position concentration (max single position share)
    const totalValue = currentPositions.reduce((sum, p) =>
      sum + (p.currentValue ?? p.size * (p.curPrice ?? 0)), 0
    );
    const maxPositionValue = currentPositions.length > 0
      ? Math.max(...currentPositions.map(p => p.currentValue ?? p.size * (p.curPrice ?? 0)))
      : 0;
    const positionConcentration = totalValue > 0 ? maxPositionValue / totalValue : 0;

    return {
      avgTradesPerDay,
      avgTradesPerWeek,
      preferredSide,
      avgPositionSize,
      avgHoldingDays: 0, // Would need more data to calculate
      topCategories,
      positionConcentration,
    };
  }

  /**
   * Build pie chart data
   */
  private buildPieChart(
    name: string,
    items: Array<{ title: string; value: number }>,
    _valueField: 'count' | 'value' | 'pnl'
  ): PieChartData {
    const categoryMap = new Map<MarketCategory, number>();

    for (const item of items) {
      const category = this.categorizeMarket(item.title);
      const current = categoryMap.get(category) || 0;
      categoryMap.set(category, current + item.value);
    }

    const total = Array.from(categoryMap.values()).reduce((a, b) => a + b, 0);

    const data: PieSlice[] = Array.from(categoryMap.entries())
      .map(([category, value]) => ({
        name: CATEGORY_LABELS[category],
        value,
        percentage: total > 0 ? (value / total) * 100 : 0,
        color: CATEGORY_COLORS[category],
      }))
      .sort((a, b) => b.value - a.value);

    return { name, data, total };
  }

  /**
   * Format date as YYYY-MM-DD
   */
  private formatDate(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  // ============================================================================
  // Utilities
  // ============================================================================

  private isCacheValid(): boolean {
    return Date.now() - this.cacheTimestamp < this.config.cacheTtl && this.smartMoneyCache.size > 0;
  }

  // ============================================================================
  // Phase 2: Enhanced Copy Trading Utilities
  // ============================================================================

  /**
   * Calculate limit price based on detected price and offset
   * BUY: limitPrice = detectedPrice + offset
   * SELL: limitPrice = detectedPrice - offset
   */
  private calculateLimitPrice(side: 'BUY' | 'SELL', detectedPrice: number, offset: number): number {
    const raw = side === 'BUY' ? detectedPrice + offset : detectedPrice - offset;
    return this.roundToTick(this.clamp(raw, 0.01, 0.99));
  }

  /**
   * Create split orders for batch execution
   * Splits total size into N orders with price gradation
   */
  private createSplitOrders(params: {
    tokenId: string;
    side: 'BUY' | 'SELL';
    basePrice: number;
    totalSize: number;
    splitCount: number;
    splitSpread: number;
    limitPriceOffset: number;
    orderType?: 'GTC' | 'GTD';
  }): Array<{
    tokenId: string;
    side: 'BUY' | 'SELL';
    price: number;
    size: number;
    orderType: 'GTC' | 'GTD';
  }> {
    const { tokenId, side, basePrice, totalSize, splitCount, splitSpread, limitPriceOffset, orderType = 'GTC' } = params;

    // Validate splitCount
    if (splitCount > 15) {
      throw new Error(`Split count (${splitCount}) exceeds Polymarket maximum (15 orders)`);
    }

    // Auto-reduce splitCount if totalSize can't support requested splits (minimum 5 shares each)
    const MIN_SHARES = 5;
    let effectiveSplitCount = splitCount;
    while (effectiveSplitCount > 1 && Math.floor(totalSize / effectiveSplitCount) < MIN_SHARES) {
      effectiveSplitCount--;
    }
    const sizePerOrder = Math.floor(totalSize / effectiveSplitCount);
    if (sizePerOrder < MIN_SHARES) {
      throw new Error(`Split order size (${sizePerOrder}) below minimum (${MIN_SHARES} shares). Total: ${totalSize}, split: ${effectiveSplitCount}`);
    }
    if (effectiveSplitCount < splitCount) {
      console.log(`[SmartMoney] Split count auto-reduced: ${splitCount} → ${effectiveSplitCount} (totalSize=${totalSize}, min=${MIN_SHARES}/order)`);
    }

    const baseLimitPrice = this.calculateLimitPrice(side, basePrice, limitPriceOffset);

    const orders: Array<{
      tokenId: string;
      side: 'BUY' | 'SELL';
      price: number;
      size: number;
      orderType: 'GTC' | 'GTD';
    }> = [];

    for (let i = 0; i < effectiveSplitCount; i++) {
      // Price gradation: BUY goes up, SELL goes down
      const priceOffset = side === 'BUY' ? i * splitSpread : -i * splitSpread;
      const limitPrice = this.roundToTick(this.clamp(baseLimitPrice + priceOffset, 0.01, 0.99));

      orders.push({
        tokenId,
        side,
        price: limitPrice,
        size: sizePerOrder,
        orderType,
      });
    }

    return orders;
  }

  /**
   * Round price to tick (0.01)
   */
  private roundToTick(price: number): number {
    return Math.round(price * 100) / 100;
  }

  /**
   * Clamp value between min and max
   */
  private clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  }

  disconnect(): void {
    // 停止轮询和 mempool
    this.stopPolling();
    this.stopMempoolMonitor();

    // 清理状态
    this.tradeHandlers.clear();
    this.targetWallets = [];
    this.mempoolTargetAddresses.clear();
    this.seenTxHashes.clear();
    this.smartMoneyCache.clear();
    this.smartMoneySet.clear();
    this.lastCheckTimestamp = Math.floor(Date.now() / 1000);
  }
}
