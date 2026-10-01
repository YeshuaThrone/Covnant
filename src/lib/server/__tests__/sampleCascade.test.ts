/**
 * Unit tests for the sample cascade and statutory cover mechanicals (PR 17)
 * — the PURE planners, the clearance-agreement parser, the versioned
 * statutory rate schedule, and the queue-line router. The three-backend
 * release behavior (the canonical seam, gates, replay) is pinned by
 * sampleCascadeParity.test.ts; here the math and every fail-closed refusal
 * are pinned against plain fixtures with no store.
 */

import { describe, expect, it } from "vitest";

import {
  buildCoverMechanicalPlan,
  buildSampleCascadePlan,
  parseClearanceAgreement,
  routeMusicQueueLine,
  statutoryMechanicalBpsForYear,
  STATUTORY_MECHANICAL_RATE_TABLE_VERSION,
} from "@/lib/server/sampleCascade";
import type { MusicQueueLineRoute } from "@/lib/server/sampleCascade";
import type { SampleClearanceEdgeRecord } from "@/modules/don/records";
import type { SplitPartyInput } from "@/lib/don/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = new Date("2026-10-01T12:00:00Z");

function edge(
  workId: string,
  parentCompositionId: string,
  rightsType: "master" | "publishing",
  payeeId: string,
  payeeName: string,
  licenseBps: number,
): SampleClearanceEdgeRecord {
  return {
    id: `edge:${workId}->${parentCompositionId}:${payeeId}:${rightsType}`,
    work_id: workId,
    parent_composition_id: parentCompositionId,
    rights_type: rightsType,
    rights_holder_payee_id: payeeId,
    rights_holder_payee_name: payeeName,
    license_bps: licenseBps,
    clearance_agreement_ref: `AGR-${workId}-${parentCompositionId}`,
    created_at: NOW.toISOString(),
  };
}

/** The canonical multi-sample chain: D samples P1; P1 interpolates P2. */
const CHAIN_EDGES: SampleClearanceEdgeRecord[] = [
  edge("D", "P1", "master", "label-heartbreak", "Heartbreak Records", 1_250),
  edge("P1", "P2", "master", "label-grand", "Grand Master Holdings", 2_500),
];

const ARTIST_PRODUCER: SplitPartyInput[] = [
  { payee_id: "artist-1", payee_name: "The Artist", role: "creator", share_bps: 7_000 },
  { payee_id: "producer-1", payee_name: "The Producer", role: "producer", share_bps: 3_000 },
];

type plannerResult<V> = { ok: true; value: V } | { ok: false; status: number; code: string; message: string };

function mustSucceed<V>(result: plannerResult<V>): V {
  if (!result.ok) {
    throw new Error(`expected success, got ${result.status} ${result.code}: ${result.message}`);
  }
  return result.value;
}

function mustFail(
  result: plannerResult<unknown>,
): { status: number; code: string; message: string } {
  if (result.ok) throw new Error("expected refusal, got success");
  return { status: result.status, code: result.code, message: result.message };
}

// The router's success variants carry path/identity, not a value — it needs
// its own refusal unwrapper typed on the exported route union.
function mustRouteFail(result: MusicQueueLineRoute): { code: string } {
  if (result.ok) throw new Error("expected refusal, got success");
  return { code: result.code };
}

// ---------------------------------------------------------------------------
// parseClearanceAgreement — the strict, fail-closed contract boundary.
// ---------------------------------------------------------------------------

describe("parseClearanceAgreement", () => {
  it("extracts the license percentage in bps from the stated text", () => {
    const parsed = mustSucceed(
      parseClearanceAgreement({
        work_id: "D",
        parent_composition_id: "P1",
        rights_type: "master",
        licensor_payee_id: "label-heartbreak",
        licensor_payee_name: "Heartbreak Records",
        license_percentage_text: "12.5%",
        agreement_ref: "AGR-001",
      }),
    );
    expect(parsed.license_bps).toBe(1_250);
    expect(parsed.work_id).toBe("D");
    expect(parsed.parent_composition_id).toBe("P1");
    expect(parsed.rights_type).toBe("master");
    expect(parsed.rights_holder_payee_id).toBe("label-heartbreak");
    expect(parsed.clearance_agreement_ref).toBe("AGR-001");
  });

  it("parses a bare decimal without the percent sign and sub-percent values", () => {
    expect(
      mustSucceed(
        parseClearanceAgreement({
          work_id: "D",
          parent_composition_id: "P1",
          rights_type: "publishing",
          licensor_payee_id: "pub-1",
          licensor_payee_name: "Publisher",
          license_percentage_text: "0.1",
          agreement_ref: "AGR-002",
        }),
      ).license_bps,
    ).toBe(10);
  });

  it("refuses percentages finer than basis points — a silently-rounded contract percentage is a forged contract", () => {
    expect(
      mustFail(
        parseClearanceAgreement({
          work_id: "D",
          parent_composition_id: "P1",
          rights_type: "master",
          licensor_payee_id: "pub-1",
          licensor_payee_name: "Publisher",
          license_percentage_text: "12.505%",
          agreement_ref: "AGR-003",
        }),
      ).code,
    ).toBe("clearance_percentage_unparseable");
  });

  it("refuses non-numeric, malformed, and finer-than-bps percentage text", () => {
    for (const text of ["twelve", "-5%", "1e2", "", "12,%", "0.001"]) {
      expect(
        mustFail(
          parseClearanceAgreement({
            work_id: "D",
            parent_composition_id: "P1",
            rights_type: "master",
            licensor_payee_id: "pub-1",
            licensor_payee_name: "Publisher",
            license_percentage_text: text,
            agreement_ref: "AGR-004",
          }),
        ).code,
      ).toBe("clearance_percentage_unparseable");
    }
  });

  it("refuses a zero, negative, or over-whole license percentage", () => {
    for (const text of ["0%", "150%"]) {
      expect(
        mustFail(
          parseClearanceAgreement({
            work_id: "D",
            parent_composition_id: "P1",
            rights_type: "master",
            licensor_payee_id: "pub-1",
            licensor_payee_name: "Publisher",
            license_percentage_text: text,
            agreement_ref: "AGR-005",
          }),
        ).code,
      ).toBe("clearance_percentage_out_of_range");
    }
  });

  it("refuses a work licensing itself — the DDL check's parse-side twin", () => {
    expect(
      mustFail(
        parseClearanceAgreement({
          work_id: "D",
          parent_composition_id: "D",
          rights_type: "master",
          licensor_payee_id: "pub-1",
          licensor_payee_name: "Publisher",
          license_percentage_text: "10%",
          agreement_ref: "AGR-006",
        }),
      ).code,
    ).toBe("sample_cascade_self_edge");
  });

  it("refuses a rights type outside the two sides of the queue", () => {
    expect(
      mustFail(
        parseClearanceAgreement({
          work_id: "D",
          parent_composition_id: "P1",
          rights_type: "sync",
          licensor_payee_id: "pub-1",
          licensor_payee_name: "Publisher",
          license_percentage_text: "10%",
          agreement_ref: "AGR-007",
        }),
      ).code,
    ).toBe("clearance_rights_type_invalid");
  });

  it("refuses an incomplete agreement — every party and the source of record are named", () => {
    for (const patch of [
      { work_id: "" },
      { parent_composition_id: "" },
      { licensor_payee_id: "" },
      { licensor_payee_name: "" },
      { agreement_ref: "" },
    ]) {
      expect(
        mustFail(
          parseClearanceAgreement({
            work_id: "D",
            parent_composition_id: "P1",
            rights_type: "master",
            licensor_payee_id: "pub-1",
            licensor_payee_name: "Publisher",
            license_percentage_text: "10%",
            agreement_ref: "AGR-008",
            ...patch,
          }),
        ).code,
      ).toBe("clearance_agreement_incomplete");
    }
  });
});

// ---------------------------------------------------------------------------
// routeMusicQueueLine — the discriminator, one side per line.
// ---------------------------------------------------------------------------

describe("routeMusicQueueLine", () => {
  it("routes a plain music line (no dependency, no cover) to the existing path", () => {
    expect(
      routeMusicQueueLine({ rights_type: "master", parent_composition_id: null, is_cover_version: false }),
    ).toEqual({ ok: true, path: "plain" });
  });

  it("routes a master sample line and a publishing interpolation line down their own sides", () => {
    expect(
      routeMusicQueueLine({ rights_type: "master", parent_composition_id: "P1", is_cover_version: false }),
    ).toEqual({ ok: true, path: "sample_cascade", rights_type: "master" });
    expect(
      routeMusicQueueLine({ rights_type: "publishing", parent_composition_id: "P1", is_cover_version: false }),
    ).toEqual({ ok: true, path: "sample_cascade", rights_type: "publishing" });
  });

  it("routes a cover version to the statutory mechanical path over its covered composition", () => {
    expect(
      routeMusicQueueLine({ rights_type: "publishing", parent_composition_id: "comp:original", is_cover_version: true }),
    ).toEqual({ ok: true, path: "cover_mechanical", composition_id: "comp:original" });
  });

  it("refuses an unresolved rights type — the separation settles before any math", () => {
    expect(
      mustRouteFail(
        routeMusicQueueLine({ rights_type: "unknown", parent_composition_id: "P1", is_cover_version: false }),
      ).code,
    ).toBe("music_rights_type_unresolved");
  });

  it("refuses a cover version with no covered composition — the statutory pool has nowhere to route", () => {
    expect(
      mustRouteFail(
        routeMusicQueueLine({ rights_type: "publishing", parent_composition_id: null, is_cover_version: true }),
      ).code,
    ).toBe("cover_missing_composition");
  });
});

// ---------------------------------------------------------------------------
// buildSampleCascadePlan — the pure planner's math and refusals.
// ---------------------------------------------------------------------------

describe("buildSampleCascadePlan", () => {
  it("reserves the chain depth-first upstream-first, then splits the net", () => {
    const plan = mustSucceed(
      buildSampleCascadePlan(
        {
          work_id: "D",
          line_gross_cents: 10_000,
          rights_type: "master",
          net_splits: ARTIST_PRODUCER,
        },
        (workId) => CHAIN_EDGES.filter((e) => e.work_id === workId),
      ),
    );
    // Step 1 is the direct sample; step 2 is its own upstream dependency —
    // the top-line deductions complete before the net split math runs.
    expect(plan.reservations.map((r) => [r.step, r.parent_composition_id, r.royalty_cents])).toEqual([
      [1, "P1", 1_250],
      [2, "P2", 2_500],
    ]);
    expect(plan.upstream_total_cents).toBe(3_750);
    expect(plan.downstream.net_bps).toBe(6_250);
    expect(plan.downstream.net_cents).toBe(6_250);
    expect(plan.downstream.splits.map((s) => [s.payee_id, s.net_cents])).toEqual([
      ["artist-1", 4_375],
      ["producer-1", 1_875],
    ]);
    expect(plan.company_dust_cents).toBe(0);
    // The party list: reservations first (upstream first), then the net.
    expect(plan.party_splits.map((p) => [p.payee_id, p.share_bps])).toEqual([
      ["label-heartbreak", 1_250],
      ["label-grand", 2_500],
      ["artist-1", 4_375],
      ["producer-1", 1_875],
    ]);
  });

  it("fires a diamond's edges once each — node expansion, both contracts pay", () => {
    const edges = [
      edge("D", "P1", "master", "label-a", "Label A", 600),
      edge("D", "P2", "master", "label-b", "Label B", 400),
      edge("P1", "P3", "master", "label-c", "Label C", 250),
      edge("P2", "P3", "master", "label-d", "Label D", 300),
    ];
    const plan = mustSucceed(
      buildSampleCascadePlan(
        { work_id: "D", line_gross_cents: 10_000, rights_type: "master", net_splits: ARTIST_PRODUCER },
        (workId) => edges.filter((e) => e.work_id === workId),
      ),
    );
    expect(plan.reservations.map((r) => [r.step, r.parent_composition_id, r.royalty_cents])).toEqual([
      [1, "P1", 600],
      [2, "P3", 250],
      [3, "P2", 400],
      [4, "P3", 300],
    ]);
    expect(plan.upstream_total_cents).toBe(1_550);
  });

  it("refuses a cycle — nothing releases from a tree that cannot be walked to the root", () => {
    const edges = [
      edge("D", "P1", "master", "label-a", "Label A", 100),
      edge("P1", "D", "master", "label-b", "Label B", 100),
    ];
    expect(
      mustFail(
        buildSampleCascadePlan(
          { work_id: "D", line_gross_cents: 10_000, rights_type: "master", net_splits: ARTIST_PRODUCER },
          (workId) => edges.filter((e) => e.work_id === workId),
        ),
      ).code,
    ).toBe("sample_cascade_cycle");
  });

  it("refuses an over-contracted tree, naming the breaching edge", () => {
    const edges = [
      edge("D", "P1", "master", "label-a", "Label A", 9_000),
      edge("P1", "P2", "master", "label-b", "Label B", 1_001),
    ];
    const refusal = mustFail(
      buildSampleCascadePlan(
        { work_id: "D", line_gross_cents: 10_000, rights_type: "master", net_splits: ARTIST_PRODUCER },
        (workId) => edges.filter((e) => e.work_id === workId),
      ),
    );
    expect(refusal.code).toBe("sample_cascade_exceeds_line");
    expect(refusal.message).toContain("10001 bps");
  });

  it("fires only the line's own side's edges — the rights-type separation", () => {
    const edges = [
      edge("D", "P1", "master", "label-a", "Label A", 1_000),
      edge("D", "P2", "publishing", "pub-b", "Publisher B", 1_000),
    ];
    for (const [side, expectedParent] of [
      ["master", "P1"],
      ["publishing", "P2"],
    ] as const) {
      const plan = mustSucceed(
        buildSampleCascadePlan(
          { work_id: "D", line_gross_cents: 10_000, rights_type: side, net_splits: ARTIST_PRODUCER },
          (workId) => edges.filter((e) => e.work_id === workId),
        ),
      );
      expect(plan.reservations).toHaveLength(1);
      expect(plan.reservations[0].parent_composition_id).toBe(expectedParent);
    }
  });

  it("sweeps the integer-cent floor residue as company dust on an odd gross", () => {
    const plan = mustSucceed(
      buildSampleCascadePlan(
        { work_id: "D", line_gross_cents: 9_999, rights_type: "master", net_splits: ARTIST_PRODUCER },
        (workId) => CHAIN_EDGES.filter((e) => e.work_id === workId),
      ),
    );
    // floor(1250 × 9999/10000) = 1249; floor(2500 × 9999/10000) = 2499.
    expect(plan.reservations.map((r) => r.royalty_cents)).toEqual([1_249, 2_499]);
    // 3748 reserved; the 6252-bps net over 9999 cents floors to 4374 + 1874
    // — the three lost fractional cents sweep as company dust.
    expect(plan.company_dust_cents).toBe(3);
    const paid = plan.party_splits.reduce(
      (total, p) => total + Math.floor((p.share_bps * 9_999) / 10_000),
      0,
    );
    expect(paid + plan.company_dust_cents).toBe(9_999);
  });

  it("refuses net splits that do not balance, repeat a payee, or carry an empty identity", () => {
    const badCases: SplitPartyInput[][] = [
      // A single payee cannot hold the whole net alone — shares must be a
      // complete artist/producer split (here: 7000 ≠ 10000).
      [{ payee_id: "artist-1", payee_name: "The Artist", role: "creator", share_bps: 7_000 }],
      // Sums to 10001.
      [
        { payee_id: "artist-1", payee_name: "The Artist", role: "creator", share_bps: 9_000 },
        { payee_id: "producer-1", payee_name: "The Producer", role: "producer", share_bps: 1_001 },
      ],
      // A repeated payee — one payee, one split row.
      [
        { payee_id: "artist-1", payee_name: "The Artist", role: "creator", share_bps: 6_000 },
        { payee_id: "producer-1", payee_name: "The Producer", role: "producer", share_bps: 4_000 },
        { payee_id: "artist-1", payee_name: "The Artist", role: "creator", share_bps: 1 },
      ],
      // An unnamed payee.
      [
        { payee_id: "artist-1", payee_name: "", role: "creator", share_bps: 5_000 },
        { payee_id: "producer-1", payee_name: "P", role: "producer", share_bps: 5_000 },
      ],
      // A zero share is not a split.
      [
        { payee_id: "artist-1", payee_name: "A", role: "creator", share_bps: 0 },
        { payee_id: "producer-1", payee_name: "P", role: "producer", share_bps: 10_000 },
      ],
    ];
    const codes = new Set<string>();
    for (const badSplits of badCases) {
      codes.add(
        mustFail(
          buildSampleCascadePlan(
            { work_id: "D", line_gross_cents: 10_000, rights_type: "master", net_splits: badSplits },
            () => [],
          ),
        ).code,
      );
    }
    expect([...codes].sort()).toEqual(["invalid_line_input", "net_splits_do_not_balance"]);
  });

  it("refuses an invalid edge and an invalid line gross, fail-closed", () => {
    const broken = [edge("D", "P1", "master", "", "Label A", 1_000)];
    expect(
      mustFail(
        buildSampleCascadePlan(
          { work_id: "D", line_gross_cents: 10_000, rights_type: "master", net_splits: ARTIST_PRODUCER },
          () => broken,
        ),
      ).code,
    ).toBe("sample_cascade_invalid_edge");
    expect(
      mustFail(
        buildSampleCascadePlan(
          { work_id: "D", line_gross_cents: 10_000.5, rights_type: "master", net_splits: ARTIST_PRODUCER },
          () => [],
        ),
      ).code,
    ).toBe("invalid_line_input");
  });
});

// ---------------------------------------------------------------------------
// buildCoverMechanicalPlan — the statutory pool routes publishers first.
// ---------------------------------------------------------------------------

const PUBLISHERS = [
  {
    id: "cp-1",
    composition_id: "comp:original",
    publisher_payee_id: "pub-sonya",
    publisher_payee_name: "Sonya Publishing",
    share_bps: 6_000,
    created_at: NOW.toISOString(),
  },
  {
    id: "cp-2",
    composition_id: "comp:original",
    publisher_payee_id: "pub-motowna",
    publisher_payee_name: "Motowna Publishing",
    share_bps: 4_000,
    created_at: NOW.toISOString(),
  },
];

const COVER_RATE = { rate_bps: 1_530, rate_table_version: STATUTORY_MECHANICAL_RATE_TABLE_VERSION };

describe("buildCoverMechanicalPlan", () => {
  it("routes the statutory pool to the publishers by share, the artist last", () => {
    const plan = mustSucceed(
      buildCoverMechanicalPlan(
        {
          composition_id: "comp:original",
          line_gross_cents: 10_000,
          recording_artist: { payee_id: "artist-1", payee_name: "The Artist" },
          statutory_mechanical: COVER_RATE,
        },
        PUBLISHERS,
      ),
    );
    expect(plan.mechanical_pool_cents).toBe(1_530);
    expect(plan.publisher_cents.map((p) => [p.payee_id, p.share_bps, p.allocated_bps, p.mechanical_cents])).toEqual([
      ["pub-sonya", 6_000, 918, 918],
      ["pub-motowna", 4_000, 612, 612],
    ]);
    expect(plan.artist.allocated_bps).toBe(8_470);
    expect(plan.artist.net_cents).toBe(8_470);
    expect(plan.company_dust_cents).toBe(0);
    // Publishers precede the artist — statutory priority is list order.
    expect(plan.party_splits.map((p) => p.payee_id)).toEqual(["pub-sonya", "pub-motowna", "artist-1"]);
    // The publisher roles are businesses, the artist is a creator — the
    // release path's withholding evaluates on exactly these roles.
    expect(plan.party_splits.map((p) => p.role)).toEqual(["publisher", "publisher", "creator"]);
  });

  it("sweeps the floor residue as dust on an odd gross", () => {
    const plan = mustSucceed(
      buildCoverMechanicalPlan(
        {
          composition_id: "comp:original",
          line_gross_cents: 9_999,
          recording_artist: { payee_id: "artist-1", payee_name: "The Artist" },
          statutory_mechanical: COVER_RATE,
        },
        PUBLISHERS,
      ),
    );
    // floor(918 × 9999/10000) = 917; floor(612 × 9999/10000) = 611;
    // floor(8470 × 9999/10000) = 8469 — paid 9997, dust 2.
    expect(plan.publisher_cents.map((p) => p.mechanical_cents)).toEqual([917, 611]);
    expect(plan.artist.net_cents).toBe(8_469);
    expect(plan.company_dust_cents).toBe(2);
  });

  it("refuses an empty or unbalanced publisher registry — the registry of record is complete or nothing routes", () => {
    expect(
      mustFail(
        buildCoverMechanicalPlan(
          {
            composition_id: "comp:original",
            line_gross_cents: 10_000,
            recording_artist: { payee_id: "artist-1", payee_name: "The Artist" },
            statutory_mechanical: COVER_RATE,
          },
          [],
        ),
      ).code,
    ).toBe("composition_publishers_empty");
    expect(
      mustFail(
        buildCoverMechanicalPlan(
          {
            composition_id: "comp:original",
            line_gross_cents: 10_000,
            recording_artist: { payee_id: "artist-1", payee_name: "The Artist" },
            statutory_mechanical: COVER_RATE,
          },
          [PUBLISHERS[0]],
        ),
      ).code,
    ).toBe("composition_publishers_unbalanced");
  });

  it("refuses an invalid statutory rate — the rate that moves money is on the record", () => {
    for (const rateBps of [0, -5, 10_001, 1_530.5]) {
      expect(
        mustFail(
          buildCoverMechanicalPlan(
            {
              composition_id: "comp:original",
              line_gross_cents: 10_000,
              recording_artist: { payee_id: "artist-1", payee_name: "The Artist" },
              statutory_mechanical: {
                rate_bps: rateBps,
                rate_table_version: STATUTORY_MECHANICAL_RATE_TABLE_VERSION,
              },
            },
            PUBLISHERS,
          ),
        ).code,
      ).toBe("statutory_rate_invalid");
    }
  });

  it("refuses an unnamed recording artist or composition", () => {
    expect(
      mustFail(
        buildCoverMechanicalPlan(
          {
            composition_id: "comp:original",
            line_gross_cents: 10_000,
            recording_artist: { payee_id: "", payee_name: "The Artist" },
            statutory_mechanical: COVER_RATE,
          },
          PUBLISHERS,
        ),
      ).code,
    ).toBe("invalid_line_input");
    expect(
      mustFail(
        buildCoverMechanicalPlan(
          {
            composition_id: "",
            line_gross_cents: 10_000,
            recording_artist: { payee_id: "artist-1", payee_name: "The Artist" },
            statutory_mechanical: COVER_RATE,
          },
          PUBLISHERS,
        ),
      ).code,
    ).toBe("invalid_line_input");
  });
});

// ---------------------------------------------------------------------------
// statutoryMechanicalBpsForYear — the versioned reference schedule.
// ---------------------------------------------------------------------------

describe("statutoryMechanicalBpsForYear", () => {
  it("returns the Phonorecords IV headline streaming rates in period", () => {
    expect(statutoryMechanicalBpsForYear(2023)).toEqual({
      rate_bps: 1_510,
      rate_table_version: "phonorecords_iv_streaming",
    });
    expect(statutoryMechanicalBpsForYear(2024)!.rate_bps).toBe(1_520);
    expect(statutoryMechanicalBpsForYear(2025)!.rate_bps).toBe(1_525);
    expect(statutoryMechanicalBpsForYear(2026)!.rate_bps).toBe(1_530);
    expect(statutoryMechanicalBpsForYear(2027)!.rate_bps).toBe(1_535);
  });

  it("refuses out-of-period years — a pending determination is never guessed", () => {
    expect(statutoryMechanicalBpsForYear(2022)).toBeUndefined();
    expect(statutoryMechanicalBpsForYear(2028)).toBeUndefined();
  });
});
