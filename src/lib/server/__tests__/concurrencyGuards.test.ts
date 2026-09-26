import { describe, expect, it } from "vitest";

import { InMemoryStore } from "@/lib/server/inMemoryStore";
import { SqliteStore } from "@/lib/server/sqliteStore";
import type { Store } from "@/lib/server/store";
import { calculateUdrSplits, type SplitCalculateSuccess } from "@/lib/server/udrSplits";
import { validateSplitCalculatePayload } from "@/lib/don/validation";
import { COMPANY_VARIANCE_PAYEE_ID, GL_GENESIS_HASH } from "@/modules/don/constants";
import type { GlJournalRecord, SovereignVaultRecord } from "@/modules/don/records";
import { creditVault, payoutFromVault, reverseVaultPayout } from "@/modules/vaults/engine";
import { postJournal } from "@/modules/ledger/engine";
import type { GlLegInput } from "@/modules/ledger/journal";

/**
 * Concurrency-guard battery (migration 0009 — audit art_GG1emERn, H1–H4).
 *
 * The production backend is SupabaseStore, where every guard is enforced by
 * Postgres itself: `apply_vault_delta` applies the balance delta additively
 * in one conditional UPDATE, and UNIQUE indexes on gl_journals.sequence,
 * payout_reversals.transfer_id, and split_runs.idempotency_key make duplicate
 * writes impossible. These tests pin the same CONTRACT on the two local
 * backends (InMemoryStore, SqliteStore over real better-sqlite3): the delta
 * seam never overwrites from a stale read, the constraints reject duplicates,
 * and the engine-level replays (reversal webhooks, split-saga retries) are
 * idempotent. Local stores are synchronous inside, so "parallel" mutations
 * serialize deterministically — the additive-delta property they assert is
 * exactly the property that makes the guarded statement safe on the real
 * backend.
 */

const NOW = new Date("2026-09-26T12:00:00.000Z");

const BACKENDS: { name: string; make: () => Promise<Store> }[] = [
  { name: "InMemoryStore", make: async () => new InMemoryStore() },
  { name: "SqliteStore", make: async () => new SqliteStore(":memory:") },
];

async function seedVaultOn(
  store: Store,
  payeeId: string,
  availableBalance: number,
  pendingBalance: number,
  reserveBalance: number,
  payeeName = `Payee ${payeeId}`,
): Promise<SovereignVaultRecord> {
  const vault: SovereignVaultRecord = {
    payee_id: payeeId,
    payee_name: payeeName,
    available_balance: availableBalance,
    pending_balance: pendingBalance,
    reserve_balance: reserveBalance,
    updated_at: NOW.toISOString(),
  };
  await store.upsertVault(vault);
  return vault;
}

function balancedLegs(cents: number): GlLegInput[] {
  return [
    { account: "fbo_cash", debit_cents: cents, credit_cents: 0 },
    { account: "payouts_pending", debit_cents: 0, credit_cents: cents },
  ];
}

function appliedVault(
  result: Awaited<ReturnType<Store["applyVaultDelta"]>>,
): SovereignVaultRecord {
  if (result.outcome !== "applied") {
    throw new Error(`expected the delta to apply, got ${result.outcome}`);
  }
  return result.vault;
}

function postedJournalOk(
  result: Awaited<ReturnType<typeof postJournal>>,
): GlJournalRecord {
  if (!result.ok) {
    throw new Error(`expected a posted journal, got ${result.code}`);
  }
  return result.journal;
}

describe("migration 0009 — guarded vault delta seam (H1)", () => {
  it.each(BACKENDS)(
    "$name: a delta applies additively to the CURRENT row, not a stale read",
    async ({ make }) => {
      const store = await make();
      await seedVaultOn(store, "p1", 500, 0, 0);

      // A reader snapshots the vault, another credit lands, and only then
      // does the reader's own delta apply. A full-row overwrite of the stale
      // row (the old RMW path) would clobber the interleaved credit.
      const stale = await store.getVault("p1");
      await creditVault(store, "p1", "Payee p1", 300, "available", NOW);
      const outcome = await store.applyVaultDelta({
        payee_id: "p1",
        payee_name: stale!.payee_name,
        delta: { available_balance: 200, pending_balance: 0, reserve_balance: 0 },
        create_if_missing: false,
        updated_at: NOW.toISOString(),
      });

      expect(outcome.outcome).toBe("applied");
      expect(appliedVault(outcome).available_balance).toBe(1000);
    },
  );

  it.each(BACKENDS)(
    "$name: the floor guard refuses an overdraft and leaves balances untouched",
    async ({ make }) => {
      const store = await make();
      await seedVaultOn(store, "p1", 500, 0, 0);

      const outcome = await store.applyVaultDelta({
        payee_id: "p1",
        payee_name: "Payee p1",
        delta: { available_balance: -600, pending_balance: 0, reserve_balance: 0 },
        min_balances: { available_balance: 0, pending_balance: 0 },
        create_if_missing: false,
        updated_at: NOW.toISOString(),
      });

      expect(outcome.outcome).toBe("guard_failed");
      const vault = await store.getVault("p1");
      expect(vault!.available_balance).toBe(500);
      expect(vault!.pending_balance).toBe(0);
    },
  );

  it.each(BACKENDS)(
    "$name: a delta on a missing vault is refused without create_if_missing, minted with it",
    async ({ make }) => {
      const store = await make();

      const refused = await store.applyVaultDelta({
        payee_id: "p1",
        payee_name: "Payee p1",
        delta: { available_balance: 100, pending_balance: 0, reserve_balance: 0 },
        create_if_missing: false,
        updated_at: NOW.toISOString(),
      });
      expect(refused.outcome).toBe("not_found");

      const minted = await store.applyVaultDelta({
        payee_id: "p1",
        payee_name: "Payee p1",
        delta: { available_balance: 100, pending_balance: 0, reserve_balance: 0 },
        create_if_missing: true,
        updated_at: NOW.toISOString(),
      });
      expect(minted.outcome).toBe("applied");
      expect(appliedVault(minted).available_balance).toBe(100);
    },
  );

  it.each(BACKENDS)(
    "$name: two parallel credits both apply — no lost update",
    async ({ make }) => {
      const store = await make();
      await seedVaultOn(store, "p1", 0, 0, 0);

      await Promise.all([
        creditVault(store, "p1", "Payee p1", 500, "available", NOW),
        creditVault(store, "p1", "Payee p1", 300, "available", NOW),
      ]);

      const vault = await store.getVault("p1");
      expect(vault!.available_balance).toBe(800);
    },
  );

  it.each(BACKENDS)(
    "$name: two parallel payout holds over thin funds — exactly one wins, cents conserved",
    async ({ make }) => {
      const store = await make();
      await seedVaultOn(store, "p1", 700, 0, 0, "Creator One");

      const results = await Promise.all([
        payoutFromVault(store, { payee_id: "p1", amount_cents: 500, rail: "ach" }, NOW),
        payoutFromVault(store, { payee_id: "p1", amount_cents: 500, rail: "ach" }, NOW),
      ]);

      const oks = results.filter((result) => result.ok);
      const refusals = results.filter((result) => !result.ok);
      expect(oks).toHaveLength(1);
      expect(refusals).toHaveLength(1);
      if (!refusals[0]!.ok) {
        expect(refusals[0]!.code).toBe("insufficient_available");
      }

      const vault = await store.getVault("p1");
      expect(vault!.available_balance).toBe(200);
      expect(vault!.pending_balance).toBe(500);
      expect(vault!.available_balance + vault!.pending_balance + vault!.reserve_balance).toBe(700);
    },
  );
});

describe("migration 0009 — journal chain integrity (H2)", () => {
  it.each(BACKENDS)(
    "$name: a duplicate journal sequence is rejected",
    async ({ make }) => {
      const store = await make();
      const base = {
        kind: "payout_settled" as const,
        ref_type: "baas_transfer",
        ref_id: "t1",
        created_at: NOW.toISOString(),
        sequence: 1,
        prev_hash: GL_GENESIS_HASH,
      };
      await store.insertGlJournal({ ...base, entry_hash: "hash-1", state: "posted" });

      await expect(
        store.insertGlJournal({ ...base, ref_id: "t2", entry_hash: "hash-2", state: "posted" }),
      ).rejects.toThrow();
    },
  );

  it.each(BACKENDS)(
    "$name: engine posts stay linear and hash-linked from genesis",
    async ({ make }) => {
      const store = await make();

      let first;
      let second;
      let third;
      for (const ref of ["r1", "r2", "r3"]) {
        const posted = postedJournalOk(
          await postJournal(
            store,
            { kind: "payout_settled", ref_type: "test", ref_id: ref, legs: balancedLegs(100) },
            NOW,
          ),
        );
        if (ref === "r1") first = posted;
        if (ref === "r2") second = posted;
        if (ref === "r3") third = posted;
      }

      expect(first!.sequence).toBe(1);
      expect(first!.prev_hash).toBe(GL_GENESIS_HASH);
      expect(second!.sequence).toBe(2);
      expect(second!.prev_hash).toBe(first!.entry_hash);
      expect(third!.sequence).toBe(3);
      expect(third!.prev_hash).toBe(second!.entry_hash);
      expect((await store.getLatestGlJournal())!.sequence).toBe(3);
    },
  );

  it.each(BACKENDS)(
    "$name: a stale latest-read loses the sequence race and retries onto the winner",
    async ({ make }) => {
      const store = await make();
      const firstPost = postedJournalOk(
        await postJournal(
          store,
          { kind: "payout_settled", ref_type: "test", ref_id: "r1", legs: balancedLegs(100) },
          NOW,
        ),
      );

      // Simulate a poster whose chain-state read is stale by one journal: it
      // computes sequence 1 (taken), hits the UNIQUE constraint, re-reads,
      // and rebuilds onto the winner instead of forking.
      const originalLatest = store.getLatestGlJournal.bind(store);
      let calls = 0;
      store.getLatestGlJournal = async () => {
        calls += 1;
        if (calls === 1) {
          return undefined; // stale: pretends the chain is still empty
        }
        return originalLatest();
      };

      const secondPost = postedJournalOk(
        await postJournal(
          store,
          { kind: "payout_settled", ref_type: "test", ref_id: "r2", legs: balancedLegs(100) },
          NOW,
        ),
      );

      expect(secondPost.sequence).toBe(2);
      expect(secondPost.prev_hash).toBe(firstPost.entry_hash);
      expect((await store.getLatestGlJournal())!.sequence).toBe(2);
    },
  );
});

describe("migration 0009 — one reversal per transfer (H4)", () => {
  it.each(BACKENDS)(
    "$name: a duplicate reversal transfer_id is rejected",
    async ({ make }) => {
      const store = await make();
      const base = {
        transfer_id: "t1",
        payee_id: "p1",
        amount_cents: 500,
        reason: "payout.failed" as const,
        ledger_transaction_id: null,
        journal_id: null,
        created_at: NOW.toISOString(),
      };
      await store.insertPayoutReversal(base);
      await expect(store.insertPayoutReversal({ ...base })).rejects.toThrow();
      await store.insertPayoutReversal({ ...base, transfer_id: "t2" });
    },
  );

  it.each(BACKENDS)(
    "$name: a replayed reversal webhook is idempotent — funds credit exactly once",
    async ({ make }) => {
      const store = await make();
      await seedVaultOn(store, "p1", 0, 1000, 0, "Creator One");
      const transfer = await store.insertBaasTransfer({
        provider: "column",
        rail: "ach",
        payee_id: "p1",
        payee_name: "Creator One",
        amount_cents: 1000,
        currency: "USD",
        status: "submitted",
        ledger_transaction_id: null,
        created_at: NOW.toISOString(),
        estimated_settlement: null,
      });
      await store.insertPayoutHold({
        transfer_id: transfer.id,
        payee_id: "p1",
        amount_cents: 1000,
        status: "in_flight",
        created_at: NOW.toISOString(),
      });

      const first = await reverseVaultPayout(store, transfer.id, "payout.failed", NOW);
      expect(first.ok).toBe(true);

      // The webhook fires again (retry, double-delivery, operator replay).
      const second = await reverseVaultPayout(store, transfer.id, "payout.failed", NOW);
      expect(second.ok).toBe(true);
      if (first.ok && second.ok) {
        expect(second.idempotent).toBe(true);
        expect(second.reversal.id).toBe(first.reversal.id);
      }

      const vault = await store.getVault("p1");
      expect(vault!.available_balance).toBe(1000); // credited once, not twice
      expect(vault!.pending_balance).toBe(0);
    },
  );
});

describe("migration 0009 — split saga idempotency (H3)", () => {
  function splitInput() {
    return {
      source: "spotify",
      period: "2026-08",
      currency: "USD",
      settle: false,
      rail: "ach" as const,
      line_items: [
        {
          work_id: "work_1",
          work_title: "One Work",
          amount_cents: 10_000,
          splits: [
            { payee_id: "creator_1", payee_name: "Creator One", role: "creator" as const, share_bps: 9500 },
            {
              payee_id: COMPANY_VARIANCE_PAYEE_ID,
              payee_name: "Don Engine Variance",
              role: "other" as const,
              share_bps: 500,
            },
          ],
        },
      ],
    };
  }

  async function wiredStore(make: () => Promise<Store>): Promise<Store> {
    const store = await make();
    await seedVaultOn(store, "creator_1", 0, 0, 0, "Creator One");
    await seedVaultOn(store, COMPANY_VARIANCE_PAYEE_ID, 0, 0, 0, "Don Engine Variance");
    await store.upsertCreatorTaxProfile({
      creator_id: "creator_1",
      tin_verified: 1,
      w9_on_file: 1,
      updated_at: NOW.toISOString(),
    });
    return store;
  }

  function splitValue(result: Awaited<ReturnType<typeof calculateUdrSplits>>): SplitCalculateSuccess["value"] {
    if (!result.ok) {
      throw new Error(`expected ok, got ${result.status} ${result.code}: ${result.message}`);
    }
    return result.value;
  }

  it.each(BACKENDS)(
    "$name: a keyed saga replay returns 409 and never double-credits",
    async ({ make }) => {
      const store = await wiredStore(make);
      const payload = splitInput();

      const first = await calculateUdrSplits(store, { ...payload, idempotency_key: "op-123" });
      const firstValue = splitValue(first);
      expect(firstValue.split_run.idempotency_key).toBe("op-123");

      const creator = await store.getVault("creator_1");
      expect(creator!.pending_balance).toBe(9500);

      const replay = await calculateUdrSplits(store, { ...payload, idempotency_key: "op-123" });
      expect(replay.ok).toBe(false);
      if (!replay.ok) {
        expect(replay.status).toBe(409);
        expect(replay.code).toBe("split_run_already_exists");
        expect(replay.message).toContain(firstValue.split_run.id);
      }

      const creatorAfter = await store.getVault("creator_1");
      expect(creatorAfter!.pending_balance).toBe(9500); // still credited once
    },
  );

  it.each(BACKENDS)(
    "$name: unkeyed runs never collide with each other",
    async ({ make }) => {
      const store = await wiredStore(make);
      const payload = splitInput();

      const first = await calculateUdrSplits(store, { ...payload });
      const second = await calculateUdrSplits(store, { ...payload });
      const firstValue = splitValue(first);
      const secondValue = splitValue(second);
      expect(secondValue.split_run.id).not.toBe(firstValue.split_run.id);
      expect(secondValue.split_run.idempotency_key).toBeNull();

      const creator = await store.getVault("creator_1");
      expect(creator!.pending_balance).toBe(19_000); // both runs credited
    },
  );

  it("the payload validator rejects empty and oversized idempotency keys", () => {
    const empty = validateSplitCalculatePayload({ ...splitInput(), idempotency_key: "   " });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.code).toBe("invalid_idempotency_key");

    const oversized = validateSplitCalculatePayload({
      ...splitInput(),
      idempotency_key: "k".repeat(256),
    });
    expect(oversized.ok).toBe(false);
    if (!oversized.ok) expect(oversized.code).toBe("invalid_idempotency_key");

    const valid = validateSplitCalculatePayload({ ...splitInput(), idempotency_key: "op-123" });
    expect(valid.ok).toBe(true);
  });
});
