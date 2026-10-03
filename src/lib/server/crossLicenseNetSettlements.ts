// The cross-license net settlement EXECUTION (PR 47, the founder hardware
// directive) — the moment the netting position becomes MONEY.
//
// PR 46 records and recomputes the cross-license net settlement of record
// per (agreement_ref, period): the mutual patent liabilities (Company A
// owes Company B $12M for 5G SEPs while Company B owes Company A $8M for
// Wi-Fi 7 SEPs) net to a single dispatch direction. The recompute replaces
// the sums in place whenever a royalty sheet re-nets — so the walk can run
// repeatedly, for the same or changing totals, BEFORE any execution. THIS
// engine executes the dispatch against the Don ledger:
//
//   1. Read the settlement of record — fail-closed when absent.
//   2. Read the append-only DISPATCH truth and derive the cumulative
//      cleared position from it — never a mutable counter.
//   3. Delta-dispatch: each side's uncleared liability is
//      owed − cleared; the dispatch moves only the signed net difference.
//      Late re-netting to a HIGHER total dispatches the increment; late
//      re-netting to a LOWER total routes the refund back through the
//      liability accounts — the dispatch ledger always reconciles to the
//      settlement of record's CURRENT sums.
//   4. The dispatch row commits position-locked BEFORE any money moves —
//      the replay guard and the concurrency arbiter in one write.
//   5. The receiving company's share rides the SAME fail-closed taxed
//      cascade every payout credits through (withholding, dispute-freeze
//      check, recoupment sweep).
//
// THE RECONCILIATION: after every execution, the dispatched cumulative
// position equals the settlement of record's net — the four liability/
// position legs plus the receiving vault credit balance the journal
// exactly, and the gross cleared columns land on the current owed sums.

import type { Store } from "@/lib/server/store";
import type {
  HardwareCrossLicenseNetDispatchRecord,
  HardwareCrossLicenseNetSettlementRecord,
} from "@/modules/hardware/records";
import { postJournal } from "@/modules/ledger/engine";
import {
  crossLicensePositionDebit,
  crossLicensePositionCredit,
  crossLicenseLiabilityCredit,
  crossLicenseLiabilityDebit,
  fboDebit,
  type GlLegInput,
} from "@/modules/ledger/journal";
import { creditTaxedCascadePayee } from "@/lib/server/patentLitigationEscrow";
import { isUniqueViolation } from "@/lib/server/uniqueViolation";

/** House failure envelope — the patent escrow's shape. */
export type CrossLicenseSettlementFailure = {
  ok: false;
  status: number;
  code: string;
  message: string;
};

export type ExecuteCrossLicenseNetSettlementInput = {
  /** The cross-licensing agreement of record (e.g. "clf-frand-5g-wifi7"). */
  agreement_ref: string;
  /** The settlement period, YYYY-MM. */
  period: string;
};

export type ExecuteCrossLicenseNetSettlementSuccess = {
  ok: true;
  value: {
    settlement: HardwareCrossLicenseNetSettlementRecord;
    /** Whether money moved in this execution. */
    dispatched: boolean;
    /** True when the position was already current — a replayed execution. */
    replayed: boolean;
    /** The dispatch row when this execution moved money. */
    dispatch: HardwareCrossLicenseNetDispatchRecord | null;
    net_before_cents: number;
    net_after_cents: number;
    dispatched_delta_cents: number;
    /** The company that received the net dispatch, when money moved. */
    receiving_payee_id: string | null;
    credits: {
      payee_id: string;
      payee_name: string;
      gross_cents: number;
      net_cents: number;
      step: string;
    }[];
    journal_id: string | null;
  };
};

/** The YYYY-MM period shape the CHECKs pin. */
const PERIOD_SHAPE = /^\d{4}-\d{2}$/;

/**
 * Executes the cross-license net settlement of record for one agreement
 * and period: the mutual patent liabilities clear to a SINGLE net
 * dispatch. Idempotent: an execution against an already-current position
 * is a counted no-op; a concurrent double-execution loses at the
 * position-locked dispatch insert and re-derives from the fresh truth.
 */
export async function executeCrossLicenseNetSettlement(
  store: Store,
  input: ExecuteCrossLicenseNetSettlementInput,
  now: Date = new Date(),
): Promise<ExecuteCrossLicenseNetSettlementSuccess | CrossLicenseSettlementFailure> {
  if (input.agreement_ref.trim() === "" || !PERIOD_SHAPE.test(input.period)) {
    return {
      ok: false,
      status: 422,
      code: "invalid_settlement_identity",
      message: "A cross-license net execution names the agreement of record and a YYYY-MM period.",
    };
  }

  // The settlement of record — fail-closed when absent: nothing
  // dispatches from a recomputed sheet that doesn't exist.
  const settlement: HardwareCrossLicenseNetSettlementRecord | undefined =
    await store.getHardwareCrossLicenseNetSettlement(input.agreement_ref, input.period);
  if (settlement === undefined) {
    return {
      ok: false,
      status: 404,
      code: "net_settlement_not_found",
      message: `No cross-license net settlement of record exists for "${input.agreement_ref}" period "${input.period}" — recompute the royalty sheets first.`,
    };
  }

  // The dispatched position derives from the append-only truth — the
  // cumulative columns of the LAST dispatch, or zeros when none.
  const dispatches = await store.listHardwareCrossLicenseNetDispatches(
    input.agreement_ref,
    input.period,
  );
  const last = dispatches.length > 0 ? dispatches[dispatches.length - 1] : undefined;
  const netBefore = last?.net_after_cents ?? 0;
  const aCleared = last?.a_gross_cleared_cents ?? 0;
  const bCleared = last?.b_gross_cleared_cents ?? 0;

  // The delta-dispatch legs: each side's uncleared liability is what the
  // settlement of record owes minus what earlier dispatches cleared.
  const aLeg = settlement.owed_a_to_b_cents - aCleared;
  const bLeg = settlement.owed_b_to_a_cents - bCleared;
  const delta = aLeg - bLeg;

  // An already-current position is a counted no-op — the replayed
  // execution (or a genuinely balanced settlement): no row, no journal.
  if (delta === 0) {
    return {
      ok: true,
      value: {
        settlement,
        dispatched: false,
        replayed: dispatches.length > 0,
        dispatch: null,
        net_before_cents: netBefore,
        net_after_cents: netBefore,
        dispatched_delta_cents: 0,
        receiving_payee_id: null,
        credits: [],
        journal_id: null,
      },
    };
  }

  // The receiving side: delta > 0 pays Company B (Company A owes the net);
  // delta < 0 pays Company A.
  const receivingPayeeId = delta > 0 ? settlement.company_b_id : settlement.company_a_id;
  const receivingPayeeName =
    delta > 0
      ? `Cross-license counterparty ${settlement.company_b_id}`
      : `Cross-license counterparty ${settlement.company_a_id}`;
  const dispatchAmount = Math.abs(delta);

  // The GL legs: each side's liability account settles its uncleared leg
  // (a debit against the account that owes, a credit when prior
  // dispatches over-cleared), and the netting-position account absorbs
  // the difference. The dispatch's delta leg opens the receiving side.
  const glLegs: GlLegInput[] = [];
  if (aLeg > 0) {
    // Company A settles its remaining liability to the netting position.
    glLegs.push(crossLicenseLiabilityDebit(input.agreement_ref, input.period, "a", aLeg));
    glLegs.push(crossLicensePositionCredit(input.agreement_ref, input.period, aLeg));
  } else if (aLeg < 0) {
    // Prior dispatches over-cleared A's liability — the position refunds.
    glLegs.push(crossLicensePositionDebit(input.agreement_ref, input.period, -aLeg));
    glLegs.push(crossLicenseLiabilityCredit(input.agreement_ref, input.period, "a", -aLeg));
  }
  if (bLeg > 0) {
    glLegs.push(crossLicensePositionDebit(input.agreement_ref, input.period, bLeg));
    glLegs.push(crossLicenseLiabilityCredit(input.agreement_ref, input.period, "b", bLeg));
  } else if (bLeg < 0) {
    glLegs.push(crossLicenseLiabilityDebit(input.agreement_ref, input.period, "b", -bLeg));
    glLegs.push(crossLicensePositionCredit(input.agreement_ref, input.period, -bLeg));
  }
  // The net delta: the position account (delta > 0) or FBO cash
  // (delta < 0 — the refund rides the house account, the cascade credits
  // the receiving payee's vault).
  if (delta > 0) {
    glLegs.push(crossLicensePositionDebit(input.agreement_ref, input.period, delta));
  } else {
    glLegs.push(fboDebit(dispatchAmount));
  }

  // The taxed cascade credits the receiving company's vault — the same
  // fail-closed family every payout rides. Returns the net that landed.
  const landedNet = await creditTaxedCascadePayee(
    store,
    receivingPayeeId,
    receivingPayeeName,
    dispatchAmount,
    now,
    glLegs,
    [],
  );
  const creditsOut = [
    {
      payee_id: receivingPayeeId,
      payee_name: receivingPayeeName,
      gross_cents: dispatchAmount,
      net_cents: landedNet,
      step: "net_dispatch",
    },
  ];

  // The position-locked dispatch insert — the replay guard AND the
  // arbiter, in one write. net_before is the cumulative signed position
  // before this execution; net_after the settlement of record's net
  // (cumulative position after — they converge because the walk replaces
  // the sums in place). UNIQUE per (agreement_ref, period, net_before,
  // net_after): a replayed execution at the same state or a lost race
  // throws here, never a double dispatch; a re-net that revisits an
  // earlier net stays distinct through net_before.
  const netAfter = netBefore + delta;
  let dispatch: HardwareCrossLicenseNetDispatchRecord;
  try {
    dispatch = await store.insertHardwareCrossLicenseNetDispatch({
      agreement_ref: input.agreement_ref,
      period: input.period,
      company_a_id: settlement.company_a_id,
      company_b_id: settlement.company_b_id,
      currency: settlement.currency,
      net_before_cents: netBefore,
      net_after_cents: netAfter,
      dispatched_delta_cents: delta,
      a_gross_cleared_cents: settlement.owed_a_to_b_cents,
      b_gross_cleared_cents: settlement.owed_b_to_a_cents,
      direction: delta > 0 ? "a_to_b" : "b_to_a",
      journal_id: null,
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      // The loser re-derives from the fresh truth: the winner's dispatch
      // already moved this money — a counted no-op unless the position
      // still diverges (a second re-net landed mid-race), in which case
      // the caller retries and the next execution dispatches the
      // remainder.
      return {
        ok: true,
        value: {
          settlement,
          dispatched: false,
          replayed: true,
          dispatch: null,
          net_before_cents: netBefore,
          net_after_cents: netBefore,
          dispatched_delta_cents: 0,
          receiving_payee_id: null,
          credits: [],
          journal_id: null,
        },
      };
    }
    throw error;
  }

  // The dispatch's own journal: the full leg set, balance-enforced by
  // postJournal before the row commits to the hash chain.
  const posted = await postJournal(store, {
    kind: "cross_license_net_dispatch",
    ref_type: "hardware_cross_license_net_settlement",
    ref_id: settlement.id,
    legs: glLegs,
  });
  if (!posted.ok) {
    return { ok: false, status: 500, code: posted.code, message: posted.message };
  }

  return {
    ok: true,
    value: {
      settlement,
      dispatched: true,
      replayed: false,
      dispatch,
      net_before_cents: netBefore,
      net_after_cents: netAfter,
      dispatched_delta_cents: delta,
      receiving_payee_id: receivingPayeeId,
      credits: creditsOut,
      journal_id: posted.journal.id,
    },
  };
}
