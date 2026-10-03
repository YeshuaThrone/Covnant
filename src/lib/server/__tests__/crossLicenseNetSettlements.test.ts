// The cross-license net settlement EXECUTION (PR 47) — the behavioral suite
// for the founder's real-time netting directive: mutual patent liabilities
// clear to a SINGLE net dispatch (12M minus 8M nets 4M), the delta
// dispatches through the taxed cascade to the receiving company's vault,
// and the append-only dispatch ledger reconciles to the settlement of
// record's CURRENT sums through late re-netting (an increment dispatches
// the delta; a lower total routes the refund back). Replay and concurrency
// guards hold: two executions of the same settlement state cannot both
// clear (the position-locked (agreement_ref, period, net_before,
// net_after) unique), and every journal balances to the cent.

import { describe, expect, it } from "vitest";

import { InMemoryStore } from "@/lib/server/inMemoryStore";
import type { Store } from "@/lib/server/store";
import { executeCrossLicenseNetSettlement } from "@/lib/server/crossLicenseNetSettlements";
import type { HardwareCrossLicenseAgreementRecord } from "@/modules/hardware/records";

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

const T0 = new Date("2026-10-03T12:00:00.000Z");
const AGREEMENT = "clf-frand-5g-wifi7";
const COMPANY_A = "company-nokia";
const COMPANY_B = "company-samsung";
const PERIOD = "2026-10";

function makeStore(): Store {
  return new InMemoryStore();
}

async function seedAgreement(
  store: Store,
  input?: Partial<HardwareCrossLicenseAgreementRecord>,
): Promise<HardwareCrossLicenseAgreementRecord> {
  const row = {
    agreement_ref: AGREEMENT,
    company_a_id: COMPANY_A,
    company_b_id: COMPANY_B,
    status: "active",
    ...(input ?? {}),
  } as HardwareCrossLicenseAgreementRecord;
  return store.upsertHardwareCrossLicenseAgreement(row);
}

/** The canonical 0050 settlement: A owes B 1.2M (5G SEPs), B owes A 800k
 * (Wi-Fi 7 SEPs) — netting a 400k dispatch to B. */
async function seedSettlement(
  store: Store,
  owedAToB = 1_200_000,
  owedBToA = 800_000,
): Promise<void> {
  await store.upsertHardwareCrossLicenseNetSettlement({
    agreement_ref: AGREEMENT,
    company_a_id: COMPANY_A,
    company_b_id: COMPANY_B,
    period: PERIOD,
    currency: "USD",
    owed_a_to_b_cents: owedAToB,
    owed_b_to_a_cents: owedBToA,
    net_cents: owedAToB - owedBToA,
    direction: owedAToB > owedBToA ? "a_to_b" : owedAToB < owedBToA ? "b_to_a" : "balanced",
  });
}

async function expectJournalBalanced(
  store: Store,
  journalId: string,
): Promise<void> {
  const entries = await store.listGlEntriesByJournal(journalId);
  expect(entries.length).toBeGreaterThan(0);
  const debits = entries.reduce((total, entry) => total + entry.debit_cents, 0);
  const credits = entries.reduce((total, entry) => total + entry.credit_cents, 0);
  expect(debits).toBe(credits);
  expect(debits).toBeGreaterThan(0);
}

async function vaultTotal(store: Store, payeeId: string): Promise<number> {
  const vault = await store.getVault(payeeId);
  if (vault === undefined) return 0;
  return vault.available_balance + vault.pending_balance + vault.reserve_balance;
}

// ---------------------------------------------------------------------------
// The single net dispatch.
// ---------------------------------------------------------------------------

describe("executeCrossLicenseNetSettlement — the single net dispatch", () => {
  it("nets mutual liabilities to ONE dispatch: B's vault receives the net, journal balanced", async () => {
    const store = makeStore();
    await seedAgreement(store);
    await seedSettlement(store);
    const bBefore = await vaultTotal(store, COMPANY_B);

    const executed = await executeCrossLicenseNetSettlement(store, {
      agreement_ref: AGREEMENT,
      period: PERIOD,
    }, T0);
    expect(executed.ok).toBe(true);
    if (!executed.ok) return;
    expect(executed.value.dispatched).toBe(true);
    expect(executed.value.replayed).toBe(false);
    expect(executed.value.dispatched_delta_cents).toBe(400_000);
    expect(executed.value.net_before_cents).toBe(0);
    expect(executed.value.net_after_cents).toBe(400_000);
    expect(executed.value.receiving_payee_id).toBe(COMPANY_B);

    // Exactly ONE dispatch row of record.
    const dispatches = await store.listHardwareCrossLicenseNetDispatches(AGREEMENT, PERIOD);
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0].net_before_cents).toBe(0);
    expect(dispatches[0].net_after_cents).toBe(400_000);
    expect(dispatches[0].dispatched_delta_cents).toBe(400_000);
    expect(dispatches[0].a_gross_cleared_cents).toBe(1_200_000);
    expect(dispatches[0].b_gross_cleared_cents).toBe(800_000);
    expect(dispatches[0].direction).toBe("a_to_b");

    // The receiving company's vault moved by the dispatched delta (after
    // the taxed cascade).
    const landed = await vaultTotal(store, COMPANY_B);
    expect(landed).toBeGreaterThan(bBefore);
    expect(landed - bBefore).toBeLessThanOrEqual(400_000);

    await expectJournalBalanced(store, executed.value.journal_id!);
  });

  it("replays an execution against a current position as a counted no-op", async () => {
    const store = makeStore();
    await seedAgreement(store);
    await seedSettlement(store);

    const first = await executeCrossLicenseNetSettlement(store, {
      agreement_ref: AGREEMENT,
      period: PERIOD,
    }, T0);
    expect(first.ok).toBe(true);

    const replay = await executeCrossLicenseNetSettlement(store, {
      agreement_ref: AGREEMENT,
      period: PERIOD,
    }, T0);
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.value.dispatched).toBe(false);
    expect(replay.value.replayed).toBe(true);
    expect(replay.value.dispatch).toBeNull();
    expect(replay.value.journal_id).toBeNull();

    // Still exactly one dispatch row — no second posting.
    const dispatches = await store.listHardwareCrossLicenseNetDispatches(AGREEMENT, PERIOD);
    expect(dispatches).toHaveLength(1);
  });

  it("treats a genuinely balanced settlement as a no-op without a replay flag", async () => {
    const store = makeStore();
    await seedAgreement(store);
    await seedSettlement(store, 800_000, 800_000);

    const executed = await executeCrossLicenseNetSettlement(store, {
      agreement_ref: AGREEMENT,
      period: PERIOD,
    }, T0);
    expect(executed.ok).toBe(true);
    if (!executed.ok) return;
    expect(executed.value.dispatched).toBe(false);
    expect(executed.value.replayed).toBe(false);
    expect(executed.value.receiving_payee_id).toBeNull();
  });

  it("fails closed when the settlement of record is absent", async () => {
    const store = makeStore();
    await seedAgreement(store);

    const executed = await executeCrossLicenseNetSettlement(store, {
      agreement_ref: AGREEMENT,
      period: PERIOD,
    }, T0);
    expect(executed.ok).toBe(false);
    if (executed.ok) return;
    expect(executed.code).toBe("net_settlement_not_found");
  });

  it("refuses a malformed period or blank agreement", async () => {
    const store = makeStore();

    const badPeriod = await executeCrossLicenseNetSettlement(store, {
      agreement_ref: AGREEMENT,
      period: "2026-10-01",
    }, T0);
    expect(badPeriod.ok).toBe(false);
    if (badPeriod.ok) return;
    expect(badPeriod.code).toBe("invalid_settlement_identity");

    const blankAgreement = await executeCrossLicenseNetSettlement(store, {
      agreement_ref: "",
      period: PERIOD,
    }, T0);
    expect(blankAgreement.ok).toBe(false);
    if (blankAgreement.ok) return;
    expect(blankAgreement.code).toBe("invalid_settlement_identity");
  });
});

// ---------------------------------------------------------------------------
// Late re-netting — the dispatch ledger reconciles to the CURRENT sums.
// ---------------------------------------------------------------------------

describe("late re-netting — increment dispatches, refunds route back", () => {
  it("dispatches the increment when the sheets re-net to a higher total", async () => {
    const store = makeStore();
    await seedAgreement(store);
    await seedSettlement(store);

    const first = await executeCrossLicenseNetSettlement(store, {
      agreement_ref: AGREEMENT,
      period: PERIOD,
    }, T0);
    expect(first.ok).toBe(true);

    // The recomputed sheets: A now owes 1.3M — the net rises to 500k.
    await seedSettlement(store, 1_300_000, 800_000);

    const second = await executeCrossLicenseNetSettlement(store, {
      agreement_ref: AGREEMENT,
      period: PERIOD,
    }, T0);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.dispatched).toBe(true);
    expect(second.value.dispatched_delta_cents).toBe(100_000);
    expect(second.value.net_before_cents).toBe(400_000);
    expect(second.value.net_after_cents).toBe(500_000);
    expect(second.value.receiving_payee_id).toBe(COMPANY_B);

    // The dispatch ledger reconciles to the settlement of record's
    // CURRENT sums — cumulative cleared equals the new owed columns.
    const dispatches = await store.listHardwareCrossLicenseNetDispatches(AGREEMENT, PERIOD);
    expect(dispatches).toHaveLength(2);
    expect(dispatches[1].a_gross_cleared_cents).toBe(1_300_000);
    expect(dispatches[1].b_gross_cleared_cents).toBe(800_000);
    await expectJournalBalanced(store, second.value.journal_id!);
  });

  it("routes the refund back when the sheets re-net to a lower total", async () => {
    const store = makeStore();
    await seedAgreement(store);
    await seedSettlement(store);

    const first = await executeCrossLicenseNetSettlement(store, {
      agreement_ref: AGREEMENT,
      period: PERIOD,
    }, T0);
    expect(first.ok).toBe(true);

    // The recomputed sheets: A now owes 1.1M and B owes 1.0M — the net
    // drops to 100k; the 300k over-dispatch routes back to A.
    await seedSettlement(store, 1_100_000, 1_000_000);
    const aBefore = await vaultTotal(store, COMPANY_A);

    const second = await executeCrossLicenseNetSettlement(store, {
      agreement_ref: AGREEMENT,
      period: PERIOD,
    }, T0);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.dispatched).toBe(true);
    expect(second.value.dispatched_delta_cents).toBe(-300_000);
    expect(second.value.net_after_cents).toBe(100_000);
    expect(second.value.receiving_payee_id).toBe(COMPANY_A);

    // A's vault receives the refund through the taxed cascade.
    const landed = await vaultTotal(store, COMPANY_A);
    expect(landed).toBeGreaterThan(aBefore);
    expect(landed - aBefore).toBeLessThanOrEqual(300_000);

    // The dispatch ledger reconciles: cumulative cleared equals the
    // CURRENT owed columns, position 100k.
    const dispatches = await store.listHardwareCrossLicenseNetDispatches(AGREEMENT, PERIOD);
    expect(dispatches).toHaveLength(2);
    expect(dispatches[1].a_gross_cleared_cents).toBe(1_100_000);
    expect(dispatches[1].b_gross_cleared_cents).toBe(1_000_000);
    expect(dispatches[1].direction).toBe("b_to_a");
    await expectJournalBalanced(store, second.value.journal_id!);
  });

  it("arbitrates concurrent executions at the position-locked insert — the loser re-derives", async () => {
    const store = makeStore();
    await seedAgreement(store);
    await seedSettlement(store);

    // A concurrent execution's row lands first (the same position state):
    // the engine's own insert then loses the unique and re-derives from
    // the fresh truth — a counted no-op, never a second dispatch.
    await store.insertHardwareCrossLicenseNetDispatch({
      agreement_ref: AGREEMENT,
      company_a_id: COMPANY_A,
      company_b_id: COMPANY_B,
      period: PERIOD,
      currency: "USD",
      net_before_cents: 0,
      net_after_cents: 400_000,
      dispatched_delta_cents: 400_000,
      a_gross_cleared_cents: 1_200_000,
      b_gross_cleared_cents: 800_000,
      direction: "a_to_b",
      journal_id: null,
    });

    const executed = await executeCrossLicenseNetSettlement(store, {
      agreement_ref: AGREEMENT,
      period: PERIOD,
    }, T0);
    expect(executed.ok).toBe(true);
    if (!executed.ok) return;
    expect(executed.value.dispatched).toBe(false);
    expect(executed.value.replayed).toBe(true);
    expect(executed.value.dispatch).toBeNull();
    expect(await store.listHardwareCrossLicenseNetDispatches(AGREEMENT, PERIOD)).toHaveLength(1);
  });

  it("executes a b_to_a net when Company B owes more", async () => {
    const store = makeStore();
    await seedAgreement(store);
    await seedSettlement(store, 700_000, 1_100_000);
    const aBefore = await vaultTotal(store, COMPANY_A);

    const executed = await executeCrossLicenseNetSettlement(store, {
      agreement_ref: AGREEMENT,
      period: PERIOD,
    }, T0);
    expect(executed.ok).toBe(true);
    if (!executed.ok) return;
    expect(executed.value.dispatched).toBe(true);
    expect(executed.value.dispatched_delta_cents).toBe(-400_000);
    expect(executed.value.receiving_payee_id).toBe(COMPANY_A);

    const landed = await vaultTotal(store, COMPANY_A);
    expect(landed).toBeGreaterThan(aBefore);
    await expectJournalBalanced(store, executed.value.journal_id!);
  });
});
