/**
 * Server-side SDK singleton and asset enumeration.
 *
 * The engine's cbtRegistry is private and not enumerable, so the studio keeps
 * a module-level shadow index (globalThis-guarded against dev HMR) populated
 * at registration time. With Supabase credentials configured, listing reads
 * the DB directly instead.
 */
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { CovenantBlockAsset, MediaMedium, UniversalAssetIdentifier, SelfServeRightsHolder } from '@/engine/covenant-master-sdk';
import { CovenantMasterSDK } from '@/engine/covenant-master-sdk';
import { SUPABASE_URL_ENV, SUPABASE_SERVICE_ROLE_KEY_ENV } from './data-source';

/** v1: 0% direct-path platform fee; the social path's 10% lives in the claim engine. */
const PLATFORM_FEE_PERCENTAGE = 0;

declare global {
  // eslint-disable-next-line no-var
  var __covnantSdk: CovenantMasterSDK | undefined;
  // eslint-disable-next-line no-var
  var __covnantAssetIndex: CovenantBlockAsset[] | undefined;
}

function supabaseFromEnv(): SupabaseClient | undefined {
  const url = process.env[SUPABASE_URL_ENV];
  const key = process.env[SUPABASE_SERVICE_ROLE_KEY_ENV];
  return url && key ? createClient(url, key) : undefined;
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

function rowToAsset(row: Record<string, unknown>): CovenantBlockAsset {
  return {
    cbtCode: row.cbt_code as string,
    title: row.title as string,
    medium: row.medium as MediaMedium,
    mappedIdentifiers: row.mapped_identifiers as UniversalAssetIdentifier,
    rightsHolders: row.rights_holders as SelfServeRightsHolder[],
    createdTimestamp: Number(row.created_timestamp),
  };
}

export async function listAssets(sdk: CovenantMasterSDK = getSdk()): Promise<CovenantBlockAsset[]> {
  if (sdk.dbClient) {
    const { data, error } = await sdk.dbClient
      .from('cbt_assets')
      .select('*')
      .order('created_timestamp', { ascending: false });
    if (!error && data) return data.map(rowToAsset);
  }
  return [...(globalThis.__covnantAssetIndex ?? [])];
}
