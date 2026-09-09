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
 * Ingestion is exact-match only, both directions:
 * - attachExternalIdentifier merges one external code (ISRC | ISWC | UPC)
 *   into the asset's `mapped_identifiers` JSONB — the same storage the
 *   Generation 7 lineage lane reads. Re-attaching an IDENTICAL pair is a
 *   no-op, never a duplicate; each kind holds exactly one value.
 * - findByIdentifier resolves an external code back to the asset with its
 *   stored CVT tag (and holder UCT where present). Unknown identifiers
 *   return not-found — NEVER auto-create, never fuzzy. The lookup applies
 *   the exact canonicalization the lineage lane uses, nothing looser.
 *
 * Adapter-level only: no HTTP endpoints here — a route can wrap this surface
 * later without rework. Read/write scope is one JSONB column on the asset
 * row; no table, route, or persisted-format changes.
 */

import type { Db } from '@/lib/db';
import { normalizeIsrc } from '@/lib/covnant/lineage';

/** The external-code kinds the vault ingests (Generation 8 kinds list). */
export type VaultExternalIdentifierKind = 'ISRC' | 'ISWC' | 'UPC';

export const VAULT_EXTERNAL_IDENTIFIER_KINDS: readonly VaultExternalIdentifierKind[] = [
  'ISRC',
  'ISWC',
  'UPC',
];

export interface VaultIdentifierInput {
  kind: VaultExternalIdentifierKind;
  value: string;
}

/** Canonical UPC-A: exactly 12 digits. */
const UPC_PATTERN = /^\d{12}$/;

/** Canonical ISWC: T-<10 digits>-<1 check digit>, dashed and uppercase (the lineage lane's ISWC form). */
const ISWC_PATTERN = /^T-\d{10}-\d$/;

/** The lowercase mapped_identifiers JSONB key each kind is stored under. */
const VAULT_IDENTIFIER_KEYS: Record<VaultExternalIdentifierKind, string> = {
  ISRC: 'isrc',
  ISWC: 'iswc',
  UPC: 'upc',
};

/**
 * Canonicalizes an external identifier for storage and exact matching;
 * null when the value is not a valid code of the kind. ISRC reuses the
 * lineage module's canonical 12-char dashless normalization so the vault and
 * the lineage lane can never disagree about the same identifier. ISWC is
 * matched only in its canonical dashed uppercase form (same as lineage).
 * UPC is matched verbatim in its 12-digit UPC-A form.
 */
export function normalizeVaultIdentifier(
  kind: VaultExternalIdentifierKind,
  raw: string,
): string | null {
  const value = raw.trim();
  switch (kind) {
    case 'ISRC':
      return normalizeIsrc(value);
    case 'ISWC': {
      const upper = value.toUpperCase();
      return ISWC_PATTERN.test(upper) ? upper : null;
    }
    case 'UPC':
      return UPC_PATTERN.test(value) ? value : null;
  }
}

export interface VaultAssetRecord {
  /** The vault's outward-facing handle — the stored cbt_assets.cvt_code. */
  cvtCode: string;
  /** The engine's canonical CBT-<TYPE>-<HASH> code (system of record). */
  cbtCode: string;
  title: string;
  medium: string;
  /** The asset's external codes, keyed by lowercase kind. */
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
 * The exact-match lookup per kind: the stored identifier is compared through
 * the SAME canonicalization the parser/attach path applies (ISRC uppercased
 * and dash-stripped, ISWC uppercased dashed, UPC verbatim digits), so the
 * comparison is exact identifier equality — never fuzzy, never a near-miss
 * shape scan.
 */
const VAULT_LOOKUP_SQL: Record<VaultExternalIdentifierKind, string> = {
  ISRC: `SELECT a.cvt_code, a.cbt_code, a.title, a.medium, a.mapped_identifiers,
           (SELECT rh->>'uct'
              FROM jsonb_array_elements(a.rights_holders) AS rh
             WHERE COALESCE(rh->>'uct', '') <> ''
             LIMIT 1) AS uct
      FROM cbt_assets a
     WHERE UPPER(REPLACE(a.mapped_identifiers->>'isrc', '-', '')) = $1
     LIMIT 1`,
  ISWC: `SELECT a.cvt_code, a.cbt_code, a.title, a.medium, a.mapped_identifiers,
           (SELECT rh->>'uct'
              FROM jsonb_array_elements(a.rights_holders) AS rh
             WHERE COALESCE(rh->>'uct', '') <> ''
             LIMIT 1) AS uct
      FROM cbt_assets a
     WHERE UPPER(a.mapped_identifiers->>'iswc') = $1
     LIMIT 1`,
  UPC: `SELECT a.cvt_code, a.cbt_code, a.title, a.medium, a.mapped_identifiers,
           (SELECT rh->>'uct'
              FROM jsonb_array_elements(a.rights_holders) AS rh
             WHERE COALESCE(rh->>'uct', '') <> ''
             LIMIT 1) AS uct
      FROM cbt_assets a
     WHERE a.mapped_identifiers->>'upc' = $1
     LIMIT 1`,
};

/**
 * Resolves an external identifier to its vault asset — exact match only,
 * read-only. Returns the asset with its stored CVT tag (and holder UCT
 * where present); null when nothing matches. NEVER auto-creates: this
 * module contains no INSERT, and an unknown identifier simply finds nothing.
 */
export async function findByIdentifier(
  db: Db,
  kind: VaultExternalIdentifierKind,
  value: string,
): Promise<VaultAssetRecord | null> {
  const canonical = normalizeVaultIdentifier(kind, value);
  if (canonical === null) {
    return null; // An invalid value cannot match anything — not-found, not an error.
  }
  const res = await db.query<VaultMatchRow>(VAULT_LOOKUP_SQL[kind], [canonical]);
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

function isNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}
