// Gaming cashout ledger states (PR 13) — three-backend parity for the
// cashout read + CAS-settle, DevEx conversion-log (unique event id, batch
// fiat settlement), and studio-KYC store methods, mirroring the film-escrow
// parity pattern: the same scenario script runs on InMemoryStore,
// SqliteStore (:memory:), and SupabaseStore over a behavioral PostgREST
// fake.
//
// Under test: the held-cashout listing filters (kind AND status =
// 'virtual_currency_cashout_pending' — released rows and ordinary royalty
// rows never appear), newest-first ordering, the limit, the compare-and-set
// settle (one winner; the loser and unknown ids read undefined), the
// conversion log's UNIQUE-per-funding-line idempotency (a replay counts as
// a no-op; a concurrent insert's unique violation re-reads the winner),
// batch-scoped fiat settlement (only pending rows flip, honest count), and
// one studio-KYC verification state per studio payee (upsert replaces).

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { InMemoryStore } from "@/lib/server/inMemoryStore";
import { SqliteStore } from "@/lib/server/sqliteStore";
import { SupabaseStore } from "@/lib/server/supabaseStore";
import type { Store } from "@/lib/server/store";
import type { LedgerTransactionRecord } from "@/lib/don/types";
import {
  gamingCashoutPayeeId,
  gamingCashoutPayeeName,
} from "@/modules/don/constants";

type Row = Record<string, unknown>;

// ---------------------------------------------------------------------------
// The PostgREST fake — eq filters, ordered select, guarded update returning,
// UNIQUE enforcement on the conversion-log event id, and the studio-KYC
// upsert keyed on studio_payee_id.
// ---------------------------------------------------------------------------

class FakeTable {
  private rows: Row[] = [];
  private sequence = 0;

  constructor(private readonly uniqueColumns: string[] = []) {}

  private violatesUnique(row: Row): Row | undefined {
    for (const column of this.uniqueColumns) {
      const clash = this.rows.find((r) => r[column] === row[column]);
      if (clash !== undefined) return clash;
    }
    return undefined;
  }

  insert(row: Row): { row?: Row; error: { message: string; code: string } | null } {
    // The generated insertion_order column the real table carries.
    const stored = {
      insertion_order: ++this.sequence,
      ...row,
    };
    // The REAL Postgres unique index the migration ships: a duplicate
    // event_id fails with 23505 — the exact shape the replay guard catches.
    const clash = this.violatesUnique(stored);
    if (clash !== undefined) {
      return {
        row: undefined,
        error: {
          message: `duplicate key value violates unique constraint "gaming_devex_conversion_logs_event_id_key"`,
          code: "23505",
        },
      };
    }
    this.rows.push(stored);
    return { row: { ...stored }, error: null };
  }

  /** One verification state per studio payee — upsert replaces the row. */
  upsert(row: Row, onConflict: string): Row {
    const existing = this.rows.find((r) => r[onConflict] === row[onConflict]);
    if (existing !== undefined) {
      Object.assign(existing, row);
      return { ...existing };
    }
    const stored = {
      insertion_order: ++this.sequence,
      ...row,
    };
    this.rows.push(stored);
    return { ...stored };
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
}

interface FakeResult {
  data: unknown;
  error: { message: string; code: string } | null;
}

type Operation =
  | { kind: "insert"; row: Row }
  | { kind: "upsert"; row: Row; onConflict: string }
  | { kind: "update"; patch: Row }
  | { kind: "select" };

class FakeQueryBuilder {
  private filters: Array<[string, unknown]> = [];
  private orders: Array<{ column: string; ascending: boolean }> = [];
  private limitCount: number | null = null;
  private single = false;
  private operation: Operation = { kind: "select" };

  constructor(private readonly table: FakeTable) {}

  insert(row: Row): this {
    this.operation = { kind: "insert", row };
    return this;
  }

  upsert(row: Row, options?: { onConflict?: string }): this {
    this.operation = { kind: "upsert", row, onConflict: options?.onConflict ?? "id" };
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
      return { data: row, error: null };
    }
    if (op.kind === "upsert") {
      return { data: this.table.upsert(op.row, op.onConflict), error: null };
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
    // The conversion-log table carries the UNIQUE event_id index the
    // migration ships; the other tables get no unique columns.
    const uniques = table === "gaming_devex_conversion_logs" ? ["event_id"] : [];
    let t = this.tables.get(table);
    if (t === undefined) {
      t = new FakeTable(uniques);
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
const PLATFORM = "Roblox";
const OTHER_PLATFORM = "Steam";
const BATCH = "rbx-payout-2026-40";

function cashoutRow(
  platform: string,
  eventId: string,
  amountCents: number,
  createdAt: string,
  status: "virtual_currency_cashout_pending" | "settled" = "virtual_currency_cashout_pending",
): Omit<LedgerTransactionRecord, "id"> {
  return {
    split_run_id: "",
    line_item_id: eventId,
    payee_id: gamingCashoutPayeeId(platform),
    payee_name: gamingCashoutPayeeName(platform),
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
    kind: "virtual_currency_cashout_pending",
  };
}

async function scenario(store: Store): Promise<void> {
  // --- The held-cashout view ------------------------------------------------

  const oldest = await store.insertLedgerTransaction(
    cashoutRow(PLATFORM, "evt-a", 2_000, T0),
  );
  const newest = await store.insertLedgerTransaction(
    cashoutRow(PLATFORM, "evt-b", 3_500, T1),
  );
  // Decoys: an already-released cashout row and an ordinary royalty row must
  // never appear. Another platform's LOCKED receipt legitimately appears —
  // the listing is the cross-platform work queue of held receipts (each
  // row's platform rides in its gaming_cashout:{platform} payee id);
  // per-batch money math goes through the release by row id.
  await store.insertLedgerTransaction(
    cashoutRow(PLATFORM, "evt-c", 9_999, T0, "settled"),
  );
  const otherPlatformHeld = await store.insertLedgerTransaction(
    cashoutRow(OTHER_PLATFORM, "evt-d", 8_888, T0),
  );
  await store.insertLedgerTransaction({
    ...cashoutRow(PLATFORM, "evt-e", 7_777, T0),
    payee_id: "creator_x",
    payee_name: "Creator X",
    role: "creator",
    share_bps: 10_000,
    status: "pending_settlement",
    kind: "royalty",
  });

  // Newest first (evt-b's created_at is strictly the latest); the T0 ties
  // are the two held receipts in some tie-break order.
  const heldIds = (await store.listVirtualCurrencyCashoutCredits()).map((r) => r.id);
  expect(heldIds[0]).toBe(newest.id);
  expect(new Set(heldIds)).toEqual(
    new Set([oldest.id, newest.id, otherPlatformHeld.id]),
  );
  expect(await store.listVirtualCurrencyCashoutCredits(1)).toEqual([newest]);

  // CAS settle: the winner reads the settled row; the loser and unknown
  // ids read undefined.
  const settled = await store.settleVirtualCurrencyCashout(oldest.id, T2);
  expect(settled?.status).toBe("settled");
  expect(settled?.settled_at).toBe(T2);
  expect(settled?.kind).toBe("virtual_currency_cashout_pending");
  expect(await store.settleVirtualCurrencyCashout(oldest.id, T2)).toBeUndefined();
  expect(await store.settleVirtualCurrencyCashout("missing", T2)).toBeUndefined();

  // The settled row left the held listing; the newest and the other
  // platform's locked receipt remain.
  const remainingIds = (await store.listVirtualCurrencyCashoutCredits()).map((r) => r.id);
  expect(remainingIds[0]).toBe(newest.id);
  expect(remainingIds).toHaveLength(2);

  // --- The DevEx conversion logs ---------------------------------------------

  const logRow = {
    event_id: "gaming:devex:evt-devex-1",
    line_event_id: "evt-devex-1",
    platform: PLATFORM,
    denomination: "Robux",
    virtual_amount: "2857142.857142857",
    exchange_rate: "0.0035",
    fiat_net_cents: 10_000,
    settlement_batch_ref: BATCH,
    status: "pending_fiat_settlement" as const,
    settled_at: null,
    created_at: T0,
  };
  const log = await store.insertGamingDevexConversionLog(logRow);
  expect(log.event_id).toBe("gaming:devex:evt-devex-1");
  expect(log.status).toBe("pending_fiat_settlement");
  expect(log.settled_at).toBeNull();

  // The replayed INSERT is the DB's refusal (UNIQUE event_id) — the caller
  // catches the unique violation and re-reads the winner. The read path
  // returns the existing record either way.
  const readBack = await store.getGamingDevexConversionLogByEventId(
    "gaming:devex:evt-devex-1",
  );
  expect(readBack?.id).toBe(log.id);
  await expect(
    store.insertGamingDevexConversionLog(logRow),
  ).rejects.toThrow(/23505|UNIQUE|unique/i);

  // Batch listing: oldest first (write order).
  await store.insertGamingDevexConversionLog({
    ...logRow,
    event_id: "gaming:devex:evt-devex-2",
    line_event_id: "evt-devex-2",
    fiat_net_cents: 5_000,
    created_at: T1,
  });
  await store.insertGamingDevexConversionLog({
    ...logRow,
    event_id: "gaming:devex:evt-devex-3",
    line_event_id: "evt-devex-3",
    settlement_batch_ref: "other-batch",
    created_at: T0,
  });
  const batchLogs = await store.listGamingDevexConversionLogsByBatch(BATCH);
  expect(batchLogs.map((l) => l.line_event_id)).toEqual(["evt-devex-1", "evt-devex-2"]);

  // Batch-scoped fiat settlement: only THIS batch's pending rows flip, the
  // count is honest, a second settlement counts zero.
  const settledCount = await store.settleGamingDevexConversionLogsByBatch(BATCH, T2);
  expect(settledCount).toBe(2);
  const settledLog = await store.getGamingDevexConversionLogByEventId(
    "gaming:devex:evt-devex-1",
  );
  expect(settledLog?.status).toBe("fiat_settled");
  expect(settledLog?.settled_at).toBe(T2);
  const otherBatchLog = await store.getGamingDevexConversionLogByEventId(
    "gaming:devex:evt-devex-3",
  );
  expect(otherBatchLog?.status).toBe("pending_fiat_settlement");
  expect(await store.settleGamingDevexConversionLogsByBatch(BATCH, T2)).toBe(0);

  // --- The studio KYC verification state --------------------------------------

  const kycRow = {
    id: "kyc-studio-1",
    studio_payee_id: "studio_1",
    studio_kyc_status: "verified" as const,
    team_members: [
      { member_ref: "member-3d-artist", role: "3d_artist", identity_check_passed: true },
      { member_ref: "member-developer", role: "developer", identity_check_passed: true },
      { member_ref: "member-sound-designer", role: "sound_designer", identity_check_passed: true },
    ],
    contract_ref: "studio-contract-2026-014",
    created_at: T0,
    updated_at: T0,
  };
  const kyc = await store.upsertGamingStudioKyc(kycRow);
  expect(kyc.studio_payee_id).toBe("studio_1");
  expect(kyc.studio_kyc_status).toBe("verified");

  const readKyc = await store.getGamingStudioKyc("studio_1");
  expect(readKyc?.team_members).toHaveLength(3);
  expect(await store.getGamingStudioKyc("studio_missing")).toBeUndefined();

  // The re-verification REPLACES the row (one verification state per
  // studio payee) — the roster changes, the payee key holds.
  await store.upsertGamingStudioKyc({
    ...kycRow,
    id: "kyc-studio-1-reverify",
    studio_kyc_status: "pending" as const,
    team_members: [
      { member_ref: "member-developer", role: "developer", identity_check_passed: true },
    ],
    updated_at: T2,
  });
  const replaced = await store.getGamingStudioKyc("studio_1");
  expect(replaced?.studio_kyc_status).toBe("pending");
  expect(replaced?.team_members).toHaveLength(1);
  expect(replaced?.team_members[0].member_ref).toBe("member-developer");
}

interface BackendSpec {
  name: string;
  make: () => Store;
}

const BACKENDS: BackendSpec[] = [
  { name: "InMemoryStore", make: () => new InMemoryStore() },
  { name: "SqliteStore", make: () => new SqliteStore(":memory:") },
  {
    // The fake implements the builder subset the gaming methods touch;
    // the real SupabaseClient surface is far larger than the store touches.
    name: "SupabaseStore",
    make: () => new SupabaseStore(new FakeSupabaseClient() as unknown as SupabaseClient),
  },
];

describe("gaming cashout — three-backend parity (verification row 4)", () => {
  for (const backend of BACKENDS) {
    describe(backend.name, () => {
      it("lists held cashout receipts (filters, newest-first, limit), settles exactly once via the CAS, enforces the conversion-log UNIQUE per funding line, settles batch fiat, and upserts one studio-KYC state per payee", async () => {
        await scenario(backend.make());
      });
    });
  }
});
