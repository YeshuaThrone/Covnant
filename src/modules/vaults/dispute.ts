// Dispute freeze flags — Cursor's Batch 2 vaults/dispute.ts.
//
// The chat transcription showed vault-record-form flags reading
// `vault.dispute_locked`, a field that exists on no merged record; the two TS
// drops (vaults/engine.ts `isPayoutFrozen(store, payeeId)`, Phase 3/4
// `isIncomingFrozen(store, payeeId, workId)`) both use the store-form below —
// that is Cursor's real signature, kept here unchanged.
//
// applyDisputeLock is Cursor's Phase 3/4 drop, async-adapted (Store PR
// contract). The drop expresses the money moves as result-object helpers; the
// merged balances layer is throw-style, so the sufficiency checks run
// explicitly against the same bucket math. Freeze sweeps available first,
// then pending, moving the total into reserve; release restores
// frozen_from_available → available and frozen_from_pending → pending out of
// the reserve.

import type { Store } from "@/lib/server/store";
import type {
  CatalogDisputeRecord,
  VaultDisputeRecord,
} from "@/modules/don/records";
import type { DisputeLockPayload } from "@/lib/don/validation";
import { creditBalances, debitBalances } from "./balances";

// A locked payee (vault dispute) or locked work (catalog dispute) freezes
// incoming credits — routed to reserve upstream.
export async function isIncomingFrozen(
  store: Store,
  payeeId: string,
  workId: string,
): Promise<boolean> {
  const vaultDispute = await store.getVaultDispute(payeeId);
  const catalogDispute = await store.getCatalogDispute(workId);
  return (
    (vaultDispute?.locked ?? 0) === 1 ||
    (catalogDispute?.locked ?? 0) === 1
  );
}

// Payouts are refused while the payee's dispute lock is active.
export async function isPayoutFrozen(store: Store, payeeId: string): Promise<boolean> {
  const dispute = await store.getVaultDispute(payeeId);
  return (dispute?.locked ?? 0) === 1;
}

// Work-level freeze check against a caller-supplied locked-work list.
export function isWorkFrozen(workId: string, lockedWorkIds: string[]): boolean {
  return lockedWorkIds.includes(workId);
}

export type DisputeLockResult =
  | {
      ok: true;
      dispute: VaultDisputeRecord | null;
      catalog_dispute: CatalogDisputeRecord | null;
      frozen_cents: number;
    }
  | { ok: false; status: number; code: string; message: string };

// Applies a dispute freeze or release (Phase 3/4 drop).
export async function applyDisputeLock(
  store: Store,
  input: DisputeLockPayload,
  now: Date = new Date(),
): Promise<DisputeLockResult> {
  const catalog_dispute = input.work_id
    ? await store.upsertCatalogDispute({
        work_id: input.work_id,
        locked: input.locked ? 1 : 0,
        updated_at: now.toISOString(),
      })
    : null;
  if (!input.payee_id) {
    return { ok: true, dispute: null, catalog_dispute, frozen_cents: 0 };
  }

  const vault = await store.getVault(input.payee_id);
  if (!vault) {
    return {
      ok: false,
      status: 404,
      code: "vault_not_found",
      message: "No sovereign vault exists for that payee.",
    };
  }
  const existing = await store.getVaultDispute(input.payee_id);

  if (!input.locked) {
    const frozenAvailable = existing?.frozen_from_available ?? 0;
    const frozenPending = existing?.frozen_from_pending ?? 0;
    const frozenTotal = frozenAvailable + frozenPending;
    if ((existing?.locked ?? 0) === 1 && frozenTotal > 0) {
      if (vault.reserve_balance < frozenTotal) {
        return {
          ok: false,
          status: 422,
          code: "insufficient_reserve",
          message:
            "Reserve balance is insufficient to release the dispute freeze.",
        };
      }
      const fromReserve = debitBalances(vault, frozenTotal, "reserve");
      const thawed = creditBalances(
        creditBalances(fromReserve, frozenAvailable, "available"),
        frozenPending,
        "pending",
      );
      await store.upsertVault({
        ...thawed,
        updated_at: now.toISOString(),
      });
    }
    const dispute = await store.upsertVaultDispute({
      payee_id: vault.payee_id,
      locked: 0,
      line_item_id: null,
      frozen_from_available: 0,
      frozen_from_pending: 0,
      updated_at: now.toISOString(),
    });
    return { ok: true, dispute, catalog_dispute, frozen_cents: 0 };
  }

  if (existing !== undefined && existing.locked === 1) {
    return {
      ok: true,
      dispute: existing,
      catalog_dispute,
      frozen_cents: existing.frozen_from_available + existing.frozen_from_pending,
    };
  }

  const amount =
    input.amount_cents ?? vault.available_balance + vault.pending_balance;
  const frozenFromAvailable = Math.min(amount, vault.available_balance);
  const frozenFromPending = amount - frozenFromAvailable;
  if (amount < 0 || frozenFromPending > vault.pending_balance) {
    return {
      ok: false,
      status: 422,
      code: "insufficient_funds",
      message:
        "available_balance + pending_balance cannot cover the dispute freeze.",
    };
  }
  const debitedAvailable = debitBalances(vault, frozenFromAvailable, "available");
  const debitedPending = debitBalances(debitedAvailable, frozenFromPending, "pending");
  const frozenBalances = creditBalances(debitedPending, amount, "reserve");
  await store.upsertVault({
    ...frozenBalances,
    updated_at: now.toISOString(),
  });
  const dispute = await store.upsertVaultDispute({
    payee_id: vault.payee_id,
    locked: 1,
    line_item_id: input.line_item_id ?? null,
    frozen_from_available: frozenFromAvailable,
    frozen_from_pending: frozenFromPending,
    updated_at: now.toISOString(),
  });
  return {
    ok: true,
    dispute,
    catalog_dispute,
    frozen_cents: frozenFromAvailable + frozenFromPending,
  };
}
