/**
 * The hardware lane's shared test scenario (PR 46, the founder hardware
 * directive) — the four sender fixtures and the policy/pool/assignment/
 * agreement registrations of record, held in ONE place so the lane's
 * worker-path suite and the three-backend parity suite exercise the
 * exact same sheet-and-policy world and can never drift apart.
 */

import { InMemoryStore } from "@/lib/server/inMemoryStore";
import type { Store } from "@/lib/server/store";
import type { HardwareSepTierBand } from "@/modules/hardware/records";

import type { ParsedStatementLine } from "../records";
import { dispatchStatementProfile } from "../profiles";

import { loadFixture } from "./fixtures";

/** The four senders' fixtures, in dispatch order. */
export const HARDWARE_FIXTURES = [
  "hardware_cellular_activations.csv",
  "hardware_mac_address_logs.csv",
  "hardware_production_serials.csv",
  "hardware_smart_grid_telemetry.csv",
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
export function parseHardwareFixtures(): ParsedStatementLine[] {
  return HARDWARE_FIXTURES.flatMap((name) => dispatchFixture(name));
}

/**
 * The policies, pools, holder legs, OEM line assignments, cross-license
 * agreement, clean-tech royalty, and OTA unlock policy the sheets ride
 * on. The deliberate gaps: line-orphan's pool is never registered, the
 * hydro-flow family has no clean-tech royalty, and the adaptive
 * suspension feature has no OTA unlock policy — the walks must skip
 * those fail-closed, never guess.
 */
export async function registerHardwarePolicies(store: Store): Promise<void> {
  // Tiered FRAND: the founder's 2.5% capped at $3.00 per connected
  // vehicle module for the first 1,000 units, then 1.25% capped at $1.50.
  await store.upsertHardwareSepRoyaltyPolicy({
    patent_family_id: "fam-5g-modem",
    sep_pool_code: "POOL-5G-VEHICLE",
    payee_id: "company-b",
    tier_bands: JSON.stringify([
      { up_to: 1000, frand_rate_bps: 250, per_unit_cap_cents: 300 },
      { up_to: null, frand_rate_bps: 125, per_unit_cap_cents: 150 },
    ] satisfies HardwareSepTierBand[]),
  });
  await store.upsertHardwareSepRoyaltyPolicy({
    patent_family_id: "fam-wifi7-module",
    sep_pool_code: "POOL-WIFI7",
    payee_id: "company-a",
    tier_bands: JSON.stringify([
      { up_to: null, frand_rate_bps: 250, per_unit_cap_cents: 300 },
    ] satisfies HardwareSepTierBand[]),
  });

  // The pools and their verified essentiality weightings (one holder
  // leg per (pool, holder) — the registries of record).
  await store.upsertHardwarePatentPool({
    pool_code: "POOL-5G-VEHICLE",
    pool_name: "5G Connected Vehicle SEP Pool (Avanci-shaped)",
  });
  await store.upsertHardwarePoolHolderLeg({
    pool_code: "POOL-5G-VEHICLE",
    holder_payee_id: "company-b",
    essentiality_score: 70,
  });
  await store.upsertHardwarePoolHolderLeg({
    pool_code: "POOL-5G-VEHICLE",
    holder_payee_id: "pool-admin-meridian",
    essentiality_score: 30,
  });
  await store.upsertHardwarePatentPool({
    pool_code: "POOL-NAV-AVANCI",
    pool_name: "Automotive Navigation Patent Pool",
  });
  await store.upsertHardwarePoolHolderLeg({
    pool_code: "POOL-NAV-AVANCI",
    holder_payee_id: "company-c",
    essentiality_score: 55,
  });
  await store.upsertHardwarePoolHolderLeg({
    pool_code: "POOL-NAV-AVANCI",
    holder_payee_id: "company-d",
    essentiality_score: 25,
  });
  await store.upsertHardwarePoolHolderLeg({
    pool_code: "POOL-NAV-AVANCI",
    holder_payee_id: "company-e",
    essentiality_score: 20,
  });

  // The automotive OEM production lines route cellular + navigation
  // licensing fees to their pools.
  await store.upsertHardwareAutomotivePoolAssignment({
    oem_id: "oem-atlas",
    line_id: "line-hamburg",
    cellular_pool_code: "POOL-5G-VEHICLE",
    navigation_pool_code: "POOL-NAV-AVANCI",
  });
  await store.upsertHardwareAutomotivePoolAssignment({
    oem_id: "oem-atlas",
    line_id: "line-rotation",
    cellular_pool_code: "POOL-5G-VEHICLE",
    navigation_pool_code: "POOL-NAV-AVANCI",
  });
  // line-orphan is assigned to a pool that is never registered — the
  // waterfall walk must skip it fail-closed.
  await store.upsertHardwareAutomotivePoolAssignment({
    oem_id: "oem-atlas",
    line_id: "line-orphan",
    cellular_pool_code: "POOL-ORPHAN",
    navigation_pool_code: "POOL-ORPHAN",
  });

  // The clean-tech royalty of record for the solid-state cell family —
  // per-kilowatt-hour and per-charge-cycle micro-payouts. The hydro-flow
  // family deliberately has none: its telemetry must skip fail-closed.
  await store.upsertHardwareCleanTechRoyaltyPolicy({
    patent_family_id: "fam-solid-state-cell",
    payee_id: "cleantech-holder-voltaic",
    micros_per_kwh: 1_500_000,
    micros_per_charge_cycle: 2_500_000,
  });

  // The cross-license agreement of record between Company A and Company B.
  await store.upsertHardwareCrossLicenseAgreement({
    agreement_ref: "XLA-5G-WIFI7-2026",
    company_a_id: "company-a",
    company_b_id: "company-b",
  });

  // The OTA unlock policy of record + the licensor's verified tax
  // profile (the no-backup-withholding state).
  await store.upsertHardwareOtaUnlockPolicy({
    feature_code: "fcs_self_driving_sensors",
    sensor_licensor_payee_id: "sensor-licensor-apex",
    micros_per_unlock: 149_000_000,
    licensor_share_bps: 7_000,
  });
  await store.upsertCreatorTaxProfile({
    creator_id: "sensor-licensor-apex",
    tin_verified: 1,
    w9_on_file: 1,
    updated_at: new Date("2026-10-03T12:00:00.000Z").toISOString(),
  });
}

/** Convenience for single-backend suites (the lane's worker-path test). */
export function makeHardwareScenarioStore(): Store {
  return new InMemoryStore();
}
