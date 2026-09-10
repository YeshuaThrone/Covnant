// Dispute freeze flags — Cursor's Batch 2 vaults/dispute.ts.
//
// The chat transcription showed vault-record-form flags reading
// `vault.dispute_locked`, a field that exists on no merged record; the two TS
// drops (vaults/engine.ts `isPayoutFrozen(store, payeeId)`, Phase 3/4
// `isIncomingFrozen(store, payeeId, workId)`) both use the store-form below —
// that is Cursor's real signature, kept here unchanged.
//
// Async adaptation only (Store PR contract): the store reads are awaited;
// predicates and math are untouched.

import type { Store } from "@/modules/don/storeStub";

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
