/**
 * The spatial lane's worker-path test (PR 36, the founder spatial
 * directive) — the full pass over the five senders' sheets through the
 * real dispatch (profiles) and the real store walk (spatialQueue) on the
 * in-memory backend: the committed math, the throughput tracker's
 * advancement, the replay no-ops, the fail-closed skips, and the
 * negative-net hold.
 */
import { describe, expect, it } from "vitest";
import { InMemoryStore } from "@/lib/server/inMemoryStore";
import { dispatchStatementProfile } from "../profiles";
import { spatialRowEventId } from "../spatial";
import { writeSpatialRowsToStore } from "../spatialQueue";
import type { ParsedStatementLine } from "../records";
import { loadFixture } from "./fixtures";

const FOUNDER_BANDS = [
  { up_to: 500_000, royalty_bps: 500 },
  { up_to: 1_000_000, royalty_bps: 650 },
  { up_to: null, royalty_bps: 800 },
] as const;

/** Dispatches and parses one raw CSV through the pinned registry (the
 * worker's own two-step). */
function parseCsv(content: string): readonly ParsedStatementLine[] {
  const profile = dispatchStatementProfile(content);
  if (profile === null) throw new Error("content matched no profile");
  return profile.parse(content);
}

const YEAR = "2026";
const VENUE = "venue-orbit-zone";
const ZONE = "ORBIT";
const OWNER = "ip-owner-orbit";

/** Registers the policies of record the lane's walks read. */
function registerPolicies(store: InMemoryStore, venueId = VENUE): void {
  for (const venue of [venueId, "venue-nova-lab"]) {
    store.upsertSpatialOccupancyTierSchedule({
      venue_id: venue,
      year: YEAR,
      basis: "annual_throughput",
      bands: JSON.stringify(FOUNDER_BANDS),
    });
    store.upsertSpatialOverheadPolicy({
      venue_id: venue,
      year: YEAR,
      security_bps: 125,
      wristband_maintenance_bps: 75,
      ticketing_platform_bps: 50,
    });
  }
  store.upsertSpatialZoneAssignment({
    venue_id: venueId,
    zone_code: ZONE,
    assigned_ip_owner_id: OWNER,
    royalty_bps: 300,
  });
  store.upsertSpatialMicroPolicy({
    venue_id: venueId,
    zone_code: ZONE,
    micros_per_dwell_minute: 1_400_000,
    micros_per_ride_session: 2_500_000,
  });
}

const TURNSTILE_HEADER =
  "Settlement ID,Venue ID,Zone Code,Spatial Footprint Sqft,Settlement Date,Ticket Revenue,Merch Revenue,Occupancy Tax,Infrastructure COGS,Group Tour Discount,Tour Discount Approved,Turnstile Entries,Currency,Reporting Period";
const PASS_HEADER =
  "Pass ID,Venue ID,Zone Code,Spatial Footprint Sqft,Sale Date,Pass Type,Pass Revenue,Occupancy Tax,Infrastructure COGS,Group Tour Discount,Tour Discount Approved,Currency,Reporting Period";
const FNB_HEADER =
  "Register ID,Venue ID,Zone Code,Register Date,Sales Gross,Currency,Reporting Period";
const RFID_HEADER =
  "Telemetry ID,Venue ID,Zone Code,Wristband ID,Sensor ID,Scan Time,Dwell Minutes,Ride Sessions,Currency,Reporting Period";

/** Parses fixture sheets through the real dispatch and walks the lane. */
async function walkFixtures(store: InMemoryStore, ...names: string[]) {
  const lines = names.flatMap((name) => parseCsv(loadFixture(name)));
  return writeSpatialRowsToStore(store, lines);
}

describe("the spatial lane's full pass over the five senders", () => {
  it("commits every ledger with the exact founder math and advances the throughput tracker", async () => {
    const store = new InMemoryStore();
    registerPolicies(store);

    const counts = await walkFixtures(
      store,
      "spatial_turnstile_settlements.csv",
      "spatial_attraction_pass_sales.csv",
      "spatial_fnb_registers.csv",
      "spatial_retail_pos.csv",
      "spatial_rfid_telemetry.csv",
    );

    // The five senders' rows: 2 turnstile + 2 pass + 1 fnb + 1 retail +
    // 1 telemetry = 4 occupancy applications, 2 zone allocations, 1
    // micro-royalty. Nothing skipped, nothing held, nothing replayed.
    expect(counts.occupancyApplicationsWritten).toBe(4);
    expect(counts.zoneAllocationsWritten).toBe(2);
    expect(counts.microRoyaltiesWritten).toBe(1);
    expect(counts.occupancyApplicationsReplayed).toBe(0);
    expect(counts.zoneAllocationsReplayed).toBe(0);
    expect(counts.microRoyaltiesReplayed).toBe(0);
    expect(counts.occupancySkippedNoSchedule).toBe(0);
    expect(counts.occupancySkippedNoOverhead).toBe(0);
    expect(counts.occupancySkippedUnverifiedSchedule).toBe(0);
    expect(counts.occupancyHeldNegativeNet).toBe(0);
    expect(counts.zoneSkippedNoAssignment).toBe(0);
    expect(counts.zoneSkippedNoOverhead).toBe(0);
    expect(counts.microSkippedNoPolicy).toBe(0);

    // THE MONEY — exact to the cent:
    //   TS-1: gross 150,000,000 − tax 6,000,000 − cogs 9,000,000 −
    //         approved discount 2,000,000 = net 133,000,000;
    //         overhead 1,662,500 + 997,500 + 665,000 = 3,325,000;
    //         basis 129,675,000 all in band 1 → royalty 6,483,750.
    //   TS-2: net 79,800,000; overhead 1,995,000; basis 77,805,000
    //         split 100,000/300,000 entries → 972,562 + 3,792,993.
    //   AP-1: net 21,500,000 (pending discount NEVER deducts); overhead
    //         537,500; basis 20,962,500 at position 800,000 (band 2)
    //         → floor(×650/10000) = 1,362,562.
    //   AP-2: net 7,740,000; overhead 193,500; basis 7,546,500 at NOVA-LAB's
    //         OWN position 0 (per-venue trackers — orbit's 800,000 entries
    //         never leak across venues) → band 1 → floor(×500/10000) =
    //         377,325.
    expect(counts.netSpatialLicensedRevenueCents).toBe(242_040_000);
    expect(counts.overheadTotalCents).toBe(6_051_000 + 312_500); // + zone legs
    expect(counts.occupancyRoyaltyCents).toBe(12_989_192);
    //   fnb: overhead 200,000 → allocated 7,800,000 → 3% = 234,000.
    //   retail: overhead 112,500 → allocated 4,387,500 → 3% = 131,625.
    expect(counts.zoneRoyaltyCents).toBe(365_625);
    //   telemetry: 45 min × 1,400,000 + 2 sessions × 2,500,000
    //            = 68,000,000 micros = 68 cents.
    expect(counts.microRoyaltyCents).toBe(68);

    // The throughput tracker: 400,000 + 400,000 turnstile entries —
    // pass rows advanced nothing.
    const tracker = await store.getSpatialThroughputYear(VENUE, YEAR);
    expect(tracker?.cumulative_entries).toBe(800_000);

    // The second turnstile row's application pins the boundary walk's
    // committed bands — the 500,000 boundary crossed mid-row.
    const tsTwo = await store.getSpatialRoyaltyApplication(
      spatialRowEventId({
        sender: "turnstile",
        venueId: VENUE,
        zoneCode: ZONE,
        period: "2026-06",
        senderRowId: "TS-2026-0002",
      }),
    );
    expect(tsTwo).toBeDefined();
    expect(tsTwo?.verdict).toBe("paid");
    expect(tsTwo?.net_spatial_licensed_revenue_cents).toBe(79_800_000);
    expect(tsTwo?.overhead_total_cents).toBe(1_995_000);
    expect(tsTwo?.royalty_basis_cents).toBe(77_805_000);
    expect(tsTwo?.entries_before).toBe(400_000);
    expect(tsTwo?.entries_after).toBe(800_000);
    expect(JSON.parse(tsTwo?.tier_legs ?? "[]")).toEqual([
      {
        band_from: 0,
        band_to: 500_000,
        band_rate_bps: 500,
        band_basis_cents: 19_451_250,
        band_entries: 100_000,
        band_royalty_cents: 972_562,
      },
      {
        band_from: 500_000,
        band_to: 1_000_000,
        band_rate_bps: 650,
        band_basis_cents: 58_353_750,
        band_entries: 300_000,
        band_royalty_cents: 3_792_993,
      },
    ]);

    // A pass row: the closing position prices it, entries stay null.
    const passOne = await store.getSpatialRoyaltyApplication(
      spatialRowEventId({
        sender: "pass",
        venueId: VENUE,
        zoneCode: ZONE,
        period: "2026-04",
        senderRowId: "AP-2026-0101",
      }),
    );
    expect(passOne?.entries_count).toBe(0);
    expect(passOne?.entries_before).toBeNull();
    expect(passOne?.entries_after).toBeNull();
    expect(passOne?.group_tour_discount_cents).toBe(0); // pending — never deducted
    expect(passOne?.occupancy_royalty_cents).toBe(1_362_562);

    // The zone allocation routes to the assigned IP owner of record.
    const fnb = await store.getSpatialZoneAllocation(
      spatialRowEventId({
        sender: "fnb",
        venueId: VENUE,
        zoneCode: ZONE,
        period: "2026-05",
        senderRowId: "FB-2026-0201",
      }),
    );
    expect(fnb?.assigned_ip_owner_id).toBe(OWNER);
    expect(fnb?.royalty_bps).toBe(300);
    expect(fnb?.allocated_basis_cents).toBe(7_800_000);
    expect(fnb?.royalty_cents).toBe(234_000);

    // The micro-royalty pins the rates of record beside the math.
    const micro = await store.getSpatialMicroRoyalty(
      spatialRowEventId({
        sender: "rfid",
        venueId: VENUE,
        zoneCode: ZONE,
        period: "2026-05",
        senderRowId: "WB-2026-0401",
      }),
    );
    expect(micro?.dwell_royalty_micros).toBe(63_000_000);
    expect(micro?.session_royalty_micros).toBe(5_000_000);
    expect(micro?.royalty_cents).toBe(68);
  });

  it("replays a re-shipped sheet as counted no-ops — no double money, no tracker drift", async () => {
    const store = new InMemoryStore();
    registerPolicies(store);
    const names = [
      "spatial_turnstile_settlements.csv",
      "spatial_attraction_pass_sales.csv",
      "spatial_fnb_registers.csv",
      "spatial_retail_pos.csv",
      "spatial_rfid_telemetry.csv",
    ];
    await walkFixtures(store, ...names);
    const replayCounts = await walkFixtures(store, ...names);

    expect(replayCounts.occupancyApplicationsWritten).toBe(0);
    expect(replayCounts.occupancyApplicationsReplayed).toBe(4);
    expect(replayCounts.zoneAllocationsWritten).toBe(0);
    expect(replayCounts.zoneAllocationsReplayed).toBe(2);
    expect(replayCounts.microRoyaltiesWritten).toBe(0);
    expect(replayCounts.microRoyaltiesReplayed).toBe(1);
    expect(replayCounts.occupancyRoyaltyCents).toBe(0);
    expect(replayCounts.zoneRoyaltyCents).toBe(0);
    expect(replayCounts.microRoyaltyCents).toBe(0);
    expect(replayCounts.netSpatialLicensedRevenueCents).toBe(0);
    expect(replayCounts.overheadTotalCents).toBe(0);

    // The tracker did not move on the replay.
    const tracker = await store.getSpatialThroughputYear(VENUE, YEAR);
    expect(tracker?.cumulative_entries).toBe(800_000);
  });
});

describe("the lane's fail-closed skips", () => {
  it("skips an occupancy row whose venue-year has no schedule of record", async () => {
    const store = new InMemoryStore();
    const counts = await writeSpatialRowsToStore(
      store,
      parseCsv(
        [
          TURNSTILE_HEADER,
          "TS-1,venue-unregistered,ORBIT,120000,2026-03-31,1000.00,500.00,60.00,90.00,20.00,approved,1000,USD,2026-03",
        ].join("\n"),
      ),
    );
    expect(counts.occupancySkippedNoSchedule).toBe(1);
    expect(counts.occupancyApplicationsWritten).toBe(0);
  });

  it("skips an occupancy row whose venue-year has no overhead policy of record", async () => {
    const store = new InMemoryStore();
    // The schedule exists; the overhead policy does not.
    store.upsertSpatialOccupancyTierSchedule({
      venue_id: VENUE,
      year: YEAR,
      basis: "annual_throughput",
      bands: JSON.stringify(FOUNDER_BANDS),
    });
    const counts = await writeSpatialRowsToStore(
      store,
      parseCsv(
        [
          TURNSTILE_HEADER,
          "TS-1,venue-orbit-zone,ORBIT,120000,2026-03-31,1000.00,500.00,60.00,90.00,20.00,approved,1000,USD,2026-03",
        ].join("\n"),
      ),
    );
    expect(counts.occupancySkippedNoOverhead).toBe(1);
    expect(counts.occupancyApplicationsWritten).toBe(0);
  });

  it("skips a zone sale whose venue-zone has no assignment of record", async () => {
    const store = new InMemoryStore();
    registerPolicies(store); // ORBIT assigned — route a NOVA sale
    const counts = await writeSpatialRowsToStore(
      store,
      parseCsv([FNB_HEADER, "FB-1,venue-orbit-zone,NOVA,2026-05-01,1000.00,USD,2026-05"].join("\n")),
    );
    expect(counts.zoneSkippedNoAssignment).toBe(1);
    expect(counts.zoneAllocationsWritten).toBe(0);
  });

  it("skips a zone sale whose venue-year has no overhead policy of record", async () => {
    const store = new InMemoryStore();
    store.upsertSpatialZoneAssignment({
      venue_id: VENUE,
      zone_code: ZONE,
      assigned_ip_owner_id: OWNER,
      royalty_bps: 300,
    });
    const counts = await writeSpatialRowsToStore(
      store,
      parseCsv([FNB_HEADER, "FB-1,venue-orbit-zone,ORBIT,2026-05-01,1000.00,USD,2026-05"].join("\n")),
    );
    expect(counts.zoneSkippedNoOverhead).toBe(1);
    expect(counts.zoneAllocationsWritten).toBe(0);
  });

  it("skips a telemetry row whose venue-zone has no micro rates of record", async () => {
    const store = new InMemoryStore();
    registerPolicies(store); // ORBIT priced — route a NOVA scan
    const counts = await writeSpatialRowsToStore(
      store,
      parseCsv(
        [
          RFID_HEADER,
          "WB-1,venue-orbit-zone,NOVA,wb-1,sensor-1,2026-05-03T14:22:05Z,30,1,USD,2026-05",
        ].join("\n"),
      ),
    );
    expect(counts.microSkippedNoPolicy).toBe(1);
    expect(counts.microRoyaltiesWritten).toBe(0);
  });
});

describe("the lane's negative-net hold", () => {
  it("records the held verdict with zeroed overhead and royalty legs, counts the negative net, and advances nothing", async () => {
    const store = new InMemoryStore();
    registerPolicies(store);
    // Deductions (60 + 90 + 20 = 170 dollars) exceed the gross (150) —
    // the net is −$20.00 = −2,000 cents: the hold IS the record.
    const counts = await writeSpatialRowsToStore(
      store,
      parseCsv(
        [
          TURNSTILE_HEADER,
          "TS-HOLD,venue-orbit-zone,ORBIT,120000,2026-07-31,100.00,50.00,60.00,90.00,20.00,approved,5000,USD,2026-07",
        ].join("\n"),
      ),
    );
    expect(counts.occupancyHeldNegativeNet).toBe(1);
    expect(counts.occupancyApplicationsWritten).toBe(1);
    expect(counts.occupancyRoyaltyCents).toBe(0);
    expect(counts.overheadTotalCents).toBe(0);
    expect(counts.netSpatialLicensedRevenueCents).toBe(-2_000);

    const held = await store.getSpatialRoyaltyApplication(
      spatialRowEventId({
        sender: "turnstile",
        venueId: VENUE,
        zoneCode: ZONE,
        period: "2026-07",
        senderRowId: "TS-HOLD",
      }),
    );
    expect(held?.verdict).toBe("held_negative_net");
    expect(held?.net_spatial_licensed_revenue_cents).toBe(-2_000);
    expect(held?.overhead_total_cents).toBe(0);
    expect(held?.royalty_basis_cents).toBe(0);
    expect(held?.tier_schedule_ref).toBeNull();
    expect(held?.entries_before).toBeNull();
    expect(held?.entries_after).toBeNull();

    // The hold advanced no position — the next walk re-prices after the
    // operator heals the sheet.
    const tracker = await store.getSpatialThroughputYear(VENUE, YEAR);
    expect(tracker).toBeUndefined();
  });
});
