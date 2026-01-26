# OrderManager Test Suite

完整的 OrderManager 测试脚本集合，包含不同场景和余额要求的测试。

## 测试脚本概览

| 脚本 | 用途 | 余额要求 | 时长 |
|------|------|----------|------|
| **quick-test.ts** | 快速验证基本功能 | ~5 USDC.e | ~13秒 |
| **balanced-test.ts** | 低余额场景测试 | ~1.5 USDC.e | ~15秒 |
| **minimal-loop-test.ts** | 资金循环测试（创建→取消→恢复） | ~7 USDC.e | ~30秒 |
| **smart-cycle-test.ts** | 智能买卖循环（买入→卖出→恢复） | ~15 USDC.e | ~25秒 |
| **full-e2e.ts** | 完整端到端测试 | ~50 USDC.e | ~3分钟 |

---

## 测试哲学 - 为什么这样设计？

### 核心原则

1. **最小金额策略**
   - 使用 Polymarket 允许的最小订单（5 shares）
   - 价格设置尽量低（0.20-0.30），确保资金需求 <= 1.5 USDC
   - 原因：在资金有限的开发环境下也能完成全面测试

2. **资金循环思维**
   - 不是"消耗式测试"（下单→成交→资金锁定）
   - 而是"循环式测试"（创建→取消/卖出→资金恢复→重复）
   - 目标：用 20 USDC 完成 100 USDC 才能做的测试覆盖

3. **买卖双向验证**
   - 不只测试 BUY 操作
   - 也测试 SELL 操作（卖出持仓回收资金）
   - 原因：真实交易场景中买卖是完整闭环

4. **梯度测试策略**
   ```
   Quick Test (5 USDC)
       ↓ 核心功能正常
   Balanced Test (1.5 USDC)
       ↓ 参数验证正常
   Minimal Loop Test (7 USDC)
       ↓ 资金循环正常
   Smart Cycle Test (15 USDC)
       ↓ 买卖闭环正常
   Full E2E Test (50 USDC)
       ↓ 所有功能正常
   ```

### 测试思维演进

**初始方案**（消耗式）:
```typescript
// 问题：每次测试都消耗资金
createOrder({ price: 0.50, size: 100 }) // 需要 50 USDC
  → 立即成交 → 资金锁定 → 需要更多钱继续测试
```

**改进方案 1**（取消恢复）:
```typescript
// 改进：下单后立即取消，资金恢复
createOrder({ price: 0.30, size: 5 })  // 只需 1.5 USDC
  → 等待 3 秒 → cancelOrder()
  → 资金恢复 → 可以继续测试
```

**改进方案 2**（买卖循环）⭐ 当前最佳:
```typescript
// 最优：测试买入 + 卖出，资金基本恢复
// Cycle 1: Buy Up @ 0.40
createOrder({ side: 'BUY', price: 0.40, size: 10 })  // 消耗 4 USDC
  → 立即成交 → 获得 10 shares

// Cycle 2: Sell Up @ 0.45
createOrder({ side: 'SELL', price: 0.45, size: 10 }) // 回收 4.5 USDC
  → 立即成交 → 净收益 0.5 USDC（扣除费用后可能略亏）

// 结果：测试了 BUY + SELL，资金几乎全部恢复
```

### 为什么资金循环很重要？

在开发 OrderManager 这样的订单管理系统时：

1. **需要测试大量场景**：
   - 不同订单类型（GTC、GTD）
   - 不同状态转换（pending → open → filled → cancelled）
   - 不同异常情况（余额不足、价格精度错误、市场关闭）

2. **但资金有限**：
   - 测试钱包可能只有 20-50 USDC
   - 每次测试消耗 5-10 USDC
   - 如果不回收，只能测试 2-10 个场景

3. **资金循环的优势**：
   - 20 USDC 可以测试 50+ 个场景
   - 无需频繁充值
   - 测试成本降低 10 倍以上

---

## 脚本说明

### 1. quick-test.ts - 快速测试

**目的**: 验证 OrderManager 核心功能是否正常工作

**测试内容**:
- ✅ 创建订单
- ✅ 自动监听（auto-watch）
- ✅ 状态变更检测
- ✅ Fill 事件
- ✅ 订单取消

**使用场景**:
- 开发时快速验证代码改动
- CI/CD 流水线中的基础验证

**运行命令**:
```bash
PRIVATE_KEY=0x... npx tsx scripts/ordermanager/quick-test.ts
```

**预期结果**:
```
✅ Test PASSED
Events received: 3 (order_created, status_change, order_filled)
```

---

### 2. balanced-test.ts - 余额平衡测试 ⭐ 推荐

**目的**: 在有限余额下测试核心功能

**测试内容**:
- ✅ 参数验证（最小值、精度）
- ✅ 低余额下创建订单
- ✅ 订单开启和取消
- ✅ 事件完整性

**余额要求**:
- 最低: 1.5 USDC.e
- 推荐: 2.0 USDC.e

**优势**:
- ✅ 适合钱包余额有限的开发环境
- ✅ 覆盖核心功能验证
- ✅ 无需大量资金即可完成测试

**运行命令**:
```bash
PRIVATE_KEY=0x... npx tsx scripts/ordermanager/balanced-test.ts
```

**预期结果**:
```
Total: 4, Passed: 4, Failed: 0
Event types: order_created (2), status_change (2), order_opened (2)
```

---

### 3. minimal-loop-test.ts - 资金循环测试

**目的**: 验证资金循环策略的可行性

**测试内容**:
- ✅ 创建订单 → 取消 → 资金恢复（循环 6 次）
- ✅ 不同价格点测试（0.20、0.25、0.22）
- ✅ 立即取消（测试极端情况）
- ✅ 批量订单创建和取消
- ✅ 连续订单测试（3 轮循环）
- ✅ Watch/Unwatch 功能验证

**资金策略**:
```typescript
// 每次测试只需 1-1.5 USDC
createOrder({ price: 0.20, size: 5 })  // 1.0 USDC
await delay(3000)
cancelOrder(orderId)                    // 恢复 1.0 USDC
// 净成本: ~0 USDC (只有 gas 费)
```

**运行命令**:
```bash
PRIVATE_KEY=0x... npx tsx scripts/ordermanager/minimal-loop-test.ts
```

**预期结果**:
```
Total Tests: 6, Passed: 6, Failed: 0
Capital Used: 7.55 USDC
Capital Recovered: 7.55 USDC
Recovery Rate: 100.0%
```

---

### 4. smart-cycle-test.ts - 智能买卖循环 ⭐ 推荐

**目的**: 测试完整的买卖闭环，验证 BUY 和 SELL 双向操作

**测试内容**:
- ✅ 买入 Up token → 卖出 Up token（资金循环）
- ✅ 买入 Down token → 卖出 Down token（资金循环）
- ✅ 多轮循环测试
- ✅ 取消路径测试（未成交订单的处理）
- ✅ 批量订单测试

**智能策略**:
```typescript
async function buyCycle() {
  // 1. 买入（低价，确保成交）
  const buyResult = await orderMgr.createOrder({
    side: 'BUY',
    price: 0.40,  // 低于市场价 0.455
    size: 10
  });

  // 2. 等待成交
  await delay(3000);

  // 3. 卖出（高价，快速卖出）
  const sellResult = await orderMgr.createOrder({
    side: 'SELL',
    price: 0.45,  // 略高于买入价
    size: filledSize
  });

  // 4. 资金恢复：0.40 * 10 = 4.0 → 0.45 * 10 = 4.5
  // 净收益: 0.5 USDC (扣除费用后可能持平或略亏)
}
```

**优势**:
- ✅ 同时测试 BUY 和 SELL 功能
- ✅ 资金几乎完全恢复（90-100%）
- ✅ 模拟真实交易场景
- ✅ 验证订单成交和状态转换

**运行命令**:
```bash
PRIVATE_KEY=0x... npx tsx scripts/ordermanager/smart-cycle-test.ts
```

**预期结果**:
```
Total Cycles: 5
Success: 2, Partial: 3, Failed: 0
Capital Used: 12.00 USDC
Capital Recovered: 11.50 USDC
Recovery Rate: 95.8%
```

---

### 5. full-e2e.ts - 完整端到端测试

**目的**: 全面测试 OrderManager 的所有功能

**测试内容**:
- ✅ GTC 订单（创建、监听、取消）
- ✅ GTD 订单（过期测试，需等待 70 秒）
- ✅ 部分成交检测
- ✅ 立即取消
- ✅ 批量订单
- ✅ 外部订单监听
- ✅ 参数验证（完整）

**余额要求**:
- 最低: 50 USDC.e
- 推荐: 100 USDC.e（用于大额订单测试）

**运行命令**:
```bash
PRIVATE_KEY=0x... npx tsx scripts/ordermanager/full-e2e.ts
```

**预期结果**:
```
Total: 8, Passed: 8, Failed: 0
Events: order_created, order_opened, order_filled, order_cancelled, order_expired...
```

---

## 测试环境配置

### 必需环境变量

```bash
export PRIVATE_KEY=0x...  # 测试钱包私钥
```

### 可选环境变量

```bash
export MARKET_CONDITION_ID=0x...  # 指定测试市场（默认: BTC 15分钟市场）
export TOKEN_ID=...               # 指定 token ID（默认: Up token）
export PRICE=0.40                 # 订单价格（默认: 0.40）
export SIZE=10                    # 订单数量（默认: 10）
```

---

## 当前测试市场

**市场**: Bitcoin Up or Down - 15分钟市场

| 参数 | 值 |
|------|-----|
| **Condition ID** | `0x734720ff62e94d4d3aca7779c0c524942552f413598471e27641fa5768c9b9bd` |
| **Up Token ID** | `33095274756912603140497919858406898509281326656669704017026263839116792685912` |
| **Down Token ID** | `96784320014242754088182679292920116900310434804732581110626077800568579041234` |
| **当前价格** | Up: 0.485¢, Down: 0.515¢ |
| **流动性** | 20,049 USDC |
| **结算时间** | 15分钟后 |

**选择原因**:
- ✅ 高流动性（快速成交）
- ✅ 短周期（快速结算，适合测试）
- ✅ 稳定的价格波动

---

## 测试策略

### 开发阶段测试流程（推荐顺序）

```
阶段 1: 快速验证（13秒）
└── quick-test.ts
    ├── 验证核心功能可用
    └── 如果失败 → 修复代码 → 重新测试

阶段 2: 参数验证（15秒）
└── balanced-test.ts
    ├── 验证边界条件
    ├── 验证错误处理
    └── 如果失败 → 修复验证逻辑

阶段 3: 资金循环验证（30秒）
└── minimal-loop-test.ts
    ├── 验证资金可以循环使用
    ├── 验证取消订单流程
    └── 确保 100% 资金恢复率

阶段 4: 买卖闭环验证（25秒）⭐ 关键
└── smart-cycle-test.ts
    ├── 验证 BUY + SELL 双向操作
    ├── 验证成交和状态转换
    └── 确保 95%+ 资金恢复率

阶段 5: 完整端到端（3分钟）
└── full-e2e.ts
    ├── 完整功能覆盖
    ├── GTD 过期测试
    └── 外部订单监听
```

### 实际开发中的使用场景

**场景 1: 日常开发**
```bash
# 修改了 OrderManager 代码
pnpm build
PRIVATE_KEY=0x... npx tsx scripts/ordermanager/quick-test.ts
# 13秒快速验证 → 通过 → 继续开发
```

**场景 2: 添加新功能**
```bash
# 添加了新的验证逻辑
pnpm build
PRIVATE_KEY=0x... npx tsx scripts/ordermanager/balanced-test.ts
# 验证边界条件 → 通过 → 提交代码
```

**场景 3: 准备发布**
```bash
# 运行完整测试套件
pnpm build
PRIVATE_KEY=0x... npx tsx scripts/ordermanager/minimal-loop-test.ts
PRIVATE_KEY=0x... npx tsx scripts/ordermanager/smart-cycle-test.ts
# 资金循环 + 买卖闭环都通过 → 可以发布
```

**场景 4: 重大变更**
```bash
# 修改了核心状态机逻辑
pnpm build
PRIVATE_KEY=0x... npx tsx scripts/ordermanager/full-e2e.ts
# 完整端到端测试 → 确保没有回归
```

### CI/CD 集成建议

**最小配置**（适合 PR 检查）:
```yaml
- name: Quick OrderManager Test
  run: |
    export PRIVATE_KEY=${{ secrets.TEST_WALLET_PRIVATE_KEY }}
    pnpm build
    npx tsx scripts/ordermanager/quick-test.ts
```

**标准配置**（适合 merge 到 main）:
```yaml
- name: OrderManager Test Suite
  run: |
    export PRIVATE_KEY=${{ secrets.TEST_WALLET_PRIVATE_KEY }}
    pnpm build
    npx tsx scripts/ordermanager/balanced-test.ts
    npx tsx scripts/ordermanager/minimal-loop-test.ts
```

**完整配置**（适合 release）:
```yaml
- name: Full OrderManager E2E
  run: |
    export PRIVATE_KEY=${{ secrets.TEST_WALLET_PRIVATE_KEY }}
    pnpm build
    npx tsx scripts/ordermanager/quick-test.ts
    npx tsx scripts/ordermanager/balanced-test.ts
    npx tsx scripts/ordermanager/minimal-loop-test.ts
    npx tsx scripts/ordermanager/smart-cycle-test.ts
    npx tsx scripts/ordermanager/full-e2e.ts
```

---

## 余额管理

### 检查钱包余额

```bash
# 使用 Polymarket MCP
mcp__polymarket__get_wallet_balances --address 0x...

# 或使用脚本
npx tsx scripts/check-balance.ts
```

### 充值指南

如需运行完整测试，建议充值方式：

1. **从 Polygon 主网桥接 USDC.e**
   - 使用 Polygon Bridge: https://wallet.polygon.technology/bridge
   - 从以太坊主网桥接 USDC → Polygon USDC.e

2. **直接在 Polygon 上购买**
   - 使用交易所（Binance、OKX）提现到 Polygon
   - 确保选择 USDC.e 代币

---

## 故障排查

### 常见错误

**1. "not enough balance / allowance"**
```
原因: 钱包 USDC.e 余额不足或未授权
解决:
- 检查余额: mcp__polymarket__get_wallet_balances
- 使用 balanced-test.ts（余额要求更低）
```

**2. "Order not auto-watched"**
```
原因: 订单立即成交并自动 unwatch
解决: 使用更低的价格（远离市场价）
```

**3. "Invalid status transition: pending → filled"**
```
原因: 订单立即成交（正常行为）
解决: 已修复状态转换验证逻辑
```

**4. "Price must be multiple of 0.01 tick size"**
```
原因: 价格精度问题
解决: 已修复浮点数验证逻辑
```

---

## 测试报告

完整测试报告请查看: [test-report.md](./test-report.md)

报告包含:
- ✅ 测试环境详情
- ✅ 执行步骤和结果
- ✅ 遇到的问题和解决方案
- ✅ 性能观察
- ✅ 代码改动总结

---

## 贡献指南

### 添加新测试场景

1. 在对应的测试文件中添加新的 `runTest()` 调用
2. 确保测试独立且可重复
3. 添加清晰的日志输出
4. 更新本 README 说明

### 测试命名规范

```typescript
await runTest('功能描述 - 具体场景', async () => {
  // 测试逻辑
});
```

**示例**:
- ✅ "Create GTC order with low balance"
- ✅ "Validation: Below minimum size"
- ❌ "Test 1" （不够描述性）

---

*Last Updated: 2026-01-15*
