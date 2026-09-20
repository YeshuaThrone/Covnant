/**
 * SovereignLedgerRecord — the founder's master ledger record (CovnantMasterDataSDK
 * canon): the unit of settlement on every master admin data surface.
 *
 * HONESTY LAW: the 50/35/15 allocations are NEVER hardcoded dollar strings —
 * every record's allocation is computed through the engine's real integer-cent
 * allocation mechanic (`allocateWithCompanyDustSweep`, the same BPS +
 * company-dust-sweep machinery the UDR splits run on), so sum(allocations) +
 * company dust === gross by construction, and any engine drift throws at
 * settlement time instead of rendering wrong numbers.
 */

import { createHash } from 'node:crypto';
import { allocateWithCompanyDustSweep } from '@/modules/don/dust';
import type { SplitPartyInput } from '@/lib/don/types';
import {
  MASTER_CATEGORY_CODES,
  type GlobalEntertainmentCategory,
} from './taxonomy';

/** The three allocation buckets of the sovereign record — integer cents. */
export interface SovereignAllocations {
  /** 50% — ownership reserve. */
  ownershipReserveCents: number;
  /** 35% — creative royalty. */
  creativeRoyaltyCents: number;
  /** 15% — production operations. */
  productionOperationsCents: number;
}

/** The clearinghouse status domain — the founder's three states. */
export type ClearinghouseStatus = 'VERIFIED_IMMUTABLE' | 'PENDING_CLEARANCE' | 'ACTIVE_YIELD';

export const CLEARINGHOUSE_STATUSES: readonly ClearinghouseStatus[] = [
  'VERIFIED_IMMUTABLE',
  'PENDING_CLEARANCE',
  'ACTIVE_YIELD',
];

/** The founder's SovereignLedgerRecord — one settled master ledger row. */
export interface SovereignLedgerRecord {
  /** `CVN-<CAT4>-2026-00N` — category code + deterministic sequence. */
  ledgerId: string;
  assetTitle: string;
  /** Pseudonymized rights holder — a deterministic hash, never a raw name. */
  rightsHolderHash: string;
  category: GlobalEntertainmentCategory;
  subcategory: string;
  /** Gross volume in integer USD cents (rendered by lib/money/format). */
  grossVolumeCents: number;
  allocations: SovereignAllocations;
  clearinghouseStatus: ClearinghouseStatus;
  /** ISO settlement instant. */
  settlementTimestamp: string;
}

/**
 * The sovereign allocation weights — 50% ownership reserve, 35% creative
 * royalty, 15% production operations. Sum is exactly 10,000 BPS, so the
 * engine's dust sweep settles at zero on every run; the sweep still runs
 * (same path as every other split) and its result is asserted.
 */
export const SOVEREIGN_ALLOCATION_BPS = {
  ownershipReserve: 5_000,
  creativeRoyalty: 3_500,
  productionOperations: 1_500,
} as const;

const SOVEREIGN_LEDGER_YEAR = 2026;

/** Deterministic pseudonymization for the rights holder column. */
export function rightsHolderHash(key: string): string {
  return `rh_${createHash('sha256').update(key).digest('hex').slice(0, 16)}`;
}

/** The sovereign ledgerId — CVN-<CAT4>-2026-00N, zero-padded sequence. */
export function sovereignLedgerId(category: GlobalEntertainmentCategory, sequence: number): string {
  if (!Number.isInteger(sequence) || sequence < 1) {
    throw new Error(`sovereignLedgerId: sequence must be a positive integer, got ${sequence}`);
  }
  return `CVN-${MASTER_CATEGORY_CODES[category]}-${SOVEREIGN_LEDGER_YEAR}-${String(sequence).padStart(3, '0')}`;
}

export interface SovereignSettlementInput {
  category: GlobalEntertainmentCategory;
  subcategory: string;
  assetTitle: string;
  /** Stable rights-holder key — hashed, never rendered raw. */
  rightsHolderKey: string;
  /** Gross volume in integer USD cents. */
  grossVolumeCents: number;
  clearinghouseStatus: ClearinghouseStatus;
  settlementTimestamp: string;
  /** Per-category sequence for the ledgerId (1-based). */
  sequence: number;
}

/**
 * Settle one sovereign record through the REAL allocation path: the gross
 * runs through allocateWithCompanyDustSweep at the canon 50/35/15 weights —
 * integer cents, company dust sweep, zero-balance identity asserted. A
 * failed allocation throws (never swallowed, never defaulted).
 */
export function settleSovereignRecord(input: SovereignSettlementInput): SovereignLedgerRecord {
  const { grossVolumeCents } = input;
  if (!Number.isInteger(grossVolumeCents) || grossVolumeCents <= 0) {
    throw new Error(`settleSovereignRecord: gross must be a positive integer cent count, got ${grossVolumeCents}`);
  }

  // Roles stay inside the PayeeRole domain; the bucket identity lives in
  // the payee_id, which the map below keys on.
  const splits: SplitPartyInput[] = [
    { payee_id: 'ownership_reserve', payee_name: 'Ownership Reserve', role: 'other', share_bps: SOVEREIGN_ALLOCATION_BPS.ownershipReserve },
    { payee_id: 'creative_royalty', payee_name: 'Creative Royalty', role: 'other', share_bps: SOVEREIGN_ALLOCATION_BPS.creativeRoyalty },
    { payee_id: 'production_operations', payee_name: 'Production Operations', role: 'other', share_bps: SOVEREIGN_ALLOCATION_BPS.productionOperations },
  ];
  const result = allocateWithCompanyDustSweep(grossVolumeCents, splits);
  if (!result.ok) {
    // Never swallowed: a mis-balanced sovereign allocation is a programmer
    // error and must fail the settlement loudly.
    throw new Error(`settleSovereignRecord: ${result.code} — ${result.message}`);
  }
  const byPayee = new Map(result.splits.map((split) => [split.payee_id, split.amount_cents]));
  const ownershipReserveCents = byPayee.get('ownership_reserve');
  const creativeRoyaltyCents = byPayee.get('creative_royalty');
  const productionOperationsCents = byPayee.get('production_operations');
  if (
    ownershipReserveCents === undefined ||
    creativeRoyaltyCents === undefined ||
    productionOperationsCents === undefined
  ) {
    throw new Error('settleSovereignRecord: allocation engine returned an unexpected bucket set');
  }

  return {
    ledgerId: sovereignLedgerId(input.category, input.sequence),
    assetTitle: input.assetTitle,
    rightsHolderHash: rightsHolderHash(input.rightsHolderKey),
    category: input.category,
    subcategory: input.subcategory,
    grossVolumeCents,
    allocations: {
      ownershipReserveCents,
      creativeRoyaltyCents,
      productionOperationsCents,
    },
    clearinghouseStatus: input.clearinghouseStatus,
    settlementTimestamp: input.settlementTimestamp,
  };
}

/** Aggregates behind every stat card — computed FROM records, never constants. */
export interface SovereignLedgerSummary {
  recordCount: number;
  grossVolumeCents: number;
  ownershipReserveCents: number;
  creativeRoyaltyCents: number;
  productionOperationsCents: number;
  statusCounts: Record<ClearinghouseStatus, number>;
}

/** Pure reducer over records — the numbers the master surfaces render. */
export function summarizeSovereignLedger(records: readonly SovereignLedgerRecord[]): SovereignLedgerSummary {
  const summary: SovereignLedgerSummary = {
    recordCount: records.length,
    grossVolumeCents: 0,
    ownershipReserveCents: 0,
    creativeRoyaltyCents: 0,
    productionOperationsCents: 0,
    statusCounts: { VERIFIED_IMMUTABLE: 0, PENDING_CLEARANCE: 0, ACTIVE_YIELD: 0 },
  };
  for (const record of records) {
    summary.grossVolumeCents += record.grossVolumeCents;
    summary.ownershipReserveCents += record.allocations.ownershipReserveCents;
    summary.creativeRoyaltyCents += record.allocations.creativeRoyaltyCents;
    summary.productionOperationsCents += record.allocations.productionOperationsCents;
    summary.statusCounts[record.clearinghouseStatus] += 1;
  }
  return summary;
}
