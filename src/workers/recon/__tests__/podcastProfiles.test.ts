/**
 * Podcast ingestion profiles (PR 10) — dispatch, strict parsing, and the
 * fail-closed refusal grammar, pinned to the checked-in fixture logs.
 *
 * The fixtures are the standing spec: bot traffic, sub-threshold and
 * duplicate downloads, the dedup-window edge, host-read verification
 * states, a cross-feed duplicate of the DAI log's anchor impression, and
 * Channel C subscription rows — every lane the founder directive names.
 * Hostile rows are synthesized inline; each asserts the exact
 * StatementParseError token the profile must refuse with.
 */
import { describe, expect, it } from "vitest";

import { dispatchStatementProfile } from "../profiles";
import {
  PODCAST_PROFILES,
  isPodcastProfileKind,
  parseCommissionCell,
} from "../podcastProfiles";
import { qualifyImpressionLines } from "../podcast";
import { loadFixture } from "./fixtures";

const DAI_PROFILE = PODCAST_PROFILES.find((p) => p.kind === "podcast_dai_log_csv");
const RSS_PROFILE = PODCAST_PROFILES.find((p) => p.kind === "podcast_rss_report_csv");

function requireProfile(
  profile: (typeof PODCAST_PROFILES)[number] | undefined,
): (typeof PODCAST_PROFILES)[number] {
  if (profile === undefined) throw new Error("podcast profile missing from registry");
  return profile;
}

const daiProfile = requireProfile(DAI_PROFILE);
const rssProfile = requireProfile(RSS_PROFILE);

/** One hostile DAI log — the real header plus one data row of cell overrides. */
function daiLog(cells: Record<string, string>): string {
  const columns = [
    "Log Date",
    "RSS Feed ID",
    "Episode GUID",
    "Listener IP",
    "User Agent",
    "Ad Creative ID",
    "Ad Slot",
    "Placement Type",
    "Revenue Channel",
    "Network Sold",
    "Impressions",
    "CPM",
    "Audio Requested (sec)",
    "Network Commission %",
    "Show DOI",
    "Currency",
  ];
  const values = [
    "2026-08-15T10:00:05Z",
    "urn:podcast:covenant:show-001",
    "ep-2026-08-15-a",
    "203.0.113.10",
    "AppleCoreMedia/1.0.0",
    "crtv-mid-100",
    "mid_roll",
    "dai",
    "channel_a_dai",
    "yes",
    "1",
    "12.00",
    "1800",
    "40.00",
    "10.61982/covenant.show-001",
    "USD",
  ];
  for (const [column, value] of Object.entries(cells)) {
    const index = columns.indexOf(column);
    if (index === -1) throw new Error(`unknown DAI column: ${column}`);
    values[index] = value;
  }
  return `${columns.join(",")}\n${values.join(",")}\n`;
}

function rssLog(cells: Record<string, string>): string {
  const columns = [
    "Report Date",
    "RSS Feed ID",
    "Episode GUID",
    "Listener IP",
    "User Agent",
    "Ad Creative ID",
    "Ad Slot",
    "Placement Type",
    "Revenue Channel",
    "Sponsor Verified",
    "Impressions",
    "CPM",
    "Flat Fee",
    "Audio Requested (sec)",
    "Network Commission %",
    "Show DOI",
    "Monthly Recurring Amount",
    "Currency",
  ];
  const values: Record<number, string> = {
    0: "2026-08-15T09:00:00Z",
    1: "urn:podcast:covenant:show-001",
    2: "ep-2026-08-15-a",
    3: "203.0.113.50",
    4: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
    5: "crtv-hostread-9",
    6: "mid_roll",
    7: "host_read",
    8: "channel_b_host_read",
    9: "yes",
    10: "",
    11: "",
    12: "250.00",
    13: "1500",
    14: "",
    15: "10.61982/covenant.show-001",
    16: "",
    17: "USD",
  };
  for (const [column, value] of Object.entries(cells)) {
    const index = columns.indexOf(column);
    if (index === -1) throw new Error(`unknown RSS column: ${column}`);
    values[index] = value;
  }
  const ordered = Array.from({ length: 18 }, (_, i) => values[i] ?? "");
  return `${columns.join(",")}\n${ordered.join(",")}\n`;
}

describe("profile dispatch", () => {
  it("dispatches both podcast logs by their exact headers", () => {
    expect(dispatchStatementProfile(loadFixture("podcast_dai_log.csv"))?.kind).toBe(
      "podcast_dai_log_csv",
    );
    expect(dispatchStatementProfile(loadFixture("podcast_rss_report.csv"))?.kind).toBe(
      "podcast_rss_report_csv",
    );
  });

  it("does not match a mutated header — the strict-header rule", () => {
    expect(
      daiProfile.matches(loadFixture("podcast_dai_log.csv").replace("CPM", "Rate")),
    ).toBe(false);
    expect(daiProfile.matches("Log Date,RSS Feed ID\n2026-08-15,x\n")).toBe(false);
  });

  it("registers both kinds in the lane discriminator", () => {
    expect(PODCAST_PROFILES.map((p) => p.kind)).toEqual([
      "podcast_dai_log_csv",
      "podcast_rss_report_csv",
    ]);
    expect(isPodcastProfileKind("podcast_dai_log_csv")).toBe(true);
    expect(isPodcastProfileKind("podcast_rss_report_csv")).toBe(true);
    expect(isPodcastProfileKind("distrokid_csv")).toBe(false);
  });
});

describe("DAI log parsing — the checked-in fixture", () => {
  const lines = daiProfile.parse(loadFixture("podcast_dai_log.csv"));

  it("parses all 13 rows", () => {
    expect(lines).toHaveLength(13);
    expect(lines.every((l) => l.podcastDetail !== null)).toBe(true);
  });

  it("converts the first row's CPM to exact micros with the full lane context", () => {
    const row1 = lines[0]!;
    // $12.00 CPM × 1 impression = $0.012 — 1,200,000 units at the house
    // 1e-8-dollar unit scale.
    expect(row1.grossMicros).toBe(1_200_000n);
    expect(row1.podcastDetail?.revenueChannel).toBe("channel_a_dai");
    expect(row1.podcastDetail?.adPlacementType).toBe("dai");
    expect(row1.podcastDetail?.adSlot).toBe("mid_roll");
    expect(row1.podcastDetail?.networkSold).toBe(true);
    expect(row1.podcastDetail?.commissionBps).toBe(4000);
    expect(row1.podcastDetail?.audioSeconds).toBe(1800);
    expect(row1.podcastDetail?.listenerIp).toBe("203.0.113.10");
    expect(row1.identifiers.DOI).toBe("10.61982/covenant.show-001");
  });

  it("keeps direct-sold rows network-commission-free", () => {
    const row3 = lines[2]!; // network_sold=no, commission cell empty
    expect(row3.podcastDetail?.networkSold).toBe(false);
    expect(row3.podcastDetail?.commissionBps).toBeNull();
    // $15.00 CPM × 1 impression = $0.015 → 1,500,000 units.
    expect(row3.grossMicros).toBe(1_500_000n);
  });

  it("tags the host-read row Channel B with its exact CPM money", () => {
    const row12 = lines[11]!;
    expect(row12.podcastDetail?.revenueChannel).toBe("channel_b_host_read");
    expect(row12.podcastDetail?.adPlacementType).toBe("host_read");
    // $30.00 CPM × 1 impression = $0.03 → 3,000,000 units.
    expect(row12.grossMicros).toBe(3_000_000n);
    // The DAI log carries no sponsor-verification column — unknown, not false.
    expect(row12.podcastDetail?.sponsorVerified).toBeNull();
  });

  it("canonicalizes a DOI to its lowercase form", () => {
    const rows = daiProfile.parse(
      daiLog({ "Show DOI": "10.61982/Covenant.Show-001" }),
    );
    expect(rows[0]!.identifiers.DOI).toBe("10.61982/covenant.show-001");
  });

  it("qualifies 8 of 13 rows through the IAB pipeline — bots 2, dupes 2, short 1", () => {
    const result = qualifyImpressionLines(lines);
    expect(result.counts.qualified).toBe(8);
    expect(result.counts.botsFiltered).toBe(2);
    expect(result.counts.duplicatesDeduped).toBe(2);
    expect(result.counts.shortRequestsRejected).toBe(1);
    // The gross money of the qualified set, exact 1e-8-dollar units:
    // 1,200,000 + 800,000 + 1,500,000 + 1,000,000 + 800,000 + 1,200,000
    // + 3,000,000 + 800,000.
    expect(result.qualified.reduce((sum, l) => sum + l.grossMicros, 0n)).toBe(
      10_300_000n,
    );
  });
});

describe("RSS report parsing — the checked-in fixture", () => {
  const lines = rssProfile.parse(loadFixture("podcast_rss_report.csv"));

  it("parses all 7 rows", () => {
    expect(lines).toHaveLength(7);
  });

  it("parses the verified flat-fee host read", () => {
    const row1 = lines[0]!;
    // $250.00 flat fee → 25,000,000,000 units at 1e-8 dollars.
    expect(row1.grossMicros).toBe(25_000_000_000n);
    expect(row1.podcastDetail?.revenueChannel).toBe("channel_b_host_read");
    expect(row1.podcastDetail?.adPlacementType).toBe("host_read");
    expect(row1.podcastDetail?.sponsorVerified).toBe(true);
  });

  it("parses the unverified host read — the held-revenue candidate", () => {
    const row2 = lines[1]!;
    expect(row2.podcastDetail?.sponsorVerified).toBe(false);
    // $180.00 flat fee → 18,000,000,000 units.
    expect(row2.grossMicros).toBe(18_000_000_000n);
  });

  it("parses the Channel C subscription row with no listener identity", () => {
    const row3 = lines[2]!;
    expect(row3.podcastDetail?.revenueChannel).toBe("channel_c_subscription");
    expect(row3.podcastDetail?.adPlacementType).toBeNull();
    expect(row3.podcastDetail?.listenerIp).toBeNull();
    expect(row3.podcastDetail?.adCreativeId).toBeNull();
    expect(row3.podcastDetail?.audioSeconds).toBeNull();
    // $4.99/month → 499,000,000 units.
    expect(row3.grossMicros).toBe(499_000_000n);
  });

  it("qualifies 4 of 7 rows as impressions — bot 1, short 1 — and the cross-feed duplicate qualifies in-batch", () => {
    // Row 7 duplicates the DAI log's anchor impression; the QUEUE's unique
    // event_id (not the per-batch engine) is the cross-ingest dedup seam.
    // The subscription row is recurring money, not an impression — it rides
    // outside the qualification counts entirely.
    const result = qualifyImpressionLines(lines);
    expect(result.counts.qualified).toBe(4);
    expect(result.counts.botsFiltered).toBe(1);
    expect(result.counts.shortRequestsRejected).toBe(1);
  });
});

describe("fail-closed refusals — DAI log", () => {
  it("refuses commission outside the 20-40% band", () => {
    expect(() =>
      daiProfile.parse(
        daiLog({ "Network Commission %": "45.00" }),
      ),
    ).toThrow(/commission_out_of_band/);
  });

  it("refuses network-sold rows without a commission rate", () => {
    expect(() => daiProfile.parse(daiLog({ "Network Commission %": "" }))).toThrow(
      /missing_commission/,
    );
  });

  it("refuses direct-sold rows carrying a commission rate", () => {
    expect(() =>
      daiProfile.parse(daiLog({ "Network Sold": "no" })),
    ).toThrow(/unexpected_commission/);
  });

  it("refuses a channel outside the A/B/C vocabulary", () => {
    expect(() =>
      daiProfile.parse(daiLog({ "Revenue Channel": "channel_z_programmatic" })),
    ).toThrow(/invalid_revenue_channel/);
  });

  it("refuses subscription money inside a DAI log", () => {
    expect(() =>
      daiProfile.parse(daiLog({ "Revenue Channel": "channel_c_subscription" })),
    ).toThrow(/invalid_revenue_channel_for_log/);
  });

  it("refuses an unparseable request timestamp", () => {
    expect(() => daiProfile.parse(daiLog({ "Log Date": "yesterday morning" }))).toThrow(
      /invalid_timestamp/,
    );
  });

  it("refuses a DOI whose registrant is outside the 4-9 digit shape", () => {
    expect(() =>
      daiProfile.parse(daiLog({ "Show DOI": "10.555/too-short" })),
    ).toThrow(/invalid_doi/);
  });

  it("refuses zero or negative impressions", () => {
    expect(() => daiProfile.parse(daiLog({ Impressions: "0" }))).toThrow(
      /invalid_impressions/,
    );
  });

  it("refuses a CPM-less impression row — revenue must be derivable", () => {
    // A blank CPM cell is a missing column; the money grammar refuses
    // unparseable values with the invalid_money token.
    expect(() => daiProfile.parse(daiLog({ CPM: "" }))).toThrow(
      /missing_column:CPM/,
    );
    expect(() => daiProfile.parse(daiLog({ CPM: "twelve" }))).toThrow(
      /invalid_amount:CPM/,
    );
  });
});

describe("fail-closed refusals — RSS report", () => {
  it("refuses a subscription row carrying impression columns", () => {
    // A subscription line with a CPM is two revenue kinds in one row —
    // refuse rather than guess.
    expect(() =>
      rssProfile.parse(
        rssLog({ "Revenue Channel": "channel_c_subscription", Impressions: "1", CPM: "10.00" }),
      ),
    ).toThrow(/unexpected_column_for_subscription/);
  });

  it("refuses a blank-channel row that is not the subscription shape", () => {
    // No channel and no monthly recurring amount — the row names no
    // revenue kind, so it is never guessed into one.
    expect(() =>
      rssProfile.parse(rssLog({ "Revenue Channel": "" })),
    ).toThrow(/missing_revenue_channel/);
  });

  it("refuses sponsor-verification cells outside the yes/no vocabulary", () => {
    expect(() =>
      rssProfile.parse(rssLog({ "Sponsor Verified": "maybe" })),
    ).toThrow(/invalid_sponsor_verified/);
  });
});

describe("commission cell parser", () => {
  function commissionMap(cell: string): ReadonlyMap<string, string> {
    return new Map([["Network Commission %", cell]]);
  }

  it("parses percent text into basis points exactly", () => {
    expect(parseCommissionCell(commissionMap("40.00"), 1)).toBe(4000);
    expect(parseCommissionCell(commissionMap("25.00"), 1)).toBe(2500);
    expect(parseCommissionCell(commissionMap("30"), 1)).toBe(3000);
  });

  it("refuses a percent sign or decimals beyond two places", () => {
    expect(() => parseCommissionCell(commissionMap("30%"), 1)).toThrow(
      /invalid_commission/,
    );
    expect(() => parseCommissionCell(commissionMap("30.005"), 1)).toThrow(
      /invalid_commission/,
    );
  });

  it("maps an empty cell to null — the caller decides whether that fails", () => {
    expect(parseCommissionCell(commissionMap(""), 1)).toBeNull();
  });
});
