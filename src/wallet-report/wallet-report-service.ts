/**
 * WalletReportService
 *
 * Client for querying the WalletReportWorker API.
 *
 * @example
 * ```typescript
 * const service = new WalletReportService({
 *   baseUrl: 'http://localhost:8789',
 * });
 *
 * // Get health status
 * const health = await service.health();
 *
 * // Get or generate wallet report
 * const report = await service.getWalletReport('0x...');
 *
 * // Get daily leaderboard
 * const leaderboard = await service.getDailyLeaderboard();
 * ```
 */

import type {
  WalletReportHealthResponse,
  WalletReportStatsResponse,
  GetWalletReportResponse,
  ReportGeneratingResponse,
  GetLeaderboardResponse,
  ListReportsResponse,
  ListReportsParams,
  WalletReportData,
  LeaderboardReportData,
} from './types.js';

export interface WalletReportServiceConfig {
  /** Base URL of WalletReportWorker (e.g., http://localhost:8789) */
  baseUrl: string;
  /** Request timeout in milliseconds (default: 60000) */
  timeoutMs?: number;
}

export class WalletReportService {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(config: WalletReportServiceConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = config.timeoutMs ?? 60_000;
  }

  // ============================================================================
  // Health & Stats
  // ============================================================================

  /**
   * Check worker health and get basic stats
   */
  async health(): Promise<WalletReportHealthResponse> {
    return this.fetchJson('/v1/health') as Promise<WalletReportHealthResponse>;
  }

  /**
   * Get detailed statistics
   */
  async getStats(): Promise<WalletReportStatsResponse> {
    return this.fetchJson('/v1/stats') as Promise<WalletReportStatsResponse>;
  }

  // ============================================================================
  // Wallet Reports
  // ============================================================================

  /**
   * Get or generate a wallet report
   *
   * Returns cached report if available, otherwise generates a new one.
   * Use forceRefresh to skip cache and generate a fresh report.
   *
   * @param address - Wallet address
   * @param forceRefresh - Force regeneration even if cached (default: false)
   */
  async getWalletReport(
    address: string,
    forceRefresh = false
  ): Promise<GetWalletReportResponse | ReportGeneratingResponse> {
    const query = forceRefresh ? '?refresh=true' : '';
    return this.fetchJson(`/v1/wallets/${address.toLowerCase()}/report${query}`) as Promise<
      GetWalletReportResponse | ReportGeneratingResponse
    >;
  }

  /**
   * Get wallet report data directly (convenience method)
   *
   * Throws if report is still generating.
   */
  async getWalletReportData(address: string, forceRefresh = false): Promise<WalletReportData> {
    const response = await this.getWalletReport(address, forceRefresh);

    if ('status' in response && response.status === 'generating') {
      throw new Error('Report is still generating');
    }

    return (response as GetWalletReportResponse).report;
  }

  // ============================================================================
  // Leaderboards
  // ============================================================================

  /**
   * Get the latest daily leaderboard
   */
  async getDailyLeaderboard(): Promise<GetLeaderboardResponse | null> {
    try {
      return await this.fetchJson('/v1/leaderboards/daily') as GetLeaderboardResponse;
    } catch (error) {
      if (error instanceof Error && error.message.includes('404')) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Get the latest weekly leaderboard
   */
  async getWeeklyLeaderboard(): Promise<GetLeaderboardResponse | null> {
    try {
      return await this.fetchJson('/v1/leaderboards/weekly') as GetLeaderboardResponse;
    } catch (error) {
      if (error instanceof Error && error.message.includes('404')) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Get the latest monthly leaderboard
   */
  async getMonthlyLeaderboard(): Promise<GetLeaderboardResponse | null> {
    try {
      return await this.fetchJson('/v1/leaderboards/monthly') as GetLeaderboardResponse;
    } catch (error) {
      if (error instanceof Error && error.message.includes('404')) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Get leaderboard report data directly (convenience method)
   */
  async getLeaderboardData(period: 'daily' | 'weekly' | 'monthly'): Promise<LeaderboardReportData | null> {
    let response: GetLeaderboardResponse | null;

    switch (period) {
      case 'daily':
        response = await this.getDailyLeaderboard();
        break;
      case 'weekly':
        response = await this.getWeeklyLeaderboard();
        break;
      case 'monthly':
        response = await this.getMonthlyLeaderboard();
        break;
    }

    return response?.report ?? null;
  }

  /**
   * Force generate a leaderboard report
   */
  async forceGenerateLeaderboard(type: 'daily' | 'weekly' | 'monthly'): Promise<void> {
    await this.fetchJson(`/v1/leaderboards/${type}/generate`, { method: 'POST' });
  }

  // ============================================================================
  // Report Management
  // ============================================================================

  /**
   * List all reports
   */
  async listReports(params: ListReportsParams = {}): Promise<ListReportsResponse> {
    const query = new URLSearchParams();
    if (params.type) query.set('type', params.type);
    if (params.status) query.set('status', params.status);
    if (params.limit != null) query.set('limit', String(params.limit));
    if (params.offset != null) query.set('offset', String(params.offset));

    const q = query.toString();
    return this.fetchJson(`/v1/reports${q ? `?${q}` : ''}`) as Promise<ListReportsResponse>;
  }

  /**
   * Delete a report by ID
   */
  async deleteReport(id: string): Promise<boolean> {
    try {
      await this.fetchJson(`/v1/reports/${id}`, { method: 'DELETE' });
      return true;
    } catch (error) {
      if (error instanceof Error && error.message.includes('404')) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Cleanup expired reports
   */
  async cleanupExpired(): Promise<number> {
    const result = await this.fetchJson('/v1/reports/cleanup', { method: 'POST' }) as { deletedCount: number };
    return result.deletedCount;
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private async fetchJson(path: string, options: RequestInit = {}): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        ...options,
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...options.headers,
        },
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`WalletReportService HTTP ${res.status}: ${text || res.statusText}`);
      }

      return await res.json();
    } finally {
      clearTimeout(timeout);
    }
  }
}
