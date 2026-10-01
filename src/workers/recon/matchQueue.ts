/**
 * CVT recon worker — match_queue writer.
 *
 * Normalized statement lines land in the EXISTING match_queue through the
 * shared store seam (all three backends), one row per line, idempotent by
 * the queue's unique `event_id` constraint: a re-processed ingest is a
 * no-op per row, never a duplicate. Cross-referencing runs through the
 * vault adapter's `findByIdentifier` — the same exact-match surface every
 * other lane uses, so canonicalization has a single opinion — and a hit
 * fills `matched_cbt_code`; a miss leaves the row honestly unmatched (no
 * fuzzy linking, no invented matches).
 */

import type { MatchQueueRecord } from "@/modules/sdk/records";
import type { Store } from "@/lib/server/store";
import type { VaultAssetRecord, VaultExternalIdentifierKind } from "@/lib/covnant/vault";
import type { ParsedStatementLine, ReconIdentifierKind } from "./records";

/** True when the error is any backend's unique-constraint violation. */
export function isUniqueViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("UNIQUE constraint failed") ||
    message.includes("duplicate key value violates unique constraint")
  );
}

/**
 * Deterministic event id — stable across re-parses of the same ingest. The
 * id carries the line's identity space: plain receipt lines live under
 * `line:`, guild residual holds under `residual:<guild>:` — a hold spreads
 * its receipt line (same lineNumber), so the discriminator is what keeps
 * the obligation row from colliding with the receipt row's unique
 * event_id and being silently dropped as a replay.
 */
export function reconEventId(ingestId: string, line: ParsedStatementLine): string {
  const guild = line.guildResidual?.guild;
  return guild === undefined
    ? `recon:${ingestId}:line:${line.lineNumber}`
    : `recon:${ingestId}:residual:${guild}:${line.lineNumber}`;
}

/**
 * Fixed cross-reference priority: recording code, then work code, then the
 * release code, then the film title code. First hit wins — the priority is
 * part of the contract, pinned by fixtures. `satisfies` proves every kind
 * is BOTH a parsed identifier kind (safe queue-row index) and a vault-
 * ingestible kind (safe findByIdentifier argument) — no assertion anywhere.
 */
const LOOKUP_PRIORITY = ["ISRC", "ISWC", "UPC", "EIDR"] as const satisfies readonly (VaultExternalIdentifierKind &
  ReconIdentifierKind)[];

/**
 * The worker's vault handle. Production wires it to the vault adapter's
 * findByIdentifier over the app's pg pool; the stub tests wire a fake.
 * Returns the matched asset or null — never throws for "not found".
 */
export interface VaultLookup {
  findByIdentifier(
    kind: VaultExternalIdentifierKind,
    value: string,
  ): Promise<VaultAssetRecord | null>;
}

/**
 * Builds the full match_queue row for one parsed line. Every column is
 * explicit — the closed-record type keeps the builder honest as the queue
 * schema grows.
 */
export function buildMatchQueueRow(
  line: ParsedStatementLine,
  eventId: string,
  reason: string,
): Omit<MatchQueueRecord, "id"> {
  return {
    event_id: eventId,
    status: "open",
    reason,
    rights_pipeline: line.rightsPipeline,
    rights_type: line.rightsType,
    tier_level: line.tierLevel,
    statement_source_type: line.statementSourceType,
    revenue_channel: null,
    ad_slot: null,
    verified_impressions: null,
    network_sold: null,
    sale_type: null,
    virtual_currency_code: null,
    virtual_amount: null,
    exchange_rate: null,
    engine_royalty_micros: null,
    platform_commission_micros: null,
    parent_asset_id: null,
    stream_platform: null,
    alert_type: null,
    revenue_basis: null,
    prize_pool_batch: null,
    parent_composition_id: null,
    is_cover_version: null,
    territory_code: null,
    foreign_tax_withheld: null,
    rss_feed_id: null,
    ad_placement_type: null,
    format_type: null,
    language_code: null,
    sku_id: null,
    cogs_per_unit_micros: null,
    usage_unit: null,
    usage_quantity: null,
    isbn: null,
    country_code: null,
    ai_model_id: null,
    dataset_attribution_weight: null,
    artwork_id: null,
    provenance_hash: null,
    jurisdiction_code: null,
    production_id: null,
    venue_id: null,
    show_date: null,
    license_class: null,
    license_id: null,
    category_code: null,
    territory_iso: null,
    athlete_id: null,
    school_id: null,
    state_jurisdiction_code: null,
    zone_code: null,
    spatial_footprint_sqft: null,
    trainer_id: null,
    program_id: null,
    studio_franchise_code: null,
    chef_id: null,
    recipe_id: null,
    ghost_kitchen_location_id: null,
    stylist_id: null,
    salon_location_id: null,
    protocol_id: null,
    developer_id: null,
    api_endpoint_id: null,
    sdk_package_hash: null,
    patent_family_id: null,
    sep_pool_code: null,
    device_imei_mac: null,
    parcel_id: null,
    well_meter_id: null,
    gpu_cluster_hash: null,
    nil_contract_id: null,
    athlete_glan: null,
    venue_gln: null,
    league_rights_code: null,
    turnstile_scan_hash: null,
    resolved_chain: null,
    resolved_identifiers: null,
    // The UNCLAIMED_IDENTIFIER_HOLD escrow marker is PR 7's decision —
    // this writer never preempts it.
    unclaimed_identifier_hold: false,
    identifier_hold_reason: null,
    source: "statement",
    platform: line.platform,
    territory: line.territory,
    period: line.period,
    currency: line.currency,
    gross_micros: line.grossMicros.toString(),
    identifiers_json: JSON.stringify(line.identifiers),
    raw_payload: JSON.stringify({
      profile: line.profile,
      line_number: line.lineNumber,
      usage_note: line.usageNote,
      raw: line.raw,
      guild_residual: line.guildResidual,
    }),
    matched_cbt_code: null,
    resolved_at: null,
    created_at: new Date().toISOString(),
  } satisfies Omit<MatchQueueRecord, "id">;
}

/** Cross-reference result for one line — the vault hit or an honest miss. */
export interface LineMatchResult {
  matchedCbtCode: string | null;
}

/** Looks the line's identifiers up in the vault, fixed priority, first hit. */
export async function crossReferenceLine(
  line: ParsedStatementLine,
  vault: VaultLookup,
): Promise<LineMatchResult> {
  for (const kind of LOOKUP_PRIORITY) {
    const value = line.identifiers[kind];
    if (value === undefined) continue;
    const asset = await vault.findByIdentifier(kind, value);
    if (asset !== null) {
      return { matchedCbtCode: asset.cbtCode };
    }
  }
  return { matchedCbtCode: null };
}

/**
 * One line's write outcome — the canonical posting seam's input (the
 * activated PR 2 → PR 7 wiring). Produced here so the vault lookup is
 * never duplicated downstream: the posting pass re-derives nothing.
 */
export interface LineWriteOutcome {
  line: ParsedStatementLine;
  eventId: string;
  matchedCbtCode: string | null;
  /** false = the row already existed (a replay wrote nothing). */
  written: boolean;
}

/** Aggregate write outcome for one ingest — the completion result's core. */
export interface MatchQueueWriteCounts {
  written: number;
  alreadyPresent: number;
  matched: number;
  unmatched: number;
  /** Per-line detail, in write order — the canonical posting seam's input. */
  lineOutcomes: LineWriteOutcome[];
}

/**
 * Writes every parsed line into match_queue idempotently, cross-referencing
 * the vault first so each row lands with its match state already honest.
 * `vault === null` (no DATABASE_URL in the worker's environment) skips the
 * lookups — the caller surfaces that in the completion result rather than
 * letting an unlabeled vault-less run pass as verified matching.
 */
export async function writeLinesToMatchQueue(
  store: Store,
  ingestId: string,
  lines: readonly ParsedStatementLine[],
  vault: VaultLookup | null,
): Promise<MatchQueueWriteCounts> {
  const counts: MatchQueueWriteCounts = {
    written: 0,
    alreadyPresent: 0,
    matched: 0,
    unmatched: 0,
    lineOutcomes: [],
  };
  for (const line of lines) {
    const match =
      vault === null ? { matchedCbtCode: null } : await crossReferenceLine(line, vault);
    const eventId = reconEventId(ingestId, line);
    const row = buildMatchQueueRow(
      line,
      eventId,
      `recon:${line.profile}`,
    );
    try {
      await store.insertMatchQueueEntry({ ...row, matched_cbt_code: match.matchedCbtCode });
      counts.written += 1;
      if (match.matchedCbtCode === null) counts.unmatched += 1;
      else counts.matched += 1;
      counts.lineOutcomes.push({
        line,
        eventId,
        matchedCbtCode: match.matchedCbtCode,
        written: true,
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      counts.alreadyPresent += 1;
      // The row already exists — still record the outcome so a replayed
      // pass re-enters the posting seam and reads the replay guard instead
      // of silently assuming the money never posted.
      counts.lineOutcomes.push({
        line,
        eventId,
        matchedCbtCode: match.matchedCbtCode,
        written: false,
      });
    }
  }
  return counts;
}
