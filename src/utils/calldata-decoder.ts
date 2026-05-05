/**
 * Polymarket settlement TX calldata decoder.
 *
 * Decodes `matchOrders` calldata from pending/mined TXs to extract
 * maker/taker addresses, token IDs, and order details.
 *
 * Two distinct ABIs are supported:
 *
 *   V1 (pre-2026-04-28 cutover): the V1 CTF Exchange + V1 NegRisk CTF
 *   Exchange were proxied through a `FeeModule` (CTF Router /
 *   NegRisk Router). The FeeModule's `matchOrders` selector is `0x2287e350`
 *   and its 13-field Order tuple includes `taker`, `nonce`, `feeRateBps`.
 *
 *   V2 (post-2026-04-28 cutover): V2 CTF Exchange (`0xE111...`) and V2
 *   NegRisk CTF Exchange (`0xe2222d...`) expose `matchOrders` directly with
 *   selector `0x3c2b4399`. The 12-field SignedOrder tuple drops `taker` /
 *   `nonce` / `feeRateBps` and adds `timestamp` (ms) / `metadata` (bytes32)
 *   / `builder` (bytes32). Verified via on-chain selector probe + 4byte
 *   directory + Polymarket V2 SDK source (`ExchangeOrderBuilderV2`).
 *
 * Default behaviour of {@link decodeMatchOrdersCalldata} is V2-first with
 * automatic fallback to V1 — relevant for any caller still scanning
 * pre-cutover historical settlement TXs (for retrospective copy-trading
 * analytics, the V1 calldata never disappears from the chain).
 *
 * @see https://github.com/Polymarket/exchange-fee-module (V1 source)
 * @see ../constants/v2-contracts.ts (V2 contract SSOT)
 */

import { ethers } from 'ethers';

// ============================================================
// Constants
// ============================================================

/**
 * V1 CTF Router (FeeModule) — V1-era operators sent settlement TXs here.
 *
 * @deprecated Retained for historical-calldata decoding only. V2 settlement
 * goes directly to the V2 CTF Exchange (`POLYGON_CONTRACTS_V2.ctfExchange`).
 */
export const CTF_ROUTER = '0xE3f18aCc55091e2c48d883fc8C8413319d4Ab7b0';

/**
 * V1 NegRisk Router (FeeModule).
 *
 * @deprecated Same caveat as `CTF_ROUTER`.
 */
export const NEG_RISK_ROUTER = '0xB768891e3130F6dF18214Ac804d4DB76c2C37730';

/** V1 FeeModule `matchOrders` selector — both V1 routers share this. */
export const MATCH_ORDERS_SELECTOR_V1 = '0x2287e350';

/**
 * V2 CTF Exchange `matchOrders` selector.
 *
 * Verified via:
 *   - On-chain bytecode probe of `0xE111180000d2663C0091e4f400237545B87B996B`
 *   - 4byte / openchain.xyz signature lookup
 *   - V2 SDK `ExchangeOrderBuilderV2` order struct (matches the tuple shape)
 */
export const MATCH_ORDERS_SELECTOR_V2 = '0x3c2b4399';

/**
 * @deprecated Backward-compat alias for `MATCH_ORDERS_SELECTOR_V1`. Existing
 * callers (smart-money copy-trading) hard-code this constant; keeping the
 * alias prevents an API break while V2 fixtures are integrated.
 */
export const MATCH_ORDERS_SELECTOR = MATCH_ORDERS_SELECTOR_V1;

/**
 * Set of router addresses (lowercase) for quick lookup.
 *
 * V1 routers ONLY — V2 settlement is direct-to-exchange (no router proxy).
 * Use {@link isSettlementTx} for a router-aware check that includes V2
 * exchange addresses.
 */
export const ROUTER_ADDRESSES = new Set([
  CTF_ROUTER.toLowerCase(),
  NEG_RISK_ROUTER.toLowerCase(),
]);

// ============================================================
// ABIs
// ============================================================

/**
 * V1 Order struct tuple (13 fields per CTF Exchange + FeeModule wrapper).
 *
 * Order: salt, maker, signer, taker, tokenId, makerAmount, takerAmount,
 *        expiration, nonce, feeRateBps, side(uint8), signatureType(uint8),
 *        signature(bytes).
 */
const ORDER_TUPLE_V1 =
  'tuple(uint256 salt, address maker, address signer, address taker, uint256 tokenId, uint256 makerAmount, uint256 takerAmount, uint256 expiration, uint256 nonce, uint256 feeRateBps, uint8 side, uint8 signatureType, bytes signature)';

/**
 * V1 FeeModule matchOrders ABI (7 params after FeeModule wrapping).
 *
 * Selector: `0x2287e350` (verified).
 */
const MATCH_ORDERS_IFACE_V1 = new ethers.utils.Interface([
  `function matchOrders(
    ${ORDER_TUPLE_V1} takerOrder,
    ${ORDER_TUPLE_V1}[] makerOrders,
    uint256 takerFillAmount,
    uint256 makerFillAmount,
    uint256[] makerFillAmounts,
    uint256 takerFeeAmount,
    uint256[] makerFeeAmounts
  )`,
]);

/**
 * V2 Order struct tuple (12 fields).
 *
 * Order: salt, maker, signer, tokenId, makerAmount, takerAmount,
 *        side(uint8), signatureType(uint8), timestamp, metadata(bytes32),
 *        builder(bytes32), signature(bytes).
 *
 * Differences from V1:
 *   - REMOVED: `taker`, `expiration`, `nonce`, `feeRateBps`
 *   - ADDED:   `timestamp` (uint256, ms), `metadata` (bytes32),
 *              `builder` (bytes32 — for builder attribution)
 */
const ORDER_TUPLE_V2 =
  'tuple(uint256 salt, address maker, address signer, uint256 tokenId, uint256 makerAmount, uint256 takerAmount, uint8 side, uint8 signatureType, uint256 timestamp, bytes32 metadata, bytes32 builder, bytes signature)';

/**
 * V2 CTF Exchange matchOrders ABI (7 params, taker direct on exchange).
 *
 * The leading `bytes32` is opaque to this decoder (likely a feature/preimage
 * hash carried for refund accounting; not needed for trader attribution).
 *
 * Selector: `0x3c2b4399` (verified via 4byte + openchain).
 */
const MATCH_ORDERS_IFACE_V2 = new ethers.utils.Interface([
  `function matchOrders(
    bytes32 contextHash,
    ${ORDER_TUPLE_V2} takerOrder,
    ${ORDER_TUPLE_V2}[] makerOrders,
    uint256 takerFillAmount,
    uint256[] makerFillAmounts,
    uint256 takerFeeAmount,
    uint256[] makerFeeAmounts
  )`,
]);

// ============================================================
// Types
// ============================================================

/** Side enum matching CTF Exchange contract */
export enum OrderSide {
  BUY = 0,
  SELL = 1,
}

/**
 * Decoded order info — common subset across V1 / V2.
 *
 * V1-only fields (`taker`) are surfaced as best-effort: V2 orders never carry
 * a taker on-chain (any-taker is the only V2 model), so V2 decodes set it to
 * the zero address.
 */
export interface DecodedOrder {
  maker: string;
  signer: string;
  /** V1: explicit taker; V2: always zero address (`0x000…000`). */
  taker: string;
  tokenId: string;
  makerAmount: string;
  takerAmount: string;
  side: OrderSide;
}

/** V2 adds `timestamp` (ms), `metadata`, `builder` fields. */
export interface DecodedOrderV2 extends DecodedOrder {
  /** Order timestamp in ms (V2-only; replaces V1 nonce as uniqueness). */
  timestamp: string;
  /** Application-defined metadata bytes32 (V2-only). */
  metadata: string;
  /** Builder code (bytes32) attributing this order to a builder (V2-only). */
  builder: string;
}

/** Result of decoding matchOrders calldata (V1 or V2 — discriminated). */
export interface DecodedMatchOrders {
  /** Calldata version detected — 1 = V1 FeeModule, 2 = V2 direct exchange. */
  version: 1 | 2;
  /** The taker (active) order */
  takerOrder: DecodedOrder | DecodedOrderV2;
  /** All maker (passive) orders */
  makerOrders: Array<DecodedOrder | DecodedOrderV2>;
  takerFillAmount: string;
  makerFillAmounts: string[];
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

// ============================================================
// Decoder
// ============================================================

function decodeOrderV1(raw: any): DecodedOrder {
  return {
    maker: raw.maker.toLowerCase(),
    signer: raw.signer.toLowerCase(),
    taker: raw.taker.toLowerCase(),
    tokenId: raw.tokenId.toString(),
    makerAmount: raw.makerAmount.toString(),
    takerAmount: raw.takerAmount.toString(),
    side: Number(raw.side) as OrderSide,
  };
}

function decodeOrderV2(raw: any): DecodedOrderV2 {
  return {
    maker: raw.maker.toLowerCase(),
    signer: raw.signer.toLowerCase(),
    // V2 has no on-chain taker — surface zero address for symmetry
    taker: ZERO_ADDRESS,
    tokenId: raw.tokenId.toString(),
    makerAmount: raw.makerAmount.toString(),
    takerAmount: raw.takerAmount.toString(),
    side: Number(raw.side) as OrderSide,
    timestamp: raw.timestamp.toString(),
    metadata: raw.metadata,
    builder: raw.builder,
  };
}

/**
 * V1-only decoder. Returns null if data doesn't start with the V1 selector
 * or decoding fails.
 *
 * Use this when you know the calldata is V1 (e.g. historical replay /
 * pre-cutover backfill). For unknown calldata, prefer
 * {@link decodeMatchOrdersCalldata} which auto-detects.
 */
export function decodeMatchOrdersCalldataV1(
  data: string
): DecodedMatchOrders | null {
  try {
    if (!data.startsWith(MATCH_ORDERS_SELECTOR_V1)) return null;
    const decoded = MATCH_ORDERS_IFACE_V1.decodeFunctionData(
      'matchOrders',
      data
    );
    return {
      version: 1,
      takerOrder: decodeOrderV1(decoded.takerOrder),
      makerOrders: decoded.makerOrders.map(decodeOrderV1),
      takerFillAmount: decoded.takerFillAmount.toString(),
      makerFillAmounts: decoded.makerFillAmounts.map((a: any) => a.toString()),
    };
  } catch {
    return null;
  }
}

/**
 * V2-only decoder. Returns null if data doesn't start with the V2 selector
 * or decoding fails.
 */
export function decodeMatchOrdersCalldataV2(
  data: string
): DecodedMatchOrders | null {
  try {
    if (!data.startsWith(MATCH_ORDERS_SELECTOR_V2)) return null;
    const decoded = MATCH_ORDERS_IFACE_V2.decodeFunctionData(
      'matchOrders',
      data
    );
    return {
      version: 2,
      takerOrder: decodeOrderV2(decoded.takerOrder),
      makerOrders: decoded.makerOrders.map(decodeOrderV2),
      takerFillAmount: decoded.takerFillAmount.toString(),
      makerFillAmounts: decoded.makerFillAmounts.map((a: any) => a.toString()),
    };
  } catch {
    return null;
  }
}

/**
 * Decode matchOrders calldata from a settlement TX — V2-first with V1
 * fallback.
 *
 * Returns null if the data is neither a V2 nor V1 matchOrders calldata.
 *
 * Selection rule:
 *   1. If the leading 4 bytes match `MATCH_ORDERS_SELECTOR_V2`, decode V2.
 *   2. Else if they match `MATCH_ORDERS_SELECTOR_V1`, decode V1.
 *   3. Else null.
 *
 * V2 decode failures do NOT silently fall through to V1 (selectors are
 * exhaustive — if the V2 selector matches but the body is malformed, that's
 * a bug, not a V1 calldata).
 */
export function decodeMatchOrdersCalldata(
  data: string
): DecodedMatchOrders | null {
  if (data.startsWith(MATCH_ORDERS_SELECTOR_V2)) {
    return decodeMatchOrdersCalldataV2(data);
  }
  if (data.startsWith(MATCH_ORDERS_SELECTOR_V1)) {
    return decodeMatchOrdersCalldataV1(data);
  }
  return null;
}

/**
 * Check if a TX is a settlement TX (sent to a V1 Router contract).
 *
 * NOTE: V2 settlement bypasses any router and goes direct to the V2 CTF
 * Exchange / NegRisk CTF Exchange. To detect V2 settlement, check the `to`
 * address against `POLYGON_CONTRACTS_V2.ctfExchange` /
 * `POLYGON_CONTRACTS_V2.negRiskExchange` (or simply attempt
 * {@link decodeMatchOrdersCalldata} on the calldata, which works for both
 * versions).
 */
export function isSettlementTx(to: string | null | undefined): boolean {
  return !!to && ROUTER_ADDRESSES.has(to.toLowerCase());
}

/**
 * Extract all unique trader addresses from decoded matchOrders calldata.
 * Returns lowercase addresses.
 */
export function extractTraderAddresses(decoded: DecodedMatchOrders): string[] {
  const addresses = new Set<string>();
  addresses.add(decoded.takerOrder.maker);
  if (decoded.takerOrder.signer !== decoded.takerOrder.maker) {
    addresses.add(decoded.takerOrder.signer);
  }
  for (const order of decoded.makerOrders) {
    addresses.add(order.maker);
    if (order.signer !== order.maker) {
      addresses.add(order.signer);
    }
  }
  return Array.from(addresses);
}
