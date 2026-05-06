/**
 * Polymarket CLOB V2 Contract Constants (SSOT)
 * ----------------------------------------------------------------------------
 * V2 cutover: 2026-04-28 (UTC). V1 surfaces have been removed — production
 * code MUST consume the V2 addresses below. The only remaining V1 traces
 * live in `utils/calldata-decoder.ts` (CTF_ROUTER / NEG_RISK_ROUTER /
 * MATCH_ORDERS_SELECTOR_V1) and exist solely to decode pre-cutover
 * settlement TXs that may still surface in mempool tail / historical replay.
 *
 * Verified sources:
 *   - V2 SDK source (`@polymarket/clob-client-v2@1.0.3`):
 *     `dist/index.js` `getContractConfig()` table.
 *   - Polygonscan ABI / proxy admin inspection (collateral + onramp pending).
 *
 * Migration plan: see `earning-engine/.claude/skills/guide-polymarket-v2-migration/`
 *   - `plans/02-poly-sdk-migration.md`        — overall workstream
 *   - `audits/01-poly-sdk-audit.md`            — provenance for each address
 */

/**
 * V2 contract addresses on Polygon mainnet (chain 137).
 * All addresses are checksummed exactly as returned by `getContractConfig(137)`
 * in `@polymarket/clob-client-v2`.
 */
export const POLYGON_CONTRACTS_V2 = {
  // -------------------------------------------------------------------------
  // Core exchanges (CHANGED in V2)
  // -------------------------------------------------------------------------

  /** V2 CTF Exchange — replaces V1 `0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E`. */
  ctfExchange: '0xE111180000d2663C0091e4f400237545B87B996B',

  /** V2 NegRisk CTF Exchange — replaces V1 `0xC5d563A36AE78145C45a50134d48A1215220f80a`. */
  negRiskExchange: '0xe2222d279d744050d28e00520010520000310F59',

  // -------------------------------------------------------------------------
  // Conditional Tokens (UNCHANGED from V1)
  // -------------------------------------------------------------------------

  /** NegRisk Adapter — wraps multi-outcome markets. UNCHANGED from V1. */
  negRiskAdapter: '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296',

  /** ConditionalTokens (CTF) ERC-1155 token contract. UNCHANGED from V1. */
  ctfContract: '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045',

  // -------------------------------------------------------------------------
  // Collateral
  // -------------------------------------------------------------------------

  /**
   * pUSD — V2 collateral token. 1:1 backed by USDC.e and supports unwrap
   * back to USDC.e via the pUSD contract itself.
   */
  pUSD: '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB',

  /**
   * USDC.e (bridged USDC) — V1 collateral, retained for fund-flow paths
   * (Relayer transfers, swap rails, withdrawal collect). Orders post-V2
   * MUST settle in pUSD; USDC.e here is purely for off-exchange flows.
   */
  usdcE: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',

  // -------------------------------------------------------------------------
  // Onramp / Offramp (USDC.e ↔ pUSD)
  // -------------------------------------------------------------------------

  /**
   * Collateral Onramp — handles USDC.e → pUSD wrapping (1:1, no fee).
   *
   * Sourced from Polymarket V2 docs (`docs.polymarket.com/resources/contracts`)
   * and verified on-chain: bytecode exposes `wrap(address,address,uint256)`
   * (selector `0x62355638`) and `COLLATERAL_TOKEN()` returns the pUSD proxy.
   *
   * ABI (verified via on-chain selector probe + docs):
   *   `wrap(address asset, address to, uint256 amount)` — pulls `amount` of
   *   `asset` (must be USDC.e) from caller and mints the same amount of pUSD
   *   to `to`. Caller MUST `approve(onramp, amount)` on USDC.e first.
   *
   * Used by `RelayerService.wrapUsdcToPUSD()` (Safe → Onramp.wrap, gasless).
   */
  collateralOnramp: '0x93070a847efEf7F70739046A929D47a521F5B8ee',

  /**
   * Collateral Offramp — handles pUSD → USDC.e unwrapping (1:1, no fee).
   *
   * Distinct from the Onramp on V2 (V1 had no equivalent — USDC.e was the
   * collateral directly). Verified on-chain: bytecode exposes
   * `unwrap(address,address,uint256)` (selector `0x8cc7104f`) and
   * `COLLATERAL_TOKEN()` returns the same pUSD proxy as the Onramp.
   *
   * ABI:
   *   `unwrap(address asset, address to, uint256 amount)` — burns `amount` of
   *   pUSD from caller and releases the same amount of `asset` (must be
   *   USDC.e) to `to`. Caller MUST `approve(offramp, amount)` on pUSD first.
   *
   * Used by `RelayerService.unwrapPUSDtoUsdc()` (Safe → Offramp.unwrap).
   */
  collateralOfframp: '0x2957922Eb93258b93368531d39fAcCA3B4dC5854',
} as const;

/**
 * EIP-712 domain version constants.
 *
 * The Polymarket protocol exposes TWO independent EIP-712 domains:
 *
 *   1. CTF Exchange domain — used to sign on-chain order structs. V2 uses
 *      `domainVersionV2 = "2"` (the V1 `"1"` domain has been retired and is
 *      not surfaced here).
 *
 *   2. ClobAuthDomain — used to sign API auth challenges (HMAC bootstrap
 *      and L1 header generation). UNCHANGED at V2: still `"1"`.
 *
 * The V2 SDK encapsulates these internally (it picks `"2"` automatically
 * when building V2-shaped orders). These constants exist so that any future
 * raw-signing path (e.g. unit tests, fixture generators, calldata decoders)
 * shares the same SSOT.
 */
export const EIP_712 = {
  /** Domain `name` for CTF Exchange (UNCHANGED across V1/V2). */
  domainName: 'Polymarket CTF Exchange',

  /** V2 CTF Exchange domain version — production order signing MUST use this. */
  domainVersionV2: '2',

  /** ClobAuthDomain version — UNCHANGED at V2 (API auth uses `"1"`). */
  clobAuthDomainVersion: '1',
} as const;

/** Polygon mainnet chain id. */
export const POLYGON_CHAIN_ID = 137 as const;

/** Polygon Amoy testnet chain id (kept for parity with `POLYGON_AMOY` in trading-service). */
export const POLYGON_AMOY_CHAIN_ID = 80002 as const;

// Type helpers ---------------------------------------------------------------

export type PolygonContractsV2 = typeof POLYGON_CONTRACTS_V2;
export type Eip712Constants = typeof EIP_712;
