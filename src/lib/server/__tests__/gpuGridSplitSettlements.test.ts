// The instant GPU grid-split cascade (PR 49, the founder resource
// directive) — the behavioral suite: PR 48's staged applications (the
// compute block's telemetry-weighted splits, staged journal_id null) post
// IMMEDIATELY between the silicon lessor, power provider, and hosting
// facility ledgers; a journal-stamped application is the completed posting
// of record (a replayed execution is a counted no-op — never a second
// split); a staged row whose legs do not conserve the pot refuses
// fail-closed; the staged row is the row of record (the OTA instant-
// posting discipline). The Don invariants hold throughout: integer cents,
// the participant legs + dust equals the pot, and the CAS as the
// concurrency arbiter.

import { describe, expect, it } from "vitest";

import { InMemoryStore } from "@/lib/server/inMemoryStore";
import type { Store } from "@/lib/server/store";
import {
  executeGpuGridSplitSettlement,
  gpuGridParticipantName,
  gpuGridSplitConservationHolds,
} from "@/lib/server/gpuGridSplitSettlements";

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

const T0 = new Date("2026-10-03T12:00:00.000Z");
const SOURCE_EVENT = "grid_split:GPUU-2026-03-0001:2026-03:USD";

/** Conservation-exact legs over a 50_000 pot — the walk's staged shape. */
function conservedLegs(): Array<{
  payee_id: string;
  participant_class: string;
  allocated_cents: number;
}> {
  return [
    {
      payee_id: "silicon-lessor",
      participant_class: "gpu_hardware_owner",
      allocated_cents: 27_273,
    },
    {
      payee_id: "power-provider-meridian",
      participant_class: "power_plant_operator",
      allocated_cents: 18_182,
    },
    {
      payee_id: "colocation-facility-delta",
      participant_class: "colocation_manager",
      allocated_cents: 4_545,
    },
  ];
}

async function seedStagedApplication(
  store: Store,
  overrides: Partial<{
    source_event_id: string;
    compute_revenue_cents: number;
    allocated_total_cents: number;
    split_legs: string;
  }> = {},
): Promise<void> {
  await store.insertEnergyComputeGridSplitApplication({
    source_event_id: overrides.source_event_id ?? SOURCE_EVENT,
    gpu_cluster_hash: "a1b2c3-cluster-hash",
    period: "2026-03",
    currency: "USD",
    compute_revenue_cents: overrides.compute_revenue_cents ?? 50_000,
    split_legs: overrides.split_legs ?? JSON.stringify(conservedLegs()),
    allocated_total_cents: overrides.allocated_total_cents ?? 50_000,
    journal_id: null,
  });
}

// ---------------------------------------------------------------------------
// The instant posting.
// ---------------------------------------------------------------------------

describe("executeGpuGridSplitSettlement — the instant cascade", () => {
  it("posts the staged split instantly: every participant credited, the journal stamped, the ledger balanced", async () => {
    const store = new InMemoryStore();
    await seedStagedApplication(store);

    const posted = await executeGpuGridSplitSettlement(store, SOURCE_EVENT, T0);
    expect(posted.ok).toBe(true);
    if (!posted.ok) return;

    expect(posted.value.replayed).toBe(false);
    expect(posted.value.journal_id).not.toBeNull();
    expect(posted.value.allocated_total_cents).toBe(50_000);

    // The three counterparties — the silicon lessor, the power provider,
    // the hosting facility — each credited their staged allocation
    // through the taxed cascade.
    expect(
      posted.value.credits.map((credit) => ({
        payee_id: credit.payee_id,
        gross_cents: credit.gross_cents,
      })),
    ).toEqual([
      { payee_id: "silicon-lessor", gross_cents: 27_273 },
      { payee_id: "power-provider-meridian", gross_cents: 18_182 },
      { payee_id: "colocation-facility-delta", gross_cents: 4_545 },
    ]);
    for (const credit of posted.value.credits) {
      expect(credit.net_cents).toBeGreaterThan(0);
      expect(credit.net_cents).toBeLessThanOrEqual(credit.gross_cents);
    }

    // The journal of record balanced.
    const journalId = posted.value.journal_id;
    if (journalId === null) throw new Error("expected a stamped journal id");
    const entries = await store.listGlEntriesByJournal(journalId);
    expect(entries.length).toBeGreaterThan(0);
    const debits = entries.reduce((total, entry) => total + entry.debit_cents, 0);
    const credits = entries.reduce((total, entry) => total + entry.credit_cents, 0);
    expect(debits).toBe(credits);
    expect(debits).toBe(50_000);

    // The staged application's journal stamp IS the posting of record.
    const stamped = await store.getEnergyComputeGridSplitApplication(SOURCE_EVENT);
    expect(stamped?.journal_id).toBe(journalId);
  });

  it("replays a journal-stamped application as a counted no-op — no second split", async () => {
    const store = new InMemoryStore();
    await seedStagedApplication(store);

    const first = await executeGpuGridSplitSettlement(store, SOURCE_EVENT, T0);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const firstJournalId = first.value.journal_id;

    const journalsBefore = await store.listGlJournals();
    const replay = await executeGpuGridSplitSettlement(store, SOURCE_EVENT, T0);
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.value.replayed).toBe(true);
    expect(replay.value.journal_id).toBe(firstJournalId);
    expect(replay.value.credits).toEqual([]);

    const journalsAfter = await store.listGlJournals();
    expect(journalsAfter.length).toBe(journalsBefore.length);
  });

  it("fails closed on an absent staged application", async () => {
    const store = new InMemoryStore();

    const posted = await executeGpuGridSplitSettlement(store, "grid_split:missing", T0);
    expect(posted.ok).toBe(false);
    if (posted.ok) return;
    expect(posted.code).toBe("grid_split_application_not_found");
    expect(posted.status).toBe(404);
  });

  it("refuses a staged application whose legs do not conserve the pot", async () => {
    const store = new InMemoryStore();
    // The staged legs sum to 49_999 against a 50_000 pot — one cent lost.
    await seedStagedApplication(store, {
      split_legs: JSON.stringify(
        conservedLegs().map((leg) =>
          leg.participant_class === "colocation_manager"
            ? { ...leg, allocated_cents: leg.allocated_cents - 1 }
            : leg,
        ),
      ),
    });

    const posted = await executeGpuGridSplitSettlement(store, SOURCE_EVENT, T0);
    expect(posted.ok).toBe(false);
    if (posted.ok) return;
    expect(posted.code).toBe("grid_split_conservation_violation");
    expect(posted.status).toBe(500);

    // Nothing stamped — the staged row remains the row of record.
    const unstamped = await store.getEnergyComputeGridSplitApplication(SOURCE_EVENT);
    expect(unstamped?.journal_id).toBeNull();
  });

  it("refuses a staged application whose legs do not parse", async () => {
    const store = new InMemoryStore();
    await seedStagedApplication(store, { split_legs: "not-json" });

    const posted = await executeGpuGridSplitSettlement(store, SOURCE_EVENT, T0);
    expect(posted.ok).toBe(false);
    if (posted.ok) return;
    expect(posted.code).toBe("grid_split_legs_unparsable");
  });

  it("refuses an empty settlement identity", async () => {
    const store = new InMemoryStore();

    const posted = await executeGpuGridSplitSettlement(store, "   ", T0);
    expect(posted.ok).toBe(false);
    if (posted.ok) return;
    expect(posted.code).toBe("invalid_settlement_identity");
  });
});

// ---------------------------------------------------------------------------
// The pure conservation check and the founder-vocabulary names.
// ---------------------------------------------------------------------------

describe("gpuGridSplitConservationHolds — the pure identity", () => {
  it("accepts conservation-exact legs and refuses every other shape", () => {
    expect(gpuGridSplitConservationHolds(conservedLegs(), 50_000)).toBe(true);

    // A lost cent refuses.
    expect(gpuGridSplitConservationHolds(conservedLegs(), 50_001)).toBe(false);
    expect(gpuGridSplitConservationHolds(conservedLegs(), 49_999)).toBe(false);

    // Empty legs refuse (a split with no counterparties is not a split).
    expect(gpuGridSplitConservationHolds([], 0)).toBe(false);

    // Non-integer or negative allocations refuse.
    expect(
      gpuGridSplitConservationHolds(
        conservedLegs().map((leg) => ({ ...leg, allocated_cents: 16666.67 })),
        50_000,
      ),
    ).toBe(false);
    expect(
      gpuGridSplitConservationHolds(
        conservedLegs().map((leg) => ({ ...leg, allocated_cents: -1 })),
        50_000,
      ),
    ).toBe(false);

    // Blank payee ids refuse.
    expect(
      gpuGridSplitConservationHolds(
        conservedLegs().map((leg) => ({ ...leg, payee_id: " " })),
        50_000,
      ),
    ).toBe(false);
  });

  it("names the counterparties in the founder's vocabulary", () => {
    expect(gpuGridParticipantName("gpu_hardware_owner", "lessor-1")).toBe(
      "Silicon lessor lessor-1",
    );
    expect(gpuGridParticipantName("power_plant_operator", "plant-1")).toBe(
      "Power provider plant-1",
    );
    expect(gpuGridParticipantName("colocation_manager", "facility-1")).toBe(
      "Hosting facility facility-1",
    );
  });
});
