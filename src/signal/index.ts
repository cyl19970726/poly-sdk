/**
 * Signal Service
 *
 * HTTP client for SignalWorker
 */

export { SignalService, type SignalServiceConfig } from './signal-service.js';

export type {
  // Core types
  SignalType,
  SignalSeverity,
  SignalStatus,
  // Signal details
  InsiderCharacteristicsSimple,
  InsiderNewDetails,
  InsiderLargeTradeDetails,
  InsiderClusterDetails,
  MarketSignalDetails,
  WhaleTradeDetails,
  SignalDetails,
  // Signal types
  SignalSummary,
  Signal,
  // Query params
  GetSignalsParams,
  // API responses
  SignalHealthResponse,
  SignalStatsResponse,
  GetSignalsResponse,
  UnreadCountResponse,
  SuccessResponse,
  SignalCreatedResponse,
  ProcessScanResponse,
  // Creation params
  CreateInsiderNewParams,
  CreateInsiderLargeTradeParams,
  CreateInsiderClusterParams,
  CreateWhaleTradeParams,
  ProcessInsiderScanParams,
} from './types.js';
