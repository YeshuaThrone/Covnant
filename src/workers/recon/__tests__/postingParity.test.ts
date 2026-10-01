/**
 * Canonical posting seam — THREE-BACKEND PARITY (the task's locked bar).
 *
 * The identical worker scenario — seed ingest + job, run the posting pass
 * against a matching vault, replay it — runs against InMemoryStore,
 * SqliteStore (real better-sqlite3, :memory:), and SupabaseStore over a
 * behavioral PostgREST fake, and every backend must produce the same
 * observable outcome: the same completion counts, the same held credits
 * (sentinel payee, exact integer cents, per-event line-item linkage), the
 * same one-journal-per-source replay-guard state, and the same open queue
 * rows. The posting seam rides only Store-interface methods, so parity is
 * the PROOF that no backend drifts.
 *
 * The fake implements the builder vocabulary SupabaseStore uses on this
 * path (from/insert/update/select/eq/in/order/limit/maybeSingle), the
 * match_queue.event_id unique violation, and the migration-0011 claim RPC
 * (`claim_royalty_recon_job`) as a behavioral shim mirroring the local
 * stores' claim semantics (earliest claimable, attempts increment).
 */
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { InMemoryStore } from "@/lib/server/inMemoryStore";
import { SqliteStore } from "@/lib/server/sqliteStore";
import { SupabaseStore } from "@/lib/server/supabaseStore";
import { RECON_STALE_CLAIM_MS, type Store } from "@/lib/server/store";
import type { ReconJobResult } from "@/modules/recon/records";
import { runOnce } from "../worker";
import type { VaultLookup } from "../matchQueue";

import { loadFixture } from "./fixtures";

type Row = Record<string, unknown>;

interface FakeDbError {
  message: string;
  code: string;
}

const UNIQUE_VIOLATION: FakeDbError = {
  message: 'duplicate key value violates unique constraint "match_queue_event_id_key"',
  code: "23505",
};

/** The columns with a UNIQUE constraint on this path (migration 0007). */
const UNIQUE_COLUMNS: Record<string, string[]> = {
  match_queue: ["event_id"],
};

class FakeTable {
  private rows: Row[] = [];
  private nextInsertionOrder = 1;

  /** The real tables carry the generated insertion_order identity column. */
  insert(row: Row): Row {
    const stored = { insertion_order: this.nextInsertionOrder++, ...row };
    this.rows.push(stored);
    return stored;
  }

  isUniqueViolation(row: Row): boolean {
    return this.rows.some(
      (existing) =>
        row.event_id !== undefined &&
        existing.event_id === row.event_id,
    );
  }

  select(): Row[] {
    return this.rows.map((row) => ({ ...row }));
  }

  update(patch: Row, filters: Array<[string, unknown]>): number {
    let changed = 0;
    for (let i = 0; i < this.rows.length; i++) {
      if (matchesRow(this.rows[i], filters)) {
        this.rows[i] = { ...this.rows[i], ...patch };
        changed++;
      }
    }
    return changed;
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
    | { kind: "insert"; row: Row }
    | { kind: "update"; patch: Row }
    | { kind: "select" } = { kind: "select" };

  constructor(
    private readonly table: FakeTable,
    private readonly tableName: string,
  ) {}

  insert(row: Row): this {
    this.operation = { kind: "insert", row };
    return this;
  }

  update(patch: Row): this {
    this.operation = { kind: "update", patch };
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
      if (
        (UNIQUE_COLUMNS[this.tableName] ?? []).includes("event_id") &&
        this.table.isUniqueViolation(op.row)
      ) {
        return { data: null, error: UNIQUE_VIOLATION };
      }
      return { data: this.table.insert(op.row), error: null };
    }
    if (op.kind === "update") {
      const changed = this.table.update(op.patch, this.filters);
      if (changed === 0) return { data: null, error: null };
      // Fall through: select returns the updated rows below.
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

class FakeSupabaseClient {
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

// ---------------------------------------------------------------------------
// Backend registry + the shared scenario.
// ---------------------------------------------------------------------------

const BACKENDS = [
  { name: "InMemoryStore", make: () => new InMemoryStore() },
  { name: "SqliteStore", make: () => new SqliteStore(":memory:") },
  {
    // The fake implements the builder subset this path touches; the real
    // SupabaseClient surface is far larger than the store uses.
    name: "SupabaseStore",
    make: () => new SupabaseStore(new FakeSupabaseClient() as unknown as SupabaseClient),
  },
] as const;

const NOW = () => new Date("2026-09-30T12:00:00Z");

function vaultWithIsrc(): VaultLookup {
  return {
    async findByIdentifier(kind, value) {
      if (kind === "ISRC" && (value === "US-XYT-26-00001" || value === "USXYT2600001")) {
        return {
          cvtCode: "CVT-TEST-TRACK",
          cbtCode: "CBT-MUS-TESTTRACK",
          title: "Neon Skyline",
          medium: "music",
          externalIdentifiers: { ISRC: value },
          holderUct: null,
        };
      }
      return null;
    },
  };
}

interface ScenarioOutcome {
  counts: ReconJobResult | null | undefined;
  replayCounts: ReconJobResult | null | undefined;
  /** Held credits projected to the parity-comparable shape (ids stripped). */
  held: Array<{
    line_item_id: string;
    payee_id: string;
    amount_cents: number;
    currency: string;
    kind: string;
    status: string;
  }>;
  replayHeldLength: number;
  journals: number;
  openQueueRows: Array<{ event_id: string; matched_cbt_code: string | null; status: string }>;
}

/** The identical scenario script every backend must run to the same result. */
async function postingScenario(store: Store): Promise<ScenarioOutcome> {
  const ingest = await store.insertStatementIngest({
    format: "csv_statement",
    source: "statement",
    file_name: "distrokid.csv",
    content: loadFixture("distrokid.csv"),
    status: "parsed",
    event_count: null,
    error: null,
    created_at: NOW().toISOString(),
  });
  await store.createReconJob({ source: "statement", ingest_id: ingest.id });

  const processed = await runOnce({ store, vault: vaultWithIsrc(), now: NOW });
  const held = (await store.listUnclaimedHoldingCredits(100)).map((row) => ({
    // Normalize the per-backend random ingest id out of the linkage.
    line_item_id: row.line_item_id.replace(ingest.id, "<ingest-id>"),
    payee_id: row.payee_id,
    amount_cents: row.amount_cents,
    currency: row.currency,
    kind: row.kind,
    status: row.status,
  }));
  const journals = await store.listGlJournalsByRef("match_queue", `recon:${ingest.id}:line:1`);

  // The replay pass — the per-source guard must read the same on every
  // backend: counted no-ops, no new credits.
  await store.createReconJob({ source: "statement", ingest_id: ingest.id });
  const replay = await runOnce({ store, vault: vaultWithIsrc(), now: NOW });
  const replayHeldLength = (await store.listUnclaimedHoldingCredits(100)).length;

  const openQueueRows = (await store.listMatchQueueEntries("open", 500))
    .filter((row) => row.event_id.startsWith(`recon:${ingest.id}:`))
    .map((row) => ({
      event_id: row.event_id.replace(ingest.id, "<ingest-id>"),
      matched_cbt_code: row.matched_cbt_code,
      status: row.status,
    }))
    // List ordering (created_at desc) is a per-backend presentation detail —
    // compare the SET of rows, not the read order.
    .sort((a, b) => a.event_id.localeCompare(b.event_id));

  return {
    counts: processed?.job.result,
    replayCounts: replay?.job.result,
    held: held.sort((a, b) => a.line_item_id.localeCompare(b.line_item_id)),
    replayHeldLength,
    journals: journals.length,
    openQueueRows,
  };
}

const EXPECTED: ScenarioOutcome = {
  counts: {
    events_written: 2,
    matched: 2,
    unmatched: 0,
    engine_used: null,
    holding_posted: 2,
    holding_replayed: 0,
  },
  replayCounts: {
    events_written: 0,
    matched: 0,
    unmatched: 0,
    engine_used: null,
    holding_posted: 0,
    holding_replayed: 2,
  },
  held: [
    {
      line_item_id: "recon:<ingest-id>:line:1",
      payee_id: "unclaimed",
      amount_cents: 431,
      currency: "USD",
      kind: "unclaimed_holding",
      status: "unclaimed_holding",
    },
    {
      line_item_id: "recon:<ingest-id>:line:2",
      payee_id: "unclaimed",
      amount_cents: 140,
      currency: "USD",
      kind: "unclaimed_holding",
      status: "unclaimed_holding",
    },
  ],
  replayHeldLength: 2,
  journals: 1,
  openQueueRows: [
    { event_id: "recon:<ingest-id>:line:1", matched_cbt_code: "CBT-MUS-TESTTRACK", status: "open" },
    { event_id: "recon:<ingest-id>:line:2", matched_cbt_code: "CBT-MUS-TESTTRACK", status: "open" },
  ],
};

describe.each(BACKENDS)("canonical posting parity — $name", ({ make }) => {
  it("runs the posting + replay scenario to the exact same observable outcome", async () => {
    const outcome = await postingScenario(make());
    expect(outcome).toEqual(EXPECTED);
  });
});
