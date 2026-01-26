# Polymarket 实现原理

> 理解 Polymarket 的三层架构是正确设计 SDK 的基础

---

## 为什么需要这份文档

**观察到的常见问题**：
- 开发者用原生 USDC 写 CTF 代码，但只有 USDC.e 能工作
- 开发者用标准 CTF 公式计算 Position ID，但 Polymarket 用自定义 tokenId
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
│    代币赎回         链下+链上         48h争议期                   │
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
│ $1 USDC ═══[Split]═══> 1 YES + 1 NO                        │
│                                                             │
│ 结果 A (YES 赢): 1 YES → $1 USDC, NO → $0                   │
│ 结果 B (NO 赢):  1 NO → $1 USDC, YES → $0                   │
│                                                             │
│ 恒等式: YES + NO 永远 = $1 (市场结算前)                      │
└─────────────────────────────────────────────────────────────┘

为什么这有效？
- 不需要手动找对手方（市场自动撮合）
- 通过订单簿发现价格（供需决定）
- 保证结算（代币背后有 USDC 抵押）
```

### 1.2 核心概念

CTF 是 Gnosis 开发的条件代币框架，实现了预测市场的代币化：

```
                    1 USDC
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

**核心约束**: `YES + NO = 1 USDC`

这意味着：
- 1 个 YES token + 1 个 NO token 始终等于 1 USDC
- 如果 YES 价格是 0.65，NO 价格必然接近 0.35
- 套利机会存在于 `YES + NO ≠ 1` 时

### 1.2 代币操作

| 操作 | 输入 | 输出 | 说明 |
|------|------|------|------|
| **Split** | 1 USDC | 1 YES + 1 NO | 铸造新代币 |
| **Merge** | 1 YES + 1 NO | 1 USDC | 合并回 USDC |
| **Redeem** | 1 winning token | 1 USDC | 结算后赎回 |

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

### 1.4 ⚠️ Token ID vs Position ID（关键陷阱）

**问题**：标准 CTF 合约使用 **计算的 Position ID**，但 Polymarket 使用 **自定义 Token ID**。

```typescript
// ❌ 错误: 用标准 CTF 公式计算
const positionId = keccak256(collectionId, conditionId, indexSet);
const balance = await ctf.balanceOf(wallet, positionId); // 永远是 0！

// ✅ 正确: 从 CLOB API 获取
const market = await clobClient.getMarket(conditionId);
const tokenId = market.tokens[0].token_id;  // 这是正确的 ID
const balance = await ctf.balanceOf(wallet, tokenId);
```

**为什么会这样**：
- Polymarket 将 CTF Position 包装成 ERC-1155 tokens
- 包装后的 Token ID 与原始 Position ID 不同
- **规则**: 永远从 CLOB API 获取 `tokenId`，永远不要自己计算

**受影响的操作**:
- `balanceOf()` - 余额查询
- `redeem()` - 代币赎回（推荐使用 `redeemByTokenIds()`）
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
│  │ Bid: 0.55   │  ←──→    │ Ask: 0.45   │  (同一订单!)          │
│  │ Ask: 0.57   │  ←──→    │ Bid: 0.43   │  (同一订单!)          │
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

### 2.4 交易参数

```typescript
interface TradingParams {
  minimumOrderSize: number;    // 最小订单量 (5 或 15 USDC)
  minimumTickSize: number;     // 最小价格单位 (0.001 或 0.01)
  makerBaseFee: number;        // Maker 费率
  takerBaseFee: number;        // Taker 费率
  secondsDelay: number;        // 体育赛事延迟
}
```

---

## 3. UMA - Optimistic Oracle

### 3.1 结算流程

```
┌─────────────────────────────────────────────────────────────────┐
│                    UMA 结算流程                                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  事件发生 → 提交结果 → 48h 争议期 → 结算                         │
│     │          │           │         │                          │
│     │          ▼           ▼         ▼                          │
│     │     质押 UMA     无争议?    YES=1, NO=0                   │
│     │     提交答案     有争议?    或 YES=0, NO=1                 │
│     │                  DVM 投票                                  │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 3.2 结算结果

市场结算后，代币价值变为：
- **YES wins**: YES = 1 USDC, NO = 0
- **NO wins**: YES = 0, NO = 1 USDC
- **50-50**: YES = 0.5 USDC, NO = 0.5 USDC (罕见)

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

## 4. USDC.e vs 原生 USDC（关键陷阱）

### 4.1 为什么 CTF 只接受 USDC.e

**问题**：开发者说 "我钱包里有 100 USDC 但 `split()` 失败了"

**根本原因**：Polygon 上有两种 USDC，CTF 只认一种。

```
┌─────────────────────────────────────────────────────────────┐
│ USDC.e (0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174)         │
│   - 桥接版 USDC（通过 Polygon Bridge 从以太坊桥接）          │
│   - CTF 合约为此而建                                         │
│   - 6 位小数                                                 │
│   - ✅ 可以用于 Split/Merge/Redeem                          │
│                                                             │
│ Native USDC (0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359)    │
│   - Circle 原生 Polygon USDC（后来部署）                     │
│   - CTF 合约不认识它                                         │
│   - 6 位小数                                                 │
│   - ❌ 不能用于 CTF 操作                                     │
└─────────────────────────────────────────────────────────────┘
```

### 4.2 如何处理

```typescript
import { BRIDGE_TOKENS } from '@catalyst-team/poly-sdk';

// 检查余额
const usdceBalance = await usdce.balanceOf(wallet);  // 检查这个
const nativeBalance = await native.balanceOf(wallet); // 不能用于 CTF

// 如果只有原生 USDC，需要转换
if (usdceBalance < amount && nativeBalance >= amount) {
  // 方式 1: 使用 QuickSwap
  await swapService.swap('USDC', 'USDC_E', amount);

  // 方式 2: 存入 Polymarket 后自动转换
  const depositAddr = await bridgeClient.getEvmDepositAddress(wallet);
  // 发送 Native USDC 到 depositAddr，Bridge 会自动转为 USDC.e
}
```

### 4.3 SDK 中的代币地址

```typescript
import {
  USDC_CONTRACT,        // 0x2791... (USDC.e) - CTF 使用这个
  NATIVE_USDC_CONTRACT, // 0x3c49... (Native) - 不能用于 CTF
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
│  约束: 所有选项 YES 价格之和 ≈ 1                                 │
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
interface Token {
  tokenId: string;
  conditionId: string;   // 关联市场
  outcome: 'YES' | 'NO'; // CTF 原理
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
  yesToken: Token;
  noToken: Token;
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
function calculateRedeemValue(position: Position, winner: 'YES' | 'NO'): number {
  if (position.token.outcome === winner) {
    return position.size * 1.0;  // 获胜方 = 1 USDC per token
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

### 10.1 错误 1：计算 Position ID

```typescript
// ❌ 错误: 标准 CTF 计算与 Polymarket 不匹配
const positionId = keccak256(collectionId, conditionId, indexSet);
const balance = await ctf.balanceOf(wallet, positionId); // 永远是 0！

// ✅ 正确: 从 CLOB API 获取
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

### 10.3 错误 3：用原生 USDC 进行 CTF 操作

```typescript
// ❌ 错误: 原生 USDC 不能用于 CTF
const balance = await nativeUsdc.balanceOf(wallet); // 显示 100
await ctf.split(conditionId, parseUnits('100', 6)); // 失败！

// ✅ 正确: 使用 USDC.e
const balance = await usdcE.balanceOf(wallet);
// 或转换: await swapService.swap('USDC', 'USDC_E', '100');
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
// ❌ 错误: redeem() 使用计算的 Position ID，可能找不到余额
const result = await ctf.redeem(conditionId);
// tokensRedeemed: "0" - 因为 Position ID 与 Token ID 不匹配

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
| UMA | 结算 0 或 1 | 持仓有 redeemable 状态 |
| Neg-Risk | 多选之和 = 1 | 需关联 questionID |
| USDC.e | CTF 只认 USDC.e | 检查代币类型后再操作 |
| Token ID | 不能自己计算 | 必须从 CLOB API 获取 |

### 11.2 设计检查清单

- [ ] 类型是否反映 CTF 的 YES/NO 二元结构？
- [ ] 套利计算是否使用有效价格？
- [ ] 持仓是否包含成本基础？
- [ ] 市场是否正确处理 neg-risk？
- [ ] 结算状态是否正确映射？
- [ ] 是否使用 USDC.e 而非原生 USDC？
- [ ] Token ID 是否来自 CLOB API？
- [ ] Outcome 名称是否动态获取？

---

## 参考资料

- [Polymarket Docs](https://docs.polymarket.com/)
- [Gnosis CTF](https://docs.gnosis.io/conditionaltokens/)
- [UMA Protocol](https://umaproject.org/)
