// The culinary audit escrow (PR 41, the founder culinary directive).
//
// A chef's compliance exposure on culinary IP payouts — customer refunds
// surfacing after the payout posted, food spoilage chargebacks, quarterly
// ingredient supplier quality audits — is protected the same way the
// fitness audit escrow protects a trainer: a founder-banded 5–10% share
// of the culinary IP payout locks into a CULINARY_AUDIT_ESCROW per
// (chef, ghost kitchen) scope (sentinel payee + GL account — its own
// escrow-shaped money, never folded into platform dust, unclaimed
// holding, or any other escrow state), drawn down by refund allowances,
// spoilage chargebacks, and supplier quality audits, and released only
// against the verified reconciliation of record (fail-closed: no
// reconciliation, no release). A viral-menu pop-up scope — a 30-day
// limited time offer, a seasonal residency — must ALSO carry its
// post-campaign packaging inventory write-off of record before any
// release (the virtual-brand decommissioning audit, fail-closed).
//
// The money path is the canonical recon posting seam — the fitness/NIL/
// spatial pattern 1:1: a culinary IP payout arrives as a held
// unclaimed-holding credit, this lane consumes exactly ONE held credit
// through the culinary payout gate (health_inspection_cleared +
// territorial_kitchen_exclusivity_verified, resolved from the durable
// gate states of record — absent and unknown BOTH refuse), CAS-settles
// the held row BEFORE any money moves, splits the escrow share
// floor(amount × bps / 10000), and routes the exact-subtraction remainder
// to the chef through the SAME fail-closed taxed cascade every payout
// rides. THE INVARIANT: chef remainder + escrow + dust === the held
// credit, ALWAYS (allocations plus dust equals gross INCLUDING the escrow
// bucket).
//
// Drawdowns and the release commit position-locked (the fitness/spatial
// drawdown discipline at culinary scope) before their money moves — the
// ordering is the point. The remaining balance derives from the
// append-only drawdown truth, never a mutable counter. The verified
// reconciliation of record is insert-as-lock (UNIQUE per escrow): the
// FIRST reconciliation wins, and the release reads it fail-closed.

import type { Store } from "@/lib/server/store";
import type { LedgerTransactionRecord } from "@/lib/don/types";
import {
  COMPANY_VARIANCE_PAYEE_ID,
  COMPANY_VARIANCE_PAYEE_NAME,
  CULINARY_AUDIT_ESCROW_MAX_RATE_BPS,
  CULINARY_AUDIT_ESCROW_MIN_RATE_BPS,
  culinaryAuditEscrowPayeeId,
  culinaryAuditEscrowPayeeName,
} from "@/modules/don/constants";
import {
  CULINARY_AUDIT_ESCROW_DRAWDOWN_CLASSES,
  culinaryAuditEscrowScopeKey,
  culinaryPopupScopeKey,
  isCulinaryPopupScope,
  type CulinaryAuditEscrowDrawdownClass,
  type CulinaryAuditEscrowDrawdownRecord,
  type CulinaryAuditEscrowPolicyRecord,
  type CulinaryAuditEscrowReconciliationRecord,
} from "@/modules/culinary/records";
import type {
  TaxEscrowRecord as DonTaxEscrowRecord,
} from "@/modules/don/records";
import { applyWithholding } from "@/modules/compliance/engine";
import { applyRecoupmentSweep } from "@/modules/recoupment/engine";
import {
  evaluatePayoutCompliance,
  resolveCreatorKycStatus,
  resolveCulinaryVerticalComplianceState,
} from "@/modules/compliance/payoutGate";
import { postJournal } from "@/modules/ledger/engine";
import {
  fboCredit,
  culinaryAuditEscrowCredit,
  culinaryAuditEscrowDebit,
  unclaimedHoldingDebit,
  vaultCredit,
  type GlLegInput,
} from "@/modules/ledger/journal";
import { creditVault } from "@/modules/vaults/engine";
import { isIncomingFrozen } from "@/modules/vaults/dispute";
import { isWithholdableTalentRole } from "@/lib/server/vtuberAgency";
import { isUniqueViolation } from "@/lib/server/uniqueViolation";

/** House failure envelope — the fitness / NIL audit-escrow shape. */
export type CulinaryAuditEscrowFailure = {
  ok: false;
  status: number;
  code: string;
  message: string;
};

/**
 * The house zero-balance invariant, scoped to a routing: the sum of the
 * allocations (chef remainder, escrow bucket, drawdown spends) plus the
 * dust equals the gross it all came from — ALWAYS.
 */
export function culinaryZeroBalanceHolds(
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

// Re-derive the scope keys through the records module — the engine cites
// one identity definition, the tests import these re-exports.
export { culinaryAuditEscrowScopeKey, culinaryPopupScopeKey, isCulinaryPopupScope };

// ---------------------------------------------------------------------------
// The policy registry — the money terms' ONLY source.
// ---------------------------------------------------------------------------

export type CulinaryAuditEscrowPolicyInput = {
  /** The chef payee the escrow protects. */
  chef_id: string;
  /** The chef's ghost kitchen location of record. */
  ghost_kitchen_location_code: string;
  /** The pop-up campaign ref — present only when registering a
   * pop-up scope's own policy (the campaign-window scope). */
  popup_ref?: string;
  /** The founder-banded share, basis points of the payout — 500–1000
   * (5–10%). */
  reserve_rate_bps: number;
};

/**
 * Registers the culinary audit escrow's policy of record for one scope —
 * the rate inside the founder's 5–10% band, enforced at registration AND
 * at use. A re-registration converges (the newest rate governs the next
 * routing) — the option-agreement discipline.
 */
export async function registerCulinaryAuditEscrowPolicy(
  store: Store,
  input: CulinaryAuditEscrowPolicyInput,
): Promise<
  { ok: true; value: CulinaryAuditEscrowPolicyRecord } | CulinaryAuditEscrowFailure
> {
  if (input.chef_id.trim() === "" || input.ghost_kitchen_location_code.trim() === "") {
    return {
      ok: false,
      status: 422,
      code: "invalid_scope_identity",
      message: "A culinary audit-escrow policy names the chef and ghost kitchen it protects.",
    };
  }
  const scopeKey =
    input.popup_ref === undefined
      ? culinaryAuditEscrowScopeKey(input.chef_id, input.ghost_kitchen_location_code)
      : culinaryPopupScopeKey(input.chef_id, input.ghost_kitchen_location_code, input.popup_ref);
  if (
    !Number.isInteger(input.reserve_rate_bps) ||
    input.reserve_rate_bps < CULINARY_AUDIT_ESCROW_MIN_RATE_BPS ||
    input.reserve_rate_bps > CULINARY_AUDIT_ESCROW_MAX_RATE_BPS
  ) {
    return {
      ok: false,
      status: 422,
      code: "escrow_rate_out_of_band",
      message: `The culinary escrow rate must sit inside the founder band (${CULINARY_AUDIT_ESCROW_MIN_RATE_BPS}–${CULINARY_AUDIT_ESCROW_MAX_RATE_BPS} bps — ${CULINARY_AUDIT_ESCROW_MIN_RATE_BPS / 100}–${CULINARY_AUDIT_ESCROW_MAX_RATE_BPS / 100}%).`,
    };
  }
  const policy = await store.upsertCulinaryAuditEscrowPolicy({
    scope_key: scopeKey,
    reserve_rate_bps: input.reserve_rate_bps,
  });
  return { ok: true, value: policy };
}

/**
 * The PURE split plan — the founder-banded escrow share of a culinary IP
 * payout, computed in exact integer cents. The escrow share floors the
 * rate multiplication (never rounds up: the chef's routed share is the
 * exact subtraction remainder, so amount = routed + escrow + dust holds
 * with dust structurally zero). Refuses a non-integer or non-positive
 * amount and a rate outside the founder band.
 */
export function buildCulinaryAuditEscrowSplitPlan(input: {
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
  | CulinaryAuditEscrowFailure {
  const { amount_cents, reserve_rate_bps } = input;
  if (!Number.isInteger(amount_cents) || amount_cents <= 0) {
    return {
      ok: false,
      status: 422,
      code: "invalid_allocation_amount",
      message: "A culinary IP payout splits in whole positive cents.",
    };
  }
  if (
    !Number.isInteger(reserve_rate_bps) ||
    reserve_rate_bps < CULINARY_AUDIT_ESCROW_MIN_RATE_BPS ||
    reserve_rate_bps > CULINARY_AUDIT_ESCROW_MAX_RATE_BPS
  ) {
    return {
      ok: false,
      status: 422,
      code: "escrow_rate_out_of_band",
      message: `The culinary escrow rate must sit inside the founder band (${CULINARY_AUDIT_ESCROW_MIN_RATE_BPS}–${CULINARY_AUDIT_ESCROW_MAX_RATE_BPS} bps — ${CULINARY_AUDIT_ESCROW_MIN_RATE_BPS / 100}–${CULINARY_AUDIT_ESCROW_MAX_RATE_BPS / 100}%).`,
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

export type CulinaryAuditEscrowRouteInput = {
  holding_ledger_id: string;
  /** The chef payee of the payout — the scope's chef half. */
  chef_id: string;
  /** The chef's ghost kitchen location — the scope's kitchen half. */
  ghost_kitchen_location_code: string;
  /** The pop-up campaign ref when the held credit is a temporary viral
   * menu pop-up's (30-day LTO) — routes into the pop-up scope's escrow. */
  popup_ref?: string;
  operator_settlement_approved: boolean;
};

export type CulinaryAuditEscrowRouteCredit = {
  payee_id: string;
  payee_name: string;
  gross_cents: number;
  net_cents: number;
  step: string;
};

export type CulinaryAuditEscrowRouteSuccess = {
  ok: true;
  value: {
    /** The settled holding row (status 'settled' after this routing). */
    payout_credit: LedgerTransactionRecord;
    split: {
      amount_cents: number;
      escrow_cents: number;
      routed_cents: number;
      company_dust_cents: number;
    };
    /** The locked escrow row when the escrow share priced positive. */
    escrow_credit: LedgerTransactionRecord | null;
    credits: CulinaryAuditEscrowRouteCredit[];
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
 * cascade per-lane — the licensing / merch-collab / ip-option / NIL /
 * fitness lanes each carry their own copy; this is the culinary lane's.)
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
  // No work context exists on a payout credit — the catalog-dispute
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
 * Routes ONE held culinary IP payout credit through the culinary audit
 * escrow split: the payout gate (fail-closed), the CAS, the
 * founder-banded escrow lock, and the exact-subtraction remainder through
 * the taxed cascade to the chef. Idempotent BY HELD CREDIT: a replayed
 * routing reads the already-settled row and refuses with the same 409 —
 * never a second split.
 */
export async function routeCulinaryAuditEscrowFromPayout(
  store: Store,
  input: CulinaryAuditEscrowRouteInput,
  now: Date = new Date(),
): Promise<CulinaryAuditEscrowRouteSuccess | CulinaryAuditEscrowFailure> {
  const row = await store.getLedgerTransaction(input.holding_ledger_id);
  if (row === undefined) {
    return {
      ok: false,
      status: 404,
      code: "payout_credit_not_found",
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
      code: "payout_already_released",
      message: `Payout credit ${row.id} is no longer held (status "${row.status}").`,
    };
  }
  if (input.chef_id.trim() === "" || input.ghost_kitchen_location_code.trim() === "") {
    return {
      ok: false,
      status: 422,
      code: "invalid_scope_identity",
      message: "A culinary escrow routing names the chef and ghost kitchen it protects.",
    };
  }
  const scopeKey =
    input.popup_ref === undefined
      ? culinaryAuditEscrowScopeKey(input.chef_id, input.ghost_kitchen_location_code)
      : culinaryPopupScopeKey(input.chef_id, input.ghost_kitchen_location_code, input.popup_ref);

  // The terms of record — the policy (the rate) comes from the registry,
  // never the caller. A scope with no registered policy means the chef's
  // terms name no escrow: nothing routes (a counted refusal, never a
  // guessed rate).
  const policy: CulinaryAuditEscrowPolicyRecord | undefined =
    await store.getCulinaryAuditEscrowPolicy(scopeKey);
  if (policy === undefined) {
    return {
      ok: false,
      status: 422,
      code: "missing_culinary_audit_escrow_policy",
      message: `No culinary audit-escrow policy of record exists for scope "${scopeKey}" — register the chef's escrow term before routing payouts.`,
    };
  }

  // The split — plan BEFORE anything moves (the exact-amount discipline).
  const splitPlanned = buildCulinaryAuditEscrowSplitPlan({
    amount_cents: row.amount_cents,
    reserve_rate_bps: policy.reserve_rate_bps,
  });
  if (!splitPlanned.ok) return splitPlanned;
  const split = splitPlanned.value;

  // THE CULINARY PAYOUT GATE — the vertical's compliance state resolves
  // from the durable gate states of record (migration 0045): an ABSENT
  // record resolves null (the gate refuses with vertical_state_unknown)
  // and an 'unknown' state refuses the specific condition
  // (culinary_inspection_not_cleared / culinary_exclusivity_unverified) —
  // fail-closed, before the CAS. Runs for the chef this routing credits.
  const kycStatus = await resolveCreatorKycStatus(store, input.chef_id);
  const verticalState = await resolveCulinaryVerticalComplianceState(
    store,
    input.chef_id,
    input.ghost_kitchen_location_code,
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
      message: `Culinary escrow routing refused for chef "${input.chef_id}": ${compliance.message}`,
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
      code: "payout_already_released",
      message: `Payout credit ${row.id} is no longer held — a concurrent routing won.`,
    };
  }

  // The exact-amount routing: the non-escrow remainder rides the taxed
  // cascade; the escrow share locks as its own ledger row — kind AND
  // status 'culinary_audit_escrow', the per-scope sentinel payee
  // (deliberately not 'platform', not the unclaimed-holding sentinel, not
  // any earlier escrow prefix), the scope stamped in line_item_id so the
  // row is discoverable through the existing line-item index and the
  // release can re-derive state from the same registry. A floor of zero
  // on a sub-10-cent payout locks no row — there is nothing to hold and
  // a zero-amount ledger row would be noise.
  const glLegs: GlLegInput[] = [unclaimedHoldingDebit(row.amount_cents)];
  const withholding: DonTaxEscrowRecord[] = [];
  const credits: CulinaryAuditEscrowRouteCredit[] = [];
  let landedNetCents = 0;
  if (split.routed_cents > 0) {
    landedNetCents = await creditTaxedCascadePayee(
      store,
      input.chef_id,
      `Chef ${input.chef_id}`,
      split.routed_cents,
      now,
      glLegs,
      withholding,
    );
    credits.push({
      payee_id: input.chef_id,
      payee_name: `Chef ${input.chef_id}`,
      gross_cents: split.routed_cents,
      net_cents: landedNetCents,
      step: "chef_net",
    });
  }
  let escrowCredit: LedgerTransactionRecord | null = null;
  if (split.escrow_cents > 0) {
    escrowCredit = await store.insertLedgerTransaction({
      split_run_id: "",
      line_item_id: scopeKey,
      payee_id: culinaryAuditEscrowPayeeId(scopeKey),
      payee_name: culinaryAuditEscrowPayeeName(scopeKey),
      role: "other",
      share_bps: 0,
      amount_cents: split.escrow_cents,
      currency: row.currency,
      status: "culinary_audit_escrow",
      rail: null,
      baas_provider: null,
      baas_transfer_id: null,
      created_at: now.toISOString(),
      settled_at: null,
      kind: "culinary_audit_escrow",
    });
    glLegs.push(culinaryAuditEscrowCredit(scopeKey, split.escrow_cents));
  }

  // The integer-cent dust — structurally zero under the subtraction
  // model; swept to the platform variance account with its own ledger
  // rows if it ever differs (the house dust discipline, retained
  // defensively).
  const companyDustCents = split.company_dust_cents;
  if (companyDustCents > 0) {
    await store.insertCompanyDust({
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

  // The zero-balance tripwire: chef remainder + escrow + dust === the
  // held credit, ALWAYS — the Don invariant (allocations plus dust equals
  // gross) WITH the escrow bucket inside the allocation total.
  if (
    !culinaryZeroBalanceHolds(
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
        "Culinary remainder + audit escrow + dust !== held credit — routing refused.",
    };
  }

  const posted = await postJournal(store, {
    kind: "culinary_audit_escrow_route",
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
      payout_credit: settled,
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
// The drawdown lane — customer refund allowances, food spoilage
// chargebacks, and quarterly ingredient supplier quality audits spend the
// escrow.
// ---------------------------------------------------------------------------

export type CulinaryAuditEscrowDrawdownInput = {
  reserve_ledger_id: string;
  scope_key: string;
  drawdown_class: string;
  source_event_id: string;
  drawn_cents: number;
};

export type CulinaryAuditEscrowDrawdownSuccess = {
  ok: true;
  value: {
    drawdown: CulinaryAuditEscrowDrawdownRecord;
    replayed: boolean;
    journal_id: string | null;
  };
};

/**
 * Draws the culinary audit escrow down — a customer refund allowance, a
 * food spoilage chargeback, or a quarterly ingredient supplier quality
 * audit spending the escrow's balance. The drawdown row commits
 * position-locked BEFORE the money moves; a drawdown that consumes the
 * LAST cent settles the escrow first (the CAS arbitrates against a
 * concurrent release); money never leaves a settled escrow.
 */
export async function drawDownCulinaryAuditEscrow(
  store: Store,
  input: CulinaryAuditEscrowDrawdownInput,
  now: Date = new Date(),
): Promise<CulinaryAuditEscrowDrawdownSuccess | CulinaryAuditEscrowFailure> {
  const row = await store.getLedgerTransaction(input.reserve_ledger_id);
  if (row === undefined) {
    return {
      ok: false,
      status: 404,
      code: "escrow_credit_not_found",
      message: "No ledger transaction matches that id.",
    };
  }
  if (row.kind !== "culinary_audit_escrow") {
    return {
      ok: false,
      status: 422,
      code: "not_an_escrow_credit",
      message: `Ledger transaction ${row.id} is kind "${row.kind}" — only culinary audit-escrow credits draw down here.`,
    };
  }
  if (row.status !== "culinary_audit_escrow") {
    return {
      ok: false,
      status: 409,
      code: "escrow_already_settled",
      message: `Escrow credit ${row.id} is no longer held (status "${row.status}") — nothing draws from a settled escrow.`,
    };
  }
  // The scope cross-check — the caller names the scope; the escrow row's
  // sentinel payee must match it exactly (the terms-of-record discipline).
  if (row.payee_id !== culinaryAuditEscrowPayeeId(input.scope_key)) {
    return {
      ok: false,
      status: 422,
      code: "escrow_scope_mismatch",
      message: `Escrow credit ${row.id} belongs to a different scope than "${input.scope_key}".`,
    };
  }
  if (
    !CULINARY_AUDIT_ESCROW_DRAWDOWN_CLASSES.some((cls) => cls === input.drawdown_class)
  ) {
    return {
      ok: false,
      status: 422,
      code: "invalid_drawdown_class",
      message:
        "A culinary escrow drawdown is a refund_allowance, a spoilage_chargeback, or a supplier_quality_audit.",
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
  // mutable counter. drawnBefore is the escrow BALANCE immediately
  // before this draw — the version the position lock arbitrates — and
  // the row's after-balance satisfies remaining = before − drawn, the
  // 0045 CHECK's self-contained conservation identity.
  const drawdowns: CulinaryAuditEscrowDrawdownRecord[] =
    await store.listCulinaryAuditEscrowDrawdowns(row.id);
  const cumulativeDrawn = drawdowns.reduce((total, line) => total + line.drawn_cents, 0);
  const drawnBefore = row.amount_cents - cumulativeDrawn;
  const remaining = drawnBefore - input.drawn_cents;
  if (remaining < 0) {
    return {
      ok: false,
      status: 422,
      code: "escrow_overdrawn",
      message: `Drawdown of ${input.drawn_cents} exceeds the escrow's remaining ${drawnBefore} — refuse, never clip.`,
    };
  }

  const instant = now.toISOString();

  // A drawdown that consumes the LAST cent settles the escrow FIRST (the
  // CAS arbitrates against a concurrent release BEFORE any row or money
  // commits — the winner is the only lane that touches the escrow).
  const fullyDrawn = remaining === 0;
  if (fullyDrawn) {
    const settled = await store.settleCulinaryAuditEscrow(row.id, instant);
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
  let drawdown: CulinaryAuditEscrowDrawdownRecord;
  try {
    drawdown = await store.insertCulinaryAuditEscrowDrawdown({
      reserve_ledger_id: row.id,
      scope_key: input.scope_key,
      drawdown_class: input.drawdown_class as CulinaryAuditEscrowDrawdownClass,
      source_event_id: input.source_event_id,
      drawn_before_cents: drawnBefore,
      drawn_cents: input.drawn_cents,
      remaining_cents: remaining,
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      const all = await store.listCulinaryAuditEscrowDrawdowns(row.id);
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
    if (rechecked === undefined || rechecked.status !== "culinary_audit_escrow") {
      return {
        ok: false,
        status: 409,
        code: "escrow_already_settled",
        message: `Escrow credit ${row.id} is no longer held — a concurrent release won.`,
      };
    }
  }

  // The drawdown's own journal: the escrow account debits back to FBO
  // cash — the refund allowance's, spoilage chargeback's, or supplier
  // quality audit's expense, itemized.
  const posted = await postJournal(store, {
    kind: "culinary_audit_escrow_drawdown",
    ref_type: "ledger_transaction",
    ref_id: row.id,
    legs: [
      culinaryAuditEscrowDebit(input.scope_key, input.drawn_cents),
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

export type CulinaryAuditEscrowReconcileInput = {
  reserve_ledger_id: string;
  scope_key: string;
  evidence_ref: string;
  reconciled_by: string;
};

/**
 * Records the verified reconciliation of record for one culinary escrow —
 * the release gate's key. Insert-as-lock: the FIRST reconciliation wins;
 * a concurrent second reconciliation surfaces the conflict (the escrow is
 * reconciled once, by one verified audit).
 */
export async function reconcileCulinaryAuditEscrow(
  store: Store,
  input: CulinaryAuditEscrowReconcileInput,
): Promise<
  { ok: true; value: CulinaryAuditEscrowReconciliationRecord } | CulinaryAuditEscrowFailure
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
    row.kind !== "culinary_audit_escrow" ||
    row.payee_id !== culinaryAuditEscrowPayeeId(input.scope_key)
  ) {
    return {
      ok: false,
      status: 422,
      code: "not_an_escrow_credit",
      message: `Ledger transaction ${row.id} is not this scope's culinary audit-escrow credit.`,
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
  const reconciliation = await store.insertCulinaryAuditEscrowReconciliation({
    reserve_ledger_id: input.reserve_ledger_id,
    evidence_ref: input.evidence_ref,
    reconciled_by: input.reconciled_by,
  });
  return { ok: true, value: reconciliation };
}

export type CulinaryAuditEscrowReleaseInput = {
  reserve_ledger_id: string;
  /** Must equal the scope the escrow routed under — derived from the
   * chef + ghost kitchen (+# popup ref) identity and cross-checked
   * against the sentinel payee. */
  scope_key: string;
  chef_id: string;
  ghost_kitchen_location_code: string;
  /** The pop-up campaign ref — required exactly when the scope is a
   * pop-up scope (the decommissioning audit reads its write-off). */
  popup_ref?: string;
  operator_settlement_approved: boolean;
};

export type CulinaryAuditEscrowReleaseSuccess = {
  ok: true;
  value: {
    /** The settled escrow row (status 'settled' after this release). */
    escrow_credit: LedgerTransactionRecord;
    released_cents: number;
    credits: CulinaryAuditEscrowRouteCredit[];
    withholding: DonTaxEscrowRecord[];
    company_dust_cents: number;
    journal_id: string;
  };
};

/**
 * Releases a held culinary audit escrow to the chef through the taxed
 * cascade — the VERIFIED release: the reconciliation of record must exist
 * (fail-closed, before the CAS — no reconciliation of record, no
 * release), a pop-up scope's post-campaign packaging write-off of record
 * must exist (the virtual-brand decommissioning audit, fail-closed), the
 * remaining balance re-derived from the append-only drawdown truth, the
 * culinary payout gate re-resolved from the durable gate states of
 * record, the scope cross-checked against the identity pair, the CAS
 * BEFORE any money moves, and the taxed cascade for the actual routing.
 * Drawdowns already spent stay spent — the release pays only what the
 * compliance exposure protected.
 */
export async function releaseCulinaryAuditEscrow(
  store: Store,
  input: CulinaryAuditEscrowReleaseInput,
  now: Date = new Date(),
): Promise<CulinaryAuditEscrowReleaseSuccess | CulinaryAuditEscrowFailure> {
  const row = await store.getLedgerTransaction(input.reserve_ledger_id);
  if (row === undefined) {
    return {
      ok: false,
      status: 404,
      code: "escrow_credit_not_found",
      message: "No ledger transaction matches that id.",
    };
  }
  if (row.kind !== "culinary_audit_escrow") {
    return {
      ok: false,
      status: 422,
      code: "not_an_escrow_credit",
      message: `Ledger transaction ${row.id} is kind "${row.kind}" — only culinary audit-escrow credits release here.`,
    };
  }
  if (row.status !== "culinary_audit_escrow") {
    return {
      ok: false,
      status: 409,
      code: "escrow_already_settled",
      message: `Escrow credit ${row.id} is no longer held (status "${row.status}").`,
    };
  }
  // The scope cross-check, twice over: the caller names the scope AND the
  // (chef, ghost kitchen, popup ref?) identity it releases to — the
  // identity must re-derive the scope exactly (the keys are injective in
  // their identity tuples), and the escrow row's sentinel payee must
  // match it. A pop-up scope REQUIRES its popup_ref; a base scope must
  // not carry one.
  const popupScope = isCulinaryPopupScope(input.scope_key);
  if (popupScope !== (input.popup_ref !== undefined)) {
    return {
      ok: false,
      status: 422,
      code: "escrow_scope_mismatch",
      message: popupScope
        ? "A pop-up scope's release names its pop-up campaign ref."
        : "A base scope's release carries no pop-up campaign ref.",
    };
  }
  const derivedScope =
    input.popup_ref === undefined
      ? culinaryAuditEscrowScopeKey(input.chef_id, input.ghost_kitchen_location_code)
      : culinaryPopupScopeKey(
          input.chef_id,
          input.ghost_kitchen_location_code,
          input.popup_ref,
        );
  if (
    input.chef_id.trim() === "" ||
    input.ghost_kitchen_location_code.trim() === "" ||
    derivedScope !== input.scope_key
  ) {
    return {
      ok: false,
      status: 422,
      code: "escrow_scope_mismatch",
      message: "The release's (chef, ghost kitchen) identity must re-derive the named scope.",
    };
  }
  if (row.payee_id !== culinaryAuditEscrowPayeeId(input.scope_key)) {
    return {
      ok: false,
      status: 422,
      code: "escrow_scope_mismatch",
      message: `Escrow credit ${row.id} belongs to a different scope than "${input.scope_key}".`,
    };
  }

  // THE VERIFIED RECONCILIATION — the release gate's key, read FAIL-CLOSED
  // before the CAS: no reconciliation of record, no release.
  const reconciliation = await store.getCulinaryAuditEscrowReconciliation(row.id);
  if (reconciliation === undefined) {
    return {
      ok: false,
      status: 403,
      code: "culinary_audit_escrow_reconciliation_missing",
      message:
        "No verified reconciliation of record exists for this escrow — reconcile the refund, spoilage, and supplier-audit exposure before releasing.",
    };
  }

  // THE POP-UP DECOMMISSIONING AUDIT — a viral-menu pop-up scope's
  // release is additionally gated on its post-campaign packaging
  // inventory write-off of record (fail-closed: the campaign's ref must
  // resolve, belong to this scope, and carry at least one write-off row).
  if (popupScope && input.popup_ref !== undefined) {
    const popup = await store.getCulinaryPopupExperience(input.popup_ref);
    if (popup === undefined) {
      return {
        ok: false,
        status: 404,
        code: "popup_experience_not_found",
        message: `No pop-up campaign of record exists for ref "${input.popup_ref}" — register the campaign before releasing its escrow.`,
      };
    }
    if (
      popup.chef_id !== input.chef_id ||
      popup.ghost_kitchen_location_code !== input.ghost_kitchen_location_code
    ) {
      return {
        ok: false,
        status: 422,
        code: "popup_scope_mismatch",
        message: `Pop-up "${input.popup_ref}" belongs to a different (chef, ghost kitchen) scope than this release.`,
      };
    }
    const writeoffs = await store.listCulinaryPopupWriteoffs(popup.id);
    if (writeoffs.length === 0) {
      return {
        ok: false,
        status: 403,
        code: "popup_writeoff_missing",
        message:
          "No post-campaign packaging inventory write-off of record exists for this pop-up — decommission the campaign before releasing its escrow.",
      };
    }
  }

  // The policy of record must still exist (the terms never vanish).
  const policy: CulinaryAuditEscrowPolicyRecord | undefined =
    await store.getCulinaryAuditEscrowPolicy(input.scope_key);
  if (policy === undefined) {
    return {
      ok: false,
      status: 422,
      code: "missing_culinary_audit_escrow_policy",
      message: `No culinary audit-escrow policy of record exists for scope "${input.scope_key}".`,
    };
  }

  // The remaining balance derives from the append-only drawdown truth.
  const drawdowns: CulinaryAuditEscrowDrawdownRecord[] =
    await store.listCulinaryAuditEscrowDrawdowns(row.id);
  const drawnBefore = drawdowns.reduce((total, line) => total + line.drawn_cents, 0);
  const remaining = row.amount_cents - drawnBefore;
  if (remaining <= 0) {
    return {
      ok: false,
      status: 422,
      code: "escrow_fully_drawn",
      message:
        "The escrow is fully drawn — refund allowances, spoilage chargebacks, and supplier audits spent every cent of it.",
    };
  }

  // The gate family — the culinary vertical's compliance state resolves
  // from the durable gate states of record: fail-closed at release too,
  // an absent record refuses.
  const kycStatus = await resolveCreatorKycStatus(store, input.chef_id);
  const verticalState = await resolveCulinaryVerticalComplianceState(
    store,
    input.chef_id,
    input.ghost_kitchen_location_code,
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
      message: `Culinary escrow release refused for chef "${input.chef_id}": ${compliance.message}`,
    };
  }

  // The CAS wins BEFORE any money moves: the concurrent release or
  // full-drawdown loser reads undefined here and refuses.
  const instant = now.toISOString();
  const settled = await store.settleCulinaryAuditEscrow(row.id, instant);
  if (settled === undefined) {
    return {
      ok: false,
      status: 409,
      code: "escrow_already_settled",
      message: `Escrow credit ${row.id} is no longer held — a concurrent release or drawdown won.`,
    };
  }

  // The taxed cascade routes the remaining balance to the chef — the
  // same fail-closed family every payout rides. The journal opens with
  // the escrow account's debit leg (the escrow pays out); the cascade
  // appends its own credits.
  const glLegs: GlLegInput[] = [culinaryAuditEscrowDebit(input.scope_key, remaining)];
  const withholding: DonTaxEscrowRecord[] = [];
  const credits: CulinaryAuditEscrowRouteCredit[] = [];
  let landedNetCents = 0;
  if (remaining > 0) {
    landedNetCents = await creditTaxedCascadePayee(
      store,
      input.chef_id,
      `Chef ${input.chef_id}`,
      remaining,
      now,
      glLegs,
      withholding,
    );
    credits.push({
      payee_id: input.chef_id,
      payee_name: `Chef ${input.chef_id}`,
      gross_cents: remaining,
      net_cents: landedNetCents,
      step: "chef_net",
    });
  }

  // The zero-balance tripwire: drawdowns + released + dust === the locked
  // escrow, ALWAYS.
  const companyDustCents = 0;
  if (
    !culinaryZeroBalanceHolds(
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
    kind: "culinary_audit_escrow_release",
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
// The virtual-brand pop-up decommissioning lane — campaign windows of
// record and post-campaign packaging inventory write-offs.
// ---------------------------------------------------------------------------

export type CulinaryPopupExperienceInput = {
  popup_ref: string;
  chef_id: string;
  ghost_kitchen_location_code: string;
  menu_theme: string;
  window_start_date: string;
  window_end_date: string;
};

/**
 * Registers one viral-menu pop-up campaign's window of record —
 * insert-as-lock on popup_ref: the FIRST registration wins; a re-shipped
 * sheet or a lost race surfaces as the named conflict (the caller reads
 * the winner through the getter). The window must run forward.
 */
export async function registerCulinaryPopupExperience(
  store: Store,
  input: CulinaryPopupExperienceInput,
): Promise<{ ok: true; value: Awaited<ReturnType<Store['insertCulinaryPopupExperience']>> } | CulinaryAuditEscrowFailure> {
  if (
    input.popup_ref.trim() === "" ||
    input.chef_id.trim() === "" ||
    input.ghost_kitchen_location_code.trim() === "" ||
    input.menu_theme.trim() === ""
  ) {
    return {
      ok: false,
      status: 422,
      code: "invalid_popup_identity",
      message:
        "A pop-up registration names its campaign ref, chef, ghost kitchen, and menu theme.",
    };
  }
  if (input.window_end_date < input.window_start_date) {
    return {
      ok: false,
      status: 422,
      code: "invalid_popup_window",
      message: "The pop-up campaign window of record runs forward (end >= start).",
    };
  }
  const popup = await store.insertCulinaryPopupExperience({
    popup_ref: input.popup_ref,
    chef_id: input.chef_id,
    ghost_kitchen_location_code: input.ghost_kitchen_location_code,
    menu_theme: input.menu_theme,
    window_start_date: input.window_start_date,
    window_end_date: input.window_end_date,
  });
  return { ok: true, value: popup };
}

export type CulinaryPopupWriteoffInput = {
  popup_ref: string;
  source_event_id: string;
  unsold_packages: number;
  unit_cost_cents: number;
  evidence_ref: string;
  calculated_by: string;
};

/**
 * Records one post-campaign packaging inventory write-off for a pop-up
 * campaign — the decommissioning fact of record a pop-up scope's escrow
 * release reads (fail-closed). The write-off price is pinned:
 * unsold_packages × unit_cost_cents, integer cents. UNIQUE per
 * (popup_experience_id, source_event_id) — a replayed calculation throws,
 * never a double-priced write-off.
 */
export async function recordCulinaryPopupWriteoff(
  store: Store,
  input: CulinaryPopupWriteoffInput,
): Promise<{ ok: true; value: Awaited<ReturnType<Store['insertCulinaryPopupWriteoff']>> } | CulinaryAuditEscrowFailure> {
  const popup = await store.getCulinaryPopupExperience(input.popup_ref);
  if (popup === undefined) {
    return {
      ok: false,
      status: 404,
      code: "popup_experience_not_found",
      message: `No pop-up campaign of record exists for ref "${input.popup_ref}" — register the campaign before recording its write-off.`,
    };
  }
  if (!Number.isInteger(input.unsold_packages) || input.unsold_packages < 0) {
    return {
      ok: false,
      status: 422,
      code: "invalid_writeoff_count",
      message: "The write-off's unsold packaging count is a whole non-negative number.",
    };
  }
  if (!Number.isInteger(input.unit_cost_cents) || input.unit_cost_cents < 0) {
    return {
      ok: false,
      status: 422,
      code: "invalid_writeoff_unit_cost",
      message: "The write-off's packaging unit cost prices in whole non-negative cents.",
    };
  }
  if (input.evidence_ref.trim() === "" || input.calculated_by.trim() === "") {
    return {
      ok: false,
      status: 422,
      code: "invalid_writeoff_evidence",
      message: "A packaging write-off carries evidence and a calculator of record.",
    };
  }
  const writeoff = await store.insertCulinaryPopupWriteoff({
    popup_experience_id: popup.id,
    source_event_id: input.source_event_id,
    unsold_packages: input.unsold_packages,
    unit_cost_cents: input.unit_cost_cents,
    writeoff_cents: input.unsold_packages * input.unit_cost_cents,
    evidence_ref: input.evidence_ref,
    calculated_by: input.calculated_by,
  });
  return { ok: true, value: writeoff };
}
