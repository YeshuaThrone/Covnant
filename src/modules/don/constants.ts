export const BPS_DENOMINATOR = 10_000;
export const COMPANY_VARIANCE_PAYEE_ID = "platform";
export const COMPANY_VARIANCE_PAYEE_NAME = "Don Engine Variance";
// Unclaimed royalty holding (PR 7): the sentinel payee held credits carry.
// Deliberately NOT 'platform' — holding funds are distinct from company dust
// (payee 'platform') and from every creator's vault, in payee, GL account,
// and ledger kind, so no query can fold one into another.
export const UNCLAIMED_HOLDING_PAYEE_ID = "unclaimed";
export const UNCLAIMED_HOLDING_PAYEE_NAME = "Unclaimed Royalty Holding";
export const GL_ACCOUNT_UNCLAIMED_HOLDING = "unclaimed_holding";

// Film waterfall escrow (PR 9): a film distributor's receipt locks in
// escrow until the statement lines are cross-referenced against the signed
// deal memo and CAMA agreement. The escrow is PER-FILM — the payee and GL
// account carry the film id the way vault accounts carry the payee id —
// because the waterfall, the deal, and the gross-receipts accumulation are
// all per-film. Deliberately NOT 'platform' and NOT the unclaimed holding
// sentinel: film escrow is distinct from company dust, from every creator
// vault, and from unallocated recon funds, in payee, GL account, and ledger
// kind, so no query can fold one into another.
export const FILM_ESCROW_PAYEE_PREFIX = "film_escrow";
export function filmEscrowPayeeId(filmId: string): string {
  return `${FILM_ESCROW_PAYEE_PREFIX}:${filmId}`;
}
export function filmEscrowPayeeName(filmId: string): string {
  return `Film Waterfall Escrow — ${filmId}`;
}
export function filmEscrowGlAccount(filmId: string): string {
  return `film_waterfall_escrow:${filmId}`;
}

// The film waterfall's tier accounts (PR 9 ledger states; the sequential
// cascade allocator itself is the film waterfall engine). Tiers 0 through 4
// each get a plain account; tier 5 — the net profit pool — is locked 50/50:
// the producer half funds backend talent net points, and NEVER the investor
// half and never gross. Floor on the producer side so net points can never
// draw a cent more than half.
export const TIER_5_PRODUCER_POOL_BPS = 5_000;
export const TIER_5_INVESTOR_POOL_BPS = 5_000;
export function waterfallTierGlAccount(filmId: string, tierLevel: number): string {
  return `waterfall:${filmId}:tier:${tierLevel}`;
}
export function tier5ProducerPoolGlAccount(filmId: string): string {
  return `waterfall:${filmId}:tier:5:producer_pool`;
}
export function tier5InvestorPoolGlAccount(filmId: string): string {
  return `waterfall:${filmId}:tier:5:investor_pool`;
}

export const BACKUP_WITHHOLDING_BPS = 2_400;
export const FORM_1099_THRESHOLD_CENTS = 60_000;
export const PLAID_TOKEN_ENC_PREFIX = "enc:v1:";
export const DEFAULT_RECOUPMENT_BPS = 10_000;

export const BAAS_WEBHOOK_EVENTS = [
  "payout.settled",
  "payout.returned",
  "payout.failed",
] as const;
export type BaasWebhookEvent = (typeof BAAS_WEBHOOK_EVENTS)[number];

export const DSP_WEBHOOK_EVENTS = [
  "royalty.report",
  "royalty.adjusted",
  "royalty.reversed",
] as const;
export type DspWebhookEvent = (typeof DSP_WEBHOOK_EVENTS)[number];

export const GL_ACCOUNT_FBO_CASH = "fbo_cash";
export const GL_GENESIS_HASH = "don-engine/gl/genesis";
export const GL_RECOUPMENT_ACCOUNT = "recoupment_ledger";

export const JOURNAL_KINDS = [
  "royalty_ingest",
  "pending_release",
  "payout_hold",
  "payout_settled",
  "payout_failed_reversal",
  "dispute_lock",
  "dispute_unlock",
  "royalty_reversal",
  // Banking rails funding (PR 4): money arrives from Stripe into the Gold
  // Board — the inbound mirror of payout_settled. Additive only.
  "funding_received",
  // Unclaimed royalty holding (PR 7): recon-identified unallocated funds
  // park in holding (post), then release to verified creator balances
  // through the clearance-gated settlement path (release). Additive only.
  "unclaimed_holding_post",
  "unclaimed_holding_release",
  // Film waterfall escrow (PR 9): a film distributor's receipt locks in
  // escrow (post), then the cross-reference-verified release routes it into
  // the waterfall — First Dollar Gross participant points off the top, then
  // the tier legs (tier 5 split into the locked producer/investor pools).
  // Net points post separately against the producer pool. Additive only.
  "film_escrow_post",
  "film_escrow_release",
  "film_net_points",
] as const;
export type JournalKind = (typeof JOURNAL_KINDS)[number];

export const VAULT_BUCKETS = ["available", "pending", "reserve"] as const;
export type VaultBucket = (typeof VAULT_BUCKETS)[number];

export function vaultGlAccount(payeeId: string, bucket: VaultBucket): string {
  return `vault:${payeeId}:${bucket}`;
}
