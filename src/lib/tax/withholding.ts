/**
 * Tax selectors — the store-driven layer behind the admin Tax tab and its
 * CSV export. One truth, two honest layers:
 *
 *  - LEDGER LAYER: the Don settlement engine's stored row figures (gross,
 *    covenant fee, corner dust, per-payee withholding, net) — the
 *    PRE-TAX distributable. Sums fold in BigInt minor units, exactly like
 *    the ledger finances audit.
 *  - TAX LAYER: every payee payout resolved through CovnantTaxEngineSDK
 *    (the founder's engine of record) — withholding, state nexus tax, net
 *    clearing payout, form triggered, lock state. The engine's gross input
 *    for each payout IS the ledger's stored disbursement gross share — the
 *    equality test pins that, so no dollar figure is ever copied twice.
 *
 * The fold is chronological with running per-payee YTD so the founder's
 * $10 MISC / $2,000 NEC form triggers evaluate on real cumulative cleared
 * gross. Currency discipline: the tax engine is USD-denominated, so only
 * USD settlements resolve through it; other currencies are counted and
 * disclosed, never silently dropped.
 *
 * Server module (imports the master store through the payee profile
 * layer) — the Tax section renders the composed payload, never this file.
 */

import { cvtDisplayCode } from '@/lib/splits/codes';
import { toMinor } from '@/lib/ledger/reconciliation';
import type { LedgerRow } from '@/lib/ledger/store';
import type { CovenantBlockAsset } from '@/engine/covenant-master-sdk';
import { UCT_DEMO_IDENTITIES } from '@/lib/master/masterStore';
import { CovnantTaxEngineSDK } from './CovnantTaxComplianceSDK';
import type { TaxLockState, TaxResolutionResult } from './CovnantTaxComplianceSDK';
import {
  DEMO_PAYEE_TAX_BRANCHES,
  identityKeyFromPayeeId,
  jurisdictionLabel,
  payeeTaxProfileFor,
} from './payeeProfiles';

/** A single payee payout resolved through the founder's engine. */
export interface ResolvedPayeePayout {
  row: LedgerRow;
  disbursement: LedgerRow['disbursements'][number];
  resolution: TaxResolutionResult;
}

/** The chronological fold's output. */
export interface TaxResolutionFold {
  /** USD payouts in settlement order (oldest first, transaction id tiebreak). */
  payouts: ResolvedPayeePayout[];
  /** Running cleared gross USD per payee identity key, after each payout. */
  ytdByPayee: Map<string, number>;
  /** Settled rows in other currencies — outside the USD engine, disclosed. */
  excludedNonUsdSettlements: number;
}

/** Engine totals in exact USD cents (bigint — integer discipline). */
export interface TaxEngineTotalsView {
  grossCents: bigint;
  withheldCents: bigint;
  stateTaxCents: bigint;
  netCents: bigint;
}

export interface TaxPayeeRowView {
  payeeId: string;
  payeeName: string;
  uctId: string | null;
  isni: string | null;
  ipi: string | null;
  jurisdiction: string | null;
  tinStatus: string;
  forms: string[];
  transactionCount: number;
  /** Ledger layer — BigInt minor units of the settlement currency (USD). */
  grossMinor: bigint;
  withheldMinor: bigint;
  netMinor: bigint;
  /** Cleared gross USD year to date through this payee's last payout. */
  ytdClearedGrossUsd: number;
  engine: TaxEngineTotalsView;
  effectiveRate: number;
  lockState: TaxLockState;
  lockReason: string | null;
}

export interface TaxPeriodRowView {
  year: number;
  transactions: number;
  grossMinor: bigint;
  feeMinor: bigint;
  dustMinor: bigint;
  withheldMinor: bigint;
  netMinor: bigint;
  engine: TaxEngineTotalsView;
}

export interface TaxAnnualRowView {
  year: number;
  payeeId: string;
  payeeName: string;
  uctId: string | null;
  isni: string | null;
  ipi: string | null;
  jurisdiction: string | null;
  tinStatus: string;
  forms: string[];
  transactionCount: number;
  grossMinor: bigint;
  withheldMinor: bigint;
  netMinor: bigint;
  engine: TaxEngineTotalsView;
  effectiveRate: number;
  lockState: TaxLockState;
  lockReason: string | null;
}

export interface TaxTransactionRowView {
  transactionId: string;
  /** ISO date of the settlement. */
  date: string;
  cbt: string;
  cvt: string;
  entityType: string | null;
  template: string | null;
  payeeCount: number;
  /** Distinct founder-engine forms triggered across the row's payouts. */
  forms: string[];
  grossMinor: bigint;
  feeMinor: bigint;
  dustMinor: bigint;
  withheldMinor: bigint;
  netMinor: bigint;
  engine: TaxEngineTotalsView;
  effectiveRate: number;
  lockState: TaxLockState;
  lockReason: string | null;
}

export interface TaxCurrencyRowView {
  currency: string;
  settlements: number;
  grossMinor: bigint;
  feeMinor: bigint;
  dustMinor: bigint;
}

/** Joins the composer derives from the stores of record — the selector stays pure. */
export interface TaxJoinContext {
  /** Entity type of record per CBT (asset medium or demo registry kind). */
  entityTypeByCbt: ReadonlyMap<string, string>;
  /** Template binding of record per CBT (vault contract or lane execution stamp). */
  templateByCbt: ReadonlyMap<string, string>;
  /** The event's US state jurisdiction per CBT, when the record carries one. */
  eventStateByCbt: ReadonlyMap<string, string>;
}

const ENGINE = new CovnantTaxEngineSDK();

/**
 * Crew and contractor flows resolve as SERVICE payouts; royalty, master
 * and publishing flows as ROYALTY. The ledger role of record decides.
 */
export function payoutTypeForRole(role: string): 'ROYALTY' | 'SERVICE' {
  return role === 'PRODUCER' ? 'SERVICE' : 'ROYALTY';
}

/** The demo door's transaction id prefix — every row it lands carries it. */
const DEMO_TRANSACTION_PREFIX = 'DIR-DEMO-';

/** True when the ledger's rows were landed by the demo settlement door. */
export function isDemoLedger(rows: readonly LedgerRow[]): boolean {
  return rows.some((row) => row.transactionId.startsWith(DEMO_TRANSACTION_PREFIX));
}

/** Chronological USD-only fold: every disbursement through the founder's engine. */
export function resolvePayeePayouts(
  rows: readonly LedgerRow[],
  joins: TaxJoinContext,
): TaxResolutionFold {
  const ordered = rows
    .filter((row) => row.currency === 'USD')
    .sort(
      (a, b) =>
        rowDate(a).getTime() - rowDate(b).getTime() ||
        a.transactionId.localeCompare(b.transactionId),
    );
  const payouts: ResolvedPayeePayout[] = [];
  const ytdByPayee = new Map<string, number>();
  for (const row of ordered) {
    for (const disbursement of row.disbursements) {
      const identityKey = identityKeyFromPayeeId(disbursement.rightsHolderId);
      const ytdBefore = ytdByPayee.get(identityKey) ?? 0;
      const profile = payeeTaxProfileFor(
        disbursement.rightsHolderId,
        disbursement.rightsHolderName,
        ytdBefore,
      );
      const resolution = ENGINE.processPayout({
        transactionId: row.transactionId,
        grossAmountUSD: disbursement.grossShare,
        payee: profile,
        payoutType: payoutTypeForRole(disbursement.role),
        eventState: joins.eventStateByCbt.get(row.cbtCode) ?? null,
      });
      payouts.push({ row, disbursement, resolution });
      ytdByPayee.set(identityKey, ytdBefore + disbursement.grossShare);
    }
  }
  return { payouts, ytdByPayee, excludedNonUsdSettlements: rows.length - ordered.length };
}

/** Exact engine totals for a set of payouts (USD cents, bigint). */
export function foldResolutions(payouts: readonly ResolvedPayeePayout[]): TaxEngineTotalsView {
  let grossCents = 0n;
  let withheldCents = 0n;
  let stateTaxCents = 0n;
  let netCents = 0n;
  for (const payout of payouts) {
    grossCents += BigInt(Math.round(payout.resolution.grossAmountUSD * 100));
    withheldCents += BigInt(Math.round(payout.resolution.withholdingTaxUSD * 100));
    stateTaxCents += BigInt(Math.round(payout.resolution.stateSalesTaxUSD * 100));
    netCents += BigInt(Math.round(payout.resolution.netClearingPayoutUSD * 100));
  }
  return { grossCents, withheldCents, stateTaxCents, netCents };
}

/** Combined effective rate over a payout set's gross (0 when no gross). */
export function effectiveRateOf(totals: TaxEngineTotalsView): number {
  if (totals.grossCents === 0n) return 0;
  return Number(totals.withheldCents + totals.stateTaxCents) / Number(totals.grossCents);
}

interface PayeeIdentity {
  uctId: string;
  name: string;
  isni: string | null;
  ipi: string | null;
}

/** The payee's identity of record from the master store (null when unknown). */
function identityOfRecord(identityKey: string): PayeeIdentity | null {
  const identity = UCT_DEMO_IDENTITIES[identityKey];
  if (!identity) return null;
  return {
    uctId: identity.uctId,
    name: identity.name,
    isni: identity.isni ?? null,
    ipi: identity.ipi ?? null,
  };
}

function payeeFields(identityKey: string, payeeName: string) {
  const identity = identityOfRecord(identityKey);
  const branch = DEMO_PAYEE_TAX_BRANCHES[identityKey];
  return {
    // The register row's id of record is the CREATOR identity key — stable
    // across roster indexes and seeds; the raw roster id names only one
    // per-asset participation.
    payeeId: identityKey,
    payeeName: identity?.name ?? payeeName,
    uctId: identity?.uctId ?? null,
    isni: identity?.isni ?? null,
    ipi: identity?.ipi ?? null,
    jurisdiction: branch ? jurisdictionLabel(branch) : null,
    tinStatus: branch?.tinStatus ?? 'UNSUBMITTED',
  };
}

function lockFields(payouts: readonly ResolvedPayeePayout[]): {
  lockState: TaxLockState;
  lockReason: string | null;
} {
  const held = payouts.find((payout) => payout.resolution.lockState === 'HELD_IN_TAX_ESCROW');
  return {
    lockState: held ? 'HELD_IN_TAX_ESCROW' : 'CLEARED',
    lockReason: held?.resolution.lockReason ?? null,
  };
}

/** Group payouts by a keying function (stable insertion order). */
function groupBy<T>(
  payouts: readonly ResolvedPayeePayout[],
  keyOf: (payout: ResolvedPayeePayout) => T,
): Map<T, ResolvedPayeePayout[]> {
  const groups = new Map<T, ResolvedPayeePayout[]>();
  for (const payout of payouts) {
    const key = keyOf(payout);
    const group = groups.get(key) ?? [];
    group.push(payout);
    groups.set(key, group);
  }
  return groups;
}

/** Ledger-layer minor-unit sums over a payout group. */
function ledgerSums(group: readonly ResolvedPayeePayout[]) {
  return {
    grossMinor: group.reduce(
      (sum, payout) => sum + toMinor(payout.disbursement.grossShare, 'USD'),
      0n,
    ),
    withheldMinor: group.reduce(
      (sum, payout) => sum + toMinor(payout.disbursement.withholdingTaxDeducted, 'USD'),
      0n,
    ),
    netMinor: group.reduce(
      (sum, payout) => sum + toMinor(payout.disbursement.netShare, 'USD'),
      0n,
    ),
  };
}

/**
 * The WITHHOLDING REGISTER — one row per payee of record, ALL creators
 * with cleared history, no curated subset. Engine rate and lock state ride
 * each row; the ledger layer keeps its own exact minor-unit sums.
 */
export function withholdingRegisterRows(
  payouts: readonly ResolvedPayeePayout[],
  ytdByPayee: ReadonlyMap<string, number>,
): TaxPayeeRowView[] {
  const groups = groupBy(payouts, (payout) =>
    identityKeyFromPayeeId(payout.disbursement.rightsHolderId),
  );
  const rows = [...groups.entries()].map(([identityKey, group]) => {
    const first = group[0];
    const engine = foldResolutions(group);
    return {
      ...payeeFields(identityKey, first.disbursement.rightsHolderName),
      forms: [...new Set(group.map((payout) => payout.resolution.formTriggered))],
      transactionCount: group.length,
      ...ledgerSums(group),
      ytdClearedGrossUsd: ytdByPayee.get(identityKey) ?? 0,
      engine,
      effectiveRate: effectiveRateOf(engine),
      ...lockFields(group),
    };
  });
  return rows.sort((a, b) => a.payeeName.localeCompare(b.payeeName));
}

/** The PERIOD SUMMARY — one totals row per tax year present in the ledger. */
export function periodSummaryRows(
  rows: readonly LedgerRow[],
  payouts: readonly ResolvedPayeePayout[],
): TaxPeriodRowView[] {
  const byYear = new Map<number, LedgerRow[]>();
  for (const row of rows) {
    if (row.currency !== 'USD') continue;
    const year = rowDate(row).getUTCFullYear();
    const group = byYear.get(year) ?? [];
    group.push(row);
    byYear.set(year, group);
  }
  const payoutsByYear = groupBy(payouts, (payout) => rowDate(payout.row).getUTCFullYear());
  return [...byYear.entries()]
    .sort(([a], [b]) => a - b)
    .map(([year, yearRows]) => {
      const engine = foldResolutions(payoutsByYear.get(year) ?? []);
      return {
        year,
        transactions: yearRows.length,
        grossMinor: yearRows.reduce((sum, row) => sum + toMinor(row.grossSettled, row.currency), 0n),
        feeMinor: yearRows.reduce((sum, row) => sum + toMinor(row.covenantFee, row.currency), 0n),
        dustMinor: yearRows.reduce(
          (sum, row) => sum + toMinor(row.cornerDustCollected, row.currency),
          0n,
        ),
        withheldMinor: yearRows.reduce(
          (sum, row) =>
            sum +
            row.disbursements.reduce(
              (inner, disbursement) =>
                inner + toMinor(disbursement.withholdingTaxDeducted, row.currency),
              0n,
            ),
          0n,
        ),
        netMinor: yearRows.reduce(
          (sum, row) =>
            sum +
            row.disbursements.reduce(
              (inner, disbursement) => inner + toMinor(disbursement.netShare, row.currency),
              0n,
            ),
          0n,
        ),
        engine,
      };
    });
}

/** The per-payee ANNUAL summary — every creator, every year (CSV block one). */
export function annualPayeeRows(payouts: readonly ResolvedPayeePayout[]): TaxAnnualRowView[] {
  const byYearPayee = groupBy(
    payouts,
    (payout) =>
      `${rowDate(payout.row).getUTCFullYear()}|${identityKeyFromPayeeId(payout.disbursement.rightsHolderId)}`,
  );
  const rows = [...byYearPayee.entries()].map(([groupKey, group]) => {
    const first = group[0];
    const identityKey = identityKeyFromPayeeId(first.disbursement.rightsHolderId);
    const engine = foldResolutions(group);
    return {
      year: Number(groupKey.slice(0, groupKey.indexOf('|'))),
      ...payeeFields(
        identityKey,
        first.disbursement.rightsHolderId,
        first.disbursement.rightsHolderName,
      ),
      forms: [...new Set(group.map((payout) => payout.resolution.formTriggered))],
      transactionCount: group.length,
      ...ledgerSums(group),
      engine,
      effectiveRate: effectiveRateOf(engine),
      ...lockFields(group),
    };
  });
  return rows.sort((a, b) => a.year - b.year || a.payeeName.localeCompare(b.payeeName));
}

/** The CBT-stamped TRANSACTION REGISTER — one row per settled transaction. */
export function transactionRegisterRows(
  rows: readonly LedgerRow[],
  payouts: readonly ResolvedPayeePayout[],
  joins: TaxJoinContext,
): TaxTransactionRowView[] {
  const byTransaction = groupBy(payouts, (payout) => payout.row.transactionId);
  return rows
    .filter((row) => row.currency === 'USD')
    .sort(
      (a, b) =>
        rowDate(a).getTime() - rowDate(b).getTime() ||
        a.transactionId.localeCompare(b.transactionId),
    )
    .map((row) => {
      const group = byTransaction.get(row.transactionId) ?? [];
      const engine = foldResolutions(group);
      return {
        transactionId: row.transactionId,
        date: rowDate(row).toISOString(),
        cbt: row.cbtCode,
        cvt: cvtDisplayCode(row.cbtCode),
        entityType: joins.entityTypeByCbt.get(row.cbtCode) ?? null,
        template: joins.templateByCbt.get(row.cbtCode) ?? null,
        payeeCount: group.length,
        forms: [...new Set(group.map((payout) => payout.resolution.formTriggered))],
        grossMinor: toMinor(row.grossSettled, row.currency),
        feeMinor: toMinor(row.covenantFee, row.currency),
        dustMinor: toMinor(row.cornerDustCollected, row.currency),
        withheldMinor: row.disbursements.reduce(
          (sum, disbursement) =>
            sum + toMinor(disbursement.withholdingTaxDeducted, row.currency),
          0n,
        ),
        netMinor: row.disbursements.reduce(
          (sum, disbursement) => sum + toMinor(disbursement.netShare, row.currency),
          0n,
        ),
        engine,
        effectiveRate: effectiveRateOf(engine),
        ...lockFields(group),
      };
    });
}

/** The PER-CURRENCY rollup — settlement counts and ledger layer by currency. */
export function currencyRollupRows(rows: readonly LedgerRow[]): TaxCurrencyRowView[] {
  const byCurrency = new Map<string, LedgerRow[]>();
  for (const row of rows) {
    const group = byCurrency.get(row.currency) ?? [];
    group.push(row);
    byCurrency.set(row.currency, group);
  }
  return [...byCurrency.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, group]) => ({
      currency,
      settlements: group.length,
      grossMinor: group.reduce((sum, row) => sum + toMinor(row.grossSettled, currency), 0n),
      feeMinor: group.reduce((sum, row) => sum + toMinor(row.covenantFee, currency), 0n),
      dustMinor: group.reduce((sum, row) => sum + toMinor(row.cornerDustCollected, currency), 0n),
    }));
}

/** The row's creation timestamp of record — the ledger stores ISO strings. */
function rowDate(row: LedgerRow): Date {
  return new Date(row.createdAt);
}

/** Build the join context from the stores of record (composer-side). */
export function buildTaxJoinContext(
  assets: readonly CovenantBlockAsset[],
  options: {
    /** Entity-type labels of record beyond the assets (the demo registry's kinds). */
    entityTypeLabels?: readonly { cbtCode: string; label: string }[];
    templateBindings: readonly { cbtCode: string; templateId: string | null }[];
    eventStates: readonly { cbtCode: string; state: string }[];
  },
): TaxJoinContext {
  const entityTypeByCbt = new Map<string, string>();
  for (const asset of assets) entityTypeByCbt.set(asset.cbtCode, asset.medium);
  for (const label of options.entityTypeLabels ?? []) {
    entityTypeByCbt.set(label.cbtCode, label.label);
  }
  const templateByCbt = new Map<string, string>();
  for (const binding of options.templateBindings) {
    if (binding.templateId) templateByCbt.set(binding.cbtCode, binding.templateId);
  }
  const eventStateByCbt = new Map<string, string>();
  for (const entry of options.eventStates) eventStateByCbt.set(entry.cbtCode, entry.state);
  return { entityTypeByCbt, templateByCbt, eventStateByCbt };
}
