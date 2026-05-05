/**
 * Unit tests for AuthorizationService V2 spender matrix.
 *
 * Stage C of the Polymarket V2 migration switches the approval set:
 *   - 3 pUSD ERC20 approvals (V2 CTF Exchange, V2 NegRisk Exchange,
 *     NegRisk Adapter — all the V2 trading rail).
 *   - 1 USDC.e ERC20 approval to the Collateral Onramp (gateway for
 *     `wrap(USDC.e → pUSD)`).
 *   - 3 ERC1155 operator approvals (the same V2 contracts, minus the
 *     Onramp which never moves CTF tokens).
 *
 * Behavioural contract:
 *   - `checkAllowances()` reports 4 ERC20 rows + 3 ERC1155 rows tagged with
 *     the correct token + V2 address.
 *   - `approveAll()` calls `approve()` on the right ERC20 contract for each
 *     row (pUSD vs USDC.e), then `setApprovalForAll(true)` on Conditional
 *     Tokens for each operator.
 *
 * We mock `ethers.Contract` calls on a per-address basis so no RPC is made.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ethers } from 'ethers';

import { AuthorizationService } from '../../services/authorization-service.js';
import { POLYGON_CONTRACTS_V2 } from '../../constants/v2-contracts.js';

// Stub ethers contracts: we override only the methods our service calls.
// Each method tracks invocations on `calls` so we can assert routing.
interface StubContract {
  address: string;
  // ERC20
  approve?: ReturnType<typeof vi.fn>;
  allowance?: ReturnType<typeof vi.fn>;
  balanceOf?: ReturnType<typeof vi.fn>;
  // ERC1155
  setApprovalForAll?: ReturnType<typeof vi.fn>;
  isApprovedForAll?: ReturnType<typeof vi.fn>;
}

const TX = {
  wait: async () => ({}),
};

// Track all approve/setApprovalForAll calls in the order they're submitted.
type ApproveCall = { token: string; spender: string; amount: string };
type ErcOpCall = { token: string; operator: string; approved: boolean };

let approveCalls: ApproveCall[];
let ercOpCalls: ErcOpCall[];

beforeEach(() => {
  approveCalls = [];
  ercOpCalls = [];
});

// Replace ethers.Contract with a per-address router stub.
const realContract = ethers.Contract;
beforeEach(() => {
  // Behaviour we want to vary in individual tests
  const allowanceFor = new Map<string, ethers.BigNumber>();
  const isApprovedFor = new Map<string, boolean>();

  // Default: nothing approved, low allowance => approveAll triggers approve()
  // for every spender.
  ;(globalThis as any).__allowanceFor = allowanceFor;
  ;(globalThis as any).__isApprovedFor = isApprovedFor;

  vi.spyOn(ethers, 'Contract').mockImplementation(((
    addr: string,
    _abi: any,
    _signerOrProvider: any
  ) => {
    const tokenLabel =
      addr.toLowerCase() === POLYGON_CONTRACTS_V2.pUSD.toLowerCase()
        ? 'pUSD'
        : addr.toLowerCase() === POLYGON_CONTRACTS_V2.usdcE.toLowerCase()
          ? 'USDC.e'
          : addr.toLowerCase() ===
              '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045'.toLowerCase()
            ? 'CTF'
            : `unknown(${addr})`;

    const stub: StubContract = { address: addr };

    if (tokenLabel === 'pUSD' || tokenLabel === 'USDC.e') {
      stub.balanceOf = vi.fn(async (_who: string) =>
        ethers.utils.parseUnits('100', 6)
      );
      stub.allowance = vi.fn(async (_who: string, spender: string) => {
        const key = `${tokenLabel}:${spender.toLowerCase()}`;
        return allowanceFor.get(key) ?? ethers.BigNumber.from(0);
      });
      stub.approve = vi.fn(async (spender: string, amount: ethers.BigNumber) => {
        approveCalls.push({
          token: tokenLabel,
          spender,
          amount: amount.toString(),
        });
        return { ...TX, hash: '0xapprovetx' };
      });
    }

    if (tokenLabel === 'CTF') {
      stub.isApprovedForAll = vi.fn(async (_who: string, op: string) => {
        return isApprovedFor.get(op.toLowerCase()) ?? false;
      });
      stub.setApprovalForAll = vi.fn(async (op: string, approved: boolean) => {
        ercOpCalls.push({ token: 'CTF', operator: op, approved });
        return { ...TX, hash: '0xerc1155tx' };
      });
    }

    return stub as unknown as ethers.Contract;
  }) as any);
});

function makeService(): AuthorizationService {
  // A wallet that doesn't need to make RPC calls — provider is set to a
  // dummy and we override `getGasPrice()` via spy.
  const provider = {
    getGasPrice: vi.fn(async () => ethers.BigNumber.from('30000000000')),
  } as unknown as ethers.providers.Provider;

  // Build a Wallet without provider (we just need the address).
  const wallet = new ethers.Wallet('0x' + '1'.repeat(64));
  const svc = new AuthorizationService(wallet, { provider });
  return svc;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AuthorizationService V2 spender matrix', () => {
  it('exposes 4 ERC20 rows with correct token tags + V2 addresses', async () => {
    const svc = makeService();
    const result = await svc.checkAllowances();

    expect(result.erc20Allowances).toHaveLength(4);

    const byName = new Map(
      result.erc20Allowances.map((a) => [a.contract, a])
    );
    expect(byName.get('V2 CTF Exchange')).toMatchObject({
      address: POLYGON_CONTRACTS_V2.ctfExchange,
      token: 'pUSD',
      approved: false,
    });
    expect(byName.get('V2 NegRisk CTF Exchange')).toMatchObject({
      address: POLYGON_CONTRACTS_V2.negRiskExchange,
      token: 'pUSD',
      approved: false,
    });
    expect(byName.get('NegRisk Adapter')).toMatchObject({
      address: POLYGON_CONTRACTS_V2.negRiskAdapter,
      token: 'pUSD',
      approved: false,
    });
    expect(byName.get('Onramp (USDC.e wrap)')).toMatchObject({
      address: POLYGON_CONTRACTS_V2.collateralOnramp,
      token: 'USDC.e',
      approved: false,
    });
  });

  it('exposes 3 ERC1155 rows pointing at V2 exchanges + Adapter', async () => {
    const svc = makeService();
    const result = await svc.checkAllowances();

    expect(result.erc1155Approvals).toHaveLength(3);

    const addrs = result.erc1155Approvals.map((r) => r.address);
    expect(addrs).toEqual([
      POLYGON_CONTRACTS_V2.ctfExchange,
      POLYGON_CONTRACTS_V2.negRiskExchange,
      POLYGON_CONTRACTS_V2.negRiskAdapter,
    ]);

    // Onramp does NOT need ERC1155 approval — we never want it to move
    // outcome tokens.
    expect(addrs).not.toContain(POLYGON_CONTRACTS_V2.collateralOnramp);
  });

  it('approveAll() routes pUSD approvals to the pUSD ERC20 + USDC.e to USDC.e', async () => {
    const svc = makeService();
    const result = await svc.approveAll();

    // 4 ERC20 + 3 ERC1155 = 7 total
    expect(result.erc20Approvals).toHaveLength(4);
    expect(result.erc1155Approvals).toHaveLength(3);
    expect(result.allApproved).toBe(true);

    // Ensure each call hit the right ERC20 contract
    const pusdCalls = approveCalls.filter((c) => c.token === 'pUSD');
    const usdceCalls = approveCalls.filter((c) => c.token === 'USDC.e');

    expect(pusdCalls).toHaveLength(3);
    expect(usdceCalls).toHaveLength(1);

    // pUSD should approve V2 Exchange / V2 NegRisk Exchange / NegRisk Adapter
    expect(new Set(pusdCalls.map((c) => c.spender))).toEqual(
      new Set([
        POLYGON_CONTRACTS_V2.ctfExchange,
        POLYGON_CONTRACTS_V2.negRiskExchange,
        POLYGON_CONTRACTS_V2.negRiskAdapter,
      ])
    );

    // USDC.e should approve only the Onramp
    expect(usdceCalls[0].spender).toBe(POLYGON_CONTRACTS_V2.collateralOnramp);
    // unlimited approval (MaxUint256)
    expect(usdceCalls[0].amount).toBe(ethers.constants.MaxUint256.toString());
  });

  it('approveAll() ERC1155 calls hit V2 Exchange + V2 NegRisk + Adapter', async () => {
    const svc = makeService();
    await svc.approveAll();

    expect(ercOpCalls).toHaveLength(3);
    expect(new Set(ercOpCalls.map((c) => c.operator))).toEqual(
      new Set([
        POLYGON_CONTRACTS_V2.ctfExchange,
        POLYGON_CONTRACTS_V2.negRiskExchange,
        POLYGON_CONTRACTS_V2.negRiskAdapter,
      ])
    );
    expect(ercOpCalls.every((c) => c.approved === true)).toBe(true);
  });

  it('checkAllowances() flips to tradingReady=true when all 7 rows approved', async () => {
    // Pre-seed allowances + isApprovedForAll
    const allowanceFor = (globalThis as any).__allowanceFor as Map<
      string,
      ethers.BigNumber
    >;
    const isApprovedFor = (globalThis as any).__isApprovedFor as Map<
      string,
      boolean
    >;
    const HUGE = ethers.utils.parseUnits('1000000000000000', 6); // > 1e12 USDC

    allowanceFor.set(`pUSD:${POLYGON_CONTRACTS_V2.ctfExchange.toLowerCase()}`, HUGE);
    allowanceFor.set(`pUSD:${POLYGON_CONTRACTS_V2.negRiskExchange.toLowerCase()}`, HUGE);
    allowanceFor.set(`pUSD:${POLYGON_CONTRACTS_V2.negRiskAdapter.toLowerCase()}`, HUGE);
    allowanceFor.set(`USDC.e:${POLYGON_CONTRACTS_V2.collateralOnramp.toLowerCase()}`, HUGE);
    isApprovedFor.set(POLYGON_CONTRACTS_V2.ctfExchange.toLowerCase(), true);
    isApprovedFor.set(POLYGON_CONTRACTS_V2.negRiskExchange.toLowerCase(), true);
    isApprovedFor.set(POLYGON_CONTRACTS_V2.negRiskAdapter.toLowerCase(), true);

    const svc = makeService();
    const result = await svc.checkAllowances();
    expect(result.tradingReady).toBe(true);
    expect(result.issues).toHaveLength(0);
    expect(result.erc20Allowances.every((r) => r.approved)).toBe(true);
    expect(result.erc1155Approvals.every((r) => r.approved)).toBe(true);
  });

  it('approveAll() short-circuits already-approved rows (no redundant approve())', async () => {
    const allowanceFor = (globalThis as any).__allowanceFor as Map<
      string,
      ethers.BigNumber
    >;
    const isApprovedFor = (globalThis as any).__isApprovedFor as Map<
      string,
      boolean
    >;
    const HUGE = ethers.utils.parseUnits('1000000000000000', 6);

    // Pre-approve 2 rows; expect approveAll to skip them
    allowanceFor.set(`pUSD:${POLYGON_CONTRACTS_V2.ctfExchange.toLowerCase()}`, HUGE);
    isApprovedFor.set(POLYGON_CONTRACTS_V2.ctfExchange.toLowerCase(), true);

    const svc = makeService();
    await svc.approveAll();

    // 4 ERC20 - 1 already approved = 3 fresh approve() calls
    expect(approveCalls).toHaveLength(3);
    // 3 ERC1155 - 1 already approved = 2 fresh setApprovalForAll calls
    expect(ercOpCalls).toHaveLength(2);
  });

  it('does not import any V1 contract address into the spender list', async () => {
    const svc = makeService();
    const result = await svc.checkAllowances();

    const allAddrs = [
      ...result.erc20Allowances.map((r) => r.address.toLowerCase()),
      ...result.erc1155Approvals.map((r) => r.address.toLowerCase()),
    ];

    // V1 CTF Exchange + V1 NegRisk CTF Exchange addresses
    expect(allAddrs).not.toContain(
      '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E'.toLowerCase()
    );
    expect(allAddrs).not.toContain(
      '0xC5d563A36AE78145C45a50134d48A1215220f80a'.toLowerCase()
    );
  });
});
