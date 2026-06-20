/**
 * smart-money/reports.ts
 *
 * WalletReports: wallet report, daily report, lifecycle report, chart data.
 * Extracted from SmartMoneyService (V2 modularization).
 */

import type { WalletService, TimePeriod, PeriodLeaderboardEntry } from '../services/wallet-service.js';
import type { Position, ClosedPosition, DataApiClient } from '../clients/data-api.js';
import {
  CATEGORY_COLORS,
  CATEGORY_LABELS,
  type MarketCategory,
  type WalletReport,
  type WalletComparison,
  type DailyWalletReport,
  type DailySummary,
  type CategoryStats,
  type TradeRecord,
  type PositionSummary,
  type ClosedMarketSummary,
  type WalletLifecycleReport,
  type DataRange,
  type PerformanceMetrics,
  type MarketStats,
  type TradingPatterns,
  type CurrentPositionsSummary,
  type WalletChartData,
  type PieChartData,
  type PieSlice,
  type ChartMetadata,
  type TextReport,
  type LifecycleReportOptions,
  type PeriodRanking,
} from './types.js';
import { categorizeMarket } from './constants.js';

export type {
  WalletReport,
  WalletComparison,
  DailyWalletReport,
  WalletLifecycleReport,
  WalletChartData,
  TextReport,
  LifecycleReportOptions,
};

/**
 * WalletReports generates comprehensive wallet analysis reports.
 */
export class WalletReports {
  private walletService: WalletService;
  private dataApi: DataApiClient;

  constructor(walletService: WalletService, dataApi: DataApiClient) {
    this.walletService = walletService;
    this.dataApi = dataApi;
  }

  // ============================================================================
  // Wallet Report
  // ============================================================================

  async getWalletReport(address: string): Promise<WalletReport> {
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

    const winningPositions = positions.filter(p => (p.cashPnl ?? 0) > 0);
    const losingPositions = positions.filter(p => (p.cashPnl ?? 0) < 0);

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
    const categoryStats = this.analyzeCategories(positions);
    const trades = activitySummary.activities.filter((a: any) => a.type === 'TRADE');
    const recentTrades = trades.slice(0, 10);

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
      recentTrades: recentTrades.map((t: any) => ({
        timestamp: t.timestamp,
        side: t.side,
        size: t.size,
        price: t.price,
        usdcSize: t.usdcSize,
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

  // ============================================================================
  // Wallet Comparison
  // ============================================================================

  async compareWallets(
    addresses: string[],
    options: { period?: TimePeriod } = {}
  ): Promise<WalletComparison> {
    const period = options.period ?? 'week';

    const results = await Promise.all(
      addresses.map(async (address) => {
        const [periodPnl, positions] = await Promise.all([
          this.walletService.getUserPeriodPnl(address, period).catch(() => null),
          this.walletService.getWalletPositions(address).catch(() => []),
        ]);

        const winningPositions = positions.filter((p: Position) => (p.cashPnl ?? 0) > 0);
        const winRate = positions.length > 0
          ? (winningPositions.length / positions.length) * 100
          : 0;

        return {
          address,
          userName: (periodPnl as any)?.userName,
          rank: (periodPnl as any)?.rank ?? null,
          pnl: (periodPnl as any)?.pnl ?? 0,
          volume: (periodPnl as any)?.volume ?? 0,
          positionCount: positions.length,
          winRate,
        };
      })
    );

    results.sort((a, b) => b.pnl - a.pnl);

    return {
      period: period as any,
      generatedAt: new Date(),
      wallets: results,
    };
  }

  // ============================================================================
  // Daily Report
  // ============================================================================

  async getDailyReport(address: string, date?: Date): Promise<DailyWalletReport> {
    const targetDate = date || new Date();
    const dateStr = this.formatDate(targetDate);

    const startOfDay = new Date(targetDate);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(targetDate);
    endOfDay.setHours(23, 59, 59, 999);

    const startTimestamp = Math.floor(startOfDay.getTime() / 1000);
    const endTimestamp = Math.floor(endOfDay.getTime() / 1000);

    const activitySummary = await this.walletService.getWalletActivity(address, {
      start: startTimestamp,
      end: endTimestamp,
      limit: 500,
    } as any);

    const closedPositions = await this.dataApi.getClosedPositions(address, {
      sortBy: 'TIMESTAMP',
      sortDirection: 'DESC',
      limit: 50,
    });

    const todaysClosed = closedPositions.filter(p => {
      const posDate = new Date(p.timestamp);
      return posDate >= startOfDay && posDate <= endOfDay;
    });

    const trades = activitySummary.activities.filter((a: any) => a.type === 'TRADE');
    const buys = trades.filter((t: any) => t.side === 'BUY');
    const sells = trades.filter((t: any) => t.side === 'SELL');

    const summary: DailySummary = {
      totalTrades: trades.length,
      buyCount: buys.length,
      sellCount: sells.length,
      buyVolume: buys.reduce((sum: number, t: any) => sum + (t.usdcSize || 0), 0),
      sellVolume: sells.reduce((sum: number, t: any) => sum + (t.usdcSize || 0), 0),
      realizedPnL: todaysClosed.reduce((sum, p) => sum + p.realizedPnl, 0),
      positionsClosed: todaysClosed.length,
      positionsOpened: buys.filter((b: any) => !sells.some((s: any) => s.conditionId === b.conditionId)).length,
    };

    const categoryBreakdown = this.calculateCategoryBreakdownFromActivities(trades);

    const significantTrades: TradeRecord[] = trades
      .map((t: any) => ({
        market: t.title || '',
        conditionId: t.conditionId,
        outcome: t.outcome || '',
        side: t.side as 'BUY' | 'SELL',
        price: t.price,
        size: t.size,
        usdcValue: t.usdcSize || t.size * t.price,
        timestamp: new Date(t.timestamp),
      }))
      .sort((a: TradeRecord, b: TradeRecord) => b.usdcValue - a.usdcValue)
      .slice(0, 10);

    const newPositions: PositionSummary[] = buys
      .filter((b: any) => !sells.some((s: any) => s.conditionId === b.conditionId))
      .slice(0, 10)
      .map((b: any) => ({
        market: b.title || '',
        conditionId: b.conditionId,
        outcome: b.outcome || '',
        size: b.size,
        avgPrice: b.price,
      }));

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

  // ============================================================================
  // Lifecycle Report
  // ============================================================================

  async getLifecycleReport(
    address: string,
    options?: LifecycleReportOptions
  ): Promise<WalletLifecycleReport> {
    const { onProgress } = options || {};

    onProgress?.(0.1, 'Fetching profile...');
    const profile = await this.walletService.getWalletProfile(address);

    onProgress?.(0.2, 'Fetching closed positions...');
    const closedPositions = await this.fetchAllClosedPositions(address);

    onProgress?.(0.6, 'Fetching current positions...');
    const currentPositions = await this.walletService.getWalletPositions(address);

    onProgress?.(0.8, 'Calculating metrics...');
    const performance = this.calculatePerformanceMetrics(closedPositions, currentPositions);
    const categoryDistribution = this.calculateCategoryDistributionFromClosed(closedPositions);
    const topMarkets = this.getTopMarkets(closedPositions, 10);
    const worstMarkets = this.getWorstMarkets(closedPositions, 10);
    const patterns = this.analyzeTradingPatterns(closedPositions, currentPositions);

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

    const currentPosCategories = this.calculateCategoryDistributionFromPositions(currentPositions);
    const currentPositionsSummary: CurrentPositionsSummary = {
      count: currentPositions.length,
      totalValue: currentPositions.reduce((sum, p) => sum + (p.currentValue ?? p.size * (p.curPrice ?? 0)), 0),
      unrealizedPnL: currentPositions.reduce((sum, p) => sum + (p.cashPnl ?? 0), 0),
      categories: currentPosCategories,
    };

    onProgress?.(1.0, 'Report generated');

    // Suppress unused variable warning
    void profile;

    return {
      address,
      generatedAt: new Date(),
      dataRange: { firstActivityAt, lastActivityAt, totalDays },
      performance,
      categoryDistribution,
      topMarkets,
      worstMarkets,
      patterns,
      currentPositions: currentPositionsSummary,
    };
  }

  // ============================================================================
  // Chart Data
  // ============================================================================

  async getWalletChartData(address: string): Promise<WalletChartData> {
    const [closedPositions, currentPositions] = await Promise.all([
      this.fetchAllClosedPositions(address),
      this.walletService.getWalletPositions(address),
    ]);

    const tradeDistribution = this.buildPieChart(
      'Trade Distribution',
      closedPositions.map(p => ({ title: p.title, value: 1 }))
    );
    const positionDistribution = this.buildPieChart(
      'Position Distribution',
      currentPositions.map(p => ({ title: p.title, value: p.currentValue ?? p.size * (p.curPrice ?? 0) }))
    );
    const profitDistribution = this.buildPieChart(
      'Profit Distribution',
      closedPositions.filter(p => p.realizedPnl > 0).map(p => ({ title: p.title, value: p.realizedPnl }))
    );

    let fromDate = new Date();
    let toDate = new Date();
    if (closedPositions.length > 0) {
      const timestamps = closedPositions.map(p => p.timestamp);
      fromDate = new Date(Math.min(...timestamps));
      toDate = new Date(Math.max(...timestamps));
    }

    const metadata: ChartMetadata = {
      address,
      generatedAt: new Date(),
      dataRange: { from: fromDate, to: toDate },
    };

    return { tradeDistribution, positionDistribution, profitDistribution, metadata };
  }

  // ============================================================================
  // Text Report
  // ============================================================================

  async generateTextReport(address: string, options?: LifecycleReportOptions): Promise<TextReport> {
    const { onProgress } = options || {};

    onProgress?.(0.1, 'Fetching wallet data...');
    const report = await this.getLifecycleReport(address, {
      onProgress: (p, msg) => onProgress?.(0.1 + p * 0.7, msg),
    });

    onProgress?.(0.8, 'Analyzing patterns...');
    const chartData = await this.getWalletChartData(address);

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

  // ============================================================================
  // Private Helpers
  // ============================================================================

  private async fetchAllClosedPositions(address: string): Promise<ClosedPosition[]> {
    const all: ClosedPosition[] = [];
    let offset = 0;
    const limit = 50;

    for (let i = 0; i < 200; i++) {
      const result = await this.dataApi.getClosedPositions(address, {
        limit,
        offset,
        sortBy: 'TIMESTAMP',
        sortDirection: 'DESC',
      });
      if (result.length === 0) break;
      all.push(...result);
      offset += limit;
      if (result.length < limit) break;
    }

    return all;
  }

  private analyzeCategories(positions: Position[]): Array<{ category: string; positionCount: number; totalPnl: number }> {
    const map: Record<string, { count: number; totalPnl: number }> = {};
    for (const pos of positions) {
      const cat = categorizeMarket(pos.title || '');
      if (!map[cat]) map[cat] = { count: 0, totalPnl: 0 };
      map[cat].count++;
      map[cat].totalPnl += pos.cashPnl ?? 0;
    }
    return Object.entries(map)
      .map(([category, s]) => ({ category, positionCount: s.count, totalPnl: s.totalPnl }))
      .sort((a, b) => b.positionCount - a.positionCount);
  }

  private calculateCategoryBreakdownFromActivities(
    trades: Array<{ title?: string; usdcSize?: number; size: number; price: number }>
  ): CategoryStats[] {
    const map = new Map<MarketCategory, { count: number; volume: number }>();
    for (const t of trades) {
      const cat = categorizeMarket(t.title || '');
      const cur = map.get(cat) || { count: 0, volume: 0 };
      map.set(cat, { count: cur.count + 1, volume: cur.volume + (t.usdcSize || t.size * t.price) });
    }
    const total = trades.length;
    return Array.from(map.entries())
      .map(([category, s]) => ({ category, tradeCount: s.count, volume: s.volume, pnl: 0, percentage: total > 0 ? (s.count / total) * 100 : 0 }))
      .sort((a, b) => b.tradeCount - a.tradeCount);
  }

  private calculateCategoryDistributionFromClosed(positions: ClosedPosition[]): CategoryStats[] {
    const map = new Map<MarketCategory, { count: number; volume: number; pnl: number }>();
    for (const pos of positions) {
      const cat = categorizeMarket(pos.title);
      const cur = map.get(cat) || { count: 0, volume: 0, pnl: 0 };
      map.set(cat, { count: cur.count + 1, volume: cur.volume + pos.totalBought, pnl: cur.pnl + pos.realizedPnl });
    }
    const total = positions.length;
    return Array.from(map.entries())
      .map(([category, s]) => ({ category, tradeCount: s.count, volume: s.volume, pnl: s.pnl, percentage: total > 0 ? (s.count / total) * 100 : 0 }))
      .sort((a, b) => b.tradeCount - a.tradeCount);
  }

  private calculateCategoryDistributionFromPositions(positions: Position[]): CategoryStats[] {
    const map = new Map<MarketCategory, { count: number; volume: number; pnl: number }>();
    for (const pos of positions) {
      const cat = categorizeMarket(pos.title || '');
      const cur = map.get(cat) || { count: 0, volume: 0, pnl: 0 };
      map.set(cat, {
        count: cur.count + 1,
        volume: cur.volume + (pos.currentValue ?? pos.size * (pos.curPrice ?? 0)),
        pnl: cur.pnl + (pos.cashPnl ?? 0),
      });
    }
    const total = positions.length;
    return Array.from(map.entries())
      .map(([category, s]) => ({ category, tradeCount: s.count, volume: s.volume, pnl: s.pnl, percentage: total > 0 ? (s.count / total) * 100 : 0 }))
      .sort((a, b) => b.tradeCount - a.tradeCount);
  }

  private calculatePerformanceMetrics(
    closedPositions: ClosedPosition[],
    currentPositions: Position[]
  ): PerformanceMetrics {
    const wins = closedPositions.filter(p => p.realizedPnl > 0);
    const losses = closedPositions.filter(p => p.realizedPnl < 0);
    const totalWin = wins.reduce((s, p) => s + p.realizedPnl, 0);
    const totalLoss = Math.abs(losses.reduce((s, p) => s + p.realizedPnl, 0));
    const realizedPnL = closedPositions.reduce((s, p) => s + p.realizedPnl, 0);
    const unrealizedPnL = currentPositions.reduce((s, p) => s + (p.cashPnl ?? 0), 0);

    return {
      totalPnL: realizedPnL + unrealizedPnL,
      realizedPnL,
      unrealizedPnL,
      totalVolume: closedPositions.reduce((s, p) => s + p.totalBought, 0),
      winRate: closedPositions.length > 0 ? wins.length / closedPositions.length : 0,
      profitFactor: totalLoss > 0 ? totalWin / totalLoss : totalWin,
      avgWin: wins.length > 0 ? totalWin / wins.length : 0,
      avgLoss: losses.length > 0 ? totalLoss / losses.length : 0,
      maxWin: wins.length > 0 ? Math.max(...wins.map(p => p.realizedPnl)) : 0,
      maxLoss: losses.length > 0 ? Math.max(...losses.map(p => Math.abs(p.realizedPnl))) : 0,
      totalMarketsTraded: closedPositions.length,
      winningMarkets: wins.length,
      losingMarkets: losses.length,
    };
  }

  private getTopMarkets(positions: ClosedPosition[], limit: number): MarketStats[] {
    return positions
      .filter(p => p.realizedPnl > 0)
      .sort((a, b) => b.realizedPnl - a.realizedPnl)
      .slice(0, limit)
      .map(p => ({
        market: p.title,
        conditionId: p.conditionId,
        category: categorizeMarket(p.title),
        pnl: p.realizedPnl,
        volume: p.totalBought,
        tradeCount: 1,
        outcome: 'win' as const,
        avgPrice: p.avgPrice,
        closePrice: p.curPrice,
      }));
  }

  private getWorstMarkets(positions: ClosedPosition[], limit: number): MarketStats[] {
    return positions
      .filter(p => p.realizedPnl < 0)
      .sort((a, b) => a.realizedPnl - b.realizedPnl)
      .slice(0, limit)
      .map(p => ({
        market: p.title,
        conditionId: p.conditionId,
        category: categorizeMarket(p.title),
        pnl: p.realizedPnl,
        volume: p.totalBought,
        tradeCount: 1,
        outcome: 'lose' as const,
        avgPrice: p.avgPrice,
        closePrice: p.curPrice,
      }));
  }

  private analyzeTradingPatterns(
    closedPositions: ClosedPosition[],
    currentPositions: Position[]
  ): TradingPatterns {
    let avgTradesPerDay = 0;
    let avgTradesPerWeek = 0;

    if (closedPositions.length > 0) {
      const timestamps = closedPositions.map(p => p.timestamp);
      const totalDays = Math.max(1, Math.ceil(
        (Math.max(...timestamps) - Math.min(...timestamps)) / (1000 * 60 * 60 * 24)
      ));
      avgTradesPerDay = closedPositions.length / totalDays;
      avgTradesPerWeek = avgTradesPerDay * 7;
    }

    const yesPos = currentPositions.filter(p =>
      p.outcome?.toLowerCase() === 'yes' || p.outcome?.toLowerCase() === 'up'
    );
    const noPos = currentPositions.filter(p =>
      p.outcome?.toLowerCase() === 'no' || p.outcome?.toLowerCase() === 'down'
    );
    let preferredSide: 'YES' | 'NO' | 'balanced' = 'balanced';
    if (yesPos.length > noPos.length * 1.5) preferredSide = 'YES';
    else if (noPos.length > yesPos.length * 1.5) preferredSide = 'NO';

    const avgPositionSize = closedPositions.length > 0
      ? closedPositions.reduce((s, p) => s + p.totalBought, 0) / closedPositions.length
      : 0;

    const categoryStats = this.calculateCategoryDistributionFromClosed(closedPositions);
    const topCategories = categoryStats.slice(0, 3).map(c => c.category);

    const totalValue = currentPositions.reduce((s, p) => s + (p.currentValue ?? p.size * (p.curPrice ?? 0)), 0);
    const maxPositionValue = currentPositions.length > 0
      ? Math.max(...currentPositions.map(p => p.currentValue ?? p.size * (p.curPrice ?? 0)))
      : 0;
    const positionConcentration = totalValue > 0 ? maxPositionValue / totalValue : 0;

    return {
      avgTradesPerDay,
      avgTradesPerWeek,
      preferredSide,
      avgPositionSize,
      avgHoldingDays: 0,
      topCategories,
      positionConcentration,
    };
  }

  private buildPieChart(
    name: string,
    items: Array<{ title: string; value: number }>
  ): PieChartData {
    const map = new Map<MarketCategory, number>();
    for (const item of items) {
      const cat = categorizeMarket(item.title);
      map.set(cat, (map.get(cat) || 0) + item.value);
    }
    const total = Array.from(map.values()).reduce((a, b) => a + b, 0);
    const data: PieSlice[] = Array.from(map.entries())
      .map(([cat, value]) => ({
        name: CATEGORY_LABELS[cat],
        value,
        percentage: total > 0 ? (value / total) * 100 : 0,
        color: CATEGORY_COLORS[cat],
      }))
      .sort((a, b) => b.value - a.value);
    return { name, data, total };
  }

  private buildTextReport(
    address: string,
    report: WalletLifecycleReport,
    _chartData: WalletChartData
  ): string {
    const { performance, categoryDistribution, topMarkets, worstMarkets, currentPositions, dataRange } = report;
    const totalPnL = performance.realizedPnL + currentPositions.unrealizedPnL;
    const fmt = (v: number) => v >= 0 ? `+$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : `-$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const fmtPct = (v: number) => `${(v * 100).toFixed(1)}%`;
    const fmtDate = (d: Date) => d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });

    const sections: string[] = [
      `# Wallet Analysis Report\n`,
      `**Address**: \`${address.slice(0, 10)}...${address.slice(-8)}\``,
      `**Report Date**: ${fmtDate(new Date())}`,
      `**Data Range**: ${fmtDate(dataRange.firstActivityAt)} - ${fmtDate(dataRange.lastActivityAt)} (${dataRange.totalDays} days)\n`,
      `## Executive Summary\n`,
      `| Metric | Value |`,
      `|--------|-------|`,
      `| Total PnL | ${fmt(totalPnL)} |`,
      `| Realized PnL | ${fmt(performance.realizedPnL)} |`,
      `| Unrealized PnL | ${fmt(currentPositions.unrealizedPnL)} |`,
      `| Win Rate | ${fmtPct(performance.winRate)} |`,
      `| Profit Factor | ${performance.profitFactor.toFixed(2)} |`,
      `| Markets Traded | ${performance.totalMarketsTraded} |`,
      `| Current Positions | ${currentPositions.count} |`,
      ``,
      `## Market Category Distribution\n`,
      `| Category | Trades | PnL | Share |`,
      `|----------|--------|-----|-------|`,
      ...categoryDistribution.slice(0, 6).map(cat =>
        `| ${CATEGORY_LABELS[cat.category]} | ${cat.tradeCount} | ${fmt(cat.pnl)} | ${cat.percentage.toFixed(1)}% |`
      ),
    ];

    if (topMarkets.length > 0) {
      sections.push(``, `## Best Performing Markets\n`);
      topMarkets.slice(0, 5).forEach((m, i) => sections.push(`${i + 1}. **${m.market}**: ${fmt(m.pnl)}`));
    }

    if (worstMarkets.length > 0) {
      sections.push(``, `## Worst Performing Markets\n`);
      worstMarkets.slice(0, 5).forEach((m, i) => sections.push(`${i + 1}. **${m.market}**: ${fmt(m.pnl)}`));
    }

    return sections.join('\n');
  }

  private formatDate(date: Date): string {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }
}
