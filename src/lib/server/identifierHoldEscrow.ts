// Unclaimed identifier hold escrow — PR 53 (founder universal-identifier
// directive).
//
// A recon line item flagged by the unmatched-code fallback detector (PR 52)
// — its primary identifier carries NO verified cross-links — must not sit
// in FBO cash and must not become anyone's balance. It locks here: ledger
// rows with kind AND status 'unclaimed_identifier_hold', a sentinel payee
// + GL account per identifier scope ('{primaryCodeType}:{primaryCodeValue}'),
// and the quarantined event id in line_item_id — so no query can fold the
// hold into unclaimed holding, company dust, or any other escrow state.
//
// THE ONLY EXIT IS THE EVIDENCE. The held identifier verifies through the
// EXTERNAL registry ping (registryPing.ts — the spec-named external API;
// any error, timeout, or unverified verdict is fail-closed and writes
// NOTHING), whose attested cross-links land in the evidence of record
// (global_identifier_cross_ref — migration 0012's verification_source and
// verified_at, the exact fields the release gate reads). The release is a
// SEPARATE deterministic step keyed on that evidence — never inside the
// ping call — so the flow is idempotent and replay-safe: a re-run of the
// ping converges on the same upserts (no money moves), and the release's
// CAS (Store.settleIdentifierHoldEscrow) lets exactly one caller move the
// money. A verified release re-parks the amount as a fresh
// 'unclaimed_holding' credit (payee 'unclaimed', the original event id in
// line_item_id) — the NORMAL matching path (PR 7's recovery discovery +
// clearance-gated release) takes it from there. Never a direct payee
// payout from the hold.
//
// NO MIGRATION. ledger_transactions.status/kind are free text columns
// (migration 0006 places no check constraint on either) — the escrow
// family's extension-in-place discipline. The evidence lives in 0012's
// table; the CAS in ledger_transactions.

import type { Store } from "@/lib/server/store";
import type { LedgerTransactionRecord } from "@/lib/don/types";
import {
  UNCLAIMED_HOLDING_PAYEE_ID,
  UNCLAIMED_HOLDING_PAYEE_NAME,
  identifierHoldEscrowPayeeId,
  identifierHoldEscrowPayeeName,
} from "@/modules/don/constants";
import { zeroBalanceHolds } from "@/modules/don/dust";
import { postJournal } from "@/modules/ledger/engine";
import {
  fboDebit,
  identifierHoldEscrowCredit,
  identifierHoldEscrowDebit,
  unclaimedHoldingCredit,
} from "@/modules/ledger/journal";
import {
  chainLinksFor,
  type RegistryPingClient,
} from "@/lib/identifiers/registryPing";
import {
  type CrossLinkEvidenceStore,
  type VerifiedCrossLinkRow,
} from "@/lib/identifiers/crossLinkEvidence";

/** The verification_source stamp prefix that marks a cross-link row as
 * REGISTRY-attested (the release gate's vocabulary — self-attested
 * ingest rows never match it). */
export const REGISTRY_PING_VERIFICATION_SOURCE_PREFIX = "registry_ping";

/** The identifier scope key: the escrow's per-identity partition. */
export function identifierHoldEscrowScopeKey(
  primaryCodeType: string,
  primaryCodeValue: string,
): string {
  return `${primaryCodeType}:${primaryCodeValue}`;
}

export interface IdentifierHoldEscrowInput {
  /** The line's whole gross, integer cents — the hold locks the ENTIRE
   * line (no partial cross-link leaves money half-reconciled). */
  amount_cents: number;
  currency: string;
  /** The line's primary identifier — the scope pair the escrow locks
   * under and the registry ping later verifies. */
  primaryCodeType: string;
  primaryCodeValue: string;
  /** The quarantined source event's id — the journal ref (replay guard)
   * and the recovery linkage the release stamps onto the fresh holding
   * credit. */
  sourceEventId: string;
}

export type IdentifierHoldEscrowFailure = {
  ok: false;
  status: number;
  code: string;
  message: string;
};

// ---------- Posting: the unmatched line's gross locks into the hold. ----------

/**
 * Posts one unmatched recon line's gross into the UNCLAIMED_IDENTIFIER_HOLD
 * escrow for its primary identifier's scope. Idempotent by the GL journal
 * ref: one journal per source event id, so a replayed line is a counted
 * no-op (the ref non-empty ⇒ the money already locked once).
 */
export async function postIdentifierHoldEscrow(
  store: Store,
  input: IdentifierHoldEscrowInput,
  now: Date = new Date(),
): Promise<
  | {
      ok: true;
      value: { escrow_credit: LedgerTransactionRecord; journal_id: string };
    }
  | IdentifierHoldEscrowFailure
> {
  if (!Number.isSafeInteger(input.amount_cents) || input.amount_cents <= 0) {
    return {
      ok: false,
      status: 422,
      code: "identifier_hold_invalid_amount",
      message: "the hold amount must be a positive integer number of cents",
    };
  }
  const primaryCodeType = input.primaryCodeType.trim();
  const primaryCodeValue = input.primaryCodeValue.trim();
  const sourceEventId = input.sourceEventId.trim();
  if (
    primaryCodeType === "" ||
    primaryCodeValue === "" ||
    sourceEventId === ""
  ) {
    return {
      ok: false,
      status: 422,
      code: "identifier_hold_invalid_scope",
      message:
        "the hold requires a non-empty primary code type, code value, and source event id",
    };
  }

  // Replay guard — the same discipline postToUnclaimedHolding rides: the
  // GL journal ref is the idempotency key of record.
  const existing = await store.listGlJournalsByRef("match_queue", sourceEventId);
  if (existing.length > 0) {
    return {
      ok: false,
      status: 409,
      code: "identifier_hold_already_posted",
      message: `a journal already exists for source event ${sourceEventId} — the hold already locked once`,
    };
  }

  const scopeKey = identifierHoldEscrowScopeKey(primaryCodeType, primaryCodeValue);
  const createdAt = now.toISOString();
  const escrowCredit = await store.insertLedgerTransaction({
    split_run_id: sourceEventId,
    // The quarantined event IS the source line — the row-level recovery
    // linkage rides the existing line-item index, the same discipline as
    // the matched post's holding credit.
    line_item_id: sourceEventId,
    payee_id: identifierHoldEscrowPayeeId(scopeKey),
    payee_name: identifierHoldEscrowPayeeName(scopeKey),
    role: "other",
    share_bps: 0,
    amount_cents: input.amount_cents,
    currency: input.currency,
    status: "unclaimed_identifier_hold",
    rail: null,
    baas_provider: null,
    baas_transfer_id: null,
    created_at: createdAt,
    settled_at: null,
    kind: "unclaimed_identifier_hold",
  });

  const journal = await postJournal(
    store,
    {
      kind: "unclaimed_identifier_hold_post",
      ref_type: "match_queue",
      ref_id: sourceEventId,
      legs: [
        fboDebit(input.amount_cents),
        identifierHoldEscrowCredit(scopeKey, input.amount_cents),
      ],
    },
    now,
  );
  if (!journal.ok) {
    return {
      ok: false,
      status: 422,
      code: journal.code,
      message: journal.message,
    };
  }

  return {
    ok: true,
    value: { escrow_credit: escrowCredit, journal_id: journal.journal.id },
  };
}

// ---------- Verification: the external registry ping, fail-closed. ----------

export interface IdentifierHoldVerificationInput {
  hold_ledger_id: string;
  /** The scope pair the caller believes the hold is under — cross-checked
   * against the escrow row's sentinel payee before the ping runs. */
  primaryCodeType: string;
  primaryCodeValue: string;
  /** Optional family chain (see IDENTIFIER_CHAIN_MAPS) carried into the
   * ping request as the mandatory-link verification context. */
  chain?: string;
}

export interface IdentifierHoldVerificationOutcome {
  escrow_credit: LedgerTransactionRecord;
  /** The registry-attested cross-links now recorded as evidence. */
  evidence: VerifiedCrossLinkRow[];
  /** The registry's verification event reference, if it supplied one. */
  registryRef: string | null;
}

/**
 * Runs the external registry ping for one held identifier and, on a
 * verified verdict, records the attested cross-links as the evidence of
 * record. FAIL-CLOSED at every gate: a transport error, a timeout, an
 * unverified verdict, a verified-but-linkless verdict, a malformed
 * attestation, or an evidence-write failure each refuses WITHOUT moving
 * money — the hold stays locked, and a re-run converges (the evidence
 * upsert is idempotent).
 *
 * The ping runs OUTSIDE any transaction boundary (it is an external API
 * call); the evidence writes are single-statement upserts. The release is
 * NOT this function's job — releaseIdentifierHoldEscrow is the separate
 * deterministic step keyed on the recorded evidence.
 */
export async function pingRegistryToVerifyHeldIdentifier(
  store: Store,
  registry: RegistryPingClient,
  evidence: CrossLinkEvidenceStore,
  input: IdentifierHoldVerificationInput,
  now: Date = new Date(),
): Promise<
  | { ok: true; value: IdentifierHoldVerificationOutcome }
  | IdentifierHoldEscrowFailure
> {
  const row = await store.getLedgerTransaction(input.hold_ledger_id);
  if (row === undefined) {
    return {
      ok: false,
      status: 404,
      code: "identifier_hold_not_found",
      message: `no ledger row ${input.hold_ledger_id}`,
    };
  }
  if (row.kind !== "unclaimed_identifier_hold") {
    return {
      ok: false,
      status: 422,
      code: "identifier_hold_invalid_state",
      message: `ledger row ${row.id} is kind ${row.kind}, not an identifier hold`,
    };
  }
  if (row.status !== "unclaimed_identifier_hold") {
    return {
      ok: false,
      status: 409,
      code: "identifier_hold_already_released",
      message: `ledger row ${row.id} is ${row.status} — the hold already released`,
    };
  }
  const scopeKey = identifierHoldEscrowScopeKey(
    input.primaryCodeType.trim(),
    input.primaryCodeValue.trim(),
  );
  if (row.payee_id !== identifierHoldEscrowPayeeId(scopeKey)) {
    return {
      ok: false,
      status: 422,
      code: "identifier_hold_scope_mismatch",
      message: `the hold's scope of record (${row.payee_id}) does not match the requested scope (${scopeKey})`,
    };
  }

  // THE PING — external API call, deliberately outside any transaction.
  // Any failure mode below is treated as UNVERIFIED: fail-closed, no
  // evidence written, no release possible.
  let verdict;
  try {
    verdict = await registry.pingIdentity({
      primaryCodeType: input.primaryCodeType.trim(),
      primaryCodeValue: input.primaryCodeValue.trim(),
      mandatoryChainLinks: chainLinksFor(input.chain),
    });
  } catch (pingError) {
    return {
      ok: false,
      status: 403,
      code: "registry_ping_unverified",
      message: `the external registry ping failed (${String(pingError)}) — the hold stays locked`,
    };
  }
  if (verdict.verified !== true) {
    return {
      ok: false,
      status: 403,
      code: "registry_ping_unverified",
      message: `the external registry did not verify the identifier: ${verdict.detail} — the hold stays locked`,
    };
  }

  const attested = verdict.crossLinks ?? [];
  if (attested.length === 0) {
    return {
      ok: false,
      status: 403,
      code: "registry_ping_no_cross_links",
      message:
        "the external registry verified the identifier but attested no cross-links — the release gate requires a verified cross-link row, so the hold stays locked",
    };
  }
  for (const link of attested) {
    if (
      typeof link?.linkedCodeType !== "string" ||
      link.linkedCodeType.trim() === "" ||
      typeof link?.linkedCodeValue !== "string" ||
      link.linkedCodeValue.trim() === ""
    ) {
      return {
        ok: false,
        status: 403,
        code: "registry_ping_malformed_attestation",
        message:
          "the external registry attested a cross-link without a code type and value — the hold stays locked",
      };
    }
  }

  // The registry's attestation becomes the evidence of record — stamped
  // registry_ping (+:ref) so the release gate can tell a registry
  // attestation from a self-attested ingest row. An evidence-write
  // failure (e.g. the primary identity is not registered — the pg
  // backend refuses to invent a map row) is fail-closed: the refusal
  // surfaces, the hold stays locked, and a re-run converges.
  const verificationSource =
    verdict.registryRef === null || verdict.registryRef === undefined
      ? REGISTRY_PING_VERIFICATION_SOURCE_PREFIX
      : `${REGISTRY_PING_VERIFICATION_SOURCE_PREFIX}:${verdict.registryRef}`;
  const verifiedAt = now.toISOString();
  try {
    for (const link of attested) {
      await evidence.recordVerifiedCrossLink({
        primaryCodeType: input.primaryCodeType.trim(),
        primaryCodeValue: input.primaryCodeValue.trim(),
        linkedCodeType: link.linkedCodeType.trim(),
        linkedCodeValue: link.linkedCodeValue.trim(),
        verificationSource,
        verifiedAt,
      });
    }
  } catch (evidenceError) {
    return {
      ok: false,
      status: 403,
      code: "identifier_cross_link_unrecorded",
      message: `the verified cross-links could not be recorded (${String(evidenceError)}) — the hold stays locked; re-run the ping to converge`,
    };
  }

  const recorded = await evidence.listVerifiedCrossLinks(
    input.primaryCodeType.trim(),
    input.primaryCodeValue.trim(),
  );
  return {
    ok: true,
    value: {
      escrow_credit: row,
      evidence: recorded.filter(
        (r) => r.verification_source === verificationSource,
      ),
      registryRef: verdict.registryRef ?? null,
    },
  };
}

// ---------- Release: the deterministic, evidence-gated exit. ----------

export interface IdentifierHoldReleaseInput {
  hold_ledger_id: string;
  primaryCodeType: string;
  primaryCodeValue: string;
}

export interface IdentifierHoldReleaseOutcome {
  escrow_credit: LedgerTransactionRecord;
  /** The fresh unclaimed_holding credit — the amount re-entered the
   * NORMAL matching path (PR 7's recovery machinery takes it from
   * here). */
  released_credit: LedgerTransactionRecord;
  journal_id: string;
}

/**
 * The pure evidence gate: a registry-attested, timestamp-verified
 * cross-link row of record — or nothing. Self-attested ingest rows (any
 * verification_source not stamped registry_ping) and rows without a
 * verified_at never release money.
 */
export function requireRegistryVerifiedCrossLink(
  rows: readonly VerifiedCrossLinkRow[],
): VerifiedCrossLinkRow | undefined {
  return rows.find(
    (row) =>
      row.verified_at !== null &&
      row.verification_source.startsWith(
        REGISTRY_PING_VERIFICATION_SOURCE_PREFIX,
      ),
  );
}

/**
 * Releases one held UNCLAIMED_IDENTIFIER_HOLD into the normal matching
 * path — ONLY on the verified cross-link evidence of record. Separate
 * deterministic step (never inside the ping call): idempotent by the
 * release CAS (exactly one caller moves the money) and by the journal
 * ref (one release journal per escrow row).
 */
export async function releaseIdentifierHoldEscrow(
  store: Store,
  evidence: CrossLinkEvidenceStore,
  input: IdentifierHoldReleaseInput,
  now: Date = new Date(),
): Promise<
  | { ok: true; value: IdentifierHoldReleaseOutcome }
  | IdentifierHoldEscrowFailure
> {
  const row = await store.getLedgerTransaction(input.hold_ledger_id);
  if (row === undefined) {
    return {
      ok: false,
      status: 404,
      code: "identifier_hold_not_found",
      message: `no ledger row ${input.hold_ledger_id}`,
    };
  }
  if (row.kind !== "unclaimed_identifier_hold") {
    return {
      ok: false,
      status: 422,
      code: "identifier_hold_invalid_state",
      message: `ledger row ${row.id} is kind ${row.kind}, not an identifier hold`,
    };
  }
  if (row.status !== "unclaimed_identifier_hold") {
    return {
      ok: false,
      status: 409,
      code: "identifier_hold_already_released",
      message: `ledger row ${row.id} is ${row.status} — the hold already released`,
    };
  }
  const scopeKey = identifierHoldEscrowScopeKey(
    input.primaryCodeType.trim(),
    input.primaryCodeValue.trim(),
  );
  if (row.payee_id !== identifierHoldEscrowPayeeId(scopeKey)) {
    return {
      ok: false,
      status: 422,
      code: "identifier_hold_scope_mismatch",
      message: `the hold's scope of record (${row.payee_id}) does not match the requested scope (${scopeKey})`,
    };
  }

  // THE EVIDENCE GATE — fail-closed until the registry ping's verified
  // cross-link of record exists. No evidence, no release; a self-attested
  // cross-link row is not evidence.
  const recorded = await evidence.listVerifiedCrossLinks(
    input.primaryCodeType.trim(),
    input.primaryCodeValue.trim(),
  );
  if (requireRegistryVerifiedCrossLink(recorded) === undefined) {
    return {
      ok: false,
      status: 403,
      code: "identifier_cross_link_unverified",
      message:
        "no registry-attested verified cross-link row exists for this identifier — the hold stays locked (fail-closed)",
    };
  }

  // The CAS is the concurrency guard: exactly one caller flips the hold;
  // a loser (or replay) reads undefined and reports 409.
  const settled = await store.settleIdentifierHoldEscrow(
    row.id,
    now.toISOString(),
  );
  if (settled === undefined) {
    return {
      ok: false,
      status: 409,
      code: "identifier_hold_already_released",
      message: `ledger row ${row.id} was settled concurrently — the hold already released`,
    };
  }

  // Re-enter the NORMAL matching path: a fresh unclaimed_holding credit
  // (payee 'unclaimed') carrying the ORIGINAL event id in line_item_id —
  // PR 7's recovery discovery pairs it with the queue event, and the
  // clearance-gated release pays it like any other holding. The
  // quarantined event's identifier cross-links ride the queue event.
  const releasedCredit = await store.insertLedgerTransaction({
    split_run_id: settled.split_run_id,
    line_item_id: settled.line_item_id,
    payee_id: UNCLAIMED_HOLDING_PAYEE_ID,
    payee_name: UNCLAIMED_HOLDING_PAYEE_NAME,
    role: "other",
    share_bps: 0,
    amount_cents: settled.amount_cents,
    currency: settled.currency,
    status: "unclaimed_holding",
    rail: null,
    baas_provider: null,
    baas_transfer_id: null,
    created_at: now.toISOString(),
    settled_at: null,
    kind: "unclaimed_holding",
  });

  const journal = await postJournal(
    store,
    {
      kind: "unclaimed_identifier_hold_release",
      ref_type: "ledger_transaction",
      ref_id: settled.id,
      legs: [
        identifierHoldEscrowDebit(scopeKey, settled.amount_cents),
        unclaimedHoldingCredit(settled.amount_cents),
      ],
    },
    now,
  );
  if (!journal.ok) {
    return {
      ok: false,
      status: 422,
      code: journal.code,
      message: journal.message,
    };
  }

  // Zero-balance tripwire (the escrow family's invariant): the whole
  // locked amount moved to the holding credit — escrow debit + holding
  // credit = the lock, dust 0. A residual here is a balance bug, not a
  // rounding fact.
  if (
    !zeroBalanceHolds(
      settled.amount_cents,
      [{ amount_cents: settled.amount_cents }],
      0,
    )
  ) {
    return {
      ok: false,
      status: 500,
      code: "identifier_hold_residual_balance",
      message:
        "the release left a residual in the hold escrow — the ledger balance of record needs attention",
    };
  }

  return {
    ok: true,
    value: {
      escrow_credit: settled,
      released_credit: releasedCredit,
      journal_id: journal.journal.id,
    },
  };
}
