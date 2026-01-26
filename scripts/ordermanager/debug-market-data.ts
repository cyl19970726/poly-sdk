#!/usr/bin/env npx tsx
/**
 * Debug script to check Gamma API market data structure
 */

import { GammaApiClient } from '../../src/clients/gamma-api.js';
import { RateLimiter } from '../../src/core/rate-limiter.js';
import { createUnifiedCache } from '../../src/core/unified-cache.js';

async function main() {
  const rateLimiter = new RateLimiter({ requestsPerSecond: 5, requestsPerMinute: 100 });
  const cache = createUnifiedCache({ maxSize: 1000, ttl: 30000 });
  const gammaApi = new GammaApiClient(rateLimiter, cache);

  console.log('Fetching trending markets...');
  const markets = await gammaApi.getTrendingMarkets(1);
  const m = markets[0];

  console.log('\n=== Market Data ===');
  console.log('Question:', m.question?.slice(0, 60));
  console.log('ConditionId:', m.conditionId);
  console.log('\n=== All Keys ===');
  console.log(Object.keys(m).join(', '));
  console.log('\n=== Token Fields ===');
  console.log('clobTokenIds type:', typeof m.clobTokenIds);
  console.log('clobTokenIds value:', m.clobTokenIds);
  console.log('outcomes type:', typeof m.outcomes);
  console.log('outcomes value:', m.outcomes);
  console.log('outcomePrices type:', typeof m.outcomePrices);
  console.log('outcomePrices value:', m.outcomePrices);

  // Try parsing
  console.log('\n=== Parsed Values ===');
  try {
    const tokenIds = JSON.parse(m.clobTokenIds || '[]');
    console.log('Parsed tokenIds:', tokenIds);
  } catch (e) {
    console.log('Failed to parse clobTokenIds:', e);
  }

  try {
    const outcomes = JSON.parse(m.outcomes || '[]');
    console.log('Parsed outcomes:', outcomes);
  } catch (e) {
    console.log('Failed to parse outcomes:', e);
  }

  try {
    const prices = JSON.parse(m.outcomePrices || '[]');
    console.log('Parsed prices:', prices);
  } catch (e) {
    console.log('Failed to parse outcomePrices:', e);
  }
}

main().catch(console.error);
