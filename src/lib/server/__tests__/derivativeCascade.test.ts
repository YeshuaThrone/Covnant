// Derivative asset royalty cascade (PR 16) — the store-backed battery.
//
// Locked invariants under test, per the founder spatial directive: a
// derivative sale's allocator walks the parent_asset_id dependency tree
// DEPTH-FIRST and reserves every upstream creator's floor(royalty_bps ×
// gross / 10000) BEFORE the downstream modder's remainder exists
// (upstream-first ordering is structural — the grandparent reserves before
// the siblings); cycles and over-contracted trees refuse the plan
// fail-closed (naming the breaching contract) before a cent moves; a
// diamond is NOT a cycle (each edge contract fires exactly once); every
// share uses the house allocator's integer math with the rounding residue
// swept to the platform variance account; the sale's gross posts to
// UNCLAIMED_HOLDING through the canonical seam under a unique event id
// (replay → 409) and releases through the clearance-gated path — operator
// settlement approval, verified KYC, and the SPATIAL vertical's state
// (territorial zoning cleared AND spatial audit verified) evaluated per
// credited payee INCLUDING the downstream seller — a refused release moves
// NO money and leaves the credit HELD.

import { afterEach, describe, expect, it } from "vitest";

import { InMemoryStore } from "@/lib/server/inMemoryStore";
import {
  DERIVATIVE_CASCADE_VERTICAL,
  buildDerivativeCascadePlan,
  derivativeResaleEventId,
  postDerivativeSaleToHolding,
  releaseDerivativeCascade,
  validateDerivativeSaleInput,
} from "@/lib/server/derivativeCascade";
import { setVerticalComplianceStateSource } from "@/modules/compliance/payoutGate";
import type { DerivativeRoyaltyEdgeRecord } from "@/modules/don/records";
import type { Store } from "@/lib/server/store";

const NOW = new Date("2026-10-01T12:00:00Z");

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

function mustFail<V>(
  result: Success<V> | Failure | { ok: true },
  status: number,
  code: string,
): Failure {
  if (result.ok) {
    throw new Error(`expected ${status} ${code} but the call succeeded`);
  }
  expect(result.status).toBe(status);
  expect(result.code).toBe(code);
  return result;
}

// ---------------------------------------------------------------------------
// Fixtures — one sold mod with a three-route tree and a two-level chain.
// ---------------------------------------------------------------------------

const SALE = {
  asset_id: "mod:dragon-sword",
  sale_gross_cents: 10_000,
  seller_payee_id: "modder-seller",
  seller_payee_name: "Downstream Modder",
};

/** The sold mod's contracts, in the table's insertion order. */
function dragonSwordEdges(): DerivativeRoyaltyEdgeRecord[] {
  return [
    edge("mod:dragon-sword", "mesh:dragon-body", "creator-mesh", "Mesh Creator", 500),
    edge("mod:dragon-sword", "tex:dragon-skins", "creator-tex", "Texture Creator", 300),
    edge("mod:dragon-sword", "script:combat", "creator-script", "Script Creator", 200),
    edge("mesh:dragon-body", "mesh:base-rig", "creator-rig", "Rig Artist", 250),
  ];
}

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

/** An edgesFor lookup over a plain map — the pure planner's fixture. */
function mapEdges(
  rows: DerivativeRoyaltyEdgeRecord[],
): (assetId: string) => readonly DerivativeRoyaltyEdgeRecord[] {
  const byAsset = new Map<string, DerivativeRoyaltyEdgeRecord[]>();
  for (const row of rows) {
    const list = byAsset.get(row.asset_id) ?? [];
    list.push(row);
    byAsset.set(row.asset_id, list);
  }
  return (assetId) => byAsset.get(assetId) ?? [];
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

/** The spatial vertical's compliance state, fully satisfied. */
function spatialStateSatisfied(): void {
  setVerticalComplianceStateSource(async () => ({
    vertical: "spatial",
    territorial_zoning_cleared: true,
    spatial_audit_verified: true,
  }));
}

async function seedCascadeScenario(store: Store): Promise<void> {
  spatialStateSatisfied();
  await seedVerifiedParty(store, "creator-mesh", "Mesh Creator");
  await seedVerifiedParty(store, "creator-rig", "Rig Artist");
  await seedVerifiedParty(store, "creator-tex", "Texture Creator");
  await seedVerifiedParty(store, "creator-script", "Script Creator");
  await seedVerifiedParty(store, SALE.seller_payee_id, SALE.seller_payee_name);
  for (const row of dragonSwordEdges()) {
    await store.insertDerivativeRoyaltyEdge(row);
  }
}

async function postDragonSwordSale(store: Store, eventId: string) {
  return postDerivativeSaleToHolding(
    store,
    { sale: SALE, currency: "USD", event_id: eventId },
    NOW,
  );
}

const EVENT_ID = "recon:test:line:derivative-1";

afterEach(() => {
  setVerticalComplianceStateSource(null);
});

// ---------------------------------------------------------------------------
// The pure planner — exact math, upstream-first ordering, fail-closed trees.
// ---------------------------------------------------------------------------

describe("buildDerivativeCascadePlan — the allocator", () => {
  it("reserves every upstream share depth-first BEFORE the downstream remainder exists", () => {
    const plan = mustSucceed(
      buildDerivativeCascadePlan(SALE, mapEdges(dragonSwordEdges())),
    );

    // The DFS proof: the mesh's OWN parent (the rig, a grandparent of the
    // sale) reserves at step 2 — before the mod's sibling textures and
    // scripts, which reserved earlier only in the table's rows.
    expect(plan.reservations.map((r) => [r.step, r.asset_id, r.payee_id, r.royalty_cents])).toEqual([
      [1, "mod:dragon-sword", "creator-mesh", 500],
      [2, "mesh:dragon-body", "creator-rig", 250],
      [3, "mod:dragon-sword", "creator-tex", 300],
      [4, "mod:dragon-sword", "creator-script", 200],
    ]);
    expect(plan.upstream_total_cents).toBe(1_250);

    // The remainder exists only after the walk: 10000 bps − 1250 bps.
    expect(plan.downstream.share_bps).toBe(8_750);
    expect(plan.downstream.net_cents).toBe(8_750);
    expect(plan.downstream.payee_id).toBe("modder-seller");

    // Exact cents: every floor is exact on this gross — no dust.
    expect(plan.company_dust_cents).toBe(0);
    expect(
      plan.upstream_total_cents + plan.downstream.net_cents + plan.company_dust_cents,
    ).toBe(SALE.sale_gross_cents);

    // The release order: upstream first, the seller LAST.
    expect(plan.party_splits.map((s) => [s.payee_id, s.share_bps])).toEqual([
      ["creator-mesh", 500],
      ["creator-rig", 250],
      ["creator-tex", 300],
      ["creator-script", 200],
      ["modder-seller", 8_750],
    ]);
    expect(plan.party_splits.every((s) => s.role === "creator")).toBe(true);
  });

  it("sweeps integer-cent dust to the platform variance account", () => {
    const plan = mustSucceed(
      buildDerivativeCascadePlan(
        { ...SALE, sale_gross_cents: 101, asset_id: "mod:tiny" },
        mapEdges([edge("mod:tiny", "mesh:tiny", "creator-tiny", "Tiny Creator", 3_333)]),
      ),
    );
    // floor(101 × 3333 / 10000) = 33; floor(101 × 6667 / 10000) = 67.
    expect(plan.reservations[0]?.royalty_cents).toBe(33);
    expect(plan.downstream.net_cents).toBe(67);
    expect(plan.company_dust_cents).toBe(1);
    expect(33 + 67 + 1).toBe(101);
  });

  it("refuses a royalty cycle before any reservation — D→P→D, longer loops, and self-edges", () => {
    const cycle = mustFail(
      buildDerivativeCascadePlan(
        SALE,
        mapEdges([
          edge("mod:dragon-sword", "mesh:dragon-body", "creator-mesh", "Mesh Creator", 500),
          edge("mesh:dragon-body", "mod:dragon-sword", "creator-mesh", "Mesh Creator", 100),
        ]),
      ),
      422,
      "derivative_royalty_cycle",
    );
    expect(cycle.message).toContain("cycle");

    const selfEdge = mustFail(
      buildDerivativeCascadePlan(
        { ...SALE, asset_id: "mod:self" },
        mapEdges([edge("mod:self", "mod:self", "creator-self", "Self Creator", 100)]),
      ),
      422,
      "derivative_royalty_cycle",
    );
    expect(selfEdge.message).toContain("cycle");
  });

  it("refuses an over-contracted tree, naming the breaching edge and payee", () => {
    const failure = mustFail(
      buildDerivativeCascadePlan(
        { ...SALE, asset_id: "mod:greedy" },
        mapEdges([
          edge("mod:greedy", "mesh:one", "creator-one", "Creator One", 7_000),
          edge("mod:greedy", "mesh:two", "creator-two", "Creator Two", 4_000),
        ]),
      ),
      422,
      "derivative_royalty_exceeds_sale",
    );
    expect(failure.message).toContain("mesh:two");
    expect(failure.message).toContain("creator-two");
  });

  it("treats a diamond as a DAG — each edge contract fires exactly once", () => {
    const plan = mustSucceed(
      buildDerivativeCascadePlan(
        { ...SALE, asset_id: "mod:diamond", sale_gross_cents: 10_000 },
        mapEdges([
          edge("mod:diamond", "mesh:left", "creator-left", "Left Creator", 100),
          edge("mod:diamond", "mesh:right", "creator-right", "Right Creator", 100),
          edge("mesh:left", "mesh:gem", "creator-gem", "Gem Creator", 150),
          edge("mesh:right", "mesh:gem", "creator-gem", "Gem Creator", 150),
        ]),
      ),
    );
    // The gem is reached two ways — not a cycle; BOTH child→gem contracts
    // fire (distinct edges), the gem's own expansion happens once.
    expect(plan.reservations.map((r) => `${r.asset_id}->${r.parent_asset_id}`)).toEqual([
      "mod:diamond->mesh:left",
      "mesh:left->mesh:gem",
      "mod:diamond->mesh:right",
      "mesh:right->mesh:gem",
    ]);
    expect(plan.upstream_total_cents).toBe(500);
    expect(plan.downstream.share_bps).toBe(9_500);
  });

  it("rejects a malformed sale input", () => {
    const zero = validateDerivativeSaleInput({ ...SALE, sale_gross_cents: 0 });
    expect(zero?.status).toBe(422);
    expect(zero?.code).toBe("invalid_amount");

    const fractional = validateDerivativeSaleInput({ ...SALE, sale_gross_cents: 10_000.5 });
    expect(fractional?.code).toBe("invalid_amount");

    const anonymous = validateDerivativeSaleInput({ ...SALE, seller_payee_id: "" });
    expect(anonymous?.status).toBe(422);
    expect(anonymous?.code).toBe("invalid_sale_input");

    // A well-formed sale validates clean.
    expect(validateDerivativeSaleInput(SALE)).toBeUndefined();
  });

  it("treats a contract-free asset as a pass-through sale to the seller", () => {
    const plan = mustSucceed(
      buildDerivativeCascadePlan(SALE, mapEdges([])),
    );
    expect(plan.reservations).toEqual([]);
    expect(plan.downstream.share_bps).toBe(10_000);
    expect(plan.downstream.net_cents).toBe(10_000);
    expect(plan.company_dust_cents).toBe(0);
  });
});

describe("derivativeResaleEventId — the content-derived replay identity", () => {
  it("derives the same id from the same sale content, distinct per sequence and gross", () => {
    const base = {
      asset_id: "mod:dragon-sword",
      seller_payee_id: "modder-seller",
      marketplace: "gumroad",
      resale_sequence: 3,
      sale_gross_cents: 250,
    };
    expect(derivativeResaleEventId(base)).toBe(derivativeResaleEventId({ ...base }));
    expect(derivativeResaleEventId({ ...base, resale_sequence: 4 })).not.toBe(
      derivativeResaleEventId(base),
    );
    expect(derivativeResaleEventId({ ...base, sale_gross_cents: 251 })).not.toBe(
      derivativeResaleEventId(base),
    );
    expect(derivativeResaleEventId(base)).toBe(
      "derivative:resale:mod:dragon-sword:modder-seller:gumroad:3:250",
    );
  });

  it("refuses a structurally impossible input", () => {
    expect(() =>
      derivativeResaleEventId({
        asset_id: "",
        seller_payee_id: "modder-seller",
        marketplace: "gumroad",
        resale_sequence: 0,
        sale_gross_cents: 250,
      }),
    ).toThrowError(/derivative_resale_event_id_invalid/);
    expect(() =>
      derivativeResaleEventId({
        asset_id: "mod:dragon-sword",
        seller_payee_id: "modder-seller",
        marketplace: "gumroad",
        resale_sequence: -1,
        sale_gross_cents: 250,
      }),
    ).toThrowError(/derivative_resale_event_id_invalid/);
  });
});

// ---------------------------------------------------------------------------
// The post — the canonical seam, the replay guard, the lane's provenance.
// ---------------------------------------------------------------------------

describe("postDerivativeSaleToHolding — the post", () => {
  it("posts the sale gross to UNCLAIMED_HOLDING under the sale's event id", async () => {
    const store = new InMemoryStore();
    const result = mustSucceed(await postDragonSwordSale(store, EVENT_ID));

    expect(result.holding_credit.line_item_id).toBe(EVENT_ID);
    expect(result.holding_credit.kind).toBe("unclaimed_holding");
    expect(result.holding_credit.status).toBe("unclaimed_holding");
    expect(result.holding_credit.amount_cents).toBe(SALE.sale_gross_cents);

    const credits = await store.listUnclaimedHoldingCredits();
    expect(credits).toHaveLength(1);
  });

  it("refuses a replayed sale ingest with 409 — never a second credit", async () => {
    const store = new InMemoryStore();
    mustSucceed(await postDragonSwordSale(store, EVENT_ID));
    mustFail(
      await postDragonSwordSale(store, EVENT_ID),
      409,
      "unclaimed_holding_already_posted",
    );

    const credits = await store.listUnclaimedHoldingCredits();
    expect(credits).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The release — the gates, the exact cascade, the replayed-release refusal.
// ---------------------------------------------------------------------------

describe("releaseDerivativeCascade — the verified release", () => {
  it("releases the exact cascade upstream-first and settles every vault to the cent", async () => {
    const store = new InMemoryStore();
    await seedCascadeScenario(store);
    const posted = mustSucceed(await postDragonSwordSale(store, EVENT_ID));

    const result = mustSucceed(
      await releaseDerivativeCascade(
        store,
        {
          event_id: EVENT_ID,
          sale: SALE,
          operator_settlement_approved: true,
        },
        NOW,
      ),
    );

    // The plan's audit trail matches the walk, cent for cent.
    expect(result.plan.reservations.map((r) => [r.payee_id, r.royalty_cents])).toEqual([
      ["creator-mesh", 500],
      ["creator-rig", 250],
      ["creator-tex", 300],
      ["creator-script", 200],
    ]);
    expect(result.plan.downstream.net_cents).toBe(8_750);
    expect(result.plan.company_dust_cents).toBe(0);

    // Every party's vault moved by exactly its cascade share (verified
    // profiles → zero backup withholding → pending balances net).
    expect((await store.getVault("creator-mesh"))?.pending_balance).toBe(500);
    expect((await store.getVault("creator-rig"))?.pending_balance).toBe(250);
    expect((await store.getVault("creator-tex"))?.pending_balance).toBe(300);
    expect((await store.getVault("creator-script"))?.pending_balance).toBe(200);
    expect((await store.getVault("modder-seller"))?.pending_balance).toBe(8_750);

    // The per-party outcome carries the post-withholding nets in order.
    expect(
      result.release.party_credits.map((c) => [c.payee_id, c.net_cents]),
    ).toEqual([
      ["creator-mesh", 500],
      ["creator-rig", 250],
      ["creator-tex", 300],
      ["creator-script", 200],
      ["modder-seller", 8_750],
    ]);
    expect(result.release.withholding.every((e) => e.withheld_cents === 0)).toBe(true);
    expect(result.release.dust_ledger).toHaveLength(0);

    // The credit flipped to settled — the release is the only path that
    // flips it, and the flip has WON before any money moved.
    expect(result.release.holding_credit.status).toBe("settled");
    expect(result.release.holding_credit.id).toBe(posted.holding_credit.id);
  });

  it("refuses a replayed release with 404 — the settled credit is no longer held", async () => {
    const store = new InMemoryStore();
    await seedCascadeScenario(store);
    mustSucceed(await postDragonSwordSale(store, EVENT_ID));
    mustSucceed(
      await releaseDerivativeCascade(
        store,
        { event_id: EVENT_ID, sale: SALE, operator_settlement_approved: true },
        NOW,
      ),
    );

    const replay = mustFail(
      await releaseDerivativeCascade(
        store,
        { event_id: EVENT_ID, sale: SALE, operator_settlement_approved: true },
        NOW,
      ),
      404,
      "holding_credit_not_found",
    );
    expect(replay.message).toContain(EVENT_ID);

    // The second release moved nothing further.
    expect((await store.getVault("creator-mesh"))?.pending_balance).toBe(500);
    expect((await store.getVault("modder-seller"))?.pending_balance).toBe(8_750);
  });

  it("refuses with the credit left HELD when operator settlement is not approved", async () => {
    const store = new InMemoryStore();
    await seedCascadeScenario(store);
    mustSucceed(await postDragonSwordSale(store, EVENT_ID));

    mustFail(
      await releaseDerivativeCascade(
        store,
        { event_id: EVENT_ID, sale: SALE, operator_settlement_approved: false },
        NOW,
      ),
      403,
      "settlement_not_approved",
    );

    // Nothing moved: every vault is untouched and the credit is still held.
    for (const payee of ["creator-mesh", "creator-rig", "creator-tex", "creator-script", "modder-seller"]) {
      expect((await store.getVault(payee))?.pending_balance).toBe(0);
    }
    const credits = await store.listUnclaimedHoldingCredits();
    expect(credits).toHaveLength(1);
  });

  it("refuses with the credit left HELD when the downstream seller's KYC is unverified", async () => {
    const store = new InMemoryStore();
    spatialStateSatisfied();
    for (const [id, name] of [
      ["creator-mesh", "Mesh Creator"],
      ["creator-rig", "Rig Artist"],
      ["creator-tex", "Texture Creator"],
      ["creator-script", "Script Creator"],
    ] as const) {
      await seedVerifiedParty(store, id, name);
    }
    // The seller has a vault but NO verified KYC — the gate evaluates the
    // downstream modder exactly as it evaluates an upstream creator.
    await store.upsertVault({
      payee_id: SALE.seller_payee_id,
      payee_name: SALE.seller_payee_name,
      available_balance: 0,
      pending_balance: 0,
      reserve_balance: 0,
      updated_at: NOW.toISOString(),
    });
    for (const row of dragonSwordEdges()) {
      await store.insertDerivativeRoyaltyEdge(row);
    }
    mustSucceed(await postDragonSwordSale(store, EVENT_ID));

    mustFail(
      await releaseDerivativeCascade(
        store,
        { event_id: EVENT_ID, sale: SALE, operator_settlement_approved: true },
        NOW,
      ),
      403,
      // No KYC row exists for the seller at all — the gate reports the
      // state as UNKNOWN and fails closed (the fail-closed posture).
      "kyc_state_unknown",
    );

    // Fail-closed: not even the VERIFIED upstream creators moved.
    for (const payee of ["creator-mesh", "creator-rig", "creator-tex", "creator-script"]) {
      expect((await store.getVault(payee))?.pending_balance).toBe(0);
    }
    const credits = await store.listUnclaimedHoldingCredits();
    expect(credits).toHaveLength(1);
  });

  it("refuses with the credit left HELD when the spatial vertical's state is not satisfied", async () => {
    const store = new InMemoryStore();
    await seedCascadeScenario(store);
    mustSucceed(await postDragonSwordSale(store, EVENT_ID));

    // Zoning cleared but the spatial audit unverified — a mid-state refusal.
    setVerticalComplianceStateSource(async () => ({
      vertical: "spatial",
      territorial_zoning_cleared: true,
      spatial_audit_verified: false,
    }));
    mustFail(
      await releaseDerivativeCascade(
        store,
        { event_id: EVENT_ID, sale: SALE, operator_settlement_approved: true },
        NOW,
      ),
      403,
      "spatial_audit_unverified",
    );

    // State entirely unknown — fail-closed.
    setVerticalComplianceStateSource(async () => null);
    mustFail(
      await releaseDerivativeCascade(
        store,
        { event_id: EVENT_ID, sale: SALE, operator_settlement_approved: true },
        NOW,
      ),
      403,
      "vertical_state_unknown",
    );

    const credits = await store.listUnclaimedHoldingCredits();
    expect(credits).toHaveLength(1);
  });

  it("refuses the release when the tree fails closed — a cycle added after posting", async () => {
    const store = new InMemoryStore();
    await seedCascadeScenario(store);
    mustSucceed(await postDragonSwordSale(store, EVENT_ID));

    // The tree turns malformed after the sale posted: the rig's parent
    // points back at the sold mod.
    await store.insertDerivativeRoyaltyEdge(
      edge("mesh:base-rig", "mod:dragon-sword", "creator-rig", "Rig Artist", 100),
    );

    mustFail(
      await releaseDerivativeCascade(
        store,
        { event_id: EVENT_ID, sale: SALE, operator_settlement_approved: true },
        NOW,
      ),
      422,
      "derivative_royalty_cycle",
    );

    // The credit is still held — a malformed tree never releases.
    const credits = await store.listUnclaimedHoldingCredits();
    expect(credits).toHaveLength(1);
  });

  it("refuses a release for a sale event that never posted", async () => {
    const store = new InMemoryStore();
    await seedCascadeScenario(store);
    mustFail(
      await releaseDerivativeCascade(
        store,
        { event_id: "recon:test:never-posted", sale: SALE, operator_settlement_approved: true },
        NOW,
      ),
      404,
      "holding_credit_not_found",
    );
  });
});

describe("DERIVATIVE_CASCADE_VERTICAL", () => {
  it("releases through the spatial vertical's compliance gate", () => {
    expect(DERIVATIVE_CASCADE_VERTICAL).toBe("spatial");
  });
});
