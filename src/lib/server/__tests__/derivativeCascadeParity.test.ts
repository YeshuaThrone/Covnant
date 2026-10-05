// Derivative asset royalty cascade (PR 16) — three-backend parity, mirroring
// the VTuber-agency, film-escrow, and gaming-cashout parity pattern: ONE
// identical scenario script runs on InMemoryStore, SqliteStore (:memory:),
// and SupabaseStore over a behavioral PostgREST fake.
//
// Under test, identically on every backend: the sale's gross posts to
// UNCLAIMED_HOLDING through the canonical seam (fbo_cash debit + holding
// credit, replay → 409, zero vault movement), the release walks the
// dependency tree DEPTH-FIRST — the grandparent reserves before the
// siblings — with exact floor(bps × gross / 10000) reservations, the
// downstream modder's remainder computed only after the walk, dust swept
// to the platform, the fail-closed gates (settlement approval, verified
// KYC, the SPATIAL vertical's zoning + audit state) evaluated per credited
// payee, the journal balanced, and the credit settled exactly once (a
// replayed release reads 404 — the settled row is no longer held).

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { InMemoryStore } from "@/lib/server/inMemoryStore";
import { SqliteStore } from "@/lib/server/sqliteStore";
import { SupabaseStore } from "@/lib/server/supabaseStore";
import type { Store } from "@/lib/server/store";
import {
  postDerivativeSaleToHolding,
  releaseDerivativeCascade,
} from "@/lib/server/derivativeCascade";
import { GL_ACCOUNT_UNCLAIMED_HOLDING } from "@/modules/don/constants";
import { setVerticalComplianceStateSource } from "@/modules/compliance/payoutGate";
import type { DerivativeRoyaltyEdgeRecord } from "@/modules/don/records";

type Row = Record<string, unknown>;

// ---------------------------------------------------------------------------
// The PostgREST fake — generic insert/upsert/select builders plus the
// apply_vault_delta RPC, identical to the VTuber parity scaffold.
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
          message: `duplicate key value violates unique constraint "derivative_royalty_edges_unique"`,
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
      table === "derivative_royalty_edges"
        ? ["asset_id", "parent_asset_id", "upstream_creator_payee_id"]
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
const EVENT_ID = "recon:test:parity:derivative-1";
const GROSS_CENTS = 10_000;

const SALE = {
  asset_id: "mod:dragon-sword",
  sale_gross_cents: GROSS_CENTS,
  seller_payee_id: "modder-seller",
  seller_payee_name: "Downstream Modder",
};

const EDGES: DerivativeRoyaltyEdgeRecord[] = [
  edge("mod:dragon-sword", "mesh:dragon-body", "creator-mesh", "Mesh Creator", 500),
  edge("mod:dragon-sword", "tex:dragon-skins", "creator-tex", "Texture Creator", 300),
  edge("mod:dragon-sword", "script:combat", "creator-script", "Script Creator", 200),
  edge("mesh:dragon-body", "mesh:base-rig", "creator-rig", "Rig Artist", 250),
];

function edge(
  assetId: string,
  parentAssetId: string,
  payeeId: string,
  payeeName: string,
  royaltyBps: number,
): DerivativeRoyaltyEdgeRecord {
  return {
    id: `edge:${assetId}->${parentAssetId}:${payeeId}`,
    asset_id: assetId,
    parent_asset_id: parentAssetId,
    upstream_creator_payee_id: payeeId,
    upstream_creator_payee_name: payeeName,
    royalty_bps: royaltyBps,
    created_at: NOW.toISOString(),
  };
}

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

async function scenario(store: Store): Promise<void> {
  // The spatial vertical's compliance state, fully satisfied.
  setVerticalComplianceStateSource(async () => ({
    vertical: "spatial",
    territorial_zoning_cleared: true,
    spatial_audit_verified: true,
  }));
  for (const [id, name] of [
    ["creator-mesh", "Mesh Creator"],
    ["creator-rig", "Rig Artist"],
    ["creator-tex", "Texture Creator"],
    ["creator-script", "Script Creator"],
    ["modder-seller", "Downstream Modder"],
  ] as const) {
    await seedVerifiedParty(store, id, name);
  }
  for (const row of EDGES) {
    await store.insertDerivativeRoyaltyEdge(row);
  }
  // The contracts read back in insertion order — the deterministic
  // reservation order every backend must honor.
  expect(
    (await store.getDerivativeRoyaltyEdgesByAsset("mod:dragon-sword")).map(
      (r) => r.parent_asset_id,
    ),
  ).toEqual(["mesh:dragon-body", "tex:dragon-skins", "script:combat"]);

  // --- The post: the canonical seam, replay-guarded -------------------------

  const posted = mustSucceed(
    await postDerivativeSaleToHolding(
      store,
      { sale: SALE, currency: "USD", event_id: EVENT_ID },
      NOW,
    ),
  );
  expect(posted.holding_credit.kind).toBe("unclaimed_holding");
  expect(posted.holding_credit.status).toBe("unclaimed_holding");
  expect(posted.holding_credit.line_item_id).toBe(EVENT_ID);
  expect(posted.holding_credit.amount_cents).toBe(GROSS_CENTS);

  const replayed = await postDerivativeSaleToHolding(
    store,
    { sale: SALE, currency: "USD", event_id: EVENT_ID },
    NOW,
  );
  expect(replayed.ok).toBe(false);
  if (!replayed.ok) expect(replayed.code).toBe("unclaimed_holding_already_posted");

  // The post journal: one fbo_cash debit against one holding credit.
  const legs = await store.listGlEntriesByJournal(posted.journal_id);
  expect(legs).toHaveLength(2);
  const fbo = legs.find((leg) => leg.account === "fbo_cash")!;
  expect(fbo.debit_cents).toBe(GROSS_CENTS);
  const holding = legs.find((leg) => leg.account === GL_ACCOUNT_UNCLAIMED_HOLDING)!;
  expect(holding.credit_cents).toBe(GROSS_CENTS);

  // The lock: no vault moved, the credit is the holding bucket's only entry.
  expect(
    (await store.getVault(SALE.seller_payee_id))!.pending_balance,
  ).toBe(0);
  expect(await store.listUnclaimedHoldingCredits()).toHaveLength(1);

  // --- The verified release through the cascade -----------------------------

  const released = mustSucceed(
    await releaseDerivativeCascade(
      store,
      { event_id: EVENT_ID, sale: SALE, operator_settlement_approved: true },
      NOW,
    ),
  );

  // Depth-first, upstream-first: the rig (grandparent) reserves at step 2,
  // before the mod's sibling texture and script contracts.
  expect(
    released.plan.reservations.map((r) => [r.step, r.payee_id, r.royalty_cents]),
  ).toEqual([
    [1, "creator-mesh", 500],
    [2, "creator-rig", 250],
    [3, "creator-tex", 300],
    [4, "creator-script", 200],
  ]);
  expect(released.plan.upstream_total_cents).toBe(1_250);
  expect(released.plan.downstream.share_bps).toBe(8_750);
  expect(released.plan.downstream.net_cents).toBe(8_750);
  expect(released.plan.company_dust_cents).toBe(0);

  // Every vault settled to the cent, upstream and downstream alike.
  expect((await store.getVault("creator-mesh"))!.pending_balance).toBe(500);
  expect((await store.getVault("creator-rig"))!.pending_balance).toBe(250);
  expect((await store.getVault("creator-tex"))!.pending_balance).toBe(300);
  expect((await store.getVault("creator-script"))!.pending_balance).toBe(200);
  expect((await store.getVault("modder-seller"))!.pending_balance).toBe(8_750);

  // The release journal balances; the credit settled exactly once.
  const releaseLegs = await store.listGlEntriesByJournal(released.release.journal_id);
  const debits = releaseLegs.reduce((total, leg) => total + leg.debit_cents, 0);
  const credits = releaseLegs.reduce((total, leg) => total + leg.credit_cents, 0);
  expect(debits).toBe(credits);
  expect(released.release.holding_credit.status).toBe("settled");
  expect(released.release.holding_credit.id).toBe(posted.holding_credit.id);
  expect(await store.listUnclaimedHoldingCredits()).toHaveLength(0);

  // A replayed release reads 404 — the settled row is no longer held.
  const replayedRelease = await releaseDerivativeCascade(
    store,
    { event_id: EVENT_ID, sale: SALE, operator_settlement_approved: true },
    NOW,
  );
  expect(replayedRelease.ok).toBe(false);
  if (!replayedRelease.ok) expect(replayedRelease.code).toBe("holding_credit_not_found");
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

describe("derivative royalty cascade — three-backend parity", () => {
  for (const backend of BACKENDS) {
    describe(backend.name, () => {
      it("posts and replay-guards the sale, releases the upstream-first cascade to the cent, and settles the credit exactly once", async () => {
        await scenario(backend.make());
      });
    });
  }
});
