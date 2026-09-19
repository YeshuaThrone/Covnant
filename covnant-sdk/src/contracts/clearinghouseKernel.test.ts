import { describe, expect, it } from 'vitest';

import {
  CreatorIdentityError,
  KernelBpsIntegrityError,
  KernelValidationError,
  TOTAL_BASIS_POINTS,
  resolveCreatorCard,
  validateLedgerBps,
  type BasisPointParticipant,
  type UniversalAssetLedgerSpec,
} from './clearinghouseKernel';

function participant(overrides: Partial<BasisPointParticipant> = {}): BasisPointParticipant {
  return {
    uctNumber: 'UCT-US-2026-AB12CD34-EF',
    role: 'songwriter',
    masterBps: 10000,
    writerBps: 10000,
    publisherBps: 10000,
    ...overrides,
  };
}

function spec(participants: BasisPointParticipant[]): UniversalAssetLedgerSpec {
  return { cvtAssetTag: 'CVT-TEST-ASSET', primaryUct: 'UCT-US-2026-AB12CD34-EF', participants };
}

describe('validateLedgerBps', () => {
  it('accepts exact 10,000 per pool', () => {
    expect(() =>
      validateLedgerBps(spec([
        participant({ masterBps: 6000, writerBps: 4000, publisherBps: 5000 }),
        participant({ masterBps: 4000, writerBps: 6000, publisherBps: 5000 }),
      ])),
    ).not.toThrow();
  });

  it('rejects a master pool off by one in both directions', () => {
    try {
      validateLedgerBps(spec([participant({ masterBps: 9999, writerBps: 10000, publisherBps: 10000 })]));
      expect.unreachable('9999 must throw');
    } catch (error) {
      expect(error).toBeInstanceOf(KernelValidationError);
      const typed = error as KernelValidationError;
      expect(typed.pool).toBe('master');
      expect(typed.actualBps).toBe(9999);
    }
    expect(() =>
      validateLedgerBps(spec([participant({ masterBps: 10001, writerBps: 10000, publisherBps: 10000 })])),
    ).toThrow(KernelValidationError);
  });

  it('rejects writer and publisher pools that do not sum exactly', () => {
    expect(() =>
      validateLedgerBps(spec([participant({ masterBps: 10000, writerBps: 9999, publisherBps: 10000 })])),
    ).toThrow(KernelValidationError);
    expect(() =>
      validateLedgerBps(spec([participant({ masterBps: 10000, writerBps: 10000, publisherBps: 9998 })])),
    ).toThrow(KernelValidationError);
  });

  it('rejects a compensating fractional split that sums to 10,000', () => {
    // 4999.5 + 5000.5 === 10000 — still an integrity failure, not a valid pool.
    try {
      validateLedgerBps(spec([
        participant({ masterBps: 4999.5, writerBps: 10000, publisherBps: 10000 }),
        participant({ masterBps: 5000.5, writerBps: 10000, publisherBps: 10000 }),
      ]));
      expect.unreachable('fractional BPS must throw');
    } catch (error) {
      expect(error).toBeInstanceOf(KernelBpsIntegrityError);
    }
  });

  it('rejects empty participants', () => {
    try {
      validateLedgerBps(spec([]));
      expect.unreachable('empty participants must throw');
    } catch (error) {
      expect(error).toBeInstanceOf(KernelValidationError);
      expect((error as KernelValidationError).actualBps).toBe(0);
    }
  });

  it('exports the 10,000 total', () => {
    expect(TOTAL_BASIS_POINTS).toBe(10000);
  });
});

describe('resolveCreatorCard', () => {
  it('resolves the card from the injected UCT read with a canonical ISNI', async () => {
    const card = await resolveCreatorCard(
      () => Promise.resolve({ uctNumber: 'UCT-US-2026-AB12CD34-EF', isni: '0000 0002 1825 009X' }),
      'creator-1',
    );
    expect(card).toEqual({
      uctNumber: 'UCT-US-2026-AB12CD34-EF',
      isni: '0000-0002-1825-009X', // canonicalized (dashed 4×4), never re-minted
      cardStatus: 'ACTIVE_EARNING',
      kycPendingAtPayout: true,
    });
  });

  it('yields null for an absent or malformed ISNI without failing the card', async () => {
    const absent = await resolveCreatorCard(
      () => Promise.resolve({ uctNumber: 'UCT-US-2026-AB12CD34-EF', isni: null }),
      'creator-1',
    );
    expect(absent.isni).toBeNull();

    const malformed = await resolveCreatorCard(
      () => Promise.resolve({ uctNumber: 'UCT-US-2026-AB12CD34-EF', isni: '0000-0002-1825-00977' }),
      'creator-1',
    );
    expect(malformed.isni).toBeNull();
    expect(malformed.uctNumber).toBe('UCT-US-2026-AB12CD34-EF');
  });

  it('throws the typed identity error — never mints — when no root UCT exists', async () => {
    try {
      await resolveCreatorCard(() => Promise.resolve(null), 'creator-404');
      expect.unreachable('missing UCT must throw');
    } catch (error) {
      expect(error).toBeInstanceOf(CreatorIdentityError);
      expect((error as CreatorIdentityError).creatorId).toBe('creator-404');
      expect((error as Error).message).toContain('no root UCT');
    }
  });
});
