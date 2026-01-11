/**
 * Fund Limiter - 资金上限控制
 *
 * 用途：
 * - 限制日交易总额
 * - 限制总持仓价值
 * - 限制单笔交易金额
 * - 防止无限制交易
 *
 * 特性：
 * - 自动重置日计数器（UTC 0:00）
 * - 持久化到文件（进程重启后恢复）
 * - 达到限制自动触发 Kill Switch
 */

import * as fs from 'fs';
import * as path from 'path';

export interface FundLimiterConfig {
  maxDailyVolume?: number;      // 每日最大交易额（美元）
  maxTotalPosition?: number;    // 最大总持仓价值（美元）
  maxSingleTrade?: number;      // 单笔交易最大金额（美元）
  maxDailyTrades?: number;      // 每日最大交易次数

  dataFilePath?: string;        // 数据持久化路径
  autoResetDaily?: boolean;     // 自动每日重置

  onLimitReached?: (limitType: string, current: number, limit: number) => void;
}

interface FundLimiterData {
  date: string;                 // YYYY-MM-DD
  dailyVolume: number;          // 今日交易总额
  dailyTrades: number;          // 今日交易次数
  totalPosition: number;        // 当前总持仓
  lastReset: string;            // 上次重置时间
}

export class FundLimiter {
  private config: Required<Omit<FundLimiterConfig, 'onLimitReached'>> & Pick<FundLimiterConfig, 'onLimitReached'>;
  private data: FundLimiterData;
  private dataFilePath: string;

  constructor(config: FundLimiterConfig = {}) {
    this.config = {
      maxDailyVolume: config.maxDailyVolume || 1000,
      maxTotalPosition: config.maxTotalPosition || 5000,
      maxSingleTrade: config.maxSingleTrade || 100,
      maxDailyTrades: config.maxDailyTrades || 50,
      dataFilePath: config.dataFilePath || '/tmp/poly-fund-limiter.json',
      autoResetDaily: config.autoResetDaily !== false,
      onLimitReached: config.onLimitReached,
    };

    this.dataFilePath = this.config.dataFilePath;
    this.data = this.loadData();

    // 自动重置检查
    if (this.config.autoResetDaily) {
      this.checkAndResetDaily();
      // 每小时检查一次是否需要重置
      setInterval(() => this.checkAndResetDaily(), 60 * 60 * 1000);
    }
  }

  /**
   * 加载持久化数据
   */
  private loadData(): FundLimiterData {
    try {
      if (fs.existsSync(this.dataFilePath)) {
        const content = fs.readFileSync(this.dataFilePath, 'utf8');
        return JSON.parse(content);
      }
    } catch (error) {
      console.warn(`Failed to load fund limiter data: ${error}`);
    }

    return this.createFreshData();
  }

  /**
   * 保存数据
   */
  private saveData(): void {
    try {
      const dir = path.dirname(this.dataFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.dataFilePath, JSON.stringify(this.data, null, 2));
    } catch (error) {
      console.error(`Failed to save fund limiter data: ${error}`);
    }
  }

  /**
   * 创建新的数据
   */
  private createFreshData(): FundLimiterData {
    return {
      date: this.getTodayDate(),
      dailyVolume: 0,
      dailyTrades: 0,
      totalPosition: 0,
      lastReset: new Date().toISOString(),
    };
  }

  /**
   * 获取今天的日期（YYYY-MM-DD，UTC）
   */
  private getTodayDate(): string {
    return new Date().toISOString().split('T')[0];
  }

  /**
   * 检查并重置日计数器
   */
  private checkAndResetDaily(): void {
    const today = this.getTodayDate();
    if (this.data.date !== today) {
      console.log(`\n📅 Daily reset: ${this.data.date} → ${today}`);
      console.log(`Previous day: Volume=$${this.data.dailyVolume.toFixed(2)}, Trades=${this.data.dailyTrades}`);

      this.data.date = today;
      this.data.dailyVolume = 0;
      this.data.dailyTrades = 0;
      this.data.lastReset = new Date().toISOString();
      this.saveData();

      console.log(`✅ Daily counters reset\n`);
    }
  }

  /**
   * 检查是否可以进行交易
   * @returns { allowed: boolean, reason?: string }
   */
  canTrade(amount: number): { allowed: boolean; reason?: string } {
    this.checkAndResetDaily();

    // 1. 检查单笔交易限额
    if (amount > this.config.maxSingleTrade) {
      const reason = `Single trade limit exceeded: $${amount.toFixed(2)} > $${this.config.maxSingleTrade}`;
      this.notifyLimitReached('single_trade', amount, this.config.maxSingleTrade);
      return { allowed: false, reason };
    }

    // 2. 检查日交易额度
    if (this.data.dailyVolume + amount > this.config.maxDailyVolume) {
      const reason = `Daily volume limit exceeded: $${(this.data.dailyVolume + amount).toFixed(2)} > $${this.config.maxDailyVolume}`;
      this.notifyLimitReached('daily_volume', this.data.dailyVolume + amount, this.config.maxDailyVolume);
      return { allowed: false, reason };
    }

    // 3. 检查日交易次数
    if (this.data.dailyTrades + 1 > this.config.maxDailyTrades) {
      const reason = `Daily trades limit exceeded: ${this.data.dailyTrades + 1} > ${this.config.maxDailyTrades}`;
      this.notifyLimitReached('daily_trades', this.data.dailyTrades + 1, this.config.maxDailyTrades);
      return { allowed: false, reason };
    }

    // 4. 检查总持仓限制
    if (this.data.totalPosition + amount > this.config.maxTotalPosition) {
      const reason = `Total position limit exceeded: $${(this.data.totalPosition + amount).toFixed(2)} > $${this.config.maxTotalPosition}`;
      this.notifyLimitReached('total_position', this.data.totalPosition + amount, this.config.maxTotalPosition);
      return { allowed: false, reason };
    }

    return { allowed: true };
  }

  /**
   * 记录交易（开仓）
   */
  recordTrade(amount: number): void {
    this.checkAndResetDaily();

    this.data.dailyVolume += amount;
    this.data.dailyTrades += 1;
    this.data.totalPosition += amount;

    this.saveData();
  }

  /**
   * 记录平仓
   */
  recordClose(amount: number): void {
    this.data.totalPosition = Math.max(0, this.data.totalPosition - amount);
    this.saveData();
  }

  /**
   * 通知达到限制
   */
  private notifyLimitReached(limitType: string, current: number, limit: number): void {
    console.error(`\n⚠️ LIMIT REACHED: ${limitType}`);
    console.error(`Current: ${current.toFixed(2)} | Limit: ${limit.toFixed(2)}`);

    if (this.config.onLimitReached) {
      this.config.onLimitReached(limitType, current, limit);
    }
  }

  /**
   * 获取当前状态
   */
  getStatus(): {
    dailyVolume: number;
    dailyVolumePercent: number;
    dailyTrades: number;
    dailyTradesPercent: number;
    totalPosition: number;
    totalPositionPercent: number;
    date: string;
  } {
    return {
      dailyVolume: this.data.dailyVolume,
      dailyVolumePercent: (this.data.dailyVolume / this.config.maxDailyVolume) * 100,
      dailyTrades: this.data.dailyTrades,
      dailyTradesPercent: (this.data.dailyTrades / this.config.maxDailyTrades) * 100,
      totalPosition: this.data.totalPosition,
      totalPositionPercent: (this.data.totalPosition / this.config.maxTotalPosition) * 100,
      date: this.data.date,
    };
  }

  /**
   * 获取配置
   */
  getConfig(): Readonly<typeof this.config> {
    return { ...this.config };
  }

  /**
   * 手动重置
   */
  reset(): void {
    console.log('🔄 Manual reset fund limiter');
    this.data = this.createFreshData();
    this.saveData();
  }

  /**
   * 更新总持仓（手动同步）
   */
  updateTotalPosition(amount: number): void {
    this.data.totalPosition = amount;
    this.saveData();
  }

  /**
   * 打印状态
   */
  printStatus(): void {
    const status = this.getStatus();
    console.log('\n' + '═'.repeat(60));
    console.log('💰 Fund Limiter Status');
    console.log('═'.repeat(60));
    console.log(`Date: ${status.date}`);
    console.log(`Daily Volume: $${status.dailyVolume.toFixed(2)} / $${this.config.maxDailyVolume} (${status.dailyVolumePercent.toFixed(1)}%)`);
    console.log(`Daily Trades: ${status.dailyTrades} / ${this.config.maxDailyTrades} (${status.dailyTradesPercent.toFixed(1)}%)`);
    console.log(`Total Position: $${status.totalPosition.toFixed(2)} / $${this.config.maxTotalPosition} (${status.totalPositionPercent.toFixed(1)}%)`);
    console.log('═'.repeat(60) + '\n');
  }
}

// 全局单例
let globalFundLimiter: FundLimiter | null = null;

/**
 * 获取全局 Fund Limiter 实例
 */
export function getGlobalFundLimiter(config?: FundLimiterConfig): FundLimiter {
  if (!globalFundLimiter) {
    globalFundLimiter = new FundLimiter(config);
  }
  return globalFundLimiter;
}

/**
 * 重置全局 Fund Limiter（主要用于测试）
 */
export function resetGlobalFundLimiter(): void {
  globalFundLimiter = null;
}
