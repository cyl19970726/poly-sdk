import { EventEmitter } from 'events';
import WebSocket from 'isomorphic-ws';
import type {
  CatalystWsClientMessage,
  CatalystWsServerMessage,
  CatalystWsTopic,
  CatalystKlineUpdatePayload,
  CatalystDepthUpdatePayload,
} from './types.js';

export type CatalystRealtimeServiceConfig = {
  url: string; // e.g. ws://localhost:8787/v1/ws
  autoReconnect?: boolean;
  reconnectDelayMs?: number;
  debug?: boolean;
};

export type CatalystRealtimeEvents = {
  connected: [];
  disconnected: [];
  error: [Error];
  kline: [CatalystKlineUpdatePayload & { eventId: string; tsMs: number }];
  depth: [CatalystDepthUpdatePayload & { eventId: string; tsMs: number }];
};

export class CatalystRealtimeService extends EventEmitter {
  private readonly config: Required<CatalystRealtimeServiceConfig>;
  private ws: WebSocket | null = null;
  private connected = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private autoReconnectEnabled = true;

  constructor(config: CatalystRealtimeServiceConfig) {
    super();
    this.config = {
      autoReconnect: true,
      reconnectDelayMs: 1_000,
      debug: false,
      ...config,
    };
    this.autoReconnectEnabled = this.config.autoReconnect;
  }

  connect(): this {
    if (this.ws) return this;

    this.ws = new WebSocket(this.config.url);
    this.ws.onopen = () => {
      this.connected = true;
      this.log('connected');
      this.emit('connected');
    };
    this.ws.onclose = () => {
      this.connected = false;
      this.log('disconnected');
      this.emit('disconnected');
      this.ws = null;
      if (this.autoReconnectEnabled) this.scheduleReconnect();
    };
    this.ws.onerror = () => {
      const err = new Error('CatalystRealtimeService ws error');
      this.emit('error', err);
    };
    this.ws.onmessage = (evt) => {
      this.handleMessage(evt.data);
    };

    return this;
  }

  disconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.autoReconnectEnabled = false;

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  subscribe(topics: CatalystWsTopic[], markets: string[], reqId?: string): void {
    const msg: CatalystWsClientMessage = { type: 'subscribe', topics, markets, reqId };
    this.send(msg);
  }

  unsubscribe(topics?: CatalystWsTopic[], markets?: string[], reqId?: string): void {
    const msg: CatalystWsClientMessage = { type: 'unsubscribe', topics, markets, reqId };
    this.send(msg);
  }

  ping(reqId?: string): void {
    const msg: CatalystWsClientMessage = { type: 'ping', reqId };
    this.send(msg);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.config.reconnectDelayMs);
  }

  private send(msg: CatalystWsClientMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(msg));
  }

  private handleMessage(data: any): void {
    let msg: CatalystWsServerMessage | null = null;
    try {
      let raw: string;
      if (typeof data === 'string') {
        raw = data;
      } else if (typeof (globalThis as any).Buffer !== 'undefined' && data instanceof (globalThis as any).Buffer) {
        raw = data.toString('utf8');
      } else if (typeof ArrayBuffer !== 'undefined' && data instanceof ArrayBuffer) {
        raw = new TextDecoder().decode(new Uint8Array(data));
      } else {
        raw = String(data);
      }
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (!msg || typeof msg !== 'object' || typeof (msg as any).type !== 'string') return;
    if (msg.type !== 'event') return;

    if (msg.topic === 'kline:update') {
      const payload = msg.payload as CatalystKlineUpdatePayload;
      this.emit('kline', { ...payload, eventId: msg.eventId, tsMs: msg.tsMs });
      return;
    }

    if (msg.topic === 'depth:update') {
      const payload = msg.payload as CatalystDepthUpdatePayload;
      this.emit('depth', { ...payload, eventId: msg.eventId, tsMs: msg.tsMs });
      return;
    }
  }

  private log(message: string): void {
    if (this.config.debug) console.log(`[CatalystRealtimeService] ${message}`);
  }
}
