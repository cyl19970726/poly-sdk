/**
 * Kill Switch - 全局紧急停止机制
 *
 * 用途：
 * - 远程紧急停止所有交易
 * - 策略失效时立即终止
 * - SSH 断开后仍可通过文件触发
 *
 * 使用方法：
 * ```bash
 * # 触发 Kill Switch
 * touch /tmp/poly-kill-switch
 *
 * # 重置 Kill Switch
 * rm /tmp/poly-kill-switch
 * ```
 */

import * as fs from 'fs';
import * as path from 'path';

export interface KillSwitchConfig {
  filePath?: string;
  checkIntervalMs?: number;
  onTriggered?: () => void;
}

export class KillSwitch {
  private filePath: string;
  private checkIntervalMs: number;
  private onTriggered?: () => void;
  private checkTimer?: NodeJS.Timeout;
  private isTriggeredFlag = false;

  constructor(config: KillSwitchConfig = {}) {
    this.filePath = config.filePath || '/tmp/poly-kill-switch';
    this.checkIntervalMs = config.checkIntervalMs || 2000; // 每 2 秒检查
    this.onTriggered = config.onTriggered;
  }

  /**
   * 启动后台检查（自动定时检查文件）
   */
  startBackgroundCheck(): void {
    if (this.checkTimer) return;

    this.checkTimer = setInterval(() => {
      if (this.isTriggered() && !this.isTriggeredFlag) {
        this.isTriggeredFlag = true;
        console.error('\n🚨 KILL SWITCH TRIGGERED! 🚨');
        console.error(`Kill switch file detected: ${this.filePath}`);
        console.error('All trading operations will be blocked.\n');

        if (this.onTriggered) {
          this.onTriggered();
        }
      }
    }, this.checkIntervalMs);

    // 确保进程退出时清理
    process.on('exit', () => this.stop());
  }

  /**
   * 停止后台检查
   */
  stop(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = undefined;
    }
  }

  /**
   * 检查是否被触发
   */
  isTriggered(): boolean {
    try {
      return fs.existsSync(this.filePath);
    } catch (error) {
      console.warn(`Kill switch check error: ${error}`);
      return false;
    }
  }

  /**
   * 手动触发（创建文件）
   */
  trigger(reason?: string): void {
    try {
      const message = reason || `Triggered at ${new Date().toISOString()}`;
      fs.writeFileSync(this.filePath, message);
      this.isTriggeredFlag = true;
      console.error('\n🚨 KILL SWITCH ACTIVATED! 🚨');
      console.error(`Reason: ${reason || 'Manual trigger'}`);
      console.error(`File: ${this.filePath}\n`);

      if (this.onTriggered) {
        this.onTriggered();
      }
    } catch (error) {
      console.error(`Failed to trigger kill switch: ${error}`);
    }
  }

  /**
   * 重置（删除文件）
   */
  reset(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        fs.unlinkSync(this.filePath);
        this.isTriggeredFlag = false;
        console.log('✅ Kill switch reset');
      }
    } catch (error) {
      console.error(`Failed to reset kill switch: ${error}`);
    }
  }

  /**
   * 检查并抛出错误（用于阻止操作）
   */
  checkAndThrow(operation: string = 'operation'): void {
    if (this.isTriggered()) {
      throw new Error(
        `Kill switch is active - ${operation} blocked. ` +
        `Remove file: ${this.filePath}`
      );
    }
  }

  /**
   * 获取文件路径
   */
  getFilePath(): string {
    return this.filePath;
  }

  /**
   * 获取触发信息
   */
  getTriggerInfo(): { triggered: boolean; message?: string; time?: Date } {
    if (!this.isTriggered()) {
      return { triggered: false };
    }

    try {
      const content = fs.readFileSync(this.filePath, 'utf8');
      const stats = fs.statSync(this.filePath);
      return {
        triggered: true,
        message: content,
        time: stats.mtime,
      };
    } catch (error) {
      return { triggered: true };
    }
  }
}

// 全局单例
let globalKillSwitch: KillSwitch | null = null;

/**
 * 获取全局 Kill Switch 实例
 */
export function getGlobalKillSwitch(config?: KillSwitchConfig): KillSwitch {
  if (!globalKillSwitch) {
    globalKillSwitch = new KillSwitch(config);
    globalKillSwitch.startBackgroundCheck();
  }
  return globalKillSwitch;
}

/**
 * 重置全局 Kill Switch（主要用于测试）
 */
export function resetGlobalKillSwitch(): void {
  if (globalKillSwitch) {
    globalKillSwitch.stop();
    globalKillSwitch = null;
  }
}
