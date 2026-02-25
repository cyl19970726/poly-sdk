/**
 * Wallet Service
 *
 * Provides smart money analysis features:
 * - Wallet profile analysis
 * - Position tracking
 * - Activity monitoring
 * - Sell detection for follow wallet strategy
 * - Time-based leaderboard and wallet stats
 */

import {
  DataApiClient,
  Position,
  Activity,
  LeaderboardEntry,
  LeaderboardResult,
  LeaderboardTimePeriod,
  LeaderboardOrderBy,
  LeaderboardCategory,
} from '../clients/data-api.js';
import { SubgraphClient, OrderFilledEvent } from '../clients/subgraph.js';
import type { UnifiedCache } from '../core/unified-cache.js';
import { CACHE_TTL } from '../core/unified-cache.js';

// ===== Time Period Types =====

/** Time period (lowercase for SDK, maps to API's uppercase) */
export type TimePeriod = 'day' | 'week' | 'month' | 'all';

/** Sort criteria for period leaderboard (official API supports PNL and VOL) */
export type LeaderboardSortBy = 'volume' | 'pnl';

// Re-export API types for convenience
export type { LeaderboardTimePeriod, LeaderboardOrderBy, LeaderboardCategory };

/**
 * Collateral Asset ID (USDC)
 * In Polymarket orderbook, "0" represents the collateral token (USDC)
 */
const COLLATERAL_ASSET_ID = '0';

/**
 * Check if an asset ID is collateral (USDC) or outcome token
 */
function isCollateralAsset(assetId: string): boolean {
  return assetId === COLLATERAL_ASSET_ID;
}

/**
 * Parsed trade from OrderFilledEvent
 */
export interface ParsedTrade {
  timestamp: number;
  user: string;
  role: 'maker' | 'taker';
  side: 'BUY' | 'SELL';
  tokenId: string;          // Outcome token ID
  tokenAmount: number;      // Outcome token 数量
  usdcAmount: number;       // USDC 数量
  price: number;            // 价格 (USDC per token)
}

/**
 * Position tracking for PnL calculation
 */
export interface TokenPosition {
  tokenId: string;
  amount: number;           // 当前持仓数量
  avgCost: number;          // 平均成本
  totalCost: number;        // 总成本
  realizedPnl: number;      // 已实现盈亏
}

/**
 * User stats with PnL
 */
export interface UserPeriodStats {
  address: string;
  volume: number;           // 总 USDC 成交量
  tradeCount: number;
  buyCount: number;
  sellCount: number;
  buyVolume: number;        // 买入 USDC 量
  sellVolume: number;       // 卖出 USDC 量
  realizedPnl: number;      // 已实现盈亏
  unrealizedPnl: number;    // 未实现盈亏 (需要当前价格)
  positions: Map<string, TokenPosition>;  // 各 token 持仓
}

export interface PeriodLeaderboardEntry {
  address: string;
  rank: number;
  // Core metrics from official API
  volume: number;           // 时间段内成交量 (USDC)
  pnl: number;              // 时间段内盈亏 (USDC) - 官方 API 提供
  // PnL breakdown (官方 API 不区分已实现/未实现)
  totalPnl: number;         // 总盈亏 = pnl
  realizedPnl: number;      // 已实现盈亏
  unrealizedPnl: number;    // 未实现盈亏
  // 交易统计 (部分来自官方 API)
  tradeCount: number;       // 时间段内成交次数
  buyCount: number;         // 买入次数
  sellCount: number;        // 卖出次数
  buyVolume: number;        // 买入金额
  sellVolume: number;       // 卖出金额
  // 兼容旧字段
  makerVolume: number;
  takerVolume: number;
  // 用户资料 (来自官方 API)
  userName?: string;
  profileImage?: string;
  // 社交信息 (来自官方 API)
  xUsername?: string;       // Twitter/X 用户名
  verifiedBadge?: boolean;  // 是否已验证
}

/**
 * Leaderboard result with proper semantics
 *
 * Note: Polymarket API doesn't return total count.
 */
export interface PeriodLeaderboardResult {
  /** Leaderboard entries returned by the API */
  entries: PeriodLeaderboardEntry[];
  /** Whether there may be more entries (entries.length === request.limit) */
  hasMore: boolean;
  /** Echo of request parameters for pagination convenience */
  request: {
    offset: number;
    limit: number;
  };
}

export interface WalletPeriodStats {
  address: string;
  period: TimePeriod;
  startTime: number;        // Unix timestamp
  endTime: number;          // Unix timestamp
  // 成交统计
  volume: number;           // 总成交量 (USDC)
  tradeCount: number;       // 成交次数
  makerVolume: number;
  takerVolume: number;
  makerCount: number;
  takerCount: number;
  // 活动统计
  splitCount: number;
  mergeCount: number;
  redemptionCount: number;
  redemptionPayout: number; // 赎回金额
}

export interface WalletProfile {
  address: string;
  totalPnL: number;
  realizedPnL: number;
  unrealizedPnL: number;
  avgPercentPnL: number;
  positionCount: number;
  closedPositionCount: number;
  tradeCount: number;
  smartScore: number; // 0-100
  lastActiveAt: Date;
}

export interface WalletActivityOptions {
  /** Maximum number of activities to return */
  limit?: number;
  /** Pagination offset */
  offset?: number;
  /** Start timestamp (Unix seconds) - filter activities after this time */
  start?: number;
  /** End timestamp (Unix seconds) - filter activities before this time */
  end?: number;
  /** Filter by activity type */
  type?: 'TRADE' | 'SPLIT' | 'MERGE' | 'REDEEM' | 'REWARD' | 'CONVERSION';
  /** Filter by trade side */
  side?: 'BUY' | 'SELL';
  /** Filter by market conditionId */
  market?: string;
  /** Fetch all activities with auto-pagination (up to maxItems) */
  fetchAll?: boolean;
  /** Maximum items when fetchAll=true (default 10000) */
  maxItems?: number;
}

export interface WalletActivitySummary {
  address: string;
  activities: Activity[];
  summary: {
    totalBuys: number;
    totalSells: number;
    buyVolume: number;
    sellVolume: number;
    activeMarkets: string[];
  };
  /** Time range of returned activities */
  timeRange?: {
    earliest: Date;
    latest: Date;
  };
}

export interface SellActivityResult {
  totalSellAmount: number;
  sellTransactions: Activity[];
  sellRatio: number;
  shouldExit: boolean;
}

export class WalletService {
  constructor(
    private dataApi: DataApiClient,
    private subgraph: SubgraphClient,
    private cache: UnifiedCache
  ) {}

  // ===== Time Period Helpers =====

  /**
   * Get start timestamp for a time period
   */
  private getPeriodStartTime(period: TimePeriod): number {
    const now = Math.floor(Date.now() / 1000);
    switch (period) {
      case 'day':
        return now - 24 * 60 * 60;
      case 'week':
        return now - 7 * 24 * 60 * 60;
      case 'month':
        return now - 30 * 24 * 60 * 60;
      case 'all':
        return 0;
    }
  }

  // ===== Wallet Analysis =====

  /**
   * Get comprehensive wallet profile with PnL analysis
   */
  async getWalletProfile(address: string): Promise<WalletProfile> {
    const [positions, activities, closedPnLResult] = await Promise.all([
      this.dataApi.getPositions(address),
      this.dataApi.getActivity(address, { limit: 100 }),
      this.getClosedPositionsTotalPnL(address),
    ]);

    const openCashPnL = positions.reduce((sum, p) => sum + (p.cashPnl || 0), 0);
    const openRealizedPnL = positions.reduce((sum, p) => sum + (p.realizedPnl || 0), 0);
    const unrealizedPnL = openCashPnL - openRealizedPnL;

    const realizedPnL = openRealizedPnL + closedPnLResult.totalPnL;
    const totalPnL = unrealizedPnL + realizedPnL;

    const avgPercentPnL =
      positions.length > 0
        ? positions.reduce((sum, p) => sum + (p.percentPnl || 0), 0) / positions.length
        : 0;

    const lastActivity = activities[0];

    return {
      address,
      totalPnL,
      realizedPnL,
      unrealizedPnL,
      avgPercentPnL,
      positionCount: positions.length,
      closedPositionCount: closedPnLResult.count,
      tradeCount: activities.filter((a) => a.type === 'TRADE').length,
      smartScore: this.calculateSmartScore(positions, activities),
      lastActiveAt: lastActivity ? new Date(lastActivity.timestamp) : new Date(0),
    };
  }

  /**
   * Paginate through all closed positions and sum their realized PnL.
   */
  private async getClosedPositionsTotalPnL(address: string): Promise<{ totalPnL: number; count: number }> {
    let totalPnL = 0;
    let count = 0;
    let offset = 0;
    const limit = 50; // API max per page

    while (offset < 100000) {
      const batch = await this.dataApi.getClosedPositions(address, { limit, offset });
      totalPnL += batch.reduce((sum, p) => sum + (p.realizedPnl || 0), 0);
      count += batch.length;
      if (batch.length < limit) break;
      offset += limit;
    }

    return { totalPnL, count };
  }

  /**
   * Get positions for a wallet
   */
  async getWalletPositions(address: string): Promise<Position[]> {
    return this.dataApi.getPositions(address);
  }

  /**
   * Get positions for a specific market
   */
  async getPositionsForMarket(address: string, conditionId: string): Promise<Position[]> {
    const positions = await this.dataApi.getPositions(address);
    return positions.filter((p) => p.conditionId === conditionId);
  }

  /**
   * Get wallet activity with summary
   *
   * @param address - Wallet address
   * @param options - Activity query options (limit, start, end, type, side, market, fetchAll)
   *
   * @example
   * ```typescript
   * // Get recent 100 activities
   * const activity = await walletService.getWalletActivity(address);
   *
   * // Get activities from past week
   * const oneWeekAgo = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;
   * const weekActivity = await walletService.getWalletActivity(address, { start: oneWeekAgo });
   *
   * // Get all activities (auto-pagination, up to API limit)
   * const allActivity = await walletService.getWalletActivity(address, { fetchAll: true });
   * ```
   */
  async getWalletActivity(
    address: string,
    options: WalletActivityOptions | number = 100
  ): Promise<WalletActivitySummary> {
    // Support legacy signature: getWalletActivity(address, limit)
    const opts: WalletActivityOptions =
      typeof options === 'number' ? { limit: options } : options;

    let activities: Activity[];

    if (opts.fetchAll) {
      // Use getAllActivity for complete history with auto-pagination
      activities = await this.dataApi.getAllActivity(
        address,
        {
          start: opts.start,
          end: opts.end,
          type: opts.type,
          side: opts.side,
          market: opts.market ? [opts.market] : undefined,
        },
        opts.maxItems || 10000
      );
    } else {
      // Use getActivity for single page
      activities = await this.dataApi.getActivity(address, {
        limit: opts.limit || 100,
        offset: opts.offset,
        start: opts.start,
        end: opts.end,
        type: opts.type,
        side: opts.side,
        market: opts.market ? [opts.market] : undefined,
      });
    }

    const buys = activities.filter((a) => a.side === 'BUY');
    const sells = activities.filter((a) => a.side === 'SELL');

    // Calculate time range
    let timeRange: { earliest: Date; latest: Date } | undefined;
    if (activities.length > 0) {
      const timestamps = activities.map((a) => a.timestamp);
      timeRange = {
        earliest: new Date(Math.min(...timestamps)),
        latest: new Date(Math.max(...timestamps)),
      };
    }

    return {
      address,
      activities,
      summary: {
        totalBuys: buys.length,
        totalSells: sells.length,
        buyVolume: buys.reduce((sum, a) => sum + (a.usdcSize || 0), 0),
        sellVolume: sells.reduce((sum, a) => sum + (a.usdcSize || 0), 0),
        activeMarkets: [...new Set(activities.map((a) => a.conditionId))],
      },
      timeRange,
    };
  }

  // ===== Wallet Discovery =====

  /**
   * Get leaderboard
   */
  async getLeaderboard(page = 0, pageSize = 50): Promise<LeaderboardResult> {
    return this.dataApi.fetchLeaderboard({ limit: pageSize, offset: page * pageSize });
  }

  /**
   * Get top traders from leaderboard
   */
  async getTopTraders(limit = 10): Promise<LeaderboardEntry[]> {
    const result = await this.dataApi.fetchLeaderboard({ limit });
    return result.entries;
  }

  // ===== Time-Based Leaderboard =====

  /**
   * Get leaderboard by time period using official Polymarket API
   *
   * Uses the official Data API which supports time period filtering.
   * This is the recommended method as it uses server-side calculations.
   *
   * @param period - Time period: 'day', 'week', 'month', or 'all'
   * @param limit - Maximum entries to return (default: 50, max: 50)
   * @param sortBy - Sort criteria: 'volume' or 'pnl' (default: 'pnl')
   * @param category - Market category filter (default: 'OVERALL')
   *
   * @example
   * ```typescript
   * // Get top traders of the week by PnL
   * const weeklyByPnl = await walletService.getLeaderboardByPeriod('week', 20, 'pnl');
   *
   * // Get top traders by volume
   * const weeklyByVolume = await walletService.getLeaderboardByPeriod('week', 20, 'volume');
   *
   * // Get politics category leaderboard
   * const politics = await walletService.getLeaderboardByPeriod('week', 20, 'pnl', 'POLITICS');
   * ```
   */
  async getLeaderboardByPeriod(
    period: TimePeriod,
    limit = 50,
    sortBy: LeaderboardSortBy = 'pnl',
    category: LeaderboardCategory = 'OVERALL',
    offset = 0
  ): Promise<PeriodLeaderboardEntry[]> {
    // Map lowercase period to API's uppercase format
    const timePeriodMap: Record<TimePeriod, LeaderboardTimePeriod> = {
      day: 'DAY',
      week: 'WEEK',
      month: 'MONTH',
      all: 'ALL',
    };

    // Map sortBy to API's orderBy format
    const orderByMap: Record<LeaderboardSortBy, LeaderboardOrderBy> = {
      volume: 'VOL',
      pnl: 'PNL',
    };

    const timePeriod = timePeriodMap[period];
    const orderBy = orderByMap[sortBy];

    // Use official API
    const result = await this.dataApi.fetchLeaderboard({
      timePeriod,
      orderBy,
      category,
      limit,
      offset,
    });

    // Map to PeriodLeaderboardEntry format
    return result.entries.map((entry: LeaderboardEntry, index: number) => ({
      address: entry.address,
      rank: entry.rank || index + 1,
      volume: entry.volume,
      pnl: entry.pnl,
      // API provides combined PnL, set as total
      totalPnl: entry.pnl,
      realizedPnl: entry.pnl, // API doesn't separate realized/unrealized
      unrealizedPnl: 0,
      // API doesn't provide these breakdowns
      tradeCount: entry.trades || 0,
      buyCount: 0,
      sellCount: 0,
      buyVolume: 0,
      sellVolume: 0,
      makerVolume: 0,
      takerVolume: 0,
      // User profile
      userName: entry.userName,
      profileImage: entry.profileImage,
    }));
  }

  /**
   * Get leaderboard by time period with pagination info
   *
   * Same as getLeaderboardByPeriod but returns pagination metadata.
   *
   * @param period - Time period: 'day', 'week', 'month', or 'all'
   * @param limit - Maximum entries to return (default: 50, max: 500)
   * @param sortBy - Sort by 'pnl' or 'volume' (default: 'pnl')
   * @param category - Market category filter (default: 'OVERALL')
   * @param offset - Pagination offset (default: 0)
   *
   * @example
   * ```typescript
   * const result = await walletService.fetchLeaderboardByPeriod('week', 20, 'pnl', 'OVERALL', 0);
   * console.log(`Showing ${result.entries.length}, hasMore: ${result.hasMore}`);
   * ```
   */
  async fetchLeaderboardByPeriod(
    period: TimePeriod,
    limit = 50,
    sortBy: LeaderboardSortBy = 'pnl',
    category: LeaderboardCategory = 'OVERALL',
    offset = 0
  ): Promise<PeriodLeaderboardResult> {
    // Map lowercase period to API's uppercase format
    const timePeriodMap: Record<TimePeriod, LeaderboardTimePeriod> = {
      day: 'DAY',
      week: 'WEEK',
      month: 'MONTH',
      all: 'ALL',
    };

    // Map sortBy to API's orderBy format
    const orderByMap: Record<LeaderboardSortBy, LeaderboardOrderBy> = {
      volume: 'VOL',
      pnl: 'PNL',
    };

    const timePeriod = timePeriodMap[period];
    const orderBy = orderByMap[sortBy];

    // Use official API with new fetchLeaderboard method
    const result = await this.dataApi.fetchLeaderboard({
      timePeriod,
      orderBy,
      category,
      limit,
      offset,
    });

    // Map to PeriodLeaderboardEntry format
    const entries = result.entries.map((entry, index) => ({
      address: entry.address,
      rank: entry.rank || offset + index + 1,
      volume: entry.volume,
      pnl: entry.pnl,
      totalPnl: entry.pnl,
      realizedPnl: entry.pnl,
      unrealizedPnl: 0,
      tradeCount: entry.trades || 0,
      buyCount: 0,
      sellCount: 0,
      buyVolume: 0,
      sellVolume: 0,
      makerVolume: 0,
      takerVolume: 0,
      userName: entry.userName,
      profileImage: entry.profileImage,
      xUsername: entry.xUsername,
      verifiedBadge: entry.verifiedBadge,
    }));

    return {
      entries,
      hasMore: result.hasMore,
      request: result.request,
    };
  }

  /**
   * Get a specific user's PnL and ranking for a time period
   *
   * Uses the official Data API's user filter to get a single user's stats.
   *
   * @param address - User's wallet address
   * @param period - Time period: 'day', 'week', 'month', or 'all'
   * @param category - Market category filter (default: 'OVERALL')
   *
   * @example
   * ```typescript
   * // Get user's weekly PnL
   * const stats = await walletService.getUserPeriodPnl(address, 'week');
   * console.log(`Rank: #${stats.rank}, PnL: $${stats.pnl}`);
   *
   * // Get user's monthly PnL in politics category
   * const politicsStats = await walletService.getUserPeriodPnl(address, 'month', 'POLITICS');
   * ```
   */
  async getUserPeriodPnl(
    address: string,
    period: TimePeriod,
    category: LeaderboardCategory = 'OVERALL'
  ): Promise<PeriodLeaderboardEntry | null> {
    // Map lowercase period to API's uppercase format
    const timePeriodMap: Record<TimePeriod, LeaderboardTimePeriod> = {
      day: 'DAY',
      week: 'WEEK',
      month: 'MONTH',
      all: 'ALL',
    };

    const timePeriod = timePeriodMap[period];

    // Use official API with user filter
    const result = await this.dataApi.fetchLeaderboard({
      timePeriod,
      orderBy: 'PNL',
      category,
      user: address,
      limit: 1,
    });

    if (result.entries.length === 0) {
      return null;
    }

    const entry = result.entries[0];
    return {
      address: entry.address,
      rank: entry.rank || 0,
      volume: entry.volume,
      pnl: entry.pnl,
      totalPnl: entry.pnl,
      realizedPnl: entry.pnl,
      unrealizedPnl: 0,
      tradeCount: entry.trades || 0,
      buyCount: 0,
      sellCount: 0,
      buyVolume: 0,
      sellVolume: 0,
      makerVolume: 0,
      takerVolume: 0,
      userName: entry.userName,
      profileImage: entry.profileImage,
    };
  }

  /**
   * Get wallet stats for a specific time period
   *
   * Combines data from Orderbook Subgraph (trades) and Activity Subgraph (splits/merges/redemptions)
   *
   * @param address - Wallet address
   * @param period - Time period: 'day', 'week', 'month', or 'all'
   *
   * @example
   * ```typescript
   * // Get wallet's monthly stats
   * const stats = await walletService.getWalletStatsByPeriod(address, 'month');
   * console.log(`Monthly volume: $${stats.volume}`);
   * ```
   */
  async getWalletStatsByPeriod(
    address: string,
    period: TimePeriod
  ): Promise<WalletPeriodStats> {
    const startTime = this.getPeriodStartTime(period);
    const endTime = Math.floor(Date.now() / 1000);
    const cacheKey = `wallet:stats:${address}:${period}`;

    return this.cache.getOrSet(cacheKey, CACHE_TTL.ACTIVITY, async () => {
      // Fetch data in parallel
      const [makerFills, takerFills, splits, merges, redemptions] = await Promise.all([
        this.subgraph.getMakerFills(address, {
          first: 1000,
          where: { timestamp_gte: String(startTime) },
        }),
        this.subgraph.getTakerFills(address, {
          first: 1000,
          where: { timestamp_gte: String(startTime) },
        }),
        this.subgraph.getSplits(address, {
          first: 500,
          where: { timestamp_gte: String(startTime) },
        }),
        this.subgraph.getMerges(address, {
          first: 500,
          where: { timestamp_gte: String(startTime) },
        }),
        this.subgraph.getRedemptions(address, {
          first: 500,
          where: { timestamp_gte: String(startTime) },
        }),
      ]);

      // Calculate volumes (amounts are in micro-units, divide by 1e6 for USDC)
      const makerVolume = makerFills.reduce(
        (sum, f) => sum + Number(f.makerAmountFilled) / 1e6,
        0
      );
      const takerVolume = takerFills.reduce(
        (sum, f) => sum + Number(f.takerAmountFilled) / 1e6,
        0
      );
      const redemptionPayout = redemptions.reduce(
        (sum, r) => sum + Number(r.payout) / 1e6,
        0
      );

      return {
        address,
        period,
        startTime,
        endTime,
        volume: makerVolume + takerVolume,
        tradeCount: makerFills.length + takerFills.length,
        makerVolume,
        takerVolume,
        makerCount: makerFills.length,
        takerCount: takerFills.length,
        splitCount: splits.length,
        mergeCount: merges.length,
        redemptionCount: redemptions.length,
        redemptionPayout,
      };
    });
  }

  /**
   * Fetch all order filled events in a time period with pagination
   */
  private async fetchAllFillsInPeriod(
    startTime: number,
    maxItems = 5000
  ): Promise<OrderFilledEvent[]> {
    const allFills: OrderFilledEvent[] = [];
    let skip = 0;
    const first = 1000;

    while (allFills.length < maxItems) {
      const fills = await this.subgraph.getOrderFilledEvents({
        first,
        skip,
        where: startTime > 0 ? { timestamp_gte: String(startTime) } : undefined,
        orderBy: 'timestamp',
        orderDirection: 'desc',
      });

      if (fills.length === 0) break;

      allFills.push(...fills);
      skip += first;

      // Break if we got less than requested (no more data)
      if (fills.length < first) break;
    }

    return allFills.slice(0, maxItems);
  }

  /**
   * Parse OrderFilledEvent into user trades
   *
   * OrderFilledEvent 结构:
   * - makerAssetId = "0" (USDC): Maker 卖 USDC = BUY outcome token
   * - makerAssetId = 长数字: Maker 卖 outcome token = SELL
   */
  private parseOrderFilledEvent(fill: OrderFilledEvent): ParsedTrade[] {
    const timestamp = Number(fill.timestamp);
    const makerSellsCollateral = isCollateralAsset(fill.makerAssetId);

    if (makerSellsCollateral) {
      // Maker: 卖 USDC, 买 Outcome Token = BUY
      // Taker: 卖 Outcome Token, 买 USDC = SELL
      const usdcAmount = Number(fill.makerAmountFilled) / 1e6;
      const tokenAmount = Number(fill.takerAmountFilled) / 1e6;
      const price = tokenAmount > 0 ? usdcAmount / tokenAmount : 0;
      const tokenId = fill.takerAssetId;

      return [
        {
          timestamp,
          user: fill.maker.toLowerCase(),
          role: 'maker',
          side: 'BUY',
          tokenId,
          tokenAmount,
          usdcAmount,
          price,
        },
        {
          timestamp,
          user: fill.taker.toLowerCase(),
          role: 'taker',
          side: 'SELL',
          tokenId,
          tokenAmount,
          usdcAmount,
          price,
        },
      ];
    } else {
      // Maker: 卖 Outcome Token, 买 USDC = SELL
      // Taker: 卖 USDC, 买 Outcome Token = BUY
      const tokenAmount = Number(fill.makerAmountFilled) / 1e6;
      const usdcAmount = Number(fill.takerAmountFilled) / 1e6;
      const price = tokenAmount > 0 ? usdcAmount / tokenAmount : 0;
      const tokenId = fill.makerAssetId;

      return [
        {
          timestamp,
          user: fill.maker.toLowerCase(),
          role: 'maker',
          side: 'SELL',
          tokenId,
          tokenAmount,
          usdcAmount,
          price,
        },
        {
          timestamp,
          user: fill.taker.toLowerCase(),
          role: 'taker',
          side: 'BUY',
          tokenId,
          tokenAmount,
          usdcAmount,
          price,
        },
      ];
    }
  }

  /**
   * Update position with a trade and calculate realized PnL
   *
   * 买入: 增加持仓，更新平均成本
   * 卖出: 减少持仓，计算已实现盈亏 = 卖出收入 - 成本基础
   */
  private updatePositionWithTrade(
    position: TokenPosition,
    trade: ParsedTrade
  ): TokenPosition {
    if (trade.side === 'BUY') {
      // 买入：增加持仓，更新平均成本
      const newAmount = position.amount + trade.tokenAmount;
      const newTotalCost = position.totalCost + trade.usdcAmount;
      const newAvgCost = newAmount > 0 ? newTotalCost / newAmount : 0;

      return {
        ...position,
        amount: newAmount,
        totalCost: newTotalCost,
        avgCost: newAvgCost,
      };
    } else {
      // 卖出：减少持仓，计算已实现盈亏
      const sellAmount = Math.min(trade.tokenAmount, position.amount);
      const costBasis = sellAmount * position.avgCost;
      const revenue = (sellAmount / trade.tokenAmount) * trade.usdcAmount;
      const realizedPnl = revenue - costBasis;

      const newAmount = position.amount - sellAmount;
      const newTotalCost = newAmount > 0 ? newAmount * position.avgCost : 0;

      return {
        ...position,
        amount: newAmount,
        totalCost: newTotalCost,
        realizedPnl: position.realizedPnl + realizedPnl,
      };
    }
  }

  /**
   * Calculate unrealized PnL for a position
   *
   * 未实现盈亏 = 当前市值 - 总成本
   * 假设当前价格约等于最后交易价格 (简化处理)
   */
  private calculateUnrealizedPnl(position: TokenPosition, lastPrice: number): number {
    if (position.amount <= 0) return 0;
    const currentValue = position.amount * lastPrice;
    return currentValue - position.totalCost;
  }

  /**
   * Aggregate user statistics with PnL calculation from order filled events
   *
   * 核心计算流程:
   * 1. 解析 OrderFilledEvent 为标准化的 ParsedTrade
   * 2. 按时间顺序处理每笔交易
   * 3. 追踪每个用户每个 token 的持仓和平均成本
   * 4. 卖出时计算已实现盈亏
   * 5. 期末计算未实现盈亏
   */
  private aggregateUserStatsWithPnl(
    fills: OrderFilledEvent[]
  ): Map<string, UserPeriodStats> {
    const userStats = new Map<string, UserPeriodStats>();
    const lastPrices = new Map<string, number>(); // 记录每个 token 的最后交易价格

    // 初始化用户统计
    const getOrCreateUserStats = (address: string): UserPeriodStats => {
      let stats = userStats.get(address);
      if (!stats) {
        stats = {
          address,
          volume: 0,
          tradeCount: 0,
          buyCount: 0,
          sellCount: 0,
          buyVolume: 0,
          sellVolume: 0,
          realizedPnl: 0,
          unrealizedPnl: 0,
          positions: new Map(),
        };
        userStats.set(address, stats);
      }
      return stats;
    };

    // 解析所有交易
    const allTrades: ParsedTrade[] = [];
    for (const fill of fills) {
      const trades = this.parseOrderFilledEvent(fill);
      allTrades.push(...trades);
    }

    // 按时间排序 (升序，确保正确计算成本基础)
    allTrades.sort((a, b) => a.timestamp - b.timestamp);

    // 处理每笔交易
    for (const trade of allTrades) {
      const stats = getOrCreateUserStats(trade.user);

      // 更新交易统计
      stats.volume += trade.usdcAmount;
      stats.tradeCount += 1;

      if (trade.side === 'BUY') {
        stats.buyCount += 1;
        stats.buyVolume += trade.usdcAmount;
      } else {
        stats.sellCount += 1;
        stats.sellVolume += trade.usdcAmount;
      }

      // 更新持仓和计算已实现 PnL
      let position = stats.positions.get(trade.tokenId);
      if (!position) {
        position = {
          tokenId: trade.tokenId,
          amount: 0,
          avgCost: 0,
          totalCost: 0,
          realizedPnl: 0,
        };
      }

      const oldRealizedPnl = position.realizedPnl;
      position = this.updatePositionWithTrade(position, trade);
      stats.positions.set(trade.tokenId, position);

      // 累加已实现 PnL
      stats.realizedPnl += position.realizedPnl - oldRealizedPnl;

      // 记录最后价格
      if (trade.price > 0) {
        lastPrices.set(trade.tokenId, trade.price);
      }
    }

    // 计算每个用户的未实现 PnL
    for (const [, stats] of userStats) {
      let totalUnrealizedPnl = 0;
      for (const [tokenId, position] of stats.positions) {
        if (position.amount > 0) {
          const lastPrice = lastPrices.get(tokenId) || position.avgCost;
          totalUnrealizedPnl += this.calculateUnrealizedPnl(position, lastPrice);
        }
      }
      stats.unrealizedPnl = totalUnrealizedPnl;
    }

    return userStats;
  }

  /**
   * Discover active wallets from recent trades
   */
  async discoverActiveWallets(limit = 100): Promise<Array<{ address: string; tradeCount: number }>> {
    const trades = await this.dataApi.getTrades({ limit: 1000 });

    // Count trades per wallet
    const walletCounts = new Map<string, number>();
    for (const trade of trades) {
      if (trade.proxyWallet) {
        walletCounts.set(trade.proxyWallet, (walletCounts.get(trade.proxyWallet) || 0) + 1);
      }
    }

    // Sort by trade count
    return [...walletCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([address, tradeCount]) => ({ address, tradeCount }));
  }

  // ===== Sell Detection (Follow Wallet Strategy) =====

  /**
   * Detect sell activity for a wallet in a specific market
   */
  async detectSellActivity(
    address: string,
    conditionId: string,
    sinceTimestamp: number,
    peakValue?: number
  ): Promise<SellActivityResult> {
    const activities = await this.dataApi.getActivity(address, { limit: 200, type: 'TRADE' });

    const sellTransactions = activities.filter(
      (a) => a.conditionId === conditionId && a.side === 'SELL' && a.timestamp >= sinceTimestamp
    );

    const totalSellAmount = sellTransactions.reduce((sum, a) => sum + (a.usdcSize || a.size * a.price), 0);

    // Calculate sell ratio if peak value is provided
    const sellRatio = peakValue && peakValue > 0 ? totalSellAmount / peakValue : 0;

    return {
      totalSellAmount,
      sellTransactions,
      sellRatio,
      shouldExit: sellRatio >= 0.3, // 30% threshold for exit signal
    };
  }

  /**
   * Track sell ratio for multiple wallets (aggregated)
   */
  async trackGroupSellRatio(
    addresses: string[],
    conditionId: string,
    peakTotalValue: number,
    sinceTimestamp: number
  ): Promise<{
    cumulativeSellAmount: number;
    sellRatio: number;
    shouldExit: boolean;
    walletSells: Array<{ address: string; sellAmount: number }>;
  }> {
    const walletSells: Array<{ address: string; sellAmount: number }> = [];
    let cumulativeSellAmount = 0;

    for (const address of addresses) {
      const sellData = await this.detectSellActivity(address, conditionId, sinceTimestamp);
      walletSells.push({ address, sellAmount: sellData.totalSellAmount });
      cumulativeSellAmount += sellData.totalSellAmount;
    }

    const sellRatio = peakTotalValue > 0 ? cumulativeSellAmount / peakTotalValue : 0;

    return {
      cumulativeSellAmount,
      sellRatio,
      shouldExit: sellRatio >= 0.3,
      walletSells,
    };
  }

  // ===== Smart Score Calculation =====

  private calculateSmartScore(positions: Position[], activities: Activity[]): number {
    // Weights: PnL 40%, Win Rate 30%, Consistency 20%, Activity 10%

    // PnL Score (0-40)
    const avgPnL =
      positions.length > 0
        ? positions.reduce((sum, p) => sum + (p.percentPnl || 0), 0) / positions.length
        : 0;
    const pnlScore = Math.min(40, Math.max(0, ((avgPnL + 50) / 100) * 40));

    // Win Rate Score (0-30)
    const winningPositions = positions.filter((p) => (p.cashPnl || 0) > 0).length;
    const winRate = positions.length > 0 ? winningPositions / positions.length : 0;
    const winRateScore = winRate * 30;

    // Consistency Score (0-20)
    const pnlValues = positions.map((p) => p.percentPnl || 0);
    const variance = this.calculateVariance(pnlValues);
    const consistencyScore = Math.max(0, 20 - variance / 10);

    // Activity Score (0-10)
    const recentTrades = activities.filter((a) => a.timestamp > Date.now() - 7 * 24 * 60 * 60 * 1000).length;
    const activityScore = Math.min(10, (recentTrades / 5) * 10);

    return Math.round(pnlScore + winRateScore + consistencyScore + activityScore);
  }

  private calculateVariance(values: number[]): number {
    if (values.length === 0) return 0;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    return values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length;
  }
}
