// Focused unit tests for the webtoon studio split + translation cascade
// service (PR 20) — the planner edge cases and release-flow refusals the
// three-backend parity scenario does not isolate: the founder-band
// enforcement, the proportional level-2 split, the amortization line's
// remainder math, the sequential multi-release candidate freshness (each
// release consumes and routes ITS OWN line — the remainder line included),
// the escrow-amount cap on a recovery line, and the refusals that must
// never take the CAS lock or consume a schedule line.

import { describe, expect, it } from "vitest";
import { InMemoryStore } from "@/lib/server/inMemoryStore";
import type { Store } from "@/lib/server/store";
import {
  buildWebtoonLocalizationAmortizationLine,
  buildWebtoonStudioSplitPlan,
  buildWebtoonTranslationCascadePlan,
  postTranslationRoyaltyToEscrow,
  releaseTranslationLocalizationEscrow,
} from "@/lib/server/webtoonStudioCascade";
import type { WebtoonStudioSplitRoleRecord } from "@/modules/don/records";
import { setVerticalComplianceStateSource } from "@/modules/compliance/payoutGate";

const NOW = new Date("2026-10-02T09:00:00Z");
const AUTHOR = { payee_id: "payee-author", payee_name: "Atlas (author)" };

function role(
  overrides: Partial<WebtoonStudioSplitRoleRecord> & {
    role_group: WebtoonStudioSplitRoleRecord["role_group"];
    payee_id: string;
    share_bps: number;
  },
): WebtoonStudioSplitRoleRecord {
  return {
    id: `role-${overrides.payee_id}`,
    series_id: "studio-atlas",
    payee_name: overrides.payee_id,
    contract_ref: "agmt-001",
    created_at: NOW.toISOString(),
    ...overrides,
  } as WebtoonStudioSplitRoleRecord;
}

// ---------------------------------------------------------------------------
// The deterministic amortization line — floor(total/periods) with the LAST
// line absorbing the integer-cent remainder.
// ---------------------------------------------------------------------------

describe("buildWebtoonLocalizationAmortizationLine", () => {
  it("floors the even split", () => {
    expect(buildWebtoonLocalizationAmortizationLine(10_000, 4, 0)).toBe(2_500);
    expect(buildWebtoonLocalizationAmortizationLine(10_000, 4, 2)).toBe(2_500);
  });

  it("absorbs the integer-cent remainder on the last line", () => {
    expect(buildWebtoonLocalizationAmortizationLine(10_001, 4, 0)).toBe(2_500);
    expect(buildWebtoonLocalizationAmortizationLine(10_001, 4, 2)).toBe(2_500);
    expect(buildWebtoonLocalizationAmortizationLine(10_001, 4, 3)).toBe(2_501);
  });
});

// ---------------------------------------------------------------------------
// The studio split planner — founder bands, the author residual, and the
// proportional level-2 member split.
// ---------------------------------------------------------------------------

describe("buildWebtoonStudioSplitPlan", () => {
  it("gives an empty registry's whole pool to the author (a studio of one)", () => {
    const plan = buildWebtoonStudioSplitPlan({
      studio_pool_cents: 100_000,
      author_payee_id: AUTHOR.payee_id,
      author_payee_name: AUTHOR.payee_name,
      roles: [],
    });
    if (!plan.ok) throw new Error(plan.message);
    expect(plan.value.groups).toEqual([]);
    expect(plan.value.author.net_cents).toBe(100_000);
    expect(plan.value.company_dust_cents).toBe(0);
  });

  it("refuses a group outside its founder band, both sides", () => {
    // The founder mandate: original creator & storywriter 30-40% net.
    for (const share_bps of [2_999, 4_001]) {
      const plan = buildWebtoonStudioSplitPlan({
        studio_pool_cents: 100_000,
        author_payee_id: AUTHOR.payee_id,
        author_payee_name: AUTHOR.payee_name,
        roles: [
          role({ role_group: "original_creator_storywriter", payee_id: "p1", share_bps }),
        ],
      });
      expect(plan.ok).toBe(false);
      if (!plan.ok) {
        expect(plan.status).toBe(422);
        expect(plan.code).toBe("webtoon_role_group_band_violation");
      }
    }
  });

  it("splits a multi-member group's pool proportionally, author LAST", () => {
    const plan = buildWebtoonStudioSplitPlan({
      studio_pool_cents: 100_000,
      author_payee_id: AUTHOR.payee_id,
      author_payee_name: AUTHOR.payee_name,
      roles: [
        role({ role_group: "original_creator_storywriter", payee_id: "p-alice", share_bps: 1_111 }),
        role({ role_group: "original_creator_storywriter", payee_id: "p-bob", share_bps: 2_222 }),
        role({ role_group: "line_artist_inker", payee_id: "p-caro", share_bps: 2_500 }),
      ],
    });
    if (!plan.ok) throw new Error(plan.message);
    const [storywriter, inker] = plan.value.groups;
    // Level 1: the storywriter group holds 3_333 bps of the pool.
    expect(storywriter!.group_bps).toBe(3_333);
    expect(storywriter!.pool_cents).toBe(33_330);
    // Level 2: proportional to each member's bps over the group's total.
    expect(storywriter!.members.map((m) => [m.payee_id, m.amount_cents])).toEqual([
      ["p-alice", 11_110],
      ["p-bob", 22_220],
    ]);
    expect(inker!.group_bps).toBe(2_500);
    expect(inker!.pool_cents).toBe(25_000);
    expect(inker!.members.map((m) => [m.payee_id, m.amount_cents])).toEqual([
      ["p-caro", 25_000],
    ]);
    // The author's residual: 10000 - 3333 - 2500 = 4167 bps.
    expect(plan.value.author.net_cents).toBe(41_670);
    expect(plan.value.company_dust_cents).toBe(0);
  });

  it("conserves cents on an odd pool — the level-one residue sweeps as dust", () => {
    // Hand-computed: pool 999, a line-artist group at 2_500 bps holds
    // floor(2500×999/10000) = 249, the author residual (7_500 bps) holds
    // floor(7500×999/10000) = 749 — 1 cent of residue sweeps as dust.
    const plan = buildWebtoonStudioSplitPlan({
      studio_pool_cents: 999,
      author_payee_id: AUTHOR.payee_id,
      author_payee_name: AUTHOR.payee_name,
      roles: [
        role({ role_group: "line_artist_inker", payee_id: "p-mila", share_bps: 2_500 }),
      ],
    });
    if (!plan.ok) throw new Error(plan.message);
    expect(plan.value.groups[0]!.pool_cents).toBe(249);
    expect(plan.value.groups[0]!.members[0]!.amount_cents).toBe(249);
    expect(plan.value.author.net_cents).toBe(749);
    expect(plan.value.company_dust_cents).toBe(1);
    const routed =
      plan.value.author.net_cents +
      plan.value.groups.reduce((total, group) => total + group.pool_cents, 0) +
      plan.value.company_dust_cents;
    expect(routed).toBe(999);
  });

  it("refuses malformed roles (unknown group, non-positive bps)", () => {
    const badGroup = buildWebtoonStudioSplitPlan({
      studio_pool_cents: 100_000,
      author_payee_id: AUTHOR.payee_id,
      author_payee_name: AUTHOR.payee_name,
      roles: [
        role({
          role_group: "session_musician" as WebtoonStudioSplitRoleRecord["role_group"],
          payee_id: "p-x",
          share_bps: 3_000,
        }),
      ],
    });
    expect(badGroup.ok).toBe(false);
    if (!badGroup.ok) expect(badGroup.code).toBe("webtoon_role_group_unknown");

    const badBps = buildWebtoonStudioSplitPlan({
      studio_pool_cents: 100_000,
      author_payee_id: AUTHOR.payee_id,
      author_payee_name: AUTHOR.payee_name,
      roles: [role({ role_group: "colorist_background", payee_id: "p-y", share_bps: 0 })],
    });
    expect(badBps.ok).toBe(false);
    if (!badBps.ok) expect(badBps.code).toBe("webtoon_role_invalid");
  });
});

// ---------------------------------------------------------------------------
// The translation cascade planner — the localizer's fee modes and the
// fail-closed fee cap.
// ---------------------------------------------------------------------------

describe("buildWebtoonTranslationCascadePlan", () => {
  const roles = [
    role({ role_group: "original_creator_storywriter", payee_id: "p-alice", share_bps: 4_000 }),
  ];

  it("routes the flat fee BEFORE the studio split", () => {
    const plan = buildWebtoonTranslationCascadePlan({
      feed_net_cents: 100_000,
      localizer: { payee_id: "p-loc", payee_name: "Localizer" },
      fee: { mode: "flat_fee", per_chapter_flat_fee_cents: 25_000, chapter_count: 1 },
      author_payee_id: AUTHOR.payee_id,
      author_payee_name: AUTHOR.payee_name,
      roles,
    });
    if (!plan.ok) throw new Error(plan.message);
    expect(plan.value.localizer.royalty_cents).toBe(25_000);
    expect(plan.value.studio.studio_pool_cents).toBe(75_000);
    // The party list: the localizer FIRST, then the studio members, author LAST.
    expect(plan.value.party_splits[0]!.payee_id).toBe("p-loc");
    expect(plan.value.party_splits[plan.value.party_splits.length - 1]!.payee_id).toBe(
      AUTHOR.payee_id,
    );
  });

  it("routes the rev share as bps of the feed net", () => {
    const plan = buildWebtoonTranslationCascadePlan({
      feed_net_cents: 100_000,
      localizer: { payee_id: "p-loc", payee_name: "Localizer" },
      fee: { mode: "rev_share", rev_share_bps: 3_000 },
      author_payee_id: AUTHOR.payee_id,
      author_payee_name: AUTHOR.payee_name,
      roles,
    });
    if (!plan.ok) throw new Error(plan.message);
    expect(plan.value.localizer.royalty_cents).toBe(30_000);
    expect(plan.value.studio.studio_pool_cents).toBe(70_000);
  });

  it("passes the whole feed through when no localizer rides", () => {
    const plan = buildWebtoonTranslationCascadePlan({
      feed_net_cents: 100_000,
      localizer: null,
      fee: { mode: "flat_fee", per_chapter_flat_fee_cents: 0, chapter_count: 0 },
      author_payee_id: AUTHOR.payee_id,
      author_payee_name: AUTHOR.payee_name,
      roles: [],
    });
    if (!plan.ok) throw new Error(plan.message);
    expect(plan.value.localizer.royalty_cents).toBe(0);
    expect(plan.value.studio.studio_pool_cents).toBe(100_000);
    expect(plan.value.studio.author.net_cents).toBe(100_000);
  });

  it("refuses a feed that cannot carry its own localizer", () => {
    const flat = buildWebtoonTranslationCascadePlan({
      feed_net_cents: 100_000,
      localizer: { payee_id: "p-loc", payee_name: "Localizer" },
      fee: { mode: "flat_fee", per_chapter_flat_fee_cents: 250_000, chapter_count: 1 },
      author_payee_id: AUTHOR.payee_id,
      author_payee_name: AUTHOR.payee_name,
      roles,
    });
    expect(flat.ok).toBe(false);
    if (!flat.ok) expect(flat.code).toBe("localization_fee_exceeds_feed");

    const badBps = buildWebtoonTranslationCascadePlan({
      feed_net_cents: 100_000,
      localizer: { payee_id: "p-loc", payee_name: "Localizer" },
      fee: { mode: "rev_share", rev_share_bps: 10_001 },
      author_payee_id: AUTHOR.payee_id,
      author_payee_name: AUTHOR.payee_name,
      roles,
    });
    expect(badBps.ok).toBe(false);
    if (!badBps.ok) expect(badBps.code).toBe("localization_fee_invalid");
  });
});

// ---------------------------------------------------------------------------
// The release flow — sequential candidate freshness, the escrow cap, and the
// refusals that never take the CAS or consume a line.
// ---------------------------------------------------------------------------

async function seedVerifiedParty(
  store: Store,
  payeeId: string,
  payeeName: string,
): Promise<void> {
  await store.upsertVault({
    payee_id: payeeId,
    payee_name: payeeName,
    available_balance: 0,
    pending_balance: 0,
    reserve_balance: 0,
    updated_at: NOW.toISOString(),
  });
  await store.insertKycVerification({
    creator_id: payeeId,
    plaid_link_token: "link-token",
    plaid_public_token: "public-token",
    status: "verified",
    identity_json: "{}",
    failure_reason: null,
    created_at: NOW.toISOString(),
    verified_at: NOW.toISOString(),
  });
  await store.upsertCreatorTaxProfile({
    creator_id: payeeId,
    tin_verified: 1,
    w9_on_file: 1,
    updated_at: NOW.toISOString(),
  });
}

async function seedVerifiedStudio(store: Store, seriesId: string): Promise<void> {
  await seedVerifiedParty(store, AUTHOR.payee_id, AUTHOR.payee_name);
  await store.insertWebtoonStudioSplitRole({
    series_id: seriesId,
    role_group: "original_creator_storywriter",
    payee_id: "p-alice",
    payee_name: "Alice",
    share_bps: 4_000,
    contract_ref: "agmt-001",
    created_at: NOW.toISOString(),
  });
  await seedVerifiedParty(store, "p-alice", "Alice");
  await store.upsertWebtoonLocalizationContract({
    series_id: seriesId,
    language_code: "es",
    localizer_payee_id: "p-loc",
    localizer_payee_name: "Localizer",
    fee_mode: "rev_share",
    per_chapter_flat_fee_cents: 0,
    rev_share_bps: 3_000,
    contract_ref: "agmt-001",
    created_at: NOW.toISOString(),
  });
  await seedVerifiedParty(store, "p-loc", "Localizer");
}

async function postEscrow(
  store: Store,
  eventId: string,
  amountCents: number,
): Promise<string> {
  const posted = await postTranslationRoyaltyToEscrow(
    store,
    {
      series_id: "studio-atlas",
      language_code: "es",
      amount_cents: amountCents,
      currency: "USD",
      source: { type: "match_queue", event_id: eventId },
    },
    NOW,
  );
  if (!posted.ok) throw new Error(posted.message);
  return posted.value.escrow_credit.id;
}

function releaseInput(escrowId: string, scheduleRef: string | null) {
  return {
    escrow_ledger_id: escrowId,
    author_payee_id: AUTHOR.payee_id,
    author_payee_name: AUTHOR.payee_name,
    amortization_schedule_ref: scheduleRef,
    operator_settlement_approved: true,
  };
}

describe("releaseTranslationLocalizationEscrow — schedule behavior", () => {
  it("consumes and routes each release's OWN line across sequential releases — the remainder line included", async () => {
    const store = new InMemoryStore();
    setVerticalComplianceStateSource(async () => ({
      vertical: "publishing",
      ip_rights_cleared: true,
      return_reserve_period_elapsed: true,
      isbn_rights_verified: true,
    }));
    await seedVerifiedStudio(store, "studio-atlas");
    // 40_003 over 4 periods: lines 10_000 / 10_000 / 10_000 / 10_003.
    await store.insertWebtoonLocalizationCostSchedule({
      schedule_ref: "loc-atlas-es-01",
      series_id: "studio-atlas",
      language_code: "es",
      total_cost_cents: 40_003,
      amortization_periods: 4,
      cost_agreement_ref: "agmt-001",
      created_at: NOW.toISOString(),
    });

    const escrowOne = await postEscrow(store, "evt-1", 13_000);
    const releasedOne = await releaseTranslationLocalizationEscrow(
      store,
      releaseInput(escrowOne, "loc-atlas-es-01"),
      NOW,
    );
    if (!releasedOne.ok) throw new Error(releasedOne.message);
    expect(releasedOne.value.amortization).toEqual({
      line_index: 0,
      computed_cents: 10_000,
      applied_cents: 10_000,
    });
    expect(releasedOne.value.credits[0]).toMatchObject({
      step: "localization_cost_recovery",
      gross_cents: 10_000,
    });

    const escrowTwo = await postEscrow(store, "evt-2", 13_000);
    const releasedTwo = await releaseTranslationLocalizationEscrow(
      store,
      releaseInput(escrowTwo, "loc-atlas-es-01"),
      NOW,
    );
    if (!releasedTwo.ok) throw new Error(releasedTwo.message);
    expect(releasedTwo.value.amortization).toEqual({
      line_index: 1,
      computed_cents: 10_000,
      applied_cents: 10_000,
    });

    const escrowThree = await postEscrow(store, "evt-3", 13_000);
    const releasedThree = await releaseTranslationLocalizationEscrow(
      store,
      releaseInput(escrowThree, "loc-atlas-es-01"),
      NOW,
    );
    if (!releasedThree.ok) throw new Error(releasedThree.message);
    expect(releasedThree.value.amortization).toEqual({
      line_index: 2,
      computed_cents: 10_000,
      applied_cents: 10_000,
    });

    // The FOURTH release reads the remainder line FRESH — routing its
    // 10_003 (never a stale 10_000 candidate).
    const escrowFour = await postEscrow(store, "evt-4", 20_003);
    const releasedFour = await releaseTranslationLocalizationEscrow(
      store,
      releaseInput(escrowFour, "loc-atlas-es-01"),
      NOW,
    );
    if (!releasedFour.ok) throw new Error(releasedFour.message);
    expect(releasedFour.value.amortization).toEqual({
      line_index: 3,
      computed_cents: 10_003,
      applied_cents: 10_003,
    });
    expect(releasedFour.value.credits[0]).toMatchObject({
      step: "localization_cost_recovery",
      gross_cents: 10_003,
    });
    // Conservation: every routed gross plus dust equals the escrow's amount.
    const routedGross = releasedFour.value.credits.reduce(
      (total, credit) => total + credit.gross_cents,
      0,
    );
    expect(routedGross + releasedFour.value.company_dust_cents).toBe(20_003);

    // The schedule is spent — a further release refuses BEFORE the CAS
    // (the escrow stays locked).
    const escrowFive = await postEscrow(store, "evt-5", 5_000);
    const refused = await releaseTranslationLocalizationEscrow(
      store,
      releaseInput(escrowFive, "loc-atlas-es-01"),
      NOW,
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.status).toBe(409);
      expect(refused.code).toBe("localization_cost_schedule_completed");
    }
    const stillLocked = await store.getLedgerTransaction(escrowFive);
    expect(stillLocked!.status).toBe("translation_localization_pending");
    expect(await store.listWebtoonLocalizationCostLines("loc-atlas-es-01")).toHaveLength(4);
  });

  it("caps the recovery line at the escrow's amount and cascades the true remainder", async () => {
    const store = new InMemoryStore();
    setVerticalComplianceStateSource(async () => ({
      vertical: "publishing",
      ip_rights_cleared: true,
      return_reserve_period_elapsed: true,
      isbn_rights_verified: true,
    }));
    await seedVerifiedStudio(store, "studio-atlas");
    await store.insertWebtoonLocalizationCostSchedule({
      schedule_ref: "loc-atlas-es-02",
      series_id: "studio-atlas",
      language_code: "es",
      total_cost_cents: 40_000,
      amortization_periods: 4, // line 0 computes 10_000
      cost_agreement_ref: "agmt-001",
      created_at: NOW.toISOString(),
    });
    // A 4_000 receipt: the candidate caps at 4_000, the rev share of the
    // zero remainder is zero, the whole escrow recovers to the house.
    const escrowId = await postEscrow(store, "evt-cap", 4_000);
    const released = await releaseTranslationLocalizationEscrow(
      store,
      releaseInput(escrowId, "loc-atlas-es-02"),
      NOW,
    );
    if (!released.ok) throw new Error(released.message);
    expect(released.value.amortization).toEqual({
      line_index: 0,
      computed_cents: 10_000,
      applied_cents: 4_000,
    });
    // The zero remainder cascades nothing — but the studio member's floored
    // zero share still reports (gross 0, net 0) beside the cost recovery.
    expect(released.value.credits).toHaveLength(2);
    expect(released.value.credits[0]).toMatchObject({
      step: "localization_cost_recovery",
      gross_cents: 4_000,
    });
    expect(released.value.credits[1]).toMatchObject({
      step: "studio_role",
      gross_cents: 0,
    });
    expect(released.value.company_dust_cents).toBe(0);
    const lines = await store.listWebtoonLocalizationCostLines("loc-atlas-es-02");
    expect(lines).toHaveLength(1);
    expect(lines[0]!.amount_cents).toBe(4_000);
  });

  it("never consumes a schedule line on a gate refusal or a schedule mismatch", async () => {
    const store = new InMemoryStore();
    setVerticalComplianceStateSource(async () => ({
      vertical: "publishing",
      ip_rights_cleared: true,
      return_reserve_period_elapsed: true,
      isbn_rights_verified: true,
    }));
    await seedVerifiedStudio(store, "studio-atlas");
    await store.insertWebtoonLocalizationCostSchedule({
      schedule_ref: "loc-atlas-es-03",
      series_id: "studio-atlas",
      language_code: "es",
      total_cost_cents: 40_000,
      amortization_periods: 4,
      cost_agreement_ref: "agmt-001",
      created_at: NOW.toISOString(),
    });

    // The gate refusal: the author has no KYC record — refused BEFORE the
    // CAS and BEFORE any line consumes.
    const gatedEscrow = await postEscrow(store, "evt-gate", 20_000);
    const gated = await releaseTranslationLocalizationEscrow(
      store,
      {
        escrow_ledger_id: gatedEscrow,
        author_payee_id: "payee-nobody",
        author_payee_name: "Nobody",
        amortization_schedule_ref: "loc-atlas-es-03",
        operator_settlement_approved: true,
      },
      NOW,
    );
    expect(gated.ok).toBe(false);
    if (!gated.ok) expect(gated.code).toBe("kyc_state_unknown");
    expect(await store.listWebtoonLocalizationCostLines("loc-atlas-es-03")).toHaveLength(0);
    expect((await store.getLedgerTransaction(gatedEscrow))!.status).toBe(
      "translation_localization_pending",
    );

    // The schedule mismatch: the ja escrow may not ride the es schedule.
    await store.upsertWebtoonLocalizationContract({
      series_id: "studio-atlas",
      language_code: "ja",
      localizer_payee_id: "p-loc",
      localizer_payee_name: "Localizer",
      fee_mode: "rev_share",
      per_chapter_flat_fee_cents: 0,
      rev_share_bps: 3_000,
      contract_ref: "agmt-001",
      created_at: NOW.toISOString(),
    });
    const jaPosted = await postTranslationRoyaltyToEscrow(
      store,
      {
        series_id: "studio-atlas",
        language_code: "ja",
        amount_cents: 20_000,
        currency: "USD",
        source: { type: "match_queue", event_id: "evt-ja" },
      },
      NOW,
    );
    if (!jaPosted.ok) throw new Error(jaPosted.message);
    await seedVerifiedParty(store, "payee-nobody", "Nobody");
    const mismatched = await releaseTranslationLocalizationEscrow(
      store,
      releaseInput(jaPosted.value.escrow_credit.id, "loc-atlas-es-03"),
      NOW,
    );
    expect(mismatched.ok).toBe(false);
    if (!mismatched.ok) expect(mismatched.code).toBe("localization_cost_schedule_mismatch");
    expect(await store.listWebtoonLocalizationCostLines("loc-atlas-es-03")).toHaveLength(0);
  });

  it("refuses an unknown escrow id and a feed with no contract of record", async () => {
    const store = new InMemoryStore();
    setVerticalComplianceStateSource(async () => ({
      vertical: "publishing",
      ip_rights_cleared: true,
      return_reserve_period_elapsed: true,
      isbn_rights_verified: true,
    }));
    const missing = await releaseTranslationLocalizationEscrow(
      store,
      releaseInput("no-such-escrow", null),
      NOW,
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.status).toBe(404);

    await postEscrow(store, "evt-nocontract", 10_000);
    const pending = await store.listTranslationLocalizationEscrowCredits();
    const noContract = await releaseTranslationLocalizationEscrow(
      store,
      releaseInput(pending[0]!.id, null),
      NOW,
    );
    expect(noContract.ok).toBe(false);
    if (!noContract.ok) expect(noContract.code).toBe("missing_localization_contract");
  });
});
