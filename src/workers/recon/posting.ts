/**
 * CVT recon worker — canonical posting seam, ACTIVATED (PR 2's dormant
 * follow-up, wired to PR 7's UNCLAIMED_HOLDING state).
 *
 * A parsed statement line whose identifiers match a verified vault track
 * (matched_cbt_code set) carries real money with no verified allocation —
 * exactly PR 7's holding predicate: it must not silently sit in FBO cash
 * and must not silently become someone's balance. This module posts that
 * gross, in whole integer cents, to UNCLAIMED_HOLDING through
 * postToUnclaimedHolding with source { type: 'match_queue', event_id } —
 * the quarantined event IS the line item, so the recovery discovery pairs
 * the held credit with its queue row through the existing line-item index.
 *
 * FAIL-CLOSED, the locked discipline:
 * - the match_queue row (unique event_id) is written BEFORE this module
 *   runs, so a posting failure never drops the event — the row stays open
 *   as the quarantine record and a retry heals it idempotently;
 * - the per-source replay guard is PR 7's journal-ref check (one journal
 *   per source id, 409 on re-post) — a replayed post is a counted no-op,
 *   never a second credit and never a failure;
 * - ANY other posting failure throws CanonicalPostingError, which fails
 *   the job with the row-scoped reason (failReconJob) — never silent,
 *   never swallowed, never partially passed off as complete.
 *
 * WHAT THIS SEAM DOES NOT DO (the standing payout gates are untouched):
 * money reaches a creator payee ONLY through releaseUnclaimedHolding's
 * clearance-gated settlement path (fail-closed evaluatePayoutCompliance —
 * operator settlement approval, Plaid-backed verified KYC, and the
 * vertical's compliance state: IAB impression verification and network
 * commission for podcasts, CAMA escrow and guild holdbacks for film).
 * This seam's only ledger writes are the sentinel holding credit and its
 * balanced journal — it structurally cannot pay a creator, bypass a
 * withholding escrow, or mint dust.
 */

import type { Store } from "@/lib/server/store";
import {
  postToUnclaimedHolding,
  type UnclaimedHoldingFailure,
  type UnclaimedHoldingPostSuccess,
} from "@/lib/server/unclaimedHolding";
import {
  postIdentifierHoldEscrow,
  type IdentifierHoldEscrowFailure,
} from "@/lib/server/identifierHoldEscrow";
import type {
  ParsedStatementLine,
  ReconIdentifierKind,
} from "./records";
import type { LineWriteOutcome } from "./matchQueue";

/** A posting failure is a job failure — row-scoped, never silent. */
export class CanonicalPostingError extends Error {
  readonly eventId: string;
  readonly code: string;

  constructor(eventId: string, code: string, message: string) {
    super(message);
    this.name = "CanonicalPostingError";
    this.eventId = eventId;
    this.code = code;
  }
}

/** 1 ledger cent = 10^6 statement micros (the SDK's 1e-8 micros space). */
export const MICROS_PER_CENT = 1_000_000n;

/**
 * Floor-divides statement micros into whole ledger cents — the exact bigint
 * conversion, no floats. Sub-cent residue never rounds up (the ledger never
 * invents money); a value outside the safe-integer cent range is refused
 * rather than truncated dishonestly.
 */
export function microsToWholeCents(micros: bigint): number {
  const cents = micros / MICROS_PER_CENT;
  const value = Number(cents);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`micros_to_cents_overflow: ${micros} micros exceeds the safe integer-cent range`);
  }
  return value;
}

/** Posting counts for one ingest — the honest completion report's inputs. */
export interface PostingCounts {
  /** Matched lines credited to UNCLAIMED_HOLDING this pass. */
  posted: number;
  /** Matched lines whose post hit the per-source replay guard (no-ops). */
  alreadyPosted: number;
}

/**
 * True when the line is the posting seam's subject: a MUSIC rights line
 * (MASTER or PUBLISHING) that matched a verified track. Film receipt lines
 * and guild residual holds are rights_type 'unknown' on purpose — they ride
 * the film waterfall's own ledger machinery (PR #85/#87) and the split-
 * quarantine rule, never this seam. Adjustments (signed-negative lines) are
 * recorded in the queue but never post as money.
 */
export function isPostableLine(
  line: ParsedStatementLine,
  matchedCbtCode: string | null,
): boolean {
  return (
    matchedCbtCode !== null &&
    line.rightsType !== "unknown" &&
    !line.isAdjustment &&
    line.grossMicros > 0n
  );
}

/**
 * Posts every postable matched line to UNCLAIMED_HOLDING. Idempotent per
 * line: a replayed ingest re-enters here, each post reads PR 7's 409
 * journal-ref guard, and the pass completes as counted no-ops. Any other
 * failure throws — the caller's failReconJob records the row-scoped reason
 * and the store's retry budget re-runs the whole idempotent pass.
 */
export async function postMatchedLinesToHolding(
  store: Store,
  outcomes: readonly LineWriteOutcome[],
  now: Date,
): Promise<PostingCounts> {
  const counts: PostingCounts = { posted: 0, alreadyPosted: 0 };
  for (const outcome of outcomes) {
    if (!isPostableLine(outcome.line, outcome.matchedCbtCode)) continue;

    let posted: UnclaimedHoldingPostSuccess | UnclaimedHoldingFailure;
    try {
      const amountCents = microsToWholeCents(outcome.line.grossMicros);
      // A matched line worth less than a whole cent cannot exist in the
      // integer-cent ledger — it stays honestly quarantined in its queue row
      // (never rounded up into invented money, never silently dropped).
      if (amountCents <= 0) continue;

      posted = await postToUnclaimedHolding(
        store,
        {
          amount_cents: amountCents,
          currency: outcome.line.currency,
          source: { type: "match_queue", event_id: outcome.eventId },
          // No split_run_id — the ingest linkage rides line_item_id and the
          // event_id itself (`recon:<ingestId>:line:N`); a split run does not
          // exist yet at parse time, and no id space may be conflated.
          split_run_id: null,
        },
        now,
      );
    } catch (cause) {
      // PR 7's guards RETURN Failure results; a store-level exception THROWS
      // raw past them. Classify it — never swallow, never let it pose as an
      // anonymous crash: the same row-scoped job-failing reason as a guard
      // refusal, so the retry budget heals through the same idempotent pass
      // and the queue row stays the quarantine record.
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new CanonicalPostingError(
        outcome.eventId,
        "ledger_store_error",
        `unclaimed_holding_post_failed:${outcome.eventId}:ledger_store_error:${message}`,
      );
    }
    if (posted.ok) {
      counts.posted += 1;
      continue;
    }
    if (isReplayRefusal(posted)) {
      counts.alreadyPosted += 1;
      continue;
    }
    throw new CanonicalPostingError(
      outcome.eventId,
      posted.code,
      `unclaimed_holding_post_failed:${outcome.eventId}:${posted.code}:${posted.message}`,
    );
  }
  return counts;
}

/** The replay guard's exact refusal — a 409 is a no-op, anything else fails. */
function isReplayRefusal(failure: UnclaimedHoldingFailure): boolean {
  return (
    failure.status === 409 &&
    failure.code === "unclaimed_holding_already_posted"
  );
}

// ---------------------------------------------------------------------------
// The unmatched-code fallback's automatic escrow (PR 53, the founder
// universal-identifier directive).
//
// An UNMATCHED postable line (rights family not 'unknown', not an
// adjustment, gross > 0) whose primary identifier carries NO verified
// cross-links — the detector's (PR 52) missing-cross-link condition,
// evaluated here at posting time against the line's own identifiers —
// must not sit in FBO cash and must not route anywhere as if it were
// matched. This pass locks the line's whole gross into the
// UNCLAIMED_IDENTIFIER_HOLD escrow per identifier scope, from which only
// the registry-verified evidence-gated release can move it.
//
// Boundary, the detector's own: a line with NO identifiers at all stays
// honestly unmatched in its queue row — the detector flags records that
// HAVE a primary identifier and no cross-links; an identifier-less line
// has no scope to hold under and no claim to verify. Rights_type
// 'unknown' lines (film receipts, guild residuals) keep their own ledger
// machinery; adjustments never post as money.
// ---------------------------------------------------------------------------

/** Routing counts for one ingest — the honest completion report's inputs. */
export interface IdentifierHoldRoutingCounts {
  /** Unmatched lines locked into the identifier hold this pass. */
  heldPosted: number;
  /** Unmatched lines whose hold post hit the per-source replay guard. */
  heldReplayed: number;
}

/**
 * The fixed lookup priority for a line's PRIMARY identifier — the scope
 * the escrow locks under. First hit wins; a line with none of these has
 * no primary and stays honestly unmatched.
 */
const HOLD_IDENTIFIER_PRIORITY = [
  "ISRC",
  "ISWC",
  "UPC",
  "EIDR",
  "DOI",
  "ISBN",
] as const;

/**
 * The line's primary identifier: the first non-empty value in the fixed
 * priority order, else the record's own first key (deterministic per
 * line). Null when the line carries no identifiers at all.
 */
export function primaryIdentifierForLine(
  line: ParsedStatementLine,
): { primaryCodeType: string; primaryCodeValue: string } | null {
  for (const kind of HOLD_IDENTIFIER_PRIORITY) {
    const value = line.identifiers[kind];
    if (typeof value === "string" && value.trim() !== "") {
      return { primaryCodeType: kind, primaryCodeValue: value.trim() };
    }
  }
  const first = (Object.entries(line.identifiers) as [
    ReconIdentifierKind,
    string | undefined,
  ][]).find(([, v]) => typeof v === "string" && (v ?? "").trim() !== "");
  if (first !== undefined) {
    return {
      primaryCodeType: first[0],
      primaryCodeValue: (first[1] ?? "").trim(),
    };
  }
  return null;
}

/**
 * True when the line is the identifier-hold pass's subject: an UNMATCHED
 * postable line WITH a primary identifier — the detector's
 * missing-cross-link money condition at posting time.
 */
export function isIdentifierHoldCandidate(
  line: ParsedStatementLine,
  matchedCbtCode: string | null,
): boolean {
  return (
    matchedCbtCode === null &&
    line.rightsType !== "unknown" &&
    !line.isAdjustment &&
    line.grossMicros > 0n &&
    primaryIdentifierForLine(line) !== null
  );
}

/**
 * Routes every unmatched candidate line into the UNCLAIMED_IDENTIFIER_HOLD
 * escrow. Idempotent per line: a replayed ingest re-enters here, each post
 * reads the escrow's journal-ref guard (409, counted no-op), and the pass
 * completes. Any other refusal or store-level exception throws — the
 * caller's failReconJob records the row-scoped reason and the store's
 * retry budget re-runs the whole idempotent pass. (This pass runs AFTER
 * postMatchedLinesToHolding: matched lines never enter it — the escrow
 * lock is exclusively the fallback detector's money rule.)
 */
export async function postUnmatchedLinesToIdentifierHold(
  store: Store,
  outcomes: readonly LineWriteOutcome[],
  now: Date,
): Promise<IdentifierHoldRoutingCounts> {
  const counts: IdentifierHoldRoutingCounts = { heldPosted: 0, heldReplayed: 0 };
  for (const outcome of outcomes) {
    if (!isIdentifierHoldCandidate(outcome.line, outcome.matchedCbtCode)) {
      continue;
    }
    const primary = primaryIdentifierForLine(outcome.line);
    if (primary === null) continue;

    let amountCents: number;
    try {
      amountCents = microsToWholeCents(outcome.line.grossMicros);
      // A line worth less than a whole cent cannot exist in the
      // integer-cent ledger — it stays honestly quarantined in its queue
      // row (never rounded up into invented money, never dropped).
      if (amountCents <= 0) continue;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new CanonicalPostingError(
        outcome.eventId,
        "ledger_store_error",
        `identifier_hold_post_failed:${outcome.eventId}:ledger_store_error:${message}`,
      );
    }

    let held:
      | { ok: true; value: { escrow_credit: unknown; journal_id: string } }
      | IdentifierHoldEscrowFailure;
    try {
      held = await postIdentifierHoldEscrow(
        store,
        {
          amount_cents: amountCents,
          currency: outcome.line.currency,
          primaryCodeType: primary.primaryCodeType,
          primaryCodeValue: primary.primaryCodeValue,
          sourceEventId: outcome.eventId,
        },
        now,
      );
    } catch (cause) {
      // A store-level exception THROWS raw past the guard refusals.
      // Classify it — never swallow, never let it pose as an anonymous
      // crash: the same row-scoped job-failing reason as a guard refusal,
      // so the retry budget heals through the same idempotent pass.
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new CanonicalPostingError(
        outcome.eventId,
        "ledger_store_error",
        `identifier_hold_post_failed:${outcome.eventId}:ledger_store_error:${message}`,
      );
    }
    if (held.ok) {
      counts.heldPosted += 1;
      continue;
    }
    if (
      held.status === 409 &&
      held.code === "identifier_hold_already_posted"
    ) {
      counts.heldReplayed += 1;
      continue;
    }
    throw new CanonicalPostingError(
      outcome.eventId,
      held.code,
      `identifier_hold_post_failed:${outcome.eventId}:${held.code}:${held.message}`,
    );
  }
  return counts;
}
