/**
 * Three-backend parity for the podcast lane (PR 10) — the worker end-to-end
 * over InMemoryStore, SqliteStore, and SupabaseStore (behavioral fake).
 *
 * The scenario: DAI log ingested → IAB qualification → queue → holding;
 * then the RSS report into the SAME store (the cross-feed duplicate of the
 * DAI anchor must not double-count); then the DAI replay (counted no-ops).
 * Every backend must produce the identical result object and the identical
 * holding credits.
 */
import { describe, expect, it } from "vitest";

import { InMemoryStore } from "@/lib/server/inMemoryStore";
import { SqliteStore } from "@/lib/server/sqliteStore";
import type { Store } from "@/lib/server/store";
import { runOnce } from "../worker";
import type { VaultLookup } from "../matchQueue";
import type { ReconJobResult } from "@/modules/recon/records";
import { loadFixture } from "./fixtures";
import { makeFakeSupabaseStore } from "./fakeSupabase";

const NOW = () => new Date("2026-09-30T12:00:00Z");

const BACKENDS = [
  { name: "InMemoryStore", make: () => new InMemoryStore() },
  { name: "SqliteStore", make: () => new SqliteStore(":memory:") },
  {
    name: "SupabaseStore",
    make: () => makeFakeSupabaseStore(),
  },
] as const;

/** The verified podcast show — every fixture DOI resolves here. */
function vaultWithDoi(): VaultLookup {
  return {
    async findByIdentifier(kind, value) {
      if (kind === "DOI" && value === "10.61982/covenant.show-001") {
        return {
          cvtCode: "CVT-TEST-SHOW",
          cbtCode: "CBT-POD-SHOW-001",
          title: "Covenant Show 001",
          medium: "podcast",
          externalIdentifiers: { DOI: value },
          holderUct: null,
        };
      }
      return null;
    },
  };
}

async function ingestAndRun(store: Store, fixture: string) {
  const ingest = await store.insertStatementIngest({
    format: fixture === "podcast_dai_log.csv" ? "dai_log" : "rss_report",
    source: "statement",
    file_name: fixture,
    content: loadFixture(fixture),
    status: "parsed",
    event_count: null,
    error: null,
    created_at: NOW().toISOString(),
  });
  await store.createReconJob({ source: "statement", ingest_id: ingest.id });
  const processed = await runOnce({ store, vault: vaultWithDoi(), now: NOW });
  return { ingest, result: processed?.job.result };
}

interface PodcastScenarioOutcome {
  daiCounts: ReconJobResult | null | undefined;
  rssCounts: ReconJobResult | null | undefined;
  replayCounts: ReconJobResult | null | undefined;
  /** All holding credits after the DAI + RSS passes, sorted by cents. */
  creditsAfterBoth: Array<{
    amount_cents: number;
    currency: string;
    kind: string;
    status: string;
  }>;
  creditsAfterReplay: number;
  /** The RSS subscription row's queue event id (ingest id normalized). */
  subscriptionEventId: string;
}

/** The identical scenario script every backend must run to the same result. */
async function podcastScenario(store: Store): Promise<PodcastScenarioOutcome> {
  // Pass 1 — the DAI log: 8 qualified of 13, 2 posts (1¢ + 3¢).
  const dai = await ingestAndRun(store, "podcast_dai_log.csv");

  // Pass 2 — the RSS report into the same store: 4 written, 1 cross-feed
  // replay (the DAI anchor), 1 held, 3 posts (2,500¢ + 499¢ + 1¢).
  const rss = await ingestAndRun(store, "podcast_rss_report.csv");

  const creditsAfterBoth = (await store.listUnclaimedHoldingCredits(100))
    .map((row) => ({
      amount_cents: row.amount_cents,
      currency: row.currency,
      kind: row.kind,
      status: row.status,
    }))
    .sort((a, b) => a.amount_cents - b.amount_cents);

  // Pass 3 — the DAI log replayed: nothing written, nothing posted, all
  // counts honest no-ops.
  await store.createReconJob({
    source: "statement",
    ingest_id: dai.ingest.id,
  });
  const replay = await runOnce({ store, vault: vaultWithDoi(), now: NOW });
  const creditsAfterReplay = (await store.listUnclaimedHoldingCredits(100)).length;

  // The subscription event id embeds the per-backend random ingest id —
  // normalize it so the parity comparison compares identity spaces, not
  // id-generation trivia.
  const rssOpenRows = await store.listMatchQueueEntries("open", 500);
  const subscriptionEventId =
    rssOpenRows
      .map((row) => row.event_id)
      .find((id) => id.startsWith("podcast:sub:"))
      ?.replace(rss.ingest.id, "<ingest-id>") ?? "missing";

  return {
    daiCounts: dai.result,
    rssCounts: rss.result,
    replayCounts: replay?.job.result,
    creditsAfterBoth,
    creditsAfterReplay,
    subscriptionEventId,
  };
}

/** The podcast lane's flat completion fields (the ReconJobResult vocabulary). */
const DAI_PODCAST_FIELDS = {
  podcast_written: 8,
  podcast_replayed: 0,
  podcast_held: 0,
  podcast_bots_filtered: 2,
  podcast_duplicates_deduped: 2,
  podcast_short_requests_rejected: 1,
  podcast_commission_micros: "0",
};

/**
 * The PR 11 split/bonus pass counters. This scenario registers no episode
 * schedules and no bonus definitions, so the pass runs fail-closed and
 * accrues nothing — counted skips, zeros on every backend, replay included.
 */
const SPLIT_BONUS_FIELDS = {
  podcast_split_accruals: 0,
  podcast_split_replays: 0,
  podcast_bonus_accrued: 0,
  podcast_bonus_replayed: 0,
};

const RSS_PODCAST_FIELDS = {
  podcast_written: 4,
  podcast_replayed: 1,
  podcast_held: 1,
  podcast_bots_filtered: 1,
  podcast_duplicates_deduped: 0,
  podcast_short_requests_rejected: 1,
  podcast_commission_micros: "0",
};

const EXPECTED: PodcastScenarioOutcome = {
  daiCounts: {
    events_written: 8,
    matched: 8,
    unmatched: 0,
    engine_used: null,
    holding_posted: 2,
    holding_replayed: 0,
    ...DAI_PODCAST_FIELDS,
    ...SPLIT_BONUS_FIELDS,
  },
  rssCounts: {
    events_written: 4,
    matched: 5,
    unmatched: 0,
    engine_used: null,
    holding_posted: 3,
    holding_replayed: 0,
    ...RSS_PODCAST_FIELDS,
    ...SPLIT_BONUS_FIELDS,
  },
  replayCounts: {
    events_written: 0,
    matched: 8,
    unmatched: 0,
    engine_used: null,
    holding_posted: 0,
    holding_replayed: 0,
    ...DAI_PODCAST_FIELDS,
    ...SPLIT_BONUS_FIELDS,
    // The queue refuses every row (all replayed); the IAB rejections are
    // per-batch engine counts, so they re-appear unchanged on the replay.
    podcast_written: 0,
    podcast_replayed: 8,
  },
  creditsAfterBoth: [
    { amount_cents: 1, currency: "USD", kind: "unclaimed_holding", status: "unclaimed_holding" },
    { amount_cents: 1, currency: "USD", kind: "unclaimed_holding", status: "unclaimed_holding" },
    { amount_cents: 3, currency: "USD", kind: "unclaimed_holding", status: "unclaimed_holding" },
    { amount_cents: 499, currency: "USD", kind: "unclaimed_holding", status: "unclaimed_holding" },
    { amount_cents: 25000, currency: "USD", kind: "unclaimed_holding", status: "unclaimed_holding" },
  ],
  creditsAfterReplay: 5,
  subscriptionEventId: "podcast:sub:<ingest-id>:line:3",
};

describe("podcast lane parity across all three backends", () => {
  for (const backend of BACKENDS) {
    it(`runs the identical podcast scenario to the identical result on ${backend.name}`, async () => {
      const outcome = await podcastScenario(backend.make());
      expect(outcome).toEqual(EXPECTED);
    });
  }
});
