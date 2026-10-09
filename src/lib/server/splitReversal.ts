// Split-run reversal — Cursor's Phase 3/4 drop (reverseSplitRun).
//
// Mechanical async adaptation only (Store PR contract): store calls are
// awaited; the exact-inversion rule (royalty_reversal posts invertLegs of
// the original royalty_ingest), recoupment rollback, ledger settlement
// failure marking, and the idempotency ordering are untouched.
//
// Gap-fill disclosure: the drop calls parseVaultAccount and debitTarget but
// neither body appears in any drop. parseVaultAccount is authored here as the
// exact inverse of the merged vaultGlAccount("vault:{payeeId}:{bucket}");
// debitTarget is authored in the merged BalancesResult style (holdPayout /
// debitPending) over the canonical debitBalances primitive.
//
// Tax-audit hardening (note_c5ksDgVw #7/#13, this PR):
//   • The reversal now UNWINDS the withholding trail — compensating
//     (negative) escrow rows and YTD decrements keyed to the run, through
//     the same atomic accumulate migration 0057 introduced — so reversed
//     runs stop counting toward 1099s (taxUnwind.ts).
//   • The run is claimed with a guard-first atomic status transition
//     (UPDATE ... WHERE status='posted') BEFORE any clawback moves, so two
//     concurrent reversals can no longer both pass the status check and
//     double-claw the vaults; a lost claim aborts with 409.
//   • Vault clawbacks move through the atomic applyVaultDelta primitive
//     (floors enforced in the same statement that moves the money), not a
//     read-modify-write upsert.
//   • Every multi-write step is compensated on failure (vault re-credits,
//     recoupment re-application, settlement un-marking, claim revert), so a
//     mid-reversal failure leaves the run exactly as it was — no vault-vs-GL
//     divergence.
//
// Bug-hunt F6 hardening (this PR):
//   • Run rows holding a real baas_transfer_id are reversed through the
//     vault engine's reverseVaultPayout — idempotent via the payout_reversals
//     insert-as-lock — instead of being relabeled failed while the money
//     stayed PAID. A posted payout reversal is permanent financial history
//     (it journals under the transfer ref), so the compensation walk never
//     restores one; a retried reversal finds it already done.
//   • The operator-only allowNegativeReceivable option (exposed through
//     POST /api/v1/splits/reverse, requireOperator-gated) lets a clawback
//     drive a vault bucket negative — the receivable — instead of the run
//     being stuck with a permanent 422. Webhook-triggered reversals never
//     set it.

import type { Store } from "@/lib/server/store";
import type { SplitRunRecord } from "@/lib/don/types";
import type { LedgerTransactionRecord } from "@/lib/don/types";
import type {
  GlJournalRecord,
  SovereignVaultRecord,
  SplitReversalRecord,
} from "@/modules/don/records";
import { VAULT_BUCKETS, type VaultBucket } from "@/modules/don/constants";
import { postJournal, type PostJournalResult } from "@/modules/ledger/engine";
import { invertLegs } from "@/modules/ledger/journal";
import { debitBalances } from "@/modules/vaults/balances";
import { reverseVaultPayout } from "@/modules/vaults/engine";
import { unwindEscrowForRun, vaultBucketDelta } from "@/lib/server/taxUnwind";

export type ParsedVaultAccount = { payeeId: string; bucket: VaultBucket };

function isVaultBucket(value: string): value is VaultBucket {
  return (VAULT_BUCKETS as readonly string[]).includes(value);
}

// Inverse of vaultGlAccount: "vault:{payeeId}:{bucket}" → parts, null for
// every non-vault account (FBO cash, recoupment ledger).
export function parseVaultAccount(account: string): ParsedVaultAccount | null {
  const prefix = "vault:";
  if (!account.startsWith(prefix)) {
    return null;
  }
  const rest = account.slice(prefix.length);
  const separator = rest.lastIndexOf(":");
  if (separator < 1) {
    return null;
  }
  const payeeId = rest.slice(0, separator);
  const bucket = rest.slice(separator + 1);
  if (payeeId === "" || !isVaultBucket(bucket)) {
    return null;
  }
  return { payeeId, bucket };
}

type DebitTargetResult =
  | { ok: true; balances: SovereignVaultRecord }
  | { ok: false; code: "insufficient_balance" };

// Debits one vault bucket for a reversal leg; result-object style per the
// merged balances helpers so the engine forwards the code to the envelope.
// (Pre-validation only — the executed clawback is the atomic applyVaultDelta.)
function debitTarget(
  vault: SovereignVaultRecord,
  amountCents: number,
  bucket: VaultBucket,
): DebitTargetResult {
  if (amountCents < 0) {
    return { ok: false, code: "insufficient_balance" };
  }
  const current =
    bucket === "available"
      ? vault.available_balance
      : bucket === "pending"
        ? vault.pending_balance
        : vault.reserve_balance;
  if (amountCents > current) {
    return { ok: false, code: "insufficient_balance" };
  }
  return { ok: true, balances: debitBalances(vault, amountCents, bucket) };
}

// One vault clawback derived from an inverted GL leg.
type VaultClawback = {
  payeeId: string;
  payeeName: string;
  bucket: VaultBucket;
  amountCents: number;
};

// The applied clawbacks, in execution order — the compensation walk
// re-credits them in reverse when a later step fails. Re-credits carry no
// floor, so this walk always completes.
async function recreditClawbacks(
  store: Store,
  executed: VaultClawback[],
  now: Date,
): Promise<void> {
  for (const leg of [...executed].reverse()) {
    await store.applyVaultDelta({
      payee_id: leg.payeeId,
      payee_name: leg.payeeName,
      delta: vaultBucketDelta(leg.bucket, leg.amountCents),
      create_if_missing: true,
      updated_at: now.toISOString(),
    });
  }
}

// The recoupment rollback's exact inverse (failure compensation):
// re-applies what the rollback subtracted.
async function reapplyRecoupmentRollback(
  store: Store,
  splitRunId: string,
  now: Date,
): Promise<void> {
  for (const row of await store.listRecoupmentLedgerByRun(splitRunId)) {
    const advance = await store.getRecoupmentAdvance(row.creator_id);
    if (!advance) continue;
    await store.upsertRecoupmentAdvance({
      ...advance,
      recoupment_current_cents:
        advance.recoupment_current_cents + row.recouped_cents,
      updated_at: now.toISOString(),
    });
  }
}

export type SplitRunReversalResult =
  | {
      ok: true;
      idempotent: boolean;
      split_run: SplitRunRecord;
      reversal: SplitReversalRecord;
      journal?: GlJournalRecord;
    }
  | { ok: false; status: number; code: string; message: string };

export type SplitRunReversalOptions = {
  /**
   * Operator-only: let a clawback drive a vault bucket below zero instead
   * of refusing with 422 when the vault cannot fund it. The negative
   * balance is the receivable — what the payee owes the platform. Only
   * operator surfaces may set it; the webhook path never does.
   */
  allowNegativeReceivable?: boolean;
};

export async function reverseSplitRun(
  store: Store,
  splitRunId: string,
  now: Date = new Date(),
  options: SplitRunReversalOptions = {},
): Promise<SplitRunReversalResult> {
  const allowNegativeReceivable = options.allowNegativeReceivable === true;
  const run = await store.getSplitRun(splitRunId);
  if (!run) {
    return {
      ok: false,
      status: 404,
      code: "split_run_not_found",
      message: "No split run matches that id.",
    };
  }
  const existing = await store.getSplitReversalByRun(splitRunId);
  if (existing) {
    return { ok: true, idempotent: true, split_run: run, reversal: existing };
  }
  if (run.status !== "posted") {
    return {
      ok: false,
      status: 409,
      code: "split_already_reversed",
      message: "That split run is not in a reversible state.",
    };
  }

  const original = (await store.listGlJournalsByRef("split_run", splitRunId)).find(
    (row) => row.kind === "royalty_ingest",
  );
  if (!original) {
    return {
      ok: false,
      status: 404,
      code: "journal_not_found",
      message: "No royalty_ingest journal exists for that split run.",
    };
  }
  const inverted = invertLegs(await store.listGlEntriesByJournal(original.id));

  // Guard-first claim (audit #13): the atomic transition is the race
  // arbiter — a false return means a concurrent reversal won, and we abort
  // before a single cent moves. The claim precedes every state-dependent
  // check so a racing reversal can only ever fail with this 409, never
  // with a misleading insufficient-funds error.
  const claimed = await store.transitionSplitRunStatus(
    splitRunId,
    "posted",
    "reversed",
  );
  if (!claimed) {
    return {
      ok: false,
      status: 409,
      code: "split_already_reversed",
      message: "That split run is not in a reversible state.",
    };
  }

  // Pre-validate every vault leg AFTER claiming: a reversal that cannot
  // afford its clawbacks fails here having written nothing but the claim,
  // which is reverted so the run stays retryable.
  const clawbacks: VaultClawback[] = [];
  for (const leg of inverted) {
    if (leg.debit_cents < 1) continue;
    const vaultAccount = parseVaultAccount(leg.account);
    if (!vaultAccount) continue;
    const vault = await store.getVault(vaultAccount.payeeId);
    if (!vault) {
      await store.transitionSplitRunStatus(splitRunId, "reversed", "posted");
      return {
        ok: false,
        status: 422,
        code: "split_reversal_insufficient",
        message: `Cannot reverse ${vaultAccount.bucket} for ${vaultAccount.payeeId}.`,
      };
    }
    const debited = debitTarget(vault, leg.debit_cents, vaultAccount.bucket);
    if (!debited.ok && !allowNegativeReceivable) {
      await store.transitionSplitRunStatus(splitRunId, "reversed", "posted");
      return {
        ok: false,
        status: 422,
        code: "split_reversal_insufficient",
        message: `Cannot reverse ${vaultAccount.bucket} for ${vaultAccount.payeeId}.`,
      };
    }
    clawbacks.push({
      payeeId: vaultAccount.payeeId,
      payeeName: vault.payee_name,
      bucket: vaultAccount.bucket,
      amountCents: leg.debit_cents,
    });
  }

  // F6: settle rows whose money actually LEFT — reverse the BaaS payout
  // through the engine (idempotent via the payout_reversals insert-as-lock)
  // instead of relabeling the row failed while the transfer stayed paid.
  // This runs BEFORE the clawbacks execute: reverseVaultPayout floors the
  // post-update pending at 0 even though its own delta never touches
  // pending, so a clawback that already drove pending negative would make
  // the engine refuse the payout reversal it needs. Rows without a transfer
  // id keep the mark-failed behavior (nothing was ever dispatched). A posted
  // payout reversal is permanent — the compensation walks below never
  // restore one; a retried reversal finds it already done (idempotent).
  for (const row of await store.listLedgerTransactionsByRun(splitRunId)) {
    if (!row.baas_transfer_id) continue;
    const reversed = await reverseVaultPayout(
      store,
      row.baas_transfer_id,
      "payout.failed",
      now,
    );
    if (!reversed.ok) {
      // Nothing else has moved yet (no clawback, no marking), so reverting
      // the claim fully unwinds the attempt; the run is retryable.
      await store.transitionSplitRunStatus(splitRunId, "reversed", "posted");
      return {
        ok: false,
        status: reversed.status,
        code: reversed.code,
        message: `Split-run reversal could not reverse BaaS transfer ${row.baas_transfer_id} for ${row.payee_id}: ${reversed.message}`,
      };
    }
    // The engine marks the row through the transfer's ledger pointer; stamp
    // this run-bound row directly too so the failed marking holds even when
    // the pointer is missing.
    await store.updateLedgerSettlement(row.id, {
      status: "failed",
      rail: row.rail,
      baas_provider: row.baas_provider,
      baas_transfer_id: row.baas_transfer_id,
      settled_at: null,
    });
  }

  // From here on, every failure path fully compensates and reverts the
  // claim (safe to retry) — except payout reversals already posted above,
  // which are permanent history a retry finds idempotently.
  const executed: VaultClawback[] = [];
  for (const leg of clawbacks) {
    const applied = await store.applyVaultDelta({
      payee_id: leg.payeeId,
      payee_name: leg.payeeName,
      delta: vaultBucketDelta(leg.bucket, -leg.amountCents),
      // The negative-receivable override drops the floor: the bucket is
      // ALLOWED to go negative — that deficit is the receivable.
      min_balances: allowNegativeReceivable
        ? undefined
        : vaultBucketDelta(leg.bucket, 0),
      create_if_missing: false,
      updated_at: now.toISOString(),
    });
    if (applied.outcome !== "applied") {
      // A concurrent drain slipped between pre-validation and execution.
      // Walk the executed legs back, revert the claim, report.
      await recreditClawbacks(store, executed, now);
      await store.transitionSplitRunStatus(splitRunId, "reversed", "posted");
      return {
        ok: false,
        status: 422,
        code: "split_reversal_insufficient",
        message: `Cannot reverse ${leg.bucket} for ${leg.payeeId}.`,
      };
    }
    executed.push(leg);
  }

  for (const row of await store.listRecoupmentLedgerByRun(splitRunId)) {
    const advance = await store.getRecoupmentAdvance(row.creator_id);
    if (!advance) continue;
    await store.upsertRecoupmentAdvance({
      ...advance,
      recoupment_current_cents: Math.max(
        0,
        advance.recoupment_current_cents - row.recouped_cents,
      ),
      updated_at: now.toISOString(),
    });
  }

  const markedSettlements: LedgerTransactionRecord[] = [];
  for (const row of await store.listLedgerTransactionsByRun(splitRunId)) {
    // Transfer-backed rows were reversed (not merely marked) above — they
    // stay out of the compensation list, deliberately.
    if (row.baas_transfer_id) continue;
    await store.updateLedgerSettlement(row.id, {
      status: "failed",
      rail: row.rail,
      baas_provider: row.baas_provider,
      baas_transfer_id: row.baas_transfer_id,
      settled_at: null,
    });
    markedSettlements.push(row);
  }

  // Compensation for a reversal attempt that dies at the journal: the
  // vaults get their clawbacks re-credited, recoupment and the non-transfer
  // settlements are restored, and the claim is released so the run is
  // exactly as it was — safe to retry (audit #6). Payout reversals posted
  // above are permanent history and are deliberately not restored.
  const unwindReversalAttempt = async (): Promise<void> => {
    await recreditClawbacks(store, executed, now);
    await reapplyRecoupmentRollback(store, splitRunId, now);
    for (const row of markedSettlements) {
      await store.updateLedgerSettlement(row.id, {
        status: row.status,
        rail: row.rail,
        baas_provider: row.baas_provider,
        baas_transfer_id: row.baas_transfer_id,
        settled_at: row.settled_at,
      });
    }
    await store.transitionSplitRunStatus(splitRunId, "reversed", "posted");
  };

  let posted: PostJournalResult;
  try {
    posted = await postJournal(
      store,
      {
        kind: "royalty_reversal",
        ref_type: "split_run",
        ref_id: splitRunId,
        legs: inverted,
      },
      now,
    );
  } catch (error) {
    // The engine throws on store-level failures (bounded sequence retry
    // exhausted, journal insert rejected) — the same vault-vs-GL divergence
    // as an !ok result, so the same compensation applies.
    await unwindReversalAttempt();
    return {
      ok: false,
      status: 500,
      code: "journal_write_failed",
      message:
        error instanceof Error ? error.message : "Journal write failed.",
    };
  }
  if (!posted.ok) {
    await unwindReversalAttempt();
    return {
      ok: false,
      status: 500,
      code: posted.code,
      message: posted.message,
    };
  }

  // The journal is posted — now remove the phantom gross (audit #7): one
  // compensating escrow row and one negative YTD delta per escrow row the
  // run created, through the same atomic accumulate the settlement used.
  await unwindEscrowForRun(store, splitRunId, now);

  const reversal = await store.insertSplitReversal({
    split_run_id: splitRunId,
    journal_id: posted.journal.id,
    created_at: now.toISOString(),
  });
  return {
    ok: true,
    idempotent: false,
    split_run: { ...run, status: "reversed" },
    reversal,
    journal: posted.journal,
  };
}
