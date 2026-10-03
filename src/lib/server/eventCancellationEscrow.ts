// The event cancellation escrow (PR 51, the founder sports directive).
//
// A promoter's gate-receipt exposure — a weather delay postponing the
// entire gate, a headline athlete's withdrawal triggering mass refund
// calls, a mandatory ticket refund order clawing back realized receipts —
// is protected the way the resource audit escrow protects a mineral
// owner's exposure, at the founder's ELEVATED sports band: a 15–20% share
// of the scope's net gate receipts locks into an EVENT_CANCELLATION_ESCROW
// per (promoter payee, event) scope (sentinel payee + GL account — its
// own escrow-shaped money, never folded into platform dust, unclaimed
// holding, or any other escrow state), drawn down by weather delays,
// athlete withdrawals, and mandatory ticket refund calls, and released
// only after BOTH facts of record hold: the event's completion telemetry
// verified (the durable sports payout gate state, migration 0055) AND 48
// hours elapsed post-event (the gate state's completion timestamp of
// record) — fail-closed: absent or 'unknown' telemetry refuses, and an
// unelapsed clock refuses.
//
// The money path is the canonical recon posting seam — the resource audit
// escrow's shape 1:1: a gate-receipts payout arrives as a held
// unclaimed-holding credit, this lane consumes exactly ONE held credit
// through the sports payout gate
// (event_completion_telemetry_verified + promoter_insurance_clearance,
// plus the collegiate NIL compliance audit for NIL waterfall payouts,
// resolved from the durable gate states of record — absent and unknown
// BOTH refuse), CAS-settles the held row BEFORE any money moves, splits
// the escrow share floor(amount × bps / 10000), and routes the
// exact-subtraction remainder to the promoter through the SAME
// fail-closed taxed cascade every payout rides. THE INVARIANT: promoter
// remainder + escrow + dust === the held credit, ALWAYS (allocations plus
// dust equals gross INCLUDING the escrow bucket).
//
// Drawdowns and the release commit position-locked before their money
// moves — the ordering is the point. The remaining balance derives from
// the append-only drawdown truth, never a mutable counter. The drawdowns
// are the PROTECTIVE spends — they run without the payout gate (they are
// the mechanism that pays exposures in exactly the scenarios the gate
// would refuse); the release is the PAYOUT — it re-runs the full sports
// payout gate plus the 48-hour clock, fail-closed.

import type { Store } from "@/lib/server/store";
import type { LedgerTransactionRecord } from "@/lib/don/types";
import {
  COMPANY_VARIANCE_PAYEE_ID,
  COMPANY_VARIANCE_PAYEE_NAME,
  EVENT_CANCELLATION_ESCROW_MAX_RATE_BPS,
  EVENT_CANCELLATION_ESCROW_MIN_RATE_BPS,
  EVENT_CANCELLATION_RELEASE_DELAY_HOURS,
  eventCancellationEscrowPayeeId,
  eventCancellationEscrowPayeeName,
} from "@/modules/don/constants";
import {
  SPORTS_EVENT_CANCELLATION_DRAWDOWN_CLASSES,
  eventCancellationEscrowScopeKey,
  type EventCancellationEscrowDrawdownRecord,
  type EventCancellationEscrowPolicyRecord,
  type SportsEventCancellationDrawdownClass,
  type SportsPayoutGateStateRecord,
} from "@/modules/sports/records";
import type {
  TaxEscrowRecord as DonTaxEscrowRecord,
} from "@/modules/don/records";
import {
  evaluatePayoutCompliance,
  resolveCreatorKycStatus,
  resolveSportsVerticalComplianceState,
} from "@/modules/compliance/payoutGate";
import {
  creditTaxedCascadePayee,
} from "@/lib/server/patentLitigationEscrow";
import { postJournal } from "@/modules/ledger/engine";
import {
  eventCancellationEscrowCredit,
  eventCancellationEscrowDebit,
  fboCredit,
  unclaimedHoldingDebit,
  vaultCredit,
  type GlLegInput,
} from "@/modules/ledger/journal";
import { creditVault } from "@/modules/vaults/engine";
import { isUniqueViolation } from "@/lib/server/uniqueViolation";

/** House failure envelope — the audit-escrow shape. */
export type EventCancellationEscrowFailure = {
  ok: false;
  status: number;
  code: string;
  message: string;
};

/**
 * The house zero-balance invariant, scoped to a routing or a release: the
 * sum of the allocations (promoter remainder, escrow bucket, drawdown
 * spends) plus the dust equals the gross it all came from — ALWAYS.
 */
export function eventZeroBalanceHolds(
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
export { eventCancellationEscrowScopeKey };

// ---------------------------------------------------------------------------
// The policy registry — the money terms' ONLY source.
// ---------------------------------------------------------------------------

export type EventCancellationEscrowPolicyInput = {
  /** The promoter payee the escrow protects. */
  promoter_payee_id: string;
  /** The event whose gate receipts the escrow rides. */
  event_ref: string;
  /** The founder-banded share, basis points of the net gate receipts —
   * 1500–2000 (15–20%, the ELEVATED sports band). */
  reserve_rate_bps: number;
};

/**
 * Registers the event cancellation escrow's policy of record for one
 * scope — the rate inside the founder's 15–20% band, enforced at
 * registration AND at use. A re-registration converges (the newest rate
 * governs the next routing) — the option-agreement discipline.
 */
export async function registerEventCancellationEscrowPolicy(
  store: Store,
  input: EventCancellationEscrowPolicyInput,
): Promise<
  { ok: true; value: EventCancellationEscrowPolicyRecord } | EventCancellationEscrowFailure
> {
  if (input.promoter_payee_id.trim() === "" || input.event_ref.trim() === "") {
    return {
      ok: false,
      status: 422,
      code: "invalid_scope_identity",
      message: "An event cancellation-escrow policy names the promoter and event it protects.",
    };
  }
  const scopeKey = eventCancellationEscrowScopeKey(
    input.promoter_payee_id,
    input.event_ref,
  );
  if (
    !Number.isInteger(input.reserve_rate_bps) ||
    input.reserve_rate_bps < EVENT_CANCELLATION_ESCROW_MIN_RATE_BPS ||
    input.reserve_rate_bps > EVENT_CANCELLATION_ESCROW_MAX_RATE_BPS
  ) {
    return {
      ok: false,
      status: 422,
      code: "escrow_rate_out_of_band",
      message: `The event cancellation escrow rate must sit inside the founder band (${EVENT_CANCELLATION_ESCROW_MIN_RATE_BPS}–${EVENT_CANCELLATION_ESCROW_MAX_RATE_BPS} bps — ${EVENT_CANCELLATION_ESCROW_MIN_RATE_BPS / 100}–${EVENT_CANCELLATION_ESCROW_MAX_RATE_BPS / 100}%).`,
    };
  }
  const policy = await store.upsertEventCancellationEscrowPolicy({
    scope_key: scopeKey,
    reserve_rate_bps: input.reserve_rate_bps,
  });
  return { ok: true, value: policy };
}

/**
 * The PURE split plan — the founder-banded escrow share of a net gate
 * receipts payout, computed in exact integer cents. The escrow share
 * floors the rate multiplication (never rounds up: the promoter's routed
 * share is the exact subtraction remainder, so amount = routed + escrow +
 * dust holds with dust structurally zero). Refuses a non-integer or
 * non-positive amount and a rate outside the founder band.
 */
export function buildEventCancellationEscrowSplitPlan(input: {
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
  | EventCancellationEscrowFailure {
  const { amount_cents, reserve_rate_bps } = input;
  if (!Number.isInteger(amount_cents) || amount_cents <= 0) {
    return {
      ok: false,
      status: 422,
      code: "invalid_allocation_amount",
      message: "A net gate receipts payout splits in whole positive cents.",
    };
  }
  if (
    !Number.isInteger(reserve_rate_bps) ||
    reserve_rate_bps < EVENT_CANCELLATION_ESCROW_MIN_RATE_BPS ||
    reserve_rate_bps > EVENT_CANCELLATION_ESCROW_MAX_RATE_BPS
  ) {
    return {
      ok: false,
      status: 422,
      code: "escrow_rate_out_of_band",
      message: `The event cancellation escrow rate must sit inside the founder band (${EVENT_CANCELLATION_ESCROW_MIN_RATE_BPS}–${EVENT_CANCELLATION_ESCROW_MAX_RATE_BPS} bps — ${EVENT_CANCELLATION_ESCROW_MIN_RATE_BPS / 100}–${EVENT_CANCELLATION_ESCROW_MAX_RATE_BPS / 100}%).`,
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

export type EventCancellationEscrowRouteInput = {
  holding_ledger_id: string;
  /** The promoter payee of the gate receipts — the scope's promoter half. */
  promoter_payee_id: string;
  /** The event the receipts ride — the scope's event half. */
  event_ref: string;
  operator_settlement_approved: boolean;
};

export type EventCancellationEscrowRouteCredit = {
  payee_id: string;
  payee_name: string;
  gross_cents: number;
  net_cents: number;
  step: string;
};

export type EventCancellationEscrowRouteSuccess = {
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
    credits: EventCancellationEscrowRouteCredit[];
    withholding: DonTaxEscrowRecord[];
    company_dust_cents: number;
    journal_id: string;
  };
};

/**
 * Routes ONE held gate-receipts payout credit through the event
 * cancellation escrow split: the sports payout gate (fail-closed), the
 * CAS, the founder-banded escrow lock, and the exact-subtraction
 * remainder through the taxed cascade to the promoter. Idempotent BY HELD
 * CREDIT: a replayed routing reads the already-settled row and refuses
 * with the same 409 — never a second split.
 */
export async function routeEventCancellationEscrowFromGateReceipts(
  store: Store,
  input: EventCancellationEscrowRouteInput,
  now: Date = new Date(),
): Promise<EventCancellationEscrowRouteSuccess | EventCancellationEscrowFailure> {
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
  if (input.promoter_payee_id.trim() === "" || input.event_ref.trim() === "") {
    return {
      ok: false,
      status: 422,
      code: "invalid_scope_identity",
      message: "An event cancellation-escrow routing names the promoter and event it protects.",
    };
  }
  const scopeKey = eventCancellationEscrowScopeKey(
    input.promoter_payee_id,
    input.event_ref,
  );

  // The terms of record — the policy (the rate) comes from the registry,
  // never the caller. A scope with no registered policy means the
  // promoter's terms name no escrow: nothing routes (a counted refusal,
  // never a guessed rate).
  const policy: EventCancellationEscrowPolicyRecord | undefined =
    await store.getEventCancellationEscrowPolicy(scopeKey);
  if (policy === undefined) {
    return {
      ok: false,
      status: 422,
      code: "missing_event_cancellation_escrow_policy",
      message: `No event cancellation-escrow policy of record exists for scope "${scopeKey}" — register the promoter's escrow term before routing gate receipts.`,
    };
  }

  // The split — plan BEFORE anything moves (the exact-amount discipline).
  const splitPlanned = buildEventCancellationEscrowSplitPlan({
    amount_cents: row.amount_cents,
    reserve_rate_bps: policy.reserve_rate_bps,
  });
  if (!splitPlanned.ok) return splitPlanned;
  const split = splitPlanned.value;

  // THE SPORTS PAYOUT GATE — the sports lane's compliance state resolves
  // from the durable gate states of record (migration 0055): an ABSENT
  // record resolves null (the gate refuses with vertical_state_unknown)
  // and an 'unknown' state refuses the specific condition
  // (sports_telemetry_unverified / sports_insurance_not_cleared /
  // sports_nil_audit_not_cleared) — fail-closed, before the CAS. Runs for
  // the promoter this routing credits.
  const kycStatus = await resolveCreatorKycStatus(store, input.promoter_payee_id);
  const verticalState = await resolveSportsVerticalComplianceState(
    store,
    input.promoter_payee_id,
    input.event_ref,
  );
  const compliance = evaluatePayoutCompliance({
    operatorSettlementApproved: input.operator_settlement_approved,
    kycStatus,
    verticalState,
    // The LOCK routes pre-event: telemetry cannot be verified for an
    // event that has not completed (the lock is itself the protection).
    // Insurance and the NIL audit still refuse fail-closed; the RELEASE
    // below runs the strict post-event gate.
    sportsGatePhase: "pre_event_lock",
  });
  if (!compliance.ok) {
    return {
      ok: false,
      status: 403,
      code: compliance.code,
      message: `Event cancellation escrow routing refused for promoter "${input.promoter_payee_id}": ${compliance.message}`,
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
  // status 'event_cancellation_escrow', the per-scope sentinel payee
  // (deliberately not 'platform', not the unclaimed-holding sentinel, not
  // any earlier escrow prefix), the scope stamped in line_item_id so the
  // row is discoverable through the existing line-item index and the
  // release can re-derive state from the same registry. A floor of zero
  // on a sub-7-cent payout locks no row — there is nothing to hold and
  // a zero-amount ledger row would be noise.
  const glLegs: GlLegInput[] = [unclaimedHoldingDebit(row.amount_cents)];
  const withholding: DonTaxEscrowRecord[] = [];
  const credits: EventCancellationEscrowRouteCredit[] = [];
  let landedNetCents = 0;
  if (split.routed_cents > 0) {
    landedNetCents = await creditTaxedCascadePayee(
      store,
      input.promoter_payee_id,
      `Event promoter ${input.promoter_payee_id}`,
      split.routed_cents,
      now,
      glLegs,
      withholding,
    );
    credits.push({
      payee_id: input.promoter_payee_id,
      payee_name: `Event promoter ${input.promoter_payee_id}`,
      gross_cents: split.routed_cents,
      net_cents: landedNetCents,
      step: "promoter_net",
    });
  }
  let escrowCredit: LedgerTransactionRecord | null = null;
  if (split.escrow_cents > 0) {
    escrowCredit = await store.insertLedgerTransaction({
      split_run_id: "",
      line_item_id: scopeKey,
      payee_id: eventCancellationEscrowPayeeId(scopeKey),
      payee_name: eventCancellationEscrowPayeeName(scopeKey),
      role: "other",
      share_bps: 0,
      amount_cents: split.escrow_cents,
      currency: row.currency,
      status: "event_cancellation_escrow",
      rail: null,
      baas_provider: null,
      baas_transfer_id: null,
      created_at: now.toISOString(),
      settled_at: null,
      kind: "event_cancellation_escrow",
    });
    glLegs.push(eventCancellationEscrowCredit(scopeKey, split.escrow_cents));
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

  // The zero-balance tripwire: promoter remainder + escrow + dust === the
  // held credit, ALWAYS — the Don invariant (allocations plus dust equals
  // gross) WITH the escrow bucket inside the allocation total.
  if (
    !eventZeroBalanceHolds(
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
        "Promoter remainder + event cancellation escrow + dust !== held credit — routing refused.",
    };
  }

  const posted = await postJournal(store, {
    kind: "event_cancellation_escrow_route",
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
// The drawdown lane — weather delays, athlete withdrawals, and mandatory
// ticket refund calls spend the escrow.
// ---------------------------------------------------------------------------

export type EventCancellationEscrowDrawdownInput = {
  reserve_ledger_id: string;
  scope_key: string;
  drawdown_class: string;
  source_event_id: string;
  drawn_cents: number;
};

export type EventCancellationEscrowDrawdownSuccess = {
  ok: true;
  value: {
    drawdown: EventCancellationEscrowDrawdownRecord;
    replayed: boolean;
    journal_id: string | null;
  };
};

/**
 * Draws the event cancellation escrow down — a weather delay, an athlete
 * withdrawal, or a mandatory ticket refund call spending the escrow's
 * balance. The drawdown row commits position-locked BEFORE the money
 * moves; a drawdown that consumes the LAST cent settles the escrow first
 * (the CAS arbitrates against a concurrent release); money never leaves a
 * settled escrow. Deliberately NOT gated by the sports payout gate — the
 * drawdowns are the protective spends that pay exposures in exactly the
 * scenarios the gate would refuse (a weather delay draws while the
 * event's completion telemetry can never verify).
 */
export async function drawDownEventCancellationEscrow(
  store: Store,
  input: EventCancellationEscrowDrawdownInput,
  now: Date = new Date(),
): Promise<EventCancellationEscrowDrawdownSuccess | EventCancellationEscrowFailure> {
  const row = await store.getLedgerTransaction(input.reserve_ledger_id);
  if (row === undefined) {
    return {
      ok: false,
      status: 404,
      code: "escrow_credit_not_found",
      message: "No ledger transaction matches that id.",
    };
  }
  if (row.kind !== "event_cancellation_escrow") {
    return {
      ok: false,
      status: 422,
      code: "not_an_escrow_credit",
      message: `Ledger transaction ${row.id} is kind "${row.kind}" — only event cancellation-escrow credits draw down here.`,
    };
  }
  if (row.status !== "event_cancellation_escrow") {
    return {
      ok: false,
      status: 409,
      code: "escrow_already_settled",
      message: `Escrow credit ${row.id} is no longer held (status "${row.status}") — nothing draws from a settled escrow.`,
    };
  }
  // The scope cross-check — the caller names the scope; the escrow row's
  // sentinel payee must match it exactly (the terms-of-record discipline).
  if (row.payee_id !== eventCancellationEscrowPayeeId(input.scope_key)) {
    return {
      ok: false,
      status: 422,
      code: "escrow_scope_mismatch",
      message: `Escrow credit ${row.id} belongs to a different scope than "${input.scope_key}".`,
    };
  }
  if (
    !SPORTS_EVENT_CANCELLATION_DRAWDOWN_CLASSES.some((cls) => cls === input.drawdown_class)
  ) {
    return {
      ok: false,
      status: 422,
      code: "invalid_drawdown_class",
      message:
        "An event cancellation escrow drawdown is a weather_delay, an athlete_withdrawal, or a ticket_refund_call.",
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
  // 0055 CHECK's self-contained conservation identity.
  const drawdowns: EventCancellationEscrowDrawdownRecord[] =
    await store.listEventCancellationEscrowDrawdowns(row.id);
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
    const settled = await store.settleEventCancellationEscrow(row.id, instant);
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
  let drawdown: EventCancellationEscrowDrawdownRecord;
  try {
    drawdown = await store.insertEventCancellationEscrowDrawdown({
      reserve_ledger_id: row.id,
      scope_key: input.scope_key,
      drawdown_class: input.drawdown_class as SportsEventCancellationDrawdownClass,
      source_event_id: input.source_event_id,
      drawn_before_cents: drawnBefore,
      drawn_cents: input.drawn_cents,
      remaining_cents: remaining,
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      const all = await store.listEventCancellationEscrowDrawdowns(row.id);
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
    if (rechecked === undefined || rechecked.status !== "event_cancellation_escrow") {
      return {
        ok: false,
        status: 409,
        code: "escrow_already_settled",
        message: `Escrow credit ${row.id} is no longer held — a concurrent release won.`,
      };
    }
  }

  // The drawdown's own journal: the escrow account debits back to FBO
  // cash — the weather delay's, athlete withdrawal's, or refund call's
  // expense, itemized.
  const posted = await postJournal(store, {
    kind: "event_cancellation_escrow_drawdown",
    ref_type: "ledger_transaction",
    ref_id: row.id,
    legs: [
      eventCancellationEscrowDebit(input.scope_key, input.drawn_cents),
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
// The timed release lane — the verified completion telemetry of record
// plus the elapsed 48-hour post-event window.
// ---------------------------------------------------------------------------

export type EventCancellationEscrowReleaseInput = {
  reserve_ledger_id: string;
  /** Must equal the scope the escrow routed under — derived from the
   * promoter + event identity and cross-checked against the
   * sentinel payee. */
  scope_key: string;
  promoter_payee_id: string;
  event_ref: string;
  operator_settlement_approved: boolean;
};

export type EventCancellationEscrowReleaseSuccess = {
  ok: true;
  value: {
    /** The settled escrow row (status 'settled' after this release). */
    escrow_credit: LedgerTransactionRecord;
    released_cents: number;
    credits: EventCancellationEscrowRouteCredit[];
    withholding: DonTaxEscrowRecord[];
    company_dust_cents: number;
    journal_id: string;
  };
};

/**
 * Releases a held event cancellation escrow to the promoter through the
 * taxed cascade — the TIMED, VERIFIED release: the event's completion
 * telemetry must have verified in the durable sports payout gate state of
 * record (fail-closed, before the CAS — no verified telemetry of record,
 * no release) AND 48 hours must have elapsed post-event (the gate state's
 * completion timestamp of record anchors the clock — an unelapsed or
 * unknowable clock refuses), the remaining balance re-derived from the
 * append-only drawdown truth, the sports payout gate re-resolved from the
 * durable gate states of record, the scope cross-checked against the
 * identity pair, the CAS BEFORE any money moves, and the taxed cascade
 * for the actual routing. Drawdowns already spent stay spent — the
 * release pays only what the cancellation exposure protected.
 */
export async function releaseEventCancellationEscrow(
  store: Store,
  input: EventCancellationEscrowReleaseInput,
  now: Date = new Date(),
): Promise<EventCancellationEscrowReleaseSuccess | EventCancellationEscrowFailure> {
  const row = await store.getLedgerTransaction(input.reserve_ledger_id);
  if (row === undefined) {
    return {
      ok: false,
      status: 404,
      code: "escrow_credit_not_found",
      message: "No ledger transaction matches that id.",
    };
  }
  if (row.kind !== "event_cancellation_escrow") {
    return {
      ok: false,
      status: 422,
      code: "not_an_escrow_credit",
      message: `Ledger transaction ${row.id} is kind "${row.kind}" — only event cancellation-escrow credits release here.`,
    };
  }
  if (row.status !== "event_cancellation_escrow") {
    return {
      ok: false,
      status: 409,
      code: "escrow_already_settled",
      message: `Escrow credit ${row.id} is no longer held (status "${row.status}").`,
    };
  }
  // The scope cross-check, twice over: the caller names the scope AND the
  // (promoter, event) identity it releases to — the identity must
  // re-derive the scope exactly (the keys are injective in their identity
  // tuples), and the escrow row's sentinel payee must match it.
  const derivedScope = eventCancellationEscrowScopeKey(
    input.promoter_payee_id,
    input.event_ref,
  );
  if (
    input.promoter_payee_id.trim() === "" ||
    input.event_ref.trim() === "" ||
    derivedScope !== input.scope_key
  ) {
    return {
      ok: false,
      status: 422,
      code: "escrow_scope_mismatch",
      message: "The release's (promoter, event) identity must re-derive the named scope.",
    };
  }
  if (row.payee_id !== eventCancellationEscrowPayeeId(input.scope_key)) {
    return {
      ok: false,
      status: 422,
      code: "escrow_scope_mismatch",
      message: `Escrow credit ${row.id} belongs to a different scope than "${input.scope_key}".`,
    };
  }

  // THE TIMED, VERIFIED GATE — the sports payout gate state of record,
  // read FAIL-CLOSED before the CAS: an absent record (no state of
  // record) refuses, an 'unknown' telemetry state refuses, and a verified
  // telemetry state whose completion timestamp sits fewer than 48 hours
  // in the past refuses. The clock anchors to the completion timestamp of
  // record — the same record the telemetry verification set.
  const gateState: SportsPayoutGateStateRecord | undefined =
    await store.getSportsPayoutGateState(input.promoter_payee_id, input.event_ref);
  if (gateState === undefined || gateState.event_completion_telemetry_state !== "verified") {
    return {
      ok: false,
      status: 403,
      code: "event_completion_telemetry_unverified",
      message:
        "No verified event completion telemetry of record exists for this escrow — the completion telemetry must verify before the escrow releases.",
    };
  }
  if (gateState.event_completed_at === null) {
    return {
      ok: false,
      status: 403,
      code: "event_completion_time_unknown",
      message:
        "The verified completion telemetry carries no completion timestamp of record — the 48-hour post-event window cannot be established. Refusing, never guessing.",
    };
  }
  const completedAtMs = Date.parse(gateState.event_completed_at);
  if (Number.isNaN(completedAtMs)) {
    return {
      ok: false,
      status: 403,
      code: "event_completion_time_unknown",
      message: `The completion timestamp of record "${gateState.event_completed_at}" does not parse — the 48-hour post-event window cannot be established.`,
    };
  }
  const releaseOpensAtMs =
    completedAtMs + EVENT_CANCELLATION_RELEASE_DELAY_HOURS * 60 * 60 * 1000;
  if (now.getTime() < releaseOpensAtMs) {
    return {
      ok: false,
      status: 403,
      code: "event_cancellation_release_window_open",
      message: `The 48-hour post-event window has not elapsed — the release opens at ${new Date(releaseOpensAtMs).toISOString()}.`,
    };
  }

  // The policy of record must still exist (the terms never vanish).
  const policy: EventCancellationEscrowPolicyRecord | undefined =
    await store.getEventCancellationEscrowPolicy(input.scope_key);
  if (policy === undefined) {
    return {
      ok: false,
      status: 422,
      code: "missing_event_cancellation_escrow_policy",
      message: `No event cancellation-escrow policy of record exists for scope "${input.scope_key}".`,
    };
  }

  // The remaining balance derives from the append-only drawdown truth.
  const drawdowns: EventCancellationEscrowDrawdownRecord[] =
    await store.listEventCancellationEscrowDrawdowns(row.id);
  const drawnBefore = drawdowns.reduce((total, line) => total + line.drawn_cents, 0);
  const remaining = row.amount_cents - drawnBefore;
  if (remaining <= 0) {
    return {
      ok: false,
      status: 422,
      code: "escrow_fully_drawn",
      message:
        "The escrow is fully drawn — weather delays, athlete withdrawals, and ticket refund calls spent every cent of it.",
    };
  }

  // The gate family — the sports lane's full compliance state re-resolves
  // from the durable gate states of record: fail-closed at release too
  // (insurance clearance and a collegiate NIL audit refusal both stop the
  // release), an absent record refuses.
  const kycStatus = await resolveCreatorKycStatus(store, input.promoter_payee_id);
  const verticalState = await resolveSportsVerticalComplianceState(
    store,
    input.promoter_payee_id,
    input.event_ref,
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
      message: `Event cancellation escrow release refused for promoter "${input.promoter_payee_id}": ${compliance.message}`,
    };
  }

  // The CAS wins BEFORE any money moves: the concurrent release or
  // full-drawdown loser reads undefined here and refuses.
  const instant = now.toISOString();
  const settled = await store.settleEventCancellationEscrow(row.id, instant);
  if (settled === undefined) {
    return {
      ok: false,
      status: 409,
      code: "escrow_already_settled",
      message: `Escrow credit ${row.id} is no longer held — a concurrent release or drawdown won.`,
    };
  }

  // The taxed cascade routes the remaining balance to the promoter —
  // the same fail-closed family every payout rides. The journal opens
  // with the escrow account's debit leg (the escrow pays out); the
  // cascade appends its own credits.
  const glLegs: GlLegInput[] = [eventCancellationEscrowDebit(input.scope_key, remaining)];
  const withholding: DonTaxEscrowRecord[] = [];
  const credits: EventCancellationEscrowRouteCredit[] = [];
  let landedNetCents = 0;
  if (remaining > 0) {
    landedNetCents = await creditTaxedCascadePayee(
      store,
      input.promoter_payee_id,
      `Event promoter ${input.promoter_payee_id}`,
      remaining,
      now,
      glLegs,
      withholding,
    );
    credits.push({
      payee_id: input.promoter_payee_id,
      payee_name: `Event promoter ${input.promoter_payee_id}`,
      gross_cents: remaining,
      net_cents: landedNetCents,
      step: "promoter_net",
    });
  }

  // The zero-balance tripwire: drawdowns + released + dust === the locked
  // escrow, ALWAYS.
  const companyDustCents = 0;
  if (
    !eventZeroBalanceHolds(
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
    kind: "event_cancellation_escrow_release",
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
