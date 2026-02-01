/**
 * DipArbService - Dip Arbitrage Service
 *
 * 暴跌套利服务 - 针对 Polymarket 15分钟/5分钟 UP/DOWN 市场
 *
 * 策略原理：
 * 1. 每个市场有一个 "price to beat"（开盘时的 Chainlink 价格）
 * 2. 结算规则：
 *    - UP 赢：结束时价格 >= price to beat
 *    - DOWN 赢：结束时价格 < price to beat
 *
 * 3. 套利流程：
 *    - Leg1：检测暴跌 → 买入暴跌侧
 *    - Leg2：等待对冲条件 → 买入另一侧
 *    - 利润：总成本 < $1 时获得无风险利润
 *
 * 使用示例：
 * ```typescript
 * const sdk = await PolymarketSDK.create({ privateKey: '...' });
 *
 * // 自动找到并启动
 * await sdk.dipArb.findAndStart({ coin: 'BTC' });
 *
 * // 监听信号
 * sdk.dipArb.on('signal', (signal) => {
 *   console.log(`Signal: ${signal.type} ${signal.side}`);
 * });
 * ```
 */

import { EventEmitter } from 'events';
import {
  RealtimeServiceV2,
  type MarketSubscription,
  type OrderbookSnapshot,
  type Subscription,
  type CryptoPrice,
} from './realtime-service-v2.js';
import { TradingService, type MarketOrderParams } from './trading-service.js';
import { MarketService } from './market-service.js';
import { CTFClient } from '../clients/ctf-client.js';
import type { Side } from '../core/types.js';
import {
  type DipArbServiceConfig,
  type DipArbConfigInternal,
  type DipArbMarketConfig,
  type DipArbRoundState,
  type DipArbStats,
  type DipArbSignal,
  type DipArbLeg1Signal,
  type DipArbLeg2Signal,
  type DipArbExecutionResult,
  type DipArbRoundResult,
  type DipArbNewRoundEvent,
  type DipArbPriceUpdateEvent,
  type DipArbScanOptions,
  type DipArbFindAndStartOptions,
  type DipArbSide,
  type DipArbAutoRotateConfig,
  type DipArbSettleResult,
  type DipArbRotateEvent,
  type DipArbUnderlying,
  type DipArbPendingRedemption,
  DEFAULT_DIP_ARB_CONFIG,
  DEFAULT_AUTO_ROTATE_CONFIG,
  createDipArbInitialStats,
  createDipArbRoundState,
  calculateDipArbProfitRate,
  estimateUpWinRate,
  detectMispricing,
  parseUnderlyingFromSlug,
  parseDurationFromSlug,
  isDipArbLeg1Signal,
} from './dip-arb-types.js';

// ===== DipArbService =====

export class DipArbService extends EventEmitter {
  // Dependencies
  private realtimeService: RealtimeServiceV2;
  private tradingService: TradingService | null = null;
  private marketService: MarketService;
  private ctf: CTFClient | null = null;

  // Configuration
  private config: DipArbConfigInternal;
  private autoRotateConfig: Required<DipArbAutoRotateConfig>;

  // State
  private market: DipArbMarketConfig | null = null;
  private currentRound: DipArbRoundState | null = null;
  private isRunning = false;
  private isExecuting = false;
  private lastExecutionTime = 0;
  private stats: DipArbStats;

  // Subscriptions
  private marketSubscription: MarketSubscription | null = null;
  private chainlinkSubscription: Subscription | null = null;

  // Auto-rotate state
  private rotateCheckInterval: ReturnType<typeof setInterval> | null = null;
  private nextMarket: DipArbMarketConfig | null = null;

  // Pending redemption state (for background redemption after market resolution)
  private pendingRedemptions: DipArbPendingRedemption[] = [];
  private redeemCheckInterval: ReturnType<typeof setInterval> | null = null;

  // Orderbook state
  private upAsks: Array<{ price: number; size: number }> = [];
  private downAsks: Array<{ price: number; size: number }> = [];

  // Price history for sliding window detection
  // Each entry: { timestamp: number, upAsk: number, downAsk: number }
  private priceHistory: Array<{ timestamp: number; upAsk: number; downAsk: number }> = [];
  private readonly MAX_HISTORY_LENGTH = 100;  // Keep last 100 price points

  // Price state
  private currentUnderlyingPrice = 0;

  // Signal state - prevent duplicate signals within same round
  private leg1SignalEmitted = false;

  // Smart logging state - reduce orderbook noise
  private lastOrderbookLogTime = 0;
  private readonly ORDERBOOK_LOG_INTERVAL_MS = 10000;  // Log orderbook every 10 seconds
  private orderbookBuffer: Array<{ timestamp: number; upAsk: number; downAsk: number; upDepth: number; downDepth: number }> = [];
  private readonly ORDERBOOK_BUFFER_SIZE = 50;  // Keep 5 seconds of data at ~10 updates/sec

  constructor(
    realtimeService: RealtimeServiceV2,
    tradingService: TradingService | null,
    marketService: MarketService,
    privateKey?: string,
    chainId: number = 137
  ) {
    super();

    this.realtimeService = realtimeService;
    this.tradingService = tradingService;
    this.marketService = marketService;

    // Initialize with default config
    this.config = { ...DEFAULT_DIP_ARB_CONFIG };
    this.autoRotateConfig = { ...DEFAULT_AUTO_ROTATE_CONFIG };
    this.stats = createDipArbInitialStats();

    // Initialize CTF if private key provided
    if (privateKey) {
      this.ctf = new CTFClient({
        privateKey,
        rpcUrl: 'https://polygon-rpc.com',
        chainId,
      });
    }
  }

  // ===== Public API: Configuration =====

  /**
   * Update configuration
   */
  updateConfig(config: Partial<DipArbServiceConfig>): void {
    this.config = {
      ...this.config,
      ...config,
    };
    this.log(`Config updated: ${JSON.stringify(config)}`);
  }

  /**
   * Get current configuration
   */
  getConfig(): DipArbConfigInternal {
    return { ...this.config };
  }

  // ===== Public API: Market Discovery =====

  /**
   * Scan for upcoming UP/DOWN markets
   *
   * Uses MarketService.scanCryptoShortTermMarkets()
   */
  async scanUpcomingMarkets(options: DipArbScanOptions = {}): Promise<DipArbMarketConfig[]> {
    const {
      coin = 'all',
      duration = 'all',
      minMinutesUntilEnd = 5,
      maxMinutesUntilEnd = 60,
      limit = 20,
    } = options;

    try {
      const gammaMarkets = await this.marketService.scanCryptoShortTermMarkets({
        coin: coin as 'BTC' | 'ETH' | 'SOL' | 'XRP' | 'all',
        duration: duration as '5m' | '15m' | 'all',
        minMinutesUntilEnd,
        maxMinutesUntilEnd,
        limit,
        sortBy: 'endDate',
      });

      // Get full market info with token IDs for each market
      const results: DipArbMarketConfig[] = [];

      for (const gm of gammaMarkets) {
        // Retry up to 3 times for network errors
        let retries = 3;
        while (retries > 0) {
          try {
            // Get full market info from CLOB API via MarketService
            const market = await this.marketService.getMarket(gm.conditionId);

            // Find UP and DOWN tokens
            const upToken = market.tokens.find(t =>
              t.outcome.toLowerCase() === 'up' || t.outcome.toLowerCase() === 'yes'
            );
            const downToken = market.tokens.find(t =>
              t.outcome.toLowerCase() === 'down' || t.outcome.toLowerCase() === 'no'
            );

            if (upToken?.tokenId && downToken?.tokenId) {
              results.push({
                name: gm.question,
                slug: gm.slug,
                conditionId: gm.conditionId,
                upTokenId: upToken.tokenId,
                downTokenId: downToken.tokenId,
                underlying: parseUnderlyingFromSlug(gm.slug),
                durationMinutes: parseDurationFromSlug(gm.slug),
                endTime: gm.endDate,
              });
            }
            break; // Success, exit retry loop
          } catch (error) {
            retries--;
            if (retries > 0) {
              // Wait 1 second before retry
              await new Promise(r => setTimeout(r, 1000));
            }
          }
        }
      }

      return results;
    } catch (error) {
      this.emit('error', error instanceof Error ? error : new Error(String(error)));
      return [];
    }
  }

  /**
   * Find the best market and start monitoring
   */
  async findAndStart(options: DipArbFindAndStartOptions = {}): Promise<DipArbMarketConfig | null> {
    const { coin, preferDuration = '15m' } = options;

    const scanOptions: DipArbScanOptions = {
      coin: coin || 'all',
      duration: preferDuration,
      minMinutesUntilEnd: 10,
      maxMinutesUntilEnd: 60,
      limit: 10,
    };

    const markets = await this.scanUpcomingMarkets(scanOptions);

    if (markets.length === 0) {
      this.log('No suitable markets found');
      return null;
    }

    // Find the best market (prefer specified coin, then by time)
    let bestMarket = markets[0];
    if (coin) {
      const coinMarket = markets.find(m => m.underlying === coin);
      if (coinMarket) {
        bestMarket = coinMarket;
      }
    }

    await this.start(bestMarket);
    return bestMarket;
  }

  // ===== Public API: Lifecycle =====

  /**
   * Start monitoring a market
   */
  async start(market: DipArbMarketConfig): Promise<void> {
    if (this.isRunning) {
      throw new Error('DipArbService is already running. Call stop() first.');
    }

    // Validate token IDs
    if (!market.upTokenId || !market.downTokenId) {
      throw new Error(`Invalid market config: missing token IDs. upTokenId=${market.upTokenId}, downTokenId=${market.downTokenId}`);
    }

    this.market = market;
    this.isRunning = true;
    this.stats = createDipArbInitialStats();
    this.priceHistory = [];  // Clear price history for new market

    this.log(`Starting Dip Arb monitor for: ${market.name}`);
    this.log(`Condition ID: ${market.conditionId.slice(0, 20)}...`);
    this.log(`Underlying: ${market.underlying}`);
    this.log(`Duration: ${market.durationMinutes}m`);
    this.log(`Auto Execute: ${this.config.autoExecute ? 'YES' : 'NO'}`);

    // Initialize trading service if available
    if (this.tradingService) {
      try {
        await this.tradingService.initialize();
        this.log(`Wallet: ${this.ctf?.getAddress()}`);
      } catch (error) {
        this.log(`Warning: Trading service init failed: ${error}`);
      }
    } else {
      this.log('No wallet configured - monitoring only');
    }

    // Connect realtime service and wait for connection
    // connect() is async and returns a Promise that resolves when connected
    await this.realtimeService.connect();
    this.log('WebSocket connected');

    // Subscribe to market orderbook
    this.log(`Subscribing to tokens: UP=${market.upTokenId.slice(0, 20)}..., DOWN=${market.downTokenId.slice(0, 20)}...`);
    this.marketSubscription = this.realtimeService.subscribeMarkets(
      [market.upTokenId, market.downTokenId],
      {
        onOrderbook: (book: OrderbookSnapshot) => {
          // Handle the orderbook update (always)
          this.handleOrderbookUpdate(book);

          // Smart logging: only log at intervals, not every update
          if (this.config.debug) {
            this.updateOrderbookBuffer(book);
            this.maybeLogOrderbookSummary();
          }
        },
        onError: (error: Error) => this.emit('error', error),
      }
    );

    // Subscribe to Chainlink prices for the underlying asset
    // Format: ETH -> ETH/USD
    const chainlinkSymbol = `${market.underlying}/USD`;
    console.log(`[DipArb] Subscribing to Chainlink prices: ${chainlinkSymbol}`);
    this.chainlinkSubscription = this.realtimeService.subscribeCryptoChainlinkPrices(
      [chainlinkSymbol],
      {
        onPrice: (price: CryptoPrice) => {
          console.log(`[DipArb] Chainlink price received: ${price.symbol} = $${price.price}`);
          this.handleChainlinkPriceUpdate(price);
        },
      }
    );

    // ✅ FIX: Check and merge existing pairs at startup
    if (this.ctf && this.config.autoMerge) {
      await this.scanAndMergeExistingPairs();
    }

    this.emit('started', market);
    this.log('Monitoring for dip arbitrage opportunities...');
  }

  /**
   * ✅ FIX: Scan and merge existing UP/DOWN pairs at startup
   *
   * When the service starts or rotates to a new market, check if there are
   * existing UP + DOWN token pairs from previous sessions and merge them.
   */
  private async scanAndMergeExistingPairs(): Promise<void> {
    if (!this.ctf || !this.market) return;

    try {
      const tokenIds = {
        yesTokenId: this.market.upTokenId,
        noTokenId: this.market.downTokenId,
      };

      const balances = await this.ctf.getPositionBalanceByTokenIds(
        this.market.conditionId,
        tokenIds
      );

      const upBalance = parseFloat(balances.yesBalance);
      const downBalance = parseFloat(balances.noBalance);

      // Calculate how many pairs can be merged
      const pairsToMerge = Math.min(upBalance, downBalance);

      if (pairsToMerge > 0.01) {  // Minimum 0.01 to avoid dust
        this.log(`🔍 Found existing pairs: UP=${upBalance.toFixed(2)}, DOWN=${downBalance.toFixed(2)}`);
        this.log(`🔄 Auto-merging ${pairsToMerge.toFixed(2)} pairs at startup...`);

        try {
          const result = await this.ctf.mergeByTokenIds(
            this.market.conditionId,
            tokenIds,
            pairsToMerge.toString()
          );

          if (result.success) {
            this.log(`✅ Startup merge successful: ${pairsToMerge.toFixed(2)} pairs → $${result.usdcReceived || pairsToMerge.toFixed(2)} USDC.e`);
            this.log(`   TxHash: ${result.txHash?.slice(0, 20)}...`);
          } else {
            this.log(`❌ Startup merge failed`);
          }
        } catch (mergeError) {
          this.log(`❌ Startup merge error: ${mergeError instanceof Error ? mergeError.message : String(mergeError)}`);
        }
      } else if (upBalance > 0 || downBalance > 0) {
        // Has tokens but not enough pairs to merge
        this.log(`📊 Existing positions: UP=${upBalance.toFixed(2)}, DOWN=${downBalance.toFixed(2)} (no pairs to merge)`);
      }
    } catch (error) {
      this.log(`Warning: Failed to scan existing pairs: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Stop monitoring
   */
  async stop(): Promise<void> {
    if (!this.isRunning) return;

    this.isRunning = false;

    // Stop rotate check
    this.stopRotateCheck();

    // Unsubscribe
    if (this.marketSubscription) {
      this.marketSubscription.unsubscribe();
      this.marketSubscription = null;
    }

    if (this.chainlinkSubscription) {
      this.chainlinkSubscription.unsubscribe();
      this.chainlinkSubscription = null;
    }

    // Update stats
    this.stats.runningTimeMs = Date.now() - this.stats.startTime;

    this.log('Stopped');
    this.log(`Rounds monitored: ${this.stats.roundsMonitored}`);
    this.log(`Rounds completed: ${this.stats.roundsSuccessful}`);
    this.log(`Total profit: $${this.stats.totalProfit.toFixed(2)}`);

    this.emit('stopped');
  }

  /**
   * Check if service is running
   */
  isActive(): boolean {
    return this.isRunning;
  }

  /**
   * Get current market
   */
  getMarket(): DipArbMarketConfig | null {
    return this.market;
  }

  // ===== Public API: State Access =====

  /**
   * Get statistics
   */
  getStats(): DipArbStats {
    return {
      ...this.stats,
      runningTimeMs: this.isRunning ? Date.now() - this.stats.startTime : this.stats.runningTimeMs,
      currentRound: this.currentRound ? {
        roundId: this.currentRound.roundId,
        phase: this.currentRound.phase,
        priceToBeat: this.currentRound.priceToBeat,
        leg1: this.currentRound.leg1 ? {
          side: this.currentRound.leg1.side,
          price: this.currentRound.leg1.price,
        } : undefined,
      } : undefined,
    };
  }

  /**
   * Get current round state
   */
  getCurrentRound(): DipArbRoundState | null {
    return this.currentRound ? { ...this.currentRound } : null;
  }

  /**
   * Get current price to beat
   */
  getPriceToBeat(): number | null {
    return this.currentRound?.priceToBeat ?? null;
  }

  // ===== Public API: Manual Execution =====

  /**
   * Execute Leg1 trade
   */
  async executeLeg1(signal: DipArbLeg1Signal): Promise<DipArbExecutionResult> {
    const startTime = Date.now();

    if (!this.tradingService || !this.market || !this.currentRound) {
      this.isExecuting = false;  // Reset in case handleSignal() set it
      return {
        success: false,
        leg: 'leg1',
        roundId: signal.roundId,
        error: 'Trading service not available or no active round',
        executionTimeMs: Date.now() - startTime,
      };
    }

    try {
      this.isExecuting = true;  // Also set here for manual mode (when not called from handleSignal)

      // 计算拆分订单参数
      const splitCount = Math.max(1, this.config.splitOrders);

      // 机制保证：确保满足 $1 最低限额
      const minSharesForMinAmount = Math.ceil(1 / signal.targetPrice);
      const adjustedShares = Math.max(signal.shares, minSharesForMinAmount);

      if (adjustedShares > signal.shares) {
        this.log(`📊 Shares adjusted: ${signal.shares} → ${adjustedShares} (to meet $1 minimum at price ${signal.targetPrice.toFixed(4)})`);
      }

      const sharesPerOrder = adjustedShares / splitCount;
      const amountPerOrder = sharesPerOrder * signal.targetPrice;

      let totalSharesFilled = 0;
      let totalAmountSpent = 0;
      let lastOrderId: string | undefined;
      let failedOrders = 0;

      // 执行多笔订单
      for (let i = 0; i < splitCount; i++) {
        const orderParams: MarketOrderParams = {
          tokenId: signal.tokenId,
          side: 'BUY' as Side,
          amount: amountPerOrder,
        };

        if (this.config.debug && splitCount > 1) {
          this.log(`Leg1 order ${i + 1}/${splitCount}: ${sharesPerOrder.toFixed(2)} shares @ ${signal.targetPrice.toFixed(4)}`);
        }

        const result = await this.tradingService.createMarketOrder(orderParams);

        if (result.success) {
          totalSharesFilled += sharesPerOrder;
          totalAmountSpent += amountPerOrder;
          lastOrderId = result.orderId;
        } else {
          failedOrders++;
          this.log(`Leg1 order ${i + 1}/${splitCount} failed: ${result.errorMsg}`);
        }

        // 订单间隔
        if (i < splitCount - 1 && this.config.orderIntervalMs > 0) {
          await new Promise(resolve => setTimeout(resolve, this.config.orderIntervalMs));
        }
      }

      // 至少有一笔成功
      if (totalSharesFilled > 0) {
        const avgPrice = totalAmountSpent / totalSharesFilled;

        // Record leg1 fill
        this.currentRound.leg1 = {
          side: signal.dipSide,
          price: avgPrice,
          shares: totalSharesFilled,
          timestamp: Date.now(),
          tokenId: signal.tokenId,
        };
        this.currentRound.phase = 'leg1_filled';
        this.stats.leg1Filled++;

        this.lastExecutionTime = Date.now();

        // Detailed execution logging
        const slippage = ((avgPrice - signal.currentPrice) / signal.currentPrice * 100);
        const execTimeMs = Date.now() - startTime;

        this.log(`✅ Leg1 FILLED: ${signal.dipSide} x${totalSharesFilled.toFixed(1)} @ ${avgPrice.toFixed(4)}`);
        this.log(`   Expected: ${signal.currentPrice.toFixed(4)} | Actual: ${avgPrice.toFixed(4)} | Slippage: ${slippage >= 0 ? '+' : ''}${slippage.toFixed(2)}%`);
        this.log(`   Execution time: ${execTimeMs}ms | Orders: ${splitCount - failedOrders}/${splitCount}`);

        // Log orderbook after execution
        if (this.config.debug) {
          this.logOrderbookContext('Post-Leg1');
        }

        return {
          success: true,
          leg: 'leg1',
          roundId: signal.roundId,
          side: signal.dipSide,
          price: avgPrice,
          shares: totalSharesFilled,
          orderId: lastOrderId,
          executionTimeMs: execTimeMs,
        };
      } else {
        return {
          success: false,
          leg: 'leg1',
          roundId: signal.roundId,
          error: 'All orders failed',
          executionTimeMs: Date.now() - startTime,
        };
      }
    } catch (error) {
      return {
        success: false,
        leg: 'leg1',
        roundId: signal.roundId,
        error: error instanceof Error ? error.message : String(error),
        executionTimeMs: Date.now() - startTime,
      };
    } finally {
      this.isExecuting = false;
    }
  }

  /**
   * Execute Leg2 trade
   */
  async executeLeg2(signal: DipArbLeg2Signal): Promise<DipArbExecutionResult> {
    const startTime = Date.now();

    if (!this.tradingService || !this.market || !this.currentRound) {
      this.isExecuting = false;  // Reset in case handleSignal() set it
      return {
        success: false,
        leg: 'leg2',
        roundId: signal.roundId,
        error: 'Trading service not available or no active round',
        executionTimeMs: Date.now() - startTime,
      };
    }

    try {
      this.isExecuting = true;  // Also set here for manual mode (when not called from handleSignal)

      // 计算拆分订单参数
      const splitCount = Math.max(1, this.config.splitOrders);

      // 机制保证：确保满足 $1 最低限额
      const minSharesForMinAmount = Math.ceil(1 / signal.targetPrice);
      const adjustedShares = Math.max(signal.shares, minSharesForMinAmount);

      if (adjustedShares > signal.shares) {
        this.log(`📊 Leg2 Shares adjusted: ${signal.shares} → ${adjustedShares} (to meet $1 minimum at price ${signal.targetPrice.toFixed(4)})`);
      }

      const sharesPerOrder = adjustedShares / splitCount;
      const amountPerOrder = sharesPerOrder * signal.targetPrice;

      let totalSharesFilled = 0;
      let totalAmountSpent = 0;
      let lastOrderId: string | undefined;
      let failedOrders = 0;

      // 执行多笔订单
      for (let i = 0; i < splitCount; i++) {
        const orderParams: MarketOrderParams = {
          tokenId: signal.tokenId,
          side: 'BUY' as Side,
          amount: amountPerOrder,
        };

        if (this.config.debug && splitCount > 1) {
          this.log(`Leg2 order ${i + 1}/${splitCount}: ${sharesPerOrder.toFixed(2)} shares @ ${signal.targetPrice.toFixed(4)}`);
        }

        const result = await this.tradingService.createMarketOrder(orderParams);

        if (result.success) {
          totalSharesFilled += sharesPerOrder;
          totalAmountSpent += amountPerOrder;
          lastOrderId = result.orderId;
        } else {
          failedOrders++;
          this.log(`Leg2 order ${i + 1}/${splitCount} failed: ${result.errorMsg}`);
        }

        // 订单间隔
        if (i < splitCount - 1 && this.config.orderIntervalMs > 0) {
          await new Promise(resolve => setTimeout(resolve, this.config.orderIntervalMs));
        }
      }

      // 至少有一笔成功
      if (totalSharesFilled > 0) {
        const avgPrice = totalAmountSpent / totalSharesFilled;
        const leg1Price = this.currentRound.leg1?.price || 0;
        const actualTotalCost = leg1Price + avgPrice;

        // Record leg2 fill
        this.currentRound.leg2 = {
          side: signal.hedgeSide,
          price: avgPrice,
          shares: totalSharesFilled,
          timestamp: Date.now(),
          tokenId: signal.tokenId,
        };
        this.currentRound.phase = 'completed';
        this.currentRound.totalCost = actualTotalCost;
        this.currentRound.profit = 1 - actualTotalCost;

        this.stats.leg2Filled++;
        this.stats.roundsSuccessful++;
        this.stats.totalProfit += this.currentRound.profit * totalSharesFilled;
        this.stats.totalSpent += actualTotalCost * totalSharesFilled;

        this.lastExecutionTime = Date.now();

        // Detailed execution logging
        const slippage = ((avgPrice - signal.currentPrice) / signal.currentPrice * 100);
        const execTimeMs = Date.now() - startTime;
        const profitPerShare = this.currentRound.profit;
        const totalProfit = profitPerShare * totalSharesFilled;

        this.log(`✅ Leg2 FILLED: ${signal.hedgeSide} x${totalSharesFilled.toFixed(1)} @ ${avgPrice.toFixed(4)}`);
        this.log(`   Expected: ${signal.currentPrice.toFixed(4)} | Actual: ${avgPrice.toFixed(4)} | Slippage: ${slippage >= 0 ? '+' : ''}${slippage.toFixed(2)}%`);
        this.log(`   Leg1: ${leg1Price.toFixed(4)} + Leg2: ${avgPrice.toFixed(4)} = ${actualTotalCost.toFixed(4)}`);
        this.log(`   💰 Profit: $${totalProfit.toFixed(2)} (${(profitPerShare * 100).toFixed(2)}% per share)`);
        this.log(`   Execution time: ${execTimeMs}ms | Orders: ${splitCount - failedOrders}/${splitCount}`);

        // Log orderbook after execution
        if (this.config.debug) {
          this.logOrderbookContext('Post-Leg2');
        }

        const roundResult: DipArbRoundResult = {
          roundId: signal.roundId,
          status: 'completed',
          leg1: this.currentRound.leg1,
          leg2: this.currentRound.leg2,
          totalCost: this.currentRound.totalCost,
          profit: this.currentRound.profit,
          profitRate: calculateDipArbProfitRate(this.currentRound.totalCost),
          merged: false,
        };

        this.emit('roundComplete', roundResult);

        // Auto merge if enabled
        if (this.config.autoMerge) {
          const mergeResult = await this.merge();
          roundResult.merged = mergeResult.success;
          roundResult.mergeTxHash = mergeResult.txHash;
        }

        return {
          success: true,
          leg: 'leg2',
          roundId: signal.roundId,
          side: signal.hedgeSide,
          price: avgPrice,
          shares: totalSharesFilled,
          orderId: lastOrderId,
          executionTimeMs: Date.now() - startTime,
        };
      } else {
        return {
          success: false,
          leg: 'leg2',
          roundId: signal.roundId,
          error: 'All orders failed',
          executionTimeMs: Date.now() - startTime,
        };
      }
    } catch (error) {
      return {
        success: false,
        leg: 'leg2',
        roundId: signal.roundId,
        error: error instanceof Error ? error.message : String(error),
        executionTimeMs: Date.now() - startTime,
      };
    } finally {
      this.isExecuting = false;
    }
  }

  /**
   * Merge UP + DOWN tokens to USDC.e
   *
   * Uses mergeByTokenIds with Polymarket token IDs for correct CLOB market handling.
   * This locks in profit immediately after Leg2 completes.
   */
  async merge(): Promise<DipArbExecutionResult> {
    const startTime = Date.now();
    const roundId = this.currentRound?.roundId || 'unknown';

    if (!this.ctf || !this.market || !this.currentRound) {
      return {
        success: false,
        leg: 'merge',
        roundId,
        error: 'CTF client not available or no completed round',
        executionTimeMs: Date.now() - startTime,
      };
    }

    // Merge the minimum of Leg1 and Leg2 shares (should be equal after our fix)
    const shares = Math.min(
      this.currentRound.leg1?.shares || 0,
      this.currentRound.leg2?.shares || 0
    );

    if (shares <= 0) {
      return {
        success: false,
        leg: 'merge',
        roundId,
        error: 'No shares to merge',
        executionTimeMs: Date.now() - startTime,
      };
    }

    try {
      // Use mergeByTokenIds with Polymarket token IDs
      const tokenIds = {
        yesTokenId: this.market.upTokenId,
        noTokenId: this.market.downTokenId,
      };

      this.log(`🔄 Merging ${shares.toFixed(1)} UP + DOWN → USDC.e...`);

      const result = await this.ctf.mergeByTokenIds(
        this.market.conditionId,
        tokenIds,
        shares.toString()
      );

      if (result.success) {
        this.log(`✅ Merge successful: ${shares.toFixed(1)} pairs → $${result.usdcReceived || shares.toFixed(2)} USDC.e`);
        this.log(`   TxHash: ${result.txHash?.slice(0, 20)}...`);
      }

      return {
        success: result.success,
        leg: 'merge',
        roundId,
        shares,
        txHash: result.txHash,
        executionTimeMs: Date.now() - startTime,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.log(`❌ Merge failed: ${errorMsg}`);
      return {
        success: false,
        leg: 'merge',
        roundId,
        error: errorMsg,
        executionTimeMs: Date.now() - startTime,
      };
    }
  }

  // ===== Private: Event Handlers =====

  private handleOrderbookUpdate(book: OrderbookSnapshot): void {
    if (!this.market) return;

    // Determine which side this update is for
    const tokenId = book.tokenId;
    const isUpToken = tokenId === this.market.upTokenId;
    const isDownToken = tokenId === this.market.downTokenId;

    // OrderbookLevel has price and size as numbers
    if (isUpToken) {
      this.upAsks = book.asks.map(l => ({ price: l.price, size: l.size }));
    } else if (isDownToken) {
      this.downAsks = book.asks.map(l => ({ price: l.price, size: l.size }));
    }

    // Record price history for sliding window detection
    this.recordPriceHistory();

    // Check if we need to start a new round (async but fire-and-forget to not block orderbook updates)
    this.checkAndStartNewRound().catch(err => {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    });

    // Skip signal detection entirely if already executing (prevents duplicate detection logs)
    if (this.isExecuting) {
      return;
    }

    // Detect signals
    const signal = this.detectSignal();
    if (signal) {
      this.handleSignal(signal);
    }
  }

  /**
   * Record current prices to history buffer for sliding window detection
   */
  private recordPriceHistory(): void {
    const upAsk = this.upAsks[0]?.price ?? 0;
    const downAsk = this.downAsks[0]?.price ?? 0;

    // Only record if we have valid prices
    if (upAsk <= 0 || downAsk <= 0) return;

    this.priceHistory.push({
      timestamp: Date.now(),
      upAsk,
      downAsk,
    });

    // Trim history to max length
    if (this.priceHistory.length > this.MAX_HISTORY_LENGTH) {
      this.priceHistory = this.priceHistory.slice(-this.MAX_HISTORY_LENGTH);
    }
  }

  /**
   * Get price from N milliseconds ago for sliding window detection
   *
   * @param side - 'UP' or 'DOWN'
   * @param msAgo - Milliseconds ago (e.g., 3000 for 3 seconds)
   * @returns Price from that time, or null if not available
   */
  private getPriceFromHistory(side: 'UP' | 'DOWN', msAgo: number): number | null {
    const targetTime = Date.now() - msAgo;

    // Find the closest price point at or before targetTime
    for (let i = this.priceHistory.length - 1; i >= 0; i--) {
      const entry = this.priceHistory[i];
      if (entry.timestamp <= targetTime) {
        return side === 'UP' ? entry.upAsk : entry.downAsk;
      }
    }

    return null;
  }

  private handleChainlinkPriceUpdate(price: CryptoPrice): void {
    if (!this.market) return;

    // Only handle updates for our underlying (symbol format: ETH/USD)
    const expectedSymbol = `${this.market.underlying}/USD`;
    if (price.symbol !== expectedSymbol) return;

    if (this.config.debug) {
      this.log(`Chainlink price update: ${price.symbol} = $${price.price.toFixed(2)}`);
    }

    this.currentUnderlyingPrice = price.price;

    // Emit price update event
    if (this.currentRound) {
      const event: DipArbPriceUpdateEvent = {
        underlying: this.market.underlying,
        value: price.price,
        priceToBeat: this.currentRound.priceToBeat,
        changePercent: this.currentRound.priceToBeat > 0
          ? ((price.price - this.currentRound.priceToBeat) / this.currentRound.priceToBeat) * 100
          : 0,
      };
      this.emit('priceUpdate', event);
    }
  }

  // ===== Private: Round Management =====

  private async checkAndStartNewRound(): Promise<void> {
    if (!this.market) return;

    // If no current round or current round is completed/expired, start new round
    if (!this.currentRound || this.currentRound.phase === 'completed' || this.currentRound.phase === 'expired') {
      // Check if market is still active
      if (new Date() >= this.market.endTime) {
        // Always log market end (not just in debug mode)
        if (!this.currentRound) {
          console.log('[DipArb] Market has ended before round could start');
        }
        return;
      }

      // Get current prices
      const upPrice = this.upAsks[0]?.price ?? 0.5;
      const downPrice = this.downAsks[0]?.price ?? 0.5;

      // Use current underlying price as price to beat (or fallback to 0)
      const priceToBeat = this.currentUnderlyingPrice || 0;

      // Create new round
      const roundId = `${this.market.slug}-${Date.now()}`;
      this.currentRound = createDipArbRoundState(
        roundId,
        priceToBeat,
        upPrice,
        downPrice,
        this.market.durationMinutes
      );

      // Clear price history for new round - we only want to detect instant drops within this round
      this.priceHistory = [];

      // Reset signal state for new round
      this.leg1SignalEmitted = false;

      this.stats.roundsMonitored++;

      const event: DipArbNewRoundEvent = {
        roundId,
        priceToBeat,
        upOpen: upPrice,
        downOpen: downPrice,
        startTime: this.currentRound.startTime,
        endTime: this.currentRound.endTime,
      };

      this.emit('newRound', event);
      this.log(`New round: ${roundId}, Price to Beat: ${priceToBeat.toFixed(2)}`);
    }

    // Check for round expiration - exit Leg1 if Leg2 times out
    if (this.currentRound && this.currentRound.phase === 'leg1_filled') {
      const elapsed = (Date.now() - (this.currentRound.leg1?.timestamp || this.currentRound.startTime)) / 1000;
      if (elapsed > this.config.leg2TimeoutSeconds) {
        // ✅ FIX: Exit Leg1 position to avoid unhedged exposure
        this.log(`⚠️ Leg2 timeout (${elapsed.toFixed(0)}s > ${this.config.leg2TimeoutSeconds}s), exiting Leg1 position...`);

        // Try to sell Leg1 position
        const exitResult = await this.emergencyExitLeg1();

        this.currentRound.phase = 'expired';
        this.stats.roundsExpired++;
        this.stats.roundsCompleted++;

        const result: DipArbRoundResult = {
          roundId: this.currentRound.roundId,
          status: 'expired',
          leg1: this.currentRound.leg1,
          merged: false,
          exitResult,  // Include exit result for tracking
        };

        this.emit('roundComplete', result);
        this.log(`Round expired: ${this.currentRound.roundId} | Exit: ${exitResult?.success ? 'SUCCESS' : 'FAILED'}`);
      }
    }
  }

  /**
   * Emergency exit Leg1 position when Leg2 times out
   * Sells the Leg1 tokens at market price to avoid unhedged exposure
   */
  private async emergencyExitLeg1(): Promise<DipArbExecutionResult | null> {
    if (!this.tradingService || !this.market || !this.currentRound?.leg1) {
      this.log('Cannot exit Leg1: no trading service or position');
      return null;
    }

    const leg1 = this.currentRound.leg1;
    const startTime = Date.now();

    try {
      this.log(`Selling ${leg1.shares} ${leg1.side} tokens...`);

      // Get current price for the token
      const currentPrice = leg1.side === 'UP'
        ? (this.upAsks[0]?.price ?? 0.5)
        : (this.downAsks[0]?.price ?? 0.5);

      const exitAmount = leg1.shares * currentPrice;

      // 检查退出金额是否满足最低限额
      if (exitAmount < 1) {
        this.log(`⚠️ Exit amount ($${exitAmount.toFixed(2)}) below $1 minimum - position will be held to expiry`);
        return {
          success: false,
          leg: 'exit',
          roundId: this.currentRound.roundId,
          error: `Exit amount ($${exitAmount.toFixed(2)}) below Polymarket minimum ($1) - holding to expiry`,
          executionTimeMs: Date.now() - startTime,
        };
      }

      // Market sell the position
      const result = await this.tradingService.createMarketOrder({
        tokenId: leg1.tokenId,
        side: 'SELL' as Side,
        amount: exitAmount,
      });

      if (result.success) {
        const soldPrice = currentPrice;  // Approximate
        const loss = (leg1.price - soldPrice) * leg1.shares;

        this.log(`✅ Leg1 exit successful: sold ${leg1.shares}x ${leg1.side} @ ~${soldPrice.toFixed(4)} | Loss: $${loss.toFixed(2)}`);

        // Update stats with the loss
        this.stats.totalProfit -= Math.abs(loss);

        return {
          success: true,
          leg: 'exit',
          roundId: this.currentRound.roundId,
          side: leg1.side,
          price: soldPrice,
          shares: leg1.shares,
          orderId: result.orderId,
          executionTimeMs: Date.now() - startTime,
        };
      } else {
        this.log(`❌ Leg1 exit failed: ${result.errorMsg}`);
        return {
          success: false,
          leg: 'exit',
          roundId: this.currentRound.roundId,
          error: result.errorMsg,
          executionTimeMs: Date.now() - startTime,
        };
      }
    } catch (error) {
      this.log(`❌ Leg1 exit error: ${error instanceof Error ? error.message : String(error)}`);
      return {
        success: false,
        leg: 'exit',
        roundId: this.currentRound.roundId,
        error: error instanceof Error ? error.message : String(error),
        executionTimeMs: Date.now() - startTime,
      };
    }
  }

  // ===== Private: Signal Detection =====

  private detectSignal(): DipArbSignal | null {
    if (!this.currentRound || !this.market) return null;

    // Check based on current phase
    if (this.currentRound.phase === 'waiting') {
      return this.detectLeg1Signal();
    } else if (this.currentRound.phase === 'leg1_filled') {
      return this.detectLeg2Signal();
    }

    return null;
  }

  private detectLeg1Signal(): DipArbLeg1Signal | null {
    if (!this.currentRound || !this.market) return null;

    // Check if within trading window (轮次开始后的交易窗口)
    const elapsed = (Date.now() - this.currentRound.startTime) / 60000;
    if (elapsed > this.config.windowMinutes) {
      return null;
    }

    const upPrice = this.upAsks[0]?.price ?? 1;
    const downPrice = this.downAsks[0]?.price ?? 1;
    const { openPrices } = this.currentRound;

    // Skip if no valid prices
    if (upPrice >= 1 || downPrice >= 1 || openPrices.up <= 0 || openPrices.down <= 0) {
      return null;
    }

    // ========================================
    // Pattern 1: Instant Dip Detection (核心策略)
    // ========================================
    // 检测 slidingWindowMs (默认 3 秒) 内的瞬时暴跌
    // 这是策略的核心！我们捕捉的是"情绪性暴跌"，不是趋势

    const upPriceAgo = this.getPriceFromHistory('UP', this.config.slidingWindowMs);
    const downPriceAgo = this.getPriceFromHistory('DOWN', this.config.slidingWindowMs);

    // UP instant dip: 3秒内暴跌 >= dipThreshold
    if (upPriceAgo !== null && upPriceAgo > 0) {
      const upInstantDrop = (upPriceAgo - upPrice) / upPriceAgo;
      if (upInstantDrop >= this.config.dipThreshold) {
        if (this.config.debug) {
          this.log(`⚡ Instant DIP detected! UP: ${upPriceAgo.toFixed(4)} → ${upPrice.toFixed(4)} = -${(upInstantDrop * 100).toFixed(1)}% in ${this.config.slidingWindowMs}ms`);
        }
        const signal = this.createLeg1Signal('UP', upPrice, downPrice, 'dip', upInstantDrop, upPriceAgo);
        if (signal && this.validateSignalProfitability(signal)) {
          return signal;
        }
      }
    }

    // DOWN instant dip: 3秒内暴跌 >= dipThreshold
    if (downPriceAgo !== null && downPriceAgo > 0) {
      const downInstantDrop = (downPriceAgo - downPrice) / downPriceAgo;
      if (downInstantDrop >= this.config.dipThreshold) {
        if (this.config.debug) {
          this.log(`⚡ Instant DIP detected! DOWN: ${downPriceAgo.toFixed(4)} → ${downPrice.toFixed(4)} = -${(downInstantDrop * 100).toFixed(1)}% in ${this.config.slidingWindowMs}ms`);
        }
        const signal = this.createLeg1Signal('DOWN', downPrice, upPrice, 'dip', downInstantDrop, downPriceAgo);
        if (signal && this.validateSignalProfitability(signal)) {
          return signal;
        }
      }
    }

    // ========================================
    // Pattern 2: Surge Detection (if enabled)
    // ========================================
    // 暴涨检测：当 token 价格暴涨时，买入对手 token
    if (this.config.enableSurge && upPriceAgo !== null && downPriceAgo !== null) {
      // UP surged in sliding window, buy DOWN
      if (upPriceAgo > 0) {
        const upSurge = (upPrice - upPriceAgo) / upPriceAgo;
        if (upSurge >= this.config.surgeThreshold) {
          if (this.config.debug) {
            this.log(`⚡ Instant SURGE detected! UP: ${upPriceAgo.toFixed(4)} → ${upPrice.toFixed(4)} = +${(upSurge * 100).toFixed(1)}% in ${this.config.slidingWindowMs}ms`);
          }
          // 买入 DOWN，参考价格是 DOWN 的历史价格
          const signal = this.createLeg1Signal('DOWN', downPrice, upPrice, 'surge', upSurge, downPriceAgo);
          if (signal && this.validateSignalProfitability(signal)) {
            return signal;
          }
        }
      }

      // DOWN surged in sliding window, buy UP
      if (downPriceAgo > 0) {
        const downSurge = (downPrice - downPriceAgo) / downPriceAgo;
        if (downSurge >= this.config.surgeThreshold) {
          if (this.config.debug) {
            this.log(`⚡ Instant SURGE detected! DOWN: ${downPriceAgo.toFixed(4)} → ${downPrice.toFixed(4)} = +${(downSurge * 100).toFixed(1)}% in ${this.config.slidingWindowMs}ms`);
          }
          // 买入 UP，参考价格是 UP 的历史价格
          const signal = this.createLeg1Signal('UP', upPrice, downPrice, 'surge', downSurge, upPriceAgo);
          if (signal && this.validateSignalProfitability(signal)) {
            return signal;
          }
        }
      }
    }

    // ========================================
    // Pattern 3: Mispricing Detection
    // ========================================
    // 定价偏差：基于底层资产价格估计胜率，检测错误定价
    if (this.currentRound.priceToBeat > 0 && this.currentUnderlyingPrice > 0) {
      const estimatedWinRate = estimateUpWinRate(this.currentUnderlyingPrice, this.currentRound.priceToBeat);
      const upMispricing = detectMispricing(upPrice, estimatedWinRate);
      const downMispricing = detectMispricing(downPrice, 1 - estimatedWinRate);

      // UP is underpriced
      if (upMispricing >= this.config.dipThreshold) {
        const signal = this.createLeg1Signal('UP', upPrice, downPrice, 'mispricing', upMispricing);
        if (signal && this.validateSignalProfitability(signal)) {
          return signal;
        }
      }

      // DOWN is underpriced
      if (downMispricing >= this.config.dipThreshold) {
        const signal = this.createLeg1Signal('DOWN', downPrice, upPrice, 'mispricing', downMispricing);
        if (signal && this.validateSignalProfitability(signal)) {
          return signal;
        }
      }
    }

    return null;
  }

  private createLeg1Signal(
    side: DipArbSide,
    price: number,
    oppositeAsk: number,
    source: 'dip' | 'surge' | 'mispricing',
    dropPercent: number,
    referencePrice?: number  // 用于 dip/surge: 滑动窗口前的价格
  ): DipArbLeg1Signal | null {
    if (!this.currentRound || !this.market) return null;

    const targetPrice = price * (1 + this.config.maxSlippage);
    const estimatedTotalCost = targetPrice + oppositeAsk;
    const estimatedProfitRate = calculateDipArbProfitRate(estimatedTotalCost);

    // openPrice: 对于 dip/surge 信号，使用滑动窗口参考价格；否则使用轮次开盘价
    const openPrice = referencePrice ??
      (side === 'UP' ? this.currentRound.openPrices.up : this.currentRound.openPrices.down);

    const signal: DipArbLeg1Signal = {
      type: 'leg1',
      roundId: this.currentRound.roundId,
      dipSide: side,
      currentPrice: price,
      openPrice,  // 参考价格（3秒前的价格或轮次开盘价）
      dropPercent,
      targetPrice,
      shares: this.config.shares,
      tokenId: side === 'UP' ? this.market.upTokenId : this.market.downTokenId,
      oppositeAsk,
      estimatedTotalCost,
      estimatedProfitRate,
      source,
    };

    // Add BTC info if available
    if (this.currentRound.priceToBeat > 0 && this.currentUnderlyingPrice > 0) {
      const btcChangePercent = ((this.currentUnderlyingPrice - this.currentRound.priceToBeat) / this.currentRound.priceToBeat) * 100;
      signal.btcInfo = {
        btcPrice: this.currentUnderlyingPrice,
        priceToBeat: this.currentRound.priceToBeat,
        btcChangePercent,
        estimatedWinRate: estimateUpWinRate(this.currentUnderlyingPrice, this.currentRound.priceToBeat),
      };
    }

    return signal;
  }

  private detectLeg2Signal(): DipArbLeg2Signal | null {
    if (!this.currentRound || !this.market || !this.currentRound.leg1) return null;

    const leg1 = this.currentRound.leg1;
    const hedgeSide: DipArbSide = leg1.side === 'UP' ? 'DOWN' : 'UP';
    const currentPrice = hedgeSide === 'UP' ? (this.upAsks[0]?.price ?? 1) : (this.downAsks[0]?.price ?? 1);

    if (currentPrice >= 1) return null;

    const targetPrice = currentPrice * (1 + this.config.maxSlippage);
    const totalCost = leg1.price + targetPrice;

    // Check if profitable - 只用 sumTarget 控制
    if (totalCost > this.config.sumTarget) {
      // 每 5 秒输出一次等待日志，避免刷屏
      if (this.config.debug && Date.now() % 5000 < 100) {
        const profitRate = calculateDipArbProfitRate(totalCost);
        this.log(`⏳ Waiting Leg2: ${hedgeSide} @ ${currentPrice.toFixed(4)}, cost ${totalCost.toFixed(4)} > ${this.config.sumTarget}, profit ${(profitRate * 100).toFixed(1)}%`);
      }
      return null;
    }

    const expectedProfitRate = calculateDipArbProfitRate(totalCost);

    if (this.config.debug) {
      this.log(`✅ Leg2 signal found! ${hedgeSide} @ ${currentPrice.toFixed(4)}, totalCost ${totalCost.toFixed(4)}, profit ${(expectedProfitRate * 100).toFixed(2)}%`);
    }

    // ✅ FIX: Use leg1.shares instead of config.shares to ensure balanced hedge
    // This is critical - Leg2 must buy exactly the same shares as Leg1 to create a perfect hedge
    return {
      type: 'leg2',
      roundId: this.currentRound.roundId,
      hedgeSide,
      leg1,
      currentPrice,
      targetPrice,
      totalCost,
      expectedProfitRate,
      shares: leg1.shares,  // Must match Leg1 to ensure balanced hedge
      tokenId: hedgeSide === 'UP' ? this.market.upTokenId : this.market.downTokenId,
    };
  }

  private validateSignalProfitability(signal: DipArbLeg1Signal): boolean {
    // Leg1 验证：只检查跌幅是否足够大
    // 不在 Leg1 阶段检查 sumTarget，因为：
    // 1. Leg1 的目的是抄底，买入暴跌的一侧
    // 2. Leg2 会等待对侧价格下降后再买入
    // 3. sumTarget 应该在 Leg2 阶段检查

    // 只做基本验证：确保价格合理
    if (signal.currentPrice <= 0 || signal.currentPrice >= 1) {
      if (this.config.debug) {
        this.log(`❌ Signal rejected: invalid price ${signal.currentPrice.toFixed(4)}`);
      }
      return false;
    }

    // 确保跌幅达到阈值（这个已经在 detectLeg1Signal 中检查过，这里再确认一下）
    if (signal.dropPercent < this.config.dipThreshold) {
      if (this.config.debug) {
        this.log(`❌ Signal rejected: drop ${(signal.dropPercent * 100).toFixed(1)}% < threshold ${(this.config.dipThreshold * 100).toFixed(1)}%`);
      }
      return false;
    }

    if (this.config.debug) {
      this.log(`✅ Leg1 signal validated: ${signal.dipSide} @ ${signal.currentPrice.toFixed(4)}, drop ${(signal.dropPercent * 100).toFixed(1)}%`);
      this.log(`   (Leg2 will check sumTarget when opposite price drops)`);
    }

    return true;
  }

  // ===== Private: Signal Handling =====

  private async handleSignal(signal: DipArbSignal): Promise<void> {
    // Check if we can execute before emitting signal
    // This prevents logging signals that won't be executed
    if (!this.config.autoExecute) {
      // Manual mode: always emit signal for user to decide
      this.stats.signalsDetected++;
      this.emit('signal', signal);

      if (this.config.debug) {
        if (isDipArbLeg1Signal(signal)) {
          this.log(`Signal: Leg1 ${signal.dipSide} @ ${signal.currentPrice.toFixed(4)} (${signal.source})`);
        } else {
          this.log(`Signal: Leg2 ${signal.hedgeSide} @ ${signal.currentPrice.toFixed(4)}`);
        }
      }
      return;
    }

    // Auto-execute mode: only emit and log if we will actually execute
    // Note: isExecuting is already checked in processOrderbook(), this is a safety guard
    if (this.isExecuting) {
      return;
    }

    const now = Date.now();
    if (now - this.lastExecutionTime < this.config.executionCooldown) {
      // Skip - within cooldown period
      if (this.config.debug) {
        const remaining = this.config.executionCooldown - (now - this.lastExecutionTime);
        this.log(`Signal skipped (cooldown ${remaining}ms): ${isDipArbLeg1Signal(signal) ? 'Leg1' : 'Leg2'}`);
      }
      return;
    }

    // CRITICAL: Set isExecuting immediately to prevent duplicate signals from being processed
    // This must happen before any async operations or emit() calls
    this.isExecuting = true;

    // Will execute - now emit signal and log
    this.stats.signalsDetected++;
    this.emit('signal', signal);

    if (this.config.debug) {
      const signalType = isDipArbLeg1Signal(signal) ? 'Leg1' : 'Leg2';

      // Log orderbook context before execution (last 5 seconds of data)
      this.logOrderbookContext(`${signalType} Signal`);

      if (isDipArbLeg1Signal(signal)) {
        this.log(`🎯 Signal: Leg1 ${signal.dipSide} @ ${signal.currentPrice.toFixed(4)} (${signal.source})`);
        this.log(`   Target: ${signal.targetPrice.toFixed(4)} | Opposite: ${signal.oppositeAsk.toFixed(4)} | Est.Cost: ${signal.estimatedTotalCost.toFixed(4)}`);
      } else {
        this.log(`🎯 Signal: Leg2 ${signal.hedgeSide} @ ${signal.currentPrice.toFixed(4)}`);
        this.log(`   Target: ${signal.targetPrice.toFixed(4)} | TotalCost: ${signal.totalCost.toFixed(4)} | Profit: ${(signal.expectedProfitRate * 100).toFixed(2)}%`);
      }
    }

    // Execute
    let result: DipArbExecutionResult;

    if (isDipArbLeg1Signal(signal)) {
      result = await this.executeLeg1(signal);
    } else {
      result = await this.executeLeg2(signal);
    }

    this.emit('execution', result);
  }

  // ===== Public API: Auto-Rotate =====

  /**
   * Configure and enable auto-rotate
   *
   * Auto-rotate 会自动：
   * 1. 监控当前市场到期时间
   * 2. 在市场结束前预加载下一个市场
   * 3. 市场结束时自动结算（redeem 或 sell）
   * 4. 无缝切换到下一个 15m 市场
   *
   * @example
   * ```typescript
   * sdk.dipArb.enableAutoRotate({
   *   underlyings: ['BTC', 'ETH'],
   *   duration: '15m',
   *   autoSettle: true,
   *   settleStrategy: 'redeem',
   * });
   * ```
   */
  enableAutoRotate(config: Partial<DipArbAutoRotateConfig> = {}): void {
    this.autoRotateConfig = {
      ...this.autoRotateConfig,
      ...config,
      enabled: true,
    };

    this.log(`Auto-rotate enabled: ${JSON.stringify(this.autoRotateConfig)}`);
    this.startRotateCheck();

    // Start background redemption check if using redeem strategy
    if (this.autoRotateConfig.settleStrategy === 'redeem') {
      this.startRedeemCheck();

      // ✅ FIX: Scan for existing redeemable positions at startup
      this.scanAndQueueRedeemablePositions().catch(err => {
        this.log(`Warning: Failed to scan redeemable positions: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
  }

  /**
   * ✅ FIX: Scan for existing redeemable positions and add them to the queue
   *
   * This is called when auto-rotate is enabled to recover any positions
   * from previous sessions that can be redeemed.
   */
  private async scanAndQueueRedeemablePositions(): Promise<void> {
    if (!this.ctf) {
      this.log('Cannot scan redeemable positions: CTF client not available');
      return;
    }

    try {
      // Scan for recently ended markets of the configured underlyings
      const now = Date.now();
      const markets = await this.scanUpcomingMarkets({
        coin: this.autoRotateConfig.underlyings.length === 1
          ? this.autoRotateConfig.underlyings[0]
          : 'all',
        duration: this.autoRotateConfig.duration,
        minMinutesUntilEnd: -60,  // Include markets that ended up to 60 minutes ago
        maxMinutesUntilEnd: 0,    // Only ended markets
        limit: 20,
      });

      this.log(`🔍 Scanning ${markets.length} recently ended markets for redeemable positions...`);

      let foundCount = 0;
      for (const market of markets) {
        // Skip current market
        if (market.conditionId === this.market?.conditionId) continue;

        // Check if we have any position in this market
        try {
          const tokenIds = {
            yesTokenId: market.upTokenId,
            noTokenId: market.downTokenId,
          };

          const balances = await this.ctf.getPositionBalanceByTokenIds(
            market.conditionId,
            tokenIds
          );

          const upBalance = parseFloat(balances.yesBalance);
          const downBalance = parseFloat(balances.noBalance);

          // If we have any tokens, check if market is resolved
          if (upBalance > 0.01 || downBalance > 0.01) {
            const resolution = await this.ctf.getMarketResolution(market.conditionId);

            if (resolution.isResolved) {
              // Check if we have winning tokens
              const winningBalance = resolution.winningOutcome === 'YES' ? upBalance : downBalance;

              if (winningBalance > 0.01) {
                // Add to pending redemption queue
                const pending: DipArbPendingRedemption = {
                  market,
                  round: {
                    roundId: `recovery-${market.slug}`,
                    priceToBeat: 0,
                    openPrices: { up: 0, down: 0 },
                    startTime: 0,
                    endTime: market.endTime.getTime(),
                    phase: 'completed',
                  },
                  marketEndTime: market.endTime.getTime(),
                  addedAt: now,
                  retryCount: 0,
                };

                this.pendingRedemptions.push(pending);
                foundCount++;
                this.log(`📌 Found redeemable: ${market.slug} | ${resolution.winningOutcome} won | Balance: ${winningBalance.toFixed(2)}`);
              }
            } else if (upBalance > 0.01 && downBalance > 0.01) {
              // Market not resolved but we have pairs - can merge
              const pairsToMerge = Math.min(upBalance, downBalance);
              this.log(`📌 Found mergeable pairs in ${market.slug}: ${pairsToMerge.toFixed(2)}`);

              // Try to merge immediately
              try {
                const result = await this.ctf.mergeByTokenIds(
                  market.conditionId,
                  tokenIds,
                  pairsToMerge.toString()
                );
                if (result.success) {
                  this.log(`✅ Merged ${pairsToMerge.toFixed(2)} pairs from ${market.slug}`);
                }
              } catch (mergeErr) {
                this.log(`⚠️ Failed to merge ${market.slug}: ${mergeErr instanceof Error ? mergeErr.message : String(mergeErr)}`);
              }
            }
          }
        } catch (err) {
          // Skip this market on error
        }
      }

      if (foundCount > 0) {
        this.log(`✅ Found ${foundCount} redeemable positions, added to queue`);
      } else {
        this.log('No redeemable positions found');
      }
    } catch (error) {
      this.log(`Error scanning redeemable positions: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Disable auto-rotate
   */
  disableAutoRotate(): void {
    this.autoRotateConfig.enabled = false;
    this.stopRotateCheck();
    this.stopRedeemCheck();
    this.log('Auto-rotate disabled');

    // Warn if there are pending redemptions
    if (this.pendingRedemptions.length > 0) {
      this.log(`Warning: ${this.pendingRedemptions.length} pending redemptions will not be processed`);
    }
  }

  /**
   * Get auto-rotate configuration
   */
  getAutoRotateConfig(): Required<DipArbAutoRotateConfig> {
    return { ...this.autoRotateConfig };
  }

  /**
   * Manually settle current position
   *
   * 结算策略：
   * - 'redeem': 等待市场结算后 redeem（需要等待结算完成）
   * - 'sell': 直接卖出 token（更快但可能有滑点）
   */
  async settle(strategy: 'redeem' | 'sell' = 'redeem'): Promise<DipArbSettleResult> {
    const startTime = Date.now();

    if (!this.market || !this.currentRound) {
      return {
        success: false,
        strategy,
        error: 'No active market or round',
        executionTimeMs: Date.now() - startTime,
      };
    }

    try {
      if (strategy === 'redeem') {
        return await this.settleByRedeem();
      } else {
        return await this.settleBySell();
      }
    } catch (error) {
      return {
        success: false,
        strategy,
        error: error instanceof Error ? error.message : String(error),
        executionTimeMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Manually rotate to next market
   */
  async rotateToNextMarket(): Promise<DipArbMarketConfig | null> {
    if (!this.autoRotateConfig.enabled) {
      this.log('Auto-rotate not enabled');
      return null;
    }

    // Find next market
    const nextMarket = await this.findNextMarket();
    if (!nextMarket) {
      this.log('No suitable next market found');
      return null;
    }

    // Stop current monitoring
    await this.stop();

    // Start new market
    await this.start(nextMarket);

    const event: DipArbRotateEvent = {
      previousMarket: this.market?.conditionId,
      newMarket: nextMarket.conditionId,
      reason: 'manual',
      timestamp: Date.now(),
    };
    this.emit('rotate', event);

    return nextMarket;
  }

  // ===== Private: Auto-Rotate Implementation =====

  private startRotateCheck(): void {
    if (this.rotateCheckInterval) {
      clearInterval(this.rotateCheckInterval);
    }

    // Check every 30 seconds
    this.rotateCheckInterval = setInterval(() => {
      this.checkRotation();
    }, 30000);

    // Also check immediately
    this.checkRotation();
  }

  private stopRotateCheck(): void {
    if (this.rotateCheckInterval) {
      clearInterval(this.rotateCheckInterval);
      this.rotateCheckInterval = null;
    }
  }

  // ===== Private: Pending Redemption Processing =====

  private startRedeemCheck(): void {
    if (this.redeemCheckInterval) {
      clearInterval(this.redeemCheckInterval);
    }

    const intervalMs = (this.autoRotateConfig.redeemRetryIntervalSeconds || 30) * 1000;

    // Check every 30 seconds (configurable)
    this.redeemCheckInterval = setInterval(() => {
      this.processPendingRedemptions();
    }, intervalMs);

    this.log(`Redeem check started (interval: ${intervalMs / 1000}s)`);
  }

  private stopRedeemCheck(): void {
    if (this.redeemCheckInterval) {
      clearInterval(this.redeemCheckInterval);
      this.redeemCheckInterval = null;
    }
  }

  /**
   * Add a position to pending redemption queue
   */
  private addPendingRedemption(market: DipArbMarketConfig, round: DipArbRoundState): void {
    const pending: DipArbPendingRedemption = {
      market,
      round,
      marketEndTime: market.endTime.getTime(),
      addedAt: Date.now(),
      retryCount: 0,
    };
    this.pendingRedemptions.push(pending);
    this.log(`Added pending redemption: ${market.slug} (queue size: ${this.pendingRedemptions.length})`);
  }

  /**
   * Process all pending redemptions
   * Called periodically by redeemCheckInterval
   */
  private async processPendingRedemptions(): Promise<void> {
    if (this.pendingRedemptions.length === 0) {
      return;
    }

    const now = Date.now();
    const waitMs = (this.autoRotateConfig.redeemWaitMinutes || 5) * 60 * 1000;

    for (let i = this.pendingRedemptions.length - 1; i >= 0; i--) {
      const pending = this.pendingRedemptions[i];
      const timeSinceEnd = now - pending.marketEndTime;

      // Skip if not enough time has passed since market end
      if (timeSinceEnd < waitMs) {
        const waitLeft = Math.round((waitMs - timeSinceEnd) / 1000);
        if (this.config.debug) {
          this.log(`Pending redemption ${pending.market.slug}: waiting ${waitLeft}s more for resolution`);
        }
        continue;
      }

      // Try to redeem
      pending.retryCount++;
      pending.lastRetryAt = now;

      try {
        if (!this.ctf) {
          this.log(`Cannot redeem ${pending.market.slug}: CTF client not available`);
          continue;
        }

        // Check if market is resolved
        const resolution = await this.ctf.getMarketResolution(pending.market.conditionId);

        if (!resolution.isResolved) {
          this.log(`Pending redemption ${pending.market.slug}: market not yet resolved (retry ${pending.retryCount})`);

          // Give up after too many retries (10 minutes of trying)
          if (pending.retryCount > 20) {
            this.log(`Giving up on redemption ${pending.market.slug}: too many retries`);
            this.pendingRedemptions.splice(i, 1);
            this.emit('settled', {
              success: false,
              strategy: 'redeem',
              market: pending.market,
              error: 'Market not resolved after max retries',
              executionTimeMs: 0,
            } as DipArbSettleResult);
          }
          continue;
        }

        // Market is resolved, try to redeem using Polymarket token IDs
        this.log(`Redeeming ${pending.market.slug}...`);
        const tokenIds = {
          yesTokenId: pending.market.upTokenId,
          noTokenId: pending.market.downTokenId,
        };
        const result = await this.ctf.redeemByTokenIds(pending.market.conditionId, tokenIds);

        // Remove from queue
        this.pendingRedemptions.splice(i, 1);

        const settleResult: DipArbSettleResult = {
          success: result.success,
          strategy: 'redeem',
          market: pending.market,
          txHash: result.txHash,
          amountReceived: result.usdcReceived ? parseFloat(result.usdcReceived) : undefined,
          executionTimeMs: 0,
        };

        this.emit('settled', settleResult);
        this.log(`Redemption successful: ${pending.market.slug} | Amount: $${settleResult.amountReceived?.toFixed(2) || 'N/A'}`);

        // Update stats
        if (settleResult.amountReceived) {
          this.stats.totalProfit += settleResult.amountReceived;
        }
      } catch (error) {
        this.log(`Redemption error for ${pending.market.slug}: ${error instanceof Error ? error.message : String(error)}`);

        // Give up after too many retries
        if (pending.retryCount > 20) {
          this.log(`Giving up on redemption ${pending.market.slug}: error after max retries`);
          this.pendingRedemptions.splice(i, 1);
          this.emit('settled', {
            success: false,
            strategy: 'redeem',
            market: pending.market,
            error: error instanceof Error ? error.message : String(error),
            executionTimeMs: 0,
          } as DipArbSettleResult);
        }
      }
    }
  }

  /**
   * Get pending redemptions (for debugging/monitoring)
   */
  getPendingRedemptions(): DipArbPendingRedemption[] {
    return [...this.pendingRedemptions];
  }

  private async checkRotation(): Promise<void> {
    if (!this.autoRotateConfig.enabled || !this.market) {
      if (this.config.debug) {
        this.log(`checkRotation: skipped (enabled=${this.autoRotateConfig.enabled}, market=${!!this.market})`);
      }
      return;
    }

    const now = Date.now();
    const endTime = this.market.endTime.getTime();
    const timeUntilEnd = endTime - now;
    const preloadMs = (this.autoRotateConfig.preloadMinutes || 2) * 60 * 1000;

    if (this.config.debug) {
      const timeLeftSec = Math.round(timeUntilEnd / 1000);
      this.log(`checkRotation: timeUntilEnd=${timeLeftSec}s, preloadMs=${preloadMs / 1000}s, nextMarket=${this.nextMarket?.slug || 'none'}`);
    }

    // Preload next market when close to end
    if (timeUntilEnd <= preloadMs && !this.nextMarket) {
      this.log('Preloading next market...');
      this.nextMarket = await this.findNextMarket();
      if (this.nextMarket) {
        this.log(`Next market ready: ${this.nextMarket.slug}`);
      } else {
        this.log('No next market found during preload');
      }
    }

    // Market ended - settle and rotate
    if (timeUntilEnd <= 0) {
      this.log(`Market ended ${Math.round(-timeUntilEnd / 1000)}s ago, initiating rotation...`);

      // Settle if configured and has position
      if (this.autoRotateConfig.autoSettle && this.currentRound?.leg1) {
        const strategy = this.autoRotateConfig.settleStrategy || 'redeem';

        if (strategy === 'redeem') {
          // For redeem strategy, add to pending queue (will be processed after 5 min wait)
          this.addPendingRedemption(this.market, this.currentRound);
          this.log(`Position added to pending redemption queue (will redeem after ${this.autoRotateConfig.redeemWaitMinutes || 5}min)`);
        } else {
          // For sell strategy, execute immediately
          const settleResult = await this.settle('sell');
          this.emit('settled', settleResult);
        }
      }

      // Rotate to next market
      if (this.nextMarket) {
        const previousMarket = this.market;
        const newMarket = this.nextMarket;
        this.nextMarket = null;

        // Stop current market (this clears the rotate check interval)
        await this.stop();

        // Start new market
        await this.start(newMarket);

        // Restart the rotate check interval for the new market
        this.startRotateCheck();

        const event: DipArbRotateEvent = {
          previousMarket: previousMarket.conditionId,
          newMarket: newMarket.conditionId,
          reason: 'marketEnded',
          timestamp: Date.now(),
        };
        this.emit('rotate', event);
      } else {
        // Try to find a market
        this.log('No preloaded market, searching...');
        const newMarket = await this.findNextMarket();
        if (newMarket) {
          const previousMarket = this.market;

          // Stop current market (this clears the rotate check interval)
          await this.stop();

          // Start new market
          await this.start(newMarket);

          // Restart the rotate check interval for the new market
          this.startRotateCheck();

          const event: DipArbRotateEvent = {
            previousMarket: previousMarket.conditionId,
            newMarket: newMarket.conditionId,
            reason: 'marketEnded',
            timestamp: Date.now(),
          };
          this.emit('rotate', event);
        } else {
          this.log('No next market available, stopping...');
          await this.stop();
        }
      }
    }
  }

  private async findNextMarket(): Promise<DipArbMarketConfig | null> {
    const markets = await this.scanUpcomingMarkets({
      coin: this.autoRotateConfig.underlyings.length === 1
        ? this.autoRotateConfig.underlyings[0]
        : 'all',
      duration: this.autoRotateConfig.duration,
      minMinutesUntilEnd: 5,
      maxMinutesUntilEnd: 30,
      limit: 10,
    });

    // Filter to configured underlyings
    const filtered = markets.filter(m =>
      this.autoRotateConfig.underlyings.includes(m.underlying as DipArbUnderlying)
    );

    // Exclude current market
    const available = filtered.filter(m =>
      m.conditionId !== this.market?.conditionId
    );

    // Return the soonest one
    return available.length > 0 ? available[0] : null;
  }

  private async settleByRedeem(): Promise<DipArbSettleResult> {
    const startTime = Date.now();

    if (!this.ctf || !this.market) {
      return {
        success: false,
        strategy: 'redeem',
        error: 'CTF client or market not available',
        executionTimeMs: Date.now() - startTime,
      };
    }

    try {
      // Check market resolution first
      const resolution = await this.ctf.getMarketResolution(this.market.conditionId);

      if (!resolution.isResolved) {
        return {
          success: false,
          strategy: 'redeem',
          error: 'Market not yet resolved',
          executionTimeMs: Date.now() - startTime,
        };
      }

      // Redeem winning tokens using Polymarket token IDs
      const tokenIds = {
        yesTokenId: this.market.upTokenId,
        noTokenId: this.market.downTokenId,
      };

      const result = await this.ctf.redeemByTokenIds(this.market.conditionId, tokenIds);

      return {
        success: result.success,
        strategy: 'redeem',
        txHash: result.txHash,
        amountReceived: result.usdcReceived ? parseFloat(result.usdcReceived) : undefined,
        executionTimeMs: Date.now() - startTime,
      };
    } catch (error) {
      return {
        success: false,
        strategy: 'redeem',
        error: error instanceof Error ? error.message : String(error),
        executionTimeMs: Date.now() - startTime,
      };
    }
  }

  private async settleBySell(): Promise<DipArbSettleResult> {
    const startTime = Date.now();

    if (!this.tradingService || !this.market || !this.currentRound) {
      return {
        success: false,
        strategy: 'sell',
        error: 'Trading service or market not available',
        executionTimeMs: Date.now() - startTime,
      };
    }

    try {
      let totalReceived = 0;

      // Sell leg1 position if exists
      if (this.currentRound.leg1) {
        const leg1Shares = this.currentRound.leg1.shares;
        const result = await this.tradingService.createMarketOrder({
          tokenId: this.currentRound.leg1.tokenId,
          side: 'SELL' as Side,
          amount: leg1Shares,
        });

        if (result.success) {
          totalReceived += leg1Shares * (this.currentRound.leg1.side === 'UP'
            ? (this.upAsks[0]?.price ?? 0.5)
            : (this.downAsks[0]?.price ?? 0.5));
        }
      }

      // Sell leg2 position if exists
      if (this.currentRound.leg2) {
        const leg2Shares = this.currentRound.leg2.shares;
        const result = await this.tradingService.createMarketOrder({
          tokenId: this.currentRound.leg2.tokenId,
          side: 'SELL' as Side,
          amount: leg2Shares,
        });

        if (result.success) {
          totalReceived += leg2Shares * (this.currentRound.leg2.side === 'UP'
            ? (this.upAsks[0]?.price ?? 0.5)
            : (this.downAsks[0]?.price ?? 0.5));
        }
      }

      return {
        success: true,
        strategy: 'sell',
        amountReceived: totalReceived,
        executionTimeMs: Date.now() - startTime,
      };
    } catch (error) {
      return {
        success: false,
        strategy: 'sell',
        error: error instanceof Error ? error.message : String(error),
        executionTimeMs: Date.now() - startTime,
      };
    }
  }

  // ===== Private: Helpers =====

  /**
   * Update orderbook buffer for smart logging
   * Keeps last 5 seconds of orderbook data
   */
  private updateOrderbookBuffer(_book: OrderbookSnapshot): void {
    if (!this.market) return;

    const upAsk = this.upAsks[0]?.price ?? 0;
    const downAsk = this.downAsks[0]?.price ?? 0;

    this.orderbookBuffer.push({
      timestamp: Date.now(),
      upAsk,
      downAsk,
      upDepth: this.upAsks.length,
      downDepth: this.downAsks.length,
    });

    // Keep only last ORDERBOOK_BUFFER_SIZE entries
    if (this.orderbookBuffer.length > this.ORDERBOOK_BUFFER_SIZE) {
      this.orderbookBuffer = this.orderbookBuffer.slice(-this.ORDERBOOK_BUFFER_SIZE);
    }
  }

  /**
   * Log orderbook summary at intervals (every 10 seconds)
   * Reduces log noise from ~10 logs/sec to 1 log/10sec
   */
  private maybeLogOrderbookSummary(): void {
    const now = Date.now();

    // Only log every ORDERBOOK_LOG_INTERVAL_MS
    if (now - this.lastOrderbookLogTime < this.ORDERBOOK_LOG_INTERVAL_MS) {
      return;
    }

    this.lastOrderbookLogTime = now;

    const upAsk = this.upAsks[0]?.price ?? 0;
    const downAsk = this.downAsks[0]?.price ?? 0;
    const sum = upAsk + downAsk;

    this.log(`📊 Orderbook: UP=${upAsk.toFixed(3)} | DOWN=${downAsk.toFixed(3)} | Sum=${sum.toFixed(3)}`);
  }

  /**
   * Log orderbook buffer around a signal/trade
   * Called when signal is detected to capture market context
   */
  private logOrderbookContext(eventType: string): void {
    if (this.orderbookBuffer.length === 0) return;

    this.log(`📈 ${eventType} - Orderbook context (last ${this.orderbookBuffer.length} ticks):`);

    // Log first, middle, and last entries for context
    const first = this.orderbookBuffer[0];
    const mid = this.orderbookBuffer[Math.floor(this.orderbookBuffer.length / 2)];
    const last = this.orderbookBuffer[this.orderbookBuffer.length - 1];

    const formatTime = (ts: number) => new Date(ts).toISOString().slice(11, 23);

    this.log(`   ${formatTime(first.timestamp)}: UP=${first.upAsk.toFixed(4)} DOWN=${first.downAsk.toFixed(4)}`);
    if (this.orderbookBuffer.length > 2) {
      this.log(`   ${formatTime(mid.timestamp)}: UP=${mid.upAsk.toFixed(4)} DOWN=${mid.downAsk.toFixed(4)}`);
    }
    this.log(`   ${formatTime(last.timestamp)}: UP=${last.upAsk.toFixed(4)} DOWN=${last.downAsk.toFixed(4)}`);

    // Calculate price changes
    const upChange = ((last.upAsk - first.upAsk) / first.upAsk * 100).toFixed(2);
    const downChange = ((last.downAsk - first.downAsk) / first.downAsk * 100).toFixed(2);
    this.log(`   Change: UP ${upChange}% | DOWN ${downChange}%`);
  }

  private log(message: string): void {
    const shouldLog = this.config.debug || message.startsWith('Starting') || message.startsWith('Stopped');
    if (!shouldLog) return;

    const formatted = `[DipArb] ${message}`;

    // Use custom log handler if provided
    if (this.config.logHandler) {
      this.config.logHandler(formatted);
    } else {
      console.log(formatted);
    }
  }
}

// Re-export types
export * from './dip-arb-types.js';
