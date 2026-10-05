// VTuber agency holdbacks (PR 15) — three-backend parity, mirroring the
// film-escrow and gaming-cashout parity pattern: ONE identical scenario
// script runs on InMemoryStore, SqliteStore (:memory:), and SupabaseStore
// over a behavioral PostgREST fake.
//
// Under test, identically on every backend: the avatar IP licensing
// holdback lock (kind AND status both 'avatar_ip_licensing_holdback', the
// FBO debit + per-agency holdback-credit journal, replay 409 per source,
// zero vault movement), the full verified release through the deduction
// stack (management band, rigging, licensing, tech-setup amortization
// line, then the talent split with dust swept — recoupment and the
// fail-closed compliance gates inside), the CAS settle (a replayed release
// is a 409 — exactly one journal), the tax-withholding verification state
// (one row per payee + tax year; a re-verification replaces; other years
// and other payees coexist), and the tech-setup amortization schedule
// (UNIQUE schedule_ref, append-only lines UNIQUE by (schedule_ref,
// line_index) — the insert-as-lock consume arbiter's 23505 refusal).

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { InMemoryStore } from "@/lib/server/inMemoryStore";
import { SqliteStore } from "@/lib/server/sqliteStore";
import { SupabaseStore } from "@/lib/server/supabaseStore";
import type { Store } from "@/lib/server/store";
import {
  buildVtuberAgencyDeductionPlan,
  postToAvatarIpHoldback,
  releaseVtuberAgencyDeductions,
  type VtuberTalentShare,
} from "@/lib/server/vtuberAgency";
import {
  vtuberHoldbackGlAccount,
  vtuberHoldbackPayeeId,
  vtuberHoldbackPayeeName,
} from "@/modules/don/constants";
import { setVerticalComplianceStateSource } from "@/modules/compliance/payoutGate";

type Row = Record<string, unknown>;

// ---------------------------------------------------------------------------
// The PostgREST fake — generic insert/upsert/select builders plus the pieces
// the VTuber surface leans on: composite-key upserts (payee_id,tax_year),
// UNIQUE enforcement on the schedule reference and the (schedule_ref,
// line_index) consume arbiter, and multi-order selects.
// ---------------------------------------------------------------------------

class FakeTable {
  private rows: Row[] = [];
  private sequence = 0;

  constructor(private readonly uniqueColumns: string[]) {}

  private violatesUnique(row: Row): boolean {
    if (this.uniqueColumns.length === 0) return false;
    // AND across the unique columns — a composite key clashes only when one
    // row matches every column (OR would 23505 a shared prefix).
    return this.rows.some((existing) =>
      this.uniqueColumns.every((column) => existing[column] === row[column]),
    );
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

  insert(row: Row): { row?: Row; error: { message: string; code: string } | null } {
    const stored = { insertion_order: ++this.sequence, ...row };
    if (this.violatesUnique(stored)) {
      // The REAL Postgres unique index the migration ships — a duplicate
      // fails with 23505, the exact shape the consume arbiter catches.
      return {
        row: undefined,
        error: {
          message: `duplicate key value violates unique constraint "vtuber_holdback_unique"`,
          code: "23505",
        },
      };
    }
    this.rows.push(stored);
    return { row: { ...stored }, error: null };
  }

  /** Composite-key upsert: onConflict may list several comma-split columns. */
  upsert(row: Row, onConflict: string): Row {
    const keyColumns = onConflict.split(",").map((c) => c.trim());
    const existing = this.rows.find((candidate) =>
      keyColumns.every((column) => candidate[column] === row[column]),
    );
    if (existing !== undefined) {
      Object.assign(existing, row);
      return { ...existing };
    }
    const stored = { insertion_order: ++this.sequence, ...row };
    this.rows.push(stored);
    return { ...stored };
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
    if (this.single) return { data: rows[0] ?? null, error: null };
    return { data: rows, error: null };
  }
}

class FakeSupabaseClient {
  private tables = new Map<string, FakeTable>();

  from(table: string): FakeQueryBuilder {
    // The migration's real indexes: the schedule's UNIQUE reference and the
    // consume arbiter's UNIQUE (schedule_ref, line_index).
    const uniques =
      table === "vtuber_tech_setup_amortization_schedules"
        ? ["schedule_ref"]
        : table === "vtuber_tech_setup_amortization_lines"
          ? ["schedule_ref", "line_index"]
          : [];
    let t = this.tables.get(table);
    if (t === undefined) {
      t = new FakeTable(uniques);
      this.tables.set(table, t);
    }
    return new FakeQueryBuilder(t);
  }

  /** The migration 0009 vault-delta function, applied to the fake's rows. */
  rpc(fn: string, params: Record<string, unknown>): { data: unknown; error: null } | { data: null; error: { message: string; code: string } } {
    // The migration 0057 YTD accumulate: one insert-or-add step over
    // creator_ytd_earnings, returning the post-increment row — the jsonb
    // the real SQL function returns.
    if (fn === "increment_creator_ytd") {
      let table = this.tables.get("creator_ytd_earnings");
      if (table === undefined) {
        table = new FakeTable([]);
        this.tables.set("creator_ytd_earnings", table);
      }
      const creatorId = String(params.p_creator_id);
      const taxYear = Number(params.p_tax_year);
      const existing = table
        .select([], [], null)
        .find(
          (row) =>
            row.creator_id === creatorId && row.tax_year === taxYear,
        );
      if (existing === undefined) {
        const minted = {
          creator_id: creatorId,
          tax_year: taxYear,
          gross_cents: Number(params.p_gross_delta),
          withheld_cents: Number(params.p_withheld_delta),
          updated_at: params.p_updated_at,
        };
        table.insert(minted);
        return { data: { ...minted }, error: null };
      }
      const updated = {
        creator_id: creatorId,
        tax_year: taxYear,
        gross_cents:
          Number(existing.gross_cents) + Number(params.p_gross_delta),
        withheld_cents:
          Number(existing.withheld_cents) +
          Number(params.p_withheld_delta),
        updated_at: params.p_updated_at,
      };
      table.upsert(updated, "creator_id,tax_year");
      return { data: { ...updated }, error: null };
    }

    if (fn !== "apply_vault_delta") {
      return { data: null, error: { message: `unhandled rpc: ${fn}`, code: "PGRST202" } };
    }
    const vaults = this.tables.get("sovereign_vaults");
    if (vaults === undefined) {
      return { data: { outcome: params.p_create_if_missing ? "applied" : "not_found", vault: null }, error: null };
    }
    const payeeId = params.p_payee_id as string;
    const delta = {
      available_balance: params.p_available_delta as number,
      pending_balance: params.p_pending_delta as number,
      reserve_balance: params.p_reserve_delta as number,
    };
    const mins = {
      available_balance: params.p_min_available as number | null,
      pending_balance: params.p_min_pending as number | null,
      reserve_balance: params.p_min_reserve as number | null,
    };
    const existing = vaults
      .select([["payee_id", payeeId]], [], null)
      .at(0) as Row | undefined;
    if (existing === undefined) {
      if (!params.p_create_if_missing) {
        return { data: { outcome: "not_found" }, error: null };
      }
      if (
        delta.available_balance < 0 ||
        delta.pending_balance < 0 ||
        delta.reserve_balance < 0
      ) {
        return { data: { outcome: "not_found" }, error: null };
      }
      if (
        (mins.available_balance !== null && delta.available_balance < mins.available_balance) ||
        (mins.pending_balance !== null && delta.pending_balance < mins.pending_balance) ||
        (mins.reserve_balance !== null && delta.reserve_balance < mins.reserve_balance)
      ) {
        return { data: { outcome: "guard_failed" }, error: null };
      }
      const minted = {
        payee_id: payeeId,
        payee_name: params.p_payee_name,
        ...delta,
        updated_at: params.p_updated_at,
      };
      vaults.insert(minted);
      return { data: { outcome: "applied", vault: { ...minted } }, error: null };
    }
    const next = {
      available_balance: (existing.available_balance as number) + delta.available_balance,
      pending_balance: (existing.pending_balance as number) + delta.pending_balance,
      reserve_balance: (existing.reserve_balance as number) + delta.reserve_balance,
    };
    if (
      (mins.available_balance !== null && next.available_balance < mins.available_balance) ||
      (mins.pending_balance !== null && next.pending_balance < mins.pending_balance) ||
      (mins.reserve_balance !== null && next.reserve_balance < mins.reserve_balance)
    ) {
      return { data: { outcome: "guard_failed" }, error: null };
    }
    vaults.update(
      { ...next, updated_at: params.p_updated_at },
      [["payee_id", payeeId]],
    );
    const updated = vaults
      .select([["payee_id", payeeId]], [], null)
      .at(0);
    return { data: { outcome: "applied", vault: updated }, error: null };
  }
}

// ---------------------------------------------------------------------------
// The shared scenario script — one identical flow on every backend.
// ---------------------------------------------------------------------------

const NOW = new Date("2026-10-01T12:00:00Z");
const LATER = new Date("2026-10-01T12:01:00Z");
const AGENCY = "holo-nexus";
const AGENCY_PAYEE_ID = vtuberHoldbackPayeeId(AGENCY);
const AGENCY_PAYEE_NAME = vtuberHoldbackPayeeName(AGENCY);
const RECEIPT_CENTS = 100_000; // $1,000.00
const YEAR = NOW.getUTCFullYear();

type Failure = { ok: false; status: number; code: string; message: string };
type Success<V> = { ok: true; value: V };

function mustSucceed<V>(result: Success<V> | Failure): V {
  if (!result.ok) {
    throw new Error(
      `expected success, got ${result.status} ${result.code}: ${result.message}`,
    );
  }
  return result.value;
}

const TALENT: VtuberTalentShare[] = [
  { payeeId: "payee-talent-one", payeeName: "Talent One", role: "creator", shareBps: 5_000 },
  { payeeId: "payee-talent-two", payeeName: "Talent Two", role: "creator", shareBps: 3_000 },
  { payeeId: "payee-coach", payeeName: "Coach", role: "producer", shareBps: 2_000 },
];

async function seedVerifiedParty(
  store: Store,
  payeeId: string,
  payeeName: string,
): Promise<void> {
  await store.upsertVault({
    payee_id: payeeId,
    payee_name: payeeName,
    available_balance: 0,
    pending_balance: 0,
    reserve_balance: 0,
    updated_at: NOW.toISOString(),
  });
  await store.insertKycVerification({
    creator_id: payeeId,
    plaid_link_token: "link-token",
    plaid_public_token: "public-token",
    status: "verified",
    identity_json: "{}",
    failure_reason: null,
    created_at: NOW.toISOString(),
    verified_at: NOW.toISOString(),
  });
  await store.upsertCreatorTaxProfile({
    creator_id: payeeId,
    tin_verified: 1,
    w9_on_file: 1,
    updated_at: NOW.toISOString(),
  });
}

async function scenario(store: Store): Promise<void> {
  setVerticalComplianceStateSource(async () => ({
    vertical: "livestream",
    stream_platform_payout_reconciled: true,
    tax_withholding_verified: true,
  }));
  await seedVerifiedParty(store, AGENCY_PAYEE_ID, AGENCY_PAYEE_NAME);
  for (const member of TALENT) {
    await seedVerifiedParty(store, member.payeeId, member.payeeName);
  }

  // --- The holdback lock: post, replay 409, journal, zero vault movement ---

  const posted = mustSucceed(
    await postToAvatarIpHoldback(
      store,
      {
        agency: AGENCY,
        amount_cents: RECEIPT_CENTS,
        currency: "USD",
        source: { type: "match_queue", event_id: "vtuber:gift:evt-1" },
      },
      NOW,
    ),
  );
  expect(posted.holdback_credit.kind).toBe("avatar_ip_licensing_holdback");
  expect(posted.holdback_credit.status).toBe("avatar_ip_licensing_holdback");
  expect(posted.holdback_credit.line_item_id).toBe("vtuber:gift:evt-1");

  const replayed = await postToAvatarIpHoldback(
    store,
    {
      agency: AGENCY,
      amount_cents: RECEIPT_CENTS,
      currency: "USD",
      source: { type: "match_queue", event_id: "vtuber:gift:evt-1" },
    },
    NOW,
  );
  expect(replayed.ok).toBe(false);
  if (!replayed.ok) expect(replayed.code).toBe("vtuber_holdback_receipt_already_posted");

  const legs = await store.listGlEntriesByJournal(posted.journal_id);
  expect(legs).toHaveLength(2);
  const fbo = legs.find((leg) => leg.account === "fbo_cash")!;
  expect(fbo.debit_cents).toBe(RECEIPT_CENTS);
  const holdback = legs.find((leg) => leg.account === vtuberHoldbackGlAccount(AGENCY))!;
  expect(holdback.credit_cents).toBe(RECEIPT_CENTS);

  // The lock: no vault moved, the row is the holdback listing's only entry.
  expect(await store.getVault(AGENCY_PAYEE_ID)).toBeDefined();
  expect((await store.getVault(AGENCY_PAYEE_ID))!.pending_balance).toBe(0);
  const held = await store.listAvatarIpHoldbackCredits();
  expect(held.map((r) => r.id)).toEqual([posted.holdback_credit.id]);

  // --- The verified release through the deduction stack ---------------------

  await store.insertVtuberTechSetupAmortizationSchedule({
    schedule_ref: "rig-parity-01",
    agency_payee_id: AGENCY_PAYEE_ID,
    description: "3D model rig + tech setup",
    total_cost_cents: 74_260,
    amortization_periods: 4,
    created_at: NOW.toISOString(),
  });

  const released = mustSucceed(
    await releaseVtuberAgencyDeductions(
      store,
      {
        holdback_ledger_id: posted.holdback_credit.id,
        agencyPayeeId: AGENCY_PAYEE_ID,
        agencyPayeeName: AGENCY_PAYEE_NAME,
        managementFeeBps: 3_000,
        riggingHoldbackCents: 10_000,
        riggingContractRef: "rig-contract-2026-014",
        licensingHoldbackCents: 8_000,
        licenseVerificationRef: "license-verif-2026-014",
        techSetupAmortizationScheduleRef: "rig-parity-01",
        talentShares: TALENT,
        operator_settlement_approved: true,
      },
      NOW,
    ),
  );
  expect(released.holdback_credit.status).toBe("settled");
  expect(released.holdback_credit.kind).toBe("avatar_ip_licensing_holdback");
  expect(released.plan.managementFeeCents).toBe(30_000);
  expect(released.plan.riggingHoldbackCents).toBe(10_000);
  expect(released.plan.licensingHoldbackCents).toBe(8_000);
  expect(released.plan.techSetupAmortizationCents).toBe(18_565);
  expect(released.plan.talentPoolCents).toBe(33_435);
  expect(released.tech_setup_amortization?.line_index).toBe(0);
  expect(released.company_dust_cents).toBe(1);
  expect(released.withholding).toHaveLength(2);
  expect(await store.listAvatarIpHoldbackCredits()).toHaveLength(0);

  // The release journal balances and a replayed release is a 409.
  const releaseLegs = await store.listGlEntriesByJournal(released.journal_id);
  const debits = releaseLegs.reduce((total, leg) => total + leg.debit_cents, 0);
  const credits = releaseLegs.reduce((total, leg) => total + leg.credit_cents, 0);
  expect(debits).toBe(credits);
  const replayedRelease = await releaseVtuberAgencyDeductions(
    store,
    {
      holdback_ledger_id: posted.holdback_credit.id,
      agencyPayeeId: AGENCY_PAYEE_ID,
      agencyPayeeName: AGENCY_PAYEE_NAME,
      managementFeeBps: 2_000,
      riggingHoldbackCents: 0,
      riggingContractRef: "",
      licensingHoldbackCents: 0,
      licenseVerificationRef: "",
      techSetupAmortizationScheduleRef: null,
      talentShares: TALENT,
      operator_settlement_approved: true,
    },
    NOW,
  );
  expect(replayedRelease.ok).toBe(false);
  if (!replayedRelease.ok) expect(replayedRelease.code).toBe("holdback_already_released");

  // --- The tax withholding verification state -------------------------------

  const verificationRow = {
    id: "vtuber-tax-verif-1",
    payee_id: "payee-talent-one",
    tax_year: YEAR,
    state: "verified" as const,
    tin_verified: true,
    w9_on_file: true,
    evidence_ref: "w9-evidence-2026-001",
    verified_at: NOW.toISOString(),
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  };
  const verified = await store.upsertVtuberTaxWithholdingVerification(verificationRow);
  expect(verified.state).toBe("verified");
  expect(verified.tax_year).toBe(YEAR);

  const readBack = await store.getVtuberTaxWithholdingVerification("payee-talent-one", YEAR);
  expect(readBack?.evidence_ref).toBe("w9-evidence-2026-001");
  expect(await store.getVtuberTaxWithholdingVerification("payee-talent-one", YEAR - 1))
    .toBeUndefined();
  expect(await store.getVtuberTaxWithholdingVerification("payee-nobody", YEAR))
    .toBeUndefined();

  // One verification state per payee + tax year — the re-verification
  // REPLACES the row (the composite key holds).
  await store.upsertVtuberTaxWithholdingVerification({
    ...verificationRow,
    id: "vtuber-tax-verif-1-reverify",
    state: "pending",
    evidence_ref: null,
    verified_at: null,
    updated_at: LATER.toISOString(),
  });
  const replaced = await store.getVtuberTaxWithholdingVerification("payee-talent-one", YEAR);
  expect(replaced?.state).toBe("pending");
  expect(replaced?.evidence_ref).toBeNull();

  // Other payees and other tax years coexist under the composite key.
  await store.upsertVtuberTaxWithholdingVerification({
    ...verificationRow,
    id: "vtuber-tax-verif-2",
    payee_id: "payee-talent-two",
    tax_year: YEAR - 1,
    evidence_ref: "w9-evidence-2025-002",
  });
  expect(
    (await store.getVtuberTaxWithholdingVerification("payee-talent-two", YEAR - 1))
      ?.state,
  ).toBe("verified");
  expect(
    (await store.getVtuberTaxWithholdingVerification("payee-talent-one", YEAR))?.state,
  ).toBe("pending");

  // --- The tech setup amortization schedule ---------------------------------

  const schedule = await store.getVtuberTechSetupAmortizationScheduleByRef("rig-parity-01");
  expect(schedule?.total_cost_cents).toBe(74_260);
  expect(await store.getVtuberTechSetupAmortizationScheduleByRef("rig-missing"))
    .toBeUndefined();

  // The consumed line zero is there; a concurrent insert of the SAME line is
  // the unique-violation refusal (the insert-as-lock consume arbiter).
  const lines = await store.listVtuberTechSetupAmortizationLines("rig-parity-01");
  expect(lines.map((l) => l.line_index)).toEqual([0]);
  await expect(
    store.insertVtuberTechSetupAmortizationLine({
      schedule_ref: "rig-parity-01",
      line_index: 0,
      line_cents: 18_565,
      deducted_at: NOW.toISOString(),
      created_at: NOW.toISOString(),
    }),
  ).rejects.toThrow(/23505|UNIQUE|unique/i);

  // The next line consumes cleanly and lists in index order.
  await store.insertVtuberTechSetupAmortizationLine({
    schedule_ref: "rig-parity-01",
    line_index: 1,
    line_cents: 18_565,
    deducted_at: LATER.toISOString(),
    created_at: NOW.toISOString(),
  });
  expect((await store.listVtuberTechSetupAmortizationLines("rig-parity-01")).map((l) => l.line_index))
    .toEqual([0, 1]);
}

interface BackendSpec {
  name: string;
  make: () => Store;
}

const BACKENDS: BackendSpec[] = [
  { name: "InMemoryStore", make: () => new InMemoryStore() },
  { name: "SqliteStore", make: () => new SqliteStore(":memory:") },
  {
    // The fake implements the builder subset the store's VTuber and ledger
    // methods touch; the real SupabaseClient surface is far larger.
    name: "SupabaseStore",
    make: () => new SupabaseStore(new FakeSupabaseClient() as unknown as SupabaseClient),
  },
];

describe("vtuber agency holdbacks — three-backend parity", () => {
  for (const backend of BACKENDS) {
    describe(backend.name, () => {
      it("posts and replay-guards the holdback lock, releases through the deduction stack exactly once, upserts one tax verification per payee and year, and arbitrates amortization line consumption by unique insert", async () => {
        await scenario(backend.make());
      });
    });
  }
});

// The plan builder is store-free — pinned once (the shared scenario runs it
// indirectly through the release; this keeps the band's edges covered on the
// parity file too).
describe("vtuber agency deduction plan — band edges (backend-independent)", () => {
  it("accepts 2000 and 4000 bps and refuses one basis point beyond either edge", () => {
    const base = {
      grossCents: 100_000,
      agencyPayeeId: AGENCY_PAYEE_ID,
      riggingHoldbackCents: 0,
      licensingHoldbackCents: 0,
      techSetupAmortizationCents: 0,
      talentShares: [
        { payeeId: "t1", payeeName: "T1", role: "creator", shareBps: 10_000 },
      ] satisfies VtuberTalentShare[],
    };
    expect(buildVtuberAgencyDeductionPlan({ ...base, managementFeeBps: 2_000 }).ok).toBe(true);
    expect(buildVtuberAgencyDeductionPlan({ ...base, managementFeeBps: 4_000 }).ok).toBe(true);
    expect(buildVtuberAgencyDeductionPlan({ ...base, managementFeeBps: 1_999 }).ok).toBe(false);
    expect(buildVtuberAgencyDeductionPlan({ ...base, managementFeeBps: 4_001 }).ok).toBe(false);
  });
});
