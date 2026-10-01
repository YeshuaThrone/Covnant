/**
 * Gaming lane — queue → posting → split accrual on the in-memory store
 * (PR 12), end to end through the worker's gaming branch (`runOnce`).
 *
 * Pinned here, against the checked-in fixtures:
 * - the Epic threshold crossing — the $900k waived EGS sale then the $250k
 *   Unreal sale paying 3.5% on exactly the window above $1M;
 * - the resale royalty as the original creator's OWN holding credit
 *   (deducted from the seller's net at posting, posted under the
 *   `gaming:royalty:` event id at accrual);
 * - the sub-cent quarantine (a net under one cent never posts), the
 *   unmatched row's honest skip, the fail-closed accrual refusals
 *   (secondary without a schedule or payee, a corrupted stored schedule),
 *   and every replay guard's counted no-op.
 */
import { describe, expect, it } from "vitest";

import { InMemoryStore } from "@/lib/server/inMemoryStore";
import type { Store } from "@/lib/server/store";
import { UNCLAIMED_HOLDING_PAYEE_ID } from "@/modules/don/constants";

import type { VaultLookup } from "../matchQueue";
import { CanonicalPostingError } from "../posting";
import { postGamingLinesToHolding } from "../gamingPosting";
import {
  registerGamingItemSplitSchedule,
  runGamingSplitAccrualPass,
} from "../gamingAccrual";
import { writeGamingLinesToMatchQueue } from "../gamingQueue";
import { dispatchStatementProfile } from "../profiles";
import { runOnce } from "../worker";
import { loadFixture } from "./fixtures";

const NOW = () => new Date("2026-09-30T12:00:00Z");

/** Every fixture DOI resolves to the verified vault game asset. */
function vaultWithDoi(): VaultLookup {
  return {
    async findByIdentifier(kind, value) {
      if (kind === "DOI" && value === "10.61982/covenant.game-001") {
        return {
          cvtCode: "CVT-TEST-GAME",
          cbtCode: "CBT-GAME-TEST-001",
          title: "Covenant Chronicles",
          medium: "game",
          externalIdentifiers: { DOI: value },
          holderUct: null,
        };
      }
      return null;
    },
  };
}

/** The founder directive's default 50/30/20 split across three payees. */
function defaultSplits() {
  return [
    { payee_id: "payee-studio-lead", payee_name: "Studio Lead", role: "creator" as const, share_bps: 5000 },
    { payee_id: "payee-modeler", payee_name: "3D Modeler", role: "producer" as const, share_bps: 3000 },
    { payee_id: "payee-audio", payee_name: "Audio Designer", role: "other" as const, share_bps: 2000 },
  ];
}

/** Registers the fixtures' items — the resale item optionally with a payee. */
async function registerSchedules(store: Store, resalePayee: string | null) {
  const items = [
    "ITEM-SKIN-001",
    "ITEM-PROP-002",
    "ITEM-EMOTE-003",
    "ITEM-DLC-010",
    "ITEM-SCENE-030",
  ];
  for (const item of items) {
    await registerGamingItemSplitSchedule(
      store,
      { item_id: item, splits: defaultSplits(), resale_royalty_payee_id: null },
      NOW(),
    );
  }
  // The resale fixture's item — its royalty routes to the ORIGINAL creator
  // of the pack (a different payee than the current seller's schedule).
  await registerGamingItemSplitSchedule(
    store,
    {
      item_id: "ITEM-PACK-020",
      splits: defaultSplits(),
      resale_royalty_payee_id: resalePayee,
    },
    NOW(),
  );
}

/** Seeds one statement ingest + recon job for a gaming fixture. */
async function seedGamingJob(store: Store, fixture: string): Promise<string> {
  const ingest = await store.insertStatementIngest({
    format: "csv_statement",
    source: "statement",
    file_name: fixture,
    content: loadFixture(fixture),
    status: "parsed",
    event_count: null,
    error: null,
    created_at: NOW().toISOString(),
  });
  await store.createReconJob({ source: "statement", ingest_id: ingest.id });
  return ingest.id;
}

/** Runs the worker's full gaming branch over one seeded ingest. */
async function runGamingFixture(store: Store, fixture: string) {
  const ingestId = await seedGamingJob(store, fixture);
  const processed = await runOnce({ store, vault: vaultWithDoi(), now: NOW });
  return { ingestId, result: processed?.job.result ?? null };
}

/** Drives the queue pass only — the posting-pass tests' raw setup. */
async function seedAndWrite(store: Store, fixture: string) {
  const ingestId = await seedGamingJob(store, fixture);
  return { ingestId, counts: await writeQueueOnly(store, fixture, ingestId) };
}

/** Drives queue + posting — the accrual tests' setup. */
async function seedAndPost(store: Store, fixture: string) {
  const ingestId = await seedGamingJob(store, fixture);
  const counts = await writeQueueOnly(store, fixture, ingestId);
  await postGamingLinesToHolding(store, counts.lineOutcomes, NOW());
  return { ingestId, counts };
}

async function writeQueueOnly(store: Store, fixture: string, ingestId: string) {
  const profile = dispatchStatementProfile(loadFixture(fixture));
  if (profile === null) throw new Error(`${fixture} failed to dispatch`);
  const lines = profile.parse(loadFixture(fixture));
  return writeGamingLinesToMatchQueue(store, ingestId, lines, vaultWithDoi(), NOW());
}

/** The ingest's gaming queue rows in write order — ingest scoping lives in
 * the event id (`gaming:line:<platform>:<ingestId>:line:N`); the store's
 * list is newest-first with no ingest filter. */
async function queueRowsFor(store: Store, ingestId: string) {
  const all = await store.listMatchQueueEntries(undefined, 100);
  return all
    .filter((row) => row.event_id.includes(ingestId))
    .sort((a, b) => a.event_id.localeCompare(b.event_id));
}

async function heldCredits(store: Store) {
  return store.listUnclaimedHoldingCredits(100);
}

describe("the Epic threshold crossing — end to end through the worker", () => {
  it("posts both nets and levies 3.5% on exactly the window above $1M", async () => {
    const store = new InMemoryStore();
    await registerSchedules(store, null);
    const { ingestId, result } = await runGamingFixture(store, "gaming_epic_sales.csv");

    expect(result).toMatchObject({
      events_written: 2,
      matched: 2,
      unmatched: 0,
      // Gaming posts land in the SHARED holding counters — the canonical
      // seam is one ledger, the lane fields below are the gaming detail.
      holding_posted: 2,
      holding_replayed: 0,
      gaming_written: 2,
      gaming_replayed: 0,
      gaming_accumulator_gross_micros: "115000000000000", // $1.15M counted
      gaming_engine_royalty_micros: "525000000000", // $5,250.00
      gaming_commission_micros: "13800000000000", // $108,000 + $30,000
      gaming_split_payouts: 2,
      gaming_split_replays: 0,
      gaming_royalty_payouts: 0,
      gaming_royalty_replays: 0,
      gaming_split_skipped_no_schedule: 0,
    });

    // The held credits: $792,000.00 and $214,750.00, integer cents.
    const held = await heldCredits(store);
    expect(held).toHaveLength(2);
    const byLineItem = new Map(held.map((row) => [row.line_item_id, row]));
    const line1 = byLineItem.get(`gaming:line:epic_games_store:${ingestId}:line:1`);
    const line2 = byLineItem.get(`gaming:line:unreal_marketplace:${ingestId}:line:2`);
    expect(line1?.amount_cents).toBe(79_200_000);
    expect(line2?.amount_cents).toBe(21_475_000);
    for (const credit of held) {
      expect(credit.payee_id).toBe(UNCLAIMED_HOLDING_PAYEE_ID);
      expect(credit.kind).toBe("unclaimed_holding");
      expect(Number.isSafeInteger(credit.amount_cents)).toBe(true);
    }

    // The GL journal per source event id — the replay guard's marker.
    for (const eventId of [
      `gaming:line:epic_games_store:${ingestId}:line:1`,
      `gaming:line:unreal_marketplace:${ingestId}:line:2`,
    ]) {
      const journals = await store.listGlJournalsByRef("match_queue", eventId);
      expect(journals).toHaveLength(1);
      expect(journals[0].kind).toBe("unclaimed_holding_post");
    }

    // The payout routings: the founder 50/30/20 over even cents, zero dust.
    const pack1 = await store.listGamingSplitPayouts("ITEM-SKIN-001");
    const pack2 = await store.listGamingSplitPayouts("ITEM-PROP-002");
    expect(pack1).toHaveLength(1);
    expect(pack2).toHaveLength(1);
    expect(pack1[0].source_amount_cents).toBe(79_200_000);
    expect(pack1[0].accruals.map((a) => a.amount_cents)).toEqual([
      39_600_000, 23_760_000, 15_840_000,
    ]);
    expect(pack1[0].company_dust_cents).toBe(0);
    expect(pack1[0].resale_royalty_cents).toBe(0);
    expect(pack1[0].split_version).toBe(1);
    expect(pack2[0].source_amount_cents).toBe(21_475_000);
    expect(pack2[0].company_dust_cents).toBe(0);
  });

  it("re-runs the SAME ingest through every replay guard — counted no-ops, zero new money", async () => {
    const store = new InMemoryStore();
    await registerSchedules(store, null);
    const ingestId = await seedGamingJob(store, "gaming_epic_sales.csv");

    const first = await runOnce({ store, vault: vaultWithDoi(), now: NOW });
    expect(first?.job.result?.holding_posted).toBe(2);

    // A crash-retry reruns the SAME ingest (same id) through a fresh job.
    await store.createReconJob({ source: "statement", ingest_id: ingestId });
    const replay = await runOnce({ store, vault: vaultWithDoi(), now: NOW });
    expect(replay?.job.result?.events_written).toBe(0); // queue rows already present
    expect(replay?.job.result?.gaming_written).toBe(0);
    expect(replay?.job.result?.gaming_replayed).toBe(2);
    // Nothing is even ATTEMPTED at the seam (unwritten outcomes skip), so
    // the replay counters stay at zero — no 409s, no double credits.
    expect(replay?.job.result?.holding_posted).toBe(0);
    expect(replay?.job.result?.holding_replayed).toBe(0);
    expect(replay?.job.result?.gaming_split_payouts).toBe(0);
    expect(replay?.job.result?.gaming_royalty_payouts).toBe(0);

    // Nothing doubled: still exactly two credits, two journals, two routings.
    expect(await heldCredits(store)).toHaveLength(2);
    expect(await store.listGamingSplitPayouts("ITEM-SKIN-001")).toHaveLength(1);
    const journals = await store.listGlJournalsByRef(
      "match_queue",
      `gaming:line:epic_games_store:${ingestId}:line:1`,
    );
    expect(journals).toHaveLength(1);

    // The replay DEDUCTED nothing (nothing posted), and the recorded
    // royalty was reused — never recomputed against moved totals.
    expect(replay?.job.result?.gaming_engine_royalty_micros).toBe("0");
  });
});

describe("the Roblox DevEx lane — exact conversion and the sub-cent quarantine", () => {
  it("posts the $245 net and quarantines the 1-Robux row's $0.00245", async () => {
    const store = new InMemoryStore();
    await registerSchedules(store, null);
    const { ingestId, result } = await runGamingFixture(store, "gaming_roblox_devex.csv");

    // Two lines written and matched; only the whole-cent net posts.
    expect(result?.events_written).toBe(2);
    expect(result?.matched).toBe(2);
    expect(result?.holding_posted).toBe(1);
    // 100,000 Robux × $0.0035 = $350 gross, 30% fee = $105 → $245 net.
    expect(result?.gaming_commission_micros).toBe("10500000000");
    expect(result?.gaming_engine_royalty_micros).toBe("0");

    // The held credit: exactly $245.00, integer cents, under the Roblox
    // line's content-derived event id.
    const held = await heldCredits(store);
    expect(held).toHaveLength(1);
    expect(held[0].line_item_id).toBe(`gaming:line:roblox:${ingestId}:line:1`);
    expect(held[0].amount_cents).toBe(24_500);

    // The rate logging: the queue rows keep the virtual operands verbatim.
    const rows = await queueRowsFor(store, ingestId);
    expect(rows).toHaveLength(2);
    expect(rows[0].virtual_currency_code).toBe("ROBUX");
    expect(rows[0].virtual_amount).toBe("100000");
    expect(rows[0].exchange_rate).toBe("0.0035");
    expect(rows[1].virtual_amount).toBe("1");

    // The routed payout: 24,500 cents across 50/30/20, zero dust. The
    // sub-cent row accrues nothing — no credit, no routing.
    const payouts = await store.listGamingSplitPayouts("ITEM-EMOTE-003");
    expect(payouts).toHaveLength(1);
    expect(payouts[0].source_amount_cents).toBe(24_500);
    expect(payouts[0].accruals.map((a) => a.amount_cents)).toEqual([
      12_250, 7_350, 4_900,
    ]);
    expect(payouts[0].company_dust_cents).toBe(0);
  });
});

describe("the secondary resale royalty — the original creator's own credit", () => {
  it("deducts the pool from the seller's net and posts it as a separate micro-payout", async () => {
    const store = new InMemoryStore();
    await registerSchedules(store, "payee-orig-creator");
    const { ingestId, result } = await runGamingFixture(store, "gaming_unity_payout.csv");

    // Row 1 is unmatched (no DOI) — written, never posted. Row 2 is the
    // secondary resale: the only posted seller credit + the royalty credit.
    expect(result?.events_written).toBe(2);
    expect(result?.matched).toBe(1);
    expect(result?.unmatched).toBe(1);
    expect(result?.holding_posted).toBe(1);
    expect(result?.gaming_royalty_payouts).toBe(1);
    expect(result?.gaming_split_payouts).toBe(1);
    expect(result?.gaming_split_skipped_no_schedule).toBe(0);

    // Two credits: the seller's $12.59 and the original creator's $1.39.
    const held = await heldCredits(store);
    expect(held).toHaveLength(2);
    const byLineItem = new Map(held.map((row) => [row.line_item_id, row]));
    const lineEventId = `gaming:line:unity_asset_store:${ingestId}:line:2`;
    const seller = byLineItem.get(lineEventId);
    const royalty = byLineItem.get(`gaming:royalty:${lineEventId}:payee-orig-creator`);
    expect(seller?.amount_cents).toBe(1_259); // $12.5937 floored
    expect(royalty?.amount_cents).toBe(139); // $1.3993 floored
    for (const credit of [seller, royalty]) {
      expect(credit?.payee_id).toBe(UNCLAIMED_HOLDING_PAYEE_ID);
      expect(credit?.kind).toBe("unclaimed_holding");
    }

    // The payout routing records the royalty decision: 139 cents routed to
    // the original creator, the 1,259-cent seller net across 50/30/20 with
    // the floor shares' 2-cent remainder swept as company dust.
    const payouts = await store.listGamingSplitPayouts("ITEM-PACK-020");
    expect(payouts).toHaveLength(1);
    expect(payouts[0].source_event_id).toBe(lineEventId);
    expect(payouts[0].source_amount_cents).toBe(1_259);
    expect(payouts[0].resale_royalty_payee_id).toBe("payee-orig-creator");
    expect(payouts[0].resale_royalty_cents).toBe(139);
    expect(payouts[0].accruals.map((a) => a.amount_cents)).toEqual([629, 377, 251]);
    expect(payouts[0].company_dust_cents).toBe(2);

    // The unmatched primary row wrote a queue row but accrued nothing.
    const rows = await queueRowsFor(store, ingestId);
    expect(rows[0].matched_cbt_code).toBeNull();
  });

  it("fails the accrual on a secondary sale whose item has NO schedule", async () => {
    const store = new InMemoryStore();
    // Every OTHER item gets a schedule — only the resale item is missing.
    for (const item of [
      "ITEM-SKIN-001",
      "ITEM-PROP-002",
      "ITEM-EMOTE-003",
      "ITEM-DLC-010",
      "ITEM-SCENE-030",
    ]) {
      await registerGamingItemSplitSchedule(
        store,
        { item_id: item, splits: defaultSplits(), resale_royalty_payee_id: null },
        NOW(),
      );
    }
    const { counts } = await seedAndPost(store, "gaming_unity_payout.csv");

    // The pool was deducted from the seller's credit at posting — skipping
    // the accrual would strand the royalty, so the job FAILS instead.
    let failure: unknown;
    try {
      await runGamingSplitAccrualPass(store, counts.lineOutcomes, NOW());
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(CanonicalPostingError);
    expect((failure as CanonicalPostingError).code).toBe(
      "gaming_schedule_missing_resale",
    );
    expect((failure as CanonicalPostingError).eventId).toMatch(
      /^gaming:line:unity_asset_store:/,
    );
  });

  it("fails the accrual on a secondary sale whose schedule has no resale payee", async () => {
    const store = new InMemoryStore();
    await registerSchedules(store, null); // ITEM-PACK-020 registered WITHOUT a payee
    const { counts } = await seedAndPost(store, "gaming_unity_payout.csv");

    let failure: unknown;
    try {
      await runGamingSplitAccrualPass(store, counts.lineOutcomes, NOW());
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(CanonicalPostingError);
    expect((failure as CanonicalPostingError).code).toBe(
      "gaming_resale_payee_missing",
    );
  });

  it("fails the accrual when the STORED schedule no longer balances", async () => {
    const store = new InMemoryStore();
    await registerSchedules(store, "payee-orig-creator");
    // Corrupt the stored row directly — bypassing the registration gate
    // (a hand edit, a migration accident). The accrual re-validates at use
    // time and refuses.
    await store.upsertGamingItemSplitSchedule({
      item_id: "ITEM-PACK-020",
      asset_cbt_code: null,
      splits: [
        { payee_id: "payee-studio-lead", payee_name: "Studio Lead", role: "creator", share_bps: 9000 },
        { payee_id: "payee-modeler", payee_name: "3D Modeler", role: "producer", share_bps: 0 },
        { payee_id: "payee-audio", payee_name: "Audio Designer", role: "other", share_bps: 0 },
      ],
      resale_royalty_payee_id: "payee-orig-creator",
      version: 9,
      created_at: NOW().toISOString(),
      updated_at: NOW().toISOString(),
    });
    const { counts } = await seedAndPost(store, "gaming_unity_payout.csv");

    let failure: unknown;
    try {
      await runGamingSplitAccrualPass(store, counts.lineOutcomes, NOW());
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(CanonicalPostingError);
    expect((failure as CanonicalPostingError).code).toBe(
      "gaming_split_schedule_invalid",
    );
  });
});

describe("the Steam and Apple lanes — pinned commissions at the ledger boundary", () => {
  it("posts the Steam $59.99 net of 30% as exactly $41.99", async () => {
    const store = new InMemoryStore();
    await registerSchedules(store, null);
    const { result } = await runGamingFixture(store, "gaming_steamworks.csv");
    expect(result?.holding_posted).toBe(1);
    expect(result?.gaming_commission_micros).toBe("1799700000"); // $17.997
    const held = await heldCredits(store);
    expect(held).toHaveLength(1);
    expect(held[0].amount_cents).toBe(4_199); // $41.993 floored — never rounded
    const payouts = await store.listGamingSplitPayouts("ITEM-DLC-010");
    expect(payouts[0].accruals.map((a) => a.amount_cents)).toEqual([2_099, 1_259, 839]);
    expect(payouts[0].company_dust_cents).toBe(2);
  });

  it("posts the Apple $9.99 sale at the 15% band floor as exactly $8.49", async () => {
    const store = new InMemoryStore();
    await registerSchedules(store, null);
    const { result } = await runGamingFixture(store, "gaming_apple_vision_pro.csv");
    expect(result?.holding_posted).toBe(1);
    expect(result?.gaming_commission_micros).toBe("149850000"); // $1.4985
    const held = await heldCredits(store);
    expect(held).toHaveLength(1);
    expect(held[0].amount_cents).toBe(849); // $8.4915 floored
  });
});

describe("the pass-level replay guards — crash-heal idempotency", () => {
  it("counts a second posting pass as alreadyPosted through the 409 guard", async () => {
    const store = new InMemoryStore();
    await registerSchedules(store, null);
    const { counts } = await seedAndWrite(store, "gaming_epic_sales.csv");

    const first = await postGamingLinesToHolding(store, counts.lineOutcomes, NOW());
    expect(first.posted).toBe(2);
    // A retry (the crash window): the seam's per-source journal-ref guard
    // counts the no-ops instead of double-crediting.
    const retry = await postGamingLinesToHolding(store, counts.lineOutcomes, NOW());
    expect(retry.posted).toBe(0);
    expect(retry.alreadyPosted).toBe(2);
    expect(await heldCredits(store)).toHaveLength(2);
  });

  it("counts a second accrual pass as replays — no double routings or royalties", async () => {
    const store = new InMemoryStore();
    await registerSchedules(store, "payee-orig-creator");
    const { counts } = await seedAndPost(store, "gaming_unity_payout.csv");

    const first = await runGamingSplitAccrualPass(store, counts.lineOutcomes, NOW());
    expect(first.payouts).toBe(1);
    expect(first.royaltiesPosted).toBe(1);
    expect(first.skippedNoSchedule).toBe(0);

    const second = await runGamingSplitAccrualPass(store, counts.lineOutcomes, NOW());
    expect(second.payouts).toBe(0);
    expect(second.replays).toBe(1);
    expect(second.royaltiesPosted).toBe(0);
    expect(second.royaltiesReplayed).toBe(1);

    // Still exactly one routing and two credits — the royalty never doubled.
    expect(await store.listGamingSplitPayouts("ITEM-PACK-020")).toHaveLength(1);
    expect(await heldCredits(store)).toHaveLength(2);
  });

  it("reports a primary line's missing schedule as an honest skip, not a failure", async () => {
    const store = new InMemoryStore();
    // Steam's fixture against an item with no registered schedule.
    const { counts } = await seedAndPost(store, "gaming_steamworks.csv");

    const accrual = await runGamingSplitAccrualPass(store, counts.lineOutcomes, NOW());
    expect(accrual.skippedNoSchedule).toBe(1);
    expect(accrual.payouts).toBe(0);
    // The holding credit stays intact for the manual-split release path.
    expect(await heldCredits(store)).toHaveLength(1);
  });
});
