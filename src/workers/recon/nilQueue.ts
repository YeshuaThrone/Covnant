/**
 * CVT recon worker — the NIL lane's store-touching pass (PR 34, the founder
 * NIL compliance + roster waterfall directive). The math and identity
 * spaces live in nil.ts and the profiles in nilProfiles.ts; THIS module is
 * the only place the lane touches the store — the same discipline as
 * licensingQueue.ts.
 *
 * House rules, restated as the module's contract:
 * - FAIL-CLOSED — a deal the lane cannot fully verify records a HELD
 *   verdict (visible, never dropped, never posted); a pool without a
 *   program of record or a waterfall of record is a counted skip — the
 *   walk never guesses a rate or invents a schedule.
 * - REPLAY GUARDS — every application is UNIQUE per content-derived
 *   source_event_id (nilRowEventId): a re-shipped sheet replays as a
 *   counted no-op; two senders' sheets for the same deal stay distinct
 *   identities.
 * - ENFORCEMENT BEFORE EXECUTION — the walk's verdict records the
 *   compliance parser's outcome; the LIVE states (the audit row, the cap
 *   verification, the gate states) are what the payout-execution seam
 *   re-reads fail-closed, so an operator heal (the audit's flagged →
 *   nil_cleared upsert, a cap verification landing) proceeds the money
 *   without rewriting the walk's record.
 *
 * The four senders' walks:
 *
 *   1. BRAND ENDORSEMENTS (sender 'brand') — the deal payout walk: the
 *      $600 valid business purpose audit flags (held until the mandatory
 *      compliance metadata matches nil_cleared), the state matrix check,
 *      the agency commission deduction at payout, then the verdict-gated
 *      payout application.
 *   2. COLLECTIVE DISCLOSURES (sender 'collective') — the same deal walk
 *      plus THE ASSOCIATED ENTITY HOLDBACK: collective/booster-backed
 *      funds verify against the school's institutional cap allowance and
 *      its verification of record before any 'paid' verdict (a 'direct'
 *      funding source skips the cap check).
 *   3. SCHOOL REVENUE-SHARE POOLS (sender 'school') — THE ADJUSTED
 *      CALCULATOR: the program of record's Title IX reserve and admin fee
 *      bps net the gross pool to the Net Athlete Share Pool, and the
 *      roster waterfall of record (keyed per scope + pool type — the
 *      lane's convention) walks the tiers; the application pins BOTH
 *      conservation identities (title_ix + fee + net = gross, roster +
 *      dust = net).
 *   4. MEDIA RIGHTS DISTRIBUTIONS (sender 'media') — THE GROUP NIL EQUAL
 *      SPLIT: team-wide video game / apparel / media license revenue
 *      divides equally across the participating roster (floor per member,
 *      dust sweeps), the split conserved in the application row.
 *
 * NIL rows NEVER enter match_queue and NEVER touch the music split
 * machinery — the store applications are this lane's money of record.
 */

import type { Store } from "@/lib/server/store";
import type { NilCapVerificationRecord, NilRosterTierSpec } from "@/modules/nil/records";
import { requiresValidBusinessPurposeAudit, validateNilTierSchedule } from "@/modules/nil/records";
import type { NilLineDetail, ParsedStatementLine } from "./records";
import {
  equalGroupSplitCents,
  isAssociatedEntityFunding,
  isValidNilDealFee,
  netAthleteSharePoolCents,
  nilAgencyFeeCents,
  nilMicrosToCents,
  nilRowEventId,
  nilStateRuleCodeForCategory,
  rosterWalkCents,
  type NilDealCategory,
} from "./nil";

/** The NIL lane's per-pass counters — the honest outcome summary. */
export interface NilWriteCounts {
  /** Deal payout applications committed / counted replay no-ops. */
  dealsWritten: number;
  dealsReplayed: number;
  /** The two held verdict families (the money pauses, visible). */
  dealsHeldCompliance: number;
  dealsHeldStateRule: number;
  /** The $600 flags raised / audits read as nil_cleared this pass. */
  auditsFlagged: number;
  auditsCleared: number;
  /** Pool walks committed / replayed / fail-closed skips. */
  poolWalksWritten: number;
  poolWalksReplayed: number;
  poolWalksSkippedNoProgram: number;
  poolWalksSkippedNoWaterfall: number;
  /** Group equal splits committed / counted replay no-ops. */
  groupSplitsWritten: number;
  groupSplitsReplayed: number;
  /** Payout gate states upserted across the pass. */
  gateStatesUpserted: number;
  /** The committed money, integer cents. */
  dealGrossCents: number;
  agencyFeesCents: number;
  netPayoutCents: number;
  netAthleteSharePoolCents: number;
  rosterPaidCents: number;
  dustCents: number;
}

/**
 * The NIL lane's one pass over a parsed statement's lines — deal walks,
 * pool walks, and group splits land in the store's NIL tables. Throws
 * into the job's fail-closed error path on any store failure.
 */
export async function writeNilRowsToStore(
  store: Store,
  lines: readonly ParsedStatementLine[],
): Promise<NilWriteCounts> {
  const counts: NilWriteCounts = {
    dealsWritten: 0,
    dealsReplayed: 0,
    dealsHeldCompliance: 0,
    dealsHeldStateRule: 0,
    auditsFlagged: 0,
    auditsCleared: 0,
    poolWalksWritten: 0,
    poolWalksReplayed: 0,
    poolWalksSkippedNoProgram: 0,
    poolWalksSkippedNoWaterfall: 0,
    groupSplitsWritten: 0,
    groupSplitsReplayed: 0,
    gateStatesUpserted: 0,
    dealGrossCents: 0,
    agencyFeesCents: 0,
    netPayoutCents: 0,
    netAthleteSharePoolCents: 0,
    rosterPaidCents: 0,
    dustCents: 0,
  };

  for (const line of lines) {
    const detail = line.nilDetail;
    // The NIL profiles always attach the detail; a line without one is a
    // lane bug — refuse, never silently skip.
    if (detail === undefined || detail === null) {
      throw new Error(`nil_detail_missing: line ${line.lineNumber} has no NIL detail`);
    }

    if (detail.sender === "school") {
      await walkSchoolPool(store, line, detail, counts);
      continue;
    }
    if (detail.sender === "media") {
      await writeGroupSplit(store, line, detail, counts);
      continue;
    }
    await writeDealPayout(store, line, detail, counts);
  }

  return counts;
}

// ---------------------------------------------------------------------------
// Senders 1 + 2 — the deal payout walk (brand endorsements and collective
// disclosures): the compliance parser's flag, the state matrix, the
// associated-entity holdback, the agency commission, the verdict.
// ---------------------------------------------------------------------------

async function writeDealPayout(
  store: Store,
  line: ParsedStatementLine,
  detail: NilLineDetail,
  counts: NilWriteCounts,
): Promise<void> {
  const sourceEventId = nilRowEventId({
    sender: detail.sender,
    athleteId: detail.athleteId,
    schoolId: detail.schoolId,
    period: detail.period,
    senderRowId: detail.senderRowId,
  });

  // The replay guard's read — a re-shipped sheet is a counted no-op (the
  // UNIQUE constraint is the concurrent backstop behind this read).
  const existing = await store.getNilPayoutApplication(sourceEventId);
  if (existing !== undefined) {
    counts.dealsReplayed += 1;
    return;
  }

  const grossCents = nilMicrosToCents(line.grossMicros);
  const schoolId = detail.schoolId ?? "";
  const athleteId = detail.athleteId ?? "";
  const capYear = detail.period.slice(0, 4);
  const fundingSource = detail.fundingSource ?? "direct";

  // THE VALID BUSINESS PURPOSE AUDIT — deals at or above $600 flag for
  // mandatory compliance metadata matching; the audit row's CURRENT state
  // governs (an operator's metadata match heals 'flagged' → 'nil_cleared'
  // through the same table; the walk never regresses it).
  let auditState: "flagged" | "nil_cleared" | null = null;
  if (requiresValidBusinessPurposeAudit(grossCents)) {
    const existingAudit = await store.getNilDealComplianceAudit(detail.nilContractId);
    if (existingAudit === undefined) {
      const audit = await store.upsertNilDealComplianceAudit({
        nil_contract_id: detail.nilContractId,
        athlete_id: athleteId,
        school_id: schoolId,
        deal_value_cents: grossCents,
        business_purpose_state: "flagged",
        purpose_description: null,
        evidence_ref: null,
        cleared_by: null,
      });
      auditState = audit.business_purpose_state;
      counts.auditsFlagged += 1;
    } else {
      auditState = existingAudit.business_purpose_state;
      if (auditState === "nil_cleared") counts.auditsCleared += 1;
    }
  }
  const complianceClear = auditState === null || auditState === "nil_cleared";

  // THE HIGH SCHOOL STATE COMPLIANCE MATRIX — enforced BEFORE execution:
  // 'prohibited' blocks; 'conditional' blocks without the rule satisfied
  // in the audit trail (the sheets carry no satisfaction columns); an
  // ABSENT rule or state code reads fail-closed as unverified. Only an
  // explicit 'permitted' rule of record pays through.
  let stateRuleRef: string | null = null;
  if (detail.stateJurisdictionCode === null || detail.stateJurisdictionCode === "") {
    stateRuleRef = "state_jurisdiction_unverified";
  } else {
    const ruleCode = nilStateRuleCodeForCategory(detail.dealCategory as NilDealCategory);
    const rule = await store.getNilStateRule(detail.stateJurisdictionCode, ruleCode);
    if (rule === undefined || rule.enforcement !== "permitted") {
      stateRuleRef = rule?.rule_code ?? ruleCode;
    }
  }
  const stateClear = stateRuleRef === null;

  // THE ASSOCIATED ENTITY HOLDBACK — collective/booster-backed funds
  // verify against the school's institutional cap allowance AND its
  // verification of record (fail-closed: no cap row, no verification, or
  // a committed total that would exceed the allowance all hold). A
  // 'direct' deal skips the cap check.
  let capVerification: NilCapVerificationRecord | undefined;
  if (isAssociatedEntityFunding(fundingSource)) {
    if (detail.schoolId !== null && detail.schoolId !== "") {
      const cap = await store.getNilSchoolCap(detail.schoolId, capYear);
      if (cap !== undefined) {
        const verification = await store.getNilCapVerification(detail.schoolId, capYear);
        if (
          verification !== undefined &&
          verification.verified_committed_cents + grossCents <= cap.annual_cap_cents
        ) {
          capVerification = verification;
        }
      }
    }
  }
  const capClear = !isAssociatedEntityFunding(fundingSource) || capVerification !== undefined;

  // THE AGENCY COMMISSION DEDUCTION — at payout, per the founder's bands
  // (the parse validated the pair; this re-pins it, belt-and-braces).
  if (!isValidNilDealFee(detail.agencyMode, detail.agencyBps)) {
    throw new Error(
      `nil_agency_fee_out_of_band: ${detail.senderRowId} ${detail.agencyMode} ${detail.agencyBps}bps`,
    );
  }
  const agencyFeeCents = nilAgencyFeeCents(grossCents, detail.agencyBps);
  const netPayoutCents = grossCents - agencyFeeCents;

  const verdict = !complianceClear
    ? ("held_compliance" as const)
    : !stateClear
      ? ("held_state_rule" as const)
      : !capClear
        ? ("held_compliance" as const)
        : ("paid" as const);

  await store.insertNilPayoutApplication({
    nil_contract_id: detail.nilContractId,
    athlete_id: athleteId,
    school_id: schoolId,
    source_event_id: sourceEventId,
    period: detail.period,
    gross_cents: grossCents,
    agency_mode: detail.agencyMode,
    agency_bps: detail.agencyBps,
    agency_fee_cents: agencyFeeCents,
    net_payout_cents: netPayoutCents,
    verdict,
    state_rule_ref: stateRuleRef,
    cap_verified_ref: capVerification?.id ?? null,
  });
  counts.dealsWritten += 1;
  if (verdict === "held_compliance") counts.dealsHeldCompliance += 1;
  if (verdict === "held_state_rule") counts.dealsHeldStateRule += 1;
  counts.dealGrossCents += grossCents;
  counts.agencyFeesCents += agencyFeeCents;
  counts.netPayoutCents += netPayoutCents;

  // THE PAYOUT GATE'S LIVE STATES — upserted for every walked row (the
  // payout-execution seam reads these fail-closed; a verification heals
  // 'unknown' through THIS upsert on the next walk).
  await store.upsertNilPayoutGateState({
    payee_id: athleteId,
    school_id: schoolId,
    nil_clearance_state: complianceClear ? "nil_cleared" : "unknown",
    compliance_state: "unknown",
    title_ix_state: "unknown",
    collective_or_booster_backed:
      detail.fundingSource === null ? null : isAssociatedEntityFunding(detail.fundingSource),
    institutional_cap_state: capClear ? "verified" : "unknown",
    evidence_ref: capVerification?.evidence_ref ?? null,
    verified_by: capVerification?.verified_by ?? null,
  });
  counts.gateStatesUpserted += 1;
}

// ---------------------------------------------------------------------------
// Sender 3 — the school pool walk: THE ADJUSTED DIRECT REVENUE SHARING
// CALCULATOR plus the tiered roster waterfall, both programs of record.
// ---------------------------------------------------------------------------

async function walkSchoolPool(
  store: Store,
  line: ParsedStatementLine,
  detail: NilLineDetail,
  counts: NilWriteCounts,
): Promise<void> {
  const schoolId = detail.schoolId ?? "";
  const scopeKey = `school:${schoolId}`;
  const poolType = detail.poolType ?? "media_rights";
  const sourceEventId = nilRowEventId({
    sender: detail.sender,
    athleteId: null,
    schoolId: detail.schoolId,
    period: detail.period,
    senderRowId: detail.senderRowId,
  });

  // The replay guard's read — a re-shipped pool is a counted no-op.
  const existing = await store.getNilPoolApplication(sourceEventId);
  if (existing !== undefined) {
    counts.poolWalksReplayed += 1;
    return;
  }

  // FAIL-CLOSED #1 — no program of record, no rates: the walk refuses
  // (counted, visible), it never guesses the Title IX reserve or the
  // admin fee.
  const program = await store.getNilRevenueShareProgram(scopeKey);
  if (program === undefined) {
    counts.poolWalksSkippedNoProgram += 1;
    return;
  }

  // FAIL-CLOSED #2 — no waterfall of record: no schedule, no walk. The
  // lane's convention keys the waterfall per (scope, pool type).
  const waterfallKey = poolType;
  const waterfall = await store.getNilRosterWaterfall(scopeKey, waterfallKey);
  if (waterfall === undefined) {
    counts.poolWalksSkippedNoWaterfall += 1;
    return;
  }

  // The gross pool through THE ADJUSTED CALCULATOR — exact to the cent
  // (deductions price off the GROSS; the net is the subtraction).
  const pool = netAthleteSharePoolCents({
    grossPoolCents: nilMicrosToCents(line.grossMicros),
    titleIxReserveBps: program.title_ix_reserve_bps,
    adminFeeBps: program.admin_fee_bps,
  });

  // THE TIERED ROSTER WALK — the waterfall's schedule (validated at
  // registration, re-validated at read) prices the NET pool; the walk's
  // identities conserve.
  const tiers = parseTiers(waterfall.tiers, waterfall.scope_key, waterfall.waterfall_key);
  const walk = rosterWalkCents(pool.netAthleteSharePoolCents, tiers);

  await store.insertNilPoolApplication({
    school_id: schoolId,
    pool_type: poolType,
    source_event_id: sourceEventId,
    period: detail.period,
    gross_pool_cents: pool.grossPoolCents,
    title_ix_reserve_bps: program.title_ix_reserve_bps,
    title_ix_reserve_cents: pool.titleIxReserveCents,
    admin_fee_bps: program.admin_fee_bps,
    admin_fee_cents: pool.adminFeeCents,
    net_athlete_share_pool_cents: pool.netAthleteSharePoolCents,
    waterfall_key: waterfallKey,
    tier_kind: waterfall.kind,
    slices: JSON.stringify(walk.allocations),
    roster_paid_cents: walk.rosterPaidCents,
    dust_cents: walk.dustCents,
  });
  counts.poolWalksWritten += 1;
  counts.netAthleteSharePoolCents += pool.netAthleteSharePoolCents;
  counts.rosterPaidCents += walk.rosterPaidCents;
  counts.dustCents += walk.dustCents;
}

/** Re-validates the stored schedule at walk time — a corrupt or mutated
 * schedule is a fail-closed refusal, never a guessed walk. */
function parseTiers(
  tiersJson: string,
  scopeKey: string,
  waterfallKey: string,
): readonly NilRosterTierSpec[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(tiersJson);
  } catch (error) {
    throw new Error(
      `nil_waterfall_tiers_corrupt: ${scopeKey}:${waterfallKey} schedule is not valid JSON`,
      { cause: error },
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`nil_waterfall_tiers_invalid: ${scopeKey}:${waterfallKey} — not an array`);
  }
  for (const tier of parsed) {
    if (typeof tier !== "object" || tier === null) {
      throw new Error(`nil_waterfall_tiers_invalid: ${scopeKey}:${waterfallKey} — non-object tier`);
    }
    const candidate = tier as { tier_key?: unknown };
    if (typeof candidate.tier_key !== "string") {
      throw new Error(
        `nil_waterfall_tiers_invalid: ${scopeKey}:${waterfallKey} — tier_key_not_a_string`,
      );
    }
  }
  const tiers = parsed as NilRosterTierSpec[];
  const outcome = validateNilTierSchedule(tiers);
  if (!outcome.ok) {
    throw new Error(
      `nil_waterfall_tiers_invalid: ${scopeKey}:${waterfallKey} — ${outcome.reason}`,
    );
  }
  return tiers;
}

// ---------------------------------------------------------------------------
// Sender 4 — the group NIL equal split: team-wide license revenue divides
// equally across the participating roster.
// ---------------------------------------------------------------------------

async function writeGroupSplit(
  store: Store,
  line: ParsedStatementLine,
  detail: NilLineDetail,
  counts: NilWriteCounts,
): Promise<void> {
  const sourceEventId = nilRowEventId({
    sender: detail.sender,
    athleteId: null,
    schoolId: detail.schoolId,
    period: detail.period,
    senderRowId: detail.senderRowId,
  });

  // The replay guard's read — a re-shipped distribution splits once.
  const existing = await store.getNilGroupSplit(sourceEventId);
  if (existing !== undefined) {
    counts.groupSplitsReplayed += 1;
    return;
  }

  const totalCents = nilMicrosToCents(line.grossMicros);
  const participantIds = (detail.participantIds ?? "")
    .split(";")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);

  // THE EQUAL SPLIT — floor per member, the residue sweeps to dust; the
  // conservation identity (per × count + dust = total) pins the row.
  const split = equalGroupSplitCents(totalCents, participantIds);

  await store.insertNilGroupSplit({
    scope_ref: detail.schoolId ?? detail.nilContractId,
    rights_stream: detail.rightsStream ?? "media",
    source_event_id: sourceEventId,
    period: detail.period,
    total_cents: totalCents,
    participant_ids: JSON.stringify(participantIds),
    participant_count: participantIds.length,
    per_participant_cents: split.perParticipantCents,
    dust_cents: split.dustCents,
  });
  counts.groupSplitsWritten += 1;
  counts.rosterPaidCents += split.perParticipantCents * participantIds.length;
  counts.dustCents += split.dustCents;
}
