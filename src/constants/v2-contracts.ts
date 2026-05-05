/**
 * Polymarket CLOB V2 Contract Constants (SSOT)
 * ----------------------------------------------------------------------------
 * V2 cutover: 2026-04-28 (UTC). All legacy V1 CTF Exchange / NegRisk Exchange
 * addresses below are kept ONLY as `@deprecated` references for migration
 * traceability — production callers MUST consume the V2 addresses.
 *
 * Verified sources:
 *   - V2 SDK source (`@polymarket/clob-client-v2@1.0.3`):
 *     `dist/index.js` `getContractConfig()` table.
 *   - Polygonscan ABI / proxy admin inspection (collateral + onramp pending).
 *
 * Migration plan: see `earning-engine/.claude/skills/guide-polymarket-v2-migration/`
 *   - `plans/02-poly-sdk-migration.md`        — overall workstream
 *   - `plans/12-poly-sdk-pr-templates.md` §PR-A — this PR's scope
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
  // Onramp (TBD — Polygonscan ABI inspection pending)
  // -------------------------------------------------------------------------

  /**
   * Collateral Onramp contract — handles USDC.e → pUSD wrapping for end users.
   * Address pending: see `audits/01-poly-sdk-audit.md` P0-5 / `p0-fix-log` P0-05.
   * To be filled in PR-C alongside `RelayerService.wrapUsdcToPUSD()` impl.
   */
  // collateralOnramp: '0x...',
} as const;

/**
 * Legacy V1 addresses (for reference / grep traceability).
 *
 * @deprecated Do not consume from production paths. V1 CLOB rejects all
 * V1-signed orders since 2026-04-28. These are kept here so that searches
 * for old addresses still surface a single SSOT result.
 */
export const POLYGON_CONTRACTS_V1_LEGACY = {
  /** @deprecated Replaced by `POLYGON_CONTRACTS_V2.ctfExchange`. */
  ctfExchange: '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E',
  /** @deprecated Replaced by `POLYGON_CONTRACTS_V2.negRiskExchange`. */
  negRiskExchange: '0xC5d563A36AE78145C45a50134d48A1215220f80a',
} as const;

/**
 * EIP-712 domain version constants.
 *
 * The Polymarket protocol exposes TWO independent EIP-712 domains:
 *
 *   1. CTF Exchange domain — used to sign on-chain order structs.
 *      Bumped from "1" → "2" at the V2 cutover. Order signing MUST use
 *      `domainVersionV2`.
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

  /** @deprecated V1 CTF Exchange domain version — kept for hash parity tests only. */
  domainVersionV1: '1',

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
