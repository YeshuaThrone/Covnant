import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CBT_SETTLEMENT_CODE_PATTERN,
  cbtSettlementMetadata,
  cbtSettlementMetadataSql,
  generateCBTSettlementCode,
  withCbtSettlementCode,
} from '../cbt-settlement';

/**
 * Deterministic CBT settlement tracker codes (Generation 8 option 1).
 * The code is derived from the row's own reference_id — same id ⇒ same
 * code, forever — so replay idempotency needs no new constraint and the
 * ledger's UNIQUE reference_id index stays the only dedupe mechanism.
 */

describe('generateCBTSettlementCode (V2 — determinism)', () => {
  it('derives the code from the first 12 hex chars of SHA-256(referenceId), uppercased', () => {
    const referenceId = 'inbound_ach_transfer_tdrwqr3fq9gnnq49odev';
    const code = generateCBTSettlementCode(referenceId);
    const digest = createHash('sha256').update(referenceId, 'utf8').digest('hex');
    expect(code).toBe(`CBT-SETTLE-${digest.slice(0, 12).toUpperCase()}`);
  });

  it('always matches the pinned CBT-SETTLE-<12 uppercase hex> shape', () => {
    for (const referenceId of ['a', 'ref-with-dashes:1', 'ups_kw_test', '', '🔑-emoji-ref']) {
      expect(generateCBTSettlementCode(referenceId)).toMatch(CBT_SETTLEMENT_CODE_PATTERN);
    }
  });

  it('returns the same code for the same reference_id, every call', () => {
    const referenceId = 'inbound_ach_transfer_return:transaction_return_9f2c';
    expect(generateCBTSettlementCode(referenceId)).toBe(generateCBTSettlementCode(referenceId));
    expect(generateCBTSettlementCode(referenceId)).toBe(generateCBTSettlementCode(referenceId));
  });

  it('returns different codes for different reference ids', () => {
    expect(generateCBTSettlementCode('ref-a')).not.toBe(generateCBTSettlementCode('ref-b'));
    expect(generateCBTSettlementCode('inbound_ach_transfer_1')).not.toBe(
      generateCBTSettlementCode('inbound_ach_transfer_2'),
    );
  });
});

describe('cbtSettlementMetadata', () => {
  it('carries the exact Generation 8 tag shape', () => {
    expect(cbtSettlementMetadata('ref-1')).toEqual({
      cbt: { settlementCode: generateCBTSettlementCode('ref-1'), derivedFrom: 'reference_id' },
    });
  });
});

describe('cbtSettlementMetadataSql (frozen banking parameter lists)', () => {
  it('emits a jsonb_build_object expression carrying the same deterministic code', () => {
    const referenceId = 'lithic_txn_1';
    const sql = cbtSettlementMetadataSql(referenceId);
    expect(sql).toContain('jsonb_build_object');
    expect(sql).toContain(generateCBTSettlementCode(referenceId));
    expect(sql).toContain("'derivedFrom', 'reference_id'");
  });

  it('interpolates nothing but the charset-locked code — user input cannot break out', () => {
    const hostile = "'); DROP TABLE universal_royalty_ledger; --";
    const sql = cbtSettlementMetadataSql(hostile);
    expect(sql).toBe(
      `jsonb_build_object('cbt', jsonb_build_object('settlementCode', '${generateCBTSettlementCode(hostile)}', 'derivedFrom', 'reference_id'))`,
    );
    expect(sql).toMatch(
      /^jsonb_build_object\('cbt', jsonb_build_object\('settlementCode', 'CBT-SETTLE-[0-9A-F]{12}', 'derivedFrom', 'reference_id'\)\)$/,
    );
  });
});

describe('withCbtSettlementCode (V5 — merge-only metadata)', () => {
  it('adds the cbt tag while preserving every other top-level metadata key', () => {
    const metadata: Record<string, unknown> = {
      increaseEventCategory: 'inbound_ach_transfer.created',
      inboundRail: 'ROYALTY_INBOUND_ACH',
      senderName: 'ASCAP',
    };
    const stamped = withCbtSettlementCode(metadata, 'ref-1');
    expect(stamped.cbt).toEqual(cbtSettlementMetadata('ref-1').cbt);
    expect(stamped.increaseEventCategory).toBe('inbound_ach_transfer.created');
    expect(stamped.inboundRail).toBe('ROYALTY_INBOUND_ACH');
    expect(stamped.senderName).toBe('ASCAP');
  });

  it('preserves the Generation 7 lineage object deeply', () => {
    const lineage = {
      reference: { resolvedBy: 'exact_asset_match', assetCbtCode: 'CBT-TRK-1234567890AB' },
      creators: [{ uct: 'UCT-US-2026-9F3A7C21-K4', name: 'Test Creator' }],
    };
    const stamped = withCbtSettlementCode({ lineage }, 'ref-2');
    expect(stamped.lineage).toEqual(lineage);
    expect(stamped.cbt).toEqual(cbtSettlementMetadata('ref-2').cbt);
  });

  it('preserves nested provenance-style payloads without cloning drift', () => {
    const provenance = { source: 'increase', rail: 'inbound_ach_transfer' };
    const stamped = withCbtSettlementCode({ provenance }, 'ref-3');
    expect(stamped.provenance).toEqual(provenance);
  });

  it('does not mutate the input metadata object', () => {
    const metadata: Record<string, unknown> = { provenance: { source: 'increase' } };
    const stamped = withCbtSettlementCode(metadata, 'ref-4');
    expect('cbt' in metadata).toBe(false);
    expect(metadata).toEqual({ provenance: { source: 'increase' } });
    expect(stamped.cbt).toBeDefined();
  });

  it('stamps empty, null, or undefined metadata with the cbt tag alone (debit paths that wrote none)', () => {
    expect(withCbtSettlementCode({}, 'ref-5')).toEqual(cbtSettlementMetadata('ref-5'));
    expect(withCbtSettlementCode(null as unknown as Record<string, unknown>, 'ref-6')).toEqual(
      cbtSettlementMetadata('ref-6'),
    );
    expect(withCbtSettlementCode(undefined as unknown as Record<string, unknown>, 'ref-7')).toEqual(
      cbtSettlementMetadata('ref-7'),
    );
  });

  it('never throws on circular metadata values (plain spread — no serialization)', () => {
    const circular: Record<string, unknown> = { provenance: { source: 'increase' } };
    circular['self'] = circular;
    expect(() => withCbtSettlementCode(circular, 'ref-8')).not.toThrow();
  });
});

describe('withCbtSettlementCode (T3 — replay re-derivation is a no-op)', () => {
  it('re-stamping the same reference_id yields an identical payload', () => {
    const referenceId = 'inbound_ach_transfer_tdrwqr3fq9gnnq49odev';
    const first = withCbtSettlementCode({ provenance: { source: 'increase' } }, referenceId);
    const second = withCbtSettlementCode(first, referenceId);
    expect(second).toEqual(first);
  });

  it('re-deriving with a different reference id replaces only the cbt tag', () => {
    const first = withCbtSettlementCode({ provenance: { source: 'increase' } }, 'ref-a');
    const second = withCbtSettlementCode(first, 'ref-b');
    expect(second.provenance).toEqual((first as { provenance: unknown }).provenance);
    expect(
      (second as { cbt: { settlementCode: string } }).cbt.settlementCode,
    ).toBe(generateCBTSettlementCode('ref-b'));
  });
});
