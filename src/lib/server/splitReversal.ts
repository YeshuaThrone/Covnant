// Split-run reversal — Cursor's Phase 3/4 drop (reverseSplitRun).
//
// Mechanical async adaptation only (Store PR contract): store calls are
// awaited; the exact-inversion rule (royalty_reversal posts invertLegs of the
// original royalty_ingest), recoupment rollback, ledger settlement failure
// marking, and the idempotency ordering are untouched.
//
// Gap-fill disclosure: the drop calls parseVaultAccount and debitTarget but
// neither body appears in any drop. parseVaultAccount is authored here as the
// exact inverse of the merged vaultGlAccount("vault:{payeeId}:{bucket}");
// debitTarget is authored in the merged BalancesResult style (holdPayout /
// debitPending) over the canonical debitBalances primitive.

import type { Store } from "@/lib/server/store";
import type { SplitRunRecord } from "@/lib/don/types";
import type {
  GlJournalRecord,
  SovereignVaultRecord,
  SplitReversalRecord,
} from "@/modules/don/records";
import { VAULT_BUCKETS, type VaultBucket } from "@/modules/don/constants";
import { postJournal } from "@/modules/ledger/engine";
import { invertLegs } from "@/modules/ledger/journal";
import { debitBalances } from "@/modules/vaults/balances";

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

export type SplitRunReversalResult =
  | {
      ok: true;
      idempotent: boolean;
      split_run: SplitRunRecord;
      reversal: SplitReversalRecord;
      journal?: GlJournalRecord;
    }
  | { ok: false; status: number; code: string; message: string };

export async function reverseSplitRun(
  store: Store,
  splitRunId: string,
  now: Date = new Date(),
): Promise<SplitRunReversalResult> {
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

  for (const leg of inverted) {
    if (leg.debit_cents < 1) continue;
    const vaultAccount = parseVaultAccount(leg.account);
    if (!vaultAccount) continue;
    const vault = await store.getVault(vaultAccount.payeeId);
    if (!vault) {
      return {
        ok: false,
        status: 422,
        code: "split_reversal_insufficient",
        message: `Cannot reverse ${vaultAccount.bucket} for ${vaultAccount.payeeId}.`,
      };
    }
    const debited = debitTarget(vault, leg.debit_cents, vaultAccount.bucket);
    if (!debited.ok) {
      return {
        ok: false,
        status: 422,
        code: "split_reversal_insufficient",
        message: `Cannot reverse ${vaultAccount.bucket} for ${vaultAccount.payeeId}.`,
      };
    }
    await store.upsertVault({
      ...debited.balances,
      updated_at: now.toISOString(),
    });
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

  for (const row of await store.listLedgerTransactionsByRun(splitRunId)) {
    await store.updateLedgerSettlement(row.id, {
      status: "failed",
      rail: row.rail,
      baas_provider: row.baas_provider,
      baas_transfer_id: row.baas_transfer_id,
      settled_at: null,
    });
  }

  const posted = await postJournal(
    store,
    {
      kind: "royalty_reversal",
      ref_type: "split_run",
      ref_id: splitRunId,
      legs: inverted,
    },
    now,
  );
  if (!posted.ok) {
    return {
      ok: false,
      status: 500,
      code: posted.code,
      message: posted.message,
    };
  }
  await store.updateSplitRunStatus(splitRunId, "reversed");
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
