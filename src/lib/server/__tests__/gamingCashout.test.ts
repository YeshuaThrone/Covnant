// Gaming cashout ledger states (PR 13) — the in-memory battery.
//
// Locked invariants under test, per the founder gaming directive: money
// received from a game platform LOCKS in VIRTUAL_CURRENCY_CASHOUT_PENDING
// (out of every vault, out of the holding bucket, out of the film escrow)
// until Astra cross-references the platform payout batch against the
// verified studio contracts AND the store statements, and the batch's
// virtual-currency conversion logs EXIST and are ALL 'fiat_settled'; the
// verified release rides the normal clearance-gated settlement path and
// moves NO money on any refusal; the durable DevEx conversion log is
// idempotent per funding line (content-derived event id, counted no-op on
// replay); studio team KYC feeds the gaming payout gate fail-closed (no
// record refuses, a failed/unknown member check refuses); allocations +
// dust equals gross INCLUDING the cashout bucket; integer cents throughout;
// per-source post idempotency; the settle CAS guards concurrency.

import { afterEach, describe, expect, it } from "vitest";
import { InMemoryStore } from "@/lib/server/inMemoryStore";
import {
  gamingDevexConversionEventId,
  ingestGamingDevexConversionLog,
  platformFromCashoutPayeeId,
  postToGamingCashoutPending,
  releaseGamingCashout,
  settleGamingDevexBatchFiat,
} from "@/lib/server/gamingCashout";
import {
  resolveGamingVerticalComplianceState,
  validateGamingStudioKyc,
} from "@/modules/compliance/gamingStudioKyc";
import {
  COMPANY_VARIANCE_PAYEE_ID,
  COMPANY_VARIANCE_PAYEE_NAME,
  gamingCashoutGlAccount,
  gamingCashoutPayeeId,
  gamingCashoutPayeeName,
} from "@/modules/don/constants";
import { setVerticalComplianceStateSource } from "@/modules/compliance/payoutGate";
import type { GamingDevexConversionLogRecord, GamingStudioKycRecord } from "@/modules/don/records";
import type { LedgerTransactionRecord } from "@/lib/don/types";
import type { Store } from "@/lib/server/store";

const NOW = new Date("2026-09-30T12:00:00Z");
const LATER = new Date("2026-09-30T12:01:00Z");
const PLATFORM = "Roblox";
const BATCH = "rbx-payout-2026-40";

type Failure = { ok: false; status: number; code: string; message: string };
type Success<V> = { ok: true; value: V };

function mustSucceed<V>(result: Success<V> | Failure): V {
  if (!result.ok) {
    throw new Error(
      `expected success, got ${result.status} ${result.code}: ${result.message}`,
    );
  }
  return result.value;
}

function mustFail<V>(
  result: Success<V> | Failure | { ok: true },
  status: number,
  code: string,
): Failure {
  if (result.ok) {
    throw new Error(`expected ${status} ${code} but the call succeeded`);
  }
  expect(result.status).toBe(status);
  expect(result.code).toBe(code);
  return result;
}

async function seedVault(
  store: Store,
  payeeId: string,
  payeeName: string,
): Promise<void> {
  await store.upsertVault({
    payee_id: payeeId,
    payee_name: payeeName,
    available_balance: 0,
    pending_balance: 0,
    reserve_balance: 0,
    updated_at: NOW.toISOString(),
  });
}

/** A KYC-verified creator with a verified tax profile — no withholding. */
async function seedVerifiedCreator(
  store: Store,
  creatorId: string,
  creatorName: string,
): Promise<void> {
  await seedVault(store, creatorId, creatorName);
  await store.insertKycVerification({
    creator_id: creatorId,
    plaid_link_token: "link-token",
    plaid_public_token: "public-token",
    status: "verified",
    identity_json: "{}",
    failure_reason: null,
    created_at: NOW.toISOString(),
    verified_at: NOW.toISOString(),
  });
  await store.upsertCreatorTaxProfile({
    creator_id: creatorId,
    tin_verified: 1,
    w9_on_file: 1,
    updated_at: NOW.toISOString(),
  });
}

/** The gaming vertical's compliance state, fully satisfied. */
function gamingStateSatisfied(): void {
  setVerticalComplianceStateSource(async () => ({
    vertical: "gaming",
    platform_commission_deducted: true,
    studio_kyc_verified: true,
    team_member_checks: [
      { member_ref: "member-3d-artist", identity_check_passed: true },
      { member_ref: "member-developer", identity_check_passed: true },
      { member_ref: "member-sound-designer", identity_check_passed: true },
    ],
  }));
}

/**
 * Wires the gaming vertical's state through the REAL studio-KYC resolver —
 * the store-backed integration the recon layer ships (the record the gate
 * reads, not a test stub).
 */
function gamingStateFromStudioKyc(
  store: Store,
  platformCommissionDeducted: boolean,
): void {
  setVerticalComplianceStateSource(async (input) =>
    resolveGamingVerticalComplianceState(
      store,
      input.payeeId,
      platformCommissionDeducted,
    ),
  );
}

function verifiedStudioKyc(
  store: Store,
  studioPayeeId: string,
  overrides: Partial<Omit<GamingStudioKycRecord, "id" | "created_at" | "updated_at">> = {},
): Promise<GamingStudioKycRecord> {
  const validated = validateGamingStudioKyc({
    studio_payee_id: studioPayeeId,
    studio_kyc_status: "verified",
    team_members: [
      { member_ref: "member-3d-artist", role: "3d_artist", identity_check_passed: true },
      { member_ref: "member-developer", role: "developer", identity_check_passed: true },
      { member_ref: "member-sound-designer", role: "sound_designer", identity_check_passed: true },
    ],
    contract_ref: "studio-contract-2026-014",
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    ...overrides,
  });
  if (!validated.ok) throw new Error(`test setup: ${validated.message}`);
  return store.upsertGamingStudioKyc({
    ...validated.record,
    id: `kyc-${studioPayeeId}`,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  });
}

const DEVEX_FACTS = {
  line_event_id: "evt-devex-1",
  denomination: "Robux",
  virtual_amount: "2857142.857142857",
  exchange_rate: "0.0035",
  settlement_batch_ref: BATCH,
};

type CashoutPostInput = Parameters<typeof postToGamingCashoutPending>[1];

async function lockReceipt(
  store: Store,
  overrides: Partial<CashoutPostInput> = {},
  eventId = "evt-gaming-1",
): Promise<LedgerTransactionRecord> {
  return (
    await mustSucceed(
      await postToGamingCashoutPending(
        store,
        {
          platform: PLATFORM,
          amount_cents: 10_000,
          currency: "USD",
          source: { type: "match_queue", event_id: eventId },
          conversion: { ...DEVEX_FACTS, line_event_id: eventId },
          ...overrides,
        },
        NOW,
      ),
    )
  ).cashout_credit;
}

/** The conversion-log ingest, narrowed — its success shape carries log and counted directly. */
async function mustIngest(
  store: Store,
  input: Parameters<typeof ingestGamingDevexConversionLog>[1],
): Promise<{ log: GamingDevexConversionLogRecord; counted: boolean }> {
  const result = await ingestGamingDevexConversionLog(store, input);
  if (!result.ok) {
    throw new Error(
      `expected ingest success, got ${result.status} ${result.code}: ${result.message}`,
    );
  }
  return result;
}

/** The batch settlement call, narrowed — its success shape carries the count directly. */
async function mustSettle(
  store: Store,
  batchRef: string,
  settledAt: string,
): Promise<{ settled_count: number }> {
  const result = await settleGamingDevexBatchFiat(store, batchRef, settledAt);
  if (!result.ok) {
    throw new Error(
      `expected settlement success, got ${result.status} ${result.code}: ${result.message}`,
    );
  }
  return result;
}

/** A conversion log for the batch, with the lock, settled at the platform. */
async function lockAndSettleBatch(
  store: Store,
  amountCents = 10_000,
): Promise<LedgerTransactionRecord> {
  const credit = await lockReceipt(store, { amount_cents: amountCents });
  const settled = await mustSettle(store, BATCH, LATER.toISOString());
  expect(settled.settled_count).toBe(1);
  return credit;
}

const VERIFICATION = {
  studio_contract_ref: "studio-contract-2026-014",
  store_statement_refs: ["stmt-rbx-2026-40-a", "stmt-rbx-2026-40-b"],
};

afterEach(() => {
  // The operations-seam override is process-global — reset it every test.
  setVerticalComplianceStateSource(null);
});

describe("postToGamingCashoutPending", () => {
  it("locks the platform receipt in cashout-pending and posts the balanced journal", async () => {
    const store = new InMemoryStore();
    const posted = mustSucceed(
      await postToGamingCashoutPending(
        store,
        {
          platform: PLATFORM,
          amount_cents: 10_000,
          currency: "USD",
          source: { type: "match_queue", event_id: "evt-gaming-1" },
          conversion: null,
        },
        NOW,
      ),
    );

    // The row: kind AND status both 'virtual_currency_cashout_pending',
    // the PER-PLATFORM payee carrying the business key.
    expect(posted.cashout_credit.kind).toBe("virtual_currency_cashout_pending");
    expect(posted.cashout_credit.status).toBe("virtual_currency_cashout_pending");
    expect(posted.cashout_credit.payee_id).toBe(gamingCashoutPayeeId(PLATFORM));
    expect(posted.cashout_credit.payee_name).toBe(gamingCashoutPayeeName(PLATFORM));
    expect(posted.cashout_credit.amount_cents).toBe(10_000);
    expect(posted.cashout_credit.line_item_id).toBe("evt-gaming-1");

    // The journal: FBO debit against the platform's cashout-pending credit.
    const entries = await store.listGlEntriesByJournal(posted.journal_id);
    expect(
      entries.find((e) => e.account === gamingCashoutGlAccount(PLATFORM))?.credit_cents,
    ).toBe(10_000);
    expect(entries.reduce((s, e) => s + e.debit_cents, 0)).toBe(10_000);
    expect(entries.reduce((s, e) => s + e.credit_cents, 0)).toBe(10_000);

    // The locked receipt is the held view's only row.
    expect((await store.listVirtualCurrencyCashoutCredits()).map((r) => r.id)).toEqual([
      posted.cashout_credit.id,
    ]);
  });

  it("writes the durable DevEx conversion log in the same pass when the line carries DevEx facts", async () => {
    const store = new InMemoryStore();
    const posted = mustSucceed(
      await postToGamingCashoutPending(
        store,
        {
          platform: PLATFORM,
          amount_cents: 10_000,
          currency: "USD",
          source: { type: "match_queue", event_id: "evt-gaming-1" },
          conversion: { ...DEVEX_FACTS, line_event_id: "evt-gaming-1" },
        },
        NOW,
      ),
    );

    // The founder's rate-logging rule, made state: denomination, exact
    // virtual amount, applied rate, integer-cent fiat net, batch ref,
    // pending fiat settlement.
    expect(posted.conversion_log).not.toBeNull();
    expect(posted.conversion_log_counted).toBe(true);
    expect(posted.conversion_log?.event_id).toBe(
      gamingDevexConversionEventId("evt-gaming-1"),
    );
    expect(posted.conversion_log?.platform).toBe(PLATFORM);
    expect(posted.conversion_log?.denomination).toBe("Robux");
    expect(posted.conversion_log?.virtual_amount).toBe("2857142.857142857");
    expect(posted.conversion_log?.exchange_rate).toBe("0.0035");
    expect(posted.conversion_log?.fiat_net_cents).toBe(10_000);
    expect(posted.conversion_log?.settlement_batch_ref).toBe(BATCH);
    expect(posted.conversion_log?.status).toBe("pending_fiat_settlement");
    expect(posted.conversion_log?.settled_at).toBeNull();
  });

  it("refuses a replayed post per source (409) and never double-posts the journal", async () => {
    const store = new InMemoryStore();
    await lockReceipt(store);
    const replay = mustFail(
      await postToGamingCashoutPending(
        store,
        {
          platform: PLATFORM,
          amount_cents: 10_000,
          currency: "USD",
          source: { type: "match_queue", event_id: "evt-gaming-1" },
          conversion: { ...DEVEX_FACTS, line_event_id: "evt-gaming-1" },
        },
        NOW,
      ),
      409,
      "gaming_receipt_already_posted",
    );
    expect(replay.message).toContain("evt-gaming-1");
    expect((await store.listVirtualCurrencyCashoutCredits()).length).toBe(1);
  });

  it("refuses blank platforms and non-integer/non-positive amounts", async () => {
    const store = new InMemoryStore();
    mustFail(
      await postToGamingCashoutPending(
        store,
        {
          platform: "  ",
          amount_cents: 10_000,
          currency: "USD",
          source: { type: "manual", note: "" },
          conversion: null,
        },
        NOW,
      ),
      422,
      "invalid_platform",
    );
    mustFail(
      await postToGamingCashoutPending(
        store,
        {
          platform: PLATFORM,
          amount_cents: 1_000.5,
          currency: "USD",
          source: { type: "manual", note: "" },
          conversion: null,
        },
        NOW,
      ),
      422,
      "invalid_amount",
    );
    mustFail(
      await postToGamingCashoutPending(
        store,
        {
          platform: PLATFORM,
          amount_cents: 0,
          currency: "USD",
          source: { type: "manual", note: "" },
          conversion: null,
        },
        NOW,
      ),
      422,
      "invalid_amount",
    );
  });
});

describe("ingestGamingDevexConversionLog", () => {
  it("derives the content-derived event id and counts a replay as a no-op", async () => {
    const store = new InMemoryStore();
    const first = await mustIngest(store, {
      line_event_id: "evt-devex-1",
      platform: PLATFORM,
      facts: DEVEX_FACTS,
      fiat_net_cents: 10_000,
      createdAt: NOW.toISOString(),
    });
    expect(first.counted).toBe(true);
    expect(first.log.event_id).toBe("gaming:devex:evt-devex-1");

    // The replayed ingest re-derives the same id, finds the existing row,
    // and writes nothing — counted: false, same record.
    const replay = await mustIngest(store, {
      line_event_id: "evt-devex-1",
      platform: PLATFORM,
      facts: DEVEX_FACTS,
      fiat_net_cents: 10_000,
      createdAt: NOW.toISOString(),
    });
    expect(replay.counted).toBe(false);
    expect(replay.log.id).toBe(first.log.id);
  });

  it("refuses blank facts, float fiat nets, and unnamed batches", async () => {
    const store = new InMemoryStore();
    const base = {
      line_event_id: "evt-devex-1",
      platform: PLATFORM,
      facts: DEVEX_FACTS,
      fiat_net_cents: 10_000,
      createdAt: NOW.toISOString(),
    };
    mustFail(
      await ingestGamingDevexConversionLog(store, { ...base, line_event_id: " " }),
      422,
      "invalid_conversion_line_event",
    );
    mustFail(
      await ingestGamingDevexConversionLog(store, {
        ...base,
        facts: { ...DEVEX_FACTS, denomination: "" },
      }),
      422,
      "invalid_conversion_denomination",
    );
    mustFail(
      await ingestGamingDevexConversionLog(store, {
        ...base,
        facts: { ...DEVEX_FACTS, virtual_amount: "", exchange_rate: "0.0035" },
      }),
      422,
      "invalid_conversion_amounts",
    );
    mustFail(
      await ingestGamingDevexConversionLog(store, {
        ...base,
        facts: { ...DEVEX_FACTS, settlement_batch_ref: " " },
      }),
      422,
      "invalid_conversion_batch_ref",
    );
    mustFail(
      await ingestGamingDevexConversionLog(store, { ...base, fiat_net_cents: 0.5 }),
      422,
      "invalid_conversion_fiat_net",
    );
  });
});

describe("settleGamingDevexBatchFiat", () => {
  it("flips every pending log of the batch, touches settled rows, and reports the honest count", async () => {
    const store = new InMemoryStore();
    await ingestGamingDevexConversionLog(store, {
      line_event_id: "evt-devex-1",
      platform: PLATFORM,
      facts: DEVEX_FACTS,
      fiat_net_cents: 10_000,
      createdAt: NOW.toISOString(),
    });
    await ingestGamingDevexConversionLog(store, {
      line_event_id: "evt-devex-2",
      platform: PLATFORM,
      facts: {
        ...DEVEX_FACTS,
        line_event_id: "evt-devex-2",
        settlement_batch_ref: "other-batch",
      },
      fiat_net_cents: 5_000,
      createdAt: NOW.toISOString(),
    });

    const first = await mustSettle(store, BATCH, LATER.toISOString());
    expect(first.settled_count).toBe(1);
    const settledLog = await store.getGamingDevexConversionLogByEventId(
      gamingDevexConversionEventId("evt-devex-1"),
    );
    expect(settledLog?.status).toBe("fiat_settled");
    expect(settledLog?.settled_at).toBe(LATER.toISOString());

    // The other batch's log rides untouched.
    const otherLog = await store.getGamingDevexConversionLogByEventId(
      gamingDevexConversionEventId("evt-devex-2"),
    );
    expect(otherLog?.status).toBe("pending_fiat_settlement");

    // A second settlement flips nothing — the count is honest.
    const again = await mustSettle(store, BATCH, LATER.toISOString());
    expect(again.settled_count).toBe(0);

    mustFail(
      await settleGamingDevexBatchFiat(store, " ", LATER.toISOString()),
      422,
      "invalid_batch_ref",
    );
  });
});

describe("releaseGamingCashout — refusal before full verification", () => {
  it("refuses unknown ids, non-cashout kinds, released rows, and corrupted payees — money never moves", async () => {
    const store = new InMemoryStore();
    mustFail(
      await releaseGamingCashout(
        store,
        {
          cashout_ledger_id: "missing",
          batch_ref: BATCH,
          verification: VERIFICATION,
          creator_allocations: [],
          operator_settlement_approved: true,
        },
        LATER,
      ),
      404,
      "cashout_receipt_not_found",
    );

    // An ordinary royalty row is not a cashout receipt.
    const royalty = await store.insertLedgerTransaction({
      split_run_id: "run-1",
      line_item_id: "",
      payee_id: "creator_x",
      payee_name: "Creator X",
      role: "creator",
      share_bps: 10_000,
      amount_cents: 5_000,
      currency: "USD",
      status: "pending_settlement",
      rail: null,
      baas_provider: null,
      baas_transfer_id: null,
      created_at: NOW.toISOString(),
      settled_at: null,
      kind: "royalty",
    });
    mustFail(
      await releaseGamingCashout(
        store,
        {
          cashout_ledger_id: royalty.id,
          batch_ref: BATCH,
          verification: VERIFICATION,
          creator_allocations: [],
          operator_settlement_approved: true,
        },
        LATER,
      ),
      422,
      "not_a_cashout_receipt",
    );

    // A released cashout receipt no longer releases (409) — and a locked
    // receipt with a corrupted (non-cashout) payee refuses at 500.
    const credit = await lockAndSettleBatch(store);
    expect(
      (await store.settleVirtualCurrencyCashout(credit.id, LATER.toISOString()))
        ?.status,
    ).toBe("settled");
    mustFail(
      await releaseGamingCashout(
        store,
        {
          cashout_ledger_id: credit.id,
          batch_ref: BATCH,
          verification: VERIFICATION,
          creator_allocations: [],
          operator_settlement_approved: true,
        },
        LATER,
      ),
      409,
      "cashout_already_released",
    );

    const corrupted = await store.insertLedgerTransaction({
      split_run_id: "",
      line_item_id: "",
      payee_id: "creator_x",
      payee_name: "Creator X",
      role: "creator",
      share_bps: 0,
      amount_cents: 10_000,
      currency: "USD",
      status: "virtual_currency_cashout_pending",
      rail: null,
      baas_provider: null,
      baas_transfer_id: null,
      created_at: NOW.toISOString(),
      settled_at: null,
      kind: "virtual_currency_cashout_pending",
    });
    mustFail(
      await releaseGamingCashout(
        store,
        {
          cashout_ledger_id: corrupted.id,
          batch_ref: BATCH,
          verification: VERIFICATION,
          creator_allocations: [],
          operator_settlement_approved: true,
        },
        LATER,
      ),
      500,
      "cashout_payee_corrupted",
    );
  });

  it("refuses before the cross-reference evidence is present (blank contract, empty statements, blank statement ref)", async () => {
    const store = new InMemoryStore();
    await seedVerifiedCreator(store, "creator_1", "Creator One");
    await seedVault(store, COMPANY_VARIANCE_PAYEE_ID, COMPANY_VARIANCE_PAYEE_NAME);
    gamingStateSatisfied();
    const credit = await lockAndSettleBatch(store);
    const allocation = [
      { payee_id: "creator_1", payee_name: "Creator One", role: "creator" as const, amount_cents: 10_000 },
    ];

    mustFail(
      await releaseGamingCashout(
        store,
        {
          cashout_ledger_id: credit.id,
          batch_ref: BATCH,
          verification: { ...VERIFICATION, studio_contract_ref: " " },
          creator_allocations: allocation,
          operator_settlement_approved: true,
        },
        LATER,
      ),
      422,
      "cross_reference_verification_required",
    );
    mustFail(
      await releaseGamingCashout(
        store,
        {
          cashout_ledger_id: credit.id,
          batch_ref: BATCH,
          verification: { ...VERIFICATION, store_statement_refs: [] },
          creator_allocations: allocation,
          operator_settlement_approved: true,
        },
        LATER,
      ),
      422,
      "cross_reference_verification_required",
    );
    mustFail(
      await releaseGamingCashout(
        store,
        {
          cashout_ledger_id: credit.id,
          batch_ref: BATCH,
          verification: { ...VERIFICATION, store_statement_refs: ["stmt-1", " "] },
          creator_allocations: allocation,
          operator_settlement_approved: true,
        },
        LATER,
      ),
      422,
      "cross_reference_verification_required",
    );
    mustFail(
      await releaseGamingCashout(
        store,
        {
          cashout_ledger_id: credit.id,
          batch_ref: " ",
          verification: VERIFICATION,
          creator_allocations: allocation,
          operator_settlement_approved: true,
        },
        LATER,
      ),
      422,
      "cashout_batch_ref_required",
    );
  });

  it("refuses while the batch's conversion logs are missing or not all fiat-settled — one pending log holds the whole batch", async () => {
    const store = new InMemoryStore();
    await seedVerifiedCreator(store, "creator_1", "Creator One");
    await seedVault(store, COMPANY_VARIANCE_PAYEE_ID, COMPANY_VARIANCE_PAYEE_NAME);
    gamingStateSatisfied();

    // No logs at all for the named batch — the audit trail is incomplete.
    const lockedWithoutLog = await lockReceipt(store, { conversion: null }, "evt-gaming-no-log");
    mustFail(
      await releaseGamingCashout(
        store,
        {
          cashout_ledger_id: lockedWithoutLog.id,
          batch_ref: "never-logged-batch",
          verification: VERIFICATION,
          creator_allocations: [
            { payee_id: "creator_1", payee_name: "Creator One", role: "creator", amount_cents: 10_000 },
          ],
          operator_settlement_approved: true,
        },
        LATER,
      ),
      422,
      "cashout_conversion_logs_missing",
    );

    // The log exists but the platform's fiat settlement has not completed.
    const credit = await lockReceipt(store, {}, "evt-gaming-2");
    mustFail(
      await releaseGamingCashout(
        store,
        {
          cashout_ledger_id: credit.id,
          batch_ref: BATCH,
          verification: VERIFICATION,
          creator_allocations: [
            { payee_id: "creator_1", payee_name: "Creator One", role: "creator", amount_cents: 10_000 },
          ],
          operator_settlement_approved: true,
        },
        LATER,
      ),
      422,
      "cashout_fiat_settlement_pending",
    );

    // Money never moved: the receipt is still locked, the vault is empty.
    expect((await store.listVirtualCurrencyCashoutCredits()).map((r) => r.id)).toContain(
      credit.id,
    );
    expect((await store.getVault("creator_1"))?.pending_balance).toBe(0);
    expect((await store.getVault("creator_1"))?.available_balance).toBe(0);
  });

  it("refuses unapproved operators and absent studio states — fail-closed", async () => {
    const store = new InMemoryStore();
    await seedVerifiedCreator(store, "creator_1", "Creator One");
    await seedVault(store, COMPANY_VARIANCE_PAYEE_ID, COMPANY_VARIANCE_PAYEE_NAME);
    const credit = await lockAndSettleBatch(store);
    const creatorAllocation = [
      { payee_id: "creator_1", payee_name: "Creator One", role: "creator" as const, amount_cents: 10_000 },
    ];

    // No operator settlement approval.
    gamingStateSatisfied();
    mustFail(
      await releaseGamingCashout(
        store,
        {
          cashout_ledger_id: credit.id,
          batch_ref: BATCH,
          verification: VERIFICATION,
          creator_allocations: creatorAllocation,
          operator_settlement_approved: false,
        },
        LATER,
      ),
      403,
      "settlement_not_approved",
    );

    // The gaming vertical's studio state does not exist yet — the wired
    // source reads the store and finds no record (vertical_state_unknown).
    gamingStateFromStudioKyc(store, true);
    mustFail(
      await releaseGamingCashout(
        store,
        {
          cashout_ledger_id: credit.id,
          batch_ref: BATCH,
          verification: VERIFICATION,
          creator_allocations: creatorAllocation,
          operator_settlement_approved: true,
        },
        LATER,
      ),
      403,
      "vertical_state_unknown",
    );

    // Money never moved on any refusal.
    expect((await store.listVirtualCurrencyCashoutCredits()).map((r) => r.id)).toContain(
      credit.id,
    );
    expect((await store.getVault("creator_1"))?.pending_balance).toBe(0);
  });

  it("enforces the team-member identity gate through the wired studio-KYC record", async () => {
    const store = new InMemoryStore();
    await seedVerifiedCreator(store, "creator_1", "Creator One");
    await seedVault(store, COMPANY_VARIANCE_PAYEE_ID, COMPANY_VARIANCE_PAYEE_NAME);

    // The studio is verified but ONE named team member's identity check has
    // not passed (the 3D artist's check failed).
    await verifiedStudioKyc(store, "creator_1", {
      team_members: [
        { member_ref: "member-3d-artist", role: "3d_artist", identity_check_passed: false },
        { member_ref: "member-developer", role: "developer", identity_check_passed: true },
      ],
    });
    gamingStateFromStudioKyc(store, true);

    const credit = await lockAndSettleBatch(store);
    mustFail(
      await releaseGamingCashout(
        store,
        {
          cashout_ledger_id: credit.id,
          batch_ref: BATCH,
          verification: VERIFICATION,
          creator_allocations: [
            { payee_id: "creator_1", payee_name: "Creator One", role: "creator", amount_cents: 10_000 },
          ],
          operator_settlement_approved: true,
        },
        LATER,
      ),
      403,
      "gaming_team_identity_unverified",
    );

    // The studio's own pending status refuses too.
    await verifiedStudioKyc(store, "creator_1", { studio_kyc_status: "pending" });
    mustFail(
      await releaseGamingCashout(
        store,
        {
          cashout_ledger_id: credit.id,
          batch_ref: BATCH,
          verification: VERIFICATION,
          creator_allocations: [
            { payee_id: "creator_1", payee_name: "Creator One", role: "creator", amount_cents: 10_000 },
          ],
          operator_settlement_approved: true,
        },
        LATER,
      ),
      403,
      "gaming_studio_kyc_not_verified",
    );
  });

  it("refuses invalid creator routings — float amounts, duplicates, allocations exceeding the receipt", async () => {
    const store = new InMemoryStore();
    await seedVerifiedCreator(store, "creator_1", "Creator One");
    await seedVault(store, "creator_2", "Creator Two");
    await seedVault(store, COMPANY_VARIANCE_PAYEE_ID, COMPANY_VARIANCE_PAYEE_NAME);
    gamingStateSatisfied();
    const credit = await lockAndSettleBatch(store);

    mustFail(
      await releaseGamingCashout(
        store,
        {
          cashout_ledger_id: credit.id,
          batch_ref: BATCH,
          verification: VERIFICATION,
          creator_allocations: [
            { payee_id: "creator_1", payee_name: "Creator One", role: "creator", amount_cents: 5_000.5 },
          ],
          operator_settlement_approved: true,
        },
        LATER,
      ),
      422,
      "invalid_amount",
    );
    mustFail(
      await releaseGamingCashout(
        store,
        {
          cashout_ledger_id: credit.id,
          batch_ref: BATCH,
          verification: VERIFICATION,
          creator_allocations: [
            { payee_id: "creator_1", payee_name: "Creator One", role: "creator", amount_cents: 2_000 },
            { payee_id: "creator_1", payee_name: "Creator One", role: "creator", amount_cents: 3_000 },
          ],
          operator_settlement_approved: true,
        },
        LATER,
      ),
      422,
      "duplicate_creator_allocation",
    );
    mustFail(
      await releaseGamingCashout(
        store,
        {
          cashout_ledger_id: credit.id,
          batch_ref: BATCH,
          verification: VERIFICATION,
          creator_allocations: [
            { payee_id: "creator_1", payee_name: "Creator One", role: "creator", amount_cents: 10_001 },
          ],
          operator_settlement_approved: true,
        },
        LATER,
      ),
      422,
      "allocations_exceed_receipt",
    );
  });
});

describe("releaseGamingCashout — the verified release", () => {
  it("routes the creator credits through the clearance-gated sequence and sweeps dust", async () => {
    const store = new InMemoryStore();
    await seedVerifiedCreator(store, "creator_1", "Creator One");
    await seedVerifiedCreator(store, "creator_2", "Creator Two");
    await seedVault(store, COMPANY_VARIANCE_PAYEE_ID, COMPANY_VARIANCE_PAYEE_NAME);
    gamingStateSatisfied();

    // A 10,000-cent batch: 6,000 to creator 1, 3,999 to creator 2, 1 cent
    // of dust to the company variance payee.
    const credit = await lockAndSettleBatch(store);
    const release = mustSucceed(
      await releaseGamingCashout(
        store,
        {
          cashout_ledger_id: credit.id,
          batch_ref: BATCH,
          verification: VERIFICATION,
          creator_allocations: [
            { payee_id: "creator_1", payee_name: "Creator One", role: "creator", amount_cents: 6_000 },
            { payee_id: "creator_2", payee_name: "Creator Two", role: "creator", amount_cents: 3_999 },
          ],
          operator_settlement_approved: true,
        },
        LATER,
      ),
    );

    // The row: settled, kind retained, settled_at stamped.
    expect(release.cashout_credit.status).toBe("settled");
    expect(release.cashout_credit.kind).toBe("virtual_currency_cashout_pending");
    expect(release.cashout_credit.settled_at).toBe(LATER.toISOString());
    expect(release.settled_conversion_logs).toBe(1);

    // The creator credits: verified tax profiles → no withholding, pending
    // bucket (dispatch stays downstream of the operator).
    expect(release.creator_credits).toEqual([
      { payee_id: "creator_1", payee_name: "Creator One", role: "creator", gross_cents: 6_000, net_cents: 6_000 },
      { payee_id: "creator_2", payee_name: "Creator Two", role: "creator", gross_cents: 3_999, net_cents: 3_999 },
    ]);
    expect((await store.getVault("creator_1"))?.pending_balance).toBe(6_000);
    expect((await store.getVault("creator_2"))?.pending_balance).toBe(3_999);
    expect((await store.getVault(COMPANY_VARIANCE_PAYEE_ID))?.pending_balance).toBe(1);
    expect(release.company_dust_cents).toBe(1);
    expect(release.dust_ledger).toHaveLength(1);

    // The journal balances: the cashout debit covers credits + dust.
    const entries = await store.listGlEntriesByJournal(release.journal_id);
    expect(
      entries.find((e) => e.account === gamingCashoutGlAccount(PLATFORM))?.debit_cents,
    ).toBe(10_000);
    expect(entries.reduce((s, e) => s + e.debit_cents, 0)).toBe(10_000);
    expect(entries.reduce((s, e) => s + e.credit_cents, 0)).toBe(10_000);

    // The cashout is empty; a replayed release refuses with the same 409.
    expect(await store.listVirtualCurrencyCashoutCredits()).toEqual([]);
    mustFail(
      await releaseGamingCashout(
        store,
        {
          cashout_ledger_id: credit.id,
          batch_ref: BATCH,
          verification: VERIFICATION,
          creator_allocations: [
            { payee_id: "creator_1", payee_name: "Creator One", role: "creator", amount_cents: 6_000 },
          ],
          operator_settlement_approved: true,
        },
        LATER,
      ),
      409,
      "cashout_already_released",
    );
  });
});

describe("studio team KYC — validation and the wired resolver", () => {
  it("refuses empty rosters, blank refs, duplicate members, unknown statuses, and non-boolean checks", () => {
    const base = {
      studio_payee_id: "studio_1",
      studio_kyc_status: "verified" as const,
      team_members: [
        { member_ref: "member-3d-artist", role: "3d_artist", identity_check_passed: true },
      ],
      contract_ref: null,
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    };
    expect(validateGamingStudioKyc({ ...base, studio_payee_id: " " }).ok).toBe(false);
    const emptyRoster = validateGamingStudioKyc({ ...base, team_members: [] });
    expect(emptyRoster.ok).toBe(false);
    if (!emptyRoster.ok) expect(emptyRoster.code).toBe("gaming_studio_kyc_roster_empty");
    expect(
      validateGamingStudioKyc({
        ...base,
        // Deliberate bad-status probe through the untyped boundary.
        studio_kyc_status: "certified" as unknown as typeof base.studio_kyc_status,
      }).ok,
    ).toBe(false);
    expect(
      validateGamingStudioKyc({
        ...base,
        team_members: [
          { member_ref: "a", role: "developer", identity_check_passed: true },
          { member_ref: "a", role: "developer", identity_check_passed: true },
        ],
      }).ok,
    ).toBe(false);
    expect(
      validateGamingStudioKyc({
        ...base,
        team_members: [{ member_ref: " ", role: "developer", identity_check_passed: true }],
      }).ok,
    ).toBe(false);
    expect(
      validateGamingStudioKyc({
        ...base,
        team_members: [{ member_ref: "a", role: " ", identity_check_passed: true }],
      }).ok,
    ).toBe(false);
    expect(
      validateGamingStudioKyc({
        ...base,
        team_members: [
          { member_ref: "a", role: "developer", identity_check_passed: "yes" as unknown as boolean },
        ],
      }).ok,
    ).toBe(false);
  });

  it("persists one verification state per studio payee — a re-verification replaces the row", async () => {
    const store = new InMemoryStore();
    await verifiedStudioKyc(store, "studio_1");
    const read = await store.getGamingStudioKyc("studio_1");
    expect(read?.studio_kyc_status).toBe("verified");
    expect(read?.team_members).toHaveLength(3);

    // The re-verification replaces the row — the roster changes, the payee
    // key holds.
    await verifiedStudioKyc(store, "studio_1", {
      team_members: [
        { member_ref: "member-developer", role: "developer", identity_check_passed: true },
      ],
    });
    const replaced = await store.getGamingStudioKyc("studio_1");
    expect(replaced?.team_members).toHaveLength(1);
    expect(replaced?.team_members[0].member_ref).toBe("member-developer");
    expect(await store.getGamingStudioKyc("studio_missing")).toBeUndefined();
  });

  it("derives the gate's gaming state from the record — absent records derive null", async () => {
    const store = new InMemoryStore();
    expect(await resolveGamingVerticalComplianceState(store, "studio_1")).toBeNull();

    await verifiedStudioKyc(store, "studio_1");
    const state = await resolveGamingVerticalComplianceState(store, "studio_1", true);
    expect(state).toEqual({
      vertical: "gaming",
      platform_commission_deducted: true,
      studio_kyc_verified: true,
      team_member_checks: [
        { member_ref: "member-3d-artist", identity_check_passed: true },
        { member_ref: "member-developer", identity_check_passed: true },
        { member_ref: "member-sound-designer", identity_check_passed: true },
      ],
    });

    // The platform-commission fact defaults FALSE — an unset fact refuses
    // at the gate (gaming_platform_commission_not_deducted), never allows.
    const uncommissioned = await resolveGamingVerticalComplianceState(store, "studio_1");
    expect(uncommissioned?.platform_commission_deducted).toBe(false);
  });
});

describe("locked ledger invariants", () => {
  it("allocations + dust equals gross INCLUDING the cashout bucket", async () => {
    const store = new InMemoryStore();
    await seedVerifiedCreator(store, "creator_1", "Creator One");
    await seedVault(store, COMPANY_VARIANCE_PAYEE_ID, COMPANY_VARIANCE_PAYEE_NAME);
    gamingStateSatisfied();

    // A royalty run allocates 5,000 to the creator.
    await store.insertLedgerTransaction({
      split_run_id: "run-1",
      line_item_id: "",
      payee_id: "creator_1",
      payee_name: "Creator One",
      role: "creator",
      share_bps: 10_000,
      amount_cents: 5_000,
      currency: "USD",
      status: "pending_settlement",
      rail: null,
      baas_provider: null,
      baas_transfer_id: null,
      created_at: NOW.toISOString(),
      settled_at: null,
      kind: "royalty",
    });

    // A game platform payout locks 10,000 in cashout-pending.
    const credit = await lockAndSettleBatch(store, 10_000);

    // Release: 9,999 to the creator, 1 cent of dust to the company payee.
    const release = mustSucceed(
      await releaseGamingCashout(
        store,
        {
          cashout_ledger_id: credit.id,
          batch_ref: BATCH,
          verification: VERIFICATION,
          creator_allocations: [
            { payee_id: "creator_1", payee_name: "Creator One", role: "creator", amount_cents: 9_999 },
          ],
          operator_settlement_approved: true,
        },
        LATER,
      ),
    );

    const creatorAllocated = 5_000; // the royalty run
    const creatorPaid = release.creator_credits.reduce((s, c) => s + c.net_cents, 0);
    const dust = release.company_dust_cents;
    const heldCashout = (await store.listVirtualCurrencyCashoutCredits()).reduce(
      (s, r) => s + r.amount_cents,
      0,
    );
    for (const component of [creatorAllocated, creatorPaid, dust, heldCashout]) {
      expect(Number.isInteger(component)).toBe(true);
    }
    // 5,000 royalty + 9,999 creator + 1 dust = 15,000 — every identified
    // cent; the cashout bucket is empty after the release.
    expect(creatorAllocated + creatorPaid + dust + heldCashout).toBe(15_000);
    expect(heldCashout).toBe(0);
    expect(dust).toBe(1);
  });

  it("the settle CAS refuses the loser and never settles an unknown id", async () => {
    const store = new InMemoryStore();
    const credit = await lockReceipt(store);
    const winner = await store.settleVirtualCurrencyCashout(credit.id, NOW.toISOString());
    expect(winner?.status).toBe("settled");
    expect(winner?.kind).toBe("virtual_currency_cashout_pending");
    expect(
      await store.settleVirtualCurrencyCashout(credit.id, LATER.toISOString()),
    ).toBeUndefined();
    expect(
      await store.settleVirtualCurrencyCashout("missing", LATER.toISOString()),
    ).toBeUndefined();
  });
});

describe("payee helpers", () => {
  it("recovers the platform from the per-platform payee id and rejects foreign payees", () => {
    expect(platformFromCashoutPayeeId(gamingCashoutPayeeId("Roblox"))).toBe("Roblox");
    expect(platformFromCashoutPayeeId("creator_x")).toBeUndefined();
    // The film escrow payee is NOT a gaming cashout payee.
    expect(platformFromCashoutPayeeId("film_escrow:film-77")).toBeUndefined();
  });
});
