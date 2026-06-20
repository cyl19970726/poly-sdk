/**
 * Example 13: Trending Markets Arbitrage Monitor
 *
 * Real-time monitoring of trending Polymarket markets for arbitrage opportunities.
 *
 * IMPORTANT: Understanding Polymarket Orderbook
 * =============================================
 * Polymarket 订单簿的关键特性：买 YES @ P = 卖 NO @ (1-P)
 * 因此互补流动性在经济上等价。API 快照不应被假设为逐笔完全镜像。
 *
 * 正确的套利计算必须使用"有效价格"：
 * - effectiveBuyYes = min(YES.ask, 1 - NO.bid)
 * - effectiveBuyNo = min(NO.ask, 1 - YES.bid)
 * - effectiveSellYes = max(YES.bid, 1 - NO.ask)
 * - effectiveSellNo = max(NO.bid, 1 - YES.ask)
 *
 * 详细文档见: docs/01-polymarket-orderbook-arbitrage.md
 *
 * Features:
 * - Fetches trending markets from Gamma API
 * - Continuously monitors orderbooks for arb opportunities
 * - Uses correct effective price calculations
 * - Detailed logging for debugging and analysis
 * - Configurable scan interval and profit thresholds
 *
 * Run with:
 *   pnpm example:trending-arb
 *
 * Environment variables:
 *   SCAN_INTERVAL_MS - Scan interval in ms (default: 5000)
 *   MIN_PROFIT_THRESHOLD - Minimum profit % (default: 0.1)
 *   MAX_MARKETS - Max markets to monitor (default: 20)
 */

import { PolymarketSDK, checkArbitrage, getEffectivePrices } from '../src/index.js';

// ===== Configuration =====
const CONFIG = {
  scanIntervalMs: parseInt(process.env.SCAN_INTERVAL_MS || '5000'),
  minProfitThreshold: parseFloat(process.env.MIN_PROFIT_THRESHOLD || '0.1') / 100, // Convert % to decimal
  maxMarkets: parseInt(process.env.MAX_MARKETS || '20'),
  refreshMarketsIntervalMs: 60000, // Refresh trending markets every minute
  maxCycles: parseInt(process.env.MAX_CYCLES || '0'), // 0 = unlimited
};

// ===== Logging Utilities =====
function log(level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG' | 'SUCCESS', message: string, data?: unknown) {
  const timestamp = new Date().toISOString();
  const prefix = {
    'INFO': '📋',
    'WARN': '⚠️',
    'ERROR': '❌',
    'DEBUG': '🔍',
    'SUCCESS': '✅',
  }[level];

  console.log(`[${timestamp}] ${prefix} [${level}] ${message}`);
  if (data !== undefined) {
    if (typeof data === 'object') {
      console.log(JSON.stringify(data, null, 2));
    } else {
      console.log(`   → ${data}`);
    }
  }
}

function logSeparator(title?: string) {
  if (title) {
    console.log(`\n${'═'.repeat(20)} ${title} ${'═'.repeat(20)}`);
  } else {
    console.log('─'.repeat(60));
  }
}

// ===== Types =====
interface MonitoredMarket {
  conditionId: string;
  question: string;
  slug: string;
  volume24h: number;
  lastUpdate: number;
  lastEffectiveLongCost?: number;
  lastEffectiveShortRevenue?: number;
  scanCount: number;
  errorCount: number;
}

interface ScanResult {
  timestamp: number;
  market: MonitoredMarket;
  yesAsk: number;
  noAsk: number;
  yesBid: number;
  noBid: number;
  // Effective prices (考虑镜像订单)
  effectiveBuyYes: number;
  effectiveBuyNo: number;
  effectiveSellYes: number;
  effectiveSellNo: number;
  effectiveLongCost: number;
  effectiveShortRevenue: number;
  longArbProfit: number;
  shortArbProfit: number;
  yesSpread: number;
  hasOpportunity: boolean;
  opportunityType?: 'long' | 'short';
}

// ===== Monitor State =====
let markets: MonitoredMarket[] = [];
let scanCount = 0;
let opportunitiesFound = 0;
let totalScans = 0;
let lastMarketRefresh = 0;

// ===== Main Functions =====

async function fetchTrendingMarkets(sdk: PolymarketSDK): Promise<MonitoredMarket[]> {
  log('INFO', `Fetching top ${CONFIG.maxMarkets} trending markets...`);

  try {
    const trendingMarkets = await sdk.gammaApi.getTrendingMarkets(CONFIG.maxMarkets);

    const monitored: MonitoredMarket[] = trendingMarkets
      .filter(m => m.conditionId)
      .map(m => ({
        conditionId: m.conditionId,
        question: m.question || 'Unknown',
        slug: m.slug || '',
        volume24h: m.volume24hr || 0,
        lastUpdate: Date.now(),
        scanCount: 0,
        errorCount: 0,
      }));

    log('SUCCESS', `Loaded ${monitored.length} trending markets`);

    // Log market details
    monitored.forEach((m, i) => {
      log('DEBUG', `  ${i + 1}. ${m.question.slice(0, 50)}...`, {
        conditionId: m.conditionId.slice(0, 20) + '...',
        volume24h: `$${m.volume24h.toLocaleString()}`,
      });
    });

    return monitored;
  } catch (error) {
    log('ERROR', 'Failed to fetch trending markets', error instanceof Error ? error.message : error);
    return [];
  }
}

async function scanMarket(sdk: PolymarketSDK, market: MonitoredMarket): Promise<ScanResult | null> {
  try {
    const orderbook = await sdk.markets.getProcessedOrderbook(market.conditionId);

    market.scanCount++;
    market.lastUpdate = Date.now();
    market.lastEffectiveLongCost = orderbook.summary.effectiveLongCost;
    market.lastEffectiveShortRevenue = orderbook.summary.effectiveShortRevenue;

    const { effectivePrices } = orderbook.summary;

    // 使用正确的有效价格检测套利
    const arb = checkArbitrage(
      orderbook.yes.ask,
      orderbook.no.ask,
      orderbook.yes.bid,
      orderbook.no.bid
    );

    const hasOpportunity = arb !== null && arb.profit > CONFIG.minProfitThreshold;

    return {
      timestamp: Date.now(),
      market,
      yesAsk: orderbook.yes.ask,
      noAsk: orderbook.no.ask,
      yesBid: orderbook.yes.bid,
      noBid: orderbook.no.bid,
      // 有效价格
      effectiveBuyYes: effectivePrices.effectiveBuyYes,
      effectiveBuyNo: effectivePrices.effectiveBuyNo,
      effectiveSellYes: effectivePrices.effectiveSellYes,
      effectiveSellNo: effectivePrices.effectiveSellNo,
      effectiveLongCost: orderbook.summary.effectiveLongCost,
      effectiveShortRevenue: orderbook.summary.effectiveShortRevenue,
      longArbProfit: orderbook.summary.longArbProfit,
      shortArbProfit: orderbook.summary.shortArbProfit,
      yesSpread: orderbook.summary.yesSpread,
      hasOpportunity,
      opportunityType: arb?.type,
    };
  } catch (error) {
    market.errorCount++;
    log('WARN', `Scan failed for ${market.question.slice(0, 30)}...`, error instanceof Error ? error.message : 'Unknown');
    return null;
  }
}

async function runScanCycle(sdk: PolymarketSDK): Promise<void> {
  scanCount++;
  const cycleStart = Date.now();

  logSeparator(`SCAN CYCLE #${scanCount}`);
  log('INFO', `Scanning ${markets.length} markets...`);

  const results: ScanResult[] = [];
  let successCount = 0;
  let errorCount = 0;

  for (const market of markets) {
    const result = await scanMarket(sdk, market);
    totalScans++;

    if (result) {
      successCount++;
      results.push(result);

      // Log each market scan result
      const profitIndicator = result.hasOpportunity ? '🎯' :
                              result.longArbProfit > -0.01 ? '📈' :
                              result.shortArbProfit > -0.01 ? '📉' : '⏸️';

      log('DEBUG', `${profitIndicator} ${market.question.slice(0, 40)}...`, {
        // 有效价格计算
        effectiveLongCost: result.effectiveLongCost.toFixed(4),
        effectiveShortRevenue: result.effectiveShortRevenue.toFixed(4),
        longArb: `${(result.longArbProfit * 100).toFixed(2)}%`,
        shortArb: `${(result.shortArbProfit * 100).toFixed(2)}%`,
        yesSpread: `${(result.yesSpread * 100).toFixed(2)}%`,
      });
    } else {
      errorCount++;
    }
  }

  // Find opportunities
  const opportunities = results.filter(r => r.hasOpportunity);

  if (opportunities.length > 0) {
    opportunitiesFound += opportunities.length;

    logSeparator('🚨 OPPORTUNITIES FOUND');

    for (const opp of opportunities) {
      log('SUCCESS', `${opp.opportunityType?.toUpperCase()} ARB OPPORTUNITY`, {
        market: opp.market.question,
        conditionId: opp.market.conditionId,
        type: opp.opportunityType,
        profit: `${(Math.max(opp.longArbProfit, opp.shortArbProfit) * 100).toFixed(3)}%`,
        effectivePrices: {
          buyYes: opp.effectiveBuyYes.toFixed(4),
          buyNo: opp.effectiveBuyNo.toFixed(4),
          sellYes: opp.effectiveSellYes.toFixed(4),
          sellNo: opp.effectiveSellNo.toFixed(4),
        },
        costs: {
          effectiveLongCost: opp.effectiveLongCost.toFixed(4),
          effectiveShortRevenue: opp.effectiveShortRevenue.toFixed(4),
        },
      });

      // Log execution strategy
      if (opp.opportunityType === 'long') {
        log('INFO', '📌 Strategy: Buy YES + Buy NO → Merge → Profit', {
          step1: `Buy YES @ ${opp.effectiveBuyYes.toFixed(4)}`,
          step2: `Buy NO @ ${opp.effectiveBuyNo.toFixed(4)}`,
          step3: 'Merge tokens → 1 USDC',
          profit: `${(opp.longArbProfit * 100).toFixed(3)}% per unit`,
        });
      } else {
        log('INFO', '📌 Strategy: Split USDC → Sell YES + Sell NO → Profit', {
          step1: 'Split 1 USDC → 1 YES + 1 NO',
          step2: `Sell YES @ ${opp.effectiveSellYes.toFixed(4)}`,
          step3: `Sell NO @ ${opp.effectiveSellNo.toFixed(4)}`,
          profit: `${(opp.shortArbProfit * 100).toFixed(3)}% per unit`,
        });
      }
    }
  }

  // Cycle summary
  const cycleTime = Date.now() - cycleStart;
  log('INFO', `Cycle #${scanCount} complete`, {
    duration: `${cycleTime}ms`,
    scanned: successCount,
    errors: errorCount,
    opportunities: opportunities.length,
  });

  // Show best spreads (closest to arb)
  if (results.length > 0) {
    const sortedByLongArb = [...results].sort((a, b) => b.longArbProfit - a.longArbProfit);
    const sortedByShortArb = [...results].sort((a, b) => b.shortArbProfit - a.shortArbProfit);

    log('DEBUG', 'Best Long Arb Candidates (by effective cost):', {
      '1st': `${sortedByLongArb[0].market.question.slice(0, 30)}... → cost=${sortedByLongArb[0].effectiveLongCost.toFixed(4)} → ${(sortedByLongArb[0].longArbProfit * 100).toFixed(2)}%`,
      '2nd': sortedByLongArb[1] ? `${sortedByLongArb[1].market.question.slice(0, 30)}... → cost=${sortedByLongArb[1].effectiveLongCost.toFixed(4)} → ${(sortedByLongArb[1].longArbProfit * 100).toFixed(2)}%` : 'N/A',
    });

    log('DEBUG', 'Best Short Arb Candidates (by effective revenue):', {
      '1st': `${sortedByShortArb[0].market.question.slice(0, 30)}... → rev=${sortedByShortArb[0].effectiveShortRevenue.toFixed(4)} → ${(sortedByShortArb[0].shortArbProfit * 100).toFixed(2)}%`,
      '2nd': sortedByShortArb[1] ? `${sortedByShortArb[1].market.question.slice(0, 30)}... → rev=${sortedByShortArb[1].effectiveShortRevenue.toFixed(4)} → ${(sortedByShortArb[1].shortArbProfit * 100).toFixed(2)}%` : 'N/A',
    });

    // Show spread analysis
    const avgSpread = results.reduce((sum, r) => sum + r.yesSpread, 0) / results.length;
    log('DEBUG', 'Market Efficiency:', {
      avgYesSpread: `${(avgSpread * 100).toFixed(2)}%`,
      interpretation: 'Spread = transaction cost, markets are efficient when spread > 0',
    });
  }
}

async function maybeRefreshMarkets(sdk: PolymarketSDK): Promise<void> {
  const now = Date.now();
  if (now - lastMarketRefresh > CONFIG.refreshMarketsIntervalMs) {
    log('INFO', 'Refreshing trending markets list...');
    const newMarkets = await fetchTrendingMarkets(sdk);
    if (newMarkets.length > 0) {
      markets = newMarkets;
      lastMarketRefresh = now;
    }
  }
}

async function main(): Promise<void> {
  console.clear();
  logSeparator('TRENDING MARKETS ARBITRAGE MONITOR');

  log('INFO', 'Configuration', {
    scanInterval: `${CONFIG.scanIntervalMs}ms`,
    minProfitThreshold: `${CONFIG.minProfitThreshold * 100}%`,
    maxMarkets: CONFIG.maxMarkets,
    refreshInterval: `${CONFIG.refreshMarketsIntervalMs / 1000}s`,
  });

  log('INFO', 'Understanding Arbitrage Calculation:', {
    note: 'Uses effective prices considering mirror orders',
    longArb: 'Profit when effectiveLongCost < 1.0',
    shortArb: 'Profit when effectiveShortRevenue > 1.0',
    docs: 'docs/01-polymarket-orderbook-arbitrage.md',
  });

  // Initialize SDK
  log('INFO', 'Initializing PolymarketSDK...');
  const sdk = new PolymarketSDK();
  log('SUCCESS', 'SDK initialized');

  // Fetch initial markets
  markets = await fetchTrendingMarkets(sdk);
  lastMarketRefresh = Date.now();

  if (markets.length === 0) {
    log('ERROR', 'No markets to monitor. Exiting.');
    process.exit(1);
  }

  logSeparator('STARTING MONITOR LOOP');
  log('INFO', `Press Ctrl+C to stop. Scanning every ${CONFIG.scanIntervalMs / 1000}s...`);

  // Monitor loop
  const runLoop = async () => {
    try {
      await maybeRefreshMarkets(sdk);
      await runScanCycle(sdk);
    } catch (error) {
      log('ERROR', 'Scan cycle error', error instanceof Error ? error.message : error);
    }

    // Check if we've reached max cycles
    if (CONFIG.maxCycles > 0 && scanCount >= CONFIG.maxCycles) {
      logSeparator('MAX CYCLES REACHED');
      log('INFO', 'Final Statistics', {
        totalCycles: scanCount,
        totalScans,
        opportunitiesFound,
      });
      process.exit(0);
    }

    // Schedule next scan
    setTimeout(runLoop, CONFIG.scanIntervalMs);
  };

  // Start loop
  await runLoop();

  // Handle shutdown
  process.on('SIGINT', () => {
    logSeparator('MONITOR SHUTDOWN');
    log('INFO', 'Final Statistics', {
      totalCycles: scanCount,
      totalScans,
      opportunitiesFound,
      runtime: `${Math.round((Date.now() - lastMarketRefresh) / 1000)}s`,
    });
    process.exit(0);
  });
}

main().catch(error => {
  log('ERROR', 'Fatal error', error);
  process.exit(1);
});
