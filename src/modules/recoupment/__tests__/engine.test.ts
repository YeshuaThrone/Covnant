import { describe, expect, it } from "vitest";
import { InMemoryStore } from "@/modules/don/__tests__/inMemoryStore";
import { applyRecoupmentSweep, sweepRecoupment } from "../engine";
import { COMPANY_VARIANCE_PAYEE_ID } from "@/modules/don/constants";

describe("sweepRecoupment", () => {
  it("takes the full bps share while the advance is open", () => {
    expect(
      sweepRecoupment({
        incoming_cents: 10_000,
        recoupment_target_cents: 100_000,
        recoupment_current_cents: 0,
      }),
    ).toEqual({
      recouped_cents: 10_000,
      excess_cents: 0,
      recoupment_current_cents: 10_000,
      recoupment_remaining_cents: 90_000,
      completed: false,
    });
  });

  it("caps the recoup at the remaining advance and passes the rest through", () => {
    expect(
      sweepRecoupment({
        incoming_cents: 10_000,
        recoupment_target_cents: 100_000,
        recoupment_current_cents: 97_000,
      }),
    ).toEqual({
      recouped_cents: 3_000,
      excess_cents: 7_000,
      recoupment_current_cents: 100_000,
      recoupment_remaining_cents: 0,
      completed: true,
    });
  });

  it("applies bps math with floor, not round", () => {
    // 10_000 * 0.0033 bps equivalent: floor(10_000 * 33 / 10_000) = 33
    expect(
      sweepRecoupment({
        incoming_cents: 10_000,
        recoupment_target_cents: 100_000,
        recoupment_current_cents: 0,
        recoupment_bps: 33,
      }).recouped_cents,
    ).toBe(33);
  });

  it("a completed advance passes everything through as excess", () => {
    expect(
      sweepRecoupment({
        incoming_cents: 10_000,
        recoupment_target_cents: 100_000,
        recoupment_current_cents: 100_000,
      }),
    ).toEqual({
      recouped_cents: 0,
      excess_cents: 10_000,
      recoupment_current_cents: 100_000,
      recoupment_remaining_cents: 0,
      completed: true,
    });
  });

  it("zero or negative incoming is a no-op", () => {
    expect(
      sweepRecoupment({
        incoming_cents: 0,
        recoupment_target_cents: 100_000,
        recoupment_current_cents: 0,
      }).recouped_cents,
    ).toBe(0);
  });
});

describe("applyRecoupmentSweep", () => {
  it("routes recouped cents to the platform vault available — never a creator", () => {
    const store = new InMemoryStore();
    store.seedVault("c1", 0, 0, 0);
    store.seedRecoupmentAdvance("c1", 100_000, 0);
    const outcome = applyRecoupmentSweep(store, "c1", "Creator One", 10_000, new Date(), {
      split_run_id: "sr_01",
    });
    expect(outcome.applied).toBe(true);
    expect(outcome.recouped_cents).toBe(10_000);
    expect(store.vaults.get(COMPANY_VARIANCE_PAYEE_ID)?.available_balance).toBe(10_000);
    expect(store.vaults.get("c1")?.available_balance).toBe(0);
  });

  it("credits the excess to the creator after the advance completes", () => {
    const store = new InMemoryStore();
    store.seedVault("c1", 0, 0, 0);
    store.seedRecoupmentAdvance("c1", 100_000, 97_000);
    const outcome = applyRecoupmentSweep(store, "c1", "Creator One", 10_000, new Date());
    expect(outcome.completed).toBe(true);
    expect(outcome.recouped_cents).toBe(3_000);
    expect(outcome.excess_cents).toBe(7_000);
    expect(store.vaults.get(COMPANY_VARIANCE_PAYEE_ID)?.available_balance).toBe(3_000);
    expect(store.vaults.get("c1")?.available_balance).toBe(7_000);
  });

  it("credits excess to pending when the creator's excess target is pending", () => {
    const store = new InMemoryStore();
    store.seedVault("c1", 0, 0, 0);
    store.seedRecoupmentAdvance("c1", 100_000, 100_000);
    applyRecoupmentSweep(store, "c1", "Creator One", 4_000, new Date(), {
      excess_target: "pending",
    });
    expect(store.vaults.get(COMPANY_VARIANCE_PAYEE_ID)).toBeUndefined();
    expect(store.vaults.get("c1")?.pending_balance).toBe(4_000);
  });

  it("writes the recoupment ledger row for a split run", () => {
    const store = new InMemoryStore();
    store.seedVault("c1", 0, 0, 0);
    store.seedRecoupmentAdvance("c1", 100_000, 0);
    applyRecoupmentSweep(store, "c1", "Creator One", 10_000, new Date(), {
      split_run_id: "sr_01",
    });
    expect(store.recoupmentLedger).toHaveLength(1);
    expect(store.recoupmentLedger[0]).toMatchObject({
      creator_id: "c1",
      split_run_id: "sr_01",
      incoming_cents: 10_000,
      recouped_cents: 10_000,
      excess_cents: 0,
    });
  });

  it("passes everything through when the creator has no recoupment advance", () => {
    const store = new InMemoryStore();
    store.seedVault("c1", 0, 0, 0);
    const outcome = applyRecoupmentSweep(store, "c1", "Creator One", 8_000, new Date());
    // No advance → nothing recouped and nothing written here: the caller's
    // normal split flow already credits that creator's share. Crediting the
    // excess again inside the sweep would double-pay.
    expect(outcome.applied).toBe(false);
    expect(outcome.recouped_cents).toBe(0);
    expect(outcome.excess_cents).toBe(8_000);
    expect(store.vaults.get(COMPANY_VARIANCE_PAYEE_ID)).toBeUndefined();
    expect(store.vaults.get("c1")?.available_balance).toBe(0);
    expect(store.recoupmentLedger).toHaveLength(0);
  });
});
