/**
 * The metadata matcher — the SDK's exact-ONLY identifier resolution.
 *
 * One rule shapes every line: a royalty event resolves to its asset by
 * exact identifier equality against `cbt_assets.mapped_identifiers`, and
 * nothing else. The locked lineage rule — "no fuzzy matching, no
 * auto-repair" (src/lib/covnant/lineage.ts, carried through the vault
 * adapter and the identifier registry) — holds here at the event level:
 *
 * - Lookup runs through the activated vault adapter's `findByIdentifier`
 *   (src/lib/covnant/vault.ts) — the same canonicalizer both sides of the
 *   comparison share, never a second opinion, never a near-miss scan.
 * - An event with no exact hit is quarantined — preserved with FULL
 *   provenance (raw payload, parsed identifiers, source, period) as a
 *   recovery candidate. It is never dropped and never "best-effort"
 *   attached to a lookalike asset.
 * - Quarantine never mutates asset storage: the matcher performs no
 *   UPDATE, no INSERT, and no repair against `cbt_assets` — identifiers
 *   enter the vault only through the attach surface.
 * - When an identifier is later attached, `rematchOpenEvents` re-runs the
 *   exact lookup for every open quarantined event and drains the ones
 *   that now hit. Matching grows as identifiers attach; the queue drains.
 *
 * The matcher performs NO money math — settlement is the split engines',
 * reached through the engine wire (a later PR). This module resolves
 * events to CBT codes and preserves what does not resolve.
 *
 * Persistence is the PR 3 Store seam's match_queue methods (this module
 * never touches store files); lookup is the PR 4 vault adapter. Both are
 * injected, so tests run on the in-memory store and a scripted db.
 */

import type { Db, DbClient } from '@/lib/db';
import {
  findByIdentifier,
  VAULT_EXTERNAL_IDENTIFIER_KINDS,
  type VaultExternalIdentifierKind,
} from '@/lib/covnant/vault';
import type { MatchQueueRecord } from '@/modules/sdk/records';
import type { Store } from '@/lib/server/store';

import type { IdentifierKind } from '../contracts/identifiers';
import type { CanonicalRoyaltyEvent } from '../contracts/royalty-event';
import { SdkMalformedInputError } from '../nodes/errors';

/** The one quarantine reason v1 can produce — exact matching has no near-miss vocabulary. */
export type MatchQueueQuarantineReason = 'no_identifier_match';

/** The quarantine reason constant, shared by the resolution and the queue row. */
export const NO_IDENTIFIER_MATCH: MatchQueueQuarantineReason = 'no_identifier_match';

/**
 * The matcher's outcome. `matched` carries the asset's canonical CBT code;
 * `quarantined` carries the match-queue row id the event is preserved under.
 * There is no third shape — no `best_effort`, no `likely_match`.
 */
export type MatchResolution =
  | { status: 'matched'; cbtCode: string }
  | { status: 'quarantined'; queueId: string; reason: MatchQueueQuarantineReason };

/** Page size for drain passes — mirrors the store's default list page. */
const DRAIN_PAGE = 200;

/** The store backends' unique-violation vocabulary (pg 23505 / sqlite + memory message). */
const UNIQUE_VIOLATION = /(UNIQUE constraint failed|23505)/;

const VAULT_KIND_SET: ReadonlySet<string> = new Set(VAULT_EXTERNAL_IDENTIFIER_KINDS);

/**
 * Whether the vault can resolve this kind at all. Creator-party kinds
 * (ISNI / IPI / IPN) belong to creator profiles — no asset storage holds
 * them yet — and NIL is the "no identifier exists" sentinel, which must
 * never assert a match from its own absence. Both are skipped, and an
 * event carrying only them quarantines.
 */
function isVaultKind(kind: string): kind is VaultExternalIdentifierKind {
  return VAULT_KIND_SET.has(kind);
}

/**
 * The queue row's verbatim raw-payload text. A string payload IS the
 * verbatim bytes; any other encodable payload travels as its JSON text.
 * A raw that cannot be serialized throws here rather than being silently
 * reshaped — the same discipline serializeRoyaltyEvent applies at the
 * contract boundary.
 */
export function rawPayloadText(raw: unknown): string {
  if (raw === undefined) return 'null';
  if (typeof raw === 'string') return raw;
  return JSON.stringify(raw);
}

/**
 * Builds the FULL-provenance quarantine row for one event — the pure core
 * of a quarantine. Every provenance field the queue carries is populated
 * from the canonical event: raw payload verbatim, parsed identifiers
 * verbatim, ingress source, period, and the fixed-point gross as exact
 * decimal text (never a float).
 */
export function quarantineProvenance(event: CanonicalRoyaltyEvent): Omit<MatchQueueRecord, 'id'> {
  return {
    event_id: event.eventId,
    status: 'open',
    reason: NO_IDENTIFIER_MATCH,
    rights_pipeline: event.rightsPipeline,
    source: event.source,
    platform: event.platform,
    territory: event.territory,
    period: event.period,
    currency: event.currency,
    gross_micros: event.grossMicros.toString(),
    identifiers_json: JSON.stringify(event.identifiers),
    raw_payload: rawPayloadText(event.raw),
    matched_cbt_code: null,
    resolved_at: null,
    created_at: new Date().toISOString(),
  };
}

/** Finds an already-open quarantine row for one event id, if any. */
async function findOpenEntryByEventId(
  store: Store,
  eventId: string,
): Promise<MatchQueueRecord | undefined> {
  const open = await store.listMatchQueueEntries('open', DRAIN_PAGE);
  return open.find((row) => row.event_id === eventId);
}

/**
 * Preserves one unmatched event. Quarantine-once: the store rejects a
 * replayed event_id, and a replay is not a second quarantine — the event
 * is already preserved, so the original row's id is returned. Any other
 * failure, or a violation whose row cannot be found again, rethrows —
 * never swallowed.
 */
async function quarantineEvent(
  store: Store,
  event: CanonicalRoyaltyEvent,
): Promise<MatchResolution> {
  try {
    const row = await store.insertMatchQueueEntry(quarantineProvenance(event));
    return { status: 'quarantined', queueId: row.id, reason: NO_IDENTIFIER_MATCH };
  } catch (error) {
    if (!(error instanceof Error) || !UNIQUE_VIOLATION.test(error.message)) throw error;
    const existing = await findOpenEntryByEventId(store, event.eventId);
    if (!existing) throw error;
    return { status: 'quarantined', queueId: existing.id, reason: NO_IDENTIFIER_MATCH };
  }
}

/**
 * The matcher's entry point. Tries the event's identifiers in canonical
 * order through the vault's exact lookup; the first exact hit resolves
 * the event to its asset's CBT code. No hit — including events carrying
 * only creator kinds or the NIL sentinel — quarantines the event with
 * full provenance. Exact-only, always: this function contains no
 * similarity logic, no tolerance, and no repair path by construction.
 */
export async function matchEvent(
  store: Store,
  db: Db | DbClient,
  event: CanonicalRoyaltyEvent,
): Promise<MatchResolution> {
  for (const [kind, value] of Object.entries(event.identifiers)) {
    // Creator-party kinds and the NIL sentinel cannot resolve against
    // asset storage — skipped, never guessed at.
    if (!isVaultKind(kind)) continue;
    const hit = await findByIdentifier(db, kind, value);
    if (hit) return { status: 'matched', cbtCode: hit.cbtCode };
  }
  return quarantineEvent(store, event);
}

/** The result of one drain pass over the open match queue. */
export interface MatchQueueDrainSummary {
  /** Open entries examined this pass. */
  readonly scanned: number;
  /** Entries resolved to their asset this pass. */
  readonly matched: number;
  /** Examined entries that still hold no exact hit. */
  readonly unmatched: number;
}

/**
 * Parses one queued row's identifiers back into (kind, value) pairs.
 * The quarantine path is this module's — rows it wrote always carry the
 * canonical map — so a row that does not parse is a wiring error, surfaced
 * as a typed structural refusal rather than silently treated as "no
 * identifiers".
 */
function parseQueuedIdentifiers(json: string | null): Array<[IdentifierKind, string]> {
  if (json === null || json.trim() === '') {
    throw new SdkMalformedInputError('corrupt_identifiers_json');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new SdkMalformedInputError('corrupt_identifiers_json');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new SdkMalformedInputError('corrupt_identifiers_json');
  }
  const entries: Array<[IdentifierKind, string]> = [];
  for (const [kind, value] of Object.entries(parsed)) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new SdkMalformedInputError(`corrupt_identifiers_json:${kind}`);
    }
    entries.push([kind as IdentifierKind, value]);
  }
  return entries;
}

/**
 * Re-runs the exact lookup for one quarantined row against CURRENT vault
 * storage; the asset's CBT code on the row's first exact hit, null when
 * the row still holds no match.
 */
async function matchQueuedRow(db: Db | DbClient, row: MatchQueueRecord): Promise<string | null> {
  for (const [kind, value] of parseQueuedIdentifiers(row.identifiers_json)) {
    if (!isVaultKind(kind)) continue;
    const hit = await findByIdentifier(db, kind, value);
    if (hit) return hit.cbtCode;
  }
  return null;
}

/**
 * The drain: re-matches every OPEN quarantined event against current
 * vault storage and resolves the ones that now hit. Call after identifiers
 * attach — matching grows as identifiers attach, and the queue drains.
 *
 * Pages through the open queue; a full page with zero resolutions stops
 * the pass honestly (the store lists newest-first from the head, so a
 * stale head with no hits cannot be skipped past). Idempotent: a pass
 * over an empty or fully-stale queue changes nothing.
 */
export async function rematchOpenEvents(
  store: Store,
  db: Db | DbClient,
): Promise<MatchQueueDrainSummary> {
  let scanned = 0;
  let matched = 0;
  for (;;) {
    const page = await store.listMatchQueueEntries('open', DRAIN_PAGE);
    if (page.length === 0) break;
    let matchedInPage = 0;
    for (const row of page) {
      scanned += 1;
      const cbtCode = await matchQueuedRow(db, row);
      if (cbtCode === null) continue;
      await store.resolveMatchQueueEntry(row.id, { status: 'matched', cbtCode });
      matchedInPage += 1;
      matched += 1;
    }
    if (page.length < DRAIN_PAGE) break;
    if (matchedInPage === 0) break;
  }
  return { scanned, matched, unmatched: scanned - matched };
}
