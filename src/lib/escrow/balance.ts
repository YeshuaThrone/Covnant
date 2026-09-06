/**
 * Shared escrow balance math — the single source of truth for what a rights
 * holder may withdraw. The artist dashboard and the payout withdrawal route
 * both flow through this module so the two surfaces can never disagree.
 *
 * Every amount is an explicit BigInt in smallest ledger units (1e-8 scale,
 * matching universal_royalty_ledger's numeric(20,8) columns). Floats enter
 * integer space only through microFromNumber's exact decimal-string adapter,
 * never through binary multiplication.
 *
 * The ledger disbursements JSONB carries two entry shapes:
 *
 *   - engine settlement entries (DisbursementDetail): carry a numeric
 *     `grossShare` and no `type` field — these sum to the holder's gross
 *     earnings.
 *   - payout entries (type 'DISBURSEMENT', written by the withdraw route):
 *     escrow debits that reduce the withdrawable balance.
 *
 * Balance reads select ONLY the disbursements column, so this math works
 * identically before and after the optional transaction_type column DDL.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  CovenantTaxEngine,
  type DisbursementDetail,
  type SelfServeRightsHolder,
  type TaxProfile,
} from '@/engine/covenant-master-sdk';
import { FixedPointParseError, MICRO_SCALE, microFromNumber } from '@/lib/fixed-point';

/** Thrown when the ledger read behind a balance computation fails. Fail closed: an escrow error must never surface as a zero (or stale) balance. */
export class EscrowLedgerReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EscrowLedgerReadError';
  }
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

export interface EscrowBalance {
  /** Σ settlement grossShare for the holder across all ledger rows. */
  grossUnits: bigint;
  /** Engine effective rate for the holder's tax profile on US territory. */
  taxRate: number;
  /** grossUnits × taxRate, floored in smallest units. */
  taxWithheldUnits: bigint;
  /** Σ prior payout (type 'DISBURSEMENT') escrow debits for the holder. */
  previousPayoutUnits: bigint;
  /** grossUnits − taxWithheldUnits − previousPayoutUnits. */
  availableUnits: bigint;
}

/**
 * Engine tax rate for the holder's profile on US territory (the locked
 * dashboard territory): unverified US → 0.24, unverified foreign → 0.30,
 * verified → 0 unless backup withholding applies, foreign verified → treaty.
 */
export function taxRateForProfile(profile: TaxProfile): number {
  return CovenantTaxEngine.calculateEffectiveTaxRate(profile, 'US');
}

/**
 * Mandatory withholding on a gross amount at `rate`, computed in exact BigInt
 * math from the rate's decimal-string form (0.24 → 24/100) — never through a
 * float multiply, whose binary rounding silently skews escrow cents.
 * BigInt division truncates toward zero, i.e. floors for non-negative gross.
 */
export function withholdingUnitsOn(grossUnits: bigint, rate: number): bigint {
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
    throw new RangeError(`Withholding rate: ${rate} is not a fraction in [0, 1].`);
  }
  if (rate === 0 || grossUnits <= 0n) return 0n;

  // Number.prototype.toString gives the shortest round-trip decimal form of
  // the engine's literal rates ('0.24', '0.3', '0.15'), which parses back
  // into an exact numerator/denominator pair.
  const rateString = rate.toString();
  const dot = rateString.indexOf('.');
  const digits = dot === -1 ? rateString : rateString.slice(0, dot) + rateString.slice(dot + 1);
  const denominator = 10n ** BigInt(dot === -1 ? 0 : rateString.length - dot - 1);
  return (grossUnits * BigInt(digits)) / denominator;
}

function isPayoutEntry(entry: unknown): entry is PayoutDisbursementEntry {
  return (
    typeof entry === 'object' &&
    entry !== null &&
    'type' in entry &&
    (entry as { type?: unknown }).type === 'DISBURSEMENT'
  );
}

function isSettlementEntry(entry: unknown): entry is DisbursementDetail {
  return (
    typeof entry === 'object' &&
    entry !== null &&
    !('type' in entry) &&
    'grossShare' in entry &&
    typeof (entry as { grossShare?: unknown }).grossShare === 'number'
  );
}

/** Gross earnings: Σ settlement grossShare for the holder across the given disbursements arrays. */
export function grossUnitsForHolder(disbursementsByRow: unknown[], rightsHolderId: string): bigint {
  let gross = 0n;
  for (const entry of disbursementsByRow) {
    if (isSettlementEntry(entry) && entry.rightsHolderId === rightsHolderId) {
      gross += microFromNumber(entry.grossShare);
    }
  }
  return gross;
}

/** Prior payouts: Σ type-'DISBURSEMENT' escrow debits (payoutAmount) for the holder. */
export function previousPayoutUnitsFor(disbursementsByRow: unknown[], rightsHolderId: string): bigint {
  let payouts = 0n;
  for (const entry of disbursementsByRow) {
    if (isPayoutEntry(entry) && entry.rightsHolderId === rightsHolderId) {
      payouts += BigInt(entry.payoutAmount);
    }
  }
  return payouts;
}

/** The full balance computation both routes share. Pure — no I/O. */
export function escrowBalanceForHolder(params: {
  /** disbursements JSONB arrays, one per ledger row */
  disbursementsByRow: unknown[][];
  rightsHolderId: string;
  taxProfile: TaxProfile;
}): EscrowBalance {
  const { disbursementsByRow, rightsHolderId, taxProfile } = params;
  const grossUnits = disbursementsByRow.reduce(
    (sum, row) => sum + grossUnitsForHolder(Array.isArray(row) ? row : [], rightsHolderId),
    0n,
  );
  const taxRate = taxRateForProfile(taxProfile);
  const taxWithheldUnits = withholdingUnitsOn(grossUnits, taxRate);
  const previousPayoutUnits = disbursementsByRow.reduce(
    (sum, row) => sum + previousPayoutUnitsFor(Array.isArray(row) ? row : [], rightsHolderId),
    0n,
  );
  return {
    grossUnits,
    taxRate,
    taxWithheldUnits,
    previousPayoutUnits,
    availableUnits: grossUnits - taxWithheldUnits - previousPayoutUnits,
  };
}

/**
 * Canonical ledger read behind both routes: select ONLY the disbursements
 * column (never transaction_type), then run the shared math. Injected client
 * keeps this module free of environment reads; failures fail closed.
 */
export async function fetchEscrowBalance(
  db: SupabaseClient,
  rightsHolderId: string,
  taxProfile: TaxProfile,
): Promise<EscrowBalance> {
  const { data, error } = await db.from('universal_royalty_ledger').select('disbursements');
  if (error) {
    throw new EscrowLedgerReadError(`Ledger read failed: ${error.message}`);
  }
  const rows = (data ?? []).map((row) =>
    row !== null && typeof row === 'object' && 'disbursements' in row
      ? (row as { disbursements: unknown[] }).disbursements
      : [],
  );
  return escrowBalanceForHolder({ disbursementsByRow: rows, rightsHolderId, taxProfile });
}

/**
 * Scan cbt_assets rows' rights_holders JSONB for the holder with `id`.
 * Returns null when the holder appears on no asset.
 */
export function findRightsHolder(assetRows: unknown[], rightsHolderId: string): SelfServeRightsHolder | null {
  for (const row of assetRows) {
    const holders = (row as { rights_holders?: unknown } | null)?.rights_holders;
    if (!Array.isArray(holders)) continue;
    for (const holder of holders) {
      if (
        typeof holder === 'object' &&
        holder !== null &&
        'id' in holder &&
        (holder as { id?: unknown }).id === rightsHolderId
      ) {
        return holder as SelfServeRightsHolder;
      }
    }
  }
  return null;
}

/**
 * Conservative fallback when a rights holder carries no tax profile on any
 * asset: an unverified foreign profile → the engine's mandatory 30% US
 * withholding. Compliance errs toward withholding more, never less.
 */
export const UNVERIFIED_FALLBACK_TAX_PROFILE: TaxProfile = {
  taxFormType: 'W8BEN_FOREIGN_INDIVIDUAL',
  taxIdentifierEncrypted: '',
  usTaxResident: false,
  isBackupWithholdingRequired: false,
  isVerified: false,
};

/**
 * Plaid boundary conversion: smallest ledger units → Plaid's 2-decimal
 * amount string, e.g. 100000000 → '1.00', 150000000 → '1.50'.
 * Sub-cent dust (units below 10⁶) is truncated, never rounded up — escrow
 * never pays more than the balance math authorized.
 */
export function smallestUnitsToPlaidAmount(units: bigint): string {
  if (units < 0n) {
    throw new RangeError(`Plaid amount: ${units} is negative.`);
  }
  const whole = units / MICRO_SCALE;
  const cents = (units % MICRO_SCALE) / (MICRO_SCALE / 100n);
  return `${whole}.${cents.toString().padStart(2, '0')}`;
}

/** Re-export for route symmetry: parse errors from untrusted JSONB must surface, not swallow. */
export { FixedPointParseError };
