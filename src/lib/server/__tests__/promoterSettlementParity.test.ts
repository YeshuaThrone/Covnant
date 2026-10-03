// Promoter box office settlement escrow + theater gate states + venue hall
// fee policies (PR 31) — three-backend parity for the new store methods,
// mirroring the film-escrow parity pattern: the same scenario script runs on
// InMemoryStore, SqliteStore (:memory:), and SupabaseStore over a behavioral
// PostgREST fake.
//
// Under test: the escrow work-queue listing (kind AND status — released,
// royalty, and comedy-audio rows never appear; cross-stop receipts share one
// queue, newest first, limited), the settlement CAS (one winner, kind
// preserved), the audit-close of record per (production_id, venue_id,
// show_date) with convergent re-recording (the newest close governs the
// next release), the theatrical payout-gate state per (payee_id,
// production_id) — payees within one production stay distinct — and the
// venue hall-fee policy per (tour_id, venue_id) with convergent
// re-registration.

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { InMemoryStore } from "@/lib/server/inMemoryStore";
import { SqliteStore } from "@/lib/server/sqliteStore";
import { SupabaseStore } from "@/lib/server/supabaseStore";
import type { Store } from "@/lib/server/store";
import type { LedgerTransactionRecord } from "@/lib/don/types";
import {
  comedyAudioRightsPayeeId,
  promoterSettlementPayeeId,
  promoterSettlementPayeeName,
} from "@/modules/don/constants";

type Row = Record<string, unknown>;

// ---------------------------------------------------------------------------
// The PostgREST fake — eq filters, ordered select, guarded update returning,
// and behavioral upsert-on-conflict over the FULL conflict tuple.
// ---------------------------------------------------------------------------

class FakeTable {
  private rows: Row[] = [];
  private sequence = 0;

  insert(row: Row): { row: Row; error: null } {
    // The generated insertion_order column the real tables carry.
    const stored = { insertion_order: ++this.sequence, ...row };
    this.rows.push(stored);
    return { row: { ...stored }, error: null };
  }

  update(patch: Row, filters: Array<[string, unknown]>): Row[] {
    const updated: Row[] = [];
    for (const row of this.rows) {
      if (!filters.every(([column, value]) => row[column] === value)) continue;
      Object.assign(row, patch);
      updated.push({ ...row });
    }
    return updated;
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

  /**
   * Behavioral upsert: the conflict target is the FULL tuple (the store's
   * composite keys — production_id,venue_id,show_date etc.), and the merge
   * matches Postgres DO UPDATE semantics — the payload's columns win, the
   * conflict-key columns themselves are identity no-ops, and created_at
   * (absent from the store's payload) is never rewritten.
   */
  upsert(row: Row, onConflict: string | null): { row: Row; error: null } {
    if (onConflict !== null) {
      const conflictColumns = onConflict
        .split(",")
        .map((column) => column.trim())
        .filter(Boolean);
      const index = this.rows.findIndex((existing) =>
        conflictColumns.length > 0 &&
        conflictColumns.every((column) => existing[column] === row[column]),
      );
      if (index >= 0) {
        const original = this.rows[index];
        const restored: Row = { ...original, ...row };
        for (const column of conflictColumns) restored[column] = original[column];
        this.rows[index] = restored;
        return { row: { ...restored }, error: null };
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
  private operation:
    | { kind: "insert"; row: Row }
    | { kind: "upsert"; row: Row }
    | { kind: "update"; patch: Row }
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

  private onConflict: string | null = null;

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
      return { data: this.table.insert(op.row).row, error: null };
    }
    if (op.kind === "upsert") {
      return { data: this.table.upsert(op.row, this.onConflict).row, error: null };
    }
    if (op.kind === "update") {
      // PostgREST semantics: the WHERE clause (id + status guard) picks the
      // targets and is NOT re-applied to the returning snapshot — an empty
      // result means the guarded transition matched nothing (the CAS lost),
      // surfacing as data:null.
      const updated = this.table.update(op.patch, this.filters);
      if (updated.length === 0) return { data: null, error: null };
      if (this.single) return { data: updated[0] ?? null, error: null };
      return { data: updated, error: null };
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
// The shared scenario script.
// ---------------------------------------------------------------------------

const T0 = "2026-09-30T12:00:00.000Z";
const T1 = "2026-09-30T12:00:01.000Z";
const T2 = "2026-09-30T12:00:02.000Z";
const PRODUCTION = "prod-tour-2026";
const VENUE_A = "venue-keg";
const DATE_A = "2026-10-15";
const VENUE_B = "venue-fillmore";
const DATE_B = "2026-10-16";
const SPECIAL = "special-midnight-set";
const PAYEE_1 = "creator_1";
const PAYEE_2 = "creator_2";

function escrowRow(
  venueId: string,
  showDate: string,
  eventId: string,
  amountCents: number,
  createdAt: string,
  status:
    | "promoter_box_office_settlement_pending"
    | "settled" = "promoter_box_office_settlement_pending",
): Omit<LedgerTransactionRecord, "id"> {
  return {
    split_run_id: "",
    line_item_id: eventId,
    payee_id: promoterSettlementPayeeId(PRODUCTION, venueId, showDate),
    payee_name: promoterSettlementPayeeName(PRODUCTION, venueId, showDate),
    role: "other",
    share_bps: 0,
    amount_cents: amountCents,
    currency: "USD",
    status,
    rail: null,
    baas_provider: null,
    baas_transfer_id: null,
    created_at: createdAt,
    settled_at: status === "settled" ? T2 : null,
    kind: "promoter_box_office_settlement_pending",
  };
}

async function scenario(store: Store): Promise<void> {
  // -- The escrow work queue and the settlement CAS -------------------------
  const oldest = await store.insertLedgerTransaction(
    escrowRow(VENUE_A, DATE_A, "evt-a", 2_000, T0),
  );
  // A different stop's receipt legitimately appears in the same queue — the
  // listing is the cross-stop work queue of held receipts (each row's stop
  // rides in its per-stop payee id); per-stop money math goes through the
  // receipt's own scope and release settles by row id.
  const newest = await store.insertLedgerTransaction(
    escrowRow(VENUE_B, DATE_B, "evt-b", 3_500, T1),
  );
  // Decoys: an already-released receipt, an ordinary royalty, and a comedy
  // audio-rights credit (the nearest kind/status pair) must never appear.
  await store.insertLedgerTransaction(
    escrowRow(VENUE_A, DATE_A, "evt-c", 9_999, T0, "settled"),
  );
  await store.insertLedgerTransaction({
    ...escrowRow(VENUE_A, DATE_A, "evt-d", 7_777, T0),
    payee_id: "creator_x",
    payee_name: "Creator X",
    role: "creator",
    share_bps: 10_000,
    status: "pending_settlement",
    kind: "royalty",
  });
  await store.insertLedgerTransaction({
    ...escrowRow(VENUE_A, DATE_A, "evt-e", 8_888, T0),
    payee_id: comedyAudioRightsPayeeId(SPECIAL),
    payee_name: `Comedy Audio Rights — ${SPECIAL}`,
    status: "comedy_audio_rights_pending",
    kind: "comedy_audio_rights_pending",
  });

  // Newest first (evt-b's created_at is strictly the latest).
  const heldIds = (await store.listPromoterSettlementEscrowCredits()).map((r) => r.id);
  expect(heldIds[0]).toBe(newest.id);
  expect(new Set(heldIds)).toEqual(new Set([oldest.id, newest.id]));
  expect(await store.listPromoterSettlementEscrowCredits(1)).toEqual([newest]);

  // CAS settle: the winner reads the settled row with its kind retained; the
  // loser and unknown ids read undefined.
  const settled = await store.settlePromoterSettlementEscrow(oldest.id, T2);
  expect(settled?.status).toBe("settled");
  expect(settled?.settled_at).toBe(T2);
  expect(settled?.kind).toBe("promoter_box_office_settlement_pending");
  expect(await store.settlePromoterSettlementEscrow(oldest.id, T2)).toBeUndefined();
  expect(await store.settlePromoterSettlementEscrow("missing", T2)).toBeUndefined();

  // The settled receipt left the held listing; the other stop's remains.
  const remainingIds = (await store.listPromoterSettlementEscrowCredits()).map(
    (r) => r.id,
  );
  expect(remainingIds[0]).toBe(newest.id);
  expect(remainingIds).toHaveLength(1);

  // -- The audit close of record per stop ----------------------------------
  const stopA = {
    production_id: PRODUCTION,
    venue_id: VENUE_A,
    show_date: DATE_A,
  };
  const closed = await store.upsertPromoterSettlementAudit({
    ...stopA,
    audit_state: "closed",
    evidence_ref: "night-of-show-audit-001",
    closed_by: "operator-founder",
  });
  expect(closed.audit_state).toBe("closed");
  expect(
    (await store.getPromoterSettlementAudit(PRODUCTION, VENUE_A, DATE_A))
      ?.evidence_ref,
  ).toBe("night-of-show-audit-001");

  // A re-recording converges — the newest close governs the next release.
  await store.upsertPromoterSettlementAudit({
    ...stopA,
    audit_state: "unknown",
    evidence_ref: null,
    closed_by: null,
  });
  expect(
    (await store.getPromoterSettlementAudit(PRODUCTION, VENUE_A, DATE_A))
      ?.audit_state,
  ).toBe("unknown");
  await store.upsertPromoterSettlementAudit({
    ...stopA,
    audit_state: "closed",
    evidence_ref: "night-of-show-audit-001",
    closed_by: "operator-founder",
  });
  expect(
    (await store.getPromoterSettlementAudit(PRODUCTION, VENUE_A, DATE_A))
      ?.audit_state,
  ).toBe("closed");

  // The other stop was never audited — absence is undefined, never a default.
  expect(
    await store.getPromoterSettlementAudit(PRODUCTION, VENUE_B, DATE_B),
  ).toBeUndefined();

  // -- The theatrical payout-gate state per (payee, production) ------------
  await store.upsertTheatricalPayoutGateState({
    payee_id: PAYEE_1,
    production_id: PRODUCTION,
    grand_rights_state: "unknown",
    venue_settlement_state: "unknown",
    grand_rights_evidence_ref: null,
    venue_settlement_evidence_ref: null,
    verified_by: null,
  });
  expect(
    await store.getTheatricalPayoutGateState(PAYEE_1, PRODUCTION),
  ).toMatchObject({
    grand_rights_state: "unknown",
    venue_settlement_state: "unknown",
  });

  // The upsert converges — the newest verified states govern the next dispatch.
  await store.upsertTheatricalPayoutGateState({
    payee_id: PAYEE_1,
    production_id: PRODUCTION,
    grand_rights_state: "cleared",
    venue_settlement_state: "reconciled",
    grand_rights_evidence_ref: "gr-evidence-001",
    venue_settlement_evidence_ref: "vs-evidence-001",
    verified_by: "operator-founder",
  });
  expect(
    await store.getTheatricalPayoutGateState(PAYEE_1, PRODUCTION),
  ).toMatchObject({
    grand_rights_state: "cleared",
    venue_settlement_state: "reconciled",
    grand_rights_evidence_ref: "gr-evidence-001",
    venue_settlement_evidence_ref: "vs-evidence-001",
    verified_by: "operator-founder",
  });

  // A second payee in the SAME production stays distinct — the composite key
  // discriminates payees within one production (fail-closed per payee).
  await store.upsertTheatricalPayoutGateState({
    payee_id: PAYEE_2,
    production_id: PRODUCTION,
    grand_rights_state: "unknown",
    venue_settlement_state: "reconciled",
    grand_rights_evidence_ref: null,
    venue_settlement_evidence_ref: "vs-evidence-002",
    verified_by: "operator-founder",
  });
  expect(
    await store.getTheatricalPayoutGateState(PAYEE_2, PRODUCTION),
  ).toMatchObject({
    grand_rights_state: "unknown",
    venue_settlement_state: "reconciled",
  });
  expect(
    (await store.getTheatricalPayoutGateState(PAYEE_1, PRODUCTION))
      ?.grand_rights_state,
  ).toBe("cleared");
  // Absent state is undefined — the gate's fail-closed shape.
  expect(
    await store.getTheatricalPayoutGateState("payee-never-seen", PRODUCTION),
  ).toBeUndefined();

  // -- The venue hall-fee policy per (tour, venue) --------------------------
  await store.upsertVenueHallFeePolicy({
    tour_id: "tour-2026",
    venue_id: VENUE_A,
    hall_fee_rate_bps: 1_500,
    venue_payee_id: "venue-llc",
    venue_payee_name: "Venue LLC",
  });
  expect(
    (await store.getVenueHallFeePolicy("tour-2026", VENUE_A))?.hall_fee_rate_bps,
  ).toBe(1_500);

  // Re-registration converges — the newest policy governs the split.
  await store.upsertVenueHallFeePolicy({
    tour_id: "tour-2026",
    venue_id: VENUE_A,
    hall_fee_rate_bps: 2_500,
    venue_payee_id: "venue-llc-2",
    venue_payee_name: "Venue LLC Two",
  });
  const policyA = await store.getVenueHallFeePolicy("tour-2026", VENUE_A);
  expect(policyA?.hall_fee_rate_bps).toBe(2_500);
  expect(policyA?.venue_payee_id).toBe("venue-llc-2");

  // A second venue on the same tour stays distinct.
  await store.upsertVenueHallFeePolicy({
    tour_id: "tour-2026",
    venue_id: VENUE_B,
    hall_fee_rate_bps: 2_000,
    venue_payee_id: "venue-keg-llc",
    venue_payee_name: "Fillmore LLC",
  });
  expect(
    (await store.getVenueHallFeePolicy("tour-2026", VENUE_B))?.hall_fee_rate_bps,
  ).toBe(2_000);
  expect(
    (await store.getVenueHallFeePolicy("tour-2026", VENUE_A))?.hall_fee_rate_bps,
  ).toBe(2_500);
  // An unregistered pairing is absent — the split never guesses a rate.
  expect(
    await store.getVenueHallFeePolicy("tour-never-registered", VENUE_A),
  ).toBeUndefined();
}

interface BackendSpec {
  name: string;
  make: () => Store;
}

const BACKENDS: BackendSpec[] = [
  { name: "InMemoryStore", make: () => new InMemoryStore() },
  { name: "SqliteStore", make: () => new SqliteStore(":memory:") },
  {
    // The fake implements the builder subset the new methods touch; the real
    // SupabaseClient surface is far larger than the store touches.
    name: "SupabaseStore",
    make: () => new SupabaseStore(new FakeSupabaseClient() as unknown as SupabaseClient),
  },
];

describe("promoter settlement — three-backend parity (verification row 4)", () => {
  for (const backend of BACKENDS) {
    describe(backend.name, () => {
      it("lists held escrow receipts across stops (filters, newest-first, limit), settles exactly once via the CAS, and converges the audit-close, theatrical gate-state, and hall-fee records per composite key", async () => {
        await scenario(backend.make());
      });
    });
  }
});
