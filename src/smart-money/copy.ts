/**
 * smart-money/copy.ts
 *
 * CopyEngine + PositionTracker + retry logic.
 * V2: Position-polling based copy trading.
 */

import { EventEmitter } from 'events';
import type { Position, DataApiClient } from '../clients/data-api.js';
import type { TradingService, OrderResult } from '../services/trading-service.js';
import type { PositionDiff, OrderRequest } from './types.js';
import { createModuleLogger } from '../core/logger.js';

const log = createModuleLogger('copy-engine');

export type { PositionDiff, OrderRequest };

// ============================================================================
// PositionTracker
// ============================================================================

/**
 * Polls leader positions and emits diffs as an EventEmitter.
 *
 * Events:
 *   'diff' → (address: string, diff: PositionDiff)
 *   'poll_error' → (address: string, error: Error)
 */
export class PositionTracker extends EventEmitter {
  private cache = new Map<string, Map<string, Position>>();
  private intervals = new Map<string, NodeJS.Timeout>();
  private dataApi: DataApiClient;

  constructor(dataApi: DataApiClient) {
    super();
    this.dataApi = dataApi;
  }

  /**
   * Start polling for a list of addresses.
   * Returns a cleanup function.
   */
  watch(addresses: string[], intervalMs = 10_000): void {
    for (const address of addresses) {
      const key = address.toLowerCase();
      if (this.intervals.has(key)) continue;

      const id = setInterval(async () => {
        try {
          const diffs = await this.poll(key);
          for (const diff of diffs) {
            this.emit('diff', key, diff);
          }
        } catch (err) {
          this.emit('poll_error', key, err instanceof Error ? err : new Error(String(err)));
        }
      }, intervalMs);

      this.intervals.set(key, id);
    }
  }

  /**
   * Stop polling for a list of addresses.
   */
  unwatch(addresses: string[]): void {
    for (const address of addresses) {
      const key = address.toLowerCase();
      const id = this.intervals.get(key);
      if (id) {
        clearInterval(id);
        this.intervals.delete(key);
      }
    }
  }

  /**
   * Stop all polling.
   */
  unwatchAll(): void {
    for (const id of this.intervals.values()) {
      clearInterval(id);
    }
    this.intervals.clear();
  }

  /**
   * Manually trigger a single poll for an address.
   * Returns the list of diffs and updates the cache.
   */
  async poll(address: string): Promise<PositionDiff[]> {
    const key = address.toLowerCase();
    const fresh = await this.dataApi.getPositions(key, { limit: 200 });
    const freshMap = new Map<string, Position>(
      fresh.map((p: Position) => [`${p.conditionId}:${p.outcomeIndex ?? p.outcome}`, p])
    );

    // First poll: establish baseline without firing 'new' events.
    if (!this.cache.has(key)) {
      this.cache.set(key, freshMap);
      return [];
    }

    const cached = this.cache.get(key)!;
    const diffs: PositionDiff[] = [];

    for (const pos of fresh) {
      const posKey = `${pos.conditionId}:${pos.outcomeIndex ?? pos.outcome}`;
      const prev = cached.get(posKey);

      if (!prev) {
        diffs.push({ type: 'new', position: pos });
      } else {
        const delta = (pos.totalBought ?? 0) - (prev.totalBought ?? 0);
        if (delta > 1) diffs.push({ type: 'increased', position: pos, deltaUSDC: delta });
        if (delta < -1) diffs.push({ type: 'decreased', position: pos, deltaUSDC: Math.abs(delta) });
      }
    }

    // Detect closed positions
    for (const [posKey, prev] of cached) {
      if (!freshMap.has(posKey)) {
        diffs.push({
          type: 'closed',
          conditionId: prev.conditionId,
          outcome: prev.outcome ?? '',
        });
      }
    }

    // Update cache
    this.cache.set(key, freshMap);

    return diffs;
  }

  /**
   * Read the current cached positions for an address.
   */
  getCache(address: string): Map<string, Position> {
    return this.cache.get(address.toLowerCase()) ?? new Map();
  }
}

// ============================================================================
// CopyEngine
// ============================================================================

/**
 * Order execution engine with two-layer retry.
 *
 * Layer 1: API-level retry (network errors, 429) — handled by TradingService.
 * Layer 2: Business-level retry — FOK reject → fallback GTC, FAK partial fill → GTC remainder.
 */
export class CopyEngine {
  constructor(private tradingService: TradingService) {}

  /**
   * Execute an order with optional business-level retry.
   *
   * GTC/GTD  → createLimitOrder  (resting order, no retry)
   * FOK/FAK  → createMarketOrder (immediate fill, optional fallback)
   * SELL     → always FOK        (must exit immediately)
   */
  async executeOrder(req: OrderRequest): Promise<OrderResult> {
    const { conditionId, tokenId, side, amount, price, orderType, retryCount = 0, retryFallback } = req;

    // SELL always uses FOK — stop-loss needs immediate execution
    const effectiveOrderType = side === 'SELL' ? 'FOK' : orderType;

    if (effectiveOrderType === 'GTC' || effectiveOrderType === 'GTD') {
      if (!price || price <= 0) {
        return { success: false, errorMsg: `GTC/GTD order requires a price (tokenId=${tokenId})` };
      }
      // amount (USDC) → size (shares): size = amount / price
      const size = amount / price;
      return this.tradingService.createLimitOrder({
        tokenId,
        side,
        price,
        size,
        orderType: effectiveOrderType,
      });
    }

    // FOK / FAK: market order
    let result = await this.tradingService.createMarketOrder({
      tokenId,
      side,
      amount,
      price: price ?? 0.5,
      orderType: effectiveOrderType as 'FOK' | 'FAK',
    });

    // Business-level retry: FOK/FAK failed → try fallback order type once
    if (!result.success && retryFallback && retryCount > 0) {
      log.info(`${effectiveOrderType} failed, falling back to ${retryFallback}`, { conditionId: conditionId.slice(0, 12) });
      if (retryFallback === 'GTC') {
        if (!price || price <= 0) {
          return { success: false, errorMsg: `GTC fallback requires a price (tokenId=${tokenId})` };
        }
        result = await this.tradingService.createLimitOrder({
          tokenId,
          side,
          price,
          size: amount / price,
          orderType: 'GTC',
        });
      } else {
        result = await this.tradingService.createMarketOrder({
          tokenId,
          side,
          amount,
          price: price ?? 0.5,
          orderType: retryFallback as 'FOK' | 'FAK',
        });
      }
    }

    return result;
  }
}
