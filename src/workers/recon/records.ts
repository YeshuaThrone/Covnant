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
  | "film_international_sales_agent_csv";

/**
 * Identifier kinds the worker emits — every one is a vault lookup kind
 * (src/lib/covnant/vault.ts VAULT_EXTERNAL_IDENTIFIER_KINDS), so a parsed
 * identifier can always be cross-referenced against cbt_assets.
 */
export type ReconIdentifierKind = "ISRC" | "ISWC" | "UPC" | "EIDR";

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
