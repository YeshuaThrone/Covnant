// Webtoon studio splits + per-language translation cascades — PR 20 (founder
// webtoon + serialized-publishing directive).
//
// A webtoon series is a STUDIO production: the primary author is one
// contributor among several, and a foreign-language feed is a PROGRAM of its
// own — a localizer of record, a localization cost that amortizes, and a
// cascade that pays the translator/localizer BEFORE the primary author's net.
// This lane implements the founder directive's three economics:
//
//   1. STUDIO SPLITS — role-group bands of the post-translation net:
//      original creator/storywriter 30–40%, line artist/inker 20–30%,
//      colorist/background 10–15%; the primary author holds the residual.
//      A registered schedule names whole basis points per role INSIDE its
//      group's band; the allocator refuses anything outside it
//      (WEBTOON_*_MIN_BPS/MAX_BPS in constants — the agency-fee-band
//      discipline of PR 15).
//
//   2. TRANSLATION CASCADES — per (series, language) feed, the localizer is
//      paid FIRST (flat fee per chapter or fractional rev share of the feed
//      net), then the studio role groups, then the primary author. The
//      ordering is structural — the plan assembles the party list
//      localizer-first and the release credits in that order — so a test can
//      pin "localizer before author" by asserting the party order and the
//      arithmetic each step leaves.
//
//   3. THE TRANSLATION ESCROW — a foreign feed's translation royalty LOCKS
//      in TRANSLATION_LOCALIZATION_PENDING (ledger kind AND status — the
//      VTuber holdback's state pattern, riding the existing ledger state
//      columns per PR 99) until the feed's localization costs amortize and
//      the verified release runs. The lock is PER-SERIES-PER-LANGUAGE — the
//      payee and GL account carry the series id and language code the way
//      the VTuber holdback carries the agency id.
//
//   4. RECOUPMENT POOLS — a print advance and a digital coin-unlock advance
//      are SEPARATE pools per series (the pool class is part of the pool's
//      identity), and a print edition's revenue never touches the coin
//      pool's recovery or vice versa — the film waterfall's
//      cross-collateralization firewall, in per-series pool form. The class
//      is chosen EXPLICITLY by the caller per revenue event; nothing infers
//      it.
//
// NO PAYOUT STATE ships in a table beyond the registries the contracts need:
// every cent moves through the ledger/journal contract — the escrow post's
// balanced `translation_localization_post` journal (FBO debit vs the
// per-language escrow account), the release's `translation_localization_release`
// journal (escrow debit vs the routing credits), and the integer-cent
// allocator's dust swept to the platform variance account
// (allocateWithCompanyDustSweep). Replay idempotency: the escrow post is
// journal-ref-guarded per source event (409 on re-post), the amortization
// line consumes under the insert-as-lock arbiter (UNIQUE per
// (schedule_ref, line_index) — the PR 99 discipline), the release flips the
// escrow row through the conditional settle CAS (a concurrent loser reads
// undefined and 409s), and a recoupment application is unique per
// (pool_id, source_event_id) — a replayed application is the unique
// violation, never a double recovery.
//
// THE MOVES:
//
//   buildWebtoonStudioSplitPlan — the PURE studio allocator over the
//                 post-translation net: band-validate every role group,
//                 allocate the group pools (author residual LAST), then
//                 allocate each group's members inside its pool. Two levels
//                 of the house allocator, each sweeping its own dust to the
//                 platform.
//
//   buildWebtoonTranslationCascadePlan — the PURE per-language cascade:
//                 localizer royalty first (flat fee or rev share), then the
//                 studio plan over what remains. Fail-closed when the
//                 contracted fees promise more than the feed carries.
//
//   postTranslationRoyaltyToEscrow — the lock. A feed's translation royalty
//                 arrives and LOCKS (kind + status
//                 translation_localization_pending): no vault, no payee
//                 credit, no dust row — the hold is the point.
//
//   releaseTranslationLocalizationEscrow — the verified release. The escrow
//                 row must be LOCKED (404/422/409 otherwise), the
//                 localization contract of record must exist, the schedule's
//                 next amortization line resolves (the cost gate), the plan
//                 must build, every credited party must pass the
//                 publishing vertical's fail-closed payout gate (operator
//                 settlement approval, verified KYC, ip-rights-cleared state
//                 — the founder canon), and the settle CAS must win BEFORE
//                 any money moves. Then the cascade routes in the founder's
//                 mandated order: the amortization line's cost recovery, the
//                 localizer's royalty, the studio role groups (withholding
//                 on creator roles), the primary author's net, dust swept to
//                 the platform.
//
//   applyWebtoonRecoupment — the isolated pool lane. One revenue event
//                 against one (series, pool class) pool: the position lock
//                 (UNIQUE per (pool_id, recouped_before_cents)) arbitrates
//                 concurrent applications, the event id arbitrates replays,
//                 and a pool whose recovery completes flips to 'recouped'.

import type { Store } from "@/lib/server/store";
import type { LedgerTransactionRecord } from "@/lib/don/types";
import {
  BPS_DENOMINATOR,
  COMPANY_VARIANCE_PAYEE_ID,
  COMPANY_VARIANCE_PAYEE_NAME,
  WEBTOON_COLORIST_BACKGROUND_MAX_BPS,
  WEBTOON_COLORIST_BACKGROUND_MIN_BPS,
  WEBTOON_LINE_ARTIST_INKER_MAX_BPS,
  WEBTOON_LINE_ARTIST_INKER_MIN_BPS,
  WEBTOON_ORIGINAL_CREATOR_STORYWRITER_MAX_BPS,
  WEBTOON_ORIGINAL_CREATOR_STORYWRITER_MIN_BPS,
  WEBTOON_STUDIO_ROLE_GROUPS,
  translationLocalizationPayeeId,
  translationLocalizationPayeeName,
  type WebtoonStudioRoleGroup,
} from "@/modules/don/constants";
import {
  allocateWithCompanyDustSweep,
  zeroBalanceHolds,
} from "@/modules/don/dust";
import type {
  CompanyDustRecord,
  TaxEscrowRecord,
  WebtoonLocalizationContractRecord,
  WebtoonLocalizationCostScheduleRecord,
  WebtoonRecoupmentApplicationRecord,
  WebtoonRecoupmentPoolClass,
  WebtoonStudioSplitRoleRecord,
} from "@/modules/don/records";
import { applyWithholding } from "@/modules/compliance/engine";
import { applyRecoupmentSweep } from "@/modules/recoupment/engine";
import {
  evaluatePayoutCompliance,
  getVerticalComplianceStateSource,
  resolveCreatorKycStatus,
} from "@/modules/compliance/payoutGate";
import { postJournal } from "@/modules/ledger/engine";
import {
  fboDebit,
  translationLocalizationCredit,
  translationLocalizationDebit,
  vaultCredit,
  type GlLegInput,
} from "@/modules/ledger/journal";
import type { SplitPartyInput } from "@/lib/don/types";
import { creditVault } from "@/modules/vaults/engine";
import { isIncomingFrozen } from "@/modules/vaults/dispute";
import { isWithholdableTalentRole } from "@/lib/server/vtuberAgency";

/** House failure envelope — the VTuber holdback / film escrow shape. */
export type WebtoonCascadeFailure = {
  ok: false;
  status: number;
  code: string;
  message: string;
};

/** The cascade releases through the publishing vertical's compliance gate. */
export const WEBTOON_CASCADE_VERTICAL = "publishing" as const;

// ---------------------------------------------------------------------------
// The per-language feed's identity — parsing the escrow payee back into the
// series and language the release cascades for.
// ---------------------------------------------------------------------------

/**
 * Recovers the (series, language) a translation-escrow payee id carries —
 * the inverse of translationLocalizationPayeeId. Undefined when the payee
 * is not a translation-escrow payee (a corrupted row's alarm).
 */
export function parseTranslationLocalizationPayeeId(
  payeeId: string,
): { seriesId: string; languageCode: string } | undefined {
  const prefix = "translation_localization_pending:";
  if (!payeeId.startsWith(prefix)) return undefined;
  const rest = payeeId.slice(prefix.length);
  const separator = rest.indexOf(":");
  if (separator <= 0 || separator === rest.length - 1) return undefined;
  const seriesId = rest.slice(0, separator);
  const languageCode = rest.slice(separator + 1);
  if (seriesId === "" || languageCode === "") return undefined;
  return { seriesId, languageCode };
}

// ---------------------------------------------------------------------------
// The studio split — the pure allocator over the post-translation net.
// ---------------------------------------------------------------------------

/** One studio role-group band — the founder directive's share envelope. */
export const WEBTOON_ROLE_GROUP_BANDS: Record<
  WebtoonStudioRoleGroup,
  { min_bps: number; max_bps: number }
> = {
  original_creator_storywriter: {
    min_bps: WEBTOON_ORIGINAL_CREATOR_STORYWRITER_MIN_BPS,
    max_bps: WEBTOON_ORIGINAL_CREATOR_STORYWRITER_MAX_BPS,
  },
  line_artist_inker: {
    min_bps: WEBTOON_LINE_ARTIST_INKER_MIN_BPS,
    max_bps: WEBTOON_LINE_ARTIST_INKER_MAX_BPS,
  },
  colorist_background: {
    min_bps: WEBTOON_COLORIST_BACKGROUND_MIN_BPS,
    max_bps: WEBTOON_COLORIST_BACKGROUND_MAX_BPS,
  },
};

/** One role-group's allocation outcome — the audit trail's row. */
export type WebtoonStudioGroupAllocation = {
  role_group: WebtoonStudioRoleGroup;
  /** The group's contracted bps of the studio pool (Σ member bps). */
  group_bps: number;
  /** The group's pool: the level-1 allocation's exact integer cents. */
  pool_cents: number;
  /** The group's members, allocated inside the pool (level 2). */
  members: Array<{
    payee_id: string;
    payee_name: string;
    share_bps: number;
    amount_cents: number;
  }>;
};

export type WebtoonStudioSplitPlan = {
  /** The post-translation net the split runs over, integer cents. */
  studio_pool_cents: number;
  /** Every role group's allocation, in band vocabulary order. */
  groups: WebtoonStudioGroupAllocation[];
  /** The primary author's residual — computed LAST, after every group. */
  author: { payee_id: string; payee_name: string; net_cents: number };
  /** The rounding residue (both levels) — swept to the platform. */
  company_dust_cents: number;
  /**
   * The release's party list, cascade order: studio members (group band
   * order, members in schedule order) then the author LAST.
   */
  party_splits: SplitPartyInput[];
};

/** The pure planner's studio input — roles come from the store's registry. */
export interface WebtoonStudioSplitPlanInput {
  studio_pool_cents: number;
  author_payee_id: string;
  author_payee_name: string;
  roles: ReadonlyArray<WebtoonStudioSplitRoleRecord>;
}

const ROLE_GROUP_ORDER: readonly WebtoonStudioRoleGroup[] = WEBTOON_STUDIO_ROLE_GROUPS;

/**
 * Builds the studio split plan for one series over the post-translation
 * net (pure: no store, no clock):
 *
 *   1. group the registered roles by role_group (schedule insertion order
 *      preserved inside each group — the deterministic member sequence),
 *   2. validate each group's TOTAL bps inside its founder band — a schedule
 *      under the floor under-recovers the studio's contribution terms, over
 *      the cap exceeds the mandate; the plan refuses, naming the group,
 *   3. level 1: the house allocator splits the studio pool into the group
 *      pools + the author's residual (author LAST — the residual exists
 *      only after every group's bps are reserved; bands cap the total at
 *      8500 so the residual is always at least 1500 bps),
 *   4. level 2: each group's pool splits across its members proportionally
 *      by their bps (the group's total is Σ its members' bps — a lone member
 *      takes the whole pool), floor per member, the residue to the house.
 *
 * Every share floor(bps × pool / 10000); each level's residue sweeps to
 * the platform variance account. An EMPTY role registry is valid — the
 * author takes the whole pool (a studio of one).
 */
/**
 * Level-2 allocation: the group pool splits across its members in the ratio
 * of their share_bps to the group's total bps — floor per member, the
 * integer residue sweeping to the platform variance account (the house dust
 * discipline). Member bps are studio-pool fractions (Σ per group = the
 * band-checked group total), so a lone member takes the whole group pool.
 */
function allocateGroupPoolProportionally(
  groupPoolCents: number,
  members: ReadonlyArray<WebtoonStudioSplitRoleRecord>,
): {
  splits: Array<{ payee_id: string; payee_name: string; amount_cents: number }>;
  dust_cents: number;
} {
  const groupTotalBps = members.reduce((sum, member) => sum + member.share_bps, 0);
  const splits = members.map((member) => ({
    payee_id: member.payee_id,
    payee_name: member.payee_name,
    amount_cents: Math.floor((member.share_bps * groupPoolCents) / groupTotalBps),
  }));
  const allocated = splits.reduce((sum, split) => sum + split.amount_cents, 0);
  return { splits, dust_cents: groupPoolCents - allocated };
}

export function buildWebtoonStudioSplitPlan(
  input: WebtoonStudioSplitPlanInput,
): { ok: true; value: WebtoonStudioSplitPlan } | WebtoonCascadeFailure {
  const { studio_pool_cents: poolCents } = input;
  if (!Number.isSafeInteger(poolCents) || poolCents < 0) {
    return {
      ok: false,
      status: 422,
      code: "invalid_amount",
      message: "The studio split pool posts integer cents (zero permitted).",
    };
  }
  if (input.author_payee_id === "" || input.author_payee_name === "") {
    return {
      ok: false,
      status: 422,
      code: "invalid_author_identity",
      message: "A studio split names the primary author (id and name of record).",
    };
  }

  // Group the roles, preserving the registry's insertion order inside each
  // group — the deterministic member sequence the level-2 allocation walks.
  const grouped = new Map<WebtoonStudioRoleGroup, WebtoonStudioSplitRoleRecord[]>();
  for (const role of input.roles) {
    if (!ROLE_GROUP_ORDER.includes(role.role_group)) {
      return {
        ok: false,
        status: 422,
        code: "webtoon_role_group_unknown",
        message: `Studio role "${role.payee_id}" carries role_group "${role.role_group}" — outside the studio vocabulary.`,
      };
    }
    if (
      role.payee_id === "" ||
      role.payee_name === "" ||
      !Number.isSafeInteger(role.share_bps) ||
      role.share_bps <= 0 ||
      role.share_bps > BPS_DENOMINATOR
    ) {
      return {
        ok: false,
        status: 422,
        code: "webtoon_role_invalid",
        message: `Studio role for payee "${role.payee_id}" is malformed (a positive whole-bps share and the payee identity of record are required).`,
      };
    }
    const bucket = grouped.get(role.role_group) ?? [];
    bucket.push(role);
    grouped.set(role.role_group, bucket);
  }

  // Band validation BEFORE any allocation — a refused schedule moves nothing.
  const groupTotals = new Map<WebtoonStudioRoleGroup, number>();
  for (const [group, members] of grouped) {
    const totalBps = members.reduce((sum, member) => sum + member.share_bps, 0);
    const band = WEBTOON_ROLE_GROUP_BANDS[group];
    if (totalBps < band.min_bps || totalBps > band.max_bps) {
      return {
        ok: false,
        status: 422,
        code: "webtoon_role_group_band_violation",
        message: `Studio role group "${group}" totals ${totalBps} bps — outside its founder band (${band.min_bps}–${band.max_bps}). Nothing splits from a schedule that ignores the mandate.`,
      };
    }
    groupTotals.set(group, totalBps);
  }

  // Level 1 — group pools + the author residual, author LAST. The party
  // list assembles in band vocabulary order; Σ bps = 10000 by construction
  // (the residual IS the remainder).
  const presentGroups = ROLE_GROUP_ORDER.filter((group) => groupTotals.has(group));
  const authorResidualBps =
    BPS_DENOMINATOR - presentGroups.reduce((sum, group) => sum + groupTotals.get(group)!, 0);
  const levelOneSplits: SplitPartyInput[] = [
    ...presentGroups.map(
      (group): SplitPartyInput => ({
        payee_id: `webtoon_group:${group}`,
        payee_name: group,
        role: "creator",
        share_bps: groupTotals.get(group)!,
      }),
    ),
    {
      payee_id: input.author_payee_id,
      payee_name: input.author_payee_name,
      role: "creator",
      share_bps: authorResidualBps,
    },
  ];
  const levelOne = allocateWithCompanyDustSweep(poolCents, levelOneSplits);
  if (!levelOne.ok) {
    return {
      ok: false,
      status: 500,
      code: "studio_plan_allocation_failed",
      message: levelOne.message,
    };
  }

  // Level 2 — each group's members inside the group's pool.
  const groupAllocations: WebtoonStudioGroupAllocation[] = [];
  let totalDust = levelOne.company_dust_cents;
  for (let index = 0; index < presentGroups.length; index += 1) {
    const group = presentGroups[index];
    const poolCentsForGroup = levelOne.splits[index]?.amount_cents ?? 0;
    const members = grouped.get(group)!;
    const levelTwo = allocateGroupPoolProportionally(poolCentsForGroup, members);
    totalDust += levelTwo.dust_cents;
    groupAllocations.push({
      role_group: group,
      group_bps: groupTotals.get(group)!,
      pool_cents: poolCentsForGroup,
      members: members.map((member, memberIndex) => ({
        payee_id: member.payee_id,
        payee_name: member.payee_name,
        share_bps: member.share_bps,
        amount_cents: levelTwo.splits[memberIndex]?.amount_cents ?? 0,
      })),
    });
  }

  const authorNet = levelOne.splits[levelOne.splits.length - 1]?.amount_cents ?? 0;

  // The release's party list — studio members in band order, author LAST.
  const partySplits: SplitPartyInput[] = [
    ...groupAllocations.flatMap((group) =>
      group.members.map(
        (member): SplitPartyInput => ({
          payee_id: member.payee_id,
          payee_name: member.payee_name,
          role: "creator",
          share_bps: member.share_bps,
        }),
      ),
    ),
    {
      payee_id: input.author_payee_id,
      payee_name: input.author_payee_name,
      role: "creator",
      share_bps: authorResidualBps,
    },
  ];

  return {
    ok: true,
    value: {
      studio_pool_cents: poolCents,
      groups: groupAllocations,
      author: {
        payee_id: input.author_payee_id,
        payee_name: input.author_payee_name,
        net_cents: authorNet,
      },
      company_dust_cents: totalDust,
      party_splits: partySplits,
    },
  };
}

// ---------------------------------------------------------------------------
// The per-language translation cascade — localizer FIRST, then the studio
// split, then the primary author. The pure plan.
// ---------------------------------------------------------------------------

/** The localizer's fee terms — from the (series, language) contract of record. */
export type WebtoonLocalizationFee =
  | { mode: "flat_fee"; per_chapter_flat_fee_cents: number; chapter_count: number }
  | { mode: "rev_share"; rev_share_bps: number };

export interface WebtoonTranslationCascadePlanInput {
  /** The feed's net for the period — post-cost-recovery, integer cents. */
  feed_net_cents: number;
  /** The localizer of record; null = a feed with no localization program. */
  localizer: { payee_id: string; payee_name: string } | null;
  fee: WebtoonLocalizationFee;
  /** The studio split's inputs (roles from the store's registry). */
  author_payee_id: string;
  author_payee_name: string;
  roles: ReadonlyArray<WebtoonStudioSplitRoleRecord>;
}

export type WebtoonTranslationCascadePlan = {
  /** The feed net the cascade ran over, integer cents. */
  feed_net_cents: number;
  /** The localizer's royalty — BEFORE any studio share or author net. */
  localizer: { payee_id: string; payee_name: string; royalty_cents: number };
  /** The studio split over the post-localization net. */
  studio: WebtoonStudioSplitPlan;
  /** The rounding residue — swept to the platform variance account. */
  company_dust_cents: number;
  /**
   * The release's party list, cascade order: the LOCALIZER first, then the
   * studio members (band order), then the primary author LAST. This order
   * IS the founder directive — the release credits in exactly this
   * sequence, and the tests pin it.
   */
  party_splits: SplitPartyInput[];
};

/**
 * Builds the per-language cascade plan (pure):
 *
 *   1. the localizer's royalty — flat fee (per_chapter_flat_fee_cents ×
 *      chapter_count) or rev share (floor(bps × net / 10000)) — reserved
 *      FIRST, fail-closed when the contracted fee exceeds the feed's net
 *      (the cascade never promises money the feed does not carry),
 *   2. the studio split over the post-localization remainder (bands and
 *      all; the author's residual is what survives),
 *   3. the party list assembles localizer-first, author-last.
 */
export function buildWebtoonTranslationCascadePlan(
  input: WebtoonTranslationCascadePlanInput,
): { ok: true; value: WebtoonTranslationCascadePlan } | WebtoonCascadeFailure {
  const { feed_net_cents: feedNet } = input;
  if (!Number.isSafeInteger(feedNet) || feedNet < 0) {
    return {
      ok: false,
      status: 422,
      code: "invalid_amount",
      message: "The translation cascade runs over integer cents (zero permitted).",
    };
  }
  if (input.author_payee_id === "" || input.author_payee_name === "") {
    return {
      ok: false,
      status: 422,
      code: "invalid_author_identity",
      message: "A translation cascade names the primary author (id and name of record).",
    };
  }

  // The localizer's royalty, exact integer cents, reserved FIRST.
  let localizerRoyaltyCents = 0;
  if (input.localizer !== null) {
    if (input.fee.mode === "flat_fee") {
      const { per_chapter_flat_fee_cents: feeCents, chapter_count: chapters } = input.fee;
      if (
        !Number.isSafeInteger(feeCents) ||
        feeCents < 0 ||
        !Number.isSafeInteger(chapters) ||
        chapters <= 0
      ) {
        return {
          ok: false,
          status: 422,
          code: "localization_fee_invalid",
          message:
            "A flat-fee localization contract carries a non-negative integer per-chapter fee and a positive integer chapter count.",
        };
      }
      localizerRoyaltyCents = feeCents * chapters;
    } else {
      const { rev_share_bps: revShareBps } = input.fee;
      if (!Number.isSafeInteger(revShareBps) || revShareBps < 0 || revShareBps > BPS_DENOMINATOR) {
        return {
          ok: false,
          status: 422,
          code: "localization_fee_invalid",
          message: "A rev-share localization contract carries whole basis points (0–10000).",
        };
      }
      localizerRoyaltyCents = Math.floor((feedNet * revShareBps) / BPS_DENOMINATOR);
    }
    if (localizerRoyaltyCents > feedNet) {
      return {
        ok: false,
        status: 422,
        code: "localization_fee_exceeds_feed",
        message: `The localization contract for "${input.localizer.payee_id}" reserves ${localizerRoyaltyCents} cents against a feed net of ${feedNet} — nothing cascades from a feed that cannot carry its own localizer.`,
      };
    }
  }

  // The studio split runs over what the localizer's royalty left.
  const postLocalizationNet = feedNet - localizerRoyaltyCents;
  const studio = buildWebtoonStudioSplitPlan({
    studio_pool_cents: postLocalizationNet,
    author_payee_id: input.author_payee_id,
    author_payee_name: input.author_payee_name,
    roles: input.roles,
  });
  if (!studio.ok) return studio;

  const partySplits: SplitPartyInput[] =
    input.localizer === null
      ? studio.value.party_splits
      : [
          {
            payee_id: input.localizer.payee_id,
            payee_name: input.localizer.payee_name,
            role: "creator",
            share_bps: 0, // The royalty is a flat/reserved amount, not a bps share.
          },
          ...studio.value.party_splits,
        ];

  return {
    ok: true,
    value: {
      feed_net_cents: feedNet,
      localizer: {
        payee_id: input.localizer?.payee_id ?? "",
        payee_name: input.localizer?.payee_name ?? "",
        royalty_cents: localizerRoyaltyCents,
      },
      studio: studio.value,
      company_dust_cents: studio.value.company_dust_cents,
      party_splits: partySplits,
    },
  };
}

// ---------------------------------------------------------------------------
// The deterministic localization amortization line — the PR 99 math (the
// VTuber tech-setup discipline): floor(total/periods) per line, the LAST
// line absorbing the integer-cent remainder.
// ---------------------------------------------------------------------------

/** The fee terms a release derives from the localization contract of record. */
function localizationFee(
  contract: WebtoonLocalizationContractRecord,
): WebtoonLocalizationFee {
  return contract.fee_mode === "flat_fee"
    ? {
        mode: "flat_fee",
        per_chapter_flat_fee_cents: contract.per_chapter_flat_fee_cents,
        chapter_count: 1, // One release amortizes one chapter's fee application.
      }
    : { mode: "rev_share", rev_share_bps: contract.rev_share_bps };
}

export function buildWebtoonLocalizationAmortizationLine(
  totalCostCents: number,
  amortizationPeriods: number,
  lineIndex: number,
): number {
  const base = Math.floor(totalCostCents / amortizationPeriods);
  return lineIndex < amortizationPeriods - 1
    ? base
    : totalCostCents - base * (amortizationPeriods - 1);
}

// ---------------------------------------------------------------------------
// The escrow lock — a foreign feed's translation royalty, pending.
// ---------------------------------------------------------------------------

/**
 * Where the locked royalty arrived from — the recovery linkage. The GL
 * post-journal carries this as its ref, and a match_queue-sourced royalty
 * ALSO stamps the quarantined statement line's event_id into line_item_id
 * (the VTuber holdback's convention — no new index or column).
 */
export type TranslationEscrowReceiptSource =
  | { type: "match_queue"; event_id: string }
  | { type: "recon_job"; job_id: string }
  | { type: "manual"; note: string };

export interface TranslationEscrowPostInput {
  /** The series whose foreign feed earned the royalty. */
  series_id: string;
  /** The language feed's code (the match_queue.language_code vocabulary). */
  language_code: string;
  /** The translation royalty receipt, integer cents. */
  amount_cents: number;
  currency: string;
  source: TranslationEscrowReceiptSource;
}

export type TranslationEscrowPostSuccess = {
  ok: true;
  value: {
    /** The locked receipt — kind and status both 'translation_localization_pending'. */
    escrow_credit: LedgerTransactionRecord;
    journal_id: string;
  };
};

/**
 * Locks one language feed's translation royalty into the per-language
 * escrow. The money's GL leg is an FBO debit (cash arrived) against a
 * credit on the feed's escrow account — no vault is minted, no payee is
 * credited, no dust row is written, and nothing cascades yet: the lock is
 * the point. Journal-ref-guarded per source (409 on re-post).
 */
export async function postTranslationRoyaltyToEscrow(
  store: Store,
  input: TranslationEscrowPostInput,
  now: Date = new Date(),
): Promise<TranslationEscrowPostSuccess | WebtoonCascadeFailure> {
  if (input.series_id.trim() === "" || input.language_code.trim() === "") {
    return {
      ok: false,
      status: 422,
      code: "invalid_escrow_input",
      message: "A translation escrow receipt names its series and language feed.",
    };
  }
  if (!Number.isSafeInteger(input.amount_cents) || input.amount_cents <= 0) {
    return {
      ok: false,
      status: 422,
      code: "invalid_amount",
      message: "Translation escrow receipts post integer cents greater than zero.",
    };
  }

  const source = input.source;
  const refType =
    source.type === "match_queue"
      ? "match_queue"
      : source.type === "recon_job"
        ? "recon_job"
        : "ledger_transaction";
  const sourceRefId =
    source.type === "match_queue"
      ? source.event_id
      : source.type === "recon_job"
        ? source.job_id
        : "";

  // Replay guard: one post per source id — the journal ref is the marker
  // (listGlJournalsByRef is indexed on (ref_type, ref_id), migration 0006).
  if (sourceRefId !== "") {
    const prior = await store.listGlJournalsByRef(refType, sourceRefId);
    if (prior.length > 0) {
      return {
        ok: false,
        status: 409,
        code: "translation_royalty_already_posted",
        message: `A translation escrow receipt for ${refType} "${sourceRefId}" was already posted (${prior.length} journal(s) ref it).`,
      };
    }
  }

  const createdAt = now.toISOString();
  const credit = await store.insertLedgerTransaction({
    split_run_id: "",
    // For match_queue-sourced posts the quarantined statement line IS the
    // source line — the row-level recovery linkage rides the existing
    // line-item index.
    line_item_id: source.type === "match_queue" ? source.event_id : "",
    payee_id: translationLocalizationPayeeId(input.series_id, input.language_code),
    payee_name: translationLocalizationPayeeName(input.series_id, input.language_code),
    role: "other",
    share_bps: 0,
    amount_cents: input.amount_cents,
    currency: input.currency,
    status: "translation_localization_pending",
    rail: null,
    baas_provider: null,
    baas_transfer_id: null,
    created_at: createdAt,
    settled_at: null,
    kind: "translation_localization_pending",
  });

  const posted = await postJournal(store, {
    kind: "translation_localization_post",
    ref_type: refType,
    ref_id: sourceRefId === "" ? credit.id : sourceRefId,
    legs: [
      fboDebit(input.amount_cents),
      translationLocalizationCredit(input.series_id, input.language_code, input.amount_cents),
    ],
  });
  if (!posted.ok) {
    return { ok: false, status: 500, code: posted.code, message: posted.message };
  }
  return {
    ok: true,
    value: { escrow_credit: credit, journal_id: posted.journal.id },
  };
}

// ---------------------------------------------------------------------------
// The verified release — the cost gate, the cascade, the canonical order.
// ---------------------------------------------------------------------------

export interface TranslationEscrowReleaseInput {
  /** The locked escrow receipt to release (the ledger row id). */
  escrow_ledger_id: string;
  /**
   * The primary author of record — the cascade's residual holder, paid
   * LAST. The caller supplies the identity (the VTuber release's
   * agency-identity precedent); the localizer comes from the contract.
   */
  author_payee_id: string;
  author_payee_name: string;
  /** The localization cost schedule amortizing this release; null = none. */
  amortization_schedule_ref: string | null;
  /** The clearance gate's first condition — fail-closed on anything but true. */
  operator_settlement_approved: boolean;
}

/** One credited party's cascade outcome — gross and post-withholding net. */
export type WebtoonCascadeCredit = {
  payee_id: string;
  payee_name: string;
  /** What the cascade step reserved for the party, integer cents. */
  gross_cents: number;
  /** What landed in the party's vault after withholding/recoupment. */
  net_cents: number;
  /** The cascade step the credit rode (the audit trail's label). */
  step:
    | "localization_cost_recovery"
    | "localizer_royalty"
    | "studio_role"
    | "primary_author_net";
};

export type TranslationEscrowReleaseSuccess = {
  ok: true;
  value: {
    /** The released row — status 'settled', kind still 'translation_localization_pending'. */
    escrow_credit: LedgerTransactionRecord;
    /** The cascade plan as executed — the founder's order, with the math. */
    plan: WebtoonTranslationCascadePlan;
    /** The amortization line this release consumed, when a schedule rode. */
    amortization: {
      line_index: number;
      computed_cents: number;
      applied_cents: number;
    } | null;
    /** Per-party outcome in cascade order (cost recovery, localizer, studio, author). */
    credits: WebtoonCascadeCredit[];
    company_dust_cents: number;
    dust_ledger: CompanyDustRecord[];
    /** The withholding escrow rows the creator credits wrote. */
    withholding: TaxEscrowRecord[];
    journal_id: string;
  };
};

/**
 * The insert-as-lock amortization consume arbiter (the PR 12 accumulator /
 * PR 99 discipline): the line's index derives from the append-only lines
 * list, and the UNIQUE (schedule_ref, line_index) index is what a
 * concurrent consume loses on. The loser of a line index never loses its
 * money — it re-derives and retries. Bounded: the schedule has finitely
 * many periods. The applied cents are the deterministic line CAPPED by the
 * caller's cap (the release's honest shortfall carry, recorded on the line).
 */
async function consumeNextLocalizationLine(
  store: Store,
  scheduleRef: string,
  capCents: number,
  releasedInLedgerId: string,
  now: Date,
): Promise<
  | {
      ok: true;
      consumption: { line_index: number; computed_cents: number; applied_cents: number };
    }
  | { ok: false; code: "localization_cost_schedule_completed" }
> {
  for (;;) {
    const schedule = await store.getWebtoonLocalizationCostScheduleByRef(scheduleRef);
    if (schedule === undefined) {
      // Unreachable in the release path (the schedule is resolved and
      // checked before the CAS) — the typed refusal keeps the helper honest
      // for any caller.
      return { ok: false, code: "localization_cost_schedule_completed" };
    }
    const lines = await store.listWebtoonLocalizationCostLines(scheduleRef);
    const lineIndex = lines.length;
    if (lineIndex >= schedule.amortization_periods) {
      return { ok: false, code: "localization_cost_schedule_completed" };
    }
    const computedCents = buildWebtoonLocalizationAmortizationLine(
      schedule.total_cost_cents,
      schedule.amortization_periods,
      lineIndex,
    );
    const appliedCents = Math.min(computedCents, capCents);
    try {
      await store.insertWebtoonLocalizationCostLine({
        schedule_ref: scheduleRef,
        line_index: lineIndex,
        amount_cents: appliedCents,
        released_in_ledger_id: releasedInLedgerId,
        created_at: now.toISOString(),
      });
      return {
        ok: true,
        consumption: {
          line_index: lineIndex,
          computed_cents: computedCents,
          applied_cents: appliedCents,
        },
      };
    } catch {
      // Lost the line to a concurrent consume — re-derive and retry.
    }
  }
}

/**
 * Releases one locked translation royalty through the per-language cascade:
 *
 *   1. the escrow row must be LOCKED (404 absent / 422 wrong kind / 409 no
 *      longer pending — a replayed release reads the CAS or this, never a
 *      double payout),
 *   2. the localization contract of record must exist for the feed (422 —
 *      the cascade's localizer comes from the contract, never the caller),
 *   3. the cost gate: when a schedule rides, it must belong to THIS feed
 *      and its next deterministic line must resolve (409 when every period
 *      consumed — the escrow's purpose is spent),
 *   4. the cascade plan builds over the post-amortization feed net
 *      (fail-closed: fees over the feed refuse; bands enforce),
 *   5. every credited party passes the PUBLISHING vertical's fail-closed
 *      payout gate (operator settlement approval, verified KYC,
 *      ip-rights-cleared state) — the platform recovery payee is the house
 *      payee and is skipped, exactly as the VTuber stack skips it,
 *   6. the settle CAS wins BEFORE any money moves (the concurrent loser
 *      reads undefined and 409s; the amortization line consumes only after
 *      the win — a gate refusal or a lost CAS must never consume a line),
 *   7. the routing, in the founder's mandated order: the localization cost
 *      recovery, the localizer's royalty, the studio role groups, the
 *      primary author's net — every payee riding the recoupment-sweep
 *      credit discipline, withholding on creator roles, dust swept to the
 *      platform variance account, and the zero-balance tripwire before the
 *      release journal posts.
 */
export async function releaseTranslationLocalizationEscrow(
  store: Store,
  input: TranslationEscrowReleaseInput,
  now: Date = new Date(),
): Promise<TranslationEscrowReleaseSuccess | WebtoonCascadeFailure> {
  const row = await store.getLedgerTransaction(input.escrow_ledger_id);
  if (row === undefined) {
    return {
      ok: false,
      status: 404,
      code: "escrow_receipt_not_found",
      message: "No ledger transaction matches that id.",
    };
  }
  if (row.kind !== "translation_localization_pending") {
    return {
      ok: false,
      status: 422,
      code: "not_a_translation_escrow_receipt",
      message: `Ledger transaction ${row.id} is kind "${row.kind}" — only translation-localization escrow receipts release here.`,
    };
  }
  if (row.status !== "translation_localization_pending") {
    return {
      ok: false,
      status: 409,
      code: "escrow_already_released",
      message: `Translation escrow receipt ${row.id} is no longer locked (status "${row.status}").`,
    };
  }
  const feed = parseTranslationLocalizationPayeeId(row.payee_id);
  if (feed === undefined) {
    return {
      ok: false,
      status: 500,
      code: "escrow_payee_corrupted",
      message: `Escrow receipt ${row.id} carries payee "${row.payee_id}" — not a translation-localization escrow payee.`,
    };
  }
  if (input.author_payee_id === "" || input.author_payee_name === "") {
    return {
      ok: false,
      status: 422,
      code: "invalid_author_identity",
      message: "A translation escrow release names the primary author (id and name of record).",
    };
  }

  // The localizer of record comes from the contract table — never the
  // caller's restatement of it.
  const contract = await store.getWebtoonLocalizationContract(
    feed.seriesId,
    feed.languageCode,
  );
  if (contract === undefined) {
    return {
      ok: false,
      status: 422,
      code: "missing_localization_contract",
      message: `No localization contract of record exists for series "${feed.seriesId}" language "${feed.languageCode}" — register the contract before releasing the feed's escrow.`,
    };
  }

  // The cost gate — the schedule resolves BEFORE the gates so a missing or
  // completed schedule refuses without taking the CAS lock. The schedule
  // must belong to THIS feed (a foreign schedule is a mis-wired release).
  let schedule: WebtoonLocalizationCostScheduleRecord | undefined;
  let amortizationCandidateCents = 0;
  if (input.amortization_schedule_ref !== null) {
    schedule = await store.getWebtoonLocalizationCostScheduleByRef(
      input.amortization_schedule_ref,
    );
    if (schedule === undefined) {
      return {
        ok: false,
        status: 422,
        code: "localization_cost_schedule_not_found",
        message: `No localization cost schedule matches "${input.amortization_schedule_ref}".`,
      };
    }
    if (schedule.series_id !== feed.seriesId || schedule.language_code !== feed.languageCode) {
      return {
        ok: false,
        status: 422,
        code: "localization_cost_schedule_mismatch",
        message: `Cost schedule "${input.amortization_schedule_ref}" belongs to series "${schedule.series_id}" (${schedule.language_code}) — not this feed (${feed.seriesId}, ${feed.languageCode}).`,
      };
    }
    const lines = await store.listWebtoonLocalizationCostLines(input.amortization_schedule_ref);
    if (lines.length >= schedule.amortization_periods) {
      return {
        ok: false,
        status: 409,
        code: "localization_cost_schedule_completed",
        message: `Cost schedule "${input.amortization_schedule_ref}" has consumed every period.`,
      };
    }
    // The deterministic candidate for the next period, capped by what the
    // escrow actually holds — the plan's honest shortfall carry.
    amortizationCandidateCents = Math.min(
      buildWebtoonLocalizationAmortizationLine(
        schedule.total_cost_cents,
        schedule.amortization_periods,
        lines.length,
      ),
      row.amount_cents,
    );
  }

  // THE cascade plan — built over what is actually HELD (the escrow row's
  // amount of record, less the cost-recovery line), with the localizer and
  // the fee terms from the contract of record. Reassignable: the post-CAS
  // drift handler below rebuilds it when a concurrent consume moves the
  // schedule's line.
  const roles = await store.listWebtoonStudioSplitRoles(feed.seriesId);
  const planned = buildWebtoonTranslationCascadePlan({
    feed_net_cents: row.amount_cents - amortizationCandidateCents,
    localizer: {
      payee_id: contract.localizer_payee_id,
      payee_name: contract.localizer_payee_name,
    },
    fee: localizationFee(contract),
    author_payee_id: input.author_payee_id,
    author_payee_name: input.author_payee_name,
    roles,
  });
  if (!planned.ok) return planned;
  let plan: WebtoonTranslationCascadePlan = planned.value;

  // The clearance gate — every credited payee rides the SAME fail-closed
  // payout compliance gate as a Lithic dispatch, on the PUBLISHING vertical
  // (ip_rights_cleared — the founder canon; the state source resolves the
  // durable verification state). The platform house payee holds no KYC
  // record by design and is skipped. Runs before the CAS on the candidate
  // plan, and again on any post-CAS rebuild (the drift handler below).
  const verticalStateSource = getVerticalComplianceStateSource();
  const runComplianceGate = async (
    cascadePlan: WebtoonTranslationCascadePlan,
  ): Promise<WebtoonCascadeFailure | null> => {
    const gatedParties: Array<{ payee_id: string; payee_name: string }> = [
      ...(cascadePlan.localizer.royalty_cents > 0
        ? [
            {
              payee_id: cascadePlan.localizer.payee_id,
              payee_name: cascadePlan.localizer.payee_name,
            },
          ]
        : []),
      ...cascadePlan.studio.groups.flatMap((group) =>
        group.members.map((member) => ({
          payee_id: member.payee_id,
          payee_name: member.payee_name,
        })),
      ),
      ...(cascadePlan.studio.author.net_cents > 0
        ? [
            {
              payee_id: cascadePlan.studio.author.payee_id,
              payee_name: cascadePlan.studio.author.payee_name,
            },
          ]
        : []),
    ];
    for (const party of gatedParties) {
      if (party.payee_id === COMPANY_VARIANCE_PAYEE_ID) continue;
      const kycStatus = await resolveCreatorKycStatus(store, party.payee_id);
      const verticalState = await verticalStateSource({
        payeeId: party.payee_id,
        vertical: WEBTOON_CASCADE_VERTICAL,
      });
      const compliance = evaluatePayoutCompliance({
        operatorSettlementApproved: input.operator_settlement_approved,
        kycStatus,
        verticalState,
      });
      if (!compliance.ok) {
        return {
          ok: false,
          status: 403,
          code: compliance.code,
          message: `Translation cascade release refused for payee "${party.payee_id}": ${compliance.message}`,
        };
      }
    }
    return null;
  };
  const gateFailure = await runComplianceGate(plan);
  if (gateFailure !== null) return gateFailure;

  // The CAS wins BEFORE any money moves (the conditional settle): the
  // concurrent release loser reads undefined here and refuses with the
  // same 409 a replayed release gets. The settled row with no
  // translation_localization_release journal is the visible alarm.
  const settled = await store.settleTranslationLocalizationEscrow(
    row.id,
    now.toISOString(),
  );
  if (settled === undefined) {
    return {
      ok: false,
      status: 409,
      code: "escrow_already_released",
      message: `Translation escrow receipt ${row.id} is no longer locked — a concurrent release won.`,
    };
  }

  // The amortization line consumes AFTER the CAS win (a gate refusal or a
  // lost CAS must never consume a schedule line). The cap is the escrow's
  // amount of record; the drift handler below re-syncs the routing when a
  // concurrent release on the SAME schedule moved the line between the
  // candidate read and this CAS win.
  let amortization: TranslationEscrowReleaseSuccess["value"]["amortization"] = null;
  if (schedule !== undefined && input.amortization_schedule_ref !== null) {
    const consumed = await consumeNextLocalizationLine(
      store,
      input.amortization_schedule_ref,
      row.amount_cents,
      row.id,
      now,
    );
    if (!consumed.ok) {
      return {
        ok: false,
        status: 500,
        code: "localization_cost_schedule_completed",
        message: `Cost schedule "${input.amortization_schedule_ref}" completed mid-release — the receipt is settled but nothing routed; re-run the release.`,
      };
    }
    amortization = {
      line_index: consumed.consumption.line_index,
      computed_cents: consumed.consumption.computed_cents,
      applied_cents: Math.min(consumed.consumption.computed_cents, row.amount_cents),
    };
    // The drift handler — a concurrent release on the SAME schedule may have
    // consumed a line between the candidate read and this CAS win. The
    // consumed line is the recovery's authority: route its APPLIED amount
    // (never the stale pre-CAS candidate) and rebuild the cascade over the
    // true post-recovery remainder, re-running the fail-closed gate past the
    // CAS. A refusal here leaves the settled receipt with nothing routed —
    // the visible alarm (the same shape as the consume-failure refusal
    // above); the common no-race path is untouched (applied === candidate).
    if (consumed.consumption.applied_cents !== amortizationCandidateCents) {
      amortizationCandidateCents = consumed.consumption.applied_cents;
      const rebuilt = buildWebtoonTranslationCascadePlan({
        feed_net_cents: row.amount_cents - amortizationCandidateCents,
        localizer: {
          payee_id: contract.localizer_payee_id,
          payee_name: contract.localizer_payee_name,
        },
        fee: localizationFee(contract),
        author_payee_id: input.author_payee_id,
        author_payee_name: input.author_payee_name,
        roles,
      });
      if (!rebuilt.ok) return rebuilt;
      plan = rebuilt.value;
      const regateFailure = await runComplianceGate(plan);
      if (regateFailure !== null) return regateFailure;
    }
  }

  // The routing, in the founder's mandated order. Every branch conserves
  // its cents; every creator credit rides the esports waterfall's
  // discipline: the catalog-dispute freeze check, then the recoupment sweep
  // (a payee with a recoupment advance has incoming swept to the company
  // before any excess lands) — never a bare vault credit.
  const glLegs: GlLegInput[] = [
    translationLocalizationDebit(feed.seriesId, feed.languageCode, row.amount_cents),
  ];
  const withholding: TaxEscrowRecord[] = [];
  const dustLedger: CompanyDustRecord[] = [];
  const credits: WebtoonCascadeCredit[] = [];

  /**
   * Credits one payee exactly the way the esports waterfall credits a
   * participant: freeze check → recoupment sweep (its own vault writes;
   * the GL legs mirror them) → bare pending credit when no advance exists.
   * Returns the cents that landed in the payee's vault (withheld and
   * recouped cents never reach the payee).
   */
  const creditCascadePayee = async (
    payeeId: string,
    payeeName: string,
    cents: number,
  ): Promise<number> => {
    if (cents <= 0) return 0;
    // No work context exists on an escrow receipt — the catalog-dispute
    // freeze check runs against the empty work key, which no dispute row
    // occupies (honest not-frozen, not a skipped check).
    const incomingFrozen = await isIncomingFrozen(store, payeeId, "");
    const recouped = await applyRecoupmentSweep(store, payeeId, payeeName, cents, now, {
      excess_target: incomingFrozen ? "reserve" : "available",
    });
    if (recouped.applied) {
      if (recouped.recouped_cents > 0) {
        glLegs.push(
          vaultCredit(COMPANY_VARIANCE_PAYEE_ID, "available", recouped.recouped_cents),
        );
      }
      if (recouped.excess_cents > 0) {
        await creditVault(
          store,
          payeeId,
          payeeName,
          recouped.excess_cents,
          incomingFrozen ? "reserve" : "available",
          now,
        );
        glLegs.push(
          vaultCredit(payeeId, incomingFrozen ? "reserve" : "available", recouped.excess_cents),
        );
      }
      return recouped.excess_cents;
    }
    await creditVault(store, payeeId, payeeName, cents, "pending", now);
    glLegs.push(vaultCredit(payeeId, "pending", cents));
    return cents;
  };

  /**
   * Credits a TALENT payee through the tax stack first: the withholding
   * comes off the top (its reserve credit + GL leg), then the net rides
   * the same recoupment-sweep discipline. Every cascade party — localizer,
   * studio members, primary author — is talent (role 'creator'), so the
   * standing withholding gate treats them identically.
   */
  const creditTaxedCascadePayee = async (
    payeeId: string,
    payeeName: string,
    grossCents: number,
  ): Promise<number> => {
    if (grossCents <= 0) return 0;
    let creditAmount = grossCents;
    if (isWithholdableTalentRole("creator")) {
      const taxed = await applyWithholding(store, {
        creator_id: payeeId,
        gross_cents: grossCents,
        tax_year: now.getUTCFullYear(),
      });
      withholding.push(taxed.value.escrow);
      creditAmount = taxed.value.net_cents;
      if (taxed.value.withheld_cents > 0) {
        await creditVault(store, payeeId, payeeName, taxed.value.withheld_cents, "reserve", now);
        glLegs.push(vaultCredit(payeeId, "reserve", taxed.value.withheld_cents));
      }
    }
    return creditCascadePayee(payeeId, payeeName, creditAmount);
  };

  // Step 1 — the localization cost recovery. The platform fronted the
  // localization program; the amortized line's cents return to the house
  // payee (named in the plan and the journal — never folded into dust).
  if (amortizationCandidateCents > 0) {
    await creditVault(
      store,
      COMPANY_VARIANCE_PAYEE_ID,
      COMPANY_VARIANCE_PAYEE_NAME,
      amortizationCandidateCents,
      "pending",
      now,
    );
    glLegs.push(
      vaultCredit(COMPANY_VARIANCE_PAYEE_ID, "pending", amortizationCandidateCents),
    );
    credits.push({
      payee_id: COMPANY_VARIANCE_PAYEE_ID,
      payee_name: COMPANY_VARIANCE_PAYEE_NAME,
      gross_cents: amortizationCandidateCents,
      net_cents: amortizationCandidateCents,
      step: "localization_cost_recovery",
    });
  }

  // Step 2 — the LOCALIZER's royalty, before any studio share or author net
  // (withheld like every other talent party).
  if (plan.localizer.royalty_cents > 0) {
    const credited = await creditTaxedCascadePayee(
      plan.localizer.payee_id,
      plan.localizer.payee_name,
      plan.localizer.royalty_cents,
    );
    credits.push({
      payee_id: plan.localizer.payee_id,
      payee_name: plan.localizer.payee_name,
      gross_cents: plan.localizer.royalty_cents,
      net_cents: credited,
      step: "localizer_royalty",
    });
  }

  // Step 3 — the studio role groups, band order.
  for (const group of plan.studio.groups) {
    for (const member of group.members) {
      // A floored-to-zero share still reports — gross 0, net 0.
      const credited = await creditTaxedCascadePayee(
        member.payee_id,
        member.payee_name,
        member.amount_cents,
      );
      credits.push({
        payee_id: member.payee_id,
        payee_name: member.payee_name,
        gross_cents: member.amount_cents,
        net_cents: credited,
        step: "studio_role",
      });
    }
  }

  // Step 4 — the primary author's net, LAST (the residual is what survives
  // the cascade).
  if (plan.studio.author.net_cents > 0) {
    const credited = await creditTaxedCascadePayee(
      plan.studio.author.payee_id,
      plan.studio.author.payee_name,
      plan.studio.author.net_cents,
    );
    credits.push({
      payee_id: plan.studio.author.payee_id,
      payee_name: plan.studio.author.payee_name,
      gross_cents: plan.studio.author.net_cents,
      net_cents: credited,
      step: "primary_author_net",
    });
  }

  // The integer-cent dust — swept to the platform variance account, its own
  // ledger rows (the house dust discipline).
  if (plan.company_dust_cents > 0) {
    dustLedger.push(
      await store.insertCompanyDust({
        split_run_id: row.split_run_id,
        line_item_id: row.line_item_id,
        amount_cents: plan.company_dust_cents,
        variance_account_id: COMPANY_VARIANCE_PAYEE_ID,
        created_at: now.toISOString(),
      }),
    );
    await creditVault(
      store,
      COMPANY_VARIANCE_PAYEE_ID,
      COMPANY_VARIANCE_PAYEE_NAME,
      plan.company_dust_cents,
      "pending",
      now,
    );
    glLegs.push(vaultCredit(COMPANY_VARIANCE_PAYEE_ID, "pending", plan.company_dust_cents));
  }

  // The zero-balance tripwire: cost recovery + localizer + studio members +
  // author + dust === the locked receipt, ALWAYS.
  const routedTotal = credits.reduce((total, credit) => total + credit.gross_cents, 0);
  if (
    !zeroBalanceHolds(
      row.amount_cents,
      credits.map((credit) => ({ amount_cents: credit.gross_cents })),
      plan.company_dust_cents,
    ) ||
    routedTotal + plan.company_dust_cents !== row.amount_cents
  ) {
    return {
      ok: false,
      status: 500,
      code: "zero_balance_violation",
      message:
        "Cost recovery + localizer + studio split + author + dust !== locked receipt — release refused.",
    };
  }

  const posted = await postJournal(store, {
    kind: "translation_localization_release",
    ref_type: "ledger_transaction",
    ref_id: row.id,
    legs: glLegs,
  });
  if (!posted.ok) {
    return { ok: false, status: 500, code: posted.code, message: posted.message };
  }

  return {
    ok: true,
    value: {
      escrow_credit: settled,
      plan,
      amortization,
      credits,
      company_dust_cents: plan.company_dust_cents,
      dust_ledger: dustLedger,
      withholding,
      journal_id: posted.journal.id,
    },
  };
}

// ---------------------------------------------------------------------------
// The isolated recoupment pools — print advance vs digital coin unlock.
// ---------------------------------------------------------------------------

export interface WebtoonRecoupmentApplicationInput {
  /** The series the revenue event belongs to. */
  series_id: string;
  /**
   * The pool class this revenue recoups — chosen EXPLICITLY by the caller
   * per revenue event (print edition vs coin unlock lane). The isolation
   * rule IS this parameter: nothing infers it, and a print event can never
   * reach the coin pool or vice versa.
   */
  pool_class: WebtoonRecoupmentPoolClass;
  /** The revenue event's content-derived id — the replay guard. */
  source_event_id: string;
  /** The revenue event's amount, integer cents. */
  revenue_cents: number;
}

export type WebtoonRecoupmentApplySuccess = {
  ok: true;
  value: {
    /** The application row — the append-only recovery ledger's new entry. */
    application: WebtoonRecoupmentApplicationRecord | null;
    /** The integer cents applied this call (0 when the pool is spent). */
    applied_cents: number;
    /** The pool's open balance after this application. */
    remaining_cents: number;
    /** The pool's status after this application. */
    pool_status: "active" | "recouped";
  };
};

/**
 * Applies one revenue event to its pool of record — the ISOLATION lane:
 *
 *   1. the pool resolves by (series, class) — the caller's explicit class
 *      is the firewall; a print event names print_advance and can never
 *      touch the digital_coin_unlock pool (404 when unregistered),
 *   2. a replayed event is refused 409 (the application's unique
 *      (pool_id, source_event_id) key — never a double recovery),
 *   3. the applied cents are min(open balance, revenue) — exact integer
 *      cents, never a negative pool,
 *   4. the POSITION lock (unique (pool_id, recouped_before_cents))
 *      arbitrates concurrent applications — the PR 12/PR 99 insert-as-lock
 *      discipline; the loser re-derives from the append-only truth and
 *      retries,
 *   5. the pool's derived counter and status track the applications
 *      (best-effort bookkeeping — the append-only rows are the truth), and
 *      a pool whose recovery completes flips to 'recouped'.
 */
export async function applyWebtoonRecoupment(
  store: Store,
  input: WebtoonRecoupmentApplicationInput,
  now: Date = new Date(),
): Promise<WebtoonRecoupmentApplySuccess | WebtoonCascadeFailure> {
  if (input.series_id.trim() === "" || input.source_event_id.trim() === "") {
    return {
      ok: false,
      status: 422,
      code: "invalid_recoupment_input",
      message: "A recoupment application names its series and its revenue event.",
    };
  }
  if (!Number.isSafeInteger(input.revenue_cents) || input.revenue_cents <= 0) {
    return {
      ok: false,
      status: 422,
      code: "invalid_amount",
      message: "Recoupment applies integer cents of revenue greater than zero.",
    };
  }

  for (;;) {
    const pool = await store.getWebtoonRecoupmentPool(input.series_id, input.pool_class);
    if (pool === undefined) {
      return {
        ok: false,
        status: 404,
        code: "recoupment_pool_not_registered",
        message: `No ${input.pool_class} recoupment pool is registered for series "${input.series_id}" — register the advance before applying revenue.`,
      };
    }
    if (pool.status === "recouped") {
      return {
        ok: true,
        value: {
          application: null,
          applied_cents: 0,
          remaining_cents: 0,
          pool_status: "recouped",
        },
      };
    }

    // Replay guard FIRST (cheap, before any position math): the same event
    // already applied → 409, never a double recovery.
    const applications = await store.listWebtoonRecoupmentApplications(pool.id);
    if (applications.some((row) => row.source_event_id === input.source_event_id)) {
      return {
        ok: false,
        status: 409,
        code: "recoupment_event_already_applied",
        message: `Recoupment event "${input.source_event_id}" was already applied to the ${input.pool_class} pool for series "${input.series_id}".`,
      };
    }

    // The append-only rows are the truth; the derived position is their Σ.
    const recoupedBefore = applications.reduce((sum, row) => sum + row.applied_cents, 0);
    const remaining = pool.advance_cents - recoupedBefore;
    if (remaining <= 0) {
      // The rows say the pool is spent — reconcile the counter and flip.
      await store.updateWebtoonRecoupmentPoolProgress(
        pool.id,
        recoupedBefore,
        "recouped",
        now.toISOString(),
      );
      return {
        ok: true,
        value: {
          application: null,
          applied_cents: 0,
          remaining_cents: 0,
          pool_status: "recouped",
        },
      };
    }
    const appliedCents = Math.min(remaining, input.revenue_cents);
    const remainingAfter = remaining - appliedCents;
    try {
      const application = await store.insertWebtoonRecoupmentApplication({
        pool_id: pool.id,
        pool_class: input.pool_class,
        source_event_id: input.source_event_id,
        recouped_before_cents: recoupedBefore,
        applied_cents: appliedCents,
        remaining_cents: remainingAfter,
        created_at: now.toISOString(),
      });
      // Won the position — the pool's derived counter and status track it
      // (bookkeeping; the append-only row is the commit).
      await store.updateWebtoonRecoupmentPoolProgress(
        pool.id,
        recoupedBefore + appliedCents,
        remainingAfter === 0 ? "recouped" : "active",
        now.toISOString(),
      );
      return {
        ok: true,
        value: {
          application,
          applied_cents: appliedCents,
          remaining_cents: remainingAfter,
          pool_status: remainingAfter === 0 ? "recouped" : "active",
        },
      };
    } catch {
      // Lost the position (or raced a twin of the same event) — re-derive
      // from the append-only truth and retry. Bounded: the pool has
      // finitely many positions.
    }
  }
}
