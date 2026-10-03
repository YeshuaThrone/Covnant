// The NIL audit escrow + the transfer portal clawback (PR 35, founder
// directive).
//
// An athlete's compliance exposure on athletic department distributions —
// mid-season NCAA Transfer Portal reconciliation, tax withholdings
// surfacing after the distribution posted — is protected the same way the
// licensing audit reserve protects a licensor: a founder-banded 5–10%
// share of the distribution locks into an NIL_AUDIT_ESCROW per
// (payee, school) scope (sentinel payee + GL account — its own
// escrow-shaped money, never folded into platform dust, unclaimed
// holding, or any other escrow state), drawn down by transfer portal
// reconciliations and tax withholdings, and released only against the
// verified reconciliation of record (fail-closed: no reconciliation, no
// release).
//
// The money path is the canonical recon posting seam — the licensing
// reserve's pattern 1:1: an athletic department distribution arrives as a
// held unclaimed-holding credit, this lane consumes exactly ONE held
// credit through the NIL payout gate (nil_cleared + compliance_verified +
// title_ix_proportionality_cleared, resolved from the durable gate states
// of record — absent and unknown BOTH refuse), CAS-settles the held row
// BEFORE any money moves, splits the escrow share
// floor(amount × bps / 10000), and routes the exact-subtraction remainder
// to the athlete through the SAME fail-closed taxed cascade every payout
// rides. THE INVARIANT: athlete remainder + escrow + dust === the held
// credit, ALWAYS (allocations plus dust equals gross INCLUDING the escrow
// bucket).
//
// Drawdowns and the release commit position-locked (the licensing
// application discipline at NIL scope) before their money moves — the
// ordering is the point. The remaining balance derives from the
// append-only drawdown truth, never a mutable counter. The verified
// reconciliation of record is insert-as-lock (UNIQUE per escrow): the
// FIRST reconciliation wins, and the release reads it fail-closed.
//
// THE TRANSFER PORTAL CLAWBACK is the athlete-side debit lane: a portal
// entry recorded prior to contract completion prices the pro-rated
// unearned advance from the advance schedule of record (never the
// caller's numbers — floor-only integer arithmetic, earned + unearned ===
// the advance, dust-free by construction) and triggers the
// `nil_unearned_clawback` debit hold — the receivable's face on the Don
// ledger, posted with balanced GL legs (the athlete's receivable rises;
// the advance-recovery income of record rises). A portal entry on/after
// contract completion is fully earned: the entry records, nothing claws
// back. An entry with no advance schedule of record records too — the
// portal fact is real — but computes nothing (fail-closed: no terms, no
// clawback).

import type { Store } from "@/lib/server/store";
import type { LedgerTransactionRecord } from "@/lib/don/types";
import {
  COMPANY_VARIANCE_PAYEE_ID,
  COMPANY_VARIANCE_PAYEE_NAME,
  NIL_AUDIT_ESCROW_MAX_RATE_BPS,
  NIL_AUDIT_ESCROW_MIN_RATE_BPS,
  nilAuditEscrowPayeeId,
  nilAuditEscrowPayeeName,
} from "@/modules/don/constants";
import {
  NIL_AUDIT_ESCROW_DRAWDOWN_CLASSES,
  buildProratedClawbackPlan,
  type NilAuditEscrowDrawdownClass,
  type NilAuditEscrowDrawdownRecord,
  type NilAuditEscrowPolicyRecord,
  type NilAuditEscrowReconciliationRecord,
  type NilTransferPortalEntryRecord,
  type NilUnearnedClawbackRecord,
} from "@/modules/nil/records";
import type {
  CompanyDustRecord as DonCompanyDustRecord,
  TaxEscrowRecord as DonTaxEscrowRecord,
} from "@/modules/don/records";
import { applyWithholding } from "@/modules/compliance/engine";
import { applyRecoupmentSweep } from "@/modules/recoupment/engine";
import {
  evaluatePayoutCompliance,
  resolveCreatorKycStatus,
  resolveNilVerticalComplianceState,
} from "@/modules/compliance/payoutGate";
import { postJournal } from "@/modules/ledger/engine";
import {
  fboCredit,
  nilAuditEscrowCredit,
  nilAuditEscrowDebit,
  nilUnearnedClawbackReceivableDebit,
  nilUnearnedClawbackRecoveryCredit,
  unclaimedHoldingDebit,
  vaultCredit,
  type GlLegInput,
} from "@/modules/ledger/journal";
import { creditVault } from "@/modules/vaults/engine";
import { isIncomingFrozen } from "@/modules/vaults/dispute";
import { isWithholdableTalentRole } from "@/lib/server/vtuberAgency";
import { isUniqueViolation } from "@/lib/server/uniqueViolation";

/** House failure envelope — the licensing-reserve / merch cascade shape. */
export type NilAuditEscrowFailure = {
  ok: false;
  status: number;
  code: string;
  message: string;
};

/**
 * The house zero-balance invariant, scoped to a routing: the sum of the
 * allocations (athlete remainder, escrow bucket, drawdown spends) plus
 * the dust equals the gross it all came from — ALWAYS.
 */
export function nilZeroBalanceHolds(
  grossCents: number,
  allocations: { amount_cents: number }[],
  dustCents: number,
): boolean {
  if (!Number.isInteger(grossCents) || grossCents < 0 || !Number.isInteger(dustCents)) {
    return false;
  }
  let total = dustCents;
  for (const allocation of allocations) {
    if (!Number.isInteger(allocation.amount_cents) || allocation.amount_cents < 0) {
      return false;
    }
    total += allocation.amount_cents;
  }
  return total === grossCents;
}

// ---------------------------------------------------------------------------
// The scope identity + the policy registry — the money terms' ONLY source.
// ---------------------------------------------------------------------------

/** The escrow scope's key of record — `payee:{payee}:school:{school}`.
 * Injective in the pair: a scope key pins exactly one (payee, school). */
export function nilAuditEscrowScopeKey(payeeId: string, schoolId: string): string {
  return `payee:${payeeId}:school:${schoolId}`;
}

export type NilAuditEscrowPolicyInput = {
  /** The athlete payee the escrow protects. */
  payee_id: string;
  /** The athlete's school of record. */
  school_id: string;
  /** The founder-banded share, basis points of the distribution —
   * 500–1000 (5–10%). */
  reserve_rate_bps: number;
};

/**
 * Registers the NIL audit escrow's policy of record for one (payee,
 * school) scope — the rate inside the founder's 5–10% band, enforced at
 * registration AND at use. A re-registration converges (the newest rate
 * governs the next routing) — the option-agreement discipline.
 */
export async function registerNilAuditEscrowPolicy(
  store: Store,
  input: NilAuditEscrowPolicyInput,
): Promise<
  { ok: true; value: NilAuditEscrowPolicyRecord } | NilAuditEscrowFailure
> {
  if (input.payee_id.trim() === "" || input.school_id.trim() === "") {
    return {
      ok: false,
      status: 422,
      code: "invalid_scope_identity",
      message: "An NIL audit-escrow policy names the athlete and school it protects.",
    };
  }
  if (
    !Number.isInteger(input.reserve_rate_bps) ||
    input.reserve_rate_bps < NIL_AUDIT_ESCROW_MIN_RATE_BPS ||
    input.reserve_rate_bps > NIL_AUDIT_ESCROW_MAX_RATE_BPS
  ) {
    return {
      ok: false,
      status: 422,
      code: "escrow_rate_out_of_band",
      message: `The NIL escrow rate must sit inside the founder band (${NIL_AUDIT_ESCROW_MIN_RATE_BPS}–${NIL_AUDIT_ESCROW_MAX_RATE_BPS} bps — ${NIL_AUDIT_ESCROW_MIN_RATE_BPS / 100}–${NIL_AUDIT_ESCROW_MAX_RATE_BPS / 100}%).`,
    };
  }
  const policy = await store.upsertNilAuditEscrowPolicy({
    scope_key: nilAuditEscrowScopeKey(input.payee_id, input.school_id),
    reserve_rate_bps: input.reserve_rate_bps,
  });
  return { ok: true, value: policy };
}

/**
 * The PURE split plan — the founder-banded escrow share of an athletic
 * department distribution, computed in exact integer cents. The escrow
 * share floors the rate multiplication (never rounds up: the athlete's
 * routed share is the exact subtraction remainder, so amount = routed +
 * escrow + dust holds with dust structurally zero). Refuses a
 * non-integer or non-positive amount and a rate outside the founder band.
 */
export function buildNilAuditEscrowSplitPlan(input: {
  amount_cents: number;
  reserve_rate_bps: number;
}):
  | {
      ok: true;
      value: {
        amount_cents: number;
        escrow_cents: number;
        routed_cents: number;
        company_dust_cents: number;
      };
    }
  | NilAuditEscrowFailure {
  const { amount_cents, reserve_rate_bps } = input;
  if (!Number.isInteger(amount_cents) || amount_cents <= 0) {
    return {
      ok: false,
      status: 422,
      code: "invalid_allocation_amount",
      message: "An athletic department distribution splits in whole positive cents.",
    };
  }
  if (
    !Number.isInteger(reserve_rate_bps) ||
    reserve_rate_bps < NIL_AUDIT_ESCROW_MIN_RATE_BPS ||
    reserve_rate_bps > NIL_AUDIT_ESCROW_MAX_RATE_BPS
  ) {
    return {
      ok: false,
      status: 422,
      code: "escrow_rate_out_of_band",
      message: `The NIL escrow rate must sit inside the founder band (${NIL_AUDIT_ESCROW_MIN_RATE_BPS}–${NIL_AUDIT_ESCROW_MAX_RATE_BPS} bps — ${NIL_AUDIT_ESCROW_MIN_RATE_BPS / 100}–${NIL_AUDIT_ESCROW_MAX_RATE_BPS / 100}%).`,
    };
  }
  const escrow_cents = Math.floor((amount_cents * reserve_rate_bps) / 10_000);
  const routed_cents = amount_cents - escrow_cents;
  return {
    ok: true,
    value: {
      amount_cents,
      escrow_cents,
      routed_cents,
      company_dust_cents: 0,
    },
  };
}

export type NilAuditEscrowRouteInput = {
  holding_ledger_id: string;
  /** The athlete payee of the distribution — the scope's payee half. */
  athlete_id: string;
  /** The athlete's school — the scope's school half. */
  school_id: string;
  operator_settlement_approved: boolean;
};

export type NilAuditEscrowRouteCredit = {
  payee_id: string;
  payee_name: string;
  gross_cents: number;
  net_cents: number;
  step: string;
};

export type NilAuditEscrowRouteSuccess = {
  ok: true;
  value: {
    /** The settled holding row (status 'settled' after this routing). */
    distribution_credit: LedgerTransactionRecord;
    split: {
      amount_cents: number;
      escrow_cents: number;
      routed_cents: number;
      company_dust_cents: number;
    };
    /** The locked escrow row when the escrow share priced positive. */
    escrow_credit: LedgerTransactionRecord | null;
    credits: NilAuditEscrowRouteCredit[];
    withholding: DonTaxEscrowRecord[];
    company_dust_cents: number;
    journal_id: string;
  };
};

/**
 * The taxed cascade one payee's credit rides — withholding off the top,
 * the catalog-dispute freeze check, the recoupment sweep. The SAME
 * fail-closed family every payout credits through; returns the net that
 * actually landed in the payee's vault. (The house convention keeps this
 * cascade per-lane — the licensing / merch-collab / ip-option lanes each
 * carry their own copy; this is the NIL lane's.)
 */
async function creditTaxedCascadePayee(
  store: Store,
  payeeId: string,
  payeeName: string,
  grossCents: number,
  now: Date,
  glLegs: GlLegInput[],
  withholding: DonTaxEscrowRecord[],
): Promise<number> {
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
  // No work context exists on a distribution credit — the catalog-dispute
  // freeze check runs against the empty work key, which no dispute row
  // occupies (honest not-frozen, not a skipped check).
  const incomingFrozen = await isIncomingFrozen(store, payeeId, "");
  const recouped = await applyRecoupmentSweep(
    store,
    payeeId,
    payeeName,
    creditAmount,
    now,
    { excess_target: incomingFrozen ? "reserve" : "available" },
  );
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
  await creditVault(
    store,
    payeeId,
    payeeName,
    creditAmount,
    incomingFrozen ? "reserve" : "pending",
    now,
  );
  glLegs.push(vaultCredit(payeeId, incomingFrozen ? "reserve" : "pending", creditAmount));
  return creditAmount;
}

/**
 * Routes ONE held athletic department distribution credit through the NIL
 * audit escrow split: the payout gate (fail-closed), the CAS, the
 * founder-banded escrow lock, and the exact-subtraction remainder through
 * the taxed cascade to the athlete. Idempotent BY HELD CREDIT: a replayed
 * routing reads the already-settled row and refuses with the same 409 —
 * never a second split.
 */
export async function routeNilAuditEscrowFromDistribution(
  store: Store,
  input: NilAuditEscrowRouteInput,
  now: Date = new Date(),
): Promise<NilAuditEscrowRouteSuccess | NilAuditEscrowFailure> {
  const row = await store.getLedgerTransaction(input.holding_ledger_id);
  if (row === undefined) {
    return {
      ok: false,
      status: 404,
      code: "distribution_credit_not_found",
      message: "No ledger transaction matches that id.",
    };
  }
  if (row.kind !== "unclaimed_holding") {
    return {
      ok: false,
      status: 422,
      code: "not_a_holding_credit",
      message: `Ledger transaction ${row.id} is kind "${row.kind}" — only unclaimed holding credits route here.`,
    };
  }
  if (row.status !== "unclaimed_holding") {
    return {
      ok: false,
      status: 409,
      code: "distribution_already_released",
      message: `Distribution credit ${row.id} is no longer held (status "${row.status}").`,
    };
  }
  if (input.athlete_id.trim() === "" || input.school_id.trim() === "") {
    return {
      ok: false,
      status: 422,
      code: "invalid_scope_identity",
      message: "An NIL escrow routing names the athlete and school it protects.",
    };
  }
  const scopeKey = nilAuditEscrowScopeKey(input.athlete_id, input.school_id);

  // The terms of record — the policy (the rate) comes from the registry,
  // never the caller. A scope with no registered policy means the
  // athlete's contract names no escrow term: nothing routes (a counted
  // refusal, never a guessed rate).
  const policy: NilAuditEscrowPolicyRecord | undefined =
    await store.getNilAuditEscrowPolicy(scopeKey);
  if (policy === undefined) {
    return {
      ok: false,
      status: 422,
      code: "missing_nil_audit_escrow_policy",
      message: `No NIL audit-escrow policy of record exists for scope "${scopeKey}" — register the athlete's escrow term before routing distributions.`,
    };
  }

  // The split — plan BEFORE anything moves (the exact-amount discipline).
  const splitPlanned = buildNilAuditEscrowSplitPlan({
    amount_cents: row.amount_cents,
    reserve_rate_bps: policy.reserve_rate_bps,
  });
  if (!splitPlanned.ok) return splitPlanned;
  const split = splitPlanned.value;

  // THE NIL PAYOUT GATE — the vertical's compliance state resolves from
  // the durable gate states of record (migration 0038): an ABSENT record
  // resolves null (the gate refuses with vertical_state_unknown) and an
  // 'unknown' state refuses the specific condition (nil_not_cleared /
  // nil_compliance_unverified / nil_title_ix_proportionality_not_cleared)
  // — fail-closed, before the CAS. Runs for the athlete this routing
  // credits.
  const kycStatus = await resolveCreatorKycStatus(store, input.athlete_id);
  const verticalState = await resolveNilVerticalComplianceState(
    store,
    input.athlete_id,
    input.school_id,
  );
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
      message: `NIL escrow routing refused for athlete "${input.athlete_id}": ${compliance.message}`,
    };
  }

  // The CAS wins BEFORE any money moves (insert-as-lock): the concurrent
  // routing loser reads undefined here and refuses with the same 409 a
  // replayed routing gets.
  const settled = await store.settleUnclaimedHolding(row.id, now.toISOString());
  if (settled === undefined) {
    return {
      ok: false,
      status: 409,
      code: "distribution_already_released",
      message: `Distribution credit ${row.id} is no longer held — a concurrent routing won.`,
    };
  }

  // The exact-amount routing: the non-escrow remainder rides the taxed
  // cascade; the escrow share locks as its own ledger row — kind AND
  // status 'nil_audit_escrow', the per-scope sentinel payee (deliberately
  // not 'platform', not the unclaimed-holding sentinel, not any earlier
  // escrow prefix), the scope stamped in line_item_id so the row is
  // discoverable through the existing line-item index and the release can
  // re-derive state from the same registry. A floor of zero on a
  // sub-10-cent distribution locks no row — there is nothing to hold and
  // a zero-amount ledger row would be noise.
  const glLegs: GlLegInput[] = [unclaimedHoldingDebit(row.amount_cents)];
  const withholding: DonTaxEscrowRecord[] = [];
  const credits: NilAuditEscrowRouteCredit[] = [];
  let landedNetCents = 0;
  if (split.routed_cents > 0) {
    landedNetCents = await creditTaxedCascadePayee(
      store,
      input.athlete_id,
      `NIL athlete ${input.athlete_id}`,
      split.routed_cents,
      now,
      glLegs,
      withholding,
    );
    credits.push({
      payee_id: input.athlete_id,
      payee_name: `NIL athlete ${input.athlete_id}`,
      gross_cents: split.routed_cents,
      net_cents: landedNetCents,
      step: "athlete_net",
    });
  }
  let escrowCredit: LedgerTransactionRecord | null = null;
  if (split.escrow_cents > 0) {
    escrowCredit = await store.insertLedgerTransaction({
      split_run_id: "",
      line_item_id: scopeKey,
      payee_id: nilAuditEscrowPayeeId(scopeKey),
      payee_name: nilAuditEscrowPayeeName(scopeKey),
      role: "other",
      share_bps: 0,
      amount_cents: split.escrow_cents,
      currency: row.currency,
      status: "nil_audit_escrow",
      rail: null,
      baas_provider: null,
      baas_transfer_id: null,
      created_at: now.toISOString(),
      settled_at: null,
      kind: "nil_audit_escrow",
    });
    glLegs.push(nilAuditEscrowCredit(scopeKey, split.escrow_cents));
  }

  // The integer-cent dust — structurally zero under the subtraction
  // model; swept to the platform variance account with its own ledger
  // rows if it ever differs (the house dust discipline, retained
  // defensively).
  const companyDustCents = split.company_dust_cents;
  let dustRecord: DonCompanyDustRecord | null = null;
  if (companyDustCents > 0) {
    dustRecord = await store.insertCompanyDust({
      split_run_id: row.split_run_id,
      line_item_id: row.line_item_id,
      amount_cents: companyDustCents,
      variance_account_id: COMPANY_VARIANCE_PAYEE_ID,
      created_at: now.toISOString(),
    });
    await creditVault(
      store,
      COMPANY_VARIANCE_PAYEE_ID,
      COMPANY_VARIANCE_PAYEE_NAME,
      companyDustCents,
      "pending",
      now,
    );
    glLegs.push(vaultCredit(COMPANY_VARIANCE_PAYEE_ID, "pending", companyDustCents));
  }

  // The zero-balance tripwire: athlete remainder + escrow + dust === the
  // held credit, ALWAYS — the Don invariant (allocations plus dust equals
  // gross) WITH the escrow bucket inside the allocation total.
  if (
    !nilZeroBalanceHolds(
      row.amount_cents,
      [{ amount_cents: split.routed_cents }, { amount_cents: split.escrow_cents }],
      companyDustCents,
    )
  ) {
    return {
      ok: false,
      status: 500,
      code: "zero_balance_violation",
      message:
        "NIL remainder + audit escrow + dust !== held credit — routing refused.",
    };
  }

  const posted = await postJournal(store, {
    kind: "nil_audit_escrow_route",
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
      distribution_credit: settled,
      split,
      escrow_credit: escrowCredit,
      credits,
      withholding,
      company_dust_cents: companyDustCents,
      journal_id: posted.journal.id,
    },
  };
}

// ---------------------------------------------------------------------------
// The drawdown lane — mid-season NCAA Transfer Portal reconciliations and
// tax withholdings spend the escrow.
// ---------------------------------------------------------------------------

export type NilAuditEscrowDrawdownInput = {
  reserve_ledger_id: string;
  scope_key: string;
  drawdown_class: string;
  source_event_id: string;
  drawn_cents: number;
};

export type NilAuditEscrowDrawdownSuccess = {
  ok: true;
  value: {
    drawdown: NilAuditEscrowDrawdownRecord;
    replayed: boolean;
    journal_id: string | null;
  };
};

/**
 * Draws the NIL audit escrow down — a mid-season NCAA Transfer Portal
 * reconciliation or a tax withholding spending the escrow's balance. The
 * drawdown row commits position-locked BEFORE the money moves; a drawdown
 * that consumes the LAST cent settles the escrow first (the CAS
 * arbitrates against a concurrent release); money never leaves a settled
 * escrow.
 */
export async function drawDownNilAuditEscrow(
  store: Store,
  input: NilAuditEscrowDrawdownInput,
  now: Date = new Date(),
): Promise<NilAuditEscrowDrawdownSuccess | NilAuditEscrowFailure> {
  const row = await store.getLedgerTransaction(input.reserve_ledger_id);
  if (row === undefined) {
    return {
      ok: false,
      status: 404,
      code: "escrow_credit_not_found",
      message: "No ledger transaction matches that id.",
    };
  }
  if (row.kind !== "nil_audit_escrow") {
    return {
      ok: false,
      status: 422,
      code: "not_an_escrow_credit",
      message: `Ledger transaction ${row.id} is kind "${row.kind}" — only NIL audit-escrow credits draw down here.`,
    };
  }
  if (row.status !== "nil_audit_escrow") {
    return {
      ok: false,
      status: 409,
      code: "escrow_already_settled",
      message: `Escrow credit ${row.id} is no longer held (status "${row.status}") — nothing draws from a settled escrow.`,
    };
  }
  // The scope cross-check — the caller names the scope; the escrow row's
  // sentinel payee must match it exactly (the terms-of-record discipline).
  if (row.payee_id !== nilAuditEscrowPayeeId(input.scope_key)) {
    return {
      ok: false,
      status: 422,
      code: "escrow_scope_mismatch",
      message: `Escrow credit ${row.id} belongs to a different scope than "${input.scope_key}".`,
    };
  }
  if (
    !NIL_AUDIT_ESCROW_DRAWDOWN_CLASSES.some((cls) => cls === input.drawdown_class)
  ) {
    return {
      ok: false,
      status: 422,
      code: "invalid_drawdown_class",
      message:
        "An NIL escrow drawdown is a transfer_portal_reconciliation or a tax_withholding.",
    };
  }
  if (!Number.isInteger(input.drawn_cents) || input.drawn_cents <= 0) {
    return {
      ok: false,
      status: 422,
      code: "invalid_drawdown_amount",
      message: "An escrow drawdown spends whole positive cents.",
    };
  }

  // The position derives from the append-only truth — never a second
  // mutable counter.
  const drawdowns: NilAuditEscrowDrawdownRecord[] =
    await store.listNilAuditEscrowDrawdowns(row.id);
  const drawnBefore = drawdowns.reduce((total, line) => total + line.drawn_cents, 0);
  const remaining = row.amount_cents - drawnBefore;
  if (input.drawn_cents > remaining) {
    return {
      ok: false,
      status: 422,
      code: "escrow_overdrawn",
      message: `Drawdown of ${input.drawn_cents} exceeds the escrow's remaining ${remaining} — refuse, never clip.`,
    };
  }

  const instant = now.toISOString();

  // A drawdown that consumes the LAST cent settles the escrow FIRST (the
  // CAS arbitrates against a concurrent release BEFORE any row or money
  // commits — the winner is the only lane that touches the escrow).
  const fullyDrawn = remaining - input.drawn_cents === 0;
  if (fullyDrawn) {
    const settled = await store.settleNilAuditEscrow(row.id, instant);
    if (settled === undefined) {
      return {
        ok: false,
        status: 409,
        code: "escrow_already_settled",
        message: `Escrow credit ${row.id} is no longer held — a concurrent release or drawdown won.`,
      };
    }
  }

  // The position-locked insert — the replay guard AND the arbiter, in one
  // write. A unique violation is disambiguated against the append-only
  // truth: a row with this source event already exists → the re-shipped
  // event's counted no-op; otherwise the position conflict re-throws (the
  // caller retries and re-derives from the fresh truth).
  let drawdown: NilAuditEscrowDrawdownRecord;
  try {
    drawdown = await store.insertNilAuditEscrowDrawdown({
      reserve_ledger_id: row.id,
      scope_key: input.scope_key,
      drawdown_class: input.drawdown_class as NilAuditEscrowDrawdownClass,
      source_event_id: input.source_event_id,
      drawn_before_cents: drawnBefore,
      drawn_cents: input.drawn_cents,
      remaining_cents: remaining - input.drawn_cents,
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      const all = await store.listNilAuditEscrowDrawdowns(row.id);
      const existing = all.find((line) => line.source_event_id === input.source_event_id);
      if (existing !== undefined) {
        return {
          ok: true,
          value: { drawdown: existing, replayed: true, journal_id: null },
        };
      }
    }
    throw error;
  }

  // The held-state re-check AFTER the position commit: money never leaves
  // a settled escrow. A concurrent release that won between the insert
  // and this read has already routed the balance — this drawdown refuses
  // without moving a cent (the recon alarms surface the refused row's
  // inconsistency; the money never double-moves).
  if (!fullyDrawn) {
    const rechecked = await store.getLedgerTransaction(row.id);
    if (rechecked === undefined || rechecked.status !== "nil_audit_escrow") {
      return {
        ok: false,
        status: 409,
        code: "escrow_already_settled",
        message: `Escrow credit ${row.id} is no longer held — a concurrent release won.`,
      };
    }
  }

  // The drawdown's own journal: the escrow account debits back to FBO
  // cash — the reconciliation's or withholding's expense, itemized.
  const posted = await postJournal(store, {
    kind: "nil_audit_escrow_drawdown",
    ref_type: "ledger_transaction",
    ref_id: row.id,
    legs: [
      nilAuditEscrowDebit(input.scope_key, input.drawn_cents),
      fboCredit(input.drawn_cents),
    ],
  });
  if (!posted.ok) {
    return { ok: false, status: 500, code: posted.code, message: posted.message };
  }

  return {
    ok: true,
    value: { drawdown, replayed: false, journal_id: posted.journal.id },
  };
}

// ---------------------------------------------------------------------------
// The verified reconciliation of record + the release lane.
// ---------------------------------------------------------------------------

export type NilAuditEscrowReconcileInput = {
  reserve_ledger_id: string;
  scope_key: string;
  evidence_ref: string;
  reconciled_by: string;
};

/**
 * Records the verified reconciliation of record for one NIL escrow — the
 * release gate's key. Insert-as-lock: the FIRST reconciliation wins; a
 * concurrent second reconciliation surfaces the conflict (the escrow is
 * reconciled once, by one verified audit).
 */
export async function reconcileNilAuditEscrow(
  store: Store,
  input: NilAuditEscrowReconcileInput,
): Promise<
  { ok: true; value: NilAuditEscrowReconciliationRecord } | NilAuditEscrowFailure
> {
  const row = await store.getLedgerTransaction(input.reserve_ledger_id);
  if (row === undefined) {
    return {
      ok: false,
      status: 404,
      code: "escrow_credit_not_found",
      message: "No ledger transaction matches that id.",
    };
  }
  if (
    row.kind !== "nil_audit_escrow" ||
    row.payee_id !== nilAuditEscrowPayeeId(input.scope_key)
  ) {
    return {
      ok: false,
      status: 422,
      code: "not_an_escrow_credit",
      message: `Ledger transaction ${row.id} is not this scope's NIL audit-escrow credit.`,
    };
  }
  if (input.evidence_ref.trim() === "" || input.reconciled_by.trim() === "") {
    return {
      ok: false,
      status: 422,
      code: "invalid_reconciliation_evidence",
      message: "A verified reconciliation carries evidence and a reconciler of record.",
    };
  }
  const reconciliation = await store.insertNilAuditEscrowReconciliation({
    reserve_ledger_id: input.reserve_ledger_id,
    evidence_ref: input.evidence_ref,
    reconciled_by: input.reconciled_by,
  });
  return { ok: true, value: reconciliation };
}

export type NilAuditEscrowReleaseInput = {
  reserve_ledger_id: string;
  /** Must equal the scope the escrow routed under — derived from the
   * athlete + school pair and cross-checked against the sentinel payee. */
  scope_key: string;
  athlete_id: string;
  school_id: string;
  operator_settlement_approved: boolean;
};

export type NilAuditEscrowReleaseSuccess = {
  ok: true;
  value: {
    /** The settled escrow row (status 'settled' after this release). */
    escrow_credit: LedgerTransactionRecord;
    released_cents: number;
    credits: NilAuditEscrowRouteCredit[];
    withholding: DonTaxEscrowRecord[];
    company_dust_cents: number;
    journal_id: string;
  };
};

/**
 * Releases a held NIL audit escrow to the athlete through the taxed
 * cascade — the VERIFIED release: the reconciliation of record must exist
 * (fail-closed, before the CAS — no reconciliation of record, no
 * release), the remaining balance re-derived from the append-only
 * drawdown truth, the NIL payout gate re-resolved from the durable gate
 * states of record, the scope cross-checked against the (athlete, school)
 * pair, the CAS BEFORE any money moves, and the taxed cascade for the
 * actual routing. Drawdowns already spent stay spent — the release pays
 * only what the compliance exposure protected.
 */
export async function releaseNilAuditEscrow(
  store: Store,
  input: NilAuditEscrowReleaseInput,
  now: Date = new Date(),
): Promise<NilAuditEscrowReleaseSuccess | NilAuditEscrowFailure> {
  const row = await store.getLedgerTransaction(input.reserve_ledger_id);
  if (row === undefined) {
    return {
      ok: false,
      status: 404,
      code: "escrow_credit_not_found",
      message: "No ledger transaction matches that id.",
    };
  }
  if (row.kind !== "nil_audit_escrow") {
    return {
      ok: false,
      status: 422,
      code: "not_an_escrow_credit",
      message: `Ledger transaction ${row.id} is kind "${row.kind}" — only NIL audit-escrow credits release here.`,
    };
  }
  if (row.status !== "nil_audit_escrow") {
    return {
      ok: false,
      status: 409,
      code: "escrow_already_settled",
      message: `Escrow credit ${row.id} is no longer held (status "${row.status}").`,
    };
  }
  // The scope cross-check, twice over: the caller names the scope AND the
  // (athlete, school) pair it releases to — the pair must re-derive the
  // scope exactly (the key is injective in the pair), and the escrow
  // row's sentinel payee must match it.
  if (
    input.athlete_id.trim() === "" ||
    input.school_id.trim() === "" ||
    nilAuditEscrowScopeKey(input.athlete_id, input.school_id) !== input.scope_key
  ) {
    return {
      ok: false,
      status: 422,
      code: "escrow_scope_mismatch",
      message: "The release's (athlete, school) pair must re-derive the named scope.",
    };
  }
  if (row.payee_id !== nilAuditEscrowPayeeId(input.scope_key)) {
    return {
      ok: false,
      status: 422,
      code: "escrow_scope_mismatch",
      message: `Escrow credit ${row.id} belongs to a different scope than "${input.scope_key}".`,
    };
  }

  // THE VERIFIED RECONCILIATION — the release gate's key, read FAIL-CLOSED
  // before the CAS: no reconciliation of record, no release.
  const reconciliation = await store.getNilAuditEscrowReconciliation(row.id);
  if (reconciliation === undefined) {
    return {
      ok: false,
      status: 403,
      code: "nil_audit_escrow_reconciliation_missing",
      message:
        "No verified reconciliation of record exists for this escrow — reconcile the transfer-portal audit before releasing.",
    };
  }

  // The policy of record must still exist (the terms never vanish).
  const policy: NilAuditEscrowPolicyRecord | undefined =
    await store.getNilAuditEscrowPolicy(input.scope_key);
  if (policy === undefined) {
    return {
      ok: false,
      status: 422,
      code: "missing_nil_audit_escrow_policy",
      message: `No NIL audit-escrow policy of record exists for scope "${input.scope_key}".`,
    };
  }

  // The remaining balance derives from the append-only drawdown truth.
  const drawdowns: NilAuditEscrowDrawdownRecord[] =
    await store.listNilAuditEscrowDrawdowns(row.id);
  const drawnBefore = drawdowns.reduce((total, line) => total + line.drawn_cents, 0);
  const remaining = row.amount_cents - drawnBefore;
  if (remaining <= 0) {
    return {
      ok: false,
      status: 422,
      code: "escrow_fully_drawn",
      message:
        "The escrow is fully drawn — transfer-portal reconciliations and withholdings spent every cent of it.",
    };
  }

  // The gate family — the NIL vertical's compliance state resolves from
  // the durable gate states of record: fail-closed at release too, an
  // absent record refuses.
  const kycStatus = await resolveCreatorKycStatus(store, input.athlete_id);
  const verticalState = await resolveNilVerticalComplianceState(
    store,
    input.athlete_id,
    input.school_id,
  );
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
      message: `NIL escrow release refused for athlete "${input.athlete_id}": ${compliance.message}`,
    };
  }

  // The CAS wins BEFORE any money moves: the concurrent release or
  // full-drawdown loser reads undefined here and refuses.
  const instant = now.toISOString();
  const settled = await store.settleNilAuditEscrow(row.id, instant);
  if (settled === undefined) {
    return {
      ok: false,
      status: 409,
      code: "escrow_already_settled",
      message: `Escrow credit ${row.id} is no longer held — a concurrent release or drawdown won.`,
    };
  }

  // The taxed cascade routes the remaining balance to the athlete — the
  // same fail-closed family every payout rides. The journal opens with
  // the escrow account's debit leg (the escrow pays out); the cascade
  // appends its own credits.
  const glLegs: GlLegInput[] = [nilAuditEscrowDebit(input.scope_key, remaining)];
  const withholding: DonTaxEscrowRecord[] = [];
  const credits: NilAuditEscrowRouteCredit[] = [];
  let landedNetCents = 0;
  if (remaining > 0) {
    landedNetCents = await creditTaxedCascadePayee(
      store,
      input.athlete_id,
      `NIL athlete ${input.athlete_id}`,
      remaining,
      now,
      glLegs,
      withholding,
    );
    credits.push({
      payee_id: input.athlete_id,
      payee_name: `NIL athlete ${input.athlete_id}`,
      gross_cents: remaining,
      net_cents: landedNetCents,
      step: "athlete_net",
    });
  }

  // The zero-balance tripwire: drawdowns + released + dust === the locked
  // escrow, ALWAYS.
  const companyDustCents = 0;
  if (
    !nilZeroBalanceHolds(
      row.amount_cents,
      [{ amount_cents: drawnBefore }, { amount_cents: remaining }],
      companyDustCents,
    )
  ) {
    return {
      ok: false,
      status: 500,
      code: "zero_balance_violation",
      message:
        "Escrow drawdowns + released remainder + dust !== locked escrow — release refused.",
    };
  }

  const posted = await postJournal(store, {
    kind: "nil_audit_escrow_release",
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
      released_cents: remaining,
      credits,
      withholding,
      company_dust_cents: companyDustCents,
      journal_id: posted.journal.id,
    },
  };
}

// ---------------------------------------------------------------------------
// The transfer portal clawback lane — the pro-rated unearned advance.
// ---------------------------------------------------------------------------

export type NilTransferPortalEntryInput = {
  nil_contract_id: string;
  athlete_id: string;
  school_id: string;
  /** The portal entry's date (strict YYYY-MM-DD). */
  entry_date: string;
  /** The athlete's display name for the hold row's payee metadata — the
   * identity key is athlete_id; this is display-only. */
  athlete_name: string;
  /** The hold row's currency of record (the statement's currency). */
  currency: string;
};

export type NilTransferPortalEntrySuccess = {
  ok: true;
  value: {
    entry: NilTransferPortalEntryRecord;
    /** The pro-rated clawback of record — null when no advance schedule
     * of record existed or the entry landed on/after completion. */
    clawback: NilUnearnedClawbackRecord | null;
    replayed: boolean;
  };
};

/**
 * Records the transfer portal entry of record for one (contract, athlete)
 * and — when the entry precedes contract completion and an advance
 * schedule of record exists — the pro-rated unearned-advance clawback and
 * its `nil_unearned_clawback` debit hold.
 *
 * Idempotent BY (CONTRACT, ATHLETE): the entry insert is first-wins; a
 * re-shipped sheet (or a lost race) reads the winner's entry and its
 * clawback and returns them as a counted replay — never a second hold.
 * The entry insert is the lane's serialization point: only its winner
 * proceeds to the clawback computation, so the hold posts exactly once
 * per portal entry. (A process crash between the hold row and the
 * clawback record leaves the hold visible without its record — the recon
 * alarms surface it; the retry throws `nil_clawback_record_conflict`
 * rather than posting a second hold.)
 */
export async function recordNilTransferPortalEntry(
  store: Store,
  input: NilTransferPortalEntryInput,
  now: Date = new Date(),
): Promise<NilTransferPortalEntrySuccess | NilAuditEscrowFailure> {
  if (
    input.nil_contract_id.trim() === "" ||
    input.athlete_id.trim() === "" ||
    input.school_id.trim() === "" ||
    input.athlete_name.trim() === "" ||
    input.currency.trim() === ""
  ) {
    return {
      ok: false,
      status: 422,
      code: "invalid_portal_entry_identity",
      message:
        "A transfer portal entry names its contract, athlete, school, athlete display name, and currency.",
    };
  }

  // The replay guard's read — a re-shipped sheet is a counted no-op.
  const existingEntry = await store.getNilTransferPortalEntry(
    input.nil_contract_id,
    input.athlete_id,
  );
  if (existingEntry !== undefined) {
    const existingClawback = await store.getNilUnearnedClawback(existingEntry.id);
    return {
      ok: true,
      value: { entry: existingEntry, clawback: existingClawback ?? null, replayed: true },
    };
  }

  // The advance schedule of record — the clawback's ONLY terms. No
  // schedule of record means the contract named no advance: the entry
  // still records (the portal fact is real), nothing claws back
  // (fail-closed: no terms, no calculation, never a guessed amount).
  const schedule = await store.getNilAdvanceSchedule(input.nil_contract_id);
  if (schedule === undefined) {
    let entry: NilTransferPortalEntryRecord;
    try {
      entry = await store.insertNilTransferPortalEntry({
        nil_contract_id: input.nil_contract_id,
        athlete_id: input.athlete_id,
        school_id: input.school_id,
        entry_date: input.entry_date,
        contract_completion_date: null,
        entered_prior_to_completion: false,
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        // A concurrent lane won the entry — read the winner's state.
        const winner = await store.getNilTransferPortalEntry(
          input.nil_contract_id,
          input.athlete_id,
        );
        if (winner !== undefined) {
          const winnerClawback = await store.getNilUnearnedClawback(winner.id);
          return {
            ok: true,
            value: { entry: winner, clawback: winnerClawback ?? null, replayed: true },
          };
        }
      }
      throw error;
    }
    return { ok: true, value: { entry, clawback: null, replayed: false } };
  }

  // The pro-rated plan — the pure math, priced from the stored terms.
  const plan = buildProratedClawbackPlan({
    advance_cents: schedule.advance_cents,
    term_start_date: schedule.term_start_date,
    term_end_date: schedule.term_end_date,
    portal_entry_date: input.entry_date,
  });
  if (!plan.ok) {
    return {
      ok: false,
      status: 422,
      code: `invalid_advance_schedule_${plan.reason}`,
      message: `Contract "${input.nil_contract_id}"'s advance schedule of record is not a priceable term (${plan.reason}) — heal the schedule before recording portal entries.`,
    };
  }

  let entry: NilTransferPortalEntryRecord;
  try {
    entry = await store.insertNilTransferPortalEntry({
      nil_contract_id: input.nil_contract_id,
      athlete_id: input.athlete_id,
      school_id: input.school_id,
      entry_date: input.entry_date,
      contract_completion_date: schedule.term_end_date,
      entered_prior_to_completion: plan.value.clawback_due,
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      // A concurrent lane won the entry — read the winner's state.
      const winner = await store.getNilTransferPortalEntry(
        input.nil_contract_id,
        input.athlete_id,
      );
      if (winner !== undefined) {
        const winnerClawback = await store.getNilUnearnedClawback(winner.id);
        return {
          ok: true,
          value: { entry: winner, clawback: winnerClawback ?? null, replayed: true },
        };
      }
    }
    throw error;
  }

  if (!plan.value.clawback_due) {
    // Fully earned — the entry records, nothing claws back.
    return { ok: true, value: { entry, clawback: null, replayed: false } };
  }

  // THE DEBIT HOLD OF RECORD — the pro-rated unearned advance locks as
  // its own ledger row: kind AND status 'nil_unearned_clawback', the
  // athlete as payee (the hold is AGAINST them), the contract stamped in
  // line_item_id so the row is discoverable through the existing
  // line-item index. The row is the receivable's face on the Don ledger —
  // visible, priced, never a guessed amount.
  const holdRow = await store.insertLedgerTransaction({
    split_run_id: "",
    line_item_id: input.nil_contract_id,
    payee_id: input.athlete_id,
    payee_name: input.athlete_name,
    role: "other",
    share_bps: 0,
    amount_cents: plan.value.unearned_cents,
    currency: input.currency,
    status: "nil_unearned_clawback",
    rail: null,
    baas_provider: null,
    baas_transfer_id: null,
    created_at: now.toISOString(),
    settled_at: null,
    kind: "nil_unearned_clawback",
  });

  let clawback: NilUnearnedClawbackRecord;
  try {
    clawback = await store.insertNilUnearnedClawback({
      nil_contract_id: input.nil_contract_id,
      athlete_id: input.athlete_id,
      school_id: input.school_id,
      portal_entry_id: entry.id,
      advance_cents: plan.value.advance_cents,
      term_start_date: plan.value.term_start_date,
      term_end_date: plan.value.term_end_date,
      entry_date: plan.value.portal_entry_date,
      total_term_days: plan.value.total_term_days,
      served_days: plan.value.served_days,
      unearned_cents: plan.value.unearned_cents,
      clawback_ledger_id: holdRow.id,
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      // A concurrent lane posted the record while this lane held a fresh
      // hold row — refuse loudly rather than post a second hold or
      // silently accept an orphaned one (the recon alarms surface it).
      throw new Error(
        `nil_clawback_record_conflict: portal entry ${entry.id} already carries a clawback record — a concurrent lane won; inspect hold row ${holdRow.id}.`,
        { cause: error },
      );
    }
    throw error;
  }

  // The hold's own journal — balanced legs, no cash movement: the
  // athlete's unearned-advance receivable rises (debit) against the
  // advance-recovery income of record (credit).
  const posted = await postJournal(store, {
    kind: "nil_unearned_clawback_hold",
    ref_type: "ledger_transaction",
    ref_id: holdRow.id,
    legs: [
      nilUnearnedClawbackReceivableDebit(input.athlete_id, plan.value.unearned_cents),
      nilUnearnedClawbackRecoveryCredit(input.athlete_id, plan.value.unearned_cents),
    ],
  });
  if (!posted.ok) {
    return { ok: false, status: 500, code: posted.code, message: posted.message };
  }

  return { ok: true, value: { entry, clawback, replayed: false } };
}
