/**
 * generateCBTAsset — the front-end registration adapter for the zero-friction
 * MUL flow (directive §2). Lives beside multi-pool.ts in the adapter layer;
 * the vendored engine is never imported at runtime here.
 *
 * One call: registers the multi-pool asset through the server action (which
 * routes through the engine's single write path), then deterministically
 * provisions the universal tracking pills from the canonical CBT-<TYPE>-<HASH>
 * code the engine returns — ISRC (Recording) + ISWC (Composition) for Music &
 * Audio, EIDR (10.5240 Root Standard) for Film/TV/Video, plus the CVT/CBT
 * internal audit keys for ledger verification. Sector registry codes are
 * never fabricated: whatever the engine does not supply is presented as a
 * clearly internal `CVT-<PREFIX>-XXXX` audit key, never as a registered
 * external identifier.
 *
 * Duplicate collisions come back classified (`duplicate: true`) so the UI can
 * render the gold banner instead of a raw Postgres error.
 */
import type { MediaMedium } from '@/engine/covenant-master-sdk';
import { registerAssetAction } from '@/lib/assets/actions';
import { resolveRegistryPills, type RegistryPill } from '@/lib/assets/registry-keys';
import type { PoolDraft } from '@/lib/splits/shared';

export interface GenerateCbtAssetInput {
  title: string;
  medium: string;
  pools: PoolDraft[];
}

export type GenerateCbtAssetResult =
  | { ok: true; cbtCode: string; pills: RegistryPill[] }
  | { ok: false; duplicate: boolean; error: string };

export async function generateCBTAsset(
  input: GenerateCbtAssetInput,
): Promise<GenerateCbtAssetResult> {
  const result = await registerAssetAction({
    title: input.title,
    medium: input.medium,
    // Zero-friction flow: no manual registry identifiers — the engine's mapped
    // identifiers stay empty unless a claim flow supplies real ones later.
    identifiers: {},
    pools: input.pools,
  });

  if (!result.ok || !result.cbtCode) {
    return {
      ok: false,
      duplicate: result.duplicate ?? false,
      error: result.error ?? 'Registration failed.',
    };
  }

  return {
    ok: true,
    cbtCode: result.cbtCode,
    pills: resolveRegistryPills({
      cbtCode: result.cbtCode,
      // The action validated the medium against MEDIA_MEDIUMS before writing.
      medium: input.medium as MediaMedium,
    }),
  };
}
