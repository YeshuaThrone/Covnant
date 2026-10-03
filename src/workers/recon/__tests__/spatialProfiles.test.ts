/**
 * The spatial lane's strict-profile tests (PR 36, the founder spatial
 * directive) — the five senders' dispatch opinions, the parsed-line
 * contracts (the spatial detail riding as the lane discriminator, the
 * NIL precedent), and the whole-file rejection posture: a wrong header,
 * a missing cell, a negative leg, an off-vocabulary cell — each rejects,
 * never guesses.
 */
import { describe, expect, it } from "vitest";
import { dispatchStatementProfile } from "../profiles";
import { isSpatialProfileKind } from "../spatialProfiles";
import type { ParsedStatementLine, StatementProfile } from "../records";
import { loadFixture } from "./fixtures";

/** The house dispatch-and-parse idiom (profiles.test.ts's helper): the
 * pinned registry must match, THEN the profile parses — a fixture that
 * stops matching is a broken profile, not a silent skip. */
function dispatchParse(
  content: string,
): { profile: StatementProfile; lines: readonly ParsedStatementLine[] } {
  const profile = dispatchStatementProfile(content);
  if (profile === null) throw new Error("content matched no profile");
  return { profile, lines: profile.parse(content) };
}

describe("the spatial lane's dispatch", () => {
  it("dispatches each of the five senders' fixtures to its profile", () => {
    expect(
      dispatchParse(loadFixture("spatial_turnstile_settlements.csv")).profile.kind,
    ).toBe("spatial_turnstile_ticket_scans_csv");
    expect(
      dispatchParse(loadFixture("spatial_attraction_pass_sales.csv")).profile.kind,
    ).toBe("spatial_attraction_pass_sales_csv");
    expect(dispatchParse(loadFixture("spatial_fnb_registers.csv")).profile.kind).toBe(
      "spatial_fnb_register_csv",
    );
    expect(dispatchParse(loadFixture("spatial_retail_pos.csv")).profile.kind).toBe(
      "spatial_retail_pos_csv",
    );
    expect(dispatchParse(loadFixture("spatial_rfid_telemetry.csv")).profile.kind).toBe(
      "spatial_rfid_wristband_telemetry_csv",
    );
  });

  it("labels every dispatched spatial kind as the lane's", () => {
    expect(isSpatialProfileKind("spatial_turnstile_ticket_scans_csv")).toBe(true);
    expect(isSpatialProfileKind("spatial_attraction_pass_sales_csv")).toBe(true);
    expect(isSpatialProfileKind("spatial_fnb_register_csv")).toBe(true);
    expect(isSpatialProfileKind("spatial_retail_pos_csv")).toBe(true);
    expect(isSpatialProfileKind("spatial_rfid_wristband_telemetry_csv")).toBe(true);
    expect(isSpatialProfileKind("nil_brand_endorsement_csv")).toBe(false);
    expect(isSpatialProfileKind("distrokid_csv")).toBe(false);
  });
});

describe("the turnstile settlement profile", () => {
  it("parses the calculator's legs, the approval gate, and the entries", () => {
    const { lines } = dispatchParse(loadFixture("spatial_turnstile_settlements.csv"));
    expect(lines).toHaveLength(2);

    const first = lines[0]!;
    expect(first.rightsType).toBe("unknown");
    expect(first.statementSourceType).toBeNull();
    expect(first.platform).toBe("turnstile");
    expect(first.period).toBe("2026-03");
    expect(first.currency).toBe("USD");
    // The row's money basis: ticket + merch revenue = $1,500,000.00 =
    // 150,000,000 cents in the house 1e-8-micros discipline (records.ts).
    expect(first.grossMicros).toBe(150_000_000_000_000n);
    expect(first.spatialDetail).toMatchObject({
      sender: "turnstile",
      senderRowId: "TS-2026-0001",
      venueId: "venue-orbit-zone",
      zoneCode: "ORBIT",
      spatialFootprintSqft: 120_000,
      ticketRevenueCents: 100_000_000,
      merchRevenueCents: 50_000_000,
      occupancyTaxCents: 6_000_000,
      infrastructureCogsCents: 9_000_000,
      groupTourDiscountCents: 2_000_000,
      tourDiscountApproved: true,
      turnstileEntries: 400_000,
    });
    expect(first.usageNote).toContain("TS-2026-0001");
    expect(first.usageNote).toContain("venue-orbit-zone");
    expect(first.usageNote).toContain("ORBIT");

    // Row 2: the approved discount rides on the sheet at parse — the
    // deduction happens at walk time (the pending gate is the pass
    // profile's AP-1 row).
    expect(lines[1]?.spatialDetail).toMatchObject({
      senderRowId: "TS-2026-0002",
      tourDiscountApproved: true,
      groupTourDiscountCents: 1_200_000,
    });
  });
});

describe("the attraction pass sales profile", () => {
  it("parses pass revenue as the ticket leg — no turnstile entries on a pass sale", () => {
    const { lines } = dispatchParse(loadFixture("spatial_attraction_pass_sales.csv"));
    expect(lines).toHaveLength(2);
    expect(lines[0]?.spatialDetail).toMatchObject({
      sender: "pass",
      senderRowId: "AP-2026-0101",
      passType: "day_pass",
      passRevenueCents: 25_000_000,
      tourDiscountApproved: false,
    });
    expect(lines[1]?.spatialDetail).toMatchObject({
      sender: "pass",
      passType: "season_pass",
      tourDiscountApproved: true,
      groupTourDiscountCents: 0,
    });
  });
});

describe("the zone-sale profiles (F&B registers and retail POS logs)", () => {
  it("parses the register feed as the fnb row class with no beacon", () => {
    const { lines } = dispatchParse(loadFixture("spatial_fnb_registers.csv"));
    expect(lines).toHaveLength(1);
    expect(lines[0]?.spatialDetail).toMatchObject({
      sender: "fnb",
      rowClass: "fnb",
      senderRowId: "FB-2026-0201",
      grossCents: 8_000_000,
      beaconId: null,
    });
  });

  it("parses the POS log as the retail row class citing the beacon of record", () => {
    const { lines } = dispatchParse(loadFixture("spatial_retail_pos.csv"));
    expect(lines).toHaveLength(1);
    expect(lines[0]?.spatialDetail).toMatchObject({
      sender: "retail",
      rowClass: "retail",
      senderRowId: "RT-2026-0301",
      grossCents: 4_500_000,
      beaconId: "BEACON-7",
    });
  });
});

describe("the RFID wristband telemetry profile", () => {
  it("parses the dwell minutes and ride sessions the micro-royalty prices", () => {
    const { lines } = dispatchParse(loadFixture("spatial_rfid_telemetry.csv"));
    expect(lines).toHaveLength(1);
    expect(lines[0]?.spatialDetail).toMatchObject({
      sender: "rfid",
      senderRowId: "WB-2026-0401",
      wristbandId: "wb-7f3a2c",
      sensorId: "sensor-gate-12",
      dwellMinutes: 45,
      rideSessions: 2,
    });
    // A telemetry row prices no money itself — the walk prices it.
    expect(lines[0]?.grossMicros).toBe(0n);
  });

  it("rejects a telemetry row that registers neither a dwell nor a session — nothing to price", () => {
    const content = [
      "Telemetry ID,Venue ID,Zone Code,Wristband ID,Sensor ID,Scan Time,Dwell Minutes,Ride Sessions,Currency,Reporting Period",
      "WB-X,venue-orbit-zone,ORBIT,wb-x,sensor-1,2026-05-03T14:22:05Z,0,0,USD,2026-05",
    ].join("\n");
    expect(() => dispatchParse(content)).toThrow(/telemetry_row_prices_nothing/);
  });
});

describe("the whole-file rejection posture", () => {
  it("rejects a wrong header layout", () => {
    const content = [
      "Settlement ID,Venue ID,Zone Code,Ticket Revenue,Merch Revenue,Currency,Reporting Period",
      "TS-1,venue,ORBIT,1.00,2.00,USD,2026-03",
    ].join("\n");
    expect(dispatchStatementProfile(content)).toBeNull();
  });

  it("rejects a missing cell — every cell is required, no null guesses", () => {
    const content = [
      "Settlement ID,Venue ID,Zone Code,Spatial Footprint Sqft,Settlement Date,Ticket Revenue,Merch Revenue,Occupancy Tax,Infrastructure COGS,Group Tour Discount,Tour Discount Approved,Turnstile Entries,Currency,Reporting Period",
      "TS-1,venue,ORBIT,120000,2026-03-31,1.00,2.00,0.00,0.00,0.00,approved,,USD,2026-03",
    ].join("\n");
    expect(() => dispatchParse(content)).toThrow();
  });

  it("rejects a negative money leg — a refund has no vocabulary here", () => {
    const content = [
      "Register ID,Venue ID,Zone Code,Register Date,Sales Gross,Currency,Reporting Period",
      "FB-1,venue,ORBIT,2026-05-01,-1.00,USD,2026-05",
    ].join("\n");
    expect(() => dispatchParse(content)).toThrow(/negative_money/);
  });

  it("rejects an off-vocabulary pass type", () => {
    const content = [
      "Pass ID,Venue ID,Zone Code,Spatial Footprint Sqft,Sale Date,Pass Type,Pass Revenue,Occupancy Tax,Infrastructure COGS,Group Tour Discount,Tour Discount Approved,Currency,Reporting Period",
      "AP-1,venue,ORBIT,120000,2026-04-02,ultra_pass,1.00,0.00,0.00,0.00,approved,USD,2026-04",
    ].join("\n");
    expect(() => dispatchParse(content)).toThrow(/invalid_pass_type/);
  });

  it("rejects an off-vocabulary tour-discount approval", () => {
    const content = [
      "Pass ID,Venue ID,Zone Code,Spatial Footprint Sqft,Sale Date,Pass Type,Pass Revenue,Occupancy Tax,Infrastructure COGS,Group Tour Discount,Tour Discount Approved,Currency,Reporting Period",
      "AP-1,venue,ORBIT,120000,2026-04-02,day_pass,1.00,0.00,0.00,0.00,maybe,USD,2026-04",
    ].join("\n");
    expect(() => dispatchParse(content)).toThrow(/invalid_discount_approval/);
  });

  it("rejects a malformed reporting period", () => {
    const content = [
      "Register ID,Venue ID,Zone Code,Register Date,Sales Gross,Currency,Reporting Period",
      "FB-1,venue,ORBIT,2026-05-01,1.00,USD,May 2026",
    ].join("\n");
    expect(() => dispatchParse(content)).toThrow(/invalid_period/);
  });

  it("rejects a malformed currency", () => {
    const content = [
      "Register ID,Venue ID,Zone Code,Register Date,Sales Gross,Currency,Reporting Period",
      "FB-1,venue,ORBIT,2026-05-01,1.00,DOLLARS,2026-05",
    ].join("\n");
    expect(() => dispatchParse(content)).toThrow(/currency/);
  });
});
