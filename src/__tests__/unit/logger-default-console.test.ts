/**
 * Unit tests for Fix-F: poly-sdk default _logger is a real console-backed
 * logger (not a silent no-op).
 *
 * Context: task-fix-market-data-ws-subscribe Fix-F (2026-05-08).
 *
 * Pre-fix: `_logger` defaulted to `{ debug, info, warn, error: noop, noop, noop, noop }`.
 * Any production caller that forgot to call `setLogger()` AND forgot to pass
 * `logger:` to a service ctor silently dropped every diagnostic. The
 * RealtimeServiceV2 sub-ack-timeout incident hid CRITICAL logs for ~60 days.
 *
 * Fix: default `_logger` is now `defaultConsoleLogger` — a thin wrapper that
 * routes each level to the matching `console.{debug,info,warn,error}` with a
 * `[poly-sdk]` prefix. Forgotten-logger bugs still emit visible output;
 * structured / file logging requires explicit injection (`setLogger()` or
 * per-service `logger:`) but absence of injection is no longer silent.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getLogger,
  setLogger,
  resetLogger,
  defaultConsoleLogger,
  createModuleLogger,
} from '../../core/logger.js';

describe('poly-sdk core logger — Fix-F: default is console-backed, not no-op', () => {
  let consoleSpies: {
    debug: ReturnType<typeof vi.spyOn>;
    info: ReturnType<typeof vi.spyOn>;
    warn: ReturnType<typeof vi.spyOn>;
    error: ReturnType<typeof vi.spyOn>;
  };

  beforeEach(() => {
    // Make sure we start each test from the default logger (some other test
    // file may have called setLogger() already in this Vitest worker).
    resetLogger();

    consoleSpies = {
      debug: vi.spyOn(console, 'debug').mockImplementation(() => {}),
      info: vi.spyOn(console, 'info').mockImplementation(() => {}),
      warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
      error: vi.spyOn(console, 'error').mockImplementation(() => {}),
    };
  });

  afterEach(() => {
    consoleSpies.debug.mockRestore();
    consoleSpies.info.mockRestore();
    consoleSpies.warn.mockRestore();
    consoleSpies.error.mockRestore();
    resetLogger();
  });

  it('getLogger() returns defaultConsoleLogger when setLogger() has not been called', () => {
    expect(getLogger()).toBe(defaultConsoleLogger);
  });

  it('defaultConsoleLogger.error routes to console.error with [poly-sdk] prefix', () => {
    defaultConsoleLogger.error('CRITICAL: WS sub appears to have NO ACK', { tokenId: 'abc' });

    expect(consoleSpies.error).toHaveBeenCalledTimes(1);
    const [msg, data] = consoleSpies.error.mock.calls[0];
    expect(msg).toBe('[poly-sdk] CRITICAL: WS sub appears to have NO ACK');
    expect(data).toEqual({ tokenId: 'abc' });
  });

  it('defaultConsoleLogger.warn routes to console.warn', () => {
    defaultConsoleLogger.warn('Pong timeout - connection dead');
    expect(consoleSpies.warn).toHaveBeenCalledTimes(1);
    expect(consoleSpies.warn.mock.calls[0][0]).toBe('[poly-sdk] Pong timeout - connection dead');
  });

  it('defaultConsoleLogger.info routes to console.info', () => {
    defaultConsoleLogger.info('TradingService V2 initialized');
    expect(consoleSpies.info).toHaveBeenCalledTimes(1);
  });

  it('createModuleLogger uses the current global logger (defaultConsoleLogger by default)', () => {
    const log = createModuleLogger('test-module');
    log.error('something bad');
    // Without `data`, defaultConsoleLogger calls console.error with ONE arg
    // (no trailing undefined). The module-prefix is built into the message.
    expect(consoleSpies.error).toHaveBeenCalledWith('[poly-sdk] [test-module] something bad');
  });

  it('setLogger() overrides the default, and resetLogger() restores it', () => {
    const fake = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    setLogger(fake);

    const log = createModuleLogger('test-module');
    log.error('routes to fake');
    expect(fake.error).toHaveBeenCalledTimes(1);
    expect(consoleSpies.error).not.toHaveBeenCalled();

    resetLogger();
    expect(getLogger()).toBe(defaultConsoleLogger);
  });

  it('regression guard: default logger is NOT a no-op (the Fix-F invariant)', () => {
    // The pre-Fix-F default produced ZERO console output. Post-fix, every
    // level must produce visible output through console.*.
    defaultConsoleLogger.debug('d');
    defaultConsoleLogger.info('i');
    defaultConsoleLogger.warn('w');
    defaultConsoleLogger.error('e');

    expect(consoleSpies.debug).toHaveBeenCalled();
    expect(consoleSpies.info).toHaveBeenCalled();
    expect(consoleSpies.warn).toHaveBeenCalled();
    expect(consoleSpies.error).toHaveBeenCalled();
  });
});
