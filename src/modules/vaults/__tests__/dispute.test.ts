import { describe, expect, it } from "vitest";
import { isIncomingFrozen, isPayoutFrozen, isWorkFrozen } from "../dispute";
import { InMemoryStore } from "@/modules/don/__tests__/inMemoryStore";

describe("isIncomingFrozen truth table", () => {
  it.each([
    { vaultLocked: false, catalogLocked: false, expected: false },
    { vaultLocked: true, catalogLocked: false, expected: true },
    { vaultLocked: false, catalogLocked: true, expected: true },
    { vaultLocked: true, catalogLocked: true, expected: true },
  ])(
    "vault dispute locked=$vaultLocked, catalog dispute locked=$catalogLocked → $expected",
    ({ vaultLocked, catalogLocked, expected }) => {
      const store = new InMemoryStore();
      store.seedVaultDispute("c1", vaultLocked ? 1 : 0);
      store.seedCatalogDispute("trk_01", catalogLocked ? 1 : 0);
      expect(isIncomingFrozen(store, "c1", "trk_01")).toBe(expected);
    },
  );

  it("is frozen when either dispute row exists and is locked", () => {
    const store = new InMemoryStore();
    store.seedCatalogDispute("trk_01", 1);
    expect(isIncomingFrozen(store, "nobody", "trk_01")).toBe(true);
  });
});

describe("isPayoutFrozen truth table", () => {
  it("is true only while the payee's own dispute lock is active", () => {
    const locked = new InMemoryStore();
    locked.seedVaultDispute("c1", 1);
    expect(isPayoutFrozen(locked, "c1")).toBe(true);

    const unlocked = new InMemoryStore();
    unlocked.seedVaultDispute("c1", 0);
    expect(isPayoutFrozen(unlocked, "c1")).toBe(false);

    // A catalog-level lock does not freeze payouts — payouts are payee-scoped.
    const catalogOnly = new InMemoryStore();
    catalogOnly.seedCatalogDispute("trk_01", 1);
    expect(isPayoutFrozen(catalogOnly, "c1")).toBe(false);
  });
});

describe("isWorkFrozen", () => {
  it("is true when the work id is in the locked list and false otherwise", () => {
    expect(isWorkFrozen("trk_01", ["trk_01", "trk_02"])).toBe(true);
    expect(isWorkFrozen("trk_03", ["trk_01", "trk_02"])).toBe(false);
    expect(isWorkFrozen("trk_01", [])).toBe(false);
  });
});
