/**
 * The podcast split/bonus accrual passes (PR 11) — three-backend parity.
 * The identical scenario script runs on InMemoryStore, SqliteStore
 * (:memory:), and SupabaseStore over the behavioral PostgREST fake:
 *
 *   register an episode's split schedule (then re-register — the version
 *   bumps, history never rewrites) → register a downloads milestone → seed
 *   the verified queue rows (impressions, subscription, a held row, and a
 *   foreign episode's row) → run the accrual pass over the postable line
 *   outcomes → assert the per-holder routing exact to the cent, the
 *   milestone's once-only holding credit, the honest no-schedule skip →
 *   replay the identical pass (counted no-ops, no double pay) → fire the
 *   reach milestone on the lifetime verified totals → fail-closed: the
 *   crash-recovery state (accrual lock missing, the first pass's journal
 *   ref still present) refuses the bonus post, releases the lock, and
 *   throws.
 *
 * Every backend must produce the identical normalized snapshot.
 */
import { describe, expect, it } from "vitest";

import { InMemoryStore } from "@/lib/server/inMemoryStore";
import { SqliteStore } from "@/lib/server/sqliteStore";
import type { Store } from "@/lib/server/store";
import { makeFakeSupabaseStore } from "@/workers/recon/__tests__/fakeSupabase";
import type { ParsedStatementLine, PodcastLineDetail } from "@/workers/recon/records";
import { CanonicalPostingError } from "@/workers/recon/posting";
import { buildPodcastQueueRow } from "@/workers/recon/podcastQueue";
import type { PodcastLineOutcome } from "@/workers/recon/podcastQueue";
import {
  ensureGuestMilestoneBonuses,
  registerEpisodeSplitSchedule,
  registerGuestBonusDefinition,
  runPodcastSplitBonusPass,
  type PodcastSplitBonusCounts,
} from "../accrual";
import type { SplitPartyInput } from "@/lib/don/types";

const NOW = () => new Date("2026-09-30T12:00:00Z");
const NOW_ISO = NOW().toISOString();

const HOST: SplitPartyInput = {
  payee_id: "payee_host",
  payee_name: "The Host",
  role: "creator",
  share_bps: 6000,
};
const CO_HOST: SplitPartyInput = {
  payee_id: "payee_co_host",
  payee_name: "The Co-Host",
  role: "producer",
  share_bps: 3000,
};
const EDITOR: SplitPartyInput = {
  payee_id: "payee_editor",
  payee_name: "The Editor",
  role: "other",
  share_bps: 1000,
};

function makePodcastLine(
  episodeId: string,
  grossMicros: bigint,
  revenueChannel: PodcastLineDetail["revenueChannel"],
  impressions: number,
): ParsedStatementLine {
  return {
    lineNumber: 1,
    profile: "podcast_dai_log_csv",
    rightsType: "master",
    statementSourceType: null,
    tierLevel: null,
    rightsPipeline: "master_digital_performance",
    period: null,
    currency: "USD",
    grossMicros,
    isAdjustment: false,
    identifiers: {},
    workTitle: null,
    territory: null,
    platform: null,
    usageNote: "podcast test line",
    raw: [],
    guildResidual: null,
    podcastDetail: {
      rssFeedId: "feed-1",
      episodeId,
      adCreativeId: "ad-1",
      listenerIp: "203.0.113.9",
      userAgent: "test-agent",
      requestedAt: NOW(),
      revenueChannel,
      adSlot: "pre_roll",
      adPlacementType: "dai",
      networkSold: null,
      sponsorVerified: true,
      audioSeconds: 120,
      cpmMicros: null,
      impressions,
      commissionBps: null,
    },
    gamingDetail: null,
    livestreamDetail: null,
  };
}

function makeImpressionOutcome(
  eventId: string,
  episodeId: string,
  grossMicros: bigint,
): PodcastLineOutcome {
  const line = makePodcastLine(episodeId, grossMicros, "channel_a_dai", 2);
  const row = buildPodcastQueueRow(line, eventId, "recon:test", "CBT-POD-SHOW-001");
  return {
    line,
    eventId,
    matchedCbtCode: "CBT-POD-SHOW-001",
    written: true,
    commissionMicros: row.platform_commission_micros ?? "0",
  };
}

/** Seeds the verified-count scan's queue rows: the lifetime episode audience. */
async function seedVerifiedQueue(store: Store, ingestId: string): Promise<void> {
  const rows: Array<{ eventId: string; episodeId: string; impressions: number }> = [
    { eventId: `podcast:imp:${ingestId}:line:1`, episodeId: "ep-1", impressions: 2 },
    { eventId: `podcast:imp:${ingestId}:line:2`, episodeId: "ep-1", impressions: 2 },
    // Channel C — counts for reach, not for downloads.
    { eventId: `podcast:sub:${ingestId}:line:3`, episodeId: "ep-1", impressions: 1 },
    // A held host-read — quarantined, never counted, never posted.
    { eventId: `podcast:held:${ingestId}:line:4`, episodeId: "ep-1", impressions: 9 },
    // A different episode's row — never counts toward ep-1's totals.
    { eventId: `podcast:imp:${ingestId}:line:5`, episodeId: "ep-other", impressions: 4 },
  ];
  for (const { eventId, episodeId, impressions } of rows) {
    const channel = eventId.startsWith("podcast:sub:")
      ? "channel_c_subscription"
      : "channel_a_dai";
    const line = makePodcastLine(
      episodeId,
      1_000_000n,
      channel as PodcastLineDetail["revenueChannel"],
      impressions,
    );
    await store.insertMatchQueueEntry(
      buildPodcastQueueRow(line, eventId, "recon:test", "CBT-POD-SHOW-001"),
    );
  }
}

/** The scenario's outcome, normalized for cross-backend deep equality. */
interface AccrualScenarioSnapshot {
  schedule: {
    episode_id: string;
    splits: SplitPartyInput[];
    version: number;
    created_at: string;
    updated_at: string;
  };
  countsFirstPass: PodcastSplitBonusCounts;
  countsReplay: PodcastSplitBonusCounts;
  countsReach: PodcastSplitBonusCounts;
  /** The split accrual rows (ids stripped — random per backend). */
  splitAccruals: Array<{
    episode_id: string;
    source_event_id: string;
    source_amount_cents: number;
    split_version: number;
    accruals: Array<SplitPartyInput & { amount_cents: number }>;
    company_dust_cents: number;
    created_at: string;
  }>;
  /** The bonus accrual rows, definition ids normalized to their role. */
  bonusAccruals: Array<{
    event_id: string;
    episode_id: string;
    definition: string;
    guest_payee_id: string;
    milestone_kind: string;
    threshold: number;
    verified_count: number;
    bonus_amount_cents: number;
    status: string;
    holding_ledger_id: string | null;
  }>;
  /** The unclaimed holding credits the bonuses posted, sorted by cents. */
  holdingCredits: Array<{
    amount_cents: number;
    currency: string;
    kind: string;
    status: string;
    line_item_id: string;
  }>;
  failClosed: {
    threwCanonicalPostingError: boolean;
    errorCode: string;
    accrualLockReleased: boolean;
  };
}

async function accrualScenario(store: Store): Promise<AccrualScenarioSnapshot> {
  // Registration: version 1, then re-registration bumps to version 2 —
  // history is never rewritten (existing created_at survives).
  const v1 = await registerEpisodeSplitSchedule(
    store,
    { episode_id: "ep-1", show_cbt_code: "CBT-POD-SHOW-001", splits: [HOST, CO_HOST, EDITOR] },
    NOW(),
  );
  expect(v1.version).toBe(1);
  const schedule = await registerEpisodeSplitSchedule(
    store,
    { episode_id: "ep-1", show_cbt_code: "CBT-POD-SHOW-001", splits: [HOST, CO_HOST, EDITOR] },
    NOW(),
  );
  expect(schedule.version).toBe(2);
  expect(schedule.created_at).toBe(v1.created_at);

  // The downloads milestone: 500¢ when the episode's verified downloads
  // cross 3. Bonus definitions ride through the same engine gate.
  const downloadsBonus = await registerGuestBonusDefinition(
    store,
    "ep-1",
    {
      guest_payee_id: "payee_guest",
      guest_payee_name: "The Guest",
      milestone_kind: "downloads",
      threshold: 3,
      bonus_amount_cents: 500,
      currency: "USD",
    },
    NOW(),
  );

  // The verified queue: 4 downloads (2+2 imp rows), 5 reach (+1 sub), the
  // held row and the foreign episode row never count.
  await seedVerifiedQueue(store, "ingest-1");

  // One postable line for ep-1 (1000¢ net) + one for ep-other, whose
  // episode has NO registered schedule — an honest skip, never an invented
  // default. A sub-cent line contributes nothing (no holding credit to
  // route) and never appears in the skip count.
  const outcomes: PodcastLineOutcome[] = [
    makeImpressionOutcome("podcast:imp:ingest-1:line:1", "ep-1", 1_000_000_000n),
    makeImpressionOutcome("podcast:imp:ingest-1:line:2", "ep-other", 1_000_000_000n),
    makeImpressionOutcome("podcast:imp:ingest-1:line:9", "ep-1", 50n),
  ];

  const countsFirstPass = await runPodcastSplitBonusPass(store, outcomes, NOW());
  expect(countsFirstPass).toEqual({
    splitAccruals: 1,
    splitReplays: 0,
    splitSkippedNoSchedule: 1,
    bonusAccrued: 1,
    bonusReplayed: 0,
  });

  // THE REPLAY — the identical episode data re-run: the split accrual and
  // the milestone bonus are counted no-ops. Exactly one of each exists; the
  // holding credit is never doubled.
  const countsReplay = await runPodcastSplitBonusPass(store, outcomes, NOW());
  expect(countsReplay).toEqual({
    splitAccruals: 0,
    splitReplays: 1,
    splitSkippedNoSchedule: 1,
    bonusAccrued: 0,
    bonusReplayed: 1,
  });

  // The reach milestone (threshold 5, lifetime verified 5) — fired on the
  // episode's LIFETIME totals over imp + sub rows, prior ingests included.
  const reachBonus = await registerGuestBonusDefinition(
    store,
    "ep-1",
    {
      guest_payee_id: "payee_guest",
      guest_payee_name: "The Guest",
      milestone_kind: "reach",
      threshold: 5,
      bonus_amount_cents: 700,
      currency: "USD",
    },
    NOW(),
  );
  const countsReach = await runPodcastSplitBonusPass(store, outcomes, NOW());
  expect(countsReach).toEqual({
    splitAccruals: 0,
    splitReplays: 1,
    splitSkippedNoSchedule: 1,
    bonusAccrued: 1,
    bonusReplayed: 1,
  });

  const definitionRole = new Map<string, string>([
    [downloadsBonus.id, "downloads-bonus"],
    [reachBonus.id, "reach-bonus"],
  ]);
  const bonusAccrualsBefore = await store.listPodcastGuestBonusAccruals("ep-1");
  const normalizedBonusAccruals = bonusAccrualsBefore.map((row) => ({
    event_id: row.event_id.replace(
      row.bonus_definition_id,
      definitionRole.get(row.bonus_definition_id) ?? "<def>",
    ),
    episode_id: row.episode_id,
    definition: definitionRole.get(row.bonus_definition_id) ?? "<def>",
    guest_payee_id: row.guest_payee_id,
    milestone_kind: row.milestone_kind,
    threshold: row.threshold,
    verified_count: row.verified_count,
    bonus_amount_cents: row.bonus_amount_cents,
    status: row.status,
    holding_ledger_id: row.holding_ledger_id === null ? null : "<ledger-id>",
  }));

  // FAIL-CLOSED, the crash-recovery shape: the accrual lock is missing but
  // the first pass's GL journal ref still names the bonus event id. The
  // pass re-derives the crossing, re-inserts the lock, and the post
  // REFUSES (one post per source id, the PR #89 seam's guard) — the lock
  // is deleted (retryable) and the pass throws. Never silent, never a
  // paid bonus without a posted credit.
  await store.deletePodcastGuestBonusAccrual(
    bonusAccrualsBefore.find((row) => row.bonus_definition_id === downloadsBonus.id)?.id ??
      "missing",
  );
  let threwCanonicalPostingError = false;
  let errorCode = "";
  try {
    await ensureGuestMilestoneBonuses(store, outcomes, NOW());
  } catch (error) {
    if (error instanceof CanonicalPostingError) {
      threwCanonicalPostingError = true;
      errorCode = error.code;
    } else {
      throw error;
    }
  }
  const accrualLockReleased =
    (await store.listPodcastGuestBonusAccruals("ep-1")).filter(
      (row) => row.bonus_definition_id === downloadsBonus.id,
    ).length === 0;

  const holdingCredits = (await store.listUnclaimedHoldingCredits(100))
    .map((row) => ({
      amount_cents: row.amount_cents,
      currency: row.currency,
      kind: row.kind,
      status: row.status,
      line_item_id: row.line_item_id.replace(
        /^podcast:bonus:ep-1:[^:]+:/,
        "podcast:bonus:ep-1:<def>:",
      ),
    }))
    .sort((a, b) => a.amount_cents - b.amount_cents);

  return {
    schedule: {
      episode_id: schedule.episode_id,
      splits: schedule.splits,
      version: schedule.version,
      created_at: schedule.created_at,
      updated_at: schedule.updated_at,
    },
    countsFirstPass,
    countsReplay,
    countsReach,
    splitAccruals: (await store.listPodcastEpisodeSplitAccruals("ep-1")).map(
      ({ id: _id, ...rest }) => rest,
    ),
    bonusAccruals: normalizedBonusAccruals,
    holdingCredits,
    failClosed: {
      threwCanonicalPostingError,
      errorCode,
      accrualLockReleased,
    },
  };
}

/** The expected snapshot every backend must reproduce. */
const EXPECTED_SNAPSHOT: AccrualScenarioSnapshot = {
  schedule: {
    episode_id: "ep-1",
    splits: [HOST, CO_HOST, EDITOR],
    version: 2,
    created_at: NOW_ISO,
    updated_at: NOW_ISO,
  },
  countsFirstPass: {
    splitAccruals: 1,
    splitReplays: 0,
    splitSkippedNoSchedule: 1,
    bonusAccrued: 1,
    bonusReplayed: 0,
  },
  countsReplay: {
    splitAccruals: 0,
    splitReplays: 1,
    splitSkippedNoSchedule: 1,
    bonusAccrued: 0,
    bonusReplayed: 1,
  },
  countsReach: {
    splitAccruals: 0,
    splitReplays: 1,
    splitSkippedNoSchedule: 1,
    bonusAccrued: 1,
    bonusReplayed: 1,
  },
  splitAccruals: [
    {
      episode_id: "ep-1",
      source_event_id: "podcast:imp:ingest-1:line:1",
      source_amount_cents: 1000,
      split_version: 2,
      // Floor shares exact to the cent; the 1000¢ amount is clean — dust 0.
      accruals: [
        { ...HOST, amount_cents: 600 },
        { ...CO_HOST, amount_cents: 300 },
        { ...EDITOR, amount_cents: 100 },
      ],
      company_dust_cents: 0,
      created_at: NOW_ISO,
    },
  ],
  bonusAccruals: [
    {
      event_id: "podcast:bonus:ep-1:downloads-bonus:3",
      episode_id: "ep-1",
      definition: "downloads-bonus",
      guest_payee_id: "payee_guest",
      milestone_kind: "downloads",
      threshold: 3,
      verified_count: 4,
      bonus_amount_cents: 500,
      status: "posted",
      holding_ledger_id: "<ledger-id>",
    },
    {
      event_id: "podcast:bonus:ep-1:reach-bonus:5",
      episode_id: "ep-1",
      definition: "reach-bonus",
      guest_payee_id: "payee_guest",
      milestone_kind: "reach",
      threshold: 5,
      verified_count: 5,
      bonus_amount_cents: 700,
      status: "posted",
      holding_ledger_id: "<ledger-id>",
    },
  ],
  holdingCredits: [
    {
      amount_cents: 500,
      currency: "USD",
      kind: "unclaimed_holding",
      status: "unclaimed_holding",
      line_item_id: "podcast:bonus:ep-1:<def>:3",
    },
    {
      amount_cents: 700,
      currency: "USD",
      kind: "unclaimed_holding",
      status: "unclaimed_holding",
      line_item_id: "podcast:bonus:ep-1:<def>:5",
    },
  ],
  failClosed: {
    threwCanonicalPostingError: true,
    errorCode: "unclaimed_holding_already_posted",
    accrualLockReleased: true,
  },
};

const BACKENDS = [
  { name: "InMemoryStore", make: () => new InMemoryStore() },
  { name: "SqliteStore", make: () => new SqliteStore(":memory:") },
  { name: "SupabaseStore", make: () => makeFakeSupabaseStore() },
] as const;

describe("podcast split/bonus accrual parity across all three backends", () => {
  for (const backend of BACKENDS) {
    it(`runs the identical accrual scenario to the identical snapshot on ${backend.name}`, async () => {
      const snapshot = await accrualScenario(backend.make());
      expect(snapshot).toEqual(EXPECTED_SNAPSHOT);
    });
  }
});
