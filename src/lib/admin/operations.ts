/**
 * Operations Back Office — the derivation layer for the ninth console tab's
 * five views (spec art_Eis55ifL): Escrow & Settlements, Runs & Pipeline
 * Health, the verification-exception queue, the payee/creator registry, and
 * the operator audit log. Sibling of `catalogGrowth.ts` / `auditStatement.ts`
 * — same three-layer discipline: this module derives, the section renders,
 * nothing in components/ is touched here.
 *
 * THE ENGINE'S OWN NUMBERS, stated once per group. No figure here re-derives
 * engine arithmetic — the no-parallel-arithmetic law:
 *
 *   - Escrow state per rights holder reads THROUGH the stored record
 *     (`escrowStateFromRows`) and the withdraw-route balance engine
 *     (`escrowBalanceForHolder`) — the same functions the /ledger page and
 *     the payout routes run. A holder whose tax profile resolves on a
 *     registered asset uses that profile of record; a holder on no asset
 *     uses the escrow module's own fail-closed fallback
 *     (`UNVERIFIED_FALLBACK_TAX_PROFILE`), and the payload says which —
 *     `taxProfileSource` — never a silently substituted rate.
 *   - Runs are the `platformRevenueStreams` fold widened to run rows:
 *     `royalty_ingest` journals on `split_run` refs resolve to their run
 *     records; a run whose record is gone contributes no row (store-read
 *     only, nothing invented).
 *   - The exception queue's three groups stay honestly SEPARATE — they are
 *     three different computations over three different stores, never
 *     merged into one score: (1) the reconciliation engine's own
 *     findings[] and drift counts (`reconcileLedger`), (2) the tax
 *     engine's locks through the Tax tab's own selectors
 *     (`resolvePayeePayouts` / `foldResolutions`), and (3) the match
 *     queue's no-identifier-match quarantine. Under the demo seed group 1
 *     is legitimately empty (every settlement passes) — designed
 *     behavior, captured as evidence, not a defect.
 *   - Registry joins are exactly the joins they claim: the master store's
 *     UCT identities and tax branches behind `identityKeyFromPayeeId`, the
 *     Don store's own UCT projection, and creator profiles by id.
 *     Resolution is shown FROM THE JOIN RESULTS — no resolved/mixed/
 *     unresolved taxonomy is invented beyond what the joins yield.
 *   - Money truth stays in the stores and the engines: Don-store cents are
 *     integers of record (`BigInt(n)` — a non-integer cent would throw,
 *     never silently truncate); the tax engine's totals fold through
 *     `foldResolutions`' exact rounding. Bigint everywhere; no `Number()`
 *     on money, no float ever touches a balance.
 *
 * AUDIT-LOG CAPABILITY — the design point the spec calls out: the local
 * mirrors (in-memory, SQLite) return [] from `listAdminActions` because
 * they do not persist the admin_action_log table, while the Supabase
 * production store reads the real table. A bare [] is therefore ambiguous
 * between "nothing logged yet" and "this backend does not keep the audit
 * table". The distinction is resolved HERE, as a derivation-level
 * capability read off the store instance (`store instanceof
 * SupabaseStore`) — deliberately OUTSIDE the Store interface, because it
 * is a property of the backend the caller wired, not a method of the
 * contract. The payload carries it as `auditLog.persisted`: rows=[] with
 * persisted=true means no operator action has been logged yet; rows=[]
 * with persisted=false means the backend keeps no audit table at all.
 *
 * Honesty law: every list is honest — empty lists render as empty (the
 * section's empty states), never as zeros. A store read that fails
 * degrades the whole payload to the honest `null` (the unavailable state,
 * the siblings' treatment). Journal movements always carry all eight canon
 * kinds — a kind with no journals is a real zero row, not an absent one.
 * No causal language: this payload carries data tokens and store-carried
 * labels only; the why is not in any ledger.
 */

import type { CovenantBlockAsset, TaxProfile } from '@/engine/covenant-master-sdk';
import { UNVERIFIED_FALLBACK_TAX_PROFILE, escrowBalanceForHolder } from '@/lib/escrow/balance';
import { escrowStateFromRows } from '@/lib/ledger/finances';
import type { LedgerRow } from '@/lib/ledger/store';
import { reconcileLedger } from '@/lib/ledger/reconciliation';
import type { AdminActionChanges, AdminCreatorProfile } from '@/lib/admin/types';
import type { AdminActionRecord } from '@/lib/admin/actionLog';
import { UCT_DEMO_IDENTITIES, type UctDemoIdentity } from '@/lib/master/masterStore';
import { SupabaseStore } from '@/lib/server/supabaseStore';
import type { Store } from '@/lib/server/store';
import type { BaasTransferRecord, SplitRunRecord } from '@/lib/don/types';
import type {
  GlEntryRecord,
  GlJournalRecord,
  SovereignVaultRecord,
  SplitReversalRecord,
  VaultDisputeRecord,
} from '@/modules/don/records';
import { JOURNAL_KINDS } from '@/modules/don/constants';
import type { MatchQueueRecord, StatementIngestRecord } from '@/modules/sdk/records';
import {
  DEMO_PAYEE_TAX_BRANCHES,
  identityKeyFromPayeeId,
  type PayeeTaxBranch,
} from '@/lib/tax/payeeProfiles';
import {
  foldResolutions,
  resolvePayeePayouts,
  type TaxJoinContext,
} from '@/lib/tax/withholding';

// ─────────────────────────────────────────────────────────────────────────────
// The payload types — one safe read, bigint money throughout (Don-store
// figures in integer CENTS, universal-ledger figures in the layer's own
// units, labeled per field), rendering happens downstream.
// ─────────────────────────────────────────────────────────────────────────────

// ── 1. Escrow & Settlements ────────────────────────────────────────────────

/** One payee's dispute freeze of record — null when the vault carries none. */
export interface OperationsDisputeRow {
  readonly locked: boolean;
  /** The disputed line item of record — null when the freeze names none. */
  readonly lineItemId: string | null;
  readonly frozenFromAvailableCents: bigint;
  readonly frozenFromPendingCents: bigint;
  readonly updatedAt: string;
}

/** One payee's sovereign-vault buckets — the Don engine's stored balances, bigint cents. */
export interface OperationsVaultRow {
  readonly payeeId: string;
  readonly payeeName: string;
  readonly availableCents: bigint;
  readonly pendingCents: bigint;
  readonly reserveCents: bigint;
  /** The payout holds currently in flight for this payee (`sumInFlightPayoutHolds`). */
  readonly inFlightHoldCents: bigint;
  /** The payee's dispute freeze of record — null when none exists. */
  readonly dispute: OperationsDisputeRow | null;
  readonly updatedAt: string;
}

/** One BaaS transfer — the rail story of record. */
export interface OperationsTransferRow {
  readonly transferId: string;
  readonly provider: BaasTransferRecord['provider'];
  readonly rail: BaasTransferRecord['rail'];
  readonly payeeId: string;
  readonly payeeName: string;
  readonly amountCents: bigint;
  readonly currency: string;
  readonly status: BaasTransferRecord['status'];
  /** The engine's estimated-settlement instant of record — null when the row carries none. */
  readonly estimatedSettlement: string | null;
  readonly ledgerTransactionId: string | null;
  readonly createdAt: string;
}

/**
 * One GL journal kind's movement summary. All eight canon kinds are always
 * present (a kind with no journals is a real zero row); any non-canon kind
 * the ledger actually carries is appended after them, labeled verbatim.
 */
export interface OperationsJournalKindRow {
  readonly kind: string;
  readonly journalCount: number;
  readonly creditCents: bigint;
  readonly debitCents: bigint;
  /** The kind's newest journal UTC day of record — null when the kind has no journals. */
  readonly latestDay: string | null;
}

/**
 * Per-rights-holder escrow state — the Ledger tab's escrow-state-table
 * rows, deepened with the withdraw-route balance engine. The `stored*`
 * figures are the disbursements' record of record (micro units, 1e-8);
 * the `engine*` figures are `escrowBalanceForHolder`'s balance computation
 * (micro units). The two layers are disclosed side by side, never merged.
 */
export interface OperationsEscrowHolderRow {
  readonly rightsHolderId: string;
  readonly name: string;
  /** The settlement currencies the holder was paid in (never summed across). */
  readonly currencies: readonly string[];
  readonly storedGrossUnits: bigint;
  readonly storedWithheldUnits: bigint;
  readonly storedNetUnits: bigint;
  readonly paidOutUnits: bigint;
  readonly engineGrossUnits: bigint;
  readonly engineTaxWithheldUnits: bigint;
  readonly enginePreviousPayoutUnits: bigint;
  readonly engineAvailableUnits: bigint;
  /**
   * Where the engine's tax profile of record resolved: 'registry' — the
   * holder's entry on a registered asset; 'unverified-fallback' — the
   * escrow module's fail-closed profile for a holder on no asset.
   */
  readonly taxProfileSource: 'registry' | 'unverified-fallback';
}

/** One tax-escrow accrual row of record — the Don engine's per-creator/year ledger, verbatim. */
export interface OperationsTaxEscrowRow {
  readonly payeeId: string;
  /** The vault's payee name of record — null when the payee carries no vault. */
  readonly payeeName: string | null;
  readonly taxYear: number;
  readonly grossCents: bigint;
  readonly withheldCents: bigint;
  readonly netCents: bigint;
  readonly tinVerified: boolean;
  readonly w9OnFile: boolean;
  readonly requires1099: boolean;
  readonly crossed1099Threshold: boolean;
  readonly createdAt: string;
}

export interface OperationsEscrowSettlements {
  readonly vaults: readonly OperationsVaultRow[];
  /** BaaS transfers newest first (the store's own order). */
  readonly transfers: readonly OperationsTransferRow[];
  /** Per-holder escrow state, first-appearance order (`escrowStateFromRows`). */
  readonly escrowHolders: readonly OperationsEscrowHolderRow[];
  /** The tax-escrow ledger, payee × activity year (the GL journals' own years). */
  readonly taxEscrowRows: readonly OperationsTaxEscrowRow[];
  /** Movement summary per journal kind — all 8 canon kinds always present. */
  readonly journalMovements: readonly OperationsJournalKindRow[];
}

// ── 2. Runs & Pipeline Health ──────────────────────────────────────────────

/** One split run — the journal fold's row of record. */
export interface OperationsRunRow {
  readonly runId: string;
  readonly source: string;
  readonly period: string | null;
  readonly currency: string;
  readonly grossCents: bigint;
  readonly lineItemCount: number;
  readonly varianceAccountCents: bigint;
  readonly status: SplitRunRecord['status'];
  readonly createdAt: string;
  /** The run's reversal of record — null when the run has none. */
  readonly reversal: OperationsRunReversal | null;
}

export interface OperationsRunReversal {
  readonly reversalId: string;
  readonly journalId: string;
  readonly createdAt: string;
}

/** One quarantined event — the raw record's provenance, money in text-micros → bigint. */
export interface OperationsMatchQueueEntry {
  readonly id: string;
  readonly eventId: string;
  readonly status: MatchQueueRecord['status'];
  readonly reason: string;
  readonly source: MatchQueueRecord['source'];
  readonly platform: string | null;
  readonly territory: string | null;
  readonly currency: string | null;
  /** The event's fixed-point gross — text micros verbatim as bigint; null when the event carried none. */
  readonly grossMicros: bigint | null;
  readonly createdAt: string;
}

/** The match queue's counts plus its open quarantine — one read, two projections. */
export interface OperationsMatchQueue {
  readonly openCount: number;
  readonly matchedCount: number;
  readonly discardedCount: number;
  /** The open quarantine, newest first (the store's own order). */
  readonly openEntries: readonly OperationsMatchQueueEntry[];
}

/** One ingested statement file's provenance row — the file body is deliberately not carried. */
export interface OperationsStatementIngestRow {
  readonly ingestId: string;
  readonly format: StatementIngestRecord['format'];
  readonly source: StatementIngestRecord['source'];
  readonly fileName: string;
  readonly status: StatementIngestRecord['status'];
  readonly eventCount: number | null;
  readonly error: string | null;
  readonly createdAt: string;
}

export interface OperationsRunsPipeline {
  /**
   * The split runs the royalty-ingest journals name, one row per unique run
   * ref, in the journals' own order (newest first per the Store's
   * contract). A run whose record is gone contributes no row.
   */
  readonly runs: readonly OperationsRunRow[];
  /** Statement-ingest provenance, newest first (the seam read's own order). */
  readonly ingests: readonly OperationsStatementIngestRow[];
  readonly matchQueue: OperationsMatchQueue;
}

// ── 3. Verification-exception queue ────────────────────────────────────────

/** One DRIFT row — the reconciliation engine's own findings, verbatim. */
export interface OperationsDriftRow {
  readonly transactionId: string;
  readonly currency: string;
  readonly expectedMinor: bigint;
  readonly distributedMinor: bigint;
  readonly driftMinor: bigint;
  readonly netDriftCount: number;
  readonly currencyMismatchCount: number;
  /** The engine's findings of record — rendered verbatim, never paraphrased. */
  readonly findings: readonly string[];
}

/** Group 1 — the reconciliation engine's counts of record plus its DRIFT rows. */
export interface OperationsReconciliationGroup {
  readonly totalRows: number;
  readonly passCount: number;
  readonly driftCount: number;
  /** The reconciliation engine's own status of record. */
  readonly status: 'RECONCILED' | 'ATTENTION';
  /**
   * The engine's DRIFT rows only — the queue's actionable set. Empty when
   * every row passes (under the demo seed: designed-empty).
   */
  readonly driftRows: readonly OperationsDriftRow[];
}

/**
 * Group 2 — one payee's locked payouts, the tax engine's own totals (USD
 * cents, bigint). Grouped at the WITHHOLDING REGISTER's own payee grain —
 * `identityKeyFromPayeeId` — so the queue and the Tax tab always agree on
 * who is locked.
 */
export interface OperationsTaxLockRow {
  readonly identityKey: string;
  readonly payeeName: string;
  /** The engine's lock reason of record — null when the engine names none. */
  readonly lockReason: string | null;
  readonly payoutCount: number;
  readonly grossCents: bigint;
  readonly withheldCents: bigint;
  readonly stateTaxCents: bigint;
  readonly netCents: bigint;
}

export interface OperationsExceptionQueue {
  readonly reconciliation: OperationsReconciliationGroup;
  /** Group 2 — payees with a locked payout, identity-key order. */
  readonly taxLocks: readonly OperationsTaxLockRow[];
  /** Settled rows in other currencies — outside the USD tax engine, counted, never silently dropped. */
  readonly excludedNonUsdSettlements: number;
  /** Group 3 — the match queue's open quarantine (the `no_identifier_match`-shaped reasons of record). */
  readonly quarantinedEvents: readonly OperationsMatchQueueEntry[];
}

// ── 4. Payee/creator registry ──────────────────────────────────────────────

/** The master store's UCT identity behind a payee's identity key. */
export interface OperationsUctIdentity {
  readonly uctId: string;
  readonly name: string;
  readonly isni: string;
  readonly ipi: string | null;
}

/**
 * One registry row — one payee, the joins it actually resolved. Every
 * join field is nullable BY DESIGN: null means the join found nothing,
 * which is the honest resolution state (no invented taxonomy).
 */
export interface OperationsRegistryRow {
  readonly payeeId: string;
  /** The stable identity key the crosswalk joins on (`identityKeyFromPayeeId`). */
  readonly identityKey: string;
  /** The master store's UCT identity behind the key — null when it names none. */
  readonly uctIdentity: OperationsUctIdentity | null;
  /** The tax branch of record behind the key — null when it names none. */
  readonly taxBranch: PayeeTaxBranch | null;
  /** The Don store's own UCT projection (`getCreatorUct`) — null when the store carries none. */
  readonly storeUct: { readonly uctNumber: string; readonly isni: string | null } | null;
  /** The creator-profile row linked by id — null when the profile store is absent or names no row. */
  readonly creatorProfileId: string | null;
  // Money context — the universal ledger's disbursements fold (micro units, 1e-8).
  readonly creditedGrossUnits: bigint;
  readonly creditedWithheldUnits: bigint;
  readonly creditedNetUnits: bigint;
  readonly settlementCurrencies: readonly string[];
  /** The Don vault of record — null when the payee carries none. */
  readonly vault: {
    readonly availableCents: bigint;
    readonly pendingCents: bigint;
    readonly reserveCents: bigint;
  } | null;
  /** Distinct royalty runs whose vault-credit legs name this payee (the GL fold). */
  readonly runCount: number;
}

// ── 5. Operator audit log ──────────────────────────────────────────────────

/** One append-only audit row — who, what, when, and the field-level before/after of record. */
export interface OperationsAuditRow {
  readonly id: string;
  readonly actor: string;
  readonly action: string;
  readonly targetTable: string;
  readonly targetRowId: string | null;
  /** The row's changes of record — `{ field: { from, to } }`, verbatim. */
  readonly changes: AdminActionChanges;
  readonly createdAt: string;
}

export interface OperationsAuditLog {
  /**
   * Whether this store backend persists admin_action_log rows at all (the
   * Supabase production store does; the local mirrors read honestly empty).
   * `rows: []` with `persisted: true` → nothing has been logged yet;
   * `rows: []` with `persisted: false` → this backend keeps no audit
   * table. The capability is read off the store instance, outside the
   * Store interface (see the module header).
   */
  readonly persisted: boolean;
  /** The audit rows, newest first (the store's own order). */
  readonly rows: readonly OperationsAuditRow[];
}

// ── The one safe payload ───────────────────────────────────────────────────

export interface OperationsFlows {
  readonly escrowSettlements: OperationsEscrowSettlements;
  readonly runsPipeline: OperationsRunsPipeline;
  readonly exceptionQueue: OperationsExceptionQueue;
  readonly registry: readonly OperationsRegistryRow[];
  readonly auditLog: OperationsAuditLog;
}

/** The derivation's inputs — what the /admin page already has in hand. */
export interface OperationsFlowsInputs {
  /** The Don settlement store (the demo door's seeded store in demo mode). */
  readonly store: Store;
  /** The Universal Royalty Ledger rows (`listLedger`) — the reconciliation and escrow-state input. */
  readonly ledgerRows: readonly LedgerRow[];
  /** The registered assets — the tax-profile-of-record source for the escrow holders. */
  readonly assets: readonly CovenantBlockAsset[];
  /**
   * The Tax tab's own join context (`buildAdminTaxJoinContext` at the
   * payload seam) — the payout fold consumes only `eventStateByCbt`.
   */
  readonly taxJoinContext: TaxJoinContext;
  /** The creator profiles of record — null when the profile store is absent (no Supabase credentials). */
  readonly creatorProfiles: readonly AdminCreatorProfile[] | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// The conversions — money enters bigint space exactly once per figure.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Don-store cents of record are integers (`BigInt(n)` is exact); a
 * non-integer cent would throw here — the loud failure, never a silent
 * truncation.
 */
function centsOf(n: number): bigint {
  return BigInt(n);
}

/** Text micros of record → bigint verbatim — never through a float. */
function microsOf(text: string): bigint {
  return BigInt(text);
}

/** The audit-log persistence capability, read off the store instance. */
function auditLogPersisted(store: Store): boolean {
  return store instanceof SupabaseStore;
}

// ─────────────────────────────────────────────────────────────────────────────
// The derivation.
// ─────────────────────────────────────────────────────────────────────────────

/** The holder's tax profile of record from the registered assets — null when the holder is on no asset. */
function taxProfileOfRecord(
  assets: readonly CovenantBlockAsset[],
  rightsHolderId: string,
): TaxProfile | null {
  for (const asset of assets) {
    for (const holder of asset.rightsHolders) {
      if (holder.id === rightsHolderId) return holder.taxProfile;
    }
  }
  return null;
}

/** Vault/dispute projections. */
function disputeRowOf(record: VaultDisputeRecord): OperationsDisputeRow {
  return {
    locked: record.locked !== 0,
    lineItemId: record.line_item_id,
    frozenFromAvailableCents: centsOf(record.frozen_from_available),
    frozenFromPendingCents: centsOf(record.frozen_from_pending),
    updatedAt: record.updated_at,
  };
}

function transferRowOf(record: BaasTransferRecord): OperationsTransferRow {
  return {
    transferId: record.id,
    provider: record.provider,
    rail: record.rail,
    payeeId: record.payee_id,
    payeeName: record.payee_name,
    amountCents: centsOf(record.amount_cents),
    currency: record.currency,
    status: record.status,
    estimatedSettlement: record.estimated_settlement,
    ledgerTransactionId: record.ledger_transaction_id,
    createdAt: record.created_at,
  };
}

function matchQueueEntryOf(record: MatchQueueRecord): OperationsMatchQueueEntry {
  return {
    id: record.id,
    eventId: record.event_id,
    status: record.status,
    reason: record.reason,
    source: record.source,
    platform: record.platform,
    territory: record.territory,
    currency: record.currency,
    grossMicros: record.gross_micros === null ? null : microsOf(record.gross_micros),
    createdAt: record.created_at,
  };
}

function ingestRowOf(record: StatementIngestRecord): OperationsStatementIngestRow {
  return {
    ingestId: record.id,
    format: record.format,
    source: record.source,
    fileName: record.file_name,
    status: record.status,
    eventCount: record.event_count,
    error: record.error,
    createdAt: record.created_at,
  };
}

function auditRowOf(record: AdminActionRecord): OperationsAuditRow {
  return {
    id: record.id,
    actor: record.actor,
    action: record.action,
    targetTable: record.target_table,
    targetRowId: record.target_row_id,
    changes: record.changes,
    createdAt: record.created_at,
  };
}

/**
 * Movement summary per journal kind. All eight canon kinds always appear
 * (zero rows honest, JOURNAL_KINDS order); observed non-canon kinds append
 * after them in first-seen order.
 */
function journalMovementsOf(
  journals: readonly GlJournalRecord[],
  entriesByJournal: ReadonlyMap<string, readonly GlEntryRecord[]>,
): OperationsJournalKindRow[] {
  const byKind = new Map<string, { count: number; credit: bigint; debit: bigint; latestDay: string | null }>();
  for (const journal of journals) {
    const group = byKind.get(journal.kind) ?? { count: 0, credit: 0n, debit: 0n, latestDay: null };
    const entries = entriesByJournal.get(journal.id) ?? [];
    group.count += 1;
    for (const entry of entries) {
      group.credit += centsOf(entry.credit_cents);
      group.debit += centsOf(entry.debit_cents);
    }
    const day = journal.created_at.slice(0, 10);
    if (group.latestDay === null || day > group.latestDay) group.latestDay = day;
    byKind.set(journal.kind, group);
  }
  const rows: OperationsJournalKindRow[] = [];
  for (const kind of JOURNAL_KINDS) {
    const group = byKind.get(kind) ?? { count: 0, credit: 0n, debit: 0n, latestDay: null };
    rows.push({ kind, journalCount: group.count, creditCents: group.credit, debitCents: group.debit, latestDay: group.latestDay });
  }
  for (const [kind, group] of byKind) {
    if ((JOURNAL_KINDS as readonly string[]).includes(kind)) continue;
    rows.push({ kind, journalCount: group.count, creditCents: group.credit, debitCents: group.debit, latestDay: group.latestDay });
  }
  return rows;
}

/** The escrow holders — the stored record deepened with the balance engine's computation. */
function escrowHolderRowsOf(
  ledgerRows: readonly LedgerRow[],
  assets: readonly CovenantBlockAsset[],
): OperationsEscrowHolderRow[] {
  const disbursementsByRow = ledgerRows.map((row) => row.disbursements as unknown[]);
  // The engines' signatures take mutable arrays (they never mutate — the
  // copy is the readonly boundary, kept local to this module).
  return escrowStateFromRows([...ledgerRows]).map((state) => {
    const profile = taxProfileOfRecord(assets, state.rightsHolderId);
    const balance = escrowBalanceForHolder({
      disbursementsByRow,
      rightsHolderId: state.rightsHolderId,
      taxProfile: profile ?? UNVERIFIED_FALLBACK_TAX_PROFILE,
    });
    return {
      rightsHolderId: state.rightsHolderId,
      name: state.name,
      currencies: [...state.currencies],
      storedGrossUnits: state.grossUnits,
      storedWithheldUnits: state.withheldUnits,
      storedNetUnits: state.netUnits,
      paidOutUnits: state.paidOutUnits,
      engineGrossUnits: balance.grossUnits,
      engineTaxWithheldUnits: balance.taxWithheldUnits,
      enginePreviousPayoutUnits: balance.previousPayoutUnits,
      engineAvailableUnits: balance.availableUnits,
      taxProfileSource: profile === null ? 'unverified-fallback' : 'registry',
    };
  });
}

/** The split runs — the platformRevenueStreams fold widened to run rows. */
async function runRowsOf(store: Store, journals: readonly GlJournalRecord[]): Promise<OperationsRunRow[]> {
  const rows: OperationsRunRow[] = [];
  const seen = new Set<string>();
  for (const journal of journals) {
    if (journal.kind !== 'royalty_ingest' || journal.ref_type !== 'split_run') continue;
    if (seen.has(journal.ref_id)) continue;
    seen.add(journal.ref_id);
    const run = await store.getSplitRun(journal.ref_id);
    if (!run) continue;
    const reversal: SplitReversalRecord | undefined = await store.getSplitReversalByRun(run.id);
    rows.push({
      runId: run.id,
      source: run.source,
      period: run.period,
      currency: run.currency,
      grossCents: centsOf(run.gross_cents),
      lineItemCount: run.line_item_count,
      varianceAccountCents: centsOf(run.variance_account_cents),
      status: run.status,
      createdAt: run.created_at,
      reversal:
        reversal === undefined
          ? null
          : { reversalId: reversal.id, journalId: reversal.journal_id, createdAt: reversal.created_at },
    });
  }
  return rows;
}

/** The registry — one row per payee the money records name, joins shown from the join results. */
async function registryRowsOf(inputs: {
  store: Store;
  ledgerRows: readonly LedgerRow[];
  vaults: readonly SovereignVaultRecord[];
  runJournals: readonly GlJournalRecord[];
  glEntries: readonly GlEntryRecord[];
  creatorProfiles: readonly AdminCreatorProfile[] | null;
}): Promise<OperationsRegistryRow[]> {
  const { store, ledgerRows, vaults, runJournals, glEntries, creatorProfiles } = inputs;

  // Money context: the universal ledger's disbursements fold — the SAME
  // first-appearance rows the escrow-state table renders.
  const escrowStates = escrowStateFromRows([...ledgerRows]);
  const holderByPayeeId = new Map(escrowStates.map((state) => [state.rightsHolderId, state]));

  // The vaults of record, by payee.
  const vaultByPayeeId = new Map(vaults.map((vault) => [vault.payee_id, vault]));

  // Run counts: distinct royalty-ingest run refs whose holder-credit legs
  // name the payee (the vault account's own segment).
  const runJournalById = new Map(runJournals.map((journal) => [journal.id, journal]));
  const runRefsByPayee = new Map<string, Set<string>>();
  for (const entry of glEntries) {
    if (!entry.account.startsWith('vault:') || entry.account.startsWith('vault:platform:')) continue;
    if (entry.credit_cents <= 0) continue;
    const payeeId = entry.account.split(':')[1];
    if (payeeId === undefined || payeeId === '') continue;
    const journal = runJournalById.get(entry.journal_id);
    if (journal === undefined || journal.kind !== 'royalty_ingest' || journal.ref_type !== 'split_run') continue;
    const refs = runRefsByPayee.get(payeeId) ?? new Set<string>();
    refs.add(journal.ref_id);
    runRefsByPayee.set(payeeId, refs);
  }

  // The payee universe: every payee the money records name — the ledger's
  // disbursement holders first (newest-first), then the vault payees, then
  // the GL credit payees. Deduped, deterministic.
  const payeeIds: string[] = [];
  const seen = new Set<string>();
  const addPayee = (payeeId: string): void => {
    if (seen.has(payeeId)) return;
    seen.add(payeeId);
    payeeIds.push(payeeId);
  };
  for (const state of escrowStates) addPayee(state.rightsHolderId);
  for (const vault of vaults) addPayee(vault.payee_id);
  for (const [payeeId] of runRefsByPayee) addPayee(payeeId);

  const rows: OperationsRegistryRow[] = [];
  for (const payeeId of payeeIds) {
    const identityKey = identityKeyFromPayeeId(payeeId);
    const uctIdentity: UctDemoIdentity | undefined = UCT_DEMO_IDENTITIES[identityKey];
    const taxBranch: PayeeTaxBranch | undefined = DEMO_PAYEE_TAX_BRANCHES[identityKey];
    const storeUct = await store.getCreatorUct(payeeId);
    const holder = holderByPayeeId.get(payeeId);
    const vault = vaultByPayeeId.get(payeeId);
    const profileId =
      creatorProfiles === null
        ? null
        : (creatorProfiles.find((profile) => profile.id === payeeId)?.id ?? null);
    rows.push({
      payeeId,
      identityKey,
      uctIdentity:
        uctIdentity === undefined
          ? null
          : {
              uctId: uctIdentity.uctId,
              name: uctIdentity.name,
              isni: uctIdentity.isni,
              ipi: uctIdentity.ipi,
            },
      taxBranch: taxBranch ?? null,
      storeUct: storeUct === undefined ? null : { uctNumber: storeUct.uctNumber, isni: storeUct.isni },
      creatorProfileId: profileId,
      creditedGrossUnits: holder?.grossUnits ?? 0n,
      creditedWithheldUnits: holder?.withheldUnits ?? 0n,
      creditedNetUnits: holder?.netUnits ?? 0n,
      settlementCurrencies: holder ? [...holder.currencies] : [],
      vault:
        vault === undefined
          ? null
          : {
              availableCents: centsOf(vault.available_balance),
              pendingCents: centsOf(vault.pending_balance),
              reserveCents: centsOf(vault.reserve_balance),
            },
      runCount: runRefsByPayee.get(payeeId)?.size ?? 0,
    });
  }

  // Deterministic order across backends: identity key, then payee id (code-unit).
  rows.sort((a, b) => (a.identityKey < b.identityKey ? -1 : a.identityKey > b.identityKey ? 1 : a.payeeId < b.payeeId ? -1 : a.payeeId > b.payeeId ? 1 : 0));
  return rows;
}

/** The exception queue — three honestly separate groups. */
function exceptionQueueOf(
  ledgerRows: readonly LedgerRow[],
  matchQueue: OperationsMatchQueue,
  taxJoinContext: TaxJoinContext,
): OperationsExceptionQueue {
  // Group 1 — the reconciliation engine's own pass.
  const reconciliation = reconcileLedger([...ledgerRows]);
  const reconciliationGroup: OperationsReconciliationGroup = {
    totalRows: reconciliation.totalRows,
    passCount: reconciliation.passCount,
    driftCount: reconciliation.driftCount,
    status: reconciliation.status,
    driftRows: reconciliation.rows
      .filter((row) => row.status === 'DRIFT')
      .map((row) => ({
        transactionId: row.transactionId,
        currency: row.currency,
        expectedMinor: row.expectedMinor,
        distributedMinor: row.distributedMinor,
        driftMinor: row.driftMinor,
        netDriftCount: row.netDriftCount,
        currencyMismatchCount: row.currencyMismatchCount,
        findings: [...row.findings],
      })),
  };

  // Group 2 — the tax engine's locks, through the Tax tab's own selectors,
  // grouped at the register's own payee grain (the identity key).
  const fold = resolvePayeePayouts(ledgerRows, taxJoinContext);
  const heldPayouts = fold.payouts.filter((payout) => payout.resolution.lockState === 'HELD_IN_TAX_ESCROW');
  const heldByIdentity = new Map<string, typeof heldPayouts>();
  for (const payout of heldPayouts) {
    const identityKey = identityKeyFromPayeeId(payout.disbursement.rightsHolderId);
    const group = heldByIdentity.get(identityKey);
    if (group) group.push(payout);
    else heldByIdentity.set(identityKey, [payout]);
  }
  const taxLocks: OperationsTaxLockRow[] = [...heldByIdentity.entries()]
    .map(([identityKey, payouts]) => {
      const engine = foldResolutions(payouts);
      return {
        identityKey,
        payeeName: payouts[0]?.disbursement.rightsHolderName ?? identityKey,
        lockReason: payouts[0]?.resolution.lockReason ?? null,
        payoutCount: payouts.length,
        grossCents: engine.grossCents,
        withheldCents: engine.withheldCents,
        stateTaxCents: engine.stateTaxCents,
        netCents: engine.netCents,
      };
    })
    .sort((a, b) => (a.identityKey < b.identityKey ? -1 : a.identityKey > b.identityKey ? 1 : 0));

  return {
    reconciliation: reconciliationGroup,
    taxLocks,
    excludedNonUsdSettlements: fold.excludedNonUsdSettlements,
    quarantinedEvents: matchQueue.openEntries,
  };
}

/**
 * The Operations payload — all five views over the store of record. Never
 * throws on a store failure: it degrades to the honest `null` (the tab's
 * unavailable state, the siblings' treatment).
 */
export async function operationsFlows(inputs: OperationsFlowsInputs): Promise<OperationsFlows | null> {
  const { store, ledgerRows, assets, taxJoinContext, creatorProfiles } = inputs;
  try {
    const [journals, glEntries, vaults, transfers, matchQueueRecords, ingestRecords] = await Promise.all([
      store.listGlJournals(),
      store.listGlEntries(),
      store.listVaults(),
      store.listBaasTransfers(),
      store.listMatchQueueEntries(),
      store.listStatementIngests(),
    ]);

    // Escrow & Settlements.
    const entriesByJournal = new Map<string, GlEntryRecord[]>();
    for (const entry of glEntries) {
      const group = entriesByJournal.get(entry.journal_id);
      if (group) group.push(entry);
      else entriesByJournal.set(entry.journal_id, [entry]);
    }
    const vaultRows: OperationsVaultRow[] = [];
    for (const vault of vaults) {
      const inFlight = await store.sumInFlightPayoutHolds(vault.payee_id);
      const dispute: VaultDisputeRecord | undefined = await store.getVaultDispute(vault.payee_id);
      vaultRows.push({
        payeeId: vault.payee_id,
        payeeName: vault.payee_name,
        availableCents: centsOf(vault.available_balance),
        pendingCents: centsOf(vault.pending_balance),
        reserveCents: centsOf(vault.reserve_balance),
        inFlightHoldCents: centsOf(inFlight),
        dispute: dispute === undefined ? null : disputeRowOf(dispute),
        updatedAt: vault.updated_at,
      });
    }
    // The tax-escrow ledger: the GL's own activity years, per vault payee.
    const activityYears = [...new Set(journals.map((journal) => Number(journal.created_at.slice(0, 4))))].sort(
      (a, b) => a - b,
    );
    const vaultNameByPayee = new Map(vaults.map((vault) => [vault.payee_id, vault.payee_name]));
    const taxEscrowRows: OperationsTaxEscrowRow[] = [];
    for (const vault of vaults) {
      for (const year of activityYears) {
        for (const record of await store.listTaxEscrowByCreator(vault.payee_id, year)) {
          taxEscrowRows.push({
            payeeId: record.creator_id,
            payeeName: vaultNameByPayee.get(record.creator_id) ?? null,
            taxYear: record.tax_year,
            grossCents: centsOf(record.gross_cents),
            withheldCents: centsOf(record.withheld_cents),
            netCents: centsOf(record.net_cents),
            tinVerified: record.tin_verified !== 0,
            w9OnFile: record.w9_on_file !== 0,
            requires1099: record.requires_1099 !== 0,
            crossed1099Threshold: record.crossed_1099_threshold !== 0,
            createdAt: record.created_at,
          });
        }
      }
    }
    const escrowSettlements: OperationsEscrowSettlements = {
      vaults: vaultRows,
      transfers: transfers.map(transferRowOf),
      escrowHolders: escrowHolderRowsOf(ledgerRows, assets),
      taxEscrowRows,
      journalMovements: journalMovementsOf(journals, entriesByJournal),
    };

    // Runs & Pipeline Health.
    const matchQueue: OperationsMatchQueue = {
      openCount: matchQueueRecords.filter((record) => record.status === 'open').length,
      matchedCount: matchQueueRecords.filter((record) => record.status === 'matched').length,
      discardedCount: matchQueueRecords.filter((record) => record.status === 'discarded').length,
      openEntries: matchQueueRecords
        .filter((record) => record.status === 'open')
        .map(matchQueueEntryOf),
    };
    const runJournals = journals.filter(
      (journal) => journal.kind === 'royalty_ingest' && journal.ref_type === 'split_run',
    );
    const runsPipeline: OperationsRunsPipeline = {
      runs: await runRowsOf(store, journals),
      ingests: ingestRecords.map(ingestRowOf),
      matchQueue,
    };

    // Exception queue + registry + audit log.
    const exceptionQueue = exceptionQueueOf(ledgerRows, matchQueue, taxJoinContext);
    const registry = await registryRowsOf({
      store,
      ledgerRows,
      vaults,
      runJournals,
      glEntries,
      creatorProfiles,
    });
    const auditLog: OperationsAuditLog = {
      persisted: auditLogPersisted(store),
      rows: (await store.listAdminActions()).map(auditRowOf),
    };

    return { escrowSettlements, runsPipeline, exceptionQueue, registry, auditLog };
  } catch (error) {
    // Fail closed to the tab's unavailable state — but never silently: the
    // stable prefix makes the store failure findable in server logs.
    console.error('[operations] store read failed:', error);
    return null;
  }
}
