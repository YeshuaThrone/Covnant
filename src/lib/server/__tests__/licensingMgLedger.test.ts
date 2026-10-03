// The MG recoupment ledger + the automatic shortfall invoice (PR 33) —
// the behavioral suite for the founder's advance directive: category-isolated
// versus cross-collateralized recoupment (the $250,000 footwear MG versus the
// separate apparel MG), the shortfall debit at contract term close, and the
// Don ledger invariants — integer cents, idempotency (a replayed event
// recoups once, a replayed close never re-prices), position-locked
// applications, and the append-only truth as the recouped position's
// arbiter.

import { describe, expect, it } from "vitest";

import { InMemoryStore } from "@/lib/server/inMemoryStore";
import type { Store } from "@/lib/server/store";
import {
  buildMgRecoupmentPlan,
  closeLicensingMgTerm,
  recoupLicensingRoyaltyEvent,
} from "@/lib/server/licensingMgLedger";
import type { LicensingRoyaltyDealRecord } from "@/modules/licensing/records";

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

const T0 = new Date("2026-09-30T12:00:00.000Z");
const FOOTWEAR_SCOPE = "license:LIC-FOOTWEAR-001";
const APPAREL_CATEGORY = "apparel";
const FOOTWEAR_CATEGORY = "footwear";
const LICENSEE_A = "licensee-northwind";
const $250_000 = 25_000_000; // cents
const $100_000 = 10_000_000; // cents

function makeStore(): Store {
  return new InMemoryStore();
}

function dealFixture(overrides: Partial<LicensingRoyaltyDealRecord> = {}): LicensingRoyaltyDealRecord {
  return {
    id: "deal-footwear-001",
    scope_key: FOOTWEAR_SCOPE,
    license_id: "LIC-FOOTWEAR-001",
    currency: "USD",
    tiers: [{ upToCents: null, rateBps: 800 }],
    agency_commission_bps: null,
    licensor_a_payee_id: "payee-founder",
    licensor_a_payee_name: "Covnant Founder",
    licensor_a_country: "US",
    licensor_b_payee_id: null,
    licensor_b_payee_name: null,
    licensor_b_country: null,
    withholding_default_bps: null,
    cumulative_net_sales_cents: 0,
    cumulative_royalty_cents: 0,
    version: 1,
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

async function seedDeal(store: Store, overrides?: Partial<LicensingRoyaltyDealRecord>) {
  const deal = dealFixture(overrides);
  await store.upsertLicensingRoyaltyDeal(deal);
  return deal;
}

async function seedCommitment(
  store: Store,
  input: {
    scope_key?: string;
    commitment_ref?: string;
    category_code?: string;
    collateralization?: "category_isolated" | "cross_collateralized";
    mg_amount_cents?: number;
    licensee_id?: string;
    licensee_name?: string;
  },
) {
  return store.upsertLicensingMgCommitment({
    scope_key: input.scope_key ?? FOOTWEAR_SCOPE,
    commitment_ref: input.commitment_ref ?? "MG-2026-001",
    category_code: input.category_code ?? FOOTWEAR_CATEGORY,
    collateralization: input.collateralization ?? "category_isolated",
    mg_amount_cents: input.mg_amount_cents ?? $250_000,
    currency: "USD",
    licensee_id: input.licensee_id ?? LICENSEE_A,
    licensee_name: input.licensee_name ?? "Northwind Retail Group",
    recouped_cents: 0,
  });
}

async function seedRoyaltyApplication(
  store: Store,
  deal: LicensingRoyaltyDealRecord,
  sourceEventId: string,
  licensorAGross: number,
  licensorBGross = 0,
  cumulativeBeforeCents = 0,
) {
  return store.insertLicensingRoyaltyApplication({
    deal_id: deal.id,
    scope_key: deal.scope_key,
    source_event_id: sourceEventId,
    period: "2026-Q3",
    net_sales_cents: licensorAGross + licensorBGross,
    cumulative_before_cents: cumulativeBeforeCents,
    royalty_cents: licensorAGross + licensorBGross,
    slices: [
      {
        tierIndex: 0,
        rateBps: 800,
        sliceCents: licensorAGross + licensorBGross,
        royaltyCents: licensorAGross + licensorBGross,
      },
    ],
    agency_commission_cents: 0,
    licensor_a_gross_cents: licensorAGross,
    licensor_b_gross_cents: licensorBGross,
    dust_cents: 0,
    withholding_rate_bps: null,
    licensor_a_withheld_cents: 0,
    licensor_b_withheld_cents: 0,
    withholding_ref: null,
  });
}

// ---------------------------------------------------------------------------
// The pure recoupment router — the collateralization directive.
// ---------------------------------------------------------------------------

describe("buildMgRecoupmentPlan — the collateralization routing", () => {
  it("routes category-isolated royalties to the matching category's advance only — the directive's footwear vs apparel example", () => {
    const footwearAdvance = {
      id: "mg-footwear",
      category_code: FOOTWEAR_CATEGORY,
      collateralization: "category_isolated" as const,
      mg_amount_cents: $250_000,
      recouped_cents: 0,
      created_at: "2026-08-01T00:00:00.000Z",
    };
    const apparelAdvance = {
      id: "mg-apparel",
      category_code: APPAREL_CATEGORY,
      collateralization: "category_isolated" as const,
      mg_amount_cents: $100_000,
      recouped_cents: 0,
      created_at: "2026-08-01T00:00:00.000Z",
    };
    const planned = buildMgRecoupmentPlan({
      earned_royalty_cents: 50_000,
      category_code: FOOTWEAR_CATEGORY,
      commitments: [footwearAdvance, apparelAdvance],
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.value).toEqual([
      { commitment_id: "mg-footwear", recouped_cents: 50_000 },
    ]);
  });

  it("splits a royalty across isolated lanes by category — neither advance ever touches the other's royalties", () => {
    const commitments = [
      {
        id: "mg-footwear",
        category_code: FOOTWEAR_CATEGORY,
        collateralization: "category_isolated" as const,
        mg_amount_cents: 30_000,
        recouped_cents: 0,
        created_at: "2026-08-01T00:00:00.000Z",
      },
      {
        id: "mg-apparel",
        category_code: APPAREL_CATEGORY,
        collateralization: "category_isolated" as const,
        mg_amount_cents: 30_000,
        recouped_cents: 0,
        created_at: "2026-08-01T00:00:00.000Z",
      },
    ];
    const footwearPlan = buildMgRecoupmentPlan({
      earned_royalty_cents: 20_000,
      category_code: FOOTWEAR_CATEGORY,
      commitments,
    });
    const apparelPlan = buildMgRecoupmentPlan({
      earned_royalty_cents: 20_000,
      category_code: APPAREL_CATEGORY,
      commitments,
    });
    expect(footwearPlan.ok && footwearPlan.value).toEqual([
      { commitment_id: "mg-footwear", recouped_cents: 20_000 },
    ]);
    expect(apparelPlan.ok && apparelPlan.value).toEqual([
      { commitment_id: "mg-apparel", recouped_cents: 20_000 },
    ]);
  });

  it("cross-collateralized advances recoup from any category, after the matching isolated lane", () => {
    const commitments = [
      {
        id: "mg-cross",
        category_code: FOOTWEAR_CATEGORY,
        collateralization: "cross_collateralized" as const,
        mg_amount_cents: 30_000,
        recouped_cents: 0,
        created_at: "2026-08-02T00:00:00.000Z",
      },
      {
        id: "mg-isolated",
        category_code: FOOTWEAR_CATEGORY,
        collateralization: "category_isolated" as const,
        mg_amount_cents: 10_000,
        recouped_cents: 0,
        created_at: "2026-08-01T00:00:00.000Z",
      },
    ];
    const planned = buildMgRecoupmentPlan({
      earned_royalty_cents: 15_000,
      category_code: FOOTWEAR_CATEGORY,
      commitments,
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    // The matching isolated advance takes its full capacity first, then the
    // cross-collateralized advance takes the remainder.
    expect(planned.value).toEqual([
      { commitment_id: "mg-isolated", recouped_cents: 10_000 },
      { commitment_id: "mg-cross", recouped_cents: 5_000 },
    ]);
  });

  it("isolates by created_at inside a lane — the oldest matching advance recoups first", () => {
    const commitments = [
      {
        id: "mg-newer",
        category_code: FOOTWEAR_CATEGORY,
        collateralization: "category_isolated" as const,
        mg_amount_cents: 30_000,
        recouped_cents: 0,
        created_at: "2026-09-01T00:00:00.000Z",
      },
      {
        id: "mg-older",
        category_code: FOOTWEAR_CATEGORY,
        collateralization: "category_isolated" as const,
        mg_amount_cents: 30_000,
        recouped_cents: 0,
        created_at: "2026-08-01T00:00:00.000Z",
      },
    ];
    const planned = buildMgRecoupmentPlan({
      earned_royalty_cents: 5_000,
      category_code: FOOTWEAR_CATEGORY,
      commitments,
    });
    expect(planned.ok && planned.value).toEqual([
      { commitment_id: "mg-older", recouped_cents: 5_000 },
    ]);
  });

  it("refuses a non-integer royalty and stops at a fully-recouped advance", () => {
    const refused = buildMgRecoupmentPlan({
      earned_royalty_cents: 1_000.5,
      category_code: FOOTWEAR_CATEGORY,
      commitments: [],
    });
    expect(refused.ok).toBe(false);
    const exhausted = buildMgRecoupmentPlan({
      earned_royalty_cents: 5_000,
      category_code: FOOTWEAR_CATEGORY,
      commitments: [
        {
          id: "mg-full",
          category_code: FOOTWEAR_CATEGORY,
          collateralization: "category_isolated" as const,
          mg_amount_cents: 10_000,
          recouped_cents: 10_000,
          created_at: "2026-08-01T00:00:00.000Z",
        },
      ],
    });
    expect(exhausted.ok && exhausted.value).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The recoupment pass on the committed application of record.
// ---------------------------------------------------------------------------

describe("recoupLicensingRoyaltyEvent — the store-backed pass", () => {
  it("offsets the committed application's post-agency earned royalty across the scope's advances", async () => {
    const store = makeStore();
    const deal = await seedDeal(store);
    await seedCommitment(store, {});
    await seedRoyaltyApplication(store, deal, "evt-1", 1_000_000);

    const recouped = await recoupLicensingRoyaltyEvent(store, {
      deal_id: deal.id,
      source_event_id: "evt-1",
      category_code: FOOTWEAR_CATEGORY,
    });
    expect(recouped.ok).toBe(true);
    if (!recouped.ok) return;
    expect(recouped.value.applications).toHaveLength(1);
    expect(recouped.value.applications[0].recouped_cents).toBe(1_000_000);
    expect(recouped.value.unreconciled_royalty_cents).toBe(0);

    // The commitment's healed counter reflects the offset.
    const commitment = await store.getLicensingMgCommitment(FOOTWEAR_SCOPE, "MG-2026-001");
    expect(commitment?.recouped_cents).toBe(1_000_000);
  });

  it("is idempotent by event — a replayed recoupment is a counted no-op that never double-applies", async () => {
    const store = makeStore();
    const deal = await seedDeal(store);
    await seedCommitment(store, {});
    await seedRoyaltyApplication(store, deal, "evt-1", 1_000_000);

    const first = await recoupLicensingRoyaltyEvent(store, {
      deal_id: deal.id,
      source_event_id: "evt-1",
      category_code: FOOTWEAR_CATEGORY,
    });
    expect(first.ok).toBe(true);
    const replay = await recoupLicensingRoyaltyEvent(store, {
      deal_id: deal.id,
      source_event_id: "evt-1",
      category_code: FOOTWEAR_CATEGORY,
    });
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.value.applications).toEqual([]);
    expect(replay.value.unreconciled_royalty_cents).toBe(1_000_000);

    const applications = await store.listLicensingMgRecoupmentApplications(
      (await store.getLicensingMgCommitment(FOOTWEAR_SCOPE, "MG-2026-001"))!.id,
    );
    expect(applications).toHaveLength(1);
    const appliedTotal = applications.reduce((total, row) => total + row.recouped_cents, 0);
    expect(appliedTotal).toBe(1_000_000);
  });

  it("chains positions across events — each application's before/after conserves exactly", async () => {
    const store = makeStore();
    const deal = await seedDeal(store);
    const commitment = await seedCommitment(store, {});
    await seedRoyaltyApplication(store, deal, "evt-1", 400_000, 0, 0);
    await seedRoyaltyApplication(store, deal, "evt-2", 400_000, 0, 400_000);

    await recoupLicensingRoyaltyEvent(store, {
      deal_id: deal.id,
      source_event_id: "evt-1",
      category_code: FOOTWEAR_CATEGORY,
    });
    await recoupLicensingRoyaltyEvent(store, {
      deal_id: deal.id,
      source_event_id: "evt-2",
      category_code: FOOTWEAR_CATEGORY,
    });

    const applications = await store.listLicensingMgRecoupmentApplications(commitment.id);
    expect(applications).toHaveLength(2);
    const [first, second] = applications;
    expect(first.recouped_before_cents).toBe(0);
    expect(first.recouped_after_cents).toBe(400_000);
    expect(second.recouped_before_cents).toBe(400_000);
    expect(second.recouped_after_cents).toBe(800_000);
    // The append-only truth is the position's arbiter: the chain sums to
    // the recouped position.
    expect(applications.reduce((total, row) => total + row.recouped_cents, 0)).toBe(800_000);
  });

  it("refuses an unknown application and a zero-royalty application fail-closed", async () => {
    const store = makeStore();
    const deal = await seedDeal(store);
    const missing = await recoupLicensingRoyaltyEvent(store, {
      deal_id: deal.id,
      source_event_id: "evt-none",
      category_code: FOOTWEAR_CATEGORY,
    });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.code).toBe("royalty_application_not_found");

    await seedRoyaltyApplication(store, deal, "evt-zero", 0);
    const zero = await recoupLicensingRoyaltyEvent(store, {
      deal_id: deal.id,
      source_event_id: "evt-zero",
      category_code: FOOTWEAR_CATEGORY,
    });
    expect(zero.ok).toBe(false);
    if (zero.ok) return;
    expect(zero.code).toBe("no_earned_royalty");
  });

  it("honors category isolation end to end — footwear royalties never recoup the apparel advance", async () => {
    const store = makeStore();
    const deal = await seedDeal(store, { scope_key: FOOTWEAR_SCOPE });
    const footwear = await seedCommitment(store, {
      commitment_ref: "MG-FOOTWEAR",
      category_code: FOOTWEAR_CATEGORY,
      mg_amount_cents: $250_000,
    });
    await seedCommitment(store, {
      commitment_ref: "MG-APPAREL",
      category_code: APPAREL_CATEGORY,
      mg_amount_cents: $100_000,
    });
    await seedRoyaltyApplication(store, deal, "evt-fw-1", 60_000);

    await recoupLicensingRoyaltyEvent(store, {
      deal_id: deal.id,
      source_event_id: "evt-fw-1",
      category_code: FOOTWEAR_CATEGORY,
    });

    const footwearApplications = await store.listLicensingMgRecoupmentApplications(footwear.id);
    expect(footwearApplications).toHaveLength(1);
    // The apparel advance of record holds — footwear royalties never touch it.
    const apparel = await store.getLicensingMgCommitment(FOOTWEAR_SCOPE, "MG-APPAREL");
    expect(apparel?.recouped_cents).toBe(0);
    const apparelApplications = await store.listLicensingMgRecoupmentApplications(apparel!.id);
    expect(apparelApplications).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The term close + the automatic shortfall invoice.
// ---------------------------------------------------------------------------

describe("closeLicensingMgTerm — the shortfall debit at term close", () => {
  it("debits the invoice of record automatically when the annual MG threshold is missed", async () => {
    const store = makeStore();
    const deal = await seedDeal(store);
    const commitment = await seedCommitment(store, {});
    // Only $4,000 of the $250,000 advance recouped (one event, 400,000
    // cents) — the close prices the $246,000 shortfall (2,460,000 cents).
    await seedRoyaltyApplication(store, deal, "evt-1", 400_000);
    await recoupLicensingRoyaltyEvent(store, {
      deal_id: deal.id,
      source_event_id: "evt-1",
      category_code: FOOTWEAR_CATEGORY,
    });

    const closed = await closeLicensingMgTerm(
      store,
      {
        scope_key: FOOTWEAR_SCOPE,
        commitment_ref: "MG-2026-001",
        term: "2026",
        closed_by: "founder",
      },
      T0,
    );
    expect(closed.ok).toBe(true);
    if (!closed.ok) return;
    expect(closed.value.close.shortfall_cents).toBe($250_000 - 400_000);
    expect(closed.value.close.mg_due_cents).toBe($250_000);
    expect(closed.value.close.recouped_at_close_cents).toBe(400_000);
    expect(closed.value.replayed).toBe(false);

    // The invoice of record: kind AND status 'mg_shortfall_due', the payee
    // is the LICENSEE of record, the close key stamped in line_item_id.
    const invoice = closed.value.invoice_ledger;
    expect(invoice).not.toBeNull();
    if (!invoice) return;
    expect(invoice.kind).toBe("mg_shortfall_due");
    expect(invoice.status).toBe("mg_shortfall_due");
    expect(invoice.payee_id).toBe(LICENSEE_A);
    expect(invoice.payee_name).toBe("Northwind Retail Group");
    expect(invoice.amount_cents).toBe($250_000 - 400_000);
    expect(invoice.currency).toBe("USD");

    // The balanced GL journal rode the close.
    const journals = await store.listGlJournalsByRef(
      "licensing_mg_term_close",
      `${commitment.id}:2026`,
    );
    expect(journals).toHaveLength(1);
    expect(closed.value.journal_id).toBe(journals[0].id);
  });

  it("is once-only per (commitment, term) — a replayed close converges and never re-prices or re-invoices", async () => {
    const store = makeStore();
    const deal = await seedDeal(store);
    await seedCommitment(store, {});
    await seedRoyaltyApplication(store, deal, "evt-1", 400_000);
    await recoupLicensingRoyaltyEvent(store, {
      deal_id: deal.id,
      source_event_id: "evt-1",
      category_code: FOOTWEAR_CATEGORY,
    });

    const first = await closeLicensingMgTerm(
      store,
      { scope_key: FOOTWEAR_SCOPE, commitment_ref: "MG-2026-001", term: "2026", closed_by: "founder" },
      T0,
    );
    const replay = await closeLicensingMgTerm(
      store,
      { scope_key: FOOTWEAR_SCOPE, commitment_ref: "MG-2026-001", term: "2026", closed_by: "founder" },
      T0,
    );
    expect(first.ok && replay.ok).toBe(true);
    if (!first.ok || !replay.ok) return;
    expect(replay.value.replayed).toBe(true);
    expect(replay.value.close.id).toBe(first.value.close.id);
    expect(replay.value.close.shortfall_cents).toBe(first.value.close.shortfall_cents);
    // The replay returns the SAME invoice of record — no second debit.
    expect(replay.value.invoice_ledger?.id).toBe(first.value.invoice_ledger?.id);
    expect(replay.value.journal_id).toBeNull();
  });

  it("records a fully-recouped close with zero shortfall and moves nothing", async () => {
    const store = makeStore();
    const deal = await seedDeal(store);
    await seedCommitment(store, { mg_amount_cents: 400_000 });
    await seedRoyaltyApplication(store, deal, "evt-1", 400_000);
    await recoupLicensingRoyaltyEvent(store, {
      deal_id: deal.id,
      source_event_id: "evt-1",
      category_code: FOOTWEAR_CATEGORY,
    });

    const closed = await closeLicensingMgTerm(
      store,
      { scope_key: FOOTWEAR_SCOPE, commitment_ref: "MG-2026-001", term: "2026", closed_by: "founder" },
      T0,
    );
    expect(closed.ok).toBe(true);
    if (!closed.ok) return;
    expect(closed.value.close.shortfall_cents).toBe(0);
    expect(closed.value.invoice_ledger).toBeNull();
    expect(closed.value.journal_id).toBeNull();
  });

  it("derives the recouped position from the append-only applications, never the healed counter", async () => {
    const store = makeStore();
    const deal = await seedDeal(store);
    const commitment = await seedCommitment(store, {});
    // Drift the counter deliberately — the close must price from the
    // applications anyway.
    await store.upsertLicensingMgCommitment({
      scope_key: commitment.scope_key,
      commitment_ref: commitment.commitment_ref,
      category_code: commitment.category_code,
      collateralization: commitment.collateralization,
      mg_amount_cents: commitment.mg_amount_cents,
      currency: commitment.currency,
      licensee_id: commitment.licensee_id,
      licensee_name: commitment.licensee_name,
      recouped_cents: 999_999,
    });
    await seedRoyaltyApplication(store, deal, "evt-1", 400_000);
    await recoupLicensingRoyaltyEvent(store, {
      deal_id: deal.id,
      source_event_id: "evt-1",
      category_code: FOOTWEAR_CATEGORY,
    });

    const closed = await closeLicensingMgTerm(
      store,
      { scope_key: FOOTWEAR_SCOPE, commitment_ref: "MG-2026-001", term: "2026", closed_by: "founder" },
      T0,
    );
    expect(closed.ok).toBe(true);
    if (!closed.ok) return;
    // The drifted counter (999,999) is ignored — the recouped position is
    // the applications' sum: one seeded event of 400,000 cents.
    expect(closed.value.close.recouped_at_close_cents).toBe(400_000);
    expect(closed.value.close.shortfall_cents).toBe($250_000 - 400_000);
  });

  it("refuses an unknown commitment, a malformed term, and a missing closer fail-closed", async () => {
    const store = makeStore();
    await seedDeal(store);
    const missing = await closeLicensingMgTerm(
      store,
      { scope_key: FOOTWEAR_SCOPE, commitment_ref: "MG-NONE", term: "2026", closed_by: "founder" },
      T0,
    );
    expect(missing.ok).toBe(false);
    if (missing.ok) {
      expect.unreachable("expected a failure result");
    }
    expect(missing.code).toBe("mg_commitment_not_found");

    await seedCommitment(store, {});
    const badTerm = await closeLicensingMgTerm(
      store,
      { scope_key: FOOTWEAR_SCOPE, commitment_ref: "MG-2026-001", term: "26", closed_by: "founder" },
      T0,
    );
    expect(badTerm.ok).toBe(false);
    if (badTerm.ok) return;
    expect(badTerm.code).toBe("invalid_mg_term");

    const badCloser = await closeLicensingMgTerm(
      store,
      { scope_key: FOOTWEAR_SCOPE, commitment_ref: "MG-2026-001", term: "2026", closed_by: "  " },
      T0,
    );
    expect(badCloser.ok).toBe(false);
    if (badCloser.ok) return;
    expect(badCloser.code).toBe("invalid_closer_identity");
  });
});
