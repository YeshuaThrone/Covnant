/**
 * Statement profile tests — dispatch (each fixture matches exactly one
 * profile), fixture-pinned parses with exact micros, the rights-separation
 * classification (master / publishing / quarantined), film tier population,
 * and the row-scoped strict rejections.
 */
import { describe, expect, it } from "vitest";

import { dispatchStatementProfile, STATEMENT_PROFILES } from "../profiles";
import type { ParsedStatementLine, StatementProfile } from "../records";
import { loadFixture } from "./fixtures";

/**
 * Dispatches a fixture (or a hostile content override) through the shared
 * helper, asserting the pinned registry matched — a fixture that stops
 * matching is a broken profile, not a silent skip.
 */
function dispatchFixture(
  name: string,
  contentOverride?: string,
): { profile: StatementProfile; lines: readonly ParsedStatementLine[] } {
  const content = contentOverride ?? loadFixture(name);
  const profile = dispatchStatementProfile(content);
  if (profile === null) throw new Error(`fixture ${name} matched no profile`);
  return { profile, lines: profile.parse(content) };
}

describe("profile registry", () => {
  it("registers seventy-seven profiles in dispatch order", () => {
    expect(STATEMENT_PROFILES.map((profile) => profile.kind)).toEqual([
      "distrokid_csv",
      "tunecore_tsv",
      "pro_publishing_csv",
      "film_vod_csv",
      "film_svod_csv",
      "film_theatrical_box_office_csv",
      "film_international_sales_agent_csv",
      "podcast_dai_log_csv",
      "podcast_rss_report_csv",
      // The gaming lane (Deep Royalties PR 12) — dispatched after podcast,
      // its own rights family (rights_type 'unknown').
      "epic_games_sales_csv",
      "unity_asset_store_payout_csv",
      "roblox_devex_csv",
      "steamworks_sales_csv",
      "apple_vision_pro_payments_csv",
      // The livestream/esports lane (PR 14) — dispatched after gaming, its
      // own rights family (stream_platform statements and prize-pool
      // receipts through the per-batch escrow).
      "twitch_livestream_payouts_csv",
      "youtube_live_livestream_payouts_csv",
      "kick_livestream_payouts_csv",
      "tiktok_live_livestream_payouts_csv",
      "streamlabs_streamelements_alerts_csv",
      "esports_tournament_prize_pool_csv",
      // The webtoon lane (Deep Royalties PR 19) — dispatched after
      // livestream, its own rights family (serialized-comics statements,
      // reader logs, and KENP pool reports).
      "webtoon_coin_payout_csv",
      "webtoon_reader_log_csv",
      "kenp_page_read_pool_csv",
      // The merch lane (Deep Royalties PR 22, the founder merchandise
      // directive) — dispatched after webtoon, its own rights family
      // (physical-product fulfillment events matched by UPC, the COGS
      // deduction, and the consignment reconciliation).
      "shopify_dtc_dump_csv",
      "pod_fulfillment_dump_csv",
      "wholesale_consignment_payout_csv",
      "square_pos_dump_csv",
      // The AI lane (PR 24) — metered inference billing, inference
      // telemetry, synthetic-voice licensing, and dataset attribution.
      "openai_llm_billing_log_csv",
      "wandb_inference_telemetry_csv",
      "elevenlabs_voice_clone_licensing_csv",
      "huggingface_dataset_attribution_log_csv",
      // The art-market lane (PR 28, the founder art directive) — dispatched
      // after AI, its own rights family (gallery invoices, auction resale
      // reports, print shop sales, museum licensing, and foundation or
      // estate audits).
      "art_gallery_invoice_csv",
      "art_auction_resale_report_csv",
      "art_print_shop_sales_csv",
      "art_museum_licensing_csv",
      "art_foundation_estate_audit_csv",
      // The brand-licensing lane (PR 32, the founder licensing directive) —
      // dispatched last, its own rights family (retail sales reports,
      // master-licensee sell-through logs, e-commerce POS feeds, and
      // wholesale distributor manifests).
      "licensing_retail_sales_csv",
      "licensing_sellthrough_log_csv",
      "licensing_ecommerce_pos_csv",
      "licensing_wholesale_manifest_csv",
      // The NIL lane (PR 34, the founder NIL directive) — its own rights
      // family (third-party brand endorsement deals,
      // collective deal disclosures, school direct revenue-share pools, and
      // media rights revenue distributions; never music-rights split math).
      "nil_brand_endorsement_csv",
      "nil_collective_disclosure_csv",
      "nil_school_rev_share_pool_csv",
      "nil_media_rights_distribution_csv",
      // The spatial lane (PR 36, the founder spatial directive) —
      // dispatched last, its own rights family (venue turnstile ticket
      // scans, attraction pass sales, in-park food and beverage register
      // feeds, location-tagged retail POS logs, and RFID wristband
      // telemetry; never music-rights split math).
      "spatial_turnstile_ticket_scans_csv",
      "spatial_attraction_pass_sales_csv",
      "spatial_fnb_register_csv",
      "spatial_retail_pos_csv",
      "spatial_rfid_wristband_telemetry_csv",
      // The fitness lane (PR 38, the founder fitness directive) —
      // dispatched last, its own rights family (digital stream starts,
      // completed workout logs, connected bike and treadmill telemetry,
      // studio class check-ins, and app subscription allocations; never
      // music-rights split math — the sync music deductions are the
      // fitness queue's own ledger legs).
      "fitness_stream_starts_csv",
      "fitness_completed_workouts_csv",
      "fitness_equipment_telemetry_csv",
      "fitness_studio_checkins_csv",
      "fitness_subscription_allocations_csv",
      // The food lane (PR 40, the founder food directive) — dispatched
      // last, its own rights family (third-party delivery app order
      // feeds, restaurant POS ticket streams, meal-kit production
      // batches, grocery CPG scanner logs, and bulk supplier rebate
      // statements; never music-rights split math — the lane keys the
      // chef, recipe, and ghost-kitchen-location identity columns).
      "food_delivery_orders_csv",
      "food_pos_tickets_csv",
      "food_meal_kit_production_csv",
      "food_grocery_cpg_scans_csv",
      "food_supplier_rebates_csv",
      // The service lane (PR 42, the founder service directive) —
      // dispatched last, its own rights family (salon/spa POS ticket
      // streams, recurring membership billing logs, hotel guest room
      // folio charges, distributor rebate statements, and booth-lease
      // ledgers; never music-rights split math — the lane keys the
      // stylist, protocol, and salon-location identity columns).
      "service_pos_tickets_csv",
      "service_membership_redemptions_csv",
      "service_membership_breakage_csv",
      "service_hotel_folio_charges_csv",
      "service_vendor_rebates_csv",
      "service_booth_lease_csv",
      // The developer lane (PR 44, the founder developer directive) —
      // dispatched last, after the services lane: the four founder-named
      // feeds (gateway usage, SDK init, marketplace sales, usage tokens)
      // plus the four modeled feeds (co-package revenue, SBOM scans,
      // white-label licenses, agent tool-call batches).
      "developer_api_gateway_usage_csv",
      "developer_sdk_initializations_csv",
      "developer_usage_billing_tokens_csv",
      "developer_marketplace_sales_csv",
      "developer_copackage_revenue_csv",
      "developer_sbom_scans_csv",
      "developer_whitelabel_licenses_csv",
      "developer_agent_tool_calls_csv",
      // The hardware lane (PR 46, the founder hardware directive) —
      // dispatched last, after the developer lane: the four founder-named
      // feeds (cellular device activations with IMEI/EID, MAC address
      // logs, factory production serial counts, smart grid telemetry;
      // OTA unlock events ride the cellular feed as their second
      // activation kind).
      "hardware_cellular_activations_csv",
      "hardware_mac_address_logs_csv",
      "hardware_production_serials_csv",
      "hardware_smart_grid_telemetry_csv",
    ]);
  });

  it("returns null for content that matches no profile — the caller owns the failure", () => {
    expect(dispatchStatementProfile(loadFixture("unknown_layout.csv"))).toBeNull();
  });
});

describe("DistroKid-style CSV (master lane)", () => {
  it("matches the distrokid profile and nothing else", () => {
    expect(dispatchFixture("distrokid.csv").profile.kind).toBe("distrokid_csv");
  });

  it("parses exact micros, period, and canonical identifiers", () => {
    const { lines } = dispatchFixture("distrokid.csv");
    expect(lines).toHaveLength(2);

    const streaming = lines[0];
    expect(streaming.rightsPipeline).toBe("master_interactive");
    expect(streaming.grossMicros).toBe(431_000_000n);
    expect(streaming.identifiers.ISRC).toBe("USXYT2600001");
    expect(streaming.identifiers.UPC).toBe("001234567890");
    expect(streaming.period).toBe("2026-08");
    expect(streaming.currency).toBe("USD");
    expect(streaming.platform).toBe("Spotify");
    expect(streaming.isAdjustment).toBe(false);

    const download = lines[1];
    expect(download.rightsPipeline).toBe("master_digital_performance");
    expect(download.grossMicros).toBe(140_000_000n);
  });

  it("classifies the lane master and pins no film fields", () => {
    const { lines } = dispatchFixture("distrokid.csv");
    expect(lines[0].rightsType).toBe("master");
    expect(lines[0].statementSourceType).toBeNull();
    expect(lines[0].tierLevel).toBeNull();
    expect(lines[0].guildResidual).toBeNull();
  });

  it("canonicalizes a dashed ISRC into the registry form", () => {
    const { lines } = dispatchFixture("distrokid.csv");
    expect(lines[0].identifiers.ISRC).toBe("USXYT2600001");
  });

  it("rejects a store outside the bounded map, row-scoped", () => {
    const hostile = loadFixture("distrokid.csv").replace("Spotify", "NotRealMusic");
    expect(() => dispatchFixture("distrokid.csv", hostile)).toThrow(/unknown_store/);
  });

  it("rejects an invalid ISRC with the row number", () => {
    const hostile = loadFixture("distrokid.csv").replace("US-XYT-26-00001", "NOT_AN_ISRC");
    expect(() => dispatchFixture("distrokid.csv", hostile)).toThrow(/invalid_isrc:row_1/);
  });

  it("rejects a missing money cell with column + row context", () => {
    const hostile = loadFixture("distrokid.csv").replace("$4.31", "");
    expect(() => dispatchFixture("distrokid.csv", hostile)).toThrow(
      /missing_column:Net Earnings:row_1/,
    );
  });
});

describe("TuneCore-style TSV (master lane)", () => {
  it("matches the tunecore profile — tab-delimited dispatch", () => {
    expect(dispatchFixture("tunecore.tsv").profile.kind).toBe("tunecore_tsv");
  });

  it("event money is Your Net Receipts (never the sender's gross)", () => {
    const { lines } = dispatchFixture("tunecore.tsv");
    expect(lines).toHaveLength(2);
    expect(lines[0].grossMicros).toBe(92_000_000n);
    expect(lines[1].grossMicros).toBe(65_000_000n);
    expect(lines[0].rightsPipeline).toBe("master_interactive");
    expect(lines[1].rightsPipeline).toBe("master_digital_performance");
  });

  it("carries the verbatim sender rows for auditability", () => {
    const { lines } = dispatchFixture("tunecore.tsv");
    expect(lines[0].raw.join("\n")).toContain("$1.02");
    expect(lines[0].raw.join("\n")).toContain("2026-08-15");
  });
});

describe("PRO publishing CSV (publishing lane)", () => {
  it("matches the publishing profile", () => {
    expect(dispatchFixture("pro_publishing.csv").profile.kind).toBe("pro_publishing_csv");
  });

  it("classifies the lane publishing with the performance pipeline", () => {
    const { lines } = dispatchFixture("pro_publishing.csv");
    expect(lines[0].rightsType).toBe("publishing");
    expect(lines[0].rightsPipeline).toBe("composition_performance");
    expect(lines[0].grossMicros).toBe(1_250_000_000n);
    expect(lines[0].identifiers.ISWC).toBe("T-034524597-1");
    expect(lines[0].platform).toBe("Spotify");
    expect(lines[0].tierLevel).toBeNull();
  });
});

describe("film statement profiles (quarantined, tier 0)", () => {
  it("dispatches each film fixture to its own profile", () => {
    expect(dispatchFixture("film_vod.csv").profile.kind).toBe("film_vod_csv");
    expect(dispatchFixture("film_svod.csv").profile.kind).toBe("film_svod_csv");
    expect(dispatchFixture("film_theatrical.csv").profile.kind).toBe(
      "film_theatrical_box_office_csv",
    );
    expect(dispatchFixture("film_sales_agent.csv").profile.kind).toBe(
      "film_international_sales_agent_csv",
    );
  });

  it("quarantines film lines: rights_type unknown, tier 0, source type set", () => {
    const { lines } = dispatchFixture("film_vod.csv");
    for (const line of lines) {
      expect(line.rightsType).toBe("unknown");
      expect(line.tierLevel).toBe(0);
      expect(line.statementSourceType).toBe("vod");
      expect(line.guildResidual).toBeNull(); // residuals attach in the worker pass
    }
  });

  it("parses VOD Net Payable with exact micros per line", () => {
    const { lines } = dispatchFixture("film_vod.csv");
    expect(lines[0].grossMicros).toBe(47_904_000_000n);
    expect(lines[1].grossMicros).toBe(13_972_000_000n);
    expect(lines[0].platform).toBe("Amazon Prime");
  });

  it("populates tier 0 and the right statement source across all film channels", () => {
    const svod = dispatchFixture("film_svod.csv");
    expect(svod.lines[0].statementSourceType).toBe("svod");
    expect(svod.lines[0].tierLevel).toBe(0);
    expect(svod.lines[0].grossMicros).toBe(125_000_000_000n);
    expect(svod.lines[0].currency).toBe("CAD");

    const theatrical = dispatchFixture("film_theatrical.csv");
    expect(theatrical.lines[0].statementSourceType).toBe("theatrical_box_office");
    expect(theatrical.lines[0].grossMicros).toBe(4_130_400_000_000n);

    const salesAgent = dispatchFixture("film_sales_agent.csv");
    expect(salesAgent.lines[0].statementSourceType).toBe("international_sales_agent");
    expect(salesAgent.lines[0].grossMicros).toBe(2_125_000_000_000n);
  });

  it("rejects a VOD transaction type outside the bounded vocabulary", () => {
    const hostile = loadFixture("film_vod.csv").replace("EST", "SVOD_RENTAL");
    expect(() => dispatchFixture("film_vod.csv", hostile)).toThrow(/invalid_line_type/);
  });

  it("cross-references the EIDR through the registry", () => {
    const { lines } = dispatchFixture("film_vod.csv");
    expect(lines[0].identifiers.EIDR).toBe("10.5240/000A-000B-000C-000D-000E-F");
  });
});
