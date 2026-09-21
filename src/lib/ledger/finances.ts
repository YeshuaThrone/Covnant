/**
 * Ledger finances — the shared selector layer for the Universal Royalty
 * Ledger's settlement data (founder directive, 2026-09-20: the /admin Ledger
 * section is the FINANCES surface and must read the same engine output as
 * the /ledger page — one truth, never copied strings).
 *
 * Everything here is pure and client-safe (no engine import, no server-only
 * import): the /ledger page, the /admin page, and the /admin Ledger section
 * all flow through these helpers, so a figure rendered in either surface is
 * the figure the settlement engines produced. The reconciliation math lives
 * in ./reconciliation (BigInt minor units); the escrow state below reads the
 * stored disbursements with the same micro-unit discipline as
 * src/lib/escrow/balance.ts.
 */

import { withRegistryPills, type RegistryKeyAsset, type RegistryPill } from '@/lib/assets/registry-keys';
import { microFromNumber } from '@/lib/fixed-point';
import type { LedgerRow } from './store';

/** A settlement row carrying its asset's registry pills (Black Box Shield). */
export type SettlementRowView = LedgerRow & { registry: RegistryPill[] };

/** A payout escrow-debit entry as persisted by the withdraw route. */
interface PayoutEntry {
  type: 'DISBURSEMENT';
  rightsHolderId: string;
  payoutAmount: string;
}

function isPayoutEntry(entry: unknown): entry is PayoutEntry {
  return (
    typeof entry === 'object' &&
    entry !== null &&
    'type' in entry &&
    (entry as { type?: unknown }).type === 'DISBURSEMENT' &&
    typeof (entry as { rightsHolderId?: unknown }).rightsHolderId === 'string'
  );
}

/** Ledger rows ride with their asset's registry pills — CBT/CVT audit keys next to the amounts. */
export function attachRegistryPills(
  rows: LedgerRow[],
  assets: ReadonlyArray<RegistryKeyAsset>,
): SettlementRowView[] {
  const assetByCode = new Map(assets.map((a) => [a.cbtCode, a]));
  return rows.map((row) => withRegistryPills(row, assetByCode.get(row.cbtCode)));
}

export interface HolderEscrowState {
  rightsHolderId: string;
  /** The holder's name of record on the settlements. */
  name: string;
  /** Set of settlement currencies the holder was paid in (never summed across). */
  currencies: string[];
  /** Σ grossShare in micro units (1e-8) — the escrow module's integer space. */
  grossUnits: bigint;
  /** Σ withholdingTaxDeducted in micro units — the stored engine deduction. */
  withheldUnits: bigint;
  /** Σ netShare in micro units. */
  netUnits: bigint;
  /** Σ payout escrow debits in micro units (zero until a withdrawal posts). */
  paidOutUnits: bigint;
}

/**
 * Escrow state per rights holder, folded from the STORED disbursements —
 * the engine-settled gross / withheld / net plus the withdraw route's
 * payout debits. Available funds are net minus payouts; nothing is
 * re-derived from a tax profile (the stored deduction is the record).
 */
export function escrowStateFromRows(rows: LedgerRow[]): HolderEscrowState[] {
  const states = new Map<string, HolderEscrowState>();
  for (const row of rows) {
    for (const entry of row.disbursements) {
      if (isPayoutEntry(entry)) {
        const state = states.get(entry.rightsHolderId);
        if (state) {
          state.paidOutUnits += BigInt(entry.payoutAmount);
        }
        continue;
      }
      const existing = states.get(entry.rightsHolderId);
      const state = existing ?? {
        rightsHolderId: entry.rightsHolderId,
        name: entry.rightsHolderName,
        currencies: [],
        grossUnits: 0n,
        withheldUnits: 0n,
        netUnits: 0n,
        paidOutUnits: 0n,
      };
      if (!existing) states.set(entry.rightsHolderId, state);
      if (!state.currencies.includes(row.currency)) state.currencies.push(row.currency);
      state.grossUnits += microFromNumber(entry.grossShare);
      state.withheldUnits += microFromNumber(entry.withholdingTaxDeducted);
      state.netUnits += microFromNumber(entry.netShare);
    }
  }
  return [...states.values()];
}
