/**
 * CTF (Conditional Token Framework) Client
 *
 * Provides on-chain operations for Polymarket's conditional tokens:
 * - Split: pUSD -> YES + NO token pair
 * - Merge: YES + NO -> pUSD
 * - Redeem: Winning tokens -> pUSD (after market resolution)
 *
 * V2 collateral model:
 * - Trading and user-visible CTF operations use pUSD (Polymarket USD).
 * - USDC.e is an onramp/offramp rail, not the V2 trading collateral.
 *
 * | Token         | Address                                    | V2 role          |
 * |---------------|--------------------------------------------|------------------|
 * | pUSD          | 0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB | Trading collateral |
 * | USDC.e        | 0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174 | Wrap/unwrap rail |
 * | Native USDC   | 0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359 | Deposit/bridge input |
 *
 * Common Mistake:
 * - Your wallet has USDC.e or native USDC but no pUSD, so V2 trading fails
 * - Solution: wrap USDC.e through the Collateral Onramp, or deposit via the
 *   Polymarket bridge/onramp flow so the account receives pUSD
 *
 * Contract: Gnosis Conditional Tokens on Polygon
 * https://docs.polymarket.com/trading/ctf/overview
 */

import { ethers, Contract, Wallet, BigNumber } from 'ethers';
import { POLYGON_CONTRACTS_V2 } from '../constants/v2-contracts.js';

// ===== Contract Addresses (Polygon Mainnet) =====

/** Conditional Tokens (CTF) ERC-1155. UNCHANGED across V1/V2. */
export const CTF_CONTRACT = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';

/** pUSD (Polymarket USD) — V2 trading collateral. */
export const PUSD_CONTRACT = POLYGON_CONTRACTS_V2.pUSD;

/** USDC.e (bridged USDC) — V2 onramp/offramp rail, not trading collateral. */
export const USDC_E_CONTRACT = POLYGON_CONTRACTS_V2.usdcE;

/** V2 CTF collateral address. */
export const COLLATERAL_CONTRACT = PUSD_CONTRACT;

/**
 * Backwards-compatible alias for the V2 collateral token.
 *
 * @deprecated Use PUSD_CONTRACT or COLLATERAL_CONTRACT. This alias no longer
 * points to USDC.e after the 2026-04-28 CLOB V2 cutover.
 */
export const USDC_CONTRACT = PUSD_CONTRACT;

/** Native USDC on Polygon - deposit/bridge input, not the CTF collateral. */
export const NATIVE_USDC_CONTRACT = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';

/**
 * V2 NegRisk CTF Exchange (canonical post-cutover).
 *
 * Re-exported here as a convenience alias alongside
 * `POLYGON_CONTRACTS_V2.negRiskExchange`. Prefer importing from the V2
 * constants module directly when consuming multiple V2 addresses.
 */
export const NEG_RISK_CTF_EXCHANGE_V2 = POLYGON_CONTRACTS_V2.negRiskExchange;

/** NegRisk Adapter — wraps multi-outcome markets. UNCHANGED from V1. */
export const NEG_RISK_ADAPTER = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';

/**
 * V2 CTF Exchange (canonical post-cutover).
 *
 * Re-exported here as a convenience alias alongside
 * `POLYGON_CONTRACTS_V2.ctfExchange`.
 */
export const CTF_EXCHANGE_V2 = POLYGON_CONTRACTS_V2.ctfExchange;

// pUSD, USDC.e, and native USDC all use 6 decimals.
export const USDC_DECIMALS = 6;

// ===== ABIs =====

const CTF_ABI = [
  // Split: pUSD -> YES + NO
  'function splitPosition(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount) external',
  // Merge: YES + NO -> pUSD
  'function mergePositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount) external',
  // Redeem: Winning tokens -> pUSD
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external',
  // Balance query
  'function balanceOf(address account, uint256 positionId) view returns (uint256)',
  // Check if condition is resolved
  'function payoutNumerators(bytes32 conditionId, uint256 outcomeIndex) view returns (uint256)',
  'function payoutDenominator(bytes32 conditionId) view returns (uint256)',
];

// NegRisk Adapter ABI — overloaded split/merge have same signature as CTF,
// redeem has NegRisk-specific signature: (conditionId, amounts[])
const NEG_RISK_ADAPTER_ABI = [
  'function splitPosition(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount) external',
  'function mergePositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount) external',
  'function redeemPositions(bytes32 conditionId, uint256[] amounts) external',
];

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function decimals() view returns (uint8)',
];

// ===== Types =====

export interface CTFConfig {
  /**
   * Private key for signing transactions
   *
   * Optional: If not provided, CTFClient operates in read-only mode.
   * Read-only mode supports: getMarketResolution(), getPositionBalance()
   * Requires private key: split(), merge(), redeem()
   */
  privateKey?: string;
  /** RPC URL (default: Polygon mainnet) */
  rpcUrl?: string;
  /** Chain ID (default: 137 for Polygon) */
  chainId?: number;
  /** Gas price multiplier (default: 1.2) */
  gasPriceMultiplier?: number;
  /** Transaction confirmation blocks (default: 1) */
  confirmations?: number;
  /** Transaction timeout in ms (default: 60000) */
  txTimeout?: number;
}

export interface GasEstimate {
  /** Estimated gas units */
  gasUnits: string;
  /** Gas price in gwei */
  gasPriceGwei: string;
  /** Estimated cost in MATIC */
  costMatic: string;
  /** Estimated cost in USDC (at current MATIC price) */
  costUsdc: string;
  /** MATIC/USDC price used */
  maticPrice: number;
}

export interface TransactionStatus {
  txHash: string;
  status: 'pending' | 'confirmed' | 'failed' | 'reverted';
  confirmations: number;
  blockNumber?: number;
  gasUsed?: string;
  effectiveGasPrice?: string;
  errorReason?: string;
}

/** Common revert reasons */
export enum RevertReason {
  INSUFFICIENT_BALANCE = 'INSUFFICIENT_BALANCE',
  INSUFFICIENT_ALLOWANCE = 'INSUFFICIENT_ALLOWANCE',
  CONDITION_NOT_RESOLVED = 'CONDITION_NOT_RESOLVED',
  INVALID_PARTITION = 'INVALID_PARTITION',
  INVALID_CONDITION = 'INVALID_CONDITION',
  EXECUTION_REVERTED = 'EXECUTION_REVERTED',
  TIMEOUT = 'TIMEOUT',
  UNKNOWN = 'UNKNOWN',
}

export interface SplitResult {
  success: boolean;
  txHash: string;
  amount: string;
  yesTokens: string;
  noTokens: string;
  gasUsed?: string;
}

export interface MergeResult {
  success: boolean;
  txHash: string;
  amount: string;
  usdcReceived: string;
  gasUsed?: string;
}

export interface RedeemResult {
  success: boolean;
  txHash: string;
  /** Winning outcome (e.g., 'YES', 'NO', 'Up', 'Down', 'Team1', 'Team2') */
  outcome: string;
  tokensRedeemed: string;
  usdcReceived: string;
  gasUsed?: string;
}

export interface PositionBalance {
  conditionId: string;
  yesBalance: string;
  noBalance: string;
  yesPositionId: string;
  noPositionId: string;
}

export interface TokenIds {
  yesTokenId: string;
  noTokenId: string;
}

export interface MarketResolution {
  conditionId: string;
  isResolved: boolean;
  /** Winning outcome (e.g., 'YES', 'NO') - determined by payout numerators */
  winningOutcome?: string;
  payoutNumerators: [number, number];
  payoutDenominator: number;
}

// ===== CTF Client =====

// Default MATIC price (updated via getMaticPrice)
const DEFAULT_MATIC_PRICE = 0.50;

export class CTFClient {
  private provider: ethers.providers.JsonRpcProvider;
  private wallet: Wallet | null;
  private ctfContract: Contract;
  private negRiskAdapterContract: Contract;
  private collateralContract: Contract;
  private usdcEContract: Contract;
  private gasPriceMultiplier: number;
  private confirmations: number;
  private txTimeout: number;
  private cachedMaticPrice: number = DEFAULT_MATIC_PRICE;
  private maticPriceLastUpdated: number = 0;
  private readonly readOnly: boolean;

  constructor(config: CTFConfig) {
    const rpcUrl = config.rpcUrl || 'https://polygon-rpc.com';
    const chainId = config.chainId || 137; // Default to Polygon mainnet
    // Use StaticJsonRpcProvider to avoid automatic network detection which can fail with some RPCs
    this.provider = new ethers.providers.StaticJsonRpcProvider(rpcUrl, {
      name: 'polygon',
      chainId,
    });
    this.readOnly = !config.privateKey;

    // Create wallet and signer only if private key is provided
    if (config.privateKey) {
      this.wallet = new Wallet(config.privateKey, this.provider);
      this.ctfContract = new Contract(CTF_CONTRACT, CTF_ABI, this.wallet);
      this.negRiskAdapterContract = new Contract(NEG_RISK_ADAPTER, NEG_RISK_ADAPTER_ABI, this.wallet);
      this.collateralContract = new Contract(COLLATERAL_CONTRACT, ERC20_ABI, this.wallet);
      this.usdcEContract = new Contract(USDC_E_CONTRACT, ERC20_ABI, this.wallet);
    } else {
      // Read-only mode: use provider directly (no signing capability)
      this.wallet = null;
      this.ctfContract = new Contract(CTF_CONTRACT, CTF_ABI, this.provider);
      this.negRiskAdapterContract = new Contract(NEG_RISK_ADAPTER, NEG_RISK_ADAPTER_ABI, this.provider);
      this.collateralContract = new Contract(COLLATERAL_CONTRACT, ERC20_ABI, this.provider);
      this.usdcEContract = new Contract(USDC_E_CONTRACT, ERC20_ABI, this.provider);
    }

    this.gasPriceMultiplier = config.gasPriceMultiplier || 1.2;
    this.confirmations = config.confirmations || 1;
    this.txTimeout = config.txTimeout || 60000;
  }

  /**
   * Get wallet address
   *
   * @throws Error if in read-only mode (no private key provided)
   */
  getAddress(): string {
    if (!this.wallet) {
      throw new Error('CTFClient is in read-only mode. Provide a private key to use this method.');
    }
    return this.wallet.address;
  }

  /**
   * Check if client is in read-only mode
   */
  isReadOnly(): boolean {
    return this.readOnly;
  }

  /**
   * Ensure client is not in read-only mode
   *
   * @throws Error if in read-only mode
   */
  private ensureNotReadOnly(methodName: string): void {
    if (this.readOnly) {
      throw new Error(
        `CTFClient.${methodName}() requires a private key. ` +
        `This client is in read-only mode. Provide a private key in the config to use transaction methods.`
      );
    }
  }

  /**
   * Get pUSD balance - the V2 collateral used for Polymarket trading.
   */
  async getPusdBalance(): Promise<string> {
    this.ensureNotReadOnly('getPusdBalance');
    const balance = await this.collateralContract.balanceOf(this.wallet!.address);
    return ethers.utils.formatUnits(balance, USDC_DECIMALS);
  }

  /**
   * Backwards-compatible alias for the pUSD collateral balance.
   *
   * @deprecated Use getPusdBalance(). In CLOB V2, this returns pUSD, not USDC.e.
   */
  async getUsdcBalance(): Promise<string> {
    return this.getPusdBalance();
  }

  /**
   * Get USDC.e balance (onramp/offramp rail, not V2 trading collateral).
   */
  async getUsdcEBalance(): Promise<string> {
    this.ensureNotReadOnly('getUsdcEBalance');
    const balance = await this.usdcEContract.balanceOf(this.wallet!.address);
    return ethers.utils.formatUnits(balance, USDC_DECIMALS);
  }

  /**
   * Get native USDC balance (for comparison/debugging).
   */
  async getNativeUsdcBalance(): Promise<string> {
    this.ensureNotReadOnly('getNativeUsdcBalance');
    const nativeUsdcContract = new Contract(NATIVE_USDC_CONTRACT, ERC20_ABI, this.provider);
    const balance = await nativeUsdcContract.balanceOf(this.wallet!.address);
    return ethers.utils.formatUnits(balance, USDC_DECIMALS);
  }

  /**
   * Check if wallet is ready for CTF trading operations
   *
   * Verifies:
   * - Has sufficient pUSD collateral
   * - Has MATIC for gas fees
   *
   * @param amount - Minimum pUSD amount needed (e.g., "100" for 100 pUSD)
   * @returns Ready status with balances and suggestions
   *
   * @example
   * ```typescript
   * const status = await ctf.checkReadyForCTF('100');
   * if (!status.ready) {
   *   console.log(status.suggestion);
   *   // "Insufficient pUSD. Wrap USDC.e through the Collateral Onramp first."
   * }
   * ```
   */
  async checkReadyForCTF(amount: string): Promise<{
    ready: boolean;
    pusdBalance: string;
    usdcEBalance: string;
    nativeUsdcBalance: string;
    maticBalance: string;
    suggestion?: string;
  }> {
    this.ensureNotReadOnly('checkReadyForCTF');
    const [pusd, usdcE, nativeUsdc, matic] = await Promise.all([
      this.getPusdBalance(),
      this.getUsdcEBalance(),
      this.getNativeUsdcBalance(),
      this.provider.getBalance(this.wallet!.address),
    ]);

    const pusdBalance = parseFloat(pusd);
    const usdcEBalance = parseFloat(usdcE);
    const nativeUsdcBalance = parseFloat(nativeUsdc);
    const maticBalance = parseFloat(ethers.utils.formatEther(matic));
    const amountNeeded = parseFloat(amount);

    const result = {
      ready: false,
      pusdBalance: pusd,
      usdcEBalance: usdcE,
      nativeUsdcBalance: nativeUsdc,
      maticBalance: ethers.utils.formatEther(matic),
      suggestion: undefined as string | undefined,
    };

    // Check MATIC for gas
    if (maticBalance < 0.01) {
      result.suggestion = `Insufficient MATIC for gas fees. Have: ${maticBalance.toFixed(4)} MATIC, need at least 0.01 MATIC.`;
      return result;
    }

    // Check pUSD balance
    if (pusdBalance < amountNeeded) {
      if (usdcEBalance >= amountNeeded) {
        result.suggestion = `Insufficient pUSD. Have: ${pusdBalance.toFixed(2)} pUSD and ${usdcEBalance.toFixed(2)} USDC.e. ` +
          `Wrap USDC.e to pUSD through the Collateral Onramp before CTF/trading operations.`;
      } else if (nativeUsdcBalance >= amountNeeded) {
        result.suggestion = `Insufficient pUSD. Have: ${pusdBalance.toFixed(2)} pUSD and ${nativeUsdcBalance.toFixed(2)} native USDC. ` +
          `Deposit/bridge or convert funds through the Polymarket onramp so the account receives pUSD.`;
      } else if (nativeUsdcBalance > 0) {
        result.suggestion = `Insufficient pUSD. Have: ${pusdBalance.toFixed(2)} pUSD, ${usdcEBalance.toFixed(2)} USDC.e, and ${nativeUsdcBalance.toFixed(2)} native USDC; need: ${amount} pUSD.`;
      } else {
        result.suggestion = `Insufficient pUSD. Have: ${pusdBalance.toFixed(2)} pUSD, need: ${amount} pUSD.`;
      }
      return result;
    }

    result.ready = true;
    return result;
  }

  /**
   * Split pUSD into YES + NO tokens
   *
   * @param conditionId - Market condition ID
   * @param amount - pUSD amount (e.g., "100" for 100 pUSD)
   * @returns SplitResult with transaction details
   *
   * @example
   * ```typescript
   * const result = await ctf.split(conditionId, "100");
   * console.log(`Split ${result.amount} pUSD into tokens`);
   * console.log(`TX: ${result.txHash}`);
   * ```
   */
  async split(conditionId: string, amount: string): Promise<SplitResult> {
    this.ensureNotReadOnly('split');

    const amountWei = ethers.utils.parseUnits(amount, USDC_DECIMALS);

    // 1. Check pUSD balance
    const balance = await this.collateralContract.balanceOf(this.wallet!.address);
    if (balance.lt(amountWei)) {
      throw new Error(`Insufficient pUSD balance. Have: ${ethers.utils.formatUnits(balance, USDC_DECIMALS)}, Need: ${amount}`);
    }

    // 2. Check and approve pUSD if needed
    const allowance = await this.collateralContract.allowance(this.wallet!.address, CTF_CONTRACT);
    if (allowance.lt(amountWei)) {
      const approveTx = await this.collateralContract.approve(
        CTF_CONTRACT,
        ethers.constants.MaxUint256,
        await this.getGasOptions()
      );
      await approveTx.wait();
    }

    // 3. Execute split
    // Partition [1, 2] represents [YES, NO] outcomes
    const tx = await this.ctfContract.splitPosition(
      COLLATERAL_CONTRACT,
      ethers.constants.HashZero, // parentCollectionId = 0 for Polymarket
      conditionId,
      [1, 2], // partition for YES/NO
      amountWei,
      await this.getGasOptions()
    );

    const receipt = await tx.wait();

    return {
      success: true,
      txHash: receipt.transactionHash,
      amount,
      yesTokens: amount, // 1:1 split
      noTokens: amount,
      gasUsed: receipt.gasUsed.toString(),
    };
  }

  /**
   * Split pUSD into YES + NO tokens using explicit token IDs
   *
   * Supports both standard CTF and NegRisk markets:
   * - Standard: uses CTF contract directly
   * - NegRisk: uses NegRisk Adapter (wraps CTF with wrapped collateral)
   *
   * @param conditionId - Market condition ID (from CLOB API)
   * @param tokenIds - Token IDs from CLOB API
   * @param amount - pUSD amount (e.g., "100" for 100 pUSD)
   * @param isNegRisk - Whether this market uses NegRisk (from CLOB API neg_risk field)
   * @returns SplitResult with transaction details
   */
  async splitByTokenIds(conditionId: string, tokenIds: TokenIds, amount: string, isNegRisk = false): Promise<SplitResult> {
    this.ensureNotReadOnly('splitByTokenIds');
    const amountWei = ethers.utils.parseUnits(amount, USDC_DECIMALS);

    const balance = await this.collateralContract.balanceOf(this.wallet!.address);
    if (balance.lt(amountWei)) {
      throw new Error(`Insufficient pUSD balance. Have: ${ethers.utils.formatUnits(balance, USDC_DECIMALS)}, Need: ${amount}`);
    }

    const targetContract = isNegRisk ? NEG_RISK_ADAPTER : CTF_CONTRACT;
    const splitContract = isNegRisk ? this.negRiskAdapterContract : this.ctfContract;

    // Check and approve pUSD for the target contract
    const allowance = await this.collateralContract.allowance(this.wallet!.address, targetContract);
    if (allowance.lt(amountWei)) {
      const approveTx = await this.collateralContract.approve(
        targetContract,
        ethers.constants.MaxUint256,
        await this.getGasOptions()
      );
      await approveTx.wait();
    }

    const tx = await splitContract.splitPosition(
      COLLATERAL_CONTRACT,
      ethers.constants.HashZero,
      conditionId,
      [1, 2],
      amountWei,
      await this.getGasOptions()
    );

    const receipt = await tx.wait();

    return {
      success: true,
      txHash: receipt.transactionHash,
      amount,
      yesTokens: amount,
      noTokens: amount,
      gasUsed: receipt.gasUsed.toString(),
    };
  }

  /**
   * Merge YES + NO tokens back to pUSD
   *
   * @param conditionId - Market condition ID
   * @param amount - Number of token pairs to merge (e.g., "100" for 100 YES + 100 NO)
   * @returns MergeResult with transaction details
   *
   * @example
   * ```typescript
   * // After buying 100 YES and 100 NO via TradingClient
   * const result = await ctf.merge(conditionId, "100");
   * console.log(`Received ${result.usdcReceived} pUSD`);
   * ```
   */
  async merge(conditionId: string, amount: string): Promise<MergeResult> {
    this.ensureNotReadOnly('merge');

    const amountWei = ethers.utils.parseUnits(amount, USDC_DECIMALS);

    // Check token balances using calculated position IDs
    const balances = await this.getPositionBalance(conditionId);
    const yesBalance = ethers.utils.parseUnits(balances.yesBalance, USDC_DECIMALS);
    const noBalance = ethers.utils.parseUnits(balances.noBalance, USDC_DECIMALS);

    if (yesBalance.lt(amountWei) || noBalance.lt(amountWei)) {
      throw new Error(
        `Insufficient token balance. Need ${amount} of each. Have: YES=${balances.yesBalance}, NO=${balances.noBalance}`
      );
    }

    // Use safe amount: min(requested, yesBalance, noBalance)
    let safeAmountWei = amountWei;
    if (yesBalance.lt(safeAmountWei)) safeAmountWei = yesBalance;
    if (noBalance.lt(safeAmountWei)) safeAmountWei = noBalance;

    // Dry-run to catch revert reason before submitting actual transaction
    try {
      await this.ctfContract.callStatic.mergePositions(
        COLLATERAL_CONTRACT,
        ethers.constants.HashZero,
        conditionId,
        [1, 2],
        safeAmountWei,
      );
    } catch (error: any) {
      const reason = error?.reason || error?.error?.message || error?.message || 'unknown';
      throw new Error(
        `Merge dry-run failed (callStatic reverted): ${reason}. ` +
        `Amount: ${ethers.utils.formatUnits(safeAmountWei, USDC_DECIMALS)}, ` +
        `YES: ${balances.yesBalance}, NO: ${balances.noBalance}, ` +
        `conditionId: ${conditionId}`
      );
    }

    // Execute merge with explicit gasLimit
    const gasOptions = await this.getGasOptions();
    const tx = await this.ctfContract.mergePositions(
      COLLATERAL_CONTRACT,
      ethers.constants.HashZero,
      conditionId,
      [1, 2],
      safeAmountWei,
      { ...gasOptions, gasLimit: 500000 }
    );

    const receipt = await tx.wait();

    const mergedAmount = ethers.utils.formatUnits(safeAmountWei, USDC_DECIMALS);
    return {
      success: true,
      txHash: receipt.transactionHash,
      amount: mergedAmount,
      usdcReceived: mergedAmount,
      gasUsed: receipt.gasUsed.toString(),
    };
  }

  /**
   * Merge YES and NO tokens back into pUSD using explicit token IDs
   *
   * Supports both standard CTF and NegRisk markets:
   * - Standard: uses CTF contract directly
   * - NegRisk: uses NegRisk Adapter (wraps CTF with wrapped collateral)
   *
   * @param conditionId - Market condition ID (from CLOB API)
   * @param tokenIds - Token IDs from CLOB API
   * @param amount - Amount of tokens to merge
   * @param isNegRisk - Whether this market uses NegRisk (from CLOB API neg_risk field)
   * @returns MergeResult with transaction details
   */
  async mergeByTokenIds(conditionId: string, tokenIds: TokenIds, amount: string, isNegRisk = false): Promise<MergeResult> {
    this.ensureNotReadOnly('mergeByTokenIds');
    const amountWei = ethers.utils.parseUnits(amount, USDC_DECIMALS);

    // Check token balances using the provided CLOB token IDs
    const balances = await this.getPositionBalanceByTokenIds(conditionId, tokenIds);
    const yesBalance = ethers.utils.parseUnits(balances.yesBalance, USDC_DECIMALS);
    const noBalance = ethers.utils.parseUnits(balances.noBalance, USDC_DECIMALS);

    if (yesBalance.lt(amountWei) || noBalance.lt(amountWei)) {
      throw new Error(
        `Insufficient token balance. Need ${amount} of each. Have: YES=${balances.yesBalance}, NO=${balances.noBalance}`
      );
    }

    // Use safe amount: min(requested, yesBalance, noBalance)
    let safeAmountWei = amountWei;
    if (yesBalance.lt(safeAmountWei)) safeAmountWei = yesBalance;
    if (noBalance.lt(safeAmountWei)) safeAmountWei = noBalance;

    // Select contract: NegRisk adapter for NegRisk markets, standard CTF otherwise
    const mergeContract = isNegRisk ? this.negRiskAdapterContract : this.ctfContract;

    // Dry-run to catch revert reason before submitting actual transaction
    try {
      await mergeContract.callStatic.mergePositions(
        COLLATERAL_CONTRACT,
        ethers.constants.HashZero,
        conditionId,
        [1, 2],
        safeAmountWei,
      );
    } catch (error: any) {
      const reason = error?.reason || error?.error?.message || error?.message || 'unknown';
      throw new Error(
        `Merge dry-run failed (callStatic reverted): ${reason}. ` +
        `Amount: ${ethers.utils.formatUnits(safeAmountWei, USDC_DECIMALS)}, ` +
        `YES: ${balances.yesBalance}, NO: ${balances.noBalance}, ` +
        `conditionId: ${conditionId}, negRisk: ${isNegRisk}`
      );
    }

    // Execute merge with explicit gasLimit
    const gasOptions = await this.getGasOptions();
    const tx = await mergeContract.mergePositions(
      COLLATERAL_CONTRACT,
      ethers.constants.HashZero,
      conditionId,
      [1, 2],
      safeAmountWei,
      { ...gasOptions, gasLimit: 500000 }
    );

    const receipt = await tx.wait();

    const mergedAmount = ethers.utils.formatUnits(safeAmountWei, USDC_DECIMALS);
    return {
      success: true,
      txHash: receipt.transactionHash,
      amount: mergedAmount,
      usdcReceived: mergedAmount,
      gasUsed: receipt.gasUsed.toString(),
    };
  }

  /**
   * Redeem winning tokens after market resolution (Standard CTF)
   *
   * IMPORTANT: This method calculates position IDs locally using the current
   * V2 collateral (pUSD). Polymarket's official docs define token ID /
   * asset ID / position ID as the same ERC-1155 identifier, but manual
   * calculation is fragile because every input must match the market exactly.
   *
   * For Polymarket CLOB markets, prefer `redeemByTokenIds()` with IDs from
   * Gamma `clobTokenIds` or CLOB `tokens[]` instead of hand calculation.
   *
   * @param conditionId - Market condition ID
   * @param outcome - 'YES' or 'NO' (optional, auto-detects if not provided)
   * @returns RedeemResult with transaction details
   *
   * @example
   * ```typescript
   * // Prefer redeemByTokenIds() for Polymarket CLOB markets.
   * const result = await ctf.redeem(conditionId);
   * console.log(`Redeemed ${result.tokensRedeemed} ${result.outcome} tokens`);
   * ```
   *
   * @see redeemByTokenIds - Use this for Polymarket CLOB markets
   */
  async redeem(conditionId: string, outcome?: string): Promise<RedeemResult> {
    this.ensureNotReadOnly('redeem');
    // Check resolution status
    const resolution = await this.getMarketResolution(conditionId);
    if (!resolution.isResolved) {
      throw new Error('Market is not resolved yet');
    }

    // Auto-detect outcome if not provided
    const winningOutcome = outcome || resolution.winningOutcome;
    if (!winningOutcome) {
      throw new Error('Could not determine winning outcome');
    }

    // Get token balance
    const balances = await this.getPositionBalance(conditionId);
    const tokenBalance = winningOutcome === 'YES' ? balances.yesBalance : balances.noBalance;

    if (parseFloat(tokenBalance) === 0) {
      throw new Error(`No ${winningOutcome} tokens to redeem`);
    }

    // indexSets: [1] for YES, [2] for NO
    const indexSets = winningOutcome === 'YES' ? [1] : [2];

    const tx = await this.ctfContract.redeemPositions(
      COLLATERAL_CONTRACT,
      ethers.constants.HashZero,
      conditionId,
      indexSets,
      await this.getGasOptions()
    );

    const receipt = await tx.wait();

    return {
      success: true,
      txHash: receipt.transactionHash,
      outcome: winningOutcome,
      tokensRedeemed: tokenBalance,
      usdcReceived: tokenBalance, // 1:1 for winning outcome
      gasUsed: receipt.gasUsed.toString(),
    };
  }

  /**
   * Redeem winning tokens using Polymarket token IDs (Polymarket CLOB)
   *
   * ✅ USE THIS for Polymarket CLOB markets!
   *
   * Polymarket token IDs are the CTF position IDs / asset IDs for the
   * outcome tokens. They are provided by Gamma/CLOB APIs and should be used
   * for:
   * - Querying balances (getPositionBalanceByTokenIds)
   * - Redeeming positions (this method)
   * - Trading via CLOB API
   *
   * Manual calculation should be avoided in SDK code. If a calculated ID does
   * not match, the usual causes are wrong collateral token, oracle,
   * condition/question ID, index set, or V1/V2 context.
   *
   * @param conditionId - The condition ID of the market
   * @param tokenIds - The Polymarket token IDs for YES and NO outcomes (from CLOB API)
   * @param outcome - Optional: which outcome to redeem ('YES' or 'NO'). Auto-detects if not provided.
   * @returns RedeemResult with transaction details
   *
   * @example
   * ```typescript
   * // For Polymarket CLOB markets
   * const tokenIds = {
   *   yesTokenId: '25064375110792967023484002819116042931016336431092144471807003884255851454283',
   *   noTokenId: '98190367690492181203391990709979106077460946443309150166954079213761598385827',
   * };
   * const result = await ctf.redeemByTokenIds(conditionId, tokenIds);
   * console.log(`Redeemed ${result.tokensRedeemed} ${result.outcome} tokens`);
   * console.log(`Received ${result.usdcReceived} pUSD`);
   * ```
   *
   * @see redeem - Only use for standard CTF markets (non-Polymarket)
   */
  async redeemByTokenIds(
    conditionId: string,
    tokenIds: TokenIds,
    outcome?: string,
    isNegRisk = false,
  ): Promise<RedeemResult> {
    this.ensureNotReadOnly('redeemByTokenIds');
    // Check resolution status
    const resolution = await this.getMarketResolution(conditionId);
    if (!resolution.isResolved) {
      throw new Error('Market is not resolved yet');
    }

    // Auto-detect outcome if not provided
    const winningOutcome = outcome || resolution.winningOutcome;
    if (!winningOutcome) {
      throw new Error('Could not determine winning outcome');
    }

    // Get token balance using Polymarket token IDs
    const balances = await this.getPositionBalanceByTokenIds(conditionId, tokenIds);
    const yesBalance = balances.yesBalance;
    const noBalance = balances.noBalance;
    const tokenBalance = winningOutcome === 'YES' ? yesBalance : noBalance;

    if (parseFloat(tokenBalance) === 0) {
      throw new Error(`No ${winningOutcome} tokens to redeem`);
    }

    const gasOptions = await this.getGasOptions();
    let tx;

    if (isNegRisk) {
      // NegRisk adapter: redeemPositions(conditionId, amounts[])
      // amounts array has one entry per outcome index: [yesAmount, noAmount]
      const yesAmountWei = ethers.utils.parseUnits(yesBalance, USDC_DECIMALS);
      const noAmountWei = ethers.utils.parseUnits(noBalance, USDC_DECIMALS);
      tx = await this.negRiskAdapterContract.redeemPositions(
        conditionId,
        [yesAmountWei, noAmountWei],
        { ...gasOptions, gasLimit: 500000 }
      );
    } else {
      // Standard CTF: redeemPositions(collateral, parentCollectionId, conditionId, indexSets)
      const indexSets = winningOutcome === 'YES' ? [1] : [2];
      tx = await this.ctfContract.redeemPositions(
        COLLATERAL_CONTRACT,
        ethers.constants.HashZero,
        conditionId,
        indexSets,
        gasOptions
      );
    }

    const receipt = await tx.wait();

    return {
      success: true,
      txHash: receipt.transactionHash,
      outcome: winningOutcome,
      tokensRedeemed: tokenBalance,
      usdcReceived: tokenBalance, // 1:1 for winning outcome
      gasUsed: receipt.gasUsed.toString(),
    };
  }

  /**
   * Get token balances for a market using calculated position IDs
   *
   * NOTE: This method calculates position IDs from conditionId, which may not match
   * the token IDs used by Polymarket's CLOB API. For accurate balances when working
   * with CLOB markets, use getPositionBalanceByTokenIds() with the token IDs from
   * the CLOB API.
   *
   * @deprecated Use getPositionBalanceByTokenIds for CLOB markets
   */
  async getPositionBalance(conditionId: string): Promise<PositionBalance> {
    this.ensureNotReadOnly('getPositionBalance');
    const yesPositionId = this.calculatePositionId(conditionId, 1);
    const noPositionId = this.calculatePositionId(conditionId, 2);

    const [yesBalance, noBalance] = await Promise.all([
      this.ctfContract.balanceOf(this.wallet!.address, yesPositionId),
      this.ctfContract.balanceOf(this.wallet!.address, noPositionId),
    ]);

    return {
      conditionId,
      yesBalance: ethers.utils.formatUnits(yesBalance, USDC_DECIMALS),
      noBalance: ethers.utils.formatUnits(noBalance, USDC_DECIMALS),
      yesPositionId,
      noPositionId,
    };
  }

  /**
   * Get token balances using CLOB API token IDs
   *
   * This is the recommended method for checking balances when working with
   * Polymarket CLOB markets. The token IDs should be obtained from the CLOB API
   * (e.g., from ClobApiClient.getMarket()).
   *
   * @param conditionId - Market condition ID (for reference)
   * @param tokenIds - Token IDs from CLOB API { yesTokenId, noTokenId }
   * @returns PositionBalance with accurate balances
   *
   * @example
   * ```typescript
   * // Get token IDs from CLOB API
   * const market = await clobApi.getMarket(conditionId);
   * const tokenIds = {
   *   yesTokenId: market.tokens[0].tokenId,
   *   noTokenId: market.tokens[1].tokenId,
   * };
   *
   * // Check balances
   * const balance = await ctf.getPositionBalanceByTokenIds(conditionId, tokenIds);
   * console.log(`YES: ${balance.yesBalance}, NO: ${balance.noBalance}`);
   * ```
   */
  async getPositionBalanceByTokenIds(
    conditionId: string,
    tokenIds: TokenIds
  ): Promise<PositionBalance> {
    this.ensureNotReadOnly('getPositionBalanceByTokenIds');
    const [yesBalance, noBalance] = await Promise.all([
      this.ctfContract.balanceOf(this.wallet!.address, tokenIds.yesTokenId),
      this.ctfContract.balanceOf(this.wallet!.address, tokenIds.noTokenId),
    ]);

    return {
      conditionId,
      yesBalance: ethers.utils.formatUnits(yesBalance, USDC_DECIMALS),
      noBalance: ethers.utils.formatUnits(noBalance, USDC_DECIMALS),
      yesPositionId: tokenIds.yesTokenId,
      noPositionId: tokenIds.noTokenId,
    };
  }

  /**
   * Check if a market is resolved and get payout info
   */
  async getMarketResolution(conditionId: string): Promise<MarketResolution> {
    const [yesNumerator, noNumerator, denominator] = await Promise.all([
      this.ctfContract.payoutNumerators(conditionId, 0),
      this.ctfContract.payoutNumerators(conditionId, 1),
      this.ctfContract.payoutDenominator(conditionId),
    ]);

    const isResolved = denominator.gt(0);
    let winningOutcome: 'YES' | 'NO' | undefined;

    if (isResolved) {
      if (yesNumerator.gt(0) && noNumerator.eq(0)) {
        winningOutcome = 'YES';
      } else if (noNumerator.gt(0) && yesNumerator.eq(0)) {
        winningOutcome = 'NO';
      }
      // If both are non-zero, it's a split resolution (rare)
    }

    return {
      conditionId,
      isResolved,
      winningOutcome,
      payoutNumerators: [yesNumerator.toNumber(), noNumerator.toNumber()],
      payoutDenominator: denominator.toNumber(),
    };
  }

  /**
   * Estimate gas for split operation
   */
  async estimateSplitGas(conditionId: string, amount: string): Promise<string> {
    const amountWei = ethers.utils.parseUnits(amount, USDC_DECIMALS);
    try {
      const gas = await this.ctfContract.estimateGas.splitPosition(
        COLLATERAL_CONTRACT,
        ethers.constants.HashZero,
        conditionId,
        [1, 2],
        amountWei
      );
      return gas.toString();
    } catch {
      // Default estimate if call fails (e.g., insufficient balance)
      return '250000';
    }
  }

  /**
   * Estimate gas for merge operation
   */
  async estimateMergeGas(conditionId: string, amount: string): Promise<string> {
    const amountWei = ethers.utils.parseUnits(amount, USDC_DECIMALS);
    try {
      const gas = await this.ctfContract.estimateGas.mergePositions(
        COLLATERAL_CONTRACT,
        ethers.constants.HashZero,
        conditionId,
        [1, 2],
        amountWei
      );
      return gas.toString();
    } catch {
      return '200000';
    }
  }

  // ===== Gas Estimation (Phase 3) =====

  /**
   * Get detailed gas estimate for a split operation
   */
  async getDetailedSplitGasEstimate(conditionId: string, amount: string): Promise<GasEstimate> {
    const gasUnits = await this.estimateSplitGas(conditionId, amount);
    return this.calculateGasCost(gasUnits);
  }

  /**
   * Get detailed gas estimate for a merge operation
   */
  async getDetailedMergeGasEstimate(conditionId: string, amount: string): Promise<GasEstimate> {
    const gasUnits = await this.estimateMergeGas(conditionId, amount);
    return this.calculateGasCost(gasUnits);
  }

  /**
   * Get current gas price info
   */
  async getGasPrice(): Promise<{ gwei: string; wei: string }> {
    const gasPrice = await this.provider.getGasPrice();
    return {
      gwei: ethers.utils.formatUnits(gasPrice, 'gwei'),
      wei: gasPrice.toString(),
    };
  }

  /**
   * Get or refresh MATIC price (cached for 5 minutes)
   */
  async getMaticPrice(): Promise<number> {
    const now = Date.now();
    const cacheAge = now - this.maticPriceLastUpdated;

    // Use cache if less than 5 minutes old
    if (cacheAge < 5 * 60 * 1000 && this.maticPriceLastUpdated > 0) {
      return this.cachedMaticPrice;
    }

    // In production, this would fetch from an oracle or price feed
    // For now, we return a reasonable estimate
    // Could integrate with Chainlink price feeds or CoinGecko API
    this.cachedMaticPrice = DEFAULT_MATIC_PRICE;
    this.maticPriceLastUpdated = now;

    return this.cachedMaticPrice;
  }

  /**
   * Set MATIC price manually (for testing or when external price is available)
   */
  setMaticPrice(price: number): void {
    this.cachedMaticPrice = price;
    this.maticPriceLastUpdated = Date.now();
  }

  // ===== Transaction Monitoring (Phase 3) =====

  /**
   * Get transaction status with detailed info
   */
  async getTransactionStatus(txHash: string): Promise<TransactionStatus> {
    try {
      const receipt = await this.provider.getTransactionReceipt(txHash);

      if (!receipt) {
        // Transaction is pending
        const tx = await this.provider.getTransaction(txHash);
        if (!tx) {
          return {
            txHash,
            status: 'failed',
            confirmations: 0,
            errorReason: 'Transaction not found',
          };
        }
        return {
          txHash,
          status: 'pending',
          confirmations: 0,
        };
      }

      const currentBlock = await this.provider.getBlockNumber();
      const confirmations = currentBlock - receipt.blockNumber + 1;

      if (receipt.status === 0) {
        // Transaction reverted
        const reason = await this.getRevertReason(txHash);
        return {
          txHash,
          status: 'reverted',
          confirmations,
          blockNumber: receipt.blockNumber,
          gasUsed: receipt.gasUsed.toString(),
          effectiveGasPrice: receipt.effectiveGasPrice?.toString(),
          errorReason: reason,
        };
      }

      return {
        txHash,
        status: 'confirmed',
        confirmations,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed.toString(),
        effectiveGasPrice: receipt.effectiveGasPrice?.toString(),
      };
    } catch (error) {
      return {
        txHash,
        status: 'failed',
        confirmations: 0,
        errorReason: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Wait for transaction confirmation with timeout
   */
  async waitForTransaction(txHash: string, confirmations?: number): Promise<TransactionStatus> {
    const targetConfirmations = confirmations ?? this.confirmations;
    const startTime = Date.now();

    while (Date.now() - startTime < this.txTimeout) {
      const status = await this.getTransactionStatus(txHash);

      if (status.status === 'reverted' || status.status === 'failed') {
        return status;
      }

      if (status.status === 'confirmed' && status.confirmations >= targetConfirmations) {
        return status;
      }

      // Wait 2 seconds before checking again
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    return {
      txHash,
      status: 'pending',
      confirmations: 0,
      errorReason: `Timeout after ${this.txTimeout}ms`,
    };
  }

  /**
   * Parse revert reason from transaction
   */
  async getRevertReason(txHash: string): Promise<string> {
    try {
      const tx = await this.provider.getTransaction(txHash);
      if (!tx) return RevertReason.UNKNOWN;

      const receipt = await this.provider.getTransactionReceipt(txHash);
      if (!receipt || receipt.status !== 0) return RevertReason.UNKNOWN;

      // Try to call the transaction to get the revert reason
      try {
        await this.provider.call(tx as ethers.providers.TransactionRequest, tx.blockNumber);
        return RevertReason.UNKNOWN;
      } catch (error: unknown) {
        const err = error as { reason?: string; message?: string; data?: string };
        if (err.reason) return err.reason;
        if (err.message) {
          // Parse common error messages
          if (err.message.includes('insufficient balance')) {
            return RevertReason.INSUFFICIENT_BALANCE;
          }
          if (err.message.includes('allowance')) {
            return RevertReason.INSUFFICIENT_ALLOWANCE;
          }
          if (err.message.includes('condition not resolved')) {
            return RevertReason.CONDITION_NOT_RESOLVED;
          }
          return err.message;
        }
        return RevertReason.EXECUTION_REVERTED;
      }
    } catch {
      return RevertReason.UNKNOWN;
    }
  }

  // ===== Position Tracking (Phase 3) =====

  /**
   * Get all positions for the wallet across multiple markets
   */
  async getAllPositions(conditionIds: string[]): Promise<PositionBalance[]> {
    const positions: PositionBalance[] = [];

    for (const conditionId of conditionIds) {
      try {
        const balance = await this.getPositionBalance(conditionId);
        // Only include non-zero balances
        if (parseFloat(balance.yesBalance) > 0 || parseFloat(balance.noBalance) > 0) {
          positions.push(balance);
        }
      } catch {
        // Skip errors for individual markets
      }
    }

    return positions;
  }

  /**
   * Check if wallet has sufficient tokens for merge
   *
   * @deprecated Use canMergeWithTokenIds for CLOB markets
   */
  async canMerge(conditionId: string, amount: string): Promise<{ canMerge: boolean; reason?: string }> {
    try {
      const balances = await this.getPositionBalance(conditionId);
      return this.checkMergeBalance(balances, amount);
    } catch (error) {
      return {
        canMerge: false,
        reason: error instanceof Error ? error.message : 'Failed to check balances'
      };
    }
  }

  /**
   * Check if wallet has sufficient tokens for merge using CLOB token IDs
   *
   * @param conditionId - Market condition ID
   * @param tokenIds - Token IDs from CLOB API
   * @param amount - Amount to merge
   */
  async canMergeWithTokenIds(
    conditionId: string,
    tokenIds: TokenIds,
    amount: string
  ): Promise<{ canMerge: boolean; reason?: string }> {
    try {
      const balances = await this.getPositionBalanceByTokenIds(conditionId, tokenIds);
      return this.checkMergeBalance(balances, amount);
    } catch (error) {
      return {
        canMerge: false,
        reason: error instanceof Error ? error.message : 'Failed to check balances'
      };
    }
  }

  private checkMergeBalance(
    balances: PositionBalance,
    amount: string
  ): { canMerge: boolean; reason?: string } {
    const amountNum = parseFloat(amount);
    const yesBalance = parseFloat(balances.yesBalance);
    const noBalance = parseFloat(balances.noBalance);

    if (yesBalance < amountNum) {
      return {
        canMerge: false,
        reason: `Insufficient YES tokens. Have: ${yesBalance}, Need: ${amountNum}`
      };
    }
    if (noBalance < amountNum) {
      return {
        canMerge: false,
        reason: `Insufficient NO tokens. Have: ${noBalance}, Need: ${amountNum}`
      };
    }

    return { canMerge: true };
  }

  /**
   * Check if wallet has sufficient pUSD for split
   */
  async canSplit(amount: string): Promise<{ canSplit: boolean; reason?: string }> {
    try {
      const balance = await this.getPusdBalance();
      const balanceNum = parseFloat(balance);
      const amountNum = parseFloat(amount);

      if (balanceNum < amountNum) {
        return {
          canSplit: false,
          reason: `Insufficient pUSD. Have: ${balance}, Need: ${amount}`
        };
      }

      return { canSplit: true };
    } catch (error) {
      return {
        canSplit: false,
        reason: error instanceof Error ? error.message : 'Failed to check balance'
      };
    }
  }

  /**
   * Get total portfolio value across positions
   */
  async getPortfolioValue(positions: PositionBalance[], prices: Map<string, { yes: number; no: number }>): Promise<{
    totalValue: number;
    breakdown: Array<{
      conditionId: string;
      yesValue: number;
      noValue: number;
      totalValue: number;
    }>;
  }> {
    let totalValue = 0;
    const breakdown: Array<{
      conditionId: string;
      yesValue: number;
      noValue: number;
      totalValue: number;
    }> = [];

    for (const position of positions) {
      const price = prices.get(position.conditionId);
      if (!price) continue;

      const yesValue = parseFloat(position.yesBalance) * price.yes;
      const noValue = parseFloat(position.noBalance) * price.no;
      const positionValue = yesValue + noValue;

      totalValue += positionValue;
      breakdown.push({
        conditionId: position.conditionId,
        yesValue,
        noValue,
        totalValue: positionValue,
      });
    }

    return { totalValue, breakdown };
  }

  // ===== Private Helpers =====


  /**
   * Calculate position ID for a given outcome (INTERNAL USE ONLY).
   *
   * Token ID, asset ID, and CTF position ID refer to the same ERC-1155 ID in
   * current Polymarket docs. This helper exists for direct contract work, but
   * SDK code should still prefer API-provided token IDs because manual
   * calculation is easy to get wrong.
   *
   * For Polymarket CLOB markets, prefer:
   * 1. Get token IDs from Gamma `clobTokenIds` or CLOB `tokens[]`
   * 2. Use getPositionBalanceByTokenIds()
   * 3. Use mergeByTokenIds()
   * 4. Use redeemByTokenIds()
   *
   * @deprecated Prefer API token IDs for Polymarket markets.
   */
  private calculatePositionId(conditionId: string, indexSet: number): string {
    // Collection ID - must use solidityPack (abi.encodePacked) to match CTF contract
    const collectionId = ethers.utils.keccak256(
      ethers.utils.solidityPack(
        ['bytes32', 'bytes32', 'uint256'],
        [ethers.constants.HashZero, conditionId, indexSet]
      )
    );

    // Position ID - must use solidityPack (abi.encodePacked) to match CTF contract
    const positionId = ethers.utils.keccak256(
      ethers.utils.solidityPack(
        ['address', 'bytes32'],
        [COLLATERAL_CONTRACT, collectionId]
      )
    );

    return positionId;
  }

  /**
   * Get gas options for Polygon network using EIP-1559
   *
   * Polygon requires higher priority fees than default ethers.js estimates.
   * Uses minimum 30 gwei priority fee to ensure transactions don't get stuck.
   */
  private async getGasOptions(): Promise<{
    maxPriorityFeePerGas: BigNumber;
    maxFeePerGas: BigNumber;
  }> {
    const feeData = await this.provider.getFeeData();
    const baseFee = feeData.lastBaseFeePerGas || feeData.gasPrice || ethers.utils.parseUnits('100', 'gwei');

    // Minimum 30 gwei priority fee for Polygon
    const minPriorityFee = ethers.utils.parseUnits('30', 'gwei');
    const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas && feeData.maxPriorityFeePerGas.gt(minPriorityFee)
      ? feeData.maxPriorityFeePerGas
      : minPriorityFee;

    // Apply multiplier to base fee and add priority fee
    const adjustedBaseFee = baseFee.mul(Math.floor(this.gasPriceMultiplier * 100)).div(100);
    const maxFeePerGas = adjustedBaseFee.add(maxPriorityFeePerGas);

    return { maxPriorityFeePerGas, maxFeePerGas };
  }

  /**
   * Calculate gas cost from gas units
   */
  private async calculateGasCost(gasUnits: string): Promise<GasEstimate> {
    const gasOptions = await this.getGasOptions();
    const effectiveGasPrice = gasOptions.maxFeePerGas;

    const gasUnitsNum = BigNumber.from(gasUnits);
    const costWei = gasUnitsNum.mul(effectiveGasPrice);
    const costMatic = parseFloat(ethers.utils.formatEther(costWei));

    const maticPrice = await this.getMaticPrice();
    const costUsdc = costMatic * maticPrice;

    return {
      gasUnits,
      gasPriceGwei: ethers.utils.formatUnits(effectiveGasPrice, 'gwei'),
      costMatic: costMatic.toFixed(6),
      costUsdc: costUsdc.toFixed(4),
      maticPrice,
    };
  }
}

// ===== Utility Functions =====

/**
 * Calculate condition ID from oracle, question ID, and outcome count
 * This is rarely needed as Polymarket provides conditionId directly
 */
export function calculateConditionId(
  oracle: string,
  questionId: string,
  outcomeSlotCount: number = 2
): string {
  return ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      ['address', 'bytes32', 'uint256'],
      [oracle, questionId, outcomeSlotCount]
    )
  );
}

/**
 * Parse pUSD amount to BigNumber (6 decimals).
 *
 * @deprecated Use parseCollateralAmount for new code.
 */
export function parseUsdc(amount: string): BigNumber {
  return ethers.utils.parseUnits(amount, USDC_DECIMALS);
}

/**
 * Format pUSD amount from BigNumber (6 decimals).
 *
 * @deprecated Use formatCollateralAmount for new code.
 */
export function formatUsdc(amount: BigNumber): string {
  return ethers.utils.formatUnits(amount, USDC_DECIMALS);
}

/** Parse a 6-decimal collateral amount. */
export function parseCollateralAmount(amount: string): BigNumber {
  return ethers.utils.parseUnits(amount, USDC_DECIMALS);
}

/** Format a 6-decimal collateral amount. */
export function formatCollateralAmount(amount: BigNumber): string {
  return ethers.utils.formatUnits(amount, USDC_DECIMALS);
}
