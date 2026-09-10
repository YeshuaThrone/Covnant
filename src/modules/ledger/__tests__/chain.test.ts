import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GL_GENESIS_HASH, GL_ACCOUNT_FBO_CASH } from "@/modules/don/constants";
import { hashEntry, hashJournal } from "../chain";
import type { GlEntryRecord } from "@/modules/don/records";

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

describe("hashEntry", () => {
  function entry(overrides: Partial<GlEntryRecord> = {}): GlEntryRecord {
    return {
      id: "gle_01",
      journal_id: "glj_01",
      account: GL_ACCOUNT_FBO_CASH,
      debit_cents: 100,
      credit_cents: 0,
      created_at: "2026-09-10T00:00:00.000Z",
      ...overrides,
    };
  }

  it("is sha256 over the documented payload with sequence and prev_hash inside", () => {
    const payload = JSON.stringify({
      id: "gle_01",
      journal_id: "glj_01",
      account: GL_ACCOUNT_FBO_CASH,
      debit_cents: 100,
      credit_cents: 0,
      created_at: "2026-09-10T00:00:00.000Z",
      sequence: 1,
      prev_hash: "prev",
    });
    expect(hashEntry(entry(), 1, "prev")).toBe(sha256(payload));
  });

  it("is sensitive to any field change", () => {
    const base = hashEntry(entry(), 1, "prev");
    expect(hashEntry(entry({ debit_cents: 101 }), 1, "prev")).not.toBe(base);
    expect(hashEntry(entry(), 2, "prev")).not.toBe(base);
    expect(hashEntry(entry(), 1, "other")).not.toBe(base);
  });
});

describe("hashEntry chaining across a sequence", () => {
  it("entry_hash chains prev_hash exactly from genesis through the ledger", () => {
    const entries: GlEntryRecord[] = [
      {
        id: "e1",
        journal_id: "j1",
        account: GL_ACCOUNT_FBO_CASH,
        debit_cents: 100,
        credit_cents: 0,
        created_at: "2026-09-10T00:00:00.000Z",
      },
      {
        id: "e2",
        journal_id: "j1",
        account: "vault:c1:available",
        debit_cents: 0,
        credit_cents: 100,
        created_at: "2026-09-10T00:00:00.000Z",
      },
      {
        id: "e3",
        journal_id: "j2",
        account: "vault:c1:pending",
        debit_cents: 50,
        credit_cents: 0,
        created_at: "2026-09-10T00:00:01.000Z",
      },
    ];
    let prev = GL_GENESIS_HASH;
    const hashes = entries.map((entry, index) => {
      const hash = hashEntry(entry, index + 1, prev);
      prev = hash;
      return hash;
    });
    // Recompute independently and require exact chaining.
    expect(hashes[0]).toBe(hashEntry(entries[0]!, 1, GL_GENESIS_HASH));
    expect(hashes[1]).toBe(hashEntry(entries[1]!, 2, hashes[0]!));
    expect(hashes[2]).toBe(hashEntry(entries[2]!, 3, hashes[1]!));
    expect(hashes.every((hash) => /^[0-9a-f]{64}$/.test(hash))).toBe(true);
  });
});
