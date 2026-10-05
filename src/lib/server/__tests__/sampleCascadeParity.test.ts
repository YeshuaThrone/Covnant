// Music sample cascade and statutory cover mechanicals (PR 17) —
// three-backend parity, mirroring the derivative-cascade parity pattern: ONE
// identical scenario script runs on InMemoryStore, SqliteStore (:memory:),
// and SupabaseStore over a behavioral PostgREST fake.
//
// Under test, identically on every backend: the line's gross posts to
// UNCLAIMED_HOLDING through the canonical seam (fbo_cash debit + holding
// credit stamped with the queue event id, replay → 409, zero vault
// movement), the sample cascade reserves the clearance chain DEPTH-FIRST —
// upstream before downstream — with exact floor(bps × gross / 10000)
// reservations and the net artist/producer splits computed only after the
// walk, the cover version routes its statutory mechanical pool to the
// original publishers FIRST and the remainder to the recording artist, dust
// sweeps to the platform, the fail-closed gates (settlement approval,
// verified KYC, the MUSIC vertical's rights-separation state) evaluate per
// credited payee, refused credits remain HELD with no vault movement, the
// journals balance, and each credit settles exactly once (a replayed
// release reads 404 — the settled row is no longer held).

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { InMemoryStore } from "@/lib/server/inMemoryStore";
import { SqliteStore } from "@/lib/server/sqliteStore";
import { SupabaseStore } from "@/lib/server/supabaseStore";
import type { Store } from "@/lib/server/store";
import {
  releaseCoverMechanical,
  releaseSampleCascade,
  STATUTORY_MECHANICAL_RATE_TABLE_VERSION,
} from "@/lib/server/sampleCascade";
import { postToUnclaimedHolding } from "@/lib/server/unclaimedHolding";
import { GL_ACCOUNT_UNCLAIMED_HOLDING } from "@/modules/don/constants";
import { setVerticalComplianceStateSource } from "@/modules/compliance/payoutGate";
import type {
  CompositionPublisherRecord,
  SampleClearanceEdgeRecord,
} from "@/modules/don/records";
import type { SplitPartyInput } from "@/lib/don/types";

type Row = Record<string, unknown>;

// ---------------------------------------------------------------------------
// The PostgREST fake — generic insert/upsert/select builders plus the
// apply_vault_delta RPC, identical to the derivative-cascade scaffold.
// ---------------------------------------------------------------------------

class FakeTable {
  private rows: Row[] = [];
  private sequence = 0;

  constructor(private readonly uniqueColumns: string[]) {}

  private violatesUnique(row: Row): boolean {
    if (this.uniqueColumns.length === 0) return false;
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
      return {
        row: undefined,
        error: {
          message: `duplicate key value violates unique constraint "sample_cascade_unique"`,
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
    const uniques =
      table === "sample_clearance_edges"
        ? ["work_id", "parent_composition_id", "rights_holder_payee_id", "rights_type"]
        : table === "composition_publishers"
          ? ["composition_id", "publisher_payee_id"]
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
// The shared scenario — ONE identical flow on every backend.
// ---------------------------------------------------------------------------

const NOW = new Date("2026-10-01T12:00:00Z");
const SAMPLE_EVENT_ID = "recon:test:parity:sample-1";
const COVER_EVENT_ID = "recon:test:parity:cover-1";
const GATE_EVENT_ID = "recon:test:parity:gate-1";
const GROSS_CENTS = 10_000;

/** The two-sample chain: D samples P1's master; P1 interpolates P2's master. */
const EDGES: Array<Omit<SampleClearanceEdgeRecord, "id">> = [
  sampleEdge("D", "P1", "master", "label-heartbreak", "Heartbreak Records", 1_250),
  sampleEdge("P1", "P2", "master", "label-grand", "Grand Master Holdings", 2_500),
];

function sampleEdge(
  workId: string,
  parentCompositionId: string,
  rightsType: "master" | "publishing",
  payeeId: string,
  payeeName: string,
  licenseBps: number,
): Omit<SampleClearanceEdgeRecord, "id"> {
  return {
    work_id: workId,
    parent_composition_id: parentCompositionId,
    rights_type: rightsType,
    rights_holder_payee_id: payeeId,
    rights_holder_payee_name: payeeName,
    license_bps: licenseBps,
    clearance_agreement_ref: `AGR-${workId}-${parentCompositionId}`,
    created_at: NOW.toISOString(),
  };
}

const PUBLISHERS: Array<Omit<CompositionPublisherRecord, "id">> = [
  {
    composition_id: "comp:original",
    publisher_payee_id: "pub-sonya",
    publisher_payee_name: "Sonya Publishing",
    share_bps: 6_000,
    created_at: NOW.toISOString(),
  },
  {
    composition_id: "comp:original",
    publisher_payee_id: "pub-motowna",
    publisher_payee_name: "Motowna Publishing",
    share_bps: 4_000,
    created_at: NOW.toISOString(),
  },
];

const NET_SPLITS: SplitPartyInput[] = [
  { payee_id: "artist-1", payee_name: "The Artist", role: "creator", share_bps: 7_000 },
  { payee_id: "producer-1", payee_name: "The Producer", role: "producer", share_bps: 3_000 },
];

const PARTIES: Array<[string, string]> = [
  ["label-heartbreak", "Heartbreak Records"],
  ["label-grand", "Grand Master Holdings"],
  ["pub-sonya", "Sonya Publishing"],
  ["pub-motowna", "Motowna Publishing"],
  ["artist-1", "The Artist"],
  ["producer-1", "The Producer"],
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

async function postLine(
  store: Store,
  eventId: string,
  amountCents: number,
): Promise<{ holding_ledger_id: string; journal_id: string }> {
  const posted = mustSucceed(
    await postToUnclaimedHolding(
      store,
      {
        amount_cents: amountCents,
        currency: "USD",
        source: { type: "match_queue", event_id: eventId },
      },
      NOW,
    ),
  );
  // The stamp the release's held-credit lookup keys on.
  expect(posted.holding_credit.line_item_id).toBe(eventId);
  expect(posted.holding_credit.kind).toBe("unclaimed_holding");
  expect(posted.holding_credit.status).toBe("unclaimed_holding");

  // The post journal: one fbo_cash debit against one holding credit.
  const legs = await store.listGlEntriesByJournal(posted.journal_id);
  expect(legs).toHaveLength(2);
  const fbo = legs.find((leg) => leg.account === "fbo_cash")!;
  expect(fbo.debit_cents).toBe(amountCents);
  const holding = legs.find((leg) => leg.account === GL_ACCOUNT_UNCLAIMED_HOLDING)!;
  expect(holding.credit_cents).toBe(amountCents);

  // The replay guard: one post per queue event id.
  const replayed = await postToUnclaimedHolding(
    store,
    {
      amount_cents: amountCents,
      currency: "USD",
      source: { type: "match_queue", event_id: eventId },
    },
    NOW,
  );
  expect(replayed.ok).toBe(false);
  if (!replayed.ok) expect(replayed.code).toBe("unclaimed_holding_already_posted");

  return { holding_ledger_id: posted.holding_credit.id, journal_id: posted.journal_id };
}

async function scenario(store: Store): Promise<void> {
  // The MUSIC vertical's compliance state, fully settled.
  setVerticalComplianceStateSource(async () => ({
    vertical: "music",
    rights_separation_settled: true,
  }));
  for (const [id, name] of PARTIES) {
    await seedVerifiedParty(store, id, name);
  }
  for (const row of EDGES) {
    await store.insertSampleClearanceEdge(row);
  }
  for (const row of PUBLISHERS) {
    await store.insertCompositionPublisher(row);
  }
  // The contracts read back in insertion order — the deterministic
  // reservation order every backend must honor, per work.
  expect((await store.getSampleClearanceEdgesByWork("D")).map((r) => r.parent_composition_id)).toEqual(["P1"]);
  expect((await store.getSampleClearanceEdgesByWork("P1")).map((r) => r.parent_composition_id)).toEqual(["P2"]);
  expect((await store.listCompositionPublishers("comp:original")).map((r) => r.publisher_payee_id)).toEqual([
    "pub-sonya",
    "pub-motowna",
  ]);

  // --- The sample cascade: post, then release upstream-first ---------------

  await postLine(store, SAMPLE_EVENT_ID, GROSS_CENTS);
  expect(await store.listUnclaimedHoldingCredits()).toHaveLength(1);

  // The lock: the post minted no vault movement — the credit is the holding
  // bucket's only footprint until a release moves money (checked before the
  // first release, the only post that precedes one).
  for (const [payeeId] of PARTIES) {
    expect((await store.getVault(payeeId))!.pending_balance).toBe(0);
  }

  const sampleReleased = mustSucceed(
    await releaseSampleCascade(
      store,
      {
        event_id: SAMPLE_EVENT_ID,
        line: {
          work_id: "D",
          rights_type: "master",
          // The release executes on the HELD amount of record — the caller's
          // restatement is overridden by the credit the seam posted.
          line_gross_cents: GROSS_CENTS,
          net_splits: NET_SPLITS,
        },
        operator_settlement_approved: true,
      },
      NOW,
    ),
  );

  // Depth-first, upstream-first: the direct sample reserves at step 1, its
  // own upstream dependency at step 2 — both before any net split math.
  expect(
    sampleReleased.plan.reservations.map(
      (r) => [r.step, r.parent_composition_id, r.royalty_cents] as const,
    ),
  ).toEqual([
    [1, "P1", 1_250],
    [2, "P2", 2_500],
  ]);
  expect(sampleReleased.plan.upstream_total_cents).toBe(3_750);
  expect(sampleReleased.plan.downstream.net_bps).toBe(6_250);
  expect(sampleReleased.plan.downstream.net_cents).toBe(6_250);
  expect(sampleReleased.plan.company_dust_cents).toBe(0);

  // Every credited party settled to the cent, upstream and downstream alike
  // (verified tax profiles — no withholding escrowed).
  expect(
    sampleReleased.release.party_credits.map(
      (p) => [p.payee_id, p.role, p.net_cents] as const,
    ),
  ).toEqual([
    ["label-heartbreak", "label", 1_250],
    ["label-grand", "label", 2_500],
    ["artist-1", "creator", 4_375],
    ["producer-1", "producer", 1_875],
  ]);
  expect((await store.getVault("label-heartbreak"))!.pending_balance).toBe(1_250);
  expect((await store.getVault("label-grand"))!.pending_balance).toBe(2_500);
  expect((await store.getVault("artist-1"))!.pending_balance).toBe(4_375);
  expect((await store.getVault("producer-1"))!.pending_balance).toBe(1_875);

  // The release journal balances; the credit settled exactly once.
  const sampleLegs = await store.listGlEntriesByJournal(sampleReleased.release.journal_id);
  expect(sampleLegs.reduce((t, leg) => t + leg.debit_cents, 0)).toBe(
    sampleLegs.reduce((t, leg) => t + leg.credit_cents, 0),
  );
  expect(sampleReleased.release.holding_credit.status).toBe("settled");
  expect(await store.listUnclaimedHoldingCredits()).toHaveLength(0);

  // A replayed release reads 404 — the settled row is no longer held.
  const sampleReplay = await releaseSampleCascade(
    store,
    {
      event_id: SAMPLE_EVENT_ID,
      line: {
        work_id: "D",
        rights_type: "master",
        line_gross_cents: GROSS_CENTS,
        net_splits: NET_SPLITS,
      },
      operator_settlement_approved: true,
    },
    NOW,
  );
  expect(sampleReplay.ok).toBe(false);
  if (!sampleReplay.ok) expect(sampleReplay.code).toBe("holding_credit_not_found");

  // --- The cover version: statutory mechanicals route publishers first ----

  await postLine(store, COVER_EVENT_ID, GROSS_CENTS);

  const coverReleased = mustSucceed(
    await releaseCoverMechanical(
      store,
      {
        event_id: COVER_EVENT_ID,
        line: {
          composition_id: "comp:original",
          recording_artist: { payee_id: "artist-1", payee_name: "The Artist" },
          statutory_mechanical: {
            rate_bps: 1_530,
            rate_table_version: STATUTORY_MECHANICAL_RATE_TABLE_VERSION,
          },
        },
        operator_settlement_approved: true,
      },
      NOW,
    ),
  );

  // The 15.30% statutory pool routes to the registered publishers by share;
  // the recording artist's remainder is computed only after the pool.
  expect(coverReleased.plan.mechanical_pool_cents).toBe(1_530);
  expect(
    coverReleased.plan.publisher_cents.map(
      (p) => [p.payee_id, p.allocated_bps, p.mechanical_cents] as const,
    ),
  ).toEqual([
    ["pub-sonya", 918, 918],
    ["pub-motowna", 612, 612],
  ]);
  expect(coverReleased.plan.artist.allocated_bps).toBe(8_470);
  expect(coverReleased.plan.artist.net_cents).toBe(8_470);
  expect(coverReleased.plan.company_dust_cents).toBe(0);
  expect(
    coverReleased.release.party_credits.map(
      (p) => [p.payee_id, p.role, p.net_cents] as const,
    ),
  ).toEqual([
    ["pub-sonya", "publisher", 918],
    ["pub-motowna", "publisher", 612],
    ["artist-1", "creator", 8_470],
  ]);

  // The artist's vault accumulates across both releases; publishers and
  // labels landed exactly their route.
  expect((await store.getVault("pub-sonya"))!.pending_balance).toBe(918);
  expect((await store.getVault("pub-motowna"))!.pending_balance).toBe(612);
  expect((await store.getVault("artist-1"))!.pending_balance).toBe(4_375 + 8_470);
  expect((await store.getVault("producer-1"))!.pending_balance).toBe(1_875);

  const coverLegs = await store.listGlEntriesByJournal(coverReleased.release.journal_id);
  expect(coverLegs.reduce((t, leg) => t + leg.debit_cents, 0)).toBe(
    coverLegs.reduce((t, leg) => t + leg.credit_cents, 0),
  );
  expect(coverReleased.release.holding_credit.status).toBe("settled");
  expect(await store.listUnclaimedHoldingCredits()).toHaveLength(0);

  const coverReplay = await releaseCoverMechanical(
    store,
    {
      event_id: COVER_EVENT_ID,
      line: {
        composition_id: "comp:original",
        recording_artist: { payee_id: "artist-1", payee_name: "The Artist" },
        statutory_mechanical: {
          rate_bps: 1_530,
          rate_table_version: STATUTORY_MECHANICAL_RATE_TABLE_VERSION,
        },
      },
      operator_settlement_approved: true,
    },
    NOW,
  );
  expect(coverReplay.ok).toBe(false);
  if (!coverReplay.ok) expect(coverReplay.code).toBe("holding_credit_not_found");

  // --- The fail-closed gates: refused credits stay HELD, vaults untouched --

  await postLine(store, GATE_EVENT_ID, 5_000);

  // Settlement approval refuses first — the clearance gate's first condition.
  const unapproved = await releaseSampleCascade(
    store,
    {
      event_id: GATE_EVENT_ID,
      line: {
        work_id: "D",
        rights_type: "master",
        line_gross_cents: 5_000,
        net_splits: NET_SPLITS,
      },
      operator_settlement_approved: false,
    },
    NOW,
  );
  expect(unapproved.ok).toBe(false);
  if (!unapproved.ok) expect(unapproved.code).toBe("settlement_not_approved");

  // An unsettled rights separation refuses per credited payee, even with
  // operator approval — the vertical's state is the gate's second lock.
  setVerticalComplianceStateSource(async () => ({
    vertical: "music",
    rights_separation_settled: false,
  }));
  const unsettled = await releaseSampleCascade(
    store,
    {
      event_id: GATE_EVENT_ID,
      line: {
        work_id: "D",
        rights_type: "master",
        line_gross_cents: 5_000,
        net_splits: NET_SPLITS,
      },
      operator_settlement_approved: true,
    },
    NOW,
  );
  expect(unsettled.ok).toBe(false);
  if (!unsettled.ok) expect(unsettled.code).toBe("music_rights_separation_unsettled");

  // Both refusals left the credit held and every vault untouched.
  const held = await store.listUnclaimedHoldingCredits();
  expect(held).toHaveLength(1);
  expect(held[0].amount_cents).toBe(5_000);
  expect((await store.getVault("label-heartbreak"))!.pending_balance).toBe(1_250);
  expect((await store.getVault("artist-1"))!.pending_balance).toBe(4_375 + 8_470);
}

interface BackendSpec {
  name: string;
  make: () => Store;
}

const BACKENDS: BackendSpec[] = [
  { name: "InMemoryStore", make: () => new InMemoryStore() },
  { name: "SqliteStore", make: () => new SqliteStore(":memory:") },
  {
    // The fake implements the builder subset the store's cascade and ledger
    // methods touch; the real SupabaseClient surface is far larger.
    name: "SupabaseStore",
    make: () => new SupabaseStore(new FakeSupabaseClient() as unknown as SupabaseClient),
  },
];

describe("music sample cascade and cover mechanicals — three-backend parity", () => {
  for (const backend of BACKENDS) {
    describe(backend.name, () => {
      it("posts and replay-guards the lines, releases the upstream-first sample cascade and publisher-first cover mechanicals to the cent, and holds refused credits", async () => {
        await scenario(backend.make());
      });
    });
  }
});
