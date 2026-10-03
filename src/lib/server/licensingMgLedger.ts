// Advance / minimum-guarantee recoupment ledger + the automatic shortfall
// penalty (PR 33, founder directive).
//
// A brand-licensing advance (the "MG") is money the licensee was paid
// UPFRONT against future earned royalties. This lane is the machinery that
// offsets that advance against actual earnings — per contract, per the
// founder's collateralization directive — and debits the invoice of record
// when the guarantee is missed.
//
//   1. THE RECOUPMENT PASS — after the PR 32 royalty cascade commits an
//      event's application (the earnings of record), this lane offsets the
//      event's post-agency earned royalty (licensor_a_gross +
//      licensor_b_gross — the withholding is a payout-side treaty leg, not
//      an earnings reduction) across the scope's registered advances. The
//      routing order is deterministic and documented: CATEGORY-ISOLATED
//      commitments matching the event's category (created_at ASC) first,
//      then CROSS-COLLATERALIZED commitments (created_at ASC) — the
//      directive's example: a $250,000 upfront MG for footwear versus a
//      separate apparel MG, where isolated footwear royalties recoup the
//      footwear advance and never touch the apparel advance. Each
//      application row commits position-locked (UNIQUE per (commitment,
//      event) replay guard + UNIQUE per (commitment, recouped_before)
//      position lock — the 0036 application discipline at commitment
//      scope); a lost position race retries at the advanced position.
//      Recoupment is an EARNING ATTRIBUTION — the advance cash moved at
//      signing, so the applications are the ledger truth and no GL journal
//      posts per application.
//
//   2. THE TERM CLOSE + SHORTFALL INVOICE — closeLicensingMgTerm is the
//      contract term's close of record per (commitment, term): UNIQUE per
//      the pair (the once-only close), the recouped position derived from
//      the append-only applications, the shortfall = max(0, mg − recouped).
//      A positive shortfall DEBITS THE INVOICE OF RECORD automatically: a
//      ledger row with kind AND status 'mg_shortfall_due' — the payee is
//      the LICENSEE of record, the term-close key stamped in line_item_id —
//      plus the GL journal (the receivable asset rises, the shortfall
//      penalty income of record rises; balanced legs). A zero shortfall
//      records the fully-recouped close and moves nothing.

import type { Store } from "@/lib/server/store";
import type { LedgerTransactionRecord } from "@/lib/don/types";
import {
  isLicensingMgTerm,
  type LicensingMgCommitmentRecord,
  type LicensingMgRecoupmentApplicationRecord,
  type LicensingMgTermCloseRecord,
  type LicensingRoyaltyApplicationRecord,
} from "@/modules/licensing/records";
import { postJournal } from "@/modules/ledger/engine";
import {
  licensingMgReceivableDebit,
  licensingMgShortfallIncomeCredit,
} from "@/modules/ledger/journal";
import { isUniqueViolation } from "@/lib/server/uniqueViolation";

/** House failure envelope — the merch cascade / unclaimed-holding shape. */
export type LicensingMgFailure = {
  ok: false;
  status: number;
  code: string;
  message: string;
};

/**
 * The PURE recoupment router — one event's earned royalty ordered across
 * one scope's commitments in the directive's routing order (isolated
 * matching-category first, then cross-collateralized; created_at ASC
 * inside each lane), each commitment taking until the royalty is
 * exhausted or the advance is fully recouped. Exact integer cents; the
 * applications always sum to min(royalty, unrecouped capacity). A
 * category_isolated commitment of a DIFFERENT category is never a
 * candidate — that is the whole point of isolation.
 */
export function buildMgRecoupmentPlan(input: {
  earned_royalty_cents: number;
  category_code: string;
  commitments: Pick<
    LicensingMgCommitmentRecord,
    | "id"
    | "category_code"
    | "collateralization"
    | "mg_amount_cents"
    | "recouped_cents"
    | "created_at"
  >[];
}):
  | { ok: true; value: { commitment_id: string; recouped_cents: number }[] }
  | LicensingMgFailure {
  const { earned_royalty_cents, category_code, commitments } = input;
  if (!Number.isInteger(earned_royalty_cents) || earned_royalty_cents <= 0) {
    return {
      ok: false,
      status: 422,
      code: "invalid_recoupment_amount",
      message: "A royalty event recoups in whole positive cents.",
    };
  }
  for (const commitment of commitments) {
    if (
      !Number.isInteger(commitment.mg_amount_cents) ||
      commitment.mg_amount_cents <= 0 ||
      !Number.isInteger(commitment.recouped_cents) ||
      commitment.recouped_cents < 0
    ) {
      return {
        ok: false,
        status: 422,
        code: "invalid_mg_commitment",
        message: `Advance ${commitment.id} carries a non-integer or negative amount — refuse, never clip.`,
      };
    }
  }
  const remainingOn = (commitment: (typeof commitments)[number]): number =>
    Math.max(0, commitment.mg_amount_cents - commitment.recouped_cents);
  const isolated = commitments
    .filter(
      (row) =>
        row.collateralization === "category_isolated" &&
        row.category_code === category_code,
    )
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  const cross = commitments
    .filter((row) => row.collateralization === "cross_collateralized")
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  let remainingRoyalty = earned_royalty_cents;
  const applications: { commitment_id: string; recouped_cents: number }[] = [];
  for (const commitment of [...isolated, ...cross]) {
    if (remainingRoyalty <= 0) break;
    const capacity = remainingOn(commitment);
    if (capacity <= 0) continue;
    const applied = Math.min(capacity, remainingRoyalty);
    applications.push({ commitment_id: commitment.id, recouped_cents: applied });
    remainingRoyalty -= applied;
  }
  return { ok: true, value: applications };
}

export type LicensingMgRecoupmentSuccess = {
  ok: true;
  value: {
    /** The committed application the recoupment read — the earnings of
     * record (never a recomputation). */
    royalty_application: LicensingRoyaltyApplicationRecord;
    /** The executed applications, in routing order. */
    applications: LicensingMgRecoupmentApplicationRecord[];
    /** The event's royalty that found no unrecouped capacity — it stays
     * earned (the licensors' money), just recoups nothing. */
    unreconciled_royalty_cents: number;
  };
};

export type LicensingMgRecoupmentInput = {
  deal_id: string;
  source_event_id: string;
  /** The event's category of record (the deal's category_code) — the
   * isolated-routing key. Never guessed. */
  category_code: string;
};

/**
 * Runs the recoupment pass for one committed royalty event: reads the
 * application of record by (deal_id, source_event_id), plans the routing
 * across the scope's registered advances, and commits each application
 * position-locked. Idempotent BY EVENT: an event whose royalty already
 * recouped (any application row exists for the event under this scope)
 * returns the counted no-op — the replay guard's honest shape.
 */
export async function recoupLicensingRoyaltyEvent(
  store: Store,
  input: LicensingMgRecoupmentInput,
): Promise<LicensingMgRecoupmentSuccess | LicensingMgFailure> {
  if (input.category_code.trim() === "") {
    return {
      ok: false,
      status: 422,
      code: "invalid_category_identity",
      message: "A recoupment pass names the event's category of record.",
    };
  }
  const application = await store.getLicensingRoyaltyApplication(
    input.deal_id,
    input.source_event_id,
  );
  if (application === undefined) {
    return {
      ok: false,
      status: 404,
      code: "royalty_application_not_found",
      message:
        "No committed royalty application matches that (deal, event) — the PR 32 cascade commits the earnings before the recoupment pass runs.",
    };
  }
  // The post-agency earned royalty — the recoupment basis. The treaty
  // withholding is a payout-side leg and never reduces earnings of record.
  const earnedRoyaltyCents =
    application.licensor_a_gross_cents + application.licensor_b_gross_cents;
  if (earnedRoyaltyCents <= 0) {
    return {
      ok: false,
      status: 422,
      code: "no_earned_royalty",
      message:
        "The committed application carries no post-agency earned royalty to recoup.",
    };
  }
  // A replayed event is a counted no-op — any application row for this
  // event under this scope's commitments means the pass already ran.
  const commitments = await store.listLicensingMgCommitments(application.scope_key);
  for (const commitment of commitments) {
    const existing = await store.listLicensingMgRecoupmentApplications(commitment.id);
    if (existing.some((row) => row.source_event_id === input.source_event_id)) {
      return {
        ok: true,
        value: {
          royalty_application: application,
          applications: [],
          unreconciled_royalty_cents: earnedRoyaltyCents,
        },
      };
    }
  }
  const planned = buildMgRecoupmentPlan({
    earned_royalty_cents: earnedRoyaltyCents,
    category_code: input.category_code,
    commitments,
  });
  if (!planned.ok) return planned;

  const executed = await commitRecoupmentPlan(
    store,
    input.source_event_id,
    earnedRoyaltyCents,
    { plan: planned.value, commitments },
  );
  const appliedTotal = executed.reduce((total, row) => total + row.recouped_cents, 0);
  return {
    ok: true,
    value: {
      royalty_application: application,
      applications: executed,
      unreconciled_royalty_cents: earnedRoyaltyCents - appliedTotal,
    },
  };
}

/**
 * The position-locked commit half of the recoupment pass: each planned
 * application commits in routing order with a bounded retry on the
 * position race — a concurrent recoupment of the same advance advanced the
 * position, so re-derive from the append-only truth and retry at the fresh
 * position (the 0036 application discipline; three attempts, then surface
 * the error — never guess).
 */
async function commitRecoupmentPlan(
  store: Store,
  sourceEventId: string,
  earnedRoyaltyCents: number,
  context: {
    plan: { commitment_id: string; recouped_cents: number }[];
    commitments: LicensingMgCommitmentRecord[];
  },
): Promise<LicensingMgRecoupmentApplicationRecord[]> {
  const executed: LicensingMgRecoupmentApplicationRecord[] = [];
  for (const step of context.plan) {
    const commitment = context.commitments.find((row) => row.id === step.commitment_id);
    if (commitment === undefined) {
      throw new Error(`Advance ${step.commitment_id} disappeared mid-recoupment`);
    }
    let committed: LicensingMgRecoupmentApplicationRecord | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const prior = await store.listLicensingMgRecoupmentApplications(commitment.id);
      const recoupedBefore = prior.reduce((total, row) => total + row.recouped_cents, 0);
      const recoupedNow = Math.min(
        step.recouped_cents,
        Math.max(0, commitment.mg_amount_cents - recoupedBefore),
      );
      if (recoupedNow <= 0) break;
      try {
        committed = await store.insertLicensingMgRecoupmentApplication({
          commitment_id: commitment.id,
          scope_key: commitment.scope_key,
          category_code: commitment.category_code,
          source_event_id: sourceEventId,
          earned_royalty_cents: earnedRoyaltyCents,
          recouped_before_cents: recoupedBefore,
          recouped_cents: recoupedNow,
          recouped_after_cents: recoupedBefore + recoupedNow,
        });
        break;
      } catch (error) {
        // A replayed (commitment, event) is excluded above, so a unique
        // violation here is the position race: re-derive and retry at the
        // advanced position.
        if (isUniqueViolation(error) && attempt < 2) {
          continue;
        }
        throw error;
      }
    }
    if (committed !== undefined) {
      executed.push(committed);
      // Keep the bookkeeping counter aligned with the truth (heal-only —
      // the applications remain the arbiter).
      await store.upsertLicensingMgCommitment({
        scope_key: commitment.scope_key,
        commitment_ref: commitment.commitment_ref,
        category_code: commitment.category_code,
        collateralization: commitment.collateralization,
        mg_amount_cents: commitment.mg_amount_cents,
        currency: commitment.currency,
        licensee_id: commitment.licensee_id,
        licensee_name: commitment.licensee_name,
        recouped_cents: committed.recouped_after_cents,
      });
      // Keep the local capacity fresh for any subsequent step against the
      // same register.
      commitment.recouped_cents = committed.recouped_after_cents;
    }
  }
  return executed;
}

// ---------------------------------------------------------------------------
// The term close + automatic shortfall invoice.
// ---------------------------------------------------------------------------

export type LicensingMgTermCloseInput = {
  scope_key: string;
  commitment_ref: string;
  /** The annual term of record (YYYY) — the directive's annual MG
   * threshold closes per contract year. */
  term: string;
  closed_by: string;
};

export type LicensingMgTermCloseSuccess = {
  ok: true;
  value: {
    close: LicensingMgTermCloseRecord;
    /** The mg_shortfall_due ledger row when the shortfall priced positive. */
    invoice_ledger: LedgerTransactionRecord | null;
    journal_id: string | null;
    /** True when this call's close had already been recorded (the replay's
     * counted no-op — the recorded close of record returns unchanged). */
    replayed: boolean;
  };
};

/**
 * Closes one contract term of record: the once-only close per (commitment,
 * term), the recouped position derived from the append-only applications,
 * the shortfall = max(0, mg − recouped), and — on a positive shortfall —
 * the AUTOMATIC invoice debit: the mg_shortfall_due ledger row against the
 * licensee of record plus the balanced GL journal. A replayed close
 * converges on the recorded close (the invoice never re-posts, the
 * shortfall never re-prices).
 */
export async function closeLicensingMgTerm(
  store: Store,
  input: LicensingMgTermCloseInput,
  now: Date = new Date(),
): Promise<LicensingMgTermCloseSuccess | LicensingMgFailure> {
  if (!isLicensingMgTerm(input.term)) {
    return {
      ok: false,
      status: 422,
      code: "invalid_mg_term",
      message: "A minimum-guarantee term of record is a contract year (YYYY).",
    };
  }
  if (input.closed_by.trim() === "") {
    return {
      ok: false,
      status: 422,
      code: "invalid_closer_identity",
      message: "A term close names the closer of record.",
    };
  }
  // The commitment of record must exist — the close never registers one
  // implicitly (the terms-of-record discipline).
  const commitment = await store.getLicensingMgCommitment(
    input.scope_key,
    input.commitment_ref,
  );
  if (commitment === undefined) {
    return {
      ok: false,
      status: 404,
      code: "mg_commitment_not_found",
      message:
        "No advance of record matches that (scope, commitment ref) — register the advance before closing terms.",
    };
  }

  // The replay check FIRST — a recorded close returns unchanged (the
  // invoice never re-posts, the shortfall never re-prices).
  const existing = await store.getLicensingMgTermClose(commitment.id, input.term);
  if (existing !== undefined) {
    const invoiceLedger =
      existing.invoice_ledger_id !== null
        ? await store.getLedgerTransaction(existing.invoice_ledger_id)
        : null;
    return {
      ok: true,
      value: {
        close: existing,
        invoice_ledger: invoiceLedger ?? null,
        journal_id: null,
        replayed: true,
      },
    };
  }

  // The recouped position derives from the append-only applications —
  // never the mutable counter.
  const applications = await store.listLicensingMgRecoupmentApplications(commitment.id);
  const recoupedAtClose = applications.reduce((total, row) => total + row.recouped_cents, 0);
  const shortfall = Math.max(0, commitment.mg_amount_cents - recoupedAtClose);

  let invoiceLedger: LedgerTransactionRecord | null = null;
  let journalId: string | null = null;
  if (shortfall > 0) {
    // THE AUTOMATIC SHORTFALL PENALTY — the invoice of record debits
    // against the licensee of record: kind AND status 'mg_shortfall_due',
    // the term-close key stamped in line_item_id (the discoverable key),
    // the price exact from the recoupment truth (never guessed).
    invoiceLedger = await store.insertLedgerTransaction({
      split_run_id: "",
      line_item_id: `${commitment.id}:${input.term}`,
      payee_id: commitment.licensee_id,
      payee_name: commitment.licensee_name,
      role: "other",
      share_bps: 0,
      amount_cents: shortfall,
      currency: commitment.currency,
      status: "mg_shortfall_due",
      rail: null,
      baas_provider: null,
      baas_transfer_id: null,
      created_at: now.toISOString(),
      settled_at: null,
      kind: "mg_shortfall_due",
    });
    // The GL journal — the receivable asset rises, the shortfall penalty
    // income of record rises; balanced legs, no cash movement.
    const posted = await postJournal(store, {
      kind: "licensing_mg_shortfall_invoice",
      ref_type: "licensing_mg_term_close",
      ref_id: `${commitment.id}:${input.term}`,
      legs: [
        licensingMgReceivableDebit(commitment.scope_key, shortfall),
        licensingMgShortfallIncomeCredit(commitment.scope_key, shortfall),
      ],
    });
    if (!posted.ok) {
      return { ok: false, status: 500, code: posted.code, message: posted.message };
    }
    journalId = posted.journal.id;
  }

  const close = await store.upsertLicensingMgTermClose({
    commitment_id: commitment.id,
    scope_key: commitment.scope_key,
    term: input.term,
    mg_due_cents: commitment.mg_amount_cents,
    recouped_at_close_cents: recoupedAtClose,
    shortfall_cents: shortfall,
    invoice_ledger_id: invoiceLedger?.id ?? null,
    closed_by: input.closed_by,
  });
  return {
    ok: true,
    value: {
      close,
      invoice_ledger: invoiceLedger,
      journal_id: journalId,
      replayed: false,
    },
  };
}
