/**
 * Ledger lineage — parse external identifiers out of payment memo text and
 * match them against asset-level external identifiers.
 *
 * Two lanes, one authority (the pinned PR #26 rule): an inbound transfer
 * resolves to a credit through the Increase account number alone. Memo and
 * payer references flow in a PARALLEL lane — parsed here, matched exactly
 * against cbt_assets.mapped_identifiers, and written into the ledger row's
 * metadata as lineage. This lane never moves money: no fuzzy matching, no
 * auto-repair, no split execution, no asset mutation — ever. Parse
 * exceptions are caught by the route's savepoint-scoped fallback so lineage
 * capture can never block or void a credit.
 *
 * Pure module: no DB, no IO. The route owns the lookup and the savepoint.
 */

/** The reference kinds the parser recognizes (ISRC minimum per the spec). */
export type ExternalReferenceKind = 'ISRC' | 'ISWC';

export interface ExternalReference {
  kind: ExternalReferenceKind;
  /** Canonical identifier value — the exact-match key (ISRC: 12-char dashless). */
  value: string;
  /** The exact matched substring from the source text, prefix included. */
  raw: string;
}

export type LineageResolution = 'exact' | 'unmatched';

export interface LedgerLineage {
  references: ExternalReference[];
  resolution: LineageResolution;
  /** The matched asset's CBT code — present only when resolution is 'exact'. */
  assetCode?: string;
  /** The matched asset holder's UCT — omitted when the holder predates UCTs. */
  uct?: string;
  parsedAt: string;
}

/** Canonical ISRC: 2 + 3 + 2 + 5 = 12 chars, uppercase alphanumeric. */
const ISRC_CANONICAL_PATTERN = /^[A-Z]{2}[A-Z0-9]{3}\d{2}\d{5}$/;

/**
 * Canonical ISWC: T-<10 digits>-<1 check digit>. Matched only in its
 * canonical dashed form — ISWCs in free text are always dashed.
 */
const ISWC_PATTERN = /\b(T-\d{10}-\d)\b/g;

/**
 * ISRC shapes in memo text, tried in order so the raw capture includes the
 * prefix when one is present:
 *  1. prefix + dashed ("ISRC: US-S1M-26-77777" / "ISRC-US-S1M-26-77777")
 *  2. bare dashed ("US-S1M-26-77777")
 *  3. bare canonical 12-char ("USS1M2677777")
 */
const ISRC_PREFIXED_PATTERN = /\bISRC\s*[:\-]\s*([A-Za-z0-9][A-Za-z0-9\-]*)/g;
const ISRC_DASHED_PATTERN = /\b([A-Za-z]{2}-[A-Za-z0-9]{3}-\d{2}-\d{5})\b/g;
const ISRC_BARE_PATTERN = /\b([A-Za-z]{2}[A-Za-z0-9]{3}\d{2}\d{5})\b/g;

/**
 * The memo/description fields parsed for references — a rail-agnostic scan
 * over free-text-style keys (memo, description, remittance, addenda,
 * reference) on the fetched transfer object's top-level strings.
 */
const MEMO_KEY_PATTERN = /memo|descript|remittance|addenda|reference/i;

/**
 * Normalizes a candidate ISRC to its canonical 12-char dashless form; null
 * when the candidate is not exactly 12 canonical chars after stripping
 * separators. Normalization is canonicalization, not fuzzy matching — the
 * DB lookup compares this exact value against the same normalization applied
 * to the stored identifier.
 */
export function normalizeIsrc(candidate: string): string | null {
  const value = candidate.replaceAll('-', '').trim().toUpperCase();
  return ISRC_CANONICAL_PATTERN.test(value) ? value : null;
}

/** Case-insensitive ISRC scan of one text — canonical values, first raw wins. */
function parseIsrcs(text: string, into: Map<string, ExternalReference>): void {
  const patterns = [ISRC_PREFIXED_PATTERN, ISRC_DASHED_PATTERN, ISRC_BARE_PATTERN];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const raw = match[0].trim();
      const value = normalizeIsrc(match[1]);
      if (value && !into.has(value)) {
        into.set(value, { kind: 'ISRC', value, raw });
      }
    }
  }
}

/** Case-insensitive ISWC scan of one text — canonical values, first raw wins. */
function parseIswcs(text: string, into: Map<string, ExternalReference>): void {
  for (const match of text.matchAll(ISWC_PATTERN)) {
    const raw = match[1];
    const value = match[1].toUpperCase();
    if (!into.has(value)) {
      into.set(value, { kind: 'ISWC', value, raw });
    }
  }
}

/**
 * Parses external references (ISRC required-pattern, ISWC optional) from the
 * memo/description fields of a fetched Increase transfer object. Scans every
 * top-level string field whose key looks free-text-ish; dedupes by
 * kind + value (first occurrence's raw form wins). Nothing parseable →
 * an empty array — the route then writes NO lineage key at all.
 */
export function parseExternalReferences(transfer: Record<string, unknown>): ExternalReference[] {
  const found = new Map<string, ExternalReference>();
  for (const [key, value] of Object.entries(transfer)) {
    if (typeof value !== 'string' || !MEMO_KEY_PATTERN.test(key)) continue;
    parseIsrcs(value, found);
    parseIswcs(value, found);
  }
  return [...found.values()];
}

/**
 * Builds the lineage metadata object from parsed references and the route's
 * exact-match lookup result. `match` carries the first exact match (the
 * asset's CBT code and, when the holder has one, its UCT); null when no
 * reference matched → resolution 'unmatched'. The `uct` key is omitted
 * gracefully for holders registered before UCTs existed.
 */
export function buildLineageMetadata(params: {
  references: ExternalReference[];
  match: { assetCode: string; uct: string | null } | null;
  parsedAt: string;
}): { lineage: LedgerLineage } {
  const lineage: LedgerLineage = {
    references: params.references,
    resolution: params.match ? 'exact' : 'unmatched',
    ...(params.match ? { assetCode: params.match.assetCode } : {}),
    ...(params.match && params.match.uct ? { uct: params.match.uct } : {}),
    parsedAt: params.parsedAt,
  };
  return { lineage };
}
