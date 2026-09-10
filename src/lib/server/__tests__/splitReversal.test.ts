import { describe, expect, it } from "vitest";
import { reverseSplitRun } from "../splitReversal";
import { calculateUdrSplits } from "../udrSplits";
import { InMemoryStore } from "@/lib/server/inMemoryStore";
import { seedVault } from "@/modules/don/__tests__/fixtures";
import { COMPANY_VARIANCE_PAYEE_ID } from "@/modules/don/constants";
import type { CreatorTaxProfile } from "@/modules/don/records";

/**
 * Wiring battery for split-run reversal (spec criteria 6 and 8): the
 * royalty_reversal journal exactly inverts the original legs, vault balances
 * are restored, and a second reversal is a no-op by idempotency.
 */

const NOW = new Date("2026-09-10T12:00:00.000Z");
const LATER = new Date("2026-09-10T13:00:00.000Z");

async function wiredStore(): Promise<InMemoryStore> {
  const store = new InMemoryStore();
  await seedVault(store, "creator_1", 0, 0, 0, "Creator One");
  await seedVault(store, COMPANY_VARIANCE_PAYEE_ID, 0, 0, 0, "Don Engine Variance");
  const profile: CreatorTaxProfile = {
    creator_id: "creator_1",
    tin_verified: 1,
    w9_on_file: 1,
    updated_at: NOW.toISOString(),
  };
  await store.upsertCreatorTaxProfile(profile);
  return store;
}

async function runSplit(store: InMemoryStore) {
  const result = await calculateUdrSplits(store, {
    source: "spotify",
    period: "2026-08",
    currency: "USD",
    settle: false,
    rail: "ach",
    line_items: [
      {
        work_id: "work_1",
        work_title: "One Work",
        amount_cents: 10_000,
        splits: [
          { payee_id: "creator_1", payee_name: "Creator One", role: "creator", share_bps: 9500 },
          { payee_id: "platform", payee_name: "Don Engine Variance", role: "other", share_bps: 500 },
        ],
      },
    ],
  }, NOW);
  if (!result.ok) {
    throw new Error(`expected ok, got ${result.status} ${result.code}`);
  }
  return result.value;
}

describe("reverseSplitRun", () => {
  it("inverts the original journal exactly and restores vault balances", async () => {
    const store = await wiredStore();
    const run = await runSplit(store);

    const creatorBefore = await store.getVault("creator_1");
    const platformBefore = await store.getVault(COMPANY_VARIANCE_PAYEE_ID);
    expect(creatorBefore?.pending_balance).toBe(9_500);
    expect(platformBefore?.pending_balance).toBe(500);

    const reversal = await reverseSplitRun(store, run.split_run.id, LATER);
    if (!reversal.ok) {
      throw new Error(`expected ok, got ${reversal.status} ${reversal.code}`);
    }
    expect(reversal.idempotent).toBe(false);

    // Both journals share the run ref (royalty_ingest + royalty_reversal);
    // the reversal's own record points at its journal by id.
    const runJournals = await store.listGlJournalsByRef("split_run", run.split_run.id);
    expect(runJournals).toHaveLength(2);
    const ingest = runJournals.find((journal) => journal.kind === "royalty_ingest");
    const reversalJournal = runJournals.find(
      (journal) => journal.id === reversal.reversal.journal_id,
    );
    expect(ingest).toBeDefined();
    expect(reversalJournal).toBeDefined();
    if (!ingest || !reversalJournal) return;
    const originalLegs = await store.listGlEntriesByJournal(ingest.id);
    const reversalLegs = await store.listGlEntriesByJournal(reversalJournal.id);
    expect(reversalLegs).toHaveLength(originalLegs.length);
    for (const leg of originalLegs) {
      const inverse = reversalLegs.find((candidate) => candidate.account === leg.account);
      expect(inverse).toBeDefined();
      expect(inverse!.debit_cents).toBe(leg.credit_cents);
      expect(inverse!.credit_cents).toBe(leg.debit_cents);
    }
    // The reversal journal itself is balanced and hash-chained.
    const debits = reversalLegs.reduce((s, leg) => s + leg.debit_cents, 0);
    const credits = reversalLegs.reduce((s, leg) => s + leg.credit_cents, 0);
    expect(debits).toBe(credits);
    expect(reversalJournal.prev_hash).toBe(ingest.entry_hash);

    // Vault balances return to their seed state.
    const creatorAfter = await store.getVault("creator_1");
    const platformAfter = await store.getVault(COMPANY_VARIANCE_PAYEE_ID);
    expect(creatorAfter?.pending_balance).toBe(0);
    expect(platformAfter?.pending_balance).toBe(0);

    // The run flips out of posted.
    const reread = await store.getSplitRun(run.split_run.id);
    expect(reread?.status).not.toBe("posted");
  });

  it("is idempotent — a second reversal returns the same record with no second journal", async () => {
    const store = await wiredStore();
    const run = await runSplit(store);
    const first = await reverseSplitRun(store, run.split_run.id, LATER);
    if (!first.ok) {
      throw new Error(`expected ok, got ${first.status} ${first.code}`);
    }
    const second = await reverseSplitRun(store, run.split_run.id, LATER);
    if (!second.ok) {
      throw new Error(`expected ok, got ${second.status} ${second.code}`);
    }
    expect(second.idempotent).toBe(true);
    expect(second.reversal.id).toBe(first.reversal.id);
    // Still exactly two journals under the run ref — no second reversal
    // journal was posted.
    const runJournals = await store.listGlJournalsByRef("split_run", run.split_run.id);
    expect(runJournals).toHaveLength(2);
    const creator = await store.getVault("creator_1");
    expect(creator?.pending_balance).toBe(0);
  });

  it("404s an unknown split run", async () => {
    const store = await wiredStore();
    const result = await reverseSplitRun(store, "run_missing", LATER);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(404);
      expect(result.code).toBe("split_run_not_found");
    }
  });
});
