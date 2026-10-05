// Merchandise COGS + the brand collaboration waterfall (PR 22) — three-backend
// parity, mirroring the ipOption-cascade parity pattern: ONE identical
// scenario script runs on InMemoryStore, SqliteStore (:memory:), and
// SupabaseStore over a behavioral PostgREST fake.
//
// Under test, identically on every backend: the merch fulfillment net's
// canonical holding post through the seam (replay-guarded per content-derived
// source event), the guest designer's flat per-unit royalty billed DIRECTLY
// to one fulfillment event (the append-only billing row + the royalty's own
// holding credit — both writes independently replay-idempotent), the
// wholesale consignment settlement's exact reconciliation (a report that
// disagrees with its own arithmetic rejects whole; the shrinkage allowance
// offsets the net payout), and the verified release through the
// founder-ordered collaboration waterfall — the FIFO production debt
// amortizes FIRST (oldest lot first, keyed on sku_id AND cogs_per_unit, the
// consumption rows COMMIT before any split money moves), 100% of the fronted
// blank-sourcing and screen-printing overhead recoups to the manufacturing
// party SECOND, the artist's basis points of the post-recoupment remainder
// THIRD, the brand's residual LAST — dust-free, gated fail-closed on the
// SAME payout compliance family as a Lithic dispatch (operator settlement
// approval, Plaid-backed KYC, the merch vertical's
// physical_fulfillment_confirmed state), CAS-locked before any money moves.

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { InMemoryStore } from "@/lib/server/inMemoryStore";
import { SqliteStore } from "@/lib/server/sqliteStore";
import { SupabaseStore } from "@/lib/server/supabaseStore";
import type { Store } from "@/lib/server/store";
import {
  billDesignerRoyaltyForFulfillment,
  buildConsignmentSettlementReconciliationPlan,
  buildDesignerRoyaltyBillingPlan,
  buildDtcNetRealizedProfitPlan,
  buildMerchCollabWaterfallPlan,
  buildMerchFifoConsumptionPlan,
  buildPodNetAfterPrintingPlan,
  buildPodSplitPlan,
  postMerchFulfillmentNetToHolding,
  recordMerchConsignmentSettlement,
  releaseMerchCollabSettlement,
  registerMerchCogsLot,
  registerMerchCollabAgreement,
  registerMerchDesignerRoyaltyTier,
} from "@/lib/server/merchCollabCascade";
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
      // fails with 23505, the exact shape a replay guard catches.
      return {
        row: undefined,
        error: {
          message: `duplicate key value violates unique constraint "merch_unique"`,
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
      table === "merch_cogs_lots"
        ? [["sku_id", "lot_ref"]]
        : table === "merch_cogs_consumptions"
          ? [["lot_id", "source_event_id"]]
          : table === "merch_collab_agreements"
            ? [["sku_id"]]
            : table === "merch_collab_recoupment_applications"
              ? [["agreement_id", "pool_class", "source_event_id"]]
              : table === "merch_designer_royalty_tiers"
                ? [["sku_id"]]
                : table === "merch_designer_royalty_billings"
                  ? [["source_event_id", "sku_id"]]
                  : table === "merch_consignment_settlements"
                    ? [["event_id"]]
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
const SKU = "hoodie-atlas-limited";
const MANUFACTURER = { payee_id: "payee-manufacture-north", payee_name: "Northwind Garment Co." };
const BRAND = { payee_id: "payee-brand-atlas", payee_name: "Atlas Apparel (brand)" };
const ARTIST = { payee_id: "payee-artist-rin", payee_name: "Rin (collaborating artist)" };
const DESIGNER = { payee_id: "payee-designer-fern", payee_name: "Fern (guest designer)" };
const ALL_PARTIES = [MANUFACTURER, BRAND, ARTIST];

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
  // The vertical state source: a placeholder that must not throw — the
  // physical_fulfillment_confirmed condition arrives from the CALLER (the
  // engine merges it over whatever the source returns).
  setVerticalComplianceStateSource(async () => ({
    vertical: "merch",
    physical_fulfillment_confirmed: false,
  }));

  // --- The fulfillment net's canonical holding post ---------------------------

  // A DTC drop: $100.00 gross, $8.00 shipping, $6.50 fulfillment, $3.75
  // gateway, $3.50 designer royalty → $78.25 net realized profit posts.
  const fulfillmentEvent = "merch_fulfill_shopify_ord_9102";
  const posted = mustSucceed(
    await postMerchFulfillmentNetToHolding(
      store,
      { source_event_id: fulfillmentEvent, amount_cents: 7_825, currency: "USD" },
      NOW,
    ),
  );
  expect(posted.replayed).toBe(false);
  expect(posted.holding_credit!.kind).toBe("unclaimed_holding");
  expect(posted.holding_credit!.status).toBe("unclaimed_holding");
  expect(posted.holding_credit!.amount_cents).toBe(7_825);

  // The seam's replay guard: re-posting the same fulfillment event is the
  // counted no-op — the original row and journal stand.
  const replayedPost = await postMerchFulfillmentNetToHolding(
    store,
    { source_event_id: fulfillmentEvent, amount_cents: 7_825, currency: "USD" },
    NOW,
  );
  expect(replayedPost.ok).toBe(true);
  if (replayedPost.ok) expect(replayedPost.value.replayed).toBe(true);

  // --- The guest designer's per-unit royalty, billed to the event ------------

  await registerMerchDesignerRoyaltyTier(store, {
    sku_id: SKU,
    designer_payee_id: DESIGNER.payee_id,
    designer_payee_name: DESIGNER.payee_name,
    royalty_per_unit_cents: 350, // $3.50 per garment
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  });

  const billed = mustSucceed(
    await billDesignerRoyaltyForFulfillment(
      store,
      { fulfillment_event_id: fulfillmentEvent, sku_id: SKU, units: 3, currency: "USD" },
      NOW,
    ),
  );
  expect(billed.billing_replayed).toBe(false);
  expect(billed.royalty_post_replayed).toBe(false);
  expect(billed.billed_cents).toBe(1_050); // 3 × 350, exact
  expect(billed.units_billed).toBe(3);

  // The royalty's own holding credit exists — the designer's money is HELD
  // like every other lane's, waiting on the gate family.
  const royaltyPost = await store.listGlJournalsByRef(
    "recon_job",
    `merch_royalty_${fulfillmentEvent}`,
  );
  expect(royaltyPost.length).toBe(1);

  // The billing replay: both guards catch it — never a double billing, never
  // a double post.
  const billedReplay = mustSucceed(
    await billDesignerRoyaltyForFulfillment(
      store,
      { fulfillment_event_id: fulfillmentEvent, sku_id: SKU, units: 3, currency: "USD" },
      NOW,
    ),
  );
  expect(billedReplay.billing_replayed).toBe(true);
  expect(billedReplay.royalty_post_replayed).toBe(true);
  expect(billedReplay.billed_cents).toBe(1_050);

  // A fulfillment event on a sku with no tier bills nothing — never
  // retroactively.
  const noTier = mustSucceed(
    await billDesignerRoyaltyForFulfillment(
      store,
      { fulfillment_event_id: "merch_fulfill_shopify_ord_0000", sku_id: "sku-no-tier", units: 5, currency: "USD" },
      NOW,
    ),
  );
  expect(noTier.billed_cents).toBe(0);
  expect(noTier.billing_replayed).toBe(false);

  // --- The consignment settlement's exact reconciliation ---------------------

  // The wholesale partner's payout report: $50.00 gross, $7.50 commission,
  // $2.50 shrinkage allowance (the offset) → $40.00 net payout. The report's
  // own arithmetic reconciles exactly, so the settlement records and the net
  // payout posts to holding.
  const consignEvent = "merch_consign_wholesale_q3_evt1";
  const settled = mustSucceed(
    await recordMerchConsignmentSettlement(
      store,
      {
        event_id: consignEvent,
        period: "2026-Q3",
        location: "Boutique Row — consignment",
        sku_id: SKU,
        units_sold: 4,
        gross_cents: 5_000,
        commission_cents: 750,
        shrinkage_allowance_cents: 250,
        reported_net_payout_cents: 4_000,
        currency: "USD",
      },
      NOW,
    ),
  );
  expect(settled.settlement_replayed).toBe(false);
  expect(settled.net_payout_cents).toBe(4_000);
  expect(settled.shrinkage_allowance_cents).toBe(250);
  const consignPost = await store.listGlJournalsByRef("recon_job", consignEvent);
  expect(consignPost.length).toBe(1);

  // A report that disagrees with its own arithmetic rejects WHOLE — no row,
  // no post, never silently adjusted.
  const mismatch = await recordMerchConsignmentSettlement(
    store,
    {
      event_id: "merch_consign_wholesale_q3_evt2",
      period: "2026-Q3",
      location: "Boutique Row — consignment",
      sku_id: SKU,
      units_sold: 2,
      gross_cents: 2_500,
      commission_cents: 375,
      shrinkage_allowance_cents: 125,
      reported_net_payout_cents: 2_001, // the arithmetic says 2_000
      currency: "USD",
    },
    NOW,
  );
  expect(mismatch.ok).toBe(false);
  if (!mismatch.ok) expect(mismatch.code).toBe("payout_reconciliation_mismatch");

  // A clawback-shaped row (commission + shrinkage over the gross) refuses —
  // an operator quarantine, never a negative settlement.
  const negative = await recordMerchConsignmentSettlement(
    store,
    {
      event_id: "merch_consign_wholesale_q3_evt3",
      period: "2026-Q3",
      location: "Boutique Row — consignment",
      sku_id: SKU,
      units_sold: 1,
      gross_cents: 1_000,
      commission_cents: 900,
      shrinkage_allowance_cents: 200,
      reported_net_payout_cents: 0,
      currency: "USD",
    },
    NOW,
  );
  expect(negative.ok).toBe(false);
  if (!negative.ok) expect(negative.code).toBe("payout_reconciliation_negative");

  // --- The collab deal of record + the production lots ------------------------

  // The waterfall's money terms come from the registry, never the caller.
  await registerMerchCollabAgreement(store, {
    sku_id: SKU,
    agreement_ref: "COLLAB-HOODIE-ATLAS-2026",
    manufacturer_payee_id: MANUFACTURER.payee_id,
    manufacturer_payee_name: MANUFACTURER.payee_name,
    brand_payee_id: BRAND.payee_id,
    brand_payee_name: BRAND.payee_name,
    artist_payee_id: ARTIST.payee_id,
    artist_payee_name: ARTIST.payee_name,
    artist_split_bps: 5_000, // 50% of the post-recoupment remainder
    blank_sourcing_cents: 1_000, // $10.00 fronted blanks
    screen_printing_cents: 800, // $8.00 fronted screen setup
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  });

  // The production lots — FIFO order (created_at, lot_ref): the OLDER lot
  // carries the HIGHER per-unit cost, so the amortization order is visible
  // in the cents.
  await registerMerchCogsLot(store, {
    sku_id: SKU,
    lot_ref: "LOT-A-2026",
    units_produced: 2,
    cogs_per_unit_cents: 700,
    created_at: "2026-09-01T00:00:00Z",
  });
  await registerMerchCogsLot(store, {
    sku_id: SKU,
    lot_ref: "LOT-B-2026",
    units_produced: 10,
    cogs_per_unit_cents: 500,
    created_at: "2026-09-15T00:00:00Z",
  });

  // KYC-verified parties — the gate family still refuses on the vertical and
  // operator conditions below.
  for (const party of ALL_PARTIES) {
    await seedVerifiedParty(store, party.payee_id, party.payee_name);
  }

  // The release refuses 422 BEFORE the CAS when no agreement of record
  // exists for the sku — the money terms' only source is the registry.
  const orphanCredit = mustSucceed(
    await postMerchFulfillmentNetToHolding(
      store,
      { source_event_id: "merch_fulfill_shopify_ord_nocollab", amount_cents: 1_000, currency: "USD" },
      NOW,
    ),
  );
  const noAgreement = await releaseMerchCollabSettlement(
    store,
    {
      holding_ledger_id: orphanCredit.holding_credit!.id,
      sku_id: "sku-no-collab-deal",
      units_shipped: 1,
      operator_settlement_approved: true,
      physical_fulfillment_confirmed: true,
    },
    NOW,
  );
  expect(noAgreement.ok).toBe(false);
  if (!noAgreement.ok) {
    expect(noAgreement.status).toBe(422);
    expect(noAgreement.code).toBe("missing_merch_collab_agreement");
  }
  expect(
    (await store.getLedgerTransaction(orphanCredit.holding_credit!.id))!.status,
  ).toBe("unclaimed_holding");

  // The FIFO amortization refuses 422 when the registered production cannot
  // cover the settled units — the raw production debt cannot amortize out of
  // thin air, so no split releases over it.
  const exhaust = await releaseMerchCollabSettlement(
    store,
    {
      holding_ledger_id: orphanCredit.holding_credit!.id,
      sku_id: SKU,
      units_shipped: 13, // 12 registered units exist — 1 short
      operator_settlement_approved: true,
      physical_fulfillment_confirmed: true,
    },
    NOW,
  );
  expect(exhaust.ok).toBe(false);
  if (!exhaust.ok) {
    expect(exhaust.status).toBe(422);
    expect(exhaust.code).toBe("cogs_lots_exhausted");
  }
  expect(
    (await store.getLedgerTransaction(orphanCredit.holding_credit!.id))!.status,
  ).toBe("unclaimed_holding");

  // The gate family, fail-closed: an operator-settlement approval that never
  // came refuses BEFORE the CAS — the same family a Lithic dispatch rides.
  const notApproved = await releaseMerchCollabSettlement(
    store,
    {
      holding_ledger_id: posted.holding_credit!.id,
      sku_id: SKU,
      units_shipped: 3,
      operator_settlement_approved: false,
      physical_fulfillment_confirmed: true,
    },
    NOW,
  );
  expect(notApproved.ok).toBe(false);
  if (!notApproved.ok) expect(notApproved.code).toBe("settlement_not_approved");
  expect(
    (await store.getLedgerTransaction(posted.holding_credit!.id))!.status,
  ).toBe("unclaimed_holding");

  // The merch vertical's condition: physical_fulfillment_confirmed comes from
  // the CALLER, stated explicitly — the gate still requires it, fail-closed.
  const unfulfilled = await releaseMerchCollabSettlement(
    store,
    {
      holding_ledger_id: posted.holding_credit!.id,
      sku_id: SKU,
      units_shipped: 3,
      operator_settlement_approved: true,
      physical_fulfillment_confirmed: false,
    },
    NOW,
  );
  expect(unfulfilled.ok).toBe(false);
  if (!unfulfilled.ok) {
    expect(unfulfilled.status).toBe(403);
    expect(unfulfilled.code).toBe("merch_fulfillment_unconfirmed");
  }
  expect(
    (await store.getLedgerTransaction(posted.holding_credit!.id))!.status,
  ).toBe("unclaimed_holding");
  // Nothing moved anywhere.
  expect((await store.getVault(MANUFACTURER.payee_id))!.pending_balance).toBe(0);
  expect((await store.getVault(BRAND.payee_id))!.pending_balance).toBe(0);
  expect((await store.getVault(ARTIST.payee_id))!.pending_balance).toBe(0);

  // --- The verified release through the founder-ordered waterfall -------------

  const released = mustSucceed(
    await releaseMerchCollabSettlement(
      store,
      {
        holding_ledger_id: posted.holding_credit!.id,
        sku_id: SKU,
        units_shipped: 3,
        operator_settlement_approved: true,
        physical_fulfillment_confirmed: true,
      },
      NOW,
    ),
  );
  expect(released.holding_credit.status).toBe("settled");
  expect(released.holding_credit.kind).toBe("unclaimed_holding");

  // THE ORDERING PROOF — the founder's inverted priority, in cents. 3 units:
  // 2 from LOT-A @ 700c (1_400) + 1 from LOT-B @ 500c (500) = 1_900 COGS.
  // Settlement 7_825 → after COGS 5_925 → blank 1_000 → screen 800 →
  // remainder 4_125 → artist 5_000bps = 2_062 (floored) → brand 2_063.
  expect(
    released.credits.map((c) => ({
      step: c.step,
      payee: c.payee_id,
      gross: c.gross_cents,
    })),
  ).toEqual([
    { step: "cogs_recovery", payee: MANUFACTURER.payee_id, gross: 1_900 },
    { step: "blank_sourcing_recoupment", payee: MANUFACTURER.payee_id, gross: 1_000 },
    { step: "screen_printing_recoupment", payee: MANUFACTURER.payee_id, gross: 800 },
    { step: "artist_split", payee: ARTIST.payee_id, gross: 2_062 },
    { step: "brand_residual", payee: BRAND.payee_id, gross: 2_063 },
  ]);
  // 1_900 + 1_000 + 800 + 2_062 + 2_063 === 7_825 EXACTLY — dust-free.
  expect(released.company_dust_cents).toBe(0);
  expect(released.dust_ledger).toHaveLength(0);

  // The FIFO amortization walked OLDEST FIRST: 2 units of LOT-A before any
  // of LOT-B, each at its OWN per-unit cost.
  expect(released.fifo.legs).toEqual([
    {
      lot_id: released.fifo.legs[0]!.lot_id,
      lot_ref: "LOT-A-2026",
      units_consumed_before: 0,
      units_consumed: 2,
      cogs_per_unit_cents: 700,
      amortized_cents: 1_400,
    },
    {
      lot_id: released.fifo.legs[1]!.lot_id,
      lot_ref: "LOT-B-2026",
      units_consumed_before: 0,
      units_consumed: 1,
      cogs_per_unit_cents: 500,
      amortized_cents: 500,
    },
  ]);
  expect(released.fifo.amortized_total_cents).toBe(1_900);

  // THE WRITE-LEVEL ORDERING PROOF — the consumption rows committed before
  // any split money moved: the append-only ledger carries exactly the
  // release's lines, position-locked from 0.
  const lotAConsumptions = await store.listMerchCogsConsumptions(
    released.fifo.legs[0]!.lot_id,
  );
  expect(lotAConsumptions).toHaveLength(1);
  expect(lotAConsumptions[0]!.units_consumed_before).toBe(0);
  expect(lotAConsumptions[0]!.units_consumed).toBe(2);

  // The recoupment applications — the append-only pool truth, position-locked.
  const agreementOfRecord = (await store.getMerchCollabAgreement(SKU))!;
  const poolApplications = await store.listMerchCollabRecoupmentApplications(
    agreementOfRecord.id,
    "blank_sourcing",
  );
  expect(poolApplications).toHaveLength(1);
  expect(poolApplications[0]!.recouped_before_cents).toBe(0);
  expect(poolApplications[0]!.applied_cents).toBe(1_000);

  // Verified profiles withhold nothing — every party's net is gross.
  expect(released.withholding).toHaveLength(5);
  for (const escrow of released.withholding) {
    expect(escrow.withheld_cents).toBe(0);
    expect(escrow.net_cents).toBe(escrow.gross_cents);
  }

  // The vaults: each credited party's pending balance is its net.
  expect((await store.getVault(MANUFACTURER.payee_id))!.pending_balance).toBe(3_700);
  expect((await store.getVault(ARTIST.payee_id))!.pending_balance).toBe(2_062);
  expect((await store.getVault(BRAND.payee_id))!.pending_balance).toBe(2_063);

  // The release journal balances: the holding debit vs the routing credits.
  const releaseLegs = await store.listGlEntriesByJournal(released.journal_id);
  const debits = releaseLegs.reduce((total, leg) => total + leg.debit_cents, 0);
  const credits = releaseLegs.reduce((total, leg) => total + leg.credit_cents, 0);
  expect(debits).toBe(7_825);
  expect(credits).toBe(7_825);

  // A replayed release is a 409 — exactly one release journal, exactly one
  // set of consumption rows.
  const replayedRelease = await releaseMerchCollabSettlement(
    store,
    {
      holding_ledger_id: posted.holding_credit!.id,
      sku_id: SKU,
      units_shipped: 3,
      operator_settlement_approved: true,
      physical_fulfillment_confirmed: true,
    },
    NOW,
  );
  expect(replayedRelease.ok).toBe(false);
  if (!replayedRelease.ok) expect(replayedRelease.code).toBe("holding_already_released");

  // --- The pools closed: a second settlement splits pure profit ---------------

  // Both overhead pools fully recouped by the first release; a second
  // settlement (units 0 — the POD-settled shape) recoups nothing and splits
  // the whole remainder per contract.
  const secondPosted = mustSucceed(
    await postMerchFulfillmentNetToHolding(
      store,
      { source_event_id: "merch_fulfill_shopify_ord_9200", amount_cents: 8_000, currency: "USD" },
      NOW,
    ),
  );
  const releasedSecond = mustSucceed(
    await releaseMerchCollabSettlement(
      store,
      {
        holding_ledger_id: secondPosted.holding_credit!.id,
        sku_id: SKU,
        units_shipped: 0,
        operator_settlement_approved: true,
        physical_fulfillment_confirmed: true,
      },
      NOW,
    ),
  );
  expect(
    releasedSecond.credits.map((c) => ({
      step: c.step,
      payee: c.payee_id,
      gross: c.gross_cents,
    })),
  ).toEqual([
    { step: "artist_split", payee: ARTIST.payee_id, gross: 4_000 },
    { step: "brand_residual", payee: BRAND.payee_id, gross: 4_000 },
  ]);
  expect(releasedSecond.company_dust_cents).toBe(0);
}

// ---------------------------------------------------------------------------
// The pure-planner distinguishers — no backend, the arithmetic IS the pin.
// ---------------------------------------------------------------------------

describe("merch COGS planners — the pure distinguishers", () => {
  it("computes the DTC net-realized-profit equation exact to the cent, every leg itemized", () => {
    const planned = mustSucceed(
      buildDtcNetRealizedProfitPlan({
        gross_cents: 2_500,
        production_cogs_cents: 700,
        shipping_fee_cents: 300,
        fulfillment_fee_cents: 250,
        gateway_fee_cents: 175,
        designer_royalty_cents: 350,
      }),
    );
    // 2_500 − 700 − 300 − 250 − 175 − 350 = 725 — exact, no rounding.
    expect(planned.net_realized_profit_cents).toBe(725);
    expect(planned.production_cogs_cents).toBe(700);
    expect(planned.designer_royalty_cents).toBe(350);

    // A float or negative leg refuses — the integer-cent invariant.
    const floatLeg = buildDtcNetRealizedProfitPlan({
      gross_cents: 2_500,
      production_cogs_cents: 700.5,
      shipping_fee_cents: 300,
      fulfillment_fee_cents: 250,
      gateway_fee_cents: 175,
      designer_royalty_cents: 350,
    });
    expect(floatLeg.ok).toBe(false);
    if (!floatLeg.ok) expect(floatLeg.code).toBe("invalid_dtc_leg");

    // Deductions over the gross refuse — a refund-shaped row is an operator
    // quarantine, never a negative settlement.
    const loss = buildDtcNetRealizedProfitPlan({
      gross_cents: 1_000,
      production_cogs_cents: 1_400,
      shipping_fee_cents: 0,
      fulfillment_fee_cents: 0,
      gateway_fee_cents: 0,
      designer_royalty_cents: 0,
    });
    expect(loss.ok).toBe(false);
    if (!loss.ok) expect(loss.code).toBe("deductions_exceed_gross");
  });

  it("prices POD splits from the AFTER-PRINTING remainder, never the gross", () => {
    // The 999-cent canon: gross 999, printing 4 → the remainder 995 is the
    // split base. 3_333 bps of 995 = 331.63… → 331; of the GROSS it would be
    // 332. The basis is the invariant.
    const net = mustSucceed(buildPodNetAfterPrintingPlan(999, 4));
    expect(net.net_after_printing_cents).toBe(995);
    const split = mustSucceed(buildPodSplitPlan(net.net_after_printing_cents, 3_333));
    expect(split.split_amount_cents).toBe(331);
    expect(split.residual_cents).toBe(664);
    expect(split.split_amount_cents + split.residual_cents).toBe(995);

    // Printing over the gross refuses.
    const over = buildPodNetAfterPrintingPlan(100, 101);
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.code).toBe("printing_cost_exceeds_gross");

    // A split over 10_000 bps refuses.
    const badBps = buildPodSplitPlan(995, 10_001);
    expect(badBps.ok).toBe(false);
    if (!badBps.ok) expect(badBps.code).toBe("invalid_pod_split_bps");
  });

  it("walks the FIFO lots oldest-first at each lot's own cost and refuses exhaustion", () => {
    const lots = [
      { id: "lot-a", lot_ref: "LOT-A", units_produced: 2, cogs_per_unit_cents: 700, consumed_units: 0 },
      { id: "lot-b", lot_ref: "LOT-B", units_produced: 10, cogs_per_unit_cents: 500, consumed_units: 0 },
    ];
    const planned = mustSucceed(buildMerchFifoConsumptionPlan(lots, 5));
    expect(planned.legs).toEqual([
      { lot_id: "lot-a", lot_ref: "LOT-A", units_consumed_before: 0, units_consumed: 2, cogs_per_unit_cents: 700, amortized_cents: 1_400 },
      { lot_id: "lot-b", lot_ref: "LOT-B", units_consumed_before: 0, units_consumed: 3, cogs_per_unit_cents: 500, amortized_cents: 1_500 },
    ]);
    expect(planned.amortized_total_cents).toBe(2_900);

    // A partially-consumed lot resumes at its position — the append-only
    // truth, never a mutable counter.
    const resumed = mustSucceed(
      buildMerchFifoConsumptionPlan(
        [{ id: "lot-b", lot_ref: "LOT-B", units_produced: 10, cogs_per_unit_cents: 500, consumed_units: 3 }],
        4,
      ),
    );
    expect(resumed.legs).toEqual([
      { lot_id: "lot-b", lot_ref: "LOT-B", units_consumed_before: 3, units_consumed: 4, cogs_per_unit_cents: 500, amortized_cents: 2_000 },
    ]);

    // Exhaustion refuses — 13 units demanded, 12 registered.
    const short = buildMerchFifoConsumptionPlan(lots, 13);
    expect(short.ok).toBe(false);
    if (!short.ok) expect(short.code).toBe("cogs_lots_exhausted");
  });

  it("runs the waterfall in the founder's order: COGS first, 100% recoupment second, the split of what survives last", () => {
    // The canonical shape: settlement 7_825, COGS 1_900, pools 1_000/800,
    // artist 5_000 bps.
    const planned = mustSucceed(
      buildMerchCollabWaterfallPlan({
        settlement_cents: 7_825,
        cogs_amortized_cents: 1_900,
        blank_sourcing_open_cents: 1_000,
        screen_printing_open_cents: 800,
        artist_split_bps: 5_000,
        manufacturer: MANUFACTURER,
        brand: BRAND,
        artist: ARTIST,
      }),
    );
    expect(planned.cogs_recovery_cents).toBe(1_900);
    expect(planned.blank_sourcing_applied_cents).toBe(1_000);
    expect(planned.screen_printing_applied_cents).toBe(800);
    expect(planned.artist_split_cents).toBe(2_062);
    expect(planned.brand_residual_cents).toBe(2_063);
    expect(planned.company_dust_cents).toBe(0);
    // The legs emit in the mandated ORDER.
    expect(planned.legs.map((l) => l.step)).toEqual([
      "cogs_recovery",
      "blank_sourcing_recoupment",
      "screen_printing_recoupment",
      "artist_split",
      "brand_residual",
    ]);

    // A pool that outruns the settlement recoups PARTIALLY and the rest
    // splits per contract — the pool stays open for the next settlement.
    const partial = mustSucceed(
      buildMerchCollabWaterfallPlan({
        settlement_cents: 1_500,
        cogs_amortized_cents: 0,
        blank_sourcing_open_cents: 2_000,
        screen_printing_open_cents: 0,
        artist_split_bps: 5_000,
        manufacturer: MANUFACTURER,
        brand: BRAND,
        artist: ARTIST,
      }),
    );
    expect(partial.blank_sourcing_applied_cents).toBe(1_500);
    expect(partial.artist_split_cents).toBe(0);
    expect(partial.brand_residual_cents).toBe(0);

    // A floored artist leg never exceeds the remainder; the brand takes the
    // complement — the 999/3_333-bps canon at waterfall scale.
    const odd = mustSucceed(
      buildMerchCollabWaterfallPlan({
        settlement_cents: 999,
        cogs_amortized_cents: 0,
        blank_sourcing_open_cents: 0,
        screen_printing_open_cents: 0,
        artist_split_bps: 3_333,
        manufacturer: MANUFACTURER,
        brand: BRAND,
        artist: ARTIST,
      }),
    );
    expect(odd.artist_split_cents).toBe(332);
    expect(odd.brand_residual_cents).toBe(667);
    expect(odd.artist_split_cents + odd.brand_residual_cents).toBe(999);

    // COGS over the settlement refuses — the production debt cannot be
    // recovered out of money the settlement does not carry.
    const over = buildMerchCollabWaterfallPlan({
      settlement_cents: 500,
      cogs_amortized_cents: 900,
      blank_sourcing_open_cents: 0,
      screen_printing_open_cents: 0,
      artist_split_bps: 5_000,
      manufacturer: MANUFACTURER,
      brand: BRAND,
      artist: ARTIST,
    });
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.code).toBe("cogs_exceeds_settlement");
  });

  it("bills the flat per-unit royalty as the exact integer product", () => {
    expect(mustSucceed(buildDesignerRoyaltyBillingPlan(3, 350)).billed_cents).toBe(1_050);
    expect(mustSucceed(buildDesignerRoyaltyBillingPlan(1, 350)).billed_cents).toBe(350);
    const zeroUnits = buildDesignerRoyaltyBillingPlan(0, 350);
    expect(zeroUnits.ok).toBe(false);
    if (!zeroUnits.ok) expect(zeroUnits.code).toBe("invalid_royalty_units");
    const badTier = buildDesignerRoyaltyBillingPlan(3, 0);
    expect(badTier.ok).toBe(false);
    if (!badTier.ok) expect(badTier.code).toBe("invalid_royalty_tier");
  });

  it("reconciles the consignment report exactly and offsets the shrinkage allowance", () => {
    const reconciled = mustSucceed(
      buildConsignmentSettlementReconciliationPlan({
        gross_cents: 5_000,
        commission_cents: 750,
        shrinkage_allowance_cents: 250,
        reported_net_payout_cents: 4_000,
      }),
    );
    // The shrinkage allowance IS the offset: 5_000 − 750 − 250 = 4_000.
    expect(reconciled.net_payout_cents).toBe(4_000);

    const mismatch = buildConsignmentSettlementReconciliationPlan({
      gross_cents: 5_000,
      commission_cents: 750,
      shrinkage_allowance_cents: 250,
      reported_net_payout_cents: 3_999,
    });
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.code).toBe("payout_reconciliation_mismatch");

    const negative = buildConsignmentSettlementReconciliationPlan({
      gross_cents: 1_000,
      commission_cents: 900,
      shrinkage_allowance_cents: 200,
      reported_net_payout_cents: 0,
    });
    expect(negative.ok).toBe(false);
    if (!negative.ok) expect(negative.code).toBe("payout_reconciliation_negative");
  });
});

// ---------------------------------------------------------------------------
// The three-backend parity — the identical scenario on every store.
// ---------------------------------------------------------------------------

interface BackendSpec {
  name: string;
  make: () => Store;
}

const BACKENDS: BackendSpec[] = [
  { name: "InMemoryStore", make: () => new InMemoryStore() },
  { name: "SqliteStore", make: () => new SqliteStore(":memory:") },
  {
    // The fake implements the builder subset the store's merch, ledger, and
    // vault methods touch; the real SupabaseClient surface is far larger.
    name: "SupabaseStore",
    make: () => new SupabaseStore(new FakeSupabaseClient() as unknown as SupabaseClient),
  },
];

describe("merch COGS + collaboration waterfall — three-backend parity", () => {
  for (const backend of BACKENDS) {
    describe(backend.name, () => {
      it("posts the fulfillment net through the seam, bills the per-unit royalty and consignment settlement replay-idempotently, gates the release on the merch vertical fail-closed, and routes the founder-ordered waterfall exact to the cent", async () => {
        await scenario(backend.make());
      });
    });
  }
});
