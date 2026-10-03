// GL journal legs — Cursor's Batch 2 ledger/journal.ts.
//
// Legs follow the merged GlEntryRecord shape: direction is encoded as the
// debit_cents / credit_cents pair (exactly one side carries the amount), not
// the transcription's `direction` + `amount_cents` — the Phase 3/4 engine
// reads `leg.debit_cents` off stored legs and posts inversions back.

import {
  GL_ACCOUNT_FBO_CASH,
  GL_ACCOUNT_UNCLAIMED_HOLDING,
  auditReserveEscrowGlAccount,
  comedyAudioRightsGlAccount,
  esportsPoolEscrowGlAccount,
  fitnessAuditEscrowGlAccount,
  culinaryAuditEscrowGlAccount,
  serviceAuditEscrowGlAccount,
  softwareAuditEscrowGlAccount,
  filmEscrowGlAccount,
  gamingCashoutGlAccount,
  licensingMgReceivableGlAccount,
  licensingMgShortfallIncomeGlAccount,
  nilAuditEscrowGlAccount,
  nilUnearnedClawbackReceivableGlAccount,
  nilUnearnedClawbackRecoveryGlAccount,
  merchReturnsReserveGlAccount,
  promoterSettlementGlAccount,
  bookReturnsReserveGlAccount,
  spatialAuditEscrowGlAccount,
  spatialMsgReceivableGlAccount,
  spatialMsgShortfallIncomeGlAccount,
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

// Merch returns reserve legs (PR 23): the per-sku reserve lock account. A
// dispatched payout allocation credits it with the 10–15% holdback (against
// the unclaimed holding debit); a return/chargeback drawdown debits it back
// to FBO cash, and the verified window release debits it to the creator
// credit legs — never a vault bucket at post, never any other escrow's
// account.
export function merchReturnsReserveDebit(skuId: string, amountCents: number): GlLegInput {
  return {
    account: merchReturnsReserveGlAccount(skuId),
    debit_cents: amountCents,
    credit_cents: 0,
  };
}

export function merchReturnsReserveCredit(skuId: string, amountCents: number): GlLegInput {
  return {
    account: merchReturnsReserveGlAccount(skuId),
    debit_cents: 0,
    credit_cents: amountCents,
  };
}

// Book returns reserve legs (PR 27): the per-ISBN reserve lock account — the
// merch legs' mirror at ISBN scope. A locked print allocation credits it
// with the 15–20% holdback (against the unclaimed holding debit); a
// return/chargeback drawdown debits it back to FBO cash, and the verified
// window release debits it to the beneficiary's taxed cascade legs — never a
// vault bucket at post, never any other escrow's account.
export function bookReturnsReserveDebit(isbn: string, amountCents: number): GlLegInput {
  return {
    account: bookReturnsReserveGlAccount(isbn),
    debit_cents: amountCents,
    credit_cents: 0,
  };
}

export function bookReturnsReserveCredit(isbn: string, amountCents: number): GlLegInput {
  return {
    account: bookReturnsReserveGlAccount(isbn),
    debit_cents: 0,
    credit_cents: amountCents,
  };
}

// Promoter box office settlement escrow legs (PR 31): the per-stop escrow
// obligation account — the book reserve legs' mirror at (production, venue,
// show date) scope. A locked stop's box office net credits it against an
// FBO debit; the verified audit-close release debits it against the stop's
// designated payout legs — never a vault bucket at post, never the dust
// payee's account, never the unclaimed holding account, never any other
// escrow's account.
export function promoterSettlementDebit(
  productionId: string,
  venueId: string,
  showDate: string,
  amountCents: number,
): GlLegInput {
  return {
    account: promoterSettlementGlAccount(productionId, venueId, showDate),
    debit_cents: amountCents,
    credit_cents: 0,
  };
}

export function promoterSettlementCredit(
  productionId: string,
  venueId: string,
  showDate: string,
  amountCents: number,
): GlLegInput {
  return {
    account: promoterSettlementGlAccount(productionId, venueId, showDate),
    debit_cents: 0,
    credit_cents: amountCents,
  };
}

// Comedy audio rights legs (PR 31): the per-special audio royalty stream
// account — SiriusXM/Spotify licensed-recording money lives HERE, never in
// the theatrical box office stream's accounts and never in unclaimed
// holding; the isolation is the account identity.
export function comedyAudioRightsDebit(specialId: string, amountCents: number): GlLegInput {
  return {
    account: comedyAudioRightsGlAccount(specialId),
    debit_cents: amountCents,
    credit_cents: 0,
  };
}

export function comedyAudioRightsCredit(specialId: string, amountCents: number): GlLegInput {
  return {
    account: comedyAudioRightsGlAccount(specialId),
    debit_cents: 0,
    credit_cents: amountCents,
  };
}

// Audit reserve escrow legs (PR 33): the per-scope AUDIT_RESERVE_ESCROW
// obligation account — the book reserve legs' mirror at license-scope
// scope. A routed royalty credit's reserve locks here against the holding
// account's debit; audit reconciliations and write-offs debit it back to
// FBO cash; the verified release debits it into the licensor's payout
// legs — never the dust payee's account, never the unclaimed holding
// account, never any other escrow's account.
export function auditReserveEscrowDebit(scopeKey: string, amountCents: number): GlLegInput {
  return {
    account: auditReserveEscrowGlAccount(scopeKey),
    debit_cents: amountCents,
    credit_cents: 0,
  };
}

export function auditReserveEscrowCredit(scopeKey: string, amountCents: number): GlLegInput {
  return {
    account: auditReserveEscrowGlAccount(scopeKey),
    debit_cents: 0,
    credit_cents: amountCents,
  };
}

// Minimum-guarantee shortfall invoice legs (PR 33): the invoice of record
// prices the receivable — the licensee's shortfall debt rises as a
// receivable asset (debit) against the shortfall penalty income of record
// (credit). Balanced legs; no cash moves until the invoice settles.
export function licensingMgReceivableDebit(scopeKey: string, amountCents: number): GlLegInput {
  return {
    account: licensingMgReceivableGlAccount(scopeKey),
    debit_cents: amountCents,
    credit_cents: 0,
  };
}

export function licensingMgShortfallIncomeCredit(
  scopeKey: string,
  amountCents: number,
): GlLegInput {
  return {
    account: licensingMgShortfallIncomeGlAccount(scopeKey),
    debit_cents: 0,
    credit_cents: amountCents,
  };
}

// NIL audit escrow legs (PR 35): the per-scope NIL_AUDIT_ESCROW obligation
// account — the audit-reserve legs' mirror at (payee, school) scope. A
// routed athletic department distribution's reserve locks here against
// the holding account's debit; mid-season NCAA Transfer Portal
// reconciliations and tax withholdings debit it back to FBO cash; the
// verified release debits it into the athlete's payout legs — never the
// dust payee's account, never the unclaimed holding account, never any
// other escrow's account.
export function nilAuditEscrowDebit(scopeKey: string, amountCents: number): GlLegInput {
  return {
    account: nilAuditEscrowGlAccount(scopeKey),
    debit_cents: amountCents,
    credit_cents: 0,
  };
}

export function nilAuditEscrowCredit(scopeKey: string, amountCents: number): GlLegInput {
  return {
    account: nilAuditEscrowGlAccount(scopeKey),
    debit_cents: 0,
    credit_cents: amountCents,
  };
}

// Transfer portal clawback legs (PR 35): the pro-rated unearned advance
// hold of record — the athlete's clawback debt rises as a receivable
// asset (debit) against the advance-recovery income of record (credit).
// Balanced legs; no cash moves until the hold settles.
export function nilUnearnedClawbackReceivableDebit(
  athleteId: string,
  amountCents: number,
): GlLegInput {
  return {
    account: nilUnearnedClawbackReceivableGlAccount(athleteId),
    debit_cents: amountCents,
    credit_cents: 0,
  };
}

export function nilUnearnedClawbackRecoveryCredit(
  athleteId: string,
  amountCents: number,
): GlLegInput {
  return {
    account: nilUnearnedClawbackRecoveryGlAccount(athleteId),
    debit_cents: 0,
    credit_cents: amountCents,
  };
}

// Spatial audit escrow legs (PR 37): the per-scope SPATIAL_AUDIT_ESCROW
// obligation account — the escrow legs' mirror at (venue[, popup]) scope.
// A routed park-earnings distribution's reserve locks here against the
// holding account's debit; local entertainment sales taxes, safety
// compliance holdbacks, and quarterly park concession reconciliations
// debit it back to FBO cash; the verified release debits it into the
// beneficiary's payout legs — never the dust payee's account, never the
// unclaimed holding account, never the NIL escrow's account, never any
// other escrow's account.
export function spatialAuditEscrowDebit(scopeKey: string, amountCents: number): GlLegInput {
  return {
    account: spatialAuditEscrowGlAccount(scopeKey),
    debit_cents: amountCents,
    credit_cents: 0,
  };
}

export function spatialAuditEscrowCredit(scopeKey: string, amountCents: number): GlLegInput {
  return {
    account: spatialAuditEscrowGlAccount(scopeKey),
    debit_cents: 0,
    credit_cents: amountCents,
  };
}

// Spatial Minimum-Spatial-Guarantee shortfall legs (PR 37): the
// quarter's MSG shortfall debit of record — the operator's receivable
// rises as an asset (debit) against the shortfall penalty income of
// record (credit). Balanced legs; the invoice's face derives from the
// venue's reserved-footprint guarantee terms and the append-only spatial
// royalty truth, never a guessed amount.
export function spatialMsgReceivableDebit(scopeKey: string, amountCents: number): GlLegInput {
  return {
    account: spatialMsgReceivableGlAccount(scopeKey),
    debit_cents: amountCents,
    credit_cents: 0,
  };
}

export function spatialMsgShortfallIncomeCredit(
  scopeKey: string,
  amountCents: number,
): GlLegInput {
  return {
    account: spatialMsgShortfallIncomeGlAccount(scopeKey),
    debit_cents: 0,
    credit_cents: amountCents,
  };
}

// Fitness audit escrow legs (PR 39): the per-scope FITNESS_AUDIT_ESCROW
// obligation account — the escrow legs' mirror at (trainer, studio
// franchise) scope. A routed fitness IP payout's reserve locks here
// against the holding account's debit; member chargeback reserves, class
// return allowances, and quarterly sync music licensing audits debit it
// back to FBO cash; the verified release debits it into the trainer's
// payout legs — never the dust payee's account, never the unclaimed
// holding account, never any other escrow's account.
export function fitnessAuditEscrowDebit(scopeKey: string, amountCents: number): GlLegInput {
  return {
    account: fitnessAuditEscrowGlAccount(scopeKey),
    debit_cents: amountCents,
    credit_cents: 0,
  };
}

export function fitnessAuditEscrowCredit(scopeKey: string, amountCents: number): GlLegInput {
  return {
    account: fitnessAuditEscrowGlAccount(scopeKey),
    debit_cents: 0,
    credit_cents: amountCents,
  };
}

// CULINARY_AUDIT_ESCROW (PR 41) — the culinary mirror at (chef, ghost
// kitchen) scope. A routed culinary IP payout's reserve locks here
// against the holding account's debit; customer refund allowances, food
// spoilage chargebacks, and quarterly ingredient supplier quality audits
// debit it back to FBO cash; the verified release debits it into the
// chef's payout legs — never the dust payee's account, never the
// unclaimed holding account, never any other escrow's account.
export function culinaryAuditEscrowDebit(scopeKey: string, amountCents: number): GlLegInput {
  return {
    account: culinaryAuditEscrowGlAccount(scopeKey),
    debit_cents: amountCents,
    credit_cents: 0,
  };
}

export function culinaryAuditEscrowCredit(scopeKey: string, amountCents: number): GlLegInput {
  return {
    account: culinaryAuditEscrowGlAccount(scopeKey),
    debit_cents: 0,
    credit_cents: amountCents,
  };
}

// SERVICE_AUDIT_ESCROW (PR 43) — the services mirror at (stylist, salon
// location) scope. A routed franchise service payout's reserve locks here
// against the holding account's debit; client refund allowances, product
// return chargebacks, and quarterly backbar inventory audits debit it
// back to FBO cash; the verified release debits it into the stylist's
// payout legs — never the dust payee's account, never the unclaimed
// holding account, never any other escrow's account.
export function serviceAuditEscrowDebit(scopeKey: string, amountCents: number): GlLegInput {
  return {
    account: serviceAuditEscrowGlAccount(scopeKey),
    debit_cents: amountCents,
    credit_cents: 0,
  };
}

export function serviceAuditEscrowCredit(scopeKey: string, amountCents: number): GlLegInput {
  return {
    account: serviceAuditEscrowGlAccount(scopeKey),
    debit_cents: 0,
    credit_cents: amountCents,
  };
}

// SOFTWARE_AUDIT_ESCROW legs (PR 45, the founder software directive) — the
// service twin's shape over the software scope's own GL account. The route
// locks the founder-banded share with a credit leg, the drawdown and the
// release debit it back out; nothing else ever touches the account.
export function softwareAuditEscrowDebit(scopeKey: string, amountCents: number): GlLegInput {
  return {
    account: softwareAuditEscrowGlAccount(scopeKey),
    debit_cents: amountCents,
    credit_cents: 0,
  };
}

export function softwareAuditEscrowCredit(scopeKey: string, amountCents: number): GlLegInput {
  return {
    account: softwareAuditEscrowGlAccount(scopeKey),
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

