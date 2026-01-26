import type {
  CatalystHealthResponse,
  CatalystKlinesResponse,
  CatalystTradesResponse,
  CatalystOrderbookSnapshotsResponse,
  CatalystDepthLineResponse,
  CatalystKLineInterval,
} from './types.js';

export type CatalystQueryServiceConfig = {
  /** Base URL of the MarketDataWorker (e.g., http://localhost:8787) */
  baseUrl: string;
  /** Request timeout in milliseconds (default: 10000) */
  timeoutMs?: number;
};

/**
 * Client for querying historical market data from MarketDataWorker.
 *
 * @example
 * ```typescript
 * const catalyst = new CatalystQueryService({
 *   baseUrl: 'http://localhost:8787',
 * });
 *
 * const health = await catalyst.health();
 * console.log('Tracked markets:', health.tracked.count);
 *
 * const klines = await catalyst.getKlines({
 *   conditionId: '0x...',
 *   interval: '1m',
 *   limit: 100,
 * });
 * console.log('Primary candles:', klines.yes.length);
 * ```
 */
export class CatalystQueryService {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(config: CatalystQueryServiceConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = config.timeoutMs ?? 10_000;
  }

  /**
   * Check worker health and get tracked markets info
   */
  async health(): Promise<CatalystHealthResponse> {
    return this.fetchJson('/v1/health') as Promise<CatalystHealthResponse>;
  }

  /**
   * Get K-line (candlestick) data for a market
   *
   * @param params.conditionId - Market condition ID
   * @param params.interval - K-line interval (5s, 15s, 30s, 1m, 5m, 15m, etc.)
   * @param params.startTimeMs - Start timestamp (Unix ms)
   * @param params.endTimeMs - End timestamp (Unix ms)
   * @param params.limit - Maximum candles to return
   */
  async getKlines(params: {
    conditionId: string;
    interval: CatalystKLineInterval;
    startTimeMs?: number;
    endTimeMs?: number;
    limit?: number;
  }): Promise<CatalystKlinesResponse> {
    const query = new URLSearchParams();
    query.set('interval', params.interval);
    if (params.startTimeMs != null) query.set('startTimeMs', String(params.startTimeMs));
    if (params.endTimeMs != null) query.set('endTimeMs', String(params.endTimeMs));
    if (params.limit != null) query.set('limit', String(params.limit));
    return this.fetchJson(`/v1/markets/${params.conditionId}/klines?${query.toString()}`) as Promise<CatalystKlinesResponse>;
  }

  /**
   * Get trade history for a market
   *
   * @param params.conditionId - Market condition ID
   * @param params.startTimeMs - Start timestamp (Unix ms)
   * @param params.endTimeMs - End timestamp (Unix ms)
   * @param params.limit - Maximum trades to return (default: 500)
   */
  async getTrades(params: {
    conditionId: string;
    startTimeMs?: number;
    endTimeMs?: number;
    limit?: number;
  }): Promise<CatalystTradesResponse> {
    const query = new URLSearchParams();
    if (params.startTimeMs != null) query.set('startTimeMs', String(params.startTimeMs));
    if (params.endTimeMs != null) query.set('endTimeMs', String(params.endTimeMs));
    if (params.limit != null) query.set('limit', String(params.limit));
    const q = query.toString();
    return this.fetchJson(`/v1/markets/${params.conditionId}/trades${q ? `?${q}` : ''}`) as Promise<CatalystTradesResponse>;
  }

  /**
   * Get orderbook snapshots for a market
   *
   * @param params.conditionId - Market condition ID
   * @param params.startTimeMs - Start timestamp (Unix ms)
   * @param params.endTimeMs - End timestamp (Unix ms)
   * @param params.stepMs - Downsampling step (only return one snapshot per stepMs)
   * @param params.limit - Maximum snapshots to return (default: 500)
   */
  async getOrderbookSnapshots(params: {
    conditionId: string;
    startTimeMs?: number;
    endTimeMs?: number;
    stepMs?: number;
    limit?: number;
  }): Promise<CatalystOrderbookSnapshotsResponse> {
    const query = new URLSearchParams();
    if (params.startTimeMs != null) query.set('startTimeMs', String(params.startTimeMs));
    if (params.endTimeMs != null) query.set('endTimeMs', String(params.endTimeMs));
    if (params.stepMs != null) query.set('stepMs', String(params.stepMs));
    if (params.limit != null) query.set('limit', String(params.limit));
    const q = query.toString();
    return this.fetchJson(`/v1/markets/${params.conditionId}/orderbook-snapshots${q ? `?${q}` : ''}`) as Promise<CatalystOrderbookSnapshotsResponse>;
  }

  /**
   * Get spread/depth history for a market
   *
   * Returns time series of spread snapshots for both primary and secondary outcomes.
   *
   * @param params.conditionId - Market condition ID
   * @param params.startTimeMs - Start timestamp (Unix ms)
   * @param params.endTimeMs - End timestamp (Unix ms)
   * @param params.limit - Maximum snapshots to return (default: 500)
   */
  async getDepthLine(params: {
    conditionId: string;
    startTimeMs?: number;
    endTimeMs?: number;
    limit?: number;
  }): Promise<CatalystDepthLineResponse> {
    const query = new URLSearchParams();
    if (params.startTimeMs != null) query.set('startTimeMs', String(params.startTimeMs));
    if (params.endTimeMs != null) query.set('endTimeMs', String(params.endTimeMs));
    if (params.limit != null) query.set('limit', String(params.limit));
    const q = query.toString();
    return this.fetchJson(`/v1/markets/${params.conditionId}/orderdepth-line${q ? `?${q}` : ''}`) as Promise<CatalystDepthLineResponse>;
  }

  /**
   * @deprecated Use getDepthLine instead
   */
  async getOrderDepthLine(params: {
    conditionId: string;
    startTimeMs?: number;
    endTimeMs?: number;
    limit?: number;
  }): Promise<CatalystDepthLineResponse> {
    return this.getDepthLine(params);
  }

  private async fetchJson(path: string): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: 'GET',
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`CatalystQueryService HTTP ${res.status}: ${text || res.statusText}`);
      }
      return await res.json();
    } finally {
      clearTimeout(timeout);
    }
  }
}

