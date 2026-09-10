// Vault bucket arithmetic — Cursor's Batch 2 vaults/balances.ts.
//
// Bucket field names follow the merged SovereignVaultRecord
// (available_balance / pending_balance / reserve_balance); the Batch 2 chat
// transcription's *_cents names do not exist on any merged record and both
// TS drops (vaults/engine.ts, Phase 3/4) use the _balance names. Semantics
// are the drop's, unchanged.
//
// Every function is pure: it returns a new record and never mutates.

import type { VaultBucket } from "@/modules/don/constants";
import type { SovereignVaultRecord } from "@/modules/don/records";

export type { VaultBucket };

// The vault shape the sovereign engine's persist step spreads over payee
// identity — balances only.
export type VaultBalances = Pick<
  SovereignVaultRecord,
  "available_balance" | "pending_balance" | "reserve_balance"
>;

// drop: vaults/engine.ts imports this alias for credit targets.
export type VaultCreditTarget = VaultBucket;

export function emptyVaultBalances(): VaultBalances {
  return { available_balance: 0, pending_balance: 0, reserve_balance: 0 };
}

// Generic over the record shape so full vault records keep their identity
// fields through the spread while balance-only inputs stay balance-only.
export function creditBalances<V extends VaultBalances>(
  vault: V,
  amountCents: number,
  bucket: VaultBucket,
): V {
  if (amountCents < 0) {
    throw new Error("creditBalances: amount_cents must be >= 0");
  }
  if (bucket === "available") {
    return { ...vault, available_balance: vault.available_balance + amountCents };
  }
  if (bucket === "pending") {
    return { ...vault, pending_balance: vault.pending_balance + amountCents };
  }
  return { ...vault, reserve_balance: vault.reserve_balance + amountCents };
}

export function debitBalances<V extends VaultBalances>(
  vault: V,
  amountCents: number,
  bucket: VaultBucket,
): V {
  if (amountCents < 0) {
    throw new Error("debitBalances: amount_cents must be >= 0");
  }
  if (bucket === "available") {
    if (amountCents > vault.available_balance) {
      throw new Error("debitBalances: insufficient available balance");
    }
    return { ...vault, available_balance: vault.available_balance - amountCents };
  }
  if (bucket === "pending") {
    if (amountCents > vault.pending_balance) {
      throw new Error("debitBalances: insufficient pending balance");
    }
    return { ...vault, pending_balance: vault.pending_balance - amountCents };
  }
  if (amountCents > vault.reserve_balance) {
    throw new Error("debitBalances: insufficient reserve balance");
  }
  return { ...vault, reserve_balance: vault.reserve_balance - amountCents };
}

// Moves available money into reserve without changing the total.
export function freezeIntoReserve(
  vault: SovereignVaultRecord,
  amountCents: number,
): SovereignVaultRecord {
  const debited = debitBalances(vault, amountCents, "available");
  return creditBalances(debited, amountCents, "reserve");
}

// Gives reserve money back to available when the dispute is unlocked.
export function unfreezeFromReserve(
  vault: SovereignVaultRecord,
  amountCents: number,
): SovereignVaultRecord {
  const debited = debitBalances(vault, amountCents, "reserve");
  return creditBalances(debited, amountCents, "available");
}

// ===== payout-hold helpers (consumed by vaults/engine.ts) =====
// Result-object style per the engine's call sites: a refusal carries the code
// the engine forwards to the HTTP envelope.

export type BalancesResult =
  | { ok: true; balances: VaultBalances }
  | { ok: false; code: "invalid_amount" | "insufficient_available" | "insufficient_pending" };

// Payouts hold on send: available moves to pending (in-flight hold).
export function holdPayout(
  vault: VaultBalances,
  amountCents: number,
): BalancesResult {
  if (amountCents < 0) {
    return { ok: false, code: "invalid_amount" };
  }
  if (amountCents > vault.available_balance) {
    return { ok: false, code: "insufficient_available" };
  }
  return {
    ok: true,
    balances: {
      available_balance: vault.available_balance - amountCents,
      pending_balance: vault.pending_balance + amountCents,
      reserve_balance: vault.reserve_balance,
    },
  };
}

// payout.settled clears the pending hold for good.
export function debitPending(
  vault: VaultBalances,
  amountCents: number,
): BalancesResult {
  if (amountCents < 0) {
    return { ok: false, code: "invalid_amount" };
  }
  if (amountCents > vault.pending_balance) {
    return { ok: false, code: "insufficient_pending" };
  }
  return {
    ok: true,
    balances: {
      available_balance: vault.available_balance,
      pending_balance: vault.pending_balance - amountCents,
      reserve_balance: vault.reserve_balance,
    },
  };
}

// Pending release moves money back to available; reports what actually
// released (capped at the pending balance — callers pre-check holds).
export function releasePending(
  vault: VaultBalances,
  amountCents: number,
): { ok: true; balances: VaultBalances; released_cents: number } | { ok: false; code: "invalid_amount" } {
  if (amountCents < 0) {
    return { ok: false, code: "invalid_amount" };
  }
  const released = Math.min(amountCents, vault.pending_balance);
  return {
    ok: true,
    balances: {
      available_balance: vault.available_balance + released,
      pending_balance: vault.pending_balance - released,
      reserve_balance: vault.reserve_balance,
    },
    released_cents: released,
  };
}

// A returned in-flight payout gives its pending hold back to available.
export function reversePayoutHold(
  vault: VaultBalances,
  amountCents: number,
): BalancesResult {
  if (amountCents < 0) {
    return { ok: false, code: "invalid_amount" };
  }
  if (amountCents > vault.pending_balance) {
    return { ok: false, code: "insufficient_pending" };
  }
  return {
    ok: true,
    balances: {
      available_balance: vault.available_balance + amountCents,
      pending_balance: vault.pending_balance - amountCents,
      reserve_balance: vault.reserve_balance,
    },
  };
}
