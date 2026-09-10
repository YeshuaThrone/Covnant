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
