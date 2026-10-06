/**
 * CVT — the asset's outward-facing Covenant handle.
 *
 * One shape, minted by the vendored engine's `generateCVTAssetCode`
 * (covenant-master-sdk.ts): `CVT-<6 hex>-<issuance year>`, stored on the
 * asset row as `cbt_assets.cvt_code` (migration 0056). That stored column is
 * the ONLY source of an asset's outward-facing CVT: every read surface
 * renders the stored value through `storedCvtHandle` or shows nothing —
 * never a client-side synthesis from the CBT body or any other field
 * (data-identity audit P1 #2: one asset, one outward handle).
 *
 * Sector-slot audit keys that used to borrow the `CVT-` prefix are renamed
 * to `AUD-<PREFIX>-XXXX` (lib/assets/registry-keys.ts) so the CVT namespace
 * means exactly the stored engine handle and nothing else.
 *
 * Pure and isomorphic like uct.ts: no runtime dependency beyond the global
 * `RegExp`, safe in the browser bundle and on the server.
 */

/** Every CVT ever minted by the engine matches this shape: 6 hex + a 4-digit issuance year. */
export const CVT_PATTERN = /^CVT-[0-9A-F]{6}-\d{4}$/;

/**
 * Shape check only — the engine's minted output, and nothing else. The year
 * segment is scoped to exactly four digits (0000-9999): issuance years are
 * minted at registration, so any 4-digit year the engine produced stays
 * valid forever; the pattern scopes FORMAT, not date range.
 */
export function isValidCvt(value: unknown): value is string {
  return typeof value === 'string' && CVT_PATTERN.test(value);
}

/**
 * The ONE fail-closed read resolver for a stored CVT: the engine-minted code
 * when it matches the single shape, else null. A null/missing/foreign-shaped
 * stored value means the asset HAS no outward handle — callers render the
 * identifier-of-record (the CBT code) or nothing, and never backfill a
 * handle client-side.
 */
export function storedCvtHandle(value: string | null | undefined): string | null {
  return isValidCvt(value) ? value : null;
}

/**
 * Deterministic CVT for DEMO FIXTURES ONLY — the engine's shape derived from
 * a stable seed (FNV-1a, 24 bits rendered as 6 hex) instead of randomBytes,
 * so seeded demo rows are identical across boots and replays. Real asset
 * registration never routes through this: the engine's
 * `generateCVTAssetCode` (collision-proof randomBytes) is the only minter on
 * the write path.
 */
export function deterministicCvtCode(seed: string, year: number): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const hex = (hash >>> 8).toString(16).toUpperCase().padStart(6, '0');
  return `CVT-${hex}-${year}`;
}
