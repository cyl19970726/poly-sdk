#!/usr/bin/env npx tsx
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * 🚀 尾盤策略 - 實盤版 (Endgame Live Trading)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 基於 v2/v3/v4 共 1300+ 筆模擬交易驗證
 *
 * 【穩定策略】
 * - 2m + LOW (0.75-0.84) + SL15% → ROI: 35%→57%→123%
 * - 2m + MID_LOW (0.85-0.89) + SL15% → ROI: 47%→60%→40%
 *
 * 【安全機制】
 * ✅ Kill Switch - 緊急停止
 * ✅ Fund Limiter - 資金上限
 * ✅ Loss Breaker - 虧損熔斷
 * ✅ 環境檢查 - Paper/Live 區分
 *
 * 【實盤模式】
 * DRY_RUN=true:  模擬下單（預設）
 * DRY_RUN=false: 真實下單 ⚠️
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { PolymarketSDK, TradingGuard } from '../../src/index.js';
import * as fs from 'fs';
import * as path from 'path';

// ═══════════════════════════════════════════════════════════════════════════
// 環境配置
// ═══════════════════════════════════════════════════════════════════════════

interface EnvConfig {
  // 交易模式
  dryRun: boolean;
  privateKey?: string;

  // 保護機制
  killSwitchFile: string;
  maxDailyVolume: number;
  maxTotalPosition: number;
  maxSingleTrade: number;
  maxDailyLoss: number;
  maxTotalLoss: number;
  maxConsecutiveLosses: number;

  // 策略參數
  initialCapital: number;
  capitalPercent: number;
  maxConcurrent: number;
  minOrderSize: number;
  maxOrderSize: number;
}

function loadEnvConfig(): EnvConfig {
  const dryRun = process.env.DRY_RUN !== 'false'; // 預設 true（安全）
  const privateKey = process.env.PRIVATE_KEY;

  // Live 模式必須有私鑰
  if (!dryRun && !privateKey) {
    console.error('\n❌ Live trading requires PRIVATE_KEY');
    console.error('Set: export PRIVATE_KEY=0x...\n');
    process.exit(1);
  }

  // Dry Run 使用更寬鬆的限制（測試用）
  const isDryRun = dryRun;

  return {
    dryRun,
    privateKey,

    // Kill Switch
    killSwitchFile: process.env.KILL_SWITCH_FILE || '/tmp/poly-kill-switch-endgame',

    // Fund Limiter（Dry Run 放寬限制）
    maxDailyVolume: parseFloat(process.env.MAX_DAILY_VOLUME || (isDryRun ? '100000' : '100')),
    maxTotalPosition: parseFloat(process.env.MAX_TOTAL_POSITION || (isDryRun ? '50000' : '200')),
    maxSingleTrade: parseFloat(process.env.MAX_SINGLE_TRADE || (isDryRun ? '10000' : '50')),

    // Loss Circuit Breaker（Dry Run 放寬限制）
    maxDailyLoss: parseFloat(process.env.MAX_DAILY_LOSS || (isDryRun ? '50000' : '30')),
    maxTotalLoss: parseFloat(process.env.MAX_TOTAL_LOSS || (isDryRun ? '100000' : '50')),
    maxConsecutiveLosses: parseInt(process.env.MAX_CONSECUTIVE_LOSSES || (isDryRun ? '1000' : '5')),

    // 策略
    initialCapital: parseFloat(process.env.INITIAL_CAPITAL || '100'),
    capitalPercent: parseFloat(process.env.CAPITAL_PERCENT || '0.5'),
    maxConcurrent: parseInt(process.env.MAX_CONCURRENT || '2'),
    minOrderSize: parseFloat(process.env.MIN_ORDER_SIZE || '5'),
    maxOrderSize: parseFloat(process.env.MAX_ORDER_SIZE || '50'),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 類型定義
// ═══════════════════════════════════════════════════════════════════════════

type Side = 'YES' | 'NO';
type ExitReason = 'TP' | 'SL' | 'END' | 'GUARD';

interface Market {
  conditionId: string;
  yesTokenId: string;
  noTokenId: string;
  coin: string;
  endTime: Date;
  minutesLeft: number;
  errorCount: number;
}

interface Tick {
  ts: number;
  yesBid: number;
  yesAsk: number;
  noBid: number;
  noAsk: number;
}

interface Position {
  market: Market;
  entryTime: Date;
  entrySide: Side;
  entryPrice: number;
  shares: number;
  cost: number;
  priceRange: 'LOW' | 'MID_LOW';

  // 實盤訂單 ID
  orderId?: string;

  exitTime?: Date;
  exitPrice?: number;
  exitReason?: ExitReason;
  pnl?: number;
  pnlPercent?: number;
}

interface Stats {
  trades: number;
  wins: number;
  tp: number;
  sl: number;
  end: number;
  guard: number;
  totalPnl: number;
  roi: number;
  maxDrawdown: number;
  peakCapital: number;
  winRate: number;
  profitFactor: number;
  pnlList: number[];
}

// ═══════════════════════════════════════════════════════════════════════════
// 配置
// ═══════════════════════════════════════════════════════════════════════════

const STRATEGY_CONFIG = {
  // 進場條件
  maxMinutesLeft: 2,
  minMinutesLeft: 0.1,

  // 價格區間
  priceRanges: {
    LOW: { min: 0.75, max: 0.84 },
    MID_LOW: { min: 0.85, max: 0.89 },
  },

  // 出場條件
  takeProfitPrice: 0.97,
  stopLossPercent: 0.15,

  // 運行參數
  cooldownMs: 3000,
  marketRefreshMs: 5000,
  tickIntervalMs: 150,
  maxMarketErrors: 20,
};

// ═══════════════════════════════════════════════════════════════════════════
// 顏色
// ═══════════════════════════════════════════════════════════════════════════

const c = {
  reset: '\x1b[0m', bright: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  cyan: '\x1b[36m', gray: '\x1b[90m', magenta: '\x1b[35m',
};

function fmt(n: number, prefix = ''): string {
  return `${prefix}${n >= 0 ? '+' : ''}${n.toFixed(2)}`;
}

function fmtPct(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

// ═══════════════════════════════════════════════════════════════════════════
// 主程式
// ═══════════════════════════════════════════════════════════════════════════

class EndgameLiveTrading {
  private envConfig: EnvConfig;
  private sdk: PolymarketSDK;
  private guard: TradingGuard;

  private markets = new Map<string, Market>();
  private tickHistory = new Map<string, Tick[]>();
  private positions = new Map<string, Position>();
  private completed: Position[] = [];
  private lastEntryTime = new Map<string, number>();

  private capital: number;
  private stats: Stats;

  private csvPath: string;
  private startTime = new Date();
  private lastDash = 0;
  private lastRefresh = 0;

  constructor() {
    // 載入配置
    this.envConfig = loadEnvConfig();

    // 初始化 SDK
    if (this.envConfig.dryRun) {
      this.sdk = new PolymarketSDK(); // Paper trading 不需要私鑰
    } else {
      this.sdk = new PolymarketSDK({
        privateKey: this.envConfig.privateKey,
      });
    }

    // 初始化 Trading Guard
    // Dry Run 模式：保護機制極度寬鬆（幾乎不會觸發）
    // Live 模式：保護機制正常啟用
    this.guard = new TradingGuard({
      environment: this.envConfig.dryRun ? 'paper' : 'live',
      requireConfirmation: !this.envConfig.dryRun,

      // Dry Run: 只啟用 Kill Switch，其他禁用
      enableKillSwitch: true,
      enableFundLimiter: !this.envConfig.dryRun, // Dry Run 禁用
      enableLossBreaker: !this.envConfig.dryRun, // Dry Run 禁用

      killSwitch: {
        filePath: this.envConfig.killSwitchFile,
      },

      fundLimiter: {
        maxDailyVolume: this.envConfig.maxDailyVolume,
        maxTotalPosition: this.envConfig.maxTotalPosition,
        maxSingleTrade: this.envConfig.maxSingleTrade,
        onLimitReached: (type) => {
          console.error(`\n⚠️ Fund limit reached: ${type}`);
          this.generateReport();
          process.exit(0);
        },
      },

      lossBreaker: {
        maxDailyLoss: this.envConfig.maxDailyLoss,
        maxTotalLoss: this.envConfig.maxTotalLoss,
        maxConsecutiveLosses: this.envConfig.maxConsecutiveLosses,
        initialCapital: this.envConfig.initialCapital,
        onBreakerTripped: (reason) => {
          console.error(`\n🔥 Circuit breaker tripped: ${reason}`);
          this.generateReport();
          process.exit(1);
        },
      },
    });

    this.capital = this.envConfig.initialCapital;
    this.stats = {
      trades: 0, wins: 0, tp: 0, sl: 0, end: 0, guard: 0,
      totalPnl: 0, roi: 0, maxDrawdown: 0,
      peakCapital: this.envConfig.initialCapital,
      winRate: 0, profitFactor: 0, pnlList: [],
    };

    // 設置日誌
    const logDir = path.join(process.cwd(), 'logs');
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

    const ts = new Date().toISOString().replace(/:/g, '-').split('.')[0];
    const prefix = this.envConfig.dryRun ? 'endgame-dry' : 'endgame-live';
    this.csvPath = path.join(logDir, `${prefix}-${ts}.csv`);

    fs.writeFileSync(this.csvPath,
      'Time,Coin,Side,Range,EntryPrice,Shares,Cost,OrderId,' +
      'ExitPrice,Reason,PnL,PnL%,Capital\n'
    );
  }

  private async welcome() {
    await this.guard.initialize();

    console.log(`\n${c.cyan}${'═'.repeat(90)}${c.reset}`);
    console.log(`${c.bright}🚀 Endgame Live Trading${c.reset}`);
    console.log(`${c.cyan}${'═'.repeat(90)}${c.reset}\n`);

    const modeColor = this.envConfig.dryRun ? c.yellow : c.red;
    const modeText = this.envConfig.dryRun ? 'DRY RUN (模擬)' : 'LIVE (真實下單)';
    console.log(`${modeColor}Mode: ${modeText}${c.reset}\n`);

    console.log(`${c.yellow}初始資金: $${this.envConfig.initialCapital}${c.reset}`);
    console.log(`${c.yellow}每筆: ${(this.envConfig.capitalPercent * 100).toFixed(0)}% ($${this.envConfig.minOrderSize}-$${this.envConfig.maxOrderSize})${c.reset}`);
    console.log(`${c.yellow}最大持倉: ${this.envConfig.maxConcurrent}${c.reset}\n`);

    console.log(`${c.gray}策略配置:${c.reset}`);
    console.log(`${c.gray}  進場: 剩餘 < ${STRATEGY_CONFIG.maxMinutesLeft} 分鐘${c.reset}`);
    console.log(`${c.gray}  價格: LOW (0.75-0.84) 或 MID_LOW (0.85-0.89)${c.reset}`);
    console.log(`${c.gray}  止盈: bid >= ${STRATEGY_CONFIG.takeProfitPrice}${c.reset}`);
    console.log(`${c.gray}  止損: 虧損 >= ${(STRATEGY_CONFIG.stopLossPercent * 100).toFixed(0)}%${c.reset}\n`);

    if (!this.envConfig.dryRun) {
      console.log(`${c.red}⚠️  LIVE TRADING - 真實資金將被使用${c.reset}`);
      console.log(`${c.red}Kill Switch: ${this.envConfig.killSwitchFile}${c.reset}\n`);
    }
  }

  private async loadMarkets() {
    const coins = ['BTC', 'ETH', 'SOL', 'XRP'];

    for (const coin of coins) {
      try {
        const list = await this.sdk.dipArb.scanUpcomingMarkets({
          coin: coin.toLowerCase() as any,
          duration: '15m',
          minMinutesUntilEnd: 0,
          maxMinutesUntilEnd: 10,
          limit: 3,
        });

        for (const m of list) {
          if (this.markets.has(m.conditionId)) continue;

          // 獲取 token IDs
          let yesTokenId = '';
          let noTokenId = '';

          try {
            const marketData = await this.sdk.getMarket(m.conditionId);
            if (marketData.tokens && marketData.tokens.length === 2) {
              // tokens[0] 通常是 YES, tokens[1] 是 NO
              yesTokenId = marketData.tokens[0].token_id;
              noTokenId = marketData.tokens[1].token_id;
            }
          } catch (e) {
            console.warn(`Failed to get token IDs for ${m.conditionId}`);
            continue;
          }

          if (!yesTokenId || !noTokenId) {
            console.warn(`Missing token IDs for ${m.conditionId}`);
            continue;
          }

          this.markets.set(m.conditionId, {
            conditionId: m.conditionId,
            yesTokenId,
            noTokenId,
            coin,
            endTime: m.endTime,
            minutesLeft: (m.endTime.getTime() - Date.now()) / 60000,
            errorCount: 0,
          });
          this.tickHistory.set(m.conditionId, []);
        }
      } catch (e) {
        console.warn(`Failed to scan ${coin} markets:`, e);
      }
    }
  }

  private async refreshMarkets() {
    const now = Date.now();
    if (now - this.lastRefresh < STRATEGY_CONFIG.marketRefreshMs) return;
    this.lastRefresh = now;

    for (const [id, m] of this.markets) {
      m.minutesLeft = (m.endTime.getTime() - now) / 60000;

      if (m.minutesLeft < STRATEGY_CONFIG.minMinutesLeft ||
          m.errorCount >= STRATEGY_CONFIG.maxMarketErrors) {
        const pos = this.positions.get(id);
        if (pos) {
          const hist = this.tickHistory.get(id);
          const lastTick = hist?.[hist.length - 1];
          const exitPrice = lastTick ?
            (pos.entrySide === 'YES' ? lastTick.yesBid : lastTick.noBid) :
            pos.entryPrice;
          await this.closePosition(pos, exitPrice, 'END');
        }
        this.markets.delete(id);
        this.tickHistory.delete(id);
      }
    }

    await this.loadMarkets();
  }

  private async fetchTick(market: Market): Promise<Tick | null> {
    try {
      const ob = await this.sdk.getOrderbook(market.conditionId);
      if (!ob?.yes || !ob?.no) return null;

      market.errorCount = 0;
      return {
        ts: Date.now(),
        yesBid: ob.yes.bid,
        yesAsk: ob.yes.ask,
        noBid: ob.no.bid,
        noAsk: ob.no.ask,
      };
    } catch {
      market.errorCount++;
      return null;
    }
  }

  private async checkEntry(market: Market, tick: Tick) {
    // 冷卻
    const lastEntry = this.lastEntryTime.get(market.conditionId) || 0;
    if (Date.now() - lastEntry < STRATEGY_CONFIG.cooldownMs) return;

    // 已有持倉
    if (this.positions.has(market.conditionId)) return;

    // 最大持倉
    if (this.positions.size >= this.envConfig.maxConcurrent) return;

    // 時機檢查
    if (market.minutesLeft > STRATEGY_CONFIG.maxMinutesLeft ||
        market.minutesLeft < STRATEGY_CONFIG.minMinutesLeft) return;

    // 價格區間檢查
    let entrySide: Side | null = null;
    let entryPrice = 0;
    let priceRange: 'LOW' | 'MID_LOW' | null = null;

    // 優先 LOW 區間
    if (tick.yesAsk >= STRATEGY_CONFIG.priceRanges.LOW.min &&
        tick.yesAsk <= STRATEGY_CONFIG.priceRanges.LOW.max) {
      entrySide = 'YES';
      entryPrice = tick.yesAsk;
      priceRange = 'LOW';
    } else if (tick.noAsk >= STRATEGY_CONFIG.priceRanges.LOW.min &&
               tick.noAsk <= STRATEGY_CONFIG.priceRanges.LOW.max) {
      entrySide = 'NO';
      entryPrice = tick.noAsk;
      priceRange = 'LOW';
    }
    // 其次 MID_LOW 區間
    else if (tick.yesAsk >= STRATEGY_CONFIG.priceRanges.MID_LOW.min &&
             tick.yesAsk <= STRATEGY_CONFIG.priceRanges.MID_LOW.max) {
      entrySide = 'YES';
      entryPrice = tick.yesAsk;
      priceRange = 'MID_LOW';
    } else if (tick.noAsk >= STRATEGY_CONFIG.priceRanges.MID_LOW.min &&
               tick.noAsk <= STRATEGY_CONFIG.priceRanges.MID_LOW.max) {
      entrySide = 'NO';
      entryPrice = tick.noAsk;
      priceRange = 'MID_LOW';
    }

    if (!entrySide || !priceRange) return;

    // 計算下單金額
    let orderAmount = this.capital * this.envConfig.capitalPercent;
    orderAmount = Math.max(
      this.envConfig.minOrderSize,
      Math.min(this.envConfig.maxOrderSize, orderAmount)
    );
    if (orderAmount > this.capital) return;

    const shares = Math.floor(orderAmount / entryPrice);
    if (shares < 5) return; // Polymarket 最小 5 shares

    const cost = shares * entryPrice;

    // 🔒 Trading Guard 檢查
    const guardCheck = this.guard.checkBeforeTrade(cost);
    if (!guardCheck.allowed) {
      console.warn(`\n⛔ Trade blocked: ${guardCheck.reason}`);
      return;
    }

    await this.openPosition(market, tick, entrySide, entryPrice, shares, cost, priceRange);
  }

  private async openPosition(
    market: Market,
    tick: Tick,
    entrySide: Side,
    entryPrice: number,
    shares: number,
    cost: number,
    priceRange: 'LOW' | 'MID_LOW'
  ) {
    const pos: Position = {
      market,
      entryTime: new Date(),
      entrySide,
      entryPrice,
      shares,
      cost,
      priceRange,
    };

    // 實盤下單
    if (!this.envConfig.dryRun) {
      try {
        // 初始化 trading service
        await this.sdk.initialize();

        // 獲取 token ID
        const tokenId = entrySide === 'YES' ? market.yesTokenId : market.noTokenId;

        console.log(`${c.magenta}[LIVE] Placing market order...${c.reset}`);

        // 下市價單（FOK = Fill or Kill）
        const orderResult = await this.sdk.tradingService.createMarketOrder({
          tokenId,
          side: 'BUY',
          amount: cost, // 投入金額
          price: entryPrice * 1.02, // 最大可接受價格（+2% 滑點）
          orderType: 'FOK',
        });

        if (!orderResult.success) {
          throw new Error(orderResult.errorMsg || 'Order failed');
        }

        pos.orderId = orderResult.orderId;
        console.log(`${c.green}✅ Order placed: ${orderResult.orderId}${c.reset}`);

      } catch (e: any) {
        console.log(`${c.red}❌ Order failed: ${e.message}${c.reset}`);
        return;
      }
    }

    this.positions.set(market.conditionId, pos);
    this.capital -= cost;
    this.lastEntryTime.set(market.conditionId, Date.now());

    // 🔒 記錄開倉（Fund Limiter）
    this.guard.recordOpen(cost);

    console.log(
      `${c.green}📈 [${priceRange}] ${market.coin} ${entrySide} ` +
      `@${entryPrice.toFixed(3)} x${shares} = $${cost.toFixed(2)} ` +
      `(${market.minutesLeft.toFixed(1)}m)` +
      `${pos.orderId ? ` | Order: ${pos.orderId.slice(0, 8)}...` : ''}${c.reset}`
    );
  }

  private async updatePosition(pos: Position, tick: Tick): Promise<boolean> {
    const bid = pos.entrySide === 'YES' ? tick.yesBid : tick.noBid;

    // 止盈
    if (bid >= STRATEGY_CONFIG.takeProfitPrice) {
      await this.closePosition(pos, bid, 'TP');
      return true;
    }

    // 止損
    const lossPct = (pos.entryPrice - bid) / pos.entryPrice;
    if (lossPct >= STRATEGY_CONFIG.stopLossPercent) {
      await this.closePosition(pos, bid, 'SL');
      return true;
    }

    return false;
  }

  private async closePosition(pos: Position, exitPrice: number, reason: ExitReason) {
    const revenue = exitPrice * pos.shares;
    const pnl = revenue - pos.cost;
    const pnlPct = (pnl / pos.cost) * 100;

    pos.exitTime = new Date();
    pos.exitPrice = exitPrice;
    pos.exitReason = reason;
    pos.pnl = pnl;
    pos.pnlPercent = pnlPct;

    // 實盤平倉
    if (!this.envConfig.dryRun && pos.orderId) {
      try {
        const tokenId = pos.entrySide === 'YES' ?
          pos.market.yesTokenId : pos.market.noTokenId;

        console.log(`${c.magenta}[LIVE] Closing position...${c.reset}`);

        // 下市價賣單
        const orderResult = await this.sdk.tradingService.createMarketOrder({
          tokenId,
          side: 'SELL',
          amount: pos.shares, // 賣出份額
          price: exitPrice * 0.98, // 最小可接受價格（-2% 滑點）
          orderType: 'FOK',
        });

        if (!orderResult.success) {
          console.warn(`${c.yellow}⚠️ Close order failed: ${orderResult.errorMsg}${c.reset}`);
          // 繼續執行，記錄為模擬平倉
        } else {
          console.log(`${c.green}✅ Position closed: ${orderResult.orderId}${c.reset}`);
        }

      } catch (e: any) {
        console.log(`${c.red}❌ Close failed: ${e.message}${c.reset}`);
        // 繼續執行，記錄為模擬平倉
      }
    }

    this.capital += revenue;
    this.positions.delete(pos.market.conditionId);
    this.completed.push(pos);

    // 更新統計
    this.stats.trades++;
    this.stats.totalPnl += pnl;
    this.stats.roi = (this.capital - this.envConfig.initialCapital) /
                     this.envConfig.initialCapital * 100;
    this.stats.pnlList.push(pnl);

    if (this.capital > this.stats.peakCapital) {
      this.stats.peakCapital = this.capital;
    }
    const dd = this.stats.peakCapital - this.capital;
    if (dd > this.stats.maxDrawdown) {
      this.stats.maxDrawdown = dd;
    }

    if (pnl > 0) this.stats.wins++;

    switch (reason) {
      case 'TP': this.stats.tp++; break;
      case 'SL': this.stats.sl++; break;
      case 'END': this.stats.end++; break;
      case 'GUARD': this.stats.guard++; break;
    }

    this.stats.winRate = this.stats.trades > 0 ?
      this.stats.wins / this.stats.trades * 100 : 0;

    const wins = this.stats.pnlList.filter(p => p > 0);
    const losses = this.stats.pnlList.filter(p => p <= 0);
    const totalWin = wins.reduce((a, b) => a + b, 0);
    const totalLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
    this.stats.profitFactor = totalLoss > 0 ? totalWin / totalLoss : 999;

    // 🔒 記錄平倉（Fund Limiter + Loss Breaker）
    this.guard.recordClose(pos.cost, pnl);

    this.saveTrade(pos);

    const pnlColor = pnl >= 0 ? c.green : c.red;
    console.log(
      `${pnlColor}📉 [${pos.priceRange}] ${pos.market.coin} ${reason} ` +
      `${fmt(pnl, '$')} (${fmtPct(pnlPct)}) | ` +
      `Capital: $${this.capital.toFixed(2)}${c.reset}`
    );
  }

  private saveTrade(pos: Position) {
    const row = [
      pos.entryTime.toISOString(),
      pos.market.coin,
      pos.entrySide,
      pos.priceRange,
      pos.entryPrice.toFixed(4),
      pos.shares,
      pos.cost.toFixed(2),
      pos.orderId || 'DRY_RUN',
      pos.exitPrice?.toFixed(4) || '',
      pos.exitReason || '',
      pos.pnl?.toFixed(2) || '',
      pos.pnlPercent?.toFixed(2) || '',
      this.capital.toFixed(2),
    ].join(',');
    fs.appendFileSync(this.csvPath, row + '\n');
  }

  private async monitor(market: Market) {
    // 🔒 檢查 Kill Switch
    if (this.guard.getKillSwitch().isTriggered()) {
      console.error(`\n🚨 Kill Switch triggered!`);
      this.generateReport();
      process.exit(0);
    }

    const tick = await this.fetchTick(market);
    if (!tick) return;

    const hist = this.tickHistory.get(market.conditionId)!;
    hist.push(tick);
    while (hist.length > 100) hist.shift();

    market.minutesLeft = (market.endTime.getTime() - Date.now()) / 60000;

    const pos = this.positions.get(market.conditionId);
    if (pos) {
      await this.updatePosition(pos, tick);
    }
    await this.checkEntry(market, tick);
  }

  private dashboard() {
    const now = Date.now();
    if (now - this.lastDash < 2000) return;
    this.lastDash = now;

    const upSec = Math.floor((now - this.startTime.getTime()) / 1000);
    const h = Math.floor(upSec / 3600);
    const m = Math.floor((upSec % 3600) / 60);
    const s = upSec % 60;

    const modeColor = this.envConfig.dryRun ? c.yellow : c.red;
    const modeText = this.envConfig.dryRun ? 'DRY' : 'LIVE';

    console.clear();
    console.log(`${c.cyan}${'═'.repeat(90)}${c.reset}`);
    console.log(
      `${c.bright}🚀 Endgame Live${c.reset} [${modeColor}${modeText}${c.reset}] | ` +
      `${h}h${m}m${s}s | Trades: ${this.stats.trades}`
    );
    console.log(`${c.cyan}${'═'.repeat(90)}${c.reset}\n`);

    // 🔒 Trading Guard 狀態
    this.guard.printSummary();

    // 績效
    const roiColor = this.stats.roi >= 0 ? c.green : c.red;
    const pnlColor = this.stats.totalPnl >= 0 ? c.green : c.red;

    console.log(`${c.bright}Performance${c.reset}`);
    console.log(`${'─'.repeat(90)}`);
    console.log(
      `Capital: ${c.bright}$${this.capital.toFixed(2)}${c.reset} | ` +
      `PnL: ${pnlColor}${fmt(this.stats.totalPnl, '$')}${c.reset} | ` +
      `ROI: ${roiColor}${fmtPct(this.stats.roi)}${c.reset}`
    );
    console.log(
      `Trades: ${this.stats.trades} | ` +
      `Win: ${this.stats.wins} (${this.stats.winRate.toFixed(1)}%) | ` +
      `TP: ${this.stats.tp} | SL: ${this.stats.sl} | END: ${this.stats.end}`
    );
    console.log(
      `MaxDD: $${this.stats.maxDrawdown.toFixed(2)} | ` +
      `PF: ${this.stats.profitFactor.toFixed(2)}`
    );

    // 持倉
    if (this.positions.size > 0) {
      console.log(`\n${c.bright}Open Positions (${this.positions.size})${c.reset}`);
      for (const pos of this.positions.values()) {
        const hist = this.tickHistory.get(pos.market.conditionId);
        const lastTick = hist?.[hist.length - 1];
        const currentBid = lastTick ?
          (pos.entrySide === 'YES' ? lastTick.yesBid : lastTick.noBid) :
          pos.entryPrice;
        const unrealizedPnl = (currentBid - pos.entryPrice) * pos.shares;
        const unrealizedPct = (currentBid - pos.entryPrice) / pos.entryPrice * 100;
        const pnlColor = unrealizedPnl >= 0 ? c.green : c.red;

        console.log(
          `  ${c.yellow}[${pos.market.coin}]${c.reset} ${pos.entrySide} @${pos.entryPrice.toFixed(3)} → ` +
          `${currentBid.toFixed(3)} | ` +
          `${pnlColor}${fmt(unrealizedPnl, '$')} (${fmtPct(unrealizedPct)})${c.reset} | ` +
          `${pos.market.minutesLeft.toFixed(1)}m`
        );
      }
    }

    // 市場
    console.log(`\n${c.bright}Markets (${this.markets.size})${c.reset}`);
    for (const market of this.markets.values()) {
      const hist = this.tickHistory.get(market.conditionId);
      if (!hist?.length) continue;
      const t = hist[hist.length - 1];
      const timeColor = market.minutesLeft < 1 ? c.red :
                       market.minutesLeft < 2 ? c.yellow : c.cyan;

      const yRange = t.yesAsk >= 0.75 && t.yesAsk <= 0.84 ? 'LOW' :
                    t.yesAsk >= 0.85 && t.yesAsk <= 0.89 ? 'MID_L' : '';
      const nRange = t.noAsk >= 0.75 && t.noAsk <= 0.84 ? 'LOW' :
                    t.noAsk >= 0.85 && t.noAsk <= 0.89 ? 'MID_L' : '';

      const yTag = yRange ? `${c.green}[${yRange}]${c.reset}` : '';
      const nTag = nRange ? `${c.green}[${nRange}]${c.reset}` : '';

      console.log(
        `  ${c.yellow}[${market.coin.padEnd(4)}]${c.reset} ` +
        `Y:${t.yesAsk.toFixed(3)}${yTag} ` +
        `N:${t.noAsk.toFixed(3)}${nTag} ` +
        `${timeColor}${market.minutesLeft.toFixed(1)}m${c.reset}`
      );
    }

    // 最近交易
    if (this.completed.length > 0) {
      console.log(`\n${c.bright}Recent Trades${c.reset}`);
      const recent = this.completed.slice(-5).reverse();
      for (const pos of recent) {
        const pnlColor = (pos.pnl || 0) >= 0 ? c.green : c.red;
        console.log(
          `  [${pos.priceRange}] ${pos.market.coin} ${pos.exitReason} ` +
          `${pnlColor}${fmt(pos.pnl || 0, '$')} (${fmtPct(pos.pnlPercent || 0)})${c.reset}`
        );
      }
    }

    console.log(`\n${c.cyan}${'═'.repeat(90)}${c.reset}`);
    console.log(`${c.gray}Ctrl+C to stop | CSV: ${this.csvPath}${c.reset}`);
  }

  private generateReport() {
    console.log(`\n${c.bright}${'═'.repeat(90)}${c.reset}`);
    console.log(`${c.bright}📊 Final Report - Endgame Live Trading${c.reset}`);
    console.log(`${c.bright}${'═'.repeat(90)}${c.reset}\n`);

    const mode = this.envConfig.dryRun ? 'DRY RUN' : 'LIVE';
    console.log(`Mode: ${mode}`);
    console.log(`Initial: $${this.envConfig.initialCapital} → Final: $${this.capital.toFixed(2)}`);
    console.log(`PnL: ${fmt(this.stats.totalPnl, '$')} | ROI: ${fmtPct(this.stats.roi)}\n`);

    console.log(`Trades: ${this.stats.trades}`);
    console.log(`  Win: ${this.stats.wins} (${this.stats.winRate.toFixed(1)}%)`);
    console.log(`  TP: ${this.stats.tp} | SL: ${this.stats.sl} | END: ${this.stats.end}`);
    console.log(`  PF: ${this.stats.profitFactor.toFixed(2)}`);
    console.log(`  MaxDD: $${this.stats.maxDrawdown.toFixed(2)}`);

    // 按區間統計
    const lowTrades = this.completed.filter(p => p.priceRange === 'LOW');
    const midLowTrades = this.completed.filter(p => p.priceRange === 'MID_LOW');

    if (lowTrades.length > 0) {
      const lowPnl = lowTrades.reduce((sum, p) => sum + (p.pnl || 0), 0);
      const lowWins = lowTrades.filter(p => (p.pnl || 0) > 0).length;
      console.log(`\nLOW: ${lowTrades.length} trades | PnL: ${fmt(lowPnl, '$')} | Win: ${(lowWins / lowTrades.length * 100).toFixed(1)}%`);
    }

    if (midLowTrades.length > 0) {
      const midPnl = midLowTrades.reduce((sum, p) => sum + (p.pnl || 0), 0);
      const midWins = midLowTrades.filter(p => (p.pnl || 0) > 0).length;
      console.log(`MID_LOW: ${midLowTrades.length} trades | PnL: ${fmt(midPnl, '$')} | Win: ${(midWins / midLowTrades.length * 100).toFixed(1)}%`);
    }

    // 🔒 Trading Guard 最終狀態
    console.log('');
    this.guard.printStatus();

    console.log(`\n${c.bright}${'═'.repeat(90)}${c.reset}`);
    console.log(`CSV: ${this.csvPath}`);
    console.log(`${c.bright}${'═'.repeat(90)}${c.reset}\n`);
  }

  async run() {
    await this.welcome();
    await this.loadMarkets();
    console.log(`${c.green}Loaded ${this.markets.size} markets${c.reset}\n`);

    process.on('SIGINT', () => {
      this.generateReport();
      process.exit(0);
    });

    while (true) {
      await this.refreshMarkets();

      for (const market of this.markets.values()) {
        await this.monitor(market);
      }

      this.dashboard();
      await new Promise(r => setTimeout(r, STRATEGY_CONFIG.tickIntervalMs));
    }
  }
}

new EndgameLiveTrading().run();
