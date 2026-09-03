/**
 * Universal royalty ledger store — PR 4.
 *
 * The engine settles but never persists on the direct path: `processRoyaltySettlement`
 * returns a SettlementResult, and only the social webhook action upserts the ledger
 * table (with its own 10% social fee). This store mirrors settled results into the
 * `universal_royalty_ledger` table using the engine's exact column mapping, with a
 * globalThis-guarded in-memory index (same pattern as the asset index and contract
 * store) so /ledger and /rights-holders render in both data modes.
 */

import type { DisbursementDetail, SettlementResult } from '@/engine/covenant-master-sdk';
import { supabaseFromEnv } from '../supabase';

export interface LedgerRow {
  transactionId: string;
  cbtCode: string;
  platform: string;
  grossSettled: number;
  covenantFee: number;
  cornerDustCollected: number;
  currency: string;
  disbursements: DisbursementDetail[];
  createdAt: string;
}

declare global {
  var __covnantLedgerIndex: LedgerRow[] | undefined;
}

function memoryIndex(): LedgerRow[] {
  if (!globalThis.__covnantLedgerIndex) globalThis.__covnantLedgerIndex = [];
  return globalThis.__covnantLedgerIndex;
}

function rowFromSettlement(result: SettlementResult, platform: string): LedgerRow {
  return {
    transactionId: result.transactionId,
    cbtCode: result.cbtCode,
    platform,
    grossSettled: result.totalSettled,
    covenantFee: result.platformFeeDeducted,
    cornerDustCollected: result.cornerDustCollected,
    currency: result.currency,
    disbursements: result.disbursements,
    createdAt: new Date().toISOString(),
  };
}

/** Column mapping matches the engine's own ledger upsert (processUniversalSocialWebhookAction). */
function toDbRow(row: LedgerRow) {
  return {
    transaction_id: row.transactionId,
    cbt_code: row.cbtCode,
    platform: row.platform,
    gross_settled: row.grossSettled,
    covenant_fee: row.covenantFee,
    corner_dust_collected: row.cornerDustCollected,
    currency: row.currency,
    disbursements: row.disbursements,
    created_at: row.createdAt,
  };
}

function rowFromDb(data: Record<string, unknown>): LedgerRow {
  return {
    transactionId: data.transaction_id as string,
    cbtCode: data.cbt_code as string,
    platform: data.platform as string,
    grossSettled: Number(data.gross_settled),
    covenantFee: Number(data.covenant_fee),
    cornerDustCollected: Number(data.corner_dust_collected),
    currency: data.currency as string,
    disbursements: (data.disbursements ?? []) as DisbursementDetail[],
    createdAt: String(data.created_at ?? ''),
  };
}

/**
 * Persist a settled result into the ledger (memory index + Supabase upsert when
 * credentials are configured). Idempotent per transaction_id in both modes.
 */
export async function rememberSettlement(
  result: SettlementResult,
  platform: string
): Promise<LedgerRow> {
  const row = rowFromSettlement(result, platform);
  const index = memoryIndex();
  const existing = index.findIndex((r) => r.transactionId === row.transactionId);
  if (existing >= 0) index[existing] = row;
  else index.unshift(row);

  const db = supabaseFromEnv();
  if (db) {
    const { error } = await db
      .from('universal_royalty_ledger')
      .upsert([toDbRow(row)], { onConflict: 'transaction_id' });
    if (error) throw new Error(`Ledger upsert failed: ${error.message}`);
  }
  return row;
}

export async function listLedger(): Promise<LedgerRow[]> {
  const db = supabaseFromEnv();
  if (db) {
    const { data, error } = await db
      .from('universal_royalty_ledger')
      .select('*')
      .order('created_at', { ascending: false });
    if (!error && data) return data.map(rowFromDb);
  }
  return [...memoryIndex()];
}

export interface LedgerTotals {
  count: number;
  gross: number;
  fees: number;
  cornerDust: number;
}

export function totalsFrom(rows: LedgerRow[]): LedgerTotals {
  return rows.reduce<LedgerTotals>(
    (acc, row) => ({
      count: acc.count + 1,
      gross: acc.gross + row.grossSettled,
      fees: acc.fees + row.covenantFee,
      cornerDust: acc.cornerDust + row.cornerDustCollected,
    }),
    { count: 0, gross: 0, fees: 0, cornerDust: 0 }
  );
}

export interface HolderYtd {
  id: string;
  name: string;
  role: string;
  /** YTD keyed by settlement currency — the ledger stores no FX, so no USD rollup. */
  grossYtd: Record<string, number>;
  withheldYtd: Record<string, number>;
  netYtd: Record<string, number>;
  /** The engine's own form determination from the most recent settlement. */
  latestTaxForm: DisbursementDetail['taxFormRequired'] | 'NONE';
  settlementCount: number;
}

export function holderStatsFrom(rows: LedgerRow[]): Map<string, HolderYtd> {
  const stats = new Map<string, HolderYtd>();
  // Rows are newest-first; fold oldest→newest so "latest" lands last.
  for (const row of [...rows].reverse()) {
    for (const d of row.disbursements) {
      const entry: HolderYtd =
        stats.get(d.rightsHolderId) ??
        {
          id: d.rightsHolderId,
          name: d.rightsHolderName,
          role: d.role,
          grossYtd: {},
          withheldYtd: {},
          netYtd: {},
          latestTaxForm: 'NONE',
          settlementCount: 0,
        };
      entry.grossYtd[row.currency] = (entry.grossYtd[row.currency] ?? 0) + d.grossShare;
      entry.withheldYtd[row.currency] =
        (entry.withheldYtd[row.currency] ?? 0) + d.withholdingTaxDeducted;
      entry.netYtd[row.currency] = (entry.netYtd[row.currency] ?? 0) + d.netShare;
      if (d.taxFormRequired !== 'NONE') entry.latestTaxForm = d.taxFormRequired;
      entry.settlementCount += 1;
      stats.set(d.rightsHolderId, entry);
    }
  }
  return stats;
}
