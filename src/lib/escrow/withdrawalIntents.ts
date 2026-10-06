/**
 * Intent-first withdrawal holds on the escrow — audit note_c5ksDgVw #4/#5.
 *
 * The withdraw path used to read the balance, call Plaid, then write the
 * DISBURSEMENT row. Two P1s fell out of that order: a concurrent second
 * withdrawal passed the same balance check and both transferred (#4, TOCTOU
 * double-spend), and a failed ledger insert left the balance intact — a
 * repeat-withdrawal window on funds that had already left (#5). The fix
 * mirrors the vault engine's available→pending discipline (migration 0009
 * H1, src/modules/vaults/engine.ts): a conditional pending-debit write
 * GATES the rail call.
 *
 * The hold lives in escrow_withdrawal_intents (migration 0058):
 *
 *   - reserve — one RPC (reserve_escrow_withdrawal) that takes the
 *     holder's advisory lock, re-derives gross/tax/payouts from the ledger
 *     exactly as escrowBalanceForHolder does, sums the holder's pending
 *     intents fresh, and inserts the intent row only when the available
 *     floor holds. Concurrent reserves serialize on the lock; the loser
 *     sees the winner's pending row and refuses.
 *   - release — the compensating write when the rail authoritatively
 *     fails (no transfer exists). Restores the available balance.
 *   - settle — the flip when the DISBURSEMENT ledger row lands. The route
 *     derives the ledger row's transaction_id deterministically as
 *     ESCROW-PAYOUT-<intentId>, so a reconciliation settle of a stuck
 *     pending intent writes the same transaction_id and converges on the
 *     ledger's UNIQUE(transaction_id).
 *
 * Failure posture is fail-closed everywhere: a release or settle that
 * errors leaves the intent PENDING — funds over-held, never over-paid —
 * and the caller logs for reconciliation. An intent whose ledger row
 * failed stays pending and blocks the retry until settled or released,
 * which is exactly the #5 window closing.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { EscrowLedgerReadError } from './balance';

/** The reserve RPC's envelope — money as exact unit strings, never floats. */
interface ReserveEnvelope {
  reserved?: unknown;
  available_units?: unknown;
}

export interface EscrowWithdrawalReservation {
  reserved: boolean;
  /**
   * The RPC's freshly recomputed available balance (1e-8 units), for logs —
   * the server-side number the floor decision was made against. null when
   * the envelope is missing it.
   */
  availableUnits: bigint | null;
}

/**
 * The conditional pending-debit write that gates the Plaid call. Throws
 * EscrowLedgerReadError on transport/envelope failure — the route turns
 * that into a sanitized 502, never a dispatch without a hold on record.
 */
export async function reserveEscrowWithdrawal(
  db: SupabaseClient,
  params: {
    intentId: string;
    rightsHolderId: string;
    /** The full gross debit in 1e-8 ledger units (integer BigInt). */
    amountUnits: bigint;
    /** The engine effective rate for the holder's profile (same value the shared balance math used). */
    taxRate: number;
  },
): Promise<EscrowWithdrawalReservation> {
  const { data, error } = await db.rpc('reserve_escrow_withdrawal', {
    p_intent_id: params.intentId,
    p_rights_holder_id: params.rightsHolderId,
    // Exact unit strings across the PostgREST boundary — BigInt ints would
    // not survive JSON numbers past 2^53.
    p_amount_units: params.amountUnits.toString(),
    p_tax_rate: params.taxRate,
  });
  if (error) {
    throw new EscrowLedgerReadError(`Withdrawal reserve failed: ${error.message}`);
  }
  const envelope = (data ?? null) as ReserveEnvelope | null;
  if (typeof envelope !== 'object' || envelope === null || typeof envelope.reserved !== 'boolean') {
    // Malformed envelope: refuse the dispatch — fail closed.
    throw new EscrowLedgerReadError('Withdrawal reserve returned an unreadable envelope.');
  }
  const availableRaw = envelope.available_units;
  const availableUnits =
    typeof availableRaw === 'string' && /^-?\d+$/.test(availableRaw) ? BigInt(availableRaw) : null;
  return { reserved: envelope.reserved, availableUnits };
}

/**
 * The compensating release after an authoritative rail failure: the
 * transfer was refused, so no transfer exists and the hold unblocks the
 * funds. Flips pending→released only; a row already settled or released
 * reports false. Throws on transport failure — the route's release is
 * best-effort and logs instead of propagating.
 */
export async function releaseEscrowWithdrawal(
  db: SupabaseClient,
  intentId: string,
): Promise<boolean> {
  const { data, error } = await db
    .from('escrow_withdrawal_intents')
    .update({ status: 'released', released_at: new Date().toISOString() })
    .eq('id', intentId)
    .eq('status', 'pending')
    .select('id');
  if (error) {
    throw new EscrowLedgerReadError(`Withdrawal release failed: ${error.message}`);
  }
  return (data ?? []).length === 1;
}

/**
 * The settle flip when the DISBURSEMENT ledger row has landed. Flips
 * pending→settled only; false means the row was already settled or
 * released (reconciliation territory). Throws on transport failure — the
 * route logs; the hold persists (over-held, never over-paid).
 */
export async function settleEscrowWithdrawal(
  db: SupabaseClient,
  params: { intentId: string; plaidTransferId: string },
): Promise<boolean> {
  const { data, error } = await db
    .from('escrow_withdrawal_intents')
    .update({
      status: 'settled',
      plaid_transfer_id: params.plaidTransferId,
      settled_at: new Date().toISOString(),
    })
    .eq('id', params.intentId)
    .eq('status', 'pending')
    .select('id');
  if (error) {
    throw new EscrowLedgerReadError(`Withdrawal settle failed: ${error.message}`);
  }
  return (data ?? []).length === 1;
}
