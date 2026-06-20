# Polymarket 数据模型设计

> 基于第一性原理和 API 验证结果的数据模型设计
> 创建时间：2025-12-26

---

## 设计原则

### 1. 第一性原理

```
预测市场原理 → Polymarket 实现 → API 验证 → 数据分类 → 数据结构设计 → SDK 架构
     ↓              ↓              ↓           ↓             ↓            ↓
    CTF          Gamma/         实际调用      用户视角      规范化类型    模块划分
   CLOB          CLOB/          验证结构      分类数据
   UMA          Data API
```

### 2. Don't Trust, Verify

所有数据结构基于：
1. **官方文档** (https://docs.polymarket.com/)
2. **实际 API 调用验证**
3. **运行验证脚本确认**

---

## 1. 预测市场核心原理

### 1.1 CTF (Conditional Token Framework)

```
┌─────────────────────────────────────────────────────────────────┐
│                    CTF 核心机制                                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  核心等式: YES token + NO token = 1 pUSD                        │
│                                                                  │
│  三个核心操作:                                                   │
│  ┌─────────┐   ┌─────────┐   ┌─────────┐                        │
│  │  Split  │   │  Merge  │   │ Redeem  │                        │
│  │ 1 pUSD  │   │ YES+NO  │   │ Winner  │                        │
│  │→YES+NO  │   │→1 pUSD  │   │→1 pUSD  │                        │
│  └─────────┘   └─────────┘   └─────────┘                        │
│                                                                  │
│  Token 结构:                                                     │
│  - ERC-1155 标准                                                │
│  - PositionId = f(conditionId, collateral, indexSet)            │
│  - indexSet: 1=YES, 2=NO                                        │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

**SDK 设计启示**：
- 必须同时跟踪 YES 和 NO token
- 价格关系约束: priceYes + priceNo ≈ 1
- 需要支持 split/merge/redeem 操作查询

### 1.2 CLOB (Central Limit Order Book)

```
┌─────────────────────────────────────────────────────────────────┐
│                    CLOB 混合架构                                 │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  链下撮合 + 链上结算                                             │
│                                                                  │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐       │
│  │   用户签名    │ →  │   CLOB 撮合   │ →  │   链上结算    │       │
│  │  EIP-712     │    │   Off-chain  │    │   Polygon    │       │
│  └──────────────┘    └──────────────┘    └──────────────┘       │
│                                                                  │
│  订单簿镜像:                                                     │
│  - 买 YES @ P = 卖 NO @ (1-P)                                   │
│  - 深度合并计算                                                  │
│                                                                  │
│  认证级别:                                                       │
│  - Public: 读取市场数据                                          │
│  - L1: 初始设置 (钱包签名)                                       │
│  - L2: 交易操作 (API 凭证)                                       │
│  - Builder: 订单归因                                             │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

**SDK 设计启示**：
- 需要处理多种认证级别
- 订单簿数据需要合并 YES/NO 视图
- 实时数据需要 WebSocket 支持

### 1.3 UMA (Optimistic Oracle)

```
┌─────────────────────────────────────────────────────────────────┐
│                    UMA 结算机制                                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  乐观预言机:                                                     │
│  - 提议 → 2h challenge → 无争议结算；被争议才进入 UMA DVM 流程     │
│  - 争议需要 bond (通常 $99,750)                                  │
│                                                                  │
│  结算结果:                                                       │
│  - 0 = NO wins (NO token → 1 pUSD)                              │
│  - 1 = YES wins (YES token → 1 pUSD)                            │
│                                                                  │
│  相关字段 (Gamma API):                                           │
│  - umaEndDate                                                   │
│  - umaResolutionStatus                                          │
│  - umaBond                                                      │
│  - umaReward                                                    │
│  - resolvedBy                                                   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

**SDK 设计启示**：
- 需要跟踪结算状态
- 2h challenge 期间及争议升级期间市场状态需按 API 字段动态判断
- 结算后需要查询 Subgraph 获取历史数据

---

## 2. 数据域分类 (用户视角)

### 2.1 Market 数据 (市场类)

**用途**: 市场发现、信息展示、交易准备

**数据来源**:
| 数据 | Gamma API | CLOB API | 选择建议 |
|------|-----------|----------|---------|
| 市场搜索/发现 | ✅ 主要 | ❌ | 用 Gamma |
| 事件分组 | ✅ 主要 | ❌ | 用 Gamma |
| 丰富元数据 | ✅ 70+ 字段 | ❌ 30 字段 | 用 Gamma |
| 实时价格 | ⚠️ lastTradePrice | ✅ token.price | 用 CLOB |
| 订单簿 | ❌ | ✅ 主要 | 用 CLOB |
| 交易参数 | ✅ 有 | ✅ 更准确 | 用 CLOB |

### 2.2 Wallet 数据 (状态类)

**用途**: 用户资产管理、持仓查看、PnL 跟踪

**数据来源**: Data API

| 数据 | 端点 | 关键参数 |
|------|------|---------|
| 持仓 | `/positions` | user, sortBy, limit, offset |
| 账户价值 | `/value` | user, market |
| 排名 | `/v1/leaderboard` | category, timePeriod |

### 2.3 Behavior 数据 (事件类)

**用途**: 交易历史、活动记录、策略分析

**数据来源**: Data API + Subgraph

| 数据 | 端点 | 关键参数 |
|------|------|---------|
| 活动记录 | `/activity` | user, start, end, type |
| 交易记录 | `/trades` | user, market, side |
| 持仓者分布 | `/holders` | market, limit |
| 历史 PnL | Subgraph | - |

---

## 3. 规范化数据结构

### 3.1 设计原则

```typescript
// 1. 原始结构 (Raw) - 直接映射 API 返回
interface GammaMarketRaw {
  outcomes: string;        // JSON 字符串 '["Yes", "No"]'
  outcomePrices: string;   // JSON 字符串 '["0.65", "0.35"]'
  volume: string;          // string 类型
  // ...
}

// 2. 规范化结构 (Normalized) - 用户友好
interface Market {
  outcomes: string[];      // 解析后数组
  outcomePrices: number[]; // 解析并转换
  volume: number;          // 转为 number
  // ...
}

// 3. 转换函数
function normalizeMarket(raw: GammaMarketRaw): Market {
  return {
    outcomes: JSON.parse(raw.outcomes),
    outcomePrices: JSON.parse(raw.outcomePrices).map(Number),
    volume: Number(raw.volume),
  };
}
```

### 3.2 Market 规范化结构

```typescript
/**
 * 规范化的市场结构
 * 合并 Gamma + CLOB 数据
 */
interface Market {
  // === 标识 ===
  id: string;
  conditionId: string;
  slug: string;
  questionId: string;

  // === 内容 ===
  question: string;
  description: string;
  image: string;
  icon: string;

  // === 结果 (已解析!) ===
  outcomes: string[];           // ["Yes", "No"]
  outcomePrices: number[];      // [0.65, 0.35]

  // === Tokens (合并结构) ===
  tokens: MarketToken[];

  // === 价格 ===
  lastTradePrice: number;
  bestBid: number;
  bestAsk: number;
  spread: number;
  priceChange: PriceChange;

  // === 成交量 ===
  volume: number;
  volume24h: number;
  volume1wk: number;
  volume1mo: number;

  // === 交易参数 ===
  minOrderSize: number;
  tickSize: number;
  makerFee: number;
  takerFee: number;

  // === 状态 ===
  status: MarketStatus;

  // === 时间 (统一为 Date) ===
  startDate: Date;
  endDate: Date;
  createdAt: Date;
  updatedAt: Date;
  closedAt?: Date;

  // === 结算 ===
  settlement?: MarketSettlement;

  // === Neg-Risk ===
  negRisk: boolean;
  negRiskMarketId?: string;

  // === 关联 ===
  eventId?: string;
  eventSlug?: string;
}

interface MarketToken {
  tokenId: string;
  outcome: string;            // "Yes" | "No"
  price: number;
  isWinner?: boolean;
}

interface PriceChange {
  oneHour: number;
  oneDay: number;
  oneWeek: number;
  oneMonth: number;
}

type MarketStatus = 'active' | 'closed' | 'resolved' | 'archived';

interface MarketSettlement {
  status: 'pending' | 'disputed' | 'resolved';
  endDate?: Date;
  bond: number;
  reward: number;
  resolvedBy?: string;
}
```

### 3.3 Position 规范化结构

```typescript
/**
 * 规范化的持仓结构
 */
interface Position {
  // === 标识 ===
  walletAddress: string;
  tokenId: string;
  conditionId: string;

  // === 持仓 ===
  size: number;
  avgPrice: number;
  currentPrice: number;

  // === 价值 ===
  initialValue: number;
  currentValue: number;

  // === PnL ===
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
  realizedPnl: number;
  realizedPnlPercent: number;

  // === 市场信息 ===
  market: PositionMarketInfo;

  // === 状态 ===
  redeemable: boolean;
  mergeable: boolean;
}

interface PositionMarketInfo {
  title: string;
  slug: string;
  icon: string;
  eventSlug: string;
  outcome: string;
  outcomeIndex: number;
  oppositeOutcome: string;
  oppositeTokenId: string;
  endDate: Date;
  negativeRisk: boolean;
}
```

### 3.4 Trade 规范化结构

```typescript
/**
 * 规范化的交易结构
 */
interface Trade {
  // === 交易信息 ===
  transactionHash: string;
  timestamp: Date;              // 统一为 Date!
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  value: number;                // size * price

  // === 市场信息 ===
  conditionId: string;
  tokenId: string;
  outcome: string;
  outcomeIndex: number;

  // === 市场元数据 ===
  market: TradeMarketInfo;

  // === 交易者信息 ===
  trader: TraderInfo;
}

interface TradeMarketInfo {
  title: string;
  slug: string;
  icon: string;
  eventSlug: string;
}

interface TraderInfo {
  address: string;
  name?: string;
  pseudonym?: string;
  profileImage?: string;
}
```

### 3.5 Activity 规范化结构

```typescript
/**
 * 规范化的活动结构
 */
interface Activity {
  // === 活动信息 ===
  transactionHash: string;
  timestamp: Date;
  type: ActivityType;

  // === 交易详情 (type=TRADE 时) ===
  side?: 'BUY' | 'SELL';
  price?: number;
  size?: number;
  usdcSize?: number;

  // === 市场信息 ===
  conditionId: string;
  tokenId: string;
  outcome: string;
  outcomeIndex: number;
  market: ActivityMarketInfo;

  // === 用户信息 ===
  walletAddress: string;
  user?: ActivityUserInfo;
}

type ActivityType =
  | 'TRADE'
  | 'SPLIT'
  | 'MERGE'
  | 'REDEEM'
  | 'REWARD'
  | 'CONVERSION';

interface ActivityMarketInfo {
  title: string;
  slug: string;
  icon: string;
  eventSlug: string;
}

interface ActivityUserInfo {
  name?: string;
  pseudonym?: string;
  bio?: string;
  profileImage?: string;
}
```

### 3.6 Leaderboard 规范化结构

```typescript
/**
 * 规范化的排行榜结构
 */
interface LeaderboardEntry {
  rank: number;                 // 转为 number!
  walletAddress: string;
  userName: string;
  volume: number;
  pnl: number;
  profileImage?: string;
  xUsername?: string;
  verified: boolean;
}

interface LeaderboardQuery {
  category?: LeaderboardCategory;
  timePeriod?: LeaderboardTimePeriod;
  orderBy?: 'PNL' | 'VOL';
  limit?: number;
  offset?: number;
  user?: string;
  userName?: string;
}

type LeaderboardCategory =
  | 'OVERALL'
  | 'POLITICS'
  | 'SPORTS'
  | 'CRYPTO'
  | 'CULTURE'
  | 'WEATHER'
  | 'ECONOMICS'
  | 'TECH'
  | 'FINANCE';

type LeaderboardTimePeriod = 'DAY' | 'WEEK' | 'MONTH' | 'ALL';
```

---

## 4. 数据转换工具

### 4.1 时间戳处理

```typescript
/**
 * 统一时间戳处理
 * - Gamma: ISO 8601 字符串
 * - CLOB orderbook: 纳秒字符串
 * - Data API: Unix 秒
 */
function normalizeTimestamp(ts: string | number): Date {
  if (typeof ts === 'string') {
    // 检查是否是纳秒时间戳
    if (/^\d{19}$/.test(ts)) {
      return new Date(Number(ts) / 1e6);
    }
    // ISO 字符串
    return new Date(ts);
  }

  // 判断是秒还是毫秒
  if (ts < 1e12) {
    return new Date(ts * 1000);  // Unix 秒
  }
  return new Date(ts);  // 已经是毫秒
}
```

### 4.2 JSON 字符串解析

```typescript
/**
 * 安全解析 Gamma API 的 JSON 字符串字段
 */
function parseJsonField<T>(value: string | T): T {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return value as unknown as T;
    }
  }
  return value;
}

// 使用
const outcomes = parseJsonField<string[]>(market.outcomes);
const prices = parseJsonField<string[]>(market.outcomePrices).map(Number);
const tokenIds = parseJsonField<string[]>(market.clobTokenIds);
```

### 4.3 Rank 转换

```typescript
/**
 * Data API 返回 rank 是 string
 */
function parseRank(rank: string | number): number {
  return typeof rank === 'string' ? parseInt(rank, 10) : rank;
}
```

---

## 5. API 客户端设计

### 5.1 客户端职责划分

```
┌─────────────────────────────────────────────────────────────────┐
│                    SDK 客户端架构                                │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────────┐                                            │
│  │  GammaClient    │  市场发现                                   │
│  │                 │  - getMarkets(query)                       │
│  │                 │  - getMarketBySlug(slug)                   │
│  │                 │  - getEvents(query)                        │
│  │                 │  - searchMarkets(query)                    │
│  └─────────────────┘  - getTags() / getSports()                 │
│                                                                  │
│  ┌─────────────────┐                                            │
│  │  ClobClient     │  交易执行                                   │
│  │                 │  - getOrderbook(tokenId)                   │
│  │                 │  - getMidpoint(tokenId)                    │
│  │                 │  - getPrice(tokenId, side)                 │
│  │                 │  - placeOrder(...) [L2]                    │
│  └─────────────────┘  - cancelOrder(...) [L2]                   │
│                                                                  │
│  ┌─────────────────┐                                            │
│  │  DataClient     │  用户数据                                   │
│  │                 │  - getPositions(query)                     │
│  │                 │  - getTrades(query)                        │
│  │                 │  - getActivity(query)                      │
│  │                 │  - getLeaderboard(query)                   │
│  │                 │  - getHolders(markets)                     │
│  └─────────────────┘  - getValue(user)                          │
│                                                                  │
│  ┌─────────────────┐                                            │
│  │  SubgraphClient │  历史数据                                   │
│  │  (未来)         │  - getHistoricalPnl(user)                  │
│  │                 │  - getClosedPositions(user)                │
│  └─────────────────┘  - getMarketHistory(conditionId)           │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 5.2 查询参数类型

```typescript
// === Positions 查询 ===
interface PositionsQuery {
  user: string;                  // 必需
  market?: string[];             // conditionId 数组
  eventId?: number[];
  title?: string;
  sizeThreshold?: number;
  redeemable?: boolean;
  mergeable?: boolean;
  limit?: number;                // 0-500
  offset?: number;               // 0-10000
  sortBy?: PositionsSortBy;
  sortDirection?: 'ASC' | 'DESC';
}

type PositionsSortBy =
  | 'CURRENT'
  | 'INITIAL'
  | 'TOKENS'
  | 'CASHPNL'
  | 'PERCENTPNL'
  | 'TITLE'
  | 'RESOLVING'
  | 'PRICE'
  | 'AVGPRICE';

// === Trades 查询 ===
interface TradesQuery {
  limit?: number;                // 0-10000
  offset?: number;               // 0-10000
  market?: string[];             // 与 eventId 互斥
  eventId?: number[];            // 与 market 互斥
  user?: string;
  side?: 'BUY' | 'SELL';
  takerOnly?: boolean;           // 默认 true
  filterType?: 'CASH' | 'TOKENS';
  filterAmount?: number;
}

// === Activity 查询 ===
interface ActivityQuery {
  user: string;                  // 必需
  limit?: number;                // 0-500
  offset?: number;               // 0-10000
  market?: string[];             // 与 eventId 互斥
  eventId?: number[];            // 与 market 互斥
  type?: ActivityType[];
  start?: number;                // Unix 秒
  end?: number;                  // Unix 秒
  sortBy?: 'TIMESTAMP' | 'TOKENS' | 'CASH';
  sortDirection?: 'ASC' | 'DESC';
  side?: 'BUY' | 'SELL';
}

// === Gamma Markets 查询 ===
interface MarketsQuery {
  tagId?: number;
  closed?: boolean;
  active?: boolean;
  order?: string;
  ascending?: boolean;
  limit?: number;
  offset?: number;
  relatedTags?: boolean;
  excludeTagId?: number;
  slug?: string;
}
```

---

## 6. 下一步

### 6.1 实现优先级

1. **P0**: 更新 DataClient 支持完整参数
   - Activity: start, end, offset, sortBy
   - Trades: user, offset, side
   - Positions: sortBy, sortDirection, limit, offset

2. **P1**: 添加缺失端点
   - Holders
   - Value (公开)
   - CLOB 价格端点

3. **P2**: 增强功能
   - Gamma 排序/分页
   - Subgraph 集成

### 6.2 验证清单

在实现任何新功能前:
- [ ] 运行验证脚本确认实际返回结构
- [ ] 对比官方文档参数
- [ ] 更新类型定义
- [ ] 添加转换函数

---

## 参考

- [02-api-verification.md](./02-api-verification.md) - API 验证报告
- [01-polymarket-principles.md](./01-polymarket-principles.md) - 原理文档
- [官方文档](https://docs.polymarket.com/)
