// Livestream lane — THREE-BACKEND PARITY (the task's locked bar).
//
// The identical worker scenario — a Twitch payout statement (Bits
// conversion, a subscription, a CPM sponsor banner) seeded as an ingest +
// recon job, one runOnce pass, then a replay pass — runs against
// InMemoryStore, SqliteStore (real better-sqlite3, :memory:), and
// SupabaseStore over the behavioral PostgREST fake, and every backend must
// produce the same observable outcome: the same parse/match counts, the
// same conversion-log and replay counters, the same held credits (integer
// cents, per-event linkage), the same journals, and the same post-replay
// holding state. The lane rides only Store-interface methods, so parity is
// the PROOF that no backend drifts on the livestream path.
import { describe, expect, it } from "vitest";

import { InMemoryStore } from "@/lib/server/inMemoryStore";
import { SqliteStore } from "@/lib/server/sqliteStore";
import type { Store } from "@/lib/server/store";
import type { ReconJobResult } from "@/modules/recon/records";
import { runOnce } from "../worker";
import type { VaultLookup } from "../matchQueue";

import { loadFixture } from "./fixtures";
import { makeFakeSupabaseStore } from "./fakeSupabase";

const BACKENDS = [
  { name: "InMemoryStore", make: () => new InMemoryStore() },
  { name: "SqliteStore", make: () => new SqliteStore(":memory:") },
  {
    name: "SupabaseStore",
    make: () => makeFakeSupabaseStore(),
  },
] as const;

const NOW = () => new Date("2026-10-01T12:00:00Z");

function vaultWithChannelDoi(): VaultLookup {
  return {
    async findByIdentifier(kind, value) {
      if (kind === "DOI" && value === "10.61982/covenant.channel-001") {
        return {
          cvtCode: "CVT-TEST-CHANNEL",
          cbtCode: "CBT-LIV-TESTCHANNEL",
          title: "Founder's Twitch Channel",
          medium: "stream_platform",
          externalIdentifiers: { DOI: value },
          holderUct: null,
        };
      }
      return null;
    },
  };
}

interface ScenarioOutcome {
  counts: ReconJobResult | null | undefined;
  replayCounts: ReconJobResult | null | undefined;
  /** Held credits projected to the parity-comparable shape (ids stripped). */
  held: Array<{
    line_item_id: string;
    payee_id: string;
    amount_cents: number;
    currency: string;
    kind: string;
    status: string;
  }>;
  replayHeldLength: number;
  journals: number;
  openQueueRows: Array<{ event_id: string; matched_cbt_code: string | null; status: string }>;
}

/** The identical scenario script every backend must run to the same result. */
async function livestreamScenario(store: Store): Promise<ScenarioOutcome> {
  const ingest = await store.insertStatementIngest({
    format: "csv_statement",
    source: "statement",
    file_name: "twitch_payouts.csv",
    content: loadFixture("livestream_twitch_payouts.csv"),
    status: "parsed",
    event_count: null,
    error: null,
    created_at: NOW().toISOString(),
  });
  await store.createReconJob({ source: "statement", ingest_id: ingest.id });

  const processed = await runOnce({ store, vault: vaultWithChannelDoi(), now: NOW });
  const held = (await store.listUnclaimedHoldingCredits(100)).map((row) => ({
    // Normalize the per-backend random ingest id out of the linkage.
    line_item_id: row.line_item_id.replace(ingest.id, "<ingest-id>"),
    payee_id: row.payee_id,
    amount_cents: row.amount_cents,
    currency: row.currency,
    kind: row.kind,
    status: row.status,
  }));
  // The lane's journals reference the queue row's event id — the per-event
  // replay guard's link.
  const journals = await store.listGlJournalsByRef(
    "match_queue",
    `livestream:line:twitch:${ingest.id}:line:1`,
  );

  // The replay pass — the per-source guard must read the same on every
  // backend: counted no-ops, no new credits.
  await store.createReconJob({ source: "statement", ingest_id: ingest.id });
  const replay = await runOnce({ store, vault: vaultWithChannelDoi(), now: NOW });
  const replayHeldLength = (await store.listUnclaimedHoldingCredits(100)).length;

  const openQueueRows = (await store.listMatchQueueEntries("open", 500))
    .filter((row) => row.event_id.startsWith(`livestream:line:twitch:${ingest.id}:`))
    .map((row) => ({
      event_id: row.event_id.replace(ingest.id, "<ingest-id>"),
      matched_cbt_code: row.matched_cbt_code,
      status: row.status,
    }))
    .sort((a, b) => a.event_id.localeCompare(b.event_id));

  return {
    counts: processed?.job.result,
    replayCounts: replay?.job.result,
    held: held.sort((a, b) => a.line_item_id.localeCompare(b.line_item_id)),
    replayHeldLength,
    journals: journals.length,
    openQueueRows,
  };
}

const EXPECTED: ScenarioOutcome = {
  counts: {
    events_written: 3,
    matched: 3,
    unmatched: 0,
    engine_used: null,
    holding_posted: 3,
    holding_replayed: 0,
    livestream_conversions_logged: 1,
    livestream_conversions_replayed: 0,
    livestream_platform_fee_micros: "0",
    livestream_prize_pool_locked_cents: 0,
    livestream_prize_pools_locked: 0,
    livestream_prize_pools_replayed: 0,
    livestream_replayed: 0,
    livestream_written: 3,
  } as ReconJobResult,
  replayCounts: {
    events_written: 0,
    // The replay re-reads the surviving queue rows and re-counts their DOI
    // cross-reference — the match state is still there, no new row is.
    matched: 3,
    unmatched: 0,
    engine_used: null,
    holding_posted: 0,
    // The queue layer's alreadyPresent guard refuses the re-writes, and the
    // posting pass never resurrects a refused write — the money seam is not
    // even reached on replay, so zero post-level replays are counted.
    holding_replayed: 0,
    livestream_conversions_logged: 0,
    livestream_conversions_replayed: 0,
    livestream_platform_fee_micros: "0",
    livestream_prize_pool_locked_cents: 0,
    livestream_prize_pools_locked: 0,
    livestream_prize_pools_replayed: 0,
    livestream_replayed: 3,
    livestream_written: 0,
  } as ReconJobResult,
  held: [
    {
      line_item_id: "livestream:line:twitch:<ingest-id>:line:1",
      payee_id: "unclaimed",
      amount_cents: 500, // 500 bits × $0.01 = $5.00
      currency: "USD",
      kind: "unclaimed_holding",
      status: "unclaimed_holding",
    },
    {
      line_item_id: "livestream:line:twitch:<ingest-id>:line:2",
      payee_id: "unclaimed",
      amount_cents: 999, // the Tier-2 sub's $9.99
      currency: "USD",
      kind: "unclaimed_holding",
      status: "unclaimed_holding",
    },
    {
      line_item_id: "livestream:line:twitch:<ingest-id>:line:3",
      payee_id: "unclaimed",
      amount_cents: 2500, // 10,000 impressions × $2.50 CPM = $25.00
      currency: "USD",
      kind: "unclaimed_holding",
      status: "unclaimed_holding",
    },
  ],
  replayHeldLength: 3,
  journals: 1,
  openQueueRows: [
    {
      event_id: "livestream:line:twitch:<ingest-id>:line:1",
      matched_cbt_code: "CBT-LIV-TESTCHANNEL",
      status: "open",
    },
    {
      event_id: "livestream:line:twitch:<ingest-id>:line:2",
      matched_cbt_code: "CBT-LIV-TESTCHANNEL",
      status: "open",
    },
    {
      event_id: "livestream:line:twitch:<ingest-id>:line:3",
      matched_cbt_code: "CBT-LIV-TESTCHANNEL",
      status: "open",
    },
  ],
};

describe("the livestream lane — three-backend parity", () => {
  for (const backend of BACKENDS) {
    it(`runs the identical scenario to the identical outcome on ${backend.name}`, async () => {
      const outcome = await livestreamScenario(backend.make());
      expect(outcome).toEqual(EXPECTED);
    });
  }
});
