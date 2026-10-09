import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GL_GENESIS_HASH, GL_ACCOUNT_FBO_CASH } from "@/modules/don/constants";
import { hashJournal } from "../chain";

function sha256(payload: string): string {
  return createHash("sha256").update(payload).digest("hex");
}

const LEGS = [
  { account: GL_ACCOUNT_FBO_CASH, debit_cents: 100, credit_cents: 0 },
  { account: "vault:c1:available", debit_cents: 0, credit_cents: 100 },
];

describe("hashJournal", () => {
  it("is sha256 over the documented payload with sequence and prev_hash inside", () => {
    const journal = {
      kind: "royalty_ingest",
      ref_type: "split_run",
      ref_id: "sr_01",
      legs: LEGS,
      created_at: "2026-09-10T00:00:00.000Z",
    };
    // Exact payload construction documented in chain.ts: legs as stored
    // triples, then created_at, sequence, and prev_hash inside the payload.
    const payload = JSON.stringify({
      kind: "royalty_ingest",
      ref_type: "split_run",
      ref_id: "sr_01",
      legs: LEGS,
      created_at: "2026-09-10T00:00:00.000Z",
      sequence: 1,
      prev_hash: "prev",
    });
    expect(hashJournal(journal, 1, "prev")).toBe(sha256(payload));
  });

  it("is sensitive to any payload change", () => {
    const journal = {
      kind: "royalty_ingest",
      ref_type: "split_run",
      ref_id: "sr_01",
      legs: LEGS,
      created_at: "2026-09-10T00:00:00.000Z",
    };
    const base = hashJournal(journal, 1, "prev");
    expect(
      hashJournal({ ...journal, ref_id: "sr_02" }, 1, "prev"),
    ).not.toBe(base);
    expect(hashJournal(journal, 2, "prev")).not.toBe(base);
    expect(hashJournal(journal, 1, "other")).not.toBe(base);
  });

  it("chains: the previous entry_hash becomes the next prev_hash", () => {
    const journal = {
      kind: "royalty_ingest",
      ref_type: "split_run",
      ref_id: "sr_01",
      legs: LEGS,
      created_at: "2026-09-10T00:00:00.000Z",
    };
    const h1 = hashJournal(journal, 1, GL_GENESIS_HASH);
    const h2 = hashJournal(journal, 2, h1);
    const h2again = hashJournal(journal, 2, h1);
    expect(h2again).toBe(h2);
    expect(h2).not.toBe(h1);
    expect(h2).toBe(
      sha256(
        JSON.stringify({
          kind: "royalty_ingest",
          ref_type: "split_run",
          ref_id: "sr_01",
          legs: LEGS,
          created_at: "2026-09-10T00:00:00.000Z",
          sequence: 2,
          prev_hash: h1,
        }),
      ),
    );
  });
});

describe("module surface", () => {
  it("does not export a per-entry hash — journal verification recomputes via hashJournal", async () => {
    // F9 regression guard: hashEntry was dead code (zero production callers)
    // whose existence invited "fixing" journal verification against it instead
    // of the canonical hashJournal. The chain's public surface is exactly
    // { hashJournal, verifyHashChain } — no entry-level hash.
    const chain = await import("../chain");
    expect(chain).not.toHaveProperty("hashEntry");
  });
});
