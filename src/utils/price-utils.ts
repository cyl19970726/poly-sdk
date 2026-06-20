/**
 * Price Utilities for Polymarket Trading
 *
 * Provides helpers for:
 * - Price validation and rounding to tick size
 * - Size validation
 * - Order amount calculation
 */

// Tick size types (as defined by Polymarket)
export type TickSize = '0.1' | '0.01' | '0.001' | '0.0001';

// Rounding configuration for each tick size
export const ROUNDING_CONFIG: Record<
  TickSize,
  { price: number; size: number; amount: number }
> = {
  '0.1': { price: 1, size: 2, amount: 2 },
  '0.01': { price: 2, size: 2, amount: 4 },
  '0.001': { price: 3, size: 2, amount: 5 },
  '0.0001': { price: 4, size: 2, amount: 6 },
};

/**
 * Round a price to the appropriate tick size
 *
 * @param price - The price to round (0 to 1)
 * @param tickSize - The tick size for the market
 * @param direction - 'floor' for sells, 'ceil' for buys, 'round' for midpoint
 * @returns Rounded price
 *
 * @example
 * roundPrice(0.523, '0.01', 'floor') // 0.52
 * roundPrice(0.523, '0.01', 'ceil') // 0.53
 */
export function roundPrice(
  price: number,
  tickSize: TickSize,
  direction: 'floor' | 'ceil' | 'round' = 'round'
): number {
  const decimals = ROUNDING_CONFIG[tickSize].price;
  const multiplier = Math.pow(10, decimals);

  let rounded: number;
  switch (direction) {
    case 'floor':
      rounded = Math.floor(price * multiplier) / multiplier;
      break;
    case 'ceil':
      rounded = Math.ceil(price * multiplier) / multiplier;
      break;
    default:
      rounded = Math.round(price * multiplier) / multiplier;
  }

  // Clamp to valid price range
  return Math.max(0.001, Math.min(0.999, rounded));
}

/**
 * Round a size to valid decimals (always 2 decimal places)
 */
export function roundSize(size: number): number {
  return Math.round(size * 100) / 100;
}

/**
 * Validate a price is within valid range and tick size
 *
 * @param price - The price to validate
 * @param tickSize - The tick size for the market
 * @returns Validation result with error message if invalid
 */
export function validatePrice(
  price: number,
  tickSize: TickSize
): { valid: boolean; error?: string } {
  // Check range
  if (price < 0.001 || price > 0.999) {
    return { valid: false, error: 'Price must be between 0.001 and 0.999' };
  }

  // Check tick size alignment
  const decimals = ROUNDING_CONFIG[tickSize].price;
  const multiplier = Math.pow(10, decimals);
  const rounded = Math.round(price * multiplier) / multiplier;

  if (Math.abs(price - rounded) > 1e-10) {
    return {
      valid: false,
      error: `Price ${price} does not align with tick size ${tickSize}. Use ${rounded} instead.`,
    };
  }

  return { valid: true };
}

/**
 * Validate minimum size requirements
 *
 * @param size - The size to validate
 * @param minOrderSize - Minimum order size from market config (usually 0.1)
 */
export function validateSize(
  size: number,
  minOrderSize = 0.1
): { valid: boolean; error?: string } {
  if (size < minOrderSize) {
    return {
      valid: false,
      error: `Size ${size} is below minimum order size ${minOrderSize}`,
    };
  }

  return { valid: true };
}

/**
 * Calculate the amount needed for a buy order (in USDC)
 *
 * @param price - Price per share
 * @param size - Number of shares to buy
 * @returns Amount in USDC
 */
export function calculateBuyAmount(price: number, size: number): number {
  return price * size;
}

/**
 * Calculate the payout for a sell order (in USDC)
 *
 * @param price - Price per share
 * @param size - Number of shares to sell
 * @returns Amount in USDC
 */
export function calculateSellPayout(price: number, size: number): number {
  return price * size;
}

// ============================================================================
// Fee estimation
// ============================================================================

export type LiquidityRole = 'maker' | 'taker';
export type FeeSide = 'BUY' | 'SELL';

export interface FeeCurve {
  /** Dynamic fee coefficient from CLOB market info (`fd.r`). */
  rate: number;
  /** Fee curve exponent from CLOB market info (`fd.e`). Defaults to 1. */
  exponent?: number;
  /** Whether platform fees apply only to taker fills (`fd.to`). Defaults to true. */
  takerOnly?: boolean;
}

export interface BuilderFeeRates {
  /** Builder maker fee in basis points. Defaults to 0. */
  makerBps?: number;
  /** Builder taker fee in basis points. Defaults to 0. */
  takerBps?: number;
}

export interface OrderFeeEstimateParams extends FeeCurve, BuilderFeeRates {
  side: FeeSide;
  price: number;
  size: number;
  /** Whether this order is expected to add or remove liquidity. Defaults to taker. */
  liquidityRole?: LiquidityRole;
}

export interface OrderFeeEstimate {
  side: FeeSide;
  price: number;
  size: number;
  notional: number;
  liquidityRole: LiquidityRole;
  platformFee: number;
  builderFee: number;
  totalFee: number;
  /** BUY: notional + fees; SELL: zero because proceeds are modeled separately. */
  totalCost: number;
  /** SELL: notional - fees; BUY: zero because cost is modeled separately. */
  netProceeds: number;
}

export interface BinaryArbitrageFeeParams extends FeeCurve, BuilderFeeRates {
  type: 'long' | 'short';
  size: number;
  yesPrice: number;
  noPrice: number;
  /** Execution role for the two CLOB legs. Defaults to taker. */
  liquidityRole?: LiquidityRole;
}

export interface BinaryArbitrageFeeEstimate {
  type: 'long' | 'short';
  size: number;
  grossProfit: number;
  grossProfitPerShare: number;
  totalFees: number;
  netProfit: number;
  netProfitPerShare: number;
  legs: {
    yes: OrderFeeEstimate;
    no: OrderFeeEstimate;
  };
}

export interface MultiLegArbitrageLegInput extends FeeCurve, BuilderFeeRates {
  price: number;
  /** Optional label for diagnostics, such as outcome name. */
  label?: string;
  tokenId?: string;
  conditionId?: string;
}

export interface MultiLegArbitrageFeeParams {
  type: 'long' | 'short';
  size: number;
  legs: MultiLegArbitrageLegInput[];
  /** Execution role for all CLOB legs. Defaults to taker. */
  liquidityRole?: LiquidityRole;
}

export interface MultiLegArbitrageLegEstimate extends MultiLegArbitrageLegInput {
  estimate: OrderFeeEstimate;
}

export interface MultiLegArbitrageFeeEstimate {
  type: 'long' | 'short';
  size: number;
  priceSum: number;
  grossProfit: number;
  grossProfitPerShare: number;
  totalFees: number;
  netProfit: number;
  netProfitPerShare: number;
  legs: MultiLegArbitrageLegEstimate[];
}

export interface FeeAwareArbitrageResult {
  type: 'long' | 'short';
  grossProfit: number;
  grossProfitPerShare: number;
  totalFees: number;
  netProfit: number;
  netProfitPerShare: number;
  description: string;
}

function roundFee(fee: number): number {
  if (!Number.isFinite(fee) || fee <= 0) return 0;
  const rounded = Math.round(fee * 100000) / 100000;
  return rounded < 0.00001 ? 0 : rounded;
}

/**
 * Estimate the platform fee charged by Polymarket at match time.
 *
 * Official formula: `fee = size * rate * p * (1 - p)`.
 * `exponent` is included because CLOB market info exposes it as `fd.e`; current
 * markets generally use `1`, which reduces to the documented formula.
 */
export function calculatePlatformFee(
  price: number,
  size: number,
  feeCurve: FeeCurve,
  liquidityRole: LiquidityRole = 'taker'
): number {
  const takerOnly = feeCurve.takerOnly ?? true;
  if (takerOnly && liquidityRole !== 'taker') return 0;

  const rate = feeCurve.rate || 0;
  const exponent = feeCurve.exponent ?? 1;
  const uncertainty = Math.max(0, price * (1 - price));
  return roundFee(size * rate * Math.pow(uncertainty, exponent));
}

/**
 * Estimate additive builder fees. Builder fees are flat bps on trade notional.
 */
export function calculateBuilderFee(
  notional: number,
  builderFees: BuilderFeeRates = {},
  liquidityRole: LiquidityRole = 'taker'
): number {
  const bps = liquidityRole === 'maker'
    ? builderFees.makerBps ?? 0
    : builderFees.takerBps ?? 0;
  return roundFee(notional * bps / 10000);
}

/**
 * Estimate all fees for one order leg and return cost/proceeds after fees.
 */
export function estimateOrderFees(params: OrderFeeEstimateParams): OrderFeeEstimate {
  const liquidityRole = params.liquidityRole ?? 'taker';
  const notional = params.price * params.size;
  const platformFee = calculatePlatformFee(
    params.price,
    params.size,
    params,
    liquidityRole
  );
  const builderFee = calculateBuilderFee(notional, params, liquidityRole);
  const totalFee = roundFee(platformFee + builderFee);

  return {
    side: params.side,
    price: params.price,
    size: params.size,
    notional,
    liquidityRole,
    platformFee,
    builderFee,
    totalFee,
    totalCost: params.side === 'BUY' ? notional + totalFee : 0,
    netProceeds: params.side === 'SELL' ? notional - totalFee : 0,
  };
}

/**
 * Estimate net profit for a two-leg binary arbitrage path.
 *
 * Long: buy YES + NO, then merge/redeem the complete set for 1 pUSD/share.
 * Short: split/mint a complete set, then sell YES + NO.
 */
export function estimateBinaryArbitrageFees(
  params: BinaryArbitrageFeeParams
): BinaryArbitrageFeeEstimate {
  const side: FeeSide = params.type === 'long' ? 'BUY' : 'SELL';
  const yes = estimateOrderFees({ ...params, side, price: params.yesPrice });
  const no = estimateOrderFees({ ...params, side, price: params.noPrice });
  const totalFees = roundFee(yes.totalFee + no.totalFee);
  const grossProfitPerShare = params.type === 'long'
    ? 1 - (params.yesPrice + params.noPrice)
    : (params.yesPrice + params.noPrice) - 1;
  const grossProfit = grossProfitPerShare * params.size;
  const netProfit = grossProfit - totalFees;

  return {
    type: params.type,
    size: params.size,
    grossProfit,
    grossProfitPerShare,
    totalFees,
    netProfit,
    netProfitPerShare: netProfit / params.size,
    legs: { yes, no },
  };
}

/**
 * Estimate net profit for an exhaustive multi-outcome set.
 *
 * Long: buy every listed winning outcome, then the set pays 1 pUSD/share.
 * Short: mint/sell every listed winning outcome, then reserve 1 pUSD/share.
 *
 * The caller must validate that the legs form a mutually exclusive and
 * exhaustive event set. This helper only aggregates prices and per-leg fees.
 */
export function estimateMultiLegArbitrageFees(
  params: MultiLegArbitrageFeeParams
): MultiLegArbitrageFeeEstimate {
  if (params.size <= 0) {
    throw new Error('size must be positive');
  }
  if (params.legs.length < 2) {
    throw new Error('at least two legs are required');
  }

  const side: FeeSide = params.type === 'long' ? 'BUY' : 'SELL';
  const legs = params.legs.map((leg) => ({
    ...leg,
    estimate: estimateOrderFees({
      ...leg,
      side,
      size: params.size,
      liquidityRole: params.liquidityRole,
    }),
  }));
  const priceSum = legs.reduce((sum, leg) => sum + leg.price, 0);
  const totalFees = roundFee(
    legs.reduce((sum, leg) => sum + leg.estimate.totalFee, 0)
  );
  const grossProfitPerShare = params.type === 'long'
    ? 1 - priceSum
    : priceSum - 1;
  const grossProfit = grossProfitPerShare * params.size;
  const netProfit = grossProfit - totalFees;

  return {
    type: params.type,
    size: params.size,
    priceSum,
    grossProfit,
    grossProfitPerShare,
    totalFees,
    netProfit,
    netProfitPerShare: netProfit / params.size,
    legs,
  };
}

/**
 * Calculate number of shares that can be bought with a given amount
 *
 * @param amount - USDC amount to spend
 * @param price - Price per share
 * @returns Number of shares
 */
export function calculateSharesForAmount(
  amount: number,
  price: number
): number {
  return roundSize(amount / price);
}

/**
 * Calculate the spread between bid and ask
 *
 * @param bid - Highest bid price
 * @param ask - Lowest ask price
 * @returns Spread as a decimal (0 to 1)
 */
export function calculateSpread(bid: number, ask: number): number {
  return ask - bid;
}

/**
 * Calculate the midpoint price between bid and ask
 *
 * @param bid - Highest bid price
 * @param ask - Lowest ask price
 * @returns Midpoint price
 */
export function calculateMidpoint(bid: number, ask: number): number {
  return (bid + ask) / 2;
}

/**
 * 计算有效价格（考虑 Polymarket 订单簿的镜像特性）
 *
 * Polymarket 的关键特性：买 YES @ P = 卖 NO @ (1-P)
 * 因此互补流动性在经济上等价。不要假设 API 快照中每一笔订单都
 * 以完全同步、完全去重的形式出现在两个订单簿里。
 *
 * 有效价格是考虑镜像后的最优价格
 *
 * @param yesAsk - YES token 的最低卖价
 * @param yesBid - YES token 的最高买价
 * @param noAsk - NO token 的最低卖价
 * @param noBid - NO token 的最高买价
 */
export function getEffectivePrices(
  yesAsk: number,
  yesBid: number,
  noAsk: number,
  noBid: number
): {
  effectiveBuyYes: number;
  effectiveBuyNo: number;
  effectiveSellYes: number;
  effectiveSellNo: number;
} {
  return {
    // 买 YES: 直接买 YES.ask 或 通过卖 NO (成本 = 1 - NO.bid)
    effectiveBuyYes: Math.min(yesAsk, 1 - noBid),

    // 买 NO: 直接买 NO.ask 或 通过卖 YES (成本 = 1 - YES.bid)
    effectiveBuyNo: Math.min(noAsk, 1 - yesBid),

    // 卖 YES: 直接卖 YES.bid 或 通过买 NO (收入 = 1 - NO.ask)
    effectiveSellYes: Math.max(yesBid, 1 - noAsk),

    // 卖 NO: 直接卖 NO.bid 或 通过买 YES (收入 = 1 - YES.ask)
    effectiveSellNo: Math.max(noBid, 1 - yesAsk),
  };
}

/**
 * Check if there's an arbitrage opportunity
 *
 * 使用有效价格计算套利机会（正确考虑镜像订单）
 *
 * Long arb: Buy YES + Buy NO < 1 (使用有效买入价格)
 * Short arb: Sell YES + Sell NO > 1 (使用有效卖出价格)
 *
 * 详细文档见: docs/01-polymarket-orderbook-arbitrage.md
 *
 * @param yesAsk - Lowest ask for YES token
 * @param noAsk - Lowest ask for NO token
 * @param yesBid - Highest bid for YES token
 * @param noBid - Highest bid for NO token
 * @returns Arbitrage info or null
 */
export function checkArbitrage(
  yesAsk: number,
  noAsk: number,
  yesBid: number,
  noBid: number
): { type: 'long' | 'short'; profit: number; description: string } | null {
  // 计算有效价格
  const effective = getEffectivePrices(yesAsk, yesBid, noAsk, noBid);

  // Long arbitrage: Buy complete set (YES + NO) cheaper than $1
  const effectiveLongCost = effective.effectiveBuyYes + effective.effectiveBuyNo;
  const longProfit = 1 - effectiveLongCost;

  if (longProfit > 0) {
    return {
      type: 'long',
      profit: longProfit,
      description: `Buy YES @ ${effective.effectiveBuyYes.toFixed(4)} + NO @ ${effective.effectiveBuyNo.toFixed(4)}, Merge for $1`,
    };
  }

  // Short arbitrage: Sell complete set (YES + NO) for more than $1
  const effectiveShortRevenue = effective.effectiveSellYes + effective.effectiveSellNo;
  const shortProfit = effectiveShortRevenue - 1;

  if (shortProfit > 0) {
    return {
      type: 'short',
      profit: shortProfit,
      description: `Split $1, Sell YES @ ${effective.effectiveSellYes.toFixed(4)} + NO @ ${effective.effectiveSellNo.toFixed(4)}`,
    };
  }

  return null;
}

/**
 * Fee-aware arbitrage check using the same effective-price normalization as
 * `checkArbitrage()`, but returning net profitability after estimated fees.
 */
export function checkArbitrageWithFees(
  yesAsk: number,
  noAsk: number,
  yesBid: number,
  noBid: number,
  params: Omit<BinaryArbitrageFeeParams, 'type' | 'yesPrice' | 'noPrice'>
): FeeAwareArbitrageResult | null {
  const effective = getEffectivePrices(yesAsk, yesBid, noAsk, noBid);

  const long = estimateBinaryArbitrageFees({
    ...params,
    type: 'long',
    yesPrice: effective.effectiveBuyYes,
    noPrice: effective.effectiveBuyNo,
  });
  if (long.netProfit > 0) {
    return {
      type: 'long',
      grossProfit: long.grossProfit,
      grossProfitPerShare: long.grossProfitPerShare,
      totalFees: long.totalFees,
      netProfit: long.netProfit,
      netProfitPerShare: long.netProfitPerShare,
      description: `Buy YES @ ${effective.effectiveBuyYes.toFixed(4)} + NO @ ${effective.effectiveBuyNo.toFixed(4)}, estimated net ${long.netProfit.toFixed(5)} pUSD`,
    };
  }

  const short = estimateBinaryArbitrageFees({
    ...params,
    type: 'short',
    yesPrice: effective.effectiveSellYes,
    noPrice: effective.effectiveSellNo,
  });
  if (short.netProfit > 0) {
    return {
      type: 'short',
      grossProfit: short.grossProfit,
      grossProfitPerShare: short.grossProfitPerShare,
      totalFees: short.totalFees,
      netProfit: short.netProfit,
      netProfitPerShare: short.netProfitPerShare,
      description: `Sell YES @ ${effective.effectiveSellYes.toFixed(4)} + NO @ ${effective.effectiveSellNo.toFixed(4)}, estimated net ${short.netProfit.toFixed(5)} pUSD`,
    };
  }

  return null;
}

/**
 * Format price for display
 */
export function formatPrice(price: number, tickSize?: TickSize): string {
  const decimals = tickSize ? ROUNDING_CONFIG[tickSize].price : 4;
  return price.toFixed(decimals);
}

/**
 * Format amount in USDC
 */
export function formatUSDC(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

/**
 * Calculate PnL for a position
 *
 * @param entryPrice - Average entry price
 * @param currentPrice - Current market price
 * @param size - Position size
 * @param side - 'long' for YES, 'short' for NO
 */
export function calculatePnL(
  entryPrice: number,
  currentPrice: number,
  size: number,
  side: 'long' | 'short' = 'long'
): { pnl: number; pnlPercent: number } {
  const pnl =
    side === 'long'
      ? (currentPrice - entryPrice) * size
      : (entryPrice - currentPrice) * size;

  const pnlPercent =
    side === 'long'
      ? ((currentPrice - entryPrice) / entryPrice) * 100
      : ((entryPrice - currentPrice) / entryPrice) * 100;

  return { pnl, pnlPercent };
}
