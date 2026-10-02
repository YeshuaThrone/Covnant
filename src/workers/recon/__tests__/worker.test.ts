/**
 * Worker E2E tests — the claim → parse → residual holds → match_queue →
 * complete loop over the REAL store backends (InMemoryStore and
 * SqliteStore on :memory:) and the REAL checked-in fixtures. Every exact
 * count and micros value is the contract: the UCT layer enqueues, this
 * lane does the rest, and a re-processed ingest is a replay no-op.
 */
import { describe, expect, it } from "vitest";

import { InMemoryStore } from "@/lib/server/inMemoryStore";
import { SqliteStore } from "@/lib/server/sqliteStore";
import type { Store } from "@/lib/server/store";
import type { VaultAssetRecord } from "@/lib/covnant/vault";

import { loadFixture } from "./fixtures";
import { RECON_WORKER_ENGINE, runOnce, runWorkerLoop } from "../worker";

const BACKENDS = [
  { name: "InMemoryStore", make: () => new InMemoryStore() },
  { name: "SqliteStore", make: () => new SqliteStore(":memory:") },
] as const;

const NOW = () => new Date("2026-09-30T12:00:00Z");

/** Seeds one statement ingest and its recon job; returns the ids. */
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
    created_at: NOW().toISOString(),
  });
  const job = await store.createReconJob({ source: "statement", ingest_id: ingest.id });
  return { jobId: job.id, ingestId: ingest.id };
}

/** A vault stub whose EIDR resolves — the film cross-reference path. */
function vaultWithEidr(): {
  findByIdentifier(kind: string, value: string): Promise<VaultAssetRecord | null>;
} {
  return {
    async findByIdentifier(kind, value) {
      if (kind === "EIDR" && value === "10.5240/000A-000B-000C-000D-000E-F") {
        return {
          cvtCode: "CVT-TEST-FILM",
          cbtCode: "CBT-FLM-TESTFILM",
          title: "Midnight Reel",
          medium: "film",
          externalIdentifiers: { EIDR: value },
          holderUct: null,
        };
      }
      return null;
    },
  };
}

/** A vault stub whose verified UPC resolves — the merch cross-reference path. */
function merchVault(): {
  findByIdentifier(kind: string, value: string): Promise<VaultAssetRecord | null>;
} {
  return {
    async findByIdentifier(kind, value) {
      if (kind === "UPC" && value === "012345678901") {
        return {
          cvtCode: "CVT-TEST-MERCH",
          cbtCode: "CBT-MERCH-TEE",
          title: "Crest Tee",
          medium: "merchandise",
          externalIdentifiers: { UPC: value },
          holderUct: null,
        };
      }
      return null;
    },
  };
}

describe.each(BACKENDS)("$name — worker loop", ({ make }) => {
  it("returns undefined when the queue is empty", async () => {
    const worker = { store: make(), vault: null, now: NOW };
    expect(await runOnce(worker)).toBeUndefined();
  });

  it("parses a DistroKid ingest end-to-end: 2 master lines, no residuals", async () => {
    const store = make();
    const { jobId, ingestId } = await seedJob(store, "distrokid.csv", loadFixture("distrokid.csv"));

    const processed = await runOnce({ store, vault: null, now: NOW });
    expect(processed?.outcome).toBe("completed");
    expect(processed?.job.id).toBe(jobId);
    expect(processed?.job.result).toEqual({
      events_written: 2,
      matched: 0,
      unmatched: 2,
      engine_used: null,
      holding_posted: 0, // vault: null — nothing matched, nothing posted
      holding_replayed: 0,
    });

    expect(processed?.job.status).toBe("completed");
    expect(processed?.job.engine).toBe(RECON_WORKER_ENGINE);

    const rows = (await store.listMatchQueueEntries(undefined, 500)).filter((row) =>
      row.event_id.startsWith(`recon:${ingestId}:`),
    );
    expect(rows.map((row) => row.event_id).sort()).toEqual(
      [`recon:${ingestId}:line:1`, `recon:${ingestId}:line:2`].sort(),
    );
    expect(rows.every((row) => row.status === "open")).toBe(true);
    expect(rows.every((row) => row.rights_type === "master")).toBe(true);
    expect(rows.every((row) => row.tier_level === null)).toBe(true);
    expect(rows.every((row) => row.source === "statement")).toBe(true);
    expect(rows[0].matched_cbt_code).toBeNull();
    expect(JSON.parse(rows[0].raw_payload).profile).toBe("distrokid_csv");
  });

  it("parses a film ingest end-to-end: tier-0 receipts plus tier-2 residual holds", async () => {
    const store = make();
    const { jobId, ingestId } = await seedJob(store, "film_vod.csv", loadFixture("film_vod.csv"));

    const processed = await runOnce({
      store,
      vault: vaultWithEidr(),
      now: NOW,
    });
    expect(processed?.outcome).toBe("completed");
    // 2 receipt lines + 3 guild holds per line = 8 written events.
    expect(processed?.job.result).toEqual({
      events_written: 8,
      matched: 2, // both receipts hit the EIDR
      unmatched: 6, // holds carry no identifiers — honest, not guessed
      engine_used: null,
      holding_posted: 0, // film lines are rights 'unknown' — waterfall lane
      holding_replayed: 0,
    });

    const rows = (await store.listMatchQueueEntries(undefined, 500)).filter((row) =>
      row.event_id.startsWith(`recon:${ingestId}:`),
    );
    const receipt = rows.find((row) => row.event_id === `recon:${ingestId}:line:1`);
    expect(receipt?.rights_type).toBe("unknown");
    expect(receipt?.tier_level).toBe(0);
    expect(receipt?.statement_source_type).toBe("vod");
    expect(receipt?.matched_cbt_code).toBe("CBT-FLM-TESTFILM");

    const sag = rows.find((row) => row.event_id === `recon:${ingestId}:residual:SAG_AFTRA:1`);
    expect(sag?.tier_level).toBe(2);
    expect(sag?.rights_type).toBe("unknown");
    expect(sag?.gross_micros).toBe("3065856000"); // 47,904,000,000 × 640 bps
    expect(sag?.matched_cbt_code).toBeNull();
    const wga = rows.find((row) => row.event_id === `recon:${ingestId}:residual:WGA:1`);
    expect(wga?.gross_micros).toBe("718560000");
    const dga = rows.find((row) => row.event_id === `recon:${ingestId}:residual:DGA:1`);
    expect(dga?.gross_micros).toBe("862272000");

    // Every guild hold for every receipt row landed — obligations are
    // never silently skipped.
    expect(rows.filter((row) => row.event_id.includes("residual"))).toHaveLength(6);
    expect(jobId).toBeDefined();
  });

  it("re-processes the same ingest as a replay no-op — idempotent by event_id", async () => {
    const store = make();
    const { ingestId } = await seedJob(store, "distrokid.csv", loadFixture("distrokid.csv"));

    await runOnce({ store, vault: null, now: NOW });

    // Enqueue the SAME ingest again (the UCT layer's re-parse path) — the
    // only pending job, so the next pass claims it.
    await store.createReconJob({ source: "statement", ingest_id: ingestId });
    const processed = await runOnce({ store, vault: null, now: NOW });
    expect(processed?.outcome).toBe("completed");
    expect(processed?.job.result).toEqual({
      events_written: 0, // every row already present — the replay wrote nothing
      matched: 0,
      unmatched: 0,
      engine_used: null,
      holding_posted: 0,
      holding_replayed: 0,
    });
    const rows = (await store.listMatchQueueEntries(undefined, 500)).filter((row) =>
      row.event_id.startsWith(`recon:${ingestId}:`),
    );
    expect(rows).toHaveLength(2); // still exactly the first pass's rows
  });

  it("fails honestly on an unrecognized text layout — retryable, reason recorded", async () => {
    const store = make();
    const { jobId } = await seedJob(
      store,
      "unknown_layout.csv",
      loadFixture("unknown_layout.csv"),
    );

    const processed = await runOnce({ store, vault: null, now: NOW });
    expect(processed?.outcome).toBe("failed");
    expect(processed?.job.status).toBe("pending"); // re-pooled under the retry budget
    expect(processed?.job.attempts).toBe(1);
    expect(processed?.job.error).toMatch(/no_matching_profile/);
    expect(jobId).toBeDefined();
  });

  it("fails closed for a PDF statement while the vision seam is unconfigured", async () => {
    const store = make();
    const { jobId } = await seedJob(store, "statement.pdf", "%PDF-1.7 scanned statement");

    const processed = await runOnce({ store, vault: null, now: NOW, env: { NODE_ENV: "test" } });
    expect(processed?.outcome).toBe("failed");
    expect(processed?.job.error).toMatch(/vision engine not configured/);
    expect(jobId).toBeDefined();
  });

  it("runs exactly maxJobs jobs through the loop, then stops", async () => {
    const store = make();
    await seedJob(store, "distrokid.csv", loadFixture("distrokid.csv"));
    await seedJob(store, "film_vod.csv", loadFixture("film_vod.csv"));

    const slept: number[] = [];
    await runWorkerLoop(
      { store, vault: null, now: NOW, sleep: async (ms) => { slept.push(ms); } },
      2,
    );
    expect(slept).toHaveLength(0); // two jobs were pending — never slept

    // Queue drained: a third pass has nothing to claim.
    expect(await store.claimReconJob(NOW(), RECON_WORKER_ENGINE)).toBeUndefined();
  });

  it("parses a merch ingest end-to-end: COGS deduction, quarantines, one post", async () => {
    const store = make();
    const { jobId } = await seedJob(
      store,
      "merch_shopify_dtc.csv",
      loadFixture("merch_shopify_dtc.csv"),
    );

    const processed = await runOnce({ store, vault: merchVault(), now: NOW });
    expect(processed?.outcome).toBe("completed");
    expect(processed?.job.id).toBe(jobId);
    expect(processed?.job.result).toEqual({
      events_written: 4,
      matched: 3, // rows 1–3 share the verified UPC; row 4's does not resolve
      unmatched: 1,
      engine_used: null,
      holding_posted: 1, // row 1's $28.13 net; the other three never post
      holding_replayed: 0,
      merch_written: 4,
      merch_replayed: 0,
      merch_held_negative_net: 1, // row 3's $10.00 gross vs $25.00 COGS
      merch_zero_net: 1, // row 2's $0.004 net
      merch_cogs_micros: "4325000000", // (2×6.50 + 0.25 + 25.00 + 5.00) × 1e8
      merch_shrinkage_offset_micros: "0", // the DTC lane carries no shrinkage
    });
    expect(processed?.job.status).toBe("completed");

    // The queue rows carry the addendum 8 columns — the physical SKU and
    // the per-unit COGS the FIFO amortization keys on — under the
    // content-derived merch event ids (identity across re-shipped dumps,
    // not per-ingest).
    const rows = (await store.listMatchQueueEntries(undefined, 500)).filter((row) =>
      row.event_id.startsWith("merch:dtc:"),
    );
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => row.sku_id !== null && row.sku_id !== "")).toBe(true);
    // Row 1's tee: the per-unit COGS the FIFO amortization keys on, and
    // the matched vault product. Row 4's tote: honestly unmatched.
    const teeRow = rows.find((row) => row.cogs_per_unit_micros === "650000000");
    expect(teeRow).toBeDefined();
    expect(teeRow!.sku_id).toBe("SKU-TSHIRT-CREST");
    expect(teeRow!.matched_cbt_code).toBe("CBT-MERCH-TEE");
    const toteRow = rows.find((row) => row.sku_id === "SKU-TOTE-BLACK");
    expect(toteRow).toBeDefined();
    expect(toteRow!.matched_cbt_code).toBeNull();
    expect(toteRow!.cogs_per_unit_micros).toBe("500000000"); // $5.00/unit
  });

  it("re-processes the same merch dump as a replay no-op — idempotent across ingests", async () => {
    const store = make();
    const { ingestId } = await seedJob(
      store,
      "merch_shopify_dtc.csv",
      loadFixture("merch_shopify_dtc.csv"),
    );
    await runOnce({ store, vault: merchVault(), now: NOW });

    // A re-shipped dump lands as a fresh ingest of the same bytes — the
    // content-derived event ids collide, and everything replays as counted
    // no-ops: nothing re-written, nothing re-posted.
    await store.createReconJob({ source: "statement", ingest_id: ingestId });
    const processed = await runOnce({ store, vault: merchVault(), now: NOW });
    expect(processed?.outcome).toBe("completed");
    expect(processed?.job.result).toMatchObject({
      events_written: 0,
      holding_posted: 0,
      holding_replayed: 1,
      merch_written: 0,
      merch_replayed: 4,
      merch_held_negative_net: 1, // the dispositions still count — visible, not posted
      merch_zero_net: 1,
    });
    expect((await store.listUnclaimedHoldingCredits(100)).length).toBe(1);
  });
});
