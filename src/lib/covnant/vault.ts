/**
 * CVT · Covnant Vault Tag — the asset vault adapter.
 *
 * Canonical tier definition (Generation 8, user-locked): CVT is "the asset
 * vault layer that ingests external codes (ISRCs, ISWCs, UPCs etc.) and
 * holds transaction metadata worldwide."
 *
 * The vault's outward-facing handle is the STORED CVT code —
 * `cbt_assets.cvt_code`, minted by the vendored engine's
 * `generateCVTAssetCode` in the PR #22 dual-code registration (every asset
 * row carries both `cvt_code` and the canonical `CBT-<TYPE>-<HASH>` code).
 * The engine's minted codes remain the stored system of record and never
 * change format; this adapter only keys on them.
 *
 * Identifier kinds come from the SDK contracts registry (PR 2,
 * `covnant-sdk/src/contracts/identifiers.ts`) — the vault stores every
 * ASSET-level registry kind except the NIL sentinel:
 *   - creator-party kinds (ISNI / IPI / IPN) carry the registry's
 *     `appliesTo: 'creator'` — they belong on creator_profiles, never on
 *     the asset row this adapter writes;
 *   - NIL is the registry's "no external identifier exists" sentinel.
 *     Storing it would let exact matching assert a match from the ABSENCE
 *     of an identifier — precisely the fuzzy logic the locked rule forbids.
 *
 * Canonicalization is the registry's, singular: attach and findByIdentifier
 * both canonicalize through the same IdentifierSpec, so a value this
 * surface attaches is exactly the value the matcher (and the Increase
 * lineage lane) compares against — no second opinion anywhere. The
 * registry's ISWC form is ISO 15707 (`T-<9 digits>-<check>`, dashed); the
 * legacy vault pattern required ten work digits. That divergence is
 * reconciled at the LOOKUP BOUNDARY, never by rewriting historical stored
 * data: the lookup SQL normalizes the stored side (case, separators) so
 * stored legacy variants stay matchable, while new attachments always
 * store the registry's canonical form.
 *
 * Ingestion is exact-match only, both directions:
 * - attachExternalIdentifier merges one external code into the asset's
 *   `mapped_identifiers` JSONB — the same storage the Generation 7 lineage
 *   lane reads. Re-attaching an IDENTICAL pair is a no-op, never a
 *   duplicate; each kind holds exactly one value.
 * - findByIdentifier resolves an external code back to the asset with its
 *   stored CVT tag (and holder UCT where present). Unknown identifiers
 *   return not-found — NEVER auto-create, never fuzzy.
 *
 * Wrapped by the admin surface: POST/GET /api/admin/vault/identifiers are
 * this adapter's production callers. Read/write scope is one JSONB column
 * on the asset row; no table or persisted-format changes.
 */

import type { IdentifierKind } from '../../../covnant-sdk/src/contracts/identifiers';
import { IDENTIFIER_KINDS, IDENTIFIER_SPECS, canonicalizeIdentifier } from '../../../covnant-sdk/src/contracts/identifiers';
import type { Db, DbClient } from '@/lib/db';

/**
 * The asset-level registry kinds the vault ingests, in registry order.
 * Explicit (not filtered at runtime) so the set is readable at a glance;
 * `satisfies` pins every entry to the registry and the vault suite's
 * drift-guard test pins the set to the registry's asset kinds minus NIL.
 */
export const VAULT_EXTERNAL_IDENTIFIER_KINDS = [
  'ISRC',
  'ISWC',
  'ISAN',
  'EIDR',
  'DOI',
  'UPC',
  'EAN',
  'ISMN',
  'GRID',
  'ISBN',
  'ISSN',
  'GTIN',
  'MLC_WORK_ID',
  'HFA_SONG_ID',
  'TUNE_CODE',
  'EPC_RFID',
] as const satisfies readonly IdentifierKind[];

export type VaultExternalIdentifierKind = (typeof VAULT_EXTERNAL_IDENTIFIER_KINDS)[number];

export interface VaultIdentifierInput {
  kind: VaultExternalIdentifierKind;
  value: string;
}

/**
 * Canonicalizes an external identifier for storage and exact matching;
 * null when the value is not a valid code of the kind. Delegates to the
 * registry's IdentifierSpec — the ONE canonicalizer every consumer shares,
 * so the vault and the matcher can never disagree about the same
 * identifier.
 */
export function normalizeVaultIdentifier(
  kind: VaultExternalIdentifierKind,
  raw: string,
): string | null {
  return canonicalizeIdentifier(kind, raw);
}

/**
 * The lowercase mapped_identifiers JSONB key each kind is stored under.
 * Kinds the vendored engine models reuse the ENGINE's persisted field
 * names — registration writes `eidrCanonical`/`isanHex`/`prs_tunecode`
 * verbatim — so vault-attached and registration-written values for the
 * same kind land under one key. Kinds the engine does not model use the
 * lowercase kind. Compile-checked for completeness against the union.
 */
const VAULT_IDENTIFIER_KEYS: Record<VaultExternalIdentifierKind, string> = {
  ISRC: 'isrc',
  ISWC: 'iswc',
  ISAN: 'isanHex',
  EIDR: 'eidrCanonical',
  DOI: 'doi',
  UPC: 'upc',
  EAN: 'ean',
  ISMN: 'ismn',
  GRID: 'grid',
  ISBN: 'isbn',
  ISSN: 'issn',
  GTIN: 'gtin',
  MLC_WORK_ID: 'mlc_work_id',
  HFA_SONG_ID: 'hfa_song_id',
  TUNE_CODE: 'prs_tunecode',
  EPC_RFID: 'epc_rfid',
};

/**
 * The persisted JSONB key for one kind — the admin audit surface's field
 * identity for its `mapped_identifiers.<key>` diffs and its compensation
 * target. One lookup so this adapter stays the only place the kind→key
 * mapping lives.
 */
export function vaultIdentifierStorageKey(kind: VaultExternalIdentifierKind): string {
  return VAULT_IDENTIFIER_KEYS[kind];
}

/**
 * How the lookup boundary compares the stored JSONB value — the canonical
 * forms' case/separator fold, applied to BOTH sides in SQL so stored
 * legacy variants (registration wrote mapped_identifiers free-form) stay
 * matchable without a data rewrite:
 *   - dashless: uppercase, dashes stripped (the lineage lane's ISRC form;
 *     ISWC joins it — see the header's ISWC divergence note)
 *   - upper:    case-folded up, separators structural (EIDR dots/slashes,
 *               ISMN/GRID/ISSN dashes survive)
 *   - lower:    case-folded down (DOI and EPC URIs are lowercase-canonical)
 */
type LookupBoundaryFold = 'dashless' | 'upper' | 'lower';

const LOOKUP_BOUNDARY_FOLD: Record<VaultExternalIdentifierKind, LookupBoundaryFold> = {
  ISRC: 'dashless',
  ISWC: 'dashless',
  ISAN: 'upper',
  EIDR: 'upper',
  DOI: 'lower',
  UPC: 'upper',
  EAN: 'upper',
  ISMN: 'upper',
  GRID: 'upper',
  ISBN: 'upper',
  ISSN: 'upper',
  GTIN: 'upper',
  MLC_WORK_ID: 'upper',
  HFA_SONG_ID: 'upper',
  TUNE_CODE: 'upper',
  EPC_RFID: 'lower',
};

export interface VaultAssetRecord {
  /** The vault's outward-facing handle — the stored cbt_assets.cvt_code. */
  cvtCode: string;
  /** The engine's canonical CBT-<TYPE>-<HASH> code (system of record). */
  cbtCode: string;
  title: string;
  medium: string;
  /** The asset's external codes, keyed by the persisted JSONB key. */
  externalIdentifiers: Record<string, string>;
  /** First UCT-carrying rights holder; null for holders registered before UCTs. */
  holderUct: string | null;
}

export type AttachExternalIdentifierResult =
  | { ok: true; attached: boolean; cvtCode: string; cbtCode: string }
  | { ok: false; reason: 'ASSET_NOT_FOUND' | 'INVALID_IDENTIFIER' };

interface VaultAssetRow {
  cvt_code: string;
  cbt_code: string;
  title: string;
  medium: string;
  mapped_identifiers: unknown;
  holder_uct: string | null;
}

const VAULT_ASSET_BY_CVT_SQL = `
      SELECT a.cvt_code, a.cbt_code, a.title, a.medium, a.mapped_identifiers,
             (SELECT rh->>'uct'
                FROM jsonb_array_elements(a.rights_holders) AS rh
               WHERE COALESCE(rh->>'uct', '') <> ''
               LIMIT 1) AS holder_uct
        FROM cbt_assets a
       WHERE a.cvt_code = $1
       FOR UPDATE`;

/**
 * Attaches one external identifier to the vault asset addressed by its CVT
 * code — the stored PR #22 dual-code handle. Idempotent by exact-match
 * dedupe: an identical (kind, canonical value) pair already present is a
 * no-op; a different value for a kind already held replaces it in place
 * (one entry per kind, never a duplicate). The JSONB merge is additive —
 * every other mapped_identifiers key survives untouched.
 */
export async function attachExternalIdentifier(
  db: Db,
  assetRef: string,
  identifier: VaultIdentifierInput,
): Promise<AttachExternalIdentifierResult> {
  const canonical = normalizeVaultIdentifier(identifier.kind, identifier.value);
  if (canonical === null) {
    return { ok: false, reason: 'INVALID_IDENTIFIER' };
  }
  const key = VAULT_IDENTIFIER_KEYS[identifier.kind];

  return db.transaction(async (tx) => {
    const res = await tx.query<VaultAssetRow>(VAULT_ASSET_BY_CVT_SQL, [assetRef]);
    const row = res.rows[0];
    if (!row) {
      // Exact CVT reference only — an unknown handle never auto-creates an asset.
      return { ok: false, reason: 'ASSET_NOT_FOUND' };
    }

    const stored = (row.mapped_identifiers ?? {}) as Record<string, unknown>;
    const existing = stored[key];
    if (
      typeof existing === 'string' &&
      normalizeVaultIdentifier(identifier.kind, existing) === canonical
    ) {
      // Exact-match dedupe: the identical pair is already attached.
      return { ok: true, attached: false, cvtCode: row.cvt_code, cbtCode: row.cbt_code };
    }

    await tx.query(
      `UPDATE cbt_assets
          SET mapped_identifiers = COALESCE(mapped_identifiers, '{}'::jsonb) || jsonb_build_object($1, $2)
        WHERE cvt_code = $3`,
      [key, canonical, assetRef],
    );
    return { ok: true, attached: true, cvtCode: row.cvt_code, cbtCode: row.cbt_code };
  });
}

interface VaultMatchRow {
  cvt_code: string | null;
  cbt_code: string | null;
  title: string | null;
  medium: string | null;
  mapped_identifiers: unknown;
  uct: string | null;
}

/**
 * Folds one side of the lookup comparison — the canonical value's case/
 * separator form for its kind, shared by the stored-side SQL expression
 * below. Canonicalization itself already happened (the registry's); this
 * is only the comparison fold.
 */
function lookupFold(kind: VaultExternalIdentifierKind, canonical: string): string {
  switch (LOOKUP_BOUNDARY_FOLD[kind]) {
    case 'dashless':
      return canonical.replaceAll('-', '').toUpperCase();
    case 'upper':
      return canonical.toUpperCase();
    case 'lower':
      return canonical.toLowerCase();
  }
}

/** The SQL expression that applies the same fold to the stored JSONB value. */
function storedFoldSql(kind: VaultExternalIdentifierKind): string {
  const stored = `a.mapped_identifiers->>'${VAULT_IDENTIFIER_KEYS[kind]}'`;
  switch (LOOKUP_BOUNDARY_FOLD[kind]) {
    case 'dashless':
      return `UPPER(REPLACE(${stored}, '-', ''))`;
    case 'upper':
      return `UPPER(${stored})`;
    case 'lower':
      return `LOWER(${stored})`;
  }
}

/**
 * The exact-match lookup per kind: the stored identifier is compared
 * through the SAME canonicalization the attach path applies (the
 * registry's IdentifierSpec), folded identically on both sides at the
 * lookup boundary — so the comparison is exact identifier equality that
 * tolerates stored legacy separator/case variants without rewriting them.
 * Never fuzzy, never a near-miss shape scan.
 */
const VAULT_LOOKUP_SQL = Object.fromEntries(
  VAULT_EXTERNAL_IDENTIFIER_KINDS.map((kind) => {
    const select = `SELECT a.cvt_code, a.cbt_code, a.title, a.medium, a.mapped_identifiers,
           (SELECT rh->>'uct'
              FROM jsonb_array_elements(a.rights_holders) AS rh
             WHERE COALESCE(rh->>'uct', '') <> ''
             LIMIT 1) AS uct
      FROM cbt_assets a`;
    return [kind, `${select}\n     WHERE ${storedFoldSql(kind)} = $1\n     LIMIT 1`];
  }),
) as Record<VaultExternalIdentifierKind, string>;

/**
 * Resolves an external identifier to its vault asset — exact match only,
 * read-only. Returns the asset with its stored CVT tag (and holder UCT
 * where present); null when nothing matches. NEVER auto-creates: this
 * module contains no INSERT, and an unknown identifier simply finds nothing.
 */
export async function findByIdentifier(
  db: Db | DbClient,
  kind: VaultExternalIdentifierKind,
  value: string,
): Promise<VaultAssetRecord | null> {
  const canonical = normalizeVaultIdentifier(kind, value);
  if (canonical === null) {
    return null; // An invalid value cannot match anything — not-found, not an error.
  }
  const res = await db.query<VaultMatchRow>(VAULT_LOOKUP_SQL[kind], [lookupFold(kind, canonical)]);
  const row = res.rows[0];
  if (!row || !isNonEmpty(row.cvt_code) || !isNonEmpty(row.cbt_code)) {
    return null;
  }
  const identifiers: Record<string, string> = {};
  if (typeof row.mapped_identifiers === 'object' && row.mapped_identifiers !== null) {
    for (const [field, stored] of Object.entries(row.mapped_identifiers as Record<string, unknown>)) {
      if (typeof stored === 'string' && stored.trim() !== '') {
        identifiers[field] = stored;
      }
    }
  }
  return {
    cvtCode: row.cvt_code,
    cbtCode: row.cbt_code,
    title: row.title ?? '',
    medium: row.medium ?? '',
    externalIdentifiers: identifiers,
    holderUct: isNonEmpty(row.uct) ? row.uct : null,
  };
}

/** Registry drift guard: the vault kinds ARE the registry's asset kinds minus the NIL sentinel. */
export function assertVaultKindsMatchRegistry(): void {
  const expected = IDENTIFIER_KINDS.filter(
    (kind) => IDENTIFIER_SPECS[kind].appliesTo === 'asset' && kind !== 'NIL',
  );
  const actual = VAULT_EXTERNAL_IDENTIFIER_KINDS.join(',');
  if (actual !== expected.join(',')) {
    throw new Error(
      `Vault identifier kinds drifted from the registry: vault [${actual}] vs registry [${expected.join(',')}]`,
    );
  }
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}
