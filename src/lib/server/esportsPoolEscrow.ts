// Esports prize pool escrow — PR 14 (founder livestream directive).
//
// Money received for a tournament's prize pool LOCKS in
// ESPORTS_PRIZE_POOL_PENDING: ledger rows with kind and status
// 'esports_prize_pool_pending' that stay out of every payee vault, out of
// the roster split, and out of the unclaimed holding bucket, until the
// verified release runs the sequential recoupment waterfall. The escrow is
// PER-BATCH (payee `esports_pool_escrow:{batchId}`, GL account
// `esports_prize_pool_escrow:{batchId}` — the film escrow's convention of
// carrying the business key in the account string) because the waterfall,
// the roster contract, and the receipts are all per-batch. A prize pool is
// team money owed to named players and staff — it must never be mistaken
// for unallocated recon revenue or settle through a creator's holding path.
//
// NO MIGRATION. ledger_transactions.status/kind are free text columns
// (migration 0006 places no check constraint on either), so the state
// extends the existing ledger contract in place — the film escrow (PR 9)
// and gaming cashout (PR 13) precedent. The release's CAS lives in the
// store's settleEsportsPoolEscrow (three backends).
//
// THE TWO MOVES:
//
//   postToEsportsPoolEscrow — a tournament's prize pool receipt arrives
//                 (the recon worker posts each prize-pool statement line
//                 here; manual posts are the film escrow's precedent):
//                 integer-cent credit into the batch's escrow, replay-
//                 guarded per source (journal per source id, 409 on
//                 re-post), balanced esports_pool_escrow_post journal (FBO
//                 debit leg). Nothing moves after this until the verified
//                 release — the escrow lock is the point.
//
//   releaseEsportsPrizePool — the verified release. Fail-closed gates, in
//                 order: the row must be a LOCKED pool receipt (404/422/
//                 409 otherwise), the waterfall contract must validate and
//                 the plan must build (buildEsportsWaterfallPlan — the
//                 sequential integer-cent allocator), every credited party
//                 must pass the SAME fail-closed payout compliance gate as
//                 a Lithic dispatch (operator settlement approval, verified
//                 KYC, and the LIVESTREAM vertical's state — reconciled
//                 stream payouts and verified tax withholding, mandatory
//                 for international tournament winnings), and the CAS flip
//                 must win (the concurrent loser gets undefined and a 409).
//                 THEN the routing in the founder's mandated order: venue
//                 recoupment, travel recoupment, the org cut (the 15-30%
//                 band), the roster split (floor shares across starters,
//                 substitutes, and coaching/analytic staff — withholding
//                 applied to playing roles), and any integer-cent dust
//                 swept to the platform payee. Insert-as-lock ordering: the
//                 CAS flips BEFORE any vault credit, so a crash mid-release
//                 fails toward "nothing moved twice". A shortfall pool
//                 recoups what exists and reports `unrecouped_cents`
//                 honestly — the roster split of a shortfalled pool pays
//                 from what REMAINS, never from invented money.

import type { Store } from "@/lib/server/store";
import type { LedgerTransactionRecord } from "@/lib/don/types";
import {
  COMPANY_VARIANCE_PAYEE_ID,
  COMPANY_VARIANCE_PAYEE_NAME,
  ESPORTS_POOL_PAYEE_PREFIX,
  esportsPoolEscrowPayeeId,
  esportsPoolEscrowPayeeName,
} from "@/modules/don/constants";
import { zeroBalanceHolds } from "@/modules/don/dust";
import { applyWithholding } from "@/modules/compliance/engine";
import { applyRecoupmentSweep } from "@/modules/recoupment/engine";
import {
  evaluatePayoutCompliance,
  getVerticalComplianceStateSource,
  resolveCreatorKycStatus,
} from "@/modules/compliance/payoutGate";
import { postJournal } from "@/modules/ledger/engine";
import {
  esportsPoolEscrowCredit,
  esportsPoolEscrowDebit,
  fboDebit,
  vaultCredit,
  type GlLegInput,
} from "@/modules/ledger/journal";
import type { CompanyDustRecord, TaxEscrowRecord } from "@/modules/don/records";
import { creditVault } from "@/modules/vaults/engine";
import { isIncomingFrozen } from "@/modules/vaults/dispute";
import {
  buildEsportsWaterfallPlan,
  isPlayingRole,
  type EsportsRosterMember,
  type EsportsWaterfallPlan,
} from "@/workers/recon/esportsSplits";

/** House failure envelope — the film escrow / unclaimed holding shape. */
export type EsportsPoolEscrowFailure = {
  ok: false;
  status: number;
  code: string;
  message: string;
};

/**
 * Where the locked receipt arrived from — the recovery linkage. The GL
 * post-journal carries this as its ref (ref_type/ref_id), and a
 * match_queue-sourced receipt ALSO stamps the quarantined statement line's
 * event_id into line_item_id, so the row is discoverable through the
 * existing listLedgerTransactionsByLineItem without a new index or column.
 */
export type EsportsPoolReceiptSource =
  | { type: "match_queue"; event_id: string }
  | { type: "recon_job"; job_id: string }
  | { type: "manual"; note: string };

export interface EsportsPoolEscrowPostInput {
  /** The prize pool batch the receipt funds — the escrow and waterfall key. */
  batch: string;
  /** The tournament organizer's remittance, integer cents. */
  amount_cents: number;
  currency: string;
  source: EsportsPoolReceiptSource;
}

export type EsportsPoolEscrowPostSuccess = {
  ok: true;
  value: {
    /** The locked receipt — kind and status both 'esports_prize_pool_pending'. */
    escrow_credit: LedgerTransactionRecord;
    journal_id: string;
  };
};

/**
 * Recovers the batch id from an escrow row's per-batch payee id.
 */
export function batchIdFromEscrowPayeeId(payeeId: string): string | undefined {
  const prefix = `${ESPORTS_POOL_PAYEE_PREFIX}:`;
  return payeeId.startsWith(prefix) ? payeeId.slice(prefix.length) : undefined;
}

/**
 * Locks one prize pool receipt into the batch's escrow. The money's GL leg
 * is an FBO debit (cash arrived) against a credit on the batch's escrow
 * account — no vault is minted, no dust ledger row is written, no payee is
 * credited, and no roster member sees a cent.
 */
export async function postToEsportsPoolEscrow(
  store: Store,
  input: EsportsPoolEscrowPostInput,
  now: Date = new Date(),
): Promise<EsportsPoolEscrowPostSuccess | EsportsPoolEscrowFailure> {
  if (input.batch.trim() === "") {
    return {
      ok: false,
      status: 422,
      code: "invalid_prize_pool_batch",
      message: "An esports prize pool receipt names its batch.",
    };
  }
  // Integer cents, the house invariant — a float amount is refused, never rounded.
  if (!Number.isSafeInteger(input.amount_cents) || input.amount_cents <= 0) {
    return {
      ok: false,
      status: 422,
      code: "invalid_amount",
      message: "Esports prize pool receipts post integer cents greater than zero.",
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
        code: "esports_pool_receipt_already_posted",
        message: `An esports prize pool receipt for ${refType} "${sourceRefId}" was already posted (${prior.length} journal(s) ref it).`,
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
    payee_id: esportsPoolEscrowPayeeId(input.batch),
    payee_name: esportsPoolEscrowPayeeName(input.batch),
    role: "other",
    share_bps: 0,
    amount_cents: input.amount_cents,
    currency: input.currency,
    status: "esports_prize_pool_pending",
    rail: null,
    baas_provider: null,
    baas_transfer_id: null,
    created_at: createdAt,
    settled_at: null,
    kind: "esports_prize_pool_pending",
  });

  const posted = await postJournal(
    store,
    {
      kind: "esports_pool_escrow_post",
      ref_type: refType,
      ref_id: sourceRefId === "" ? credit.id : sourceRefId,
      legs: [
        fboDebit(input.amount_cents),
        esportsPoolEscrowCredit(input.batch, input.amount_cents),
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

/** One verified roster member at release — the allocator's contract input. */
export type EsportsRosterMemberInput = EsportsRosterMember;

export interface EsportsPoolReleaseInput {
  /** The locked receipt to release (the ledger row id). */
  escrow_ledger_id: string;
  orgPayeeId: string;
  orgPayeeName: string;
  /** The org's operational fee, whole basis points — the 15-30% band. */
  orgCutBps: number;
  /** Advanced expense recoupment — each step only when contractually mandated. */
  venueExpenseCents: number;
  travelExpenseCents: number;
  venueMandated: boolean;
  travelMandated: boolean;
  /** The roster split — shares in bps summing to EXACTLY 10000. */
  roster: readonly EsportsRosterMemberInput[];
  /** The clearance gate's first condition — fail-closed on anything but true. */
  operator_settlement_approved: boolean;
}

export type EsportsPoolReleaseSuccess = {
  ok: true;
  value: {
    /** The released row — status 'settled', kind still 'esports_prize_pool_pending'. */
    escrow_credit: LedgerTransactionRecord;
    /** The waterfall plan as posted — every step's integer-cent outcome. */
    plan: EsportsWaterfallPlan;
    /** Per-roster-member outcome; net_cents is post-withholding. */
    roster_credits: Array<{
      payee_id: string;
      payee_name: string;
      role: EsportsRosterMemberInput["role"];
      gross_cents: number;
      net_cents: number;
    }>;
    company_dust_cents: number;
    dust_ledger: CompanyDustRecord[];
    /** Mandated expenses the pool could not cover — reported, never hidden. */
    unrecouped_cents: number;
    journal_id: string;
  };
};

/**
 * Releases one locked prize pool receipt through the sequential recoupment
 * waterfall — ONLY after the waterfall contract validates, every credited
 * party passes the fail-closed payout compliance gate, and the CAS flip has
 * won BEFORE any money moves.
 */
export async function releaseEsportsPrizePool(
  store: Store,
  input: EsportsPoolReleaseInput,
  now: Date = new Date(),
): Promise<EsportsPoolReleaseSuccess | EsportsPoolEscrowFailure> {
  const row = await store.getLedgerTransaction(input.escrow_ledger_id);
  if (row === undefined) {
    return {
      ok: false,
      status: 404,
      code: "escrow_receipt_not_found",
      message: "No ledger transaction matches that id.",
    };
  }
  if (row.kind !== "esports_prize_pool_pending") {
    return {
      ok: false,
      status: 422,
      code: "not_an_esports_pool_receipt",
      message: `Ledger transaction ${row.id} is kind "${row.kind}" — only esports prize pool receipts release here.`,
    };
  }
  if (row.status !== "esports_prize_pool_pending") {
    return {
      ok: false,
      status: 409,
      code: "escrow_already_released",
      message: `Escrow receipt ${row.id} is no longer locked (status "${row.status}").`,
    };
  }
  const batch = batchIdFromEscrowPayeeId(row.payee_id);
  if (batch === undefined) {
    return {
      ok: false,
      status: 500,
      code: "escrow_payee_corrupted",
      message: `Escrow receipt ${row.id} carries payee "${row.payee_id}" — not an esports prize pool escrow payee.`,
    };
  }

  // THE allocator: validates the contract and computes every step in exact
  // integer cents BEFORE any gate or ledger write — a refused plan moves
  // nothing and reports why.
  const planned = buildEsportsWaterfallPlan({
    poolCents: row.amount_cents,
    orgPayeeId: input.orgPayeeId,
    orgPayeeName: input.orgPayeeName,
    orgCutBps: input.orgCutBps,
    venueExpenseCents: input.venueExpenseCents,
    travelExpenseCents: input.travelExpenseCents,
    venueMandated: input.venueMandated,
    travelMandated: input.travelMandated,
    roster: input.roster,
  });
  if (!planned.ok) {
    return {
      ok: false,
      status: 422,
      code: planned.code,
      message: planned.message,
    };
  }
  const plan = planned.plan;

  // The clearance gate — org and every roster member ride the SAME
  // fail-closed payout compliance gate as a Lithic dispatch, on the
  // LIVESTREAM vertical (reconciled stream payouts + verified tax
  // withholding — mandatory for international tournament winnings). The
  // platform house payee holds no KYC record by design and is skipped.
  const verticalStateSource = getVerticalComplianceStateSource();
  const gatedParties: Array<{ payee_id: string; payee_name: string }> = [
    { payee_id: input.orgPayeeId, payee_name: input.orgPayeeName },
    ...plan.rosterAllocations.map((allocation) => ({
      payee_id: allocation.payeeId,
      payee_name: allocation.payeeName,
    })),
  ];
  for (const party of gatedParties) {
    if (party.payee_id === COMPANY_VARIANCE_PAYEE_ID) continue;
    const kycStatus = await resolveCreatorKycStatus(store, party.payee_id);
    const verticalState = await verticalStateSource({
      payeeId: party.payee_id,
      vertical: "livestream",
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
        message: `Esports prize pool release refused for payee "${party.payee_id}": ${compliance.message}`,
      };
    }
  }

  // The CAS wins BEFORE any money moves (insert-as-lock): the concurrent
  // release loser reads undefined here and refuses with the same 409 a
  // replayed release gets. The settled row with no
  // esports_pool_escrow_release journal is the visible alarm.
  const settled = await store.settleEsportsPoolEscrow(row.id, now.toISOString());
  if (settled === undefined) {
    return {
      ok: false,
      status: 409,
      code: "escrow_already_released",
      message: `Escrow receipt ${row.id} is no longer locked — a concurrent release won.`,
    };
  }

  // The waterfall legs, in the founder's mandated order: recoupment, org
  // cut, roster split (withholding on playing roles), dust. Every branch
  // conserves its cents. Every payee credit rides the film escrow's
  // structure: withholding off the top for playing roles, the
  // catalog-dispute freeze check, then the recoupment sweep (a payee with
  // a recoupment advance has incoming swept to the company before any
  // excess lands) — never a bare vault credit.
  const glLegs: GlLegInput[] = [esportsPoolEscrowDebit(batch, row.amount_cents)];
  const withholding: TaxEscrowRecord[] = [];
  const dustLedger: CompanyDustRecord[] = [];
  const rosterCredits: EsportsPoolReleaseSuccess["value"]["roster_credits"] = [];

  /**
   * Credits one waterfall payee exactly the way the film escrow credits a
   * participant: freeze check → recoupment sweep (its own vault writes;
   * the GL legs mirror them) → bare pending credit when no advance exists.
   * Returns the cents that landed in the payee's vault (excess or bare
   * credit — withheld and recouped cents never reach the payee).
   */
  const creditWaterfallPayee = async (
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
          vaultCredit(
            payeeId,
            incomingFrozen ? "reserve" : "available",
            recouped.excess_cents,
          ),
        );
      }
      return recouped.excess_cents;
    }
    await creditVault(store, payeeId, payeeName, cents, "pending", now);
    glLegs.push(vaultCredit(payeeId, "pending", cents));
    return cents;
  };

  await creditWaterfallPayee(input.orgPayeeId, input.orgPayeeName, plan.venuePaidCents);
  await creditWaterfallPayee(input.orgPayeeId, input.orgPayeeName, plan.travelPaidCents);
  await creditWaterfallPayee(input.orgPayeeId, input.orgPayeeName, plan.orgPaidCents);

  for (const allocation of plan.rosterAllocations) {
    if (allocation.amountCents <= 0) {
      // A floored-to-zero share still reports — gross 0, net 0.
      rosterCredits.push({
        payee_id: allocation.payeeId,
        payee_name: allocation.payeeName,
        role: allocation.role,
        gross_cents: 0,
        net_cents: 0,
      });
      continue;
    }
    let creditAmount = allocation.amountCents;
    if (isPlayingRole(allocation.role)) {
      // Playing talent's share is W-2-shaped compensation — the same
      // withholding escrow the film escrow's creator credits ride. The
      // tax comes off the top; only the net sweeps recoupment.
      const taxed = await applyWithholding(store, {
        creator_id: allocation.payeeId,
        gross_cents: allocation.amountCents,
        tax_year: now.getUTCFullYear(),
      });
      withholding.push(taxed.value.escrow);
      creditAmount = taxed.value.net_cents;
      if (taxed.value.withheld_cents > 0) {
        await creditVault(
          store,
          allocation.payeeId,
          allocation.payeeName,
          taxed.value.withheld_cents,
          "reserve",
          now,
        );
        glLegs.push(
          vaultCredit(allocation.payeeId, "reserve", taxed.value.withheld_cents),
        );
      }
    }
    const credited = await creditWaterfallPayee(
      allocation.payeeId,
      allocation.payeeName,
      creditAmount,
    );
    rosterCredits.push({
      payee_id: allocation.payeeId,
      payee_name: allocation.payeeName,
      role: allocation.role,
      gross_cents: allocation.amountCents,
      net_cents: credited,
    });
  }

  if (plan.companyDustCents > 0) {
    dustLedger.push(
      await store.insertCompanyDust({
        split_run_id: row.split_run_id,
        line_item_id: row.line_item_id,
        amount_cents: plan.companyDustCents,
        variance_account_id: COMPANY_VARIANCE_PAYEE_ID,
        created_at: now.toISOString(),
      }),
    );
    await creditVault(
      store,
      COMPANY_VARIANCE_PAYEE_ID,
      COMPANY_VARIANCE_PAYEE_NAME,
      plan.companyDustCents,
      "pending",
      now,
    );
    glLegs.push(vaultCredit(COMPANY_VARIANCE_PAYEE_ID, "pending", plan.companyDustCents));
  }

  // The zero-balance check: recoupment + org + roster + dust === the locked
  // receipt, ALWAYS (the plan conserves by construction; the check is the
  // tripwire that refuses to post a journal that does not).
  const routedTotal =
    plan.venuePaidCents +
    plan.travelPaidCents +
    plan.orgPaidCents +
    plan.rosterAllocations.reduce((total, a) => total + a.amountCents, 0) +
    plan.companyDustCents;
  if (
    !zeroBalanceHolds(
      row.amount_cents,
      [
        { amount_cents: plan.venuePaidCents },
        { amount_cents: plan.travelPaidCents },
        { amount_cents: plan.orgPaidCents },
        ...plan.rosterAllocations.map((a) => ({ amount_cents: a.amountCents })),
      ],
      plan.companyDustCents,
    ) ||
    routedTotal !== row.amount_cents
  ) {
    return {
      ok: false,
      status: 500,
      code: "zero_balance_violation",
      message:
        "Waterfall routing + dust !== locked receipt — release refused.",
    };
  }

  const posted = await postJournal(
    store,
    {
      kind: "esports_pool_escrow_release",
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
      plan,
      roster_credits: rosterCredits,
      company_dust_cents: plan.companyDustCents,
      dust_ledger: dustLedger,
      unrecouped_cents: plan.unrecoupedCents,
      journal_id: posted.journal.id,
    },
  };
}
