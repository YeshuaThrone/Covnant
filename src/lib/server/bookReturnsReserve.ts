/**
 * The foreign-tax hold and book returns-reserve lanes (PR 27, the founder
 * publishing directive).
 *
 * Two protections over the held print-royalty money, both fail-closed:
 *
 *   1. THE FOREIGN-TAX HOLD — a FOREIGN print royalty's holding leg posts
 *      STRAIGHT INTO the `foreign_tax_hold` freeze (same GL legs as an
 *      unclaimed-holding post, distinct journal kind for the audit trail).
 *      The freeze keys on (country_code, tax_year) via the scope id the
 *      ledger row carries in split_run_id. The ONLY exit is VERIFIED
 *      withholding-tax-credit evidence of record for the scope (for
 *      example US-UK treaty evidence) — the evidence upsert → the thaw
 *      sweep. Absent, pending, and failed evidence all refuse; a release
 *      attempt never unfreezes (the PR 25 dispute-freeze precedent).
 *
 *   2. THE BOOK RETURNS RESERVE — a physical print allocation's held net
 *      splits at lock time: the founder-banded reserve share (15–20%, the
 *      policy of record) locks into the per-ISBN returns reserve
 *      (kind+status `book_returns_reserve`, the merch instance's mechanics
 *      through PR 23's generalized planners), and the remainder re-parks
 *      in unclaimed holding until the publishing payout gate clears.
 *      Publisher returns and chargebacks draw the held reserves down
 *      (money back to FBO); whatever they cannot cover offsets against
 *      incoming POD net BEFORE an author payout releases — the offset's
 *      recovery goes back to FBO first, and only the post-offset remainder
 *      routes through the same taxed cascade every payout rides.
 *
 * Money discipline (the Don invariants): integer cents everywhere; every
 * journal balances; a lock's allocation = reserve + re-parked remainder +
 * zero dust (subtraction model); a release's held amount = offsets back to
 * FBO + per-party cascade + dust, asserted with the zero-balance tripwire;
 * every state transition is replay-guarded (unique constraints as the
 * counted no-op) and concurrency-guarded (CAS / insert-as-lock position
 * arbitration); the drawdown and offset sums are DERIVED from the
 * append-only truth, never a second mutable counter.
 */
import type { Store } from "@/lib/server/store";
import type {
  LedgerTransactionRecord,
  SplitPartyInput,
} from "@/lib/don/types";
import {
  BOOK_RETURNS_RESERVE_MAX_RATE_BPS,
  BOOK_RETURNS_RESERVE_MAX_WINDOW_DAYS,
  BOOK_RETURNS_RESERVE_MIN_RATE_BPS,
  BOOK_RETURNS_RESERVE_MIN_WINDOW_DAYS,
  COMPANY_VARIANCE_PAYEE_ID,
  COMPANY_VARIANCE_PAYEE_NAME,
  UNCLAIMED_HOLDING_PAYEE_ID,
  UNCLAIMED_HOLDING_PAYEE_NAME,
  bookReturnsReservePayeeId,
  bookReturnsReservePayeeName,
} from "@/modules/don/constants";
import {
  allocateWithCompanyDustSweep,
  zeroBalanceHolds,
} from "@/modules/don/dust";
import {
  BOOK_RESERVE_DRAWDOWN_CLASSES,
  type BookReserveDrawdownClass,
  type BookReserveDrawdownRecord,
  type BookReturnChargebackRecord,
  type BookReturnsReservePolicyRecord,
  type CompanyDustRecord,
  type IsbnRightsVerificationRecord,
  type TaxEscrowRecord,
  type WithholdingTaxCreditVerificationRecord,
} from "@/modules/don/records";
import { applyWithholding } from "@/modules/compliance/engine";
import { applyRecoupmentSweep, type RecoupmentSweepOutcome } from "@/modules/recoupment/engine";
import {
  evaluatePayoutCompliance,
  resolveCreatorKycStatus,
  type PublishingComplianceState,
} from "@/modules/compliance/payoutGate";
import { resolvePublishingIpRightsCleared } from "@/modules/compliance/publishingIpRights";
import { postJournal } from "@/modules/ledger/engine";
import {
  bookReturnsReserveCredit,
  bookReturnsReserveDebit,
  fboCredit,
  fboDebit,
  unclaimedHoldingCredit,
  unclaimedHoldingDebit,
  vaultCredit,
  type GlLegInput,
} from "@/modules/ledger/journal";
import { creditVault } from "@/modules/vaults/engine";
import type { VaultCreditTarget } from "@/modules/vaults/balances";
import { isIncomingFrozen } from "@/modules/vaults/dispute";
import { isUniqueViolation } from "@/lib/server/uniqueViolation";
import {
  buildReserveDrawdownPlan,
  buildReserveSplitPlan,
  buildReserveWindowCheck,
  type MerchReserveFailure,
} from "@/lib/server/merchReturnsReserve";
import type { UnclaimedHoldingSource } from "@/lib/server/unclaimedHolding";

/** House failure envelope — the merch cascade / unclaimed-holding shape. */
export type BookLaneFailure = MerchReserveFailure;

// ---------------------------------------------------------------------------
// The foreign-tax-hold scope id — the (country_code, tax_year) key the
// ledger rows carry in split_run_id and the thaw sweep matches on.
// ---------------------------------------------------------------------------

const FOREIGN_TAX_SCOPE_PREFIX = "foreign_tax";

export function foreignTaxHoldScope(countryCode: string, taxYear: number): string {
  return `${FOREIGN_TAX_SCOPE_PREFIX}:${countryCode}:${taxYear}`;
}

/** Normalizes and shape-checks an ISO-3166 alpha-2 country code. */
function normalizeCountryCode(raw: string): string | undefined {
  const code = raw.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : undefined;
}

// ---------------------------------------------------------------------------
// Lane 1 — the foreign print royalty posts STRAIGHT INTO the freeze.
// ---------------------------------------------------------------------------

export type ForeignTaxHoldPostInput = {
  /** The foreign print royalty's identified gross, integer cents. */
  amount_cents: number;
  currency: string;
  /** The sale territory's ISO-3166 alpha-2 country code. */
  country_code: string;
  /** The sale's tax year — the withholding credit is claimed per year. */
  tax_year: number;
  source: UnclaimedHoldingSource;
};

export type ForeignTaxHoldPostSuccess = {
  ok: true;
  value: {
    /** The frozen credit — kind 'unclaimed_holding', status 'foreign_tax_hold'. */
    holding_credit: LedgerTransactionRecord;
    journal_id: string;
    /** The (country, year) scope id the thaw sweep matches on. */
    scope: string;
  };
};

/**
 * Posts one FOREIGN print royalty's gross directly into the foreign-tax
 * freeze. The money's GL leg is the same FBO debit / unclaimed-holding
 * credit an unclaimed-holding post rides (the cash arrived and is held on
 * the platform holding account) — the DISTINCT journal kind is the audit
 * trail: this post froze on arrival, no release path exists but the
 * verified credit.
 */
export async function postForeignPrintRoyaltyToHold(
  store: Store,
  input: ForeignTaxHoldPostInput,
  now: Date = new Date(),
): Promise<ForeignTaxHoldPostSuccess | BookLaneFailure> {
  if (!Number.isSafeInteger(input.amount_cents) || input.amount_cents <= 0) {
    return {
      ok: false,
      status: 422,
      code: "invalid_amount",
      message: "Foreign print royalties post integer cents greater than zero.",
    };
  }
  const countryCode = normalizeCountryCode(input.country_code);
  if (countryCode === undefined) {
    return {
      ok: false,
      status: 422,
      code: "invalid_country_code",
      message: "The foreign-tax hold scope is an ISO-3166 alpha-2 country code.",
    };
  }
  if (!Number.isSafeInteger(input.tax_year) || input.tax_year < 2000 || input.tax_year > 2100) {
    return {
      ok: false,
      status: 422,
      code: "invalid_tax_year",
      message: "The foreign-tax hold scope carries a plausible sale tax year.",
    };
  }

  const scope = foreignTaxHoldScope(countryCode, input.tax_year);
  const source = input.source;
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

  // Replay guard: one frozen post per source id (the journal ref is the
  // marker — the same discipline as the unclaimed-holding post).
  if (sourceRefId !== "") {
    const prior = await store.listGlJournalsByRef(refType, sourceRefId);
    if (prior.length > 0) {
      return {
        ok: false,
        status: 409,
        code: "foreign_tax_hold_already_posted",
        message: `A foreign-tax-hold credit for ${refType} "${sourceRefId}" was already posted (${prior.length} journal(s) ref it).`,
      };
    }
  }

  const createdAt = now.toISOString();
  const credit = await store.insertLedgerTransaction({
    split_run_id: scope,
    // The match_queue-sourced post keeps the quarantined event's row-level
    // recovery linkage exactly as the plain holding post does.
    line_item_id: source.type === "match_queue" ? source.event_id : "",
    payee_id: UNCLAIMED_HOLDING_PAYEE_ID,
    payee_name: UNCLAIMED_HOLDING_PAYEE_NAME,
    role: "other",
    share_bps: 0,
    amount_cents: input.amount_cents,
    currency: input.currency,
    status: "foreign_tax_hold",
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
      kind: "foreign_tax_hold_post",
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
    value: { holding_credit: credit, journal_id: posted.journal.id, scope },
  };
}

// ---------------------------------------------------------------------------
// Lane 2 — the withholding-tax-credit evidence of record.
// ---------------------------------------------------------------------------

export type WithholdingTaxCreditVerificationInput = {
  country_code: string;
  tax_year: number;
  state: WithholdingTaxCreditVerificationRecord["state"];
  /** The treaty of record the credit claims — required for 'verified'. */
  treaty_ref?: string | null;
  /** The credit evidence's provenance — required for 'verified'. */
  evidence_ref?: string | null;
  /** Who verified the evidence — required for 'verified'. */
  verified_by?: string | null;
};

/**
 * Records one withholding-tax-credit verification of record. A 'verified'
 * state REQUIRES the treaty reference, the evidence provenance, and the
 * verifier — the state never lies about the credit. The upsert converges
 * a re-recording (the pending → verified upgrade replaces the row
 * atomically).
 */
export async function recordWithholdingTaxCreditVerification(
  store: Store,
  input: WithholdingTaxCreditVerificationInput,
  now: Date = new Date(),
): Promise<{ ok: true; value: WithholdingTaxCreditVerificationRecord } | BookLaneFailure> {
  const countryCode = normalizeCountryCode(input.country_code);
  if (countryCode === undefined) {
    return {
      ok: false,
      status: 422,
      code: "invalid_country_code",
      message: "The withholding credit's scope is an ISO-3166 alpha-2 country code.",
    };
  }
  if (
    !Number.isSafeInteger(input.tax_year) ||
    input.tax_year < 2000 ||
    input.tax_year > 2100
  ) {
    return {
      ok: false,
      status: 422,
      code: "invalid_tax_year",
      message: "The withholding credit's scope carries a plausible tax year.",
    };
  }
  const treatyRef = input.treaty_ref?.trim() ?? "";
  const evidenceRef = input.evidence_ref?.trim() ?? "";
  const verifiedBy = input.verified_by?.trim() ?? "";
  if (input.state === "verified" && (treatyRef === "" || evidenceRef === "" || verifiedBy === "")) {
    return {
      ok: false,
      status: 422,
      code: "withholding_credit_verification_incomplete",
      message:
        "A verified withholding tax credit carries the treaty reference, the evidence provenance, and the verifier — the state never lies about the credit.",
    };
  }
  const instant = now.toISOString();
  const record = await store.upsertWithholdingTaxCreditVerification({
    country_code: countryCode,
    tax_year: input.tax_year,
    state: input.state,
    treaty_ref: treatyRef === "" ? null : treatyRef,
    evidence_ref: evidenceRef === "" ? null : evidenceRef,
    verified_by: verifiedBy === "" ? null : verifiedBy,
    verified_at: input.state === "verified" ? instant : null,
    created_at: instant,
    updated_at: instant,
  });
  return { ok: true, value: record };
}

// ---------------------------------------------------------------------------
// Lane 3 — the VERIFIED release: the evidence lands, the freeze thaws.
// ---------------------------------------------------------------------------

export type ForeignTaxHoldReleaseInput = {
  country_code: string;
  tax_year: number;
};

export type ForeignTaxHoldReleaseSuccess = {
  ok: true;
  value: {
    /** How many frozen legs returned to the holding state. */
    thawed: number;
    scope: string;
  };
};

/**
 * Releases a territory's foreign-tax freeze — ONLY on verified evidence of
 * record for the exact (country_code, tax_year) scope. Absent, pending,
 * and failed evidence refuse (403, fail-closed — the freeze's ONLY exit is
 * the verified credit). The thaw is the CAS sweep: ONLY the scope's still-
 * frozen legs return to holding, and a re-run is an honest no-op.
 */
export async function releaseForeignTaxHolds(
  store: Store,
  input: ForeignTaxHoldReleaseInput,
): Promise<ForeignTaxHoldReleaseSuccess | BookLaneFailure> {
  const countryCode = normalizeCountryCode(input.country_code);
  if (countryCode === undefined) {
    return {
      ok: false,
      status: 422,
      code: "invalid_country_code",
      message: "The release scope is an ISO-3166 alpha-2 country code.",
    };
  }
  const verification = await store.getWithholdingTaxCreditVerification(
    countryCode,
    input.tax_year,
  );
  if (verification === undefined || verification.state !== "verified") {
    return {
      ok: false,
      status: 403,
      code: "withholding_credit_not_verified",
      message: `No verified withholding tax credit of record exists for ${countryCode} / tax year ${input.tax_year} — the foreign-tax freeze holds (fail-closed).`,
    };
  }
  const scope = foreignTaxHoldScope(countryCode, input.tax_year);
  const thawed = await store.thawForeignTaxHolds(scope);
  return { ok: true, value: { thawed, scope } };
}

// ---------------------------------------------------------------------------
// Lane 4 — the returns-reserve policy of record per ISBN.
// ---------------------------------------------------------------------------

export type BookReturnsReservePolicyInput = {
  isbn: string;
  /** Whole basis points inside the founder band — 1500 (15%) to 2000 (20%). */
  reserve_rate_bps: number;
  /** Whole days inside the founder band — 90 to 120. */
  reserve_window_days: number;
  beneficiary_payee_id: string;
  beneficiary_payee_name: string;
};

/**
 * Registers the returns-reserve policy of record for one ISBN — the
 * founder-banded money terms the lock withholds from and the release
 * reads. The bands are lane-enforced here (and CHECK-enforced at rest):
 * a hostile contract is refused, never clipped.
 */
export async function registerBookReturnsReservePolicy(
  store: Store,
  input: BookReturnsReservePolicyInput,
  now: Date = new Date(),
): Promise<{ ok: true; value: BookReturnsReservePolicyRecord } | BookLaneFailure> {
  const isbn = input.isbn.trim();
  if (isbn === "") {
    return {
      ok: false,
      status: 422,
      code: "invalid_isbn",
      message: "A returns-reserve policy of record names its ISBN.",
    };
  }
  if (
    !Number.isInteger(input.reserve_rate_bps) ||
    input.reserve_rate_bps < BOOK_RETURNS_RESERVE_MIN_RATE_BPS ||
    input.reserve_rate_bps > BOOK_RETURNS_RESERVE_MAX_RATE_BPS
  ) {
    return {
      ok: false,
      status: 422,
      code: "reserve_rate_out_of_band",
      message: `The book returns-reserve rate sits inside the founder band (${BOOK_RETURNS_RESERVE_MIN_RATE_BPS}–${BOOK_RETURNS_RESERVE_MAX_RATE_BPS} bps — ${BOOK_RETURNS_RESERVE_MIN_RATE_BPS / 100}–${BOOK_RETURNS_RESERVE_MAX_RATE_BPS / 100}%).`,
    };
  }
  if (
    !Number.isInteger(input.reserve_window_days) ||
    input.reserve_window_days < BOOK_RETURNS_RESERVE_MIN_WINDOW_DAYS ||
    input.reserve_window_days > BOOK_RETURNS_RESERVE_MAX_WINDOW_DAYS
  ) {
    return {
      ok: false,
      status: 422,
      code: "reserve_window_out_of_band",
      message: `The book returns-reserve window sits inside the founder band (${BOOK_RETURNS_RESERVE_MIN_WINDOW_DAYS}–${BOOK_RETURNS_RESERVE_MAX_WINDOW_DAYS} days).`,
    };
  }
  if (input.beneficiary_payee_id.trim() === "" || input.beneficiary_payee_name.trim() === "") {
    return {
      ok: false,
      status: 422,
      code: "invalid_beneficiary",
      message: "A returns-reserve policy names its beneficiary of record.",
    };
  }
  const instant = now.toISOString();
  const record = await store.upsertBookReturnsReservePolicy({
    isbn,
    reserve_rate_bps: input.reserve_rate_bps,
    reserve_window_days: input.reserve_window_days,
    beneficiary_payee_id: input.beneficiary_payee_id.trim(),
    beneficiary_payee_name: input.beneficiary_payee_name.trim(),
    created_at: instant,
    updated_at: instant,
  });
  return { ok: true, value: record };
}

// ---------------------------------------------------------------------------
// Lane 5 — the reserve lock: a held print net splits into reserve + re-park.
// ---------------------------------------------------------------------------

/** The re-parked credit's scope marker: `book_reserve_lock:{isbn}:{source_id}`. */
const BOOK_LOCK_SCOPE_PREFIX = "book_reserve_lock";

export function bookLockScope(isbn: string, sourceLedgerId: string): string {
  return `${BOOK_LOCK_SCOPE_PREFIX}:${isbn}:${sourceLedgerId}`;
}

function parseBookLockScope(
  scope: string,
): { isbn: string; source_ledger_id: string } | undefined {
  if (!scope.startsWith(`${BOOK_LOCK_SCOPE_PREFIX}:`)) return undefined;
  const rest = scope.slice(BOOK_LOCK_SCOPE_PREFIX.length + 1);
  const separator = rest.indexOf(":");
  if (separator <= 0) return undefined;
  const isbn = rest.slice(0, separator);
  const sourceLedgerId = rest.slice(separator + 1);
  if (isbn === "" || sourceLedgerId === "") return undefined;
  return { isbn, source_ledger_id: sourceLedgerId };
}

export type BookReserveLockInput = {
  /** The held print net's ledger row id (kind+status unclaimed_holding). */
  holding_ledger_id: string;
  /** The title the allocation belongs to — cross-checked against the row's lock linkage. */
  isbn: string;
};

export type BookReserveLockSuccess = {
  ok: true;
  value: {
    /** The locked reserve credit (kind+status book_returns_reserve). */
    reserve_credit: LedgerTransactionRecord;
    /**
     * The net-of-reserve remainder, re-parked in unclaimed holding.
     * Undefined only on a crash-recovery replay that cannot re-derive it
     * (the partial-commit alarm — recon's surface, never a lie).
     */
    reparked_credit: LedgerTransactionRecord | undefined;
    journal_id: string | undefined;
    replayed: boolean;
  };
};

/**
 * Locks one physical print allocation's returns reserve. The policy of
 * record supplies the rate (never the caller); the generalized PR 23
 * planner splits the held net inside the book's founder band; the CAS
 * consumes the held credit BEFORE any child row commits (insert-as-lock —
 * the concurrent loser reads undefined and refuses); the reserve share
 * locks as a `book_returns_reserve` credit under the ISBN's sentinel
 * payee and the remainder re-parks in unclaimed holding with the lock
 * linkage in its scope. The dispatch journal balances:
 * allocation = reserve + re-parked remainder (dust structurally zero).
 */
export async function lockBookReturnsReserve(
  store: Store,
  input: BookReserveLockInput,
  now: Date = new Date(),
): Promise<BookReserveLockSuccess | BookLaneFailure> {
  const isbn = input.isbn.trim();
  if (isbn === "") {
    return {
      ok: false,
      status: 422,
      code: "invalid_isbn",
      message: "A reserve lock names the ISBN it locks for.",
    };
  }
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
      message: `Ledger transaction ${row.id} is kind "${row.kind}" — only held print nets lock a reserve here.`,
    };
  }
  // Crash-recovery replay: a lock that committed its children but died
  // before (or around) the journal reads back as the counted no-op — the
  // reserve credit's split_run_id linkage IS the marker. The re-parked
  // remainder re-derives from the same linkage; a partial commit surfaces
  // as undefined (the alarm), never as a fabricated row.
  const existing = (await store.listBookReturnsReserveCreditsByIsbn(isbn)).find(
    (credit) => credit.split_run_id === row.id,
  );
  if (existing !== undefined) {
    let reparked: LedgerTransactionRecord | undefined;
    if (row.line_item_id !== "") {
      const linked = await store.listLedgerTransactionsByLineItem(row.line_item_id);
      reparked = linked.find(
        (candidate) =>
          candidate.kind === "unclaimed_holding" &&
          candidate.status === "unclaimed_holding" &&
          candidate.split_run_id === bookLockScope(isbn, row.id),
      );
    }
    return {
      ok: true,
      value: {
        reserve_credit: existing,
        reparked_credit: reparked,
        journal_id: undefined,
        replayed: true,
      },
    };
  }
  if (row.status === "foreign_tax_hold") {
    // The freeze holds here too — a frozen foreign royalty is not raw
    // material for a reserve lock; only the verified credit thaw exits.
    return {
      ok: false,
      status: 403,
      code: "foreign_tax_hold",
      message: `Holding credit ${row.id} is frozen in foreign_tax_hold — verified withholding tax credit evidence has not landed.`,
    };
  }
  if (row.status !== "unclaimed_holding") {
    return {
      ok: false,
      status: 409,
      code: "holding_already_released",
      message: `Holding credit ${row.id} is no longer held (status "${row.status}") — a concurrent lane consumed it.`,
    };
  }

  // The policy of record — the rate comes from the registry, never the
  // caller. No policy, no lock: fail-closed.
  const policy = await store.getBookReturnsReservePolicy(isbn);
  if (policy === undefined) {
    return {
      ok: false,
      status: 422,
      code: "missing_book_returns_reserve_policy",
      message: `No returns-reserve policy of record exists for ISBN "${isbn}" — register the title's protection terms before locking its reserves.`,
    };
  }
  const planned = buildReserveSplitPlan({
    allocation_cents: row.amount_cents,
    reserve_rate_bps: policy.reserve_rate_bps,
    min_rate_bps: BOOK_RETURNS_RESERVE_MIN_RATE_BPS,
    max_rate_bps: BOOK_RETURNS_RESERVE_MAX_RATE_BPS,
  });
  if (!planned.ok) return planned;

  const instant = now.toISOString();

  // The CAS wins BEFORE any child commits (insert-as-lock): the concurrent
  // lock/release loser reads undefined here and refuses.
  const settled = await store.settleUnclaimedHolding(row.id, instant);
  if (settled === undefined) {
    return {
      ok: false,
      status: 409,
      code: "holding_already_released",
      message: `Holding credit ${row.id} is no longer held — a concurrent lane won.`,
    };
  }

  const reserveCredit = await store.insertLedgerTransaction({
    split_run_id: row.id,
    line_item_id: row.line_item_id,
    payee_id: bookReturnsReservePayeeId(isbn),
    payee_name: bookReturnsReservePayeeName(isbn),
    role: "other",
    share_bps: 0,
    amount_cents: planned.value.reserve_cents,
    currency: row.currency,
    status: "book_returns_reserve",
    rail: null,
    baas_provider: null,
    baas_transfer_id: null,
    created_at: instant,
    settled_at: null,
    kind: "book_returns_reserve",
  });
  const reparkedCredit = await store.insertLedgerTransaction({
    split_run_id: bookLockScope(isbn, row.id),
    line_item_id: row.line_item_id,
    payee_id: UNCLAIMED_HOLDING_PAYEE_ID,
    payee_name: UNCLAIMED_HOLDING_PAYEE_NAME,
    role: "other",
    share_bps: 0,
    amount_cents: planned.value.dispatch_cents,
    currency: row.currency,
    status: "unclaimed_holding",
    rail: null,
    baas_provider: null,
    baas_transfer_id: null,
    created_at: instant,
    settled_at: null,
    kind: "unclaimed_holding",
  });

  const posted = await postJournal(
    store,
    {
      kind: "book_reserve_dispatch",
      ref_type: "ledger_transaction",
      ref_id: row.id,
      legs: [
        unclaimedHoldingDebit(row.amount_cents),
        bookReturnsReserveCredit(isbn, planned.value.reserve_cents),
        unclaimedHoldingCredit(planned.value.dispatch_cents),
      ],
    },
    now,
  );
  if (!posted.ok) {
    return { ok: false, status: 500, code: posted.code, message: posted.message };
  }
  return {
    ok: true,
    value: {
      reserve_credit: reserveCredit,
      reparked_credit: reparkedCredit,
      journal_id: posted.journal.id,
      replayed: false,
    },
  };
}

// ---------------------------------------------------------------------------
// Lane 6 — the publisher return / chargeback: reserves first, offset later.
// ---------------------------------------------------------------------------

export type BookReserveDrawdownInput = {
  isbn: string;
  /** The return/chargeback event's content-derived id — the replay guard. */
  event_id: string;
  drawdown_class: BookReserveDrawdownClass;
  chargeback_cents: number;
  currency: string;
};

export type BookReserveDrawdownOutcome = {
  drawdown: BookReserveDrawdownRecord;
  reserve_ledger_id: string;
};

export type BookReserveDrawdownSuccess = {
  ok: true;
  value: {
    chargeback: BookReturnChargebackRecord;
    /** The event's total recovery taken from held reserves THIS call. */
    drawn_cents: number;
    outcomes: BookReserveDrawdownOutcome[];
    /** True when the event of record already existed — the counted no-op. */
    replayed: boolean;
    /** What the event still owes after reserves — the POD-net offset's input. */
    outstanding_cents: number;
  };
};

/**
 * Records one publisher return or payment chargeback against an ISBN and
 * recovers it from the title's held reserves, FIFO (oldest reserve first).
 * The obligation re-derives from the append-only truth at every entry —
 * a re-shipped event is the counted no-op, and a partially-processed
 * event's retry recovers exactly the still-outstanding remainder. Each
 * per-reserve drawdown is position-locked (the merch discipline: the
 * unique violation re-derives, never double-draws), a full draw settles
 * the reserve through the CAS first, and every draw's money leaves the
 * reserve back to FBO cash (the publisher's refund) under its own
 * balanced journal. A chargeback the reserves cannot fully cover stays
 * outstanding — the POD-net offset recovers the remainder at release.
 */
export async function drawDownBookReturnChargeback(
  store: Store,
  input: BookReserveDrawdownInput,
  now: Date = new Date(),
): Promise<BookReserveDrawdownSuccess | BookLaneFailure> {
  const isbn = input.isbn.trim();
  const eventId = input.event_id.trim();
  if (isbn === "" || eventId === "") {
    return {
      ok: false,
      status: 422,
      code: "invalid_chargeback_identity",
      message: "A return chargeback of record names its ISBN and carries its event id.",
    };
  }
  if (!BOOK_RESERVE_DRAWDOWN_CLASSES.includes(input.drawdown_class)) {
    return {
      ok: false,
      status: 422,
      code: "invalid_drawdown_class",
      message: `A book reserve drawdown is a "${BOOK_RESERVE_DRAWDOWN_CLASSES.join('" or "')}" event.`,
    };
  }
  if (!Number.isSafeInteger(input.chargeback_cents) || input.chargeback_cents <= 0) {
    return {
      ok: false,
      status: 422,
      code: "invalid_chargeback_amount",
      message: "A return chargeback is whole positive cents.",
    };
  }

  // The chargeback of record — UNIQUE on event_id: the re-shipped event's
  // insert throws, the read-back answers the counted no-op.
  const instant = now.toISOString();
  let chargeback: BookReturnChargebackRecord;
  try {
    chargeback = await store.insertBookReturnChargeback({
      event_id: eventId,
      isbn,
      chargeback_class: input.drawdown_class,
      chargeback_cents: input.chargeback_cents,
      currency: input.currency,
      created_at: instant,
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      const all = await store.listBookReturnChargebacksByIsbn(isbn);
      const existing = all.find((row) => row.event_id === eventId);
      if (existing !== undefined) {
        return {
          ok: true,
          value: {
            chargeback: existing,
            drawn_cents: 0,
            outcomes: [],
            replayed: true,
            outstanding_cents: await bookChargebackOutstandingCents(store, existing, isbn),
          },
        };
      }
    }
    throw error;
  }

  // FIFO across the title's held reserves — the re-derived outstanding
  // obligation caps the recovery (a retried event recovers only what is
  // still missing, never twice).
  let obligation = await bookChargebackOutstandingCents(store, chargeback, isbn);
  const outcomes: BookReserveDrawdownOutcome[] = [];
  let drawnTotal = 0;

  const reserves = await store.listBookReturnsReserveCreditsByIsbn(isbn);
  for (const reserve of reserves) {
    if (obligation <= 0) break;
    if (reserve.status !== "book_returns_reserve") continue;
    const drawdowns = await store.listBookReserveDrawdowns(reserve.id);
    // One event draws at most once per reserve — the UNIQUE
    // (reserve_ledger_id, source_event_id) contract. A reserve this event
    // already drew from is history for this event, not capacity.
    if (drawdowns.some((line) => line.source_event_id === eventId)) continue;
    const drawnBefore = drawdowns.reduce((total, line) => total + line.drawn_cents, 0);
    const remaining = reserve.amount_cents - drawnBefore;
    if (remaining <= 0) continue;
    const draw = Math.min(remaining, obligation);
    const planned = buildReserveDrawdownPlan({
      drawdown_class: input.drawdown_class,
      source_event_id: eventId,
      drawn_before_cents: drawnBefore,
      drawn_cents: draw,
      remaining_cents: remaining,
      drawdown_classes: BOOK_RESERVE_DRAWDOWN_CLASSES,
    });
    if (!planned.ok) return planned;

    // A draw that consumes the LAST cent settles the reserve FIRST (the
    // CAS arbitrates against a concurrent release BEFORE anything
    // commits — the winner is the only lane that touches the reserve).
    const fullyDrawn = planned.value.remaining_cents === 0;
    if (fullyDrawn) {
      const settled = await store.settleBookReturnsReserve(reserve.id, instant);
      if (settled === undefined) {
        // A concurrent release won this reserve — it is no longer
        // capacity. The obligation stays outstanding; the next reserve
        // (or the POD-net offset) recovers it.
        continue;
      }
    }

    let drawdown: BookReserveDrawdownRecord;
    try {
      drawdown = await store.insertBookReserveDrawdown({
        reserve_ledger_id: reserve.id,
        drawdown_class: input.drawdown_class,
        source_event_id: eventId,
        drawn_before_cents: planned.value.drawn_before_cents,
        drawn_cents: planned.value.drawn_cents,
        remaining_cents: planned.value.remaining_cents,
        created_at: instant,
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        // The position lock or the per-event uniqueness fired — re-derive
        // from the fresh truth: the event's row here means this reserve
        // already drew for this event (skip); anything else is a position
        // race and the NEXT reserve (or the offset) carries the recovery.
        const fresh = await store.listBookReserveDrawdowns(reserve.id);
        if (fresh.some((line) => line.source_event_id === eventId)) continue;
        continue;
      }
      throw error;
    }

    // The held-state re-check AFTER the position commit: money never
    // leaves a settled reserve (the merch discipline verbatim).
    if (!fullyDrawn) {
      const rechecked = await store.getLedgerTransaction(reserve.id);
      if (rechecked === undefined || rechecked.status !== "book_returns_reserve") {
        continue;
      }
    }

    const posted = await postJournal(store, {
      kind: "book_reserve_drawdown",
      ref_type: "ledger_transaction",
      ref_id: reserve.id,
      legs: [
        bookReturnsReserveDebit(isbn, planned.value.drawn_cents),
        fboCredit(planned.value.drawn_cents),
      ],
    });
    if (!posted.ok) {
      return { ok: false, status: 500, code: posted.code, message: posted.message };
    }
    outcomes.push({ drawdown, reserve_ledger_id: reserve.id });
    drawnTotal += planned.value.drawn_cents;
    obligation -= planned.value.drawn_cents;
  }

  return {
    ok: true,
    value: {
      chargeback,
      drawn_cents: drawnTotal,
      outcomes,
      // The re-delivered event returned in the catch above — this line is
      // always a first delivery.
      replayed: false,
      outstanding_cents: obligation,
    },
  };
}

/** One chargeback's outstanding recovery — derived, never a counter. */
async function bookChargebackOutstandingCents(
  store: Store,
  chargeback: BookReturnChargebackRecord,
  isbn: string,
): Promise<number> {
  const reserves = await store.listBookReturnsReserveCreditsByIsbn(isbn);
  let recovered = 0;
  for (const reserve of reserves) {
    const drawdowns = await store.listBookReserveDrawdowns(reserve.id);
    for (const line of drawdowns) {
      if (line.source_event_id === chargeback.event_id) recovered += line.drawn_cents;
    }
  }
  const applications = await store.listBookChargebackOffsetApplications(chargeback.id);
  for (const application of applications) recovered += application.applied_cents;
  return Math.max(chargeback.chargeback_cents - recovered, 0);
}

// ---------------------------------------------------------------------------
// Lane 7 — the publishing payout gate's DERIVED state (fail-closed).
// ---------------------------------------------------------------------------

export type PublishingGateState = {
  /** The policy of record exists for the ISBN. */
  policy_present: boolean;
  /** The earliest reserve's founder-banded window has fully elapsed. */
  return_reserve_period_elapsed: boolean;
  /** The ISBN's rights chain of record is verified. */
  isbn_rights_verified: boolean;
  /** The derivation's inputs — the test and audit surface. */
  earliest_reserve_created_at: string | null;
  window_days: number | null;
};

/**
 * Derives the publishing payout gate's states of record for one ISBN —
 * DERIVED from durable sources, never caller-stated:
 *
 *   - `return_reserve_period_elapsed`: the ISBN has a policy of record
 *     AND a reserve-credit history, and the EARLIEST reserve credit
 *     (any state — a settled reserve still proves its period ran) has
 *     aged through the policy's full founder-banded window. Absent
 *     policy or history stays false, fail-closed.
 *   - `isbn_rights_verified`: the durable rights record exists and reads
 *     exactly 'verified'. Absent, pending, and failed all refuse.
 */
export async function resolvePublishingGateState(
  store: Store,
  input: { isbn: string; now: Date },
): Promise<PublishingGateState> {
  const isbn = input.isbn.trim();
  const policy = await store.getBookReturnsReservePolicy(isbn);
  if (policy === undefined) {
    return {
      policy_present: false,
      return_reserve_period_elapsed: false,
      isbn_rights_verified: false,
      earliest_reserve_created_at: null,
      window_days: null,
    };
  }
  const history = await store.listBookReturnsReserveCreditsByIsbn(isbn);
  const earliest = history.length > 0 ? history[0] : undefined;
  let elapsed = false;
  if (earliest !== undefined) {
    const windowChecked = buildReserveWindowCheck({
      created_at: earliest.created_at,
      window_days: policy.reserve_window_days,
      now: input.now,
      min_window_days: BOOK_RETURNS_RESERVE_MIN_WINDOW_DAYS,
      max_window_days: BOOK_RETURNS_RESERVE_MAX_WINDOW_DAYS,
    });
    elapsed = windowChecked.ok;
  }
  const rights: IsbnRightsVerificationRecord | undefined =
    await store.getIsbnRightsVerification(isbn);
  return {
    policy_present: true,
    return_reserve_period_elapsed: elapsed,
    isbn_rights_verified: rights?.state === "verified",
    earliest_reserve_created_at: earliest?.created_at ?? null,
    window_days: policy.reserve_window_days,
  };
}

// ---------------------------------------------------------------------------
// Lane 8 — the author payout release: gate, offsets first, taxed cascade.
// ---------------------------------------------------------------------------

export type BookPrintNetReleaseInput = {
  /** The re-parked (locked) print net's ledger row id. */
  holding_ledger_id: string;
  /** The title — cross-checked against the row's lock linkage. */
  isbn: string;
  /**
   * The VERIFIED author allocation — shares must sum to 10000 bps over the
   * POST-OFFSET remainder (the sweep's dust routes to the platform payee).
   */
  splits: SplitPartyInput[];
  /** The clearance gate's first condition — fail-closed on anything but true. */
  operator_settlement_approved: boolean;
};

export type BookPrintNetReleaseSuccess = {
  ok: true;
  value: {
    /** The settled row — status 'settled', kind still 'unclaimed_holding'. */
    holding_credit: LedgerTransactionRecord;
    /** The publisher's recovery taken out of THIS allocation. */
    offset_cents: number;
    /** The chargeback ids this release recovered against, oldest first. */
    offset_chargeback_ids: string[];
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
    journal_id: string;
  };
};

/** Position-lock retries before the release re-derives fail-closed. */
const OFFSET_POSITION_RETRIES = 3;

/**
 * Releases one locked print net's author payout — the fail-closed chain:
 *
 *   1. the row is a HELD holding credit carrying THIS title's lock linkage
 *      (the scope the lock lane stamped — a mismatched ISBN refuses),
 *   2. the publishing gate's derived states hold: the reserve window has
 *      elapsed and the ISBN rights are verified (each false refuses 403),
 *   3. every credited payee passes the SAME fail-closed payout gate with
 *      the publishing vertical's DERIVED state (IP rights per payee/work),
 *   4. the CAS wins (the concurrent loser reads undefined and refuses),
 *   5. the outstanding chargeback offsets consume their recovery FIRST —
 *      position-locked applications of record, the recovery back to FBO
 *      cash — and the post-offset remainder routes through the same taxed
 *      cascade every payout rides (withholding escrow, recoupment sweep,
 *      guarded vault credits, dust), under one balanced
 *      `book_print_net_release` journal.
 */
export async function releaseBookPrintNet(
  store: Store,
  input: BookPrintNetReleaseInput,
  now: Date = new Date(),
): Promise<BookPrintNetReleaseSuccess | BookLaneFailure> {
  const isbn = input.isbn.trim();
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
      message: `Ledger transaction ${row.id} is kind "${row.kind}" — only locked book print nets release here.`,
    };
  }
  if (row.status === "foreign_tax_hold") {
    // The freeze holds here too — a frozen foreign royalty never releases
    // through ANY lane but the verified credit thaw (fail-closed).
    return {
      ok: false,
      status: 403,
      code: "foreign_tax_hold",
      message: `Holding credit ${row.id} is frozen in foreign_tax_hold — verified withholding tax credit evidence has not landed.`,
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
  // The lock linkage IS the ISBN cross-check — the release trusts the
  // linkage the lock lane stamped, never the caller's say-so alone.
  const linkage = parseBookLockScope(row.split_run_id);
  if (linkage === undefined) {
    return {
      ok: false,
      status: 422,
      code: "not_a_locked_book_net",
      message: `Holding credit ${row.id} never locked a returns reserve — route physical print nets through the lock lane first.`,
    };
  }
  if (isbn === "" || linkage.isbn !== isbn) {
    return {
      ok: false,
      status: 422,
      code: "isbn_linkage_mismatch",
      message: `Holding credit ${row.id} is locked for ISBN "${linkage.isbn}", not "${input.isbn}".`,
    };
  }

  // THE GATE — derived from the durable sources, fail-closed on every
  // absent path, evaluated BEFORE the CAS (nothing moves on a refusal).
  const gate = await resolvePublishingGateState(store, { isbn, now });
  if (!gate.return_reserve_period_elapsed) {
    return {
      ok: false,
      status: 403,
      code: "return_reserve_period_not_elapsed",
      message: `ISBN "${isbn}" has no returns-reserve history that has aged through its policy window${gate.window_days === null ? "" : ` (${gate.window_days} days)`} — the author payout holds (fail-closed).`,
    };
  }
  if (!gate.isbn_rights_verified) {
    return {
      ok: false,
      status: 403,
      code: "isbn_rights_not_verified",
      message: `ISBN "${isbn}" has no verified rights chain of record — the author payout holds (fail-closed).`,
    };
  }

  // The outstanding-chargeback ledger — the offset's input, FIFO oldest
  // first. Derived from the append-only truth at every entry. This plan is
  // an ESTIMATE: the committed truth re-derives under the apply loop below
  // (a concurrent release can recover a chargeback between here and the
  // inserts), so the payout base and allocation wait for the committed
  // offset total.
  const chargebacks = await store.listBookReturnChargebacksByIsbn(isbn);
  const offsetPlan: Array<{
    chargeback: BookReturnChargebackRecord;
    offset_before_cents: number;
    applied_cents: number;
    remaining_cents: number;
  }> = [];
  for (const chargeback of chargebacks) {
    const capacity = row.amount_cents - offsetPlan.reduce((t, p) => t + p.applied_cents, 0);
    if (capacity <= 0) break;
    const outstanding = await bookChargebackOutstandingCents(store, chargeback, isbn);
    if (outstanding <= 0) continue;
    const applied = Math.min(outstanding, capacity);
    offsetPlan.push({
      chargeback,
      offset_before_cents: chargeback.chargeback_cents - outstanding,
      applied_cents: applied,
      remaining_cents: outstanding - applied,
    });
  }

  // The gate family — every credited payee passes the SAME fail-closed
  // payout gate with the publishing vertical's DERIVED state (the
  // per-payee IP-rights half resolves payee × work; the window and ISBN
  // halves are the title-level derivations above).
  for (const party of input.splits) {
    if (party.payee_id === COMPANY_VARIANCE_PAYEE_ID) continue;
    const kycStatus = await resolveCreatorKycStatus(store, party.payee_id);
    const verticalState: PublishingComplianceState = {
      vertical: "publishing",
      ip_rights_cleared: await resolvePublishingIpRightsCleared(
        store,
        party.payee_id,
        isbn,
      ),
      return_reserve_period_elapsed: gate.return_reserve_period_elapsed,
      isbn_rights_verified: gate.isbn_rights_verified,
    };
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
        message: `Print net release refused for payee "${party.payee_id}": ${compliance.message}`,
      };
    }
  }

  // Input validation BEFORE the CAS — nothing moves on a malformed split
  // set. The committed allocation re-derives after the offsets apply (the
  // plan is an estimate), so only shape is checked here.
  if (!allocateWithCompanyDustSweep(row.amount_cents, input.splits).ok) {
    return {
      ok: false,
      status: 422,
      code: "splits_do_not_balance",
      message: "Party shares must sum to 10000 bps (100%).",
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

  // The CAS wins BEFORE anything moves (insert-as-lock).
  const instant = now.toISOString();
  const settled = await store.settleUnclaimedHolding(row.id, instant);
  if (settled === undefined) {
    return {
      ok: false,
      status: 409,
      code: "holding_already_released",
      message: `Holding credit ${row.id} is no longer held — a concurrent release won.`,
    };
  }

  // The offsets commit — position-locked applications of record. A lost
  // position race re-derives from the fresh truth (bounded retries): the
  // winner's application moved the chargeback's recovered position, and
  // the loser's next derivation reads it. offsetTotal accumulates what
  // actually COMMITTED (insert + counted no-op); a chargeback fully
  // recovered by a concurrent release is skipped without counting — its
  // cents stay in the payout base.
  const offsetChargebackIds: string[] = [];
  let offsetTotal = 0;
  for (const plan of offsetPlan) {
    for (let attempt = 0; attempt < OFFSET_POSITION_RETRIES; attempt += 1) {
      try {
        await store.insertBookChargebackOffsetApplication({
          chargeback_id: plan.chargeback.id,
          holding_ledger_id: row.id,
          offset_before_cents: plan.offset_before_cents,
          applied_cents: plan.applied_cents,
          remaining_cents: plan.remaining_cents,
          created_at: instant,
        });
        offsetChargebackIds.push(plan.chargeback.id);
        offsetTotal += plan.applied_cents;
        break;
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        const all = await store.listBookChargebackOffsetApplications(plan.chargeback.id);
        if (all.some((a) => a.holding_ledger_id === row.id)) {
          // This release already applied for this chargeback (the crash
          // window's counted no-op) — the cents moved; keep the recovery
          // honest by counting them.
          offsetChargebackIds.push(plan.chargeback.id);
          offsetTotal += plan.applied_cents;
          break;
        }
        if (attempt === OFFSET_POSITION_RETRIES - 1) {
          return {
            ok: false,
            status: 409,
            code: "offset_position_contended",
            message: `Chargeback ${plan.chargeback.id}'s offset position stayed contended after ${OFFSET_POSITION_RETRIES} derivations — release refused (nothing further moved).`,
          };
        }
        // Re-derive the plan from the fresh truth and try again.
        const outstanding = await bookChargebackOutstandingCents(store, plan.chargeback, isbn);
        if (outstanding <= 0) break;
        plan.offset_before_cents = plan.chargeback.chargeback_cents - outstanding;
        plan.applied_cents = Math.min(outstanding, plan.applied_cents);
        plan.remaining_cents = outstanding - plan.applied_cents;
      }
    }
  }

  // The committed allocation — the payout base reads the offset total that
  // actually committed, not the pre-CAS estimate. Allocator refusals here
  // are programmer-error paranoia (shape was validated pre-CAS; the dust
  // is the allocator's own remainder) and leave the replayable counted
  // no-op, never a fabricated release.
  const payoutBase = row.amount_cents - offsetTotal;
  let allocation:
    | Extract<ReturnType<typeof allocateWithCompanyDustSweep>, { ok: true }>
    | undefined;
  if (payoutBase > 0) {
    const planned = allocateWithCompanyDustSweep(payoutBase, input.splits);
    if (!planned.ok) {
      return {
        ok: false,
        status: 500,
        code: "zero_balance_violation",
        message: planned.message,
      };
    }
    if (!zeroBalanceHolds(payoutBase, planned.splits, planned.company_dust_cents)) {
      return {
        ok: false,
        status: 500,
        code: "zero_balance_violation",
        message:
          "sum(verified allocations) + company_dust !== post-offset remainder — release refused.",
      };
    }
    allocation = planned;
  }

  // The taxed cascade — the unclaimed-holding release's per-party
  // sequence, ledger for ledger and leg for leg, over the POST-OFFSET
  // remainder. Every branch conserves its cents.
  const glLegs: GlLegInput[] = [
    unclaimedHoldingDebit(row.amount_cents),
  ];
  if (offsetTotal > 0) {
    // The publisher's recovery goes back to FBO cash first.
    glLegs.push(fboCredit(offsetTotal));
  }
  const withholding: TaxEscrowRecord[] = [];
  const recoupment: Array<RecoupmentSweepOutcome & { payee_id: string }> = [];
  const dustLedger: CompanyDustRecord[] = [];
  const partyCredits: BookPrintNetReleaseSuccess["value"]["party_credits"] = [];

  if (allocation !== undefined) {
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
      const incomingFrozen = await isIncomingFrozen(store, party.payee_id, "");
      const excessBucket: VaultCreditTarget = incomingFrozen ? "reserve" : "available";
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
            vaultCredit(COMPANY_VARIANCE_PAYEE_ID, "available", recouped.recouped_cents),
          );
        }
        if (recouped.excess_cents > 0) {
          glLegs.push(vaultCredit(party.payee_id, excessBucket, recouped.excess_cents));
        }
      } else if (incomingFrozen && creditAmount > 0) {
        await creditVault(store, party.payee_id, party.payee_name, creditAmount, "reserve", now);
        glLegs.push(vaultCredit(party.payee_id, "reserve", creditAmount));
      } else if (creditAmount > 0) {
        await creditVault(store, party.payee_id, party.payee_name, creditAmount, "pending", now);
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
          created_at: instant,
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
        vaultCredit(COMPANY_VARIANCE_PAYEE_ID, "pending", allocation.company_dust_cents),
      );
    }
  }

  // The zero-balance tripwire: offsets to FBO + party allocations + dust
  // === the held amount, ALWAYS (the Don invariant with the offset inside
  // it — the publisher got recovered OR the author got paid; never both,
  // never neither).
  const allocatedSum = partyCredits.reduce((total, credit) => total + credit.gross_cents, 0);
  const dustTotal = allocation?.company_dust_cents ?? 0;
  if (offsetTotal + allocatedSum + dustTotal !== row.amount_cents) {
    return {
      ok: false,
      status: 500,
      code: "zero_balance_violation",
      message:
        "Offsets to FBO + author allocations + dust !== held print net — release refused.",
    };
  }

  const posted = await postJournal(
    store,
    {
      kind: "book_print_net_release",
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
      offset_cents: offsetTotal,
      offset_chargeback_ids: offsetChargebackIds,
      party_credits: partyCredits,
      company_dust_cents: dustTotal,
      withholding,
      recoupment,
      journal_id: posted.journal.id,
    },
  };
}
