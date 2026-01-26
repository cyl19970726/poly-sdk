/**
 * InsiderScan Service Types
 *
 * Types for querying the InsiderScanWorker API
 */

// ============================================================================
// Core Types (inlined from @catalyst-team/smart-money)
// ============================================================================

/**
 * Market type
 */
export type MarketType = 'political' | 'crypto' | 'sports' | 'other';

/**
 * Insider suspicion level
 */
export type InsiderLevel = 'critical' | 'high' | 'medium' | 'low';

/**
 * Insider characteristics details
 */
export interface InsiderCharacteristics {
  // Original features
  isNewWallet: boolean;
  hasNoHistory: boolean;
  singleSidedBet: boolean;
  largePosition: boolean;
  timingSensitive: boolean;

  // New features from case studies
  shortDepositWindow: boolean;
  lowPriceSensitivity: boolean;
  twoPhasePattern: boolean;

  // Detail data
  walletAgeDays: number;
  totalTradeCount: number;
  maxSingleTradeUsd: number;
  yesBetRatio: number;
  hoursBeforeEvent?: number;

  // New detail data
  depositToTradeMinutes?: number;
  priceStandardDeviation?: number;
  hasFailedTrades?: boolean;
  successAfterFailure?: boolean;

  // Bonus factors
  returnMultiple: number;
  marketType: MarketType;
  crossChainCorrelation?: number;
  domainCount?: number;
}

/**
 * Suspicious trade record
 */
export interface SuspiciousTrade {
  txHash?: string;
  timestamp: number;
  conditionId: string;
  marketTitle: string;
  side: 'BUY' | 'SELL';
  outcome: string;
  size: number;
  price: number;
  usdcValue: number;
  suspiciousReasons: string[];
  potentialReturn: number;
  returnMultiple: number;
}

// ============================================================================
// API Response Types
// ============================================================================

/**
 * Health response from InsiderScanWorker
 */
export interface InsiderScanHealthResponse {
  status: string;
  service: string;
  version: string;
  now: number;
  stats: {
    totalCandidates: number;
    criticalCount: number;
    highCount: number;
    mediumCount: number;
    lowCount: number;
    lastScanAt: number | null;
    totalScans: number;
  };
}

/**
 * Candidate summary (list view)
 */
export interface InsiderCandidateSummary {
  address: string;
  displayName?: string;
  insiderScore: number;
  level: InsiderLevel;
  levelColor: string;
  levelDescription: string;
  totalVolume: number;
  potentialProfit: number;
  markets: number;
  walletAgeDays: number;
  analyzedAt: number;
  tags: string[];
}

/**
 * Full candidate details
 */
export interface InsiderCandidateDetails extends InsiderCandidateSummary {
  characteristics: InsiderCharacteristics;
  suspiciousTrades: SuspiciousTrade[];
  marketsList: string[];
  firstSeen: number;
  lastActivity: number;
  analyzedBy: 'scanner' | 'manual' | 'agent';
}

/**
 * Get candidates response
 */
export interface GetCandidatesResponse {
  candidates: InsiderCandidateSummary[];
  pagination: {
    limit: number;
    offset: number;
    total: number;
  };
  filters: {
    minScore: number;
    maxScore: number;
    level?: InsiderLevel;
    market?: string;
    sortBy: string;
    sortOrder: string;
  };
}

/**
 * Scan result
 */
export interface ScanMarketResponse {
  conditionId: string;
  marketTitle: string;
  tradesAnalyzed: number;
  walletsScanned: number;
  candidatesFound: number;
  highScoreCount: number;
  durationMs: number;
  candidates: Array<{
    address: string;
    insiderScore: number;
    level: InsiderLevel;
    levelColor: string;
    totalVolume: number;
    potentialProfit: number;
  }>;
}

/**
 * Scan history record
 */
export interface ScanHistoryItem {
  id: string;
  conditionId: string;
  marketTitle: string;
  tradesAnalyzed: number;
  walletsScanned: number;
  candidatesFound: number;
  highScoreCount: number;
  durationMs: number;
  scannedAt: number;
}

/**
 * Scan history response
 */
export interface GetScanHistoryResponse {
  history: ScanHistoryItem[];
  pagination: {
    limit: number;
    offset: number;
  };
}

/**
 * Statistics response
 */
export interface InsiderStatsResponse {
  candidates: {
    total: number;
    byLevel: {
      critical: number;
      high: number;
      medium: number;
      low: number;
    };
  };
  scans: {
    total: number;
    lastScanAt: number | null;
  };
  thresholds: {
    critical: number;
    high: number;
    medium: number;
    low: number;
  };
}

// ============================================================================
// Query Parameters
// ============================================================================

export interface GetCandidatesParams {
  minScore?: number;
  maxScore?: number;
  level?: InsiderLevel;
  market?: string;
  sortBy?: 'score' | 'analyzedAt' | 'potentialProfit' | 'totalVolume';
  sortOrder?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export interface GetScanHistoryParams {
  conditionId?: string;
  limit?: number;
  offset?: number;
}
