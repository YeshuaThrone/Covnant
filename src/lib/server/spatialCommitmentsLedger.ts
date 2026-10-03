// The spatial commitments lane (PR 37, founder directive): CapEx
// recoupment, the quarterly Minimum Spatial Guarantee, the temporary
// pop-up decommissioning audit, and the SPATIAL_AUDIT_ESCROW.
//
// Four services ride the recon posting seam's established patterns:
//
//   1. THE CAPEX RECOUPMENT OFFSET — applySpatialCapexOffset consumes one
//      committed spatial royalty of record (occupancy, zone, or micro —
//      the amount read from the append-only ledger row, never the
//      caller's numbers) across the venue scope's registered CapEx
//      commitments (ride construction + venue build-out, created_at ASC —
//      the OLDEST-FIRST amortization order). Each application commits
//      position-locked (UNIQUE per (commitment, source_event) replay
//      guard + UNIQUE per (commitment, offset_before) position lock —
//      the licensing recoupment discipline at spatial scope); a lost
//      race re-derives from the append-only truth and retries. The IP
//      owner's payout is the royalty MINUS the offset — early-stage
//      royalties amortize the builds until every commitment clears.
//
//   2. THE QUARTERLY MSG CLOSE — closeSpatialMsgTerm is the guarantee's
//      close of record per (commitment, quarter): UNIQUE per the pair
//      (the once-only close), the scope's earnings derived from the
//      THREE append-only spatial royalty ledgers (the venue's rows in
//      the quarter's months), the guarantee priced floor(footprint ×
//      rate / 1e6) from the commitment's reserved-footprint terms. A
//      positive shortfall DEBITS THE INVOICE OF RECORD automatically: a
//      ledger row with kind AND status 'msg_shortfall_due' — the payee
//      is the OPERATOR of record, the quarter key stamped in
//      line_item_id — plus the GL journal (the operator receivable
//      rises; the shortfall penalty income of record rises; balanced
//      legs). A zero shortfall records the met guarantee and moves
//      nothing.
//
//   3. THE TEMPORARY POP-UP DECOMMISSIONING AUDIT — a pop-up scope's
//      escrow release additionally requires the post-event inventory
//      write-off calculation of record AND the site restoration reserve
//      of record (insert-as-locked per pop-up). No records, no
//      disbursement — fail-closed.
//
//   4. THE SPATIAL_AUDIT_ESCROW — the founder-banded 5–12% of a scope's
//      park earnings that locks as its own ledger row (sentinel payee +
//      GL account — never folded into platform dust, unclaimed holding,
//      or the NIL escrow), drawn down position-locked by local
//      entertainment sales taxes, safety compliance holdbacks, and
//      quarterly park concession reconciliations, and released only
//      against the verified reconciliation of record (fail-closed: no
//      reconciliation, no release). THE INVARIANT: routed remainder +
//      escrow + dust === the held credit, ALWAYS; drawdowns + released
//      remainder === the locked escrow, ALWAYS.

import type { Store } from "@/lib/server/store";
import type { LedgerTransactionRecord } from "@/lib/don/types";
import {
  SPATIAL_AUDIT_ESCROW_DRAWDOWN_CLASSES,
  SPATIAL_AUDIT_ESCROW_MAX_RATE_BPS,
  SPATIAL_AUDIT_ESCROW_MIN_RATE_BPS,
  COMPANY_VARIANCE_PAYEE_ID,
  COMPANY_VARIANCE_PAYEE_NAME,
  spatialAuditEscrowPayeeId,
  spatialAuditEscrowPayeeName,
  type SpatialAuditEscrowDrawdownClass,
} from "@/modules/don/constants";
import {
  buildSpatialAuditEscrowSplitPlan,
  buildSpatialCapexRecoupmentPlan,
  isSpatialMsgQuarter,
  isSpatialPopupScope,
  spatialAuditEscrowScopeKey,
  spatialCapexScopeKey,
  spatialMsgDueCents,
  spatialMsgQuarterMonths,
  type SpatialAuditEscrowDrawdownRecord,
  type SpatialAuditEscrowPolicyRecord,
  type SpatialAuditEscrowReconciliationRecord,
  type SpatialCapexApplicationRecord,
  type SpatialCapexCommitmentRecord,
  type SpatialCapexRecoupmentStep,
  type SpatialMsgCommitmentRecord,
  type SpatialMsgTermCloseRecord,
  type SpatialPopupExperienceRecord,
  type SpatialPopupRestorationReserveRecord,
  type SpatialPopupWriteoffRecord,
  type SpatialRoyaltyApplicationRecord,
  type SpatialRoyaltyStream,
  type SpatialZoneAllocationRecord,
  type SpatialMicroRoyaltyRecord,
} from "@/modules/spatial/records";
import type {
  CompanyDustRecord as DonCompanyDustRecord,
  TaxEscrowRecord as DonTaxEscrowRecord,
} from "@/modules/don/records";
import { applyWithholding } from "@/modules/compliance/engine";
import { applyRecoupmentSweep } from "@/modules/recoupment/engine";
import {
  evaluatePayoutCompliance,
  resolveCreatorKycStatus,
  resolveSpatialVerticalComplianceState,
} from "@/modules/compliance/payoutGate";
import { postJournal } from "@/modules/ledger/engine";
import {
  fboCredit,
  spatialAuditEscrowCredit,
  spatialAuditEscrowDebit,
  spatialMsgReceivableDebit,
  spatialMsgShortfallIncomeCredit,
  unclaimedHoldingDebit,
  vaultCredit,
  type GlLegInput,
} from "@/modules/ledger/journal";
import { creditVault } from "@/modules/vaults/engine";
import { isIncomingFrozen } from "@/modules/vaults/dispute";
import { isWithholdableTalentRole } from "@/lib/server/vtuberAgency";
import { isUniqueViolation } from "@/lib/server/uniqueViolation";

/** House failure envelope — the licensing / NIL escrow shape. */
export type SpatialCommitmentsFailure = {
  ok: false;
  status: number;
  code: string;
  message: string;
};

/**
 * The house zero-balance invariant, scoped to a routing — the same
 * tripwire the NIL escrow rides: the allocations plus the dust equals
 * the gross it all came from, ALWAYS.
 */
export function spatialZeroBalanceHolds(
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
// The SPATIAL_AUDIT_ESCROW — policy registry, routing, drawdowns,
// reconciliation, and the release.
// ---------------------------------------------------------------------------

export type SpatialAuditEscrowPolicyInput = {
  /** The park venue (or pop-up, via the scope overload) the escrow
   * protects. */
  venue_id: string;
  /** The pop-up ref when the policy prices a temporary pop-up's scope. */
  popup_ref?: string;
  /** The founder-banded share, basis points of park earnings — 500–1200
   * (5–12%). */
  reserve_rate_bps: number;
};

/**
 * Registers the spatial audit escrow's policy of record for one
 * (venue [, pop-up]) scope — the rate inside the founder's 5–12% band,
 * enforced at registration AND at use. A re-registration converges (the
 * newest rate governs the next routing) — the option-agreement
 * discipline.
 */
export async function registerSpatialAuditEscrowPolicy(
  store: Store,
  input: SpatialAuditEscrowPolicyInput,
): Promise<{ ok: true; value: SpatialAuditEscrowPolicyRecord } | SpatialCommitmentsFailure> {
  if (input.venue_id.trim() === "" || (input.popup_ref !== undefined && input.popup_ref.trim() === "")) {
    return {
      ok: false,
      status: 422,
      code: "invalid_scope_identity",
      message: "A spatial audit-escrow policy names the venue (and optional pop-up) it protects.",
    };
  }
  if (
    !Number.isInteger(input.reserve_rate_bps) ||
    input.reserve_rate_bps < SPATIAL_AUDIT_ESCROW_MIN_RATE_BPS ||
    input.reserve_rate_bps > SPATIAL_AUDIT_ESCROW_MAX_RATE_BPS
  ) {
    return {
      ok: false,
      status: 422,
      code: "escrow_rate_out_of_band",
      message: `The spatial escrow rate must sit inside the founder band (${SPATIAL_AUDIT_ESCROW_MIN_RATE_BPS}–${SPATIAL_AUDIT_ESCROW_MAX_RATE_BPS} bps — ${SPATIAL_AUDIT_ESCROW_MIN_RATE_BPS / 100}–${SPATIAL_AUDIT_ESCROW_MAX_RATE_BPS / 100}%).`,
    };
  }
  const policy = await store.upsertSpatialAuditEscrowPolicy({
    scope_key: spatialAuditEscrowScopeKey(input.venue_id, input.popup_ref),
    reserve_rate_bps: input.reserve_rate_bps,
  });
  return { ok: true, value: policy };
}

export type SpatialAuditEscrowRouteInput = {
  holding_ledger_id: string;
  /** The venue whose park earnings the credit carries — the scope's
   * venue half. */
  venue_id: string;
  /** The pop-up ref when the held credit is a temporary pop-up's. */
  popup_ref?: string;
  /** The payee the non-escrow remainder credits — the IP owner (or
   * operator) of record for the scope's earnings. */
  payee_id: string;
  operator_settlement_approved: boolean;
};

export type SpatialAuditEscrowRouteCredit = {
  payee_id: string;
  payee_name: string;
  gross_cents: number;
  net_cents: number;
  step: string;
};

export type SpatialAuditEscrowRouteSuccess = {
  ok: true;
  value: {
    /** The settled holding row (status 'settled' after this routing). */
    distribution_credit: LedgerTransactionRecord;
    split: {
      escrow_cents: number;
      remainder_cents: number;
      dust_cents: number;
    };
    /** The locked escrow row when the escrow share priced positive. */
    escrow_credit: LedgerTransactionRecord | null;
    credits: SpatialAuditEscrowRouteCredit[];
    withholding: DonTaxEscrowRecord[];
    company_dust_cents: number;
    company_dust_record: DonCompanyDustRecord | null;
    journal_id: string;
  };
};

/**
 * The taxed cascade one payee's credit rides — withholding off the top,
 * the catalog-dispute freeze check, the recoupment sweep. The SAME
 * fail-closed family every payout credits through; returns the net that
 * actually landed in the payee's vault. (The house convention keeps this
 * cascade per-lane — this is the spatial lane's copy.)
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
 * Routes ONE held park-earnings credit through the spatial audit escrow
 * split: the spatial payout gate (territorial_zoning_cleared AND
 * spatial_audit_verified — fail-closed when absent or unknown), the CAS,
 * the founder-banded escrow lock, and the exact-subtraction remainder
 * through the taxed cascade to the scope's payee of record. Idempotent BY
 * HELD CREDIT: a replayed routing reads the already-settled row and
 * refuses with the same 409 — never a second split.
 */
export async function routeSpatialAuditEscrowFromHolding(
  store: Store,
  input: SpatialAuditEscrowRouteInput,
  now: Date = new Date(),
): Promise<SpatialAuditEscrowRouteSuccess | SpatialCommitmentsFailure> {
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
  if (input.venue_id.trim() === "" || input.payee_id.trim() === "") {
    return {
      ok: false,
      status: 422,
      code: "invalid_scope_identity",
      message: "A spatial escrow routing names the venue and the payee of record.",
    };
  }
  const scopeKey = spatialAuditEscrowScopeKey(input.venue_id, input.popup_ref);

  // The terms of record — the policy (the rate) comes from the registry,
  // never the caller. A scope with no registered policy means the
  // venue's contract names no escrow term: nothing routes (a counted
  // refusal, never a guessed rate).
  const policy: SpatialAuditEscrowPolicyRecord | undefined =
    await store.getSpatialAuditEscrowPolicy(scopeKey);
  if (policy === undefined) {
    return {
      ok: false,
      status: 422,
      code: "missing_spatial_audit_escrow_policy",
      message: `No spatial audit-escrow policy of record exists for scope "${scopeKey}" — register the scope's escrow term before routing park earnings.`,
    };
  }

  // THE SPATIAL PAYOUT GATE — the vertical's compliance state resolves
  // from the durable gate states of record (migration 0041): an ABSENT
  // record resolves null (the gate refuses with vertical_state_unknown)
  // and an 'unknown' state refuses the specific condition
  // (territorial_zoning_not_cleared / spatial_audit_unverified) —
  // fail-closed, before the CAS. Runs for the payee this routing
  // credits.
  const kycStatus = await resolveCreatorKycStatus(store, input.payee_id);
  const verticalState = await resolveSpatialVerticalComplianceState(
    store,
    input.payee_id,
    input.venue_id,
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
      message: `Spatial escrow routing refused for payee "${input.payee_id}": ${compliance.message}`,
    };
  }

  // The split — plan BEFORE anything moves (the exact-amount discipline).
  const split = buildSpatialAuditEscrowSplitPlan(row.amount_cents, policy.reserve_rate_bps);

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
  // status 'spatial_audit_escrow', the per-scope sentinel payee
  // (deliberately not 'platform', not the unclaimed-holding sentinel,
  // not the NIL escrow's prefix), the scope stamped in line_item_id so
  // the row is discoverable through the existing line-item index and the
  // release can re-derive state from the same registry. A floor of zero
  // on a sub-escrow-rate credit locks no row — there is nothing to hold
  // and a zero-amount ledger row would be noise.
  const glLegs: GlLegInput[] = [unclaimedHoldingDebit(row.amount_cents)];
  const withholding: DonTaxEscrowRecord[] = [];
  const credits: SpatialAuditEscrowRouteCredit[] = [];
  let landedNetCents = 0;
  if (split.remainder_cents > 0) {
    landedNetCents = await creditTaxedCascadePayee(
      store,
      input.payee_id,
      `Spatial payee ${input.payee_id}`,
      split.remainder_cents,
      now,
      glLegs,
      withholding,
    );
    credits.push({
      payee_id: input.payee_id,
      payee_name: `Spatial payee ${input.payee_id}`,
      gross_cents: split.remainder_cents,
      net_cents: landedNetCents,
      step: "payee_net",
    });
  }
  let escrowCredit: LedgerTransactionRecord | null = null;
  if (split.escrow_cents > 0) {
    escrowCredit = await store.insertLedgerTransaction({
      split_run_id: "",
      line_item_id: scopeKey,
      payee_id: spatialAuditEscrowPayeeId(scopeKey),
      payee_name: spatialAuditEscrowPayeeName(scopeKey),
      role: "other",
      share_bps: 0,
      amount_cents: split.escrow_cents,
      currency: row.currency,
      status: "spatial_audit_escrow",
      rail: null,
      baas_provider: null,
      baas_transfer_id: null,
      created_at: now.toISOString(),
      settled_at: null,
      kind: "spatial_audit_escrow",
    });
    glLegs.push(spatialAuditEscrowCredit(scopeKey, split.escrow_cents));
  }

  // The integer-cent dust — structurally zero under the subtraction
  // model; swept to the platform variance account with its own ledger
  // rows if it ever differs (the house dust discipline, retained
  // defensively).
  const companyDustCents = split.dust_cents;
  let companyDustRecord: DonCompanyDustRecord | null = null;
  if (companyDustCents > 0) {
    companyDustRecord = await store.insertCompanyDust({
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

  // The zero-balance tripwire: routed remainder + escrow + dust === the
  // held credit, ALWAYS — the Don invariant (allocations plus dust
  // equals gross) WITH the escrow bucket inside the allocation total.
  if (
    !spatialZeroBalanceHolds(
      row.amount_cents,
      [{ amount_cents: split.remainder_cents }, { amount_cents: split.escrow_cents }],
      companyDustCents,
    )
  ) {
    return {
      ok: false,
      status: 500,
      code: "zero_balance_violation",
      message:
        "Spatial remainder + audit escrow + dust !== held credit — routing refused.",
    };
  }

  const posted = await postJournal(store, {
    kind: "spatial_audit_escrow_route",
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
      split: {
        escrow_cents: split.escrow_cents,
        remainder_cents: split.remainder_cents,
        dust_cents: split.dust_cents,
      },
      escrow_credit: escrowCredit,
      credits,
      withholding,
      company_dust_cents: companyDustCents,
      company_dust_record: companyDustRecord,
      journal_id: posted.journal.id,
    },
  };
}

export type SpatialAuditEscrowDrawdownInput = {
  reserve_ledger_id: string;
  scope_key: string;
  drawdown_class: string;
  source_event_id: string;
  drawn_cents: number;
};

export type SpatialAuditEscrowDrawdownSuccess = {
  ok: true;
  value: {
    drawdown: SpatialAuditEscrowDrawdownRecord;
    replayed: boolean;
    journal_id: string | null;
  };
};

/**
 * Draws the spatial audit escrow down — a local entertainment sales tax,
 * a safety compliance holdback, or a quarterly park concession
 * reconciliation spending the escrow's balance. The drawdown row commits
 * position-locked BEFORE the money moves; a drawdown that consumes the
 * LAST cent settles the escrow first (the CAS arbitrates against a
 * concurrent release); money never leaves a settled escrow.
 */
export async function drawDownSpatialAuditEscrow(
  store: Store,
  input: SpatialAuditEscrowDrawdownInput,
  now: Date = new Date(),
): Promise<SpatialAuditEscrowDrawdownSuccess | SpatialCommitmentsFailure> {
  const row = await store.getLedgerTransaction(input.reserve_ledger_id);
  if (row === undefined) {
    return {
      ok: false,
      status: 404,
      code: "escrow_credit_not_found",
      message: "No ledger transaction matches that id.",
    };
  }
  if (row.kind !== "spatial_audit_escrow") {
    return {
      ok: false,
      status: 422,
      code: "not_an_escrow_credit",
      message: `Ledger transaction ${row.id} is kind "${row.kind}" — only spatial audit-escrow credits draw down here.`,
    };
  }
  if (row.status !== "spatial_audit_escrow") {
    return {
      ok: false,
      status: 409,
      code: "escrow_already_settled",
      message: `Escrow credit ${row.id} is no longer held (status "${row.status}") — nothing draws from a settled escrow.`,
    };
  }
  // The scope cross-check — the caller names the scope; the escrow row's
  // sentinel payee must match it exactly (the terms-of-record discipline).
  if (row.payee_id !== spatialAuditEscrowPayeeId(input.scope_key)) {
    return {
      ok: false,
      status: 422,
      code: "escrow_scope_mismatch",
      message: `Escrow credit ${row.id} belongs to a different scope than "${input.scope_key}".`,
    };
  }
  if (
    !SPATIAL_AUDIT_ESCROW_DRAWDOWN_CLASSES.some((cls) => cls === input.drawdown_class)
  ) {
    return {
      ok: false,
      status: 422,
      code: "invalid_drawdown_class",
      message:
        "A spatial escrow drawdown is an entertainment_sales_tax, a safety_compliance_holdback, or a concession_reconciliation.",
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
  const drawdowns: SpatialAuditEscrowDrawdownRecord[] =
    await store.listSpatialAuditEscrowDrawdowns(row.id);
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
    const settled = await store.settleSpatialAuditEscrow(row.id, instant);
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
  let drawdown: SpatialAuditEscrowDrawdownRecord;
  try {
    drawdown = await store.insertSpatialAuditEscrowDrawdown({
      reserve_ledger_id: row.id,
      scope_key: input.scope_key,
      drawdown_class: input.drawdown_class as SpatialAuditEscrowDrawdownClass,
      source_event_id: input.source_event_id,
      drawn_before_cents: drawnBefore,
      drawn_cents: input.drawn_cents,
      remaining_cents: remaining - input.drawn_cents,
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      const all = await store.listSpatialAuditEscrowDrawdowns(row.id);
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
    if (rechecked === undefined || rechecked.status !== "spatial_audit_escrow") {
      return {
        ok: false,
        status: 409,
        code: "escrow_already_settled",
        message: `Escrow credit ${row.id} is no longer held — a concurrent release won.`,
      };
    }
  }

  // The drawdown's own journal: the escrow account debits back to FBO
  // cash — the tax's, holdback's, or reconciliation's expense, itemized.
  const posted = await postJournal(store, {
    kind: "spatial_audit_escrow_drawdown",
    ref_type: "ledger_transaction",
    ref_id: row.id,
    legs: [
      spatialAuditEscrowDebit(input.scope_key, input.drawn_cents),
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

export type SpatialAuditEscrowReconcileInput = {
  reserve_ledger_id: string;
  scope_key: string;
  evidence_ref: string;
  reconciled_by: string;
};

/**
 * Records the verified reconciliation of record for one spatial escrow —
 * the release gate's key. Insert-as-lock: the FIRST reconciliation wins;
 * a concurrent second reconciliation surfaces the conflict (the escrow
 * is reconciled once, by one verified audit).
 */
export async function reconcileSpatialAuditEscrow(
  store: Store,
  input: SpatialAuditEscrowReconcileInput,
): Promise<{ ok: true; value: SpatialAuditEscrowReconciliationRecord } | SpatialCommitmentsFailure> {
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
    row.kind !== "spatial_audit_escrow" ||
    row.payee_id !== spatialAuditEscrowPayeeId(input.scope_key)
  ) {
    return {
      ok: false,
      status: 422,
      code: "not_an_escrow_credit",
      message: `Ledger transaction ${row.id} is not this scope's spatial audit-escrow credit.`,
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
  const reconciliation = await store.insertSpatialAuditEscrowReconciliation({
    reserve_ledger_id: input.reserve_ledger_id,
    evidence_ref: input.evidence_ref,
    reconciled_by: input.reconciled_by,
  });
  return { ok: true, value: reconciliation };
}

export type SpatialAuditEscrowReleaseInput = {
  reserve_ledger_id: string;
  /** Must equal the scope the escrow routed under — derived from the
   * venue (+ pop-up) pair and cross-checked against the sentinel payee. */
  scope_key: string;
  venue_id: string;
  popup_ref?: string;
  /** The payee the released remainder credits — the same payee the
   * routing credited. */
  payee_id: string;
  operator_settlement_approved: boolean;
};

export type SpatialAuditEscrowReleaseSuccess = {
  ok: true;
  value: {
    /** The settled escrow row (status 'settled' after this release). */
    escrow_credit: LedgerTransactionRecord;
    released_cents: number;
    credits: SpatialAuditEscrowRouteCredit[];
    withholding: DonTaxEscrowRecord[];
    company_dust_cents: number;
    journal_id: string;
  };
};

/**
 * Releases a held spatial audit escrow to the scope's payee through the
 * taxed cascade — the VERIFIED release: the reconciliation of record
 * must exist (fail-closed, before the CAS — no reconciliation of record,
 * no release), a POP-UP scope additionally requires its post-event
 * inventory write-off calculation AND site restoration reserve of record
 * (the decommissioning audit — fail-closed), the remaining balance
 * re-derived from the append-only drawdown truth, the spatial payout
 * gate re-resolved from the durable gate states of record, the scope
 * cross-checked against the (venue [, pop-up]) pair, the CAS BEFORE any
 * money moves, and the taxed cascade for the actual routing. Drawdowns
 * already spent stay spent — the release pays only what the compliance
 * exposure protected.
 */
export async function releaseSpatialAuditEscrow(
  store: Store,
  input: SpatialAuditEscrowReleaseInput,
  now: Date = new Date(),
): Promise<SpatialAuditEscrowReleaseSuccess | SpatialCommitmentsFailure> {
  const row = await store.getLedgerTransaction(input.reserve_ledger_id);
  if (row === undefined) {
    return {
      ok: false,
      status: 404,
      code: "escrow_credit_not_found",
      message: "No ledger transaction matches that id.",
    };
  }
  if (row.kind !== "spatial_audit_escrow") {
    return {
      ok: false,
      status: 422,
      code: "not_an_escrow_credit",
      message: `Ledger transaction ${row.id} is kind "${row.kind}" — only spatial audit-escrow credits release here.`,
    };
  }
  if (row.status !== "spatial_audit_escrow") {
    return {
      ok: false,
      status: 409,
      code: "escrow_already_settled",
      message: `Escrow credit ${row.id} is no longer held (status "${row.status}").`,
    };
  }
  // The scope cross-check, twice over: the caller names the scope AND the
  // (venue [, pop-up]) pair it releases under — the pair must re-derive
  // the scope exactly, and the escrow row's sentinel payee must match it.
  if (
    input.venue_id.trim() === "" ||
    input.payee_id.trim() === "" ||
    spatialAuditEscrowScopeKey(input.venue_id, input.popup_ref) !== input.scope_key
  ) {
    return {
      ok: false,
      status: 422,
      code: "escrow_scope_mismatch",
      message: "The release's (venue, pop-up) pair must re-derive the named scope.",
    };
  }
  if (row.payee_id !== spatialAuditEscrowPayeeId(input.scope_key)) {
    return {
      ok: false,
      status: 422,
      code: "escrow_scope_mismatch",
      message: `Escrow credit ${row.id} belongs to a different scope than "${input.scope_key}".`,
    };
  }

  // THE VERIFIED RECONCILIATION — the release gate's key, read FAIL-CLOSED
  // before the CAS: no reconciliation of record, no release.
  const reconciliation = await store.getSpatialAuditEscrowReconciliation(row.id);
  if (reconciliation === undefined) {
    return {
      ok: false,
      status: 403,
      code: "spatial_audit_escrow_reconciliation_missing",
      message:
        "No verified reconciliation of record exists for this escrow — reconcile the audit before releasing.",
    };
  }

  // THE TEMPORARY POP-UP DECOMMISSIONING AUDIT — a pop-up scope's final
  // disbursement additionally requires the post-event inventory
  // write-off calculation of record AND the site restoration reserve of
  // record (both insert-as-locked per pop-up). Either missing → fail
  // closed (the operator owes the audit before the escrow releases).
  if (isSpatialPopupScope(input.scope_key)) {
    const experience: SpatialPopupExperienceRecord | undefined =
      await store.getSpatialPopupExperience(input.popup_ref ?? "");
    if (experience === undefined) {
      return {
        ok: false,
        status: 422,
        code: "popup_experience_not_found",
        message: `No pop-up experience of record matches ref "${input.popup_ref}" — register the pop-up before its escrow releases.`,
      };
    }
    const writeoffs: SpatialPopupWriteoffRecord[] =
      await store.listSpatialPopupWriteoffs(experience.id);
    if (writeoffs.length === 0) {
      return {
        ok: false,
        status: 403,
        code: "popup_writeoff_missing",
        message:
          "No post-event inventory write-off of record exists for this pop-up — the decommissioning audit blocks the final disbursement.",
      };
    }
    const reserve: SpatialPopupRestorationReserveRecord | undefined =
      await store.getSpatialPopupRestorationReserve(experience.id);
    if (reserve === undefined) {
      return {
        ok: false,
        status: 403,
        code: "popup_restoration_reserve_missing",
        message:
          "No site restoration reserve of record exists for this pop-up — the decommissioning audit blocks the final disbursement.",
      };
    }
  }

  // The policy of record must still exist (the terms never vanish).
  const policy: SpatialAuditEscrowPolicyRecord | undefined =
    await store.getSpatialAuditEscrowPolicy(input.scope_key);
  if (policy === undefined) {
    return {
      ok: false,
      status: 422,
      code: "missing_spatial_audit_escrow_policy",
      message: `No spatial audit-escrow policy of record exists for scope "${input.scope_key}".`,
    };
  }

  // The remaining balance derives from the append-only drawdown truth.
  const drawdowns: SpatialAuditEscrowDrawdownRecord[] =
    await store.listSpatialAuditEscrowDrawdowns(row.id);
  const drawnBefore = drawdowns.reduce((total, line) => total + line.drawn_cents, 0);
  const remaining = row.amount_cents - drawnBefore;
  if (remaining <= 0) {
    return {
      ok: false,
      status: 422,
      code: "escrow_fully_drawn",
      message:
        "The escrow is fully drawn — taxes, holdbacks, and reconciliations spent every cent of it.",
    };
  }

  // The gate family — the spatial vertical's compliance state resolves
  // from the durable gate states of record: fail-closed at release too,
  // an absent record refuses.
  const kycStatus = await resolveCreatorKycStatus(store, input.payee_id);
  const verticalState = await resolveSpatialVerticalComplianceState(
    store,
    input.payee_id,
    input.venue_id,
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
      message: `Spatial escrow release refused for payee "${input.payee_id}": ${compliance.message}`,
    };
  }

  // The CAS wins BEFORE any money moves: the concurrent release or
  // full-drawdown loser reads undefined here and refuses.
  const instant = now.toISOString();
  const settled = await store.settleSpatialAuditEscrow(row.id, instant);
  if (settled === undefined) {
    return {
      ok: false,
      status: 409,
      code: "escrow_already_settled",
      message: `Escrow credit ${row.id} is no longer held — a concurrent release or drawdown won.`,
    };
  }

  // The taxed cascade routes the remaining balance to the payee — the
  // same fail-closed family every payout rides. The journal opens with
  // the escrow account's debit leg (the escrow pays out); the cascade
  // appends its own credits.
  const glLegs: GlLegInput[] = [spatialAuditEscrowDebit(input.scope_key, remaining)];
  const withholding: DonTaxEscrowRecord[] = [];
  const credits: SpatialAuditEscrowRouteCredit[] = [];
  let landedNetCents = 0;
  if (remaining > 0) {
    landedNetCents = await creditTaxedCascadePayee(
      store,
      input.payee_id,
      `Spatial payee ${input.payee_id}`,
      remaining,
      now,
      glLegs,
      withholding,
    );
    credits.push({
      payee_id: input.payee_id,
      payee_name: `Spatial payee ${input.payee_id}`,
      gross_cents: remaining,
      net_cents: landedNetCents,
      step: "payee_net",
    });
  }

  // The zero-balance tripwire: drawdowns + released + dust === the locked
  // escrow, ALWAYS.
  const companyDustCents = 0;
  if (
    !spatialZeroBalanceHolds(
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
    kind: "spatial_audit_escrow_release",
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
// The CapEx recoupment offset — allowable ride construction and venue
// build-out costs deduct against early-stage IP royalties.
// ---------------------------------------------------------------------------

export type SpatialCapexCommitmentInput = {
  venue_id: string;
  capex_ref: string;
  operator_id: string;
  capex_category: string;
  capex_amount_cents: number;
  currency: string;
  recouped_cents?: number;
};

/**
 * Registers the CapEx commitment of record for one (venue, capex_ref) —
 * the allowable ride construction or venue build-out cost. A
 * re-registration converges (the newest registered cost governs the next
 * walk); the cumulative recouped position rides the append-only
 * applications ledger.
 */
export async function registerSpatialCapexCommitment(
  store: Store,
  input: SpatialCapexCommitmentInput,
): Promise<{ ok: true; value: SpatialCapexCommitmentRecord } | SpatialCommitmentsFailure> {
  if (input.venue_id.trim() === "" || input.capex_ref.trim() === "" || input.operator_id.trim() === "") {
    return {
      ok: false,
      status: 422,
      code: "invalid_scope_identity",
      message: "A CapEx commitment names its venue, ref, and operator of record.",
    };
  }
  if (input.capex_category !== "ride_construction" && input.capex_category !== "venue_buildout") {
    return {
      ok: false,
      status: 422,
      code: "invalid_capex_category",
      message: "A CapEx commitment is a ride_construction or a venue_buildout cost.",
    };
  }
  if (!Number.isInteger(input.capex_amount_cents) || input.capex_amount_cents <= 0) {
    return {
      ok: false,
      status: 422,
      code: "invalid_capex_amount",
      message: "A CapEx commitment prices in whole positive cents.",
    };
  }
  const recouped = input.recouped_cents ?? 0;
  if (!Number.isInteger(recouped) || recouped < 0 || recouped > input.capex_amount_cents) {
    return {
      ok: false,
      status: 422,
      code: "invalid_capex_recouped",
      message: "A CapEx commitment's recouped position is whole non-negative cents within the cost.",
    };
  }
  if (input.currency.trim() === "") {
    return {
      ok: false,
      status: 422,
      code: "invalid_currency",
      message: "A CapEx commitment carries its currency of record.",
    };
  }
  const commitment = await store.upsertSpatialCapexCommitment({
    scope_key: spatialCapexScopeKey(input.venue_id),
    capex_ref: input.capex_ref,
    operator_id: input.operator_id,
    capex_category: input.capex_category,
    capex_amount_cents: input.capex_amount_cents,
    recouped_cents: recouped,
    currency: input.currency,
  });
  return { ok: true, value: commitment };
}

export type SpatialCapexOffsetInput = {
  venue_id: string;
  source_event_id: string;
  /** Which append-only spatial royalty ledger the event's royalty of
   * record lives in — the amount is read FROM that row, never the
   * caller's numbers. */
  royalty_stream: string;
};

export type SpatialCapexOffsetSuccess = {
  ok: true;
  value: {
    /** The executed applications, in OLDEST-FIRST amortization order —
     * the amortization schedule's increments of record. */
    applications: SpatialCapexApplicationRecord[];
    /** The royalty that survives the offset — the IP owner's payout. */
    payout_after_offset_cents: number;
    /** The scope's remaining unrecouped CapEx after the walk. */
    unrecouped_after_cents: number;
  };
};

/**
 * Runs the CapEx recoupment pass for one committed spatial royalty: reads
 * the royalty of record from the named append-only ledger (occupancy,
 * zone, or micro), plans the OLDEST-FIRST walk across the venue scope's
 * unrecouped commitments, and commits each application position-locked.
 * Idempotent BY EVENT: an event whose royalty already offset (any
 * application row exists for the event across the scope's commitments)
 * returns the counted no-op — the replay guard's honest shape.
 */
export async function applySpatialCapexOffset(
  store: Store,
  input: SpatialCapexOffsetInput,
): Promise<SpatialCapexOffsetSuccess | SpatialCommitmentsFailure> {
  if (input.venue_id.trim() === "" || input.source_event_id.trim() === "") {
    return {
      ok: false,
      status: 422,
      code: "invalid_scope_identity",
      message: "A CapEx offset names its venue and source event of record.",
    };
  }
  const stream = input.royalty_stream as SpatialRoyaltyStream;
  if (
    stream !== "occupancy" &&
    stream !== "zone" &&
    stream !== "micro"
  ) {
    return {
      ok: false,
      status: 422,
      code: "invalid_royalty_stream",
      message: "A CapEx offset consumes an occupancy, zone, or micro royalty of record.",
    };
  }
  const scopeKey = spatialCapexScopeKey(input.venue_id);

  // The royalty of record — read from the append-only ledger, never the
  // caller's numbers.
  let royaltyCents: number;
  if (stream === "occupancy") {
    const row: SpatialRoyaltyApplicationRecord | undefined =
      await store.getSpatialRoyaltyApplication(input.source_event_id);
    if (row === undefined) {
      return {
        ok: false,
        status: 404,
        code: "royalty_application_not_found",
        message:
          "No committed occupancy royalty application matches that event — the PR 36 lane commits the royalty before the CapEx offset runs.",
      };
    }
    royaltyCents = row.occupancy_royalty_cents;
  } else if (stream === "zone") {
    const row: SpatialZoneAllocationRecord | undefined =
      await store.getSpatialZoneAllocation(input.source_event_id);
    if (row === undefined) {
      return {
        ok: false,
        status: 404,
        code: "royalty_application_not_found",
        message:
          "No committed zone allocation matches that event — the PR 36 lane commits the allocation before the CapEx offset runs.",
      };
    }
    royaltyCents = row.royalty_cents;
  } else {
    const row: SpatialMicroRoyaltyRecord | undefined =
      await store.getSpatialMicroRoyalty(input.source_event_id);
    if (row === undefined) {
      return {
        ok: false,
        status: 404,
        code: "royalty_application_not_found",
        message:
          "No committed micro royalty matches that event — the PR 36 lane commits the royalty before the CapEx offset runs.",
      };
    }
    royaltyCents = row.royalty_cents;
  }
  if (!Number.isInteger(royaltyCents) || royaltyCents < 0) {
    return {
      ok: false,
      status: 422,
      code: "invalid_royalty_amount",
      message: "The royalty of record carries a non-integer or negative amount — refuse, never clip.",
    };
  }
  if (royaltyCents === 0) {
    // A held-negative-net or zero royalty finds nothing to offset — the
    // honest counted no-op.
    return {
      ok: true,
      value: {
        applications: [],
        payout_after_offset_cents: 0,
        unrecouped_after_cents: (
          await store.listSpatialCapexCommitments(scopeKey)
        ).reduce((total, row) => total + Math.max(0, row.capex_amount_cents - row.recouped_cents), 0),
      },
    };
  }

  // A replayed event is a counted no-op — any application row for this
  // event across the scope's commitments means the pass already ran.
  const commitments = await store.listSpatialCapexCommitments(scopeKey);
  for (const commitment of commitments) {
    const existing = await store.listSpatialCapexApplications(commitment.id);
    if (existing.some((row) => row.source_event_id === input.source_event_id)) {
      return {
        ok: true,
        value: {
          applications: [],
          payout_after_offset_cents: royaltyCents,
          unrecouped_after_cents: commitments.reduce(
            (total, row) => total + Math.max(0, row.capex_amount_cents - row.recouped_cents),
            0,
          ),
        },
      };
    }
  }

  const plan = buildSpatialCapexRecoupmentPlan(commitments, royaltyCents);
  const executed = await commitCapexPlan(store, input.source_event_id, royaltyCents, {
    scopeKey,
    stream,
    steps: plan.applications,
  });
  const appliedTotal = executed.reduce((total, row) => total + row.offset_cents, 0);
  return {
    ok: true,
    value: {
      applications: executed,
      payout_after_offset_cents: royaltyCents - appliedTotal,
      unrecouped_after_cents: plan.unrecouped_after_cents,
    },
  };
}

/**
 * The position-locked commit half of the CapEx walk: each planned
 * application commits in OLDEST-FIRST order with a bounded retry on the
 * position race — a concurrent walk of the same commitment advanced the
 * position, so re-derive from the append-only truth and retry at the
 * fresh position (the licensing recoupment discipline; three attempts,
 * then surface the error — never guess).
 */
async function commitCapexPlan(
  store: Store,
  sourceEventId: string,
  royaltyCents: number,
  context: {
    scopeKey: string;
    stream: SpatialRoyaltyStream;
    steps: readonly SpatialCapexRecoupmentStep[];
  },
): Promise<SpatialCapexApplicationRecord[]> {
  const executed: SpatialCapexApplicationRecord[] = [];
  for (const step of context.steps) {
    const commitment = step.commitment;
    let committed: SpatialCapexApplicationRecord | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const prior = await store.listSpatialCapexApplications(commitment.id);
      const offsetBefore = prior.reduce((total, row) => total + row.offset_cents, 0);
      const offsetNow = Math.min(
        step.offset_cents,
        Math.max(0, commitment.capex_amount_cents - offsetBefore),
      );
      if (offsetNow <= 0) break;
      try {
        committed = await store.insertSpatialCapexApplication({
          commitment_id: commitment.id,
          scope_key: context.scopeKey,
          capex_category: commitment.capex_category,
          source_event_id: sourceEventId,
          royalty_stream: context.stream,
          royalty_cents: royaltyCents,
          offset_before_cents: offsetBefore,
          offset_cents: offsetNow,
          offset_after_cents: offsetBefore + offsetNow,
        });
        break;
      } catch (error) {
        // A replayed (commitment, event) is excluded above, so a unique
        // violation here is the position race: re-derive and retry at the
        // advanced position.
        if (isUniqueViolation(error) && attempt < 2) {
          continue;
        }
        throw error;
      }
    }
    if (committed !== undefined) {
      executed.push(committed);
      // Keep the bookkeeping counter aligned with the truth (heal-only —
      // the applications remain the arbiter).
      await store.upsertSpatialCapexCommitment({
        scope_key: commitment.scope_key,
        capex_ref: commitment.capex_ref,
        operator_id: commitment.operator_id,
        capex_category: commitment.capex_category,
        capex_amount_cents: commitment.capex_amount_cents,
        recouped_cents: committed.offset_after_cents,
        currency: commitment.currency,
      });
      // Keep the local capacity fresh for any subsequent step against the
      // same register.
      commitment.recouped_cents = committed.offset_after_cents;
    }
  }
  return executed;
}

export type SpatialMsgCloseInput = {
  scope_key: string;
  quarter: string;
  closed_by: string;
};

export type SpatialMsgCloseSuccess = {
  ok: true;
  value: {
    close: SpatialMsgTermCloseRecord;
    /** The msg_shortfall_due ledger row when the shortfall priced
     * positive. */
    invoice_ledger: LedgerTransactionRecord | null;
    journal_id: string | null;
    /** True when this call's close had already been recorded (the
     * replay's counted no-op — the recorded close of record returns
     * unchanged). */
    replayed: boolean;
  };
};

/**
 * Closes one quarterly Minimum Spatial Guarantee of record: the once-only
 * close per (commitment, quarter), the scope's earnings derived from the
 * THREE append-only spatial royalty ledgers (the venue's rows in the
 * quarter's months), the guarantee priced floor(footprint × rate / 1e6)
 * from the commitment's reserved-footprint terms, the shortfall =
 * max(0, due − earned), and — on a positive shortfall — the AUTOMATIC
 * invoice debit: the msg_shortfall_due ledger row against the operator
 * of record plus the balanced GL journal. A replayed close converges on
 * the recorded close (the invoice never re-posts, the shortfall never
 * re-prices).
 */
export async function closeSpatialMsgTerm(
  store: Store,
  input: SpatialMsgCloseInput,
  now: Date = new Date(),
): Promise<SpatialMsgCloseSuccess | SpatialCommitmentsFailure> {
  if (!isSpatialMsgQuarter(input.quarter)) {
    return {
      ok: false,
      status: 422,
      code: "invalid_msg_quarter",
      message: "A Minimum Spatial Guarantee quarter of record is YYYY-QN (N ∈ 1..4).",
    };
  }
  if (input.closed_by.trim() === "") {
    return {
      ok: false,
      status: 422,
      code: "invalid_closer_identity",
      message: "A quarter close names the closer of record.",
    };
  }
  // The commitment of record must exist — the close never registers one
  // implicitly (the terms-of-record discipline).
  const commitment: SpatialMsgCommitmentRecord | undefined =
    await store.getSpatialMsgCommitment(input.scope_key);
  if (commitment === undefined) {
    return {
      ok: false,
      status: 404,
      code: "msg_commitment_not_found",
      message:
        "No guarantee of record matches that scope — register the Minimum Spatial Guarantee before closing terms.",
    };
  }

  // The replay check FIRST — a recorded close returns unchanged (the
  // invoice never re-posts, the shortfall never re-prices).
  const existing = await store.getSpatialMsgTermClose(commitment.id, input.quarter);
  if (existing !== undefined) {
    const invoiceLedger =
      existing.invoice_ledger_id !== null
        ? await store.getLedgerTransaction(existing.invoice_ledger_id)
        : null;
    return {
      ok: true,
      value: {
        close: existing,
        invoice_ledger: invoiceLedger ?? null,
        journal_id: null,
        replayed: true,
      },
    };
  }

  // The scope's earnings derive from the append-only royalty truth — the
  // venue's committed rows in the quarter's months, all three streams.
  const months = spatialMsgQuarterMonths(input.quarter);
  const monthSet = new Set(months);
  const [occupancy, zones, micros] = await Promise.all([
    store.listSpatialRoyaltyApplicationsByVenue(commitment.venue_id),
    store.listSpatialZoneAllocationsByVenue(commitment.venue_id),
    store.listSpatialMicroRoyaltiesByVenue(commitment.venue_id),
  ]);
  const earnedAtClose =
    occupancy
      .filter((row) => monthSet.has(row.period))
      .reduce((total, row) => total + row.occupancy_royalty_cents, 0) +
    zones
      .filter((row) => monthSet.has(row.period))
      .reduce((total, row) => total + row.royalty_cents, 0) +
    micros
      .filter((row) => monthSet.has(row.period))
      .reduce((total, row) => total + row.royalty_cents, 0);

  // The guarantee's face — floor(footprint × rate / 1e6), exact integer
  // arithmetic (the reserved-footprint terms of record).
  const msgDue = spatialMsgDueCents(
    commitment.reserved_footprint_sqft,
    commitment.quarterly_rate_micros_per_sqft,
  );
  const shortfall = Math.max(0, msgDue - earnedAtClose);

  let invoiceLedger: LedgerTransactionRecord | null = null;
  let journalId: string | null = null;
  if (shortfall > 0) {
    // THE AUTOMATIC SHORTFALL PENALTY — the invoice of record debits
    // against the operator of record: kind AND status 'msg_shortfall_due',
    // the quarter-close key stamped in line_item_id (the discoverable
    // key), the price exact from the royalty truth (never guessed).
    invoiceLedger = await store.insertLedgerTransaction({
      split_run_id: "",
      line_item_id: `${commitment.id}:${input.quarter}`,
      payee_id: commitment.operator_id,
      payee_name: commitment.operator_name,
      role: "other",
      share_bps: 0,
      amount_cents: shortfall,
      currency: commitment.currency,
      status: "msg_shortfall_due",
      rail: null,
      baas_provider: null,
      baas_transfer_id: null,
      created_at: now.toISOString(),
      settled_at: null,
      kind: "msg_shortfall_due",
    });
    // The GL journal — the operator receivable asset rises, the shortfall
    // penalty income of record rises; balanced legs, no cash movement.
    const posted = await postJournal(store, {
      kind: "spatial_msg_shortfall_invoice",
      ref_type: "spatial_msg_term_close",
      ref_id: `${commitment.id}:${input.quarter}`,
      legs: [
        spatialMsgReceivableDebit(input.scope_key, shortfall),
        spatialMsgShortfallIncomeCredit(input.scope_key, shortfall),
      ],
    });
    if (!posted.ok) {
      return { ok: false, status: 500, code: posted.code, message: posted.message };
    }
    journalId = posted.journal.id;
  }

  const close = await store.upsertSpatialMsgTermClose({
    commitment_id: commitment.id,
    scope_key: commitment.scope_key,
    quarter: input.quarter,
    msg_due_cents: msgDue,
    earned_at_close_cents: earnedAtClose,
    shortfall_cents: shortfall,
    invoice_ledger_id: invoiceLedger?.id ?? null,
    closed_by: input.closed_by,
  });
  return {
    ok: true,
    value: {
      close,
      invoice_ledger: invoiceLedger,
      journal_id: journalId,
      replayed: false,
    },
  };
}
