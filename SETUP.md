# 🔧 安装和设置指南

## 📦 安装依赖

```bash
cd /home/user/poly-sdk

# 安装依赖
npm install

# 或使用 pnpm（更快）
pnpm install
```

## 🏗️ 构建项目

```bash
# 构建 TypeScript
npm run build

# 或开发模式（监听文件变化）
npm run dev
```

## ⚙️ 配置环境

### Paper Trading（推荐先测试）

```bash
# 复制 paper trading 配置
cp .env.paper .env

# 直接运行（不需要私钥）
npx tsx scripts/endgame/v4-safe.ts
```

### Live Trading（真实交易）

```bash
# 复制 live trading 配置
cp .env.live .env

# 编辑配置文件，填入你的私钥
nano .env
# 或
vim .env

# 确认配置正确
cat .env | grep -v "^#" | grep -v "^$"

# 启动实盘交易（会有 10 秒确认期）
npx tsx scripts/endgame/v4-safe.ts
```

## 🧪 测试安全机制

### 1. 测试 Kill Switch

```bash
# 终端 1: 启动 paper trading
TRADING_MODE=paper npx tsx scripts/endgame/v4-safe.ts

# 终端 2: 触发 kill switch
touch /tmp/poly-kill-switch-paper

# 观察终端 1: 应该立即停止交易
```

### 2. 测试 Fund Limiter

```bash
# 设置小额限制来快速测试
export MAX_DAILY_VOLUME=20
export MAX_SINGLE_TRADE=5

npx tsx scripts/endgame/v4-safe.ts

# 观察: 达到限制后应该停止交易
```

### 3. 测试 Loss Breaker

```bash
# 设置小额亏损限制
export MAX_DAILY_LOSS=10
export MAX_CONSECUTIVE_LOSSES=2

npx tsx scripts/endgame/v4-safe.ts

# 观察: 连续亏损 2 次后应该熔断
```

## 📊 监控运行状态

### 实时监控脚本

```bash
# 创建监控脚本
cat > monitor.sh << 'EOF'
#!/bin/bash
while true; do
  clear
  echo "═══════════════════════════════════════"
  echo "🛡️  Trading Monitor"
  echo "═══════════════════════════════════════"

  # Kill Switch
  if [ -f /tmp/poly-kill-switch-* ]; then
    echo "⛔ Kill Switch: ACTIVE"
    ls -lh /tmp/poly-kill-switch-*
  else
    echo "✅ Kill Switch: OK"
  fi

  # Fund Limiter
  if [ -f /tmp/poly-fund-limiter.json ]; then
    echo ""
    echo "💰 Fund Limiter:"
    cat /tmp/poly-fund-limiter.json | jq '.' 2>/dev/null || cat /tmp/poly-fund-limiter.json
  fi

  # Loss Breaker
  if [ -f /tmp/poly-loss-breaker.json ]; then
    echo ""
    echo "🔥 Loss Breaker:"
    cat /tmp/poly-loss-breaker.json | jq '.' 2>/dev/null || cat /tmp/poly-loss-breaker.json
  fi

  echo ""
  echo "═══════════════════════════════════════"
  echo "Press Ctrl+C to exit"
  sleep 5
done
EOF

chmod +x monitor.sh
./monitor.sh
```

### 查看日志

```bash
# 查看最新的日志文件
ls -lt logs/ | head

# 实时跟踪日志
tail -f logs/v4-paper-*.csv

# 或使用 watch 命令
watch -n 2 "tail -20 logs/v4-paper-*.csv"
```

## 🚨 紧急操作

### 立即停止交易

```bash
# 方法 1: Kill Switch（推荐）
touch /tmp/poly-kill-switch-live

# 方法 2: Ctrl+C（如果终端可访问）
# 在运行终端按 Ctrl+C

# 方法 3: 杀死进程
pkill -f "v4-safe.ts"
```

### 重置所有保护机制

```bash
# 删除所有状态文件
rm /tmp/poly-kill-switch*
rm /tmp/poly-fund-limiter.json
rm /tmp/poly-loss-breaker.json

# 验证清理完成
ls -lh /tmp/poly-* 2>/dev/null || echo "All cleared"
```

## 🔍 故障排查

### 问题: 无法启动脚本

**检查清单**:
```bash
# 1. 依赖是否安装
npm list 2>&1 | grep UNMET

# 2. 构建是否完成
ls -lh dist/

# 3. 环境变量是否正确
cat .env | grep -v "^#"

# 4. Kill Switch 是否触发
ls -lh /tmp/poly-kill-switch* 2>/dev/null
```

### 问题: 一直不进场

**可能原因**:
- 市场价格不在目标区间
- 距离结束时间不符合策略要求
- Fund Limiter 达到限制
- Loss Breaker 已触发

**检查**:
```bash
# 查看 Fund Limiter 状态
cat /tmp/poly-fund-limiter.json | jq '.'

# 查看 Loss Breaker 状态
cat /tmp/poly-loss-breaker.json | jq '.'

# 查看 Kill Switch
ls -lh /tmp/poly-kill-switch*
```

### 问题: 编译错误

```bash
# 清理并重新构建
rm -rf dist/
rm -rf node_modules/
npm install
npm run build
```

## 📝 日常使用流程

### Paper Trading 测试

```bash
# 1. 设置环境
cp .env.paper .env

# 2. 启动测试
npx tsx scripts/endgame/v4-safe.ts

# 3. 在另一个终端监控
./monitor.sh

# 4. 测试 24 小时后查看报告
ls -lh logs/
```

### Live Trading 上线

```bash
# 1. 确认 Paper Trading 测试通过
echo "Paper trading tested for 24+ hours? (yes/no)"

# 2. 设置 Live 环境
cp .env.live .env
nano .env  # 填入 PRIVATE_KEY

# 3. 小额测试配置
cat .env | grep INITIAL_CAPITAL  # 确认是 $100 左右

# 4. 启动
npx tsx scripts/endgame/v4-safe.ts

# 5. 立即监控
./monitor.sh

# 6. 设置定时停止（可选）
echo "0 18 * * * touch /tmp/poly-kill-switch-live" | crontab -
```

## 📚 更多文档

- [实盘交易准备指南](docs/live-trading-readiness.md) - 完整的风控说明
- [API 文档](docs/) - SDK 使用文档
- [示例脚本](examples/) - 更多示例代码

## ⚠️ 重要提醒

1. **Paper Trading 优先**: 任何策略都应先在 Paper Trading 测试至少 24 小时
2. **小额起步**: 实盘从 $50-100 开始，不要一次投入大额资金
3. **严格风控**: 设置合理的日交易额度和亏损限制
4. **实时监控**: 运行时保持监控，及时发现问题
5. **紧急预案**: 熟悉 Kill Switch 的使用方法，确保能在任何情况下停止交易
6. **数据备份**: 定期备份日志和配置文件

## 🆘 需要帮助？

如果遇到问题:

1. 查看 [故障排查](#故障排查) 章节
2. 查看 [实盘交易准备指南](docs/live-trading-readiness.md)
3. 查看日志文件 `logs/`
4. 查看保护机制状态文件 `/tmp/poly-*.json`
5. 提交 Issue 到 GitHub

**交易有风险，请谨慎操作！** 🚨
