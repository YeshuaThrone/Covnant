/**
 * Astra → recon queue handoff — integration over the REAL store backends
 * (the recon worker tests' pattern). Every captured statement lands as one
 * statement_ingests row (raw bytes byte-verbatim, identifier codes
 * untouched) and enqueues EXACTLY ONE royalty_recon_jobs row with the
 * ingest as provenance and the holder as requester. Re-traversal is the
 * recovery path for a partial handoff, not a double-enqueue guarantee —
 * the assertion pins the one-per-statement shape of a single pass.
 */
import { describe, expect, it } from "vitest";

import { InMemoryStore } from "@/lib/server/inMemoryStore";
import { SqliteStore } from "@/lib/server/sqliteStore";
import type { Store } from "@/lib/server/store";

import { handOffStatement, captureFailureReason } from "../handoff";
import type { CapturedStatement } from "../records";

const BACKENDS = [
  { name: "InMemoryStore", make: () => new InMemoryStore() },
  { name: "SqliteStore", make: () => new SqliteStore(":memory:") },
] as const;

const NOW = () => "2026-09-30T12:00:00.000Z";

const SAMPLE: CapturedStatement = {
  fileName: "2026-08.csv",
  content:
    "report_id,code,value,unit,kind,rate,note,partner\n" +
    "US-S1O-26-00001,T-034.524.680-1,190296734438,November,written,streaming,0.0041,partner\n" +
    "10.5240/1A2B-3C4D-5E6F-7G8H-9I0J-K,DE,700000,theatrical,12000,0.35,partner\n",
  format: "csv_statement",
};

describe.each(BACKENDS)("handOffStatement on $name", ({ make }) => {
  it("lands the raw statement byte-verbatim and enqueues exactly one claimable job", async () => {
    const store: Store = make();
    const handoff = await handOffStatement(store, SAMPLE, "holder-1", [], NOW);

    // Draining through the recon worker's OWN claim path — the job must be
    // claimable, not merely present.
    const claimed = await store.claimReconJob(new Date(NOW()), null);
    expect(claimed).toBeDefined();
    expect(claimed!.source).toBe("statement");
    expect(claimed!.ingest_id).toBe(handoff.ingestId);
    expect(claimed!.requested_by).toBe("holder-1");
    expect(claimed!.status).toBe("processing");
    expect(await store.claimReconJob(new Date(NOW()), null)).toBeUndefined();
  });

  it("two statements produce two ingests and two claimable jobs — never a merged enqueue", async () => {
    const store: Store = make();
    const second: CapturedStatement = { ...SAMPLE, fileName: "2026-07.csv" };
    const first = await handOffStatement(store, SAMPLE, "holder-1", [], NOW);
    const secondHandoff = await handOffStatement(store, second, "holder-1", [], NOW);

    const firstClaim = await store.claimReconJob(new Date(NOW()), null);
    const secondClaim = await store.claimReconJob(new Date(NOW()), null);
    expect(firstClaim!.ingest_id).toBe(first.ingestId);
    expect(secondClaim!.ingest_id).toBe(secondHandoff.ingestId);
    expect(new Set([firstClaim!.ingest_id, secondClaim!.ingest_id]).size).toBe(2);
  });

  it("the ingest row's identifier codes are captured verbatim", async () => {
    const store: Store = make();
    const handoff = await handOffStatement(store, SAMPLE, null, [], NOW);

    const ingest = await store.getStatementIngest(handoff.ingestId);
    expect(ingest).toBeDefined();
    expect(ingest!.content).toBe(SAMPLE.content); // byte-verbatim
    expect(ingest!.content).toContain("US-S1O-26-00001"); // ISRC untouched
    expect(ingest!.content).toContain("T-034.524.680-1"); // ISWC untouched
    expect(ingest!.content).toContain("10.5240/1A2B-3C4D-5E6F-7G8H-9I0J-K"); // EIDR untouched
    expect(ingest!.file_name).toBe("2026-08.csv");
    expect(ingest!.status).toBe("parsed"); // no parse ran; nothing failed
    expect(ingest!.event_count).toBeNull();
    expect(ingest!.error).toBeNull();
  });
});

describe("captureFailureReason", () => {
  it("prefixes the redacted error — secrets never reach the reason", () => {
    const reason = captureFailureReason(
      new Error("login rejected for s3cret-user@example.com"),
      ["s3cret-user@example.com"],
    );
    expect(reason).toContain("capture_failed:");
    expect(reason).not.toContain("s3cret-user");
  });
});
