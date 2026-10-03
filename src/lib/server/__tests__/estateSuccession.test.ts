// Estate succession + multi-heir splitting (PR 29, migration 0033) — the
// engine behavior suite on the in-memory store, mirroring the art-cascade
// test discipline:
//
//   1. Receiving-entity transition ONLY on a verified legal certificate —
//      absent, pending, and rejected all refuse fail-closed; a verified
//      certificate records the append-only handoff; a replayed event is a
//      409, never a double handoff.
//   2. Multi-heir fractional splitting exact to the cent, keyed on the
//      verified probate percentages (configurable per probate), dust to
//      the platform variance payee — never an heir.
//   3. The estate payout gate reads estate_succession_verified fail-closed:
//      absent → vertical_state_unknown; 'unknown' →
//      art_estate_succession_unverified; only 'verified' passes.
//   4. Provenance tracking: artwork_id and provenance_hash propagate onto
//      the line items (transitions and accruals) for audit.
//   5. The probate schedule of record: configurable per probate, versioned
//      on amendment, never re-cutting accrued history.

import { describe, expect, it } from "vitest";
import { InMemoryStore } from "@/lib/server/inMemoryStore";
import {
  accrueEstateHeirSplit,
  estateHeirSplits,
  registerEstateHeirSchedule,
  resolveReceivingEntity,
  transitionReceivingEntity,
  verifyEstateSuccessionCertificate,
} from "@/lib/server/estateSuccession";
import {
  evaluatePayoutCompliance,
  resolveArtVerticalComplianceState,
} from "@/modules/compliance/payoutGate";

const T0 = new Date("2026-10-01T12:00:00.000Z");
const T1 = new Date("2026-10-01T12:00:01.000Z");
const T2 = new Date("2026-10-01T12:00:02.000Z");

const ARTIST = "payee-artist-1";
const ESTATE = "payee-estate-foundation";
const HEIR_SPOUSE = "payee-heir-spouse";
const HEIR_CHILD_A = "payee-heir-child-a";
const HEIR_CHILD_B = "payee-heir-child-b";

const CERT_HASH = "a".repeat(64);

async function seedVerifiedCertificate(
  store: InMemoryStore,
): Promise<{ certificateId: string }> {
  const certificate = await verifyEstateSuccessionCertificate(
    store,
    {
      artist_payee_id: ARTIST,
      certificate_ref: "PROBATE-2026-001",
      certificate_hash: CERT_HASH,
      estate_entity_payee_id: ESTATE,
      estate_entity_payee_name: "The Artist Foundation",
      validation_state: "verified",
      verified_by: "operator-founder",
    },
    T0,
  );
  if ("ok" in certificate) throw new Error("seed certificate refused");
  return { certificateId: certificate.id };
}

describe("estate receiving-entity transition — verified certificate only", () => {
  it("refuses fail-closed when no certificate of record exists", async () => {
    const store = new InMemoryStore();
    const outcome = await transitionReceivingEntity(store, {
      artist_payee_id: ARTIST,
      source_event_id: "funding-event-1",
    });
    expect(outcome).toMatchObject({ ok: false, status: 422, code: "estate_succession_not_verified" });
    // Nothing was recorded — the append-only history stays empty.
    expect(await store.listEstateSuccessionTransitions("no-such-certificate")).toEqual([]);
  });

  it("refuses fail-closed on pending and rejected certificates", async () => {
    const store = new InMemoryStore();
    const pending = await verifyEstateSuccessionCertificate(
      store,
      {
        artist_payee_id: ARTIST,
        certificate_ref: "PROBATE-PENDING",
        certificate_hash: CERT_HASH,
        estate_entity_payee_id: ESTATE,
        estate_entity_payee_name: "The Artist Foundation",
        validation_state: "pending",
      },
      T0,
    );
    expect(pending).not.toHaveProperty("ok", false);
    const pendingOutcome = await transitionReceivingEntity(store, {
      artist_payee_id: ARTIST,
      source_event_id: "funding-event-pending",
    });
    expect(pendingOutcome).toMatchObject({ ok: false, status: 422, code: "estate_succession_not_verified" });

    const rejected = await verifyEstateSuccessionCertificate(
      store,
      {
        artist_payee_id: "payee-artist-2",
        certificate_ref: "PROBATE-REJECTED",
        certificate_hash: CERT_HASH,
        estate_entity_payee_id: ESTATE,
        estate_entity_payee_name: "The Artist Foundation",
        validation_state: "rejected",
      },
      T0,
    );
    expect(rejected).not.toHaveProperty("ok", false);
    const rejectedOutcome = await transitionReceivingEntity(store, {
      artist_payee_id: "payee-artist-2",
      source_event_id: "funding-event-rejected",
    });
    expect(rejectedOutcome).toMatchObject({ ok: false, status: 422, code: "estate_succession_not_verified" });
  });

  it("records the append-only handoff on a verified certificate and stamps the verifier", async () => {
    const store = new InMemoryStore();
    const { certificateId } = await seedVerifiedCertificate(store);
    const outcome = await transitionReceivingEntity(
      store,
      {
        artist_payee_id: ARTIST,
        source_event_id: "funding-event-1",
        artwork_id: "artwork-1",
        provenance_hash: "b".repeat(64),
      },
      T1,
    );
    expect(outcome).not.toHaveProperty("ok", false);
    if ("ok" in outcome) throw new Error("verified transition refused");
    expect(outcome.certificate_id).toBe(certificateId);
    expect(outcome.artist_payee_id).toBe(ARTIST);
    expect(outcome.estate_entity_payee_id).toBe(ESTATE);
    expect(outcome.artwork_id).toBe("artwork-1");
    expect(outcome.provenance_hash).toBe("b".repeat(64));
    expect(outcome.created_at).toBe(T1.toISOString());

    // The history is append-only: the read returns exactly the recorded
    // handoff, and the certificate itself is untouched.
    const history = await store.listEstateSuccessionTransitions(certificateId);
    expect(history).toHaveLength(1);
    expect(history[0]?.source_event_id).toBe("funding-event-1");
    const certificate = await store.getEstateSuccessionCertificateById(certificateId);
    expect(certificate?.validation_state).toBe("verified");
  });

  it("refuses a replayed event with 409 — never a double handoff", async () => {
    const store = new InMemoryStore();
    const { certificateId } = await seedVerifiedCertificate(store);
    const first = await transitionReceivingEntity(store, {
      artist_payee_id: ARTIST,
      source_event_id: "funding-event-1",
    });
    expect(first).not.toHaveProperty("ok", false);
    const replay = await transitionReceivingEntity(store, {
      artist_payee_id: ARTIST,
      source_event_id: "funding-event-1",
    });
    expect(replay).toMatchObject({ ok: false, status: 409, code: "estate_transition_already_recorded" });
    expect(await store.listEstateSuccessionTransitions(certificateId)).toHaveLength(1);
  });

  it("derives is_artist_estate fail-closed in both directions", async () => {
    const store = new InMemoryStore();
    // No certificate of record — the artist still receives.
    expect(await resolveReceivingEntity(store, ARTIST)).toEqual({
      is_artist_estate: false,
      receiving_payee_id: ARTIST,
      receiving_payee_name: ARTIST,
    });
    await verifyEstateSuccessionCertificate(
      store,
      {
        artist_payee_id: ARTIST,
        certificate_ref: "PROBATE-2026-001",
        certificate_hash: CERT_HASH,
        estate_entity_payee_id: ESTATE,
        estate_entity_payee_name: "The Artist Foundation",
        validation_state: "verified",
        verified_by: "operator-founder",
      },
      T0,
    );
    expect(await resolveReceivingEntity(store, ARTIST)).toEqual({
      is_artist_estate: true,
      receiving_payee_id: ESTATE,
      receiving_payee_name: "The Artist Foundation",
    });
  });
});

describe("multi-heir probate splitting — exact to the cent, dust to platform", () => {
  it("splits the founder's example exactly: spouse 50 / child A 25 / child B 25", () => {
    const heirs = [
      { heir_payee_id: HEIR_SPOUSE, heir_payee_name: "Spouse", relationship: "spouse" as const, percentage_bps: 5_000 },
      { heir_payee_id: HEIR_CHILD_A, heir_payee_name: "Child A", relationship: "child" as const, percentage_bps: 2_500 },
      { heir_payee_id: HEIR_CHILD_B, heir_payee_name: "Child B", relationship: "child" as const, percentage_bps: 2_500 },
    ];
    const { allocations, dustCents } = estateHeirSplits(10_000_00, heirs);
    expect(allocations).toEqual([
      { heir_payee_id: HEIR_SPOUSE, heir_payee_name: "Spouse", relationship: "spouse", share_cents: 5_000_00 },
      { heir_payee_id: HEIR_CHILD_A, heir_payee_name: "Child A", relationship: "child", share_cents: 2_500_00 },
      { heir_payee_id: HEIR_CHILD_B, heir_payee_name: "Child B", relationship: "child", share_cents: 2_500_00 },
    ]);
    expect(dustCents).toBe(0);
  });

  it("floors each share and routes the residue as dust — conservation exact", () => {
    // 100 cents at 1/3 apiece: floor(33.33) × 3 = 99, dust 1.
    const thirds = [
      { heir_payee_id: HEIR_SPOUSE, heir_payee_name: "Spouse", relationship: "spouse" as const, percentage_bps: 3_333 },
      { heir_payee_id: HEIR_CHILD_A, heir_payee_name: "Child A", relationship: "child" as const, percentage_bps: 3_333 },
      { heir_payee_id: HEIR_CHILD_B, heir_payee_name: "Child B", relationship: "child" as const, percentage_bps: 3_334 },
    ];
    const { allocations, dustCents } = estateHeirSplits(100, thirds);
    expect(allocations.map((allocation) => allocation.share_cents)).toEqual([33, 33, 33]);
    expect(allocations.reduce((sum, allocation) => sum + allocation.share_cents, 0) + dustCents).toBe(100);
    expect(dustCents).toBe(1);
    // Sub-cent basis: every floor lands at 0 — the whole basis is dust.
    const dustOnly = estateHeirSplits(1, thirds);
    expect(dustOnly.allocations).toEqual([]);
    expect(dustOnly.dustCents).toBe(1);
  });

  it("never lets a share round up into an heir's credit", () => {
    // 101 cents × 50% = 50.5 → floor 50; conservation pins the residue.
    const { allocations, dustCents } = estateHeirSplits(101, [
      { heir_payee_id: HEIR_SPOUSE, heir_payee_name: "Spouse", relationship: "spouse" as const, percentage_bps: 5_000 },
      { heir_payee_id: HEIR_CHILD_A, heir_payee_name: "Child A", relationship: "child" as const, percentage_bps: 2_500 },
      { heir_payee_id: HEIR_CHILD_B, heir_payee_name: "Child B", relationship: "child" as const, percentage_bps: 2_500 },
    ]);
    expect(allocations.map((allocation) => allocation.share_cents)).toEqual([50, 25, 25]);
    expect(allocations.reduce((sum, allocation) => sum + allocation.share_cents, 0) + dustCents).toBe(101);
  });
});

describe("estate split accrual — the once-only designation behind the gates", () => {
  it("accrues the verified probate split with dust and provenance carried", async () => {
    const store = new InMemoryStore();
    const { certificateId } = await seedVerifiedCertificate(store);
    const schedule = await registerEstateHeirSchedule(
      store,
      {
        certificate_id: certificateId,
        heirs: [
          { heir_payee_id: HEIR_SPOUSE, heir_payee_name: "Spouse", relationship: "spouse", percentage_bps: 5_000 },
          { heir_payee_id: HEIR_CHILD_A, heir_payee_name: "Child A", relationship: "child", percentage_bps: 2_500 },
          { heir_payee_id: HEIR_CHILD_B, heir_payee_name: "Child B", relationship: "child", percentage_bps: 2_500 },
        ],
      },
      T1,
    );
    if ("ok" in schedule) throw new Error("schedule registration refused");
    const outcome = await accrueEstateHeirSplit(
      store,
      {
        certificate: (await store.getEstateSuccessionCertificateById(certificateId))!,
        schedule,
        source_event_id: "funding-event-1",
        artwork_id: "artwork-1",
        provenance_hash: "c".repeat(64),
        basis_cents: 123_45,
      },
      T2,
    );
    expect(outcome).not.toHaveProperty("ok", false);
    if (!("accrual" in outcome) || outcome.accrual === null) throw new Error("accrual missing");
    expect(outcome.accrual.allocations).toEqual([
      { heir_payee_id: HEIR_SPOUSE, heir_payee_name: "Spouse", relationship: "spouse", share_cents: 6_172 },
      { heir_payee_id: HEIR_CHILD_A, heir_payee_name: "Child A", relationship: "child", share_cents: 3_086 },
      { heir_payee_id: HEIR_CHILD_B, heir_payee_name: "Child B", relationship: "child", share_cents: 3_086 },
    ]);
    // Conservation: allocations + dust = basis, exact.
    const allocated = outcome.accrual.allocations.reduce((sum, allocation) => sum + allocation.share_cents, 0);
    expect(allocated + outcome.accrual.dust_cents).toBe(123_45);
    // Provenance keyed on the artwork, hash carried for audit.
    expect(outcome.accrual.artwork_id).toBe("artwork-1");
    expect(outcome.accrual.provenance_hash).toBe("c".repeat(64));
    expect(outcome.accrual.basis_cents).toBe(123_45);
  });

  it("replays an accrued event as a no-op — never a double designation", async () => {
    const store = new InMemoryStore();
    const { certificateId } = await seedVerifiedCertificate(store);
    const schedule = await registerEstateHeirSchedule(store, {
      certificate_id: certificateId,
      heirs: [
        { heir_payee_id: HEIR_SPOUSE, heir_payee_name: "Spouse", relationship: "spouse", percentage_bps: 5_000 },
        { heir_payee_id: HEIR_CHILD_A, heir_payee_name: "Child A", relationship: "child", percentage_bps: 2_500 },
        { heir_payee_id: HEIR_CHILD_B, heir_payee_name: "Child B", relationship: "child", percentage_bps: 2_500 },
      ],
    });
    if ("ok" in schedule) throw new Error("schedule registration refused");
    const certificate = (await store.getEstateSuccessionCertificateById(certificateId))!;
    const input = {
      certificate,
      schedule,
      source_event_id: "funding-event-1",
      artwork_id: "artwork-1",
      provenance_hash: "c".repeat(64),
      basis_cents: 10_000_00,
    };
    const first = await accrueEstateHeirSplit(store, input, T1);
    expect(first).not.toHaveProperty("ok", false);
    const replay = await accrueEstateHeirSplit(store, input, T2);
    expect(replay).toEqual({ accrual: null, replayed: true });
    // The append-only ledger keeps exactly one designation.
    expect(await store.listEstateSplitAccruals(certificateId)).toHaveLength(1);
  });

  it("accrues the same event across several artworks — the provenance triple is the key", async () => {
    const store = new InMemoryStore();
    const { certificateId } = await seedVerifiedCertificate(store);
    const schedule = await registerEstateHeirSchedule(store, {
      certificate_id: certificateId,
      heirs: [
        { heir_payee_id: HEIR_SPOUSE, heir_payee_name: "Spouse", relationship: "spouse", percentage_bps: 10_000 },
      ],
    });
    if ("ok" in schedule) throw new Error("schedule registration refused");
    const certificate = (await store.getEstateSuccessionCertificateById(certificateId))!;
    for (const artwork of ["artwork-1", "artwork-2"]) {
      const outcome = await accrueEstateHeirSplit(store, {
        certificate,
        schedule,
        source_event_id: "funding-event-1",
        artwork_id: artwork,
        provenance_hash: "d".repeat(64),
        basis_cents: 1_000,
      });
      expect(outcome).not.toHaveProperty("ok", false);
    }
    expect(await store.listEstateSplitAccruals(certificateId)).toHaveLength(2);
  });
});

describe("the probate schedule of record — configurable per probate", () => {
  it("registers versioned schedules and amends without re-cutting accrued history", async () => {
    const store = new InMemoryStore();
    const { certificateId } = await seedVerifiedCertificate(store);
    const original = await registerEstateHeirSchedule(store, {
      certificate_id: certificateId,
      heirs: [
        { heir_payee_id: HEIR_SPOUSE, heir_payee_name: "Spouse", relationship: "spouse", percentage_bps: 5_000 },
        { heir_payee_id: HEIR_CHILD_A, heir_payee_name: "Child A", relationship: "child", percentage_bps: 5_000 },
      ],
    });
    if ("ok" in original) throw new Error("schedule registration refused");
    expect(original.version).toBe(1);

    // Accrue under version 1.
    const certificate = (await store.getEstateSuccessionCertificateById(certificateId))!;
    await accrueEstateHeirSplit(store, {
      certificate,
      schedule: original,
      source_event_id: "funding-event-1",
      artwork_id: "artwork-1",
      provenance_hash: "c".repeat(64),
      basis_cents: 10_000_00,
    });

    // A probate amendment re-cuts future splits but keeps identity — and
    // the accrued row keeps its original shares (history, never re-cut).
    const amended = await registerEstateHeirSchedule(store, {
      certificate_id: certificateId,
      heirs: [
        { heir_payee_id: HEIR_SPOUSE, heir_payee_name: "Spouse", relationship: "spouse", percentage_bps: 7_000 },
        { heir_payee_id: HEIR_CHILD_A, heir_payee_name: "Child A", relationship: "child", percentage_bps: 3_000 },
      ],
    });
    if ("ok" in amended) throw new Error("schedule amendment refused");
    expect(amended.version).toBe(2);
    expect(amended.id).toBe(original.id);
    const accruals = await store.listEstateSplitAccruals(certificateId);
    expect(accruals).toHaveLength(1);
    expect(accruals[0]?.schedule_id).toBe(original.id);
    expect(accruals[0]?.allocations).toEqual([
      { heir_payee_id: HEIR_SPOUSE, heir_payee_name: "Spouse", relationship: "spouse", share_cents: 5_000_00 },
      { heir_payee_id: HEIR_CHILD_A, heir_payee_name: "Child A", relationship: "child", share_cents: 5_000_00 },
    ]);
    // Future accruals use the amended percentages.
    const postAmendment = await accrueEstateHeirSplit(store, {
      certificate,
      schedule: amended,
      source_event_id: "funding-event-2",
      artwork_id: "artwork-1",
      provenance_hash: "c".repeat(64),
      basis_cents: 10_000_00,
    });
    expect(postAmendment).not.toHaveProperty("ok", false);
    if ("accrual" in postAmendment && postAmendment.accrual !== null) {
      expect(postAmendment.accrual.allocations).toEqual([
        { heir_payee_id: HEIR_SPOUSE, heir_payee_name: "Spouse", relationship: "spouse", share_cents: 7_000_00 },
        { heir_payee_id: HEIR_CHILD_A, heir_payee_name: "Child A", relationship: "child", share_cents: 3_000_00 },
      ]);
    }
  });

  it("refuses a schedule over the whole basis, unknown relationships, and missing certificates", async () => {
    const store = new InMemoryStore();
    const { certificateId } = await seedVerifiedCertificate(store);
    const overBasis = await registerEstateHeirSchedule(store, {
      certificate_id: certificateId,
      heirs: [
        { heir_payee_id: HEIR_SPOUSE, heir_payee_name: "Spouse", relationship: "spouse", percentage_bps: 6_000 },
        { heir_payee_id: HEIR_CHILD_A, heir_payee_name: "Child A", relationship: "child", percentage_bps: 5_000 },
      ],
    });
    expect(overBasis).toMatchObject({ ok: false, status: 422, code: "invalid_schedule_input" });
    const unknownRelationship = await registerEstateHeirSchedule(store, {
      certificate_id: certificateId,
      heirs: [
        {
          heir_payee_id: HEIR_SPOUSE,
          heir_payee_name: "Spouse",
          relationship: "second_cousin_twice_removed" as never,
          percentage_bps: 10_000,
        },
      ],
    });
    expect(unknownRelationship).toMatchObject({ ok: false, status: 422, code: "invalid_schedule_input" });
    const noCertificate = await registerEstateHeirSchedule(store, {
      certificate_id: "no-such-certificate",
      heirs: [
        { heir_payee_id: HEIR_SPOUSE, heir_payee_name: "Spouse", relationship: "spouse", percentage_bps: 10_000 },
      ],
    });
    expect(noCertificate).toMatchObject({ ok: false, status: 404, code: "estate_certificate_not_found" });
  });
});

describe("the estate payout gate — fail-closed on estate_succession_verified", () => {
  it("refuses vertical_state_unknown when no gate state of record exists", async () => {
    const store = new InMemoryStore();
    const state = await resolveArtVerticalComplianceState(store, HEIR_SPOUSE);
    expect(state).toBeNull();
    const compliance = evaluatePayoutCompliance({
      operatorSettlementApproved: true,
      kycStatus: "verified",
      verticalState: state,
    });
    expect(compliance).toMatchObject({ ok: false, code: "vertical_state_unknown" });
  });

  it("refuses art_estate_succession_unverified on the unknown state of record", async () => {
    const store = new InMemoryStore();
    await verifyEstateSuccessionCertificate(
      store,
      {
        artist_payee_id: ARTIST,
        certificate_ref: "PROBATE-PENDING",
        certificate_hash: CERT_HASH,
        estate_entity_payee_id: ESTATE,
        estate_entity_payee_name: "The Artist Foundation",
        validation_state: "pending",
      },
      T0,
    );
    // A pending certificate converges nothing — but a pre-seeded 'unknown'
    // state of record must refuse regardless.
    await store.upsertEstatePayoutGateState({
      payee_id: ESTATE,
      estate_succession_state: "unknown",
      certificate_ref: "PROBATE-PENDING",
      verified_by: null,
    });
    const state = await resolveArtVerticalComplianceState(store, ESTATE);
    expect(state).toEqual({ vertical: "art", estate_succession_verified: false });
    const compliance = evaluatePayoutCompliance({
      operatorSettlementApproved: true,
      kycStatus: "verified",
      verticalState: state,
    });
    expect(compliance).toMatchObject({ ok: false, code: "art_estate_succession_unverified" });
  });

  it("passes only on the verified state of record", async () => {
    const store = new InMemoryStore();
    const { certificateId } = await seedVerifiedCertificate(store);
    // The verified certificate converged the estate entity's gate state.
    const certificate = (await store.getEstateSuccessionCertificateById(certificateId))!;
    const state = await resolveArtVerticalComplianceState(store, certificate.estate_entity_payee_id);
    expect(state).toEqual({ vertical: "art", estate_succession_verified: true });
    const compliance = evaluatePayoutCompliance({
      operatorSettlementApproved: true,
      kycStatus: "verified",
      verticalState: state,
    });
    expect(compliance).toMatchObject({ ok: true });
  });

  it("converges heir gate states when a verified schedule registers", async () => {
    const store = new InMemoryStore();
    const { certificateId } = await seedVerifiedCertificate(store);
    await registerEstateHeirSchedule(store, {
      certificate_id: certificateId,
      heirs: [
        { heir_payee_id: HEIR_SPOUSE, heir_payee_name: "Spouse", relationship: "spouse", percentage_bps: 5_000 },
        { heir_payee_id: HEIR_CHILD_A, heir_payee_name: "Child A", relationship: "child", percentage_bps: 2_500 },
        { heir_payee_id: HEIR_CHILD_B, heir_payee_name: "Child B", relationship: "child", percentage_bps: 2_500 },
      ],
    });
    for (const heir of [HEIR_SPOUSE, HEIR_CHILD_A, HEIR_CHILD_B]) {
      const state = await resolveArtVerticalComplianceState(store, heir);
      expect(state).toEqual({ vertical: "art", estate_succession_verified: true });
    }
  });
});

describe("the locked Don invariants hold on the estate lane", () => {
  it("conserves allocations + dust = basis across the accrual ledger, integer cents only", async () => {
    const store = new InMemoryStore();
    const { certificateId } = await seedVerifiedCertificate(store);
    const schedule = await registerEstateHeirSchedule(store, {
      certificate_id: certificateId,
      heirs: [
        { heir_payee_id: HEIR_SPOUSE, heir_payee_name: "Spouse", relationship: "spouse", percentage_bps: 3_333 },
        { heir_payee_id: HEIR_CHILD_A, heir_payee_name: "Child A", relationship: "child", percentage_bps: 3_333 },
        { heir_payee_id: HEIR_CHILD_B, heir_payee_name: "Child B", relationship: "child", percentage_bps: 3_334 },
      ],
    });
    if ("ok" in schedule) throw new Error("schedule registration refused");
    const certificate = (await store.getEstateSuccessionCertificateById(certificateId))!;
    for (const [index, basis] of [1, 7, 101, 123_45, 10_000_00].entries()) {
      await accrueEstateHeirSplit(store, {
        certificate,
        schedule,
        source_event_id: `funding-event-${index}`,
        artwork_id: "artwork-1",
        provenance_hash: "c".repeat(64),
        basis_cents: basis,
      });
    }
    const accruals = await store.listEstateSplitAccruals(certificateId);
    expect(accruals).toHaveLength(5);
    for (const accrual of accruals) {
      expect(Number.isInteger(accrual.basis_cents)).toBe(true);
      expect(Number.isInteger(accrual.dust_cents)).toBe(true);
      for (const allocation of accrual.allocations) {
        expect(Number.isInteger(allocation.share_cents)).toBe(true);
        // Dust never enters an heir's credit: every allocation is floor-
        // derived, and the dust payee of record is the platform variance
        // payee — never an heir.
        expect(allocation.heir_payee_id).not.toBe("platform");
      }
      const allocated = accrual.allocations.reduce((sum, allocation) => sum + allocation.share_cents, 0);
      expect(allocated + accrual.dust_cents).toBe(accrual.basis_cents);
    }
  });

  it("keeps certificate validation state the sole transition arbiter — idempotent verification converges", async () => {
    const store = new InMemoryStore();
    await verifyEstateSuccessionCertificate(
      store,
      {
        artist_payee_id: ARTIST,
        certificate_ref: "PROBATE-2026-001",
        certificate_hash: CERT_HASH,
        estate_entity_payee_id: ESTATE,
        estate_entity_payee_name: "The Artist Foundation",
        validation_state: "pending",
      },
      T0,
    );
    await verifyEstateSuccessionCertificate(
      store,
      {
        artist_payee_id: ARTIST,
        certificate_ref: "PROBATE-2026-001",
        certificate_hash: CERT_HASH,
        estate_entity_payee_id: ESTATE,
        estate_entity_payee_name: "The Artist Foundation",
        validation_state: "verified",
        verified_by: "operator-founder",
      },
      T1,
    );
    // Re-verification converges on the SAME row — idempotent identity,
    // and the newest verification act re-stamps verified_at (the newest
    // validation state governs).
    const reverified = await verifyEstateSuccessionCertificate(
      store,
      {
        artist_payee_id: ARTIST,
        certificate_ref: "PROBATE-2026-001",
        certificate_hash: CERT_HASH,
        estate_entity_payee_id: ESTATE,
        estate_entity_payee_name: "The Artist Foundation",
        validation_state: "verified",
        verified_by: "operator-founder",
      },
      T2,
    );
    if ("ok" in reverified) throw new Error("re-verification refused");
    expect(reverified.verified_at).toBe(T2.toISOString());
    expect((await store.getVerifiedEstateSuccessionCertificate(ARTIST))?.id).toBe(reverified.id);
  });
});
