export type CatalystKLineInterval = '5s' | '15s' | '30s' | '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d';

export type CatalystKLineCandle = {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  tradeCount: number;
  tokenId: string;
  buyVolume?: number;
  sellVolume?: number;
};

export type CatalystWsTopic = 'kline:update' | 'depth:update';

export type CatalystWsClientMessage =
  | {
      type: 'subscribe';
      reqId?: string;
      topics: CatalystWsTopic[];
      markets: string[]; // conditionIds, or ["*"]
    }
  | {
      type: 'unsubscribe';
      reqId?: string;
      topics?: CatalystWsTopic[];
      markets?: string[];
    }
  | {
      type: 'ping';
      reqId?: string;
    };

export type CatalystWsServerMessage =
  | {
      type: 'hello';
      tsMs: number;
      schemaVersion: 1;
    }
  | {
      type: 'pong';
      reqId?: string;
      tsMs: number;
    }
  | {
      type: 'subscribed' | 'unsubscribed';
      reqId?: string;
    }
  | {
      type: 'error';
      reqId?: string;
      code: string;
      message: string;
    }
  | {
      type: 'event';
      topic: CatalystWsTopic;
      eventId: string;
      tsMs: number;
      schemaVersion: 1;
      payload: unknown;
    };

export type CatalystKlineUpdatePayload = {
  conditionId: string;
  tokenId: string;
  interval: CatalystKLineInterval;
  candle: CatalystKLineCandle;
  isFinal: boolean;
};

export type CatalystSpreadSnapshot = {
  type: 'spread_snapshot';
  timestamp: number;
  conditionId: string;
  tokenId: string;
  spread: number;
  spreadPercent: number;
  midPrice: number;
  bestBid: number;
  bestAsk: number;
  bidDepth: number;
  askDepth: number;
  bidRatio: number;
};

export type CatalystDepthUpdatePayload = {
  conditionId: string;
  configId: 'v1-spread_snapshot' | string;
  /** Primary outcome spread (e.g., Yes/Up) */
  primary: CatalystSpreadSnapshot;
  /** Secondary outcome spread (e.g., No/Down) */
  secondary: CatalystSpreadSnapshot;
  /** Dynamic outcome names [primary, secondary] */
  outcomes: [string, string];
  /** @deprecated Use primary instead */
  yes?: CatalystSpreadSnapshot;
  /** @deprecated Use secondary instead */
  no?: CatalystSpreadSnapshot;
};

// ============================================================================
// Query Service Response Types
// ============================================================================

export type CatalystHealthResponse = {
  status: string;
  service: string;
  version: string;
  now: number;
  tracked: {
    markets: Array<{
      conditionId: string;
      slug: string;
      coin?: string;
      duration?: string;
      outcomes: [string, string];
    }>;
    count: number;
  };
  circuitBreaker?: {
    consecutiveFailures: number;
    lastFailureTime: number;
    currentBackoffMs: number;
    isOpen: boolean;
  };
  ws: {
    connections: number;
  };
  config: {
    tickMs: number;
    tradeFlushEveryMs: number;
    orderbookSnapshotEveryMs: number;
    klinePushEveryMs: number;
    depthPushEveryMs: number;
    spreadSamplingIntervalMs: number;
  };
};

export type CatalystKlinesResponse = {
  conditionId: string;
  interval: string;
  /** Primary outcome K-lines (e.g., Yes/Up) */
  yes: CatalystKLineCandle[];
  /** Secondary outcome K-lines (e.g., No/Down) */
  no: CatalystKLineCandle[];
  spreadAnalysis?: {
    avgSpread: number;
    minSpread: number;
    maxSpread: number;
  };
};

export type CatalystTradeRecord = {
  type: 'trade';
  timestamp: number;
  tokenId: string;
  conditionId: string;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  traderAddress?: string;
  tradeId?: string;
};

export type CatalystTradesResponse = {
  conditionId: string;
  trades: CatalystTradeRecord[];
  count: number;
};

export type CatalystOrderbookSnapshot = {
  type: 'orderbook';
  timestamp: number;
  tokenId: string;
  conditionId: string;
  bids: Array<{ price: number; size: number }>;
  asks: Array<{ price: number; size: number }>;
};

export type CatalystOrderbookSnapshotsResponse = {
  conditionId: string;
  snapshots: CatalystOrderbookSnapshot[];
  count: number;
};

export type CatalystDepthLineResponse = {
  conditionId: string;
  configId: string;
  primaryTokenId: string;
  secondaryTokenId: string;
  outcomes: [string, string];
  primary: CatalystSpreadSnapshot[];
  secondary: CatalystSpreadSnapshot[];
};
