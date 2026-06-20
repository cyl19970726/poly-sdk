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

## Logger injection contract（2026-05-08, Fix-B/C/D/E/F/G）

> 任何 owns watchdog/timer 输出诊断 log 的 class —— 永远不允许「optional logger + 默认 no-op」。
> 不变量：(1) 默认 logger 必须 fail-loud（console-backed，**非** silent no-op），
> (2) 接受 `logger?` 的 ctor 必须把它 propagate 到所有 own 一个 watchdog 的 child。

### 历史教训
2026-03 至 2026-05 间，`market-data` worker 实例化 `RealtimeServiceV2({ debug })` 但**没注入** `logger`。
`RealtimeServiceV2.scheduleSubAckTimeoutCheck()` 60s watchdog 触发的 `CRITICAL: WS sub appears to have NO ACK`
log 进了 `_logger`（poly-sdk 默认是 silent no-op）—— 这条 log **从未出现**在 PM2 logs 中，
30% 的 crypto 5m markets 静默丢数据持续了 ~60 天。详见 `task-fix-market-data-ws-subscribe`。

### 不变量列表

1. **默认 logger 必须 console-backed（Fix-F）**。`src/core/logger.ts:_logger` 默认指向
   `defaultConsoleLogger`，**不是** no-op。`{debug,info,warn,error}` 路由到对应
   `console.*`，前缀 `[poly-sdk]`。这样未来即使有人忘记调 `setLogger()` 或漏传
   `logger:`，诊断 log 至少进了 stdout/stderr，不会全黑。
2. **任何 service ctor 接受 `logger?: ILogger` 都必须**：
   - 存到 `this.config.logger`
   - 在每条 `log.warn / log.error` 处优先用 `this.config.logger ?? log`
   - 如果有 child class own watchdog，也要把 logger 透传下去（Fix-E 经验）
3. **TradingService / RealtimeServiceV2 等核心 service** 必须接受 `logger?`（已实现）。
4. **CI gate**：`scripts/ci/check-logger-inject.sh diff` 在 PR diff 中扫
   `new RealtimeServiceV2(...)` / `new TradingService(...)` —— 任何新增点漏 `logger:` 直接 fail。

### 给新 service 作者的 checklist

- [ ] config interface 加 `logger?: Logger`
- [ ] constructor 存到 `this.config.logger`
- [ ] 所有 `log.warn / log.error` 用 `this.config.logger ?? log`
- [ ] 如果 ctor 内部 `new Other(...)` 有 watchdog，把 logger 透传
- [ ] 写一个 unit test：mock logger, assert watchdog 触发时 logger 收到 message
- [ ] CI: `scripts/ci/check-logger-inject.sh diff` 在 PR 中绿

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

