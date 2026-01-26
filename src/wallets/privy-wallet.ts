/**
 * PrivyWallet - Privy Delegated Actions 钱包适配器
 *
 * 允许服务端代表用户执行所有链上操作：
 * - CLOB 交易（下单、撤单）
 * - CTF 操作（split、merge、redeem）
 * - ERC20/ERC1155 approve
 *
 * 前提条件：用户已在前端完成 Delegated Actions 授权
 *
 * @example
 * ```typescript
 * // 服务端初始化
 * const privyWallet = new PrivyWallet({
 *   privyAppId: process.env.PRIVY_APP_ID!,
 *   privyAppSecret: process.env.PRIVY_APP_SECRET!,
 *   userWalletAddress: '0x...',  // 用户的 Privy embedded wallet
 *   chainId: 137,
 * });
 *
 * // 执行 CTF 操作（自动签名）
 * await privyWallet.sendTransaction({
 *   to: CTF_CONTRACT,
 *   data: mergeCalldata,
 * });
 * ```
 */

import { ethers } from 'ethers';

// Types for Privy Server SDK
interface PrivyWalletConfig {
  /** Privy App ID */
  privyAppId: string;
  /** Privy App Secret */
  privyAppSecret: string;
  /** User's wallet address (Privy embedded wallet) */
  userWalletAddress: string;
  /** Chain ID (default: 137 for Polygon) */
  chainId?: number;
  /** RPC URL (optional, uses default Polygon RPC if not provided) */
  rpcUrl?: string;
}

interface TransactionRequest {
  to: string;
  data?: string;
  value?: string;
  gasLimit?: string;
  gasPrice?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
}

interface TransactionResult {
  hash: string;
  success: boolean;
  error?: string;
}

interface SignatureResult {
  signature: string;
  success: boolean;
  error?: string;
}

// EIP-712 typed data for CLOB order signing
interface TypedDataDomain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract?: string;
}

interface TypedDataTypes {
  [key: string]: Array<{ name: string; type: string }>;
}

/**
 * PrivyWallet - 使用 Privy Delegated Actions 的钱包适配器
 *
 * 这个类封装了 Privy Server SDK，让策略引擎可以：
 * 1. 发送链上交易（split/merge/redeem/approve）
 * 2. 签名 EIP-712 数据（CLOB 订单）
 * 3. 签名普通消息
 */
export class PrivyWallet {
  private config: PrivyWalletConfig;
  private provider: ethers.providers.JsonRpcProvider;
  private privyClient: any; // PrivyClient from @privy-io/server-auth

  constructor(config: PrivyWalletConfig) {
    this.config = {
      chainId: 137,
      rpcUrl: 'https://polygon-rpc.com',
      ...config,
    };

    this.provider = new ethers.providers.JsonRpcProvider(
      this.config.rpcUrl,
      this.config.chainId
    );
  }

  /**
   * 初始化 Privy 客户端
   * 需要动态导入 @privy-io/server-auth
   */
  async initialize(): Promise<void> {
    try {
      // Dynamic import to avoid bundling issues
      const { PrivyClient } = await import('@privy-io/server-auth');
      this.privyClient = new PrivyClient(
        this.config.privyAppId,
        this.config.privyAppSecret
      );
    } catch (error) {
      throw new Error(
        'Failed to initialize Privy client. Make sure @privy-io/server-auth is installed.'
      );
    }
  }

  /**
   * 获取钱包地址
   */
  getAddress(): string {
    return this.config.userWalletAddress;
  }

  /**
   * 发送链上交易
   *
   * 使用 Privy Delegated Actions 签名并广播交易
   *
   * @param tx - 交易请求
   * @returns 交易结果
   */
  async sendTransaction(tx: TransactionRequest): Promise<TransactionResult> {
    if (!this.privyClient) {
      await this.initialize();
    }

    try {
      // 构建交易
      const transaction = {
        to: tx.to,
        data: tx.data || '0x',
        value: tx.value || '0x0',
        chainId: this.config.chainId,
      };

      // 如果没有指定 gas，估算 gas
      if (!tx.gasLimit) {
        const gasEstimate = await this.provider.estimateGas({
          ...transaction,
          from: this.config.userWalletAddress,
        });
        transaction['gasLimit'] = gasEstimate.mul(120).div(100).toHexString(); // +20% buffer
      } else {
        transaction['gasLimit'] = tx.gasLimit;
      }

      // 获取当前 gas price
      if (!tx.maxFeePerGas) {
        const feeData = await this.provider.getFeeData();
        transaction['maxFeePerGas'] = feeData.maxFeePerGas?.toHexString();
        transaction['maxPriorityFeePerGas'] = feeData.maxPriorityFeePerGas?.toHexString();
      }

      // 使用 Privy Wallet API 签名并发送交易
      const result = await this.privyClient.walletApi.ethereum.sendTransaction({
        address: this.config.userWalletAddress,
        caip2ChainId: `eip155:${this.config.chainId}`,
        transaction,
      });

      return {
        hash: result.hash,
        success: true,
      };
    } catch (error: any) {
      return {
        hash: '',
        success: false,
        error: error.message || 'Transaction failed',
      };
    }
  }

  /**
   * 签名 EIP-712 类型数据
   *
   * 用于 CLOB 订单签名
   *
   * @param domain - EIP-712 domain
   * @param types - EIP-712 types
   * @param message - 要签名的消息
   * @returns 签名结果
   */
  async signTypedData(
    domain: TypedDataDomain,
    types: TypedDataTypes,
    message: Record<string, any>
  ): Promise<SignatureResult> {
    if (!this.privyClient) {
      await this.initialize();
    }

    try {
      const result = await this.privyClient.walletApi.ethereum.signTypedData({
        address: this.config.userWalletAddress,
        caip2ChainId: `eip155:${this.config.chainId}`,
        typedData: {
          domain,
          types,
          primaryType: Object.keys(types).find(k => k !== 'EIP712Domain') || 'Order',
          message,
        },
      });

      return {
        signature: result.signature,
        success: true,
      };
    } catch (error: any) {
      return {
        signature: '',
        success: false,
        error: error.message || 'Signing failed',
      };
    }
  }

  /**
   * 签名普通消息
   *
   * 用于 deriveApiKey 等操作
   *
   * @param message - 要签名的消息
   * @returns 签名结果
   */
  async signMessage(message: string): Promise<SignatureResult> {
    if (!this.privyClient) {
      await this.initialize();
    }

    try {
      const result = await this.privyClient.walletApi.ethereum.signMessage({
        address: this.config.userWalletAddress,
        caip2ChainId: `eip155:${this.config.chainId}`,
        message,
      });

      return {
        signature: result.signature,
        success: true,
      };
    } catch (error: any) {
      return {
        signature: '',
        success: false,
        error: error.message || 'Signing failed',
      };
    }
  }

  /**
   * 检查用户是否已授权 Delegated Actions
   *
   * @returns 是否已授权
   */
  async checkDelegationStatus(): Promise<boolean> {
    if (!this.privyClient) {
      await this.initialize();
    }

    try {
      // 尝试获取用户信息来验证授权状态
      // Privy API 会返回 delegation 状态
      const user = await this.privyClient.getUserByWalletAddress(
        this.config.userWalletAddress
      );

      // 检查 embedded wallet 的 delegation 状态
      const wallet = user?.linkedAccounts?.find(
        (a: any) => a.type === 'wallet' && a.walletClientType === 'privy'
      );

      return wallet?.delegated === true;
    } catch (error) {
      return false;
    }
  }
}

export type {
  PrivyWalletConfig,
  TransactionRequest,
  TransactionResult,
  SignatureResult,
  TypedDataDomain,
  TypedDataTypes,
};
