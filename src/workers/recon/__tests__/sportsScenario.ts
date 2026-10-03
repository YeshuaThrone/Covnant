/**
 * The sports lane's shared test scenario (PR 50, the founder sports
 * directive) — the eight senders' fixtures and the athlete profiles,
 * resale royalty policy, league pool policy, team registrations,
 * biometric royalty policies, and NIL payout applications of record,
 * held in ONE place so the lane's worker-path suite and the
 * three-backend parity suite exercise the exact same sheet-and-registry
 * world and can never drift apart.
 *
 * The scenario's pinned math (the fixtures ride it):
 * - nil-contract-77 / athlete:qb-one / VEN-METRO-1 / hash-turnstile-a:
 *   gross 15000003 + 20000000 = 35000003; deductions 2700000 + 2000000
 *   + 700000 + 950000 = 6350000; net = 28650003 (POSTED).
 * - nil-contract-held / athlete:wr-two: gross 1000 − 600 − 200 − 300
 *   − 200 = −300 (the HELD verdict).
 * - VEN-METRO-1 reconciles exactly: 35010 tickets, 35010 scans, delta
 *   0. VEN-ORPHAN-1 flags the variance: 7 tickets, 5000 scans, delta
 *   +4993 (the orphan scans the receipts never saw). VEN-ARENA-2 flags
 *   the reverse: 7500 tickets, 0 scans, delta −7500 (the unscanned
 *   tickets).
 * - The resale policy (VEN-METRO-1 × NFL-LIC-2026, 1000 bps split
 *   5000/3000/2000): $40,000 → pot 400000 = promoter 200000 + venue
 *   120000 + league 80000; $10,005 → pot 100050 = 50025 + 30015 +
 *   20010; the $1.00 row → pot 10 = 5 + 3 + 2 (the league leg absorbs
 *   every floor's remainder). VEN-NOPOL-1 has no policy — the
 *   fail-closed skip.
 * - The league pool (Σ pool-class gross = 100000001 + 40000000 +
 *   10000000 = 150000001 cents; policy 4000/3500/2500): the equal
 *   slice 60000000 → 20000000 per team (exact); the market slice
 *   52500000 → TEAM-A 30000000 + TEAM-C 22500000 exact (TEAM-B is over
 *   the salary cap and takes none of it); the incentive slice — the
 *   EXACT remainder 37500001, which carries the national contract's
 *   bps-floor dust — walks the incentive weights 300/200/500 to
 *   11250000 / 7500000 / 18750000 with the one-cent remainder to
 *   TEAM-C (the highest weight). Totals: A 61250000, B 27500000, C
 *   61250001; Σ = pool, dust 0.
 * - Group licensing (union share 2000 bps): the $1,000,000 video-game
 *   pool → union 20000000 + athlete pool 80000000 split 26666667 /
 *   26666667 / 26666666 (GLAN order qb-one, rb-three, wr-two); the
 *   $250,000 card pool → union 5000000 + 20000000 → 6666667 /
 *   6666667 / 6666666; the NBAPA apparel pool 2000000 → union 400000
 *   + wallet 1600000. The ghost roster fails closed (no profile); the
 *   NBAPA athlete under an NFLPA contract fails closed (union
 *   mismatch).
 * - Biometric (cents = floor(quantity micros × micros per unit /
 *   10^14)): the sportsbook license (rate 2000000, athlete 7000 bps) →
 *   pot 100 = athlete 70 + league 30; the media_network license (rate
 *   1000000, athlete 5000 bps) → pot 25 = 12 + 13; the health_tech
 *   license (rate 500000, athlete 7000 bps) → pot 5 = 3 + 2. The
 *   ghost telemetry fails closed (no profile).
 * - The NIL reconciliations read the NIL lane's applications of record:
 *   qb-one's nil_athlete_id carries a brand application (net 500000)
 *   and a collective application (net 250000) in 2026-03 — both
 *   reconciliation scopes that name qb-one reconcile at gross 750000;
 *   wr-two's scope reconciles empty; the ghost scope reports
 *   unmatched_profile; the rb-three scope reports profile_ineligible.
 *
 * The deliberate fail-closed gaps: VEN-NOPOL-1 has no resale policy,
 * athlete:ghost has no student-athlete profile, and CONTRACT-APPAREL-
 * MISMATCH points an NFLPA contract at the NBAPA athlete — the walks
 * must skip those counted, never guess.
 */

import { InMemoryStore } from "@/lib/server/inMemoryStore";
import type { Store } from "@/lib/server/store";

import type { ParsedStatementLine } from "../records";
import { dispatchStatementProfile } from "../profiles";

import { loadFixture } from "./fixtures";

/** The eight senders' fixtures, in dispatch order. */
export const SPORTS_FIXTURES = [
  "sports_ticketmaster_sales.csv",
  "sports_axs_sales.csv",
  "sports_seatgeek_sales.csv",
  "sports_stubhub_resale.csv",
  "sports_vividseats_resale.csv",
  "sports_turnstile_telemetry.csv",
  "sports_league_contracts.csv",
  "sports_biometric_tracking.csv",
] as const;

/** The scenario's fixed instant — the worker clock and row timestamps. */
export const NOW = new Date("2026-10-03T12:00:00Z");

function dispatchFixture(name: string): ParsedStatementLine[] {
  const content = loadFixture(name);
  const profile = dispatchStatementProfile(content);
  if (profile === null) {
    throw new Error(`fixture ${name} did not dispatch to a pinned profile`);
  }
  return [...profile.parse(content)];
}

/** All eight sheets through their pinned strict profiles, in order. */
export function parseSportsFixtures(): ParsedStatementLine[] {
  return SPORTS_FIXTURES.flatMap((name) => dispatchFixture(name));
}

/**
 * The athlete profiles, resale royalty policy, league pool policy,
 * league team registrations, biometric royalty policies, and NIL
 * payout applications the sheets ride on.
 */
export async function registerSportsPolicies(store: Store): Promise<void> {
  // The student-athlete profiles of record — the NIL reconciliation's
  // join, the group licensing walk's wallets, the biometric walk's
  // destinations.
  await store.upsertSportsStudentAthleteProfile({
    athlete_glan: "athlete:qb-one",
    full_name: "Quarterback One",
    school_id: "school-metro-u",
    union_code: "NFLPA",
    nil_athlete_id: "nil-athlete-qb-one",
    wallet_payee_id: "wallet-qb-one",
    eligible: true,
  });
  await store.upsertSportsStudentAthleteProfile({
    athlete_glan: "athlete:wr-two",
    full_name: "Receiver Two",
    school_id: "school-metro-u",
    union_code: "NFLPA",
    nil_athlete_id: "nil-athlete-wr-two",
    wallet_payee_id: "wallet-wr-two",
    eligible: true,
  });
  await store.upsertSportsStudentAthleteProfile({
    athlete_glan: "athlete:rb-three",
    full_name: "Back Three (ineligible)",
    school_id: "school-metro-u",
    union_code: "NFLPA",
    nil_athlete_id: "nil-athlete-rb-three",
    wallet_payee_id: "wallet-rb-three",
    eligible: false,
  });
  await store.upsertSportsStudentAthleteProfile({
    athlete_glan: "athlete:c-four",
    full_name: "Center Four (NBAPA)",
    school_id: "school-metro-u",
    union_code: "NBAPA",
    nil_athlete_id: "nil-athlete-c-four",
    wallet_payee_id: "wallet-c-four",
    eligible: true,
  });

  // The resale royalty policy of record — the founder's 10% band split
  // promoter / venue / league (conserves to 10000), with the payee
  // identities each leg routes to.
  await store.upsertSportsResaleRoyaltyPolicy({
    venue_gln: "VEN-METRO-1",
    league_rights_code: "NFL-LIC-2026",
    promoter_payee_id: "promoter-metro-1",
    promoter_payee_name: "Metro Promoters LLC",
    venue_payee_id: "venue-metro-1",
    venue_payee_name: "Metro Venue Operations",
    league_payee_id: "league-rights-nfl",
    league_payee_name: "League Rights (NFL)",
    resale_royalty_bps: 1000,
    promoter_share_bps: 5000,
    venue_share_bps: 3000,
    league_share_bps: 2000,
  });

  // The league-wide pool policy of record — the three-way split
  // (conserves to 10000).
  await store.upsertSportsLeaguePoolPolicy({
    league_rights_code: "NFL-LIC-2026",
    equal_share_bps: 4000,
    market_balance_bps: 3500,
    performance_incentive_bps: 2500,
  });

  // The team owners' registrations — TEAM-B is over the salary cap
  // threshold (the market slice's cap offset).
  await store.upsertSportsLeagueTeam({
    league_rights_code: "NFL-LIC-2026",
    team_code: "TEAM-A",
    owner_payee_id: "owner-team-a",
    owner_payee_name: "Metro Owners LP (A)",
    market_size_micros: 4_000_000,
    payroll_micros: 1_000_000,
    cap_threshold_micros: 1_200_000,
    performance_incentive_bps: 300,
  });
  await store.upsertSportsLeagueTeam({
    league_rights_code: "NFL-LIC-2026",
    team_code: "TEAM-B",
    owner_payee_id: "owner-team-b",
    owner_payee_name: "Harbor Owners LP (B, over cap)",
    market_size_micros: 3_000_000,
    payroll_micros: 1_500_000,
    cap_threshold_micros: 1_200_000,
    performance_incentive_bps: 200,
  });
  await store.upsertSportsLeagueTeam({
    league_rights_code: "NFL-LIC-2026",
    team_code: "TEAM-C",
    owner_payee_id: "owner-team-c",
    owner_payee_name: "Capital Owners LP (C)",
    market_size_micros: 3_000_000,
    payroll_micros: 500_000,
    cap_threshold_micros: 1_000_000,
    performance_incentive_bps: 500,
  });

  // The biometric royalty policies of record — the per-license
  // micro-payout rates and athlete shares.
  await store.upsertSportsBiometricRoyaltyPolicy({
    league_rights_code: "NFL-LIC-2026",
    licensee_class: "sportsbook",
    league_data_payee_id: "league-data-nfl",
    league_data_payee_name: "League Data Rights (NFL)",
    micros_per_unit: 2_000_000,
    athlete_share_bps: 7000,
  });
  await store.upsertSportsBiometricRoyaltyPolicy({
    league_rights_code: "NFL-LIC-2026",
    licensee_class: "media_network",
    league_data_payee_id: "league-data-nfl",
    league_data_payee_name: "League Data Rights (NFL)",
    micros_per_unit: 1_000_000,
    athlete_share_bps: 5000,
  });
  await store.upsertSportsBiometricRoyaltyPolicy({
    league_rights_code: "NFL-LIC-2026",
    licensee_class: "health_tech",
    league_data_payee_id: "league-data-nfl",
    league_data_payee_name: "League Data Rights (NFL)",
    micros_per_unit: 500_000,
    athlete_share_bps: 7000,
  });

  // The NIL lane's payout applications of record — the NIL deal
  // reconciliation reads these through the profile's nil_athlete_id
  // (unmodified; the sports lane never writes them). The source event
  // ids carry the durable sender segment the classification reads.
  await store.insertNilPayoutApplication({
    nil_contract_id: "nil-contract-77",
    athlete_id: "nil-athlete-qb-one",
    school_id: "school-metro-u",
    source_event_id: "nil:brand:SCEN-ENDORSE-1",
    period: "2026-03",
    gross_cents: 625000,
    agency_mode: "none",
    agency_bps: 0,
    agency_fee_cents: 0,
    net_payout_cents: 500000,
    verdict: "paid",
    state_rule_ref: null,
    cap_verified_ref: null,
  });
  await store.insertNilPayoutApplication({
    nil_contract_id: "nil-contract-77",
    athlete_id: "nil-athlete-qb-one",
    school_id: "school-metro-u",
    source_event_id: "nil:collective:SCEN-BOOST-1",
    period: "2026-03",
    gross_cents: 250000,
    agency_mode: "none",
    agency_bps: 0,
    agency_fee_cents: 0,
    net_payout_cents: 250000,
    verdict: "paid",
    state_rule_ref: null,
    cap_verified_ref: null,
  });
}

/** A store pre-loaded with the scenario's registry of record. */
export async function makeSportsScenarioStore(): Promise<InMemoryStore> {
  const store = new InMemoryStore();
  await registerSportsPolicies(store);
  return store;
}
