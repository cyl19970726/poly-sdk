# RealTimeDataClient Test Scripts

测试自定义 `RealTimeDataClient` 实现的脚本。

## WebSocket 协议参考

基于 Polymarket 官方文档：
- [WSS Overview](https://docs.polymarket.com/developers/CLOB/websocket/wss-overview)
- [Market Channel](https://docs.polymarket.com/developers/CLOB/websocket/market-channel)
- [User Channel](https://docs.polymarket.com/developers/CLOB/websocket/user-channel)

### Market Channel

**Endpoint**: `wss://ws-subscriptions-clob.polymarket.com/ws/market`

**Initial Subscription Format**:
```json
{
  "type": "MARKET",
  "assets_ids": ["token_id_1", "token_id_2"]
}
```

**Dynamic Subscription** (after initial connection):
```json
{
  "operation": "subscribe",
  "assets_ids": ["token_id_3"]
}
```

**Event Types**:
| Event | Description | Trigger |
|-------|-------------|---------|
| `book` | Orderbook snapshot | On subscribe, or when trades affect orderbook |
| `price_change` | Price level change | New order placed or cancelled |
| `last_trade_price` | Trade execution | Maker and taker orders matched |
| `tick_size_change` | Tick size changed | Price > 0.96 or < 0.04 |
| `best_bid_ask` | Best prices changed | Feature-flagged |

### User Channel

**Endpoint**: `wss://ws-subscriptions-clob.polymarket.com/ws/user`

**Subscription Format** (requires authentication):
```json
{
  "type": "USER",
  "auth": {
    "apiKey": "...",
    "secret": "...",
    "passphrase": "..."
  },
  "markets": ["condition_id_1"]
}
```

**Event Types**:
| Event | Description |
|-------|-------------|
| `trade` | Trade status: MATCHED, MINED, CONFIRMED, RETRYING, FAILED |
| `order` | Order event: PLACEMENT, UPDATE, CANCELLATION |

## 测试设计原则

### 1. 使用活跃的 15 分钟市场

15 分钟加密市场是测试 WebSocket 的最佳选择，因为：
- 交易活跃（价格频繁变动）
- 市场数据更新快
- 可以在短时间内验证所有事件类型

使用 MarketService 扫描活跃市场：

```typescript
import {
  MarketService,
  GammaApiClient,
  RateLimiter,
  createUnifiedCache
} from '@catalyst-team/poly-sdk';

// Create dependencies (order matters: RateLimiter and cache first)
const rateLimiter = new RateLimiter();
const cache = createUnifiedCache();
const gammaApi = new GammaApiClient(rateLimiter, cache);

// Create MarketService with GammaApiClient
const service = new MarketService(gammaApi, undefined, rateLimiter, cache);
const markets = await service.scanCryptoShortTermMarkets({
  duration: '15m',
  minMinutesUntilEnd: 5,
  maxMinutesUntilEnd: 15,
  coin: 'BTC',
});
```

### 2. 测试覆盖矩阵

| 测试场景 | 脚本 | 验证点 |
|---------|------|--------|
| 连接稳定性 | `test-raw-websocket.ts` | 连接建立、ping/pong、断开 |
| Market 订阅 | `test-realtime-quick.ts` | book/price_change 事件 |
| 数据正确性 | `test-15m-data-consistency.ts` | 价格区间、排序、时间戳 |
| User 订阅 | TODO | order/trade 事件 |

### 3. 事件验证规则

**book (orderbook snapshot)**:
- `bids` 按价格降序排列
- `asks` 按价格升序排列
- `timestamp` 为毫秒级（> 1e12）
- `hash` 存在且非空

**price_change**:
- `price` 在 0.001-0.999 之间
- `side` 为 "BUY" 或 "SELL"
- `best_bid` < `best_ask`

**last_trade_price**:
- `size` > 0
- `fee_rate_bps` 存在

## Scripts

### test-raw-websocket.ts

最小化 WebSocket 测试，使用正确的订阅格式：

```bash
npx tsx scripts/real-time-service/test-raw-websocket.ts
```

验证：
- 连接到正确的 endpoint
- 发送正确的订阅格式
- 收到 book 和 price_change 事件

### test-realtime-quick.ts

使用 RealtimeServiceV2 的快速测试：

```bash
npx tsx scripts/real-time-service/test-realtime-quick.ts
```

验证：
- RealtimeServiceV2 正确订阅和处理事件
- 事件回调被正确触发
- 30 秒内收到数据

### test-realtime-15m.ts

完整的 15 分钟市场测试：

```bash
# 默认测试 (1 分钟)
npx tsx scripts/real-time-service/test-realtime-15m.ts

# 扩展测试 (5 分钟)
npx tsx scripts/real-time-service/test-realtime-15m.ts --duration 300

# Debug 模式
npx tsx scripts/real-time-service/test-realtime-15m.ts --debug
```

### test-client-ping-pong.ts

测试 ping/pong 机制：

```bash
npx tsx scripts/real-time-service/test-client-ping-pong.ts
```

验证：
- ping 每 30 秒发送一次
- pong 在 10 秒内响应
- 连接保持稳定

## Expected Results

### 成功的测试输出

```
[RealTimeDataClient] Connecting to wss://ws-subscriptions-clob.polymarket.com/ws/market
[RealTimeDataClient] WebSocket connected
[RealTimeDataClient] Sent: {"type":"MARKET","assets_ids":["..."]}
[RealTimeDataClient] Raw message: [{"market":"0x...","asset_id":"...","bids":[...],"asks":[...]}]
[RealtimeService] Received: clob_market:book
[RealtimeService] Received: clob_market:price_change
```

### Troubleshooting

| 问题 | 可能原因 | 解决方案 |
|-----|---------|---------|
| 无数据 | 市场已过期 | 扫描新的活跃市场 |
| 连接失败 | 网络问题 | 检查防火墙/代理 |
| 订阅无响应 | 格式错误 | 检查是否使用正确的格式 |

## 测试依据 (Test Rationale)

### 为什么选择 15 分钟市场

| 因素 | 15 分钟市场 | 普通市场 |
|-----|-----------|---------|
| 交易频率 | 高（每分钟多次） | 低（可能几小时无交易）|
| 价格变动 | 频繁（随加密货币价格波动） | 稀少 |
| 事件覆盖 | 30 秒内可验证所有事件类型 | 可能需要数小时 |
| Token 有效期 | 15 分钟 | 数天/数月 |

### 如何测试所有事件类型

#### Market Channel 事件

| 事件 | 触发条件 | 测试方法 |
|-----|---------|---------|
| `book` | 订阅时立即返回 | 订阅任意市场即可收到 |
| `price_change` | 新订单或取消订单 | 等待市场活动（15m 市场每秒都有） |
| `last_trade_price` | 成交发生 | 需要等待真实成交（活跃市场约 1-5 分钟） |
| `tick_size_change` | 价格 > 0.96 或 < 0.04 | 罕见，通常在市场即将结束时 |
| `best_bid_ask` | 最优价格变化 | Feature-flagged，需要启用 |

#### User Channel 事件

| 事件 | 触发条件 | 测试方法 |
|-----|---------|---------|
| `order` | 下单/更新/取消 | 需要真实下单操作 |
| `trade` | 订单成交 | 需要真实成交 |

### 测试流程

```
1. 扫描活跃市场
   └── MarketService.scanCryptoShortTermMarkets()
        └── 选择距离结束 5-15 分钟的 BTC 市场

2. 订阅市场
   └── 发送: { type: "MARKET", assets_ids: [up_token, down_token] }
        └── 立即收到: book 事件 x2

3. 等待价格变动
   └── 收到: price_change 事件
        └── 验证: price, size, side, best_bid, best_ask

4. 等待成交
   └── 收到: last_trade_price 事件
        └── 验证: price, size, side, fee_rate_bps

5. 验证数据正确性
   └── book.bids 降序、book.asks 升序
   └── 价格在 0-1 范围内
   └── Up + Down 价格和 ≈ 1.0
```

### 完整覆盖测试（推荐）

运行以下脚本按顺序测试所有功能：

```bash
# 1. 基础连接测试（验证 endpoint 和订阅格式）
npx tsx scripts/real-time-service/test-raw-websocket.ts

# 2. RealtimeServiceV2 集成测试（验证事件处理）
npx tsx scripts/real-time-service/test-realtime-quick.ts

# 3. 数据正确性测试（验证数据质量）
npx tsx scripts/real-time-service/test-15m-data-consistency.ts

# 4. 长时间稳定性测试（验证 ping/pong）
npx tsx scripts/real-time-service/test-client-ping-pong.ts --duration 180
```

### 自动化测试（CI/CD）

集成测试位于 `src/__tests__/integration/realtime-service-v2.integration.test.ts`：

```bash
pnpm test:integration --testPathPattern "realtime-service-v2"
```

## 注意事项

1. **Token 过期**：15 分钟市场的 token ID 每 15 分钟轮换一次，测试前需要扫描新市场
2. **时区**：市场时间使用 ET (美国东部时间)
3. **节假日**：交易量可能较低，影响测试
4. **事件频率**：`last_trade_price` 事件可能需要等待几分钟才能收到，因为需要真实成交
