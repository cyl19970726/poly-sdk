/**
 * Unit tests for V2 builder-code env helper.
 *
 * Stage B (PR-B) of the Polymarket V2 migration replaces the legacy HMAC
 * three-tuple (POLY_BUILDER_API_KEY/SECRET/PASSPHRASE) for *order signing*
 * with a single bytes32 `builderCode`. The helper sourced from
 * `src/constants/builder-config.ts` validates the env var format eagerly so
 * misconfiguration fails at startup rather than silently producing malformed
 * on-chain orders.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  readBuilderCode,
  readBuilderCodeOptional,
} from '../../constants/builder-config.js';

const ENV_KEY = 'POLY_BUILDER_CODE';

describe('V2 builder-config helpers', () => {
  let prev: string | undefined;

  beforeEach(() => {
    prev = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
  });

  afterEach(() => {
    if (prev === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = prev;
    }
  });

  describe('readBuilderCode (strict)', () => {
    it('returns the code when it matches the bytes32 pattern', () => {
      const code = '0x' + 'a'.repeat(64);
      process.env[ENV_KEY] = code;
      expect(readBuilderCode()).toBe(code);
    });

    it('accepts mixed-case hex (checksummed-style is fine for bytes32)', () => {
      const code = '0xAbCdEf' + '0'.repeat(58);
      process.env[ENV_KEY] = code;
      expect(readBuilderCode()).toBe(code);
    });

    it('throws when the env var is unset', () => {
      expect(() => readBuilderCode()).toThrow(/POLY_BUILDER_CODE/);
    });

    it('throws when the env var is empty', () => {
      process.env[ENV_KEY] = '';
      expect(() => readBuilderCode()).toThrow(/POLY_BUILDER_CODE/);
    });

    it('throws when the prefix is missing', () => {
      process.env[ENV_KEY] = 'a'.repeat(64);
      expect(() => readBuilderCode()).toThrow(/bytes32/);
    });

    it('throws when the body is too short', () => {
      process.env[ENV_KEY] = '0x' + 'a'.repeat(63);
      expect(() => readBuilderCode()).toThrow(/bytes32/);
    });

    it('throws when the body is too long', () => {
      process.env[ENV_KEY] = '0x' + 'a'.repeat(65);
      expect(() => readBuilderCode()).toThrow(/bytes32/);
    });

    it('throws when the body contains non-hex characters', () => {
      process.env[ENV_KEY] = '0x' + 'g'.repeat(64);
      expect(() => readBuilderCode()).toThrow(/bytes32/);
    });

    it('error message links to the migration plan SSOT', () => {
      // The message MUST include enough context for a reader to find the
      // canonical sourcing instructions without grep-spelunking.
      try {
        readBuilderCode();
        throw new Error('expected throw');
      } catch (err) {
        expect((err as Error).message).toMatch(/plans\/12/);
      }
    });
  });

  describe('readBuilderCodeOptional', () => {
    it('returns undefined when the env var is unset', () => {
      expect(readBuilderCodeOptional()).toBeUndefined();
    });

    it('returns undefined when the env var is empty', () => {
      process.env[ENV_KEY] = '';
      expect(readBuilderCodeOptional()).toBeUndefined();
    });

    it('returns the code when valid', () => {
      const code = '0x' + 'b'.repeat(64);
      process.env[ENV_KEY] = code;
      expect(readBuilderCodeOptional()).toBe(code);
    });

    it('throws when set but malformed (does NOT silently degrade)', () => {
      // A typo in the env should fail loudly even on a read-only path; we
      // never want a strategy to silently start trading without builder
      // attribution.
      process.env[ENV_KEY] = '0xnope';
      expect(() => readBuilderCodeOptional()).toThrow(/bytes32/);
    });
  });
});
