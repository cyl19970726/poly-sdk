/**
 * CTFManager - Unified CTF Operations and Event Monitoring
 *
 * Core Design Philosophy:
 * - Unifies CTF operations (split/merge/redeem) + real-time event monitoring
 * - Monitors on-chain ERC1155 Transfer events (not polling!)
 * - Provides complete operation lifecycle tracking
 * - Auto-validates operations before submission
 *
 * Architecture (similar to OrderManager):
 * ```
 * CTFManager
 * ├── CTFClient (execute operations)
 * ├── ethers.Contract (listen to ERC1155 events)
 * └── Event Emitter (operation_detected, transaction_confirmed)
 * ```
 *
 * @example
 * ```typescript
 * const ctfMgr = new CTFManager({
 *   privateKey: '0x...',
 *   conditionId: '0x...',
 *   primaryTokenId: '123...',
 *   secondaryTokenId: '456...',
 * });
 *
 * await ctfMgr.start();
 *
 * // Listen to real-time CTF events
 * ctfMgr.on('split_detected', (event) => {
 *   console.log(`Split: ${event.amount} USDC → tokens`);
 * });
 *
 * ctfMgr.on('merge_detected', (event) => {
 *   console.log(`Merge: ${event.amount} tokens → USDC`);
 * });
 *
 * ctfMgr.on('redeem_detected', (event) => {
 *   console.log(`Redeem: ${event.amount} winning tokens`);
 * });
 *
 * // Execute operations (automatically tracked)
 * await ctfMgr.split('100');
 * await ctfMgr.merge('50');
 * await ctfMgr.redeem();
 * ```
 */

import { EventEmitter } from 'events';
import { ethers, Contract } from 'ethers';
import { CTFClient, CTF_CONTRACT, type SplitResult, type MergeResult, type RedeemResult } from '../clients/ctf-client.js';

// ============================================================================
// Configuration & Types
// ============================================================================

export interface CTFManagerConfig {
  /** Private key for signing transactions */
  privateKey: string;
  /** Market condition ID */
  conditionId: string;
  /** Primary token ID (YES/primary outcome) */
  primaryTokenId: string;
  /** Secondary token ID (NO/secondary outcome) */
  secondaryTokenId: string;
  /** RPC URL for Polygon (default: public RPC) */
  rpcUrl?: string;
  /** Chain ID (default: 137 Polygon mainnet) */
  chainId?: number;
  /** Enable debug logging */
  debug?: boolean;
  /** Whether this market uses NegRisk (routes to NegRisk Adapter) */
  negRisk?: boolean;
}

/**
 * CTF operation types
 */
export type CTFOperationType = 'split' | 'merge' | 'redeem';

/**
 * Split event (USDC → YES + NO tokens)
 */
export interface SplitEvent {
  type: 'split';
  userAddress: string;
  conditionId: string;
  primaryTokenId: string;
  secondaryTokenId: string;
  amount: string;
  txHash: string;
  blockNumber: number;
  timestamp: number;
}

/**
 * Merge event (YES + NO tokens → USDC)
 */
export interface MergeEvent {
  type: 'merge';
  userAddress: string;
  conditionId: string;
  primaryTokenId: string;
  secondaryTokenId: string;
  amount: string;
  txHash: string;
  blockNumber: number;
  timestamp: number;
}

/**
 * Redeem event (Winning tokens → USDC)
 */
export interface RedeemEvent {
  type: 'redeem';
  userAddress: string;
  conditionId: string;
  winningTokenId: string;
  amount: string;
  txHash: string;
  blockNumber: number;
  timestamp: number;
}

/**
 * Union type for all CTF events
 */
export type CTFEvent = SplitEvent | MergeEvent | RedeemEvent;

// ============================================================================
// CTFManager Implementation
// ============================================================================

export class CTFManager extends EventEmitter {
  // ========== Dependencies ==========
  private ctfClient: CTFClient;
  private provider: ethers.providers.Provider;
  private ctfContract: Contract;

  // ========== Configuration ==========
  private config: Required<CTFManagerConfig>;
  private initialized = false;
  private userAddress: string;

  // ========== Event Tracking ==========
  private processedEvents: Set<string> = new Set();

  constructor(config: CTFManagerConfig) {
    super();

    this.config = {
      rpcUrl: config.rpcUrl ?? 'https://polygon-rpc.com',
      chainId: config.chainId ?? 137,
      debug: config.debug ?? false,
      negRisk: config.negRisk ?? false,
      ...config,
    };

    // Initialize CTFClient for operations
    this.ctfClient = new CTFClient({
      privateKey: config.privateKey,
      rpcUrl: this.config.rpcUrl,
      chainId: this.config.chainId,
    });

    // Initialize provider for event listening
    this.provider = new ethers.providers.JsonRpcProvider(this.config.rpcUrl);

    // Get user address from private key
    const wallet = new ethers.Wallet(config.privateKey);
    this.userAddress = wallet.address;

    // Initialize CTF contract for event listening
    const CTF_ABI = [
      // ERC-1155 standard events
      'event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)',
      'event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)',
      // CTF-specific events (faster and more reliable detection)
      'event PositionSplit(address indexed stakeholder, address indexed collateralToken, bytes32 indexed parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount)',
      'event PositionsMerge(address indexed stakeholder, address indexed collateralToken, bytes32 indexed parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount)',
      'event PayoutRedemption(address indexed redeemer, address indexed collateralToken, bytes32 indexed parentCollectionId, bytes32 conditionId, uint256[] indexSets, uint256 payout)',
    ];
    this.ctfContract = new Contract(CTF_CONTRACT, CTF_ABI, this.provider);
  }

  // ============================================================================
  // Lifecycle Management
  // ============================================================================

  /**
   * Start CTFManager
   * - Starts listening to CTF-specific events (primary detection)
   * - Also listens to ERC1155 Transfer events (fallback)
   */
  async start(): Promise<void> {
    if (this.initialized) return;

    // ========== Primary Detection: CTF-specific events ==========
    // These provide direct, fast detection without parsing Transfer events

    // Listen to PositionSplit events
    this.ctfContract.on(
      'PositionSplit',
      async (stakeholder, collateralToken, parentCollectionId, conditionId, partition, amount, event) => {
        await this.handlePositionSplit(stakeholder, conditionId, amount, event);
      }
    );

    // Listen to PositionsMerge events
    this.ctfContract.on(
      'PositionsMerge',
      async (stakeholder, collateralToken, parentCollectionId, conditionId, partition, amount, event) => {
        await this.handlePositionsMerge(stakeholder, conditionId, amount, event);
      }
    );

    // Listen to PayoutRedemption events
    this.ctfContract.on(
      'PayoutRedemption',
      async (redeemer, collateralToken, parentCollectionId, conditionId, indexSets, payout, event) => {
        await this.handlePayoutRedemption(redeemer, conditionId, indexSets, payout, event);
      }
    );

    // ========== Fallback Detection: ERC1155 Transfer events ==========
    // Keep these as fallback in case CTF events are not emitted for some reason

    // Listen to TransferSingle events (covers split/merge/redeem)
    this.ctfContract.on(
      'TransferSingle',
      async (operator, from, to, id, value, event) => {
        await this.handleTransferSingle(operator, from, to, id, value, event);
      }
    );

    // Listen to TransferBatch events (less common, but possible)
    this.ctfContract.on(
      'TransferBatch',
      async (operator, from, to, ids, values, event) => {
        await this.handleTransferBatch(operator, from, to, ids, values, event);
      }
    );

    this.initialized = true;
    this.log('CTFManager started, listening to on-chain events (CTF-specific + Transfer fallback)');
    this.emit('initialized');
  }

  /**
   * Stop CTFManager
   * - Removes all event listeners
   */
  stop(): void {
    // Remove CTF-specific event listeners
    this.ctfContract.removeAllListeners('PositionSplit');
    this.ctfContract.removeAllListeners('PositionsMerge');
    this.ctfContract.removeAllListeners('PayoutRedemption');
    // Remove Transfer event listeners
    this.ctfContract.removeAllListeners('TransferSingle');
    this.ctfContract.removeAllListeners('TransferBatch');
    this.initialized = false;
    this.log('CTFManager stopped');
    this.emit('stopped');
  }

  // ============================================================================
  // CTF Operations (Execute + Auto-Track)
  // ============================================================================

  /**
   * Split USDC into YES + NO tokens
   * Transaction is automatically tracked via on-chain events
   */
  async split(amount: string): Promise<SplitResult> {
    if (!this.initialized) {
      throw new Error('CTFManager not initialized. Call start() first.');
    }

    this.log(`Splitting ${amount} USDC...`);

    const tokenIds = {
      yesTokenId: this.config.primaryTokenId,
      noTokenId: this.config.secondaryTokenId,
    };

    const result = await this.ctfClient.splitByTokenIds(
      this.config.conditionId,
      tokenIds,
      amount,
      this.config.negRisk,
    );

    if (result.success) {
      this.log(`Split successful: ${result.txHash}`);
      // Event will be automatically detected via TransferSingle listener
    }

    return result;
  }

  /**
   * Merge YES + NO tokens into USDC
   * Transaction is automatically tracked via on-chain events
   */
  async merge(amount: string): Promise<MergeResult> {
    if (!this.initialized) {
      throw new Error('CTFManager not initialized. Call start() first.');
    }

    this.log(`Merging ${amount} tokens...`);

    const tokenIds = {
      yesTokenId: this.config.primaryTokenId,
      noTokenId: this.config.secondaryTokenId,
    };

    const result = await this.ctfClient.mergeByTokenIds(
      this.config.conditionId,
      tokenIds,
      amount,
      this.config.negRisk,
    );

    if (result.success) {
      this.log(`Merge successful: ${result.txHash}`);
      // Event will be automatically detected via TransferSingle listener
    }

    return result;
  }

  /**
   * Redeem winning tokens for USDC (after market resolution)
   * Transaction is automatically tracked via on-chain events
   */
  async redeem(outcome?: string): Promise<RedeemResult> {
    if (!this.initialized) {
      throw new Error('CTFManager not initialized. Call start() first.');
    }

    this.log(`Redeeming tokens...`);

    const tokenIds = {
      yesTokenId: this.config.primaryTokenId,
      noTokenId: this.config.secondaryTokenId,
    };

    const result = await this.ctfClient.redeemByTokenIds(
      this.config.conditionId,
      tokenIds,
      outcome,
      this.config.negRisk,
    );

    if (result.success) {
      this.log(`Redeem successful: ${result.txHash}`);
      // Event will be automatically detected via TransferSingle listener
    }

    return result;
  }

  // ============================================================================
  // Event Handlers
  // ============================================================================

  /**
   * Handle TransferSingle event
   *
   * ERC1155 TransferSingle patterns:
   * - Split:  from=0x0, to=user, id=YES/NO (two events)
   * - Merge:  from=user, to=0x0, id=YES/NO (two events)
   * - Redeem: from=user, to=0x0, id=winningToken (one event)
   */
  private async handleTransferSingle(
    operator: string,
    from: string,
    to: string,
    id: ethers.BigNumber,
    value: ethers.BigNumber,
    event: ethers.Event
  ): Promise<void> {
    try {
      // Only track events for this user
      const fromLower = from.toLowerCase();
      const toLower = to.toLowerCase();
      const userLower = this.userAddress.toLowerCase();

      if (fromLower !== userLower && toLower !== userLower) {
        return; // Not this user's event
      }

      const tokenId = id.toString();
      const amount = value.toString();

      // Check if this token belongs to our market
      if (tokenId !== this.config.primaryTokenId && tokenId !== this.config.secondaryTokenId) {
        return; // Different market
      }

      // Deduplication
      const eventKey = `${event.transactionHash}-${event.logIndex}`;
      if (this.processedEvents.has(eventKey)) {
        return;
      }
      this.processedEvents.add(eventKey);

      // Cleanup old processed events (keep last 1000)
      if (this.processedEvents.size > 2000) {
        const toKeep = Array.from(this.processedEvents).slice(-1000);
        this.processedEvents = new Set(toKeep);
      }

      // Get block timestamp
      const block = await event.getBlock();
      const timestamp = block.timestamp * 1000; // Convert to ms

      // Detect operation type
      if (fromLower === ethers.constants.AddressZero.toLowerCase() && toLower === userLower) {
        // Split: 0x0 → user
        await this.detectSplit(tokenId, amount, event.transactionHash!, event.blockNumber, timestamp);
      } else if (fromLower === userLower && toLower === ethers.constants.AddressZero.toLowerCase()) {
        // Merge or Redeem: user → 0x0
        await this.detectMergeOrRedeem(tokenId, amount, event.transactionHash!, event.blockNumber, timestamp);
      }
    } catch (error) {
      console.error('[CTFManager] Error handling TransferSingle:', error);
      this.emit('error', error);
    }
  }

  /**
   * Handle TransferBatch event (less common)
   */
  private async handleTransferBatch(
    operator: string,
    from: string,
    to: string,
    ids: ethers.BigNumber[],
    values: ethers.BigNumber[],
    event: ethers.Event
  ): Promise<void> {
    // TransferBatch is less common for CTF operations
    // But we should handle it for completeness
    for (let i = 0; i < ids.length; i++) {
      await this.handleTransferSingle(operator, from, to, ids[i], values[i], event);
    }
  }

  // ============================================================================
  // CTF-Specific Event Handlers (Primary Detection)
  // ============================================================================

  /**
   * Handle PositionSplit event
   * Direct detection of Split operation - faster than parsing Transfer events
   */
  private async handlePositionSplit(
    stakeholder: string,
    conditionId: ethers.utils.BytesLike,
    amount: ethers.BigNumber,
    event: ethers.Event
  ): Promise<void> {
    try {
      // Only track events for this user
      if (stakeholder.toLowerCase() !== this.userAddress.toLowerCase()) {
        return;
      }

      // Only track events for this market
      const conditionIdHex = ethers.utils.hexlify(conditionId);
      if (conditionIdHex.toLowerCase() !== this.config.conditionId.toLowerCase()) {
        return;
      }

      // Deduplication
      const eventKey = `split-${event.transactionHash}-${event.logIndex}`;
      if (this.processedEvents.has(eventKey)) {
        return;
      }
      this.processedEvents.add(eventKey);

      // Cleanup old processed events (keep last 1000)
      if (this.processedEvents.size > 2000) {
        const toKeep = Array.from(this.processedEvents).slice(-1000);
        this.processedEvents = new Set(toKeep);
      }

      // Get block timestamp
      const block = await event.getBlock();
      const timestamp = block.timestamp * 1000; // Convert to ms

      // Convert amount from wei to USDC (6 decimals)
      const amountStr = ethers.utils.formatUnits(amount, 6);

      const splitEvent: SplitEvent = {
        type: 'split',
        userAddress: this.userAddress,
        conditionId: this.config.conditionId,
        primaryTokenId: this.config.primaryTokenId,
        secondaryTokenId: this.config.secondaryTokenId,
        amount: amountStr,
        txHash: event.transactionHash!,
        blockNumber: event.blockNumber,
        timestamp,
      };

      this.log(`[CTF Event] Split detected: ${amountStr} USDC`);
      this.emit('split_detected', splitEvent);
      this.emit('operation_detected', splitEvent);
    } catch (error) {
      console.error('[CTFManager] Error handling PositionSplit:', error);
      this.emit('error', error);
    }
  }

  /**
   * Handle PositionsMerge event
   * Direct detection of Merge operation - faster than parsing Transfer events
   */
  private async handlePositionsMerge(
    stakeholder: string,
    conditionId: ethers.utils.BytesLike,
    amount: ethers.BigNumber,
    event: ethers.Event
  ): Promise<void> {
    try {
      // Only track events for this user
      if (stakeholder.toLowerCase() !== this.userAddress.toLowerCase()) {
        return;
      }

      // Only track events for this market
      const conditionIdHex = ethers.utils.hexlify(conditionId);
      if (conditionIdHex.toLowerCase() !== this.config.conditionId.toLowerCase()) {
        return;
      }

      // Deduplication
      const eventKey = `merge-${event.transactionHash}-${event.logIndex}`;
      if (this.processedEvents.has(eventKey)) {
        return;
      }
      this.processedEvents.add(eventKey);

      // Cleanup old processed events (keep last 1000)
      if (this.processedEvents.size > 2000) {
        const toKeep = Array.from(this.processedEvents).slice(-1000);
        this.processedEvents = new Set(toKeep);
      }

      // Get block timestamp
      const block = await event.getBlock();
      const timestamp = block.timestamp * 1000; // Convert to ms

      // Convert amount from wei to USDC (6 decimals)
      const amountStr = ethers.utils.formatUnits(amount, 6);

      const mergeEvent: MergeEvent = {
        type: 'merge',
        userAddress: this.userAddress,
        conditionId: this.config.conditionId,
        primaryTokenId: this.config.primaryTokenId,
        secondaryTokenId: this.config.secondaryTokenId,
        amount: amountStr,
        txHash: event.transactionHash!,
        blockNumber: event.blockNumber,
        timestamp,
      };

      this.log(`[CTF Event] Merge detected: ${amountStr} USDC`);
      this.emit('merge_detected', mergeEvent);
      this.emit('operation_detected', mergeEvent);
    } catch (error) {
      console.error('[CTFManager] Error handling PositionsMerge:', error);
      this.emit('error', error);
    }
  }

  /**
   * Handle PayoutRedemption event
   * Direct detection of Redeem operation - faster than parsing Transfer events
   */
  private async handlePayoutRedemption(
    redeemer: string,
    conditionId: ethers.utils.BytesLike,
    indexSets: ethers.BigNumber[],
    payout: ethers.BigNumber,
    event: ethers.Event
  ): Promise<void> {
    try {
      // Only track events for this user
      if (redeemer.toLowerCase() !== this.userAddress.toLowerCase()) {
        return;
      }

      // Only track events for this market
      const conditionIdHex = ethers.utils.hexlify(conditionId);
      if (conditionIdHex.toLowerCase() !== this.config.conditionId.toLowerCase()) {
        return;
      }

      // Deduplication
      const eventKey = `redeem-${event.transactionHash}-${event.logIndex}`;
      if (this.processedEvents.has(eventKey)) {
        return;
      }
      this.processedEvents.add(eventKey);

      // Cleanup old processed events (keep last 1000)
      if (this.processedEvents.size > 2000) {
        const toKeep = Array.from(this.processedEvents).slice(-1000);
        this.processedEvents = new Set(toKeep);
      }

      // Get block timestamp
      const block = await event.getBlock();
      const timestamp = block.timestamp * 1000; // Convert to ms

      // Convert payout from wei to USDC (6 decimals)
      const payoutStr = ethers.utils.formatUnits(payout, 6);

      // Determine which token was redeemed based on indexSets
      // indexSets[0] represents the outcome index (0 or 1)
      const outcomeIndex = indexSets[0].toNumber();
      const winningTokenId = outcomeIndex === 0
        ? this.config.primaryTokenId
        : this.config.secondaryTokenId;

      const redeemEvent: RedeemEvent = {
        type: 'redeem',
        userAddress: this.userAddress,
        conditionId: this.config.conditionId,
        winningTokenId,
        amount: payoutStr,
        txHash: event.transactionHash!,
        blockNumber: event.blockNumber,
        timestamp,
      };

      this.log(`[CTF Event] Redeem detected: ${payoutStr} USDC (token ${winningTokenId})`);
      this.emit('redeem_detected', redeemEvent);
      this.emit('operation_detected', redeemEvent);
    } catch (error) {
      console.error('[CTFManager] Error handling PayoutRedemption:', error);
      this.emit('error', error);
    }
  }

  /**
   * Detect split operation
   * Split creates TWO Transfer events (0x0 → user) for both tokens
   * We need to wait for the second event to confirm it's a split
   */
  private async detectSplit(
    tokenId: string,
    amount: string,
    txHash: string,
    blockNumber: number,
    timestamp: number
  ): Promise<void> {
    // Wait a bit to see if there's a second Transfer event
    // (Split always creates two events in the same transaction)
    await new Promise(resolve => setTimeout(resolve, 1000));

    const event: SplitEvent = {
      type: 'split',
      userAddress: this.userAddress,
      conditionId: this.config.conditionId,
      primaryTokenId: this.config.primaryTokenId,
      secondaryTokenId: this.config.secondaryTokenId,
      amount,
      txHash,
      blockNumber,
      timestamp,
    };

    this.log(`Split detected: ${amount} tokens`);
    this.emit('split_detected', event);
    this.emit('operation_detected', event);
  }

  /**
   * Detect merge or redeem operation
   * - Merge: TWO Transfer events (user → 0x0) for both tokens
   * - Redeem: ONE Transfer event (user → 0x0) for winning token
   */
  private async detectMergeOrRedeem(
    tokenId: string,
    amount: string,
    txHash: string,
    blockNumber: number,
    timestamp: number
  ): Promise<void> {
    // Wait a bit to see if there's a second Transfer event
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Get all Transfer events in this transaction
    const receipt = await this.provider.getTransactionReceipt(txHash);
    const transfers = receipt.logs
      .filter(log => {
        try {
          const parsed = this.ctfContract.interface.parseLog(log);
          return parsed.name === 'TransferSingle';
        } catch {
          return false;
        }
      })
      .map(log => this.ctfContract.interface.parseLog(log));

    const userTransfers = transfers.filter(
      t => t.args.from.toLowerCase() === this.userAddress.toLowerCase()
    );

    if (userTransfers.length === 2) {
      // Merge: both tokens transferred
      const event: MergeEvent = {
        type: 'merge',
        userAddress: this.userAddress,
        conditionId: this.config.conditionId,
        primaryTokenId: this.config.primaryTokenId,
        secondaryTokenId: this.config.secondaryTokenId,
        amount,
        txHash,
        blockNumber,
        timestamp,
      };

      this.log(`Merge detected: ${amount} tokens`);
      this.emit('merge_detected', event);
      this.emit('operation_detected', event);
    } else if (userTransfers.length === 1) {
      // Redeem: only winning token transferred
      const event: RedeemEvent = {
        type: 'redeem',
        userAddress: this.userAddress,
        conditionId: this.config.conditionId,
        winningTokenId: tokenId,
        amount,
        txHash,
        blockNumber,
        timestamp,
      };

      this.log(`Redeem detected: ${amount} tokens (${tokenId})`);
      this.emit('redeem_detected', event);
      this.emit('operation_detected', event);
    }
  }

  // ============================================================================
  // Helpers
  // ============================================================================

  /**
   * Log message (if debug enabled)
   */
  private log(message: string): void {
    if (this.config.debug) {
      console.log(`[CTFManager] ${message}`);
    }
  }

  /**
   * Get current balances
   */
  async getBalances(): Promise<{
    primary: string;
    secondary: string;
  }> {
    const tokenIds = {
      yesTokenId: this.config.primaryTokenId,
      noTokenId: this.config.secondaryTokenId,
    };

    const balance = await this.ctfClient.getPositionBalanceByTokenIds(
      this.config.conditionId,
      tokenIds
    );

    return {
      primary: balance.yesBalance,
      secondary: balance.noBalance,
    };
  }
}
