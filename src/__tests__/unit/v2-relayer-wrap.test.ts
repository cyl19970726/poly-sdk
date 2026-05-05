/**
 * Unit tests for V2 Relayer wrap / unwrap helpers.
 *
 * Stage C of the Polymarket V2 migration adds the USDC.e ↔ pUSD bridge
 * helpers on `RelayerService`. The behavioural contract:
 *
 *   - `wrapUsdcToPUSD(amount)` calls the V2 Collateral Onramp's
 *     `wrap(USDC.e, safeAddress, amount)` via `relayClient.execute()`.
 *   - `unwrapPUSDtoUsdc(amount)` calls the V2 Collateral Offramp's
 *     `unwrap(USDC.e, safeAddress, amount)` via `relayClient.execute()`.
 *   - Both require non-zero `amountWei` — zero / negative reject without
 *     touching the relay client.
 *   - Failed relayer states (FAILED / INVALID) surface as
 *     `success: false` with a descriptive `errorMessage`.
 *
 * We mock `@polymarket/builder-relayer-client` at module load so no network
 * call ever happens; we only assert on the encoded transaction the service
 * emits.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ethers } from 'ethers';
import { POLYGON_CONTRACTS_V2 } from '../../constants/v2-contracts.js';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

// Capture the most recent `execute()` invocation so each test can assert
// against it without holding a reference to the live mock.
let capturedExecute: { txs: any[] } | null = null;
let nextRelayState = 'STATE_CONFIRMED';
let nextTxHash = '0xdeadbeef';

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
          state: nextRelayState,
          transactionHash: nextTxHash,
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

// Import the service AFTER mocks are registered.
import { RelayerService } from '../../services/relayer-service.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_PK = '0x' + '1'.repeat(64);

function makeService(): RelayerService {
  return new RelayerService({
    builderCreds: { key: 'k', secret: 's', passphrase: 'p' },
    privateKey: TEST_PK,
    chainId: 137,
    rpcUrl: 'http://localhost:0', // never reached because we don't make RPC calls
  });
}

// Decode the `wrap` / `unwrap` calldata our service emitted.
const RAMP_IFACE = new ethers.utils.Interface([
  'function wrap(address asset, address to, uint256 amount) external',
  'function unwrap(address asset, address to, uint256 amount) external',
]);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RelayerService.wrapUsdcToPUSD', () => {
  beforeEach(() => {
    capturedExecute = null;
    nextRelayState = 'STATE_CONFIRMED';
    nextTxHash = '0xwraphash';
  });

  it('targets the V2 Collateral Onramp with wrap(USDC.e, safe, amount)', async () => {
    const svc = makeService();
    const safe = await svc.getSafeAddress();
    const amount = 1_000_000n; // 1 USDC.e (6 decimals)

    const r = await svc.wrapUsdcToPUSD(amount);

    expect(r.success).toBe(true);
    expect(r.txHash).toBe('0xwraphash');
    expect(capturedExecute).not.toBeNull();
    expect(capturedExecute!.txs).toHaveLength(1);

    const tx = capturedExecute!.txs[0];
    expect(tx.to).toBe(POLYGON_CONTRACTS_V2.collateralOnramp);
    expect(tx.value).toBe('0');

    const decoded = RAMP_IFACE.decodeFunctionData('wrap', tx.data);
    expect(decoded.asset.toLowerCase()).toBe(
      POLYGON_CONTRACTS_V2.usdcE.toLowerCase()
    );
    expect(decoded.to).toBe(safe);
    expect(decoded.amount.toString()).toBe(amount.toString());
  });

  it('rejects zero amount without invoking the relay client', async () => {
    const svc = makeService();
    const r = await svc.wrapUsdcToPUSD(0n);
    expect(r.success).toBe(false);
    expect(r.errorMessage).toMatch(/amountWei must be > 0/);
    expect(capturedExecute).toBeNull();
  });

  it('rejects negative amount without invoking the relay client', async () => {
    const svc = makeService();
    const r = await svc.wrapUsdcToPUSD(-1n);
    expect(r.success).toBe(false);
    expect(r.errorMessage).toMatch(/amountWei must be > 0/);
    expect(capturedExecute).toBeNull();
  });

  it('reports failure when relayer state is FAILED', async () => {
    nextRelayState = 'STATE_FAILED';
    const svc = makeService();
    const r = await svc.wrapUsdcToPUSD(123n);
    expect(r.success).toBe(false);
    expect(r.errorMessage).toMatch(/wrap.*STATE_FAILED/);
  });

  it('reports failure when relayer state is INVALID', async () => {
    nextRelayState = 'STATE_INVALID';
    const svc = makeService();
    const r = await svc.wrapUsdcToPUSD(123n);
    expect(r.success).toBe(false);
    expect(r.errorMessage).toMatch(/wrap.*STATE_INVALID/);
  });
});

describe('RelayerService.unwrapPUSDtoUsdc', () => {
  beforeEach(() => {
    capturedExecute = null;
    nextRelayState = 'STATE_CONFIRMED';
    nextTxHash = '0xunwraphash';
  });

  it('targets the V2 Collateral Offramp with unwrap(USDC.e, safe, amount)', async () => {
    const svc = makeService();
    const safe = await svc.getSafeAddress();
    const amount = 5_000_000n; // 5 pUSD

    const r = await svc.unwrapPUSDtoUsdc(amount);

    expect(r.success).toBe(true);
    expect(r.txHash).toBe('0xunwraphash');

    const tx = capturedExecute!.txs[0];
    expect(tx.to).toBe(POLYGON_CONTRACTS_V2.collateralOfframp);
    expect(tx.value).toBe('0');

    const decoded = RAMP_IFACE.decodeFunctionData('unwrap', tx.data);
    expect(decoded.asset.toLowerCase()).toBe(
      POLYGON_CONTRACTS_V2.usdcE.toLowerCase()
    );
    expect(decoded.to).toBe(safe);
    expect(decoded.amount.toString()).toBe(amount.toString());
  });

  it('rejects zero amount without invoking the relay client', async () => {
    const svc = makeService();
    const r = await svc.unwrapPUSDtoUsdc(0n);
    expect(r.success).toBe(false);
    expect(r.errorMessage).toMatch(/amountWei must be > 0/);
    expect(capturedExecute).toBeNull();
  });

  it('reports failure when relayer state is FAILED', async () => {
    nextRelayState = 'STATE_FAILED';
    const svc = makeService();
    const r = await svc.unwrapPUSDtoUsdc(7n);
    expect(r.success).toBe(false);
    expect(r.errorMessage).toMatch(/unwrap.*STATE_FAILED/);
  });

  it('targets a different contract than wrap (Offramp ≠ Onramp)', () => {
    expect(POLYGON_CONTRACTS_V2.collateralOnramp).not.toBe(
      POLYGON_CONTRACTS_V2.collateralOfframp
    );
  });
});
