/**
 * Signal Service Types
 *
 * Types for SignalService HTTP client
 */

// ============================================================================
// Core Types (mirrored from SignalWorker)
// ============================================================================

/**
 * Signal types
 */
export type SignalType =
  | 'insider_new'          // New insider wallet discovered
  | 'insider_large_trade'  // Insider wallet large trade
  | 'insider_cluster'      // Multiple insiders trading same market
  | 'market_signal'        // Market-level signal (volume surge, price movement)
  | 'whale_trade';         // Large whale trade detected

/**
 * Signal severity levels
 */
export type SignalSeverity = 'low' | 'medium' | 'high' | 'critical';

/**
 * Signal status
 */
export type SignalStatus = 'active' | 'read' | 'dismissed' | 'expired';

// ============================================================================
// Signal Details Types
// ============================================================================

/**
 * Insider characteristics (simplified for storage)
 */
export interface InsiderCharacteristicsSimple {
  isNewWallet: boolean;
  singleSidedBet: boolean;
  largePosition: boolean;
  shortDepositWindow: boolean;
  walletAgeDays: number;
  returnMultiple: number;
}

/**
 * Details for insider_new signal
 */
export interface InsiderNewDetails {
  insiderScore: number;
  characteristics: InsiderCharacteristicsSimple;
  potentialProfit: number;
  returnMultiple: number;
  markets: string[];
}

/**
 * Details for insider_large_trade signal
 */
export interface InsiderLargeTradeDetails {
  trade: {
    txHash?: string;
    side: 'BUY' | 'SELL';
    outcome: string;
    size: number;
    price: number;
    usdcValue: number;
  };
  insiderScore: number;
  potentialReturn: number;
  returnMultiple: number;
}

/**
 * Details for insider_cluster signal
 */
export interface InsiderClusterDetails {
  wallets: string[];
  totalVolume: number;
  direction: string;
  timeWindow: string;
  avgInsiderScore: number;
}

/**
 * Details for market_signal
 */
export interface MarketSignalDetails {
  signalName: string;
  currentValue: number;
  threshold: number;
  change: number;
  changePercent: number;
}

/**
 * Details for whale_trade signal
 */
export interface WhaleTradeDetails {
  trade: {
    txHash?: string;
    side: 'BUY' | 'SELL';
    outcome: string;
    size: number;
    price: number;
    usdcValue: number;
  };
  traderPnL?: number;
  traderVolume?: number;
}

/**
 * Union type for signal details
 */
export type SignalDetails =
  | InsiderNewDetails
  | InsiderLargeTradeDetails
  | InsiderClusterDetails
  | MarketSignalDetails
  | WhaleTradeDetails;

// ============================================================================
// Signal Types
// ============================================================================

/**
 * Signal summary (list view)
 */
export interface SignalSummary {
  id: string;
  type: SignalType;
  severity: SignalSeverity;
  status: SignalStatus;
  priority: number;
  marketId: string;
  marketTitle?: string;
  wallet?: string;
  walletName?: string;
  title: string;
  description: string;
  createdAt: number;
  readAt?: number;
}

/**
 * Full signal with details
 */
export interface Signal extends SignalSummary {
  details: SignalDetails;
  expiresAt: number;
}

// ============================================================================
// Query Parameters
// ============================================================================

/**
 * Query params for getting signals
 */
export interface GetSignalsParams {
  type?: SignalType;
  severity?: SignalSeverity;
  status?: SignalStatus;
  marketId?: string;
  wallet?: string;
  unreadOnly?: boolean;
  since?: number;
  limit?: number;
  offset?: number;
}

// ============================================================================
// API Response Types
// ============================================================================

/**
 * Health check response
 */
export interface SignalHealthResponse {
  status: 'ok';
  service: string;
  version: string;
  now: number;
  stats: {
    totalSignals: number;
    unreadCount: number;
    bySeverity: Record<SignalSeverity, number>;
  };
}

/**
 * Stats response
 */
export interface SignalStatsResponse {
  totalSignals: number;
  unreadCount: number;
  byType: Record<SignalType, number>;
  bySeverity: Record<SignalSeverity, number>;
  byStatus: Record<SignalStatus, number>;
  oldestSignal: number | null;
  newestSignal: number | null;
}

/**
 * Get signals response
 */
export interface GetSignalsResponse {
  signals: Signal[];
  pagination: {
    total: number;
    unreadCount: number;
    limit: number;
    offset: number;
  };
}

/**
 * Unread count response
 */
export interface UnreadCountResponse {
  count: number;
}

/**
 * Success response
 */
export interface SuccessResponse {
  success: boolean;
  count?: number;
}

/**
 * Signal created response
 */
export interface SignalCreatedResponse {
  created: boolean;
  signal?: Signal;
  reason?: string;
}

/**
 * Process scan response
 */
export interface ProcessScanResponse {
  processed: number;
  signalsCreated: number;
  signals: Signal[];
}

// ============================================================================
// Signal Creation Types
// ============================================================================

/**
 * Params for creating insider new signal
 */
export interface CreateInsiderNewParams {
  wallet: string;
  walletName?: string;
  marketId: string;
  marketTitle: string;
  insiderScore: number;
  characteristics: InsiderCharacteristicsSimple;
  potentialProfit: number;
  returnMultiple: number;
  markets?: string[];
}

/**
 * Params for creating insider large trade signal
 */
export interface CreateInsiderLargeTradeParams {
  wallet: string;
  walletName?: string;
  marketId: string;
  marketTitle: string;
  insiderScore: number;
  trade: {
    txHash?: string;
    side: 'BUY' | 'SELL';
    outcome: string;
    size: number;
    price: number;
    usdcValue: number;
  };
  potentialReturn: number;
  returnMultiple: number;
}

/**
 * Params for creating insider cluster signal
 */
export interface CreateInsiderClusterParams {
  wallets: string[];
  marketId: string;
  marketTitle: string;
  totalVolume: number;
  direction: string;
  timeWindow: string;
  avgInsiderScore: number;
}

/**
 * Params for creating whale trade signal
 */
export interface CreateWhaleTradeParams {
  wallet: string;
  walletName?: string;
  marketId: string;
  marketTitle: string;
  trade: {
    txHash?: string;
    side: 'BUY' | 'SELL';
    outcome: string;
    size: number;
    price: number;
    usdcValue: number;
  };
  traderPnL?: number;
  traderVolume?: number;
}

/**
 * Params for processing insider scan results
 */
export interface ProcessInsiderScanParams {
  marketId: string;
  marketTitle: string;
  candidates: Array<{
    address: string;
    name?: string;
    insiderScore: number;
    characteristics: InsiderCharacteristicsSimple;
    potentialProfit?: number;
    returnMultiple?: number;
  }>;
}
