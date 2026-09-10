/**
 * Ledger disbursement-entry guards — the two JSONB shapes the escrow and
 * display layers read, discriminated exactly once for the whole codebase:
 *
 *   - engine settlement entries (DisbursementDetail): carry a numeric
 *     `grossShare` and NO `type` field — the holder's royalty credits.
 *   - payout entries (type 'DISBURSEMENT', written by the withdraw route):
 *     escrow debits that reduce the withdrawable balance.
 *
 * Pure and client-safe: no imports, no I/O. The escrow balance module and
 * the dashboard's display slice must never disagree about what counts as a
 * settlement, so the guards live here. The engine's DisbursementDetail
 * carries more fields than this structural view — the guards read exactly
 * the fields the two consumers use.
 */

/** Engine settlement disbursement — the fields the display slice reads. */
export interface SettlementEntry {
  rightsHolderId: string;
  grossShare: number;
  withholdingTaxDeducted?: number;
  netShare?: number;
}

/** A withdraw-route payout entry as persisted in ledger disbursements JSONB. Money fields are smallest-unit strings to avoid float loss. */
export interface PayoutDisbursementEntry {
  type: 'DISBURSEMENT';
  rightsHolderId: string;
  payoutAmount: string;
  amountPaid: string;
  taxWithheld: string;
  plaidAuthorizationId?: string;
  plaidTransferId?: string;
  timestamp: number;
  remainingNetBalance: string;
}

export function isPayoutEntry(entry: unknown): entry is PayoutDisbursementEntry {
  return (
    typeof entry === 'object' &&
    entry !== null &&
    'type' in entry &&
    (entry as { type?: unknown }).type === 'DISBURSEMENT'
  );
}

export function isSettlementEntry(entry: unknown): entry is SettlementEntry {
  return (
    typeof entry === 'object' &&
    entry !== null &&
    !('type' in entry) &&
    'grossShare' in entry &&
    typeof (entry as { grossShare?: unknown }).grossShare === 'number'
  );
}
