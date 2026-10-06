import { describe, expect, it } from 'vitest';
import { generateCVTAssetCode } from '@/engine/covenant-master-sdk';
import {
  CVT_PATTERN,
  deterministicCvtCode,
  isValidCvt,
  storedCvtHandle,
} from '../cvt';

describe('CVT_PATTERN — the single outward handle shape (CVT-XXXXXX-YYYY)', () => {
  it('matches the engine-minted shape: 6 uppercase hex + 4-digit year', () => {
    expect(CVT_PATTERN.test('CVT-0A1B2C-2026')).toBe(true);
    expect(CVT_PATTERN.test('CVT-FFFFFF-2026')).toBe(true);
    expect(CVT_PATTERN.test('CVT-000000-2025')).toBe(true);
  });

  it('rejects the retired synthesized display shape (type + 4 hex)', () => {
    expect(CVT_PATTERN.test('CVT-TRK-4279')).toBe(false);
    expect(CVT_PATTERN.test('CVT-ISRC-9F3A')).toBe(false);
  });

  it('rejects wrong hex width', () => {
    expect(CVT_PATTERN.test('CVT-0A1B2-2026')).toBe(false); // 5 hex
    expect(CVT_PATTERN.test('CVT-0A1B2C3-2026')).toBe(false); // 7 hex
    expect(CVT_PATTERN.test('CVT-0A1B2C3D-2026')).toBe(false); // 8 hex (legacy stub shape)
  });

  it('scopes the year segment to exactly four digits', () => {
    expect(CVT_PATTERN.test('CVT-0A1B2C-26')).toBe(false); // 2-digit year
    expect(CVT_PATTERN.test('CVT-0A1B2C-226')).toBe(false); // 3-digit year
    expect(CVT_PATTERN.test('CVT-0A1B2C-20260')).toBe(false); // 5-digit year
    expect(CVT_PATTERN.test('CVT-0A1B2C-202')).toBe(false); // truncated
  });

  it('rejects casing drift, separators, and surrounding junk', () => {
    expect(CVT_PATTERN.test('CVT-0a1b2c-2026')).toBe(false);
    expect(CVT_PATTERN.test('cvt-0A1B2C-2026')).toBe(false);
    expect(CVT_PATTERN.test('CVT-0A1B2C-2026 ')).toBe(false);
    expect(CVT_PATTERN.test(' CVT-0A1B2C-2026')).toBe(false);
    expect(CVT_PATTERN.test('CVT_0A1B2C_2026')).toBe(false);
    expect(CVT_PATTERN.test('CVT-0A1B2C-2026x')).toBe(false);
  });

  it('rejects non-string input', () => {
    for (const value of [null, undefined, 42, {}, ['CVT-0A1B2C-2026']]) {
      expect(isValidCvt(value)).toBe(false);
    }
  });

  it('accepts every year the engine may mint — format-scoped, not date-scoped', () => {
    expect(isValidCvt('CVT-0A1B2C-2026')).toBe(true);
    expect(isValidCvt('CVT-0A1B2C-2099')).toBe(true);
  });
});

describe('storedCvtHandle — the fail-closed read resolver', () => {
  it('passes through a well-shaped stored code', () => {
    expect(storedCvtHandle('CVT-0A1B2C-2026')).toBe('CVT-0A1B2C-2026');
  });

  it('resolves null/missing to NO outward handle — never a synthesized one', () => {
    expect(storedCvtHandle(null)).toBe(null);
    expect(storedCvtHandle(undefined)).toBe(null);
    expect(storedCvtHandle('')).toBe(null);
    expect(storedCvtHandle('   ')).toBe(null);
  });

  it('fails closed on a foreign-shaped stored value — no client-side backfill', () => {
    expect(storedCvtHandle('CVT-TRK-4279')).toBe(null);
    expect(storedCvtHandle('CBT-TRK-ABCDEF123456')).toBe(null);
  });
});

describe('deterministicCvtCode — demo fixtures only', () => {
  it('mints the engine shape deterministically from a stable seed', () => {
    const code = deterministicCvtCode('CBT-TRK-A51DF05B4279', 2026);
    expect(code).toMatch(CVT_PATTERN);
    expect(deterministicCvtCode('CBT-TRK-A51DF05B4279', 2026)).toBe(code);
  });

  it('varies by seed and year', () => {
    expect(deterministicCvtCode('CBT-TRK-A51DF05B4279', 2026)).not.toBe(
      deterministicCvtCode('CBT-FLM-7C3A91D2E40B', 2026),
    );
    expect(deterministicCvtCode('CBT-TRK-A51DF05B4279', 2026)).not.toBe(
      deterministicCvtCode('CBT-TRK-A51DF05B4279', 2027),
    );
  });
});

describe('engine ↔ validator drift guard', () => {
  it('every engine-minted CVT matches the single pattern', () => {
    for (let i = 0; i < 50; i += 1) {
      expect(generateCVTAssetCode()).toMatch(CVT_PATTERN);
    }
  });
});
