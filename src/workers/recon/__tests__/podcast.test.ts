/**
 * Podcast IAB qualification engine (PR 10) — the pure module's contract.
 *
 * Every gate is pinned BEFORE revenue exists: the bot filter's token list,
 * the 60-second threshold boundary, the 24-hour single-IP dedup window
 * (first-qualified anchoring, same-second ad units, the window edge), the
 * content-derived cross-feed fingerprint, the exact-integer CPM conversion
 * with sub-micro floors, and the commission band/bypass rules. No store,
 * no clock — the engine is deterministic by construction.
 */
import { describe, expect, it } from "vitest";

import {
  AUDIO_SECONDS_THRESHOLD,
  BOT_USER_AGENT_TOKENS,
  DEDUP_WINDOW_MS,
  MAX_COMMISSION_BPS,
  MIN_COMMISSION_BPS,
  cpmRevenueMicros,
  impressionFingerprint,
  isBotUserAgent,
  networkCommissionMicros,
  normalizeListenerIp,
  passesAudioThreshold,
  podcastHeldEventId,
  podcastImpressionEventId,
  podcastSubscriptionEventId,
  qualifyImpressionLines,
  utcDayBucket,
} from "../podcast";
import type { PodcastLineDetail, ParsedStatementLine } from "../records";

/** Builds one ad-insertion line with overrides — the engine's raw input. */
function impLine(
  overrides: Partial<PodcastLineDetail> = {},
  lineOverrides: Partial<ParsedStatementLine> = {},
): ParsedStatementLine {
  const detail: PodcastLineDetail = {
    rssFeedId: "urn:podcast:covenant:show-001",
    episodeId: "ep-2026-08-15-a",
    adCreativeId: "crtv-mid-100",
    listenerIp: "203.0.113.10",
    userAgent: "AppleCoreMedia/1.0.0",
    requestedAt: new Date("2026-08-15T10:00:05Z"),
    revenueChannel: "channel_a_dai",
    adSlot: "mid_roll",
    adPlacementType: "dai",
    networkSold: true,
    sponsorVerified: null,
    audioSeconds: 1800,
    cpmMicros: 12_000_000n,
    impressions: 1,
    commissionBps: 4000,
    ...overrides,
  };
  return {
    lineNumber: 1,
    profile: "podcast_dai_log_csv",
    rightsType: "unknown",
    statementSourceType: null,
    tierLevel: null,
    rightsPipeline: "master_digital_performance",
    period: null,
    currency: "USD",
    grossMicros: 12_000n,
    isAdjustment: false,
    identifiers: { DOI: "10.61982/covenant.show-001" },
    workTitle: null,
    territory: null,
    platform: "podcast",
    usageNote: "",
    raw: [],
    guildResidual: null,
    podcastDetail: detail,
    gamingDetail: null,
    livestreamDetail: null,
    webtoonDetail: null,
    ...lineOverrides,
  };
}

describe("bot filter", () => {
  it("pins the token list — the growth point is a list edit, not logic", () => {
    expect(BOT_USER_AGENT_TOKENS).toContain("bot");
    expect(BOT_USER_AGENT_TOKENS).toContain("crawler");
    expect(BOT_USER_AGENT_TOKENS).toContain("curl");
    expect(BOT_USER_AGENT_TOKENS).toContain("python-requests");
    expect(BOT_USER_AGENT_TOKENS).toContain("headlesschrome");
  });

  it("filters every pinned token, case-insensitively", () => {
    for (const token of ["bot", "CURL/8.0", "Python-Requests/2.31", "HeadlessChrome/126"]) {
      expect(isBotUserAgent(token)).toBe(true);
    }
  });

  it("does not filter real player user agents", () => {
    for (const ua of [
      "AppleCoreMedia/1.0.0",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
      "Spotify/8.9.0",
      "Overcast/3.0",
    ]) {
      expect(isBotUserAgent(ua)).toBe(false);
    }
  });

  it("bot lines never qualify and are counted", () => {
    const result = qualifyImpressionLines([
      impLine({ userAgent: "PodcastBot/1.0 (research crawler)" }, { lineNumber: 1 }),
      impLine({ userAgent: "wget/1.21" }, { lineNumber: 2 }),
      impLine({}, { lineNumber: 3 }),
    ]);
    expect(result.counts.botsFiltered).toBe(2);
    expect(result.counts.qualified).toBe(1);
    expect(result.verdicts.get(1)).toBe("bot_filtered");
    expect(result.verdicts.get(2)).toBe("bot_filtered");
    expect(result.verdicts.get(3)).toBe("qualified");
  });
});

describe("60-second audio request threshold", () => {
  it("pins the threshold at 60 seconds", () => {
    expect(AUDIO_SECONDS_THRESHOLD).toBe(60);
    expect(passesAudioThreshold(59)).toBe(false);
    expect(passesAudioThreshold(60)).toBe(true);
    expect(passesAudioThreshold(3600)).toBe(true);
  });

  it("rejects short requests with their own counter", () => {
    const result = qualifyImpressionLines([
      impLine({ audioSeconds: 45 }, { lineNumber: 1 }),
      impLine({ audioSeconds: 59 }, { lineNumber: 2 }),
      impLine({ audioSeconds: 60 }, { lineNumber: 3 }),
    ]);
    expect(result.counts.shortRequestsRejected).toBe(2);
    expect(result.counts.qualified).toBe(1);
    expect(result.verdicts.get(2)).toBe("short_request_rejected");
    expect(result.verdicts.get(3)).toBe("qualified");
  });

  it("fails closed on an unverifiable request (null audio seconds)", () => {
    const result = qualifyImpressionLines([
      impLine({ audioSeconds: null }),
    ]);
    expect(result.counts.unverifiableRejected).toBe(1);
    expect(result.counts.qualified).toBe(0);
  });
});

describe("24-hour single-IP dedup window", () => {
  it("pins the window at exactly 24 hours", () => {
    expect(DEDUP_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
  });

  it("anchors on the first-qualified request and dedupes requests inside the window", () => {
    const result = qualifyImpressionLines([
      impLine({}, { lineNumber: 1 }),
      impLine(
        { requestedAt: new Date("2026-08-15T10:05:05Z"), adCreativeId: "crtv-mid-300" },
        { lineNumber: 2 },
      ),
    ]);
    expect(result.counts.qualified).toBe(1);
    expect(result.counts.duplicatesDeduped).toBe(1);
    expect(result.verdicts.get(2)).toBe("duplicate_deduped");
  });

  it("counts the same request's distinct ad units as qualified (same second, different creative)", () => {
    const result = qualifyImpressionLines([
      impLine({}, { lineNumber: 1 }),
      impLine({ adCreativeId: "crtv-mid-500", adSlot: "pre_roll" }, { lineNumber: 2 }),
    ]);
    expect(result.counts.qualified).toBe(2);
    expect(result.counts.duplicatesDeduped).toBe(0);
  });

  it("re-anchors at the window edge — a request at exactly +24h is a new download", () => {
    const result = qualifyImpressionLines([
      impLine({}, { lineNumber: 1 }),
      impLine(
        {
          requestedAt: new Date("2026-08-16T10:00:05Z"),
          adCreativeId: "crtv-mid-400",
        },
        { lineNumber: 2 },
      ),
    ]);
    expect(result.counts.qualified).toBe(2);
    expect(result.counts.duplicatesDeduped).toBe(0);
  });

  it("keeps one window per (feed, episode, ip) space", () => {
    const result = qualifyImpressionLines([
      impLine({}, { lineNumber: 1 }),
      impLine({ listenerIp: "203.0.113.11" }, { lineNumber: 2 }),
      impLine({ episodeId: "ep-2026-08-15-b" }, { lineNumber: 3 }),
      impLine({ rssFeedId: "urn:podcast:covenant:show-002" }, { lineNumber: 4 }),
    ]);
    expect(result.counts.qualified).toBe(4);
    expect(result.counts.duplicatesDeduped).toBe(0);
  });

  it("processes lines in request-timestamp order regardless of file order", () => {
    // File order: the LATER request first. The window must still anchor on
    // the earlier one — the later request is the duplicate.
    const result = qualifyImpressionLines([
      impLine(
        { requestedAt: new Date("2026-08-15T10:05:05Z") },
        { lineNumber: 1 },
      ),
      impLine({}, { lineNumber: 2 }),
    ]);
    expect(result.counts.qualified).toBe(1);
    expect(result.counts.duplicatesDeduped).toBe(1);
    expect(result.verdicts.get(1)).toBe("duplicate_deduped");
    expect(result.verdicts.get(2)).toBe("qualified");
  });
});

describe("cross-feed impression fingerprint", () => {
  it("is stable for identical content — two platform dumps of one session collide", () => {
    const a = impLine();
    const b = impLine({ revenueChannel: "channel_b_host_read", networkSold: null });
    expect(impressionFingerprint(a.podcastDetail!)).toBe(
      impressionFingerprint(b.podcastDetail!),
    );
  });

  it("changes with any identity attribute", () => {
    const base = impressionFingerprint(impLine().podcastDetail!);
    expect(
      impressionFingerprint(impLine({ listenerIp: "203.0.113.11" }).podcastDetail!),
    ).not.toBe(base);
    expect(
      impressionFingerprint(impLine({ adCreativeId: "crtv-mid-300" }).podcastDetail!),
    ).not.toBe(base);
    expect(
      impressionFingerprint(impLine({ adSlot: "pre_roll" }).podcastDetail!),
    ).not.toBe(base);
    expect(
      impressionFingerprint(
        impLine({ requestedAt: new Date("2026-08-16T10:00:05Z") }).podcastDetail!,
      ),
    ).not.toBe(base);
  });

  it("buckets by UTC day — the deterministic cross-file encoding of the 24h rule", () => {
    expect(utcDayBucket(new Date("2026-08-15T23:59:59Z"))).toBe("2026-08-15");
    expect(utcDayBucket(new Date("2026-08-16T00:00:00Z"))).toBe("2026-08-16");
  });

  it("separates the countable, held, and subscription event-id spaces", () => {
    const detail = impLine().podcastDetail!;
    expect(podcastImpressionEventId(detail)).toMatch(/^podcast:imp:[0-9a-f]{64}$/);
    expect(podcastHeldEventId(detail)).toMatch(/^podcast:held:[0-9a-f]{64}$/);
    expect(podcastSubscriptionEventId("ingest-1", 3)).toBe(
      "podcast:sub:ingest-1:line:3",
    );
    // The held id space never collides with the countable one.
    expect(podcastImpressionEventId(detail)).not.toBe(podcastHeldEventId(detail));
  });
});

describe("CPM conversion — exact integer micros", () => {
  it("converts impressions × CPM / 1000 with no float anywhere", () => {
    // CPM $12.00 = 12,000,000 micros; one impression = 12,000 micros ($0.012).
    expect(cpmRevenueMicros(1, 12_000_000n)).toBe(12_000n);
    // A full mille: 1000 impressions × $1.00 CPM = $1.00 exactly.
    expect(cpmRevenueMicros(1000, 1_000_000n)).toBe(1_000_000n);
  });

  it("floors sub-micro residue — never rounds up", () => {
    // 7 × 12,345 micros = 86,415; /1000 = 86.415 → 86 (residue 415 dropped).
    expect(cpmRevenueMicros(7, 12_345n)).toBe(86n);
  });

  it("rejects invalid inputs row-scoped", () => {
    expect(() => cpmRevenueMicros(0, 12_000_000n)).toThrow(/invalid_impressions/);
    expect(() => cpmRevenueMicros(-1, 12_000_000n)).toThrow(/invalid_impressions/);
    expect(() => cpmRevenueMicros(1, 0n)).toThrow(/invalid_cpm/);
  });
});

describe("network commission — band, trigger, and the host-read bypass", () => {
  it("deducts only on network-sold DAI placement", () => {
    expect(networkCommissionMicros(12_000n, impLine().podcastDetail!)).toBe(4_800n);
    // Direct-sold: no network commission even with a rate on the row.
    expect(
      networkCommissionMicros(12_000n, impLine({ networkSold: false }).podcastDetail!),
    ).toBe(0n);
  });

  it("bypasses the commission entirely for host-read attribution", () => {
    expect(
      networkCommissionMicros(
        300_000_000n,
        impLine({
          adPlacementType: "host_read",
          networkSold: false,
          commissionBps: null,
        }).podcastDetail!,
      ),
    ).toBe(0n);
    // Even a host-read row carrying network-sold flags stays a direct deal.
    expect(
      networkCommissionMicros(
        300_000_000n,
        impLine({ adPlacementType: "host_read", networkSold: true }).podcastDetail!,
      ),
    ).toBe(0n);
  });

  it("pins the configurable 20-40% band", () => {
    expect(MIN_COMMISSION_BPS).toBe(2000);
    expect(MAX_COMMISSION_BPS).toBe(4000);
    expect(
      networkCommissionMicros(10_000n, impLine({ commissionBps: 2000 }).podcastDetail!),
    ).toBe(2_000n);
    expect(
      networkCommissionMicros(10_000n, impLine({ commissionBps: 4000 }).podcastDetail!),
    ).toBe(4_000n);
  });

  it("fails closed outside the band or without a rate", () => {
    expect(() =>
      networkCommissionMicros(10_000n, impLine({ commissionBps: 1999 }).podcastDetail!),
    ).toThrow(/commission_out_of_band/);
    expect(() =>
      networkCommissionMicros(10_000n, impLine({ commissionBps: 4001 }).podcastDetail!),
    ).toThrow(/commission_out_of_band/);
    expect(() =>
      networkCommissionMicros(10_000n, impLine({ commissionBps: null }).podcastDetail!),
    ).toThrow(/commission_out_of_band/);
  });

  it("floors the bps arithmetic — the deduction never rounds up", () => {
    // 10,001 micros at 4000 bps = 4000.4 → floor 4000.
    expect(
      networkCommissionMicros(10_001n, impLine({ commissionBps: 4000 }).podcastDetail!),
    ).toBe(4_000n);
  });
});

describe("normalizeListenerIp", () => {
  it("trims and lowercases — one listener, one key", () => {
    expect(normalizeListenerIp(" 203.0.113.10 ")).toBe("203.0.113.10");
    expect(normalizeListenerIp("2001:DB8::1")).toBe("2001:db8::1");
  });
});
