import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SettlementResult } from '@/engine/covenant-master-sdk';
import { rememberSettlement } from '../store';
import {
  CBT_SETTLEMENT_CODE_PATTERN,
  cbtSettlementMetadata,
  generateCBTSettlementCode,
  isMissingMetadataColumnError,
  stampSupabaseLedgerRow,
} from '../cbt-settlement';

/**
 * Generation 9 — supabase-js stamping evidence for the ledger store
 * (rememberSettlement upsert) and the shared payload helpers. The store's
 * upsert is the repo-side mirror of the engine's settled results; its stamp
 * is additive (merge-only by construction), deterministic from the row's
 * transaction_id, and money-never-blocks: a live table without the additive
 * metadata column (42703 / PGRST204) retries the upsert WITHOUT the stamp so
 * the settled result still persists. The mock mirrors the frozen harness in
 * settlement-tax.test.ts (unmodified) with coded-error behavior.
 */

const sb = vi.hoisted(() => ({
  upsertCalls: [] as { table: string; rows: Record<string, unknown>[]; opts: unknown }[],
  upsertError: null as { code?: string; message: string } | null,
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (table: string) => ({
      upsert: async (rows: Record<string, unknown>[], opts: unknown) => {
        sb.upsertCalls.push({ table, rows, opts });
        // A live table without the metadata column rejects ONLY the stamped
        // attempt — the bare fallback row must succeed (money never blocks).
        const stamped = rows.some((row) => 'metadata' in row);
        return { error: sb.upsertError && stamped ? { ...sb.upsertError } : null };
      },
    }),
  }),
}));

const URL_ENV = 'NEXT_PUBLIC_SUPABASE_URL';
const KEY_ENV = 'SUPABASE_SERVICE_ROLE_KEY';

function enableDbMode(): void {
  process.env[URL_ENV] = 'https://gen9-test.supabase.co';
  process.env[KEY_ENV] = 'service-role-key';
}

function disableDbMode(): void {
  delete process.env[URL_ENV];
  delete process.env[KEY_ENV];
}

const RESULT: SettlementResult = {
  transactionId: 'DIR-GEN9-1',
  cbtCode: 'CBT-TRK-TEST000010',
  totalSettled: 100,
  currency: 'USD',
  platformFeeDeducted: 0,
  cornerDustCollected: 0,
  disbursements: [],
  reconciliationStatus: 'PASS',
};

beforeEach(() => {
  sb.upsertCalls.length = 0;
  sb.upsertError = null;
  delete (globalThis as { __covnantLedgerIndex?: unknown }).__covnantLedgerIndex;
});

afterEach(disableDbMode);

describe('G2 · the store upsert stamps metadata.cbt in the frozen shape', () => {
  it('writes metadata.cbt = { settlementCode, derivedFrom: "reference_id" } with the sha256 derivation', async () => {
    enableDbMode();
    await rememberSettlement(RESULT, 'DIRECT');

    expect(sb.upsertCalls).toHaveLength(1);
    const row = sb.upsertCalls[0].rows[0];
    const metadata = row.metadata as { cbt?: { settlementCode?: string; derivedFrom?: string } };
    expect(metadata.cbt?.settlementCode).toMatch(CBT_SETTLEMENT_CODE_PATTERN);
    expect(metadata.cbt?.settlementCode).toBe(generateCBTSettlementCode('DIR-GEN9-1'));
    expect(metadata.cbt?.derivedFrom).toBe('reference_id');
  });

  it('is merge-only: every legacy flat-schema row key survives beside the stamp', async () => {
    enableDbMode();
    await rememberSettlement(RESULT, 'DIRECT');

    const row = sb.upsertCalls[0].rows[0];
    // The engine's exact column mapping (toDbRow) is unchanged.
    expect(row.transaction_id).toBe('DIR-GEN9-1');
    expect(row.cbt_code).toBe('CBT-TRK-TEST000010');
    expect(row.platform).toBe('DIRECT');
    expect(row.gross_settled).toBe(RESULT.totalSettled);
    expect(row.covenant_fee).toBe(RESULT.platformFeeDeducted);
    expect(row.corner_dust_collected).toBe(RESULT.cornerDustCollected);
    expect(row.currency).toBe('USD');
    expect(row.disbursements).toEqual([]);
    expect(typeof row.created_at).toBe('string');
    // The only addition is the metadata key.
    expect(Object.keys(row).sort()).toEqual(
      [
        'cbt_code',
        'corner_dust_collected',
        'covenant_fee',
        'created_at',
        'currency',
        'disbursements',
        'gross_settled',
        'metadata',
        'platform',
        'transaction_id',
      ].sort(),
    );
  });

  it('re-derives the identical code for the same transaction_id (replay-safe)', async () => {
    enableDbMode();
    await rememberSettlement(RESULT, 'DIRECT');
    await rememberSettlement(RESULT, 'DIRECT');

    expect(sb.upsertCalls).toHaveLength(2);
    const first = (sb.upsertCalls[0].rows[0].metadata as { cbt: { settlementCode: string } }).cbt.settlementCode;
    const second = (sb.upsertCalls[1].rows[0].metadata as { cbt: { settlementCode: string } }).cbt.settlementCode;
    expect(first).toBe(second);
    expect(first).toBe(generateCBTSettlementCode('DIR-GEN9-1'));
  });
});

describe('G4 · money never blocks on the store path', () => {
  it('retries the upsert WITHOUT the stamp on PostgreSQL 42703 and still records the settlement', async () => {
    enableDbMode();
    sb.upsertError = { code: '42703', message: 'column "metadata" of relation "universal_royalty_ledger" does not exist' };

    await expect(rememberSettlement(RESULT, 'DIRECT')).resolves.toMatchObject({ transactionId: 'DIR-GEN9-1' });

    expect(sb.upsertCalls).toHaveLength(2);
    expect(sb.upsertCalls[0].rows[0].metadata).toBeDefined();
    expect(sb.upsertCalls[1].rows[0]).not.toHaveProperty('metadata');
    expect(sb.upsertCalls[1].opts).toEqual({ onConflict: 'transaction_id' });
  });

  it('retries the upsert WITHOUT the stamp on PostgREST PGRST204 (same rule, client surface)', async () => {
    enableDbMode();
    sb.upsertError = {
      code: 'PGRST204',
      message: "Could not find the 'metadata' column of 'universal_royalty_ledger' in the schema cache",
    };

    await expect(rememberSettlement(RESULT, 'DIRECT')).resolves.toMatchObject({ transactionId: 'DIR-GEN9-1' });
    expect(sb.upsertCalls).toHaveLength(2);
    expect(sb.upsertCalls[1].rows[0]).not.toHaveProperty('metadata');
  });

  it('still throws the ledger error for a generic upsert failure (unchanged failure semantics)', async () => {
    enableDbMode();
    sb.upsertError = { message: 'boom' };

    await expect(rememberSettlement(RESULT, 'DIRECT')).rejects.toThrow(/Ledger upsert failed: boom/);
    expect(sb.upsertCalls).toHaveLength(1);
  });
});

describe('stampSupabaseLedgerRow — the additive payload stamp', () => {
  it('adds metadata.cbt without reshaping the row payload', () => {
    const row = { transaction_id: 'TX-1', gross_settled: 5 };
    const stamped = stampSupabaseLedgerRow(row, 'TX-1');
    expect(stamped).toEqual({
      transaction_id: 'TX-1',
      gross_settled: 5,
      metadata: cbtSettlementMetadata('TX-1'),
    });
  });

  it('preserves metadata keys the payload already carries (merge-only)', () => {
    const row = {
      transaction_id: 'TX-1',
      metadata: { provenance: 'pr-26', lineage: { references: ['ISRC-X'] } },
    };
    const stamped = stampSupabaseLedgerRow(row, 'TX-1');
    const metadata = stamped.metadata as {
      provenance: string;
      lineage: { references: string[] };
      cbt: { settlementCode: string; derivedFrom: string };
    };
    expect(metadata.provenance).toBe('pr-26');
    expect(metadata.lineage).toEqual({ references: ['ISRC-X'] });
    expect(metadata.cbt.settlementCode).toMatch(CBT_SETTLEMENT_CODE_PATTERN);
    expect(metadata.cbt.settlementCode).toBe(generateCBTSettlementCode('TX-1'));
    expect(metadata.cbt.derivedFrom).toBe('reference_id');
  });

  it('derives the same code from the same reference (deterministic)', () => {
    expect(stampSupabaseLedgerRow({ a: 1 }, 'REF').metadata).toEqual(stampSupabaseLedgerRow({ a: 1 }, 'REF').metadata);
  });
});

describe('isMissingMetadataColumnError — the money-never-blocks guard', () => {
  it('recognizes PostgreSQL 42703 and PostgREST PGRST204 as missing-column errors', () => {
    expect(isMissingMetadataColumnError({ code: '42703', message: 'column "metadata" does not exist' })).toBe(true);
    expect(isMissingMetadataColumnError({ code: 'PGRST204', message: 'Could not find the metadata column' })).toBe(true);
  });

  it('treats every other failure as a real error', () => {
    for (const error of [
      { code: '23505', message: 'duplicate key' },
      { code: '25P02', message: 'in aborted transaction' },
      { message: 'boom' },
      {},
      null,
      undefined,
      '42703',
      42,
    ]) {
      expect(isMissingMetadataColumnError(error)).toBe(false);
    }
  });
});
