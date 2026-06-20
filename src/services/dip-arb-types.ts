/**
 * Dip Arbitrage Service Types
 *
 * 暴跌套利服务类型定义
 *
 * 策略原理：
 * 在 Polymarket 的 BTC/ETH/SOL/XRP UP/DOWN 短期市场中：
 *
 * 1. 每个市场有一个 "price to beat"（开盘时的 Chainlink 价格）
 * 2. 结算规则：
 *    - UP 赢：结束时价格 >= price to beat
 *    - DOWN 赢：结束时价格 < price to beat
 *
 * 3. 套利流程：
 *    - Leg1：检测暴跌 → 买入暴跌侧
 *    - Leg2：等待对冲条件 → 买入另一侧
 *    - 利润：总成本 < $1 时获得无风险利润
 */

// ============= Configuration =============

/**
 * DipArbService 配置
 */
export interface DipArbServiceConfig {
  /**
   * 每次交易的份额数量
   * @default 20
   */
  shares?: number;

  /**
   * 对冲价格阈值 (sumTarget)
   * 只有当 leg1Price + leg2Price <= sumTarget 时才执行对冲
   * @default 0.95
   */
  sumTarget?: number;

  /**
   * 暴跌触发阈值
   * 价格相对开盘价下跌超过此比例时触发 Leg1
   * 0.15 = 15%
   * @default 0.15
   */
  dipThreshold?: number;

  /**
   * 交易窗口（分钟）
   * 每轮开始后，只在此时间窗口内触发 Leg1
   * @default 2
   */
  windowMinutes?: number;

  /**
   * 滑动窗口时长（毫秒）
   * 用于检测瞬时暴跌：比较当前价格与 N 毫秒前的价格
   *
   * 重要：这是策略的核心参数！
   * - 3000ms (3秒) 跌 15% = 异常事件 ✅ 触发
   * - 5分钟跌 15% = 趋势下行 ❌ 不触发
   *
   * @default 3000
   */
  slidingWindowMs?: number;

  /**
   * 最大滑点
   * 下单价格 = 市场价 * (1 + maxSlippage)
   * @default 0.02
   */
  maxSlippage?: number;

  /**
   * 最小利润率
   * 只有预期利润率 > minProfitRate 时才生成信号
   * @default 0.03
   */
  minProfitRate?: number;

  /**
   * Leg1 成交后等待 Leg2 的最大时间（秒）
   * 超时后放弃当前轮次
   * @default 300
   */
  leg2TimeoutSeconds?: number;

  /**
   * 启用暴涨检测
   * 当 token 价格暴涨时，买入对手 token（预期均值回归）
   * @default true
   */
  enableSurge?: boolean;

  /**
   * 暴涨触发阈值
   * 价格相对开盘价上涨超过此比例时触发
   * @default 0.15
   */
  surgeThreshold?: number;

  /**
   * 完成双腿后自动合并回 pUSD
   * YES + NO tokens → pUSD
   * @default true
   */
  autoMerge?: boolean;

  /**
   * 自动执行交易
   * 检测到信号后自动下单
   * @default false
   */
  autoExecute?: boolean;

  /**
   * 执行冷却时间（毫秒）
   * 两次交易之间的最小间隔
   * @default 3000
   */
  executionCooldown?: number;

  /**
   * 拆分订单数量
   * 将 shares 拆分成多笔订单执行
   * 例如: shares=30, splitOrders=3 → 每笔 10 shares
   * @default 1 (不拆分)
   */
  splitOrders?: number;

  /**
   * 拆分订单间隔（毫秒）
   * 多笔订单之间的间隔时间
   * @default 500
   */
  orderIntervalMs?: number;

  /**
   * 启用调试日志
   * @default false
   */
  debug?: boolean;

  /**
   * 自定义日志处理函数
   * 如果设置，所有日志将通过此函数输出
   * @example
   * logHandler: (msg) => {
   *   console.log(`[${Date.now()}] ${msg}`);
   *   logs.push(msg);
   * }
   */
  logHandler?: (message: string) => void;
}

/**
 * 内部配置类型（不包含 logHandler，因为它是纯可选的回调函数）
 */
export type DipArbConfigInternal = Required<Omit<DipArbServiceConfig, 'logHandler'>> & {
  logHandler?: (message: string) => void;
};

/**
 * 默认配置
 */
export const DEFAULT_DIP_ARB_CONFIG: DipArbConfigInternal = {
  shares: 20,
  sumTarget: 0.92,        // ✅ 放宽到 0.92 提高 Leg2 成交率 (8%+ 利润)
  dipThreshold: 0.15,
  windowMinutes: 2,
  slidingWindowMs: 3000,  // 3秒滑动窗口 - 核心参数！
  maxSlippage: 0.02,
  minProfitRate: 0.03,
  leg2TimeoutSeconds: 180,  // ✅ 缩短到 3 分钟，更快退出未对冲仓位
  enableSurge: true,
  surgeThreshold: 0.15,
  autoMerge: true,
  autoExecute: false,
  executionCooldown: 3000,
  splitOrders: 1,         // ✅ 默认不拆分，避免份额误差
  orderIntervalMs: 500,   // 拆分订单间隔 500ms
  debug: false,
};

// ============= Market Configuration =============

/** 支持的底层资产 */
export type DipArbUnderlying = 'BTC' | 'ETH' | 'SOL' | 'XRP';

/** 市场时长 */
export type DipArbDuration = 5 | 15;

/**
 * 市场配置
 */
export interface DipArbMarketConfig {
  /** 市场名称（用于日志） */
  name: string;
  /** 市场 slug (e.g., 'btc-updown-15m-1767165300') */
  slug: string;
  /** Condition ID */
  conditionId: string;
  /** UP token ID */
  upTokenId: string;
  /** DOWN token ID */
  downTokenId: string;
  /** 底层资产 */
  underlying: DipArbUnderlying;
  /** 市场时长（分钟） */
  durationMinutes: DipArbDuration;
  /** 市场结束时间 */
  endTime: Date;
}

// ============= Round State =============

/** 轮次阶段 */
export type DipArbPhase = 'waiting' | 'leg1_filled' | 'completed' | 'expired';

/** 交易侧 */
export type DipArbSide = 'UP' | 'DOWN';

/**
 * Leg 信息
 */
export interface DipArbLegInfo {
  /** 买入侧 */
  side: DipArbSide;
  /** 成交价格 */
  price: number;
  /** 份额数量 */
  shares: number;
  /** 成交时间 */
  timestamp: number;
  /** Token ID */
  tokenId: string;
}

/**
 * 轮次状态
 */
export interface DipArbRoundState {
  /** 轮次 ID */
  roundId: string;
  /** 轮次开始时间 (Unix ms) */
  startTime: number;
  /** 轮次结束时间 (Unix ms) */
  endTime: number;
  /** Price to Beat - 开盘时的底层资产价格（Chainlink） */
  priceToBeat: number;
  /** 开盘时的 token 价格 */
  openPrices: {
    up: number;
    down: number;
  };
  /** 当前阶段 */
  phase: DipArbPhase;
  /** Leg1 信息（如果已成交） */
  leg1?: DipArbLegInfo;
  /** Leg2 信息（如果已成交） */
  leg2?: DipArbLegInfo;
  /** 总成本 */
  totalCost?: number;
  /** 实际利润 */
  profit?: number;
}

// ============= Signals =============

/**
 * Leg1 信号
 */
export interface DipArbLeg1Signal {
  type: 'leg1';
  /** 轮次 ID */
  roundId: string;
  /** 买入侧 */
  dipSide: DipArbSide;
  /** 当前价格 */
  currentPrice: number;
  /** 开盘价格 */
  openPrice: number;
  /** 下跌/上涨幅度 */
  dropPercent: number;
  /** 目标价格（包含滑点） */
  targetPrice: number;
  /** 份额数量 */
  shares: number;
  /** Token ID */
  tokenId: string;
  /** 对手侧当前 ask 价格 */
  oppositeAsk: number;
  /** 预估总成本 */
  estimatedTotalCost: number;
  /** 预估利润率 */
  estimatedProfitRate: number;
  /** 信号来源 */
  source: 'dip' | 'surge' | 'mispricing';
  /** BTC 信息（用于定价偏差检测） */
  btcInfo?: {
    btcPrice: number;
    priceToBeat: number;
    btcChangePercent: number;
    estimatedWinRate: number;
  };
}

/**
 * Leg2 信号
 */
export interface DipArbLeg2Signal {
  type: 'leg2';
  /** 轮次 ID */
  roundId: string;
  /** 对冲侧 */
  hedgeSide: DipArbSide;
  /** Leg1 信息 */
  leg1: DipArbLegInfo;
  /** 当前价格 */
  currentPrice: number;
  /** 目标价格（包含滑点） */
  targetPrice: number;
  /** 总成本 (leg1 + leg2) */
  totalCost: number;
  /** 预期利润率 */
  expectedProfitRate: number;
  /** 份额数量 */
  shares: number;
  /** Token ID */
  tokenId: string;
}

/** 信号类型 */
export type DipArbSignal = DipArbLeg1Signal | DipArbLeg2Signal;

// ============= Execution Results =============

/**
 * 执行结果
 */
export interface DipArbExecutionResult {
  /** 是否成功 */
  success: boolean;
  /** 执行的 leg */
  leg: 'leg1' | 'leg2' | 'merge' | 'exit';
  /** 轮次 ID */
  roundId: string;
  /** 交易侧 */
  side?: DipArbSide;
  /** 成交价格 */
  price?: number;
  /** 成交份额 */
  shares?: number;
  /** 订单 ID */
  orderId?: string;
  /** 交易哈希（merge 操作） */
  txHash?: string;
  /** 错误信息 */
  error?: string;
  /** 执行时间（毫秒） */
  executionTimeMs: number;
}

/**
 * 轮次完成结果
 */
export interface DipArbRoundResult {
  /** 轮次 ID */
  roundId: string;
  /** 状态 */
  status: 'completed' | 'expired' | 'partial';
  /** Leg1 信息 */
  leg1?: DipArbLegInfo;
  /** Leg2 信息 */
  leg2?: DipArbLegInfo;
  /** 总成本 */
  totalCost?: number;
  /** 实际利润 */
  profit?: number;
  /** 利润率 */
  profitRate?: number;
  /** 是否已合并 */
  merged: boolean;
  /** 合并交易哈希 */
  mergeTxHash?: string;
  /** Leg1 退出结果（Leg2 超时时） */
  exitResult?: DipArbExecutionResult | null;
}

// ============= Statistics =============

/**
 * 服务统计
 */
export interface DipArbStats {
  /** 开始时间 */
  startTime: number;
  /** 运行时长（毫秒） */
  runningTimeMs: number;
  /** 监控的轮次数 */
  roundsMonitored: number;
  /** 完成的轮次数 */
  roundsCompleted: number;
  /** 成功的轮次数（双腿完成） */
  roundsSuccessful: number;
  /** 过期的轮次数 */
  roundsExpired: number;
  /** 检测到的信号数 */
  signalsDetected: number;
  /** Leg1 成交次数 */
  leg1Filled: number;
  /** Leg2 成交次数 */
  leg2Filled: number;
  /** 总花费 (USDC) */
  totalSpent: number;
  /** 总收益 (USDC) */
  totalProfit: number;
  /** 平均利润率 */
  avgProfitRate: number;
  /** 当前轮次信息 */
  currentRound?: {
    roundId: string;
    phase: DipArbPhase;
    priceToBeat: number;
    leg1?: { side: DipArbSide; price: number };
  };
}

// ============= Events =============

/**
 * 新轮次事件数据
 */
export interface DipArbNewRoundEvent {
  roundId: string;
  priceToBeat: number;
  upOpen: number;
  downOpen: number;
  startTime: number;
  endTime: number;
}

/**
 * 价格更新事件数据
 */
export interface DipArbPriceUpdateEvent {
  underlying: DipArbUnderlying;
  value: number;
  priceToBeat: number;
  changePercent: number;
}

/**
 * 服务事件
 */
export interface DipArbServiceEvents {
  started: (market: DipArbMarketConfig) => void;
  stopped: () => void;
  newRound: (event: DipArbNewRoundEvent) => void;
  signal: (signal: DipArbSignal) => void;
  execution: (result: DipArbExecutionResult) => void;
  roundComplete: (result: DipArbRoundResult) => void;
  priceUpdate: (event: DipArbPriceUpdateEvent) => void;
  error: (error: Error) => void;
}

// ============= Scan Options =============

/**
 * 市场扫描选项
 */
export interface DipArbScanOptions {
  /** 筛选底层资产 */
  coin?: DipArbUnderlying | 'all';
  /** 筛选时长 */
  duration?: '5m' | '15m' | '1h' | '4h' | 'all';
  /** 距离结束的最小分钟数 */
  minMinutesUntilEnd?: number;
  /** 距离结束的最大分钟数 */
  maxMinutesUntilEnd?: number;
  /** 返回数量限制 */
  limit?: number;
}

/**
 * 自动启动选项
 */
export interface DipArbFindAndStartOptions {
  /** 偏好的底层资产 */
  coin?: DipArbUnderlying;
  /** 偏好的时长 */
  preferDuration?: '5m' | '15m';
}

/**
 * 自动轮换配置
 */
export interface DipArbAutoRotateConfig {
  /** 是否启用自动轮换 */
  enabled: boolean;
  /** 监控的底层资产列表 */
  underlyings: DipArbUnderlying[];
  /** 偏好的时长 */
  duration: '5m' | '15m';
  /** 市场结束前多少分钟开始寻找下一个市场 */
  preloadMinutes?: number;
  /** 市场结束后自动结算 */
  autoSettle?: boolean;
  /** 结算策略: 'redeem' 赎回 (等结算) 或 'sell' 立即卖出 */
  settleStrategy?: 'redeem' | 'sell';
  /** Redeem 等待时间（分钟）- 市场结束后等待 Oracle 结算的时间，默认 5 分钟 */
  redeemWaitMinutes?: number;
  /** Redeem 重试间隔（秒）- 每次检查 resolution 的间隔，默认 30 秒 */
  redeemRetryIntervalSeconds?: number;
}

/**
 * 默认自动轮换配置
 */
export const DEFAULT_AUTO_ROTATE_CONFIG: Required<DipArbAutoRotateConfig> = {
  enabled: false,
  underlyings: ['BTC'],
  duration: '15m',
  preloadMinutes: 2,
  autoSettle: true,
  settleStrategy: 'redeem',
  redeemWaitMinutes: 5,
  redeemRetryIntervalSeconds: 30,
};

/**
 * 结算结果
 */
export interface DipArbSettleResult {
  /** 是否成功 */
  success: boolean;
  /** 结算策略 */
  strategy: 'redeem' | 'sell';
  /** 市场信息 */
  market?: DipArbMarketConfig;
  /** UP token 数量 */
  upBalance?: number;
  /** DOWN token 数量 */
  downBalance?: number;
  /** 收到的金额 (pUSD) */
  amountReceived?: number;
  /** 交易哈希 */
  txHash?: string;
  /** 错误信息 */
  error?: string;
  /** 执行时间（毫秒） */
  executionTimeMs: number;
}

/**
 * 待赎回的仓位
 * 用于跟踪市场结束后需要赎回的仓位
 */
export interface DipArbPendingRedemption {
  /** 市场配置 */
  market: DipArbMarketConfig;
  /** 轮次状态（包含持仓信息） */
  round: DipArbRoundState;
  /** 市场结束时间 */
  marketEndTime: number;
  /** 添加到队列的时间 */
  addedAt: number;
  /** 重试次数 */
  retryCount: number;
  /** 最后一次尝试时间 */
  lastRetryAt?: number;
}

/**
 * 市场轮换事件
 */
export interface DipArbRotateEvent {
  /** 旧市场 condition ID */
  previousMarket?: string;
  /** 新市场 condition ID */
  newMarket: string;
  /** 轮换原因 */
  reason: 'marketEnded' | 'manual' | 'error';
  /** 时间戳 */
  timestamp: number;
  /** 结算结果（如果有） */
  settleResult?: DipArbSettleResult;
}

// ============= Helper Functions =============

/**
 * 创建初始统计
 */
export function createDipArbInitialStats(): DipArbStats {
  return {
    startTime: Date.now(),
    runningTimeMs: 0,
    roundsMonitored: 0,
    roundsCompleted: 0,
    roundsSuccessful: 0,
    roundsExpired: 0,
    signalsDetected: 0,
    leg1Filled: 0,
    leg2Filled: 0,
    totalSpent: 0,
    totalProfit: 0,
    avgProfitRate: 0,
  };
}

/**
 * 创建新轮次状态
 */
export function createDipArbRoundState(
  roundId: string,
  priceToBeat: number,
  upPrice: number,
  downPrice: number,
  durationMinutes: number = 15
): DipArbRoundState {
  const now = Date.now();
  return {
    roundId,
    startTime: now,
    endTime: now + durationMinutes * 60 * 1000,
    priceToBeat,
    openPrices: {
      up: upPrice,
      down: downPrice,
    },
    phase: 'waiting',
  };
}

/**
 * 计算利润率
 */
export function calculateDipArbProfitRate(totalCost: number): number {
  if (totalCost >= 1 || totalCost <= 0) return 0;
  return (1 - totalCost) / totalCost;
}

/**
 * 计算基于底层资产价格变化的"真实"胜率
 *
 * @param currentPrice - 当前价格
 * @param priceToBeat - 开盘价格
 * @returns UP 的真实胜率估计 (0-1)
 */
export function estimateUpWinRate(currentPrice: number, priceToBeat: number): number {
  if (priceToBeat <= 0) return 0.5;

  const priceChange = (currentPrice - priceToBeat) / priceToBeat;

  // 简单模型：价格变化 1% 对应胜率变化约 10%
  const sensitivity = 10;
  const winRateShift = priceChange * sensitivity;

  // 限制在 [0.05, 0.95] 范围内
  return Math.max(0.05, Math.min(0.95, 0.5 + winRateShift));
}

/**
 * 检测定价偏差
 *
 * @param tokenPrice - token 当前价格（隐含胜率）
 * @param estimatedWinRate - 基于价格估计的真实胜率
 * @returns 偏差程度（正数 = 被低估，负数 = 被高估）
 */
export function detectMispricing(tokenPrice: number, estimatedWinRate: number): number {
  return estimatedWinRate - tokenPrice;
}

/**
 * 从 slug 解析底层资产
 * e.g., 'btc-updown-15m-1767165300' → 'BTC'
 */
export function parseUnderlyingFromSlug(slug: string): DipArbUnderlying {
  const lower = slug.toLowerCase();
  if (lower.startsWith('btc')) return 'BTC';
  if (lower.startsWith('eth')) return 'ETH';
  if (lower.startsWith('sol')) return 'SOL';
  if (lower.startsWith('xrp')) return 'XRP';
  return 'BTC'; // default
}

/**
 * 从 slug 解析时长
 * e.g., 'btc-updown-15m-1767165300' → 15
 */
export function parseDurationFromSlug(slug: string): DipArbDuration {
  if (slug.includes('-5m-')) return 5;
  if (slug.includes('-15m-')) return 15;
  return 15; // default
}

/**
 * 类型守卫：检查是否为 Leg1 信号
 */
export function isDipArbLeg1Signal(signal: DipArbSignal): signal is DipArbLeg1Signal {
  return signal.type === 'leg1';
}

/**
 * 类型守卫：检查是否为 Leg2 信号
 */
export function isDipArbLeg2Signal(signal: DipArbSignal): signal is DipArbLeg2Signal {
  return signal.type === 'leg2';
}
