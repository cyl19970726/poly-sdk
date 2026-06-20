# Polymarket 实现原理

> 理解 Polymarket 的三层架构是正确设计 SDK 的基础

---

## 为什么需要这份文档

**观察到的常见问题**：
- 开发者沿用 V1/USDC.e 假设，但 CLOB V2 用户侧交易抵押品已经是 pUSD
- 开发者手算 tokenId 时把 collateral、conditionId、indexSet 或 V1/V2 语境用错
- 开发者独立读取 YES/NO 订单簿相加，忽略了镜像属性，得到 ~2.0 而不是 ~1.0
- 开发者硬编码 "YES"/"NO"，但加密市场用 "Up"/"Down"

**根本原因**：开发者不理解 Polymarket **为什么**这样设计，导致做出不匹配现实的假设。

本文档不仅解释"是什么"，更解释"为什么"。

---

## 概述

Polymarket 是一个去中心化预测市场，由三个核心组件构成：

```
┌─────────────────────────────────────────────────────────────────┐
│                    Polymarket 技术栈                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │
│  │     CTF     │  │    CLOB     │  │     UMA     │              │
│  │  条件代币   │  │  订单簿交易  │  │  预言机结算  │              │
│  └─────────────┘  └─────────────┘  └─────────────┘              │
│        ↓               ↓               ↓                        │
│    代币铸造         价格发现         结果确定                    │
│    代币合并         订单撮合         争议解决                    │
│    代币赎回         链下+链上         2h挑战期/争议升级             │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 1. CTF - Conditional Token Framework

### 1.1 为什么需要 Conditional Tokens

**问题**：传统预测方式 "我觉得 Trump 会赢" 没有对手方，无法形成市场。

**CTF 的解决方案**：

```
传统预测: "我觉得 Trump 会赢" → 对手方在哪？谁来赔付？

CTF 预测:
┌─────────────────────────────────────────────────────────────┐
│ $1 pUSD ═══[Split]═══> 1 YES + 1 NO                        │
│                                                             │
│ 结果 A (YES 赢): 1 YES → $1 pUSD, NO → $0                   │
│ 结果 B (NO 赢):  1 NO → $1 pUSD, YES → $0                   │
│                                                             │
│ 恒等式: YES + NO 永远 = $1 (市场结算前)                      │
└─────────────────────────────────────────────────────────────┘

为什么这有效？
- 不需要手动找对手方（市场自动撮合）
- 通过订单簿发现价格（供需决定）
- 保证结算（代币背后有 pUSD 抵押）
```

### 1.2 核心概念

CTF 是 Gnosis 开发的条件代币框架，实现了预测市场的代币化：

```
                    1 pUSD
                       │
                       ▼
              ┌────────────────┐
              │     SPLIT      │
              │   (铸造代币)    │
              └────────────────┘
                       │
           ┌───────────┴───────────┐
           ▼                       ▼
      1 YES Token              1 NO Token
      (ERC-1155)              (ERC-1155)
```

**核心约束**: `YES + NO = 1 pUSD`

这意味着：
- 1 个 YES token + 1 个 NO token 始终等于 1 pUSD
- 如果 YES 价格是 0.65，NO 价格必然接近 0.35
- 套利机会只在按有效价格和可成交深度计算后，组合成本/收入仍偏离 1 时成立

### 1.2 代币操作

| 操作 | 输入 | 输出 | 说明 |
|------|------|------|------|
| **Split** | 1 pUSD | 1 YES + 1 NO | 铸造新代币 |
| **Merge** | 1 YES + 1 NO | 1 pUSD | 合并回 pUSD |
| **Redeem** | 1 winning token | 1 pUSD | 结算后赎回 |

### 1.3 ERC-1155 标准

每个市场的 YES 和 NO 代币都是 ERC-1155 token：

```typescript
// Token ID 格式
interface Token {
  tokenId: string;    // 如 "21742633143463906290569050155826241533067272736897614950488156847949938836455"
  outcome: string;    // "Yes" 或 "No"
  conditionId: string; // 市场标识
}
```

**Token ID 的来源**:
- Gamma API: `clobTokenIds` (JSON 字符串)
- CLOB API: `tokens[].token_id`

### 1.4 Token ID / Position ID

当前官方语义里，Polymarket outcome token 的 `tokenId` / `assetId` / CTF `positionId` 指向同一个 ERC-1155 token ID。它由 `getConditionId -> getCollectionId -> getPositionId` 三步链上计算得到，其中 V2 collateral token 是 pUSD。

```typescript
// ✅ 最稳: 从 Gamma/CLOB API 获取，而不是在业务代码里手算
const market = await gammaApi.getMarketByCondition(conditionId);
const [primaryTokenId, secondaryTokenId] = JSON.parse(market.clobTokenIds);

const balance = await ctf.balanceOf(wallet, primaryTokenId);
```

**工程规则**：
- 不再说 Polymarket 使用“自定义 wrapper tokenId”
- SDK 和策略层仍应优先使用 Gamma `clobTokenIds` 或 CLOB `tokens[]`
- 手算失败通常说明 collateral token、oracle、questionId、conditionId、indexSet 或 V1/V2 语境有误
- Gamma Quickstart 约定：`clobTokenIds[0]` 是第一个 outcome token，`clobTokenIds[1]` 是第二个 outcome token；UI label 仍要动态读取

**受影响的操作**:
- `balanceOf()` - 余额查询
- `redeem()` - 代币赎回（工程上推荐使用 `redeemByTokenIds()`）
- 所有涉及 Token ID 的操作

### 1.5 SDK 设计启示

```typescript
// 持仓必须包含 outcome 信息
interface Position {
  tokenId: string;
  outcome: 'YES' | 'NO';
  size: number;       // 代币数量
  // ...
}

// 市场必须有两个代币
interface Market {
  yesTokenId: string;
  noTokenId: string;
  // ...
}

// 验证约束
function validatePrices(yesPrice: number, noPrice: number): boolean {
  const sum = yesPrice + noPrice;
  // 允许小误差（价差）
  return sum >= 0.98 && sum <= 1.02;
}
```

---

## 2. CLOB - Central Limit Order Book

### 2.1 混合架构

Polymarket 采用**混合去中心化**架构：

```
┌─────────────────────────────────────────────────────────────────┐
│                    CLOB 混合架构                                 │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────┐     ┌─────────────┐     ┌─────────────┐        │
│  │   用户签名   │ --> │  链下撮合   │ --> │  链上结算   │        │
│  │  EIP-712   │     │   Operator  │     │   Polygon   │        │
│  └─────────────┘     └─────────────┘     └─────────────┘        │
│                                                                  │
│  签名内容:                                                       │
│  - 市场 (conditionId)                                           │
│  - 方向 (BUY/SELL)                                              │
│  - 代币 (tokenId)                                               │
│  - 价格和数量                                                    │
│  - 过期时间                                                      │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 订单簿镜像

**关键概念**: 买 YES @ P = 卖 NO @ (1-P)

```
┌─────────────────────────────────────────────────────────────────┐
│                    订单簿镜像特性                                │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  YES 订单簿                NO 订单簿                             │
│  ┌─────────────┐          ┌─────────────┐                       │
│  │ Bid: 0.55   │  ←──→    │ Ask: 0.45   │  (互补价格路径)        │
│  │ Ask: 0.57   │  ←──→    │ Bid: 0.43   │  (互补价格路径)        │
│  └─────────────┘          └─────────────┘                       │
│                                                                  │
│  买 YES @ 0.57 = 卖 NO @ 0.43                                   │
│  卖 YES @ 0.55 = 买 NO @ 0.45                                   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 2.3 套利计算

由于镜像特性，套利必须使用**有效价格**：

```typescript
// 错误：直接相加（会重复计算）
const wrongLongCost = yesAsk + noAsk;  // 可能 > 1

// 正确：使用有效价格
interface EffectivePrices {
  effectiveBuyYes: number;   // min(YES.ask, 1 - NO.bid)
  effectiveBuyNo: number;    // min(NO.ask, 1 - YES.bid)
  effectiveSellYes: number;  // max(YES.bid, 1 - NO.ask)
  effectiveSellNo: number;   // max(NO.bid, 1 - YES.ask)
}

function calculateEffectivePrices(yesBook: Orderbook, noBook: Orderbook): EffectivePrices {
  const yesBid = yesBook.bids[0]?.price || 0;
  const yesAsk = yesBook.asks[0]?.price || 1;
  const noBid = noBook.bids[0]?.price || 0;
  const noAsk = noBook.asks[0]?.price || 1;

  return {
    effectiveBuyYes: Math.min(yesAsk, 1 - noBid),
    effectiveBuyNo: Math.min(noAsk, 1 - yesBid),
    effectiveSellYes: Math.max(yesBid, 1 - noAsk),
    effectiveSellNo: Math.max(noBid, 1 - yesAsk),
  };
}

// Long arb: 同时买 YES + NO，期望 settlement 获利
const longCost = effectiveBuyYes + effectiveBuyNo;
const longProfit = 1 - longCost;  // > 0 表示有套利机会

// Short arb: 同时卖 YES + NO
const shortRevenue = effectiveSellYes + effectiveSellNo;
const shortProfit = shortRevenue - 1;  // > 0 表示有套利机会
```

注意：上面的 `bids[0]` / `asks[0]` 只能用于概念说明或初筛。真实交易必须按目标规模逐档走订单簿，计算每个 leg 的 VWAP；否则很容易把几美元的一档深度当成可执行的大额套利。

### 2.4 交易参数

```typescript
interface TradingParams {
  minimumOrderSize: number;    // 从 API 读取，不硬编码
  minimumTickSize: number;     // 从 API 读取，可能是 0.1 / 0.01 / 0.001 / 0.0001
  makerBaseFee: number;        // Maker 费率
  takerBaseFee: number;        // Taker 费率
  secondsDelay?: number;       // 市场级延迟/最小订单年龄
}
```

这些参数应从 `getMarket()` / `getClobMarketInfo()` 返回值读取，例如 `minimum_order_size`、`minimum_tick_size`、maker/taker base fee、fee curve、`seconds_delay` / `oas`、`neg_risk` 和 token outcome label。不要在 SDK 中把 tick size、min size 或费用写死。

---

## 3. UMA - Optimistic Oracle

### 3.1 结算流程

```
┌─────────────────────────────────────────────────────────────────┐
│                    UMA 结算流程                                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  事件发生 → 提交结果 → 2h challenge → 结算或争议升级              │
│     │          │           │         │                          │
│     │          ▼           ▼         ▼                          │
│     │     质押 pUSD    无争议?    YES=1, NO=0                   │
│     │     提交答案     有争议?    或 YES=0, NO=1                 │
│     │                  debate + DVM vote                         │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 3.2 结算结果

市场结算后，代币价值变为：
- **YES wins**: YES = 1 pUSD, NO = 0
- **NO wins**: YES = 0, NO = 1 pUSD
- **50-50**: YES = 0.5 pUSD, NO = 0.5 pUSD (罕见 Unknown/50-50)

时间线不要写成统一的“48h 争议期”：

- 无争议：proposal 后有 2 小时 challenge period，通过后约 2 小时完成
- 有争议：进入后续 proposal / challenge；若升级到 UMA DVM，会有 24-48 小时 debate period 与约 48 小时 voting
- 争议流程整体可能需要 4-6 天

### 3.3 相关字段

```typescript
interface SettlementInfo {
  umaResolutionStatus: 'proposed' | 'disputed' | 'resolved';
  umaEndDate: string;           // 结算时间
  umaBond: string;              // 质押金额
  umaReward: string;            // 奖励金额
  resolvedBy?: string;          // 结算者地址
}
```

---

## 4. pUSD / USDC.e / 原生 USDC

### 4.1 V2 抵押品规则

**问题**：开发者沿用旧逻辑，认为“CTF 只接受 USDC.e”，或看到钱包里有 USDC.e/native USDC 就认为可以直接下单。

**当前 CLOB V2 规则**：用户侧交易、余额、下单、split/merge/redeem 文档都应以 **pUSD / Polymarket USD** 为主。pUSD 是 Polygon 上的 ERC-20，背后由 USDC 支撑；USDC.e 主要是 onramp/offramp 或适配层相关资产。

```
┌─────────────────────────────────────────────────────────────┐
│ pUSD (0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB)           │
│   - Polymarket V2 用户侧交易抵押品                           │
│   - 下单、余额、split/merge/redeem 以它为主                  │
│   - 6 位小数                                                 │
│   - ✅ V2 trading collateral                                 │
│                                                             │
│ USDC.e (0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174)         │
│   - 桥接版 USDC                                              │
│   - Collateral Onramp/Offramp 包装/解包轨道                  │
│   - 不是 SDK 当前交易抵押品的核心规则                         │
│                                                             │
│ Native USDC (0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359)    │
│   - Circle 原生 Polygon USDC                                 │
│   - 可作为 deposit/bridge/onramp 输入                         │
│   - 下单前仍需要进入 pUSD 余额                                │
└─────────────────────────────────────────────────────────────┘
```

### 4.2 如何处理

```typescript
import {
  PUSD_CONTRACT,
  USDC_E_CONTRACT,
  NATIVE_USDC_CONTRACT,
} from '@catalyst-team/poly-sdk';

// 检查余额
const pusdBalance = await pusd.balanceOf(wallet);     // V2 交易抵押品
const usdceBalance = await usdce.balanceOf(wallet);   // onramp/offramp 轨道
const nativeBalance = await native.balanceOf(wallet); // deposit/bridge 输入

// 如果只有 USDC.e，需要先 wrap 为 pUSD
if (pusdBalance < amount && usdceBalance >= amount) {
  await relayer.wrapUsdcToPUSD(amountWei);
}

// 如果只有 native USDC，走 Polymarket deposit/bridge/onramp 流程
if (pusdBalance < amount && nativeBalance >= amount) {
  const depositAddr = await bridgeClient.getEvmDepositAddress(wallet);
  // 发送支持资产后，Polymarket 侧最终应形成 pUSD 余额
}
```

### 4.3 SDK 中的代币地址

```typescript
import {
  PUSD_CONTRACT,        // 0xC011... - V2 trading collateral
  USDC_E_CONTRACT,      // 0x2791... - onramp/offramp rail
  NATIVE_USDC_CONTRACT, // 0x3c49... - deposit/bridge input
} from '@catalyst-team/poly-sdk';
```

---

## 5. 两级认证模型

### 5.1 为什么需要两级认证

**问题**：用户私钥不应该在每笔交易中通过网络发送。

**Polymarket 解决方案**：

```
┌─────────────────────────────────────────────────────────────┐
│ Level 1 (L1): 钱包签名                                       │
│   - 一次性初始化                                             │
│   - 签名消息以派生/创建 API 凭证                              │
│                                                             │
│ Level 2 (L2): API 凭证 (key, secret, passphrase)            │
│   - 用于每个交易请求                                         │
│   - 无私钥暴露                                               │
│   - 可撤销而不改变钱包                                       │
│                                                             │
│ 流程: privateKey → deriveOrCreateApiKey() → {key, secret}  │
│       TradingService 使用 L2 凭证进行交易                    │
└─────────────────────────────────────────────────────────────┘
```

### 5.2 Derive vs Create

| 方法 | 说明 | 使用场景 |
|------|------|----------|
| `deriveApiKey()` | 从私钥确定性派生，每次相同 | 已有凭证时恢复 |
| `createApiKey()` | 创建新凭证，每次不同 | 首次设置或轮换 |

### 5.3 常见错误

```typescript
// ❌ 错误: 未初始化就交易
const result = await tradingService.createOrder(params);
// Error: "API key not found"

// ✅ 正确: 先初始化
await tradingService.initialize();  // 内部调用 deriveOrCreateApiKey
const result = await tradingService.createOrder(params);
```

---

## 6. 动态 Outcome 名称

### 6.1 不是所有市场都用 YES/NO

**问题**：开发者硬编码 `<span>YES: {price}</span>`，但加密市场显示 "Up"/"Down"。

```
┌─────────────────────────────────────────────────────────────┐
│ 市场类型          │ Outcome 名称                            │
├───────────────────┼─────────────────────────────────────────┤
│ 标准市场          │ "Yes" / "No"                            │
│ 加密 15 分钟市场   │ "Up" / "Down"                           │
│ 体育比赛          │ "Team A" / "Team B"                     │
│ 选举              │ "Candidate A" / "Candidate B"           │
└─────────────────────────────────────────────────────────────┘
```

### 6.2 正确做法

```typescript
// ❌ 错误: 硬编码
<span>YES: {yesPrice}¢</span>

// ✅ 正确: 使用市场返回的动态名称
const market = await clobClient.getMarket(conditionId);
const primaryOutcome = market.tokens[0].outcome;  // "Yes", "Up", etc.
const secondaryOutcome = market.tokens[1].outcome; // "No", "Down", etc.

<span>{primaryOutcome}: {primaryPrice}¢</span>
<span>{secondaryOutcome}: {secondaryPrice}¢</span>
```

---

## 7. Neg-Risk 市场（多选题）

### 7.1 概念

Neg-Risk 市场是多选题市场（如 "谁将赢得总统选举？"）：

```
┌─────────────────────────────────────────────────────────────────┐
│                    Neg-Risk 市场示例                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  问题: 谁将赢得 2024 总统选举？                                  │
│                                                                  │
│  选项:                                                          │
│  ├── Trump  → 单独市场 A (conditionId: 0xdd22...)               │
│  ├── Biden  → 单独市场 B (conditionId: 0xab12...)               │
│  ├── Harris → 单独市场 C (conditionId: 0xcd34...)               │
│  └── Other  → 单独市场 D (conditionId: 0xef56...)               │
│                                                                  │
│  Neg-Risk 标识:                                                 │
│  - negRisk: true                                                │
│  - negRiskMarketID: 0xe3b1bc38... (共同标识)                    │
│  - questionID: 0xe3b1bc38... (Gamma 中)                         │
│                                                                  │
│  直觉: 完整互斥结果空间的 YES 价格之和应接近 1                    │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 7.2 SDK 设计

```typescript
interface Market {
  // 普通市场
  conditionId: string;

  // Neg-Risk 额外字段
  negRisk?: boolean;
  negRiskMarketId?: string;   // 共同的 questionID
  groupItemTitle?: string;    // 如 "Trump", "Biden"
}

// 查询同一 neg-risk 组的所有市场
async function getNegRiskGroup(questionId: string): Promise<Market[]> {
  const markets = await gamma.getMarkets({ negRiskMarketId: questionId });
  return markets;
}
```

Neg-Risk 不能只靠页面形态或价格求和推断。启用多结果 `ΣYES ≈ 1` 逻辑前，需要确认：

- `negRisk === true`
- markets 共享同一个 event / `negRiskMarketId`
- 结果互斥且穷尽，`Other` 或兜底项定义清晰
- resolution rules 一致，不存在多个结果同时为真或单个 leg 可 void 的情况

如果这些条件不成立，多结果价格求和就不是严格套利约束，只是一个可能有方向性风险的相对价值信号。实际执行还要扣除费用、tick size、min size、订单簿深度、暂停/closed 状态和失败风险。

---

## 8. API 差异速查表

**三个 API 的命名和格式差异**：

```
┌──────────────┬──────────────┬──────────────┬───────────────┐
│              │    CLOB      │    Gamma     │     Data      │
├──────────────┼──────────────┼──────────────┼───────────────┤
│ 命名风格      │ snake_case   │ camelCase    │ camelCase     │
│ 数值类型      │ string       │ string       │ number        │
│ 时间戳        │ 毫秒         │ ISO 字符串    │ 秒            │
│ 分页          │ cursor       │ offset       │ offset        │
│ JSON 嵌套     │ 无           │ 有           │ 无            │
│ 认证          │ HMAC         │ 无           │ 无            │
└──────────────┴──────────────┴──────────────┴───────────────┘
```

**常见字段映射**：

| 概念 | CLOB API | Gamma API | Data API |
|------|----------|-----------|----------|
| 市场 ID | `condition_id` | `conditionId` | `conditionId` |
| Token ID | `token_id` | `clobTokenIds` (JSON) | `asset` |
| 价格 | `"0.55"` (string) | `"0.55"` | `0.55` (number) |
| 时间 | `1704067200000` (ms) | `"2024-01-01T00:00:00Z"` | `1704067200` (s) |
| 是否 Neg-Risk | `neg_risk` | `negRisk` | - |

---

## 9. 原理约束对 SDK 的影响

### 9.1 类型设计

```typescript
// 1. Token 必须关联 market 和 outcome
type OutcomeRole = 'primary' | 'secondary';
type OutcomeLabel = string;

interface Token {
  tokenId: string;
  conditionId: string;   // 关联市场
  role: OutcomeRole;
  outcome: OutcomeLabel; // "Yes", "No", "Up", "Down", "Team A", ...
}

// 2. 持仓必须有成本基础（用于 PnL 计算）
interface Position {
  token: Token;
  size: number;
  avgPrice: number;      // 平均成本
  unrealizedPnl: number; // 基于当前价格
}

// 3. 市场必须有双边代币
interface Market {
  conditionId: string;
  primaryToken: Token;
  secondaryToken: Token;
  // 价格约束: yesPrice + noPrice ≈ 1
}
```

### 9.2 计算函数

```typescript
// PnL 计算
function calculateUnrealizedPnl(position: Position, currentPrice: number): number {
  const value = position.size * currentPrice;
  const cost = position.size * position.avgPrice;
  return value - cost;
}

// 赎回价值（结算后）
function calculateRedeemValue(position: Position, winner: OutcomeLabel): number {
  if (position.token.outcome === winner) {
    return position.size * 1.0;  // 获胜方 = 1 pUSD per token
  }
  return 0;  // 失败方 = 0
}

// 套利检测
function detectArbitrage(yesBook: Orderbook, noBook: Orderbook): {
  hasLongArb: boolean;
  hasShortArb: boolean;
  profit: number;
} {
  const effective = calculateEffectivePrices(yesBook, noBook);
  const longCost = effective.effectiveBuyYes + effective.effectiveBuyNo;
  const shortRevenue = effective.effectiveSellYes + effective.effectiveSellNo;

  return {
    hasLongArb: longCost < 1,
    hasShortArb: shortRevenue > 1,
    profit: Math.max(1 - longCost, shortRevenue - 1),
  };
}
```

---

## 10. 常见反模式（避免这些错误）

### 10.1 错误 1：在业务代码里手算 tokenId

```typescript
// ⚠️ 脆弱: 手算要求 collateral/oracle/questionId/conditionId/indexSet 全部正确
const positionId = keccak256(collectionId, conditionId, indexSet);
const balance = await ctf.balanceOf(wallet, positionId);

// ✅ 稳定: 从 Gamma/CLOB API 获取
const market = await clobClient.getMarket(conditionId);
const tokenId = market.tokens[0].token_id;
const balance = await ctf.balanceOf(wallet, tokenId);
```

### 10.2 错误 2：订单簿价格相加

```typescript
// ❌ 错误: 重复计算镜像订单
const cost = yesBook.ask + noBook.ask; // 得到 ~1.998，不是 ~1.0

// ✅ 正确: 使用有效价格
const effectiveBuyYes = yesAsk;
const effectiveBuyNo = 1 - yesBid;
const cost = effectiveBuyYes + effectiveBuyNo; // 正确 ~1.02
```

### 10.3 错误 3：用 USDC.e / native USDC 余额直接判断 V2 可交易余额

```typescript
// ❌ 错误: 只看 USDC.e 或 native USDC
const balance = await nativeUsdc.balanceOf(wallet); // 显示 100 USDC
await ctf.split(conditionId, parseUnits('100', 6)); // 失败！

// ✅ 正确: 检查 pUSD；USDC.e/native USDC 需先进入 onramp/deposit 流程
const balance = await pusd.balanceOf(wallet);
await relayer.wrapUsdcToPUSD(amountWei); // 如果持有的是 USDC.e
```

### 10.4 错误 4：硬编码 YES/NO

```typescript
// ❌ 错误: 不是所有市场都用 YES/NO
<span>YES: {yesPrice}</span>

// ✅ 正确: 使用市场的结果名称
// 加密 15 分钟市场: "Up" / "Down"
// 体育: "Team A" / "Team B"
<span>{market.tokens[0].outcome}: {primaryPrice}</span>
```

### 10.5 错误 5：使用 redeem() 而不是 redeemByTokenIds()

```typescript
// ⚠️ 脆弱: redeem() 依赖本地计算的 Position ID，输入错会找不到余额
const result = await ctf.redeem(conditionId);
// tokensRedeemed: "0" - 常见原因是 collateral/indexSet/V1-V2 语境错误

// ✅ 正确: 使用 redeemByTokenIds()
const market = await clobApi.getMarket(conditionId);
const tokenIds = {
  yesTokenId: market.tokens[0].tokenId,
  noTokenId: market.tokens[1].tokenId,
};
const result = await ctf.redeemByTokenIds(conditionId, tokenIds);
```

---

## 11. 总结

### 11.1 核心约束

| 原理 | 约束 | SDK 影响 |
|------|------|---------|
| CTF | YES + NO = 1 | 市场必须有双边代币 |
| CLOB | 订单簿镜像 | 套利需用有效价格 |
| UMA | 无争议约 2h，争议后 4-6 天 | 持仓有 redeemable 状态 |
| Neg-Risk | 完整互斥组价格和接近 1 | 需验证同组、互斥、穷尽和规则一致 |
| pUSD | V2 trading collateral | USDC.e/native USDC 先走 onramp/deposit |
| Token ID | tokenId/assetId/positionId | 工程上优先从 API 获取 |

### 11.2 设计检查清单

- [ ] 类型是否反映 CTF 的 YES/NO 二元结构？
- [ ] 套利计算是否使用有效价格？
- [ ] 套利规模是否按订单簿深度和 VWAP 计算？
- [ ] 持仓是否包含成本基础？
- [ ] 市场是否正确处理 neg-risk，并验证同一事件的互斥穷尽条件？
- [ ] 结算状态是否正确映射？
- [ ] 是否以 pUSD 作为 V2 collateral？
- [ ] Token ID 是否优先来自 Gamma/CLOB API？
- [ ] Outcome 名称是否动态获取？

---

## 参考资料

- [Polymarket Docs](https://docs.polymarket.com/)
- [Gnosis CTF](https://docs.gnosis.io/conditionaltokens/)
- [UMA Protocol](https://umaproject.org/)
