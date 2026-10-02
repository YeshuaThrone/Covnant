// GL journal legs — Cursor's Batch 2 ledger/journal.ts.
//
// Legs follow the merged GlEntryRecord shape: direction is encoded as the
// debit_cents / credit_cents pair (exactly one side carries the amount), not
// the transcription's `direction` + `amount_cents` — the Phase 3/4 engine
// reads `leg.debit_cents` off stored legs and posts inversions back.

import {
  GL_ACCOUNT_FBO_CASH,
  GL_ACCOUNT_UNCLAIMED_HOLDING,
  esportsPoolEscrowGlAccount,
  filmEscrowGlAccount,
  gamingCashoutGlAccount,
  tier5InvestorPoolGlAccount,
  tier5ProducerPoolGlAccount,
  vaultGlAccount,
  translationLocalizationGlAccount,
  vtuberHoldbackGlAccount,
  waterfallTierGlAccount,
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

// Unclaimed royalty holding (PR 7): the platform-scoped obligation account
// parked between "cash received" and "payee owed". A held credit posts a
// credit here against an FBO debit; a release debits it against vault
// credits — never a vault bucket, never the dust payee's account.
export function unclaimedHoldingDebit(amountCents: number): GlLegInput {
  return {
    account: GL_ACCOUNT_UNCLAIMED_HOLDING,
    debit_cents: amountCents,
    credit_cents: 0,
  };
}

export function unclaimedHoldingCredit(amountCents: number): GlLegInput {
  return {
    account: GL_ACCOUNT_UNCLAIMED_HOLDING,
    debit_cents: 0,
    credit_cents: amountCents,
  };
}

// Film waterfall escrow (PR 9): the per-film escrow obligation account. A
// locked receipt posts a credit here against an FBO debit; the verified
// release debits it against the waterfall routing legs — never a vault
// bucket, never the dust payee's account, never the unclaimed holding
// account.
export function filmEscrowDebit(filmId: string, amountCents: number): GlLegInput {
  return {
    account: filmEscrowGlAccount(filmId),
    debit_cents: amountCents,
    credit_cents: 0,
  };
}

export function filmEscrowCredit(filmId: string, amountCents: number): GlLegInput {
  return {
    account: filmEscrowGlAccount(filmId),
    debit_cents: 0,
    credit_cents: amountCents,
  };
}

// Gaming cashout pending (PR 13): the per-platform cashout obligation
// account. A locked payout batch posts a credit here against an FBO debit;
// the verified release debits it against the creator-credit legs — never a
// vault bucket, never the dust payee's account, never the unclaimed holding
// account, never the film escrow account.
export function gamingCashoutDebit(platform: string, amountCents: number): GlLegInput {
  return {
    account: gamingCashoutGlAccount(platform),
    debit_cents: amountCents,
    credit_cents: 0,
  };
}

export function gamingCashoutCredit(platform: string, amountCents: number): GlLegInput {
  return {
    account: gamingCashoutGlAccount(platform),
    debit_cents: 0,
    credit_cents: amountCents,
  };
}

// Esports prize pool escrow (PR 14): the per-batch escrow obligation
// account. A locked prize pool receipt posts a credit here against an FBO
// debit; the verified waterfall release debits it against the routing legs
// — never a vault bucket, never the dust payee's account, never the
// unclaimed holding account, never the film escrow or gaming cashout
// accounts.
export function esportsPoolEscrowDebit(batch: string, amountCents: number): GlLegInput {
  return {
    account: esportsPoolEscrowGlAccount(batch),
    debit_cents: amountCents,
    credit_cents: 0,
  };
}

export function esportsPoolEscrowCredit(batch: string, amountCents: number): GlLegInput {
  return {
    account: esportsPoolEscrowGlAccount(batch),
    debit_cents: 0,
    credit_cents: amountCents,
  };
}

// VTuber agency licensing holdback (PR 15): the per-agency holdback
// obligation account. A locked talent-income receipt posts a credit here
// against an FBO debit; the verified release debits it against the agency
// deduction stack and talent routing legs — never a vault bucket, never the
// dust payee's account, never any earlier holdback state's account.
export function vtuberHoldbackDebit(agencyId: string, amountCents: number): GlLegInput {
  return {
    account: vtuberHoldbackGlAccount(agencyId),
    debit_cents: amountCents,
    credit_cents: 0,
  };
}

export function vtuberHoldbackCredit(agencyId: string, amountCents: number): GlLegInput {
  return {
    account: vtuberHoldbackGlAccount(agencyId),
    debit_cents: 0,
    credit_cents: amountCents,
  };
}

// Translation/localization escrow legs (PR 20): the per-series-per-language
// lock account — a foreign feed's royalty receipt credits it at post; the
// verified release's cascade debits it as the money routes.
export function translationLocalizationDebit(
  seriesId: string,
  languageCode: string,
  amountCents: number,
): GlLegInput {
  return {
    account: translationLocalizationGlAccount(seriesId, languageCode),
    debit_cents: amountCents,
    credit_cents: 0,
  };
}

export function translationLocalizationCredit(
  seriesId: string,
  languageCode: string,
  amountCents: number,
): GlLegInput {
  return {
    account: translationLocalizationGlAccount(seriesId, languageCode),
    debit_cents: 0,
    credit_cents: amountCents,
  };
}

// Waterfall tier legs (PR 9): tiers 0 through 4 are plain accounts. The
// tier-5 net profit pool is NEVER a plain leg — route its credit through
// tier5ProducerPoolCredit/tier5InvestorPoolCredit, which split the locked
// 50/50 (net points draw only from the producer half).
export function waterfallTierCredit(
  filmId: string,
  tierLevel: number,
  amountCents: number,
): GlLegInput {
  return {
    account: waterfallTierGlAccount(filmId, tierLevel),
    debit_cents: 0,
    credit_cents: amountCents,
  };
}

export function tier5ProducerPoolCredit(filmId: string, amountCents: number): GlLegInput {
  return {
    account: tier5ProducerPoolGlAccount(filmId),
    debit_cents: 0,
    credit_cents: amountCents,
  };
}

export function tier5ProducerPoolDebit(filmId: string, amountCents: number): GlLegInput {
  return {
    account: tier5ProducerPoolGlAccount(filmId),
    debit_cents: amountCents,
    credit_cents: 0,
  };
}

export function tier5InvestorPoolCredit(filmId: string, amountCents: number): GlLegInput {
  return {
    account: tier5InvestorPoolGlAccount(filmId),
    debit_cents: 0,
    credit_cents: amountCents,
  };
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

