// Estate succession + multi-heir splitting (PR 29, migration 0033) —
// three-backend parity for the new store methods, mirroring the
// merch-returns-reserve parity pattern: the same scenario script runs on
// InMemoryStore, SqliteStore (:memory:), and SupabaseStore over a
// behavioral PostgREST fake.
//
// Under test: the certificate-of-record upsert/get (identity preserved
// across re-validation), the verified-certificate read, the per-certificate
// probate schedule upsert (version increments, identity kept), the
// append-only transition ledger with its replay-guard unique
// (certificate_id, source_event_id), the split-accrual ledger with its
// provenance-triple unique (certificate_id, artwork_id, source_event_id),
// and the per-payee payout-gate state upsert/get.

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { InMemoryStore } from "@/lib/server/inMemoryStore";
import { SqliteStore } from "@/lib/server/sqliteStore";
import { SupabaseStore } from "@/lib/server/supabaseStore";
import type { Store } from "@/lib/server/store";
import {
  registerEstateHeirSchedule,
  verifyEstateSuccessionCertificate,
} from "@/lib/server/estateSuccession";

type Row = Record<string, unknown>;

// ---------------------------------------------------------------------------
// The PostgREST fake — the merch parity harness's shape, unchanged.
// ---------------------------------------------------------------------------

type UniqueConstraint = {
  /** Human name, surfaced in the violation message. */
  name: string;
  /** The column tuple that must be unique across rows. */
  columns: string[];
};

class FakeTable {
  private rows: Row[] = [];
  private sequence = 0;

  constructor(private readonly uniques: UniqueConstraint[] = []) {}

  /**
   * Behavioral uniqueness: an insert violating any constraint returns the
   * Postgres unique_violation error shape instead of storing — the exact
   * 23505 surface the store's replay guards detect.
   */
  insert(row: Row): { row: Row | null; error: { message: string; code: string } | null } {
    for (const unique of this.uniques) {
      const key = unique.columns.map((column) => row[column]);
      if (key.every((value) => value !== undefined) &&
          this.rows.some((existing) => unique.columns.every((column) => existing[column] === row[column]))) {
        return {
          row: null,
          error: {
            message: `duplicate key value violates unique constraint ${unique.name}`,
            code: "23505",
          },
        };
      }
    }
    // The generated insertion_order column the real tables carry.
    const stored = { insertion_order: ++this.sequence, ...row };
    this.rows.push(stored);
    return { row: { ...stored }, error: null };
  }

  select(
    filters: Array<[string, unknown]>,
    orders: Array<{ column: string; ascending: boolean }>,
    limit: number | null,
  ): Row[] {
    const matched = this.rows.filter((row) =>
      filters.every(([column, value]) => row[column] === value),
    );
    const sorted = matched.sort((a, b) => {
      for (const spec of orders) {
        const av = a[spec.column] as string | number;
        const bv = b[spec.column] as string | number;
        if (av === bv) continue;
        const cmp = av < bv ? -1 : 1;
        return spec.ascending ? cmp : -cmp;
      }
      return 0;
    });
    return limit === null ? sorted : sorted.slice(0, limit);
  }

  upsert(row: Row, onConflict: string | null): { row: Row; error: null } {
    if (onConflict !== null) {
      const conflictColumns = onConflict.split(",").map((column) => column.trim());
      const index = this.rows.findIndex(
        (existing) =>
          conflictColumns.length > 0 &&
          conflictColumns.every((column) => existing[column] === row[column]),
      );
      if (index >= 0) {
        this.rows[index] = { ...this.rows[index], ...row };
        return { row: { ...this.rows[index] }, error: null };
      }
    }
    const stored = { insertion_order: ++this.sequence, ...row };
    this.rows.push(stored);
    return { row: { ...stored }, error: null };
  }
}

interface FakeResult {
  data: unknown;
  error: { message: string; code: string } | null;
}

class FakeQueryBuilder {
  private filters: Array<[string, unknown]> = [];
  private orders: Array<{ column: string; ascending: boolean }> = [];
  private limitCount: number | null = null;
  private single = false;
  private onConflict: string | null = null;
  private operation:
    | { kind: "insert"; row: Row }
    | { kind: "upsert"; row: Row }
    | { kind: "select" } = { kind: "select" };

  constructor(private readonly table: FakeTable) {}

  insert(row: Row): this {
    this.operation = { kind: "insert", row };
    return this;
  }

  upsert(row: Row, options?: { onConflict?: string }): this {
    this.operation = { kind: "upsert", row };
    this.onConflict = options?.onConflict ?? null;
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
    this.orders.push({ column, ascending: options?.ascending ?? true });
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

  then<TResult1 = FakeResult, TResult2 = never>(
    onFulfilled?: (value: FakeResult) => TResult1,
    onRejected?: (reason: unknown) => TResult2,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(this.execute()).then(onFulfilled, onRejected);
  }

  private execute(): FakeResult {
    const op = this.operation;
    if (op.kind === "insert") {
      const { row, error } = this.table.insert(op.row);
      if (error !== null) return { data: null, error };
      return { data: this.single ? row : [row], error: null };
    }
    if (op.kind === "upsert") {
      const { row, error } = this.table.upsert(op.row, this.onConflict);
      if (error !== null) return { data: null, error };
      return { data: this.single ? row : [row], error: null };
    }
    const rows = this.table.select(this.filters, this.orders, this.limitCount);
    if (this.single) {
      return { data: rows[0] ?? null, error: null };
    }
    return { data: rows, error: null };
  }
}

class FakeSupabaseClient {
  private tables = new Map<string, FakeTable>();

  constructor(
    private readonly uniques: Record<string, UniqueConstraint[]> = {},
  ) {}

  from(table: string): FakeQueryBuilder {
    let t = this.tables.get(table);
    if (t === undefined) {
      t = new FakeTable(this.uniques[table] ?? []);
      this.tables.set(table, t);
    }
    return new FakeQueryBuilder(t);
  }
}

// The unique constraints the real schema enforces — the fake reproduces
// their 23505 behavior so the replay guards exercise end to end.
const FAKE_UNIQUES = {
  estate_succession_certificates: [
    {
      name: "estate_succession_certificates_artist_payee_id_certificate_ref_key",
      columns: ["artist_payee_id", "certificate_ref"],
    },
  ],
  estate_heir_schedules: [
    { name: "estate_heir_schedules_certificate_id_key", columns: ["certificate_id"] },
  ],
  estate_succession_transitions: [
    {
      name: "estate_succession_transitions_certificate_id_source_event_id_key",
      columns: ["certificate_id", "source_event_id"],
    },
  ],
  estate_split_accruals: [
    {
      name: "estate_split_accruals_certificate_id_artwork_id_source_event_id_key",
      columns: ["certificate_id", "artwork_id", "source_event_id"],
    },
  ],
  estate_payout_gate_states: [
    { name: "estate_payout_gate_states_payee_id_key", columns: ["payee_id"] },
  ],
};

// ---------------------------------------------------------------------------
// The shared scenario script.
// ---------------------------------------------------------------------------

const T0 = new Date("2026-10-01T12:00:00.000Z");
const T1 = new Date("2026-10-01T12:00:01.000Z");
const T2 = new Date("2026-10-01T12:00:02.000Z");

const ARTIST = "payee-artist-1";
const ESTATE = "payee-estate-foundation";
const HEIR_SPOUSE = "payee-heir-spouse";
const HEIR_CHILD_A = "payee-heir-child-a";
const HEIR_CHILD_B = "payee-heir-child-b";
const CERT_HASH = "a".repeat(64);

function expectUniqueViolation(error: unknown): void {
  expect(error).toBeInstanceOf(Error);
  // Both backend surfaces the canonical helper detects: the Postgres 23505
  // code (SupabaseStore wraps it into the thrown message) and SQLite's
  // native constraint text.
  const message = (error as Error).message;
  expect(
    message.includes("23505") || message.includes("UNIQUE constraint failed"),
  ).toBe(true);
}

async function scenario(store: Store): Promise<void> {
  // --- The certificate of record: upsert converges per (artist, ref);
  // re-validation keeps the row's identity; an unknown artist reads
  // undefined. ---
  const pending = await verifyEstateSuccessionCertificate(
    store,
    {
      artist_payee_id: ARTIST,
      certificate_ref: "PROBATE-2026-001",
      certificate_hash: CERT_HASH,
      estate_entity_payee_id: ESTATE,
      estate_entity_payee_name: "The Artist Foundation",
      validation_state: "pending",
    },
    T0,
  );
  if ("ok" in pending) throw new Error("pending certificate refused");
  const verified = await verifyEstateSuccessionCertificate(
    store,
    {
      artist_payee_id: ARTIST,
      certificate_ref: "PROBATE-2026-001",
      certificate_hash: CERT_HASH,
      estate_entity_payee_id: ESTATE,
      estate_entity_payee_name: "The Artist Foundation",
      validation_state: "verified",
      verified_by: "operator-founder",
    },
    T1,
  );
  if ("ok" in verified) throw new Error("verified certificate refused");
  expect(verified.id).toBe(pending.id);
  expect(verified.validation_state).toBe("verified");
  expect(verified.verified_by).toBe("operator-founder");
  expect((await store.getEstateSuccessionCertificate(ARTIST, "PROBATE-2026-001"))?.id).toBe(pending.id);
  expect(await store.getEstateSuccessionCertificate(ARTIST, "no-such-ref")).toBeUndefined();
  expect((await store.getEstateSuccessionCertificateById(pending.id))?.validation_state).toBe("verified");
  expect(await store.getEstateSuccessionCertificateById("no-such-id")).toBeUndefined();
  expect((await store.getVerifiedEstateSuccessionCertificate(ARTIST))?.id).toBe(pending.id);
  // An unverified artist has no verified certificate — fail-closed absent.
  expect(await store.getVerifiedEstateSuccessionCertificate("payee-artist-2")).toBeUndefined();

  // --- The probate schedule of record: one row per certificate, versioned
  // on amendment; identity and created_at preserved. ---
  const scheduleV1 = await registerEstateHeirSchedule(
    store,
    {
      certificate_id: verified.id,
      heirs: [
        { heir_payee_id: HEIR_SPOUSE, heir_payee_name: "Spouse", relationship: "spouse", percentage_bps: 5_000 },
        { heir_payee_id: HEIR_CHILD_A, heir_payee_name: "Child A", relationship: "child", percentage_bps: 2_500 },
        { heir_payee_id: HEIR_CHILD_B, heir_payee_name: "Child B", relationship: "child", percentage_bps: 2_500 },
      ],
    },
    T1,
  );
  if ("ok" in scheduleV1) throw new Error("schedule registration refused");
  expect(scheduleV1.version).toBe(1);
  const scheduleV2 = await registerEstateHeirSchedule(
    store,
    {
      certificate_id: verified.id,
      heirs: [
        { heir_payee_id: HEIR_SPOUSE, heir_payee_name: "Spouse", relationship: "spouse", percentage_bps: 6_000 },
        { heir_payee_id: HEIR_CHILD_A, heir_payee_name: "Child A", relationship: "child", percentage_bps: 4_000 },
      ],
    },
    T2,
  );
  if ("ok" in scheduleV2) throw new Error("schedule amendment refused");
  expect(scheduleV2.id).toBe(scheduleV1.id);
  expect(scheduleV2.version).toBe(2);
  expect(scheduleV2.created_at).toBe(scheduleV1.created_at);
  expect((await store.getEstateHeirSchedule(verified.id))?.version).toBe(2);
  expect(await store.getEstateHeirSchedule("no-such-certificate")).toBeUndefined();

  // --- The append-only transition ledger: UNIQUE per (certificate_id,
  // source_event_id) — the replay guard is the 23505, never a double
  // handoff. ---
  await store.insertEstateSuccessionTransition({
    certificate_id: verified.id,
    artist_payee_id: ARTIST,
    estate_entity_payee_id: ESTATE,
    source_event_id: "funding-event-1",
    artwork_id: "artwork-1",
    provenance_hash: "b".repeat(64),
    created_at: T1.toISOString(),
  });
  let replayThrew: unknown;
  try {
    await store.insertEstateSuccessionTransition({
      certificate_id: verified.id,
      artist_payee_id: ARTIST,
      estate_entity_payee_id: ESTATE,
      source_event_id: "funding-event-1",
      artwork_id: "artwork-1",
      provenance_hash: "b".repeat(64),
      created_at: T2.toISOString(),
    });
  } catch (error) {
    replayThrew = error;
  }
  expectUniqueViolation(replayThrew);
  // A different event appends — the ledger grows, nothing updates.
  await store.insertEstateSuccessionTransition({
    certificate_id: verified.id,
    artist_payee_id: ARTIST,
    estate_entity_payee_id: ESTATE,
    source_event_id: "funding-event-2",
    artwork_id: null,
    provenance_hash: null,
    created_at: T2.toISOString(),
  });
  const history = await store.listEstateSuccessionTransitions(verified.id);
  expect(history.map((transition) => transition.source_event_id)).toEqual([
    "funding-event-1",
    "funding-event-2",
  ]);
  expect(await store.listEstateSuccessionTransitions("no-such-certificate")).toEqual([]);

  // --- The split-accrual ledger: UNIQUE per (certificate_id, artwork_id,
  // source_event_id) — the provenance triple is the once-only key. ---
  await store.insertEstateSplitAccrual({
    schedule_id: scheduleV1.id,
    certificate_id: verified.id,
    artist_payee_id: ARTIST,
    estate_entity_payee_id: ESTATE,
    source_event_id: "funding-event-1",
    artwork_id: "artwork-1",
    provenance_hash: "c".repeat(64),
    basis_cents: 10_000_00,
    allocations: [
      { heir_payee_id: HEIR_SPOUSE, heir_payee_name: "Spouse", relationship: "spouse", share_cents: 5_000_00 },
      { heir_payee_id: HEIR_CHILD_A, heir_payee_name: "Child A", relationship: "child", share_cents: 2_500_00 },
      { heir_payee_id: HEIR_CHILD_B, heir_payee_name: "Child B", relationship: "child", share_cents: 2_500_00 },
    ],
    dust_cents: 0,
    created_at: T1.toISOString(),
  });
  let accrualReplayThrew: unknown;
  try {
    await store.insertEstateSplitAccrual({
      schedule_id: scheduleV1.id,
      certificate_id: verified.id,
      artist_payee_id: ARTIST,
      estate_entity_payee_id: ESTATE,
      source_event_id: "funding-event-1",
      artwork_id: "artwork-1",
      provenance_hash: "c".repeat(64),
      basis_cents: 10_000_00,
      allocations: [],
      dust_cents: 10_000_00,
      created_at: T2.toISOString(),
    });
  } catch (error) {
    accrualReplayThrew = error;
  }
  expectUniqueViolation(accrualReplayThrew);
  // The same event on a DIFFERENT artwork accrues — the triple, not the
  // event id alone, is the key.
  await store.insertEstateSplitAccrual({
    schedule_id: scheduleV1.id,
    certificate_id: verified.id,
    artist_payee_id: ARTIST,
    estate_entity_payee_id: ESTATE,
    source_event_id: "funding-event-1",
    artwork_id: "artwork-2",
    provenance_hash: "c".repeat(64),
    basis_cents: 1_000,
    allocations: [],
    dust_cents: 1_000,
    created_at: T2.toISOString(),
  });
  const accruals = await store.listEstateSplitAccruals(verified.id);
  expect(accruals.map((accrual) => accrual.artwork_id)).toEqual(["artwork-1", "artwork-2"]);
  // The jsonb round-trip preserves the roster exactly.
  expect(accruals[0]?.allocations).toEqual([
    { heir_payee_id: HEIR_SPOUSE, heir_payee_name: "Spouse", relationship: "spouse", share_cents: 5_000_00 },
    { heir_payee_id: HEIR_CHILD_A, heir_payee_name: "Child A", relationship: "child", share_cents: 2_500_00 },
    { heir_payee_id: HEIR_CHILD_B, heir_payee_name: "Child B", relationship: "child", share_cents: 2_500_00 },
  ]);
  expect(await store.listEstateSplitAccruals("no-such-certificate")).toEqual([]);

  // --- The payout-gate states of record: upsert converges per payee; the
  // newest state governs the next dispatch. ---
  await store.upsertEstatePayoutGateState({
    payee_id: ESTATE,
    estate_succession_state: "unknown",
    certificate_ref: "PROBATE-2026-001",
    verified_by: null,
  });
  expect((await store.getEstatePayoutGateState(ESTATE))?.estate_succession_state).toBe("unknown");
  await store.upsertEstatePayoutGateState({
    payee_id: ESTATE,
    estate_succession_state: "verified",
    certificate_ref: "PROBATE-2026-001",
    verified_by: "operator-founder",
  });
  expect((await store.getEstatePayoutGateState(ESTATE))?.estate_succession_state).toBe("verified");
  expect((await store.getEstatePayoutGateState(ESTATE))?.verified_by).toBe("operator-founder");
  expect(await store.getEstatePayoutGateState("payee-no-such")).toBeUndefined();
}

interface BackendSpec {
  name: string;
  make: () => Store;
}

const BACKENDS: BackendSpec[] = [
  { name: "InMemoryStore", make: () => new InMemoryStore() },
  { name: "SqliteStore", make: () => new SqliteStore(":memory:") },
  {
    // The fake implements the builder subset the estate methods touch;
    // the real SupabaseClient surface is far larger than the store touches.
    name: "SupabaseStore",
    make: () =>
      new SupabaseStore(
        new FakeSupabaseClient(FAKE_UNIQUES) as unknown as SupabaseClient,
      ),
  },
];

describe("estate succession — three-backend parity (migration 0033)", () => {
  for (const backend of BACKENDS) {
    describe(backend.name, () => {
      it("guards the certificate upsert, schedule versioning, transition and accrual replay guards, and gate states identically", async () => {
        await scenario(backend.make());
      });
    });
  }
});
