
/**
 * The sports lane's pure-math engine (PR 50, the founder sports
 * directive) — no store, no I/O: the Net Venue Realization identity
 * (gross ticket revenue minus facility surcharges minus municipal taxes
 * minus insurance reserves minus payment processor fee cuts equals the
 * Net Gate Pool), the turnstile-to-receipt reconciliation verdicts, the
 * perpetual secondary resale royalty splits, the league-wide pool
 * distribution's market-size balance offsets, salary cap thresholds, and
 * performance incentives, the collective group licensing union and
 * athlete wallet routing, the NIL deal waterfall classification, and
 * the biometric micro-payout math.
 *
 * MONEY is integer cents; QUANTITIES are statement micros. Every bps
 * division floors exactly (BigInt — the product overflows Number); the
 * floor remainder conserves into a designated leg so no cent is ever
 * minted or burned. Event ids are content-derived (`sports:` namespace,
 * the energy precedent) so a re-shipped sheet replays as a counted
 * no-op while two senders' rows stay distinct.
 */

import type {
  SportsGateReconciliationVerdict,
  SportsLeaguePoolLeg,
  SportsLeagueTeamRegistrationRecord,
  SportsRealizationVerdict,
  SportsUnionCode,
} from "../../modules/sports/records";

// ---------------------------------------------------------------------------
// Exact-cent primitives.
// ---------------------------------------------------------------------------

/** floor(pot × bps / 10000) — BigInt exact; the bps floor primitive. */
export function sportsBpsShareCents(potCents: number, bps: number): number {
  if (!Number.isInteger(potCents) || potCents < 0) {
    throw new Error(`sports_bps_share_invalid_pot:${potCents}`);
  }
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
    throw new Error(`sports_bps_share_invalid_bps:${bps}`);
  }
  return Number((BigInt(potCents) * BigInt(bps)) / 10_000n);
}

/** One cent of remainder routed one at a time through the caller's
 * ranked candidate list — the deterministic dust walk (the caller owns
 * the ranking; the helper never re-sorts). */
function distributeRemainderCents(
  remainder: number,
  candidates: string[],
  legs: Map<string, number>,
): void {
  for (let i = 0; i < remainder; i += 1) {
    const key = candidates[i % candidates.length];
    legs.set(key, (legs.get(key) ?? 0) + 1);
  }
}

// ---------------------------------------------------------------------------
// THE NET VENUE REALIZATION — the founder's exact identity.
// ---------------------------------------------------------------------------

/** The realization's five money legs, in founder-column order. */
export interface SportsGateMoneyLegs {
  grossTicketRevenueCents: number;
  facilitySurchargesCents: number;
  municipalTaxesCents: number;
  insuranceReservesCents: number;
  processorFeeCutsCents: number;
}

/**
 * THE FOUNDER'S IDENTITY, exact to the cent: gross ticket revenue minus
 * facility surcharges minus municipal taxes minus insurance reserves
 * minus payment processor fee cuts equals the Net Gate Pool. No bps, no
 * proration — pure subtraction, so the DDL pins the same identity.
 */
export function netVenueRealizationCents(
  legs: SportsGateMoneyLegs,
): { netGatePoolCents: number; verdict: SportsRealizationVerdict } {
  const fields = [
    legs.grossTicketRevenueCents,
    legs.facilitySurchargesCents,
    legs.municipalTaxesCents,
    legs.insuranceReservesCents,
    legs.processorFeeCutsCents,
  ];
  for (const value of fields) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`sports_realization_invalid_leg:${value}`);
    }
  }
  const netGatePoolCents =
    legs.grossTicketRevenueCents -
    legs.facilitySurchargesCents -
    legs.municipalTaxesCents -
    legs.insuranceReservesCents -
    legs.processorFeeCutsCents;
  return {
    netGatePoolCents,
    // A loss-making gate (deductions exceed gross) holds visible, the
    // energy realization precedent — never a silent negative post.
    verdict:
      netGatePoolCents >= 0
        ? ("posted" as const)
        : ("held_negative_net" as const),
  };
}

// ---------------------------------------------------------------------------
// Turnstile-to-receipt reconciliation.
// ---------------------------------------------------------------------------

/**
 * The gate reconciliation's verdict: the venue's scan counts reconcile
 * against the gross ticket receipts BEFORE gate realization. Equal
 * positive counts reconcile; any delta — orphan scans or unscanned
 * tickets — flags the variance with the signed delta of record; an
 * empty scope (nothing posted yet) is unreconciled, never silently
 * clean.
 */
export function gateReconciliationVerdict(
  ticketCountSum: number,
  scanCountSum: number,
): {
  verdict: SportsGateReconciliationVerdict;
  varianceScanDelta: number;
} {
  if (
    !Number.isInteger(ticketCountSum) ||
    ticketCountSum < 0 ||
    !Number.isInteger(scanCountSum) ||
    scanCountSum < 0
  ) {
    throw new Error(
      `sports_gate_reconciliation_invalid_counts:${ticketCountSum}:${scanCountSum}`,
    );
  }
  const varianceScanDelta = scanCountSum - ticketCountSum;
  if (ticketCountSum === 0 && scanCountSum === 0) {
    return { verdict: "unreconciled", varianceScanDelta };
  }
  return {
    verdict:
      varianceScanDelta === 0
        ? ("reconciled" as const)
        : ("variance_flagged" as const),
    varianceScanDelta,
  };
}

// ---------------------------------------------------------------------------
// Perpetual secondary resale royalties — the founder 5–10% band.
// ---------------------------------------------------------------------------

/** The resale royalty policy's split shape (the registry's bps legs). */
export interface SportsResaleRoyaltySplitPolicy {
  resale_royalty_bps: number;
  promoter_share_bps: number;
  venue_share_bps: number;
  league_share_bps: number;
}

/**
 * The resale royalty cut: floor(gross × royalty bps / 10000) — the
 * founder band, 500–1000 bps (5–10%) — split across promoter, venue,
 * and league rights holders. The promoter and venue legs floor; the
 * league leg absorbs the remainder, conserving the pot exactly.
 */
export function planResaleRoyaltySplit(
  resaleGrossCents: number,
  policy: SportsResaleRoyaltySplitPolicy,
): {
  royaltyPotCents: number;
  promoterLegCents: number;
  venueLegCents: number;
  leagueLegCents: number;
} {
  if (!Number.isInteger(resaleGrossCents) || resaleGrossCents < 0) {
    throw new Error(`sports_resale_invalid_gross:${resaleGrossCents}`);
  }
  const royaltyPotCents = sportsBpsShareCents(
    resaleGrossCents,
    policy.resale_royalty_bps,
  );
  const promoterLegCents = sportsBpsShareCents(
    royaltyPotCents,
    policy.promoter_share_bps,
  );
  const venueLegCents = sportsBpsShareCents(
    royaltyPotCents,
    policy.venue_share_bps,
  );
  const leagueLegCents = royaltyPotCents - promoterLegCents - venueLegCents;
  return { royaltyPotCents, promoterLegCents, venueLegCents, leagueLegCents };
}

// ---------------------------------------------------------------------------
// The league-wide pool distribution — market-size balance offsets,
// salary cap thresholds, and performance incentives.
// ---------------------------------------------------------------------------

/**
 * The league pool's three-way split policy (equal, market balance,
 * performance incentive — conserves to 10000).
 */
export interface SportsLeaguePoolSplitPolicy {
  equal_share_bps: number;
  market_balance_bps: number;
  performance_incentive_bps: number;
}

/**
 * The league-wide pool distribution walk:
 *
 *   pool ─┬─ equal slice     (policy bps)      → equal cents per team,
 *         │                                     the floor remainder one
 *         │                                     cent at a time in
 *         │                                     team-code order
 *         ├─ market slice    (policy bps)      → proportional to market
 *         │                                     size; teams OVER the
 *         │                                     salary cap threshold are
 *         │                                     excluded (the cap
 *         │                                     offset)
 *         └─ incentive slice (exact remainder) → proportional to the
 *                                               teams' performance
 *                                               incentive bps
 *
 * Every slice floors; undistributable slices (no eligible weights) ride
 * dust_cents — pool = Σ legs + dust conserves exactly.
 */
export function planLeaguePoolDistribution(
  poolCents: number,
  policy: SportsLeaguePoolSplitPolicy,
  teams: Pick<
    SportsLeagueTeamRegistrationRecord,
    | "team_code"
    | "owner_payee_id"
    | "owner_payee_name"
    | "market_size_micros"
    | "payroll_micros"
    | "cap_threshold_micros"
    | "performance_incentive_bps"
  >[],
): { legs: SportsLeaguePoolLeg[]; distributedCents: number; dustCents: number } {
  if (!Number.isInteger(poolCents) || poolCents < 0) {
    throw new Error(`sports_pool_invalid_pool:${poolCents}`);
  }
  if (
    policy.equal_share_bps < 0 ||
    policy.market_balance_bps < 0 ||
    policy.performance_incentive_bps < 0 ||
    policy.equal_share_bps +
      policy.market_balance_bps +
      policy.performance_incentive_bps !==
      10_000
  ) {
    throw new Error(
      `sports_pool_invalid_policy:${policy.equal_share_bps}:${policy.market_balance_bps}:${policy.performance_incentive_bps}`,
    );
  }
  if (teams.length === 0) {
    throw new Error("sports_pool_no_teams");
  }
  const byCode = new Map<string, SportsLeaguePoolLeg>();
  for (const team of teams) {
    if (byCode.has(team.team_code)) {
      throw new Error(`sports_pool_duplicate_team:${team.team_code}`);
    }
    byCode.set(team.team_code, {
      team_code: team.team_code,
      owner_payee_id: team.owner_payee_id,
      owner_payee_name: team.owner_payee_name,
      equal_share_cents: 0,
      market_balance_cents: 0,
      cap_floor_cents: 0,
      performance_incentive_cents: 0,
      total_cents: 0,
    });
  }

  // THE EQUAL SLICE — the untouchable base, shared flat.
  const equalSlice = sportsBpsShareCents(poolCents, policy.equal_share_bps);
  const perTeamFloor = Math.floor(equalSlice / teams.length);
  const equalRemainder = equalSlice - perTeamFloor * teams.length;
  const equalLegs = new Map<string, number>();
  for (const leg of byCode.values()) {
    equalLegs.set(leg.team_code, perTeamFloor);
  }
  distributeRemainderCents(
    equalRemainder,
    teams.map((team) => team.team_code).sort(),
    equalLegs,
  );

  // THE MARKET SLICE — the market-size balance offset. Teams over the
  // league salary cap threshold take none of it (the cap offset); the
  // slice splits proportionally to the eligible teams' market sizes.
  const marketSlice = sportsBpsShareCents(
    poolCents,
    policy.market_balance_bps,
  );
  const underCap = teams.filter(
    (team) => team.payroll_micros <= team.cap_threshold_micros,
  );
  const marketWeightSum = underCap.reduce(
    (sum, team) => sum + team.market_size_micros,
    0,
  );
  const marketLegs = new Map<string, number>();
  if (marketWeightSum > 0) {
    const marketFloors = new Map<string, number>();
    for (const team of underCap) {
      marketFloors.set(
        team.team_code,
        Math.floor(
          (marketSlice * team.market_size_micros) / marketWeightSum,
        ),
      );
    }
    let distributed = 0;
    for (const value of marketFloors.values()) {
      distributed += value;
    }
    const marketRemainder = marketSlice - distributed;
    if (marketRemainder > 0) {
      // One cent at a time to the largest eligible market, then the
      // next — lexicographic among ties (deterministic).
      const ranked = [...underCap]
        .sort(
          (a, b) =>
            b.market_size_micros - a.market_size_micros ||
            (a.team_code < b.team_code ? -1 : 1),
        )
        .map((team) => team.team_code);
      distributeRemainderCents(marketRemainder, ranked, marketFloors);
    }
    for (const [code, cents] of marketFloors) {
      marketLegs.set(code, cents);
    }
  }

  // THE INCENTIVE SLICE — the exact remainder, weighted by each team's
  // performance incentive bps (the directive's third offset).
  const incentiveSlice = poolCents - equalSlice - marketSlice;
  const incentiveWeightSum = teams.reduce(
    (sum, team) => sum + team.performance_incentive_bps,
    0,
  );
  const incentiveLegs = new Map<string, number>();
  if (incentiveWeightSum > 0) {
    const incentiveFloors = new Map<string, number>();
    for (const team of teams) {
      incentiveFloors.set(
        team.team_code,
        Math.floor(
          (incentiveSlice * team.performance_incentive_bps) /
            incentiveWeightSum,
        ),
      );
    }
    let distributed = 0;
    for (const value of incentiveFloors.values()) {
      distributed += value;
    }
    const incentiveRemainder = incentiveSlice - distributed;
    if (incentiveRemainder > 0) {
      const ranked = [...teams]
        .sort(
          (a, b) =>
            b.performance_incentive_bps - a.performance_incentive_bps ||
            (a.team_code < b.team_code ? -1 : 1),
        )
        .map((team) => team.team_code);
      distributeRemainderCents(incentiveRemainder, ranked, incentiveFloors);
    }
    for (const [code, cents] of incentiveFloors) {
      incentiveLegs.set(code, cents);
    }
  }

  // Assemble conservatively — dust is whatever no leg could take.
  let distributedCents = 0;
  for (const leg of byCode.values()) {
    leg.equal_share_cents = equalLegs.get(leg.team_code) ?? 0;
    leg.market_balance_cents = marketLegs.get(leg.team_code) ?? 0;
    leg.cap_floor_cents = 0;
    leg.performance_incentive_cents = incentiveLegs.get(leg.team_code) ?? 0;
    leg.total_cents =
      leg.equal_share_cents +
      leg.market_balance_cents +
      leg.cap_floor_cents +
      leg.performance_incentive_cents;
    distributedCents += leg.total_cents;
  }
  const dustCents = poolCents - distributedCents;
  return {
    legs: [...byCode.values()].sort((a, b) =>
      a.team_code < b.team_code ? -1 : 1,
    ),
    distributedCents,
    dustCents,
  };
}

// ---------------------------------------------------------------------------
// The collective athlete group licensing engine.
// ---------------------------------------------------------------------------

/** The union ledger's payee id of record for a union code — the
 * sentinel ledger identity (the resource escrow payee precedent). */
export function unionLedgerPayeeId(
  unionCode: Exclude<SportsUnionCode, "none">,
): string {
  return `union_ledger:${unionCode}`;
}

/**
 * The group licensing split: floor(pool × union share / 10000) routes
 * to the union's players-association ledger; the athlete pool (the
 * exact remainder) splits equally across the roster's digital wallets,
 * the floor remainder one cent at a time in athlete-GLAN order — the
 * NIL group split's equal-division precedent.
 */
export function planGroupLicensingSplit(
  royaltyPoolCents: number,
  unionShareBps: number,
  roster: { athlete_glan: string; wallet_payee_id: string }[],
): {
  unionLegCents: number;
  athletePoolCents: number;
  wallets: {
    athlete_glan: string;
    wallet_payee_id: string;
    wallet_cents: number;
  }[];
} {
  if (!Number.isInteger(royaltyPoolCents) || royaltyPoolCents < 0) {
    throw new Error(`sports_group_licensing_invalid_pool:${royaltyPoolCents}`);
  }
  if (
    !Number.isInteger(unionShareBps) ||
    unionShareBps <= 0 ||
    unionShareBps >= 10_000
  ) {
    throw new Error(
      `sports_group_licensing_invalid_union_share:${unionShareBps}`,
    );
  }
  if (roster.length === 0) {
    throw new Error("sports_group_licensing_empty_roster");
  }
  const unionLegCents = sportsBpsShareCents(royaltyPoolCents, unionShareBps);
  const athletePoolCents = royaltyPoolCents - unionLegCents;
  const perWalletFloor = Math.floor(athletePoolCents / roster.length);
  const remainder = athletePoolCents - perWalletFloor * roster.length;
  const wallets = roster
    .map((entry) => ({
      athlete_glan: entry.athlete_glan,
      wallet_payee_id: entry.wallet_payee_id,
      wallet_cents: perWalletFloor,
    }))
    .sort((a, b) => (a.athlete_glan < b.athlete_glan ? -1 : 1));
  for (let i = 0; i < remainder; i += 1) {
    wallets[i % wallets.length].wallet_cents += 1;
  }
  return { unionLegCents, athletePoolCents, wallets };
}

// ---------------------------------------------------------------------------
// The NIL deal waterfall classification.
// ---------------------------------------------------------------------------

/**
 * The NIL lane's deal-application event ids carry their sender in the
 * second segment (`nil:{sender}:{hash}` — nilRowEventId's durable,
 * versioned scheme). The brand sender records the corporate endorsement
 * deals; the collective sender records the booster collective payouts;
 * the fan-club subscription leg stays at zero until a fan-club sender
 * exists (the NIL lane has none — inventing one would be scope
 * invention).
 */
export function nilDealClassLegs(sourceEventId: string): {
  endorsementDealCents: number;
  boosterCollectiveCents: number;
  fanClubSubscriptionCents: number;
} {
  const segments = sourceEventId.split(":");
  const sender = segments.length >= 2 ? segments[1] : "";
  if (sender === "brand") {
    return {
      endorsementDealCents: 1,
      boosterCollectiveCents: 0,
      fanClubSubscriptionCents: 0,
    };
  }
  if (sender === "collective") {
    return {
      endorsementDealCents: 0,
      boosterCollectiveCents: 1,
      fanClubSubscriptionCents: 0,
    };
  }
  return {
    endorsementDealCents: 0,
    boosterCollectiveCents: 0,
    fanClubSubscriptionCents: 1,
  };
}

// ---------------------------------------------------------------------------
// Biometric performance telemetry micro-royalties.
// ---------------------------------------------------------------------------

/**
 * The micro-payout pot: floor(quantity micros × micros per unit /
 * 10^14) — the carbon precedent's exact BigInt identity (a quantity in
 * micros times a money-micro rate lands in cents through 10^14).
 */
export function biometricMicroPayoutCents(
  licensedQuantityMicros: number,
  microsPerUnit: number,
): number {
  if (
    !Number.isInteger(licensedQuantityMicros) ||
    licensedQuantityMicros < 0
  ) {
    throw new Error(
      `sports_biometric_invalid_quantity:${licensedQuantityMicros}`,
    );
  }
  if (!Number.isInteger(microsPerUnit) || microsPerUnit < 0) {
    throw new Error(`sports_biometric_invalid_rate:${microsPerUnit}`);
  }
  return Number(
    (BigInt(licensedQuantityMicros) * BigInt(microsPerUnit)) /
      100_000_000_000_000n,
  );
}

/**
 * The payout split: the athlete's digital wallet takes floor(pot ×
 * athlete share / 10000); the league data-rights holder takes the exact
 * remainder — the pot conserves exactly.
 */
export function planBiometricPayoutSplit(
  payoutPotCents: number,
  athleteShareBps: number,
): { athleteLegCents: number; leagueLegCents: number } {
  const athleteLegCents = sportsBpsShareCents(payoutPotCents, athleteShareBps);
  return {
    athleteLegCents,
    leagueLegCents: payoutPotCents - athleteLegCents,
  };
}

// ---------------------------------------------------------------------------
// The event-id derivations (the `sports:` ledger namespace).
// ---------------------------------------------------------------------------

/** The content-derived event id for the sports lane's rows and
 * positions — identity fields only, never money (the fingerprint
 * discipline). */
export function sportsRowEventId(
  kind:
    | "ticket_sale"
    | "resale_sale"
    | "turnstile_scan"
    | "biometric_telemetry"
    | "gate_reconciliation"
    | "net_gate_realization"
    | "resale_royalty"
    | "group_licensing"
    | "league_pool"
    | "nil_deal_reconciliation"
    | "biometric_payout",
  senderRowId: string,
  suffix?: string,
): string {
  return `sports:${kind}:${senderRowId}${suffix === undefined ? "" : `:${suffix}`}`;
}

/** The gate reconciliation's position event id — one per venue scope. */
export function gateReconciliationEventId(
  venueGln: string,
  period: string,
  currency: string,
): string {
  return sportsRowEventId(
    "gate_reconciliation",
    `${venueGln}:${period}:${currency}`,
  );
}

/** The Net Gate Pool realization's position event id — one per founder
 * five-column identity tuple. */
export function netVenueRealizationEventId(detail: {
  nilContractId: string;
  athleteGlan: string;
  venueGln: string;
  leagueRightsCode: string;
  turnstileScanHash: string;
  period: string;
  currency: string;
}): string {
  return sportsRowEventId(
    "net_gate_realization",
    [
      detail.nilContractId,
      detail.athleteGlan,
      detail.venueGln,
      detail.leagueRightsCode,
      detail.turnstileScanHash,
      detail.period,
      detail.currency,
    ].join(":"),
  );
}

/** The league pool distribution's position event id. */
export function leaguePoolEventId(
  leagueRightsCode: string,
  period: string,
  currency: string,
): string {
  return sportsRowEventId(
    "league_pool",
    `${leagueRightsCode}:${period}:${currency}`,
  );
}

/** The NIL deal reconciliation's position event id. */
export function nilDealReconciliationEventId(
  nilContractId: string,
  athleteGlan: string,
  period: string,
): string {
  return sportsRowEventId(
    "nil_deal_reconciliation",
    `${nilContractId}:${athleteGlan}:${period}`,
  );
}
