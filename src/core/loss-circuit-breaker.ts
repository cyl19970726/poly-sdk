/**
 * Loss Circuit Breaker - 亏损熔断器
 *
 * 用途：
 * - 累计亏损达到阈值自动停止
 * - 连续失败次数过多自动停止
 * - 单日亏损达到阈值自动停止
 * - 回撤过大自动停止
 *
 * 特性：
 * - 多层次保护（累计、单日、连续、回撤）
 * - 达到阈值自动触发 Kill Switch
 * - 持久化数据
 */

import * as fs from 'fs';
import * as path from 'path';
import { KillSwitch } from './kill-switch.js';

export interface LossCircuitBreakerConfig {
  maxTotalLoss?: number;           // 累计最大亏损（美元）
  maxDailyLoss?: number;           // 单日最大亏损（美元）
  maxDrawdownPercent?: number;     // 最大回撤百分比
  maxConsecutiveLosses?: number;   // 最大连续亏损次数

  initialCapital?: number;         // 初始资金（用于计算回撤）

  dataFilePath?: string;
  autoResetDaily?: boolean;

  killSwitch?: KillSwitch;         // Kill Switch 实例
  onBreakerTripped?: (reason: string, details: any) => void;
}

interface BreakerData {
  date: string;
  totalPnL: number;                // 累计盈亏
  dailyPnL: number;                // 今日盈亏
  peakCapital: number;             // 峰值资金
  currentCapital: number;          // 当前资金

  consecutiveLosses: number;       // 当前连续亏损
  maxConsecutiveLosses: number;    // 最大连续亏损

  totalTrades: number;
  winningTrades: number;
  losingTrades: number;

  lastReset: string;
  isTripped: boolean;              // 是否已触发
  tripReason?: string;             // 触发原因
}

export class LossCircuitBreaker {
  private config: Required<Omit<LossCircuitBreakerConfig, 'killSwitch' | 'onBreakerTripped'>> &
    Pick<LossCircuitBreakerConfig, 'killSwitch' | 'onBreakerTripped'>;
  private data: BreakerData;
  private dataFilePath: string;

  constructor(config: LossCircuitBreakerConfig = {}) {
    this.config = {
      maxTotalLoss: config.maxTotalLoss || 100,
      maxDailyLoss: config.maxDailyLoss || 50,
      maxDrawdownPercent: config.maxDrawdownPercent || 20,
      maxConsecutiveLosses: config.maxConsecutiveLosses || 5,
      initialCapital: config.initialCapital || 1000,
      dataFilePath: config.dataFilePath || '/tmp/poly-loss-breaker.json',
      autoResetDaily: config.autoResetDaily !== false,
      killSwitch: config.killSwitch,
      onBreakerTripped: config.onBreakerTripped,
    };

    this.dataFilePath = this.config.dataFilePath;
    this.data = this.loadData();

    if (this.config.autoResetDaily) {
      this.checkAndResetDaily();
      setInterval(() => this.checkAndResetDaily(), 60 * 60 * 1000);
    }
  }

  private loadData(): BreakerData {
    try {
      if (fs.existsSync(this.dataFilePath)) {
        const content = fs.readFileSync(this.dataFilePath, 'utf8');
        return JSON.parse(content);
      }
    } catch (error) {
      console.warn(`Failed to load breaker data: ${error}`);
    }

    return this.createFreshData();
  }

  private saveData(): void {
    try {
      const dir = path.dirname(this.dataFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.dataFilePath, JSON.stringify(this.data, null, 2));
    } catch (error) {
      console.error(`Failed to save breaker data: ${error}`);
    }
  }

  private createFreshData(): BreakerData {
    return {
      date: this.getTodayDate(),
      totalPnL: 0,
      dailyPnL: 0,
      peakCapital: this.config.initialCapital,
      currentCapital: this.config.initialCapital,
      consecutiveLosses: 0,
      maxConsecutiveLosses: 0,
      totalTrades: 0,
      winningTrades: 0,
      losingTrades: 0,
      lastReset: new Date().toISOString(),
      isTripped: false,
    };
  }

  private getTodayDate(): string {
    return new Date().toISOString().split('T')[0];
  }

  private checkAndResetDaily(): void {
    const today = this.getTodayDate();
    if (this.data.date !== today) {
      console.log(`\n📅 Daily reset (Loss Breaker): ${this.data.date} → ${today}`);
      console.log(`Previous day PnL: $${this.data.dailyPnL.toFixed(2)}`);

      this.data.date = today;
      this.data.dailyPnL = 0;
      this.data.lastReset = new Date().toISOString();
      // 不重置 isTripped - 熔断后需手动重置
      this.saveData();

      console.log(`✅ Daily PnL reset\n`);
    }
  }

  /**
   * 记录交易结果
   */
  recordTrade(pnl: number): void {
    this.checkAndResetDaily();

    // 如果已触发，拒绝记录
    if (this.data.isTripped) {
      console.warn('⚠️ Circuit breaker is tripped - ignoring trade');
      return;
    }

    this.data.totalTrades++;
    this.data.totalPnL += pnl;
    this.data.dailyPnL += pnl;
    this.data.currentCapital += pnl;

    // 更新峰值
    if (this.data.currentCapital > this.data.peakCapital) {
      this.data.peakCapital = this.data.currentCapital;
    }

    // 连续亏损统计
    if (pnl < 0) {
      this.data.losingTrades++;
      this.data.consecutiveLosses++;
      if (this.data.consecutiveLosses > this.data.maxConsecutiveLosses) {
        this.data.maxConsecutiveLosses = this.data.consecutiveLosses;
      }
    } else {
      this.data.winningTrades++;
      this.data.consecutiveLosses = 0;
    }

    this.saveData();

    // 检查是否需要触发熔断
    this.checkBreakers();
  }

  /**
   * 检查所有熔断条件
   */
  private checkBreakers(): void {
    if (this.data.isTripped) return;

    // 1. 累计亏损
    if (this.data.totalPnL <= -this.config.maxTotalLoss) {
      this.trip(
        'max_total_loss',
        `Cumulative loss exceeded: $${this.data.totalPnL.toFixed(2)} <= -$${this.config.maxTotalLoss}`
      );
      return;
    }

    // 2. 单日亏损
    if (this.data.dailyPnL <= -this.config.maxDailyLoss) {
      this.trip(
        'max_daily_loss',
        `Daily loss exceeded: $${this.data.dailyPnL.toFixed(2)} <= -$${this.config.maxDailyLoss}`
      );
      return;
    }

    // 3. 回撤百分比
    const drawdown = (this.data.peakCapital - this.data.currentCapital) / this.data.peakCapital * 100;
    if (drawdown >= this.config.maxDrawdownPercent) {
      this.trip(
        'max_drawdown',
        `Drawdown exceeded: ${drawdown.toFixed(2)}% >= ${this.config.maxDrawdownPercent}%`
      );
      return;
    }

    // 4. 连续亏损
    if (this.data.consecutiveLosses >= this.config.maxConsecutiveLosses) {
      this.trip(
        'max_consecutive_losses',
        `Consecutive losses: ${this.data.consecutiveLosses} >= ${this.config.maxConsecutiveLosses}`
      );
      return;
    }
  }

  /**
   * 触发熔断
   */
  private trip(reason: string, message: string): void {
    this.data.isTripped = true;
    this.data.tripReason = message;
    this.saveData();

    console.error('\n' + '🚨'.repeat(30));
    console.error('🔥 CIRCUIT BREAKER TRIPPED! 🔥');
    console.error('🚨'.repeat(30));
    console.error(`Reason: ${reason}`);
    console.error(`Details: ${message}`);
    console.error('All trading will be stopped.');
    console.error('To reset, use: breaker.reset()');
    console.error('🚨'.repeat(30) + '\n');

    // 触发 Kill Switch
    if (this.config.killSwitch) {
      this.config.killSwitch.trigger(`Circuit breaker: ${reason}`);
    }

    // 回调
    if (this.config.onBreakerTripped) {
      this.config.onBreakerTripped(reason, {
        totalPnL: this.data.totalPnL,
        dailyPnL: this.data.dailyPnL,
        currentCapital: this.data.currentCapital,
        consecutiveLosses: this.data.consecutiveLosses,
      });
    }
  }

  /**
   * 检查是否可以交易
   */
  canTrade(): { allowed: boolean; reason?: string } {
    this.checkAndResetDaily();

    if (this.data.isTripped) {
      return {
        allowed: false,
        reason: `Circuit breaker tripped: ${this.data.tripReason}`,
      };
    }

    return { allowed: true };
  }

  /**
   * 获取状态
   */
  getStatus() {
    const drawdown = (this.data.peakCapital - this.data.currentCapital) / this.data.peakCapital * 100;
    const winRate = this.data.totalTrades > 0 ?
      (this.data.winningTrades / this.data.totalTrades * 100) : 0;

    return {
      isTripped: this.data.isTripped,
      tripReason: this.data.tripReason,

      totalPnL: this.data.totalPnL,
      dailyPnL: this.data.dailyPnL,

      currentCapital: this.data.currentCapital,
      peakCapital: this.data.peakCapital,
      drawdown,

      consecutiveLosses: this.data.consecutiveLosses,
      maxConsecutiveLosses: this.data.maxConsecutiveLosses,

      totalTrades: this.data.totalTrades,
      winningTrades: this.data.winningTrades,
      losingTrades: this.data.losingTrades,
      winRate,

      date: this.data.date,
    };
  }

  /**
   * 手动重置（需要明确确认）
   */
  reset(force: boolean = false): void {
    if (!force) {
      console.warn('⚠️ Use reset(true) to confirm circuit breaker reset');
      return;
    }

    console.log('🔄 Circuit breaker reset');
    this.data.isTripped = false;
    this.data.tripReason = undefined;
    this.data.consecutiveLosses = 0;
    this.saveData();
  }

  /**
   * 完全重置（包括所有数据）
   */
  fullReset(): void {
    console.log('🔄 Full reset circuit breaker');
    this.data = this.createFreshData();
    this.saveData();
  }

  /**
   * 更新当前资金（手动同步）
   */
  updateCapital(capital: number): void {
    this.data.currentCapital = capital;
    if (capital > this.data.peakCapital) {
      this.data.peakCapital = capital;
    }
    this.saveData();
  }

  /**
   * 打印状态
   */
  printStatus(): void {
    const status = this.getStatus();
    console.log('\n' + '═'.repeat(60));
    console.log('🔥 Loss Circuit Breaker Status');
    console.log('═'.repeat(60));

    if (status.isTripped) {
      console.log(`⛔ TRIPPED: ${status.tripReason}`);
    } else {
      console.log('✅ Active');
    }

    console.log(`Date: ${status.date}`);
    console.log(`Total PnL: $${status.totalPnL.toFixed(2)} (Limit: -$${this.config.maxTotalLoss})`);
    console.log(`Daily PnL: $${status.dailyPnL.toFixed(2)} (Limit: -$${this.config.maxDailyLoss})`);
    console.log(`Capital: $${status.currentCapital.toFixed(2)} (Peak: $${status.peakCapital.toFixed(2)})`);
    console.log(`Drawdown: ${status.drawdown.toFixed(2)}% (Limit: ${this.config.maxDrawdownPercent}%)`);
    console.log(`Consecutive Losses: ${status.consecutiveLosses} / ${this.config.maxConsecutiveLosses}`);
    console.log(`Win Rate: ${status.winRate.toFixed(1)}% (${status.winningTrades}W / ${status.losingTrades}L)`);
    console.log('═'.repeat(60) + '\n');
  }
}

// 全局单例
let globalBreaker: LossCircuitBreaker | null = null;

export function getGlobalLossBreaker(config?: LossCircuitBreakerConfig): LossCircuitBreaker {
  if (!globalBreaker) {
    globalBreaker = new LossCircuitBreaker(config);
  }
  return globalBreaker;
}

export function resetGlobalLossBreaker(): void {
  globalBreaker = null;
}
