/**
 * ArbitrageService - Real-time Arbitrage Detection and Execution
 *
 * Uses WebSocket for real-time orderbook monitoring and automatically
 * detects arbitrage opportunities in Polymarket binary markets.
 *
 * Strategy:
 * - Long Arb: Buy YES + NO (effective cost < $1) → Merge → $1 USDC
 * - Short Arb: Sell pre-held YES + NO tokens (effective revenue > $1)
 *
 * Features:
 * - Real-time orderbook monitoring via WebSocket
 * - Automatic arbitrage detection using effective prices
 * - Configurable profit threshold and trade sizes
 * - Auto-execute mode or event-based manual mode
 * - Balance tracking and position management
 *
 * Based on: scripts/arb/faze-bo3-arb.ts
 * Docs: docs/arbitrage.md
 */

import { EventEmitter } from 'events';
import {
  RealtimeServiceV2,
  type MarketSubscription,
  type OrderbookSnapshot,
} from './realtime-service-v2.js';
import { TradingService } from './trading-service.js';
import { MarketService } from './market-service.js';
import { CTFClient, type TokenIds } from '../clients/ctf-client.js';
import { GammaApiClient } from '../clients/gamma-api.js';
import { RateLimiter } from '../core/rate-limiter.js';
import { createUnifiedCache } from '../core/unified-cache.js';
import { getEffectivePrices } from '../utils/price-utils.js';
import type { BookUpdate } from '../core/types.js';

// ===== Types =====

export interface ArbitrageMarketConfig {
  /** Market name for logging */
  name: string;
  /** Condition ID */
  conditionId: string;
  /** YES token ID from CLOB API */
  yesTokenId: string;
  /** NO token ID from CLOB API */
  noTokenId: string;
  /** Outcome names [YES, NO] */
  outcomes?: [string, string];
}

export interface ArbitrageServiceConfig {
  /** Private key for trading (optional for monitor-only mode) */
  privateKey?: string;
  /** RPC URL for CTF operations */
  rpcUrl?: string;
  /** Funder address for proxy wallet (optional) */
  funderAddress?: string;
  /** Minimum profit threshold (default: 0.005 = 0.5%) */
  profitThreshold?: number;
  /** Minimum trade size in USDC (default: 5) */
  minTradeSize?: number;
  /** Maximum single trade size in USDC (default: 100) */
  maxTradeSize?: number;
  /** Minimum token reserve for short arb (default: 10) */
  minTokenReserve?: number;
  /** Auto-execute mode (default: false) */
  autoExecute?: boolean;
  /** Enable logging (default: true) */
  enableLogging?: boolean;
  /** Cooldown between executions in ms (default: 5000) */
  executionCooldown?: number;

  // ===== Rebalancer Config =====
  /** Enable auto-rebalancing (default: false) */
  enableRebalancer?: boolean;
  /** Minimum USDC ratio 0-1 (default: 0.2 = 20%) - Split if below */
  minUsdcRatio?: number;
  /** Maximum USDC ratio 0-1 (default: 0.8 = 80%) - Merge if above */
  maxUsdcRatio?: number;
  /** Target USDC ratio when rebalancing (default: 0.5 = 50%) */
  targetUsdcRatio?: number;
  /** Max YES/NO imbalance before auto-fix (default: 5 tokens) */
  imbalanceThreshold?: number;
  /** Rebalance check interval in ms (default: 10000) */
  rebalanceInterval?: number;
  /** Minimum cooldown between rebalance actions in ms (default: 30000) */
  rebalanceCooldown?: number;
  /** Size safety factor 0-1 (default: 0.8) - use only 80% of orderbook depth to prevent partial fills */
  sizeSafetyFactor?: number;
  /** Auto-fix imbalance after failed execution (default: true) */
  autoFixImbalance?: boolean;
}

export interface RebalanceAction {
  type: 'split' | 'merge' | 'sell_yes' | 'sell_no' | 'none';
  amount: number;
  reason: string;
  priority: number;
}

export interface RebalanceResult {
  success: boolean;
  action: RebalanceAction;
  txHash?: string;
  error?: string;
}

export interface SettleResult {
  market: ArbitrageMarketConfig;
  yesBalance: number;
  noBalance: number;
  pairedTokens: number;
  unpairedYes: number;
  unpairedNo: number;
  merged: boolean;
  mergeAmount?: number;
  mergeTxHash?: string;
  usdcRecovered?: number;
  error?: string;
}

export interface ClearPositionResult {
  market: ArbitrageMarketConfig;
  marketStatus: 'active' | 'resolved' | 'unknown';
  yesBalance: number;
  noBalance: number;
  actions: ClearAction[];
  totalUsdcRecovered: number;
  success: boolean;
  error?: string;
}

export interface ClearAction {
  type: 'merge' | 'sell_yes' | 'sell_no' | 'redeem';
  amount: number;
  usdcResult: number;
  txHash?: string;
  success: boolean;
  error?: string;
}

// ===== Market Scanning Types =====

export interface ScanCriteria {
  /** Minimum 24h volume in USDC (default: 1000) */
  minVolume24h?: number;
  /** Maximum 24h volume (optional) */
  maxVolume24h?: number;
  /** Keywords to filter markets (optional) */
  keywords?: string[];
  /** Maximum number of markets to scan (default: 100) */
  limit?: number;
}

export interface ScanResult {
  /** Market config ready to use with start() */
  market: ArbitrageMarketConfig;
  /** Best arbitrage type */
  arbType: 'long' | 'short' | 'none';
  /** Profit rate (e.g., 0.01 = 1%) */
  profitRate: number;
  /** Profit percentage */
  profitPercent: number;
  /** Effective prices */
  effectivePrices: {
    buyYes: number;
    buyNo: number;
    sellYes: number;
    sellNo: number;
    longCost: number;
    shortRevenue: number;
  };
  /** 24h volume */
  volume24h: number;
  /** Available size on orderbook */
  availableSize: number;
  /** Score 0-100 */
  score: number;
  /** Description */
  description: string;
}

export interface OrderbookState {
  yesBids: Array<{ price: number; size: number }>;
  yesAsks: Array<{ price: number; size: number }>;
  noBids: Array<{ price: number; size: number }>;
  noAsks: Array<{ price: number; size: number }>;
  lastUpdate: number;
}

export interface BalanceState {
  usdc: number;
  yesTokens: number;
  noTokens: number;
  lastUpdate: number;
}

export interface ArbitrageOpportunity {
  type: 'long' | 'short';
  /** Profit rate (0.01 = 1%) */
  profitRate: number;
  /** Profit in percentage */
  profitPercent: number;
  /** Effective buy/sell prices */
  effectivePrices: {
    buyYes: number;
    buyNo: number;
    sellYes: number;
    sellNo: number;
  };
  /** Maximum executable size based on orderbook depth */
  maxOrderbookSize: number;
  /** Maximum executable size based on balance */
  maxBalanceSize: number;
  /** Recommended trade size */
  recommendedSize: number;
  /** Estimated profit in USDC */
  estimatedProfit: number;
  /** Description */
  description: string;
  /** Timestamp */
  timestamp: number;
}

export interface ArbitrageExecutionResult {
  success: boolean;
  type: 'long' | 'short';
  size: number;
  profit: number;
  txHashes: string[];
  error?: string;
  executionTimeMs: number;
}

export interface ArbitrageServiceEvents {
  opportunity: (opportunity: ArbitrageOpportunity) => void;
  execution: (result: ArbitrageExecutionResult) => void;
  balanceUpdate: (balance: BalanceState) => void;
  orderbookUpdate: (orderbook: OrderbookState) => void;
  rebalance: (result: RebalanceResult) => void;
  settle: (result: SettleResult) => void;
  error: (error: Error) => void;
  started: (market: ArbitrageMarketConfig) => void;
  stopped: () => void;
}

// ===== ArbitrageService =====

export class ArbitrageService extends EventEmitter {
  private realtimeService: RealtimeServiceV2;
  private marketSubscription: MarketSubscription | null = null;
  private ctf: CTFClient | null = null;
  private tradingService: TradingService | null = null;
  private rateLimiter: RateLimiter;

  private market: ArbitrageMarketConfig | null = null;
  private config: Omit<Required<ArbitrageServiceConfig>, 'privateKey' | 'rpcUrl' | 'rebalanceInterval'> & {
    privateKey?: string;
    rpcUrl?: string;
    rebalanceIntervalMs: number;
  };

  private orderbook: OrderbookState = {
    yesBids: [],
    yesAsks: [],
    noBids: [],
    noAsks: [],
    lastUpdate: 0,
  };

  private balance: BalanceState = {
    usdc: 0,
    yesTokens: 0,
    noTokens: 0,
    lastUpdate: 0,
  };

  private isExecuting = false;
  private lastExecutionTime = 0;
  private lastRebalanceTime = 0;
  private balanceUpdateInterval: ReturnType<typeof setInterval> | null = null;
  private rebalanceInterval: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;
  private totalCapital = 0;

  // Statistics
  private stats = {
    opportunitiesDetected: 0,
    executionsAttempted: 0,
    executionsSucceeded: 0,
    totalProfit: 0,
    startTime: 0,
  };

  constructor(config: ArbitrageServiceConfig = {}) {
    super();

    this.config = {
      privateKey: config.privateKey,
      rpcUrl: config.rpcUrl || 'https://polygon-rpc.com',
      profitThreshold: config.profitThreshold ?? 0.005,
      minTradeSize: config.minTradeSize ?? 5,
      maxTradeSize: config.maxTradeSize ?? 100,
      minTokenReserve: config.minTokenReserve ?? 10,
      autoExecute: config.autoExecute ?? false,
      enableLogging: config.enableLogging ?? true,
      executionCooldown: config.executionCooldown ?? 5000,
      // Rebalancer config
      enableRebalancer: config.enableRebalancer ?? false,
      minUsdcRatio: config.minUsdcRatio ?? 0.2,
      maxUsdcRatio: config.maxUsdcRatio ?? 0.8,
      targetUsdcRatio: config.targetUsdcRatio ?? 0.5,
      imbalanceThreshold: config.imbalanceThreshold ?? 5,
      rebalanceIntervalMs: config.rebalanceInterval ?? 10000,
      rebalanceCooldown: config.rebalanceCooldown ?? 30000,
      // Execution safety
      sizeSafetyFactor: config.sizeSafetyFactor ?? 0.8,
      autoFixImbalance: config.autoFixImbalance ?? true,
    };

    this.rateLimiter = new RateLimiter();
    this.realtimeService = new RealtimeServiceV2({ debug: false });

    // Initialize trading clients if private key provided
    if (this.config.privateKey) {
      this.ctf = new CTFClient({
        privateKey: this.config.privateKey,
        rpcUrl: this.config.rpcUrl,
      });

      const cache = createUnifiedCache();
      this.tradingService = new TradingService(this.rateLimiter, cache, {
        privateKey: this.config.privateKey,
        chainId: 137,
        funderAddress: this.config.funderAddress,
      });
    }

    // RealtimeServiceV2 event handlers are set up during subscription
  }

  // ===== Public API =====

  /**
   * Start monitoring a market for arbitrage opportunities
   */
  async start(market: ArbitrageMarketConfig): Promise<void> {
    if (this.isRunning) {
      throw new Error('ArbitrageService is already running. Call stop() first.');
    }

    this.market = market;
    this.isRunning = true;
    this.stats.startTime = Date.now();

    this.log(`Starting arbitrage monitor for: ${market.name}`);
    this.log(`Condition ID: ${market.conditionId.slice(0, 20)}...`);
    this.log(`Profit Threshold: ${(this.config.profitThreshold * 100).toFixed(2)}%`);
    this.log(`Auto Execute: ${this.config.autoExecute ? 'YES' : 'NO'}`);

    // Initialize trading service
    if (this.tradingService) {
      await this.tradingService.initialize();
      this.log(`Wallet: ${this.ctf?.getAddress()}`);
      await this.updateBalance();
      this.log(`USDC Balance: ${this.balance.usdc.toFixed(2)}`);
      this.log(`YES Tokens: ${this.balance.yesTokens.toFixed(2)}`);
      this.log(`NO Tokens: ${this.balance.noTokens.toFixed(2)}`);

      // Calculate total capital (USDC + paired tokens)
      const pairedTokens = Math.min(this.balance.yesTokens, this.balance.noTokens);
      this.totalCapital = this.balance.usdc + pairedTokens;
      this.log(`Total Capital: ${this.totalCapital.toFixed(2)}`);

      // Start balance update interval
      this.balanceUpdateInterval = setInterval(() => this.updateBalance(), 30000);

      // Start rebalancer if enabled
      if (this.config.enableRebalancer) {
        this.log(`Rebalancer: ENABLED (USDC range: ${(this.config.minUsdcRatio * 100).toFixed(0)}%-${(this.config.maxUsdcRatio * 100).toFixed(0)}%, target: ${(this.config.targetUsdcRatio * 100).toFixed(0)}%)`);
        this.rebalanceInterval = setInterval(
          () => this.checkAndRebalance(),
          this.config.rebalanceIntervalMs
        );
      }
    } else {
      this.log('No wallet configured - monitoring only');
    }

    // Connect and subscribe to WebSocket
    this.realtimeService.connect();
    this.marketSubscription = this.realtimeService.subscribeMarkets(
      [market.yesTokenId, market.noTokenId],
      {
        onOrderbook: (book: OrderbookSnapshot) => {
          // Convert OrderbookSnapshot to BookUpdate format
          const bookUpdate: BookUpdate = {
            assetId: book.assetId,
            bids: book.bids,
            asks: book.asks,
            timestamp: book.timestamp,
          };
          this.handleBookUpdate(bookUpdate);
        },
        onError: (error: Error) => this.emit('error', error),
      }
    );

    this.emit('started', market);
    this.log('Monitoring for arbitrage opportunities...');
  }

  /**
   * Stop monitoring
   */
  async stop(): Promise<void> {
    if (!this.isRunning) return;

    this.isRunning = false;

    if (this.balanceUpdateInterval) {
      clearInterval(this.balanceUpdateInterval);
      this.balanceUpdateInterval = null;
    }

    if (this.rebalanceInterval) {
      clearInterval(this.rebalanceInterval);
      this.rebalanceInterval = null;
    }

    // Unsubscribe and disconnect
    if (this.marketSubscription) {
      this.marketSubscription.unsubscribe();
      this.marketSubscription = null;
    }
    this.realtimeService.disconnect();

    this.log('Stopped');
    this.log(`Total opportunities: ${this.stats.opportunitiesDetected}`);
    this.log(`Executions: ${this.stats.executionsSucceeded}/${this.stats.executionsAttempted}`);
    this.log(`Total profit: $${this.stats.totalProfit.toFixed(2)}`);

    this.emit('stopped');
  }

  /**
   * Get current orderbook state
   */
  getOrderbook(): OrderbookState {
    return { ...this.orderbook };
  }

  /**
   * Get current balance state
   */
  getBalance(): BalanceState {
    return { ...this.balance };
  }

  /**
   * Get statistics
   */
  getStats() {
    return {
      ...this.stats,
      runningTimeMs: this.isRunning ? Date.now() - this.stats.startTime : 0,
    };
  }

  /**
   * Check for arbitrage opportunity based on current orderbook
   */
  checkOpportunity(): ArbitrageOpportunity | null {
    if (!this.market) return null;

    const { yesBids, yesAsks, noBids, noAsks } = this.orderbook;
    if (yesBids.length === 0 || yesAsks.length === 0 || noBids.length === 0 || noAsks.length === 0) {
      return null;
    }

    const yesBestBid = yesBids[0]?.price || 0;
    const yesBestAsk = yesAsks[0]?.price || 1;
    const noBestBid = noBids[0]?.price || 0;
    const noBestAsk = noAsks[0]?.price || 1;

    // Calculate effective prices
    const effective = getEffectivePrices(yesBestAsk, yesBestBid, noBestAsk, noBestBid);

    // Check for arbitrage
    const longCost = effective.effectiveBuyYes + effective.effectiveBuyNo;
    const longProfit = 1 - longCost;
    const shortRevenue = effective.effectiveSellYes + effective.effectiveSellNo;
    const shortProfit = shortRevenue - 1;

    // Calculate sizes with safety factor to prevent partial fills
    // Use min of both sides * safety factor to ensure both orders can fill
    const safetyFactor = this.config.sizeSafetyFactor;
    const orderbookLongSize = Math.min(yesAsks[0]?.size || 0, noAsks[0]?.size || 0) * safetyFactor;
    const orderbookShortSize = Math.min(yesBids[0]?.size || 0, noBids[0]?.size || 0) * safetyFactor;
    const heldPairs = Math.min(this.balance.yesTokens, this.balance.noTokens);
    const balanceLongSize = longCost > 0 ? this.balance.usdc / longCost : 0;

    // Check long arb
    if (longProfit > this.config.profitThreshold) {
      const maxSize = Math.min(orderbookLongSize, balanceLongSize * safetyFactor, this.config.maxTradeSize);
      if (maxSize >= this.config.minTradeSize) {
        return {
          type: 'long',
          profitRate: longProfit,
          profitPercent: longProfit * 100,
          effectivePrices: {
            buyYes: effective.effectiveBuyYes,
            buyNo: effective.effectiveBuyNo,
            sellYes: effective.effectiveSellYes,
            sellNo: effective.effectiveSellNo,
          },
          maxOrderbookSize: orderbookLongSize,
          maxBalanceSize: balanceLongSize,
          recommendedSize: maxSize,
          estimatedProfit: longProfit * maxSize,
          description: `Buy YES @ ${effective.effectiveBuyYes.toFixed(4)} + NO @ ${effective.effectiveBuyNo.toFixed(4)}, Merge for $1`,
          timestamp: Date.now(),
        };
      }
    }

    // Check short arb
    if (shortProfit > this.config.profitThreshold) {
      const maxSize = Math.min(orderbookShortSize, heldPairs, this.config.maxTradeSize);
      if (maxSize >= this.config.minTradeSize && heldPairs >= this.config.minTokenReserve) {
        return {
          type: 'short',
          profitRate: shortProfit,
          profitPercent: shortProfit * 100,
          effectivePrices: {
            buyYes: effective.effectiveBuyYes,
            buyNo: effective.effectiveBuyNo,
            sellYes: effective.effectiveSellYes,
            sellNo: effective.effectiveSellNo,
          },
          maxOrderbookSize: orderbookShortSize,
          maxBalanceSize: heldPairs,
          recommendedSize: maxSize,
          estimatedProfit: shortProfit * maxSize,
          description: `Sell YES @ ${effective.effectiveSellYes.toFixed(4)} + NO @ ${effective.effectiveSellNo.toFixed(4)}`,
          timestamp: Date.now(),
        };
      }
    }

    return null;
  }

  /**
   * Manually execute an arbitrage opportunity
   */
  async execute(opportunity: ArbitrageOpportunity): Promise<ArbitrageExecutionResult> {
    if (!this.ctf || !this.tradingService || !this.market) {
      return {
        success: false,
        type: opportunity.type,
        size: 0,
        profit: 0,
        txHashes: [],
        error: 'Trading not configured (no private key)',
        executionTimeMs: 0,
      };
    }

    if (this.isExecuting) {
      return {
        success: false,
        type: opportunity.type,
        size: 0,
        profit: 0,
        txHashes: [],
        error: 'Another execution in progress',
        executionTimeMs: 0,
      };
    }

    this.isExecuting = true;
    this.stats.executionsAttempted++;
    const startTime = Date.now();

    try {
      const result = opportunity.type === 'long'
        ? await this.executeLongArb(opportunity)
        : await this.executeShortArb(opportunity);

      if (result.success) {
        this.stats.executionsSucceeded++;
        this.stats.totalProfit += result.profit;
        this.lastExecutionTime = Date.now();
      }

      this.emit('execution', result);
      return result;
    } finally {
      this.isExecuting = false;
      // Update balance after execution
      await this.updateBalance();
    }
  }

  // ===== Rebalancer Methods =====

  /**
   * Calculate recommended rebalance action based on current state
   */
  calculateRebalanceAction(): RebalanceAction {
    if (!this.market || this.totalCapital === 0) {
      return { type: 'none', amount: 0, reason: 'No market or capital', priority: 0 };
    }

    const { usdc, yesTokens, noTokens } = this.balance;
    const pairedTokens = Math.min(yesTokens, noTokens);
    const currentTotal = usdc + pairedTokens;
    const usdcRatio = usdc / currentTotal;
    const tokenImbalance = yesTokens - noTokens;

    // Priority 1: Fix YES/NO imbalance (highest priority - risk control)
    if (Math.abs(tokenImbalance) > this.config.imbalanceThreshold) {
      if (tokenImbalance > 0) {
        const sellAmount = Math.min(tokenImbalance, yesTokens * 0.5);
        if (sellAmount >= this.config.minTradeSize) {
          return {
            type: 'sell_yes',
            amount: Math.floor(sellAmount * 1e6) / 1e6,
            reason: `Risk: YES > NO by ${tokenImbalance.toFixed(2)}`,
            priority: 100,
          };
        }
      } else {
        const sellAmount = Math.min(-tokenImbalance, noTokens * 0.5);
        if (sellAmount >= this.config.minTradeSize) {
          return {
            type: 'sell_no',
            amount: Math.floor(sellAmount * 1e6) / 1e6,
            reason: `Risk: NO > YES by ${(-tokenImbalance).toFixed(2)}`,
            priority: 100,
          };
        }
      }
    }

    // Priority 2: USDC ratio too high (> maxUsdcRatio) → Split to create tokens
    if (usdcRatio > this.config.maxUsdcRatio) {
      const targetUsdc = this.totalCapital * this.config.targetUsdcRatio;
      const excessUsdc = usdc - targetUsdc;
      const splitAmount = Math.min(excessUsdc * 0.5, usdc * 0.3);
      if (splitAmount >= this.config.minTradeSize) {
        return {
          type: 'split',
          amount: Math.floor(splitAmount * 100) / 100,
          reason: `USDC ${(usdcRatio * 100).toFixed(0)}% > ${(this.config.maxUsdcRatio * 100).toFixed(0)}% max`,
          priority: 50,
        };
      }
    }

    // Priority 3: USDC ratio too low (< minUsdcRatio) → Merge tokens to recover USDC
    if (usdcRatio < this.config.minUsdcRatio && pairedTokens >= this.config.minTradeSize) {
      const targetUsdc = this.totalCapital * this.config.targetUsdcRatio;
      const neededUsdc = targetUsdc - usdc;
      const mergeAmount = Math.min(neededUsdc * 0.5, pairedTokens * 0.5);
      if (mergeAmount >= this.config.minTradeSize) {
        return {
          type: 'merge',
          amount: Math.floor(mergeAmount * 100) / 100,
          reason: `USDC ${(usdcRatio * 100).toFixed(0)}% < ${(this.config.minUsdcRatio * 100).toFixed(0)}% min`,
          priority: 50,
        };
      }
    }

    return { type: 'none', amount: 0, reason: 'Balanced', priority: 0 };
  }

  /**
   * Execute a rebalance action
   */
  async rebalance(action?: RebalanceAction): Promise<RebalanceResult> {
    if (!this.ctf || !this.tradingService || !this.market) {
      return {
        success: false,
        action: action || { type: 'none', amount: 0, reason: 'No trading config', priority: 0 },
        error: 'Trading not configured',
      };
    }

    const rebalanceAction = action || this.calculateRebalanceAction();
    if (rebalanceAction.type === 'none') {
      return { success: true, action: rebalanceAction };
    }

    this.log(`\n🔄 Rebalance: ${rebalanceAction.type.toUpperCase()} ${rebalanceAction.amount.toFixed(2)}`);
    this.log(`   Reason: ${rebalanceAction.reason}`);

    try {
      let txHash: string | undefined;

      switch (rebalanceAction.type) {
        case 'split': {
          const result = await this.ctf.split(this.market.conditionId, rebalanceAction.amount.toString());
          txHash = result.txHash;
          this.log(`   ✅ Split TX: ${txHash}`);
          break;
        }
        case 'merge': {
          const tokenIds: TokenIds = {
            yesTokenId: this.market.yesTokenId,
            noTokenId: this.market.noTokenId,
          };
          const result = await this.ctf.mergeByTokenIds(
            this.market.conditionId,
            tokenIds,
            rebalanceAction.amount.toString()
          );
          txHash = result.txHash;
          this.log(`   ✅ Merge TX: ${txHash}`);
          break;
        }
        case 'sell_yes': {
          const result = await this.tradingService.createMarketOrder({
            tokenId: this.market.yesTokenId,
            side: 'SELL',
            amount: rebalanceAction.amount,
            orderType: 'FOK',
          });
          if (!result.success) {
            throw new Error(result.errorMsg || 'Sell YES failed');
          }
          this.log(`   ✅ Sold ${rebalanceAction.amount.toFixed(2)} YES tokens`);
          break;
        }
        case 'sell_no': {
          const result = await this.tradingService.createMarketOrder({
            tokenId: this.market.noTokenId,
            side: 'SELL',
            amount: rebalanceAction.amount,
            orderType: 'FOK',
          });
          if (!result.success) {
            throw new Error(result.errorMsg || 'Sell NO failed');
          }
          this.log(`   ✅ Sold ${rebalanceAction.amount.toFixed(2)} NO tokens`);
          break;
        }
      }

      await this.updateBalance();
      const rebalanceResult: RebalanceResult = { success: true, action: rebalanceAction, txHash };
      this.emit('rebalance', rebalanceResult);
      return rebalanceResult;
    } catch (error: any) {
      this.log(`   ❌ Failed: ${error.message}`);
      const rebalanceResult: RebalanceResult = {
        success: false,
        action: rebalanceAction,
        error: error.message,
      };
      this.emit('rebalance', rebalanceResult);
      return rebalanceResult;
    }
  }

  // ===== Settle Position Methods =====

  /**
   * Settle a market position - merge paired tokens to recover USDC
   * @param market Market to settle (defaults to current market)
   * @param execute If true, execute the merge. If false, just return info.
   */
  async settlePosition(market?: ArbitrageMarketConfig, execute = false): Promise<SettleResult> {
    const targetMarket = market || this.market;
    if (!targetMarket) {
      throw new Error('No market specified');
    }

    if (!this.ctf) {
      return {
        market: targetMarket,
        yesBalance: 0,
        noBalance: 0,
        pairedTokens: 0,
        unpairedYes: 0,
        unpairedNo: 0,
        merged: false,
        error: 'CTF client not configured',
      };
    }

    const tokenIds: TokenIds = {
      yesTokenId: targetMarket.yesTokenId,
      noTokenId: targetMarket.noTokenId,
    };

    // Get token balances
    const positions = await this.ctf.getPositionBalanceByTokenIds(targetMarket.conditionId, tokenIds);
    const yesBalance = parseFloat(positions.yesBalance);
    const noBalance = parseFloat(positions.noBalance);

    const pairedTokens = Math.min(yesBalance, noBalance);
    const unpairedYes = yesBalance - pairedTokens;
    const unpairedNo = noBalance - pairedTokens;

    this.log(`\n📊 Position: ${targetMarket.name}`);
    this.log(`   YES: ${yesBalance.toFixed(6)}`);
    this.log(`   NO: ${noBalance.toFixed(6)}`);
    this.log(`   Paired: ${pairedTokens.toFixed(6)} (can merge → $${pairedTokens.toFixed(2)} USDC)`);

    if (unpairedYes > 0.001) {
      this.log(`   ⚠️ Unpaired YES: ${unpairedYes.toFixed(6)}`);
    }
    if (unpairedNo > 0.001) {
      this.log(`   ⚠️ Unpaired NO: ${unpairedNo.toFixed(6)}`);
    }

    const result: SettleResult = {
      market: targetMarket,
      yesBalance,
      noBalance,
      pairedTokens,
      unpairedYes,
      unpairedNo,
      merged: false,
    };

    // Execute merge if requested and we have enough pairs
    if (execute && pairedTokens >= 1) {
      const mergeAmount = Math.floor(pairedTokens * 1e6) / 1e6;
      this.log(`\n🔄 Merging ${mergeAmount.toFixed(6)} token pairs...`);

      try {
        const mergeResult = await this.ctf.mergeByTokenIds(
          targetMarket.conditionId,
          tokenIds,
          mergeAmount.toString()
        );
        result.merged = true;
        result.mergeAmount = mergeAmount;
        result.mergeTxHash = mergeResult.txHash;
        result.usdcRecovered = mergeAmount;
        this.log(`   ✅ Merge TX: ${mergeResult.txHash}`);
        this.log(`   ✅ Recovered: $${mergeAmount.toFixed(2)} USDC`);
      } catch (error: any) {
        result.error = error.message;
        this.log(`   ❌ Merge failed: ${error.message}`);
      }
    } else if (pairedTokens >= 1) {
      this.log(`   💡 Run settlePosition(market, true) to recover $${pairedTokens.toFixed(2)} USDC`);
    }

    this.emit('settle', result);
    return result;
  }

  /**
   * Settle multiple markets at once
   */
  async settleMultiple(markets: ArbitrageMarketConfig[], execute = false): Promise<SettleResult[]> {
    const results: SettleResult[] = [];
    let totalMerged = 0;
    let totalUnpairedYes = 0;
    let totalUnpairedNo = 0;

    for (const market of markets) {
      const result = await this.settlePosition(market, execute);
      results.push(result);
      if (result.usdcRecovered) totalMerged += result.usdcRecovered;
      totalUnpairedYes += result.unpairedYes;
      totalUnpairedNo += result.unpairedNo;
    }

    this.log(`\n═══════════════════════════════════════`);
    this.log(`SUMMARY: ${markets.length} markets`);
    if (execute) {
      this.log(`Total Merged: $${totalMerged.toFixed(2)} USDC`);
    }
    if (totalUnpairedYes > 0.001 || totalUnpairedNo > 0.001) {
      this.log(`Unpaired YES: ${totalUnpairedYes.toFixed(6)}`);
      this.log(`Unpaired NO: ${totalUnpairedNo.toFixed(6)}`);
    }

    return results;
  }

  /**
   * Clear all positions in a market using the best strategy
   *
   * Strategy:
   * - Active market: Merge paired tokens → Sell remaining unpaired tokens
   * - Resolved market: Redeem winning tokens
   *
   * @param market Market to clear positions from
   * @param execute If true, execute the clearing. If false, just return info.
   * @returns Result with all actions taken
   *
   * @example
   * ```typescript
   * const service = new ArbitrageService({ privateKey: '0x...' });
   *
   * // View clearing plan
   * const plan = await service.clearPositions(market, false);
   * console.log(`Will recover: $${plan.totalUsdcRecovered}`);
   *
   * // Execute clearing
   * const result = await service.clearPositions(market, true);
   * ```
   */
  async clearPositions(market: ArbitrageMarketConfig, execute = false): Promise<ClearPositionResult> {
    if (!this.ctf) {
      return {
        market,
        marketStatus: 'unknown',
        yesBalance: 0,
        noBalance: 0,
        actions: [],
        totalUsdcRecovered: 0,
        success: false,
        error: 'CTF client not configured',
      };
    }

    const tokenIds: TokenIds = {
      yesTokenId: market.yesTokenId,
      noTokenId: market.noTokenId,
    };

    // Get token balances
    const positions = await this.ctf.getPositionBalanceByTokenIds(market.conditionId, tokenIds);
    const yesBalance = parseFloat(positions.yesBalance);
    const noBalance = parseFloat(positions.noBalance);

    if (yesBalance < 0.001 && noBalance < 0.001) {
      this.log(`No positions to clear for ${market.name}`);
      return {
        market,
        marketStatus: 'unknown',
        yesBalance,
        noBalance,
        actions: [],
        totalUsdcRecovered: 0,
        success: true,
      };
    }

    this.log(`\n🧹 Clearing positions: ${market.name}`);
    this.log(`   YES: ${yesBalance.toFixed(6)}, NO: ${noBalance.toFixed(6)}`);

    // Check if market is resolved
    let marketStatus: 'active' | 'resolved' | 'unknown' = 'unknown';
    // winningOutcome can be any outcome name (YES/NO, Up/Down, Team1/Team2, etc.)
    let winningOutcome: string | undefined;

    try {
      const resolution = await this.ctf.getMarketResolution(market.conditionId);
      marketStatus = resolution.isResolved ? 'resolved' : 'active';
      winningOutcome = resolution.winningOutcome;
      this.log(`   Status: ${marketStatus}${resolution.isResolved ? ` (Winner: ${winningOutcome})` : ''}`);
    } catch {
      // If we can't determine resolution, try to get market status from MarketService
      try {
        const cache = createUnifiedCache();
        const tempMarketService = new MarketService(undefined, undefined, this.rateLimiter, cache);
        const clobMarket = await tempMarketService.getClobMarket(market.conditionId);
        if (clobMarket) {
          marketStatus = clobMarket.closed ? 'resolved' : 'active';
          this.log(`   Status: ${marketStatus} (from MarketService)`);
        } else {
          this.log(`   Status: unknown (market not found, assuming active)`);
          marketStatus = 'active';
        }
      } catch {
        this.log(`   Status: unknown (assuming active)`);
        marketStatus = 'active';
      }
    }

    const actions: ClearAction[] = [];
    let totalUsdcRecovered = 0;

    if (!execute) {
      // Dry run - calculate expected actions
      if (marketStatus === 'resolved' && winningOutcome) {
        // Resolved market: redeem winning tokens
        const winningBalance = winningOutcome === 'YES' ? yesBalance : noBalance;
        if (winningBalance >= 0.001) {
          actions.push({
            type: 'redeem',
            amount: winningBalance,
            usdcResult: winningBalance, // 1 USDC per winning token
            success: true,
          });
          totalUsdcRecovered = winningBalance;
        }
      } else {
        // Active market: merge + sell
        const pairedTokens = Math.min(yesBalance, noBalance);
        const unpairedYes = yesBalance - pairedTokens;
        const unpairedNo = noBalance - pairedTokens;

        if (pairedTokens >= 1) {
          actions.push({
            type: 'merge',
            amount: pairedTokens,
            usdcResult: pairedTokens,
            success: true,
          });
          totalUsdcRecovered += pairedTokens;
        }

        // For unpaired tokens, estimate sell price (assume ~0.5 if unknown)
        if (unpairedYes >= this.config.minTradeSize) {
          const estimatedPrice = 0.5; // Conservative estimate
          actions.push({
            type: 'sell_yes',
            amount: unpairedYes,
            usdcResult: unpairedYes * estimatedPrice,
            success: true,
          });
          totalUsdcRecovered += unpairedYes * estimatedPrice;
        }

        if (unpairedNo >= this.config.minTradeSize) {
          const estimatedPrice = 0.5;
          actions.push({
            type: 'sell_no',
            amount: unpairedNo,
            usdcResult: unpairedNo * estimatedPrice,
            success: true,
          });
          totalUsdcRecovered += unpairedNo * estimatedPrice;
        }
      }

      this.log(`   📋 Plan: ${actions.length} actions, ~$${totalUsdcRecovered.toFixed(2)} USDC`);
      for (const action of actions) {
        this.log(`      - ${action.type}: ${action.amount.toFixed(4)} → ~$${action.usdcResult.toFixed(2)}`);
      }

      return {
        market,
        marketStatus,
        yesBalance,
        noBalance,
        actions,
        totalUsdcRecovered,
        success: true,
      };
    }

    // Execute clearing
    this.log(`   🔄 Executing...`);

    if (marketStatus === 'resolved' && winningOutcome) {
      // Resolved market: redeem
      const winningBalance = winningOutcome === 'YES' ? yesBalance : noBalance;
      if (winningBalance >= 0.001) {
        try {
          const redeemResult = await this.ctf.redeem(market.conditionId);
          actions.push({
            type: 'redeem',
            amount: winningBalance,
            usdcResult: winningBalance,
            txHash: redeemResult.txHash,
            success: true,
          });
          totalUsdcRecovered = winningBalance;
          this.log(`   ✅ Redeemed: ${winningBalance.toFixed(4)} tokens → $${winningBalance.toFixed(2)} USDC`);
        } catch (error: any) {
          actions.push({
            type: 'redeem',
            amount: winningBalance,
            usdcResult: 0,
            success: false,
            error: error.message,
          });
          this.log(`   ❌ Redeem failed: ${error.message}`);
        }
      }
    } else {
      // Active market: merge + sell
      const pairedTokens = Math.min(yesBalance, noBalance);
      let unpairedYes = yesBalance - pairedTokens;
      let unpairedNo = noBalance - pairedTokens;

      // Step 1: Merge paired tokens
      if (pairedTokens >= 1) {
        const mergeAmount = Math.floor(pairedTokens * 1e6) / 1e6;
        try {
          const mergeResult = await this.ctf.mergeByTokenIds(
            market.conditionId,
            tokenIds,
            mergeAmount.toString()
          );
          actions.push({
            type: 'merge',
            amount: mergeAmount,
            usdcResult: mergeAmount,
            txHash: mergeResult.txHash,
            success: true,
          });
          totalUsdcRecovered += mergeAmount;
          this.log(`   ✅ Merged: ${mergeAmount.toFixed(4)} pairs → $${mergeAmount.toFixed(2)} USDC`);
        } catch (error: any) {
          actions.push({
            type: 'merge',
            amount: mergeAmount,
            usdcResult: 0,
            success: false,
            error: error.message,
          });
          this.log(`   ❌ Merge failed: ${error.message}`);
          // Update unpaired amounts since merge failed
          unpairedYes = yesBalance;
          unpairedNo = noBalance;
        }
      }

      // Step 2: Sell unpaired tokens
      if (this.tradingService && unpairedYes >= this.config.minTradeSize) {
        try {
          const sellAmount = Math.floor(unpairedYes * 1e6) / 1e6;
          const result = await this.tradingService.createMarketOrder({
            tokenId: market.yesTokenId,
            side: 'SELL',
            amount: sellAmount,
            orderType: 'FOK',
          });
          if (result.success) {
            // Estimate USDC received (conservative estimate since we don't have exact trade info)
            const usdcReceived = sellAmount * 0.5; // Assume ~0.5 average price
            actions.push({
              type: 'sell_yes',
              amount: sellAmount,
              usdcResult: usdcReceived,
              success: true,
            });
            totalUsdcRecovered += usdcReceived;
            this.log(`   ✅ Sold YES: ${sellAmount.toFixed(4)} → ~$${usdcReceived.toFixed(2)} USDC`);
          } else {
            throw new Error(result.errorMsg || 'Sell failed');
          }
        } catch (error: any) {
          actions.push({
            type: 'sell_yes',
            amount: unpairedYes,
            usdcResult: 0,
            success: false,
            error: error.message,
          });
          this.log(`   ❌ Sell YES failed: ${error.message}`);
        }
      }

      if (this.tradingService && unpairedNo >= this.config.minTradeSize) {
        try {
          const sellAmount = Math.floor(unpairedNo * 1e6) / 1e6;
          const result = await this.tradingService.createMarketOrder({
            tokenId: market.noTokenId,
            side: 'SELL',
            amount: sellAmount,
            orderType: 'FOK',
          });
          if (result.success) {
            // Estimate USDC received (conservative estimate since we don't have exact trade info)
            const usdcReceived = sellAmount * 0.5; // Assume ~0.5 average price
            actions.push({
              type: 'sell_no',
              amount: sellAmount,
              usdcResult: usdcReceived,
              success: true,
            });
            totalUsdcRecovered += usdcReceived;
            this.log(`   ✅ Sold NO: ${sellAmount.toFixed(4)} → ~$${usdcReceived.toFixed(2)} USDC`);
          } else {
            throw new Error(result.errorMsg || 'Sell failed');
          }
        } catch (error: any) {
          actions.push({
            type: 'sell_no',
            amount: unpairedNo,
            usdcResult: 0,
            success: false,
            error: error.message,
          });
          this.log(`   ❌ Sell NO failed: ${error.message}`);
        }
      }
    }

    const allSuccess = actions.every((a) => a.success);
    this.log(`   📊 Result: ${actions.filter((a) => a.success).length}/${actions.length} succeeded, $${totalUsdcRecovered.toFixed(2)} recovered`);

    const result: ClearPositionResult = {
      market,
      marketStatus,
      yesBalance,
      noBalance,
      actions,
      totalUsdcRecovered,
      success: allSuccess,
    };

    this.emit('settle', result);
    return result;
  }

  /**
   * Clear positions from multiple markets
   *
   * @param markets Markets to clear
   * @param execute If true, execute clearing
   * @returns Results for all markets
   */
  async clearAllPositions(markets: ArbitrageMarketConfig[], execute = false): Promise<ClearPositionResult[]> {
    const results: ClearPositionResult[] = [];
    let totalRecovered = 0;

    this.log(`\n🧹 Clearing positions from ${markets.length} markets...`);

    for (const market of markets) {
      const result = await this.clearPositions(market, execute);
      results.push(result);
      totalRecovered += result.totalUsdcRecovered;
    }

    this.log(`\n═══════════════════════════════════════`);
    this.log(`TOTAL: $${totalRecovered.toFixed(2)} USDC ${execute ? 'recovered' : 'expected'}`);

    return results;
  }

  // ===== Private Methods =====

  private handleBookUpdate(update: BookUpdate): void {
    if (!this.market) return;

    const { assetId, bids, asks } = update;

    type PriceLevel = { price: number; size: number };
    if (assetId === this.market.yesTokenId) {
      this.orderbook.yesBids = bids.sort((a: PriceLevel, b: PriceLevel) => b.price - a.price);
      this.orderbook.yesAsks = asks.sort((a: PriceLevel, b: PriceLevel) => a.price - b.price);
    } else if (assetId === this.market.noTokenId) {
      this.orderbook.noBids = bids.sort((a: PriceLevel, b: PriceLevel) => b.price - a.price);
      this.orderbook.noAsks = asks.sort((a: PriceLevel, b: PriceLevel) => a.price - b.price);
    }

    this.orderbook.lastUpdate = Date.now();
    this.emit('orderbookUpdate', this.orderbook);

    // Check for arbitrage opportunity
    this.checkAndHandleOpportunity();
  }

  private checkAndHandleOpportunity(): void {
    const opportunity = this.checkOpportunity();

    if (opportunity) {
      this.stats.opportunitiesDetected++;
      this.emit('opportunity', opportunity);

      this.log(`\n${'!'.repeat(60)}`);
      this.log(`${opportunity.type.toUpperCase()} ARB: ${opportunity.description}`);
      this.log(`Profit: ${opportunity.profitPercent.toFixed(2)}%, Size: ${opportunity.recommendedSize.toFixed(2)}, Est: $${opportunity.estimatedProfit.toFixed(2)}`);
      this.log('!'.repeat(60));

      // Auto-execute if enabled and cooldown has passed
      if (this.config.autoExecute && !this.isExecuting) {
        const timeSinceLastExecution = Date.now() - this.lastExecutionTime;
        if (timeSinceLastExecution >= this.config.executionCooldown) {
          this.execute(opportunity).catch((error) => {
            this.emit('error', error);
          });
        }
      }
    }
  }

  private async checkAndRebalance(): Promise<void> {
    if (!this.isRunning || this.isExecuting) return;

    // Check cooldown
    const timeSinceLastRebalance = Date.now() - this.lastRebalanceTime;
    if (timeSinceLastRebalance < this.config.rebalanceCooldown) {
      return;
    }

    await this.updateBalance();
    const action = this.calculateRebalanceAction();

    if (action.type !== 'none' && action.amount >= this.config.minTradeSize) {
      await this.rebalance(action);
      this.lastRebalanceTime = Date.now();
    }
  }

  /**
   * Fix YES/NO imbalance immediately after partial execution
   * This is critical when one side of a parallel order fails
   */
  private async fixImbalanceIfNeeded(): Promise<void> {
    if (!this.config.autoFixImbalance || !this.ctf || !this.tradingService || !this.market) return;

    await this.updateBalance();
    const imbalance = this.balance.yesTokens - this.balance.noTokens;

    if (Math.abs(imbalance) <= this.config.imbalanceThreshold) return;

    this.log(`\n⚠️ Imbalance detected after execution: ${imbalance > 0 ? 'YES' : 'NO'} excess = ${Math.abs(imbalance).toFixed(2)}`);

    // Sell the excess tokens to restore balance
    const sellAmount = Math.floor(Math.abs(imbalance) * 0.9 * 1e6) / 1e6; // Sell 90% to be safe
    if (sellAmount < this.config.minTradeSize) return;

    try {
      if (imbalance > 0) {
        // Sell excess YES
        const result = await this.tradingService.createMarketOrder({
          tokenId: this.market.yesTokenId,
          side: 'SELL',
          amount: sellAmount,
          orderType: 'FOK',
        });
        if (result.success) {
          this.log(`   ✅ Sold ${sellAmount.toFixed(2)} excess YES to restore balance`);
        }
      } else {
        // Sell excess NO
        const result = await this.tradingService.createMarketOrder({
          tokenId: this.market.noTokenId,
          side: 'SELL',
          amount: sellAmount,
          orderType: 'FOK',
        });
        if (result.success) {
          this.log(`   ✅ Sold ${sellAmount.toFixed(2)} excess NO to restore balance`);
        }
      }
    } catch (error: any) {
      this.log(`   ❌ Failed to fix imbalance: ${error.message}`);
    }
  }

  private async updateBalance(): Promise<void> {
    if (!this.ctf || !this.market) return;

    try {
      const tokenIds: TokenIds = {
        yesTokenId: this.market.yesTokenId,
        noTokenId: this.market.noTokenId,
      };

      const [usdcBalance, positions] = await Promise.all([
        this.ctf.getUsdcBalance(),
        this.ctf.getPositionBalanceByTokenIds(this.market.conditionId, tokenIds),
      ]);

      this.balance = {
        usdc: parseFloat(usdcBalance),
        yesTokens: parseFloat(positions.yesBalance),
        noTokens: parseFloat(positions.noBalance),
        lastUpdate: Date.now(),
      };

      this.emit('balanceUpdate', this.balance);
    } catch (error) {
      this.emit('error', error as Error);
    }
  }

  private async executeLongArb(opportunity: ArbitrageOpportunity): Promise<ArbitrageExecutionResult> {
    const startTime = Date.now();
    const txHashes: string[] = [];
    const size = opportunity.recommendedSize;

    this.log(`\nExecuting Long Arb (Buy → Merge)...`);

    try {
      const { buyYes, buyNo } = opportunity.effectivePrices;
      const requiredUsdc = (buyYes + buyNo) * size;

      if (this.balance.usdc < requiredUsdc) {
        return {
          success: false,
          type: 'long',
          size,
          profit: 0,
          txHashes,
          error: `Insufficient USDC.e: have ${this.balance.usdc.toFixed(2)}, need ${requiredUsdc.toFixed(2)}`,
          executionTimeMs: Date.now() - startTime,
        };
      }

      // Buy both tokens in parallel
      this.log(`  1. Buying tokens in parallel...`);
      const [buyYesResult, buyNoResult] = await Promise.all([
        this.tradingService!.createMarketOrder({
          tokenId: this.market!.yesTokenId,
          side: 'BUY',
          amount: size * buyYes,
          orderType: 'FOK',
        }),
        this.tradingService!.createMarketOrder({
          tokenId: this.market!.noTokenId,
          side: 'BUY',
          amount: size * buyNo,
          orderType: 'FOK',
        }),
      ]);

      const outcomes = this.market!.outcomes || ['YES', 'NO'];
      this.log(`     ${outcomes[0]}: ${buyYesResult.success ? '✓' : '✗'}, ${outcomes[1]}: ${buyNoResult.success ? '✓' : '✗'}`);

      // If one succeeded and the other failed, we have an imbalance - fix it
      if (!buyYesResult.success || !buyNoResult.success) {
        // Check if partial execution created imbalance
        if (buyYesResult.success !== buyNoResult.success) {
          this.log(`  ⚠️ Partial execution detected - attempting to fix imbalance...`);
          await this.fixImbalanceIfNeeded();
        }
        return {
          success: false,
          type: 'long',
          size,
          profit: 0,
          txHashes,
          error: `Order(s) failed: YES=${buyYesResult.errorMsg}, NO=${buyNoResult.errorMsg}`,
          executionTimeMs: Date.now() - startTime,
        };
      }

      // Merge tokens
      const tokenIds: TokenIds = {
        yesTokenId: this.market!.yesTokenId,
        noTokenId: this.market!.noTokenId,
      };

      // Update balance to get accurate token counts
      await this.updateBalance();
      const heldPairs = Math.min(this.balance.yesTokens, this.balance.noTokens);
      const mergeSize = Math.floor(Math.min(size, heldPairs) * 1e6) / 1e6;

      if (mergeSize >= this.config.minTradeSize) {
        this.log(`  2. Merging ${mergeSize.toFixed(2)} pairs...`);
        try {
          const mergeResult = await this.ctf!.mergeByTokenIds(
            this.market!.conditionId,
            tokenIds,
            mergeSize.toString()
          );
          txHashes.push(mergeResult.txHash);
          this.log(`     TX: ${mergeResult.txHash}`);

          const profit = opportunity.profitRate * mergeSize;
          this.log(`  ✅ Long Arb completed! Profit: ~$${profit.toFixed(2)}`);

          return {
            success: true,
            type: 'long',
            size: mergeSize,
            profit,
            txHashes,
            executionTimeMs: Date.now() - startTime,
          };
        } catch (mergeError: any) {
          this.log(`  ⚠️ Merge failed: ${mergeError.message}`);
          return {
            success: false,
            type: 'long',
            size,
            profit: 0,
            txHashes,
            error: `Merge failed: ${mergeError.message}`,
            executionTimeMs: Date.now() - startTime,
          };
        }
      }

      return {
        success: false,
        type: 'long',
        size,
        profit: 0,
        txHashes,
        error: `Insufficient pairs for merge: ${heldPairs.toFixed(2)}`,
        executionTimeMs: Date.now() - startTime,
      };
    } catch (error: any) {
      return {
        success: false,
        type: 'long',
        size,
        profit: 0,
        txHashes,
        error: error.message,
        executionTimeMs: Date.now() - startTime,
      };
    }
  }

  private async executeShortArb(opportunity: ArbitrageOpportunity): Promise<ArbitrageExecutionResult> {
    const startTime = Date.now();
    const txHashes: string[] = [];
    const size = opportunity.recommendedSize;

    this.log(`\nExecuting Short Arb (Sell Pre-held Tokens)...`);

    try {
      const heldPairs = Math.min(this.balance.yesTokens, this.balance.noTokens);

      if (heldPairs < size) {
        return {
          success: false,
          type: 'short',
          size,
          profit: 0,
          txHashes,
          error: `Insufficient held tokens: have ${heldPairs.toFixed(2)}, need ${size.toFixed(2)}`,
          executionTimeMs: Date.now() - startTime,
        };
      }

      // Sell both tokens in parallel
      this.log(`  1. Selling pre-held tokens in parallel...`);
      const [sellYesResult, sellNoResult] = await Promise.all([
        this.tradingService!.createMarketOrder({
          tokenId: this.market!.yesTokenId,
          side: 'SELL',
          amount: size,
          orderType: 'FOK',
        }),
        this.tradingService!.createMarketOrder({
          tokenId: this.market!.noTokenId,
          side: 'SELL',
          amount: size,
          orderType: 'FOK',
        }),
      ]);

      const outcomes = this.market!.outcomes || ['YES', 'NO'];
      this.log(`     ${outcomes[0]}: ${sellYesResult.success ? '✓' : '✗'}, ${outcomes[1]}: ${sellNoResult.success ? '✓' : '✗'}`);

      // If one succeeded and the other failed, we have an imbalance
      if (!sellYesResult.success || !sellNoResult.success) {
        // Check if partial execution created imbalance
        if (sellYesResult.success !== sellNoResult.success) {
          this.log(`  ⚠️ Partial execution detected - imbalance created`);
          // Note: For short arb, we just sold one side, creating imbalance
          // The rebalancer will fix this on next cycle
          await this.fixImbalanceIfNeeded();
        }
        return {
          success: false,
          type: 'short',
          size,
          profit: 0,
          txHashes,
          error: `Order(s) failed: YES=${sellYesResult.errorMsg}, NO=${sellNoResult.errorMsg}`,
          executionTimeMs: Date.now() - startTime,
        };
      }

      const profit = opportunity.profitRate * size;
      this.log(`  ✅ Short Arb completed! Profit: ~$${profit.toFixed(2)}`);

      return {
        success: true,
        type: 'short',
        size,
        profit,
        txHashes,
        executionTimeMs: Date.now() - startTime,
      };
    } catch (error: any) {
      return {
        success: false,
        type: 'short',
        size,
        profit: 0,
        txHashes,
        error: error.message,
        executionTimeMs: Date.now() - startTime,
      };
    }
  }

  private log(message: string): void {
    if (this.config.enableLogging) {
      console.log(`[ArbitrageService] ${message}`);
    }
  }

  // ===== Market Scanning Methods =====

  /**
   * Scan markets for arbitrage opportunities
   *
   * @param criteria Filter criteria for markets
   * @param minProfit Minimum profit threshold (default: 0.005 = 0.5%)
   * @returns Array of scan results sorted by profit
   *
   * @example
   * ```typescript
   * const service = new ArbitrageService({ privateKey: '0x...' });
   *
   * // Scan markets with at least $5000 volume
   * const results = await service.scanMarkets({ minVolume24h: 5000 }, 0.005);
   *
   * // Start arbitraging the best opportunity
   * if (results.length > 0 && results[0].arbType !== 'none') {
   *   await service.start(results[0].market);
   * }
   * ```
   */
  async scanMarkets(
    criteria: ScanCriteria = {},
    minProfit = 0.005
  ): Promise<ScanResult[]> {
    const {
      minVolume24h = 1000,
      maxVolume24h,
      keywords = [],
      limit = 100,
    } = criteria;

    this.log(`Scanning markets (minVolume: $${minVolume24h}, minProfit: ${(minProfit * 100).toFixed(2)}%)...`);

    // Create temporary API clients for scanning
    const cache = createUnifiedCache();
    const gammaApi = new GammaApiClient(this.rateLimiter, cache);
    const tempMarketService = new MarketService(gammaApi, undefined, this.rateLimiter, cache);

    // Fetch active markets from Gamma API
    const markets = await gammaApi.getMarkets({
      active: true,
      closed: false,
      limit,
    });

    this.log(`Found ${markets.length} active markets`);

    const results: ScanResult[] = [];

    for (const gammaMarket of markets) {
      try {
        // Filter by volume
        const volume24h = gammaMarket.volume24hr || 0;
        if (volume24h < minVolume24h) continue;
        if (maxVolume24h && volume24h > maxVolume24h) continue;

        // Filter by keywords
        if (keywords.length > 0) {
          const marketText = `${gammaMarket.question} ${gammaMarket.description || ''}`.toLowerCase();
          const hasKeyword = keywords.some((kw) => marketText.includes(kw.toLowerCase()));
          if (!hasKeyword) continue;
        }

        // Skip non-binary markets
        if (!gammaMarket.conditionId || gammaMarket.outcomes?.length !== 2) continue;

        // Get market data for token IDs
        let clobMarket;
        try {
          clobMarket = await tempMarketService.getClobMarket(gammaMarket.conditionId);
          if (!clobMarket) continue; // Skip if market not found
        } catch {
          continue; // Skip if market data not available
        }

        // Use index-based access instead of name-based (supports Yes/No, Up/Down, Team1/Team2, etc.)
        const yesToken = clobMarket.tokens[0];  // primary outcome
        const noToken = clobMarket.tokens[1];   // secondary outcome
        if (!yesToken || !noToken) continue;

        // Get orderbook data
        let orderbook;
        try {
          orderbook = await tempMarketService.getProcessedOrderbook(gammaMarket.conditionId);
        } catch {
          continue; // Skip if orderbook not available
        }

        const { effectivePrices, longArbProfit, shortArbProfit } = orderbook.summary;

        // Determine best arbitrage type
        let arbType: 'long' | 'short' | 'none' = 'none';
        let profitRate = 0;

        if (longArbProfit > minProfit && longArbProfit >= shortArbProfit) {
          arbType = 'long';
          profitRate = longArbProfit;
        } else if (shortArbProfit > minProfit) {
          arbType = 'short';
          profitRate = shortArbProfit;
        }

        // Calculate available size (min of both sides)
        const yesAskSize = orderbook.yes.askSize || 0;
        const noAskSize = orderbook.no.askSize || 0;
        const yesBidSize = orderbook.yes.bidSize || 0;
        const noBidSize = orderbook.no.bidSize || 0;

        const availableSize = arbType === 'long'
          ? Math.min(yesAskSize, noAskSize)
          : Math.min(yesBidSize, noBidSize);

        // Calculate score (profit * volume * available_size)
        const score = profitRate * 100 * Math.log10(volume24h + 1) * Math.min(availableSize, 100) / 100;

        // Create market config
        const marketConfig: ArbitrageMarketConfig = {
          name: gammaMarket.question.slice(0, 60) + (gammaMarket.question.length > 60 ? '...' : ''),
          conditionId: gammaMarket.conditionId,
          yesTokenId: yesToken.tokenId,
          noTokenId: noToken.tokenId,
          outcomes: gammaMarket.outcomes as [string, string],
        };

        const longCost = effectivePrices.effectiveBuyYes + effectivePrices.effectiveBuyNo;
        const shortRevenue = effectivePrices.effectiveSellYes + effectivePrices.effectiveSellNo;

        let description: string;
        if (arbType === 'long') {
          description = `Buy YES@${effectivePrices.effectiveBuyYes.toFixed(4)} + NO@${effectivePrices.effectiveBuyNo.toFixed(4)} = ${longCost.toFixed(4)} → Merge for $1`;
        } else if (arbType === 'short') {
          description = `Sell YES@${effectivePrices.effectiveSellYes.toFixed(4)} + NO@${effectivePrices.effectiveSellNo.toFixed(4)} = ${shortRevenue.toFixed(4)}`;
        } else {
          description = `No opportunity (Long cost: ${longCost.toFixed(4)}, Short rev: ${shortRevenue.toFixed(4)})`;
        }

        results.push({
          market: marketConfig,
          arbType,
          profitRate,
          profitPercent: profitRate * 100,
          effectivePrices: {
            buyYes: effectivePrices.effectiveBuyYes,
            buyNo: effectivePrices.effectiveBuyNo,
            sellYes: effectivePrices.effectiveSellYes,
            sellNo: effectivePrices.effectiveSellNo,
            longCost,
            shortRevenue,
          },
          volume24h,
          availableSize,
          score,
          description,
        });
      } catch (error) {
        // Skip markets with errors
        continue;
      }
    }

    // Sort by profit (descending), then by score
    results.sort((a, b) => {
      if (b.profitRate !== a.profitRate) return b.profitRate - a.profitRate;
      return b.score - a.score;
    });

    this.log(`Found ${results.filter((r) => r.arbType !== 'none').length} markets with arbitrage opportunities`);

    return results;
  }

  /**
   * Quick scan for best arbitrage opportunities
   *
   * @param minProfit Minimum profit threshold (default: 0.005 = 0.5%)
   * @param limit Maximum number of results to return (default: 10)
   * @returns Top arbitrage opportunities
   *
   * @example
   * ```typescript
   * const service = new ArbitrageService({ privateKey: '0x...' });
   *
   * // Find best arbitrage opportunities
   * const top = await service.quickScan(0.005, 5);
   *
   * // Print results
   * for (const r of top) {
   *   console.log(`${r.market.name}: ${r.arbType} +${r.profitPercent.toFixed(2)}%`);
   * }
   *
   * // Start the best one
   * if (top.length > 0) {
   *   await service.start(top[0].market);
   * }
   * ```
   */
  async quickScan(minProfit = 0.005, limit = 10): Promise<ScanResult[]> {
    const results = await this.scanMarkets(
      { minVolume24h: 5000, limit: 100 },
      minProfit
    );

    // Return only markets with opportunities, limited to requested count
    return results
      .filter((r) => r.arbType !== 'none')
      .slice(0, limit);
  }

  /**
   * Find and start arbitraging the best opportunity
   *
   * @param minProfit Minimum profit threshold (default: 0.005 = 0.5%)
   * @returns The scan result that was started, or null if none found
   *
   * @example
   * ```typescript
   * const service = new ArbitrageService({
   *   privateKey: '0x...',
   *   autoExecute: true,
   *   profitThreshold: 0.005,
   * });
   *
   * // Find and start the best opportunity
   * const started = await service.findAndStart(0.005);
   * if (started) {
   *   console.log(`Started: ${started.market.name} (+${started.profitPercent.toFixed(2)}%)`);
   * }
   * ```
   */
  async findAndStart(minProfit = 0.005): Promise<ScanResult | null> {
    const results = await this.quickScan(minProfit, 1);

    if (results.length === 0) {
      this.log('No arbitrage opportunities found');
      return null;
    }

    const best = results[0];
    this.log(`Best opportunity: ${best.market.name} (${best.arbType} +${best.profitPercent.toFixed(2)}%)`);

    await this.start(best.market);
    return best;
  }
}
