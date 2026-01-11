#!/usr/bin/env npx tsx
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * 🎯 尾盤策略 v4 - 安全版（集成风控机制）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 🔒 安全增强：
 * ✅ Kill Switch - 紧急停止机制
 * ✅ Fund Limiter - 资金上限控制
 * ✅ Loss Circuit Breaker - 亏损熔断
 * ✅ 环境检查 - Paper/Live 区分
 * ✅ 配置验证 - 防止误操作
 *
 * ⚠️ 重要：
 * - Paper Trading: 只模拟，不真实下单
 * - Live Trading: 真实交易，小心使用
 *
 * 📊 策略原理（基于 v2+v3 数据）：
 * - 价格区间: MID_LOW (0.85-0.89) 或 LOW (0.75-0.84)
 * - 进场时机: 2-3 分钟
 * - 止损: 12-15%
 * - 资金管理: 半倉
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { PolymarketSDK, TradingGuard } from '../../src/index.js';
import * as fs from 'fs';
import * as path from 'path';

// ═══════════════════════════════════════════════════════════════════════════
// 环境配置
// ═══════════════════════════════════════════════════════════════════════════

interface EnvConfig {
  // 交易模式
  mode: 'paper' | 'live';

  // 私钥（live 模式必需）
  privateKey?: string;

  // 保护机制配置
  killSwitchFile?: string;
  maxDailyVolume?: number;
  maxTotalPosition?: number;
  maxSingleTrade?: number;
  maxDailyLoss?: number;
  maxTotalLoss?: number;
  maxConsecutiveLosses?: number;

  // 策略配置
  initialCapital?: number;
  minOrderSize?: number;
  maxOrderSize?: number;
}

function loadEnvConfig(): EnvConfig {
  const mode = (process.env.TRADING_MODE || 'paper') as 'paper' | 'live';

  const config: EnvConfig = {
    mode,
    privateKey: process.env.PRIVATE_KEY,

    // Kill Switch
    killSwitchFile: process.env.KILL_SWITCH_FILE || '/tmp/poly-kill-switch',

    // Fund Limiter
    maxDailyVolume: parseFloat(process.env.MAX_DAILY_VOLUME || '100'),
    maxTotalPosition: parseFloat(process.env.MAX_TOTAL_POSITION || '500'),
    maxSingleTrade: parseFloat(process.env.MAX_SINGLE_TRADE || '50'),

    // Loss Circuit Breaker
    maxDailyLoss: parseFloat(process.env.MAX_DAILY_LOSS || '50'),
    maxTotalLoss: parseFloat(process.env.MAX_TOTAL_LOSS || '100'),
    maxConsecutiveLosses: parseInt(process.env.MAX_CONSECUTIVE_LOSSES || '5'),

    // 策略
    initialCapital: parseFloat(process.env.INITIAL_CAPITAL || '1000'),
    minOrderSize: parseFloat(process.env.MIN_ORDER_SIZE || '10'),
    maxOrderSize: parseFloat(process.env.MAX_ORDER_SIZE || '500'),
  };

  // Live 模式必须有私钥
  if (mode === 'live' && !config.privateKey) {
    console.error('\n❌ PRIVATE_KEY is required for live trading');
    console.error('Set environment variable: export PRIVATE_KEY=0x...\n');
    process.exit(1);
  }

  return config;
}

// ═══════════════════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════════════════

type Side = 'YES' | 'NO';
type ExitReason = 'TP' | 'SL' | 'END' | 'GUARD';
type PriceRange = 'LOW' | 'MID_LOW';
type EntryTiming = '3m' | '2m';

interface StrategyConfig {
  id: string;
  name: string;
  timing: EntryTiming;
  priceRange: PriceRange;
  takeProfitPrice: number;
  stopLossPercent: number;
  capitalPercent: number;
  maxConcurrent: number;
  minSum: number;
  maxSum: number;
}

interface Market {
  conditionId: string;
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
  sum: number;
}

interface Position {
  strategyId: string;
  market: Market;
  entryTime: Date;
  entrySide: Side;
  entryPrice: number;
  shares: number;
  cost: number;
  sumAtEntry: number;
  minutesLeftAtEntry: number;
  maxBid: number;
  exitTime?: Date;
  exitPrice?: number;
  exitReason?: ExitReason;
  pnl?: number;
  pnlPercent?: number;
}

interface StrategyState {
  config: StrategyConfig;
  capital: number;
  positions: Map<string, Position>;
  stats: {
    trades: number;
    wins: number;
    tp: number;
    sl: number;
    end: number;
    guard: number;
    totalPnl: number;
    roi: number;
    maxDrawdown: number;
    maxDrawdownPct: number;
    peakCapital: number;
    winRate: number;
    profitFactor: number;
    avgWin: number;
    avgLoss: number;
    expectancy: number;
    winStreak: number;
    lossStreak: number;
    maxWinStreak: number;
    maxLossStreak: number;
    pnlList: number[];
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 价格区间和策略配置
// ═══════════════════════════════════════════════════════════════════════════

const PRICE_RANGES: Record<PriceRange, { min: number; max: number }> = {
  'LOW':      { min: 0.75, max: 0.84 },
  'MID_LOW':  { min: 0.85, max: 0.89 },
};

const TIMING_VALUES: Record<EntryTiming, number> = {
  '3m': 3,
  '2m': 2,
};

const STRATEGIES: StrategyConfig[] = [
  {
    id: 'S1',
    name: '2m+MID_LOW+SL15',
    timing: '2m',
    priceRange: 'MID_LOW',
    takeProfitPrice: 0.97,
    stopLossPercent: 0.15,
    capitalPercent: 0.50,
    maxConcurrent: 2,
    minSum: 0.98,
    maxSum: 1.05,
  },
  {
    id: 'S2',
    name: '3m+LOW+SL15',
    timing: '3m',
    priceRange: 'LOW',
    takeProfitPrice: 0.97,
    stopLossPercent: 0.15,
    capitalPercent: 0.50,
    maxConcurrent: 2,
    minSum: 0.95,
    maxSum: 1.08,
  },
  {
    id: 'S3',
    name: '3m+MID_LOW+SL15',
    timing: '3m',
    priceRange: 'MID_LOW',
    takeProfitPrice: 0.97,
    stopLossPercent: 0.15,
    capitalPercent: 0.50,
    maxConcurrent: 2,
    minSum: 0.98,
    maxSum: 1.05,
  },
  {
    id: 'S4',
    name: '2m+MID_LOW+SL12',
    timing: '2m',
    priceRange: 'MID_LOW',
    takeProfitPrice: 0.97,
    stopLossPercent: 0.12,
    capitalPercent: 0.50,
    maxConcurrent: 2,
    minSum: 0.98,
    maxSum: 1.05,
  },
  {
    id: 'S5',
    name: '2m+LOW+SL15',
    timing: '2m',
    priceRange: 'LOW',
    takeProfitPrice: 0.97,
    stopLossPercent: 0.15,
    capitalPercent: 0.50,
    maxConcurrent: 2,
    minSum: 0.95,
    maxSum: 1.08,
  },
];

// ═══════════════════════════════════════════════════════════════════════════
// 全域設定
// ═══════════════════════════════════════════════════════════════════════════

const c = {
  reset: '\x1b[0m', bright: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  cyan: '\x1b[36m', gray: '\x1b[90m',
};

// ═══════════════════════════════════════════════════════════════════════════
// 工具函數
// ═══════════════════════════════════════════════════════════════════════════

function getPrice(tick: Tick, side: Side, type: 'ask' | 'bid'): number {
  if (side === 'YES') return type === 'ask' ? tick.yesAsk : tick.yesBid;
  return type === 'ask' ? tick.noAsk : tick.noBid;
}

function createState(config: StrategyConfig, initialCapital: number): StrategyState {
  return {
    config,
    capital: initialCapital,
    positions: new Map(),
    stats: {
      trades: 0, wins: 0, tp: 0, sl: 0, end: 0, guard: 0,
      totalPnl: 0, roi: 0,
      maxDrawdown: 0, maxDrawdownPct: 0,
      peakCapital: initialCapital,
      winRate: 0, profitFactor: 0,
      avgWin: 0, avgLoss: 0, expectancy: 0,
      winStreak: 0, lossStreak: 0,
      maxWinStreak: 0, maxLossStreak: 0,
      pnlList: [],
    },
  };
}

function fmt(n: number, prefix = ''): string {
  return `${prefix}${n >= 0 ? '+' : ''}${n.toFixed(2)}`;
}

function fmtPct(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

// ═══════════════════════════════════════════════════════════════════════════
// 主程式
// ═══════════════════════════════════════════════════════════════════════════

class EndgameV4Safe {
  private envConfig: EnvConfig;
  private sdk: PolymarketSDK;
  private guard: TradingGuard;

  private CONFIG: {
    initialCapital: number;
    minOrderSize: number;
    maxOrderSize: number;
    minPrice: number;
    maxPrice: number;
    minMinutesLeft: number;
    cooldownMs: number;
    marketRefreshMs: number;
    tickIntervalMs: number;
    maxMarketErrors: number;
  };

  private markets = new Map<string, Market>();
  private tickHistory = new Map<string, Tick[]>();
  private states = new Map<string, StrategyState>();
  private completed: Position[] = [];
  private lastEntryTime = new Map<string, number>();

  private csvPath: string;
  private startTime = new Date();
  private lastDash = 0;
  private lastRefresh = 0;

  constructor() {
    // 加载环境配置
    this.envConfig = loadEnvConfig();

    // 配置策略参数
    this.CONFIG = {
      initialCapital: this.envConfig.initialCapital!,
      minOrderSize: this.envConfig.minOrderSize!,
      maxOrderSize: this.envConfig.maxOrderSize!,
      minPrice: 0.10,
      maxPrice: 0.99,
      minMinutesLeft: 0.1,
      cooldownMs: 3000,
      marketRefreshMs: 6000,
      tickIntervalMs: 150,
      maxMarketErrors: 15,
    };

    // 初始化 SDK（paper 模式不需要 privateKey）
    if (this.envConfig.mode === 'paper') {
      this.sdk = new PolymarketSDK();
    } else {
      this.sdk = new PolymarketSDK({
        privateKey: this.envConfig.privateKey,
      });
    }

    // 初始化 Trading Guard
    this.guard = new TradingGuard({
      environment: this.envConfig.mode,
      requireConfirmation: this.envConfig.mode === 'live',

      killSwitch: {
        filePath: this.envConfig.killSwitchFile,
      },

      fundLimiter: {
        maxDailyVolume: this.envConfig.maxDailyVolume,
        maxTotalPosition: this.envConfig.maxTotalPosition,
        maxSingleTrade: this.envConfig.maxSingleTrade,
        onLimitReached: (type, current, limit) => {
          console.error(`\n⚠️ Fund limit reached: ${type}`);
          console.error(`Current: ${current.toFixed(2)} | Limit: ${limit.toFixed(2)}`);
          this.generateReport();
          process.exit(0);
        },
      },

      lossBreaker: {
        maxDailyLoss: this.envConfig.maxDailyLoss,
        maxTotalLoss: this.envConfig.maxTotalLoss,
        maxConsecutiveLosses: this.envConfig.maxConsecutiveLosses,
        initialCapital: this.CONFIG.initialCapital,
        onBreakerTripped: (reason, details) => {
          console.error(`\n🔥 Circuit breaker tripped: ${reason}`);
          console.error(`Details:`, details);
          this.generateReport();
          process.exit(1);
        },
      },
    });

    // 初始化策略状态
    for (const s of STRATEGIES) {
      this.states.set(s.id, createState(s, this.CONFIG.initialCapital));
    }

    // 设置日志目录
    const logDir = path.join(process.cwd(), 'logs');
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

    const ts = new Date().toISOString().replace(/:/g, '-').split('.')[0];
    const modePrefix = this.envConfig.mode === 'paper' ? 'paper' : 'live';
    this.csvPath = path.join(logDir, `v4-${modePrefix}-${ts}.csv`);

    fs.writeFileSync(this.csvPath,
      'Strategy,Coin,Side,EntryPrice,Shares,Cost,MinLeft,Sum,' +
      'ExitPrice,Reason,PnL,PnL%,Capital,WinStreak,LossStreak\n'
    );
  }

  private async welcome() {
    await this.guard.initialize();

    console.log(`\n${c.cyan}${'═'.repeat(90)}${c.reset}`);
    console.log(`${c.bright}🎯 Endgame v4 - 安全版 (${this.envConfig.mode.toUpperCase()})${c.reset}`);
    console.log(`${c.cyan}${'═'.repeat(90)}${c.reset}\n`);

    const modeColor = this.envConfig.mode === 'paper' ? c.yellow : c.red;
    console.log(`${modeColor}Mode: ${this.envConfig.mode.toUpperCase()}${c.reset}`);
    console.log(`${c.yellow}Capital: $${this.CONFIG.initialCapital}${c.reset}`);
    console.log(`${c.yellow}Strategies: ${STRATEGIES.length}${c.reset}\n`);

    if (this.envConfig.mode === 'paper') {
      console.log(`${c.gray}📝 Paper Trading Mode: 只模拟，不真实下单${c.reset}\n`);
    } else {
      console.log(`${c.red}⚠️  LIVE TRADING MODE: 真实交易，小心使用${c.reset}`);
      console.log(`${c.red}Kill Switch: ${this.envConfig.killSwitchFile}${c.reset}\n`);
    }

    for (const s of STRATEGIES) {
      console.log(`  ${c.cyan}${s.id}${c.reset}: ${s.name}`);
    }
    console.log('');
  }

  private async loadMarkets() {
    const coins = ['BTC', 'ETH', 'SOL', 'XRP'];

    for (const coin of coins) {
      try {
        const list = await this.sdk.dipArb.scanUpcomingMarkets({
          coin: coin.toLowerCase() as any,
          duration: '15m',
          minMinutesUntilEnd: 0,
          maxMinutesUntilEnd: 16,
          limit: 3,
        });

        for (const m of list) {
          if (this.markets.has(m.conditionId)) continue;

          this.markets.set(m.conditionId, {
            conditionId: m.conditionId,
            coin,
            endTime: m.endTime,
            minutesLeft: (m.endTime.getTime() - Date.now()) / 60000,
            errorCount: 0,
          });
          this.tickHistory.set(m.conditionId, []);
        }
      } catch {}
    }
  }

  private async refreshMarkets() {
    const now = Date.now();
    if (now - this.lastRefresh < this.CONFIG.marketRefreshMs) return;
    this.lastRefresh = now;

    for (const [id, m] of this.markets) {
      m.minutesLeft = (m.endTime.getTime() - now) / 60000;

      if (m.minutesLeft < this.CONFIG.minMinutesLeft || m.errorCount >= this.CONFIG.maxMarketErrors) {
        for (const state of this.states.values()) {
          const pos = state.positions.get(id);
          if (pos) {
            const hist = this.tickHistory.get(id);
            const lastTick = hist?.[hist.length - 1];
            const exitPrice = lastTick ? getPrice(lastTick, pos.entrySide, 'bid') : pos.entryPrice;
            this.closePosition(state, pos, exitPrice, 'END');
          }
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
        sum: ob.yes.ask + ob.no.ask,
      };
    } catch {
      market.errorCount++;
      return null;
    }
  }

  private checkEntry(state: StrategyState, market: Market, tick: Tick) {
    const config = state.config;

    const lastEntry = this.lastEntryTime.get(`${config.id}-${market.conditionId}`) || 0;
    if (Date.now() - lastEntry < this.CONFIG.cooldownMs) return;
    if (state.positions.has(market.conditionId)) return;
    if (state.positions.size >= config.maxConcurrent) return;

    const timingMinutes = TIMING_VALUES[config.timing];
    if (market.minutesLeft > timingMinutes || market.minutesLeft < this.CONFIG.minMinutesLeft) return;

    if (tick.sum < config.minSum || tick.sum > config.maxSum) return;

    const bounds = PRICE_RANGES[config.priceRange];
    let entrySide: Side | null = null;
    let entryPrice = 0;

    if (tick.yesAsk >= bounds.min && tick.yesAsk <= bounds.max) {
      entrySide = 'YES';
      entryPrice = tick.yesAsk;
    } else if (tick.noAsk >= bounds.min && tick.noAsk <= bounds.max) {
      entrySide = 'NO';
      entryPrice = tick.noAsk;
    }

    if (!entrySide || entryPrice < this.CONFIG.minPrice || entryPrice > this.CONFIG.maxPrice) return;

    let orderAmount = state.capital * config.capitalPercent;
    orderAmount = Math.max(this.CONFIG.minOrderSize, Math.min(this.CONFIG.maxOrderSize, orderAmount));
    if (orderAmount > state.capital) return;

    const shares = Math.floor(orderAmount / entryPrice);
    if (shares < 1) return;

    const cost = shares * entryPrice;

    // 🔒 检查 Trading Guard
    const guardCheck = this.guard.checkBeforeTrade(cost);
    if (!guardCheck.allowed) {
      console.warn(`\n⛔ Trade blocked: ${guardCheck.reason}`);
      return;
    }

    this.openPosition(state, market, tick, entrySide, entryPrice, shares, cost);
  }

  private openPosition(state: StrategyState, market: Market, tick: Tick, entrySide: Side, entryPrice: number, shares: number, cost: number) {
    const pos: Position = {
      strategyId: state.config.id,
      market,
      entryTime: new Date(),
      entrySide,
      entryPrice,
      shares,
      cost,
      sumAtEntry: tick.sum,
      minutesLeftAtEntry: market.minutesLeft,
      maxBid: getPrice(tick, entrySide, 'bid'),
    };

    state.positions.set(market.conditionId, pos);
    state.capital -= cost;
    this.lastEntryTime.set(`${state.config.id}-${market.conditionId}`, Date.now());

    // 🔒 记录开仓（Fund Limiter）
    this.guard.recordOpen(cost);

    console.log(
      `${c.green}📈 [${state.config.id}] ${market.coin} ${entrySide} ` +
      `@${entryPrice.toFixed(3)} x${shares} = $${cost.toFixed(0)} ` +
      `(${market.minutesLeft.toFixed(1)}m)${c.reset}`
    );
  }

  private updatePosition(state: StrategyState, pos: Position, tick: Tick): boolean {
    const config = state.config;
    const bid = getPrice(tick, pos.entrySide, 'bid');

    pos.maxBid = Math.max(pos.maxBid, bid);

    // 止盈
    if (bid >= config.takeProfitPrice) {
      this.closePosition(state, pos, bid, 'TP');
      return true;
    }

    // 止損
    const lossPct = (pos.entryPrice - bid) / pos.entryPrice;
    if (lossPct >= config.stopLossPercent) {
      this.closePosition(state, pos, bid, 'SL');
      return true;
    }

    return false;
  }

  private closePosition(state: StrategyState, pos: Position, exitPrice: number, reason: ExitReason) {
    const revenue = exitPrice * pos.shares;
    const pnl = revenue - pos.cost;
    const pnlPct = (pnl / pos.cost) * 100;

    pos.exitTime = new Date();
    pos.exitPrice = exitPrice;
    pos.exitReason = reason;
    pos.pnl = pnl;
    pos.pnlPercent = pnlPct;

    state.capital += revenue;
    state.positions.delete(pos.market.conditionId);
    this.completed.push(pos);

    const st = state.stats;
    st.trades++;
    st.totalPnl += pnl;
    st.roi = (state.capital - this.CONFIG.initialCapital) / this.CONFIG.initialCapital * 100;
    st.pnlList.push(pnl);

    if (state.capital > st.peakCapital) {
      st.peakCapital = state.capital;
    }
    const dd = st.peakCapital - state.capital;
    if (dd > st.maxDrawdown) {
      st.maxDrawdown = dd;
      st.maxDrawdownPct = dd / st.peakCapital * 100;
    }

    // 連勝/連敗統計
    if (pnl > 0) {
      st.wins++;
      st.winStreak++;
      st.lossStreak = 0;
      if (st.winStreak > st.maxWinStreak) st.maxWinStreak = st.winStreak;
    } else {
      st.winStreak = 0;
      st.lossStreak++;
      if (st.lossStreak > st.maxLossStreak) st.maxLossStreak = st.lossStreak;
    }

    switch (reason) {
      case 'TP': st.tp++; break;
      case 'SL': st.sl++; break;
      case 'END': st.end++; break;
      case 'GUARD': st.guard++; break;
    }

    st.winRate = st.trades > 0 ? st.wins / st.trades * 100 : 0;

    const wins = st.pnlList.filter(p => p > 0);
    const losses = st.pnlList.filter(p => p <= 0);
    st.avgWin = wins.length > 0 ? wins.reduce((a, b) => a + b, 0) / wins.length : 0;
    st.avgLoss = losses.length > 0 ? Math.abs(losses.reduce((a, b) => a + b, 0) / losses.length) : 0;

    const totalWin = wins.reduce((a, b) => a + b, 0);
    const totalLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
    st.profitFactor = totalLoss > 0 ? totalWin / totalLoss : totalWin > 0 ? 999 : 0;
    st.expectancy = (st.winRate / 100 * st.avgWin) - ((100 - st.winRate) / 100 * st.avgLoss);

    // 🔒 记录平仓（Fund Limiter + Loss Breaker）
    this.guard.recordClose(pos.cost, pnl);

    this.saveTrade(state, pos);

    const pnlColor = pnl >= 0 ? c.green : c.red;
    console.log(
      `${pnlColor}📉 [${pos.strategyId}] ${pos.market.coin} ${reason} ` +
      `${fmt(pnl, '$')} (${fmtPct(pnlPct)}) | ` +
      `Capital: $${state.capital.toFixed(0)} | ` +
      `W${st.winStreak}/L${st.lossStreak}${c.reset}`
    );
  }

  private saveTrade(state: StrategyState, pos: Position) {
    const st = state.stats;
    const row = [
      pos.strategyId,
      pos.market.coin,
      pos.entrySide,
      pos.entryPrice.toFixed(4),
      pos.shares,
      pos.cost.toFixed(2),
      pos.minutesLeftAtEntry.toFixed(2),
      pos.sumAtEntry.toFixed(4),
      pos.exitPrice?.toFixed(4) || '',
      pos.exitReason || '',
      pos.pnl?.toFixed(2) || '',
      pos.pnlPercent?.toFixed(2) || '',
      state.capital.toFixed(2),
      st.winStreak,
      st.lossStreak,
    ].join(',');
    fs.appendFileSync(this.csvPath, row + '\n');
  }

  private async monitor(market: Market) {
    // 🔒 检查 Kill Switch
    const guardStatus = this.guard.getStatus();
    if (guardStatus.killSwitch.triggered) {
      console.error(`\n🚨 Kill Switch triggered: ${guardStatus.killSwitch.message}`);
      this.generateReport();
      process.exit(0);
    }

    const tick = await this.fetchTick(market);
    if (!tick) return;

    const hist = this.tickHistory.get(market.conditionId)!;
    hist.push(tick);
    while (hist.length > 200) hist.shift();

    market.minutesLeft = (market.endTime.getTime() - Date.now()) / 60000;

    for (const state of this.states.values()) {
      const pos = state.positions.get(market.conditionId);
      if (pos) {
        this.updatePosition(state, pos, tick);
      }
      this.checkEntry(state, market, tick);
    }
  }

  private dashboard() {
    const now = Date.now();
    if (now - this.lastDash < 2500) return;
    this.lastDash = now;

    const upSec = Math.floor((now - this.startTime.getTime()) / 1000);
    const h = Math.floor(upSec / 3600);
    const m = Math.floor((upSec % 3600) / 60);
    const s = upSec % 60;

    console.clear();
    console.log(`${c.cyan}${'═'.repeat(120)}${c.reset}`);
    const modeColor = this.envConfig.mode === 'paper' ? c.yellow : c.red;
    console.log(`${c.bright}🎯 Endgame v4 (${modeColor}${this.envConfig.mode.toUpperCase()}${c.reset}${c.bright})${c.reset} | ${h}h${m}m${s}s | Markets: ${this.markets.size} | Trades: ${this.completed.length}`);
    console.log(`${c.cyan}${'═'.repeat(120)}${c.reset}\n`);

    // 🔒 Trading Guard 状态
    this.guard.printSummary();

    // 策略排行
    console.log(`${c.bright}Strategy Performance${c.reset}`);
    console.log(`${'─'.repeat(120)}`);
    console.log(
      `${'ID'.padEnd(5)}` +
      `${'Name'.padEnd(20)}` +
      `${'Trades'.padEnd(8)}` +
      `${'Win%'.padEnd(8)}` +
      `${'TP'.padEnd(5)}` +
      `${'SL'.padEnd(5)}` +
      `${'PnL'.padEnd(12)}` +
      `${'ROI%'.padEnd(10)}` +
      `${'Capital'.padEnd(10)}` +
      `${'MaxDD%'.padEnd(9)}` +
      `${'PF'.padEnd(7)}` +
      `${'Expect'.padEnd(10)}` +
      `${'Streak'}`
    );
    console.log(`${'─'.repeat(120)}`);

    const sorted = Array.from(this.states.values())
      .sort((a, b) => b.stats.roi - a.stats.roi);

    for (const state of sorted) {
      const st = state.stats;
      const cfg = state.config;
      const pnlColor = st.totalPnl >= 0 ? c.green : c.red;
      const roiColor = st.roi >= 0 ? c.green : c.red;
      const posCount = state.positions.size;

      console.log(
        `${c.cyan}${cfg.id.padEnd(5)}${c.reset}` +
        `${(cfg.name + (posCount > 0 ? `[${posCount}]` : '')).padEnd(20)}` +
        `${String(st.trades).padEnd(8)}` +
        `${(st.winRate.toFixed(1) + '%').padEnd(8)}` +
        `${String(st.tp).padEnd(5)}` +
        `${String(st.sl).padEnd(5)}` +
        `${pnlColor}${fmt(st.totalPnl, '$').padEnd(11)}${c.reset}` +
        `${roiColor}${fmtPct(st.roi).padEnd(9)}${c.reset}` +
        `${'$' + state.capital.toFixed(0).padEnd(9)}` +
        `${(st.maxDrawdownPct.toFixed(1) + '%').padEnd(9)}` +
        `${st.profitFactor.toFixed(2).padEnd(7)}` +
        `${fmt(st.expectancy, '$').padEnd(10)}` +
        `W${st.maxWinStreak}/L${st.maxLossStreak}`
      );
    }

    // 市場
    console.log(`\n${c.bright}Markets${c.reset}`);
    for (const market of this.markets.values()) {
      const hist = this.tickHistory.get(market.conditionId);
      if (!hist?.length) continue;
      const t = hist[hist.length - 1];
      const timeColor = market.minutesLeft < 1 ? c.red : market.minutesLeft < 3 ? c.yellow : c.cyan;

      const yInLow = t.yesAsk >= 0.75 && t.yesAsk <= 0.84;
      const yInMidLow = t.yesAsk >= 0.85 && t.yesAsk <= 0.89;
      const nInLow = t.noAsk >= 0.75 && t.noAsk <= 0.84;
      const nInMidLow = t.noAsk >= 0.85 && t.noAsk <= 0.89;

      const yTag = yInLow ? '[LOW]' : yInMidLow ? '[MID_LOW]' : '';
      const nTag = nInLow ? '[LOW]' : nInMidLow ? '[MID_LOW]' : '';

      console.log(
        `  ${c.yellow}[${market.coin.padEnd(4)}]${c.reset} ` +
        `Y:${t.yesAsk.toFixed(3)}${yTag.padEnd(10)} ` +
        `N:${t.noAsk.toFixed(3)}${nTag.padEnd(10)} ` +
        `Sum:${t.sum.toFixed(3)} ` +
        `${timeColor}${market.minutesLeft.toFixed(1)}m${c.reset}`
      );
    }

    console.log(`\n${c.cyan}${'═'.repeat(120)}${c.reset}`);
    console.log(`${c.gray}Ctrl+C to stop | CSV: ${this.csvPath}${c.reset}`);
  }

  private generateReport() {
    console.log(`\n${c.bright}${'═'.repeat(100)}${c.reset}`);
    console.log(`${c.bright}📊 Final Report - Endgame v4 Safe${c.reset}`);
    console.log(`${c.bright}${'═'.repeat(100)}${c.reset}\n`);

    const modeColor = this.envConfig.mode === 'paper' ? c.yellow : c.red;
    console.log(`${modeColor}Mode: ${this.envConfig.mode.toUpperCase()}${c.reset}`);
    console.log(`${c.yellow}Capital: $${this.CONFIG.initialCapital} | Trades: ${this.completed.length}${c.reset}\n`);

    // 🔒 Trading Guard 最终状态
    this.guard.printStatus();

    const sorted = Array.from(this.states.values())
      .sort((a, b) => b.stats.roi - a.stats.roi);

    console.log(`${c.cyan}═══ Strategy Results ═══${c.reset}\n`);

    for (let i = 0; i < sorted.length; i++) {
      const state = sorted[i];
      const st = state.stats;
      const cfg = state.config;
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '  ';
      const status = st.roi > 0 ? '✅' : st.trades < 5 ? '⏳' : '❌';

      console.log(`${medal} ${status} ${c.cyan}${cfg.id}${c.reset} ${cfg.name}`);
      console.log(`   Trades: ${st.trades} | Win: ${st.wins} (${st.winRate.toFixed(1)}%) | TP: ${st.tp} | SL: ${st.sl} | END: ${st.end}`);
      console.log(`   PnL: ${fmt(st.totalPnl, '$')} | ROI: ${fmtPct(st.roi)}`);
      console.log(`   Capital: $${state.capital.toFixed(2)} | MaxDD: ${st.maxDrawdownPct.toFixed(1)}%`);
      console.log(`   PF: ${st.profitFactor.toFixed(2)} | Expect: ${fmt(st.expectancy, '$')} | MaxStreak: W${st.maxWinStreak}/L${st.maxLossStreak}`);
      console.log('');
    }

    console.log(`\n${c.bright}${'═'.repeat(100)}${c.reset}`);
    console.log(`${c.green}CSV: ${this.csvPath}${c.reset}`);
    console.log(`${c.bright}${'═'.repeat(100)}${c.reset}\n`);
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
      await new Promise(r => setTimeout(r, this.CONFIG.tickIntervalMs));
    }
  }
}

new EndgameV4Safe().run();
