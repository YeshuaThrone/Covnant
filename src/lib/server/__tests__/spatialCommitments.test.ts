// The spatial commitments lane (PR 37) — the behavioral suite for the
// founder's directive: the CapEx recoupment offset ledger (allowable ride
// construction and venue build-out costs deduct against early-stage IP
// royalty payouts until the builds amortize clear), the quarterly Minimum
// Spatial Guarantee whose shortfall debits the operator's invoice of
// record automatically, the temporary pop-up decommissioning audit
// (post-event inventory write-offs + site restoration reserves before any
// final escrow disbursement), and the SPATIAL_AUDIT_ESCROW (5–12% of park
// earnings locked automatically, drawn down by local entertainment sales
// taxes / safety compliance holdbacks / quarterly park concession
// reconciliations, released ONLY with a verified reconciliation of
// record). Spatial payouts gate on territorial_zoning_cleared AND
// spatial_audit_verified — fail-closed when absent or unknown. The Don
// invariants hold throughout: integer cents, allocations plus dust equals
// gross including the escrow bucket, idempotency (a replayed event moves
// nothing twice), and the CAS as the concurrency arbiter.

import { describe, expect, it } from "vitest";

import { InMemoryStore } from "@/lib/server/inMemoryStore";
import type { Store } from "@/lib/server/store";
import {
  SPATIAL_AUDIT_ESCROW_MAX_RATE_BPS,
  SPATIAL_AUDIT_ESCROW_MIN_RATE_BPS,
  spatialAuditEscrowPayeeId,
  spatialAuditEscrowPayeeName,
} from "@/modules/don/constants";
import type { GlEntryRecord, GlJournalRecord } from "@/modules/don/records";
import {
  buildSpatialAuditEscrowSplitPlan,
  buildSpatialCapexRecoupmentPlan,
  isSpatialMsgQuarter,
  spatialAuditEscrowScopeKey,
  spatialCapexScopeKey,
  spatialMsgDueCents,
  spatialMsgQuarterMonths,
} from "@/modules/spatial/records";
import {
  applySpatialCapexOffset,
  closeSpatialMsgTerm,
  drawDownSpatialAuditEscrow,
  reconcileSpatialAuditEscrow,
  registerSpatialAuditEscrowPolicy,
  registerSpatialCapexCommitment,
  releaseSpatialAuditEscrow,
  routeSpatialAuditEscrowFromHolding,
  spatialZeroBalanceHolds,
} from "@/lib/server/spatialCommitmentsLedger";
import type { LedgerTransactionRecord } from "@/lib/don/types";

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

const T0 = new Date("2026-10-03T12:00:00.000Z");
const PAYEE_ID = "ip-owner-marvelous";
const PAYEE_NAME = "Marvelous IP Owner";
const OPERATOR_ID = "operator-regional";
const OPERATOR_NAME = "Regional Licensee Co";
const VENUE_ID = "venue-park-one";
const POPUP_REF = "halloween-90d";
const CAP_SCOPE = spatialCapexScopeKey(VENUE_ID);
const ESCROW_SCOPE = spatialAuditEscrowScopeKey(VENUE_ID);

function makeStore(): Store {
  return new InMemoryStore();
}

/** The GL read path of record: find the posted journal and its legs. */
async function glJournalOf(
  store: Store,
  journalId: string | null,
): Promise<{ journal: GlJournalRecord; legs: GlEntryRecord[] } | null> {
  if (!journalId) return null;
  const journal = (await store.listGlJournals()).find((j) => j.id === journalId);
  if (!journal) return null;
  return { journal, legs: await store.listGlEntriesByJournal(journalId) };
}

function legTotals(legs: GlEntryRecord[]): { debits: number; credits: number } {
  return {
    debits: legs.reduce((t, l) => t + l.debit_cents, 0),
    credits: legs.reduce((t, l) => t + l.credit_cents, 0),
  };
}

async function seedVerifiedKyc(store: Store, creatorId: string): Promise<void> {
  await store.insertKycVerification({
    creator_id: creatorId,
    plaid_link_token: "link-token",
    plaid_public_token: "public-token",
    status: "verified",
    identity_json: "{}",
    failure_reason: null,
    created_at: T0.toISOString(),
    verified_at: T0.toISOString(),
  });
}

async function seedSpatialGateState(
  store: Store,
  states: {
    territorial_zoning_state: "cleared" | "unknown";
    spatial_audit_state: "verified" | "unknown";
  },
  payeeId = PAYEE_ID,
  venueId = VENUE_ID,
): Promise<void> {
  await store.upsertSpatialPayoutGateState({
    payee_id: payeeId,
    venue_id: venueId,
    territorial_zoning_state: states.territorial_zoning_state,
    spatial_audit_state: states.spatial_audit_state,
    evidence_ref: "gate-evidence.pdf",
    verified_by: "compliance-desk",
  });
}

/** The full fixture set the gate must still read: KYC verified, gate
 * states green, policy registered. */
async function seedGateGreen(
  store: Store,
  rateBps = 700,
): Promise<void> {
  await seedVerifiedKyc(store, PAYEE_ID);
  await seedSpatialGateState(store, {
    territorial_zoning_state: "cleared",
    spatial_audit_state: "verified",
  });
  const registered = await registerSpatialAuditEscrowPolicy(store, {
    venue_id: VENUE_ID,
    reserve_rate_bps: rateBps,
  });
  expect(registered.ok).toBe(true);
}

async function seedHeldCredit(
  store: Store,
  amountCents: number,
  createdAt: Date = T0,
): Promise<LedgerTransactionRecord> {
  return store.insertLedgerTransaction({
    split_run_id: "",
    line_item_id: "distribution-line-1",
    payee_id: PAYEE_ID,
    payee_name: PAYEE_NAME,
    role: "creator",
    share_bps: 0,
    amount_cents: amountCents,
    currency: "USD",
    status: "unclaimed_holding",
    rail: null,
    baas_provider: null,
    baas_transfer_id: null,
    created_at: createdAt.toISOString(),
    settled_at: null,
    kind: "unclaimed_holding",
  });
}

/** One committed occupancy royalty of record (the PR 36 append-only
 * ledger row the CapEx offset and the MSG close derive from). */
async function seedOccupancyRoyalty(
  store: Store,
  sourceEventId: string,
  royaltyCents: number,
  period = "2026-01",
  venueId = VENUE_ID,
): Promise<void> {
  await store.insertSpatialRoyaltyApplication({
    source_event_id: sourceEventId,
    sender: "turnstile",
    venue_id: venueId,
    zone_code: "ZONE-A",
    spatial_footprint_sqft: 10_000,
    period,
    ticket_revenue_cents: royaltyCents + 5_000,
    merch_revenue_cents: 0,
    gross_revenue_cents: royaltyCents + 5_000,
    occupancy_tax_cents: 0,
    infrastructure_cogs_cents: 0,
    group_tour_discount_cents: 0,
    net_spatial_licensed_revenue_cents: royaltyCents + 5_000,
    overhead_security_cents: 0,
    overhead_wristband_cents: 0,
    overhead_ticketing_cents: 0,
    overhead_total_cents: 0,
    royalty_basis_cents: royaltyCents + 5_000,
    tier_basis: "annual_throughput",
    tier_schedule_ref: null,
    tier_legs: "[]",
    entries_count: 100,
    entries_before: 0,
    entries_after: 100,
    occupancy_royalty_cents: royaltyCents,
    verdict: "paid",
  });
}

async function seedZoneRoyalty(
  store: Store,
  sourceEventId: string,
  royaltyCents: number,
  period = "2026-01",
  venueId = VENUE_ID,
): Promise<void> {
  await store.insertSpatialZoneAllocation({
    source_event_id: sourceEventId,
    row_class: "fnb",
    venue_id: venueId,
    zone_code: "ZONE-B",
    period,
    gross_cents: royaltyCents * 10,
    overhead_security_cents: 0,
    overhead_wristband_cents: 0,
    overhead_ticketing_cents: 0,
    overhead_total_cents: 0,
    allocated_basis_cents: royaltyCents * 10,
    assigned_ip_owner_id: PAYEE_ID,
    royalty_bps: 1_000,
    royalty_cents: royaltyCents,
  });
}

async function seedMicroRoyalty(
  store: Store,
  sourceEventId: string,
  royaltyCents: number,
  period = "2026-01",
  venueId = VENUE_ID,
): Promise<void> {
  const totalMicros = royaltyCents * 1_000_000;
  await store.insertSpatialMicroRoyalty({
    source_event_id: sourceEventId,
    venue_id: venueId,
    zone_code: "ZONE-C",
    wristband_id: "wb-1",
    sensor_id: "sensor-1",
    period,
    dwell_minutes: 30,
    ride_sessions: 2,
    micros_per_dwell_minute: 10_000,
    micros_per_ride_session: 100_000,
    dwell_royalty_micros: Math.floor(totalMicros / 2),
    session_royalty_micros: totalMicros - Math.floor(totalMicros / 2),
    total_royalty_micros: totalMicros,
    royalty_cents: royaltyCents,
  });
}

// ---------------------------------------------------------------------------
// Pure helpers — the escrow split and the CapEx plan.
// ---------------------------------------------------------------------------

describe("buildSpatialAuditEscrowSplitPlan — the escrow bucket arithmetic", () => {
  it("floors the escrow share and keeps the remainder by exact subtraction with structurally-zero dust", () => {
    const planned = buildSpatialAuditEscrowSplitPlan(123_456, 700);
    expect(planned.escrow_cents).toBe(8_641); // floor(123456 × 0.07)
    expect(planned.remainder_cents).toBe(123_456 - 8_641);
    expect(planned.dust_cents).toBe(0);
  });

  it("keeps escrow plus remainder plus dust equal to the amount at every rate in the band", () => {
    for (const rateBps of [500, 613, 700, 999, 1_200]) {
      const planned = buildSpatialAuditEscrowSplitPlan(999_999, rateBps);
      expect(
        planned.escrow_cents + planned.remainder_cents + planned.dust_cents,
      ).toBe(999_999);
      expect(Number.isInteger(planned.escrow_cents)).toBe(true);
      expect(Number.isInteger(planned.remainder_cents)).toBe(true);
      expect(Number.isInteger(planned.dust_cents)).toBe(true);
    }
  });
});

describe("spatialZeroBalanceHolds — the house invariant", () => {
  it("accepts the exact allocation totals (escrow inside the total) and refuses any drift", () => {
    expect(spatialZeroBalanceHolds(1_000, [{ amount_cents: 300 }, { amount_cents: 700 }], 0)).toBe(true);
    expect(spatialZeroBalanceHolds(999, [{ amount_cents: 700 }], 299)).toBe(true);
    expect(spatialZeroBalanceHolds(1_000, [{ amount_cents: 300 }, { amount_cents: 701 }], 0)).toBe(false);
    expect(spatialZeroBalanceHolds(1_000, [{ amount_cents: 300.5 }], 700)).toBe(false);
    expect(spatialZeroBalanceHolds(1_000, [{ amount_cents: -1 }], 1_001)).toBe(false);
    expect(spatialZeroBalanceHolds(1_000.5, [], 1_000)).toBe(false);
  });
});

describe("spatialMsgDueCents and the quarter grammar", () => {
  it("prices floor(footprint × rate / 1e6) exactly and lists the quarter's months", () => {
    expect(spatialMsgDueCents(10_000, 250_000)).toBe(2_500); // $25.00 / quarter
    expect(spatialMsgDueCents(1, 1)).toBe(0); // sub-micro pricing floors to zero
    expect(spatialMsgQuarterMonths("2026-Q1")).toEqual(["2026-01", "2026-02", "2026-03"]);
    expect(spatialMsgQuarterMonths("2026-Q4")).toEqual(["2026-10", "2026-11", "2026-12"]);
    expect(isSpatialMsgQuarter("2026-Q3")).toBe(true);
    for (const bad of ["2026-Q5", "26-Q1", "2026-Q0", "2026-q1", "2026-01"]) {
      expect(isSpatialMsgQuarter(bad)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// The CapEx recoupment offset — the amortization schedule of record.
// ---------------------------------------------------------------------------

describe("applySpatialCapexOffset — the OLDEST-FIRST amortization walk", () => {
  it("amortizes across commitments oldest-first and reports the surviving payout", async () => {
    const store = makeStore();
    const oldest = await registerSpatialCapexCommitment(store, {
      venue_id: VENUE_ID,
      capex_ref: "ride-coaster-01",
      operator_id: OPERATOR_ID,
      capex_category: "ride_construction",
      capex_amount_cents: 10_000,
      currency: "USD",
    });
    const newest = await registerSpatialCapexCommitment(store, {
      venue_id: VENUE_ID,
      capex_ref: "buildout-plaza",
      operator_id: OPERATOR_ID,
      capex_category: "venue_buildout",
      capex_amount_cents: 10_000,
      currency: "USD",
    });
    expect(oldest.ok && newest.ok).toBe(true);
    if (!oldest.ok || !newest.ok) return;

    await seedOccupancyRoyalty(store, "evt-roy-1", 12_000);
    const offset = await applySpatialCapexOffset(store, {
      venue_id: VENUE_ID,
      source_event_id: "evt-roy-1",
      royalty_stream: "occupancy",
    });
    expect(offset.ok).toBe(true);
    if (!offset.ok) return;

    // 12_000 royalty: 10_000 eats the oldest commitment whole, 2_000
    // starts the newest — the oldest-first amortization order.
    expect(offset.value.applications.map((a) => a.commitment_id)).toEqual([
      oldest.value.id,
      newest.value.id,
    ]);
    expect(offset.value.applications[0]?.offset_cents).toBe(10_000);
    expect(offset.value.applications[0]?.offset_before_cents).toBe(0);
    expect(offset.value.applications[0]?.offset_after_cents).toBe(10_000);
    expect(offset.value.applications[1]?.offset_cents).toBe(2_000);
    expect(offset.value.applications[1]?.offset_before_cents).toBe(0);
    expect(offset.value.applications[1]?.offset_after_cents).toBe(2_000);
    // Every application carries the event's royalty of record.
    for (const application of offset.value.applications) {
      expect(application.source_event_id).toBe("evt-roy-1");
      expect(application.royalty_cents).toBe(12_000);
      expect(application.royalty_stream).toBe("occupancy");
    }
    // The IP owner's payout is the royalty MINUS the offset.
    expect(offset.value.payout_after_offset_cents).toBe(0);
    expect(offset.value.unrecouped_after_cents).toBe(10_000 - 2_000);
    // The bookkeeping counters track the truth.
    const commitments = await store.listSpatialCapexCommitments(CAP_SCOPE);
    expect(commitments.map((c) => c.recouped_cents)).toEqual([10_000, 2_000]);
  });

  it("fully clears the final commitment — builds amortize out and later royalties pay whole", async () => {
    const store = makeStore();
    await registerSpatialCapexCommitment(store, {
      venue_id: VENUE_ID,
      capex_ref: "ride-coaster-01",
      operator_id: OPERATOR_ID,
      capex_category: "ride_construction",
      capex_amount_cents: 5_000,
      currency: "USD",
    });
    await seedOccupancyRoyalty(store, "evt-roy-1", 5_000);
    const first = await applySpatialCapexOffset(store, {
      venue_id: VENUE_ID,
      source_event_id: "evt-roy-1",
      royalty_stream: "occupancy",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.unrecouped_after_cents).toBe(0);

    // The next royalty finds nothing to offset — the build has cleared.
    await seedOccupancyRoyalty(store, "evt-roy-2", 7_777);
    const second = await applySpatialCapexOffset(store, {
      venue_id: VENUE_ID,
      source_event_id: "evt-roy-2",
      royalty_stream: "occupancy",
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.applications).toEqual([]);
    expect(second.value.payout_after_offset_cents).toBe(7_777);
    expect(second.value.unrecouped_after_cents).toBe(0);
  });

  it("is idempotent by event — a replayed royalty is a counted no-op that moves nothing twice", async () => {
    const store = makeStore();
    await registerSpatialCapexCommitment(store, {
      venue_id: VENUE_ID,
      capex_ref: "ride-coaster-01",
      operator_id: OPERATOR_ID,
      capex_category: "ride_construction",
      capex_amount_cents: 100_000,
      currency: "USD",
    });
    await seedOccupancyRoyalty(store, "evt-roy-1", 6_000);
    const first = await applySpatialCapexOffset(store, {
      venue_id: VENUE_ID,
      source_event_id: "evt-roy-1",
      royalty_stream: "occupancy",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.applications).toHaveLength(1);

    const replay = await applySpatialCapexOffset(store, {
      venue_id: VENUE_ID,
      source_event_id: "evt-roy-1",
      royalty_stream: "occupancy",
    });
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.value.applications).toEqual([]);
    // The replay reports the royalty as payable (it already survived the
    // first pass) and the position never moved twice.
    expect(replay.value.payout_after_offset_cents).toBe(6_000);
    const applications = await store.listSpatialCapexApplications(
      first.value.applications[0]?.commitment_id ?? "",
    );
    expect(applications).toHaveLength(1);
    const commitments = await store.listSpatialCapexCommitments(CAP_SCOPE);
    expect(commitments[0]?.recouped_cents).toBe(6_000);
  });

  it("consumes zone and micro royalties of record from their own append-only ledgers", async () => {
    const store = makeStore();
    const registered = await registerSpatialCapexCommitment(store, {
      venue_id: VENUE_ID,
      capex_ref: "buildout-plaza",
      operator_id: OPERATOR_ID,
      capex_category: "venue_buildout",
      capex_amount_cents: 50_000,
      currency: "USD",
    });
    expect(registered.ok).toBe(true);
    await seedZoneRoyalty(store, "evt-zone-1", 3_333);
    const zoneOffset = await applySpatialCapexOffset(store, {
      venue_id: VENUE_ID,
      source_event_id: "evt-zone-1",
      royalty_stream: "zone",
    });
    expect(zoneOffset.ok).toBe(true);
    if (!zoneOffset.ok) return;
    expect(zoneOffset.value.applications[0]?.royalty_cents).toBe(3_333);
    expect(zoneOffset.value.applications[0]?.royalty_stream).toBe("zone");

    await seedMicroRoyalty(store, "evt-micro-1", 1_234);
    const microOffset = await applySpatialCapexOffset(store, {
      venue_id: VENUE_ID,
      source_event_id: "evt-micro-1",
      royalty_stream: "micro",
    });
    expect(microOffset.ok).toBe(true);
    if (!microOffset.ok) return;
    expect(microOffset.value.applications[0]?.royalty_cents).toBe(1_234);
    expect(microOffset.value.applications[0]?.royalty_stream).toBe("micro");
    // The schedule accumulates both streams against one register.
    const applications = await store.listSpatialCapexApplications(
      zoneOffset.value.applications[0]?.commitment_id ?? "",
    );
    expect(applications.map((a) => a.royalty_stream)).toEqual(["zone", "micro"]);
    expect(applications.reduce((t, a) => t + a.offset_cents, 0)).toBe(4_567);
  });

  it("refuses an unknown stream and a royalty event of record that does not exist", async () => {
    const store = makeStore();
    const badStream = await applySpatialCapexOffset(store, {
      venue_id: VENUE_ID,
      source_event_id: "evt-x",
      royalty_stream: "book_sales",
    });
    expect(badStream.ok).toBe(false);
    if (badStream.ok) return;
    expect(badStream.code).toBe("invalid_royalty_stream");

    const noEvent = await applySpatialCapexOffset(store, {
      venue_id: VENUE_ID,
      source_event_id: "evt-missing",
      royalty_stream: "occupancy",
    });
    expect(noEvent.ok).toBe(false);
    if (noEvent.ok) return;
    expect(noEvent.code).toBe("royalty_application_not_found");
  });

  it("buildSpatialCapexRecoupmentPlan walks oldest-first and stops at the royalty", () => {
    const plan = buildSpatialCapexRecoupmentPlan(
      [
        {
          id: "c-old",
          scope_key: CAP_SCOPE,
          capex_ref: "old",
          operator_id: OPERATOR_ID,
          capex_category: "ride_construction",
          capex_amount_cents: 10_000,
          recouped_cents: 4_000,
          currency: "USD",
          created_at: T0.toISOString(),
          updated_at: T0.toISOString(),
        },
        {
          id: "c-new",
          scope_key: CAP_SCOPE,
          capex_ref: "new",
          operator_id: OPERATOR_ID,
          capex_category: "venue_buildout",
          capex_amount_cents: 10_000,
          recouped_cents: 0,
          currency: "USD",
          created_at: T0.toISOString(),
          updated_at: T0.toISOString(),
        },
      ],
      8_000,
    );
    expect(plan.applications.map((s) => s.commitment.id)).toEqual(["c-old", "c-new"]);
    expect(plan.applications[0]?.offset_cents).toBe(6_000);
    expect(plan.applications[1]?.offset_cents).toBe(2_000);
    // After the walk: 16_000 unrecouped minus the 8_000 just consumed.
    expect(plan.unrecouped_after_cents).toBe(8_000);
  });
});

// ---------------------------------------------------------------------------
// The CapEx commitment registry.
// ---------------------------------------------------------------------------

describe("registerSpatialCapexCommitment — the allowable cost of record", () => {
  it("refuses blank identities, unknown categories, and non-positive or non-integer costs", async () => {
    const store = makeStore();
    for (const bad of [
      { venue_id: "  ", capex_ref: "r", operator_id: "op", capex_category: "ride_construction", capex_amount_cents: 100, currency: "USD" },
      { venue_id: VENUE_ID, capex_ref: "  ", operator_id: "op", capex_category: "ride_construction", capex_amount_cents: 100, currency: "USD" },
      { venue_id: VENUE_ID, capex_ref: "r", operator_id: "  ", capex_category: "ride_construction", capex_amount_cents: 100, currency: "USD" },
      { venue_id: VENUE_ID, capex_ref: "r", operator_id: "op", capex_category: "marketing_billboard", capex_amount_cents: 100, currency: "USD" },
      { venue_id: VENUE_ID, capex_ref: "r", operator_id: "op", capex_category: "ride_construction", capex_amount_cents: 0, currency: "USD" },
      { venue_id: VENUE_ID, capex_ref: "r", operator_id: "op", capex_category: "ride_construction", capex_amount_cents: 100.5, currency: "USD" },
    ]) {
      const registered = await registerSpatialCapexCommitment(store, bad);
      expect(registered.ok).toBe(false);
    }
  });

  it("converges on re-registration — the newest cost governs the next walk", async () => {
    const store = makeStore();
    const first = await registerSpatialCapexCommitment(store, {
      venue_id: VENUE_ID,
      capex_ref: "ride-coaster-01",
      operator_id: OPERATOR_ID,
      capex_category: "ride_construction",
      capex_amount_cents: 10_000,
      currency: "USD",
    });
    expect(first.ok).toBe(true);
    const second = await registerSpatialCapexCommitment(store, {
      venue_id: VENUE_ID,
      capex_ref: "ride-coaster-01",
      operator_id: OPERATOR_ID,
      capex_category: "ride_construction",
      capex_amount_cents: 12_500,
      currency: "USD",
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.capex_amount_cents).toBe(12_500);
    const commitments = await store.listSpatialCapexCommitments(CAP_SCOPE);
    expect(commitments).toHaveLength(1);
    expect(commitments[0]?.capex_amount_cents).toBe(12_500);
  });
});

// ---------------------------------------------------------------------------
// The quarterly MSG close — the automatic shortfall debit.
// ---------------------------------------------------------------------------

describe("closeSpatialMsgTerm — the guarantee's close of record", () => {
  async function seedMsgCommitment(
    store: Store,
    footprintSqft = 10_000,
    rateMicros = 250_000,
    venueId = VENUE_ID,
  ): Promise<string> {
    const commitment = await store.upsertSpatialMsgCommitment({
      scope_key: `operator:${OPERATOR_ID}:venue:${venueId}`,
      operator_id: OPERATOR_ID,
      operator_name: OPERATOR_NAME,
      venue_id: venueId,
      reserved_footprint_sqft: footprintSqft,
      quarterly_rate_micros_per_sqft: rateMicros,
      currency: "USD",
    });
    return commitment.id;
  }

  it("debits the operator's invoice of record automatically when the quarter's earnings miss the guarantee", async () => {
    const store = makeStore();
    const commitmentId = await seedMsgCommitment(store);

    // The quarter earns 1_500 cents against a 2_500-cent guarantee.
    await seedOccupancyRoyalty(store, "evt-q1a", 1_000, "2026-01");
    await seedZoneRoyalty(store, "evt-q1b", 300, "2026-02");
    await seedMicroRoyalty(store, "evt-q1c", 200, "2026-03");
    // Outside the quarter — must NOT count.
    await seedOccupancyRoyalty(store, "evt-q4", 99_999, "2026-10");
    // Another venue's row — must NOT count.
    await seedOccupancyRoyalty(store, "evt-other-venue", 99_999, "2026-01", "venue-park-two");

    const close = await closeSpatialMsgTerm(store, {
      scope_key: `operator:${OPERATOR_ID}:venue:${VENUE_ID}`,
      quarter: "2026-Q1",
      closed_by: "spatial-desk",
    }, T0);
    expect(close.ok).toBe(true);
    if (!close.ok) return;

    // The guarantee's face from the reserved-footprint terms.
    expect(close.value.close.msg_due_cents).toBe(2_500);
    // Earnings derived from all THREE append-only ledgers, quarter-month
    // filtered, venue-scoped.
    expect(close.value.close.earned_at_close_cents).toBe(1_500);
    expect(close.value.close.shortfall_cents).toBe(1_000);
    expect(close.value.close.invoice_ledger_id).not.toBeNull();

    // THE AUTOMATIC DEBIT — the invoice row of record: kind AND status
    // 'msg_shortfall_due', the payee is the operator of record, the
    // quarter key stamped in line_item_id.
    const invoice = close.value.invoice_ledger;
    expect(invoice).not.toBeNull();
    if (invoice === null) return;
    expect(invoice.kind).toBe("msg_shortfall_due");
    expect(invoice.status).toBe("msg_shortfall_due");
    expect(invoice.payee_id).toBe(OPERATOR_ID);
    expect(invoice.payee_name).toBe(OPERATOR_NAME);
    expect(invoice.amount_cents).toBe(1_000);
    expect(invoice.line_item_id).toBe(`${commitmentId}:2026-Q1`);

    // The GL journal posted balanced legs.
    const posted = await glJournalOf(store, close.value.journal_id);
    expect(posted?.journal.kind).toBe("spatial_msg_shortfall_invoice");
    const invoiceTotals = legTotals(posted?.legs ?? []);
    expect(invoiceTotals.debits).toBe(1_000);
    expect(invoiceTotals.credits).toBe(1_000);

    // The term close of record persisted.
    const recorded = await store.getSpatialMsgTermClose(commitmentId, "2026-Q1");
    expect(recorded?.shortfall_cents).toBe(1_000);
  });

  it("records a met guarantee and moves nothing when earnings cover the face", async () => {
    const store = makeStore();
    await seedMsgCommitment(store);
    await seedOccupancyRoyalty(store, "evt-q1a", 2_600, "2026-01");

    const close = await closeSpatialMsgTerm(store, {
      scope_key: `operator:${OPERATOR_ID}:venue:${VENUE_ID}`,
      quarter: "2026-Q1",
      closed_by: "spatial-desk",
    }, T0);
    expect(close.ok).toBe(true);
    if (!close.ok) return;
    expect(close.value.close.msg_due_cents).toBe(2_500);
    expect(close.value.close.earned_at_close_cents).toBe(2_600);
    expect(close.value.close.shortfall_cents).toBe(0);
    expect(close.value.close.invoice_ledger_id).toBeNull();
    expect(close.value.invoice_ledger).toBeNull();
    expect(close.value.journal_id).toBeNull();
  });

  it("is idempotent per (commitment, quarter) — the replay converges on the recorded close and never re-posts the invoice", async () => {
    const store = makeStore();
    await seedMsgCommitment(store);
    await seedOccupancyRoyalty(store, "evt-q1a", 1_000, "2026-01");

    const first = await closeSpatialMsgTerm(store, {
      scope_key: `operator:${OPERATOR_ID}:venue:${VENUE_ID}`,
      quarter: "2026-Q1",
      closed_by: "spatial-desk",
    }, T0);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.replayed).toBe(false);
    expect(first.value.invoice_ledger).not.toBeNull();

    // New earnings land AFTER the close — the recorded close of record
    // does not re-price.
    await seedOccupancyRoyalty(store, "evt-q1b", 99_999, "2026-02");

    const replay = await closeSpatialMsgTerm(store, {
      scope_key: `operator:${OPERATOR_ID}:venue:${VENUE_ID}`,
      quarter: "2026-Q1",
      closed_by: "spatial-desk",
    }, T0);
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.value.replayed).toBe(true);
    expect(replay.value.close.shortfall_cents).toBe(1_500);
    expect(replay.value.invoice_ledger?.id).toBe(first.value.invoice_ledger?.id);
    expect(replay.value.journal_id).toBeNull();
  });

  it("refuses a missing commitment of record and a malformed quarter — fail-closed", async () => {
    const store = makeStore();
    const noCommitment = await closeSpatialMsgTerm(store, {
      scope_key: "operator:ghost:venue:venue-ghost",
      quarter: "2026-Q1",
      closed_by: "spatial-desk",
    }, T0);
    expect(noCommitment.ok).toBe(false);
    if (noCommitment.ok) return;
    expect(noCommitment.code).toBe("msg_commitment_not_found");

    await seedMsgCommitment(store);
    for (const quarter of ["2026-Q5", "garbage", ""]) {
      const bad = await closeSpatialMsgTerm(store, {
        scope_key: `operator:${OPERATOR_ID}:venue:${VENUE_ID}`,
        quarter,
        closed_by: "spatial-desk",
      }, T0);
      expect(bad.ok).toBe(false);
      if (!bad.ok) {
        expect(bad.code).toBe("invalid_msg_quarter");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The SPATIAL_AUDIT_ESCROW — registration, routing, drawdown,
// reconciliation, release.
// ---------------------------------------------------------------------------

describe("registerSpatialAuditEscrowPolicy — the founder-banded rate of record", () => {
  it("accepts the band's edges (500 and 1200 bps) and refuses outside it", async () => {
    const store = makeStore();
    for (const rateBps of [SPATIAL_AUDIT_ESCROW_MIN_RATE_BPS, 700, SPATIAL_AUDIT_ESCROW_MAX_RATE_BPS]) {
      const registered = await registerSpatialAuditEscrowPolicy(store, {
        venue_id: VENUE_ID,
        reserve_rate_bps: rateBps,
      });
      expect(registered.ok).toBe(true);
    }
    for (const rateBps of [
      SPATIAL_AUDIT_ESCROW_MIN_RATE_BPS - 1,
      SPATIAL_AUDIT_ESCROW_MAX_RATE_BPS + 1,
      0,
      -700,
      700.5,
    ]) {
      const registered = await registerSpatialAuditEscrowPolicy(store, {
        venue_id: VENUE_ID,
        reserve_rate_bps: rateBps,
      });
      expect(registered.ok).toBe(false);
      if (!registered.ok) {
        expect(registered.code).toBe("escrow_rate_out_of_band");
      }
    }
  });
});

describe("routeSpatialAuditEscrowFromHolding — the automatic 5–12% lock", () => {
  it("splits the held park-earnings credit at the policy rate: the escrow locks at the per-scope sentinel payee, the remainder rides the taxed cascade", async () => {
    const store = makeStore();
    await seedGateGreen(store, 700);
    const held = await seedHeldCredit(store, 1_000_000); // $10,000

    const routed = await routeSpatialAuditEscrowFromHolding(
      store,
      {
        holding_ledger_id: held.id,
        venue_id: VENUE_ID,
        payee_id: PAYEE_ID,
        operator_settlement_approved: true,
      },
      T0,
    );
    expect(routed.ok).toBe(true);
    if (!routed.ok) return;

    // The split of record: 7% locks, the remainder routes.
    expect(routed.value.split.escrow_cents).toBe(70_000);
    expect(routed.value.split.remainder_cents).toBe(930_000);
    expect(routed.value.split.dust_cents).toBe(0);
    // THE INVARIANT: remainder + escrow + dust === held.
    expect(
      routed.value.split.remainder_cents +
        routed.value.split.escrow_cents +
        routed.value.split.dust_cents,
    ).toBe(held.amount_cents);

    // The escrow locked as its own ledger row — kind AND status
    // 'spatial_audit_escrow', the per-scope sentinel payee (never the
    // platform, the unclaimed-holding sentinel, or the NIL escrow).
    const escrow = routed.value.escrow_credit;
    expect(escrow).not.toBeNull();
    if (escrow === null) return;
    expect(escrow.kind).toBe("spatial_audit_escrow");
    expect(escrow.status).toBe("spatial_audit_escrow");
    expect(escrow.payee_id).toBe(spatialAuditEscrowPayeeId(ESCROW_SCOPE));
    expect(escrow.payee_id).not.toBe("platform");
    expect(escrow.payee_name).toBe(spatialAuditEscrowPayeeName(ESCROW_SCOPE));
    expect(escrow.line_item_id).toBe(ESCROW_SCOPE);
    expect(escrow.amount_cents).toBe(70_000);

    // The held credit settled exactly once.
    expect(routed.value.distribution_credit.status).toBe("settled");
    expect(routed.value.journal_id).not.toBeNull();

    // The GL journal balanced legs — the holding debit funds the escrow
    // credit plus the payee's vault legs.
    const posted = await glJournalOf(store, routed.value.journal_id);
    expect(posted?.journal.kind).toBe("spatial_audit_escrow_route");
    const routeTotals = legTotals(posted?.legs ?? []);
    expect(routeTotals.debits).toBe(1_000_000);
    expect(routeTotals.credits).toBe(1_000_000);
  });

  it("is idempotent by held credit — a replayed routing refuses with the same 409 and never splits twice", async () => {
    const store = makeStore();
    await seedGateGreen(store, 700);
    const held = await seedHeldCredit(store, 1_000_000);
    const routeInput = {
      holding_ledger_id: held.id,
      venue_id: VENUE_ID,
      payee_id: PAYEE_ID,
      operator_settlement_approved: true,
    };
    const first = await routeSpatialAuditEscrowFromHolding(store, routeInput, T0);
    expect(first.ok).toBe(true);

    const replay = await routeSpatialAuditEscrowFromHolding(store, routeInput, T0);
    expect(replay.ok).toBe(false);
    if (replay.ok) return;
    expect(replay.status).toBe(409);
    expect(replay.code).toBe("distribution_already_released");

    // Exactly one route journal exists.
    const journals = await store.listGlJournals();
    expect(journals.filter((j) => j.kind === "spatial_audit_escrow_route")).toHaveLength(1);
  });

  it("refuses fail-closed: no policy of record, wrong kind, already-settled credits", async () => {
    const store = makeStore();
    // No registered policy → nothing routes.
    const noPolicyHeld = await seedHeldCredit(store, 500_000);
    const noPolicy = await routeSpatialAuditEscrowFromHolding(
      store,
      { holding_ledger_id: noPolicyHeld.id, venue_id: VENUE_ID, payee_id: PAYEE_ID, operator_settlement_approved: true },
      T0,
    );
    expect(noPolicy.ok).toBe(false);
    if (noPolicy.ok) return;
    expect(noPolicy.code).toBe("missing_spatial_audit_escrow_policy");

    // A registered policy + green gates routes...
    await seedGateGreen(store, 700);
    const held = await seedHeldCredit(store, 500_000);
    // ...but a non-holding kind never enters the lane.
    const fakePayout = await store.insertLedgerTransaction({
      split_run_id: "",
      line_item_id: "li-1",
      payee_id: PAYEE_ID,
      payee_name: PAYEE_NAME,
      role: "creator",
      share_bps: 0,
      amount_cents: 1_000,
      currency: "USD",
      status: "pending_settlement",
      rail: null,
      baas_provider: null,
      baas_transfer_id: null,
      created_at: T0.toISOString(),
      settled_at: null,
      kind: "payout",
    });
    const wrongKind = await routeSpatialAuditEscrowFromHolding(
      store,
      { holding_ledger_id: fakePayout.id, venue_id: VENUE_ID, payee_id: PAYEE_ID, operator_settlement_approved: true },
      T0,
    );
    expect(wrongKind.ok).toBe(false);
    if (wrongKind.ok) return;
    expect(wrongKind.code).toBe("not_a_holding_credit");

    // A settled (already-routed) holding credit refuses.
    await routeSpatialAuditEscrowFromHolding(
      store,
      { holding_ledger_id: held.id, venue_id: VENUE_ID, payee_id: PAYEE_ID, operator_settlement_approved: true },
      T0,
    );
    const replay = await routeSpatialAuditEscrowFromHolding(
      store,
      { holding_ledger_id: held.id, venue_id: VENUE_ID, payee_id: PAYEE_ID, operator_settlement_approved: true },
      T0,
    );
    expect(replay.ok).toBe(false);
    if (!replay.ok) {
      expect(replay.status).toBe(409);
    }
  });
});

describe("the spatial payout gate — territorial_zoning_cleared AND spatial_audit_verified", () => {
  it("refuses the routing when the gate-state record is ABSENT (null resolves fail-closed)", async () => {
    const store = makeStore();
    await seedVerifiedKyc(store, PAYEE_ID);
    await registerSpatialAuditEscrowPolicy(store, { venue_id: VENUE_ID, reserve_rate_bps: 700 });
    const held = await seedHeldCredit(store, 100_000);

    const routed = await routeSpatialAuditEscrowFromHolding(
      store,
      { holding_ledger_id: held.id, venue_id: VENUE_ID, payee_id: PAYEE_ID, operator_settlement_approved: true },
      T0,
    );
    expect(routed.ok).toBe(false);
    if (routed.ok) return;
    expect(routed.status).toBe(403);
    expect(routed.code).toBe("vertical_state_unknown");
    // Nothing moved: the holding credit is still held.
    const stillHeld = await store.getLedgerTransaction(held.id);
    expect(stillHeld?.status).toBe("unclaimed_holding");
  });

  it("refuses with the specific condition when either state is 'unknown'", async () => {
    const store = makeStore();
    await seedVerifiedKyc(store, PAYEE_ID);
    await registerSpatialAuditEscrowPolicy(store, { venue_id: VENUE_ID, reserve_rate_bps: 700 });

    await seedSpatialGateState(store, { territorial_zoning_state: "unknown", spatial_audit_state: "verified" });
    const zoningHeld = await seedHeldCredit(store, 100_000);
    const zoningUnknown = await routeSpatialAuditEscrowFromHolding(
      store,
      { holding_ledger_id: zoningHeld.id, venue_id: VENUE_ID, payee_id: PAYEE_ID, operator_settlement_approved: true },
      T0,
    );
    expect(zoningUnknown.ok).toBe(false);
    if (zoningUnknown.ok) return;
    expect(zoningUnknown.code).toBe("spatial_zoning_not_cleared");

    await seedSpatialGateState(store, { territorial_zoning_state: "cleared", spatial_audit_state: "unknown" });
    const auditHeld = await seedHeldCredit(store, 100_000);
    const auditUnknown = await routeSpatialAuditEscrowFromHolding(
      store,
      { holding_ledger_id: auditHeld.id, venue_id: VENUE_ID, payee_id: PAYEE_ID, operator_settlement_approved: true },
      T0,
    );
    expect(auditUnknown.ok).toBe(false);
    if (auditUnknown.ok) return;
    expect(auditUnknown.code).toBe("spatial_audit_unverified");
  });

  it("passes the gate only when both states verify — and the same gate guards the release", async () => {
    const store = makeStore();
    await seedGateGreen(store, 700); // verified + cleared
    const held = await seedHeldCredit(store, 100_000);
    const routed = await routeSpatialAuditEscrowFromHolding(
      store,
      { holding_ledger_id: held.id, venue_id: VENUE_ID, payee_id: PAYEE_ID, operator_settlement_approved: true },
      T0,
    );
    expect(routed.ok).toBe(true);
    const escrowId = routed.ok ? routed.value.escrow_credit?.id : undefined;
    expect(escrowId).toBeDefined();
    if (!routed.ok || !escrowId) return;

    await reconcileSpatialAuditEscrow(store, {
      reserve_ledger_id: escrowId,
      scope_key: ESCROW_SCOPE,
      evidence_ref: "concession-audit.pdf",
      reconciled_by: "compliance-desk",
    });

    // The states flip to unknown AFTER routing — the release refuses.
    await seedSpatialGateState(store, { territorial_zoning_state: "cleared", spatial_audit_state: "unknown" });
    const blocked = await releaseSpatialAuditEscrow(
      store,
      {
        reserve_ledger_id: escrowId,
        scope_key: ESCROW_SCOPE,
        venue_id: VENUE_ID,
        payee_id: PAYEE_ID,
        operator_settlement_approved: true,
      },
      T0,
    );
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect(blocked.code).toBe("spatial_audit_unverified");

    // States heal — the release proceeds.
    await seedSpatialGateState(store, { territorial_zoning_state: "cleared", spatial_audit_state: "verified" });
    const released = await releaseSpatialAuditEscrow(
      store,
      {
        reserve_ledger_id: escrowId,
        scope_key: ESCROW_SCOPE,
        venue_id: VENUE_ID,
        payee_id: PAYEE_ID,
        operator_settlement_approved: true,
      },
      T0,
    );
    expect(released.ok).toBe(true);
  });
});

describe("drawDownSpatialAuditEscrow — taxes, holdbacks, and reconciliations spend the bucket", () => {
  async function seedLockedEscrow(
    store: Store,
    rateBps = 700,
    heldCents = 1_000_000,
  ): Promise<string> {
    await seedGateGreen(store, rateBps);
    const held = await seedHeldCredit(store, heldCents);
    const routed = await routeSpatialAuditEscrowFromHolding(
      store,
      { holding_ledger_id: held.id, venue_id: VENUE_ID, payee_id: PAYEE_ID, operator_settlement_approved: true },
      T0,
    );
    expect(routed.ok).toBe(true);
    const escrowId = routed.ok ? routed.value.escrow_credit?.id : undefined;
    expect(escrowId).toBeDefined();
    return escrowId ?? "";
  }

  it("draws down each class position-locked with its own balanced journal", async () => {
    const store = makeStore();
    const escrowId = await seedLockedEscrow(store);

    const tax = await drawDownSpatialAuditEscrow(store, {
      reserve_ledger_id: escrowId,
      scope_key: ESCROW_SCOPE,
      drawdown_class: "entertainment_sales_tax",
      source_event_id: "tax-2026-q1",
      drawn_cents: 30_000,
    }, T0);
    expect(tax.ok).toBe(true);
    if (tax.ok) {
      expect(tax.value.drawdown.drawn_before_cents).toBe(0);
      expect(tax.value.drawdown.remaining_cents).toBe(40_000);
      expect(tax.value.replayed).toBe(false);
    }

    const safety = await drawDownSpatialAuditEscrow(store, {
      reserve_ledger_id: escrowId,
      scope_key: ESCROW_SCOPE,
      drawdown_class: "safety_compliance_holdback",
      source_event_id: "safety-2026-q1",
      drawn_cents: 5_000,
    }, T0);
    expect(safety.ok).toBe(true);
    if (safety.ok) {
      expect(safety.value.drawdown.drawn_before_cents).toBe(30_000);
      expect(safety.value.drawdown.remaining_cents).toBe(35_000);
    }

    const concession = await drawDownSpatialAuditEscrow(store, {
      reserve_ledger_id: escrowId,
      scope_key: ESCROW_SCOPE,
      drawdown_class: "concession_reconciliation",
      source_event_id: "concessions-2026-q1",
      drawn_cents: 2_000,
    }, T0);
    expect(concession.ok).toBe(true);
    if (concession.ok) {
      expect(concession.value.drawdown.drawn_before_cents).toBe(35_000);
      expect(concession.value.drawdown.remaining_cents).toBe(33_000);
    }

    // The drawdown journals: one per class, each with balanced legs.
    const journals = await store.listGlJournals();
    const drawdownJournals = journals.filter((j) => j.kind === "spatial_audit_escrow_drawdown");
    expect(drawdownJournals).toHaveLength(3);
    for (const journal of drawdownJournals) {
      const totals = legTotals(await store.listGlEntriesByJournal(journal.id));
      expect(totals.debits).toBe(totals.credits);
    }
  });

  it("is idempotent by source event — a re-shipped tax event is a counted no-op", async () => {
    const store = makeStore();
    const escrowId = await seedLockedEscrow(store);
    const drawInput = {
      reserve_ledger_id: escrowId,
      scope_key: ESCROW_SCOPE,
      drawdown_class: "entertainment_sales_tax" as const,
      source_event_id: "tax-2026-q1",
      drawn_cents: 10_000,
    };
    const first = await drawDownSpatialAuditEscrow(store, drawInput, T0);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.replayed).toBe(false);

    const replay = await drawDownSpatialAuditEscrow(store, drawInput, T0);
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.value.replayed).toBe(true);
    expect(replay.value.journal_id).toBeNull();
    const drawdowns = await store.listSpatialAuditEscrowDrawdowns(escrowId);
    expect(drawdowns).toHaveLength(1);
  });

  it("refuses overdraws, unknown classes, wrong scopes, and draws against a settled escrow", async () => {
    const store = makeStore();
    const escrowId = await seedLockedEscrow(store, 700, 100_000); // escrow = 7_000

    const overdraw = await drawDownSpatialAuditEscrow(store, {
      reserve_ledger_id: escrowId,
      scope_key: ESCROW_SCOPE,
      drawdown_class: "entertainment_sales_tax",
      source_event_id: "tax-big",
      drawn_cents: 7_001,
    }, T0);
    expect(overdraw.ok).toBe(false);
    if (!overdraw.ok) {
      expect(overdraw.code).toBe("escrow_overdrawn");
    }

    for (const badClass of ["marketing_splash", "bonus_pool", ""]) {
      const bad = await drawDownSpatialAuditEscrow(store, {
        reserve_ledger_id: escrowId,
        scope_key: ESCROW_SCOPE,
        drawdown_class: badClass,
        source_event_id: "evt-x",
        drawn_cents: 100,
      }, T0);
      expect(bad.ok).toBe(false);
      if (!bad.ok) {
        expect(bad.code).toBe("invalid_drawdown_class");
      }
    }

    const wrongScope = await drawDownSpatialAuditEscrow(store, {
      reserve_ledger_id: escrowId,
      scope_key: spatialAuditEscrowScopeKey("venue-park-two"),
      drawdown_class: "entertainment_sales_tax",
      source_event_id: "tax-scope",
      drawn_cents: 100,
    }, T0);
    expect(wrongScope.ok).toBe(false);
    if (!wrongScope.ok) {
      expect(wrongScope.code).toBe("escrow_scope_mismatch");
    }
  });

  it("a full drawdown settles the escrow first — the last cent never double-moves", async () => {
    const store = makeStore();
    const escrowId = await seedLockedEscrow(store, 700, 100_000); // escrow = 7_000

    const final = await drawDownSpatialAuditEscrow(store, {
      reserve_ledger_id: escrowId,
      scope_key: ESCROW_SCOPE,
      drawdown_class: "concession_reconciliation",
      source_event_id: "concessions-final",
      drawn_cents: 7_000,
    }, T0);
    expect(final.ok).toBe(true);
    if (!final.ok) return;

    const settled = await store.getLedgerTransaction(escrowId);
    expect(settled?.status).toBe("settled");

    // Nothing further draws or releases.
    const afterDraw = await drawDownSpatialAuditEscrow(store, {
      reserve_ledger_id: escrowId,
      scope_key: ESCROW_SCOPE,
      drawdown_class: "entertainment_sales_tax",
      source_event_id: "tax-after",
      drawn_cents: 1,
    }, T0);
    expect(afterDraw.ok).toBe(false);
    if (!afterDraw.ok) {
      expect(afterDraw.code).toBe("escrow_already_settled");
    }
    const afterRelease = await releaseSpatialAuditEscrow(
      store,
      { reserve_ledger_id: escrowId, scope_key: ESCROW_SCOPE, venue_id: VENUE_ID, payee_id: PAYEE_ID, operator_settlement_approved: true },
      T0,
    );
    expect(afterRelease.ok).toBe(false);
  });
});

describe("releaseSpatialAuditEscrow — the verified release", () => {
  async function seedLockedEscrow(
    store: Store,
    rateBps = 700,
    heldCents = 1_000_000,
  ): Promise<string> {
    await seedGateGreen(store, rateBps);
    const held = await seedHeldCredit(store, heldCents);
    const routed = await routeSpatialAuditEscrowFromHolding(
      store,
      { holding_ledger_id: held.id, venue_id: VENUE_ID, payee_id: PAYEE_ID, operator_settlement_approved: true },
      T0,
    );
    expect(routed.ok).toBe(true);
    return routed.ok ? (routed.value.escrow_credit?.id ?? "") : "";
  }

  it("refuses fail-closed with NO reconciliation of record — the key gates the door", async () => {
    const store = makeStore();
    const escrowId = await seedLockedEscrow(store);

    const unreconciled = await releaseSpatialAuditEscrow(
      store,
      { reserve_ledger_id: escrowId, scope_key: ESCROW_SCOPE, venue_id: VENUE_ID, payee_id: PAYEE_ID, operator_settlement_approved: true },
      T0,
    );
    expect(unreconciled.ok).toBe(false);
    if (unreconciled.ok) return;
    expect(unreconciled.status).toBe(403);
    expect(unreconciled.code).toBe("spatial_audit_escrow_reconciliation_missing");
    const stillHeld = await store.getLedgerTransaction(escrowId);
    expect(stillHeld?.status).toBe("spatial_audit_escrow");
  });

  it("releases the surviving balance through the taxed cascade once the reconciliation verifies", async () => {
    const store = makeStore();
    const escrowId = await seedLockedEscrow(store);

    await drawDownSpatialAuditEscrow(store, {
      reserve_ledger_id: escrowId,
      scope_key: ESCROW_SCOPE,
      drawdown_class: "entertainment_sales_tax",
      source_event_id: "tax-q1",
      drawn_cents: 20_000,
    }, T0);

    await reconcileSpatialAuditEscrow(store, {
      reserve_ledger_id: escrowId,
      scope_key: ESCROW_SCOPE,
      evidence_ref: "q1-concession-audit.pdf",
      reconciled_by: "compliance-desk",
    });

    const released = await releaseSpatialAuditEscrow(
      store,
      { reserve_ledger_id: escrowId, scope_key: ESCROW_SCOPE, venue_id: VENUE_ID, payee_id: PAYEE_ID, operator_settlement_approved: true },
      T0,
    );
    expect(released.ok).toBe(true);
    if (!released.ok) return;

    // The drawdowns stay spent; the release pays only what survived.
    expect(released.value.released_cents).toBe(50_000);
    expect(released.value.escrow_credit.status).toBe("settled");
    // THE INVARIANT: drawdowns + released remainder === the locked escrow.
    expect(20_000 + released.value.released_cents).toBe(70_000);

    // The release journal balanced legs.
    const posted = await glJournalOf(store, released.value.journal_id);
    expect(posted?.journal.kind).toBe("spatial_audit_escrow_release");
    const releaseTotals = legTotals(posted?.legs ?? []);
    expect(releaseTotals.debits).toBe(50_000);
    expect(releaseTotals.credits).toBe(50_000);

    // A replayed release refuses — the escrow settled exactly once.
    const replay = await releaseSpatialAuditEscrow(
      store,
      { reserve_ledger_id: escrowId, scope_key: ESCROW_SCOPE, venue_id: VENUE_ID, payee_id: PAYEE_ID, operator_settlement_approved: true },
      T0,
    );
    expect(replay.ok).toBe(false);
    if (!replay.ok) {
      expect(replay.status).toBe(409);
    }
  });

  it("records the reconciliation once and reads it back through the getter", async () => {
    const store = makeStore();
    const escrowId = await seedLockedEscrow(store);
    const first = await reconcileSpatialAuditEscrow(store, {
      reserve_ledger_id: escrowId,
      scope_key: ESCROW_SCOPE,
      evidence_ref: "audit.pdf",
      reconciled_by: "compliance-desk",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.evidence_ref).toBe("audit.pdf");
    const readBack = await store.getSpatialAuditEscrowReconciliation(escrowId);
    expect(readBack?.evidence_ref).toBe("audit.pdf");
  });

  it("refuses scope mismatches — the (venue, pop-up) pair must re-derive the named scope", async () => {
    const store = makeStore();
    const escrowId = await seedLockedEscrow(store);
    await reconcileSpatialAuditEscrow(store, {
      reserve_ledger_id: escrowId,
      scope_key: ESCROW_SCOPE,
      evidence_ref: "audit.pdf",
      reconciled_by: "compliance-desk",
    });

    const mismatch = await releaseSpatialAuditEscrow(
      store,
      { reserve_ledger_id: escrowId, scope_key: ESCROW_SCOPE, venue_id: "venue-park-two", payee_id: PAYEE_ID, operator_settlement_approved: true },
      T0,
    );
    expect(mismatch.ok).toBe(false);
    if (mismatch.ok) return;
    expect(mismatch.code).toBe("escrow_scope_mismatch");
  });
});

// ---------------------------------------------------------------------------
// The temporary pop-up decommissioning audit.
// ---------------------------------------------------------------------------

describe("the pop-up decommissioning audit — no records, no final disbursement", () => {
  const POPUP_SCOPE = spatialAuditEscrowScopeKey(VENUE_ID, POPUP_REF);

  async function seedPopupEscrow(store: Store, rateBps = 700): Promise<string> {
    await seedVerifiedKyc(store, PAYEE_ID);
    await seedSpatialGateState(store, { territorial_zoning_state: "cleared", spatial_audit_state: "verified" });
    const registered = await registerSpatialAuditEscrowPolicy(store, {
      venue_id: VENUE_ID,
      popup_ref: POPUP_REF,
      reserve_rate_bps: rateBps,
    });
    expect(registered.ok).toBe(true);
    const held = await seedHeldCredit(store, 1_000_000);
    const routed = await routeSpatialAuditEscrowFromHolding(
      store,
      { holding_ledger_id: held.id, venue_id: VENUE_ID, popup_ref: POPUP_REF, payee_id: PAYEE_ID, operator_settlement_approved: true },
      T0,
    );
    expect(routed.ok).toBe(true);
    return routed.ok ? (routed.value.escrow_credit?.id ?? "") : "";
  }

  async function seedPopupExperience(store: Store): Promise<string> {
    const experience = await store.insertSpatialPopupExperience({
      popup_ref: POPUP_REF,
      venue_id: VENUE_ID,
      zone_code: "ZONE-H",
      operator_id: OPERATOR_ID,
      experience_kind: "halloween",
      window_start_date: "2026-10-01",
      window_end_date: "2026-12-30",
    });
    return experience.id;
  }

  async function seedPopupWriteoff(store: Store, experienceId: string): Promise<void> {
    await store.insertSpatialPopupWriteoff({
      popup_experience_id: experienceId,
      popup_ref: POPUP_REF,
      source_event_id: "writeoff-final",
      unsold_units: 40,
      unit_cost_cents: 250,
      writeoff_cents: 10_000,
      evidence_ref: "inventory-count.pdf",
      calculated_by: "pop-up-ops",
    });
  }

  it("blocks the release when the pop-up has NO write-off of record — fail-closed", async () => {
    const store = makeStore();
    const escrowId = await seedPopupEscrow(store);
    const experienceId = await seedPopupExperience(store);
    // The restoration reserve exists, but the write-off does not.
    await store.insertSpatialPopupRestorationReserve({
      popup_experience_id: experienceId,
      popup_ref: POPUP_REF,
      reserve_cents: 25_000,
      evidence_ref: "restoration-quote.pdf",
      funded_by: OPERATOR_ID,
    });
    await reconcileSpatialAuditEscrow(store, {
      reserve_ledger_id: escrowId,
      scope_key: POPUP_SCOPE,
      evidence_ref: "popup-audit.pdf",
      reconciled_by: "compliance-desk",
    });

    const blocked = await releaseSpatialAuditEscrow(
      store,
      {
        reserve_ledger_id: escrowId,
        scope_key: POPUP_SCOPE,
        venue_id: VENUE_ID,
        popup_ref: POPUP_REF,
        payee_id: PAYEE_ID,
        operator_settlement_approved: true,
      },
      T0,
    );
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect(blocked.status).toBe(403);
    expect(blocked.code).toBe("popup_writeoff_missing");
  });

  it("blocks the release when the pop-up has NO site restoration reserve of record", async () => {
    const store = makeStore();
    const escrowId = await seedPopupEscrow(store);
    const experienceId = await seedPopupExperience(store);
    await seedPopupWriteoff(store, experienceId);
    await reconcileSpatialAuditEscrow(store, {
      reserve_ledger_id: escrowId,
      scope_key: POPUP_SCOPE,
      evidence_ref: "popup-audit.pdf",
      reconciled_by: "compliance-desk",
    });

    const blocked = await releaseSpatialAuditEscrow(
      store,
      {
        reserve_ledger_id: escrowId,
        scope_key: POPUP_SCOPE,
        venue_id: VENUE_ID,
        popup_ref: POPUP_REF,
        payee_id: PAYEE_ID,
        operator_settlement_approved: true,
      },
      T0,
    );
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect(blocked.code).toBe("popup_restoration_reserve_missing");
  });

  it("releases once BOTH the write-off calculation and the restoration reserve are of record", async () => {
    const store = makeStore();
    const escrowId = await seedPopupEscrow(store);
    const experienceId = await seedPopupExperience(store);
    await seedPopupWriteoff(store, experienceId);
    await store.insertSpatialPopupRestorationReserve({
      popup_experience_id: experienceId,
      popup_ref: POPUP_REF,
      reserve_cents: 15_000,
      evidence_ref: "restoration-quote.pdf",
      funded_by: OPERATOR_ID,
    });
    await reconcileSpatialAuditEscrow(store, {
      reserve_ledger_id: escrowId,
      scope_key: POPUP_SCOPE,
      evidence_ref: "popup-audit.pdf",
      reconciled_by: "compliance-desk",
    });

    const released = await releaseSpatialAuditEscrow(
      store,
      {
        reserve_ledger_id: escrowId,
        scope_key: POPUP_SCOPE,
        venue_id: VENUE_ID,
        popup_ref: POPUP_REF,
        payee_id: PAYEE_ID,
        operator_settlement_approved: true,
      },
      T0,
    );
    expect(released.ok).toBe(true);
    if (!released.ok) return;
    expect(released.value.released_cents).toBe(70_000);
  });

  it("refuses the release when the pop-up experience of record itself is missing", async () => {
    const store = makeStore();
    const escrowId = await seedPopupEscrow(store);
    // No experience registered, no write-off, no reserve — the scope
    // alone is not enough.
    await reconcileSpatialAuditEscrow(store, {
      reserve_ledger_id: escrowId,
      scope_key: POPUP_SCOPE,
      evidence_ref: "popup-audit.pdf",
      reconciled_by: "compliance-desk",
    });
    const blocked = await releaseSpatialAuditEscrow(
      store,
      {
        reserve_ledger_id: escrowId,
        scope_key: POPUP_SCOPE,
        venue_id: VENUE_ID,
        popup_ref: POPUP_REF,
        payee_id: PAYEE_ID,
        operator_settlement_approved: true,
      },
      T0,
    );
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect(blocked.code).toBe("popup_experience_not_found");
  });

  it("the audit never gates a NON-pop-up park scope", async () => {
    const store = makeStore();
    await seedGateGreen(store, 700);
    const held = await seedHeldCredit(store, 1_000_000);
    const routed = await routeSpatialAuditEscrowFromHolding(
      store,
      { holding_ledger_id: held.id, venue_id: VENUE_ID, payee_id: PAYEE_ID, operator_settlement_approved: true },
      T0,
    );
    expect(routed.ok).toBe(true);
    const escrowId = routed.ok ? (routed.value.escrow_credit?.id ?? "") : "";
    await reconcileSpatialAuditEscrow(store, {
      reserve_ledger_id: escrowId,
      scope_key: ESCROW_SCOPE,
      evidence_ref: "park-audit.pdf",
      reconciled_by: "compliance-desk",
    });
    const released = await releaseSpatialAuditEscrow(
      store,
      { reserve_ledger_id: escrowId, scope_key: ESCROW_SCOPE, venue_id: VENUE_ID, payee_id: PAYEE_ID, operator_settlement_approved: true },
      T0,
    );
    expect(released.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The ledger invariant suite — the Don canon, scoped to the lane.
// ---------------------------------------------------------------------------

describe("the Don ledger invariants across the spatial lane", () => {
  it("moves integer cents everywhere — every journal leg in every posted journal", async () => {
    const store = makeStore();
    await seedGateGreen(store, 613);
    const held = await seedHeldCredit(store, 123_456);
    const routed = await routeSpatialAuditEscrowFromHolding(
      store,
      { holding_ledger_id: held.id, venue_id: VENUE_ID, payee_id: PAYEE_ID, operator_settlement_approved: true },
      T0,
    );
    expect(routed.ok).toBe(true);
    if (!routed.ok) return;
    const escrowId = routed.value.escrow_credit?.id ?? "";
    await drawDownSpatialAuditEscrow(store, {
      reserve_ledger_id: escrowId,
      scope_key: ESCROW_SCOPE,
      drawdown_class: "entertainment_sales_tax",
      source_event_id: "tax-1",
      drawn_cents: 1_234,
    }, T0);
    await reconcileSpatialAuditEscrow(store, {
      reserve_ledger_id: escrowId,
      scope_key: ESCROW_SCOPE,
      evidence_ref: "audit.pdf",
      reconciled_by: "compliance-desk",
    });
    await releaseSpatialAuditEscrow(
      store,
      { reserve_ledger_id: escrowId, scope_key: ESCROW_SCOPE, venue_id: VENUE_ID, payee_id: PAYEE_ID, operator_settlement_approved: true },
      T0,
    );

    const journals = await store.listGlJournals();
    for (const journal of journals) {
      for (const leg of await store.listGlEntriesByJournal(journal.id)) {
        expect(Number.isInteger(leg.debit_cents)).toBe(true);
        expect(Number.isInteger(leg.credit_cents)).toBe(true);
        expect(leg.debit_cents).toBeGreaterThanOrEqual(0);
        expect(leg.credit_cents).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("the escrow bucket never folds into platform dust, unclaimed holding, or the NIL escrow", async () => {
    const store = makeStore();
    await seedGateGreen(store, 700);
    const held = await seedHeldCredit(store, 999_999);
    const routed = await routeSpatialAuditEscrowFromHolding(
      store,
      { holding_ledger_id: held.id, venue_id: VENUE_ID, payee_id: PAYEE_ID, operator_settlement_approved: true },
      T0,
    );
    expect(routed.ok).toBe(true);
    if (!routed.ok) return;
    const escrow = routed.value.escrow_credit;
    expect(escrow?.kind).toBe("spatial_audit_escrow");
    expect(escrow?.payee_id.startsWith("nil_")).toBe(false);
    expect(escrow?.payee_id).not.toBe("platform");
    expect(routed.value.company_dust_cents).toBe(0);
    // allocations + dust == gross, with the escrow inside the allocations.
    expect(
      routed.value.split.remainder_cents +
        routed.value.split.escrow_cents +
        routed.value.company_dust_cents,
    ).toBe(999_999);
  });

  it("idempotency end-to-end: replaying the lane entry moves nothing twice", async () => {
    const store = makeStore();
    await seedGateGreen(store, 700);
    const held = await seedHeldCredit(store, 1_000_000);
    const routeInput = {
      holding_ledger_id: held.id,
      venue_id: VENUE_ID,
      payee_id: PAYEE_ID,
      operator_settlement_approved: true,
    };
    await routeSpatialAuditEscrowFromHolding(store, routeInput, T0);
    const snapshot = await store.listGlJournals();

    await routeSpatialAuditEscrowFromHolding(store, routeInput, T0);
    const after = await store.listGlJournals();
    expect(after).toHaveLength(snapshot.length);
  });
});
