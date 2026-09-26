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
import type {
  BaasTransferRecord,
  LedgerTransactionRecord,
  SettlementRail,
} from "@/lib/don/types";
import {
  getBaasAdapter,
  type BaasTransferResult,
} from "@/services/baas";
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
  holdPayout,
  releasePending,
  reversePayoutHold,
  type VaultBalances,
  type VaultCreditTarget,
} from "./balances";
import { isPayoutFrozen } from "./dispute";

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
  // Atomic credit (migration 0009, H1): the delta is applied additively in
  // one guarded statement — no read-modify-write window, so concurrent
  // credits can no longer last-write-wins over each other.
  const delta = emptyVaultBalances();
  delta[`${target}_balance`] += amountCents;
  const result = await store.applyVaultDelta({
    payee_id: payeeId,
    payee_name: payeeName,
    delta,
    create_if_missing: true,
    updated_at: now.toISOString(),
  });
  if (result.outcome !== "applied") {
    // Unreachable by contract: a non-negative delta mints or adds with no
    // floors set. Surface it loudly rather than inventing a balance.
    throw new Error(
      `creditVault: the store refused a ${amountCents}-cent credit to ${payeeId} (${result.outcome}).`,
    );
  }
  return result.vault;
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
  // Atomic settle (migration 0009, H1): the pending debit is guarded in the
  // same statement that moves the money — two concurrent settles of
  // different payouts can no longer last-write-wins over each other.
  const applied = await store.applyVaultDelta({
    payee_id: vault.payee_id,
    payee_name: vault.payee_name,
    delta: {
      available_balance: 0,
      pending_balance: -hold.amount_cents,
      reserve_balance: 0,
    },
    min_balances: { pending_balance: 0 },
    create_if_missing: false,
    updated_at: now.toISOString(),
  });
  if (applied.outcome !== "applied") {
    return {
      ok: false,
      status: 422,
      code: "insufficient_pending",
      message: "pending_balance cannot cover that settled payout.",
    };
  }
  const updated = applied.vault;
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

  // Insert-as-lock (migration 0009, H4): the reversal row is written BEFORE
  // any money moves and payout_reversals.transfer_id is UNIQUE, so a
  // replayed or concurrent webhook loses the insert race and gets the
  // winner's row back instead of double-crediting the vault. The journal
  // and ledger ids are back-filled after posting — they do not exist yet.
  let lock: PayoutReversalRecord;
  try {
    lock = await store.insertPayoutReversal({
      transfer_id: transferId,
      payee_id: vault.payee_id,
      amount_cents: amount,
      reason,
      ledger_transaction_id: null,
      journal_id: null,
      created_at: now.toISOString(),
    });
  } catch (insertError) {
    const winner = await store.getPayoutReversalByTransfer(transferId);
    if (winner === undefined) {
      throw insertError; // not a duplicate-transfer failure — surface it
    }
    return { ok: true, vault, reversal: winner, transfer, idempotent: true };
  }

  const legs: GlLegInput[] = [];
  let delta: VaultBalances;
  let failureCode: string;

  if (hold?.status === "in_flight") {
    const reversed = reversePayoutHold(vault, amount);
    if (!reversed.ok) {
      // Money never moved — drop the lock so a retry can re-attempt.
      await store.deletePayoutReversal(lock.id);
      return {
        ok: false,
        status: 422,
        code: reversed.code,
        message: "pending_balance cannot cover that payout reversal.",
      };
    }
    delta = {
      available_balance: amount,
      pending_balance: -amount,
      reserve_balance: 0,
    };
    failureCode = reversed.code;
    legs.push(vaultDebit(vault.payee_id, "pending", amount));
    legs.push(vaultCredit(vault.payee_id, "available", amount));
  } else {
    delta = {
      available_balance: amount,
      pending_balance: 0,
      reserve_balance: 0,
    };
    failureCode = "insufficient_available";
    legs.push(fboDebit(amount));
    legs.push(vaultCredit(vault.payee_id, "available", amount));
  }

  // Atomic reversal move (migration 0009, H1): the sufficiency floors are
  // enforced in the same statement that moves the money.
  const applied = await store.applyVaultDelta({
    payee_id: vault.payee_id,
    payee_name: vault.payee_name,
    delta,
    min_balances: { available_balance: 0, pending_balance: 0 },
    create_if_missing: false,
    updated_at: now.toISOString(),
  });
  if (applied.outcome !== "applied") {
    await store.deletePayoutReversal(lock.id);
    return {
      ok: false,
      status: 422,
      code: failureCode,
      message: "The vault balances cannot cover that payout reversal.",
    };
  }
  const updated = applied.vault;
  if (hold !== undefined && (hold.status === "in_flight" || hold.status === "settled")) {
    await store.updatePayoutHoldStatus(transferId, "reversed");
  }
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

  // Finalize the lock row (migration 0009, H4): the reversal row was
  // inserted as the guard before the money moved; now it becomes financial
  // history with the posted journal and ledger ids attached.
  const reversal = await store.updatePayoutReversal(lock.id, {
    journal_id: posted.journal.id,
    ledger_transaction_id: reversalLedger.id,
  });
  if (reversal === undefined) {
    throw new Error(
      `reverseVaultPayout: reversal lock row ${lock.id} vanished before finalization.`,
    );
  }

  return {
    ok: true,
    vault: updated,
    reversal,
    transfer: (await store.getBaasTransfer(transferId))!,
    idempotent: false,
  };
}


export type VaultPayoutInput = {
  payee_id: string;
  amount_cents: number;
  rail: SettlementRail;
};

async function insertPayoutLedger(
  store: Store,
  input: {
    payee_id: string;
    payee_name: string;
    amount_cents: number;
    rail: SettlementRail;
  },
  now: Date,
): Promise<LedgerTransactionRecord> {
  return await store.insertLedgerTransaction({
    split_run_id: "",
    line_item_id: "",
    payee_id: input.payee_id,
    payee_name: input.payee_name,
    role: "other",
    share_bps: 0,
    amount_cents: input.amount_cents,
    currency: "USD",
    status: "submitted",
    rail: input.rail,
    baas_provider: null,
    baas_transfer_id: null,
    created_at: now.toISOString(),
    settled_at: null,
    kind: "payout",
  });
}

export async function payoutFromVault(
  store: Store,
  input: VaultPayoutInput,
  now: Date = new Date(),
): Promise<
  | {
      ok: true;
      vault: SovereignVaultRecord;
      transfer: Extract<BaasTransferResult, { ok: true }>["transfer"];
    }
  | { ok: false; status: number; code: string; message: string }
> {
  const current = await store.getVault(input.payee_id);
  if (current === undefined) {
    return {
      ok: false,
      status: 404,
      code: "vault_not_found",
      message: "No sovereign vault exists for that payee.",
    };
  }
  if (await isPayoutFrozen(store, input.payee_id)) {
    return {
      ok: false,
      status: 423,
      code: "payout_frozen",
      message: "Payouts are frozen while a split dispute lock is active.",
    };
  }
  const held = holdPayout(current, input.amount_cents);
  if (!held.ok) {
    return {
      ok: false,
      status: 422,
      code: held.code,
      message: "available_balance is insufficient for that payout.",
    };
  }
  await persistVault(store, current.payee_id, current.payee_name, held.balances, now);
  const ledger = await insertPayoutLedger(
    store,
    {
      payee_id: current.payee_id,
      payee_name: current.payee_name,
      amount_cents: input.amount_cents,
      rail: input.rail,
    },
    now,
  );
  const adapter = getBaasAdapter(store);
  const request = {
    payee_id: current.payee_id,
    payee_name: current.payee_name,
    amount_cents: input.amount_cents,
    currency: "USD",
    ledger_transaction_id: ledger.id,
  };
  const result =
    input.rail === "rtp"
      ? await adapter.createRtpPayment(request)
      : await adapter.createAchTransfer(request);
  if (!result.ok) {
    // Roll the hold back with the inverse, guarded delta (migration 0009,
    // H1) — a full-row overwrite of the stale pre-hold vault would clobber
    // concurrent mutations.
    const rolledBack = await store.applyVaultDelta({
      payee_id: current.payee_id,
      payee_name: current.payee_name,
      delta: {
        available_balance: input.amount_cents,
        pending_balance: -input.amount_cents,
        reserve_balance: 0,
      },
      min_balances: { available_balance: 0, pending_balance: 0 },
      create_if_missing: false,
      updated_at: now.toISOString(),
    });
    if (rolledBack.outcome !== "applied") {
      // The hold just added this pending balance, so the inverse refusing is
      // a data-integrity alarm — surface it instead of the adapter error.
      throw new Error(
        `payoutFromVault: could not roll back the payout hold for ${current.payee_id} after a failed BaaS call.`,
      );
    }
    await store.updateLedgerSettlement(ledger.id, {
      status: "failed",
      rail: input.rail,
      baas_provider: adapter.provider,
      baas_transfer_id: null,
      settled_at: null,
    });
    return result;
  }
  await store.updateLedgerSettlement(ledger.id, {
    status: "submitted",
    rail: input.rail,
    baas_provider: adapter.provider,
    baas_transfer_id: result.transfer.id,
    settled_at: null,
  });
  await store.insertPayoutHold({
    transfer_id: result.transfer.id,
    payee_id: current.payee_id,
    amount_cents: input.amount_cents,
    status: "in_flight",
    created_at: now.toISOString(),
  });
  await postJournal(store, {
    kind: "payout_hold",
    ref_type: "baas_transfer",
    ref_id: result.transfer.id,
    legs: [
      vaultDebit(current.payee_id, "available", input.amount_cents),
      vaultCredit(current.payee_id, "pending", input.amount_cents),
    ],
  }, now);

  return {
    ok: true,
    vault,
    transfer: result.transfer,
  };
}

