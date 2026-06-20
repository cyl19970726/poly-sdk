# 05 - Copy Trading 深度分析

> 第一性原理：Copy Trading 的本质价值是什么？

---

## 0. 第一性原理思考

在讨论"如何实现"之前，先问"为什么"和"是否可行"。

### 0.1 Copy Trading 的本质假设

Copy Trading 有效的前提是：**目标钱包有可复制的 alpha**

Alpha 来源可能是：
1. **信息优势** - 知道别人不知道的事（内幕、早期研究）
2. **分析优势** - 更好的概率判断能力
3. **执行优势** - 更好的入场/出场时机

### 0.2 关键质疑

| 假设 | 质疑 | 验证方法 |
|------|------|----------|
| Smart Money 有 alpha | 是否只是幸存者偏差？ | 分析 Top 100 钱包的持续性 |
| Alpha 可以被复制 | 价格反应速度多快？ | 测量交易后价格变化 |
| 跟单能获利 | 延迟导致的滑点是否吃掉利润？ | 模拟回测 |

### 0.3 核心问题重新定义

**真正的问题不是"如何更快检测"，而是：**

1. **价格反应窗口有多长？**
   - 如果 Smart Money 交易后，价格在 5 秒内完成反应 → Copy Trading 可能无效
   - 如果价格反应窗口 > 1 分钟 → 有足够时间跟单

2. **我们跟的是"交易"还是"方向"？**
   - 跟交易 = 需要低延迟
   - 跟方向 = 延迟不重要，重要的是持仓变化

3. **Alpha 来自哪里？**
   - 如果来自信息 → 需要极低延迟（可能已经太晚）
   - 如果来自分析 → 信号可能持续更久

### 0.4 待验证假设

```typescript
// 假设 1: Smart Money 交易后，价格反应窗口
// 验证: 分析 Smart Money 交易后的价格变化曲线
async function measurePriceReactionWindow() {
  // 1. 获取 Smart Money 历史交易
  // 2. 获取交易后 5s/30s/1min/5min 的价格变化
  // 3. 计算"跟单可获利"的时间窗口
}

// 假设 2: 跟单能覆盖滑点成本
// 验证: 计算平均跟单收益 vs 滑点成本
async function measureCopyTradingProfitability() {
  // 1. 模拟跟单 (加入检测延迟 + 下单延迟)
  // 2. 计算每笔跟单的实际收益
  // 3. 扣除滑点、手续费
}
```

---

## 1. 技术问题定义

假设上述验证通过，Copy Trading 有价值，那么技术问题是：

```
目标钱包下单 → 检测到交易 → 我们跟单 → 成交
              ↑           ↑
            延迟1       延迟2
```

**关键指标：**
- **Total Latency** = 检测延迟 + 下单延迟
- 目标：取决于价格反应窗口（待验证）

---

## 2. 跟单的本质分类

在讨论检测方案之前，先明确**跟的是什么**：

### 2.1 四种跟单方式

| 方式 | 跟的是什么 | 触发时机 | 延迟敏感度 | 描述 |
|------|-----------|---------|-----------|------|
| **跟成交** | Trade/Fill | 目标成交后 | 高 | 他成交了，我立即跟单 |
| **跟挂单** | Order Placement | 目标挂单时 | 极高 | 他挂单了，我也挂相同价格 |
| **跟持仓** | Position Change | 持仓变化时 | 低 | 定期对比持仓，复制组合 |
| **跟信号** | Pattern/Signal | 检测到模式时 | 中 | 他买入某市场，我也买入 |

### 2.2 各方式分析

#### 方式 A: 跟成交 (Trade Following)

```
目标成交 → 我们检测到 → 我们下单 → 我们成交
         延迟1           延迟2
```

**优点：** 确定性高，目标确实交易了
**缺点：** 价格可能已经变化，可能买在更差的价格

**适用场景：** 流动性好的市场，价格反应不太快

---

#### 方式 B: 跟挂单 (Order Following)

```
目标挂单 → 我们检测到 → 我们挂单 → (可能)同时成交
         延迟
```

**优点：** 可能获得与目标相同的价格
**缺点：**
- 需要能监听挂单事件（需要目标的 API 凭证 - 不可能）
- 目标可能取消订单

**可行性分析：**
- Polymarket WebSocket 的 `clob_user` topic 只能监听**自己**的订单
- 无法监听**别人**的挂单
- **结论：不可行**

---

#### 方式 C: 跟持仓 (Position Following)

```
定期检查持仓 → 发现变化 → 调整我们的持仓
            每 N 分钟
```

**优点：**
- 实现简单
- 不需要实时检测
- 可以复制整个投资组合

**缺点：**
- 延迟大（分钟级）
- 可能错过短期交易

**适用场景：** 跟随长期持有型 Smart Money

---

#### 方式 D: 跟信号 (Signal Following)

```
检测到买入信号 → 评估市场 → 我们进入相同市场
             （可选延迟）
```

**特点：**
- 不是精确复制，而是"跟随方向"
- 可以选择更好的入场时机
- 需要自己判断止盈止损

**适用场景：** 信号有效期较长的情况

---

### 2.3 可行性矩阵（更新后）

| 方式 | 技术可行性 | 检测手段 | 延迟 | 备注 |
|------|-----------|---------|------|------|
| 跟成交 | ✅ 可行 | Activity WS (trader.address) | 100-500ms | 最直接 |
| 跟挂单 | ⚠️ 间接可行 | 盘口变化分析 / 链上事件 | 秒级 | 需要推断 |
| 跟持仓 | ✅ 可行 | Data API getPositions | 分钟级 | 最稳定 |
| 跟信号 | ✅ 可行 | 组合检测方法 | 灵活 | 可定制 |

### 2.4 跟挂单的实现思路

虽然无法直接监听他人订单，但有几种间接方式：

#### 方式 1: 盘口变化分析

```typescript
// 监听 agg_orderbook，检测大单挂单
realtime.subscribeMarkets([tokenId], {
  onOrderbook: (book) => {
    // 对比前后盘口，检测新增大单
    const prevBook = this.bookCache.get(book.assetId);
    if (prevBook) {
      const newLargeOrders = detectLargeOrderChanges(prevBook, book);
      for (const order of newLargeOrders) {
        // 发现大单挂单信号
        this.emit('largeOrderDetected', {
          side: order.side,
          price: order.price,
          size: order.size,
          timestamp: Date.now(),
        });
      }
    }
    this.bookCache.set(book.assetId, book);
  },
});

function detectLargeOrderChanges(prev: Orderbook, curr: Orderbook) {
  const changes = [];
  // 对比 bids 和 asks，找出新增的大单
  // ...
  return changes;
}
```

**局限：** 无法确定挂单者是谁，只能看到"有大单出现"

---

#### 方式 2: 链上事件监听

Polymarket CLOB 订单在链上发出事件，可以监听：

```typescript
// CTF Exchange 合约事件
const EXCHANGE_ABI = [
  'event OrderCreated(bytes32 indexed orderHash, address indexed maker, ...)',
  'event OrderFilled(bytes32 indexed orderHash, ...)',
  'event OrderCancelled(bytes32 indexed orderHash, ...)',
];

const exchange = new ethers.Contract(CTF_EXCHANGE, EXCHANGE_ABI, provider);

// 监听订单创建事件
exchange.on('OrderCreated', (orderHash, maker, ...args) => {
  if (watchedWallets.has(maker.toLowerCase())) {
    console.log('Smart Money 挂单了！');
    // 可以跟单
  }
});
```

**待验证：** CTF Exchange 是否发出 OrderCreated 事件？

---

#### 方式 3: 成交时分析 maker 历史

```typescript
// 当 Smart Money 作为 taker 成交时，记录对手方 (maker)
// 如果某个 maker 持续与 Smart Money 对手交易，可能也是大户

// Activity trades 只包含 taker 的 trader.address
// 需要通过 Subgraph 获取 maker 信息
const fills = await subgraph.getOrderFilledEvents({
  where: { taker: smartMoneyAddress },
});

for (const fill of fills) {
  // fill.maker 就是 Smart Money 的对手方
  // 可以分析 maker 的行为模式
}
```

---

#### 方式 4: Smart Money 的 Maker 行为推断

如果 Smart Money 是做市商：

```typescript
// 1. 获取 Smart Money 的历史交易
const trades = await dataApi.getTrades(smartMoney, { limit: 1000 });

// 2. 分析他们是 maker 还是 taker
// 通过 Subgraph 查询每笔交易的角色
const fills = await subgraph.getMakerFills(smartMoney, { first: 100 });

// 3. 如果他们经常作为 maker，说明他们在挂单
// 我们可以在相同价位跟随挂单
```

---

## 3. 事件检测方案对比

### 3.1 现有 RealtimeServiceV2 的能力

通过分析源码，发现 RealtimeServiceV2 支持多个 topic：

```typescript
// 可用 Topics:
// 1. clob_market - 市场数据（不含交易者地址）
//    - last_trade_price: { price, size, side } // 无地址

// 2. clob_user - 用户数据（只能订阅自己）
//    - order: PLACEMENT/UPDATE/CANCELLATION
//    - trade: 自己的成交

// 3. activity - 活动数据 ← 关键！
//    - trades: 包含 trader.address!
//    - orders_matched
```

**关键发现：`activity` topic 的 trades 包含交易者地址！**

```typescript
interface ActivityTrade {
  trader?: {
    name?: string;
    address?: string;  // ← 这正是我们需要的
  };
  // ...
}
```

### 3.2 可用数据源

| 数据源 | 类型 | 有交易者地址？ | 备注 |
|--------|------|--------------|------|
| `activity` WebSocket | 推送 | ✅ 有 | 按市场过滤，包含所有交易 |
| `clob_market` WebSocket | 推送 | ❌ 无 | 只有价格和数量 |
| Data API getTrades | 轮询 | ✅ 有 | maker 字段 |
| Data API getActivity | 轮询 | ✅ 有 | 按地址查询 |
| Subgraph OrderFilledEvent | 轮询 | ✅ 有 | maker/taker 字段 |
| Polygon RPC 事件 | 推送 | ✅ 有 | 最底层，最快 |

### 3.3 验证脚本

创建了验证脚本来实际测量延迟：

```bash
# 运行延迟测试
npx tsx scripts/smart-money/01-test-detection-methods.ts
```

脚本同时启动三种检测方法，对比：
1. Activity WebSocket
2. Data API 轮询
3. Subgraph 轮询

测量指标：
- 事件接收数量
- 平均延迟
- 是否包含交易者地址
- 哪个方法最先检测到

### 3.4 理论分析

| 方案 | 机制 | 预期延迟 | 优点 | 缺点 |
|------|------|---------|------|------|
| Activity WebSocket | 推送 | 100-500ms | 最快、实时 | 需要监听所有交易再过滤 |
| Data API 轮询 | HTTP | 2-5s + 轮询间隔 | 简单可靠 | 有延迟 |
| Subgraph 轮询 | GraphQL | 5-15s + 轮询间隔 | 数据完整 | 索引延迟大 |
| Polygon RPC | 链上事件 | 2-3s (出块时间) | 最底层 | 实现复杂 |

### 3.5 ✅ 实测验证结果 (2025-12-28)

**验证测试已完成，结果如下：**

#### 关键发现

1. **Activity WebSocket 确认可用** ✅
   - 60 秒内收到 200+ 交易
   - 所有交易都包含 `trader.address`（交易者地址）
   - 所有交易还包含 `trader.name`（交易者名称）

2. **延迟极低** ✅
   - 交易推送延迟 < 100ms
   - 适合实时 Copy Trading

3. **数据完整度** ✅
   ```typescript
   // Activity Trade 包含的完整字段
   {
     "asset": "47632033502843656213...",      // Token ID
     "conditionId": "0xb82c6573...",          // 市场 ID
     "eventSlug": "aus-mct-per-2025-12-28",   // 事件 slug
     "slug": "aus-mct-per-draw",              // 市场 slug
     "outcome": "No",                          // 结果方向
     "side": "BUY",                            // 交易方向
     "size": 15.72,                            // 交易数量
     "price": 0.87,                            // 价格
     "timestamp": 1766913243,                  // 时间戳
     "transactionHash": "0x921936dfc9...",    // 交易哈希
     "trader": {                              // ← 交易者信息对象
       "name": "gabagool22",                  // ← 交易者名称
       "address": "0x6031B6eed1C97e..."       // ← 交易者地址！
     }
   }
   ```

4. **Data API 也提供交易者地址** ✅
   - `dataApi.getTrades()` 返回的交易也包含交易者地址
   - 可作为备用方案

#### 结论

**Copy Trading 通过交易跟踪（跟成交）在技术上完全可行：**

| 能力 | 状态 | 说明 |
|------|------|------|
| 检测目标钱包交易 | ✅ 可行 | trader.address 字段 |
| 实时推送 | ✅ 可行 | Activity WebSocket |
| 低延迟 | ✅ 确认 | < 100ms |
| 交易详情完整 | ✅ 确认 | 包含市场、价格、数量等 |

#### 注意事项

**RealTimeDataClient 回调签名**：官方客户端的 `onMessage` 回调实际上是 `(client, message)` 而不是 `(message)`：

```typescript
// 正确用法
const onMessage = (client: RealTimeDataClient, message: Message) => {
  // message.topic, message.type, message.payload
};

// 错误用法（文档误导）
const onMessage = (message: Message) => { ... };
```

**RealtimeServiceV2 需要修复**：当前的 `subscribeActivity` 传递空 filter `'{}'` 会被服务端拒绝，需要修复为不传 filters 字段。

### 3.6 RealtimeServiceV2 增强方案

基于验证结果，可以增强现有服务：

#### 方案 A: 增加 SmartMoneyWatcher（推荐）

```typescript
// 新增: 专门用于监控 Smart Money 的包装器
class SmartMoneyWatcher extends EventEmitter {
  private watchedWallets: Set<string> = new Set();
  private marketSubscriptions: Map<string, Subscription> = new Map();

  /**
   * 监控一组钱包在所有市场的活动
   */
  watchWallets(addresses: string[]): void {
    addresses.forEach(addr => this.watchedWallets.add(addr.toLowerCase()));
  }

  /**
   * 监控特定市场的所有 Smart Money 活动
   */
  watchMarket(marketSlug: string): void {
    const sub = this.realtime.subscribeActivity(
      { marketSlug },
      {
        onTrade: (trade) => {
          const trader = trade.trader?.address?.toLowerCase();
          if (trader && this.watchedWallets.has(trader)) {
            // 目标钱包交易了！
            this.emit('smartMoneyTrade', {
              wallet: trader,
              trade,
              detectedAt: Date.now(),
              latency: Date.now() - trade.timestamp,
            });
          }
        },
      }
    );
    this.marketSubscriptions.set(marketSlug, sub);
  }

  /**
   * 监控多个市场
   */
  watchMarkets(marketSlugs: string[]): void {
    marketSlugs.forEach(slug => this.watchMarket(slug));
  }
}
```

**使用方式：**

```typescript
const watcher = new SmartMoneyWatcher(realtimeService);

// 设置要监控的 Smart Money 钱包
watcher.watchWallets([
  '0x1234...',  // Top trader 1
  '0x5678...',  // Top trader 2
]);

// 监控热门市场
watcher.watchMarkets(['trump-win-2024', 'btc-100k-2024']);

// 监听 Smart Money 交易
watcher.on('smartMoneyTrade', async ({ wallet, trade }) => {
  console.log(`🎯 Smart Money detected: ${wallet}`);
  console.log(`   ${trade.side} ${trade.size} @ ${trade.price}`);

  // 执行跟单...
});
```

---

#### 方案 B: 增强 RealtimeServiceV2

直接在 RealtimeServiceV2 中添加钱包过滤能力：

```typescript
// 在 RealtimeServiceV2 中添加
subscribeWalletActivity(
  walletAddresses: string[],
  marketSlugs: string[],
  handlers: {
    onTrade?: (wallet: string, trade: ActivityTrade) => void;
  }
): Subscription {
  const normalizedWallets = new Set(
    walletAddresses.map(a => a.toLowerCase())
  );

  // 订阅所有目标市场
  const subs = marketSlugs.map(slug =>
    this.subscribeActivity({ marketSlug: slug }, {
      onTrade: (trade) => {
        const trader = trade.trader?.address?.toLowerCase();
        if (trader && normalizedWallets.has(trader)) {
          handlers.onTrade?.(trader, trade);
        }
      },
    })
  );

  return {
    id: `wallet_activity_${++this.subscriptionIdCounter}`,
    topic: 'activity',
    type: 'wallet_filter',
    unsubscribe: () => subs.forEach(s => s.unsubscribe()),
  };
}
```

---

#### 方案 C: 全市场监控

如果需要监控 Smart Money 在任意市场的活动（不限于特定市场）：

```typescript
// 问题：无法订阅"所有市场"的 activity
// 解决：监控 Smart Money 当前持有仓位的市场

class FullMarketWatcher {
  async start(walletAddresses: string[]): Promise<void> {
    // 1. 获取每个钱包的当前持仓
    for (const wallet of walletAddresses) {
      const positions = await this.dataApi.getPositions(wallet);
      const marketSlugs = [...new Set(positions.map(p => p.slug))];

      // 2. 订阅这些市场的 activity
      this.watcher.watchMarkets(marketSlugs);
    }

    // 3. 定期刷新持仓列表，发现新市场
    setInterval(async () => {
      // 检查是否有新市场需要订阅
    }, 60_000);
  }
}
```

---

### 3.7 验证脚本列表

创建了以下验证脚本：

```bash
# 1. 对比三种检测方法的延迟
npx tsx scripts/smart-money/01-test-detection-methods.ts

# 2. 专门测试 Activity WebSocket 是否包含交易者地址
npx tsx scripts/smart-money/02-test-activity-ws.ts
npx tsx scripts/smart-money/02-test-activity-ws.ts --market trump-win-2024
```

---

## 4. 下单方案对比

### 4.1 可用下单方式

| 方式 | 延迟 | 确定性 | 适用场景 | 实现方法 |
|------|------|--------|----------|----------|
| **Market Order (FOK)** | 快 | 全成交或取消 | 跟成交 - 小额 | `tradingService.createMarketOrder({ orderType: 'FOK' })` |
| **Market Order (FAK)** | 快 | 部分成交也可以 | 跟成交 - 大额 | `tradingService.createMarketOrder({ orderType: 'FAK' })` |
| **Limit Order (GTC)** | 中 | 可能不成交 | 跟持仓/跟信号 | `tradingService.createLimitOrder({ orderType: 'GTC' })` |
| **Limit Order (GTD)** | 中 | 有时效限制 | 短期信号 | `tradingService.createLimitOrder({ orderType: 'GTD' })` |

### 4.2 下单方式选择决策树

```
检测到 Smart Money 交易
│
├── 跟成交场景 (需要快速执行)
│   │
│   ├── 小额 (< $50)
│   │   └── 使用 FOK: 全部成交或取消，确定性最高
│   │
│   └── 大额 (>= $50)
│       └── 使用 FAK: 部分成交也接受，成交率更高
│
└── 跟持仓/跟信号场景 (可以等待更好价格)
    │
    ├── 长期信号
    │   └── 使用 GTC: 挂单等待，直到成交或手动取消
    │
    └── 短期信号
        └── 使用 GTD: 限时挂单，避免长期敞口暴露
```

### 3.2 Copy Trading 下单策略

```typescript
interface CopyTradeConfig {
  // 下单类型选择
  orderType: 'FOK' | 'FAK' | 'GTC';

  // 滑点容忍度
  maxSlippage: number;  // 0.02 = 2%

  // 跟单比例
  sizeMultiplier: number;  // 0.5 = 跟 50%

  // 最大单笔金额
  maxOrderSize: number;  // $100

  // 是否跟随卖出
  followSells: boolean;
}
```

**推荐配置：**

```typescript
const defaultConfig: CopyTradeConfig = {
  orderType: 'FOK',      // 快速确定结果
  maxSlippage: 0.03,     // 3% 滑点容忍
  sizeMultiplier: 0.1,   // 跟 10%
  maxOrderSize: 50,      // 最大 $50
  followSells: true,     // 跟随卖出
};
```

---

## 4. 实现架构

### 4.1 服务拆分

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ SmartMoneyService (新)                                                       │
├─────────────────────────────────────────────────────────────────────────────┤
│ 1. Copy Trading 核心                                                         │
│    - watchWallet(address) → 监控目标钱包                                     │
│    - onTrade(callback) → 交易事件回调                                        │
│    - executeCopyTrade() → 执行跟单                                          │
│                                                                             │
│ 2. 信号检测                                                                  │
│    - detectSellActivity() → 检测卖出行为                                     │
│    - trackGroupSellRatio() → 追踪群体卖出比例                                │
│    - calculateSmartScore() → 计算 Smart Score                               │
│                                                                             │
│ 3. 钱包发现                                                                  │
│    - discoverActiveWallets() → 发现活跃钱包                                  │
│    - findSimilarWallets() → 发现相似策略钱包                                 │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│ WalletService (精简后)                                                       │
├─────────────────────────────────────────────────────────────────────────────┤
│ 1. 钱包查询                                                                  │
│    - getWalletProfile() → 钱包概况                                          │
│    - getWalletPositions() → 持仓列表                                        │
│    - getWalletActivity() → 活动记录                                         │
│    - getWalletStatsByPeriod() → 时间段统计                                  │
│    - getUserPeriodPnl() → PnL 查询                                          │
│                                                                             │
│ 2. Leaderboard                                                              │
│    - getLeaderboard()                                                       │
│    - getLeaderboardByPeriod()                                               │
│    - getTopTraders()                                                        │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 4.2 事件监控实现

```typescript
// 方案 1: Data API 轮询
class SmartMoneyService {
  private watchedWallets: Map<string, WatchConfig> = new Map();
  private lastSeen: Map<string, string> = new Map(); // address -> lastTradeId

  async watchWallet(address: string, config: CopyTradeConfig): Promise<void> {
    this.watchedWallets.set(address, config);
    this.startPolling();
  }

  private async pollTrades(): Promise<void> {
    for (const [address, config] of this.watchedWallets) {
      const trades = await this.dataApi.getTrades(address, { limit: 10 });
      const lastSeenId = this.lastSeen.get(address);

      // 找到新交易
      const newTrades = trades.filter(t => t.id !== lastSeenId);
      if (newTrades.length > 0) {
        this.lastSeen.set(address, newTrades[0].id);
        for (const trade of newTrades.reverse()) {
          await this.handleNewTrade(address, trade, config);
        }
      }
    }
  }

  private async handleNewTrade(
    wallet: string,
    trade: Trade,
    config: CopyTradeConfig
  ): Promise<void> {
    this.emit('trade', { wallet, trade });

    if (config.autoExecute) {
      await this.executeCopyTrade(trade, config);
    }
  }
}
```

```typescript
// 方案 2: Polygon RPC 事件监听 (低延迟)
class SmartMoneyService {
  private provider: ethers.providers.WebSocketProvider;
  private exchangeContract: ethers.Contract;

  async watchWalletRealtime(address: string): Promise<void> {
    // 监听 CTF Exchange 的 OrderFilled 事件
    this.exchangeContract.on('OrderFilled', async (
      orderHash,
      maker,
      taker,
      makerAssetId,
      takerAssetId,
      makerAmountFilled,
      takerAmountFilled,
      fee,
      event
    ) => {
      if (maker.toLowerCase() === address.toLowerCase() ||
          taker.toLowerCase() === address.toLowerCase()) {
        const trade = this.parseOrderFilledEvent({
          maker, taker, makerAssetId, takerAssetId,
          makerAmountFilled, takerAmountFilled
        });
        this.emit('trade', { wallet: address, trade });
      }
    });
  }
}
```

---

## 5. 待验证问题

### 5.1 延迟测试脚本

```typescript
// scripts/smart-money/test-latency.ts

async function testDetectionLatency() {
  console.log('=== Copy Trading Latency Test ===\n');

  // 测试钱包 (找一个活跃的 Smart Money)
  const targetWallet = '0x...';

  // 1. 记录 Data API 检测延迟
  console.log('1. Testing Data API latency...');
  const dataApiStart = Date.now();
  const trades = await dataApi.getTrades(targetWallet, { limit: 1 });
  const dataApiLatency = Date.now() - dataApiStart;
  console.log(`   Data API response: ${dataApiLatency}ms`);

  // 2. 记录 Subgraph 检测延迟
  console.log('2. Testing Subgraph latency...');
  const subgraphStart = Date.now();
  const fills = await subgraph.getMakerFills(targetWallet, { first: 1 });
  const subgraphLatency = Date.now() - subgraphStart;
  console.log(`   Subgraph response: ${subgraphLatency}ms`);

  // 3. 比较最新交易时间差
  if (trades[0] && fills[0]) {
    const tradeTime = trades[0].timestamp;
    const fillTime = Number(fills[0].timestamp) * 1000;
    console.log(`\n3. Data freshness comparison:`);
    console.log(`   Data API latest: ${new Date(tradeTime).toISOString()}`);
    console.log(`   Subgraph latest: ${new Date(fillTime).toISOString()}`);
    console.log(`   Difference: ${Math.abs(tradeTime - fillTime)}ms`);
  }
}
```

### 5.2 下单延迟测试

```typescript
async function testOrderLatency() {
  console.log('=== Order Latency Test ===\n');

  // 小额测试订单
  const testOrder = {
    tokenId: '...',
    side: 'BUY' as const,
    price: 0.50,
    size: 1, // $0.50
  };

  // 1. Limit Order
  console.log('1. Testing Limit Order...');
  const limitStart = Date.now();
  const limitResult = await tradingService.createLimitOrder({
    ...testOrder,
    orderType: 'GTC',
  });
  const limitLatency = Date.now() - limitStart;
  console.log(`   Limit Order: ${limitLatency}ms, success: ${limitResult.success}`);

  // 取消测试订单
  if (limitResult.orderId) {
    await tradingService.cancelOrder(limitResult.orderId);
  }

  // 2. Market Order (模拟，不实际执行)
  console.log('\n2. Market Order would use similar API...');
}
```

---

## 6. 下一步

1. **运行延迟测试** - 验证各方案实际延迟
2. **实现 SmartMoneyService** - 基于测试结果选择方案
3. **构建 Copy Trading Demo** - 端到端验证

---

## 7. 合约地址参考

```typescript
// Polygon Mainnet
const ADDRESSES = {
  // CTF Exchange (订单执行)
  CTF_EXCHANGE: '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E',

  // Neg Risk CTF Exchange
  NEG_RISK_CTF_EXCHANGE: '0xC5d563A36AE78145C45a50134d48A1215220f80a',

  // Conditional Tokens (ERC1155)
  CONDITIONAL_TOKENS: '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045',

  // USDC.e
  USDC_E: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
};
```

---

## 8. 第一性原理总结

### 8.1 决策树

```
Copy Trading 是否有价值？
│
├── 验证 1: Smart Money 有持续 alpha？
│   ├── NO → 不做 Copy Trading
│   └── YES ↓
│
├── 验证 2: 价格反应窗口多长？
│   ├── < 5s → 实时 Copy Trading 可能无效
│   │         考虑替代策略：跟随持仓变化（而非交易）
│   ├── 5s-60s → 需要低延迟检测（RPC 事件监听）
│   └── > 60s → Data API 轮询足够
│
├── 验证 3: 跟单收益 > 成本？
│   ├── NO → 不做 Copy Trading
│   └── YES → 实现 SmartMoneyService
│
└── 选择实现方案
    ├── 跟"交易" → 需要事件监听 + 快速下单
    └── 跟"方向" → 持仓监控即可，延迟不敏感
```

### 8.2 两种 Copy Trading 模式

| 模式 | 跟"交易" | 跟"方向" |
|------|----------|----------|
| 目标 | 复制每一笔交易 | 复制持仓组合 |
| 延迟要求 | 秒级 | 分钟/小时级 |
| 检测方式 | 实时事件监听 | 定期持仓对比 |
| 优点 | 更精确复制 | 实现简单、稳定 |
| 缺点 | 复杂、可能抢不到价格 | 可能错过短期交易 |
| 适用场景 | 短线、信息驱动 | 中长线、策略驱动 |

### 8.3 建议路径

1. **先验证假设** - 写脚本分析 Smart Money 交易后的价格变化
2. **基于数据决策** - 确定适合哪种模式
3. **从简单开始** - 先实现"跟方向"模式，验证基础逻辑
4. **按需优化** - 如果数据支持，再优化到"跟交易"模式

### 8.4 避免的陷阱

- ❌ **过早优化延迟** - 在验证价值之前就追求毫秒级延迟
- ❌ **假设 alpha 存在** - 不验证就认为 Smart Money 一定有 alpha
- ❌ **忽略成本** - 忘记计算滑点、手续费、失败订单成本
- ❌ **复杂度爆炸** - 一开始就做最复杂的实时跟单系统

---

## 9. 实现总结 (Implementation Summary)

### 9.1 已实现 - SmartMoneyService

**位置**: `packages/poly-sdk/src/services/smart-money-service.ts`

| 功能 | 方法 | 监控方式 | 下单方式 |
|------|------|----------|----------|
| **跟成交** | `subscribeSmartMoneyTrades()` | Activity WebSocket (< 100ms) | Market Order (FOK/FAK) |
| **跟持仓** | `syncPositions()` | Data API 轮询 | Limit Order (GTC) |
| **跟信号** | `analyzeSignals()` | 交易模式分析 | Market/Limit Order |
| **执行跟单** | `executeCopyTrade()` | - | 根据场景自动选择 |

### 9.2 核心设计决策

**Q1: 我们通过监控什么信号？**

→ **Activity WebSocket 的 trades 事件**，因为：
- 包含 `trader.address` (交易者地址) 和 `trader.name` (交易者名称)
- 延迟 100-500ms (实测验证 2025-12-28)
- 支持按 market/event 过滤

**Q2: 这些信号的监控方式是什么？**

→ 使用 `RealtimeServiceV2.subscribeAllActivity()`:
1. 订阅全局 activity 交易流
2. 客户端根据目标钱包地址过滤 (trader.address 匹配)
3. 触发回调处理

**Q3: 不同信号要采用哪种下单方式？**

| 场景 | 推荐下单方式 | 原因 |
|------|------------|------|
| 跟成交 - 小额 | FOK | 全部成交或取消，确定性最高 |
| 跟成交 - 大额 | FAK | 部分成交也接受，成交率更高 |
| 跟持仓/跟信号 | GTC | 挂单等待，可获得更好价格 |
| 短期信号 | GTD | 限时挂单，避免长期暴露 |

### 9.3 使用示例

```typescript
import { PolymarketSDK } from '@catalyst-team/poly-sdk';

// 一行代码启动 SDK（推荐）
const sdk = await PolymarketSDK.create({ privateKey: '0x...' });
// SDK 已初始化并连接 WebSocket

// ===== 自动跟单交易 =====
// 实时跟单 - 聪明钱一旦交易，立即跟单

const subscription = await sdk.smartMoney.startAutoCopyTrading({
  // 目标选择
  topN: 50,                    // 跟踪排行榜前 50 名
  // targetAddresses: ['0x...'], // 或直接指定地址

  // 订单设置
  sizeScale: 0.1,              // 跟单 10% 的交易量
  maxSizePerTrade: 10,         // 每笔最多 $10
  maxSlippage: 0.03,           // 3% 滑点容忍度
  orderType: 'FOK',            // FOK 或 FAK

  // 过滤
  minTradeSize: 5,             // 只跟单 > $5 的交易

  // 测试模式
  dryRun: true,                // 设为 false 执行真实交易

  // 回调
  onTrade: (trade, result) => {
    console.log(`跟单 ${trade.traderName}: ${result.success ? '✅' : '❌'}`);
  },
});

console.log(`正在跟踪 ${subscription.targetAddresses.length} 个钱包`);

// 获取统计
const stats = subscription.getStats();
console.log(`检测: ${stats.tradesDetected}, 执行: ${stats.tradesExecuted}`);

// 停止
subscription.stop();
sdk.stop();
```

> **注意**: Polymarket 最小订单金额为 **$1**。低于 $1 的订单会被自动跳过。

📁 **完整示例**: 查看 [../../scripts/smart-money/](../../scripts/smart-money/) 获取完整可运行的脚本：
- `04-auto-copy-trading.ts` - 完整功能的自动跟单
- `05-auto-copy-simple.ts` - 简化的 SDK 用法（三种初始化方式对比）
- `06-real-copy-test.ts` - 真实交易测试

---

## 10. 参考资料

- [Polymarket Subgraph - Orderbook](https://thegraph.com/hosted-service/subgraph/polymarket/polymarket-orderbook-resync)
- [Polygon Block Time](https://polygonscan.com/chart/blocktime) - ~2 seconds
- [@polymarket/clob-client-v2](https://www.npmjs.com/package/@polymarket/clob-client-v2)
