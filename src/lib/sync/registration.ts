/**
 * The Sync License registration request — the creator submission boundary
 * (layout contract art_9tCxOhGO backend sections + the SyncMarketplaceRegistry
 * amendment). Parse, don't cast: exact key sets, stable machine reasons,
 * fail-closed.
 *
 * Splits are HARD-LOCKED 50/35/15: the request carries NO split input at
 * all — any split-shaped key is rejected as unknown — and the locked
 * structure is echoed in responses from the settlement lane's single
 * source of truth (SYNC_TIER_WEIGHTS).
 */

export interface SyncRegistrationRequest {
  cvtAssetTag: string;
  syncFeeCents: number;
  /** Free-form catalog label; '' when the submission omits it. */
  genre: string;
  /** Optional tempo; null when the submission omits it. */
  bpm: number | null;
}

export type ParsedSyncRegistration =
  | { ok: true; value: SyncRegistrationRequest }
  | { ok: false; code: string; message: string };

const REGISTRATION_KEYS: readonly string[] = ['cvtAssetTag', 'syncFeeCents', 'genre', 'bpm'];

export function parseSyncRegistration(value: unknown): ParsedSyncRegistration {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, code: 'malformed_body', message: 'Request body must be a JSON object.' };
  }
  const body = value as Record<string, unknown>;

  for (const key of Object.keys(body)) {
    if (!REGISTRATION_KEYS.includes(key)) {
      return {
        ok: false,
        code: `unknown_key:${key}`,
        message: `Registration accepts only cvtAssetTag, syncFeeCents, genre, and bpm — "${key}" is not accepted (splits are hard-locked 50/35/15).`,
      };
    }
  }
  if (body.cvtAssetTag === undefined) {
    return { ok: false, code: 'missing_key:cvtAssetTag', message: 'cvtAssetTag is required.' };
  }
  if (body.syncFeeCents === undefined) {
    return { ok: false, code: 'missing_key:syncFeeCents', message: 'syncFeeCents is required.' };
  }

  if (
    typeof body.cvtAssetTag !== 'string' ||
    body.cvtAssetTag.length === 0 ||
    body.cvtAssetTag.length > 128 ||
    body.cvtAssetTag !== body.cvtAssetTag.trim()
  ) {
    return { ok: false, code: 'invalid_cvt_asset_tag', message: 'cvtAssetTag must be a non-empty string (≤128 chars).' };
  }
  if (typeof body.syncFeeCents !== 'number' || !Number.isInteger(body.syncFeeCents) || body.syncFeeCents <= 0) {
    return { ok: false, code: 'invalid_sync_fee_cents', message: 'syncFeeCents must be a positive integer (cents).' };
  }

  let genre = '';
  if (body.genre !== undefined) {
    if (typeof body.genre !== 'string' || body.genre.length > 128) {
      return { ok: false, code: 'invalid_genre', message: 'genre must be a string (≤128 chars).' };
    }
    genre = body.genre.trim();
  }

  let bpm: number | null = null;
  if (body.bpm !== undefined) {
    if (typeof body.bpm !== 'number' || !Number.isInteger(body.bpm) || body.bpm <= 0) {
      return { ok: false, code: 'invalid_bpm', message: 'bpm must be a positive integer.' };
    }
    bpm = body.bpm;
  }

  return {
    ok: true,
    value: {
      cvtAssetTag: body.cvtAssetTag,
      syncFeeCents: body.syncFeeCents,
      genre,
      bpm,
    },
  };
}
