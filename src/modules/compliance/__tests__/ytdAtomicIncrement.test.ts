/**
 * YTD atomic-increment regression (migration 0057, audit note_c5ksDgVw).
 *
 * applyWithholding used to write the YTD row as an absolute total computed
 * from a read: two settlements of one creator in flight together both read
 * the same starting total and the loser's money vanished — creators could
 * silently sit below the $600 1099 threshold they actually crossed. These
 * tests pin the replacement contract: the settlement write is a delta the
 * store accumulates in ONE step (the increment_creator_ytd RPC in Supabase,
 * a single INSERT..ON CONFLICT statement in SQLite, one synchronous
 * mutation in memory), so N parallel settlements accumulate exactly and the
 * $600 crossing still evaluates from an exact total.
 */

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { applyWithholding, readCreatorCompliance } from "../engine";
import { FORM_1099_THRESHOLD_CENTS } from "@/modules/don/constants";
import type { CreatorYtdEarnings } from "@/modules/don/records";
import type { Store } from "@/lib/server/store";
import { InMemoryStore } from "@/lib/server/inMemoryStore";
import { SqliteStore } from "@/lib/server/sqliteStore";
import { SupabaseStore } from "@/lib/server/supabaseStore";

const CREATOR = "cr_ytd_race";
const TAX_YEAR = 2026;
const T0 = "2026-09-10T00:00:00.000Z";

/** Deterministic per-settlement wall clocks: one second apart, in order. */
const settledAt = (i: number) => new Date(Date.UTC(2026, 8, 10, 0, 0, i));
/** The ISO stamp the store receives for the settlement at the same clock. */
const stampedAt = (i: number) => settledAt(i).toISOString();

/** Backup withholding the engine applies to an unverified payout (floor 24%). */
const backupOn = (gross: number) => Math.floor((gross * 2_400) / 10_000);

/**
 * Behavioral fake of the migration 0057 RPC: the same single-step semantics
 * (insert-from-deltas, or column-arithmetic update on conflict) applied to a
 * Map, returning the post-increment row as jsonb — what PostgREST hands
 * back. Mutation happens synchronously at call time, mirroring the real
 * function's execute-inside-one-statement guarantee.
 */
class FakeYtdRpcClient {
  readonly rows = new Map<string, CreatorYtdEarnings>();

  async rpc(
    fn: string,
    params: Record<string, unknown>,
  ): Promise<{ data: unknown; error: null } | { data: null; error: { message: string; code: string } }> {
    if (fn !== "increment_creator_ytd") {
      return {
        data: null,
        error: { message: `unhandled rpc: ${fn}`, code: "PGRST202" },
      };
    }
    const key = `${params.p_creator_id}:${params.p_tax_year}`;
    const existing = this.rows.get(key);
    const row: CreatorYtdEarnings = {
      creator_id: params.p_creator_id as string,
      tax_year: params.p_tax_year as number,
      gross_cents:
        (existing?.gross_cents ?? 0) + (params.p_gross_delta as number),
      withheld_cents:
        (existing?.withheld_cents ?? 0) +
        (params.p_withheld_delta as number),
      updated_at: params.p_updated_at as string,
    };
    this.rows.set(key, row);
    return { data: { ...row }, error: null };
  }
}

/** The two backends that can host the full engine flow without a live DB. */
const raceBackends: Array<{ name: string; make: () => InMemoryStore | SqliteStore }> = [
  { name: "in-memory", make: () => new InMemoryStore() },
  { name: "sqlite", make: () => new SqliteStore(":memory:") },
];

async function seedVerifiedProfile(
  store: InMemoryStore | SqliteStore,
): Promise<void> {
  await store.upsertCreatorTaxProfile({
    creator_id: CREATOR,
    tin_verified: 1,
    w9_on_file: 1,
    updated_at: T0,
  });
}

describe("concurrent settlements of one creator accumulate exactly", () => {
  const N = 120;
  const GROSS = 1_000;

  it.each(raceBackends)("$name: N parallel verified settlements all land", async ({ make }) => {
    const store = make();
    await seedVerifiedProfile(store);

    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        applyWithholding(
          store,
          { creator_id: CREATOR, gross_cents: GROSS, tax_year: TAX_YEAR },
          settledAt(i),
        ),
      ),
    );

    const ytd = await store.getCreatorYtd(CREATOR, TAX_YEAR);
    expect(ytd?.gross_cents).toBe(N * GROSS);
    expect(ytd?.withheld_cents).toBe(0);

    // One escrow row per settlement, and its ledger agrees with the YTD row.
    const escrow = await store.listTaxEscrowByCreator(CREATOR, TAX_YEAR);
    expect(escrow).toHaveLength(N);
    expect(escrow.reduce((sum, r) => sum + r.gross_cents, 0)).toBe(N * GROSS);
  });

  it("sqlite: parallel unverified settlements accumulate their backup withholding", async () => {
    const store = new SqliteStore(":memory:");
    await store.upsertCreatorTaxProfile({
      creator_id: CREATOR,
      tin_verified: 0,
      w9_on_file: 0,
      updated_at: T0,
    });
    const gross = 700;

    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        applyWithholding(
          store,
          { creator_id: CREATOR, gross_cents: gross, tax_year: TAX_YEAR },
          settledAt(i),
        ),
      ),
    );

    const ytd = await store.getCreatorYtd(CREATOR, TAX_YEAR);
    expect(ytd?.gross_cents).toBe(N * gross);
    expect(ytd?.withheld_cents).toBe(N * backupOn(gross));
  });

  it.each(raceBackends)("$name: increments accumulate onto a seeded row without overwriting it", async ({ make }) => {
    const store = make();
    await store.upsertCreatorYtd({
      creator_id: CREATOR,
      tax_year: TAX_YEAR,
      gross_cents: 5_000,
      withheld_cents: 1_200,
      updated_at: T0,
    });

    const row = await store.incrementCreatorYtd({
      creator_id: CREATOR,
      tax_year: TAX_YEAR,
      gross_delta_cents: 300,
      withheld_delta_cents: 40,
      updated_at: stampedAt(1),
    });
    expect(row.gross_cents).toBe(5_300);
    expect(row.withheld_cents).toBe(1_240);

    const reread = await store.getCreatorYtd(CREATOR, TAX_YEAR);
    expect(reread?.gross_cents).toBe(5_300);
    expect(reread?.withheld_cents).toBe(1_240);
  });
});

describe("the $600 crossing evaluates after concurrent writes", () => {
  it.each(raceBackends)(
    "$name: requires_1099 is true only because every parallel contribution landed",
    async ({ make }) => {
      const store = make();
      await seedVerifiedProfile(store);
      // 60 payments of 1,001 cents = 60,060: the crossing happens ONLY if
      // all sixty land — one lost update leaves 59,059 and fails this.
      expect(FORM_1099_THRESHOLD_CENTS).toBe(60_000);
      const n = 60;
      const gross = 1_001;

      await Promise.all(
        Array.from({ length: n }, (_, i) =>
          applyWithholding(
            store,
            { creator_id: CREATOR, gross_cents: gross, tax_year: TAX_YEAR },
            settledAt(i),
          ),
        ),
      );

      const snapshot = await readCreatorCompliance(store, CREATOR, TAX_YEAR);
      expect(snapshot.ytd_gross_cents).toBe(n * gross);
      expect(snapshot.ytd_gross_cents).toBeGreaterThanOrEqual(
        FORM_1099_THRESHOLD_CENTS,
      );
      expect(snapshot.requires_1099).toBe(true);
    },
  );
});

describe("store parity — the same increment script on every backend", () => {
  it("leaves in-memory, sqlite, and the supabase RPC with identical rows", async () => {
    const increments = [
      { gross: 5_000, withheld: 0 },
      { gross: 12_345, withheld: 678 },
      { gross: 0, withheld: 0 }, // a zero-delta stamp still rewrites updated_at
      { gross: 60_000, withheld: 0 }, // the settlement that crosses the threshold
    ];

    const inMemory = new InMemoryStore();
    const sqlite = new SqliteStore(":memory:");
    const fake = new FakeYtdRpcClient();
    const supabase = new SupabaseStore(fake as unknown as SupabaseClient);

    const run = async (store: Pick<Store, "incrementCreatorYtd">) => {
      const rows: CreatorYtdEarnings[] = [];
      for (const [i, step] of increments.entries()) {
        rows.push(
          await store.incrementCreatorYtd({
            creator_id: CREATOR,
            tax_year: TAX_YEAR,
            gross_delta_cents: step.gross,
            withheld_delta_cents: step.withheld,
            updated_at: stampedAt(i),
          }),
        );
      }
      return rows;
    };

    const [memRows, liteRows, pgRows] = await Promise.all([
      run(inMemory),
      run(sqlite),
      run(supabase),
    ]);

    expect(memRows).toEqual(liteRows);
    expect(memRows).toEqual(pgRows);
    const expected = {
      creator_id: CREATOR,
      tax_year: TAX_YEAR,
      gross_cents: 77_345,
      withheld_cents: 678,
      updated_at: stampedAt(increments.length - 1),
    };
    expect(await inMemory.getCreatorYtd(CREATOR, TAX_YEAR)).toEqual(expected);
    expect(await sqlite.getCreatorYtd(CREATOR, TAX_YEAR)).toEqual(expected);
    expect(fake.rows.get(`${CREATOR}:${TAX_YEAR}`)).toEqual(expected);
  });

  it("isolates creators and tax years on every backend", async () => {
    const inMemory = new InMemoryStore();
    const sqlite = new SqliteStore(":memory:");
    const fake = new FakeYtdRpcClient();
    const supabase = new SupabaseStore(fake as unknown as SupabaseClient);

    for (const store of [inMemory, sqlite, supabase]) {
      await store.incrementCreatorYtd({
        creator_id: CREATOR,
        tax_year: TAX_YEAR,
        gross_delta_cents: 1_000,
        withheld_delta_cents: 0,
        updated_at: stampedAt(0),
      });
      await store.incrementCreatorYtd({
        creator_id: CREATOR,
        tax_year: TAX_YEAR - 1,
        gross_delta_cents: 5_000,
        withheld_delta_cents: 0,
        updated_at: stampedAt(1),
      });
      await store.incrementCreatorYtd({
        creator_id: `${CREATOR}_other`,
        tax_year: TAX_YEAR,
        gross_delta_cents: 7_000,
        withheld_delta_cents: 0,
        updated_at: stampedAt(2),
      });
    }

    expect((await inMemory.getCreatorYtd(CREATOR, TAX_YEAR))?.gross_cents).toBe(1_000);
    expect((await inMemory.getCreatorYtd(CREATOR, TAX_YEAR - 1))?.gross_cents).toBe(5_000);
    expect((await inMemory.getCreatorYtd(`${CREATOR}_other`, TAX_YEAR))?.gross_cents).toBe(7_000);
    expect((await sqlite.getCreatorYtd(CREATOR, TAX_YEAR))?.gross_cents).toBe(1_000);
    expect((await sqlite.getCreatorYtd(CREATOR, TAX_YEAR - 1))?.gross_cents).toBe(5_000);
    expect((await sqlite.getCreatorYtd(`${CREATOR}_other`, TAX_YEAR))?.gross_cents).toBe(7_000);
    expect(fake.rows.get(`${CREATOR}:${TAX_YEAR}`)?.gross_cents).toBe(1_000);
    expect(fake.rows.get(`${CREATOR}:${TAX_YEAR - 1}`)?.gross_cents).toBe(5_000);
    expect(fake.rows.get(`${CREATOR}_other:${TAX_YEAR}`)?.gross_cents).toBe(7_000);
  });
});
