/**
 * RelayerService
 *
 * Wrapper around Polymarket Builder Relayer Client for gasless on-chain operations.
 * Enables Gnosis Safe smart contract wallet operations paid by Polymarket Relayer.
 *
 * Benefits:
 * - Gasless transactions (Polymarket pays gas)
 * - Builder attribution (fee sharing + weekly rewards)
 * - Daily transaction limits by tier (Unverified: 100/day, Verified: 1500/day)
 *
 * Operations:
 * - deploySafe: Deploy Gnosis Safe smart contract wallet
 * - approveUsdc: Approve pUSD for trading or USDC.e for onramp wrapping
 * - split: pUSD -> YES + NO tokens
 * - merge: YES + NO -> pUSD
 * - redeem: Winning tokens -> pUSD
 *
 * Based on: @polymarket/builder-relayer-client v0.0.8
 */

import { RelayClient } from '@polymarket/builder-relayer-client';
import { BuilderConfig } from '@polymarket/builder-signing-sdk';
import { ethers, Wallet, BigNumber } from 'ethers';
import {
  CTF_CONTRACT,
  NEG_RISK_ADAPTER,
  USDC_DECIMALS,
} from '../clients/ctf-client.js';
import { POLYGON_CONTRACTS_V2 } from '../constants/v2-contracts.js';

// ============================================================================
// Types
// ============================================================================

export interface RelayerServiceConfig {
  /** Builder API credentials */
  builderCreds: {
    key: string;
    secret: string;
    passphrase: string;
  };
  /** Private key for signing relayer requests (EOA that owns the Safe) */
  privateKey: string;
  /** Chain ID (default: 137 for Polygon) */
  chainId?: number;
  /** RPC URL for the provider (default: from POLYGON_RPC_URL env or polygon-rpc.com) */
  rpcUrl?: string;
  /** Relayer endpoint URL */
  relayerUrl?: string;
}

/**
 * Relayer transaction state machine
 * See: @polymarket/builder-relayer-client types
 */
export enum RelayerState {
  NEW = 'STATE_NEW',
  EXECUTED = 'STATE_EXECUTED',
  MINED = 'STATE_MINED',
  CONFIRMED = 'STATE_CONFIRMED',
  FAILED = 'STATE_FAILED',
  INVALID = 'STATE_INVALID',
}

export interface RelayerResult {
  success: boolean;
  txHash?: string;
  errorMessage?: string;
}

export interface SafeDeployResult extends RelayerResult {
  safeAddress: string;
}

// ============================================================================
// V2 collateral routing
// ============================================================================

/**
 * Off-exchange / fund-flow token identifier. V2 trade settlement collateral
 * is always `pUSD`; the `'USDC.e'` variant is retained ONLY for off-exchange
 * helpers (`approveUsdc` to the Onramp, `transferUsdc` for fund-out collect).
 *
 * Trading-related helpers (`split`, `merge`, `redeem`, `redeemBatch`) do not
 * accept this type: they hardcode pUSD as the post-V2 collateral.
 */
export type CollateralToken = 'pUSD' | 'USDC.e';

/**
 * Resolve a {@link CollateralToken} identifier to its on-chain ERC-20
 * contract address.
 */
function resolveCollateralAddress(token: CollateralToken): string {
  return token === 'pUSD'
    ? POLYGON_CONTRACTS_V2.pUSD
    : POLYGON_CONTRACTS_V2.usdcE;
}

// ============================================================================
// CTF ABIs (reused from ctf-client.ts)
// ============================================================================

const CTF_ABI = [
  'function splitPosition(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount) external',
  'function mergePositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount) external',
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external',
];

const NEG_RISK_ADAPTER_ABI = [
  'function redeemPositions(bytes32 conditionId, uint256[] amounts) external',
];

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
];

const ERC1155_ABI = [
  'function setApprovalForAll(address operator, bool approved) external',
];

/**
 * Polymarket V2 Collateral Onramp / Offramp ABI.
 *
 * Both endpoints share the same `(address asset, address to, uint256 amount)`
 * shape. Verified on-chain via selector probe: `wrap = 0x62355638`,
 * `unwrap = 0x8cc7104f`. See `src/constants/v2-contracts.ts` for source
 * provenance and the `guide-polymarket-v2-migration` skill for migration
 * context.
 */
const COLLATERAL_RAMP_ABI = [
  'function wrap(address asset, address to, uint256 amount) external',
  'function unwrap(address asset, address to, uint256 amount) external',
];

// ============================================================================
// RelayerService Implementation
// ============================================================================

export class RelayerService {
  private relayClient: RelayClient;
  private wallet: Wallet;
  private chainId: number;

  constructor(config: RelayerServiceConfig) {
    this.chainId = config.chainId || 137;
    const rpcUrl = config.rpcUrl ?? process.env.POLYGON_RPC_URL ?? 'https://polygon-rpc.com';
    const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
    this.wallet = new Wallet(config.privateKey, provider);

    const relayerUrl = config.relayerUrl || 'https://relayer-v2.polymarket.com/';

    // Construct BuilderConfig
    const builderConfig = new BuilderConfig({
      localBuilderCreds: {
        key: config.builderCreds.key,
        secret: config.builderCreds.secret,
        passphrase: config.builderCreds.passphrase,
      },
    });

    // Initialize RelayClient with Builder credentials
    // RelayClient constructor signature:
    // constructor(relayerUrl, chainId, signer?, builderConfig?, relayTxType?)
    this.relayClient = new RelayClient(
      relayerUrl,
      this.chainId,
      this.wallet,
      builderConfig as any
    );
  }

  /**
   * Get the EOA address (signer)
   */
  getSignerAddress(): string {
    return this.wallet.address;
  }

  /**
   * Get the ethers Provider used by this service (for on-chain read calls)
   */
  getProvider(): ethers.providers.Provider {
    return this.wallet.provider;
  }

  /**
   * Get the deterministic Safe address for this EOA (without deploying)
   *
   * Uses the same CREATE2 derivation as the Relayer to compute the Safe address.
   */
  async getSafeAddress(): Promise<string> {
    // Access the contract config from RelayClient (it's a public readonly field)
    const safeFactory = (this.relayClient as any).contractConfig?.SafeContracts?.SafeFactory;
    if (!safeFactory) {
      throw new Error('Cannot derive Safe address: SafeFactory not found in contract config');
    }

    // SAFE_INIT_CODE_HASH from @polymarket/builder-relayer-client/constants
    const SAFE_INIT_CODE_HASH = '0x2bce2127ff07fb632d16c8347c4ebf501f4841168bed00d9e6ef715ddb6fcecf';

    // Replicate viem's encodeAbiParameters + keccak256 with ethers
    const salt = ethers.utils.keccak256(
      ethers.utils.defaultAbiCoder.encode(['address'], [this.wallet.address])
    );

    return ethers.utils.getCreate2Address(safeFactory, salt, SAFE_INIT_CODE_HASH);
  }

  /**
   * Check if the Safe is already deployed
   */
  async isDeployed(): Promise<boolean> {
    const safe = await this.getSafeAddress();
    return this.relayClient.getDeployed(safe);
  }

  /**
   * Deploy a Gnosis Safe smart contract wallet (idempotent)
   *
   * If the Safe is already deployed, returns the existing Safe address.
   * Safe owner is the EOA (this.wallet.address).
   *
   * @returns SafeDeployResult with deployed Safe address
   */
  async deploySafe(): Promise<SafeDeployResult> {
    try {
      // Check if already deployed
      const expectedSafe = await this.getSafeAddress();
      const deployed = await this.relayClient.getDeployed(expectedSafe);

      if (deployed) {
        return {
          success: true,
          safeAddress: expectedSafe,
          txHash: undefined,
        };
      }

      const response = await this.relayClient.deploy();

      // Wait for confirmation
      const tx = await response.wait();

      if (!tx) {
        return {
          success: false,
          safeAddress: '',
          errorMessage: 'Deployment failed: No transaction returned',
        };
      }

      if (tx.state === RelayerState.FAILED || tx.state === RelayerState.INVALID) {
        return {
          success: false,
          safeAddress: '',
          errorMessage: `Safe deployment failed: ${tx.state}`,
        };
      }

      return {
        success: true,
        safeAddress: expectedSafe,
        txHash: tx.transactionHash,
      };
    } catch (error) {
      return {
        success: false,
        safeAddress: '',
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Approve a collateral token for CTF / Onramp / Offramp operations.
   *
   * V2 default is `pUSD` (the trading collateral). Pass `'USDC.e'` for
   * off-exchange flows (e.g. approving the Onramp prior to wrap, or legacy
   * V1-style direct approvals).
   *
   * @param spender - Spender address (CTF_CONTRACT, Onramp/Offramp, etc.)
   * @param amount - Amount to approve (use MaxUint256 for unlimited)
   * @param token - Collateral token to approve. Defaults to `'pUSD'`.
   */
  async approveUsdc(
    spender: string,
    amount: BigNumber,
    token: CollateralToken = 'pUSD'
  ): Promise<RelayerResult> {
    const usdcInterface = new ethers.utils.Interface(ERC20_ABI);
    const data = usdcInterface.encodeFunctionData('approve', [spender, amount]);
    const collateralAddress = resolveCollateralAddress(token);

    try {
      const response = await this.relayClient.execute([{
        to: collateralAddress,
        value: '0',
        data,
      }]);

      const tx = await response.wait();

      if (!tx || tx.state === RelayerState.FAILED || tx.state === RelayerState.INVALID) {
        return {
          success: false,
          errorMessage: `USDC approval failed: ${tx?.state || 'No transaction'}`,
        };
      }

      return {
        success: true,
        txHash: tx.transactionHash,
      };
    } catch (error) {
      return {
        success: false,
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Wrap USDC.e → pUSD via the V2 Collateral Onramp (gasless, 1:1, no fee).
   *
   * V2 trade settlement uses pUSD as collateral. Each Safe must wrap its
   * USDC.e holdings to pUSD before placing its first V2 order. This is
   * relay-encoded so it costs the Safe no gas.
   *
   * Pre-conditions (NOT enforced here — caller must ensure):
   *   1. Safe has approved the Onramp (`POLYGON_CONTRACTS_V2.collateralOnramp`)
   *      to spend USDC.e on its behalf — see `AuthorizationService.approveAll()`.
   *   2. Safe has at least `amountWei` USDC.e balance.
   *
   * The minted pUSD is delivered to the Safe itself (the Safe is `_to`).
   *
   * @param amountWei - amount in USDC.e base units (6 decimals). MUST be
   *   non-zero; the contract will revert on zero amount.
   * @returns RelayerResult with transaction status
   *
   * @example
   * ```typescript
   * // Wrap 100 USDC.e → 100 pUSD on the caller's Safe
   * const amount = ethers.utils.parseUnits("100", 6);
   * const r = await relayer.wrapUsdcToPUSD(amount.toBigInt());
   * ```
   */
  async wrapUsdcToPUSD(amountWei: bigint): Promise<RelayerResult> {
    if (amountWei <= 0n) {
      return {
        success: false,
        errorMessage: 'wrapUsdcToPUSD: amountWei must be > 0',
      };
    }

    const safeAddress = await this.getSafeAddress();
    const rampInterface = new ethers.utils.Interface(COLLATERAL_RAMP_ABI);
    const data = rampInterface.encodeFunctionData('wrap', [
      POLYGON_CONTRACTS_V2.usdcE,
      safeAddress,
      BigNumber.from(amountWei),
    ]);

    try {
      const response = await this.relayClient.execute([{
        to: POLYGON_CONTRACTS_V2.collateralOnramp,
        value: '0',
        data,
      }]);

      const tx = await response.wait();

      if (!tx || tx.state === RelayerState.FAILED || tx.state === RelayerState.INVALID) {
        return {
          success: false,
          errorMessage: `wrap (USDC.e → pUSD) failed: ${tx?.state || 'No transaction'}`,
        };
      }

      return {
        success: true,
        txHash: tx.transactionHash,
      };
    } catch (error) {
      return {
        success: false,
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Unwrap pUSD → USDC.e via the V2 Collateral Offramp (gasless, 1:1, no fee).
   *
   * Reverses {@link wrapUsdcToPUSD}. Useful for `ee wallet collect` flows
   * that need to drain a strategy Safe back to USDC.e (the canonical
   * non-trading rail) before transferring to main.
   *
   * Pre-conditions (NOT enforced here — caller must ensure):
   *   1. Safe has approved the Offramp (`POLYGON_CONTRACTS_V2.collateralOfframp`)
   *      to spend pUSD on its behalf — currently NOT in the default V2
   *      approval matrix; callers needing unwrap must explicitly approve
   *      pUSD → Offramp first via the V1-style ERC20 contract call.
   *   2. Safe has at least `amountWei` pUSD balance.
   *
   * @param amountWei - amount in pUSD base units (6 decimals).
   * @returns RelayerResult with transaction status.
   */
  async unwrapPUSDtoUsdc(amountWei: bigint): Promise<RelayerResult> {
    if (amountWei <= 0n) {
      return {
        success: false,
        errorMessage: 'unwrapPUSDtoUsdc: amountWei must be > 0',
      };
    }

    const safeAddress = await this.getSafeAddress();
    const rampInterface = new ethers.utils.Interface(COLLATERAL_RAMP_ABI);
    const data = rampInterface.encodeFunctionData('unwrap', [
      POLYGON_CONTRACTS_V2.usdcE,
      safeAddress,
      BigNumber.from(amountWei),
    ]);

    try {
      const response = await this.relayClient.execute([{
        to: POLYGON_CONTRACTS_V2.collateralOfframp,
        value: '0',
        data,
      }]);

      const tx = await response.wait();

      if (!tx || tx.state === RelayerState.FAILED || tx.state === RelayerState.INVALID) {
        return {
          success: false,
          errorMessage: `unwrap (pUSD → USDC.e) failed: ${tx?.state || 'No transaction'}`,
        };
      }

      return {
        success: true,
        txHash: tx.transactionHash,
      };
    } catch (error) {
      return {
        success: false,
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Transfer collateral (default `pUSD`) to another address via Relayer
   * (gasless).
   *
   * Enables Safe-to-EOA or Safe-to-Safe collateral transfers without gas
   * fees. Useful for fund distribution / collection between main wallet and
   * strategy wallets.
   *
   * Defaults to `'pUSD'` so post-V2 strategy flows (which keep working
   * capital in pUSD) work out of the box. Pass `'USDC.e'` for fund-out
   * paths that drain unwrapped USDC.e back to main.
   *
   * @param recipient - Recipient address (can be EOA or another Safe)
   * @param amount   - Amount in human-readable format (e.g., "100" for 100
   *                   pUSD or 100 USDC.e — both are 6-decimal tokens).
   * @param token    - Collateral token to transfer. Defaults to `'pUSD'`.
   * @returns RelayerResult with transaction status
   *
   * @example
   * ```typescript
   * // Default V2: transfer pUSD between strategy Safes
   * await relayer.transferUsdc(otherSafe, "300");
   *
   * // Fund-out: drain unwrapped USDC.e back to main wallet
   * await relayer.transferUsdc(mainEoa, "300", 'USDC.e');
   * ```
   */
  async transferUsdc(
    recipient: string,
    amount: string,
    token: CollateralToken = 'pUSD'
  ): Promise<RelayerResult> {
    // pUSD and USDC.e both use 6 decimals; reusing USDC_DECIMALS keeps
    // parity with the V1 path while routing the transfer to the right token.
    const amountWei = ethers.utils.parseUnits(amount, USDC_DECIMALS);
    const usdcInterface = new ethers.utils.Interface(ERC20_ABI);
    const data = usdcInterface.encodeFunctionData('transfer', [recipient, amountWei]);
    const collateralAddress = resolveCollateralAddress(token);

    try {
      const response = await this.relayClient.execute([{
        to: collateralAddress,
        value: '0',
        data,
      }]);

      const tx = await response.wait();

      if (!tx || tx.state === RelayerState.FAILED || tx.state === RelayerState.INVALID) {
        return {
          success: false,
          errorMessage: `USDC transfer failed: ${tx?.state || 'No transaction'}`,
        };
      }

      return {
        success: true,
        txHash: tx.transactionHash,
      };
    } catch (error) {
      return {
        success: false,
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Approve ERC1155 (Conditional Tokens) operator via Relayer (gasless)
   *
   * Required for order fills — CTF Exchange needs setApprovalForAll to transfer tokens.
   *
   * @param operator - Operator address (e.g., CTF_EXCHANGE_V2, NEG_RISK_CTF_EXCHANGE_V2)
   */
  async approveERC1155ForAll(operator: string): Promise<RelayerResult> {
    const erc1155Interface = new ethers.utils.Interface(ERC1155_ABI);
    const data = erc1155Interface.encodeFunctionData('setApprovalForAll', [operator, true]);

    try {
      const response = await this.relayClient.execute([{
        to: CTF_CONTRACT,
        value: '0',
        data,
      }]);

      const tx = await response.wait();

      if (!tx || tx.state === RelayerState.FAILED || tx.state === RelayerState.INVALID) {
        return {
          success: false,
          errorMessage: `ERC1155 approval failed: ${tx?.state || 'No transaction'}`,
        };
      }

      return {
        success: true,
        txHash: tx.transactionHash,
      };
    } catch (error) {
      return {
        success: false,
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Split pUSD collateral into YES + NO tokens (gasless).
   *
   * V2 markets settle in pUSD only — there is no token override.
   *
   * @param conditionId - Market condition ID
   * @param amount      - Collateral amount in human-readable format (e.g.,
   *                      "100" for 100 pUSD).
   * @param isNegRisk   - True for NegRisk markets (routes via adapter).
   * @returns RelayerResult with transaction status
   *
   * @example
   * ```typescript
   * const result = await relayer.split(conditionId, "100");
   * if (result.success) {
   *   console.log(`Split tx: ${result.txHash}`);
   * }
   * ```
   */
  async split(
    conditionId: string,
    amount: string,
    isNegRisk = false
  ): Promise<RelayerResult> {
    const amountWei = ethers.utils.parseUnits(amount, USDC_DECIMALS);
    const ctfInterface = new ethers.utils.Interface(CTF_ABI);

    const data = ctfInterface.encodeFunctionData('splitPosition', [
      POLYGON_CONTRACTS_V2.pUSD,
      ethers.constants.HashZero, // parentCollectionId
      conditionId,
      [1, 2], // partition [YES, NO]
      amountWei,
    ]);

    const to = isNegRisk ? NEG_RISK_ADAPTER : CTF_CONTRACT;

    try {
      const response = await this.relayClient.execute([{
        to,
        value: '0',
        data,
      }]);

      const tx = await response.wait();

      if (!tx || tx.state === RelayerState.FAILED || tx.state === RelayerState.INVALID) {
        return {
          success: false,
          errorMessage: `Split failed: ${tx?.state || 'No transaction'}`,
        };
      }

      return {
        success: true,
        txHash: tx.transactionHash,
      };
    } catch (error) {
      return {
        success: false,
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Merge YES + NO tokens back to pUSD collateral (gasless).
   *
   * V2 CLOB trading and CTF operations are modeled as pUSD collateral. USDC.e
   * remains an onramp/offramp rail and is not used as the merge collateral
   * argument here.
   *
   * @param conditionId - Market condition ID
   * @param amount      - Number of token pairs to merge (e.g., "100" for
   *                      100 YES + 100 NO).
   * @param isNegRisk   - True for NegRisk markets (routes via adapter).
   * @returns RelayerResult with transaction status
   */
  async merge(
    conditionId: string,
    amount: string,
    isNegRisk = false
  ): Promise<RelayerResult> {
    const amountWei = ethers.utils.parseUnits(amount, USDC_DECIMALS);
    const ctfInterface = new ethers.utils.Interface(CTF_ABI);

    const data = ctfInterface.encodeFunctionData('mergePositions', [
      POLYGON_CONTRACTS_V2.pUSD,
      ethers.constants.HashZero,
      conditionId,
      [1, 2],
      amountWei,
    ]);

    const to = isNegRisk ? NEG_RISK_ADAPTER : CTF_CONTRACT;

    try {
      const response = await this.relayClient.execute([{
        to,
        value: '0',
        data,
      }]);

      const tx = await response.wait();

      if (!tx || tx.state === RelayerState.FAILED || tx.state === RelayerState.INVALID) {
        return {
          success: false,
          errorMessage: `Merge failed: ${tx?.state || 'No transaction'}`,
        };
      }

      return {
        success: true,
        txHash: tx.transactionHash,
      };
    } catch (error) {
      return {
        success: false,
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Redeem winning tokens back to pUSD collateral (gasless).
   *
   * V2 markets settle in pUSD. NegRisk adapter doesn't take a collateral
   * argument on-chain (it reads the market's collateral itself).
   *
   * @param conditionId - Market condition ID
   * @param outcome     - Winning outcome ('YES' or 'NO')
   * @param isNegRisk   - True for NegRisk markets (routes via adapter).
   * @returns RelayerResult with transaction status
   */
  async redeem(
    conditionId: string,
    outcome: 'YES' | 'NO',
    isNegRisk = false
  ): Promise<RelayerResult> {
    let data: string;
    let to: string;

    if (isNegRisk) {
      // NegRisk adapter: redeemPositions(conditionId, amounts[])
      // amounts = [yesAmount, noAmount] — use MaxUint256 to redeem all
      const negRiskInterface = new ethers.utils.Interface(NEG_RISK_ADAPTER_ABI);
      const maxAmount = ethers.constants.MaxUint256;
      // outcome determines which index has tokens: YES=index0, NO=index1
      const amounts = outcome === 'YES'
        ? [maxAmount, BigNumber.from(0)]
        : [BigNumber.from(0), maxAmount];
      data = negRiskInterface.encodeFunctionData('redeemPositions', [conditionId, amounts]);
      to = NEG_RISK_ADAPTER;
    } else {
      // Standard CTF: redeemPositions(collateral, parentCollectionId, conditionId, indexSets)
      const indexSets = outcome === 'YES' ? [1] : [2];
      const ctfInterface = new ethers.utils.Interface(CTF_ABI);
      data = ctfInterface.encodeFunctionData('redeemPositions', [
        POLYGON_CONTRACTS_V2.pUSD,
        ethers.constants.HashZero,
        conditionId,
        indexSets,
      ]);
      to = CTF_CONTRACT;
    }

    try {
      const response = await this.relayClient.execute([{
        to,
        value: '0',
        data,
      }]);

      const tx = await response.wait();

      if (!tx || tx.state === RelayerState.FAILED || tx.state === RelayerState.INVALID) {
        return {
          success: false,
          errorMessage: `Redeem failed: ${tx?.state || 'No transaction'}`,
        };
      }

      return {
        success: true,
        txHash: tx.transactionHash,
      };
    } catch (error) {
      return {
        success: false,
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Redeem negRisk positions with actual token amounts (gasless)
   *
   * @param conditionId - Market condition ID
   * @param outcome - Our outcome ('YES' or 'NO')
   * @param size - Number of tokens to redeem (decimal, e.g. 26.315788)
   * @returns RelayerResult with transaction status
   */
  async redeemNegRisk(conditionId: string, outcome: 'YES' | 'NO', size: number): Promise<RelayerResult> {
    const negRiskInterface = new ethers.utils.Interface(NEG_RISK_ADAPTER_ABI);
    // CTF tokens use 6 decimals
    const amountWei = ethers.utils.parseUnits(size.toFixed(6), 6);
    // amounts = [yesAmount, noAmount]
    const amounts = outcome === 'YES'
      ? [amountWei, BigNumber.from(0)]
      : [BigNumber.from(0), amountWei];

    const data = negRiskInterface.encodeFunctionData('redeemPositions', [conditionId, amounts]);

    try {
      const response = await this.relayClient.execute([{
        to: NEG_RISK_ADAPTER,
        value: '0',
        data,
      }]);

      const tx = await response.wait();

      if (!tx || tx.state === RelayerState.FAILED || tx.state === RelayerState.INVALID) {
        return {
          success: false,
          errorMessage: `Redeem failed: ${tx?.state || 'No transaction'}`,
        };
      }

      return {
        success: true,
        txHash: tx.transactionHash,
      };
    } catch (error) {
      return {
        success: false,
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Batch redeem multiple winning positions in a single relayer call
   * (gasless). All entries settle in pUSD (V2 collateral).
   *
   * @param redeems - Array of { conditionId, outcome, isNegRisk? } to redeem.
   * @returns RelayerResult with transaction status
   */
  async redeemBatch(
    redeems: Array<{
      conditionId: string;
      outcome: 'YES' | 'NO';
      isNegRisk?: boolean;
    }>
  ): Promise<RelayerResult> {
    if (redeems.length === 0) {
      return { success: true };
    }

    // Single redeem — use simple path
    if (redeems.length === 1) {
      return this.redeem(
        redeems[0].conditionId,
        redeems[0].outcome,
        redeems[0].isNegRisk
      );
    }

    const ctfInterface = new ethers.utils.Interface(CTF_ABI);
    const negRiskInterface = new ethers.utils.Interface(NEG_RISK_ADAPTER_ABI);
    const transactions = redeems.map(({ conditionId, outcome, isNegRisk }) => {
      let data: string;
      let to: string;
      if (isNegRisk) {
        const maxAmount = ethers.constants.MaxUint256;
        const amounts = outcome === 'YES'
          ? [maxAmount, BigNumber.from(0)]
          : [BigNumber.from(0), maxAmount];
        data = negRiskInterface.encodeFunctionData('redeemPositions', [conditionId, amounts]);
        to = NEG_RISK_ADAPTER;
      } else {
        const indexSets = outcome === 'YES' ? [1] : [2];
        data = ctfInterface.encodeFunctionData('redeemPositions', [
          POLYGON_CONTRACTS_V2.pUSD,
          ethers.constants.HashZero,
          conditionId,
          indexSets,
        ]);
        to = CTF_CONTRACT;
      }
      return { to, value: '0', data };
    });

    return this.executeBatch(transactions);
  }

  /**
   * Execute a batch of generic transactions via Relayer (gasless)
   *
   * @param transactions - Array of transactions to execute
   */
  async executeBatch(
    transactions: Array<{ to: string; data: string; value: string }>
  ): Promise<RelayerResult> {
    try {
      const response = await this.relayClient.execute(transactions);
      const tx = await response.wait();

      if (!tx || tx.state === RelayerState.FAILED || tx.state === RelayerState.INVALID) {
        return {
          success: false,
          errorMessage: `Batch execution failed: ${tx?.state || 'No transaction'}`,
        };
      }

      return {
        success: true,
        txHash: tx.transactionHash,
      };
    } catch (error) {
      return {
        success: false,
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}
