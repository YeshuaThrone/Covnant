// Event-cancellation escrow + sports payout gate states + the staged
// sports applications' journal stamps (PR 51, the founder sports
// directive) — three-backend parity for the new store methods, mirroring
// the resource audit escrow parity pattern: the same scenario script runs
// on InMemoryStore, SqliteStore (:memory:), and SupabaseStore over a
// behavioral PostgREST fake.
//
// Under test: the sports payout gate's states of record per (promoter
// payee, event) — event_completion_telemetry_state,
// promoter_insurance_state, the collegiate NIL waterfall's
// nil_compliance_audit_state upsert-converging, absent reads fail-closed —
// the founder-banded (1500–2000 bps) escrow policy per promoter+event
// scope, the escrow drawdown ledger with its two uniques (replay +
// position), the escrow settlement CAS (one winner), and the staged
// resale-royalty and biometric micro-payout applications' journal stamps
// (the instant postings' CAS — journal_id null → stamped exactly once).

import { describe, expect, it } from "vitest";

import { InMemoryStore } from "@/lib/server/inMemoryStore";
import { SqliteStore } from "@/lib/server/sqliteStore";
import type { Store } from "@/lib/server/store";
import { makeFakeSupabaseStore } from "@/workers/recon/__tests__/fakeSupabase";
import { eventCancellationEscrowScopeKey } from "@/modules/sports/records";
import { eventCancellationEscrowPayeeId } from "@/modules/don/constants";

interface BackendSpec {
  name: string;
  make: () => Store;
}

const BACKENDS: BackendSpec[] = [
  { name: "InMemoryStore", make: () => new InMemoryStore() },
  { name: "SqliteStore", make: () => new SqliteStore(":memory:") },
  {
    name: "SupabaseStore",
    make: () => makeFakeSupabaseStore(),
  },
];

/** Both backend surfaces the canonical helper detects: the Postgres 23505
 * code (SupabaseStore wraps it into the thrown message) and SQLite's
 * native constraint text. */
function expectUniqueViolation(error: unknown): void {
  expect(error).toBeInstanceOf(Error);
  const message = (error as Error).message;
  expect(
    message.includes("23505") || message.includes("UNIQUE constraint failed"),
  ).toBe(true);
}

// ---------------------------------------------------------------------------
// The shared scenario script — the PR 51 sports tables.
// ---------------------------------------------------------------------------

const T1 = "2026-10-03T12:00:01.000Z";
const T2 = "2026-10-03T12:00:02.000Z";
const T3 = "2026-10-03T12:00:03.000Z";
const PROMOTER = "promoter-parity";
const EVENT = "EVENT-PARITY-1";
const SCOPE = eventCancellationEscrowScopeKey(PROMOTER, EVENT);
const COMPLETED_AT = "2026-10-03T22:00:00.000Z";

async function scenario(store: Store): Promise<void> {
  // --- The sports payout gate's durable states of record per (promoter
  // payee, event): upsert converges — a verification heals 'unknown'
  // (the collegiate NIL audit and insurance clearances heal the same
  // way); an absent record reads undefined (the gate's fail-closed
  // null). ---
  await store.upsertSportsPayoutGateState({
    payee_id: PROMOTER,
    event_ref: EVENT,
    event_completion_telemetry_state: "unknown",
    promoter_insurance_state: "unknown",
    is_collegiate_nil_waterfall: true,
    nil_compliance_audit_state: "unknown",
    event_completed_at: null,
    evidence_ref: "event-completion-telemetry.json",
    verified_by: "sports-ops-desk",
  });
  const unknownStates = await store.getSportsPayoutGateState(PROMOTER, EVENT);
  expect(unknownStates?.event_completion_telemetry_state).toBe("unknown");
  expect(unknownStates?.promoter_insurance_state).toBe("unknown");
  expect(unknownStates?.nil_compliance_audit_state).toBe("unknown");
  expect(
    await store.getSportsPayoutGateState("promoter-other", EVENT),
  ).toBeUndefined();
  await store.upsertSportsPayoutGateState({
    payee_id: PROMOTER,
    event_ref: EVENT,
    event_completion_telemetry_state: "verified",
    promoter_insurance_state: "cleared",
    is_collegiate_nil_waterfall: true,
    nil_compliance_audit_state: "cleared",
    event_completed_at: COMPLETED_AT,
    evidence_ref: "event-completion-telemetry-v2.json",
    verified_by: "sports-ops-desk",
  });
  const clearedStates = await store.getSportsPayoutGateState(PROMOTER, EVENT);
  expect(clearedStates?.event_completion_telemetry_state).toBe("verified");
  expect(clearedStates?.promoter_insurance_state).toBe("cleared");
  expect(clearedStates?.nil_compliance_audit_state).toBe("cleared");
  expect(clearedStates?.event_completed_at).toBe(COMPLETED_AT);

  // --- The founder-banded escrow policy of record per scope: upsert
  // replaces; unknown scopes read undefined. ---
  await store.upsertEventCancellationEscrowPolicy({
    scope_key: SCOPE,
    reserve_rate_bps: 1_500,
  });
  expect(
    (await store.getEventCancellationEscrowPolicy(SCOPE))?.reserve_rate_bps,
  ).toBe(1_500);
  expect(
    await store.getEventCancellationEscrowPolicy(
      eventCancellationEscrowScopeKey("promoter-other", EVENT),
    ),
  ).toBeUndefined();
  await store.upsertEventCancellationEscrowPolicy({
    scope_key: SCOPE,
    reserve_rate_bps: 2_000,
  });
  expect(
    (await store.getEventCancellationEscrowPolicy(SCOPE))?.reserve_rate_bps,
  ).toBe(2_000);

  // --- The escrow drawdown ledger: replay unique + position unique; the
  // listing reads position (drawn_before_cents) first. reserve_ledger_id
  // values are real ledger rows — the ledger-child discipline. ---
  const escrow = await store.insertLedgerTransaction({
    split_run_id: "",
    line_item_id: SCOPE,
    payee_id: eventCancellationEscrowPayeeId(SCOPE),
    payee_name: `EVENT_CANCELLATION_ESCROW — ${SCOPE}`,
    role: "other",
    share_bps: 0,
    amount_cents: 200_000,
    currency: "USD",
    status: "event_cancellation_escrow",
    rail: null,
    baas_provider: null,
    baas_transfer_id: null,
    created_at: T1,
    settled_at: null,
    kind: "event_cancellation_escrow",
  });
  await store.insertEventCancellationEscrowDrawdown({
    reserve_ledger_id: escrow.id,
    scope_key: SCOPE,
    drawdown_class: "weather_delay",
    source_event_id: "weather-delay-parity-2026-10",
    drawn_before_cents: 200_000,
    drawn_cents: 80_000,
    remaining_cents: 120_000,
  });
  await store.insertEventCancellationEscrowDrawdown({
    reserve_ledger_id: escrow.id,
    scope_key: SCOPE,
    drawdown_class: "athlete_withdrawal",
    source_event_id: "headliner-withdrawal-parity",
    drawn_before_cents: 120_000,
    drawn_cents: 30_000,
    remaining_cents: 90_000,
  });
  let drawReplayThrew: unknown;
  try {
    await store.insertEventCancellationEscrowDrawdown({
      reserve_ledger_id: escrow.id,
      scope_key: SCOPE,
      drawdown_class: "ticket_refund_call",
      source_event_id: "weather-delay-parity-2026-10",
      drawn_before_cents: 60_000,
      drawn_cents: 100,
      remaining_cents: 59_900,
    });
  } catch (error) {
    drawReplayThrew = error;
  }
  expectUniqueViolation(drawReplayThrew);
  let drawPositionThrew: unknown;
  try {
    await store.insertEventCancellationEscrowDrawdown({
      reserve_ledger_id: escrow.id,
      scope_key: SCOPE,
      drawdown_class: "ticket_refund_call",
      source_event_id: "refund-call-parity",
      drawn_before_cents: 120_000,
      drawn_cents: 100,
      remaining_cents: 119_900,
    });
  } catch (error) {
    drawPositionThrew = error;
  }
  expectUniqueViolation(drawPositionThrew);
  const drawdowns = await store.listEventCancellationEscrowDrawdowns(escrow.id);
  expect(drawdowns.map((row) => row.drawn_before_cents)).toEqual([
    200_000,
    120_000,
  ]);

  // --- The settlement CAS: one winner; the loser and unknown ids read
  // undefined. ---
  const settled = await store.settleEventCancellationEscrow(escrow.id, T2);
  expect(settled?.status).toBe("settled");
  expect(settled?.settled_at).toBe(T2);
  expect(
    await store.settleEventCancellationEscrow(escrow.id, T3),
  ).toBeUndefined();
  expect(
    await store.settleEventCancellationEscrow("missing", T3),
  ).toBeUndefined();

  // --- The staged resale royalty application's journal stamp — the
  // instant posting's CAS: journal_id null stamps exactly once; a
  // second stamp, and an unknown id, read undefined; the re-read
  // persists the winner. ---
  const stagedResale = await store.insertSportsResaleRoyaltyApplication({
    source_event_id: "resale_royalty:PARITY-1:USD",
    resale_sale_event_id: "resale:PARITY-1",
    venue_gln: "GLN-PARITY-VENUE",
    league_rights_code: "LEAGUE-PARITY",
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
  });
  expect(stagedResale.journal_id).toBeNull();
  const resaleStamped = await store.setSportsResaleRoyaltyJournal(
    "resale_royalty:PARITY-1:USD",
    "journal-parity-resale-1",
  );
  expect(resaleStamped?.journal_id).toBe("journal-parity-resale-1");
  expect(
    await store.setSportsResaleRoyaltyJournal(
      "resale_royalty:PARITY-1:USD",
      "journal-parity-resale-2",
    ),
  ).toBeUndefined();
  expect(
    await store.setSportsResaleRoyaltyJournal("resale_royalty:missing", "j"),
  ).toBeUndefined();
  expect(
    (await store.getSportsResaleRoyaltyApplication("resale_royalty:PARITY-1:USD"))
      ?.journal_id,
  ).toBe("journal-parity-resale-1");

  // --- The staged biometric micro-payout application's journal stamp —
  // the same CAS for the athlete-wallet + league data-rights instant
  // posting. ---
  const stagedBiometric = await store.insertSportsBiometricMicroPayoutApplication({
    source_event_id: "biometric_payout:PARITY-1:USD",
    biometric_post_event_id: "biometric:PARITY-1",
    athlete_glan: "GLN-PARITY-ATHLETE",
    league_rights_code: "LEAGUE-PARITY",
    tracking_modality: "wearable",
    licensee_class: "media_network",
    licensed_quantity_micros: 250_000_000,
    micros_per_unit: 1_200,
    athlete_share_bps: 6_000,
    payout_pot_cents: 30_000,
    athlete_wallet_payee_id: "athlete-wallet-parity",
    athlete_leg_cents: 18_000,
    league_data_payee_id: "league-data-parity",
    league_leg_cents: 12_000,
    journal_id: null,
  });
  expect(stagedBiometric.journal_id).toBeNull();
  const biometricStamped = await store.setSportsBiometricMicroPayoutJournal(
    "biometric_payout:PARITY-1:USD",
    "journal-parity-biometric-1",
  );
  expect(biometricStamped?.journal_id).toBe("journal-parity-biometric-1");
  expect(
    await store.setSportsBiometricMicroPayoutJournal(
      "biometric_payout:PARITY-1:USD",
      "journal-parity-biometric-2",
    ),
  ).toBeUndefined();
  expect(
    await store.setSportsBiometricMicroPayoutJournal(
      "biometric_payout:missing",
      "j",
    ),
  ).toBeUndefined();
  expect(
    (
      await store.getSportsBiometricMicroPayoutApplication(
        "biometric_payout:PARITY-1:USD",
      )
    )?.journal_id,
  ).toBe("journal-parity-biometric-1");
}

describe("event-cancellation escrow + sports payout gate states + staged application journal stamps — three-backend parity", () => {
  for (const backend of BACKENDS) {
    describe(backend.name, () => {
      it("guards the gate states, escrow policy, drawdowns, settle CAS, and instant-posting journal stamps identically", async () => {
        await scenario(backend.make());
      });
    });
  }
});
