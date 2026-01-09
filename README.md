# 使用指南

> **Polymarket TypeScript SDK** - 预测市场交易、聪明钱分析和市场数据的完整解决方案。 ➡️[关于poly-sdk](./poly-sdk.zh-CN.md)

[![npm version](https://img.shields.io/npm/v/@catalyst-team/poly-sdk.svg)](https://www.npmjs.com/package/@catalyst-team/poly-sdk)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## 📖 关于本项目

`poly-sdk` 是一个功能完整的 TypeScript SDK，为 Polymarket 预测市场提供：

- 🎯 **交易功能** - 限价单/市价单（GTC, GTD, FOK, FAK）、订单管理、奖励追踪
- 📊 **市场数据** - 实时价格、订单簿、K线、历史成交、市场搜索
- 🧠 **聪明钱分析** - 追踪顶级交易者、计算 P&L、识别高表现钱包、跟单策略
- ⛓️ **链上操作** - CTF (Split/Merge/Redeem)、代币授权、DEX 交换
- 💰 **套利工具** - 实时套利扫描、监控和执行（生产级）
- 🔴 **实时推送** - WebSocket 实时价格和订单簿更新
- 🚀 **生产就绪** - 包含生产级示例，具备完整的错误处理、日志、监控功能

## ✨ 主要特性

### 📚 13 个完整示例
- **01-07**: 基础功能演示（市场数据、分析、WebSocket）
- **08-10**: 交易和链上操作（需要私钥）
- **11**: 套利扫描（只读）
- **12-13**: 🚀 **生产级套利服务**（包含完整的错误处理、日志、监控）

### 🛠️ 实用脚本集合
- **授权管理** - 代币授权检查和设置
- **充值交换** - USDC 充值和交换工具
- **交易管理** - 订单和仓位管理
- **钱包工具** - 余额检查和验证
- **Dip 套利** - 自动交易策略
- **聪明钱跟单** - 自动跟单系统
- **套利工具** - 套利检测和执行
- **市场研究** - 市场分析和研究工具

### 🚀 生产级功能
- ✅ 结构化日志系统（JSON 格式）
- ✅ 配置验证（启动时检查）
- ✅ 错误处理和重试机制（指数退避）
- ✅ 交易限额和安全检查
- ✅ 指标收集和监控
- ✅ 优雅关闭和状态保存

### 🎨 开发体验
- 📋 **CLI 命令列表工具** - 快速查看所有可用命令
- 🔧 **自动化安装脚本** - 一键安装所有依赖（Windows/Linux/macOS）
- 📖 **完整文档** - 详细的使用指南和 API 文档
- 💡 **丰富示例** - 13 个示例覆盖所有主要功能

## 📦 项目结构

```
poly-sdk/
├── src/                    # SDK 源代码
│   ├── clients/           # 底层客户端（Gamma API, CLOB, CTF等）
│   ├── services/          # 高级服务（Trading, Market, Arbitrage等）
│   └── utils/             # 工具函数
├── examples/              # 示例代码
│   ├── 01-11-*.ts         # 基础教学示例
│   ├── 12-13-*.ts         # 生产级示例
│   └── config/            # 生产级配置模块
├── scripts/                # 实用脚本
│   ├── approvals/         # 代币授权
│   ├── trading/           # 交易管理
│   ├── dip-arb/           # Dip 套利策略
│   └── smart-money/        # 聪明钱跟单
├── install.sh             # Linux/macOS 安装脚本
├── install.ps1            # Windows 安装脚本
└── list-commands.ts       # CLI 命令列表工具
```

## 🎯 适用场景

- 📈 **量化交易** - 自动化交易策略、套利执行
- 🔍 **市场分析** - 市场数据获取、价格分析、趋势监控
- 🧠 **聪明钱追踪** - 识别高表现交易者、跟单策略
- 💰 **套利交易** - 实时套利检测和执行
- 📊 **数据研究** - 市场数据收集和分析

---

## 📋 目录

- [支持平台](#支持平台)
- [克隆项目](#克隆项目)
- [快速安装（自动化脚本）](#快速安装自动化脚本)
- [安装项目依赖并构建项目](#安装项目依赖并构建项目)
- [环境配置](#环境配置)
- [运行示例](#运行示例)
- [命令列表工具](#命令列表工具)
- [示例详解](#示例详解)
- [使用实用脚本](#使用实用脚本)
- [常见问题](#常见问题)

---

## 🖥️ 支持平台

- ![Windows](https://img.shields.io/badge/-Windows-0078D6?logo=windows&logoColor=white)
- ![macOS](https://img.shields.io/badge/-macOS-000000?logo=apple&logoColor=white)
- ![Linux](https://img.shields.io/badge/-Linux-FCC624?logo=linux&logoColor=black)
- ![WSL](https://img.shields.io/badge/-WSL-0078D6?logo=windows&logoColor=white) &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;➡️[如何在 Windows 上安装 WSL2 Ubuntu](https://medium.com/@cryptoguy_/在-windows-上安装-wsl2-和-ubuntu-a857dab92c3e)

---

## 🚀安装指南

### 1️⃣克隆项目
（确保你已安装 `git`，如果未安装请参考➡️[安装git教程](./安装git教程.md)）

```bash
# 克隆仓库
git clone https://github.com/oxmoei/poly-sdk.git

# 进入项目目录
cd poly-sdk
```

---

### 2️⃣快速安装（自动化脚本）

一键检查并安装缺失的前置依赖。
- ✅ 安装系统依赖
- ✅ 安装 Node.js LTS（通过 nvm）
- ✅ 安装 pnpm（多种方式自动尝试）
- ✅ 自动应用环境变量配置
- ✅ 验证安装结果

#### 📌Linux / macOS / WSL 用户

```bash
# 在项目根目录执行
./install.sh
```

#### 📌Windows 用户

```powershell
# 以管理员身份运行 PowerShell，然后在项目根目录执行
Set-ExecutionPolicy Bypass -Scope CurrentUser
.\install.ps1
```
---

### 3️⃣安装项目依赖并构建项目

```bash
# 安装所有项目依赖
pnpm install

# 构建项目
pnpm run build
```

构建完成后，TypeScript 代码将编译到 `dist/` 目录。

---

### 4️⃣配置环境变量

将 `.env.example` 文件重命名为 `.env`，并添加以下内容：

```env
POLYMARKET_PRIVATE_KEY=0x你的私钥

# 可选：套利扫描配置
SCAN_INTERVAL_MS=5000
PROFIT_THRESHOLD=0.005
```

---

## 📋 命令列表工具

项目提供了一个 CLI 工具，可以快速查看所有可用的 Examples 和 Scripts 命令，帮助您快速找到需要的功能。

### 使用方法

```bash
# 方式 1: 使用 pnpm 快捷命令（推荐）
pnpm list                    # 显示所有命令（Examples + Scripts）
pnpm list:examples          # 仅显示 Examples
pnpm list:scripts           # 仅显示 Scripts
pnpm list:quick             # 快速参考

# 方式 2: 直接运行
npx tsx list-commands.ts
npx tsx list-commands.ts examples
npx tsx list-commands.ts scripts
npx tsx list-commands.ts quick
```

### 功能特点

- ✅ **美观的界面**：使用彩色输出，清晰易读
- ✅ **分类展示**：Examples 按类别分组，Scripts 按功能模块分组
- ✅ **完整信息**：显示每个命令的描述、使用方法、是否需要认证
- ✅ **快速参考**：提供常用命令的快速参考模式

### 输出示例

运行 `pnpm list` 会显示：

- **Examples 部分**：按类别（只读操作、交易操作、链上操作、套利检测、套利执行）分组展示
- **Scripts 部分**：按功能模块（授权、充值、交易、钱包、套利等）分组展示
- **快速参考**：常用命令的快速列表

每个命令都会显示：
- 📝 功能描述
- 💻 运行命令（pnpm 和 npx tsx 两种方式）
- 🔐 是否需要私钥认证

---

## 📚 示例详解

### 示例分类

| 类别 | 示例编号 | 是否需要认证 | 说明 |
|------|---------|-------------|------|
| **只读操作** | 01-07 | ❌ 否 | 市场数据、分析、WebSocket |
| **交易操作** | 08-09 | ✅ 是 | 下单、订单管理、奖励追踪 |
| **链上操作** | 10 | ✅ 是 | Split/Merge/Redeem（需要 USDC.e）|
| **套利检测** | 11 | ❌ 否 | 扫描套利机会（基础版） |
| **套利监控** | 12 🚀 | ❌ 否 | 生产级套利监控（持续监控） |
| **套利执行** | 13 🚀 | ✅ 是 | 生产级套利服务（完整工作流程） |

> 🚀 标记表示生产级版本，包含完整的错误处理、日志、监控等功能

### 详细示例说明

#### 01 - 基础用法 (`01-basic-usage.ts`)

**功能**：获取热门市场、市场详情和订单簿数据

**运行**：
```bash
pnpm example:basic
```

**输出示例**：
- 热门市场列表
- 市场详情（问题、条件ID、代币ID、价格）
- 订单簿数据

**代码要点**：
```typescript
const sdk = new PolymarketSDK();
const trendingMarkets = await sdk.gammaApi.getTrendingMarkets(5);
const unifiedMarket = await sdk.getMarket(marketSlug);
const orderbook = await sdk.getOrderbook(conditionId);
```

---

#### 02 - 聪明钱分析 (`02-smart-money.ts`)

**功能**：分析钱包交易表现，识别高收益交易者

**运行**：
```bash
pnpm example:smart-money
```

**功能包括**：
- 获取顶级交易者
- 计算钱包 P&L 和胜率
- 识别高表现钱包

---

#### 03 - 市场分析 (`03-market-analysis.ts`)

**功能**：搜索和分析市场

**运行**：
```bash
pnpm example:market-analysis
```

**功能包括**：
- 关键词搜索
- 按成交量、流动性筛选
- 市场价差分析

---

#### 04 - K线聚合 (`04-kline-aggregation.ts`)

**功能**：获取价格历史数据用于图表展示

**运行**：
```bash
pnpm example:kline
```

**功能包括**：
- 多时间框架蜡烛图（1m, 5m, 1h, 1d）
- OHLCV 数据
- YES/NO 双代币价格追踪

---

#### 05 - 跟单策略 (`05-follow-wallet-strategy.ts`)

**功能**：基于聪明钱信号模拟跟单交易

**运行**：
```bash
pnpm example:follow-wallet
```

**功能包括**：
- 监控钱包活动
- 生成交易信号
- 回测策略表现

---

#### 06 - 服务演示 (`06-services-demo.ts`)

**功能**：展示高级服务抽象

**运行**：
```bash
pnpm example:services
```

**功能包括**：
- `WalletService` - 钱包分析助手
- `MarketService` - 市场数据聚合

---

#### 07 - 实时 WebSocket (`07-realtime-websocket.ts`)

**功能**：使用 `RealtimeServiceV2` 进行实时市场数据流

**运行**：
```bash
pnpm example:realtime
```

**功能包括**：
- 连接到 Polymarket WebSocket（官方客户端）
- 实时订单簿更新
- 价格变动事件
- 最新成交通知
- 加密货币价格订阅（BTC, ETH）

**代码示例**：
```typescript
import { RealtimeServiceV2 } from '@catalyst-team/poly-sdk';

const realtime = new RealtimeServiceV2({ debug: false });
realtime.connect();

realtime.once('connected', () => {
  const sub = realtime.subscribeMarket(yesTokenId, noTokenId, {
    onOrderbook: (book) => console.log('Book:', book),
    onPriceUpdate: (update) => console.log('Price:', update),
  });
});
```

---

#### 08 - 交易订单 (`08-trading-orders.ts`) ⚠️ 需要私钥

**功能**：使用 `TradingService` 进行交易操作

**运行**：
```bash
# 确保已配置 POLYMARKET_PRIVATE_KEY
pnpm example:trading
```

**功能包括**：
- 市场数据：`getMarket()`, `getOrderbook()`, `getPricesHistory()`
- 创建限价/市价单：`createLimitOrder()`, `createMarketOrder()`
- 取消订单：`cancelOrder()`, `cancelAllOrders()`
- 查询订单状态：`getOpenOrders()`, `getTrades()`
- 奖励：`getCurrentRewards()`, `isOrderScoring()`

**订单类型**：
- **GTC** (Good Till Cancelled): 一直有效直到取消
- **GTD** (Good Till Date): 有效期至指定时间
- **FOK** (Fill Or Kill): 全部成交或取消
- **FAK** (Fill And Kill): 部分成交也可以

⚠️ **注意**：此示例默认不会执行真实交易，需要取消注释相关代码。

---

#### 09 - 奖励追踪 (`09-rewards-tracking.ts`) ⚠️ 需要私钥

**功能**：使用 `TradingService` 追踪流动性提供者奖励

**运行**：
```bash
pnpm example:rewards
```

**功能包括**：
- 查找有活跃奖励的市场
- 检查订单是否在计分
- 追踪每日收益

---

#### 10 - CTF 操作 (`10-ctf-operations.ts`) ⚠️ 需要私钥 + USDC.e

**功能**：链上代币操作

**运行**：
```bash
# 确保已配置 POLY_PRIVKEY 且钱包有 USDC.e
pnpm example:ctf
```

**重要提示**：使用 **USDC.e**（不是原生 USDC）

| 代币 | 地址 | CTF 兼容 |
|------|------|----------|
| USDC.e | `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` | ✅ 是 |
| Native USDC | `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359` | ❌ 否 |

**操作类型**：
- **Split**: USDC.e → YES + NO 代币
- **Merge**: YES + NO → USDC.e（套利利润）
- **Redeem**: 获胜代币 → USDC.e

---

#### 11 - 实时套利扫描 (`11-live-arbitrage-scan.ts`)

**功能**：扫描市场寻找套利机会（只读）

**运行**：
```bash
pnpm example:live-arb
```

**功能包括**：
- 获取活跃市场
- 计算有效价格
- 检测多头/空头套利机会

---

#### 12 - 热门套利监控 (`12-trending-arb-monitor.ts`) 🚀 生产级

**功能**：生产级套利监控服务，持续监控热门市场寻找套利机会

**运行**：
```bash
pnpm example:trending-arb
# 或
npx tsx examples/12-trending-arb-monitor.ts
```

**生产级特性**：
- ✅ 结构化日志系统（JSON 格式，支持日志级别）
- ✅ 配置验证（启动时验证所有环境变量）
- ✅ 错误处理和重试机制（指数退避）
- ✅ 指标收集（监控扫描性能、机会检测等）
- ✅ 结果持久化（可选保存到文件）
- ✅ 优雅关闭（保存状态、清理资源）

**功能包括**：
- 实时订单簿分析
- 正确的有效价格计算
- 可配置的扫描间隔
- 持续监控热门市场
- 套利机会自动检测和报告

**环境变量**：
```bash
export SCAN_INTERVAL_MS=5000          # 扫描间隔（毫秒）
export MIN_PROFIT_THRESHOLD=0.1       # 最小利润阈值（%）
export MAX_MARKETS=20                 # 最大监控市场数
export MAX_CYCLES=0                   # 最大扫描周期（0=无限制）
export LOG_LEVEL=INFO                 # 日志级别
export RESULTS_FILE=./results.json     # 结果保存文件（可选）
```

---

#### 13 - 套利服务完整流程 (`13-arbitrage-service.ts`) 🚀 生产级 ⚠️ 需要私钥

**功能**：生产级套利服务，完整的套利工作流程，包含自动执行功能

**运行**：
```bash
pnpm example:arb-service
# 或
npx tsx examples/13-arbitrage-service.ts
# 扫描模式（不执行交易）
npx tsx examples/13-arbitrage-service.ts --scan-only
# 自定义运行时长
npx tsx examples/13-arbitrage-service.ts --duration=300
```

**生产级特性**：
- ✅ 结构化日志系统
- ✅ 配置验证和交易限额
- ✅ 错误处理和重试机制
- ✅ 交易安全措施（每日限额、单笔限额、余额检查）
- ✅ 指标收集和监控
- ✅ 优雅关闭和状态保存

**功能包括**：
- **ArbitrageService**：套利检测和执行的高级 API
- 可配置条件的市场扫描
- 实时 WebSocket 监控
- 带利润阈值的自动执行
- 仓位清算和结算
- 自动仓位再平衡

**环境变量**：
```bash
export POLYMARKET_PRIVATE_KEY=0x...   # 私钥（必需）
export POLYGON_RPC_URL=https://...    # RPC URL（可选）
export PROFIT_THRESHOLD=0.005         # 最小利润阈值（0.5%）
export MIN_TRADE_SIZE=5               # 最小交易金额（USDC）
export MAX_TRADE_SIZE=100             # 最大交易金额（USDC）
export DAILY_TRADE_LIMIT=1000         # 每日交易限额（USDC）
export SCAN_INTERVAL_MS=5000          # 扫描间隔（毫秒）
export LOG_LEVEL=INFO                 # 日志级别
```

---

## 🛠️ 使用实用脚本

> 💡 **提示**：不确定要运行哪个脚本？使用 `pnpm list:scripts` 查看所有可用脚本的详细列表。

`scripts/` 目录包含了一系列实用的工具脚本，用于实际交易操作、测试和验证。这些脚本比 `examples/` 中的示例更加完整和实用，可以直接用于生产环境。

### Scripts 目录结构

```
scripts/
├── approvals/          # 代币授权脚本
├── deposit/            # USDC 充值和交换
├── trading/            # 订单和仓位管理
├── wallet/             # 钱包余额和验证
├── verify/             # API 验证测试
├── dip-arb/            # Dip 套利自动交易
├── smart-money/        # 聪明钱跟踪和跟单
├── arb/                # 套利工具
├── research/           # 市场研究和分析
└── benchmark/          # 性能基准测试
```

### 运行 Scripts

所有 scripts 都通过 `tsx` 直接运行：

```bash
# 方式 1: 使用环境变量（推荐）
npx tsx scripts/xxx/script.ts

# 方式 2: 内联传递环境变量
POLYMARKET_PRIVATE_KEY=0x你的私钥 npx tsx scripts/xxx/script.ts
```

### 主要脚本分类

#### 1. 准备工作脚本

##### `approvals/` - 代币授权

在开始交易前，需要授权代币给 Polymarket 合约：

```bash
# 检查所有授权状态
npx tsx scripts/approvals/check-all-allowances.ts

# 检查 USDC 授权
npx tsx scripts/approvals/check-allowance.ts

# 检查 CTF/ERC1155 授权（重要！）
npx tsx scripts/approvals/check-ctf-approval.ts

# 授权 USDC 给 CTF Exchange
npx tsx scripts/approvals/check-allowance.ts approve

# 授权 ERC1155 代币（用于交易 YES/NO tokens）
npx tsx scripts/approvals/approve-erc1155.ts
```

**重要提示**：如果没有正确授权，订单会失败并提示 "not enough balance / allowance"。

##### `deposit/` - 充值和交换

```bash
# 检查充值地址和余额
npx tsx scripts/deposit/deposit-native-usdc.ts check

# 通过 Bridge 充值原生 USDC（自动转换为 USDC.e）
npx tsx scripts/deposit/deposit-native-usdc.ts deposit 50

# 将原生 USDC 交换为 USDC.e（如果已有原生 USDC）
npx tsx scripts/deposit/swap-usdc-to-usdce.ts
```

**重要提示**：Polymarket CTF 操作需要 **USDC.e**，不是原生 USDC！

| 代币 | 地址 | CTF 兼容 |
|------|------|----------|
| USDC.e | `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` | ✅ 是 |
| Native USDC | `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359` | ❌ 否 |

#### 2. 交易管理脚本

##### `trading/` - 订单和仓位管理

```bash
# 查看当前订单和交易历史
npx tsx scripts/trading/check-orders.ts

# 测试订单下单（GTC vs FOK）
npx tsx scripts/trading/test-order.ts
```

##### `wallet/` - 钱包管理

```bash
# 检查钱包余额（USDC、MATIC、代币等）
npx tsx scripts/wallet/check-wallet-balances.ts

# 验证钱包工具
npx tsx scripts/wallet/verify-wallet-tools.ts

# 测试钱包操作
npx tsx scripts/wallet/test-wallet-operations.ts
```

#### 3. 策略脚本

##### `dip-arb/` - Dip 套利自动交易

Dip 套利策略用于 Polymarket 15 分钟加密货币 UP/DOWN 市场：

```bash
# 运行 ETH Dip 套利（默认）
npx tsx scripts/dip-arb/auto-trade.ts --eth

# 运行 BTC Dip 套利
npx tsx scripts/dip-arb/auto-trade.ts --btc

# 运行 SOL Dip 套利
npx tsx scripts/dip-arb/auto-trade.ts --sol

# 运行 XRP Dip 套利
npx tsx scripts/dip-arb/auto-trade.ts --xrp

# 自定义参数
npx tsx scripts/dip-arb/auto-trade.ts --xrp --dip=0.35 --target=0.90 --shares=50

# 赎回已结束市场的仓位
npx tsx scripts/dip-arb/redeem-positions.ts
```

**策略原理**：
- 检测价格暴跌（如 30% 跌幅）
- 买入暴跌侧（Leg1）
- 等待对侧价格下降后买入（Leg2）
- 锁定利润：UP + DOWN = $1

**日志文件**：每个市场单独生成日志，存放在 `/tmp/dip-arb-logs/`

##### `smart-money/` - 聪明钱跟踪和跟单

```bash
# E2E 测试：完整跟单链路验证
npx tsx scripts/smart-money/01-e2e.ts

# 底层测试：直接使用 WebSocket + Trading API
npx tsx scripts/smart-money/02-e2e-low-level.ts

# 自动跟单交易（完整功能）
npx tsx scripts/smart-money/04-auto-copy-trading.ts

# 简化版自动跟单
npx tsx scripts/smart-money/05-auto-copy-simple.ts

# 真实交易测试（⚠️ 会执行真实交易）
npx tsx scripts/smart-money/06-real-copy-test.ts
```

##### `arb/` - 套利工具

```bash
# 清算仓位（市场结束后）
npx tsx scripts/arb/settle-position.ts

# 执行 merge 操作
npx tsx scripts/arb/settle-position.ts --merge

# 指定市场清算
npx tsx scripts/arb/settle-position.ts --merge --market map1

# 代币再平衡器（维持 USDC/Token 比例）
npx tsx scripts/arb/token-rebalancer.ts
```

#### 4. 测试和验证脚本

##### `verify/` - API 验证

```bash
# 验证所有 API 端点是否正常工作
npx tsx scripts/verify/verify-all-apis.ts

# 测试交易授权
npx tsx scripts/verify/test-approve-trading.ts

# 测试 Provider 修复
npx tsx scripts/verify/test-provider-fix.ts
```

##### `research/` - 市场研究

```bash
# 寻找套利和做市机会
npx tsx scripts/research/research-markets.ts
```

### 完整使用流程示例

#### 场景 1: 首次使用 - 准备交易环境

```bash
# 1. 检查钱包余额
npx tsx scripts/wallet/check-wallet-balances.ts

# 2. 充值 USDC（如果需要）
npx tsx scripts/deposit/deposit-native-usdc.ts deposit 100

# 3. 检查授权状态
npx tsx scripts/approvals/check-all-allowances.ts

# 4. 授权代币（如果需要）
npx tsx scripts/approvals/check-ctf-approval.ts approve
npx tsx scripts/approvals/approve-erc1155.ts

# 5. 验证 API 连接
npx tsx scripts/verify/verify-all-apis.ts
```

#### 场景 2: 执行 Dip 套利策略

```bash
# 1. 启动自动交易（ETH 市场）
npx tsx scripts/dip-arb/auto-trade.ts --eth

# 2. 查看日志（在另一个终端）
tail -f /tmp/dip-arb-logs/eth-updown-15m-*.log

# 3. 市场结束后，赎回仓位
npx tsx scripts/dip-arb/redeem-positions.ts
```

#### 场景 3: 聪明钱跟单

```bash
# 1. 先测试（dry run 模式）
# 编辑 scripts/smart-money/04-auto-copy-trading.ts，设置 DRY_RUN = true
npx tsx scripts/smart-money/04-auto-copy-trading.ts

# 2. 确认无误后，设置 DRY_RUN = false 执行真实交易
npx tsx scripts/smart-money/04-auto-copy-trading.ts
```

#### 场景 4: 日常管理

```bash
# 查看当前订单
npx tsx scripts/trading/check-orders.ts

# 检查余额
npx tsx scripts/wallet/check-wallet-balances.ts

# 研究市场机会
npx tsx scripts/research/research-markets.ts
```

### Scripts 详细文档

更多 scripts 的详细说明，请查看：
- [scripts/README.md](scripts/README.md) - Scripts 完整文档
- [scripts/dip-arb/README.md](scripts/dip-arb/README.md) - Dip 套利策略说明
- [scripts/smart-money/README.md](scripts/smart-money/README.md) - 聪明钱跟单说明

### 生产级示例说明

示例 12-13 是**生产级版本**，包含完整的生产环境功能，可直接用于生产部署。

**生产级特性**（示例 12-13）：
- ✅ 结构化日志系统（JSON 格式，支持日志级别）
- ✅ 配置验证（启动时验证所有环境变量）
- ✅ 错误处理和重试机制（指数退避）
- ✅ 交易限额和安全检查（示例 13）
- ✅ 指标收集和监控
- ✅ 优雅关闭和状态保存

**与普通示例的区别**：

| 特性 | 普通示例（01-11） | 生产级示例（12-13） |
|------|------------------|-------------------|
| 日志 | console.log | 结构化 JSON 日志 |
| 错误处理 | 基础 try-catch | 重试 + 指数退避 |
| 配置 | 环境变量 | 验证 + 默认值 |
| 交易安全 | 无 | 限额 + 余额检查 |
| 监控 | 无 | 内置指标 |
| 关闭 | 基础 | 优雅清理 |

> 💡 **提示**：对于套利相关功能，推荐直接使用示例 12-13（生产级版本），它们已经包含了生产环境所需的所有功能。详细使用方法请参考上面的示例说明。

---

## 🔍 套利概念说明

Polymarket 订单簿具有镜像特性：
- **买入 YES @ P = 卖出 NO @ (1-P)**

正确的有效价格计算：
```
effectiveBuyYes = min(YES.ask, 1 - NO.bid)
effectiveBuyNo = min(NO.ask, 1 - YES.bid)
effectiveSellYes = max(YES.bid, 1 - NO.ask)
effectiveSellNo = max(NO.bid, 1 - YES.ask)
```

| 套利类型 | 条件 | 操作 |
|---------|------|------|
| Long | `effectiveBuyYes + effectiveBuyNo < 1` | 买入两者，合并获得 $1 |
| Short | `effectiveSellYes + effectiveSellNo > 1` | 拆分 $1，卖出两者 |

---

## ❓ 常见问题

### Q1: 如何使用自动化安装脚本？

**A**: 项目提供了两个自动化安装脚本：

**Linux/macOS**：
```bash
bash install.sh
```

**Windows**（需要管理员权限）：
```powershell
Set-ExecutionPolicy Bypass -Scope CurrentUser
.\install.ps1
```

脚本会自动安装：
- 系统依赖
- Node.js LTS
- pnpm
- 自动应用环境变量配置
- 验证安装结果

**常见问题**：
- **Linux/macOS**: 如果 pnpm 安装后未检测到，运行 `source ~/.bashrc` 或 `source ~/.zshrc`，或重新打开终端
- **Windows**: 必须以管理员身份运行 PowerShell；如果 pnpm 未检测到，重启 PowerShell 或手动运行 `npm install -g pnpm`
- 如果脚本失败，可以手动安装依赖：
  - **Node.js**: 访问 https://nodejs.org/ 下载 LTS 版本
  - **pnpm**: 运行 `npm install -g pnpm` 或使用 `corepack enable && corepack prepare pnpm@latest --activate`

### Q2: 如何获取私钥？

**A**: 私钥是您的钱包私钥，可以从 MetaMask 等钱包导出。⚠️ **永远不要分享您的私钥**。

### Q3: 为什么某些示例需要私钥？

**A**: 以下操作需要私钥签名：
- 下单交易（示例 08）
- 链上操作（示例 10）
- 套利执行（示例 13）

只读操作（市场数据、分析）不需要私钥。

### Q4: 如何区分 USDC.e 和原生 USDC？

**A**: 
- **USDC.e**: `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` - 用于 CTF 操作
- **Native USDC**: `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359` - 不能用于 CTF

### Q5: 运行示例时出现 "Module not found" 错误？

**A**: 
```bash
# 确保已安装依赖
pnpm install

# 确保已构建项目
pnpm run build
```

### Q6: TypeScript 类型错误？

**A**: 
```bash
# 重新构建项目
pnpm run build

# 检查 TypeScript 版本
npx tsc --version
```

### Q7: 如何修改示例代码？

**A**: 
1. 直接编辑 `examples/` 目录下的 `.ts` 文件
2. 使用 `npx tsx` 运行修改后的文件
3. 或使用 `pnpm example:xxx` 运行（如果已配置脚本）

### Q8: 示例会执行真实交易吗？

**A**: 
- 示例 08、10、13 **可能**执行真实交易（取决于代码是否取消注释）
- 其他示例都是只读操作
- **建议**：先在测试网或使用小额资金测试

### Q9: 如何查看所有可用的 pnpm 脚本？

**A**: 
```bash
# 查看 package.json 中的 scripts
cat package.json | grep -A 20 '"scripts"'

# 或使用 pnpm
pnpm run

# 或使用命令列表工具（推荐）
pnpm list
```

### Q10: 如何使用命令列表工具？

**A**: 项目提供了 CLI 工具来快速查看所有可用命令：

```bash
# 显示所有命令
pnpm list

# 仅显示 Examples
pnpm list:examples

# 仅显示 Scripts
pnpm list:scripts

# 快速参考
pnpm list:quick
```

这个工具会以美观的格式显示所有命令，包括：
- 功能描述
- 运行命令（pnpm 和 npx tsx 两种方式）
- 是否需要私钥认证
- 参数说明（如果有）

### Q11: Examples 和 Scripts 有什么区别？

**A**: 
- **Examples** (`examples/`): 教学示例，展示 SDK 的基本用法，代码简单清晰
- **Scripts** (`scripts/`): 实用工具，包含完整的工作流程，可直接用于生产环境

建议：
- 学习 SDK → 使用 `examples/`
- 实际交易 → 使用 `scripts/`

### Q12: 如何运行 Scripts？

**A**: 
```bash
# 设置环境变量
export POLYMARKET_PRIVATE_KEY=0x你的私钥

# 运行脚本
npx tsx scripts/xxx/script.ts

# 或内联传递
POLYMARKET_PRIVATE_KEY=0x你的私钥 npx tsx scripts/xxx/script.ts
```

### Q13: Scripts 会执行真实交易吗？

**A**: 
- **会**！Scripts 是生产级工具，会执行真实交易
- **建议**：
  1. 先在小额资金上测试
  2. 仔细阅读脚本的注释和文档
  3. 某些脚本有 `DRY_RUN` 模式，可以先测试

### Q14: 如何查看 Scripts 的详细文档？

**A**: 
- 查看 `scripts/README.md` 获取完整列表
- 查看各子目录的 README（如 `scripts/dip-arb/README.md`）
- 查看脚本文件中的注释

---

## 📖 更多资源

- **完整文档**: 查看 [README.md](README.md) 或 [README.zh-CN.md](README.zh-CN.md)
- **API 参考**: 查看 [docs/02-API.md](docs/02-API.md)
- **架构设计**: 查看 [docs/00-design.md](docs/00-design.md)
- **套利说明**: 查看 [docs/01-polymarket-orderbook-arbitrage.md](docs/01-polymarket-orderbook-arbitrage.md)
- **Scripts 文档**: 查看 [scripts/README.md](scripts/README.md)
- **Examples 文档**: 查看 [examples/README.md](examples/README.md)

---

## 🆘 获取帮助

如果遇到问题：

1. 查看 [GitHub Issues](https://github.com/catalyst-team/poly-sdk/issues)
2. 阅读 [完整文档](README.md)
3. 检查示例代码中的注释

---

## 📝 许可证

MIT License - 详见 [LICENSE](LICENSE) 文件

---

☕ **请我喝杯咖啡 (EVM):** `0xd9c5d6111983ea3692f1d29bec4ac7d6f723217a`

**祝您使用愉快！** 🚀