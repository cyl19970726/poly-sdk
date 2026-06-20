# Polymarket Position & Activity API 文档

## 概述

Polymarket Data API 提供完整的用户持仓和活动查询功能：

| 端点 | 功能 | SDK 方法 |
|------|------|----------|
| `/positions` | 当前持仓 | `dataApi.getPositions()` |
| `/closed-positions` | 已平仓位 | `dataApi.getClosedPositions()` |
| `/activity` | 用户活动 | `dataApi.getActivity()` |
| `/trades` | 交易记录 | `dataApi.getTrades()` |
| `/value` | 账户总价值 | `dataApi.getAccountValue()` |

**Base URL**: `https://data-api.polymarket.com`

---

## 1. 当前持仓 (Positions)

### 端点

```
GET /positions
```

### 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `user` | string | **是** | - | 用户地址 (0x...) |
| `market` | string[] | 否 | - | 按 conditionId 过滤 (csv) |
| `eventId` | integer[] | 否 | - | 按 eventId 过滤 (csv) |
| `sizeThreshold` | number | 否 | 1 | 最小持仓量 |
| `redeemable` | boolean | 否 | false | 仅可赎回持仓 |
| `mergeable` | boolean | 否 | false | 仅可合并持仓 |
| `limit` | integer | 否 | 100 | 每页条数 (0-500) |
| `offset` | integer | 否 | 0 | 偏移量 (0-10000) |
| `sortBy` | enum | 否 | TOKENS | 排序字段 |
| `sortDirection` | enum | 否 | DESC | ASC / DESC |
| `title` | string | 否 | - | 标题搜索 (max 100) |

**sortBy 选项**:
- `CURRENT` - 当前价值
- `INITIAL` - 初始价值
- `TOKENS` - 持仓数量
- `CASHPNL` - 现金盈亏
- `PERCENTPNL` - 百分比盈亏
- `TITLE` - 标题
- `RESOLVING` - 即将结算
- `PRICE` - 当前价格
- `AVGPRICE` - 平均成本

### 返回数据

```typescript
interface Position {
  proxyWallet: string;        // 钱包地址
  asset: string;              // ERC-1155 Token ID
  conditionId: string;        // 市场 ID

  // 持仓数据
  size: number;               // 持仓数量
  avgPrice: number;           // 平均成本
  curPrice: number;           // 当前价格

  // 价值计算
  initialValue: number;       // 初始价值
  currentValue: number;       // 当前价值
  cashPnl: number;            // 未实现盈亏 (USDC)
  percentPnl: number;         // 百分比盈亏
  totalBought: number;        // 总买入
  realizedPnl: number;        // 已实现盈亏
  percentRealizedPnl: number; // 已实现百分比盈亏

  // 状态
  redeemable: boolean;        // 可赎回
  mergeable: boolean;         // 可合并

  // 市场信息
  title: string;
  slug: string;
  outcome: string;            // "Yes" / "No"
  outcomeIndex: number;       // 0 = Yes, 1 = No
  endDate: string;
}
```

### SDK 使用

```typescript
import { PolymarketSDK } from '@catalyst-team/poly-sdk';

const sdk = new PolymarketSDK();

// 获取所有持仓
const positions = await sdk.dataApi.getPositions(address);

// 按盈亏排序
const topPnl = await sdk.dataApi.getPositions(address, {
  sortBy: 'CASHPNL',
  sortDirection: 'DESC',
  limit: 10,
});

// 仅获取可赎回持仓
const redeemable = await sdk.dataApi.getPositions(address, {
  redeemable: true,
});

// 按特定市场过滤
const marketPositions = await sdk.dataApi.getPositions(address, {
  market: ['0x...conditionId1', '0x...conditionId2'],
});
```

---

## 2. 已平仓位 (Closed Positions)

### 端点

```
GET /closed-positions
```

### 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `user` | string | **是** | - | 用户地址 (0x...) |
| `market` | string[] | 否 | - | 按 conditionId 过滤 |
| `eventId` | integer[] | 否 | - | 按 eventId 过滤 |
| `title` | string | 否 | - | 标题搜索 (max 100) |
| `limit` | integer | 否 | 10 | 每页条数 (0-50) |
| `offset` | integer | 否 | 0 | 偏移量 (0-100000) |
| `sortBy` | enum | 否 | REALIZEDPNL | 排序字段 |
| `sortDirection` | enum | 否 | DESC | ASC / DESC |

**sortBy 选项**:
- `REALIZEDPNL` - 已实现盈亏
- `TITLE` - 标题
- `PRICE` - 结算价格
- `AVGPRICE` - 平均成本
- `TIMESTAMP` - 结算时间

### 返回数据

```typescript
interface ClosedPosition {
  proxyWallet: string;
  asset: string;
  conditionId: string;

  // 交易数据
  avgPrice: number;           // 平均成本
  totalBought: number;        // 总买入
  realizedPnl: number;        // 已实现盈亏
  curPrice: number;           // 结算价格 (0 或 1)
  timestamp: number;          // 结算时间

  // 市场信息
  title: string;
  slug: string;
  outcome: string;
  outcomeIndex: number;
  endDate: string;
}
```

### SDK 使用

```typescript
// 获取已平仓位 (按盈亏排序)
const closed = await sdk.dataApi.getClosedPositions(address);

// 分页获取
const page2 = await sdk.dataApi.getClosedPositions(address, {
  offset: 50,
  limit: 50,
});

// 按时间排序
const recent = await sdk.dataApi.getClosedPositions(address, {
  sortBy: 'TIMESTAMP',
  sortDirection: 'DESC',
});
```

---

## 3. 用户活动 (Activity)

### 端点

```
GET /activity
```

### 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `user` | string | **是** | - | 用户地址 (0x...) |
| `limit` | integer | 否 | 100 | 每页条数 (0-500) |
| `offset` | integer | 否 | 0 | 偏移量 (0-10000) |
| `market` | string[] | 否 | - | 按 conditionId 过滤 |
| `eventId` | integer[] | 否 | - | 按 eventId 过滤 |
| `type` | enum[] | 否 | - | 活动类型过滤 |
| `side` | enum | 否 | - | BUY / SELL |
| `start` | integer | 否 | - | 起始时间 (Unix 秒) |
| `end` | integer | 否 | - | 结束时间 (Unix 秒) |
| `sortBy` | enum | 否 | TIMESTAMP | 排序字段 |
| `sortDirection` | enum | 否 | DESC | ASC / DESC |

**type 选项**:
- `TRADE` - 交易
- `SPLIT` - 拆分 (USDC → YES + NO)
- `MERGE` - 合并 (YES + NO → pUSD)
- `REDEEM` - 赎回 (结算后)
- `REWARD` - 奖励
- `CONVERSION` - 转换

**sortBy 选项**:
- `TIMESTAMP` - 时间
- `TOKENS` - 代币数量
- `CASH` - 现金金额

### 返回数据

```typescript
interface Activity {
  type: 'TRADE' | 'SPLIT' | 'MERGE' | 'REDEEM' | 'REWARD' | 'CONVERSION';
  side: 'BUY' | 'SELL';

  // 交易数据
  size: number;               // 代币数量
  usdcSize: number;           // USDC 金额
  price: number;              // 价格

  // 交易信息
  timestamp: number;          // Unix 时间戳
  transactionHash: string;    // 链上交易哈希

  // 市场信息
  asset: string;
  conditionId: string;
  outcome: string;
  outcomeIndex: number;
  title: string;
  slug: string;
}
```

### SDK 使用

```typescript
// 获取最近 50 条活动
const activity = await sdk.dataApi.getActivity(address, { limit: 50 });

// 时间范围查询 (过去 24 小时)
const dayAgo = Math.floor(Date.now() / 1000) - 86400;
const recent = await sdk.dataApi.getActivity(address, {
  start: dayAgo,
  limit: 100,
});

// 仅获取交易活动
const trades = await sdk.dataApi.getActivity(address, {
  type: 'TRADE',
});

// 仅获取卖出活动
const sells = await sdk.dataApi.getActivity(address, {
  type: 'TRADE',
  side: 'SELL',
});

// 获取所有活动 (自动分页)
const allActivity = await sdk.dataApi.getAllActivity(address, {
  start: dayAgo,
});
```

---

## 4. 交易记录 (Trades)

### 端点

```
GET /trades
```

### 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `user` | string | 否 | - | 用户地址 (0x...) |
| `market` | string[] | 否 | - | 按 conditionId 过滤 |
| `eventId` | integer[] | 否 | - | 按 eventId 过滤 |
| `limit` | integer | 否 | 100 | 每页条数 (0-10000) |
| `offset` | integer | 否 | 0 | 偏移量 (0-10000) |
| `side` | enum | 否 | - | BUY / SELL |
| `takerOnly` | boolean | 否 | true | 仅 taker 交易 |
| `filterType` | enum | 否 | - | CASH / TOKENS |
| `filterAmount` | number | 否 | - | 最小金额 |

### 返回数据

```typescript
interface Trade {
  proxyWallet: string;        // 交易者地址

  // 交易数据
  side: 'BUY' | 'SELL';
  size: number;               // 代币数量
  price: number;              // 成交价格

  // 交易信息
  timestamp: number;
  transactionHash: string;

  // 市场信息
  asset: string;
  conditionId: string;
  outcome: string;
  title: string;
  slug: string;
}
```

### SDK 使用

```typescript
// 获取市场交易记录
const marketTrades = await sdk.dataApi.getTrades({
  market: conditionId,
  limit: 100,
});
// 或使用便捷方法
const marketTrades2 = await sdk.dataApi.getTradesByMarket(conditionId, 100);

// 获取用户交易记录
const userTrades = await sdk.dataApi.getTrades({
  user: address,
  limit: 50,
});
// 或使用便捷方法
const userTrades2 = await sdk.dataApi.getTradesByUser(address, { limit: 50 });

// 仅获取大额买入
const bigBuys = await sdk.dataApi.getTrades({
  market: conditionId,
  side: 'BUY',
  filterType: 'CASH',
  filterAmount: 1000,  // > $1000
});
```

---

## 5. 账户总价值 (Value)

### 端点

```
GET /value
```

### 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `user` | string | **是** | - | 用户地址 (0x...) |
| `market` | string[] | 否 | - | 按 conditionId 过滤 |

### 返回数据

```typescript
interface AccountValue {
  user: string;
  value: number;  // 总价值 (USDC)
}
```

### SDK 使用

```typescript
// 获取账户总价值
const { value } = await sdk.dataApi.getAccountValue(address);
console.log(`账户总价值: $${value.toFixed(2)}`);

// 获取特定市场的持仓价值
const marketValue = await sdk.dataApi.getAccountValue(address, [conditionId]);
```

---

## 6. API 参考

### DataApiClient 方法

| 方法 | 说明 |
|------|------|
| `getPositions(address, params?)` | 获取当前持仓 |
| `getClosedPositions(address, params?)` | 获取已平仓位 |
| `getActivity(address, params?)` | 获取用户活动 |
| `getAllActivity(address, params?, max?)` | 获取所有活动 (自动分页) |
| `getTrades(params?)` | 获取交易记录 |
| `getTradesByMarket(conditionId, limit?)` | 获取市场交易 |
| `getTradesByUser(address, params?)` | 获取用户交易 |
| `getAccountValue(address, markets?)` | 获取账户价值 |

### 类型导出

```typescript
import type {
  Position,
  Activity,
  Trade,
  AccountValue,
  PositionsParams,
  ActivityParams,
  TradesParams,
} from '@catalyst-team/poly-sdk';
```

---

## 7. 完整示例

```typescript
import { PolymarketSDK } from '@catalyst-team/poly-sdk';

async function analyzeTrader(address: string) {
  const sdk = new PolymarketSDK();

  // 1. 账户总览
  const { value } = await sdk.dataApi.getAccountValue(address);
  console.log(`\n=== 账户总览 ===`);
  console.log(`总价值: $${value.toFixed(2)}`);

  // 2. 当前持仓 (按盈亏排序)
  const positions = await sdk.dataApi.getPositions(address, {
    sortBy: 'CASHPNL',
    sortDirection: 'DESC',
    limit: 5,
  });
  console.log(`\n=== Top 5 持仓 (按盈亏) ===`);
  positions.forEach((p, i) => {
    console.log(`${i + 1}. ${p.title} (${p.outcome})`);
    console.log(`   持仓: ${p.size.toFixed(2)} @ $${p.avgPrice.toFixed(3)}`);
    console.log(`   盈亏: $${p.cashPnl?.toFixed(2)} (${(p.percentPnl || 0).toFixed(1)}%)`);
  });

  // 3. 已平仓位 (按盈亏排序)
  const closed = await sdk.dataApi.getClosedPositions(address, {
    sortBy: 'REALIZEDPNL',
    sortDirection: 'DESC',
    limit: 5,
  });
  console.log(`\n=== Top 5 已平仓位 ===`);
  closed.forEach((p, i) => {
    console.log(`${i + 1}. ${p.title} (${p.outcome})`);
    console.log(`   已实现盈亏: $${p.realizedPnl.toFixed(2)}`);
  });

  // 4. 最近活动
  const dayAgo = Math.floor(Date.now() / 1000) - 86400;
  const activity = await sdk.dataApi.getActivity(address, {
    start: dayAgo,
    limit: 10,
  });
  console.log(`\n=== 过去 24h 活动 ===`);
  activity.forEach((a) => {
    const time = new Date(a.timestamp).toLocaleTimeString();
    console.log(`[${time}] ${a.type} ${a.side} ${a.size.toFixed(2)} @ $${a.price.toFixed(3)}`);
    console.log(`        ${a.title} (${a.outcome})`);
  });

  // 5. 可赎回持仓
  const redeemable = await sdk.dataApi.getPositions(address, {
    redeemable: true,
  });
  if (redeemable.length > 0) {
    console.log(`\n=== 可赎回持仓 (${redeemable.length}) ===`);
    redeemable.forEach((p) => {
      console.log(`- ${p.title}: ${p.size.toFixed(2)} tokens`);
    });
  }
}

analyzeTrader('0x...');
```

---

## 8. 注意事项

### 分页限制

| 端点 | limit 范围 | offset 范围 |
|------|-----------|-------------|
| `/positions` | 0-500 | 0-10000 |
| `/closed-positions` | 0-50 | 0-100000 |
| `/activity` | 0-500 | 0-10000 |
| `/trades` | 0-10000 | 0-10000 |

### 互斥参数

- `market` 和 `eventId` 不能同时使用
- 使用其中一个即可

### 时间戳格式

- API 返回的 `timestamp` 为 Unix 秒
- SDK 会自动转换为毫秒 (JavaScript Date 兼容)
