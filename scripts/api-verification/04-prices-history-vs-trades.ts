/**
 * /prices-history vs /data/trades API 对比验证脚本
 *
 * 目的：验证 Polymarket CLOB /prices-history 端点的行为
 * 对比场景：
 *   1. 已结束（resolved）市场
 *   2. 进行中的活跃市场
 *   3. 15 分钟短期加密市场
 *   4. fidelity 参数的最小粒度
 *   5. interval 参数行为
 *   6. /data/trades 对比
 */

const CLOB_API = 'https://clob.polymarket.com';
const DATA_API = 'https://data-api.polymarket.com';
const GAMMA_API = 'https://gamma-api.polymarket.com';

// ===== 测试用市场 =====

// 已结束市场: Trump 2024 (resolved)
const TRUMP_CONDITION_ID = '0xdd22472e552920b8438158ea7238bfadfa4f736aa4cee91a6b86c39ead110917';
const TRUMP_YES_TOKEN_ID = '21742633143463906290569050155826241533067272736897614950488156847949938836455';

// 已结束市场: CS2 esports (resolved)
const CS2_CONDITION_ID = '0x8307e29e55c51624bf7dc2448f640902deda12a798bf4f9389f50effed5ca8e3';
const CS2_YES_TOKEN_ID = '43483263124644478520592164117863889505064690344162739837819619686304683165329';

// ===== Helper Functions =====

function formatTimestamp(ts: number): string {
  return new Date(ts * 1000).toISOString();
}

async function fetchJson(url: string): Promise<{ ok: boolean; status: number; data: unknown; error?: string }> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      const text = await response.text();
      return { ok: false, status: response.status, data: null, error: text };
    }
    const data = await response.json();
    return { ok: true, status: response.status, data };
  } catch (error) {
    return { ok: false, status: 0, data: null, error: String(error) };
  }
}

function printSeparator(title: string) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`  ${title}`);
  console.log('='.repeat(80));
}

function printSubSection(title: string) {
  console.log(`\n--- ${title} ---`);
}

// ===== Test Functions =====

/**
 * Test 1: /prices-history 基本行为
 */
async function testPriceHistory(
  label: string,
  tokenId: string,
  params: Record<string, string> = {}
) {
  const query = new URLSearchParams({ market: tokenId, ...params });
  const url = `${CLOB_API}/prices-history?${query}`;

  console.log(`\nRequest: GET ${url}`);
  const result = await fetchJson(url);

  if (!result.ok) {
    console.log(`  Status: ${result.status}`);
    console.log(`  Error: ${result.error}`);
    return null;
  }

  const data = result.data as { history?: Array<{ t: number; p: number }> };
  const history = data.history || [];

  console.log(`  Status: ${result.status}`);
  console.log(`  Points: ${history.length}`);

  if (history.length > 0) {
    const first = history[0];
    const last = history[history.length - 1];
    console.log(`  First: t=${first.t} (${formatTimestamp(first.t)}), p=${first.p}`);
    console.log(`  Last:  t=${last.t} (${formatTimestamp(last.t)}), p=${last.p}`);

    // 计算时间间隔
    if (history.length >= 2) {
      const intervals = [];
      for (let i = 1; i < Math.min(history.length, 10); i++) {
        intervals.push(history[i].t - history[i - 1].t);
      }
      const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      console.log(`  Avg interval: ${avgInterval}s (${(avgInterval / 60).toFixed(1)}min)`);
      console.log(`  Time span: ${((last.t - first.t) / 3600).toFixed(1)} hours`);
    }

    // 价格范围
    const prices = history.map((h) => h.p);
    console.log(`  Price range: ${Math.min(...prices).toFixed(4)} - ${Math.max(...prices).toFixed(4)}`);
  }

  return data;
}

/**
 * Test 2: /data/trades 行为
 */
async function testDataTrades(
  label: string,
  conditionId: string,
  params: Record<string, string> = {}
) {
  const query = new URLSearchParams({ market: conditionId, ...params });
  const url = `${DATA_API}/trades?${query}`;

  console.log(`\nRequest: GET ${url}`);
  const result = await fetchJson(url);

  if (!result.ok) {
    console.log(`  Status: ${result.status}`);
    console.log(`  Error: ${result.error}`);
    return null;
  }

  const trades = result.data as Array<Record<string, unknown>>;
  console.log(`  Status: ${result.status}`);
  console.log(`  Trades returned: ${trades.length}`);

  if (trades.length > 0) {
    const first = trades[0];
    console.log(`  First trade keys: ${Object.keys(first).sort().join(', ')}`);
    console.log(`  Sample trade:`, JSON.stringify(first, null, 2).split('\n').slice(0, 15).join('\n'));
  }

  return trades;
}

/**
 * Test 3: 查找活跃市场的 tokenId（通过 CLOB API）
 */
async function findActiveMarketTokens(): Promise<{
  conditionId: string;
  yesTokenId: string;
  noTokenId: string;
  question: string;
} | null> {
  printSubSection('Finding an active market via CLOB API');

  // 用 Gamma API 找一个活跃市场
  const url = `${GAMMA_API}/markets?active=true&closed=false&limit=3&order=volume24hr&ascending=false`;
  console.log(`\nRequest: GET ${url}`);
  const result = await fetchJson(url);

  if (!result.ok || !result.data) {
    console.log('  Failed to find active markets from Gamma API');
    return null;
  }

  const markets = result.data as Array<Record<string, unknown>>;
  if (markets.length === 0) {
    console.log('  No active markets found');
    return null;
  }

  const market = markets[0];
  const conditionId = market.conditionId as string || market.condition_id as string;
  console.log(`  Found: "${market.question}"`);
  console.log(`  conditionId: ${conditionId}`);

  // 通过 CLOB API 获取 token IDs
  const clobUrl = `${CLOB_API}/markets/${conditionId}`;
  console.log(`\nRequest: GET ${clobUrl}`);
  const clobResult = await fetchJson(clobUrl);

  if (!clobResult.ok || !clobResult.data) {
    console.log('  Failed to get market from CLOB');
    return null;
  }

  const clobMarket = clobResult.data as Record<string, unknown>;
  const tokens = clobMarket.tokens as Array<{ token_id: string; outcome: string }>;

  if (!tokens || tokens.length < 2) {
    console.log('  No tokens found in CLOB market data');
    return null;
  }

  console.log(`  Tokens:`);
  tokens.forEach((t) => console.log(`    ${t.outcome}: ${t.token_id}`));

  return {
    conditionId,
    yesTokenId: tokens[0].token_id,
    noTokenId: tokens[1].token_id,
    question: String(market.question),
  };
}

/**
 * Test 4: 查找 15 分钟短期加密市场
 */
async function findShortTermCryptoMarket(): Promise<{
  conditionId: string;
  yesTokenId: string;
  noTokenId: string;
  question: string;
} | null> {
  printSubSection('Finding a 15-min crypto market');

  // 搜索 15-minute 加密市场
  const url = `${GAMMA_API}/markets?active=true&closed=false&limit=10&tag=crypto&order=endDate&ascending=true`;
  console.log(`\nRequest: GET ${url}`);
  const result = await fetchJson(url);

  if (!result.ok || !result.data) {
    // Fallback: search by keyword
    const url2 = `${GAMMA_API}/markets?active=true&closed=false&limit=20&order=endDate&ascending=true`;
    console.log(`\nFallback: GET ${url2}`);
    const result2 = await fetchJson(url2);
    if (!result2.ok || !result2.data) {
      console.log('  Failed to find crypto markets');
      return null;
    }
    const markets = result2.data as Array<Record<string, unknown>>;
    const cryptoMarket = markets.find(
      (m) => {
        const q = String(m.question || '').toLowerCase();
        return (q.includes('btc') || q.includes('eth') || q.includes('xrp') || q.includes('sol')) &&
               (q.includes('up') || q.includes('down'));
      }
    );
    if (!cryptoMarket) {
      console.log('  No short-term crypto market found');
      return null;
    }

    const conditionId = cryptoMarket.conditionId as string || cryptoMarket.condition_id as string;
    console.log(`  Found: "${cryptoMarket.question}"`);
    console.log(`  conditionId: ${conditionId}`);

    // Get tokens
    const clobResult = await fetchJson(`${CLOB_API}/markets/${conditionId}`);
    if (!clobResult.ok) return null;
    const clobMarket = clobResult.data as Record<string, unknown>;
    const tokens = clobMarket.tokens as Array<{ token_id: string; outcome: string }>;
    if (!tokens || tokens.length < 2) return null;

    return {
      conditionId,
      yesTokenId: tokens[0].token_id,
      noTokenId: tokens[1].token_id,
      question: String(cryptoMarket.question),
    };
  }

  const markets = result.data as Array<Record<string, unknown>>;
  if (markets.length === 0) return null;

  const market = markets[0];
  const conditionId = market.conditionId as string || market.condition_id as string;
  console.log(`  Found: "${market.question}"`);

  const clobResult = await fetchJson(`${CLOB_API}/markets/${conditionId}`);
  if (!clobResult.ok) return null;
  const clobMarket = clobResult.data as Record<string, unknown>;
  const tokens = clobMarket.tokens as Array<{ token_id: string; outcome: string }>;
  if (!tokens || tokens.length < 2) return null;

  return {
    conditionId,
    yesTokenId: tokens[0].token_id,
    noTokenId: tokens[1].token_id,
    question: String(market.question),
  };
}

// ===== Main =====

async function main(): Promise<void> {
  console.log('🔬 Polymarket /prices-history vs /data/trades API 验证');
  console.log(`Time: ${new Date().toISOString()}`);
  console.log(`CLOB API: ${CLOB_API}`);
  console.log(`Data API: ${DATA_API}`);

  // =========================================================
  // SECTION 1: 已结束市场 — /prices-history
  // =========================================================
  printSeparator('SECTION 1: /prices-history on RESOLVED market (Trump 2024)');

  printSubSection('1a. interval=max (全部数据)');
  await testPriceHistory('Trump max', TRUMP_YES_TOKEN_ID, { interval: 'max' });

  printSubSection('1b. interval=1d');
  await testPriceHistory('Trump 1d', TRUMP_YES_TOKEN_ID, { interval: '1d' });

  printSubSection('1c. interval=1h');
  await testPriceHistory('Trump 1h', TRUMP_YES_TOKEN_ID, { interval: '1h' });

  printSubSection('1d. fidelity=1 (1 分钟)');
  await testPriceHistory('Trump fidelity=1', TRUMP_YES_TOKEN_ID, {
    interval: '1d',
    fidelity: '1',
  });

  printSubSection('1e. fidelity=5 (5 分钟)');
  await testPriceHistory('Trump fidelity=5', TRUMP_YES_TOKEN_ID, {
    interval: '1d',
    fidelity: '5',
  });

  printSubSection('1f. Custom time range (startTs/endTs)');
  // 2024-11-04 (election day) to 2024-11-06
  const electionStart = Math.floor(new Date('2024-11-04T00:00:00Z').getTime() / 1000);
  const electionEnd = Math.floor(new Date('2024-11-06T00:00:00Z').getTime() / 1000);
  await testPriceHistory('Trump election window', TRUMP_YES_TOKEN_ID, {
    startTs: String(electionStart),
    endTs: String(electionEnd),
    fidelity: '60', // 1 hour
  });

  // =========================================================
  // SECTION 2: 已结束市场 — /data/trades
  // =========================================================
  printSeparator('SECTION 2: /data/trades on RESOLVED market (Trump 2024)');

  printSubSection('2a. 基本获取');
  await testDataTrades('Trump trades', TRUMP_CONDITION_ID, { limit: '5' });

  // =========================================================
  // SECTION 3: CS2 esports 已结束市场
  // =========================================================
  printSeparator('SECTION 3: /prices-history on RESOLVED esports market (CS2)');

  printSubSection('3a. interval=max');
  await testPriceHistory('CS2 max', CS2_YES_TOKEN_ID, { interval: 'max' });

  printSubSection('3b. /data/trades');
  await testDataTrades('CS2 trades', CS2_CONDITION_ID, { limit: '5' });

  // =========================================================
  // SECTION 4: 活跃市场
  // =========================================================
  printSeparator('SECTION 4: ACTIVE market');

  const activeMarket = await findActiveMarketTokens();
  if (activeMarket) {
    printSubSection('4a. /prices-history interval=1d');
    await testPriceHistory('Active 1d', activeMarket.yesTokenId, { interval: '1d' });

    printSubSection('4b. /prices-history interval=1h');
    await testPriceHistory('Active 1h', activeMarket.yesTokenId, { interval: '1h' });

    printSubSection('4c. /prices-history fidelity=1 (1min)');
    await testPriceHistory('Active fidelity=1', activeMarket.yesTokenId, {
      interval: '1h',
      fidelity: '1',
    });

    printSubSection('4d. /data/trades');
    await testDataTrades('Active trades', activeMarket.conditionId, { limit: '10' });
  }

  // =========================================================
  // SECTION 5: 15 分钟短期加密市场
  // =========================================================
  printSeparator('SECTION 5: SHORT-TERM crypto market (15-min)');

  const cryptoMarket = await findShortTermCryptoMarket();
  if (cryptoMarket) {
    printSubSection('5a. /prices-history interval=max');
    await testPriceHistory('Crypto max', cryptoMarket.yesTokenId, { interval: 'max' });

    printSubSection('5b. /prices-history fidelity=1');
    await testPriceHistory('Crypto fidelity=1', cryptoMarket.yesTokenId, {
      interval: 'max',
      fidelity: '1',
    });

    printSubSection('5c. /data/trades');
    await testDataTrades('Crypto trades', cryptoMarket.conditionId, { limit: '20' });
  }

  // =========================================================
  // SECTION 6: fidelity 参数边界测试
  // =========================================================
  printSeparator('SECTION 6: fidelity edge cases');

  const testTokenId = activeMarket?.yesTokenId || TRUMP_YES_TOKEN_ID;

  printSubSection('6a. fidelity=0 (会不会报错？)');
  await testPriceHistory('fidelity=0', testTokenId, { interval: '1h', fidelity: '0' });

  printSubSection('6b. fidelity=0.5 (亚分钟级别？)');
  await testPriceHistory('fidelity=0.5', testTokenId, { interval: '1h', fidelity: '0.5' });

  printSubSection('6c. fidelity=0.1 (6秒？)');
  await testPriceHistory('fidelity=0.1', testTokenId, { interval: '1h', fidelity: '0.1' });

  // =========================================================
  // SECTION 7: conditionId vs tokenId
  // =========================================================
  printSeparator('SECTION 7: conditionId vs tokenId as market param');

  printSubSection('7a. 使用 tokenId (文档说的)');
  await testPriceHistory('tokenId', TRUMP_YES_TOKEN_ID, { interval: '1d' });

  printSubSection('7b. 使用 conditionId (看看能不能用)');
  await testPriceHistory('conditionId', TRUMP_CONDITION_ID, { interval: '1d' });

  // =========================================================
  // SUMMARY
  // =========================================================
  printSeparator('VERIFICATION COMPLETE');
  console.log('\nCheck the output above to determine:');
  console.log('1. Does /prices-history work for resolved markets?');
  console.log('2. What is the minimum fidelity granularity?');
  console.log('3. Does it support conditionId or only tokenId?');
  console.log('4. How does data coverage compare to /data/trades?');
  console.log('5. Is /prices-history suitable for 15-min crypto markets?');
}

main().catch(console.error);
