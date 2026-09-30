/**
 * Recon job request/callback validation (spec art_7M0snhxc, build item 2).
 *
 * The enqueue body is deliberately tiny — {source, ingest_id?} — because
 * the enqueue route is the UCT layer's ONE write: it validates the shape,
 * checks ownership where the schema can prove it, inserts one row, and
 * returns 202. `source` reuses the statement_ingests vocabulary (the
 * recon worker parses statements these rows describe); `ingest_id` is a
 * UUID referencing that table.
 *
 * The callback body is the pg_net completion webhook's payload: the
 * migration's trigger POSTs {job_id, status, error, result} — the result
 * summary is the worker's own outcome (written before the trigger fired),
 * carried through for the missed-trigger fallback so the callback never
 * invents counts.
 */

import { z } from 'zod';

import { RECON_JOB_SOURCES } from './records';

/** Announced terminal statuses the callback applies (the trigger's vocabulary). */
export const RECON_CALLBACK_STATUSES = ['completed', 'failed'] as const;

/**
 * Rights-family vocabulary (V1 rights-separation directive addendum,
 * 2026-09-30). REQUIRED on ingest payloads: split math never conflates
 * recording royalties ('master') with composition royalties ('publishing'),
 * and 'unknown' quarantines the row until reclassified — the parser tags
 * every line item explicitly, never guesses from rights_pipeline.
 */
export const RECON_RIGHTS_TYPES = ['master', 'publishing', 'unknown'] as const;

/**
 * Film-waterfall statement kinds (V1 film-waterfall directive addendum 2,
 * 2026-09-30). OPTIONAL on ingest payloads (nullable): null means not
 * classified (the music lane).
 */
export const RECON_STATEMENT_SOURCE_TYPES = [
  'vod',
  'svod',
  'theatrical_box_office',
  'international_sales_agent',
] as const;

/** Required rights-family tag for every parsed line item. */
export const reconRightsTypeSchema = z.enum(RECON_RIGHTS_TYPES);

/** Optional film waterfall tier — 0 through 5, or null (non-waterfall lane). */
export const reconTierLevelSchema = z.number().int().min(0).max(5).nullable();

/** Optional film statement kind. */
export const reconStatementSourceTypeSchema =
  z.enum(RECON_STATEMENT_SOURCE_TYPES).nullable();

/**
 * Podcast revenue vocabulary (V1 podcast directive addendum, 2026-09-30).
 * Podcast ingest payloads carry these; other verticals leave them null.
 */
export const RECON_REVENUE_CHANNELS = [
  'channel_a_dai',
  'channel_b_host_read',
  'channel_c_subscription',
] as const;
export const RECON_AD_SLOTS = ['pre_roll', 'mid_roll', 'post_roll'] as const;

/** Optional podcast revenue lane; null = non-podcast lines. */
export const reconRevenueChannelSchema =
  z.enum(RECON_REVENUE_CHANNELS).nullable();

/** Optional pod position for ad lines; null for non-ad lines. */
export const reconAdSlotSchema = z.enum(RECON_AD_SLOTS).nullable();

/** Optional ad-verified impression count (non-negative); null when unverified. */
export const reconVerifiedImpressionsSchema =
  z.number().int().min(0).nullable();

/** Optional network-sold inventory flag; null = unknown or not applicable. */
export const reconNetworkSoldSchema = z.boolean().nullable();

/**
 * Gaming revenue vocabulary (V1 gaming directive addendum, 2026-09-30).
 * Gaming ingest payloads carry these; other verticals leave them null.
 */
export const RECON_SALE_TYPES = ['primary', 'secondary_resale'] as const;

/** Optional game-platform sale type; null = not applicable. */
export const reconSaleTypeSchema = z.enum(RECON_SALE_TYPES).nullable();

/**
 * Exact-decimal text for virtual amounts, exchange rates, and money micros —
 * the table's fixed-point convention (never a float); null when not carried.
 */
export const reconExactDecimalSchema = z
  .string()
  .regex(/^\d+(\.\d+)?$/)
  .nullable();

/** Optional platform virtual-currency denomination (Robux, V-Bucks, Coins...). */
export const reconVirtualCurrencyCodeSchema = z.string().min(1).nullable();

/**
 * Livestream and publication vocabularies (V1 directive addenda 5 and 7,
 * 2026-09-30). Livestream ingest payloads carry stream platforms, sponsor
 * alert types, and prize-pool batches; publishing payloads carry formats
 * and language codes; other verticals leave them null.
 */
export const RECON_STREAM_PLATFORMS = [
  'twitch',
  'youtube_live',
  'kick',
  'tiktok_live',
  'streamlabs',
  'streamelements',
] as const;

/** Optional stream platform for livestream lines; null = non-livestream. */
export const reconStreamPlatformSchema =
  z.enum(RECON_STREAM_PLATFORMS).nullable();

/** Optional sponsor payout basis — flat or CPM; null when not sponsorship. */
export const reconRevenueBasisSchema = z.enum(['flat', 'cpm']).nullable();

/**
 * Optional ad delivery method — independent of the revenue_channel lane
 * (host-read copy can be served through DAI); null when no ad context.
 */
export const reconAdPlacementTypeSchema =
  z.enum(['host_read', 'dai']).nullable();

/** Optional publication format; null = not classified. */
export const RECON_PUBLICATION_FORMATS = [
  'print',
  'digital_chapter',
  'coin_unlock',
  'kenp_page_read',
  'audio',
] as const;
export const reconPublicationFormatSchema =
  z.enum(RECON_PUBLICATION_FORMATS).nullable();

/** Optional upstream cbt_assets id — derivative assets and compositions. */
export const reconParentAssetIdSchema = z.uuid().nullable();

/** Optional non-empty text labels — alert types, prize pools, feeds, codes. */
export const reconShortTextSchema = z.string().min(1).nullable();

/** Optional boolean flags — cover versions, foreign tax, network-sold. */
export const reconBooleanFlagSchema = z.boolean().nullable();

/**
 * Merch and AI metering (V1 directive addendum 8, 2026-09-30). Merch
 * payloads carry SKUs and per-unit COGS; AI payloads carry metering units
 * and quantities; other verticals leave them null.
 */
export const reconSkuIdSchema = z.string().min(1).nullable();

/** Optional per-unit cost of goods — fixed-point micros as text, never a float. */
export const reconCogsPerUnitSchema = reconExactDecimalSchema;

/** Optional AI metering unit — tokens, characters, minutes, ... */
export const reconUsageUnitSchema = z.string().min(1).nullable();

/** Optional metered usage amount as exact decimal text — never a float. */
export const reconUsageQuantitySchema = reconExactDecimalSchema;

/**
 * Books and AI attribution (V1 directive addendum 9, 2026-09-30). Book
 * payloads carry ISBNs and localization markets; AI payloads carry model ids
 * and attribution weights; other verticals leave them null.
 */
export const reconIsbnSchema = z.string().min(1).nullable();

/**
 * Optional publishing localization market — deliberately separate from
 * territory_code (the film tax jurisdiction).
 */
export const reconCountryCodeSchema = z.string().min(1).nullable();

/** Optional AI model whose inference produced the line. */
export const reconAiModelIdSchema = z.string().min(1).nullable();

/** Optional fractional attribution weight as exact decimal text — never a float. */
export const reconDatasetAttributionWeightSchema = reconExactDecimalSchema;

/**
 * Art market (V1 directive addendum 10, 2026-09-30). Art payloads carry
 * object ids, provenance hashes, and resale jurisdictions; other verticals
 * leave them null.
 */
export const reconArtworkIdSchema = z.string().min(1).nullable();

/** Optional provenance-chain hash anchoring the line for verification. */
export const reconProvenanceHashSchema = z.string().min(1).nullable();

/**
 * Optional cross-border resale-right jurisdiction — deliberately separate
 * from territory_code (film tax) and country_code (publishing localization).
 */
export const reconJurisdictionCodeSchema = z.string().min(1).nullable();

/**
 * Live theater and comedy (V1 directive addendum 11, 2026-09-30). Theatrical
 * payloads carry production/venue ids, the show date, and the licensing
 * routing class; other verticals leave them null.
 */
export const reconProductionIdSchema = z.string().min(1).nullable();

/** Optional venue the performance ran at. */
export const reconVenueIdSchema = z.string().min(1).nullable();

/** Optional performance date as an ISO date string (YYYY-MM-DD). */
export const reconShowDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .nullable();

/**
 * Optional Grand Rights vs small rights routing class — the routing rule
 * itself ships in allocator PRs 30/31. Deliberately NOT a rights_type value:
 * a Grand Rights line is publishing-family; this carries only the class.
 */
export const reconLicenseClassSchema = z
  .enum(['grand_rights', 'small_rights'])
  .nullable();

/**
 * Brand licensing (V1 directive addendum 12, 2026-09-30). Licensing payloads
 * carry the license agreement, product category, and territorial grant
 * scope; other verticals leave them null.
 */
export const reconLicenseIdSchema = z.string().min(1).nullable();

/** Optional licensed product category. */
export const reconCategoryCodeSchema = z.string().min(1).nullable();

/**
 * Optional license territorial grant scope — deliberately separate from
 * territory_code (film tax), country_code (publishing localization), and
 * jurisdiction_code (art resale).
 */
export const reconTerritoryIsoSchema = z.string().min(1).nullable();

/**
 * NIL (name, image, likeness) (V1 directive addendum 13, 2026-09-30). NIL
 * payloads carry athlete/program ids and the governing state statute; other
 * verticals leave them null.
 */
export const reconAthleteIdSchema = z.string().min(1).nullable();

/** Optional athletic program (school) the line maps to. */
export const reconSchoolIdSchema = z.string().min(1).nullable();

/**
 * Optional US state whose NIL statute governs the line — deliberately
 * separate from jurisdiction_code (art cross-border resale).
 */
export const reconStateJurisdictionCodeSchema = z.string().min(1).nullable();

/**
 * Spatial / location-based entertainment (V1 directive addendum 14 founder
 * patch, 2026-09-30). zone_code locates the line within the venue; other
 * verticals leave it null.
 */
export const reconZoneCodeSchema = z.string().min(1).nullable();

/** Optional zone footprint in square feet — exact-decimal text. */
export const reconSpatialFootprintSqftSchema = z.string().min(1).nullable();

/**
 * Fitness / connected-wellness (V1 directive addendum 15 founder patch,
 * 2026-09-30). trainer_id keys workout IP, program_id is the module-weighted
 * waterfall key, and studio_franchise_code is the founder-patched boutique
 * franchise location code.
 */
export const reconTrainerIdSchema = z.string().min(1).nullable();

/** Optional fitness program reference — module-weighted waterfall key. */
export const reconProgramIdSchema = z.string().min(1).nullable();

/** Optional boutique franchise location code — founder-patched column. */
export const reconStudioFranchiseCodeSchema = z.string().min(1).nullable();

/**
 * Culinary / ghost-kitchen (V1 directive addendum 16, 2026-09-30,
 * founder-specified). chef_id and recipe_id key recipe IP;
 * ghost_kitchen_location_id tracks the producing kitchen.
 */
export const reconChefIdSchema = z.string().min(1).nullable();

/** Optional licensed recipe reference for culinary royalty lines. */
export const reconRecipeIdSchema = z.string().min(1).nullable();

/** Optional producing ghost-kitchen location. */
export const reconGhostKitchenLocationIdSchema = z.string().min(1).nullable();

/**
 * Salon / med-spa / hospitality franchise (V1 directive addendum 17 founder
 * patch, 2026-09-30). stylist_id keys service IP, protocol_id is the
 * licensed treatment protocol, and salon_location_id is the franchise
 * location — founder-patched names replacing the addendum-17 originals.
 */
export const reconStylistIdSchema = z.string().min(1).nullable();

/** Optional licensed treatment protocol (service IP). */
export const reconProtocolIdSchema = z.string().min(1).nullable();

/** Optional hospitality or salon franchise location. */
export const reconSalonLocationIdSchema = z.string().min(1).nullable();

/**
 * Developer tools (V1 directive addendum 18, 2026-09-30,
 * founder-specified). developer_id keys software IP, api_endpoint_id maps
 * metered API usage, and sdk_package_hash identifies the distributed
 * package build.
 */
export const reconDeveloperIdSchema = z.string().min(1).nullable();

/** Optional metered API endpoint reference. */
export const reconApiEndpointIdSchema = z.string().min(1).nullable();

/** Optional distributed SDK package build hash. */
export const reconSdkPackageHashSchema = z.string().min(1).nullable();

/**
 * Hardware patent (V1 directive addendum 19, 2026-09-30,
 * founder-specified). patent_family_id keys the licensed family,
 * sep_pool_code identifies the standard-essential pool, and
 * device_imei_mac carries the device-level hardware identifier.
 */
export const reconPatentFamilyIdSchema = z.string().min(1).nullable();

/** Optional standard-essential patent pool code. */
export const reconSepPoolCodeSchema = z.string().min(1).nullable();

/** Optional device-level IMEI or MAC identifier. */
export const reconDeviceImeiMacSchema = z.string().min(1).nullable();

/**
 * Energy and resource (V1 directive addendum 20, 2026-09-30,
 * founder-specified). parcel_id keys the land parcel, well_meter_id carries
 * the producing meter, and gpu_cluster_hash identifies the compute cluster.
 */
export const reconParcelIdSchema = z.string().min(1).nullable();

/** Optional producing well or meter identifier. */
export const reconWellMeterIdSchema = z.string().min(1).nullable();

/** Optional compute cluster identifier for GPU-hosting lines. */
export const reconGpuClusterHashSchema = z.string().min(1).nullable();

/**
 * Sports ticketing (V1 directive addendum 21, 2026-09-30,
 * founder-specified). nil_contract_id ties lines to the endorsement,
 * athlete_glan and venue_gln carry the GLN identifiers, league_rights_code
 * keys league-broadcast and group-licensing rights, and
 * turnstile_scan_hash anchors gate-reconciliation to scan telemetry.
 */
export const reconNilContractIdSchema = z.string().min(1).nullable();

/** Optional athlete Global Location Number. */
export const reconAthleteGlanSchema = z.string().min(1).nullable();

/** Optional venue Global Location Number. */
export const reconVenueGlnSchema = z.string().min(1).nullable();

/** Optional league broadcasting and group-licensing rights code. */
export const reconLeagueRightsCodeSchema = z.string().min(1).nullable();

/** Optional turnstile scan telemetry hash for gate reconciliation. */
export const reconTurnstileScanHashSchema = z.string().min(1).nullable();

/** The worker's outcome summary — schema-validated, never invented here. */
const reconJobResultSchema = z.object({
  events_written: z.number().int().min(0),
  matched: z.number().int().min(0),
  unmatched: z.number().int().min(0),
  engine_used: z.string().min(1).nullable(),
});

export const reconJobRequestSchema = z.object({
  source: z.enum(RECON_JOB_SOURCES),
  ingest_id: z.uuid().optional(),
});

export const reconJobCallbackSchema = z.object({
  job_id: z.uuid(),
  status: z.enum(RECON_CALLBACK_STATUSES),
  error: z.string().min(1).nullish(),
  result: reconJobResultSchema.nullish(),
});

export type ReconJobCallbackPayload = z.infer<typeof reconJobCallbackSchema>;

export type ReconJobRequestParse =
  | { ok: true; value: { source: (typeof RECON_JOB_SOURCES)[number]; ingest_id?: string } }
  | { ok: false; message: string };

/** Parses the enqueue body into the store input's shape, or a 422 message. */
export function parseReconJobRequest(body: unknown): ReconJobRequestParse {
  const parsed = reconJobRequestSchema.safeParse(body);
  if (parsed.success) return { ok: true, value: parsed.data };
  const first = parsed.error.issues[0];
  const field = first?.path?.join('.') ?? 'body';
  return {
    ok: false,
    message: `Invalid recon job request: ${field} — ${first?.message ?? 'malformed payload'}.`,
  };
}

export type ReconJobCallbackParse =
  | { ok: true; value: ReconJobCallbackPayload }
  | { ok: false; message: string };

/** Parses the signed callback body, or a 422 message. */
export function parseReconJobCallback(body: unknown): ReconJobCallbackParse {
  const parsed = reconJobCallbackSchema.safeParse(body);
  if (parsed.success) return { ok: true, value: parsed.data };
  const first = parsed.error.issues[0];
  const field = first?.path?.join('.') ?? 'body';
  return {
    ok: false,
    message: `Invalid recon job callback: ${field} — ${first?.message ?? 'malformed payload'}.`,
  };
}
