/**
 * CVT estate succession + multi-heir splitting (PR 29, migration 0033) —
 * the durable ledger operations behind the founder's estate directive:
 * when an artist passes away, the Don Ledger's receiving entity transitions
 * to the verified estate entity (the Artist Foundation or the multi-heir
 * succession) upon legal certificate validation, and incoming licensing and
 * resale funds divide according to the VERIFIED probate percentages before
 * the standing release machinery disburses them (the payout gates).
 *
 * The gates, in order of severity:
 *   1. The RECEIVING-ENTITY transition appends history ONLY from a verified
 *      legal certificate — absent, pending, and rejected certificates all
 *      refuse, fail-closed. The transition is an INSERT into the
 *      append-only handoff ledger; existing ledger history is never
 *      rewritten (the AI allocation-archive discipline: audit-preserving).
 *   2. The multi-heir split accrual is keyed on the verified probate
 *      percentages (configurable per probate, versioned — accrued splits
 *      keep their version's history, never re-cut). Conservation is exact:
 *      Σ heir allocations + dust = basis, and the dust routes to the
 *      platform variance payee ('platform', never an heir — the locked Don
 *      dust discipline).
 *   3. The estate payout gate (estate_succession_verified) reads the
 *      per-payee states of record FAIL-CLOSED: absent → null → refuse;
 *      'unknown' → false → refuse; only 'verified' passes. The gate's
 *      resolver lives beside the AI resolver in the payout-gate module.
 *
 * The split accruals are designations, not movements: the money moves
 * through the standing release machinery (the payout gates). The append-only
 * accrual row is the gate's verified input — the art lane's discipline.
 */

import { randomUUID } from "node:crypto";
import type { Store } from "@/lib/server/store";
import {
  type EstateCertificateValidationState,
  type EstateHeirScheduleRecord,
  type EstateHeirSpec,
  type EstatePayoutGateStateRecord,
  type EstateSplitAccrualRecord,
  type EstateSuccessionCertificateRecord,
  type EstateSuccessionTransitionRecord,
  isEstateCertificateValidationState,
  isEstateHeirRelationship,
} from "@/modules/don/records";
import { isUniqueViolation } from "@/lib/server/uniqueViolation";

/** House failure envelope — the art cascade's shape. */
export type EstateFailure = {
  ok: false;
  status: number;
  code: string;
  message: string;
};

// ---------------------------------------------------------------------------
// Money helpers — exact integer arithmetic only; nothing rounds up into an
// heir's credit.
// ---------------------------------------------------------------------------

/**
 * The multi-heir probate split — each heir's share is floor(basis × bps /
 * 10_000), exact. The residue (basis − Σ shares) is the schedule's DUST: it
 * never enters an heir's credit and routes to the platform variance payee —
 * the locked Don invariant (dust payee 'platform', never a creator). With
 * Σ bps ≤ 10_000 (registration-validated) the residue is never negative.
 */
export function estateHeirSplits(
  basisCents: number,
  heirs: readonly EstateHeirSpec[],
): { allocations: EstateSplitAccrualRecord["allocations"]; dustCents: number } {
  if (!Number.isSafeInteger(basisCents) || basisCents < 0) {
    throw new RangeError(`invalid_split_basis:${String(basisCents)}`);
  }
  const allocations = heirs
    .map((heir) => {
      const bps = heir.percentage_bps;
      if (!Number.isInteger(bps) || bps < 1 || bps > 10_000) {
        throw new RangeError(`invalid_split_percentage:${heir.heir_payee_id}:${String(bps)}`);
      }
      return {
        heir_payee_id: heir.heir_payee_id,
        heir_payee_name: heir.heir_payee_name,
        relationship: heir.relationship,
        share_cents: Number((BigInt(basisCents) * BigInt(bps)) / 10_000n),
      };
    })
    .filter((allocation) => allocation.share_cents > 0);
  const dustCents = basisCents - allocations.reduce((sum, allocation) => sum + allocation.share_cents, 0);
  return { allocations, dustCents };
}

// ---------------------------------------------------------------------------
// The certificate of record — the verified legal fact the whole lane gates
// on.
// ---------------------------------------------------------------------------

export interface EstateCertificateInput {
  artist_payee_id: string;
  /** The legal certificate's reference of record (probate/court ref). */
  certificate_ref: string;
  /** The certificate document's SHA-256 hex digest — the audit anchor. */
  certificate_hash: string;
  estate_entity_payee_id: string;
  estate_entity_payee_name: string;
  validation_state: EstateCertificateValidationState;
  /** The operator identity recording the validation (required when verified). */
  verified_by?: string | null;
}

const CERTIFICATE_HASH_PATTERN = /^[0-9a-f]{64}$/;

function validateCertificateInput(input: EstateCertificateInput): string | null {
  if (input.artist_payee_id.trim() === "") return "A certificate names the artist of record.";
  if (input.certificate_ref.trim() === "") return "A certificate names its legal reference of record.";
  if (!CERTIFICATE_HASH_PATTERN.test(input.certificate_hash)) {
    return "A certificate carries its document's SHA-256 hex digest — the audit anchor.";
  }
  if (input.estate_entity_payee_id.trim() === "" || input.estate_entity_payee_name.trim() === "") {
    return "A certificate names the estate entity of record — the receiving entity AFTER the transition.";
  }
  if (!isEstateCertificateValidationState(input.validation_state)) {
    return "A certificate's validation state is 'pending', 'verified', or 'rejected'.";
  }
  return null;
}

/**
 * Records (or re-validates) the estate succession certificate of record.
 * The transition gate reads the VALIDATION STATE, not the row's existence:
 * only validation_state === 'verified' transitions, and a verified record
 * stamps verified_by/verified_at and converges the payout-gate states of
 * record (the receiving payees' estate_succession_verified) — fail-closed
 * until then. The estate entity's state is recorded on verify; each heir's
 * state converges when the probate schedule of record registers.
 */
export async function verifyEstateSuccessionCertificate(
  store: Store,
  input: EstateCertificateInput,
  now: Date = new Date(),
): Promise<EstateSuccessionCertificateRecord | EstateFailure> {
  const validationError = validateCertificateInput(input);
  if (validationError !== null) {
    return { ok: false, status: 422, code: "invalid_certificate_input", message: validationError };
  }
  const isVerified = input.validation_state === "verified";
  const record = await store.upsertEstateSuccessionCertificate({
    artist_payee_id: input.artist_payee_id.trim(),
    certificate_ref: input.certificate_ref.trim(),
    certificate_hash: input.certificate_hash.toLowerCase(),
    estate_entity_payee_id: input.estate_entity_payee_id.trim(),
    estate_entity_payee_name: input.estate_entity_payee_name.trim(),
    validation_state: input.validation_state,
    verified_by: isVerified ? (input.verified_by ?? null) : null,
    verified_at: isVerified ? now.toISOString() : null,
  });

  // The verified certificate converges the estate entity's payout-gate
  // state of record (the AI payout-gate states' discipline): 'verified' is
  // the ONLY state this write produces — a revoke path would be its own
  // explicit operator act, never a side effect of a re-validation.
  if (isVerified) {
    await store.upsertEstatePayoutGateState({
      payee_id: record.estate_entity_payee_id,
      estate_succession_state: "verified",
      certificate_ref: record.certificate_ref,
      verified_by: record.verified_by,
    });
  }
  return record;
}

// ---------------------------------------------------------------------------
// The probate split schedule of record — configurable per probate.
// ---------------------------------------------------------------------------

export interface EstateHeirScheduleRegistration {
  certificate_id: string;
  heirs: readonly EstateHeirSpec[];
}

function validateEstateHeirs(registration: EstateHeirScheduleRegistration): string | null {
  if (registration.certificate_id.trim() === "") {
    return "A probate schedule hangs from its certificate of record.";
  }
  if (registration.heirs.length === 0) {
    return "A probate schedule names at least one heir.";
  }
  let totalBps = 0;
  for (const heir of registration.heirs) {
    if (heir.heir_payee_id.trim() === "" || heir.heir_payee_name.trim() === "") {
      return "Every heir names its payee of record.";
    }
    if (!isEstateHeirRelationship(heir.relationship)) {
      return `Unknown heir relationship "${heir.relationship}".`;
    }
    if (!Number.isInteger(heir.percentage_bps) || heir.percentage_bps < 1 || heir.percentage_bps > 10_000) {
      return "A probate share is 1–10,000 whole basis points.";
    }
    totalBps += heir.percentage_bps;
  }
  if (totalBps > 10_000) {
    return "A probate schedule's shares cannot exceed the whole basis (10,000 bps).";
  }
  return null;
}

/**
 * Registers (or amends) the multi-heir split schedule of record for one
 * certificate — configurable per probate (e.g. spouse 50% / child A 25% /
 * child B 25%). A re-registration keeps the row's identity and increments
 * its version; accrued splits keep their version's history — never re-cut.
 * When the certificate is VERIFIED, the registration converges each heir's
 * payout-gate state of record to 'verified' (the heirs are named receiving
 * payees of a verified succession).
 */
export async function registerEstateHeirSchedule(
  store: Store,
  input: EstateHeirScheduleRegistration,
  now: Date = new Date(),
): Promise<EstateHeirScheduleRecord | EstateFailure> {
  const validationError = validateEstateHeirs(input);
  if (validationError !== null) {
    return { ok: false, status: 422, code: "invalid_schedule_input", message: validationError };
  }
  const certificate = await store.getEstateSuccessionCertificateById(input.certificate_id);
  if (certificate === undefined) {
    return {
      ok: false,
      status: 404,
      code: "estate_certificate_not_found",
      message: `No estate succession certificate of record "${input.certificate_id}" — register the certificate before its probate schedule.`,
    };
  }
  const existing = await store.getEstateHeirSchedule(input.certificate_id);
  const record: EstateHeirScheduleRecord = {
    id: existing?.id ?? randomUUID(),
    certificate_id: input.certificate_id,
    heirs: input.heirs.map((heir) => ({
      heir_payee_id: heir.heir_payee_id.trim(),
      heir_payee_name: heir.heir_payee_name.trim(),
      relationship: heir.relationship,
      percentage_bps: heir.percentage_bps,
    })),
    version: existing === undefined ? 1 : existing.version + 1,
    created_at: existing?.created_at ?? now.toISOString(),
    updated_at: now.toISOString(),
  };
  const saved = await store.upsertEstateHeirSchedule(record);

  // The verified succession's heirs are receiving payees of record — their
  // gate states converge with the schedule (the estate entity's state was
  // recorded at certificate verification).
  if (certificate.validation_state === "verified") {
    for (const heir of saved.heirs) {
      await store.upsertEstatePayoutGateState({
        payee_id: heir.heir_payee_id,
        estate_succession_state: "verified",
        certificate_ref: certificate.certificate_ref,
        verified_by: certificate.verified_by,
      });
    }
  }
  return saved;
}

// ---------------------------------------------------------------------------
// The receiving-entity transition — append-only, gated on the VERIFIED
// certificate.
// ---------------------------------------------------------------------------

export type EstateReceivingEntity = {
  /** True when the artist's succession is verified — funds route to the
   * estate entity from this read onward. */
  is_artist_estate: boolean;
  /** The receiving payee of record — the artist pre-transition, the estate
   * entity after. */
  receiving_payee_id: string;
  receiving_payee_name: string;
};

/**
 * The is_artist_estate derivation — the ledger contract's read for WHO
 * receives an artist's funds. Fail-closed in both directions of intent: no
 * verified certificate (absent, pending, rejected) → the artist still
 * receives (is_artist_estate false); a verified certificate → the estate
 * entity receives. The append-only transition rows are the handoff's audit
 * trail; this derivation is the routing read the fund-posting paths use.
 */
export async function resolveReceivingEntity(
  store: Store,
  artistPayeeId: string,
): Promise<EstateReceivingEntity> {
  const certificate = await store.getVerifiedEstateSuccessionCertificate(artistPayeeId);
  if (certificate === undefined) {
    return { is_artist_estate: false, receiving_payee_id: artistPayeeId, receiving_payee_name: artistPayeeId };
  }
  return {
    is_artist_estate: true,
    receiving_payee_id: certificate.estate_entity_payee_id,
    receiving_payee_name: certificate.estate_entity_payee_name,
  };
}

export interface EstateTransitionInput {
  artist_payee_id: string;
  /** The funding event that drove this transition — the replay guard's key. */
  source_event_id: string;
  /** The artwork the funds relate to (null = an estate-wide handoff). */
  artwork_id?: string | null;
  /** The funds' provenance hash, carried for audit. */
  provenance_hash?: string | null;
}

/**
 * The receiving-entity transition — the append-only handoff record, gated
 * on the artist's VERIFIED legal certificate. Absent, pending, and
 * rejected certificates refuse (fail-closed). The transition INSERTS
 * history; it never updates or deletes a ledger row — the existing trail
 * stays intact (audit-preserving). UNIQUE per (certificate_id,
 * source_event_id): a replayed event is a 409, never a double handoff.
 */
export async function transitionReceivingEntity(
  store: Store,
  input: EstateTransitionInput,
  now: Date = new Date(),
): Promise<EstateSuccessionTransitionRecord | EstateFailure> {
  if (input.artist_payee_id.trim() === "" || input.source_event_id.trim() === "") {
    return {
      ok: false,
      status: 422,
      code: "invalid_transition_input",
      message: "A receiving-entity transition names its artist of record and its driving funding event.",
    };
  }
  const certificate = await store.getVerifiedEstateSuccessionCertificate(input.artist_payee_id.trim());
  if (certificate === undefined) {
    return {
      ok: false,
      status: 422,
      code: "estate_succession_not_verified",
      message:
        "Receiving-entity transition refused: no VERIFIED legal certificate of record exists for this artist's estate succession (absent, pending, and rejected certificates all refuse).",
    };
  }
  const history = await store.listEstateSuccessionTransitions(certificate.id);
  if (history.some((transition) => transition.source_event_id === input.source_event_id)) {
    return {
      ok: false,
      status: 409,
      code: "estate_transition_already_recorded",
      message: `Receiving-entity transition for event "${input.source_event_id}" was already recorded for certificate "${certificate.certificate_ref}" — the append-only history is the replay arbiter.`,
    };
  }
  try {
    return await store.insertEstateSuccessionTransition({
      certificate_id: certificate.id,
      artist_payee_id: certificate.artist_payee_id,
      estate_entity_payee_id: certificate.estate_entity_payee_id,
      source_event_id: input.source_event_id.trim(),
      artwork_id: input.artwork_id ?? null,
      provenance_hash: input.provenance_hash ?? null,
      created_at: now.toISOString(),
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      // Lost the replay race — the once-only guard's no-op discipline.
      return {
        ok: false,
        status: 409,
        code: "estate_transition_already_recorded",
        message: `Receiving-entity transition for event "${input.source_event_id}" was already recorded for certificate "${certificate.certificate_ref}".`,
      };
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// The multi-heir split accrual — the once-only designation behind the payout
// gates.
// ---------------------------------------------------------------------------

export interface EstateSplitAccrualInput {
  certificate: EstateSuccessionCertificateRecord;
  schedule: EstateHeirScheduleRecord;
  /** The funding row's event id. */
  source_event_id: string;
  /** The artwork the funds relate to — the provenance key. */
  artwork_id: string;
  /** The funds' provenance hash — carried on the line item for audit. */
  provenance_hash: string;
  /** The funding base, integer cents. */
  basis_cents: number;
}

export type EstateSplitAccrualSuccess = {
  accrual: EstateSplitAccrualRecord | null;
  /** True when the provenance triple already accrued (the UNIQUE guard's no-op). */
  replayed: boolean;
};

/**
 * Executes the multi-heir probate split for one funding event — the
 * append-only accrual keyed on the VERIFIED probate percentages. Exact to
 * the cent: Σ heir allocations + dust = basis (dust to the platform
 * variance payee, never an heir). The provenance triple
 * (certificate_id, artwork_id, source_event_id) is the once-only key: a
 * replayed event is the unique violation, never a double designation.
 */
export async function accrueEstateHeirSplit(
  store: Store,
  input: EstateSplitAccrualInput,
  now: Date = new Date(),
): Promise<EstateSplitAccrualSuccess | EstateFailure> {
  if (input.schedule.certificate_id !== input.certificate.id) {
    return {
      ok: false,
      status: 422,
      code: "invalid_schedule_input",
      message: "The probate schedule of record hangs from the accrual's certificate.",
    };
  }
  let allocations: EstateSplitAccrualRecord["allocations"];
  let dustCents: number;
  try {
    const splits = estateHeirSplits(input.basis_cents, input.schedule.heirs);
    allocations = splits.allocations;
    dustCents = splits.dustCents;
  } catch (error) {
    // A malformed probate schedule of record is an operator data problem —
    // surface it, never fabricate an allocation.
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      status: 422,
      code: "invalid_schedule_input",
      message: `The probate schedule for certificate "${input.certificate.certificate_ref}" cannot split its basis: ${message}`,
    };
  }
  try {
    const accrual = await store.insertEstateSplitAccrual({
      schedule_id: input.schedule.id,
      certificate_id: input.certificate.id,
      artist_payee_id: input.certificate.artist_payee_id,
      estate_entity_payee_id: input.certificate.estate_entity_payee_id,
      source_event_id: input.source_event_id.trim(),
      artwork_id: input.artwork_id.trim(),
      provenance_hash: input.provenance_hash.trim(),
      basis_cents: input.basis_cents,
      allocations,
      dust_cents: dustCents,
      created_at: now.toISOString(),
    });
    return { accrual, replayed: false };
  } catch (error) {
    if (isUniqueViolation(error)) {
      // The event already accrued — the once-only designation, replayed as
      // a no-op (the books accrual's replay discipline).
      return { accrual: null, replayed: true };
    }
    throw error;
  }
}

// Re-exported for the gate module and the release paths — the estate lane
// speaks in the records' own vocabulary.
export type {
  EstatePayoutGateStateRecord,
  EstateSuccessionCertificateRecord,
  EstateSuccessionTransitionRecord,
};
