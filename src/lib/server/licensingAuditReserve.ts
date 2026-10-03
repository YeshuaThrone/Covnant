// The audit reserve escrow (PR 33, founder directive).
//
// A brand-licensing contract's retail-audit exposure — chargebacks,
// quarterly reconciliations, inventory write-offs surfacing after the
// royalty posted — is protected the same way the merch returns reserve
// protects its payout allocations: a founder-banded 5–10% share of the
// licensing royalty credit locks into an AUDIT_RESERVE_ESCROW per license
// scope (sentinel payee + GL account — its own escrow-shaped money, never
// folded into platform dust, unclaimed holding, or any other escrow
// state), drawn down by quarterly retail audit reconciliations and
// inventory write-offs, and released only against the verified
// reconciliation of record (fail-closed: no reconciliation, no release).
//
// The money path is the canonical recon posting seam — the merch reserve
// dispatch's pattern 1:1: a licensing royalty credit arrives as a held
// unclaimed-holding credit, this lane consumes exactly ONE held credit
// through the licensing payout gate (territory_cleared +
// category_exclusivity_verified, resolved from the durable states of
// record — absent and unknown BOTH refuse), CAS-settles the held row
// BEFORE any money moves, splits the reserve share floor(amount × bps /
// 10000), and routes the exact-subtraction remainder to the deal of
// record's licensor through the SAME fail-closed taxed cascade every
// payout rides. THE INVARIANT: licensor remainder + reserve + dust ===
// the held credit, ALWAYS (allocations plus dust equals gross INCLUDING
// the escrow bucket).
//
// Drawdowns and the release commit position-locked (the 0036 application
// discipline at reserve scope) before their money moves — the ordering is
// the point. The remaining balance derives from the append-only drawdown
// truth, never a mutable counter. The verified reconciliation of record is
// insert-as-lock (UNIQUE per reserve): the FIRST reconciliation wins, and
// the release reads it fail-closed.

import type { Store } from "@/lib/server/store";
import type { LedgerTransactionRecord } from "@/lib/don/types";
import {
  COMPANY_VARIANCE_PAYEE_ID,
  COMPANY_VARIANCE_PAYEE_NAME,
  LICENSING_AUDIT_RESERVE_MAX_RATE_BPS,
  LICENSING_AUDIT_RESERVE_MIN_RATE_BPS,
  auditReserveEscrowPayeeId,
  auditReserveEscrowPayeeName,
} from "@/modules/don/constants";
import {
  LICENSING_AUDIT_RESERVE_DRAWDOWN_CLASSES,
  type LicensingAuditReserveDrawdownClass,
  type LicensingAuditReserveDrawdownRecord,
  type LicensingAuditReservePolicyRecord,
  type LicensingAuditReserveReconciliationRecord,
  type LicensingRoyaltyDealRecord,
} from "@/modules/licensing/records";
import type {
  CompanyDustRecord as DonCompanyDustRecord,
  TaxEscrowRecord as DonTaxEscrowRecord,
} from "@/modules/don/records";
import { applyWithholding } from "@/modules/compliance/engine";
import { applyRecoupmentSweep } from "@/modules/recoupment/engine";
import {
  evaluatePayoutCompliance,
  resolveCreatorKycStatus,
  resolveLicensingVerticalComplianceState,
} from "@/modules/compliance/payoutGate";
import { postJournal } from "@/modules/ledger/engine";
import {
  auditReserveEscrowCredit,
  auditReserveEscrowDebit,
  fboCredit,
  unclaimedHoldingDebit,
  vaultCredit,
  type GlLegInput,
} from "@/modules/ledger/journal";
import { creditVault } from "@/modules/vaults/engine";
import { isIncomingFrozen } from "@/modules/vaults/dispute";
import { isWithholdableTalentRole } from "@/lib/server/vtuberAgency";
import { isUniqueViolation } from "@/lib/server/uniqueViolation";

/** House failure envelope — the merch cascade / unclaimed-holding shape. */
export type LicensingAuditReserveFailure = {
  ok: false;
  status: number;
  code: string;
  message: string;
};

/**
 * The house zero-balance invariant, scoped to a routing: the sum of the
 * allocations (licensor remainder, reserve bucket, drawdown spends) plus
 * the dust equals the gross it all came from — ALWAYS.
 */
export function zeroBalanceHolds(
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
// The policy registry — the money terms' ONLY source.
// ---------------------------------------------------------------------------

export type LicensingAuditReservePolicyInput = {
  /** The license scope (`license:<license_id>`) the reserve protects. */
  scope_key: string;
  /** The founder-banded share, basis points of the licensing royalty
   * credit — 500–1000 (5–10%). */
  reserve_rate_bps: number;
};

/**
 * Registers the audit reserve escrow's policy of record for one license
 * scope — the rate inside the founder's 5–10% band, enforced at
 * registration AND at use. A re-registration converges (the newest rate
 * governs the next routing) — the option-agreement discipline.
 */
export async function registerLicensingAuditReservePolicy(
  store: Store,
  input: LicensingAuditReservePolicyInput,
): Promise<
  { ok: true; value: LicensingAuditReservePolicyRecord } | LicensingAuditReserveFailure
> {
  if (input.scope_key.trim() === "") {
    return {
      ok: false,
      status: 422,
      code: "invalid_scope_identity",
      message: "An audit-reserve policy names the license scope it protects.",
    };
  }
  if (
    !Number.isInteger(input.reserve_rate_bps) ||
    input.reserve_rate_bps < LICENSING_AUDIT_RESERVE_MIN_RATE_BPS ||
    input.reserve_rate_bps > LICENSING_AUDIT_RESERVE_MAX_RATE_BPS
  ) {
    return {
      ok: false,
      status: 422,
      code: "reserve_rate_out_of_band",
      message: `The audit-reserve rate must sit inside the founder band (${LICENSING_AUDIT_RESERVE_MIN_RATE_BPS}–${LICENSING_AUDIT_RESERVE_MAX_RATE_BPS} bps — ${LICENSING_AUDIT_RESERVE_MIN_RATE_BPS / 100}–${LICENSING_AUDIT_RESERVE_MAX_RATE_BPS / 100}%).`,
    };
  }
  const policy = await store.upsertLicensingAuditReservePolicy({
    scope_key: input.scope_key,
    reserve_rate_bps: input.reserve_rate_bps,
  });
  return { ok: true, value: policy };
}

/**
 * The PURE split plan — the founder-banded reserve share of a licensing
 * royalty credit, computed in exact integer cents. The reserve share
 * floors the rate multiplication (never rounds up: the licensor's routed
 * share is the exact subtraction remainder, so amount = routed + reserve
 * + dust holds with dust structurally zero). Refuses a non-integer or
 * non-positive amount and a rate outside the founder band.
 */
export function buildAuditReserveSplitPlan(input: {
  amount_cents: number;
  reserve_rate_bps: number;
}):
  | {
      ok: true;
      value: {
        amount_cents: number;
        reserve_cents: number;
        routed_cents: number;
        company_dust_cents: number;
      };
    }
  | LicensingAuditReserveFailure {
  const { amount_cents, reserve_rate_bps } = input;
  if (!Number.isInteger(amount_cents) || amount_cents <= 0) {
    return {
      ok: false,
      status: 422,
      code: "invalid_allocation_amount",
      message: "A licensing royalty credit splits in whole positive cents.",
    };
  }
  if (
    !Number.isInteger(reserve_rate_bps) ||
    reserve_rate_bps < LICENSING_AUDIT_RESERVE_MIN_RATE_BPS ||
    reserve_rate_bps > LICENSING_AUDIT_RESERVE_MAX_RATE_BPS
  ) {
    return {
      ok: false,
      status: 422,
      code: "reserve_rate_out_of_band",
      message: `The audit-reserve rate must sit inside the founder band (${LICENSING_AUDIT_RESERVE_MIN_RATE_BPS}–${LICENSING_AUDIT_RESERVE_MAX_RATE_BPS} bps — ${LICENSING_AUDIT_RESERVE_MIN_RATE_BPS / 100}–${LICENSING_AUDIT_RESERVE_MAX_RATE_BPS / 100}%).`,
    };
  }
  const reserve_cents = Math.floor((amount_cents * reserve_rate_bps) / 10_000);
  const routed_cents = amount_cents - reserve_cents;
  return {
    ok: true,
    value: {
      amount_cents,
      reserve_cents,
      routed_cents,
      company_dust_cents: 0,
    },
  };
}

export type LicensingAuditReserveRouteInput = {
  holding_ledger_id: string;
  scope_key: string;
  operator_settlement_approved: boolean;
};

export type LicensingAuditReserveRouteCredit = {
  payee_id: string;
  payee_name: string;
  gross_cents: number;
  net_cents: number;
  step: string;
};

export type LicensingAuditReserveRouteSuccess = {
  ok: true;
  value: {
    /** The settled holding row (status 'settled' after this routing). */
    holding_credit: LedgerTransactionRecord;
    split: {
      amount_cents: number;
      reserve_cents: number;
      routed_cents: number;
      company_dust_cents: number;
    };
    /** The locked escrow row when the reserve share priced positive. */
    reserve_credit: LedgerTransactionRecord | null;
    credits: LicensingAuditReserveRouteCredit[];
    withholding: DonTaxEscrowRecord[];
    company_dust_cents: number;
    journal_id: string;
  };
};

/**
 * The taxed cascade one payee's credit rides — withholding off the top,
 * the catalog-dispute freeze check, the recoupment sweep. The SAME
 * fail-closed family every payout credits through; returns the net that
 * actually landed in the payee's vault.
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
  // No work context exists on a holding credit — the catalog-dispute
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
 * Routes ONE held licensing royalty credit through the audit reserve
 * split: the payout gate (fail-closed), the CAS, the founder-banded
 * reserve lock, and the exact-subtraction remainder through the taxed
 * cascade to the deal of record's licensor. Idempotent BY HELD CREDIT: a
 * replayed routing reads the already-settled row and refuses with the
 * same 409 — never a second split.
 */
export async function routeLicensingAuditReserveFromHolding(
  store: Store,
  input: LicensingAuditReserveRouteInput,
  now: Date = new Date(),
): Promise<LicensingAuditReserveRouteSuccess | LicensingAuditReserveFailure> {
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
      message: `Ledger transaction ${row.id} is kind "${row.kind}" — only unclaimed holding credits route here.`,
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
  if (input.scope_key.trim() === "") {
    return {
      ok: false,
      status: 422,
      code: "invalid_scope_identity",
      message: "An audit-reserve routing names the license scope it protects.",
    };
  }

  // The terms of record — the policy (the rate) and the deal (the
  // licensor of record) come from the registries, never the caller. A
  // scope with no registered policy means the contract names no
  // audit-reserve term: nothing routes (a counted refusal, never a
  // guessed rate).
  const policy: LicensingAuditReservePolicyRecord | undefined =
    await store.getLicensingAuditReservePolicy(input.scope_key);
  if (policy === undefined) {
    return {
      ok: false,
      status: 422,
      code: "missing_audit_reserve_policy",
      message: `No audit-reserve policy of record exists for scope "${input.scope_key}" — register the contract's reserve term before routing its royalties.`,
    };
  }
  const deal: LicensingRoyaltyDealRecord | undefined =
    await store.getLicensingRoyaltyDeal(input.scope_key);
  if (deal === undefined) {
    return {
      ok: false,
      status: 404,
      code: "licensing_deal_not_found",
      message: `No licensing deal of record exists for scope "${input.scope_key}" — the licensor of record comes from the deal registry.`,
    };
  }

  // The split — plan BEFORE anything moves (the exact-amount discipline).
  const splitPlanned = buildAuditReserveSplitPlan({
    amount_cents: row.amount_cents,
    reserve_rate_bps: policy.reserve_rate_bps,
  });
  if (!splitPlanned.ok) return splitPlanned;
  const split = splitPlanned.value;

  // THE LICENSING PAYOUT GATE — the vertical's compliance state resolves
  // from the durable states of record (migration 0037): an ABSENT record
  // resolves null (the gate refuses with vertical_state_unknown) and an
  // 'unknown' state refuses the specific condition — fail-closed, before
  // the CAS. Runs for the licensor of record — the payee this routing
  // credits.
  const kycStatus = await resolveCreatorKycStatus(store, deal.licensor_a_payee_id);
  const verticalState = await resolveLicensingVerticalComplianceState(
    store,
    deal.licensor_a_payee_id,
    input.scope_key,
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
      message: `Licensing reserve routing refused for licensor "${deal.licensor_a_payee_id}": ${compliance.message}`,
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
      code: "holding_already_released",
      message: `Holding credit ${row.id} is no longer held — a concurrent routing won.`,
    };
  }

  // The exact-amount routing: the non-reserve remainder rides the taxed
  // cascade; the reserve share locks as its own ledger row — kind AND
  // status 'audit_reserve_escrow', the per-scope sentinel payee
  // (deliberately not 'platform', not the unclaimed-holding sentinel, not
  // any earlier escrow prefix), the scope stamped in line_item_id so the
  // row is discoverable through the existing line-item index and the
  // release can re-derive state from the same registry. A floor of zero
  // on a sub-10-cent credit locks no row — there is nothing to hold and
  // a zero-amount ledger row would be noise.
  const glLegs: GlLegInput[] = [unclaimedHoldingDebit(row.amount_cents)];
  const withholding: DonTaxEscrowRecord[] = [];
  const credits: LicensingAuditReserveRouteCredit[] = [];
  let landedNetCents = 0;
  if (split.routed_cents > 0) {
    landedNetCents = await creditTaxedCascadePayee(
      store,
      deal.licensor_a_payee_id,
      deal.licensor_a_payee_name,
      split.routed_cents,
      now,
      glLegs,
      withholding,
    );
    credits.push({
      payee_id: deal.licensor_a_payee_id,
      payee_name: deal.licensor_a_payee_name,
      gross_cents: split.routed_cents,
      net_cents: landedNetCents,
      step: "licensor_net",
    });
  }
  let reserveCredit: LedgerTransactionRecord | null = null;
  if (split.reserve_cents > 0) {
    reserveCredit = await store.insertLedgerTransaction({
      split_run_id: "",
      line_item_id: input.scope_key,
      payee_id: auditReserveEscrowPayeeId(input.scope_key),
      payee_name: auditReserveEscrowPayeeName(input.scope_key),
      role: "other",
      share_bps: 0,
      amount_cents: split.reserve_cents,
      currency: row.currency,
      status: "audit_reserve_escrow",
      rail: null,
      baas_provider: null,
      baas_transfer_id: null,
      created_at: now.toISOString(),
      settled_at: null,
      kind: "audit_reserve_escrow",
    });
    glLegs.push(auditReserveEscrowCredit(input.scope_key, split.reserve_cents));
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

  // The zero-balance tripwire: licensor remainder + reserve + dust ===
  // the held credit, ALWAYS — the Don invariant (allocations plus dust
  // equals gross) WITH the escrow bucket inside the allocation total.
  if (
    !zeroBalanceHolds(row.amount_cents, [
      { amount_cents: split.routed_cents },
      { amount_cents: split.reserve_cents },
    ], companyDustCents)
  ) {
    return {
      ok: false,
      status: 500,
      code: "zero_balance_violation",
      message:
        "Licensing remainder + audit reserve + dust !== held credit — routing refused.",
    };
  }

  const posted = await postJournal(store, {
    kind: "licensing_audit_reserve_route",
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
      split,
      reserve_credit: reserveCredit,
      credits,
      withholding,
      company_dust_cents: companyDustCents,
      journal_id: posted.journal.id,
    },
  };
}

// ---------------------------------------------------------------------------
// The drawdown lane — quarterly audit reconciliations and inventory
// write-offs spend the reserve.
// ---------------------------------------------------------------------------

export type LicensingAuditReserveDrawdownInput = {
  reserve_ledger_id: string;
  scope_key: string;
  drawdown_class: string;
  source_event_id: string;
  drawn_cents: number;
};

export type LicensingAuditReserveDrawdownSuccess = {
  ok: true;
  value: {
    drawdown: LicensingAuditReserveDrawdownRecord;
    replayed: boolean;
    journal_id: string | null;
  };
};

/**
 * Draws the audit reserve down — a quarterly retail audit reconciliation
 * or an inventory write-off spending the escrow's balance. The drawdown
 * row commits position-locked BEFORE the money moves; a drawdown that
 * consumes the LAST cent settles the reserve first (the CAS arbitrates
 * against a concurrent release); money never leaves a settled reserve.
 */
export async function drawDownLicensingAuditReserve(
  store: Store,
  input: LicensingAuditReserveDrawdownInput,
  now: Date = new Date(),
): Promise<LicensingAuditReserveDrawdownSuccess | LicensingAuditReserveFailure> {
  const row = await store.getLedgerTransaction(input.reserve_ledger_id);
  if (row === undefined) {
    return {
      ok: false,
      status: 404,
      code: "reserve_credit_not_found",
      message: "No ledger transaction matches that id.",
    };
  }
  if (row.kind !== "audit_reserve_escrow") {
    return {
      ok: false,
      status: 422,
      code: "not_a_reserve_credit",
      message: `Ledger transaction ${row.id} is kind "${row.kind}" — only audit-reserve credits draw down here.`,
    };
  }
  if (row.status !== "audit_reserve_escrow") {
    return {
      ok: false,
      status: 409,
      code: "reserve_already_settled",
      message: `Reserve credit ${row.id} is no longer held (status "${row.status}") — nothing draws from a settled reserve.`,
    };
  }
  // The scope cross-check — the caller names the contract; the reserve
  // row's sentinel payee must match it exactly (the terms-of-record
  // discipline).
  if (row.payee_id !== auditReserveEscrowPayeeId(input.scope_key)) {
    return {
      ok: false,
      status: 422,
      code: "reserve_scope_mismatch",
      message: `Reserve credit ${row.id} belongs to a different contract than scope "${input.scope_key}".`,
    };
  }
  if (
    !LICENSING_AUDIT_RESERVE_DRAWDOWN_CLASSES.some((row) => row === input.drawdown_class)
  ) {
    return {
      ok: false,
      status: 422,
      code: "invalid_drawdown_class",
      message:
        "A reserve drawdown is a quarterly_audit_reconciliation or an inventory_write_off.",
    };
  }
  if (!Number.isInteger(input.drawn_cents) || input.drawn_cents <= 0) {
    return {
      ok: false,
      status: 422,
      code: "invalid_drawdown_amount",
      message: "A reserve drawdown spends whole positive cents.",
    };
  }

  // The position derives from the append-only truth — never a second
  // mutable counter.
  const drawdowns: LicensingAuditReserveDrawdownRecord[] =
    await store.listLicensingAuditReserveDrawdowns(row.id);
  const drawnBefore = drawdowns.reduce((total, line) => total + line.drawn_cents, 0);
  const remaining = row.amount_cents - drawnBefore;
  if (input.drawn_cents > remaining) {
    return {
      ok: false,
      status: 422,
      code: "reserve_overdrawn",
      message: `Drawdown of ${input.drawn_cents} exceeds the reserve's remaining ${remaining} — refuse, never clip.`,
    };
  }

  const instant = now.toISOString();

  // A drawdown that consumes the LAST cent settles the reserve FIRST (the
  // CAS arbitrates against a concurrent release BEFORE any row or money
  // commits — the winner is the only lane that touches the reserve).
  const fullyDrawn = remaining - input.drawn_cents === 0;
  if (fullyDrawn) {
    const settled = await store.settleLicensingAuditReserve(row.id, instant);
    if (settled === undefined) {
      return {
        ok: false,
        status: 409,
        code: "reserve_already_settled",
        message: `Reserve credit ${row.id} is no longer held — a concurrent release or drawdown won.`,
      };
    }
  }

  // The position-locked insert — the replay guard AND the arbiter, in one
  // write. A unique violation is disambiguated against the append-only
  // truth: a row with this source event already exists → the re-shipped
  // event's counted no-op; otherwise the position conflict re-throws (the
  // caller retries and re-derives from the fresh truth).
  let drawdown: LicensingAuditReserveDrawdownRecord;
  try {
    drawdown = await store.insertLicensingAuditReserveDrawdown({
      reserve_ledger_id: row.id,
      scope_key: input.scope_key,
      drawdown_class: input.drawdown_class as LicensingAuditReserveDrawdownClass,
      source_event_id: input.source_event_id,
      drawn_before_cents: drawnBefore,
      drawn_cents: input.drawn_cents,
      remaining_cents: remaining - input.drawn_cents,
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      const all = await store.listLicensingAuditReserveDrawdowns(row.id);
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
  // a settled reserve. A concurrent release that won between the insert
  // and this read has already routed the balance — this drawdown refuses
  // without moving a cent (the recon alarms surface the refused row's
  // inconsistency; the money never double-moves).
  if (!fullyDrawn) {
    const rechecked = await store.getLedgerTransaction(row.id);
    if (rechecked === undefined || rechecked.status !== "audit_reserve_escrow") {
      return {
        ok: false,
        status: 409,
        code: "reserve_already_settled",
        message: `Reserve credit ${row.id} is no longer held — a concurrent release won.`,
      };
    }
  }

  // The drawdown's own journal: the reserve account debits back to FBO
  // cash — the audit's expense, itemized.
  const posted = await postJournal(store, {
    kind: "licensing_audit_reserve_drawdown",
    ref_type: "ledger_transaction",
    ref_id: row.id,
    legs: [
      auditReserveEscrowDebit(input.scope_key, input.drawn_cents),
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

export type LicensingAuditReserveReconcileInput = {
  reserve_ledger_id: string;
  scope_key: string;
  evidence_ref: string;
  reconciled_by: string;
};

/**
 * Records the verified reconciliation of record for one reserve — the
 * release gate's key. Insert-as-lock: the FIRST reconciliation wins; a
 * concurrent second reconciliation surfaces the conflict (the reserve is
 * reconciled once, by one verified audit).
 */
export async function reconcileLicensingAuditReserve(
  store: Store,
  input: LicensingAuditReserveReconcileInput,
): Promise<
  { ok: true; value: LicensingAuditReserveReconciliationRecord } | LicensingAuditReserveFailure
> {
  const row = await store.getLedgerTransaction(input.reserve_ledger_id);
  if (row === undefined) {
    return {
      ok: false,
      status: 404,
      code: "reserve_credit_not_found",
      message: "No ledger transaction matches that id.",
    };
  }
  if (
    row.kind !== "audit_reserve_escrow" ||
    row.payee_id !== auditReserveEscrowPayeeId(input.scope_key)
  ) {
    return {
      ok: false,
      status: 422,
      code: "not_a_reserve_credit",
      message: `Ledger transaction ${row.id} is not this scope's audit-reserve credit.`,
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
  const reconciliation = await store.insertLicensingAuditReserveReconciliation({
    reserve_ledger_id: input.reserve_ledger_id,
    evidence_ref: input.evidence_ref,
    reconciled_by: input.reconciled_by,
  });
  return { ok: true, value: reconciliation };
}

export type LicensingAuditReserveReleaseInput = {
  reserve_ledger_id: string;
  scope_key: string;
  operator_settlement_approved: boolean;
};

export type LicensingAuditReserveReleaseSuccess = {
  ok: true;
  value: {
    /** The settled reserve row (status 'settled' after this release). */
    reserve_credit: LedgerTransactionRecord;
    released_cents: number;
    credits: LicensingAuditReserveRouteCredit[];
    withholding: DonTaxEscrowRecord[];
    company_dust_cents: number;
    journal_id: string;
  };
};

/**
 * Releases a held audit reserve to the licensor of record through the
 * taxed cascade — the VERIFIED release: the reconciliation of record must
 * exist (fail-closed, before the CAS — no reconciliation of record, no
 * release), the remaining balance re-derived from the append-only
 * drawdown truth, the licensing payout gate re-resolved from the durable
 * states of record, the CAS BEFORE any money moves, and the taxed cascade
 * for the actual routing. Drawdowns already spent stay spent — the
 * release pays only what the audit exposure protected.
 */
export async function releaseLicensingAuditReserve(
  store: Store,
  input: LicensingAuditReserveReleaseInput,
  now: Date = new Date(),
): Promise<LicensingAuditReserveReleaseSuccess | LicensingAuditReserveFailure> {
  const row = await store.getLedgerTransaction(input.reserve_ledger_id);
  if (row === undefined) {
    return {
      ok: false,
      status: 404,
      code: "reserve_credit_not_found",
      message: "No ledger transaction matches that id.",
    };
  }
  if (row.kind !== "audit_reserve_escrow") {
    return {
      ok: false,
      status: 422,
      code: "not_a_reserve_credit",
      message: `Ledger transaction ${row.id} is kind "${row.kind}" — only audit-reserve credits release here.`,
    };
  }
  if (row.status !== "audit_reserve_escrow") {
    return {
      ok: false,
      status: 409,
      code: "reserve_already_settled",
      message: `Reserve credit ${row.id} is no longer held (status "${row.status}").`,
    };
  }
  // The scope cross-check — the caller names the contract; the reserve
  // row's sentinel payee must match it exactly.
  if (row.payee_id !== auditReserveEscrowPayeeId(input.scope_key)) {
    return {
      ok: false,
      status: 422,
      code: "reserve_scope_mismatch",
      message: `Reserve credit ${row.id} belongs to a different contract than scope "${input.scope_key}".`,
    };
  }

  // THE VERIFIED RECONCILIATION — the release gate's key, read FAIL-CLOSED
  // before the CAS: no reconciliation of record, no release.
  const reconciliation = await store.getLicensingAuditReserveReconciliation(row.id);
  if (reconciliation === undefined) {
    return {
      ok: false,
      status: 403,
      code: "audit_reserve_reconciliation_missing",
      message:
        "No verified reconciliation of record exists for this reserve — reconcile the quarterly audit before releasing.",
    };
  }

  // The licensor of record — the deal registry, never the caller.
  const deal: LicensingRoyaltyDealRecord | undefined =
    await store.getLicensingRoyaltyDeal(input.scope_key);
  if (deal === undefined) {
    return {
      ok: false,
      status: 404,
      code: "licensing_deal_not_found",
      message: `No licensing deal of record exists for scope "${input.scope_key}" — the licensor of record comes from the deal registry.`,
    };
  }

  // The remaining balance derives from the append-only drawdown truth.
  const drawdowns: LicensingAuditReserveDrawdownRecord[] =
    await store.listLicensingAuditReserveDrawdowns(row.id);
  const drawnBefore = drawdowns.reduce((total, line) => total + line.drawn_cents, 0);
  const remaining = row.amount_cents - drawnBefore;
  if (remaining <= 0) {
    return {
      ok: false,
      status: 422,
      code: "reserve_fully_drawn",
      message:
        "The reserve is fully drawn — audit reconciliations and write-offs spent every cent of it.",
    };
  }

  // The gate family — the licensing vertical's compliance state resolves
  // from the durable states of record: fail-closed at release too, an
  // absent record refuses.
  const kycStatus = await resolveCreatorKycStatus(store, deal.licensor_a_payee_id);
  const verticalState = await resolveLicensingVerticalComplianceState(
    store,
    deal.licensor_a_payee_id,
    input.scope_key,
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
      message: `Licensing reserve release refused for licensor "${deal.licensor_a_payee_id}": ${compliance.message}`,
    };
  }

  // The CAS wins BEFORE any money moves: the concurrent release or
  // full-drawdown loser reads undefined here and refuses.
  const instant = now.toISOString();
  const settled = await store.settleLicensingAuditReserve(row.id, instant);
  if (settled === undefined) {
    return {
      ok: false,
      status: 409,
      code: "reserve_already_settled",
      message: `Reserve credit ${row.id} is no longer held — a concurrent release or drawdown won.`,
    };
  }

  // The taxed cascade routes the remaining balance to the licensor of
  // record — the same fail-closed family every payout rides. The journal
  // opens with the reserve account's debit leg (the escrow pays out);
  // the cascade appends its own credits.
  const glLegs: GlLegInput[] = [auditReserveEscrowDebit(input.scope_key, remaining)];
  const withholding: DonTaxEscrowRecord[] = [];
  const credits: LicensingAuditReserveRouteCredit[] = [];
  let landedNetCents = 0;
  if (remaining > 0) {
    landedNetCents = await creditTaxedCascadePayee(
      store,
      deal.licensor_a_payee_id,
      deal.licensor_a_payee_name,
      remaining,
      now,
      glLegs,
      withholding,
    );
    credits.push({
      payee_id: deal.licensor_a_payee_id,
      payee_name: deal.licensor_a_payee_name,
      gross_cents: remaining,
      net_cents: landedNetCents,
      step: "licensor_net",
    });
  }

  // The zero-balance tripwire: drawdowns + released + dust === the locked
  // escrow, ALWAYS.
  const companyDustCents = 0;
  if (
    !zeroBalanceHolds(row.amount_cents, [
      { amount_cents: drawnBefore },
      { amount_cents: remaining },
    ], companyDustCents)
  ) {
    return {
      ok: false,
      status: 500,
      code: "zero_balance_violation",
      message:
        "Reserve drawdowns + released remainder + dust !== locked escrow — release refused.",
    };
  }

  const posted = await postJournal(store, {
    kind: "licensing_audit_reserve_release",
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
      reserve_credit: settled,
      released_cents: remaining,
      credits,
      withholding,
      company_dust_cents: companyDustCents,
      journal_id: posted.journal.id,
    },
  };
}
