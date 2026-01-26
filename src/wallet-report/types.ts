/**
 * WalletReport Service Types
 *
 * Types for querying the WalletReportWorker API
 */

// ============================================================================
// Report Types
// ============================================================================

/**
 * Report type identifiers
 */
export type ReportType = 'wallet' | 'leaderboard_daily' | 'leaderboard_weekly' | 'leaderboard_monthly';

/**
 * Report status
 */
export type ReportStatus = 'pending' | 'generating' | 'completed' | 'failed';

/**
 * Daily performance entry
 */
export interface DailyPerformance {
  date: string;
  pnl: number;
  volume: number;
  tradeCount: number;
  winRate: number;
}

/**
 * Wallet report data structure
 */
export interface WalletReportData {
  address: string;
  displayName?: string;
  metrics: {
    totalPnL: number;
    totalVolume: number;
    winRate: number;
    tradeCount: number;
    avgHoldingDays: number;
    bestTrade: number;
    worstTrade: number;
  };
  recentPerformance: DailyPerformance[];
  marketBreakdown: {
    category: string;
    volume: number;
    pnl: number;
    tradeCount: number;
  }[];
  topPositions: {
    marketTitle: string;
    conditionId: string;
    size: number;
    avgPrice: number;
    currentPrice: number;
    unrealizedPnL: number;
  }[];
  generatedAt: number;
}

/**
 * Leaderboard entry
 */
export interface LeaderboardEntry {
  rank: number;
  address: string;
  displayName?: string;
  pnl: number;
  volume: number;
  winRate: number;
  tradeCount: number;
  rankChange: number | null;
}

/**
 * Leaderboard report data structure
 */
export interface LeaderboardReportData {
  period: 'daily' | 'weekly' | 'monthly';
  periodStart: string;
  periodEnd: string;
  entries: LeaderboardEntry[];
  stats: {
    totalTraders: number;
    totalVolume: number;
    totalPnL: number;
    avgWinRate: number;
  };
  generatedAt: number;
}

// ============================================================================
// API Response Types
// ============================================================================

/**
 * Health response
 */
export interface WalletReportHealthResponse {
  status: string;
  service: string;
  version: string;
  now: number;
  stats: {
    totalReports: number;
    byType: {
      wallet: number;
      leaderboard_daily: number;
      leaderboard_weekly: number;
      leaderboard_monthly: number;
    };
    byStatus: {
      pending: number;
      generating: number;
      completed: number;
      failed: number;
    };
    schedulerEnabled: boolean;
  };
}

/**
 * Stats response
 */
export interface WalletReportStatsResponse {
  totalReports: number;
  byType: {
    wallet: number;
    leaderboard_daily: number;
    leaderboard_weekly: number;
    leaderboard_monthly: number;
  };
  byStatus: {
    pending: number;
    generating: number;
    completed: number;
    failed: number;
  };
  oldestReport: number | null;
  newestReport: number | null;
}

/**
 * Wallet report response
 */
export interface GetWalletReportResponse {
  source: 'cache' | 'generated';
  report: WalletReportData;
}

/**
 * Report generating response
 */
export interface ReportGeneratingResponse {
  status: 'generating';
  message: string;
  reportId: string;
}

/**
 * Leaderboard response
 */
export interface GetLeaderboardResponse {
  identifier: string;
  report: LeaderboardReportData | null;
  createdAt: number;
  expiresAt: number;
}

/**
 * Report summary (list view)
 */
export interface ReportSummary {
  id: string;
  type: ReportType;
  status: ReportStatus;
  identifier: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  hasData: boolean;
  error: string | null;
}

/**
 * List reports response
 */
export interface ListReportsResponse {
  reports: ReportSummary[];
  pagination: {
    limit: number;
    offset: number;
  };
}

// ============================================================================
// Query Parameters
// ============================================================================

/**
 * List reports params
 */
export interface ListReportsParams {
  type?: ReportType;
  status?: ReportStatus;
  limit?: number;
  offset?: number;
}
