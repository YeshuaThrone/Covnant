/**
 * The brand-licensing royalty cascade (PR 32, the founder Net Sales + tiered
 * royalties + sub-license cascade directive) — the books/art/theatrical
 * cascade discipline applied to license-scope money.
 *
 * Consumes the recon write pass's outcomes (the Net Licensed Sales computed
 * ONCE at write time — this pass never recomputes) and executes:
 *
 *   1. THE TIER WALK — a non-sub-license row's net sales walks the deal's
 *      marginal tier schedule from the deal's cumulative position (the
 *      state that carries ACROSS reporting periods). The walk commits as
 *      the position-locked, replay-guarded application row; the deal's
 *      counters advance as bookkeeping (the append-only rows are the
 *      truth — a re-derivation from them heals any drift).
 *   2. AGENCY COMMISSION ORDERING — the deal's commission (the founder
 *      1500–3500 bps band) deducts from the walk's earned GROSS royalty
 *      BEFORE the split or withholding is computed — the application
 *      row's conservation identity pins the ordering.
 *   3. THE DUAL-IP SPLIT — a co-branded deal's post-agency royalty divides
 *      50-50 between both licensor ledgers (floor/floor, the odd-cent
 *      residue to dust_cents).
 *   4. TREATY WITHHOLDING — an international sale (the row's source
 *      territory ≠ licensor A's residence country) prices the
 *      double-taxation treaty rate of record per (source, residence); an
 *      uncovered pair falls to the deal's statutory default; with neither
 *      the payout legs are HELD (withheld legs null — recorded, never
 *      guessed, fail-closed).
 *   5. THE SUB-LICENSE CASCADE — a wholesale manifest row attributed to a
 *      registered regional sub-licensee walks the MASTER ROYALTY OVERRIDE
 *      instead of the tier table: the report of record is written with its
 *      own recorded legs and the computed master royalty, audit state
 *      'unknown'. The net proceeds release is FAIL-CLOSED: 'unknown' holds
 *      the master royalty, only 'reconciled' (the store's evidenced CAS —
 *      the promoter audit-close discipline) releases it, and the release
 *      post is once-only per source event (the holding 409 guard).
 *
 * Every branch is idempotent (replays are counted no-ops through the
 * UNIQUE guards); a pass failure throws — the job fails with its
 * row-scoped reason and a retry heals idempotently.
 */

import type { Store } from "@/lib/server/store";
import { recoupLicensingRoyaltyEvent } from "@/lib/server/licensingMgLedger";
import { isUniqueViolation } from "@/lib/server/uniqueViolation";
import type { LicensingLineOutcome } from "@/workers/recon/licensingQueue";
import {
  agencyCommissionCents,
  dualIpSplitCents,
  licensingScopeKey,
  masterOverrideRoyaltyCents,
  netLicensedSalesCents,
  tieredRoyaltyWalk,
  treatyWithholdingCents,
} from "@/workers/recon/licensing";
import {
  postToUnclaimedHolding,
  type UnclaimedHoldingFailure,
  type UnclaimedHoldingPostSuccess,
} from "@/lib/server/unclaimedHolding";

/** The position-lock retry budget — a concurrent walk's re-reads before the
 * pass treats the event as replayed (the append-only truth governs; a
 * later pass heals). */
const POSITION_RETRY_BUDGET = 3;

/** Cascade counts for one licensing ingest — the honest completion report's inputs. */
export interface LicensingCascadeCounts {
  /** Money rows that walked the tier schedule and committed an application. */
  applicationsCommitted: number;
  /** Rows whose application already existed (the replay guard) or whose
   * position race exhausted the retry budget — counted no-ops. */
  applicationsReplayed: number;
  /** Money rows with no deal of record — skipped fail-closed (the posted
   * net stays in holding; the walk never guesses a schedule). */
  skippedNoDeal: number;
  /** Money rows whose currency mismatches the deal of record — skipped
   * fail-closed (the art lane's discipline). */
  skippedCurrencyMismatch: number;
  /** Sub-license gross reports written (audit state 'unknown'). */
  subReportsWritten: number;
  /** Sub-license reports already of record (the once-only key converged). */
  subReportsReplayed: number;
  /** Reconciled sub-license reports whose master royalty released to
   * holding this pass. */
  subReleasesPosted: number;
  /** Sub-license releases that hit the per-source replay guard (no-ops). */
  subReleasesReplayed: number;
  /** Sub-license reports held pending audit reconciliation — the
   * fail-closed gate's counted refusals. */
  subHeldPendingAudit: number;
  /** Sub-license rows with no registered sub-licensee — skipped
   * fail-closed (never a guessed override). */
  skippedNoSubLicensee: number;
  /** The walk's earned gross royalties, whole cents (pre-agency). */
  royaltyGrossCents: number;
  /** The agency commission deducted, whole cents. */
  agencyCommissionCents: number;
  /** The withholding held back across licensor legs, whole cents. */
  withheldCents: number;
  /** Licensor payout legs HELD (null withheld legs) — fail-closed. */
  payoutLegsHeld: number;
  /** MG recoupment applications committed this pass (PR 33) — the
   * post-agency earned royalty offsetting registered advances. */
  mgRecoupmentApplications: number;
}

export function emptyLicensingCascadeCounts(): LicensingCascadeCounts {
  return {
    applicationsCommitted: 0,
    applicationsReplayed: 0,
    skippedNoDeal: 0,
    skippedCurrencyMismatch: 0,
    subReportsWritten: 0,
    subReportsReplayed: 0,
    subReleasesPosted: 0,
    subReleasesReplayed: 0,
    subHeldPendingAudit: 0,
    skippedNoSubLicensee: 0,
    royaltyGrossCents: 0,
    agencyCommissionCents: 0,
    withheldCents: 0,
    payoutLegsHeld: 0,
    mgRecoupmentApplications: 0,
  };
}

/** The master-royalty release post's replay refusal — a 409 is a no-op. */
function isReplayRefusal(failure: UnclaimedHoldingFailure): boolean {
  return failure.status === 409 && failure.code === "unclaimed_holding_already_posted";
}

export async function runLicensingRoyaltyCascadePass(
  store: Store,
  lineOutcomes: readonly LicensingLineOutcome[],
  now: Date,
): Promise<LicensingCascadeCounts> {
  const counts = emptyLicensingCascadeCounts();

  for (const outcome of lineOutcomes) {
    // The dispositions decided at write time are final here — quarantined
    // rows never walk, never split, never report.
    if (outcome.disposition !== "money") continue;

    if (outcome.detail.subLicenseeId !== null) {
      await cascadeSubLicenseReport(store, outcome, counts, now);
      continue;
    }
    await cascadeTierWalk(store, outcome, counts);
  }
  return counts;
}

/**
 * The tier-walk path: deal lookup → schedule walk from the cumulative
 * position → agency commission → dual-IP split → treaty withholding → the
 * position-locked application commit → the counters' bookkeeping advance.
 */
async function cascadeTierWalk(
  store: Store,
  outcome: LicensingLineOutcome,
  counts: LicensingCascadeCounts,
): Promise<void> {
  const scopeKey = licensingScopeKey(outcome.detail.licenseId);
  let deal = await store.getLicensingRoyaltyDeal(scopeKey);
  if (deal === undefined) {
    // No deal of record — fail-closed: the net stays in holding, the walk
    // never guesses a schedule, and the skip is a counted, visible surface.
    counts.skippedNoDeal += 1;
    return;
  }
  if (deal.currency !== outcome.line.currency) {
    // A statement in a currency the deal of record does not price — never
    // converted here (no FX in the royalty engine; the art lane's rule).
    counts.skippedCurrencyMismatch += 1;
    return;
  }

  // THE TIER WALK, under the position lock: a concurrent walk advanced the
  // deal's counters between this pass's read and its insert → re-read and
  // re-walk from the advanced position (bounded; the append-only truth
  // governs). A replayed event (the same source_event_id already walked)
  // fails the same insert — the replay is the counted no-op.
  for (let attempt = 0; attempt < POSITION_RETRY_BUDGET; attempt += 1) {
    const netSalesCents = outcome.netCents;
    const cumulativeBefore = deal.cumulative_net_sales_cents;
    const walk = tieredRoyaltyWalk(netSalesCents, cumulativeBefore, deal.tiers);

    // AGENCY COMMISSION ORDERING — the commission prices the walk's GROSS
    // royalty before any split or withholding (the founder band; a deal
    // with no agency keeps everything).
    const agencyBps = deal.agency_commission_bps;
    const agencyCents =
      agencyBps === null ? 0 : agencyCommissionCents(walk.royaltyCents, agencyBps);

    // THE DUAL-IP SPLIT — the post-agency remainder divides equally on a
    // co-branded deal (the odd cent sweeps to dust); a single-licensor
    // deal keeps everything on licensor A with zero dust.
    const netAfterAgency = walk.royaltyCents - agencyCents;
    const isDualIp = deal.licensor_b_payee_id !== null;
    const split = isDualIp
      ? dualIpSplitCents(netAfterAgency)
      : { licensorACents: netAfterAgency, licensorBCents: 0, dustCents: 0 };

    // TREATY WITHHOLDING — the deal-level rate resolution: the source
    // territory is the row's territory_iso; the residence is licensor A's
    // country of record (the co-branded partner's leg prices the same
    // resolved rate — one deal, one withholding context per event).
    const source = outcome.detail.territoryIso;
    let rateBps: number | null = null;
    let ref: string | null = null;
    if (source !== deal.licensor_a_country) {
      const treaty = await store.getLicensingTreatyRate(source, deal.licensor_a_country);
      if (treaty !== undefined) {
        rateBps = treaty.rate_bps;
        ref = treaty.treaty_ref;
      } else if (deal.withholding_default_bps !== null) {
        rateBps = deal.withholding_default_bps;
        ref = "default";
      }
      // Neither a treaty of record nor a statutory default → rateBps stays
      // null and the payout legs HELD below — fail-closed, never guessed.
    }

    let withheldA: number | null = 0;
    let withheldB: number | null = 0;
    if (source !== deal.licensor_a_country && rateBps === null) {
      // The international sale with no coverage — the payout legs are
      // HELD (null withheld legs on the record; the money stays visible).
      withheldA = null;
      withheldB = null;
      counts.payoutLegsHeld += isDualIp ? 2 : 1;
    } else if (rateBps !== null) {
      withheldA = treatyWithholdingCents(split.licensorACents, rateBps);
      withheldB = treatyWithholdingCents(split.licensorBCents, rateBps);
      counts.withheldCents += withheldA + withheldB;
    }

    try {
      await store.insertLicensingRoyaltyApplication({
        deal_id: deal.id,
        scope_key: scopeKey,
        source_event_id: outcome.eventId,
        period: outcome.detail.period,
        net_sales_cents: netSalesCents,
        cumulative_before_cents: cumulativeBefore,
        royalty_cents: walk.royaltyCents,
        slices: walk.slices,
        agency_commission_cents: agencyCents,
        licensor_a_gross_cents: split.licensorACents,
        licensor_b_gross_cents: split.licensorBCents,
        dust_cents: split.dustCents,
        withholding_rate_bps: rateBps,
        licensor_a_withheld_cents: withheldA,
        licensor_b_withheld_cents: withheldB,
        withholding_ref: ref,
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // Which guard fired? Re-read the deal: an ADVANCED position means a
      // concurrent walk won the lock — re-walk from the advanced position.
      // An UNCHANGED position means this event's application already
      // exists (the replay guard) — the counted no-op.
      const advanced = await store.getLicensingRoyaltyDeal(scopeKey);
      if (advanced !== undefined && advanced.cumulative_net_sales_cents > cumulativeBefore) {
        deal = advanced;
        continue;
      }
      counts.applicationsReplayed += 1;
      return;
    }

    // Won the position — the counters advance as bookkeeping (the
    // append-only application row is the commit; a re-derivation from the
    // ledger truth heals any drift). The version is NOT incremented: the
    // tier table did not change — only the walk's position did.
    counts.applicationsCommitted += 1;
    counts.royaltyGrossCents += walk.royaltyCents;
    counts.agencyCommissionCents += agencyCents;
    await store.upsertLicensingRoyaltyDeal({
      ...deal,
      cumulative_net_sales_cents: walk.cumulativeAfterCents,
      cumulative_royalty_cents: deal.cumulative_royalty_cents + walk.royaltyCents,
    });

    // THE MG RECOUPMENT PASS (PR 33) — the committed application's
    // post-agency earned royalty offsets the scope's registered advances
    // per the founder's collateralization routing (matching
    // category-isolated first, then cross-collateralized). A scope with
    // no registered commitments is a fast counted no-op; a lane failure
    // surfaces (never swallowed) — the earnings of record are already
    // committed, and the recoupment ledger must never drift from them.
    const recoupment = await recoupLicensingRoyaltyEvent(store, {
      deal_id: deal.id,
      source_event_id: outcome.eventId,
      category_code: outcome.detail.categoryCode,
    });
    if (recoupment.ok) {
      counts.mgRecoupmentApplications += recoupment.value.applications.length;
    } else {
      throw new Error(
        `licensing_mg_recoupment_failed:${outcome.eventId}:${recoupment.code}:${recoupment.message}`,
      );
    }
    return;
  }

  // The retry budget exhausted without an advanced position — treat as the
  // replay surface (bounded; the append-only truth governs a later pass).
  counts.applicationsReplayed += 1;
}

/**
 * The sub-license path: the registered sub-licensee's override prices the
 * master royalty; the report of record is written with its own recorded
 * legs (the rollup's audit trail, audit state 'unknown'); ONLY a
 * 'reconciled' report releases its master royalty to holding — the
 * fail-closed audit gate, released once-only per source event.
 */
async function cascadeSubLicenseReport(
  store: Store,
  outcome: LicensingLineOutcome,
  counts: LicensingCascadeCounts,
  now: Date,
): Promise<void> {
  const scopeKey = licensingScopeKey(outcome.detail.licenseId);
  const subLicenseeId = outcome.detail.subLicenseeId;
  if (subLicenseeId === null) return; // Unreachable — the caller discriminates.

  const registration = await store.getLicensingSubLicensee(scopeKey, subLicenseeId);
  if (registration === undefined) {
    // An unregistered sub-licensee's money — fail-closed: no override of
    // record exists, so no royalty is computed and the skip is counted.
    counts.skippedNoSubLicensee += 1;
    return;
  }

  // The report's recorded legs, exact from the row's micros (the same pure
  // realization the write pass used — the conservation identity pins it).
  const legs = netLicensedSalesCents({
    grossRevenueMicros: BigInt(outcome.detail.grossRevenueMicros),
    tradeDiscountMicros: BigInt(outcome.detail.tradeDiscountMicros),
    returnedGoodsMicros: BigInt(outcome.detail.returnedGoodsMicros),
    shippingFreightMicros: BigInt(outcome.detail.shippingFreightMicros),
    vatMicros: BigInt(outcome.detail.vatMicros),
  });

  const existing = await store.getLicensingSubLicenseReport(outcome.eventId);
  if (existing === undefined) {
    // THE MASTER ROYALTY OVERRIDE — floor(net × override / 10000),
    // replacing the tier walk for the sub-licensed region's money.
    const masterRoyaltyCents = masterOverrideRoyaltyCents(
      legs.netSalesCents,
      registration.master_override_bps,
    );
    await store.upsertLicensingSubLicenseReport({
      scope_key: scopeKey,
      sub_licensee_id: subLicenseeId,
      region_code: registration.region_code,
      period: outcome.detail.period,
      source_event_id: outcome.eventId,
      gross_cents: legs.grossRevenueCents,
      trade_discount_cents: legs.tradeDiscountCents,
      returned_goods_cents: legs.returnedGoodsCents,
      shipping_freight_cents: legs.shippingFreightCents,
      vat_cents: legs.vatCents,
      net_sales_cents: legs.netSalesCents,
      master_override_bps: registration.master_override_bps,
      master_royalty_cents: masterRoyaltyCents,
      audit_state: "unknown",
      evidence_ref: null,
      reconciled_by: null,
    });
    counts.subReportsWritten += 1;
    return;
  }
  counts.subReportsReplayed += 1;

  // A re-shipped manifest whose report of record is already reconciled —
  // the release attempt (once-only per source event via the 409 guard).
  if (existing.audit_state !== "reconciled") {
    counts.subHeldPendingAudit += 1;
    return;
  }
  await releaseReconciledSubLicenseRoyalty(
    store,
    {
      sourceEventId: existing.source_event_id,
      masterRoyaltyCents: existing.master_royalty_cents,
      currency: outcome.line.currency,
    },
    counts,
    now,
  );
}

/**
 * The reconciled report's master-royalty release — the audit gate's open
 * state. The post is once-only per source event (the holding 409 guard is
 * the replay arbiter); the amount is the report's own committed
 * master_royalty_cents (never recomputed).
 */
export async function releaseReconciledSubLicenseRoyalty(
  store: Store,
  input: { sourceEventId: string; masterRoyaltyCents: number; currency: string },
  counts: LicensingCascadeCounts,
  now: Date,
): Promise<void> {
  let posted: UnclaimedHoldingPostSuccess | UnclaimedHoldingFailure;
  try {
    posted = await postToUnclaimedHolding(
      store,
      {
        amount_cents: input.masterRoyaltyCents,
        currency: input.currency,
        source: {
          type: "match_queue",
          event_id: `licensing:subrelease:${input.sourceEventId}`,
        },
        split_run_id: null,
      },
      now,
    );
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `licensing_sub_release_post_failed:${input.sourceEventId}:ledger_store_error:${message}`,
      { cause },
    );
  }
  if (posted.ok) {
    counts.subReleasesPosted += 1;
    return;
  }
  if (isReplayRefusal(posted)) {
    counts.subReleasesReplayed += 1;
    return;
  }
  throw new Error(
    `licensing_sub_release_post_failed:${input.sourceEventId}:${posted.code}:${posted.message}`,
  );
}

/**
 * The operator-side release sweep for one license scope: every
 * 'reconciled' report of record attempts its master-royalty release
 * (idempotent — already-released reports count as replays through the 409
 * guard). The audit reconciliation itself is the store's evidenced CAS
 * (reconcileLicensingSubLicenseReport) — this pass only ever releases
 * what that gate opened. Each post prices the currency of its source
 * queue row — the manifest line that funded the report.
 */
export async function releaseReconciledSubLicenseRoyalties(
  store: Store,
  scopeKey: string,
  now: Date,
): Promise<{ posted: number; replayed: number }> {
  const reports = await store.listLicensingSubLicenseReports(scopeKey);
  const counts = emptyLicensingCascadeCounts();
  for (const report of reports) {
    if (report.audit_state !== "reconciled") continue;
    // The currency of record is the source queue row's — the manifest row
    // that funded this report. A missing row fails closed (no release).
    const sourceRow = await store.getMatchQueueEntryByEventId(report.source_event_id);
    if (sourceRow === undefined || sourceRow.currency === null) continue;
    await releaseReconciledSubLicenseRoyalty(
      store,
      {
        sourceEventId: report.source_event_id,
        masterRoyaltyCents: report.master_royalty_cents,
        currency: sourceRow.currency,
      },
      counts,
      now,
    );
  }
  return { posted: counts.subReleasesPosted, replayed: counts.subReleasesReplayed };
}
