/**
 * Universal Royalty Collection SDK — record vocabulary for the collection
 * surfaces (migration 0007, PR 3 of Generation 16). snake_case fields match
 * the database columns 1:1 (the Store seam convention — records are the
 * rows). These types are re-exported through the Store seam
 * (src/lib/server/store.ts); SDK PRs 4+ (clearance, matcher, parsers)
 * consume them and never touch store files.
 *
 * MUL = Multi-Use License (the master-use license register). CBT = the
 * canonical catalog asset code (CVT/CBT lineage, project overview). Fixed
 * money stays text micros — never floats (immutability rule).
 */

import type { SyncLicenseType } from '../../../covnant-sdk/src/contracts/syncLibraryMarketplace';

/** The four canonical rights pipelines (build spec art_MzwqTXym). */
export type RightsPipeline =
  | 'composition_performance'
  | 'composition_mechanical'
  | 'master_digital_performance'
  | 'master_interactive';

/** Statement file formats the ingest provenance records can hold. */
export type StatementFormat = 'cwr' | 'ddex' | 'csv_statement';

/** Where an ingest's bytes came from. */
export type StatementSource = 'statement' | 'manual';

/** Parse outcome for one ingested statement file. */
export type StatementIngestStatus = 'parsed' | 'failed';

/** Match-queue lifecycle: quarantined → matched | discarded. */
export type MatchQueueStatus = 'open' | 'matched' | 'discarded';

/**
 * Where a quarantined event arrived from — the canonical royalty event's
 * ingress vocabulary (covnant-sdk/src/contracts/royalty-event.ts), carried
 * verbatim so queue provenance never folds a webhook or API-pull event
 * into the statement-ingest vocabulary below.
 */
export type MatchQueueSource = 'webhook' | 'statement' | 'api_pull';

/**
 * Rights family for a line item (V1 rights-separation directive addendum,
 * 2026-09-30): split math must never conflate recording royalties with
 * composition royalties. Quarantine rule: 'unknown' rows are excluded from
 * split math until reclassified — the tag is explicit, never guessed from
 * `rights_pipeline` (which records usage kind, not rights family).
 */
export type MatchQueueRightsType = 'master' | 'publishing' | 'unknown';

/**
 * Statement kinds the film waterfall ingests (V1 film-waterfall directive
 * addendum, 2026-09-30); null means not classified (the music lane). The
 * existing ingress/platform columns cannot distinguish these.
 */
export type MatchQueueStatementSourceType =
  | 'vod'
  | 'svod'
  | 'theatrical_box_office'
  | 'international_sales_agent'
  | 'game_platform';

/**
 * Podcast revenue lanes (V1 podcast directive addendum, 2026-09-30):
 * IAB-qualified DAI programmatic, host-read sponsor/affiliate, and
 * subscription membership; null = non-podcast lines.
 */
export type MatchQueueRevenueChannel =
  | 'channel_a_dai'
  | 'channel_b_host_read'
  | 'channel_c_subscription';

/** Pod positions for ad lines; null for non-ad lines. */
export type MatchQueueAdSlot = 'pre_roll' | 'mid_roll' | 'post_roll';

/** Game-platform sale types (V1 gaming directive addendum, 2026-09-30). */
export type MatchQueueSaleType = 'primary' | 'secondary_resale';

/**
 * Stream sources for livestream lines (V1 livestream directive addendum,
 * 2026-09-30); null = non-livestream.
 */
export type MatchQueueStreamPlatform =
  | 'twitch'
  | 'youtube_live'
  | 'kick'
  | 'tiktok_live'
  | 'streamlabs'
  | 'streamelements';

/** Sponsor payout basis — flat or CPM; null when not sponsorship lines. */
export type MatchQueueRevenueBasis = 'flat' | 'cpm';

/**
 * Ad delivery method (V1 podcast feed directive addendum, 2026-09-30) —
 * independent of the revenue_channel lane (host-read copy can be served
 * through DAI); null = no ad placement context.
 */
export type MatchQueueAdPlacementType = 'host_read' | 'dai';

/**
 * Publication formats (V1 publishing directive addendum, 2026-09-30);
 * null = not classified.
 */
export type MatchQueuePublicationFormat =
  | 'print'
  | 'digital_chapter'
  | 'coin_unlock'
  | 'kenp_page_read'
  | 'audio';

/**
 * Theatrical licensing class (V1 live-theater directive addendum, 2026-09-30);
 * null = not classified. Distinct from MatchQueueRightsType — a Grand Rights
 * line is publishing-family; this carries only the routing class.
 */
export type MatchQueueLicenseClass = 'grand_rights' | 'small_rights';

/** MUL clearance lifecycle (append-only history in mul_clearance_transitions). */
export type MulClearanceState = 'draft' | 'requested' | 'cleared' | 'disputed';

/** The current MUL clearance state for one catalog asset — upsert per asset. */
export interface MulClearanceRecord {
  asset_cbt_code: string;
  state: MulClearanceState;
  licensee: string | null;
  territory: string | null;
  term_start: string | null;
  term_end: string | null;
  updated_at: string;
}

/** One append-only state transition in an asset's clearance history. */
export interface MulClearanceTransitionRecord {
  id: string;
  asset_cbt_code: string;
  from_state: MulClearanceState | null;
  to_state: MulClearanceState;
  note: string | null;
  created_at: string;
}

/** The caller's decision when closing a quarantined event. */
export type MatchQueueResolution =
  | { status: 'matched'; cbtCode: string }
  | { status: 'discarded' };

/**
 * One quarantined royalty event awaiting exact match — the raw payload is
 * preserved verbatim so recovery never re-parses from lossy intermediates.
 */
export interface MatchQueueRecord {
  id: string;
  event_id: string;
  status: MatchQueueStatus;
  reason: string;
  rights_pipeline: RightsPipeline;
  /** Rights family — see MatchQueueRightsType for the quarantine rule. */
  rights_type: MatchQueueRightsType;
  /** Film waterfall tier, 0 through 5; null rides the non-waterfall lane. */
  tier_level: number | null;
  /** Film statement kind; null = not classified (music lane). */
  statement_source_type: MatchQueueStatementSourceType | null;
  /** Podcast revenue lane; null = non-podcast lines. */
  revenue_channel: MatchQueueRevenueChannel | null;
  /** Pod position for ad lines; null for non-ad lines. */
  ad_slot: MatchQueueAdSlot | null;
  /** Ad-verified impressions; null when unverified or non-ad. */
  verified_impressions: number | null;
  /** Network-sold inventory flag; null = unknown or not applicable. */
  network_sold: boolean | null;
  /** Game-platform sale type; null = not applicable (non-game lines). */
  sale_type: MatchQueueSaleType | null;
  /** Platform virtual-currency denomination (Robux, V-Bucks, Coins, ...). */
  virtual_currency_code: string | null;
  /** Exact virtual amount as decimal text — never a float. */
  virtual_amount: string | null;
  /** Fiat-per-virtual-unit exchange rate as exact decimal text. */
  exchange_rate: string | null;
  /** Engine royalty, fixed-point micros as text — never a float. */
  engine_royalty_micros: string | null;
  /** Platform commission, fixed-point micros as text — never a float. */
  platform_commission_micros: string | null;
  /** Upstream asset a derivative item or mod builds on; null = original. */
  parent_asset_id: string | null;
  /** Stream source for livestream lines; null = non-livestream. */
  stream_platform: MatchQueueStreamPlatform | null;
  /** Sponsor overlay alert type (donation, sub, follow, ...); null = none. */
  alert_type: string | null;
  /** Sponsor payout basis — flat or CPM; null when not sponsorship lines. */
  revenue_basis: MatchQueueRevenueBasis | null;
  /** Esports prize-pool batch context; waterfall steps reuse tier_level. */
  prize_pool_batch: string | null;
  /** Upstream composition a sample or interpolation builds on; null = original. */
  parent_composition_id: string | null;
  /** HFA/MLC statutory cover flag; null = not classified. */
  is_cover_version: boolean | null;
  /** Withholding jurisdiction for film tax; separate from the market territory. */
  territory_code: string | null;
  /** Whether foreign tax was withheld; null = unknown. */
  foreign_tax_withheld: boolean | null;
  /** Podcast feed the line maps to; null = not feed-scoped. */
  rss_feed_id: string | null;
  /** Ad delivery method; independent of the revenue_channel lane. */
  ad_placement_type: MatchQueueAdPlacementType | null;
  /** Publication format; null = not classified. */
  format_type: MatchQueuePublicationFormat | null;
  /** Per-language feed isolation code; null = not language-scoped. */
  language_code: string | null;
  /** Physical inventory SKU the merch line maps to; null = non-merch. */
  sku_id: string | null;
  /** Per-unit cost of goods for FIFO amortization, micros as text — never a float. */
  cogs_per_unit_micros: string | null;
  /** AI metering unit — tokens, characters, minutes, ...; null = not metered. */
  usage_unit: string | null;
  /** Metered usage amount as exact decimal text — never a float. */
  usage_quantity: string | null;
  /** ISBN of the book title; null = non-book lines. */
  isbn: string | null;
  /** Publishing localization market — separate from the film tax jurisdiction. */
  country_code: string | null;
  /** AI model whose inference produced the line; null = non-AI lines. */
  ai_model_id: string | null;
  /** Fractional dataset-attribution weight as exact decimal text — never a float. */
  dataset_attribution_weight: string | null;
  /** Art object the line maps to; null = non-art lines. */
  artwork_id: string | null;
  /** Provenance-chain hash anchoring the line for verification. */
  provenance_hash: string | null;
  /** Cross-border resale-right jurisdiction — distinct tax/localization codes. */
  jurisdiction_code: string | null;
  /** Live production the line maps to; null = non-theatrical lines. */
  production_id: string | null;
  /** Venue the performance ran at; null = non-theatrical lines. */
  venue_id: string | null;
  /** Performance date as an ISO date string; null = non-performance lines. */
  show_date: string | null;
  /** Grand Rights vs small rights routing class; the rule ships in PRs 30/31. */
  license_class: MatchQueueLicenseClass | null;
  /** License agreement the line falls under; null = non-licensed lines. */
  license_id: string | null;
  /** Licensed product category; null = unclassified lines. */
  category_code: string | null;
  /** License territorial grant scope — distinct from tax/localization/resale. */
  territory_iso: string | null;
  /** Athlete the NIL line maps to; null = non-NIL lines. */
  athlete_id: string | null;
  /** Athletic program (school) the NIL line maps to; null = non-NIL lines. */
  school_id: string | null;
  /** US state whose NIL statute governs the line — distinct from art resale. */
  state_jurisdiction_code: string | null;
  /** Spatial zone within the venue; null = non-spatial lines. */
  zone_code: string | null;
  /** Zone footprint in square feet, exact-decimal text; null = non-spatial. */
  spatial_footprint_sqft: string | null;
  /** Workout IP trainer for fitness streams and class check-ins. */
  trainer_id: string | null;
  /** Fitness program — the module-weighted waterfall key. */
  program_id: string | null;
  /** Boutique franchise location code; null = non-franchise lines. */
  studio_franchise_code: string | null;
  /** Recipe IP chef for culinary streams and ghost-kitchen lines. */
  chef_id: string | null;
  /** Licensed recipe for culinary royalty lines. */
  recipe_id: string | null;
  /** Producing ghost-kitchen location; null = non-culinary lines. */
  ghost_kitchen_location_id: string | null;
  /** Service IP stylist for salon and med-spa lines. */
  stylist_id: string | null;
  /** Hospitality or salon franchise location. */
  salon_location_id: string | null;
  /** Licensed treatment protocol (service IP); null = non-service lines. */
  protocol_id: string | null;
  /** Software IP developer for dev-tool royalty lines. */
  developer_id: string | null;
  /** Metered API endpoint reference; null = non-API lines. */
  api_endpoint_id: string | null;
  /** Distributed SDK package build hash; null = non-package lines. */
  sdk_package_hash: string | null;
  /** Licensed hardware patent family; null = non-patent lines. */
  patent_family_id: string | null;
  /** Standard-essential patent pool code; null = non-pool lines. */
  sep_pool_code: string | null;
  /** Device-level IMEI or MAC identifier; null = non-device lines. */
  device_imei_mac: string | null;
  /** Land or resource parcel for energy royalty lines. */
  parcel_id: string | null;
  /** Producing well or meter identifier; null = non-resource lines. */
  well_meter_id: string | null;
  /** Compute cluster identifier for GPU-hosting lines. */
  gpu_cluster_hash: string | null;
  /** NIL endorsement contract reference; null = non-NIL lines. */
  nil_contract_id: string | null;
  /** Athlete Global Location Number; null = non-athlete lines. */
  athlete_glan: string | null;
  /** Venue Global Location Number; null = non-venue lines. */
  venue_gln: string | null;
  /** League broadcasting and group-licensing rights code; null = non-league lines. */
  league_rights_code: string | null;
  /** Turnstile scan telemetry hash for gate reconciliation; null = non-gate lines. */
  turnstile_scan_hash: string | null;
  /** The event's ingress source, verbatim from the canonical event. */
  source: MatchQueueSource;
  platform: string | null;
  territory: string | null;
  period: string | null;
  currency: string | null;
  /** Fixed-point gross in micros — text, never a float. */
  gross_micros: string | null;
  /** Parsed identifiers (ISRC/ISWC/ISNI/IPI-CAE…) as JSON text. */
  identifiers_json: string | null;
  raw_payload: string;
  matched_cbt_code: string | null;
  resolved_at: string | null;
  created_at: string;
}

/** Provenance record for one ingested statement file. */
export interface StatementIngestRecord {
  id: string;
  format: StatementFormat;
  source: StatementSource;
  file_name: string;
  content: string;
  status: StatementIngestStatus;
  event_count: number | null;
  error: string | null;
  created_at: string;
}

// --- Sync Library catalog + purchases (migration 0008 — the
//     SyncMarketplaceRegistry amendment, spec art_ZIdWlYUX) ---

/**
 * The migration-0008 catalog columns for one asset, keyed by its CBT code.
 * NOT a new asset table — the asset's identity (title, medium, rights
 * holders) stays in cbt_assets; these are the additive sync-library columns
 * the amendment locks, projected per backend. `is_pre_cleared` is the
 * pending pre-clearance state: registrations land false and only a gated
 * administrator action flips them.
 */
export interface SyncCatalogItemRecord {
  cbt_code: string;
  is_pre_cleared: boolean;
  sync_fee_cents: number;
  genre: string;
  bpm: number | null;
  updated_at: string;
}

/**
 * The licensing settlement lane's write-back record — one settled sync
 * license purchase. `cbt_settlement_stamp` is the server-minted stamp
 * (withCbtSettlementCode over the purchase reference); UNIQUE, and the
 * replay key: duplicate purchases land on the idempotent existing row.
 * `split_run_id` links the single calculateUdrSplits run that partitioned
 * the fee 50/35/15 and credited the tier vaults. `metadata` carries the
 * withCbtSettlementCode merge output — the cbt lineage tag, same provenance
 * shape the settlement wire stamps onto ledger rows.
 */
export interface SyncLicensePurchaseRecord {
  id: string;
  cvt_asset_tag: string;
  buyer_uct: string;
  license_type: SyncLicenseType;
  fee_paid_cents: number;
  cbt_settlement_stamp: string;
  split_run_id: string;
  metadata: Record<string, unknown>;
  created_at: string;
}
