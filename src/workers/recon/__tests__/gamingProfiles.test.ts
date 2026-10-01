/**
 * Gaming ingestion profiles (PR 12) — dispatch, strict parsing, and the
 * fail-closed refusal grammar, pinned to the checked-in fixture logs.
 *
 * The fixtures are the standing spec: the Epic-family threshold crossing
 * ($900k EGS waived + $250k Unreal taxable), the Roblox DevEx conversion
 * with its sub-cent net row, the Steam cent-flooring gross, the Unity
 * primary + secondary-resale pair, and the Apple 15% band-floor row.
 * Hostile rows are synthesized inline over the real headers; each asserts
 * the exact StatementParseError token the profile must refuse with.
 */
import { describe, expect, it } from "vitest";

import { dispatchStatementProfile } from "../profiles";
import { GAMING_PROFILES, isGamingProfileKind } from "../gamingProfiles";
import { loadFixture } from "./fixtures";

function requireProfile(kind: string) {
  const profile = GAMING_PROFILES.find((p) => p.kind === kind);
  if (profile === undefined) throw new Error(`profile missing: ${kind}`);
  return profile;
}

const EPIC = requireProfile("epic_games_sales_csv");
const UNITY = requireProfile("unity_asset_store_payout_csv");
const ROBLOX = requireProfile("roblox_devex_csv");
const STEAM = requireProfile("steamworks_sales_csv");
const APPLE = requireProfile("apple_vision_pro_payments_csv");

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

describe("gaming profile registry — dispatch and the lane discriminator", () => {
  it("registers exactly the five gaming profile kinds", () => {
    expect(GAMING_PROFILES.map((p) => p.kind)).toEqual([
      "epic_games_sales_csv",
      "unity_asset_store_payout_csv",
      "roblox_devex_csv",
      "steamworks_sales_csv",
      "apple_vision_pro_payments_csv",
    ]);
    for (const kind of GAMING_PROFILES.map((p) => p.kind)) {
      expect(isGamingProfileKind(kind)).toBe(true);
    }
    expect(isGamingProfileKind("distrokid_csv")).toBe(false);
    expect(isGamingProfileKind("podcast_dai_log_csv")).toBe(false);
  });

  it("dispatches each checked-in fixture to its gaming profile", () => {
    expect(dispatchStatementProfile(loadFixture("gaming_epic_sales.csv"))?.kind).toBe(
      "epic_games_sales_csv",
    );
    expect(dispatchStatementProfile(loadFixture("gaming_unity_payout.csv"))?.kind).toBe(
      "unity_asset_store_payout_csv",
    );
    expect(dispatchStatementProfile(loadFixture("gaming_roblox_devex.csv"))?.kind).toBe(
      "roblox_devex_csv",
    );
    expect(dispatchStatementProfile(loadFixture("gaming_steamworks.csv"))?.kind).toBe(
      "steamworks_sales_csv",
    );
    expect(
      dispatchStatementProfile(loadFixture("gaming_apple_vision_pro.csv"))?.kind,
    ).toBe("apple_vision_pro_payments_csv");
  });

  it("does not match a mutated header — the strict-header rule", () => {
    expect(
      EPIC.matches(loadFixture("gaming_epic_sales.csv").replace("Gross", "Amount")),
    ).toBe(false);
    expect(EPIC.matches("Sale Date,Store\n2026-01-15,epic_games_store\n")).toBe(
      false,
    );
  });
});

describe("Epic family parsing — the threshold-crossing fixture", () => {
  const lines = EPIC.parse(loadFixture("gaming_epic_sales.csv"));

  it("parses both rows with full gaming context", () => {
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.gamingDetail !== null)).toBe(true);
  });

  it("parses the waived EGS sale — $900,000 gross at exactly 12%", () => {
    const row1 = lines[0]!;
    // $900,000.00 → 90,000,000,000,000 units at the house 1e-8-dollar scale.
    expect(row1.grossMicros).toBe(90_000_000_000_000n);
    expect(row1.gamingDetail?.platform).toBe("epic_games_store");
    expect(row1.gamingDetail?.commissionBps).toBe(1200);
    // The waiver is a RATE fact: EGS sales never bear the 3.5% royalty,
    // but their gross still counts toward the accumulator (the queue pass
    // records the contribution either way).
    expect(row1.gamingDetail?.engineRoyaltySubject).toBe(false);
    expect(row1.gamingDetail?.saleType).toBe("primary");
    expect(row1.gamingDetail?.annualYear).toBe(2026);
    expect(row1.identifiers.DOI).toBe("10.61982/covenant.game-001");
  });

  it("parses the taxable Unreal Marketplace sale — $250,000, royalty-subject", () => {
    const row2 = lines[1]!;
    expect(row2.grossMicros).toBe(25_000_000_000_000n);
    expect(row2.gamingDetail?.platform).toBe("unreal_marketplace");
    expect(row2.gamingDetail?.engineRoyaltySubject).toBe(true);
    expect(row2.gamingDetail?.resaleRoyaltyBps).toBeNull();
  });

  it("refuses an unknown storefront — the store cell is a closed vocabulary", () => {
    expect(() =>
      EPIC.parse(withCells("gaming_epic_sales.csv", { Store: "itch_io" })),
    ).toThrow(/invalid_store:itch_io:row_1/);
  });
});

describe("Roblox DevEx parsing — the conversion fixture", () => {
  const lines = ROBLOX.parse(loadFixture("gaming_roblox_devex.csv"));

  it("parses both rows and derives gross from virtual × recorded rate", () => {
    expect(lines).toHaveLength(2);
    // 100,000 Robux at $0.0035 = $350.00 exactly.
    expect(lines[0]!.grossMicros).toBe(35_000_000_000n);
    // 1 Robux at $0.0035 = $0.0035 — sub-cent, the posting pass skips it.
    expect(lines[1]!.grossMicros).toBe(350_000n);
  });

  it("keeps the virtual operands and the Robux code on the line verbatim", () => {
    const row1 = lines[0]!;
    expect(row1.gamingDetail?.virtualCurrencyCode).toBe("ROBUX");
    expect(row1.gamingDetail?.virtualAmount).toBe("100000");
    expect(row1.gamingDetail?.exchangeRate).toBe("0.0035");
    expect(row1.gamingDetail?.platform).toBe("roblox");
    expect(row1.gamingDetail?.commissionBps).toBe(3000);
  });

  it("refuses a non-positive Robux balance — no conversions from nothing", () => {
    for (const amount of ["0", "-5"]) {
      expect(() =>
        ROBLOX.parse(withCells("gaming_roblox_devex.csv", { "Robux Amount": amount })),
      ).toThrow(new RegExp(`invalid_robux_amount:${amount}:row_1`));
    }
  });

  it("refuses a missing or zero exchange rate — a zero-rate conversion invents money", () => {
    expect(() =>
      ROBLOX.parse(withCells("gaming_roblox_devex.csv", { "Exchange Rate": "0" })),
    ).toThrow(/invalid_exchange_rate:0:row_1/);
    expect(() =>
      ROBLOX.parse(
        withCells("gaming_roblox_devex.csv", { "Exchange Rate": "" }),
      ),
    ).toThrow(/missing_column:Exchange Rate:row_1/);
  });

  it("refuses a fee outside the pinned 30% Roblox band", () => {
    expect(() =>
      ROBLOX.parse(withCells("gaming_roblox_devex.csv", { "Platform Fee %": "25" })),
    ).toThrow(/commission_out_of_band:roblox:2500:row_1/);
  });
});

describe("Steamworks parsing — the cent-flooring fixture", () => {
  const lines = STEAM.parse(loadFixture("gaming_steamworks.csv"));

  it("parses the $59.99 sale at the pinned 30%", () => {
    expect(lines).toHaveLength(1);
    // $59.99 → 5,999,000,000 units.
    expect(lines[0]!.grossMicros).toBe(5_999_000_000n);
    expect(lines[0]!.gamingDetail?.platform).toBe("steamworks");
    expect(lines[0]!.gamingDetail?.commissionBps).toBe(3000);
    expect(lines[0]!.gamingDetail?.engineRoyaltySubject).toBe(false);
  });

  it("refuses a commission off the pinned 30% — Steam has no band", () => {
    expect(() =>
      STEAM.parse(withCells("gaming_steamworks.csv", { "Platform Commission %": "25" })),
    ).toThrow(/commission_out_of_band:steamworks:2500:row_1/);
  });
});

describe("Unity parsing — the primary + secondary-resale fixture", () => {
  const lines = UNITY.parse(loadFixture("gaming_unity_payout.csv"));

  it("parses the primary sale with an empty resale-royalty cell", () => {
    const row1 = lines[0]!;
    expect(row1.grossMicros).toBe(4_999_000_000n); // $49.99
    expect(row1.gamingDetail?.saleType).toBe("primary");
    expect(row1.gamingDetail?.resaleRoyaltyBps).toBeNull();
  });

  it("parses the secondary resale with its 7% royalty", () => {
    const row2 = lines[1]!;
    expect(row2.grossMicros).toBe(1_999_000_000n); // $19.99
    expect(row2.gamingDetail?.saleType).toBe("secondary_resale");
    expect(row2.gamingDetail?.resaleRoyaltyBps).toBe(700);
  });

  it("refuses a royalty rate on a primary sale — nothing to route downstream", () => {
    expect(() =>
      UNITY.parse(
        withCells("gaming_unity_payout.csv", { "Resale Royalty %": "7" }),
      ),
    ).toThrow(/unexpected_resale_royalty:700:row_1/);
  });

  it("refuses a secondary resale without its royalty rate", () => {
    // Make the hostile row a genuine secondary resale — a primary row with
    // an empty cell is the contract-correct shape.
    expect(() =>
      UNITY.parse(
        withCells("gaming_unity_payout.csv", {
          "Sale Type": "secondary_resale",
          "Resale Royalty %": "",
        }),
      ),
    ).toThrow(/resale_royalty_out_of_band:null:row_1/);
  });

  it("refuses a royalty outside the 5-10% band", () => {
    // The fixture's first row is PRIMARY — make the hostile row a genuine
    // secondary resale so the BAND check fires, not the primary-sale rule.
    for (const royalty of ["4", "11"]) {
      expect(() =>
        UNITY.parse(
          withCells("gaming_unity_payout.csv", {
            "Sale Type": "secondary_resale",
            "Resale Royalty %": royalty,
          }),
        ),
      ).toThrow(
        new RegExp(
          `resale_royalty_out_of_band:${royalty === "4" ? "400" : "1100"}:row_1`,
        ),
      );
    }
  });
});

describe("Apple Vision Pro parsing — the band-floor fixture", () => {
  const lines = APPLE.parse(loadFixture("gaming_apple_vision_pro.csv"));

  it("parses the $9.99 sale at Apple's 15% floor", () => {
    expect(lines).toHaveLength(1);
    // $9.99 → 999,000,000 units.
    expect(lines[0]!.grossMicros).toBe(999_000_000n);
    expect(lines[0]!.gamingDetail?.platform).toBe("apple_vision_pro");
    expect(lines[0]!.gamingDetail?.commissionBps).toBe(1500);
  });

  it("accepts the 30% ceiling and refuses outside Apple's 15-30% RANGE", () => {
    expect(() =>
      APPLE.parse(
        withCells("gaming_apple_vision_pro.csv", { "Platform Commission %": "30" }),
      ),
    ).not.toThrow();
    expect(() =>
      APPLE.parse(
        withCells("gaming_apple_vision_pro.csv", { "Platform Commission %": "12" }),
      ),
    ).toThrow(/commission_out_of_band:apple_vision_pro:1200:row_1/);
    expect(() =>
      APPLE.parse(
        withCells("gaming_apple_vision_pro.csv", { "Platform Commission %": "31" }),
      ),
    ).toThrow(/commission_out_of_band:apple_vision_pro:3100:row_1/);
  });
});

describe("the shared refusal grammar — every gaming profile", () => {
  it("refuses an unknown sale type", () => {
    expect(() =>
      STEAM.parse(withCells("gaming_steamworks.csv", { "Sale Type": "refund" })),
    ).toThrow(/invalid_sale_type:refund:row_1/);
  });

  it("refuses a missing commission — never a guessed rate", () => {
    expect(() =>
      STEAM.parse(
        withCells("gaming_steamworks.csv", { "Platform Commission %": "" }),
      ),
    ).toThrow(/missing_commission:row_1/);
  });

  it("refuses a malformed percent cell — no floats, no three decimals", () => {
    expect(() =>
      STEAM.parse(
        withCells("gaming_steamworks.csv", { "Platform Commission %": "30.000" }),
      ),
    ).toThrow(/invalid_percent:Platform Commission %:30\.000:row_1/);
    expect(() =>
      STEAM.parse(
        withCells("gaming_steamworks.csv", { "Platform Commission %": "thirty" }),
      ),
    ).toThrow(/invalid_percent:Platform Commission %:thirty:row_1/);
  });

  it("refuses a malformed date — the annual bucket is never guessed", () => {
    expect(() =>
      STEAM.parse(withCells("gaming_steamworks.csv", { "Sale Date": "01/10/2026" })),
    ).toThrow(/invalid_date:01\/10\/2026:row_1/);
  });

  it("refuses a malformed catalog DOI", () => {
    expect(() =>
      STEAM.parse(withCells("gaming_steamworks.csv", { "Catalog DOI": "not-a-doi" })),
    ).toThrow(/invalid_doi:row_1/);
  });

  it("refuses a malformed gross — the strict money grammar", () => {
    expect(() =>
      STEAM.parse(withCells("gaming_steamworks.csv", { Gross: "59.999.5" })),
    ).toThrow(/invalid_amount:Gross:row_1/);
  });
});
