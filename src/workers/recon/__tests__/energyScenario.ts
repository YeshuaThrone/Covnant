/**
 * The energy lane's shared test scenario (PR 48, the founder resource
 * directive) — the four sender fixtures and the parcel / interest /
 * policy / deed / participant registrations of record, held in ONE
 * place so the lane's worker-path suite and the three-backend parity
 * suite exercise the exact same sheet-and-registry world and can never
 * drift apart.
 *
 * The scenario's pinned math (the fixtures ride it):
 * - TRACT-77 (12.5% ORRI flat, heirs at 4/3/2 surveyed acres of 9):
 *   royalty 12500 + 25000 = 37500 cents; divisions conserve to 37500;
 *   heir-cal's deed (DEED-77-01, 800 bps, recorded 2026-03-05) accrues
 *   26 late days → floor(2777 × 26 × 800 / 3,650,000) = 15 and
 *   floor(5555 × 26 × 800 / 3,650,000) = 31 → 46 cents total.
 * - TRACT-77's realization: 100003 + 200000 − 132580 = 167423.
 * - TRACT-HELD: gross 1000, deductions 1100 → −100, the HELD verdict.
 * - The a1b2c3 cluster (20% sponsor yield): 10000 + 20000 = 30000
 *   cents; the grid split's calibrated weights (gpu 1e7 × hours,
 *   power 4e4 × draw, colo 2.5e8 flat) allocate the payee-sorted legs
 *   [4545, 18182, 27273] on row 1 and [4761, 38096, 57143] on row 2 —
 *   the colocation manager's flat weight dilutes as the GPU and power
 *   telemetry doubles (the DYNAMIC property).
 * - The 12.5-tonne mint at $1.50/tonne: pot 1875, trust (7000 bps)
 *   1312, developer 563.
 *
 * The deliberate fail-closed gaps: TRACT-NOPO has no royalty policy and
 * no carbon offset policy, TRACT-BARE has a policy but no registered
 * owner interests, and cluster-orphan has no yield policy and no grid
 * participants — the walks must skip those counted, never guess.
 */

import { InMemoryStore } from "@/lib/server/inMemoryStore";
import type { Store } from "@/lib/server/store";
import type { EnergyRoyaltyTierBandRecord } from "@/modules/energy/records";

import type { ParsedStatementLine } from "../records";
import { dispatchStatementProfile } from "../profiles";

import { loadFixture } from "./fixtures";

/** The four senders' fixtures, in dispatch order. */
export const ENERGY_FIXTURES = [
  "energy_scada_meter_sales.csv",
  "energy_gpu_utilization.csv",
  "energy_pipeline_flow_meter.csv",
  "energy_carbon_offset_mints.csv",
] as const;

function dispatchFixture(name: string): ParsedStatementLine[] {
  const content = loadFixture(name);
  const profile = dispatchStatementProfile(content);
  if (profile === null) {
    throw new Error(`fixture ${name} did not dispatch to a pinned profile`);
  }
  return [...profile.parse(content)];
}

/** All four sheets through their pinned strict profiles, in order. */
export function parseEnergyFixtures(): ParsedStatementLine[] {
  return ENERGY_FIXTURES.flatMap((name) => dispatchFixture(name));
}

/** The founder's example ladders, as stored band JSON. */
export const ORRI_12_5_PERCENT_BANDS: EnergyRoyaltyTierBandRecord[] = [
  { up_to: null, royalty_bps: 1250 },
];
export const GPU_YIELD_20_PERCENT_BANDS: EnergyRoyaltyTierBandRecord[] = [
  { up_to: null, royalty_bps: 2000 },
];

/**
 * The parcels, deeded fractional heir interests, royalty ladders, deed
 * transfers, GPU yield policy, grid participant registrations, and
 * carbon offset policy the sheets ride on.
 */
export async function registerEnergyPolicies(store: Store): Promise<void> {
  // The surveyed parcel of record.
  await store.upsertEnergyLandParcel({
    parcel_id: "TRACT-77",
    parcel_name: "Basin Tract 77 (fractional heirs)",
    region: "Permian Basin",
  });

  // The deeded fractional heirs — 4/3/2 surveyed acres of 9 total (the
  // acreage-ratio division's legs; the 4/3/2-of-9 ratios are what force
  // the conservation dust in the division fixtures).
  await store.upsertEnergyParcelOwnerInterest({
    parcel_id: "TRACT-77",
    owner_payee_id: "heir-ana",
    owner_name: "Heir Ana (mineral, 4 acres)",
    deeded_acres_micros: 4_000_000,
    interest_class: "mineral",
  });
  await store.upsertEnergyParcelOwnerInterest({
    parcel_id: "TRACT-77",
    owner_payee_id: "heir-bea",
    owner_name: "Heir Bea (surface, 3 acres)",
    deeded_acres_micros: 3_000_000,
    interest_class: "surface",
  });
  await store.upsertEnergyParcelOwnerInterest({
    parcel_id: "TRACT-77",
    owner_payee_id: "heir-cal",
    owner_name: "Heir Cal (mixed, 2 acres)",
    deeded_acres_micros: 2_000_000,
    interest_class: "mixed",
  });

  // The founder's 12.5% mineral ORRI — a single open band.
  await store.upsertEnergyParcelRoyaltyPolicy({
    parcel_id: "TRACT-77",
    tier_bands: JSON.stringify(ORRI_12_5_PERCENT_BANDS),
  });
  // TRACT-BARE carries a policy but no registered interests — the
  // division walk's fail-closed skip.
  await store.upsertEnergyParcelRoyaltyPolicy({
    parcel_id: "TRACT-BARE",
    tier_bands: JSON.stringify([{ up_to: null, royalty_bps: 500 }]),
  });

  // The deed transfers of record. DEED-77-01 moved heir-cal's interest
  // before the 2026-03 payable date (26 late days at 800 bps);
  // DEED-77-02 postdates the period — the reroute's zero-day clamp.
  await store.upsertEnergyDeedTransfer({
    deed_ref: "DEED-77-01",
    parcel_id: "TRACT-77",
    from_payee_id: "estate-quin",
    to_payee_id: "heir-cal",
    transferred_acres_micros: 2_000_000,
    statutory_interest_bps: 800,
    recorded_on: "2026-03-05",
  });
  await store.upsertEnergyDeedTransfer({
    deed_ref: "DEED-77-02",
    parcel_id: "TRACT-77",
    from_payee_id: "heir-bea",
    to_payee_id: "heir-ana",
    transferred_acres_micros: 1_000_000,
    statutory_interest_bps: 600,
    recorded_on: "2026-04-15",
  });

  // The founder's 20% GPU cluster yield to the infrastructure sponsor.
  await store.upsertEnergyComputeYieldPolicy({
    gpu_cluster_hash: "a1b2c3-cluster-hash",
    sponsor_payee_id: "datacenter-sponsor-apex",
    sponsor_payee_name: "Data Center Infrastructure Sponsor Apex",
    tier_bands: JSON.stringify(GPU_YIELD_20_PERCENT_BANDS),
  });

  // The compute-grid split's participants — the calibration weights
  // are what keep the founder's three counterparties in the same order
  // of magnitude under the rows' raw telemetry (hours 1.5e8→3e8 and
  // draw 2.5e10→5e10 in statement micros; the colocation manager rides
  // its registered weight flat against a 1e6 telemetry factor).
  await store.upsertEnergyGridParticipant({
    gpu_cluster_hash: "a1b2c3-cluster-hash",
    participant_payee_id: "silicon-lessor",
    participant_payee_name: "Silicon Lessor (GPU hardware owner)",
    participant_class: "gpu_hardware_owner",
    weight_micros: 10_000_000,
  });
  await store.upsertEnergyGridParticipant({
    gpu_cluster_hash: "a1b2c3-cluster-hash",
    participant_payee_id: "power-provider-meridian",
    participant_payee_name: "Meridian Power (plant operator)",
    participant_class: "power_plant_operator",
    weight_micros: 40_000,
  });
  await store.upsertEnergyGridParticipant({
    gpu_cluster_hash: "a1b2c3-cluster-hash",
    participant_payee_id: "colocation-facility-delta",
    participant_payee_name: "Delta Colocation (facility manager)",
    participant_class: "colocation_manager",
    weight_micros: 250_000_000,
  });

  // The per-tonne carbon offset payout policy — the conservation trust
  // and the project developer of record.
  await store.upsertEnergyCarbonOffsetPolicy({
    parcel_id: "TRACT-77",
    trust_payee_id: "conservation-trust-basin",
    trust_payee_name: "Basin Land Conservation Trust",
    developer_payee_id: "offset-developer-verdant",
    developer_payee_name: "Verdant Offset Project Developer",
    micros_per_tonne: 150_000_000, // $1.50 per verified tonne
    trust_share_bps: 7000,
  });
}
