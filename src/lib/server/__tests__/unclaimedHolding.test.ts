// Unclaimed royalty holding (PR 7) — the in-memory battery.
//
// Locked invariants under test, per the founder directive: holding is
// distinct from platform dust and creator balances; release refuses until
// identity AND splits are fully verified (and moves NO money on refusal);
// release on verification rides the normal clearance-gated settlement path;
// sum(creator allocations) + company dust equals gross INCLUDING the
// holding bucket; integer cents throughout; post idempotency; the settle
// CAS guards concurrency; recovery discovery uses the worker's quarantine
// vocabulary verbatim (open match_queue rows with rights_type 'unknown').

import { afterEach, describe, expect, it } from "vitest";
import { InMemoryStore } from "@/lib/server/inMemoryStore";
import { calculateUdrSplits } from "@/lib/server/udrSplits";
import {
  listRecoveryCandidates,
  postToUnclaimedHolding,
  releaseUnclaimedHolding,
} from "@/lib/server/unclaimedHolding";
import {
  COMPANY_VARIANCE_PAYEE_ID,
  COMPANY_VARIANCE_PAYEE_NAME,
  GL_ACCOUNT_UNCLAIMED_HOLDING,
  UNCLAIMED_HOLDING_PAYEE_ID,
  UNCLAIMED_HOLDING_PAYEE_NAME,
} from "@/modules/don/constants";
import { setVerticalComplianceStateSource } from "@/modules/compliance/payoutGate";
import type { MatchQueueRecord } from "@/modules/sdk/records";
import { buildMatchQueueRow } from "@/workers/recon/matchQueue";
import type { ParsedStatementLine } from "@/workers/recon/records";
import type { LedgerTransactionRecord } from "@/lib/don/types";
import type { Store } from "@/lib/server/store";

const NOW = new Date("2026-09-30T12:00:00Z");
const LATER = new Date("2026-09-30T12:01:00Z");

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
  result: Success<V> | Failure,
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

/** A minimal quarantined film statement line — the worker's parse shape. */
function filmLine(overrides: Partial<ParsedStatementLine> = {}): ParsedStatementLine {
  return {
    lineNumber: 1,
    profile: "film_vod_csv",
    rightsType: "unknown",
    statementSourceType: null,
    tierLevel: null,
    // Inert on quarantined rows — the split engines never read it for
    // rights_type-'unknown' rows (the worker's own contract).
    rightsPipeline: "master_digital_performance",
    period: "2026-09",
    currency: "USD",
    grossMicros: 5_000_000_000n,
    isAdjustment: false,
    identifiers: { ISRC: "US-XXX-26-00001" },
    workTitle: "Unclaimed Work",
    territory: "US",
    platform: "Astra",
    usageNote: "",
    raw: ["raw"],
    guildResidual: null,
    podcastDetail: null,
    gamingDetail: null,
    livestreamDetail: null,
    webtoonDetail: null,
    ...overrides,
  };
}

async function seedQueueRow(
  store: Store,
  eventId: string,
  rightsType: ParsedStatementLine["rightsType"],
  status: MatchQueueRecord["status"],
): Promise<MatchQueueRecord> {
  const row = buildMatchQueueRow(
    filmLine({ rightsType }),
    eventId,
    "unclassified rights family",
  );
  return store.insertMatchQueueEntry({ ...row, status });
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

function royaltyRow(): Omit<LedgerTransactionRecord, "id"> {
  return {
    split_run_id: "",
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
  };
}

afterEach(() => {
  // The operations-seam override is process-global — reset it every test.
  setVerticalComplianceStateSource(null);
});

describe("postToUnclaimedHolding", () => {
  it("parks the money in holding: sentinel payee, holding kind and status, no vault minted", async () => {
    const store = new InMemoryStore();
    const result = await postToUnclaimedHolding(
      store,
      {
        amount_cents: 2_000,
        currency: "USD",
        source: { type: "match_queue", event_id: "evt-1" },
      },
      NOW,
    );
    const { holding_credit: credit, journal_id: journalId } = mustSucceed(result);
    expect(credit.kind).toBe("unclaimed_holding");
    expect(credit.status).toBe("unclaimed_holding");
    expect(credit.payee_id).toBe(UNCLAIMED_HOLDING_PAYEE_ID);
    expect(credit.payee_name).toBe(UNCLAIMED_HOLDING_PAYEE_NAME);
    expect(credit.line_item_id).toBe("evt-1");
    expect(credit.rail).toBeNull();
    expect(credit.settled_at).toBeNull();
    // No vault exists for the sentinel payee — holding is not a balance.
    expect(await store.getVault(UNCLAIMED_HOLDING_PAYEE_ID)).toBeUndefined();
    expect(await store.getVault(COMPANY_VARIANCE_PAYEE_ID)).toBeUndefined();
    // The held credit is discoverable through the existing line-item index.
    expect(
      (await store.listLedgerTransactionsByLineItem("evt-1")).map((r) => r.id),
    ).toEqual([credit.id]);
    void journalId;
  });

  it("posts a balanced journal: FBO debit against the holding account, no dust or vault accounts touched", async () => {
    const store = new InMemoryStore();
    const { journal_id: journalId } = mustSucceed(
      await postToUnclaimedHolding(
        store,
        {
          amount_cents: 2_000,
          currency: "USD",
          source: { type: "manual", note: "operator identified unallocated" },
        },
        NOW,
      ),
    );
    const entries = await store.listGlEntriesByJournal(journalId);
    expect(entries.map((e) => e.account).sort()).toEqual([
      "fbo_cash",
      GL_ACCOUNT_UNCLAIMED_HOLDING,
    ]);
    expect(entries.reduce((s, e) => s + e.debit_cents, 0)).toBe(2_000);
    expect(entries.reduce((s, e) => s + e.credit_cents, 0)).toBe(2_000);
  });

  it("refuses a replayed post for the same source id (409) and writes nothing twice", async () => {
    const store = new InMemoryStore();
    mustSucceed(
      await postToUnclaimedHolding(
        store,
        {
          amount_cents: 2_000,
          currency: "USD",
          source: { type: "match_queue", event_id: "evt-1" },
        },
        NOW,
      ),
    );
    const replay = mustFail(
      await postToUnclaimedHolding(
        store,
        {
          amount_cents: 2_000,
          currency: "USD",
          source: { type: "match_queue", event_id: "evt-1" },
        },
        LATER,
      ),
      409,
      "unclaimed_holding_already_posted",
    );
    expect(replay.message).toContain("evt-1");
    expect(await store.listLedgerTransactionsByLineItem("evt-1")).toHaveLength(1);
  });

  it("refuses float, zero, and negative amounts (422) — integer cents, never rounding", async () => {
    const store = new InMemoryStore();
    for (const amount of [100.5, 0, -5]) {
      mustFail(
        await postToUnclaimedHolding(
          store,
          {
            amount_cents: amount,
            currency: "USD",
            source: { type: "manual", note: "bad" },
          },
          NOW,
        ),
        422,
        "invalid_amount",
      );
    }
  });
});

describe("releaseUnclaimedHolding — refusal before full verification", () => {
  it("refuses splits that do not balance (422)", async () => {
    const store = new InMemoryStore();
    await seedVerifiedCreator(store, "creator_1", "Creator One");
    const credit = mustSucceed(
      await postToUnclaimedHolding(
        store,
        { amount_cents: 10_000, currency: "USD", source: { type: "manual", note: "" } },
        NOW,
      ),
    ).holding_credit;
    mustFail(
      await releaseUnclaimedHolding(
        store,
        {
          holding_ledger_id: credit.id,
          splits: [
            { payee_id: "creator_1", payee_name: "Creator One", role: "creator", share_bps: 9_000 },
          ],
          operator_settlement_approved: true,
          vertical: "music",
        },
        NOW,
      ),
      422,
      "splits_do_not_balance",
    );
  });

  it("refuses without operator settlement approval (403) and moves no money", async () => {
    const store = new InMemoryStore();
    await seedVerifiedCreator(store, "creator_1", "Creator One");
    await seedVault(store, COMPANY_VARIANCE_PAYEE_ID, COMPANY_VARIANCE_PAYEE_NAME);
    setVerticalComplianceStateSource(async () => ({
      vertical: "music",
      rights_separation_settled: true,
    }));
    const credit = mustSucceed(
      await postToUnclaimedHolding(
        store,
        { amount_cents: 10_000, currency: "USD", source: { type: "manual", note: "" } },
        NOW,
      ),
    ).holding_credit;
    mustFail(
      await releaseUnclaimedHolding(
        store,
        {
          holding_ledger_id: credit.id,
          splits: [
            { payee_id: "creator_1", payee_name: "Creator One", role: "creator", share_bps: 10_000 },
          ],
          operator_settlement_approved: false,
          vertical: "music",
        },
        NOW,
      ),
      403,
      "settlement_not_approved",
    );
    expect(await store.getVault("creator_1")).toMatchObject({
      pending_balance: 0,
      reserve_balance: 0,
      available_balance: 0,
    });
    expect((await store.listUnclaimedHoldingCredits()).map((r) => r.id)).toEqual([
      credit.id,
    ]);
  });

  it("refuses an unknown creator (403 kyc_state_unknown) and moves no money", async () => {
    const store = new InMemoryStore();
    await seedVault(store, "creator_1", "Creator One");
    setVerticalComplianceStateSource(async () => ({
      vertical: "music",
      rights_separation_settled: true,
    }));
    const credit = mustSucceed(
      await postToUnclaimedHolding(
        store,
        { amount_cents: 10_000, currency: "USD", source: { type: "manual", note: "" } },
        NOW,
      ),
    ).holding_credit;
    mustFail(
      await releaseUnclaimedHolding(
        store,
        {
          holding_ledger_id: credit.id,
          splits: [
            { payee_id: "creator_1", payee_name: "Creator One", role: "creator", share_bps: 10_000 },
          ],
          operator_settlement_approved: true,
          vertical: "music",
        },
        NOW,
      ),
      403,
      "kyc_state_unknown",
    );
    expect((await store.getVault("creator_1"))?.pending_balance).toBe(0);
    expect((await store.listUnclaimedHoldingCredits()).map((r) => r.id)).toEqual([
      credit.id,
    ]);
  });

  it("refuses a pending-KYC creator (403 kyc_not_verified)", async () => {
    const store = new InMemoryStore();
    await seedVault(store, "creator_1", "Creator One");
    await store.insertKycVerification({
      creator_id: "creator_1",
      plaid_link_token: "link-token",
      plaid_public_token: "public-token",
      status: "pending",
      identity_json: "{}",
      failure_reason: null,
      created_at: NOW.toISOString(),
      verified_at: null,
    });
    setVerticalComplianceStateSource(async () => ({
      vertical: "music",
      rights_separation_settled: true,
    }));
    const credit = mustSucceed(
      await postToUnclaimedHolding(
        store,
        { amount_cents: 10_000, currency: "USD", source: { type: "manual", note: "" } },
        NOW,
      ),
    ).holding_credit;
    mustFail(
      await releaseUnclaimedHolding(
        store,
        {
          holding_ledger_id: credit.id,
          splits: [
            { payee_id: "creator_1", payee_name: "Creator One", role: "creator", share_bps: 10_000 },
          ],
          operator_settlement_approved: true,
          vertical: "music",
        },
        NOW,
      ),
      403,
      "kyc_not_verified",
    );
  });

  it("refuses when the vertical's compliance state is unknown (403) — the default source fails closed", async () => {
    const store = new InMemoryStore();
    await seedVerifiedCreator(store, "creator_1", "Creator One");
    const credit = mustSucceed(
      await postToUnclaimedHolding(
        store,
        { amount_cents: 10_000, currency: "USD", source: { type: "manual", note: "" } },
        NOW,
      ),
    ).holding_credit;
    // No override: the default state source returns null → unknown refuses.
    mustFail(
      await releaseUnclaimedHolding(
        store,
        {
          holding_ledger_id: credit.id,
          splits: [
            { payee_id: "creator_1", payee_name: "Creator One", role: "creator", share_bps: 10_000 },
          ],
          operator_settlement_approved: true,
          vertical: "music",
        },
        NOW,
      ),
      403,
      "vertical_state_unknown",
    );
  });

  it("refuses a non-holding ledger row (422) and a released row (409)", async () => {
    const store = new InMemoryStore();
    await seedVerifiedCreator(store, "creator_1", "Creator One");
    setVerticalComplianceStateSource(async () => ({
      vertical: "music",
      rights_separation_settled: true,
    }));
    const royalty = await store.insertLedgerTransaction(royaltyRow());
    mustFail(
      await releaseUnclaimedHolding(
        store,
        {
          holding_ledger_id: royalty.id,
          splits: [
            { payee_id: "creator_1", payee_name: "Creator One", role: "creator", share_bps: 10_000 },
          ],
          operator_settlement_approved: true,
          vertical: "music",
        },
        NOW,
      ),
      422,
      "not_a_holding_credit",
    );
    const credit = mustSucceed(
      await postToUnclaimedHolding(
        store,
        { amount_cents: 10_000, currency: "USD", source: { type: "manual", note: "" } },
        NOW,
      ),
    ).holding_credit;
    mustSucceed(
      await releaseUnclaimedHolding(
        store,
        {
          holding_ledger_id: credit.id,
          splits: [
            { payee_id: "creator_1", payee_name: "Creator One", role: "creator", share_bps: 10_000 },
          ],
          operator_settlement_approved: true,
          vertical: "music",
        },
        NOW,
      ),
    );
    mustFail(
      await releaseUnclaimedHolding(
        store,
        {
          holding_ledger_id: credit.id,
          splits: [
            { payee_id: "creator_1", payee_name: "Creator One", role: "creator", share_bps: 10_000 },
          ],
          operator_settlement_approved: true,
          vertical: "music",
        },
        LATER,
      ),
      409,
      "holding_already_released",
    );
  });
});

describe("releaseUnclaimedHolding — release on verification through the settlement path", () => {
  it("settles the row, credits the normal pending buckets, sweeps dust to the platform payee, and posts a balanced journal", async () => {
    const store = new InMemoryStore();
    await seedVerifiedCreator(store, "creator_1", "Creator One");
    // The identity gate covers EVERY credited payee, not just creators —
    // fail-closed on any recipient without a KYC record.
    await seedVault(store, "partner_1", "Partner One");
    await store.insertKycVerification({
      creator_id: "partner_1",
      plaid_link_token: "link-token",
      plaid_public_token: "public-token",
      status: "verified",
      identity_json: "{}",
      failure_reason: null,
      created_at: NOW.toISOString(),
      verified_at: NOW.toISOString(),
    });
    await seedVault(store, COMPANY_VARIANCE_PAYEE_ID, COMPANY_VARIANCE_PAYEE_NAME);
    setVerticalComplianceStateSource(async () => ({
      vertical: "music",
      rights_separation_settled: true,
    }));
    const credit = mustSucceed(
      await postToUnclaimedHolding(
        store,
        {
          amount_cents: 12_345,
          currency: "USD",
          source: { type: "match_queue", event_id: "evt-release" },
        },
        NOW,
      ),
    ).holding_credit;

    const release = mustSucceed(
      await releaseUnclaimedHolding(
        store,
        {
          holding_ledger_id: credit.id,
          // 90/10 of 12,345 → 11,110 + 1,234 with 1 cent of integer-remainder dust.
          splits: [
            { payee_id: "creator_1", payee_name: "Creator One", role: "creator", share_bps: 9_000 },
            { payee_id: "partner_1", payee_name: "Partner One", role: "other", share_bps: 1_000 },
          ],
          operator_settlement_approved: true,
          vertical: "music",
        },
        LATER,
      ),
    );

    // The row: settled, kind retained, settled_at stamped.
    expect(release.holding_credit.status).toBe("settled");
    expect(release.holding_credit.kind).toBe("unclaimed_holding");
    expect(release.holding_credit.settled_at).toBe(LATER.toISOString());

    // Creator pending balances only — no available-balance shortcut, no
    // settlement (dispatch stays downstream of the operator).
    expect(release.party_credits).toEqual([
      { payee_id: "creator_1", payee_name: "Creator One", role: "creator", gross_cents: 11_110, net_cents: 11_110 },
      { payee_id: "partner_1", payee_name: "Partner One", role: "other", gross_cents: 1_234, net_cents: 1_234 },
    ]);
    expect((await store.getVault("creator_1"))?.pending_balance).toBe(11_110);
    expect((await store.getVault("partner_1"))?.pending_balance).toBe(1_234);

    // The dust payee id stays platform — on the dust ledger row AND the vault.
    expect(release.company_dust_cents).toBe(1);
    expect(release.dust_ledger).toHaveLength(1);
    expect(release.dust_ledger[0].variance_account_id).toBe(COMPANY_VARIANCE_PAYEE_ID);
    expect(release.dust_ledger[0].amount_cents).toBe(1);
    expect((await store.getVault(COMPANY_VARIANCE_PAYEE_ID))?.pending_balance).toBe(1);

    // The release journal balances: holding debit + the credited legs.
    const entries = await store.listGlEntriesByJournal(release.journal_id);
    expect(entries.reduce((s, e) => s + e.debit_cents, 0)).toBe(12_345);
    expect(entries.reduce((s, e) => s + e.credit_cents, 0)).toBe(12_345);
    expect(
      entries.some((e) => e.account === GL_ACCOUNT_UNCLAIMED_HOLDING && e.debit_cents === 12_345),
    ).toBe(true);

    // Holding is empty.
    expect(await store.listUnclaimedHoldingCredits()).toEqual([]);
  });

  it("runs the normal withholding sequence on an unverified tax profile and conserves every cent", async () => {
    const store = new InMemoryStore();
    // KYC verified (the gate passes) but no tax profile → backup withholding.
    await seedVault(store, "creator_1", "Creator One");
    await store.insertKycVerification({
      creator_id: "creator_1",
      plaid_link_token: "link-token",
      plaid_public_token: "public-token",
      status: "verified",
      identity_json: "{}",
      failure_reason: null,
      created_at: NOW.toISOString(),
      verified_at: NOW.toISOString(),
    });
    await seedVault(store, COMPANY_VARIANCE_PAYEE_ID, COMPANY_VARIANCE_PAYEE_NAME);
    setVerticalComplianceStateSource(async () => ({
      vertical: "music",
      rights_separation_settled: true,
    }));
    const credit = mustSucceed(
      await postToUnclaimedHolding(
        store,
        { amount_cents: 10_000, currency: "USD", source: { type: "manual", note: "" } },
        NOW,
      ),
    ).holding_credit;

    const release = mustSucceed(
      await releaseUnclaimedHolding(
        store,
        {
          holding_ledger_id: credit.id,
          splits: [
            { payee_id: "creator_1", payee_name: "Creator One", role: "creator", share_bps: 10_000 },
          ],
          operator_settlement_approved: true,
          vertical: "music",
        },
        NOW,
      ),
    );

    expect(release.withholding).toHaveLength(1);
    const escrow = release.withholding[0];
    expect(escrow.gross_cents).toBe(10_000);
    expect(escrow.withheld_cents).toBeGreaterThan(0);
    expect(escrow.net_cents).toBe(10_000 - escrow.withheld_cents);
    // Conservation: reserve + pending == gross, every cent accounted for.
    const vault = await store.getVault("creator_1");
    expect(vault?.reserve_balance).toBe(escrow.withheld_cents);
    expect(vault?.pending_balance).toBe(escrow.net_cents);
    expect(
      (vault?.reserve_balance ?? 0) + (vault?.pending_balance ?? 0),
    ).toBe(10_000);
    const entries = await store.listGlEntriesByJournal(release.journal_id);
    expect(entries.reduce((s, e) => s + e.debit_cents, 0)).toBe(10_000);
    expect(entries.reduce((s, e) => s + e.credit_cents, 0)).toBe(10_000);
  });

  it("refuses a release that would pay the holding sentinel back into holding", async () => {
    const store = new InMemoryStore();
    await seedVault(store, UNCLAIMED_HOLDING_PAYEE_ID, UNCLAIMED_HOLDING_PAYEE_NAME);
    setVerticalComplianceStateSource(async () => ({
      vertical: "music",
      rights_separation_settled: true,
    }));
    const credit = mustSucceed(
      await postToUnclaimedHolding(
        store,
        { amount_cents: 10_000, currency: "USD", source: { type: "manual", note: "" } },
        NOW,
      ),
    ).holding_credit;
    mustFail(
      await releaseUnclaimedHolding(
        store,
        {
          holding_ledger_id: credit.id,
          splits: [
            {
              payee_id: UNCLAIMED_HOLDING_PAYEE_ID,
              payee_name: UNCLAIMED_HOLDING_PAYEE_NAME,
              role: "other",
              share_bps: 10_000,
            },
          ],
          operator_settlement_approved: true,
          vertical: "music",
        },
        NOW,
      ),
      422,
      "splits_do_not_balance",
    );
  });
});

describe("locked ledger invariants", () => {
  it("sum(creator allocations) + company dust equals gross INCLUDING the holding bucket", async () => {
    const store = new InMemoryStore();
    await seedVerifiedCreator(store, "creator_1", "Creator One");
    await seedVault(store, COMPANY_VARIANCE_PAYEE_ID, COMPANY_VARIANCE_PAYEE_NAME);

    // An allocated run: 10,001 gross split 50/50 creator/platform →
    // 5,000 + 5,000 with 1 cent of integer-remainder dust.
    const run = mustSucceed(
      await calculateUdrSplits(
        store,
        {
          source: "recon-sim",
          period: "2026-09",
          currency: "USD",
          settle: false,
          rail: "ach",
          line_items: [
            {
              work_id: "work-1",
              work_title: "Verified Track",
              amount_cents: 10_001,
              splits: [
                { payee_id: "creator_1", payee_name: "Creator One", role: "creator", share_bps: 5_000 },
                {
                  payee_id: COMPANY_VARIANCE_PAYEE_ID,
                  payee_name: COMPANY_VARIANCE_PAYEE_NAME,
                  role: "other",
                  share_bps: 5_000,
                },
              ],
            },
          ],
        },
        NOW,
      ),
    );

    // The identified remainder posts to holding.
    mustSucceed(
      await postToUnclaimedHolding(
        store,
        {
          amount_cents: 4_999,
          currency: "USD",
          source: { type: "match_queue", event_id: "evt-remainder" },
        },
        NOW,
      ),
    );

    // mustSucceed unwraps the envelope — the run's fields sit at the top.
    const creatorAllocated = run.ledger
      .filter((r) => r.role === "creator")
      .reduce((s, r) => s + r.amount_cents, 0);
    const platformParty = run.ledger
      .filter((r) => r.role !== "creator")
      .reduce((s, r) => s + r.amount_cents, 0);
    const dust = run.company_dust_ledger.reduce((s, r) => s + r.amount_cents, 0);
    const held = (await store.listUnclaimedHoldingCredits()).reduce(
      (s, r) => s + r.amount_cents,
      0,
    );
    for (const component of [creatorAllocated, platformParty, dust, held]) {
      expect(Number.isInteger(component)).toBe(true);
    }
    // 5,000 + 5,000 + 1 + 4,999 = 15,000 — the total identified gross.
    expect(creatorAllocated + platformParty + dust + held).toBe(15_000);
    expect(held).toBe(4_999);
    expect(dust).toBe(1);
  });

  it("the settle CAS refuses the loser and never settles an unknown id", async () => {
    const store = new InMemoryStore();
    const credit = mustSucceed(
      await postToUnclaimedHolding(
        store,
        { amount_cents: 1_000, currency: "USD", source: { type: "manual", note: "" } },
        NOW,
      ),
    ).holding_credit;
    const winner = await store.settleUnclaimedHolding(credit.id, NOW.toISOString());
    expect(winner?.status).toBe("settled");
    expect(await store.settleUnclaimedHolding(credit.id, LATER.toISOString())).toBeUndefined();
    expect(await store.settleUnclaimedHolding("missing", LATER.toISOString())).toBeUndefined();
  });

  it("a concurrent release loser reads 409, never a double release", async () => {
    const store = new InMemoryStore();
    await seedVerifiedCreator(store, "creator_1", "Creator One");
    await seedVault(store, COMPANY_VARIANCE_PAYEE_ID, COMPANY_VARIANCE_PAYEE_NAME);
    setVerticalComplianceStateSource(async () => ({
      vertical: "music",
      rights_separation_settled: true,
    }));
    const credit = mustSucceed(
      await postToUnclaimedHolding(
        store,
        { amount_cents: 10_000, currency: "USD", source: { type: "manual", note: "" } },
        NOW,
      ),
    ).holding_credit;
    const releaseInput = {
      holding_ledger_id: credit.id,
      splits: [
        { payee_id: "creator_1", payee_name: "Creator One", role: "creator" as const, share_bps: 10_000 },
      ],
      operator_settlement_approved: true,
      vertical: "music" as const,
    };
    mustSucceed(await releaseUnclaimedHolding(store, releaseInput, NOW));
    // The loser (a raced retry) cannot double-move the money.
    mustFail(
      await releaseUnclaimedHolding(store, releaseInput, LATER),
      409,
      "holding_already_released",
    );
    expect((await store.getVault("creator_1"))?.pending_balance).toBe(10_000);
  });
});

describe("listRecoveryCandidates — the worker's quarantine vocabulary", () => {
  it("pairs open rights-quarantined events with held credits and reports the unlinked remainder", async () => {
    const store = new InMemoryStore();
    await seedQueueRow(store, "evt-quarantined", "unknown", "open");
    await seedQueueRow(store, "evt-quarantined-2", "unknown", "open");
    await seedQueueRow(store, "evt-master-open", "master", "open");
    await seedQueueRow(store, "evt-matched-unknown", "unknown", "matched");
    await seedQueueRow(store, "evt-discarded-unknown", "unknown", "discarded");

    mustSucceed(
      await postToUnclaimedHolding(
        store,
        {
          amount_cents: 1_500,
          currency: "USD",
          source: { type: "match_queue", event_id: "evt-quarantined" },
        },
        NOW,
      ),
    );
    // One post per source event — a retried post is refused (409), which is
    // what makes the posting seam safe for the worker's follow-up wiring.
    mustFail(
      await postToUnclaimedHolding(
        store,
        {
          amount_cents: 1_500,
          currency: "USD",
          source: { type: "match_queue", event_id: "evt-quarantined" },
        },
        NOW,
      ),
      409,
      "unclaimed_holding_already_posted",
    );
    mustSucceed(
      await postToUnclaimedHolding(
        store,
        {
          amount_cents: 1_200,
          currency: "USD",
          source: { type: "match_queue", event_id: "evt-quarantined-2" },
        },
        LATER,
      ),
    );
    mustSucceed(
      await postToUnclaimedHolding(
        store,
        {
          amount_cents: 700,
          currency: "USD",
          source: { type: "manual", note: "operator identified" },
        },
        NOW,
      ),
    );

    const report = await listRecoveryCandidates(store);

    // Every OPEN row is a candidate — the pairing surface covers the
    // canonical posting seam's matched master rows as well as rights-
    // quarantined ones (the seam posts matched music money to holding, and
    // the recovery report must see it). Non-open rows (matched, discarded)
    // are never candidates. Order-insensitive: equal created_at timestamps
    // make candidate order implementation-defined across backends.
    expect(report.candidates.map((c) => c.event.event_id).sort()).toEqual([
      "evt-master-open",
      "evt-quarantined",
      "evt-quarantined-2",
    ]);
    const masterOpen = report.candidates.find(
      (c) => c.event.event_id === "evt-master-open",
    );
    expect(masterOpen?.held_cents).toBe(0); // present but holding nothing yet
    const quarantined1 = report.candidates.find(
      (c) => c.event.event_id === "evt-quarantined",
    );
    const quarantined2 = report.candidates.find(
      (c) => c.event.event_id === "evt-quarantined-2",
    );
    expect(quarantined1?.event.rights_type).toBe("unknown");
    expect(quarantined1?.event.status).toBe("open");
    expect(quarantined1?.credits.map((c) => c.amount_cents)).toEqual([1_500]);
    expect(quarantined1?.held_cents).toBe(1_500);
    expect(quarantined2?.held_cents).toBe(1_200);

    // The manual post explains no open event — it is reported unlinked.
    expect(report.unlinked).toHaveLength(1);
    expect(report.unlinked[0].amount_cents).toBe(700);

    // The full holding balance, integer cents.
    expect(Number.isInteger(report.total_held_cents)).toBe(true);
    expect(report.total_held_cents).toBe(3_400);
  });
});
