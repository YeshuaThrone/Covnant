/**
 * CVT recon worker — livestream ingestion profiles (PR 14, founder
 * livestream directive).
 *
 * Six strict layouts in the PR #82/#93 house style: exact header (order +
 * columns), required cells, bounded value maps, whole-file rejection on
 * any violation. The profile is the contract, pinned by checked-in
 * fixtures — a permissive guesser is the silent-misparse behavior the
 * recon engine exists to prevent.
 *
 *   twitch_livestream_payouts_csv — a Twitch creator payout report:
 *     Bits cheers (the virtual count + the net rate, default $0.01/bit —
 *     the founder rate, contract-configurable through the row's rate
 *     cell, always recorded), subscriptions, and sponsorship overlay
 *     alerts (flat or CPM basis).
 *
 *   youtube_live_livestream_payouts_csv — a YouTube Live payout report:
 *     Super Chat, channel memberships, and overlay alerts.
 *
 *   kick_livestream_payouts_csv — a Kick subscription report: the tier's
 *     gross splits on the 95/5 model (the creator's share defaults to
 *     9500 bps, contract-configurable through the row's share cell,
 *     recorded per row).
 *
 *   tiktok_live_livestream_payouts_csv — a TikTok Live Diamonds report:
 *     the Diamond rate is VARIABLE and REQUIRED on every row (a
 *     conversion at an unrecorded rate cannot be audited — the founder's
 *     rate-logging rule).
 *
 *   streamlabs_streamelements_alerts_csv — Streamlabs/StreamElements
 *     overlay alert logs (the Platform cell discriminates the two
 *     platforms; they share one alert format).
 *
 *   esports_tournament_prize_pool_csv — an esports tournament's prize
 *     pool receipt report: each row funds a batch (Prize Pool Batch is
 *     required) that locks into the esports waterfall's escrow — never
 *     the unclaimed holding.
 *
 * Rights separation: livestream lines are rights_type 'unknown' — a
 * stream payout is neither recording nor composition royalty, so the
 * split-quarantine rule keeps them out of music split math. tier_level
 * is null and statement_source_type is null — the livestream columns PR 1
 * shipped (stream_platform, alert_type, revenue_basis, prize_pool_batch,
 * and the virtual-currency conversion trio) are this lane's discriminators,
 * the way tier_level+statement_source_type are the film discriminator and
 * revenue_channel is the podcast discriminator. rights_pipeline rides
 * inert provenance, the film/podcast profiles' precedent.
 *
 * Fail-closed row validation (every rejection row-scoped, never silent):
 * the revenue-kind vocabulary per report, the conversion operands
 * (positive virtual amounts; Bits at the recorded-or-default net rate;
 * Diamonds ALWAYS at a recorded rate), the Kick share band (strictly
 * between 0% and 100%), the alert basis vocabulary (flat requires the
 * payout, CPM requires impressions + CPM), the prize-pool batch cell,
 * and the channel/team DOI every attributable row needs.
 */

import { canonicalizeIdentifier } from "../../../covnant-sdk/src/contracts/identifiers";
import type {
  MatchQueueRevenueBasis,
  MatchQueueRightsType,
  MatchQueueStatementSourceType,
  MatchQueueStreamPlatform,
} from "@/modules/sdk/records";
import {
  parseStatementMoney,
  readStrictTable,
  requiredCell,
  sniffHeaderMatches,
} from "./delimited";
import {
  convertVirtualToMicros,
  DEFAULT_BITS_NET_RATE,
  DEFAULT_KICK_CREATOR_SHARE_BPS,
  overlayCpmGrossMicros,
  validateKickCreatorShareBps,
} from "./livestream";
import { StatementParseError } from "./records";
import type {
  LivestreamLineDetail,
  LivestreamRevenueKind,
  ParsedStatementLine,
  ReconIdentifiers,
  StatementProfile,
} from "./records";

const CSV = ",";

/** The livestream lane's rights family — neither recording nor composition. */
const LIVESTREAM_RIGHTS_TYPE: MatchQueueRightsType = "unknown";

/** The livestream lane carries no statement_source_type — stream_platform
 * (and the detail cells) are the discriminator. */
const LIVESTREAM_SOURCE_TYPE: MatchQueueStatementSourceType | null = null;

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

/** A positive money cell — rates and payouts reject zero and negative. */
function positiveMoneyCell(
  values: ReadonlyMap<string, string>,
  column: string,
  rowNumber: number,
): bigint {
  const money = moneyCell(values, column, rowNumber);
  if (money.negative || money.micros <= 0n) {
    throw new StatementParseError(
      `invalid_money:${column}:${(values.get(column) ?? "").trim()}:row_${rowNumber}`,
    );
  }
  return money.micros;
}

/**
 * The report date cell — an ISO calendar date. Required provenance on
 * every livestream row (the withholding/settlement passes read periods,
 * never guesses).
 */
function reportDateCell(
  values: ReadonlyMap<string, string>,
  rowNumber: number,
): string {
  const cell = requiredCell(values, "Report Date", rowNumber);
  const parsed = new Date(`${cell}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cell) || Number.isNaN(parsed.getTime())) {
    throw new StatementParseError(`invalid_date:${cell}:row_${rowNumber}`);
  }
  return cell;
}

/** The currency cell — required, uppercased. */
function currencyCell(
  values: ReadonlyMap<string, string>,
  rowNumber: number,
): string {
  return requiredCell(values, "Currency", rowNumber).toUpperCase();
}

/**
 * The channel DOI — REQUIRED on every livestream row: a stream payout
 * without its channel's vault identity is unattributable money, and the
 * lane refuses to quarantine it silently (the gaming lane's Catalog DOI
 * with the required posture the row's attribution needs).
 */
function channelDoiCell(
  values: ReadonlyMap<string, string>,
  column: string,
  rowNumber: number,
): ReconIdentifiers {
  const trimmed = requiredCell(values, column, rowNumber);
  const canonical = canonicalizeIdentifier("DOI", trimmed);
  if (canonical === null) {
    throw new StatementParseError(`invalid_doi:${trimmed}:row_${rowNumber}`);
  }
  return { DOI: canonical };
}

/**
 * A percent cell with at most two decimals ("95", "97.5", "95.00"),
 * parsed into whole basis points with NO float (the fraction's digits
 * ARE the bps digits). Empty is allowed (the caller decides when the
 * rate is required).
 */
function optionalPercentCell(
  values: ReadonlyMap<string, string>,
  column: string,
  rowNumber: number,
): number | null {
  const cell = (values.get(column) ?? "").trim();
  if (cell === "") return null;
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(cell)) {
    throw new StatementParseError(`invalid_percent:${column}:${cell}:row_${rowNumber}`);
  }
  const [whole, fraction = ""] = cell.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0") || "0");
}

/** The payout-basis cell — the bounded flat/cpm vocabulary. */
function revenueBasisCell(
  values: ReadonlyMap<string, string>,
  rowNumber: number,
): MatchQueueRevenueBasis {
  const cell = requiredCell(values, "Payout Basis", rowNumber);
  if (cell !== "flat" && cell !== "cpm") {
    throw new StatementParseError(`invalid_revenue_basis:${cell}:row_${rowNumber}`);
  }
  return cell;
}

/** The impressions cell — a positive whole count (CPM-basis rows). */
function impressionsCell(
  values: ReadonlyMap<string, string>,
  rowNumber: number,
): number {
  const cell = requiredCell(values, "Impressions", rowNumber);
  if (!/^\d+$/.test(cell) || Number(cell) <= 0) {
    throw new StatementParseError(`invalid_impressions:${cell}:row_${rowNumber}`);
  }
  return Number(cell);
}

/**
 * The Twitch Bits count cell — whole bits only (a fractional bit is a
 * hostile row). Returns the exact virtual amount text verbatim plus the
 * count as micros (1 bit = 1 virtual unit = 1e8 micros).
 */
function bitsCell(
  values: ReadonlyMap<string, string>,
  rowNumber: number,
): { text: string; micros: bigint } {
  const cell = requiredCell(values, "Bits", rowNumber);
  if (!/^\d+$/.test(cell) || BigInt(cell) <= 0n) {
    throw new StatementParseError(`invalid_bits_amount:${cell}:row_${rowNumber}`);
  }
  return { text: cell, micros: BigInt(cell) * 100_000_000n };
}

/**
 * Assembles one livestream line. grossMicros is the line's gross FIAT
 * revenue — the raw cell on fiat-native rows, the conversion (virtual ×
 * recorded rate) on Bits/Diamonds rows, the CPM product on CPM alert rows.
 */
function livestreamLine(
  profile: StatementProfile["kind"],
  rowNumber: number,
  currency: string,
  grossMicros: bigint,
  detail: LivestreamLineDetail,
  identifiers: ReconIdentifiers,
  raw: readonly string[],
  channelName: string,
): ParsedStatementLine {
  return {
    lineNumber: rowNumber,
    profile,
    rightsType: LIVESTREAM_RIGHTS_TYPE,
    statementSourceType: LIVESTREAM_SOURCE_TYPE,
    tierLevel: null,
    // Inert on quarantined rows — the film/podcast precedent; the column
    // only carries the four music/DSP pipelines and the split engines never
    // read it for rights_type-'unknown' lines.
    rightsPipeline: "master_digital_performance",
    period: null,
    currency,
    grossMicros,
    isAdjustment: grossMicros < 0n,
    identifiers,
    workTitle: channelName,
    territory: null,
    // The free-text display platform — 'esports' on prize-pool receipt
    // rows (the typed stream_platform column stays null for those).
    platform: detail.platform ?? "esports",
    usageNote: livestreamUsageNote(detail),
    raw,
    guildResidual: null,
    podcastDetail: null,
    gamingDetail: null,
    livestreamDetail: detail,
    webtoonDetail: null,
    merchDetail: null,
    aiDetail: null,
  };
}

/** The usage note — provenance naming the row's kind and its audit cells. */
function livestreamUsageNote(detail: LivestreamLineDetail): string {
  const virtual =
    detail.virtualCurrencyCode === null
      ? ""
      : ` (${detail.virtualAmount} ${detail.virtualCurrencyCode} @ ${detail.exchangeRate})`;
  const share =
    detail.creatorShareBps === null ? "" : ` creator ${detail.creatorShareBps} bps`;
  const platform = detail.platform ?? "esports";
  return `livestream ${platform} — ${detail.revenueKind}${virtual}${share}`;
}

// ---------------------------------------------------------------------------
// Twitch creator payout report — Bits, subscriptions, and sponsorship
// overlay alerts in one report. The Revenue Kind cell discriminates the
// money math: Bits convert at the recorded-or-default net rate, subs post
// the reported amount, alerts price flat or CPM.
// ---------------------------------------------------------------------------

const TWITCH_HEADER = [
  "Report Date",
  "Channel",
  "Revenue Kind",
  "Subscription Tier",
  "Bits",
  "Rate per Bit (USD)",
  "Alert Type",
  "Payout Basis",
  "Impressions",
  "CPM (USD)",
  "Gross Amount (USD)",
  "Channel DOI",
  "Currency",
] as const;

const TWITCH_REVENUE_KINDS: readonly LivestreamRevenueKind[] = [
  "bits",
  "subscription",
  "overlay_alert",
];

function twitchRevenueKindCell(
  values: ReadonlyMap<string, string>,
  rowNumber: number,
): LivestreamRevenueKind {
  const cell = requiredCell(values, "Revenue Kind", rowNumber);
  if (!TWITCH_REVENUE_KINDS.includes(cell as LivestreamRevenueKind)) {
    throw new StatementParseError(`invalid_revenue_kind:${cell}:row_${rowNumber}`);
  }
  return cell as LivestreamRevenueKind;
}

const twitchProfile: StatementProfile = {
  kind: "twitch_livestream_payouts_csv",
  title: "Twitch creator payout report CSV (Bits, subscriptions, overlay alerts)",
  laneRightsType: LIVESTREAM_RIGHTS_TYPE,
  statementSourceType: LIVESTREAM_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, TWITCH_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, TWITCH_HEADER);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      reportDateCell(values, rowNumber);
      const revenueKind = twitchRevenueKindCell(values, rowNumber);
      const channel = requiredCell(values, "Channel", rowNumber);
      const identifiers = channelDoiCell(values, "Channel DOI", rowNumber);
      const currency = currencyCell(values, rowNumber);

      let grossMicros = 0n;
      let detail: LivestreamLineDetail;
      if (revenueKind === "bits") {
        // The Bits conversion — the recorded rate (the row's cell, the
        // founder's $0.01/bit default when the report does not restate a
        // contract rate), ALWAYS recorded on the row.
        const bits = bitsCell(values, rowNumber);
        const rateCell = (values.get("Rate per Bit (USD)") ?? "").trim();
        const rateText = rateCell === "" ? DEFAULT_BITS_NET_RATE : rateCell;
        const rateMoney = (() => {
          try {
            return parseStatementMoney(rateText);
          } catch (error) {
            if (error instanceof StatementParseError) {
              throw new StatementParseError(
                `invalid_exchange_rate:${rateText}:row_${rowNumber}`,
              );
            }
            throw error;
          }
        })();
        if (rateMoney.negative || rateMoney.micros <= 0n) {
          throw new StatementParseError(
            `invalid_exchange_rate:${rateText}:row_${rowNumber}`,
          );
        }
        grossMicros = convertVirtualToMicros(bits.micros, rateMoney.micros);
        detail = {
          platform: "twitch",
          revenueKind,
          alertType: null,
          revenueBasis: null,
          impressions: null,
          cpmMicros: null,
          virtualCurrencyCode: "Bits",
          virtualAmount: bits.text,
          exchangeRate: rateText,
          subscriptionTier: null,
          creatorShareBps: null,
          prizePoolBatch: null,
        };
      } else if (revenueKind === "subscription") {
        grossMicros = positiveMoneyCell(values, "Gross Amount (USD)", rowNumber);
        detail = {
          platform: "twitch",
          revenueKind,
          alertType: null,
          revenueBasis: null,
          impressions: null,
          cpmMicros: null,
          virtualCurrencyCode: null,
          virtualAmount: null,
          exchangeRate: null,
          subscriptionTier: requiredCell(values, "Subscription Tier", rowNumber),
          creatorShareBps: null,
          prizePoolBatch: null,
        };
      } else {
        // The overlay alert — flat payouts price from the payout cell,
        // CPM payouts from impressions × cost-per-mille.
        const basis = revenueBasisCell(values, rowNumber);
        const alertType = requiredCell(values, "Alert Type", rowNumber);
        if (basis === "flat") {
          grossMicros = positiveMoneyCell(values, "Gross Amount (USD)", rowNumber);
        } else {
          const impressions = impressionsCell(values, rowNumber);
          const cpm = positiveMoneyCell(values, "CPM (USD)", rowNumber);
          grossMicros = overlayCpmGrossMicros(impressions, cpm);
        }
        detail = {
          platform: "twitch",
          revenueKind,
          alertType,
          revenueBasis: basis,
          impressions: basis === "cpm" ? Number((values.get("Impressions") ?? "").trim()) : null,
          cpmMicros:
            basis === "cpm"
              ? (() => {
                  try {
                    return parseStatementMoney((values.get("CPM (USD)") ?? "").trim()).micros;
                  } catch {
                    throw new StatementParseError(
                      `invalid_money:CPM (USD):${(values.get("CPM (USD)") ?? "").trim()}:row_${rowNumber}`,
                    );
                  }
                })()
              : null,
          virtualCurrencyCode: null,
          virtualAmount: null,
          exchangeRate: null,
          subscriptionTier: null,
          creatorShareBps: null,
          prizePoolBatch: null,
        };
      }

      return livestreamLine(
        "twitch_livestream_payouts_csv",
        rowNumber,
        currency,
        grossMicros,
        detail,
        identifiers,
        TWITCH_HEADER.map((column) => values.get(column) ?? ""),
        channel,
      );
    });
  },
};

// ---------------------------------------------------------------------------
// YouTube Live payout report — Super Chat, channel memberships, and
// sponsorship overlay alerts (flat or CPM).
// ---------------------------------------------------------------------------

const YOUTUBE_HEADER = [
  "Report Date",
  "Channel",
  "Revenue Kind",
  "Membership Tier",
  "Alert Type",
  "Payout Basis",
  "Impressions",
  "CPM (USD)",
  "Gross Amount (USD)",
  "Channel DOI",
  "Currency",
] as const;

const YOUTUBE_REVENUE_KINDS: readonly LivestreamRevenueKind[] = [
  "super_chat",
  "membership",
  "overlay_alert",
];

const youtubeLiveProfile: StatementProfile = {
  kind: "youtube_live_livestream_payouts_csv",
  title: "YouTube Live payout report CSV (Super Chat, memberships, overlay alerts)",
  laneRightsType: LIVESTREAM_RIGHTS_TYPE,
  statementSourceType: LIVESTREAM_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, YOUTUBE_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, YOUTUBE_HEADER);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      reportDateCell(values, rowNumber);
      const kindCell = requiredCell(values, "Revenue Kind", rowNumber);
      if (!YOUTUBE_REVENUE_KINDS.includes(kindCell as LivestreamRevenueKind)) {
        throw new StatementParseError(`invalid_revenue_kind:${kindCell}:row_${rowNumber}`);
      }
      const revenueKind = kindCell as LivestreamRevenueKind;
      const channel = requiredCell(values, "Channel", rowNumber);
      const identifiers = channelDoiCell(values, "Channel DOI", rowNumber);
      const currency = currencyCell(values, rowNumber);

      let detail: LivestreamLineDetail;
      let grossMicros: bigint;
      if (revenueKind === "overlay_alert") {
        const basis = revenueBasisCell(values, rowNumber);
        const alertType = requiredCell(values, "Alert Type", rowNumber);
        let alertMicros: bigint;
        let impressions: number | null = null;
        let cpmMicros: bigint | null = null;
        if (basis === "flat") {
          alertMicros = positiveMoneyCell(values, "Gross Amount (USD)", rowNumber);
        } else {
          impressions = impressionsCell(values, rowNumber);
          cpmMicros = positiveMoneyCell(values, "CPM (USD)", rowNumber);
          alertMicros = overlayCpmGrossMicros(impressions, cpmMicros);
        }
        grossMicros = alertMicros;
        detail = {
          platform: "youtube_live",
          revenueKind,
          alertType,
          revenueBasis: basis,
          impressions,
          cpmMicros,
          virtualCurrencyCode: null,
          virtualAmount: null,
          exchangeRate: null,
          subscriptionTier: null,
          creatorShareBps: null,
          prizePoolBatch: null,
        };
      } else {
        grossMicros = positiveMoneyCell(values, "Gross Amount (USD)", rowNumber);
        detail = {
          platform: "youtube_live",
          revenueKind,
          alertType: null,
          revenueBasis: null,
          impressions: null,
          cpmMicros: null,
          virtualCurrencyCode: null,
          virtualAmount: null,
          exchangeRate: null,
          // The Membership Tier cell names the tier on membership rows —
          // required there, null on Super Chat.
          subscriptionTier:
            revenueKind === "membership"
              ? requiredCell(values, "Membership Tier", rowNumber)
              : null,
          creatorShareBps: null,
          prizePoolBatch: null,
        };
      }

      return livestreamLine(
        "youtube_live_livestream_payouts_csv",
        rowNumber,
        currency,
        grossMicros,
        detail,
        identifiers,
        YOUTUBE_HEADER.map((column) => values.get(column) ?? ""),
        channel,
      );
    });
  },
};

// ---------------------------------------------------------------------------
// Kick subscription report — the tier's gross on the 95/5 split model: the
// creator's share (whole bps, default 9500, contract-configurable through
// the row's share cell) and the platform's exact complement, recorded per
// row so the split is auditable from the queue row alone.
// ---------------------------------------------------------------------------

const KICK_HEADER = [
  "Report Date",
  "Channel",
  "Subscription Tier",
  "Creator Share %",
  "Gross Amount (USD)",
  "Channel DOI",
  "Currency",
] as const;

const kickProfile: StatementProfile = {
  kind: "kick_livestream_payouts_csv",
  title: "Kick subscription report CSV (tiered 95/5 split model)",
  laneRightsType: LIVESTREAM_RIGHTS_TYPE,
  statementSourceType: LIVESTREAM_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, KICK_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, KICK_HEADER);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      reportDateCell(values, rowNumber);
      const channel = requiredCell(values, "Channel", rowNumber);
      const identifiers = channelDoiCell(values, "Channel DOI", rowNumber);
      const currency = currencyCell(values, rowNumber);
      const grossMicros = positiveMoneyCell(values, "Gross Amount (USD)", rowNumber);

      // The applied creator share — the row's contract cell or the 95/5
      // model's default, ALWAYS recorded (the founder's rate-logging rule
      // covers the split rates too).
      const shareBps =
        optionalPercentCell(values, "Creator Share %", rowNumber) ??
        DEFAULT_KICK_CREATOR_SHARE_BPS;
      try {
        validateKickCreatorShareBps(shareBps);
      } catch (error) {
        throw new StatementParseError(
          `${error instanceof RangeError ? error.message : "kick_share_invalid"}:row_${rowNumber}`,
        );
      }

      const detail: LivestreamLineDetail = {
        platform: "kick",
        revenueKind: "subscription",
        alertType: null,
        revenueBasis: null,
        impressions: null,
        cpmMicros: null,
        virtualCurrencyCode: null,
        virtualAmount: null,
        exchangeRate: null,
        subscriptionTier: requiredCell(values, "Subscription Tier", rowNumber),
        creatorShareBps: shareBps,
        prizePoolBatch: null,
      };
      return livestreamLine(
        "kick_livestream_payouts_csv",
        rowNumber,
        currency,
        grossMicros,
        detail,
        identifiers,
        KICK_HEADER.map((column) => values.get(column) ?? ""),
        channel,
      );
    });
  },
};

// ---------------------------------------------------------------------------
// TikTok Live Diamonds report — the Diamond rate is VARIABLE and REQUIRED
// on every row: the conversion at the recorded rate is the founder's
// rate-logging rule, and a Diamond row without its rate is hostile.
// ---------------------------------------------------------------------------

const TIKTOK_HEADER = [
  "Report Date",
  "Creator",
  "Diamonds",
  "Diamond Rate (USD)",
  "Gift Description",
  "Channel DOI",
  "Currency",
] as const;

const tikTokLiveProfile: StatementProfile = {
  kind: "tiktok_live_livestream_payouts_csv",
  title: "TikTok Live Diamonds report CSV (recorded variable rate)",
  laneRightsType: LIVESTREAM_RIGHTS_TYPE,
  statementSourceType: LIVESTREAM_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, TIKTOK_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, TIKTOK_HEADER);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      reportDateCell(values, rowNumber);
      const channel = requiredCell(values, "Creator", rowNumber);
      const identifiers = channelDoiCell(values, "Channel DOI", rowNumber);
      const currency = currencyCell(values, rowNumber);

      // The conversion operands — a hostile row is one the converter
      // cannot verify: a non-positive Diamond balance or a missing/zero
      // rate (a conversion at a zero rate invents money from nothing).
      const diamondsMoney = moneyCell(values, "Diamonds", rowNumber);
      if (diamondsMoney.negative || diamondsMoney.micros <= 0n) {
        throw new StatementParseError(
          `invalid_diamond_amount:${(values.get("Diamonds") ?? "").trim()}:row_${rowNumber}`,
        );
      }
      const rateText = requiredCell(values, "Diamond Rate (USD)", rowNumber);
      const rateMoney = (() => {
        try {
          return parseStatementMoney(rateText);
        } catch (error) {
          if (error instanceof StatementParseError) {
            throw new StatementParseError(
              `invalid_exchange_rate:${rateText}:row_${rowNumber}`,
            );
          }
          throw error;
        }
      })();
      if (rateMoney.negative || rateMoney.micros <= 0n) {
        throw new StatementParseError(
          `invalid_exchange_rate:${rateText}:row_${rowNumber}`,
        );
      }
      const grossMicros = convertVirtualToMicros(diamondsMoney.micros, rateMoney.micros);

      const detail: LivestreamLineDetail = {
        platform: "tiktok_live",
        revenueKind: "diamond",
        alertType: null,
        revenueBasis: null,
        impressions: null,
        cpmMicros: null,
        virtualCurrencyCode: "Diamonds",
        // The exact decimal texts, verbatim — the recorded conversion
        // log (the founder's rate-logging rule), never a recomputation.
        virtualAmount: (values.get("Diamonds") ?? "").trim(),
        exchangeRate: rateText,
        subscriptionTier: null,
        creatorShareBps: null,
        prizePoolBatch: null,
      };
      return livestreamLine(
        "tiktok_live_livestream_payouts_csv",
        rowNumber,
        currency,
        grossMicros,
        detail,
        identifiers,
        TIKTOK_HEADER.map((column) => values.get(column) ?? ""),
        channel,
      );
    });
  },
};

// ---------------------------------------------------------------------------
// Streamlabs/StreamElements overlay alert log — the two platforms share
// one alert format; the Platform cell discriminates the vocabulary.
// Alerts price flat or CPM (sponsor banner impressions).
// ---------------------------------------------------------------------------

const SLSE_HEADER = [
  "Report Date",
  "Platform",
  "Alert Type",
  "Payout Basis",
  "Impressions",
  "CPM (USD)",
  "Gross Amount (USD)",
  "Channel DOI",
  "Currency",
] as const;

const slseProfile: StatementProfile = {
  kind: "streamlabs_streamelements_alerts_csv",
  title: "Streamlabs/StreamElements overlay alert log CSV",
  laneRightsType: LIVESTREAM_RIGHTS_TYPE,
  statementSourceType: LIVESTREAM_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, SLSE_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, SLSE_HEADER);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      reportDateCell(values, rowNumber);
      const platformCell = requiredCell(values, "Platform", rowNumber);
      if (platformCell !== "streamlabs" && platformCell !== "streamelements") {
        throw new StatementParseError(`invalid_platform:${platformCell}:row_${rowNumber}`);
      }
      const platform: MatchQueueStreamPlatform = platformCell;
      const identifiers = channelDoiCell(values, "Channel DOI", rowNumber);
      const currency = currencyCell(values, rowNumber);
      const basis = revenueBasisCell(values, rowNumber);
      const alertType = requiredCell(values, "Alert Type", rowNumber);

      let grossMicros: bigint;
      let impressions: number | null = null;
      let cpmMicros: bigint | null = null;
      if (basis === "flat") {
        grossMicros = positiveMoneyCell(values, "Gross Amount (USD)", rowNumber);
      } else {
        impressions = impressionsCell(values, rowNumber);
        cpmMicros = positiveMoneyCell(values, "CPM (USD)", rowNumber);
        grossMicros = overlayCpmGrossMicros(impressions, cpmMicros);
      }

      const detail: LivestreamLineDetail = {
        platform,
        revenueKind: "overlay_alert",
        alertType,
        revenueBasis: basis,
        impressions,
        cpmMicros,
        virtualCurrencyCode: null,
        virtualAmount: null,
        exchangeRate: null,
        subscriptionTier: null,
        creatorShareBps: null,
        prizePoolBatch: null,
      };
      return livestreamLine(
        "streamlabs_streamelements_alerts_csv",
        rowNumber,
        currency,
        grossMicros,
        detail,
        identifiers,
        SLSE_HEADER.map((column) => values.get(column) ?? ""),
        // No channel column on the alert log — the platform + alert type
        // is the row's display identity.
        `${platform} ${alertType}`,
      );
    });
  },
};

// ---------------------------------------------------------------------------
// Esports tournament prize-pool receipt report — each row funds a batch
// (Prize Pool Batch required) that locks into the esports waterfall's
// per-batch escrow. The waterfall releases the batch only through the
// fail-closed gates; the receipt rows themselves post NOTHING to holding.
// ---------------------------------------------------------------------------

const ESPORTS_HEADER = [
  "Report Date",
  "Tournament",
  "Prize Pool Batch",
  "Placement",
  "Gross Amount (USD)",
  "Team DOI",
  "Currency",
] as const;

const esportsPrizePoolProfile: StatementProfile = {
  kind: "esports_tournament_prize_pool_csv",
  title: "Esports tournament prize pool report CSV (per-batch receipts)",
  laneRightsType: LIVESTREAM_RIGHTS_TYPE,
  statementSourceType: LIVESTREAM_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, ESPORTS_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, ESPORTS_HEADER);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      reportDateCell(values, rowNumber);
      const tournament = requiredCell(values, "Tournament", rowNumber);
      const batch = requiredCell(values, "Prize Pool Batch", rowNumber);
      const identifiers = channelDoiCell(values, "Team DOI", rowNumber);
      const currency = currencyCell(values, rowNumber);
      const grossMicros = positiveMoneyCell(values, "Gross Amount (USD)", rowNumber);

      const detail: LivestreamLineDetail = {
        // A tournament payout is not a stream platform's row — the
        // prize_pool_batch cell is the receipt row's identity.
        platform: null,
        revenueKind: "prize_pool",
        alertType: null,
        revenueBasis: null,
        impressions: null,
        cpmMicros: null,
        virtualCurrencyCode: null,
        virtualAmount: null,
        exchangeRate: null,
        subscriptionTier: null,
        creatorShareBps: null,
        prizePoolBatch: batch,
      };
      return livestreamLine(
        "esports_tournament_prize_pool_csv",
        rowNumber,
        currency,
        grossMicros,
        detail,
        identifiers,
        ESPORTS_HEADER.map((column) => values.get(column) ?? ""),
        tournament,
      );
    });
  },
};

/** The livestream lane's profiles — dispatched through the shared dispatcher. */
export const LIVESTREAM_PROFILES: readonly StatementProfile[] = [
  twitchProfile,
  youtubeLiveProfile,
  kickProfile,
  tikTokLiveProfile,
  slseProfile,
  esportsPrizePoolProfile,
];

/** True when a dispatched profile is the livestream lane's. */
export function isLivestreamProfileKind(kind: StatementProfile["kind"]): boolean {
  return (
    kind === "twitch_livestream_payouts_csv" ||
    kind === "youtube_live_livestream_payouts_csv" ||
    kind === "kick_livestream_payouts_csv" ||
    kind === "tiktok_live_livestream_payouts_csv" ||
    kind === "streamlabs_streamelements_alerts_csv" ||
    kind === "esports_tournament_prize_pool_csv"
  );
}
