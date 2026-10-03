/**
 * The hardware lane's worker-path test (PR 46, the founder hardware
 * directive) — the four sender sheets (cellular activations with OTA
 * unlock events, MAC address logs, factory production serials, smart
 * grid telemetry) run through the REAL strict dispatch (the pinned
 * profiles) and the REAL store walk (hardwareQueue) against a real
 * store, and every ledger commits with math exact to the cent:
 *
 * - the Net Hardware Patent Realization (ASP − COGS − BOM), including
 *   the negative-net hold;
 * - tiered FRAND SEP royalties with the founder's $3.00 per connected
 *   vehicle module ceiling and the cumulative monthly unit tracker;
 * - automotive pool routing off production lines (including the
 *   fail-closed skips for unassigned lines and unregistered pools);
 * - essentiality-weighted multi-owner pool waterfalls (the MPEG-LA /
 *   Avanci shape) that conserve every cent, dust riding the highest
 *   essentiality scores;
 * - per-kilowatt-hour and per-charge-cycle clean-tech telemetry
 *   micro-payouts;
 * - cross-license net offset settlements recomputed as royalties land
 *   (the founder's Company A / Company B shape at scale: the pass ends
 *   with Company A owing Company B $3,450.00 less the $30.00 Company B
 *   owes back — a $3,420.00 dispatch);
 * - the OTA feature-unlock micro-royalty trigger, priced per unlock
 *   and posted instantly (one journal, sensor licensor 104 cents,
 *   platform 45).
 *
 * A re-shipped sheet is a counted no-op everywhere, never a second
 * posting. No policy or assignment of record — no settlement, never a
 * guessed rate.
 */

import { describe, expect, it } from "vitest";

import { InMemoryStore } from "@/lib/server/inMemoryStore";
import { dispatchStatementProfile } from "../profiles";
import {
  automotivePoolRoutingCents,
  crossLicenseNetting,
  crossLicenseNormalizedPair,
  essentialityWaterfallCents,
  hardwareRowEventId,
  hardwareSepTierWalk,
  netHardwarePatentRealizationCents,
  otaUnlockSplit,
  telemetryRoyaltyMicros,
  validateHardwareSepBands,
} from "../hardware";
import { writeHardwareRowsToStore } from "../hardwareQueue";

import { loadFixture } from "./fixtures";
import {
  parseHardwareFixtures,
  registerHardwarePolicies,
} from "./hardwareScenario";


// ---------------------------------------------------------------------------
// The full pass.
// ---------------------------------------------------------------------------

describe("the hardware lane's full pass over the four senders", () => {
  it("commits every ledger with math exact to the cent and advances the walks", async () => {
    const store = new InMemoryStore();
    await registerHardwarePolicies(store);
    const counts = await writeHardwareRowsToStore(store, parseHardwareFixtures());

    // ---- 1. THE NET HARDWARE PATENT REALIZATION (the founder identity).
    expect(counts.realizationsWritten).toBe(3);
    expect(counts.realizationsHeldNonPositiveNet).toBe(1);
    // 70000 + 35000 − 7500 = the period's net patentable value base.
    expect(counts.netPatentableValueBaseCents).toBe(97_500);

    const paid = await store.getHardwareRealizationApplication(
      hardwareRowEventId("realization", {
        sender: "cellular_activation",
        period: "2026-03",
        senderRowId: "CVA-2026-03-0001",
      }),
    );
    expect(paid).toBeDefined();
    if (!paid) return;
    expect(paid.device_wholesale_asp_cents).toBe(120_000);
    expect(paid.component_cogs_base_cents).toBe(42_550);
    expect(paid.non_essential_bom_cents).toBe(7_450);
    expect(paid.net_patentable_device_value_base_cents).toBe(70_000);
    expect(paid.verdict).toBe("paid");
    expect(paid.device_imei_mac).toBe("IMEI-356938035643809");
    expect(paid.eid).toBe("EID-89049032000001000001");
    expect(paid.patent_family_id).toBe("fam-5g-modem");
    expect(paid.sep_pool_code).toBe("POOL-5G-VEHICLE");
    // THE IDENTITY, pinned in CHECKs too: COGS + BOM + net === ASP.
    expect(
      paid.component_cogs_base_cents +
        paid.non_essential_bom_cents +
        paid.net_patentable_device_value_base_cents,
    ).toBe(paid.device_wholesale_asp_cents);

    const held = await store.getHardwareRealizationApplication(
      hardwareRowEventId("realization", {
        sender: "cellular_activation",
        period: "2026-03",
        senderRowId: "CVA-2026-03-0003",
      }),
    );
    expect(held).toBeDefined();
    if (!held) return;
    expect(held.net_patentable_device_value_base_cents).toBe(-7_500);
    expect(held.verdict).toBe("held_negative_net");
    // The optional EID stays null — never a guess.
    expect(held.eid).toBeNull();

    // ---- 2. TIERED FRAND SEP ROYALTIES + the cumulative unit tracker.
    expect(counts.sepRoyaltiesWritten).toBe(3);
    expect(counts.sepSkippedNoPolicy).toBe(1);
    expect(counts.sepRoyaltyCents).toBe(348_000); // 180000 + 165000 + 3000

    const sep1 = await store.getHardwareSepRoyaltyApplication(
      hardwareRowEventId("sep_royalty", {
        sender: "mac_address_log",
        period: "2026-03",
        senderRowId: "MAC-2026-03-0001",
      }),
    );
    expect(sep1).toBeDefined();
    if (!sep1) return;
    // 600 units at the $3.00 connected-vehicle-module ceiling — the
    // founder's example, where the cap binds against the 2.5% rate.
    expect(sep1.royalty_cents).toBe(180_000);
    expect(sep1.cumulative_units_before).toBe(0);
    expect(sep1.cumulative_units_after).toBe(600);

    const sep2 = await store.getHardwareSepRoyaltyApplication(
      hardwareRowEventId("sep_royalty", {
        sender: "mac_address_log",
        period: "2026-03",
        senderRowId: "MAC-2026-03-0002",
      }),
    );
    expect(sep2).toBeDefined();
    if (!sep2) return;
    // The band edge: units 601–1000 at $3.00, units 1001–1300 at $1.50.
    expect(sep2.royalty_cents).toBe(165_000);
    expect(sep2.cumulative_units_before).toBe(600);
    expect(sep2.cumulative_units_after).toBe(1300);
    expect(JSON.parse(sep2.tier_legs)).toEqual([
      {
        band_from: 0,
        band_to: 1000,
        frand_rate_bps: 250,
        per_unit_cap_cents: 300,
        band_units: 400,
        band_payout_cents: 120_000,
      },
      {
        band_from: 1000,
        band_to: null,
        frand_rate_bps: 125,
        per_unit_cap_cents: 150,
        band_units: 300,
        band_payout_cents: 45_000,
      },
    ]);

    const tracker = await store.getHardwareSepUnitMonth(
      "company-a",
      "fam-5g-modem",
      "POOL-5G-VEHICLE",
      "2026-03",
    );
    expect(tracker).toBeDefined();
    expect(tracker?.cumulative_units).toBe(1300);

    // ---- 3. AUTOMOTIVE POOL ROUTING off the production lines.
    expect(counts.oemRoutingsWritten).toBe(3);
    expect(counts.oemSkippedNoAssignment).toBe(2); // unassigned line + foreign OEM on a known line
    expect(counts.oemRoutedCents).toBe(507_110); // 445110 + 50000 + 12000
    expect(counts.poolWaterfallsWritten).toBe(3);
    expect(counts.poolSkippedNoPool).toBe(1); // line-orphan's pool is not registered
    expect(counts.poolDistributedCents).toBe(495_110); // the pools conserve everything routed to them

    const routing = await store.getHardwarePoolRoutingApplication(
      hardwareRowEventId("pool_routing", {
        sender: "production_serial",
        period: "2026-03",
        senderRowId: "BAT-2026-03-0001",
      }),
    );
    expect(routing).toBeDefined();
    if (!routing) return;
    expect(routing.serials_produced).toBe(401);
    expect(routing.cellular_routed_cents).toBe(311_577); // 401 × 777
    expect(routing.navigation_routed_cents).toBe(133_533); // 401 × 333
    expect(routing.total_routed_cents).toBe(445_110);
    expect(routing.cellular_pool_code).toBe("POOL-5G-VEHICLE");
    expect(routing.navigation_pool_code).toBe("POOL-NAV-AVANCI");

    // ---- 4. THE ESSENTIALITY-WEIGHTED WATERFALL (MPEG-LA / Avanci shape).
    const cellularWaterfall = await store.getHardwarePoolWaterfallApplication(
      routing.source_event_id,
      "POOL-5G-VEHICLE",
    );
    expect(cellularWaterfall).toBeDefined();
    if (!cellularWaterfall) return;
    expect(cellularWaterfall.pool_fee_pot_cents).toBe(311_577);
    expect(cellularWaterfall.allocated_total_cents).toBe(311_577);
    expect(JSON.parse(cellularWaterfall.split_legs)).toEqual([
      // 311577 × 70/100 floors to 218103 — the dust cent rides the
      // highest essentiality score.
      { holder_payee_id: "company-b", essentiality_score: 70, allocated_cents: 218_104 },
      { holder_payee_id: "pool-admin-meridian", essentiality_score: 30, allocated_cents: 93_473 },
    ]);

    const navWaterfall = await store.getHardwarePoolWaterfallApplication(
      routing.source_event_id,
      "POOL-NAV-AVANCI",
    );
    expect(navWaterfall).toBeDefined();
    if (!navWaterfall) return;
    expect(navWaterfall.pool_fee_pot_cents).toBe(133_533);
    expect(navWaterfall.allocated_total_cents).toBe(133_533);
    expect(JSON.parse(navWaterfall.split_legs)).toEqual([
      { holder_payee_id: "company-c", essentiality_score: 55, allocated_cents: 73_444 },
      { holder_payee_id: "company-d", essentiality_score: 25, allocated_cents: 33_383 },
      { holder_payee_id: "company-e", essentiality_score: 20, allocated_cents: 26_706 },
    ]);

    // ---- 5. CLEAN-TECH TELEMETRY MICRO-PAYOUTS (per kWh / per cycle).
    expect(counts.telemetryRoyaltiesWritten).toBe(2);
    expect(counts.telemetrySkippedNoPolicy).toBe(1);
    expect(counts.telemetryRoyaltyCents).toBe(108); // 90 + 18

    const telemetry1 = await store.getHardwareTelemetryRoyaltyApplication(
      hardwareRowEventId("telemetry", {
        sender: "smart_grid_telemetry",
        period: "2026-03",
        senderRowId: "TLM-2026-03-0001",
      }),
    );
    expect(telemetry1).toBeDefined();
    if (!telemetry1) return;
    // (3.75 kWh × 1e8) × 1,500,000 µ$/kWh / 1e8 = 5,625,000 µ$ energy leg
    // + 34 cycles × 2,500,000 µ$ = 85,000,000 µ$ cycle leg.
    expect(telemetry1.kwh_micros).toBe(375_000_000);
    expect(telemetry1.royalty_micros).toBe(90_625_000);
    expect(telemetry1.royalty_cents).toBe(90); // 90.625 floors

    const telemetry2 = await store.getHardwareTelemetryRoyaltyApplication(
      hardwareRowEventId("telemetry", {
        sender: "smart_grid_telemetry",
        period: "2026-03",
        senderRowId: "TLM-2026-03-0002",
      }),
    );
    expect(telemetry2).toBeDefined();
    if (!telemetry2) return;
    expect(telemetry2.kwh_micros).toBe(1_225_000_000);
    expect(telemetry2.royalty_micros).toBe(18_375_000);
    expect(telemetry2.royalty_cents).toBe(18);

    // ---- 6. CROSS-LICENSE NET OFFSET (the founder's Company A / B shape).
    expect(counts.crossLicenseNettingsWritten).toBe(3);
    expect(counts.crossLicenseNettingsReplayed).toBe(0);
    expect(counts.crossLicenseSkippedNoAgreement).toBe(0);
    expect(counts.crossLicenseNetDispatchCents).toBe(867_000); // |180000| + |345000| + |342000|

    // The recomputed settlement of record: Company A's 5G royalties to
    // Company B total 345000 cents; Company B's Wi-Fi 7 royalties back
    // total 3000 cents — a 342000-cent dispatch to Company B.
    const settlement = await store.getHardwareCrossLicenseNetSettlement(
      "XLA-5G-WIFI7-2026",
      "2026-03",
    );
    expect(settlement).toBeDefined();
    if (!settlement) return;
    expect(settlement.owed_a_to_b_cents).toBe(345_000);
    expect(settlement.owed_b_to_a_cents).toBe(3_000);
    expect(settlement.net_cents).toBe(342_000);
    expect(settlement.direction).toBe("a_to_b");

    // ---- 7. THE OTA FEATURE-UNLOCK TRIGGER — priced and posted instantly.
    expect(counts.otaUnlockSettlementsWritten).toBe(1);
    expect(counts.otaUnlockSkippedNoPolicy).toBe(1); // adaptive suspension has no policy of record
    expect(counts.otaUnlockInstantPostings).toBe(1);
    expect(counts.otaLicensorCents).toBe(104); // floor(149 × 7000/10000)
    expect(counts.otaPlatformCents).toBe(45); // the residual conserves the 149-cent pot

    const ota = await store.getHardwareOtaUnlockApplication(
      hardwareRowEventId("ota_unlock", {
        sender: "cellular_activation",
        period: "2026-03",
        senderRowId: "OTA-2026-03-0001",
      }),
    );
    expect(ota).toBeDefined();
    if (!ota) return;
    expect(ota.feature_code).toBe("fcs_self_driving_sensors");
    expect(ota.device_imei_mac).toBe("IMEI-356938035643809");
    expect(ota.settlement_cents).toBe(149);
    expect(ota.licensor_cents).toBe(104);
    expect(ota.platform_cents).toBe(45);
  });

  it("replays the same sheets as counted no-ops with zero new money", async () => {
    const store = new InMemoryStore();
    await registerHardwarePolicies(store);
    const lines = parseHardwareFixtures();
    await writeHardwareRowsToStore(store, lines);

    const trackerBefore = await store.getHardwareSepUnitMonth(
      "company-a",
      "fam-5g-modem",
      "POOL-5G-VEHICLE",
      "2026-03",
    );
    const counts = await writeHardwareRowsToStore(store, lines);

    expect(counts.realizationsReplayed).toBe(3);
    expect(counts.sepRoyaltiesReplayed).toBe(3);
    expect(counts.oemRoutingsReplayed).toBe(3);
    // The routings replay before the waterfall walks run — so no
    // waterfall replay counter fires on a full re-ship.
    expect(counts.poolWaterfallsWritten).toBe(0);
    expect(counts.poolWaterfallsReplayed).toBe(0);
    expect(counts.telemetryRoyaltiesReplayed).toBe(2);
    expect(counts.otaUnlockSettlementsReplayed).toBe(1);
    // Re-shipped royalty rows replay BEFORE the netting trigger — no
    // trigger, no re-net, no movement.
    expect(counts.crossLicenseNettingsWritten).toBe(0);
    expect(counts.crossLicenseNettingsReplayed).toBe(0);
    // Nothing was written; every money counter stayed at zero.
    expect(counts.realizationsWritten + counts.sepRoyaltiesWritten + counts.oemRoutingsWritten).toBe(0);
    expect(counts.telemetryRoyaltiesWritten + counts.otaUnlockSettlementsWritten).toBe(0);
    expect(counts.netPatentableValueBaseCents + counts.sepRoyaltyCents + counts.oemRoutedCents).toBe(0);
    expect(counts.poolDistributedCents + counts.telemetryRoyaltyCents + counts.crossLicenseNetDispatchCents).toBe(0);
    expect(counts.otaLicensorCents + counts.otaPlatformCents).toBe(0);
    // The tracker did not advance — replay moves no money and no units.
    expect(
      (
        await store.getHardwareSepUnitMonth(
          "company-a",
          "fam-5g-modem",
          "POOL-5G-VEHICLE",
          "2026-03",
        )
      )?.cumulative_units,
    ).toBe(trackerBefore?.cumulative_units);
  });
});

// ---------------------------------------------------------------------------
// The calculators — the verifying tests the directive names.
// ---------------------------------------------------------------------------

describe("netHardwarePatentRealizationCents — the Net Hardware Patent Realization", () => {
  it("computes the founder's identity exact to the cent", () => {
    // 1200.00 − 425.50 − 74.50 = 700.00.
    const r = netHardwarePatentRealizationCents({
      deviceWholesaleAspCents: 120_000,
      componentCogsBaseCents: 42_550,
      nonEssentialBomCents: 7_450,
    });
    expect(r.deviceWholesaleAspCents).toBe(120_000);
    expect(r.netPatentableDeviceValueBaseCents).toBe(70_000);
    // THE IDENTITY: COGS + BOM + net === ASP, exactly.
    expect(42_550 + 7_450 + r.netPatentableDeviceValueBaseCents).toBe(r.deviceWholesaleAspCents);
  });

  it("holds the negative net honestly — never clamps, never fakes a payout", () => {
    // 100.00 − 150.00 − 25.00 = −75.00.
    const r = netHardwarePatentRealizationCents({
      deviceWholesaleAspCents: 10_000,
      componentCogsBaseCents: 15_000,
      nonEssentialBomCents: 2_500,
    });
    expect(r.netPatentableDeviceValueBaseCents).toBe(-7_500);
  });

  it("refuses negative or non-integer cent legs", () => {
    expect(() =>
      netHardwarePatentRealizationCents({
        deviceWholesaleAspCents: -1,
        componentCogsBaseCents: 0,
        nonEssentialBomCents: 0,
      }),
    ).toThrow(/hardware_realization_invalid_leg/);
    expect(() =>
      netHardwarePatentRealizationCents({
        deviceWholesaleAspCents: 100.5,
        componentCogsBaseCents: 0,
        nonEssentialBomCents: 0,
      }),
    ).toThrow(/hardware_realization_invalid_leg/);
  });
});

describe("hardwareSepTierWalk — tiered FRAND with the per-unit cap", () => {
  it("enforces the founder's $3.00 connected-vehicle-module ceiling", () => {
    // 2.5% of a $200.00 basis = $5.00/unit, so the $3.00 cap binds:
    // 600 units × 300 cents = 180000 cents.
    const walk = hardwareSepTierWalk({
      units: 600,
      cumulativeBefore: 0,
      royaltyBasisCents: 20_000,
      bands: [
        { up_to: 1000, frand_rate_bps: 250, per_unit_cap_cents: 300 },
        { up_to: null, frand_rate_bps: 125, per_unit_cap_cents: 150 },
      ],
    });
    expect(walk.royaltyCents).toBe(180_000);
    expect(walk.cumulativeAfter).toBe(600);
    expect(walk.legs).toEqual([
      {
        band_from: 0,
        band_to: 1000,
        frand_rate_bps: 250,
        per_unit_cap_cents: 300,
        band_units: 600,
        band_payout_cents: 180_000,
      },
    ]);
  });

  it("crosses the band edge correctly against the cumulative tracker", () => {
    // Units 601–1000 pay $3.00; units 1001–1300 pay min(1.25% of $200.00
    // = $2.50, $1.50 cap) = $1.50.
    const walk = hardwareSepTierWalk({
      units: 700,
      cumulativeBefore: 600,
      royaltyBasisCents: 20_000,
      bands: [
        { up_to: 1000, frand_rate_bps: 250, per_unit_cap_cents: 300 },
        { up_to: null, frand_rate_bps: 125, per_unit_cap_cents: 150 },
      ],
    });
    expect(walk.royaltyCents).toBe(165_000);
    expect(walk.cumulativeAfter).toBe(1300);
    expect(walk.legs).toEqual([
      {
        band_from: 0,
        band_to: 1000,
        frand_rate_bps: 250,
        per_unit_cap_cents: 300,
        band_units: 400,
        band_payout_cents: 120_000,
      },
      {
        band_from: 1000,
        band_to: null,
        frand_rate_bps: 125,
        per_unit_cap_cents: 150,
        band_units: 300,
        band_payout_cents: 45_000,
      },
    ]);
  });

  it("refuses a non-positive unit count and a negative basis or position", () => {
    expect(() =>
      hardwareSepTierWalk({
        units: 0,
        cumulativeBefore: 0,
        royaltyBasisCents: 20_000,
        bands: [{ up_to: null, frand_rate_bps: 250, per_unit_cap_cents: 300 }],
      }),
    ).toThrow(/hardware_walk_invalid_units/);
    expect(() =>
      hardwareSepTierWalk({
        units: 10,
        cumulativeBefore: -1,
        royaltyBasisCents: 20_000,
        bands: [{ up_to: null, frand_rate_bps: 250, per_unit_cap_cents: 300 }],
      }),
    ).toThrow(/hardware_walk_invalid_position/);
    expect(() =>
      hardwareSepTierWalk({
        units: 10,
        cumulativeBefore: 0,
        royaltyBasisCents: -5,
        bands: [{ up_to: null, frand_rate_bps: 250, per_unit_cap_cents: 300 }],
      }),
    ).toThrow(/hardware_walk_invalid_basis/);
  });
});

describe("validateHardwareSepBands — the tier ladder's vocabulary", () => {
  it("accepts the founder's ladder and rejects drift", () => {
    expect(
      validateHardwareSepBands([
        { up_to: 1000, frand_rate_bps: 250, per_unit_cap_cents: 300 },
        { up_to: null, frand_rate_bps: 125, per_unit_cap_cents: 150 },
      ]),
    ).toHaveLength(2);
    expect(() => validateHardwareSepBands([])).toThrow(/hardware_bands_empty/);
    // Only the last band may be open.
    expect(() =>
      validateHardwareSepBands([
        { up_to: null, frand_rate_bps: 250, per_unit_cap_cents: 300 },
        { up_to: 2000, frand_rate_bps: 100, per_unit_cap_cents: 100 },
      ]),
    ).toThrow(/hardware_bands_open_not_last/);
    // The FRAND rate is bounded at 10000 bps.
    expect(() =>
      validateHardwareSepBands([
        { up_to: null, frand_rate_bps: 10_001, per_unit_cap_cents: 300 },
      ]),
    ).toThrow(/hardware_bands_rate/);
    // A cap pricing nothing is a hostile registration.
    expect(() =>
      validateHardwareSepBands([{ up_to: null, frand_rate_bps: 250, per_unit_cap_cents: 0 }]),
    ).toThrow(/hardware_bands_cap/);
    // Bounds must ascend.
    expect(() =>
      validateHardwareSepBands([
        { up_to: 1000, frand_rate_bps: 250, per_unit_cap_cents: 300 },
        { up_to: 1000, frand_rate_bps: 125, per_unit_cap_cents: 150 },
      ]),
    ).toThrow(/hardware_bands_bounds/);
  });
});

describe("essentialityWaterfallCents — the MPEG-LA / Avanci waterfall", () => {
  it("distributes the pot by essentiality weighting, dust to the highest score", () => {
    // 311577 × 70/100 = 218103.9 → 218103; 311577 × 30/100 = 93473.1 →
    // 93473; the 1-cent dust rides company-b (the highest score).
    const waterfall = essentialityWaterfallCents({
      poolFeePotCents: 311_577,
      holders: [
        { holder_payee_id: "company-b", essentiality_score: 70 },
        { holder_payee_id: "pool-admin-meridian", essentiality_score: 30 },
      ],
    });
    expect(waterfall.legs).toEqual([
      { holder_payee_id: "company-b", essentiality_score: 70, allocated_cents: 218_104 },
      { holder_payee_id: "pool-admin-meridian", essentiality_score: 30, allocated_cents: 93_473 },
    ]);
    // CONSERVATION: the holders receive every cent of the pot.
    expect(waterfall.allocatedTotalCents).toBe(311_577);
  });

  it("splits a three-holder pot with dust to the top score", () => {
    const waterfall = essentialityWaterfallCents({
      poolFeePotCents: 133_533,
      holders: [
        { holder_payee_id: "company-c", essentiality_score: 55 },
        { holder_payee_id: "company-d", essentiality_score: 25 },
        { holder_payee_id: "company-e", essentiality_score: 20 },
      ],
    });
    expect(waterfall.legs).toEqual([
      { holder_payee_id: "company-c", essentiality_score: 55, allocated_cents: 73_444 },
      { holder_payee_id: "company-d", essentiality_score: 25, allocated_cents: 33_383 },
      { holder_payee_id: "company-e", essentiality_score: 20, allocated_cents: 26_706 },
    ]);
    expect(waterfall.allocatedTotalCents).toBe(133_533);
  });

  it("refuses empty holder sets, duplicates, zero scores, and negative pots", () => {
    expect(() =>
      essentialityWaterfallCents({
        poolFeePotCents: 1000,
        holders: [
          { holder_payee_id: "company-b", essentiality_score: 70 },
          { holder_payee_id: "company-b", essentiality_score: 30 },
        ],
      }),
    ).toThrow(/hardware_waterfall_invalid_holder/);
    expect(() =>
      essentialityWaterfallCents({
        poolFeePotCents: 1000,
        holders: [{ holder_payee_id: "company-b", essentiality_score: 0 }],
      }),
    ).toThrow(/hardware_waterfall_invalid_score/);
    expect(() =>
      essentialityWaterfallCents({
        poolFeePotCents: -1,
        holders: [{ holder_payee_id: "company-b", essentiality_score: 70 }],
      }),
    ).toThrow(/hardware_waterfall_invalid_pot/);
    expect(() => essentialityWaterfallCents({ poolFeePotCents: 0, holders: [] })).toThrow(
      /hardware_waterfall_no_holders/,
    );
  });
});

describe("automotivePoolRoutingCents — per-vehicle fees off the production line", () => {
  it("prices the batch exactly and conserves the split", () => {
    const r = automotivePoolRoutingCents({
      serialsProduced: 401,
      cellularFeePerVehicleCents: 777,
      navigationFeePerVehicleCents: 333,
    });
    expect(r.cellularRoutedCents).toBe(311_577);
    expect(r.navigationRoutedCents).toBe(133_533);
    expect(r.totalRoutedCents).toBe(445_110);
    expect(r.cellularRoutedCents + r.navigationRoutedCents).toBe(r.totalRoutedCents);
  });

  it("handles a zero navigation fee and refuses invalid inputs", () => {
    const r = automotivePoolRoutingCents({
      serialsProduced: 100,
      cellularFeePerVehicleCents: 500,
      navigationFeePerVehicleCents: 0,
    });
    expect(r.totalRoutedCents).toBe(50_000);
    expect(() =>
      automotivePoolRoutingCents({
        serialsProduced: 0,
        cellularFeePerVehicleCents: 500,
        navigationFeePerVehicleCents: 0,
      }),
    ).toThrow(/hardware_routing_invalid_serials/);
    expect(() =>
      automotivePoolRoutingCents({
        serialsProduced: 10,
        cellularFeePerVehicleCents: -1,
        navigationFeePerVehicleCents: 0,
      }),
    ).toThrow(/hardware_routing_invalid_fee/);
  });
});

describe("telemetryRoyaltyMicros — per-kilowatt-hour and per-cycle micro-payouts", () => {
  it("scales the energy leg back down by 1e8 — the µ$/kWh rate is honest", () => {
    // 3.75 kWh (375000000 kwh_micros) × 1,500,000 µ$/kWh / 1e8 =
    // 5,625,000 µ$ + 34 cycles × 2,500,000 µ$ = 90,625,000 µ$.
    const r = telemetryRoyaltyMicros({
      kwhMicros: 375_000_000,
      chargeCycles: 34,
      microsPerKwh: 1_500_000,
      microsPerChargeCycle: 2_500_000,
    });
    expect(r.energyMicros).toBe(5_625_000);
    expect(r.cycleMicros).toBe(85_000_000);
    expect(r.royaltyMicros).toBe(90_625_000);
  });

  it("prices the pure energy leg — the DB CHECK identity, leg for leg", () => {
    // 12.25 kWh, zero cycles.
    const r = telemetryRoyaltyMicros({
      kwhMicros: 1_225_000_000,
      chargeCycles: 0,
      microsPerKwh: 1_500_000,
      microsPerChargeCycle: 2_500_000,
    });
    expect(r.energyMicros).toBe(18_375_000);
    expect(r.cycleMicros).toBe(0);
    expect(r.royaltyMicros).toBe(18_375_000);
  });

  it("refuses negative or non-integer inputs", () => {
    expect(() =>
      telemetryRoyaltyMicros({
        kwhMicros: -1,
        chargeCycles: 0,
        microsPerKwh: 1_500_000,
        microsPerChargeCycle: 0,
      }),
    ).toThrow(/hardware_telemetry_invalid_kwh/);
    expect(() =>
      telemetryRoyaltyMicros({
        kwhMicros: 0,
        chargeCycles: 1.5,
        microsPerKwh: 1_500_000,
        microsPerChargeCycle: 0,
      }),
    ).toThrow(/hardware_telemetry_invalid_cycles/);
    expect(() =>
      telemetryRoyaltyMicros({
        kwhMicros: 0,
        chargeCycles: 0,
        microsPerKwh: -5,
        microsPerChargeCycle: 0,
      }),
    ).toThrow(/hardware_telemetry_invalid_rate/);
  });
});

describe("otaUnlockSplit — the per-unlock royalty split", () => {
  it("prices the pot and floors the licensor's bps share", () => {
    // $1.49 per unlock, licensor 70%: 149 × 7000/10000 = 104.3 → 104;
    // the platform's residual is the subtraction (the split conserves).
    const split = otaUnlockSplit({ microsPerUnlock: 149_000_000, licensorShareBps: 7_000 });
    expect(split.settlementMicros).toBe(149_000_000n);
    expect(split.settlementCents).toBe(149);
    expect(split.licensorCents).toBe(104);
    expect(split.platformCents).toBe(45);
    expect(split.licensorCents + split.platformCents).toBe(split.settlementCents);
  });

  it("refuses a non-positive rate and an out-of-vocabulary share", () => {
    expect(() => otaUnlockSplit({ microsPerUnlock: 0, licensorShareBps: 7_000 })).toThrow(
      /hardware_ota_invalid_rate/,
    );
    expect(() => otaUnlockSplit({ microsPerUnlock: 100, licensorShareBps: 10_001 })).toThrow(
      /hardware_ota_invalid_bps/,
    );
  });
});

describe("crossLicenseNetting — the net offset calculation", () => {
  it("nets the founder's Company A / Company B example at scale", () => {
    // Company A owes Company B 12,000,000.00 for 5G SEPs; Company B owes
    // Company A 8,000,000.00 for Wi-Fi 7 SEPs — a 4,000,000.00 dispatch
    // to Company B. In cents: 1,200,000,000 vs 800,000,000.
    const net = crossLicenseNetting({ owedAToBCents: 1_200_000_000, owedBToACents: 800_000_000 });
    expect(net.netCents).toBe(400_000_000);
    expect(net.direction).toBe("a_to_b");
  });

  it("nets the reverse direction and reports balanced liabilities honestly", () => {
    const reverse = crossLicenseNetting({ owedAToBCents: 3_000, owedBToACents: 345_000 });
    // The net is signed: positive dispatches a_to_b, negative b_to_a.
    expect(reverse.netCents).toBe(-342_000);
    expect(reverse.direction).toBe("b_to_a");

    const balanced = crossLicenseNetting({ owedAToBCents: 500, owedBToACents: 500 });
    expect(balanced.netCents).toBe(0);
    expect(balanced.direction).toBe("balanced");
  });

  it("refuses negative liabilities and self-pairs", () => {
    expect(() => crossLicenseNetting({ owedAToBCents: -1, owedBToACents: 0 })).toThrow(
      /hardware_netting_invalid_leg/,
    );
    expect(() => crossLicenseNormalizedPair("company-a", "company-a")).toThrow(
      /hardware_netting_self_pair/,
    );
    // The normalizer orders the pair canonically — the same agreement
    // from either direction resolves to the same identity.
    expect(crossLicenseNormalizedPair("company-b", "company-a")).toEqual({
      companyAId: "company-a",
      companyBId: "company-b",
    });
  });
});

// ---------------------------------------------------------------------------
// The strict parsers — sender layouts can never half-parse.
// ---------------------------------------------------------------------------

describe("the hardware lane's strict parsers", () => {
  it("dispatches every sender's sheet by its exact header", () => {
    const expectations = [
      ["hardware_cellular_activations.csv", "hardware_cellular_activations_csv"],
      ["hardware_mac_address_logs.csv", "hardware_mac_address_logs_csv"],
      ["hardware_production_serials.csv", "hardware_production_serials_csv"],
      ["hardware_smart_grid_telemetry.csv", "hardware_smart_grid_telemetry_csv"],
    ] as const;
    for (const [fixtureName, expectedKind] of expectations) {
      const content = loadFixture(fixtureName);
      const profile = dispatchStatementProfile(content);
      expect(profile?.kind).toBe(expectedKind);
      expect(profile?.parse(content).length).toBeGreaterThan(0);
    }
  });

  it("rejects a swapped header column outright", () => {
    const content = loadFixture("hardware_cellular_activations.csv").replace(
      "Device Wholesale ASP,Component COGS Base",
      "Component COGS Base,Device Wholesale ASP",
    );
    // The dispatch sniffs the exact header — a swapped column is not ours.
    expect(dispatchStatementProfile(content)).toBeNull();
  });

  it("rejects a short row instead of half-parsing it", () => {
    const content = loadFixture("hardware_mac_address_logs.csv").replace(
      "MAC-2026-03-0001,AA:BB:CC:DD:EE:01,company-a,fam-5g-modem,POOL-5G-VEHICLE,600,200.00,USD,2026-03",
      "MAC-2026-03-0001,AA:BB:CC:DD:EE:01,company-a,fam-5g-modem,POOL-5G-VEHICLE,600,200.00,USD",
    );
    const profile = dispatchStatementProfile(loadFixture("hardware_mac_address_logs.csv"));
    expect(profile).not.toBeNull();
    expect(() => profile?.parse(content)).toThrow(/column_count_mismatch/);
  });

  it("rejects a missing required cell", () => {
    const content = loadFixture("hardware_production_serials.csv").replace(
      "BAT-2026-03-0001,oem-atlas,line-hamburg,401,7.77,3.33,USD,2026-03",
      "BAT-2026-03-0001,oem-atlas,,401,7.77,3.33,USD,2026-03",
    );
    const profile = dispatchStatementProfile(loadFixture("hardware_production_serials.csv"));
    expect(() => profile?.parse(content)).toThrow(/missing_column:Production Line ID/);
  });

  it("rejects a negative money cell and a mangled decimal", () => {
    const negative = loadFixture("hardware_cellular_activations.csv").replace(
      "POOL-5G-VEHICLE,1200.00,425.50,74.50,,USD,2026-03",
      "POOL-5G-VEHICLE,1200.00,-425.50,74.50,,USD,2026-03",
    );
    const profile = dispatchStatementProfile(loadFixture("hardware_cellular_activations.csv"));
    expect(() => profile?.parse(negative)).toThrow(/negative_money:Component COGS Base/);

    const mangled = loadFixture("hardware_smart_grid_telemetry.csv").replace(
      "3.75,34,USD",
      "3.7.5,34,USD",
    );
    const telemetryProfile = dispatchStatementProfile(
      loadFixture("hardware_smart_grid_telemetry.csv"),
    );
    expect(() => telemetryProfile?.parse(mangled)).toThrow(/invalid_amount/);
  });

  it("rejects vocabulary drift: activation kinds, periods, and currency shapes", () => {
    const badKind = loadFixture("hardware_cellular_activations.csv").replace(
      "CVA-2026-03-0001,device_activation",
      "CVA-2026-03-0001,warranty_replacement",
    );
    const activationProfile = dispatchStatementProfile(
      loadFixture("hardware_cellular_activations.csv"),
    );
    expect(() => activationProfile?.parse(badKind)).toThrow(/invalid_vocabulary:Activation Kind/);

    const badPeriod = loadFixture("hardware_cellular_activations.csv").replace(
      "74.50,,USD,2026-03\nCVA-2026-03-0002",
      "74.50,,USD,March 2026\nCVA-2026-03-0002",
    );
    expect(() => activationProfile?.parse(badPeriod)).toThrow(/invalid_period:March 2026/);

    // The currency of record is shape-validated (ISO alpha-3) — a mangled
    // code is a row-scoped rejection.
    const badCurrency = loadFixture("hardware_mac_address_logs.csv").replace(
      ",600,200.00,USD,2026-03",
      ",600,200.00,USDD,2026-03",
    );
    const macProfile = dispatchStatementProfile(loadFixture("hardware_mac_address_logs.csv"));
    expect(() => macProfile?.parse(badCurrency)).toThrow(/currency must be an ISO alpha-3 code/);
  });

  it("rejects economics that cannot price: zero ASP, zero royalty basis, zero-fee batches, zero-telemetry", () => {
    const zeroAsp = loadFixture("hardware_cellular_activations.csv").replace(
      "POOL-5G-VEHICLE,1200.00,425.50,74.50,,USD,2026-03",
      "POOL-5G-VEHICLE,0.00,0.00,0.00,,USD,2026-03",
    );
    const activationProfile = dispatchStatementProfile(
      loadFixture("hardware_cellular_activations.csv"),
    );
    expect(() => activationProfile?.parse(zeroAsp)).toThrow(/hardware_row_prices_nothing/);

    const zeroBasis = loadFixture("hardware_mac_address_logs.csv").replace(
      ",600,200.00,USD,2026-03",
      ",600,0.00,USD,2026-03",
    );
    const macProfile = dispatchStatementProfile(loadFixture("hardware_mac_address_logs.csv"));
    expect(() => macProfile?.parse(zeroBasis)).toThrow(/hardware_row_prices_nothing/);

    const zeroFees = loadFixture("hardware_production_serials.csv").replace(
      "BAT-2026-03-0001,oem-atlas,line-hamburg,401,7.77,3.33,USD,2026-03",
      "BAT-2026-03-0001,oem-atlas,line-hamburg,401,0.00,0.00,USD,2026-03",
    );
    const productionProfile = dispatchStatementProfile(
      loadFixture("hardware_production_serials.csv"),
    );
    expect(() => productionProfile?.parse(zeroFees)).toThrow(/hardware_row_prices_nothing/);

    const zeroTelemetry = loadFixture("hardware_smart_grid_telemetry.csv").replace(
      "TLM-2026-03-0001,meter-zenith-01,fam-solid-state-cell,3.75,34,USD,2026-03",
      "TLM-2026-03-0001,meter-zenith-01,fam-solid-state-cell,0.00,0,USD,2026-03",
    );
    const telemetryProfile = dispatchStatementProfile(
      loadFixture("hardware_smart_grid_telemetry.csv"),
    );
    expect(() => telemetryProfile?.parse(zeroTelemetry)).toThrow(/hardware_row_prices_nothing/);
  });

  it("rejects OTA rows priced off the row and activation rows carrying a feature code", () => {
    const otaPriced = loadFixture("hardware_cellular_activations.csv").replace(
      "OTA-2026-03-0001,ota_feature_unlock,IMEI-356938035643809,EID-89049032000001000001,fam-5g-modem,POOL-5G-VEHICLE,0.00,0.00,0.00,fcs_self_driving_sensors,USD,2026-03",
      "OTA-2026-03-0001,ota_feature_unlock,IMEI-356938035643809,EID-89049032000001000001,fam-5g-modem,POOL-5G-VEHICLE,1200.00,425.50,74.50,fcs_self_driving_sensors,USD,2026-03",
    );
    const activationProfile = dispatchStatementProfile(
      loadFixture("hardware_cellular_activations.csv"),
    );
    // An OTA unlock prices by its feature policy — a price basis on the
    // row is unexpected (and would silently change nothing).
    expect(() => activationProfile?.parse(otaPriced)).toThrow(/ota_unlock_prices_nothing/);

    const pricedActivation = loadFixture("hardware_cellular_activations.csv").replace(
      "CVA-2026-03-0001,device_activation,IMEI-356938035643809,EID-89049032000001000001,fam-5g-modem,POOL-5G-VEHICLE,1200.00,425.50,74.50,,USD,2026-03",
      "CVA-2026-03-0001,device_activation,IMEI-356938035643809,EID-89049032000001000001,fam-5g-modem,POOL-5G-VEHICLE,1200.00,425.50,74.50,fcs_self_driving_sensors,USD,2026-03",
    );
    expect(() => activationProfile?.parse(pricedActivation)).toThrow(/unexpected_feature_code/);
  });
});
