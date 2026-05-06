/**
 * Unit tests for V2 Relayer collateral-token routing.
 *
 * After the 2026-04-28 V2 cutover, trading collateral is `pUSD`. The
 * trading-related relayer helpers (`split`, `merge`, `redeem`, `redeemBatch`)
 * hardcode pUSD as the on-chain collateral argument. The off-exchange
 * helpers (`approveUsdc`, `transferUsdc`) accept a `CollateralToken`
 * parameter so they can route to either pUSD (V2 trading collateral, the
 * default) or USDC.e (Onramp approval / fund-out collect path).
 *
 * These tests assert the routing behaviour by capturing the encoded
 * transaction the service emits to a mocked relay client.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ethers, BigNumber } from 'ethers';
import { POLYGON_CONTRACTS_V2 } from '../../constants/v2-contracts.js';
import {
  CTF_CONTRACT,
  NEG_RISK_ADAPTER,
} from '../../clients/ctf-client.js';

// ---------------------------------------------------------------------------
// Module mocks (mirrors v2-relayer-wrap.test.ts pattern)
// ---------------------------------------------------------------------------

let capturedExecute: { txs: any[] } | null = null;

vi.mock('@polymarket/builder-relayer-client', () => {
  class RelayClient {
    contractConfig = {
      SafeContracts: {
        SafeFactory: '0xaacFeEa03eb1561C4e67d661e40682Bd20E3541b',
      },
    };
    constructor(_url: string, _chainId: number, _signer: any, _bc: any) {}
    async getDeployed(_addr: string) {
      return true;
    }
    async deploy() {
      return { wait: async () => ({ state: 'STATE_CONFIRMED', transactionHash: '0x00' }) };
    }
    async execute(transactions: any[]) {
      capturedExecute = { txs: transactions };
      return {
        wait: async () => ({
          state: 'STATE_CONFIRMED',
          transactionHash: '0xroutehash',
        }),
      };
    }
  }
  return { RelayClient };
});

vi.mock('@polymarket/builder-signing-sdk', () => {
  class BuilderConfig {
    constructor(_config: any) {}
  }
  return { BuilderConfig };
});

import { RelayerService } from '../../services/relayer-service.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_PK = '0x' + '1'.repeat(64);
const TEST_SPENDER = '0x' + 'aa'.repeat(20);
const TEST_RECIPIENT = '0x' + 'bb'.repeat(20);
const TEST_CONDITION_ID = '0x' + 'cd'.repeat(32);

function makeService(): RelayerService {
  return new RelayerService({
    builderCreds: { key: 'k', secret: 's', passphrase: 'p' },
    privateKey: TEST_PK,
    chainId: 137,
    rpcUrl: 'http://localhost:0',
  });
}

const ERC20_IFACE = new ethers.utils.Interface([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
]);

const CTF_IFACE = new ethers.utils.Interface([
  'function splitPosition(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount) external',
  'function mergePositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount) external',
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external',
]);

beforeEach(() => {
  capturedExecute = null;
});

// ---------------------------------------------------------------------------
// approveUsdc — token routing (pUSD default + USDC.e for Onramp)
// ---------------------------------------------------------------------------

describe('RelayerService.approveUsdc — token routing', () => {
  it('defaults to pUSD when no token is supplied (V2 trading collateral)', async () => {
    const svc = makeService();
    const r = await svc.approveUsdc(TEST_SPENDER, ethers.constants.MaxUint256);
    expect(r.success).toBe(true);
    expect(capturedExecute!.txs[0].to).toBe(POLYGON_CONTRACTS_V2.pUSD);

    const decoded = ERC20_IFACE.decodeFunctionData('approve', capturedExecute!.txs[0].data);
    expect(decoded.spender.toLowerCase()).toBe(TEST_SPENDER.toLowerCase());
  });

  it("routes to USDC.e when token === 'USDC.e' (off-exchange / Onramp approval)", async () => {
    const svc = makeService();
    const r = await svc.approveUsdc(TEST_SPENDER, BigNumber.from(123), 'USDC.e');
    expect(r.success).toBe(true);
    expect(capturedExecute!.txs[0].to).toBe(POLYGON_CONTRACTS_V2.usdcE);
  });
});

// ---------------------------------------------------------------------------
// transferUsdc — token routing (pUSD default + USDC.e for fund-out)
// ---------------------------------------------------------------------------

describe('RelayerService.transferUsdc — token routing', () => {
  it('defaults to pUSD (V2 strategy capital)', async () => {
    const svc = makeService();
    const r = await svc.transferUsdc(TEST_RECIPIENT, '50');
    expect(r.success).toBe(true);
    expect(capturedExecute!.txs[0].to).toBe(POLYGON_CONTRACTS_V2.pUSD);

    const decoded = ERC20_IFACE.decodeFunctionData('transfer', capturedExecute!.txs[0].data);
    expect(decoded.to.toLowerCase()).toBe(TEST_RECIPIENT.toLowerCase());
    // 6 decimals: 50 → 50_000_000
    expect(decoded.amount.toString()).toBe('50000000');
  });

  it("routes to USDC.e when token === 'USDC.e' (fund-out collect path)", async () => {
    const svc = makeService();
    const r = await svc.transferUsdc(TEST_RECIPIENT, '7', 'USDC.e');
    expect(r.success).toBe(true);
    expect(capturedExecute!.txs[0].to).toBe(POLYGON_CONTRACTS_V2.usdcE);
  });
});

// ---------------------------------------------------------------------------
// split / merge — pUSD only (V2 trading collateral)
// ---------------------------------------------------------------------------

describe('RelayerService.split — pUSD-only collateral', () => {
  it('encodes pUSD as the splitPosition collateral arg (V2)', async () => {
    const svc = makeService();
    const r = await svc.split(TEST_CONDITION_ID, '10');
    expect(r.success).toBe(true);
    expect(capturedExecute!.txs[0].to).toBe(CTF_CONTRACT);

    const decoded = CTF_IFACE.decodeFunctionData('splitPosition', capturedExecute!.txs[0].data);
    expect(decoded.collateralToken.toLowerCase()).toBe(POLYGON_CONTRACTS_V2.pUSD.toLowerCase());
  });
});

describe('RelayerService.merge — pUSD-only collateral', () => {
  it('encodes pUSD as the mergePositions collateral arg (V2)', async () => {
    const svc = makeService();
    const r = await svc.merge(TEST_CONDITION_ID, '10');
    expect(r.success).toBe(true);
    expect(capturedExecute!.txs[0].to).toBe(CTF_CONTRACT);

    const decoded = CTF_IFACE.decodeFunctionData('mergePositions', capturedExecute!.txs[0].data);
    expect(decoded.collateralToken.toLowerCase()).toBe(POLYGON_CONTRACTS_V2.pUSD.toLowerCase());
  });
});

// ---------------------------------------------------------------------------
// redeem / redeemBatch — pUSD only (V2 trading collateral)
// ---------------------------------------------------------------------------

describe('RelayerService.redeem — pUSD-only collateral', () => {
  it('encodes pUSD on the standard CTF redeem path (V2)', async () => {
    const svc = makeService();
    const r = await svc.redeem(TEST_CONDITION_ID, 'YES');
    expect(r.success).toBe(true);
    expect(capturedExecute!.txs[0].to).toBe(CTF_CONTRACT);

    const decoded = CTF_IFACE.decodeFunctionData(
      'redeemPositions',
      capturedExecute!.txs[0].data
    );
    expect(decoded.collateralToken.toLowerCase()).toBe(POLYGON_CONTRACTS_V2.pUSD.toLowerCase());
  });

  it('routes through NEG_RISK_ADAPTER for negRisk markets (no collateral arg on adapter)', async () => {
    // NegRisk adapter doesn't take a collateral arg in redeemPositions.
    const svc = makeService();
    const r = await svc.redeem(TEST_CONDITION_ID, 'YES', true);
    expect(r.success).toBe(true);
    expect(capturedExecute!.txs[0].to).toBe(NEG_RISK_ADAPTER);
  });
});

describe('RelayerService.redeemBatch — pUSD-only collateral', () => {
  it('encodes pUSD on every standard CTF entry', async () => {
    const svc = makeService();
    const r = await svc.redeemBatch([
      { conditionId: TEST_CONDITION_ID, outcome: 'YES' },
      { conditionId: TEST_CONDITION_ID, outcome: 'NO' },
    ]);
    expect(r.success).toBe(true);
    expect(capturedExecute!.txs).toHaveLength(2);

    for (const tx of capturedExecute!.txs) {
      expect(tx.to).toBe(CTF_CONTRACT);
      const decoded = CTF_IFACE.decodeFunctionData('redeemPositions', tx.data);
      expect(decoded.collateralToken.toLowerCase()).toBe(POLYGON_CONTRACTS_V2.pUSD.toLowerCase());
    }
  });
});
