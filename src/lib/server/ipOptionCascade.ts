// IP adaptation optioning — the author-first option-fee cascade (PR 21,
// founder directive).
//
// When a webtoon series or novel is optioned for film, TV, or gaming
// adaptation, the option fee routes through the Don Ledger with the
// original author's IP ownership allocations prioritized BEFORE any agency
// commission — the inverse of the translation cascade's localizer-first
// ordering, and the point of this lane: the author's ring-fenced IP share
// is reserved in full before the agency's commission is even COMPUTED, and
// the commission derives from the REMAINDER only, never from the gross.
//
// The three moves, in the founder's mandated order:
//
//   1. AUTHOR IP ALLOCATIONS — the ordered ip_option_author_allocations of
//      record (migration 0025), each a basis-point share OF THE OPTION FEE
//      (registration order = reservation order; UNIQUE per (work, payee)).
//   2. AGENCY COMMISSION — basis points OF THE REMAINDER after every
//      author allocation is reserved (never of the gross — a hand-checkable
//      999-cent case pins the distinction in tests).
//   3. AUTHOR'S RESIDUAL — what survives, credited to the agreement's
//      author of record, LAST.
//
// The money path is the canonical recon posting seam: the fee's arrival
// posts to UNCLAIMED_HOLDING through postToUnclaimedHolding (no new post
// kind — the seam IS the arrival path, journal-ref-guarded per
// content-derived source event, 409 on replay), and the verified release
// consumes one held credit through the same fail-closed gate family every
// payout uses — operator settlement approval, Plaid-backed KYC, and the
// publishing vertical's compliance state, whose ip_rights_cleared
// condition resolves from the DURABLE verification rows this chain ships
// (publishingIpRights.ts) — before the exact-amount routing and the
// balanced ip_option_release journal.
//
// THE EXACT-AMOUNT RELEASE. The seam's own releaseUnclaimedHolding
// allocates bps-of-gross; this lane's legs are EXACT integer cents (the
// webtoon translation-escrow release's discipline — plan first, then route
// exactly what the plan computed, dust swept defensively). The settlement
// CAS (settleUnclaimedHolding) flips the held row BEFORE any money moves —
// insert-as-lock, the payout-reversal precedent: a crash mid-release fails
// toward "nothing moved twice".

import type { Store } from "@/lib/server/store";
import type { LedgerTransactionRecord } from "@/lib/don/types";
import {
  BPS_DENOMINATOR,
  COMPANY_VARIANCE_PAYEE_ID,
  COMPANY_VARIANCE_PAYEE_NAME,
} from "@/modules/don/constants";
import { zeroBalanceHolds } from "@/modules/don/dust";
import type {
  CompanyDustRecord,
  IpOptionAgreementRecord,
  IpOptionAuthorAllocationRecord,
  TaxEscrowRecord,
} from "@/modules/don/records";
import { applyWithholding } from "@/modules/compliance/engine";
import { applyRecoupmentSweep } from "@/modules/recoupment/engine";
import {
  evaluatePayoutCompliance,
  getVerticalComplianceStateSource,
  resolveCreatorKycStatus,
} from "@/modules/compliance/payoutGate";
import { resolvePublishingIpRightsCleared } from "@/modules/compliance/publishingIpRights";
import { postToUnclaimedHolding } from "@/lib/server/unclaimedHolding";
import { postJournal } from "@/modules/ledger/engine";
import {
  unclaimedHoldingDebit,
  vaultCredit,
  type GlLegInput,
} from "@/modules/ledger/journal";
import { creditVault } from "@/modules/vaults/engine";
import { isIncomingFrozen } from "@/modules/vaults/dispute";
import { isWithholdableTalentRole } from "@/lib/server/vtuberAgency";

/** House failure envelope — the webtoon cascade / unclaimed-holding shape. */
export type IpOptionCascadeFailure = {
  ok: false;
  status: number;
  code: string;
  message: string;
};

// ---------------------------------------------------------------------------
// The plan — the pure author-first allocator.
// ---------------------------------------------------------------------------

/** One author-side IP allocation leg, in registration (reservation) order. */
export type IpOptionAuthorLeg = {
  payee_id: string;
  payee_name: string;
  /** Basis points OF THE OPTION FEE — ring-fenced before any commission. */
  allocation_bps: number;
  amount_cents: number;
};

export type IpOptionReleasePlan = {
  /** The option fee the plan splits — the held credit's amount of record. */
  option_fee_cents: number;
  /** The author IP allocations, reserved FIRST, in registration order. */
  author_allocations: IpOptionAuthorLeg[];
  /** Σ author allocations — the pool the agency commission never touches. */
  author_allocated_total_cents: number;
  /** The fee remainder after the author IP allocations. */
  remainder_cents: number;
  agency: { payee_id: string; payee_name: string };
  /** The agency commission — basis points OF THE REMAINDER, floored. */
  agency_commission_cents: number;
  /** The author of record's residual — what survives the cascade, LAST. */
  author_residual: { payee_id: string; payee_name: string; amount_cents: number };
  /**
   * Structurally zero under the subtraction model (every cent is either
   * allocated, commissioned, or residual) — computed defensively and swept
   * to the platform variance account if it ever differs.
   */
  company_dust_cents: number;
};

export type IpOptionReleasePlanInput = {
  option_fee_cents: number;
  author_allocations: Array<{
    payee_id: string;
    payee_name: string;
    allocation_bps: number;
  }>;
  agency: { payee_id: string; payee_name: string; commission_bps: number };
  /** The agreement's author of record — the residual holder. */
  author: { payee_id: string; payee_name: string };
};

export type IpOptionReleasePlanResult =
  | { ok: true; value: IpOptionReleasePlan }
  | IpOptionCascadeFailure;

/**
 * The PURE author-first allocator — identical arithmetic across every
 * backend and every caller, and the test pin for the founder's ordering:
 * allocations of the fee first, commission of the remainder second, the
 * author's residual last. Integer-exact throughout; floored legs, never
 * fractional cents. Refuses (fail-closed) a malformed party, a duplicate
 * allocation payee, an agency allocation, or allocations promising more
 * than the fee carries.
 */
export function buildIpOptionReleasePlan(
  input: IpOptionReleasePlanInput,
): IpOptionReleasePlanResult {
  const { option_fee_cents } = input;
  if (!Number.isSafeInteger(option_fee_cents) || option_fee_cents <= 0) {
    return {
      ok: false,
      status: 422,
      code: "invalid_option_fee",
      message: "An option fee splits integer cents greater than zero.",
    };
  }
  if (input.author.payee_id.trim() === "" || input.author.payee_name.trim() === "") {
    return {
      ok: false,
      status: 422,
      code: "invalid_author_identity",
      message: "An option release names the author of record (id and name).",
    };
  }
  if (input.agency.payee_id.trim() === "" || input.agency.payee_name.trim() === "") {
    return {
      ok: false,
      status: 422,
      code: "invalid_agency_identity",
      message: "An option release names the agency of record (id and name).",
    };
  }
  const { commission_bps } = input.agency;
  if (!Number.isSafeInteger(commission_bps) || commission_bps < 0 || commission_bps > BPS_DENOMINATOR) {
    return {
      ok: false,
      status: 422,
      code: "invalid_agency_commission_bps",
      message: "The agency commission is whole basis points between 0 and 10000 of the remainder.",
    };
  }

  const seenPayees = new Set<string>();
  const authorAllocations: IpOptionAuthorLeg[] = [];
  let authorAllocatedTotalCents = 0;
  for (const allocation of input.author_allocations) {
    if (allocation.payee_id.trim() === "" || allocation.payee_name.trim() === "") {
      return {
        ok: false,
        status: 422,
        code: "invalid_allocation_identity",
        message: "Every author IP allocation names its holder (id and name).",
      };
    }
    if (
      !Number.isSafeInteger(allocation.allocation_bps) ||
      allocation.allocation_bps <= 0 ||
      allocation.allocation_bps > BPS_DENOMINATOR
    ) {
      return {
        ok: false,
        status: 422,
        code: "invalid_allocation_bps",
        message: "Every author IP allocation is whole basis points between 1 and 10000 of the fee.",
      };
    }
    if (allocation.payee_id === input.agency.payee_id) {
      return {
        ok: false,
        status: 422,
        code: "agency_cannot_hold_ip_allocation",
        message: "The agency's share is its commission of the remainder — an agency IP allocation would blur author-first.",
      };
    }
    if (seenPayees.has(allocation.payee_id)) {
      return {
        ok: false,
        status: 422,
        code: "duplicate_allocation_payee",
        message: `Payee "${allocation.payee_id}" holds two IP allocations on one work — the registry's UNIQUE(work, payee) forbids it.`,
      };
    }
    seenPayees.add(allocation.payee_id);
    // Floored basis points of the FEE — the ring-fenced reservation.
    const amountCents = Math.floor(
      (option_fee_cents * allocation.allocation_bps) / BPS_DENOMINATOR,
    );
    authorAllocations.push({ ...allocation, amount_cents: amountCents });
    authorAllocatedTotalCents += amountCents;
  }

  const remainderCents = option_fee_cents - authorAllocatedTotalCents;
  if (remainderCents < 0) {
    return {
      ok: false,
      status: 422,
      code: "allocations_exceed_option_fee",
      message: `Author IP allocations reserve ${authorAllocatedTotalCents} of ${option_fee_cents} cents — the registry cannot promise more than the fee carries.`,
    };
  }

  // The commission is basis points OF THE REMAINDER — computed only after
  // every author allocation is reserved. This line is the founder's
  // inverted priority, in arithmetic form.
  const agencyCommissionCents = Math.floor((remainderCents * commission_bps) / BPS_DENOMINATOR);
  const authorResidualCents = remainderCents - agencyCommissionCents;
  const companyDustCents =
    option_fee_cents - authorAllocatedTotalCents - agencyCommissionCents - authorResidualCents;

  return {
    ok: true,
    value: {
      option_fee_cents,
      author_allocations: authorAllocations,
      author_allocated_total_cents: authorAllocatedTotalCents,
      remainder_cents: remainderCents,
      agency: {
        payee_id: input.agency.payee_id,
        payee_name: input.agency.payee_name,
      },
      agency_commission_cents: agencyCommissionCents,
      author_residual: {
        payee_id: input.author.payee_id,
        payee_name: input.author.payee_name,
        amount_cents: authorResidualCents,
      },
      company_dust_cents: companyDustCents,
    },
  };
}

// ---------------------------------------------------------------------------
// The arrival — the option fee posts to holding through the canonical seam.
// ---------------------------------------------------------------------------

export interface IpOptionFeePostInput {
  /** The optioned work the fee buys the adaptation rights to. */
  work_id: string;
  /** The option fee, integer cents. */
  option_fee_cents: number;
  currency: string;
  /**
   * The recon settlement event id carrying this fee. Optional — the default
   * is CONTENT-DERIVED from the deal terms, so re-posting the same option
   * event (whatever id the caller invents) still hits the journal-ref
   * replay guard and 409s instead of double-holding.
   */
  source_event_id?: string;
}

export type IpOptionFeePostSuccess = {
  ok: true;
  value: {
    /** The held credit — kind and status both 'unclaimed_holding'. */
    holding_credit: LedgerTransactionRecord;
    journal_id: string;
    source_event_id: string;
  };
};

/**
 * Posts one option fee to UNCLAIMED_HOLDING through the canonical recon
 * seam — no new post kind, no direct payee credit, no vault. The fee stays
 * held until the verified release clears the gates; the seam's journal-ref
 * guard makes the post replay-idempotent per content-derived source event.
 */
export async function postOptionFeeToHolding(
  store: Store,
  input: IpOptionFeePostInput,
  now: Date = new Date(),
): Promise<IpOptionFeePostSuccess | IpOptionCascadeFailure> {
  if (input.work_id.trim() === "") {
    return {
      ok: false,
      status: 422,
      code: "invalid_work_identity",
      message: "An option fee names the work it optioned.",
    };
  }
  // The content-derived event id — the deal terms ARE the identity.
  const sourceEventId = input.source_event_id ?? `ip_option_${input.work_id}_${input.option_fee_cents}`;
  const posted = await postToUnclaimedHolding(
    store,
    {
      amount_cents: input.option_fee_cents,
      currency: input.currency,
      // The recon settlement event that carried the fee — the ref the
      // replay guard keys on (the journal-ref discipline, migration 0006).
      source: { type: "recon_job", job_id: sourceEventId },
    },
    now,
  );
  if (!posted.ok) {
    return posted;
  }
  return {
    ok: true,
    value: {
      holding_credit: posted.value.holding_credit,
      journal_id: posted.value.journal_id,
      source_event_id: sourceEventId,
    },
  };
}

// ---------------------------------------------------------------------------
// The verified release — the author-first exact-amount cascade.
// ---------------------------------------------------------------------------

export interface IpOptionReleaseInput {
  /** The held credit to release (the ledger row id). */
  holding_ledger_id: string;
  /** The optioned work — names the agreement of record. */
  work_id: string;
  /** The clearance gate's first condition — fail-closed on anything but true. */
  operator_settlement_approved: boolean;
  /**
   * The publishing vertical's print-title conditions, stated EXPLICITLY by
   * the caller — option fees are not print-title payouts, so nothing here
   * silently defaults them. The gate still requires both, fail-closed.
   */
  publishing_conditions: {
    return_reserve_period_elapsed: boolean;
    isbn_rights_verified: boolean;
  };
}

export type IpOptionReleaseCredit = {
  payee_id: string;
  payee_name: string;
  gross_cents: number;
  net_cents: number;
  step: "author_ip_allocation" | "agency_commission" | "author_residual";
};

export type IpOptionReleaseSuccess = {
  ok: true;
  value: {
    /** The released row — status 'settled', kind still 'unclaimed_holding'. */
    holding_credit: LedgerTransactionRecord;
    plan: IpOptionReleasePlan;
    credits: IpOptionReleaseCredit[];
    company_dust_cents: number;
    dust_ledger: CompanyDustRecord[];
    withholding: TaxEscrowRecord[];
    journal_id: string;
  };
};

/**
 * Releases one held option fee through the author-first cascade — ONLY
 * through the standing gate family:
 *
 *   1. the row must be a HELD holding credit (404 / 422 / 409 otherwise —
 *      a replayed release reads the 409, never a double release),
 *   2. the option agreement of record must exist for the work (422 —
 *      the money terms come from the registry, never the caller),
 *   3. the plan must build over the held amount (the pure allocator),
 *   4. EVERY credited payee must pass the SAME fail-closed payout
 *      compliance gate as a Lithic dispatch — operator settlement
 *      approval, Plaid-backed KYC, and the publishing vertical's state
 *      whose ip_rights_cleared resolves from the durable verification
 *      rows (absent/pending/failed refuse), plus the caller-stated print
 *      conditions,
 *   5. the settlement CAS must win BEFORE any money moves,
 *   6. then the exact-amount routing in the founder's mandated order —
 *      author IP allocations (registration order), agency commission,
 *      author's residual — each talent credit through the withholding
 *      escrow and recoupment-sweep discipline, dust swept to the platform,
 *      and the balanced ip_option_release journal.
 */
export async function releaseIpOptionFeeFromHolding(
  store: Store,
  input: IpOptionReleaseInput,
  now: Date = new Date(),
): Promise<IpOptionReleaseSuccess | IpOptionCascadeFailure> {
  const row = await store.getLedgerTransaction(input.holding_ledger_id);
  if (row === undefined) {
    return {
      ok: false,
      status: 404,
      code: "holding_credit_not_found",
      message: "No ledger transaction matches that id.",
    };
  }
  if (row.kind !== "unclaimed_holding") {
    return {
      ok: false,
      status: 422,
      code: "not_a_holding_credit",
      message: `Ledger transaction ${row.id} is kind "${row.kind}" — only unclaimed holding credits release here.`,
    };
  }
  if (row.status !== "unclaimed_holding") {
    return {
      ok: false,
      status: 409,
      code: "holding_already_released",
      message: `Holding credit ${row.id} is no longer held (status "${row.status}").`,
    };
  }
  if (input.work_id.trim() === "") {
    return {
      ok: false,
      status: 422,
      code: "invalid_work_identity",
      message: "An option release names the work it releases for.",
    };
  }

  // The option agreement of record — the money terms' ONLY source. A
  // release against a work with no registered option deal refuses before
  // the CAS (nothing routes, nothing locks).
  const agreement: IpOptionAgreementRecord | undefined = await store.getIpOptionAgreement(
    input.work_id,
  );
  if (agreement === undefined) {
    return {
      ok: false,
      status: 422,
      code: "missing_option_agreement",
      message: `No option agreement of record exists for work "${input.work_id}" — register the option deal before releasing its fee.`,
    };
  }
  const allocations: IpOptionAuthorAllocationRecord[] =
    await store.listIpOptionAuthorAllocations(input.work_id);

  const planned = buildIpOptionReleasePlan({
    option_fee_cents: row.amount_cents,
    author_allocations: allocations.map((allocation) => ({
      payee_id: allocation.payee_id,
      payee_name: allocation.payee_name,
      allocation_bps: allocation.allocation_bps,
    })),
    agency: {
      payee_id: agreement.agency_payee_id,
      payee_name: agreement.agency_payee_name,
      commission_bps: agreement.agency_commission_bps,
    },
    author: {
      payee_id: agreement.author_payee_id,
      payee_name: agreement.author_payee_name,
    },
  });
  if (!planned.ok) return planned;
  const plan = planned.value;

  // The clearance gate — every credited payee rides the SAME fail-closed
  // payout compliance gate as a Lithic dispatch, on the PUBLISHING
  // vertical: operator settlement approval, verified KYC, and the vertical
  // state whose ip_rights_cleared resolves DURABLY per (payee, work) —
  // absent, pending, and failed all refuse. The platform house payee holds
  // no KYC record by design and is skipped. Runs before the CAS.
  const verticalStateSource = getVerticalComplianceStateSource();
  const gatedParties: Array<{ payee_id: string; payee_name: string }> = [
    ...plan.author_allocations
      .filter((allocation) => allocation.amount_cents > 0)
      .map((allocation) => ({
        payee_id: allocation.payee_id,
        payee_name: allocation.payee_name,
      })),
    ...(plan.agency_commission_cents > 0
      ? [{ payee_id: plan.agency.payee_id, payee_name: plan.agency.payee_name }]
      : []),
    ...(plan.author_residual.amount_cents > 0
      ? [
          {
            payee_id: plan.author_residual.payee_id,
            payee_name: plan.author_residual.payee_name,
          },
        ]
      : []),
  ];
  const gatedPayees = new Set(
    gatedParties.map((party) => party.payee_id),
  );
  for (const payeeId of gatedPayees) {
    if (payeeId === COMPANY_VARIANCE_PAYEE_ID) continue;
    const kycStatus = await resolveCreatorKycStatus(store, payeeId);
    const verticalState = await verticalStateSource({
      payeeId,
      vertical: "publishing",
    });
    // The durable ip_rights_cleared resolution replaces whatever the
    // vertical-state source guessed — the verification rows are the state
    // of record for the option lane (fail-closed on absent). The print
    // conditions stay caller-stated: option fees are not print-title
    // payouts, so nothing defaults them. A null source (the recon layer has
    // populated no hold state) flows through and refuses the canonical
    // vertical_state_unknown — fail-closed, the default source's shape.
    const ipRightsCleared = await resolvePublishingIpRightsCleared(
      store,
      payeeId,
      input.work_id,
    );
    const compliance = evaluatePayoutCompliance({
      operatorSettlementApproved: input.operator_settlement_approved,
      kycStatus,
      verticalState:
        verticalState === null
          ? null
          : {
              vertical: "publishing",
              ip_rights_cleared: ipRightsCleared,
              return_reserve_period_elapsed:
                input.publishing_conditions.return_reserve_period_elapsed,
              isbn_rights_verified: input.publishing_conditions.isbn_rights_verified,
            },
    });
    if (!compliance.ok) {
      return {
        ok: false,
        status: 403,
        code: compliance.code,
        message: `Option-fee release refused for payee "${payeeId}": ${compliance.message}`,
      };
    }
  }

  // The CAS wins BEFORE any money moves (insert-as-lock): the concurrent
  // release loser reads undefined here and refuses with the same 409 a
  // replayed release gets.
  const settled = await store.settleUnclaimedHolding(row.id, now.toISOString());
  if (settled === undefined) {
    return {
      ok: false,
      status: 409,
      code: "holding_already_released",
      message: `Holding credit ${row.id} is no longer held — a concurrent release won.`,
    };
  }

  // The exact-amount routing, in the founder's mandated order. Every
  // branch conserves its cents; every talent credit rides the esports
  // waterfall's discipline: the catalog-dispute freeze check, withholding
  // off the top, then the recoupment sweep — never a bare vault credit.
  const glLegs: GlLegInput[] = [unclaimedHoldingDebit(row.amount_cents)];
  const withholding: TaxEscrowRecord[] = [];
  const dustLedger: CompanyDustRecord[] = [];
  const credits: IpOptionReleaseCredit[] = [];

  /**
   * Credits one talent payee exactly the way the webtoon cascade credits a
   * participant: withholding comes off the top (its reserve credit + GL
   * leg), then the freeze check, then the recoupment sweep (its own vault
   * writes; the GL legs mirror them), then the bare pending credit when no
   * advance exists. Returns the cents that landed in the payee's vault.
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
    // No work context exists on a holding credit — the catalog-dispute
    // freeze check runs against the empty work key, which no dispute row
    // occupies (honest not-frozen, not a skipped check).
    const incomingFrozen = await isIncomingFrozen(store, payeeId, "");
    const recouped = await applyRecoupmentSweep(store, payeeId, payeeName, creditAmount, now, {
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
    await creditVault(store, payeeId, payeeName, creditAmount, incomingFrozen ? "reserve" : "pending", now);
    glLegs.push(
      vaultCredit(payeeId, incomingFrozen ? "reserve" : "pending", creditAmount),
    );
    return creditAmount;
  };

  // Step 1 — the author IP allocations, in registration (reservation)
  // order. Ring-fenced: the agency commission below is computed AFTER
  // these amounts, never out of them.
  for (const allocation of plan.author_allocations) {
    const credited = await creditTaxedCascadePayee(
      allocation.payee_id,
      allocation.payee_name,
      allocation.amount_cents,
    );
    credits.push({
      payee_id: allocation.payee_id,
      payee_name: allocation.payee_name,
      gross_cents: allocation.amount_cents,
      net_cents: credited,
      step: "author_ip_allocation",
    });
  }

  // Step 2 — the agency commission, of the REMAINDER only.
  if (plan.agency_commission_cents > 0) {
    const credited = await creditTaxedCascadePayee(
      plan.agency.payee_id,
      plan.agency.payee_name,
      plan.agency_commission_cents,
    );
    credits.push({
      payee_id: plan.agency.payee_id,
      payee_name: plan.agency.payee_name,
      gross_cents: plan.agency_commission_cents,
      net_cents: credited,
      step: "agency_commission",
    });
  }

  // Step 3 — the author of record's residual, LAST.
  if (plan.author_residual.amount_cents > 0) {
    const credited = await creditTaxedCascadePayee(
      plan.author_residual.payee_id,
      plan.author_residual.payee_name,
      plan.author_residual.amount_cents,
    );
    credits.push({
      payee_id: plan.author_residual.payee_id,
      payee_name: plan.author_residual.payee_name,
      gross_cents: plan.author_residual.amount_cents,
      net_cents: credited,
      step: "author_residual",
    });
  }

  // The integer-cent dust — structurally zero under the subtraction model;
  // swept to the platform variance account with its own ledger rows if it
  // ever differs (the house dust discipline, retained defensively).
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

  // The zero-balance tripwire: allocations + commission + residual + dust
  // === the held fee, ALWAYS.
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
        "Author allocations + agency commission + author residual + dust !== held option fee — release refused.",
    };
  }

  const posted = await postJournal(store, {
    kind: "ip_option_release",
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
      holding_credit: settled,
      plan,
      credits,
      company_dust_cents: plan.company_dust_cents,
      dust_ledger: dustLedger,
      withholding,
      journal_id: posted.journal.id,
    },
  };
}
