/**
 * smart-money/core.ts
 *
 * SmartMoneyCore: leaderboard, rankings, wallet info.
 * Extracted from SmartMoneyService (V2 modularization).
 */

import type { WalletService, TimePeriod, PeriodLeaderboardEntry } from '../services/wallet-service.js';
import type {
  SmartMoneyWallet,
  SmartMoneyServiceConfig,
  LeaderboardOptions,
  SmartMoneyLeaderboardEntry,
  SmartMoneyLeaderboardResult,
} from './types.js';

export type { SmartMoneyWallet, SmartMoneyServiceConfig, LeaderboardOptions, SmartMoneyLeaderboardEntry, SmartMoneyLeaderboardResult };

/**
 * SmartMoneyCore manages leaderboard queries, wallet info, and smart-money cache.
 */
export class SmartMoneyCore {
  private walletService: WalletService;
  private config: Required<Pick<SmartMoneyServiceConfig, 'minPnl' | 'cacheTtl'>>;

  private cache = new Map<string, SmartMoneyWallet>();
  private cacheSet = new Set<string>();
  private cacheTimestamp = 0;

  constructor(
    walletService: WalletService,
    config: Pick<SmartMoneyServiceConfig, 'minPnl' | 'cacheTtl'> = {}
  ) {
    this.walletService = walletService;
    this.config = {
      minPnl: config.minPnl ?? 1000,
      cacheTtl: config.cacheTtl ?? 300_000,
    };
  }

  // ============================================================================
  // Leaderboard
  // ============================================================================

  /**
   * Get leaderboard by time period.
   */
  async getLeaderboard(options: LeaderboardOptions = {}): Promise<SmartMoneyLeaderboardResult> {
    const period = (options.period ?? 'week') as TimePeriod;
    const limit = Math.min(options.limit ?? 50, 500);
    const sortBy = options.sortBy ?? 'pnl';
    const offset = Math.min(options.offset ?? 0, 10_000);

    const result = await this.walletService.fetchLeaderboardByPeriod(period, limit, sortBy, 'OVERALL', offset);

    const entries: SmartMoneyLeaderboardEntry[] = result.entries.map((e: PeriodLeaderboardEntry) => ({
      address: e.address,
      rank: e.rank,
      pnl: e.pnl,
      volume: e.volume,
      tradeCount: e.tradeCount,
      userName: e.userName,
      profileImage: e.profileImage,
      xUsername: e.xUsername,
      verifiedBadge: e.verifiedBadge,
      totalPnl: e.totalPnl,
      realizedPnl: e.realizedPnl,
      unrealizedPnl: e.unrealizedPnl,
      buyCount: e.buyCount,
      sellCount: e.sellCount,
      buyVolume: e.buyVolume,
      sellVolume: e.sellVolume,
      makerVolume: e.makerVolume,
      takerVolume: e.takerVolume,
    }));

    return {
      entries,
      hasMore: result.hasMore,
      request: result.request,
    };
  }

  // ============================================================================
  // Smart Money Info
  // ============================================================================

  /**
   * Get list of Smart Money wallets from leaderboard.
   */
  async getSmartMoneyList(limit = 100): Promise<SmartMoneyWallet[]> {
    if (this.isCacheValid()) {
      return Array.from(this.cache.values());
    }

    const page = await this.walletService.getLeaderboard(0, limit);
    const entries = page.entries;
    const list: SmartMoneyWallet[] = [];

    for (let i = 0; i < entries.length; i++) {
      const trader = entries[i];
      if (trader.pnl < this.config.minPnl) continue;

      const wallet: SmartMoneyWallet = {
        address: trader.address.toLowerCase(),
        name: trader.userName,
        pnl: trader.pnl,
        volume: trader.volume,
        score: Math.min(100, Math.round((trader.pnl / 100_000) * 50 + (trader.volume / 1_000_000) * 50)),
        rank: trader.rank ?? i + 1,
      };

      list.push(wallet);
      this.cache.set(wallet.address, wallet);
      this.cacheSet.add(wallet.address);
    }

    this.cacheTimestamp = Date.now();
    return list;
  }

  /**
   * Check if address is Smart Money.
   */
  async isSmartMoney(address: string): Promise<boolean> {
    const normalized = address.toLowerCase();
    if (this.isCacheValid()) return this.cacheSet.has(normalized);
    await this.getSmartMoneyList();
    return this.cacheSet.has(normalized);
  }

  /**
   * Get Smart Money wallet info.
   */
  async getWalletInfo(address: string): Promise<SmartMoneyWallet | null> {
    const normalized = address.toLowerCase();
    if (this.isCacheValid() && this.cache.has(normalized)) {
      return this.cache.get(normalized)!;
    }
    await this.getSmartMoneyList();
    return this.cache.get(normalized) ?? null;
  }

  getCache(): Map<string, SmartMoneyWallet> {
    return this.cache;
  }

  getCacheSet(): Set<string> {
    return this.cacheSet;
  }

  private isCacheValid(): boolean {
    return Date.now() - this.cacheTimestamp < this.config.cacheTtl && this.cache.size > 0;
  }
}
