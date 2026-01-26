/**
 * Bridge Client for Polymarket Cross-Chain Deposits
 *
 * Enables depositing assets from multiple chains (Ethereum, etc.)
 * and having them automatically converted to USDC.e on Polygon for trading.
 *
 * Flow:
 * 1. Request deposit addresses for your Polymarket wallet
 * 2. Send assets to the unique deposit address for each chain/token
 * 3. Assets are automatically bridged and swapped to USDC.e on Polygon
 * 4. USDC.e is credited to your Polymarket account
 *
 * @see https://docs.polymarket.com/developers/misc-endpoints/bridge-deposit
 * @see https://docs.polymarket.com/developers/misc-endpoints/bridge-supported-assets
 */

// ===== Types =====

/**
 * Supported asset information from the bridge
 */
export interface BridgeSupportedAsset {
  /** Blockchain chain ID (e.g., 1 for Ethereum) */
  chainId: number;
  /** Human-readable chain name (e.g., "Ethereum") */
  chainName: string;
  /** Token contract address on the source chain */
  tokenAddress: string;
  /** Token symbol (e.g., "USDC", "ETH") */
  tokenSymbol: string;
  /** Token name (e.g., "USD Coin") */
  tokenName: string;
  /** Token decimals (e.g., 6 for USDC) */
  decimals: number;
  /** Minimum deposit amount in token units */
  minDeposit: string;
  /** Minimum deposit amount in USD */
  minDepositUsd: number;
  /** Whether this asset is currently active */
  active: boolean;
}

/**
 * Deposit address for a specific chain/token combination
 */
export interface DepositAddress {
  /** Blockchain chain ID */
  chainId: number;
  /** Human-readable chain name */
  chainName: string;
  /** Token contract address on source chain */
  tokenAddress: string;
  /** Token symbol */
  tokenSymbol: string;
  /** Unique deposit address to send funds to */
  depositAddress: string;
  /** Minimum deposit amount */
  minDeposit: string;
}

/**
 * Response from creating deposit addresses
 *
 * The Bridge API returns a single universal deposit address structure.
 * - EVM address: Used for all EVM chains (Ethereum, Polygon, Arbitrum, Base, Optimism)
 * - SVM address: Used for Solana
 * - BTC address: Used for Bitcoin
 *
 * @example Response from API:
 * ```json
 * {
 *   "address": {
 *     "evm": "0x1234...",
 *     "svm": "ABC123...",
 *     "btc": "bc1q..."
 *   }
 * }
 * ```
 */
export interface CreateDepositResponse {
  /** Universal deposit addresses for different chain types */
  address: {
    /** EVM deposit address (Ethereum, Polygon, Arbitrum, Base, Optimism) */
    evm: string;
    /** Solana deposit address */
    svm: string;
    /** Bitcoin deposit address */
    btc: string;
  };
}

/**
 * Deposit status types from Bridge API
 *
 * @see https://docs.polymarket.com/api-reference/bridge/get-deposit-status
 */
export type DepositStatusType =
  | 'DEPOSIT_DETECTED'    // Deposit detected but not yet processing
  | 'PROCESSING'          // Transaction is being routed and swapped
  | 'ORIGIN_TX_CONFIRMED' // Origin transaction confirmed on source chain
  | 'SUBMITTED'           // Transaction has been submitted to destination chain
  | 'COMPLETED'           // Transaction completed successfully
  | 'FAILED';             // Transaction encountered an error

/**
 * Single deposit transaction from Bridge API /status endpoint
 */
export interface DepositTransaction {
  /** Source chain ID */
  fromChainId: number;
  /** Source token contract address */
  fromTokenAddress: string;
  /** Amount in base units (wei/smallest denomination) */
  fromAmountBaseUnit: string;
  /** Destination chain ID (137 for Polygon) */
  toChainId: number;
  /** Destination token address (USDC.e on Polygon) */
  toTokenAddress: string;
  /** Current status of the deposit */
  status: DepositStatusType;
  /** Timestamp when deposit was created (Unix milliseconds) */
  createdTimeMs: number;
  /** Source transaction hash (when available) */
  txHash?: string;
  /** Destination transaction hash (when completed) */
  destinationTxHash?: string;
}

/**
 * Response from Bridge API /status/{address} endpoint
 */
export interface DepositStatusResponse {
  /** Array of deposit transactions for this address */
  transactions: DepositTransaction[];
}

/**
 * @deprecated Use DepositTransaction instead
 * Legacy deposit status tracking (kept for backward compatibility)
 */
export interface DepositStatus {
  /** Unique deposit ID */
  depositId: string;
  /** Source chain ID */
  sourceChainId: number;
  /** Source transaction hash */
  sourceTxHash: string;
  /** Amount deposited */
  amount: string;
  /** Token symbol */
  tokenSymbol: string;
  /** Status of the deposit */
  status: 'pending' | 'bridging' | 'swapping' | 'completed' | 'failed';
  /** Destination transaction hash (when completed) */
  destinationTxHash?: string;
  /** USDC.e amount received (when completed) */
  usdceReceived?: string;
  /** Error message (if failed) */
  errorMessage?: string;
  /** Timestamp of last update */
  updatedAt: string;
}

/**
 * Bridge configuration
 */
export interface BridgeConfig {
  /** Base URL for the bridge API (default: https://bridge.polymarket.com) */
  baseUrl?: string;
  /** Request timeout in ms (default: 30000) */
  timeout?: number;
}

// ===== Constants =====

const BRIDGE_API_BASE = 'https://bridge.polymarket.com';

// Known chain information
export const SUPPORTED_CHAINS = {
  ETHEREUM: {
    chainId: 1,
    name: 'Ethereum',
    rpcUrl: 'https://eth.llamarpc.com',
  },
  POLYGON: {
    chainId: 137,
    name: 'Polygon',
    rpcUrl: 'https://polygon-rpc.com',
  },
} as const;

// Known token addresses
export const BRIDGE_TOKENS = {
  // Ethereum
  ETH_USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  ETH_WETH: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  ETH_DAI: '0x6B175474E89094C44Da98b954EeDeaC495271d0F',

  // Polygon (destination)
  POLYGON_USDC_E: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
  POLYGON_NATIVE_USDC: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
} as const;

// ===== Bridge Client =====

/**
 * Client for interacting with Polymarket's cross-chain bridge
 *
 * @example
 * ```typescript
 * const bridge = new BridgeClient();
 *
 * // Get supported assets
 * const assets = await bridge.getSupportedAssets();
 * console.log(`Supported: ${assets.map(a => a.tokenSymbol).join(', ')}`);
 *
 * // Create deposit addresses for your wallet
 * const deposit = await bridge.createDepositAddresses('0xYourAddress');
 * const ethUsdc = deposit.depositAddresses.find(
 *   d => d.chainName === 'Ethereum' && d.tokenSymbol === 'USDC'
 * );
 * console.log(`Send USDC on Ethereum to: ${ethUsdc.depositAddress}`);
 * ```
 */
export class BridgeClient {
  private baseUrl: string;
  private timeout: number;

  constructor(config: BridgeConfig = {}) {
    this.baseUrl = config.baseUrl || BRIDGE_API_BASE;
    this.timeout = config.timeout || 30000;
  }

  /**
   * Get all supported assets for bridge deposits
   *
   * @returns Array of supported assets with their chain/token details
   *
   * @example
   * ```typescript
   * const assets = await bridge.getSupportedAssets();
   * for (const asset of assets) {
   *   console.log(`${asset.chainName} ${asset.tokenSymbol}: min $${asset.minDepositUsd}`);
   * }
   * ```
   */
  async getSupportedAssets(): Promise<BridgeSupportedAsset[]> {
    const response = await this.fetch('/supported-assets') as {
      supportedAssets: Array<{
        chainId: string;
        chainName: string;
        token: {
          name: string;
          symbol: string;
          address: string;
          decimals: number;
        };
        minCheckoutUsd: number;
      }>;
    };

    // Normalize the API response to match our interface
    return response.supportedAssets.map((asset) => ({
      chainId: parseInt(asset.chainId, 10),
      chainName: asset.chainName,
      tokenSymbol: asset.token.symbol,
      tokenName: asset.token.name,
      tokenAddress: asset.token.address,
      decimals: asset.token.decimals,
      minDeposit: asset.minCheckoutUsd.toString(),
      minDepositUsd: asset.minCheckoutUsd,
      active: true,
    }));
  }

  /**
   * Get unique deposit addresses for a Polymarket wallet
   *
   * The Bridge API returns a universal deposit address structure:
   * - A single EVM address works for ALL EVM chains (Ethereum, Polygon, Arbitrum, Base, Optimism)
   * - A Solana address for SVM deposits
   * - A Bitcoin address for BTC deposits
   *
   * Funds sent to these addresses are automatically bridged to Polygon
   * and converted to USDC.e for your Polymarket account.
   *
   * @param walletAddress - Your Polymarket wallet address (EOA address)
   * @returns Universal deposit addresses for EVM, Solana, and Bitcoin
   *
   * @example
   * ```typescript
   * const result = await bridge.createDepositAddresses('0xYourPolymarketWallet');
   *
   * // The EVM address works for Ethereum, Polygon, Arbitrum, Base, Optimism
   * console.log(`EVM deposit address: ${result.address.evm}`);
   *
   * // For Solana deposits
   * console.log(`Solana deposit address: ${result.address.svm}`);
   *
   * // For Bitcoin deposits
   * console.log(`Bitcoin deposit address: ${result.address.btc}`);
   * ```
   */
  async createDepositAddresses(walletAddress: string): Promise<CreateDepositResponse> {
    const response = await this.fetch('/deposit', {
      method: 'POST',
      body: JSON.stringify({ address: walletAddress }),
    });

    return response as CreateDepositResponse;
  }

  /**
   * Get the EVM deposit address for a wallet
   *
   * This address works for ALL supported EVM chains:
   * - Ethereum (chainId: 1)
   * - Polygon (chainId: 137)
   * - Arbitrum (chainId: 42161)
   * - Base (chainId: 8453)
   * - Optimism (chainId: 10)
   *
   * @param walletAddress - Your Polymarket wallet address
   * @returns The universal EVM deposit address
   *
   * @example
   * ```typescript
   * const evmAddr = await bridge.getEvmDepositAddress('0xYourWallet');
   * // Send Native USDC on Polygon to this address
   * // Or send USDC on Ethereum to this address
   * console.log(`Deposit to: ${evmAddr}`);
   * ```
   */
  async getEvmDepositAddress(walletAddress: string): Promise<string> {
    const result = await this.createDepositAddresses(walletAddress);
    return result.address.evm;
  }

  /**
   * Get the Solana deposit address for a wallet
   *
   * @param walletAddress - Your Polymarket wallet address
   * @returns The Solana deposit address
   */
  async getSolanaDepositAddress(walletAddress: string): Promise<string> {
    const result = await this.createDepositAddresses(walletAddress);
    return result.address.svm;
  }

  /**
   * Get the Bitcoin deposit address for a wallet
   *
   * @param walletAddress - Your Polymarket wallet address
   * @returns The Bitcoin deposit address
   */
  async getBtcDepositAddress(walletAddress: string): Promise<string> {
    const result = await this.createDepositAddresses(walletAddress);
    return result.address.btc;
  }

  // ===== Deposit Status =====

  /**
   * Get deposit status for a deposit address
   *
   * Check the status of deposits made to a specific deposit address.
   * Returns all transactions associated with that address.
   *
   * @param depositAddress - The deposit address (EVM, SVM, or BTC) returned from createDepositAddresses
   * @returns Array of deposit transactions with their current status
   *
   * @example
   * ```typescript
   * const bridge = new BridgeClient();
   * const addresses = await bridge.createDepositAddresses('0xMyWallet');
   *
   * // After sending funds to the EVM deposit address...
   * const transactions = await bridge.getDepositStatus(addresses.address.evm);
   *
   * for (const tx of transactions) {
   *   console.log(`Status: ${tx.status}, Amount: ${tx.fromAmountBaseUnit}`);
   *   if (tx.status === 'COMPLETED') {
   *     console.log(`Completed! Destination tx: ${tx.destinationTxHash}`);
   *   }
   * }
   * ```
   */
  async getDepositStatus(depositAddress: string): Promise<DepositTransaction[]> {
    const response = await this.fetch(`/status/${depositAddress}`) as DepositStatusResponse;
    return response.transactions || [];
  }

  /**
   * Get the latest deposit transaction for a deposit address
   *
   * @param depositAddress - The deposit address
   * @returns The most recent deposit transaction, or null if none
   */
  async getLatestDeposit(depositAddress: string): Promise<DepositTransaction | null> {
    const transactions = await this.getDepositStatus(depositAddress);
    if (transactions.length === 0) return null;

    // Sort by createdTimeMs descending and return the most recent
    return transactions.sort((a, b) => b.createdTimeMs - a.createdTimeMs)[0];
  }

  /**
   * Check if a deposit is completed
   *
   * @param depositAddress - The deposit address
   * @returns True if the latest deposit is completed
   */
  async isDepositCompleted(depositAddress: string): Promise<boolean> {
    const latest = await this.getLatestDeposit(depositAddress);
    return latest?.status === 'COMPLETED';
  }

  /**
   * Check if a deposit has failed
   *
   * @param depositAddress - The deposit address
   * @returns True if the latest deposit has failed
   */
  async isDepositFailed(depositAddress: string): Promise<boolean> {
    const latest = await this.getLatestDeposit(depositAddress);
    return latest?.status === 'FAILED';
  }

  /**
   * Wait for a deposit to complete with polling
   *
   * Polls the deposit status until it reaches COMPLETED or FAILED status,
   * or until the timeout is reached.
   *
   * @param depositAddress - The deposit address to monitor
   * @param options - Polling options
   * @returns The completed deposit transaction
   * @throws Error if timeout is reached or deposit fails
   *
   * @example
   * ```typescript
   * const bridge = new BridgeClient();
   * const addresses = await bridge.createDepositAddresses('0xMyWallet');
   *
   * // Send funds to the deposit address, then wait for completion
   * try {
   *   const deposit = await bridge.waitForDeposit(addresses.address.evm, {
   *     timeoutMs: 10 * 60 * 1000, // 10 minutes
   *     pollIntervalMs: 5000,       // Check every 5 seconds
   *     onStatusChange: (tx) => {
   *       console.log(`Status changed: ${tx.status}`);
   *     },
   *   });
   *   console.log(`Deposit completed! Tx: ${deposit.destinationTxHash}`);
   * } catch (err) {
   *   console.error(`Deposit failed: ${err.message}`);
   * }
   * ```
   */
  async waitForDeposit(
    depositAddress: string,
    options: {
      /** Timeout in milliseconds (default: 10 minutes) */
      timeoutMs?: number;
      /** Polling interval in milliseconds (default: 5 seconds) */
      pollIntervalMs?: number;
      /** Callback when status changes */
      onStatusChange?: (tx: DepositTransaction) => void;
    } = {}
  ): Promise<DepositTransaction> {
    const { timeoutMs = 10 * 60 * 1000, pollIntervalMs = 5000, onStatusChange } = options;

    const startTime = Date.now();
    let lastStatus: DepositStatusType | null = null;

    while (Date.now() - startTime < timeoutMs) {
      const latest = await this.getLatestDeposit(depositAddress);

      if (latest) {
        // Notify on status change
        if (onStatusChange && latest.status !== lastStatus) {
          onStatusChange(latest);
          lastStatus = latest.status;
        }

        // Check for terminal states
        if (latest.status === 'COMPLETED') {
          return latest;
        }

        if (latest.status === 'FAILED') {
          throw new Error(`Deposit failed. Transaction: ${latest.txHash || 'unknown'}`);
        }
      }

      // Wait before next poll
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    throw new Error(`Timeout waiting for deposit to complete after ${timeoutMs}ms`);
  }

  /**
   * Get a human-readable description of a deposit status
   *
   * @param status - The deposit status
   * @returns Human-readable description
   */
  static getStatusDescription(status: DepositStatusType): string {
    switch (status) {
      case 'DEPOSIT_DETECTED':
        return 'Deposit detected, waiting for confirmation';
      case 'PROCESSING':
        return 'Processing: routing and swapping';
      case 'ORIGIN_TX_CONFIRMED':
        return 'Source transaction confirmed, bridging to Polygon';
      case 'SUBMITTED':
        return 'Submitted to Polygon, awaiting confirmation';
      case 'COMPLETED':
        return 'Deposit completed successfully';
      case 'FAILED':
        return 'Deposit failed';
      default:
        return `Unknown status: ${status}`;
    }
  }

  /**
   * @deprecated Use getEvmDepositAddress(), getSolanaDepositAddress(), or getBtcDepositAddress() instead.
   *
   * The Bridge API returns universal addresses by chain type (EVM/SVM/BTC),
   * not by specific chain/token combinations.
   *
   * For EVM chains (Ethereum, Polygon, Arbitrum, Base, Optimism), use getEvmDepositAddress()
   */
  async getDepositAddress(
    address: string,
    _chainId: number,
    _tokenSymbol: string
  ): Promise<DepositAddress | null> {
    // Return a compatibility shim - the EVM address works for all EVM chains
    const result = await this.createDepositAddresses(address);
    return {
      chainId: _chainId,
      chainName: 'Universal EVM',
      tokenAddress: '',
      tokenSymbol: _tokenSymbol,
      depositAddress: result.address.evm,
      minDeposit: '2', // Default minimum
    };
  }

  /**
   * Check if a chain/token combination is supported
   *
   * @param chainId - The chain ID to check
   * @param tokenSymbol - The token symbol to check
   * @returns True if supported, false otherwise
   */
  async isSupported(chainId: number, tokenSymbol: string): Promise<boolean> {
    const assets = await this.getSupportedAssets();
    return assets.some(
      (a) => a.chainId === chainId && a.tokenSymbol.toUpperCase() === tokenSymbol.toUpperCase()
    );
  }

  /**
   * Get minimum deposit amount for a chain/token
   *
   * @param chainId - The chain ID
   * @param tokenSymbol - The token symbol
   * @returns Minimum deposit info or null if not supported
   */
  async getMinDeposit(
    chainId: number,
    tokenSymbol: string
  ): Promise<{ amount: string; usd: number } | null> {
    const assets = await this.getSupportedAssets();
    const asset = assets.find(
      (a) => a.chainId === chainId && a.tokenSymbol.toUpperCase() === tokenSymbol.toUpperCase()
    );

    if (!asset) return null;

    return {
      amount: asset.minDeposit,
      usd: asset.minDepositUsd,
    };
  }

  /**
   * Format deposit instructions for a user
   *
   * @param walletAddress - The Polymarket wallet address
   * @returns Formatted instructions string
   */
  async getDepositInstructions(walletAddress: string): Promise<string> {
    const result = await this.createDepositAddresses(walletAddress);
    const assets = await this.getSupportedAssets();

    const lines: string[] = [
      '═══════════════════════════════════════════════════════════',
      '            POLYMARKET DEPOSIT INSTRUCTIONS',
      '═══════════════════════════════════════════════════════════',
      '',
      `Wallet: ${walletAddress}`,
      '',
      'Send assets to these addresses to deposit to your Polymarket account:',
      '(Assets will be automatically converted to USDC.e on Polygon)',
      '',
    ];

    // EVM Deposit Address (works for all EVM chains)
    lines.push('── EVM CHAINS ──');
    lines.push('(Ethereum, Polygon, Arbitrum, Base, Optimism)');
    lines.push('');
    lines.push(`  Universal EVM Address: ${result.address.evm}`);
    lines.push('');

    // Group assets by chain for display
    const evmChainIds = [1, 137, 42161, 8453, 10];
    const evmAssets = assets.filter((a) => evmChainIds.includes(a.chainId));

    // Group by chain
    const byChain = new Map<number, BridgeSupportedAsset[]>();
    for (const asset of evmAssets) {
      const existing = byChain.get(asset.chainId) || [];
      existing.push(asset);
      byChain.set(asset.chainId, existing);
    }

    for (const [chainId, chainAssets] of byChain) {
      const chainName = chainAssets[0]?.chainName || `Chain ${chainId}`;
      lines.push(`  ${chainName} (${chainId}):`);
      for (const asset of chainAssets) {
        lines.push(`    - ${asset.tokenSymbol}: min $${asset.minDepositUsd}`);
      }
      lines.push('');
    }

    // Solana Deposit Address
    lines.push('── SOLANA ──');
    lines.push(`  Address: ${result.address.svm}`);
    const solAssets = assets.filter((a) => a.chainName?.toLowerCase().includes('solana'));
    for (const asset of solAssets) {
      lines.push(`    - ${asset.tokenSymbol}: min $${asset.minDepositUsd}`);
    }
    lines.push('');

    // Bitcoin Deposit Address
    lines.push('── BITCOIN ──');
    lines.push(`  Address: ${result.address.btc}`);
    const btcAssets = assets.filter((a) => a.chainName?.toLowerCase().includes('bitcoin'));
    for (const asset of btcAssets) {
      lines.push(`    - ${asset.tokenSymbol}: min $${asset.minDepositUsd}`);
    }
    lines.push('');

    lines.push('═══════════════════════════════════════════════════════════');
    lines.push('');
    lines.push('IMPORTANT:');
    lines.push('  - Always send more than the minimum amount');
    lines.push('  - Deposits may take 1-30 minutes to process');
    lines.push('  - Check Polymarket balance after deposit completes');
    lines.push('  - Bridge fee is approximately 0.16%');
    lines.push('');

    return lines.join('\n');
  }

  // ===== Private Methods =====

  private async fetch(path: string, options: RequestInit = {}): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...options.headers,
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Bridge API error (${response.status}): ${errorText}`);
      }

      return await response.json();
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

// ===== Deposit Execution =====

import { ethers } from 'ethers';

// ERC20 ABI for deposits
const ERC20_DEPOSIT_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
];

export interface DepositResult {
  success: boolean;
  txHash?: string;
  amount: string;
  depositAddress: string;
  error?: string;
}

export interface DepositOptions {
  /** Chain ID for the deposit (default: 137 for Polygon) */
  chainId?: number;
  /** Token to deposit: 'NATIVE_USDC' or 'USDC_E' (default: 'NATIVE_USDC') */
  token?: 'NATIVE_USDC' | 'USDC_E';
  /** Gas price multiplier (default: 1.2) */
  gasPriceMultiplier?: number;
}

/**
 * Deposit USDC to Polymarket via Bridge
 *
 * This function:
 * 1. Gets the deposit address for your wallet
 * 2. Transfers USDC to that address
 * 3. The bridge automatically converts it to USDC.e for your Polymarket account
 *
 * @param signer - Ethers wallet/signer to send from
 * @param amount - Amount in USDC (e.g., 10.5 for $10.50)
 * @param options - Deposit options
 * @returns Deposit result with transaction hash
 *
 * @example
 * ```typescript
 * const bridge = new BridgeClient();
 * const result = await bridge.depositUsdc(signer, 100);
 * console.log(`Deposited $100: ${result.txHash}`);
 * ```
 */
export async function depositUsdc(
  signer: ethers.Wallet,
  amount: number,
  options: DepositOptions = {}
): Promise<DepositResult> {
  const { token = 'NATIVE_USDC', gasPriceMultiplier = 1.2 } = options;

  // Validate minimum deposit
  if (amount < 2) {
    return {
      success: false,
      amount: amount.toString(),
      depositAddress: '',
      error: 'Minimum deposit is $2',
    };
  }

  // Get token address
  const tokenAddress =
    token === 'NATIVE_USDC' ? BRIDGE_TOKENS.POLYGON_NATIVE_USDC : BRIDGE_TOKENS.POLYGON_USDC_E;

  try {
    // Get deposit address
    const bridge = new BridgeClient();
    const depositAddr = await bridge.getEvmDepositAddress(signer.address);

    // Create token contract
    const tokenContract = new ethers.Contract(tokenAddress, ERC20_DEPOSIT_ABI, signer);

    // Check balance
    const balance = await tokenContract.balanceOf(signer.address);
    const amountWei = ethers.utils.parseUnits(amount.toString(), 6);

    if (balance.lt(amountWei)) {
      const balanceFormatted = ethers.utils.formatUnits(balance, 6);
      return {
        success: false,
        amount: amount.toString(),
        depositAddress: depositAddr,
        error: `Insufficient balance. Have: ${balanceFormatted}, Need: ${amount}`,
      };
    }

    // Get gas price with buffer
    const feeData = await signer.provider!.getFeeData();
    const gasPrice = feeData.gasPrice
      ? feeData.gasPrice.mul(Math.floor(gasPriceMultiplier * 100)).div(100)
      : undefined;

    // Execute transfer
    const tx = await tokenContract.transfer(depositAddr, amountWei, {
      gasPrice,
    });

    const receipt = await tx.wait();

    if (receipt.status !== 1) {
      return {
        success: false,
        txHash: tx.hash,
        amount: amount.toString(),
        depositAddress: depositAddr,
        error: 'Transaction failed',
      };
    }

    return {
      success: true,
      txHash: tx.hash,
      amount: amount.toString(),
      depositAddress: depositAddr,
    };
  } catch (err) {
    return {
      success: false,
      amount: amount.toString(),
      depositAddress: '',
      error: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}

// ===== Swap and Deposit =====

import { SwapService, POLYGON_TOKENS, TOKEN_DECIMALS } from '../services/swap-service.js';

export interface SwapAndDepositOptions {
  /** Slippage tolerance for swap (default: 0.5%) */
  slippage?: number;
  /** Gas price multiplier (default: 1.2) */
  gasPriceMultiplier?: number;
}

export interface SwapAndDepositResult {
  success: boolean;
  /** Swap transaction hash (if swap was needed) */
  swapTxHash?: string;
  /** Deposit transaction hash */
  depositTxHash?: string;
  /** Input token */
  tokenIn: string;
  /** Amount of input token */
  amountIn: string;
  /** Amount of USDC after swap */
  usdcAmount: string;
  /** Deposit address */
  depositAddress: string;
  /** Error message if failed */
  error?: string;
}

/**
 * Swap any supported Polygon token to USDC and deposit to Polymarket
 *
 * Supported tokens: MATIC, WMATIC, USDC, USDC_E, USDT, DAI, WETH
 *
 * Flow:
 * 1. If token is not USDC, swap to USDC using QuickSwap
 * 2. Deposit USDC to the bridge deposit address
 *
 * @param signer - Ethers wallet/signer
 * @param token - Token symbol to deposit (e.g., 'MATIC', 'WETH', 'USDT')
 * @param amount - Amount to deposit in token units
 * @param options - Swap and deposit options
 * @returns Result with transaction hashes
 *
 * @example
 * ```typescript
 * // Deposit 10 MATIC
 * const result = await swapAndDeposit(signer, 'MATIC', '10');
 *
 * // Deposit 100 USDT
 * const result = await swapAndDeposit(signer, 'USDT', '100');
 *
 * // Deposit 0.1 WETH
 * const result = await swapAndDeposit(signer, 'WETH', '0.1');
 * ```
 */
export async function swapAndDeposit(
  signer: ethers.Wallet,
  token: string,
  amount: string,
  options: SwapAndDepositOptions = {}
): Promise<SwapAndDepositResult> {
  const { slippage = 0.5, gasPriceMultiplier = 1.2 } = options;

  const upperToken = token.toUpperCase();

  try {
    const swapService = new SwapService(signer);
    const bridge = new BridgeClient();

    // Get deposit address
    const depositAddr = await bridge.getEvmDepositAddress(signer.address);

    // If already USDC, skip swap
    if (upperToken === 'USDC' || upperToken === 'NATIVE_USDC') {
      const result = await depositUsdc(signer, parseFloat(amount), {
        token: 'NATIVE_USDC',
        gasPriceMultiplier,
      });

      return {
        success: result.success,
        depositTxHash: result.txHash,
        tokenIn: upperToken,
        amountIn: amount,
        usdcAmount: amount,
        depositAddress: depositAddr,
        error: result.error,
      };
    }

    if (upperToken === 'USDC_E') {
      const result = await depositUsdc(signer, parseFloat(amount), {
        token: 'USDC_E',
        gasPriceMultiplier,
      });

      return {
        success: result.success,
        depositTxHash: result.txHash,
        tokenIn: upperToken,
        amountIn: amount,
        usdcAmount: amount,
        depositAddress: depositAddr,
        error: result.error,
      };
    }

    // Check balance
    const balance = await swapService.getBalance(token);
    if (parseFloat(balance) < parseFloat(amount)) {
      return {
        success: false,
        tokenIn: upperToken,
        amountIn: amount,
        usdcAmount: '0',
        depositAddress: depositAddr,
        error: `Insufficient ${upperToken} balance. Have: ${balance}, Need: ${amount}`,
      };
    }

    // Swap to USDC
    const swapResult = await swapService.swapToUsdc(token, amount, {
      usdcType: 'NATIVE_USDC',
      slippage,
    });

    if (!swapResult.success) {
      return {
        success: false,
        tokenIn: upperToken,
        amountIn: amount,
        usdcAmount: '0',
        depositAddress: depositAddr,
        error: `Swap failed: ${swapResult.transactionHash}`,
      };
    }

    // Get USDC balance after swap
    const usdcBalance = await swapService.getBalance('USDC');

    // Deposit USDC
    const depositResult = await depositUsdc(signer, parseFloat(usdcBalance), {
      token: 'NATIVE_USDC',
      gasPriceMultiplier,
    });

    return {
      success: depositResult.success,
      swapTxHash: swapResult.transactionHash,
      depositTxHash: depositResult.txHash,
      tokenIn: upperToken,
      amountIn: amount,
      usdcAmount: usdcBalance,
      depositAddress: depositAddr,
      error: depositResult.error,
    };
  } catch (err) {
    return {
      success: false,
      tokenIn: upperToken,
      amountIn: amount,
      usdcAmount: '0',
      depositAddress: '',
      error: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}

/**
 * Get list of supported tokens for swap and deposit
 */
export function getSupportedDepositTokens(): string[] {
  return Object.keys(POLYGON_TOKENS);
}

// ===== Utility Functions =====

/**
 * Calculate the expected USDC.e output after bridge fees
 *
 * Note: This is an estimate. Actual output depends on bridge/swap fees.
 *
 * @param amount - Input amount in source token
 * @param tokenSymbol - Source token symbol
 * @returns Estimated USDC.e output
 */
export function estimateBridgeOutput(amount: number, tokenSymbol: string): number {
  // Typical bridge fees: ~0.5-1%
  // Swap fees: ~0.3%
  const totalFeePercent = 0.01; // 1% estimate

  // For stablecoins, 1:1 minus fees
  if (['USDC', 'USDT', 'DAI', 'BUSD'].includes(tokenSymbol.toUpperCase())) {
    return amount * (1 - totalFeePercent);
  }

  // For ETH and other tokens, would need price oracle
  // This is just a placeholder
  return amount * (1 - totalFeePercent);
}

/**
 * Get explorer URL for a deposit transaction
 *
 * @param chainId - The chain ID
 * @param txHash - The transaction hash
 * @returns Block explorer URL
 */
export function getExplorerUrl(chainId: number, txHash: string): string {
  switch (chainId) {
    case 1:
      return `https://etherscan.io/tx/${txHash}`;
    case 137:
      return `https://polygonscan.com/tx/${txHash}`;
    case 10:
      return `https://optimistic.etherscan.io/tx/${txHash}`;
    case 42161:
      return `https://arbiscan.io/tx/${txHash}`;
    case 8453:
      return `https://basescan.org/tx/${txHash}`;
    default:
      return `https://blockscan.com/tx/${txHash}`;
  }
}
