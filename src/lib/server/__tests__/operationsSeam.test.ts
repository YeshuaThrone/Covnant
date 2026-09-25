/**
 * Operations store seam (spec art_Eis55ifL) — the two list reads the
 * Operations back-office tab consumes.
 *
 * listStatementIngests completes the statement_ingests surface (migration
 * 0007; the store had insert/get only): the same insert → list scenario
 * runs against InMemoryStore, SqliteStore (real better-sqlite3, :memory:),
 * and SupabaseStore over a behavioral PostgREST fake. Identical bodies per
 * backend are the parity guarantee (the sdkStoreParity canon).
 *
 * listAdminActions reads the append-only admin_action_log (migration 0005,
 * RLS service-role-only). The table exists only in Supabase production —
 * the local mirrors carry no such table, so their honest read is empty,
 * never fabricated rows; the Supabase read is exercised over the fake,
 * including its failure path.
 *
 * The demo seed writes NEITHER table (devSeed ingests no statements and no
 * console mutation runs in it) — the seed pins at the bottom assert the
 * designed-empty state the Operations views render honestly.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { InMemoryStore } from '@/lib/server/inMemoryStore';
import { bootDevSeedStore } from '@/lib/server/devSeed';
import { SqliteStore } from '@/lib/server/sqliteStore';
import { SupabaseStore } from '@/lib/server/supabaseStore';
import type { Store } from '@/lib/server/store';
import type { StatementIngestRecord } from '@/modules/sdk/records';
import type { AdminActionChanges } from '@/lib/admin/types';

// ---------------------------------------------------------------------------
// The behavioral PostgREST fake — the builder vocabulary these reads use
// (from/insert/select/order/limit/maybeSingle over a thenable), modeled on
// the sdkStoreParity fake. insertion_order is assigned for the 0007 tables
// that carry the identity column, so SupabaseStore's toRecord projection is
// real; admin_action_log (0005) defines no such column.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

interface FakeDbError {
  message: string;
  code: string;
}

interface FakeResult {
  data: unknown;
  error: FakeDbError | null;
}

const INSERTION_ORDER_TABLES = new Set(['statement_ingests']);

class FakeTable {
  private rows: Row[] = [];
  private nextInsertionOrder = 1;

  constructor(private readonly tableName: string) {}

  insert(row: Row): Row {
    const stored = INSERTION_ORDER_TABLES.has(this.tableName)
      ? { ...row, insertion_order: this.nextInsertionOrder++ }
      : { ...row };
    this.rows.push(stored);
    return stored;
  }

  select(): Row[] {
    return this.rows.map((row) => ({ ...row }));
  }
}

class FakeQueryBuilder {
  private orders: Array<[string, boolean]> = [];
  private limitCount: number | null = null;
  private single = false;
  private operation: { kind: 'insert'; row: Row } | { kind: 'select' } = { kind: 'select' };

  constructor(
    private readonly table: FakeTable,
    private readonly tableName: string,
  ) {}

  insert(row: Row): this {
    this.operation = { kind: 'insert', row };
    return this;
  }

  select(): this {
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
    if (this.operation.kind === 'insert') {
      return { data: this.table.insert(this.operation.row), error: null };
    }
    const rows = this.sorted(this.table.select());
    const limited = this.limitCount === null ? rows : rows.slice(0, this.limitCount);
    // Real client: .maybeSingle() resolves to the row itself, or data:null
    // when nothing matched — never an array. one()/oneStrict() rely on it.
    return { data: this.single ? (limited[0] ?? null) : limited, error: null };
  }
}

/** The used subset of SupabaseClient. Cast at the SupabaseStore boundary. */
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
// Fixtures.
// ---------------------------------------------------------------------------

const ingestInput = (
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

/**
 * The admin_action_log insert payload — mirrors recordAdminAction's entry
 * plus the table's uuid PK (default gen_random_uuid(), which the fake
 * stands in for). A type alias, not an interface: object literal types
 * carry the implicit index signature the fake's Row parameter requires.
 */
type AuditEntryInput = {
  id: string;
  actor: string;
  action: string;
  target_table: string;
  target_row_id: string | null;
  changes: AdminActionChanges;
  created_at: string;
}

const auditEntry = (overrides: Partial<AuditEntryInput> = {}): AuditEntryInput => ({
  id: '0a000000-0000-4000-8000-000000000001',
  actor: 'admin',
  action: 'creator.compliance.update',
  target_table: 'creator_profiles',
  target_row_id: '11111111-1111-1111-1111-111111111111',
  changes: { kyc_status: { from: 'PENDING_INITIALIZATION', to: 'PENDING' } },
  created_at: '2026-09-01T00:00:00Z',
  ...overrides,
});

// ---------------------------------------------------------------------------
// listStatementIngests — three-backend parity (the sdkStoreParity canon):
// the identical insert → list scenario against every Store backend.
// ---------------------------------------------------------------------------

const BACKENDS: { name: string; make: () => Store }[] = [
  { name: 'InMemoryStore', make: () => new InMemoryStore() },
  { name: 'SqliteStore', make: () => new SqliteStore(':memory:') },
  {
    name: 'SupabaseStore',
    make: () => new SupabaseStore(new FakeSupabaseClient() as unknown as SupabaseClient),
  },
];

let store: Store;

describe.each(BACKENDS)('Operations store seam — listStatementIngests, $name', ({ make }) => {
  beforeEach(() => {
    store = make();
  });

  it('reads [] from a fresh store — honest emptiness, never zeros', async () => {
    await expect(store.listStatementIngests()).resolves.toEqual([]);
  });

  it('round-trips inserted ingests verbatim — parsed and failed rows alike', async () => {
    const parsed = await store.insertStatementIngest(ingestInput());
    const failed = await store.insertStatementIngest(
      ingestInput({
        format: 'ddex',
        source: 'manual',
        status: 'failed',
        event_count: null,
        error: 'HDR segment missing',
        content: 'garbage bytes',
        file_name: 'DDEX-2026-09.xml',
      }),
    );

    const rows = await store.listStatementIngests();
    expect(rows).toEqual([failed, parsed]); // newest first
    // A failed parse keeps the verbatim content and error — the recovery
    // path's evidence survives the list read.
    expect(rows[0]?.status).toBe('failed');
    expect(rows[0]?.event_count).toBeNull();
    expect(rows[0]?.error).toBe('HDR segment missing');
    expect(rows[0]?.content).toBe('garbage bytes');
    expect(rows[1]?.status).toBe('parsed');
    expect(rows[1]?.event_count).toBe(12);
  });

  it('lists newest first with the insertion-order tiebreak, honoring limit', async () => {
    const tie = '2026-09-02T00:00:00Z';
    await store.insertStatementIngest(
      ingestInput({ file_name: 'old.csv', created_at: '2026-09-01T00:00:00Z' }),
    );
    await store.insertStatementIngest(ingestInput({ file_name: 'tie1.csv', created_at: tie }));
    await store.insertStatementIngest(ingestInput({ file_name: 'tie2.csv', created_at: tie }));
    await store.insertStatementIngest(
      ingestInput({ file_name: 'new.csv', created_at: '2026-09-03T00:00:00Z' }),
    );

    // Newest first; the tied pair keeps insertion order (later insert leads).
    const rows = await store.listStatementIngests();
    expect(rows.map((row) => row.file_name)).toEqual([
      'new.csv',
      'tie2.csv',
      'tie1.csv',
      'old.csv',
    ]);

    // Limit truncates from the head of the newest-first list.
    const bounded = await store.listStatementIngests(2);
    expect(bounded.map((row) => row.file_name)).toEqual(['new.csv', 'tie2.csv']);
  });
});

// ---------------------------------------------------------------------------
// listAdminActions — the append-only audit trail. Local mirrors read
// honestly empty (no table, no fabricated rows); the Supabase read runs
// over the fake, including its failure path.
// ---------------------------------------------------------------------------

describe('Operations store seam — listAdminActions, local mirrors read honestly empty', () => {
  it('InMemoryStore carries no audit mirror — [], never fabricated rows', async () => {
    await expect(new InMemoryStore().listAdminActions()).resolves.toEqual([]);
  });

  it('SqliteStore carries no audit mirror — [], never fabricated rows', async () => {
    await expect(new SqliteStore(':memory:').listAdminActions()).resolves.toEqual([]);
  });
});

describe('Operations store seam — listAdminActions, SupabaseStore over the service-role read', () => {
  it('returns the append-only rows newest first, field-level changes verbatim', async () => {
    const client = new FakeSupabaseClient();
    const auditStore = new SupabaseStore(client as unknown as SupabaseClient);
    await client.from('admin_action_log').insert(auditEntry({ created_at: '2026-09-01T00:00:00Z' }));
    await client
      .from('admin_action_log')
      .insert(
        auditEntry({
          id: '0a000000-0000-4000-8000-000000000003',
          action: 'allowlist.status_flip',
          target_table: 'platform_allowlists',
          target_row_id: null,
          changes: { status: { from: 'blocked', to: 'allowed' } },
          created_at: '2026-09-03T00:00:00Z',
        }),
      );
    await client
      .from('admin_action_log')
      .insert(
        auditEntry({
          id: '0a000000-0000-4000-8000-000000000002',
          changes: { tier: { from: 'standard', to: 'verified' } },
          created_at: '2026-09-02T00:00:00Z',
        }),
      );

    const rows = await auditStore.listAdminActions();
    // Newest first (created_at DESC; the table defines no tiebreak key).
    expect(rows.map((row) => row.created_at)).toEqual([
      '2026-09-03T00:00:00Z',
      '2026-09-02T00:00:00Z',
      '2026-09-01T00:00:00Z',
    ]);
    // The full audit shape round-trips: who, what, target, field-level diff.
    expect(rows[0]).toEqual({
      id: '0a000000-0000-4000-8000-000000000003',
      actor: 'admin',
      action: 'allowlist.status_flip',
      target_table: 'platform_allowlists',
      target_row_id: null,
      changes: { status: { from: 'blocked', to: 'allowed' } },
      created_at: '2026-09-03T00:00:00Z',
    });
    expect(rows[2]?.changes).toEqual({
      kyc_status: { from: 'PENDING_INITIALIZATION', to: 'PENDING' },
    });
  });

  it('honors the limit from the head of the newest-first list', async () => {
    const client = new FakeSupabaseClient();
    const auditStore = new SupabaseStore(client as unknown as SupabaseClient);
    for (const day of ['01', '02', '03']) {
      await client
        .from('admin_action_log')
        .insert(auditEntry({ created_at: `2026-09-${day}T00:00:00Z` }));
    }

    const rows = await auditStore.listAdminActions(2);
    expect(rows.map((row) => row.created_at)).toEqual([
      '2026-09-03T00:00:00Z',
      '2026-09-02T00:00:00Z',
    ]);
  });

  it('propagates query failures — never a silent zero', async () => {
    // A non-service-role client hitting the RLS-denied table gets 42501;
    // the read surfaces it, it never degrades to [].
    const auditStore = new SupabaseStore({
      from: () => new FailingBuilder(),
    } as unknown as SupabaseClient);
    await expect(auditStore.listAdminActions()).rejects.toThrow(/listAdminActions.*42501/);
  });
});

/** A minimal thenable that fails the read the way PostgREST reports denial. */
const AUDIT_READ_FAILURE: FakeResult = {
  data: null,
  error: { message: 'permission denied for table admin_action_log', code: '42501' },
};

class FailingBuilder {
  select(): this {
    return this;
  }
  order(): this {
    return this;
  }
  limit(): this {
    return this;
  }
  then<TResult1 = FakeResult, TResult2 = never>(
    onFulfilled?: (value: FakeResult) => TResult1,
    onRejected?: (reason: unknown) => TResult2,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(AUDIT_READ_FAILURE).then(onFulfilled, onRejected);
  }
}

// ---------------------------------------------------------------------------
// Seed pins — the demo seed writes neither table, so both reads land on the
// designed-empty states the Operations views must render honestly.
// ---------------------------------------------------------------------------

describe('Operations store seam — seed pins (the demo seed writes neither table)', () => {
  let seeded: InMemoryStore;

  beforeAll(async () => {
    seeded = await bootDevSeedStore();
  });

  it('the seeded statement-ingest list is honestly empty — the seed ingests no statements', async () => {
    await expect(seeded.listStatementIngests()).resolves.toEqual([]);
  });

  it('the seeded audit log is honestly empty — no console mutation runs in the seed', async () => {
    await expect(seeded.listAdminActions()).resolves.toEqual([]);
  });
});
