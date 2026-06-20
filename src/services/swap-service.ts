/**
 * Swap Service
 *
 * Provides DEX swap functionality on Polygon using QuickSwap V3.
 * Supports swapping between various tokens including MATIC, WETH, USDC, USDC.e, USDT, DAI.
 */

import { ethers, Contract, BigNumber } from 'ethers';

// QuickSwap V3 Contracts on Polygon
export const QUICKSWAP_ROUTER = '0xf5b509bB0909a69B1c207E495f687a596C168E12';
export const QUICKSWAP_QUOTER = '0xa15F0D7377B2A0C0c10db057f641beD21028FC89';
export const QUICKSWAP_FACTORY = '0x411b0fAcC3489691f28ad58c47006AF5E3Ab3A28';

// Wrapped MATIC for swapping native MATIC
export const WMATIC = '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270';

/**
 * Supported tokens on Polygon
 *
 * ⚠️ IMPORTANT: V2 Polymarket trading collateral
 *
 * | Token       | Address                                    | V2 role         |
 * |-------------|--------------------------------------------|-----------------|
 * | pUSD        | 0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB | Trading collateral |
 * | USDC_E      | 0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174 | Onramp/offramp rail |
 * | USDC/NATIVE | 0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359 | Deposit/bridge input |
 *
 * For Polymarket V2 CTF operations (split/merge/redeem), the account needs
 * pUSD. This swap service can still help acquire USDC.e, which must then be
 * wrapped through the Polymarket Collateral Onramp.
 *
 * For general transfers:
 * - transferUsdc() sends native USDC (most DEXs, CEXs use this)
 * - transferUsdcE() sends bridged USDC.e (useful before wrapping to pUSD)
 */
export const POLYGON_TOKENS = {
  // Native MATIC (use WMATIC address for swaps)
  MATIC: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270',
  WMATIC: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270',
  // USDC variants - SEE ABOVE FOR POLYMARKET V2 FUND-FLOW ROLE
  USDC: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',       // Native USDC - deposit/bridge input, not direct CTF collateral
  NATIVE_USDC: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', // Alias for USDC
  USDC_E: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',      // Bridged USDC.e - onramp/offramp rail
  // Other stables
  USDT: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
  DAI: '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063',
  // ETH
  WETH: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619',
} as const;

// Token decimals
export const TOKEN_DECIMALS: Record<string, number> = {
  MATIC: 18,
  WMATIC: 18,
  USDC: 6,
  NATIVE_USDC: 6,
  USDC_E: 6,
  USDT: 6,
  DAI: 18,
  WETH: 18,
};

export type SupportedToken = keyof typeof POLYGON_TOKENS;

// ABIs
const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
];

const QUICKSWAP_ROUTER_ABI = [
  'function exactInputSingle((address tokenIn, address tokenOut, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 limitSqrtPrice)) external payable returns (uint256 amountOut)',
  'function exactInput((bytes path, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum)) external payable returns (uint256 amountOut)',
];

const QUICKSWAP_QUOTER_ABI = [
  'function quoteExactInputSingle(address tokenIn, address tokenOut, uint256 amountIn, uint160 limitSqrtPrice) external returns (uint256 amountOut, uint16 fee)',
  'function quoteExactInput(bytes path, uint256 amountIn) external returns (uint256 amountOut, uint16[] fees)',
];

const QUICKSWAP_FACTORY_ABI = [
  'function poolByPair(address tokenA, address tokenB) external view returns (address pool)',
];

const WMATIC_ABI = [
  'function deposit() external payable',
  'function withdraw(uint256 amount) external',
];

export interface SwapQuote {
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  estimatedAmountOut: string;
  minAmountOut: string;
  slippage: number;
  priceImpact: string;
}

/** Quote result from Quoter contract */
export interface QuoteResult {
  possible: boolean;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  amountOut: string | null;
  route: string[];
  poolExists: boolean;
  reason?: string;
}

/** Pool info */
export interface PoolInfo {
  tokenA: string;
  tokenB: string;
  poolAddress: string | null;
  exists: boolean;
}

export interface SwapResult {
  success: boolean;
  transactionHash: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  amountOut: string;
  gasUsed: string;
}

export interface TokenBalance {
  token: string;
  symbol: string;
  balance: string;
  decimals: number;
}

export interface TransferResult {
  success: boolean;
  transactionHash: string;
  token: string;
  to: string;
  amount: string;
  gasUsed: string;
}

export class SwapService {
  private signer: ethers.Wallet;
  private provider: ethers.providers.Provider;
  private router: Contract;
  private quoter: Contract;
  private factory: Contract;

  constructor(signer: ethers.Wallet) {
    // Use signer's provider if available, otherwise create a default Polygon provider
    this.provider = signer.provider || new ethers.providers.JsonRpcProvider('https://polygon-rpc.com');
    // Ensure signer is connected to the provider
    this.signer = signer.provider ? signer : signer.connect(this.provider);
    this.router = new Contract(QUICKSWAP_ROUTER, QUICKSWAP_ROUTER_ABI, this.signer);
    this.quoter = new Contract(QUICKSWAP_QUOTER, QUICKSWAP_QUOTER_ABI, this.provider);
    this.factory = new Contract(QUICKSWAP_FACTORY, QUICKSWAP_FACTORY_ABI, this.provider);
  }

  /**
   * Get dynamic gas options for Polygon network
   * Uses RPC fee data with minimum priority fee of 30 gwei
   */
  private async getGasOptions(): Promise<{
    maxPriorityFeePerGas: BigNumber;
    maxFeePerGas: BigNumber;
  }> {
    const feeData = await this.provider.getFeeData();
    const baseFee = feeData.lastBaseFeePerGas || feeData.gasPrice || ethers.utils.parseUnits('100', 'gwei');
    const minPriorityFee = ethers.utils.parseUnits('30', 'gwei');
    const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas && feeData.maxPriorityFeePerGas.gt(minPriorityFee)
      ? feeData.maxPriorityFeePerGas
      : minPriorityFee;
    const maxFeePerGas = baseFee.mul(3).div(2).add(maxPriorityFeePerGas);
    return { maxPriorityFeePerGas, maxFeePerGas };
  }

  /**
   * Get the wallet address
   */
  get address(): string {
    return this.signer.address;
  }

  /**
   * Get token address from symbol
   */
  getTokenAddress(token: string): string {
    const upperToken = token.toUpperCase() as SupportedToken;
    const address = POLYGON_TOKENS[upperToken];
    if (!address) {
      // Check if it's already an address
      if (token.startsWith('0x') && token.length === 42) {
        return token;
      }
      throw new Error(`Unknown token: ${token}. Supported: ${Object.keys(POLYGON_TOKENS).join(', ')}`);
    }
    return address;
  }

  /**
   * Get token decimals
   */
  getTokenDecimals(token: string): number {
    const upperToken = token.toUpperCase();
    return TOKEN_DECIMALS[upperToken] || 18;
  }

  /**
   * Check if a pool exists for a token pair
   */
  async checkPool(tokenA: string, tokenB: string): Promise<PoolInfo> {
    const addressA = this.getTokenAddress(tokenA);
    const addressB = this.getTokenAddress(tokenB);

    try {
      const poolAddress = await this.factory.poolByPair(addressA, addressB);
      const exists = poolAddress !== ethers.constants.AddressZero;

      return {
        tokenA: tokenA.toUpperCase(),
        tokenB: tokenB.toUpperCase(),
        poolAddress: exists ? poolAddress : null,
        exists,
      };
    } catch {
      return {
        tokenA: tokenA.toUpperCase(),
        tokenB: tokenB.toUpperCase(),
        poolAddress: null,
        exists: false,
      };
    }
  }

  /**
   * Get all available pools for supported tokens
   */
  async getAvailablePools(): Promise<PoolInfo[]> {
    const tokens = Object.keys(POLYGON_TOKENS).filter(
      (t) => t !== 'NATIVE_USDC' && t !== 'WMATIC' // Skip aliases
    );
    const pools: PoolInfo[] = [];

    for (let i = 0; i < tokens.length; i++) {
      for (let j = i + 1; j < tokens.length; j++) {
        const pool = await this.checkPool(tokens[i], tokens[j]);
        if (pool.exists) {
          pools.push(pool);
        }
      }
    }

    return pools;
  }

  /**
   * Get a quote for a swap (checks if route is possible)
   */
  async getQuote(
    tokenIn: string,
    tokenOut: string,
    amountIn: string
  ): Promise<QuoteResult> {
    const upperTokenIn = tokenIn.toUpperCase();
    const upperTokenOut = tokenOut.toUpperCase();

    // Handle MATIC → need to use WMATIC for the pool
    const actualTokenIn = upperTokenIn === 'MATIC' ? 'WMATIC' : upperTokenIn;
    const actualTokenOut = upperTokenOut === 'MATIC' ? 'WMATIC' : upperTokenOut;

    const addressIn = this.getTokenAddress(actualTokenIn);
    const addressOut = this.getTokenAddress(actualTokenOut);
    const decimalsIn = this.getTokenDecimals(actualTokenIn);
    const decimalsOut = this.getTokenDecimals(actualTokenOut);
    const amountInWei = ethers.utils.parseUnits(amountIn, decimalsIn);

    // First check if direct pool exists
    const directPool = await this.checkPool(actualTokenIn, actualTokenOut);

    if (directPool.exists) {
      // Try direct quote
      try {
        const result = await this.quoter.callStatic.quoteExactInputSingle(
          addressIn,
          addressOut,
          amountInWei,
          0 // no price limit
        );
        const amountOut = ethers.utils.formatUnits(result.amountOut, decimalsOut);

        return {
          possible: true,
          tokenIn: upperTokenIn,
          tokenOut: upperTokenOut,
          amountIn,
          amountOut,
          route: [upperTokenIn, upperTokenOut],
          poolExists: true,
        };
      } catch {
        // Pool exists but quote failed (maybe low liquidity)
        return {
          possible: false,
          tokenIn: upperTokenIn,
          tokenOut: upperTokenOut,
          amountIn,
          amountOut: null,
          route: [upperTokenIn, upperTokenOut],
          poolExists: true,
          reason: 'Pool exists but insufficient liquidity for this amount',
        };
      }
    }

    // Try multi-hop through USDC or WMATIC
    const intermediates = ['USDC', 'WMATIC', 'WETH'];
    for (const mid of intermediates) {
      if (mid === actualTokenIn || mid === actualTokenOut) continue;

      const pool1 = await this.checkPool(actualTokenIn, mid);
      const pool2 = await this.checkPool(mid, actualTokenOut);

      if (pool1.exists && pool2.exists) {
        // Try multi-hop quote
        try {
          const midAddress = this.getTokenAddress(mid);
          const path = ethers.utils.solidityPack(
            ['address', 'address', 'address'],
            [addressIn, midAddress, addressOut]
          );

          const result = await this.quoter.callStatic.quoteExactInput(path, amountInWei);
          const amountOut = ethers.utils.formatUnits(result.amountOut, decimalsOut);

          return {
            possible: true,
            tokenIn: upperTokenIn,
            tokenOut: upperTokenOut,
            amountIn,
            amountOut,
            route: [upperTokenIn, mid, upperTokenOut],
            poolExists: true,
          };
        } catch {
          // Continue to try other routes
        }
      }
    }

    // No route found
    return {
      possible: false,
      tokenIn: upperTokenIn,
      tokenOut: upperTokenOut,
      amountIn,
      amountOut: null,
      route: [],
      poolExists: false,
      reason: 'No liquidity pool or route available for this pair',
    };
  }

  /**
   * Execute a multi-hop swap
   */
  async swapMultiHop(
    tokenIn: string,
    tokenOut: string,
    amountIn: string,
    route: string[],
    options: { slippage?: number; deadline?: number } = {}
  ): Promise<SwapResult> {
    const { slippage = 0.5, deadline = 300 } = options;

    if (route.length < 2) {
      throw new Error('Route must have at least 2 tokens');
    }

    const upperTokenIn = tokenIn.toUpperCase();
    const upperTokenOut = tokenOut.toUpperCase();

    // Handle MATIC wrapping
    let wrappedAmount = amountIn;
    if (upperTokenIn === 'MATIC') {
      await this.wrapMatic(amountIn);
    }

    // Build path
    const addresses = route.map((t) => {
      const upper = t.toUpperCase();
      return this.getTokenAddress(upper === 'MATIC' ? 'WMATIC' : upper);
    });

    const path = ethers.utils.solidityPack(
      addresses.map(() => 'address'),
      addresses
    );

    const decimalsIn = this.getTokenDecimals(route[0] === 'MATIC' ? 'WMATIC' : route[0]);
    const decimalsOut = this.getTokenDecimals(route[route.length - 1] === 'MATIC' ? 'WMATIC' : route[route.length - 1]);
    const amountInWei = ethers.utils.parseUnits(wrappedAmount, decimalsIn);

    // Get gas options
    const gasOptions = await this.getGasOptions();

    // Check and approve if needed
    const tokenInAddress = addresses[0];
    const tokenContract = new Contract(tokenInAddress, ERC20_ABI, this.signer);
    const currentAllowance = await tokenContract.allowance(this.signer.address, QUICKSWAP_ROUTER);

    if (currentAllowance.lt(amountInWei)) {
      const approveTx = await tokenContract.approve(QUICKSWAP_ROUTER, ethers.constants.MaxUint256, gasOptions);
      await approveTx.wait();
    }

    // Execute multi-hop swap
    const swapParams = {
      path,
      recipient: this.signer.address,
      deadline: Math.floor(Date.now() / 1000) + deadline,
      amountIn: amountInWei,
      amountOutMinimum: 0, // For simplicity; in production use quote with slippage
    };

    const tx = await this.router.exactInput(swapParams, { ...gasOptions, gasLimit: 500000 });
    const receipt = await tx.wait();

    // Get actual output amount
    const tokenOutAddress = addresses[addresses.length - 1];
    const tokenOutContract = new Contract(tokenOutAddress, ERC20_ABI, this.provider);
    const finalBalance = await tokenOutContract.balanceOf(this.signer.address);

    return {
      success: receipt.status === 1,
      transactionHash: receipt.transactionHash,
      tokenIn: upperTokenIn,
      tokenOut: upperTokenOut,
      amountIn,
      amountOut: ethers.utils.formatUnits(finalBalance, decimalsOut),
      gasUsed: receipt.gasUsed.toString(),
    };
  }

  /**
   * Get balances for all supported tokens
   */
  async getBalances(): Promise<TokenBalance[]> {
    const balances: TokenBalance[] = [];

    // Get native MATIC balance
    const maticBalance = await this.provider.getBalance(this.signer.address);
    balances.push({
      token: 'MATIC',
      symbol: 'MATIC',
      balance: ethers.utils.formatEther(maticBalance),
      decimals: 18,
    });

    // Get ERC20 balances
    const tokens = ['USDC', 'USDC_E', 'USDT', 'DAI', 'WETH', 'WMATIC'];
    for (const tokenSymbol of tokens) {
      const address = POLYGON_TOKENS[tokenSymbol as SupportedToken];
      const contract = new Contract(address, ERC20_ABI, this.provider);
      try {
        const balance = await contract.balanceOf(this.signer.address);
        const decimals = TOKEN_DECIMALS[tokenSymbol];
        balances.push({
          token: tokenSymbol,
          symbol: tokenSymbol,
          balance: ethers.utils.formatUnits(balance, decimals),
          decimals,
        });
      } catch {
        // Skip if token query fails
      }
    }

    return balances;
  }

  /**
   * Get balance for a specific token
   */
  async getBalance(token: string): Promise<string> {
    const upperToken = token.toUpperCase();

    if (upperToken === 'MATIC') {
      const balance = await this.provider.getBalance(this.signer.address);
      return ethers.utils.formatEther(balance);
    }

    const address = this.getTokenAddress(token);
    const contract = new Contract(address, ERC20_ABI, this.provider);
    const balance = await contract.balanceOf(this.signer.address);
    const decimals = this.getTokenDecimals(token);
    return ethers.utils.formatUnits(balance, decimals);
  }

  /**
   * Wrap native MATIC to WMATIC
   */
  async wrapMatic(amount: string): Promise<SwapResult> {
    const amountWei = ethers.utils.parseEther(amount);
    const wmatic = new Contract(WMATIC, WMATIC_ABI, this.signer);
    const gasOptions = await this.getGasOptions();

    const tx = await wmatic.deposit({ value: amountWei, ...gasOptions });
    const receipt = await tx.wait();

    return {
      success: true,
      transactionHash: receipt.transactionHash,
      tokenIn: 'MATIC',
      tokenOut: 'WMATIC',
      amountIn: amount,
      amountOut: amount,
      gasUsed: receipt.gasUsed.toString(),
    };
  }

  /**
   * Unwrap WMATIC to native MATIC
   */
  async unwrapMatic(amount: string): Promise<SwapResult> {
    const amountWei = ethers.utils.parseEther(amount);
    const wmatic = new Contract(WMATIC, WMATIC_ABI, this.signer);
    const gasOptions = await this.getGasOptions();

    const tx = await wmatic.withdraw(amountWei, gasOptions);
    const receipt = await tx.wait();

    return {
      success: true,
      transactionHash: receipt.transactionHash,
      tokenIn: 'WMATIC',
      tokenOut: 'MATIC',
      amountIn: amount,
      amountOut: amount,
      gasUsed: receipt.gasUsed.toString(),
    };
  }

  /**
   * Execute a token swap using QuickSwap V3
   */
  async swap(
    tokenIn: string,
    tokenOut: string,
    amountIn: string,
    options: {
      slippage?: number; // Default 0.5%
      deadline?: number; // Default 5 minutes
    } = {}
  ): Promise<SwapResult> {
    const { slippage = 0.5, deadline = 300 } = options;

    const upperTokenIn = tokenIn.toUpperCase();
    const upperTokenOut = tokenOut.toUpperCase();

    // Handle native MATIC swaps
    if (upperTokenIn === 'MATIC' && upperTokenOut === 'WMATIC') {
      return this.wrapMatic(amountIn);
    }
    if (upperTokenIn === 'WMATIC' && upperTokenOut === 'MATIC') {
      return this.unwrapMatic(amountIn);
    }

    // For MATIC input, first wrap to WMATIC
    let actualTokenIn = upperTokenIn;
    let wrappedAmount = amountIn;
    if (upperTokenIn === 'MATIC') {
      await this.wrapMatic(amountIn);
      actualTokenIn = 'WMATIC';
    }

    const tokenInAddress = this.getTokenAddress(actualTokenIn);
    const tokenOutAddress = this.getTokenAddress(tokenOut);
    const decimalsIn = this.getTokenDecimals(actualTokenIn);
    const decimalsOut = this.getTokenDecimals(tokenOut);

    const amountInWei = ethers.utils.parseUnits(wrappedAmount, decimalsIn);

    // Get gas options for all transactions
    const gasOptions = await this.getGasOptions();

    // Check and approve if needed
    const tokenContract = new Contract(tokenInAddress, ERC20_ABI, this.signer);
    const currentAllowance = await tokenContract.allowance(this.signer.address, QUICKSWAP_ROUTER);

    if (currentAllowance.lt(amountInWei)) {
      const approveTx = await tokenContract.approve(QUICKSWAP_ROUTER, ethers.constants.MaxUint256, gasOptions);
      await approveTx.wait();
    }

    // Calculate min output with slippage
    // Only stablecoin pairs can use ~1:1 ratio estimation
    const stablecoins = ['USDC', 'NATIVE_USDC', 'USDC_E', 'USDT', 'DAI'];
    const isStablecoinPair = stablecoins.includes(actualTokenIn) && stablecoins.includes(upperTokenOut);

    let minAmountOut: BigNumber;
    if (isStablecoinPair) {
      // For stablecoin pairs, assume ~1:1 ratio with slippage
      let estimatedOut = amountInWei;
      if (decimalsIn !== decimalsOut) {
        if (decimalsIn > decimalsOut) {
          estimatedOut = amountInWei.div(BigNumber.from(10).pow(decimalsIn - decimalsOut));
        } else {
          estimatedOut = amountInWei.mul(BigNumber.from(10).pow(decimalsOut - decimalsIn));
        }
      }
      const slippageBps = Math.floor(slippage * 100);
      minAmountOut = estimatedOut.mul(10000 - slippageBps).div(10000);
    } else {
      // For non-stablecoin pairs (like MATIC → USDC), set minAmountOut to 0
      // The actual protection comes from the DEX's price oracle
      // In production, you should use a quoter contract for accurate price
      minAmountOut = BigNumber.from(0);
    }

    // Execute swap
    const swapParams = {
      tokenIn: tokenInAddress,
      tokenOut: tokenOutAddress,
      recipient: this.signer.address,
      deadline: Math.floor(Date.now() / 1000) + deadline,
      amountIn: amountInWei,
      amountOutMinimum: minAmountOut,
      limitSqrtPrice: 0,
    };

    const tx = await this.router.exactInputSingle(swapParams, { ...gasOptions, gasLimit: 300000 });
    const receipt = await tx.wait();

    // Get actual output amount
    const tokenOutContract = new Contract(tokenOutAddress, ERC20_ABI, this.provider);
    const finalBalance = await tokenOutContract.balanceOf(this.signer.address);

    return {
      success: true,
      transactionHash: receipt.transactionHash,
      tokenIn: upperTokenIn,
      tokenOut: upperTokenOut,
      amountIn,
      amountOut: ethers.utils.formatUnits(finalBalance, decimalsOut),
      gasUsed: receipt.gasUsed.toString(),
    };
  }

  /**
   * Swap any supported token to USDC (for deposit)
   */
  async swapToUsdc(
    tokenIn: string,
    amountIn: string,
    options: {
      usdcType?: 'NATIVE_USDC' | 'USDC_E';
      slippage?: number;
    } = {}
  ): Promise<SwapResult> {
    const { usdcType = 'NATIVE_USDC', slippage = 0.5 } = options;

    const upperTokenIn = tokenIn.toUpperCase();

    // If already USDC, no swap needed
    if (upperTokenIn === 'USDC' || upperTokenIn === 'NATIVE_USDC') {
      if (usdcType === 'NATIVE_USDC') {
        return {
          success: true,
          transactionHash: '',
          tokenIn: upperTokenIn,
          tokenOut: 'NATIVE_USDC',
          amountIn,
          amountOut: amountIn,
          gasUsed: '0',
        };
      }
      // Swap USDC to USDC.e
      return this.swap('USDC', 'USDC_E', amountIn, { slippage });
    }

    if (upperTokenIn === 'USDC_E') {
      if (usdcType === 'USDC_E') {
        return {
          success: true,
          transactionHash: '',
          tokenIn: upperTokenIn,
          tokenOut: 'USDC_E',
          amountIn,
          amountOut: amountIn,
          gasUsed: '0',
        };
      }
      // Swap USDC.e to USDC
      return this.swap('USDC_E', 'USDC', amountIn, { slippage });
    }

    // Swap other tokens to USDC
    const targetUsdc = usdcType === 'NATIVE_USDC' ? 'USDC' : 'USDC_E';
    return this.swap(tokenIn, targetUsdc, amountIn, { slippage });
  }

  /**
   * Get list of supported tokens
   */
  getSupportedTokens(): string[] {
    return Object.keys(POLYGON_TOKENS);
  }

  /**
   * Get balances for any wallet address (static method, no signer required)
   */
  static async getWalletBalances(
    address: string,
    provider?: ethers.providers.Provider
  ): Promise<TokenBalance[]> {
    const rpcProvider = provider || new ethers.providers.JsonRpcProvider('https://polygon-rpc.com');
    const balances: TokenBalance[] = [];

    // Get native MATIC balance
    const maticBalance = await rpcProvider.getBalance(address);
    balances.push({
      token: 'MATIC',
      symbol: 'MATIC',
      balance: ethers.utils.formatEther(maticBalance),
      decimals: 18,
    });

    // Get ERC20 balances
    const tokens = ['USDC', 'USDC_E', 'USDT', 'DAI', 'WETH', 'WMATIC'];
    for (const tokenSymbol of tokens) {
      const tokenAddress = POLYGON_TOKENS[tokenSymbol as SupportedToken];
      const contract = new Contract(tokenAddress, ERC20_ABI, rpcProvider);
      try {
        const balance = await contract.balanceOf(address);
        const decimals = TOKEN_DECIMALS[tokenSymbol];
        balances.push({
          token: tokenSymbol,
          symbol: tokenSymbol,
          balance: ethers.utils.formatUnits(balance, decimals),
          decimals,
        });
      } catch {
        // Skip if token query fails
      }
    }

    return balances;
  }

  /**
   * Get balance for a specific token for any wallet (static)
   */
  static async getWalletBalance(
    address: string,
    token: string,
    provider?: ethers.providers.Provider
  ): Promise<string> {
    const rpcProvider = provider || new ethers.providers.JsonRpcProvider('https://polygon-rpc.com');
    const upperToken = token.toUpperCase();

    if (upperToken === 'MATIC') {
      const balance = await rpcProvider.getBalance(address);
      return ethers.utils.formatEther(balance);
    }

    const tokenAddress = POLYGON_TOKENS[upperToken as SupportedToken];
    if (!tokenAddress) {
      throw new Error(`Unknown token: ${token}`);
    }

    const contract = new Contract(tokenAddress, ERC20_ABI, rpcProvider);
    const balance = await contract.balanceOf(address);
    const decimals = TOKEN_DECIMALS[upperToken] || 18;
    return ethers.utils.formatUnits(balance, decimals);
  }

  // ============= Transfer Methods =============

  /**
   * Transfer native MATIC (POL) to another address
   */
  async transferMatic(to: string, amount: string): Promise<TransferResult> {
    const amountWei = ethers.utils.parseEther(amount);

    // Check balance
    const balance = await this.provider.getBalance(this.signer.address);
    if (balance.lt(amountWei)) {
      throw new Error(`Insufficient MATIC balance: have ${ethers.utils.formatEther(balance)}, need ${amount}`);
    }

    const gasOptions = await this.getGasOptions();

    const tx = await this.signer.sendTransaction({
      to,
      value: amountWei,
      ...gasOptions,
      gasLimit: 21000, // Standard ETH transfer gas limit
    });
    const receipt = await tx.wait();

    return {
      success: true,
      transactionHash: receipt.transactionHash,
      token: 'MATIC',
      to,
      amount,
      gasUsed: receipt.gasUsed.toString(),
    };
  }

  /**
   * Transfer an ERC20 token to another address
   */
  async transfer(token: string, to: string, amount: string): Promise<TransferResult> {
    const upperToken = token.toUpperCase();

    // For native MATIC, use transferMatic
    if (upperToken === 'MATIC') {
      return this.transferMatic(to, amount);
    }

    const tokenAddress = this.getTokenAddress(token);
    const decimals = this.getTokenDecimals(token);
    const amountWei = ethers.utils.parseUnits(amount, decimals);

    const contract = new Contract(tokenAddress, ERC20_ABI, this.signer);

    // Check balance
    const balance = await contract.balanceOf(this.signer.address);
    if (balance.lt(amountWei)) {
      throw new Error(`Insufficient ${upperToken} balance: have ${ethers.utils.formatUnits(balance, decimals)}, need ${amount}`);
    }

    const gasOptions = await this.getGasOptions();

    const tx = await contract.transfer(to, amountWei, {
      ...gasOptions,
      gasLimit: 100000, // ERC20 transfer gas limit (USDC.e needs ~71k)
    });
    const receipt = await tx.wait();

    return {
      success: true,
      transactionHash: receipt.transactionHash,
      token: upperToken,
      to,
      amount,
      gasUsed: receipt.gasUsed.toString(),
    };
  }

  /**
   * Transfer native USDC to another address
   *
   * ⚠️ WARNING: This transfers NATIVE USDC (0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359)
   *
   * For Polymarket V2 trading, the account ultimately needs pUSD.
   * Native USDC can be a deposit/bridge input, not direct CTF collateral.
   *
   * @see transferUsdcE - For USDC.e onramp/offramp flows before pUSD wrapping
   */
  async transferUsdc(to: string, amount: string): Promise<TransferResult> {
    return this.transfer('USDC', to, amount);
  }

  /**
   * Transfer USDC.e (bridged USDC) to another address.
   *
   * USDC.e is useful as an onramp/offramp rail. For CLOB V2 CTF operations,
   * wrap it to pUSD before trading.
   *
   * @example
   * ```typescript
   * // Fund a session wallet's USDC.e rail, then wrap to pUSD before trading
   * await swapService.transferUsdcE(sessionWallet, '100');
   * ```
   */
  async transferUsdcE(to: string, amount: string): Promise<TransferResult> {
    return this.transfer('USDC_E', to, amount);
  }
}
