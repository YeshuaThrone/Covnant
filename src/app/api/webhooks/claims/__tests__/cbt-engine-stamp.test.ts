import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { POST } from '../route';
import { processUniversalSocialWebhookAction } from '@/engine/covenant-master-sdk';
import type { SettlementResult } from '@/engine/covenant-master-sdk';
import { supabaseFromEnv } from '@/lib/supabase';
import { CBT_SETTLEMENT_CODE_PATTERN, generateCBTSettlementCode } from '@/lib/ledger/cbt-settlement';

/**
 * Generation 9 — engine-boundary CBT stamping evidence for the claims webhook
 * (POST /api/webhooks/claims). In DB mode the vendored SDK action upserts the
 * ledger rows itself (hash-locked — it cannot stamp), so the repo-side
 * boundary enriches each settled row with a bounded, METADATA-ONLY
 * read-merge-update keyed by transaction_id. Tests mock the SDK action (the
 * engine's own upsert is its own concern) and the Supabase client, and pin:
 * the frozen code shape, merge-only metadata, the metadata-only update
 * envelope, money-never-blocks, memory-mode isolation, and determinism.
 */

vi.mock('@/engine/covenant-master-sdk', () => ({
  processUniversalSocialWebhookAction: vi.fn(),
}));

vi.mock('@/lib/supabase', () => ({ supabaseFromEnv: vi.fn() }));

const mockAction = vi.mocked(processUniversalSocialWebhookAction);
const mockSupabaseFromEnv = vi.mocked(supabaseFromEnv);

/** Captures the enrichment client's reads, writes, and scripted failures. */
const ledgerDb = vi.hoisted(() => ({
  rows: new Map<string, { metadata: Record<string, unknown> } | null>(),
  reads: [] as string[],
  updates: [] as { id: string; metadata: unknown }[],
  failUpdateWith: null as { code: string; message: string } | null,
  failReadWith: null as { code: string; message: string } | null,
}));

function fakeLedgerDb(): never {
  return {
    from: (table: string) => {
      if (table !== 'universal_royalty_ledger') throw new Error(`unexpected table ${table}`);
      return {
        select: () => ({
          eq: (_column: string, id: string) => ({
            maybeSingle: async () => {
              ledgerDb.reads.push(id);
              if (ledgerDb.failReadWith) return { data: null, error: { ...ledgerDb.failReadWith } };
              const row = ledgerDb.rows.get(id);
              return row ? { data: { ...row }, error: null } : { data: null, error: null };
            },
          }),
        }),
        update: (payload: { metadata?: unknown }) => ({
          eq: (_column: string, id: string) => {
            ledgerDb.updates.push({ id, metadata: payload.metadata });
            if (ledgerDb.failUpdateWith) {
              return Promise.resolve({ error: { ...ledgerDb.failUpdateWith } });
            }
            const row = ledgerDb.rows.get(id);
            if (row) row.metadata = payload.metadata as Record<string, unknown>;
            return Promise.resolve({ error: null });
          },
        }),
      };
    },
  } as never;
}

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

const validClaim = {
  platform: 'SPOTIFY',
  cbtCode: 'CBT-TRK-TEST000010',
  externalAssetId: 'spotify:track:1234',
  mediaContentId: 'vid-1',
  channelOrProfileId: 'channel-1',
  grossAdRevenueOrRoyalty: 120.5,
  currency: 'USD',
  territoryCountryCode: 'US',
  timestamp: 1_720_000_000_000,
};

const SETTLED: SettlementResult = {
  transactionId: 'SOC-GEN9-1',
  cbtCode: 'CBT-TRK-TEST000010',
  totalSettled: 90,
  currency: 'USD',
  platformFeeDeducted: 10,
  cornerDustCollected: 0,
  disbursements: [],
  reconciliationStatus: 'PASS',
};

function post(body: unknown): Promise<Response> {
  return POST(
    new Request('https://covnant.example/api/webhooks/claims', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  ledgerDb.rows.clear();
  ledgerDb.reads.length = 0;
  ledgerDb.updates.length = 0;
  ledgerDb.failUpdateWith = null;
  ledgerDb.failReadWith = null;
  enableDbMode();
  mockSupabaseFromEnv.mockReturnValue(fakeLedgerDb());
  mockAction.mockResolvedValue({ success: true, processedCount: 1, data: [SETTLED] });
});

afterEach(() => {
  disableDbMode();
  vi.unstubAllGlobals();
});

describe('G2 · the engine boundary enriches settled rows with the frozen code shape', () => {
  it('stamps metadata.cbt derived from the row transaction_id, merge-only over existing metadata', async () => {
    ledgerDb.rows.set('SOC-GEN9-1', {
      metadata: { provenance: 'pr-26', lineage: { references: ['ISRC-X'] } },
    });

    const res = await post({ claims: [validClaim] });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(ledgerDb.updates).toHaveLength(1);
    const metadata = ledgerDb.updates[0].metadata as {
      provenance?: string;
      lineage?: unknown;
      cbt?: { settlementCode?: string; derivedFrom?: string };
    };
    // Merge-only: every pre-existing metadata key survives…
    expect(metadata.provenance).toBe('pr-26');
    expect(metadata.lineage).toEqual({ references: ['ISRC-X'] });
    // …and the cbt tag is the frozen Generation 8 shape.
    expect(metadata.cbt?.settlementCode).toMatch(CBT_SETTLEMENT_CODE_PATTERN);
    expect(metadata.cbt?.settlementCode).toBe(generateCBTSettlementCode('SOC-GEN9-1'));
    expect(metadata.cbt?.derivedFrom).toBe('reference_id');
  });

  it('addresses only the metadata column of the referenced row (append-only in the row sense)', async () => {
    ledgerDb.rows.set('SOC-GEN9-1', { metadata: {} });

    await post({ claims: [validClaim] });

    expect(ledgerDb.reads).toEqual(['SOC-GEN9-1']);
    expect(ledgerDb.updates).toHaveLength(1);
    // The enrichment payload carries ONLY the metadata column — no amount,
    // status, or money field is addressable at the repo-side boundary.
    expect(Object.keys(ledgerDb.updates[0].metadata as Record<string, unknown>)).toEqual(['cbt']);
  });

  it('stamps rows whose metadata is empty (the SDK writes no metadata)', async () => {
    ledgerDb.rows.set('SOC-GEN9-1', { metadata: {} });

    await post({ claims: [validClaim] });

    const metadata = ledgerDb.updates[0].metadata as { cbt: { settlementCode: string } };
    expect(metadata.cbt.settlementCode).toBe(generateCBTSettlementCode('SOC-GEN9-1'));
  });
});

describe('G4 · money never blocks on the engine path', () => {
  it('still returns the settled result when the metadata update fails (PGRST204 missing column)', async () => {
    ledgerDb.rows.set('SOC-GEN9-1', { metadata: {} });
    ledgerDb.failUpdateWith = {
      code: 'PGRST204',
      message: "Could not find the 'metadata' column of 'universal_royalty_ledger' in the schema cache",
    };

    const res = await post({ claims: [validClaim] });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.processedCount).toBe(1);
    expect(body.results[0].transactionId).toBe('SOC-GEN9-1');
  });

  it('still returns the settled result when the metadata read fails or the row is absent', async () => {
    // Row absent (no read error, no data) — the enrichment skips.
    const res = await post({ claims: [validClaim] });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(ledgerDb.updates).toHaveLength(0);

    // Read failure (e.g. the additive column is not on the live table yet) — skip as well.
    ledgerDb.failReadWith = { code: 'PGRST204', message: 'Could not find the metadata column' };
    const second = await post({ claims: [validClaim] });
    expect(second.status).toBe(200);
    expect(((await second.json()) as { ok: boolean }).ok).toBe(true);
  });
});

describe('isolation · memory mode performs no enrichment', () => {
  it('leaves the ledger client untouched when Supabase is not configured', async () => {
    disableDbMode();
    // Memory mode: the store mirror sees no client either — the settlement
    // is mirrored into the in-memory ledger index only.
    mockSupabaseFromEnv.mockReturnValue(undefined);
    delete (globalThis as { __covnantLedgerIndex?: unknown }).__covnantLedgerIndex;

    const res = await post({ claims: [validClaim] });

    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    expect(ledgerDb.reads).toHaveLength(0);
    expect(ledgerDb.updates).toHaveLength(0);
    const index = (globalThis as { __covnantLedgerIndex?: { transactionId: string }[] })
      .__covnantLedgerIndex;
    expect(index?.some((row) => row.transactionId === 'SOC-GEN9-1')).toBe(true);
  });
});

describe('replay/determinism · the same claim re-derives the identical code', () => {
  it('reconciles repeated settlements of the same claim to the same settlement code', async () => {
    ledgerDb.rows.set('SOC-GEN9-1', { metadata: {} });

    await post({ claims: [validClaim] });
    await post({ claims: [validClaim] });

    expect(ledgerDb.updates).toHaveLength(2);
    const first = (ledgerDb.updates[0].metadata as { cbt: { settlementCode: string } }).cbt.settlementCode;
    const second = (ledgerDb.updates[1].metadata as { cbt: { settlementCode: string } }).cbt.settlementCode;
    expect(first).toBe(second);
    expect(first).toBe(generateCBTSettlementCode('SOC-GEN9-1'));
  });
});
