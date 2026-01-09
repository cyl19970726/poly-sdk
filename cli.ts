#!/usr/bin/env tsx
/**
 * Poly-SDK Interactive CLI
 * 
 * 交互式命令行工具，通过菜单选择执行命令
 * 使用方法: npx tsx cli.ts
 */

import { spawn } from 'child_process';
import * as readline from 'readline';

// 从 list-commands.ts 导入数据（简化版，直接定义）
interface Example {
  id: string;
  name: string;
  file: string;
  description: string;
  auth: boolean;
  category: string;
}

interface ScriptCommand {
  file: string;
  description: string;
  auth: boolean;
  usage?: string;
}

interface ScriptSection {
  name: string;
  description: string;
  commands: ScriptCommand[];
}

// ANSI 颜色代码
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
};

const colorize = (text: string, color: string) => `${color}${text}${colors.reset}`;
const bold = (text: string) => colorize(text, colors.bright);
const dim = (text: string) => colorize(text, colors.dim);
const success = (text: string) => colorize(text, colors.green);
const warning = (text: string) => colorize(text, colors.yellow);
const info = (text: string) => colorize(text, colors.cyan);
const error = (text: string) => colorize(text, colors.red);

// Examples 数据
const examples: Example[] = [
  { id: '01', name: 'basic', file: '01-basic-usage.ts', description: '基础用法 - 获取热门市场和订单簿数据', auth: false, category: '只读操作' },
  { id: '02', name: 'smart-money', file: '02-smart-money.ts', description: '聪明钱分析 - 分析钱包交易表现', auth: false, category: '只读操作' },
  { id: '03', name: 'market-analysis', file: '03-market-analysis.ts', description: '市场分析 - 搜索和分析市场', auth: false, category: '只读操作' },
  { id: '04', name: 'kline', file: '04-kline-aggregation.ts', description: 'K线聚合 - 获取价格历史数据', auth: false, category: '只读操作' },
  { id: '05', name: 'follow-wallet', file: '05-follow-wallet-strategy.ts', description: '跟单策略 - 基于聪明钱信号模拟跟单', auth: false, category: '只读操作' },
  { id: '06', name: 'services', file: '06-services-demo.ts', description: '服务演示 - 展示高级服务抽象', auth: false, category: '只读操作' },
  { id: '07', name: 'realtime', file: '07-realtime-websocket.ts', description: '实时 WebSocket - 实时市场数据流', auth: false, category: '只读操作' },
  { id: '08', name: 'trading', file: '08-trading-orders.ts', description: '交易订单 - 下单和订单管理', auth: true, category: '交易操作' },
  { id: '09', name: 'rewards', file: '09-rewards-tracking.ts', description: '奖励追踪 - 追踪流动性提供者奖励', auth: true, category: '交易操作' },
  { id: '10', name: 'ctf', file: '10-ctf-operations.ts', description: 'CTF 操作 - Split/Merge/Redeem（需要 USDC.e）', auth: true, category: '链上操作' },
  { id: '11', name: 'live-arb', file: '11-live-arbitrage-scan.ts', description: '实时套利扫描 - 扫描市场寻找套利机会', auth: false, category: '套利检测' },
  { id: '12', name: 'trending-arb', file: '12-trending-arb-monitor.ts', description: '热门套利监控 - 持续监控热门市场', auth: false, category: '套利检测' },
  { id: '13', name: 'arb-service', file: '13-arbitrage-service.ts', description: '套利服务完整流程 - 完整的套利工作流程', auth: true, category: '套利执行' },
];

// Scripts 数据
const scripts: Record<string, ScriptSection> = {
  approvals: {
    name: '代币授权',
    description: 'ERC20/ERC1155 授权脚本',
    commands: [
      { file: 'check-all-allowances.ts', description: '检查所有授权状态', auth: true },
      { file: 'check-allowance.ts', description: '检查 USDC 授权', auth: true },
      { file: 'check-ctf-approval.ts', description: '检查 CTF/ERC1155 授权状态', auth: true },
      { file: 'approve-erc1155.ts', description: '授权 ERC1155 代币（用于交易 YES/NO tokens）', auth: true },
      { file: 'approve-neg-risk.ts', description: '授权 USDC 给 Neg Risk Exchange', auth: true },
      { file: 'approve-neg-risk-erc1155.ts', description: '授权 ERC1155 给 Neg Risk Exchange', auth: true },
    ],
  },
  deposit: {
    name: '充值和交换',
    description: 'USDC 充值和交换',
    commands: [
      { file: 'deposit-native-usdc.ts', description: '通过 Bridge 充值原生 USDC（自动转换为 USDC.e）', auth: true, usage: 'check | deposit <amount>' },
      { file: 'deposit-usdc.ts', description: '直接充值 USDC.e', auth: true },
      { file: 'swap-usdc-to-usdce.ts', description: '将原生 USDC 交换为 USDC.e', auth: true },
    ],
  },
  trading: {
    name: '订单和仓位管理',
    description: '交易订单和仓位管理',
    commands: [
      { file: 'check-orders.ts', description: '查看当前订单和交易历史', auth: true },
      { file: 'test-order.ts', description: '测试订单下单（GTC vs FOK）', auth: true },
    ],
  },
  wallet: {
    name: '钱包管理',
    description: '钱包余额和验证',
    commands: [
      { file: 'check-wallet-balances.ts', description: '检查钱包余额（USDC、MATIC、代币等）', auth: true },
      { file: 'verify-wallet-tools.ts', description: '验证钱包工具', auth: true },
      { file: 'test-wallet-operations.ts', description: '测试钱包操作', auth: true },
    ],
  },
  'dip-arb': {
    name: 'Dip 套利自动交易',
    description: 'Polymarket 15 分钟加密货币 UP/DOWN 市场套利',
    commands: [
      { file: 'auto-trade.ts', description: '运行自动交易（支持 --eth, --btc, --sol, --xrp）', auth: true, usage: '--eth | --btc | --sol | --xrp [--dip=0.35] [--target=0.90] [--shares=50]' },
      { file: 'redeem-positions.ts', description: '赎回已结束市场的仓位', auth: true },
      { file: 'scan-markets.ts', description: '扫描市场寻找套利机会', auth: false },
    ],
  },
  'smart-money': {
    name: '聪明钱跟踪和跟单',
    description: '聪明钱跟踪和自动跟单',
    commands: [
      { file: '01-e2e.ts', description: 'E2E 测试：完整跟单链路验证', auth: true },
      { file: '02-e2e-low-level.ts', description: '底层测试：直接使用 WebSocket + Trading API', auth: true },
      { file: '04-auto-copy-trading.ts', description: '自动跟单交易（完整功能）', auth: true },
      { file: '05-auto-copy-simple.ts', description: '简化版自动跟单', auth: true },
      { file: '06-real-copy-test.ts', description: '真实交易测试（⚠️ 会执行真实交易）', auth: true },
    ],
  },
  arb: {
    name: '套利工具',
    description: '套利相关工具',
    commands: [
      { file: 'settle-position.ts', description: '清算仓位（市场结束后）', auth: true, usage: '[--merge] [--market <slug>]' },
      { file: 'token-rebalancer.ts', description: '代币再平衡器（维持 USDC/Token 比例）', auth: true },
    ],
  },
  verify: {
    name: 'API 验证',
    description: 'API 验证测试',
    commands: [
      { file: 'verify-all-apis.ts', description: '验证所有 API 端点是否正常工作', auth: false },
      { file: 'test-approve-trading.ts', description: '测试交易授权', auth: true },
      { file: 'test-provider-fix.ts', description: '测试 Provider 修复', auth: false },
      { file: 'test-search-mcp.ts', description: '测试 MCP 搜索工具', auth: false },
    ],
  },
  research: {
    name: '市场研究',
    description: '市场研究和分析',
    commands: [
      { file: 'research-markets.ts', description: '寻找套利和做市机会', auth: false },
    ],
  },
};

// 创建 readline 接口
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

// 清屏
const clearScreen = () => {
  process.stdout.write('\x1b[2J\x1b[0f');
};

// 打印标题
const printHeader = () => {
  console.log('\n' + '═'.repeat(80));
  console.log(bold('  🚀 Poly-SDK 交互式命令行工具'));
  console.log('═'.repeat(80) + '\n');
};

// 打印分隔线
const printSeparator = () => {
  console.log(dim('─'.repeat(80)));
};

// 执行命令
const executeCommand = (command: string, args: string[] = []) => {
  return new Promise<void>((resolve) => {
    console.log('\n' + info('执行命令: ') + bold(`npx tsx ${command} ${args.join(' ')}`));
    console.log(dim('─'.repeat(80)) + '\n');

    const child = spawn('npx', ['tsx', command, ...args], {
      stdio: 'inherit',
      shell: false, // 移除 shell: true 以避免安全警告
    });

    child.on('close', (code: number | null) => {
      console.log('\n' + dim('─'.repeat(80)));
      if (code === 0) {
        console.log(success('✓ 命令执行完成'));
      } else {
        console.log(error(`✗ 命令执行失败 (退出码: ${code})`));
      }
      console.log(dim('─'.repeat(80)) + '\n');
      resolve();
    });

    child.on('error', (err: Error) => {
      console.error(error(`执行错误: ${err.message}`));
      resolve();
    });
  });
};

// 显示主菜单
const showMainMenu = (): Promise<string> => {
  return new Promise((resolve) => {
    printHeader();
    console.log(bold('请选择操作类型:\n'));
    console.log(`  ${info('1')}. ${bold('Examples')} - 示例命令 (${examples.length} 个)`);
    console.log(`  ${info('2')}. ${bold('Scripts')} - 实用脚本`);
    console.log(`  ${info('0')}. ${dim('退出')}\n`);
    printSeparator();

    rl.question(bold('请输入选项 (0-2): '), (answer: string) => {
      resolve(answer.trim());
    });
  });
};

// 显示 Examples 菜单
const showExamplesMenu = (): Promise<string | null> => {
  return new Promise((resolve) => {
    printHeader();
    console.log(bold('📚 Examples - 示例命令\n'));

    // 按分类分组
    const categories = examples.reduce((acc, ex) => {
      if (!acc[ex.category]) acc[ex.category] = [];
      acc[ex.category].push(ex);
      return acc;
    }, {} as Record<string, Example[]>);

    let index = 1;
    const indexMap: Record<number, Example> = {};

    Object.entries(categories).forEach(([category, items]) => {
      console.log(bold(`\n📁 ${category}`));
      items.forEach((ex) => {
        const authBadge = ex.auth ? warning('🔐') : success('✅');
        const productionBadge = (ex.id === '12' || ex.id === '13') ? info('🚀') : '';
        console.log(`  ${info(String(index).padStart(2))}. ${ex.description} ${productionBadge} ${authBadge}`);
        indexMap[index] = ex;
        index++;
      });
    });

    console.log(`\n  ${dim('0')}. ${dim('返回主菜单')}\n`);
    printSeparator();

    rl.question(bold(`请选择 (0-${index - 1}): `), (answer: string) => {
      const choice = parseInt(answer.trim());
      if (choice === 0) {
        resolve(null);
      } else if (indexMap[choice]) {
        resolve(indexMap[choice].id);
      } else {
        console.log(error('无效选项，请重试\n'));
        setTimeout(() => resolve('retry'), 500);
      }
    });
  });
};

// 显示 Scripts 菜单
const showScriptsMenu = (): Promise<string | null> => {
  return new Promise((resolve) => {
    printHeader();
    console.log(bold('🛠️  Scripts - 实用脚本\n'));

    let index = 1;
    const indexMap: Record<number, { dir: string; cmd: ScriptCommand }> = {};

    Object.entries(scripts).forEach(([dir, section]) => {
      console.log(bold(`\n📂 ${section.name} - ${dim(section.description)}`));
      section.commands.forEach((cmd) => {
        const authBadge = cmd.auth ? warning('🔐') : success('✅');
        console.log(`  ${info(String(index).padStart(2))}. ${cmd.description} ${authBadge}`);
        indexMap[index] = { dir, cmd };
        index++;
      });
    });

    console.log(`\n  ${dim('0')}. ${dim('返回主菜单')}\n`);
    printSeparator();

    rl.question(bold(`请选择 (0-${index - 1}): `), (answer: string) => {
      const choice = parseInt(answer.trim());
      if (choice === 0) {
        resolve(null);
      } else if (indexMap[choice]) {
        const { dir, cmd } = indexMap[choice];
        const fullPath = `scripts/${dir}/${cmd.file}`;
        resolve(fullPath);
      } else {
        console.log(error('无效选项，请重试\n'));
        setTimeout(() => resolve('retry'), 500);
      }
    });
  });
};

// 处理需要额外参数的脚本
const handleScriptWithArgs = (scriptPath: string, cmd: ScriptCommand): Promise<string[]> => {
  return new Promise((resolve) => {
    if (!cmd.usage) {
      resolve([]);
      return;
    }

    console.log(bold(`\n此脚本需要额外参数: ${info(cmd.usage)}`));
    rl.question(bold('请输入参数 (直接回车跳过): '), (answer: string) => {
      const args = answer.trim().split(/\s+/).filter(Boolean);
      resolve(args);
    });
  });
};

// 等待用户输入
const waitForEnter = (): Promise<void> => {
  return new Promise((resolve) => {
    rl.question(bold('\n按回车键继续...'), (_answer: string) => {
      resolve();
    });
  });
};

// 主循环
const main = async () => {
  while (true) {
    const mainChoice = await showMainMenu();

    if (mainChoice === '0') {
      console.log('\n' + success('感谢使用！再见 👋\n'));
      rl.close();
      break;
    } else if (mainChoice === '1') {
      // Examples
      while (true) {
        const exampleId = await showExamplesMenu();
        if (exampleId === null) break;
        if (exampleId === 'retry') continue;

        const example = examples.find((e) => e.id === exampleId);
        if (example) {
          if (example.auth) {
            const hasKey = process.env.POLYMARKET_PRIVATE_KEY;
            if (!hasKey) {
              console.log(warning('\n⚠️  此命令需要私钥，但未检测到 POLYMARKET_PRIVATE_KEY 环境变量'));
              console.log(dim('请先设置环境变量或使用 .env 文件\n'));
              const answer = await new Promise<string>((resolve) => {
                rl.question(bold('是否继续？(y/N): '), resolve);
              });
              if (answer.toLowerCase() !== 'y') {
                continue;
              }
            }
          }

          await executeCommand(`examples/${example.file}`);
          await waitForEnter();
        }
      }
    } else if (mainChoice === '2') {
      // Scripts
      while (true) {
        const scriptPath = await showScriptsMenu();
        if (scriptPath === null) break;
        if (scriptPath === 'retry') continue;

        const [dir, file] = scriptPath.replace('scripts/', '').split('/');
        const section = scripts[dir];
        const cmd = section?.commands.find((c) => c.file === file);

        if (cmd) {
          if (cmd.auth) {
            const hasKey = process.env.POLYMARKET_PRIVATE_KEY;
            if (!hasKey) {
              console.log(warning('\n⚠️  此命令需要私钥，但未检测到 POLYMARKET_PRIVATE_KEY 环境变量'));
              console.log(dim('请先设置环境变量或使用 .env 文件\n'));
              const answer = await new Promise<string>((resolve) => {
                rl.question(bold('是否继续？(y/N): '), resolve);
              });
              if (answer.toLowerCase() !== 'y') {
                continue;
              }
            }
          }

          const args = await handleScriptWithArgs(scriptPath, cmd);
          await executeCommand(scriptPath, args);
          await waitForEnter();
        }
      }
    } else {
      console.log(error('无效选项，请重试\n'));
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
};

// 启动
main().catch((err) => {
  console.error(error(`错误: ${err.message}`));
  rl.close();
  process.exit(1);
});

