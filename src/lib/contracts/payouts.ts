/**
 * Contract payout views — directive §4.
 *
 * Display layer only: shapes the EXISTING ledger read rows (the same
 * `universal_royalty_ledger` rows the /api/ledger route serves) into per-
 * agreement flows for the contract's asset of record. No new server-side
 * routing or persistence logic — the ledger store's read API remains the
 * only data path. Type-only ledger import keeps this module client-safe.
 */

import type { LedgerRow } from '@/lib/ledger/store';
import type { AgreementContext } from './generator';

export interface PayoutLine {
  holder: string;
  role: string;
  /** Exact recorded share from the agreement's pools, when resolvable. */
  recordedPercent?: string;
  grossShare: number;
  withholdingTaxDeducted: number;
  netShare: number;
}

export interface PayoutFlow {
  transactionId: string;
  platform: string;
  /** ISO timestamp of the settled row. */
  settledAt: string;
  currency: string;
  grossSettled: number;
  covenantFee: number;
  cornerDustCollected: number;
  lines: PayoutLine[];
}

export interface PayoutTotals {
  currency: string;
  gross: number;
  fees: number;
  net: number;
  settlements: number;
}

export interface AssetPayouts {
  flows: PayoutFlow[];
  /** Totals per settlement currency — the ledger stores no FX, so no cross-currency rollup. */
  totals: PayoutTotals[];
}

/**
 * Maps ledger rows for one CBT code into agreement payout flows, pairing each
 * disbursement with the holder's recorded split from the agreement context.
 * Pure: identical rows and context yield identical flows.
 */
export function payoutFlowsFor(cbtCode: string, ctx: AgreementContext, rows: readonly LedgerRow[]): AssetPayouts {
  const flows = rows
    .filter((row) => row.cbtCode === cbtCode)
    .map((row): PayoutFlow => ({
      transactionId: row.transactionId,
      platform: row.platform,
      settledAt: row.createdAt,
      currency: row.currency,
      grossSettled: row.grossSettled,
      covenantFee: row.covenantFee,
      cornerDustCollected: row.cornerDustCollected,
      lines: row.disbursements.map((d) => ({
        holder: d.rightsHolderName,
        role: d.role,
        recordedPercent: recordedShareFor(d.rightsHolderName, ctx),
        grossShare: d.grossShare,
        withholdingTaxDeducted: d.withholdingTaxDeducted,
        netShare: d.netShare,
      })),
    }));

  return { flows, totals: totalsFor(flows) };
}

function recordedShareFor(holderName: string, ctx: AgreementContext): string | undefined {
  const shares = new Set<string>();
  for (const pool of ctx.pools) {
    for (const holder of pool.holders) {
      if (holder.name === holderName && holder.sharePercent) shares.add(holder.sharePercent);
    }
  }
  // A holder on several pools at conflicting shares has no single recorded %.
  return shares.size === 1 ? [...shares][0] : undefined;
}

function totalsFor(flows: PayoutFlow[]): PayoutTotals[] {
  const byCurrency = new Map<string, PayoutTotals>();
  for (const flow of flows) {
    const entry = byCurrency.get(flow.currency) ?? {
      currency: flow.currency,
      gross: 0,
      fees: 0,
      net: 0,
      settlements: 0,
    };
    const disbursed = flow.lines.reduce((sum, l) => sum + l.netShare, 0);
    entry.gross += flow.grossSettled;
    entry.fees += flow.covenantFee;
    entry.net += disbursed;
    entry.settlements += 1;
    byCurrency.set(flow.currency, entry);
  }
  return [...byCurrency.values()];
}
