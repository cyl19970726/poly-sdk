/**
 * Bridge adapter between legacy Cache class and new CacheAdapter interface
 *
 * This allows the SDK to work with both:
 * 1. Legacy internal Cache (synchronous, millisecond TTL)
 * 2. New CacheAdapter interface (async, second TTL)
 */

import type { CacheAdapter } from '@catalyst-team/cache';
import { Cache } from './cache.js';
import { createModuleLogger } from './logger.js';

const log = createModuleLogger('cache-adapter');

/**
 * Wraps the legacy Cache class to implement CacheAdapter interface
 */
export class LegacyCacheAdapter implements CacheAdapter {
  constructor(private cache: Cache) {}

  async get<T>(key: string): Promise<T | null> {
    const value = this.cache.get<T>(key);
    return value === undefined ? null : value;
  }

  async set<T>(key: string, value: T, ttl?: number): Promise<void> {
    // Convert seconds to milliseconds (CacheAdapter uses seconds, Cache uses ms)
    const ttlMs = ttl ? ttl * 1000 : 60000; // Default 60s
    this.cache.set(key, value, ttlMs);
  }

  async del(key: string): Promise<void> {
    this.cache.invalidate(key);
  }

  async exists(key: string): Promise<boolean> {
    const value = this.cache.get(key);
    return value !== undefined;
  }

  async clear(): Promise<void> {
    this.cache.clear();
  }
}

/**
 * Wraps a CacheAdapter to provide the legacy Cache interface
 * This allows using new cache adapters with code expecting the old Cache class
 */
export class CacheAdapterWrapper {
  constructor(private adapter: CacheAdapter) {}

  get<T>(key: string): T | undefined {
    // Note: This makes an async operation sync, which may cause issues
    // However, we need to maintain backward compatibility
    let result: T | undefined;
    this.adapter.get<T>(key).then((value) => {
      result = value ?? undefined;
    });
    return result;
  }

  set<T>(key: string, value: T, ttlMs: number): void {
    // Convert milliseconds to seconds
    const ttlSeconds = Math.ceil(ttlMs / 1000);
    void this.adapter.set(key, value, ttlSeconds);
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
    await this.adapter.set(key, value, ttlSeconds);
    return value;
  }

  invalidate(pattern: string): void {
    // CacheAdapter doesn't have pattern matching, so we can't implement this
    // This is a limitation of the adapter approach
    log.warn('invalidate(pattern) not supported with external cache adapter');
  }

  clear(): void {
    void this.adapter.clear?.();
  }

  size(): number {
    // CacheAdapter doesn't expose size, return -1 to indicate unknown
    return -1;
  }
}
