import { describe, expect, it } from 'vitest';
import { buildLineageMetadata, normalizeIsrc, parseExternalReferences } from '../lineage';

/**
 * Ledger lineage parser unit tests: memo/description parsing (ISRC in
 * prefixed/dashed/bare forms, ISWC optional), exact canonicalization, and
 * the lineage metadata object shape. Pure functions; no DB, no IO.
 */

describe('normalizeIsrc', () => {
  it('canonicalizes dashed and lowercase candidates to the 12-char dashless form', () => {
    expect(normalizeIsrc('US-S1M-26-77777')).toBe('USS1M2677777');
    expect(normalizeIsrc('us-s1m-26-77777')).toBe('USS1M2677777');
    expect(normalizeIsrc('USS1M2677777')).toBe('USS1M2677777');
  });

  it('rejects candidates that are not exactly 12 canonical chars after stripping dashes', () => {
    expect(normalizeIsrc('US-S1M-26-7777')).toBeNull(); // 11
    expect(normalizeIsrc('US-S1M-26-777777')).toBeNull(); // 13
    expect(normalizeIsrc('12-S1M-26-77777')).toBeNull(); // must start with 2 letters
    expect(normalizeIsrc('')).toBeNull();
  });
});

describe('parseExternalReferences — ISRC forms', () => {
  it('parses the prefixed dashed form with the raw capture including the prefix', () => {
    const refs = parseExternalReferences({
      unstructured_remittance_information: 'Royalty distro ISRC: US-S1M-26-77777 thanks',
    });
    expect(refs).toEqual([
      { kind: 'ISRC', value: 'USS1M2677777', raw: 'ISRC: US-S1M-26-77777' },
    ]);
  });

  it('parses the ISRC- hyphen-prefixed form', () => {
    const refs = parseExternalReferences({
      company_entry_description: 'ISRC-US-S1M-26-77777 payout',
    });
    expect(refs).toEqual([
      { kind: 'ISRC', value: 'USS1M2677777', raw: 'ISRC-US-S1M-26-77777' },
    ]);
  });

  it('parses the bare dashed form and the bare canonical 12-char form', () => {
    const dashed = parseExternalReferences({
      unstructured_remittance_information: 'Payment for US-S1M-26-77777',
    });
    expect(dashed.map((r) => r.value)).toEqual(['USS1M2677777']);
    const bare = parseExternalReferences({
      unstructured_remittance_information: 'Payment for USS1M2677777',
    });
    expect(bare.map((r) => r.value)).toEqual(['USS1M2677777']);
  });

  it('parses case-insensitively and canonicalizes to uppercase', () => {
    const refs = parseExternalReferences({
      unstructured_remittance_information: 'isrc:us-s1m-26-77777',
    });
    expect(refs.map((r) => r.value)).toEqual(['USS1M2677777']);
  });

  it('dedupes the same ISRC across repeated occurrences (scan order decides the raw: prefixed > dashed > bare)', () => {
    const refs = parseExternalReferences({
      unstructured_remittance_information: 'USS1M2677777 again US-S1M-26-77777',
    });
    expect(refs).toHaveLength(1);
    expect(refs[0].raw).toBe('US-S1M-26-77777'); // dashed scanned before bare
  });

  it('ignores non-memo fields entirely (trace numbers, sender names, ids)', () => {
    // 12-char ISRC-shaped value in a NON-memo field is never parsed.
    const refs = parseExternalReferences({
      trace_number: 'USS1M2677777',
      originator_company_name: 'USS1M2677777 RECORDS',
      id: 'USS1M2677777',
    });
    expect(refs).toEqual([]);
  });

  it('returns an empty array when no identifier-shaped text is present', () => {
    expect(
      parseExternalReferences({ unstructured_remittance_information: 'INVOICE 2468' }),
    ).toEqual([]);
  });
});

describe('parseExternalReferences — ISWC', () => {
  it('parses the canonical ISWC form (T-<10 digits>-<1 check digit>)', () => {
    const refs = parseExternalReferences({
      unstructured_remittance_information: 'Pub royalty T-0123456789-9 settlement',
    });
    expect(refs).toContainEqual({ kind: 'ISWC', value: 'T-0123456789-9', raw: 'T-0123456789-9' });
  });

  it('collects ISRC and ISWC together from one memo', () => {
    const refs = parseExternalReferences({
      unstructured_remittance_information: 'ISRC:US-S1M-26-77777 T-0123456789-9',
    });
    expect(refs.map((r) => `${r.kind}:${r.value}`)).toEqual([
      'ISRC:USS1M2677777',
      'ISWC:T-0123456789-9',
    ]);
  });

  it('rejects malformed ISWC look-alikes (9 or 11 middle digits)', () => {
    expect(
      parseExternalReferences({
        unstructured_remittance_information: 'T-012345678-9 X T-01234567890-9',
      }),
    ).toEqual([]);
  });
});

describe('buildLineageMetadata', () => {
  const refs = [{ kind: 'ISRC' as const, value: 'USS1M2677777', raw: 'ISRC:US-S1M-26-77777' }];

  it('emits resolution exact with assetCode and uct on a match', () => {
    const { lineage } = buildLineageMetadata({
      references: refs,
      match: { assetCode: 'CBT-TRACK-4f9c2ab7d1e0', uct: 'UCT-US-2026-9F3A7C21-K4' },
      parsedAt: '2026-09-07T18:46:09.405Z',
    });
    expect(lineage.resolution).toBe('exact');
    expect(lineage.assetCode).toBe('CBT-TRACK-4f9c2ab7d1e0');
    expect(lineage.uct).toBe('UCT-US-2026-9F3A7C21-K4');
    expect(lineage.references).toEqual(refs);
    expect(lineage.parsedAt).toBe('2026-09-07T18:46:09.405Z');
  });

  it('omits the uct key gracefully for pre-UCT holders', () => {
    const { lineage } = buildLineageMetadata({
      references: refs,
      match: { assetCode: 'CBT-TRACK-4f9c2ab7d1e0', uct: null },
      parsedAt: '2026-09-07T18:46:09.405Z',
    });
    expect(lineage.resolution).toBe('exact');
    expect(lineage.assetCode).toBe('CBT-TRACK-4f9c2ab7d1e0');
    expect('uct' in lineage).toBe(false);
  });

  it('emits resolution unmatched with no assetCode and no uct when nothing matched', () => {
    const { lineage } = buildLineageMetadata({
      references: refs,
      match: null,
      parsedAt: '2026-09-07T18:46:09.405Z',
    });
    expect(lineage.resolution).toBe('unmatched');
    expect('assetCode' in lineage).toBe(false);
    expect('uct' in lineage).toBe(false);
  });
});
