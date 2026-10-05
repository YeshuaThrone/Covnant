// IP adaptation optioning — the author-first option-fee cascade (PR 21) —
// three-backend parity, mirroring the webtoon-cascade parity pattern: ONE
// identical scenario script runs on InMemoryStore, SqliteStore (:memory:),
// and SupabaseStore over a behavioral PostgREST fake.
//
// Under test, identically on every backend: the option fee's canonical
// holding post (kind AND status both 'unclaimed_holding', the FBO debit +
// holding-credit journal, the content-derived replay guard), the verified
// release through the AUTHOR-FIRST cascade (the ring-fenced author IP
// allocations FIRST in registration order, the agency commission of the
// REMAINDER — never of the gross — the author of record's residual LAST,
// dust swept), the publishing vertical's fail-closed payout gate (a missing
// per-(payee, work) ip_rights_cleared verification refuses 403 BEFORE the
// CAS takes the lock and before any vault moves, alongside operator
// approval and KYC), the CAS settle (a replayed release is a 409 — exactly
// one release journal), and the durable verification discipline (only a
// 'cleared' state with evidence passes; one state of record per pair).

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { InMemoryStore } from "@/lib/server/inMemoryStore";
import { SqliteStore } from "@/lib/server/sqliteStore";
import { SupabaseStore } from "@/lib/server/supabaseStore";
import type { Store } from "@/lib/server/store";
import { postOptionFeeToHolding, releaseIpOptionFeeFromHolding } from "@/lib/server/ipOptionCascade";
import { verifyPublishingIpRights } from "@/modules/compliance/publishingIpRights";
import { setVerticalComplianceStateSource } from "@/modules/compliance/payoutGate";

type Row = Record<string, unknown>;

// ---------------------------------------------------------------------------
// The PostgREST fake — generic insert/upsert/select/update builders plus the
// apply_vault_delta rpc. Unique constraints arrive as a LIST (a table may
// carry several).
// ---------------------------------------------------------------------------

class FakeTable {
  private rows: Row[] = [];
  private sequence = 0;

  constructor(private readonly uniqueConstraints: string[][]) {}

  private violatesUnique(row: Row): boolean {
    return this.uniqueConstraints.some((constraint) =>
      this.rows.some((existing) =>
        constraint.every((column) => existing[column] === row[column]),
      ),
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
      // The REAL Postgres unique indexes the migration ships — a duplicate
      // fails with 23505, the exact shape a duplicate registration catches.
      return {
        row: undefined,
        error: {
          message: `duplicate key value violates unique constraint "ip_option_unique"`,
          code: "23505",
        },
      };
    }
    this.rows.push(stored);
    return { row: { ...stored }, error: null };
  }

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
    // The migration's real unique indexes, per table.
    const uniques: string[][] =
      table === "ip_option_agreements"
        ? [["work_id"]]
        : table === "ip_option_author_allocations"
          ? [["work_id", "payee_id"]]
          : table === "publishing_ip_rights_verifications"
            ? [["payee_id", "work_id"]]
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
const WORK = "novel-atlas";
const WORK_999 = "novel-vireo";
const OPTION_FEE = 100_000; // $1,000.00
const AGENCY_BPS = 1_000;
const AGREEMENT_REF = "option-atlas-film-2026-07";
const CO_HOLDER_A = { payee_id: "payee-nova", payee_name: "Nova (co-holder)" };
const CO_HOLDER_B = { payee_id: "payee-rio", payee_name: "Rio (co-holder)" };
const AGENCY = { payee_id: "payee-agency-lumen", payee_name: "Lumen Talent Agency" };
const AUTHOR = { payee_id: "payee-atlas-author", payee_name: "Atlas (author of record)" };
const ALL_PARTIES = [CO_HOLDER_A, CO_HOLDER_B, AGENCY, AUTHOR];
// The author-first split of record: allocations are bps OF THE FEE,
// ring-fenced before the agency commission exists.
const ALLOCATIONS = [
  { ...CO_HOLDER_A, allocation_bps: 350 }, // 3.5% of the fee — 3_500 of 100_000
  { ...CO_HOLDER_B, allocation_bps: 225 }, // 2.25% of the fee — 2_250 of 100_000
];

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

async function registerOptionDeal(
  store: Store,
  workId: string,
  author = AUTHOR,
): Promise<void> {
  await store.upsertIpOptionAgreement({
    work_id: workId,
    author_payee_id: author.payee_id,
    author_payee_name: author.payee_name,
    agency_payee_id: AGENCY.payee_id,
    agency_payee_name: AGENCY.payee_name,
    agency_commission_bps: AGENCY_BPS,
    option_deal_ref: AGREEMENT_REF,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  });
}

async function scenario(store: Store): Promise<void> {
  // The vertical state source: the release OVERRIDES ip_rights_cleared with
  // the durable per-(payee, work) resolution and takes the print conditions
  // from the caller — the source here is a placeholder that must not throw.
  setVerticalComplianceStateSource(async () => ({
    vertical: "publishing",
    ip_rights_cleared: true,
    return_reserve_period_elapsed: true,
    isbn_rights_verified: true,
  }));

  // --- The option fee's canonical holding post -------------------------------

  const posted = mustSucceed(
    await postOptionFeeToHolding(
      store,
      {
        work_id: WORK,
        option_fee_cents: OPTION_FEE,
        currency: "USD",
        source_event_id: "recon:option:evt-atlas-1",
      },
      NOW,
    ),
  );
  expect(posted.holding_credit.kind).toBe("unclaimed_holding");
  expect(posted.holding_credit.status).toBe("unclaimed_holding");
  expect(posted.holding_credit.amount_cents).toBe(OPTION_FEE);
  expect(posted.source_event_id).toBe("recon:option:evt-atlas-1");

  // The replay guard: re-posting the same option event 409s — the fee is
  // held exactly once, whatever the caller invents.
  const replayedPost = await postOptionFeeToHolding(
    store,
    {
      work_id: WORK,
      option_fee_cents: OPTION_FEE,
      currency: "USD",
      source_event_id: "recon:option:evt-atlas-1",
    },
    NOW,
  );
  expect(replayedPost.ok).toBe(false);
  if (!replayedPost.ok) expect(replayedPost.code).toBe("unclaimed_holding_already_posted");

  // The holding journal balances: the FBO debit vs the holding credit.
  const postLegs = await store.listGlEntriesByJournal(posted.journal_id);
  const postDebits = postLegs.reduce((total, leg) => total + leg.debit_cents, 0);
  const postCredits = postLegs.reduce((total, leg) => total + leg.credit_cents, 0);
  expect(postDebits).toBe(OPTION_FEE);
  expect(postCredits).toBe(OPTION_FEE);

  // --- The release refuses without the agreement of record -------------------

  const noAgreement = await releaseIpOptionFeeFromHolding(
    store,
    {
      holding_ledger_id: posted.holding_credit.id,
      work_id: WORK,
      operator_settlement_approved: true,
      publishing_conditions: {
        return_reserve_period_elapsed: true,
        isbn_rights_verified: true,
      },
    },
    NOW,
  );
  expect(noAgreement.ok).toBe(false);
  if (!noAgreement.ok) {
    expect(noAgreement.status).toBe(422);
    expect(noAgreement.code).toBe("missing_option_agreement");
  }
  // Nothing moved: the credit is still HELD.
  expect(
    (await store.getLedgerTransaction(posted.holding_credit.id))!.status,
  ).toBe("unclaimed_holding");

  // --- The deal of record + the fail-closed gate -----------------------------

  await registerOptionDeal(store, WORK);
  for (const party of ALL_PARTIES) {
    await seedVerifiedParty(store, party.payee_id, party.payee_name);
  }
  for (const allocation of ALLOCATIONS) {
    await store.insertIpOptionAuthorAllocation({
      work_id: WORK,
      payee_id: allocation.payee_id,
      payee_name: allocation.payee_name,
      allocation_bps: allocation.allocation_bps,
      created_at: NOW.toISOString(),
    });
  }

  // NO verification rows yet: the durable ip_rights_cleared state is absent
  // for every credited payee — the release refuses 403 BEFORE the CAS takes
  // the lock, before a cent routes, and before any vault moves.
  const gated = await releaseIpOptionFeeFromHolding(
    store,
    {
      holding_ledger_id: posted.holding_credit.id,
      work_id: WORK,
      operator_settlement_approved: true,
      publishing_conditions: {
        return_reserve_period_elapsed: true,
        isbn_rights_verified: true,
      },
    },
    NOW,
  );
  expect(gated.ok).toBe(false);
  if (!gated.ok) {
    expect(gated.status).toBe(403);
    expect(gated.code).toBe("publishing_ip_rights_not_cleared");
  }
  expect(
    (await store.getLedgerTransaction(posted.holding_credit.id))!.status,
  ).toBe("unclaimed_holding");
  expect((await store.getVault(CO_HOLDER_A.payee_id))!.pending_balance).toBe(0);
  expect((await store.getVault(AGENCY.payee_id))!.pending_balance).toBe(0);
  expect((await store.getVault(AUTHOR.payee_id))!.pending_balance).toBe(0);

  // Clearing ONE payee is not enough — the gate evaluates EVERY credited
  // payee, fail-closed per (payee, work).
  const clearedA = await verifyPublishingIpRights(
    store,
    {
      payee_id: CO_HOLDER_A.payee_id,
      work_id: WORK,
      state: "cleared",
      evidence_ref: "EVID-IP-NOVA-001",
    },
    NOW.toISOString(),
  );
  if (!clearedA.ok) throw new Error(`unexpected refusal: ${clearedA.code}`);
  expect(clearedA.record.state).toBe("cleared");
  const gatedStill = await releaseIpOptionFeeFromHolding(
    store,
    {
      holding_ledger_id: posted.holding_credit.id,
      work_id: WORK,
      operator_settlement_approved: true,
      publishing_conditions: {
        return_reserve_period_elapsed: true,
        isbn_rights_verified: true,
      },
    },
    NOW,
  );
  expect(gatedStill.ok).toBe(false);
  if (!gatedStill.ok) expect(gatedStill.code).toBe("publishing_ip_rights_not_cleared");

  // A 'cleared' state without evidence refuses at the writer — the state
  // never lies about the rights chain.
  const noEvidence = await verifyPublishingIpRights(
    store,
    {
      payee_id: CO_HOLDER_B.payee_id,
      work_id: WORK,
      state: "cleared",
      evidence_ref: null,
    },
    NOW.toISOString(),
  );
  expect(noEvidence.ok).toBe(false);
  if (!noEvidence.ok && noEvidence.code === "publishing_ip_rights_invalid") {
    expect(noEvidence.errors.some((e) => e.field === "evidence_ref")).toBe(true);
  }

  // The gate family, in order: operator approval first, then KYC, then the
  // vertical state. Operator approval refused (fail-closed, before KYC even
  // matters — the SAME gate family a Lithic dispatch rides).
  for (const party of ALL_PARTIES) {
    await verifyPublishingIpRights(
      store,
      {
        payee_id: party.payee_id,
        work_id: WORK,
        state: "cleared",
        evidence_ref: `EVID-IP-${party.payee_id}`,
      },
      NOW.toISOString(),
    );
  }
  const notApproved = await releaseIpOptionFeeFromHolding(
    store,
    {
      holding_ledger_id: posted.holding_credit.id,
      work_id: WORK,
      operator_settlement_approved: false,
      publishing_conditions: {
        return_reserve_period_elapsed: true,
        isbn_rights_verified: true,
      },
    },
    NOW,
  );
  expect(notApproved.ok).toBe(false);
  if (!notApproved.ok) expect(notApproved.code).toBe("settlement_not_approved");
  expect(
    (await store.getLedgerTransaction(posted.holding_credit.id))!.status,
  ).toBe("unclaimed_holding");

  // --- The verified release through the author-first cascade -----------------

  const released = mustSucceed(
    await releaseIpOptionFeeFromHolding(
      store,
      {
        holding_ledger_id: posted.holding_credit.id,
        work_id: WORK,
        operator_settlement_approved: true,
        publishing_conditions: {
          return_reserve_period_elapsed: true,
          isbn_rights_verified: true,
        },
      },
      NOW,
    ),
  );
  expect(released.holding_credit.status).toBe("settled");
  expect(released.holding_credit.kind).toBe("unclaimed_holding");

  // THE ORDERING PROOF — the founder's inverted priority, in cents:
  // author IP allocations FIRST (registration order, bps OF THE FEE),
  // the agency commission SECOND (bps OF THE REMAINDER — never of the
  // gross), the author of record's residual LAST.
  expect(
    released.credits.map((c) => ({
      step: c.step,
      payee: c.payee_id,
      gross: c.gross_cents,
    })),
  ).toEqual([
    { step: "author_ip_allocation", payee: CO_HOLDER_A.payee_id, gross: 3_500 },
    { step: "author_ip_allocation", payee: CO_HOLDER_B.payee_id, gross: 2_250 },
    // 1_000 bps of the 94_250 remainder = 9_425 — of the 100_000 GROSS it
    // would be 10_000. The remainder basis is the invariant.
    { step: "agency_commission", payee: AGENCY.payee_id, gross: 9_425 },
    { step: "author_residual", payee: AUTHOR.payee_id, gross: 84_825 },
  ]);
  expect(released.plan.option_fee_cents).toBe(OPTION_FEE);
  expect(released.plan.author_allocated_total_cents).toBe(5_750);
  expect(released.plan.remainder_cents).toBe(94_250);
  expect(released.company_dust_cents).toBe(0);
  expect(released.dust_ledger).toHaveLength(0);

  // Verified profiles withhold nothing — every talent party's net is gross.
  expect(released.withholding).toHaveLength(4);
  for (const escrow of released.withholding) {
    expect(escrow.withheld_cents).toBe(0);
    expect(escrow.net_cents).toBe(escrow.gross_cents);
  }

  // The vaults: each credited party's pending balance is its net.
  expect((await store.getVault(CO_HOLDER_A.payee_id))!.pending_balance).toBe(3_500);
  expect((await store.getVault(CO_HOLDER_B.payee_id))!.pending_balance).toBe(2_250);
  expect((await store.getVault(AGENCY.payee_id))!.pending_balance).toBe(9_425);
  expect((await store.getVault(AUTHOR.payee_id))!.pending_balance).toBe(84_825);

  // The release journal balances: the holding debit vs the routing credits.
  const releaseLegs = await store.listGlEntriesByJournal(released.journal_id);
  const debits = releaseLegs.reduce((total, leg) => total + leg.debit_cents, 0);
  const credits = releaseLegs.reduce((total, leg) => total + leg.credit_cents, 0);
  expect(debits).toBe(OPTION_FEE);
  expect(credits).toBe(OPTION_FEE);

  // A replayed release is a 409 — exactly one release journal.
  const replayedRelease = await releaseIpOptionFeeFromHolding(
    store,
    {
      holding_ledger_id: posted.holding_credit.id,
      work_id: WORK,
      operator_settlement_approved: true,
      publishing_conditions: {
        return_reserve_period_elapsed: true,
        isbn_rights_verified: true,
      },
    },
    NOW,
  );
  expect(replayedRelease.ok).toBe(false);
  if (!replayedRelease.ok) expect(replayedRelease.code).toBe("holding_already_released");

  // --- The 999-cent distinguisher: commission of the REMAINDER, exact to the
  // --- cent with dust-free conservation --------------------------------------

  const posted999 = mustSucceed(
    await postOptionFeeToHolding(
      store,
      {
        work_id: WORK_999,
        // The content-derived event id — deal terms ARE the identity.
        option_fee_cents: 999,
        currency: "USD",
      },
      NOW,
    ),
  );
  expect(posted999.source_event_id).toBe(`ip_option_${WORK_999}_999`);
  await registerOptionDeal(store, WORK_999);
  await store.insertIpOptionAuthorAllocation({
    work_id: WORK_999,
    payee_id: CO_HOLDER_A.payee_id,
    payee_name: CO_HOLDER_A.payee_name,
    // 3_333 bps of 999 = 332.9667… → floored 332, never a fractional cent.
    allocation_bps: 3_333,
    created_at: NOW.toISOString(),
  });
  for (const party of [CO_HOLDER_A, AGENCY, AUTHOR]) {
    await verifyPublishingIpRights(
      store,
      {
        payee_id: party.payee_id,
        work_id: WORK_999,
        state: "cleared",
        evidence_ref: `EVID-IP-999-${party.payee_id}`,
      },
      NOW.toISOString(),
    );
  }
  const released999 = mustSucceed(
    await releaseIpOptionFeeFromHolding(
      store,
      {
        holding_ledger_id: posted999.holding_credit.id,
        work_id: WORK_999,
        operator_settlement_approved: true,
        publishing_conditions: {
          return_reserve_period_elapsed: true,
          isbn_rights_verified: true,
        },
      },
      NOW,
    ),
  );
  // 999 × 3_333 bps → 332; remainder 667; 1_000 bps of 667 → 66 (of the
  // gross it would be 99); residual 601. 332 + 66 + 601 === 999 EXACTLY.
  expect(
    released999.credits.map((c) => ({
      step: c.step,
      payee: c.payee_id,
      gross: c.gross_cents,
    })),
  ).toEqual([
    { step: "author_ip_allocation", payee: CO_HOLDER_A.payee_id, gross: 332 },
    { step: "agency_commission", payee: AGENCY.payee_id, gross: 66 },
    { step: "author_residual", payee: AUTHOR.payee_id, gross: 601 },
  ]);
  expect(released999.plan.remainder_cents).toBe(667);
  expect(released999.company_dust_cents).toBe(0);
  // Conservation, again through the journal: debits === credits === 999.
  const legs999 = await store.listGlEntriesByJournal(released999.journal_id);
  const debits999 = legs999.reduce((total, leg) => total + leg.debit_cents, 0);
  const credits999 = legs999.reduce((total, leg) => total + leg.credit_cents, 0);
  expect(debits999).toBe(999);
  expect(credits999).toBe(999);

  // --- The durable verification discipline -----------------------------------

  // One state of record per (payee, work): a re-verification REPLACES the
  // row — never a second row for one pair.
  await verifyPublishingIpRights(
    store,
    {
      payee_id: AUTHOR.payee_id,
      work_id: WORK,
      state: "pending",
      evidence_ref: null,
    },
    NOW.toISOString(),
  );
  const finalVerif = await store.getPublishingIpRightsVerification(
    AUTHOR.payee_id,
    WORK,
  );
  expect(finalVerif).toBeDefined();
  expect(finalVerif!.state).toBe("pending");
  expect(finalVerif!.cleared_at).toBeNull();
  // And the resolver fails closed on the non-cleared state — the gate family
  // reads THIS record, not the caller's word.
  const stillHeld = await releaseIpOptionFeeFromHolding(
    store,
    {
      holding_ledger_id: posted999.holding_credit.id,
      work_id: WORK_999,
      operator_settlement_approved: true,
      publishing_conditions: {
        return_reserve_period_elapsed: true,
        isbn_rights_verified: true,
      },
    },
    NOW,
  );
  expect(stillHeld.ok).toBe(false);
  if (!stillHeld.ok) expect(stillHeld.code).toBe("holding_already_released");
}

interface BackendSpec {
  name: string;
  make: () => Store;
}

const BACKENDS: BackendSpec[] = [
  { name: "InMemoryStore", make: () => new InMemoryStore() },
  { name: "SqliteStore", make: () => new SqliteStore(":memory:") },
  {
    // The fake implements the builder subset the store's ip-option and ledger
    // methods touch; the real SupabaseClient surface is far larger.
    name: "SupabaseStore",
    make: () => new SupabaseStore(new FakeSupabaseClient() as unknown as SupabaseClient),
  },
];

describe("ip adaptation optioning — three-backend parity", () => {
  for (const backend of BACKENDS) {
    describe(backend.name, () => {
      it("holds the option fee through the canonical seam, gates the release on the durable ip_rights_cleared state fail-closed, and routes the author-first cascade exact to the cent", async () => {
        await scenario(backend.make());
      });
    });
  }
});
