/**
 * VTuber tax withholding verification state (PR 15, migration 0020) — the
 * durable state behind the livestream payout gate's
 * `tax_withholding_verified` read.
 *
 * Sibling mechanics to the gaming studio KYC state (PR 13): a validated,
 * fail-closed writer for the verification record, plus the store-backed
 * resolver the livestream vertical gate reads through. The gate itself is
 * untouched — it reads `LivestreamComplianceState` through the seam
 * (payoutGate's VerticalComplianceStateSource) and refuses when the state
 * is absent or not verified; this module is the wiring that POPULATES that
 * state from durable rows instead of leaving the default source returning
 * null forever.
 *
 * Wired to the existing withholding machinery of record: a 'verified'
 * state is only writable when the payee's creator tax profile — the fields
 * the withholding engine (applyWithholding, POST /api/v1/compliance/
 * withholding) maintains and resolves — shows tin_verified AND w9_on_file.
 * No profile, no verification; the state never lies about withholding.
 */

import type { Store } from "@/lib/server/store";
import type {
  VtuberTaxWithholdingVerificationRecord,
  VtuberTaxWithholdingVerificationState,
} from "@/modules/don/records";
import type { LivestreamComplianceState } from "@/modules/compliance/payoutGate";

export type VtuberWithholdingVerificationInput = {
  /** The payee's sovereign identity. */
  payee_id: string;
  /** The tax year the verification covers. */
  tax_year: number;
  /** 'verified' is the only state the livestream gate accepts. */
  state: VtuberTaxWithholdingVerificationState;
  /**
   * The withholding evidence the verification cites — REQUIRED for a
   * 'verified' state (fail-closed provenance; the livestream gate's own
   * doc: "withholding evidence is mandatory").
   */
  evidence_ref: string | null;
};

export type VtuberVerificationValidationError = {
  field: "payee_id" | "tax_year" | "state" | "evidence_ref";
  message: string;
};

export type VtuberWithholdingVerificationFailure =
  | { ok: false; code: "vtuber_withholding_invalid"; errors: VtuberVerificationValidationError[] }
  | { ok: false; code: "vtuber_withholding_profile_unverified"; payee_id: string };

export type VtuberWithholdingVerificationSuccess = {
  ok: true;
  record: VtuberTaxWithholdingVerificationRecord;
};

/**
 * Pure input validation — the strict-ingestion discipline (fail-closed on
 * malformed input, a typed error per bad field, never a guessed default).
 * A 'verified' state without evidence is rejected here, before any store
 * write or profile read.
 */
export function validateVtuberTaxWithholdingVerification(
  input: VtuberWithholdingVerificationInput,
): VtuberVerificationValidationError[] {
  const errors: VtuberVerificationValidationError[] = [];
  if (typeof input.payee_id !== "string" || input.payee_id.trim() === "") {
    errors.push({ field: "payee_id", message: "payee_id must be a non-empty string" });
  }
  if (!Number.isSafeInteger(input.tax_year) || input.tax_year <= 0) {
    errors.push({ field: "tax_year", message: "tax_year must be a positive integer" });
  }
  if (
    input.state !== "pending" &&
    input.state !== "verified" &&
    input.state !== "failed"
  ) {
    errors.push({
      field: "state",
      message: "state must be 'pending', 'verified', or 'failed'",
    });
  }
  if (input.state === "verified" && (input.evidence_ref ?? "").trim() === "") {
    errors.push({
      field: "evidence_ref",
      message: "a 'verified' state requires withholding evidence (evidence_ref)",
    });
  }
  return errors;
}

/**
 * The fail-closed verification writer: validates the input, checks the
 * withholding machinery of record (the creator tax profile's tin_verified
 * AND w9_on_file — the fields applyWithholding maintains), then upserts
 * one verification state per (payee_id, tax_year). A 'verified' state
 * without a verified profile of record is refused — the state never lies
 * about withholding.
 */
export async function verifyVtuberTaxWithholding(
  store: Store,
  input: VtuberWithholdingVerificationInput,
  now: string,
): Promise<VtuberWithholdingVerificationSuccess | VtuberWithholdingVerificationFailure> {
  const errors = validateVtuberTaxWithholdingVerification(input);
  if (errors.length > 0) {
    return { ok: false, code: "vtuber_withholding_invalid", errors };
  }

  const profile = await store.getCreatorTaxProfile(input.payee_id);

  if (input.state === "verified") {
    if (profile === undefined || !profile.tin_verified || !profile.w9_on_file) {
      return {
        ok: false,
        code: "vtuber_withholding_profile_unverified",
        payee_id: input.payee_id,
      };
    }
  }

  const existing = await store.getVtuberTaxWithholdingVerification(
    input.payee_id,
    input.tax_year,
  );
  const record: VtuberTaxWithholdingVerificationRecord = {
    id: existing?.id ?? crypto.randomUUID(),
    payee_id: input.payee_id,
    tax_year: input.tax_year,
    state: input.state,
    // The profile-of-record fields ride the row so the gate's read never
    // needs a second hop (and an audit shows what the profile said when
    // the verification landed).
    tin_verified: input.state === "verified" ? Boolean(profile?.tin_verified) : false,
    w9_on_file: input.state === "verified" ? Boolean(profile?.w9_on_file) : false,
    evidence_ref: input.evidence_ref,
    verified_at: input.state === "pending" || input.state === "failed" ? null : now,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };
  const stored = await store.upsertVtuberTaxWithholdingVerification(record);
  return { ok: true, record: stored };
}

/**
 * Derives the livestream vertical's compliance state from one verification
 * row — the pure projection the store-backed resolver returns through the
 * seam. `stream_platform_payout_reconciled` is the caller's context (the
 * recon layer's reconciliation of record), not this row's.
 */
export function livestreamComplianceStateFromVerification(
  record: VtuberTaxWithholdingVerificationRecord,
  streamPlatformPayoutReconciled: boolean,
): LivestreamComplianceState {
  return {
    vertical: "livestream",
    stream_platform_payout_reconciled: streamPlatformPayoutReconciled,
    tax_withholding_verified: record.state === "verified",
  };
}

export type LivestreamVerticalComplianceOptions = {
  /** The tax year whose verification state the gate reads. */
  taxYear: number;
  /** The recon layer's stream-platform reconciliation of record. */
  streamPlatformPayoutReconciled: boolean;
};

/**
 * The store-backed livestream vertical state resolver — the function the
 * runtime wires into setVerticalComplianceStateSource (the payoutGate
 * seam) so the livestream gate reads DURABLE verification state. An absent
 * row resolves null — and the gate refuses on absent (fail-closed, always).
 */
export async function resolveLivestreamVerticalComplianceState(
  store: Store,
  payeeId: string,
  options: LivestreamVerticalComplianceOptions,
): Promise<LivestreamComplianceState | null> {
  const record = await store.getVtuberTaxWithholdingVerification(
    payeeId,
    options.taxYear,
  );
  if (record === undefined) return null;
  return livestreamComplianceStateFromVerification(
    record,
    options.streamPlatformPayoutReconciled,
  );
}
