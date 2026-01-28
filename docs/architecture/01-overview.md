# poly-sdk 架构设计 v2

> Service 层职责划分与方法清单

---

## 1. 架构概览

```
┌─────────────────────────────────────────────────────────────┐
│                        MCP Layer                            │
│  (poly-mcp: MCP tools for AI agents)                       │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                      Service Layer                          │
│  ┌─────────────────┐ ┌─────────────────┐ ┌───────────────┐ │
│  │  TradingService │ │  MarketService  │ │ WalletService │ │
│  │   (交易执行)    │ │  (市场数据)     │ │  (钱包查询)   │ │
│  └─────────────────┘ └─────────────────┘ └───────────────┘ │
│  ┌─────────────────┐ ┌─────────────────┐ ┌───────────────┐ │
│  │SmartMoneyService│ │RealtimeServiceV2│ │ArbitrageService│ │
│  │  (跟单/检测)    │ │  (实时数据流)   │ │  (套利执行)   │ │
│  └─────────────────┘ └─────────────────┘ └───────────────┘ │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                      Client Layer                           │
│  ┌────────────────┐ ┌────────────────┐ ┌────────────────┐  │
│  │  ClobClient    │ │ GammaApiClient │ │ DataApiClient  │  │
│  │  (官方交易)    │ │ (市场发现)     │ │ (排行榜/历史)  │  │
│  └────────────────┘ └────────────────┘ └────────────────┘  │
│  ┌────────────────┐ ┌────────────────┐ ┌────────────────┐  │
│  │ SubgraphClient │ │   CTFClient    │ │  BridgeClient  │  │
│  │  (链上数据)    │ │ (Split/Merge)  │ │  (跨链存款)    │  │
│  └────────────────┘ └────────────────┘ └────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. Service 职责边界

| Service | 核心职责 | 依赖 |
|---------|----------|------|
| **TradingService** | 订单执行、订单管理、账户余额 | ClobClient |
| **MarketService** | 市场查询、订单簿、K线、套利检测 | GammaApi, DataApi, ClobClient |
| **WalletService** | 钱包查询、排行榜、PnL统计 | DataApi, Subgraph |
| **SmartMoneyService** | Smart Money 检测、跟单、卖出检测 | WalletService, RealtimeServiceV2, TradingService |
| **RealtimeServiceV2** | WebSocket 实时数据订阅 | official real-time-data-client |
| **ArbitrageService** | 套利扫描、套利执行 | MarketService, TradingService, CTFClient |

---

## 3. TradingService 方法清单

> **职责**: 订单执行、订单管理、账户信息

### 3.1 初始化

| 方法 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `initialize()` | - | `Promise<void>` | 初始化 ClobClient 和 API 凭证 |
| `ensureInitialized()` | - | `Promise<ClobClient>` | 确保已初始化，返回 ClobClient |

### 3.2 订单创建

| 方法 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `createLimitOrder(params)` | `LimitOrderParams` | `Promise<OrderResult>` | 创建限价单 (GTC/GTD) |
| `createMarketOrder(params)` | `MarketOrderParams` | `Promise<OrderResult>` | 创建市价单 (FOK/FAK) |

### 3.3 订单管理

| 方法 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `cancelOrder(orderId)` | `string` | `Promise<OrderResult>` | 取消单个订单 |
| `cancelOrders(orderIds)` | `string[]` | `Promise<OrderResult>` | 批量取消订单 |
| `cancelAllOrders()` | - | `Promise<OrderResult>` | 取消所有订单 |
| `getOpenOrders(marketId?)` | `string?` | `Promise<Order[]>` | 查询挂单 |
| `getTrades(marketId?)` | `string?` | `Promise<TradeInfo[]>` | 查询成交记录 |

### 3.4 交易辅助

| 方法 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `getTickSize(tokenId)` | `string` | `Promise<TickSize>` | 获取价格精度 |
| `isNegRisk(tokenId)` | `string` | `Promise<boolean>` | 检查是否 neg risk 市场 |

### 3.5 奖励相关

| 方法 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `isOrderScoring(orderId)` | `string` | `Promise<boolean>` | 订单是否计分 |
| `areOrdersScoring(orderIds)` | `string[]` | `Promise<Record<string, boolean>>` | 批量检查计分 |
| `getEarningsForDay(date)` | `string` | `Promise<UserEarning[]>` | 获取某日收益 |
| `getCurrentRewards()` | - | `Promise<MarketReward[]>` | 当前有奖励的市场 |

### 3.6 账户管理

| 方法 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `getBalanceAllowance(assetType, tokenId?)` | `string, string?` | `Promise<{balance, allowance}>` | 查询余额和授权 |
| `updateBalanceAllowance(assetType, tokenId?)` | `string, string?` | `Promise<void>` | 更新授权 |
| `getAddress()` | - | `string` | 获取钱包地址 |
| `getCredentials()` | - | `ApiCredentials \| null` | 获取 API 凭证 |
| `isInitialized()` | - | `boolean` | 是否已初始化 |
| `getClobClient()` | - | `ClobClient \| null` | 获取底层客户端 |

---

## 4. MarketService 方法清单

> **职责**: 市场查询、订单簿分析、K线、套利检测

### 4.1 市场查询

| 方法 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `getMarket(identifier)` | `string` (slug 或 conditionId) | `Promise<UnifiedMarket>` | 获取市场信息 |
| `searchMarkets(params)` | `SearchParams` | `Promise<GammaMarket[]>` | 搜索市场 |
| `getTrendingMarkets(limit?)` | `number?` | `Promise<GammaMarket[]>` | 热门市场 |

### 4.2 订单簿

| 方法 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `getOrderbook(conditionId)` | `string` | `Promise<ProcessedOrderbook>` | 获取处理后的订单簿 |

### 4.3 K线数据

| 方法 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `getKLines(conditionId, interval, options?)` | `string, PriceHistoryIntervalString, options` | `Promise<PricePoint[]>` | 价格线 (from /prices-history) |
| `getDualKLines(conditionId, interval, options?)` | `string, PriceHistoryIntervalString, options` | `Promise<DualPriceLineData>` | 双价格线 (from /prices-history) |
| `getKLinesOHLCV(conditionId, interval, options?)` | `string, KLineInterval, options` | `Promise<KLineCandle[]>` | 单 Token OHLCV K线 (from /trades) |
| `getDualKLinesOHLCV(conditionId, interval, options?)` | `string, KLineInterval, options` | `Promise<DualKLineData>` | YES+NO 双 OHLCV K线 (from /trades) |

### 4.4 价差分析

| 方法 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `getRealtimeSpread(conditionId)` | `string` | `Promise<RealtimeSpreadAnalysis>` | 实时价差分析 |

### 4.5 套利检测

| 方法 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `detectArbitrage(conditionId, threshold?)` | `string, number?` | `Promise<ArbitrageOpportunity \| null>` | 检测套利机会 |

### 4.6 信号检测

| 方法 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `detectMarketSignals(conditionId)` | `string` | `Promise<MarketSignal[]>` | 检测市场信号 (量能、深度、鲸鱼) |

---

## 5. WalletService 方法清单

> **职责**: 钱包数据查询、排行榜、PnL 统计

### 5.1 钱包查询

| 方法 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `getWalletProfile(address)` | `string` | `Promise<WalletProfile>` | 钱包概况 (PnL, 胜率, SmartScore) |
| `getWalletPositions(address)` | `string` | `Promise<Position[]>` | 持仓列表 |
| `getPositionsForMarket(address, conditionId)` | `string, string` | `Promise<Position[]>` | 特定市场持仓 |
| `getWalletActivity(address, limit?)` | `string, number?` | `Promise<WalletActivitySummary>` | 活动历史 |

### 5.2 排行榜

| 方法 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `getLeaderboard(page?, pageSize?)` | `number?, number?` | `Promise<LeaderboardPage>` | 总排行榜 |
| `getTopTraders(limit?)` | `number?` | `Promise<LeaderboardEntry[]>` | Top 交易者 |
| `getLeaderboardByPeriod(period, limit?, sortBy?, category?)` | `TimePeriod, ...` | `Promise<PeriodLeaderboardEntry[]>` | 时间段排行榜 |

### 5.3 用户统计

| 方法 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `getUserPeriodPnl(address, period, category?)` | `string, TimePeriod, string?` | `Promise<PeriodLeaderboardEntry \| null>` | 用户时间段 PnL |
| `getWalletStatsByPeriod(address, period)` | `string, TimePeriod` | `Promise<WalletPeriodStats>` | 钱包时间段统计 |

### 5.4 钱包发现

| 方法 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `discoverActiveWallets(limit?)` | `number?` | `Promise<{address, tradeCount}[]>` | 发现活跃钱包 |

---

## 6. SmartMoneyService 方法清单

> **职责**: Smart Money 检测、实时跟踪、跟单执行

### 6.1 Smart Money 检测

| 方法 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `getSmartMoneyList(limit?)` | `number?` | `Promise<SmartMoneyWallet[]>` | 获取 Smart Money 列表 |
| `isSmartMoney(address)` | `string` | `Promise<boolean>` | 检查是否 Smart Money |
| `getSmartMoneyInfo(address)` | `string` | `Promise<SmartMoneyWallet \| null>` | 获取 Smart Money 信息 |

### 6.2 实时监控 (跟成交)

| 方法 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `subscribeSmartMoneyTrades(onTrade, options?)` | `callback, options` | `{id, unsubscribe}` | 订阅交易流 |

**options 参数:**
- `filterAddresses?: string[]` - 只监听指定地址
- `minSize?: number` - 最小交易量
- `smartMoneyOnly?: boolean` - 是否只看 Smart Money

### 6.3 持仓同步 (跟持仓)

| 方法 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `syncPositions(addresses)` | `string[]` | `Promise<PositionSnapshot[]>` | 批量同步持仓 |

### 6.4 信号分析 (跟信号)

| 方法 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `analyzeSignals(trades, options?)` | `SmartMoneyTrade[], options` | `TradingSignal[]` | 分析交易生成信号 |

### 6.5 跟单执行

| 方法 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `executeCopyTrade(signal, options?)` | `TradingSignal, CopyTradeOptions` | `Promise<OrderResult>` | 执行跟单 |

**CopyTradeOptions 参数:**
- `sizeScale?: number` - 仓位比例 (0.1 = 10%)
- `maxSize?: number` - 最大金额 (USDC)
- `maxSlippage?: number` - 最大滑点 (0.03 = 3%)
- `executionMode?: 'market' \| 'limit'` - 执行方式
- `marketOrderType?: 'FOK' \| 'FAK'` - 市价单类型
- `limitOrderType?: 'GTC' \| 'GTD'` - 限价单类型

### 6.6 卖出检测

| 方法 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `detectSellActivity(address, conditionId, since, peakValue?)` | `...` | `Promise<SellActivityResult>` | 检测卖出活动 |
| `trackGroupSellRatio(addresses, conditionId, peakTotal, since)` | `...` | `Promise<GroupSellResult>` | 跟踪群体卖出 |

### 6.7 生命周期

| 方法 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `disconnect()` | - | `void` | 断开连接，清理资源 |

---

## 7. RealtimeServiceV2 方法清单

> **职责**: WebSocket 实时数据订阅

### 7.1 连接管理

| 方法 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `connect()` | - | `void` | 建立 WebSocket 连接 |
| `disconnect()` | - | `void` | 断开连接 |
| `isConnected()` | - | `boolean` | 连接状态 |

### 7.2 订阅管理

| 方法 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `subscribeMarket(conditionId, callbacks)` | `string, callbacks` | `Subscription` | 订阅单个市场 |
| `subscribeMarkets(conditionIds, callbacks)` | `string[], callbacks` | `Subscription` | 批量订阅市场 |
| `subscribeAllActivity(callbacks)` | `callbacks` | `Subscription` | 订阅全局活动流 |
| `unsubscribeAll()` | - | `void` | 取消所有订阅 |

### 7.3 事件回调

```typescript
interface SubscriptionCallbacks {
  onPrice?: (price: PriceUpdate) => void;
  onBook?: (book: BookUpdate) => void;
  onTrade?: (trade: ActivityTrade) => void;
  onError?: (error: Error) => void;
}
```

---

## 8. 重构记录 (2025-12-28 完成)

### ✅ Phase 1: MarketService 增强 (已完成)

MarketService 现在直接使用 ClobClient，不再依赖 TradingService:

| 新方法 | 说明 |
|------|------|
| `getClobMarket(conditionId)` | 从 CLOB 获取市场信息 |
| `getClobMarkets(cursor)` | 批量获取市场 |
| `getTokenOrderbook(tokenId)` | 单 Token 订单簿 |
| `getTokenOrderbooks(params)` | 批量订单簿 |
| `getProcessedOrderbook(conditionId)` | 处理后订单簿 (含套利分析) |
| `getPricesHistory(params)` | 价格历史 |
| `getMidpoint(tokenId)` | 中间价 |
| `getSpread(tokenId)` | 价差 |
| `getLastTradePrice(tokenId)` | 最新成交价 |

**构造函数变更:**
```typescript
// 旧版
new MarketService(gammaApi, tradingService, dataApi, cache)

// 新版
new MarketService(gammaApi, dataApi, rateLimiter, cache, config?)
```

### ✅ Phase 2: SmartMoneyService 增强 (已完成)

SmartMoneyService 现在提供卖出检测方法 (委托给 WalletService):

| 方法 | 说明 |
|------|------|
| `detectSellActivity(address, conditionId, since, peak?)` | 检测单个钱包卖出活动 |
| `trackGroupSellRatio(addresses, conditionId, peak, since)` | 跟踪群体卖出 |

### ✅ Phase 3: 调用方更新 (已完成)

| 文件 | 变更 |
|------|------|
| `src/index.ts` | MarketService 构造函数已更新 |
| `market-service.ts` | 不再导入 TradingService |

---

## 9. 依赖关系图 (重构后)

```
                    Application
                        │
         ┌──────────────┼──────────────┐
         │              │              │
         ▼              ▼              ▼
┌─────────────┐  ┌─────────────┐  ┌─────────────┐
│SmartMoney   │  │  Market     │  │  Trading    │
│Service      │  │  Service    │  │  Service    │
└──────┬──────┘  └──────┬──────┘  └──────┬──────┘
       │                │                │
       │         ┌──────┴──────┐         │
       │         │             │         │
       ▼         ▼             ▼         ▼
┌─────────────┐  ┌─────────┐  ┌─────────────────┐
│  Wallet     │  │ Gamma   │  │   ClobClient    │
│  Service    │  │ ApiClient│  │   (官方)       │
└──────┬──────┘  └─────────┘  └─────────────────┘
       │
       ▼
┌─────────────┐
│  DataApi    │
│  Subgraph   │
└─────────────┘
```

---

## 10. 关键发现 (2025-12-28)

### Activity WebSocket 限制

| 验证方式 | 能看到自己的交易? |
|---------|------------------|
| Activity WebSocket | **否** |
| `getTrades()` API | 是 |
| `clob_user` topic (需认证) | 是 |

### 跟单验证最快方式

```typescript
// createMarketOrder 返回值直接判断成功
const result = await tradingService.createMarketOrder(params);
if (result.success && result.transactionHashes?.length) {
  // 已成交，无需额外 API 调用
}
```

### 执行延迟

从收到信号到订单成交: **约 2 秒**
