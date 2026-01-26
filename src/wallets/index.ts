/**
 * Wallet Management Module
 *
 * Provides different wallet strategies for automated trading:
 *
 * 1. HotWalletService - Self-managed hot wallets with encrypted private keys
 *    - Best for: Full automation, strategy execution
 *    - Security: AES-256-GCM encryption, we manage keys
 *
 * 2. PrivyWallet - Privy Delegated Actions (future implementation)
 *    - Best for: When users prefer Privy key custody
 *    - Security: Privy manages keys with TEE + key sharding
 */

export {
  HotWalletService,
  type HotWalletServiceConfig,
  type IWalletStore,
  type WalletInfo,
  type EncryptedData,
} from './hot-wallet-service.js';

// PrivyWallet is optional - only available if @privy-io/server-auth is installed
// Temporarily disabled due to missing @privy-io/server-auth dependency
// export {
//   PrivyWallet,
//   type PrivyWalletConfig,
//   type TransactionRequest,
//   type TransactionResult,
//   type SignatureResult,
//   type TypedDataDomain,
//   type TypedDataTypes,
// } from './privy-wallet.js';
