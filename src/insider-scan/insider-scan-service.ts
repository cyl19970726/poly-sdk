/**
 * InsiderScanService
 *
 * Client for querying the InsiderScanWorker API.
 *
 * @example
 * ```typescript
 * const service = new InsiderScanService({
 *   baseUrl: 'http://localhost:8788',
 * });
 *
 * // Get health status
 * const health = await service.health();
 *
 * // Get candidates
 * const { candidates } = await service.getCandidates({ minScore: 60 });
 *
 * // Scan a market
 * const result = await service.scanMarket('0x...');
 * ```
 */

import type {
  InsiderScanHealthResponse,
  InsiderCandidateSummary,
  InsiderCandidateDetails,
  GetCandidatesResponse,
  ScanMarketResponse,
  GetScanHistoryResponse,
  InsiderStatsResponse,
  GetCandidatesParams,
  GetScanHistoryParams,
} from './types.js';

export interface InsiderScanServiceConfig {
  /** Base URL of InsiderScanWorker (e.g., http://localhost:8788) */
  baseUrl: string;
  /** Request timeout in milliseconds (default: 30000) */
  timeoutMs?: number;
}

export class InsiderScanService {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(config: InsiderScanServiceConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = config.timeoutMs ?? 30_000;
  }

  // ============================================================================
  // Health & Stats
  // ============================================================================

  /**
   * Check worker health and get basic stats
   */
  async health(): Promise<InsiderScanHealthResponse> {
    return this.fetchJson('/v1/health') as Promise<InsiderScanHealthResponse>;
  }

  /**
   * Get detailed statistics
   */
  async getStats(): Promise<InsiderStatsResponse> {
    return this.fetchJson('/v1/stats') as Promise<InsiderStatsResponse>;
  }

  // ============================================================================
  // Candidates
  // ============================================================================

  /**
   * Get insider candidates with filtering
   */
  async getCandidates(params: GetCandidatesParams = {}): Promise<GetCandidatesResponse> {
    const query = new URLSearchParams();
    if (params.minScore != null) query.set('minScore', String(params.minScore));
    if (params.maxScore != null) query.set('maxScore', String(params.maxScore));
    if (params.level) query.set('level', params.level);
    if (params.market) query.set('market', params.market);
    if (params.sortBy) query.set('sortBy', params.sortBy);
    if (params.sortOrder) query.set('sortOrder', params.sortOrder);
    if (params.limit != null) query.set('limit', String(params.limit));
    if (params.offset != null) query.set('offset', String(params.offset));

    const q = query.toString();
    return this.fetchJson(`/v1/candidates${q ? `?${q}` : ''}`) as Promise<GetCandidatesResponse>;
  }

  /**
   * Get a specific candidate by address
   */
  async getCandidate(address: string): Promise<InsiderCandidateDetails | null> {
    try {
      return await this.fetchJson(`/v1/candidates/${address.toLowerCase()}`) as InsiderCandidateDetails;
    } catch (error) {
      if (error instanceof Error && error.message.includes('404')) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Delete a candidate
   */
  async deleteCandidate(address: string): Promise<boolean> {
    try {
      await this.fetchJson(`/v1/candidates/${address.toLowerCase()}`, {
        method: 'DELETE',
      });
      return true;
    } catch (error) {
      if (error instanceof Error && error.message.includes('404')) {
        return false;
      }
      throw error;
    }
  }

  // ============================================================================
  // Scanning
  // ============================================================================

  /**
   * Scan a market for insider activity
   */
  async scanMarket(conditionId: string): Promise<ScanMarketResponse> {
    return this.fetchJson(`/v1/scan/${conditionId}`, {
      method: 'POST',
    }) as Promise<ScanMarketResponse>;
  }

  /**
   * Get scan history
   */
  async getScanHistory(params: GetScanHistoryParams = {}): Promise<GetScanHistoryResponse> {
    const query = new URLSearchParams();
    if (params.conditionId) query.set('conditionId', params.conditionId);
    if (params.limit != null) query.set('limit', String(params.limit));
    if (params.offset != null) query.set('offset', String(params.offset));

    const q = query.toString();
    return this.fetchJson(`/v1/scan/history${q ? `?${q}` : ''}`) as Promise<GetScanHistoryResponse>;
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
        throw new Error(`InsiderScanService HTTP ${res.status}: ${text || res.statusText}`);
      }

      return await res.json();
    } finally {
      clearTimeout(timeout);
    }
  }
}
