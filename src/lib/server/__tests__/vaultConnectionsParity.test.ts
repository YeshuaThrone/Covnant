/**
 * Three-backend parity for the UCT credential vault (migration 0013,
 * PR 5) — the same connect/status/disconnect scenario script runs against
 * InMemoryStore, SqliteStore (real better-sqlite3, :memory:), and
 * SupabaseStore over a behavioral PostgREST fake, so the vault's contract
 * cannot fork per backend:
 *
 *   - a connect inserts an ACTIVE row carrying the caller's ciphertexts;
 *   - reconnecting while active ROTATES the ciphertexts in place — same
 *     row, same created_at (tenure), fresh updated_at;
 *   - after a disconnect, reconnecting inserts a FRESH active row
 *     (rotation never resurrects a disconnected row);
 *   - the list is holder-scoped and newest-first;
 *   - the point lookup is holder-scoped: a foreign holder's id is
 *     indistinguishable from an unknown id (undefined);
 *   - disconnect flips status to 'disconnected' and KEEPS the ciphertexts
 *     (the holder's history is theirs), is idempotent (replay no-op), and
 *     a foreign id mutates nothing.
 *
 * The fake implements the builder vocabulary the vault methods use
 * (from/insert/update/select/eq/order/maybeSingle) with PostgREST's
 * update-returns-updated-rows semantics.
 */
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { InMemoryStore } from '@/lib/server/inMemoryStore';
import { SqliteStore } from '@/lib/server/sqliteStore';
import { SupabaseStore } from '@/lib/server/supabaseStore';
import type { Store } from '@/lib/server/store';
import type { DistributorConnectionInput } from '@/modules/vault/records';

// ---------------------------------------------------------------------------
// The behavioral PostgREST fake — chainable builder resolved at await.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

class FakeTable {
  private rows: Row[] = [];
  private sequence = 0;

  /** The insertion_order bigserial the real table generates. */
  insert(row: Row): Row {
    this.sequence += 1;
    const stored = { ...row, insertion_order: this.sequence };
    this.rows.push(stored);
    return { ...stored };
  }

  select(): Row[] {
    return this.rows.map((row) => ({ ...row }));
  }

  update(patch: Row, filters: Array<[string, unknown]>): Row[] {
    const updated: Row[] = [];
    for (const row of this.rows) {
      const eqOk = filters.every(([column, value]) => row[column] === value);
      if (eqOk) {
        Object.assign(row, patch);
        updated.push({ ...row });
      }
    }
    return updated;
  }

  all(): Row[] {
    return this.rows;
  }
}

interface FakeResult {
  data: unknown;
  error: { message: string; code: string } | null;
}

class FakeQueryBuilder {
  private filters: Array<[string, unknown]> = [];
  private orderDesc: string | null = null;
  private single = false;
  private operation:
    | { kind: 'insert'; row: Row }
    | { kind: 'update'; patch: Row }
    | { kind: 'select' } = { kind: 'select' };

  constructor(private readonly table: FakeTable) {}

  insert(row: Row): this {
    this.operation = { kind: 'insert', row };
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
    if (options?.ascending === false) this.orderDesc = column;
    return this;
  }

  maybeSingle(): this {
    this.single = true;
    return this;
  }

  then<TResult1 = FakeResult, TResult2 = never>(
    onFulfilled?: (value: FakeResult) => TResult1,
    onRejected?: (reason: unknown) => TResult2,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(this.execute()).then(onFulfilled, onRejected);
  }

  private matches(row: Row): boolean {
    return this.filters.every(([column, value]) => row[column] === value);
  }

  private execute(): FakeResult {
    const op = this.operation;
    if (op.kind === 'insert') {
      return { data: this.table.insert(op.row), error: null };
    }
    if (op.kind === 'update') {
      // PostgREST semantics: the updated rows come back; an empty result
      // (no row matched the guard filters) surfaces as data:null.
      const updated = this.table.update(op.patch, this.filters);
      if (updated.length === 0) return { data: null, error: null };
      if (this.single) return { data: updated[0] ?? null, error: null };
      return { data: updated, error: null };
    }
    const rows = this.table
      .select()
      .filter((row) => this.matches(row))
      .sort((a, b) =>
        this.orderDesc === null
          ? 0
          : Number(b[this.orderDesc] as number) - Number(a[this.orderDesc] as number),
      );
    if (this.single) return { data: rows[0] ?? null, error: null };
    return { data: rows, error: null };
  }
}

class FakeSupabaseClient {
  private tables = new Map<string, FakeTable>();

  from(table: string): FakeQueryBuilder {
    let t = this.tables.get(table);
    if (t === undefined) {
      t = new FakeTable();
      this.tables.set(table, t);
    }
    return new FakeQueryBuilder(t);
  }
}

// ---------------------------------------------------------------------------
// Backend registry + the shared scenario script.
// ---------------------------------------------------------------------------

interface BackendSpec {
  name: string;
  make: () => Store;
}

const BACKENDS: BackendSpec[] = [
  { name: 'InMemoryStore', make: () => new InMemoryStore() },
  { name: 'SqliteStore', make: () => new SqliteStore(':memory:') },
  {
    // The fake implements the builder subset the vault methods use; the
    // real SupabaseClient surface is far larger than the store touches.
    name: 'SupabaseStore',
    make: () => new SupabaseStore(new FakeSupabaseClient() as unknown as SupabaseClient),
  },
];

const HOLDER_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const HOLDER_B = 'bbbbbbbb-2222-4222-8222-222222222222';

function connectInput(
  holderId: string,
  distributor: DistributorConnectionInput['distributor'] = 'distrokid',
  username = 'artist@distrokid.com',
): DistributorConnectionInput {
  return {
    holder_id: holderId,
    distributor,
    // Pre-encrypted by the route (the Plaid token precedent) — the store
    // persists ciphertexts verbatim.
    username_encrypted: `enc:v1:iv-${holderId.slice(0, 4)}-${username.length}.tag.cipher`,
    password_encrypted: 'enc:v1:iv-pw.tag.cipher',
  };
}

describe('distributor credential vault — three-backend parity (migration 0013)', () => {
  for (const backend of BACKENDS) {
    describe(backend.name, () => {
      it('connects a distributor: one ACTIVE row with the holder-scoped ciphertexts', async () => {
        const store = backend.make();
        const upsert = await store.createDistributorConnection(connectInput(HOLDER_A));
        const record = upsert.connection;
        expect(upsert.rotated).toBe(false); // a first connect INSERTS, never rotates
        expect(record.holder_id).toBe(HOLDER_A);
        expect(record.distributor).toBe('distrokid');
        expect(record.status).toBe('connected');
        expect(record.username_encrypted).toBe(
          `enc:v1:iv-${HOLDER_A.slice(0, 4)}-20.tag.cipher`,
        );
        expect(record.last_verified_at).toBeNull();
        expect(record.last_error).toBeNull();
      });

      it('rotates in place on reconnect while active — same row and tenure, new ciphertexts', async () => {
        const store = backend.make();
        const first = await store.createDistributorConnection(connectInput(HOLDER_A));
        await new Promise((resolve) => setTimeout(resolve, 5)); // separate the timestamps
        const rotatedUsername = 'rotated@distrokid.com';
        const second = await store.createDistributorConnection(
          connectInput(HOLDER_A, 'distrokid', rotatedUsername),
        );
        expect(second.rotated).toBe(true); // the store's own account of the outcome
        const record = second.connection;
        expect(record.id).toBe(first.connection.id);
        expect(record.created_at).toBe(first.connection.created_at);
        expect(record.updated_at >= first.connection.updated_at).toBe(true);
        expect(record.username_encrypted).toBe(
          `enc:v1:iv-${HOLDER_A.slice(0, 4)}-${rotatedUsername.length}.tag.cipher`,
        );
        // Still exactly one row for the pair.
        const rows = await store.listDistributorConnections(HOLDER_A);
        expect(rows).toHaveLength(1);
      });

      it('keeps active rows independent per distributor and per holder', async () => {
        const store = backend.make();
        await store.createDistributorConnection(connectInput(HOLDER_A, 'distrokid'));
        await store.createDistributorConnection(connectInput(HOLDER_A, 'ascap'));
        await store.createDistributorConnection(connectInput(HOLDER_B, 'distrokid'));
        expect(await store.listDistributorConnections(HOLDER_A)).toHaveLength(2);
        expect(await store.listDistributorConnections(HOLDER_B)).toHaveLength(1);
      });

      it('inserts a FRESH row on reconnect after disconnect — rotation never resurrects', async () => {
        const store = backend.make();
        const first = await store.createDistributorConnection(connectInput(HOLDER_A));
        await store.disconnectDistributorConnection(HOLDER_A, first.connection.id);
        const second = await store.createDistributorConnection(connectInput(HOLDER_A));
        expect(second.rotated).toBe(false); // the disconnected row doesn't resurrect
        expect(second.connection.id).not.toBe(first.connection.id);
        expect(second.connection.status).toBe('connected');
        // Both rows survive: the disconnected one (history) + the new one.
        const rows = await store.listDistributorConnections(HOLDER_A);
        expect(rows).toHaveLength(2);
        expect(rows.map((row) => row.status).sort()).toEqual(['connected', 'disconnected']);
      });

      it('lists holder-scoped and newest-first', async () => {
        const store = backend.make();
        await store.createDistributorConnection(connectInput(HOLDER_A, 'distrokid'));
        await store.createDistributorConnection(connectInput(HOLDER_A, 'tunecore'));
        await store.createDistributorConnection(connectInput(HOLDER_A, 'ascap'));
        const rows = await store.listDistributorConnections(HOLDER_A);
        expect(rows.map((row) => row.distributor)).toEqual(['ascap', 'tunecore', 'distrokid']);
      });

      it('scoping the point lookup by holder: a foreign id is just unknown', async () => {
        const store = backend.make();
        const seeded = await store.createDistributorConnection(connectInput(HOLDER_A));
        expect(await store.getDistributorConnection(HOLDER_B, seeded.connection.id)).toBeUndefined();
        expect(await store.getDistributorConnection(HOLDER_A, seeded.connection.id)).toBeDefined();
      });

      it('disconnects: status flips, ciphertexts are KEPT, and it is a replay no-op', async () => {
        const store = backend.make();
        const seeded = await store.createDistributorConnection(connectInput(HOLDER_A));
        const record = seeded.connection;
        const disconnected = await store.disconnectDistributorConnection(HOLDER_A, record.id);
        expect(disconnected?.status).toBe('disconnected');
        expect(disconnected?.username_encrypted).toBe(record.username_encrypted);
        expect(disconnected?.password_encrypted).toBe(record.password_encrypted);
        // Replay — the row is untouched the second time.
        const replay = await store.disconnectDistributorConnection(HOLDER_A, record.id);
        expect(replay?.status).toBe('disconnected');
        expect(replay?.id).toBe(record.id);
        expect(replay?.updated_at).toBe(disconnected?.updated_at);
      });

      it('a foreign disconnect mutates nothing — same undefined an unknown id gets', async () => {
        const store = backend.make();
        const seeded = await store.createDistributorConnection(connectInput(HOLDER_A));
        expect(
          await store.disconnectDistributorConnection(HOLDER_B, seeded.connection.id),
        ).toBeUndefined();
        const untouched = await store.getDistributorConnection(HOLDER_A, seeded.connection.id);
        expect(untouched?.status).toBe('connected');
      });
    });
  }
});
