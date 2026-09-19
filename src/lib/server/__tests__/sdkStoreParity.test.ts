/**
 * Three-backend parity for the SDK collection surfaces (migration 0007) —
 * the same scenario script runs against InMemoryStore, SqliteStore (real
 * better-sqlite3, :memory:), and SupabaseStore over a behavioral PostgREST
 * fake. Identical bodies per backend are the parity guarantee: every store
 * must round-trip the records, order lists identically (created_at with
 * insertion-order tiebreak), and enforce the same uniqueness (match_queue
 * event_id) — migration 0007's column inventory is the shared contract.
 *
 * The fake client implements only the builder vocabulary SupabaseStore
 * uses for these tables (from/insert/upsert/update/select/eq/order/limit/
 * maybeSingle) plus a 23505 unique-violation path — enough to exercise the
 * store's real code: table mapping, the toRecord insertion_order
 * projection, and the one/many/oneStrict result shaping.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { InMemoryStore } from '@/lib/server/inMemoryStore';
import { SqliteStore } from '@/lib/server/sqliteStore';
import { SupabaseStore } from '@/lib/server/supabaseStore';
import type { Store } from '@/lib/server/store';
import type {
  MatchQueueRecord,
  MulClearanceRecord,
  StatementIngestRecord,
  SyncCatalogItemRecord,
  SyncLicensePurchaseRecord,
} from '@/modules/sdk/records';

// ---------------------------------------------------------------------------
// The behavioral PostgREST fake — chainable builder resolved at await.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

/** Error payload PostgREST returns on a failed statement (23505 = unique violation). */
interface FakeDbError {
  message: string;
  code: string;
}

const UNIQUE_VIOLATION: FakeDbError = {
  message: 'duplicate key value violates unique constraint "match_queue_event_id_key"',
  code: '23505',
};

/** The columns with a UNIQUE constraint, per migrations 0007 + 0008. */
const UNIQUE_COLUMNS: Record<string, string[]> = {
  match_queue: ['event_id'],
  sync_license_purchases: ['cbt_settlement_stamp'],
};

/** Tables whose migration defines the insertion_order identity column. */
const INSERTION_ORDER_TABLES = new Set([
  'mul_clearance_transitions',
  'match_queue',
  'statement_ingests',
]);

class FakeTable {
  private rows: Row[] = [];
  private nextInsertionOrder = 1;

  constructor(private readonly tableName: string) {}

  /** Assigns the identity column so the store's toRecord projection is real. */
  insert(row: Row): Row {
    const stored =
      INSERTION_ORDER_TABLES.has(this.tableName) ?
        { ...row, insertion_order: this.nextInsertionOrder++ }
      : { ...row };
    this.rows.push(stored);
    return stored;
  }

  upsert(row: Row, conflictColumn: string): Row {
    const existing = this.rows.findIndex((r) => r[conflictColumn] === row[conflictColumn]);
    if (existing === -1) {
      return this.insert(row);
    }
    // ON CONFLICT DO UPDATE keeps the original insertion_order.
    this.rows[existing] = { ...this.rows[existing], ...row };
    return this.rows[existing];
  }

  isUniqueViolation(table: string, row: Row): boolean {
    return (UNIQUE_COLUMNS[table] ?? []).some(
      (column) => row[column] !== undefined && this.rows.some((r) => r[column] === row[column]),
    );
  }

  select(): Row[] {
    return this.rows.map((row) => ({ ...row }));
  }

  update(patch: Row, filters: Array<[string, unknown]>): number {
    let changed = 0;
    for (let i = 0; i < this.rows.length; i++) {
      if (filters.every(([column, value]) => this.rows[i][column] === value)) {
        this.rows[i] = { ...this.rows[i], ...patch };
        changed++;
      }
    }
    return changed;
  }
}

interface FakeResult {
  data: unknown;
  error: FakeDbError | null;
}

class FakeQueryBuilder {
  private filters: Array<[string, unknown]> = [];
  private orders: Array<[string, boolean]> = [];
  private limitCount: number | null = null;
  private single = false;
  private operation:
    | { kind: 'insert'; row: Row }
    | { kind: 'upsert'; row: Row; conflictColumn: string }
    | { kind: 'update'; patch: Row }
    | { kind: 'select' } = { kind: 'select' };

  constructor(
    private readonly table: FakeTable,
    private readonly tableName: string,
  ) {}

  insert(row: Row): this {
    this.operation = { kind: 'insert', row };
    return this;
  }

  upsert(row: Row, options: { onConflict: string }): this {
    this.operation = { kind: 'upsert', row, conflictColumn: options.onConflict };
    return this;
  }

  update(patch: Row): this {
    this.operation = { kind: 'update', patch };
    return this;
  }

  select(): this {
    return this;
  }

  eq(column: string, value: unknown): this {
    this.filters.push([column, value]);
    return this;
  }

  order(column: string, options?: { ascending?: boolean }): this {
    this.orders.push([column, options?.ascending ?? true]);
    return this;
  }

  limit(count: number): this {
    this.limitCount = count;
    return this;
  }

  /** Single-row result mode — resolved in execute(): row or data:null. */
  maybeSingle(): this {
    this.single = true;
    return this;
  }

  /** The PostgREST builder is thenable — `await` resolves { data, error }. */
  then<TResult1 = FakeResult, TResult2 = never>(
    onFulfilled?: (value: FakeResult) => TResult1,
    onRejected?: (reason: unknown) => TResult2,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(this.execute()).then(onFulfilled, onRejected);
  }

  private matches(row: Row): boolean {
    return this.filters.every(([column, value]) => row[column] === value);
  }

  private sorted(rows: Row[]): Row[] {
    const sorted = [...rows];
    for (let i = this.orders.length - 1; i >= 0; i--) {
      const [column, ascending] = this.orders[i];
      sorted.sort((a, b) => {
        const av = a[column];
        const bv = b[column];
        const cmp = av === bv ? 0 : (av as string | number) < (bv as string | number) ? -1 : 1;
        return ascending ? cmp : -cmp;
      });
    }
    return sorted;
  }

  private execute(): FakeResult {
    const op = this.operation;
    if (op.kind === 'insert') {
      if (this.table.isUniqueViolation(this.tableName, op.row)) {
        return { data: null, error: UNIQUE_VIOLATION };
      }
      return { data: this.table.insert(op.row), error: null };
    }
    if (op.kind === 'upsert') {
      return { data: this.table.upsert(op.row, op.conflictColumn), error: null };
    }
    if (op.kind === 'update') {
      const changed = this.table.update(op.patch, this.filters);
      if (changed === 0) return { data: null, error: null };
      // Fall through: select returns the updated rows below.
    }
    const rows = this.sorted(this.table.select().filter((row) => this.matches(row)));
    const limited = this.limitCount === null ? rows : rows.slice(0, this.limitCount);
    // Real client: .maybeSingle() resolves to the row itself, or data:null
    // when nothing matched — never an array. one()/oneStrict() rely on it.
    if (this.single) {
      return { data: limited[0] ?? null, error: null };
    }
    return { data: limited, error: null };
  }
}

/**
 * The used subset of SupabaseClient. Cast at the SupabaseStore boundary —
 * the real client's full surface is far larger than these tables touch.
 */
class FakeSupabaseClient {
  private tables = new Map<string, FakeTable>();

  from(table: string): FakeQueryBuilder {
    let t = this.tables.get(table);
    if (t === undefined) {
      t = new FakeTable(table);
      this.tables.set(table, t);
    }
    return new FakeQueryBuilder(t, table);
  }
}

// ---------------------------------------------------------------------------
// Backend registry + fixtures.
// ---------------------------------------------------------------------------

interface BackendSpec {
  name: string;
  make: () => Store;
  /**
   * Materializes the 0008 identity projection for the getCreatorUct parity
   * read — the local seed seams (InMemory/SQLite) or the production signup
   * registry rows (Supabase, through the fake client).
   */
  seedIdentity: (store: Store) => Promise<void>;
}

/** The Supabase backend's fake client, captured by make() for registry seeding. */
let lastFakeClient: FakeSupabaseClient | undefined;

const CREATOR_ID = 'creator_1';
const IDENTITY_UCT = 'UCT-US-2026-9F3A7C21';
const IDENTITY_ISNI = '0000-0002-1825-0097';

const BACKENDS: BackendSpec[] = [
  {
    name: 'InMemoryStore',
    make: () => new InMemoryStore(),
    seedIdentity: async (store) => {
      await (store as InMemoryStore).upsertCreatorUct({
        creatorId: CREATOR_ID,
        uctNumber: IDENTITY_UCT,
        isni: IDENTITY_ISNI,
      });
    },
  },
  {
    name: 'SqliteStore',
    make: () => new SqliteStore(':memory:'),
    seedIdentity: async (store) => {
      await (store as SqliteStore).upsertCreatorUct({
        creatorId: CREATOR_ID,
        uctNumber: IDENTITY_UCT,
        isni: IDENTITY_ISNI,
      });
    },
  },
  {
    // The fake implements the builder subset these tables use; the real
    // SupabaseClient surface is far larger than the store touches.
    name: 'SupabaseStore',
    make: () => {
      const client = new FakeSupabaseClient();
      lastFakeClient = client;
      return new SupabaseStore(client as unknown as SupabaseClient);
    },
    seedIdentity: async () => {
      const client = lastFakeClient;
      if (client === undefined) throw new Error('fake client not initialized');
      await client.from('cbt_assets').insert({
        cbt_code: 'CBT-SIGNUP-REGISTRY',
        rights_holders: [
          { rightsHolderId: CREATOR_ID, email: 'Creator@Example.com', uct: IDENTITY_UCT },
        ],
      });
      // creator_profiles.isni keyed by the NORMALIZED email.
      await client.from('creator_profiles').insert({ email: 'creator@example.com', isni: IDENTITY_ISNI });
    },
  },
];

const mulClearanceInput = (overrides: Partial<MulClearanceRecord> = {}): MulClearanceRecord => ({
  asset_cbt_code: 'CBT-REC-0123456789AB',
  state: 'draft',
  licensee: null,
  territory: null,
  term_start: null,
  term_end: null,
  updated_at: '2026-09-01T00:00:00Z',
  ...overrides,
});

const matchQueueInput = (
  overrides: Partial<Omit<MatchQueueRecord, 'id'>> = {},
): Omit<MatchQueueRecord, 'id'> => ({
  event_id: 'evt_001',
  status: 'open',
  reason: 'no_identifier_match',
  rights_pipeline: 'composition_performance',
  source: 'statement',
  platform: null,
  territory: 'US',
  period: '2026-08',
  currency: 'USD',
  gross_micros: '12345000000',
  identifiers_json: '{"ISRC":"USUM71703862"}',
  raw_payload: '{"statement":"verbatim"}',
  matched_cbt_code: null,
  resolved_at: null,
  created_at: '2026-09-01T00:00:00Z',
  ...overrides,
});

const statementIngestInput = (
  overrides: Partial<Omit<StatementIngestRecord, 'id'>> = {},
): Omit<StatementIngestRecord, 'id'> => ({
  format: 'cwr',
  source: 'statement',
  file_name: 'CW2600812_8837.V21',
  content: 'HDR\nNWR...',
  status: 'parsed',
  event_count: 12,
  error: null,
  created_at: '2026-09-01T00:00:00Z',
  ...overrides,
});

const syncCatalogInput = (overrides: Partial<SyncCatalogItemRecord> = {}): SyncCatalogItemRecord => ({
  cbt_code: 'CBT-REC-0123456789AB',
  is_pre_cleared: false,
  sync_fee_cents: 25000,
  genre: 'Ambient',
  bpm: 92,
  updated_at: '2026-09-01T00:00:00Z',
  ...overrides,
});

const syncPurchaseInput = (
  overrides: Partial<Omit<SyncLicensePurchaseRecord, 'id' | 'created_at'>> = {},
): Omit<SyncLicensePurchaseRecord, 'id' | 'created_at'> => ({
  cvt_asset_tag: 'CBT-REC-0123456789AB',
  buyer_uct: 'UCT-US-2026-DEADBEEF',
  license_type: 'COMMERCIAL_SYNC',
  fee_paid_cents: 999,
  cbt_settlement_stamp: 'CBT-SETTLE-0123456789AB',
  split_run_id: 'run_1',
  metadata: { cbt: { settlementCode: 'CBT-SETTLE-0123456789AB', derivedFrom: 'reference_id' } },
  ...overrides,
});

let store: Store;

describe.each(BACKENDS)('SDK store parity — $name', ({ make, seedIdentity }) => {
  beforeEach(() => {
    store = make();
  });

  describe('MUL clearance', () => {
    it('round-trips upsert → get-by-asset with every field verbatim', async () => {
      const row = mulClearanceInput({
        state: 'cleared',
        licensee: 'Meridian Records',
        territory: 'US',
        term_start: '2026-01-01T00:00:00Z',
        term_end: '2027-01-01T00:00:00Z',
        updated_at: '2026-09-02T00:00:00Z',
      });
      const upserted = await store.upsertClearance(row);
      expect(upserted).toEqual(row);

      expect(await store.getClearanceForAsset(row.asset_cbt_code)).toEqual(row);
    });

    it('returns undefined for an asset that was never cleared', async () => {
      expect(await store.getClearanceForAsset('CBT-UNKNOWN')).toBeUndefined();
    });

    it('keeps one row per asset — a second upsert updates in place', async () => {
      const asset = 'CBT-REC-0123456789AB';
      await store.upsertClearance(mulClearanceInput({ asset_cbt_code: asset, state: 'draft' }));
      const updated = await store.upsertClearance(
        mulClearanceInput({
          asset_cbt_code: asset,
          state: 'cleared',
          licensee: 'Meridian Records',
          updated_at: '2026-09-03T00:00:00Z',
        }),
      );

      expect(updated.state).toBe('cleared');
      expect(await store.getClearanceForAsset(asset)).toEqual(updated);
    });

    it('lists transition history oldest first, insertion order as tiebreak, scoped per asset', async () => {
      const assetA = 'CBT-REC-0123456789AB';
      const assetB = 'CBT-REC-BA9876543210';
      const tie = '2026-09-02T00:00:00Z';
      const first = await store.insertClearanceTransition({
        asset_cbt_code: assetA,
        from_state: null,
        to_state: 'requested',
        note: null,
        created_at: '2026-09-01T00:00:00Z',
      });
      const tiedOld = await store.insertClearanceTransition({
        asset_cbt_code: assetA,
        from_state: 'requested',
        to_state: 'cleared',
        note: null,
        created_at: tie,
      });
      const tiedNew = await store.insertClearanceTransition({
        asset_cbt_code: assetA,
        from_state: 'cleared',
        to_state: 'disputed',
        note: 'claim received',
        created_at: tie,
      });
      await store.insertClearanceTransition({
        asset_cbt_code: assetB,
        from_state: null,
        to_state: 'requested',
        note: null,
        created_at: tie,
      });

      const history = await store.listClearanceTransitions(assetA);
      expect(history.map((row) => row.id)).toEqual([first.id, tiedOld.id, tiedNew.id]);
      // Tied timestamps keep insertion order (the later transition second).
      expect(history[1].to_state).toBe('cleared');
      expect(history[2].to_state).toBe('disputed');
      // Asset B's history stays out of A's list; A's first row opens with null.
      expect(await store.listClearanceTransitions(assetB)).toHaveLength(1);
      expect(history[0].from_state).toBeNull();
    });
  });

  describe('match queue', () => {
    it('quarantines verbatim and round-trips get by store-generated id', async () => {
      const input = matchQueueInput();
      const inserted = await store.insertMatchQueueEntry(input);

      expect(inserted.id).toEqual(expect.any(String));
      expect(await store.getMatchQueueEntry(inserted.id)).toEqual(inserted);
      // Preserved verbatim — the raw payload and parsed identifiers survive byte-honest.
      expect(inserted.raw_payload).toBe('{"statement":"verbatim"}');
      expect(inserted.identifiers_json).toBe('{"ISRC":"USUM71703862"}');
    });

    it('returns undefined for an unknown id', async () => {
      expect(await store.getMatchQueueEntry('missing')).toBeUndefined();
    });

    it('refuses to quarantine a replayed event_id — the quarantine-once rule', async () => {
      await store.insertMatchQueueEntry(matchQueueInput({ event_id: 'evt_001' }));
      await expect(
        store.insertMatchQueueEntry(matchQueueInput({ event_id: 'evt_001' })),
      ).rejects.toThrow(/(UNIQUE constraint failed|23505)/);
    });

    it('lists newest first with insertion-order tiebreak, scoped by status, honoring limit', async () => {
      const tie = '2026-09-02T00:00:00Z';
      const oldest = await store.insertMatchQueueEntry(
        matchQueueInput({ event_id: 'evt_old', created_at: '2026-09-01T00:00:00Z' }),
      );
      const tieFirst = await store.insertMatchQueueEntry(
        matchQueueInput({ event_id: 'evt_tie1', created_at: tie }),
      );
      const tieLater = await store.insertMatchQueueEntry(
        matchQueueInput({ event_id: 'evt_tie2', created_at: tie }),
      );
      const newest = await store.insertMatchQueueEntry(
        matchQueueInput({ event_id: 'evt_new', created_at: '2026-09-03T00:00:00Z' }),
      );

      // Newest first; the tied pair keeps insertion order (later insert leads).
      const all = await store.listMatchQueueEntries();
      expect(all.map((row) => row.id)).toEqual([
        newest.id,
        tieLater.id,
        tieFirst.id,
        oldest.id,
      ]);

      // Limit truncates from the head.
      expect((await store.listMatchQueueEntries(undefined, 2)).map((row) => row.id)).toEqual([
        newest.id,
        tieLater.id,
      ]);

      // Resolving one scopes the open list to the rest — the recovery drain path.
      await store.resolveMatchQueueEntry(newest.id, {
        status: 'matched',
        cbtCode: 'CBT-REC-0123456789AB',
      });
      const open = await store.listMatchQueueEntries('open');
      expect(open).toHaveLength(3);
      expect(open.map((row) => row.status)).toEqual(['open', 'open', 'open']);
      expect(await store.listMatchQueueEntries('matched')).toHaveLength(1);
    });

    it('resolves matched — stamps the CBT code and resolved_at, persisted', async () => {
      const inserted = await store.insertMatchQueueEntry(matchQueueInput());
      const resolved = await store.resolveMatchQueueEntry(inserted.id, {
        status: 'matched',
        cbtCode: 'CBT-REC-0123456789AB',
      });

      expect(resolved?.status).toBe('matched');
      expect(resolved?.matched_cbt_code).toBe('CBT-REC-0123456789AB');
      expect(resolved?.resolved_at).toEqual(expect.any(String));
      expect(await store.getMatchQueueEntry(inserted.id)).toEqual(resolved);
    });

    it('resolves discarded — closes the entry without a CBT code', async () => {
      const inserted = await store.insertMatchQueueEntry(matchQueueInput());
      const resolved = await store.resolveMatchQueueEntry(inserted.id, { status: 'discarded' });

      expect(resolved?.status).toBe('discarded');
      expect(resolved?.matched_cbt_code).toBeNull();
      expect(resolved?.resolved_at).toEqual(expect.any(String));
      expect(await store.getMatchQueueEntry(inserted.id)).toEqual(resolved);
    });

    it('returns undefined when resolving an id that does not exist', async () => {
      expect(
        await store.resolveMatchQueueEntry('missing', {
          status: 'matched',
          cbtCode: 'CBT-REC-0123456789AB',
        }),
      ).toBeUndefined();
    });
  });

  describe('statement ingests', () => {
    it('records the ingest with its parse outcome and round-trips get by id', async () => {
      const input = statementIngestInput();
      const inserted = await store.insertStatementIngest(input);

      expect(inserted.id).toEqual(expect.any(String));
      expect(await store.getStatementIngest(inserted.id)).toEqual(inserted);
    });

    it('records a failed parse — the error and verbatim content survive', async () => {
      const inserted = await store.insertStatementIngest(
        statementIngestInput({
          status: 'failed',
          event_count: null,
          error: 'HDR segment missing',
          content: 'garbage bytes',
        }),
      );

      const fetched = await store.getStatementIngest(inserted.id);
      expect(fetched?.status).toBe('failed');
      expect(fetched?.event_count).toBeNull();
      expect(fetched?.error).toBe('HDR segment missing');
      expect(fetched?.content).toBe('garbage bytes');
    });

    it('returns undefined for an unknown id', async () => {
      expect(await store.getStatementIngest('missing')).toBeUndefined();
    });
  });

  describe('creator UCT identity (0008)', () => {
    it('returns undefined when the creator has no root UCT — never a mint', async () => {
      await expect(store.getCreatorUct('creator_without_uct')).resolves.toBeUndefined();
    });

    it('resolves the identity projection (root UCT + ISNI) without minting', async () => {
      await seedIdentity(store);
      await expect(store.getCreatorUct(CREATOR_ID)).resolves.toEqual({
        creatorId: CREATOR_ID,
        uctNumber: IDENTITY_UCT,
        isni: IDENTITY_ISNI,
      });
    });
  });

  describe('sync catalog (0008)', () => {
    it('upserts, reads, and lists catalog items in stable cbt_code order', async () => {
      await store.upsertSyncCatalogItem(syncCatalogInput({ cbt_code: 'CBT-REC-B' }));
      await store.upsertSyncCatalogItem(syncCatalogInput({ cbt_code: 'CBT-REC-A' }));

      expect(await store.getSyncCatalogItem('CBT-REC-B')).toEqual({
        cbt_code: 'CBT-REC-B',
        is_pre_cleared: false,
        sync_fee_cents: 25000,
        genre: 'Ambient',
        bpm: 92,
        updated_at: '2026-09-01T00:00:00Z',
      });
      await expect(store.getSyncCatalogItem('CBT-REC-ZZ')).resolves.toBeUndefined();

      const list = await store.listSyncCatalogItems();
      expect(list.map((item) => item.cbt_code)).toEqual(['CBT-REC-A', 'CBT-REC-B']);
    });

    it('re-upserting the same cbt_code updates the row in place', async () => {
      await store.upsertSyncCatalogItem(syncCatalogInput());
      await store.upsertSyncCatalogItem(
        syncCatalogInput({ is_pre_cleared: true, sync_fee_cents: 30000, bpm: null }),
      );

      expect(await store.getSyncCatalogItem('CBT-REC-0123456789AB')).toMatchObject({
        is_pre_cleared: true,
        sync_fee_cents: 30000,
        bpm: null,
      });
      expect((await store.listSyncCatalogItems()).length).toBe(1);
    });
  });

  describe('sync license purchases (0008)', () => {
    it('inserts and reads back the settlement write-back record by stamp', async () => {
      const input = syncPurchaseInput();
      const inserted = await store.insertSyncLicensePurchase(input);

      expect(inserted.id).toEqual(expect.any(String));
      expect(await store.getSyncLicensePurchaseByStamp(inserted.cbt_settlement_stamp)).toEqual(inserted);
      expect(inserted.metadata).toEqual(input.metadata);
    });

    it('enforces the UNIQUE settlement stamp — the replay key', async () => {
      await store.insertSyncLicensePurchase(syncPurchaseInput());
      await expect(store.insertSyncLicensePurchase(syncPurchaseInput())).rejects.toThrow(
        /23505|UNIQUE|unique/i,
      );

      // The lane's recovery path: the existing row is re-readable by stamp.
      const existing = await store.getSyncLicensePurchaseByStamp('CBT-SETTLE-0123456789AB');
      expect(existing?.split_run_id).toBe('run_1');
    });
  });
});
