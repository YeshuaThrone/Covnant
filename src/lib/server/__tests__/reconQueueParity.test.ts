/**
 * Three-backend parity for the recon job queue (migration 0011, spec
 * art_7M0snhxc, verification row 4) — the same claim/complete/fail scenario
 * script runs against InMemoryStore, SqliteStore (real better-sqlite3,
 * :memory:), and SupabaseStore over a behavioral PostgREST fake, so the
 * queue's concurrency semantics cannot fork per backend:
 *
 *   - two sequential claims take DIFFERENT jobs (claim exclusivity);
 *   - the oldest claimable job wins (created_at with insertion-order
 *     tiebreak) — the CVT lane is FIFO;
 *   - a processing claim older than the 30-minute stale threshold is
 *     re-claimable (injectable clock — crashed-worker recovery is a
 *     property of the claim, not a sweeper process);
 *   - a FRESH processing claim is never stolen (the exclusivity contract);
 *   - failReconJob re-pools under the retry budget (attempts < 3) and makes
 *     failure TERMINAL at the cap — honest failure, not infinite retry;
 *   - completeReconJob on a terminal row is a replay no-op.
 *
 * The fake client implements the builder vocabulary SupabaseStore uses for
 * this table (from/insert/update/select/eq/in/order/limit/maybeSingle)
 * plus the migration's claim_royalty_recon_job RPC — enough to exercise
 * the store's real code paths against the queue's contract.
 */
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { InMemoryStore } from '@/lib/server/inMemoryStore';
import { SqliteStore } from '@/lib/server/sqliteStore';
import { SupabaseStore } from '@/lib/server/supabaseStore';
import type { Store } from '@/lib/server/store';
import type { ReconJobResult } from '@/modules/recon/records';

// ---------------------------------------------------------------------------
// The behavioral PostgREST fake — chainable builder resolved at await.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

class FakeTable {
  private rows: Row[] = [];

  insert(row: Row): Row {
    this.rows.push({ ...row });
    return { ...row };
  }

  select(): Row[] {
    return this.rows.map((row) => ({ ...row }));
  }

  update(
    patch: Row,
    filters: Array<[string, unknown]>,
    inFilters: Array<[string, unknown[]]>,
  ): Row[] {
    const updated: Row[] = [];
    for (const row of this.rows) {
      const eqOk = filters.every(([column, value]) => row[column] === value);
      const inOk = inFilters.every(([column, values]) =>
        values.includes(row[column] as string | number | boolean),
      );
      if (eqOk && inOk) {
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
  private inFilters: Array<[string, unknown[]]> = [];
  private limitCount: number | null = null;
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

  in(column: string, values: unknown[]): this {
    this.inFilters.push([column, values]);
    return this;
  }

  order(): this {
    return this; // the recon table's reads are point lookups or the RPC's ordering
  }

  limit(count: number): this {
    this.limitCount = count;
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
    const eqOk = this.filters.every(([column, value]) => row[column] === value);
    const inOk = this.inFilters.every(([column, values]) =>
      values.includes(row[column] as string | number | boolean),
    );
    return eqOk && inOk;
  }

  private execute(): FakeResult {
    const op = this.operation;
    if (op.kind === 'insert') {
      return { data: this.table.insert(op.row), error: null };
    }
    if (op.kind === 'update') {
      // PostgREST semantics: `.update(patch).eq(...).in(...).select()` returns
      // the UPDATED rows — the WHERE clause picked the targets and is NOT
      // re-applied to the returning snapshot (which already carries the new
      // status). An empty result means the guarded transition matched nothing
      // — the row was moved by a concurrent writer — surfacing as data:null.
      const updated = this.table.update(op.patch, this.filters, this.inFilters);
      if (updated.length === 0) return { data: null, error: null };
      if (this.single) return { data: updated[0] ?? null, error: null };
      return { data: updated, error: null };
    }
    const rows = this.table.select().filter((row) => this.matches(row));
    const limited = this.limitCount === null ? rows : rows.slice(0, this.limitCount);
    if (this.single) {
      return { data: limited[0] ?? null, error: null };
    }
    return { data: limited, error: null };
  }
}

/**
 * The claim_royalty_recon_job RPC's behavioral fake: the oldest claimable
 * row (pending, or processing with a stale claim) is transitioned to
 * processing with the attempts increment — the migration's single atomic
 * UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1).
 */
function fakeClaimRpc(
  table: FakeTable,
  params: { p_now: string; p_engine: string | null },
): FakeResult {
  const nowMs = Date.parse(params.p_now);
  const staleCutoffMs = nowMs - 30 * 60 * 1000;
  const rows = table.all();
  let best: Row | null = null;
  for (const row of rows) {
    const claimable =
      row.status === 'pending' ||
      (row.status === 'processing' &&
        typeof row.claimed_at === 'string' &&
        Date.parse(row.claimed_at) < staleCutoffMs);
    if (!claimable) continue;
    if (best === null || (row.created_at as string) < (best.created_at as string)) best = row;
  }
  if (best === null) return { data: null, error: null };
  Object.assign(best, {
    status: 'processing',
    engine: params.p_engine,
    claimed_at: params.p_now,
    started_at: (best.started_at as string | null) ?? params.p_now,
    attempts: ((best.attempts as number) ?? 0) + 1,
    updated_at: params.p_now,
  });
  return { data: { ...best }, error: null };
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

  /** The migration's claim RPC, faked behaviorally against the same rows. */
  rpc(fn: string, params: { p_now: string; p_engine: string | null }): FakeResult {
    if (fn !== 'claim_royalty_recon_job') {
      return { data: null, error: { message: `unknown rpc ${fn}`, code: '404' } };
    }
    const table = this.tables.get('royalty_recon_jobs');
    if (table === undefined) return { data: null, error: null };
    return fakeClaimRpc(table, params);
  }
}

// ---------------------------------------------------------------------------
// Backend registry + the shared scenario script.
// ---------------------------------------------------------------------------

const RESULT: ReconJobResult = { events_written: 5, matched: 4, unmatched: 1, engine_used: null };

interface BackendSpec {
  name: string;
  make: () => Store;
}

const BACKENDS: BackendSpec[] = [
  { name: 'InMemoryStore', make: () => new InMemoryStore() },
  { name: 'SqliteStore', make: () => new SqliteStore(':memory:') },
  {
    // The fake implements the builder subset + the claim RPC this table uses;
    // the real SupabaseClient surface is far larger than the store touches.
    name: 'SupabaseStore',
    make: () => new SupabaseStore(new FakeSupabaseClient() as unknown as SupabaseClient),
  },
];

describe('recon job queue — three-backend parity (verification row 4)', () => {
  for (const backend of BACKENDS) {
    describe(backend.name, () => {
      it('claims exclusively: two sequential claims take different jobs, oldest first', async () => {
        const store = backend.make();
        const first = await store.createReconJob({ source: 'statement', requested_by: 'a' });
        const second = await store.createReconJob({ source: 'manual', requested_by: 'b' });
        const claimA = await store.claimReconJob(new Date('2026-09-30T12:00:00Z'));
        const claimB = await store.claimReconJob(new Date('2026-09-30T12:00:01Z'));
        expect(claimA?.id).toBe(first.id);
        expect(claimB?.id).toBe(second.id);
        expect(claimA?.attempts).toBe(1);
        expect(claimB?.attempts).toBe(1);
      });

      it('returns undefined when the pool is empty', async () => {
        const store = backend.make();
        expect(await store.claimReconJob(new Date('2026-09-30T12:00:00Z'))).toBeUndefined();
      });

      it('recovers a crashed worker: a stale processing claim is re-claimable after 30 minutes', async () => {
        const store = backend.make();
        const job = await store.createReconJob({ source: 'statement' });
        await store.claimReconJob(new Date('2026-09-30T12:00:00Z'));
        // 29 minutes later: still held — a live worker owns it.
        const fresh = await store.claimReconJob(new Date('2026-09-30T12:29:00Z'));
        expect(fresh).toBeUndefined();
        // 31 minutes after the claim: the crash window has passed.
        const recovered = await store.claimReconJob(new Date('2026-09-30T12:31:00Z'));
        expect(recovered?.id).toBe(job.id);
        expect(recovered?.attempts).toBe(2);
        // First-claim provenance survives stale-claim recovery.
        expect(recovered?.started_at).toBe('2026-09-30T12:00:00.000Z');
      });

      it('completes an active job with the worker result and marks completed_at', async () => {
        const store = backend.make();
        const job = await store.createReconJob({ source: 'statement' });
        await store.claimReconJob(new Date('2026-09-30T12:00:00Z'));
        const done = await store.completeReconJob(job.id, RESULT);
        expect(done?.status).toBe('completed');
        expect(done?.result).toEqual(RESULT);
        expect(done?.completed_at).not.toBeNull();
        // Terminal rows are authoritative — a second completion is a replay.
        const replay = await store.completeReconJob(job.id, {
          ...RESULT,
          events_written: 999,
        });
        expect(replay?.result?.events_written).toBe(5);
      });

      it('re-pools a failed active job under the retry budget and marks failure terminal at the cap', async () => {
        const store = backend.make();
        const job = await store.createReconJob({ source: 'statement' });
        // Claim → fail ×3: attempts 1 and 2 re-pool, the third is terminal.
        for (const minute of [0, 1, 2]) {
          await store.claimReconJob(new Date(`2026-09-30T12:0${minute}:00Z`));
          const failed = await store.failReconJob(job.id, 'deterministic parse error');
          if (minute < 2) {
            expect(failed?.status).toBe('pending');
            expect(failed?.error).toBe('deterministic parse error');
          } else {
            expect(failed?.status).toBe('failed');
            expect(failed?.completed_at).not.toBeNull();
          }
        }
        // A terminal row never re-enters the pool.
        expect(await store.claimReconJob(new Date('2026-09-30T12:10:00Z'))).toBeUndefined();
      });

      it('fails a never-claimed job honestly into the pool, not the terminal state', async () => {
        const store = backend.make();
        const job = await store.createReconJob({ source: 'statement' });
        const failed = await store.failReconJob(job.id, 'worker reported without claiming');
        expect(failed?.status).toBe('pending');
        expect(failed?.error).toBe('worker reported without claiming');
        void job;
      });
    });
  }
});
