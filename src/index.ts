/**
 * @catalyst-team/poly-sdk
 *
 * Unified SDK for Polymarket APIs
 * - Data API (positions, activity, trades, leaderboard)
 * - Gamma API (markets, events, trending)
 * - CLOB API (orderbook, market info, trading)
 * - Services (WalletService, MarketService)
 */

// Core infrastructure
export { RateLimiter, ApiType } from './core/rate-limiter.js';
export { Cache, CACHE_TTL } from './core/cache.js';
export { PolymarketError, ErrorCode, withRetry } from './core/errors.js';
export * from './core/types.js';

// Order status utilities
export {
  mapApiStatusToInternal,
  mapInternalStatusToApi,
  isActiveStatus,
  isTerminalStatus,
  isOrderOpen,
  isOrderFilled,
  canOrderBeCancelled,
  calculateOrderProgress,
  isValidStatusTransition,
  getStatusDescription,
} from './core/order-status.js';

// Cache integration (new)
export type { UnifiedCache } from './core/unified-cache.js';
export { createUnifiedCache } from './core/unified-cache.js';

// API Clients
export { DataApiClient } from './clients/data-api.js';
export type {
  Position,
  Activity,
  Trade,
  LeaderboardEntry,
  LeaderboardResult,
  // Leaderboard parameters (supports time period filtering)
  LeaderboardParams,
  LeaderboardTimePeriod,
  LeaderboardOrderBy,
  LeaderboardCategory,
  // P0/P1/P2 Gap Analysis types
  ActivityParams,
  PositionsParams,
  TradesParams,
  HoldersParams,
  AccountValue,
  MarketHolder,
  // Closed positions
  ClosedPosition,
  ClosedPositionsParams,
} from './clients/data-api.js';

export { GammaApiClient } from './clients/gamma-api.js';
export type {
  GammaMarket,
  GammaEvent,
  MarketSearchParams,
} from './clients/gamma-api.js';

// ClobApiClient has been removed - use TradingService instead
// TradingService provides getMarket(), getProcessedOrderbook(), etc.

// Subgraph Client (on-chain data via Goldsky)
export { SubgraphClient, SUBGRAPH_ENDPOINTS } from './clients/subgraph.js';
export type {
  SubgraphName,
  SubgraphQueryParams,
  // Positions Subgraph
  UserBalance,
  NetUserBalance,
  // PnL Subgraph
  UserPosition,
  Condition,
  // Activity Subgraph
  Split,
  Merge,
  Redemption,
  // OI Subgraph
  MarketOpenInterest,
  GlobalOpenInterest,
  // Orderbook Subgraph
  OrderFilledEvent,
  MarketData,
} from './clients/subgraph.js';

// Services
export { WalletService } from './services/wallet-service.js';
export type {
  WalletProfile,
  WalletActivityOptions,
  WalletActivitySummary,
  SellActivityResult,
  // Time-based leaderboard types
  TimePeriod,
  LeaderboardSortBy,
  PeriodLeaderboardEntry,
  PeriodLeaderboardResult,
  WalletPeriodStats,
  // PnL calculation types
  ParsedTrade,
  TokenPosition,
  UserPeriodStats,
} from './services/wallet-service.js';

export { MarketService, getIntervalMs as getIntervalMsService } from './services/market-service.js';
export type { ResolvedMarketTokens } from './services/market-service.js';

// Real-time (V2 - using custom RealTimeDataClient)
export { RealtimeServiceV2 } from './services/realtime-service-v2.js';

// RealTimeDataClient (low-level WebSocket client, use RealtimeServiceV2 for most cases)
export {
  RealTimeDataClient,
  ConnectionStatus,
  type ClobApiKeyCreds,
  type Message as RealTimeMessage,
  type RealTimeDataClientConfig,
  type SubscriptionMessage,
} from './realtime/index.js';
export type {
  RealtimeServiceConfig,
  OrderbookSnapshot,
  LastTradeInfo,
  PriceChange,
  TickSizeChange,
  MarketEvent,
  UserOrder,
  UserTrade,
  ActivityTrade,
  CryptoPrice,
  EquityPrice,
  Comment,
  Reaction,
  RFQRequest,
  RFQQuote,
  Subscription,
  MarketSubscription,
  MarketDataHandlers,
  UserDataHandlers,
  ActivityHandlers,
  CryptoPriceHandlers,
  EquityPriceHandlers,
} from './services/realtime-service-v2.js';

// RealtimeService (legacy) has been removed - use RealtimeServiceV2 instead

// ============================================================================
// Catalyst (Internal Alpha) - query/realtime clients
// ============================================================================

export {
  CatalystQueryService,
  CatalystRealtimeService,
} from './catalyst/index.js';

export type {
  CatalystQueryServiceConfig,
  CatalystRealtimeServiceConfig,
  CatalystWsTopic,
  CatalystWsClientMessage,
  CatalystWsServerMessage,
  CatalystKlineUpdatePayload,
  CatalystDepthUpdatePayload,
  CatalystSpreadSnapshot,
  CatalystKLineInterval,
  CatalystKLineCandle,
  // Query service response types
  CatalystHealthResponse,
  CatalystKlinesResponse,
  CatalystTradesResponse,
  CatalystTradeRecord,
  CatalystOrderbookSnapshotsResponse,
  CatalystOrderbookSnapshot,
  CatalystDepthLineResponse,
} from './catalyst/index.js';

// ============================================================================
// InsiderScan (Internal Alpha) - insider detection service
// ============================================================================

export { InsiderScanService } from './insider-scan/index.js';

export type {
  InsiderScanServiceConfig,
  InsiderScanHealthResponse,
  InsiderCandidateSummary,
  InsiderCandidateDetails,
  GetCandidatesResponse,
  ScanMarketResponse,
  ScanHistoryItem,
  GetScanHistoryResponse,
  InsiderStatsResponse,
  GetCandidatesParams,
  GetScanHistoryParams,
} from './insider-scan/index.js';

// WalletReportService (Client for WalletReportWorker)
// ============================================================================

export { WalletReportService } from './wallet-report/index.js';

export type {
  WalletReportServiceConfig,
  WalletReportHealthResponse,
  WalletReportStatsResponse,
  GetWalletReportResponse,
  ReportGeneratingResponse,
  GetLeaderboardResponse,
  ListReportsResponse,
  ListReportsParams,
  WalletReportData,
  LeaderboardReportData,
  LeaderboardEntry as WalletReportLeaderboardEntry,
  DailyPerformance,
  ReportType,
  ReportStatus,
  ReportSummary,
} from './wallet-report/index.js';

// SignalService (Client for SignalWorker)
// ============================================================================

export { SignalService } from './signal/index.js';

export type {
  SignalServiceConfig,
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
  SuccessResponse as SignalSuccessResponse,
  SignalCreatedResponse,
  ProcessScanResponse,
  // Creation params
  CreateInsiderNewParams,
  CreateInsiderLargeTradeParams,
  CreateInsiderClusterParams,
  CreateWhaleTradeParams,
  ProcessInsiderScanParams,
} from './signal/index.js';

// ArbitrageService (Real-time arbitrage detection, execution, rebalancing, and settlement)
export { ArbitrageService } from './services/arbitrage-service.js';
export type {
  ArbitrageMarketConfig,
  ArbitrageServiceConfig,
  ArbitrageOpportunity as ArbitrageServiceOpportunity,
  ArbitrageExecutionResult,
  ArbitrageServiceEvents,
  OrderbookState,
  BalanceState,
  // Rebalancer types
  RebalanceAction,
  RebalanceResult,
  // Settle types
  SettleResult,
  // Clear position types (smart settle)
  ClearPositionResult,
  ClearAction,
  // Scanning types
  ScanCriteria,
  ScanResult,
} from './services/arbitrage-service.js';

// SmartMoneyService - Smart Money detection and Copy Trading
export {
  SmartMoneyService,
  categorizeMarket,
  CATEGORY_KEYWORDS,
} from './services/smart-money-service.js';
export type {
  SmartMoneyWallet,
  SmartMoneyTrade,
  AutoCopyTradingOptions,
  AutoCopyTradingStats,
  AutoCopyTradingSubscription,
  SmartMoneyServiceConfig,
  // Leaderboard & Report types
  LeaderboardOptions,
  SmartMoneyLeaderboardEntry,
  SmartMoneyLeaderboardResult,
  PeriodRanking,
  WalletReport,
  WalletComparison,
  // Report types (02-smart-money)
  MarketCategory,
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
} from './services/smart-money-service.js';

// DipArbService - Dip Arbitrage for 15m/5m UP/DOWN markets
export { DipArbService } from './services/dip-arb-service.js';
export type {
  DipArbServiceConfig,
  DipArbMarketConfig,
  DipArbRoundState,
  DipArbStats,
  DipArbSignal,
  DipArbLeg1Signal,
  DipArbLeg2Signal,
  DipArbExecutionResult,
  DipArbRoundResult,
  DipArbNewRoundEvent,
  DipArbPriceUpdateEvent,
  DipArbScanOptions,
  DipArbFindAndStartOptions,
  DipArbAutoRotateConfig,
  DipArbSettleResult,
  DipArbRotateEvent,
  DipArbSide,
  DipArbUnderlying,
  DipArbPhase,
  DipArbLegInfo,
} from './services/dip-arb-types.js';

// BinanceService - BTC/ETH/SOL K-line data from Binance
export { BinanceService } from './services/binance-service.js';
export type {
  BinanceKLine,
  BinanceSymbol,
  BinanceInterval,
  BinanceKLineOptions,
} from './services/binance-service.js';

// TradingService - Unified trading and market data
export {
  TradingService,
  POLYGON_MAINNET,
  POLYGON_AMOY,
  // Polymarket order minimum requirements
  MIN_ORDER_VALUE_USDC,
  MIN_ORDER_SIZE_SHARES,
} from './services/trading-service.js';
export type {
  TradingServiceConfig,
  // Order types - Side and OrderType are re-exported from core/types.ts via trading-service.ts
  // They are also exported via `export * from './core/types.js'` above
  ApiCredentials,
  LimitOrderParams,
  MarketOrderParams,
  // Results
  Order,
  OrderResult,
  TradeInfo,
  // Rewards
  UserEarning,
  MarketReward,
  // Enhanced rewards types (Q-Score optimization)
  MarketRewardConfig,
  QScoreParams,
  QScoreEstimate,
  RewardsSummary,
  TopRewardMarket,
} from './services/trading-service.js';

// CTFManager - CTF operations + event monitoring (Recommended)
export { CTFManager } from './services/ctf-manager.js';
export type {
  CTFManagerConfig,
  CTFEvent,
  SplitEvent,
  MergeEvent,
  RedeemEvent,
  CTFOperationType as CTFManagerOperationType,
} from './services/ctf-manager.js';

// OrderManager - Unified order creation + lifecycle monitoring
export { OrderManager, OrderHandleImpl } from './services/order-manager.js';
export type {
  OrderManagerConfig,
  OrderMetadata,
  // Event types
  OrderStatusChangeEvent,
  FillEvent,
  TransactionEvent,
  SettlementEvent,
  CancelEvent,
  ExpireEvent,
  RejectEvent,
  // OrderHandle types
  OrderHandleStatus,
  OrderFinalResult,
  OrderHandle,
} from './services/order-manager.js';

// Market types from MarketService
// Note: Side and Orderbook are now in core/types.ts (exported via `export * from './core/types.js'` above)
export type {
  Market,
  MarketToken,
  PricePoint,
  PriceHistoryParams,
  PriceHistoryIntervalString,
} from './services/market-service.js';

// TradingClient (legacy) has been removed - use TradingService instead
// TradingService provides all trading functionality with proper type exports

// CTF (Conditional Token Framework)
// NOTE: USDC_CONTRACT is USDC.e (bridged), required for Polymarket CTF
// NATIVE_USDC_CONTRACT is native USDC, NOT compatible with CTF
export {
  CTFClient,
  CTF_CONTRACT,
  USDC_CONTRACT,           // USDC.e (0x2791...) - Required for CTF
  NATIVE_USDC_CONTRACT,    // Native USDC (0x3c49...) - NOT for CTF
  NEG_RISK_CTF_EXCHANGE,
  NEG_RISK_ADAPTER,
  USDC_DECIMALS,
  calculateConditionId,
  parseUsdc,
  formatUsdc,
} from './clients/ctf-client.js';
export type {
  CTFConfig,
  SplitResult,
  MergeResult,
  RedeemResult,
  PositionBalance,
  MarketResolution,
  GasEstimate,
  TransactionStatus,
  TokenIds,
} from './clients/ctf-client.js';
export { RevertReason } from './clients/ctf-client.js';

// Bridge (Cross-chain Deposits)
export {
  BridgeClient,
  SUPPORTED_CHAINS,
  BRIDGE_TOKENS,
  estimateBridgeOutput,
  getExplorerUrl,
  depositUsdc,
  swapAndDeposit,
  getSupportedDepositTokens,
} from './clients/bridge-client.js';
export type {
  BridgeSupportedAsset,
  DepositAddress,
  CreateDepositResponse,
  // New deposit status types (from Bridge API /status endpoint)
  DepositStatusType,
  DepositTransaction,
  DepositStatusResponse,
  // Legacy (deprecated)
  DepositStatus,
  BridgeConfig,
  DepositResult,
  DepositOptions,
  SwapAndDepositOptions,
  SwapAndDepositResult,
} from './clients/bridge-client.js';

// Swap Service (DEX swaps on Polygon)
export {
  SwapService,
  QUICKSWAP_ROUTER,
  POLYGON_TOKENS,
  TOKEN_DECIMALS,
} from './services/swap-service.js';
export type {
  SupportedToken,
  SwapQuote,
  SwapResult,
  TokenBalance,
  TransferResult,
} from './services/swap-service.js';

// Authorization (ERC20/ERC1155 Approvals)
export { AuthorizationService } from './services/authorization-service.js';
export type {
  AllowanceInfo,
  AllowancesResult,
  ApprovalTxResult,
  ApprovalsResult,
  AuthorizationServiceConfig,
} from './services/authorization-service.js';

// OnchainService (Unified on-chain operations: CTF + Authorization + Swaps)
export { OnchainService } from './services/onchain-service.js';
export type {
  OnchainServiceConfig,
  ReadyStatus,
  TokenBalances,
} from './services/onchain-service.js';

// Price Utilities
export {
  roundPrice,
  roundSize,
  validatePrice,
  validateSize,
  calculateBuyAmount,
  calculateSellPayout,
  calculateSharesForAmount,
  calculateSpread,
  calculateMidpoint,
  formatPrice,
  formatUSDC,
  calculatePnL,
  checkArbitrage,
  getEffectivePrices,
  ROUNDING_CONFIG,
} from './utils/price-utils.js';
export type { TickSize } from './utils/price-utils.js';

// Wallet Management (Hot Wallet for automated trading)
export {
  HotWalletService,
  // PrivyWallet, // Disabled: requires @privy-io/server-auth
} from './wallets/index.js';
export type {
  HotWalletServiceConfig,
  IWalletStore,
  WalletInfo,
  EncryptedData,
  // PrivyWalletConfig, // Disabled: requires @privy-io/server-auth
  // TransactionRequest as WalletTransactionRequest,
  // TransactionResult as WalletTransactionResult,
  // SignatureResult,
} from './wallets/index.js';

// NOTE: MCP tools have been moved to @catalyst-team/poly-mcp package
// See packages/poly-mcp/

// ===== Main SDK Class =====

import { RateLimiter } from './core/rate-limiter.js';
import { DataApiClient } from './clients/data-api.js';
import { GammaApiClient } from './clients/gamma-api.js';
import { SubgraphClient } from './clients/subgraph.js';
import { WalletService } from './services/wallet-service.js';
import { MarketService } from './services/market-service.js';
import { TradingService } from './services/trading-service.js';
import { RealtimeServiceV2 } from './services/realtime-service-v2.js';
import { SmartMoneyService } from './services/smart-money-service.js';
import { BinanceService } from './services/binance-service.js';
import { DipArbService } from './services/dip-arb-service.js';
import type { UnifiedMarket, ProcessedOrderbook, ArbitrageOpportunity, KLineInterval, KLineCandle, DualKLineData, PolySDKOptions } from './core/types.js';
import { createUnifiedCache, type UnifiedCache } from './core/unified-cache.js';

// Re-export for backward compatibility
export interface PolymarketSDKConfig extends PolySDKOptions {}

export class PolymarketSDK {
  // Infrastructure
  private rateLimiter: RateLimiter;
  private cache: UnifiedCache;

  // API Clients
  public readonly dataApi: DataApiClient;
  public readonly gammaApi: GammaApiClient;
  public readonly tradingService: TradingService;
  public readonly subgraph: SubgraphClient;

  // Services
  public readonly wallets: WalletService;
  public readonly markets: MarketService;
  public readonly realtime: RealtimeServiceV2;
  public readonly smartMoney: SmartMoneyService;
  public readonly binance: BinanceService;
  public readonly dipArb: DipArbService;

  // Initialization state
  private _initialized = false;

  constructor(config: PolymarketSDKConfig = {}) {
    // Initialize infrastructure
    this.rateLimiter = new RateLimiter();

    // Create unified cache (supports both legacy Cache and CacheAdapter)
    this.cache = createUnifiedCache(config.cache);

    // Initialize API clients
    this.dataApi = new DataApiClient(this.rateLimiter, this.cache);
    this.gammaApi = new GammaApiClient(this.rateLimiter, this.cache);

    // TradingService requires a private key - use provided key or dummy key for read-only
    const privateKey = config.privateKey || '0x' + '1'.repeat(64);
    this.tradingService = new TradingService(this.rateLimiter, this.cache, {
      privateKey,
      chainId: config.chainId,
      credentials: config.creds,
    });

    this.subgraph = new SubgraphClient(this.rateLimiter, this.cache);

    // Initialize services
    this.wallets = new WalletService(this.dataApi, this.subgraph, this.cache);
    this.binance = new BinanceService(this.rateLimiter, this.cache);
    this.markets = new MarketService(this.gammaApi, this.dataApi, this.rateLimiter, this.cache, undefined, this.binance);
    this.realtime = new RealtimeServiceV2();
    this.smartMoney = new SmartMoneyService(
      this.wallets,
      this.realtime,
      this.tradingService,
      {},  // default config
      this.dataApi  // pass dataApi for report generation
    );

    // Initialize DipArbService
    this.dipArb = new DipArbService(
      this.realtime,
      this.tradingService,
      this.markets,
      config.privateKey,
      config.chainId
    );
  }

  // ===== Static Factory Methods =====

  /**
   * Create and initialize SDK in one call
   *
   * @example
   * ```typescript
   * const sdk = await PolymarketSDK.create({ privateKey: '...' });
   * // Ready to trade and track smart money
   * ```
   */
  static async create(config: PolymarketSDKConfig = {}): Promise<PolymarketSDK> {
    const sdk = new PolymarketSDK(config);
    await sdk.start();
    return sdk;
  }

  // ===== Lifecycle Methods =====

  /**
   * Initialize the SDK (required for trading operations)
   */
  async initialize(): Promise<void> {
    if (this._initialized) return;
    await this.tradingService.initialize();
    this._initialized = true;
  }

  /**
   * Check if SDK is initialized
   */
  isInitialized(): boolean {
    return this._initialized;
  }

  /**
   * Start SDK - initialize trading + connect WebSocket
   *
   * One method to do everything:
   * - Initialize trading service (derive API credentials)
   * - Connect WebSocket
   * - Wait for connection
   *
   * @example
   * ```typescript
   * const sdk = new PolymarketSDK({ privateKey: '...' });
   * await sdk.start();
   * // Ready to use
   * ```
   */
  async start(options: { timeout?: number } = {}): Promise<void> {
    await this.initialize();
    this.connect();
    await this.waitForConnection(options.timeout ?? 10000);
  }

  /**
   * Connect to realtime WebSocket (required for smart money tracking)
   */
  connect(): void {
    this.realtime.connect();
  }

  /**
   * Wait for WebSocket connection
   */
  async waitForConnection(timeoutMs: number = 10000): Promise<void> {
    // Already connected
    if (this.realtime.isConnected?.()) {
      return;
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Connection timeout')), timeoutMs);
      this.realtime.once('connected', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  /**
   * Stop SDK - disconnect all services and clean up
   */
  stop(): void {
    this.dipArb.stop();
    this.smartMoney.disconnect();
    this.realtime.disconnect();
  }

  /**
   * Disconnect all services and clean up
   * @deprecated Use stop() instead
   */
  disconnect(): void {
    this.stop();
  }

  // ===== Unified Market Access =====

  /**
   * Get market by slug or condition ID
   * Delegates to MarketService which handles merging Gamma and CLOB data
   */
  async getMarket(identifier: string): Promise<UnifiedMarket> {
    return this.markets.getMarket(identifier);
  }

  // ===== Orderbook Analysis =====

  /**
   * Get processed orderbook with analytics
   */
  async getOrderbook(conditionId: string): Promise<ProcessedOrderbook> {
    return this.markets.getProcessedOrderbook(conditionId);
  }

  /**
   * Detect arbitrage opportunity
   *
   * 使用有效价格计算套利机会（正确考虑镜像订单）
   * 详细文档见: docs/01-polymarket-orderbook-arbitrage.md
   */
  async detectArbitrage(
    conditionId: string,
    threshold = 0.005
  ): Promise<ArbitrageOpportunity | null> {
    const orderbook = await this.getOrderbook(conditionId);
    const { effectivePrices, longArbProfit, shortArbProfit } = orderbook.summary;

    if (longArbProfit > threshold) {
      return {
        type: 'long',
        profit: longArbProfit,
        action: `Buy YES @ ${effectivePrices.effectiveBuyYes.toFixed(4)} + Buy NO @ ${effectivePrices.effectiveBuyNo.toFixed(4)}, merge for 1 USDC`,
        expectedProfit: longArbProfit,
      };
    }

    if (shortArbProfit > threshold) {
      return {
        type: 'short',
        profit: shortArbProfit,
        action: `Split 1 USDC, Sell YES @ ${effectivePrices.effectiveSellYes.toFixed(4)} + Sell NO @ ${effectivePrices.effectiveSellNo.toFixed(4)}`,
        expectedProfit: shortArbProfit,
      };
    }

    return null;
  }

  // ===== Cache Management =====

  /**
   * Clear all cached data
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Invalidate cache for a specific market
   */
  invalidateMarketCache(conditionId: string): void {
    this.cache.invalidate(conditionId);
  }
}
