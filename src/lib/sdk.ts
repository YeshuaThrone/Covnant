/**
 * Server-side SDK singleton and asset enumeration.
 *
 * The engine's cbtRegistry is private and not enumerable, so the studio keeps
 * a module-level shadow index (globalThis-guarded against dev HMR) populated
 * at registration time. With Supabase credentials configured, listing reads
 * the DB directly instead.
 */
import type { CovenantBlockAsset, MediaMedium, UniversalAssetIdentifier, SelfServeRightsHolder } from '@/engine/covenant-master-sdk';
import { CovenantMasterSDK } from '@/engine/covenant-master-sdk';
import { supabaseFromEnv } from './supabase';

/** v1: 0% direct-path platform fee; the social path's 10% lives in the claim engine. */
export const PLATFORM_FEE_PERCENTAGE = 0;

declare global {
  // eslint-disable-next-line no-var
  var __covnantSdk: CovenantMasterSDK | undefined;
  // eslint-disable-next-line no-var
  var __covnantAssetIndex: CovenantBlockAsset[] | undefined;
}

export function getSdk(): CovenantMasterSDK {
  globalThis.__covnantSdk ??= new CovenantMasterSDK(PLATFORM_FEE_PERCENTAGE, supabaseFromEnv());
  return globalThis.__covnantSdk;
}

export function indexAsset(asset: CovenantBlockAsset): void {
  globalThis.__covnantAssetIndex ??= [];
  const index = globalThis.__covnantAssetIndex;
  const existing = index.findIndex((a) => a.cbtCode === asset.cbtCode);
  if (existing >= 0) index[existing] = asset;
  else index.unshift(asset);
}

/**
 * A listed asset — the engine's asset record plus the DB-only holder UCT
 * column (migration 0056). The in-memory index carries engine-shaped
 * assets, so `holderUct` is absent there: an absent fact, honestly.
 */
export type ListedAsset = CovenantBlockAsset & { readonly holderUct?: string | null };

/** Column value → string when present and non-blank, else `undefined`. */
function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function rowToAsset(row: Record<string, unknown>): ListedAsset {
  const cvtCode = optionalString(row.cvt_code);
  return {
    cbtCode: row.cbt_code as string,
    ...(cvtCode !== undefined ? { cvtCode } : {}),
    title: row.title as string,
    medium: row.medium as MediaMedium,
    mappedIdentifiers: row.mapped_identifiers as UniversalAssetIdentifier,
    rightsHolders: row.rights_holders as SelfServeRightsHolder[],
    createdTimestamp: Number(row.created_timestamp),
    holderUct: optionalString(row.holder_uct) ?? null,
  };
}

export async function listAssets(sdk: CovenantMasterSDK = getSdk()): Promise<ListedAsset[]> {
  if (sdk.dbClient) {
    const { data, error } = await sdk.dbClient
      .from('cbt_assets')
      .select('*')
      .order('created_timestamp', { ascending: false });
    if (!error && data) return data.map(rowToAsset);
  }
  return [...(globalThis.__covnantAssetIndex ?? [])];
}
