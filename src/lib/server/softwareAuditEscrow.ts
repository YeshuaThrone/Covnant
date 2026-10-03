// The software audit escrow (PR 45, the founder software directive).
//
// A developer's IP-payout exposure — uptime SLA breaches surfacing after
// the payout posted, API rate-limit breach credits owed to customers,
// quarterly security compliance audits — is protected the same way the
// service audit escrow protects a stylist: a founder-banded 5–10% share
// of the developer IP payout locks into a SOFTWARE_AUDIT_ESCROW per
// (developer, API endpoint) scope (sentinel payee + GL account — its own
// escrow-shaped money, never folded into platform dust, unclaimed
// holding, or any other escrow state), drawn down by uptime outage
// penalty refunds, API rate-limit breach credits, and quarterly security
// compliance audits, and released only against the verified
// reconciliation of record (fail-closed: no reconciliation, no release).
//
// The money path is the canonical recon posting seam — the service/
// culinary/fitness/NIL/spatial pattern 1:1: a developer IP payout arrives
// as a held unclaimed-holding credit, this lane consumes exactly ONE held
// credit through the software payout gate (api_uptime_sla_verified +
// software_security_audit_cleared, resolved from the durable gate states
// of record — absent and unknown BOTH refuse), CAS-settles the held row
// BEFORE any money moves, splits the escrow share
// floor(amount × bps / 10000), and routes the exact-subtraction remainder
// to the developer through the SAME fail-closed taxed cascade every
// payout rides. THE INVARIANT: developer remainder + escrow + dust ===
// the held credit, ALWAYS (allocations plus dust equals gross INCLUDING
// the escrow bucket).
//
// Drawdowns and the release commit position-locked (the service/culinary/
// fitness drawdown discipline at software scope) before their money moves
// — the ordering is the point. The remaining balance derives from the
// append-only drawdown truth, never a mutable counter. The verified
// reconciliation of record is insert-as-lock (UNIQUE per escrow): the
// FIRST reconciliation wins, and the release reads it fail-closed.

import type { Store } from "@/lib/server/store";
import type { LedgerTransactionRecord } from "@/lib/don/types";
import {
  COMPANY_VARIANCE_PAYEE_ID,
  COMPANY_VARIANCE_PAYEE_NAME,
  SOFTWARE_AUDIT_ESCROW_MAX_RATE_BPS,
  SOFTWARE_AUDIT_ESCROW_MIN_RATE_BPS,
  softwareAuditEscrowPayeeId,
  softwareAuditEscrowPayeeName,
} from "@/modules/don/constants";
import {
  SOFTWARE_AUDIT_ESCROW_DRAWDOWN_CLASSES,
  softwareAuditEscrowScopeKey,
  type SoftwareAuditEscrowDrawdownClass,
  type SoftwareAuditEscrowDrawdownRecord,
  type SoftwareAuditEscrowPolicyRecord,
  type SoftwareAuditEscrowReconciliationRecord,
} from "@/modules/software/records";
import type {
  TaxEscrowRecord as DonTaxEscrowRecord,
} from "@/modules/don/records";
import { applyWithholding } from "@/modules/compliance/engine";
import { applyRecoupmentSweep } from "@/modules/recoupment/engine";
import {
  evaluatePayoutCompliance,
  resolveCreatorKycStatus,
  resolveSoftwareVerticalComplianceState,
} from "@/modules/compliance/payoutGate";
import { postJournal } from "@/modules/ledger/engine";
import {
  fboCredit,
  softwareAuditEscrowCredit,
  softwareAuditEscrowDebit,
  unclaimedHoldingDebit,
  vaultCredit,
  type GlLegInput,
} from "@/modules/ledger/journal";
import { creditVault } from "@/modules/vaults/engine";
import { isIncomingFrozen } from "@/modules/vaults/dispute";
import { isWithholdableTalentRole } from "@/lib/server/vtuberAgency";
import { isUniqueViolation } from "@/lib/server/uniqueViolation";

/** House failure envelope — the service audit-escrow shape. */
export type SoftwareAuditEscrowFailure = {
  ok: false;
  status: number;
  code: string;
  message: string;
};

/**
 * The house zero-balance invariant, scoped to a routing: the sum of the
 * allocations (developer remainder, escrow bucket, drawdown spends) plus
 * the dust equals the gross it all came from — ALWAYS.
 */
export function softwareZeroBalanceHolds(
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

// Re-derive the scope key through the records module — the engine cites
// one identity definition, the tests import these re-exports.
export { softwareAuditEscrowScopeKey };

// ---------------------------------------------------------------------------
// The policy registry — the money terms' ONLY source.
// ---------------------------------------------------------------------------

export type SoftwareAuditEscrowPolicyInput = {
  /** The developer payee the escrow protects. */
  developer_id: string;
  /** The developer's API endpoint of record. */
  api_endpoint_id: string;
  /** The founder-banded share, basis points of the payout — 500–1000
   * (5–10%). */
  reserve_rate_bps: number;
};

/**
 * Registers the software audit escrow's policy of record for one scope —
 * the rate inside the founder's 5–10% band, enforced at registration AND
 * at use. A re-registration converges (the newest rate governs the next
 * routing) — the option-agreement discipline.
 */
export async function registerSoftwareAuditEscrowPolicy(
  store: Store,
  input: SoftwareAuditEscrowPolicyInput,
): Promise<
  { ok: true; value: SoftwareAuditEscrowPolicyRecord } | SoftwareAuditEscrowFailure
> {
  if (input.developer_id.trim() === "" || input.api_endpoint_id.trim() === "") {
    return {
      ok: false,
      status: 422,
      code: "invalid_scope_identity",
      message: "A software audit-escrow policy names the developer and API endpoint it protects.",
    };
  }
  const scopeKey = softwareAuditEscrowScopeKey(input.developer_id, input.api_endpoint_id);
  if (
    !Number.isInteger(input.reserve_rate_bps) ||
    input.reserve_rate_bps < SOFTWARE_AUDIT_ESCROW_MIN_RATE_BPS ||
    input.reserve_rate_bps > SOFTWARE_AUDIT_ESCROW_MAX_RATE_BPS
  ) {
    return {
      ok: false,
      status: 422,
      code: "escrow_rate_out_of_band",
      message: `The software escrow rate must sit inside the founder band (${SOFTWARE_AUDIT_ESCROW_MIN_RATE_BPS}–${SOFTWARE_AUDIT_ESCROW_MAX_RATE_BPS} bps — ${SOFTWARE_AUDIT_ESCROW_MIN_RATE_BPS / 100}–${SOFTWARE_AUDIT_ESCROW_MAX_RATE_BPS / 100}%).`,
    };
  }
  const policy = await store.upsertSoftwareAuditEscrowPolicy({
    scope_key: scopeKey,
    reserve_rate_bps: input.reserve_rate_bps,
  });
  return { ok: true, value: policy };
}

/**
 * The PURE split plan — the founder-banded escrow share of a developer IP
 * payout, computed in exact integer cents. The escrow share floors the
 * rate multiplication (never rounds up: the developer's routed share is
 * the exact subtraction remainder, so amount = routed + escrow + dust
 * holds with dust structurally zero). Refuses a non-integer or
 * non-positive amount and a rate outside the founder band.
 */
export function buildSoftwareAuditEscrowSplitPlan(input: {
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
  | SoftwareAuditEscrowFailure {
  const { amount_cents, reserve_rate_bps } = input;
  if (!Number.isInteger(amount_cents) || amount_cents <= 0) {
    return {
      ok: false,
      status: 422,
      code: "invalid_allocation_amount",
      message: "A developer IP payout splits in whole positive cents.",
    };
  }
  if (
    !Number.isInteger(reserve_rate_bps) ||
    reserve_rate_bps < SOFTWARE_AUDIT_ESCROW_MIN_RATE_BPS ||
    reserve_rate_bps > SOFTWARE_AUDIT_ESCROW_MAX_RATE_BPS
  ) {
    return {
      ok: false,
      status: 422,
      code: "escrow_rate_out_of_band",
      message: `The software escrow rate must sit inside the founder band (${SOFTWARE_AUDIT_ESCROW_MIN_RATE_BPS}–${SOFTWARE_AUDIT_ESCROW_MAX_RATE_BPS} bps — ${SOFTWARE_AUDIT_ESCROW_MIN_RATE_BPS / 100}–${SOFTWARE_AUDIT_ESCROW_MAX_RATE_BPS / 100}%).`,
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

export type SoftwareAuditEscrowRouteInput = {
  holding_ledger_id: string;
  /** The developer payee of the payout — the scope's developer half. */
  developer_id: string;
  /** The developer's API endpoint — the scope's endpoint half. */
  api_endpoint_id: string;
  operator_settlement_approved: boolean;
};

export type SoftwareAuditEscrowRouteCredit = {
  payee_id: string;
  payee_name: string;
  gross_cents: number;
  net_cents: number;
  step: string;
};

export type SoftwareAuditEscrowRouteSuccess = {
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
    credits: SoftwareAuditEscrowRouteCredit[];
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
 * fitness / culinary / service lanes each carry their own copy; this is
 * the software lane's.)
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
 * Routes ONE held developer IP payout credit through the software audit
 * escrow split: the payout gate (fail-closed), the CAS, the founder-banded
 * escrow lock, and the exact-subtraction remainder through the taxed
 * cascade to the developer. Idempotent BY HELD CREDIT: a replayed routing
 * reads the already-settled row and refuses with the same 409 — never a
 * second split.
 */
export async function routeSoftwareAuditEscrowFromPayout(
  store: Store,
  input: SoftwareAuditEscrowRouteInput,
  now: Date = new Date(),
): Promise<SoftwareAuditEscrowRouteSuccess | SoftwareAuditEscrowFailure> {
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
  if (input.developer_id.trim() === "" || input.api_endpoint_id.trim() === "") {
    return {
      ok: false,
      status: 422,
      code: "invalid_scope_identity",
      message: "A software escrow routing names the developer and API endpoint it protects.",
    };
  }
  const scopeKey = softwareAuditEscrowScopeKey(input.developer_id, input.api_endpoint_id);

  // The terms of record — the policy (the rate) comes from the registry,
  // never the caller. A scope with no registered policy means the
  // developer's terms name no escrow: nothing routes (a counted refusal,
  // never a guessed rate).
  const policy: SoftwareAuditEscrowPolicyRecord | undefined =
    await store.getSoftwareAuditEscrowPolicy(scopeKey);
  if (policy === undefined) {
    return {
      ok: false,
      status: 422,
      code: "missing_software_audit_escrow_policy",
      message: `No software audit-escrow policy of record exists for scope "${scopeKey}" — register the developer's escrow term before routing payouts.`,
    };
  }

  // The split — plan BEFORE anything moves (the exact-amount discipline).
  const splitPlanned = buildSoftwareAuditEscrowSplitPlan({
    amount_cents: row.amount_cents,
    reserve_rate_bps: policy.reserve_rate_bps,
  });
  if (!splitPlanned.ok) return splitPlanned;
  const split = splitPlanned.value;

  // THE SOFTWARE PAYOUT GATE — the vertical's compliance state resolves
  // from the durable gate states of record (migration 0049): an ABSENT
  // record resolves null (the gate refuses with vertical_state_unknown)
  // and an 'unknown' state refuses the specific condition
  // (software_uptime_sla_unverified / software_security_audit_not_cleared)
  // — fail-closed, before the CAS. Runs for the developer this routing
  // credits.
  const kycStatus = await resolveCreatorKycStatus(store, input.developer_id);
  const verticalState = await resolveSoftwareVerticalComplianceState(
    store,
    input.developer_id,
    input.api_endpoint_id,
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
      message: `Software escrow routing refused for developer "${input.developer_id}": ${compliance.message}`,
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
  // status 'software_audit_escrow', the per-scope sentinel payee
  // (deliberately not 'platform', not the unclaimed-holding sentinel, not
  // any earlier escrow prefix), the scope stamped in line_item_id so the
  // row is discoverable through the existing line-item index and the
  // release can re-derive state from the same registry. A floor of zero
  // on a sub-10-cent payout locks no row — there is nothing to hold and
  // a zero-amount ledger row would be noise.
  const glLegs: GlLegInput[] = [unclaimedHoldingDebit(row.amount_cents)];
  const withholding: DonTaxEscrowRecord[] = [];
  const credits: SoftwareAuditEscrowRouteCredit[] = [];
  let landedNetCents = 0;
  if (split.routed_cents > 0) {
    landedNetCents = await creditTaxedCascadePayee(
      store,
      input.developer_id,
      `Developer ${input.developer_id}`,
      split.routed_cents,
      now,
      glLegs,
      withholding,
    );
    credits.push({
      payee_id: input.developer_id,
      payee_name: `Developer ${input.developer_id}`,
      gross_cents: split.routed_cents,
      net_cents: landedNetCents,
      step: "developer_net",
    });
  }
  let escrowCredit: LedgerTransactionRecord | null = null;
  if (split.escrow_cents > 0) {
    escrowCredit = await store.insertLedgerTransaction({
      split_run_id: "",
      line_item_id: scopeKey,
      payee_id: softwareAuditEscrowPayeeId(scopeKey),
      payee_name: softwareAuditEscrowPayeeName(scopeKey),
      role: "other",
      share_bps: 0,
      amount_cents: split.escrow_cents,
      currency: row.currency,
      status: "software_audit_escrow",
      rail: null,
      baas_provider: null,
      baas_transfer_id: null,
      created_at: now.toISOString(),
      settled_at: null,
      kind: "software_audit_escrow",
    });
    glLegs.push(softwareAuditEscrowCredit(scopeKey, split.escrow_cents));
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

  // The zero-balance tripwire: developer remainder + escrow + dust === the
  // held credit, ALWAYS — the Don invariant (allocations plus dust equals
  // gross) WITH the escrow bucket inside the allocation total.
  if (
    !softwareZeroBalanceHolds(
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
        "Developer remainder + audit escrow + dust !== held credit — routing refused.",
    };
  }

  const posted = await postJournal(store, {
    kind: "software_audit_escrow_route",
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
// The drawdown lane — uptime outage penalty refunds, API rate-limit breach
// credits, and quarterly security compliance audits spend the escrow.
// ---------------------------------------------------------------------------

export type SoftwareAuditEscrowDrawdownInput = {
  reserve_ledger_id: string;
  scope_key: string;
  drawdown_class: string;
  source_event_id: string;
  drawn_cents: number;
};

export type SoftwareAuditEscrowDrawdownSuccess = {
  ok: true;
  value: {
    drawdown: SoftwareAuditEscrowDrawdownRecord;
    replayed: boolean;
    journal_id: string | null;
  };
};

/**
 * Draws the software audit escrow down — an uptime outage penalty refund,
 * an API rate-limit breach credit, or a quarterly security compliance
 * audit spending the escrow's balance. The drawdown row commits
 * position-locked BEFORE the money moves; a drawdown that consumes the
 * LAST cent settles the escrow first (the CAS arbitrates against a
 * concurrent release); money never leaves a settled escrow.
 */
export async function drawDownSoftwareAuditEscrow(
  store: Store,
  input: SoftwareAuditEscrowDrawdownInput,
  now: Date = new Date(),
): Promise<SoftwareAuditEscrowDrawdownSuccess | SoftwareAuditEscrowFailure> {
  const row = await store.getLedgerTransaction(input.reserve_ledger_id);
  if (row === undefined) {
    return {
      ok: false,
      status: 404,
      code: "escrow_credit_not_found",
      message: "No ledger transaction matches that id.",
    };
  }
  if (row.kind !== "software_audit_escrow") {
    return {
      ok: false,
      status: 422,
      code: "not_an_escrow_credit",
      message: `Ledger transaction ${row.id} is kind "${row.kind}" — only software audit-escrow credits draw down here.`,
    };
  }
  if (row.status !== "software_audit_escrow") {
    return {
      ok: false,
      status: 409,
      code: "escrow_already_settled",
      message: `Escrow credit ${row.id} is no longer held (status "${row.status}") — nothing draws from a settled escrow.`,
    };
  }
  // The scope cross-check — the caller names the scope; the escrow row's
  // sentinel payee must match it exactly (the terms-of-record discipline).
  if (row.payee_id !== softwareAuditEscrowPayeeId(input.scope_key)) {
    return {
      ok: false,
      status: 422,
      code: "escrow_scope_mismatch",
      message: `Escrow credit ${row.id} belongs to a different scope than "${input.scope_key}".`,
    };
  }
  if (
    !SOFTWARE_AUDIT_ESCROW_DRAWDOWN_CLASSES.some((cls) => cls === input.drawdown_class)
  ) {
    return {
      ok: false,
      status: 422,
      code: "invalid_drawdown_class",
      message:
        "A software escrow drawdown is an uptime_outage_penalty_refund, an api_rate_limit_breach_credit, or a quarterly_security_compliance_audit.",
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
  // 0049 CHECK's self-contained conservation identity.
  const drawdowns: SoftwareAuditEscrowDrawdownRecord[] =
    await store.listSoftwareAuditEscrowDrawdowns(row.id);
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
    const settled = await store.settleSoftwareAuditEscrow(row.id, instant);
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
  let drawdown: SoftwareAuditEscrowDrawdownRecord;
  try {
    drawdown = await store.insertSoftwareAuditEscrowDrawdown({
      reserve_ledger_id: row.id,
      scope_key: input.scope_key,
      drawdown_class: input.drawdown_class as SoftwareAuditEscrowDrawdownClass,
      source_event_id: input.source_event_id,
      drawn_before_cents: drawnBefore,
      drawn_cents: input.drawn_cents,
      remaining_cents: remaining,
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      const all = await store.listSoftwareAuditEscrowDrawdowns(row.id);
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
    if (rechecked === undefined || rechecked.status !== "software_audit_escrow") {
      return {
        ok: false,
        status: 409,
        code: "escrow_already_settled",
        message: `Escrow credit ${row.id} is no longer held — a concurrent release won.`,
      };
    }
  }

  // The drawdown's own journal: the escrow account debits back to FBO
  // cash — the outage penalty refund's, rate-limit breach credit's, or
  // security compliance audit's expense, itemized.
  const posted = await postJournal(store, {
    kind: "software_audit_escrow_drawdown",
    ref_type: "ledger_transaction",
    ref_id: row.id,
    legs: [
      softwareAuditEscrowDebit(input.scope_key, input.drawn_cents),
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

export type SoftwareAuditEscrowReconcileInput = {
  reserve_ledger_id: string;
  scope_key: string;
  evidence_ref: string;
  reconciled_by: string;
};

/**
 * Records the verified reconciliation of record for one software escrow —
 * the release gate's key. Insert-as-lock: the FIRST reconciliation wins;
 * a concurrent second reconciliation surfaces the conflict (the escrow is
 * reconciled once, by one verified audit).
 */
export async function reconcileSoftwareAuditEscrow(
  store: Store,
  input: SoftwareAuditEscrowReconcileInput,
): Promise<
  { ok: true; value: SoftwareAuditEscrowReconciliationRecord } | SoftwareAuditEscrowFailure
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
    row.kind !== "software_audit_escrow" ||
    row.payee_id !== softwareAuditEscrowPayeeId(input.scope_key)
  ) {
    return {
      ok: false,
      status: 422,
      code: "not_an_escrow_credit",
      message: `Ledger transaction ${row.id} is not this scope's software audit-escrow credit.`,
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
  const reconciliation = await store.insertSoftwareAuditEscrowReconciliation({
    reserve_ledger_id: input.reserve_ledger_id,
    evidence_ref: input.evidence_ref,
    reconciled_by: input.reconciled_by,
  });
  return { ok: true, value: reconciliation };
}

export type SoftwareAuditEscrowReleaseInput = {
  reserve_ledger_id: string;
  /** Must equal the scope the escrow routed under — derived from the
   * developer + API endpoint identity and cross-checked against the
   * sentinel payee. */
  scope_key: string;
  developer_id: string;
  api_endpoint_id: string;
  operator_settlement_approved: boolean;
};

export type SoftwareAuditEscrowReleaseSuccess = {
  ok: true;
  value: {
    /** The settled escrow row (status 'settled' after this release). */
    escrow_credit: LedgerTransactionRecord;
    released_cents: number;
    credits: SoftwareAuditEscrowRouteCredit[];
    withholding: DonTaxEscrowRecord[];
    company_dust_cents: number;
    journal_id: string;
  };
};

/**
 * Releases a held software audit escrow to the developer through the
 * taxed cascade — the VERIFIED release: the reconciliation of record must
 * exist (fail-closed, before the CAS — no reconciliation of record, no
 * release), the remaining balance re-derived from the append-only
 * drawdown truth, the software payout gate re-resolved from the durable
 * gate states of record, the scope cross-checked against the identity
 * pair, the CAS BEFORE any money moves, and the taxed cascade for the
 * actual routing. Drawdowns already spent stay spent — the release pays
 * only what the compliance exposure protected.
 */
export async function releaseSoftwareAuditEscrow(
  store: Store,
  input: SoftwareAuditEscrowReleaseInput,
  now: Date = new Date(),
): Promise<SoftwareAuditEscrowReleaseSuccess | SoftwareAuditEscrowFailure> {
  const row = await store.getLedgerTransaction(input.reserve_ledger_id);
  if (row === undefined) {
    return {
      ok: false,
      status: 404,
      code: "escrow_credit_not_found",
      message: "No ledger transaction matches that id.",
    };
  }
  if (row.kind !== "software_audit_escrow") {
    return {
      ok: false,
      status: 422,
      code: "not_an_escrow_credit",
      message: `Ledger transaction ${row.id} is kind "${row.kind}" — only software audit-escrow credits release here.`,
    };
  }
  if (row.status !== "software_audit_escrow") {
    return {
      ok: false,
      status: 409,
      code: "escrow_already_settled",
      message: `Escrow credit ${row.id} is no longer held (status "${row.status}").`,
    };
  }
  // The scope cross-check, twice over: the caller names the scope AND the
  // (developer, API endpoint) identity it releases to — the identity must
  // re-derive the scope exactly (the keys are injective in their identity
  // tuples), and the escrow row's sentinel payee must match it.
  const derivedScope = softwareAuditEscrowScopeKey(input.developer_id, input.api_endpoint_id);
  if (
    input.developer_id.trim() === "" ||
    input.api_endpoint_id.trim() === "" ||
    derivedScope !== input.scope_key
  ) {
    return {
      ok: false,
      status: 422,
      code: "escrow_scope_mismatch",
      message: "The release's (developer, API endpoint) identity must re-derive the named scope.",
    };
  }
  if (row.payee_id !== softwareAuditEscrowPayeeId(input.scope_key)) {
    return {
      ok: false,
      status: 422,
      code: "escrow_scope_mismatch",
      message: `Escrow credit ${row.id} belongs to a different scope than "${input.scope_key}".`,
    };
  }

  // THE VERIFIED RECONCILIATION — the release gate's key, read FAIL-CLOSED
  // before the CAS: no reconciliation of record, no release.
  const reconciliation = await store.getSoftwareAuditEscrowReconciliation(row.id);
  if (reconciliation === undefined) {
    return {
      ok: false,
      status: 403,
      code: "software_audit_escrow_reconciliation_missing",
      message:
        "No verified reconciliation of record exists for this escrow — reconcile the outage-refund, breach-credit, and security-audit exposure before releasing.",
    };
  }

  // The policy of record must still exist (the terms never vanish).
  const policy: SoftwareAuditEscrowPolicyRecord | undefined =
    await store.getSoftwareAuditEscrowPolicy(input.scope_key);
  if (policy === undefined) {
    return {
      ok: false,
      status: 422,
      code: "missing_software_audit_escrow_policy",
      message: `No software audit-escrow policy of record exists for scope "${input.scope_key}".`,
    };
  }

  // The remaining balance derives from the append-only drawdown truth.
  const drawdowns: SoftwareAuditEscrowDrawdownRecord[] =
    await store.listSoftwareAuditEscrowDrawdowns(row.id);
  const drawnBefore = drawdowns.reduce((total, line) => total + line.drawn_cents, 0);
  const remaining = row.amount_cents - drawnBefore;
  if (remaining <= 0) {
    return {
      ok: false,
      status: 422,
      code: "escrow_fully_drawn",
      message:
        "The escrow is fully drawn — outage penalty refunds, rate-limit breach credits, and security compliance audits spent every cent of it.",
    };
  }

  // The gate family — the software vertical's compliance state resolves
  // from the durable gate states of record: fail-closed at release too,
  // an absent record refuses.
  const kycStatus = await resolveCreatorKycStatus(store, input.developer_id);
  const verticalState = await resolveSoftwareVerticalComplianceState(
    store,
    input.developer_id,
    input.api_endpoint_id,
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
      message: `Software escrow release refused for developer "${input.developer_id}": ${compliance.message}`,
    };
  }

  // The CAS wins BEFORE any money moves: the concurrent release or
  // full-drawdown loser reads undefined here and refuses.
  const instant = now.toISOString();
  const settled = await store.settleSoftwareAuditEscrow(row.id, instant);
  if (settled === undefined) {
    return {
      ok: false,
      status: 409,
      code: "escrow_already_settled",
      message: `Escrow credit ${row.id} is no longer held — a concurrent release or drawdown won.`,
    };
  }

  // The taxed cascade routes the remaining balance to the developer — the
  // same fail-closed family every payout rides. The journal opens with
  // the escrow account's debit leg (the escrow pays out); the cascade
  // appends its own credits.
  const glLegs: GlLegInput[] = [softwareAuditEscrowDebit(input.scope_key, remaining)];
  const withholding: DonTaxEscrowRecord[] = [];
  const credits: SoftwareAuditEscrowRouteCredit[] = [];
  let landedNetCents = 0;
  if (remaining > 0) {
    landedNetCents = await creditTaxedCascadePayee(
      store,
      input.developer_id,
      `Developer ${input.developer_id}`,
      remaining,
      now,
      glLegs,
      withholding,
    );
    credits.push({
      payee_id: input.developer_id,
      payee_name: `Developer ${input.developer_id}`,
      gross_cents: remaining,
      net_cents: landedNetCents,
      step: "developer_net",
    });
  }

  // The zero-balance tripwire: drawdowns + released + dust === the locked
  // escrow, ALWAYS.
  const companyDustCents = 0;
  if (
    !softwareZeroBalanceHolds(
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
    kind: "software_audit_escrow_release",
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
