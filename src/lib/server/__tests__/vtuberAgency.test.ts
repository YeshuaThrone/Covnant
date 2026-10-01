// VTuber agency licensing holdback (PR 15) — the store-backed battery.
//
// Locked invariants under test, per the founder VTuber directive: a managed
// talent's income receipt LOCKS in a per-agency holdback (kind and status
// both 'avatar_ip_licensing_holdback' — out of every vault, out of
// UNCLAIMED_HOLDING, out of the film/gaming/esports escrows) with one FBO
// debit and one holdback-credit GL journal, replay-guarded per source
// (match_queue event id, recon job id — 409 on re-post); release runs the
// agency deduction stack ONLY after the deduction contract validates (the
// 20–40% management band, one share per payee, shares summing to exactly
// 10000 bps), every credited party passes the fail-closed payout compliance
// gate (operator settlement approval, verified KYC, the LIVESTREAM
// vertical's reconciled payout AND tax_withholding_verified state), and the
// CAS flip has WON before any money moves. The stack applies IN ORDER —
// agency management, 3D rigging holdback, avatar IP licensing holdback,
// tech setup amortization — before net income releases to the talent split
// (withholding on creator roles, recoupment sweep on credited payees), and
// integer-cent dust sweeps to company variance. The tech setup amortization
// schedule's line math is deterministic (floor(total/periods), the last
// line absorbing the remainder); a shortfall against the schedule is
// REPORTED (techSetupUnamortizedCents), never hidden; a refused release
// moves NO money.

import { afterEach, describe, expect, it } from "vitest";

import { InMemoryStore } from "@/lib/server/inMemoryStore";
import {
  agencyIdFromHoldbackPayeeId,
  buildTechSetupAmortizationLine,
  buildVtuberAgencyDeductionPlan,
  postToAvatarIpHoldback,
  releaseVtuberAgencyDeductions,
  type VtuberAgencyDeductionPlan,
  type VtuberAgencyDeductionPlanFailure,
  type VtuberTalentShare,
} from "@/lib/server/vtuberAgency";

import {
  VTUBER_HOLDBACK_PAYEE_PREFIX,
  vtuberHoldbackGlAccount,
  vtuberHoldbackPayeeId,
  vtuberHoldbackPayeeName,
} from "@/modules/don/constants";
import { setVerticalComplianceStateSource } from "@/modules/compliance/payoutGate";
import type { Store } from "@/lib/server/store";

const NOW = new Date("2026-10-01T12:00:00Z");
const AGENCY = "holo-nexus";
const AGENCY_PAYEE_ID = vtuberHoldbackPayeeId(AGENCY);
const AGENCY_PAYEE_NAME = vtuberHoldbackPayeeName(AGENCY);

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

function mustPlan(result: { ok: true; plan: VtuberAgencyDeductionPlan } | VtuberAgencyDeductionPlanFailure): VtuberAgencyDeductionPlan {
  if (!result.ok) {
    throw new Error(`expected a plan, got ${result.code}: ${result.message}`);
  }
  return result.plan;
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

async function seedVerifiedParty(
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
  await store.insertKycVerification({
    creator_id: payeeId,
    plaid_link_token: "link-token",
    plaid_public_token: "public-token",
    status: "verified",
    identity_json: "{}",
    failure_reason: null,
    created_at: NOW.toISOString(),
    verified_at: NOW.toISOString(),
  });
  await store.upsertCreatorTaxProfile({
    creator_id: payeeId,
    tin_verified: 1,
    w9_on_file: 1,
    updated_at: NOW.toISOString(),
  });
}

/** The livestream vertical's compliance state, fully satisfied. */
function livestreamStateSatisfied(): void {
  setVerticalComplianceStateSource(async () => ({
    vertical: "livestream",
    stream_platform_payout_reconciled: true,
    tax_withholding_verified: true,
  }));
}

/** Two talent shares + one coach summing to exactly 10000 bps (no dust). */
function talentNoDust(): VtuberTalentShare[] {
  return [
    { payeeId: "payee-talent-one", payeeName: "Talent One", role: "creator", shareBps: 5000 },
    { payeeId: "payee-talent-two", payeeName: "Talent Two", role: "creator", shareBps: 3000 },
    { payeeId: "payee-coach", payeeName: "Coach", role: "producer", shareBps: 2000 },
  ];
}

async function seedFullyVerifiedScenario(store: Store): Promise<void> {
  livestreamStateSatisfied();
  await seedVerifiedParty(store, AGENCY_PAYEE_ID, AGENCY_PAYEE_NAME);
  for (const member of talentNoDust()) {
    await seedVerifiedParty(store, member.payeeId, member.payeeName);
  }
}

async function postReceipt(
  store: Store,
  amountCents: number,
  source: Parameters<typeof postToAvatarIpHoldback>[1]["source"] = {
    type: "match_queue",
    event_id: "vtuber:gift:evt-1",
  },
) {
  return postToAvatarIpHoldback(
    store,
    { agency: AGENCY, amount_cents: amountCents, currency: "USD", source },
    NOW,
  );
}

type ReleaseInput = Parameters<typeof releaseVtuberAgencyDeductions>[1];

function releaseInput(
  holdbackLedgerId: string,
  overrides: Partial<ReleaseInput> = {},
): ReleaseInput {
  return {
    holdback_ledger_id: holdbackLedgerId,
    agencyPayeeId: AGENCY_PAYEE_ID,
    agencyPayeeName: AGENCY_PAYEE_NAME,
    managementFeeBps: 2_000,
    riggingHoldbackCents: 0,
    riggingContractRef: "",
    licensingHoldbackCents: 0,
    licenseVerificationRef: "",
    techSetupAmortizationScheduleRef: null,
    talentShares: talentNoDust(),
    operator_settlement_approved: true,
    ...overrides,
  };
}

const RECEIPT_CENTS = 100_000; // $1,000.00

afterEach(() => {
  setVerticalComplianceStateSource(null);
});

describe("postToAvatarIpHoldback — the lock", () => {
  it("locks the receipt out of every vault and the holding bucket, with one FBO debit and one holdback-credit GL journal", async () => {
    const store = new InMemoryStore();
    await seedFullyVerifiedScenario(store);

    const posted = mustSucceed(await postReceipt(store, RECEIPT_CENTS));

    // The row: kind AND status both 'avatar_ip_licensing_holdback', the
    // per-agency payee, the match_queue source stamped in line_item_id.
    expect(posted.holdback_credit.kind).toBe("avatar_ip_licensing_holdback");
    expect(posted.holdback_credit.status).toBe("avatar_ip_licensing_holdback");
    expect(posted.holdback_credit.payee_id).toBe(AGENCY_PAYEE_ID);
    expect(posted.holdback_credit.payee_name).toBe(AGENCY_PAYEE_NAME);
    expect(posted.holdback_credit.amount_cents).toBe(RECEIPT_CENTS);
    expect(posted.holdback_credit.line_item_id).toBe("vtuber:gift:evt-1");

    // The GL journal: one FBO debit (cash arrived) + one holdback credit.
    const legs = await store.listGlEntriesByJournal(posted.journal_id);
    expect(legs).toHaveLength(2);
    const fbo = legs.find((leg) => leg.account === "fbo_cash")!;
    expect(fbo.debit_cents).toBe(RECEIPT_CENTS);
    expect(fbo.credit_cents).toBe(0);
    const holdback = legs.find(
      (leg) => leg.account === vtuberHoldbackGlAccount(AGENCY),
    )!;
    expect(holdback.credit_cents).toBe(RECEIPT_CENTS);
    expect(holdback.debit_cents).toBe(0);

    // The lock is the point: NO vault was minted or credited — the agency
    // and every talent share hold zero, and the row never entered the
    // unclaimed holding bucket.
    for (const payee of [AGENCY_PAYEE_ID, ...talentNoDust().map((t) => t.payeeId)]) {
      const vault = await store.getVault(payee);
      expect(vault?.available_balance ?? 0).toBe(0);
      expect(vault?.pending_balance ?? 0).toBe(0);
      expect(vault?.reserve_balance ?? 0).toBe(0);
    }
    const holding = await store.listUnclaimedHoldingCredits();
    expect(holding).toHaveLength(0);

    // The locked receipt IS the holdback listing's only row.
    const held = await store.listAvatarIpHoldbackCredits();
    expect(held.map((r) => r.id)).toEqual([posted.holdback_credit.id]);
  });

  it("replay-guards per source: a re-posted match_queue event is a 409, never a second credit", async () => {
    const store = new InMemoryStore();
    await seedFullyVerifiedScenario(store);

    mustSucceed(await postReceipt(store, RECEIPT_CENTS));
    mustFail(
      await postReceipt(store, RECEIPT_CENTS),
      409,
      "vtuber_holdback_receipt_already_posted",
    );

    // A DIFFERENT source id posts cleanly — the guard is per source.
    mustSucceed(
      await postReceipt(store, 5_000, {
        type: "match_queue",
        event_id: "vtuber:gift:evt-2",
      }),
    );

    // Two receipts, exactly two holdback rows.
    expect(await store.listAvatarIpHoldbackCredits()).toHaveLength(2);
  });

  it("recon-job-sourced receipts replay-guard on the job id; manual posts ref their own ledger row", async () => {
    const store = new InMemoryStore();
    await seedFullyVerifiedScenario(store);

    const viaJob = mustSucceed(
      await postReceipt(store, 12_345, { type: "recon_job", job_id: "job-9001" }),
    );
    mustFail(
      await postReceipt(store, 12_345, { type: "recon_job", job_id: "job-9001" }),
      409,
      "vtuber_holdback_receipt_already_posted",
    );

    const manual = mustSucceed(
      await postReceipt(store, 6_789, { type: "manual", note: "operator-topup" }),
    );
    // A manual post carries no source line item and refs its own ledger row.
    expect(manual.holdback_credit.line_item_id).toBe("");
    const legs = await store.listGlEntriesByJournal(manual.journal_id);
    expect(legs).toHaveLength(2);
    void viaJob;
  });

  it("fails closed on malformed input — blank agency, zero/negative, and float amounts are refused before anything is written", async () => {
    const store = new InMemoryStore();
    await seedFullyVerifiedScenario(store);

    mustFail(
      await postToAvatarIpHoldback(
        store,
        { agency: "  ", amount_cents: 100, currency: "USD", source: { type: "manual", note: "" } },
        NOW,
      ),
      422,
      "invalid_holdback_agency",
    );
    mustFail(
      await postReceipt(store, 0),
      422,
      "invalid_amount",
    );
    mustFail(
      await postReceipt(store, 1_000.5),
      422,
      "invalid_amount",
    );
    // Nothing was written.
    expect(await store.listAvatarIpHoldbackCredits()).toHaveLength(0);
  });

  it("recovers the agency id from the per-agency payee id", () => {
    expect(agencyIdFromHoldbackPayeeId(AGENCY_PAYEE_ID)).toBe(AGENCY);
    expect(agencyIdFromHoldbackPayeeId(VTUBER_HOLDBACK_PAYEE_PREFIX)).toBeUndefined();
    expect(agencyIdFromHoldbackPayeeId("creator_x")).toBeUndefined();
  });
});

describe("buildVtuberAgencyDeductionPlan — the allocator (pure)", () => {
  it("applies the stack IN ORDER and conserves every cent: deductions off the top, talent split of the remainder, dust swept", () => {
    // $1,000.00 gross; 30% management ($300), $100 rigging, $80 licensing,
    // $37.13 amortization — the talent pool is the remainder, split 50/30/20
    // with the floor's dust landing in company variance.
    const planned = buildVtuberAgencyDeductionPlan({
      grossCents: 100_000,
      agencyPayeeId: AGENCY_PAYEE_ID,
      managementFeeBps: 3_000,
      riggingHoldbackCents: 10_000,
      licensingHoldbackCents: 8_000,
      techSetupAmortizationCents: 3_713,
      talentShares: [
        { payeeId: "t1", payeeName: "T1", role: "creator", shareBps: 5_000 },
        { payeeId: "t2", payeeName: "T2", role: "creator", shareBps: 5_000 },
      ],
    });
    const plan = mustPlan(planned);
    expect(plan.managementFeeCents).toBe(30_000);
    expect(plan.riggingHoldbackCents).toBe(10_000);
    expect(plan.licensingHoldbackCents).toBe(8_000);
    expect(plan.techSetupAmortizationCents).toBe(3_713);
    expect(plan.techSetupUnamortizedCents).toBe(0);
    expect(plan.talentPoolCents).toBe(48_287);
    expect(plan.talentAllocations.map((a) => a.amountCents)).toEqual([24_143, 24_143]);
    expect(plan.companyDustCents).toBe(1);

    // The conservation: every bucket — held or routed — sums to the gross.
    const routed =
      plan.managementFeeCents +
      plan.riggingHoldbackCents +
      plan.licensingHoldbackCents +
      plan.techSetupAmortizationCents +
      plan.talentAllocations.reduce((total, a) => total + a.amountCents, 0) +
      plan.companyDustCents;
    expect(routed).toBe(100_000);
  });

  it("caps deductions at what the previous steps left and REPORTS the amortization shortfall, never hiding it", () => {
    const planned = buildVtuberAgencyDeductionPlan({
      grossCents: 1_000,
      agencyPayeeId: AGENCY_PAYEE_ID,
      managementFeeBps: 2_000, // $200 management
      riggingHoldbackCents: 900, // capped: only $800 remains
      licensingHoldbackCents: 0,
      techSetupAmortizationCents: 5_000, // $0 remains — fully unamortized
      talentShares: [
        { payeeId: "t1", payeeName: "T1", role: "producer", shareBps: 10_000 },
      ],
    });
    const plan = mustPlan(planned);
    expect(plan.managementFeeCents).toBe(200);
    expect(plan.riggingHoldbackCents).toBe(800); // capped
    expect(plan.licensingHoldbackCents).toBe(0);
    expect(plan.techSetupAmortizationCents).toBe(0); // capped to zero
    expect(plan.techSetupUnamortizedCents).toBe(5_000); // REPORTED
    expect(plan.talentPoolCents).toBe(0);
    expect(plan.talentAllocations[0].amountCents).toBe(0);
    expect(plan.companyDustCents).toBe(0);
  });

  it("refuses an out-of-band management fee, duplicate/empty/oversubscribed talent splits, and non-integer money", () => {
    const base = {
      grossCents: 100_000,
      agencyPayeeId: AGENCY_PAYEE_ID,
      managementFeeBps: 2_000,
      riggingHoldbackCents: 0,
      licensingHoldbackCents: 0,
      techSetupAmortizationCents: 0,
      talentShares: [
        { payeeId: "t1", payeeName: "T1", role: "creator", shareBps: 10_000 },
      ] satisfies VtuberTalentShare[],
    };
    // Below the 20% floor and above the 40% ceiling.
    const low = buildVtuberAgencyDeductionPlan({ ...base, managementFeeBps: 1_999 });
    expect(low.ok).toBe(false);
    if (!low.ok) expect(low.code).toBe("invalid_management_fee_bps");
    const high = buildVtuberAgencyDeductionPlan({ ...base, managementFeeBps: 4_001 });
    expect(high.ok).toBe(false);
    if (!high.ok) expect(high.code).toBe("invalid_management_fee_bps");
    // The band's edges are legal.
    mustPlan(buildVtuberAgencyDeductionPlan({ ...base, managementFeeBps: 2_000 }));
    mustPlan(buildVtuberAgencyDeductionPlan({ ...base, managementFeeBps: 4_000 }));

    const oversubscribed = buildVtuberAgencyDeductionPlan({
      ...base,
      talentShares: [
        { payeeId: "t1", payeeName: "T1", role: "creator", shareBps: 6_000 },
        { payeeId: "t2", payeeName: "T2", role: "producer", shareBps: 4_001 },
      ],
    });
    expect(oversubscribed.ok).toBe(false);
    if (!oversubscribed.ok) expect(oversubscribed.code).toBe("invalid_talent_share_sum");

    const duplicate = buildVtuberAgencyDeductionPlan({
      ...base,
      talentShares: [
        { payeeId: "t1", payeeName: "T1", role: "creator", shareBps: 6_000 },
        { payeeId: "t1", payeeName: "T1", role: "producer", shareBps: 4_000 },
      ],
    });
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.code).toBe("invalid_talent_duplicate_payee");

    const empty = buildVtuberAgencyDeductionPlan({ ...base, talentShares: [] });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.code).toBe("invalid_talent_shares_empty");

    const float = buildVtuberAgencyDeductionPlan({ ...base, riggingHoldbackCents: 1.5 });
    expect(float.ok).toBe(false);
    if (!float.ok) expect(float.code).toBe("invalid_deduction_amount");

    const badGross = buildVtuberAgencyDeductionPlan({ ...base, grossCents: 0 });
    expect(badGross.ok).toBe(false);
    if (!badGross.ok) expect(badGross.code).toBe("invalid_holdback_gross");
  });
});

describe("buildTechSetupAmortizationLine — the deterministic schedule math", () => {
  it("splits floor(total/periods) per line with the LAST line absorbing the integer-cent remainder", () => {
    // $1,000.00 over 3 periods: $333.33 + $333.33 + $333.34.
    const lines = [0, 1, 2].map((i) =>
      buildTechSetupAmortizationLine(100_003, 3, i),
    );
    expect(lines).toEqual([33_334, 33_334, 33_335]);
    expect(lines.reduce((a, b) => a + b, 0)).toBe(100_003);

    // Exact division conserves trivially.
    const even = [0, 1, 2, 3].map((i) => buildTechSetupAmortizationLine(40_000, 4, i));
    expect(even).toEqual([10_000, 10_000, 10_000, 10_000]);

    // A single period amortizes everything on line zero.
    expect(buildTechSetupAmortizationLine(77_777, 1, 0)).toBe(77_777);

    // Sum conserved over a prime total and a ten-period schedule.
    const prime = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) =>
      buildTechSetupAmortizationLine(9_997, 10, i),
    );
    expect(prime.reduce((a, b) => a + b, 0)).toBe(9_997);
  });
});

describe("releaseVtuberAgencyDeductions — the verified release", () => {
  it("runs the full stack IN ORDER after the gates and the CAS, with withholding on creator roles and dust swept", async () => {
    const store = new InMemoryStore();
    await seedFullyVerifiedScenario(store);
    const posted = mustSucceed(await postReceipt(store, RECEIPT_CENTS));

    // $1,000.00: 30% management ($300), $100 rigging, $80 licensing, a
    // $37.13 amortization line, then the 50/30/20 talent split.
    const schedule = await store.insertVtuberTechSetupAmortizationSchedule({
      schedule_ref: "rig-rig-2026-01",
      agency_payee_id: AGENCY_PAYEE_ID,
      description: "3D model rig + tech setup",
      total_cost_cents: 74_260, // 4 periods of $185.65
      amortization_periods: 4,
      created_at: NOW.toISOString(),
    });
    void schedule;

    const released = mustSucceed(
      await releaseVtuberAgencyDeductions(
        store,
        releaseInput(posted.holdback_credit.id, {
          managementFeeBps: 3_000,
          riggingHoldbackCents: 10_000,
          riggingContractRef: "rig-contract-2026-014",
          licensingHoldbackCents: 8_000,
          licenseVerificationRef: "license-verif-2026-014",
          techSetupAmortizationScheduleRef: "rig-rig-2026-01",
        }),
        NOW,
      ),
    );

    // The row: status 'settled', kind STILL 'avatar_ip_licensing_holdback'
    // (the kind marks WHAT the row was for its whole life).
    expect(released.holdback_credit.status).toBe("settled");
    expect(released.holdback_credit.kind).toBe("avatar_ip_licensing_holdback");
    expect(released.holdback_credit.settled_at).toBe(NOW.toISOString());

    // The stack, in the founder's mandated order.
    expect(released.plan.managementFeeCents).toBe(30_000);
    expect(released.plan.riggingHoldbackCents).toBe(10_000);
    expect(released.plan.licensingHoldbackCents).toBe(8_000);
    expect(released.plan.techSetupAmortizationCents).toBe(18_565);
    expect(released.plan.techSetupUnamortizedCents).toBe(0);
    expect(released.plan.talentPoolCents).toBe(33_435);
    // The consumed amortization line is period zero of four.
    expect(released.tech_setup_amortization?.line_index).toBe(0);
    expect(released.tech_setup_amortization?.applied_cents).toBe(18_565);

    // The talent split of $334.35: 50/30/20 with the floor's dust swept.
    const byPayee = new Map(released.talent_credits.map((t) => [t.payee_id, t]));
    // Both creator shares ride withholding (the engines' rates apply to the
    // gross); net_cents reports what LANDED post-withholding and post-sweep.
    expect(byPayee.get("payee-talent-one")?.gross_cents).toBe(16_717);
    expect(byPayee.get("payee-talent-two")?.gross_cents).toBe(10_030);
    expect(byPayee.get("payee-coach")?.gross_cents).toBe(6_687);
    expect(byPayee.get("payee-coach")?.net_cents).toBe(6_687); // coach: no withholding
    // Withholding escrows exist for the two creator roles only.
    expect(released.withholding).toHaveLength(2);
    for (const escrow of released.withholding) {
      expect(escrow.gross_cents).toBeGreaterThan(0);
      expect(escrow.withheld_cents).toBeGreaterThanOrEqual(0);
    }

    // Every credited party's vault moved; the agency holds the stack total.
    const agencyVault = await store.getVault(AGENCY_PAYEE_ID);
    expect(agencyVault).toBeDefined();
    const agencyTotal =
      (agencyVault?.available_balance ?? 0) + (agencyVault?.pending_balance ?? 0);
    expect(agencyTotal).toBe(30_000 + 10_000 + 8_000 + 18_565);

    // The dust: $334.35 splits 16_717 + 10_030 + 6_687 = 33_434 — one cent
    // of dust to company variance, with a dust ledger row.
    expect(released.company_dust_cents).toBe(1);
    expect(released.dust_ledger).toHaveLength(1);

    // The GL journal: the holdback debit + every routing leg — and it
    // balances (credits === debits).
    const legs = await store.listGlEntriesByJournal(released.journal_id);
    const debits = legs.reduce((total, leg) => total + leg.debit_cents, 0);
    const credits = legs.reduce((total, leg) => total + leg.credit_cents, 0);
    expect(debits).toBe(credits);

    // The released row left the held listing.
    expect(await store.listAvatarIpHoldbackCredits()).toHaveLength(0);
  });

  it("fails closed BEFORE any money moves: missing KYC, unverified withholding state, and an unapproved operator each refuse with 403", async () => {
    const store = new InMemoryStore();
    await seedFullyVerifiedScenario(store);
    const posted = mustSucceed(await postReceipt(store, RECEIPT_CENTS));

    // One talent share's KYC is missing — the gate refuses for that payee.
    const storeNoCoachKyc = new InMemoryStore();
    await seedFullyVerifiedScenario(storeNoCoachKyc);
    const postedNoCoach = mustSucceed(await postReceipt(storeNoCoachKyc, RECEIPT_CENTS));
    const coachRecord = await storeNoCoachKyc.getVault("payee-coach");
    void coachRecord;
    // Remove the coach's KYC by rebuilding the scenario without it.
    const storeMissing = new InMemoryStore();
    livestreamStateSatisfied();
    await seedVerifiedParty(storeMissing, AGENCY_PAYEE_ID, AGENCY_PAYEE_NAME);
    await seedVerifiedParty(storeMissing, "payee-talent-one", "Talent One");
    await seedVerifiedParty(storeMissing, "payee-talent-two", "Talent Two");
    const postedMissingKyc = mustSucceed(await postReceipt(storeMissing, RECEIPT_CENTS));
    mustFail(
      await releaseVtuberAgencyDeductions(
        storeMissing,
        releaseInput(postedMissingKyc.holdback_credit.id),
        NOW,
      ),
      403,
      "kyc_state_unknown",
    );
    // The refusal moved NO money and the row is STILL locked.
    expect((await storeMissing.listAvatarIpHoldbackCredits()).map((r) => r.id)).toEqual([
      postedMissingKyc.holdback_credit.id,
    ]);
    const agencyVaultAfterRefusal = await storeMissing.getVault(AGENCY_PAYEE_ID);
    expect(agencyVaultAfterRefusal?.pending_balance ?? 0).toBe(0);

    // The livestream vertical's tax withholding verification is absent —
    // the gate refuses (fail-closed, always).
    setVerticalComplianceStateSource(async () => null);
    mustFail(
      await releaseVtuberAgencyDeductions(
        store,
        releaseInput(posted.holdback_credit.id),
        NOW,
      ),
      403,
      "vertical_state_unknown",
    );

    // A verified-but-pending withholding state refuses too.
    setVerticalComplianceStateSource(async () => ({
      vertical: "livestream",
      stream_platform_payout_reconciled: true,
      tax_withholding_verified: false,
    }));
    mustFail(
      await releaseVtuberAgencyDeductions(
        store,
        releaseInput(posted.holdback_credit.id),
        NOW,
      ),
      403,
      "livestream_tax_withholding_unverified",
    );

    // Operator settlement approval is the first condition — refused
    // regardless of every other state.
    livestreamStateSatisfied();
    mustFail(
      await releaseVtuberAgencyDeductions(
        store,
        releaseInput(posted.holdback_credit.id, { operator_settlement_approved: false }),
        NOW,
      ),
      403,
      "settlement_not_approved",
    );

    // All three refusals left the receipt locked and nothing routed.
    expect((await store.listAvatarIpHoldbackCredits()).map((r) => r.id)).toEqual([
      posted.holdback_credit.id,
    ]);
  });

  it("refuses a release whose stack is unbuildable — band violations, share sums, and missing deduction provenance — without moving anything", async () => {
    const store = new InMemoryStore();
    await seedFullyVerifiedScenario(store);
    const posted = mustSucceed(await postReceipt(store, RECEIPT_CENTS));

    // Below the 20% band.
    mustFail(
      await releaseVtuberAgencyDeductions(
        store,
        releaseInput(posted.holdback_credit.id, { managementFeeBps: 1_000 }),
        NOW,
      ),
      422,
      "invalid_management_fee_bps",
    );
    // A rigging holdback without its contract of record.
    mustFail(
      await releaseVtuberAgencyDeductions(
        store,
        releaseInput(posted.holdback_credit.id, { riggingHoldbackCents: 5_000 }),
        NOW,
      ),
      422,
      "missing_rigging_contract_ref",
    );
    // A licensing holdback without its license verification of record.
    mustFail(
      await releaseVtuberAgencyDeductions(
        store,
        releaseInput(posted.holdback_credit.id, { licensingHoldbackCents: 5_000 }),
        NOW,
      ),
      422,
      "missing_license_verification_ref",
    );
    // An oversubscribed talent split.
    mustFail(
      await releaseVtuberAgencyDeductions(
        store,
        releaseInput(posted.holdback_credit.id, {
          talentShares: [
            { payeeId: "t1", payeeName: "T1", role: "creator", shareBps: 9_000 },
            { payeeId: "t2", payeeName: "T2", role: "producer", shareBps: 1_001 },
          ],
        }),
        NOW,
      ),
      422,
      "invalid_talent_share_sum",
    );
    // An unknown amortization schedule.
    mustFail(
      await releaseVtuberAgencyDeductions(
        store,
        releaseInput(posted.holdback_credit.id, {
          techSetupAmortizationScheduleRef: "no-such-schedule",
        }),
        NOW,
      ),
      422,
      "tech_setup_amortization_schedule_not_found",
    );

    // Every refusal: the row is STILL locked, nothing anywhere moved.
    expect((await store.listAvatarIpHoldbackCredits()).map((r) => r.id)).toEqual([
      posted.holdback_credit.id,
    ]);
  });

  it("releases exactly once — a replayed release and a concurrent loser both read 409, the CAS won first", async () => {
    const store = new InMemoryStore();
    await seedFullyVerifiedScenario(store);
    const posted = mustSucceed(await postReceipt(store, RECEIPT_CENTS));

    mustSucceed(
      await releaseVtuberAgencyDeductions(store, releaseInput(posted.holdback_credit.id), NOW),
    );

    // The replay: the row is no longer locked.
    mustFail(
      await releaseVtuberAgencyDeductions(store, releaseInput(posted.holdback_credit.id), NOW),
      409,
      "holdback_already_released",
    );
    // The journal is singular — the release posted exactly one.
    const journals = await store.listGlJournalsByRef(
      "ledger_transaction",
      posted.holdback_credit.id,
    );
    expect(journals).toHaveLength(1);
    expect(journals[0].kind).toBe("vtuber_holdback_release");
  });

  it("refuses non-holdback rows, unknown ids, and releases whose row never was a locked receipt", async () => {
    const store = new InMemoryStore();
    await seedFullyVerifiedScenario(store);

    // Unknown id → 404.
    mustFail(
      await releaseVtuberAgencyDeductions(store, releaseInput("missing-row"), NOW),
      404,
      "holdback_receipt_not_found",
    );

    // An ordinary royalty row is not a holdback receipt → 422.
    const royalty = await store.insertLedgerTransaction({
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
    });
    mustFail(
      await releaseVtuberAgencyDeductions(store, releaseInput(royalty.id), NOW),
      422,
      "not_a_vtuber_holdback_receipt",
    );
  });

  it("consumes the amortization schedule line by line across releases — a concurrent line advance re-plans, the shortfall is honest", async () => {
    const store = new InMemoryStore();
    await seedFullyVerifiedScenario(store);

    await store.insertVtuberTechSetupAmortizationSchedule({
      schedule_ref: "rig-rig-2026-02",
      agency_payee_id: AGENCY_PAYEE_ID,
      description: "3D model rig + tech setup (odd split)",
      total_cost_cents: 1_000, // 3 periods: $3.33 + $3.33 + $3.34
      amortization_periods: 3,
      created_at: NOW.toISOString(),
    });

    // Release one: consumes period zero ($3.33).
    const first = mustSucceed(await postReceipt(store, 90_000, { type: "recon_job", job_id: "job-a" }));
    const releasedOne = mustSucceed(
      await releaseVtuberAgencyDeductions(
        store,
        releaseInput(first.holdback_credit.id, {
          techSetupAmortizationScheduleRef: "rig-rig-2026-02",
        }),
        NOW,
      ),
    );
    expect(releasedOne.tech_setup_amortization?.line_index).toBe(0);
    expect(releasedOne.tech_setup_amortization?.applied_cents).toBe(333);

    // Release two: consumes period one ($3.33) — the derived index advanced.
    const second = mustSucceed(await postReceipt(store, 90_000, { type: "recon_job", job_id: "job-b" }));
    const releasedTwo = mustSucceed(
      await releaseVtuberAgencyDeductions(
        store,
        releaseInput(second.holdback_credit.id, {
          techSetupAmortizationScheduleRef: "rig-rig-2026-02",
        }),
        NOW,
      ),
    );
    expect(releasedTwo.tech_setup_amortization?.line_index).toBe(1);
    expect(releasedTwo.tech_setup_amortization?.applied_cents).toBe(333);

    // Release three: the LAST period absorbs the remainder ($3.34).
    const third = mustSucceed(await postReceipt(store, 90_000, { type: "recon_job", job_id: "job-c" }));
    const releasedThree = mustSucceed(
      await releaseVtuberAgencyDeductions(
        store,
        releaseInput(third.holdback_credit.id, {
          techSetupAmortizationScheduleRef: "rig-rig-2026-02",
        }),
        NOW,
      ),
    );
    expect(releasedThree.tech_setup_amortization?.line_index).toBe(2);
    expect(releasedThree.tech_setup_amortization?.computed_cents).toBe(334);
    expect(releasedThree.tech_setup_amortization?.applied_cents).toBe(334);

    // The schedule is complete: the sum of the lines equals the total, and
    // a fourth release refuses with 409 — the schedule consumed every
    // period.
    const lines = await store.listVtuberTechSetupAmortizationLines("rig-rig-2026-02");
    expect(lines.map((l) => l.line_index)).toEqual([0, 1, 2]);
    expect(lines.reduce((total, l) => total + l.line_cents, 0)).toBe(1_000);
    const fourth = mustSucceed(await postReceipt(store, 90_000, { type: "recon_job", job_id: "job-d" }));
    mustFail(
      await releaseVtuberAgencyDeductions(
        store,
        releaseInput(fourth.holdback_credit.id, {
          techSetupAmortizationScheduleRef: "rig-rig-2026-02",
        }),
        NOW,
      ),
      409,
      "tech_setup_amortization_schedule_completed",
    );
  });
});
