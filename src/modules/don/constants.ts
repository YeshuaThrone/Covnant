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

// Merch returns reserve (PR 23, founder directive): 10–15% of every merch
// payout allocation holds in a MERCH_RETURNS_RESERVE per contract for the
// 30–60 day returns window — customer returns and chargebacks draw it down,
// and the verified release pays the remainder to creator net after the
// window. The lock is PER-SKU (per contract) — the payee and GL account
// carry the sku the way the film escrow carries the film id. Deliberately
// NOT 'platform', NOT the unclaimed holding sentinel, NOT any earlier
// escrow prefix: reserve money is distinct from company dust, from every
// creator vault, from unallocated recon funds, and from every other
// holding state, in payee, GL account, and ledger kind, so no query can
// fold one into another.
export const MERCH_RETURNS_RESERVE_PAYEE_PREFIX = "merch_returns_reserve";
export function merchReturnsReservePayeeId(skuId: string): string {
  return `${MERCH_RETURNS_RESERVE_PAYEE_PREFIX}:${skuId}`;
}
export function merchReturnsReservePayeeName(skuId: string): string {
  return `Merch Returns Reserve — ${skuId}`;
}
export function merchReturnsReserveGlAccount(skuId: string): string {
  return `merch_returns_reserve:${skuId}`;
}
// The founder's bands, enforced at registration AND at use: a holdback rate
// of 10–15% of the allocation and a returns window of 30–60 days. Anything
// outside a band is a hostile contract, refused.
export const MERCH_RETURNS_RESERVE_MIN_RATE_BPS = 1_000;
export const MERCH_RETURNS_RESERVE_MAX_RATE_BPS = 1_500;
export const MERCH_RETURNS_RESERVE_MIN_WINDOW_DAYS = 30;
export const MERCH_RETURNS_RESERVE_MAX_WINDOW_DAYS = 60;

// --- The book returns reserve (PR 27, the founder publishing directive) ---
//
// Physical print allocations of one ISBN hold a BOOK_RETURNS_RESERVE per
// contract for the returns window: the 15–20% the directive bands, held for
// 90–120 days, then released to the beneficiary of record. Sentinel payee +
// GL account per ISBN — the merch module's no-fold discipline; the reserve
// is its own escrow-shaped money, never folded into platform dust.
export const BOOK_RETURNS_RESERVE_PAYEE_PREFIX = "book_returns_reserve";
export function bookReturnsReservePayeeId(isbn: string): string {
  return `${BOOK_RETURNS_RESERVE_PAYEE_PREFIX}:${isbn}`;
}
export function bookReturnsReservePayeeName(isbn: string): string {
  return `Book Returns Reserve — ${isbn}`;
}
export function bookReturnsReserveGlAccount(isbn: string): string {
  return `book_returns_reserve:${isbn}`;
}
// The founder's book bands, enforced at registration AND at use: a holdback
// rate of 15–20% of the allocation and a returns window of 90–120 days.
// Anything outside a band is a hostile contract, refused.
export const BOOK_RETURNS_RESERVE_MIN_RATE_BPS = 1_500;
export const BOOK_RETURNS_RESERVE_MAX_RATE_BPS = 2_000;
export const BOOK_RETURNS_RESERVE_MIN_WINDOW_DAYS = 90;
export const BOOK_RETURNS_RESERVE_MAX_WINDOW_DAYS = 120;

// The venue hall fee band (PR 31, the founder touring directive): the
// venue's cut of TOUR MERCHANDISE sales — 15–25% of the gross merch sales
// at the venue — deducted from the gross BEFORE the artist's apparel net
// releases. Whole basis points; anything outside the band is a hostile
// contract, refused (the merch/book reserve band discipline).
export const VENUE_HALL_FEE_MIN_BPS = 1_500;
export const VENUE_HALL_FEE_MAX_BPS = 2_500;

// Promoter box office settlement escrow (PR 31, the founder touring/comedy
// directive): a stop's box office net locks in the settlement escrow until
// the FINAL NIGHT-OF-SHOW audit closes — the venue's box office statement
// audited, the close of record verified — and the verified release pays the
// stop's designated payouts. The lock is PER-STOP — the payee and GL account
// carry the (production, venue, show date) scope the way the film escrow
// carries the film id — because the deal terms, the settlement sheet, and
// the audit close are all per-stop. Deliberately NOT 'platform', NOT the
// unclaimed holding sentinel, NOT any prior escrow prefix: held box office
// nets are distinct from company dust, from every creator vault, from
// unallocated recon funds, and from every other escrow state, in payee, GL
// account, and ledger kind, so no query can fold one into another.
export const PROMOTER_SETTLEMENT_PAYEE_PREFIX = "promoter_settlement";
export function promoterSettlementScope(
  productionId: string,
  venueId: string,
  showDate: string,
): string {
  return `${productionId}:${venueId}:${showDate}`;
}
export function promoterSettlementPayeeId(
  productionId: string,
  venueId: string,
  showDate: string,
): string {
  return `${PROMOTER_SETTLEMENT_PAYEE_PREFIX}:${promoterSettlementScope(productionId, venueId, showDate)}`;
}
export function promoterSettlementPayeeName(
  productionId: string,
  venueId: string,
  showDate: string,
): string {
  return `Promoter Box Office Settlement Pending — ${productionId} @ ${venueId} ${showDate}`;
}
export function promoterSettlementGlAccount(
  productionId: string,
  venueId: string,
  showDate: string,
): string {
  return `promoter_box_office_settlement_pending:${promoterSettlementScope(productionId, venueId, showDate)}`;
}

// Live comedy recording audio rights (PR 31): a comedy special's AUDIO
// royalties — SiriusXM satellite radio and Spotify streaming — post under
// their OWN rights stream, isolated in payee, GL account, and ledger kind
// from the physical live ticket sales streams (the theatrical lane's
// settlement money). Audio money is licensed-recording money; ticket money
// is box office money; no query can fold one into another and no posting
// may route one through the other's stream.
export const COMEDY_AUDIO_RIGHTS_PAYEE_PREFIX = "comedy_audio_rights";
export function comedyAudioRightsPayeeId(specialId: string): string {
  return `${COMEDY_AUDIO_RIGHTS_PAYEE_PREFIX}:${specialId}`;
}
export function comedyAudioRightsPayeeName(specialId: string): string {
  return `Comedy Special Audio Rights — ${specialId}`;
}
export function comedyAudioRightsGlAccount(specialId: string): string {
  return `comedy_audio_rights:${specialId}`;
}
// The two audio senders the directive names — distinct from every
// theatrical box office sender (axs, ticketmaster, eventbrite, venuepos).
export const COMEDY_AUDIO_SENDERS = ["siriusxm", "spotify"] as const;
export type ComedyAudioSenderCode = (typeof COMEDY_AUDIO_SENDERS)[number];
export function isComedyAudioSenderCode(value: string): value is ComedyAudioSenderCode {
  return (COMEDY_AUDIO_SENDERS as readonly string[]).includes(value);
}

// --- The audit reserve escrow (PR 33, the founder licensing-audit directive) ---
//
// 5–10% of a licensing royalty credit holds in an AUDIT_RESERVE_ESCROW per
// license scope while the contract's retail-audit exposure runs: quarterly
// retail audit reconciliations and inventory write-offs draw it down, and
// the verified reconciliation of record opens the release. Sentinel payee +
// GL account per scope key — the merch/book reserve no-fold discipline; the
// reserve is its own escrow-shaped money, never folded into platform dust,
// unclaimed holding, or any other escrow state.
export const AUDIT_RESERVE_ESCROW_PAYEE_PREFIX = "audit_reserve_escrow";
export function auditReserveEscrowPayeeId(scopeKey: string): string {
  return `${AUDIT_RESERVE_ESCROW_PAYEE_PREFIX}:${scopeKey}`;
}
export function auditReserveEscrowPayeeName(scopeKey: string): string {
  return `Audit Reserve Escrow — ${scopeKey}`;
}
export function auditReserveEscrowGlAccount(scopeKey: string): string {
  return `audit_reserve_escrow:${scopeKey}`;
}
// The founder's band, enforced at registration AND at use: a 5–10% reserve
// rate of the licensing royalty credit. Anything outside the band is a
// hostile contract, refused.
export const LICENSING_AUDIT_RESERVE_MIN_RATE_BPS = 500;
export const LICENSING_AUDIT_RESERVE_MAX_RATE_BPS = 1_000;

// The minimum-guarantee shortfall invoice (PR 33): the licensee's annual MG
// shortfall debits as the receivable of record at contract term close. The
// GL pair per scope — the receivable asset rises (debit) and the shortfall
// penalty income of record rises (credit); balanced legs, no cash movement
// until the invoice settles.
export function licensingMgReceivableGlAccount(scopeKey: string): string {
  return `licensing_mg_receivable:${scopeKey}`;
}
export function licensingMgShortfallIncomeGlAccount(scopeKey: string): string {
  return `licensing_mg_shortfall_income:${scopeKey}`;
}

// --- The NIL audit escrow (PR 35, the founder NIL directive) ---
//
// The athlete-side twin of the licensing audit reserve: 5–10% of an
// athletic department distribution (a NIL pool or media-rights credit)
// holds in an NIL_AUDIT_ESCROW per (payee, school) scope while the
// athlete's compliance exposure runs. Mid-season NCAA Transfer Portal
// reconciliations and tax withholdings draw it down, and the verified
// reconciliation of record opens the release. Sentinel payee + GL account
// per scope key — the same no-fold discipline: the escrow is its own
// escrow-shaped money, never folded into platform dust, unclaimed
// holding, or any other escrow state.
export const NIL_AUDIT_ESCROW_PAYEE_PREFIX = "nil_audit_escrow";
export function nilAuditEscrowPayeeId(scopeKey: string): string {
  return `${NIL_AUDIT_ESCROW_PAYEE_PREFIX}:${scopeKey}`;
}
export function nilAuditEscrowPayeeName(scopeKey: string): string {
  return `NIL Audit Escrow — ${scopeKey}`;
}
export function nilAuditEscrowGlAccount(scopeKey: string): string {
  return `nil_audit_escrow:${scopeKey}`;
}
// The founder's band, enforced at registration AND at use: a 5–10% share
// of the athletic department distribution. Anything outside the band is a
// hostile policy, refused.
export const NIL_AUDIT_ESCROW_MIN_RATE_BPS = 500;
export const NIL_AUDIT_ESCROW_MAX_RATE_BPS = 1_000;

// The transfer portal clawback (PR 35): an athlete entering the portal
// prior to contract completion owes back the pro-rated unearned NIL
// advance — the debit hold of record. The GL pair per athlete — the
// receivable asset rises (debit) and the advance-recovery income of
// record rises (credit); balanced legs, no cash movement until the hold
// settles.
export function nilUnearnedClawbackReceivableGlAccount(athleteId: string): string {
  return `nil_unearned_clawback_receivable:${athleteId}`;
}
export function nilUnearnedClawbackRecoveryGlAccount(athleteId: string): string {
  return `nil_unearned_clawback_recovery:${athleteId}`;
}

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
  // The merch COGS + collaboration waterfall (PR 22): a held merch
  // settlement released through the founder-ordered waterfall — the FIFO
  // production-debt amortization and the two overhead recoupment pools to
  // the manufacturing party FIRST, then the contracted artist/brand
  // split. Credits in the journal move through the payout gate; every
  // leg lands through the canonical posting seam with the destination
  // fail-closed.
  "merch_collab_release",
  // Merch returns reserve + fulfillment confirmation (PR 23): a merch
  // payout allocation's dispatch splits the held settlement — the
  // non-reserve portion routes to the beneficiary of record's creator net
  // ONLY through the tracking-derived fulfillment gate, the 10–15% reserve
  // locks into the per-sku returns reserve. Returns and chargebacks draw
  // the reserve down (the money goes back to the customer); after the
  // 30–60 day window the verified release pays the remainder to creator
  // net. Additive only.
  "merch_reserve_dispatch",
  "merch_reserve_drawdown",
  "merch_returns_reserve_release",
  // The foreign tax hold (PR 27, the founder publishing directive): a
  // FOREIGN print royalty's unclaimed-holding leg posts STRAIGHT INTO the
  // FOREIGN_TAX_HOLD freeze — same legs as unclaimed_holding_post (FBO
  // debit, unclaimed-holding credit), distinct kind for the audit trail.
  // The verified withholding-tax-credit release THAWS the legs back to the
  // holding state (a status CAS sweep, no journal — the reversal of the
  // freeze is not money moving; the PR 25 dispute thaw precedent).
  // Additive only.
  "foreign_tax_hold_post",
  // The book returns reserve (PR 27): a physical print allocation's
  // dispatch splits the held credit — the 15–20% reserve locks into the
  // per-ISBN returns reserve, the remainder re-parks in unclaimed holding
  // until the publishing payout gate clears (the author payout releases
  // THEN, offset first). Returns and chargebacks draw the reserve down
  // (the money goes back to the publisher); after the 90–120 day window
  // the verified release pays the remaining reserve to the beneficiary of
  // record through the taxed cascade. Additive only.
  "book_reserve_dispatch",
  "book_reserve_drawdown",
  "book_returns_reserve_release",
  // The book print author payout (PR 27): the re-parked net-of-reserve
  // holding releases through the fail-closed publishing gate, the
  // outstanding chargeback offsets consume their recovery FIRST (the
  // offset's credits go back to FBO), and the post-offset remainder routes
  // through the same taxed cascade every payout rides. Additive only.
  "book_print_net_release",
  // Promoter box office settlement escrow (PR 31): a stop's box office net
  // locks in the per-stop settlement escrow (post), then the verified
  // release — the FINAL NIGHT-OF-SHOW audit closed of record, the theater
  // payout gate's states cleared/reconciled — routes the stop's designated
  // payouts through the taxed cascade. Additive only.
  "promoter_settlement_post",
  "promoter_settlement_release",
  // Live comedy recording audio rights (PR 31): a comedy special's audio
  // royalties (SiriusXM, Spotify) post into their OWN rights stream under
  // the audio payee/GL space — the same FBO-debit/holding-credit legs the
  // holding post rides, with the DISTINCT kind as the audit trail that the
  // money is licensed-recording money and never ticket-sales money.
  // Additive only.
  "comedy_audio_rights_post",
  // Audit reserve escrow (PR 33): a licensing royalty credit's release
  // splits the held settlement — the 5–10% reserve locks into the
  // per-scope audit reserve (post), quarterly retail audit reconciliations
  // and inventory write-offs draw it down (drawdown), and the verified
  // reconciliation of record opens the release that pays the remaining
  // reserve to the licensor of record through the taxed cascade
  // (release). Additive only.
  "licensing_audit_reserve_route",
  "licensing_audit_reserve_drawdown",
  "licensing_audit_reserve_release",
  // Minimum-guarantee shortfall invoice (PR 33): a licensee's annual MG
  // shortfall at contract term close debits as the invoice of record —
  // the receivable asset rises and the shortfall penalty income of record
  // rises, balanced legs priced from the append-only recoupment truth.
  // Additive only.
  "licensing_mg_shortfall_invoice",
  // NIL audit escrow (PR 35): an athletic department distribution's
  // release splits the held credit — the 5–10% NIL reserve locks into the
  // per-scope escrow (route), mid-season NCAA Transfer Portal
  // reconciliations and tax withholdings draw it down (drawdown), and the
  // verified reconciliation of record opens the release that pays the
  // remaining escrow through the taxed cascade (release). The transfer
  // portal clawback hold posts its own balanced legs — the pro-rated
  // unearned advance debits as the receivable of record and the
  // advance-recovery income rises (clawback hold). Additive only.
  "nil_audit_escrow_route",
  "nil_audit_escrow_drawdown",
  "nil_audit_escrow_release",
  "nil_unearned_clawback_hold",
  // Spatial audit escrow (PR 37, the founder spatial directive): a
  // venue's held unclaimed-holding credit routes through the spatial
  // payout gate — the 5–12% SPATIAL_AUDIT_ESCROW locks into the
  // per-scope escrow (route), local entertainment sales taxes, safety
  // compliance holdbacks, and quarterly park concession reconciliations
  // draw it down (drawdown), and the verified reconciliation of record
  // opens the release that pays the remaining escrow through the taxed
  // cascade (release). A pop-up scope's release is additionally gated on
  // its post-event inventory write-off and site restoration reserve of
  // record. The quarterly Minimum Spatial Guarantee shortfall invoice
  // posts its own balanced legs — the operator's receivable of record
  // rises and the shortfall penalty income rises, priced from the
  // venue's reserved footprint and the append-only spatial royalty
  // truth. Additive only.
  "spatial_audit_escrow_route",
  "spatial_audit_escrow_drawdown",
  "spatial_audit_escrow_release",
  "spatial_msg_shortfall_invoice",
  // Fitness audit escrow (PR 39, the founder fitness directive): a
  // fitness IP payout's release splits the held credit — the 5–10%
  // FITNESS_AUDIT_ESCROW locks into the per-scope escrow (route), member
  // chargeback reserves, class return allowances, and quarterly sync
  // music licensing audits draw it down (drawdown), and the verified
  // reconciliation of record opens the release that pays the remaining
  // escrow through the taxed cascade (release). Additive only.
  "fitness_audit_escrow_route",
  "fitness_audit_escrow_drawdown",
  "fitness_audit_escrow_release",
  // Culinary audit escrow (PR 41, the founder culinary directive): a
  // culinary IP payout's release splits the held credit — the 5–10%
  // CULINARY_AUDIT_ESCROW locks into the per-(chef, ghost kitchen) scope
  // escrow (route), customer refund allowances, food spoilage
  // chargebacks, and quarterly ingredient supplier quality audits draw it
  // down (drawdown), and the verified reconciliation of record opens the
  // release that pays the remaining escrow through the taxed cascade
  // (release). A pop-up scope's release is additionally gated on its
  // post-campaign packaging write-off of record. Additive only.
  "culinary_audit_escrow_route",
  "culinary_audit_escrow_drawdown",
  "culinary_audit_escrow_release",
] as const;
export type JournalKind = (typeof JOURNAL_KINDS)[number];

// SPATIAL_AUDIT_ESCROW (PR 37, the founder spatial directive): the
// founder-banded 5–12% of a park venue's earnings held per scope while
// the scope's local exposure runs. Per-scope — the payee and GL account
// carry the scope key the way vault accounts carry the payee id and the
// film escrow carries the film id. A park scope is `venue:{venueId}`; a
// temporary pop-up's scope is `venue:{venueId}:popup:{popupRef}`. Both
// scopes draw down for local entertainment sales taxes, safety
// compliance holdbacks, and quarterly park concession reconciliations;
// the verified reconciliation of record opens the release (fail-closed),
// and a pop-up scope's release additionally requires its post-event
// inventory write-off and site restoration reserve of record.
// Deliberately NOT 'platform', NOT the unclaimed holding sentinel, and
// NOT the NIL audit escrow's sentinel: spatial escrow is distinct from
// company dust, from unallocated recon funds, and from the NIL escrow in
// payee, GL account, and ledger kind, so no query can fold one into
// another.
export const SPATIAL_AUDIT_ESCROW_PAYEE_PREFIX = "spatial_audit_escrow";
export function spatialAuditEscrowPayeeId(scopeKey: string): string {
  return `${SPATIAL_AUDIT_ESCROW_PAYEE_PREFIX}:${scopeKey}`;
}
export function spatialAuditEscrowPayeeName(scopeKey: string): string {
  return `SPATIAL_AUDIT_ESCROW — ${scopeKey}`;
}
export const GL_ACCOUNT_SPATIAL_AUDIT_ESCROW = "spatial_audit_escrow";
export function spatialAuditEscrowGlAccount(scopeKey: string): string {
  return `${GL_ACCOUNT_SPATIAL_AUDIT_ESCROW}:${scopeKey}`;
}
// The founder band: a scope's escrow policy of record must price between
// 5% and 12% of park earnings inclusive — below the band under-reserves
// the scope's exposure, above it confiscates earnings, so the band is a
// constructor argument to every routing, never a suggestion.
export const SPATIAL_AUDIT_ESCROW_MIN_RATE_BPS = 500;
export const SPATIAL_AUDIT_ESCROW_MAX_RATE_BPS = 1_200;
// The drawdown classes of record — the three exposures the directive
// names. Position-locked against the escrow bucket's balance of record;
// anything else is refused at the vocabulary (no unpriced drawdown
// shape).
export const SPATIAL_AUDIT_ESCROW_DRAWDOWN_CLASSES = [
  "entertainment_sales_tax",
  "safety_compliance_holdback",
  "concession_reconciliation",
] as const;
export type SpatialAuditEscrowDrawdownClass =
  (typeof SPATIAL_AUDIT_ESCROW_DRAWDOWN_CLASSES)[number];

// Minimum Spatial Guarantee GL pair (PR 37): a quarterly MSG shortfall
// debits the operator's receivable of record and credits the shortfall
// penalty income of record — balanced legs priced from the venue's
// reserved-footprint guarantee terms and the append-only spatial royalty
// truth. Per operator × venue scope, the way the NIL clawback's pair is
// per athlete: no query can fold one operator's guarantee into another's.
export const GL_ACCOUNT_SPATIAL_MSG_RECEIVABLE = "spatial_msg_receivable";
export function spatialMsgReceivableGlAccount(scopeKey: string): string {
  return `${GL_ACCOUNT_SPATIAL_MSG_RECEIVABLE}:${scopeKey}`;
}
export const GL_ACCOUNT_SPATIAL_MSG_SHORTFALL_INCOME =
  "spatial_msg_shortfall_income";
export function spatialMsgShortfallIncomeGlAccount(scopeKey: string): string {
  return `${GL_ACCOUNT_SPATIAL_MSG_SHORTFALL_INCOME}:${scopeKey}`;
}

// FITNESS_AUDIT_ESCROW (PR 39, the founder fitness directive): the
// fitness-side twin of the NIL and spatial audit escrows — 5–10% of a
// fitness IP payout locks per (trainer, studio franchise) scope while the
// payout's exposure runs: member chargeback reserves, class return
// allowances, and quarterly sync music licensing audits draw it down, and
// the verified reconciliation of record opens the release. Sentinel payee
// + GL account per scope key — the no-fold discipline: the escrow is its
// own escrow-shaped money, never folded into platform dust, unclaimed
// holding, or any other escrow state.
export const FITNESS_AUDIT_ESCROW_PAYEE_PREFIX = "fitness_audit_escrow";
export function fitnessAuditEscrowPayeeId(scopeKey: string): string {
  return `${FITNESS_AUDIT_ESCROW_PAYEE_PREFIX}:${scopeKey}`;
}
export function fitnessAuditEscrowPayeeName(scopeKey: string): string {
  return `FITNESS_AUDIT_ESCROW — ${scopeKey}`;
}
export const GL_ACCOUNT_FITNESS_AUDIT_ESCROW = "fitness_audit_escrow";
export function fitnessAuditEscrowGlAccount(scopeKey: string): string {
  return `${GL_ACCOUNT_FITNESS_AUDIT_ESCROW}:${scopeKey}`;
}
// The founder band, enforced at registration AND at use: a 5–10% share of
// the fitness IP payout. Anything outside the band is a hostile policy,
// refused.
export const FITNESS_AUDIT_ESCROW_MIN_RATE_BPS = 500;
export const FITNESS_AUDIT_ESCROW_MAX_RATE_BPS = 1_000;

// CULINARY_AUDIT_ESCROW (PR 41, the founder culinary directive): the
// culinary twin of the NIL, spatial, and fitness audit escrows — 5–10% of
// a culinary IP payout locks per (chef, ghost kitchen) scope while the
// payout's exposure runs: customer refund allowances, food spoilage
// chargebacks, and quarterly ingredient supplier quality audits draw it
// down, and the verified reconciliation of record opens the release (a
// pop-up scope also needs its post-campaign packaging write-off of
// record). Sentinel payee + GL account per scope key — the no-fold
// discipline: the escrow is its own escrow-shaped money, never folded
// into platform dust, unclaimed holding, or any other escrow state.
export const CULINARY_AUDIT_ESCROW_PAYEE_PREFIX = "culinary_audit_escrow";
export function culinaryAuditEscrowPayeeId(scopeKey: string): string {
  return `${CULINARY_AUDIT_ESCROW_PAYEE_PREFIX}:${scopeKey}`;
}
export function culinaryAuditEscrowPayeeName(scopeKey: string): string {
  return `CULINARY_AUDIT_ESCROW — ${scopeKey}`;
}
export const GL_ACCOUNT_CULINARY_AUDIT_ESCROW = "culinary_audit_escrow";
export function culinaryAuditEscrowGlAccount(scopeKey: string): string {
  return `${GL_ACCOUNT_CULINARY_AUDIT_ESCROW}:${scopeKey}`;
}
// The founder band, enforced at registration AND at use: a 5–10% share of
// the culinary IP payout. Anything outside the band is a hostile policy,
// refused.
export const CULINARY_AUDIT_ESCROW_MIN_RATE_BPS = 500;
export const CULINARY_AUDIT_ESCROW_MAX_RATE_BPS = 1_000;

export const VAULT_BUCKETS = ["available", "pending", "reserve"] as const;
export type VaultBucket = (typeof VAULT_BUCKETS)[number];

export function vaultGlAccount(payeeId: string, bucket: VaultBucket): string {
  return `vault:${payeeId}:${bucket}`;
}
