/**
 * Unit tests for V1 / V2 matchOrders calldata decoder.
 *
 * Stage C of the Polymarket V2 migration teaches the decoder about the V2
 * direct-on-exchange `matchOrders` ABI (selector `0x3c2b4399`, 12-field
 * SignedOrder tuple) while keeping the V1 FeeModule path
 * (selector `0x2287e350`, 13-field tuple) for historical-replay scenarios.
 *
 * Behavioural contract:
 *   - V1 calldata → `decodeMatchOrdersCalldata*` returns `version: 1` with
 *     V1 fields populated (taker is the on-chain value).
 *   - V2 calldata → returns `version: 2` with V2 fields populated
 *     (timestamp / metadata / builder), taker forced to zero address.
 *   - Unknown selector / malformed calldata → null (no exception).
 *   - V1-only and V2-only entry points return null when the calldata
 *     belongs to the other version.
 *
 * Fixtures are constructed in-test so the test stays self-contained and
 * tracks any future ABI tweaks.
 */

import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';

import {
  decodeMatchOrdersCalldata,
  decodeMatchOrdersCalldataV1,
  decodeMatchOrdersCalldataV2,
  MATCH_ORDERS_SELECTOR_V1,
  MATCH_ORDERS_SELECTOR_V2,
  OrderSide,
} from '../../utils/calldata-decoder.js';

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

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

// Lower-case addresses for fixtures so we can compare directly.
const TAKER_MAKER_V1 = '0x000000000000000000000000000000000000aaaa';
const MAKER_MAKER_V1 = '0x000000000000000000000000000000000000bbbb';
const TAKER_MAKER_V2 = '0x000000000000000000000000000000000000cccc';
const MAKER_MAKER_V2 = '0x000000000000000000000000000000000000dddd';

const METADATA_HEX = '0x' + '11'.repeat(32);
const BUILDER_HEX = '0x' + '22'.repeat(32);

function buildV1Calldata(): string {
  const taker = {
    salt: 1n,
    maker: TAKER_MAKER_V1,
    signer: TAKER_MAKER_V1,
    taker: '0x0000000000000000000000000000000000000000',
    tokenId: 12345n,
    makerAmount: 1_000_000n,
    takerAmount: 2_000_000n,
    expiration: 0n,
    nonce: 0n,
    feeRateBps: 100n,
    side: 0,
    signatureType: 0,
    signature: '0x',
  };
  const maker = {
    ...taker,
    maker: MAKER_MAKER_V1,
    signer: MAKER_MAKER_V1,
    side: 1,
  };
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
    maker: TAKER_MAKER_V2,
    signer: TAKER_MAKER_V2,
    tokenId: 7777n,
    makerAmount: 5_000_000n,
    takerAmount: 8_000_000n,
    side: 0,
    signatureType: 2,
    timestamp: 1714435200000n,
    metadata: METADATA_HEX,
    builder: BUILDER_HEX,
    signature: '0xabcd',
  };
  const maker = {
    ...taker,
    maker: MAKER_MAKER_V2,
    signer: MAKER_MAKER_V2,
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('calldata-decoder selectors', () => {
  it('V1 selector is 0x2287e350', () => {
    expect(MATCH_ORDERS_SELECTOR_V1).toBe('0x2287e350');
  });

  it('V2 selector is 0x3c2b4399', () => {
    expect(MATCH_ORDERS_SELECTOR_V2).toBe('0x3c2b4399');
  });

  it('V1 fixture starts with the V1 selector', () => {
    expect(buildV1Calldata().slice(0, 10)).toBe(MATCH_ORDERS_SELECTOR_V1);
  });

  it('V2 fixture starts with the V2 selector', () => {
    expect(buildV2Calldata().slice(0, 10)).toBe(MATCH_ORDERS_SELECTOR_V2);
  });
});

describe('decodeMatchOrdersCalldataV1', () => {
  it('decodes V1 fixture into V1 fields', () => {
    const decoded = decodeMatchOrdersCalldataV1(buildV1Calldata());
    expect(decoded).not.toBeNull();
    expect(decoded!.version).toBe(1);
    expect(decoded!.takerOrder.maker).toBe(TAKER_MAKER_V1);
    expect(decoded!.takerOrder.signer).toBe(TAKER_MAKER_V1);
    expect(decoded!.takerOrder.taker).toBe(
      '0x0000000000000000000000000000000000000000'
    );
    expect(decoded!.takerOrder.tokenId).toBe('12345');
    expect(decoded!.takerOrder.makerAmount).toBe('1000000');
    expect(decoded!.takerOrder.takerAmount).toBe('2000000');
    expect(decoded!.takerOrder.side).toBe(OrderSide.BUY);

    expect(decoded!.makerOrders).toHaveLength(1);
    expect(decoded!.makerOrders[0].maker).toBe(MAKER_MAKER_V1);
    expect(decoded!.makerOrders[0].side).toBe(OrderSide.SELL);

    expect(decoded!.takerFillAmount).toBe('1000000');
    expect(decoded!.makerFillAmounts).toEqual(['1000000']);
  });

  it('returns null for V2 calldata (cross-version isolation)', () => {
    const decoded = decodeMatchOrdersCalldataV1(buildV2Calldata());
    expect(decoded).toBeNull();
  });

  it('returns null for unknown selector', () => {
    expect(decodeMatchOrdersCalldataV1('0xdeadbeef')).toBeNull();
  });

  it('returns null for malformed body', () => {
    expect(
      decodeMatchOrdersCalldataV1(MATCH_ORDERS_SELECTOR_V1 + 'aabbcc')
    ).toBeNull();
  });
});

describe('decodeMatchOrdersCalldataV2', () => {
  it('decodes V2 fixture into V2 fields with timestamp/metadata/builder', () => {
    const decoded = decodeMatchOrdersCalldataV2(buildV2Calldata());
    expect(decoded).not.toBeNull();
    expect(decoded!.version).toBe(2);

    const taker = decoded!.takerOrder as any;
    expect(taker.maker).toBe(TAKER_MAKER_V2);
    expect(taker.signer).toBe(TAKER_MAKER_V2);
    expect(taker.tokenId).toBe('7777');
    expect(taker.makerAmount).toBe('5000000');
    expect(taker.takerAmount).toBe('8000000');
    expect(taker.side).toBe(OrderSide.BUY);
    expect(taker.timestamp).toBe('1714435200000');
    expect(taker.metadata).toBe(METADATA_HEX);
    expect(taker.builder).toBe(BUILDER_HEX);
    // V2 has no on-chain taker — decoder forces zero address
    expect(taker.taker).toBe('0x0000000000000000000000000000000000000000');

    expect(decoded!.makerOrders).toHaveLength(1);
    expect(decoded!.makerOrders[0].maker).toBe(MAKER_MAKER_V2);
    expect(decoded!.makerOrders[0].side).toBe(OrderSide.SELL);

    expect(decoded!.takerFillAmount).toBe('5000000');
    expect(decoded!.makerFillAmounts).toEqual(['5000000']);
  });

  it('returns null for V1 calldata (cross-version isolation)', () => {
    const decoded = decodeMatchOrdersCalldataV2(buildV1Calldata());
    expect(decoded).toBeNull();
  });

  it('returns null for unknown selector', () => {
    expect(decodeMatchOrdersCalldataV2('0xcafebabe')).toBeNull();
  });
});

describe('decodeMatchOrdersCalldata (auto-detect)', () => {
  it('routes V2 calldata to the V2 decoder', () => {
    const decoded = decodeMatchOrdersCalldata(buildV2Calldata());
    expect(decoded).not.toBeNull();
    expect(decoded!.version).toBe(2);
    expect((decoded!.takerOrder as any).timestamp).toBe('1714435200000');
  });

  it('falls back to V1 decoder for V1 calldata', () => {
    const decoded = decodeMatchOrdersCalldata(buildV1Calldata());
    expect(decoded).not.toBeNull();
    expect(decoded!.version).toBe(1);
    expect(decoded!.takerOrder.taker).toBe(
      '0x0000000000000000000000000000000000000000'
    );
  });

  it('returns null for unknown calldata without throwing', () => {
    expect(decodeMatchOrdersCalldata('0xdeadbeef')).toBeNull();
    expect(decodeMatchOrdersCalldata('0x' + 'ab'.repeat(100))).toBeNull();
  });

  it('does NOT silently accept V1 fixture as V2 (selector check is strict)', () => {
    // V1 calldata has the V1 selector; auto-detect must NOT misdetect as V2
    const decoded = decodeMatchOrdersCalldata(buildV1Calldata());
    expect(decoded!.version).toBe(1);
    expect((decoded!.takerOrder as any).timestamp).toBeUndefined();
  });

  it('handles V2 decode failure gracefully (selector match + bad body → null)', () => {
    const corrupt = MATCH_ORDERS_SELECTOR_V2 + 'aabb';
    expect(decodeMatchOrdersCalldata(corrupt)).toBeNull();
  });
});
