import { describe, expect, it } from "vitest";
import { readCreatorCompliance } from "../engine";
import { InMemoryStore } from "@/lib/server/inMemoryStore";
import {
  CreatorTaxProfile,
  CreatorYtdEarnings,
  TaxEscrowRecord,
} from "@/modules/don/records";
import { FORM_1099_THRESHOLD_CENTS } from "@/modules/don/constants";

/**
 * Don Engine compliance snapshot (Gen 14, part of spec criterion 3).
 *
 * readCreatorCompliance is Cursor's Phase 2 read path: TIN/W-9 flags come off
 * the stored tax profile (integer 0/1), YTD and escrow come off the store, and
 * requires_1099 flips at exactly 60,000 cents ($600). The withholding math
 * itself (floor(gross x 2400/10000)) is locked by the sibling withholding
 * suite. Adapted mechanically for the real async Store (PR ruling): the tests
 * seed the canonical InMemoryStore and await every read — assertions are
 * byte-identical to the pre-wiring suite.
 */

const TAX_YEAR = 2026;

function taxProfile(overrides: Partial<CreatorTaxProfile> = {}): CreatorTaxProfile {
  return {
    creator_id: "creator_1",
    tin_verified: 1,
    w9_on_file: 1,
    updated_at: "2026-09-10T00:00:00.000Z",
    ...overrides,
  };
}

function ytd(overrides: Partial<CreatorYtdEarnings> = {}): CreatorYtdEarnings {
  return {
    creator_id: "creator_1",
    tax_year: TAX_YEAR,
    gross_cents: 0,
    withheld_cents: 0,
    updated_at: "2026-09-10T00:00:00.000Z",
    ...overrides,
  };
}

function escrowInput(
  overrides: Partial<Omit<TaxEscrowRecord, "id">> = {},
): Omit<TaxEscrowRecord, "id"> {
  return {
    creator_id: "creator_1",
    tax_year: TAX_YEAR,
    gross_cents: 10_000,
    withheld_cents: 2_400,
    net_cents: 7_600,
    tin_verified: 0,
    w9_on_file: 0,
    requires_1099: 0,
    crossed_1099_threshold: 0,
    created_at: "2026-09-10T00:00:00.000Z",
    ...overrides,
  };
}

// Async seed over the canonical InMemoryStore: a verified profile and zero YTD
// by default; `null` seeds nothing (missing row).
async function seededStore(overrides: {
  profile?: CreatorTaxProfile | null;
  ytd?: CreatorYtdEarnings | null;
  escrow?: Array<Omit<TaxEscrowRecord, "id">>;
} = {}): Promise<InMemoryStore> {
  const store = new InMemoryStore();
  if (overrides.profile !== null) {
    await store.upsertCreatorTaxProfile(overrides.profile ?? taxProfile());
  }
  if (overrides.ytd !== null) {
    await store.upsertCreatorYtd(overrides.ytd ?? ytd());
  }
  for (const row of overrides.escrow ?? []) {
    await store.insertTaxEscrow(row);
  }
  return store;
}

describe("readCreatorCompliance", () => {
  it("reports verified TIN and W-9 as true", async () => {
    const store = await seededStore({
      profile: taxProfile({ tin_verified: 1, w9_on_file: 1 }),
    });
    const snapshot = await readCreatorCompliance(store, "creator_1", TAX_YEAR);
    expect(snapshot.tin_verified).toBe(true);
    expect(snapshot.w9_on_file).toBe(true);
  });

  it("reports unverified TIN and W-9 as false", async () => {
    const store = await seededStore({
      profile: taxProfile({ tin_verified: 0, w9_on_file: 0 }),
    });
    const snapshot = await readCreatorCompliance(store, "creator_1", TAX_YEAR);
    expect(snapshot.tin_verified).toBe(false);
    expect(snapshot.w9_on_file).toBe(false);
  });

  it("treats a missing tax profile as fully unverified", async () => {
    const store = await seededStore({ profile: null });
    const snapshot = await readCreatorCompliance(store, "creator_1", TAX_YEAR);
    expect(snapshot.tin_verified).toBe(false);
    expect(snapshot.w9_on_file).toBe(false);
  });

  it("does not count a lone verified flag — both flags must be 1", async () => {
    const store = await seededStore({
      profile: taxProfile({ tin_verified: 1, w9_on_file: 0 }),
    });
    const snapshot = await readCreatorCompliance(store, "creator_1", TAX_YEAR);
    expect(snapshot.tin_verified).toBe(true);
    expect(snapshot.w9_on_file).toBe(false);
  });

  it("passes YTD gross and withheld cents through", async () => {
    const store = await seededStore({
      ytd: ytd({ gross_cents: 123_456, withheld_cents: 29_629 }),
    });
    const snapshot = await readCreatorCompliance(store, "creator_1", TAX_YEAR);
    expect(snapshot.ytd_gross_cents).toBe(123_456);
    expect(snapshot.ytd_withheld_cents).toBe(29_629);
  });

  it("reports zero YTD when no earnings row exists", async () => {
    const store = await seededStore({ ytd: null });
    const snapshot = await readCreatorCompliance(store, "creator_1", TAX_YEAR);
    expect(snapshot.ytd_gross_cents).toBe(0);
    expect(snapshot.ytd_withheld_cents).toBe(0);
    expect(snapshot.requires_1099).toBe(false);
  });

  it("flips requires_1099 exactly at the $600 threshold (60,000 cents)", async () => {
    expect(FORM_1099_THRESHOLD_CENTS).toBe(60_000);
    const below = await readCreatorCompliance(
      await seededStore({ ytd: ytd({ gross_cents: FORM_1099_THRESHOLD_CENTS - 1 }) }),
      "creator_1",
      TAX_YEAR,
    );
    expect(below.requires_1099).toBe(false);

    const at = await readCreatorCompliance(
      await seededStore({ ytd: ytd({ gross_cents: FORM_1099_THRESHOLD_CENTS }) }),
      "creator_1",
      TAX_YEAR,
    );
    expect(at.requires_1099).toBe(true);

    const above = await readCreatorCompliance(
      await seededStore({ ytd: ytd({ gross_cents: FORM_1099_THRESHOLD_CENTS + 1 }) }),
      "creator_1",
      TAX_YEAR,
    );
    expect(above.requires_1099).toBe(true);
  });

  it("returns the creator escrow history untouched", async () => {
    const store = new InMemoryStore();
    const rows = [
      await store.insertTaxEscrow(escrowInput()),
      await store.insertTaxEscrow(
        escrowInput({ gross_cents: 500, withheld_cents: 120, net_cents: 380 }),
      ),
    ];
    const snapshot = await readCreatorCompliance(store, "creator_1", TAX_YEAR);
    expect(snapshot.escrow).toEqual(rows);
  });

  it("scopes the read to the requested creator and tax year", async () => {
    const store = await seededStore();
    await store.insertTaxEscrow(escrowInput({ creator_id: "creator_9", tax_year: 2025 }));
    const snapshot = await readCreatorCompliance(store, "creator_9", 2025);
    expect(snapshot.creator_id).toBe("creator_9");
    expect(snapshot.tax_year).toBe(2025);
    expect(snapshot.escrow).toHaveLength(1);
    expect(snapshot.escrow[0]!.tax_year).toBe(2025);
  });

  it("echoes the creator and tax year in the snapshot", async () => {
    const snapshot = await readCreatorCompliance(await seededStore(), "creator_7", 2024);
    expect(snapshot.creator_id).toBe("creator_7");
    expect(snapshot.tax_year).toBe(2024);
  });
});
