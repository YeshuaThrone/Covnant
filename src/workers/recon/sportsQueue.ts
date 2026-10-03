/**
 * CVT recon worker — the sports lane's store-touching pass (PR 50, the
 * founder sports directive). The math and identity spaces live in
 * sports.ts, the profiles in sportsProfiles.ts; THIS module is the only
 * place the lane touches the store — the same discipline as
 * energyQueue.ts and the other lanes' queue modules.
 *
 * House rules, restated as the module's contract:
 * - FAIL-CLOSED — a walk the lane cannot fully route records its honest
 *   outcome: a resale row without a royalty policy of record, a league
 *   pool without a pool policy or registered teams, a group-licensing
 *   roster with an unregistered athlete (or a union mismatch against a
 *   roster profile's association of record), and a biometric row
 *   without a payout policy (or an unregistered athlete) are counted
 *   skips — the walk never guesses a rate, a routing, or a wallet.
 * - REPLAY GUARDS — every post and application is UNIQUE per
 *   content-derived source_event_id (sportsRowEventId, the ledger
 *   namespace riding the sports prefix): a re-shipped sheet replays as
 *   a counted no-op, and a re-shipped row never re-triggers the
 *   reconciliation, the realization recompute, the pool redistribution,
 *   or the payout walks behind it.
 * - THE REALIZATION RECOMPUTES FROM THE POSTS — the Net Gate Pool of
 *   record is the founder identity recomputed in place from the
 *   settlement-post sums (the cross-license settlement precedent):
 *   every NEW post re-sums the key's legs and replaces the application
 *   of record. The reconciliation of record is recomputed FIRST (the
 *   directive: scans reconcile against receipts BEFORE gate
 *   realization) and rides the realization's audit columns; a
 *   variance-flagged reconciliation is the visible flag — the
 *   realization's own verdict answers only the negative-net hold.
 * - THE POOL RECOMPUTES FROM THE CONTRACTS — the league-wide
 *   distribution of record re-sums the posted broadcasting and
 *   merchandise contracts and replaces in place on every NEW contract
 *   post; the market-size balance offsets, the salary cap thresholds,
 *   and the performance incentives price the teams' legs.
 * - THE SPLITS CONSERVE — the resale royalty's three-way split, the
 *   group licensing's union-plus-wallets split, the biometric payout's
 *   two-way split, and the pool's team legs all pin to their basis
 *   (the engines' dust discipline).
 *
 * The eight senders' walks:
 *
 *   1–3. PRIMARY TICKETERS (senders 'ticketmaster', 'axs', 'seatgeek')
 *        — the settlement post, the gate reconciliation recompute, the
 *        Net Gate Pool realization recompute, and the NIL deal
 *        reconciliation recompute for the row's (nil contract, athlete,
 *        period) scope.
 *   4–5. SECONDARY MARKETPLACES (senders 'stubhub', 'vivid_seats') —
 *        the resale post and the 5–10% royalty's three-way routing to
 *        the promoter, venue, and league rights holders at the policy
 *        of record.
 *   6. VENUE TURNSTILE TELEMETRY (sender 'turnstile_telemetry') — the
 *      scan-batch post, the gate reconciliation recompute, and the
 *      re-realization of every ticket key the batch's hash reconciles.
 *   7. LEAGUE CONTRACTS (sender 'league_contracts') — the contract
 *      post; group classes walk the union ledger and the athlete
 *      wallets, pool classes recompute the league-wide distribution.
 *   8. BIOMETRIC TRACKING (sender 'biometric_tracking') — the telemetry
 *      post and the per-license micro-payout to the athlete wallet and
 *      the league data-rights holder at the policy of record.
 *
 * Sports rows NEVER enter match_queue and NEVER touch the music split
 * machinery — the store applications are this lane's money of record.
 */

import type { Store } from "@/lib/server/store";
import type {
  SportsGateReconciliationRecord,
  SportsNilReconciliationVerdict,
} from "@/modules/sports/records";
import type {
  SportsBiometricTrackingDetail,
  SportsLeagueContractDetail,
  ParsedStatementLine,
  SportsResaleSaleDetail,
  SportsTicketSaleDetail,
  SportsTurnstileScanDetail,
} from "./records";
import {
  biometricMicroPayoutCents,
  gateReconciliationEventId,
  gateReconciliationVerdict,
  leaguePoolEventId,
  netVenueRealizationCents,
  netVenueRealizationEventId,
  nilDealClassLegs,
  nilDealReconciliationEventId,
  planBiometricPayoutSplit,
  planGroupLicensingSplit,
  planLeaguePoolDistribution,
  planResaleRoyaltySplit,
  sportsRowEventId,
  unionLedgerPayeeId,
} from "./sports";
import { isSportsPeriod } from "@/modules/sports/records";

/** The sports lane's per-pass counters — the honest outcome summary. */
export interface SportsWriteCounts {
  /** Gate reconciliations committed (the venue scopes recomputed). */
  gateReconciliationsWritten: number;
  /** Net Gate Pool realizations committed / the negative-net holds
   * (the money pauses, visible). */
  realizationsWritten: number;
  realizationsHeldNegativeNet: number;
  /** Sports rows replayed as counted no-ops by the replay guards (all
   * eight senders' re-shipped rows). */
  rowsReplayed: number;
  /** Resale royalty routings committed / fail-closed skips (no resale
   * royalty policy of record for the (venue, league) scope). */
  resaleRoyaltiesWritten: number;
  resaleRoyaltiesSkippedNoPolicy: number;
  /** League pool distributions committed / fail-closed skips (no pool
   * policy of record / no registered teams). */
  leaguePoolsWritten: number;
  leaguePoolsSkippedNoPolicy: number;
  leaguePoolsSkippedNoTeams: number;
  /** Group licensing routings committed / fail-closed skips (a roster
   * athlete with no profile of record / a union mismatch). */
  groupLicensingWritten: number;
  groupLicensingSkippedNoProfile: number;
  groupLicensingSkippedUnionMismatch: number;
  /** NIL deal reconciliations committed — including the unmatched and
   * ineligible verdicts (recorded visible, never dropped). */
  nilReconciliationsWritten: number;
  nilReconciliationsUnmatchedProfile: number;
  nilReconciliationsProfileIneligible: number;
  /** Biometric micro-payouts committed / fail-closed skips (no payout
   * policy of record / no athlete profile of record). */
  biometricPayoutsWritten: number;
  biometricPayoutsSkippedNoPolicy: number;
  biometricPayoutsSkippedNoProfile: number;
  /** The committed money, integer cents. The pool DELTA is what this
   * pass's realization recomputes moved the pool of record by (the
   * per-tuple after − before of record; negative when the deduction
   * legs claw gross back) — additive across jobs, never a double-count
   * of a tuple an earlier job already priced. */
  netGatePoolDeltaCents: number;
  resaleRoyaltyCents: number;
  leaguePoolDistributedCents: number;
  groupLicensingUnionCents: number;
  groupLicensingAthleteCents: number;
  biometricPayoutCents: number;
}

/**
 * The sports lane's one pass over a parsed statement's lines — the
 * application ledgers (gate reconciliations, Net Gate Pool
 * realizations, resale royalties, league pool distributions, group
 * licensing routings, NIL deal reconciliations, and biometric
 * micro-payouts) land in the store's sports tables. Throws into the
 * job's fail-closed error path on any store failure.
 */
export async function writeSportsRowsToStore(
  store: Store,
  lines: readonly ParsedStatementLine[],
): Promise<SportsWriteCounts> {
  const counts: SportsWriteCounts = {
    gateReconciliationsWritten: 0,
    realizationsWritten: 0,
    realizationsHeldNegativeNet: 0,
    rowsReplayed: 0,
    resaleRoyaltiesWritten: 0,
    resaleRoyaltiesSkippedNoPolicy: 0,
    leaguePoolsWritten: 0,
    leaguePoolsSkippedNoPolicy: 0,
    leaguePoolsSkippedNoTeams: 0,
    groupLicensingWritten: 0,
    groupLicensingSkippedNoProfile: 0,
    groupLicensingSkippedUnionMismatch: 0,
    nilReconciliationsWritten: 0,
    nilReconciliationsUnmatchedProfile: 0,
    nilReconciliationsProfileIneligible: 0,
    biometricPayoutsWritten: 0,
    biometricPayoutsSkippedNoPolicy: 0,
    biometricPayoutsSkippedNoProfile: 0,
    netGatePoolDeltaCents: 0,
    resaleRoyaltyCents: 0,
    leaguePoolDistributedCents: 0,
    groupLicensingUnionCents: 0,
    groupLicensingAthleteCents: 0,
    biometricPayoutCents: 0,
  };
  // The pool delta's per-tuple tracking — the recompute REPLACES
  // positions in place, so the pass's pool summary is each DISTINCT
  // key's (before, after) of record and the counter totals after −
  // before (summing finals would double-count a tuple an earlier job
  // already priced into its own pass summary).
  const poolOfRecord = new Map<string, { before: number; after: number }>();

  for (const line of lines) {
    const detail = line.sportsDetail;
    // The sports profiles always attach the detail; a line without one
    // is a lane bug — refuse, never silently skip.
    if (detail === undefined || detail === null) {
      throw new Error(`sports_detail_missing: line ${line.lineNumber} has no sports detail`);
    }

    switch (detail.sender) {
      case "ticketmaster":
      case "axs":
      case "seatgeek":
        await walkSportsTicketSale(store, detail, counts, poolOfRecord);
        continue;
      case "stubhub":
      case "vivid_seats":
        await walkSportsResaleSale(store, detail, counts);
        continue;
      case "turnstile_telemetry":
        await walkSportsTurnstileScan(store, detail, counts, poolOfRecord);
        continue;
      case "league_contracts":
        await walkSportsLeagueContract(store, detail, counts);
        continue;
      case "biometric_tracking":
        await walkSportsBiometricTracking(store, detail, counts);
        continue;
    }
  }

  counts.netGatePoolDeltaCents = [...poolOfRecord.values()].reduce(
    (sum, delta) => sum + (delta.after - delta.before),
    0,
  );

  return counts;
}

// ---------------------------------------------------------------------------
// The gate reconciliation recompute — the venue scope's position of
// record, resummed from the posts and replaced in place on every NEW
// post (the directive: the scan counts reconcile against the gross
// ticket receipts BEFORE gate realization).
// ---------------------------------------------------------------------------

async function recomputeGateReconciliation(
  store: Store,
  venueGln: string,
  period: string,
  currency: string,
  counts: SportsWriteCounts,
): Promise<SportsGateReconciliationRecord> {
  const sides = await store.sumSportsGateReconciliationSides(venueGln, period, currency);
  const outcome = gateReconciliationVerdict(
    sides.ticket_count_sum,
    sides.scan_count_sum,
  );
  const sourceEventId = gateReconciliationEventId(venueGln, period, currency);
  const record = await store.upsertSportsGateReconciliation({
    source_event_id: sourceEventId,
    venue_gln: venueGln,
    period,
    currency,
    ticket_count_sum: sides.ticket_count_sum,
    scan_count_sum: sides.scan_count_sum,
    variance_scan_delta: outcome.varianceScanDelta,
    gross_ticket_revenue_cents: sides.gross_ticket_revenue_cents,
    verdict: outcome.verdict,
  });
  counts.gateReconciliationsWritten += 1;
  return record;
}

// ---------------------------------------------------------------------------
// The realization recompute — the founder tuple's position of record,
// resummed from the posts and replaced in place on every NEW post (the
// cross-license settlement precedent: the settlement of record carries
// the period's full sums once the sheets have shipped). The
// reconciliation of record rides the audit columns.
// ---------------------------------------------------------------------------

async function recomputeNetVenueRealization(
  store: Store,
  key: {
    nilContractId: string;
    athleteGlan: string;
    venueGln: string;
    leagueRightsCode: string;
    turnstileScanHash: string;
    period: string;
    currency: string;
  },
  counts: SportsWriteCounts,
  poolOfRecord: Map<string, { before: number; after: number }>,
): Promise<void> {
  const legs = await store.sumSportsGateLegs(
    key.nilContractId,
    key.athleteGlan,
    key.venueGln,
    key.leagueRightsCode,
    key.turnstileScanHash,
    key.period,
    key.currency,
  );

  // THE NET VENUE REALIZATION — the founder's exact identity: gross
  // ticket revenue minus facility surcharges minus municipal taxes
  // minus insurance reserves minus payment processor fee cuts.
  const realization = netVenueRealizationCents({
    grossTicketRevenueCents: legs.gross_ticket_revenue_cents,
    facilitySurchargesCents: legs.facility_surcharges_cents,
    municipalTaxesCents: legs.municipal_taxes_cents,
    insuranceReservesCents: legs.insurance_reserves_cents,
    processorFeeCutsCents: legs.processor_fee_cuts_cents,
  });

  // A NEGATIVE NET — the deduction legs exceeded the gross revenue.
  // Recorded visible (the held row's truth); the money pauses, never
  // drops, never guesses into a route.
  const held = realization.netGatePoolCents < 0;

  // The reconciliation of record for the venue scope — recomputed
  // BEFORE the realization (the directive's ordering), riding the
  // realization's audit columns.
  const reconciliation = await store.getSportsGateReconciliation(
    gateReconciliationEventId(key.venueGln, key.period, key.currency),
  );
  if (reconciliation === undefined) {
    throw new Error(
      `sports_realization_missing_reconciliation:${key.venueGln}:${key.period}`,
    );
  }

  const sourceEventId = netVenueRealizationEventId(key);
  // The pre-recompute position of record — the delta's before leg (a
  // first-touch tuple's before is 0; a re-priced tuple's is the net
  // this pass is about to replace).
  const prior = await store.getSportsNetVenueRealization(sourceEventId);

  await store.upsertSportsNetVenueRealization({
    source_event_id: sourceEventId,
    nil_contract_id: key.nilContractId,
    athlete_glan: key.athleteGlan,
    venue_gln: key.venueGln,
    league_rights_code: key.leagueRightsCode,
    turnstile_scan_hash: key.turnstileScanHash,
    period: key.period,
    currency: key.currency,
    gross_ticket_revenue_cents: legs.gross_ticket_revenue_cents,
    facility_surcharges_cents: legs.facility_surcharges_cents,
    municipal_taxes_cents: legs.municipal_taxes_cents,
    insurance_reserves_cents: legs.insurance_reserves_cents,
    processor_fee_cuts_cents: legs.processor_fee_cuts_cents,
    net_gate_pool_cents: realization.netGatePoolCents,
    gate_reconciliation_event_id: reconciliation.source_event_id,
    gate_reconciliation_verdict: reconciliation.verdict,
    verdict: held ? "held_negative_net" : "posted",
  });
  counts.realizationsWritten += 1;
  const poolKey = netVenueRealizationEventId(key);
  const poolEntry = poolOfRecord.get(poolKey);
  if (poolEntry === undefined) {
    poolOfRecord.set(poolKey, {
      before: prior?.net_gate_pool_cents ?? 0,
      after: realization.netGatePoolCents,
    });
  } else {
    poolEntry.after = realization.netGatePoolCents;
  }
  if (held) {
    counts.realizationsHeldNegativeNet += 1;
  }
}

// ---------------------------------------------------------------------------
// The NIL deal reconciliation recompute — the (nil contract, athlete,
// period) scope's position of record, resummed from the NIL lane's
// applications of record and replaced in place on every NEW ticket post
// naming the scope (the reconciliation reads the NIL lane's own
// applications — unmodified).
// ---------------------------------------------------------------------------

async function recomputeNilDealReconciliation(
  store: Store,
  nilContractId: string,
  athleteGlan: string,
  period: string,
  counts: SportsWriteCounts,
): Promise<void> {
  const legs = {
    endorsementDealCents: 0,
    boosterCollectiveCents: 0,
    fanClubSubscriptionCents: 0,
  };
  let verdict: SportsNilReconciliationVerdict = "reconciled";

  // The profile of record resolves through the NIL lane's athlete id —
  // an unregistered athlete reconciles as unmatched (visible, never
  // dropped); an ineligible one flags the profile.
  const profile = athleteGlan
    ? await store.getSportsStudentAthleteProfile(athleteGlan)
    : undefined;
  if (profile === undefined) {
    verdict = "unmatched_profile";
  } else if (!profile.eligible) {
    verdict = "profile_ineligible";
  } else {
    const applications = await store.listNilPayoutApplicationsForAthlete(
      profile.nil_athlete_id,
      period,
    );
    for (const application of applications) {
      // The NIL lane's deal applications classify by their durable
      // sender segment; the leg of record is the application's net
      // payout (the money that actually moved past the gates).
      const classification = nilDealClassLegs(application.source_event_id);
      if (classification.endorsementDealCents > 0) {
        legs.endorsementDealCents += application.net_payout_cents;
      } else if (classification.boosterCollectiveCents > 0) {
        legs.boosterCollectiveCents += application.net_payout_cents;
      } else {
        // The fan-club leg stays at zero until the NIL lane has a
        // fan-club sender — an application classifying as neither
        // brand nor collective is a lane bug, never a silent fold
        // into a leg.
        throw new Error(
          `sports_nil_unknown_sender:${application.source_event_id}`,
        );
      }
    }
  }

  const nilDealGrossCents =
    legs.endorsementDealCents +
    legs.boosterCollectiveCents +
    legs.fanClubSubscriptionCents;

  await store.upsertSportsNilDealReconciliation({
    source_event_id: nilDealReconciliationEventId(nilContractId, athleteGlan, period),
    nil_contract_id: nilContractId,
    athlete_glan: athleteGlan,
    period,
    endorsement_deal_cents: legs.endorsementDealCents,
    booster_collective_cents: legs.boosterCollectiveCents,
    fan_club_subscription_cents: legs.fanClubSubscriptionCents,
    nil_deal_gross_cents: nilDealGrossCents,
    verdict,
  });
  counts.nilReconciliationsWritten += 1;
  if (verdict === "unmatched_profile") counts.nilReconciliationsUnmatchedProfile += 1;
  if (verdict === "profile_ineligible") counts.nilReconciliationsProfileIneligible += 1;
}

// ---------------------------------------------------------------------------
// Senders 1–3 — the primary ticketers' settlement rows: the post, the
// gate reconciliation recompute, the realization recompute, and the NIL
// deal reconciliation recompute.
// ---------------------------------------------------------------------------

async function walkSportsTicketSale(
  store: Store,
  detail: SportsTicketSaleDetail,
  counts: SportsWriteCounts,
  poolOfRecord: Map<string, { before: number; after: number }>,
): Promise<void> {
  if (!isSportsPeriod(detail.period)) {
    throw new Error(`sports_invalid_period:${detail.period}`);
  }
  const sourceEventId = sportsRowEventId(
    "ticket_sale",
    `${detail.sender}:${detail.senderRowId}`,
    `${detail.period}:${detail.currency}`,
  );

  // The replay guard's read — a re-shipped sheet is a counted no-op (the
  // UNIQUE constraint is the concurrent backstop behind this read).
  const existingPost = await store.getSportsTicketSalePost(sourceEventId);
  if (existingPost !== undefined) {
    counts.rowsReplayed += 1;
    return;
  }

  await store.insertSportsTicketSalePost({
    source_event_id: sourceEventId,
    nil_contract_id: detail.nilContractId,
    athlete_glan: detail.athleteGlan,
    venue_gln: detail.venueGln,
    league_rights_code: detail.leagueRightsCode,
    turnstile_scan_hash: detail.turnstileScanHash,
    period: detail.period,
    currency: detail.currency,
    gross_ticket_revenue_cents: detail.grossTicketRevenueCents,
    facility_surcharges_cents: detail.facilitySurchargesCents,
    municipal_taxes_cents: detail.municipalTaxesCents,
    insurance_reserves_cents: detail.insuranceReservesCents,
    processor_fee_cuts_cents: detail.processorFeeCutsCents,
    ticket_count: detail.ticketCount,
  });

  // The reconciliation of record FIRST (the directive's ordering — the
  // scans reconcile against the receipts before the gate realizes).
  await recomputeGateReconciliation(
    store,
    detail.venueGln,
    detail.period,
    detail.currency,
    counts,
  );

  await recomputeNetVenueRealization(
    store,
    {
      nilContractId: detail.nilContractId,
      athleteGlan: detail.athleteGlan,
      venueGln: detail.venueGln,
      leagueRightsCode: detail.leagueRightsCode,
      turnstileScanHash: detail.turnstileScanHash,
      period: detail.period,
      currency: detail.currency,
    },
    counts,
    poolOfRecord,
  );

  // The NIL deal waterfall reconciliation for the row's scope — the
  // founder's directive ties the settlement's NIL contract to the
  // athlete's profile of record.
  await recomputeNilDealReconciliation(
    store,
    detail.nilContractId,
    detail.athleteGlan,
    detail.period,
    counts,
  );
}

// ---------------------------------------------------------------------------
// Senders 4–5 — the secondary marketplaces' resale rows: the post and
// the perpetual royalty's three-way routing at the policy of record.
// ---------------------------------------------------------------------------

async function walkSportsResaleSale(
  store: Store,
  detail: SportsResaleSaleDetail,
  counts: SportsWriteCounts,
): Promise<void> {
  if (!isSportsPeriod(detail.period)) {
    throw new Error(`sports_invalid_period:${detail.period}`);
  }
  const sourceEventId = sportsRowEventId(
    "resale_sale",
    `${detail.sender}:${detail.senderRowId}`,
    `${detail.period}:${detail.currency}`,
  );

  const existingPost = await store.getSportsResaleSalePost(sourceEventId);
  if (existingPost !== undefined) {
    counts.rowsReplayed += 1;
    return;
  }

  await store.insertSportsResaleSalePost({
    source_event_id: sourceEventId,
    venue_gln: detail.venueGln,
    league_rights_code: detail.leagueRightsCode,
    resale_gross_cents: detail.resaleGrossCents,
    period: detail.period,
    currency: detail.currency,
  });

  // The policy of record — fail closed without one (the walk never
  // guesses a rate or a routing).
  const policy = await store.getSportsResaleRoyaltyPolicy(
    detail.venueGln,
    detail.leagueRightsCode,
  );
  if (policy === undefined) {
    counts.resaleRoyaltiesSkippedNoPolicy += 1;
    return;
  }

  const split = planResaleRoyaltySplit(detail.resaleGrossCents, policy);
  await store.insertSportsResaleRoyaltyApplication({
    source_event_id: sportsRowEventId(
      "resale_royalty",
      `${detail.sender}:${detail.senderRowId}`,
      `${detail.period}:${detail.currency}`,
    ),
    resale_sale_event_id: sourceEventId,
    venue_gln: detail.venueGln,
    league_rights_code: detail.leagueRightsCode,
    resale_gross_cents: detail.resaleGrossCents,
    resale_royalty_bps: policy.resale_royalty_bps,
    promoter_share_bps: policy.promoter_share_bps,
    venue_share_bps: policy.venue_share_bps,
    league_share_bps: policy.league_share_bps,
    royalty_pot_cents: split.royaltyPotCents,
    promoter_leg_cents: split.promoterLegCents,
    venue_leg_cents: split.venueLegCents,
    league_leg_cents: split.leagueLegCents,
  });
  counts.resaleRoyaltiesWritten += 1;
  counts.resaleRoyaltyCents += split.royaltyPotCents;
}

// ---------------------------------------------------------------------------
// Sender 6 — the venue turnstile telemetry: the scan-batch post, the
// reconciliation recompute, and the re-realization of every ticket key
// the batch's hash reconciles (a late telemetry sheet re-prices the
// gates it covers).
// ---------------------------------------------------------------------------

async function walkSportsTurnstileScan(
  store: Store,
  detail: SportsTurnstileScanDetail,
  counts: SportsWriteCounts,
  poolOfRecord: Map<string, { before: number; after: number }>,
): Promise<void> {
  if (!isSportsPeriod(detail.period)) {
    throw new Error(`sports_invalid_period:${detail.period}`);
  }
  const sourceEventId = sportsRowEventId(
    "turnstile_scan",
    `${detail.venueGln}:${detail.senderRowId}`,
    `${detail.period}:${detail.currency}`,
  );

  const existingPost = await store.getSportsTurnstileScanPost(sourceEventId);
  if (existingPost !== undefined) {
    counts.rowsReplayed += 1;
    return;
  }

  await store.insertSportsTurnstileScanPost({
    source_event_id: sourceEventId,
    venue_gln: detail.venueGln,
    turnstile_scan_hash: detail.turnstileScanHash,
    scan_count: detail.scanCount,
    period: detail.period,
    currency: detail.currency,
  });

  await recomputeGateReconciliation(
    store,
    detail.venueGln,
    detail.period,
    detail.currency,
    counts,
  );

  // The re-realization of every ticket key the hash covers — each key's
  // realization of record re-rides the refreshed reconciliation.
  const keys = await store.listSportsTicketSaleKeysForHash(
    detail.venueGln,
    detail.turnstileScanHash,
  );
  for (const key of keys) {
    await recomputeNetVenueRealization(
      store,
      {
        nilContractId: key.nil_contract_id,
        athleteGlan: key.athlete_glan,
        venueGln: key.venue_gln,
        leagueRightsCode: key.league_rights_code,
        turnstileScanHash: key.turnstile_scan_hash,
        period: key.period,
        currency: key.currency,
      },
      counts,
      poolOfRecord,
    );
  }
}

// ---------------------------------------------------------------------------
// Sender 7 — the league contracts: the contract post; the group classes
// walk the union ledger and the athlete wallets, the pool classes
// recompute the league-wide distribution.
// ---------------------------------------------------------------------------

async function walkSportsLeagueContract(
  store: Store,
  detail: SportsLeagueContractDetail,
  counts: SportsWriteCounts,
): Promise<void> {
  if (!isSportsPeriod(detail.period)) {
    throw new Error(`sports_invalid_period:${detail.period}`);
  }
  // The contract_ref is the contract table's replay key (UNIQUE per
  // backend) — a re-shipped contract replays as a counted no-op.
  const existingPost = await store.getSportsBroadcastingContract(detail.senderRowId);
  if (existingPost !== undefined) {
    counts.rowsReplayed += 1;
    return;
  }

  await store.insertSportsBroadcastingContract({
    contract_ref: detail.senderRowId,
    league_rights_code: detail.leagueRightsCode,
    contract_class: detail.contractClass,
    contract_gross_cents: detail.contractGrossCents,
    royalty_pool_cents: detail.royaltyPoolCents,
    union_code: detail.unionCode,
    union_share_bps: detail.unionShareBps,
    athlete_roster_json: detail.athleteRosterJson,
    period: detail.period,
    currency: detail.currency,
  });

  const isGroupClass =
    detail.contractClass === "group_licensing_video_games" ||
    detail.contractClass === "group_licensing_trading_cards" ||
    detail.contractClass === "group_licensing_apparel";

  if (isGroupClass) {
    await walkSportsGroupLicensing(store, detail, counts);
    return;
  }

  await walkSportsLeaguePool(store, detail, counts);
}

/** The collective athlete group licensing engine's walk — the union
 * ledger's leg and the roster wallets' equal split, fail-closed on any
 * unregistered athlete or union mismatch. */
async function walkSportsGroupLicensing(
  store: Store,
  detail: SportsLeagueContractDetail,
  counts: SportsWriteCounts,
): Promise<void> {
  if (detail.unionCode === "none") {
    // The profiles' vocabulary gate already rejects this shape; the
    // queue re-check is the store path's own guard.
    throw new Error(`sports_group_licensing_no_union:${detail.senderRowId}`);
  }
  const roster = JSON.parse(detail.athleteRosterJson) as string[];
  const walletEntries: { athlete_glan: string; wallet_payee_id: string }[] = [];
  for (const athleteGlan of roster) {
    const profile = await store.getSportsStudentAthleteProfile(athleteGlan);
    if (profile === undefined) {
      counts.groupLicensingSkippedNoProfile += 1;
      return;
    }
    // The roster's union of record must match the contract's — routing
    // NFLPA money to an NBAPA ledger (or a wallet) is a misroute the
    // walk refuses, never guesses through.
    if (profile.union_code !== detail.unionCode) {
      counts.groupLicensingSkippedUnionMismatch += 1;
      return;
    }
    walletEntries.push({
      athlete_glan: athleteGlan,
      wallet_payee_id: profile.wallet_payee_id,
    });
  }

  const split = planGroupLicensingSplit(
    detail.royaltyPoolCents,
    detail.unionShareBps,
    walletEntries,
  );
  await store.insertSportsGroupLicensingApplication({
    source_event_id: sportsRowEventId(
      "group_licensing",
      detail.senderRowId,
      `${detail.period}:${detail.currency}`,
    ),
    contract_ref: detail.senderRowId,
    league_rights_code: detail.leagueRightsCode,
    union_code: detail.unionCode,
    union_payee_id: unionLedgerPayeeId(detail.unionCode),
    union_share_bps: detail.unionShareBps,
    royalty_pool_cents: detail.royaltyPoolCents,
    union_leg_cents: split.unionLegCents,
    athlete_pool_cents: split.athletePoolCents,
    athlete_wallets_json: JSON.stringify(split.wallets),
    wallet_count: split.wallets.length,
  });
  counts.groupLicensingWritten += 1;
  counts.groupLicensingUnionCents += split.unionLegCents;
  counts.groupLicensingAthleteCents += split.athletePoolCents;
}

/** The league-wide pool waterfall's walk — the Σ-contract pool
 * distributed across the registered team owners at the policy of
 * record, recomputed in place per league scope. */
async function walkSportsLeaguePool(
  store: Store,
  detail: SportsLeagueContractDetail,
  counts: SportsWriteCounts,
): Promise<void> {
  const policy = await store.getSportsLeaguePoolPolicy(detail.leagueRightsCode);
  if (policy === undefined) {
    counts.leaguePoolsSkippedNoPolicy += 1;
    return;
  }
  const teams = await store.listSportsLeagueTeams(detail.leagueRightsCode);
  if (teams.length === 0) {
    counts.leaguePoolsSkippedNoTeams += 1;
    return;
  }

  // THE LEAGUE-WIDE POOL — the Σ broadcasting + merchandise contract
  // gross for the scope, resummed from the posts of record (the
  // realization recompute's precedent: the distribution of record
  // carries the scope's full sums once the sheets have shipped).
  const poolCents = await store.sumSportsLeaguePoolContractGross(
    detail.leagueRightsCode,
    detail.period,
    detail.currency,
  );

  const distribution = planLeaguePoolDistribution(
    poolCents,
    {
      equal_share_bps: policy.equal_share_bps,
      market_balance_bps: policy.market_balance_bps,
      performance_incentive_bps: policy.performance_incentive_bps,
    },
    teams,
  );

  const prior = await store.getSportsLeaguePoolDistribution(
    leaguePoolEventId(detail.leagueRightsCode, detail.period, detail.currency),
  );
  await store.upsertSportsLeaguePoolDistribution({
    source_event_id: leaguePoolEventId(
      detail.leagueRightsCode,
      detail.period,
      detail.currency,
    ),
    league_rights_code: detail.leagueRightsCode,
    period: detail.period,
    currency: detail.currency,
    pool_cents: poolCents,
    equal_share_bps: policy.equal_share_bps,
    market_balance_bps: policy.market_balance_bps,
    performance_incentive_bps: policy.performance_incentive_bps,
    legs_json: JSON.stringify(distribution.legs),
    distributed_cents: distribution.distributedCents,
    dust_cents: distribution.dustCents,
  });
  // The delta of record — the recompute replaces the position in
  // place, so the pass's summary is after − before per scope touched
  // (the energy precedent).
  counts.leaguePoolDistributedCents += Math.max(
    0,
    distribution.distributedCents - (prior?.distributed_cents ?? 0),
  );
  counts.leaguePoolsWritten += 1;
}

// ---------------------------------------------------------------------------
// Sender 8 — the biometric tracking feeds: the telemetry post and the
// per-license micro-payout at the policy of record.
// ---------------------------------------------------------------------------

async function walkSportsBiometricTracking(
  store: Store,
  detail: SportsBiometricTrackingDetail,
  counts: SportsWriteCounts,
): Promise<void> {
  if (!isSportsPeriod(detail.period)) {
    throw new Error(`sports_invalid_period:${detail.period}`);
  }
  const sourceEventId = sportsRowEventId(
    "biometric_telemetry",
    `${detail.leagueRightsCode}:${detail.senderRowId}`,
    `${detail.period}:${detail.currency}`,
  );

  const existingPost = await store.getSportsBiometricTrackingPost(sourceEventId);
  if (existingPost !== undefined) {
    counts.rowsReplayed += 1;
    return;
  }

  await store.insertSportsBiometricTrackingPost({
    source_event_id: sourceEventId,
    athlete_glan: detail.athleteGlan,
    league_rights_code: detail.leagueRightsCode,
    tracking_modality: detail.trackingModality,
    licensee_class: detail.licenseeClass,
    licensed_quantity_micros: detail.licensedQuantityMicros,
    period: detail.period,
    currency: detail.currency,
  });

  // The policy of record — fail closed without one.
  const policy = await store.getSportsBiometricRoyaltyPolicy(
    detail.leagueRightsCode,
    detail.licenseeClass,
  );
  if (policy === undefined) {
    counts.biometricPayoutsSkippedNoPolicy += 1;
    return;
  }

  // The athlete's wallet of record — fail closed without a profile.
  const profile = await store.getSportsStudentAthleteProfile(detail.athleteGlan);
  if (profile === undefined) {
    counts.biometricPayoutsSkippedNoProfile += 1;
    return;
  }

  const payoutPotCents = biometricMicroPayoutCents(
    detail.licensedQuantityMicros,
    policy.micros_per_unit,
  );
  const split = planBiometricPayoutSplit(payoutPotCents, policy.athlete_share_bps);
  await store.insertSportsBiometricMicroPayoutApplication({
    source_event_id: sportsRowEventId(
      "biometric_payout",
      `${detail.leagueRightsCode}:${detail.senderRowId}`,
      `${detail.period}:${detail.currency}`,
    ),
    biometric_post_event_id: sourceEventId,
    athlete_glan: detail.athleteGlan,
    league_rights_code: detail.leagueRightsCode,
    tracking_modality: detail.trackingModality,
    licensee_class: detail.licenseeClass,
    licensed_quantity_micros: detail.licensedQuantityMicros,
    micros_per_unit: policy.micros_per_unit,
    athlete_share_bps: policy.athlete_share_bps,
    payout_pot_cents: payoutPotCents,
    athlete_wallet_payee_id: profile.wallet_payee_id,
    athlete_leg_cents: split.athleteLegCents,
    league_data_payee_id: policy.league_data_payee_id,
    league_leg_cents: split.leagueLegCents,
  });
  counts.biometricPayoutsWritten += 1;
  counts.biometricPayoutCents += payoutPotCents;
}
