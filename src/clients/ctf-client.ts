/**
 * CTF (Conditional Token Framework) Client
 *
 * Provides on-chain operations for Polymarket's conditional tokens:
 * - Split: USDC → YES + NO token pair
 * - Merge: YES + NO → USDC
 * - Redeem: Winning tokens → USDC (after market resolution)
 *
 * ⚠️ CRITICAL: Polymarket CTF uses USDC.e (bridged), NOT native USDC!
 *
 * | Token         | Address                                    | CTF Compatible |
 * |---------------|--------------------------------------------|-----------------
 * | USDC.e        | 0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174 | ✅ Yes         |
 * | Native USDC   | 0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359 | ❌ No          |
 *
 * Common Mistake:
 * - Your wallet has native USDC but CTF operations fail
 * - Solution: Use SwapService.transferUsdcE() or swap native USDC to USDC.e
 *
 * Based on: docs/01-product-research/06-poly-sdk/05-ctf-integration-plan.md
 *
 * Contract: Gnosis Conditional Tokens on Polygon
 * https://docs.polymarket.com/developers/CTF/overview
 */

import { ethers, Contract, Wallet, BigNumber } from 'ethers';

// ===== Contract Addresses (Polygon Mainnet) =====

export const CTF_CONTRACT = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';

/**
 * USDC.e (Bridged USDC) - The ONLY USDC accepted by Polymarket CTF
 *
 * ⚠️ WARNING: This is NOT native USDC (0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359)
 *
 * If your wallet has native USDC but CTF operations fail with "Insufficient USDC balance",
 * you need to swap your native USDC to USDC.e first using:
 * - SwapService.swap('USDC', 'USDC_E', amount)
 * - Or transfer USDC.e using SwapService.transferUsdcE()
 */
export const USDC_CONTRACT = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

/** Native USDC on Polygon - NOT compatible with CTF */
export const NATIVE_USDC_CONTRACT = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';

export const NEG_RISK_CTF_EXCHANGE = '0xC5d563A36AE78145C45a50134d48A1215220f80a';
export const NEG_RISK_ADAPTER = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';

/** CTF Exchange — Polymarket order matching contract for standard markets */
export const CTF_EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';

// USDC.e uses 6 decimals
export const USDC_DECIMALS = 6;

// ===== ABIs =====

const CTF_ABI = [
  // Split: USDC → YES + NO
  'function splitPosition(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount) external',
  // Merge: YES + NO → USDC
  'function mergePositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount) external',
  // Redeem: Winning tokens → USDC
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
  /** Private key for signing transactions */
  privateKey: string;
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
  private wallet: Wallet;
  private ctfContract: Contract;
  private negRiskAdapterContract: Contract;
  private usdcContract: Contract;
  private gasPriceMultiplier: number;
  private confirmations: number;
  private txTimeout: number;
  private cachedMaticPrice: number = DEFAULT_MATIC_PRICE;
  private maticPriceLastUpdated: number = 0;

  constructor(config: CTFConfig) {
    const rpcUrl = config.rpcUrl || 'https://polygon-rpc.com';
    this.provider = new ethers.providers.JsonRpcProvider(rpcUrl);
    this.wallet = new Wallet(config.privateKey, this.provider);
    this.ctfContract = new Contract(CTF_CONTRACT, CTF_ABI, this.wallet);
    this.negRiskAdapterContract = new Contract(NEG_RISK_ADAPTER, NEG_RISK_ADAPTER_ABI, this.wallet);
    this.usdcContract = new Contract(USDC_CONTRACT, ERC20_ABI, this.wallet);
    this.gasPriceMultiplier = config.gasPriceMultiplier || 1.2;
    this.confirmations = config.confirmations || 1;
    this.txTimeout = config.txTimeout || 60000;
  }

  /**
   * Get wallet address
   */
  getAddress(): string {
    return this.wallet.address;
  }

  /**
   * Get USDC.e (bridged USDC) balance - the token used by Polymarket CTF
   *
   * ⚠️ Note: This returns USDC.e balance, NOT native USDC balance.
   * Polymarket CTF only accepts USDC.e (0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174).
   *
   * Common issue: Your wallet shows USDC balance but this returns 0
   * - This means you have native USDC, not USDC.e
   * - Use SwapService.swap('USDC', 'USDC_E', amount) to convert
   */
  async getUsdcBalance(): Promise<string> {
    const balance = await this.usdcContract.balanceOf(this.wallet.address);
    return ethers.utils.formatUnits(balance, USDC_DECIMALS);
  }

  /**
   * Get native USDC balance (for comparison/debugging)
   *
   * This is NOT the token used by CTF. Use getUsdcBalance() for CTF operations.
   */
  async getNativeUsdcBalance(): Promise<string> {
    const nativeUsdcContract = new Contract(NATIVE_USDC_CONTRACT, ERC20_ABI, this.provider);
    const balance = await nativeUsdcContract.balanceOf(this.wallet.address);
    return ethers.utils.formatUnits(balance, USDC_DECIMALS);
  }

  /**
   * Check if wallet is ready for CTF trading operations
   *
   * Verifies:
   * - Has sufficient USDC.e (not native USDC)
   * - Has MATIC for gas fees
   *
   * @param amount - Minimum USDC.e amount needed (e.g., "100" for 100 USDC.e)
   * @returns Ready status with balances and suggestions
   *
   * @example
   * ```typescript
   * const status = await ctf.checkReadyForCTF('100');
   * if (!status.ready) {
   *   console.log(status.suggestion);
   *   // "You have 50 native USDC but 0 USDC.e. Swap native USDC to USDC.e first."
   * }
   * ```
   */
  async checkReadyForCTF(amount: string): Promise<{
    ready: boolean;
    usdcEBalance: string;
    nativeUsdcBalance: string;
    maticBalance: string;
    suggestion?: string;
  }> {
    const [usdcE, nativeUsdc, matic] = await Promise.all([
      this.getUsdcBalance(),
      this.getNativeUsdcBalance(),
      this.provider.getBalance(this.wallet.address),
    ]);

    const usdcEBalance = parseFloat(usdcE);
    const nativeUsdcBalance = parseFloat(nativeUsdc);
    const maticBalance = parseFloat(ethers.utils.formatEther(matic));
    const amountNeeded = parseFloat(amount);

    const result = {
      ready: false,
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

    // Check USDC.e balance
    if (usdcEBalance < amountNeeded) {
      if (nativeUsdcBalance >= amountNeeded) {
        result.suggestion = `You have ${nativeUsdcBalance.toFixed(2)} native USDC but only ${usdcEBalance.toFixed(2)} USDC.e. ` +
          `Polymarket CTF requires USDC.e. Use SwapService.swap('USDC', 'USDC_E', '${amount}') to convert.`;
      } else if (nativeUsdcBalance > 0) {
        result.suggestion = `Insufficient USDC.e. Have: ${usdcEBalance.toFixed(2)} USDC.e + ${nativeUsdcBalance.toFixed(2)} native USDC, need: ${amount} USDC.e. ` +
          `Swap all native USDC to USDC.e, then add more funds.`;
      } else {
        result.suggestion = `Insufficient USDC.e. Have: ${usdcEBalance.toFixed(2)} USDC.e, need: ${amount} USDC.e.`;
      }
      return result;
    }

    result.ready = true;
    return result;
  }

  /**
   * Split USDC into YES + NO tokens
   *
   * @param conditionId - Market condition ID
   * @param amount - USDC amount (e.g., "100" for 100 USDC)
   * @returns SplitResult with transaction details
   *
   * @example
   * ```typescript
   * const result = await ctf.split(conditionId, "100");
   * console.log(`Split ${result.amount} USDC into tokens`);
   * console.log(`TX: ${result.txHash}`);
   * ```
   */
  async split(conditionId: string, amount: string): Promise<SplitResult> {
    const amountWei = ethers.utils.parseUnits(amount, USDC_DECIMALS);

    // 1. Check USDC balance
    const balance = await this.usdcContract.balanceOf(this.wallet.address);
    if (balance.lt(amountWei)) {
      throw new Error(`Insufficient USDC balance. Have: ${ethers.utils.formatUnits(balance, USDC_DECIMALS)}, Need: ${amount}`);
    }

    // 2. Check and approve USDC if needed
    const allowance = await this.usdcContract.allowance(this.wallet.address, CTF_CONTRACT);
    if (allowance.lt(amountWei)) {
      const approveTx = await this.usdcContract.approve(
        CTF_CONTRACT,
        ethers.constants.MaxUint256,
        await this.getGasOptions()
      );
      await approveTx.wait();
    }

    // 3. Execute split
    // Partition [1, 2] represents [YES, NO] outcomes
    const tx = await this.ctfContract.splitPosition(
      USDC_CONTRACT,
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
   * Split USDC into YES + NO tokens using explicit token IDs
   *
   * Supports both standard CTF and NegRisk markets:
   * - Standard: uses CTF contract directly
   * - NegRisk: uses NegRisk Adapter (wraps CTF with wrapped collateral)
   *
   * @param conditionId - Market condition ID (from CLOB API)
   * @param tokenIds - Token IDs from CLOB API
   * @param amount - USDC amount (e.g., "100" for 100 USDC)
   * @param isNegRisk - Whether this market uses NegRisk (from CLOB API neg_risk field)
   * @returns SplitResult with transaction details
   */
  async splitByTokenIds(conditionId: string, tokenIds: TokenIds, amount: string, isNegRisk = false): Promise<SplitResult> {
    const amountWei = ethers.utils.parseUnits(amount, USDC_DECIMALS);

    const balance = await this.usdcContract.balanceOf(this.wallet.address);
    if (balance.lt(amountWei)) {
      throw new Error(`Insufficient USDC balance. Have: ${ethers.utils.formatUnits(balance, USDC_DECIMALS)}, Need: ${amount}`);
    }

    const targetContract = isNegRisk ? NEG_RISK_ADAPTER : CTF_CONTRACT;
    const splitContract = isNegRisk ? this.negRiskAdapterContract : this.ctfContract;

    // Check and approve USDC for the target contract
    const allowance = await this.usdcContract.allowance(this.wallet.address, targetContract);
    if (allowance.lt(amountWei)) {
      const approveTx = await this.usdcContract.approve(
        targetContract,
        ethers.constants.MaxUint256,
        await this.getGasOptions()
      );
      await approveTx.wait();
    }

    const tx = await splitContract.splitPosition(
      USDC_CONTRACT,
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
   * Merge YES + NO tokens back to USDC
   *
   * @param conditionId - Market condition ID
   * @param amount - Number of token pairs to merge (e.g., "100" for 100 YES + 100 NO)
   * @returns MergeResult with transaction details
   *
   * @example
   * ```typescript
   * // After buying 100 YES and 100 NO via TradingClient
   * const result = await ctf.merge(conditionId, "100");
   * console.log(`Received ${result.usdcReceived} USDC`);
   * ```
   */
  async merge(conditionId: string, amount: string): Promise<MergeResult> {
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
        USDC_CONTRACT,
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
      USDC_CONTRACT,
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
   * Merge YES and NO tokens back into USDC using explicit token IDs
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
        USDC_CONTRACT,
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
      USDC_CONTRACT,
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
   * ⚠️ IMPORTANT: This method uses standard CTF position ID calculation.
   * It is ONLY suitable for:
   * - Standard Gnosis CTF markets (non-Polymarket)
   * - Markets where position IDs are calculated from conditionId using standard formula
   * - Direct CTF contract interactions without CLOB
   *
   * ❌ DO NOT USE for Polymarket CLOB markets!
   * Polymarket uses custom token IDs that differ from standard CTF position IDs.
   * For Polymarket, use `redeemByTokenIds()` instead.
   *
   * Position ID calculation: keccak256(collectionId, conditionId, indexSet)
   * - This formula may NOT match Polymarket's token IDs
   *
   * @param conditionId - Market condition ID
   * @param outcome - 'YES' or 'NO' (optional, auto-detects if not provided)
   * @returns RedeemResult with transaction details
   *
   * @example
   * ```typescript
   * // For standard CTF markets (NOT Polymarket)
   * const result = await ctf.redeem(conditionId);
   * console.log(`Redeemed ${result.tokensRedeemed} ${result.outcome} tokens`);
   * ```
   *
   * @see redeemByTokenIds - Use this for Polymarket CLOB markets
   */
  async redeem(conditionId: string, outcome?: string): Promise<RedeemResult> {
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
      USDC_CONTRACT,
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
   * Polymarket uses custom token IDs that are different from standard CTF position IDs.
   * These token IDs are provided by the CLOB API and must be used for:
   * - Querying balances (getPositionBalanceByTokenIds)
   * - Redeeming positions (this method)
   * - Trading via CLOB API
   *
   * Why Polymarket token IDs differ:
   * - Polymarket wraps CTF positions into ERC-1155 tokens with custom IDs
   * - The token IDs from CLOB API (e.g., "25064375...") are NOT the same as
   *   calculated position IDs from keccak256(collectionId, conditionId, indexSet)
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
   * console.log(`Received ${result.usdcReceived} USDC`);
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
        USDC_CONTRACT,
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
    const yesPositionId = this.calculatePositionId(conditionId, 1);
    const noPositionId = this.calculatePositionId(conditionId, 2);

    const [yesBalance, noBalance] = await Promise.all([
      this.ctfContract.balanceOf(this.wallet.address, yesPositionId),
      this.ctfContract.balanceOf(this.wallet.address, noPositionId),
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
    const [yesBalance, noBalance] = await Promise.all([
      this.ctfContract.balanceOf(this.wallet.address, tokenIds.yesTokenId),
      this.ctfContract.balanceOf(this.wallet.address, tokenIds.noTokenId),
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
        USDC_CONTRACT,
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
        USDC_CONTRACT,
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
   * Check if wallet has sufficient USDC for split
   */
  async canSplit(amount: string): Promise<{ canSplit: boolean; reason?: string }> {
    try {
      const balance = await this.getUsdcBalance();
      const balanceNum = parseFloat(balance);
      const amountNum = parseFloat(amount);

      if (balanceNum < amountNum) {
        return {
          canSplit: false,
          reason: `Insufficient USDC. Have: ${balance}, Need: ${amount}`
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
   * Calculate position ID for a given outcome (INTERNAL USE ONLY)
   *
   * ⚠️ WARNING: This calculation does NOT produce correct Polymarket token IDs!
   *
   * Polymarket uses custom token IDs that differ from standard CTF position ID calculation.
   * The token IDs from CLOB API (e.g., "104173557214744537570424345347209544585775842950109756851652855913015295701992")
   * are NOT the same as what this function calculates.
   *
   * For Polymarket CLOB markets, ALWAYS:
   * 1. Get token IDs from CLOB API: https://clob.polymarket.com/markets/{conditionId}
   * 2. Use getPositionBalanceByTokenIds() instead of getPositionBalance()
   * 3. Use mergeByTokenIds() instead of merge()
   * 4. Use redeemByTokenIds() instead of redeem()
   *
   * This method is kept for potential non-Polymarket CTF markets only.
   *
   * @deprecated Use CLOB API token IDs for Polymarket markets
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
        [USDC_CONTRACT, collectionId]
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
 * Parse USDC amount to BigNumber (6 decimals)
 */
export function parseUsdc(amount: string): BigNumber {
  return ethers.utils.parseUnits(amount, USDC_DECIMALS);
}

/**
 * Format BigNumber to USDC string (6 decimals)
 */
export function formatUsdc(amount: BigNumber): string {
  return ethers.utils.formatUnits(amount, USDC_DECIMALS);
}
