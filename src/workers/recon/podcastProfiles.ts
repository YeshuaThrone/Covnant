/**
 * CVT recon worker — podcast ingestion profiles (PR 10).
 *
 * Two strict layouts in the PR #82 house style: exact header (order +
 * columns), required cells, bounded value maps, whole-file rejection on any
 * violation. The profile is the contract, pinned by checked-in fixtures —
 * a permissive guesser is the silent-misparse behavior the recon engine
 * exists to prevent.
 *
 *   podcast_dai_log_csv — a Dynamic Ad Insertion server log (Megaphone/
 *     Libsyn-style): one row per ad insertion event, carrying the listener
 *     identity (IP, user agent), the audio request's timestamp and seconds,
 *     the creative, the pod position, the network-sold flag with the
 *     contract's commission rate, and the CPM. These are the Channel A
 *     programmatic lines (plus any DAI-served host-read copy).
 *
 *   podcast_rss_report_csv — an RSS distribution report (Spotify for
 *     Podcasters/Acast-style): host-read sponsor reads (Channel B, sponsor
 *     verification carried on the row), subscription/membership recurring
 *     revenue (Channel C), and platform-reported impressions that overlap
 *     the DAI log's — the cross-feed deduplication's other half.
 *
 * Rights separation: podcast lines are rights_type 'unknown' — podcast ad
 * and subscription revenue is neither recording nor composition royalty,
 * so the split-quarantine rule keeps it out of music split math (PR 11's
 * episode splits reclassify). tier_level is null (never a waterfall line)
 * and statement_source_type stays null — the revenue_channel column is the
 * podcast discriminator, the way tier_level+statement_source_type are the
 * film discriminator. rights_pipeline rides inert provenance, the film
 * profiles' precedent (the column only carries the four music/DSP values).
 *
 * Fail-closed row validation (every rejection row-scoped, never silent):
 * the revenue channel vocabulary, the CPM tier's CPM/impressions, the
 * commission band on network-sold inventory (20-40% — outside is hostile),
 * sponsor verification on host reads, and the IAB qualification inputs
 * (IP, user agent, audio seconds) on every impression-bearing line.
 */

import { canonicalizeIdentifier } from "../../../covnant-sdk/src/contracts/identifiers";
import type {
  MatchQueueAdPlacementType,
  MatchQueueAdSlot,
  MatchQueueRevenueChannel,
} from "@/modules/sdk/records";
import {
  parseStatementMoney,
  readStrictTable,
  requiredCell,
  sniffHeaderMatches,
} from "./delimited";
import {
  cpmRevenueMicros,
  MAX_COMMISSION_BPS,
  MIN_COMMISSION_BPS,
  normalizeListenerIp,
} from "./podcast";
import { StatementParseError } from "./records";
import type {
  ParsedStatementLine,
  PodcastLineDetail,
  ReconIdentifiers,
  StatementProfile,
} from "./records";

const CSV = ",";

/** Every revenue channel, for the row-level vocabulary check. */
const REVENUE_CHANNELS: readonly MatchQueueRevenueChannel[] = [
  "channel_a_dai",
  "channel_b_host_read",
  "channel_c_subscription",
];

/** Canonicalizes the show's DOI — the podcast lane's vault lookup code. */
function showDoiCell(
  values: ReadonlyMap<string, string>,
  rowNumber: number,
): ReconIdentifiers {
  const trimmed = (values.get("Show DOI") ?? "").trim();
  if (trimmed === "") return {};
  const canonical = canonicalizeIdentifier("DOI", trimmed);
  if (canonical === null) {
    throw new StatementParseError(`invalid_doi:row_${rowNumber}`);
  }
  return { DOI: canonical };
}

/** The revenue channel cell — the bounded A/B/C vocabulary, row-scoped. */
function revenueChannelCell(
  values: ReadonlyMap<string, string>,
  rowNumber: number,
): MatchQueueRevenueChannel {
  const cell = requiredCell(values, "Revenue Channel", rowNumber);
  if (!REVENUE_CHANNELS.includes(cell as MatchQueueRevenueChannel)) {
    throw new StatementParseError(
      `invalid_revenue_channel:${cell}:row_${rowNumber}`,
    );
  }
  return cell as MatchQueueRevenueChannel;
}

/** The delivery-method cell — host_read or dai; independent of the channel. */
function placementTypeCell(
  values: ReadonlyMap<string, string>,
  rowNumber: number,
): MatchQueueAdPlacementType {
  const cell = requiredCell(values, "Placement Type", rowNumber);
  if (cell !== "host_read" && cell !== "dai") {
    throw new StatementParseError(
      `invalid_placement_type:${cell}:row_${rowNumber}`,
    );
  }
  return cell;
}

/** The pod position cell — the bounded slot vocabulary. */
function adSlotCell(
  values: ReadonlyMap<string, string>,
  rowNumber: number,
): MatchQueueAdSlot {
  const cell = requiredCell(values, "Ad Slot", rowNumber);
  if (cell !== "pre_roll" && cell !== "mid_roll" && cell !== "post_roll") {
    throw new StatementParseError(`invalid_ad_slot:${cell}:row_${rowNumber}`);
  }
  return cell;
}

/** The network-sold cell — yes/no; a missing value is a rejection (the
 * commission's trigger cannot be guessed). */
function networkSoldCell(
  values: ReadonlyMap<string, string>,
  rowNumber: number,
): boolean {
  const cell = requiredCell(values, "Network Sold", rowNumber).toLowerCase();
  if (cell !== "yes" && cell !== "no") {
    throw new StatementParseError(
      `invalid_network_sold:${cell}:row_${rowNumber}`,
    );
  }
  return cell === "yes";
}

/** The sponsor-verification cell — yes/no; required on host-read lines. */
function sponsorVerifiedCell(
  values: ReadonlyMap<string, string>,
  rowNumber: number,
): boolean {
  const cell = requiredCell(values, "Sponsor Verified", rowNumber).toLowerCase();
  if (cell !== "yes" && cell !== "no") {
    throw new StatementParseError(
      `invalid_sponsor_verified:${cell}:row_${rowNumber}`,
    );
  }
  return cell === "yes";
}

/** Money wrapper — attributes rejections to the column and row. */
function moneyCell(
  values: ReadonlyMap<string, string>,
  column: string,
  rowNumber: number,
): { micros: bigint; negative: boolean } {
  const cell = requiredCell(values, column, rowNumber);
  try {
    return parseStatementMoney(cell);
  } catch (error) {
    if (error instanceof StatementParseError) {
      throw new StatementParseError(`${error.reason}:${column}:row_${rowNumber}`);
    }
    throw error;
  }
}

/**
 * The commission cell — a percent with at most two decimals ("30",
 * "27.5", "30.00"), parsed into whole basis points with NO float (the
 * fraction's digits ARE the bps digits). Empty is allowed (the caller
 * decides when the rate is required); a value outside the 20-40% band is
 * a hostile row, rejected here.
 */
export function parseCommissionCell(
  values: ReadonlyMap<string, string>,
  rowNumber: number,
): number | null {
  const cell = (values.get("Network Commission %") ?? "").trim();
  if (cell === "") return null;
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(cell)) {
    throw new StatementParseError(`invalid_commission:${cell}:row_${rowNumber}`);
  }
  const [whole, fraction = ""] = cell.split(".");
  const bps = Number(whole) * 100 + Number(fraction.padEnd(2, "0") || "0");
  if (bps < MIN_COMMISSION_BPS || bps > MAX_COMMISSION_BPS) {
    throw new StatementParseError(
      `commission_out_of_band:${cell}:row_${rowNumber}`,
    );
  }
  return bps;
}

/** Integer cell — non-negative whole number, row-scoped rejection. */
function integerCell(
  values: ReadonlyMap<string, string>,
  column: string,
  rowNumber: number,
): number {
  const cell = requiredCell(values, column, rowNumber);
  if (!/^\d+$/.test(cell)) {
    throw new StatementParseError(`invalid_integer:${column}:row_${rowNumber}`);
  }
  const value = Number(cell);
  if (!Number.isSafeInteger(value)) {
    throw new StatementParseError(`integer_overflow:${column}:row_${rowNumber}`);
  }
  return value;
}

/** ISO 8601 timestamp cell — the dedup window's input; never guessed. */
function timestampCell(
  values: ReadonlyMap<string, string>,
  column: string,
  rowNumber: number,
): Date {
  const cell = requiredCell(values, column, rowNumber);
  const parsed = new Date(cell);
  if (
    !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(cell) ||
    Number.isNaN(parsed.getTime())
  ) {
    throw new StatementParseError(`invalid_timestamp:${cell}:row_${rowNumber}`);
  }
  return parsed;
}

/**
 * Assembles one podcast line. grossMicros is the line's gross revenue:
 * CPM conversion for impression lines (computed at parse from the row's
 * raw CPM + impressions — qualification happens downstream and filters
 * the line BEFORE any revenue counts), exact money for subscription and
 * flat-fee lines.
 */
function podcastLine(
  profile: StatementProfile["kind"],
  rowNumber: number,
  currency: string,
  grossMicros: bigint,
  detail: PodcastLineDetail,
  identifiers: ReconIdentifiers,
  raw: readonly string[],
): ParsedStatementLine {
  return {
    lineNumber: rowNumber,
    profile,
    rightsType: "unknown",
    statementSourceType: null,
    tierLevel: null,
    // Inert on quarantined rows — the film profiles' precedent; the column
    // only carries the four music/DSP pipelines and the split engines never
    // read it for rights_type-'unknown' lines.
    rightsPipeline: "master_digital_performance",
    period: null,
    currency,
    grossMicros,
    isAdjustment: grossMicros < 0n,
    identifiers,
    workTitle: null,
    territory: null,
    platform: "podcast",
    usageNote: `podcast ${detail.revenueChannel} — ${detail.adPlacementType ?? "none"} placement`,
    raw,
    guildResidual: null,
    podcastDetail: detail,
    gamingDetail: null,
    livestreamDetail: null,
    webtoonDetail: null,
    merchDetail: null,
    aiDetail: null,
  };
}

// ---------------------------------------------------------------------------
// DAI server log — Megaphone/Libsyn-style per-insertion rows. The raw unit
// is one ad insertion riding one audio request: the listener identity and
// request telemetry (IP, user agent, audio seconds) drive IAB qualification,
// the CPM + impressions drive Channel A revenue, and the network-sold flag
// with the contract's commission rate drives the pre-ledger deduction.
// ---------------------------------------------------------------------------

const DAI_LOG_HEADER = [
  "Log Date",
  "RSS Feed ID",
  "Episode GUID",
  "Listener IP",
  "User Agent",
  "Ad Creative ID",
  "Ad Slot",
  "Placement Type",
  "Revenue Channel",
  "Network Sold",
  "Impressions",
  "CPM",
  "Audio Requested (sec)",
  "Network Commission %",
  "Show DOI",
  "Currency",
] as const;

/** CPM conversion at parse time — attributes engine rejections to the row. */
function cpmRevenue(
  impressions: number,
  cpmMicros: bigint,
  rowNumber: number,
): bigint {
  try {
    return cpmRevenueMicros(impressions, cpmMicros);
  } catch (error) {
    throw new StatementParseError(
      `${error instanceof Error ? error.message : "cpm_error"}:row_${rowNumber}`,
    );
  }
}

/**
 * The RSS row's revenue channel — tolerant of the blank cell real
 * distribution reports ship for rows with no ad inventory at all. A blank
 * channel is accepted only as the subscription shape: the monthly
 * recurring amount present and every ad/listener column empty. Anything
 * else stays hostile (missing or unknown channel).
 */
function rssRevenueChannel(
  values: ReadonlyMap<string, string>,
  rowNumber: number,
): MatchQueueRevenueChannel {
  const cell = (values.get("Revenue Channel") ?? "").trim();
  if (cell === "") {
    const hasRecurring =
      (values.get("Monthly Recurring Amount") ?? "").trim() !== "";
    const adColumnsEmpty = [
      "Ad Creative ID",
      "Ad Slot",
      "Placement Type",
      "Listener IP",
      "User Agent",
      "Audio Requested (sec)",
      "CPM",
      "Flat Fee",
    ].every((column) => (values.get(column) ?? "").trim() === "");
    if (hasRecurring && adColumnsEmpty) {
      return "channel_c_subscription";
    }
    throw new StatementParseError(`missing_revenue_channel:row_${rowNumber}`);
  }
  if (!REVENUE_CHANNELS.includes(cell as MatchQueueRevenueChannel)) {
    throw new StatementParseError(
      `invalid_revenue_channel:${cell}:row_${rowNumber}`,
    );
  }
  return cell as MatchQueueRevenueChannel;
}

const daiLogProfile: StatementProfile = {
  kind: "podcast_dai_log_csv",
  title: "Podcast Dynamic Ad Insertion (DAI) server log CSV",
  laneRightsType: "unknown",
  statementSourceType: null,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, DAI_LOG_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, DAI_LOG_HEADER);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      const revenueChannel = revenueChannelCell(values, rowNumber);
      if (revenueChannel === "channel_c_subscription") {
        throw new StatementParseError(
          `invalid_revenue_channel_for_log:channel_c_subscription:row_${rowNumber}`,
        );
      }
      const adSlot = adSlotCell(values, rowNumber);
      const placementType = placementTypeCell(values, rowNumber);
      const networkSold = networkSoldCell(values, rowNumber);
      const impressions = integerCell(values, "Impressions", rowNumber);
      if (impressions <= 0) {
        throw new StatementParseError(
          `invalid_impressions:${impressions}:row_${rowNumber}`,
        );
      }
      const audioSeconds = integerCell(values, "Audio Requested (sec)", rowNumber);
      const cpm = moneyCell(values, "CPM", rowNumber);
      if (cpm.negative || cpm.micros <= 0n) {
        throw new StatementParseError(`invalid_cpm:row_${rowNumber}`);
      }
      // The commission rate exists ONLY on network-sold inventory — a rate
      // on direct-sold inventory is a contract error (nothing to deduct
      // from), and a network-sold row without one cannot compute creator
      // net (fail-closed, never a guessed rate).
      const commissionBps = parseCommissionCell(values, rowNumber);
      if (networkSold && commissionBps === null) {
        throw new StatementParseError(`missing_commission:row_${rowNumber}`);
      }
      if (!networkSold && commissionBps !== null) {
        throw new StatementParseError(`unexpected_commission:row_${rowNumber}`);
      }
      return podcastLine(
        "podcast_dai_log_csv",
        rowNumber,
        requiredCell(values, "Currency", rowNumber).toUpperCase(),
        cpmRevenue(impressions, cpm.micros, rowNumber),
        {
          rssFeedId: requiredCell(values, "RSS Feed ID", rowNumber),
          episodeId: requiredCell(values, "Episode GUID", rowNumber),
          adCreativeId: requiredCell(values, "Ad Creative ID", rowNumber),
          listenerIp: normalizeListenerIp(
            requiredCell(values, "Listener IP", rowNumber),
          ),
          userAgent: requiredCell(values, "User Agent", rowNumber),
          requestedAt: timestampCell(values, "Log Date", rowNumber),
          revenueChannel,
          adSlot,
          adPlacementType: placementType,
          networkSold,
          sponsorVerified: null,
          audioSeconds,
          cpmMicros: cpm.micros,
          impressions,
          commissionBps,
        },
        showDoiCell(values, rowNumber),
        DAI_LOG_HEADER.map((column) => values.get(column) ?? ""),
      );
    });
  },
};

// ---------------------------------------------------------------------------
// RSS distribution report — Spotify for Podcasters/Acast-style. Carries
// host-read sponsor reads (Channel B — sponsor verification on the row),
// subscription/membership recurring revenue (Channel C — exact recurring
// money, no listener identity), and platform-reported impressions whose
// overlap with the DAI log exercises the cross-feed deduplication.
// ---------------------------------------------------------------------------

const RSS_REPORT_HEADER = [
  "Report Date",
  "RSS Feed ID",
  "Episode GUID",
  "Listener IP",
  "User Agent",
  "Ad Creative ID",
  "Ad Slot",
  "Placement Type",
  "Revenue Channel",
  "Sponsor Verified",
  "Impressions",
  "CPM",
  "Flat Fee",
  "Audio Requested (sec)",
  "Network Commission %",
  "Show DOI",
  "Monthly Recurring Amount",
  "Currency",
] as const;

const rssReportProfile: StatementProfile = {
  kind: "podcast_rss_report_csv",
  title: "Podcast RSS distribution report CSV",
  laneRightsType: "unknown",
  statementSourceType: null,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, RSS_REPORT_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, RSS_REPORT_HEADER);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      const revenueChannel = rssRevenueChannel(values, rowNumber);
      const currency = requiredCell(values, "Currency", rowNumber).toUpperCase();
      const feedId = requiredCell(values, "RSS Feed ID", rowNumber);
      const episodeId = requiredCell(values, "Episode GUID", rowNumber);
      const requestedAt = timestampCell(values, "Report Date", rowNumber);
      const identifiers = showDoiCell(values, rowNumber);

      if (revenueChannel === "channel_c_subscription") {
        // A subscription line is recurring money, not an impression — the
        // ad and listener columns must be empty (their presence would make
        // the line's nature ambiguous, and ambiguous rows are never guessed).
        for (const column of [
          "Ad Creative ID",
          "Ad Slot",
          "Placement Type",
          "Listener IP",
          "User Agent",
          "Audio Requested (sec)",
          "CPM",
          "Flat Fee",
        ]) {
          if ((values.get(column) ?? "").trim() !== "") {
            throw new StatementParseError(
              `unexpected_column_for_subscription:${column}:row_${rowNumber}`,
            );
          }
        }
        const recurring = moneyCell(values, "Monthly Recurring Amount", rowNumber);
        return podcastLine(
          "podcast_rss_report_csv",
          rowNumber,
          currency,
          recurring.micros,
          {
            rssFeedId: feedId,
            episodeId,
            adCreativeId: null,
            listenerIp: null,
            userAgent: null,
            requestedAt,
            revenueChannel,
            adSlot: null,
            adPlacementType: null,
            networkSold: null,
            sponsorVerified: null,
            audioSeconds: null,
            cpmMicros: null,
            impressions: null,
            commissionBps: null,
          },
          identifiers,
          RSS_REPORT_HEADER.map((column) => values.get(column) ?? ""),
        );
      }

      // Impression-bearing rows (Channels A and B) — the full listener
      // identity is required: the IAB gates cannot qualify a request they
      // cannot attribute.
      const adSlot = adSlotCell(values, rowNumber);
      const placementType = placementTypeCell(values, rowNumber);
      const audioSeconds = integerCell(values, "Audio Requested (sec)", rowNumber);
      const listenerIp = normalizeListenerIp(
        requiredCell(values, "Listener IP", rowNumber),
      );
      const userAgent = requiredCell(values, "User Agent", rowNumber);
      const adCreativeId = requiredCell(values, "Ad Creative ID", rowNumber);

      if (revenueChannel === "channel_a_dai") {
        const impressions = integerCell(values, "Impressions", rowNumber);
        if (impressions <= 0) {
          throw new StatementParseError(
            `invalid_impressions:${impressions}:row_${rowNumber}`,
          );
        }
        const cpm = moneyCell(values, "CPM", rowNumber);
        if (cpm.negative || cpm.micros <= 0n) {
          throw new StatementParseError(`invalid_cpm:row_${rowNumber}`);
        }
        return podcastLine(
          "podcast_rss_report_csv",
          rowNumber,
          currency,
          cpmRevenue(impressions, cpm.micros, rowNumber),
          {
            rssFeedId: feedId,
            episodeId,
            adCreativeId,
            listenerIp,
            userAgent,
            requestedAt,
            revenueChannel,
            adSlot,
            adPlacementType: placementType,
            networkSold: null,
            sponsorVerified: null,
            audioSeconds,
            cpmMicros: cpm.micros,
            impressions,
            commissionBps: null,
          },
          identifiers,
          RSS_REPORT_HEADER.map((column) => values.get(column) ?? ""),
        );
      }

      // Channel B — host-read and affiliate direct deals. The sponsor's
      // verification state rides the row (unverified parks in the held
      // quarantine id space); the money is the flat fee when present,
      // otherwise the CPM conversion (revenue-share deals report CPM).
      const sponsorVerified = sponsorVerifiedCell(values, rowNumber);
      const flatFee = (values.get("Flat Fee") ?? "").trim();
      let grossMicros = 0n;
      let cpmMicros: bigint | null = null;
      let impressions: number | null = null;
      if (flatFee !== "") {
        grossMicros = moneyCell(values, "Flat Fee", rowNumber).micros;
      } else {
        const cpm = moneyCell(values, "CPM", rowNumber);
        if (cpm.negative || cpm.micros <= 0n) {
          throw new StatementParseError(`invalid_cpm:row_${rowNumber}`);
        }
        const count = integerCell(values, "Impressions", rowNumber);
        if (count <= 0) {
          throw new StatementParseError(
            `invalid_impressions:${count}:row_${rowNumber}`,
          );
        }
        cpmMicros = cpm.micros;
        impressions = count;
        grossMicros = cpmRevenue(count, cpm.micros, rowNumber);
      }
      return podcastLine(
        "podcast_rss_report_csv",
        rowNumber,
        currency,
        grossMicros,
        {
          rssFeedId: feedId,
          episodeId,
          adCreativeId,
          listenerIp,
          userAgent,
          requestedAt,
          revenueChannel,
          adSlot,
          adPlacementType: placementType,
          networkSold: null,
          sponsorVerified,
          audioSeconds,
          cpmMicros,
          impressions,
          commissionBps: null,
        },
        identifiers,
        RSS_REPORT_HEADER.map((column) => values.get(column) ?? ""),
      );
    });
  },
};

/** The podcast lane's profiles — dispatched through the shared dispatcher. */
export const PODCAST_PROFILES: readonly StatementProfile[] = [
  daiLogProfile,
  rssReportProfile,
];

/** True when a dispatched profile is the podcast lane's. */
export function isPodcastProfileKind(kind: StatementProfile["kind"]): boolean {
  return (
    kind === "podcast_dai_log_csv" || kind === "podcast_rss_report_csv"
  );
}
