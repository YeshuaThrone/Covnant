import { describe, expect, it } from "vitest";
import { ingestDspWebhook, ingestBaasWebhook } from "../webhooks";
import { InMemoryStore } from "@/lib/server/inMemoryStore";
import {
  seedBaasTransfer,
  seedPayoutHold,
  seedVault,
} from "@/modules/don/__tests__/fixtures";
import { COMPANY_VARIANCE_PAYEE_ID } from "@/modules/don/constants";
import type { CreatorTaxProfile } from "@/modules/don/records";

/**
 * Wiring battery for webhook ingestors (spec criterion 8): event-id
 * idempotency fires BEFORE any financial effect — replays return the prior
 * event and never move money twice.
 */

const NOW = new Date("2026-09-10T12:00:00.000Z");

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

function royaltyPayload() {
  return {
    event: "royalty.report" as const,
    event_id: "evt_dsp_1",
    source: "spotify",
    period: "2026-08",
    currency: "USD",
    rail: "ach" as const,
    split_run_id: undefined as string | undefined,
    line_items: [
      {
        work_id: "work_1",
        work_title: "One Work",
        amount_cents: 10_000,
        splits: [
          { payee_id: "creator_1", payee_name: "Creator One", role: "creator" as const, share_bps: 9500 },
          { payee_id: "platform", payee_name: "Don Engine Variance", role: "other" as const, share_bps: 500 },
        ],
      },
    ],
  };
}

describe("ingestDspWebhook", () => {
  it("ingests a royalty report into a split run once, then replays idempotently", async () => {
    const store = await wiredStore();
    const first = await ingestDspWebhook(store, royaltyPayload(), NOW);
    if (!first.ok) {
      throw new Error(`expected ok, got ${first.status} ${first.code}`);
    }
    expect(first.idempotent).toBe(false);
    expect(first.split?.split_run.gross_cents).toBe(10_000);

    const replay = await ingestDspWebhook(store, royaltyPayload(), NOW);
    if (!replay.ok) {
      throw new Error(`expected ok, got ${replay.status} ${replay.code}`);
    }
    expect(replay.idempotent).toBe(true);
    expect(replay.event.id).toBe(first.event.id);
    expect(replay.split).toBeUndefined();

    // Exactly one journal exists — the replay moved no money.
    const creator = await store.getVault("creator_1");
    expect(creator?.pending_balance).toBe(9_500);
  });

  it("derives a fallback event id so duplicate deliveries stay idempotent", async () => {
    const store = await wiredStore();
    const payload = { ...royaltyPayload(), event_id: undefined };
    const first = await ingestDspWebhook(store, payload, NOW);
    if (!first.ok) {
      throw new Error(`expected ok, got ${first.status} ${first.code}`);
    }
    expect(first.idempotent).toBe(false);
    const replay = await ingestDspWebhook(store, { ...payload }, NOW);
    if (!replay.ok) {
      throw new Error(`expected ok, got ${replay.status} ${replay.code}`);
    }
    expect(replay.idempotent).toBe(true);
  });

  it("reverses a royalty report through the webhook and restores balances", async () => {
    const store = await wiredStore();
    const report = await ingestDspWebhook(store, royaltyPayload(), NOW);
    if (!report.ok || report.split === undefined) {
      throw new Error("expected the report to create a split run");
    }
    const runId = report.split.split_run.id;

    const reversed = await ingestDspWebhook(
      store,
      {
        event: "royalty.reversed",
        event_id: "evt_dsp_rev",
        source: "dsp",
        period: null,
        currency: "USD",
        rail: "rtp",
        split_run_id: runId,
        line_items: [],
      },
      NOW,
    );
    if (!reversed.ok) {
      throw new Error(`expected ok, got ${reversed.status} ${reversed.code}`);
    }
    expect(reversed.idempotent).toBe(false);
    expect(reversed.reversal).toBeDefined();

    const creator = await store.getVault("creator_1");
    const platform = await store.getVault(COMPANY_VARIANCE_PAYEE_ID);
    expect(creator?.pending_balance).toBe(0);
    expect(platform?.pending_balance).toBe(0);

    // Replay the reversal — idempotent, no second financial effect.
    const replay = await ingestDspWebhook(
      store,
      {
        event: "royalty.reversed",
        event_id: "evt_dsp_rev",
        source: "dsp",
        period: null,
        currency: "USD",
        rail: "rtp",
        split_run_id: runId,
        line_items: [],
      },
      NOW,
    );
    if (!replay.ok) {
      throw new Error(`expected ok, got ${replay.status} ${replay.code}`);
    }
    expect(replay.idempotent).toBe(true);
  });
});

describe("ingestBaasWebhook", () => {
  async function payoutStore(): Promise<{ store: InMemoryStore; transferId: string }> {
    const store = await wiredStore();
    // The payout lifecycle holds the money on send: available → pending.
    await store.upsertVault({
      payee_id: "creator_1",
      payee_name: "Creator One",
      available_balance: 0,
      pending_balance: 1_000,
      reserve_balance: 0,
      updated_at: NOW.toISOString(),
    });
    const transfer = await seedBaasTransfer(store, "creator_1", {
      status: "submitted",
      amount_cents: 1_000,
    });
    await seedPayoutHold(store, transfer.id, "creator_1", 1_000, "in_flight");
    return { store, transferId: transfer.id };
  }

  it("settles a payout once, then replays idempotently", async () => {
    const { store, transferId } = await payoutStore();
    const first = await ingestBaasWebhook(
      store,
      { event: "payout.settled", transfer_id: transferId, event_id: "evt_baas_1" },
      NOW,
    );
    if (!first.ok) {
      throw new Error(`expected ok, got ${first.status} ${first.code}`);
    }
    expect(first.idempotent).toBe(false);
    const settledVault = await store.getVault("creator_1");
    expect(settledVault?.pending_balance).toBe(0);
    const transfer = await store.getBaasTransfer(transferId);
    expect(transfer?.status).toBe("settled");

    const replay = await ingestBaasWebhook(
      store,
      { event: "payout.settled", transfer_id: transferId, event_id: "evt_baas_1" },
      NOW,
    );
    if (!replay.ok) {
      throw new Error(`expected ok, got ${replay.status} ${replay.code}`);
    }
    expect(replay.idempotent).toBe(true);
    const afterReplay = await store.getVault("creator_1");
    expect(afterReplay?.pending_balance).toBe(0);
    expect(afterReplay?.available_balance).toBe(0);
  });

  it("returns a payout to available on payout.returned", async () => {
    const { store, transferId } = await payoutStore();
    const result = await ingestBaasWebhook(
      store,
      { event: "payout.returned", transfer_id: transferId, event_id: "evt_baas_2" },
      NOW,
    );
    if (!result.ok) {
      throw new Error(`expected ok, got ${result.status} ${result.code}`);
    }
    expect(result.idempotent).toBe(false);
    const vault = await store.getVault("creator_1");
    expect(vault?.available_balance).toBe(1_000);
    expect(vault?.pending_balance).toBe(0);

    const replay = await ingestBaasWebhook(
      store,
      { event: "payout.returned", transfer_id: transferId, event_id: "evt_baas_2" },
      NOW,
    );
    if (!replay.ok) {
      throw new Error(`expected ok, got ${replay.status} ${replay.code}`);
    }
    expect(replay.idempotent).toBe(true);
    const afterReplay = await store.getVault("creator_1");
    expect(afterReplay?.available_balance).toBe(1_000);
  });

  it("404s an unknown transfer", async () => {
    const store = await wiredStore();
    const result = await ingestBaasWebhook(
      store,
      { event: "payout.settled", transfer_id: "trf_missing", event_id: "evt_baas_3" },
      NOW,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(404);
      expect(result.code).toBe("transfer_not_found");
    }
  });
});
