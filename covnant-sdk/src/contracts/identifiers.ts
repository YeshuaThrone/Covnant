/**
 * The SDK's external-identifier registry — the 20 IdentifierKind values with a
 * strict, total canonicalizer per kind.
 *
 * Canonicalization is NOT repair. Each canonicalize is a total function
 * `string → string | null`: it normalizes separators and case toward the
 * kind's canonical form and returns null for anything that does not match
 * that form exactly. It never guesses (no fuzzy matching), never auto-repairs
 * (no arithmetic conversion such as ISBN-10 → ISBN-13), and never computes a
 * missing check character. The locked lineage rule — "no fuzzy matching, no
 * auto-repair" (src/lib/covnant/lineage.ts) — is carried down to the value
 * level: canonical form is a fixed point, so the same identifier canonicalizes
 * to the same string every time and exact matching stays exact.
 *
 * Canonical forms, per the standards verified when this registry was written:
 *
 * - ISRC  — ISO 3901: 12 chars, uppercase, dashless
 *           (2-letter country + 3 alnum registrant + 2-digit year + 5 digits).
 *           Mirrors the lineage lane's normalizeIsrc byte-for-byte.
 * - ISWC  — ISO 15707: `T-<9 digits>-<1 check digit>` dashed. NOTE: the
 *           standard's work identifier is NINE digits; see the PR record for
 *           the divergence flag against the vault's older 10-digit pattern.
 * - ISAN  — ISO 15706: 16 uppercase hex digits (the engine's `isanHex` form),
 *           separators tolerated on input, check-char variant rejected.
 * - EIDR  — canonical DOI root form `10.5240/XXXX-XXXX-XXXX-XXXX-XXXX-C`
 *           (RFC 7302): the 10.5240 root issuer, 5 groups of 4 alphanumeric
 *           characters, 1 check character.
 * - DOI   — ISO 26324: `10.<registrant digits>/<suffix>`, lowercased, no
 *           whitespace anywhere.
 * - UPC   — exactly 12 digits, verbatim (mirrors the vault adapter).
 * - EAN   — exactly 13 digits (EAN-13), verbatim.
 * - ISMN  — 13 digits beginning 9790, output dashed `979-0-XXXX-XXXX-X`.
 * - GRid  — IFPI GRid Standard: 18 alphanumeric chars structured
 *           scheme(2) + issuer(5) + release(10) + check(1), output
 *           hyphen-separated.
 * - ISBN  — 13 digits (ISBN-13). ISBN-10 is rejected — converting it is
 *           arithmetic repair, which canonicalization never does.
 * - ISSN  — `NNNN-NNNC` with C a digit or X; compact input tolerated,
 *           output dashed.
 * - GTIN  — exactly 14 digits (GTIN-14); shorter GTINs use their own kinds
 *           (UPC, EAN).
 * - MLC_WORK_ID / HFA_SONG_ID / IPN — registry-assigned codes with no public
 *           syntax standard verified at write time; the strict structural rule
 *           is: uppercase, whitespace-free, printable, 1–64 chars, starting
 *           alphanumeric. Tighten only with the registries' documentation.
 * - TUNE_CODE — PRS Tunecode: exactly 8 alphanumeric characters.
 * - ISNI  — ISO 27729: 15 digits + check (digit or X), output dashed 4×4.
 * - IPI   — the 11-digit IPI Name Number; the 9-digit legacy CAE form is
 *           accepted and zero-padded to 11 with the documented `00` prefix.
 * - EPC_RFID — GS1 EPC Tag Data Standard pure-identity URI
 *           (`urn:epc:id:<scheme>:<body>`), lowercased; tag/binary forms
 *           (`urn:epc:tag:…`, hex) are rejected.
 * - NIL   — the deliberate "no external identifier" sentinel. Its only valid
 *           value is the string `NIL` (case-insensitive on input). It lets a
 *           canonical event state "looked, none exists" instead of leaving
 *           the registry silent about whether the question was asked.
 *
 * Storage home: `cbt_assets.mapped_identifiers` (JSONB). The three vault kinds
 * (ISRC/ISWC/UPC) already live there; widening to the 20 kinds here is a
 * code-level change — no asset-table migration is needed.
 */

/** The 20 external-identifier kinds the SDK recognizes, as named by the mission. */
export type IdentifierKind =
  | 'ISRC'
  | 'ISWC'
  | 'ISAN'
  | 'EIDR'
  | 'DOI'
  | 'UPC'
  | 'EAN'
  | 'ISMN'
  | 'GRID'
  | 'ISBN'
  | 'ISSN'
  | 'GTIN'
  | 'MLC_WORK_ID'
  | 'HFA_SONG_ID'
  | 'TUNE_CODE'
  | 'ISNI'
  | 'IPI'
  | 'IPN'
  | 'EPC_RFID'
  | 'NIL';

/** Whether a kind names an asset (a recording, work, release…) or a creator party. */
export type IdentifierAppliesTo = 'asset' | 'creator';

export interface IdentifierSpec {
  readonly kind: IdentifierKind;
  /** Creators need ISNI/IPI/IPN on creator_profiles; assets take the rest. */
  readonly appliesTo: IdentifierAppliesTo;
  /**
   * Canonicalize one value; null = reject. Never guesses, never auto-repairs:
   * output is either the kind's canonical form (a fixed point — re-canonicalizing
   * it returns it unchanged) or null.
   */
  readonly canonicalize: (value: string) => string | null;
}

/** Canonical ISRC: 2 letters + 3 alnum + 2 digits + 5 digits = 12 chars. */
const ISRC_PATTERN = /^[A-Z]{2}[A-Z0-9]{3}\d{2}\d{5}$/;

/** Canonical ISWC per ISO 15707: T + 9-digit work identifier + 1 check digit. */
const ISWC_PATTERN = /^T-\d{9}-\d$/;

/** Canonical ISAN: 16 uppercase hex digits (the engine's isanHex form). */
const ISAN_PATTERN = /^[0-9A-F]{16}$/;

/** Canonical EIDR: the 10.5240 root issuer, 5 groups of 4 alnum, 1 check char. */
const EIDR_PATTERN = /^10\.5240\/(?:[0-9A-Z]{4}-){5}[0-9A-Z]$/;

/** Canonical DOI: 10.<4–9 registrant digits>/<suffix with no whitespace>. */
const DOI_PATTERN = /^10\.\d{4,9}\/\S+$/;

/** Canonical UPC-A: exactly 12 digits. */
const UPC_PATTERN = /^\d{12}$/;

/** Canonical EAN-13: exactly 13 digits. */
const EAN_PATTERN = /^\d{13}$/;

/** Canonical ISMN: 13 digits beginning 9790. */
const ISMN_PATTERN = /^9790\d{9}$/;

/** Canonical GRid: scheme(2) + issuer(5) + release(10) + check(1) = 18 alnum. */
const GRID_PATTERN = /^[0-9A-Z]{18}$/;

/** Canonical ISBN-13: exactly 13 digits. */
const ISBN_PATTERN = /^\d{13}$/;

/** Canonical GTIN-14: exactly 14 digits. */
const GTIN_PATTERN = /^\d{14}$/;

/** PRS Tunecode: exactly 8 alphanumeric characters. */
const TUNE_CODE_PATTERN = /^[0-9A-Z]{8}$/;

/** Canonical ISNI: 15 digits + check character (digit or X). */
const ISNI_PATTERN = /^\d{15}[\dX]$/;

/** IPI Name Number: 11 digits. */
const IPI_PATTERN = /^\d{11}$/;

/** GS1 pure-identity EPC URI: urn:epc:id:<scheme>:<body of digits/dots/dashes>. */
const EPC_PATTERN = /^urn:epc:id:[a-z0-9-]+:[0-9a-z.-]+$/;

/**
 * The strict structural rule for registry-assigned codes with no public
 * syntax standard verified (MLC work IDs, HFA song codes, IPNs): uppercase,
 * whitespace-free printable characters from letters/digits/underscore/hyphen,
 * 1–64 chars, starting alphanumeric.
 */
const REGISTRY_ASSIGNED_PATTERN = /^[0-9A-Z][0-9A-Z_-]{0,63}$/;

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** Uppercase + trim + drop every dash and space (not dots — some kinds use them). */
function upperDashed(value: string): string {
  return value.trim().replaceAll('-', '').replaceAll(' ', '').toUpperCase();
}

/** Uppercase + trim only (kinds whose separators are structural). */
function upper(value: string): string {
  return value.trim().toUpperCase();
}

function canonicalizeIsrc(value: string): string | null {
  // Mirrors normalizeIsrc (lineage lane): dashes stripped, nothing else.
  const candidate = value.trim().replaceAll('-', '').toUpperCase();
  return ISRC_PATTERN.test(candidate) ? candidate : null;
}

function canonicalizeIswc(value: string): string | null {
  // Dashed canonical form only — the same posture the vault and lineage lane
  // take toward ISWC ("ISWCs in free text are always dashed"). Nine work
  // digits per ISO 15707 (the older vault pattern required ten).
  const candidate = upper(value);
  return ISWC_PATTERN.test(candidate) ? candidate : null;
}

function canonicalizeIsan(value: string): string | null {
  const candidate = upperDashed(value);
  return ISAN_PATTERN.test(candidate) ? candidate : null;
}

function canonicalizeEidr(value: string): string | null {
  const candidate = upper(value);
  return EIDR_PATTERN.test(candidate) ? candidate : null;
}

function canonicalizeDoi(value: string): string | null {
  const candidate = value.trim().toLowerCase();
  return DOI_PATTERN.test(candidate) && !CONTROL_CHARS.test(candidate) ? candidate : null;
}

function canonicalizeUpc(value: string): string | null {
  const candidate = value.trim();
  return UPC_PATTERN.test(candidate) ? candidate : null;
}

function canonicalizeEan(value: string): string | null {
  const candidate = value.trim();
  return EAN_PATTERN.test(candidate) ? candidate : null;
}

function canonicalizeIsmn(value: string): string | null {
  const digits = upperDashed(value);
  if (!ISMN_PATTERN.test(digits)) return null;
  // 13 digits: 979 | 0 | 4 | 4 | 1 → 979-0-XXXX-XXXX-X.
  return `${digits.slice(0, 3)}-${digits.slice(3, 4)}-${digits.slice(4, 8)}-${digits.slice(8, 12)}-${digits.slice(12, 13)}`;
}

function canonicalizeGrid(value: string): string | null {
  const candidate = upperDashed(value);
  if (!GRID_PATTERN.test(candidate)) return null;
  // 18 chars: scheme(2) + issuer(5) + release(10) + check(1), hyphen-separated.
  return `${candidate.slice(0, 2)}-${candidate.slice(2, 7)}-${candidate.slice(7, 17)}-${candidate.slice(17, 18)}`;
}

function canonicalizeIsbn(value: string): string | null {
  const candidate = upperDashed(value);
  return ISBN_PATTERN.test(candidate) ? candidate : null;
}

function canonicalizeIssn(value: string): string | null {
  // Canonical ISSN display: dddd-dddd (dash after the fourth character).
  // upperDashed removes separators, so test the compact 8-char form and
  // re-dash once — no recursion (a dashed input re-strips to itself).
  const compact = upperDashed(value);
  return /^\d{7}[\dX]$/.test(compact) ? `${compact.slice(0, 4)}-${compact.slice(4)}` : null;
}

function canonicalizeGtin(value: string): string | null {
  const candidate = value.trim();
  return GTIN_PATTERN.test(candidate) ? candidate : null;
}

function canonicalizeRegistryAssigned(value: string): string | null {
  const candidate = upper(value);
  return REGISTRY_ASSIGNED_PATTERN.test(candidate) && !CONTROL_CHARS.test(candidate)
    ? candidate
    : null;
}

function canonicalizeTuneCode(value: string): string | null {
  const candidate = upper(value);
  return TUNE_CODE_PATTERN.test(candidate) ? candidate : null;
}

function canonicalizeIsni(value: string): string | null {
  const candidate = upperDashed(value);
  if (!ISNI_PATTERN.test(candidate)) return null;
  // Canonical ISNI display: dashed groups of four.
  return `${candidate.slice(0, 4)}-${candidate.slice(4, 8)}-${candidate.slice(8, 12)}-${candidate.slice(12, 16)}`;
}

function canonicalizeIpi(value: string): string | null {
  const candidate = value.trim();
  // Legacy 9-digit CAE numbers carry the documented `00` prefix to reach the
  // 11-digit IPI Name Number form; anything else that is not already 11
  // digits is rejected, not repaired.
  if (candidate.length === 9 && /^\d{9}$/.test(candidate)) return `00${candidate}`;
  return IPI_PATTERN.test(candidate) ? candidate : null;
}

function canonicalizeEpc(value: string): string | null {
  const candidate = value.trim().toLowerCase();
  return EPC_PATTERN.test(candidate) ? candidate : null;
}

function canonicalizeNil(value: string): string | null {
  return upper(value) === 'NIL' ? 'NIL' : null;
}

/**
 * The registry — one spec per kind, all 20, keyed by kind. TypeScript enforces
 * completeness of this literal against IdentifierKind; IDENTIFIER_KINDS below
 * is derived from it so the two can never drift.
 */
export const IDENTIFIER_SPECS: Readonly<Record<IdentifierKind, IdentifierSpec>> = {
  ISRC: { kind: 'ISRC', appliesTo: 'asset', canonicalize: canonicalizeIsrc },
  ISWC: { kind: 'ISWC', appliesTo: 'asset', canonicalize: canonicalizeIswc },
  ISAN: { kind: 'ISAN', appliesTo: 'asset', canonicalize: canonicalizeIsan },
  EIDR: { kind: 'EIDR', appliesTo: 'asset', canonicalize: canonicalizeEidr },
  DOI: { kind: 'DOI', appliesTo: 'asset', canonicalize: canonicalizeDoi },
  UPC: { kind: 'UPC', appliesTo: 'asset', canonicalize: canonicalizeUpc },
  EAN: { kind: 'EAN', appliesTo: 'asset', canonicalize: canonicalizeEan },
  ISMN: { kind: 'ISMN', appliesTo: 'asset', canonicalize: canonicalizeIsmn },
  GRID: { kind: 'GRID', appliesTo: 'asset', canonicalize: canonicalizeGrid },
  ISBN: { kind: 'ISBN', appliesTo: 'asset', canonicalize: canonicalizeIsbn },
  ISSN: { kind: 'ISSN', appliesTo: 'asset', canonicalize: canonicalizeIssn },
  GTIN: { kind: 'GTIN', appliesTo: 'asset', canonicalize: canonicalizeGtin },
  MLC_WORK_ID: {
    kind: 'MLC_WORK_ID',
    appliesTo: 'asset',
    canonicalize: canonicalizeRegistryAssigned,
  },
  HFA_SONG_ID: {
    kind: 'HFA_SONG_ID',
    appliesTo: 'asset',
    canonicalize: canonicalizeRegistryAssigned,
  },
  TUNE_CODE: { kind: 'TUNE_CODE', appliesTo: 'asset', canonicalize: canonicalizeTuneCode },
  ISNI: { kind: 'ISNI', appliesTo: 'creator', canonicalize: canonicalizeIsni },
  IPI: { kind: 'IPI', appliesTo: 'creator', canonicalize: canonicalizeIpi },
  IPN: { kind: 'IPN', appliesTo: 'creator', canonicalize: canonicalizeRegistryAssigned },
  EPC_RFID: { kind: 'EPC_RFID', appliesTo: 'asset', canonicalize: canonicalizeEpc },
  NIL: { kind: 'NIL', appliesTo: 'asset', canonicalize: canonicalizeNil },
};

/** All 20 kinds, in registry order. */
export const IDENTIFIER_KINDS: readonly IdentifierKind[] = Object.keys(
  IDENTIFIER_SPECS,
) as IdentifierKind[];

/** The kinds that name creator parties (ISNI / IPI / IPN) — the creator_profiles set. */
export const CREATOR_IDENTIFIER_KINDS: readonly IdentifierKind[] = IDENTIFIER_KINDS.filter(
  (kind) => IDENTIFIER_SPECS[kind].appliesTo === 'creator',
);

/** True exactly when `value` is one of the 20 kinds (case-sensitive, as stored). */
export function isIdentifierKind(value: string): value is IdentifierKind {
  return Object.prototype.hasOwnProperty.call(IDENTIFIER_SPECS, value);
}

/** The spec for one kind. */
export function getIdentifierSpec(kind: IdentifierKind): IdentifierSpec {
  return IDENTIFIER_SPECS[kind];
}

/** Canonicalize one value through the registry; null = reject. Never guesses. */
export function canonicalizeIdentifier(kind: IdentifierKind, value: string): string | null {
  return IDENTIFIER_SPECS[kind].canonicalize(value);
}
