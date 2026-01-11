/**
 * Trading Guard - 交易守卫（统一保护层）
 *
 * 集成所有保护机制：
 * - Kill Switch（紧急停止）
 * - Fund Limiter（资金上限）
 * - Loss Circuit Breaker（亏损熔断）
 *
 * 用途：
 * - 在所有交易操作前统一检查
 * - 自动记录交易和盈亏
 * - 达到限制自动停止
 *
 * 使用方法：
 * ```typescript
 * const guard = new TradingGuard({ ... });
 *
 * // 交易前检查
 * const check = guard.checkBeforeTrade(amount);
 * if (!check.allowed) {
 *   console.error(check.reason);
 *   return;
 * }
 *
 * // 记录开仓
 * guard.recordOpen(amount);
 *
 * // 记录平仓
 * guard.recordClose(amount, pnl);
 * ```
 */

import { KillSwitch, getGlobalKillSwitch, KillSwitchConfig } from './kill-switch.js';
import { FundLimiter, getGlobalFundLimiter, FundLimiterConfig } from './fund-limiter.js';
import { LossCircuitBreaker, getGlobalLossBreaker, LossCircuitBreakerConfig } from './loss-circuit-breaker.js';

export interface TradingGuardConfig {
  // 环境设置
  environment?: 'paper' | 'live';
  requireConfirmation?: boolean;

  // 子模块配置
  killSwitch?: KillSwitchConfig;
  fundLimiter?: FundLimiterConfig;
  lossBreaker?: LossCircuitBreakerConfig;

  // 全局开关
  enableKillSwitch?: boolean;
  enableFundLimiter?: boolean;
  enableLossBreaker?: boolean;

  // 回调
  onBlocked?: (reason: string, details: any) => void;
  onWarning?: (warning: string, details: any) => void;
}

export class TradingGuard {
  private config: Required<Omit<TradingGuardConfig, 'killSwitch' | 'fundLimiter' | 'lossBreaker' | 'onBlocked' | 'onWarning'>> &
    Pick<TradingGuardConfig, 'killSwitch' | 'fundLimiter' | 'lossBreaker' | 'onBlocked' | 'onWarning'>;

  private killSwitch: KillSwitch;
  private fundLimiter: FundLimiter;
  private lossBreaker: LossCircuitBreaker;

  private isInitialized = false;

  constructor(config: TradingGuardConfig = {}) {
    this.config = {
      environment: config.environment || 'paper',
      requireConfirmation: config.requireConfirmation !== false,
      enableKillSwitch: config.enableKillSwitch !== false,
      enableFundLimiter: config.enableFundLimiter !== false,
      enableLossBreaker: config.enableLossBreaker !== false,
      killSwitch: config.killSwitch,
      fundLimiter: config.fundLimiter,
      lossBreaker: config.lossBreaker,
      onBlocked: config.onBlocked,
      onWarning: config.onWarning,
    };

    // 创建保护模块
    this.killSwitch = getGlobalKillSwitch(this.config.killSwitch);
    this.fundLimiter = getGlobalFundLimiter(this.config.fundLimiter);
    this.lossBreaker = getGlobalLossBreaker({
      ...this.config.lossBreaker,
      killSwitch: this.killSwitch,
    });
  }

  /**
   * 初始化（显示欢迎信息和确认）
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    this.printWelcome();

    // 如果是实盘且需要确认
    if (this.config.environment === 'live' && this.config.requireConfirmation) {
      await this.requireConfirmation();
    }

    // 打印状态
    this.printStatus();

    this.isInitialized = true;
  }

  /**
   * 打印欢迎信息
   */
  private printWelcome(): void {
    const env = this.config.environment.toUpperCase();
    const envColor = this.config.environment === 'live' ? '\x1b[31m' : '\x1b[33m';
    const reset = '\x1b[0m';

    console.log('\n' + '═'.repeat(80));
    console.log(`🛡️  Trading Guard - ${envColor}${env} TRADING${reset}`);
    console.log('═'.repeat(80));

    console.log(`Environment: ${envColor}${env}${reset}`);
    console.log(`Kill Switch: ${this.config.enableKillSwitch ? '✅ Enabled' : '⚠️ Disabled'} (${this.killSwitch.getFilePath()})`);
    console.log(`Fund Limiter: ${this.config.enableFundLimiter ? '✅ Enabled' : '⚠️ Disabled'}`);
    console.log(`Loss Breaker: ${this.config.enableLossBreaker ? '✅ Enabled' : '⚠️ Disabled'}`);

    if (this.config.environment === 'live') {
      console.log('\n⚠️  WARNING: LIVE TRADING MODE');
      console.log('Real money will be used. Proceed with caution.');
    }

    console.log('═'.repeat(80) + '\n');
  }

  /**
   * 需要确认（实盘）
   */
  private async requireConfirmation(): Promise<void> {
    console.log('⚠️  Please confirm you want to proceed with LIVE trading.');
    console.log('Press Ctrl+C to cancel, or wait 10 seconds to continue...\n');

    await new Promise(resolve => setTimeout(resolve, 10000));

    console.log('✅ Confirmation received. Starting trading...\n');
  }

  /**
   * 交易前检查（统一入口）
   */
  checkBeforeTrade(amount: number): { allowed: boolean; reason?: string } {
    // 1. Kill Switch
    if (this.config.enableKillSwitch && this.killSwitch.isTriggered()) {
      const info = this.killSwitch.getTriggerInfo();
      const reason = `Kill switch is active: ${info.message || 'Manual trigger'}`;
      this.notifyBlocked('kill_switch', reason);
      return { allowed: false, reason };
    }

    // 2. Fund Limiter
    if (this.config.enableFundLimiter) {
      const fundCheck = this.fundLimiter.canTrade(amount);
      if (!fundCheck.allowed) {
        this.notifyBlocked('fund_limiter', fundCheck.reason!);
        return fundCheck;
      }
    }

    // 3. Loss Circuit Breaker
    if (this.config.enableLossBreaker) {
      const breakerCheck = this.lossBreaker.canTrade();
      if (!breakerCheck.allowed) {
        this.notifyBlocked('loss_breaker', breakerCheck.reason!);
        return breakerCheck;
      }
    }

    return { allowed: true };
  }

  /**
   * 记录开仓
   */
  recordOpen(amount: number): void {
    if (this.config.enableFundLimiter) {
      this.fundLimiter.recordTrade(amount);
    }
  }

  /**
   * 记录平仓
   */
  recordClose(amount: number, pnl: number): void {
    if (this.config.enableFundLimiter) {
      this.fundLimiter.recordClose(amount);
    }

    if (this.config.enableLossBreaker) {
      this.lossBreaker.recordTrade(pnl);
    }
  }

  /**
   * 通知被阻止
   */
  private notifyBlocked(module: string, reason: string): void {
    console.error(`\n⛔ Trading blocked by ${module}`);
    console.error(`Reason: ${reason}\n`);

    if (this.config.onBlocked) {
      this.config.onBlocked(reason, { module });
    }
  }

  /**
   * 通知警告
   */
  private notifyWarning(warning: string, details: any): void {
    console.warn(`\n⚠️ Warning: ${warning}`);

    if (this.config.onWarning) {
      this.config.onWarning(warning, details);
    }
  }

  /**
   * 获取综合状态
   */
  getStatus() {
    return {
      environment: this.config.environment,
      killSwitch: this.killSwitch.getTriggerInfo(),
      fundLimiter: this.config.enableFundLimiter ? this.fundLimiter.getStatus() : null,
      lossBreaker: this.config.enableLossBreaker ? this.lossBreaker.getStatus() : null,
    };
  }

  /**
   * 打印状态
   */
  printStatus(): void {
    if (this.config.enableFundLimiter) {
      this.fundLimiter.printStatus();
    }

    if (this.config.enableLossBreaker) {
      this.lossBreaker.printStatus();
    }
  }

  /**
   * 打印摘要（用于定期显示）
   */
  printSummary(): void {
    const status = this.getStatus();
    console.log('\n' + '─'.repeat(60));
    console.log('🛡️  Trading Guard Summary');

    if (status.killSwitch.triggered) {
      console.log(`⛔ Kill Switch: ACTIVE (${status.killSwitch.message})`);
    }

    if (status.fundLimiter) {
      console.log(
        `💰 Fund: Daily $${status.fundLimiter.dailyVolume.toFixed(0)}/$${this.fundLimiter.getConfig().maxDailyVolume} ` +
        `| Trades ${status.fundLimiter.dailyTrades}/${this.fundLimiter.getConfig().maxDailyTrades}`
      );
    }

    if (status.lossBreaker) {
      const color = status.lossBreaker.isTripped ? '\x1b[31m' : '\x1b[32m';
      const reset = '\x1b[0m';
      console.log(
        `${color}🔥 Breaker: ${status.lossBreaker.isTripped ? 'TRIPPED' : 'OK'}${reset} ` +
        `| PnL $${status.lossBreaker.totalPnL.toFixed(2)} ` +
        `| Streak ${status.lossBreaker.consecutiveLosses}`
      );
    }

    console.log('─'.repeat(60) + '\n');
  }

  /**
   * 获取子模块（高级使用）
   */
  getKillSwitch(): KillSwitch {
    return this.killSwitch;
  }

  getFundLimiter(): FundLimiter {
    return this.fundLimiter;
  }

  getLossBreaker(): LossCircuitBreaker {
    return this.lossBreaker;
  }

  /**
   * 手动触发 Kill Switch
   */
  triggerKillSwitch(reason?: string): void {
    this.killSwitch.trigger(reason);
  }

  /**
   * 重置所有保护机制（需要明确确认）
   */
  resetAll(force: boolean = false): void {
    if (!force) {
      console.warn('⚠️ Use resetAll(true) to confirm reset all guards');
      return;
    }

    console.log('🔄 Resetting all trading guards...');
    this.killSwitch.reset();
    this.fundLimiter.reset();
    this.lossBreaker.reset(true);
    console.log('✅ All guards reset\n');
  }
}

// 全局单例
let globalGuard: TradingGuard | null = null;

export function getGlobalTradingGuard(config?: TradingGuardConfig): TradingGuard {
  if (!globalGuard) {
    globalGuard = new TradingGuard(config);
  }
  return globalGuard;
}

export function resetGlobalTradingGuard(): void {
  if (globalGuard) {
    globalGuard = null;
  }
}
