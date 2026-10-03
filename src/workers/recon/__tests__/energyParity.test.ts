/**
 * Three-backend parity for the energy lane (PR 48, the founder resource
 * directive) — the worker end-to-end over InMemoryStore, SqliteStore,
 * and SupabaseStore (behavioral fake).
 *
 * The scenario: all four sender sheets ingested → pinned strict profile
 * dispatch → the energy walks (the Net Resource Realization recompute
 * keyed on the founder's parcel_id / well_meter_id / gpu_cluster_hash
 * columns, the tiered fractional royalties with cumulative tracking,
 * the acreage-ratio divisions, the deed-transfer statutory interest
 * accruals, the tiered GPU yields, the telemetry-weighted grid splits,
 * and the per-tonne carbon payouts); then the same four sheets
 * re-shipped (the counted no-op replay). Every backend must produce the
 * identical result counters, the identical application rows of record,
 * and the identical positions.
 */
import { describe, expect, it } from "vitest";

import { InMemoryStore } from "@/lib/server/inMemoryStore";
import { SqliteStore } from "@/lib/server/sqliteStore";
import type { Store } from "@/lib/server/store";
import type { ReconJobResult } from "@/modules/recon/records";
import { energyRowEventId } from "../energy";
import { runOnce } from "../worker";
import { loadFixture } from "./fixtures";
import { makeFakeSupabaseStore } from "./fakeSupabase";
import { ENERGY_FIXTURES, registerEnergyPolicies } from "./energyScenario";

const NOW = () => new Date("2026-10-03T12:00:00Z");

const BACKENDS = [
  { name: "InMemoryStore", make: () => new InMemoryStore() },
  { name: "SqliteStore", make: () => new SqliteStore(":memory:") },
  {
    name: "SupabaseStore",
    make: () => makeFakeSupabaseStore(),
  },
] as const;

/** The energy lane does no vault matching — a null lookup is the vault. */
function nullVault() {
  return { findByIdentifier: async () => null };
}

/**
 * Ingests each of the four sender sheets, enqueues its recon job, and
 * runs the worker once per job — the real ingest → job → parse → walk
 * path. Returns the four jobs' result objects.
 */
async function runEnergyPass(
  store: Store,
): Promise<Array<ReconJobResult | null | undefined>> {
  const results: Array<ReconJobResult | null | undefined> = [];
  for (const fixture of ENERGY_FIXTURES) {
    const ingest = await store.insertStatementIngest({
      format: "csv_statement",
      source: "statement",
      file_name: fixture,
      content: loadFixture(fixture),
      status: "parsed",
      event_count: null,
      error: null,
      created_at: NOW().toISOString(),
    });
    await store.createReconJob({ source: "statement", ingest_id: ingest.id });
    const processed = await runOnce({ store, vault: nullVault(), now: NOW });
    results.push(processed?.job.result);
  }
  return results;
}

/** The energy_* counters, summed across a pass's four job results. */
function energyCounters(
  results: Array<ReconJobResult | null | undefined>,
): Record<string, number> {
  const sums: Record<string, number> = {};
  for (const result of results) {
    if (!result) continue;
    for (const [key, value] of Object.entries(result)) {
      if (key.startsWith("energy_") && typeof value === "number") {
        sums[key] = (sums[key] ?? 0) + value;
      }
    }
  }
  return sums;
}

/**
 * The lane's rows of record, projected id-free (UUIDs and timestamps
 * legitimately differ per backend; content-derived event ids, money,
 * verdicts, and conserved legs may not). Order follows the fixtures'
 * row order — deterministic on every backend.
 */
async function energyProjection(store: Store) {
  // TRACT-77's realization of record — the full founder identity after
  // both meter rows and the deduction row posted.
  const tract77 = await store.getEnergyNetRealizationApplication(
    energyRowEventId(
      "realization",
      "TRACT-77:WELL-77-A:a1b2c3-cluster-hash",
      "2026-03:USD",
    ),
  );
  // TRACT-HELD's — the deduction exceeded the gross: HELD.
  const tractHeld = await store.getEnergyNetRealizationApplication(
    energyRowEventId("realization", "TRACT-HELD:WELL-H-1:cluster-held", "2026-03:USD"),
  );

  // The acreage divisions of record, per meter-sales row (the pot legs
  // as stored JSON, re-parsed).
  const divisions: Array<{ pot: number; total: number; legs: unknown }> = [];
  for (const senderRowId of ["MSC-2026-03-0001", "MSC-2026-03-0002"]) {
    const row = await store.getEnergyParcelDivisionApplication(
      energyRowEventId("division", senderRowId, "2026-03:USD"),
    );
    if (row) {
      divisions.push({
        pot: row.revenue_basis_cents,
        total: row.allocated_total_cents,
        legs: JSON.parse(row.division_legs),
      });
    }
  }

  // The statutory interest accruals for heir-cal's rerouted legs.
  const accruals: Array<{ base: number; lateDays: number; interest: number }> = [];
  for (const senderRowId of ["MSC-2026-03-0001", "MSC-2026-03-0002"]) {
    const row = await store.getEnergyStatutoryInterestApplication(
      energyRowEventId(
        "statutory_interest",
        "DEED-77-01",
        energyRowEventId("division", senderRowId, "2026-03:USD"),
      ),
    );
    if (row) {
      accruals.push({
        base: row.base_cents,
        lateDays: row.late_days,
        interest: row.interest_cents,
      });
    }
  }

  // The cumulative royalty positions of record.
  const tract77Position = await store.getEnergyParcelRoyaltyPosition(
    "TRACT-77",
    "2026-03",
    "USD",
  );
  const barePosition = await store.getEnergyParcelRoyaltyPosition(
    "TRACT-BARE",
    "2026-03",
    "USD",
  );
  const yieldPosition = await store.getEnergyComputeYieldPosition(
    "a1b2c3-cluster-hash",
    "2026-03",
    "USD",
  );

  // The grid splits of record — the cascade trigger's staged legs, with
  // the instant cascade's journal stamp state (PR 49: the walk posts the
  // split immediately, so every staged row of record is journal-stamped).
  const gridSplits: Array<{
    revenue: number;
    total: number;
    legs: unknown;
    journalStamped: boolean;
  }> = [];
  for (const senderRowId of ["GPUU-2026-03-0001", "GPUU-2026-03-0002"]) {
    const row = await store.getEnergyComputeGridSplitApplication(
      energyRowEventId("grid_split", senderRowId, "2026-03:USD"),
    );
    if (row) {
      gridSplits.push({
        revenue: row.compute_revenue_cents,
        total: row.allocated_total_cents,
        legs: JSON.parse(row.split_legs),
        journalStamped: row.journal_id !== null,
      });
    }
  }

  // The carbon payout of record.
  const carbon = await store.getEnergyCarbonOffsetPayoutApplication(
    energyRowEventId("carbon_payout", "MINT-2026-03-0001", "2026-03"),
  );

  return {
    tract77: tract77
      ? {
          grossEnergy: tract77.gross_energy_sales_cents,
          grossMineral: tract77.gross_mineral_sales_cents,
          transportation: tract77.transportation_pipeline_deductions_cents,
          gridFees: tract77.grid_transmission_fees_cents,
          processing: tract77.processing_refining_base_fees_cents,
          net: tract77.net_realized_resource_pool_cents,
          verdict: tract77.verdict,
        }
      : null,
    tractHeld: tractHeld
      ? { net: tractHeld.net_realized_resource_pool_cents, verdict: tractHeld.verdict }
      : null,
    divisions,
    accruals,
    tract77Position: tract77Position
      ? {
          revenue: tract77Position.cumulative_revenue_cents,
          royalty: tract77Position.cumulative_royalty_cents,
        }
      : null,
    barePosition: barePosition
      ? {
          revenue: barePosition.cumulative_revenue_cents,
          royalty: barePosition.cumulative_royalty_cents,
        }
      : null,
    yieldPosition: yieldPosition
      ? {
          revenue: yieldPosition.cumulative_compute_revenue_cents,
          yield: yieldPosition.cumulative_yield_cents,
        }
      : null,
    gridSplits,
    carbon: carbon
      ? {
          tonnes: carbon.tonnes_verified_micros,
          pot: carbon.total_payout_cents,
          trust: carbon.trust_payout_cents,
          developer: carbon.developer_payout_cents,
        }
      : null,
  };
}

describe("the energy lane's three-backend parity", () => {
  it("produces identical counters, rows, and positions across InMemory, SQLite, and the Supabase fake", async () => {
    const outcomes = [];
    for (const backend of BACKENDS) {
      const store = backend.make();
      await registerEnergyPolicies(store);

      // First pass: the four sheets settle everything they can price.
      const first = energyCounters(await runEnergyPass(store));
      const projection = await energyProjection(store);

      // Replay: the same sheets re-shipped — counted no-ops, no money.
      const replay = energyCounters(await runEnergyPass(store));

      outcomes.push({ first, projection, replay });
    }

    // Every backend agrees with every other — counters, rows, positions.
    expect(outcomes[0]).toEqual(outcomes[1]);
    expect(outcomes[0]).toEqual(outcomes[2]);

    // And the shared outcome is the founder's math, end to end through
    // the real worker: seven realization recomputes (one held), three
    // royalty walks, two acreage divisions, two statutory accruals, two
    // GPU yields, two grid splits, and one carbon payout.
    const { first, projection, replay } = outcomes[0];
    expect(first.energy_realizations_committed).toBe(7);
    expect(first.energy_realization_held_negative_net).toBe(1);
    expect(first.energy_parcel_royalties_committed).toBe(3);
    expect(first.energy_divisions_committed).toBe(2);
    expect(first.energy_statutory_interest_accruals_committed).toBe(2);
    expect(first.energy_gpu_yields_committed).toBe(2);
    expect(first.energy_grid_splits_committed).toBe(2);
    // THE INSTANT CASCADE (PR 49): both staged splits posted immediately —
    // every staged application of record journal-stamped in the same pass.
    expect(first.energy_grid_split_postings_posted).toBe(2);
    expect(first.energy_grid_split_postings_refused ?? 0).toBe(0);
    expect(first.energy_carbon_payouts_committed).toBe(1);
    // The fail-closed skips: no royalty policy (the TRACT-HELD and
    // TRACT-NOPO meter rows), no interests (TRACT-BARE), no yield
    // policy and no participants (the orphan cluster), no offset
    // policy (the TRACT-NOPO mint).
    expect(first.energy_parcel_royalties_skipped_no_policy).toBe(2);
    expect(first.energy_divisions_skipped_no_interests).toBe(1);
    expect(first.energy_gpu_yields_skipped_no_policy).toBe(1);
    expect(first.energy_grid_splits_skipped_no_participants).toBe(1);
    expect(first.energy_carbon_payouts_skipped_no_policy).toBe(1);
    // The money: the distinct positions' final nets (167423 − 100 +
    // 50000 + 25000 = the pool of record, via the additive per-job
    // deltas), the royalties, the conserved divisions, the accruals,
    // the yields, the split allocations, and the payout pot.
    expect(first.energy_net_realized_resource_pool_delta_cents).toBe(242_323);
    expect(first.energy_parcel_royalty_cents).toBe(38_750);
    expect(first.energy_divided_cents).toBe(37_500);
    expect(first.energy_statutory_interest_accrued_cents).toBe(46);
    expect(first.energy_gpu_yield_cents).toBe(30_000);
    expect(first.energy_grid_split_cents).toBe(150_000);
    expect(first.energy_carbon_payout_total_cents).toBe(1_875);

    // The replay pass: every sender's rows replayed as counted no-ops
    // (5 meter + 2 pipeline + 3 GPU + 1 carbon) and no money moved
    // anywhere.
    expect(replay.energy_rows_replayed).toBe(11);
    expect(replay.energy_realizations_committed ?? 0).toBe(0);
    expect(replay.energy_parcel_royalties_committed ?? 0).toBe(0);
    expect(replay.energy_divisions_committed ?? 0).toBe(0);
    expect(replay.energy_statutory_interest_accruals_committed ?? 0).toBe(0);
    expect(replay.energy_gpu_yields_committed ?? 0).toBe(0);
    expect(replay.energy_grid_splits_committed ?? 0).toBe(0);
    expect(replay.energy_carbon_payouts_committed ?? 0).toBe(0);
    expect(replay.energy_net_realized_resource_pool_delta_cents ?? 0).toBe(0);
    expect(replay.energy_parcel_royalty_cents ?? 0).toBe(0);
    expect(replay.energy_carbon_payout_total_cents ?? 0).toBe(0);

    // The rows of record: TRACT-77's identity pins to the cent —
    // 100003 + 200000 − 132580 = 167423, posted; TRACT-HELD's
    // deduction-exceeds-gross is the HELD verdict, the money visible.
    expect(projection.tract77).toEqual({
      grossEnergy: 100_003,
      grossMineral: 200_000,
      transportation: 123_456,
      gridFees: 7_890,
      processing: 1_234,
      net: 167_423,
      verdict: "posted",
    });
    expect(projection.tractHeld).toEqual({ net: -100, verdict: "held_negative_net" });

    // The acreage divisions conserve exactly (4/3/2 acres of 9), with
    // the dust riding the larger tracts deterministically.
    expect(projection.divisions[0]).toEqual({
      pot: 12_500,
      total: 12_500,
      legs: [
        { payee_id: "heir-ana", deeded_acres_micros: 4_000_000, allocated_cents: 5_556 },
        { payee_id: "heir-bea", deeded_acres_micros: 3_000_000, allocated_cents: 4_167 },
        { payee_id: "heir-cal", deeded_acres_micros: 2_000_000, allocated_cents: 2_777 },
      ],
    });
    expect(projection.divisions[1]).toEqual({
      pot: 25_000,
      total: 25_000,
      legs: [
        { payee_id: "heir-ana", deeded_acres_micros: 4_000_000, allocated_cents: 11_112 },
        { payee_id: "heir-bea", deeded_acres_micros: 3_000_000, allocated_cents: 8_333 },
        { payee_id: "heir-cal", deeded_acres_micros: 2_000_000, allocated_cents: 5_555 },
      ],
    });

    // The statutory interest: heir-cal's deed (800 bps, 26 late days)
    // accrued 15 then 31 on the rerouted legs; the postdating
    // DEED-77-02 accrued nothing.
    expect(projection.accruals).toEqual([
      { base: 2_777, lateDays: 26, interest: 15 },
      { base: 5_555, lateDays: 26, interest: 31 },
    ]);

    // The cumulative positions of record — the ORRI walked 300003
    // revenue to 37500 royalty; TRACT-BARE's 5% walked 25000 to 1250;
    // the cluster's 20% yield walked 150000 to 30000.
    expect(projection.tract77Position).toEqual({ revenue: 300_003, royalty: 37_500 });
    expect(projection.barePosition).toEqual({ revenue: 25_000, royalty: 1_250 });
    expect(projection.yieldPosition).toEqual({ revenue: 150_000, yield: 30_000 });

    // The dynamic grid split: the founder's three counterparties, the
    // split conserved per row, and the colocation share diluting as
    // the GPU and power telemetry doubles.
    expect(projection.gridSplits[0]).toEqual({
      revenue: 50_000,
      total: 50_000,
      journalStamped: true,
      legs: [
        { payee_id: "colocation-facility-delta", participant_class: "colocation_manager", effective_weight_micros: 250_000_000_000_000, allocated_cents: 4_545 },
        { payee_id: "power-provider-meridian", participant_class: "power_plant_operator", effective_weight_micros: 1_000_000_000_000_000, allocated_cents: 18_182 },
        { payee_id: "silicon-lessor", participant_class: "gpu_hardware_owner", effective_weight_micros: 1_500_000_000_000_000, allocated_cents: 27_273 },
      ],
    });
    expect(projection.gridSplits[1]).toEqual({
      revenue: 100_000,
      total: 100_000,
      journalStamped: true,
      legs: [
        { payee_id: "colocation-facility-delta", participant_class: "colocation_manager", effective_weight_micros: 250_000_000_000_000, allocated_cents: 4_761 },
        { payee_id: "power-provider-meridian", participant_class: "power_plant_operator", effective_weight_micros: 2_000_000_000_000_000, allocated_cents: 38_096 },
        { payee_id: "silicon-lessor", participant_class: "gpu_hardware_owner", effective_weight_micros: 3_000_000_000_000_000, allocated_cents: 57_143 },
      ],
    });

    // The per-tonne payout: 12.5 verified tonnes at $1.50/tonne, the
    // conservation trust's 70% and the developer's remainder.
    expect(projection.carbon).toEqual({
      tonnes: 1_250_000_000,
      pot: 1_875,
      trust: 1_312,
      developer: 563,
    });
  });
});
