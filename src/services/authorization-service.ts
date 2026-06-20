/**
 * Authorization Service
 *
 * Manages ERC20 and ERC1155 approvals required for trading on Polymarket V2.
 *
 * V2 collateral model (post-2026-04-28 cutover):
 *   - Trading collateral is pUSD (not USDC.e). pUSD is approved to the V2
 *     CTF Exchange + V2 NegRisk Exchange + NegRisk Adapter.
 *   - USDC.e remains relevant ONLY as the "off-exchange" rail:
 *       USDC.e --(approve Onramp)--> wrap() --> pUSD
 *     The USDC.e approval target is therefore the Collateral Onramp, NOT any
 *     V2 Exchange. This service emits separate approval rows for the two
 *     tokens.
 *   - ERC1155 (Conditional Tokens) operators are the V2 Exchanges + the
 *     NegRisk Adapter, all unchanged in spirit but pointing at V2 addresses.
 *
 * V1 approvals on V1 Exchanges are NOT revoked by this service — they are
 * harmless on the V2 rail (V1 Exchange contracts no longer accept orders).
 * Callers wanting to revoke can do so manually; default `approveAll()` only
 * sets the V2 approval matrix.
 *
 * @see https://docs.polymarket.com/v2-migration
 * @see ../constants/v2-contracts.ts (V2 contract SSOT)
 */

import { ethers } from 'ethers';
import { CTF_CONTRACT } from '../clients/ctf-client.js';
import { POLYGON_CONTRACTS_V2 } from '../constants/v2-contracts.js';

// Conditional Tokens ERC1155 (UNCHANGED across V1/V2).
const CONDITIONAL_TOKENS = CTF_CONTRACT;

// ABIs
const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
];

const ERC1155_ABI = [
  'function setApprovalForAll(address operator, bool approved) external',
  'function isApprovedForAll(address account, address operator) view returns (bool)',
];

// Types
export interface AllowanceInfo {
  contract: string;
  address: string;
  approved: boolean;
  allowance?: string;
  /** ERC20 only: which token's allowance this row reports (`pUSD` vs `USDC.e`). */
  token?: 'pUSD' | 'USDC.e';
}

export interface AllowancesResult {
  wallet: string;
  /** Wallet's pUSD balance (V2 trading collateral). */
  pusdBalance: string;
  /** Wallet's USDC.e balance (off-exchange rail). */
  usdcEBalance: string;
  erc20Allowances: AllowanceInfo[];
  erc1155Approvals: AllowanceInfo[];
  tradingReady: boolean;
  issues: string[];
}

export interface ApprovalTxResult {
  contract: string;
  txHash?: string;
  success: boolean;
  error?: string;
  /** ERC20 only: which token's allowance was set in this row. */
  token?: 'pUSD' | 'USDC.e';
}

export interface ApprovalsResult {
  wallet: string;
  erc20Approvals: ApprovalTxResult[];
  erc1155Approvals: ApprovalTxResult[];
  allApproved: boolean;
  summary: string;
}

export interface AuthorizationServiceConfig {
  provider?: ethers.providers.Provider;
}

/**
 * V2 ERC20 spender matrix.
 *
 * Two distinct token rails:
 *   - `pUSD` rows: trading collateral; approved to V2 Exchanges + Adapter so
 *     the matchOrders flow can pull pUSD from the maker/taker.
 *   - `USDC.e` row: NOT trading collateral on V2; the approval is to the
 *     Collateral Onramp so `wrap(USDC.e → pUSD)` can pull USDC.e from the
 *     wallet and mint pUSD to the same address.
 *
 * The optional `token` field disambiguates which ERC20 contract this row
 * targets. Older callers that ignore the field default to pUSD-correct
 * behaviour because all four V2 trading rows are pUSD.
 */
interface V2Erc20Spender {
  name: string;
  address: string;
  token: 'pUSD' | 'USDC.e';
}

const ERC20_SPENDERS_V2: readonly V2Erc20Spender[] = [
  { name: 'V2 CTF Exchange',         address: POLYGON_CONTRACTS_V2.ctfExchange,      token: 'pUSD' },
  { name: 'V2 NegRisk CTF Exchange', address: POLYGON_CONTRACTS_V2.negRiskExchange,  token: 'pUSD' },
  { name: 'NegRisk Adapter',         address: POLYGON_CONTRACTS_V2.negRiskAdapter,   token: 'pUSD' },
  { name: 'Onramp (USDC.e wrap)',    address: POLYGON_CONTRACTS_V2.collateralOnramp, token: 'USDC.e' },
];

/**
 * V2 ERC1155 operator list — operators that may transfer the wallet's
 * Conditional Token balances during order matching / NegRisk redemption.
 *
 * The NegRisk Adapter is retained as a separate operator: the V2 NegRisk
 * Exchange relies on the Adapter for split/merge during multi-outcome
 * resolution and the Adapter must be able to move the wallet's CTF tokens.
 */
const ERC1155_OPERATORS_V2 = [
  { name: 'V2 CTF Exchange',         address: POLYGON_CONTRACTS_V2.ctfExchange },
  { name: 'V2 NegRisk CTF Exchange', address: POLYGON_CONTRACTS_V2.negRiskExchange },
  { name: 'NegRisk Adapter',         address: POLYGON_CONTRACTS_V2.negRiskAdapter },
];

/**
 * Service for managing trading authorizations on Polymarket
 *
 * @example
 * ```typescript
 * const authService = new AuthorizationService(signer);
 *
 * // Check all allowances
 * const status = await authService.checkAllowances();
 * console.log(`Trading ready: ${status.tradingReady}`);
 * if (!status.tradingReady) {
 *   console.log('Issues:', status.issues);
 * }
 *
 * // Set up all approvals
 * const result = await authService.approveAll();
 * console.log(result.summary);
 * ```
 */
export class AuthorizationService {
  private signer: ethers.Wallet;
  private provider: ethers.providers.Provider;

  constructor(signer: ethers.Wallet, config: AuthorizationServiceConfig = {}) {
    this.signer = signer;
    this.provider = config.provider || signer.provider || new ethers.providers.JsonRpcProvider('https://polygon-rpc.com');
  }

  /**
   * Get the wallet address
   */
  get walletAddress(): string {
    return this.signer.address;
  }

  /**
   * Resolve the ERC20 token contract address for a V2 spender row.
   *
   * pUSD rows trade through the V2 Exchanges; USDC.e rows feed the Onramp.
   * Centralised so future V2 token additions only edit one place.
   */
  private erc20ContractForToken(token: 'pUSD' | 'USDC.e'): string {
    return token === 'pUSD'
      ? POLYGON_CONTRACTS_V2.pUSD
      : POLYGON_CONTRACTS_V2.usdcE;
  }

  /**
   * Check all V2 ERC20 and ERC1155 allowances required for trading.
   *
   * Reads pUSD balance + per-spender allowances on both pUSD and USDC.e, and
   * ERC1155 approvals on Conditional Tokens for the V2 operator set.
   *
   * @returns Status of all allowances and whether trading is ready
   */
  async checkAllowances(): Promise<AllowancesResult> {
    const walletAddress = this.signer.address;

    const pusd = new ethers.Contract(POLYGON_CONTRACTS_V2.pUSD, ERC20_ABI, this.provider);
    const usdcE = new ethers.Contract(POLYGON_CONTRACTS_V2.usdcE, ERC20_ABI, this.provider);
    const conditionalTokens = new ethers.Contract(CONDITIONAL_TOKENS, ERC1155_ABI, this.provider);

    // Balances
    const [pusdBal, usdcEBal] = await Promise.all([
      pusd.balanceOf(walletAddress),
      usdcE.balanceOf(walletAddress),
    ]);
    const pusdBalance = ethers.utils.formatUnits(pusdBal, 6);
    const usdcEBalance = ethers.utils.formatUnits(usdcEBal, 6);

    // Check ERC20 allowances per V2 spender row (token-specific)
    const erc20Allowances: AllowanceInfo[] = [];
    for (const spender of ERC20_SPENDERS_V2) {
      const tokenContract = spender.token === 'pUSD' ? pusd : usdcE;
      const allowance = await tokenContract.allowance(walletAddress, spender.address);
      const allowanceNum = parseFloat(ethers.utils.formatUnits(allowance, 6));
      const isUnlimited = allowanceNum > 1e12;

      erc20Allowances.push({
        contract: spender.name,
        address: spender.address,
        approved: isUnlimited,
        allowance: isUnlimited ? 'unlimited' : allowanceNum.toFixed(2),
        token: spender.token,
      });
    }

    // Check ERC1155 approvals
    const erc1155Approvals: AllowanceInfo[] = [];
    for (const operator of ERC1155_OPERATORS_V2) {
      const isApproved = await conditionalTokens.isApprovedForAll(walletAddress, operator.address);

      erc1155Approvals.push({
        contract: operator.name,
        address: operator.address,
        approved: isApproved,
      });
    }

    // Determine issues
    const issues: string[] = [];
    for (const a of erc20Allowances) {
      if (!a.approved) {
        issues.push(`ERC20 ${a.token ?? 'pUSD'}: ${a.contract} needs approval`);
      }
    }
    for (const a of erc1155Approvals) {
      if (!a.approved) {
        issues.push(`ERC1155: ${a.contract} needs approval for Conditional Tokens`);
      }
    }

    const tradingReady = issues.length === 0;

    return {
      wallet: walletAddress,
      pusdBalance,
      usdcEBalance,
      erc20Allowances,
      erc1155Approvals,
      tradingReady,
      issues,
    };
  }

  /**
   * Set up all required V2 approvals for trading.
   *
   * - 3 pUSD approvals (to V2 CTF Exchange / V2 NegRisk Exchange / NegRisk Adapter)
   * - 1 USDC.e approval (to Collateral Onramp, for `wrap()`)
   * - 3 ERC1155 approvals (V2 Exchanges + Adapter as Conditional Tokens operators)
   *
   * @returns Results of all approval transactions
   */
  async approveAll(): Promise<ApprovalsResult> {
    const walletAddress = this.signer.address;

    const tokenContracts = {
      pUSD: new ethers.Contract(POLYGON_CONTRACTS_V2.pUSD, ERC20_ABI, this.signer),
      'USDC.e': new ethers.Contract(POLYGON_CONTRACTS_V2.usdcE, ERC20_ABI, this.signer),
    } as const;
    const conditionalTokens = new ethers.Contract(CONDITIONAL_TOKENS, ERC1155_ABI, this.signer);

    // Get gas price with buffer
    const gasPrice = await this.provider.getGasPrice();
    const adjustedGasPrice = gasPrice.mul(150).div(100); // 1.5x

    // Process ERC20 approvals (token-aware)
    const erc20Results: ApprovalTxResult[] = [];
    for (const spender of ERC20_SPENDERS_V2) {
      const tokenContract = tokenContracts[spender.token];

      // Check current allowance
      const allowance = await tokenContract.allowance(walletAddress, spender.address);
      const allowanceNum = parseFloat(ethers.utils.formatUnits(allowance, 6));

      if (allowanceNum > 1e12) {
        // Already approved
        erc20Results.push({
          contract: spender.name,
          token: spender.token,
          success: true,
        });
        continue;
      }

      try {
        const tx = await tokenContract.approve(spender.address, ethers.constants.MaxUint256, {
          gasPrice: adjustedGasPrice,
        });
        await tx.wait();
        erc20Results.push({
          contract: spender.name,
          token: spender.token,
          txHash: tx.hash,
          success: true,
        });
      } catch (err) {
        erc20Results.push({
          contract: spender.name,
          token: spender.token,
          success: false,
          error: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    }

    // Process ERC1155 approvals
    const erc1155Results: ApprovalTxResult[] = [];
    for (const operator of ERC1155_OPERATORS_V2) {
      // Check current approval
      const isApproved = await conditionalTokens.isApprovedForAll(walletAddress, operator.address);

      if (isApproved) {
        // Already approved
        erc1155Results.push({
          contract: operator.name,
          success: true,
        });
        continue;
      }

      try {
        const tx = await conditionalTokens.setApprovalForAll(operator.address, true, {
          gasPrice: adjustedGasPrice,
          gasLimit: 100000,
        });
        await tx.wait();
        erc1155Results.push({
          contract: operator.name,
          txHash: tx.hash,
          success: true,
        });
      } catch (err) {
        erc1155Results.push({
          contract: operator.name,
          success: false,
          error: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    }

    const allApproved =
      erc20Results.every((r) => r.success) && erc1155Results.every((r) => r.success);

    const newApprovals = [...erc20Results, ...erc1155Results].filter((r) => r.txHash).length;

    return {
      wallet: walletAddress,
      erc20Approvals: erc20Results,
      erc1155Approvals: erc1155Results,
      allApproved,
      summary: allApproved
        ? newApprovals > 0
          ? `All approvals set. ${newApprovals} new approval(s) submitted.`
          : 'All approvals already set. Ready to trade.'
        : 'Some approvals failed. Check the results for details.',
    };
  }

  /**
   * Approve a single ERC20 spender.
   *
   * Defaults to pUSD (V2 trading collateral). Pass `token: 'USDC.e'` for
   * Onramp / off-exchange paths.
   *
   * @param spenderAddress - The contract address to approve
   * @param amount - The amount to approve (default: unlimited)
   * @param token - Which ERC20 to approve from (default: pUSD)
   */
  async approveUsdc(
    spenderAddress: string,
    amount: ethers.BigNumber = ethers.constants.MaxUint256,
    token: 'pUSD' | 'USDC.e' = 'pUSD'
  ): Promise<ApprovalTxResult> {
    const tokenAddress = this.erc20ContractForToken(token);
    const erc20 = new ethers.Contract(tokenAddress, ERC20_ABI, this.signer);
    const gasPrice = await this.provider.getGasPrice();

    try {
      const tx = await erc20.approve(spenderAddress, amount, {
        gasPrice: gasPrice.mul(150).div(100),
      });
      await tx.wait();
      return {
        contract: spenderAddress,
        token,
        txHash: tx.hash,
        success: true,
      };
    } catch (err) {
      return {
        contract: spenderAddress,
        token,
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      };
    }
  }

  /**
   * Set approval for an ERC1155 operator
   *
   * @param operatorAddress - The operator address to approve
   * @param approved - Whether to approve or revoke
   */
  async setErc1155Approval(
    operatorAddress: string,
    approved: boolean = true
  ): Promise<ApprovalTxResult> {
    const conditionalTokens = new ethers.Contract(CONDITIONAL_TOKENS, ERC1155_ABI, this.signer);
    const gasPrice = await this.provider.getGasPrice();

    try {
      const tx = await conditionalTokens.setApprovalForAll(operatorAddress, approved, {
        gasPrice: gasPrice.mul(150).div(100),
        gasLimit: 100000,
      });
      await tx.wait();
      return {
        contract: operatorAddress,
        txHash: tx.hash,
        success: true,
      };
    } catch (err) {
      return {
        contract: operatorAddress,
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      };
    }
  }
}
