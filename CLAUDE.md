# poly-sdk 开发约定（给 Codex/Claude 的最短手册）

> 目标：让对 `@catalyst-team/poly-sdk` 的修改保持一致、可验证、可回滚。

## 这个 SDK 的边界

- `RealtimeServiceV2`：直连 Polymarket WS（低延迟原始事实：orderbook/trades/price_change 等）
- `DataApiClient`：Polymarket Data API（钱包/交易/排行榜等）
- `GammaApiClient`：Polymarket Gamma API（市场发现、搜索、trending、event）
- `MarketService`/`WalletService`/`SmartMoneyService`：在 clients 之上做组合与业务友好的聚合

> 项目级架构里提到的 `CatalystQueryService`/`CatalystRealtimeService`/`CatalystDataWorker` 是“我们自己的数据面”，不属于 Polymarket 原生 API；若要在 SDK 内实现，务必新开目录与清晰命名，避免和 Polymarket clients 混在一起。

## 开发规则（必须）

1) **先找现有实现再加新文件**：优先复用 `src/clients/*` 的风格与 `RateLimiter`/cache 约束  
2) **类型先行**：新增 endpoint 时先定义 response types，再写 request  
3) **失败要可诊断**：统一抛 `PolymarketError`（含 `ErrorCode`）  
4) **不要引入隐式 fallback**：SDK 的“数据源选择策略”必须显式（否则业务侧很难 debug）  
5) **不要提交本地凭证/脚本**：`.test-creds.json`、`scripts/test-*` 等只用于本地调试

## 本地验证（最小集合）

- Build：`pnpm -C packages/poly-sdk build`
- Test：`pnpm -C packages/poly-sdk test`
- Integration（如需）：`pnpm -C packages/poly-sdk test:integration`

## 目录提示

- `src/clients/`：纯 API client（请求/响应/分页/参数）
- `src/services/`：组合逻辑（可依赖多个 client）
- `src/core/`：错误、限流、缓存、基础 types
- `src/realtime/`：WebSocket 客户端实现（RealTimeDataClient）
- `scripts/`：本地测试脚本（不提交）

## WebSocket 测试

修改 RealtimeServiceV2 后必须验证 WebSocket 功能正常：

```bash
cd poly-sdk
PRIVATE_KEY=0x... npx tsx scripts/test-websocket-subscription.ts
```

**预期输出**:
```
✓ Market channel connected
✓ User channel connected
✓ USER_ORDER #1 received: { eventType: 'PLACEMENT', ... }
✓ USER_ORDER #2 received: { eventType: 'CANCELLATION', ... }
✓ WebSocket subscription is working!
```

**关键验证点**:
1. Market 和 User channel 都成功连接
2. 订阅发送后收到 USER_ORDER 事件
3. 测试脚本退出码为 0

## WebSocket 端点架构

Polymarket 使用三个独立的 WebSocket 端点：

| 端点 | URL | 用途 |
|------|-----|------|
| MARKET | `wss://ws-subscriptions-clob.polymarket.com/ws/market` | orderbook, trades, price changes |
| USER | `wss://ws-subscriptions-clob.polymarket.com/ws/user` | 用户订单/成交事件 (需认证) |
| LIVE_DATA | `wss://ws-live-data.polymarket.com` | 加密货币价格 |

**重要**: USER 事件必须连接 `/ws/user` 端点，不能在 `/ws/market` 上订阅！

