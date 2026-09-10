import { describe, expect, it } from "vitest";
import { InMemoryStore } from "@/modules/don/__tests__/inMemoryStore";
import { creditVault, releaseVaultPending, reverseVaultPayout, settleVaultPayout } from "../engine";
import { holdPayout } from "../balances";

const NOW = new Date("2026-09-10T12:00:00.000Z");

describe("creditVault", () => {
  it("creates the vault on first credit", () => {
    const store = new InMemoryStore();
    const vault = creditVault(store, "c1", "Creator One", 500, "available", NOW);
    expect(vault).toMatchObject({
      available_balance: 500,
      pending_balance: 0,
      reserve_balance: 0,
    });
  });

  it("credits pending and reserve targets onto an existing vault", () => {
    const store = new InMemoryStore();
    store.seedVault("c1", 100, 0, 0);
    creditVault(store, "c1", "Creator One", 200, "pending", NOW);
    const vault = creditVault(store, "c1", "Creator One", 300, "reserve", NOW);
    expect(vault).toMatchObject({
      available_balance: 100,
      pending_balance: 200,
      reserve_balance: 300,
    });
  });
});

describe("releaseVaultPending", () => {
  it("moves pending to available and reports what released", () => {
    const store = new InMemoryStore();
    store.seedVault("c1", 100, 700, 0);
    const result = releaseVaultPending(store, "c1", 400, NOW);
    if (!result.ok) throw new Error("expected release to succeed");
    expect(result.released_cents).toBe(400);
    expect(result.vault).toMatchObject({ available_balance: 500, pending_balance: 300 });
  });

  it("releases all releasable pending when amount is undefined", () => {
    const store = new InMemoryStore();
    store.seedVault("c1", 0, 700, 0);
    const result = releaseVaultPending(store, "c1", undefined, NOW);
    if (!result.ok) throw new Error("expected release to succeed");
    expect(result.released_cents).toBe(700);
    expect(result.vault.pending_balance).toBe(0);
    expect(result.vault.available_balance).toBe(700);
  });

  it("excludes in-flight payout holds from the releasable pending", () => {
    const store = new InMemoryStore();
    store.seedVault("c1", 0, 1000, 0);
    // 700 is locked in an in-flight payout hold — only 300 may release.
    store.seedPayoutHold("tx_1", "c1", 700, "in_flight");
    const result = releaseVaultPending(store, "c1", undefined, NOW);
    if (!result.ok) throw new Error("expected release to succeed");
    expect(result.released_cents).toBe(300);
  });

  it("refuses to release more than releasable pending", () => {
    const store = new InMemoryStore();
    store.seedVault("c1", 0, 1000, 0);
    store.seedPayoutHold("tx_1", "c1", 700, "in_flight");
    const result = releaseVaultPending(store, "c1", 400, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(422);
      expect(result.code).toBe("insufficient_pending");
    }
  });

  it("404s when the vault does not exist", () => {
    const store = new InMemoryStore();
    const result = releaseVaultPending(store, "ghost", 1, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(404);
      expect(result.code).toBe("vault_not_found");
    }
  });
});

describe("settleVaultPayout", () => {
  function seeded(): { store: InMemoryStore; transferId: string } {
    const store = new InMemoryStore();
    store.seedVault("c1", 300, 700, 0);
    store.seedBaasTransfer("tx_1", "c1", { amount_cents: 700 });
    store.seedPayoutHold("tx_1", "c1", 700, "in_flight");
    return { store, transferId: "tx_1" };
  }

  it("clears the in-flight hold from pending on settlement", () => {
    const { store, transferId } = seeded();
    const result = settleVaultPayout(store, transferId, NOW);
    if (!result.ok) throw new Error("expected settlement to succeed");
    expect(result.idempotent).toBe(false);
    expect(result.vault).toMatchObject({ available_balance: 300, pending_balance: 0 });
    expect(store.getPayoutHold(transferId)?.status).toBe("settled");
    expect(store.getBaasTransfer(transferId)?.status).toBe("settled");
  });

  it("re-settlement is idempotent", () => {
    const { store, transferId } = seeded();
    settleVaultPayout(store, transferId, NOW);
    const again = settleVaultPayout(store, transferId, NOW);
    if (!again.ok) throw new Error("expected re-settlement to succeed");
    expect(again.idempotent).toBe(true);
    expect(again.vault.pending_balance).toBe(0);
  });

  it("returns 409 when the payout was already reversed", () => {
    const { store, transferId } = seeded();
    store.updatePayoutHoldStatus(transferId, "reversed");
    const result = settleVaultPayout(store, transferId, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(409);
      expect(result.code).toBe("payout_already_reversed");
    }
  });

  it("404s for an unknown transfer", () => {
    const store = new InMemoryStore();
    const result = settleVaultPayout(store, "ghost", NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(404);
  });

  it("marks a linked ledger transaction settled", () => {
    const { store, transferId } = seeded();
    const ledger = store.seedLedgerTransaction({ payee_id: "c1" });
    store.seedBaasTransfer(transferId, "c1", { ledger_transaction_id: ledger.id });
    settleVaultPayout(store, transferId, NOW);
    expect(store.getLedgerTransaction(ledger.id)?.status).toBe("settled");
    expect(store.getLedgerTransaction(ledger.id)?.baas_transfer_id).toBe(transferId);
  });
});

describe("reverseVaultPayout", () => {
  it("in-flight hold: pending returns to available and the hold reverses", () => {
    const store = new InMemoryStore();
    store.seedVault("c1", 300, 700, 0);
    store.seedBaasTransfer("tx_1", "c1", { amount_cents: 700 });
    store.seedPayoutHold("tx_1", "c1", 700, "in_flight");

    const result = reverseVaultPayout(store, "tx_1", "payout.failed", NOW);
    if (!result.ok) throw new Error("expected reversal to succeed");
    expect(result.idempotent).toBe(false);
    expect(result.vault).toMatchObject({ available_balance: 1000, pending_balance: 0 });
    expect(store.getPayoutHold("tx_1")?.status).toBe("reversed");
    expect(store.getBaasTransfer("tx_1")?.status).toBe("failed");
    expect(result.reversal.amount_cents).toBe(700);
  });

  it("settled payout: money returns to available from the FBO side", () => {
    const store = new InMemoryStore();
    store.seedVault("c1", 0, 0, 0);
    store.seedBaasTransfer("tx_1", "c1", { amount_cents: 250 });
    store.seedPayoutHold("tx_1", "c1", 250, "settled");

    const result = reverseVaultPayout(store, "tx_1", "payout.returned", NOW);
    if (!result.ok) throw new Error("expected reversal to succeed");
    expect(result.vault.available_balance).toBe(250);
    expect(store.getBaasTransfer("tx_1")?.status).toBe("returned");
  });

  it("reversal is idempotent", () => {
    const store = new InMemoryStore();
    store.seedVault("c1", 0, 100, 0);
    store.seedBaasTransfer("tx_1", "c1");
    store.seedPayoutHold("tx_1", "c1", 100, "in_flight");
    const first = reverseVaultPayout(store, "tx_1", "payout.returned", NOW);
    const second = reverseVaultPayout(store, "tx_1", "payout.returned", NOW);
    if (!first.ok || !second.ok) throw new Error("expected both reversals to succeed");
    expect(second.idempotent).toBe(true);
    expect(second.reversal.id).toBe(first.reversal.id);
    expect(store.payoutReversals).toHaveLength(1);
  });

  it("refuses to reverse an in-flight hold when pending can no longer cover it", () => {
    const store = new InMemoryStore();
    store.seedVault("c1", 0, 100, 0);
    store.seedBaasTransfer("tx_1", "c1", { amount_cents: 500 });
    store.seedPayoutHold("tx_1", "c1", 500, "in_flight");
    // Pending drained behind the engine's back — the hold can no longer reverse.
    const vault = store.getVault("c1");
    if (vault) vault.pending_balance = 0;
    const result = reverseVaultPayout(store, "tx_1", "payout.failed", NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(422);
      expect(result.code).toBe("insufficient_pending");
    }
  });

  it("404s for an unknown transfer", () => {
    const store = new InMemoryStore();
    const result = reverseVaultPayout(store, "ghost", "payout.failed", NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(404);
  });
});

describe("hold → settle vs hold → reverse round trip", () => {
  it("settlement then reversal restores the original buckets via the FBO side", () => {
    const store = new InMemoryStore();
    const before = store.seedVault("c1", 500, 500, 0);
    store.seedBaasTransfer("tx_1", "c1", { amount_cents: 500 });

    // available → pending hold
    const held = holdPayout(before, 500);
    if (!held.ok) throw new Error("expected hold to succeed");
    store.seedPayoutHold("tx_1", "c1", 500, "in_flight");

    // settlement clears pending
    const settled = settleVaultPayout(store, "tx_1", NOW);
    if (!settled.ok) throw new Error("expected settlement to succeed");
    expect(settled.vault.pending_balance).toBe(0);

    // payout bounced later: settled-payout reversal re-credits available
    const reversed = reverseVaultPayout(store, "tx_1", "payout.returned", NOW);
    if (!reversed.ok) throw new Error("expected reversal to succeed");
    expect(reversed.vault.available_balance).toBe(1000);
    expect(reversed.vault.pending_balance).toBe(0);
    // Total money constant across the whole trip.
    expect(
      reversed.vault.available_balance +
        reversed.vault.pending_balance +
        reversed.vault.reserve_balance,
    ).toBe(1000);
  });
});
