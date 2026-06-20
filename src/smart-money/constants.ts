/**
 * smart-money/constants.ts
 *
 * Market categorization constants and utilities.
 * Extracted from smart-money-service.ts (V2 modularization).
 */

import type { MarketCategory } from './types.js';

/**
 * Keywords for market categorization by category
 */
export const CATEGORY_KEYWORDS: Record<MarketCategory, RegExp> = {
  crypto: /\b(btc|bitcoin|eth|ethereum|sol|solana|xrp|crypto|doge|ada|matic)\b/i,
  politics: /\b(trump|biden|election|president|senate|congress|vote|political|maga|democrat|republican)\b/i,
  sports: /\b(nfl|nba|mlb|nhl|super bowl|world cup|championship|game|match|ufc|soccer|football|basketball)\b/i,
  economics: /\b(fed|interest rate|inflation|gdp|recession|economic|unemployment|cpi)\b/i,
  entertainment: /\b(oscar|grammy|movie|twitter|celebrity|entertainment|netflix|spotify)\b/i,
  science: /\b(spacex|nasa|ai|openai|google|apple|tesla|tech|technology|science)\b/i,
  other: /.*/, // Matches everything as fallback
};

/**
 * Categorize a market based on its title
 *
 * @param title - Market title to categorize
 * @returns The market category
 *
 * @example
 * ```typescript
 * import { categorizeMarket } from '@catalyst-team/poly-sdk';
 *
 * categorizeMarket('Will BTC hit $100k?'); // 'crypto'
 * categorizeMarket('Trump wins 2024?');    // 'politics'
 * categorizeMarket('Lakers win NBA?');     // 'sports'
 * categorizeMarket('Random event?');       // 'other'
 * ```
 */
export function categorizeMarket(title: string): MarketCategory {
  const lowerTitle = title.toLowerCase();

  if (CATEGORY_KEYWORDS.crypto.test(lowerTitle)) return 'crypto';
  if (CATEGORY_KEYWORDS.politics.test(lowerTitle)) return 'politics';
  if (CATEGORY_KEYWORDS.sports.test(lowerTitle)) return 'sports';
  if (CATEGORY_KEYWORDS.economics.test(lowerTitle)) return 'economics';
  if (CATEGORY_KEYWORDS.entertainment.test(lowerTitle)) return 'entertainment';
  if (CATEGORY_KEYWORDS.science.test(lowerTitle)) return 'science';

  return 'other';
}
