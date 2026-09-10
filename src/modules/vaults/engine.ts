/**
 * Sovereign vault engine — FBO credits, pending release, BaaS payout
 * from available_balance with in-flight holds, and payout settlement /
 * reversal used by the BaaS webhook ingestor.
 *
 * Copied verbatim from Cursor's drop, minus `payoutFromVault` /
 * `VaultPayoutInput` / `insertPayoutLedger`: those import getBaasAdapter from
 * "@/services/baas", which lands with the BaaS adapter PR — deferred to the
 * final wiring PR per the drop-resolution rule. Settlement and reversal (the
 * webhook-ingestor paths) are fully included.
 *
 * Async adaptation only (Store PR contract): every store call is awaited and
 * store-calling functions return Promises. Arithmetic, control flow, and GL
 * wiring are untouched.
 */

import type { Store } from "@/lib/server/store";
import type { BaasTransferRecord } from "@/lib/don/types";
import { postJournal } from "@/modules/ledger/engine";
import {
  fboCredit,
  fboDebit,
  vaultCredit,
  vaultDebit,
  type GlLegInput,
} from "@/modules/ledger/journal";
import type { PayoutReversalRecord, SovereignVaultRecord } from "@/modules/don/records";
import {
  creditBalances,
  debitPending,
  emptyVaultBalances,
  releasePending,
  reversePayoutHold,
  type VaultBalances,
  type VaultCreditTarget,
} from "./balances";

async function persistVault(
  store: Store,
  payeeId: string,
  payeeName: string,
  balances: {
    available_balance: number;
    pending_balance: number;
    reserve_balance: number;
  },
  now: Date,
): Promise<SovereignVaultRecord> {
  return await store.upsertVault({
    payee_id: payeeId,
    payee_name: payeeName,
    ...balances,
    updated_at: now.toISOString(),
  });
}

export async function creditVault(
  store: Store,
  payeeId: string,
  payeeName: string,
  amountCents: number,
  target: VaultCreditTarget,
  now: Date = new Date(),
): Promise<SovereignVaultRecord> {
  const current = await store.getVault(payeeId);
  const balances = creditBalances(
    current ?? emptyVaultBalances(),
    amountCents,
    target,
  );
  return persistVault(store, payeeId, payeeName, balances, now);
}

export async function releaseVaultPending(
  store: Store,
  payeeId: string,
  amountCents: number | undefined,
  now: Date = new Date(),
): Promise<
  | { ok: true; vault: SovereignVaultRecord; released_cents: number }
  | { ok: false; status: number; code: string; message: string }
> {
  const current = await store.getVault(payeeId);
  if (current === undefined) {
    return {
      ok: false,
      status: 404,
      code: "vault_not_found",
      message: "No sovereign vault exists for that payee.",
    };
  }
  const inFlight = await store.sumInFlightPayoutHolds(payeeId);
  const releasable = current.pending_balance - inFlight;
  const requested = amountCents === undefined ? releasable : amountCents;
  if (requested > releasable) {
    return {
      ok: false,
      status: 422,
      code: "insufficient_pending",
      message: "Pending balance is insufficient for that release (payout holds excluded).",
    };
  }
  const released = releasePending(current, requested);
  if (!released.ok) {
    return {
      ok: false,
      status: 422,
      code: released.code,
      message: "Pending balance is insufficient for that release.",
    };
  }
  const vault = await persistVault(
    store,
    current.payee_id,
    current.payee_name,
    released.balances,
    now,
  );
  if (released.released_cents > 0) {
    await postJournal(store, {
      kind: "pending_release",
      ref_type: "vault",
      ref_id: payeeId,
      legs: [
        vaultDebit(payeeId, "pending", released.released_cents),
        vaultCredit(payeeId, "available", released.released_cents),
      ],
    }, now);
  }
  return { ok: true, vault, released_cents: released.released_cents };
}

export async function settleVaultPayout(
  store: Store,
  transferId: string,
  now: Date = new Date(),
): Promise<
  | { ok: true; vault: SovereignVaultRecord; transfer: BaasTransferRecord; idempotent: boolean }
  | { ok: false; status: number; code: string; message: string }
> {
  const transfer = await store.getBaasTransfer(transferId);
  if (transfer === undefined) {
    return {
      ok: false,
      status: 404,
      code: "transfer_not_found",
      message: "No BaaS transfer matches that id.",
    };
  }
  const hold = await store.getPayoutHold(transferId);
  const vault = await store.getVault(transfer.payee_id);
  if (vault === undefined) {
    return {
      ok: false,
      status: 404,
      code: "vault_not_found",
      message: "No sovereign vault exists for that payee.",
    };
  }
  if (hold === undefined || hold.status === "settled") {
    await store.updateBaasTransferStatus(transferId, "settled");
    if (transfer.ledger_transaction_id) {
      const ledger = await store.getLedgerTransaction(transfer.ledger_transaction_id);
      if (ledger) {
        await store.updateLedgerSettlement(ledger.id, {
          status: "settled",
          rail: ledger.rail ?? transfer.rail,
          baas_provider: ledger.baas_provider ?? transfer.provider,
          baas_transfer_id: transferId,
          settled_at: now.toISOString(),
        });
      }
    }
    return { ok: true, vault, transfer: (await store.getBaasTransfer(transferId))!, idempotent: true };
  }
  if (hold.status === "reversed") {
    return {
      ok: false,
      status: 409,
      code: "payout_already_reversed",
      message: "That payout was already returned or failed.",
    };
  }
  const cleared = debitPending(vault, hold.amount_cents);
  if (!cleared.ok) {
    return {
      ok: false,
      status: 422,
      code: cleared.code,
      message: "pending_balance cannot cover that settled payout.",
    };
  }
  const updated = await persistVault(store, vault.payee_id, vault.payee_name, cleared.balances, now);
  await store.updatePayoutHoldStatus(transferId, "settled");
  await store.updateBaasTransferStatus(transferId, "settled");
  if (transfer.ledger_transaction_id) {
    const ledger = await store.getLedgerTransaction(transfer.ledger_transaction_id);
    if (ledger) {
      await store.updateLedgerSettlement(ledger.id, {
        status: "settled",
        rail: ledger.rail ?? transfer.rail,
        baas_provider: ledger.baas_provider ?? transfer.provider,
        baas_transfer_id: transferId,
        settled_at: now.toISOString(),
      });
    }
  }
  await postJournal(store, {
    kind: "payout_settled",
    ref_type: "baas_transfer",
    ref_id: transferId,
    legs: [
      vaultDebit(vault.payee_id, "pending", hold.amount_cents),
      fboCredit(hold.amount_cents),
    ],
  }, now);
  return {
    ok: true,
    vault: updated,
    transfer: (await store.getBaasTransfer(transferId))!,
    idempotent: false,
  };
}

export async function reverseVaultPayout(
  store: Store,
  transferId: string,
  reason: "payout.returned" | "payout.failed",
  now: Date = new Date(),
): Promise<
  | {
      ok: true;
      vault: SovereignVaultRecord;
      reversal: PayoutReversalRecord;
      transfer: BaasTransferRecord;
      idempotent: boolean;
    }
  | { ok: false; status: number; code: string; message: string }
> {
  const transfer = await store.getBaasTransfer(transferId);
  if (transfer === undefined) {
    return {
      ok: false,
      status: 404,
      code: "transfer_not_found",
      message: "No BaaS transfer matches that id.",
    };
  }
  const existing = await store.getPayoutReversalByTransfer(transferId);
  const vault = await store.getVault(transfer.payee_id);
  if (vault === undefined) {
    return {
      ok: false,
      status: 404,
      code: "vault_not_found",
      message: "No sovereign vault exists for that payee.",
    };
  }
  if (existing !== undefined) {
    return {
      ok: true,
      vault,
      reversal: existing,
      transfer,
      idempotent: true,
    };
  }

  const hold = await store.getPayoutHold(transferId);
  const amount = hold?.amount_cents ?? transfer.amount_cents;
  let nextBalances: VaultBalances = {
    available_balance: vault.available_balance,
    pending_balance: vault.pending_balance,
    reserve_balance: vault.reserve_balance,
  };
  const legs: GlLegInput[] = [];

  if (hold?.status === "in_flight") {
    const reversed = reversePayoutHold(vault, amount);
    if (!reversed.ok) {
      return {
        ok: false,
        status: 422,
        code: reversed.code,
        message: "pending_balance cannot cover that payout reversal.",
      };
    }
    nextBalances = reversed.balances;
    legs.push(vaultDebit(vault.payee_id, "pending", amount));
    legs.push(vaultCredit(vault.payee_id, "available", amount));
    await store.updatePayoutHoldStatus(transferId, "reversed");
  } else {
    nextBalances = creditBalances(nextBalances, amount, "available");
    legs.push(fboDebit(amount));
    legs.push(vaultCredit(vault.payee_id, "available", amount));
    if (hold?.status === "settled") {
      await store.updatePayoutHoldStatus(transferId, "reversed");
    }
  }

  const updated = await persistVault(store, vault.payee_id, vault.payee_name, nextBalances, now);
  const transferStatus = reason === "payout.returned" ? "returned" : "failed";
  await store.updateBaasTransferStatus(transferId, transferStatus);

  if (transfer.ledger_transaction_id) {
    const original = await store.getLedgerTransaction(transfer.ledger_transaction_id);
    if (original) {
      await store.updateLedgerSettlement(original.id, {
        status: "failed",
        rail: original.rail ?? transfer.rail,
        baas_provider: original.baas_provider ?? transfer.provider,
        baas_transfer_id: transferId,
        settled_at: null,
      });
    }
  }

  const reversalLedger = await store.insertLedgerTransaction({
    split_run_id: "",
    line_item_id: "",
    payee_id: vault.payee_id,
    payee_name: vault.payee_name,
    role: "other",
    share_bps: 0,
    amount_cents: amount,
    currency: "USD",
    status: "failed",
    rail: transfer.rail,
    baas_provider: transfer.provider,
    baas_transfer_id: transferId,
    created_at: now.toISOString(),
    settled_at: null,
    kind: "payout_failed_reversal",
  });

  const posted = await postJournal(store, {
    kind: "payout_failed_reversal",
    ref_type: "baas_transfer",
    ref_id: transferId,
    legs,
  }, now);
  if (!posted.ok) {
    return {
      ok: false,
      status: 500,
      code: posted.code,
      message: posted.message,
    };
  }

  const reversal = await store.insertPayoutReversal({
    transfer_id: transferId,
    payee_id: vault.payee_id,
    amount_cents: amount,
    reason,
    ledger_transaction_id: reversalLedger.id,
    journal_id: posted.journal.id,
    created_at: now.toISOString(),
  });

  return {
    ok: true,
    vault: updated,
    reversal,
    transfer: (await store.getBaasTransfer(transferId))!,
    idempotent: false,
  };
}
