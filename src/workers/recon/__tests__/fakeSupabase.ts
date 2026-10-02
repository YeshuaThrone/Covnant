/**
 * Shared behavioral PostgREST fake for the recon parity suites — the
 * builder vocabulary SupabaseStore uses on the claim/parse/write/post path
 * (from/insert/update/select/eq/in/order/limit/maybeSingle), the
 * match_queue.event_id unique violation, and the migration-0011 claim RPC
 * (`claim_royalty_recon_job`) as a behavioral shim mirroring the local
 * stores' claim semantics (earliest claimable, attempts increment).
 *
 * Extracted from postingParity.test.ts (PR #89's suite) so the podcast
 * lane's parity suite (PR 10) proves backend parity against the SAME fake
 * rather than a drifted copy.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { RECON_STALE_CLAIM_MS } from "@/lib/server/store";
import { SupabaseStore } from "@/lib/server/supabaseStore";

export type Row = Record<string, unknown>;

export interface FakeDbError {
  message: string;
  code: string;
}

export const UNIQUE_VIOLATION: FakeDbError = {
  message: 'duplicate key value violates unique constraint "match_queue_event_id_key"',
  code: "23505",
};

/**
 * The columns with a UNIQUE constraint on this path (migrations 0007,
 * 0017). Each entry is a GROUP of columns — a composite primary key's
 * columns are one group (all must match for a violation); single-column
 * constraints are a group of one.
 */
export const UNIQUE_COLUMNS: Record<string, string[][]> = {
  match_queue: [["event_id"]],
  podcast_episode_split_schedules: [["episode_id"]],
  podcast_episode_split_accruals: [["source_event_id"]],
  podcast_guest_bonus_definitions: [
    ["episode_id", "guest_payee_id", "milestone_kind", "threshold"],
  ],
  podcast_guest_bonus_accruals: [["event_id"]],
  // Gaming lane (migration 0018): one accumulator contribution per queue
  // event, one schedule per item, one payout routing per funding event.
  gaming_engine_royalty_events: [["event_id"]],
  gaming_item_split_schedules: [["item_id"]],
  gaming_split_payouts: [["source_event_id"]],
  // AI dispute freeze + payout gates + dataset deprecations (migration
  // 0029): the dispute of record per model+version+payee, one gate state
  // per payee, one deprecation per model+version, and the archives that
  // converge per deprecation+ledger row.
  ai_training_disputes: [
    ["ai_model_id", "dataset_version", "rights_holder_payee_id"],
  ],
  ai_payout_gate_states: [["payee_id"]],
  ai_dataset_deprecations: [["ai_model_id", "dataset_version"]],
  ai_dataset_allocation_archives: [["deprecation_id", "ledger_transaction_id"]],
};

export class FakeTable {
  private rows: Row[] = [];
  private nextInsertionOrder = 1;

  /** The real tables carry the generated insertion_order identity column. */
  insert(row: Row): Row {
    const stored = { insertion_order: this.nextInsertionOrder++, ...row };
    this.rows.push(stored);
    return stored;
  }

  isUniqueViolation(row: Row, columnGroups: string[][]): boolean {
    return this.rows.some((existing) =>
      columnGroups.some((group) =>
        group.every(
          (column) =>
            row[column] !== undefined && existing[column] === row[column],
        ),
      ),
    );
  }

  /**
   * PostgREST upsert (onConflict): the matching row is patched in place;
   * no match inserts. Returns the upserted row.
   */
  upsert(row: Row, conflictColumns: string[]): Row {
    for (let i = 0; i < this.rows.length; i++) {
      if (
        conflictColumns.length > 0 &&
        conflictColumns.every((column) => this.rows[i][column] === row[column])
      ) {
        this.rows[i] = { ...this.rows[i], ...row };
        return { ...this.rows[i] };
      }
    }
    return this.insert(row);
  }

  select(): Row[] {
    return this.rows.map((row) => ({ ...row }));
  }

  /**
   * PostgREST UPDATE ... RETURNING — patches every matching row and
   * returns the UPDATED representations. The status-flip CAS sweeps
   * (0029) depend on this: the filters that SELECTED the rows no longer
   * match them after the patch, so a re-select would lose them (the
   * real PostgREST returns the rows updated by the original filters).
   */
  updateReturning(patch: Row, filters: Array<[string, unknown]>): Row[] {
    const updated: Row[] = [];
    for (let i = 0; i < this.rows.length; i++) {
      if (matchesRow(this.rows[i], filters)) {
        this.rows[i] = { ...this.rows[i], ...patch };
        updated.push({ ...this.rows[i] });
      }
    }
    return updated;
  }

  /** PostgREST-style delete — removes every matching row in place. */
  deleteRows(filters: Array<[string, unknown]>): number {
    let removed = 0;
    for (let i = this.rows.length - 1; i >= 0; i--) {
      if (matchesRow(this.rows[i], filters)) {
        this.rows.splice(i, 1);
        removed++;
      }
    }
    return removed;
  }

  /** In-place claim transition for the rpc shim — the row keeps its identity. */
  claimFirst(nowIso: string, engine: unknown): Row | null {
    const staleCutoff = new Date(
      new Date(nowIso).getTime() - RECON_STALE_CLAIM_MS,
    ).toISOString();
    const claimable = this.rows
      .filter(
        (row) =>
          row.status === "pending" ||
          (row.status === "processing" &&
            typeof row.claimed_at === "string" &&
            row.claimed_at < staleCutoff),
      )
      .sort((a, b) => {
        const av = String(a.created_at);
        const bv = String(b.created_at);
        return av < bv ? -1 : av > bv ? 1 : 0;
      });
    const best = claimable[0];
    if (best === undefined) return null;
    const claimed = {
      ...best,
      status: "processing",
      engine: engine ?? null,
      claimed_at: nowIso,
      started_at: (best.started_at as string | null) ?? nowIso,
      attempts: Number(best.attempts) + 1,
      updated_at: nowIso,
    };
    Object.assign(best, claimed);
    return { ...best };
  }
}

/** eq filters compare equality; an array value is an `.in()` membership set. */
function matchesRow(row: Row, filters: Array<[string, unknown]>): boolean {
  return filters.every(([column, value]) =>
    Array.isArray(value) ? value.includes(row[column]) : row[column] === value,
  );
}

export interface FakeResult {
  data: unknown;
  error: FakeDbError | null;
}

class FakeQueryBuilder {
  private filters: Array<[string, unknown]> = [];
  private orders: Array<[string, boolean]> = [];
  private limitCount: number | null = null;
  private single = false;
  private operation:
    | { kind: "insert"; row: Row }
    | { kind: "upsert"; row: Row; onConflict: string | null }
    | { kind: "update"; patch: Row }
    | { kind: "delete" }
    | { kind: "select" } = { kind: "select" };

  constructor(
    private readonly table: FakeTable,
    private readonly tableName: string,
  ) {}

  insert(row: Row): this {
    this.operation = { kind: "insert", row };
    return this;
  }

  upsert(row: Row, options?: { onConflict?: string }): this {
    this.operation = {
      kind: "upsert",
      row,
      onConflict: options?.onConflict ?? null,
    };
    return this;
  }

  update(patch: Row): this {
    this.operation = { kind: "update", patch };
    return this;
  }

  delete(): this {
    this.operation = { kind: "delete" };
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
    this.filters.push([column, values]);
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

  private execute(): FakeResult {
    const op = this.operation;
    if (op.kind === "insert") {
      const uniqueGroups = UNIQUE_COLUMNS[this.tableName] ?? [];
      if (
        uniqueGroups.length > 0 &&
        this.table.isUniqueViolation(op.row, uniqueGroups)
      ) {
        return { data: null, error: UNIQUE_VIOLATION };
      }
      return { data: this.table.insert(op.row), error: null };
    }
    if (op.kind === "upsert") {
      const conflictColumns =
        op.onConflict === null
          ? []
          : op.onConflict
              .split(",")
              .map((column) => column.trim())
              .filter((column) => column !== "");
      const upserted = this.table.upsert(op.row, conflictColumns);
      if (this.single) return { data: upserted, error: null };
      return { data: [upserted], error: null };
    }
    if (op.kind === "delete") {
      this.table.deleteRows(this.filters);
      return { data: [], error: null };
    }
    if (op.kind === "update") {
      const updated = this.table.updateReturning(op.patch, this.filters);
      if (updated.length === 0) return { data: null, error: null };
      if (this.single) return { data: updated[0] ?? null, error: null };
      return { data: updated, error: null };
    }
    const rows = this.table
      .select()
      .filter((row) => matchesRow(row, this.filters));
    for (let i = this.orders.length - 1; i >= 0; i--) {
      const [column, ascending] = this.orders[i];
      rows.sort((a, b) => {
        const av = a[column] as string | number;
        const bv = b[column] as string | number;
        if (av === bv) return 0;
        const cmp = av < bv ? -1 : 1;
        return ascending ? cmp : -cmp;
      });
    }
    const limited = this.limitCount === null ? rows : rows.slice(0, this.limitCount);
    if (this.single) {
      return { data: limited[0] ?? null, error: null };
    }
    return { data: limited, error: null };
  }
}

/** The behavioral SupabaseClient stand-in — the only surface the store touches. */
export class FakeSupabaseClient {
  private tables = new Map<string, FakeTable>();

  private table(name: string): FakeTable {
    let t = this.tables.get(name);
    if (t === undefined) {
      t = new FakeTable();
      this.tables.set(name, t);
    }
    return t;
  }

  from(name: string): FakeQueryBuilder {
    return new FakeQueryBuilder(this.table(name), name);
  }

  /** The migration-0011 claim RPC — the store's ONLY rpc on this path. */
  async rpc(fn: string, args: Record<string, unknown>): Promise<FakeResult> {
    if (fn !== "claim_royalty_recon_job") {
      return {
        data: null,
        error: { message: `fake: rpc ${fn} not implemented`, code: "P0001" },
      };
    }
    const claimed = this.table("royalty_recon_jobs").claimFirst(
      String(args.p_now),
      args.p_engine,
    );
    return { data: claimed, error: null };
  }
}

/** Builds a SupabaseStore over the fake, cast through the real client type. */
export function makeFakeSupabaseStore(): SupabaseStore {
  return new SupabaseStore(new FakeSupabaseClient() as unknown as SupabaseClient);
}
