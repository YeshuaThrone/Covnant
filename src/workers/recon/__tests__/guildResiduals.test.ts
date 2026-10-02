/**
 * Guild residual tests — versioned per-guild rate selection by effective
 * date, floor discipline in the 1e-8 micros space, the film-only scope
 * (music lines carry no residuals), hold-row shape (tier 2, quarantined,
 * no identifiers), and fail-closed behavior for unversioned periods.
 */
import { describe, expect, it } from "vitest";

import {
  GUILD_RESIDUAL_GUILDS,
  GUILD_RESIDUAL_RATE_TABLES,
  calculateGuildResiduals,
  residualObligationMicros,
  selectRateVersion,
} from "../guildResiduals";
import type { ParsedStatementLine } from "../records";

/** Builds one film receipt line at the given micros and period. */
function filmLine(micros: bigint, period: string): ParsedStatementLine {
  return {
    lineNumber: 1,
    profile: "film_vod_csv",
    rightsType: "unknown",
    statementSourceType: "vod",
    tierLevel: 0,
    rightsPipeline: "master_digital_performance",
    period,
    currency: "USD",
    grossMicros: micros,
    isAdjustment: false,
    identifiers: { EIDR: "10.5240/000A-000B-000C-000D-000E-F" },
    workTitle: "Midnight Reel",
    territory: "US",
    platform: "Amazon Prime",
    usageNote: "test receipt",
    raw: [],
    guildResidual: null,
    podcastDetail: null,
    gamingDetail: null,
    livestreamDetail: null,
    webtoonDetail: null,
  };
}

describe("rate table versions", () => {
  it("is a versioned table per guild — the growth point for new contracts", () => {
    expect(GUILD_RESIDUAL_GUILDS).toEqual(["SAG_AFTRA", "WGA", "DGA"]);
    for (const guild of GUILD_RESIDUAL_GUILDS) {
      const versions = GUILD_RESIDUAL_RATE_TABLES[guild];
      expect(versions.length).toBeGreaterThanOrEqual(1);
      for (const version of versions) {
        expect(version.version).toBe("2026-contract");
        expect(version.effectiveFrom).toBe("2026-01-01");
      }
    }
  });

  it("pins the 2026 contract rates", () => {
    expect(GUILD_RESIDUAL_RATE_TABLES.SAG_AFTRA[0].rates.SAG_AFTRA).toBe(640);
    expect(GUILD_RESIDUAL_RATE_TABLES.WGA[0].rates.WGA).toBe(150);
    expect(GUILD_RESIDUAL_RATE_TABLES.DGA[0].rates.DGA).toBe(180);
  });
});

describe("selectRateVersion", () => {
  it("selects the latest version effective on or before the period", () => {
    const version = selectRateVersion("SAG_AFTRA", "2026-08");
    expect(version).not.toBeNull();
    expect(version?.effectiveFrom).toBe("2026-01-01");
  });

  it("accepts a full-date period cell", () => {
    expect(selectRateVersion("WGA", "2026-08-15")?.rates.WGA).toBe(150);
  });

  it("returns null when the period predates every version (caller fails closed)", () => {
    expect(selectRateVersion("DGA", "2025-12")).toBeNull();
  });

  it("rejects a period that is neither YYYY-MM nor YYYY-MM-DD", () => {
    expect(() => selectRateVersion("SAG_AFTRA", "August 2026")).toThrow(/invalid_period/);
  });
});

describe("residualObligationMicros", () => {
  it("is exact bigint math at whole basis points", () => {
    expect(residualObligationMicros(47_904_000_000n, 640)).toBe(3_065_856_000n);
  });

  it("floors non-exact division — never rounds, never floats", () => {
    expect(residualObligationMicros(12_345n, 640)).toBe(790n); // 790.08
    expect(residualObligationMicros(12_345n, 150)).toBe(185n); // 185.175
    expect(residualObligationMicros(12_345n, 180)).toBe(222n); // 222.21
  });
});

describe("calculateGuildResiduals", () => {
  it("emits one tier-2 hold per guild per positive film receipt line", () => {
    const holds = calculateGuildResiduals([filmLine(47_904_000_000n, "2026-08")]);
    expect(holds).toHaveLength(3);
    expect(holds.map((hold) => hold.guildResidual?.guild)).toEqual([
      "SAG_AFTRA",
      "WGA",
      "DGA",
    ]);
  });

  it("pins the obligation micros and the recompute provenance on each hold", () => {
    const [sag, wga, dga] = calculateGuildResiduals([filmLine(47_904_000_000n, "2026-08")]);
    expect(sag.guildResidual).toEqual({
      guild: "SAG_AFTRA",
      rate_table_version: "2026-contract",
      effective_from: "2026-01-01",
      rate_bps: 640,
      base_micros: "47904000000",
      obligation_micros: "3065856000",
    });
    expect(BigInt(sag.guildResidual!.obligation_micros)).toBe(3_065_856_000n);
    expect(BigInt(wga.guildResidual!.obligation_micros)).toBe(718_560_000n);
    expect(BigInt(dga.guildResidual!.obligation_micros)).toBe(862_272_000n);
  });

  it("shapes holds as quarantined tier-2 rows that can never re-enter split math", () => {
    const [hold] = calculateGuildResiduals([filmLine(47_904_000_000n, "2026-08")]);
    expect(hold.tierLevel).toBe(2);
    expect(hold.rightsType).toBe("unknown");
    expect(hold.statementSourceType).toBe("vod"); // inherited provenance
    expect(hold.identifiers).toEqual({}); // holds never cross-reference the vault
    expect(hold.isAdjustment).toBe(false);
    expect(hold.grossMicros).toBe(BigInt(hold.guildResidual!.obligation_micros));
  });

  it("skips music lines (statement kind null) — residuals are film obligations", () => {
    const musicLine: ParsedStatementLine = {
      ...filmLine(47_904_000_000n, "2026-08"),
      statementSourceType: null,
    };
    expect(calculateGuildResiduals([musicLine])).toHaveLength(0);
  });

  it("skips adjustments and non-positive receipts", () => {
    const holds = calculateGuildResiduals([
      filmLine(-500_000n, "2026-08"),
      filmLine(0n, "2026-08"),
    ]);
    expect(holds).toHaveLength(0);
  });

  it("computes per receipt line — obligations never net against each other", () => {
    const holds = calculateGuildResiduals([
      filmLine(47_904_000_000n, "2026-08"),
      filmLine(13_972_000_000n, "2026-08"),
    ]);
    const sagHolds = holds.filter((hold) => hold.guildResidual?.guild === "SAG_AFTRA");
    expect(sagHolds).toHaveLength(2);
    expect(sagHolds[0].grossMicros).toBe(3_065_856_000n);
    expect(sagHolds[1].grossMicros).toBe(894_208_000n);
  });

  it("fails closed when a film line has no period — never a skipped obligation", () => {
    const noPeriod: ParsedStatementLine = {
      ...filmLine(1_000n, "2026-08"),
      period: null,
    };
    expect(() => calculateGuildResiduals([noPeriod])).toThrow(/missing_period:row_1/);
  });

  it("fails closed when no rate version covers the period", () => {
    expect(() => calculateGuildResiduals([filmLine(1_000n, "2024-01")])).toThrow(
      /no_rate_version:SAG_AFTRA:2024-01:row_1/,
    );
  });
});
