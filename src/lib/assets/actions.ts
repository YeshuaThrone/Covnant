'use server';

import { revalidatePath } from 'next/cache';
import type { MediaMedium } from '@/engine/covenant-master-sdk';
import { getSdk, indexAsset } from '@/lib/sdk';
import {
  holdersFromDrafts,
  registerMultiPoolAsset,
  saveAssetSplits,
} from '@/lib/splits/multi-pool';
import { MEDIA_MEDIUMS, type PoolDraft } from '@/lib/splits/shared';

export interface RegisterAssetPayload {
  title: string;
  medium: string;
  identifiers: { isrc?: string; iswc?: string; eidrCanonical?: string };
  pools: PoolDraft[];
}

export interface ActionResult {
  ok: boolean;
  cbtCode?: string;
  error?: string;
}

/**
 * Register a multi-pool asset. The per-pool exact-100.0000% gate is enforced
 * server-side inside registerMultiPoolAsset, so a stale or tampered client
 * cannot bypass it.
 */
export async function registerAssetAction(payload: RegisterAssetPayload): Promise<ActionResult> {
  try {
    if (!payload.title.trim()) return { ok: false, error: 'Asset title is required.' };
    if (!MEDIA_MEDIUMS.includes(payload.medium as MediaMedium)) {
      return { ok: false, error: 'Choose a valid medium.' };
    }
    if (payload.pools.length === 0) return { ok: false, error: 'At least one pool is required.' };

    const pools = payload.pools.map((p) => ({
      pool: p.pool,
      holders: holdersFromDrafts(p.holders),
    }));
    const sdk = getSdk();
    const result = await registerMultiPoolAsset(sdk, {
      title: payload.title.trim(),
      medium: payload.medium as MediaMedium,
      identifiers: payload.identifiers,
      pools,
    });
    const asset = sdk.getInMemoryAsset(result.cbtCode);
    if (asset) indexAsset(asset);
    revalidatePath('/assets');
    return { ok: true, cbtCode: result.cbtCode };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Registration failed.',
    };
  }
}

/** Re-validate and persist an asset's split sheet; nothing is written off-gate. */
export async function saveAssetSplitsAction(cbtCode: string, pools: PoolDraft[]): Promise<ActionResult> {
  try {
    const results = await saveAssetSplits(
      getSdk(),
      cbtCode,
      pools.map((p) => ({ pool: p.pool, holders: holdersFromDrafts(p.holders) })),
    );
    const invalid = results.filter((r) => !r.valid);
    if (invalid.length > 0) {
      return {
        ok: false,
        error:
          'Nothing saved — each pool must read exactly 100.0000%. ' +
          invalid.map((r) => `${r.pool} reads ${r.sum.toFixed(4)}%`).join('; '),
      };
    }
    revalidatePath(`/assets/${cbtCode}`);
    return { ok: true, cbtCode };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Split sheet update failed.',
    };
  }
}
