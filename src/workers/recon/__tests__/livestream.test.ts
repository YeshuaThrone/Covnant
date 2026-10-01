// CVT recon worker — the livestream lane's converter math (PR 14).
// Pure-function pins: the exact bigint conversion product (never a float,
// the sub-micro residue flooring away), the Kick 95/5 split's conservation,
// the CPM per-thousand division, the share-band validation, and the event-id
// identity spaces (lane-scoped, ingest-scoped, deterministic).

import { describe, expect, it } from "vitest";
import {
  convertVirtualToMicros,
  DEFAULT_BITS_NET_RATE,
  DEFAULT_KICK_CREATOR_SHARE_BPS,
  esportsPrizePoolLineEventId,
  livestreamConversionEventId,
  livestreamLineEventId,
  overlayCpmGrossMicros,
  splitKickSubscription,
  validateKickCreatorShareBps,
} from "../livestream";
import { parseStatementMoney } from "../delimited";

const MICROS_PER_DOLLAR = 100_000_000n;

function dollarsToMicros(text: string): bigint {
  return parseStatementMoney(text).micros;
}

describe("convertVirtualToMicros — the founder's rate-logged conversion", () => {
  it("converts Bits at the default $0.01/bit net rate exactly to the cent", () => {
    // 500 bits × $0.01 = $5.00 = 5,000 cents.
    const grossMicros = convertVirtualToMicros(
      500n * MICROS_PER_DOLLAR,
      dollarsToMicros(DEFAULT_BITS_NET_RATE),
    );
    expect(grossMicros).toBe(500_000_000n); // $5.00 in micros
  });

  it("floors the sub-micro residue — 1 bit at a 0.0035 rate cannot invent money", () => {
    // 1 bit × $0.0035 = $0.0035 → 350,000 micros exactly.
    expect(convertVirtualToMicros(MICROS_PER_DOLLAR, 350_000n)).toBe(350_000n);
    // 3 bits × $0.0001 = $0.0003 = 30,000 micros — exact.
    expect(convertVirtualToMicros(3n * MICROS_PER_DOLLAR, 10_000n)).toBe(30_000n);
  });

  it("keeps the conversion exact for awkward decimals (no float anywhere)", () => {
    // 1,234.5678 units at 0.0035 — the product 4.32098730 fits the house
    // 1e-8-dollar scale exactly, and the math lands on it without a float.
    const amountMicros = dollarsToMicros("1234.5678");
    const rateMicros = dollarsToMicros("0.0035");
    expect(convertVirtualToMicros(amountMicros, rateMicros)).toBe(
      432_098_730n,
    ); // $4.32098730 — every digit exact
  });

  it("refuses negative operands — the math module's own belt", () => {
    expect(() => convertVirtualToMicros(-1n, 100n)).toThrow(
      /negative_conversion_operand/,
    );
    expect(() => convertVirtualToMicros(1n, -100n)).toThrow(
      /negative_conversion_operand/,
    );
  });
});

describe("splitKickSubscription — the 95/5 model", () => {
  it("splits the gross at 9500 bps with the platform taking the exact complement", () => {
    // $10.00 gross → creator $9.50, platform $0.50.
    const split = splitKickSubscription(
      10n * MICROS_PER_DOLLAR,
      DEFAULT_KICK_CREATOR_SHARE_BPS,
    );
    expect(split.creatorNetMicros).toBe(950_000_000n);
    expect(split.platformFeeMicros).toBe(50_000_000n);
    expect(split.creatorNetMicros + split.platformFeeMicros).toBe(
      10n * MICROS_PER_DOLLAR,
    );
  });

  it("conserves every micro on floor-heavy grosses — creator + fee === gross, ALWAYS", () => {
    // 1 micro at 9500 bps: creator floors to 0, platform takes the whole micro.
    const split = splitKickSubscription(1n, DEFAULT_KICK_CREATOR_SHARE_BPS);
    expect(split.creatorNetMicros).toBe(0n);
    expect(split.platformFeeMicros).toBe(1n);
    expect(split.creatorNetMicros + split.platformFeeMicros).toBe(1n);
  });

  it("honors contract-configured shares (a 97/3 deal records 9700 bps)", () => {
    const split = splitKickSubscription(10n * MICROS_PER_DOLLAR, 9700);
    expect(split.creatorNetMicros).toBe(970_000_000n);
    expect(split.platformFeeMicros).toBe(30_000_000n);
  });

  it("refuses shares outside (0, 10000) and negative grosses", () => {
    expect(() => splitKickSubscription(1n, 0)).toThrow(/invalid_kick_creator_share/);
    expect(() => splitKickSubscription(1n, 10000)).toThrow(
      /invalid_kick_creator_share/,
    );
    expect(() => splitKickSubscription(-1n, 9500)).toThrow(/negative_kick_gross/);
  });

  it("validates contract shares through the same band", () => {
    expect(() => validateKickCreatorShareBps(9500)).not.toThrow();
    expect(() => validateKickCreatorShareBps(10000)).toThrow(RangeError);
    expect(() => validateKickCreatorShareBps(0)).toThrow(RangeError);
  });
});

describe("overlayCpmGrossMicros — sponsorship alert pricing", () => {
  it("prices a CPM alert as impressions × cost-per-mille / 1000", () => {
    // 10,000 impressions at a $2.50 CPM = $25.00.
    expect(overlayCpmGrossMicros(10_000, dollarsToMicros("2.5"))).toBe(
      25n * MICROS_PER_DOLLAR,
    );
  });

  it("floors the per-thousand division's residue — never rounds up", () => {
    // 999 impressions at $1 CPM = $0.999 → the residue floors away.
    expect(overlayCpmGrossMicros(999, MICROS_PER_DOLLAR)).toBe(99_900_000n);
  });

  it("refuses negative or fractional impressions and negative rates", () => {
    expect(() => overlayCpmGrossMicros(-1, 1n)).toThrow(/invalid_cpm_impressions/);
    expect(() => overlayCpmGrossMicros(1.5, 1n)).toThrow(/invalid_cpm_impressions/);
    expect(() => overlayCpmGrossMicros(100, -1n)).toThrow(/negative_cpm_rate/);
  });
});

describe("the event-id identity spaces", () => {
  it("scopes stream payout rows to the livestream:line space, ingest and row specific", () => {
    expect(livestreamLineEventId("twitch", "ingest-1", 3)).toBe(
      "livestream:line:twitch:ingest-1:line:3",
    );
    expect(livestreamLineEventId("twitch", "ingest-1", 4)).not.toBe(
      livestreamLineEventId("twitch", "ingest-1", 3),
    );
    expect(livestreamLineEventId("kick", "ingest-1", 3)).not.toBe(
      livestreamLineEventId("twitch", "ingest-1", 3),
    );
  });

  it("scopes prize-pool receipt rows to the esports:pool space, carrying the batch ref", () => {
    expect(esportsPrizePoolLineEventId("batch-7", "ingest-1", 1)).toBe(
      "esports:pool:batch-7:ingest-1:line:1",
    );
  });

  it("derives the conversion-log id deterministically from the line event id", () => {
    const lineId = livestreamLineEventId("twitch", "ingest-1", 3);
    expect(livestreamConversionEventId(lineId)).toBe(
      `livestream:conv:${lineId}`,
    );
    // A replayed ingest re-derives the same id — the UNIQUE guard's key.
    expect(livestreamConversionEventId(lineId)).toBe(
      livestreamConversionEventId(lineId),
    );
  });
});
