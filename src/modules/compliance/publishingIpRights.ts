// Publishing IP-rights clearance — PR 21 (founder IP-adaptation optioning
// directive).
//
// When a webtoon series or novel is optioned for film, TV, or gaming
// adaptation, the option fee can only dispatch once the work's IP rights
// are verifiably cleared — an adaptation made on uncleared rights is not a
// settlement mistake, it is an infringement. The publishing vertical's
// payout gate reads `ip_rights_cleared` for every publishing/adaptation
// work (payoutGate's founder canon); this module owns the DURABLE state
// that field resolves from.
//
// The pattern is the VTuber tax-withholding verification
// (vtuberWithholdingVerification.ts) at work scope instead of tax-year
// scope: one row per (payee_id, work_id), a fail-closed writer that
// validates the input and checks the machinery of record before any state
// is written, a re-verification that replaces the row atomically (the
// studio-KYC upsert precedent), and a store-backed resolver the runtime
// wires into payoutGate's vertical-compliance seam. Only an explicit
// 'cleared' state passes the gate — absent, pending, and failed all refuse,
// fail-closed. A 'cleared' state carries mandatory evidence (the clearance
// document's provenance) and requires an option agreement of record for
// the work — the state never lies about the rights chain.
//
// SCOPE NOTE (fail-closed by construction): the publishing gate's other
// two conditions — return_reserve_period_elapsed and isbn_rights_verified —
// are print-title conditions. Option fees are not print-title payouts, so
// the CALLER states those two conditions explicitly in the release input;
// nothing here silently defaults them to true. The gate itself is
// unchanged — all three conditions must hold for the publishing vertical.

import type { Store } from "@/lib/server/store";
import {
  PUBLISHING_IP_RIGHTS_STATES,
  type PublishingIpRightsState,
  type PublishingIpRightsVerificationRecord,
} from "@/modules/don/records";

/** House validation-error shape — the VTuber verification writer's. */
export type PublishingIpRightsValidationError = {
  field: string;
  message: string;
};

export interface PublishingIpRightsVerificationInput {
  /** The payee whose option-fee dispatch this clearance covers. */
  payee_id: string;
  /** The optioned work the clearance covers. */
  work_id: string;
  /** The verification state — only 'cleared' passes the payout gate. */
  state: PublishingIpRightsState;
  /**
   * The clearance's provenance of record — REQUIRED for 'cleared' (the
   * VTuber evidence_ref discipline).
   */
  evidence_ref?: string | null;
}

export type PublishingIpRightsVerificationSuccess = {
  ok: true;
  record: PublishingIpRightsVerificationRecord;
};

export type PublishingIpRightsVerificationFailure =
  | {
      ok: false;
      code: "publishing_ip_rights_invalid";
      errors: PublishingIpRightsValidationError[];
    }
  | {
      ok: false;
      code: "publishing_ip_rights_agreement_missing";
      work_id: string;
      message: string;
    };

function validatePublishingIpRightsVerification(
  input: PublishingIpRightsVerificationInput,
): PublishingIpRightsValidationError[] {
  const errors: PublishingIpRightsValidationError[] = [];
  if (input.payee_id.trim() === "") {
    errors.push({ field: "payee_id", message: "a verification names its payee" });
  }
  if (input.work_id.trim() === "") {
    errors.push({ field: "work_id", message: "a verification names its optioned work" });
  }
  if (!PUBLISHING_IP_RIGHTS_STATES.includes(input.state)) {
    errors.push({
      field: "state",
      message: `state must be one of ${PUBLISHING_IP_RIGHTS_STATES.join(", ")}`,
    });
  }
  // The machinery-of-record discipline: a 'cleared' state without evidence
  // is refused — the state never lies about the rights chain (the VTuber
  // writer's precedent).
  if (input.state === "cleared" && (input.evidence_ref ?? "").trim() === "") {
    errors.push({
      field: "evidence_ref",
      message: "a 'cleared' state requires IP clearance evidence (evidence_ref)",
    });
  }
  return errors;
}

/**
 * The fail-closed verification writer: validates the input, requires the
 * option agreement of record for the work (a clearance without a
 * registered option deal is meaningless — there is nothing to clear
 * AGAINST), then upserts one verification state per (payee_id, work_id).
 * A 'cleared' state without evidence or without the agreement of record is
 * refused.
 */
export async function verifyPublishingIpRights(
  store: Store,
  input: PublishingIpRightsVerificationInput,
  now: string,
): Promise<PublishingIpRightsVerificationSuccess | PublishingIpRightsVerificationFailure> {
  const errors = validatePublishingIpRightsVerification(input);
  if (errors.length > 0) {
    return { ok: false, code: "publishing_ip_rights_invalid", errors };
  }

  if (input.state === "cleared") {
    const agreement = await store.getIpOptionAgreement(input.work_id);
    if (agreement === undefined) {
      return {
        ok: false,
        code: "publishing_ip_rights_agreement_missing",
        work_id: input.work_id,
        message: `No option agreement of record exists for work "${input.work_id}" — register the option deal before recording an IP clearance.`,
      };
    }
  }

  const existing = await store.getPublishingIpRightsVerification(
    input.payee_id,
    input.work_id,
  );
  const record: PublishingIpRightsVerificationRecord = {
    id: existing?.id ?? crypto.randomUUID(),
    payee_id: input.payee_id,
    work_id: input.work_id,
    state: input.state,
    evidence_ref: input.evidence_ref ?? null,
    cleared_at: input.state === "cleared" ? now : null,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };
  const stored = await store.upsertPublishingIpRightsVerification(record);
  return { ok: true, record: stored };
}

/**
 * The store-backed publishing vertical's ip_rights_cleared resolver — the
 * durable read the release lane evaluates per credited payee. Absent,
 * pending, and failed all resolve FALSE — fail-closed, always (the
 * livestream resolver's absent-row rule, at work scope).
 */
export async function resolvePublishingIpRightsCleared(
  store: Store,
  payeeId: string,
  workId: string,
): Promise<boolean> {
  const record = await store.getPublishingIpRightsVerification(payeeId, workId);
  return record?.state === "cleared";
}
