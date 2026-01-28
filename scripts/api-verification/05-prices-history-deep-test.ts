/**
 * /prices-history 深度测试
 *
 * 基于 04 的发现：
 * - interval 是时间窗口（last 1h/1d），不是蜡烛间隔
 * - resolved 市场用 interval 返回 0，但 startTs/endTs 可以
 * - fidelity 最小粒度似乎是 1 分钟
 *
 * 本脚本验证：
 * 1. 已结束市场用 startTs/endTs 恢复数据
 * 2. 实际的 15 分钟加密市场
 * 3. fidelity 和返回数据量的关系
 */

const CLOB_API = 'https://clob.polymarket.com';
const GAMMA_API = 'https://gamma-api.polymarket.com';

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

async function testPriceHistory(label: string, tokenId: string, params: Record<string, string> = {}) {
  const query = new URLSearchParams({ market: tokenId, ...params });
  const url = `${CLOB_API}/prices-history?${query}`;
  console.log(`\n[${label}] GET ${url}`);
  const result = await fetchJson(url);
  if (!result.ok) {
    console.log(`  ERROR: ${result.status} ${result.error}`);
    return null;
  }
  const data = result.data as { history?: Array<{ t: number; p: number }> };
  const history = data.history || [];
  console.log(`  Points: ${history.length}`);
  if (history.length > 0) {
    const first = history[0];
    const last = history[history.length - 1];
    console.log(`  First: t=${first.t} (${formatTimestamp(first.t)}), p=${first.p}`);
    console.log(`  Last:  t=${last.t} (${formatTimestamp(last.t)}), p=${last.p}`);
    if (history.length >= 2) {
      const intervals: number[] = [];
      for (let i = 1; i < Math.min(history.length, 20); i++) {
        intervals.push(history[i].t - history[i - 1].t);
      }
      const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      const minInterval = Math.min(...intervals);
      const maxInterval = Math.max(...intervals);
      console.log(`  Interval: avg=${avgInterval.toFixed(0)}s min=${minInterval}s max=${maxInterval}s`);
      console.log(`  Time span: ${((last.t - first.t) / 60).toFixed(1)} min / ${((last.t - first.t) / 3600).toFixed(1)} hours`);
    }
    const prices = history.map((h) => h.p);
    console.log(`  Price range: ${Math.min(...prices)} - ${Math.max(...prices)}`);

    // Show first 5 data points
    console.log(`  Sample data:`);
    history.slice(0, 5).forEach((h, i) => {
      console.log(`    [${i}] t=${h.t} (${formatTimestamp(h.t)}) p=${h.p}`);
    });
  }
  return data;
}

async function main() {
  console.log('🔬 /prices-history 深度测试');
  console.log(`Time: ${new Date().toISOString()}`);

  // =========================================================
  // TEST 1: CS2 resolved market 用 startTs/endTs
  // =========================================================
  printSeparator('TEST 1: CS2 resolved market with startTs/endTs');

  const CS2_YES_TOKEN_ID = '43483263124644478520592164117863889505064690344162739837819619686304683165329';

  // CS2 比赛大约在 2025-12 左右
  // 先试一个大范围
  const dec2025Start = Math.floor(new Date('2025-12-01T00:00:00Z').getTime() / 1000);
  const dec2025End = Math.floor(new Date('2025-12-31T00:00:00Z').getTime() / 1000);

  console.log('\n1a. CS2 - 2025年12月整月');
  await testPriceHistory('CS2-dec', CS2_YES_TOKEN_ID, {
    startTs: String(dec2025Start),
    endTs: String(dec2025End),
  });

  console.log('\n1b. CS2 - 2025年12月, fidelity=1');
  await testPriceHistory('CS2-dec-f1', CS2_YES_TOKEN_ID, {
    startTs: String(dec2025Start),
    endTs: String(dec2025End),
    fidelity: '1',
  });

  // =========================================================
  // TEST 2: 找到真正的 15 分钟加密市场
  // =========================================================
  printSeparator('TEST 2: 15-min crypto market via scan_crypto_short_term_markets equivalent');

  // 用更精确的搜索: 搜索 "up" 或 "down" 关键词
  const searchUrl = `${GAMMA_API}/markets?active=true&closed=false&limit=30&order=endDate&ascending=true`;
  console.log(`\nSearching for short-term markets: GET ${searchUrl}`);
  const searchResult = await fetchJson(searchUrl);

  let cryptoTokenId: string | null = null;
  let cryptoConditionId: string | null = null;

  if (searchResult.ok && searchResult.data) {
    const markets = searchResult.data as Array<Record<string, unknown>>;
    const cryptoMarkets = markets.filter((m) => {
      const q = String(m.question || '').toLowerCase();
      return (q.includes('btc') || q.includes('eth') || q.includes('xrp') || q.includes('sol')) &&
             (q.includes('up') || q.includes('down') || q.includes('above') || q.includes('below'));
    });

    console.log(`  Found ${cryptoMarkets.length} crypto short-term markets`);
    cryptoMarkets.slice(0, 5).forEach((m) => {
      console.log(`    - "${m.question}" endDate=${m.endDate}`);
      console.log(`      conditionId: ${m.conditionId || m.condition_id}`);
    });

    if (cryptoMarkets.length > 0) {
      const market = cryptoMarkets[0];
      cryptoConditionId = (market.conditionId || market.condition_id) as string;

      // 获取 token IDs
      const clobResult = await fetchJson(`${CLOB_API}/markets/${cryptoConditionId}`);
      if (clobResult.ok) {
        const clobData = clobResult.data as Record<string, unknown>;
        const tokens = clobData.tokens as Array<{ token_id: string; outcome: string }>;
        if (tokens && tokens.length >= 2) {
          cryptoTokenId = tokens[0].token_id;
          console.log(`\n  Selected: "${market.question}"`);
          console.log(`  Token IDs:`);
          tokens.forEach((t) => console.log(`    ${t.outcome}: ${t.token_id}`));
        }
      }
    }
  }

  if (cryptoTokenId && cryptoConditionId) {
    console.log('\n2a. 15-min crypto - interval=max');
    await testPriceHistory('crypto-max', cryptoTokenId, { interval: 'max' });

    console.log('\n2b. 15-min crypto - interval=1h');
    await testPriceHistory('crypto-1h', cryptoTokenId, { interval: '1h' });

    console.log('\n2c. 15-min crypto - interval=1h, fidelity=1');
    await testPriceHistory('crypto-1h-f1', cryptoTokenId, { interval: '1h', fidelity: '1' });

    // 用最近 15 分钟的时间范围
    const nowTs = Math.floor(Date.now() / 1000);
    console.log('\n2d. 15-min crypto - last 15 minutes, fidelity=1');
    await testPriceHistory('crypto-15m-f1', cryptoTokenId, {
      startTs: String(nowTs - 15 * 60),
      endTs: String(nowTs),
      fidelity: '1',
    });
  }

  // =========================================================
  // TEST 3: 已知的 XRP/ETH 15 分钟市场 (可能已结束)
  // =========================================================
  printSeparator('TEST 3: Known 15-min crypto markets (likely resolved)');

  // ETH 1/6 7:15-7:30AM Up
  const ETH_CONDITION_ID = '0x0be9ec4ae7d1c374122a755f7d930fbfd1b00da33627a43a322f300d74a3e65a';

  // 先通过 CLOB 获取 token IDs
  console.log('\n3a. ETH 15-min market - get token IDs');
  const ethClobResult = await fetchJson(`${CLOB_API}/markets/${ETH_CONDITION_ID}`);
  if (ethClobResult.ok) {
    const ethData = ethClobResult.data as Record<string, unknown>;
    const tokens = ethData.tokens as Array<{ token_id: string; outcome: string }>;
    if (tokens && tokens.length >= 2) {
      console.log(`  Tokens:`);
      tokens.forEach((t) => console.log(`    ${t.outcome}: ${t.token_id}`));

      const ethTokenId = tokens[0].token_id;

      // 2025-01-06 around 7:15-7:30 AM UTC
      const ethStart = Math.floor(new Date('2025-01-06T07:00:00Z').getTime() / 1000);
      const ethEnd = Math.floor(new Date('2025-01-06T08:00:00Z').getTime() / 1000);

      console.log('\n3b. ETH 15-min - startTs/endTs around market time, fidelity=1');
      await testPriceHistory('eth-15m', ethTokenId, {
        startTs: String(ethStart),
        endTs: String(ethEnd),
        fidelity: '1',
      });

      console.log('\n3c. ETH 15-min - interval=max');
      await testPriceHistory('eth-15m-max', ethTokenId, { interval: 'max' });
    }
  } else {
    console.log(`  CLOB lookup failed: ${ethClobResult.status} ${ethClobResult.error}`);
  }

  // =========================================================
  // TEST 4: fidelity 与默认行为深度测试
  // =========================================================
  printSeparator('TEST 4: fidelity defaults and behavior');

  // 使用活跃市场
  const FED_TOKEN_ID = '16419649354067298412736919830777830730026677464626899811394461690794060330642';

  // 不同 interval 下的默认 fidelity
  const intervals = ['1h', '6h', '1d', '1w'] as const;
  for (const interval of intervals) {
    console.log(`\n4-${interval}. interval=${interval} (default fidelity)`);
    await testPriceHistory(`fed-${interval}`, FED_TOKEN_ID, { interval });
  }

  // 同一 interval 下不同 fidelity
  console.log('\n4-custom. interval=6h with different fidelities');
  for (const fidelity of ['1', '5', '15', '30', '60']) {
    await testPriceHistory(`fed-6h-f${fidelity}`, FED_TOKEN_ID, { interval: '6h', fidelity });
  }

  // =========================================================
  // SUMMARY
  // =========================================================
  printSeparator('DEEP TEST COMPLETE');
  console.log('\nKey questions answered:');
  console.log('1. Can startTs/endTs recover data for any resolved market?');
  console.log('2. What resolution does /prices-history support for 15-min markets?');
  console.log('3. How does fidelity interact with interval?');
  console.log('4. Default fidelity per interval level?');
}

main().catch(console.error);
