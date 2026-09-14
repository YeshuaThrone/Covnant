/**
 * Black-box royalty recovery — discovery and claim-case listing, v1.
 *
 * The build spec's recovery state (art_MzwqTXym): an event the system cannot
 * match today is a recovery candidate with full provenance (raw payload,
 * parsed identifiers, source, period) — "not a silent gap". Two record
 * universes carry that promise today (findings art_EGVYFSrV §D10–§D11):
 *
 * 1. Quarantined royalty events — the matcher's OPEN match-queue rows
 *    (covnant-sdk/src/match/match.ts), preserved verbatim with provenance.
 * 2. Unclaimed ledger credits — inbound money whose lineage lane
 *    (src/lib/covnant/lineage.ts) recorded `resolution: 'unmatched'`:
 *    payment references were parsed from the memo, but no catalog asset
 *    exact-matched them. This is the only unclaimed-money signal the
 *    ledger carries today.
 *
 * v1 scope is DISCOVERY + CLAIM-CASE LISTING, and nothing more (locked
 * rule). This module derives candidates, projects them into claim cases,
 * and reports what it could not read. It performs NO auto-repair — no
 * attach, no queue mutation, no ledger write, no re-matching (the matcher's
 * `rematchOpenEvents` owns draining the queue; the vault attach surface
 * owns new identifiers) — and NO money math (split and unit conversion
 * math stay with the locked engines). Amounts travel as verbatim text from
 * their records, never floats.
 *
 * Fail-closed reading: a record recovery cannot fully read is SKIPPED AND
 * SURFACED (typed reason in the discovery result), never silently dropped
 * and never partially reshaped. Money the module cannot affirm is
 * reported, not guessed at. Normal non-candidates — resolved queue rows,
 * exact-resolution lineage, rows with no lineage at all — are correct
 * absences, not skips.
 *
 * Persistence: none. Discovery reads the Store seam's match-queue list and
 * a caller-supplied ledger-row reader (no universal_royalty_ledger read
 * seam exists yet — the reader is injected so tests seed rows directly and
 * a route or worker can wire the live query later without rework, the same
 * adapter-level posture the vault adapter shipped with).
 */

import type { Store } from '@/lib/server/store';
import type { MatchQueueRecord } from '@/modules/sdk/records';

/** The store list page for one discovery pass — mirrors the matcher's drain page. */
const RECOVERY_QUEUE_PAGE = 200;

/**
 * Stable skip reasons — callers branch on these, never on prose. A skipped
 * record is money-bearing input recovery refused to derive from until it is
 * inspected; the underlying record is never touched.
 */
export const RECOVERY_SKIP_REASONS = {
  /** The queue row's identifiers_json is empty, unparsable, or not a string map. */
  corruptIdentifiersJson: 'corrupt_identifiers_json',
  /** The queue row's gross_micros is present but not non-negative integer text. */
  corruptGrossMicros: 'corrupt_gross_micros',
  /** The ledger row's reference_id is empty — the row cannot anchor a case id. */
  corruptReferenceId: 'corrupt_reference_id',
  /** The ledger row's amount_cents is not decimal text. */
  unparsableAmountCents: 'unparsable_amount_cents',
  /** The ledger row is not claimable money (zero or negative — e.g. a return). */
  nonCreditRow: 'non_credit_row',
  /** The ledger row's lineage metadata exists but is not structurally valid. */
  corruptLineageMetadata: 'corrupt_lineage_metadata',
} as const;

/** Where a recovery candidate was discovered. */
export type RecoveryCandidateSource = 'quarantined_event' | 'unclaimed_ledger_credit';

/**
 * One parsed payment-memo reference from an unclaimed credit's lineage.
 * Mirrors the lineage lane's ExternalReference shape with the kind held
 * open as a string — the memo lane's vocabulary can grow without this
 * module skipping real money over an unrecognized kind.
 */
export interface RecoveryLineageReference {
  readonly kind: string;
  readonly value: string;
  /** The exact matched substring from the source memo text. */
  readonly raw: string;
}

/**
 * A recovery candidate derived from one OPEN match-queue row — a quarantined
 * royalty event preserved with full provenance. Field names follow the
 * candidate's own vocabulary; the mapping from the queue row is 1:1.
 */
export interface QuarantinedEventCandidate {
  readonly source: 'quarantined_event';
  readonly queueId: string;
  readonly eventId: string;
  readonly rightsPipeline: MatchQueueRecord['rights_pipeline'];
  readonly ingressSource: MatchQueueRecord['source'];
  readonly platform: string | null;
  readonly territory: string | null;
  readonly period: string | null;
  readonly currency: string | null;
  /** Fixed-point gross in micros — verbatim text, never a float. Null on a legacy row that recorded none. */
  readonly grossMicros: string | null;
  /** Parsed identifier map, canonical kind keys to canonical values, as preserved by the matcher. */
  readonly identifiers: Readonly<Record<string, string>>;
  /** The event's raw payload, byte-verbatim. */
  readonly rawPayload: string;
  readonly quarantinedAt: string;
}

/**
 * A recovery candidate derived from one ledger credit whose lineage recorded
 * `resolution: 'unmatched'` — money arrived, references were parsed from the
 * memo, and no asset claimed them. The amount is the row's verbatim numeric
 * text (the ledger's own unit); recovery performs no conversion.
 */
export interface UnclaimedLedgerCreditCandidate {
  readonly source: 'unclaimed_ledger_credit';
  readonly referenceId: string;
  readonly transactionType: string | null;
  readonly amountCents: string;
  readonly currency: string | null;
  readonly references: readonly RecoveryLineageReference[];
  readonly lineageParsedAt: string | null;
  readonly recordedAt: string;
}

export type RecoveryCandidate =
  | QuarantinedEventCandidate
  | UnclaimedLedgerCreditCandidate;

/**
 * The ledger row port — the shape of a money-lane `universal_royalty_ledger`
 * row as the inbound royalty webhook writes it (reference_id unique,
 * amount_cents numeric text, open-TEXT transaction_type, additive metadata
 * JSONB). Recovery never queries the table itself; callers inject a reader
 * over these rows.
 */
export interface RecoveryLedgerRow {
  readonly reference_id: string;
  readonly amount_cents: string;
  readonly transaction_type: string | null;
  readonly currency: string | null;
  readonly metadata: unknown;
  readonly created_at: string;
}

/** One record recovery examined and refused to derive from — surfaced, never silent. */
export interface RecoverySkippedRecord {
  readonly source: RecoveryCandidateSource;
  /** The underlying record's id — the queue row id or the ledger reference_id when parseable. */
  readonly recordId: string;
  /** Stable machine reason — see RECOVERY_SKIP_REASONS. */
  readonly reason: string;
  /** Optional offending-key detail for the operator. */
  readonly detail: string | null;
}

export interface RecoveryDiscovery {
  readonly candidates: readonly RecoveryCandidate[];
  readonly skipped: readonly RecoverySkippedRecord[];
}

/** The raw inputs to one pure discovery pass. */
export interface RecoverySources {
  /** Open match-queue rows (the store's newest-first list). */
  readonly quarantinedRows: readonly MatchQueueRecord[];
  /** Ledger rows in the caller's chosen order and window. */
  readonly ledgerRows: readonly RecoveryLedgerRow[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type QueueRowDerivation =
  | { outcome: 'candidate'; candidate: QuarantinedEventCandidate }
  | { outcome: 'not_eligible' }
  | { outcome: 'skipped'; reason: string; detail?: string };

/**
 * Parses one queue row's identifiers back into a canonical kind→value map.
 * The quarantine path is the matcher's — rows it wrote always carry the
 * canonical map — so a row that does not parse is surfaced as a skip, not
 * silently treated as "no identifiers".
 */
function parseQueuedIdentifiers(
  json: string | null,
): { ok: true; identifiers: Record<string, string> } | { ok: false; detail: string } {
  if (json === null || json.trim() === '') {
    return { ok: false, detail: 'identifiers_json is empty' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, detail: 'identifiers_json is not valid JSON' };
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, detail: 'identifiers_json is not an object' };
  }
  const identifiers: Record<string, string> = {};
  for (const [kind, value] of Object.entries(parsed)) {
    if (typeof value !== 'string' || value.length === 0) {
      return { ok: false, detail: `identifiers_json.${kind} is not a non-empty string` };
    }
    identifiers[kind] = value;
  }
  return { ok: true, identifiers };
}

/** Derives one candidate from one match-queue row. */
function deriveQuarantinedRow(row: MatchQueueRecord): QueueRowDerivation {
  // Matched and discarded rows are resolved history — the matcher drained
  // them or an operator closed them. Their absence from recovery is correct,
  // not a skip.
  if (row.status !== 'open') return { outcome: 'not_eligible' };

  const identifiers = parseQueuedIdentifiers(row.identifiers_json);
  if (!identifiers.ok) {
    return {
      outcome: 'skipped',
      reason: RECOVERY_SKIP_REASONS.corruptIdentifiersJson,
      detail: identifiers.detail,
    };
  }

  // Verbatim fixed-point text, digits only. A legacy row that recorded no
  // gross still lists — its amount is unknown, its provenance is intact.
  let grossMicros: string | null = null;
  if (row.gross_micros !== null) {
    const text = row.gross_micros.trim();
    if (!/^\d+$/.test(text)) {
      return { outcome: 'skipped', reason: RECOVERY_SKIP_REASONS.corruptGrossMicros };
    }
    grossMicros = text;
  }

  return {
    outcome: 'candidate',
    candidate: {
      source: 'quarantined_event',
      queueId: row.id,
      eventId: row.event_id,
      rightsPipeline: row.rights_pipeline,
      ingressSource: row.source,
      platform: row.platform,
      territory: row.territory,
      period: row.period,
      currency: row.currency,
      grossMicros,
      identifiers: identifiers.identifiers,
      rawPayload: row.raw_payload,
      quarantinedAt: row.created_at,
    },
  };
}

type LedgerRowDerivation =
  | { outcome: 'candidate'; candidate: UnclaimedLedgerCreditCandidate }
  | { outcome: 'not_eligible' }
  | { outcome: 'skipped'; reason: string; detail?: string };

/** Zero in verbatim decimal text — every char a zero or the decimal point. */
function isZeroAmountText(amount: string): boolean {
  return /^[0.]+$/.test(amount);
}

/**
 * Validates one lineage metadata object. Returns the parsed lane, a
 * not-eligible marker when the row carries no lineage lane at all (normal —
 * the webhook writes lineage only when memo references were parsed), or a
 * corrupt marker when a lane exists but will not read.
 */
function parseRowLineage(
  metadata: unknown,
): { outcome: 'no_lineage' } | { outcome: 'corrupt'; detail: string } | { outcome: 'lineage'; resolution: 'unmatched'; references: RecoveryLineageReference[]; parsedAt: string | null } {
  if (metadata === null || metadata === undefined) return { outcome: 'no_lineage' };
  if (!isPlainObject(metadata)) return { outcome: 'corrupt', detail: 'metadata is not an object' };
  const lineage = metadata['lineage'];
  if (lineage === null || lineage === undefined) return { outcome: 'no_lineage' };
  if (!isPlainObject(lineage)) return { outcome: 'corrupt', detail: 'lineage is not an object' };

  const resolution = lineage['resolution'];
  // 'exact' is a claimed credit — correct absence, not a skip.
  if (resolution === 'exact') return { outcome: 'no_lineage' };
  if (resolution !== 'unmatched') {
    return { outcome: 'corrupt', detail: 'lineage.resolution is not a known resolution' };
  }

  const rawReferences = lineage['references'];
  if (!Array.isArray(rawReferences)) {
    return { outcome: 'corrupt', detail: 'lineage.references is not an array' };
  }
  const references: RecoveryLineageReference[] = [];
  for (const item of rawReferences) {
    if (
      !isPlainObject(item) ||
      typeof item['kind'] !== 'string' || item['kind'].length === 0 ||
      typeof item['value'] !== 'string' || item['value'].length === 0 ||
      typeof item['raw'] !== 'string'
    ) {
      return { outcome: 'corrupt', detail: 'lineage.references holds a malformed reference' };
    }
    references.push({ kind: item['kind'], value: item['value'], raw: item['raw'] });
  }

  const parsedAt = lineage['parsedAt'];
  return {
    outcome: 'lineage',
    resolution: 'unmatched',
    references,
    parsedAt: typeof parsedAt === 'string' ? parsedAt : null,
  };
}

/** Derives one candidate from one ledger row. */
function deriveLedgerRow(row: RecoveryLedgerRow): LedgerRowDerivation {
  if (row.reference_id.trim() === '') {
    return { outcome: 'skipped', reason: RECOVERY_SKIP_REASONS.corruptReferenceId };
  }

  // Sign classification only — verbatim text in, no conversion, no rounding.
  const amount = row.amount_cents.trim();
  if (!/^-?\d+(\.\d+)?$/.test(amount)) {
    return { outcome: 'skipped', reason: RECOVERY_SKIP_REASONS.unparsableAmountCents };
  }
  if (amount.startsWith('-') || isZeroAmountText(amount)) {
    // A return or a zero credit is not claimable money — surfaced so the
    // operator sees the row was examined, never silently dropped.
    return { outcome: 'skipped', reason: RECOVERY_SKIP_REASONS.nonCreditRow };
  }

  const lineage = parseRowLineage(row.metadata);
  if (lineage.outcome === 'no_lineage') return { outcome: 'not_eligible' };
  if (lineage.outcome === 'corrupt') {
    return { outcome: 'skipped', reason: RECOVERY_SKIP_REASONS.corruptLineageMetadata, detail: lineage.detail };
  }

  return {
    outcome: 'candidate',
    candidate: {
      source: 'unclaimed_ledger_credit',
      referenceId: row.reference_id,
      transactionType: row.transaction_type,
      amountCents: amount,
      currency: row.currency,
      references: lineage.references,
      lineageParsedAt: lineage.parsedAt,
      recordedAt: row.created_at,
    },
  };
}

/**
 * The pure derivation core: candidates from open quarantined events and
 * unclaimed ledger credits, in stable order (queue rows in the order
 * listed, then ledger rows in the order supplied), with every refusal
 * surfaced. Deterministic — the same sources always derive the same
 * discovery.
 */
export function deriveRecoveryCandidates(sources: RecoverySources): RecoveryDiscovery {
  const candidates: RecoveryCandidate[] = [];
  const skipped: RecoverySkippedRecord[] = [];

  for (const row of sources.quarantinedRows) {
    const derived = deriveQuarantinedRow(row);
    if (derived.outcome === 'candidate') candidates.push(derived.candidate);
    else if (derived.outcome === 'skipped') {
      skipped.push({
        source: 'quarantined_event',
        recordId: row.id,
        reason: derived.reason,
        detail: derived.detail ?? null,
      });
    }
  }

  for (const row of sources.ledgerRows) {
    const derived = deriveLedgerRow(row);
    if (derived.outcome === 'candidate') candidates.push(derived.candidate);
    else if (derived.outcome === 'skipped') {
      skipped.push({
        source: 'unclaimed_ledger_credit',
        recordId: row.reference_id.trim() === '' ? '<unknown>' : row.reference_id,
        reason: derived.reason,
        detail: derived.detail ?? null,
      });
    }
  }

  return { candidates, skipped };
}

/** The listing state of one claim case. v1 lists recoverable cases only; the workflow around them is a later surface. */
export type RecoveryClaimCaseStatus = 'recoverable';

/**
 * One recoverable money item, projected 1:1 from its candidate with a
 * deterministic case id. A claim case is the operator-facing unit: this
 * money, this provenance, recoverable through the exact-match path —
 * attach the identifier its references carry, then let the matcher drain.
 */
export interface RecoveryClaimCase {
  readonly caseId: string;
  readonly status: RecoveryClaimCaseStatus;
  readonly source: RecoveryCandidateSource;
  /** The underlying record's own timestamp — when the money was quarantined or recorded. */
  readonly discoveredAt: string;
  readonly candidate: RecoveryCandidate;
}

export interface RecoveryClaimCaseSummary {
  readonly totalCases: number;
  readonly quarantinedEvents: number;
  readonly unclaimedLedgerCredits: number;
  /** Records recovery refused to derive from — surfaced for inspection. */
  readonly skipped: number;
}

export interface RecoveryClaimCaseListing {
  readonly cases: readonly RecoveryClaimCase[];
  readonly summary: RecoveryClaimCaseSummary;
}

/**
 * A claim case's deterministic id, anchored to the underlying record's
 * unique key — stable across discovery passes and across processes.
 */
export function claimCaseId(candidate: RecoveryCandidate): string {
  return candidate.source === 'quarantined_event'
    ? `recovery:quarantined_event:${candidate.queueId}`
    : `recovery:unclaimed_ledger_credit:${candidate.referenceId}`;
}

/** Projects a discovery into the claim-case listing — pure, order-preserving, 1:1. */
export function deriveClaimCases(discovery: RecoveryDiscovery): RecoveryClaimCaseListing {
  const cases = discovery.candidates.map((candidate) => ({
    caseId: claimCaseId(candidate),
    status: 'recoverable' as const,
    source: candidate.source,
    discoveredAt:
      candidate.source === 'quarantined_event' ? candidate.quarantinedAt : candidate.recordedAt,
    candidate,
  }));
  const quarantinedEvents = cases.filter((entry) => entry.source === 'quarantined_event').length;
  return {
    cases,
    summary: {
      totalCases: cases.length,
      quarantinedEvents,
      unclaimedLedgerCredits: cases.length - quarantinedEvents,
      skipped: discovery.skipped.length,
    },
  };
}

/** The injected read seam for ledger rows — a route or worker wires the live query; tests seed arrays. */
export type RecoveryLedgerRowReader = () => Promise<readonly RecoveryLedgerRow[]>;

/**
 * Discovers recovery candidates from live state: the store's open match
 * queue plus the caller's ledger reader. One bounded window of the queue
 * (the seam has no offset pagination, and listing never mutates the queue,
 * so a pass cannot advance its own head) — rows past the window surface on
 * the next discovery after the queue drains or resolves.
 */
export async function discoverRecoveryCandidates(
  store: Store,
  readLedgerRows: RecoveryLedgerRowReader,
): Promise<RecoveryDiscovery> {
  const quarantinedRows = await store.listMatchQueueEntries('open', RECOVERY_QUEUE_PAGE);
  const ledgerRows = await readLedgerRows();
  return deriveRecoveryCandidates({ quarantinedRows, ledgerRows });
}

/**
 * Lists claim cases: discovery, then the claim-case projection. Read-only
 * end to end — no attach, no queue write, no ledger write, no re-match.
 */
export async function listClaimCases(
  store: Store,
  readLedgerRows: RecoveryLedgerRowReader,
): Promise<RecoveryClaimCaseListing> {
  return deriveClaimCases(await discoverRecoveryCandidates(store, readLedgerRows));
}
