/**
 * TradingService
 *
 * Trading service using official @polymarket/clob-client-v2 (CLOB V2).
 *
 * Provides:
 * - Order creation (limit, market)
 * - Order management (cancel, query)
 * - Rewards tracking
 * - Balance management
 *
 * Important: Polymarket enforces minimum order requirements:
 * - Minimum order size: 5 shares (MIN_ORDER_SIZE_SHARES)
 * - Minimum order value: $1 pUSD notional (MIN_ORDER_VALUE_USDC, legacy name)
 * Orders below these limits are validated and rejected before sending to API.
 *
 * Note: Market data methods have been moved to MarketService.
 *
 * V2 migration notes:
 * - Constructor switched from positional args to options-bag (`{ host, chain, ... }`).
 * - `builderConfig` content changed from HMAC three-tuple to `{ builderCode }`.
 * - Order struct now embeds `timestamp(ms)` / `metadata(bytes32)` / `builder(bytes32)`
 *   in place of `nonce` / `feeRateBps` / `taker` — the SDK populates these
 *   fields internally; callers only forward `expiration` and `builderCode`
 *   (the latter via `builderConfig`).
 * - HMAC creds (`@polymarket/builder-signing-sdk`) are still used by RelayerService
 *   for gasless TX envelopes; only the *order signing* path swaps to builderCode.
 */

import * as http from 'node:http';
import * as https from 'node:https';
import {
  ClobClient,
  Side as ClobSide,
  OrderType as ClobOrderType,
  Chain,
  SignatureTypeV2,
  type SignedOrder,
  type OpenOrder,
  type Trade as ClobTrade,
  type TickSize,
} from '@polymarket/clob-client-v2';

import { Wallet } from 'ethers';
import {
  isActiveBuilderCode,
  readBuilderCode,
  readBuilderCodeOptional,
  ZERO_BUILDER_CODE,
} from '../constants/builder-config.js';
import { RateLimiter, ApiType } from '../core/rate-limiter.js';
import type { UnifiedCache } from '../core/unified-cache.js';
import { CACHE_TTL } from '../core/unified-cache.js';
import { PolymarketError, ErrorCode } from '../core/errors.js';
import { createModuleLogger, type Logger } from '../core/logger.js';
import type { Side, OrderType, PolymarketSignatureType } from '../core/types.js';
import {
  estimateOrderFees as estimateOrderFeesPure,
  estimateBinaryArbitrageFees as estimateBinaryArbitrageFeesPure,
  type BinaryArbitrageFeeEstimate,
  type FeeSide,
  type LiquidityRole,
  type OrderFeeEstimate,
} from '../utils/price-utils.js';

const log = createModuleLogger('trading-service');
import { OrderStatus } from '../core/types.js';
import {
  mapApiStatusToInternal,
  isOrderOpen,
  canOrderBeCancelled,
  calculateOrderProgress,
} from '../core/order-status.js';
import type { DataApiClient } from '../clients/data-api.js';

// Chain IDs
export const POLYGON_MAINNET = 137;
export const POLYGON_AMOY = 80002;

// CLOB Host
const CLOB_HOST = 'https://clob.polymarket.com';

let clobHttpKeepAliveConfigured = false;

function configureClobHttpKeepAlive(logger: Logger): void {
  if (clobHttpKeepAliveConfigured) return;
  clobHttpKeepAliveConfigured = true;

  const httpAgent = http.globalAgent as http.Agent & { keepAlive: boolean; keepAliveMsecs: number };
  const httpsAgent = https.globalAgent as https.Agent & { keepAlive: boolean; keepAliveMsecs: number };
  httpAgent.keepAlive = true;
  httpAgent.keepAliveMsecs = 30_000;
  httpsAgent.keepAlive = true;
  httpsAgent.keepAliveMsecs = 30_000;

  logger.info('Configured CLOB HTTP keep-alive', {
    httpKeepAlive: true,
    httpsKeepAlive: true,
    keepAliveMsecs: 30_000,
  });
}

function signatureTypeName(value: number | undefined): string {
  if (value === SignatureTypeV2.POLY_GNOSIS_SAFE) return 'POLY_GNOSIS_SAFE';
  if (value === SignatureTypeV2.POLY_1271) return 'POLY_1271';
  if (value === SignatureTypeV2.EOA || value == null) return 'EOA';
  return String(value);
}

// ============================================================================
// Polymarket Order Minimums
// ============================================================================
// These are enforced by Polymarket's CLOB API. Orders below these limits will
// be rejected with errors like:
// - "invalid amount for a marketable BUY order ($X), min size: $1"
// - "Size (X) lower than the minimum: 5"
//
// NOTE: minimum_order_size is MARKET-SPECIFIC (retrieved via CLOB API):
// - SOL/BTC/ETH 15-minute markets: 5 shares
// - Sports markets: 15 shares
// - Some markets: 0 shares
// Use LimitOrderParams.minimumOrderSize to pass the market-specific value.
//
// Strategies should ensure orders meet these requirements BEFORE sending.
// ============================================================================

/** Minimum order value in pUSD notional (price * size >= MIN_ORDER_VALUE). */
export const MIN_ORDER_VALUE_USDC = 1;

/** Default minimum order size in shares (fallback if market-specific value not provided) */
export const MIN_ORDER_SIZE_SHARES = 5;

// ============================================================================
// Types
// ============================================================================

// Side and OrderType are imported from core/types.ts
// Re-export for backward compatibility
export type { Side, OrderType } from '../core/types.js';

export interface ApiCredentials {
  key: string;
  secret: string;
  passphrase: string;
}

export interface TradingServiceConfig {
  /** Private key for signing */
  privateKey: string;
  /** Chain ID (default: Polygon mainnet 137) */
  chainId?: number;
  /** Polymarket signature type. Use 1 for Magic / Email login. */
  signatureType?: PolymarketSignatureType;
  /** Polymarket profile / funder address. Required with signatureType 1. */
  funderAddress?: string;
  /** Pre-generated API credentials (optional) */
  credentials?: ApiCredentials;
  /**
   * V2 builder code (bytes32). When provided, every order signed by this
   * service is attributed to this code on-chain. Falls back to the
   * `POLY_BUILDER_CODE` env var when omitted.
   *
   * Required for any order placement path; throws at `initialize()` if neither
   * config nor env supplies a valid code.
   *
   * Note: replaces the V1 `builderCreds` HMAC three-tuple. HMAC creds are
   * still consumed by `RelayerService` for gasless TX envelopes; they are
   * NOT used by V2 order signing.
   */
  builderCode?: string;
  /**
   * Gnosis Safe address — required for Builder mode so orders use Safe as
   * maker/funder. Setting this together with a builder code switches the
   * signature type to `POLY_GNOSIS_SAFE` (matches V1 behaviour).
   */
  safeAddress?: string;
  /**
   * Explicit CLOB wallet mode for non-Safe accounts. Builder/Safe remains the
   * default when `safeAddress` is present. Deposit wallet mode signs with the
   * owner EOA and uses the derived deposit wallet as maker/funder with
   * POLY_1271 signatures.
   */
  walletMode?: 'builder_safe' | 'eoa' | 'deposit_wallet';
  /** Data API client — required for clearPosition() to fetch size internally */
  dataApi?: DataApiClient;
  /**
   * Optional structured logger — when injected, replaces the module-scope
   * `createModuleLogger('trading-service')` for THIS instance's diagnostic
   * output (`TradingService V2 initialized`, `EIP-712 V2 domain`,
   * `Order missing side field`). Without this, those messages route through
   * poly-sdk's `_logger` which (post-Fix-F, 2026-05-08) defaults to console
   * but used to be a silent no-op until any host called `setLogger()`.
   *
   * Recommended for any host that wants TradingService events tagged with
   * its own logger (e.g. trading-engine's `LiveOrderExecutor`, market-data
   * worker). Fix-G for task-fix-market-data-ws-subscribe.
   */
  logger?: Logger;
}

// Order types
export interface LimitOrderParams {
  tokenId: string;
  side: Side;
  price: number;
  size: number;
  orderType?: 'GTC' | 'GTD';
  expiration?: number;
  /**
   * Submit as post-only so the order can only rest on the book as maker.
   * CLOB rejects post-only orders that would cross the spread.
   */
  postOnly?: boolean;
  /** Market-specific minimum order size (from CLOB API). Falls back to MIN_ORDER_SIZE_SHARES if not provided. */
  minimumOrderSize?: number;
  /** Optional hot-path metadata from WS/orderbook cache. Avoids REST /tick-size during order submission. */
  tickSize?: TickSize;
  /** Optional hot-path metadata from market cache. Avoids REST /neg-risk during order submission. */
  negRisk?: boolean;
}

export interface MarketOrderParams {
  tokenId: string;
  side: Side;
  amount: number;
  price?: number;
  orderType?: 'FOK' | 'FAK';
  /** Optional hot-path metadata from WS/orderbook cache. Avoids REST /tick-size during order submission. */
  tickSize?: TickSize;
  /** Optional hot-path metadata from market cache. Avoids REST /neg-risk during order submission. */
  negRisk?: boolean;
}

export interface PrepareMarketMetadataParams {
  conditionId: string;
  tokenIds: string[];
  /** Optional hot-path metadata from WS/orderbook cache. */
  tickSize?: TickSize;
  /** Optional market-level negRisk flag. */
  negRisk?: boolean;
}

export interface PrepareMarketMetadataResult {
  success: boolean;
  conditionId: string;
  tokenCount: number;
  latencyMs: number;
  marketInfoMs?: number;
  builderFeeMs?: number;
  versionMs?: number;
  errorMsg?: string;
}

export interface MarketFeeInfo {
  /** CLOB market fee rate, e.g. 0.07 for crypto markets. */
  rate: number;
  /** Fee curve exponent from CLOB market info; current V2 markets use 1. */
  exponent: number;
  /** Whether platform fees apply only to taker fills. */
  takerOnly: boolean;
  /** Builder maker fee in basis points, if a builder code is attached. */
  builderMakerFeeBps: number;
  /** Builder taker fee in basis points, if a builder code is attached. */
  builderTakerFeeBps: number;
  source: 'clob_market_info';
}

export interface EstimateOrderFeesParams {
  tokenId: string;
  /** Optional condition ID. Passing it avoids an extra token->condition lookup. */
  conditionId?: string;
  side: FeeSide;
  price: number;
  size: number;
  /** Defaults to taker, because marketable orders remove liquidity. */
  liquidityRole?: LiquidityRole;
}

export interface EstimateOrderFeesResult extends OrderFeeEstimate {
  tokenId: string;
  conditionId?: string;
  feeInfo: MarketFeeInfo;
}

export interface EstimateBinaryArbitrageFeesParams {
  conditionId: string;
  yesTokenId: string;
  noTokenId: string;
  type: 'long' | 'short';
  size: number;
  yesPrice: number;
  noPrice: number;
  liquidityRole?: LiquidityRole;
}

export interface EstimateBinaryArbitrageFeesResult extends BinaryArbitrageFeeEstimate {
  conditionId: string;
  yesTokenId: string;
  noTokenId: string;
  feeInfo: MarketFeeInfo;
}

/** Parameters for clearing a token position (market sell) */
export interface ClearPositionParams {
  tokenId: string;
  /** Min accept price (with slippage applied) */
  price: number;
  /** Order type for market sell (default FOK) */
  orderType?: 'FOK' | 'FAK';
}

/**
 * Order representation with detailed status tracking
 *
 * Status Flow:
 * pending → open → partially_filled → filled
 *              ↓         ↓               (or)
 *          cancelled  cancelled       expired
 *
 * @see OrderStatus enum for detailed state documentation
 */
export interface Order {
  id: string;
  /** Current order status - see OrderStatus enum for state machine */
  status: OrderStatus;
  tokenId: string;
  side: Side;
  price: number;
  originalSize: number;
  filledSize: number;
  remainingSize: number;
  associateTrades: string[];
  createdAt: number;

  /**
   * Last update timestamp
   * Updated on: status change, new fill, cancellation
   */
  updatedAt?: number;

  /**
   * Expiration timestamp (for GTD orders)
   * undefined for GTC orders
   */
  expiration?: number;

  /** Maker address (EOA or Safe) — from CLOB's maker_address field */
  makerAddress?: string;
}

export interface OrderResult {
  success: boolean;
  orderId?: string;
  orderIds?: string[];
  errorMsg?: string;
  transactionHashes?: string[];
  telemetry?: OrderLatencyTelemetry;
  /**
   * True when the order POST reached an indeterminate transport state.
   *
   * This is not a business reject. CLOB may still accept and match the signed
   * order after the local HTTP request times out, so callers must reconcile via
   * USER WS / Data API / positions before retrying the same intent.
   */
  unknown?: boolean;
  postTimedOut?: boolean;
}

export interface OrderLatencyTelemetry {
  startedAt: number;
  readyAt?: number;
  rateLimiterReadyAt?: number;
  metadataReadyAt?: number;
  signedAt?: number;
  postedAt?: number;
  presignRequested?: boolean;
  presignHit?: boolean;
  presignKey?: string;
  presignCreatedAt?: number;
  presignAgeMs?: number;
  presignBuildMs?: number;
  presignSignMs?: number;
  presignFallbackReason?: string;
  preRateMs?: number;
  rateWaitMs?: number;
  metadataMs?: number;
  signAndBuildMs?: number;
  postOrderMs?: number;
  postTransport?: 'sdk_axios' | 'ee_fetch' | 'ee_https';
  postTimeoutMs?: number;
  postTimedOut?: boolean;
  postErrorCode?: string;
  totalMs: number;
  httpStatus?: number;
  clobStatus?: string;
  success?: boolean;
}

export interface TradingServiceWalletIdentity {
  walletMode: 'builder_safe' | 'eoa' | 'deposit_wallet';
  maker: string;
  signer: string;
  funder?: string;
  signatureType: number;
  builderCode?: string;
}

export interface PresignedOrderFingerprint {
  tokenId: string;
  side: Side;
  orderType: 'GTC' | 'GTD' | 'FOK' | 'FAK';
  postOnly?: boolean;
  price?: number;
  size?: number;
  amount?: number;
  expiration?: number;
  tickSize?: TickSize;
  negRisk?: boolean;
  walletMode: string;
  maker: string;
  signer: string;
  funder?: string;
  signatureType: number;
  builderCode?: string;
}

export interface PresignedOrder {
  key: string;
  kind: 'market' | 'limit';
  orderType: 'GTC' | 'GTD' | 'FOK' | 'FAK';
  postOnly?: boolean;
  signedOrder: SignedOrder;
  fingerprint: PresignedOrderFingerprint;
  createdAt: number;
  expiresAt?: number;
  telemetry: OrderLatencyTelemetry;
  used?: boolean;
}

export interface PresignOptions {
  key?: string;
  ttlMs?: number;
}

interface ClobPostTelemetry {
  transport: 'ee_fetch' | 'ee_https';
  startedAt: number;
  endedAt: number;
  latencyMs: number;
  timeoutMs: number;
  timedOut: boolean;
  httpStatus?: number;
  errorCode?: string;
  orderType?: string;
}

export interface TradeInfo {
  id: string;
  tokenId: string;
  side: Side;
  price: number;
  size: number;
  fee: number;
  timestamp: number;
}

// Rewards types
export interface UserEarning {
  date: string;
  conditionId: string;
  assetAddress: string;
  makerAddress: string;
  earnings: number;
  assetRate: number;
}

export interface MarketReward {
  conditionId: string;
  question: string;
  marketSlug: string;
  eventSlug: string;
  rewardsMaxSpread: number;
  rewardsMinSize: number;
  tokens: Array<{ tokenId: string; outcome: string; price: number }>;
  rewardsConfig: Array<{
    assetAddress: string;
    startDate: string;
    endDate: string;
    ratePerDay: number;
    totalRewards: number;
  }>;
}

/**
 * Market reward configuration for a specific market
 */
export interface MarketRewardConfig {
  conditionId: string;
  question: string;
  /** Maximum qualifying spread for rewards */
  maxSpread: number;
  /** Minimum order size for rewards */
  minSize: number;
  /** Daily reward rate in USDC */
  dailyRate: number;
  /** Total reward pool in USDC */
  totalPool: number;
  /** Reward period start date */
  startDate: string;
  /** Reward period end date */
  endDate: string;
  /** Whether rewards are currently active */
  isActive: boolean;
}

/**
 * Parameters for Q-Score estimation
 */
export interface QScoreParams {
  /** Your bid-ask spread */
  spread: number;
  /** Maximum qualifying spread (from market rewards) */
  maxSpread: number;
  /** Order size in shares */
  orderSize: number;
  /** Whether quoting both sides (YES and NO) */
  isTwoSided?: boolean;
}

/**
 * Q-Score estimation result
 */
export interface QScoreEstimate {
  /** Raw Q-Score before two-sided multiplier */
  score: number;
  /** Effective score after multiplier */
  effectiveScore: number;
  /** Your spread */
  spread: number;
  /** Maximum qualifying spread */
  maxSpread: number;
  /** Order size */
  orderSize: number;
  /** Whether two-sided */
  isTwoSided: boolean;
  /** Estimated percentile ranking */
  percentile: 'top10' | 'top25' | 'top50' | 'average' | 'below_average' | 'below_threshold';
  /** Optimization suggestions */
  suggestions: string[];
}

/**
 * Rewards summary for a date range
 */
export interface RewardsSummary {
  startDate: string;
  endDate: string;
  /** Total earnings in USDC */
  totalEarnings: number;
  /** Average daily earnings */
  averageDailyEarnings: number;
  /** Number of markets earned from */
  marketCount: number;
  /** Best performing market */
  bestMarket: { conditionId: string; earnings: number };
  /** Number of days in range */
  totalDays: number;
}

/**
 * Top reward market information
 */
export interface TopRewardMarket {
  conditionId: string;
  question: string;
  marketSlug: string;
  /** Daily reward rate */
  dailyRate: number;
  /** Total reward pool */
  totalPool: number;
  /** Maximum qualifying spread */
  maxSpread: number;
  /** Minimum order size */
  minSize: number;
  /** Recommended spread for good Q-Score (40% of max) */
  recommendedSpread: number;
  /** Token information */
  tokens: Array<{ tokenId: string; outcome: string; price: number }>;
}

// ============================================================================
// TradingService Implementation
// ============================================================================

export class TradingService {
  private clobClient: ClobClient | null = null;
  private wallet: Wallet;
  private chainId: Chain;
  private credentials: ApiCredentials | null = null;
  private initialized = false;
  private tickSizeCache: Map<string, string> = new Map();
  private negRiskCache: Map<string, boolean> = new Map();
  private lastClobPostTelemetry: ClobPostTelemetry | undefined;

  private dataApi: DataApiClient | undefined;

  /**
   * Resolve diagnostic logger: instance-injected `config.logger` if present,
   * else the module-scope `createModuleLogger('trading-service')` (which now
   * defaults to console post-Fix-F instead of no-op). Fix-G — see
   * TradingServiceConfig.logger doc.
   */
  private get diag(): Logger {
    return this.config.logger ?? log;
  }

  constructor(
    private rateLimiter: RateLimiter,
    private cache: UnifiedCache,
    private config: TradingServiceConfig
  ) {
    this.wallet = new Wallet(config.privateKey);
    this.chainId = (config.chainId || POLYGON_MAINNET) as Chain;
    this.credentials = config.credentials || null;
    this.dataApi = config.dataApi;
    configureClobHttpKeepAlive(this.diag);
  }

  // ============================================================================
  // Initialization
  // ============================================================================

  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Resolve builder code: explicit config > env. Allow undefined here so
    // read-only auth flows (deriveApiKey/createApiKey) can run without it,
    // but enforce presence before any order is placed (see ensureBuilderCode).
    // Note: readBuilderCodeOptional throws on a malformed env value, so a
    // typo fails loudly even if no code is required for the current call.
    const resolvedBuilderCode =
      this.config.builderCode !== undefined
        ? this.config.builderCode
        : readBuilderCodeOptional();

    // Builder mode: orders use Safe as maker, signed by EOA owner. Deposit
    // wallet mode signs with the owner EOA and uses the derived deposit wallet
    // as maker/funder under POLY_1271.
    const configuredWalletMode = this.resolveWalletMode(resolvedBuilderCode);
    const funderAddress = this.resolveFunderAddress(configuredWalletMode);
    const signatureType = this.resolveSignatureType(configuredWalletMode);
    const builderConfig = resolvedBuilderCode
      ? { builderCode: resolvedBuilderCode }
      : undefined;

    // Create CLOB client with L1 auth (wallet) for API-key derivation. We
    // attach the builderConfig up front so any subsequent re-init keeps
    // identical attribution.
    this.clobClient = new ClobClient({
      host: CLOB_HOST,
      chain: this.chainId,
      signer: this.wallet,
      builderConfig,
    });

    // Get or create API credentials
    // We use derive-first strategy (opposite of official createOrDeriveApiKey)
    // because most users already have a key, avoiding unnecessary 400 error logs.
    if (!this.credentials) {
      const creds = await this.deriveOrCreateApiKey();
      this.credentials = {
        key: creds.key,
        secret: creds.secret,
        passphrase: creds.passphrase,
      };
    }

    if (this.config.signatureType === 1 && !this.config.funderAddress) {
      throw new PolymarketError(
        ErrorCode.INVALID_CONFIG,
        'signatureType 1 (Magic / Email login) requires funderAddress (your Polymarket profile address).'
      );
    }

    // Re-initialize with L2 auth (credentials) and (optional) builder config.
    // V2 ClobClient takes a single options object; `chain` replaces V1
    // `chainId`, `signatureType`/`funderAddress`/`builderConfig` are nested.
    this.clobClient = new ClobClient({
      host: CLOB_HOST,
      chain: this.chainId,
      signer: this.wallet,
      creds: {
        key: this.credentials.key,
        secret: this.credentials.secret,
        passphrase: this.credentials.passphrase,
      },
      signatureType,
      funderAddress,
      builderConfig,
    });
    this.installClobFastPost(this.clobClient);

    // PR-1: builderCode boot echo (fires once per TradingService init).
    this.diag.info('TradingService V2 initialized', {
      chainId: this.chainId,
      builderCode: builderConfig?.builderCode ?? '(none)',
      builder_attribution: builderConfig?.builderCode === ZERO_BUILDER_CODE
        ? 'zero_no_rewards'
        : (builderConfig?.builderCode ? 'set' : 'absent'),
      signature_type: signatureTypeName(signatureType),
      wallet_mode: configuredWalletMode,
      funder_address: funderAddress ?? '(EOA-self)',
    });

    // PR-4: EIP-712 V2 domain echo (constants inlined for log clarity / drift detection).
    this.diag.info('EIP-712 V2 domain', {
      domain_name: 'Polymarket CTF Exchange',
      domain_version: '2',  // V2 cutover hardcoded; SDK auto-resolves but we want this in our log for drift detection
      chain_id: 137,
      verifying_contract: '0xE111180000d2663C0091e4f400237545B87B996B',
    });

    this.initialized = true;
  }

  /**
   * Validate that a V2 builder code is available before any order placement
   * path. Pulled into a helper so each order entry-point fails fast with the
   * same diagnostic.
   */
  private ensureBuilderCode(): void {
    if (
      this.config.builderCode === undefined &&
      readBuilderCodeOptional() === undefined
    ) {
      // readBuilderCode() raises with the canonical error message + plan link.
      readBuilderCode();
    }
  }

  /**
   * Try to derive existing API key first, create new one if not exists.
   * This is the reverse of official createOrDeriveApiKey() to avoid
   * 400 "Could not create api key" error log for existing keys.
   */
  private async deriveOrCreateApiKey(): Promise<{ key: string; secret: string; passphrase: string }> {
    // First try to derive existing key (most common case for existing users)
    const derived = await this.clobClient!.deriveApiKey();
    if (derived.key) {
      return derived;
    }

    // Derive failed (key doesn't exist), create new key (first-time users)
    const created = await this.clobClient!.createApiKey();
    if (!created.key) {
      throw new PolymarketError(
        ErrorCode.AUTH_FAILED,
        'Failed to create or derive API key. Wallet may not be registered on Polymarket.'
      );
    }
    return created;
  }

  private async ensureInitialized(): Promise<ClobClient> {
    if (!this.initialized || !this.clobClient) {
      await this.initialize();
    }
    return this.clobClient!;
  }

  getWalletIdentity(): TradingServiceWalletIdentity {
    const builderCode = this.config.builderCode !== undefined
      ? this.config.builderCode
      : readBuilderCodeOptional();
    const walletMode = this.resolveWalletMode(builderCode);
    const signer = this.wallet.address;
    const funder = this.resolveFunderAddress(walletMode);
    return {
      walletMode,
      maker: funder ?? signer,
      signer,
      funder,
      signatureType: this.resolveSignatureType(walletMode),
      builderCode,
    };
  }

  private resolveWalletMode(builderCode?: string): 'builder_safe' | 'eoa' | 'deposit_wallet' {
    if (this.config.walletMode) return this.config.walletMode;
    if (builderCode && this.config.safeAddress) return 'builder_safe';
    return 'eoa';
  }

  private resolveFunderAddress(walletMode: 'builder_safe' | 'eoa' | 'deposit_wallet'): string | undefined {
    if (this.config.funderAddress) return this.config.funderAddress;
    if (walletMode === 'builder_safe') {
      if (!this.config.safeAddress) {
        throw new Error('builder_safe wallet mode requires safeAddress or funderAddress');
      }
      return this.config.safeAddress;
    }
    if (walletMode === 'deposit_wallet') {
      throw new Error('deposit_wallet wallet mode requires funderAddress');
    }
    return undefined;
  }

  private resolveSignatureType(walletMode: 'builder_safe' | 'eoa' | 'deposit_wallet'): number {
    if (this.config.signatureType != null) return this.config.signatureType;
    if (walletMode === 'builder_safe') return SignatureTypeV2.POLY_GNOSIS_SAFE;
    if (walletMode === 'deposit_wallet') return SignatureTypeV2.POLY_1271;
    return SignatureTypeV2.EOA;
  }

  private createPresignKey(kind: 'market' | 'limit', tokenId: string, orderType: string): string {
    return `${kind}:${tokenId}:${orderType}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
  }

  private createPresignedFingerprint(
    params: MarketOrderParams | LimitOrderParams,
    orderType: 'GTC' | 'GTD' | 'FOK' | 'FAK',
    wallet: TradingServiceWalletIdentity,
  ): PresignedOrderFingerprint {
    const limitParams = params as LimitOrderParams;
    const marketParams = params as MarketOrderParams;
    const postOnly = 'postOnly' in params ? params.postOnly : undefined;
    return {
      tokenId: params.tokenId,
      side: params.side,
      orderType,
      postOnly,
      price: params.price,
      size: 'size' in params ? limitParams.size : undefined,
      amount: 'amount' in params ? marketParams.amount : undefined,
      expiration: 'expiration' in params ? limitParams.expiration : undefined,
      tickSize: params.tickSize,
      negRisk: params.negRisk,
      walletMode: wallet.walletMode,
      maker: wallet.maker,
      signer: wallet.signer,
      funder: wallet.funder,
      signatureType: wallet.signatureType,
      builderCode: wallet.builderCode,
    };
  }

  private readLastClobPostTelemetry(): ClobPostTelemetry | undefined {
    return this.lastClobPostTelemetry;
  }

  private getImmediatePostTimeoutMs(): number {
    const raw = process.env.POLY_CLOB_IMMEDIATE_POST_TIMEOUT_MS ?? '3000';
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) return 3000;
    return Math.max(250, Math.min(10_000, Math.floor(parsed)));
  }

  private installClobFastPost(client: ClobClient): void {
    const patchedClient = client as unknown as {
      post?: (endpoint: string, options?: { headers?: Record<string, string>; data?: unknown; params?: Record<string, unknown> }, ipAddressHeaderRequired?: boolean) => Promise<unknown>;
      __eeFastPostInstalled?: boolean;
    };

    if (patchedClient.__eeFastPostInstalled || typeof patchedClient.post !== 'function') return;

    const originalPost = patchedClient.post.bind(patchedClient);
    patchedClient.post = async (endpoint, options = {}, ipAddressHeaderRequired) => {
      const data = options.data as { orderType?: string } | undefined;
      const orderType = data?.orderType;
      const isImmediateOrder =
        endpoint.includes('/order') &&
        (orderType === ClobOrderType.FAK || orderType === ClobOrderType.FOK);

      if (!isImmediateOrder) {
        return originalPost(endpoint, options, ipAddressHeaderRequired);
      }

      return this.postClobWithFetch(
        endpoint,
        {
          headers: options.headers,
          data: options.data,
          params: options.params,
        },
        this.getImmediatePostTimeoutMs(),
        orderType,
      );
    };
    patchedClient.__eeFastPostInstalled = true;
  }

  private async postClobWithFetch(
    endpoint: string,
    options: { headers?: Record<string, string>; data?: unknown; params?: Record<string, unknown> },
    timeoutMs: number,
    orderType?: string,
  ): Promise<any> {
    const startedAt = Date.now();
    const url = new URL(endpoint);
    for (const [key, value] of Object.entries(options.params ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const payload = JSON.stringify(options.data ?? {});
    const headers = {
      'User-Agent': '@polymarket/clob-client-v2',
      Accept: '*/*',
      'Content-Type': 'application/json',
      Connection: 'keep-alive',
      'Content-Length': Buffer.byteLength(payload).toString(),
      ...(options.headers ?? {}),
    };

    try {
      const { statusCode, body: text } = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
        let timedOut = false;
        const request = https.request(
          url,
          {
            method: 'POST',
            headers,
            agent: https.globalAgent,
          },
          (response) => {
            response.setEncoding('utf8');
            let body = '';
            response.on('data', (chunk) => {
              body += chunk;
            });
            response.on('end', () => {
              resolve({ statusCode: response.statusCode ?? 0, body });
            });
          },
        );
        const timeout = setTimeout(() => {
          timedOut = true;
          const error = new Error(`CLOB immediate order POST timed out after ${timeoutMs}ms`) as Error & { code?: string };
          error.code = 'ETIMEDOUT';
          request.destroy(error);
        }, timeoutMs);
        request.on('error', (error) => {
          clearTimeout(timeout);
          if (timedOut && 'code' in error && !error.code) {
            (error as Error & { code?: string }).code = 'ETIMEDOUT';
          }
          reject(error);
        });
        request.on('close', () => clearTimeout(timeout));
        request.write(payload);
        request.end();
      });
      const endedAt = Date.now();
      let body: any;
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        body = { error: text };
      }

      this.lastClobPostTelemetry = {
        transport: 'ee_https',
        startedAt,
        endedAt,
        latencyMs: endedAt - startedAt,
        timeoutMs,
        timedOut: false,
        httpStatus: statusCode,
        orderType,
      };

      if (body && typeof body === 'object' && body.status === undefined) {
        body.status = statusCode;
      }
      return body;
    } catch (error) {
      const endedAt = Date.now();
      const errorCode =
        error instanceof Error && 'code' in error ? String((error as Error & { code?: string }).code) : undefined;
      const timedOut = errorCode === 'ETIMEDOUT';
      this.lastClobPostTelemetry = {
        transport: 'ee_https',
        startedAt,
        endedAt,
        latencyMs: endedAt - startedAt,
        timeoutMs,
        timedOut,
        httpStatus: 0,
        errorCode,
        orderType,
      };
      return {
        success: false,
        status: 0,
        errorMsg: timedOut
          ? `CLOB immediate order POST timed out after ${timeoutMs}ms`
          : `CLOB immediate order POST failed: ${error instanceof Error ? error.message : String(error)}`,
        code: errorCode,
        timeout: timedOut,
      };
    }
  }

  private seedClobClientMarketMetadata(
    tokenId: string,
    metadata: { tickSize?: TickSize; negRisk?: boolean },
  ): void {
    if (!this.clobClient) return;
    const client = this.clobClient as unknown as {
      tickSizes?: Record<string, TickSize>;
      negRisk?: Record<string, boolean>;
    };
    if (metadata.tickSize) {
      client.tickSizes ??= {};
      client.tickSizes[tokenId] = metadata.tickSize;
      this.tickSizeCache.set(tokenId, metadata.tickSize);
    }
    if (metadata.negRisk != null) {
      client.negRisk ??= {};
      client.negRisk[tokenId] = metadata.negRisk;
      this.negRiskCache.set(tokenId, metadata.negRisk);
    }
  }

  /**
   * Preload the CLOB client's per-market caches before a latency-sensitive
   * strategy can emit its first order. The official client always calls
   * `_ensureMarketInfoCached(tokenID)` and, for builder orders,
   * `ensureBuilderFeeRateCached(builderCode)` while creating an order. If those
   * REST calls happen inside the edge window, FAK/FOK orders can miss by seconds.
   */
  async prepareMarketMetadata(params: PrepareMarketMetadataParams): Promise<PrepareMarketMetadataResult> {
    const startedAt = Date.now();
    try {
      const client = await this.ensureInitialized();
      const rawClient = client as unknown as {
        tokenConditionMap?: Record<string, string>;
        getClobMarketInfo?: (conditionId: string) => Promise<unknown>;
        ensureBuilderFeeRateCached?: (builderCode?: string) => Promise<void>;
        resolveVersion?: (forceUpdate?: boolean) => Promise<number>;
      };

      rawClient.tokenConditionMap ??= {};
      for (const tokenId of params.tokenIds) {
        rawClient.tokenConditionMap[tokenId] = params.conditionId;
        this.seedClobClientMarketMetadata(tokenId, {
          tickSize: params.tickSize,
          negRisk: params.negRisk,
        });
      }

      const marketInfoStartedAt = Date.now();
      if (rawClient.getClobMarketInfo) {
        await rawClient.getClobMarketInfo(params.conditionId);
      }
      const marketInfoMs = Date.now() - marketInfoStartedAt;

      const builderCode = this.config.builderCode !== undefined
        ? this.config.builderCode
        : readBuilderCodeOptional();
      const builderFeeStartedAt = Date.now();
      if (builderCode && rawClient.ensureBuilderFeeRateCached) {
        await rawClient.ensureBuilderFeeRateCached(builderCode);
      }
      const builderFeeMs = Date.now() - builderFeeStartedAt;

      const versionStartedAt = Date.now();
      if (rawClient.resolveVersion) {
        await rawClient.resolveVersion(false);
      }
      const versionMs = Date.now() - versionStartedAt;

      const result = {
        success: true,
        conditionId: params.conditionId,
        tokenCount: params.tokenIds.length,
        latencyMs: Date.now() - startedAt,
        marketInfoMs,
        builderFeeMs,
        versionMs,
      };
      this.diag.info('TradingService market metadata prepared', result);
      return result;
    } catch (error) {
      const result = {
        success: false,
        conditionId: params.conditionId,
        tokenCount: params.tokenIds.length,
        latencyMs: Date.now() - startedAt,
        errorMsg: error instanceof Error ? error.message : String(error),
      };
      this.diag.warn('TradingService market metadata prepare failed', result);
      return result;
    }
  }

  /**
   * Return the official per-market fee parameters cached by CLOB market info.
   *
   * Polymarket applies taker fees at match time. USER channel trade events can
   * omit or zero `fee_rate_bps`, so latency-sensitive callers should preload
   * CLOB market info once and use `fd.r/fd.e` for realtime wallet accounting,
   * then reconcile against Data API / chain deltas after the run.
   */
  async getMarketFeeInfo(tokenId: string, conditionId?: string): Promise<MarketFeeInfo> {
    const client = await this.ensureInitialized();
    const rawClient = client as unknown as {
      tokenConditionMap?: Record<string, string>;
      feeInfos?: Record<string, { rate?: number; exponent?: number; takerOnly?: boolean }>;
      getClobMarketInfo?: (conditionId: string) => Promise<{
        fd?: { r?: number; e?: number; to?: boolean };
        mbf?: number;
        tbf?: number;
      }>;
    };

    rawClient.tokenConditionMap ??= {};
    if (conditionId) rawClient.tokenConditionMap[tokenId] = conditionId;

    let marketInfo: {
      fd?: { r?: number; e?: number; to?: boolean };
      mbf?: number;
      tbf?: number;
    } | undefined;
    if (!rawClient.feeInfos?.[tokenId] && conditionId && rawClient.getClobMarketInfo) {
      marketInfo = await rawClient.getClobMarketInfo(conditionId);
    } else if (conditionId && rawClient.getClobMarketInfo) {
      // Still fetch the market info object so builder fee bps and taker-only
      // flags are not lost when feeInfos were already cached.
      marketInfo = await rawClient.getClobMarketInfo(conditionId);
    }

    const info = rawClient.feeInfos?.[tokenId];
    const rate = marketInfo?.fd?.r ?? info?.rate;
    const exponent = marketInfo?.fd?.e ?? info?.exponent ?? 1;
    const builderCode = this.config.builderCode !== undefined
      ? this.config.builderCode
      : readBuilderCodeOptional();
    const applyBuilderFees = isActiveBuilderCode(builderCode);
    if (rate != null) {
      return {
        rate: Number(rate),
        exponent: Number(exponent),
        takerOnly: marketInfo?.fd?.to ?? info?.takerOnly ?? true,
        builderMakerFeeBps: applyBuilderFees ? Number(marketInfo?.mbf ?? 0) : 0,
        builderTakerFeeBps: applyBuilderFees ? Number(marketInfo?.tbf ?? 0) : 0,
        source: 'clob_market_info',
      };
    }

    throw new Error(`failed to load market fee info for token ${tokenId}`);
  }

  /**
   * Estimate platform + builder fees for a single order using live CLOB market
   * fee parameters. The protocol calculates and applies actual fees at match
   * time; this method is for pre-trade budgeting and net-profit checks.
   */
  async estimateOrderFees(params: EstimateOrderFeesParams): Promise<EstimateOrderFeesResult> {
    const feeInfo = await this.getMarketFeeInfo(params.tokenId, params.conditionId);
    const estimate = estimateOrderFeesPure({
      side: params.side,
      price: params.price,
      size: params.size,
      liquidityRole: params.liquidityRole ?? 'taker',
      rate: feeInfo.rate,
      exponent: feeInfo.exponent,
      takerOnly: feeInfo.takerOnly,
      makerBps: feeInfo.builderMakerFeeBps,
      takerBps: feeInfo.builderTakerFeeBps,
    });

    return {
      ...estimate,
      tokenId: params.tokenId,
      conditionId: params.conditionId,
      feeInfo,
    };
  }

  /**
   * Estimate net fees and net profit for two-leg YES/NO arbitrage on a binary
   * market. Existing gross arbitrage helpers remain available, but production
   * execution should gate on this net result.
   */
  async estimateBinaryArbitrageFees(
    params: EstimateBinaryArbitrageFeesParams
  ): Promise<EstimateBinaryArbitrageFeesResult> {
    const feeInfo = await this.getMarketFeeInfo(params.yesTokenId, params.conditionId);
    const estimate = estimateBinaryArbitrageFeesPure({
      type: params.type,
      size: params.size,
      yesPrice: params.yesPrice,
      noPrice: params.noPrice,
      liquidityRole: params.liquidityRole ?? 'taker',
      rate: feeInfo.rate,
      exponent: feeInfo.exponent,
      takerOnly: feeInfo.takerOnly,
      makerBps: feeInfo.builderMakerFeeBps,
      takerBps: feeInfo.builderTakerFeeBps,
    });

    return {
      ...estimate,
      conditionId: params.conditionId,
      yesTokenId: params.yesTokenId,
      noTokenId: params.noTokenId,
      feeInfo,
    };
  }

  // ============================================================================
  // Trading Helpers
  // ============================================================================

  /**
   * Get tick size for a token
   */
  async getTickSize(tokenId: string): Promise<TickSize> {
    if (this.tickSizeCache.has(tokenId)) {
      return this.tickSizeCache.get(tokenId)! as TickSize;
    }

    const client = await this.ensureInitialized();
    const tickSize = await client.getTickSize(tokenId);
    this.tickSizeCache.set(tokenId, tickSize);
    return tickSize;
  }

  /**
   * Check if token is neg risk
   */
  async isNegRisk(tokenId: string): Promise<boolean> {
    if (this.negRiskCache.has(tokenId)) {
      return this.negRiskCache.get(tokenId)!;
    }

    const client = await this.ensureInitialized();
    const negRisk = await client.getNegRisk(tokenId);
    this.negRiskCache.set(tokenId, negRisk);
    return negRisk;
  }

  // ============================================================================
  // Order Creation
  // ============================================================================

  /**
   * Create and post a limit order
   *
   * Note: Polymarket enforces minimum order requirements:
   * - Minimum size: 5 shares (MIN_ORDER_SIZE_SHARES)
   * - Minimum value: $1 pUSD notional (MIN_ORDER_VALUE_USDC, legacy name)
   *
   * Orders below these limits will be rejected by the API.
   */
  async createLimitOrder(params: LimitOrderParams): Promise<OrderResult> {
    // Validate minimum order requirements before sending to API
    // Use market-specific minimum if provided, otherwise fall back to global default
    const minOrderSize = params.minimumOrderSize ?? MIN_ORDER_SIZE_SHARES;
    if (params.size < minOrderSize) {
      return {
        success: false,
        errorMsg: `Order size (${params.size}) is below Polymarket minimum (${minOrderSize} shares)`,
      };
    }

    const orderValue = params.price * params.size;
    if (orderValue < MIN_ORDER_VALUE_USDC) {
      return {
        success: false,
        errorMsg: `Order value ($${orderValue.toFixed(2)}) is below Polymarket minimum ($${MIN_ORDER_VALUE_USDC})`,
      };
    }

    // V2 attribution: every signed order MUST carry a builder code.
    this.ensureBuilderCode();
    const client = await this.ensureInitialized();
    this.seedClobClientMarketMetadata(params.tokenId, {
      tickSize: params.tickSize,
      negRisk: params.negRisk,
    });

    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      try {
        const [tickSize, negRisk] = await Promise.all([
          params.tickSize ?? this.getTickSize(params.tokenId),
          params.negRisk ?? this.isNegRisk(params.tokenId),
        ]);

        const orderType = params.orderType === 'GTD' ? ClobOrderType.GTD : ClobOrderType.GTC;

        // V2 UserOrder shape: only `expiration` (unix seconds) is forwarded
        // explicitly; the SDK populates `timestamp` (ms), `metadata` (zero
        // bytes32), and `builder` (from `builderConfig.builderCode`)
        // internally during order signing. `nonce` / `feeRateBps` / `taker`
        // are removed by V2.
        const result = await client.createAndPostOrder(
          {
            tokenID: params.tokenId,
            side: params.side === 'BUY' ? ClobSide.BUY : ClobSide.SELL,
            price: params.price,
            size: params.size,
            expiration: params.expiration || 0,
          },
          { tickSize, negRisk },
          orderType,
          params.postOnly === true
        );

        // Per CLOB API docs: orderID is always returned on successful 200 responses.
        // transactionsHashes alone is NOT a standalone success signal — it co-occurs with orderID
        // when status="matched". Removing the transactionHashes-only fallback prevents ghost positions
        // (success=true, orderId=undefined) when Builder/Relayer path returns txHash without orderID.
        const success = result.success === true ||
          (result.success !== false && result.orderID !== undefined && result.orderID !== '');

        const errorMsg = !success
          ? (result.errorMsg || `Limit order rejected (status: ${result.status ?? 'unknown'}, response: ${JSON.stringify(result)})`)
          : result.errorMsg;

        return {
          success,
          orderId: result.orderID,
          orderIds: result.orderIDs,
          errorMsg,
          transactionHashes: result.transactionsHashes,
        };
      } catch (error) {
        return {
          success: false,
          errorMsg: `Order failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    });
  }

  async presignLimitOrder(params: LimitOrderParams, options: PresignOptions = {}): Promise<PresignedOrder> {
    const startedAt = Date.now();
    const minOrderSize = params.minimumOrderSize ?? MIN_ORDER_SIZE_SHARES;
    if (params.size < minOrderSize) {
      throw new Error(`Order size (${params.size}) is below Polymarket minimum (${minOrderSize} shares)`);
    }

    const orderValue = params.price * params.size;
    if (orderValue < MIN_ORDER_VALUE_USDC) {
      throw new Error(`Order value ($${orderValue.toFixed(2)}) is below Polymarket minimum ($${MIN_ORDER_VALUE_USDC})`);
    }

    this.ensureBuilderCode();
    const client = await this.ensureInitialized();
    this.seedClobClientMarketMetadata(params.tokenId, {
      tickSize: params.tickSize,
      negRisk: params.negRisk,
    });
    const readyAt = Date.now();

    const [tickSize, negRisk] = await Promise.all([
      params.tickSize ?? this.getTickSize(params.tokenId),
      params.negRisk ?? this.isNegRisk(params.tokenId),
    ]);
    const metadataReadyAt = Date.now();
    const orderType = params.orderType === 'GTD' ? ClobOrderType.GTD : ClobOrderType.GTC;
    const signedOrder = await client.createOrder(
      {
        tokenID: params.tokenId,
        side: params.side === 'BUY' ? ClobSide.BUY : ClobSide.SELL,
        price: params.price,
        size: params.size,
        expiration: params.expiration || 0,
      },
      { tickSize, negRisk },
    );
    const signedAt = Date.now();
    const wallet = this.getWalletIdentity();
    const key = options.key ?? this.createPresignKey('limit', params.tokenId, orderType);
    return {
      key,
      kind: 'limit',
      orderType,
      postOnly: params.postOnly === true,
      signedOrder,
      fingerprint: this.createPresignedFingerprint({ ...params, tickSize, negRisk }, orderType, wallet),
      createdAt: signedAt,
      expiresAt: options.ttlMs == null ? undefined : signedAt + options.ttlMs,
      telemetry: {
        startedAt,
        readyAt,
        metadataReadyAt,
        signedAt,
        presignRequested: true,
        presignHit: false,
        presignKey: key,
        presignCreatedAt: signedAt,
        presignBuildMs: signedAt - metadataReadyAt,
        presignSignMs: signedAt - metadataReadyAt,
        preRateMs: readyAt - startedAt,
        metadataMs: metadataReadyAt - readyAt,
        signAndBuildMs: signedAt - metadataReadyAt,
        totalMs: signedAt - startedAt,
      },
    };
  }

  /**
   * Create and post a market order
   *
   * Note: Polymarket enforces minimum order requirements:
   * - Minimum value: $1 pUSD notional (MIN_ORDER_VALUE_USDC, legacy name)
   *
   * Market orders below this limit will be rejected by the API.
   */
  async createMarketOrder(params: MarketOrderParams): Promise<OrderResult> {
    const startedAt = Date.now();
    // Validate minimum order value before sending to API
    if (params.amount < MIN_ORDER_VALUE_USDC) {
      return {
        success: false,
        errorMsg: `Order amount ($${params.amount.toFixed(2)}) is below Polymarket minimum ($${MIN_ORDER_VALUE_USDC})`,
      };
    }

    this.ensureBuilderCode();
    const client = await this.ensureInitialized();
    this.seedClobClientMarketMetadata(params.tokenId, {
      tickSize: params.tickSize,
      negRisk: params.negRisk,
    });
    const readyAt = Date.now();

    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      const rateLimiterReadyAt = Date.now();
      try {
        const [tickSize, negRisk] = await Promise.all([
          params.tickSize ?? this.getTickSize(params.tokenId),
          params.negRisk ?? this.isNegRisk(params.tokenId),
        ]);
        const metadataReadyAt = Date.now();

        const orderType = params.orderType === 'FAK' ? ClobOrderType.FAK : ClobOrderType.FOK;

        // V2 UserMarketOrder: same `tokenID` / `side` / `amount` / `price`
        // surface; `feeRateBps` / `nonce` / `taker` removed; `builder` and
        // `metadata` populated by the SDK from `builderConfig`.
        const signedOrder = await client.createMarketOrder(
          {
            tokenID: params.tokenId,
            side: params.side === 'BUY' ? ClobSide.BUY : ClobSide.SELL,
            amount: params.amount,
            price: params.price,
          },
          { tickSize, negRisk },
        );
        const signedAt = Date.now();
        this.lastClobPostTelemetry = undefined;
        const result = await client.postOrder(signedOrder, orderType);
        const postedAt = Date.now();
        const postTelemetry = this.readLastClobPostTelemetry();
        const telemetry: OrderLatencyTelemetry = {
          startedAt,
          readyAt,
          rateLimiterReadyAt,
          metadataReadyAt,
          signedAt,
          postedAt,
          preRateMs: readyAt - startedAt,
          rateWaitMs: rateLimiterReadyAt - readyAt,
          metadataMs: metadataReadyAt - rateLimiterReadyAt,
          signAndBuildMs: signedAt - metadataReadyAt,
          postOrderMs: postedAt - signedAt,
          postTransport: postTelemetry?.transport ?? 'sdk_axios',
          postTimeoutMs: postTelemetry?.timeoutMs,
          postTimedOut: postTelemetry?.timedOut,
          postErrorCode: postTelemetry?.errorCode,
          totalMs: postedAt - startedAt,
          httpStatus: postTelemetry?.httpStatus,
          clobStatus: result.status,
          success: result.success === true,
        };

        this.diag.info('TradingService market order latency', {
          tokenId: params.tokenId.slice(0, 12),
          side: params.side,
          orderType: params.orderType ?? 'FOK',
          amount: params.amount,
          price: params.price,
          preRateMs: telemetry.preRateMs,
          rateWaitMs: telemetry.rateWaitMs,
          metadataMs: telemetry.metadataMs,
          signAndBuildMs: telemetry.signAndBuildMs,
          postOrderMs: telemetry.postOrderMs,
          postTransport: telemetry.postTransport,
          postTimeoutMs: telemetry.postTimeoutMs,
          postTimedOut: telemetry.postTimedOut,
          postErrorCode: telemetry.postErrorCode,
          totalMs: telemetry.totalMs,
          success: result.success === true,
          status: telemetry.clobStatus ?? telemetry.httpStatus,
          orderId: result.orderID ? result.orderID.slice(0, 12) : undefined,
        });

        // FOK/FAK orders can return an orderID for a terminal no-fill/killed
        // response. Treating orderID alone as success creates ghost open orders
        // and lets live strategies count killed FAK attempts as accepted orders.
        // For immediate market orders, only explicit success=true means a fill
        // path was accepted by CLOB.
        const isFokOrder = params.orderType !== 'FAK'; // default is FOK
        const success = result.success === true;

        const postTimedOut = telemetry.postTimedOut === true || result.timeout === true;
        const unknown = postTimedOut;
        const errorMsg = unknown
          ? (result.errorMsg || `CLOB immediate order POST outcome unknown after ${telemetry.postTimeoutMs ?? 'configured'}ms`)
          : (!success
            ? (result.errorMsg || `Market order ${isFokOrder ? 'FOK not filled' : 'FAK killed/no-fill'} (status: ${result.status ?? 'unknown'}, orderID: ${result.orderID ?? 'none'})`)
            : result.errorMsg);

        return {
          success,
          orderId: result.orderID,
          orderIds: result.orderIDs,
          errorMsg,
          transactionHashes: result.transactionsHashes,
          telemetry,
          unknown,
          postTimedOut,
        };
      } catch (error) {
        const failedAt = Date.now();
        const postTelemetry = this.readLastClobPostTelemetry();
        const postTimedOut = postTelemetry?.timedOut === true;
        return {
          success: false,
          errorMsg: `Market order failed: ${error instanceof Error ? error.message : String(error)}`,
          unknown: postTimedOut,
          postTimedOut,
          telemetry: {
            startedAt,
            readyAt,
            rateLimiterReadyAt,
            postOrderMs: postTelemetry?.latencyMs,
            postTransport: postTelemetry?.transport,
            postTimeoutMs: postTelemetry?.timeoutMs,
            postTimedOut: postTelemetry?.timedOut,
            postErrorCode: postTelemetry?.errorCode,
            httpStatus: postTelemetry?.httpStatus,
            totalMs: failedAt - startedAt,
            success: false,
          },
        };
      }
    });
  }

  async presignMarketOrder(params: MarketOrderParams, options: PresignOptions = {}): Promise<PresignedOrder> {
    const startedAt = Date.now();
    if (params.amount < MIN_ORDER_VALUE_USDC) {
      throw new Error(`Order amount ($${params.amount.toFixed(2)}) is below Polymarket minimum ($${MIN_ORDER_VALUE_USDC})`);
    }

    this.ensureBuilderCode();
    const client = await this.ensureInitialized();
    this.seedClobClientMarketMetadata(params.tokenId, {
      tickSize: params.tickSize,
      negRisk: params.negRisk,
    });
    const readyAt = Date.now();

    const [tickSize, negRisk] = await Promise.all([
      params.tickSize ?? this.getTickSize(params.tokenId),
      params.negRisk ?? this.isNegRisk(params.tokenId),
    ]);
    const metadataReadyAt = Date.now();
    const orderType = params.orderType === 'FAK' ? ClobOrderType.FAK : ClobOrderType.FOK;
    const signedOrder = await client.createMarketOrder(
      {
        tokenID: params.tokenId,
        side: params.side === 'BUY' ? ClobSide.BUY : ClobSide.SELL,
        amount: params.amount,
        price: params.price,
      },
      { tickSize, negRisk },
    );
    const signedAt = Date.now();
    const wallet = this.getWalletIdentity();
    const key = options.key ?? this.createPresignKey('market', params.tokenId, orderType);
    return {
      key,
      kind: 'market',
      orderType,
      signedOrder,
      fingerprint: this.createPresignedFingerprint({ ...params, tickSize, negRisk }, orderType, wallet),
      createdAt: signedAt,
      expiresAt: options.ttlMs == null ? undefined : signedAt + options.ttlMs,
      telemetry: {
        startedAt,
        readyAt,
        metadataReadyAt,
        signedAt,
        presignRequested: true,
        presignHit: false,
        presignKey: key,
        presignCreatedAt: signedAt,
        presignBuildMs: signedAt - metadataReadyAt,
        presignSignMs: signedAt - metadataReadyAt,
        preRateMs: readyAt - startedAt,
        metadataMs: metadataReadyAt - readyAt,
        signAndBuildMs: signedAt - metadataReadyAt,
        totalMs: signedAt - startedAt,
      },
    };
  }

  async postPresignedOrder(presigned: PresignedOrder): Promise<OrderResult> {
    const startedAt = Date.now();
    if (presigned.used) {
      return {
        success: false,
        errorMsg: `Presigned order ${presigned.key} has already been used`,
        telemetry: {
          startedAt,
          presignRequested: true,
          presignHit: false,
          presignKey: presigned.key,
          presignCreatedAt: presigned.createdAt,
          presignAgeMs: startedAt - presigned.createdAt,
          presignFallbackReason: 'already_used',
          totalMs: 0,
          success: false,
        },
      };
    }
    if (presigned.expiresAt != null && presigned.expiresAt <= startedAt) {
      return {
        success: false,
        errorMsg: `Presigned order ${presigned.key} expired`,
        telemetry: {
          startedAt,
          presignRequested: true,
          presignHit: false,
          presignKey: presigned.key,
          presignCreatedAt: presigned.createdAt,
          presignAgeMs: startedAt - presigned.createdAt,
          presignFallbackReason: 'expired',
          totalMs: 0,
          success: false,
        },
      };
    }

    this.ensureBuilderCode();
    const client = await this.ensureInitialized();
    const readyAt = Date.now();
    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      const rateLimiterReadyAt = Date.now();
      try {
        this.lastClobPostTelemetry = undefined;
        presigned.used = true;
        const result = await client.postOrder(
          presigned.signedOrder,
          presigned.orderType as ClobOrderType,
          presigned.postOnly === true,
        );
        const postedAt = Date.now();
        const postTelemetry = this.readLastClobPostTelemetry();
        const telemetry: OrderLatencyTelemetry = {
          startedAt,
          readyAt,
          rateLimiterReadyAt,
          postedAt,
          presignRequested: true,
          presignHit: true,
          presignKey: presigned.key,
          presignCreatedAt: presigned.createdAt,
          presignAgeMs: startedAt - presigned.createdAt,
          presignBuildMs: presigned.telemetry.presignBuildMs ?? presigned.telemetry.signAndBuildMs,
          presignSignMs: presigned.telemetry.presignSignMs,
          preRateMs: readyAt - startedAt,
          rateWaitMs: rateLimiterReadyAt - readyAt,
          signAndBuildMs: 0,
          postOrderMs: postedAt - rateLimiterReadyAt,
          postTransport: postTelemetry?.transport ?? 'sdk_axios',
          postTimeoutMs: postTelemetry?.timeoutMs,
          postTimedOut: postTelemetry?.timedOut,
          postErrorCode: postTelemetry?.errorCode,
          totalMs: postedAt - startedAt,
          httpStatus: postTelemetry?.httpStatus,
          clobStatus: result.status,
          success: result.success === true,
        };
        if (presigned.kind === 'market') {
          const success = result.success === true;
          const postTimedOut = telemetry.postTimedOut === true || result.timeout === true;
          const unknown = postTimedOut;
          const errorMsg = unknown
            ? (result.errorMsg || `CLOB immediate order POST outcome unknown after ${telemetry.postTimeoutMs ?? 'configured'}ms`)
            : (!success
              ? (result.errorMsg || `Market order ${presigned.orderType === 'FOK' ? 'FOK not filled' : 'FAK killed/no-fill'} (status: ${result.status ?? 'unknown'}, orderID: ${result.orderID ?? 'none'})`)
              : result.errorMsg);
          return {
            success,
            orderId: result.orderID,
            orderIds: result.orderIDs,
            errorMsg,
            transactionHashes: result.transactionsHashes,
            telemetry,
            unknown,
            postTimedOut,
          };
        }
        const success = result.success === true ||
          (result.success !== false && result.orderID !== undefined && result.orderID !== '');
        return {
          success,
          orderId: result.orderID,
          orderIds: result.orderIDs,
          errorMsg: !success
            ? (result.errorMsg || `Limit order rejected (status: ${result.status ?? 'unknown'}, response: ${JSON.stringify(result)})`)
            : result.errorMsg,
          transactionHashes: result.transactionsHashes,
          telemetry,
        };
      } catch (error) {
        const failedAt = Date.now();
        const postTelemetry = this.readLastClobPostTelemetry();
        const postTimedOut = postTelemetry?.timedOut === true;
        return {
          success: false,
          errorMsg: `Presigned order POST failed: ${error instanceof Error ? error.message : String(error)}`,
          unknown: postTimedOut,
          postTimedOut,
          telemetry: {
            startedAt,
            readyAt,
            rateLimiterReadyAt,
            presignRequested: true,
            presignHit: true,
            presignKey: presigned.key,
            presignCreatedAt: presigned.createdAt,
            presignAgeMs: startedAt - presigned.createdAt,
            postOrderMs: postTelemetry?.latencyMs,
            postTransport: postTelemetry?.transport,
            postTimeoutMs: postTelemetry?.timeoutMs,
            postTimedOut: postTelemetry?.timedOut,
            postErrorCode: postTelemetry?.errorCode,
            httpStatus: postTelemetry?.httpStatus,
            totalMs: failedAt - startedAt,
            success: false,
          },
        };
      }
    });
  }

  /**
   * Clear position via market sell. Fetches size from Data API (tokenId持仓).
   *
   * Requires config.dataApi. Uses safeAddress (Builder) or wallet.address for position lookup.
   *
   * @param params - tokenId, price (with slippage applied), orderType
   * @returns OrderResult
   *
   * @example
   * ```typescript
   * await sdk.tradingService.clearPosition({
   *   tokenId,
   *   price: bestBid * 0.95,  // 5% slippage
   * });
   * ```
   */
  async clearPosition(params: ClearPositionParams): Promise<OrderResult> {
    const { tokenId, price, orderType = 'FOK' } = params;

    if (!this.dataApi) {
      return {
        success: false,
        errorMsg: 'clearPosition requires config.dataApi to fetch position size.',
      };
    }

    const address = this.config.safeAddress || this.wallet.address;

    let pos: { size: number } | null;
    try {
      pos = await this.dataApi.getPositionByTokenId(address, tokenId);
    } catch (error) {
      return {
        success: false,
        errorMsg: `Failed to fetch position: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    let size = pos?.size ?? 0;
    return this.createMarketOrder({
      tokenId,
      side: 'SELL',
      amount: size,
      price,
      orderType,
    });
  }

  /**
   * Create and post multiple limit orders in a batch
   *
   * Note: Polymarket enforces:
   * - Maximum 15 orders per batch
   * - Same minimum requirements as single orders (5 shares, $1 value)
   *
   * This method uses Polymarket's batch API (POST /orders) which submits
   * all orders in a single HTTP request, significantly faster than individual calls.
   *
   * @param orders - Array of limit order parameters (max 15)
   * @returns Batch result with individual order IDs or errors
   */
  async createBatchOrders(orders: LimitOrderParams[]): Promise<OrderResult> {
    // Validate batch size
    if (orders.length === 0) {
      return {
        success: false,
        errorMsg: 'Batch must contain at least one order',
      };
    }

    if (orders.length > 15) {
      return {
        success: false,
        errorMsg: `Batch size (${orders.length}) exceeds Polymarket maximum (15 orders)`,
      };
    }

    const batchPostOnly = orders.some(order => order.postOnly === true);
    if (batchPostOnly && orders.some(order => order.postOnly !== true)) {
      return {
        success: false,
        errorMsg: 'Batch postOnly must be consistent for all orders because CLOB postOrders accepts a batch-level postOnly flag',
      };
    }

    // Validate each order
    const validationErrors: string[] = [];
    for (let i = 0; i < orders.length; i++) {
      const order = orders[i];
      // Use market-specific minimum if provided, otherwise fall back to global default
      const minOrderSize = order.minimumOrderSize ?? MIN_ORDER_SIZE_SHARES;
      if (order.size < minOrderSize) {
        validationErrors.push(`Order ${i}: size (${order.size}) below minimum (${minOrderSize} shares)`);
      }
      const orderValue = order.price * order.size;
      if (orderValue < MIN_ORDER_VALUE_USDC) {
        validationErrors.push(`Order ${i}: value ($${orderValue.toFixed(2)}) below minimum ($${MIN_ORDER_VALUE_USDC})`);
      }
    }

    if (validationErrors.length > 0) {
      return {
        success: false,
        errorMsg: `Batch validation failed:\n${validationErrors.join('\n')}`,
      };
    }

    this.ensureBuilderCode();
    const client = await this.ensureInitialized();

    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      try {
        // Step 1: Get tick sizes and neg risk flags for all unique tokens
        const uniqueTokenIds = [...new Set(orders.map(o => o.tokenId))];
        const tokenMetadata = new Map<string, { tickSize: TickSize; negRisk: boolean }>();

        await Promise.all(
          uniqueTokenIds.map(async tokenId => {
            const [tickSize, negRisk] = await Promise.all([
              this.getTickSize(tokenId),
              this.isNegRisk(tokenId),
            ]);
            tokenMetadata.set(tokenId, { tickSize, negRisk });
          })
        );

        // Step 2: Create signed orders (without posting)
        const signedOrders = await Promise.all(
          orders.map(async order => {
            const metadata = tokenMetadata.get(order.tokenId)!;
            const orderType = order.orderType === 'GTD' ? ClobOrderType.GTD : ClobOrderType.GTC;

            return {
              signedOrder: await client.createOrder(
                {
                  tokenID: order.tokenId,
                  side: order.side === 'BUY' ? ClobSide.BUY : ClobSide.SELL,
                  price: order.price,
                  size: order.size,
                  expiration: order.expiration || 0,
                },
                {
                  tickSize: metadata.tickSize,
                  negRisk: metadata.negRisk,
                }
              ),
              orderType,
            };
          })
        );

        // Step 3: Batch submit all signed orders in a single request
        const batchArgs = signedOrders.map(({ signedOrder, orderType }) => ({
          order: signedOrder,
          orderType,
        }));

        const results = await client.postOrders(batchArgs, batchPostOnly);

        // Step 4: Process batch response
        const successfulOrderIds: string[] = [];
        const errors: string[] = [];

        if (Array.isArray(results)) {
          results.forEach((result, index) => {
            if (result.success === true || result.orderID) {
              if (result.orderID) {
                successfulOrderIds.push(result.orderID);
              }
            } else {
              const msg = result.errorMsg || `rejected (response: ${JSON.stringify(result)})`;
              errors.push(`Order ${index}: ${msg}`);
            }
          });
        }

        const totalSuccess = successfulOrderIds.length;
        const totalFailed = orders.length - totalSuccess;

        return {
          success: totalSuccess > 0,
          orderIds: successfulOrderIds,
          errorMsg: totalSuccess < orders.length
            ? `Batch: ${totalSuccess}/${orders.length} succeeded.\n${errors.join('\n')}`
            : undefined,
        };
      } catch (error) {
        return {
          success: false,
          errorMsg: `Batch order failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    });
  }

  // ============================================================================
  // Order Management
  // ============================================================================

  /**
   * Get a single order by ID
   *
   * @param orderId - Order ID (hash)
   * @returns Order details or null if not found
   */
  async getOrder(orderId: string): Promise<Order | null> {
    const client = await this.ensureInitialized();

    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      try {
        const order = await client.getOrder(orderId);
        if (!order) return null;

        // Validate required fields to prevent runtime errors
        if (!order.side) {
          this.diag.warn(`Order ${orderId} missing side field, returning null`);
          return null;
        }

        const originalSize = Number(order.original_size) || 0;
        const filledSize = Number(order.size_matched) || 0;
        return {
          id: order.id,
          status: mapApiStatusToInternal(order),
          tokenId: order.asset_id,
          side: order.side.toUpperCase() as Side,
          price: Number(order.price) || 0,
          originalSize,
          filledSize,
          remainingSize: originalSize - filledSize,
          associateTrades: order.associate_trades || [],
          createdAt: order.created_at,
          updatedAt: Date.now(),
          expiration: order.expiration ? Number(order.expiration) : undefined,
          makerAddress: (order as any).maker_address || undefined,
        };
      } catch (error) {
        // If order not found, return null instead of throwing
        if (error instanceof Error && error.message.includes('not found')) {
          return null;
        }
        throw new PolymarketError(
          ErrorCode.ORDER_FAILED,
          `Get order failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    });
  }

  async cancelOrder(orderId: string): Promise<OrderResult> {
    const client = await this.ensureInitialized();

    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      try {
        const result = await client.cancelOrder({ orderID: orderId });
        return { success: result.canceled ?? false, orderId };
      } catch (error) {
        throw new PolymarketError(
          ErrorCode.ORDER_FAILED,
          `Cancel failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    });
  }

  async cancelOrders(orderIds: string[]): Promise<OrderResult> {
    const client = await this.ensureInitialized();

    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      try {
        const result = await client.cancelOrders(orderIds);
        return { success: result.canceled ?? false, orderIds };
      } catch (error) {
        throw new PolymarketError(
          ErrorCode.ORDER_FAILED,
          `Cancel orders failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    });
  }

  async cancelAllOrders(): Promise<OrderResult> {
    const client = await this.ensureInitialized();

    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      try {
        const result = await client.cancelAll();
        return { success: result.canceled ?? false };
      } catch (error) {
        throw new PolymarketError(
          ErrorCode.ORDER_FAILED,
          `Cancel all failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    });
  }

  /**
   * Cancel orders by market or asset
   *
   * @param marketId - Market condition ID (optional)
   * @param assetId - Token ID (optional)
   * @returns Cancel result with canceled order IDs
   */
  async cancelMarketOrders(marketId?: string, assetId?: string): Promise<OrderResult> {
    const client = await this.ensureInitialized();

    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      try {
        const result = await client.cancelMarketOrders({ market: marketId, asset_id: assetId });
        return {
          success: (result.canceled?.length ?? 0) > 0 || Object.keys(result.not_canceled || {}).length === 0,
          orderIds: result.canceled,
        };
      } catch (error) {
        throw new PolymarketError(
          ErrorCode.ORDER_FAILED,
          `Cancel market orders failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    });
  }

  async getOpenOrders(marketId?: string): Promise<Order[]> {
    const client = await this.ensureInitialized();

    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      const orders = await client.getOpenOrders(marketId ? { market: marketId } : undefined);

      return orders.map((o: OpenOrder) => {
        const originalSize = Number(o.original_size) || 0;
        const filledSize = Number(o.size_matched) || 0;
        return {
          id: o.id,
          status: mapApiStatusToInternal(o),
          tokenId: o.asset_id,
          side: o.side.toUpperCase() as Side,
          price: Number(o.price) || 0,
          originalSize,
          filledSize,
          remainingSize: originalSize - filledSize,
          associateTrades: o.associate_trades || [],
          createdAt: o.created_at,
          updatedAt: Date.now(),
          expiration: o.expiration ? Number(o.expiration) : undefined,
        };
      });
    });
  }

  /**
   * Check if an order can be cancelled
   *
   * Orders can be cancelled if they are in OPEN or PARTIALLY_FILLED status.
   * Orders in terminal states (FILLED, CANCELLED, EXPIRED, REJECTED) or
   * PENDING state cannot be cancelled via API.
   *
   * @param orderId - Order ID to check
   * @returns Promise<boolean> - true if order can be cancelled
   *
   * @example
   * ```typescript
   * const canCancel = await sdk.trading.canCancelOrder(orderId);
   * if (canCancel) {
   *   await sdk.trading.cancelOrder(orderId);
   * }
   * ```
   */
  async canCancelOrder(orderId: string): Promise<boolean> {
    const order = await this.getOrder(orderId);
    if (!order) return false;
    return canOrderBeCancelled(order.status);
  }

  /**
   * Get order fill progress as percentage
   *
   * Returns the percentage of the order that has been filled (0-100).
   * Useful for tracking partial fills and displaying progress.
   *
   * @param orderId - Order ID to check
   * @returns Promise<number | null> - Fill percentage (0-100) or null if order not found
   *
   * @example
   * ```typescript
   * const progress = await sdk.trading.getOrderProgress(orderId);
   * if (progress !== null) {
   *   console.log(`Order ${progress.toFixed(1)}% filled`);
   * }
   * ```
   */
  async getOrderProgress(orderId: string): Promise<number | null> {
    const order = await this.getOrder(orderId);
    if (!order) return null;
    return calculateOrderProgress(order.originalSize, order.filledSize);
  }

  async getTrades(marketId?: string): Promise<TradeInfo[]> {
    const client = await this.ensureInitialized();

    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      const trades = await client.getTrades(marketId ? { market: marketId } : undefined);

      return trades.map((t: ClobTrade) => ({
        id: t.id,
        tokenId: t.asset_id,
        side: t.side as Side,
        price: Number(t.price) || 0,
        size: Number(t.size) || 0,
        fee: Number(t.fee_rate_bps) || 0,
        timestamp: Number(t.match_time) || Date.now(),
      }));
    });
  }

  // ============================================================================
  // Rewards
  // ============================================================================

  async isOrderScoring(orderId: string): Promise<boolean> {
    const client = await this.ensureInitialized();
    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      const result = await client.isOrderScoring({ order_id: orderId });
      return result.scoring;
    });
  }

  async areOrdersScoring(orderIds: string[]): Promise<Record<string, boolean>> {
    const client = await this.ensureInitialized();
    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      return await client.areOrdersScoring({ orderIds });
    });
  }

  async getEarningsForDay(date: string): Promise<UserEarning[]> {
    const client = await this.ensureInitialized();
    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      const earnings = await client.getEarningsForUserForDay(date);
      return earnings.map(e => ({
        date: e.date,
        conditionId: e.condition_id,
        assetAddress: e.asset_address,
        makerAddress: e.maker_address,
        earnings: e.earnings,
        assetRate: e.asset_rate,
      }));
    });
  }

  async getCurrentRewards(): Promise<MarketReward[]> {
    const client = await this.ensureInitialized();
    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      const rewards = await client.getCurrentRewards();
      return rewards.map(r => ({
        conditionId: r.condition_id,
        question: r.question,
        marketSlug: r.market_slug,
        eventSlug: r.event_slug,
        rewardsMaxSpread: r.rewards_max_spread,
        rewardsMinSize: r.rewards_min_size,
        tokens: r.tokens.map(t => ({
          tokenId: t.token_id,
          outcome: t.outcome,
          price: t.price,
        })),
        rewardsConfig: r.rewards_config.map(c => ({
          assetAddress: c.asset_address,
          startDate: c.start_date,
          endDate: c.end_date,
          ratePerDay: c.rate_per_day,
          totalRewards: c.total_rewards,
        })),
      }));
    });
  }

  /**
   * Get reward configuration for a specific market
   *
   * Returns maxSpread, minSize, dailyRate for Q-Score calculation.
   * Returns null if market has no active rewards.
   */
  async getMarketRewardConfig(conditionId: string): Promise<MarketRewardConfig | null> {
    const rewards = await this.getCurrentRewards();
    const market = rewards.find(r => r.conditionId === conditionId);

    if (!market) {
      return null;
    }

    // Find active reward config
    const now = new Date();
    const activeConfig = market.rewardsConfig.find(c => {
      const start = new Date(c.startDate);
      const end = new Date(c.endDate);
      return now >= start && now <= end;
    });

    return {
      conditionId: market.conditionId,
      question: market.question,
      maxSpread: market.rewardsMaxSpread,
      minSize: market.rewardsMinSize,
      dailyRate: activeConfig?.ratePerDay ?? 0,
      totalPool: activeConfig?.totalRewards ?? 0,
      startDate: activeConfig?.startDate ?? '',
      endDate: activeConfig?.endDate ?? '',
      isActive: !!activeConfig,
    };
  }

  /**
   * Estimate Q-Score for given parameters
   *
   * Q-Score = ((maxSpread - yourSpread) / maxSpread)² × orderSize
   *
   * Two-sided quotes get full score, one-sided gets 1/3.
   */
  estimateQScore(params: QScoreParams): QScoreEstimate {
    const { spread, maxSpread, orderSize, isTwoSided = true } = params;

    // If spread exceeds max, no score
    if (spread >= maxSpread || maxSpread <= 0) {
      return {
        score: 0,
        effectiveScore: 0,
        spread,
        maxSpread,
        orderSize,
        isTwoSided,
        percentile: 'below_threshold',
        suggestions: ['Your spread exceeds the maximum qualifying spread'],
      };
    }

    const ratio = (maxSpread - spread) / maxSpread;
    const baseScore = Math.pow(ratio, 2) * orderSize;

    // Two-sided gets full score, one-sided gets 1/3
    const multiplier = isTwoSided ? 1.0 : 1 / 3;
    const effectiveScore = baseScore * multiplier;

    // Estimate percentile based on typical spread distributions
    let percentile: QScoreEstimate['percentile'];
    const spreadRatio = spread / maxSpread;
    if (spreadRatio <= 0.2) percentile = 'top10';
    else if (spreadRatio <= 0.4) percentile = 'top25';
    else if (spreadRatio <= 0.6) percentile = 'top50';
    else if (spreadRatio <= 0.8) percentile = 'average';
    else percentile = 'below_average';

    // Generate suggestions
    const suggestions: string[] = [];
    if (!isTwoSided) {
      suggestions.push('Enable two-sided quoting for 3x reward multiplier');
    }
    if (spreadRatio > 0.5) {
      const tighterSpread = maxSpread * 0.4;
      suggestions.push(`Tightening spread to ${(tighterSpread * 100).toFixed(1)}% would significantly increase rewards`);
    }
    if (orderSize < 50) {
      suggestions.push('Increasing order size improves Q-Score proportionally');
    }

    return {
      score: baseScore,
      effectiveScore,
      spread,
      maxSpread,
      orderSize,
      isTwoSided,
      percentile,
      suggestions,
    };
  }

  /**
   * Get rewards summary for a date range
   *
   * Aggregates daily earnings into a summary.
   */
  async getRewardsSummary(startDate?: string, endDate?: string): Promise<RewardsSummary> {
    // Default to last 7 days
    const end = endDate ? new Date(endDate) : new Date();
    const start = startDate ? new Date(startDate) : new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);

    const earnings: UserEarning[] = [];
    const currentDate = new Date(start);

    // Fetch earnings for each day
    while (currentDate <= end) {
      const dateStr = currentDate.toISOString().split('T')[0];
      try {
        const dayEarnings = await this.getEarningsForDay(dateStr);
        earnings.push(...dayEarnings);
      } catch {
        // Skip days with no data
      }
      currentDate.setDate(currentDate.getDate() + 1);
    }

    // Aggregate by market
    const marketEarnings = new Map<string, number>();
    let totalEarnings = 0;

    for (const e of earnings) {
      totalEarnings += e.earnings;
      const current = marketEarnings.get(e.conditionId) || 0;
      marketEarnings.set(e.conditionId, current + e.earnings);
    }

    // Find best market
    let bestMarket = { conditionId: '', earnings: 0 };
    for (const [conditionId, amount] of marketEarnings) {
      if (amount > bestMarket.earnings) {
        bestMarket = { conditionId, earnings: amount };
      }
    }

    const days = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)));

    return {
      startDate: start.toISOString().split('T')[0],
      endDate: end.toISOString().split('T')[0],
      totalEarnings,
      averageDailyEarnings: totalEarnings / days,
      marketCount: marketEarnings.size,
      bestMarket,
      totalDays: days,
    };
  }

  /**
   * Get top reward markets ranked by daily rate
   *
   * Useful for finding the most profitable markets to make.
   */
  async getTopRewardMarkets(limit: number = 10): Promise<TopRewardMarket[]> {
    const rewards = await this.getCurrentRewards();

    return rewards
      .filter(r => r.rewardsConfig.some(c => {
        const now = new Date();
        const start = new Date(c.startDate);
        const end = new Date(c.endDate);
        return now >= start && now <= end;
      }))
      .map(r => {
        const activeConfig = r.rewardsConfig.find(c => {
          const now = new Date();
          return now >= new Date(c.startDate) && now <= new Date(c.endDate);
        });

        return {
          conditionId: r.conditionId,
          question: r.question,
          marketSlug: r.marketSlug,
          dailyRate: activeConfig?.ratePerDay ?? 0,
          totalPool: activeConfig?.totalRewards ?? 0,
          maxSpread: r.rewardsMaxSpread,
          minSize: r.rewardsMinSize,
          // Recommend spread at 40% of max for good Q-Score
          recommendedSpread: r.rewardsMaxSpread * 0.4,
          tokens: r.tokens,
        };
      })
      .sort((a, b) => b.dailyRate - a.dailyRate)
      .slice(0, limit);
  }

  // ============================================================================
  // Balance & Allowance
  // ============================================================================

  async getBalanceAllowance(
    assetType: 'COLLATERAL' | 'CONDITIONAL',
    tokenId?: string
  ): Promise<{ balance: string; allowance: string }> {
    const client = await this.ensureInitialized();
    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      const result = await client.getBalanceAllowance({
        asset_type: assetType as any,
        token_id: tokenId,
      });
      const allowances = result.allowances ?? {};
      const allowance = Object.values(allowances).reduce((max, value) => {
        try {
          return BigInt(value) > BigInt(max) ? value : max;
        } catch {
          return max;
        }
      }, '0');
      return { balance: result.balance, allowance };
    });
  }

  async updateBalanceAllowance(
    assetType: 'COLLATERAL' | 'CONDITIONAL',
    tokenId?: string
  ): Promise<void> {
    const client = await this.ensureInitialized();
    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      await client.updateBalanceAllowance({
        asset_type: assetType as any,
        token_id: tokenId,
      });
    });
  }

  // ============================================================================
  // Account Info
  // ============================================================================

  getAddress(): string {
    return this.wallet.address;
  }

  getWallet(): Wallet {
    return this.wallet;
  }

  getCredentials(): ApiCredentials | null {
    return this.credentials;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  getClobClient(): ClobClient | null {
    return this.clobClient;
  }

}

// ============================================================================
// Standalone Utilities
// ============================================================================

export interface BuilderKeyResult {
  /** L2 CLOB API credentials (derived or newly created) */
  clobCreds: ApiCredentials;
  /** L3 Builder API credentials */
  builderCreds: ApiCredentials;
}

/**
 * Create Builder API key for a wallet. Full code-based flow:
 *   L1 (EIP-712) → derive/create L2 CLOB creds → create L3 Builder key.
 *
 * No browser needed.
 */
export async function createBuilderApiKey(privateKey: string): Promise<BuilderKeyResult> {
  const wallet = new Wallet(privateKey);

  // Step 1: L1 auth → derive or create L2 CLOB credentials
  const l1Client = new ClobClient({
    host: CLOB_HOST,
    chain: POLYGON_MAINNET as Chain,
    signer: wallet,
  });

  let clobCreds: ApiCredentials;
  const derived = await l1Client.deriveApiKey();
  if (derived.key) {
    clobCreds = derived;
  } else {
    const created = await l1Client.createApiKey();
    if (!created.key) {
      throw new PolymarketError(
        ErrorCode.AUTH_FAILED,
        'Failed to derive or create CLOB API key. Wallet may not be registered on Polymarket.'
      );
    }
    clobCreds = created;
  }

  // Step 2: L2 auth → create L3 Builder API key
  const l2Client = new ClobClient({
    host: CLOB_HOST,
    chain: POLYGON_MAINNET as Chain,
    signer: wallet,
    creds: { key: clobCreds.key, secret: clobCreds.secret, passphrase: clobCreds.passphrase },
  });

  const builderCreds = await l2Client.createBuilderApiKey();
  if (!builderCreds.key) {
    throw new PolymarketError(
      ErrorCode.AUTH_FAILED,
      'Failed to create Builder API key.'
    );
  }

  return {
    clobCreds,
    builderCreds: { key: builderCreds.key, secret: builderCreds.secret, passphrase: builderCreds.passphrase },
  };
}
