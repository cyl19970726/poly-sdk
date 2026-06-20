/**
 * Internal logger interface for poly-sdk.
 *
 * poly-sdk does NOT import any external logger directly.
 * Consumers (e.g. poly-cli, market-data, crypto-prices, trading-engine) should
 * either call `setLogger()` once at startup OR pass `logger:` into individual
 * service constructors that accept it (preferred — Fix-B/C/D pattern).
 *
 * Default behaviour (2026-05-08, Fix-F):
 *   _logger defaults to `defaultConsoleLogger` (a thin wrapper around
 *   `console.{debug,info,warn,error}`) — NOT a no-op. This is the
 *   "fail-loud" default, mirroring mars-sdk's design.
 *
 * Why this changed: prior to Fix-F the default was a no-op, which meant any
 * production caller that forgot to inject a logger silently dropped every
 * `log.info/warn/error` from poly-sdk. The 60-day blast radius of the
 * RealtimeServiceV2 sub-ack-timeout incident (CRITICAL log invisible for
 * weeks) demonstrated the footgun. Defaulting to console means
 * forgotten-logger bugs still emit visible diagnostics on stdout/stderr —
 * coarse but never silent.
 *
 * Hosts that want structured / file logs should still inject (`setLogger()`
 * or per-service `logger:`); the console default is a safety net, not a
 * replacement.
 */

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

/**
 * Default console-backed logger. Used when no host calls setLogger().
 *
 * Intentionally simple: routes each level to the matching console method,
 * with a `[poly-sdk]` prefix so output is greppable. NO timestamp / structured
 * formatting — hosts that want richer output should inject their own logger.
 */
export const defaultConsoleLogger: Logger = {
  debug: (msg, data) => {
    if (data !== undefined) console.debug(`[poly-sdk] ${msg}`, data);
    else console.debug(`[poly-sdk] ${msg}`);
  },
  info: (msg, data) => {
    if (data !== undefined) console.info(`[poly-sdk] ${msg}`, data);
    else console.info(`[poly-sdk] ${msg}`);
  },
  warn: (msg, data) => {
    if (data !== undefined) console.warn(`[poly-sdk] ${msg}`, data);
    else console.warn(`[poly-sdk] ${msg}`);
  },
  error: (msg, data) => {
    if (data !== undefined) console.error(`[poly-sdk] ${msg}`, data);
    else console.error(`[poly-sdk] ${msg}`);
  },
};

let _logger: Logger = defaultConsoleLogger;

/**
 * Inject an application logger into poly-sdk.
 * Call once at startup before using any SDK services.
 *
 * @example
 * ```typescript
 * import { setLogger } from '@catalyst-team/poly-sdk';
 * import { createLogger } from '@earning-engine/logger';
 * setLogger(createLogger('poly-sdk'));
 * ```
 */
export function setLogger(logger: Logger): void {
  _logger = logger;
}

/** Get the currently registered logger (or the default console logger). */
export function getLogger(): Logger {
  return _logger;
}

/**
 * Reset the module-scope logger back to `defaultConsoleLogger`.
 * Primarily intended for tests that mutate global logger state via `setLogger()`
 * and need a clean slate in `afterEach`.
 */
export function resetLogger(): void {
  _logger = defaultConsoleLogger;
}

/**
 * Create a module-scoped logger that prefixes every message with `[module]`.
 * Used internally by poly-sdk modules.
 */
export function createModuleLogger(module: string): Logger {
  return {
    debug: (msg, data) => _logger.debug(`[${module}] ${msg}`, data),
    info: (msg, data) => _logger.info(`[${module}] ${msg}`, data),
    warn: (msg, data) => _logger.warn(`[${module}] ${msg}`, data),
    error: (msg, data) => _logger.error(`[${module}] ${msg}`, data),
  };
}
