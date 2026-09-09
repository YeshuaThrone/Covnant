/**
 * Overview aggregation helpers — pure transforms over the existing stores'
 * reads (assets via src/lib/sdk, the royalty ledger via the ledger store's
 * read helpers, contracts via the contracts store, allowlists via the admin
 * store). The route composes them; nothing here writes anything.
 *
 * The registry surface discloses PROVISIONING STATUS ONLY: the payout
 * routing object (virtual-account ids/numbers) is stripped so no account or
 * routing number can reach the console response — the same disclosure rule
 * the signup and provision routes enforce.
 */

import type { CovenantBlockAsset } from '@/engine/covenant-master-sdk';
import type { HolderYtd, LedgerRow, LedgerTotals } from '@/lib/ledger/store';
import { holderStatsFrom, totalsFrom } from '@/lib/ledger/store';
import type { AdminAllowlistRow } from './allowlists';
import type { StoredContract } from '@/lib/contracts/store';

export type ProvisioningStatus = 'PROVISIONED' | 'PENDING';

export interface RegistryHolderSummary {
  /** Engine entries key `id`; signup registry entries key `rightsHolderId`. */
  rightsHolderId: string;
  name: string;
  role: string;
  email: string | null;
  uct: string | null;
  provisioning: ProvisioningStatus;
}

export interface RegistrySummary {
  assetCount: number;
  rightsHolderCount: number;
  holders: RegistryHolderSummary[];
}

/**
 * Flattens every asset's rights_holders into deduplicated holder summaries.
 * Assets arrive newest-first; a holder's first appearance wins. Entries
 * without any holder id are skipped (nothing to identify or dedupe against).
 */
export function registrySummary(assets: CovenantBlockAsset[]): RegistrySummary {
  const holders = new Map<string, RegistryHolderSummary>();
  let skipped = 0;
  for (const asset of assets) {
    for (const entry of asset.rightsHolders ?? []) {
      // The registry JSONB has TWO producers: the engine writes entries keyed
      // `id`, the signup route writes `rightsHolderId` + email/uct — the
      // stored objects are a genuine shape union, hence the unknown hop.
      const raw = entry as unknown as Record<string, unknown>;
      const holderId =
        typeof raw.rightsHolderId === 'string'
          ? raw.rightsHolderId
          : typeof raw.id === 'string'
            ? raw.id
            : null;
      if (!holderId) {
        skipped += 1;
        continue;
      }
      if (holders.has(holderId)) continue;
      holders.set(holderId, {
        rightsHolderId: holderId,
        name: String(raw.name ?? ''),
        role: String(raw.role ?? ''),
        email: typeof raw.email === 'string' ? raw.email : null,
        uct: typeof raw.uct === 'string' ? raw.uct : null,
        // Provisioning STATUS only — never the routing object itself.
        provisioning:
          (raw.payoutRouting as { covenantVirtualAccount?: unknown } | undefined)?.covenantVirtualAccount
            ? 'PROVISIONED'
            : 'PENDING',
      });
    }
  }
  if (skipped > 0) {
    console.warn(`[admin] registry summary skipped ${skipped} holder entries with no holder id`);
  }
  return {
    assetCount: assets.length,
    rightsHolderCount: holders.size,
    holders: [...holders.values()],
  };
}

export interface LedgerSummary {
  totals: LedgerTotals;
  /** Per-holder YTD across settlements (the ledger store's own fold). */
  holders: HolderYtd[];
}

/** Royalty-ledger totals + per-holder YTD, read-only, via the ledger store. */
export function ledgerSummary(rows: LedgerRow[]): LedgerSummary {
  return { totals: totalsFrom(rows), holders: [...holderStatsFrom(rows).values()] };
}

export interface ContractsSummary {
  total: number;
  byStatus: { DRAFT: number; FINAL: number };
}

export function contractsSummary(contracts: StoredContract[]): ContractsSummary {
  const byStatus: ContractsSummary['byStatus'] = { DRAFT: 0, FINAL: 0 };
  for (const contract of contracts) byStatus[contract.status] += 1;
  return { total: contracts.length, byStatus };
}

export interface AllowlistsSummary {
  total: number;
  byStatus: { ACTIVE: number; REVOKED: number };
}

export function allowlistsSummary(rows: AdminAllowlistRow[]): AllowlistsSummary {
  const byStatus: AllowlistsSummary['byStatus'] = { ACTIVE: 0, REVOKED: 0 };
  for (const row of rows) byStatus[row.status] += 1;
  return { total: rows.length, byStatus };
}
