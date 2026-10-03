// The sports instant postings (PR 51, the founder real-time directive):
// the staged resale-royalty and biometric micro-payout applications from
// PR 50's walk complete IMMEDIATELY — the promoter, venue, and league
// royalty cuts, and the athlete wallet + league data-rights legs, post
// between their ledgers through the taxed cascade the moment their
// application stages. Journal-stamped, replay-safe, fail-closed.
//
// Under test: the identity and staging fail-closed refusals (blank ids,
// absent applications), the missing policy-of-record refusal (the resale
// legs' payee identities are unknowable), the conservation re-verification
// before money moves, the happy-path postings (journal kinds, CAS stamp,
// the exact credited legs), the counted replay no-op (never a second
// posting), and the pure legs-conserve-pot check the executors re-run.

import { describe, expect, it } from "vitest";

import {
  executeSportsBiometricMicroPayout,
  executeSportsResaleRoyaltyPosting,
  sportsLegsConservePot,
} from "@/lib/server/sportsInstantPostings";
import { InMemoryStore } from "@/lib/server/inMemoryStore";

const T0 = new Date("2026-10-03T12:00:00.000Z");

async function stageBiometric(
  store: InMemoryStore,
  overrides: Partial<Parameters<InMemoryStore["insertSportsBiometricMicroPayoutApplication"]>[0]> = {},
) {
  return store.insertSportsBiometricMicroPayoutApplication({
    source_event_id: "biometric_payout:TEST-1:USD",
    biometric_post_event_id: "biometric:TEST-1",
    athlete_glan: "GLN-TEST-ATHLETE",
    league_rights_code: "LEAGUE-TEST",
    tracking_modality: "wearable",
    licensee_class: "media_network",
    licensed_quantity_micros: 250_000_000,
    micros_per_unit: 1_200,
    athlete_share_bps: 6_000,
    payout_pot_cents: 30_000,
    athlete_wallet_payee_id: "athlete-wallet-test",
    athlete_leg_cents: 18_000,
    league_data_payee_id: "league-data-test",
    league_leg_cents: 12_000,
    journal_id: null,
    ...overrides,
  });
}

async function stageResale(
  store: InMemoryStore,
  overrides: Partial<Parameters<InMemoryStore["insertSportsResaleRoyaltyApplication"]>[0]> = {},
) {
  return store.insertSportsResaleRoyaltyApplication({
    source_event_id: "resale_royalty:TEST-1:USD",
    resale_sale_event_id: "resale:TEST-1",
    venue_gln: "GLN-TEST-VENUE",
    league_rights_code: "LEAGUE-TEST",
    resale_gross_cents: 100_000,
    resale_royalty_bps: 700,
    promoter_share_bps: 4_000,
    venue_share_bps: 3_500,
    league_share_bps: 2_500,
    royalty_pot_cents: 7_000,
    promoter_leg_cents: 2_800,
    venue_leg_cents: 2_450,
    league_leg_cents: 1_750,
    journal_id: null,
    ...overrides,
  });
}

function seedResalePolicy(store: InMemoryStore): void {
  void store.upsertSportsResaleRoyaltyPolicy({
    venue_gln: "GLN-TEST-VENUE",
    league_rights_code: "LEAGUE-TEST",
    promoter_payee_id: "promoter-test",
    promoter_payee_name: "Test Promoter",
    venue_payee_id: "venue-test",
    venue_payee_name: "Test Venue",
    league_payee_id: "league-test",
    league_payee_name: "Test League",
    resale_royalty_bps: 700,
    promoter_share_bps: 4_000,
    venue_share_bps: 3_500,
    league_share_bps: 2_500,
  });
}

describe("sportsLegsConservePot — the pure conservation identity", () => {
  it("accepts exact whole-cent conservation and refuses drift, negatives, and non-integers", () => {
    expect(sportsLegsConservePot([{ amount_cents: 18_000 }, { amount_cents: 12_000 }], 30_000)).toBe(true);
    expect(sportsLegsConservePot([{ amount_cents: 0 }, { amount_cents: 30_000 }], 30_000)).toBe(true);
    expect(sportsLegsConservePot([{ amount_cents: 18_000 }, { amount_cents: 12_001 }], 30_000)).toBe(false);
    expect(sportsLegsConservePot([{ amount_cents: -1 }, { amount_cents: 30_001 }], 30_000)).toBe(false);
    expect(sportsLegsConservePot([{ amount_cents: 1.5 }], 1.5)).toBe(false);
    expect(sportsLegsConservePot([], -1)).toBe(false);
  });
});

describe("executeSportsBiometricMicroPayout — athlete wallet + league data rights, instantly", () => {
  it("fails closed on blank identities and absent staged applications", async () => {
    const store = new InMemoryStore();
    const blank = await executeSportsBiometricMicroPayout(store, "   ", T0);
    expect(blank).toMatchObject({ ok: false, status: 422, code: "invalid_posting_identity" });
    const absent = await executeSportsBiometricMicroPayout(store, "biometric_payout:none", T0);
    expect(absent).toMatchObject({
      ok: false,
      status: 404,
      code: "biometric_payout_application_not_found",
    });
  });

  it("refuses staged legs that do not conserve the staged pot — before anything moves", async () => {
    const store = new InMemoryStore();
    await stageBiometric(store, {
      source_event_id: "biometric_payout:BAD:USD",
      athlete_leg_cents: 20_000,
      league_leg_cents: 12_000,
    });
    const refused = await executeSportsBiometricMicroPayout(
      store,
      "biometric_payout:BAD:USD",
      T0,
    );
    expect(refused).toMatchObject({
      ok: false,
      status: 500,
      code: "biometric_payout_conservation_violation",
    });
    expect((await store.listGlJournals()).length).toBe(0);
  });

  it("posts athlete + league legs through the taxed cascade, journals, and CAS-stamps the application", async () => {
    const store = new InMemoryStore();
    await stageBiometric(store);
    const result = await executeSportsBiometricMicroPayout(
      store,
      "biometric_payout:TEST-1:USD",
      T0,
    );
    if (!result.ok) {
      throw new Error(`expected the posting to succeed: ${result.code} ${result.message}`);
    }
    expect(result.value.replayed).toBe(false);
    expect(result.value.pot_cents).toBe(30_000);
    // The leg identities and gross cents are exact; the NET rides the
    // taxed cascade (withholding on an unverified TIN, recoupment
    // sweeps), so it lands anywhere in [0, gross] — every withheld and
    // recouped portion moves inside the house legs.
    expect(
      result.value.credits.map((c) => [c.payee_id, c.leg, c.gross_cents]),
    ).toEqual([
      ["athlete-wallet-test", "athlete_data_rights", 18_000],
      ["league-data-test", "league_data_rights", 12_000],
    ]);
    for (const credit of result.value.credits) {
      expect(credit.net_cents).toBeGreaterThanOrEqual(0);
      expect(credit.net_cents).toBeLessThanOrEqual(credit.gross_cents);
    }
    expect(result.value.journal_id).toBe(result.value.application.journal_id);
    const journal = (await store.listGlJournals()).find(
      (j) => j.id === result.value.journal_id,
    );
    expect(journal?.kind).toBe("sports_biometric_payout_post");
  });

  it("skips zero legs (a 100% athlete payout still posts) and replays as a counted no-op", async () => {
    const store = new InMemoryStore();
    await stageBiometric(store, {
      athlete_leg_cents: 30_000,
      league_leg_cents: 0,
    });
    const first = await executeSportsBiometricMicroPayout(
      store,
      "biometric_payout:TEST-1:USD",
      T0,
    );
    if (!first.ok) {
      throw new Error(`expected the posting to succeed: ${first.code}`);
    }
    expect(first.value.credits.map((c) => c.leg)).toEqual(["athlete_data_rights"]);

    const replay = await executeSportsBiometricMicroPayout(
      store,
      "biometric_payout:TEST-1:USD",
      T0,
    );
    expect(replay.ok).toBe(true);
    if (replay.ok) {
      expect(replay.value.replayed).toBe(true);
      expect(replay.value.journal_id).toBe(first.value.journal_id);
      expect(replay.value.credits).toEqual([]);
    }
    expect((await store.listGlJournals()).length).toBe(1);
  });
});

describe("executeSportsResaleRoyaltyPosting — promoter, venue, and league cuts, instantly", () => {
  it("fails closed on absent applications and a missing policy of record", async () => {
    const store = new InMemoryStore();
    const absent = await executeSportsResaleRoyaltyPosting(store, "resale_royalty:none", T0);
    expect(absent).toMatchObject({
      ok: false,
      status: 404,
      code: "resale_royalty_application_not_found",
    });
    await stageResale(store);
    const noPolicy = await executeSportsResaleRoyaltyPosting(
      store,
      "resale_royalty:TEST-1:USD",
      T0,
    );
    expect(noPolicy).toMatchObject({
      ok: false,
      status: 422,
      code: "missing_resale_royalty_policy",
    });
    expect((await store.listGlJournals()).length).toBe(0);
  });

  it("refuses staged legs that do not conserve the staged pot — before anything moves", async () => {
    const store = new InMemoryStore();
    seedResalePolicy(store);
    await stageResale(store, {
      source_event_id: "resale_royalty:BAD:USD",
      promoter_leg_cents: 9_999,
    });
    const refused = await executeSportsResaleRoyaltyPosting(
      store,
      "resale_royalty:BAD:USD",
      T0,
    );
    expect(refused).toMatchObject({
      ok: false,
      status: 500,
      code: "resale_royalty_conservation_violation",
    });
    expect((await store.listGlJournals()).length).toBe(0);
  });

  it("posts the three-way royalty legs from the policy of record, journals, and CAS-stamps", async () => {
    const store = new InMemoryStore();
    seedResalePolicy(store);
    await stageResale(store);
    const result = await executeSportsResaleRoyaltyPosting(
      store,
      "resale_royalty:TEST-1:USD",
      T0,
    );
    if (!result.ok) {
      throw new Error(`expected the posting to succeed: ${result.code} ${result.message}`);
    }
    expect(result.value.replayed).toBe(false);
    expect(result.value.pot_cents).toBe(7_000);
    // The leg identities and gross cents are exact; the NET rides the
    // taxed cascade (withholding on an unverified TIN, recoupment
    // sweeps), so it lands anywhere in [0, gross] — every withheld and
    // recouped portion moves inside the house legs.
    expect(
      result.value.credits.map((c) => [c.payee_id, c.leg, c.gross_cents]),
    ).toEqual([
      ["promoter-test", "promoter_royalty", 2_800],
      ["venue-test", "venue_royalty", 2_450],
      ["league-test", "league_royalty", 1_750],
    ]);
    for (const credit of result.value.credits) {
      expect(credit.net_cents).toBeGreaterThanOrEqual(0);
      expect(credit.net_cents).toBeLessThanOrEqual(credit.gross_cents);
    }
    const journal = (await store.listGlJournals()).find(
      (j) => j.id === result.value.journal_id,
    );
    expect(journal?.kind).toBe("sports_resale_royalty_post");

    const replay = await executeSportsResaleRoyaltyPosting(
      store,
      "resale_royalty:TEST-1:USD",
      T0,
    );
    expect(replay.ok).toBe(true);
    if (replay.ok) {
      expect(replay.value.replayed).toBe(true);
      expect(replay.value.journal_id).toBe(result.value.journal_id);
      expect(replay.value.credits).toEqual([]);
    }
    expect((await store.listGlJournals()).length).toBe(1);
  });
});
