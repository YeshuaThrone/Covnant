import { describe, expect, it } from "vitest";
import { calculateUdrSplits, type SplitCalculateSuccess } from "../udrSplits";
import { InMemoryStore } from "@/lib/server/inMemoryStore";
import { seedVault, seedRecoupmentAdvance } from "@/modules/don/__tests__/fixtures";
import type { CreatorTaxProfile } from "@/modules/don/records";
import {
  COMPANY_VARIANCE_PAYEE_ID,
  GL_GENESIS_HASH,
} from "@/modules/don/constants";

/**
 * Wiring battery for the UDR orchestrator (spec criteria 1, 2, 4, 5, 6).
 *
 * calculateUdrSplits wires the sanctified primitives (splitEngine allocation,
 * dust, withholding, recoupment sweep, dispute routing, GL posting) — these
 * tests lock the wiring, not the math: zero balance, dust destination,
 * withholding floor, frozen-payee reserve routing, recoupment-to-platform,
 * balanced hash-chained GL, and sandbox-rail settlement ETAs.
 */

const NOW = new Date("2026-09-10T12:00:00.000Z");

function verifiedProfile(creatorId = "creator_1"): CreatorTaxProfile {
  return {
    creator_id: creatorId,
    tin_verified: 1,
    w9_on_file: 1,
    updated_at: NOW.toISOString(),
  };
}

function input(
  overrides: Partial<Parameters<typeof calculateUdrSplits>[1]> = {},
): Parameters<typeof calculateUdrSplits>[1] {
  return {
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
    ...overrides,
  };
}

async function wiredStore(): Promise<InMemoryStore> {
  const store = new InMemoryStore();
  await seedVault(store, "creator_1", 0, 0, 0, "Creator One");
  await seedVault(store, COMPANY_VARIANCE_PAYEE_ID, 0, 0, 0, "Don Engine Variance");
  await store.upsertCreatorTaxProfile(verifiedProfile());
  return store;
}

function value(result: Awaited<ReturnType<typeof calculateUdrSplits>>): SplitCalculateSuccess["value"] {
  if (!result.ok) {
    throw new Error(`expected ok, got ${result.status} ${result.code}: ${result.message}`);
  }
  return result.value;
}

describe("calculateUdrSplits — zero balance and routing", () => {
  it("credits creator pending (non-settle) and platform available, zero_balance true", async () => {
    const store = await wiredStore();
    const result = value(await calculateUdrSplits(store, input()));

    expect(result.zero_balance).toBe(true);
    const creator = await store.getVault("creator_1");
    expect(creator?.pending_balance).toBe(9_500);
    expect(creator?.available_balance).toBe(0);
    expect(creator?.reserve_balance).toBe(0);
    const platform = await store.getVault(COMPANY_VARIANCE_PAYEE_ID);
    expect(platform?.pending_balance).toBe(500);
  });

  it("conserves every cent: allocations + dust === gross", async () => {
    const store = await wiredStore();
    const result = value(
      await calculateUdrSplits(store, input({ line_items: [input().line_items[0]!] })),
    );
    const gross = result.split_run.gross_cents;
    const allocated = result.line_items.reduce(
      (sum, item) =>
        sum + item.splits.reduce((s, split) => s + split.amount_cents, 0),
      0,
    );
    const dust = result.company_dust_ledger.reduce((s, row) => s + row.amount_cents, 0);
    expect(allocated + dust).toBe(gross);
  });

  it("routes company dust to the platform payee only — never a creator", async () => {
    const store = await wiredStore();
    // 999 cents at 9500/500 bps: floor(999 x 0.95) = 949, floor(999 x 0.05)
    // = 49 → 1 cent of dust to the platform payee.
    const result = value(
      await calculateUdrSplits(store, input({ line_items: [
        {
          work_id: "work_dust",
          work_title: "Dusty Work",
          amount_cents: 999,
          splits: [
            { payee_id: "creator_1", payee_name: "Creator One", role: "creator", share_bps: 9500 },
            { payee_id: "platform", payee_name: "Don Engine Variance", role: "other", share_bps: 500 },
          ],
        },
      ] })),
    );
    expect(result.company_dust_ledger.length).toBeGreaterThan(0);
    for (const row of result.company_dust_ledger) {
      expect(row.variance_account_id).toBe(COMPANY_VARIANCE_PAYEE_ID);
      expect(row.amount_cents).toBe(1);
    }
    const platform = await store.getVault(COMPANY_VARIANCE_PAYEE_ID);
    expect(platform?.pending_balance).toBe(49 + 1);
  });
});

describe("calculateUdrSplits — withholding seam", () => {
  it("withholds 24% to creator reserve when TIN/W-9 unverified", async () => {
    // No tax profile seeded → the creator resolves unverified.
    const store = new InMemoryStore();
    await seedVault(store, "creator_1", 0, 0, 0, "Creator One");
    await seedVault(store, COMPANY_VARIANCE_PAYEE_ID, 0, 0, 0, "Don Engine Variance");
    const result = value(
      await calculateUdrSplits(store, input({ line_items: [
        {
          work_id: "work_1",
          work_title: "One Work",
          amount_cents: 10_000,
          splits: [
            { payee_id: "creator_1", payee_name: "Creator One", role: "creator", share_bps: 10000 },
          ],
        },
      ] })),
    );
    expect(result.withholding).toHaveLength(1);
    expect(result.withholding[0]!.withheld_cents).toBe(2_400);
    expect(result.withholding[0]!.net_cents).toBe(7_600);
    const creator = await store.getVault("creator_1");
    expect(creator?.reserve_balance).toBe(2_400);
    expect(creator?.pending_balance).toBe(7_600);
  });

  it("writes a zero-withheld escrow row for a verified creator", async () => {
    const store = await wiredStore();
    const result = value(await calculateUdrSplits(store, input()));
    expect(result.withholding).toHaveLength(1);
    expect(result.withholding[0]!.withheld_cents).toBe(0);
    const creator = await store.getVault("creator_1");
    expect(creator?.pending_balance).toBe(9_500);
    expect(creator?.reserve_balance).toBe(0);
  });
});

describe("calculateUdrSplits — recoupment and disputes", () => {
  it("sweeps recoupment to platform available before crediting the creator", async () => {
    const store = await wiredStore();
    await seedRecoupmentAdvance(store, "creator_1", 100_000, 0, 10_000);
    const result = value(
      await calculateUdrSplits(store, input({ line_items: [
        {
          work_id: "work_1",
          work_title: "One Work",
          amount_cents: 10_000,
          splits: [
            { payee_id: "creator_1", payee_name: "Creator One", role: "creator", share_bps: 10000 },
          ],
        },
      ] })),
    );
    expect(result.recoupment).toHaveLength(1);
    expect(result.recoupment[0]!.recouped_cents).toBe(10_000);
    expect(result.recoupment[0]!.completed).toBe(false);
    const platform = await store.getVault(COMPANY_VARIANCE_PAYEE_ID);
    expect(platform?.available_balance).toBe(10_000);
    const creator = await store.getVault("creator_1");
    expect(creator?.pending_balance).toBe(0);
  });

  it("routes a dispute-frozen payee to reserve", async () => {
    const store = await wiredStore();
    await store.upsertVaultDispute({
      payee_id: "creator_1",
      locked: 1,
      line_item_id: null,
      frozen_from_available: 0,
      frozen_from_pending: 0,
      updated_at: NOW.toISOString(),
    });
    const result = value(await calculateUdrSplits(store, input()));
    const creator = await store.getVault("creator_1");
    expect(creator?.reserve_balance).toBe(9_500);
    expect(creator?.pending_balance).toBe(0);
    expect(result.zero_balance).toBe(true);
  });
});

describe("calculateUdrSplits — GL journals", () => {
  it("posts one balanced journal per run, hash-chained off the genesis", async () => {
    const store = await wiredStore();
    const result = value(await calculateUdrSplits(store, input()));
    const journals = await store.listGlJournalsByRef("split_run", result.split_run.id);
    expect(journals).toHaveLength(1);
    const journal = journals[0]!;
    expect(journal.prev_hash).toBe(GL_GENESIS_HASH);

    const legs = await store.listGlEntriesByJournal(journal.id);
    const debits = legs.reduce((s, leg) => s + leg.debit_cents, 0);
    const credits = legs.reduce((s, leg) => s + leg.credit_cents, 0);
    expect(debits).toBe(credits);
    expect(debits).toBe(result.split_run.gross_cents);
    // The FBO cash debit anchors the journal; vault credits balance it.
    const fbo = legs.find((leg) => !leg.account.startsWith("vault:"));
    expect(fbo?.debit_cents).toBe(result.split_run.gross_cents);
  });

  it("chains the second run's journal onto the first run's hash", async () => {
    const store = await wiredStore();
    const first = value(await calculateUdrSplits(store, input()));
    const second = value(await calculateUdrSplits(store, input({ period: "2026-09" })));
    const [j1] = await store.listGlJournalsByRef("split_run", first.split_run.id);
    const [j2] = await store.listGlJournalsByRef("split_run", second.split_run.id);
    expect(j1!.prev_hash).toBe(GL_GENESIS_HASH);
    expect(j2!.prev_hash).toBe(j1!.entry_hash);
  });
});

describe("calculateUdrSplits — sandbox settlement rails", () => {
  it("RTP settles immediately in sandbox mode", async () => {
    const store = await wiredStore();
    const result = value(await calculateUdrSplits(store, input({ settle: true, rail: "rtp" })));
    expect(result.settlement).not.toBeNull();
    expect(result.settlement!.rail).toBe("rtp");
    // One transfer per payee (creator + platform share). The sandbox
    // adapter stamps ETAs off the real clock — assert "immediate".
    expect(result.settlement!.transfers).toHaveLength(2);
    for (const transfer of result.settlement!.transfers) {
      expect(transfer.estimated_settlement).not.toBeNull();
      const eta = new Date(transfer.estimated_settlement!).getTime();
      expect(eta).toBeGreaterThan(Date.now() - 60_000);
      expect(eta).toBeLessThan(Date.now() + 60_000);
    }
  });

  it("ACH settles +3 days in sandbox mode", async () => {
    const store = await wiredStore();
    const result = value(await calculateUdrSplits(store, input({ settle: true, rail: "ach" })));
    // The sandbox adapter stamps ETAs off the real clock — assert the 3-day
    // delta with a minute of tolerance.
    const etaRaw = result.settlement!.transfers[0]!.estimated_settlement;
    expect(etaRaw).not.toBeNull();
    const eta = new Date(etaRaw!).getTime();
    const threeDaysMs = 3 * 24 * 60 * 60 * 1000;
    expect(eta - Date.now()).toBeGreaterThan(threeDaysMs - 60_000);
    expect(eta - Date.now()).toBeLessThan(threeDaysMs + 60_000);
  });

  it("non-settle runs leave ledger rows pending_settlement and create no transfers", async () => {
    const store = await wiredStore();
    const result = value(await calculateUdrSplits(store, input()));
    expect(result.settlement).toBeNull();
    const rows = await store.listLedgerTransactionsByRun(result.split_run.id);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.status).toBe("pending_settlement");
    }
  });
});

describe("calculateUdrSplits — validation failures", () => {
  it("rejects shares that do not sum to 10,000 bps", async () => {
    const store = await wiredStore();
    const result = await calculateUdrSplits(store, input({ line_items: [
      {
        work_id: "work_1",
        work_title: "One Work",
        amount_cents: 10_000,
        splits: [
          { payee_id: "creator_1", payee_name: "Creator One", role: "creator", share_bps: 4000 },
          { payee_id: "platform", payee_name: "Don Engine Variance", role: "other", share_bps: 5000 },
        ],
      },
    ] }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(422);
    }
  });
});
