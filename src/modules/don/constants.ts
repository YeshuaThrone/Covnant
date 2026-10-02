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

// Gaming cashout pending (PR 13): a game platform's fiat payout batch
// locks in cashout-pending until Astra cross-references the payout batch
// against verified studio contracts and store statements and the batch's
// fiat settlement completes. The lock is PER-PLATFORM — the payee and GL
// account carry the platform the way the film escrow carries the film id —
// because the payout batches, the conversion logs, and the cross-reference
// are all per-platform program. Deliberately NOT 'platform', NOT the
// unclaimed holding sentinel, and NOT the film escrow prefix: gaming
// cashout is distinct from company dust, from every creator vault, from
// unallocated recon funds, and from film escrow, in payee, GL account, and
// ledger kind, so no query can fold one into another.
export const GAMING_CASHOUT_PAYEE_PREFIX = "gaming_cashout";
export function gamingCashoutPayeeId(platform: string): string {
  return `${GAMING_CASHOUT_PAYEE_PREFIX}:${platform}`;
}
export function gamingCashoutPayeeName(platform: string): string {
  return `Gaming Cashout Pending — ${platform}`;
}
export function gamingCashoutGlAccount(platform: string): string {
  return `gaming_cashout:${platform}`;
}

// Esports prize pool escrow (PR 14, founder livestream directive): a
// tournament's prize pool receipt locks in the waterfall's escrow until the
// release runs the sequential recoupment waterfall. The lock is PER-BATCH —
// the payee and GL account carry the prize pool batch id the way the film
// escrow carries the film id — because the waterfall steps, the roster
// split, and the cross-reference are all per-batch. Deliberately NOT
// 'platform', NOT the unclaimed holding sentinel, NOT the film escrow
// prefix, and NOT the gaming cashout prefix: prize pool escrow is distinct
// from company dust, from every creator vault, from unallocated recon
// funds, from film escrow, and from gaming cashout, in payee, GL account,
// and ledger kind, so no query can fold one into another.
export const ESPORTS_POOL_PAYEE_PREFIX = "esports_pool_escrow";
export function esportsPoolEscrowPayeeId(batch: string): string {
  return `${ESPORTS_POOL_PAYEE_PREFIX}:${batch}`;
}
export function esportsPoolEscrowPayeeName(batch: string): string {
  return `Esports Prize Pool Escrow — ${batch}`;
}
export function esportsPoolEscrowGlAccount(batch: string): string {
  return `esports_prize_pool_escrow:${batch}`;
}

// VTuber agency licensing holdback (PR 15, founder VTuber directive): a
// managed talent's income locks in the PER-AGENCY holdback until the
// verified release runs the agency deduction stack — management fee (the
// 20–40% band), 3D model rigging and avatar IP licensing holdbacks, tech
// setup amortization — before net income releases to the talent. The lock
// is PER-AGENCY — the payee and GL account carry the agency id the way the
// film escrow carries the film id — because the agency contract, the
// deduction stack, and the amortization schedules are all per-agency
// program. Deliberately NOT 'platform', NOT the unclaimed holding sentinel,
// NOT the film/gaming/esports prefixes: managed talent income is distinct
// from company dust, from every creator vault, from unallocated recon
// funds, and from every other escrow state, in payee, GL account, and
// ledger kind, so no query can fold one into another.
export const VTUBER_HOLDBACK_PAYEE_PREFIX = "vtuber_holdback";
export function vtuberHoldbackPayeeId(agencyId: string): string {
  return `${VTUBER_HOLDBACK_PAYEE_PREFIX}:${agencyId}`;
}
export function vtuberHoldbackPayeeName(agencyId: string): string {
  return `Avatar IP Licensing Holdback — ${agencyId}`;
}
export function vtuberHoldbackGlAccount(agencyId: string): string {
  return `avatar_ip_licensing_holdback:${agencyId}`;
}

// Webtoon studio split bands (PR 20, founder webtoon + serialized-publishing
// directive): the per-contract production split schedule's role groups, each
// a share of the POST-translation net. A registered schedule names whole
// basis points per group INSIDE its band — below the floor under-recovers
// the studio's own contribution terms, above the cap exceeds the mandate;
// the allocator refuses anything outside the band. The bands leave the
// primary author the residual (60-85% studio team, 15-40% author/IP holder).
export const WEBTOON_ORIGINAL_CREATOR_STORYWRITER_MIN_BPS = 3_000;
export const WEBTOON_ORIGINAL_CREATOR_STORYWRITER_MAX_BPS = 4_000;
export const WEBTOON_LINE_ARTIST_INKER_MIN_BPS = 2_000;
export const WEBTOON_LINE_ARTIST_INKER_MAX_BPS = 3_000;
export const WEBTOON_COLORIST_BACKGROUND_MIN_BPS = 1_000;
export const WEBTOON_COLORIST_BACKGROUND_MAX_BPS = 1_500;

// The studio role-group vocabulary — the three bands' keys. A schedule role
// outside the vocabulary is a hostile registration.
export const WEBTOON_STUDIO_ROLE_GROUPS = [
  "original_creator_storywriter",
  "line_artist_inker",
  "colorist_background",
] as const;
export type WebtoonStudioRoleGroup = (typeof WEBTOON_STUDIO_ROLE_GROUPS)[number];

// Translation/localization escrow (PR 20, founder directive): a foreign
// language feed's translation royalty locks in the PER-LANGUAGE escrow until
// localization costs fully amortize and the verified release runs the
// localization cascade — the localizer's royalty BEFORE the primary author's
// net. The lock is PER-SERIES-PER-LANGUAGE — the payee and GL account carry
// the series id and language code the way the VTuber holdback carries the
// agency id — because the localization contract, the cost amortization
// schedule, and the cascade ordering are all per-language-feed program.
// Deliberately NOT 'platform', NOT the unclaimed holding sentinel, NOT any
// prior escrow prefix: translation royalties are distinct from company dust,
// from every creator vault, from unallocated recon funds, and from every
// other escrow state, in payee, GL account, and ledger kind, so no query
// can fold one into another.
export const TRANSLATION_LOCALIZATION_PENDING_PAYEE_PREFIX =
  "translation_localization_pending";
export function translationLocalizationPayeeId(
  seriesId: string,
  languageCode: string,
): string {
  return `${TRANSLATION_LOCALIZATION_PENDING_PAYEE_PREFIX}:${seriesId}:${languageCode}`;
}
export function translationLocalizationPayeeName(
  seriesId: string,
  languageCode: string,
): string {
  return `Translation Localization Pending — ${seriesId} (${languageCode})`;
}
export function translationLocalizationGlAccount(
  seriesId: string,
  languageCode: string,
): string {
  return `translation_localization_pending:${seriesId}:${languageCode}`;
}

// The agency management fee band (PR 15): the founder directive caps the
// automated agency management deduction at 20–40% of the gross — below 20%
// under-recovers the agency program, above 40% exceeds the mandate; the
// allocator refuses anything outside the band. Whole basis points.
export const VTUBER_MANAGEMENT_FEE_MIN_BPS = 2_000;
export const VTUBER_MANAGEMENT_FEE_MAX_BPS = 4_000;

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
  // Gaming cashout pending (PR 13): a game platform's fiat payout batch
  // locks in cashout-pending (post), then the verified release — the
  // cross-reference against studio contracts and store statements complete,
  // the batch's fiat settlement confirmed — routes the net through the
  // clearance-gated creator-credit sequence. Additive only.
  "gaming_cashout_post",
  "gaming_cashout_release",
  // Esports prize pool escrow (PR 14): a tournament's prize pool receipt
  // locks in the waterfall's escrow (post), then the verified release runs
  // the sequential recoupment waterfall — contract-mandated expenses, the
  // org cut, the roster split — with any integer-cent dust swept to the
  // platform payee. Additive only.
  "esports_pool_escrow_post",
  "esports_pool_escrow_release",
  // VTuber agency licensing holdback (PR 15): a managed talent's income
  // locks in the per-agency holdback (post), then the verified release runs
  // the agency deduction stack — management fee, rigging and licensing
  // holdbacks, tech setup amortization — before net income releases to the
  // talent. Additive only.
  "vtuber_holdback_post",
  "vtuber_holdback_release",
  // Translation/localization escrow (PR 20): a foreign language feed's
  // translation royalty locks in the per-series-per-language escrow (post),
  // then the verified release runs the localization cascade — the
  // localization cost amortization line, the localizer's royalty, the studio
  // split bands — before net funds allocate to the primary author. Additive
  // only.
  "translation_localization_post",
  "translation_localization_release",
  // IP adaptation optioning (PR 21): a work's option fee posts to
  // UNCLAIMED_HOLDING through the canonical seam (no new post kind), then
  // the verified release runs the author-first option cascade — the
  // author's IP allocations reserved before the agency's commission (the
  // commission derives from the remainder only), the residual author's net
  // last. Additive only.
  "ip_option_release",
] as const;
export type JournalKind = (typeof JOURNAL_KINDS)[number];

export const VAULT_BUCKETS = ["available", "pending", "reserve"] as const;
export type VaultBucket = (typeof VAULT_BUCKETS)[number];

export function vaultGlAccount(payeeId: string, bucket: VaultBucket): string {
  return `vault:${payeeId}:${bucket}`;
}
