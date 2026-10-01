/**
 * CVT recon worker — the livestream lane's converter math (PR 14, founder
 * livestream directive).
 *
 * Pure functions only — no store, no clock. The money discipline is the
 * house fixed-point canon: 1e-8 micros as bigint in memory, exact decimal
 * text on the row, integer cents in the ledger — never a float.
 *
 *   Twitch Bits convert at 0.01 dollars per bit NET (the founder rate —
 *   one cent per bit, configurable per contract through the report's rate
 *   cell, always recorded on the conversion log).
 *
 *   TikTok Diamonds convert at the variable platform rate RECORDED ON THE
 *   ROW — a Diamond row without its rate is a hostile row (a conversion at
 *   an unrecorded rate cannot be audited).
 *
 *   Kick subscriptions split on the 95/5 model: the creator's share is
 *   whole basis points (default 9500, contract-configurable through the
 *   row's share cell), the platform takes the exact complement.
 *
 *   Sponsorship overlay alerts price flat (the payout cell) or CPM
 *   (impressions × cost-per-mille / 1000 — exact bigint division, the
 *   sub-micro residue floors away, never rounds up).
 */

/** House micro-dollar scale: 1 dollar = 1e8 statement micros (the SDK's 1e-8 space). */
export const MICROS_PER_DOLLAR = 100_000_000n;

/** The founder's Twitch Bits rate: $0.01 per bit, creator net. */
export const DEFAULT_BITS_NET_RATE = "0.01";

/** The Kick 95/5 split model: the creator's default share is 9500 bps. */
export const DEFAULT_KICK_CREATOR_SHARE_BPS = 9500;

/** The org-cut band for the esports prize-pool waterfall (15–30%). */
export const ESPORTS_ORG_CUT_MIN_BPS = 1500;
export const ESPORTS_ORG_CUT_MAX_BPS = 3000;

/**
 * Converts an exact virtual amount at an exact fiat-per-unit rate into the
 * fiat gross in micros — the same exact bigint product the gaming DevEx
 * converter runs: (virtual micros × rate micros) / 1e8, floored, the
 * sub-micro residue never rounding up. Negative operands are refused by
 * the parsers upstream; this guard is the math module's own belt.
 */
export function convertVirtualToMicros(
  virtualAmountMicros: bigint,
  rateMicros: bigint,
): bigint {
  if (virtualAmountMicros < 0n || rateMicros < 0n) {
    throw new Error(
      `negative_conversion_operand:${virtualAmountMicros}:${rateMicros}`,
    );
  }
  return (virtualAmountMicros * rateMicros) / MICROS_PER_DOLLAR;
}

/**
 * The Kick 95/5 split model: the creator's floor share at whole basis
 * points, the platform taking the exact complement — creator + fee equals
 * the gross by construction, so no rounding can invent or lose a micro.
 */
export function splitKickSubscription(
  grossMicros: bigint,
  creatorShareBps: number,
): { creatorNetMicros: bigint; platformFeeMicros: bigint } {
  if (!Number.isSafeInteger(creatorShareBps) || creatorShareBps <= 0 || creatorShareBps >= 10000) {
    throw new Error(`invalid_kick_creator_share:${creatorShareBps}`);
  }
  if (grossMicros < 0n) {
    throw new Error(`negative_kick_gross:${grossMicros}`);
  }
  const creatorNetMicros = (grossMicros * BigInt(creatorShareBps)) / 10000n;
  return { creatorNetMicros, platformFeeMicros: grossMicros - creatorNetMicros };
}

/**
 * A CPM sponsorship overlay's gross: impressions × cost-per-mille / 1000
 * (the per-mille division in exact bigint — a CPM price is per THOUSAND
 * impressions). Negative operands refused; the residue floors away.
 */
export function overlayCpmGrossMicros(
  impressions: number,
  cpmMicros: bigint,
): bigint {
  if (!Number.isSafeInteger(impressions) || impressions < 0) {
    throw new Error(`invalid_cpm_impressions:${impressions}`);
  }
  if (cpmMicros < 0n) {
    throw new Error(`negative_cpm_rate:${cpmMicros}`);
  }
  return (BigInt(impressions) * cpmMicros) / 1000n;
}

/** Validates a contract-configured Kick creator share — (0, 10000) exclusive. */
export function validateKickCreatorShareBps(creatorShareBps: number): void {
  if (
    !Number.isSafeInteger(creatorShareBps) ||
    creatorShareBps <= 0 ||
    creatorShareBps >= 10000
  ) {
    throw new RangeError(
      `kick_creator_share_out_of_band:${creatorShareBps}: the Kick split model requires the creator share strictly between 0% and 100%`,
    );
  }
}

/**
 * The queue event id for one livestream report row — the lane's identity
 * space (`livestream:line:`), ingest-scoped. A stream payout row is plain
 * money with no cross-platform impression to dedupe, so replay idempotency
 * rides the queue's UNIQUE event_id exactly like every other lane.
 */
export function livestreamLineEventId(
  platform: string,
  ingestId: string,
  lineNumber: number,
): string {
  return `livestream:line:${platform}:${ingestId}:line:${lineNumber}`;
}

/**
 * The queue event id for one esports prize-pool receipt row — the
 * `esports:pool:` space carries the batch ref so recovery paths can name
 * the batch a receipt funds without parsing payloads.
 */
export function esportsPrizePoolLineEventId(
  batchRef: string,
  ingestId: string,
  lineNumber: number,
): string {
  return `esports:pool:${batchRef}:${ingestId}:line:${lineNumber}`;
}

/**
 * The content-derived conversion-log event id — one log per funding line.
 * A replayed ingest re-derives the same id, the read finds the row, and
 * the write is a counted no-op (the UNIQUE constraint is the arbiter).
 */
export function livestreamConversionEventId(lineEventId: string): string {
  return `livestream:conv:${lineEventId}`;
}
