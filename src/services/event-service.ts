/**
 * Event Service
 *
 * Provides access to Polymarket Events API for event-level market organization.
 * Events group related markets together (e.g., all markets for a presidential election,
 * all BTC 15m markets for a specific time window, or all markets for a CS2 tournament).
 *
 * @remarks
 * - Base URL: https://gamma-api.polymarket.com/events
 * - Best for: Discovering event-level structure, grouping related markets
 * - Rate limits are automatically handled by the RateLimiter
 *
 * @example
 * ```typescript
 * import { EventService, RateLimiter, Cache } from '@catalyst-team/poly-sdk';
 *
 * const eventService = new EventService(new RateLimiter(), new Cache());
 *
 * // List active events
 * const events = await eventService.listEvents({ active: true, limit: 20 });
 *
 * // Get specific event by ID
 * const event = await eventService.getEventById('event-id-123');
 *
 * // Get event by slug
 * const btcEvent = await eventService.getEventBySlug('btc-15m-2026-03-01-1400');
 * ```
 *
 * @see {@link https://docs.polymarket.com/api-reference/events Polymarket Events API}
 *
 * @module services/event-service
 */

import { RateLimiter, ApiType } from '../core/rate-limiter.js';
import type { UnifiedCache } from '../core/unified-cache.js';
import { PolymarketError, ErrorCode } from '../core/errors.js';

/** Gamma API base URL for Events */
const EVENTS_API_BASE = 'https://gamma-api.polymarket.com/events';

// ===== Types =====

/**
 * Polymarket Event
 *
 * @remarks
 * Events organize related markets into logical groupings. For example:
 * - A presidential election event contains electoral college, popular vote, and state-level markets
 * - A BTC 15m event contains all 4 coin markets (BTC/ETH/SOL/XRP) for a specific 15-minute window
 * - A CS2 tournament event contains all matches and related markets (Map1/Map2/Winner/Handicap)
 */
export interface PolymarketEvent {
  /**
   * Event ID
   * @example "btc-15m-2026-03-01-1400"
   */
  id: string;

  /**
   * URL-friendly slug
   * @example "btc-15m-2026-03-01-1400"
   */
  slug: string;

  /**
   * Event title/name
   * @example "BTC 15-Minute Price Prediction (2026-03-01 14:00 UTC)"
   */
  title: string;

  /**
   * Event description
   */
  description?: string;

  /**
   * Event start time
   */
  startDate?: Date;

  /**
   * Event end time (when all markets close)
   */
  endDate?: Date;

  /**
   * Market condition IDs in this event
   */
  markets: string[];

  /**
   * Tags/categories for this event
   * @example ["crypto", "short-term", "btc"]
   */
  tags?: string[];

  /**
   * Whether the event is currently active
   */
  active?: boolean;

  /**
   * Whether the event is closed/resolved
   */
  closed?: boolean;

  /**
   * Whether the event is archived
   */
  archived?: boolean;

  /**
   * Event image URL
   */
  image?: string;

  /**
   * Total volume across all markets in this event (USDC)
   */
  volume?: number;

  /**
   * Liquidity across all markets in this event (USDC)
   */
  liquidity?: number;

  /**
   * When the event was created
   */
  creationDate?: Date;
}

/**
 * Parameters for listing events
 */
export interface ListEventsParams {
  /**
   * Only show active events
   * @default false
   */
  active?: boolean;

  /**
   * Only show closed events
   * @default false
   */
  closed?: boolean;

  /**
   * Only show archived events
   * @default false
   */
  archived?: boolean;

  /**
   * Filter by tag
   * @example "crypto"
   */
  tag?: string;

  /**
   * Number of events to return
   * @default 20
   */
  limit?: number;

  /**
   * Offset for pagination
   * @default 0
   */
  offset?: number;

  /**
   * Order by field
   * @example "volume", "endDate", "startDate"
   */
  order?: 'volume' | 'liquidity' | 'endDate' | 'startDate' | 'creationDate';

  /**
   * Sort ascending (true) or descending (false)
   * @default false
   */
  ascending?: boolean;
}

/**
 * Event tag
 */
export interface EventTag {
  /**
   * Tag name
   * @example "crypto"
   */
  tag: string;

  /**
   * Number of events with this tag
   */
  count?: number;
}

// ===== EventService Class =====

/**
 * EventService provides access to Polymarket Events API
 */
export class EventService {
  constructor(
    private rateLimiter: RateLimiter,
    private cache: UnifiedCache
  ) {}

  /**
   * List events with optional filtering
   *
   * @param params - Filter and pagination parameters
   * @returns Array of events
   *
   * @example
   * ```typescript
   * // Get active crypto events
   * const events = await eventService.listEvents({
   *   active: true,
   *   tag: 'crypto',
   *   limit: 50
   * });
   * ```
   */
  async listEvents(params: ListEventsParams = {}): Promise<PolymarketEvent[]> {
    const {
      active,
      closed,
      archived,
      tag,
      limit = 20,
      offset = 0,
      order,
      ascending = false,
    } = params;

    // Build query string
    const queryParams = new URLSearchParams();
    if (active !== undefined) queryParams.set('active', String(active));
    if (closed !== undefined) queryParams.set('closed', String(closed));
    if (archived !== undefined) queryParams.set('archived', String(archived));
    if (tag) queryParams.set('tag', tag);
    queryParams.set('limit', String(limit));
    queryParams.set('offset', String(offset));
    if (order) queryParams.set('order', order);
    queryParams.set('ascending', String(ascending));

    const url = `${EVENTS_API_BASE}?${queryParams.toString()}`;
    const cacheKey = `events:list:${queryParams.toString()}`;

    // Check cache
    const cached = await this.cache.get<PolymarketEvent[]>(cacheKey);
    if (cached) return cached;

    // Rate limit and fetch
    const events = await this.rateLimiter.execute(ApiType.GAMMA_API, async () => {
      const response = await fetch(url);
      if (!response.ok) {
        throw new PolymarketError(
          ErrorCode.API_ERROR,
          `Failed to list events: ${response.status} ${response.statusText}`
        );
      }

      const data = (await response.json()) as any[];
      return data.map((e) => this.parseEvent(e));
    });

    // Cache for 5 minutes
    await this.cache.set(cacheKey, events, 5 * 60 * 1000);

    return events;
  }

  /**
   * Get event by ID
   *
   * @param eventId - Event ID
   * @returns Event details
   *
   * @example
   * ```typescript
   * const event = await eventService.getEventById('btc-15m-2026-03-01-1400');
   * console.log(event.markets); // Array of conditionIds
   * ```
   */
  async getEventById(eventId: string): Promise<PolymarketEvent> {
    const url = `${EVENTS_API_BASE}/${eventId}`;
    const cacheKey = `events:id:${eventId}`;

    // Check cache
    const cached = await this.cache.get<PolymarketEvent>(cacheKey);
    if (cached) return cached;

    // Rate limit and fetch
    const event = await this.rateLimiter.execute(ApiType.GAMMA_API, async () => {
      const response = await fetch(url);
      if (!response.ok) {
        if (response.status === 404) {
          throw new PolymarketError(
            ErrorCode.MARKET_NOT_FOUND,
            `Event not found: ${eventId}`
          );
        }
        throw new PolymarketError(
          ErrorCode.API_ERROR,
          `Failed to get event: ${response.status} ${response.statusText}`
        );
      }

      const data = await response.json();
      return this.parseEvent(data);
    });

    // Cache for 5 minutes
    await this.cache.set(cacheKey, event, 5 * 60 * 1000);

    return event;
  }

  /**
   * Get event by slug
   *
   * @param slug - Event slug
   * @returns Event details
   *
   * @example
   * ```typescript
   * const event = await eventService.getEventBySlug('btc-15m-2026-03-01-1400');
   * ```
   */
  async getEventBySlug(slug: string): Promise<PolymarketEvent> {
    const url = `${EVENTS_API_BASE}/slug/${slug}`;
    const cacheKey = `events:slug:${slug}`;

    // Check cache
    const cached = await this.cache.get<PolymarketEvent>(cacheKey);
    if (cached) return cached;

    // Rate limit and fetch
    const event = await this.rateLimiter.execute(ApiType.GAMMA_API, async () => {
      const response = await fetch(url);
      if (!response.ok) {
        if (response.status === 404) {
          throw new PolymarketError(
            ErrorCode.MARKET_NOT_FOUND,
            `Event not found: ${slug}`
          );
        }
        throw new PolymarketError(
          ErrorCode.API_ERROR,
          `Failed to get event: ${response.status} ${response.statusText}`
        );
      }

      const data = await response.json();
      return this.parseEvent(data);
    });

    // Cache for 5 minutes
    await this.cache.set(cacheKey, event, 5 * 60 * 1000);

    return event;
  }

  /**
   * Get available event tags
   *
   * @returns Array of tags with counts
   *
   * @example
   * ```typescript
   * const tags = await eventService.getEventTags();
   * console.log(tags); // [{ tag: 'crypto', count: 150 }, { tag: 'sports', count: 80 }, ...]
   * ```
   */
  async getEventTags(): Promise<EventTag[]> {
    const url = `${EVENTS_API_BASE}/tags`;
    const cacheKey = 'events:tags';

    // Check cache
    const cached = await this.cache.get<EventTag[]>(cacheKey);
    if (cached) return cached;

    // Rate limit and fetch
    const tags = await this.rateLimiter.execute(ApiType.GAMMA_API, async () => {
      const response = await fetch(url);
      if (!response.ok) {
        throw new PolymarketError(
          ErrorCode.API_ERROR,
          `Failed to get event tags: ${response.status} ${response.statusText}`
        );
      }

      return (await response.json()) as EventTag[];
    });

    // Cache for 1 hour (tags change slowly)
    await this.cache.set(cacheKey, tags, 60 * 60 * 1000);

    return tags;
  }

  /**
   * Parse raw API response into PolymarketEvent
   */
  private parseEvent(data: any): PolymarketEvent {
    return {
      id: data.id,
      slug: data.slug,
      title: data.title,
      description: data.description,
      startDate: data.startDate ? new Date(data.startDate) : undefined,
      endDate: data.endDate ? new Date(data.endDate) : undefined,
      markets: data.markets || [],
      tags: data.tags || [],
      active: data.active,
      closed: data.closed,
      archived: data.archived,
      image: data.image,
      volume: data.volume,
      liquidity: data.liquidity,
      creationDate: data.creationDate ? new Date(data.creationDate) : undefined,
    };
  }
}
