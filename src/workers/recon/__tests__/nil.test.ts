// Focused tests for the NIL compliance parser + roster waterfall lane (PR
// 34, the founder directive): the adjusted calculator's pool math exact to
// the cent (Title IX reserve + admin fee priced off the GROSS), the
// tiered roster waterfall's share and stipend tiers with the dust sweep,
// the $600 valid business purpose flag boundary and the nil_cleared heal,
// the associated-entity holdback against the $20.5M institutional cap,
// the agency commission bands deducted at payout, the group NIL equal
// split's odd-cent dust, the high school state compliance matrix's
// fail-closed verdicts, and the replay guards — on the strict profiles'
// checked-in fixtures over the real store backends.

import { describe, expect, it } from "vitest";

import { InMemoryStore } from "@/lib/server/inMemoryStore";
import { SqliteStore } from "@/lib/server/sqliteStore";
import type { Store } from "@/lib/server/store";
import type { NilRosterTierSpec } from "@/modules/nil/records";

import { loadFixture } from "./fixtures";
import {
  equalGroupSplitCents,
  netAthleteSharePoolCents,
  nilRowEventId,
  rosterWalkCents,
} from "../nil";
import { isNilProfileKind } from "../nilProfiles";
import { writeNilRowsToStore, type NilWriteCounts } from "../nilQueue";
import { RECON_WORKER_ENGINE, runOnce } from "../worker";
import { dispatchStatementProfile } from "../profiles";
import { StatementParseError } from "../records";

/** The directive's example schedule: starting QB 15%, O-line pool 25%,
 * the walk-on base stipend tier. */
const DIRECTIVE_TIERS: readonly NilRosterTierSpec[] = [
  { tier_key: "qb_starting", share_bps: 1500, base_stipend_cents: null, member_ids: ["ATH-QB-1"] },
  {
    tier_key: "oline_pool",
    share_bps: 2500,
    base_stipend_cents: null,
    member_ids: ["ATH-OL-1", "ATH-OL-2", "ATH-OL-3", "ATH-OL-4", "ATH-OL-5"],
  },
  {
    tier_key: "walkon_base",
    share_bps: null,
    base_stipend_cents: 1_000_000,
    member_ids: ["ATH-WO-1", "ATH-WO-2", "ATH-WO-3", "ATH-WO-4", "ATH-WO-5"],
  },
];

/** Registers the programs of record the fixtures' walks read. */
async function registerPrograms(store: Store): Promise<void> {
  for (const schoolId of ["SCH-1", "SCH-2"]) {
    await store.upsertNilRevenueShareProgram({
      scope_key: `school:${schoolId}`,
      scope: "school",
      school_id: schoolId,
      collective_id: null,
      title_ix_reserve_bps: 500,
      admin_fee_bps: 250,
    });
  }
}

/** Registers the (scope, pool type) waterfall of record — SCH-1 only. */
async function registerWaterfall(store: Store): Promise<void> {
  await store.upsertNilRosterWaterfall({
    scope_key: "school:SCH-1",
    waterfall_key: "media_rights",
    kind: "position",
    tiers: JSON.stringify(DIRECTIVE_TIERS),
  });
}

/** Registers the state matrix: CA permits the fixture's categories, TX
 * prohibits the jersey rule (and permits execution), NY has NO jersey
 * rule of record (the fail-closed absent-rule case). */
async function registerStateRules(store: Store): Promise<void> {
  const rules = [
    { state: "CA", code: "hs_jersey_private_endorsement", category: "private_brand" },
    { state: "CA", code: "hs_team_apparel_endorsement", category: "team_apparel" },
    { state: "CA", code: "nil_contract_execution", category: "collective" },
    { state: "TX", code: "hs_jersey_private_endorsement", category: "private_brand" },
    { state: "TX", code: "nil_contract_execution", category: "collective" },
    { state: "NY", code: "nil_contract_execution", category: "collective" },
  ] as const;
  for (const rule of rules) {
    await store.upsertNilStateRule({
      state_jurisdiction_code: rule.state,
      rule_code: rule.code,
      applies_to_category: rule.category,
      enforcement:
        rule.state === "TX" && rule.code === "hs_jersey_private_endorsement"
          ? "prohibited"
          : "permitted",
      rule_summary: `${rule.state} ${rule.code} of record`,
    });
  }
}

/** Registers the institutional cap allowances and verifications of record:
 * SCH-1 verified clean ($20.5M cap, nothing committed); SCH-2 verified at
 * $20.49M committed (the booster deal pushes over); SCH-3 has NO cap row
 * (the fail-closed no-cap case). */
async function registerCaps(store: Store): Promise<void> {
  await store.upsertNilSchoolCap({
    school_id: "SCH-1",
    cap_year: "2026",
    annual_cap_cents: 2_050_000_000,
  });
  await store.insertNilCapVerification({
    school_id: "SCH-1",
    cap_year: "2026",
    verified_committed_cents: 0,
    evidence_ref: "cap-verify-sch1",
    verified_by: "compliance",
  });
  await store.upsertNilSchoolCap({
    school_id: "SCH-2",
    cap_year: "2026",
    annual_cap_cents: 2_050_000_000,
  });
  await store.insertNilCapVerification({
    school_id: "SCH-2",
    cap_year: "2026",
    verified_committed_cents: 2_049_000_000,
    evidence_ref: "cap-verify-sch2",
    verified_by: "compliance",
  });
}

/** Pre-clears the contracts whose audits the fixtures' walks must pass —
 * the operator's metadata match landed before the walk. */
async function registerClearedAudits(store: Store, contractIds: readonly string[]): Promise<void> {
  for (const id of contractIds) {
    await store.upsertNilDealComplianceAudit({
      nil_contract_id: id,
      athlete_id: "ATH-PRE",
      school_id: "SCH-PRE",
      deal_value_cents: 1,
      business_purpose_state: "nil_cleared",
      purpose_description: "Promotional appearance — purpose of record",
      evidence_ref: `evidence-${id}`,
      cleared_by: "compliance",
    });
  }
}

/** Parses one checked-in fixture through the shared dispatcher. */
function parseFixture(fixture: string) {
  const content = loadFixture(fixture);
  const profile = dispatchStatementProfile(content);
  if (profile === null) throw new Error(`fixture ${fixture} failed to dispatch`);
  return { profile, lines: profile.parse(content) };
}

/** Full setup for the deal fixtures: state rules, caps, cleared audits. */
async function setupDealStore(store: Store): Promise<void> {
  await registerStateRules(store);
  await registerCaps(store);
  await registerClearedAudits(store, ["B-5003", "C-6001", "C-6002", "C-6003"]);
}

describe("the adjusted direct revenue sharing calculator", () => {
  it("nets the pool exactly to the cent: Title IX reserve + admin fee + net === gross", async () => {
    const store = new InMemoryStore();
    await registerPrograms(store);
    await registerWaterfall(store);
    const { lines } = parseFixture("nil_school_rev_share_pools.csv");
    const counts = await writeNilRowsToStore(store, lines);

    const application = await store.getNilPoolApplication(
      nilRowEventId({
        sender: "school",
        athleteId: null,
        schoolId: "SCH-1",
        period: "2026-09",
        senderRowId: "P-7001",
      }),
    );
    expect(application).toBeDefined();
    expect(application?.gross_pool_cents).toBe(1_000_000_000);
    expect(application?.title_ix_reserve_cents).toBe(50_000_000);
    expect(application?.admin_fee_cents).toBe(25_000_000);
    expect(application?.net_athlete_share_pool_cents).toBe(925_000_000);
    expect(
      application!.title_ix_reserve_cents + application!.admin_fee_cents +
        application!.net_athlete_share_pool_cents,
    ).toBe(application!.gross_pool_cents);
    expect(counts.netAthleteSharePoolCents).toBe(925_000_000);
  });

  it("prices both deductions off the GROSS pool, never off the post-reserve remainder", () => {
    const pool = netAthleteSharePoolCents({
      grossPoolCents: 1_000_000_003,
      titleIxReserveBps: 500,
      adminFeeBps: 250,
    });
    expect(pool.titleIxReserveCents).toBe(50_000_000);
    expect(pool.adminFeeCents).toBe(25_000_000);
    expect(pool.netAthleteSharePoolCents).toBe(925_000_003);
  });
});

describe("the tiered roster waterfall", () => {
  it("walks the directive's fixture: QB 15%, the O-line pool 25% across five, walk-on stipends", async () => {
    const store = new InMemoryStore();
    await registerPrograms(store);
    await registerWaterfall(store);
    const { lines } = parseFixture("nil_school_rev_share_pools.csv");
    await writeNilRowsToStore(store, lines);

    const application = await store.getNilPoolApplication(
      nilRowEventId({
        sender: "school",
        athleteId: null,
        schoolId: "SCH-1",
        period: "2026-09",
        senderRowId: "P-7001",
      }),
    );
    const slices = JSON.parse(application?.slices ?? "[]") as {
      tier_key: string;
      tier_cents: number;
      member_amounts: { athlete_id: string; cents: number }[];
    }[];
    expect(slices).toHaveLength(3);
    // The starting QB's 15% of the NET pool.
    expect(slices[0].tier_key).toBe("qb_starting");
    expect(slices[0].tier_cents).toBe(138_750_000);
    expect(slices[0].member_amounts).toEqual([
      { athlete_id: "ATH-QB-1", cents: 138_750_000 },
    ]);
    // The O-line pool's 25% divides equally across its five members.
    expect(slices[1].tier_key).toBe("oline_pool");
    expect(slices[1].tier_cents).toBe(231_250_000);
    expect(slices[1].member_amounts).toEqual(
      ["ATH-OL-1", "ATH-OL-2", "ATH-OL-3", "ATH-OL-4", "ATH-OL-5"].map((athlete_id) => ({
        athlete_id,
        cents: 46_250_000,
      })),
    );
    // The walk-on base stipend tier pays each member the stipend.
    expect(slices[2].tier_key).toBe("walkon_base");
    expect(slices[2].tier_cents).toBe(5_000_000);
    expect(application?.roster_paid_cents).toBe(375_000_000);
    // The under-committed remainder sweeps to dust — conserved.
    expect(application?.dust_cents).toBe(550_000_000);
    expect(application!.roster_paid_cents + application!.dust_cents).toBe(
      application?.net_athlete_share_pool_cents,
    );
  });

  it("caps stipend payments at the pool remaining — under-pays in order, never negative", () => {
    const walk = rosterWalkCents(1_500_000, [
      {
        tier_key: "exhausted",
        share_bps: null,
        base_stipend_cents: 1_000_000,
        member_ids: ["A", "B", "C"],
      },
    ]);
    // A and B take the stipend; C takes the $500k remainder — never a
    // negative pool, and the walk conserves.
    expect(walk.allocations[0].member_amounts).toEqual([
      { athlete_id: "A", cents: 1_000_000 },
      { athlete_id: "B", cents: 500_000 },
      { athlete_id: "C", cents: 0 },
    ]);
    expect(walk.rosterPaidCents).toBe(1_500_000);
    expect(walk.dustCents).toBe(0);
  });

  it("skips a pool fail-closed when no program of record — never guesses rates", async () => {
    const store = new InMemoryStore();
    await registerPrograms(store);
    await registerWaterfall(store);
    const { lines } = parseFixture("nil_school_rev_share_pools.csv");
    const counts = await writeNilRowsToStore(store, lines);

    expect(counts.poolWalksSkippedNoProgram).toBe(1); // P-7002 / SCH-9
    expect(
      await store.getNilPoolApplication(
        nilRowEventId({
          sender: "school",
          athleteId: null,
          schoolId: "SCH-9",
          period: "2026-09",
          senderRowId: "P-7002",
        }),
      ),
    ).toBeUndefined();
  });

  it("skips a pool fail-closed when no waterfall of record — never invents a schedule", async () => {
    const store = new InMemoryStore();
    await registerPrograms(store);
    await registerWaterfall(store);
    const { lines } = parseFixture("nil_school_rev_share_pools.csv");
    const counts = await writeNilRowsToStore(store, lines);

    expect(counts.poolWalksSkippedNoWaterfall).toBe(1); // P-7003 / SCH-2
    expect(
      await store.getNilPoolApplication(
        nilRowEventId({
          sender: "school",
          athleteId: null,
          schoolId: "SCH-2",
          period: "2026-09",
          senderRowId: "P-7003",
        }),
      ),
    ).toBeUndefined();
  });
});

describe("the $600 valid business purpose audit", () => {
  it("flags a deal at exactly $600.00 and holds it pending the metadata match", async () => {
    const store = new InMemoryStore();
    await setupDealStore(store);
    const { lines } = parseFixture("nil_brand_endorsements.csv");
    const counts = await writeNilRowsToStore(store, lines);

    const audit = await store.getNilDealComplianceAudit("B-5002");
    expect(audit?.business_purpose_state).toBe("flagged");
    expect(audit?.deal_value_cents).toBe(60_000);
    expect(counts.auditsFlagged).toBe(1);
    const application = await store.getNilPayoutApplication(
      nilRowEventId({
        sender: "brand",
        athleteId: "ATH-WR-2",
        schoolId: "SCH-2",
        period: "2026-09",
        senderRowId: "B-5002",
      }),
    );
    expect(application?.verdict).toBe("held_compliance");
  });

  it("does not flag a deal below $600.00 — B-5001 at $599.99 pays unflagged", async () => {
    const store = new InMemoryStore();
    await setupDealStore(store);
    const { lines } = parseFixture("nil_brand_endorsements.csv");
    const counts = await writeNilRowsToStore(store, lines);

    expect(await store.getNilDealComplianceAudit("B-5001")).toBeUndefined();
    const application = await store.getNilPayoutApplication(
      nilRowEventId({
        sender: "brand",
        athleteId: "ATH-QB-1",
        schoolId: "SCH-1",
        period: "2026-09",
        senderRowId: "B-5001",
      }),
    );
    expect(application?.verdict).toBe("paid");
    expect(counts.auditsFlagged).toBe(1); // only B-5002 tripped
  });

  it("pays a flagged contract once the audit of record reads nil_cleared", async () => {
    const store = new InMemoryStore();
    await setupDealStore(store);
    const { lines } = parseFixture("nil_brand_endorsements.csv");
    const counts = await writeNilRowsToStore(store, lines);

    // B-5003 ($1,500) arrived with the operator's metadata match of record.
    const application = await store.getNilPayoutApplication(
      nilRowEventId({
        sender: "brand",
        athleteId: "ATH-QB-1",
        schoolId: "SCH-1",
        period: "2026-09",
        senderRowId: "B-5003",
      }),
    );
    expect(application?.verdict).toBe("paid");
    expect(counts.auditsCleared).toBe(1); // B-5003's pre-registered audit
  });
});

describe("the associated-entity holdback", () => {
  it("pays a collective deal verified within the $20.5M institutional cap", async () => {
    const store = new InMemoryStore();
    await setupDealStore(store);
    const { lines } = parseFixture("nil_collective_disclosures.csv");
    const counts = await writeNilRowsToStore(store, lines);

    const application = await store.getNilPayoutApplication(
      nilRowEventId({
        sender: "collective",
        athleteId: "ATH-QB-1",
        schoolId: "SCH-1",
        period: "2026-09",
        senderRowId: "C-6001",
      }),
    );
    expect(application?.verdict).toBe("paid");
    expect(application?.cap_verified_ref).not.toBeNull();
    expect(counts.dealsHeldCompliance).toBe(2); // C-6002 + C-6003, not this one
  });

  it("holds a booster deal that would exceed the cap allowance", async () => {
    const store = new InMemoryStore();
    await setupDealStore(store);
    const { lines } = parseFixture("nil_collective_disclosures.csv");
    await writeNilRowsToStore(store, lines);

    // SCH-2's verification carries $20.49M committed; the $25M booster
    // deal pushes past the $20.5M allowance — held, no verification ref.
    const application = await store.getNilPayoutApplication(
      nilRowEventId({
        sender: "collective",
        athleteId: "ATH-WR-2",
        schoolId: "SCH-2",
        period: "2026-09",
        senderRowId: "C-6002",
      }),
    );
    expect(application?.verdict).toBe("held_compliance");
    expect(application?.cap_verified_ref).toBeNull();
  });

  it("holds a collective deal fail-closed when no cap of record exists", async () => {
    const store = new InMemoryStore();
    await setupDealStore(store);
    const { lines } = parseFixture("nil_collective_disclosures.csv");
    await writeNilRowsToStore(store, lines);

    const application = await store.getNilPayoutApplication(
      nilRowEventId({
        sender: "collective",
        athleteId: "ATH-TE-3",
        schoolId: "SCH-3",
        period: "2026-09",
        senderRowId: "C-6003",
      }),
    );
    expect(application?.verdict).toBe("held_compliance");
    expect(application?.cap_verified_ref).toBeNull();
  });

  it("skips the cap check for a direct deal — no associated entity to verify", async () => {
    const store = new InMemoryStore();
    await registerStateRules(store);
    // No caps registered at all — a direct deal still pays.
    const directCsv = [
      "Deal ID,Contract Date,Athlete ID,School ID,State Jurisdiction Code,Deal Category,Brand,Deal Value,Agency Fee Mode,Agency Commission BPS,Currency,Reporting Period",
      "B-5100,2026-09-05,ATH-QB-1,SCH-1,CA,private_brand,Beacon Sportswear,400.00,none,0,USD,2026-09",
    ].join("\n");
    const profile = dispatchStatementProfile(directCsv);
    if (profile === null) throw new Error("direct deal failed to dispatch");
    const counts = await writeNilRowsToStore(store, profile.parse(directCsv));

    expect(counts.dealsWritten).toBe(1);
    const application = await store.getNilPayoutApplication(
      nilRowEventId({
        sender: "brand",
        athleteId: "ATH-QB-1",
        schoolId: "SCH-1",
        period: "2026-09",
        senderRowId: "B-5100",
      }),
    );
    expect(application?.verdict).toBe("paid");
    expect(application?.cap_verified_ref).toBeNull();
  });
});

describe("the sports agency commission", () => {
  it("deducts the marketing commission at payout — 15% of $599.99, floored", async () => {
    const store = new InMemoryStore();
    await setupDealStore(store);
    const { lines } = parseFixture("nil_brand_endorsements.csv");
    await writeNilRowsToStore(store, lines);

    const application = await store.getNilPayoutApplication(
      nilRowEventId({
        sender: "brand",
        athleteId: "ATH-QB-1",
        schoolId: "SCH-1",
        period: "2026-09",
        senderRowId: "B-5001",
      }),
    );
    expect(application?.agency_mode).toBe("marketing");
    expect(application?.agency_fee_cents).toBe(8_999); // floor(59_999 × 0.15)
    expect(application?.net_payout_cents).toBe(51_000); // 59_999 − 8_999
  });

  it("deducts the direct rev-share band's commission — 3% of $1,500.00", async () => {
    const store = new InMemoryStore();
    await setupDealStore(store);
    const { lines } = parseFixture("nil_brand_endorsements.csv");
    await writeNilRowsToStore(store, lines);

    const application = await store.getNilPayoutApplication(
      nilRowEventId({
        sender: "brand",
        athleteId: "ATH-QB-1",
        schoolId: "SCH-1",
        period: "2026-09",
        senderRowId: "B-5003",
      }),
    );
    expect(application?.agency_mode).toBe("direct_rev_share");
    expect(application?.agency_fee_cents).toBe(4_500);
    expect(application?.net_payout_cents).toBe(145_500);
  });

  it("refuses an out-of-band marketing fee at parse — never a guessed rate", () => {
    const hostileCsv = [
      "Deal ID,Contract Date,Athlete ID,School ID,State Jurisdiction Code,Deal Category,Brand,Deal Value,Agency Fee Mode,Agency Commission BPS,Currency,Reporting Period",
      "B-5200,2026-09-05,ATH-QB-1,SCH-1,CA,private_brand,Beacon Sportswear,400.00,marketing,2500,USD,2026-09",
    ].join("\n");
    const profile = dispatchStatementProfile(hostileCsv);
    if (profile === null) throw new Error("hostile deal failed to dispatch");
    expect(() => profile.parse(hostileCsv)).toThrow(StatementParseError);
  });

  it("accepts 'none' at exactly 0 bps and deducts nothing", async () => {
    const store = new InMemoryStore();
    await setupDealStore(store);
    const { lines } = parseFixture("nil_brand_endorsements.csv");
    await writeNilRowsToStore(store, lines);

    const application = await store.getNilPayoutApplication(
      nilRowEventId({
        sender: "brand",
        athleteId: "ATH-TE-3",
        schoolId: "SCH-3",
        period: "2026-09",
        senderRowId: "B-5004",
      }),
    );
    expect(application?.agency_mode).toBe("none");
    expect(application?.agency_fee_cents).toBe(0);
    expect(application?.net_payout_cents).toBe(application?.gross_cents);
  });
});

describe("the group NIL equal split", () => {
  it("divides team-wide license revenue equally with the odd cent swept to dust", async () => {
    const store = new InMemoryStore();
    const { lines } = parseFixture("nil_media_rights_distributions.csv");
    await writeNilRowsToStore(store, lines);

    const split = await store.getNilGroupSplit(
      nilRowEventId({
        sender: "media",
        athleteId: null,
        schoolId: "SCH-1",
        period: "2026-09",
        senderRowId: "D-8001",
      }),
    );
    expect(split?.total_cents).toBe(100_000_003);
    expect(split?.participant_count).toBe(3);
    expect(split?.per_participant_cents).toBe(33_333_334);
    expect(split?.dust_cents).toBe(1);
    // THE CONSERVATION IDENTITY the row pins.
    expect(split!.per_participant_cents * split!.participant_count + split!.dust_cents).toBe(
      split?.total_cents,
    );
  });

  it("splits exactly when the total divides evenly across the roster", async () => {
    const store = new InMemoryStore();
    const { lines } = parseFixture("nil_media_rights_distributions.csv");
    await writeNilRowsToStore(store, lines);

    const split = await store.getNilGroupSplit(
      nilRowEventId({
        sender: "media",
        athleteId: null,
        schoolId: "SCH-1",
        period: "2026-09",
        senderRowId: "D-8002",
      }),
    );
    expect(split?.per_participant_cents).toBe(5_000);
    expect(split?.dust_cents).toBe(0);
  });

  it("prices the equal split's floor and dust at the engine level", () => {
    const split = equalGroupSplitCents(1_000_003, ["A", "B", "C", "D"]);
    expect(split.perParticipantCents).toBe(250_000);
    expect(split.dustCents).toBe(3);
    expect(split.amounts.every((amount) => amount.cents === 250_000)).toBe(true);
  });
});

describe("the high school state compliance matrix", () => {
  it("pays through an explicit 'permitted' rule of record", async () => {
    const store = new InMemoryStore();
    await setupDealStore(store);
    const { lines } = parseFixture("nil_brand_endorsements.csv");
    await writeNilRowsToStore(store, lines);

    const application = await store.getNilPayoutApplication(
      nilRowEventId({
        sender: "brand",
        athleteId: "ATH-QB-1",
        schoolId: "SCH-1",
        period: "2026-09",
        senderRowId: "B-5001",
      }),
    );
    expect(application?.verdict).toBe("paid");
    expect(application?.state_rule_ref).toBeNull();
  });

  it("holds a 'prohibited' rule and records the blocking rule's code", async () => {
    const store = new InMemoryStore();
    await setupDealStore(store);
    const { lines } = parseFixture("nil_brand_endorsements.csv");
    await writeNilRowsToStore(store, lines);

    // B-5002 (TX) trips BOTH the $600 flag and the jersey prohibition —
    // the verdict records the first failing gate, the ref records the
    // state block alongside.
    const application = await store.getNilPayoutApplication(
      nilRowEventId({
        sender: "brand",
        athleteId: "ATH-WR-2",
        schoolId: "SCH-2",
        period: "2026-09",
        senderRowId: "B-5002",
      }),
    );
    expect(application?.verdict).toBe("held_compliance");
    expect(application?.state_rule_ref).toBe("hs_jersey_private_endorsement");
  });

  it("holds fail-closed when no rule of record exists for the state", async () => {
    const store = new InMemoryStore();
    await setupDealStore(store);
    const { lines } = parseFixture("nil_brand_endorsements.csv");
    const counts = await writeNilRowsToStore(store, lines);

    // B-5004 (NY): no hs_jersey rule of record — unverified is not allowed.
    const application = await store.getNilPayoutApplication(
      nilRowEventId({
        sender: "brand",
        athleteId: "ATH-TE-3",
        schoolId: "SCH-3",
        period: "2026-09",
        senderRowId: "B-5004",
      }),
    );
    expect(application?.verdict).toBe("held_state_rule");
    expect(application?.state_rule_ref).toBe("hs_jersey_private_endorsement");
    expect(counts.dealsHeldStateRule).toBe(1);
  });
});

describe("the NIL replay guards", () => {
  it("counts a full re-ship as counted no-ops — never a double payout", async () => {
    const store = new InMemoryStore();
    await setupDealStore(store);
    await registerPrograms(store);
    await registerWaterfall(store);
    const brand = parseFixture("nil_brand_endorsements.csv");
    const collective = parseFixture("nil_collective_disclosures.csv");
    const pools = parseFixture("nil_school_rev_share_pools.csv");
    const media = parseFixture("nil_media_rights_distributions.csv");

    const first = await writeNilRowsToStore(store, [
      ...brand.lines,
      ...collective.lines,
      ...pools.lines,
      ...media.lines,
    ]);
    expect(first.dealsWritten).toBe(7);
    expect(first.poolWalksWritten).toBe(1);
    expect(first.groupSplitsWritten).toBe(2);

    const replay = await writeNilRowsToStore(store, [
      ...brand.lines,
      ...collective.lines,
      ...pools.lines,
      ...media.lines,
    ]);
    expect(replay.dealsWritten).toBe(0);
    expect(replay.dealsReplayed).toBe(7);
    expect(replay.poolWalksWritten).toBe(0);
    expect(replay.poolWalksReplayed).toBe(1);
    expect(replay.groupSplitsWritten).toBe(0);
    expect(replay.groupSplitsReplayed).toBe(2);
    // The replay raised no second flag and re-walked no pool.
    expect(replay.auditsFlagged).toBe(0);
    expect(replay.netAthleteSharePoolCents).toBe(0);
  });
});

describe("the NIL ingestion profiles", () => {
  it("dispatches all four senders to the NIL lane's kinds", () => {
    for (const fixture of [
      "nil_brand_endorsements.csv",
      "nil_collective_disclosures.csv",
      "nil_school_rev_share_pools.csv",
      "nil_media_rights_distributions.csv",
    ]) {
      const content = loadFixture(fixture);
      const profile = dispatchStatementProfile(content);
      expect(profile, fixture).not.toBeNull();
      expect(isNilProfileKind(profile!.kind), fixture).toBe(true);
    }
  });

  it("keeps NIL event identities distinct per sender for the same row id", () => {
    const brand = nilRowEventId({
      sender: "brand",
      athleteId: "ATH-QB-1",
      schoolId: "SCH-1",
      period: "2026-09",
      senderRowId: "ROW-1",
    });
    const collective = nilRowEventId({
      sender: "collective",
      athleteId: "ATH-QB-1",
      schoolId: "SCH-1",
      period: "2026-09",
      senderRowId: "ROW-1",
    });
    expect(brand).not.toBe(collective);
  });
});

describe("the NIL lane over the SQLite backend", () => {
  it("walks the same fixtures to the same verdicts and money", async () => {
    const store = new SqliteStore(":memory:");
    await setupDealStore(store);
    await registerPrograms(store);
    await registerWaterfall(store);
    const brand = parseFixture("nil_brand_endorsements.csv");
    const pools = parseFixture("nil_school_rev_share_pools.csv");
    const media = parseFixture("nil_media_rights_distributions.csv");
    const counts: NilWriteCounts = await writeNilRowsToStore(store, [
      ...brand.lines,
      ...pools.lines,
      ...media.lines,
    ]);

    expect(counts.dealsWritten).toBe(4);
    expect(counts.poolWalksWritten).toBe(1);
    expect(counts.groupSplitsWritten).toBe(2);
    expect(counts.netAthleteSharePoolCents).toBe(925_000_000);

    const application = await store.getNilPoolApplication(
      nilRowEventId({
        sender: "school",
        athleteId: null,
        schoolId: "SCH-1",
        period: "2026-09",
        senderRowId: "P-7001",
      }),
    );
    expect(application?.net_athlete_share_pool_cents).toBe(925_000_000);
    expect(application?.roster_paid_cents).toBe(375_000_000);
    expect(application?.dust_cents).toBe(550_000_000);
  });
});

/** Seeds one statement ingest and its recon job — the worker E2E harness. */
async function seedJob(
  store: Store,
  fileName: string,
  content: string,
): Promise<{ jobId: string; ingestId: string }> {
  const ingest = await store.insertStatementIngest({
    format: "csv_statement",
    source: "statement",
    file_name: fileName,
    content,
    status: "parsed",
    event_count: null,
    error: null,
    created_at: new Date("2026-09-30T12:00:00Z").toISOString(),
  });
  const job = await store.createReconJob({ source: "statement", ingest_id: ingest.id });
  return { jobId: job.id, ingestId: ingest.id };
}

describe("the NIL lane end-to-end through the recon worker", () => {
  it("drives a brand endorsement sheet through ingest → job → nil_* result block", async () => {
    const store = new InMemoryStore();
    await setupDealStore(store);
    const { jobId } = await seedJob(
      store,
      "nil_brand_endorsements.csv",
      loadFixture("nil_brand_endorsements.csv"),
    );

    const processed = await runOnce({
      store,
      vault: null,
      now: () => new Date("2026-09-30T12:00:00Z"),
    });
    expect(processed?.outcome).toBe("completed");
    expect(processed?.job.id).toBe(jobId);
    expect(processed?.job.engine).toBe(RECON_WORKER_ENGINE);
    expect(processed?.job.status).toBe("completed");
    // The four brand rows: B-5001 paid, B-5002 held (flag + TX jersey),
    // B-5003 paid through the cleared audit, B-5004 held (no NY rule).
    expect(processed?.job.result).toEqual({
      events_written: 4, // four NIL rows applied to durable NIL stores
      matched: 0,
      unmatched: 0,
      engine_used: null,
      holding_posted: 0,
      holding_replayed: 0,
      nil_payouts_committed: 4,
      nil_payouts_replayed: 0,
      nil_payouts_held_compliance: 1,
      nil_payouts_held_state_rule: 1,
      nil_deal_audits_flagged: 1,
      nil_deal_audits_cleared: 1,
      nil_pool_walks_committed: 0,
      nil_pool_walks_replayed: 0,
      nil_pool_walks_skipped_no_program: 0,
      nil_pool_walks_skipped_no_waterfall: 0,
      nil_group_splits_committed: 0,
      nil_group_splits_replayed: 0,
      nil_gate_states_upserted: 4,
      nil_deal_gross_cents: 319_999,
      nil_agency_fees_cents: 25_499,
      nil_net_payout_cents: 294_500,
      nil_net_athlete_share_pool_cents: 0,
      nil_roster_paid_cents: 0,
      nil_dust_cents: 0,
    });

    // The payout application is durable, keyed on the NIL event identity.
    const application = await store.getNilPayoutApplication(
      nilRowEventId({
        sender: "brand",
        athleteId: "ATH-WR-2",
        schoolId: "SCH-2",
        period: "2026-09",
        senderRowId: "B-5002",
      }),
    );
    expect(application?.verdict).toBe("held_compliance");
  });
});
