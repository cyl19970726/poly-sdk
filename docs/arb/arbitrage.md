# Polymarket 订单簿与套利机制详解

> **Status**: Production Reference
> **Last Updated**: 2026-06-20

本文档详细解释 Polymarket 订单簿的工作原理，以及如何正确计算套利机会。

核心结论：

1. YES 和 NO 是同一事件的互补资产，不是两只独立股票。
2. 普通二元市场里，最常见的 `YES.ask + NO.ask` / `YES.bid + NO.bid` 偏离通常只是 bid-ask spread，不是利润。
3. 值得优先扫描的是严格 winner-take-all 的多结果 / NegRisk 事件。
4. 任何可执行套利都必须按订单簿深度计算 VWAP，并用显式执行策略处理部分成交风险。
5. `longArbProfit` / `shortArbProfit` 是 gross signal；实盘必须扣除 CLOB taker fee、builder fee、gas/relayer、滑点和失败风险。
6. `postOnly: true` 只能用于 GTC/GTD maker 挂单；如果价格会立即成交，CLOB 会拒单，所以它不能替代 FOK/FAK 去吃当前 spread。

---

## 1. Polymarket 市场结构

### 1.1 二元市场 (Binary Market)

每个 Polymarket 市场都是一个二元预测市场：

```
市场: "Will Bitcoin reach $100,000 by December 31, 2024?"

结果:
  - YES: BTC 达到 $100k → 代币价值 $1
  - NO:  BTC 未达到 $100k → 代币价值 $1

不变量: YES + NO = $1 (市场结束时，只有一个结果获胜)
```

### 1.2 Token 对

每个市场有两个 ERC-1155 代币：

```
YES Token (tokenId: 0x123...)
  - 如果结果是 YES，价值 $1
  - 如果结果是 NO，价值 $0

NO Token (tokenId: 0x456...)
  - 如果结果是 NO，价值 $1
  - 如果结果是 YES，价值 $0
```

---

## 2. 订单簿的镜像特性

### 2.1 关键洞察：买 YES = 卖 NO

这是理解 Polymarket 订单簿的核心概念：

```
┌────────────────────────────────────────────────────────────────┐
│                        等价关系                                 │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│   买 YES @ $0.40  ≡  卖 NO @ $0.60                             │
│   卖 YES @ $0.40  ≡  买 NO @ $0.60                             │
│                                                                │
│   一般形式:                                                     │
│   买 YES @ P  ≡  卖 NO @ (1-P)                                 │
│   卖 YES @ P  ≡  买 NO @ (1-P)                                 │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

### 2.2 为什么会这样？

考虑做市商的视角：

```
做市商持有: 100 YES + 100 NO (通过 Split $100 获得)

如果做市商想卖出 1 YES @ $0.40:
  - 他可以直接在 YES 订单簿挂 Ask @ $0.40
  - 或者他可以在 NO 订单簿挂 Bid @ $0.60

两种方式对做市商来说是等价的：
  - 卖 YES @ $0.40 → 收到 $0.40
  - 买 NO @ $0.60 (如果对手方想卖 NO @ $0.60)
    → 做市商支付 $0.60，但现在有了完整的 YES+NO 对
    → 可以 Merge 获得 $1
    → 净收益 = $1 - $0.60 = $0.40
```

### 2.3 订单簿镜像示例

```
┌─────────────────────────────────────────────────────────────────────┐
│                         原始订单                                      │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│ 用户 A: "我想以 $0.40 买入 100 个 YES"                               │
│ 用户 B: "我想以 $0.65 卖出 50 个 YES"                                │
│                                                                     │
├─────────────────────────────────────────────────────────────────────┤
│                      这些订单如何显示                                 │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│ YES Token 订单簿:              NO Token 订单簿:                      │
│                                                                     │
│ ┌─────────────────────┐       ┌─────────────────────┐              │
│ │ Bids      │ Asks    │       │ Bids      │ Asks    │              │
│ ├───────────┼─────────┤       ├───────────┼─────────┤              │
│ │ 0.40 x100 │ 0.65 x50│       │ 0.35 x50  │ 0.60 x100│             │
│ │ (用户 A)  │ (用户 B) │       │ (用户 B)   │ (用户 A) │             │
│ └───────────┴─────────┘       └───────────┴─────────┘              │
│                                                                     │
│ 注意:                                                               │
│ - 用户 A 的买 YES 订单，变成了 NO 的卖单 (Ask @ 0.60 = 1 - 0.40)    │
│ - 用户 B 的卖 YES 订单，变成了 NO 的买单 (Bid @ 0.35 = 1 - 0.65)    │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

上图是经济等价关系示例，不是 API 快照保证。生产代码不能假设每个订单在 YES/NO 两个 orderbook 中总是以完全镜像、同步、同排序、同去重方式出现。SDK 中可以用有效价格做 quote normalization，但执行前仍要按真实订单簿深度逐档计算，并避免把互补流动性重复计入可成交数量。

---

## 3. 套利机会分析

### 3.1 错误的计算方式

常见错误是把 YES 和 NO 当作两只独立资产，直接相加：

```typescript
// 错误！会导致重复计算
const askSum = yesAsk + noAsk;   // 0.65 + 0.60 = 1.25
const bidSum = yesBid + noBid;   // 0.40 + 0.35 = 0.75

// 这些数字没有意义，因为互补流动性被重复计算
```

如果看到 `YES.ask + NO.ask > 1` 或 `YES.bid + NO.bid < 1`，大多数情况下只是正常 spread 的反映。真正的套利判断必须先把直接交易和通过 split/merge 间接转换的路径都纳入同一套有效价格。

### 3.2 正确的计算方式

实际可执行的交易成本：

```
┌─────────────────────────────────────────────────────────────────────┐
│                        正确的套利计算                                 │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│ 目标: 买入 1 YES + 1 NO (用于 Merge 获得 $1)                        │
│                                                                     │
│ 买 YES 的成本:                                                      │
│   方式 1: 直接买 YES @ YES.ask = $0.65                              │
│   方式 2: 通过卖 NO 获得 (成本 = 1 - NO.bid = 1 - 0.35 = $0.65)     │
│   最低成本 = min(0.65, 0.65) = $0.65                                │
│                                                                     │
│ 买 NO 的成本:                                                       │
│   方式 1: 直接买 NO @ NO.ask = $0.60                                │
│   方式 2: 通过卖 YES 获得 (成本 = 1 - YES.bid = 1 - 0.40 = $0.60)   │
│   最低成本 = min(0.60, 0.60) = $0.60                                │
│                                                                     │
│ 总成本 = $0.65 + $0.60 = $1.25                                      │
│ Merge 收益 = $1.00                                                  │
│ 利润 = $1.00 - $1.25 = -$0.25 (没有套利机会)                        │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 3.3 套利的真正公式

```
Long Arbitrage (买双边 + Merge):
  有效买 YES 成本 = min(YES.ask, 1 - NO.bid)
  有效买 NO 成本  = min(NO.ask, 1 - YES.bid)
  总成本 = 有效买 YES + 有效买 NO
  Gross 利润 = 1 - 总成本

  当 总成本 < 1 时，只能说明存在 gross 候选机会

Short Arbitrage (Split + 卖双边):
  有效卖 YES 收入 = max(YES.bid, 1 - NO.ask)
  有效卖 NO 收入  = max(NO.bid, 1 - YES.ask)
  总收入 = 有效卖 YES + 有效卖 NO
  Gross 利润 = 总收入 - 1

  当 总收入 > 1 时，只能说明存在 gross 候选机会
```

净利润还必须扣除：

```text
netProfit = grossProfit - platformFees - builderFees - gasOrRelayerCost - slippageBuffer - failureRiskBuffer
```

Polymarket CLOB V2 平台费由 market fee config 决定，常见形式是：

```text
platformFee = size * feeRate * price * (1 - price)
```

当前 SDK 的 `checkArbitrage()` / `longArbProfit` / `shortArbProfit` 保留为 gross 初筛。`ArbitrageService.scanMarkets()` 和启动后的 WebSocket `checkOpportunity()` 对二元市场默认走 fee-aware 路径，返回/触发的 `profitRate` / `profitPercent` 是扣除平台费和 builder fee 后的 net 值；如显式传 `feeAware: false`，才是 gross 初筛。生产执行请使用 `checkArbitrageWithFees()`、`MarketService.detectArbitrageNet()`、`TradingService.estimateBinaryArbitrageFees()` 或多腿场景的 `estimateMultiLegArbitrageFees()`。

如果执行策略想保证 maker 身份，可以在限价单上设置 `postOnly: true`。这会让订单只挂簿不吃单；任何会 cross spread 的订单都会被 CLOB 拒绝。换句话说，post-only 适合做市/报价，不适合立即执行套利。立即执行路径仍应使用 FOK 或 FAK（IOC-style，能成交的部分成交，剩余取消）并按 taker fee 建模。

### 3.4 简化公式（利用镜像特性）

由于 YES.ask = 1 - NO.bid 和 NO.ask = 1 - YES.bid（在理想情况下）：

```
实际上，我们只需要看一个 token 的 spread:

YES Spread = YES.ask - YES.bid

Long Arb 成本 = YES.ask + (1 - YES.bid) = 1 + YES.spread
Short Arb 收入 = YES.bid + (1 - YES.ask) = 1 - YES.spread

因此:
  Long Arb 利润 = 1 - (1 + spread) = -spread
  Short Arb 利润 = (1 - spread) - 1 = -spread

结论: 在正常市场中，spread > 0，所以没有套利机会
      只有当出现定价错误（spread < 0 或跨市场价格不一致）时才有套利
```

### 3.5 普通二元市场中的直觉陷阱

假设一个普通二元市场：

```
YES bid = 0.40
YES ask = 0.65

镜像后通常接近:
NO ask = 1 - YES.bid = 0.60
NO bid = 1 - YES.ask = 0.35
```

朴素相加会得到：

```
YES.ask + NO.ask = 0.65 + 0.60 = 1.25
YES.bid + NO.bid = 0.40 + 0.35 = 0.75
```

这不是一个“偏离 1 的套利信号”，而是同一组 bid/ask spread 的两种展示方式：

```
Long Arb 成本 = YES.ask + (1 - YES.bid)
              = 0.65 + 0.60
              = 1.25 = 1 + spread

Short Arb 收入 = YES.bid + (1 - YES.ask)
                = 0.40 + 0.35
                = 0.75 = 1 - spread
```

在普通二元市场里，spread 是成本。只有当有效买入成本低于 1，或有效卖出收入高于 1，并且扣除费用、滑点和失败风险后仍为正，才可能是可执行机会。

---

## 4. 真正的套利场景

### 4.1 场景 1: 订单簿错配

```
┌─────────────────────────────────────────────────────────────────────┐
│                     订单簿错配套利                                    │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│ YES 订单簿:                   NO 订单簿:                            │
│ ┌───────────┬─────────┐       ┌───────────┬─────────┐              │
│ │ Bid       │ Ask     │       │ Bid       │ Ask     │              │
│ ├───────────┼─────────┤       ├───────────┼─────────┤              │
│ │ 0.52      │ 0.53    │       │ 0.49      │ 0.50    │              │
│ └───────────┴─────────┘       └───────────┴─────────┘              │
│                                                                     │
│ 检测:                                                               │
│   YES.ask + NO.ask = 0.53 + 0.50 = 1.03 (> 1, 没有 Long Arb)        │
│   YES.bid + NO.bid = 0.52 + 0.49 = 1.01 (> 1, 有 Short Arb!)        │
│                                                                     │
│ 但等等！我们需要检查真实可执行价格:                                   │
│   真实卖 YES = max(YES.bid, 1 - NO.ask) = max(0.52, 0.50) = 0.52    │
│   真实卖 NO  = max(NO.bid, 1 - YES.ask) = max(0.49, 0.47) = 0.49    │
│   总收入 = 0.52 + 0.49 = 1.01 > 1.00                                │
│                                                                     │
│ 策略:                                                               │
│   1. Split $1000 → 1000 YES + 1000 NO                               │
│   2. Sell YES @ 0.52 → $520                                         │
│   3. Sell NO @ 0.49 → $490                                          │
│   4. Total = $1010, Profit = $10 (1%)                               │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 4.2 场景 2: 跨市场套利（多结果市场）

```
┌─────────────────────────────────────────────────────────────────────┐
│                     多结果市场套利                                    │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│ 市场: "2024 美国总统大选赢家?"                                       │
│                                                                     │
│ 结果 A: Trump    @ $0.55                                            │
│ 结果 B: Biden    @ $0.30                                            │
│ 结果 C: Harris   @ $0.20                                            │
│ 结果 D: Other    @ $0.02                                            │
│ ─────────────────────────                                           │
│ 总和 = $1.07 (> $1.00)                                              │
│                                                                     │
│ 这种情况下可以 Short Arb:                                            │
│   Split $100 → 100 份每个结果                                        │
│   卖出全部 → $107                                                    │
│   利润 = $7 (7%)                                                    │
│                                                                     │
│ 注意: 这需要多结果市场支持，不适用于简单的 YES/NO 市场               │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 5. 实现代码

### 5.1 正确的套利检测

```typescript
/**
 * 计算有效的买入/卖出价格
 * 考虑镜像订单的影响
 */
export function getEffectivePrices(
  yesAsk: number,
  yesBid: number,
  noAsk: number,
  noBid: number
): {
  effectiveBuyYes: number;   // 买 YES 的最低成本
  effectiveBuyNo: number;    // 买 NO 的最低成本
  effectiveSellYes: number;  // 卖 YES 的最高收入
  effectiveSellNo: number;   // 卖 NO 的最高收入
} {
  return {
    // 买 YES: 直接买 YES.ask 或者 通过卖 NO (成本 = 1 - NO.bid)
    effectiveBuyYes: Math.min(yesAsk, 1 - noBid),

    // 买 NO: 直接买 NO.ask 或者 通过卖 YES (成本 = 1 - YES.bid)
    effectiveBuyNo: Math.min(noAsk, 1 - yesBid),

    // 卖 YES: 直接卖 YES.bid 或者 通过买 NO (收入 = 1 - NO.ask)
    effectiveSellYes: Math.max(yesBid, 1 - noAsk),

    // 卖 NO: 直接卖 NO.bid 或者 通过买 YES (收入 = 1 - YES.ask)
    effectiveSellNo: Math.max(noBid, 1 - yesAsk),
  };
}

/**
 * 检测套利机会
 */
export function checkArbitrage(
  yesAsk: number,
  noAsk: number,
  yesBid: number,
  noBid: number
): ArbitrageOpportunity | null {
  const effective = getEffectivePrices(yesAsk, yesBid, noAsk, noBid);

  // Long Arb: 买双边 + Merge
  const longCost = effective.effectiveBuyYes + effective.effectiveBuyNo;
  const longProfit = 1 - longCost;

  // Short Arb: Split + 卖双边
  const shortRevenue = effective.effectiveSellYes + effective.effectiveSellNo;
  const shortProfit = shortRevenue - 1;

  if (longProfit > 0) {
    return {
      type: 'long',
      profit: longProfit,
      description: `Buy YES @ ${effective.effectiveBuyYes.toFixed(4)} + NO @ ${effective.effectiveBuyNo.toFixed(4)}, Merge for $1`,
    };
  }

  if (shortProfit > 0) {
    return {
      type: 'short',
      profit: shortProfit,
      description: `Split $1, Sell YES @ ${effective.effectiveSellYes.toFixed(4)} + NO @ ${effective.effectiveSellNo.toFixed(4)}`,
    };
  }

  return null;
}
```

### 5.2 费用感知检测

```typescript
import {
  checkArbitrageWithFees,
  estimateBinaryArbitrageFees,
} from '@catalyst-team/poly-sdk';

const candidate = checkArbitrageWithFees(
  yesAsk,
  yesBid,
  noAsk,
  noBid,
  {
    size: 10,
    rate: 0.03,
    exponent: 1,
    takerOnly: true,
    liquidityRole: 'taker',
  }
);

if (candidate && candidate.netProfit > 0.05) {
  console.log(candidate.netProfit);
}

const long = estimateBinaryArbitrageFees({
  type: 'long',
  size: 10,
  yesPrice: 0.49,
  noPrice: 0.49,
  rate: 0.03,
});
```

如果从 conditionId 开始，优先让 service 从 CLOB market info 读取 fee 参数：

```typescript
const book = await markets.getFeeAwareProcessedOrderbook(conditionId, { size: 10 });
const opportunity = await markets.detectArbitrageNet(conditionId, {
  size: 10,
  threshold: 0.05,
});
```

实测风险提示：2026-06-20 的 1 pUSD 级 live smoke 中，6 股 France 2026 World Cup YES 以 `0.197` 买入、`0.196` 卖出，价差损失只有 `0.006` pUSD，但总成本约 `0.06283` pUSD，主要来自 CLOB taker fee。低价小 tick round trip 不能只看 spread。

---

## 6. 实际市场观察

### 6.1 为什么大多数时候没有套利？

```
市场效率:
  - 做市商会主动消除价差
  - 套利机器人在毫秒级别执行
  - Gas 成本 (~$0.01-0.05) 吃掉小利润

典型观察:
  - YES.ask ≈ 1 - NO.bid (镜像关系成立)
  - Spread ≈ 0.5% - 2%
  - 套利空间 ≈ -spread (负数，无利可图)
```

### 6.2 什么时候会有套利？

```
1. 市场剧烈波动时
   - 新闻事件导致价格快速变化
   - 订单簿来不及完全调整

2. 低流动性市场
   - 订单簿深度不足
   - 大单冲击导致价格偏离

3. 系统延迟
   - 不同交易者的延迟差异
   - 链上确认时间差

4. 新市场上线
   - 初始定价可能不准确
   - 套利者尚未入场
```

---

## 7. 总结

### 核心要点

1. **互补流动性**: 买 YES @ P 与卖 NO @ (1-P) 在经济上等价，但 API 快照不应被假设为逐笔完全镜像
2. **等价关系**: 买 YES @ P = 卖 NO @ (1-P)
3. **有效价格**: 计算套利时要用 min/max 取最优价格
4. **Spread = 成本**: 在正常市场中，spread 就是交易成本
5. **费用优先**: gross profit 不是净利润，CLOB taker fee 经常大于一两个 tick 的价差
6. **市场效率**: 大多数时候不存在无风险套利
7. **深度优先**: top-of-book 只能做初筛，真实利润要按目标规模走订单簿深度
8. **NegRisk 要验证**: 只有同一事件、互斥且穷尽的 NegRisk 组才满足多结果求和逻辑

### 代码检查清单

- [ ] 使用 `getEffectivePrices()` 而不是直接相加
- [ ] Long Arb gross 利润 = 1 - (effectiveBuyYes + effectiveBuyNo)
- [ ] Short Arb gross 利润 = (effectiveSellYes + effectiveSellNo) - 1
- [ ] 使用 `getClobMarketInfo(conditionId)` / SDK fee-aware API 读取 `fd.r`、`fd.e`、`fd.to`、`mbf`、`tbf`
- [ ] 净利润 = gross profit - platform fees - builder fees - gas/relayer - slippage/failure buffer
- [ ] top-of-book 只用于发现候选机会，执行前必须按订单簿深度计算 VWAP
- [ ] 多结果策略必须确认 `market.negRisk === true`，且所有市场属于同一事件和同一互斥结果空间
- [ ] 执行路径必须显式使用 FOK/FAK (IOC-style)/批量下单、最小利润保护、最大滑点保护和失败处理

---

## 8. CTF 合约架构：两种市场类型

Polymarket 使用 **两种不同的 CTF (Conditional Token Framework) 合约**，理解它们的区别对于套利策略至关重要。

### 8.1 标准 CTF 合约 (Standard Binary Markets)

```
┌─────────────────────────────────────────────────────────────────────┐
│                     标准 CTF 合约                                     │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│ 合约地址: 0x4D97DCd97eC945f40cF65F87097ACe5EA0476045                │
│                                                                     │
│ 用途: 简单的二元市场 (Yes/No)                                        │
│                                                                     │
│ 操作:                                                               │
│   - Split:  pUSD → YES + NO token                                  │
│   - Merge:  YES + NO → pUSD                                        │
│   - Redeem: Winning tokens → pUSD (市场结算后)                      │
│                                                                     │
│ 特点:                                                               │
│   - 每个市场独立                                                     │
│   - YES + NO 代币只在同一市场内有意义                                │
│   - 适用于大多数简单预测市场                                         │
│                                                                     │
│ 示例市场:                                                           │
│   - "BTC 年底前会达到 $100k 吗?"                                    │
│   - "Fed 会在下次会议降息吗?"                                        │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 8.2 NegRisk CTF 合约 (Winner-Take-All Events)

```
┌─────────────────────────────────────────────────────────────────────┐
│                     NegRisk CTF 系统                                  │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│ CTF 合约:    0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E            │
│ CTF 交易所: 0xC5d563A36AE78145C45a50134d48A1215220f80a             │
│ Neg Adapter: 0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296            │
│                                                                     │
│ 用途: "Winner-Take-All" 多结果事件                                   │
│                                                                     │
│ 关键创新:                                                           │
│   ┌──────────────────────────────────────────────────────────────┐ │
│   │ NO share 可以转换为其他所有市场的 YES share！                  │ │
│   └──────────────────────────────────────────────────────────────┘ │
│                                                                     │
│ 示例: 2024 美国总统大选                                              │
│                                                                     │
│   Market A: "Trump 赢?" → 持有 Trump NO                             │
│   Market B: "Harris 赢?"                                            │
│   Market C: "Biden 赢?"                                             │
│                                                                     │
│   通过 NegRisk Adapter:                                             │
│     Trump NO → Harris YES + Biden YES + ...                        │
│                                                                     │
│   这意味着: 买 Trump NO = 押注 "任何其他人赢"                        │
│                                                                     │
│ 资本效率优势:                                                        │
│   - 不需要在每个候选人市场都买 YES                                   │
│   - 只需买一个候选人的 NO，就等于投资了所有其他人                    │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 8.3 如何判断市场类型？

```typescript
// 通过 Gamma API 获取市场信息
const market = await gammaApi.getMarketByConditionId(conditionId);

// 检查是否是 NegRisk 市场
if (market.negRisk === true) {
  // 使用 NegRisk CTF 合约
  // 可以进行 NO → YES 转换
} else {
  // 使用标准 CTF 合约
  // 只能做 split/merge/redeem
}
```

---

## 9. 多结果市场套利策略 (NegRisk Arbitrage)

这是 Polymarket 最有价值的套利机会来源！

不能仅因为页面看起来像“多候选人事件”就启用 `ΣYES ≈ 1` 逻辑。生产系统必须先确认：

- 每个候选市场的 `negRisk === true`
- 所有 markets 属于同一个 event / `negRiskMarketId`
- 结果空间互斥且穷尽，包含清晰的 `Other` 或等价兜底项
- resolution rules 一致，不存在多个结果可同时为真
- 没有会破坏组合 payoff 的 void / cancellation / ambiguous settlement 条款

只要这些条件不满足，`ΣYES ≈ 1` 的数学基础就不成立，扫描结果只能作为人工研究线索，不能作为自动交易信号。

费用处理也必须逐腿完成：对同一 `negRiskMarketId` 下的每个候选 market 读取 `getClobMarketInfo(conditionId)`，把 `fd.r`、`fd.e`、`fd.to`、`mbf`、`tbf` 填入 `estimateMultiLegArbitrageFees()`。不要把二元市场的 `getFeeAwareProcessedOrderbook()` 直接套到整个多结果事件上。

### 9.1 多结果市场的套利原理

```
┌─────────────────────────────────────────────────────────────────────┐
│                   多结果市场套利 (Winner-Take-All)                    │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│ 事件: "2024 NBA 总冠军?"                                             │
│                                                                     │
│ 结果 (n 个候选):                                                     │
│   Lakers:   YES @ $0.15   NO @ $0.85                               │
│   Celtics:  YES @ $0.35   NO @ $0.65                               │
│   Nuggets:  YES @ $0.25   NO @ $0.75                               │
│   Warriors: YES @ $0.18   NO @ $0.82                               │
│   Mavs:     YES @ $0.05   NO @ $0.95                               │
│   Other:    YES @ $0.02   NO @ $0.98                               │
│                                                                     │
│ 不变量: 只有一个结果会赢，所有 YES 应该加起来 = $1.00                 │
│                                                                     │
│ 实际情况:                                                           │
│   YES 总和 = 0.15 + 0.35 + 0.25 + 0.18 + 0.05 + 0.02 = $1.00       │
│   NO 总和 = 0.85 + 0.65 + 0.75 + 0.82 + 0.95 + 0.98 = $5.00        │
│                                                                     │
│ 等等！NO 总和应该 = (n-1) * $1 = 5 * $1 = $5.00 ✓                   │
│                                                                     │
│ 套利条件:                                                           │
│   如果 Σ(YES prices) < $1.00 → Long Arb (买所有 YES，持有到结算)    │
│   如果 Σ(YES prices) > $1.00 → Short Arb (卖所有 YES)               │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 9.2 实际套利机会示例

```
┌─────────────────────────────────────────────────────────────────────┐
│                    多结果 Short Arb 示例                              │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│ 事件: "下一任法国总统?"                                               │
│                                                                     │
│ 候选人 YES 价格:                                                     │
│   Macron:   $0.45                                                  │
│   Le Pen:   $0.35                                                  │
│   Mélenchon: $0.15                                                 │
│   Zemmour:  $0.08                                                  │
│   Other:    $0.05                                                  │
│   ─────────────────                                                 │
│   总和:     $1.08  (> $1.00，存在套利!)                             │
│                                                                     │
│ 套利策略:                                                           │
│   1. Split $1000 → 获得每个结果 1000 份 tokens                       │
│   2. 卖出所有 YES tokens:                                           │
│      - 卖 Macron YES @ $0.45 → $450                                │
│      - 卖 Le Pen YES @ $0.35 → $350                                │
│      - 卖 Mélenchon YES @ $0.15 → $150                             │
│      - 卖 Zemmour YES @ $0.08 → $80                                │
│      - 卖 Other YES @ $0.05 → $50                                  │
│   3. 总收入: $1080                                                  │
│   4. 利润: $1080 - $1000 = $80 (8%)                                │
│                                                                     │
│ 风险: 低于方向性持仓，但依赖完整成交和正常结算                         │
│ 成本: Gas fee (~$0.05) + 交易手续费                                  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 9.3 多结果 Long Arb (更少见)

```
┌─────────────────────────────────────────────────────────────────────┐
│                    多结果 Long Arb 示例                               │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│ 场景: 新市场刚上线，定价不足                                          │
│                                                                     │
│ 候选人 YES 价格:                                                     │
│   候选人 A: $0.30                                                   │
│   候选人 B: $0.28                                                   │
│   候选人 C: $0.22                                                   │
│   候选人 D: $0.12                                                   │
│   ─────────────────                                                 │
│   总和:     $0.92  (< $1.00，存在套利!)                             │
│                                                                     │
│ 套利策略:                                                           │
│   1. 买入所有 YES tokens:                                           │
│      - 买 A YES @ $0.30 × 1000 = $300                              │
│      - 买 B YES @ $0.28 × 1000 = $280                              │
│      - 买 C YES @ $0.22 × 1000 = $220                              │
│      - 买 D YES @ $0.12 × 1000 = $120                              │
│   2. 总成本: $920                                                   │
│   3. 无论谁赢，你都有 1000 个获胜 tokens = $1000                    │
│   4. 利润: $1000 - $920 = $80 (8.7%)                               │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 9.4 NegRisk Conversion 套利

```
┌─────────────────────────────────────────────────────────────────────┐
│                   NegRisk Conversion 高级策略                         │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│ 场景: 利用 NO → YES 转换机制                                         │
│                                                                     │
│ 事件: 3 候选人选举                                                   │
│   A: YES @ $0.50, NO @ $0.50                                       │
│   B: YES @ $0.30, NO @ $0.70                                       │
│   C: YES @ $0.25, NO @ $0.75                                       │
│                                                                     │
│ 发现:                                                               │
│   买 A NO @ $0.50                                                   │
│   = 押注 "A 不会赢"                                                 │
│   = 押注 "B 或 C 会赢"                                              │
│                                                                     │
│ 但是:                                                               │
│   买 B YES + C YES 直接成本 = $0.30 + $0.25 = $0.55                │
│   买 A NO 成本 = $0.50                                              │
│                                                                     │
│ 套利策略:                                                           │
│   1. 买入 A NO @ $0.50 (获得 B+C 敞口)                              │
│   2. Convert: A NO → B YES + C YES                                 │
│   3. 卖出 B YES @ $0.30 + C YES @ $0.25 = $0.55                    │
│   4. 利润: $0.55 - $0.50 = $0.05 (10%)                             │
│                                                                     │
│ 注意: 这需要使用 Neg Risk Adapter 合约进行转换                       │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 10. 监控与执行策略

### 10.1 多结果市场扫描

```typescript
/**
 * 扫描多结果市场的套利机会
 */
async function scanMultiOutcomeArbitrage(eventId: string): Promise<ArbitrageOpportunity | null> {
  // 获取事件下所有市场
  const event = await gammaApi.getEvent(eventId);
  const markets = event.markets;

  // 注意：这是监控初筛示例，不是生产执行价格。
  // 生产执行前必须用实时订单簿深度计算目标规模的 VWAP。

  // 计算所有 YES 价格总和
  let yesSum = 0;
  const marketPrices: Map<string, number> = new Map();

  for (const market of markets) {
    const yesPrice = market.outcomePrices[0]; // YES 通常是第一个
    yesSum += yesPrice;
    marketPrices.set(market.conditionId, yesPrice);
  }

  // 检测套利
  if (yesSum < 0.99) {
    // Long Arb: 买所有 YES
    return {
      type: 'MULTI_LONG',
      profit: 1 - yesSum,
      profitPercent: ((1 - yesSum) / yesSum) * 100,
      markets: marketPrices,
      action: 'BUY_ALL_YES',
    };
  }

  if (yesSum > 1.01) {
    // Short Arb: 卖所有 YES
    return {
      type: 'MULTI_SHORT',
      profit: yesSum - 1,
      profitPercent: ((yesSum - 1) / 1) * 100,
      markets: marketPrices,
      action: 'SELL_ALL_YES',
    };
  }

  return null; // 没有套利机会
}
```

上面的示例只适合发现候选事件。真实执行前需要把每个候选市场的 `outcomePrices` 替换为订单簿可成交价格，并对目标规模逐档撮合。

### 10.2 可成交规模：不要只看 top-of-book

top-of-book 只能回答“第一美元是否看起来有利润”，不能回答“目标规模是否能成交”。例如：

```
A YES ask = 0.30, size = 5
A YES ask = 0.32, size = 1000
A YES ask = 0.35, size = 2000
```

如果策略想买 1000 份，不能用 `0.30` 计算利润。必须逐档计算 VWAP：

```
VWAP = Σ(price_i * fillSize_i) / Σ(fillSize_i)
```

生产级扫描至少要输出：

- 目标交易规模
- 每个 leg 的可成交数量
- 每个 leg 的 VWAP
- 扣除费用和 gas 后的净利润
- 最薄 leg 决定的最大安全规模

### 10.3 执行原子性

理论套利通常由多个订单组成。真实执行时，如果只成交一部分，风险会从“套利”变成裸露方向性仓位：

- 买了 A/B/C 的 YES，但 D 没买到
- 卖出了几个候选人的 YES，但剩余 leg 未成交
- split/merge 或 NegRisk conversion 成功，但 CLOB leg 失败

因此自动执行必须显式配置：

- FOK 或 FAK (IOC-style) 订单类型
- 批量下单或顺序下单的失败策略
- `minProfitAfterFees`，成交后低于阈值立即停止
- `maxSlippageBps`，任何 leg 超限即取消
- 部分成交后的回滚 / 对冲 / 清仓逻辑
- 如使用 `postOnly: true`，必须把它视作 maker 报价策略：可能不成交，不能作为立即吃 spread 的套利执行手段

### 10.4 数据源和 fallback 必须显式

套利检测不能在数据不完整时悄悄 fallback 到另一个来源。例如 WebSocket 订单簿过期、缺少某个 leg 深度、Gamma 事件 markets 不完整时，结果应标记为 `nonExecutable` 或直接跳过。

SDK/策略层应把数据源选择暴露为显式参数，而不是在内部自动切换。否则业务侧很难判断机会是来自实时订单簿、缓存快照，还是 Gamma 的展示价格。

### 10.5 建议的监控策略

```
┌─────────────────────────────────────────────────────────────────────┐
│                      套利监控优先级                                    │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│ 1. 高优先级: 多结果事件 (NegRisk Markets)                            │
│    - 选举: 总统/市长/议会                                            │
│    - 体育冠军: NBA/NFL/World Cup                                     │
│    - 颁奖典礼: Oscar/Grammy                                          │
│    └─ 套利机会更频繁，利润更高                                       │
│                                                                     │
│ 2. 中优先级: 高流动性二元市场                                        │
│    - 宏观经济: Fed 利率决定                                          │
│    - 加密货币: BTC 价格里程碑                                        │
│    └─ 偶尔有价格错配，但竞争激烈                                     │
│                                                                     │
│ 3. 低优先级: 低流动性二元市场                                        │
│    - 小众事件                                                       │
│    └─ 有机会但难以执行大额                                          │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 11. 盈利预期与风险

### 11.1 预期收益

| 市场类型 | 套利频率 | 典型利润 | 竞争程度 |
|---------|---------|---------|---------|
| 多结果 Short | 每周 2-5 次 | 1-5% | 中等 |
| 多结果 Long | 每月 1-2 次 | 2-8% | 低 |
| 二元市场 | 罕见 | 0.1-0.5% | 极高 |
| NegRisk Conversion | 每周 1-3 次 | 0.5-2% | 中等 |

### 11.2 风险因素

```
1. 执行风险
   - 价格在执行过程中变化
   - 深度不足导致滑点
   - 链上交易失败

2. 智能合约风险
   - 合约 bug 导致资金损失
   - 市场结算异常

3. 流动性风险
   - 无法全部成交
   - 被更快的套利者抢先

4. NegRisk 资格风险
   - 候选项不完整或 Other 定义不清
   - resolution rules 不一致
   - 市场可能 void 或多个结果同时为真

5. Gas 成本
   - 多次交易累积成本
   - 网络拥堵时成本飙升

缓解措施:
   - 设置最小利润阈值 (>0.5%)
   - 使用 FOK/FAK (IOC-style) 和批量执行控制部分成交
   - 按订单簿深度计算 VWAP，不用单一 top-of-book 价格
   - 对 NegRisk 组做 event、negRiskMarketId、互斥穷尽和规则一致性校验
   - 监控 Gas 价格，高峰期不操作
   - 从小额开始测试
```

---

## 12. 实施路线图

```
Phase 1: 监控 (已完成)
   ✅ 多结果市场 YES 价格总和监控
   ✅ 二元市场有效价格计算
   ✅ 套利机会检测

Phase 2: 通知 (进行中)
   □ 发现机会时发送通知
   □ 利润/深度/VWAP/风险评估

Phase 3: 半自动执行
   □ 一键执行套利
   □ 预设参数确认后执行
   □ 部分成交后的回滚或清仓

Phase 4: 全自动执行
   □ 自动检测 + 自动执行
   □ FOK/FAK (IOC-style)/批量执行与风控系统
   □ 利润跟踪
```
