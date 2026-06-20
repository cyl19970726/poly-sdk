/**
 * Plan 11 §6 — Smart-money mempool filter accepts V1 routers AND V2 exchanges.
 *
 * `TradeMonitor` (poly-sdk smart-money) filters mempool TXs by:
 *   1. `tx.to` ∈ allowed settlement recipients
 *   2. `tx.input` starts with a known matchOrders selector
 *
 * V1 (pre-2026-04-28): tx.to = CTF Router / NegRisk Router, selector = 0x2287e350
 * V2 (post-2026-04-28): tx.to = V2 CTF Exchange / NegRisk Exchange, selector = 0x3c2b4399
 *
 * This test exercises the filter end-to-end via `handleMempoolMessage` (private)
 * by spinning a TradeMonitor without a real WS, watching a target trader, and
 * pushing fabricated V1 + V2 mempool payloads. It verifies the monitor emits
 * a `trade` event for the target trader on BOTH calldata versions and ignores
 * non-settlement TXs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ethers } from 'ethers';

import { TradeMonitor } from '../../smart-money/monitor.js';
import type { DataApiClient } from '../../clients/data-api.js';
import {
  CTF_ROUTER,
  MATCH_ORDERS_SELECTOR_V1,
  MATCH_ORDERS_SELECTOR_V2,
} from '../../utils/calldata-decoder.js';
import { POLYGON_CONTRACTS_V2 } from '../../constants/v2-contracts.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TARGET_TRADER = '0x000000000000000000000000000000000000aaaa';
const COUNTERPARTY = '0x000000000000000000000000000000000000bbbb';
const V2_TARGET_TRADER = '0x000000000000000000000000000000000000cccc';
const V2_COUNTERPARTY = '0x000000000000000000000000000000000000dddd';

const V1_TUPLE =
  'tuple(uint256 salt, address maker, address signer, address taker, uint256 tokenId, uint256 makerAmount, uint256 takerAmount, uint256 expiration, uint256 nonce, uint256 feeRateBps, uint8 side, uint8 signatureType, bytes signature)';

const V1_IFACE = new ethers.utils.Interface([
  `function matchOrders(${V1_TUPLE} takerOrder, ${V1_TUPLE}[] makerOrders, uint256 takerFillAmount, uint256 makerFillAmount, uint256[] makerFillAmounts, uint256 takerFeeAmount, uint256[] makerFeeAmounts)`,
]);

const V2_TUPLE =
  'tuple(uint256 salt, address maker, address signer, uint256 tokenId, uint256 makerAmount, uint256 takerAmount, uint8 side, uint8 signatureType, uint256 timestamp, bytes32 metadata, bytes32 builder, bytes signature)';

const V2_IFACE = new ethers.utils.Interface([
  `function matchOrders(bytes32 contextHash, ${V2_TUPLE} takerOrder, ${V2_TUPLE}[] makerOrders, uint256 takerFillAmount, uint256[] makerFillAmounts, uint256 takerFeeAmount, uint256[] makerFeeAmounts)`,
]);

function buildV1Calldata(): string {
  const taker = {
    salt: 1n,
    maker: TARGET_TRADER,
    signer: TARGET_TRADER,
    taker: '0x0000000000000000000000000000000000000000',
    tokenId: 12345n,
    makerAmount: 1_000_000n, // 1 USDC
    takerAmount: 2_000_000n, // 2 shares
    expiration: 0n,
    nonce: 0n,
    feeRateBps: 100n,
    side: 0, // BUY
    signatureType: 0,
    signature: '0x',
  };
  const maker = { ...taker, maker: COUNTERPARTY, signer: COUNTERPARTY, side: 1 };
  return V1_IFACE.encodeFunctionData('matchOrders', [
    taker,
    [maker],
    1_000_000n,
    2_000_000n,
    [1_000_000n],
    0n,
    [0n],
  ]);
}

function buildV2Calldata(): string {
  const taker = {
    salt: 99n,
    maker: V2_TARGET_TRADER,
    signer: V2_TARGET_TRADER,
    tokenId: 7777n,
    makerAmount: 5_000_000n,
    takerAmount: 8_000_000n,
    side: 0, // BUY
    signatureType: 2,
    timestamp: 1714435200000n,
    metadata: '0x' + '11'.repeat(32),
    builder: '0x' + '22'.repeat(32),
    signature: '0xabcd',
  };
  const maker = {
    ...taker,
    maker: V2_COUNTERPARTY,
    signer: V2_COUNTERPARTY,
    side: 1,
  };
  return V2_IFACE.encodeFunctionData('matchOrders', [
    '0x' + 'ff'.repeat(32),
    taker,
    [maker],
    5_000_000n,
    [5_000_000n],
    0n,
    [0n],
  ]);
}

function makeMempoolMessage(tx: {
  to: string;
  input: string;
  hash?: string;
}): Buffer {
  return Buffer.from(
    JSON.stringify({
      params: {
        result: {
          to: tx.to,
          input: tx.input,
          hash: tx.hash ?? `0x${'a'.repeat(64)}`,
        },
      },
    }),
  );
}

// Minimal DataApiClient stub — TradeMonitor doesn't poll in these tests.
const stubDataApi = {
  getActivity: vi.fn(),
} as unknown as DataApiClient;

describe('Plan 11 §6 — TradeMonitor V1 + V2 settlement filter', () => {
  let monitor: TradeMonitor;

  beforeEach(() => {
    monitor = new TradeMonitor(stubDataApi);
  });

  it('emits trade for V2 calldata sent to V2 CTF Exchange', () => {
    const trades: any[] = [];
    monitor.on('trade', (e) => trades.push(e));
    monitor.watch([V2_TARGET_TRADER], 'mempool');

    const msg = makeMempoolMessage({
      to: POLYGON_CONTRACTS_V2.ctfExchange,
      input: buildV2Calldata(),
    });

    (monitor as any).handleMempoolMessage(msg);

    expect(trades).toHaveLength(1);
    expect(trades[0].address).toBe(V2_TARGET_TRADER);
    expect(trades[0].source).toBe('mempool');

    monitor.stop();
  });

  it('emits trade for V2 calldata sent to V2 NegRisk Exchange', () => {
    const trades: any[] = [];
    monitor.on('trade', (e) => trades.push(e));
    monitor.watch([V2_TARGET_TRADER], 'mempool');

    const msg = makeMempoolMessage({
      to: POLYGON_CONTRACTS_V2.negRiskExchange,
      input: buildV2Calldata(),
    });

    (monitor as any).handleMempoolMessage(msg);

    expect(trades).toHaveLength(1);
    expect(trades[0].address).toBe(V2_TARGET_TRADER);

    monitor.stop();
  });

  it('still decodes legacy V1 calldata sent to V1 CTF Router', () => {
    const trades: any[] = [];
    monitor.on('trade', (e) => trades.push(e));
    monitor.watch([TARGET_TRADER], 'mempool');

    const msg = makeMempoolMessage({
      to: CTF_ROUTER,
      input: buildV1Calldata(),
    });

    (monitor as any).handleMempoolMessage(msg);

    expect(trades).toHaveLength(1);
    expect(trades[0].address).toBe(TARGET_TRADER);

    monitor.stop();
  });

  it('skips TX sent to a non-settlement recipient (random EOA)', () => {
    const trades: any[] = [];
    monitor.on('trade', (e) => trades.push(e));
    monitor.watch([V2_TARGET_TRADER], 'mempool');

    const msg = makeMempoolMessage({
      to: '0x1234567890123456789012345678901234567890',
      input: buildV2Calldata(),
    });

    (monitor as any).handleMempoolMessage(msg);

    expect(trades).toHaveLength(0);

    monitor.stop();
  });

  it('skips TX with non-matchOrders calldata sent to V2 exchange', () => {
    const trades: any[] = [];
    monitor.on('trade', (e) => trades.push(e));
    monitor.watch([V2_TARGET_TRADER], 'mempool');

    const msg = makeMempoolMessage({
      to: POLYGON_CONTRACTS_V2.ctfExchange,
      input: '0xdeadbeef' + '00'.repeat(32), // unknown selector
    });

    (monitor as any).handleMempoolMessage(msg);

    expect(trades).toHaveLength(0);

    monitor.stop();
  });

  it('selectors are the documented V1/V2 values', () => {
    // Sanity that we wired the right constants into the monitor.
    expect(MATCH_ORDERS_SELECTOR_V1).toBe('0x2287e350');
    expect(MATCH_ORDERS_SELECTOR_V2).toBe('0x3c2b4399');
    expect(buildV1Calldata().slice(0, 10)).toBe(MATCH_ORDERS_SELECTOR_V1);
    expect(buildV2Calldata().slice(0, 10)).toBe(MATCH_ORDERS_SELECTOR_V2);
  });
});
