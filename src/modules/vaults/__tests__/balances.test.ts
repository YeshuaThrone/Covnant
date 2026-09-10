import { describe, expect, it } from "vitest";
import {
  creditBalances,
  debitBalances,
  debitPending,
  emptyVaultBalances,
  freezeIntoReserve,
  holdPayout,
  releasePending,
  reversePayoutHold,
  unfreezeFromReserve,
} from "../balances";
import type { SovereignVaultRecord } from "@/modules/don/records";

function vault(overrides: Partial<SovereignVaultRecord> = {}): SovereignVaultRecord {
  return {
    payee_id: "c1",
    payee_name: "Creator One",
    available_balance: 1000,
    pending_balance: 500,
    reserve_balance: 250,
    updated_at: "2026-09-10T00:00:00.000Z",
    ...overrides,
  };
}

describe("creditBalances", () => {
  it("credits each bucket without touching the others", () => {
    expect(creditBalances(vault(), 100, "available")).toMatchObject({
      available_balance: 1100,
      pending_balance: 500,
      reserve_balance: 250,
    });
    expect(creditBalances(vault(), 100, "pending")).toMatchObject({
      available_balance: 1000,
      pending_balance: 600,
    });
    expect(creditBalances(vault(), 100, "reserve")).toMatchObject({
      available_balance: 1000,
      reserve_balance: 350,
    });
  });

  it("refuses negative amounts", () => {
    expect(() => creditBalances(vault(), -1, "available")).toThrow(
      "creditBalances: amount_cents must be >= 0",
    );
  });

  it("returns a new record and never mutates", () => {
    const original = vault();
    creditBalances(original, 100, "available");
    expect(original.available_balance).toBe(1000);
  });
});

describe("debitBalances", () => {
  it("debits each bucket without touching the others", () => {
    expect(debitBalances(vault(), 400, "available")).toMatchObject({
      available_balance: 600,
      pending_balance: 500,
      reserve_balance: 250,
    });
    expect(debitBalances(vault(), 400, "pending")).toMatchObject({
      pending_balance: 100,
      available_balance: 1000,
    });
    expect(debitBalances(vault(), 250, "reserve")).toMatchObject({
      reserve_balance: 0,
      available_balance: 1000,
    });
  });

  it("refuses to go negative on any bucket", () => {
    expect(() => debitBalances(vault(), 1001, "available")).toThrow(
      "debitBalances: insufficient available balance",
    );
    expect(() => debitBalances(vault(), 501, "pending")).toThrow(
      "debitBalances: insufficient pending balance",
    );
    expect(() => debitBalances(vault(), 251, "reserve")).toThrow(
      "debitBalances: insufficient reserve balance",
    );
  });

  it("allows debiting the exact balance to zero", () => {
    expect(debitBalances(vault(), 1000, "available").available_balance).toBe(0);
  });

  it("refuses negative amounts", () => {
    expect(() => debitBalances(vault(), -5, "available")).toThrow(
      "debitBalances: amount_cents must be >= 0",
    );
  });
});

describe("freezeIntoReserve / unfreezeFromReserve", () => {
  it("moves available into reserve keeping the total constant", () => {
    const frozen = freezeIntoReserve(vault(), 400);
    expect(frozen.available_balance).toBe(600);
    expect(frozen.reserve_balance).toBe(650);
    expect(frozen.available_balance + frozen.pending_balance + frozen.reserve_balance).toBe(
      1750,
    );
  });

  it("unfreezing reverses the freeze exactly", () => {
    const frozen = freezeIntoReserve(vault(), 400);
    const thawed = unfreezeFromReserve(frozen, 400);
    expect(thawed).toMatchObject(vault());
  });

  it("refuses freezing more than available", () => {
    expect(() => freezeIntoReserve(vault(), 1001)).toThrow(
      "debitBalances: insufficient available balance",
    );
  });

  it("refuses unfreezing more than reserve", () => {
    expect(() => unfreezeFromReserve(vault(), 251)).toThrow(
      "debitBalances: insufficient reserve balance",
    );
  });
});

describe("payout-hold helpers", () => {
  it("holdPayout moves available to pending", () => {
    const held = holdPayout(vault(), 700);
    expect(held).toEqual({
      ok: true,
      balances: {
        available_balance: 300,
        pending_balance: 1200,
        reserve_balance: 250,
      },
    });
  });

  it("holdPayout refuses more than available", () => {
    expect(holdPayout(vault(), 1001)).toEqual({
      ok: false,
      code: "insufficient_available",
    });
  });

  it("debitPending clears the settled hold from pending", () => {
    const held = holdPayout(vault(), 700);
    if (!held.ok) throw new Error("expected hold to succeed");
    const cleared = debitPending(held.balances, 700);
    expect(cleared).toEqual({
      ok: true,
      balances: {
        available_balance: 300,
        pending_balance: 500,
        reserve_balance: 250,
      },
    });
  });

  it("debitPending refuses more than pending", () => {
    expect(debitPending(vault(), 501)).toEqual({
      ok: false,
      code: "insufficient_pending",
    });
  });

  it("releasePending caps at pending and reports what released", () => {
    const released = releasePending(vault(), 10_000);
    expect(released).toEqual({
      ok: true,
      balances: {
        available_balance: 1500,
        pending_balance: 0,
        reserve_balance: 250,
      },
      released_cents: 500,
    });
  });

  it("releasePending releases an exact amount and zero is a no-op release", () => {
    expect(releasePending(vault(), 200)).toMatchObject({ released_cents: 200 });
    expect(releasePending(vault(), 0)).toMatchObject({
      released_cents: 0,
      balances: {
        available_balance: 1000,
        pending_balance: 500,
        reserve_balance: 250,
      },
    });
  });

  it("reversePayoutHold gives the pending hold back to available", () => {
    const reversed = reversePayoutHold(vault(), 300);
    expect(reversed).toEqual({
      ok: true,
      balances: {
        available_balance: 1300,
        pending_balance: 200,
        reserve_balance: 250,
      },
    });
    expect(reversePayoutHold(vault(), 501)).toEqual({
      ok: false,
      code: "insufficient_pending",
    });
  });

  it("hold helpers refuse negative amounts", () => {
    expect(holdPayout(vault(), -1)).toEqual({ ok: false, code: "invalid_amount" });
    expect(debitPending(vault(), -1)).toEqual({ ok: false, code: "invalid_amount" });
    expect(reversePayoutHold(vault(), -1)).toEqual({ ok: false, code: "invalid_amount" });
    expect(releasePending(vault(), -1)).toEqual({ ok: false, code: "invalid_amount" });
  });
});

describe("emptyVaultBalances", () => {
  it("returns zero balances", () => {
    expect(emptyVaultBalances()).toEqual({
      available_balance: 0,
      pending_balance: 0,
      reserve_balance: 0,
    });
  });
});
