/**
 * smart-money/index.ts
 *
 * Re-exports all symbols from the smart-money module.
 * Also re-exports SmartMoneyService for backward compatibility.
 */

// Types
export type {
  MarketCategory,
  SmartMoneyWallet,
  SmartMoneyTrade,
  AutoCopyTradingOptions,
  AutoCopyTradingStats,
  AutoCopyTradingSubscription,
  SmartMoneyServiceConfig,
  LeaderboardOptions,
  SmartMoneyLeaderboardEntry,
  SmartMoneyLeaderboardResult,
  PeriodRanking,
  WalletReport,
  WalletComparison,
  DailySummary,
  CategoryStats,
  TradeRecord,
  PositionSummary,
  ClosedMarketSummary,
  DailyWalletReport,
  DataRange,
  PerformanceMetrics,
  MarketStats,
  TradingPatterns,
  CurrentPositionsSummary,
  WalletLifecycleReport,
  PieSlice,
  PieChartData,
  BarItem,
  BarChartData,
  MonthlyPnLItem,
  MonthlyPnLData,
  ChartMetadata,
  WalletChartData,
  ReportProgressCallback,
  LifecycleReportOptions,
  TextReport,
  PositionDiff,
  OrderRequest,
  TradeEvent,
  MonitorOptions,
} from './types.js';

// Constants
export { CATEGORY_KEYWORDS } from './constants.js';
export { categorizeMarket } from './constants.js';
export { CATEGORY_COLORS, CATEGORY_LABELS } from './types.js';

// V2 Modules
export { PositionTracker, CopyEngine } from './copy.js';
export { TradeMonitor } from './monitor.js';
export { SmartMoneyCore } from './core.js';
export { WalletReports } from './reports.js';
