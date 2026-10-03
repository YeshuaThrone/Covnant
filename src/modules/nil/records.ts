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
