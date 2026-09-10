// Dispute freeze flags — Cursor's Batch 2 vaults/dispute.ts.
//
// The chat transcription showed vault-record-form flags reading
// `vault.dispute_locked`, a field that exists on no merged record; the two TS
// drops (vaults/engine.ts `isPayoutFrozen(store, payeeId)`, Phase 3/4
// `isIncomingFrozen(store, payeeId, workId)`) both use the store-form below —
// that is Cursor's real signature, kept here unchanged.

import type { Store } from "@/modules/don/storeStub";

// A locked payee (vault dispute) or locked work (catalog dispute) freezes
// incoming credits — routed to reserve upstream.
export function isIncomingFrozen(
  store: Store,
  payeeId: string,
  workId: string,
): boolean {
  return (
    (store.getVaultDispute(payeeId)?.locked ?? 0) === 1 ||
    (store.getCatalogDispute(workId)?.locked ?? 0) === 1
  );
}

// Payouts are refused while the payee's dispute lock is active.
export function isPayoutFrozen(store: Store, payeeId: string): boolean {
  return (store.getVaultDispute(payeeId)?.locked ?? 0) === 1;
}

// Work-level freeze check against a caller-supplied locked-work list.
export function isWorkFrozen(workId: string, lockedWorkIds: string[]): boolean {
  return lockedWorkIds.includes(workId);
}
