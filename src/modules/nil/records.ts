/**
 * The NIL revenue-share record vocabulary (PR 34, migration 0038) — the
 * founder directive's durable facts of record:
 *
 *   nil_revenue_share_programs  — the adjusted direct revenue-sharing
 *                                 program config per school or collective
 *                                 scope (the Title IX reserve and school
 *                                 administrative fee rates of record).
 *   nil_roster_waterfalls       — the tiered roster allocation configs per
 *                                 program scope: position-based or
 *                                 performance-tiered schedules whose tiers
 *                                 name the roster members (starting QB
 *                                 share tiers, O-line pool tiers, walk-on
 *                                 base-stipend tiers).
 *   nil_school_caps             — the institutional cap allowance of record
 *                                 per (school, year) — the annual
 *                                 revenue-share ceiling the associated
 *                                 entity holdback verifies against.
 *   nil_cap_verifications       — the VERIFIED cap verification of record
 *                                 per (school, year) — the holdback
 *                                 release gate's key (insert-as-lock).
 *   nil_deal_compliance_audits  — the valid business purpose audit of
 *                                 record per NIL contract: deals at or
 *                                 above the $600 threshold flag for
 *                                 mandatory compliance metadata matching;
 *                                 only a 'nil_cleared' audit pays.
 *   nil_payout_applications     — the append-only per-event payout
 *                                 application for deal money (endorsement
 *                                 and collective rows): the agency
 *                                 commission deduction at payout, the
 *                                 state-matrix and cap verdicts, and the
 *                                 net payout of record.
 *   nil_pool_applications       — the append-only per-event pool
 *                                 application for school distribution
 *                                 pools: the adjusted revenue-share
 *                                 calculator's pool math and the tiered
 *                                 roster walk's committed slices.
 *   nil_group_splits            — the group NIL equal split of record per
 *                                 media-rights distribution event: the
 *                                 team-wide video game and apparel license
 *                                 revenue divided equally across all
 *                                 participating roster members.
 *   nil_state_rules             — the high school state compliance matrix
 *                                 per (state_jurisdiction_code, rule_code):
 *                                 the regional association rules of record
 *                                 enforced before contract payout
 *                                 execution.
 *   nil_payout_gate_states      — the durable NIL payout gate states of
 *                                 record per (payee, school): the states
 *                                 the payout compliance gate reads —
 *                                 nil_cleared, compliance_verified,
 *                                 title_ix_proportionality_cleared, and the
 *                                 associated-entity holdback pair.
 *
 * Money is integer cents throughout; rates are basis points (the founder
 * bands enforced in code: agency marketing 1000–2000 bps, direct rev-share
 * 300–500 bps). No foreign keys by design — the tables key on ledger
 * transaction ids, contract ids, and the addendum 13 identifier space
 * (athlete_id, school_id, state_jurisdiction_code), the 0036/0037
 * discipline.
 */

/** The deal's agency commission mode of record — the founder's two fee
 * families plus the explicit no-fee deal. */
export type NilAgencyMode = "marketing" | "direct_rev_share" | "none";

/** The founder's agency bands, enforced at registration AND at payout. */
export const NIL_MARKETING_MIN_BPS = 1_000;
export const NIL_MARKETING_MAX_BPS = 2_000;
export const NIL_DIRECT_REV_SHARE_MIN_BPS = 300;
export const NIL_DIRECT_REV_SHARE_MAX_BPS = 500;

/** The valid business purpose audit threshold — deals AT or ABOVE $600
 * flag for mandatory compliance metadata matching (the directive's
 * boundary; the test pins 59999/60000). */
export const NIL_BUSINESS_PURPOSE_THRESHOLD_CENTS = 60_000;

/** True when a deal's value trips the valid business purpose audit flag. */
export function requiresValidBusinessPurposeAudit(dealValueCents: number): boolean {
  return dealValueCents >= NIL_BUSINESS_PURPOSE_THRESHOLD_CENTS;
}

/**
 * Validates an agency fee against the founder's bands — a mode outside the
 * vocabulary or a rate outside its band is a hostile registration, refused.
 * 'none' requires exactly 0 bps.
 */
export function isValidNilAgencyFee(mode: NilAgencyMode, bps: number): boolean {
  switch (mode) {
    case "marketing":
      return (
        bps >= NIL_MARKETING_MIN_BPS && bps <= NIL_MARKETING_MAX_BPS
      );
    case "direct_rev_share":
      return (
        bps >= NIL_DIRECT_REV_SHARE_MIN_BPS &&
        bps <= NIL_DIRECT_REV_SHARE_MAX_BPS
      );
    case "none":
      return bps === 0;
  }
}

/** The adjusted revenue-share program's scope key — `school:<id>` or
 * `collective:<id>` (the program config the pool calculator reads). */
export type NilProgramScope = "school" | "collective";

/** The school distribution pool's type of record. */
export type NilPoolType = "media_rights" | "ticket_distribution";

/** The roster waterfall's tier basis of record. */
export type NilWaterfallKind = "position" | "performance";

/** One roster tier's spec — a share tier (share_bps of the net pool,
 * divided equally across its members) or a base-stipend tier (each member
 * receives the stipend). Exactly one of share_bps / base_stipend_cents. */
export type NilRosterTierSpec = {
  readonly tier_key: string;
  /** The tier's share of the Net Athlete Share Pool, in bps (share tiers). */
  readonly share_bps: number | null;
  /** The tier's per-member base stipend, whole cents (stipend tiers). */
  readonly base_stipend_cents: number | null;
  /** The roster members in the tier — the athlete_id keys of record. */
  readonly member_ids: readonly string[];
};

/** One tier's committed allocation — the pool application's slices. */
export type NilRosterTierAllocation = {
  readonly tier_key: string;
  readonly member_ids: readonly string[];
  /** The tier's total slice, whole cents. */
  readonly tier_cents: number;
  /** Per-member equal split of the tier slice (floor/floor + dust swept
   * to the LAST member, the licensing dual-IP discipline). */
  readonly member_amounts: readonly { athlete_id: string; cents: number }[];
  /** The tier slice's odd-cent dust, whole cents (>= 0). */
  readonly dust_cents: number;
};

/** The collective/booster funding source of record — the associated-entity
 * discriminator. Only 'collective' and 'booster' trip the holdback. */
export type NilFundingSource = "collective" | "booster" | "direct";

/** The group split's rights stream of record — the team-wide license
 * revenue the directive names. */
export type NilGroupRightsStream = "video_game" | "apparel" | "media";

/** The state matrix's enforcement vocabulary. */
export type NilStateEnforcement = "prohibited" | "permitted" | "conditional";

// ---------------------------------------------------------------------------
// The records.
// ---------------------------------------------------------------------------

/** The adjusted direct revenue-sharing program of record per scope. */
export type NilRevenueShareProgramRecord = {
  id: string;
  /** `school:<uuid>` or `collective:<uuid>` — the program's identity. */
  scope_key: string;
  scope: NilProgramScope;
  school_id: string | null;
  collective_id: string | null;
  /** The roster Title IX allocation reserve, bps of the gross pool. */
  title_ix_reserve_bps: number;
  /** The school administrative fee, bps of the gross pool. */
  admin_fee_bps: number;
  created_at: string;
  updated_at: string;
};

/** The tiered roster waterfall config of record per (scope, key). */
export type NilRosterWaterfallRecord = {
  id: string;
  scope_key: string;
  waterfall_key: string;
  kind: NilWaterfallKind;
  /** The tier schedule of record — JSON-encoded NilRosterTierSpec[]. */
  tiers: string;
  created_at: string;
  updated_at: string;
};

/** The institutional cap allowance of record per (school, year). */
export type NilSchoolCapRecord = {
  id: string;
  school_id: string;
  /** The cap year of record (e.g. "2026"). */
  cap_year: string;
  /** The annual revenue-share cap, whole cents (e.g. $20.5M = 2_050_000_000). */
  annual_cap_cents: number;
  created_at: string;
  updated_at: string;
};

/** The verified cap verification of record per (school, year) — the
 * holdback release gate's key. Insert-as-lock: the FIRST verification of
 * record wins; a concurrent second insert throws (the caller reads the
 * winner through the getter). */
export type NilCapVerificationRecord = {
  id: string;
  school_id: string;
  cap_year: string;
  /** The verified committed total at verification, whole cents. */
  verified_committed_cents: number;
  evidence_ref: string;
  verified_by: string;
  created_at: string;
};

/** The valid business purpose audit of record per NIL contract. */
export type NilDealComplianceAuditRecord = {
  id: string;
  nil_contract_id: string;
  athlete_id: string;
  school_id: string;
  /** The deal value at flag time, whole cents. */
  deal_value_cents: number;
  /** 'flagged' — the $600 trip, pending compliance metadata matching;
   * 'nil_cleared' — the mandatory metadata matched (purpose + evidence). */
  business_purpose_state: "flagged" | "nil_cleared";
  /** The deal's stated business purpose — mandatory before a clear. */
  purpose_description: string | null;
  evidence_ref: string | null;
  cleared_by: string | null;
  created_at: string;
  updated_at: string;
};

/** The per-event payout application of record for deal money. */
export type NilPayoutApplicationRecord = {
  id: string;
  nil_contract_id: string;
  athlete_id: string;
  school_id: string;
  /** The content-derived event id — UNIQUE, the replay guard. */
  source_event_id: string;
  period: string;
  gross_cents: number;
  agency_mode: NilAgencyMode;
  agency_bps: number;
  /** The agency commission deducted at payout, whole cents. */
  agency_fee_cents: number;
  /** The net payout of record: gross − agency fee. */
  net_payout_cents: number;
  /** 'paid' — every gate passed; 'held_compliance' — the valid business
   * purpose audit; 'held_state_rule' — the state matrix block. */
  verdict: "paid" | "held_compliance" | "held_state_rule";
  /** The blocking state rule's code (held_state_rule payouts). */
  state_rule_ref: string | null;
  /** The cap verification of record backing a collective/booster payout. */
  cap_verified_ref: string | null;
  created_at: string;
};

/** The per-event pool application of record — the adjusted calculator's
 * pool math plus the tiered roster walk's committed slices. */
export type NilPoolApplicationRecord = {
  id: string;
  school_id: string;
  pool_type: NilPoolType;
  /** The content-derived event id — UNIQUE, the replay guard. */
  source_event_id: string;
  period: string;
  gross_pool_cents: number;
  title_ix_reserve_bps: number;
  title_ix_reserve_cents: number;
  admin_fee_bps: number;
  admin_fee_cents: number;
  /** The Net Athlete Share Pool: gross − Title IX reserve − admin fee. */
  net_athlete_share_pool_cents: number;
  waterfall_key: string;
  tier_kind: NilWaterfallKind;
  /** The committed roster walk — JSON-encoded NilRosterTierAllocation[]. */
  slices: string;
  /** The total paid across members, whole cents. */
  roster_paid_cents: number;
  /** The walk's unallocated dust, whole cents (>= 0). */
  dust_cents: number;
  created_at: string;
};

/** The group NIL equal split of record per media-rights distribution. */
export type NilGroupSplitRecord = {
  id: string;
  /** The distribution's scope of record (school or league identity). */
  scope_ref: string;
  rights_stream: NilGroupRightsStream;
  /** The content-derived event id — UNIQUE, the replay guard. */
  source_event_id: string;
  period: string;
  total_cents: number;
  /** The participating roster members — JSON-encoded string[]. */
  participant_ids: string;
  participant_count: number;
  per_participant_cents: number;
  /** The equal split's odd-cent dust, whole cents (>= 0). */
  dust_cents: number;
  created_at: string;
};

/** The high school state compliance rule of record per (state, rule). */
export type NilStateRuleRecord = {
  id: string;
  state_jurisdiction_code: string;
  rule_code: string;
  /** The deal category the rule covers (e.g. 'private_brand'). */
  applies_to_category: string;
  enforcement: NilStateEnforcement;
  rule_summary: string;
  created_at: string;
  updated_at: string;
};

/** The NIL payout gate states of record per (payee, school) — the states
 * the payout compliance gate reads (the 0029/0033/0035/0037 pattern). */
export type NilPayoutGateStateRecord = {
  id: string;
  payee_id: string;
  school_id: string;
  /** 'unknown' | 'nil_cleared' — the valid business purpose audit's state. */
  nil_clearance_state: "unknown" | "nil_cleared";
  /** 'unknown' | 'verified' — the NIL compliance verification. */
  compliance_state: "unknown" | "verified";
  /** 'unknown' | 'cleared' — the Title IX proportionality clearance. */
  title_ix_state: "unknown" | "cleared";
  /** The associated-entity backing: true collective/booster-backed, false
   * a direct unassociated deal, null UNKNOWN (the fail-closed reading). */
  collective_or_booster_backed: boolean | null;
  /** 'unknown' | 'verified' — the institutional cap verification. */
  institutional_cap_state: "unknown" | "verified";
  evidence_ref: string | null;
  verified_by: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * Validates a roster tier schedule at registration — every tier names
 * members, carries exactly one of share_bps (0 < bps <= 10000) or a
 * non-negative stipend, and the share tiers' bps sum to at most 10000
 * (the schedule may under-commit the pool; the walk sweeps the remainder
 * to dust). A member may appear in only one tier.
 */
export function validateNilTierSchedule(
  tiers: readonly NilRosterTierSpec[],
): { ok: true } | { ok: false; reason: string } {
  if (tiers.length === 0) return { ok: false, reason: "empty_schedule" };
  let shareBpsTotal = 0;
  const seenMembers = new Set<string>();
  for (const tier of tiers) {
    if (tier.tier_key.trim() === "") return { ok: false, reason: "tier_key_required" };
    if (tier.member_ids.length === 0) {
      return { ok: false, reason: `tier_${tier.tier_key}:no_members` };
    }
    const isShareTier = tier.share_bps !== null;
    const isStipendTier = tier.base_stipend_cents !== null;
    if (isShareTier === isStipendTier) {
      return { ok: false, reason: `tier_${tier.tier_key}:exactly_one_of_share_or_stipend` };
    }
    if (isShareTier) {
      const bps = tier.share_bps as number;
      if (!Number.isInteger(bps) || bps <= 0 || bps > 10_000) {
        return { ok: false, reason: `tier_${tier.tier_key}:share_bps_out_of_range` };
      }
      shareBpsTotal += bps;
      if (shareBpsTotal > 10_000) {
        return { ok: false, reason: "share_bps_total_exceeds_pool" };
      }
    } else {
      const stipend = tier.base_stipend_cents as number;
      if (!Number.isInteger(stipend) || stipend < 0) {
        return { ok: false, reason: `tier_${tier.tier_key}:stipend_out_of_range` };
      }
    }
    for (const member of tier.member_ids) {
      if (seenMembers.has(member)) {
        return { ok: false, reason: `member_${member}:duplicate_across_tiers` };
      }
      seenMembers.add(member);
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// PR 35 (migration 0039) — the NIL audit escrow and the transfer portal
// clawback: the founder's athlete-side directives on top of the PR 34 lane.
//
//   nil_audit_escrow_policies       — the founder-banded 500–1000 bps
//                                     escrow rate of record per
//                                     (payee, school) scope.
//   nil_audit_escrow_drawdowns      — the position-locked escrow
//                                     drawdown ledger: mid-season NCAA
//                                     Transfer Portal reconciliations and
//                                     tax withholdings, never a guessed
//                                     draw.
//   nil_audit_escrow_reconciliations — the verified reconciliation of
//                                     record per escrow (insert-as-lock);
//                                     the release gate's key.
//   nil_advance_schedules           — the NIL advance of record per
//                                     contract: amount and the
//                                     start/completion term dates the
//                                     pro-rated clawback prices from.
//   nil_transfer_portal_entries     — the portal entry of record per
//                                     (contract, athlete) — the first
//                                     entry wins; a re-shipped sheet
//                                     replays as a no-op.
//   nil_unearned_clawbacks          — the pro-rated unearned-advance
//                                     calculation of record per portal
//                                     entry and the nil_unearned_clawback
//                                     debit hold it triggered.
// ---------------------------------------------------------------------------

/** The two escrow drawdown classes the founder named — anything else is a
 * coding error at the type level and a refusal at the store level. */
export const NIL_AUDIT_ESCROW_DRAWDOWN_CLASSES = [
  "transfer_portal_reconciliation",
  "tax_withholding",
] as const;

export type NilAuditEscrowDrawdownClass = (typeof NIL_AUDIT_ESCROW_DRAWDOWN_CLASSES)[number];

/** The NIL audit escrow policy of record per (payee, school) scope — the
 * founder-banded share of each athletic department distribution held back
 * into the reserved bucket. */
export type NilAuditEscrowPolicyRecord = {
  id: string;
  /** The scope key — `payee:{payee_id}:school:{school_id}` (the routing
   * lane's convention). */
  scope_key: string;
  /** 500–1000 bps — the 5–10% founder band, enforced at registration. */
  reserve_rate_bps: number;
  created_at: string;
  updated_at: string;
};

/** One position-locked escrow drawdown — the append-only spend ledger.
 * UNIQUE per (reserve_ledger_id, source_event_id) is the replay guard;
 * UNIQUE per (reserve_ledger_id, drawn_before_cents) is the position
 * lock — two concurrent drawdowns cannot both spend the same balance. */
export type NilAuditEscrowDrawdownRecord = {
  id: string;
  /** The escrow bucket's ledger row id (`nil_audit_escrow` kind/status). */
  reserve_ledger_id: string;
  /** The policy scope the bucket was routed under. */
  scope_key: string;
  drawdown_class: NilAuditEscrowDrawdownClass;
  /** The content-derived event identity — a replayed draw is a no-op. */
  source_event_id: string;
  /** The bucket balance this drawdown priced against — the position. */
  drawn_before_cents: number;
  drawn_cents: number;
  remaining_cents: number;
  created_at: string;
};

/** The verified reconciliation of record per escrow bucket —
 * insert-as-lock: the FIRST reconciliation of record wins; a concurrent
 * second insert throws. The release gate reads THIS row. */
export type NilAuditEscrowReconciliationRecord = {
  id: string;
  reserve_ledger_id: string;
  /** The verified reconciliation evidence of record. */
  evidence_ref: string;
  reconciled_by: string;
  created_at: string;
};

/** The NIL advance of record per contract — the terms the pro-rated
 * clawback prices from. Never the caller's numbers: the lane reads THIS
 * row or computes nothing. */
export type NilAdvanceScheduleRecord = {
  id: string;
  nil_contract_id: string;
  athlete_id: string;
  school_id: string;
  /** The advance's face — integer cents, positive. */
  advance_cents: number;
  /** The term's calendar dates (strict YYYY-MM-DD, UTC days). */
  term_start_date: string;
  /** Contract completion — portal entry on/after this date is fully
   * earned; nothing is clawed back. */
  term_end_date: string;
  created_at: string;
  updated_at: string;
};

/** The transfer portal entry of record per (contract, athlete) — the
 * durable portal fact the clawback lane hangs off. */
export type NilTransferPortalEntryRecord = {
  id: string;
  nil_contract_id: string;
  athlete_id: string;
  school_id: string;
  /** The portal entry's calendar date (strict YYYY-MM-DD). */
  entry_date: string;
  /** The contract completion date of record at entry time (the advance
   * schedule's term end) — null when no advance schedule existed, so a
   * re-shipped entry still shows what the lane knew. */
  contract_completion_date: string | null;
  /** True only when the entry preceded contract completion — the
   * clawback trigger condition. */
  entered_prior_to_completion: boolean;
  created_at: string;
};

/** The pro-rated unearned-advance clawback of record per portal entry —
 * the calculation AND the `nil_unearned_clawback` debit hold it
 * triggered (the hold's ledger row id). */
export type NilUnearnedClawbackRecord = {
  id: string;
  nil_contract_id: string;
  athlete_id: string;
  school_id: string;
  portal_entry_id: string;
  /** The advance of record the math priced from (pinned, not joined). */
  advance_cents: number;
  term_start_date: string;
  term_end_date: string;
  entry_date: string;
  total_term_days: number;
  served_days: number;
  /** advance − earned — the unearned balance, exact to the cent. */
  unearned_cents: number;
  /** The `nil_unearned_clawback` debit hold's ledger row. */
  clawback_ledger_id: string;
  created_at: string;
};

/** A strict YYYY-MM-DD calendar date — anything else is NaN. */
function parseUtcDate(date: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return Number.NaN;
  const ms = Date.parse(`${date}T00:00:00.000Z`);
  return Number.isFinite(ms) ? ms : Number.NaN;
}

/** Whole UTC days from `from` to `to` (both strict YYYY-MM-DD). */
function utcDaysBetween(from: string, to: string): number {
  return Math.round((parseUtcDate(to) - parseUtcDate(from)) / 86_400_000);
}

/** The pro-rated clawback plan — the pure math the portal-entry lane
 * prices from. Floor-only integer arithmetic: the SERVED share is floored
 * and the unearned balance is the exact subtraction
 * (advance − floor(advance × served / total)), so earned + unearned equals
 * the advance on every input — the clawback bucket's conservation
 * identity, dust-free by construction. A portal entry on/after contract
 * completion is fully earned: no clawback is due. */
export type NilProratedClawbackPlan = {
  advance_cents: number;
  term_start_date: string;
  term_end_date: string;
  portal_entry_date: string;
  total_term_days: number;
  served_days: number;
  earned_cents: number;
  unearned_cents: number;
  /** False when the entry landed on/after completion. */
  clawback_due: boolean;
};

export type NilProratedClawbackPlanResult =
  | { ok: true; value: NilProratedClawbackPlan }
  | { ok: false; reason: "invalid_advance_cents" | "invalid_date" | "nonpositive_term" };

export function buildProratedClawbackPlan(input: {
  advance_cents: number;
  term_start_date: string;
  term_end_date: string;
  portal_entry_date: string;
}): NilProratedClawbackPlanResult {
  const { advance_cents, term_start_date, term_end_date, portal_entry_date } = input;
  if (!Number.isInteger(advance_cents) || advance_cents <= 0) {
    return { ok: false, reason: "invalid_advance_cents" };
  }
  if (
    Number.isNaN(parseUtcDate(term_start_date)) ||
    Number.isNaN(parseUtcDate(term_end_date)) ||
    Number.isNaN(parseUtcDate(portal_entry_date))
  ) {
    return { ok: false, reason: "invalid_date" };
  }
  const totalTermDays = utcDaysBetween(term_start_date, term_end_date);
  if (!Number.isInteger(totalTermDays) || totalTermDays <= 0) {
    return { ok: false, reason: "nonpositive_term" };
  }
  const rawServedDays = utcDaysBetween(term_start_date, portal_entry_date);
  // An entry before the term opened served no earned days; an entry on or
  // after completion served the full term.
  const servedDays = Math.max(0, Math.min(totalTermDays, rawServedDays));
  const earnedCents = Math.floor((advance_cents * servedDays) / totalTermDays);
  return {
    ok: true,
    value: {
      advance_cents,
      term_start_date,
      term_end_date,
      portal_entry_date,
      total_term_days: totalTermDays,
      served_days: servedDays,
      earned_cents: earnedCents,
      unearned_cents: advance_cents - earnedCents,
      clawback_due: rawServedDays < totalTermDays,
    },
  };
}
