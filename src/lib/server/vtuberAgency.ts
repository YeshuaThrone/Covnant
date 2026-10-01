// VTuber agency licensing holdback — PR 15 (founder VTuber directive).
//
// Money earned by managed VTuber talent LOCKS in
// AVATAR_IP_LICENSING_HOLDBACK: ledger rows with kind and status
// 'avatar_ip_licensing_holdback' that stay out of every payee vault, out of
// the talent split, and out of the unclaimed holding bucket, until the
// verified release runs the agency deduction stack. The holdback is
// PER-AGENCY (payee `vtuber_holdback:{agencyId}`, GL account
// `avatar_ip_licensing_holdback:{agencyId}` — the film escrow's convention
// of carrying the business key in the account string) because the agency
// contract, the deduction stack, and the amortization schedules are all
// per-agency program. Managed talent income must never be mistaken for
// unallocated recon revenue or settle through a creator's holding path.
//
// NO MIGRATION for the LEDGER state — ledger_transactions.status/kind are
// free text columns (migration 0006 places no check constraint on either),
// so the state extends the existing ledger contract in place — the film
// escrow (PR 9), gaming cashout (PR 13), and esports escrow (PR 14)
// precedent. The DURABLE verification and amortization state ships in
// migration 0020 (vtuber_tax_withholding_verifications,
// vtuber_tech_setup_amortization_schedules + _lines). The release's CAS
// lives in the store's settleAvatarIpHoldback (three backends).
//
// THE TWO MOVES:
//
//   postToAvatarIpHoldback — a managed talent's income receipt arrives (the
//                 recon worker posts each statement line here; manual posts
//                 are the esports escrow's precedent): integer-cent credit
//                 into the agency's holdback account, replay-guarded per
//                 source (journal per source id, 409 on re-post), balanced
//                 vtuber_holdback_post journal (FBO debit leg). Nothing
//                 moves after this until the verified release — the
//                 holdback lock is the point.
//
//   releaseVtuberAgencyDeductions — the verified release. Fail-closed
//                 gates, in order: the row must be a LOCKED holdback
//                 receipt (404/422/409 otherwise), the deduction contract
//                 must validate and the plan must build
//                 (buildVtuberAgencyDeductionPlan — the sequential
//                 integer-cent stack: agency management (the 20–40% band),
//                 3D model rigging holdback, avatar IP licensing holdback,
//                 tech setup amortization line, then the talent split),
//                 every credited party must pass the SAME fail-closed
//                 payout compliance gate as a Lithic dispatch (operator
//                 settlement approval, verified KYC, and the LIVESTREAM
//                 vertical's state — reconciled stream payouts and the
//                 tax_withholding_verified read this PR backs with durable
//                 state in migration 0020), and the CAS flip must win (the
//                 concurrent loser gets undefined and a 409). THEN the
//                 routing in the founder's mandated order — the deduction
//                 stack applied BEFORE net income releases to the talent:
//                 management fee, rigging holdback, licensing holdback, the
//                 amortization line (each riding the recoupment-sweep
//                 credit discipline), the talent split (floor shares,
//                 withholding on creator roles), and any integer-cent dust
//                 swept to the platform payee. Insert-as-lock ordering: the
//                 CAS flips BEFORE any vault credit, so a crash mid-release
//                 fails toward "nothing moved twice".

import type { Store } from "@/lib/server/store";
import type { LedgerTransactionRecord, PayeeRole } from "@/lib/don/types";
import {
  COMPANY_VARIANCE_PAYEE_ID,
  COMPANY_VARIANCE_PAYEE_NAME,
  VTUBER_HOLDBACK_PAYEE_PREFIX,
  VTUBER_MANAGEMENT_FEE_MAX_BPS,
  VTUBER_MANAGEMENT_FEE_MIN_BPS,
  vtuberHoldbackPayeeId,
  vtuberHoldbackPayeeName,
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
  fboDebit,
  vaultCredit,
  vtuberHoldbackCredit,
  vtuberHoldbackDebit,
  type GlLegInput,
} from "@/modules/ledger/journal";
import type {
  CompanyDustRecord,
  TaxEscrowRecord,
  VtuberTechSetupAmortizationScheduleRecord,
} from "@/modules/don/records";
import { creditVault } from "@/modules/vaults/engine";
import { isIncomingFrozen } from "@/modules/vaults/dispute";

/** House failure envelope — the esports escrow / film escrow shape. */
export type VtuberAgencyHoldbackFailure = {
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
export type VtuberHoldbackReceiptSource =
  | { type: "match_queue"; event_id: string }
  | { type: "recon_job"; job_id: string }
  | { type: "manual"; note: string };

export interface VtuberAgencyHoldbackPostInput {
  /** The agency program the receipt funds — the holdback and stack key. */
  agency: string;
  /** The managed talent's income receipt, integer cents. */
  amount_cents: number;
  currency: string;
  source: VtuberHoldbackReceiptSource;
}

export type VtuberAgencyHoldbackPostSuccess = {
  ok: true;
  value: {
    /** The locked receipt — kind and status both 'avatar_ip_licensing_holdback'. */
    holdback_credit: LedgerTransactionRecord;
    journal_id: string;
  };
};

/**
 * Recovers the agency id from a holdback row's per-agency payee id.
 */
export function agencyIdFromHoldbackPayeeId(payeeId: string): string | undefined {
  const prefix = `${VTUBER_HOLDBACK_PAYEE_PREFIX}:`;
  return payeeId.startsWith(prefix) ? payeeId.slice(prefix.length) : undefined;
}

/**
 * Locks one managed talent's income receipt into the agency's holdback. The
 * money's GL leg is an FBO debit (cash arrived) against a credit on the
 * agency's holdback account — no vault is minted, no dust ledger row is
 * written, no payee is credited, and no talent share moves.
 */
export async function postToAvatarIpHoldback(
  store: Store,
  input: VtuberAgencyHoldbackPostInput,
  now: Date = new Date(),
): Promise<VtuberAgencyHoldbackPostSuccess | VtuberAgencyHoldbackFailure> {
  if (input.agency.trim() === "") {
    return {
      ok: false,
      status: 422,
      code: "invalid_holdback_agency",
      message: "A VTuber agency holdback receipt names its agency.",
    };
  }
  // Integer cents, the house invariant — a float amount is refused, never rounded.
  if (!Number.isSafeInteger(input.amount_cents) || input.amount_cents <= 0) {
    return {
      ok: false,
      status: 422,
      code: "invalid_amount",
      message: "VTuber agency holdback receipts post integer cents greater than zero.",
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
        code: "vtuber_holdback_receipt_already_posted",
        message: `A VTuber agency holdback receipt for ${refType} "${sourceRefId}" was already posted (${prior.length} journal(s) ref it).`,
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
    payee_id: vtuberHoldbackPayeeId(input.agency),
    payee_name: vtuberHoldbackPayeeName(input.agency),
    role: "other",
    share_bps: 0,
    amount_cents: input.amount_cents,
    currency: input.currency,
    status: "avatar_ip_licensing_holdback",
    rail: null,
    baas_provider: null,
    baas_transfer_id: null,
    created_at: createdAt,
    settled_at: null,
    kind: "avatar_ip_licensing_holdback",
  });

  const posted = await postJournal(
    store,
    {
      kind: "vtuber_holdback_post",
      ref_type: refType,
      ref_id: sourceRefId === "" ? credit.id : sourceRefId,
      legs: [
        fboDebit(input.amount_cents),
        vtuberHoldbackCredit(input.agency, input.amount_cents),
      ],
    },
    now,
  );
  if (!posted.ok) {
    return { ok: false, status: 500, code: posted.code, message: posted.message };
  }
  return {
    ok: true,
    value: { holdback_credit: credit, journal_id: posted.journal.id },
  };
}

// ---------------------------------------------------------------------------
// The deduction stack — pure, integer-cent, validated fail-closed.
// ---------------------------------------------------------------------------

/** One talent share at release — the allocator's contract input. */
export interface VtuberTalentShareInput {
  payeeId: string;
  payeeName: string;
  role: PayeeRole;
  /** Share of the POST-DEDUCTION talent pool, whole basis points. */
  shareBps: number;
}

export interface VtuberAgencyStackInput {
  /** The locked receipt's gross, integer cents. */
  grossCents: number;
  agencyPayeeId: string;
  /** The agency management fee, whole basis points — the 20–40% band. */
  managementFeeBps: number;
  /** The 3D model rigging holdback deduction, integer cents (0 = none). */
  riggingHoldbackCents: number;
  /** The avatar IP licensing holdback deduction, integer cents (0 = none). */
  licensingHoldbackCents: number;
  /**
   * The tech setup amortization candidate — the schedule's deterministic
   * line for the next period, integer cents (0 = no schedule attached).
   * Capped at what remains at stack time; the shortfall is reported, never
   * hidden.
   */
  techSetupAmortizationCents: number;
  /** The talent split — bps of the post-deduction pool, summing to 10000. */
  talentShares: readonly VtuberTalentShareInput[];
}

export type VtuberAgencyDeductionPlan = {
  grossCents: number;
  /** The agency management deduction (the 20–40% band). */
  managementFeeCents: number;
  /** The rigging holdback deduction as applied (capped at what remained). */
  riggingHoldbackCents: number;
  /** The licensing holdback deduction as applied (capped at what remained). */
  licensingHoldbackCents: number;
  /** The amortization line as applied (capped at what remained). */
  techSetupAmortizationCents: number;
  /** The mandated amortization this pool could not cover — reported, never hidden. */
  techSetupUnamortizedCents: number;
  talentPoolCents: number;
  talentAllocations: ReadonlyArray<{
    payeeId: string;
    payeeName: string;
    role: PayeeRole;
    shareBps: number;
    amountCents: number;
  }>;
  companyDustCents: number;
};

export type VtuberAgencyDeductionPlanFailure = {
  ok: false;
  code: string;
  message: string;
};

export type VtuberAgencyDeductionPlanSuccess = {
  ok: true;
  plan: VtuberAgencyDeductionPlan;
};

function fail(code: string, message: string): VtuberAgencyDeductionPlanFailure {
  return { ok: false, code, message };
}

function isNonNegativeInt(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Creator-role talent rides W-2-shaped withholding — the same rule the film
 * escrow and esports waterfall apply to creator/playing roles.
 */
export function isWithholdableTalentRole(role: PayeeRole): boolean {
  return role === "creator";
}

/**
 * THE allocator: validates the deduction contract and computes every step
 * in exact integer cents. Sequential order is the founder's mandated
 * order — the deductions come off the top, net income releases to talent —
 * so each step is computed from what the previous steps left:
 *
 *   1. agency management fee: floor bps of the gross (the 20–40% band)
 *   2. 3D model rigging holdback (capped at what remains)
 *   3. avatar IP licensing holdback (capped at what remains)
 *   4. tech setup amortization line (capped at what remains; shortfall
 *      reported as techSetupUnamortizedCents — the esports escrow's honest
 *      shortfall carry)
 *   5. the talent split: floor shares of the remaining pool, the sub-cent
 *      dust swept to the company variance account
 *
 * Invariant: every step + the talent allocations + the dust === the gross,
 * ALWAYS — every bucket, held or routed, is in the equation.
 */
export function buildVtuberAgencyDeductionPlan(
  input: VtuberAgencyStackInput,
): VtuberAgencyDeductionPlanFailure | VtuberAgencyDeductionPlanSuccess {
  if (!isNonNegativeInt(input.grossCents) || input.grossCents <= 0) {
    return fail("invalid_holdback_gross", "The holdback gross posts integer cents greater than zero.");
  }
  if (input.agencyPayeeId.trim() === "") {
    return fail("invalid_agency_payee", "The deduction stack names the agency payee the deductions route to.");
  }
  if (
    !Number.isSafeInteger(input.managementFeeBps) ||
    input.managementFeeBps < VTUBER_MANAGEMENT_FEE_MIN_BPS ||
    input.managementFeeBps > VTUBER_MANAGEMENT_FEE_MAX_BPS
  ) {
    return fail(
      "invalid_management_fee_bps",
      `The agency management fee must sit in the ${VTUBER_MANAGEMENT_FEE_MIN_BPS}-${VTUBER_MANAGEMENT_FEE_MAX_BPS} bps band (20–40%) — got ${input.managementFeeBps}.`,
    );
  }
  if (
    !isNonNegativeInt(input.riggingHoldbackCents) ||
    !isNonNegativeInt(input.licensingHoldbackCents) ||
    !isNonNegativeInt(input.techSetupAmortizationCents)
  ) {
    return fail(
      "invalid_deduction_amount",
      "Holdback deductions and the amortization candidate post non-negative integer cents.",
    );
  }
  if (input.talentShares.length === 0) {
    return fail(
      "invalid_talent_shares_empty",
      "The talent split names at least one share — a holdback with no talent is unrouteable.",
    );
  }
  const seenPayees = new Set<string>();
  let shareSum = 0;
  for (const share of input.talentShares) {
    if (share.payeeId.trim() === "") {
      return fail("invalid_talent_share", "Every talent share names its payee.");
    }
    if (seenPayees.has(share.payeeId)) {
      return fail(
        "invalid_talent_duplicate_payee",
        `Payee "${share.payeeId}" appears more than once in the talent split — one share per payee.`,
      );
    }
    seenPayees.add(share.payeeId);
    if (!isNonNegativeInt(share.shareBps) || share.shareBps <= 0) {
      return fail(
        "invalid_talent_share_bps",
        `Talent payee "${share.payeeId}" carries share ${share.shareBps} bps — a listed share is a positive integer.`,
      );
    }
    shareSum += share.shareBps;
  }
  if (shareSum !== 10000) {
    return fail(
      "invalid_talent_share_sum",
      `Talent shares sum to ${shareSum} bps — they must sum to EXACTLY 10000 (100.0000%).`,
    );
  }

  // Step 1 — the agency management fee: floor bps of the gross.
  const managementFeeCents = Math.floor((input.grossCents * input.managementFeeBps) / 10000);
  let remaining = input.grossCents - managementFeeCents;

  // Step 2 — the 3D model rigging holdback (capped at what remains).
  const riggingHoldbackCents = Math.min(input.riggingHoldbackCents, remaining);
  remaining -= riggingHoldbackCents;

  // Step 3 — the avatar IP licensing holdback (capped at what remains).
  const licensingHoldbackCents = Math.min(input.licensingHoldbackCents, remaining);
  remaining -= licensingHoldbackCents;

  // Step 4 — the tech setup amortization line (capped at what remains; the
  // shortfall is reported, never hidden — never invented money).
  const techSetupAmortizationCents = Math.min(input.techSetupAmortizationCents, remaining);
  const techSetupUnamortizedCents = input.techSetupAmortizationCents - techSetupAmortizationCents;
  remaining -= techSetupAmortizationCents;

  // Step 5 — the talent split: floor shares of the post-deduction pool,
  // the sub-cent dust swept to the company variance account.
  const talentPoolCents = remaining;
  const talentAllocations = input.talentShares.map((share) => ({
    payeeId: share.payeeId,
    payeeName: share.payeeName,
    role: share.role,
    shareBps: share.shareBps,
    amountCents: Math.floor((talentPoolCents * share.shareBps) / 10000),
  }));
  const allocated = talentAllocations.reduce((total, a) => total + a.amountCents, 0);
  const companyDustCents = talentPoolCents - allocated;

  return {
    ok: true,
    plan: {
      grossCents: input.grossCents,
      managementFeeCents,
      riggingHoldbackCents,
      licensingHoldbackCents,
      techSetupAmortizationCents,
      techSetupUnamortizedCents,
      talentPoolCents,
      talentAllocations,
      companyDustCents,
    },
  };
}

// ---------------------------------------------------------------------------
// Tech setup amortization — deterministic integer-cent line math.
// ---------------------------------------------------------------------------

/**
 * One schedule line's deterministic integer-cent deduction:
 * floor(total/periods) per line, the LAST line absorbing the integer-cent
 * remainder. Sum of all lines === the total cost exactly — the conservation
 * is in the math, not in a mutable counter.
 */
export function buildTechSetupAmortizationLine(
  totalCostCents: number,
  amortizationPeriods: number,
  lineIndex: number,
): number {
  const base = Math.floor(totalCostCents / amortizationPeriods);
  return lineIndex < amortizationPeriods - 1 ? base : totalCostCents - base * (amortizationPeriods - 1);
}

export type VtuberAmortizationConsumption = {
  line_index: number;
  /** The schedule's deterministic line for the period (the ceiling). */
  computed_cents: number;
  /** What the release actually deducted (the capped application). */
  applied_cents: number;
};

async function consumeNextAmortizationLine(
  store: Store,
  scheduleRef: string,
  capCents: number,
  deductedAt: string,
): Promise<
  | { ok: true; consumption: VtuberAmortizationConsumption }
  | { ok: false; code: "tech_setup_amortization_schedule_completed" }
> {
  // The insert-as-lock consume arbiter (the PR 12 accumulator discipline):
  // the line's index is derived from the append-only lines list, and the
  // UNIQUE (schedule_ref, line_index) index — not a mutable counter — is
  // what a concurrent consume loses on. A concurrent consumer of the SAME
  // schedule throws the unique violation; re-derive the next index and
  // retry. Two releases of two receipts of the same agency consume
  // distinct lines; the loser of a line index never loses its money.
  // Bounded: the schedule has finitely many periods.
  for (;;) {
    const schedule = await store.getVtuberTechSetupAmortizationScheduleByRef(scheduleRef);
    if (schedule === undefined) {
      // Unreachable in the release path (the schedule is checked before the
      // CAS) — the typed refusal keeps the helper honest for any caller.
      return { ok: false, code: "tech_setup_amortization_schedule_completed" };
    }
    const lines = await store.listVtuberTechSetupAmortizationLines(scheduleRef);
    const lineIndex = lines.length;
    if (lineIndex >= schedule.amortization_periods) {
      return { ok: false, code: "tech_setup_amortization_schedule_completed" };
    }
    const computedCents = buildTechSetupAmortizationLine(
      schedule.total_cost_cents,
      schedule.amortization_periods,
      lineIndex,
    );
    const appliedCents = Math.min(computedCents, capCents);
    try {
      await store.insertVtuberTechSetupAmortizationLine({
        schedule_ref: scheduleRef,
        line_index: lineIndex,
        line_cents: appliedCents,
        deducted_at: deductedAt,
        created_at: deductedAt,
      });
      return {
        ok: true,
        consumption: {
          line_index: lineIndex,
          computed_cents: computedCents,
          applied_cents: appliedCents,
        },
      };
    } catch {
      // Lost the line to a concurrent consume — re-derive and retry.
    }
  }
}

// ---------------------------------------------------------------------------
// The verified release.
// ---------------------------------------------------------------------------

/** One talent share at release — same contract the allocator validates. */
export type VtuberTalentShare = VtuberTalentShareInput;

export interface VtuberAgencyReleaseInput {
  /** The locked receipt to release (the ledger row id). */
  holdback_ledger_id: string;
  agencyPayeeId: string;
  agencyPayeeName: string;
  /** The agency management fee, whole basis points — the 20–40% band. */
  managementFeeBps: number;
  /** The 3D model rigging holdback deduction, integer cents (0 = none). */
  riggingHoldbackCents: number;
  /** Required when riggingHoldbackCents > 0 — the contract of record. */
  riggingContractRef: string;
  /** The avatar IP licensing holdback deduction, integer cents (0 = none). */
  licensingHoldbackCents: number;
  /** Required when licensingHoldbackCents > 0 — the license verification of record. */
  licenseVerificationRef: string;
  /** The tech setup amortization schedule consumed this release; null = none. */
  techSetupAmortizationScheduleRef: string | null;
  /** The talent split — bps of the post-deduction pool, summing to 10000. */
  talentShares: readonly VtuberTalentShare[];
  /** The clearance gate's first condition — fail-closed on anything but true. */
  operator_settlement_approved: boolean;
}

export type VtuberAgencyReleaseSuccess = {
  ok: true;
  value: {
    /** The released row — status 'settled', kind still 'avatar_ip_licensing_holdback'. */
    holdback_credit: LedgerTransactionRecord;
    /** The deduction stack as posted — every step's integer-cent outcome. */
    plan: VtuberAgencyDeductionPlan;
    /** Per-talent outcome; net_cents is post-withholding. */
    talent_credits: Array<{
      payee_id: string;
      payee_name: string;
      role: PayeeRole;
      gross_cents: number;
      net_cents: number;
    }>;
    company_dust_cents: number;
    dust_ledger: CompanyDustRecord[];
    /** The amortization line this release consumed, when a schedule rode. */
    tech_setup_amortization: VtuberAmortizationConsumption | null;
    /** The withholding escrow rows the talent credits wrote. */
    withholding: TaxEscrowRecord[];
    journal_id: string;
  };
};

/**
 * Releases one locked holdback receipt through the agency deduction stack —
 * ONLY after the deduction contract validates, every credited party passes
 * the fail-closed payout compliance gate, and the CAS flip has won BEFORE
 * any money moves.
 */
export async function releaseVtuberAgencyDeductions(
  store: Store,
  input: VtuberAgencyReleaseInput,
  now: Date = new Date(),
): Promise<VtuberAgencyReleaseSuccess | VtuberAgencyHoldbackFailure> {
  const row = await store.getLedgerTransaction(input.holdback_ledger_id);
  if (row === undefined) {
    return {
      ok: false,
      status: 404,
      code: "holdback_receipt_not_found",
      message: "No ledger transaction matches that id.",
    };
  }
  if (row.kind !== "avatar_ip_licensing_holdback") {
    return {
      ok: false,
      status: 422,
      code: "not_a_vtuber_holdback_receipt",
      message: `Ledger transaction ${row.id} is kind "${row.kind}" — only VTuber agency holdback receipts release here.`,
    };
  }
  if (row.status !== "avatar_ip_licensing_holdback") {
    return {
      ok: false,
      status: 409,
      code: "holdback_already_released",
      message: `Holdback receipt ${row.id} is no longer locked (status "${row.status}").`,
    };
  }
  const agency = agencyIdFromHoldbackPayeeId(row.payee_id);
  if (agency === undefined) {
    return {
      ok: false,
      status: 500,
      code: "holdback_payee_corrupted",
      message: `Holdback receipt ${row.id} carries payee "${row.payee_id}" — not a VTuber agency holdback payee.`,
    };
  }

  // Deduction provenance is fail-closed: a rigging holdback without its
  // contract of record and a licensing holdback without its license
  // verification are refused before anything is planned or gated.
  if (input.riggingHoldbackCents > 0 && input.riggingContractRef.trim() === "") {
    return {
      ok: false,
      status: 422,
      code: "missing_rigging_contract_ref",
      message: "A rigging holdback deduction names its 3D model rigging contract of record.",
    };
  }
  if (input.licensingHoldbackCents > 0 && input.licenseVerificationRef.trim() === "") {
    return {
      ok: false,
      status: 422,
      code: "missing_license_verification_ref",
      message: "An avatar IP licensing holdback deduction names its license verification of record.",
    };
  }

  // The amortization candidate — the schedule's deterministic line for the
  // next period — is resolved BEFORE the gates so a missing or completed
  // schedule refuses without taking the CAS lock. The applied amount is
  // capped by the stack (the plan's honest shortfall carry).
  let amortizationCandidateCents = 0;
  let amortizationSchedule: VtuberTechSetupAmortizationScheduleRecord | undefined = undefined;
  if (input.techSetupAmortizationScheduleRef !== null) {
    amortizationSchedule = await store.getVtuberTechSetupAmortizationScheduleByRef(
      input.techSetupAmortizationScheduleRef,
    );
    if (amortizationSchedule === undefined) {
      return {
        ok: false,
        status: 422,
        code: "tech_setup_amortization_schedule_not_found",
        message: `No tech setup amortization schedule matches "${input.techSetupAmortizationScheduleRef}".`,
      };
    }
    const lines = await store.listVtuberTechSetupAmortizationLines(
      input.techSetupAmortizationScheduleRef,
    );
    if (lines.length >= amortizationSchedule.amortization_periods) {
      return {
        ok: false,
        status: 409,
        code: "tech_setup_amortization_schedule_completed",
        message: `Amortization schedule "${input.techSetupAmortizationScheduleRef}" has consumed every period.`,
      };
    }
    amortizationCandidateCents = buildTechSetupAmortizationLine(
      amortizationSchedule.total_cost_cents,
      amortizationSchedule.amortization_periods,
      lines.length,
    );
  }

  // THE allocator: validates the contract and computes every step in exact
  // integer cents BEFORE any gate or ledger write — a refused plan moves
  // nothing and reports why.
  const planned = buildVtuberAgencyDeductionPlan({
    grossCents: row.amount_cents,
    agencyPayeeId: input.agencyPayeeId,
    managementFeeBps: input.managementFeeBps,
    riggingHoldbackCents: input.riggingHoldbackCents,
    licensingHoldbackCents: input.licensingHoldbackCents,
    techSetupAmortizationCents: amortizationCandidateCents,
    talentShares: input.talentShares,
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

  // The clearance gate — the agency and every talent share ride the SAME
  // fail-closed payout compliance gate as a Lithic dispatch, on the
  // LIVESTREAM vertical (reconciled stream payouts + the
  // tax_withholding_verified read — backed by the durable verification
  // state of migration 0020 through the payoutGate seam). The platform
  // house payee holds no KYC record by design and is skipped.
  const verticalStateSource = getVerticalComplianceStateSource();
  const gatedParties: Array<{ payee_id: string; payee_name: string }> = [
    { payee_id: input.agencyPayeeId, payee_name: input.agencyPayeeName },
    ...plan.talentAllocations.map((allocation) => ({
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
        message: `VTuber agency deduction release refused for payee "${party.payee_id}": ${compliance.message}`,
      };
    }
  }

  // The CAS wins BEFORE any money moves (insert-as-lock): the concurrent
  // release loser reads undefined here and refuses with the same 409 a
  // replayed release gets. The settled row with no vtuber_holdback_release
  // journal is the visible alarm.
  const settled = await store.settleAvatarIpHoldback(row.id, now.toISOString());
  if (settled === undefined) {
    return {
      ok: false,
      status: 409,
      code: "holdback_already_released",
      message: `Holdback receipt ${row.id} is no longer locked — a concurrent release won.`,
    };
  }

  // The amortization line consumes AFTER the CAS win (a gate refusal or a
  // lost CAS must never consume a schedule line). A concurrent release of
  // another receipt on the same agency schedule may have advanced the
  // lines between the pre-CAS read and here — the arbiter loop derives the
  // line that THIS release actually consumes.
  let amortization: VtuberAmortizationConsumption | null = null;
  if (amortizationSchedule !== undefined && input.techSetupAmortizationScheduleRef !== null) {
    // The cap is what the stack left AFTER the other deductions — the
    // remaining pool before the amortization step, per the plan.
    const capCents =
      plan.talentPoolCents + plan.techSetupAmortizationCents;
    const consumed = await consumeNextAmortizationLine(
      store,
      input.techSetupAmortizationScheduleRef,
      capCents,
      now.toISOString(),
    );
    if (!consumed.ok) {
      return {
        ok: false,
        status: 500,
        code: "tech_setup_amortization_schedule_completed",
        message: `Amortization schedule "${input.techSetupAmortizationScheduleRef}" completed mid-release — the receipt is settled but nothing routed; re-run the release.`,
      };
    }
    amortization = consumed.consumption;
    if (amortization.applied_cents !== plan.techSetupAmortizationCents) {
      // The concurrent line advanced the schedule — rebuild the plan from
      // the line THIS release actually consumed, so routing matches the
      // consumed cents exactly (the tripwire below enforces it).
      const replanned = buildVtuberAgencyDeductionPlan({
        grossCents: row.amount_cents,
        agencyPayeeId: input.agencyPayeeId,
        managementFeeBps: input.managementFeeBps,
        riggingHoldbackCents: input.riggingHoldbackCents,
        licensingHoldbackCents: input.licensingHoldbackCents,
        techSetupAmortizationCents: amortization.computed_cents,
        talentShares: input.talentShares,
      });
      if (!replanned.ok) {
        return {
          ok: false,
          status: 500,
          code: "zero_balance_violation",
          message: `Replanned deduction stack refused (${replanned.code}) after the amortization line advanced — the receipt is settled but nothing routed; re-run the release.`,
        };
      }
      Object.assign(plan, replanned.plan);
    }
  }

  // The routing legs, in the founder's mandated order: the deduction stack
  // applied before net income releases to talent. Every branch conserves
  // its cents. Every payee credit rides the esports waterfall's structure:
  // the catalog-dispute freeze check, then the recoupment sweep (a payee
  // with a recoupment advance has incoming swept to the company before any
  // excess lands) — never a bare vault credit.
  const glLegs: GlLegInput[] = [vtuberHoldbackDebit(agency, row.amount_cents)];
  const withholding: TaxEscrowRecord[] = [];
  const dustLedger: CompanyDustRecord[] = [];
  const talentCredits: VtuberAgencyReleaseSuccess["value"]["talent_credits"] = [];

  /**
   * Credits one payee exactly the way the esports waterfall credits a
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
    // No work context exists on a holdback receipt — the catalog-dispute
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

  // The agency deduction stack, in order — management, rigging holdback,
  // licensing holdback, the amortization line (each its own named
  // deduction; the plan and the GL legs keep them distinct for audit).
  await creditWaterfallPayee(input.agencyPayeeId, input.agencyPayeeName, plan.managementFeeCents);
  await creditWaterfallPayee(input.agencyPayeeId, input.agencyPayeeName, plan.riggingHoldbackCents);
  await creditWaterfallPayee(input.agencyPayeeId, input.agencyPayeeName, plan.licensingHoldbackCents);
  await creditWaterfallPayee(
    input.agencyPayeeId,
    input.agencyPayeeName,
    plan.techSetupAmortizationCents,
  );

  for (const allocation of plan.talentAllocations) {
    if (allocation.amountCents <= 0) {
      // A floored-to-zero share still reports — gross 0, net 0.
      talentCredits.push({
        payee_id: allocation.payeeId,
        payee_name: allocation.payeeName,
        role: allocation.role,
        gross_cents: 0,
        net_cents: 0,
      });
      continue;
    }
    let creditAmount = allocation.amountCents;
    if (isWithholdableTalentRole(allocation.role)) {
      // Creator talent's share is W-2-shaped compensation — the same
      // withholding escrow the esports waterfall's playing roles ride. The
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
    talentCredits.push({
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

  // The zero-balance check: the deduction stack + the talent allocations +
  // dust === the locked receipt, ALWAYS (the plan conserves by
  // construction; the check is the tripwire that refuses to post a journal
  // that does not). The held buckets — the stack's deductions — are in the
  // equation.
  const routedTotal =
    plan.managementFeeCents +
    plan.riggingHoldbackCents +
    plan.licensingHoldbackCents +
    plan.techSetupAmortizationCents +
    plan.talentAllocations.reduce((total, a) => total + a.amountCents, 0) +
    plan.companyDustCents;
  if (
    !zeroBalanceHolds(
      row.amount_cents,
      [
        { amount_cents: plan.managementFeeCents },
        { amount_cents: plan.riggingHoldbackCents },
        { amount_cents: plan.licensingHoldbackCents },
        { amount_cents: plan.techSetupAmortizationCents },
        ...plan.talentAllocations.map((a) => ({ amount_cents: a.amountCents })),
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
        "Deduction stack + talent split + dust !== locked receipt — release refused.",
    };
  }

  const posted = await postJournal(
    store,
    {
      kind: "vtuber_holdback_release",
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
      holdback_credit: settled,
      plan,
      talent_credits: talentCredits,
      company_dust_cents: plan.companyDustCents,
      dust_ledger: dustLedger,
      tech_setup_amortization: amortization,
      withholding,
      journal_id: posted.journal.id,
    },
  };
}
