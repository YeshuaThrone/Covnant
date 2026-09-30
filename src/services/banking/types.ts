/**
 * Banking rails contracts — Stripe (funding IN), Lithic (ACH dispatch OUT +
 * card issuing), Plaid (bank authorization/verification).
 *
 * Founder canon (2026-09-30): "We build the API with Stripe and Lithic to
 * FUEL the Gold Board. The Gold Board is the financial ledger. Plaid is
 * available as well." These adapters are the rails; the Don ledger
 * (modules/ledger + the vault engine) is the Gold Board they move money
 * through — never around.
 *
 * Every adapter follows the repo's explicit not-configured error canon
 * (services/baas/sandboxRail.ts): when the rail's credentials are absent,
 * EVERY entry point returns the structured not-configured envelope —
 * { ok: false, status, code, message } — never a fake success and never a
 * thrown env error. With credentials present, calls go out over the
 * injected transport, so tests mock the wire and assert the exact request
 * shape each provider will receive.
 */

/** The failure envelope every rail entry point shares (sandboxRail canon). */
export type BankingFailure = {
  ok: false;
  status: number;
  code: string;
  message: string;
};

export type BankingSuccess<T> = { ok: true; value: T };

export type BankingResult<T> = BankingSuccess<T> | BankingFailure;

/**
 * The one wire seam every adapter calls through. The default wraps global
 * fetch (transport.ts); tests inject a spy and assert method, URL, headers,
 * and body — the exact bytes Stripe/Lithic/Plaid will receive.
 */
export type BankingTransport = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ status: number; body: string }>;

// --- Lithic: ACH dispatch (money OUT, settlement-time) + card issuing ---

/**
 * ACH dispatch request. `destination` is the Lithic EXTERNAL bank account
 * token (an account the operator tokenized through Lithic) — never a raw
 * routing/account number; full account numbers never enter this seam.
 */
export type LithicAchDispatchInput = {
  destination: string;
  amountCents: number;
  idempotencyKey: string;
  memo?: string;
};

export type LithicAchDispatchResult = {
  /** Lithic payment token. */
  transferId: string;
  status: string | null;
  raw: unknown;
};

/**
 * Virtual card issue request. Card issuing does not itself move Gold Board
 * money — card AUTHORIZATIONS move money, and those land through the
 * existing /api/banking card-authorization webhook path.
 */
export type LithicVirtualCardInput = {
  idempotencyKey: string;
  memo?: string;
  /** Optional spend limit in cents (Lithic spend_limit + monthly duration). */
  spendLimitCents?: number;
};

export type LithicVirtualCardResult = {
  cardToken: string;
  state: string | null;
  raw: unknown;
};

export interface LithicAdapter {
  dispatchAch(input: LithicAchDispatchInput): Promise<BankingResult<LithicAchDispatchResult>>;
  createVirtualCard(input: LithicVirtualCardInput): Promise<BankingResult<LithicVirtualCardResult>>;
}

// --- Stripe: funding charges (money IN to the Gold Board) ---

export type StripeFundingChargeInput = {
  payeeId: string;
  payeeName: string;
  amountCents: number;
  /** BCP-47 currency, lowercased; default "usd". */
  currency?: string;
  description?: string;
  idempotencyKey: string;
};

export type StripeFundingChargeResult = {
  paymentIntentId: string;
  clientSecret: string | null;
  status: string | null;
  raw: unknown;
};

export interface StripeAdapter {
  createFundingCharge(input: StripeFundingChargeInput): Promise<BankingResult<StripeFundingChargeResult>>;
}

// --- Plaid: Link token creation + bank account verification ---

export type PlaidLinkTokenInput = {
  /** The creator's payee id — Plaid's client_user_id. */
  userId: string;
  userName: string;
  /** Defaults to ["auth"] — bank authorization is the rail Covnant needs. */
  products?: string[];
};

export type PlaidLinkTokenResult = {
  linkToken: string;
  expiration: string | null;
  requestId: string | null;
};

export type PlaidBankAccountStatus = {
  accountId: string;
  name: string | null;
  officialName: string | null;
  /** e.g. "automatically_verified" — Plaid's verification vocabulary. */
  verificationStatus: string | null;
  /** Last-4 mask only. Full account numbers NEVER leave this adapter. */
  mask: string | null;
};

export type PlaidVerificationResult = {
  accounts: PlaidBankAccountStatus[];
};

export interface PlaidAdapter {
  createLinkToken(input: PlaidLinkTokenInput): Promise<BankingResult<PlaidLinkTokenResult>>;
  /**
   * Exchange the creator's own Link public_token, then read /auth/get for
   * verification state. The public_token is the caller's own Link
   * capability, so no store cross-reference is needed to scope it.
   */
  getBankAccountVerification(input: {
    publicToken: string;
  }): Promise<BankingResult<PlaidVerificationResult>>;
}
