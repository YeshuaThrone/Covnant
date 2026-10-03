// Unclaimed royalty holding — PR 7 (founder V1 directive, 2026-09-30).
//
// When Astra identifies unallocated streams matching a verified track, the
// money must not silently sit in FBO cash and must not silently become
// someone's balance. It posts to HOLDING: ledger rows with kind and status
// 'unclaimed_holding' that are distinct from company dust (payee 'platform'),
// from every creator vault, and from the platform GL dust account — three
// dimensions (payee, GL account, ledger kind) so no query can fold one into
// another. It stays held until identity AND splits are fully verified; only
// then does release move it to creator balances, through the SAME
// clearance-gated settlement path every payout uses (payoutGate's
// fail-closed evaluatePayoutCompliance + the normal creator-credit sequence:
// withholding, recoupment sweep, guarded vault credits, hash-chained GL).
//
// NO MIGRATION. ledger_transactions.status/kind are free text columns
// (migration 0006 places no check constraint on either), so the state
// extends the existing ledger contract in place — the founder-directive
// preference over new DDL.
//
// THE WORKER SEAM STAYS DORMANT. The CVT recon worker (PR #82) does not call
// this module yet — its canonical posting path activates in a follow-up once
// this state ships. This module is the state, the posting seam, the release
// path, and the recovery-candidate discovery, with the locked invariants
// under test.
//
// Ordering (insert-as-lock, the payout-reversal precedent): the release CAS
// (Store.settleUnclaimedHolding) flips the row BEFORE any vault credit, so a
// crash mid-release fails toward "nothing moved twice" — a settled row with
// no unclaimed_holding_release journal is the visible alarm. Posting's
// replay guard is the GL journal ref (one journal per source id); the
// durable arbiter once the worker seam activates is match_queue's unique
// event_id upstream of this seam.

import type { Store } from "@/lib/server/store";
import type { LedgerTransactionRecord, SplitPartyInput } from "@/lib/don/types";
import {
  COMPANY_VARIANCE_PAYEE_ID,
  COMPANY_VARIANCE_PAYEE_NAME,
  UNCLAIMED_HOLDING_PAYEE_ID,
  UNCLAIMED_HOLDING_PAYEE_NAME,
} from "@/modules/don/constants";
import {
  allocateWithCompanyDustSweep,
  zeroBalanceHolds,
} from "@/modules/don/dust";
import { applyWithholding } from "@/modules/compliance/engine";
import {
  evaluatePayoutCompliance,
  getVerticalComplianceStateSource,
  resolveAiVerticalComplianceState,
  resolveArtVerticalComplianceState,
  resolveCreatorKycStatus,
  type AssetVertical,
} from "@/modules/compliance/payoutGate";
import { applyRecoupmentSweep, type RecoupmentSweepOutcome } from "@/modules/recoupment/engine";
import { postJournal } from "@/modules/ledger/engine";
import {
  fboDebit,
  unclaimedHoldingCredit,
  unclaimedHoldingDebit,
  vaultCredit,
  type GlLegInput,
} from "@/modules/ledger/journal";
import type { CompanyDustRecord, TaxEscrowRecord } from "@/modules/don/records";
import type { MatchQueueRecord } from "@/modules/sdk/records";
import { creditVault } from "@/modules/vaults/engine";
import { isIncomingFrozen } from "@/modules/vaults/dispute";
import type { VaultCreditTarget } from "@/modules/vaults/balances";

/** House failure envelope — the udrSplits / vaults-engine shape. */
export type UnclaimedHoldingFailure = {
  ok: false;
  status: number;
  code: string;
  message: string;
};

/**
 * Where the held funds were identified — the recovery linkage. The GL
 * post-journal carries this as its ref (ref_type/ref_id), and a
 * match_queue-sourced credit ALSO stamps the quarantined event's event_id
 * into line_item_id, so the row is discoverable through the existing
 * listLedgerTransactionsByLineItem without a new index or column.
 */
export type UnclaimedHoldingSource =
  | { type: "match_queue"; event_id: string }
  | { type: "recon_job"; job_id: string }
  | { type: "manual"; note: string };

export interface UnclaimedHoldingPostInput {
  /** The identified-unallocated gross, integer cents. */
  amount_cents: number;
  currency: string;
  source: UnclaimedHoldingSource;
  /** Run linkage when the posting arises inside a run's reconciliation. */
  split_run_id?: string | null;
}

export type UnclaimedHoldingPostSuccess = {
  ok: true;
  value: {
    /** The held credit — kind and status both 'unclaimed_holding'. */
    holding_credit: LedgerTransactionRecord;
    journal_id: string;
  };
};

export interface UnclaimedHoldingReleaseInput {
  /** The held credit to release (the ledger row id). */
  holding_ledger_id: string;
  /**
   * The VERIFIED allocation — shares must sum to 10000 bps and the sweep's
   * dust (integer-cent remainder) routes to the platform payee, exactly as
   * a royalty ingest's does.
   */
  splits: SplitPartyInput[];
  /** The clearance gate's first condition — fail-closed on anything but true. */
  operator_settlement_approved: boolean;
  /** The asset vertical whose compliance hold state the gate evaluates. */
  vertical: AssetVertical;
}

export type UnclaimedHoldingReleaseSuccess = {
  ok: true;
  value: {
    /** The released row — status 'settled', kind still 'unclaimed_holding'. */
    holding_credit: LedgerTransactionRecord;
    /** Per-party outcome; net_cents is post-withholding, post-recoupment. */
    party_credits: Array<{
      payee_id: string;
      payee_name: string;
      role: SplitPartyInput["role"];
      gross_cents: number;
      net_cents: number;
    }>;
    company_dust_cents: number;
    withholding: TaxEscrowRecord[];
    recoupment: Array<RecoupmentSweepOutcome & { payee_id: string }>;
    dust_ledger: CompanyDustRecord[];
    journal_id: string;
  };
};

/**
 * Posts one unallocated gross to holding. The money's GL leg is an FBO
 * debit (cash arrived) against a credit on the platform holding account —
 * no vault is minted, no dust ledger row is written, no payee is credited.
 */
export async function postToUnclaimedHolding(
  store: Store,
  input: UnclaimedHoldingPostInput,
  now: Date = new Date(),
): Promise<UnclaimedHoldingPostSuccess | UnclaimedHoldingFailure> {
  // Integer cents, the house invariant — a float amount is refused, never rounded.
  if (!Number.isSafeInteger(input.amount_cents) || input.amount_cents <= 0) {
    return {
      ok: false,
      status: 422,
      code: "invalid_amount",
      message: "Holding credits post integer cents greater than zero.",
    };
  }

  const source = input.source;
  // The journal ref names the SOURCE for match_queue/recon_job provenance;
  // a manual post refs its own ledger row (nothing else exists to point at).
  const refType =
    source.type === "match_queue"
      ? "match_queue"
      : source.type === "recon_job"
        ? "recon_job"
        : "ledger_transaction";
  const sourceRefId =
    source.type === "match_queue"
      ? source.event_id
      : source.type === "recon_job"
        ? source.job_id
        : "";

  // Replay guard: one post per source id. The journal ref is the marker —
  // listGlJournalsByRef is indexed on (ref_type, ref_id) (migration 0006).
  if (sourceRefId !== "") {
    const prior = await store.listGlJournalsByRef(refType, sourceRefId);
    if (prior.length > 0) {
      return {
        ok: false,
        status: 409,
        code: "unclaimed_holding_already_posted",
        message: `A holding credit for ${refType} "${sourceRefId}" was already posted (${prior.length} journal(s) ref it).`,
      };
    }
  }

  const createdAt = now.toISOString();
  const credit = await store.insertLedgerTransaction({
    split_run_id: input.split_run_id ?? "",
    // For match_queue-sourced posts the quarantined event IS the source line
    // (the worker writes one queue row per statement line) — the row-level
    // recovery linkage rides the existing line-item index.
    line_item_id: source.type === "match_queue" ? source.event_id : "",
    payee_id: UNCLAIMED_HOLDING_PAYEE_ID,
    payee_name: UNCLAIMED_HOLDING_PAYEE_NAME,
    role: "other",
    share_bps: 0,
    amount_cents: input.amount_cents,
    currency: input.currency,
    status: "unclaimed_holding",
    rail: null,
    baas_provider: null,
    baas_transfer_id: null,
    created_at: createdAt,
    settled_at: null,
    kind: "unclaimed_holding",
  });

  const posted = await postJournal(
    store,
    {
      kind: "unclaimed_holding_post",
      ref_type: refType,
      ref_id: sourceRefId === "" ? credit.id : sourceRefId,
      legs: [
        fboDebit(input.amount_cents),
        unclaimedHoldingCredit(input.amount_cents),
      ],
    },
    now,
  );
  if (!posted.ok) {
    return { ok: false, status: 500, code: posted.code, message: posted.message };
  }
  return {
    ok: true,
    value: { holding_credit: credit, journal_id: posted.journal.id },
  };
}

/**
 * Releases one held credit to creator balances — ONLY through the normal
 * clearance-gated settlement path:
 *
 *   1. the row must be a HELD holding credit (404 / 422 / 409 otherwise —
 *      a replayed release reads the 409, never a double release),
 *   2. the verified splits must balance (allocateWithCompanyDustSweep —
 *      shares sum to 10000 bps, the integer-cent remainder is dust),
 *   3. EVERY credited payee except the platform house payee must pass the
 *      SAME fail-closed payout compliance gate as a Lithic dispatch —
 *      operator settlement approval, Plaid-backed KYC verified, and the
 *      vertical's compliance hold state (unknown refuses),
 *   4. the CAS flip wins (the concurrent loser gets undefined and a 409),
 *   5. then the normal creator-credit sequence moves the money: withholding
 *      escrow, recoupment sweep, guarded vault credits (pending bucket —
 *      the non-settled ingest destination; payout dispatch stays downstream
 *      of the operator), dust to the platform payee, and the balanced
 *      unclaimed_holding_release journal.
 */
export async function releaseUnclaimedHolding(
  store: Store,
  input: UnclaimedHoldingReleaseInput,
  now: Date = new Date(),
): Promise<UnclaimedHoldingReleaseSuccess | UnclaimedHoldingFailure> {
  const row = await store.getLedgerTransaction(input.holding_ledger_id);
  if (row === undefined) {
    return {
      ok: false,
      status: 404,
      code: "holding_credit_not_found",
      message: "No ledger transaction matches that id.",
    };
  }
  if (row.kind !== "unclaimed_holding") {
    return {
      ok: false,
      status: 422,
      code: "not_a_holding_credit",
      message: `Ledger transaction ${row.id} is kind "${row.kind}" — only unclaimed holding credits release here.`,
    };
  }
  if (row.status === "unauthorized_training_hold") {
    // THE DISPUTE FREEZE (PR 25): the leg is frozen by an active IP
    // attribution dispute against the training dataset. The ONLY exit is
    // the verified resolution path (the dispute's CAS resolution → the
    // thaw sweep) — a release attempt never unfreezes.
    return {
      ok: false,
      status: 403,
      code: "unauthorized_training_hold",
      message: `Holding credit ${row.id} is frozen in unauthorized_training_hold — an IP attribution dispute against the training dataset is active. Thaw runs only through the verified resolution path.`,
    };
  }
  if (row.status === "foreign_tax_hold") {
    // THE FOREIGN-TAX FREEZE (PR 27): the leg is a foreign print royalty
    // held pending verified withholding-tax-credit evidence for its
    // country/tax-year scope. The ONLY exit is the verified credit path
    // (the evidence upsert → the thaw sweep) — a release attempt never
    // unfreezes, fail-closed exactly like the dispute freeze above.
    return {
      ok: false,
      status: 403,
      code: "foreign_tax_hold",
      message: `Holding credit ${row.id} is frozen in foreign_tax_hold — verified withholding tax credit evidence for its territory has not landed. Thaw runs only through the verified credit path.`,
    };
  }
  if (row.status !== "unclaimed_holding") {
    return {
      ok: false,
      status: 409,
      code: "holding_already_released",
      message: `Holding credit ${row.id} is no longer held (status "${row.status}").`,
    };
  }

  const allocation = allocateWithCompanyDustSweep(row.amount_cents, input.splits);
  if (!allocation.ok) {
    return {
      ok: false,
      status: 422,
      code: allocation.code,
      message: allocation.message,
    };
  }
  if (input.splits.some((party) => party.payee_id === UNCLAIMED_HOLDING_PAYEE_ID)) {
    return {
      ok: false,
      status: 422,
      code: "splits_do_not_balance",
      message: "A release cannot pay the holding sentinel back into holding.",
    };
  }
  if (
    !zeroBalanceHolds(row.amount_cents, allocation.splits, allocation.company_dust_cents)
  ) {
    return {
      ok: false,
      status: 500,
      code: "zero_balance_violation",
      message:
        "sum(verified allocations) + company_dust !== held amount — release refused.",
    };
  }

  // Full verification = identity AND splits. Splits balanced above; identity
  // and the vertical compliance state run through the SAME fail-closed gate
  // the Lithic dispatch route uses, once per credited payee (the platform
  // house payee holds no KYC record by design and is skipped).
  const verticalStateSource = getVerticalComplianceStateSource();
  for (const party of allocation.splits) {
    if (party.payee_id === COMPANY_VARIANCE_PAYEE_ID) continue;
    const kycStatus = await resolveCreatorKycStatus(store, party.payee_id);
    let verticalState = await verticalStateSource({
      payeeId: party.payee_id,
      vertical: input.vertical,
    });
    if (verticalState === null && input.vertical === "ai") {
      // The AI vertical's fallback (PR 25): when the request-scoped source
      // has no state for the payee, resolve from the payout-gate states of
      // record (migration 0029) — fail-closed on absent (null stays null)
      // and on 'unknown' (maps to false, the specific condition refuses).
      verticalState = await resolveAiVerticalComplianceState(
        store,
        party.payee_id,
      );
    }
    if (verticalState === null && input.vertical === "art") {
      // The art vertical's fallback (PR 29): the same fail-closed pattern,
      // resolved from the estate payout-gate states of record (migration
      // 0033) — absent stays null (vertical_state_unknown refuses) and an
      // 'unknown' state of record maps to false (the estate condition
      // refuses). Only the verified estate succession state passes.
      verticalState = await resolveArtVerticalComplianceState(
        store,
        party.payee_id,
      );
    }
    const compliance = evaluatePayoutCompliance({
      operatorSettlementApproved: input.operator_settlement_approved,
      kycStatus,
      verticalState,
    });
    if (!compliance.ok) {
      return {
        ok: false,
        status: 403,
        code: compliance.code,
        message: `Holding release refused for payee "${party.payee_id}": ${compliance.message}`,
      };
    }
  }

  // The CAS wins BEFORE any money moves (insert-as-lock): the concurrent
  // release loser reads undefined here and refuses with the same 409 a
  // replayed release gets.
  const settled = await store.settleUnclaimedHolding(
    row.id,
    now.toISOString(),
  );
  if (settled === undefined) {
    return {
      ok: false,
      status: 409,
      code: "holding_already_released",
      message: `Holding credit ${row.id} is no longer held — a concurrent release won.`,
    };
  }

  // The normal creator-credit sequence — the udrSplits non-settled path,
  // ledger for ledger and leg for leg. Every branch conserves its cents:
  // recoupment splits incoming into recouped + excess; withholding splits
  // gross into net + escrowed reserve.
  const glLegs: GlLegInput[] = [unclaimedHoldingDebit(row.amount_cents)];
  const withholding: TaxEscrowRecord[] = [];
  const recoupment: Array<RecoupmentSweepOutcome & { payee_id: string }> = [];
  const dustLedger: CompanyDustRecord[] = [];
  const partyCredits: UnclaimedHoldingReleaseSuccess["value"]["party_credits"] = [];

  for (const party of allocation.splits) {
    let creditAmount = party.amount_cents;
    if (party.role === "creator" && party.amount_cents > 0) {
      const taxed = await applyWithholding(store, {
        creator_id: party.payee_id,
        gross_cents: party.amount_cents,
        tax_year: now.getUTCFullYear(),
      });
      withholding.push(taxed.value.escrow);
      creditAmount = taxed.value.net_cents;
      if (taxed.value.withheld_cents > 0) {
        await creditVault(
          store,
          party.payee_id,
          party.payee_name,
          taxed.value.withheld_cents,
          "reserve",
          now,
        );
        glLegs.push(
          vaultCredit(party.payee_id, "reserve", taxed.value.withheld_cents),
        );
      }
    }
    // No work context exists on a holding credit — the catalog-dispute
    // freeze check runs against the empty work key, which no dispute row
    // occupies (honest not-frozen, not a skipped check).
    const incomingFrozen = await isIncomingFrozen(
      store,
      party.payee_id,
      "",
    );
    const excessBucket: VaultCreditTarget = incomingFrozen
      ? "reserve"
      : "available";
    const recouped = await applyRecoupmentSweep(
      store,
      party.payee_id,
      party.payee_name,
      creditAmount,
      now,
      {
        split_run_id: row.split_run_id,
        excess_target: excessBucket,
      },
    );
    if (recouped.applied) {
      recoupment.push({ ...recouped, payee_id: party.payee_id });
      if (recouped.recouped_cents > 0) {
        glLegs.push(
          vaultCredit(
            COMPANY_VARIANCE_PAYEE_ID,
            "available",
            recouped.recouped_cents,
          ),
        );
      }
      if (recouped.excess_cents > 0) {
        glLegs.push(
          vaultCredit(party.payee_id, excessBucket, recouped.excess_cents),
        );
      }
    } else if (incomingFrozen && creditAmount > 0) {
      await creditVault(
        store,
        party.payee_id,
        party.payee_name,
        creditAmount,
        "reserve",
        now,
      );
      glLegs.push(vaultCredit(party.payee_id, "reserve", creditAmount));
    } else if (creditAmount > 0) {
      await creditVault(
        store,
        party.payee_id,
        party.payee_name,
        creditAmount,
        "pending",
        now,
      );
      glLegs.push(vaultCredit(party.payee_id, "pending", creditAmount));
    }
    partyCredits.push({
      payee_id: party.payee_id,
      payee_name: party.payee_name,
      role: party.role,
      gross_cents: party.amount_cents,
      net_cents: creditAmount,
    });
  }

  if (allocation.company_dust_cents > 0) {
    dustLedger.push(
      await store.insertCompanyDust({
        split_run_id: row.split_run_id,
        line_item_id: row.line_item_id,
        amount_cents: allocation.company_dust_cents,
        variance_account_id: COMPANY_VARIANCE_PAYEE_ID,
        created_at: now.toISOString(),
      }),
    );
    await creditVault(
      store,
      COMPANY_VARIANCE_PAYEE_ID,
      COMPANY_VARIANCE_PAYEE_NAME,
      allocation.company_dust_cents,
      "pending",
      now,
    );
    glLegs.push(
      vaultCredit(
        COMPANY_VARIANCE_PAYEE_ID,
        "pending",
        allocation.company_dust_cents,
      ),
    );
  }

  const posted = await postJournal(
    store,
    {
      kind: "unclaimed_holding_release",
      ref_type: "ledger_transaction",
      ref_id: row.id,
      legs: glLegs,
    },
    now,
  );
  if (!posted.ok) {
    return { ok: false, status: 500, code: posted.code, message: posted.message };
  }

  return {
    ok: true,
    value: {
      holding_credit: settled,
      party_credits: partyCredits,
      company_dust_cents: allocation.company_dust_cents,
      withholding,
      recoupment,
      dust_ledger: dustLedger,
      journal_id: posted.journal.id,
    },
  };
}

// ---------------------------------------------------------------------------
// Recovery candidate discovery — the read surface that pairs the CVT worker's
// quarantined rights-type events with the unclaimed ledger credits. The
// worker's quarantine vocabulary, verbatim: a quarantined event is a
// match_queue row with status 'open'; the RIGHTS-type quarantine is
// rights_type 'unknown' (the split-quarantine rule excludes those rows from
// split math until reclassified). Nothing here writes — the worker's files
// are untouched, and its posting seam activates in a follow-up.
// ---------------------------------------------------------------------------

/** One open rights-quarantined event paired with the credits held against it. */
export interface RecoveryCandidate {
  event: MatchQueueRecord;
  /** Held credits whose line_item_id is this event's event_id, newest first. */
  credits: LedgerTransactionRecord[];
  held_cents: number;
}

export interface RecoveryCandidateReport {
  candidates: RecoveryCandidate[];
  /**
   * Held credits not paired with an open rights-quarantined event —
   * manual or recon_job posts (their linkage lives on the GL journal ref).
   */
  unlinked: LedgerTransactionRecord[];
  /** Σ every held credit — the full holding balance, integer cents. */
  total_held_cents: number;
}

/** Integer-cent sum over held credits — the pure core of the report. */
export function sumHeldCents(credits: ReadonlyArray<{ amount_cents: number }>): number {
  return credits.reduce((total, credit) => total + credit.amount_cents, 0);
}

/**
 * Pairs every open rights-quarantined match_queue event with the held
 * credits stamped to its event_id, and reports held credits no open event
 * explains. Zero-credit candidates are real rows (nothing posted yet), not
 * gaps — the recovery view shows the whole quarantine honestly.
 */
export async function listRecoveryCandidates(
  store: Store,
  limit: number = 200,
): Promise<RecoveryCandidateReport> {
  const held = await store.listUnclaimedHoldingCredits(limit);
  const open = await store.listMatchQueueEntries("open", limit);

  const byEventId = new Map<string, LedgerTransactionRecord[]>();
  const unlinked: LedgerTransactionRecord[] = [];
  for (const credit of held) {
    if (credit.line_item_id === "") {
      unlinked.push(credit);
      continue;
    }
    const paired = byEventId.get(credit.line_item_id) ?? [];
    paired.push(credit);
    byEventId.set(credit.line_item_id, paired);
  }

  // Every open event with held money is a recovery candidate — not just
  // rights-'unknown' rows. Since the canonical posting seam activated,
  // MATCHED music rows post holding credits too; filtering them out here
  // would blind the recovery report to exactly the money the seam holds.
  const candidates: RecoveryCandidate[] = open.map((event) => {
    const credits = byEventId.get(event.event_id) ?? [];
    return { event, credits, held_cents: sumHeldCents(credits) };
  });

  return {
    candidates,
    unlinked,
    total_held_cents: sumHeldCents(held),
  };
}
