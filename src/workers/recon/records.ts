/**
 * CVT recon worker — parsed statement vocabulary.
 *
 * The worker's deterministic lane turns raw statement bytes into normalized
 * lines, writes them into the existing match_queue (the parsed line-item
 * store, spec art_7M0snhxc), cross-references cbt_assets.mapped_identifiers,
 * and completes the job with the spec's result summary. This module holds
 * the worker's own typed vocabulary — the Store seam types stay in
 * @/modules/* (records are the rows).
 *
 * Money follows the house fixed-point discipline: 1e-8 micros as bigint in
 * memory, exact decimal text on the row — never a float
 * (covnant-sdk/src/parsers/money.ts is the singular converter).
 */

import type {
  MatchQueueAdPlacementType,
  MatchQueueAdSlot,
  MatchQueueRevenueBasis,
  MatchQueueRevenueChannel,
  MatchQueueRightsType,
  MatchQueueSaleType,
  MatchQueueStatementSourceType,
  MatchQueueStreamPlatform,
  RightsPipeline,
} from "@/modules/sdk/records";

// The worker lanes on the SDK's four-pipeline vocabulary verbatim — one
// definition, no worker-local shadow.
export type { RightsPipeline };

/** The strict statement profiles the deterministic lane parses. */
export type StatementProfileKind =
  | "distrokid_csv"
  | "tunecore_tsv"
  | "pro_publishing_csv"
  | "film_vod_csv"
  | "film_svod_csv"
  | "film_theatrical_box_office_csv"
  | "film_international_sales_agent_csv"
  | "podcast_dai_log_csv"
  | "podcast_rss_report_csv"
  | "epic_games_sales_csv"
  | "unity_asset_store_payout_csv"
  | "roblox_devex_csv"
  | "steamworks_sales_csv"
  | "apple_vision_pro_payments_csv"
  | "twitch_livestream_payouts_csv"
  | "youtube_live_livestream_payouts_csv"
  | "kick_livestream_payouts_csv"
  | "tiktok_live_livestream_payouts_csv"
  | "streamlabs_streamelements_alerts_csv"
  | "esports_tournament_prize_pool_csv"
  | "webtoon_coin_payout_csv"
  | "webtoon_reader_log_csv"
  | "kenp_page_read_pool_csv";

/**
 * Identifier kinds the worker emits — every one is a vault lookup kind
 * (src/lib/covnant/vault.ts VAULT_EXTERNAL_IDENTIFIER_KINDS), so a parsed
 * identifier can always be cross-referenced against cbt_assets.
 */
export type ReconIdentifierKind = "ISRC" | "ISWC" | "UPC" | "EIDR" | "DOI";

export type ReconIdentifiers = Partial<Record<ReconIdentifierKind, string>>;

/** Guilds with versioned residual rate tables (film waterfall directive). */
export type GuildResidualGuild = "SAG_AFTRA" | "WGA" | "DGA";

/**
 * Provenance tag riding a calculated guild residual hold — the calculation
 * is reproducible from the tag alone (rate table version, effective date,
 * basis, rate). Never a silently skipped obligation.
 */
export interface GuildResidualTag {
  guild: GuildResidualGuild;
  rate_table_version: string;
  effective_from: string;
  rate_bps: number;
  /** Residual basis: the statement line's gross, in 1e-8 micros as text. */
  base_micros: string;
  obligation_micros: string;
}

/**
 * The podcast lane's per-line context (PR 10, founder podcast directive +
 * multi-feed directive patch). Null on every non-podcast line — the field's
 * PRESENCE is the lane discriminator, so the worker never guesses a line's
 * vertical from its profile name alone. All identity fields needed for IAB
 * v2/v3 qualification ride the line: the bot filter needs the user agent,
 * the 24-hour single-IP dedup needs listener ip + feed + episode, and the
 * 60-second audio threshold needs the request's audio seconds.
 */
export interface PodcastLineDetail {
  /** The audio feed the line maps to — the deduplication scope unit. */
  readonly rssFeedId: string;
  /** The episode's feed-level GUID. */
  readonly episodeId: string;
  /** The ad creative (or sponsor campaign) the line reports — required on
   * impression-bearing lines: the cross-feed fingerprint discriminates
   * distinct ad units within one qualified download. Null on subscription. */
  readonly adCreativeId: string | null;
  /** Normalized listener IP (the IAB dedup key component); required on
   * impression-bearing lines, null on subscription lines. */
  readonly listenerIp: string | null;
  /** Raw user agent (bot filtering); null on subscription lines. */
  readonly userAgent: string | null;
  /** ISO 8601 audio/ad request timestamp — the dedup window's input. */
  readonly requestedAt: Date;
  /** The revenue lane this line earned in — Channel A/B/C tagging. */
  readonly revenueChannel: MatchQueueRevenueChannel;
  /** Pod position for ad lines; null for subscription lines. */
  readonly adSlot: MatchQueueAdSlot | null;
  /** Delivery method — independent of the revenue lane (host-read copy can
   * be served through DAI insertion); required on ad lines, null on
   * subscription lines. */
  readonly adPlacementType: MatchQueueAdPlacementType | null;
  /** Network-sold inventory flag; required on DAI lines (the commission's
   * trigger), null when not applicable. */
  readonly networkSold: boolean | null;
  /** Host-read sponsor verification — revenue recognizes only on true;
   * false parks the line in the podcast-held quarantine id space. */
  readonly sponsorVerified: boolean | null;
  /** The audio request's seconds — the 60-second threshold's input;
   * required on impression-bearing lines, null on subscription lines. */
  readonly audioSeconds: number | null;
  /** CPM as exact 1e-8 micros — required on DAI programmatic lines. */
  readonly cpmMicros: bigint | null;
  /** The line's ad impression count (per-request logs report 1). */
  readonly impressions: number | null;
  /** Network commission as whole basis points — validated into the
   * 2000-4000 contract band at parse time on network-sold inventory. */
  readonly commissionBps: number | null;
}

/**
 * The livestream lane's per-line revenue kind (PR 14, founder livestream
 * directive) — what the row reports, driving the conversion/split math:
 *
 *   bits          — Twitch Bits (virtual count + the net rate recorded)
 *   subscription  — platform subscription revenue (Kick tiers carry the
 *                   95/5 model's creator share; Twitch/YouTube subs post
 *                   the reported amount as-is)
 *   super_chat    — YouTube Live Super Chat
 *   membership    — YouTube Live channel memberships
 *   diamond       — TikTok Live Diamonds (variable rate, recorded per row)
 *   overlay_alert — sponsorship overlay alerts (flat or CPM basis)
 *   prize_pool    — an esports tournament prize-pool receipt (locks into
 *                   the waterfall's per-batch escrow, never to holding)
 */
export type LivestreamRevenueKind =
  | "bits"
  | "subscription"
  | "super_chat"
  | "membership"
  | "diamond"
  | "overlay_alert"
  | "prize_pool";

/**
 * The livestream lane's per-line context (PR 14). Null on every
 * non-livestream line — the field's PRESENCE is the lane discriminator,
 * the same pattern as podcastDetail and gamingDetail. Every field the
 * lane's money math and audit trail need ride the line: the applied
 * conversion rate is RECORDED here per row (the founder's rate-logging
 * rule), the Kick split's applied share is recorded per row, and the
 * sponsorship alert's type/basis/impressions are recorded per row.
 */
export interface LivestreamLineDetail {
  /** The stream platform whose report the row came from — null on esports
   * prize-pool receipt rows (a tournament payout is not a stream platform's
   * row; the prize_pool_batch cell is that row's identity). */
  readonly platform: MatchQueueStreamPlatform | null;
  /** What the row reports — the conversion/split math's discriminator. */
  readonly revenueKind: LivestreamRevenueKind;
  /** Overlay alert type (donation, sub, follow, sponsor_banner, ...);
   * required on overlay_alert lines, null elsewhere. */
  readonly alertType: string | null;
  /** Sponsor payout basis — flat or cpm; required on overlay_alert lines,
   * null elsewhere. */
  readonly revenueBasis: MatchQueueRevenueBasis | null;
  /** The line's impression count — required on CPM-basis alert lines. */
  readonly impressions: number | null;
  /** CPM as exact 1e-8 micros — required on CPM-basis alert lines. */
  readonly cpmMicros: bigint | null;
  /** Virtual-currency denomination ('Bits' or 'Diamonds'); null on
   * fiat-native rows. */
  readonly virtualCurrencyCode: string | null;
  /** Exact virtual amount as decimal text (never a float); null on
   * fiat-native rows. */
  readonly virtualAmount: string | null;
  /** The APPLIED fiat-per-virtual-unit rate as exact decimal text —
   * recorded on every conversion log row (the founder's rate-logging
   * rule); null on fiat-native rows. */
  readonly exchangeRate: string | null;
  /** The platform subscription tier (Kick tiers); null elsewhere. */
  readonly subscriptionTier: string | null;
  /** The APPLIED creator share in whole basis points (the Kick 95/5
   * model — default 9500, contract-configurable, recorded per row); null
   * where no split model applies. */
  readonly creatorShareBps: number | null;
  /** The esports prize-pool batch the receipt funds — required on
   * prize_pool lines, null elsewhere. */
  readonly prizePoolBatch: string | null;
}

/**
 * The webtoon lane's platform vocabulary (PR 19, founder webtoon +
 * serialized-publishing directive) — the three webtoon-family senders plus
 * Amazon KDP (the KENP page-read pool's report).
 */
export type WebtoonLanePlatform =
  | "webtoon"
  | "tapas"
  | "kakaopage"
  | "amazon_kdp";

/** What one webtoon-lane row reports — the lane's row-kind discriminator. */
export type WebtoonRowKind = "reader_log" | "coin_payout" | "kenp_pool";

/** The reader-log access types (PR 19) — monthly_pass is the all-access
 * subscription read (the double-dip claim's subject); fast_pass and
 * paid_coin_unlock are coin-money reads. */
export type WebtoonAccessType =
  | "paid_coin_unlock"
  | "fast_pass"
  | "monthly_pass";

/**
 * The webtoon lane's per-line context (PR 19). Null on every non-webtoon
 * line — the field's PRESENCE is the lane discriminator, the same pattern
 * as podcastDetail/gamingDetail/livestreamDetail. The deduplication needs
 * the reading-event identity (platform, series, chapter, reader, period),
 * the conversion needs the recorded virtual-currency cells, and the KENP
 * pool math needs the pages and the period's recorded rate.
 */
export interface WebtoonLineDetail {
  /** What the row reports — the conversion/dedup math's discriminator. */
  readonly kind: WebtoonRowKind;
  /** The platform whose report the row came from (the bounded vocabulary
   * above — validated at parse time). */
  readonly platform: WebtoonLanePlatform;
  /** The series the row reports — required on reader_log and coin_payout
   * rows (the reading-event identity); the KDP Title ID on kenp_pool rows
   * (it keys the pool event id). */
  readonly seriesId: string | null;
  /** The chapter the row reports — required on reader_log and coin_payout
   * rows, null on KENP pool rows. */
  readonly chapterId: string | null;
  /** The reader whose read the row reports — required on reader_log and
   * coin_payout rows (the double-dip dedup key), null on KENP pool rows. */
  readonly readerId: string | null;
  /** The row's access type — required on reader_log and coin_payout rows,
   * null on KENP pool rows. A monthly_pass row in a coin PAYOUT report is
   * a hostile row (a pass read is never pay-per-chapter coin money). */
  readonly accessType: WebtoonAccessType | null;
  /** The coin denomination (WEBTOON_COINS or TAPAS_INK, validated at
   * parse); null on reader_log and KENP rows. */
  readonly coinDenomination: string | null;
  /** Exact coin amount as decimal text (never a float), verbatim; null on
   * non-coin rows. */
  readonly coinAmount: string | null;
  /** The APPLIED fiat-per-unit rate as exact decimal text — RECORDED per
   * row (the founder's rate-logging rule): fiat per coin on coin_payout
   * rows, fiat per KENP page on kenp_pool rows; verbatim, never a
   * recomputation. */
  readonly exchangeRate: string | null;
  /** The Apple/Google App Store cut as whole basis points — required on
   * coin_payout rows (the pinned 3000), null elsewhere. */
  readonly appStoreCutBps: number | null;
  /** The platform split as whole basis points — required on coin_payout
   * rows (the 3000-5000 band), null elsewhere. */
  readonly platformSplitBps: number | null;
  /** The row's page count — required on kenp_pool and reader_log rows,
   * null on coin_payout rows. */
  readonly pagesRead: number | null;
  /** The row's UTC period bucket, `YYYY-MM` — the reading-event
   * fingerprint's period component and the KENP pool period (the Global
   * Fund's rate applies per period). */
  readonly period: string;
  /** The KDP marketplace (amazon.com, amazon.co.uk, ...) — required on
   * kenp_pool rows (the rate-consistency scope), null elsewhere. */
  readonly marketplace: string | null;
}

/**
 * The gaming lane's platform vocabulary (PR 12, founder gaming directive).
 * The Epic Games Store and Unreal Engine Marketplace share one engine-
 * royalty accumulator scope (the Epic family) — the store cell discriminates
 * the waiver; the other platforms carry their own commission bands.
 */
export type GamingPlatform =
  | "epic_games_store"
  | "unreal_marketplace"
  | "unity_asset_store"
  | "roblox"
  | "steamworks"
  | "apple_vision_pro";

/**
 * The gaming lane's per-line context (PR 12). Null on every non-gaming line
 * — the field's PRESENCE is the lane discriminator, the same pattern as
 * podcastDetail. All identity fields the lane's money math needs ride the
 * line: the per-product annual engine-royalty accumulator needs the product
 * key and the row's year, the split accruals need the item key, the DevEx
 * converter needs the virtual-currency cells, and the commission
 * reconciliation needs the validated band context.
 */
export interface GamingLineDetail {
  /** The platform whose report the row came from (drives the commission
   * band and the engine-royalty waiver). */
  readonly platform: GamingPlatform;
  /** The product/scope key the row reports — required on Epic-family rows
   * (the per-product annual accumulator's scope), the catalog scope on the
   * other platforms. */
  readonly productId: string | null;
  /** The product's display name (provenance). */
  readonly productName: string | null;
  /** The micro-transaction item key — the split schedule's scope unit
   * (an avatar skin, a 3D prop, an expansion pass, an audio plugin). */
  readonly itemId: string;
  /** The item's display name (provenance). */
  readonly itemName: string | null;
  /** Primary sale or secondary resale — the resale royalty's trigger. */
  readonly saleType: MatchQueueSaleType;
  /** Platform commission as whole basis points — validated against the
   * platform's band at parse time (Apple 15-30%, Steam 30, EGS 12, Unity
   * 30, Roblox marketplace fee 30). */
  readonly commissionBps: number;
  /** True when the line bears the Unreal engine royalty (the accumulator's
   * subject); false = waived (Epic Games Store sales) or not Epic family. */
  readonly engineRoyaltySubject: boolean;
  /** Secondary platform creator fee as whole basis points — required on
   * secondary_resale lines (the 5-10% band), forbidden on primary lines. */
  readonly resaleRoyaltyBps: number | null;
  /** Platform virtual-currency denomination (Robux on Roblox DevEx rows);
   * null on fiat-native rows. */
  readonly virtualCurrencyCode: string | null;
  /** Exact virtual amount as decimal text (never a float); null on
   * fiat-native rows. */
  readonly virtualAmount: string | null;
  /** Fiat-per-virtual-unit exchange rate as exact decimal text — recorded
   * on each conversion log row (the founder's rate-logging rule); null on
   * fiat-native rows. */
  readonly exchangeRate: string | null;
  /** The row date's UTC year — the engine-royalty accumulator's annual
   * bucket (per-product ANNUAL state). */
  readonly annualYear: number;
}

/** One normalized statement line — the worker's parse vocabulary. */
export interface ParsedStatementLine {
  /** 1-based data-row number within the statement (header excluded). */
  lineNumber: number;
  profile: StatementProfileKind;
  /**
   * Rights family — the profile's whole-file lane. Film and residual lines
   * are 'unknown' on purpose: they are neither recording nor composition
   * royalties, and the quarantine rule excludes them from split math.
   */
  rightsType: MatchQueueRightsType;
  statementSourceType: MatchQueueStatementSourceType | null;
  /** Film waterfall tier 0-5; null rides the non-waterfall (music) lane. */
  tierLevel: number | null;
  /**
   * One of the four music/DSP pipelines — the column carries only these.
   * On quarantined film rows the value is inert provenance (the split
   * engines never read it for rights_type-'unknown' rows).
   */
  rightsPipeline: RightsPipeline;
  period: string | null;
  currency: string;
  /** Signed 1e-8 micros — negative lines are adjustments (refunds, fees). */
  grossMicros: bigint;
  /** Adjustments are recorded but never posted as royalty.report events. */
  isAdjustment: boolean;
  identifiers: ReconIdentifiers;
  workTitle: string | null;
  territory: string | null;
  platform: string | null;
  /** The pipeline (music) or off-the-top note (film) the profile derived. */
  usageNote: string;
  raw: readonly string[];
  guildResidual: GuildResidualTag | null;
  /** Podcast lane context (feed, ad slot, CPM, qualification inputs);
   * null on every non-podcast line — the presence IS the lane discriminator. */
  podcastDetail: PodcastLineDetail | null;
  /** Gaming lane context (platform, product/item keys, sale type, validated
   * commission band, DevEx conversion cells); null on every non-gaming line
   * — the presence IS the lane discriminator. */
  gamingDetail: GamingLineDetail | null;
  /** Livestream lane context (stream platform, revenue kind, overlay alert
   * cells, recorded conversion rate, Kick split share, prize-pool batch);
   * null on every non-livestream line — the presence IS the lane
   * discriminator. */
  livestreamDetail: LivestreamLineDetail | null;
  /** Webtoon lane context (row kind, reading-event identity, coin
   * denomination/amount, recorded rate, layered shares, KENP pages);
   * null on every non-webtoon line — the presence IS the lane
   * discriminator. */
  webtoonDetail: WebtoonLineDetail | null;
}

/** A worker parse rejection — profile-scoped, row-attributed, never silent. */
export class StatementParseError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = "StatementParseError";
    this.reason = reason;
  }
}

/** The strict-profile contract: parse whole-file or reject whole-file. */
export interface StatementProfile {
  readonly kind: StatementProfileKind;
  /** Human-readable profile title for logs and job errors. */
  readonly title: string;
  readonly laneRightsType: MatchQueueRightsType;
  readonly statementSourceType: MatchQueueStatementSourceType | null;
  readonly tierLevel: number | null;
  /** True when the file's header row matches this profile exactly. */
  readonly matches: (content: string) => boolean;
  /** Deterministic parse — throws StatementParseError on any violation. */
  readonly parse: (content: string) => readonly ParsedStatementLine[];
}

/**
 * One job's parse outcome — the deterministic lane either produced lines or
 * named why it could not (never a partial parse).
 */
export type ParseOutcome =
  | { ok: true; profile: StatementProfileKind; lines: readonly ParsedStatementLine[] }
  | { ok: false; error: string };

/** The completion result shape migration 0011 locks into royalty_recon_jobs.result. */
export interface ReconJobCounts {
  events_written: number;
  matched: number;
  unmatched: number;
  engine_used: string | null;
}
