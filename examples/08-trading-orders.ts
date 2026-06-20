/**
 * Example 08: Trading Orders
 *
 * Demonstrates trading functionality using TradingService and MarketService:
 * - Market data fetching via MarketService (getMarket, getProcessedOrderbook, getPricesHistory)
 * - Limit orders (GTC, GTD)
 * - Market orders (FOK, FAK)
 * - Order management
 * - Price utilities
 * - Rewards tracking
 *
 * NOTE: This example does NOT execute real trades.
 * Uncomment the order sections to test with real funds.
 */

import {
  TradingService,
  RateLimiter,
  PolymarketSDK,
  roundPrice,
  validatePrice,
  calculateBuyAmount,
  checkArbitrage,
  formatUSDC,
  getBinaryTokens,
  createUnifiedCache,
  type TickSize,
} from '../src/index.js';

// Test wallet private key (empty wallet for safety)
const PRIVATE_KEY = process.env.POLYMARKET_PRIVATE_KEY || '0xYOUR_PRIVATE_KEY_HERE';
const SIGNATURE_TYPE = Number(process.env.POLYMARKET_SIGNATURE_TYPE || '0') as 0 | 1 | 2;
const FUNDER_ADDRESS = process.env.POLYMARKET_FUNDER || '';

async function main() {
  console.log('=== Polymarket Trading Examples (TradingService) ===\n');

  // Initialize SDK and TradingService
  const sdk = new PolymarketSDK();
  const rateLimiter = new RateLimiter();
  const cache = createUnifiedCache();
  const tradingService = new TradingService(rateLimiter, cache, {
    privateKey: PRIVATE_KEY,
    signatureType: SIGNATURE_TYPE,
    funderAddress: FUNDER_ADDRESS || undefined,
  });

  // ===== 1. Find an Active Market =====
  console.log('1. Finding active markets...\n');

  const markets = await sdk.gammaApi.getMarkets({
    closed: false,
    active: true,
    limit: 5,
  });

  if (markets.length === 0) {
    console.log('   No active markets found');
    return;
  }

  const gammaMarket = markets[0];
  console.log(`   Market: ${gammaMarket.question?.slice(0, 60)}...`);
  console.log(`   Condition ID: ${gammaMarket.conditionId}`);

  // Get market details using TradingService
  try {
    await tradingService.initialize();
  } catch {
    console.log('   TradingService initialization skipped (no valid private key)');
    console.log('   Using SDK for market data...\n');
  }

  // Get market data from CLOB via MarketService (no private key required)
  const market = await sdk.markets.getClobMarket(gammaMarket.conditionId);
  const binary = market ? getBinaryTokens(market.tokens) : null;

  if (!binary) {
    console.log('   Could not find a binary token pair');
    return;
  }
  const [yesOutcome, noOutcome] = binary.outcomes;
  const yesToken = binary.primary;
  const noToken = binary.secondary;

  console.log(`   YES Token (${yesOutcome}): ${yesToken.tokenId.slice(0, 20)}...`);
  console.log(`   NO Token (${noOutcome}): ${noToken.tokenId.slice(0, 20)}...`);
  console.log(`   YES Price (${yesOutcome}): $${yesToken.price}`);
  console.log(`   NO Price (${noOutcome}): $${noToken.price}`);

  // ===== 2. Price Utilities Demo =====
  console.log('\n2. Price Utilities Demo\n');

  // Get tick size for the market
  const tickSize: TickSize = '0.01'; // Most markets use 0.01

  // Round prices to tick size
  const rawPrice = 0.523;
  console.log(`   Raw price: ${rawPrice}`);
  console.log(`   Rounded (floor): ${roundPrice(rawPrice, tickSize, 'floor')}`);
  console.log(`   Rounded (ceil): ${roundPrice(rawPrice, tickSize, 'ceil')}`);
  console.log(`   Rounded (round): ${roundPrice(rawPrice, tickSize, 'round')}`);

  // Validate prices
  const validation = validatePrice(0.525, tickSize);
  console.log(`   Price 0.525 valid: ${validation.valid}`);

  const invalidValidation = validatePrice(0.5233, tickSize);
  console.log(`   Price 0.5233 valid: ${invalidValidation.valid}`);
  if (!invalidValidation.valid) {
    console.log(`   Error: ${invalidValidation.error}`);
  }

  // Calculate order amounts
  const price = 0.52;
  const size = 100;
  const amount = calculateBuyAmount(price, size);
  console.log(`\n   Order: BUY ${size} YES (${yesOutcome}) @ $${price}`);
  console.log(`   Cost: ${formatUSDC(amount)}`);

  // ===== 3. Arbitrage Detection =====
  console.log('\n3. Arbitrage Detection\n');

  // Get current orderbook via MarketService (no private key required)
  const orderbook = await sdk.markets.getProcessedOrderbook(gammaMarket.conditionId);

  console.log(`   YES (${yesOutcome}): Bid $${orderbook.yes.bid} / Ask $${orderbook.yes.ask}`);
  console.log(`   NO (${noOutcome}): Bid $${orderbook.no.bid} / Ask $${orderbook.no.ask}`);

  const arb = checkArbitrage(
    orderbook.yes.ask,
    orderbook.no.ask,
    orderbook.yes.bid,
    orderbook.no.bid
  );

  if (arb) {
    console.log(`\n   ARBITRAGE DETECTED!`);
    console.log(`   Type: ${arb.type}`);
    console.log(`   Profit: ${formatUSDC(arb.profit)}`);
  } else {
    console.log(`   No arbitrage opportunity`);
    console.log(`   Long cost: $${(orderbook.yes.ask + orderbook.no.ask).toFixed(4)}`);
    console.log(`   Short revenue: $${(orderbook.yes.bid + orderbook.no.bid).toFixed(4)}`);
  }

  // ===== 3.5 Price History Demo =====
  console.log('\n3.5. Price History (MarketService)\n');

  try {
    const priceHistory = await sdk.markets.getPricesHistory({
      tokenId: yesToken.tokenId,
      interval: '1d',
    });
    console.log(`   Got ${priceHistory.length} price points for YES token (${yesOutcome})`);
    if (priceHistory.length > 0) {
      const latest = priceHistory[priceHistory.length - 1];
      console.log(`   Latest: ${new Date(latest.timestamp * 1000).toLocaleDateString()} @ $${latest.price.toFixed(4)}`);
    }
  } catch (e) {
    console.log(`   Price history unavailable: ${e}`);
  }

  // ===== 4. Trading Service Status =====
  console.log('\n4. TradingService Status...\n');

  if (!tradingService.isInitialized()) {
    console.log(`   Initialization skipped (no valid private key)`);
    console.log(`   Set POLYMARKET_PRIVATE_KEY to test trading`);
    return;
  }

  console.log(`   Wallet: ${tradingService.getAddress()}`);
  console.log(`   Initialized: ${tradingService.isInitialized()}`);

  const creds = tradingService.getCredentials();
  if (creds) {
    console.log(`   API Key: ${creds.key.slice(0, 20)}...`);
  }

  // ===== 5. Get Existing Orders and Trades =====
  console.log('\n5. Getting existing orders and trades...\n');

  const openOrders = await tradingService.getOpenOrders();
  console.log(`   Open orders: ${openOrders.length}`);

  const trades = await tradingService.getTrades();
  console.log(`   Total trades: ${trades.length}`);

  if (trades.length > 0) {
    console.log('\n   Recent trades:');
    for (const t of trades.slice(0, 3)) {
      console.log(`   - ${t.side} ${t.size} @ $${t.price.toFixed(4)}`);
    }
  }

  // ===== 6. Order Types Demo =====
  console.log('\n6. Order Types (Not Executed)\n');

  console.log('   --- LIMIT ORDERS ---');
  console.log('   GTC (Good-Til-Cancelled):');
  console.log('   - Stays on book until filled or cancelled');
  console.log('   - Best for passive orders at your target price');
  console.log(`
   tradingService.createLimitOrder({
     tokenId: '${yesToken.tokenId.slice(0, 20)}...',
     side: 'BUY',
     price: 0.45,
     size: 10,
     orderType: 'GTC',
   });
`);

  console.log('   GTD (Good-Til-Date):');
  console.log('   - Auto-expires at specified timestamp');
  console.log('   - Good for time-sensitive strategies');
  console.log(`
   tradingService.createLimitOrder({
     tokenId: '${yesToken.tokenId.slice(0, 20)}...',
     side: 'BUY',
     price: 0.45,
     size: 10,
     orderType: 'GTD',
     expiration: Math.floor(Date.now() / 1000) + 3600, // 1 hour
   });
`);

  console.log('   --- MARKET ORDERS ---');
  console.log('   FOK (Fill-Or-Kill):');
  console.log('   - Must fill entirely or not at all');
  console.log('   - Best for guaranteed execution');
  console.log(`
   tradingService.createMarketOrder({
     tokenId: '${yesToken.tokenId.slice(0, 20)}...',
     side: 'BUY',
     amount: 10, // $10 USDC for BUY
     orderType: 'FOK',
   });
`);

  console.log('   FAK (Fill-And-Kill):');
  console.log('   - Fill what you can, cancel the rest');
  console.log('   - Good for partial fills');
  console.log(`
   tradingService.createMarketOrder({
     tokenId: '${yesToken.tokenId.slice(0, 20)}...',
     side: 'SELL',
     amount: 10, // 10 shares for SELL
     orderType: 'FAK',
   });
`);

  // ===== 7. Rewards Demo =====
  console.log('\n7. Rewards (Market Making Incentives)\n');

  try {
    // Get current reward programs
    const rewards = await tradingService.getCurrentRewards();
    console.log(`   Active reward programs: ${rewards.length}`);

    if (rewards.length > 0) {
      const reward = rewards[0];
      console.log(`\n   Example reward market:`);
      console.log(`   - Question: ${reward.question?.slice(0, 50)}...`);
      console.log(`   - Max Spread: ${reward.rewardsMaxSpread}`);
      console.log(`   - Min Size: ${reward.rewardsMinSize}`);

      if (reward.rewardsConfig.length > 0) {
        const config = reward.rewardsConfig[0];
        console.log(`   - Rate/Day: ${config.ratePerDay}`);
        console.log(`   - Total Pool: ${config.totalRewards}`);
      }
    }

    // Check if orders are scoring (need actual order IDs)
    if (openOrders.length > 0) {
      const orderId = openOrders[0].id;
      const isScoring = await tradingService.isOrderScoring(orderId);
      console.log(`\n   Order ${orderId.slice(0, 20)}... scoring: ${isScoring}`);
    }

    // Get yesterday's earnings
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const dateStr = yesterday.toISOString().split('T')[0];

    const earnings = await tradingService.getEarningsForDay(dateStr);
    const totalEarnings = earnings.reduce((sum, e) => sum + e.earnings, 0);
    console.log(`\n   Earnings for ${dateStr}:`);
    console.log(`   Total: ${formatUSDC(totalEarnings)}`);
  } catch (error) {
    console.log(`   Rewards data not available (requires valid trading history)`);
  }

  // ===== 8. Balance Check =====
  console.log('\n8. Balance Check\n');

  try {
    const balance = await tradingService.getBalanceAllowance('COLLATERAL');
    console.log(`   USDC Balance: ${balance.balance}`);
    console.log(`   USDC Allowance: ${balance.allowance}`);
  } catch (error) {
    console.log(`   Balance check failed (requires initialized wallet)`);
  }

  console.log('\n=== Example Complete ===');
  console.log('\nTo execute real trades:');
  console.log('1. Set POLYMARKET_PRIVATE_KEY environment variable');
  console.log('2. Deposit USDC to your Polymarket proxy wallet');
  console.log('3. Uncomment the order placement code in this file');
}

main().catch(console.error);
