/**
 * Gaming fee engine (PR 12) — the pure math's fail-closed discipline, the
 * founder directive's pinned numbers: the $1M annual per-product threshold
 * boundary (the marginal 3.5% window), the per-platform commission bands,
 * the secondary-resale royalty band, and the DevEx conversion's exact
 * bigint math (never a float, residue floored — never rounded up).
 */
import { describe, expect, it } from "vitest";

import type { GamingLineDetail } from "../records";
import {
  ENGINE_ROYALTY_BPS,
  ENGINE_ROYALTY_THRESHOLD_MICROS,
  MICROS_SCALE,
  devexGrossMicros,
  engineRoyaltyMicros,
  gamingLineEventId,
  gamingResalePayoutEventId,
  isEpicFamilyPlatform,
  platformCommissionMicros,
  resaleRoyaltyPoolMicros,
  validateCommissionBps,
  validateResaleRoyaltyBps,
} from "../gaming";

/** A line detail with per-test overrides — Epic family by default. */
function detail(overrides: Partial<GamingLineDetail>): GamingLineDetail {
  return {
    platform: "unreal_marketplace",
    productId: "PROD-001",
    productName: "Covenant Chronicles",
    itemId: "ITEM-001",
    itemName: "Aurora Skin",
    saleType: "primary",
    commissionBps: 1200,
    engineRoyaltySubject: true,
    resaleRoyaltyBps: null,
    virtualCurrencyCode: null,
    virtualAmount: null,
    exchangeRate: null,
    annualYear: 2026,
    ...overrides,
  };
}

describe("engine-royalty threshold — the $1M annual per-product line", () => {
  it("pins the threshold constant to exactly $1M in 1e-8 micros", () => {
    // $1,000,000 × 10^8 statement micros per dollar.
    expect(ENGINE_ROYALTY_THRESHOLD_MICROS).toBe(100_000_000_000_000n);
    expect(ENGINE_ROYALTY_THRESHOLD_MICROS).toBe(1_000_000n * MICROS_SCALE);
  });

  it("levies nothing while the product-year sits below the threshold", () => {
    const gross = 100_000n * MICROS_SCALE; // $100,000
    const cumBefore = 899_999n * MICROS_SCALE; // $899,999 recorded
    expect(engineRoyaltyMicros(detail({}), gross, cumBefore)).toBe(0n);
  });

  it("pins the boundary: gross ending EXACTLY at $1M owes nothing", () => {
    const gross = 100_000n * MICROS_SCALE;
    const cumBefore = 900_000n * MICROS_SCALE; // window [900k, 1000k)
    expect(engineRoyaltyMicros(detail({}), gross, cumBefore)).toBe(0n);
  });

  it("levies 3.5% on the portion of the window above the threshold only", () => {
    // Window [900k, 1150k): $150k taxable at 3.5% = $5,250.
    const gross = 250_000n * MICROS_SCALE;
    const cumBefore = 900_000n * MICROS_SCALE;
    expect(engineRoyaltyMicros(detail({}), gross, cumBefore)).toBe(
      525_000_000_000n,
    );
  });

  it("levies on the WHOLE line once the accumulator starts past the threshold", () => {
    const gross = 50_000n * MICROS_SCALE;
    const cumBefore = 1_000_000n * MICROS_SCALE; // already at $1M
    const expected = (gross * BigInt(ENGINE_ROYALTY_BPS)) / 10000n;
    expect(engineRoyaltyMicros(detail({}), gross, cumBefore)).toBe(expected);
  });

  it("waives the EGS sale but still counts its gross (the waiver is on the rate)", () => {
    const gross = 900_000n * MICROS_SCALE;
    const egs = detail({
      platform: "epic_games_store",
      engineRoyaltySubject: false,
    });
    expect(engineRoyaltyMicros(egs, gross, 0n)).toBe(0n);
  });

  it("levies nothing on non-Epic platforms — no accumulator, no royalty", () => {
    const gross = 5_000_000n * MICROS_SCALE;
    const steam = detail({ platform: "steamworks", engineRoyaltySubject: false });
    const roblox = detail({ platform: "roblox", engineRoyaltySubject: false });
    const apple = detail({
      platform: "apple_vision_pro",
      engineRoyaltySubject: false,
    });
    const unity = detail({
      platform: "unity_asset_store",
      engineRoyaltySubject: false,
    });
    for (const line of [steam, roblox, apple, unity]) {
      expect(engineRoyaltyMicros(line, gross, 0n)).toBe(0n);
    }
  });

  it("refuses hostile operands — a negative gross or accumulator", () => {
    const gross = 100n * MICROS_SCALE;
    expect(() => engineRoyaltyMicros(detail({}), -gross, 0n)).toThrow(
      "negative_gross",
    );
    expect(() => engineRoyaltyMicros(detail({}), gross, -1n)).toThrow(
      "negative_accumulator",
    );
  });

  it("discriminates the Epic family — exactly the two storefronts", () => {
    expect(isEpicFamilyPlatform("epic_games_store")).toBe(true);
    expect(isEpicFamilyPlatform("unreal_marketplace")).toBe(true);
    expect(isEpicFamilyPlatform("roblox")).toBe(false);
    expect(isEpicFamilyPlatform("steamworks")).toBe(false);
    expect(isEpicFamilyPlatform("unity_asset_store")).toBe(false);
    expect(isEpicFamilyPlatform("apple_vision_pro")).toBe(false);
  });
});

describe("platform commission bands — the founder-pinned rates", () => {
  it("pins Apple's 15-30% RANGE", () => {
    expect(() => validateCommissionBps("apple_vision_pro", 1500)).not.toThrow();
    expect(() => validateCommissionBps("apple_vision_pro", 3000)).not.toThrow();
    expect(() => validateCommissionBps("apple_vision_pro", 1499)).toThrow(
      "commission_out_of_band:apple_vision_pro:1499",
    );
    expect(() => validateCommissionBps("apple_vision_pro", 3001)).toThrow(
      "commission_out_of_band:apple_vision_pro:3001",
    );
  });

  it("pins Steam, Unity, Roblox at exactly 30% and the Epic family at 12%", () => {
    for (const platform of [
      "steamworks",
      "unity_asset_store",
      "roblox",
    ] as const) {
      expect(() => validateCommissionBps(platform, 3000)).not.toThrow();
      expect(() => validateCommissionBps(platform, 2999)).toThrow(
        `commission_out_of_band:${platform}:2999`,
      );
      expect(() => validateCommissionBps(platform, 3001)).toThrow();
    }
    for (const platform of [
      "epic_games_store",
      "unreal_marketplace",
    ] as const) {
      expect(() => validateCommissionBps(platform, 1200)).not.toThrow();
      expect(() => validateCommissionBps(platform, 1199)).toThrow(
        `commission_out_of_band:${platform}:1199`,
      );
      expect(() => validateCommissionBps(platform, 1201)).toThrow();
    }
  });
});

describe("secondary resale royalty — the 5-10% creator-fee band", () => {
  it("accepts the band edges on secondary_resale lines", () => {
    expect(validateResaleRoyaltyBps("secondary_resale", 500)).toBe(500);
    expect(validateResaleRoyaltyBps("secondary_resale", 1000)).toBe(1000);
    expect(validateResaleRoyaltyBps("secondary_resale", 700)).toBe(700);
  });

  it("refuses outside the band, or a missing rate, on secondary lines", () => {
    expect(() => validateResaleRoyaltyBps("secondary_resale", 499)).toThrow(
      "resale_royalty_out_of_band:499",
    );
    expect(() => validateResaleRoyaltyBps("secondary_resale", 1001)).toThrow(
      "resale_royalty_out_of_band:1001",
    );
    expect(() => validateResaleRoyaltyBps("secondary_resale", null)).toThrow(
      "resale_royalty_out_of_band:null",
    );
  });

  it("refuses a royalty rate on a primary sale — nothing to route downstream", () => {
    expect(validateResaleRoyaltyBps("primary", null)).toBeNull();
    expect(() => validateResaleRoyaltyBps("primary", 700)).toThrow(
      "unexpected_resale_royalty:700",
    );
  });
});

describe("platform commission and pool math — exact bigint micros", () => {
  it("computes gross × bps / 10000 with bigint floor", () => {
    // $900,000 at 12% = $108,000.
    expect(platformCommissionMicros(900_000n * MICROS_SCALE, 1200)).toBe(
      108_000n * MICROS_SCALE,
    );
    // $59.99 at 30% = $17.997 = 1.7997e9 micros (the floor is exact here).
    expect(platformCommissionMicros(59_99n * 1_000_000n, 3000)).toBe(
      1_799_700_000n,
    );
  });

  it("refuses a negative gross", () => {
    expect(() => platformCommissionMicros(-1n, 1200)).toThrow("negative_gross");
  });

  it("returns an empty pool when no resale royalty applies", () => {
    expect(resaleRoyaltyPoolMicros(100n * MICROS_SCALE, null)).toBe(0n);
    expect(resaleRoyaltyPoolMicros(100n * MICROS_SCALE, 700)).toBe(
      7n * MICROS_SCALE,
    );
  });
});

describe("the Roblox DevEx conversion — virtual × recorded rate", () => {
  it("converts exactly: 100,000 Robux at $0.0035 = $350.00", () => {
    const robux = 100_000n * MICROS_SCALE; // "100000" as 1e-8 fixed point
    const rate = 350_000n; // "0.0035" as 1e-8 fixed point
    expect(devexGrossMicros(robux, rate)).toBe(35_000_000_000n); // $350
  });

  it("keeps sub-cent fiat honest: 1 Robux at $0.0035 = $0.0035", () => {
    const robux = 1n * MICROS_SCALE;
    const rate = 350_000n;
    expect(devexGrossMicros(robux, rate)).toBe(350_000n);
  });

  it("floors non-even products — residue never rounds up into money", () => {
    // 3.00000001 Robux at 0.0035: product = 105000000350000 micros,
    // / 1e8 = 1050000.0035 → floors to 1050000 (the 0.0035-micro residue
    // is dropped, never rounded up).
    const robux = 300_000_001n;
    const rate = 350_000n;
    expect(devexGrossMicros(robux, rate)).toBe(1_050_000n);
  });

  it("refuses a negative operand", () => {
    expect(() => devexGrossMicros(-1n, 350_000n)).toThrow(
      "negative_devex_operand",
    );
    expect(() => devexGrossMicros(1n * MICROS_SCALE, -1n)).toThrow(
      "negative_devex_operand",
    );
  });
});

describe("the gaming identity spaces — content-derived event ids", () => {
  it("derives the line event id from platform + ingest + row", () => {
    expect(
      gamingLineEventId(detail({ platform: "roblox" }), "ing_123", 7),
    ).toBe("gaming:line:roblox:ing_123:line:7");
  });

  it("derives the resale payout id from the funding line + payee", () => {
    const lineEventId = gamingLineEventId(detail({}), "ing_123", 2);
    expect(gamingResalePayoutEventId(lineEventId, "payee_orig")).toBe(
      `gaming:royalty:${lineEventId}:payee_orig`,
    );
  });
});
