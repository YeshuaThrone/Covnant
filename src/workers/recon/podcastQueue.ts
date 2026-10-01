/**
 * CVT recon worker — the podcast lane's match_queue writer (PR 10).
 *
 * Reuses the music lane's builder for the closed record's 90+ explicit
 * columns and overrides ONLY the podcast ones — one source of truth for the
 * null columns, zero drift between lanes. Event ids come from the engine's
 * three identity spaces (`podcast:imp:` / `podcast:held:` / `podcast:sub:`),
 * so cross-feed deduplication is the queue's UNIQUE event_id constraint —
 * the same replay guard every other lane rides, no new table, no new column.
 *
 * Only QUALIFIED lines and subscription lines are written: a bot-filtered
 * or deduped-out line was never an impression (IAB semantics — filtering
 * is not dropping, the verbatim ingest bytes and the completion counts are
 * the audit trail), and a queue row carrying revenue that does not exist
 * would be worse than no row. Unverified host-read sponsors DO write —
 * into the `podcast:held:` quarantine space, visible and never counted.
 */

import type { MatchQueueRecord } from "@/modules/sdk/records";
import type { Store } from "@/lib/server/store";
import type { ParsedStatementLine } from "./records";
import { StatementParseError } from "./records";
import {
  networkCommissionMicros,
  podcastHeldEventId,
  podcastImpressionEventId,
  podcastSubscriptionEventId,
} from "./podcast";
import {
  buildMatchQueueRow,
  isUniqueViolation,
  type VaultLookup,
} from "./matchQueue";

/** True when the line parks in the sponsor-unverified quarantine space. */
export function isPodcastHeldLine(line: ParsedStatementLine): boolean {
  const detail = line.podcastDetail;
  return (
    detail !== null &&
    detail.revenueChannel === "channel_b_host_read" &&
    detail.sponsorVerified === false
  );
}

/** The event id for one podcast line — the engine's identity spaces. */
export function podcastEventId(
  line: ParsedStatementLine,
  ingestId: string,
): string {
  const detail = line.podcastDetail;
  if (detail === null) {
    throw new StatementParseError(`podcast_detail_missing:row_${line.lineNumber}`);
  }
  if (detail.revenueChannel === "channel_c_subscription") {
    return podcastSubscriptionEventId(ingestId, line.lineNumber);
  }
  // Channel B revenue recognizes on sponsor verification — an unverified
  // sponsor parks in the held quarantine space (visible, never counted,
  // never posted). A later VERIFIED report writes the real `podcast:imp:`
  // row; the held row stays as the quarantine record.
  return isPodcastHeldLine(line)
    ? podcastHeldEventId(detail)
    : podcastImpressionEventId(detail);
}

/**
 * Builds the match_queue row for one podcast line. The commission is
 * computed HERE — at write time, from the row's own facts — so the queue
 * row records the deduction (platform_commission_micros) before any
 * posting happens: fail-closed ordering, the row is the source of truth
 * and the posting pass re-derives nothing.
 */
export function buildPodcastQueueRow(
  line: ParsedStatementLine,
  eventId: string,
  reason: string,
  matchedCbtCode: string | null,
): Omit<MatchQueueRecord, "id"> {
  const detail = line.podcastDetail;
  if (detail === null) {
    throw new StatementParseError(`podcast_detail_missing:row_${line.lineNumber}`);
  }
  const commission = networkCommissionMicros(line.grossMicros, detail);
  const base = buildMatchQueueRow(line, eventId, reason);
  return {
    ...base,
    matched_cbt_code: matchedCbtCode,
    revenue_channel: detail.revenueChannel,
    ad_slot: detail.adSlot,
    verified_impressions: detail.impressions,
    network_sold: detail.networkSold,
    platform_commission_micros: commission.toString(),
    rss_feed_id: detail.rssFeedId,
    ad_placement_type: detail.adPlacementType,
    raw_payload: JSON.stringify({
      profile: line.profile,
      line_number: line.lineNumber,
      usage_note: line.usageNote,
      raw: line.raw,
      podcast: {
        revenue_channel: detail.revenueChannel,
        ad_slot: detail.adSlot,
        ad_placement_type: detail.adPlacementType,
        rss_feed_id: detail.rssFeedId,
        episode_id: detail.episodeId,
        ad_creative_id: detail.adCreativeId,
        listener_ip: detail.listenerIp,
        user_agent: detail.userAgent,
        requested_at: detail.requestedAt.toISOString(),
        audio_seconds: detail.audioSeconds,
        sponsor_verified: detail.sponsorVerified,
        network_sold: detail.networkSold,
        commission_bps: detail.commissionBps,
        cpm_micros: detail.cpmMicros === null ? null : detail.cpmMicros.toString(),
        impressions: detail.impressions,
        held: isPodcastHeldLine(line),
      },
    }),
  } satisfies Omit<MatchQueueRecord, "id">;
}

/** Per-line podcast write outcome — the posting pass's input. */
export interface PodcastLineOutcome {
  line: ParsedStatementLine;
  eventId: string;
  matchedCbtCode: string | null;
  /** false = the row already existed (a replay wrote nothing). */
  written: boolean;
  /** The queue row's commission deduction, exact micros as text. */
  commissionMicros: string;
}

/** Aggregate podcast write counts — the completion result's podcast block. */
export interface PodcastWriteCounts {
  written: number;
  alreadyPresent: number;
  /** Rows parked in the sponsor-unverified quarantine space. */
  heldWritten: number;
  matched: number;
  unmatched: number;
  /** Per-line detail, in write order — the posting pass's input. */
  lineOutcomes: PodcastLineOutcome[];
}

/**
 * Writes every qualified podcast line (and every Channel C line) into
 * match_queue idempotently, cross-referencing the vault by DOI first.
 * `vault === null` skips lookups exactly like the music lane — the caller
 * surfaces an unlabeled vault-less run instead of passing it off as
 * verified matching.
 */
export async function writePodcastLinesToMatchQueue(
  store: Store,
  ingestId: string,
  lines: readonly ParsedStatementLine[],
  vault: VaultLookup | null,
): Promise<PodcastWriteCounts> {
  const counts: PodcastWriteCounts = {
    written: 0,
    alreadyPresent: 0,
    heldWritten: 0,
    matched: 0,
    unmatched: 0,
    lineOutcomes: [],
  };
  for (const line of lines) {
    const detail = line.podcastDetail;
    if (detail === null) continue;
    const eventId = podcastEventId(line, ingestId);
    // DOI cross-reference — the podcast lane's only identifier kind.
    let matchedCbtCode: string | null = null;
    const doi = line.identifiers.DOI;
    if (vault !== null && doi !== undefined) {
      const asset = await vault.findByIdentifier("DOI", doi);
      if (asset !== null) matchedCbtCode = asset.cbtCode;
    }
    if (matchedCbtCode !== null) counts.matched += 1;
    else counts.unmatched += 1;

    const row = buildPodcastQueueRow(
      line,
      eventId,
      `recon:podcast:${line.profile}:line:${line.lineNumber}`,
      matchedCbtCode,
    );
    let written = true;
    try {
      await store.insertMatchQueueEntry(row);
      counts.written += 1;
      if (isPodcastHeldLine(line)) counts.heldWritten += 1;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // A replay: the row already exists (same event_id) — nothing is
      // written and nothing double-counts. The outcome rides along so the
      // posting pass re-derives the same no-op the music lane does.
      written = false;
      counts.alreadyPresent += 1;
    }
    counts.lineOutcomes.push({
      line,
      eventId,
      matchedCbtCode,
      written,
      commissionMicros: row.platform_commission_micros ?? "0",
    });
  }
  return counts;
}
