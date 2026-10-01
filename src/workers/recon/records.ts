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
  MatchQueueRevenueChannel,
  MatchQueueRightsType,
  MatchQueueStatementSourceType,
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
  | "podcast_rss_report_csv";

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
