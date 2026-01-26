/**
 * SignalService - HTTP client for SignalWorker
 *
 * Provides a clean interface for consuming signal data from SignalWorker.
 */

import type {
  Signal,
  GetSignalsParams,
  SignalHealthResponse,
  SignalStatsResponse,
  GetSignalsResponse,
  UnreadCountResponse,
  SuccessResponse,
  SignalCreatedResponse,
  ProcessScanResponse,
  CreateInsiderNewParams,
  CreateInsiderLargeTradeParams,
  CreateInsiderClusterParams,
  CreateWhaleTradeParams,
  ProcessInsiderScanParams,
} from './types.js';

/**
 * SignalService configuration
 */
export interface SignalServiceConfig {
  /** Base URL of SignalWorker (default: http://localhost:8790) */
  baseUrl?: string;
  /** Request timeout in ms (default: 10000) */
  timeout?: number;
}

const DEFAULT_CONFIG: Required<SignalServiceConfig> = {
  baseUrl: 'http://localhost:8790',
  timeout: 10000,
};

/**
 * SignalService - HTTP client for SignalWorker
 */
export class SignalService {
  private baseUrl: string;
  private timeout: number;

  constructor(config: SignalServiceConfig = {}) {
    this.baseUrl = config.baseUrl ?? DEFAULT_CONFIG.baseUrl;
    this.timeout = config.timeout ?? DEFAULT_CONFIG.timeout;
  }

  // ============================================================================
  // Private Helpers
  // ============================================================================

  private async request<T>(
    method: string,
    path: string,
    options: {
      params?: Record<string, string | number | boolean | undefined>;
      body?: unknown;
    } = {}
  ): Promise<T> {
    const url = new URL(`/v1${path}`, this.baseUrl);

    // Add query params
    if (options.params) {
      for (const [key, value] of Object.entries(options.params)) {
        if (value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url.toString(), {
        method,
        headers: {
          'Content-Type': 'application/json',
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => 'Unknown error');
        throw new Error(`SignalService request failed: ${response.status} ${response.statusText} - ${errorBody}`);
      }

      return await response.json() as T;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // ============================================================================
  // Health & Stats
  // ============================================================================

  /**
   * Check SignalWorker health
   */
  async health(): Promise<SignalHealthResponse> {
    return this.request<SignalHealthResponse>('GET', '/health');
  }

  /**
   * Get signal statistics
   */
  async getStats(): Promise<SignalStatsResponse> {
    return this.request<SignalStatsResponse>('GET', '/stats');
  }

  // ============================================================================
  // Signal Queries
  // ============================================================================

  /**
   * Get signals with optional filtering
   */
  async getSignals(params: GetSignalsParams = {}): Promise<GetSignalsResponse> {
    return this.request<GetSignalsResponse>('GET', '/signals', {
      params: {
        type: params.type,
        severity: params.severity,
        status: params.status,
        marketId: params.marketId,
        wallet: params.wallet,
        unreadOnly: params.unreadOnly,
        since: params.since,
        limit: params.limit,
        offset: params.offset,
      },
    });
  }

  /**
   * Get a single signal by ID
   */
  async getSignal(id: string): Promise<Signal | null> {
    try {
      return await this.request<Signal>('GET', `/signals/${id}`);
    } catch (error) {
      if (error instanceof Error && error.message.includes('404')) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Get unread signal count
   */
  async getUnreadCount(): Promise<number> {
    const response = await this.request<UnreadCountResponse>('GET', '/signals/unread/count');
    return response.count;
  }

  // ============================================================================
  // Signal Actions
  // ============================================================================

  /**
   * Mark a signal as read
   */
  async markAsRead(id: string): Promise<boolean> {
    try {
      await this.request<SuccessResponse>('POST', `/signals/${id}/read`);
      return true;
    } catch (error) {
      if (error instanceof Error && error.message.includes('404')) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Mark all signals as read
   */
  async markAllAsRead(): Promise<number> {
    const response = await this.request<SuccessResponse>('POST', '/signals/read-all');
    return response.count ?? 0;
  }

  /**
   * Dismiss a signal
   */
  async dismissSignal(id: string): Promise<boolean> {
    try {
      await this.request<SuccessResponse>('POST', `/signals/${id}/dismiss`);
      return true;
    } catch (error) {
      if (error instanceof Error && error.message.includes('404')) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Delete a signal
   */
  async deleteSignal(id: string): Promise<boolean> {
    try {
      await this.request<SuccessResponse>('DELETE', `/signals/${id}`);
      return true;
    } catch (error) {
      if (error instanceof Error && error.message.includes('404')) {
        return false;
      }
      throw error;
    }
  }

  // ============================================================================
  // Signal Creation (for external integrations)
  // ============================================================================

  /**
   * Create an insider new signal
   */
  async createInsiderNewSignal(params: CreateInsiderNewParams): Promise<SignalCreatedResponse> {
    return this.request<SignalCreatedResponse>('POST', '/signals/insider/new', {
      body: params,
    });
  }

  /**
   * Create an insider large trade signal
   */
  async createInsiderLargeTradeSignal(params: CreateInsiderLargeTradeParams): Promise<SignalCreatedResponse> {
    return this.request<SignalCreatedResponse>('POST', '/signals/insider/trade', {
      body: params,
    });
  }

  /**
   * Create an insider cluster signal
   */
  async createInsiderClusterSignal(params: CreateInsiderClusterParams): Promise<SignalCreatedResponse> {
    return this.request<SignalCreatedResponse>('POST', '/signals/insider/cluster', {
      body: params,
    });
  }

  /**
   * Create a whale trade signal
   */
  async createWhaleTradeSignal(params: CreateWhaleTradeParams): Promise<SignalCreatedResponse> {
    return this.request<SignalCreatedResponse>('POST', '/signals/whale/trade', {
      body: params,
    });
  }

  /**
   * Process insider scan results (batch)
   */
  async processInsiderScanResults(params: ProcessInsiderScanParams): Promise<ProcessScanResponse> {
    return this.request<ProcessScanResponse>('POST', '/signals/process-scan', {
      body: params,
    });
  }

  // ============================================================================
  // Maintenance
  // ============================================================================

  /**
   * Trigger cleanup of expired signals
   */
  async cleanup(): Promise<number> {
    const response = await this.request<{ success: boolean; deletedCount: number }>('POST', '/signals/cleanup');
    return response.deletedCount;
  }

  /**
   * Clear all signals (admin)
   */
  async clearAll(): Promise<void> {
    await this.request<SuccessResponse>('DELETE', '/signals');
  }
}
