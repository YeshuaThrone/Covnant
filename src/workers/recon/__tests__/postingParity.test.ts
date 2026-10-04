/**
 * Canonical posting seam — THREE-BACKEND PARITY (the task's locked bar).
 *
 * The identical worker scenario — seed ingest + job, run the posting pass
 * against a matching vault, replay it — runs against InMemoryStore,
 * SqliteStore (real better-sqlite3, :memory:), and SupabaseStore over a
 * behavioral PostgREST fake, and every backend must produce the same
 * observable outcome: the same completion counts, the same held credits
 * (sentinel payee, exact integer cents, per-event line-item linkage), the
 * same one-journal-per-source replay-guard state, and the same open queue
 * rows. The posting seam rides only Store-interface methods, so parity is
 * the PROOF that no backend drifts.
 *
 * The fake implements the builder vocabulary SupabaseStore uses on this
 * path (from/insert/update/select/eq/in/order/limit/maybeSingle), the
 * match_queue.event_id unique violation, and the migration-0011 claim RPC
 * (`claim_royalty_recon_job`) as a behavioral shim mirroring the local
 * stores' claim semantics (earliest claimable, attempts increment).
 */
import { describe, expect, it } from "vitest";

import { InMemoryStore } from "@/lib/server/inMemoryStore";
import { SqliteStore } from "@/lib/server/sqliteStore";
import type { Store } from "@/lib/server/store";
import type { ReconJobResult } from "@/modules/recon/records";
import { runOnce } from "../worker";
import type { VaultLookup } from "../matchQueue";

import { loadFixture } from "./fixtures";
import { makeFakeSupabaseStore } from "./fakeSupabase";

// ---------------------------------------------------------------------------
// Backend registry + the shared scenario.
// ---------------------------------------------------------------------------

const BACKENDS = [
  { name: "InMemoryStore", make: () => new InMemoryStore() },
  { name: "SqliteStore", make: () => new SqliteStore(":memory:") },
  {
    name: "SupabaseStore",
    make: () => makeFakeSupabaseStore(),
  },
] as const;

const NOW = () => new Date("2026-09-30T12:00:00Z");

function vaultWithIsrc(): VaultLookup {
  return {
    async findByIdentifier(kind, value) {
      if (kind === "ISRC" && (value === "US-XYT-26-00001" || value === "USXYT2600001")) {
        return {
          cvtCode: "CVT-TEST-TRACK",
          cbtCode: "CBT-MUS-TESTTRACK",
          title: "Neon Skyline",
          medium: "music",
          externalIdentifiers: { ISRC: value },
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
async function postingScenario(store: Store): Promise<ScenarioOutcome> {
  const ingest = await store.insertStatementIngest({
    format: "csv_statement",
    source: "statement",
    file_name: "distrokid.csv",
    content: loadFixture("distrokid.csv"),
    status: "parsed",
    event_count: null,
    error: null,
    created_at: NOW().toISOString(),
  });
  await store.createReconJob({ source: "statement", ingest_id: ingest.id });

  const processed = await runOnce({ store, vault: vaultWithIsrc(), now: NOW });
  const held = (await store.listUnclaimedHoldingCredits(100)).map((row) => ({
    // Normalize the per-backend random ingest id out of the linkage.
    line_item_id: row.line_item_id.replace(ingest.id, "<ingest-id>"),
    payee_id: row.payee_id,
    amount_cents: row.amount_cents,
    currency: row.currency,
    kind: row.kind,
    status: row.status,
  }));
  const journals = await store.listGlJournalsByRef("match_queue", `recon:${ingest.id}:line:1`);

  // The replay pass — the per-source guard must read the same on every
  // backend: counted no-ops, no new credits.
  await store.createReconJob({ source: "statement", ingest_id: ingest.id });
  const replay = await runOnce({ store, vault: vaultWithIsrc(), now: NOW });
  const replayHeldLength = (await store.listUnclaimedHoldingCredits(100)).length;

  const openQueueRows = (await store.listMatchQueueEntries("open", 500))
    .filter((row) => row.event_id.startsWith(`recon:${ingest.id}:`))
    .map((row) => ({
      event_id: row.event_id.replace(ingest.id, "<ingest-id>"),
      matched_cbt_code: row.matched_cbt_code,
      status: row.status,
    }))
    // List ordering (created_at desc) is a per-backend presentation detail —
    // compare the SET of rows, not the read order.
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
    events_written: 2,
    matched: 2,
    unmatched: 0,
    engine_used: null,
    holding_posted: 2,
    holding_replayed: 0,
    identifier_hold_posted: 0,
    identifier_hold_replayed: 0,
  },
  replayCounts: {
    events_written: 0,
    matched: 0,
    unmatched: 0,
    engine_used: null,
    holding_posted: 0,
    holding_replayed: 2,
    identifier_hold_posted: 0,
    identifier_hold_replayed: 0,
  },
  held: [
    {
      line_item_id: "recon:<ingest-id>:line:1",
      payee_id: "unclaimed",
      amount_cents: 431,
      currency: "USD",
      kind: "unclaimed_holding",
      status: "unclaimed_holding",
    },
    {
      line_item_id: "recon:<ingest-id>:line:2",
      payee_id: "unclaimed",
      amount_cents: 140,
      currency: "USD",
      kind: "unclaimed_holding",
      status: "unclaimed_holding",
    },
  ],
  replayHeldLength: 2,
  journals: 1,
  openQueueRows: [
    { event_id: "recon:<ingest-id>:line:1", matched_cbt_code: "CBT-MUS-TESTTRACK", status: "open" },
    { event_id: "recon:<ingest-id>:line:2", matched_cbt_code: "CBT-MUS-TESTTRACK", status: "open" },
  ],
};

describe.each(BACKENDS)("canonical posting parity — $name", ({ make }) => {
  it("runs the posting + replay scenario to the exact same observable outcome", async () => {
    const outcome = await postingScenario(make());
    expect(outcome).toEqual(EXPECTED);
  });
});
