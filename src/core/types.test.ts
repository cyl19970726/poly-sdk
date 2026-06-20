/**
 * Core Types Unit Tests
 *
 * Tests type definitions and type guards
 */

import { describe, it, expect } from 'vitest';
import { getBinaryTokens } from './types.js';
import type {
  UnifiedMarket,
  MarketToken,
  Orderbook,
  OrderbookLevel,
  Side,
  OrderType,
} from './types.js';

describe('Core Types', () => {
  describe('MarketToken', () => {
    it('should have correct structure', () => {
      const token: MarketToken = {
        tokenId: '123456789',
        outcome: 'Yes',
        price: 0.55,
      };

      expect(token.tokenId).toBe('123456789');
      expect(token.outcome).toBe('Yes');
      expect(token.price).toBe(0.55);
    });
  });

  describe('UnifiedMarket', () => {
    it('should preserve binary token order', () => {
      const market: UnifiedMarket = {
        conditionId: '0x123',
        slug: 'test-market',
        question: 'Will this test pass?',
        tokens: [
          { tokenId: 'yes-token', outcome: 'Yes', price: 0.6 },
          { tokenId: 'no-token', outcome: 'No', price: 0.4 },
        ],
        volume: 10000,
        liquidity: 5000,
        active: true,
        closed: false,
        acceptingOrders: true,
        endDate: new Date('2025-12-31'),
        source: 'gamma',
      };

      // Tokens should be an array
      expect(Array.isArray(market.tokens)).toBe(true);
      expect(market.tokens.length).toBe(2);

      const binary = getBinaryTokens(market.tokens);

      expect(binary).not.toBeNull();
      expect(binary?.primary.tokenId).toBe('yes-token');
      expect(binary?.primary.price).toBe(0.6);
      expect(binary?.secondary.tokenId).toBe('no-token');
      expect(binary?.secondary.price).toBe(0.4);
    });

    it('should support multi-outcome markets', () => {
      const market: UnifiedMarket = {
        conditionId: '0x456',
        slug: 'multi-outcome',
        question: 'Who will win?',
        tokens: [
          { tokenId: 'a-token', outcome: 'Candidate A', price: 0.4 },
          { tokenId: 'b-token', outcome: 'Candidate B', price: 0.35 },
          { tokenId: 'c-token', outcome: 'Candidate C', price: 0.25 },
        ],
        volume: 50000,
        liquidity: 20000,
        active: true,
        closed: false,
        acceptingOrders: true,
        endDate: new Date('2025-11-05'),
        source: 'clob',
      };

      expect(market.tokens.length).toBe(3);
      expect(market.tokens.map(t => t.outcome)).toEqual([
        'Candidate A',
        'Candidate B',
        'Candidate C',
      ]);
      expect(getBinaryTokens(market.tokens)).toBeNull();
    });
  });

  describe('Orderbook', () => {
    it('should have correct structure', () => {
      const orderbook: Orderbook = {
        bids: [
          { price: 0.50, size: 100 },
          { price: 0.49, size: 200 },
        ],
        asks: [
          { price: 0.52, size: 150 },
          { price: 0.53, size: 250 },
        ],
        timestamp: Date.now(),
      };

      expect(orderbook.bids.length).toBe(2);
      expect(orderbook.asks.length).toBe(2);
      expect(orderbook.bids[0].price).toBeGreaterThan(orderbook.bids[1].price);
      expect(orderbook.asks[0].price).toBeLessThan(orderbook.asks[1].price);
    });
  });

  describe('OrderbookLevel', () => {
    it('should have price and size', () => {
      const level: OrderbookLevel = {
        price: 0.55,
        size: 100,
      };

      expect(level.price).toBe(0.55);
      expect(level.size).toBe(100);
    });
  });

  describe('Side', () => {
    it('should only allow BUY or SELL', () => {
      const buy: Side = 'BUY';
      const sell: Side = 'SELL';

      expect(buy).toBe('BUY');
      expect(sell).toBe('SELL');
    });
  });

  describe('OrderType', () => {
    it('should support all order types', () => {
      const gtc: OrderType = 'GTC';
      const gtd: OrderType = 'GTD';
      const fok: OrderType = 'FOK';
      const fak: OrderType = 'FAK';

      expect([gtc, gtd, fok, fak]).toEqual(['GTC', 'GTD', 'FOK', 'FAK']);
    });
  });
});
