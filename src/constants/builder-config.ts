/**
 * V2 Builder Code Helpers (SSOT)
 * ----------------------------------------------------------------------------
 * Polymarket CLOB V2 replaces the legacy HMAC-based builder attribution
 * (`POLY_BUILDER_API_KEY` / `_SECRET` / `_PASSPHRASE`) with an on-chain
 * `bytes32` field embedded inside the signed order struct (`Order.builder`).
 *
 * The V2 `ClobClient`'s `builderConfig: { builderCode: bytes32 }` option
 * propagates this code into every order created/posted via the client. We
 * source the code from `POLY_BUILDER_CODE` and validate the format before
 * letting it reach the SDK so misconfiguration fails loudly at startup
 * instead of silently as a malformed on-chain order.
 *
 * Migration plan: see `earning-engine/.claude/skills/guide-polymarket-v2-migration/`
 *   - `plans/02-poly-sdk-migration.md` §6 — Builder Auth Split
 *   - `plans/12-poly-sdk-pr-templates.md` §PR-B — env sourcing
 *
 * Note: HMAC creds (`POLY_BUILDER_API_KEY` etc.) are still required for the
 * Relayer (gasless TX) path in `RelayerService`. They are NOT consumed by
 * order signing in V2.
 */

/** Strict bytes32 format: `0x` followed by exactly 64 hex characters. */
const BYTES32_REGEX = /^0x[0-9a-fA-F]{64}$/;
export const ZERO_BUILDER_CODE = '0x0000000000000000000000000000000000000000000000000000000000000000';

/**
 * A zero bytes32 builder code is valid order metadata but should be treated as
 * no fee-bearing builder attribution.
 */
export function isActiveBuilderCode(code?: string): boolean {
  return Boolean(code && code !== ZERO_BUILDER_CODE);
}

/**
 * Read and validate the V2 builder code from the environment.
 *
 * @throws if `POLY_BUILDER_CODE` is missing or not a valid bytes32 hex string.
 *   The error message points to the SSOT plan so callers can self-diagnose.
 */
export function readBuilderCode(): string {
  const code = process.env.POLY_BUILDER_CODE;
  if (!code || !BYTES32_REGEX.test(code)) {
    throw new Error(
      'POLY_BUILDER_CODE env var must be set to a valid bytes32 ' +
        '(0x followed by 64 hex chars). ' +
        'See guide-polymarket-v2-migration/plans/12 §PR-B for sourcing.'
    );
  }
  return code;
}

/**
 * Read the V2 builder code if configured, returning `undefined` when absent.
 *
 * Useful for read-only paths (e.g. `MarketService` constructing a non-signing
 * `ClobClient`) where a missing builder code is acceptable.
 *
 * Still throws if the env is set to a malformed value, so misconfiguration
 * never silently degrades to "no builder attribution".
 */
export function readBuilderCodeOptional(): string | undefined {
  const code = process.env.POLY_BUILDER_CODE;
  if (code === undefined || code === '') return undefined;
  if (!BYTES32_REGEX.test(code)) {
    throw new Error(
      'POLY_BUILDER_CODE env var is set but is not a valid bytes32 ' +
        '(0x followed by 64 hex chars). ' +
        'See guide-polymarket-v2-migration/plans/12 §PR-B for sourcing.'
    );
  }
  return code;
}
