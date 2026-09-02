/**
 * Covenant MCP Harness
 * ====================
 * A Model Context Protocol server that exposes the vendored CovenantMasterSDK
 * (v2.0.0, src/engine/covenant-master-sdk.ts) as MCP tools over stdio.
 *
 * The engine is vendored byte-for-byte and is NEVER modified here — this
 * harness is a thin adapter. Every tool maps 1:1 onto a public engine method:
 *
 *   register_asset            -> CovenantMasterSDK.registerCBTAsset
 *   lookup_asset              -> CovenantMasterSDK.getOrHydrateAsset
 *   validate_splits           -> CovenantMasterSDK.validateSplits
 *   settle_royalties          -> CovenantMasterSDK.processRoyaltySettlement
 *   tax_form_requirement      -> CovenantTaxEngine.DetermineTaxFormRequirement
 *   tax_effective_rate        -> CovenantTaxEngine.calculateEffectiveTaxRate
 *   audit_system              -> CovenantAuditorAgent.RunFullSystemAudit
 *   register_platform_allowlist -> CovenantGlobalSocialEngine.registerGlobalAllowlist
 *   process_social_claim      -> CovenantGlobalSocialEngine.processGlobalClaimEvent
 *
 * Persistence: when NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are
 * set, a Supabase client is handed to the engine for asset hydration; without
 * them the engine runs purely in-memory (registered via register_asset).
 * Platform fee: COVNANT_PLATFORM_FEE_PCT (e.g. "0.1" = 10%).
 *
 * Run:  npx tsx mcp/server.ts
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import {
  CovenantAuditorAgent,
  CovenantMasterSDK,
  CovenantTaxEngine,
  CovenantGlobalSocialEngine,
} from "../src/engine/covenant-master-sdk";

/* ------------------------------------------------------------------ */
/* Engine wiring                                                       */
/* ------------------------------------------------------------------ */

const PLATFORM_FEE_PCT = Number(process.env.COVNANT_PLATFORM_FEE_PCT ?? "0");

function buildDbClient(): SupabaseClient | undefined {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && key ? createClient(url, key) : undefined;
}

const sdk = new CovenantMasterSDK(PLATFORM_FEE_PCT, buildDbClient());
const auditor = new CovenantAuditorAgent(sdk);
const social = new CovenantGlobalSocialEngine(sdk);

/* ------------------------------------------------------------------ */
/* Schemas mirroring the engine's interfaces (lines 23-187)            */
/* ------------------------------------------------------------------ */

const mediaMediumEnum = [
  "MUSIC_TRACK", "MUSIC_ALBUM", "SHEET_MUSIC", "FEATURE_FILM", "TV_SHOW",
  "TV_SEASON", "TV_EPISODE", "PODCAST_EPISODE", "AUDIOBOOK", "PRINT_BOOK",
  "EBOOK", "MAGAZINE_SERIAL", "VIDEO_GAME", "LIVE_STREAM", "MARS_ORBITAL_BROADCAST",
] as const;

const currencyEnum = [
  "USD", "EUR", "GBP", "CAD", "AUD", "JPY", "MXN", "BRL", "INR", "CNY",
  "SAT", "ETH", "SOL", "MARS_CREDIT",
] as const;

const socialPlatformEnum = [
  "META_FB_IG", "TIKTOK", "YOUTUBE_CONTENT_ID", "TWITCH", "SNAPCHAT",
  "TRILLER", "X_TWITTER", "DISCORD", "APPLE_MUSIC", "SPOTIFY",
  "ROBLOX", "EPIC_GAMES_UE5",
] as const;

const taxFormEnum = [
  "W9_US_PERSON", "W8BEN_FOREIGN_INDIVIDUAL", "W8BEN_E_FOREIGN_ENTITY", "EXEMPT",
] as const;

const rightsHolderRoleEnum = [
  "COMPOSER", "LYRICIST", "PRODUCER", "DIRECTOR", "ACTOR",
  "PUBLISHER", "STUDIO", "HOST", "DISTRIBUTOR",
] as const;

const identifiersSchema = z
  .object({
    isrc: z.string().optional(),
    iswc: z.string().optional(),
    ismn: z.string().optional(),
    grid: z.string().optional(),
    eidrCanonical: z.string().optional(),
    isanHex: z.string().optional(),
    isbn: z.string().optional(),
    issn: z.string().optional(),
    gtin: z.string().optional(),
    guid: z.string().optional(),
    mlc_work_id: z.string().optional(),
    hfa_song_id: z.string().optional(),
    prs_tunecode: z.string().optional(),
  })
  .strict();

const taxProfileSchema = z
  .object({
    taxFormType: z.enum(taxFormEnum),
    taxIdentifierEncrypted: z.string(),
    usTaxResident: z.boolean(),
    treatyCountryCode: z.string().optional(),
    treatyWithholdingRate: z.number().min(0).max(0.3).optional(),
    isBackupWithholdingRequired: z.boolean(),
    formExpirationTimestamp: z.number().optional(),
    isVerified: z.boolean(),
  })
  .strict();

const bankRoutingSchema = z
  .object({
    accountHolderName: z.string(),
    bankName: z.string(),
    accountNumberOrIBAN: z.string(),
    routingOrBIC: z.string(),
    intermediaryBankBIC: z.string().optional(),
    currency: z.string(),
    countryCode: z.string(),
    planetaryJurisdiction: z.enum(["EARTH", "MARS", "ORBITAL"]),
    railType: z.string(),
  })
  .strict();

const rightsHolderSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    role: z.enum(rightsHolderRoleEnum),
    isni: z.string().optional(),
    ipi: z.string().optional(),
    splitPercentage: z.number(),
    taxProfile: taxProfileSchema,
    payoutRouting: bankRoutingSchema,
    confirmedByArtist: z.boolean(),
  })
  .strict();

/* ------------------------------------------------------------------ */
/* Server + tools                                                      */
/* ------------------------------------------------------------------ */

const mcp = new McpServer({ name: "covnant-engine", version: "2.0.0" });

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function ok(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function fail(error: unknown): ToolResult {
  return {
    content: [{ type: "text", text: `Engine error: ${error instanceof Error ? error.message : String(error)}` }],
    isError: true,
  };
}

mcp.tool(
  "register_asset",
  "Register a Covenant Block asset (validates that rights-holder splits total exactly 100%, generates a per-medium CBT code, and stores the asset in the engine registry).",
  {
    title: z.string(),
    medium: z.enum(mediaMediumEnum),
    mappedIdentifiers: identifiersSchema,
    rightsHolders: z.array(rightsHolderSchema).min(1),
  },
  async ({ title, medium, mappedIdentifiers, rightsHolders }) => {
    try {
      return ok(await sdk.registerCBTAsset(title, medium, mappedIdentifiers, rightsHolders));
    } catch (e) {
      return fail(e);
    }
  },
);

mcp.tool(
  "lookup_asset",
  "Resolve an asset by CBT code from engine memory, hydrating from Supabase when a DB client is configured.",
  { cbtCode: z.string() },
  async ({ cbtCode }) => {
    try {
      return ok(await sdk.getOrHydrateAsset(cbtCode));
    } catch (e) {
      return fail(e);
    }
  },
);

mcp.tool(
  "validate_splits",
  "Validate that rights-holder splits total exactly 100.0000% (engine tolerance ±1 at scale 10,000). Throws with the exact current sum on failure.",
  { rightsHolders: z.array(rightsHolderSchema).min(1) },
  async ({ rightsHolders }) => {
    try {
      sdk.validateSplits(rightsHolders);
      return ok({ valid: true, totalPercentage: 100 });
    } catch (e) {
      return fail(e);
    }
  },
);

mcp.tool(
  "settle_royalties",
  "Process a royalty settlement event: BigInt proportional disbursement, platform fee, tax withholding per holder profile, corner-dust collection, and reconciliation status.",
  {
    transactionId: z.string(),
    cbtCode: z.string(),
    grossAmount: z.number().nonnegative(),
    currency: z.enum(currencyEnum),
    sourcePlatform: z.string(),
    territoryCountryCode: z.string(),
    timestamp: z.number().int(),
  },
  async (event) => {
    try {
      return ok(await sdk.processRoyaltySettlement(event));
    } catch (e) {
      return fail(e);
    }
  },
);

mcp.tool(
  "tax_form_requirement",
  "Determine the required tax form (1099-MISC / 1099-NEC / 1042-S / NONE) for a rights-holder tax profile at a given earnings amount.",
  {
    taxProfile: taxProfileSchema,
    earningsAmount: z.number().nonnegative(),
    role: z.enum(rightsHolderRoleEnum),
  },
  async ({ taxProfile, earningsAmount, role }) => {
    try {
      return ok({
        taxFormRequired: CovenantTaxEngine.DetermineTaxFormRequirement(taxProfile, earningsAmount, role),
      });
    } catch (e) {
      return fail(e);
    }
  },
);

mcp.tool(
  "tax_effective_rate",
  "Calculate the effective withholding tax rate for a tax profile in a territory (US backup 24% / foreign default 30% with treaty override).",
  {
    taxProfile: taxProfileSchema,
    territoryCountryCode: z.string(),
  },
  async ({ taxProfile, territoryCountryCode }) => {
    try {
      return ok({
        effectiveRate: CovenantTaxEngine.calculateEffectiveTaxRate(taxProfile, territoryCountryCode),
      });
    } catch (e) {
      return fail(e);
    }
  },
);

mcp.tool(
  "audit_system",
  "Run the full system audit (CovenantAuditorAgent.RunFullSystemAudit) across registered assets and the royalty ledger, returning anomalies by severity.",
  {},
  async () => {
    try {
      return ok(await auditor.RunFullSystemAudit());
    } catch (e) {
      return fail(e);
    }
  },
);

mcp.tool(
  "register_platform_allowlist",
  "Register or update a social-platform allowlist entry for a CBT code (target account, creator incentive share percentage, ACTIVE/REVOKED status).",
  {
    cbtCode: z.string(),
    platform: z.enum(socialPlatformEnum),
    targetAccountOrChannelId: z.string(),
    creatorIncentiveSharePct: z.number().min(0).max(100),
    status: z.enum(["ACTIVE", "REVOKED"]),
  },
  async (entry) => {
    try {
      social.registerGlobalAllowlist(entry);
      return ok({ success: true, entry });
    } catch (e) {
      return fail(e);
    }
  },
);

mcp.tool(
  "process_social_claim",
  "Process a global match-claim event from a social/entertainment platform through the CovenantGlobalSocialEngine (allowlist check, creator incentive share, 10% social-path fee, settlement).",
  {
    platform: z.enum(socialPlatformEnum),
    cbtCode: z.string(),
    externalAssetId: z.string(),
    mediaContentId: z.string(),
    channelOrProfileId: z.string(),
    grossAdRevenueOrRoyalty: z.number().nonnegative(),
    currency: z.enum(currencyEnum),
    territoryCountryCode: z.string(),
    timestamp: z.number().int(),
  },
  async (claim) => {
    try {
      return ok(await social.processGlobalClaimEvent(claim));
    } catch (e) {
      return fail(e);
    }
  },
);

/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  console.error(`[covnant-mcp] CovenantMasterSDK v2.0.0 harness ready — platform fee ${(PLATFORM_FEE_PCT * 100).toFixed(2)}%, persistence: ${process.env.NEXT_PUBLIC_SUPABASE_URL ? "supabase" : "in-memory"}`);
}

main().catch((err: unknown) => {
  console.error("[covnant-mcp] fatal:", err);
  process.exit(1);
});
