/**
 * Livestream ingestion profiles (PR 14) — dispatch, strict parsing, and the
 * fail-closed refusal grammar, pinned to the checked-in fixture logs.
 *
 * The fixtures are the standing spec: the Twitch payout report's Bits row
 * (default rate injected and logged), the Tier-2 subscription, the CPM
 * sponsor banner; YouTube Live's super chat and membership; Kick's default
 * and contract-configured 95/5-model rows; TikTok's Diamonds at the
 * recorded rate including the sub-cent single-rose row; the
 * Streamlabs/StreamElements flat + CPM alert pair; and the esports
 * prize-pool receipt funding two batches. Hostile rows are synthesized
 * inline over the real headers; each asserts the exact StatementParseError
 * token the profile must refuse with.
 */
import { describe, expect, it } from "vitest";

import { dispatchStatementProfile } from "../profiles";
import { LIVESTREAM_PROFILES, isLivestreamProfileKind } from "../livestreamProfiles";
import { MICROS_PER_DOLLAR } from "../livestream";
import { loadFixture } from "./fixtures";

function requireProfile(kind: string) {
  const profile = LIVESTREAM_PROFILES.find((p) => p.kind === kind);
  if (profile === undefined) throw new Error(`profile missing: ${kind}`);
  return profile;
}

const TWITCH = requireProfile("twitch_livestream_payouts_csv");
const YOUTUBE = requireProfile("youtube_live_livestream_payouts_csv");
const KICK = requireProfile("kick_livestream_payouts_csv");
const TIKTOK = requireProfile("tiktok_live_livestream_payouts_csv");
const SLSE = requireProfile("streamlabs_streamelements_alerts_csv");
const ESPORTS = requireProfile("esports_tournament_prize_pool_csv");

/**
 * One hostile row — the fixture's real header plus a first data row with
 * cell overrides (the fixtures carry no quoted commas, so a plain split
 * reconstructs the row exactly).
 */
function withCells(
  fixtureName: string,
  overrides: Record<string, string>,
): string {
  const content = loadFixture(fixtureName);
  const lines = content.split("\n");
  const header = lines[0];
  const firstRow = lines[1];
  if (header === undefined || firstRow === undefined) {
    throw new Error(`fixture ${fixtureName} has no data row`);
  }
  const columns = header.split(",");
  const values = firstRow.split(",").map((cell, index) => {
    const column = columns[index];
    return column !== undefined && column in overrides
      ? overrides[column]
      : cell;
  });
  return [header, values.join(","), ...lines.slice(2)].join("\n");
}

describe("livestream profile registry — dispatch and the lane discriminator", () => {
  it("registers exactly the six livestream profile kinds", () => {
    expect(LIVESTREAM_PROFILES.map((p) => p.kind)).toEqual([
      "twitch_livestream_payouts_csv",
      "youtube_live_livestream_payouts_csv",
      "kick_livestream_payouts_csv",
      "tiktok_live_livestream_payouts_csv",
      "streamlabs_streamelements_alerts_csv",
      "esports_tournament_prize_pool_csv",
    ]);
    for (const kind of LIVESTREAM_PROFILES.map((p) => p.kind)) {
      expect(isLivestreamProfileKind(kind)).toBe(true);
    }
    expect(isLivestreamProfileKind("distrokid_csv")).toBe(false);
    expect(isLivestreamProfileKind("epic_games_sales_csv")).toBe(false);
  });

  it("dispatches each checked-in fixture to its livestream profile", () => {
    expect(
      dispatchStatementProfile(loadFixture("livestream_twitch_payouts.csv"))?.kind,
    ).toBe("twitch_livestream_payouts_csv");
    expect(
      dispatchStatementProfile(loadFixture("livestream_youtube_live.csv"))?.kind,
    ).toBe("youtube_live_livestream_payouts_csv");
    expect(
      dispatchStatementProfile(loadFixture("livestream_kick_subs.csv"))?.kind,
    ).toBe("kick_livestream_payouts_csv");
    expect(
      dispatchStatementProfile(loadFixture("livestream_tiktok_diamonds.csv"))?.kind,
    ).toBe("tiktok_live_livestream_payouts_csv");
    expect(
      dispatchStatementProfile(loadFixture("livestream_slse_alerts.csv"))?.kind,
    ).toBe("streamlabs_streamelements_alerts_csv");
    expect(
      dispatchStatementProfile(loadFixture("livestream_esports_prize_pool.csv"))?.kind,
    ).toBe("esports_tournament_prize_pool_csv");
  });

  it("does not match a mutated header — the strict-header rule", () => {
    expect(
      TWITCH.matches(loadFixture("livestream_twitch_payouts.csv").replace("Bits", "Bits ")),
    ).toBe(false);
    expect(
      KICK.matches("Date,Channel,Amount\n2026-03-14,x,1\n"),
    ).toBe(false);
  });
});

describe("Twitch parsing — the payout-report fixture", () => {
  const lines = TWITCH.parse(loadFixture("livestream_twitch_payouts.csv"));

  it("parses all three revenue kinds with full livestream context", () => {
    expect(lines).toHaveLength(3);
    expect(lines.every((l) => l.livestreamDetail !== null)).toBe(true);
    expect(lines.every((l) => l.livestreamDetail?.platform === "twitch")).toBe(true);
  });

  it("parses the Bits row with the DEFAULT rate injected and logged — $0.01/bit net", () => {
    const row1 = lines[0]!;
    expect(row1.livestreamDetail?.revenueKind).toBe("bits");
    expect(row1.livestreamDetail?.virtualCurrencyCode).toBe("Bits");
    expect(row1.livestreamDetail?.virtualAmount).toBe("500");
    expect(row1.livestreamDetail?.exchangeRate).toBe("0.01");
    // 500 bits × $0.01 = $5.00.
    expect(row1.grossMicros).toBe(5n * MICROS_PER_DOLLAR);
    // Bits rows carry no alert-type cell — the overlay context is null.
    expect(row1.livestreamDetail?.alertType).toBeNull();
  });

  it("parses the Tier-2 subscription at its reported gross", () => {
    const row2 = lines[1]!;
    expect(row2.livestreamDetail?.revenueKind).toBe("subscription");
    expect(row2.livestreamDetail?.subscriptionTier).toBe("Tier 2");
    expect(row2.grossMicros).toBe(999_000_000n);
    // A Twitch sub reports the creator's net directly — no platform split
    // rate is recorded (Kick's rows carry the split).
    expect(row2.livestreamDetail?.creatorShareBps).toBeNull();
  });

  it("prices the CPM sponsor banner from impressions × CPM", () => {
    const row3 = lines[2]!;
    expect(row3.livestreamDetail?.revenueKind).toBe("overlay_alert");
    expect(row3.livestreamDetail?.alertType).toBe("sponsor_banner");
    expect(row3.livestreamDetail?.revenueBasis).toBe("cpm");
    expect(row3.livestreamDetail?.impressions).toBe(10_000);
    expect(row3.livestreamDetail?.cpmMicros).toBe(250_000_000n); // $2.50 CPM
    // 10,000 impressions at a $2.50 CPM = $25.00.
    expect(row3.grossMicros).toBe(25n * MICROS_PER_DOLLAR);
  });

  it("refuses a bits row with a non-positive or fractional bits cell", () => {
    expect(() =>
      TWITCH.parse(withCells("livestream_twitch_payouts.csv", { Bits: "0" })),
    ).toThrow(/invalid_bits_amount:0:row_1/);
    expect(() =>
      TWITCH.parse(withCells("livestream_twitch_payouts.csv", { Bits: "5.5" })),
    ).toThrow(/invalid_bits_amount:5\.5:row_1/);
  });

  it("injects a bits row's overlay alert type — the cell is not required on bits rows", () => {
    // The Bits row's alert-type cell is not part of the Twitch report shape;
    // an empty cell parses fine (the detail's alertType is just null).
    expect(() =>
      TWITCH.parse(withCells("livestream_twitch_payouts.csv", { "Alert Type": "" })),
    ).not.toThrow();
  });

  it("refuses an unknown revenue kind — the closed vocabulary", () => {
    expect(() =>
      TWITCH.parse(withCells("livestream_twitch_payouts.csv", { "Revenue Kind": "raids" })),
    ).toThrow(/invalid_revenue_kind:raids:row_1/);
  });

  it("refuses a CPM alert row with missing or fractional impressions", () => {
    expect(() =>
      TWITCH.parse(
        withCells("livestream_twitch_payouts.csv", {
          "Revenue Kind": "overlay_alert",
          "Alert Type": "sponsor_banner",
          "Payout Basis": "cpm",
          Impressions: "",
          Bits: "0",
        }),
      ),
    ).toThrow(/missing_column:Impressions:row_1/);
    expect(() =>
      TWITCH.parse(
        withCells("livestream_twitch_payouts.csv", {
          "Revenue Kind": "overlay_alert",
          "Alert Type": "sponsor_banner",
          "Payout Basis": "cpm",
          Impressions: "1.5",
          Bits: "0",
        }),
      ),
    ).toThrow(/invalid_impressions:1\.5:row_1/);
  });
});

describe("YouTube Live parsing — the super-chat fixture", () => {
  const lines = YOUTUBE.parse(loadFixture("livestream_youtube_live.csv"));

  it("parses the super chat and the membership with tier context", () => {
    expect(lines).toHaveLength(2);
    expect(lines[0]!.livestreamDetail?.revenueKind).toBe("super_chat");
    expect(lines[0]!.grossMicros).toBe(25n * MICROS_PER_DOLLAR);
    expect(lines[1]!.livestreamDetail?.revenueKind).toBe("membership");
    expect(lines[1]!.livestreamDetail?.subscriptionTier).toBe("Legend");
    expect(lines[1]!.grossMicros).toBe(499_000_000n);
    expect(lines.every((l) => l.livestreamDetail?.platform === "youtube_live")).toBe(
      true,
    );
  });

  it("refuses an unknown revenue kind", () => {
    expect(() =>
      YOUTUBE.parse(withCells("livestream_youtube_live.csv", { "Revenue Kind": "ads" })),
    ).toThrow(/invalid_revenue_kind:ads:row_1/);
  });
});

describe("Kick parsing — the 95/5 subscription fixture", () => {
  const lines = KICK.parse(loadFixture("livestream_kick_subs.csv"));

  it("applies the 9500-bps default when the share cell is empty and logs it", () => {
    const row1 = lines[0]!;
    expect(row1.livestreamDetail?.platform).toBe("kick");
    expect(row1.livestreamDetail?.revenueKind).toBe("subscription");
    expect(row1.livestreamDetail?.creatorShareBps).toBe(9500);
    expect(row1.grossMicros).toBe(10n * MICROS_PER_DOLLAR);
  });

  it("records the contract-configured 97% share verbatim", () => {
    expect(lines[1]!.livestreamDetail?.creatorShareBps).toBe(9700);
  });

  it("refuses a share outside the (0, 100) band", () => {
    expect(() =>
      KICK.parse(withCells("livestream_kick_subs.csv", { "Creator Share %": "0" })),
    ).toThrow(/kick_creator_share_out_of_band:0:/);
    expect(() =>
      KICK.parse(withCells("livestream_kick_subs.csv", { "Creator Share %": "100" })),
    ).toThrow(/invalid_percent:Creator Share %:100:row_1/);
  });
});

describe("TikTok parsing — the Diamonds conversion fixture", () => {
  const lines = TIKTOK.parse(loadFixture("livestream_tiktok_diamonds.csv"));

  it("derives gross from Diamonds × the recorded rate", () => {
    expect(lines).toHaveLength(2);
    const row1 = lines[0]!;
    expect(row1.livestreamDetail?.platform).toBe("tiktok_live");
    expect(row1.livestreamDetail?.virtualCurrencyCode).toBe("Diamonds");
    expect(row1.livestreamDetail?.virtualAmount).toBe("2500");
    expect(row1.livestreamDetail?.exchangeRate).toBe("0.002");
    // 2,500 diamonds × $0.002 = $5.00.
    expect(row1.grossMicros).toBe(5n * MICROS_PER_DOLLAR);
  });

  it("keeps the sub-cent single-rose row — the conversion math, exactly", () => {
    // 1 diamond × $0.002 = $0.002 — below a cent; the posting pass skips it.
    expect(lines[1]!.grossMicros).toBe(200_000n);
  });

  it("refuses a zero or missing diamond rate — a zero-rate conversion invents money", () => {
    expect(() =>
      TIKTOK.parse(withCells("livestream_tiktok_diamonds.csv", { "Diamond Rate (USD)": "0" })),
    ).toThrow(/invalid_exchange_rate:0:row_1/);
    expect(() =>
      TIKTOK.parse(withCells("livestream_tiktok_diamonds.csv", { "Diamond Rate (USD)": "" })),
    ).toThrow(/missing_column:Diamond Rate \(USD\):row_1/);
  });

  it("refuses a non-positive Diamonds cell", () => {
    expect(() =>
      TIKTOK.parse(withCells("livestream_tiktok_diamonds.csv", { Diamonds: "0" })),
    ).toThrow(/invalid_diamond_amount:0:row_1/);
  });
});

describe("Streamlabs/StreamElements parsing — the alert fixture", () => {
  const lines = SLSE.parse(loadFixture("livestream_slse_alerts.csv"));

  it("parses the flat sub alert and the CPM sponsor banner", () => {
    expect(lines).toHaveLength(2);
    expect(lines[0]!.livestreamDetail?.platform).toBe("streamlabs");
    expect(lines[0]!.livestreamDetail?.revenueBasis).toBe("flat");
    expect(lines[0]!.grossMicros).toBe(5n * MICROS_PER_DOLLAR);
    expect(lines[1]!.livestreamDetail?.platform).toBe("streamelements");
    expect(lines[1]!.livestreamDetail?.revenueBasis).toBe("cpm");
    // 2,000 impressions at a $1.50 CPM = $3.00.
    expect(lines[1]!.grossMicros).toBe(3n * MICROS_PER_DOLLAR);
  });

  it("refuses an unknown alert platform", () => {
    expect(() =>
      SLSE.parse(withCells("livestream_slse_alerts.csv", { Platform: "owntone" })),
    ).toThrow(/invalid_platform:owntone:row_1/);
  });

  it("refuses a CPM alert row without its CPM rate", () => {
    expect(() =>
      SLSE.parse(
        withCells("livestream_slse_alerts.csv", {
          Platform: "streamelements",
          "Alert Type": "sponsor_banner",
          "Payout Basis": "cpm",
          Impressions: "1000",
          "CPM (USD)": "",
        }),
      ),
    ).toThrow(/missing_column:CPM \(USD\):row_1/);
  });
});

describe("Esports prize-pool parsing — the receipt fixture", () => {
  const lines = ESPORTS.parse(loadFixture("livestream_esports_prize_pool.csv"));

  it("parses both placements with the batch as the row's identity", () => {
    expect(lines).toHaveLength(2);
    // $50,000 and $25,000.
    expect(lines[0]!.grossMicros).toBe(50_000n * MICROS_PER_DOLLAR);
    expect(lines[1]!.grossMicros).toBe(25_000n * MICROS_PER_DOLLAR);
    expect(lines[0]!.livestreamDetail?.prizePoolBatch).toBe("founder-cup-2026-main");
    expect(lines[0]!.livestreamDetail?.revenueKind).toBe("prize_pool");
    // A tournament payout is not a stream platform's row.
    expect(lines[0]!.livestreamDetail?.platform).toBeNull();
    // The Team DOI attributes the receipt to the org's vault.
    expect(lines[0]!.identifiers.DOI).toBe("10.61982/covenant.team-001");
    expect(lines[1]!.identifiers.DOI).toBe("10.61982/covenant.team-002");
  });

  it("refuses a receipt without its prize-pool batch — an unfundable row", () => {
    expect(() =>
      ESPORTS.parse(
        withCells("livestream_esports_prize_pool.csv", { "Prize Pool Batch": "" }),
      ),
    ).toThrow(/missing_column:Prize Pool Batch:row_1/);
  });
});

describe("the shared refusal grammar — every livestream profile", () => {
  it("refuses a missing channel DOI — unattributable money never quarantines silently", () => {
    expect(() =>
      TWITCH.parse(withCells("livestream_twitch_payouts.csv", { "Channel DOI": "" })),
    ).toThrow(/missing_column:Channel DOI:row_1/);
  });

  it("refuses a malformed channel DOI", () => {
    expect(() =>
      TWITCH.parse(withCells("livestream_twitch_payouts.csv", { "Channel DOI": "not-a-doi" })),
    ).toThrow(/invalid_doi:not-a-doi:row_1/);
  });

  it("refuses a malformed report date — the ingestion day is never guessed", () => {
    expect(() =>
      TWITCH.parse(withCells("livestream_twitch_payouts.csv", { "Report Date": "03/14/2026" })),
    ).toThrow(/invalid_date:03\/14\/2026:row_1/);
  });

  it("refuses a malformed gross — the strict money grammar", () => {
    expect(() =>
      KICK.parse(withCells("livestream_kick_subs.csv", { "Gross Amount (USD)": "10.999.5" })),
    ).toThrow(/invalid_amount:Gross Amount \(USD\):row_1/);
  });

  it("refuses a non-positive gross on flat-fee rows", () => {
    expect(() =>
      KICK.parse(withCells("livestream_kick_subs.csv", { "Gross Amount (USD)": "0" })),
    ).toThrow(/invalid_money:Gross Amount \(USD\):0:row_1/);
  });

  it("refuses a missing currency cell", () => {
    expect(() =>
      YOUTUBE.parse(withCells("livestream_youtube_live.csv", { Currency: "" })),
    ).toThrow(/missing_column:Currency:row_1/);
  });

  it("refuses an unknown payout basis on alert rows", () => {
    expect(() =>
      SLSE.parse(withCells("livestream_slse_alerts.csv", { "Payout Basis": "revenue_share" })),
    ).toThrow(/invalid_revenue_basis:revenue_share:row_1/);
  });
});
