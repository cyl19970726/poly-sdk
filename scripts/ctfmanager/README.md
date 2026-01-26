# CTFManager Test Suite

完整的 CTFManager 测试脚本集合，基于链上事件监听验证 CTF 操作。

## 测试脚本概览

| 脚本 | 用途 | 余额要求 | 时长 |
|------|------|----------|------|
| **quick-test.ts** | 快速验证 Split → Merge | ~2 USDC.e + Gas | ~20秒 |
| **cycle-test.ts** | 多次循环测试 | ~5 USDC.e + Gas | ~60秒 |
| **full-e2e.ts** | 完整测试（含 Redeem） | ~10 USDC.e + Gas | ~3分钟 |

---

## 测试哲学 - CTF 资金循环

### 核心原则

1. **Split → Merge 循环**
   ```
   USDC.e (1.0) → Split → YES (1.0) + NO (1.0)
                         ↓
                      Merge
                         ↓
                   USDC.e (1.0)
   ```
   - 理论上资金完全恢复（只消耗 Gas 费）
   - 1 USDC.e 可以测试无限次 Split/Merge

2. **最小金额策略**
   - 每次测试使用 1-2 USDC.e
   - Gas 费约 0.01-0.05 USDC（Polygon 很便宜）
   - 总成本：~0.1 USDC / 次测试

3. **事件驱动验证**
   - 基于链上 ERC1155 Transfer 事件
   - 实时检测（延迟 < 1 秒）
   - 不依赖轮询余额

4. **梯度测试策略**
   ```
   Quick Test (2 USDC.e)
       ↓ Split + Merge 正常
   Cycle Test (5 USDC.e)
       ↓ 多次循环正常
   Full E2E Test (10 USDC.e)
       ↓ 包括 Redeem 正常
   ```

### 为什么 CTF 测试比 OrderManager 更省钱？

**OrderManager 测试**：
- 需要订单成交：BUY 消耗 USDC，SELL 回收（可能有滑点损失）
- 市场价格波动：可能损失 1-5%
- 手续费：0.02% maker fee

**CTFManager 测试**：
- Split/Merge 是 1:1 等价交换（无滑点）
- 只消耗 Gas 费（~0.01 USDC）
- 资金几乎完全恢复

**对比**：
| 操作 | OrderManager | CTFManager |
|------|-------------|------------|
| 单次测试成本 | 0.05-0.50 USDC | 0.01-0.05 USDC |
| 资金回收率 | 95-99% | 99.9% |
| 10 次测试成本 | 0.5-5 USDC | 0.1-0.5 USDC |

---

## 快速开始

### 1. 准备钱包

确保钱包有：
- ✅ **USDC.e**（bridged USDC）：至少 5 USDC.e
- ✅ **MATIC**：至少 0.5 MATIC（用于 Gas）
- ❌ ~~Native USDC~~（不支持！）

**检查 USDC 类型**：
```bash
# 查看钱包余额
PRIVATE_KEY=0x... npx tsx scripts/check-balances.ts

# 如果只有 Native USDC，需要转换：
# 方法 1: 使用 QuickSwap 转换
# 方法 2: 通过 Polygon Bridge 桥接
```

### 2. 选择市场

选择一个活跃的 Polymarket 市场：

**推荐：15 分钟加密货币市场**（高流动性，快速结算）
```bash
# BTC Up/Down 15分钟市场
MARKET_CONDITION_ID=0x4e605132e536d51c37a28cdc0ac77e48c77d8e2251743d4eae3309165dee7d34
PRIMARY_TOKEN_ID=114556380551836029874371622136300870993278600643770464506059877822810208153399  # Up
SECONDARY_TOKEN_ID=24084804653914500740208824435348684831132621527155423823545713790843845444174  # Down
```

**替代方案：长期政治市场**（测试 Redeem 功能）
```bash
# 2024 US Presidential Election
MARKET_CONDITION_ID=0x...  # 从 Polymarket API 获取
```

### 3. 运行测试

**Quick Test**（推荐首次测试）：
```bash
PRIVATE_KEY=0x... \
MARKET_CONDITION_ID=0x4e60... \
PRIMARY_TOKEN_ID=11455... \
SECONDARY_TOKEN_ID=24084... \
npx tsx scripts/ctfmanager/quick-test.ts
```

**Cycle Test**（验证稳定性）：
```bash
PRIVATE_KEY=0x... \
CYCLES=5 \
npx tsx scripts/ctfmanager/cycle-test.ts
```

**Full E2E Test**（完整功能）：
```bash
PRIVATE_KEY=0x... \
npx tsx scripts/ctfmanager/full-e2e.ts
```

---

## 测试场景说明

### Quick Test - 基础验证

**流程**：
```
1. 初始化 CTFManager
2. Split 1 USDC.e → YES + NO tokens
3. 等待事件（split_detected）
4. 验证余额增加
5. Merge YES + NO → USDC.e
6. 等待事件（merge_detected）
7. 验证余额恢复
```

**预期结果**：
- ✅ `split_detected` 事件触发
- ✅ `merge_detected` 事件触发
- ✅ 余额恢复（损失 < 0.1 USDC Gas 费）
- ✅ 总时长 < 20 秒

### Cycle Test - 循环测试

**流程**：
```
循环 N 次：
  1. Split 1 USDC.e
  2. 验证事件
  3. Merge tokens
  4. 验证事件
  5. 等待 5 秒
```

**目的**：
- 验证多次操作的稳定性
- 检测内存泄漏
- 测试事件去重

### Full E2E Test - 完整场景

**流程**：
```
1. Split 操作测试
2. Merge 操作测试
3. 等待市场结算（15 分钟市场）
4. Redeem 操作测试
5. 验证所有事件
```

**注意**：
- Redeem 需要等待市场结算
- 15 分钟加密货币市场：每 15 分钟结算一次
- 长期市场：可能需要等待数天/数周

---

## 资金管理最佳实践

### 测试前检查

```bash
# 1. 检查 USDC.e 余额
cast balance $YOUR_ADDRESS --rpc-url https://polygon-rpc.com --erc20 0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174

# 2. 检查 MATIC 余额
cast balance $YOUR_ADDRESS --rpc-url https://polygon-rpc.com

# 3. 检查 CTF token 余额
cast balance $YOUR_ADDRESS --rpc-url https://polygon-rpc.com --erc20 0x4D97DCd97eC945f40cF65F87097ACe5EA0476045
```

### 资金恢复策略

如果余额被锁定在 tokens 中：

**场景 1：持有配对的 YES + NO tokens**
```bash
# 直接 Merge 恢复
npx tsx scripts/ctfmanager/recover-merge.ts
```

**场景 2：只持有单边 token（YES 或 NO）**
```bash
# 方法 1: 在 Polymarket 上出售
# 方法 2: 等待市场结算后 Redeem（如果是赢的一方）
```

**场景 3：市场已结算**
```bash
# Redeem 获得 USDC.e
npx tsx scripts/ctfmanager/recover-redeem.ts
```

### Gas 费预算

| 操作 | Gas Used | Cost (MATIC) | Cost (USDC) |
|------|----------|--------------|-------------|
| Split | ~150,000 | 0.015 MATIC | ~$0.01 |
| Merge | ~150,000 | 0.015 MATIC | ~$0.01 |
| Redeem | ~100,000 | 0.010 MATIC | ~$0.008 |

**预算建议**：
- 单次测试：0.5 MATIC + 2 USDC.e
- 10 次测试：1 MATIC + 5 USDC.e
- 持续测试：5 MATIC + 10 USDC.e

---

## 常见问题

### Q1: 为什么 Split 失败 "Insufficient USDC balance"？

**原因**：
- 你的钱包有 Native USDC，但 CTF 只接受 USDC.e

**解决方案**：
```bash
# 检查 USDC 类型
npx tsx scripts/check-usdc-type.ts

# 转换 Native USDC → USDC.e
npx tsx scripts/swap-to-usdc-e.ts
```

### Q2: 为什么事件没有触发？

**可能原因**：
1. RPC 节点不支持 WebSocket
2. 网络延迟
3. 交易 revert

**调试步骤**：
```bash
# 1. 检查交易状态
cast receipt $TX_HASH --rpc-url https://polygon-rpc.com

# 2. 启用 debug 模式
DEBUG=true npx tsx scripts/ctfmanager/quick-test.ts

# 3. 使用备用 RPC
RPC_URL=https://polygon-mainnet.g.alchemy.com/v2/your-key \
  npx tsx scripts/ctfmanager/quick-test.ts
```

### Q3: Merge 失败 "Insufficient token balance"？

**原因**：
- 没有配对的 YES + NO tokens
- Token ID 不匹配

**解决方案**：
```bash
# 检查 token 余额
npx tsx scripts/check-ctf-balance.ts

# 如果只有单边 token，需要 Split 补足另一边
```

### Q4: 如何测试 Redeem？

**方法 1：使用 15 分钟市场**
- 优点：快速结算（15 分钟）
- 缺点：需要等待下一个结算时间点

**方法 2：使用测试网**
- 优点：可以快速触发结算
- 缺点：需要部署测试合约

**方法 3：使用已结算的市场**
- 优点：立即可测试
- 缺点：需要先持有该市场的 tokens

---

## 测试报告模板

每次测试后生成报告：

```markdown
## CTFManager Test Report - [Date]

### Environment
- Network: Polygon Mainnet
- Wallet: 0x...
- Market: [Market Name]
- Condition ID: 0x...

### Test Results

#### Quick Test
- Status: ✅ PASSED / ❌ FAILED
- Duration: 18.5 seconds
- Events: 2 split_detected, 2 merge_detected
- Gas Cost: 0.032 MATIC (~$0.02)
- USDC Recovery: 99.8% (1.998 USDC recovered from 2.0 USDC)

#### Cycle Test
- Status: ✅ PASSED
- Cycles Completed: 5/5
- Total Duration: 62 seconds
- Total Gas: 0.15 MATIC
- Average Recovery Rate: 99.7%

#### Full E2E Test
- Status: ⏳ PENDING (waiting for market settlement)
- Split/Merge: ✅ PASSED
- Redeem: ⏳ Waiting for settlement at 12:30 PM ET

### Issues Found
- None

### Recommendations
- All tests passed successfully
- CTFManager ready for production use
```

---

## 下一步

1. **运行 Quick Test** 验证基础功能
2. **运行 Cycle Test** 验证稳定性
3. **集成到策略引擎** 在 earning-engine 中使用
4. **监控生产环境** 部署到 GCP 服务器

Happy Testing! 🎉
