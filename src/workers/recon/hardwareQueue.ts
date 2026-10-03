/**
 * CVT recon worker — the hardware lane's store-touching pass (PR 46, the
 * founder hardware directive). The math and identity spaces live in
 * hardware.ts, the profiles in hardwareProfiles.ts; THIS module is the
 * only place the lane touches the store — the same discipline as
 * developerQueue.ts and the other lanes' queue modules.
 *
 * House rules, restated as the module's contract:
 * - FAIL-CLOSED — a walk the lane cannot fully price records its honest
 *   outcome: a negative realization net is a HELD verdict (visible, never
 *   dropped, never posted), and a connected device without a SEP royalty
 *   policy of record, an OEM line without a pool assignment, a pool
 *   without a registration (or without holder weightings), a metering
 *   device's family without a clean-tech policy, a corporate pair
 *   without a cross-license agreement, and an OTA feature without an
 *   unlock policy are counted skips — the walk never guesses a rate, a
 *   routing, or a weighting.
 * - REPLAY GUARDS — every application is UNIQUE per content-derived
 *   source_event_id (hardwareRowEventId, the ledger namespace riding the
 *   prefix; the pool waterfall keys on (routing event, pool) and the net
 *   settlement on (agreement ref, period)): a re-shipped sheet replays
 *   as a counted no-op.
 * - THE UNITS PRICE THE TIER WALK — the per-unit FRAND royalty is
 *   per-unit pricing off the row's royalty basis against the (licensee,
 *   family, pool, month) cumulative position; the per-unit cap floors
 *   each band's rate (the founder example: a 2.5% FRAND rate capped at
 *   $3.00 per connected vehicle module). A HELD realization never blocks
 *   a MAC log's royalty — the realization and the royalty are separate
 *   ledgers of record (the developer precedent).
 * - THE SPLITS CONSERVE — the essentiality waterfall and the OTA unlock
 *   split route shares whose sums pin to their basis (the waterfall's
 *   dust rides the highest-scored holders; the OTA split's platform
 *   residual is the subtraction).
 *
 * The four senders' walks:
 *
 *   1. CELLULAR DEVICE ACTIVATIONS (sender 'cellular_activation',
 *      kind 'device_activation') — the Net Hardware Patent Realization
 *      (device wholesale ASP − component COGS base − non-essential BOM
 *      = the Net Patentable Device Value Base), keyed on the founder's
 *      patent_family_id / sep_pool_code / device_imei_mac columns.
 *   2. CELLULAR DEVICE ACTIVATIONS (sender 'cellular_activation',
 *      kind 'ota_feature_unlock') — the instant per-unlock royalty
 *      split: the policy's pot, the sensor licensor's bps share posted
 *      the moment the row commits (the PR 45 precedent).
 *   3. HARDWARE MAC ADDRESS LOGS (sender 'mac_address_log') — the
 *      tiered FRAND SEP micro-royalty across the cumulative unit
 *      position, then the cross-license netting trigger when the
 *      (licensee, holder) pair rides an agreement of record.
 *   4. FACTORY PRODUCTION SERIALS (sender 'production_serial') — the
 *      automotive OEM pool routing (serials × per-vehicle fees), then
 *      the essentiality-weighted waterfall per receiving pool.
 *   5. SMART GRID TELEMETRY (sender 'smart_grid_telemetry') — the
 *      per-kilowatt-hour and per-charge-cycle micro-payouts at the
 *      clean-tech policy of record.
 *
 * Hardware rows NEVER enter match_queue and NEVER touch the music split
 * machinery — the store applications are this lane's money of record.
 */

import type { Store } from "@/lib/server/store";
import type { HardwareSepTierBand } from "@/modules/hardware/records";
import { postInstantOtaUnlockSettlement } from "@/lib/server/hardwareOtaUnlockSettlements";
import type { HardwareLineDetail, ParsedStatementLine } from "./records";
import {
  automotivePoolRoutingCents,
  crossLicenseNetting,
  crossLicenseNormalizedPair,
  essentialityWaterfallCents,
  hardwareMicrosToCents,
  hardwareRowEventId,
  hardwareSepTierWalk,
  netHardwarePatentRealizationCents,
  telemetryRoyaltyMicros,
  validateHardwareSepBands,
} from "./hardware";

/** The hardware lane's per-pass counters — the honest outcome summary. */
export interface HardwareWriteCounts {
  /** Realizations committed / counted replay no-ops / the negative-net
   * holds (the money pauses, visible). */
  realizationsWritten: number;
  realizationsReplayed: number;
  realizationsHeldNonPositiveNet: number;
  /** SEP royalties committed / counted replay no-ops / fail-closed
   * skips (no royalty policy of record for the family + pool, or one
   * whose tier ladder fails validation at read). */
  sepRoyaltiesWritten: number;
  sepRoyaltiesReplayed: number;
  sepSkippedNoPolicy: number;
  /** OEM routings committed / counted replay no-ops / fail-closed
   * skips (no pool assignment of record for the OEM line). */
  oemRoutingsWritten: number;
  oemRoutingsReplayed: number;
  oemSkippedNoAssignment: number;
  /** Pool waterfalls committed / counted replay no-ops / fail-closed
   * skips (no pool registration, or no verified holder weightings). */
  poolWaterfallsWritten: number;
  poolWaterfallsReplayed: number;
  poolSkippedNoPool: number;
  /** Telemetry royalties committed / counted replay no-ops / fail-
   * closed skips (no clean-tech policy of record for the family). */
  telemetryRoyaltiesWritten: number;
  telemetryRoyaltiesReplayed: number;
  telemetrySkippedNoPolicy: number;
  /** Cross-license net settlements committed / counted replay no-ops /
   * fail-closed skips (no agreement of record for the pair). */
  crossLicenseNettingsWritten: number;
  crossLicenseNettingsReplayed: number;
  crossLicenseSkippedNoAgreement: number;
  /** OTA unlock settlements committed / counted replay no-ops / fail-
   * closed skips (no unlock policy of record for the feature). */
  otaUnlockSettlementsWritten: number;
  otaUnlockSettlementsReplayed: number;
  otaUnlockSkippedNoPolicy: number;
  /** The instant postings — journals written the moment an unlock
   * priced (sub-cent pots record rows, no journal, and are NOT counted
   * here). */
  otaUnlockInstantPostings: number;
  /** The committed money, integer cents. */
  netPatentableValueBaseCents: number;
  sepRoyaltyCents: number;
  oemRoutedCents: number;
  poolDistributedCents: number;
  telemetryRoyaltyCents: number;
  crossLicenseNetDispatchCents: number;
  otaLicensorCents: number;
  otaPlatformCents: number;
}

/**
 * The hardware lane's one pass over a parsed statement's lines — the
 * seven application ledgers (realization, SEP royalty, OEM routing,
 * pool waterfall, telemetry royalty, cross-license netting, and OTA
 * unlock settlement) land in the store's hardware tables. Throws into
 * the job's fail-closed error path on any store failure.
 */
export async function writeHardwareRowsToStore(
  store: Store,
  lines: readonly ParsedStatementLine[],
): Promise<HardwareWriteCounts> {
  const counts: HardwareWriteCounts = {
    realizationsWritten: 0,
    realizationsReplayed: 0,
    realizationsHeldNonPositiveNet: 0,
    sepRoyaltiesWritten: 0,
    sepRoyaltiesReplayed: 0,
    sepSkippedNoPolicy: 0,
    oemRoutingsWritten: 0,
    oemRoutingsReplayed: 0,
    oemSkippedNoAssignment: 0,
    poolWaterfallsWritten: 0,
    poolWaterfallsReplayed: 0,
    poolSkippedNoPool: 0,
    telemetryRoyaltiesWritten: 0,
    telemetryRoyaltiesReplayed: 0,
    telemetrySkippedNoPolicy: 0,
    crossLicenseNettingsWritten: 0,
    crossLicenseNettingsReplayed: 0,
    crossLicenseSkippedNoAgreement: 0,
    otaUnlockSettlementsWritten: 0,
    otaUnlockSettlementsReplayed: 0,
    otaUnlockSkippedNoPolicy: 0,
    otaUnlockInstantPostings: 0,
    netPatentableValueBaseCents: 0,
    sepRoyaltyCents: 0,
    oemRoutedCents: 0,
    poolDistributedCents: 0,
    telemetryRoyaltyCents: 0,
    crossLicenseNetDispatchCents: 0,
    otaLicensorCents: 0,
    otaPlatformCents: 0,
  };

  for (const line of lines) {
    const detail = line.hardwareDetail;
    // The hardware profiles always attach the detail; a line without one
    // is a lane bug — refuse, never silently skip.
    if (detail === undefined || detail === null) {
      throw new Error(`hardware_detail_missing: line ${line.lineNumber} has no hardware detail`);
    }

    switch (detail.sender) {
      case "cellular_activation":
        if (detail.activationKind === "device_activation") {
          await walkHardwareRealization(store, detail, counts);
        } else {
          await walkOtaUnlockSettlement(store, detail, counts);
        }
        continue;
      case "mac_address_log":
        await walkHardwareSepRoyalty(store, detail, counts);
        continue;
      case "production_serial":
        await walkHardwareOemRouting(store, detail, counts);
        continue;
      case "smart_grid_telemetry":
        await walkHardwareTelemetryRoyalty(store, detail, counts);
        continue;
    }
  }

  return counts;
}

// ---------------------------------------------------------------------------
// Sender 1, kind 'device_activation' — the Net Hardware Patent
// Realization: the founder's exact identity on the activation's own
// figures, keyed on the patent_family_id, sep_pool_code, and
// device_imei_mac columns.
// ---------------------------------------------------------------------------

async function walkHardwareRealization(
  store: Store,
  detail: Extract<HardwareLineDetail, { sender: "cellular_activation" }>,
  counts: HardwareWriteCounts,
): Promise<void> {
  const sourceEventId = hardwareRowEventId("realization", detail);

  // The replay guard's read — a re-shipped sheet is a counted no-op (the
  // UNIQUE constraint is the concurrent backstop behind this read).
  const existing = await store.getHardwareRealizationApplication(sourceEventId);
  if (existing !== undefined) {
    counts.realizationsReplayed += 1;
    return;
  }

  // THE NET HARDWARE PATENT REALIZATION — the sender's own figures
  // (never a rate guess); the identity (COGS + BOM + net === ASP) pins
  // the math at the database.
  const realization = netHardwarePatentRealizationCents({
    deviceWholesaleAspCents: detail.deviceWholesaleAspCents,
    componentCogsBaseCents: detail.componentCogsBaseCents,
    nonEssentialBomCents: detail.nonEssentialBomCents,
  });

  // A NEGATIVE NET — the deduction legs exceeded the device wholesale
  // ASP. Recorded visible (the held row's truth); the money pauses,
  // never drops, never guesses into a route.
  const held = realization.netPatentableDeviceValueBaseCents < 0;

  await store.insertHardwareRealizationApplication({
    source_event_id: sourceEventId,
    patent_family_id: detail.patentFamilyId,
    sep_pool_code: detail.sepPoolCode,
    device_imei_mac: detail.deviceImeiMac,
    eid: detail.eid,
    period: detail.period,
    currency: detail.currency,
    device_wholesale_asp_cents: realization.deviceWholesaleAspCents,
    component_cogs_base_cents: detail.componentCogsBaseCents,
    non_essential_bom_cents: detail.nonEssentialBomCents,
    net_patentable_device_value_base_cents: realization.netPatentableDeviceValueBaseCents,
    verdict: held ? "held_negative_net" : "paid",
  });
  counts.realizationsWritten += 1;
  // The value base of record includes the held row's negative net — the
  // pass summary shows the truth (the developer lane's precedent).
  counts.netPatentableValueBaseCents += realization.netPatentableDeviceValueBaseCents;
  if (held) {
    counts.realizationsHeldNonPositiveNet += 1;
  }
}

// ---------------------------------------------------------------------------
// Sender 2, kind 'ota_feature_unlock' — the instant per-unlock royalty
// split: the policy's pot, the sensor licensor's bps share posted the
// moment the row commits (the PR 45 precedent, the hardware lane's
// posting path).
// ---------------------------------------------------------------------------

async function walkOtaUnlockSettlement(
  store: Store,
  detail: Extract<HardwareLineDetail, { sender: "cellular_activation" }>,
  counts: HardwareWriteCounts,
): Promise<void> {
  const sourceEventId = hardwareRowEventId("ota_unlock", detail);

  // PR 46 — the instant micro-settlement: EVERY OTA feature-unlock
  // purchase prices and posts the moment the walk reaches it (per-event,
  // on detection — not a batch-end sweep). ONE pricing/posting path: the
  // lane owns the replay guard, the fail-closed policy read, the split
  // economics, the application row of record, and the immediate posting
  // (sensor licensor ledger through the taxed cascade + platform share).
  const result = await postInstantOtaUnlockSettlement(store, {
    source_event_id: sourceEventId,
    feature_code: detail.featureCode ?? "",
    device_imei_mac: detail.deviceImeiMac,
    period: detail.period,
    currency: detail.currency,
  });
  if (!result.ok) {
    if (result.code === "ota_unlock_policy_missing") {
      // The walk's counted fail-closed skip — never a guessed rate.
      counts.otaUnlockSkippedNoPolicy += 1;
      return;
    }
    throw new Error(`hardware_ota_unlock_settlement_refused:${result.code}:${result.message}`);
  }
  const { value } = result;
  if (value.replayed) {
    counts.otaUnlockSettlementsReplayed += 1;
    return;
  }
  counts.otaUnlockSettlementsWritten += 1;
  if (value.journal_id !== null) {
    counts.otaUnlockInstantPostings += 1;
  }
  counts.otaLicensorCents += value.licensor_cents;
  counts.otaPlatformCents += value.platform_cents;
}

// ---------------------------------------------------------------------------
// Sender 3 — the tiered FRAND SEP micro-royalty: the connected units
// cross the (licensee, family, pool, month) cumulative position; each
// band's per-unit royalty floors its rate against its cap. Then the
// cross-license netting trigger when the (licensee, holder) pair rides
// an agreement of record.
// ---------------------------------------------------------------------------

async function walkHardwareSepRoyalty(
  store: Store,
  detail: Extract<HardwareLineDetail, { sender: "mac_address_log" }>,
  counts: HardwareWriteCounts,
): Promise<void> {
  const sourceEventId = hardwareRowEventId("sep_royalty", detail);

  const existing = await store.getHardwareSepRoyaltyApplication(sourceEventId);
  if (existing !== undefined) {
    counts.sepRoyaltiesReplayed += 1;
    return;
  }

  // The royalty policy of record — no policy, no royalty (the walk never
  // guesses a rate).
  const policy = await store.getHardwareSepRoyaltyPolicy(
    detail.patentFamilyId,
    detail.sepPoolCode,
  );
  if (policy === undefined) {
    counts.sepSkippedNoPolicy += 1;
    return;
  }

  // The policy of record re-validates at every read.
  let bands: readonly HardwareSepTierBand[];
  try {
    bands = validateHardwareSepBands(JSON.parse(policy.tier_bands) as readonly unknown[]);
  } catch {
    counts.sepSkippedNoPolicy += 1;
    return;
  }

  const tracker = await store.getHardwareSepUnitMonth(
    detail.licenseeId,
    detail.patentFamilyId,
    detail.sepPoolCode,
    detail.period,
  );
  const cumulativeUnitsBefore = tracker?.cumulative_units ?? 0;
  const walk = hardwareSepTierWalk({
    units: detail.connectedUnits,
    cumulativeBefore: cumulativeUnitsBefore,
    royaltyBasisCents: detail.royaltyBasisCents,
    bands,
  });
  // The tracker advances BEFORE the application commits — the walk's
  // cumulative position is the month's of-record position (the fitness
  // lane's precedent; both passes are replay-guarded).
  await store.advanceHardwareSepUnitMonth(
    detail.licenseeId,
    detail.patentFamilyId,
    detail.sepPoolCode,
    detail.period,
    detail.connectedUnits,
  );
  await store.insertHardwareSepRoyaltyApplication({
    source_event_id: sourceEventId,
    licensee_id: detail.licenseeId,
    patent_family_id: detail.patentFamilyId,
    sep_pool_code: detail.sepPoolCode,
    period: detail.period,
    currency: detail.currency,
    policy_ref: policy.id,
    payee_id: policy.payee_id,
    device_mac: detail.deviceMac,
    connected_units: detail.connectedUnits,
    royalty_basis_cents: detail.royaltyBasisCents,
    tier_legs: JSON.stringify(walk.legs),
    royalty_cents: walk.royaltyCents,
    cumulative_units_before: cumulativeUnitsBefore,
    cumulative_units_after: walk.cumulativeAfter,
  });
  counts.sepRoyaltiesWritten += 1;
  counts.sepRoyaltyCents += walk.royaltyCents;

  // THE CROSS-LICENSE NETTING TRIGGER — the (licensee, holder) pair's
  // agreement of record turns this application's liability into one
  // side of the net balance clearing. No agreement, no netting (a
  // counted fail-closed skip — never a guessed settlement).
  await walkCrossLicenseNetting(
    store,
    detail.licenseeId,
    policy.payee_id,
    detail.period,
    detail.currency,
    counts,
  );
}

// ---------------------------------------------------------------------------
// The cross-license net balance clearing: the lane's SEP royalty
// applications between the two companies sum to the mutual liabilities
// of record for the period; the netting recomputes and replaces the
// settlement of record on every trigger (UNIQUE per (agreement_ref,
// period) — the settlement of record carries the period's full mutual
// liabilities once the month's sheets have all shipped).
// ---------------------------------------------------------------------------

async function walkCrossLicenseNetting(
  store: Store,
  licenseeId: string,
  holderPayeeId: string,
  period: string,
  currency: string,
  counts: HardwareWriteCounts,
): Promise<void> {
  const pair = crossLicenseNormalizedPair(licenseeId, holderPayeeId);
  const agreement = await store.getHardwareCrossLicenseAgreement(
    pair.companyAId,
    pair.companyBId,
  );
  if (agreement === undefined) {
    counts.crossLicenseSkippedNoAgreement += 1;
    return;
  }

  // The mutual liabilities of record — the lane's own royalty
  // applications between the pair, summed per direction. (The lane's
  // operating currency of record prices a period in one currency; the
  // settlement carries the triggering row's.)
  const owedAToBCents = await store.sumHardwareSepRoyaltiesBetween(
    pair.companyAId,
    pair.companyBId,
    period,
  );
  const owedBToACents = await store.sumHardwareSepRoyaltiesBetween(
    pair.companyBId,
    pair.companyAId,
    period,
  );

  // The counted no-op — the settlement of record already carries these
  // exact sums. (A re-shipped sheet never re-triggers this walk at all:
  // its royalty rows replay before the trigger. A LATE-ARRIVING row for
  // an already-netted period re-triggers with new sums and re-nets.)
  const existing = await store.getHardwareCrossLicenseNetSettlement(
    agreement.agreement_ref,
    period,
  );
  if (
    existing !== undefined &&
    existing.owed_a_to_b_cents === owedAToBCents &&
    existing.owed_b_to_a_cents === owedBToACents
  ) {
    counts.crossLicenseNettingsReplayed += 1;
    return;
  }

  // THE NET BALANCE CLEARING — recomputed from the applications of
  // record on every trigger, so the settlement of record carries the
  // period's FULL mutual liabilities once the month's sheets have all
  // shipped (the founder example's exact shape: $12M owed by A − $8M
  // owed to A = $4M dispatching to B).
  const netting = crossLicenseNetting({ owedAToBCents, owedBToACents });

  await store.upsertHardwareCrossLicenseNetSettlement({
    agreement_ref: agreement.agreement_ref,
    company_a_id: pair.companyAId,
    company_b_id: pair.companyBId,
    period,
    currency,
    owed_a_to_b_cents: owedAToBCents,
    owed_b_to_a_cents: owedBToACents,
    net_cents: netting.netCents,
    direction: netting.direction,
  });
  counts.crossLicenseNettingsWritten += 1;
  counts.crossLicenseNetDispatchCents += Math.abs(netting.netCents);
}

// ---------------------------------------------------------------------------
// Sender 4 — the automotive OEM pool routing: per-vehicle cellular and
// navigation licensing fees × the production serials, routed to the
// line's pools of record; then the essentiality-weighted waterfall per
// receiving pool.
// ---------------------------------------------------------------------------

async function walkHardwareOemRouting(
  store: Store,
  detail: Extract<HardwareLineDetail, { sender: "production_serial" }>,
  counts: HardwareWriteCounts,
): Promise<void> {
  const sourceEventId = hardwareRowEventId("pool_routing", detail);

  const existing = await store.getHardwarePoolRoutingApplication(sourceEventId);
  if (existing !== undefined) {
    counts.oemRoutingsReplayed += 1;
    return;
  }

  // The pool assignment of record — none registered, no routing (the
  // walk never guesses a destination pool).
  const assignment = await store.getHardwareAutomotivePoolAssignment(
    detail.oemId,
    detail.lineId,
  );
  if (assignment === undefined) {
    counts.oemSkippedNoAssignment += 1;
    return;
  }

  // THE AUTOMOTIVE POOL ROUTING — the batch's fees × the serials,
  // integer-exact, routed to the line's pools.
  const routing = automotivePoolRoutingCents({
    serialsProduced: detail.serialsProduced,
    cellularFeePerVehicleCents: detail.cellularFeePerVehicleCents,
    navigationFeePerVehicleCents: detail.navigationFeePerVehicleCents,
  });

  await store.insertHardwarePoolRoutingApplication({
    source_event_id: sourceEventId,
    oem_id: detail.oemId,
    line_id: detail.lineId,
    period: detail.period,
    currency: detail.currency,
    assignment_ref: assignment.id,
    serials_produced: detail.serialsProduced,
    cellular_pool_code: assignment.cellular_pool_code,
    navigation_pool_code: assignment.navigation_pool_code,
    cellular_fee_per_vehicle_cents: detail.cellularFeePerVehicleCents,
    navigation_fee_per_vehicle_cents: detail.navigationFeePerVehicleCents,
    cellular_routed_cents: routing.cellularRoutedCents,
    navigation_routed_cents: routing.navigationRoutedCents,
    total_routed_cents: routing.totalRoutedCents,
  });
  counts.oemRoutingsWritten += 1;
  counts.oemRoutedCents += routing.totalRoutedCents;

  // THE POOL WATERFALLS — each receiving pool's fee pot distributes
  // across its verified holders by essentiality score weightings (the
  // MPEG-LA / Avanci shape). A pool fee of zero runs no waterfall.
  if (routing.cellularRoutedCents > 0) {
    await walkPoolWaterfall(
      store,
      sourceEventId,
      assignment.cellular_pool_code,
      routing.cellularRoutedCents,
      detail.period,
      detail.currency,
      counts,
    );
  }
  if (routing.navigationRoutedCents > 0) {
    await walkPoolWaterfall(
      store,
      sourceEventId,
      assignment.navigation_pool_code,
      routing.navigationRoutedCents,
      detail.period,
      detail.currency,
      counts,
    );
  }
}

// ---------------------------------------------------------------------------
// The essentiality-weighted pool waterfall: the pool's registration and
// its verified holder weightings of record; the pot splits floor per
// holder and the dust rides the highest-scored holders until the pot
// conserves exactly. No pool registration, or no holder weightings, no
// waterfall (a counted fail-closed skip — never a guessed weighting).
// ---------------------------------------------------------------------------

async function walkPoolWaterfall(
  store: Store,
  routingSourceEventId: string,
  poolCode: string,
  poolFeePotCents: number,
  period: string,
  currency: string,
  counts: HardwareWriteCounts,
): Promise<void> {
  const pool = await store.getHardwarePatentPool(poolCode);
  const holders = await store.listHardwarePoolHolderLegs(poolCode);
  if (pool === undefined || holders.length === 0) {
    counts.poolSkippedNoPool += 1;
    return;
  }

  // The replay guard's read — this routing's waterfall for this pool
  // already priced (UNIQUE per (routing event, pool)).
  const existing = await store.getHardwarePoolWaterfallApplication(
    routingSourceEventId,
    poolCode,
  );
  if (existing !== undefined) {
    counts.poolWaterfallsReplayed += 1;
    return;
  }

  // THE ESSENTIALITY WATERFALL — the pot conserves exactly.
  const waterfall = essentialityWaterfallCents({
    poolFeePotCents,
    holders: holders.map((holder) => ({
      holder_payee_id: holder.holder_payee_id,
      essentiality_score: holder.essentiality_score,
    })),
  });

  await store.insertHardwarePoolWaterfallApplication({
    routing_source_event_id: routingSourceEventId,
    pool_code: poolCode,
    period,
    currency,
    split_legs: JSON.stringify(waterfall.legs),
    pool_fee_pot_cents: poolFeePotCents,
    allocated_total_cents: waterfall.allocatedTotalCents,
  });
  counts.poolWaterfallsWritten += 1;
  counts.poolDistributedCents += waterfall.allocatedTotalCents;
}

// ---------------------------------------------------------------------------
// Sender 5 — the clean-tech telemetry micro-payout: per-kilowatt-hour
// and per-charge-cycle micros at the clean-tech policy of record,
// bigint-exact, floored into payable cents.
// ---------------------------------------------------------------------------

async function walkHardwareTelemetryRoyalty(
  store: Store,
  detail: Extract<HardwareLineDetail, { sender: "smart_grid_telemetry" }>,
  counts: HardwareWriteCounts,
): Promise<void> {
  const sourceEventId = hardwareRowEventId("telemetry", detail);

  const existing = await store.getHardwareTelemetryRoyaltyApplication(sourceEventId);
  if (existing !== undefined) {
    counts.telemetryRoyaltiesReplayed += 1;
    return;
  }

  // The clean-tech policy of record — none registered, no payout (the
  // walk never guesses a payee or a rate).
  const policy = await store.getHardwareCleanTechRoyaltyPolicy(detail.patentFamilyId);
  if (policy === undefined) {
    counts.telemetrySkippedNoPolicy += 1;
    return;
  }

  // THE TELEMETRY MICRO-PAYOUT — bigint-exact off the row's own counts,
  // floored into payable cents.
  const royalty = telemetryRoyaltyMicros({
    kwhMicros: detail.kwhMicros,
    chargeCycles: detail.chargeCycles,
    microsPerKwh: policy.micros_per_kwh,
    microsPerChargeCycle: policy.micros_per_charge_cycle,
  });
  const royaltyCents = hardwareMicrosToCents(royalty.royaltyMicros);

  await store.insertHardwareTelemetryRoyaltyApplication({
    source_event_id: sourceEventId,
    patent_family_id: detail.patentFamilyId,
    period: detail.period,
    currency: detail.currency,
    policy_ref: policy.id,
    payee_id: policy.payee_id,
    device_serial: detail.deviceSerial,
    kwh_micros: detail.kwhMicros,
    charge_cycles: detail.chargeCycles,
    micros_per_kwh: policy.micros_per_kwh,
    micros_per_charge_cycle: policy.micros_per_charge_cycle,
    royalty_micros: Number(royalty.royaltyMicros),
    royalty_cents: royaltyCents,
  });
  counts.telemetryRoyaltiesWritten += 1;
  counts.telemetryRoyaltyCents += royaltyCents;
}
