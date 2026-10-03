// Promoter box office settlement escrow + venue hall fees + comedy audio
// rights isolation + Grand Rights routing decoupling — PR 31 (migration 0035,
// the founder touring/comedy settlement-protection directive).
//
// Money received for a tour stop's box office net LOCKS in
// PROMOTER_BOX_OFFICE_SETTLEMENT_PENDING: ledger rows with kind and status
// 'promoter_box_office_settlement_pending' that stay out of every payee
// vault, out of the stop's payout designations, and out of the unclaimed
// holding bucket, until the FINAL NIGHT-OF-SHOW audit closes — the venue's
// box office statement audited, the close of record verified. The escrow is
// PER-STOP (payee `promoter_settlement:{production}:{venue}:{showDate}`, GL
// account `promoter_box_office_settlement_pending:{...}` — the film/esports
// escrow convention of carrying the business key in the account string)
// because the deal terms, the settlement sheet, and the audit close are all
// per-stop (the addendum-11 triple). Held box office nets are distinct from
// company dust, from every creator vault, from unallocated recon funds, and
// from every other escrow state, in payee, GL account, and ledger kind — no
// query can fold one into another.
//
// Migration 0035 carries the durable gate facts: promoter_settlement_audits
// (the audit close of record per stop), theatrical_payout_gate_states (the
// grand_rights_cleared / venue_settlement_reconciled states the theater
// payout gate reads, fail-closed), and venue_hall_fee_policies (the
// founder-banded 15–25% venue cut on tour merchandise). The escrow itself
// rides the free-text ledger kind/status columns — NO schema change (the
// film escrow PR 9 / esports PR 14 precedent).
//
// THE MOVES:
//
//   lockPromoterBoxOfficeSettlement — a stop's box office net arrives (the
//                 recon worker posts each settlement statement line here;
//                 manual posts are the film escrow's precedent): integer-
//                 cent credit into the stop's escrow, replay-guarded per
//                 source (409 on re-post), balanced
//                 promoter_settlement_post journal (FBO debit leg). Nothing
//                 moves after this until the verified release.
//
//   recordPromoterSettlementAuditClose — the final night-of-show audit
//                 close of record per stop (the release's fail-closed
//                 gate). A 'closed' row MUST carry its evidence_ref and
//                 closed_by provenance; 'unknown' is a valid explicit
//                 state that refuses.
//
//   releasePromoterBoxOfficeSettlement — the verified release. Fail-closed
//                 gates, in order: the row must be a LOCKED stop receipt
//                 (404/422/409 otherwise), the stop's audit close of record
//                 must be 'closed' (an ABSENT close refuses with
//                 audit_close_not_verified — nothing defaults to allowing),
//                 the payout designations must validate (integer cents,
//                 shares ≤ 10000 bps), every designated payee must pass the
//                 SAME fail-closed payout compliance gate as a Lithic
//                 dispatch on the THEATER vertical (grand rights cleared AND
//                 venue settlement reconciled), and the CAS flip must win
//                 BEFORE any money moves (the concurrent loser gets a 409).
//                 Then the routing: each designation's floored share, any
//                 integer-cent dust swept to the platform payee, and the
//                 zero-balance tripwire before the journal posts.
//
//   registerVenueHallFeePolicy / resolveMerchHallFeeSplit — the 15–25%
//                 venue cut on tour merchandise, enforced at registration
//                 (the band CHECK backs it in the database) and at use
//                 (a missing policy refuses — fail-closed, never guessed).
//                 The venue's cut deducts from gross merch sales BEFORE the
//                 artist's apparel net releases.
//
//   postComedyAudioRightsRoyalty — a comedy special's AUDIO royalty
//                 (SiriusXM / Spotify) posts under its OWN rights stream —
//                 isolated in payee, GL account, and ledger kind from the
//                 physical live ticket sales streams. Audio money is
//                 licensed-recording money; ticket money is box office
//                 money; no posting may route one through the other.
//
//   grandRightsRoute — the Grand Rights versus small rights decoupling:
//                 dramatic and theatrical performance royalties route
//                 STRICTLY through the specialized theatrical publishers of
//                 record (concord, mti, rodgers_hammerstein — the PR 30
//                 deal vocabulary), NEVER through standard PRO small-rights
//                 streaming pools (ASCAP, BMI). The router makes the wrong
//                 destination a refusal, not a bad posting.

import type { Store } from "@/lib/server/store";
import type { LedgerTransactionRecord } from "@/lib/don/types";
import {
  COMPANY_VARIANCE_PAYEE_ID,
  COMPANY_VARIANCE_PAYEE_NAME,
  COMEDY_AUDIO_SENDERS,
  PROMOTER_SETTLEMENT_PAYEE_PREFIX,
  promoterSettlementPayeeId,
  promoterSettlementPayeeName,
  promoterSettlementScope,
  comedyAudioRightsPayeeId,
  comedyAudioRightsPayeeName,
  VENUE_HALL_FEE_MIN_BPS,
  VENUE_HALL_FEE_MAX_BPS,
  isComedyAudioSenderCode,
  BPS_DENOMINATOR,
} from "@/modules/don/constants";
import { THEATRICAL_PUBLISHERS } from "@/modules/don/records";
import { zeroBalanceHolds } from "@/modules/don/dust";
import { applyWithholding } from "@/modules/compliance/engine";
import { applyRecoupmentSweep, type RecoupmentSweepOutcome } from "@/modules/recoupment/engine";
import {
  evaluatePayoutCompliance,
  getVerticalComplianceStateSource,
  resolveCreatorKycStatus,
  resolveTheatricalVerticalComplianceState,
} from "@/modules/compliance/payoutGate";
import { postJournal } from "@/modules/ledger/engine";
import {
  promoterSettlementDebit,
  promoterSettlementCredit,
  comedyAudioRightsCredit,
  fboDebit,
  vaultCredit,
  type GlLegInput,
} from "@/modules/ledger/journal";
import type {
  CompanyDustRecord,
  PromoterSettlementAuditRecord,
  PromoterSettlementAuditState,
  TaxEscrowRecord,
  VenueHallFeePolicyRecord,
} from "@/modules/don/records";
import { creditVault } from "@/modules/vaults/engine";
import { isIncomingFrozen } from "@/modules/vaults/dispute";

/** House failure envelope — the film escrow / esports pool shape. */
export type PromoterSettlementFailure = {
  ok: false;
  status: number;
  code: string;
  message: string;
};

/**
 * Where the settlement receipt came from. A recon-sourced receipt's
 * post-journal carries this as its ref (ref_type/ref_id), and a
 * match_queue-sourced receipt ALSO stamps the quarantined statement line's
 * event_id into line_item_id, so the row is discoverable through the
 * existing listLedgerTransactionsByLineItem without a new index or column.
 */
export type PromoterSettlementReceiptSource =
  | { type: "match_queue"; event_id: string }
  | { type: "recon_job"; job_id: string }
  | { type: "manual"; note: string };

export interface PromoterSettlementPostInput {
  /** The production scope the stop settles under (the addendum-11 triple). */
  production_id: string;
  /** The venue the stop played (the addendum-11 triple). */
  venue_id: string;
  /** The show date the stop played, ISO (the addendum-11 triple). */
  show_date: string;
  /** The promoter's remittance of the box office net, integer cents. */
  amount_cents: number;
  currency: string;
  source: PromoterSettlementReceiptSource;
}

export type PromoterSettlementPostSuccess = {
  ok: true;
  value: {
    /** The locked receipt — kind and status both 'promoter_box_office_settlement_pending'. */
    escrow_credit: LedgerTransactionRecord;
    journal_id: string;
  };
};

/** Recovers the stop triple from an escrow row's per-stop payee id. */
export function parsePromoterSettlementPayeeId(
  payeeId: string,
): { production_id: string; venue_id: string; show_date: string } | undefined {
  const prefix = `${PROMOTER_SETTLEMENT_PAYEE_PREFIX}:`;
  if (!payeeId.startsWith(prefix)) return undefined;
  const scope = payeeId.slice(prefix.length);
  const parts = scope.split(":");
  if (parts.length !== 3) return undefined;
  const [production_id, venue_id, show_date] = parts;
  if (production_id === "" || venue_id === "" || show_date === "") return undefined;
  return { production_id, venue_id, show_date };
}

/**
 * Locks one stop's box office net into the settlement escrow. The money's
 * GL leg is an FBO debit (cash arrived) against a credit on the stop's
 * escrow account — no vault is minted, no dust ledger row is written, no
 * payee is credited, and no payout designation sees a cent.
 */
export async function lockPromoterBoxOfficeSettlement(
  store: Store,
  input: PromoterSettlementPostInput,
  now: Date = new Date(),
): Promise<PromoterSettlementPostSuccess | PromoterSettlementFailure> {
  if (input.production_id.trim() === "" || input.venue_id.trim() === "" || input.show_date.trim() === "") {
    return {
      ok: false,
      status: 422,
      code: "invalid_stop_scope",
      message:
        "A promoter settlement receipt names its production, venue, and show date — the addendum-11 triple, all required.",
    };
  }
  // Integer cents, the house invariant — a float amount is refused, never rounded.
  if (!Number.isSafeInteger(input.amount_cents) || input.amount_cents <= 0) {
    return {
      ok: false,
      status: 422,
      code: "invalid_amount",
      message: "Promoter settlement receipts post integer cents greater than zero.",
    };
  }

  const source = input.source;
  // The journal ref names the SOURCE for match_queue/recon_job provenance;
  // a manual post refs its own ledger row (nothing else exists to point at).
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

  // Replay guard: one post per source id. The journal ref is the marker —
  // listGlJournalsByRef is indexed on (ref_type, ref_id) (migration 0006).
  if (sourceRefId !== "") {
    const prior = await store.listGlJournalsByRef(refType, sourceRefId);
    if (prior.length > 0) {
      return {
        ok: false,
        status: 409,
        code: "promoter_settlement_already_posted",
        message: `A promoter settlement receipt for ${refType} "${sourceRefId}" was already posted (${prior.length} journal(s) ref it).`,
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
    payee_id: promoterSettlementPayeeId(input.production_id, input.venue_id, input.show_date),
    payee_name: promoterSettlementPayeeName(input.production_id, input.venue_id, input.show_date),
    role: "other",
    share_bps: 0,
    amount_cents: input.amount_cents,
    currency: input.currency,
    status: "promoter_box_office_settlement_pending",
    rail: null,
    baas_provider: null,
    baas_transfer_id: null,
    created_at: createdAt,
    settled_at: null,
    kind: "promoter_box_office_settlement_pending",
  });

  const posted = await postJournal(
    store,
    {
      kind: "promoter_settlement_post",
      ref_type: refType,
      ref_id: sourceRefId === "" ? credit.id : sourceRefId,
      legs: [
        fboDebit(input.amount_cents),
        promoterSettlementCredit(
          input.production_id,
          input.venue_id,
          input.show_date,
          input.amount_cents,
        ),
      ],
    },
    now,
  );
  if (!posted.ok) {
    return { ok: false, status: 500, code: posted.code, message: posted.message };
  }
  return {
    ok: true,
    value: { escrow_credit: credit, journal_id: posted.journal.id },
  };
}

export interface PromoterSettlementAuditCloseInput {
  /** The stop the close covers — the addendum-11 triple. */
  production_id: string;
  venue_id: string;
  show_date: string;
  /** 'closed' = the final night-of-show audit closed and verified. */
  audit_state: PromoterSettlementAuditState;
  /** The close evidence's provenance — required for 'closed'. */
  evidence_ref: string | null;
  /** The operator identity that recorded the close — required for 'closed'. */
  closed_by: string | null;
}

/**
 * Records the final night-of-show audit close of record for one stop — the
 * persisted fact the escrow release reads, fail-closed. A 'closed' close
 * MUST carry its evidence and operator provenance; 'unknown' is a valid
 * explicit state that keeps the escrow refused.
 */
export async function recordPromoterSettlementAuditClose(
  store: Store,
  input: PromoterSettlementAuditCloseInput,
): Promise<
  | { ok: true; value: PromoterSettlementAuditRecord }
  | PromoterSettlementFailure
> {
  if (
    input.production_id.trim() === "" ||
    input.venue_id.trim() === "" ||
    input.show_date.trim() === ""
  ) {
    return {
      ok: false,
      status: 422,
      code: "invalid_stop_scope",
      message:
        "An audit close names its production, venue, and show date — the addendum-11 triple, all required.",
    };
  }
  if (
    input.audit_state === "closed" &&
    ((input.evidence_ref ?? "").trim() === "" || (input.closed_by ?? "").trim() === "")
  ) {
    return {
      ok: false,
      status: 422,
      code: "audit_close_provenance_required",
      message:
        "A 'closed' audit close of record carries its evidence_ref AND closed_by provenance — without them the close is not verifiable and is refused.",
    };
  }
  const record = await store.upsertPromoterSettlementAudit({
    production_id: input.production_id,
    venue_id: input.venue_id,
    show_date: input.show_date,
    audit_state: input.audit_state,
    evidence_ref: input.evidence_ref === null ? null : input.evidence_ref.trim() === "" ? null : input.evidence_ref,
    closed_by: input.closed_by === null ? null : input.closed_by.trim() === "" ? null : input.closed_by,
  });
  return { ok: true, value: record };
}

export type PromoterSettlementPayout = {
  payee_id: string;
  payee_name: string;
  /** The designated share of the released net, whole basis points. */
  share_bps: number;
};

export interface PromoterSettlementReleaseInput {
  /** The locked receipt to release (the ledger row id). */
  escrow_ledger_id: string;
  /** The stop's designated payouts — shares in bps summing to AT MOST 10000. */
  payouts: readonly PromoterSettlementPayout[];
  /** The clearance gate's first condition — fail-closed on anything but true. */
  operator_settlement_approved: boolean;
}

/** One designated payee's release outcome — gross and post-withholding net. */
export type PromoterSettlementPayoutCredit = {
  payee_id: string;
  payee_name: string;
  gross_cents: number;
  net_cents: number;
};

export type PromoterSettlementReleaseSuccess = {
  ok: true;
  value: {
    /** The released row — status 'settled', kind still 'promoter_box_office_settlement_pending'. */
    escrow_credit: LedgerTransactionRecord;
    /** The audit close of record this release verified (the gate's receipt). */
    audit_close: PromoterSettlementAuditRecord;
    /** Per-designee outcome; net_cents is post-withholding. */
    payout_credits: PromoterSettlementPayoutCredit[];
    company_dust_cents: number;
    dust_ledger: CompanyDustRecord[];
    /** The withholding escrow rows the creator credits wrote. */
    withholding: TaxEscrowRecord[];
    /** The recoupment sweeps the creator credits ran (the film escrow's shape). */
    recoupment: Array<RecoupmentSweepOutcome & { payee_id: string }>;
    journal_id: string;
  };
};

/**
 * Releases one locked stop receipt through the verified-release path — ONLY
 * after the stop's audit close of record reads 'closed', every designated
 * payee passes the fail-closed theater-vertical payout gate, and the CAS
 * flip has won BEFORE any money moves.
 */
export async function releasePromoterBoxOfficeSettlement(
  store: Store,
  input: PromoterSettlementReleaseInput,
  now: Date = new Date(),
): Promise<PromoterSettlementReleaseSuccess | PromoterSettlementFailure> {
  const row = await store.getLedgerTransaction(input.escrow_ledger_id);
  if (row === undefined) {
    return {
      ok: false,
      status: 404,
      code: "escrow_receipt_not_found",
      message: "No ledger transaction matches that id.",
    };
  }
  if (row.kind !== "promoter_box_office_settlement_pending") {
    return {
      ok: false,
      status: 422,
      code: "not_a_promoter_settlement_receipt",
      message: `Ledger transaction ${row.id} is kind "${row.kind}" — only promoter box office settlement receipts release here.`,
    };
  }
  if (row.status !== "promoter_box_office_settlement_pending") {
    return {
      ok: false,
      status: 409,
      code: "escrow_already_released",
      message: `Escrow receipt ${row.id} is no longer locked (status "${row.status}").`,
    };
  }
  const stop = parsePromoterSettlementPayeeId(row.payee_id);
  if (stop === undefined) {
    return {
      ok: false,
      status: 500,
      code: "escrow_payee_corrupted",
      message: `Escrow receipt ${row.id} carries payee "${row.payee_id}" — not a promoter settlement payee.`,
    };
  }

  // THE audit-close gate: the stop's audit close of record must read
  // 'closed' — an ABSENT close is unknown (refuses), an 'unknown' close
  // refuses, ONLY 'closed' passes. Nothing defaults to allowing.
  const auditClose = await store.getPromoterSettlementAudit(
    stop.production_id,
    stop.venue_id,
    stop.show_date,
  );
  if (auditClose === undefined || auditClose.audit_state !== "closed") {
    return {
      ok: false,
      status: 403,
      code: "audit_close_not_verified",
      message: `Promoter settlement release refused: the final night-of-show audit close of record for ${promoterSettlementScope(stop.production_id, stop.venue_id, stop.show_date)} is ${auditClose === undefined ? "absent (never recorded)" : `"${auditClose.audit_state}"`} — the escrow releases only on a verified close.`,
    };
  }

  // The payout designations: integer bps, no duplicates, summing to at most
  // 10000 — a designation may not promise more than the receipt.
  if (input.payouts.length === 0) {
    return {
      ok: false,
      status: 422,
      code: "no_payout_designations",
      message: "A promoter settlement release names at least one designated payout.",
    };
  }
  const seenPayees = new Set<string>();
  let totalBps = 0;
  for (const payout of input.payouts) {
    if (payout.payee_id.trim() === "") {
      return {
        ok: false,
        status: 422,
        code: "invalid_payout_payee",
        message: "Every payout designation names its payee.",
      };
    }
    if (seenPayees.has(payout.payee_id)) {
      return {
        ok: false,
        status: 422,
        code: "duplicate_payout_payee",
        message: `Payee "${payout.payee_id}" appears more than once — one designation per payee.`,
      };
    }
    seenPayees.add(payout.payee_id);
    if (
      !Number.isSafeInteger(payout.share_bps) ||
      payout.share_bps <= 0 ||
      payout.share_bps > BPS_DENOMINATOR
    ) {
      return {
        ok: false,
        status: 422,
        code: "invalid_payout_share",
        message: `Payout shares are positive bps of at most 10000 (got ${payout.share_bps} for "${payout.payee_id}").`,
      };
    }
    totalBps += payout.share_bps;
  }
  if (totalBps > BPS_DENOMINATOR) {
    return {
      ok: false,
      status: 422,
      code: "payouts_exceed_receipt",
      message: `Payout designations sum to ${totalBps} bps — at most 10000 is routable from the receipt.`,
    };
  }

  // The shares: floors of the releasing receipt (money still held pays no
  // one); the integer-cent residue is dust, swept to the platform payee.
  const shares = input.payouts.map((payout) => ({
    payout,
    amount_cents: Math.floor((row.amount_cents * payout.share_bps) / BPS_DENOMINATOR),
  }));
  const dustCents = row.amount_cents - shares.reduce((total, share) => total + share.amount_cents, 0);
  if (
    !zeroBalanceHolds(
      row.amount_cents,
      shares.map((share) => ({ amount_cents: share.amount_cents })),
      dustCents,
    )
  ) {
    return {
      ok: false,
      status: 500,
      code: "zero_balance_violation",
      message: "payout shares + dust !== locked receipt — release refused.",
    };
  }

  // Full verification = every designated payee's identity and vertical state
  // through the SAME fail-closed payout compliance gate as a Lithic dispatch,
  // on the THEATER vertical — resolved from the payout-gate states of record
  // (migration 0035; the AI/art holding-release fallback pattern), with the
  // request-scoped source honored first. The platform house payee holds no
  // KYC record by design and is skipped.
  const verticalStateSource = getVerticalComplianceStateSource();
  for (const share of shares) {
    if (share.payout.payee_id === COMPANY_VARIANCE_PAYEE_ID) continue;
    const kycStatus = await resolveCreatorKycStatus(store, share.payout.payee_id);
    let verticalState = await verticalStateSource({
      payeeId: share.payout.payee_id,
      vertical: "theater",
    });
    if (verticalState === null) {
      // The theater vertical's fallback (PR 31): when the request-scoped
      // source has no state for the payee, resolve from the theatrical
      // payout-gate states of record (migration 0035) — fail-closed on
      // absent (null stays null) and on 'unknown' (maps to false, the
      // specific condition refuses).
      verticalState = await resolveTheatricalVerticalComplianceState(
        store,
        share.payout.payee_id,
        stop.production_id,
      );
    }
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
        message: `Promoter settlement release refused for payee "${share.payout.payee_id}": ${compliance.message}`,
      };
    }
  }

  // The CAS wins BEFORE any money moves (insert-as-lock): the concurrent
  // release loser reads undefined here and refuses with the same 409 a
  // replayed release gets. The settled row with no
  // promoter_settlement_release journal is the visible alarm.
  const settled = await store.settlePromoterSettlementEscrow(row.id, now.toISOString());
  if (settled === undefined) {
    return {
      ok: false,
      status: 409,
      code: "escrow_already_released",
      message: `Escrow receipt ${row.id} is no longer locked — a concurrent release won.`,
    };
  }

  // The routing legs: the escrow debit, each designation's creator-credit
  // sequence (withholding off the top, recoupment sweep, guarded vault
  // credits — the PR 7 release loop, the film escrow's shape), the platform
  // dust. Every branch conserves its cents; the routed-legs log below
  // watches the ACTUAL postings, not the plan.
  const glLegs: GlLegInput[] = [
    promoterSettlementDebit(stop.production_id, stop.venue_id, stop.show_date, row.amount_cents),
  ];
  const withholding: TaxEscrowRecord[] = [];
  const recoupmentSweeps: Array<RecoupmentSweepOutcome & { payee_id: string }> = [];
  const routedLegCents: number[] = [];
  const dustLedger: CompanyDustRecord[] = [];
  const payoutCredits: PromoterSettlementPayoutCredit[] = [];

  for (const share of shares) {
    if (share.amount_cents <= 0) {
      // A floored-to-zero share still reports — gross 0, net 0.
      payoutCredits.push({
        payee_id: share.payout.payee_id,
        payee_name: share.payout.payee_name,
        gross_cents: 0,
        net_cents: 0,
      });
      continue;
    }
    let creditAmount = share.amount_cents;
    const kycStatus = await resolveCreatorKycStatus(store, share.payout.payee_id);
    if (kycStatus !== null) {
      // A verified creator-designee's share is W-2-shaped compensation —
      // the same withholding escrow the film escrow's creator credits ride.
      // The tax comes off the top; only the net sweeps recoupment.
      // applyWithholding records the escrow and YTD; the caller moves the
      // withheld cents into the creator's reserve bucket.
      const taxed = await applyWithholding(store, {
        creator_id: share.payout.payee_id,
        gross_cents: share.amount_cents,
        tax_year: now.getUTCFullYear(),
      });
      withholding.push(taxed.value.escrow);
      creditAmount = taxed.value.net_cents;
      if (taxed.value.withheld_cents > 0) {
        await creditVault(
          store,
          share.payout.payee_id,
          share.payout.payee_name,
          taxed.value.withheld_cents,
          "reserve",
          now,
        );
        glLegs.push(
          vaultCredit(share.payout.payee_id, "reserve", taxed.value.withheld_cents),
        );
        routedLegCents.push(taxed.value.withheld_cents);
      }
    }
    // No work context exists on a settlement receipt — the catalog-dispute
    // freeze check runs against the empty work key, which no dispute row
    // occupies (honest not-frozen, not a skipped check).
    const incomingFrozen = await isIncomingFrozen(store, share.payout.payee_id, "");
    const excessTarget = incomingFrozen ? "reserve" : "available";
    const recouped = await applyRecoupmentSweep(
      store,
      share.payout.payee_id,
      share.payout.payee_name,
      creditAmount,
      now,
      { excess_target: excessTarget },
    );
    if (recouped.applied) {
      // The sweep credits the vaults itself (company available for the
      // recouped cents, the payee's excess bucket for the excess) — these
      // GL legs MIRROR those postings; a second vault write here would
      // double-credit.
      recoupmentSweeps.push({ ...recouped, payee_id: share.payout.payee_id });
      if (recouped.recouped_cents > 0) {
        glLegs.push(
          vaultCredit(COMPANY_VARIANCE_PAYEE_ID, "available", recouped.recouped_cents),
        );
        routedLegCents.push(recouped.recouped_cents);
      }
      if (recouped.excess_cents > 0) {
        glLegs.push(vaultCredit(share.payout.payee_id, excessTarget, recouped.excess_cents));
        routedLegCents.push(recouped.excess_cents);
      }
    } else if (incomingFrozen && creditAmount > 0) {
      await creditVault(
        store,
        share.payout.payee_id,
        share.payout.payee_name,
        creditAmount,
        "reserve",
        now,
      );
      glLegs.push(vaultCredit(share.payout.payee_id, "reserve", creditAmount));
      routedLegCents.push(creditAmount);
    } else if (creditAmount > 0) {
      await creditVault(store, share.payout.payee_id, share.payout.payee_name, creditAmount, "pending", now);
      glLegs.push(vaultCredit(share.payout.payee_id, "pending", creditAmount));
      routedLegCents.push(creditAmount);
    }
    payoutCredits.push({
      payee_id: share.payout.payee_id,
      payee_name: share.payout.payee_name,
      gross_cents: share.amount_cents,
      // Post-withholding, PRE-recoupment — the film escrow's convention;
      // the sweep's outcome rides the recoupment array.
      net_cents: creditAmount,
    });
  }

  if (dustCents > 0) {
    dustLedger.push(
      await store.insertCompanyDust({
        split_run_id: row.split_run_id,
        line_item_id: row.line_item_id,
        amount_cents: dustCents,
        variance_account_id: COMPANY_VARIANCE_PAYEE_ID,
        created_at: now.toISOString(),
      }),
    );
    await creditVault(
      store,
      COMPANY_VARIANCE_PAYEE_ID,
      COMPANY_VARIANCE_PAYEE_NAME,
      dustCents,
      "pending",
      now,
    );
    glLegs.push(vaultCredit(COMPANY_VARIANCE_PAYEE_ID, "pending", dustCents));
    routedLegCents.push(dustCents);
  }

  // The zero-balance tripwire: the cents ACTUALLY routed (withheld to
  // reserves, recouped to the company, landed in creator vaults, dust to
  // the platform payee) must conserve against the receipt exactly. The
  // planned shares conserve by construction; THIS check watches the legs
  // that actually posted.
  const routedTotal = routedLegCents.reduce((total, cents) => total + cents, 0);
  if (routedTotal !== row.amount_cents) {
    return {
      ok: false,
      status: 500,
      code: "zero_balance_violation",
      message: `routed cents (${routedTotal}) !== locked receipt (${row.amount_cents}) — journal refused.`,
    };
  }

  const posted = await postJournal(
    store,
    {
      kind: "promoter_settlement_release",
      ref_type: "ledger_transaction",
      ref_id: row.id,
      legs: glLegs,
    },
    now,
  );
  if (!posted.ok) {
    return { ok: false, status: 500, code: posted.code, message: posted.message };
  }
  return {
    ok: true,
    value: {
      escrow_credit: settled,
      audit_close: auditClose,
      payout_credits: payoutCredits,
      company_dust_cents: dustCents,
      dust_ledger: dustLedger,
      withholding,
      recoupment: recoupmentSweeps,
      journal_id: posted.journal.id,
    },
  };
}

// ---------------------------------------------------------------------------
// Venue hall fees — the founder-banded 15–25% venue cut on tour merchandise.
// ---------------------------------------------------------------------------

export interface VenueHallFeePolicyInput {
  tour_id: string;
  venue_id: string;
  /** The venue's cut, whole basis points — the 1500–2500 band. */
  hall_fee_rate_bps: number;
  venue_payee_id: string;
  venue_payee_name: string;
}

/**
 * Registers the venue hall fee policy of record for one (tour, venue)
 * pairing. The 15–25% band validates here AND in the database (migration
 * 0035's CHECK) — a hostile contract outside the band is refused twice.
 */
export async function registerVenueHallFeePolicy(
  store: Store,
  input: VenueHallFeePolicyInput,
): Promise<
  | { ok: true; value: VenueHallFeePolicyRecord }
  | PromoterSettlementFailure
> {
  if (input.tour_id.trim() === "" || input.venue_id.trim() === "") {
    return {
      ok: false,
      status: 422,
      code: "invalid_hall_fee_scope",
      message: "A venue hall fee policy names its tour and venue.",
    };
  }
  if (
    !Number.isSafeInteger(input.hall_fee_rate_bps) ||
    input.hall_fee_rate_bps < VENUE_HALL_FEE_MIN_BPS ||
    input.hall_fee_rate_bps > VENUE_HALL_FEE_MAX_BPS
  ) {
    return {
      ok: false,
      status: 422,
      code: "hall_fee_rate_out_of_band",
      message: `The venue hall fee is the founder-banded 15–25% (${VENUE_HALL_FEE_MIN_BPS}–${VENUE_HALL_FEE_MAX_BPS} bps) — got ${input.hall_fee_rate_bps} bps.`,
    };
  }
  if (input.venue_payee_id.trim() === "" || input.venue_payee_name.trim() === "") {
    return {
      ok: false,
      status: 422,
      code: "invalid_hall_fee_payee",
      message: "A venue hall fee policy names the venue payee that receives the cut.",
    };
  }
  const record = await store.upsertVenueHallFeePolicy({
    tour_id: input.tour_id,
    venue_id: input.venue_id,
    hall_fee_rate_bps: input.hall_fee_rate_bps,
    venue_payee_id: input.venue_payee_id,
    venue_payee_name: input.venue_payee_name,
  });
  return { ok: true, value: record };
}

/** The integer-cent hall fee split — pure, conservation-exact. */
export type VenueHallFeeSplit = {
  venue_cut_cents: number;
  artist_net_cents: number;
};

/** Floors the venue's cut off the gross; the artist's apparel net is the
 * remainder — venue_cut + artist_net === gross, exact, always. */
export function computeVenueHallFeeSplit(
  grossMerchCents: number,
  hallFeeRateBps: number,
): VenueHallFeeSplit {
  const venueCutCents = Math.floor((grossMerchCents * hallFeeRateBps) / BPS_DENOMINATOR);
  return { venue_cut_cents: venueCutCents, artist_net_cents: grossMerchCents - venueCutCents };
}

export type MerchHallFeeResolution =
  | {
      ok: true;
      value: VenueHallFeeSplit & {
        policy: VenueHallFeePolicyRecord;
        gross_merch_cents: number;
      };
    }
  | PromoterSettlementFailure;

/**
 * Resolves the merch hall fee split for one (tour, venue) pairing's gross
 * merch sales — the deduction the artist's apparel net releases AFTER.
 * Fail-closed: a pairing with no registered policy refuses (never guesses a
 * rate); integer-cent gross only; the conservation is exact.
 */
export async function resolveMerchHallFeeSplit(
  store: Store,
  input: { tour_id: string; venue_id: string; gross_merch_cents: number },
): Promise<MerchHallFeeResolution> {
  if (!Number.isSafeInteger(input.gross_merch_cents) || input.gross_merch_cents < 0) {
    return {
      ok: false,
      status: 422,
      code: "invalid_amount",
      message: "Gross merch sales resolve in integer cents (zero allowed).",
    };
  }
  const policy = await store.getVenueHallFeePolicy(input.tour_id, input.venue_id);
  if (policy === undefined) {
    return {
      ok: false,
      status: 403,
      code: "hall_fee_policy_unregistered",
      message: `Merch hall fee refused: no venue hall fee policy of record for tour "${input.tour_id}" @ venue "${input.venue_id}" — the deduction never guesses a rate.`,
    };
  }
  const split = computeVenueHallFeeSplit(input.gross_merch_cents, policy.hall_fee_rate_bps);
  return {
    ok: true,
    value: {
      ...split,
      policy,
      gross_merch_cents: input.gross_merch_cents,
    },
  };
}

// ---------------------------------------------------------------------------
// Comedy audio rights — the isolated per-special audio royalty stream.
// ---------------------------------------------------------------------------

export type ComedyAudioReceiptSource =
  | { type: "match_queue"; event_id: string }
  | { type: "recon_job"; job_id: string }
  | { type: "manual"; note: string };

export interface ComedyAudioRightsPostInput {
  /** The comedy special whose recording the royalty derives from. */
  special_id: string;
  /** The audio sender — siriusxm or spotify, the directive's two. */
  sender: string;
  /** The audio royalty due, integer cents. */
  amount_cents: number;
  currency: string;
  source: ComedyAudioReceiptSource;
}

export type ComedyAudioRightsPostSuccess = {
  ok: true;
  value: {
    /** The audio-stream credit — kind and status both 'comedy_audio_rights_pending'. */
    audio_credit: LedgerTransactionRecord;
    journal_id: string;
  };
};

/**
 * Posts one comedy special's AUDIO royalty into the isolated audio stream —
 * the special's own payee and GL account, NEVER a box office account, never
 * unclaimed holding, never a ticket-sales ledger kind. The sender must be
 * one of the directive's audio senders (siriusxm, spotify): a theatrical
 * box office sender arriving here is exactly the cross-stream contamination
 * the isolation exists to prevent, and is refused.
 */
export async function postComedyAudioRightsRoyalty(
  store: Store,
  input: ComedyAudioRightsPostInput,
  now: Date = new Date(),
): Promise<ComedyAudioRightsPostSuccess | PromoterSettlementFailure> {
  if (input.special_id.trim() === "") {
    return {
      ok: false,
      status: 422,
      code: "invalid_special_id",
      message: "A comedy audio royalty names its special.",
    };
  }
  if (!isComedyAudioSenderCode(input.sender)) {
    return {
      ok: false,
      status: 422,
      code: "invalid_audio_sender",
      message: `Comedy audio royalties post from the directive's audio senders (${COMEDY_AUDIO_SENDERS.join(", ")}) — got "${input.sender}". Box office senders (axs, ticketmaster, eventbrite, venuepos) never route here.`,
    };
  }
  if (!Number.isSafeInteger(input.amount_cents) || input.amount_cents <= 0) {
    return {
      ok: false,
      status: 422,
      code: "invalid_amount",
      message: "Comedy audio royalties post integer cents greater than zero.",
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

  // Replay guard: one post per source id (the journal ref is the marker).
  if (sourceRefId !== "") {
    const prior = await store.listGlJournalsByRef(refType, sourceRefId);
    if (prior.length > 0) {
      return {
        ok: false,
        status: 409,
        code: "comedy_audio_royalty_already_posted",
        message: `A comedy audio royalty for ${refType} "${sourceRefId}" was already posted (${prior.length} journal(s) ref it).`,
      };
    }
  }

  const createdAt = now.toISOString();
  const credit = await store.insertLedgerTransaction({
    split_run_id: "",
    line_item_id: source.type === "match_queue" ? source.event_id : "",
    payee_id: comedyAudioRightsPayeeId(input.special_id),
    payee_name: comedyAudioRightsPayeeName(input.special_id),
    role: "other",
    share_bps: 0,
    amount_cents: input.amount_cents,
    currency: input.currency,
    status: "comedy_audio_rights_pending",
    rail: null,
    baas_provider: null,
    baas_transfer_id: null,
    created_at: createdAt,
    settled_at: null,
    kind: "comedy_audio_rights_pending",
  });

  const posted = await postJournal(
    store,
    {
      kind: "comedy_audio_rights_post",
      ref_type: refType,
      ref_id: sourceRefId === "" ? credit.id : sourceRefId,
      legs: [
        fboDebit(input.amount_cents),
        comedyAudioRightsCredit(input.special_id, input.amount_cents),
      ],
    },
    now,
  );
  if (!posted.ok) {
    return { ok: false, status: 500, code: posted.code, message: posted.message };
  }
  return {
    ok: true,
    value: { audio_credit: credit, journal_id: posted.journal.id },
  };
}

// ---------------------------------------------------------------------------
// Grand Rights versus small rights — the routing decoupling.
// ---------------------------------------------------------------------------

/** The PRO small-rights streaming pools the directive names — the
 * destinations a dramatic/theatrical royalty must NEVER route through. */
export const SMALL_RIGHTS_PRO_POOLS = ["ascap", "bmi"] as const;
export type SmallRightsProPool = (typeof SMALL_RIGHTS_PRO_POOLS)[number];
export function isSmallRightsProPool(value: string): value is SmallRightsProPool {
  return (SMALL_RIGHTS_PRO_POOLS as readonly string[]).includes(value);
}

/** The theatrical publisher payee id of record — the Grand Rights lane's
 * only legal destination for dramatic/theatrical performance royalties. */
export function theatricalPublisherPayeeId(publisherCode: string): string {
  return `theatrical_publisher:${publisherCode}`;
}

export type GrandRightsRoute =
  | { ok: true; destination: string; payee_id: string; lane: "theatrical_publisher" }
  | {
      ok: false;
      code: "grand_rights_never_route_through_pro_pools";
      message: string;
    };

/**
 * Routes a dramatic/theatrical performance royalty — Grand Rights — to the
 * production's specialized theatrical publisher of record. A PRO small-
 * rights pool destination (ascap, bmi) is REFUSED: those pools exist for
 * small rights (broadcast/streaming performance), and a Grand Rights
 * royalty arriving there is the exact commingling the decoupling forbids.
 */
export function grandRightsRoute(
  publisherCode: string,
  destination: string,
): GrandRightsRoute {
  if (isSmallRightsProPool(destination)) {
    return {
      ok: false,
      code: "grand_rights_never_route_through_pro_pools",
      message: `Grand Rights royalties route ONLY through the production's specialized theatrical publisher ("${publisherCode}") — "${destination}" is a standard PRO small-rights streaming pool, and dramatic/theatrical performance royalties never route there.`,
    };
  }
  if (!(THEATRICAL_PUBLISHERS as readonly string[]).includes(publisherCode)) {
    return {
      ok: false,
      code: "grand_rights_never_route_through_pro_pools",
      message: `"${publisherCode}" is not a theatrical publisher of record (${THEATRICAL_PUBLISHERS.join(", ")}) — Grand Rights route only through the specialized theatrical publishers.`,
    };
  }
  return {
    ok: true,
    destination,
    payee_id: theatricalPublisherPayeeId(publisherCode),
    lane: "theatrical_publisher",
  };
}
