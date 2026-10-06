/**
 * Withdrawal-intent reconciliation — the fail-closed resolver PR #156's
 * withdraw route deliberately left to this module (migration 0058's
 * "deliberately NOT touched" note): pending escrow_withdrawal_intents whose
 * Plaid outcome was unknown at dispatch (network drop mid-call, unparseable
 * 2xx) or whose ledger debit insert failed stay pending by design — funds
 * over-held, never over-paid — until a rail-verified outcome resolves them.
 *
 * Two surfaces share this core, and both resolve through the SAME atomic
 * status guard (settleEscrowWithdrawal / releaseEscrowWithdrawal — the
 * guard-first UPDATE … WHERE status='pending' with a rowcount gate), so a
 * live webhook and the stale-hold sweep racing on one intent admit exactly
 * one resolution: the flip's rowcount decides the winner, the loser no-ops.
 *
 *   - the Plaid transfer webhook (src/app/api/payouts/webhooks/plaid) — a
 *     signed notification is a BELL; the verdict comes from /transfer/get.
 *   - the stale-hold sweep (src/app/api/payouts/withdraw/reconcile) —
 *     re-queries /transfer/get for stale pending intents whose webhook never
 *     arrived (provider outage).
 *
 * Ledger discipline (audit note_c5ksDgVw #5, unchanged): the DISBURSEMENT
 * debit's transaction_id is deterministic — ESCROW-PAYOUT-<intent_id> — so
 * "complete the debit" converges on the ledger's UNIQUE(transaction_id)
 * instead of double-recording, and every compensating entry is an appended
 * row with its own deterministic id (…-REVERSAL), never an absolute-total
 * write. Fail-closed ordering:
 *
 *   settle:  ensure the debit row exists FIRST, flip SECOND — a failure
 *            leaves the hold pending and the next webhook/sweep retry
 *            converges (insert → UNIQUE no-op, flip → guard).
 *   release: compensating reversal FIRST (when a debit exists), flip SECOND
 *            — a failure never un-blocks funds whose debit still stands.
 *
 * Reversal math: the escrow balance is Σgross − tax − Σ(type-DISBURSEMENT
 * payoutAmount) − Σpending intents (src/lib/escrow/balance.ts, migration
 * 0058's reserve RPC — the same sum in two places). A reversal entry
 * carries a NEGATIVE payoutAmount through the same entry shape, so both
 * computations unwind the erroneous debit exactly; the intent flip then
 * drops the hold. Released funds therefore restore available EXACTLY —
 * subtract pending, restore available.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { TaxProfile } from '@/engine/covenant-master-sdk';
import {
  EscrowLedgerReadError,
  fetchEscrowBalance,
  findRightsHolder,
  UNVERIFIED_FALLBACK_TAX_PROFILE,
  taxRateForProfile,
  withholdingUnitsOn,
} from './balance';
import { formatMicro } from '@/lib/fixed-point';
import { isMissingMetadataColumnError, stampSupabaseLedgerRow } from '@/lib/ledger/cbt-settlement';
import { releaseEscrowWithdrawal, settleEscrowWithdrawal } from './withdrawalIntents';

/** The deterministic ledger id of a payout's DISBURSEMENT debit (the withdraw route's derivation — shared, never re-invented). */
export function escrowPayoutTransactionId(intentId: string): string {
  return `ESCROW-PAYOUT-${intentId}`;
}

/** The deterministic ledger id of a payout's compensating reversal entry. */
export function escrowPayoutReversalTransactionId(intentId: string): string {
  return `ESCROW-PAYOUT-${intentId}-REVERSAL`;
}

/** A withdrawal intent as the reconciler reads it. */
export interface WithdrawalIntentRow {
  id: string;
  rights_holder_id: string;
  amount_units: string;
  status: 'pending' | 'settled' | 'released';
}

/** The unique violation Postgres raises on a duplicate deterministic ledger id — convergence, not failure. */
const UNIQUE_VIOLATION = '23505';

/**
 * One stamped supabase-js ledger insert site — the withdraw route's exact
 * discipline (stamped primary, bare 42703-fallback retry): a live table
 * without the additive metadata column retries the row WITHOUT the CBT
 * stamp so the reconciliation — the money state — still records. A 23505
 * means a concurrent resolver already wrote this deterministic row:
 * converged, not failed.
 */
async function insertLedgerRow(
  db: SupabaseClient,
  row: Record<string, unknown>,
  referenceId: string,
): Promise<{ written: boolean; duplicated: boolean }> {
  const { error } = await db.from('universal_royalty_ledger').insert(stampSupabaseLedgerRow(row, referenceId));
  if (error && isMissingMetadataColumnError(error)) {
    const { error: fallbackError } = await db.from('universal_royalty_ledger').insert(row);
    if (fallbackError) {
      if ((fallbackError as { code?: string }).code === UNIQUE_VIOLATION) {
        return { written: false, duplicated: true };
      }
      throw new EscrowLedgerReadError(`Reconciliation ledger insert failed: ${fallbackError.message}`);
    }
    return { written: true, duplicated: false };
  }
  if (error) {
    if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
      return { written: false, duplicated: true };
    }
    throw new EscrowLedgerReadError(`Reconciliation ledger insert failed: ${error.message}`);
  }
  return { written: true, duplicated: false };
}

/**
 * The webhook's transfer-id → intent mapping: the withdraw route stamps the
 * rail id onto the pending intent at create time (recordWithdrawalTransferId),
 * so a signed notification resolves by table lookup. Prefers the pending row
 * (the reconciliation target); a terminal row still resolves — a reversal of
 * an already-settled payout needs the compensating path.
 */
export async function findIntentByTransferId(
  db: SupabaseClient,
  plaidTransferId: string,
): Promise<WithdrawalIntentRow | null> {
  const { data, error } = await db
    .from('escrow_withdrawal_intents')
    .select('id, rights_holder_id, amount_units, status')
    .eq('plaid_transfer_id', plaidTransferId);
  if (error) {
    throw new EscrowLedgerReadError(`Withdrawal intent lookup failed: ${error.message}`);
  }
  const rows = (data ?? []) as WithdrawalIntentRow[];
  return rows.find((row) => row.status === 'pending') ?? rows[0] ?? null;
}

/**
 * The sweep's fallback for intents that predate the transfer-id stamp: the
 * withdraw route's DISBURSEMENT row (deterministic transaction_id) carries
 * the entry-level plaidTransferId. A primary-key read on the ledger —
 * bounded by construction. Returns null when no row exists (the pre-reconciler
 * failed-insert case: the transfer id exists nowhere machine-readable; the
 * sweep logs those for operator review).
 */
export async function findTransferIdForIntent(
  db: SupabaseClient,
  intentId: string,
): Promise<string | null> {
  const { data, error } = await db
    .from('universal_royalty_ledger')
    .select('transaction_id, disbursements')
    .eq('transaction_id', escrowPayoutTransactionId(intentId));
  if (error) {
    throw new EscrowLedgerReadError(`Reconciliation ledger read failed: ${error.message}`);
  }
  const row = (data ?? [])[0] as { disbursements?: unknown } | undefined;
  const entry = Array.isArray(row?.disbursements) ? (row.disbursements as unknown[])[0] : null;
  const transferId =
    typeof entry === 'object' && entry !== null && 'plaidTransferId' in entry
      ? (entry as { plaidTransferId?: unknown }).plaidTransferId
      : null;
  return typeof transferId === 'string' && transferId !== '' ? transferId : null;
}

/** The holder's payout-entry tax split, re-derived at completion time from the same engine helpers the withdraw route used. The GROSS debit is intent-sourced and exact; the withheld/net split is display-grade — the balance math sums payoutAmount only — so completion-time re-derivation cannot move a balance. */
async function deriveTaxSplit(
  db: SupabaseClient,
  rightsHolderId: string,
  amountUnits: bigint,
): Promise<{ taxProfile: TaxProfile; withheldUnits: bigint; netUnits: bigint }> {
  const { data: assetRows, error: assetsError } = await db.from('cbt_assets').select('rights_holders');
  if (assetsError) {
    throw new EscrowLedgerReadError(`Reconciliation tax-profile read failed: ${assetsError.message}`);
  }
  const holder = findRightsHolder(assetRows ?? [], rightsHolderId);
  const taxProfile = holder?.taxProfile ?? UNVERIFIED_FALLBACK_TAX_PROFILE;
  const withheldUnits = taxProfile.isVerified ? 0n : withholdingUnitsOn(amountUnits, taxRateForProfile(taxProfile));
  return { taxProfile, withheldUnits, netUnits: amountUnits - withheldUnits };
}

/** The debit row's disbursements entry (null when the debit never landed). */
async function findDebitEntry(
  db: SupabaseClient,
  intentId: string,
): Promise<{ entry: Record<string, unknown> | null; currency: string | null }> {
  const { data, error } = await db
    .from('universal_royalty_ledger')
    .select('transaction_id, disbursements, currency')
    .eq('transaction_id', escrowPayoutTransactionId(intentId));
  if (error) {
    throw new EscrowLedgerReadError(`Reconciliation debit read failed: ${error.message}`);
  }
  const row = (data ?? [])[0] as { disbursements?: unknown; currency?: unknown } | undefined;
  const entry = Array.isArray(row?.disbursements) ? (row.disbursements as unknown[])[0] : null;
  return {
    entry: typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>) : null,
    currency: typeof row?.currency === 'string' ? row.currency : null,
  };
}

/** What the reconciliation did to the ledger row for this intent. */
export type ReconcileLedgerAction =
  | 'debit_completed'
  | 'debit_already_present'
  | 'reversal_written'
  | 'reversal_already_present'
  | 'none';

export interface ReconcileResolution {
  intentId: string;
  outcome: 'settle' | 'release';
  /**
   * True when THIS call won the guard race and flipped the hold — exactly
   * one resolver (webhook or sweep) sees this per intent.
   */
  resolved: boolean;
  /** True when the intent was already terminal (a replay — acknowledged, nothing done). */
  alreadyResolved: boolean;
  ledger: ReconcileLedgerAction;
}

/**
 * Resolve a withdrawal intent from a rail-verified outcome.
 *
 * settle — TRANSFER posted/settled: the money left escrow. Completes the
 * ledger debit for the deterministic ESCROW-PAYOUT-<intent_id> id when the
 * route's insert failed (#5), then flips pending→settled. A settled intent
 * replays as a no-op; a released one (posted-after-release pathology)
 * still completes the debit — the ledger must reflect money that moved —
 * and is logged for operator review, since the released funds may already
 * have been re-withdrawn.
 *
 * release — TRANSFER failed/reversed/cancelled: the money is not leaving
 * (or came back). When the route's debit row landed (settle-flip-failed
 * case), a compensating reversal entry — deterministic
 * ESCROW-PAYOUT-<intent_id>-REVERSAL id, negative payoutAmount through the
 * same DISBURSEMENT entry shape — unwinds the erroneous debit FIRST; the
 * guard-first flip then restores the hold. A settled intent stays settled
 * (its hold converted long ago); the reversal entry alone restores the
 * balance exactly. A replayed release is a no-op.
 *
 * Every transport failure throws AFTER the ledger converged or BEFORE any
 * write — the hold stays pending either way, and the next webhook/sweep
 * converges. Nothing here ever writes an absolute total.
 */
export async function reconcileTransferOutcome(
  db: SupabaseClient,
  params: { intentId: string; plaidTransferId: string; outcome: 'settle' | 'release' },
): Promise<ReconcileResolution> {
  const { intentId, plaidTransferId, outcome } = params;

  const { data, error } = await db
    .from('escrow_withdrawal_intents')
    .select('id, rights_holder_id, amount_units, status')
    .eq('id', intentId);
  if (error) {
    throw new EscrowLedgerReadError(`Withdrawal intent read failed: ${error.message}`);
  }
  const intent = (data ?? [])[0] as WithdrawalIntentRow | undefined;
  if (!intent) {
    // Nothing to reconcile — the caller's mapping is stale. Not an error:
    // acknowledge with nothing done.
    return { intentId, outcome, resolved: false, alreadyResolved: true, ledger: 'none' };
  }

  if (outcome === 'settle') {
    if (intent.status !== 'pending') {
      // Replayed POSTED (already settled), or the posted-after-release
      // pathology: either way the flip must not run again.
      if (intent.status === 'released') {
        console.error(
          `Withdrawal intent ${intentId} was RELEASED but Plaid reports the transfer posted — completing the ledger debit and flagging for operator review.`,
        );
        await completeDebit(db, intent, plaidTransferId);
        return { intentId, outcome, resolved: false, alreadyResolved: true, ledger: 'debit_completed' };
      }
      return { intentId, outcome, resolved: false, alreadyResolved: true, ledger: 'none' };
    }
    const ledger = await completeDebit(db, intent, plaidTransferId);
    // Guard-first flip — the one winner of the webhook/sweep race. A loser
    // (another resolver released first) no-ops here.
    const settled = await settleEscrowWithdrawal(db, { intentId, plaidTransferId });
    return { intentId, outcome, resolved: settled, alreadyResolved: !settled, ledger };
  }

  // release
  if (intent.status === 'released') {
    return { intentId, outcome, resolved: false, alreadyResolved: true, ledger: 'none' };
  }
  if (intent.status === 'settled') {
    // The payout had completed, then the rail returned the money: unwind
    // the debit (deterministic, idempotent) — the intent itself stays
    // settled; there is no hold left to flip.
    const ledger = await writeReversal(db, intent, plaidTransferId);
    return { intentId, outcome, resolved: false, alreadyResolved: false, ledger };
  }
  // pending — the reconciliation target.
  const { entry } = await findDebitEntry(db, intentId);
  let ledger: ReconcileLedgerAction = 'none';
  if (entry !== null) {
    // The route recorded the debit but the flip failed (or never ran) and
    // the rail then failed the transfer: unwind the erroneous debit BEFORE
    // releasing the hold — a failure here leaves the hold standing and the
    // next retry converges (the reversal id is deterministic).
    ledger = await writeReversal(db, intent, plaidTransferId);
  }
  // Guard-first flip — the same atomic guard the webhook path uses; the
  // race loser (a concurrent settle won) no-ops.
  const released = await releaseEscrowWithdrawal(db, intentId);
  return { intentId, outcome, resolved: released, alreadyResolved: !released, ledger };
}

/**
 * Ensure the ESCROW-PAYOUT-<intent_id> DISBURSEMENT debit exists — the
 * settle path's ledger completion. Idempotent by construction: an existing
 * row (the settle-flip-failed case) or a 23505 race converges without a
 * second write. MUST run before the settle flip; a failure throws so the
 * hold stays pending (an unrecorded payout may never un-block itself).
 */
async function completeDebit(
  db: SupabaseClient,
  intent: WithdrawalIntentRow,
  plaidTransferId: string,
): Promise<ReconcileLedgerAction> {
  const existing = await findDebitEntry(db, intent.id);
  if (existing.entry !== null) {
    return 'debit_already_present';
  }

  const amountUnits = BigInt(intent.amount_units);
  const { taxProfile, withheldUnits, netUnits } = await deriveTaxSplit(db, intent.rights_holder_id, amountUnits);
  // The hold→debit conversion is balance-neutral (the pending subtraction
  // becomes the payout subtraction), so the available balance read BEFORE
  // the write IS the post-settlement remaining.
  const remainingNetBalance = (await fetchEscrowBalance(db, intent.rights_holder_id, taxProfile)).availableUnits;

  const transactionId = escrowPayoutTransactionId(intent.id);
  const debitRow = {
    transaction_id: transactionId,
    transaction_type: 'DISBURSEMENT',
    cbt_code: 'ESCROW-PAYOUT',
    platform: 'PLAID',
    gross_settled: formatMicro(amountUnits),
    currency: existing.currency ?? 'USD',
    disbursements: [
      {
        type: 'DISBURSEMENT',
        rightsHolderId: intent.rights_holder_id,
        payoutAmount: amountUnits.toString(),
        amountPaid: netUnits.toString(),
        taxWithheld: withheldUnits.toString(),
        plaidTransferId,
        timestamp: Date.now(),
        remainingNetBalance: remainingNetBalance.toString(),
      },
    ],
  };
  const { written, duplicated } = await insertLedgerRow(db, debitRow, transactionId);
  if (!written && !duplicated) {
    throw new EscrowLedgerReadError(`Reconciliation debit insert for ${intent.id} wrote nothing.`);
  }
  return written ? 'debit_completed' : 'debit_already_present';
}

/**
 * The compensating reversal: an appended DISBURSEMENT_REVERSAL row whose
 * disbursements entry mirrors the debit's split NEGATED (payoutAmount
 * negative — the field both balance computations sum), with a deterministic
 * …-REVERSAL transaction_id so replays converge on UNIQUE. Row-level
 * fields follow the banking route's reversal convention (positive
 * magnitude, REVERSAL type — the sign lives in the entry the math reads).
 */
async function writeReversal(
  db: SupabaseClient,
  intent: WithdrawalIntentRow,
  plaidTransferId: string,
): Promise<ReconcileLedgerAction> {
  const debit = await findDebitEntry(db, intent.id);
  if (debit.entry === null) {
    // No debit to unwind — the caller only invokes this when one exists;
    // a vanished row means a concurrent resolver already handled it.
    return 'reversal_already_present';
  }
  const amountUnits = BigInt(intent.amount_units);
  // The post-unwind available: the current balance (which double-counts the
  // standing debit, and the hold when still pending) plus back whatever the
  // unwind restores.
  const { taxProfile } = await deriveTaxSplit(db, intent.rights_holder_id, amountUnits);
  const availableNow = (await fetchEscrowBalance(db, intent.rights_holder_id, taxProfile)).availableUnits;
  const restored = amountUnits * (intent.status === 'pending' ? 2n : 1n);

  const negate = (raw: unknown): string => {
    // Mirror the debit's split negated; fall back to the intent's gross for
    // an unreadable payoutAmount (the balance math needs exactly that one).
    const value = typeof raw === 'string' && /^-?\d+$/.test(raw) ? BigInt(raw) : amountUnits;
    return (-value).toString();
  };

  const transactionId = escrowPayoutReversalTransactionId(intent.id);
  const reversalRow = {
    transaction_id: transactionId,
    transaction_type: 'DISBURSEMENT_REVERSAL',
    cbt_code: 'ESCROW-PAYOUT-REVERSAL',
    platform: 'PLAID',
    gross_settled: formatMicro(amountUnits),
    currency: debit.currency ?? 'USD',
    disbursements: [
      {
        type: 'DISBURSEMENT',
        rightsHolderId: intent.rights_holder_id,
        payoutAmount: negate(debit.entry.payoutAmount),
        amountPaid: negate(debit.entry.amountPaid),
        taxWithheld: negate(debit.entry.taxWithheld),
        plaidTransferId,
        timestamp: Date.now(),
        remainingNetBalance: (availableNow + restored).toString(),
      },
    ],
  };
  const { written, duplicated } = await insertLedgerRow(db, reversalRow, transactionId);
  if (!written && !duplicated) {
    throw new EscrowLedgerReadError(`Reconciliation reversal insert for ${intent.id} wrote nothing.`);
  }
  return written ? 'reversal_written' : 'reversal_already_present';
}
