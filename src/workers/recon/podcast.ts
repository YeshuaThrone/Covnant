/**
 * CVT recon worker — the podcast IAB v2/v3 qualification engine (PR 10,
 * founder podcast directive + multi-feed directive patch).
 *
 * Every podcast revenue line passes the IAB Podcast Measurement pipeline
 * BEFORE any revenue counts — bot filtering, the 24-hour single-IP download
 * dedup window, and the 60-second audio request threshold — and only then
 * converts into CPM units and Channel A revenue. The module is PURE:
 * deterministic bigint integer math, no clock, no store, no float anywhere
 * (the house fixed-point discipline — 1e-8 micros in, whole cents out,
 * sub-cent residue never rounds up).
 *
 * The three IAB gates, in order, each with an honest rejection counter:
 *
 *   1. BOT FILTER — a pinned user-agent token list (IAB known-device/bot
 *      practice). A bot line never qualifies, never counts.
 *   2. 24-HOUR SINGLE-IP DEDUP — within (rss_feed_id, episode, ip), the
 *      first-qualified audio request anchors a 24-hour window; every request
 *      inside the window is a duplicate of that download. A request at or
 *      past 24h re-qualifies and re-anchors. Ad insertions sharing the
 *      anchor's exact request timestamp are the SAME download's distinct ad
 *      units — they qualify (per-request DAI logs stamp one request's
 *      insertions with the request timestamp), and the cross-feed
 *      fingerprint's creative/slot components keep them distinct.
 *   3. 60-SECOND THRESHOLD — an audio request below 60 seconds is not a
 *      qualified download. A line that cannot verify the threshold is
 *      rejected as unverifiable (the profile makes the column required, so
 *      in practice the parser refuses the row first — the engine still
 *      refuses defensively; fail-closed twice is once too rarely).
 *
 * Cross-feed deduplication (the multi-feed directive patch): the SAME
 * impression reported through different platform dumps (Spotify Video,
 * Apple Podcasts, YouTube RSS) of one audio feed must count once. The
 * engine derives the impression identity from CONTENT — sha256 over
 * feed | episode | ip | UTC day | creative | slot — so two platforms'
 * reports of one listening session collapse to one match_queue event_id
 * (the queue's UNIQUE event_id is the dedup arbiter across ingests; no
 * new table, no new column). UTC-day bucketing is the deterministic,
 * replay-safe encoding of the 24-hour rule across files: same-day reports
 * of the same session dedupe; a same-key request a later UTC day lands on
 * is a genuinely new listening session.
 *
 * Channel attribution (the A/B/C tagging):
 *   Channel A — channel_a_dai, programmatic DAI per CPM tier (pre/mid/post
 *   roll): revenue = impressions × CPM / 1000, exact bigint floor.
 *   Channel B — channel_b_host_read, host-read and affiliate direct deals:
 *   revenue recognizes ONLY on sponsor verification; an unverified sponsor
 *   parks the line in the podcast-held quarantine id space (visible, never
 *   dropped, never counted as revenue).
 *   Channel C — channel_c_subscription, subscription/membership recurring:
 *   exact recurring money, no listener-qualification inputs (no impression
 *   exists), ingest-scoped event ids.
 *
 * Commission (the network management deduction): on network-sold inventory
 * with DAI placement, the contract's commission rate — validated into the
 * 20-40% band at parse time — deducts BEFORE creator net lands in the Gold
 * Note ledger: the queue row records the deduction (platform_commission_
 * micros) and the posting pass posts the NET to holding. HOST_READ
 * attribution bypasses the DAI commission entirely (direct deal), and
 * direct-sold (network_sold=false) carries no network commission.
 */

import { createHash } from "node:crypto";

import type { ParsedStatementLine, PodcastLineDetail } from "./records";

/** The pinned bot/automation user-agent tokens (IAB known-device practice). */
export const BOT_USER_AGENT_TOKENS: readonly string[] = [
  "bot",
  "crawler",
  "spider",
  "curl",
  "wget",
  "python-requests",
  "python-urllib",
  "java/",
  "headlesschrome",
  "phantomjs",
  "facebookexternalhit",
  "monitoring",
  "preview",
  "validator",
];

/** IAB 60-second audio request threshold — a qualified download requests
 * at least 60 seconds of audio. */
export const AUDIO_SECONDS_THRESHOLD = 60;

/** The 24-hour single-IP download deduplication window (ms). */
export const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The network management commission band — configurable per contract
 * within 20-40% of gross (2000-4000 bps); outside the band is a hostile
 * row, rejected at parse time. */
export const MIN_COMMISSION_BPS = 2000;
export const MAX_COMMISSION_BPS = 4000;

/** Impressions per CPM unit. */
export const IMPRESSIONS_PER_MILLE = 1000n;

/** True when the user agent carries any pinned bot token (case-insensitive). */
export function isBotUserAgent(userAgent: string): boolean {
  const lowered = userAgent.toLowerCase();
  return BOT_USER_AGENT_TOKENS.some((token) => lowered.includes(token));
}

/** The 60-second threshold — a request below it is not a qualified download. */
export function passesAudioThreshold(audioSeconds: number): boolean {
  return audioSeconds >= AUDIO_SECONDS_THRESHOLD;
}

/** Normalizes a listener IP for the dedup key — trimmed, lowercased. */
export function normalizeListenerIp(ip: string): string {
  return ip.trim().toLowerCase();
}

/** The UTC day bucket of a request timestamp — the cross-file dedup epoch. */
export function utcDayBucket(requestedAt: Date): string {
  return requestedAt.toISOString().slice(0, 10);
}

/**
 * The impression identity fingerprint — content-derived, ingest-independent:
 * two platform dumps reporting one listening session produce the same hex.
 * Identity is WHAT was delivered (feed, episode, listener, day, creative,
 * slot), never how it was monetized — a channel label is a state, not an
 * identity attribute.
 */
export function impressionFingerprint(detail: PodcastLineDetail): string {
  const identity = [
    detail.rssFeedId,
    detail.episodeId,
    detail.listenerIp ?? "",
    utcDayBucket(detail.requestedAt),
    detail.adCreativeId ?? "",
    detail.adSlot ?? "",
    detail.adPlacementType,
  ].join("|");
  return createHash("sha256").update(identity).digest("hex");
}

/**
 * The event-id spaces. `podcast:imp:` counts (posts); `podcast:held:` is
 * the sponsor-unverified quarantine (visible, never posts); both are
 * fingerprint-keyed — a later VERIFIED report of an unverified impression
 * writes the real `podcast:imp:` row while the held row stays as the
 * honest quarantine record. Subscription lines are ingest-scoped (a
 * re-report is a new row; recurring money has no impression to dedupe).
 */
export function podcastImpressionEventId(detail: PodcastLineDetail): string {
  return `podcast:imp:${impressionFingerprint(detail)}`;
}

export function podcastHeldEventId(detail: PodcastLineDetail): string {
  return `podcast:held:${impressionFingerprint(detail)}`;
}

export function podcastSubscriptionEventId(
  ingestId: string,
  lineNumber: number,
): string {
  return `podcast:sub:${ingestId}:line:${lineNumber}`;
}

/**
 * CPM conversion — impressions × CPM / 1000 in exact 1e-8 micros, bigint
 * floor. The CPM tier's per-impression revenue never rounds up: a value
 * that does not divide evenly leaves sub-micro residue on the floor (the
 * queue row's exact gross_micros preserves the full precision; the ledger
 * posts whole cents only).
 */
export function cpmRevenueMicros(impressions: number, cpmMicros: bigint): bigint {
  if (!Number.isSafeInteger(impressions) || impressions <= 0) {
    throw new Error(`invalid_impressions:${impressions}`);
  }
  if (cpmMicros <= 0n) {
    throw new Error(`invalid_cpm:${cpmMicros}`);
  }
  return (BigInt(impressions) * cpmMicros) / IMPRESSIONS_PER_MILLE;
}

/**
 * Network commission — gross × bps / 10000 in exact 1e-8 micros, bigint
 * floor. HOST_READ placement bypasses the commission entirely (direct
 * attribution), and only network-sold inventory is commission-bearing.
 */
export function networkCommissionMicros(
  grossMicros: bigint,
  detail: PodcastLineDetail,
): bigint {
  const isCommissionBearing =
    detail.adPlacementType === "dai" && detail.networkSold === true;
  if (!isCommissionBearing) return 0n;
  const bps = detail.commissionBps;
  if (bps === null || bps < MIN_COMMISSION_BPS || bps > MAX_COMMISSION_BPS) {
    throw new Error(`commission_out_of_band:${String(bps)}`);
  }
  return (grossMicros * BigInt(bps)) / 10000n;
}

/**
 * One line's qualification verdict — every non-qualifying line names its
 * gate; the counts are the completion report's honest inputs.
 */
export type QualificationVerdict =
  | "qualified"
  | "bot_filtered"
  | "duplicate_deduped"
  | "short_request_rejected"
  | "unverifiable_rejected";

/** The qualification outcome for one podcast log's impression-bearing lines. */
export interface QualificationCounts {
  qualified: number;
  botsFiltered: number;
  duplicatesDeduped: number;
  shortRequestsRejected: number;
  unverifiableRejected: number;
}

export interface QualificationResult {
  /** Lines that passed all three IAB gates, in qualification order. */
  qualified: readonly ParsedStatementLine[];
  /** Per-line verdicts, in input order — the queue writer's input. */
  verdicts: ReadonlyMap<number, QualificationVerdict>;
  counts: QualificationCounts;
}

/**
 * Runs the IAB pipeline over one log's impression-bearing podcast lines
 * (Channel A and B; Channel C subscription lines are plain money rows and
 * qualify by construction). Deterministic: the dedup window processes the
 * lines in (timestamp, raw row) order and anchors on first-qualified.
 */
export function qualifyImpressionLines(
  lines: readonly ParsedStatementLine[],
): QualificationResult {
  const counts: QualificationCounts = {
    qualified: 0,
    botsFiltered: 0,
    duplicatesDeduped: 0,
    shortRequestsRejected: 0,
    unverifiableRejected: 0,
  };
  const verdicts = new Map<number, QualificationVerdict>();

  // Impression-bearing lines only — subscription lines carry no listener
  // identity to qualify.
  const candidates = lines.filter(
    (line) =>
      line.podcastDetail !== null &&
      line.podcastDetail.revenueChannel !== "channel_c_subscription",
  );
  const others = lines.filter(
    (line) =>
      line.podcastDetail !== null &&
      line.podcastDetail.revenueChannel === "channel_c_subscription",
  );
  for (const line of others) verdicts.set(line.lineNumber, "qualified");

  // Deterministic processing order: request timestamp, then raw row order.
  const ordered = [...candidates].sort((a, b) => {
    const at = a.podcastDetail?.requestedAt.getTime() ?? 0;
    const bt = b.podcastDetail?.requestedAt.getTime() ?? 0;
    if (at !== bt) return at < bt ? -1 : 1;
    return a.lineNumber - b.lineNumber;
  });

  // The dedup state: one anchor per (feed, episode, ip) download space.
  const anchors = new Map<string, number>();
  const qualifiedInOrder: ParsedStatementLine[] = [];

  for (const line of ordered) {
    const detail = line.podcastDetail;
    if (detail === null) continue;

    // Gate 1 — bot filter.
    if (detail.userAgent !== null && isBotUserAgent(detail.userAgent)) {
      verdicts.set(line.lineNumber, "bot_filtered");
      counts.botsFiltered += 1;
      continue;
    }

    // Gate 2 — the 60-second audio request threshold (fail-closed on an
    // unverifiable request: the profile requires the column, the engine
    // refuses defensively anyway).
    if (detail.audioSeconds === null) {
      verdicts.set(line.lineNumber, "unverifiable_rejected");
      counts.unverifiableRejected += 1;
      continue;
    }
    if (!passesAudioThreshold(detail.audioSeconds)) {
      verdicts.set(line.lineNumber, "short_request_rejected");
      counts.shortRequestsRejected += 1;
      continue;
    }

    // Gate 3 — the 24-hour single-IP dedup window. The window anchors on
    // the first-qualified request; insertions sharing the anchor's exact
    // request timestamp are the same download's distinct ad units.
    const key = `${detail.rssFeedId}|${detail.episodeId}|${detail.listenerIp ?? ""}`;
    const anchor = anchors.get(key);
    const at = detail.requestedAt.getTime();
    if (
      anchor !== undefined &&
      at >= anchor &&
      at < anchor + DEDUP_WINDOW_MS &&
      at !== anchor
    ) {
      verdicts.set(line.lineNumber, "duplicate_deduped");
      counts.duplicatesDeduped += 1;
      continue;
    }
    anchors.set(key, at);
    verdicts.set(line.lineNumber, "qualified");
    counts.qualified += 1;
    qualifiedInOrder.push(line);
  }

  return { qualified: qualifiedInOrder, verdicts, counts };
}
