import { describe, expect, it } from "vitest";
import { InMemoryStore } from "@/lib/server/inMemoryStore";
import { creditVault, payoutFromVault } from "@/modules/vaults/engine";
import { ingestBaasWebhook, webhookEventId } from "./baas";

/**
 * Ported from EmeraldVal PR #41 src/modules/webhooks/baas.test.ts (head
 * c754bb4): SqliteStore(":memory:") swapped for the repo's InMemoryStore
 * injection pattern, and every Store/engine call awaited against the async
 * contract. Assertions and coverage are unchanged.
 */

describe("ingestBaasWebhook", () => {
  it("returns transfer_not_found for an unknown transfer", async () => {
    const store = new InMemoryStore();
    const result = await ingestBaasWebhook(store, {
      event: "payout.settled",
      transfer_id: "missing",
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe("transfer_not_found");
  });

  it("settles an ACH hold and is idempotent on replay", async () => {
    const store = new InMemoryStore();
    await creditVault(store, "c1", "Yeshua Throne", 800, "available");
    const paid = await payoutFromVault(store, {
      payee_id: "c1",
      amount_cents: 800,
      rail: "ach",
    });
    expect(paid.ok).toBe(true);
    if (!paid.ok) {
      return;
    }
    const first = await ingestBaasWebhook(store, {
      event: "payout.settled",
      transfer_id: paid.transfer.id,
      event_id: "evt_1",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    expect(first.vault?.pending_balance).toBe(0);
    expect(first.idempotent).toBe(false);
    const replay = await ingestBaasWebhook(store, {
      event: "payout.settled",
      transfer_id: paid.transfer.id,
      event_id: "evt_1",
    });
    expect(replay.ok).toBe(true);
    if (!replay.ok) {
      return;
    }
    expect(replay.idempotent).toBe(true);
  });

  it("reverses an in-flight payout on payout.failed", async () => {
    const store = new InMemoryStore();
    await creditVault(store, "c1", "Yeshua Throne", 300, "available");
    const paid = await payoutFromVault(store, {
      payee_id: "c1",
      amount_cents: 300,
      rail: "ach",
    });
    expect(paid.ok).toBe(true);
    if (!paid.ok) {
      return;
    }
    const failed = await ingestBaasWebhook(store, {
      event: "payout.failed",
      transfer_id: paid.transfer.id,
    });
    expect(failed.ok).toBe(true);
    if (!failed.ok) {
      return;
    }
    expect(failed.vault?.available_balance).toBe(300);
    expect(failed.reversal?.reason).toBe("payout.failed");
    expect(webhookEventId({ event: "payout.failed", transfer_id: paid.transfer.id })).toBe(
      `${paid.transfer.id}:payout.failed`,
    );
  });

  it("returns funds on payout.returned after settlement", async () => {
    const store = new InMemoryStore();
    await creditVault(store, "c1", "Yeshua Throne", 150, "available");
    const paid = await payoutFromVault(store, {
      payee_id: "c1",
      amount_cents: 150,
      rail: "rtp",
    });
    expect(paid.ok).toBe(true);
    if (!paid.ok) {
      return;
    }
    const returned = await ingestBaasWebhook(store, {
      event: "payout.returned",
      transfer_id: paid.transfer.id,
    });
    expect(returned.ok).toBe(true);
    if (!returned.ok) {
      return;
    }
    expect(returned.vault?.available_balance).toBe(150);
  });

  it("surfaces settle failures without recording the event", async () => {
    const store = new InMemoryStore();
    await creditVault(store, "c1", "Yeshua Throne", 100, "available");
    const paid = await payoutFromVault(store, {
      payee_id: "c1",
      amount_cents: 100,
      rail: "ach",
    });
    expect(paid.ok).toBe(true);
    if (!paid.ok) {
      return;
    }
    await reverseVaultThenTamper(store, paid.transfer.id);
    const settled = await ingestBaasWebhook(store, {
      event: "payout.settled",
      transfer_id: paid.transfer.id,
    });
    expect(settled.ok).toBe(false);
    expect(
      await store.getWebhookEvent(`${paid.transfer.id}:payout.settled`),
    ).toBeUndefined();
  });

  it("does not record a failed reversal webhook", async () => {
    const store = new InMemoryStore();
    await creditVault(store, "c1", "Yeshua Throne", 100, "available");
    const paid = await payoutFromVault(store, {
      payee_id: "c1",
      amount_cents: 100,
      rail: "ach",
    });
    expect(paid.ok).toBe(true);
    if (!paid.ok) {
      return;
    }
    await store.upsertVault({
      payee_id: "c1",
      payee_name: "Yeshua Throne",
      available_balance: 0,
      pending_balance: 0,
      reserve_balance: 0,
      updated_at: new Date().toISOString(),
    });
    const failed = await ingestBaasWebhook(store, {
      event: "payout.failed",
      transfer_id: paid.transfer.id,
    });
    expect(failed.ok).toBe(false);
    expect(
      await store.getWebhookEvent(`${paid.transfer.id}:payout.failed`),
    ).toBeUndefined();
  });

  it("builds an event id from a provided key", () => {
    expect(
      webhookEventId({
        event: "payout.settled",
        transfer_id: "t1",
        event_id: " custom ",
      }),
    ).toBe("custom");
  });
});

async function reverseVaultThenTamper(
  store: InMemoryStore,
  transferId: string,
): Promise<void> {
  const hold = await store.getPayoutHold(transferId);
  if (hold) {
    await store.updatePayoutHoldStatus(transferId, "reversed");
  }
}
