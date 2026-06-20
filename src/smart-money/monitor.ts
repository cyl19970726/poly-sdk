/**
 * smart-money/monitor.ts
 *
 * TradeMonitor: polls target wallets and/or monitors mempool for trades.
 * Emits unified TradeEvent regardless of detection source.
 */

import { EventEmitter } from 'events';
import WebSocket from 'ws';
import type { DataApiClient, Activity } from '../clients/data-api.js';
import type { TradeEvent, MonitorOptions } from './types.js';
import { createModuleLogger } from '../core/logger.js';
import {
  ROUTER_ADDRESSES,
  MATCH_ORDERS_SELECTOR_V1,
  MATCH_ORDERS_SELECTOR_V2,
  decodeMatchOrdersCalldata,
  extractTraderAddresses,
  OrderSide,
} from '../utils/calldata-decoder.js';
import { POLYGON_CONTRACTS_V2 } from '../constants/v2-contracts.js';

/**
 * Plan 11 §6 — Settlement TX recipient whitelist.
 *
 * Mempool TXs filter on `tx.to` to skip non-settlement traffic before
 * paying for calldata decode. V1 settlement went through router proxies
 * (CTF Router / NegRisk Router); V2 settlement goes direct to the V2
 * exchanges (CTF Exchange / NegRisk CTF Exchange).
 *
 * Both V1 and V2 are accepted so the historical-replay path keeps working
 * during the cutover window when the mempool may carry pending V1 TXs
 * that were broadcast before 2026-04-28 + still in flight.
 */
const SETTLEMENT_RECIPIENTS = new Set<string>([
  ...Array.from(ROUTER_ADDRESSES),
  POLYGON_CONTRACTS_V2.ctfExchange.toLowerCase(),
  POLYGON_CONTRACTS_V2.negRiskExchange.toLowerCase(),
]);

/**
 * Both V1 (`0x2287e350`) and V2 (`0x3c2b4399`) `matchOrders` selectors.
 * `decodeMatchOrdersCalldata` auto-detects the version from the leading
 * 4 bytes; this prefix gate is just to skip non-settlement calldata cheaply.
 */
function hasMatchOrdersSelector(input: string): boolean {
  return (
    input.startsWith(MATCH_ORDERS_SELECTOR_V2) ||
    input.startsWith(MATCH_ORDERS_SELECTOR_V1)
  );
}

const log = createModuleLogger('sm-monitor');

export type { TradeEvent, MonitorOptions };

/**
 * TradeMonitor watches a set of addresses for trades via polling and/or mempool.
 *
 * Events:
 *   'trade' → (event: TradeEvent)
 */
export class TradeMonitor extends EventEmitter {
  private dataApi: DataApiClient;
  private opts: Required<MonitorOptions>;

  // Polling state
  private watchedAddresses = new Set<string>();
  private pollIntervalId: NodeJS.Timeout | null = null;
  private lastCheckTimestamp: number = Math.floor(Date.now() / 1000);
  private seenTxHashes = new Set<string>();

  // Mempool state
  private mempoolWs: WebSocket | null = null;
  private mempoolTargets = new Set<string>();
  private mempoolMsgCount = 0;
  private mempoolLastStatLog = 0;

  constructor(dataApi: DataApiClient, opts: MonitorOptions = {}) {
    super();
    this.dataApi = dataApi;
    this.opts = {
      pollIntervalMs: opts.pollIntervalMs ?? 5_000,
      mempoolWssUrl: opts.mempoolWssUrl ?? '',
      debug: opts.debug ?? false,
    };
  }

  /**
   * Start watching addresses in the given mode.
   */
  watch(addresses: string[], mode: 'polling' | 'mempool' | 'dual' = 'polling'): void {
    for (const addr of addresses) {
      this.watchedAddresses.add(addr.toLowerCase());
      this.mempoolTargets.add(addr.toLowerCase());
    }

    if (mode === 'polling' || mode === 'dual') {
      this.startPolling();
    }
    if (mode === 'mempool' || mode === 'dual') {
      this.startMempool();
    }
  }

  /**
   * Stop watching addresses.
   */
  unwatch(addresses: string[]): void {
    for (const addr of addresses) {
      this.watchedAddresses.delete(addr.toLowerCase());
      this.mempoolTargets.delete(addr.toLowerCase());
    }

    if (this.watchedAddresses.size === 0) {
      this.stopPolling();
      this.stopMempool();
    }
  }

  /**
   * Stop all monitoring.
   */
  stop(): void {
    this.stopPolling();
    this.stopMempool();
    this.watchedAddresses.clear();
    this.mempoolTargets.clear();
  }

  // ============================================================================
  // Polling
  // ============================================================================

  private startPolling(): void {
    if (this.pollIntervalId) return;

    this.pollIntervalId = setInterval(async () => {
      const activities = await this.pollAll();
      const now = Date.now();

      for (const activity of activities) {
        if (activity.transactionHash && this.seenTxHashes.has(activity.transactionHash)) {
          continue;
        }
        if (activity.transactionHash) {
          this.seenTxHashes.add(activity.transactionHash);
          if (this.seenTxHashes.size > 1000) {
            const toRemove = Array.from(this.seenTxHashes).slice(0, 500);
            toRemove.forEach(h => this.seenTxHashes.delete(h));
          }
        }

        const event = this.activityToTradeEvent(activity, now);
        if (event) this.emit('trade', event);
      }
    }, this.opts.pollIntervalMs);
  }

  private stopPolling(): void {
    if (this.pollIntervalId) {
      clearInterval(this.pollIntervalId);
      this.pollIntervalId = null;
    }
  }

  private async pollAll(): Promise<Activity[]> {
    if (this.watchedAddresses.size === 0) return [];

    const now = Math.floor(Date.now() / 1000);
    const start = this.lastCheckTimestamp;

    const results = await Promise.all(
      Array.from(this.watchedAddresses).map(async (wallet) => {
        try {
          return await this.dataApi.getActivity(wallet, {
            type: 'TRADE',
            start,
            limit: 100,
            sortBy: 'TIMESTAMP',
            sortDirection: 'DESC',
          });
        } catch {
          return [];
        }
      })
    );

    const OVERLAP_SECONDS = 10;
    this.lastCheckTimestamp = Math.max(start, now - OVERLAP_SECONDS);

    return results.flat().sort((a, b) => b.timestamp - a.timestamp);
  }

  private activityToTradeEvent(activity: Activity, detectedAt: number): TradeEvent | null {
    const address = activity.proxyWallet?.toLowerCase();
    if (!address) return null;

    return {
      address,
      conditionId: activity.conditionId,
      outcome: activity.outcome,
      tokenId: activity.asset ?? '',
      side: activity.side,
      size: activity.size,
      price: activity.price,
      // Activity.timestamp is already normalized to Unix ms by DataApiClient.normalizeTimestamp().
      // Do NOT multiply by 1000 again — that would produce year ~58197.
      timestamp: typeof activity.timestamp === 'number' ? activity.timestamp : detectedAt,
      source: 'polling',
      detectedAt,
      marketSlug: (activity as any).marketSlug,
      transactionHash: activity.transactionHash ?? undefined,
    };
  }

  // ============================================================================
  // Mempool
  // ============================================================================

  private startMempool(): void {
    const url = this.opts.mempoolWssUrl;
    if (!url) {
      log.warn('[TradeMonitor] Mempool WSS URL not configured, skipping');
      return;
    }
    if (this.mempoolWs) return;

    const ws = new WebSocket(url);
    this.mempoolWs = ws;

    ws.on('open', () => {
      ws.send(JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_subscribe',
        params: ['newPendingTransactions', true],
      }));
    });

    ws.on('message', (data: Buffer) => {
      this.handleMempoolMessage(data);
    });

    ws.on('error', (err: Error) => {
      log.warn('[TradeMonitor] Mempool WSS error:', { message: err.message });
    });

    ws.on('close', () => {
      log.warn('[TradeMonitor] Mempool WSS closed');
      this.mempoolWs = null;
    });
  }

  private stopMempool(): void {
    if (this.mempoolWs) {
      this.mempoolWs.close();
      this.mempoolWs = null;
    }
  }

  private handleMempoolMessage(data: Buffer): void {
    const t0 = Date.now();
    try {
      const msg = JSON.parse(data.toString());
      if (msg.id === 1 && msg.result) return; // subscription confirmation

      if (!msg.params?.result) return;
      const tx = msg.params.result;
      this.mempoolMsgCount++;

      if (t0 - this.mempoolLastStatLog > 60_000) {
        log.debug('[TradeMonitor] Mempool stats', {
          totalMsgs: this.mempoolMsgCount,
          targets: this.mempoolTargets.size,
        });
        this.mempoolLastStatLog = t0;
      }

      if (typeof tx === 'string') return;
      // Plan 11 §6 — accept BOTH V1 routers (legacy mempool tail) and V2
      // exchanges (post-cutover). Calldata decode below is V2-aware too.
      if (!tx.to || !SETTLEMENT_RECIPIENTS.has(tx.to.toLowerCase())) return;
      if (!tx.input || !hasMatchOrdersSelector(tx.input)) return;

      const decoded = decodeMatchOrdersCalldata(tx.input);
      if (!decoded) return;

      const traders = extractTraderAddresses(decoded);
      const targetTrader = traders.find((a: string) => this.mempoolTargets.has(a));
      if (!targetTrader) return;

      if (tx.hash && this.seenTxHashes.has(tx.hash)) return;
      if (tx.hash) {
        this.seenTxHashes.add(tx.hash);
        if (this.seenTxHashes.size > 1000) {
          const toRemove = Array.from(this.seenTxHashes).slice(0, 500);
          toRemove.forEach(h => this.seenTxHashes.delete(h));
        }
      }

      let targetOrder = decoded.takerOrder;
      if (decoded.takerOrder.maker !== targetTrader && decoded.takerOrder.signer !== targetTrader) {
        const makerOrder = decoded.makerOrders.find(
          (o: any) => o.maker === targetTrader || o.signer === targetTrader,
        );
        if (makerOrder) targetOrder = makerOrder;
      }

      const makerAmt = Number(targetOrder.makerAmount) / 1e6;
      const takerAmt = Number(targetOrder.takerAmount) / 1e6;
      let price: number;
      let size: number;

      if (targetOrder.side === OrderSide.BUY) {
        price = makerAmt / takerAmt;
        size = takerAmt;
      } else {
        price = takerAmt / makerAmt;
        size = makerAmt;
      }

      const event: TradeEvent = {
        address: targetTrader,
        tokenId: targetOrder.tokenId,
        side: targetOrder.side === OrderSide.BUY ? 'BUY' : 'SELL',
        size,
        price,
        // Mempool: trade not yet confirmed — use detection time as best approximation
        timestamp: t0,
        source: 'mempool',
        detectedAt: t0,
      };

      this.emit('trade', event);
    } catch {
      // Ignore parse errors
    }
  }
}
