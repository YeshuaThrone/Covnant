/**
 * PR 11 — the verification capstone's e2e sandbox collection run (build spec
 * art_MzwqTXym, Verification table, "Whole gates" row): one run proving the
 * FULL path — statement file in → cleared (MUL) → matched (identifier spine)
 * → split via the locked engines → CBT-stamped ledger row → visible through
 * the API surface.
 *
 * Sandbox stores, two seams:
 * - The Store seam runs on InMemoryStore — the designed test swap and the
 *   SAME store the DON_DEV_SEED=1 e2e server boots; the three-backend parity
 *   suite (sdkStoreParity.test.ts) pins InMemory/Sqlite/Supabase equivalence
 *   for the SDK record tables.
 * - The pg seam runs on a scripted Db that routes the REAL SQL text — the
 *   vault adapter's cbt_assets attach/lookup statements, the wire's asset
 *   sheet read, and the universal_royalty_ledger credit INSERT with its real
 *   UNIQUE reference_id semantics — the harness discipline pinned by
 *   match.test.ts and wire.test.ts. No SQL is invented here: every pattern
 *   this fake answers is a production statement from those modules.
 *
 * Honesty boundary, on the record: v1 exposes no HTTP statement-ingest route
 * (the spec scopes the operator surface to the API-only admin routes), so
 * "visible through the API surface" is proven through the exact read APIs
 * those routes and surfaces delegate to — getClearance (the admin MUL
 * route's read), the universal_royalty_ledger SELECT (the table /api/ledger
 * serves), and the Store seam's provenance/queue/run reads. Nothing here
 * stubs the SDK: parsers, clearance machine, vault adapter, matcher, and the
 * engine wire all execute their real code paths.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { expect, test } from '@playwright/test';
import type { QueryResult, QueryResultRow } from 'pg';

import type { Db } from '@/lib/db';
import { attachExternalIdentifier } from '@/lib/covnant/vault';
import { generateCBTSettlementCode } from '@/lib/ledger/cbt-settlement';
import { InMemoryStore } from '@/lib/server/inMemoryStore';

import { matchEvent, rematchOpenEvents } from '../covnant-sdk/src/match/match';
import {
  ClearanceBlockedError,
  assertCollectible,
  getClearance,
  transitionClearance,
} from '../covnant-sdk/src/mul/clearance';
import { recordStatementIngest } from '../covnant-sdk/src/parsers/ingest';
import type { StatementFile } from '../covnant-sdk/src/nodes/collection-node';
import {
  settleEvent,
  settlementReferenceId,
  type MatchedEvent,
} from '../covnant-sdk/src/engine/wire';

// ---------------------------------------------------------------------------
// Fixtures — the parsers' golden DDEX RDR-R statement and two catalog assets.
// ---------------------------------------------------------------------------

/** The REAL industry statement the parser test suite pins (RHEA→RFOO). */
const GOLDEN_DDEX_PATH = 'covnant-sdk/src/parsers/ddex/fixtures/golden-revenue-report.tsv';

function goldenStatement(): StatementFile {
  return {
    format: 'ddex-rdr',
    name: 'revenue-report.tsv',
    content: readFileSync(path.join(process.cwd(), GOLDEN_DDEX_PATH), 'utf8'),
  };
}

interface SandboxAsset {
  cvt_code: string;
  cbt_code: string;
  title: string;
  medium: string;
  mapped_identifiers: Record<string, string>;
  rights_holders: Array<Record<string, unknown>>;
}

/** 50/30/20 — a strict-gate sheet (units sum exactly 1,000,000). */
const SHEET_50_30_20 = [
  { id: 'holder-publisher', name: 'Pub Co', role: 'PUBLISHER', splitPercentage: 50, uct: 'UCT-US-2026-9F3A7C21-K4' },
  { id: 'holder-producer', name: 'The Producer', role: 'PRODUCER', splitPercentage: 30 },
  { id: 'holder-studio', name: 'Studio LLC', role: 'STUDIO', splitPercentage: 20 },
];

/** A single-holder 100.0000% sheet. */
const SHEET_100 = [{ id: 'holder-sole', name: 'Sole Writer', role: 'PUBLISHER', splitPercentage: 100 }];

const ASSET_A: SandboxAsset = {
  cvt_code: 'CVT-9F3A7C21-2026',
  cbt_code: 'CBT-TRK-1234567890AB',
  title: 'SECOND BEST',
  medium: 'MUSIC_TRACK',
  mapped_identifiers: {},
  rights_holders: SHEET_50_30_20,
};

const ASSET_B: SandboxAsset = {
  cvt_code: 'CVT-44BB11DD-2026',
  cbt_code: 'CBT-REC-ABCDEF123456',
  title: 'NEXT BEST',
  medium: 'MUSIC_TRACK',
  mapped_identifiers: {},
  rights_holders: SHEET_100,
};

// ---------------------------------------------------------------------------
// The scripted pg seam — the REAL SQL text, routed to sandbox behavior.
// ---------------------------------------------------------------------------

interface StoredCredit {
  rights_holder_id: string;
  amount_cents: string;
  transaction_type: string;
  reference_id: string;
  metadata: Record<string, unknown> | null;
}

class SandboxLedgerDb implements Db {
  readonly assets: SandboxAsset[];
  /** universal_royalty_ledger — UNIQUE on reference_id, the 23505 final guard. */
  readonly credits: StoredCredit[] = [];
  /** Every SQL string that reached this db — audit for the reader. */
  readonly queries: string[] = [];

  constructor(...assets: SandboxAsset[]) {
    this.assets = assets;
  }

  private firstHolderUct(asset: SandboxAsset): string | null {
    for (const holder of asset.rights_holders) {
      const uct = (holder as { uct?: unknown }).uct;
      if (typeof uct === 'string' && uct.length > 0) return uct;
    }
    return null;
  }

  /**
   * The vault's documented lookup-boundary fold on the STORED side — the
   * same fold match.test.ts pins (the query param arrives pre-folded by the
   * real vault code). Values attached through the real adapter are already
   * canonical, so the fold is a no-op for this run's round trip.
   */
  private foldStored(key: string, value: string): string {
    if (key === 'isrc' || key === 'iswc') return value.replaceAll('-', '').toUpperCase();
    if (key === 'doi' || key === 'epc_rfid') return value.toLowerCase();
    return value.toUpperCase();
  }

  query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params: unknown[] = [],
  ): Promise<QueryResult<T>> {
    return this.runQuery<T>(sql, params);
  }

  private async runQuery<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params: unknown[],
  ): Promise<QueryResult<T>> {
    this.queries.push(sql);

    // 1. attachExternalIdentifier's JSONB merge — [key, canonicalValue, cvtCode].
    if (/^UPDATE cbt_assets/.test(sql)) {
      const asset = this.assets.find((candidate) => candidate.cvt_code === params[2]);
      if (asset) {
        asset.mapped_identifiers = {
          ...asset.mapped_identifiers,
          [String(params[0])]: String(params[1]),
        };
      }
      return { rows: [] } as unknown as QueryResult<T>;
    }

    // 2. The attach SELECT — keyed by cvt_code, FOR UPDATE.
    if (/FOR UPDATE/.test(sql)) {
      const asset = this.assets.find((candidate) => candidate.cvt_code === params[0]);
      const rows = asset
        ? [
            {
              cvt_code: asset.cvt_code,
              cbt_code: asset.cbt_code,
              title: asset.title,
              medium: asset.medium,
              mapped_identifiers: asset.mapped_identifiers,
              uct: this.firstHolderUct(asset),
            },
          ]
        : [];
      return { rows } as unknown as QueryResult<T>;
    }

    // 3. The wire's asset-sheet read — cbt_code keyed.
    if (/rights_holders FROM cbt_assets/.test(sql)) {
      const asset = this.assets.find((candidate) => candidate.cbt_code === params[0]);
      const rows = asset
        ? [
            {
              cbt_code: asset.cbt_code,
              title: asset.title,
              rights_holders: asset.rights_holders,
            },
          ]
        : [];
      return { rows } as unknown as QueryResult<T>;
    }

    // 4. The vault's identifier lookup — one folded stored-side key per SELECT.
    if (/FROM cbt_assets/.test(sql)) {
      const key = /mapped_identifiers->>'([a-z_]+)'/.exec(sql)?.[1] ?? '';
      const wanted = String(params[0] ?? '');
      const hit = this.assets.find(
        (asset) => this.foldStored(key, asset.mapped_identifiers[key] ?? '') === wanted,
      );
      const rows = hit
        ? [
            {
              cvt_code: hit.cvt_code,
              cbt_code: hit.cbt_code,
              title: hit.title,
              medium: hit.medium,
              mapped_identifiers: hit.mapped_identifiers,
              uct: this.firstHolderUct(hit),
            },
          ]
        : [];
      return { rows } as unknown as QueryResult<T>;
    }

    // 5. The replay guard's read — by reference_id.
    if (/FROM universal_royalty_ledger/.test(sql)) {
      const row = this.credits.find((credit) => credit.reference_id === params[0]);
      return { rows: row ? [row] : [] } as unknown as QueryResult<T>;
    }

    // 6. The credit INSERT — the increase lane's column set, UNIQUE-guarded.
    if (/INSERT INTO universal_royalty_ledger/.test(sql)) {
      const referenceId = String(params[3]);
      if (this.credits.some((credit) => credit.reference_id === referenceId)) {
        const error: Error & { code?: string } = new Error(
          'duplicate key value violates unique constraint "universal_royalty_ledger_reference_id_key"',
        );
        error.code = '23505';
        throw error;
      }
      const withMetadata = params.length > 4;
      this.credits.push({
        rights_holder_id: String(params[0] ?? ''),
        amount_cents: String(params[1] ?? ''),
        transaction_type: String(params[2] ?? ''),
        reference_id: referenceId,
        metadata: withMetadata ? (JSON.parse(String(params[4])) as Record<string, unknown>) : null,
      });
      return { rows: [] } as unknown as QueryResult<T>;
    }

    throw new Error(`sandbox db: unexpected sql — ${sql}`);
  }

  transaction<T>(work: (tx: Pick<Db, 'query'>) => Promise<T>): Promise<T> {
    return work({ query: (sql, params) => this.query(sql, params) });
  }
}

// ---------------------------------------------------------------------------
// The e2e — one run, the full path in order.
// ---------------------------------------------------------------------------

test('statement in → cleared → matched → split via the locked engines → CBT-stamped ledger row, visible through the API surface', async () => {
  const store = new InMemoryStore();
  const db = new SandboxLedgerDb(ASSET_A, ASSET_B);
  const statement = goldenStatement();

  // --- Stage 1: statement file in — real parser dispatch, provenance recorded.
  const ingest = await recordStatementIngest(store, statement);
  expect(ingest.events).toHaveLength(2);
  expect(ingest.events[0]?.eventId).toBe('98765654321-1');
  expect(ingest.events[0]?.identifiers.ISRC).toBe('USDMG1800001');
  expect(ingest.events[1]?.identifiers.ISRC).toBe('USDMG1800002');
  expect(ingest.events[0]?.grossMicros).toBe(12_345_000_000n); // 123.45 EUR, exact

  const provenance = await store.getStatementIngest(ingest.ingestId);
  expect(provenance?.status).toBe('parsed');
  expect(provenance?.event_count).toBe(2);
  expect(provenance?.format).toBe('ddex');
  expect(provenance?.source).toBe('statement');
  expect(provenance?.file_name).toBe('revenue-report.tsv');

  const [event1, event2] = ingest.events;
  expect(event1).toBeDefined();
  expect(event2).toBeDefined();
  if (!event1 || !event2) return; // narrowed above — keeps tsc honest below

  // --- Stage 2: cleared (MUL) — the machine is the law, fail-closed first.
  expect(() => assertCollectible(null)).toThrow(ClearanceBlockedError);

  const clearanceA = await transitionClearance(store, {
    assetCbtCode: ASSET_A.cbt_code,
    to: 'draft',
  });
  expect(clearanceA.state).toBe('draft');
  expect(() => assertCollectible(clearanceA)).toThrow(ClearanceBlockedError);

  await transitionClearance(store, { assetCbtCode: ASSET_A.cbt_code, to: 'requested' });
  await transitionClearance(store, {
    assetCbtCode: ASSET_A.cbt_code,
    to: 'cleared',
    licensee: 'Spotify',
    territory: 'US',
    note: 'PR 11 e2e sandbox run',
  });

  const readbackA = await getClearance(store, ASSET_A.cbt_code);
  expect(readbackA?.state).toBe('cleared');
  expect(readbackA?.licensee).toBe('Spotify');
  expect(readbackA?.territory).toBe('US');
  assertCollectible(readbackA); // the dispatch gate opens — does not throw

  const historyA = await store.listClearanceTransitions(ASSET_A.cbt_code);
  expect(historyA.map((row) => row.to_state)).toEqual(['draft', 'requested', 'cleared']);

  // --- Stage 3: matched (identifier spine) — exact-only, quarantine preserves.
  const attached = await attachExternalIdentifier(db, ASSET_A.cvt_code, {
    kind: 'ISRC',
    value: 'USDMG1800001',
  });
  expect(attached.ok).toBe(true);

  const resolution1 = await matchEvent(store, db, event1);
  expect(resolution1).toEqual({ status: 'matched', cbtCode: ASSET_A.cbt_code });

  const resolution2 = await matchEvent(store, db, event2);
  expect(resolution2.status).toBe('quarantined'); // no identifier match yet
  const openQueue = await store.listMatchQueueEntries('open', 200);
  expect(openQueue).toHaveLength(1);
  expect(openQueue[0]?.event_id).toBe('98765654321-2');
  expect(openQueue[0]?.identifiers_json).toContain('USDMG1800002');
  expect(openQueue[0]?.gross_micros).toBe('5432000000');
  expect(openQueue[0]?.raw_payload.startsWith('RD01.01\t')).toBe(true); // verbatim

  // --- Stage 4: split via the LOCKED engines — the wire's one path to money.
  expect(readbackA).not.toBeNull();
  const matched1: MatchedEvent = { event: event1, cbtCode: ASSET_A.cbt_code, clearance: readbackA! };
  const settled1 = await settleEvent(store, db, matched1);
  if (!settled1.ok) throw new Error(`settlement refused: ${settled1.code} — ${settled1.message}`);
  expect(settled1.splitRun).not.toBeNull();
  // The locked floor+dust invariant, live: 12,345 cents across 50/30/20
  // floors to 6172 + 3703 + 2469 = 12,344 — the 1-cent remainder sweeps to
  // the company (the engine's variance account), never to a payee.
  expect(settled1.varianceAccountCents).toBe(1);
  expect(settled1.subCentDustMicros).toBe(0n); // 123.45 floors exactly
  expect(settled1.ledger.length).toBeGreaterThan(0);

  const reference1 = settlementReferenceId(event1.eventId);
  expect(settled1.credit.referenceId).toBe(reference1);
  expect(settled1.credit.metadata?.cbt).toEqual({
    settlementCode: generateCBTSettlementCode(reference1),
    derivedFrom: 'reference_id',
  });
  const sdkMeta1 = settled1.credit.metadata?.sdk as Record<string, unknown>;
  expect(sdkMeta1.event_id).toBe('98765654321-1');
  expect(sdkMeta1.rights_pipeline).toBe('master_digital_performance');
  expect(sdkMeta1.statement_format).toBe('ddex-rdr');
  expect(sdkMeta1.gross_micros).toBe('12345000000');
  expect(sdkMeta1.split_run_id).toBe(settled1.splitRun?.id);

  // The tier credit: the increase lane's exact column set, SDK transaction type.
  expect(db.credits).toHaveLength(1);
  expect(db.credits[0]?.transaction_type).toBe('SDK_ROYALTY_SETTLEMENT');
  expect(db.credits[0]?.amount_cents).toBe('12345');
  expect(db.credits[0]?.rights_holder_id).toBe('UCT-US-2026-9F3A7C21-K4');

  // --- Stage 5: replay idempotency — exactly one credit stands.
  const replay = await settleEvent(store, db, matched1);
  if (!replay.ok) throw new Error(`replay refused: ${replay.code}`);
  expect(replay.idempotent).toBe(true);
  expect(replay.credit.referenceId).toBe(reference1);
  expect(db.credits).toHaveLength(1);

  // --- Stage 6: recovery — the quarantined event is preserved, then drained.
  await transitionClearance(store, { assetCbtCode: ASSET_B.cbt_code, to: 'draft' });
  await transitionClearance(store, { assetCbtCode: ASSET_B.cbt_code, to: 'requested' });
  await transitionClearance(store, {
    assetCbtCode: ASSET_B.cbt_code,
    to: 'cleared',
    licensee: 'Spotify',
    territory: 'GB',
    note: 'PR 11 e2e sandbox run',
  });

  const attachedB = await attachExternalIdentifier(db, ASSET_B.cvt_code, {
    kind: 'ISRC',
    value: 'USDMG1800002',
  });
  expect(attachedB.ok).toBe(true);

  const drain = await rematchOpenEvents(store, db);
  expect(drain).toEqual({ scanned: 1, matched: 1, unmatched: 0 });
  const matchedQueue = await store.listMatchQueueEntries('matched', 200);
  expect(matchedQueue).toHaveLength(1);
  expect(matchedQueue[0]?.matched_cbt_code).toBe(ASSET_B.cbt_code);

  const clearanceB = await getClearance(store, ASSET_B.cbt_code);
  expect(clearanceB?.state).toBe('cleared');
  expect(clearanceB).not.toBeNull();
  const matched2: MatchedEvent = { event: event2, cbtCode: ASSET_B.cbt_code, clearance: clearanceB! };
  const settled2 = await settleEvent(store, db, matched2);
  if (!settled2.ok) throw new Error(`settlement 2 refused: ${settled2.code} — ${settled2.message}`);
  expect(settled2.subCentDustMicros).toBe(0n); // 54.32 floors exactly
  expect(settled2.credit.referenceId).toBe(settlementReferenceId(event2.eventId));
  expect(db.credits).toHaveLength(2);

  // --- Stage 7: visible through the API surface — every read surface.
  // The admin MUL route's read function sees both clearances.
  expect((await getClearance(store, ASSET_A.cbt_code))?.state).toBe('cleared');
  expect((await getClearance(store, ASSET_B.cbt_code))?.state).toBe('cleared');

  // The ledger read surface (the table GET /api/ledger serves): both credits
  // resolvable by their deterministic replay keys, each CBT-stamped.
  for (const event of [event1, event2]) {
    const referenceId = settlementReferenceId(event.eventId);
    const credit = db.credits.find((row) => row.reference_id === referenceId);
    expect(credit, referenceId).toBeDefined();
    expect(credit?.transaction_type).toBe('SDK_ROYALTY_SETTLEMENT');
    expect(credit?.metadata?.cbt).toEqual({
      settlementCode: generateCBTSettlementCode(referenceId),
      derivedFrom: 'reference_id',
    });
  }

  // The Store seam's run/provenance reads: both Don-universe runs resolve.
  expect(settled1.splitRun).not.toBeNull();
  const run1 = await store.getSplitRun(settled1.splitRun!.id);
  expect(run1?.id).toBe(settled1.splitRun?.id);
  expect((await store.listLedgerTransactionsByRun(settled1.splitRun!.id)).length).toBeGreaterThan(0);
  expect((await store.listMatchQueueEntries('open', 200))).toHaveLength(0); // drained
  expect((await store.getStatementIngest(ingest.ingestId))?.status).toBe('parsed');
});
