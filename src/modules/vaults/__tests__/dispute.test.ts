import { describe, expect, it } from "vitest";
import { isIncomingFrozen, isPayoutFrozen, isWorkFrozen } from "../dispute";
import { InMemoryStore } from "@/lib/server/inMemoryStore";
import { seedCatalogDispute, seedVaultDispute } from "@/modules/don/__tests__/fixtures";

describe("isIncomingFrozen truth table", () => {
  it.each([
    { vaultLocked: false, catalogLocked: false, expected: false },
    { vaultLocked: true, catalogLocked: false, expected: true },
    { vaultLocked: false, catalogLocked: true, expected: true },
    { vaultLocked: true, catalogLocked: true, expected: true },
  ])(
    "vault dispute locked=$vaultLocked, catalog dispute locked=$catalogLocked → $expected",
    async ({ vaultLocked, catalogLocked, expected }) => {
      const store = new InMemoryStore();
      await seedVaultDispute(store, "c1", vaultLocked ? 1 : 0);
      await seedCatalogDispute(store, "trk_01", catalogLocked ? 1 : 0);
      expect(await isIncomingFrozen(store, "c1", "trk_01")).toBe(expected);
    },
  );

  it("is frozen when either dispute row exists and is locked", async () => {
    const store = new InMemoryStore();
    await seedCatalogDispute(store, "trk_01", 1);
    expect(await isIncomingFrozen(store, "nobody", "trk_01")).toBe(true);
  });
});

describe("isPayoutFrozen truth table", () => {
  it("is true only while the payee's own dispute lock is active", async () => {
    const locked = new InMemoryStore();
    await seedVaultDispute(locked, "c1", 1);
    expect(await isPayoutFrozen(locked, "c1")).toBe(true);

    const unlocked = new InMemoryStore();
    await seedVaultDispute(unlocked, "c1", 0);
    expect(await isPayoutFrozen(unlocked, "c1")).toBe(false);

    // A catalog-level lock does not freeze payouts — payouts are payee-scoped.
    const catalogOnly = new InMemoryStore();
    await seedCatalogDispute(catalogOnly, "trk_01", 1);
    expect(await isPayoutFrozen(catalogOnly, "c1")).toBe(false);
  });
});

describe("isWorkFrozen", () => {
  it("is true when the work id is in the locked list and false otherwise", () => {
    expect(isWorkFrozen("trk_01", ["trk_01", "trk_02"])).toBe(true);
    expect(isWorkFrozen("trk_03", ["trk_01", "trk_02"])).toBe(false);
    expect(isWorkFrozen("trk_01", [])).toBe(false);
  });
});
