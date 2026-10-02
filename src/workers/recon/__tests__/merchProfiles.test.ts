/**
 * Merch ingestion profiles (PR 22, founder merchandise directive) —
 * dispatch, strict parsing, and the fail-closed refusal grammar, pinned to
 * the checked-in fixture dumps.
 *
 * The fixtures are the standing spec: the DTC dump's net-realized-profit
 * equation rows (including the sub-cent and negative-net rows the lane
 * quarantines), the POD printing-before-split rows, the self-reconciling
 * consignment payout report, and the Square POS sales. Hostile rows are
 * synthesized inline; each asserts the exact StatementParseError token the
 * profile must refuse with.
 */
import { describe, expect, it } from "vitest";

import { dispatchStatementProfile } from "../profiles";
import { MERCH_PROFILES, isMerchProfileKind } from "../merchProfiles";
import { loadFixture } from "./fixtures";

const DTC_PROFILE = MERCH_PROFILES.find((p) => p.kind === "shopify_dtc_dump_csv");
const POD_PROFILE = MERCH_PROFILES.find((p) => p.kind === "pod_fulfillment_dump_csv");
const CONSIGNMENT_PROFILE = MERCH_PROFILES.find(
  (p) => p.kind === "wholesale_consignment_payout_csv",
);
const POS_PROFILE = MERCH_PROFILES.find((p) => p.kind === "square_pos_dump_csv");

function requireProfile(
  profile: (typeof MERCH_PROFILES)[number] | undefined,
): (typeof MERCH_PROFILES)[number] {
  if (profile === undefined) throw new Error("merch profile missing from registry");
  return profile;
}

const dtcProfile = requireProfile(DTC_PROFILE);
const podProfile = requireProfile(POD_PROFILE);
const consignmentProfile = requireProfile(CONSIGNMENT_PROFILE);
const posProfile = requireProfile(POS_PROFILE);

/** The checked-in fixture's exact header — hostile rows build on it. */
const DTC_HEADER =
  "Order Date,Order ID,UPC,SKU,Units,Gross Customer Price,Unit Production COGS,Shipping Fee,Fulfillment Fee,Gateway Fee,Designer Royalty,Currency";

/** One hostile DTC row — the real header plus one data line. */
function dtcLog(dataRow: string): string {
  return `${DTC_HEADER}\n${dataRow}\n`;
}

describe("profile dispatch", () => {
  it("dispatches all four merch dumps through the shared dispatcher", () => {
    expect(dtcProfile.matches(loadFixture("merch_shopify_dtc.csv"))).toBe(true);
    expect(podProfile.matches(loadFixture("merch_pod_fulfillment.csv"))).toBe(true);
    expect(consignmentProfile.matches(loadFixture("merch_wholesale_consignment.csv"))).toBe(
      true,
    );
    expect(posProfile.matches(loadFixture("merch_square_pos.csv"))).toBe(true);
    expect(dispatchStatementProfile(loadFixture("merch_shopify_dtc.csv"))?.kind).toBe(
      "shopify_dtc_dump_csv",
    );
    expect(dispatchStatementProfile(loadFixture("merch_pod_fulfillment.csv"))?.kind).toBe(
      "pod_fulfillment_dump_csv",
    );
    expect(
      dispatchStatementProfile(loadFixture("merch_wholesale_consignment.csv"))?.kind,
    ).toBe("wholesale_consignment_payout_csv");
    expect(dispatchStatementProfile(loadFixture("merch_square_pos.csv"))?.kind).toBe(
      "square_pos_dump_csv",
    );
  });

  it("is the merch lane by kind", () => {
    for (const profile of MERCH_PROFILES) {
      expect(isMerchProfileKind(profile.kind)).toBe(true);
    }
  });
});

describe("the Shopify DTC dump parser", () => {
  it("parses the fixture's rows with the equation legs intact", () => {
    const lines = dtcProfile.parse(loadFixture("merch_shopify_dtc.csv"));
    expect(lines).toHaveLength(4);
    const first = lines[0];
    expect(first.identifiers.UPC).toBe("012345678901");
    expect(first.rightsType).toBe("unknown");
    expect(first.grossMicros).toBe(5_600_000_000n);
    expect(first.merchDetail?.kind).toBe("dtc_order");
    if (first.merchDetail?.kind !== "dtc_order") throw new Error("unreachable");
    expect(first.merchDetail.units).toBe(2);
    expect(first.merchDetail.unitProductionCogsMicros).toBe("650000000");
    expect(first.merchDetail.shippingFeeMicros).toBe("499000000");
    expect(first.merchDetail.fulfillmentFeeMicros).toBe("120000000");
    expect(first.merchDetail.gatewayFeeMicros).toBe("168000000");
    // The profile records the PER-UNIT royalty cell (3.50); the queue's net
    // math multiplies it by the row's units at posting time.
    expect(first.merchDetail.designerRoyaltyMicros).toBe("350000000");
    expect(first.merchDetail.period).toBe("2026-08");
  });

  it("keeps the sub-cent and negative-net rows for the queue's dispositions", () => {
    const lines = dtcProfile.parse(loadFixture("merch_shopify_dtc.csv"));
    // Row 2 nets to $0.004 — parseable; the QUEUE disposes it as zero_net.
    // Row 3 nets to −$15.00 — parseable; the QUEUE disposes it as
    // held_negative_net. The profile refuses nothing it can read.
    expect(lines[1].grossMicros).toBe(100_000_000n);
    expect(lines[2].merchDetail?.kind).toBe("dtc_order");
  });

  it("refuses a missing UPC — unattributable money never quarantines silently", () => {
    expect(() =>
      dtcProfile.parse(
        dtcLog("2026-08-04,SH-9,SKU-X,SKU-TSHIRT-CREST,1,10.00,1.00,0.00,0.00,0.00,0.00,USD"),
      ),
    ).toThrow(/invalid_upc:SKU-X/);
  });

  it("refuses zero and negative grosses", () => {
    expect(() =>
      dtcProfile.parse(
        dtcLog(
          "2026-08-04,SH-9,012345678901,SKU-TSHIRT-CREST,1,0.00,1.00,0.00,0.00,0.00,0.00,USD",
        ),
      ),
    ).toThrow(/invalid_money:Gross Customer Price/);
    expect(() =>
      dtcProfile.parse(
        dtcLog(
          "2026-08-04,SH-9,012345678901,SKU-TSHIRT-CREST,1,-10.00,1.00,0.00,0.00,0.00,0.00,USD",
        ),
      ),
    ).toThrow(/negative_money:Gross Customer Price/);
  });

  it("refuses zero and fractional units", () => {
    expect(() =>
      dtcProfile.parse(
        dtcLog(
          "2026-08-04,SH-9,012345678901,SKU-TSHIRT-CREST,0,10.00,1.00,0.00,0.00,0.00,0.00,USD",
        ),
      ),
    ).toThrow(/invalid_merch_units|invalid_units/);
    expect(() =>
      dtcProfile.parse(
        dtcLog(
          "2026-08-04,SH-9,012345678901,SKU-TSHIRT-CREST,1.5,10.00,1.00,0.00,0.00,0.00,0.00,USD",
        ),
      ),
    ).toThrow(/invalid_units:Units:1.5/);
  });

  it("refuses malformed dates and short UPCs", () => {
    expect(() =>
      dtcProfile.parse(
        dtcLog(
          "08/04/2026,SH-9,012345678901,SKU-TSHIRT-CREST,1,10.00,1.00,0.00,0.00,0.00,0.00,USD",
        ),
      ),
    ).toThrow(/invalid_date:08\/04\/2026/);
    expect(() =>
      dtcProfile.parse(
        dtcLog("2026-08-04,SH-9,12345,SKU-TSHIRT-CREST,1,10.00,1.00,0.00,0.00,0.00,0.00,USD"),
      ),
    ).toThrow(/invalid_upc:12345/);
  });
});

describe("the POD fulfillment parser", () => {
  it("parses the fixture's rows with the printing and split cells intact", () => {
    const lines = podProfile.parse(loadFixture("merch_pod_fulfillment.csv"));
    expect(lines).toHaveLength(3);
    expect(lines[0].grossMicros).toBe(3_000_000_000n);
    expect(lines[0].merchDetail?.kind).toBe("pod_fulfillment");
    if (lines[0].merchDetail?.kind !== "pod_fulfillment") throw new Error("unreachable");
    expect(lines[0].merchDetail.platform).toBe("printful");
    expect(lines[0].merchDetail.printingCostPerUnitMicros).toBe("950000000");
    expect(lines[0].merchDetail.splitShareBps).toBe(5_000);
    expect(lines[1].merchDetail?.kind).toBe("pod_fulfillment");
    if (lines[1].merchDetail?.kind !== "pod_fulfillment") throw new Error("unreachable");
    expect(lines[1].merchDetail.platform).toBe("gelato");
    expect(lines[1].merchDetail.splitShareBps).toBe(3_333);
  });

  it("refuses a platform outside the bounded vocabulary", () => {
    expect(() =>
      podProfile.parse(
        "Fulfillment Date,Order ID,Platform,UPC,SKU,Units,Gross Customer Price,Printing Cost Per Unit,Split Share %,Currency\n2026-08-06,POD-9,amazon_merch,023456789012,SKU-X,1,10.00,1.00,50,USD\n",
      ),
    ).toThrow(/invalid_pod_platform:amazon_merch/);
  });

  it("refuses split shares outside the percent grammar's two-digit range", () => {
    // "150" fails the livestream-inherited percent grammar (at most two
    // whole digits) — the engine-level 0–10000 bps bounds check is pinned
    // in merch.test.ts.
    expect(() =>
      podProfile.parse(
        "Fulfillment Date,Order ID,Platform,UPC,SKU,Units,Gross Customer Price,Printing Cost Per Unit,Split Share %,Currency\n2026-08-06,POD-9,printful,023456789012,SKU-X,1,10.00,1.00,150,USD\n",
      ),
    ).toThrow(/invalid_percent:Split Share %:150/);
  });
});

describe("the wholesale consignment payout parser", () => {
  const CONSIGNMENT_HEADER =
    "Payout Period,Location,Payout ID,UPC,SKU,Units Sold,Gross Sales,Commission,Shrinkage Allowance,Reported Net Payout,Currency";

  it("parses the fixture's self-reconciling rows", () => {
    const lines = consignmentProfile.parse(loadFixture("merch_wholesale_consignment.csv"));
    expect(lines).toHaveLength(2);
    expect(lines[0].grossMicros).toBe(9_000_000_000n);
    expect(lines[0].merchDetail?.kind).toBe("consignment_payout");
    if (lines[0].merchDetail?.kind !== "consignment_payout") throw new Error("unreachable");
    expect(lines[0].merchDetail.commissionMicros).toBe("1350000000");
    expect(lines[0].merchDetail.shrinkageAllowanceMicros).toBe("225000000");
    expect(lines[0].merchDetail.reportedNetPayoutMicros).toBe("7425000000");
    expect(lines[0].merchDetail.location).toBe("Novel Gate Crossing");
    expect(lines[0].merchDetail.period).toBe("2026-08");
    if (lines[1].merchDetail?.kind !== "consignment_payout") throw new Error("unreachable");
    expect(lines[1].merchDetail.location).toBe("Downtown Records");
  });

  it("refuses a report that disagrees with its own arithmetic", () => {
    // 90 − 13.50 − 2.25 = 74.25; the row reports 70.00 — mismatch.
    expect(() =>
      consignmentProfile.parse(
        `${CONSIGNMENT_HEADER}\n2026-08,Novel Gate,CON-9,045678901234,SKU-TOTE-NAVY,3,90.00,13.50,2.25,70.00,USD\n`,
      ),
    ).toThrow(/payout_reconciliation_mismatch:CON-9/);
  });

  it("refuses a clawback-shaped row whose net is negative", () => {
    // Commission + shrinkage (13.00) exceed the gross (10.00) — the row's
    // own arithmetic is negative before the reported net is even compared.
    expect(() =>
      consignmentProfile.parse(
        `${CONSIGNMENT_HEADER}\n2026-08,Novel Gate,CON-10,045678901234,SKU-TOTE-NAVY,1,10.00,8.00,5.00,0.00,USD\n`,
      ),
    ).toThrow(/payout_reconciliation_negative:CON-10/);
  });

  it("refuses a payout period with a stray day", () => {
    expect(() =>
      consignmentProfile.parse(
        `${CONSIGNMENT_HEADER}\n2026-08-15,Novel Gate,CON-11,045678901234,SKU-TOTE-NAVY,1,10.00,1.00,0.00,9.00,USD\n`,
      ),
    ).toThrow(/invalid_period:2026-08-15/);
  });
});

describe("the Square POS parser", () => {
  it("parses the fixture's sales", () => {
    const lines = posProfile.parse(loadFixture("merch_square_pos.csv"));
    expect(lines).toHaveLength(2);
    expect(lines[0].grossMicros).toBe(800_000_000n);
    expect(lines[0].merchDetail?.kind).toBe("pos_sale");
    if (lines[0].merchDetail?.kind !== "pos_sale") throw new Error("unreachable");
    expect(lines[0].merchDetail.processingFeeMicros).toBe("46000000");
    expect(lines[0].merchDetail.units).toBe(4);
    expect(lines[1].merchDetail?.kind).toBe("pos_sale");
  });

  it("refuses a missing processing fee", () => {
    expect(() =>
      posProfile.parse(
        "Sale Date,Sale ID,UPC,SKU,Units,Gross Sales,Processing Fee,Currency\n2026-08-09,SQ-9,067890123456,SKU-STICKER-PCK,1,8.00,,USD\n",
      ),
    ).toThrow(/required_cell|missing/);
  });
});
