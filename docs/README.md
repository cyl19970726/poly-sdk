# poly-sdk Documentation

> Polymarket SDK for data analysis and trading

---

## 推荐学习路径

### 🚀 新手入门（按顺序阅读）

```
1. 先理解原理（为什么 Polymarket 这样设计）
   └── concepts/polymarket-principles.md

2. 再看 API 参考（怎么使用）
   └── api/01-overview.md

3. 最后看架构（如何扩展）
   └── architecture/01-overview.md
```

### ⚠️ 避免常见陷阱

在开始写代码之前，请先了解这些关键概念（详见 polymarket-principles.md）：

| 陷阱 | 问题 | 解决方案 |
|------|------|----------|
| **USDC 类型** | 用原生 USDC 进行 CTF 操作失败 | CTF 只接受 USDC.e (0x2791...) |
| **Token ID** | 用标准 CTF 公式计算 Position ID | 必须从 CLOB API 获取 tokenId |
| **订单簿镜像** | YES.ask + NO.ask = ~2.0 | 使用有效价格计算 |
| **Outcome 名称** | 硬编码 "YES"/"NO" | 动态获取（可能是 "Up"/"Down"） |
| **Redeem 方法** | `redeem()` 找不到余额 | 使用 `redeemByTokenIds()` |

---

## Quick Navigation

### For Learners - Understanding Polymarket

| Document | Description |
|----------|-------------|
| [concepts/polymarket-principles.md](concepts/polymarket-principles.md) | **必读** - Polymarket 原理深度解析（含常见陷阱） |

### For Developers - API Reference

| Document | Description |
|----------|-------------|
| [api/01-overview.md](api/01-overview.md) | Complete API reference |
| [api/02-leaderboard.md](api/02-leaderboard.md) | Leaderboard API |
| [api/03-position-activity.md](api/03-position-activity.md) | Position and activity tracking API |

### For Developers - Practical Guides

| Document | Description |
|----------|-------------|
| [guides/copy-trading.md](guides/copy-trading.md) | Copy trading analysis and implementation |
| [arb/arbitrage.md](arb/arbitrage.md) | Arbitrage mechanics and calculation |

### For Contributors - SDK Architecture

| Document | Description |
|----------|-------------|
| [architecture/01-overview.md](architecture/01-overview.md) | Service layer design and responsibilities |
| [architecture/02-websocket.md](architecture/02-websocket.md) | WebSocket implementation details |
| [architecture/03-data-model.md](architecture/03-data-model.md) | Data model design |

---

## Other Resources

### Reports

| Document | Description |
|----------|-------------|
| [reports/smart-money-analysis-2025-12-23-cn.md](reports/smart-money-analysis-2025-12-23-cn.md) | Smart money analysis report |

### Plans

| Document | Description |
|----------|-------------|
| [plans/2024-12-29-docs-and-datamodel-refactor.md](plans/2024-12-29-docs-and-datamodel-refactor.md) | Current refactoring plan |

### Testing

| Document | Description |
|----------|-------------|
| [test/e2e-test-plan.md](test/e2e-test-plan.md) | End-to-end testing plan |
| [arb/test-plan.md](arb/test-plan.md) | Arbitrage test plan |
| [arb/test-results.md](arb/test-results.md) | Arbitrage test results |

### Archive (Design Process Documents)

These documents record the design process and are not required reading:

| Document | Description |
|----------|-------------|
| [archive/design-retrospective.md](archive/design-retrospective.md) | Design retrospective |
| [archive/architecture-deep-dive.md](archive/architecture-deep-dive.md) | Early architecture exploration |
| [archive/api-verification.md](archive/api-verification.md) | API verification notes |
| [archive/old-design.md](archive/old-design.md) | Original design document (superseded) |

---

## Directory Structure

```
docs/
├── README.md                 # This file - navigation
├── concepts/                 # Conceptual understanding
├── architecture/             # SDK internal architecture
├── api/                      # API reference
├── guides/                   # Practical guides
├── arb/                      # Arbitrage documentation
├── reports/                  # Analysis reports
├── plans/                    # Planning documents
├── test/                     # Testing documentation
└── archive/                  # Archived design documents
```
