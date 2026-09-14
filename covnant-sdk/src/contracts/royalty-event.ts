/**
 * The canonical royalty event — the shape every collection surface (webhook,
 * statement file, API pull) is normalized into before anything else in the
 * SDK touches it.
 *
 * Two disciplines shape this module:
 *
 * 1. Money precision — `grossMicros` is a bigint in the 1e-8 fixed-point
 *    space of src/lib/fixed-point.ts (MICRO units, 10⁸ per currency unit).
 *    Floats never enter the SDK's money path.
 * 2. The type boundary — TypeScript types cannot reject anything at runtime,
 *    so the entry point of the boundary is `parseCanonicalRoyaltyEvent`:
 *    parse, don't cast. A `CanonicalRoyaltyEvent` value in memory is
 *    canonical by construction; the parser enforces the exact key set, the
 *    "at least one identifier" rule, and that every identifier value is
 *    already canonical (re-canonicalizing it returns it unchanged).
 *
 * `raw` keeps the verbatim source payload — audit never loses the original.
 * Reversals and adjustments are not collection events; they travel the
 * existing royalty.reversed path, so a canonical event's gross is
 * non-negative.
 */

import {
  canonicalizeIdentifier,
  isIdentifierKind,
  type IdentifierKind,
} from './identifiers';

/**
 * The four rights pipelines, in mission order — the typed version of the
 * mission's four-pipeline rule.
 */
export type RightsPipeline =
  | 'composition_performance'
  | 'composition_mechanical'
  | 'master_digital_performance'
  | 'master_interactive';

/** How the event arrived at the SDK. */
export type RoyaltyEventSource = 'webhook' | 'statement' | 'api_pull';

/** The statement wire formats v1 parses; present only on statement events. */
export type StatementFormat = 'ddex-rdr' | 'cwr' | 'csv';

export const RIGHTS_PIPELINES: readonly RightsPipeline[] = [
  'composition_performance',
  'composition_mechanical',
  'master_digital_performance',
  'master_interactive',
];

export const ROYALTY_EVENT_SOURCES: readonly RoyaltyEventSource[] = [
  'webhook',
  'statement',
  'api_pull',
];

export const STATEMENT_FORMATS: readonly StatementFormat[] = ['ddex-rdr', 'cwr', 'csv'];

/**
 * The canonical event. `identifiers` carries canonicalized values keyed by
 * their IdentifierKind — at least one entry is required (an event with no
 * identifier is malformed at the boundary; unmatched-but-valid events are a
 * matcher concern, not a contract concern). `period` is deliberately a plain
 * string (the spec's '2026-08' is an example, not a grammar — statement
 * periods vary by source and v1 does not guess).
 */
export interface CanonicalRoyaltyEvent {
  /** Idempotency key — mirrors the source's event_id / reference_id discipline. */
  readonly eventId: string;
  readonly rightsPipeline: RightsPipeline;
  readonly source: RoyaltyEventSource;
  /** Present only when `source` is 'statement'. */
  readonly statementFormat?: StatementFormat;
  /** e.g. '2026-08'; null when the source carries no period. */
  readonly period: string | null;
  /** ISO 4217 alpha-3. */
  readonly currency: string;
  /** 1e-8 fixed point (src/lib/fixed-point.ts MICRO discipline); never negative. */
  readonly grossMicros: bigint;
  /** Canonicalized values keyed by kind; at least one entry. */
  readonly identifiers: Partial<Record<IdentifierKind, string>>;
  /** The claims platform enum value when UGC; null otherwise. */
  readonly platform: string | null;
  /** ISO 3166-1 alpha-2; null when the source carries no territory. */
  readonly territory: string | null;
  /** The verbatim source payload — audit never loses the original. */
  readonly raw: unknown;
}

/** The parse result at the type boundary: either a canonical event or a reason. */
export type ParsedRoyaltyEvent =
  | { ok: true; event: CanonicalRoyaltyEvent }
  | { ok: false; reason: string };

export function isRightsPipeline(value: unknown): value is RightsPipeline {
  return (
    typeof value === 'string' && RIGHTS_PIPELINES.includes(value as RightsPipeline)
  );
}

function isRoyaltyEventSource(value: unknown): value is RoyaltyEventSource {
  return (
    typeof value === 'string' && ROYALTY_EVENT_SOURCES.includes(value as RoyaltyEventSource)
  );
}

function isStatementFormat(value: unknown): value is StatementFormat {
  return typeof value === 'string' && STATEMENT_FORMATS.includes(value as StatementFormat);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** The event's exact top-level key set — statementFormat is the one optional key. */
const EVENT_KEYS: readonly string[] = [
  'eventId',
  'rightsPipeline',
  'source',
  'statementFormat',
  'period',
  'currency',
  'grossMicros',
  'identifiers',
  'platform',
  'territory',
  'raw',
];

const REQUIRED_KEYS: readonly string[] = EVENT_KEYS.filter((key) => key !== 'statementFormat');

function reject(reason: string): ParsedRoyaltyEvent {
  return { ok: false, reason };
}

/**
 * Verifies the identifiers map and returns either a stable rejection reason or
 * the map rebuilt with its keys narrowed to IdentifierKind — the parser never
 * casts: the verified map becomes the event's identifiers directly.
 */
function validateIdentifiers(
  value: unknown,
): { ok: true; identifiers: Partial<Record<IdentifierKind, string>> } | { ok: false; reason: string } {
  if (!isPlainObject(value)) return { ok: false, reason: 'identifiers_not_an_object' };
  const entries = Object.entries(value);
  if (entries.length === 0) return { ok: false, reason: 'identifiers_empty' };
  const identifiers: Partial<Record<IdentifierKind, string>> = {};
  for (const [kind, rawValue] of entries) {
    if (typeof rawValue !== 'string' || rawValue.length === 0) {
      return { ok: false, reason: `invalid_identifier_value:${kind}` };
    }
    if (!isIdentifierKind(kind)) {
      return { ok: false, reason: `unknown_identifier_kind:${kind}` };
    }
    if (canonicalizeIdentifier(kind, rawValue) !== rawValue) {
      return { ok: false, reason: `non_canonical_identifier:${kind}` };
    }
    identifiers[kind] = rawValue;
  }
  return { ok: true, identifiers };
}

/**
 * The type boundary. Accepts `unknown` and either returns the canonical
 * event or a stable, testable reason — never a guessed coercion. Unknown
 * top-level keys are rejected: the canonical event has exactly its keys.
 */
export function parseCanonicalRoyaltyEvent(value: unknown): ParsedRoyaltyEvent {
  if (!isPlainObject(value)) return reject('not_an_object');

  for (const key of Object.keys(value)) {
    if (!EVENT_KEYS.includes(key)) return reject(`unknown_key:${key}`);
  }
  for (const key of REQUIRED_KEYS) {
    if (!(key in value)) return reject(`missing_key:${key}`);
  }

  const eventId = value.eventId;
  if (
    typeof eventId !== 'string' ||
    eventId.length === 0 ||
    eventId.length > 512 ||
    eventId !== eventId.trim()
  ) {
    return reject('invalid_event_id');
  }

  if (!isRightsPipeline(value.rightsPipeline)) {
    return reject(`invalid_rights_pipeline:${String(value.rightsPipeline)}`);
  }
  if (!isRoyaltyEventSource(value.source)) {
    return reject(`invalid_source:${String(value.source)}`);
  }

  let statementFormat: StatementFormat | undefined;
  if ('statementFormat' in value) {
    if (!isStatementFormat(value.statementFormat)) {
      return reject(`invalid_statement_format:${String(value.statementFormat)}`);
    }
    if (value.source !== 'statement') {
      return reject('statement_format_requires_statement_source');
    }
    statementFormat = value.statementFormat;
  }

  let period: string | null = null;
  const periodValue = value.period;
  if (periodValue !== null) {
    if (
      typeof periodValue !== 'string' ||
      periodValue.length === 0 ||
      periodValue.length > 64 ||
      CONTROL_CHARS.test(periodValue)
    ) {
      return reject('invalid_period');
    }
    period = periodValue;
  }

  const currency = value.currency;
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) {
    return reject(`invalid_currency:${String(currency)}`);
  }

  if (typeof value.grossMicros !== 'bigint' || value.grossMicros < 0n) {
    return reject('invalid_gross_micros');
  }

  const identifiers = validateIdentifiers(value.identifiers);
  if (!identifiers.ok) return reject(identifiers.reason);

  let platform: string | null = null;
  const platformValue = value.platform;
  if (platformValue !== null) {
    if (
      typeof platformValue !== 'string' ||
      platformValue.length === 0 ||
      platformValue.length > 128 ||
      platformValue !== platformValue.trim()
    ) {
      return reject('invalid_platform');
    }
    platform = platformValue;
  }

  let territory: string | null = null;
  const territoryValue = value.territory;
  if (territoryValue !== null) {
    if (typeof territoryValue !== 'string' || !/^[A-Z]{2}$/.test(territoryValue)) {
      return reject('invalid_territory');
    }
    territory = territoryValue;
  }

  return {
    ok: true,
    event: {
      eventId,
      rightsPipeline: value.rightsPipeline,
      source: value.source,
      ...(statementFormat === undefined ? {} : { statementFormat }),
      period,
      currency,
      grossMicros: value.grossMicros,
      identifiers: identifiers.identifiers,
      platform,
      territory,
      raw: value.raw,
    },
  };
}

/**
 * Lossless transport form. `grossMicros` travels as its exact decimal string
 * (bigint does not survive JSON as a number); `statementFormat` is omitted
 * when absent. The `raw` payload must be JSON-encodable — webhook and
 * statement sources already are; an in-memory raw that is not encodable
 * throws here rather than being silently reshaped.
 */
export function serializeRoyaltyEvent(event: CanonicalRoyaltyEvent): string {
  return JSON.stringify({
    eventId: event.eventId,
    rightsPipeline: event.rightsPipeline,
    source: event.source,
    ...(event.statementFormat === undefined ? {} : { statementFormat: event.statementFormat }),
    period: event.period,
    currency: event.currency,
    grossMicros: event.grossMicros.toString(),
    identifiers: event.identifiers,
    platform: event.platform,
    territory: event.territory,
    raw: event.raw,
  });
}

/**
 * The type boundary's inverse. Parses the transport JSON, rebuilds the
 * bigint, and re-validates the whole event through the parser — a serialized
 * event is never trusted, only re-verified.
 */
export function deserializeRoyaltyEvent(json: string): ParsedRoyaltyEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return reject('not_json');
  }
  if (!isPlainObject(parsed)) return reject('not_an_object');
  const grossMicros = parsed.grossMicros;
  if (typeof grossMicros !== 'string' || !/^\d+$/.test(grossMicros)) {
    return reject('invalid_gross_micros');
  }
  parsed.grossMicros = BigInt(grossMicros);
  return parseCanonicalRoyaltyEvent(parsed);
}
