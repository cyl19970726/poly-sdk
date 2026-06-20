/**
 * Unified cache interface for poly-sdk
 *
 * Bridges between:
 * 1. Legacy internal Cache (synchronous get/set with millisecond TTL)
 * 2. New CacheAdapter interface (async with second TTL)
 *
 * This allows the SDK to accept external cache adapters while maintaining
 * backward compatibility with existing code.
 */

import type { CacheAdapter } from '@catalyst-team/cache';
import { Cache, CACHE_TTL } from './cache.js';
import { createModuleLogger } from './logger.js';

const log = createModuleLogger('unified-cache');

/**
 * Unified cache interface that works with both legacy Cache and CacheAdapter
 *
 * Key features:
 * - Async API (compatible with CacheAdapter)
 * - Millisecond TTL (compatible with existing SDK code)
 * - getOrSet helper for cache-aside pattern
 */
export interface UnifiedCache {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, ttlMs: number): Promise<void>;
  getOrSet<T>(key: string, ttlMs: number, factory: () => Promise<T>): Promise<T>;
  invalidate(pattern: string): Promise<void>;
  clear(): void;
}

/**
 * Wraps the legacy Cache class to provide async interface
 */
export class LegacyCacheWrapper implements UnifiedCache {
  constructor(private cache: Cache) {}

  async get<T>(key: string): Promise<T | undefined> {
    return this.cache.get<T>(key);
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    this.cache.set(key, value, ttlMs);
  }

  async getOrSet<T>(
    key: string,
    ttlMs: number,
    factory: () => Promise<T>
  ): Promise<T> {
    return this.cache.getOrSet(key, ttlMs, factory);
  }

  async invalidate(pattern: string): Promise<void> {
    this.cache.invalidate(pattern);
  }

  clear(): void {
    this.cache.clear();
  }
}

/**
 * Wraps a CacheAdapter to provide legacy-compatible interface
 *
 * Main differences:
 * - Converts milliseconds to seconds for TTL
 * - Returns undefined instead of null for missing keys
 * - Implements getOrSet helper
 * - Implements pattern-based invalidation (limited support)
 */
export class CacheAdapterWrapper implements UnifiedCache {
  constructor(private adapter: CacheAdapter) {}

  async get<T>(key: string): Promise<T | undefined> {
    const value = await this.adapter.get<T>(key);
    return value ?? undefined;
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    // Convert milliseconds to seconds
    const ttlSeconds = Math.ceil(ttlMs / 1000);

    // Check if this is a CacheManager (has getStats method)
    if ('getStats' in this.adapter) {
      // This is a CacheManager - use CacheSetOptions signature
      await (this.adapter as any).set(key, value, { ttl: ttlSeconds });
    } else {
      // This is a regular CacheAdapter - use simple signature
      await this.adapter.set(key, value, ttlSeconds);
    }
  }

  async getOrSet<T>(
    key: string,
    ttlMs: number,
    factory: () => Promise<T>
  ): Promise<T> {
    const cached = await this.adapter.get<T>(key);
    if (cached !== null) return cached;

    const value = await factory();
    const ttlSeconds = Math.ceil(ttlMs / 1000);

    // Check if this is a CacheManager
    if ('getStats' in this.adapter) {
      // This is a CacheManager
      await (this.adapter as any).set(key, value, { ttl: ttlSeconds });
    } else {
      // This is a regular CacheAdapter
      await this.adapter.set(key, value, ttlSeconds);
    }
    return value;
  }

  async invalidate(pattern: string): Promise<void> {
    // CacheAdapter doesn't have pattern matching
    // Best we can do is warn - this is a limitation
    log.warn(`invalidate(pattern="${pattern}") not fully supported with external cache adapter`);
  }

  clear(): void {
    void this.adapter.clear?.();
  }
}

/**
 * Create a UnifiedCache from either legacy Cache or CacheAdapter
 */
export function createUnifiedCache(
  cache?: CacheAdapter | Cache
): UnifiedCache {
  if (!cache) {
    // No cache provided, create default legacy cache
    return new LegacyCacheWrapper(new Cache());
  }

  // Check if it's a CacheAdapter (has async get method)
  if ('get' in cache && typeof cache.get === 'function') {
    const testResult = cache.get('test');
    if (testResult instanceof Promise) {
      // It's a CacheAdapter
      return new CacheAdapterWrapper(cache as CacheAdapter);
    }
  }

  // It's a legacy Cache
  return new LegacyCacheWrapper(cache as Cache);
}

// Re-export CACHE_TTL for convenience
export { CACHE_TTL };
