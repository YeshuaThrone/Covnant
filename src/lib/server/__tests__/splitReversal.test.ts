import { describe, expect, it } from "vitest";
import { reverseSplitRun } from "../splitReversal";
import { calculateUdrSplits } from "../udrSplits";
import { InMemoryStore } from "@/lib/server/inMemoryStore";
import { seedVault } from "@/modules/don/__tests__/fixtures";
import { COMPANY_VARIANCE_PAYEE_ID } from "@/modules/don/constants";
import type { CreatorTaxProfile } from "@/modules/don/records";
import { readCreatorCompliance } from "@/modules/compliance/engine";

/**
 * Wiring battery for split-run reversal (spec criteria 6 and 8): the
 * royalty_reversal journal exactly inverts the original legs, vault balances
 * are restored, and a second reversal is a no-op by idempotency.
 */

const NOW = new Date("2026-09-10T12:00:00.000Z");
const LATER = new Date("2026-09-10T13:00:00.000Z");

async function wiredStore(
  store: InMemoryStore = new InMemoryStore(),
  tinVerified: 0 | 1 = 1,
  w9OnFile: 0 | 1 = 1,
): Promise<InMemoryStore> {
  await seedVault(store, "creator_1", 0, 0, 0, "Creator One");
  await seedVault(store, COMPANY_VARIANCE_PAYEE_ID, 0, 0, 0, "Don Engine Variance");
  const profile: CreatorTaxProfile = {
    creator_id: "creator_1",
    tin_verified: tinVerified,
    w9_on_file: w9OnFile,
    updated_at: NOW.toISOString(),
  };
  await store.upsertCreatorTaxProfile(profile);
  return store;
}

async function runSplit(store: InMemoryStore, amountCents = 10_000) {
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
        amount_cents: amountCents,
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

  // Audit #7: the reversal must remove the phantom gross — the creator's
  // YTD and the run's escrow trail used to keep the reversed run's amounts,
  // so it kept counting toward 1099s after its money was clawed back.
  describe("tax unwind", () => {
    it("nets YTD and the run's escrow trail to zero after a reversal", async () => {
      // Unverified TIN → backup withholding (24% of the creator's share),
      // so the clawback covers BOTH the net (pending) and the withheld
      // (reserve) — and the run crosses the 1099 threshold before reversal.
      const store = await wiredStore(new InMemoryStore(), 0, 0);
      const run = await runSplit(store, 70_000); // creator share 66_500 ≥ 60_000

      const ytdBefore = await store.getCreatorYtd("creator_1", NOW.getUTCFullYear());
      expect(ytdBefore?.gross_cents).toBe(66_500);
      expect(ytdBefore?.withheld_cents).toBe(15_960); // floor(66_500 × 24%)
      const creatorBefore = await store.getVault("creator_1");
      expect(creatorBefore?.pending_balance).toBe(50_540); // 66_500 − 15_960
      expect(creatorBefore?.reserve_balance).toBe(15_960);

      const reversal = await reverseSplitRun(store, run.split_run.id, LATER);
      if (!reversal.ok) {
        throw new Error(`expected ok, got ${reversal.status} ${reversal.code}`);
      }

      // Phantom gross removed: YTD is back to zero on both totals.
      const ytdAfter = await store.getCreatorYtd("creator_1", NOW.getUTCFullYear());
      expect(ytdAfter?.gross_cents).toBe(0);
      expect(ytdAfter?.withheld_cents).toBe(0);

      // The run's escrow trail nets to zero — one compensating (negative)
      // row per escrow row the run created, keyed to the same run id.
      const escrowTrail = await store.listTaxEscrowByRun(run.split_run.id);
      expect(escrowTrail).toHaveLength(2);
      const escrowGross = escrowTrail.reduce((s, row) => s + row.gross_cents, 0);
      const escrowWithheld = escrowTrail.reduce((s, row) => s + row.withheld_cents, 0);
      expect(escrowGross).toBe(0);
      expect(escrowWithheld).toBe(0);

      // The withheld reserve is clawed back along with the net.
      const creatorAfter = await store.getVault("creator_1");
      expect(creatorAfter?.pending_balance).toBe(0);
      expect(creatorAfter?.reserve_balance).toBe(0);

      // No 1099 exposure remains for the reversed run.
      const compliance = await readCreatorCompliance(
        store,
        "creator_1",
        NOW.getUTCFullYear(),
      );
      expect(compliance.requires_1099).toBe(false);
    });
  });

  // Audit #13: two concurrent reversals of the same run used to BOTH pass
  // the status check and double-claw the vaults. The guard-first atomic
  // claim is the arbiter: the loser passed every pre-claim check, but its
  // claim attempts the transition against an already-reversed run, fails
  // the rowcount, and aborts without moving a cent.
  describe("concurrent reversal race", () => {
    class StalledClaimStore extends InMemoryStore {
      /** When set, the FIRST claim attempt stalls until release fires. */
      stall: Promise<void> | null = null;
      release: (() => void) | null = null;

      override async transitionSplitRunStatus(
        splitRunId: string,
        from: Parameters<InMemoryStore["transitionSplitRunStatus"]>[1],
        to: Parameters<InMemoryStore["transitionSplitRunStatus"]>[2],
      ) {
        if (this.stall) {
          const gate = this.stall;
          this.stall = null;
          await gate;
        }
        return super.transitionSplitRunStatus(splitRunId, from, to);
      }

      override async insertSplitReversal(
        row: Parameters<InMemoryStore["insertSplitReversal"]>[0],
      ) {
        const created = await super.insertSplitReversal(row);
        // The winner's final write — release the stalled claim now, so the
        // loser's claim runs against the ALREADY-reversed run.
        this.release?.();
        this.release = null;
        return created;
      }
    }

    it("lets exactly one of two simultaneous reversals win", async () => {
      const store = new StalledClaimStore();
      await wiredStore(store);
      const run = await runSplit(store);

      const gate = new Promise<void>((resolve) => {
        store.release = resolve;
      });
      store.stall = gate;

      const results = await Promise.all([
        reverseSplitRun(store, run.split_run.id, LATER),
        reverseSplitRun(store, run.split_run.id, LATER),
      ]);

      const winners = results.filter(
        (r): r is Extract<typeof r, { ok: true }> => r.ok,
      );
      const losers = results.filter(
        (r): r is Extract<typeof r, { ok: false }> => !r.ok,
      );
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      expect(winners[0]!.idempotent).toBe(false);
      expect(losers[0]!.status).toBe(409);
      expect(losers[0]!.code).toBe("split_already_reversed");

      // The loser posted nothing: one ingest + one reversal journal only.
      const runJournals = await store.listGlJournalsByRef(
        "split_run",
        run.split_run.id,
      );
      expect(runJournals).toHaveLength(2);

      // Balances clawed back exactly once — no double-claw.
      const creator = await store.getVault("creator_1");
      const platform = await store.getVault(COMPANY_VARIANCE_PAYEE_ID);
      expect(creator?.pending_balance).toBe(0);
      expect(platform?.pending_balance).toBe(0);
    });
  });
});
