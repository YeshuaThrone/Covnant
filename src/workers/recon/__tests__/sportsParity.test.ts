/**
 * The sports lane's backend-parity suite (PR 50, the founder sports
 * directive) — the full eight-sender scenario walked through the
 * InMemory, SQLite, and Supabase-backed stores through the SAME
 * recon-worker dispatch, then replayed to prove the replay guard. All
 * three backends must produce byte-identical recon-job counters and
 * identical rows of record: the realizations, the venue
 * reconciliations, the resale royalty applications, the league pool
 * distribution, the group licensing applications, the NIL
 * reconciliations, and the biometric micro-payout applications.
 */

import { describe, expect, it } from "vitest";

import { InMemoryStore } from "@/lib/server/inMemoryStore";
import type { ReconJobResult, Store } from "@/lib/server/store";
import { SqliteStore } from "@/lib/server/sqliteStore";

import { runOnce } from "../worker";
import { netVenueRealizationEventId } from "../sports";
import { loadFixture } from "./fixtures";
import { makeFakeSupabaseStore } from "./fakeSupabase";
import {
  NOW,
  SPORTS_FIXTURES,
  registerSportsPolicies,
} from "./sportsScenario";

const BACKENDS: { make: () => Promise<Store>; name: string }[] = [
  { make: async () => new InMemoryStore(), name: "in-memory" },
  { make: async () => new SqliteStore(":memory:") as Store, name: "sqlite" },
  { make: async () => makeFakeSupabaseStore(), name: "supabase-fake" },
];

/** The scenario's per-sender sheet identity — one ingest and job per fixture. */
async function ingestFixture(store: Store, fixtureName: string): Promise<string> {
  if (!SPORTS_FIXTURES.includes(fixtureName as (typeof SPORTS_FIXTURES)[number])) {
    throw new Error(`unknown sports fixture ${fixtureName}`);
  }
  const ingest = await store.insertStatementIngest({
    format: "csv_statement",
    source: "statement",
    file_name: fixtureName,
    content: loadFixture(fixtureName),
    status: "parsed",
    event_count: null,
    error: null,
    created_at: NOW.toISOString(),
  });
  await store.createReconJob({ source: "statement", ingest_id: ingest.id });
  return ingest.id;
}

/** Sums the lane's numeric counters across a pass's job results. */
function sportsCounters(results: ReconJobResult[]): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const result of results) {
    for (const [key, value] of Object.entries(result)) {
      if (!key.startsWith("sports_") || typeof value !== "number") continue;
      totals[key] = (totals[key] ?? 0) + value;
    }
  }
  return totals;
}

/**
 * The rows of record the pass must leave — the pinned identity and
 * money per recompute-in-place row and application of record.
 */
async function sportsProjection(store: Store) {
  const realization = (nilContractId: string, athleteGlan: string, venueGln: string, scanHash: string) =>
    store.getSportsNetVenueRealization(
      netVenueRealizationEventId({
        nilContractId,
        athleteGlan,
        venueGln,
        leagueRightsCode: "NFL-LIC-2026",
        turnstileScanHash: scanHash,
        period: "2026-03",
        currency: "USD",
      }),
    );
  return normalizeVolatile({
    metroQbOne: await realization("nil-contract-77", "athlete:qb-one", "VEN-METRO-1", "hash-turnstile-a"),
    metroHeld: await realization("nil-contract-held", "athlete:wr-two", "VEN-METRO-1", "hash-turnstile-a"),
    orphanGhost: await realization("nil-contract-orphan", "athlete:ghost", "VEN-ORPHAN-1", "hash-turnstile-c"),
    orphanRb: await realization("nil-contract-99", "athlete:rb-three", "VEN-ORPHAN-1", "hash-turnstile-c"),
    arenaWr: await realization("nil-contract-88", "athlete:wr-two", "VEN-ARENA-2", "hash-turnstile-b"),
    arenaQb: await realization("nil-contract-88", "athlete:qb-one", "VEN-ARENA-2", "hash-turnstile-b"),
    metroRecon: await store.getSportsGateReconciliation("sports:gate_reconciliation:VEN-METRO-1:2026-03:USD"),
    arenaRecon: await store.getSportsGateReconciliation("sports:gate_reconciliation:VEN-ARENA-2:2026-03:USD"),
    orphanRecon: await store.getSportsGateReconciliation("sports:gate_reconciliation:VEN-ORPHAN-1:2026-03:USD"),
    resaleStubhubOne: await store.getSportsResaleRoyaltyApplication(
      "sports:resale_royalty:stubhub:SH-2026-03-0001:2026-03:USD",
    ),
    resaleStubhubTwo: await store.getSportsResaleRoyaltyApplication(
      "sports:resale_royalty:stubhub:SH-2026-03-0002:2026-03:USD",
    ),
    resaleVivid: await store.getSportsResaleRoyaltyApplication(
      "sports:resale_royalty:vivid_seats:VS-2026-03-0001:2026-03:USD",
    ),
    leaguePool: await store.getSportsLeaguePoolDistribution(
      "sports:league_pool:NFL-LIC-2026:2026-03:USD",
    ),
    groupLicensingGame: await store.getSportsGroupLicensingApplication(
      "sports:group_licensing:CONTRACT-GAME-2026:2026-03:USD",
    ),
    groupLicensingCards: await store.getSportsGroupLicensingApplication(
      "sports:group_licensing:CONTRACT-CARDS-2026:2026-03:USD",
    ),
    nilEndorse: await store.getSportsNilDealReconciliation(
      "sports:nil_deal_reconciliation:nil-contract-77:athlete:qb-one:2026-03",
    ),
    nilUnmatched: await store.getSportsNilDealReconciliation(
      "sports:nil_deal_reconciliation:nil-contract-orphan:athlete:ghost:2026-03",
    ),
    nilIneligible: await store.getSportsNilDealReconciliation(
      "sports:nil_deal_reconciliation:nil-contract-99:athlete:rb-three:2026-03",
    ),
    biometricSportsbook: await store.getSportsBiometricMicroPayoutApplication(
      "sports:biometric_payout:NFL-LIC-2026:BIO-2026-03-0001:2026-03:USD",
    ),
    biometricMedia: await store.getSportsBiometricMicroPayoutApplication(
      "sports:biometric_payout:NFL-LIC-2026:BIO-2026-03-0002:2026-03:USD",
    ),
    biometricHealth: await store.getSportsBiometricMicroPayoutApplication(
      "sports:biometric_payout:NFL-LIC-2026:BIO-2026-03-0003:2026-03:USD",
    ),
  });
}

/** Strips the four non-deterministic fields — random row ids, the
 * wall-clock stamps, and the PR 51 instant postings' random per-backend
 * journal ids (their non-nullness is pinned by the queue's posted
 * counters, not by cross-backend value equality) — from every record so
 * the three backends compare on money, verdicts, and event ids alone. */
function normalizeVolatile<T extends Record<string, unknown>>(projection: T): T {
  const stripped = JSON.parse(
    JSON.stringify(projection, (_key, value) =>
      value instanceof Map ? Object.fromEntries(value) : value,
    ),
  ) as T;
  for (const record of Object.values(stripped)) {
    if (record !== null && typeof record === "object") {
      for (const volatile of ["id", "created_at", "updated_at", "journal_id"]) {
        delete (record as Record<string, unknown>)[volatile];
      }
    }
  }
  return stripped;
}

type SportsProjection = Awaited<ReturnType<typeof sportsProjection>>;

describe("the sports lane — three backends, one scenario, byte-identical outcomes", () => {
  it("runs the full pass with identical counters and rows of record", async () => {
    const projections: SportsProjection[] = [];
    let baseline: Record<string, number> | undefined;

    for (const backend of BACKENDS) {
      const store = await backend.make();
      await registerSportsPolicies(store);
      const results: ReconJobResult[] = [];
      for (const fixtureName of SPORTS_FIXTURES) {
        const ingestId = await ingestFixture(store, fixtureName);
        const processed = await runOnce({ store, vault: null, now: () => NOW });
        if (
          !processed ||
          processed.job.ingest_id !== ingestId ||
          processed.job.result === null
        ) {
          throw new Error(`${backend.name}: the sports job did not run for ${fixtureName}`);
        }
        results.push(processed.job.result);
      }

      const counters = sportsCounters(results);
      if (!baseline) baseline = counters;
      else expect(counters).toEqual(baseline);

      projections.push(await sportsProjection(store));
    }

    const [inMemory, sqlite, supabase] = projections;
    expect(sqlite).toEqual(inMemory);
    expect(supabase).toEqual(inMemory);

    // The realization pins — the founder identity's rows of record.
    expect(inMemory.metroQbOne?.net_gate_pool_cents).toBe(28_650_003);
    expect(inMemory.metroQbOne?.gate_reconciliation_verdict).toBe("reconciled");
    expect(inMemory.metroHeld?.verdict).toBe("held_negative_net");
    expect(inMemory.orphanRb?.net_gate_pool_cents).toBe(200);
    expect(inMemory.arenaWr?.net_gate_pool_cents).toBe(4_100_000);
    expect(inMemory.arenaQb?.net_gate_pool_cents).toBe(2_050_000);

    // The reconciliation rows of record — one per venue, period, currency.
    expect(inMemory.metroRecon?.verdict).toBe("reconciled");
    expect(inMemory.metroRecon?.scan_count_sum).toBe(35_010);
    expect(inMemory.metroRecon?.ticket_count_sum).toBe(35_010);
    expect(inMemory.arenaRecon?.verdict).toBe("variance_flagged");
    expect(inMemory.orphanRecon?.verdict).toBe("variance_flagged");
    expect(inMemory.orphanRecon?.scan_count_sum).toBe(5_000);
    expect(inMemory.orphanRecon?.ticket_count_sum).toBe(7);
    expect(inMemory.orphanRecon?.variance_scan_delta).toBe(4_993);

    // The resale royalty applications — pot and three legs each.
    expect(inMemory.resaleStubhubOne?.royalty_pot_cents).toBe(400_000);
    expect(inMemory.resaleStubhubOne?.promoter_leg_cents).toBe(200_000);
    expect(inMemory.resaleStubhubOne?.venue_leg_cents).toBe(120_000);
    expect(inMemory.resaleStubhubOne?.league_leg_cents).toBe(80_000);
    expect(inMemory.resaleStubhubTwo?.royalty_pot_cents).toBe(100_050);
    expect(inMemory.resaleVivid?.royalty_pot_cents).toBe(10);
    expect(inMemory.resaleVivid?.league_leg_cents).toBe(2);

    // The league pool distribution of record — the pinned offsets
    // (the team legs ride the record's legs_json payload).
    expect(inMemory.leaguePool?.pool_cents).toBe(150_000_001);
    expect(inMemory.leaguePool?.distributed_cents).toBe(150_000_001);
    const poolLegs = JSON.parse(inMemory.leaguePool?.legs_json ?? "[]") as Array<{
      team_code: string;
      market_balance_cents: number;
      total_cents: number;
    }>;
    expect(poolLegs.find((leg) => leg.team_code === "TEAM-B")?.market_balance_cents).toBe(0);
    expect(poolLegs.find((leg) => leg.team_code === "TEAM-C")?.total_cents).toBe(61_250_001);

    // The group licensing applications — union leg plus wallets
    // (the wallet legs ride the record's athlete_wallets_json payload).
    expect(inMemory.groupLicensingGame?.union_leg_cents).toBe(20_000_000);
    const gameWallets = JSON.parse(
      inMemory.groupLicensingGame?.athlete_wallets_json ?? "[]",
    ) as Array<{ athlete_glan: string; wallet_cents: number }>;
    expect(gameWallets.map((wallet) => wallet.wallet_cents)).toEqual([
      26_666_667,
      26_666_667,
      26_666_666,
    ]);
    expect(inMemory.groupLicensingCards?.union_leg_cents).toBe(5_000_000);

    // The NIL reconciliations of record — matched, unmatched, ineligible
    // (brand 500000 + collective 250000 = gross 750000 per the scenario).
    expect(inMemory.nilEndorse?.nil_deal_gross_cents).toBe(750_000);
    expect(inMemory.nilEndorse?.endorsement_deal_cents).toBe(500_000);
    expect(inMemory.nilEndorse?.booster_collective_cents).toBe(250_000);
    expect(inMemory.nilUnmatched?.verdict).toBe("unmatched_profile");
    expect(inMemory.nilIneligible?.verdict).toBe("profile_ineligible");

    // The biometric micro-payout applications — quantity × rate, floored
    // (pot then athlete/league legs per the scenario's rates and shares).
    expect(inMemory.biometricSportsbook?.payout_pot_cents).toBe(100);
    expect(inMemory.biometricSportsbook?.athlete_leg_cents).toBe(70);
    expect(inMemory.biometricSportsbook?.league_leg_cents).toBe(30);
    expect(inMemory.biometricMedia?.payout_pot_cents).toBe(25);
    expect(inMemory.biometricMedia?.athlete_leg_cents).toBe(12);
    expect(inMemory.biometricHealth?.payout_pot_cents).toBe(5);
  });

  it("replays the same sheets with every row replay-guarded — zero double money", async () => {
    for (const backend of BACKENDS) {
      const store = await backend.make();
      await registerSportsPolicies(store);
      for (const fixtureName of SPORTS_FIXTURES) {
        await ingestFixture(store, fixtureName);
        await runOnce({ store, vault: null, now: () => NOW });
      }
      // The replay — the same eight sheets again.
      for (const fixtureName of SPORTS_FIXTURES) {
        await ingestFixture(store, fixtureName);
        await runOnce({ store, vault: null, now: () => NOW });
      }

      // Every realization of record kept its pass-one value — the
      // recompute-in-place positions never doubled.
      const metro = await store.getSportsNetVenueRealization(
        netVenueRealizationEventId({
          nilContractId: "nil-contract-77",
          athleteGlan: "athlete:qb-one",
          venueGln: "VEN-METRO-1",
          leagueRightsCode: "NFL-LIC-2026",
          turnstileScanHash: "hash-turnstile-a",
          period: "2026-03",
          currency: "USD",
        }),
      );
      expect(metro?.net_gate_pool_cents).toBe(28_650_003);

      const pool = await store.getSportsLeaguePoolDistribution(
        "sports:league_pool:NFL-LIC-2026:2026-03:USD",
      );
      expect(pool?.pool_cents).toBe(150_000_001);
      expect(pool?.distributed_cents).toBe(150_000_001);
    }
  });
});
