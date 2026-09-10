/**
 * Creator settlement slice — the display-side read of the Universal Royalty
 * Ledger for one rights holder: the bounded recent-rows strip and the
 * per-currency gross/net totals that the bank-home dashboard renders.
 *
 * Exactness rules (the same discipline as the reconciliation module):
 * every amount enters BigInt space through microFromNumber (the ledger's
 * 1e-8 scale) — never through a float sum. Per-currency lines are never
 * rolled up across currencies. The engine's per-entry netShare (grossShare
 * − withholding recorded at settlement time) is the creator's landed
 * amount; the escrow balance math (rate-derived, payout-aware) stays in
 * @/lib/escrow/balance — the two surfaces answer different questions.
 *
 * Pure and client-safe: no I/O. Rows arrive as raw PostgREST shapes
 * (snake_case columns); malformed rows are skipped for DISPLAY — the money
 * math in balance.ts never depends on this module.
 */

import { microFromNumber } from '@/lib/fixed-point';

import { isSettlementEntry } from './disbursementEntries';

/** The universal_royalty_ledger columns the creator slice reads. */
export const CREATOR_LEDGER_COLUMNS =
  'transaction_id, cbt_code, platform, currency, created_at, disbursements';

/** A raw universal_royalty_ledger row as the PostgREST read returns it. */
export interface CreatorLedgerDbRow {
  transaction_id?: unknown;
  cbt_code?: unknown;
  platform?: unknown;
  currency?: unknown;
  created_at?: unknown;
  disbursements?: unknown;
}

/** One row of the dashboard's recent royalty strip — display fields only. */
export interface CreatorRecentSettlement {
  transactionId: string;
  cbtCode: string;
  platform: string;
  currency: string;
  /** The holder's engine-recorded net share, BigInt smallest-unit string (1e-8). */
  amountUnits: string;
  /** The ledger row's created_at, passed through for display. */
  settledAt: string;
}

/** Per-currency settled totals for the holder — exact BigInt unit strings. */
export interface CurrencySettlementTotals {
  currency: string;
  grossUnits: string;
  /** gross − engine-recorded withholding, per entry — no rate recomputation. */
  netUnits: string;
}

/** The recent strip's hard bound — the me route's documented slice size. */
export const RECENT_SETTLEMENT_LIMIT = 10;

export interface CreatorSettlementSlice {
  recent: CreatorRecentSettlement[];
  totalsByCurrency: CurrencySettlementTotals[];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/** Newest first; rows without a parseable timestamp sink to the end. */
function settledAtDesc(a: CreatorRecentSettlement, b: CreatorRecentSettlement): number {
  const at = Date.parse(a.settledAt);
  const bt = Date.parse(b.settledAt);
  return (Number.isNaN(bt) ? 0 : bt) - (Number.isNaN(at) ? 0 : at);
}

/**
 * The creator-scoped slice over raw ledger rows: recent (newest first,
 * bounded at RECENT_SETTLEMENT_LIMIT) and per-currency gross/net totals.
 * Rows missing any display column are skipped for display (corrupt data
 * never renders); rows that qualify count fully — a holder's multiple
 * entries in one settlement row sum into that row's amount.
 */
export function creatorSettlementsFromDbRows(params: {
  dbRows: CreatorLedgerDbRow[];
  rightsHolderId: string;
}): CreatorSettlementSlice {
  const { dbRows, rightsHolderId } = params;

  const recent: CreatorRecentSettlement[] = [];
  const totals = new Map<string, { gross: bigint; net: bigint }>();

  for (const row of dbRows) {
    if (
      !isNonEmptyString(row.transaction_id) ||
      !isNonEmptyString(row.cbt_code) ||
      !isNonEmptyString(row.platform) ||
      !isNonEmptyString(row.currency) ||
      !isNonEmptyString(row.created_at) ||
      !Array.isArray(row.disbursements)
    ) {
      continue;
    }

    // The holder's settlement entries on this row — payout debits never
    // appear in the royalty strip (they are withdrawals, not royalties).
    let rowNet = 0n;
    let rowGross = 0n;
    let rowQualifies = false;
    for (const entry of row.disbursements) {
      if (!isSettlementEntry(entry) || entry.rightsHolderId !== rightsHolderId) continue;
      rowQualifies = true;
      rowGross += microFromNumber(entry.grossShare);
      // A settlement entry without a recorded netShare is a corrupt row —
      // skip the row entirely rather than render a gross-as-net lie.
      if (typeof entry.netShare !== 'number') {
        rowQualifies = false;
        rowNet = 0n;
        rowGross = 0n;
        break;
      }
      rowNet += microFromNumber(entry.netShare);
    }
    if (!rowQualifies) continue;

    recent.push({
      transactionId: row.transaction_id,
      cbtCode: row.cbt_code,
      platform: row.platform,
      currency: row.currency,
      amountUnits: rowNet.toString(),
      settledAt: row.created_at,
    });

    const bucket = totals.get(row.currency) ?? { gross: 0n, net: 0n };
    bucket.gross += rowGross;
    bucket.net += rowNet;
    totals.set(row.currency, bucket);
  }

  recent.sort(settledAtDesc);

  return {
    recent: recent.slice(0, RECENT_SETTLEMENT_LIMIT),
    totalsByCurrency: Array.from(totals.entries())
      .map(([currency, { gross, net }]) => ({
        currency,
        grossUnits: gross.toString(),
        netUnits: net.toString(),
      }))
      .sort((a, b) => a.currency.localeCompare(b.currency)),
  };
}

/**
 * The cbt_codes of registry rows carrying the holder — the scope of their
 * rights workspace (contracts reference asset cbt_codes). Pure; the
 * resolver feeds the result into the contracts read's `.in()` filter.
 *
 * Holder matching follows the signup-registry shape (PR #26): entries key
 * the holder as `rightsHolderId`. Richer entries (the escrow module's
 * tax-profile shape) key it as `id` — both are recognized so the workspace
 * counts stay correct across entry generations.
 */
function holderEntryMatches(holder: unknown, rightsHolderId: string): boolean {
  if (typeof holder !== 'object' || holder === null) return false;
  const entry = holder as { rightsHolderId?: unknown; id?: unknown };
  return (
    (typeof entry.rightsHolderId === 'string' && entry.rightsHolderId === rightsHolderId) ||
    (typeof entry.id === 'string' && entry.id === rightsHolderId)
  );
}

export function holderAssetCbtCodes(assetRows: AssetRowLike[], rightsHolderId: string): string[] {
  const codes: string[] = [];
  for (const row of assetRows) {
    const holders = row.rights_holders;
    if (!Array.isArray(holders) || !isNonEmptyString(row.cbt_code)) continue;
    if (holders.some((holder) => holderEntryMatches(holder, rightsHolderId))) {
      codes.push(row.cbt_code);
    }
  }
  return codes;
}

/** A registry (cbt_assets) row shape — code + holder list, anything else ignored. */
export interface AssetRowLike {
  cbt_code?: unknown;
  rights_holders?: unknown;
}

/**
 * The count of registry (cbt_assets) rows where the holder appears in
 * rights_holders — the creator-scoped "registered assets" figure.
 */
export function registeredAssetsForHolder(assetRows: AssetRowLike[], rightsHolderId: string): number {
  return holderAssetCbtCodes(assetRows, rightsHolderId).length;
}
