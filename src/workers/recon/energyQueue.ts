/**
 * CVT recon worker — the energy lane's store-touching pass (PR 48, the
 * founder resource directive). The math and identity spaces live in
 * energy.ts, the profiles in energyProfiles.ts; THIS module is the only
 * place the lane touches the store — the same discipline as
 * hardwareQueue.ts and the other lanes' queue modules.
 *
 * House rules, restated as the module's contract:
 * - FAIL-CLOSED — a walk the lane cannot fully price records its honest
 *   outcome: a negative realization net is a HELD verdict (visible,
 *   never dropped, never posted), and a parcel without a royalty policy
 *   of record (or one whose tier ladder fails validation at read), a
 *   parcel without registered owner interests, a cluster without a
 *   yield policy (or valid bands), a cluster without registered grid
 *   participants, and a mint without a carbon offset policy are counted
 *   skips — the walk never guesses a rate, a routing, or a weighting.
 * - REPLAY GUARDS — every post and application is UNIQUE per
 *   content-derived source_event_id (energyRowEventId, the ledger
 *   namespace riding the energy prefix): a re-shipped sheet replays as
 *   a counted no-op, and a re-shipped row never re-triggers the
 *   realization recompute, the royalty walk, the division, or the
 *   cascade pricing behind it.
 * - THE REALIZATION RECOMPUTES FROM THE POSTS — the Net Realized
 *   Resource Pool of record is the five-tuple position recomputed in
 *   place from the meter-sales and pipeline-deduction post sums (the
 *   cross-license settlement precedent): every NEW post re-sums the
 *   key's legs and replaces the application of record.
 * - THE TIER WALKS PRICE MARGINALLY — the parcel's royalty basis and
 *   the cluster's yield basis cross the cumulative positions of record;
 *   each band's bps prices the basis inside its window. A HELD
 *   realization never blocks a royalty — the realization and the
 *   royalty are separate ledgers of record (the developer precedent).
 * - THE SPLITS CONSERVE — the acreage division and the grid split
 *   route shares whose sums pin to their basis (the engines' dust
 *   discipline); the grid split's application of record stages the
 *   computed cascade at journal_id null for the posting pass of record.
 *
 * The four senders' walks:
 *
 *   1. SCADA SMART METER UTILITY LOGS (sender 'scada_meter_sales') —
 *      the gross post, the Net Resource Realization recompute, the
 *      parcel's tiered ORRI royalty walk, the acreage-ratio division
 *      across the deeded fractional heirs, and the statutory interest
 *      accruals for the deed transfers of record that moved a leg's
 *      title into the current holder's hands.
 *   2. PIPELINE FLOW-METER VOLUME FEEDS (sender 'pipeline_flow_meter')
 *      — the deduction post and the realization recompute.
 *   3. GPU DATA CENTER UTILIZATION METRICS (sender 'gpu_utilization') —
 *      the utilization post, the cluster's tiered yield walk to the
 *      infrastructure sponsors, and the telemetry-weighted grid split
 *      across the registered participants (the cascade trigger's
 *      calculation of record).
 *   4. CARBON OFFSET REGISTRY MINTS (sender 'carbon_offset_mint') — the
 *      per-tonne micro-royalty to the conservation trust and the
 *      project developer at the policy of record.
 *
 * Energy rows NEVER enter match_queue and NEVER touch the music split
 * machinery — the store applications are this lane's money of record.
 */

import type { Store } from "@/lib/server/store";
import type { EnergyDeedTransferRecord } from "@/modules/energy/records";
import type {
  EnergyCarbonOffsetMintDetail,
  EnergyGpuUtilizationDetail,
  EnergyPipelineFlowMeterDetail,
  EnergyScadaMeterSalesDetail,
  ParsedStatementLine,
} from "./records";
import {
  carbonOffsetPayoutCents,
  energyRowEventId,
  energyRoyaltyTierWalk,
  isEnergyPeriod,
  netResourceRealizationCents,
  planComputeGridSplit,
  planParcelAcreageDivision,
  statutoryInterestCents,
  validateEnergyRoyaltyBands,
} from "./energy";

/** The energy lane's per-pass counters — the honest outcome summary. */
export interface EnergyWriteCounts {
  /** Realization recomputes committed / the negative-net holds (the
   * money pauses, visible). */
  realizationsWritten: number;
  /** Energy rows replayed as counted no-ops by the replay guards (all
   * four senders' re-shipped rows). */
  rowsReplayed: number;
  realizationsHeldNegativeNet: number;
  /** Parcel tier royalties committed / fail-closed skips (no royalty
   * policy of record, or one whose tier ladder fails validation at
   * read). */
  parcelRoyaltiesWritten: number;
  parcelRoyaltiesSkippedNoPolicy: number;
  /** Acreage divisions committed / fail-closed skips (no registered
   * owner interests for the parcel). */
  divisionsWritten: number;
  divisionsSkippedNoInterests: number;
  /** Statutory interest accruals committed for the rerouted legs. */
  statutoryInterestAccrualsWritten: number;
  /** GPU yield royalties committed / fail-closed skips (no yield
   * policy of record, or one whose tier ladder fails validation at
   * read). */
  gpuYieldsWritten: number;
  gpuYieldsSkippedNoPolicy: number;
  /** Grid splits (cascade trigger calculations) committed / fail-closed
   * skips (no registered participants for the cluster). */
  gridSplitsWritten: number;
  gridSplitsSkippedNoParticipants: number;
  /** Carbon offset payouts committed / fail-closed skips (no offset
   * policy of record for the parcel). */
  carbonPayoutsWritten: number;
  carbonPayoutsSkippedNoPolicy: number;
  /** The committed money, integer cents. The pool DELTA is what this
   * pass's realization recomputes moved the pool of record by (the
   * per-tuple after − before of record; negative when the deduction
   * legs claw gross back) — additive across jobs, never a double-count
   * of a tuple an earlier job already priced. */
  netRealizedResourcePoolDeltaCents: number;
  parcelRoyaltyCents: number;
  dividedCents: number;
  statutoryInterestAccruedCents: number;
  gpuYieldCents: number;
  gridSplitCents: number;
  carbonPayoutTotalCents: number;
}

/**
 * The energy lane's one pass over a parsed statement's lines — the
 * application ledgers (realization, parcel royalty, acreage division,
 * statutory interest, GPU yield, grid split cascade trigger, and carbon
 * offset payout) land in the store's energy tables. Throws into the
 * job's fail-closed error path on any store failure.
 */
export async function writeEnergyRowsToStore(
  store: Store,
  lines: readonly ParsedStatementLine[],
): Promise<EnergyWriteCounts> {
  const counts: EnergyWriteCounts = {
    realizationsWritten: 0,
    rowsReplayed: 0,
    realizationsHeldNegativeNet: 0,
    parcelRoyaltiesWritten: 0,
    parcelRoyaltiesSkippedNoPolicy: 0,
    divisionsWritten: 0,
    divisionsSkippedNoInterests: 0,
    statutoryInterestAccrualsWritten: 0,
    gpuYieldsWritten: 0,
    gpuYieldsSkippedNoPolicy: 0,
    gridSplitsWritten: 0,
    gridSplitsSkippedNoParticipants: 0,
    carbonPayoutsWritten: 0,
    carbonPayoutsSkippedNoPolicy: 0,
    netRealizedResourcePoolDeltaCents: 0,
    parcelRoyaltyCents: 0,
    dividedCents: 0,
    statutoryInterestAccruedCents: 0,
    gpuYieldCents: 0,
    gridSplitCents: 0,
    carbonPayoutTotalCents: 0,
  };
  // The pool delta's per-tuple tracking — the recompute REPLACES
  // positions in place, so the pass's pool summary is each DISTINCT
  // key's (before, after) of record and the counter totals after −
  // before (summing finals would double-count a tuple an earlier job
  // already priced into its own pass summary).
  const poolOfRecord = new Map<string, { before: number; after: number }>();

  for (const line of lines) {
    const detail = line.energyDetail;
    // The energy profiles always attach the detail; a line without one
    // is a lane bug — refuse, never silently skip.
    if (detail === undefined || detail === null) {
      throw new Error(`energy_detail_missing: line ${line.lineNumber} has no energy detail`);
    }

    switch (detail.sender) {
      case "scada_meter_sales":
        await walkEnergyMeterSales(store, detail, counts, poolOfRecord);
        continue;
      case "pipeline_flow_meter":
        await walkEnergyPipelineDeduction(store, detail, counts, poolOfRecord);
        continue;
      case "gpu_utilization":
        await walkEnergyGpuUtilization(store, detail, counts);
        continue;
      case "carbon_offset_mint":
        await walkEnergyCarbonOffset(store, detail, counts);
        continue;
    }
  }

  counts.netRealizedResourcePoolDeltaCents = [...poolOfRecord.values()].reduce(
    (sum, delta) => sum + (delta.after - delta.before),
    0,
  );

  return counts;
}

// ---------------------------------------------------------------------------
// The realization recompute — the five-tuple position of record, resummed
// from the posts and replaced in place on every NEW post (the
// cross-license settlement precedent: the settlement of record carries
// the period's full sums once the sheets have shipped).
// ---------------------------------------------------------------------------

async function recomputeEnergyRealization(
  store: Store,
  parcelId: string,
  wellMeterId: string,
  gpuClusterHash: string,
  period: string,
  currency: string,
  counts: EnergyWriteCounts,
  poolOfRecord: Map<string, { before: number; after: number }>,
): Promise<void> {
  const posts = await store.sumEnergyRealizationPosts(
    parcelId,
    wellMeterId,
    gpuClusterHash,
    period,
    currency,
  );

  // THE NET RESOURCE REALIZATION — the founder's exact identity: gross
  // energy and mineral sales revenue minus transportation and pipeline
  // deductions minus grid transmission fees minus processing and
  // refining base fees.
  const realization = netResourceRealizationCents({
    grossEnergySalesCents: posts.gross_energy_sales_cents,
    grossMineralSalesCents: posts.gross_mineral_sales_cents,
    transportationPipelineDeductionsCents: posts.transportation_pipeline_deductions_cents,
    gridTransmissionFeesCents: posts.grid_transmission_fees_cents,
    processingRefiningBaseFeesCents: posts.processing_refining_base_fees_cents,
  });

  // A NEGATIVE NET — the deduction legs exceeded the gross sales.
  // Recorded visible (the held row's truth); the money pauses, never
  // drops, never guesses into a route.
  const held = realization.netRealizedResourcePoolCents < 0;

  const sourceEventId = energyRowEventId(
    "realization",
    `${parcelId}:${wellMeterId}:${gpuClusterHash}`,
    `${period}:${currency}`,
  );
  // The pre-recompute position of record — the delta's before leg (a
  // first-touch tuple's before is 0; a re-priced tuple's is the net
  // this pass is about to replace).
  const prior = await store.getEnergyNetRealizationApplication(sourceEventId);

  await store.upsertEnergyNetRealizationApplication({
    source_event_id: sourceEventId,
    parcel_id: parcelId,
    well_meter_id: wellMeterId,
    gpu_cluster_hash: gpuClusterHash,
    period,
    currency,
    gross_energy_sales_cents: posts.gross_energy_sales_cents,
    gross_mineral_sales_cents: posts.gross_mineral_sales_cents,
    transportation_pipeline_deductions_cents: posts.transportation_pipeline_deductions_cents,
    grid_transmission_fees_cents: posts.grid_transmission_fees_cents,
    processing_refining_base_fees_cents: posts.processing_refining_base_fees_cents,
    net_realized_resource_pool_cents: realization.netRealizedResourcePoolCents,
    verdict: held ? "held_negative_net" : "posted",
  });
  counts.realizationsWritten += 1;
  const poolKey = `${parcelId}:${wellMeterId}:${gpuClusterHash}:${period}:${currency}`;
  const poolEntry = poolOfRecord.get(poolKey);
  if (poolEntry === undefined) {
    poolOfRecord.set(poolKey, {
      before: prior?.net_realized_resource_pool_cents ?? 0,
      after: realization.netRealizedResourcePoolCents,
    });
  } else {
    poolEntry.after = realization.netRealizedResourcePoolCents;
  }
  if (held) {
    counts.realizationsHeldNegativeNet += 1;
  }
}

// ---------------------------------------------------------------------------
// Sender 1 — SCADA smart meter utility logs: the gross post, the
// realization recompute, the parcel's tiered royalty walk, the
// acreage-ratio division, and the deed-transfer statutory interest
// accruals.
// ---------------------------------------------------------------------------

async function walkEnergyMeterSales(
  store: Store,
  detail: EnergyScadaMeterSalesDetail,
  counts: EnergyWriteCounts,
  poolOfRecord: Map<string, { before: number; after: number }>,
): Promise<void> {
  if (!isEnergyPeriod(detail.period)) {
    throw new Error(`energy_invalid_period:${detail.period}`);
  }
  const sourceEventId = energyRowEventId("meter_sales", detail.senderRowId, detail.period);

  // The replay guard's read — a re-shipped sheet is a counted no-op (the
  // UNIQUE constraint is the concurrent backstop behind this read).
  const existingPost = await store.getEnergyMeterSalesPost(sourceEventId);
  if (existingPost !== undefined) {
    counts.rowsReplayed += 1;
    return;
  }

  await store.insertEnergyMeterSalesPost({
    source_event_id: sourceEventId,
    parcel_id: detail.parcelId,
    well_meter_id: detail.wellMeterId,
    gpu_cluster_hash: detail.gpuClusterHash,
    period: detail.period,
    currency: detail.currency,
    gross_energy_sales_cents: detail.grossEnergySalesCents,
    gross_mineral_sales_cents: detail.grossMineralSalesCents,
  });

  await recomputeEnergyRealization(
    store,
    detail.parcelId,
    detail.wellMeterId,
    detail.gpuClusterHash,
    detail.period,
    detail.currency,
    counts,
    poolOfRecord,
  );

  await walkParcelRoyaltyAndDivision(store, detail, counts);
}

// ---------------------------------------------------------------------------
// The parcel's tiered royalty walk and the acreage division: the row's
// gross revenue crosses the parcel's cumulative position; each band's
// bps prices the marginal basis; the royalty pot divides across the
// deeded fractional heirs by surveyed acreage ratios; the rerouted legs
// (deed transfers of record) accrue statutory interest at the transfer's
// rate. No policy, no royalty; no interests, no division — counted
// fail-closed skips either way.
// ---------------------------------------------------------------------------

async function walkParcelRoyaltyAndDivision(
  store: Store,
  detail: EnergyScadaMeterSalesDetail,
  counts: EnergyWriteCounts,
): Promise<void> {
  const revenueBasisCents = detail.grossEnergySalesCents + detail.grossMineralSalesCents;

  // The royalty policy of record — no policy, no royalty (the walk never
  // guesses a rate).
  const policy = await store.getEnergyParcelRoyaltyPolicy(detail.parcelId);
  if (policy === undefined) {
    counts.parcelRoyaltiesSkippedNoPolicy += 1;
    return;
  }

  // The policy of record re-validates at every read.
  let bands: ReturnType<typeof validateEnergyRoyaltyBands>;
  try {
    bands = validateEnergyRoyaltyBands(JSON.parse(policy.tier_bands) as readonly unknown[]);
  } catch {
    counts.parcelRoyaltiesSkippedNoPolicy += 1;
    return;
  }

  const position = await store.getEnergyParcelRoyaltyPosition(
    detail.parcelId,
    detail.period,
    detail.currency,
  );
  const cumulativeBeforeCents = position?.cumulative_revenue_cents ?? 0;
  const walk = energyRoyaltyTierWalk({
    royaltyBasisCents: revenueBasisCents,
    cumulativeBeforeCents,
    bands,
  });
  // The position advances BEFORE the division commits — the walk's
  // cumulative position is the period's of-record position (the
  // hardware SEP precedent; both passes are replay-guarded).
  await store.advanceEnergyParcelRoyaltyPosition(
    detail.parcelId,
    detail.period,
    detail.currency,
    revenueBasisCents,
    walk.royaltyCents,
  );
  counts.parcelRoyaltiesWritten += 1;
  counts.parcelRoyaltyCents += walk.royaltyCents;

  await walkParcelDivision(store, detail, walk.royaltyCents, counts);
}

async function walkParcelDivision(
  store: Store,
  detail: EnergyScadaMeterSalesDetail,
  royaltyPotCents: number,
  counts: EnergyWriteCounts,
): Promise<void> {
  // The deeded fractional heirs of record — no registered interests, no
  // division (the walk never guesses a routing).
  const interests = await store.listEnergyParcelOwnerInterests(detail.parcelId);
  if (interests.length === 0) {
    counts.divisionsSkippedNoInterests += 1;
    return;
  }

  const division = planParcelAcreageDivision({
    interests: interests.map((interest) => ({
      payeeId: interest.owner_payee_id,
      deededAcresMicros: interest.deeded_acres_micros,
    })),
    potCents: royaltyPotCents,
  });

  const divisionEventId = energyRowEventId(
    "division",
    detail.senderRowId,
    `${detail.period}:${detail.currency}`,
  );
  const allocatedTotalCents = division.reduce(
    (sum, leg) => sum + leg.allocated_cents,
    0,
  );
  await store.insertEnergyParcelDivisionApplication({
    source_event_id: divisionEventId,
    parcel_id: detail.parcelId,
    period: detail.period,
    currency: detail.currency,
    revenue_basis_cents: royaltyPotCents,
    division_legs: JSON.stringify(division),
    allocated_total_cents: allocatedTotalCents,
    owner_count: division.length,
  });
  counts.divisionsWritten += 1;
  counts.dividedCents += allocatedTotalCents;

  await walkStatutoryInterestReroute(store, detail, divisionEventId, division, counts);
}

// ---------------------------------------------------------------------------
// The statutory interest reroute: a division leg whose current title
// holder acquired it through a deed transfer of record accrues the
// transfer's statutory interest over the days the transfer predates the
// period's payable date (the period month's last day). A transfer
// recorded after the period end routes nothing yet — zero days, no
// accrual.
// ---------------------------------------------------------------------------

/** The days between the deed's recording date (UTC midnight) and the
 * period's payable date (the month's last day, UTC midnight), floored —
 * negative when the transfer postdates the period (clamped to zero by
 * the caller's skip). */
function lateDaysFromTransferToPeriod(
  recordedOn: string,
  period: string,
): number {
  const recordedMs = Date.parse(`${recordedOn}T00:00:00Z`);
  // The month's LAST day: Date.UTC's zero day of the next month index.
  const monthStart = new Date(Date.parse(`${period}-01T00:00:00Z`));
  const payableMs = Date.UTC(
    monthStart.getUTCFullYear(),
    monthStart.getUTCMonth() + 1,
    0,
  );
  return Math.floor((payableMs - recordedMs) / 86_400_000);
}

async function walkStatutoryInterestReroute(
  store: Store,
  detail: EnergyScadaMeterSalesDetail,
  divisionEventId: string,
  division: readonly { payee_id: string; allocated_cents: number }[],
  counts: EnergyWriteCounts,
): Promise<void> {
  const transfers: EnergyDeedTransferRecord[] =
    await store.listEnergyDeedTransfersForParcel(detail.parcelId);
  if (transfers.length === 0) {
    return;
  }

  for (const leg of division) {
    if (leg.allocated_cents <= 0) {
      continue;
    }
    for (const transfer of transfers) {
      if (transfer.to_payee_id !== leg.payee_id) {
        continue;
      }
      const lateDays = lateDaysFromTransferToPeriod(transfer.recorded_on, detail.period);
      if (lateDays <= 0) {
        continue;
      }
      const accrualEventId = energyRowEventId(
        "statutory_interest",
        transfer.deed_ref,
        divisionEventId,
      );
      const existing = await store.getEnergyStatutoryInterestApplication(accrualEventId);
      if (existing !== undefined) {
        continue;
      }
      const interest = statutoryInterestCents({
        baseCents: leg.allocated_cents,
        lateDays,
        rateBps: transfer.statutory_interest_bps,
      });
      await store.insertEnergyStatutoryInterestApplication({
        source_event_id: accrualEventId,
        parcel_id: detail.parcelId,
        deed_ref: transfer.deed_ref,
        period: detail.period,
        currency: detail.currency,
        base_cents: leg.allocated_cents,
        late_days: lateDays,
        statutory_interest_bps: transfer.statutory_interest_bps,
        interest_cents: interest,
      });
      counts.statutoryInterestAccrualsWritten += 1;
      counts.statutoryInterestAccruedCents += interest;
    }
  }
}

// ---------------------------------------------------------------------------
// Sender 2 — pipeline flow-meter volume feeds: the deduction post and the
// realization recompute.
// ---------------------------------------------------------------------------

async function walkEnergyPipelineDeduction(
  store: Store,
  detail: EnergyPipelineFlowMeterDetail,
  counts: EnergyWriteCounts,
  poolOfRecord: Map<string, { before: number; after: number }>,
): Promise<void> {
  if (!isEnergyPeriod(detail.period)) {
    throw new Error(`energy_invalid_period:${detail.period}`);
  }
  const sourceEventId = energyRowEventId("pipeline_deduction", detail.senderRowId, detail.period);

  const existingPost = await store.getEnergyPipelineDeductionPost(sourceEventId);
  if (existingPost !== undefined) {
    counts.rowsReplayed += 1;
    return;
  }

  await store.insertEnergyPipelineDeductionPost({
    source_event_id: sourceEventId,
    parcel_id: detail.parcelId,
    well_meter_id: detail.wellMeterId,
    gpu_cluster_hash: detail.gpuClusterHash,
    period: detail.period,
    currency: detail.currency,
    transportation_pipeline_deductions_cents: detail.transportationPipelineDeductionsCents,
    grid_transmission_fees_cents: detail.gridTransmissionFeesCents,
    processing_refining_base_fees_cents: detail.processingRefiningBaseFeesCents,
  });

  await recomputeEnergyRealization(
    store,
    detail.parcelId,
    detail.wellMeterId,
    detail.gpuClusterHash,
    detail.period,
    detail.currency,
    counts,
    poolOfRecord,
  );
}

// ---------------------------------------------------------------------------
// Sender 3 — GPU data center utilization metrics: the utilization post,
// the cluster's tiered yield walk, and the telemetry-weighted grid split
// (the cascade trigger's calculation of record, staged at journal_id
// null for the posting pass).
// ---------------------------------------------------------------------------

async function walkEnergyGpuUtilization(
  store: Store,
  detail: EnergyGpuUtilizationDetail,
  counts: EnergyWriteCounts,
): Promise<void> {
  if (!isEnergyPeriod(detail.period)) {
    throw new Error(`energy_invalid_period:${detail.period}`);
  }
  const sourceEventId = energyRowEventId("gpu_utilization", detail.senderRowId, detail.period);

  const existingPost = await store.getEnergyGpuUtilizationPost(sourceEventId);
  if (existingPost !== undefined) {
    counts.rowsReplayed += 1;
    return;
  }

  await store.insertEnergyGpuUtilizationPost({
    source_event_id: sourceEventId,
    gpu_cluster_hash: detail.gpuClusterHash,
    period: detail.period,
    currency: detail.currency,
    compute_hours_micros: detail.computeHoursMicros,
    power_draw_kw_micros: detail.powerDrawKwMicros,
    compute_revenue_cents: detail.computeRevenueCents,
  });

  await walkGpuYieldRoyalty(store, detail, counts);
  await walkComputeGridSplit(store, detail, counts);
}

async function walkGpuYieldRoyalty(
  store: Store,
  detail: EnergyGpuUtilizationDetail,
  counts: EnergyWriteCounts,
): Promise<void> {
  // The yield policy of record — no policy, no royalty.
  const policy = await store.getEnergyComputeYieldPolicy(detail.gpuClusterHash);
  if (policy === undefined) {
    counts.gpuYieldsSkippedNoPolicy += 1;
    return;
  }

  let bands: ReturnType<typeof validateEnergyRoyaltyBands>;
  try {
    bands = validateEnergyRoyaltyBands(JSON.parse(policy.tier_bands) as readonly unknown[]);
  } catch {
    counts.gpuYieldsSkippedNoPolicy += 1;
    return;
  }

  const position = await store.getEnergyComputeYieldPosition(
    detail.gpuClusterHash,
    detail.period,
    detail.currency,
  );
  const cumulativeBeforeCents = position?.cumulative_compute_revenue_cents ?? 0;
  const walk = energyRoyaltyTierWalk({
    royaltyBasisCents: detail.computeRevenueCents,
    cumulativeBeforeCents,
    bands,
  });
  await store.advanceEnergyComputeYieldPosition(
    detail.gpuClusterHash,
    detail.period,
    detail.currency,
    detail.computeRevenueCents,
    walk.royaltyCents,
  );
  counts.gpuYieldsWritten += 1;
  counts.gpuYieldCents += walk.royaltyCents;
}

async function walkComputeGridSplit(
  store: Store,
  detail: EnergyGpuUtilizationDetail,
  counts: EnergyWriteCounts,
): Promise<void> {
  // The registered participants of record — no registrations, no split
  // (the walk never guesses a weighting).
  const registrations = await store.listEnergyGridParticipants(detail.gpuClusterHash);
  if (registrations.length === 0) {
    counts.gridSplitsSkippedNoParticipants += 1;
    return;
  }

  const split = planComputeGridSplit({
    participants: registrations.map((registration) => ({
      payeeId: registration.participant_payee_id,
      participantClass: registration.participant_class,
      weightMicros: registration.weight_micros,
    })),
    telemetry: {
      computeHoursMicros: detail.computeHoursMicros,
      powerDrawKwMicros: detail.powerDrawKwMicros,
    },
    revenueCents: detail.computeRevenueCents,
  });

  await store.insertEnergyComputeGridSplitApplication({
    source_event_id: energyRowEventId(
      "grid_split",
      detail.senderRowId,
      `${detail.period}:${detail.currency}`,
    ),
    gpu_cluster_hash: detail.gpuClusterHash,
    period: detail.period,
    currency: detail.currency,
    compute_revenue_cents: detail.computeRevenueCents,
    split_legs: JSON.stringify(split.legs),
    allocated_total_cents: split.allocatedTotalCents,
    journal_id: null,
  });
  counts.gridSplitsWritten += 1;
  counts.gridSplitCents += split.allocatedTotalCents;
}

// ---------------------------------------------------------------------------
// Sender 4 — carbon offset registry mints: the per-tonne micro-royalty to
// the conservation trust and the project developer at the policy of
// record.
// ---------------------------------------------------------------------------

async function walkEnergyCarbonOffset(
  store: Store,
  detail: EnergyCarbonOffsetMintDetail,
  counts: EnergyWriteCounts,
): Promise<void> {
  if (!isEnergyPeriod(detail.period)) {
    throw new Error(`energy_invalid_period:${detail.period}`);
  }
  const sourceEventId = energyRowEventId("carbon_payout", detail.senderRowId, detail.period);

  // The replay guard's read — a re-shipped mint is a counted no-op.
  const existing = await store.getEnergyCarbonOffsetPayoutApplication(sourceEventId);
  if (existing !== undefined) {
    counts.rowsReplayed += 1;
    return;
  }

  // The offset policy of record — no policy, no payout (the walk never
  // guesses a per-tonne rate or a trust split).
  const policy = await store.getEnergyCarbonOffsetPolicy(detail.parcelId);
  if (policy === undefined) {
    counts.carbonPayoutsSkippedNoPolicy += 1;
    return;
  }

  const payout = carbonOffsetPayoutCents({
    tonnesVerifiedMicros: detail.tonnesVerifiedMicros,
    microsPerTonne: policy.micros_per_tonne,
    trustShareBps: policy.trust_share_bps,
  });

  await store.insertEnergyCarbonOffsetPayoutApplication({
    source_event_id: sourceEventId,
    parcel_id: detail.parcelId,
    registry_ref: detail.registryRef,
    period: detail.period,
    currency: detail.currency,
    tonnes_verified_micros: detail.tonnesVerifiedMicros,
    micros_per_tonne: policy.micros_per_tonne,
    trust_share_bps: policy.trust_share_bps,
    trust_payee_id: policy.trust_payee_id,
    trust_payout_cents: payout.trustCents,
    developer_payee_id: policy.developer_payee_id,
    developer_payout_cents: payout.developerCents,
    total_payout_cents: payout.potCents,
  });
  counts.carbonPayoutsWritten += 1;
  counts.carbonPayoutTotalCents += payout.potCents;
}
