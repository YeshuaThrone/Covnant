/**
 * POST /api/payouts/withdraw/reconcile — the bounded stale-hold sweep (the
 * operator-gated sibling of the Plaid transfer webhook for
 * escrow_withdrawal_intents reconciliation).
 *
 * Why: the withdraw route leaves a hold pending when the dispatch outcome
 * is UNKNOWN (network drop mid-call, unparseable 2xx) or the DISBURSEMENT
 * ledger insert failed — funds over-held, never over-paid. The webhook
 * resolves holds when Plaid's notification arrives, but a provider outage
 * means the webhook NEVER arrives. The sweep closes that gap: for every
 * pending intent older than the staleness floor, it re-queries the
 * AUTHORITATIVE transfer status from /transfer/get (the same shared
 * transport the webhook uses) and resolves through the SAME reconciler
 * core — so a sweep racing a live webhook on one intent admits exactly one
 * resolution (the guard-first status UPDATE decides the winner; the loser
 * no-ops).
 *
 * Bounded by construction: at most SWEEP_BATCH pending intents per run
 * (the oldest window the table's default order yields), filtered to the
 * staleness floor in the handler. An operator (or a cron worker holding
 * the admin session) invokes it on a schedule; every invocation is one
 * bounded pass, never an unbounded job. Intent-by-intent isolation: one
 * transfer whose status query fails (rail outage on a single id) is
 * reported as unresolved and the sweep continues — a stale hold must not
 * be able to wedge the whole reconciliation surface.
 *
 * Transfer-id resolution, in order: the intent's stamped plaid_transfer_id
 * (the withdraw route stamps it at create time), else the deterministic
 * DISBURSEMENT row's entry-level id (legacy Case B recovery), else the
 * intent is UNRESOLVABLE BY RAIL — reported with reason 'no_transfer_id'
 * and left pending for operator review (it can also still be settled by a
 * webhook if Plaid notifies anyway).
 *
 * Fail-closed posture mirrors the webhook: credentials absent → 503
 * explicit not-configured (the locked-rails policy — no fake-enabling the
 * live rail); database unconfigured → 503; status queries that cannot
 * complete leave the hold pending. Release math and compensating entries
 * ride the shared reconciler — the same ledger code path, never
 * absolute-total writes.
 */

import { supabaseFromEnv } from '@/lib/supabase';
import { requireOperator } from '@/lib/server/apiAccess';
import { clientAddress } from '@/lib/server/clientAddress';
import { ADMIN_API_RATE_LIMIT, checkSharedRateLimit } from '@/lib/server/rateLimit';
import {
  fetchTransferStatus,
  outcomeForTransferStatus,
  plaidCredentialsFromEnv,
} from '@/lib/escrow/plaidApi';
import { findTransferIdForIntent, reconcileTransferOutcome } from '@/lib/escrow/intentReconciler';
import { EscrowLedgerReadError } from '@/lib/escrow/balance';

export const dynamic = 'force-dynamic';

/** A pending intent older than this is stale (the webhook had its window). */
const STALE_AFTER_MS = 30 * 60 * 1000;

/** The bound: at most this many stale intents per invocation. */
const SWEEP_BATCH = 25;

interface SweepEntry {
  intentId: string;
  outcome?: 'settle' | 'release';
  status?: string;
  reason?: string;
  resolved?: boolean;
  alreadyResolved?: boolean;
  ledger?: string;
}

export async function POST(request: Request): Promise<Response> {
  const gate = requireOperator(request);
  if (!gate.ok) {
    return Response.json(
      { ok: false, error: gate.message, code: gate.code },
      { status: gate.status, headers: { 'cache-control': 'no-store' } },
    );
  }

  const verdict = await checkSharedRateLimit(
    `withdraw-reconcile:${clientAddress(request)}`,
    ADMIN_API_RATE_LIMIT,
  );
  if (!verdict.ok) {
    return Response.json(
      { ok: false, error: 'Rate limit exceeded.' },
      { status: 429, headers: { 'cache-control': 'no-store' } },
    );
  }

  const credentials = plaidCredentialsFromEnv();
  if (!credentials) {
    // Locked-rails policy: no application-level Plaid credentials, no
    // authoritative status queries — refuse explicitly.
    console.error('Withdrawal sweep: Plaid credentials are not configured.');
    return Response.json(
      { ok: false, error: 'Plaid reconciliation is not configured.' },
      { status: 503, headers: { 'cache-control': 'no-store' } },
    );
  }

  const db = supabaseFromEnv();
  if (!db) {
    console.error('Withdrawal sweep: database is not configured.');
    return Response.json(
      { ok: false, error: 'Database is not configured.' },
      { status: 503, headers: { 'cache-control': 'no-store' } },
    );
  }

  // The bounded candidate set: pending intents only, batch-limited at the
  // query, staleness-filtered in the handler (one round-trip, one bound).
  const { data, error } = await db
    .from('escrow_withdrawal_intents')
    .select('id, plaid_transfer_id, amount_units, created_at')
    .eq('status', 'pending')
    .limit(SWEEP_BATCH);
  if (error) {
    console.error('Withdrawal sweep: pending-intent read failed:', error);
    return Response.json(
      { ok: false, error: 'Pending-intent read failed.' },
      { status: 503, headers: { 'cache-control': 'no-store' } },
    );
  }

  const staleCutoff = Date.now() - STALE_AFTER_MS;
  const staleIntents = (data ?? []).filter((row) => {
    const createdAt = typeof (row as { created_at?: unknown }).created_at === 'string'
      ? new Date((row as { created_at: string }).created_at).getTime()
      : NaN;
    // A row with an unparseable created_at is treated as stale — a data
    // defect must not hide a hold from reconciliation.
    return Number.isNaN(createdAt) || createdAt <= staleCutoff;
  });

  const resolved: SweepEntry[] = [];
  const unresolved: SweepEntry[] = [];

  for (const raw of staleIntents) {
    const intent = raw as { id: string; plaid_transfer_id: string | null };
    try {
      const transferId =
        intent.plaid_transfer_id ?? (await findTransferIdForIntent(db, intent.id));
      if (!transferId) {
        // Pre-reconciler hold: the transfer id exists nowhere
        // machine-readable. Operator review; a webhook can still settle it.
        console.error(`Withdrawal sweep: intent ${intent.id} has no recoverable transfer id.`);
        unresolved.push({ intentId: intent.id, reason: 'no_transfer_id' });
        continue;
      }

      let status: string;
      try {
        status = await fetchTransferStatus(credentials, transferId);
      } catch (statusError) {
        console.error(`Withdrawal sweep: transfer/get failed for ${transferId}:`, statusError);
        unresolved.push({ intentId: intent.id, reason: 'status_query_failed' });
        continue;
      }

      const outcome = outcomeForTransferStatus(status);
      if (!outcome) {
        unresolved.push({ intentId: intent.id, status, reason: 'still_pending' });
        continue;
      }

      const resolution = await reconcileTransferOutcome(db, {
        intentId: intent.id,
        plaidTransferId: transferId,
        outcome,
      });
      resolved.push({
        intentId: intent.id,
        outcome,
        status,
        resolved: resolution.resolved,
        alreadyResolved: resolution.alreadyResolved,
        ledger: resolution.ledger,
      });
    } catch (reconcileError) {
      // The EscrowLedgerReadError family — a hold that cannot be resolved
      // right now stays pending; the next sweep (or webhook) converges.
      console.error(`Withdrawal sweep: reconciliation failed for intent ${intent.id}:`, reconcileError);
      unresolved.push({
        intentId: intent.id,
        reason: reconcileError instanceof EscrowLedgerReadError ? 'ledger_write_failed' : 'reconciliation_failed',
      });
    }
  }

  return Response.json(
    {
      ok: true,
      swept: staleIntents.length,
      batchLimit: SWEEP_BATCH,
      staleAfterSeconds: STALE_AFTER_MS / 1000,
      resolved,
      unresolved,
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
