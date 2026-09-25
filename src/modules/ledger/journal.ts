// GL journal legs — Cursor's Batch 2 ledger/journal.ts.
//
// Legs follow the merged GlEntryRecord shape: direction is encoded as the
// debit_cents / credit_cents pair (exactly one side carries the amount), not
// the transcription's `direction` + `amount_cents` — the Phase 3/4 engine
// reads `leg.debit_cents` off stored legs and posts inversions back.

import {
  GL_ACCOUNT_FBO_CASH,
  vaultGlAccount,
  type VaultBucket,
} from "@/modules/don/constants";

export type GlLegInput = {
  // e.g. "fbo_cash" | "vault:{payeeId}:{bucket}" | "company_dust"
  account: string;
  debit_cents: number;
  credit_cents: number;
  memo?: string;
};

// A journal posts only when the two sides meet exactly and money moves.
export function validateJournal(legs: GlLegInput[]): {
  ok: boolean;
  debits: number;
  credits: number;
} {
  let debits = 0;
  let credits = 0;
  for (const leg of legs) {
    debits += leg.debit_cents;
    credits += leg.credit_cents;
  }
  return { ok: debits === credits && debits > 0, debits, credits };
}

// The reversal of a journal is its exact mirror: every leg flips sides,
// accounts and memos carry over untouched.
export function invertLegs(legs: GlLegInput[]): GlLegInput[] {
  return legs.map((leg) => ({
    ...leg,
    debit_cents: leg.credit_cents,
    credit_cents: leg.debit_cents,
  }));
}

export function vaultDebit(
  payeeId: string,
  bucket: VaultBucket,
  amountCents: number,
): GlLegInput {
  return {
    account: vaultGlAccount(payeeId, bucket),
    debit_cents: amountCents,
    credit_cents: 0,
  };
}

export function vaultCredit(
  payeeId: string,
  bucket: VaultBucket,
  amountCents: number,
): GlLegInput {
  return {
    account: vaultGlAccount(payeeId, bucket),
    debit_cents: 0,
    credit_cents: amountCents,
  };
}

export function fboDebit(amountCents: number): GlLegInput {
  return { account: GL_ACCOUNT_FBO_CASH, debit_cents: amountCents, credit_cents: 0 };
}

export function fboCredit(amountCents: number): GlLegInput {
  return { account: GL_ACCOUNT_FBO_CASH, debit_cents: 0, credit_cents: amountCents };
}

// --- Audit-surveillance helpers (Cursor's Batch 2 drop, landed with the
// Covenant API integration: the MCP ledger tools consume them). Pure
// double-entry math over the GlLegInput shape — no Store, no I/O.

export function sumDebits(legs: readonly GlLegInput[]): number {
  return legs.reduce((total, leg) => total + leg.debit_cents, 0);
}

export function sumCredits(legs: readonly GlLegInput[]): number {
  return legs.reduce((total, leg) => total + leg.credit_cents, 0);
}

export function journalIsBalanced(legs: readonly GlLegInput[]): boolean {
  return sumDebits(legs) === sumCredits(legs);
}

export function compactLegs(legs: readonly GlLegInput[]): GlLegInput[] {
  return legs.filter((leg) => leg.debit_cents !== 0 || leg.credit_cents !== 0);
}

export function netDebit(legs: readonly GlLegInput[], account: string): number {
  return legs.reduce((total, leg) => {
    if (leg.account !== account) {
      return total;
    }
    return total + leg.debit_cents - leg.credit_cents;
  }, 0);
}

export function isVaultAccount(account: string): boolean {
  return account.startsWith("vault:");
}

export type DebitCreditPair = {
  debit_account: string;
  credit_account: string;
  amount_cents: number;
};

/**
 * Expand a balanced multi-leg journal into explicit debit/credit pairs
 * (one FBO debit may fund many vault credits).
 */
export function expandDebitCreditPairs(
  legs: readonly GlLegInput[],
): DebitCreditPair[] {
  const debits = compactLegs(legs)
    .filter((leg) => leg.debit_cents > 0)
    .map((leg) => ({ account: leg.account, remaining: leg.debit_cents }));
  const credits = compactLegs(legs)
    .filter((leg) => leg.credit_cents > 0)
    .map((leg) => ({ account: leg.account, remaining: leg.credit_cents }));
  const pairs: DebitCreditPair[] = [];
  let di = 0;
  let ci = 0;
  while (di < debits.length && ci < credits.length) {
    const debit = debits[di]!;
    const credit = credits[ci]!;
    const amount = Math.min(debit.remaining, credit.remaining);
    pairs.push({
      debit_account: debit.account,
      credit_account: credit.account,
      amount_cents: amount,
    });
    debit.remaining -= amount;
    credit.remaining -= amount;
    if (debit.remaining === 0) {
      di += 1;
    }
    if (credit.remaining === 0) {
      ci += 1;
    }
  }
  return pairs;
}

