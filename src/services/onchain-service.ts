/**
 * OnchainService - Unified interface for all on-chain operations
 *
 * Consolidates:
 * - CTF operations (split, merge, redeem)
 * - Authorization (ERC20/ERC1155 approvals)
 * - Swaps (QuickSwap V3)
 *
 * This service provides a single entry point for all blockchain interactions
 * required for Polymarket trading. It shares wallet/provider configuration
 * across all underlying services.
 *
 * @example
 * ```typescript
 * const onchain = new OnchainService({
 *   privateKey: '0x...',
 *   rpcUrl: 'https://polygon-rpc.com', // optional
 * });
 *
 * // Check if ready for trading
 * const status = await onchain.checkReadyForCTF('100');
 * if (!status.ready) {
 *   // Set up approvals
 *   await onchain.approveAll();
 * }
 *
 * // Execute CTF operations
 * await onchain.split(conditionId, '100');
 * await onchain.merge(conditionId, '100');
 *
 * // Swap tokens
 * await onchain.swap('MATIC', 'USDC_E', '10');
 * ```
 */

import { ethers } from 'ethers';

// Import underlying services
import {
  CTFClient,
  type CTFConfig,
  type SplitResult,
  type MergeResult,
  type RedeemResult,
  type PositionBalance,
  type MarketResolution,
  type GasEstimate,
  type TransactionStatus,
  type TokenIds,
} from '../clients/ctf-client.js';

import {
  AuthorizationService,
  type AllowancesResult,
  type ApprovalsResult,
  type ApprovalTxResult,
} from './authorization-service.js';

import {
  SwapService,
  type SwapQuote,
  type SwapResult,
  type TokenBalance,
  type TransferResult,
  type QuoteResult,
  type PoolInfo,
} from './swap-service.js';

// ===== Types =====

export interface OnchainServiceConfig {
  /** Private key for signing transactions */
  privateKey: string;
  /** RPC URL (default: Polygon mainnet) */
  rpcUrl?: string;
  /** Chain ID (default: 137 for Polygon) */
  chainId?: number;
  /** Gas price multiplier for CTF operations (default: 1.2) */
  gasPriceMultiplier?: number;
  /** Transaction confirmation blocks (default: 1) */
  confirmations?: number;
  /** Transaction timeout in ms (default: 60000) */
  txTimeout?: number;
}

export interface ReadyStatus {
  ready: boolean;
  usdcEBalance: string;
  nativeUsdcBalance: string;
  maticBalance: string;
  tradingReady: boolean;
  issues: string[];
  suggestion?: string;
}

export interface TokenBalances {
  matic: string;
  usdc: string;
  usdcE: string;
  usdt: string;
  dai: string;
  weth: string;
  wmatic: string;
}

// Re-export types from underlying services
export type {
  SplitResult,
  MergeResult,
  RedeemResult,
  PositionBalance,
  MarketResolution,
  GasEstimate,
  TransactionStatus,
  TokenIds,
  AllowancesResult,
  ApprovalsResult,
  ApprovalTxResult,
  SwapQuote,
  SwapResult,
  TokenBalance,
  TransferResult,
  QuoteResult,
  PoolInfo,
};

// ===== OnchainService =====

/**
 * Unified service for all on-chain operations on Polymarket
 *
 * This service wraps:
 * - CTFClient: Conditional Token Framework operations (split, merge, redeem)
 * - AuthorizationService: ERC20 and ERC1155 approvals
 * - SwapService: DEX swaps on Polygon via QuickSwap V3
 *
 * All services share the same wallet and provider configuration.
 */
export class OnchainService {
  private wallet: ethers.Wallet;
  private provider: ethers.providers.JsonRpcProvider;
  private ctfClient: CTFClient;
  private authService: AuthorizationService;
  private swapService: SwapService;

  constructor(config: OnchainServiceConfig) {
    const rpcUrl = config.rpcUrl || 'https://polygon-rpc.com';

    // Create shared provider and wallet
    this.provider = new ethers.providers.JsonRpcProvider(rpcUrl);
    this.wallet = new ethers.Wallet(config.privateKey, this.provider);

    // Initialize CTFClient with config
    const ctfConfig: CTFConfig = {
      privateKey: config.privateKey,
      rpcUrl,
      chainId: config.chainId,
      gasPriceMultiplier: config.gasPriceMultiplier,
      confirmations: config.confirmations,
      txTimeout: config.txTimeout,
    };
    this.ctfClient = new CTFClient(ctfConfig);

    // Initialize AuthorizationService with shared wallet
    this.authService = new AuthorizationService(this.wallet, {
      provider: this.provider,
    });

    // Initialize SwapService with shared wallet
    this.swapService = new SwapService(this.wallet);
  }

  // ===== Utilities =====

  /**
   * Get the wallet address
   */
  getAddress(): string {
    return this.wallet.address;
  }

  /**
   * Get native MATIC balance
   */
  async getMaticBalance(): Promise<string> {
    const balance = await this.provider.getBalance(this.wallet.address);
    return ethers.utils.formatEther(balance);
  }

  /**
   * Get all token balances
   */
  async getTokenBalances(): Promise<TokenBalances> {
    const balances = await this.swapService.getBalances();

    const findBalance = (token: string): string => {
      const entry = balances.find(b => b.token === token);
      return entry?.balance || '0';
    };

    return {
      matic: findBalance('MATIC'),
      usdc: findBalance('USDC'),
      usdcE: findBalance('USDC_E'),
      usdt: findBalance('USDT'),
      dai: findBalance('DAI'),
      weth: findBalance('WETH'),
      wmatic: findBalance('WMATIC'),
    };
  }

  // ===== Authorization =====

  /**
   * Check all ERC20 and ERC1155 allowances required for trading
   *
   * @returns Status of all allowances and whether trading is ready
   */
  async checkAllowances(): Promise<AllowancesResult> {
    return this.authService.checkAllowances();
  }

  /**
   * Set up all required approvals for trading
   *
   * @returns Results of all approval transactions
   */
  async approveAll(): Promise<ApprovalsResult> {
    return this.authService.approveAll();
  }

  /**
   * Approve USDC spending for a specific contract
   */
  async approveUsdc(
    spenderAddress: string,
    amount: ethers.BigNumber = ethers.constants.MaxUint256
  ): Promise<ApprovalTxResult> {
    return this.authService.approveUsdc(spenderAddress, amount);
  }

  /**
   * Set approval for an ERC1155 operator
   */
  async setErc1155Approval(
    operatorAddress: string,
    approved: boolean = true
  ): Promise<ApprovalTxResult> {
    return this.authService.setErc1155Approval(operatorAddress, approved);
  }

  // ===== CTF Operations =====

  /**
   * Split USDC into YES + NO tokens
   *
   * @param conditionId - Market condition ID
   * @param amount - USDC amount (e.g., "100" for 100 USDC)
   * @returns SplitResult with transaction details
   */
  async split(conditionId: string, amount: string): Promise<SplitResult> {
    return this.ctfClient.split(conditionId, amount);
  }

  /**
   * Split USDC into YES + NO tokens using explicit token IDs
   *
   * Supports both standard CTF and NegRisk markets.
   * For NegRisk: uses NegRisk Adapter (set isNegRisk=true).
   */
  async splitByTokenIds(
    conditionId: string,
    tokenIds: TokenIds,
    amount: string,
    isNegRisk = false,
  ): Promise<SplitResult> {
    return this.ctfClient.splitByTokenIds(conditionId, tokenIds, amount, isNegRisk);
  }

  /**
   * Merge YES + NO tokens back to USDC
   *
   * @param conditionId - Market condition ID
   * @param amount - Number of token pairs to merge
   * @returns MergeResult with transaction details
   */
  async merge(conditionId: string, amount: string): Promise<MergeResult> {
    return this.ctfClient.merge(conditionId, amount);
  }

  /**
   * Merge YES and NO tokens using explicit token IDs
   *
   * Supports both standard CTF and NegRisk markets.
   * For NegRisk: uses NegRisk Adapter (set isNegRisk=true).
   */
  async mergeByTokenIds(
    conditionId: string,
    tokenIds: TokenIds,
    amount: string,
    isNegRisk = false,
  ): Promise<MergeResult> {
    return this.ctfClient.mergeByTokenIds(conditionId, tokenIds, amount, isNegRisk);
  }

  /**
   * Redeem winning tokens after market resolution (Standard CTF)
   *
   * WARNING: Use redeemByTokenIds for Polymarket CLOB markets.
   *
   * @param conditionId - Market condition ID
   * @param outcome - Optional: Specific outcome to redeem (e.g., "YES", "UP", "TEAM A")
   */
  async redeem(conditionId: string, outcome?: string): Promise<RedeemResult> {
    return this.ctfClient.redeem(conditionId, outcome);
  }

  /**
   * Redeem winning tokens using Polymarket token IDs (Polymarket CLOB)
   *
   * This is the correct method for Polymarket CLOB markets.
   * Supports dynamic outcome names (YES/NO, UP/DOWN, TEAM A/B, etc.)
   *
   * @param conditionId - Market condition ID
   * @param tokenIds - Token IDs for primary and secondary outcomes
   * @param outcome - Optional: Specific outcome to redeem (e.g., "YES", "UP", "TEAM A")
   */
  async redeemByTokenIds(
    conditionId: string,
    tokenIds: TokenIds,
    outcome?: string,
    isNegRisk = false,
  ): Promise<RedeemResult> {
    return this.ctfClient.redeemByTokenIds(conditionId, tokenIds, outcome, isNegRisk);
  }

  // ===== Balances =====

  /**
   * Get USDC.e (bridged USDC) balance - the token used by Polymarket CTF
   */
  async getUsdcBalance(): Promise<string> {
    return this.ctfClient.getUsdcBalance();
  }

  /**
   * Get native USDC balance (not compatible with CTF)
   */
  async getNativeUsdcBalance(): Promise<string> {
    return this.ctfClient.getNativeUsdcBalance();
  }

  /**
   * Get token balances for a market using calculated position IDs
   *
   * @deprecated Use getPositionBalanceByTokenIds for CLOB markets
   */
  async getPositionBalance(conditionId: string): Promise<PositionBalance> {
    return this.ctfClient.getPositionBalance(conditionId);
  }

  /**
   * Get token balances using CLOB API token IDs
   *
   * This is the recommended method for checking balances when working with
   * Polymarket CLOB markets.
   */
  async getPositionBalanceByTokenIds(
    conditionId: string,
    tokenIds: TokenIds
  ): Promise<PositionBalance> {
    return this.ctfClient.getPositionBalanceByTokenIds(conditionId, tokenIds);
  }

  /**
   * Check if wallet is ready for CTF trading operations
   *
   * Combines CTF readiness check with authorization status.
   */
  async checkReadyForCTF(amount: string): Promise<ReadyStatus> {
    // Check CTF readiness (balances)
    const ctfStatus = await this.ctfClient.checkReadyForCTF(amount);

    // Check authorization status
    const authStatus = await this.authService.checkAllowances();

    // Combine issues
    const issues: string[] = [];
    if (ctfStatus.suggestion) {
      issues.push(ctfStatus.suggestion);
    }
    issues.push(...authStatus.issues);

    return {
      ready: ctfStatus.ready && authStatus.tradingReady,
      usdcEBalance: ctfStatus.usdcEBalance,
      nativeUsdcBalance: ctfStatus.nativeUsdcBalance,
      maticBalance: ctfStatus.maticBalance,
      tradingReady: authStatus.tradingReady,
      issues,
      suggestion: ctfStatus.suggestion,
    };
  }

  /**
   * Check if wallet has sufficient tokens for merge
   */
  async canMerge(conditionId: string, amount: string): Promise<{ canMerge: boolean; reason?: string }> {
    return this.ctfClient.canMerge(conditionId, amount);
  }

  /**
   * Check if wallet has sufficient tokens for merge using CLOB token IDs
   */
  async canMergeWithTokenIds(
    conditionId: string,
    tokenIds: TokenIds,
    amount: string
  ): Promise<{ canMerge: boolean; reason?: string }> {
    return this.ctfClient.canMergeWithTokenIds(conditionId, tokenIds, amount);
  }

  /**
   * Check if wallet has sufficient USDC for split
   */
  async canSplit(amount: string): Promise<{ canSplit: boolean; reason?: string }> {
    return this.ctfClient.canSplit(amount);
  }

  // ===== Market Resolution =====

  /**
   * Check if a market is resolved and get payout info
   */
  async getMarketResolution(conditionId: string): Promise<MarketResolution> {
    return this.ctfClient.getMarketResolution(conditionId);
  }

  // ===== Gas Estimation =====

  /**
   * Get detailed gas estimate for a split operation
   */
  async estimateSplitGas(conditionId: string, amount: string): Promise<GasEstimate> {
    return this.ctfClient.getDetailedSplitGasEstimate(conditionId, amount);
  }

  /**
   * Get detailed gas estimate for a merge operation
   */
  async estimateMergeGas(conditionId: string, amount: string): Promise<GasEstimate> {
    return this.ctfClient.getDetailedMergeGasEstimate(conditionId, amount);
  }

  /**
   * Get current gas price info
   */
  async getGasPrice(): Promise<{ gwei: string; wei: string }> {
    return this.ctfClient.getGasPrice();
  }

  // ===== Transaction Monitoring =====

  /**
   * Get transaction status with detailed info
   */
  async getTransactionStatus(txHash: string): Promise<TransactionStatus> {
    return this.ctfClient.getTransactionStatus(txHash);
  }

  /**
   * Wait for transaction confirmation with timeout
   */
  async waitForTransaction(txHash: string, confirmations?: number): Promise<TransactionStatus> {
    return this.ctfClient.waitForTransaction(txHash, confirmations);
  }

  // ===== Swaps =====

  /**
   * Get a quote for a swap (checks if route is possible)
   */
  async getSwapQuote(
    tokenIn: string,
    tokenOut: string,
    amount: string
  ): Promise<QuoteResult> {
    return this.swapService.getQuote(tokenIn, tokenOut, amount);
  }

  /**
   * Execute a token swap using QuickSwap V3
   *
   * @param tokenIn - Token to swap from (e.g., 'MATIC', 'USDC', 'USDT')
   * @param tokenOut - Token to swap to (e.g., 'USDC_E', 'WETH')
   * @param amount - Amount to swap in token units
   * @param slippage - Slippage tolerance in percent (default: 0.5)
   */
  async swap(
    tokenIn: string,
    tokenOut: string,
    amount: string,
    slippage?: number
  ): Promise<SwapResult> {
    return this.swapService.swap(tokenIn, tokenOut, amount, { slippage });
  }

  /**
   * Swap any supported token to USDC.e and deposit to Polymarket
   *
   * This is a convenience method for converting tokens to the USDC.e
   * format required by Polymarket CTF operations.
   */
  async swapAndDeposit(
    token: string,
    amount: string,
    slippage?: number
  ): Promise<SwapResult> {
    return this.swapService.swapToUsdc(token, amount, {
      usdcType: 'USDC_E',
      slippage,
    });
  }

  /**
   * Get all available liquidity pools on QuickSwap V3
   */
  async getAvailablePools(): Promise<PoolInfo[]> {
    return this.swapService.getAvailablePools();
  }

  /**
   * Check if a pool exists for a token pair
   */
  async checkPool(tokenA: string, tokenB: string): Promise<PoolInfo> {
    return this.swapService.checkPool(tokenA, tokenB);
  }

  // ===== Token Transfers =====

  /**
   * Transfer an ERC20 token to another address
   */
  async transfer(token: string, to: string, amount: string): Promise<TransferResult> {
    return this.swapService.transfer(token, to, amount);
  }

  /**
   * Transfer native MATIC to another address
   */
  async transferMatic(to: string, amount: string): Promise<TransferResult> {
    return this.swapService.transferMatic(to, amount);
  }

  /**
   * Transfer native USDC to another address
   *
   * WARNING: This transfers NATIVE USDC, not USDC.e.
   * For Polymarket CTF operations, use transferUsdcE() instead.
   */
  async transferUsdc(to: string, amount: string): Promise<TransferResult> {
    return this.swapService.transferUsdc(to, amount);
  }

  /**
   * Transfer USDC.e (bridged USDC) to another address
   *
   * This is the correct method for Polymarket CTF operations.
   */
  async transferUsdcE(to: string, amount: string): Promise<TransferResult> {
    return this.swapService.transferUsdcE(to, amount);
  }

  // ===== MATIC Wrapping =====

  /**
   * Wrap native MATIC to WMATIC
   */
  async wrapMatic(amount: string): Promise<SwapResult> {
    return this.swapService.wrapMatic(amount);
  }

  /**
   * Unwrap WMATIC to native MATIC
   */
  async unwrapMatic(amount: string): Promise<SwapResult> {
    return this.swapService.unwrapMatic(amount);
  }

  // ===== Advanced Access =====

  /**
   * Get the underlying CTFClient for advanced operations
   */
  getCTFClient(): CTFClient {
    return this.ctfClient;
  }

  /**
   * Get the underlying AuthorizationService for advanced operations
   */
  getAuthorizationService(): AuthorizationService {
    return this.authService;
  }

  /**
   * Get the underlying SwapService for advanced operations
   */
  getSwapService(): SwapService {
    return this.swapService;
  }

  /**
   * Get the shared wallet instance
   */
  getWallet(): ethers.Wallet {
    return this.wallet;
  }

  /**
   * Get the shared provider instance
   */
  getProvider(): ethers.providers.JsonRpcProvider {
    return this.provider;
  }
}
