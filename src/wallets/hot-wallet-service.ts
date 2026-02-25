/**
 * HotWalletService - 自管 Hot Wallet 服务
 *
 * 为每个用户创建专用的 hot wallet，私钥加密存储在服务端。
 * 策略引擎可以完全自动执行所有链上操作。
 *
 * 安全措施：
 * 1. 私钥使用 AES-256-GCM 加密存储
 * 2. 加密密钥从环境变量读取（生产环境应使用 KMS）
 * 3. 私钥解密后仅在内存中短暂存在
 * 4. 操作完成后立即清除内存中的私钥
 *
 * @example
 * ```typescript
 * const hotWalletService = new HotWalletService({
 *   encryptionKey: process.env.WALLET_ENCRYPTION_KEY!,
 *   store: new UserStore(), // 实现 IWalletStore 接口
 * });
 *
 * // 创建新钱包
 * const { address, encryptedKey } = await hotWalletService.createWallet();
 *
 * // 执行操作
 * await hotWalletService.executeWithWallet(userId, async (wallet) => {
 *   await wallet.sendTransaction({ to: '0x...', data: '0x...' });
 * });
 * ```
 */

import { ethers } from 'ethers';
import * as crypto from 'crypto';

// ===== Types =====

export interface HotWalletServiceConfig {
  /** 32-byte hex string for AES-256 encryption */
  encryptionKey: string;
  /** Wallet store implementation */
  store: IWalletStore;
  /** RPC URL (default: Polygon mainnet) */
  rpcUrl?: string;
  /** Chain ID (default: 137) */
  chainId?: number;
}

export interface IWalletStore {
  /** Get encrypted private key by user ID */
  getEncryptedKey(userId: string): Promise<string | null>;
  /** Store encrypted private key for user */
  setEncryptedKey(userId: string, encryptedKey: string, address: string): Promise<void>;
  /** Get wallet address by user ID */
  getWalletAddress(userId: string): Promise<string | null>;
  /** Check if user has a wallet */
  hasWallet(userId: string): Promise<boolean>;
}

export interface WalletInfo {
  address: string;
  encryptedKey: string;
}

export interface EncryptedData {
  /** Initialization vector (hex) */
  iv: string;
  /** Auth tag for GCM (hex) */
  authTag: string;
  /** Encrypted data (hex) */
  data: string;
}

// ===== HotWalletService =====

export class HotWalletService {
  private config: Required<HotWalletServiceConfig>;
  private provider: ethers.providers.JsonRpcProvider;

  constructor(config: HotWalletServiceConfig) {
    // Validate encryption key
    if (!config.encryptionKey || config.encryptionKey.length !== 64) {
      throw new Error(
        'Invalid encryption key. Must be a 32-byte hex string (64 characters).'
      );
    }

    this.config = {
      rpcUrl: 'https://polygon-rpc.com',
      chainId: 137,
      ...config,
    };

    this.provider = new ethers.providers.JsonRpcProvider(
      this.config.rpcUrl,
      this.config.chainId
    );
  }

  // ===== Wallet Management =====

  /**
   * 创建新的 Hot Wallet
   *
   * @returns 钱包地址和加密后的私钥
   */
  async createWallet(): Promise<WalletInfo> {
    // 生成新钱包
    const wallet = ethers.Wallet.createRandom();

    // 加密私钥
    const encryptedKey = this.encryptPrivateKey(wallet.privateKey);

    return {
      address: wallet.address,
      encryptedKey: JSON.stringify(encryptedKey),
    };
  }


  /**
   * 导入已有私钥到加密存储
   *
   * @param privateKey - 私钥（hex string，可带 0x 前缀）
   * @returns 钱包地址和加密后的私钥
   */
  async importWallet(privateKey: string): Promise<WalletInfo> {
    const wallet = new ethers.Wallet(privateKey);
    const encryptedKey = this.encryptPrivateKey(wallet.privateKey);

    return {
      address: wallet.address,
      encryptedKey: JSON.stringify(encryptedKey),
    };
  }

  /**
   * 为用户创建并存储钱包
   *
   * @param userId - 用户 ID
   * @returns 钱包地址
   */
  async createWalletForUser(userId: string): Promise<string> {
    // 检查是否已有钱包
    if (await this.config.store.hasWallet(userId)) {
      const existingAddress = await this.config.store.getWalletAddress(userId);
      if (existingAddress) {
        return existingAddress;
      }
    }

    // 创建新钱包
    const { address, encryptedKey } = await this.createWallet();

    // 存储
    await this.config.store.setEncryptedKey(userId, encryptedKey, address);

    return address;
  }

  /**
   * 获取用户的钱包地址
   *
   * @param userId - 用户 ID
   * @returns 钱包地址，如果没有则返回 null
   */
  async getWalletAddress(userId: string): Promise<string | null> {
    return this.config.store.getWalletAddress(userId);
  }

  /**
   * 检查用户是否有钱包
   *
   * @param userId - 用户 ID
   */
  async hasWallet(userId: string): Promise<boolean> {
    return this.config.store.hasWallet(userId);
  }

  // ===== Wallet Operations =====

  /**
   * 使用用户钱包执行操作
   *
   * 私钥仅在回调执行期间存在于内存中，执行完毕后立即清除。
   *
   * @param userId - 用户 ID
   * @param callback - 使用钱包执行的操作
   * @returns 回调的返回值
   */
  async executeWithWallet<T>(
    userId: string,
    callback: (wallet: ethers.Wallet) => Promise<T>
  ): Promise<T> {
    // 获取加密私钥
    const encryptedKey = await this.config.store.getEncryptedKey(userId);
    if (!encryptedKey) {
      throw new Error(`No wallet found for user: ${userId}`);
    }

    // 解密私钥
    let privateKey: string | null = null;
    let wallet: ethers.Wallet | null = null;

    try {
      const encrypted: EncryptedData = JSON.parse(encryptedKey);
      privateKey = this.decryptPrivateKey(encrypted);

      // 创建钱包实例
      wallet = new ethers.Wallet(privateKey, this.provider);

      // 执行回调
      return await callback(wallet);
    } finally {
      // 清除内存中的敏感数据
      if (privateKey) {
        // 覆盖字符串内存（JavaScript 中的最佳努力）
        privateKey = '0'.repeat(privateKey.length);
      }
      privateKey = null;
      wallet = null;
    }
  }

  /**
   * 获取用户钱包的私钥（危险操作，仅用于初始化 SDK）
   *
   * 调用者必须负责安全处理私钥！
   *
   * @param userId - 用户 ID
   * @returns 私钥
   */
  async getPrivateKey(userId: string): Promise<string> {
    const encryptedKey = await this.config.store.getEncryptedKey(userId);
    if (!encryptedKey) {
      throw new Error(`No wallet found for user: ${userId}`);
    }

    const encrypted: EncryptedData = JSON.parse(encryptedKey);
    return this.decryptPrivateKey(encrypted);
  }

  // ===== Convenience Methods =====

  /**
   * 获取用户钱包余额
   *
   * @param userId - 用户 ID
   */
  async getBalance(userId: string): Promise<{
    matic: string;
    maticWei: string;
  }> {
    const address = await this.config.store.getWalletAddress(userId);
    if (!address) {
      throw new Error(`No wallet found for user: ${userId}`);
    }

    const balance = await this.provider.getBalance(address);
    return {
      matic: ethers.utils.formatEther(balance),
      maticWei: balance.toString(),
    };
  }

  /**
   * 发送交易
   *
   * @param userId - 用户 ID
   * @param tx - 交易参数
   */
  async sendTransaction(
    userId: string,
    tx: ethers.providers.TransactionRequest
  ): Promise<ethers.providers.TransactionResponse> {
    return this.executeWithWallet(userId, async (wallet) => {
      return wallet.sendTransaction(tx);
    });
  }

  /**
   * 签名消息
   *
   * @param userId - 用户 ID
   * @param message - 消息
   */
  async signMessage(userId: string, message: string): Promise<string> {
    return this.executeWithWallet(userId, async (wallet) => {
      return wallet.signMessage(message);
    });
  }

  /**
   * 签名 EIP-712 类型数据
   *
   * @param userId - 用户 ID
   * @param domain - EIP-712 domain
   * @param types - EIP-712 types
   * @param value - 要签名的数据
   */
  async signTypedData(
    userId: string,
    domain: ethers.TypedDataDomain,
    types: Record<string, ethers.TypedDataField[]>,
    value: Record<string, any>
  ): Promise<string> {
    return this.executeWithWallet(userId, async (wallet) => {
      return wallet._signTypedData(domain, types, value);
    });
  }

  // ===== Encryption/Decryption =====

  /**
   * 加密私钥
   */
  private encryptPrivateKey(privateKey: string): EncryptedData {
    const key = Buffer.from(this.config.encryptionKey, 'hex');
    const iv = crypto.randomBytes(16);

    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

    let encrypted = cipher.update(privateKey, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const authTag = cipher.getAuthTag();

    return {
      iv: iv.toString('hex'),
      authTag: authTag.toString('hex'),
      data: encrypted,
    };
  }

  /**
   * 解密私钥
   */
  private decryptPrivateKey(encrypted: EncryptedData): string {
    const key = Buffer.from(this.config.encryptionKey, 'hex');
    const iv = Buffer.from(encrypted.iv, 'hex');
    const authTag = Buffer.from(encrypted.authTag, 'hex');

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encrypted.data, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  }

  // ===== Static Helpers =====

  /**
   * 生成加密密钥
   *
   * 用于首次设置时生成 WALLET_ENCRYPTION_KEY
   */
  static generateEncryptionKey(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  /**
   * 验证加密密钥格式
   */
  static validateEncryptionKey(key: string): boolean {
    return /^[a-f0-9]{64}$/i.test(key);
  }
}
