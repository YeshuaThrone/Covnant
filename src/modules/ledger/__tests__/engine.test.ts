import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GL_GENESIS_HASH } from "@/modules/don/constants";
import { InMemoryStore } from "@/lib/server/inMemoryStore";
import { fboDebit, vaultCredit } from "../journal";
import { postJournal } from "../engine";

describe("postJournal", () => {
  it("posts a balanced journal and returns it", async () => {
    const store = new InMemoryStore();
    const posted = await postJournal(store, {
      kind: "royalty_ingest",
      ref_type: "split_run",
      ref_id: "sr_01",
      legs: [fboDebit(2500), vaultCredit("c1", "available", 2500)],
    });
    if (!posted.ok) throw new Error("expected balanced journal to post");
    expect(posted.journal.state).toBe("posted");
    const journals = await store.listGlJournals();
    const entries = await store.listGlEntries();
    expect(journals).toHaveLength(1);
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.journal_id === posted.journal.id)).toBe(true);
  });

  it("refuses an unbalanced journal and persists nothing", async () => {
    const store = new InMemoryStore();
    const posted = await postJournal(store, {
      kind: "royalty_ingest",
      ref_type: "split_run",
      ref_id: "sr_01",
      legs: [fboDebit(2500), vaultCredit("c1", "available", 2400)],
    });
    expect(posted.ok).toBe(false);
    if (!posted.ok) {
      expect(posted.code).toBe("unbalanced_journal");
      expect(posted.message).toContain("2500");
      expect(posted.message).toContain("2400");
    }
    expect(await store.listGlJournals()).toHaveLength(0);
    expect(await store.listGlEntries()).toHaveLength(0);
  });

  it("refuses a single-sided journal", async () => {
    const store = new InMemoryStore();
    expect((await postJournal(store, {
      kind: "royalty_ingest",
      ref_type: "split_run",
      ref_id: "sr_01",
      legs: [fboDebit(100)],
    })).ok).toBe(false);
  });

  it("every posted journal in a sequence is balanced", async () => {
    const store = new InMemoryStore();
    const sequences = [
      [fboDebit(1000), vaultCredit("c1", "available", 400), vaultCredit("c1", "pending", 600)],
      [vaultDebitLeg("c1", "pending", 600), vaultCreditLeg("c1", "available", 600)],
      [fboDebit(1), vaultCredit("c1", "reserve", 1)],
    ];
    for (const legs of sequences) {
      const posted = await postJournal(store, {
        kind: "royalty_ingest",
        ref_type: "split_run",
        ref_id: "sr_01",
        legs,
      });
      expect(posted.ok).toBe(true);
    }
    const sums = new Map<string, { debits: number; credits: number }>();
    for (const entry of await store.listGlEntries()) {
      const s = sums.get(entry.journal_id) ?? { debits: 0, credits: 0 };
      s.debits += entry.debit_cents;
      s.credits += entry.credit_cents;
      sums.set(entry.journal_id, s);
    }
    for (const { debits, credits } of sums.values()) {
      expect(debits).toBe(credits);
    }
  });

  it("chains entry_hash across a sequence: prev_hash inside the hashed payload", async () => {
    const store = new InMemoryStore();
    const first = await postJournal(store, {
      kind: "royalty_ingest",
      ref_type: "split_run",
      ref_id: "sr_01",
      legs: [fboDebit(100), vaultCredit("c1", "available", 100)],
    }, new Date("2026-09-10T00:00:00.000Z"));
    const second = await postJournal(store, {
      kind: "royalty_ingest",
      ref_type: "split_run",
      ref_id: "sr_02",
      legs: [fboDebit(50), vaultCredit("c1", "pending", 50)],
    }, new Date("2026-09-10T00:00:01.000Z"));

    if (!first.ok || !second.ok) throw new Error("expected both journals to post");
    expect(first.journal.prev_hash).toBe(GL_GENESIS_HASH);
    expect(second.journal.prev_hash).toBe(first.journal.entry_hash);
    expect(second.journal.sequence).toBe(first.journal.sequence + 1);

    // Recompute the second hash by hand over chain.ts's documented payload:
    // legs as stored triples, then created_at, then sequence and prev_hash.
    const hand = createHash("sha256")
      .update(
        JSON.stringify({
          kind: second.journal.kind,
          ref_type: second.journal.ref_type,
          ref_id: second.journal.ref_id,
          legs: [
            { account: "fbo_cash", debit_cents: 50, credit_cents: 0 },
            { account: "vault:c1:pending", debit_cents: 0, credit_cents: 50 },
          ],
          created_at: "2026-09-10T00:00:01.000Z",
          sequence: second.journal.sequence,
          prev_hash: second.journal.prev_hash,
        }),
      )
      .digest("hex");
    expect(second.journal.entry_hash).toBe(hand);
  });
});

// Local leg builders kept tiny so this file exercises postJournal directly.
function vaultDebitLeg(payeeId: string, bucket: "available" | "pending" | "reserve", amount: number) {
  return { account: `vault:${payeeId}:${bucket}`, debit_cents: amount, credit_cents: 0 };
}
function vaultCreditLeg(payeeId: string, bucket: "available" | "pending" | "reserve", amount: number) {
  return { account: `vault:${payeeId}:${bucket}`, debit_cents: 0, credit_cents: amount };
}
