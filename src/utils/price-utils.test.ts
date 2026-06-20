/**
 * Price Utilities Unit Tests
 */

import { describe, it, expect } from 'vitest';
import {
  roundPrice,
  roundSize,
  validatePrice,
  validateSize,
  calculateBuyAmount,
  calculateSellPayout,
  calculateSharesForAmount,
  calculateSpread,
  calculateMidpoint,
  calculatePlatformFee,
  calculateBuilderFee,
  estimateOrderFees,
  estimateBinaryArbitrageFees,
  estimateMultiLegArbitrageFees,
  getEffectivePrices,
  checkArbitrage,
  checkArbitrageWithFees,
  formatPrice,
  formatUSDC,
  calculatePnL,
  ROUNDING_CONFIG,
  type TickSize,
} from './price-utils.js';

describe('Price Utilities', () => {
  describe('roundPrice', () => {
    it('should round down with floor', () => {
      expect(roundPrice(0.523, '0.01', 'floor')).toBe(0.52);
      expect(roundPrice(0.529, '0.01', 'floor')).toBe(0.52);
    });

    it('should round up with ceil', () => {
      expect(roundPrice(0.521, '0.01', 'ceil')).toBe(0.53);
      expect(roundPrice(0.520, '0.01', 'ceil')).toBe(0.52);
    });

    it('should round to nearest with round', () => {
      expect(roundPrice(0.524, '0.01', 'round')).toBe(0.52);
      expect(roundPrice(0.525, '0.01', 'round')).toBe(0.53);
    });

    it('should respect different tick sizes', () => {
      expect(roundPrice(0.1234, '0.1', 'round')).toBe(0.1);
      expect(roundPrice(0.1234, '0.01', 'round')).toBe(0.12);
      expect(roundPrice(0.1234, '0.001', 'round')).toBe(0.123);
      expect(roundPrice(0.1234, '0.0001', 'round')).toBe(0.1234);
    });

    it('should clamp to valid price range', () => {
      expect(roundPrice(0.0001, '0.01', 'floor')).toBe(0.001);
      expect(roundPrice(0.9999, '0.01', 'ceil')).toBe(0.999);
    });
  });

  describe('roundSize', () => {
    it('should round to 2 decimal places', () => {
      expect(roundSize(1.234)).toBe(1.23);
      expect(roundSize(1.235)).toBe(1.24);
      expect(roundSize(10)).toBe(10);
    });
  });

  describe('validatePrice', () => {
    it('should accept valid prices', () => {
      expect(validatePrice(0.5, '0.01').valid).toBe(true);
      expect(validatePrice(0.001, '0.001').valid).toBe(true);
      expect(validatePrice(0.999, '0.001').valid).toBe(true);
    });

    it('should reject prices outside range', () => {
      expect(validatePrice(0, '0.01').valid).toBe(false);
      expect(validatePrice(1, '0.01').valid).toBe(false);
      expect(validatePrice(-0.1, '0.01').valid).toBe(false);
    });

    it('should reject prices not aligned to tick size', () => {
      const result = validatePrice(0.123, '0.01');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('does not align');
    });
  });

  describe('validateSize', () => {
    it('should accept valid sizes', () => {
      expect(validateSize(1).valid).toBe(true);
      expect(validateSize(0.1).valid).toBe(true);
    });

    it('should reject sizes below minimum', () => {
      const result = validateSize(0.05);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('below minimum');
    });

    it('should respect custom minimum', () => {
      expect(validateSize(0.5, 1).valid).toBe(false);
      expect(validateSize(1.5, 1).valid).toBe(true);
    });
  });

  describe('calculateBuyAmount', () => {
    it('should calculate cost correctly', () => {
      expect(calculateBuyAmount(0.5, 10)).toBe(5);
      expect(calculateBuyAmount(0.25, 100)).toBe(25);
    });
  });

  describe('calculateSellPayout', () => {
    it('should calculate payout correctly', () => {
      expect(calculateSellPayout(0.75, 10)).toBe(7.5);
      expect(calculateSellPayout(0.5, 20)).toBe(10);
    });
  });

  describe('fee estimation', () => {
    it('calculates taker platform fees with the official symmetric curve', () => {
      // 100 shares at 50c with a 0.03 rate: 100 * 0.03 * 0.5 * 0.5 = 0.75
      expect(calculatePlatformFee(0.5, 100, { rate: 0.03 })).toBe(0.75);

      // Symmetric around 50c.
      expect(calculatePlatformFee(0.3, 100, { rate: 0.03 })).toBe(
        calculatePlatformFee(0.7, 100, { rate: 0.03 })
      );
    });

    it('does not charge taker-only platform fees to maker fills', () => {
      expect(calculatePlatformFee(0.5, 100, { rate: 0.03, takerOnly: true }, 'maker')).toBe(0);
    });

    it('supports non-default fee exponent from CLOB market info', () => {
      // With exponent=2, uncertainty is squared before applying the rate.
      expect(calculatePlatformFee(0.5, 100, { rate: 0.03, exponent: 2 })).toBe(0.1875);
    });

    it('rounds fees to five decimals and drops below the minimum charged fee', () => {
      expect(calculatePlatformFee(0.333333, 1, { rate: 0.03 })).toBe(0.00667);
      expect(calculatePlatformFee(0.001, 0.1, { rate: 0.03 })).toBe(0);
    });

    it('calculates additive builder fees from notional bps', () => {
      expect(calculateBuilderFee(100, { takerBps: 25 }, 'taker')).toBe(0.25);
      expect(calculateBuilderFee(100, { makerBps: 10 }, 'maker')).toBe(0.1);
    });

    it('returns BUY total cost and SELL net proceeds after fees', () => {
      const buy = estimateOrderFees({ side: 'BUY', price: 0.5, size: 100, rate: 0.03 });
      expect(buy.notional).toBe(50);
      expect(buy.platformFee).toBe(0.75);
      expect(buy.totalCost).toBe(50.75);
      expect(buy.netProceeds).toBe(0);

      const sell = estimateOrderFees({ side: 'SELL', price: 0.5, size: 100, rate: 0.03 });
      expect(sell.notional).toBe(50);
      expect(sell.platformFee).toBe(0.75);
      expect(sell.totalCost).toBe(0);
      expect(sell.netProceeds).toBe(49.25);
    });

    it('shows the live France one-tick round trip is dominated by fees', () => {
      const roundTripFees = estimateOrderFees({ side: 'BUY', price: 0.197, size: 6, rate: 0.03 }).totalFee
        + estimateOrderFees({ side: 'SELL', price: 0.196, size: 6, rate: 0.03 }).totalFee;
      expect(roundTripFees).toBeCloseTo(0.05684, 5);

      const spreadLoss = (0.197 - 0.196) * 6;
      expect(spreadLoss + roundTripFees).toBeCloseTo(0.06284, 5);
    });

    it('estimates net binary arbitrage after fees', () => {
      const estimate = estimateBinaryArbitrageFees({
        type: 'long',
        size: 10,
        yesPrice: 0.49,
        noPrice: 0.49,
        rate: 0.03,
      });

      expect(estimate.grossProfit).toBeCloseTo(0.2, 10);
      expect(estimate.totalFees).toBeCloseTo(0.14994, 5);
      expect(estimate.netProfit).toBeCloseTo(0.05006, 5);
    });

    it('includes builder fees in binary arbitrage net profit', () => {
      const estimate = estimateBinaryArbitrageFees({
        type: 'long',
        size: 10,
        yesPrice: 0.49,
        noPrice: 0.49,
        rate: 0.03,
        takerBps: 25,
      });

      // Builder fee: (0.49 * 10 * 25 / 10000) * 2 = 0.0245
      expect(estimate.totalFees).toBeCloseTo(0.17444, 5);
      expect(estimate.netProfit).toBeCloseTo(0.02556, 5);
    });

    it('estimates short arbitrage sell proceeds after fees', () => {
      const estimate = estimateBinaryArbitrageFees({
        type: 'short',
        size: 10,
        yesPrice: 0.51,
        noPrice: 0.51,
        rate: 0.03,
      });

      expect(estimate.grossProfit).toBeCloseTo(0.2, 10);
      expect(estimate.legs.yes.netProceeds).toBeCloseTo(5.02503, 5);
      expect(estimate.legs.no.netProceeds).toBeCloseTo(5.02503, 5);
      expect(estimate.netProfit).toBeCloseTo(0.05006, 5);
    });

    it('aggregates multi-leg fees with per-leg market configs', () => {
      const estimate = estimateMultiLegArbitrageFees({
        type: 'long',
        size: 10,
        legs: [
          { label: 'A', price: 0.25, rate: 0.03 },
          { label: 'B', price: 0.35, rate: 0.03 },
          { label: 'Any Other Score', price: 0.38, rate: 0.06 },
        ],
      });

      expect(estimate.priceSum).toBeCloseTo(0.98, 10);
      expect(estimate.grossProfit).toBeCloseTo(0.2, 10);
      expect(estimate.legs[2]?.estimate.platformFee).toBeCloseTo(0.14136, 5);
      expect(estimate.totalFees).toBeCloseTo(0.26586, 5);
      expect(estimate.netProfit).toBeCloseTo(-0.06586, 5);
    });

    it('supports short multi-leg fee estimates', () => {
      const estimate = estimateMultiLegArbitrageFees({
        type: 'short',
        size: 10,
        legs: [
          { label: 'A', price: 0.36, rate: 0.03 },
          { label: 'B', price: 0.36, rate: 0.03 },
          { label: 'Other', price: 0.36, rate: 0.03 },
        ],
      });

      expect(estimate.priceSum).toBeCloseTo(1.08, 10);
      expect(estimate.grossProfit).toBeCloseTo(0.8, 10);
      expect(estimate.totalFees).toBeCloseTo(0.20736, 5);
      expect(estimate.netProfit).toBeCloseTo(0.59264, 5);
      expect(estimate.legs[0]?.estimate.side).toBe('SELL');
    });
  });

  describe('calculateSharesForAmount', () => {
    it('should calculate shares correctly', () => {
      expect(calculateSharesForAmount(10, 0.5)).toBe(20);
      expect(calculateSharesForAmount(25, 0.25)).toBe(100);
    });

    it('should round to 2 decimals', () => {
      expect(calculateSharesForAmount(10, 0.33)).toBe(30.3);
    });
  });

  describe('calculateSpread', () => {
    it('should calculate spread correctly', () => {
      expect(calculateSpread(0.45, 0.55)).toBeCloseTo(0.1, 10);
      expect(calculateSpread(0.5, 0.5)).toBe(0);
    });
  });

  describe('calculateMidpoint', () => {
    it('should calculate midpoint correctly', () => {
      expect(calculateMidpoint(0.4, 0.6)).toBe(0.5);
      expect(calculateMidpoint(0.3, 0.5)).toBe(0.4);
    });
  });

  describe('getEffectivePrices', () => {
    it('should calculate effective prices with mirroring', () => {
      // Scenario: YES ask=0.55, bid=0.45, NO ask=0.55, bid=0.45
      const result = getEffectivePrices(0.55, 0.45, 0.55, 0.45);

      // Buy YES: min(0.55, 1-0.45) = min(0.55, 0.55) = 0.55
      expect(result.effectiveBuyYes).toBe(0.55);

      // Buy NO: min(0.55, 1-0.45) = min(0.55, 0.55) = 0.55
      expect(result.effectiveBuyNo).toBe(0.55);

      // Sell YES: max(0.45, 1-0.55) = max(0.45, 0.45) = 0.45
      expect(result.effectiveSellYes).toBe(0.45);

      // Sell NO: max(0.45, 1-0.55) = max(0.45, 0.45) = 0.45
      expect(result.effectiveSellNo).toBe(0.45);
    });

    it('should find better prices through mirroring', () => {
      // Asymmetric case: YES ask=0.60, bid=0.45, NO ask=0.50, bid=0.35
      const result = getEffectivePrices(0.60, 0.45, 0.50, 0.35);

      // Buy YES: min(0.60, 1-0.35) = min(0.60, 0.65) = 0.60
      expect(result.effectiveBuyYes).toBe(0.60);

      // Buy NO: min(0.50, 1-0.45) = min(0.50, 0.55) = 0.50
      expect(result.effectiveBuyNo).toBe(0.50);
    });
  });

  describe('checkArbitrage', () => {
    it('should detect long arbitrage', () => {
      // YES ask=0.45, NO ask=0.45 => total cost 0.90 < 1
      const result = checkArbitrage(0.45, 0.45, 0.40, 0.40);
      expect(result).not.toBeNull();
      expect(result?.type).toBe('long');
      expect(result?.profit).toBeCloseTo(0.1, 2);
    });

    it('should prioritize long arb when both exist', () => {
      // Due to Polymarket's mirroring, if one arb exists, the other often does too
      // The function prioritizes long arb (checks first)
      // With low asks, we get long arb opportunity
      const result = checkArbitrage(0.45, 0.45, 0.40, 0.40);
      expect(result).not.toBeNull();
      // Long arb is checked first and returned
      expect(result?.type).toBe('long');
      expect(result?.profit).toBeGreaterThan(0);
    });

    it('should return null when no arbitrage', () => {
      // Normal spread, no arbitrage
      const result = checkArbitrage(0.55, 0.45, 0.55, 0.45);
      expect(result).toBeNull();
    });

    it('can reject a gross opportunity after estimated fees', () => {
      const gross = checkArbitrage(0.495, 0.495, 0.48, 0.48);
      expect(gross?.profit).toBeCloseTo(0.01, 10);

      const net = checkArbitrageWithFees(0.495, 0.495, 0.48, 0.48, {
        size: 10,
        rate: 0.03,
      });
      expect(net).toBeNull();
    });

    it('keeps long priority when both net paths survive fees', () => {
      const result = checkArbitrageWithFees(0.53, 0.53, 0.52, 0.52, {
        size: 10,
        rate: 0.003,
      });

      expect(result?.type).toBe('long');
      expect(result?.grossProfit).toBeCloseTo(0.4, 10);
      expect(result?.netProfit).toBeGreaterThan(0.38);
    });
  });

  describe('formatPrice', () => {
    it('should format with default decimals', () => {
      expect(formatPrice(0.5)).toBe('0.5000');
      expect(formatPrice(0.123456)).toBe('0.1235');
    });

    it('should respect tick size', () => {
      expect(formatPrice(0.5, '0.1')).toBe('0.5');
      expect(formatPrice(0.5, '0.01')).toBe('0.50');
      expect(formatPrice(0.5, '0.001')).toBe('0.500');
    });
  });

  describe('formatUSDC', () => {
    it('should format as USD', () => {
      expect(formatUSDC(10)).toBe('$10.00');
      expect(formatUSDC(1234.567)).toBe('$1234.57');
    });
  });

  describe('calculatePnL', () => {
    it('should calculate long PnL correctly', () => {
      const result = calculatePnL(0.4, 0.6, 10, 'long');
      expect(result.pnl).toBeCloseTo(2, 10); // (0.6 - 0.4) * 10
      expect(result.pnlPercent).toBeCloseTo(50, 10); // 50% gain
    });

    it('should calculate short PnL correctly', () => {
      const result = calculatePnL(0.6, 0.4, 10, 'short');
      expect(result.pnl).toBeCloseTo(2, 10); // (0.6 - 0.4) * 10
      expect(result.pnlPercent).toBeCloseTo(33.33, 1); // ~33% gain
    });

    it('should handle losses', () => {
      const result = calculatePnL(0.6, 0.4, 10, 'long');
      expect(result.pnl).toBeCloseTo(-2, 10); // Loss
      expect(result.pnlPercent).toBeCloseTo(-33.33, 1);
    });
  });

  describe('ROUNDING_CONFIG', () => {
    it('should have correct configuration for all tick sizes', () => {
      expect(ROUNDING_CONFIG['0.1']).toEqual({ price: 1, size: 2, amount: 2 });
      expect(ROUNDING_CONFIG['0.01']).toEqual({ price: 2, size: 2, amount: 4 });
      expect(ROUNDING_CONFIG['0.001']).toEqual({ price: 3, size: 2, amount: 5 });
      expect(ROUNDING_CONFIG['0.0001']).toEqual({ price: 4, size: 2, amount: 6 });
    });
  });
});
