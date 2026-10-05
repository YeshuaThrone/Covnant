// Webtoon studio splits + per-language translation cascades (PR 20) —
// three-backend parity, mirroring the VTuber-agency and film-escrow parity
// pattern: ONE identical scenario script runs on InMemoryStore, SqliteStore
// (:memory:), and SupabaseStore over a behavioral PostgREST fake.
//
// Under test, identically on every backend: the per-language escrow lock
// (kind AND status both 'translation_localization_pending', the FBO debit +
// per-language escrow-credit journal, replay 409 per source, zero vault
// movement), the verified release through the per-language cascade (the
// amortized localization-cost recovery FIRST, the localizer's royalty before
// any studio share, the role-group bands in founder vocabulary order, the
// primary author's residual LAST — dust swept), the publishing vertical's
// fail-closed payout gate (a missing KYC refuses 403 BEFORE the CAS takes
// the lock, before a line is consumed, and before any vault moves), the CAS
// settle (a replayed release is a 409 — exactly one release journal), the
// rev-share fee mode, and the ISOLATED recoupment pools (print advance and
// digital coin unlock never share a cent; the position lock arbitrates).

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { InMemoryStore } from "@/lib/server/inMemoryStore";
import { SqliteStore } from "@/lib/server/sqliteStore";
import { SupabaseStore } from "@/lib/server/supabaseStore";
import type { Store } from "@/lib/server/store";
import {
  applyWebtoonRecoupment,
  postTranslationRoyaltyToEscrow,
  releaseTranslationLocalizationEscrow,
} from "@/lib/server/webtoonStudioCascade";
import {
  translationLocalizationGlAccount,
  translationLocalizationPayeeId,
  translationLocalizationPayeeName,
} from "@/modules/don/constants";
import { setVerticalComplianceStateSource } from "@/modules/compliance/payoutGate";

type Row = Record<string, unknown>;

// ---------------------------------------------------------------------------
// The PostgREST fake — generic insert/upsert/select/update builders plus the
// apply_vault_delta rpc. Unique constraints arrive as a LIST (a table may
// carry several — the recoupment application's replay key and its position
// lock are two independent constraints).
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
      // fails with 23505, the exact shape the insert-as-lock arbiter catches.
      return {
        row: undefined,
        error: {
          message: `duplicate key value violates unique constraint "webtoon_unique"`,
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
      table === "webtoon_studio_split_roles"
        ? [["series_id", "role_group", "payee_id"]]
        : table === "webtoon_localization_contracts"
          ? [["series_id", "language_code"]]
          : table === "webtoon_localization_cost_schedules"
            ? [["schedule_ref"]]
            : table === "webtoon_localization_cost_lines"
              ? [["schedule_ref", "line_index"]]
              : table === "webtoon_recoupment_pools"
                ? [["series_id", "pool_class"]]
                : table === "webtoon_recoupment_applications"
                  ? [
                      ["pool_id", "source_event_id"],
                      ["pool_id", "recouped_before_cents"],
                    ]
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
const SERIES = "studio-atlas";
const LANG = "es";
const JA_LANG = "ja";
const RECEIPT_CENTS = 100_000; // $1,000.00
const JA_RECEIPT_CENTS = 50_000;
const SCHEDULE_REF = "loc-atlas-es-01";
const CONTRACT_REF = "atlas-studio-agmt-2026-14";
const SCHEDULE_TOTAL = 40_000;
const SCHEDULE_PERIODS = 4; // line 0 = 10_000 exactly
const LOCALIZER = { payee_id: "payee-localizer-es", payee_name: "Localizer ES" };
const AUTHOR = { payee_id: "payee-author-atlas", payee_name: "Atlas (author)" };
const ROLE_MEMBERS = [
  { role_group: "original_creator_storywriter" as const, payee_id: "payee-zoe", payee_name: "Zoe", share_bps: 3_500 },
  { role_group: "line_artist_inker" as const, payee_id: "payee-ivan", payee_name: "Ivan", share_bps: 2_500 },
  { role_group: "colorist_background" as const, payee_id: "payee-mila", payee_name: "Mila", share_bps: 1_200 },
];
const RECOUP_SERIES = "recoup-atlas";
const PRINT_ADVANCE = 50_000;
const COIN_ADVANCE = 30_000;

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

async function registerStudioSchedule(
  store: Store,
  seriesId: string,
): Promise<void> {
  for (const member of ROLE_MEMBERS) {
    await store.insertWebtoonStudioSplitRole({
      series_id: seriesId,
      role_group: member.role_group,
      payee_id: member.payee_id,
      payee_name: member.payee_name,
      share_bps: member.share_bps,
      contract_ref: CONTRACT_REF,
      created_at: NOW.toISOString(),
    });
  }
}

async function scenario(store: Store): Promise<void> {
  setVerticalComplianceStateSource(async () => ({
    vertical: "publishing",
    ip_rights_cleared: true,
    return_reserve_period_elapsed: true,
    isbn_rights_verified: true,
  }));

  // --- The per-language escrow lock -----------------------------------------

  const posted = mustSucceed(
    await postTranslationRoyaltyToEscrow(
      store,
      {
        series_id: SERIES,
        language_code: LANG,
        amount_cents: RECEIPT_CENTS,
        currency: "USD",
        source: { type: "match_queue", event_id: "webtoon:coin:evt-es-1" },
      },
      NOW,
    ),
  );
  const escrowPayeeId = translationLocalizationPayeeId(SERIES, LANG);
  expect(posted.escrow_credit.kind).toBe("translation_localization_pending");
  expect(posted.escrow_credit.status).toBe("translation_localization_pending");
  expect(posted.escrow_credit.payee_id).toBe(escrowPayeeId);
  expect(posted.escrow_credit.payee_name).toBe(
    translationLocalizationPayeeName(SERIES, LANG),
  );

  const replayedPost = await postTranslationRoyaltyToEscrow(
    store,
    {
      series_id: SERIES,
      language_code: LANG,
      amount_cents: RECEIPT_CENTS,
      currency: "USD",
      source: { type: "match_queue", event_id: "webtoon:coin:evt-es-1" },
    },
    NOW,
  );
  expect(replayedPost.ok).toBe(false);
  if (!replayedPost.ok) expect(replayedPost.code).toBe("translation_royalty_already_posted");

  const postLegs = await store.listGlEntriesByJournal(posted.journal_id);
  expect(postLegs).toHaveLength(2);
  const fbo = postLegs.find((leg) => leg.account === "fbo_cash")!;
  expect(fbo.debit_cents).toBe(RECEIPT_CENTS);
  const escrowLeg = postLegs.find(
    (leg) => leg.account === translationLocalizationGlAccount(SERIES, LANG),
  )!;
  expect(escrowLeg.credit_cents).toBe(RECEIPT_CENTS);

  // The lock: no vault for the escrow payee, the row is the pending list's
  // only entry.
  expect(await store.getVault(escrowPayeeId)).toBeUndefined();
  const pending = await store.listTranslationLocalizationEscrowCredits();
  expect(pending.map((r) => r.id)).toEqual([posted.escrow_credit.id]);

  // --- The verified release through the per-language cascade ----------------

  await seedVerifiedParty(store, LOCALIZER.payee_id, LOCALIZER.payee_name);
  await seedVerifiedParty(store, AUTHOR.payee_id, AUTHOR.payee_name);
  for (const member of ROLE_MEMBERS) {
    await seedVerifiedParty(store, member.payee_id, member.payee_name);
  }
  await registerStudioSchedule(store, SERIES);
  await store.upsertWebtoonLocalizationContract({
    series_id: SERIES,
    language_code: LANG,
    localizer_payee_id: LOCALIZER.payee_id,
    localizer_payee_name: LOCALIZER.payee_name,
    fee_mode: "flat_fee",
    per_chapter_flat_fee_cents: 25_000,
    rev_share_bps: 0,
    contract_ref: CONTRACT_REF,
    created_at: NOW.toISOString(),
  });
  await store.insertWebtoonLocalizationCostSchedule({
    schedule_ref: SCHEDULE_REF,
    series_id: SERIES,
    language_code: LANG,
    total_cost_cents: SCHEDULE_TOTAL,
    amortization_periods: SCHEDULE_PERIODS,
    cost_agreement_ref: CONTRACT_REF,
    created_at: NOW.toISOString(),
  });

  const released = mustSucceed(
    await releaseTranslationLocalizationEscrow(
      store,
      {
        escrow_ledger_id: posted.escrow_credit.id,
        author_payee_id: AUTHOR.payee_id,
        author_payee_name: AUTHOR.payee_name,
        amortization_schedule_ref: SCHEDULE_REF,
        operator_settlement_approved: true,
      },
      NOW,
    ),
  );
  expect(released.escrow_credit.status).toBe("settled");
  expect(released.escrow_credit.kind).toBe("translation_localization_pending");
  // The amortization line: deterministic line 0, capped by the escrow.
  expect(released.amortization).toEqual({
    line_index: 0,
    computed_cents: 10_000,
    applied_cents: 10_000,
  });
  // The cascade, in the founder's mandated order: cost recovery FIRST, the
  // localizer SECOND (before any studio share), the role groups in band
  // vocabulary order, the primary author LAST.
  expect(
    released.credits.map((c) => ({ step: c.step, payee: c.payee_id, gross: c.gross_cents })),
  ).toEqual([
    { step: "localization_cost_recovery", payee: "platform", gross: 10_000 },
    { step: "localizer_royalty", payee: LOCALIZER.payee_id, gross: 25_000 },
    { step: "studio_role", payee: "payee-zoe", gross: 22_750 },
    { step: "studio_role", payee: "payee-ivan", gross: 16_250 },
    { step: "studio_role", payee: "payee-mila", gross: 7_800 },
    { step: "primary_author_net", payee: AUTHOR.payee_id, gross: 18_200 },
  ]);
  expect(released.company_dust_cents).toBe(0);
  // Verified profiles withhold nothing — every talent party's net is gross.
  expect(released.withholding).toHaveLength(5);
  for (const escrow of released.withholding) {
    expect(escrow.withheld_cents).toBe(0);
    expect(escrow.net_cents).toBe(escrow.gross_cents);
  }

  // The vaults: each credited party's pending balance is its net; the house
  // payee holds the cost recovery. No reserve, no available moved.
  expect((await store.getVault(LOCALIZER.payee_id))!.pending_balance).toBe(25_000);
  expect((await store.getVault("payee-zoe"))!.pending_balance).toBe(22_750);
  expect((await store.getVault("payee-ivan"))!.pending_balance).toBe(16_250);
  expect((await store.getVault("payee-mila"))!.pending_balance).toBe(7_800);
  expect((await store.getVault(AUTHOR.payee_id))!.pending_balance).toBe(18_200);
  expect((await store.getVault("platform"))!.pending_balance).toBe(10_000);

  // The release journal balances: the escrow debit vs the routing credits.
  const releaseLegs = await store.listGlEntriesByJournal(released.journal_id);
  const debits = releaseLegs.reduce((total, leg) => total + leg.debit_cents, 0);
  const credits = releaseLegs.reduce((total, leg) => total + leg.credit_cents, 0);
  expect(debits).toBe(RECEIPT_CENTS);
  expect(credits).toBe(RECEIPT_CENTS);

  // The pending list is empty after the settle; a replayed release 409s.
  expect(await store.listTranslationLocalizationEscrowCredits()).toHaveLength(0);
  const replayedRelease = await releaseTranslationLocalizationEscrow(
    store,
    {
      escrow_ledger_id: posted.escrow_credit.id,
      author_payee_id: AUTHOR.payee_id,
      author_payee_name: AUTHOR.payee_name,
      amortization_schedule_ref: SCHEDULE_REF,
      operator_settlement_approved: true,
    },
    NOW,
  );
  expect(replayedRelease.ok).toBe(false);
  if (!replayedRelease.ok) expect(replayedRelease.code).toBe("escrow_already_released");

  // --- The fail-closed gate: a missing KYC refuses BEFORE the CAS, before a
  // --- line is consumed, and before any vault moves -------------------------

  // A second feed (Japanese) on the same series: the colorist has no KYC
  // record of her own... she does (seeded). Use an UNSEEDED role member —
  // register a second role for the ja feed's release? The registry is
  // per-series. Instead: an unseeded AUTHOR — the residual holder without
  // KYC refuses the whole cascade.
  const jaPosted = mustSucceed(
    await postTranslationRoyaltyToEscrow(
      store,
      {
        series_id: SERIES,
        language_code: JA_LANG,
        amount_cents: JA_RECEIPT_CENTS,
        currency: "USD",
        source: { type: "recon_job", job_id: "recon-ja-1" },
      },
      NOW,
    ),
  );
  await store.upsertWebtoonLocalizationContract({
    series_id: SERIES,
    language_code: JA_LANG,
    localizer_payee_id: LOCALIZER.payee_id,
    localizer_payee_name: LOCALIZER.payee_name,
    fee_mode: "rev_share",
    per_chapter_flat_fee_cents: 0,
    rev_share_bps: 3_000,
    contract_ref: CONTRACT_REF,
    created_at: NOW.toISOString(),
  });
  const unseededAuthor = { payee_id: "payee-author-ja", payee_name: "JA Author" };
  const gated = await releaseTranslationLocalizationEscrow(
    store,
    {
      escrow_ledger_id: jaPosted.escrow_credit.id,
      author_payee_id: unseededAuthor.payee_id,
      author_payee_name: unseededAuthor.payee_name,
      amortization_schedule_ref: null,
      operator_settlement_approved: true,
    },
    NOW,
  );
  expect(gated.ok).toBe(false);
  // No KYC record AT ALL — the gate cannot even name the state (fail closed).
  if (!gated.ok) expect(gated.code).toBe("kyc_state_unknown");
  // Nothing moved: the escrow is still locked, no vault was minted for the
  // author, and the localizer's rev share did not land.
  expect((await store.getLedgerTransaction(jaPosted.escrow_credit.id))!.status).toBe(
    "translation_localization_pending",
  );
  expect(await store.getVault(unseededAuthor.payee_id)).toBeUndefined();
  expect((await store.getVault(LOCALIZER.payee_id))!.pending_balance).toBe(25_000);

  // A KYC record that exists but is NOT verified — the second fail-closed
  // refusal, also before the CAS and before any vault moves.
  await store.insertKycVerification({
    creator_id: unseededAuthor.payee_id,
    plaid_link_token: "link-token",
    plaid_public_token: "public-token",
    status: "pending",
    identity_json: "{}",
    failure_reason: null,
    created_at: NOW.toISOString(),
    verified_at: null,
  });
  const gatedPending = await releaseTranslationLocalizationEscrow(
    store,
    {
      escrow_ledger_id: jaPosted.escrow_credit.id,
      author_payee_id: unseededAuthor.payee_id,
      author_payee_name: unseededAuthor.payee_name,
      amortization_schedule_ref: null,
      operator_settlement_approved: true,
    },
    NOW,
  );
  expect(gatedPending.ok).toBe(false);
  if (!gatedPending.ok) expect(gatedPending.code).toBe("kyc_not_verified");
  expect((await store.getVault(unseededAuthor.payee_id)) ?? null).toBeNull();

  // Seed the author; the rev-share release then succeeds: 3_000 bps of the
  // 50_000 feed = 15_000 localizer, 35_000 cascade net.
  await store.insertKycVerification({
    creator_id: unseededAuthor.payee_id,
    plaid_link_token: "link-token",
    plaid_public_token: "public-token",
    status: "verified",
    identity_json: "{}",
    failure_reason: null,
    created_at: NOW.toISOString(),
    verified_at: NOW.toISOString(),
  });
  await store.upsertCreatorTaxProfile({
    creator_id: unseededAuthor.payee_id,
    tin_verified: 1,
    w9_on_file: 1,
    updated_at: NOW.toISOString(),
  });
  await store.upsertVault({
    payee_id: unseededAuthor.payee_id,
    payee_name: unseededAuthor.payee_name,
    available_balance: 0,
    pending_balance: 0,
    reserve_balance: 0,
    updated_at: NOW.toISOString(),
  });
  const jaReleased = mustSucceed(
    await releaseTranslationLocalizationEscrow(
      store,
      {
        escrow_ledger_id: jaPosted.escrow_credit.id,
        author_payee_id: unseededAuthor.payee_id,
        author_payee_name: unseededAuthor.payee_name,
        amortization_schedule_ref: null,
        operator_settlement_approved: true,
      },
      NOW,
    ),
  );
  expect(jaReleased.amortization).toBeNull();
  expect(jaReleased.plan.localizer.royalty_cents).toBe(15_000);
  expect(jaReleased.plan.studio.studio_pool_cents).toBe(35_000);
  expect(jaReleased.credits[0]!.step).toBe("localizer_royalty");
  expect(jaReleased.credits[jaReleased.credits.length - 1]!.step).toBe("primary_author_net");

  // --- The isolated recoupment pools -----------------------------------------

  const printPool = await store.upsertWebtoonRecoupmentPool({
    series_id: RECOUP_SERIES,
    pool_class: "print_advance",
    advance_cents: PRINT_ADVANCE,
    currency: "USD",
    status: "active",
    recouped_cents: 0,
    advance_agreement_ref: "atlas-print-adv-2026-03",
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  });
  const coinPool = await store.upsertWebtoonRecoupmentPool({
    series_id: RECOUP_SERIES,
    pool_class: "digital_coin_unlock",
    advance_cents: COIN_ADVANCE,
    currency: "USD",
    status: "active",
    recouped_cents: 0,
    advance_agreement_ref: "atlas-coin-adv-2026-05",
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  });

  // An unregistered pool refuses.
  const unregistered = await applyWebtoonRecoupment(
    store,
    {
      series_id: "no-such-series",
      pool_class: "print_advance",
      source_event_id: "print:evt-0",
      revenue_cents: 1_000,
    },
    NOW,
  );
  expect(unregistered.ok).toBe(false);
  if (!unregistered.ok) expect(unregistered.code).toBe("recoupment_pool_not_registered");

  // The print lane: 20_000 applied, active; the coin pool untouched.
  const printOne = mustSucceed(
    await applyWebtoonRecoupment(
      store,
      {
        series_id: RECOUP_SERIES,
        pool_class: "print_advance",
        source_event_id: "print:evt-1",
        revenue_cents: 20_000,
      },
      NOW,
    ),
  );
  expect(printOne.applied_cents).toBe(20_000);
  expect(printOne.remaining_cents).toBe(30_000);
  expect(printOne.pool_status).toBe("active");
  expect(printOne.application!.recouped_before_cents).toBe(0);

  // A replayed print event is a 409 — never a double recovery.
  const printReplay = await applyWebtoonRecoupment(
    store,
    {
      series_id: RECOUP_SERIES,
      pool_class: "print_advance",
      source_event_id: "print:evt-1",
      revenue_cents: 20_000,
    },
    NOW,
  );
  expect(printReplay.ok).toBe(false);
  if (!printReplay.ok) expect(printReplay.code).toBe("recoupment_event_already_applied");

  // The coin lane recoups ITS OWN pool fully — the print pool does not move.
  const coinOne = mustSucceed(
    await applyWebtoonRecoupment(
      store,
      {
        series_id: RECOUP_SERIES,
        pool_class: "digital_coin_unlock",
        source_event_id: "coin:evt-1",
        revenue_cents: 30_000,
      },
      NOW,
    ),
  );
  expect(coinOne.applied_cents).toBe(30_000);
  expect(coinOne.pool_status).toBe("recouped");

  // ISOLATION: the print pool's counter is still 20_000 — the coin event
  // never crossed.
  expect((await store.getWebtoonRecoupmentPool(RECOUP_SERIES, "print_advance"))!.recouped_cents)
    .toBe(20_000);
  expect((await store.getWebtoonRecoupmentPool(RECOUP_SERIES, "digital_coin_unlock"))!.status)
    .toBe("recouped");

  // A coin event beyond the recouped pool is a zero-applied no-op.
  const coinAfter = mustSucceed(
    await applyWebtoonRecoupment(
      store,
      {
        series_id: RECOUP_SERIES,
        pool_class: "digital_coin_unlock",
        source_event_id: "coin:evt-2",
        revenue_cents: 5_000,
      },
      NOW,
    ),
  );
  expect(coinAfter.applied_cents).toBe(0);
  expect(coinAfter.application).toBeNull();
  expect(coinAfter.pool_status).toBe("recouped");

  // The print lane completes exactly at the advance: 20_000 + 20_000 + 10_000.
  const printTwo = mustSucceed(
    await applyWebtoonRecoupment(
      store,
      {
        series_id: RECOUP_SERIES,
        pool_class: "print_advance",
        source_event_id: "print:evt-2",
        revenue_cents: 20_000,
      },
      NOW,
    ),
  );
  expect(printTwo.pool_status).toBe("active");
  const printThree = mustSucceed(
    await applyWebtoonRecoupment(
      store,
      {
        series_id: RECOUP_SERIES,
        pool_class: "print_advance",
        source_event_id: "print:evt-3",
        revenue_cents: 10_000,
      },
      NOW,
    ),
  );
  expect(printThree.applied_cents).toBe(10_000);
  expect(printThree.remaining_cents).toBe(0);
  expect(printThree.pool_status).toBe("recouped");

  // The POSITION lock: a direct insert at an occupied (pool_id,
  // recouped_before_cents) position is the unique refusal — the
  // insert-as-lock arbiter a concurrent application loses on. Same for the
  // replay key.
  await expect(
    store.insertWebtoonRecoupmentApplication({
      pool_id: printPool.id,
      pool_class: "print_advance",
      source_event_id: "print:evt-x",
      recouped_before_cents: 20_000,
      applied_cents: 1_000,
      remaining_cents: 29_000,
      created_at: NOW.toISOString(),
    }),
  ).rejects.toThrow(/23505|UNIQUE|unique/i);
  await expect(
    store.insertWebtoonRecoupmentApplication({
      pool_id: printPool.id,
      pool_class: "print_advance",
      source_event_id: "print:evt-1",
      recouped_before_cents: 999,
      applied_cents: 1_000,
      remaining_cents: 29_000,
      created_at: NOW.toISOString(),
    }),
  ).rejects.toThrow(/23505|UNIQUE|unique/i);
  void coinPool; // The coin pool's id is asserted through its lane above.

  // The applications list per pool: three print rows in position order, one
  // coin row — the append-only recovery truth.
  const printApplications = await store.listWebtoonRecoupmentApplications(printPool.id);
  expect(printApplications.map((r) => r.source_event_id)).toEqual([
    "print:evt-1",
    "print:evt-2",
    "print:evt-3",
  ]);
  expect(printApplications.map((r) => r.recouped_before_cents)).toEqual([0, 20_000, 40_000]);
}

interface BackendSpec {
  name: string;
  make: () => Store;
}

const BACKENDS: BackendSpec[] = [
  { name: "InMemoryStore", make: () => new InMemoryStore() },
  { name: "SqliteStore", make: () => new SqliteStore(":memory:") },
  {
    // The fake implements the builder subset the store's webtoon and ledger
    // methods touch; the real SupabaseClient surface is far larger.
    name: "SupabaseStore",
    make: () => new SupabaseStore(new FakeSupabaseClient() as unknown as SupabaseClient),
  },
];

describe("webtoon studio splits + translation cascades — three-backend parity", () => {
  for (const backend of BACKENDS) {
    describe(backend.name, () => {
      it("locks and replay-guards the per-language escrow, releases through the cascade in founder order behind the fail-closed gate, and keeps print-advance recoupment isolated from coin unlocks under the position lock", async () => {
        await scenario(backend.make());
      });
    });
  }
});
