/**
 * CVT recon worker — the NIL lane's pure engine (PR 34, the founder NIL
 * compliance + roster waterfall directive): the identity spaces, the
 * adjusted direct revenue-sharing calculator, the tiered roster walk, the
 * agency commission modes, the group NIL equal split, and the valid
 * business purpose flag boundary.
 *
 * Every function here is pure — no store, no I/O — and exact to the cent:
 * deductions floor per leg (never round up — the house money discipline),
 * equal splits floor per member and sweep the odd-cent residue to dust,
 * and every walk conserves: the allocations plus the dust equal the pool,
 * ALWAYS. The cascade pass consumes these; the profiles parse into them.
 */

import { createHash } from "node:crypto";

import type {
  NilAgencyMode,
  NilFundingSource,
  NilRosterTierAllocation,
  NilRosterTierSpec,
  NilWaterfallKind,
} from "@/modules/nil/records";
import { isValidNilAgencyFee } from "@/modules/nil/records";

/** The NIL lane's statement senders — the four strict layouts' families. */
export type NilSenderCode = "brand" | "collective" | "school" | "media";

/** The roster waterfall's tier basis of record (re-exported for the
 * queue/cascade modules' convenience). */
export type { NilWaterfallKind };

function nilFingerprint(...fields: readonly string[]): string {
  return createHash("sha256").update(fields.join("|")).digest("hex");
}

/**
 * The row's event id — one per (sender, athlete, school, period, sender
 * row id). The sender's row id of record is the identity core: a
 * re-shipped disclosure replays as a counted no-op, and two senders'
 * sheets for the same deal stay distinct identities. The athlete and
 * school ride the identity — a deal re-attributed to a different athlete
 * or school is a different event.
 */
export function nilRowEventId(detail: {
  sender: NilSenderCode;
  athleteId: string | null;
  schoolId: string | null;
  period: string;
  senderRowId: string;
}): string {
  return `nil:${detail.sender}:${nilFingerprint(
    detail.athleteId ?? "",
    detail.schoolId ?? "",
    detail.period,
    detail.senderRowId,
  )}`;
}

/** The reporting period's shape of record (YYYY-MM). */
export function isNilPeriod(value: string): boolean {
  return /^\d{4}-\d{2}$/.test(value);
}

/** Floor-divides exact micros into whole cents — the house conversion
 * (1 dollar = 1e8 statement micros, so 1e6 micros per cent). A negative
 * basis is hostile upstream; this helper never sees one. */
export function nilMicrosToCents(micros: bigint): number {
  // 1 dollar = 1e8 statement micros (the codebase-wide MICROS_PER_DOLLAR),
  // so 1 cent = 1e6 micros.
  return Number(micros / 1_000_000n);
}

/** Floors a basis-points share of a cents amount — per-leg exact, never
 * rounds up (the founder's cent-exact canon). */
export function nilBpsShareCents(amountCents: number, bps: number): number {
  return Math.floor((amountCents * bps) / 10_000);
}

/**
 * THE ADJUSTED DIRECT REVENUE SHARING CALCULATOR (the founder directive's
 * exact identity):
 *
 *   Net Athlete Share Pool = gross media or ticket distribution pool
 *                            − the roster Title IX allocation reserve
 *                            − the school administrative fee
 *
 * The deductions price off the GROSS pool (each floor-derived); the net
 * is the subtraction — the pool math is exact to the cent by
 * construction, and the conservation identity
 * (title_ix + admin_fee + net === gross) pins it.
 */
export function netAthleteSharePoolCents(input: {
  grossPoolCents: number;
  titleIxReserveBps: number;
  adminFeeBps: number;
}): {
  grossPoolCents: number;
  titleIxReserveCents: number;
  adminFeeCents: number;
  netAthleteSharePoolCents: number;
} {
  const titleIxReserveCents = nilBpsShareCents(
    input.grossPoolCents,
    input.titleIxReserveBps,
  );
  const adminFeeCents = nilBpsShareCents(input.grossPoolCents, input.adminFeeBps);
  const netAthleteSharePoolCents =
    input.grossPoolCents - titleIxReserveCents - adminFeeCents;
  return {
    grossPoolCents: input.grossPoolCents,
    titleIxReserveCents,
    adminFeeCents,
    netAthleteSharePoolCents,
  };
}

/**
 * THE AGENCY COMMISSION DEDUCTION — at payout, per the founder's fee
 * families: typically 10–20% (1000–2000 bps) on marketing and 3–5%
 * (300–500 bps) on direct rev-share. The caller validates the band
 * (isValidNilAgencyFee at parse/registration); this floors the share.
 */
export function nilAgencyFeeCents(amountCents: number, bps: number): number {
  return nilBpsShareCents(amountCents, bps);
}

/**
 * THE GROUP NIL EQUAL SPLIT — team-wide video game and apparel license
 * revenue divides equally across all participating roster members: floor
 * per member, the odd-cent residue sweeps to dust (the licensing dual-IP
 * discipline). Conserves: per-member total + dust === total.
 */
export function equalGroupSplitCents(
  totalCents: number,
  participantIds: readonly string[],
): {
  perParticipantCents: number;
  amounts: readonly { athlete_id: string; cents: number }[];
  dustCents: number;
} {
  const count = participantIds.length;
  const perParticipantCents = count === 0 ? 0 : Math.floor(totalCents / count);
  const dustCents = totalCents - perParticipantCents * count;
  const amounts = participantIds.map((athlete_id) => ({
    athlete_id,
    cents: perParticipantCents,
  }));
  return { perParticipantCents, amounts, dustCents };
}

/**
 * THE TIERED ROSTER WALK — the Net Athlete Share Pool distributes across
 * the waterfall's tiers in order:
 *
 *   - a SHARE tier earns floor(net pool × share_bps / 10000) — the share
 *     prices the NET POOL, not the remainder — divided equally across its
 *     members (floor/floor, the tier's odd cent swept to its last member,
 *     the licensing dual-IP discipline);
 *   - a STIPEND tier pays each member the tier's base stipend, capped at
 *     the pool REMAINING (an exhausted pool under-pays in order, never
 *     negative — the fail-closed direction: never over-commits);
 *   - the unallocated remainder (an under-committed schedule) sweeps to
 *     dust.
 *
 * Conserves: Σ tier slices + final dust === the Net Athlete Share Pool,
 * ALWAYS — the identity the pool application pins.
 */
export function rosterWalkCents(
  netPoolCents: number,
  tiers: readonly NilRosterTierSpec[],
): {
  allocations: NilRosterTierAllocation[];
  rosterPaidCents: number;
  dustCents: number;
} {
  let remaining = netPoolCents;
  const allocations: NilRosterTierAllocation[] = [];
  let paidTotal = 0;

  for (const tier of tiers) {
    if (tier.share_bps !== null) {
      const tierSlice = nilBpsShareCents(netPoolCents, tier.share_bps);
      const perMember = Math.floor(tierSlice / tier.member_ids.length);
      const tierDust = tierSlice - perMember * tier.member_ids.length;
      const memberAmounts = tier.member_ids.map((athlete_id, index) => ({
        athlete_id,
        cents: index === tier.member_ids.length - 1 ? perMember + tierDust : perMember,
      }));
      allocations.push({
        tier_key: tier.tier_key,
        member_ids: [...tier.member_ids],
        tier_cents: tierSlice,
        member_amounts: memberAmounts,
        dust_cents: 0,
      });
      remaining -= tierSlice;
      paidTotal += tierSlice;
      continue;
    }

    const stipend = tier.base_stipend_cents ?? 0;
    const memberAmounts = tier.member_ids.map((athlete_id) => {
      const cents = Math.min(stipend, Math.max(remaining, 0));
      remaining -= cents;
      paidTotal += cents;
      return { athlete_id, cents };
    });
    allocations.push({
      tier_key: tier.tier_key,
      member_ids: [...tier.member_ids],
      tier_cents: memberAmounts.reduce((total, member) => total + member.cents, 0),
      member_amounts: memberAmounts,
      dust_cents: 0,
    });
  }

  const dustCents = remaining;
  return { allocations, rosterPaidCents: paidTotal, dustCents };
}

/** Validates the deal's agency fee against the founder's bands (the
 * parse-time refusal; the payout application re-pins it). */
export function isValidNilDealFee(mode: NilAgencyMode, bps: number): boolean {
  return isValidNilAgencyFee(mode, bps);
}

/** The collective/booster funding sources — the associated-entity
 * holdback's trip set. A 'direct' deal skips the cap check. */
export function isAssociatedEntityFunding(source: NilFundingSource): boolean {
  return source === "collective" || source === "booster";
}

/** The state matrix's deal categories of record (the rule rows' scope). */
export type NilDealCategory =
  | "private_brand"
  | "team_apparel"
  | "school_gear"
  | "collective"
  | "school_rev_share"
  | "media_rights";

/**
 * The high school state matrix's rule-code mapping — the deal category
 * onto the rule codes of record. `private_brand` is the directive's
 * worked example: prohibitions on wearing high school team jerseys in
 * private brand endorsements.
 */
export function nilStateRuleCodeForCategory(category: NilDealCategory): string {
  switch (category) {
    case "private_brand":
      return "hs_jersey_private_endorsement";
    case "team_apparel":
      return "hs_team_apparel_endorsement";
    case "school_gear":
      return "hs_school_gear_endorsement";
    default:
      return "nil_contract_execution";
  }
}
