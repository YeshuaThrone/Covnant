// Gaming cashout ledger states — PR 13 (founder gaming directive).
//
// Money received from a game platform LOCKS in VIRTUAL_CURRENCY_CASHOUT_PENDING:
// ledger rows with kind and status 'virtual_currency_cashout_pending' that
// stay out of every payee vault, out of the unclaimed holding bucket, and
// out of the film escrow, until Astra cross-references the platform payout
// batch against the verified studio contracts and the store statements AND
// the batch's virtual-currency conversion logs have all reached
// 'fiat_settled' (the platform's fiat settlement completed). The lock is
// PER-PLATFORM — payee `gaming_cashout:{platform}`, GL account
// `gaming_cashout:{platform}` (the vault-account convention of carrying the
// business key in the account string, the film escrow precedent) — because
// the payout batches, the DevEx conversion logs, and the cross-reference
// are all per-platform program. The state is distinct from 'platform', from
// the unclaimed holding sentinel, and from the film escrow, in payee, GL
// account, and ledger kind: no query can fold one into another.
//
// THE CONVERSION LOGS are the durable DevEx audit trail (the founder's
// rate-logging rule, made state): one log per funding line — denomination,
// exact virtual amount, applied exchange rate, integer-cent fiat net,
// settlement batch reference, and a fiat-settlement status that holds at
// 'pending_fiat_settlement' until the platform's fiat settlement completes.
// A batch releases only when its logs EXIST (completeness) and are ALL
// settled. UNIQUE on a content-derived event id (`gaming:devex:<line event
// id>`) makes the write a counted no-op under replay — the PR 12
// accumulator's insert-as-lock discipline.
//
// STUDIO TEAM KYC is the studio-level compliance record the gaming payout
// gate reads: the studio's own verified status PLUS every named team
// member's identity check (3D artist, developer, sound designer, ...). The
// gate refuses on an absent record, an unverified studio, a failed or
// unknown member check — fail-closed, no state is never assumed verified.
//
// NO MIGRATION for the LEDGER state itself: ledger_transactions.status/kind
// are free text columns (migration 0006 places no check constraint on
// either) — the PR 7/PR 9 precedent. Migration 0019 is additive-only for
// the two NEW tables (conversion logs + studio KYC verifications); it never
// touches an existing migration folder.
//
// THE FOUR MOVES:
//
//   postToGamingCashoutPending — a game platform's payout batch (recon
//                         match-queue event or manual): integer-cent credit
//                         into the platform's cashout-pending hold, replay-
//                         guarded per source (journal per source id, 409 on
//                         re-post), balanced gaming_cashout_post journal
//                         (FBO debit leg). When the line carries DevEx
//                         conversion facts, the durable conversion log
//                         writes in the same pass (idempotent per funding
//                         line). Nothing moves after this until the
//                         cross-reference verifies and the fiat settles —
//                         the cashout-pending lock is the point.
//
//   ingestGamingDevexConversionLog — the durable conversion-log writer,
//                         standalone for the recon ingest. Content-derived
//                         event id; replay returns the existing row with
//                         counted: false; a concurrent insert between the
//                         read and the write re-reads the winner (never
//                         swallows the unique violation).
//
//   settleGamingDevexBatchFiat — the platform's fiat settlement completed:
//                         flips EVERY 'pending_fiat_settlement' log of one
//                         payout batch to 'fiat_settled' and returns the
//                         count flipped. Already-settled rows are untouched.
//
//   releaseGamingCashout — the verified release. Fail-closed gates, in
//                         order: the row must be a LOCKED cashout receipt
//                         (404 / 422 / 409 otherwise), the cross-reference
//                         evidence must be present (verified studio contract
//                         ref AND at least one verified store statement ref
//                         — 422 before either exists), the payout batch's
//                         conversion logs must exist and ALL be fiat-settled
//                         (422 otherwise — completeness), every credited
//                         creator must pass the SAME fail-closed payout
//                         compliance gate as a Lithic dispatch (operator
//                         settlement approval, verified KYC, the gaming
//                         vertical's studio/team state), and the CAS flip
//                         must win (the concurrent loser gets undefined and
//                         a 409). THEN the routing: creator credits through
//                         the clearance-gated creator-credit sequence
//                         (withholding, recoupment sweep, guarded vault
//                         credits), the integer-cent remainder swept to the
//                         company variance payee. Insert-as-lock ordering
//                         (the PR 7/PR 9 precedent): the CAS flips BEFORE
//                         any vault credit, so a crash mid-release fails
//                         toward "nothing moved twice".

import type { Store } from "@/lib/server/store";
import type { LedgerTransactionRecord, SplitPartyInput } from "@/lib/don/types";
import {
  COMPANY_VARIANCE_PAYEE_ID,
  COMPANY_VARIANCE_PAYEE_NAME,
  gamingCashoutPayeeId,
  gamingCashoutPayeeName,
} from "@/modules/don/constants";
import { zeroBalanceHolds } from "@/modules/don/dust";
import { applyWithholding } from "@/modules/compliance/engine";
import {
  evaluatePayoutCompliance,
  getVerticalComplianceStateSource,
  resolveCreatorKycStatus,
} from "@/modules/compliance/payoutGate";
import { applyRecoupmentSweep, type RecoupmentSweepOutcome } from "@/modules/recoupment/engine";
import { postJournal } from "@/modules/ledger/engine";
import {
  fboDebit,
  gamingCashoutCredit,
  gamingCashoutDebit,
  vaultCredit,
  type GlLegInput,
} from "@/modules/ledger/journal";
import { isUniqueViolation } from "@/lib/server/uniqueViolation";
import type {
  CompanyDustRecord,
  GamingDevexConversionLogRecord,
  TaxEscrowRecord,
} from "@/modules/don/records";
import { creditVault } from "@/modules/vaults/engine";
import { isIncomingFrozen } from "@/modules/vaults/dispute";
import type { VaultCreditTarget } from "@/modules/vaults/balances";

/** House failure envelope — the filmEscrow shape. */
export type GamingCashoutFailure = {
  ok: false;
  status: number;
  code: string;
  message: string;
};

/**
 * Where the locked payout batch arrived from — the recovery linkage. The GL
 * post-journal carries this as its ref (ref_type/ref_id), and a
 * match_queue-sourced receipt ALSO stamps the quarantined statement line's
 * event_id into line_item_id (the film escrow precedent).
 */
export type GamingReceiptSource =
  | { type: "match_queue"; event_id: string }
  | { type: "recon_job"; job_id: string }
  | { type: "manual"; note: string };

/**
 * The DevEx conversion facts one funding line carries — the founder's
 * rate-logging rule. Amounts are exact decimal TEXT (never a float); the
 * fiat net is the locked receipt's own integer cents.
 */
export interface GamingDevexConversionFacts {
  /** The funding line the conversion came from (the match_queue event id). */
  line_event_id: string;
  /** The virtual-currency denomination ('Robux' on Roblox DevEx rows). */
  denomination: string;
  /** Exact virtual amount as decimal text — never a float. */
  virtual_amount: string;
  /** The applied fiat-per-virtual-unit exchange rate, exact decimal text. */
  exchange_rate: string;
  /** The platform payout batch the conversion rides. */
  settlement_batch_ref: string;
}

export interface GamingCashoutPostInput {
  /** The game platform the payout batch came from — the lock's key. */
  platform: string;
  /** The platform's fiat payout for the batch, integer cents. */
  amount_cents: number;
  currency: string;
  source: GamingReceiptSource;
  /** The line's DevEx conversion facts; null = the line converted outside a logged virtual-currency program. */
  conversion: GamingDevexConversionFacts | null;
}

export type GamingCashoutPostSuccess = {
  ok: true;
  value: {
    /** The locked receipt — kind and status both 'virtual_currency_cashout_pending'. */
    cashout_credit: LedgerTransactionRecord;
    journal_id: string;
    /** The durable conversion log, when the line carried DevEx facts. */
    conversion_log: GamingDevexConversionLogRecord | null;
    /** false = the log already existed (a replay wrote nothing). */
    conversion_log_counted: boolean;
  };
};

/** The cross-reference evidence — fail-closed: the contract ref AND at least one statement ref. */
export interface GamingCrossReferenceVerification {
  /** The verified studio contract the payout batch was checked against. */
  studio_contract_ref: string;
  /** The verified store statements the batch lines were reconciled against. */
  store_statement_refs: string[];
}

/** One credited creator — the batch net's routing, integer cents. */
export interface GamingCreatorAllocation {
  payee_id: string;
  payee_name: string;
  role: SplitPartyInput["role"];
  amount_cents: number;
}

export interface GamingCashoutReleaseInput {
  /** The locked receipt to release (the ledger row id). */
  cashout_ledger_id: string;
  /** The platform payout batch this release settles — the conversion-log key. */
  batch_ref: string;
  verification: GamingCrossReferenceVerification;
  /** The verified creator routing for the batch net. */
  creator_allocations: GamingCreatorAllocation[];
  /** The clearance gate's first condition — fail-closed on anything but true. */
  operator_settlement_approved: boolean;
}

export type GamingCashoutReleaseSuccess = {
  ok: true;
  value: {
    /** The released row — status 'settled', kind still 'virtual_currency_cashout_pending'. */
    cashout_credit: LedgerTransactionRecord;
    /** Per-creator outcome; net_cents is post-withholding, post-recoupment. */
    creator_credits: Array<{
      payee_id: string;
      payee_name: string;
      role: SplitPartyInput["role"];
      gross_cents: number;
      net_cents: number;
    }>;
    /** The batch's conversion logs this release proved settled. */
    settled_conversion_logs: number;
    company_dust_cents: number;
    dust_ledger: CompanyDustRecord[];
    journal_id: string;
  };
};

/** The content-derived conversion-log event id — one log per funding line. */
export function gamingDevexConversionEventId(lineEventId: string): string {
  return `gaming:devex:${lineEventId}`;
}

/** Recovers the platform from a cashout row's per-platform payee id. */
export function platformFromCashoutPayeeId(payeeId: string): string | undefined {
  const prefix = "gaming_cashout:";
  return payeeId.startsWith(prefix) ? payeeId.slice(prefix.length) : undefined;
}

/**
 * Writes one durable DevEx conversion log. Content-derived event id — the
 * once-only replay arbiter: a replayed ingest re-derives the same id, the
 * read finds the existing row, and the write is a counted no-op
 * (counted: false). A concurrent insert between the read and the write
 * re-reads the winner — the unique violation is never swallowed.
 */
export async function ingestGamingDevexConversionLog(
  store: Store,
  input: {
    line_event_id: string;
    platform: string;
    facts: GamingDevexConversionFacts;
    fiat_net_cents: number;
    createdAt: string;
  },
): Promise<
  | GamingCashoutFailure
  | {
      ok: true;
      log: GamingDevexConversionLogRecord;
      counted: boolean;
    }
> {
  if (input.line_event_id.trim() === "") {
    return {
      ok: false,
      status: 422,
      code: "invalid_conversion_line_event",
      message: "A DevEx conversion log names its funding line.",
    };
  }
  if (input.facts.denomination.trim() === "") {
    return {
      ok: false,
      status: 422,
      code: "invalid_conversion_denomination",
      message: "A DevEx conversion log names its virtual-currency denomination.",
    };
  }
  if (input.facts.virtual_amount.trim() === "" || input.facts.exchange_rate.trim() === "") {
    return {
      ok: false,
      status: 422,
      code: "invalid_conversion_amounts",
      message:
        "A DevEx conversion log records the exact virtual amount and the applied exchange rate as decimal text — never a float.",
    };
  }
  if (input.facts.settlement_batch_ref.trim() === "") {
    return {
      ok: false,
      status: 422,
      code: "invalid_conversion_batch_ref",
      message: "A DevEx conversion log names the payout batch its fiat settlement rides.",
    };
  }
  if (!Number.isSafeInteger(input.fiat_net_cents) || input.fiat_net_cents <= 0) {
    return {
      ok: false,
      status: 422,
      code: "invalid_conversion_fiat_net",
      message: "A DevEx conversion log posts integer cents greater than zero.",
    };
  }

  const eventId = gamingDevexConversionEventId(input.line_event_id);
  const existing = await store.getGamingDevexConversionLogByEventId(eventId);
  if (existing !== undefined) {
    return { ok: true, log: existing, counted: false };
  }
  try {
    const log = await store.insertGamingDevexConversionLog({
      event_id: eventId,
      line_event_id: input.line_event_id,
      platform: input.platform,
      denomination: input.facts.denomination,
      virtual_amount: input.facts.virtual_amount,
      exchange_rate: input.facts.exchange_rate,
      fiat_net_cents: input.fiat_net_cents,
      settlement_batch_ref: input.facts.settlement_batch_ref,
      status: "pending_fiat_settlement",
      settled_at: null,
      created_at: input.createdAt,
    });
    return { ok: true, log, counted: true };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // A concurrent ingest recorded this conversion between our read and
    // our insert — the lock held; re-read the recorded log.
    const winner = await store.getGamingDevexConversionLogByEventId(eventId);
    if (winner === undefined) {
      return {
        ok: false,
        status: 500,
        code: "conversion_log_lock_lost",
        message: `The conversion log lock for event "${eventId}" was won concurrently but the row is missing.`,
      };
    }
    return { ok: true, log: winner, counted: false };
  }
}

/**
 * The platform's fiat settlement completed for one payout batch: every
 * 'pending_fiat_settlement' conversion log of the batch flips to
 * 'fiat_settled'. Already-settled logs are untouched; the count is the
 * honest report of what this call settled.
 */
export async function settleGamingDevexBatchFiat(
  store: Store,
  batchRef: string,
  settledAt: string,
): Promise<GamingCashoutFailure | { ok: true; settled_count: number }> {
  if (batchRef.trim() === "") {
    return {
      ok: false,
      status: 422,
      code: "invalid_batch_ref",
      message: "A fiat settlement names its payout batch.",
    };
  }
  return { ok: true, settled_count: await store.settleGamingDevexConversionLogsByBatch(batchRef, settledAt) };
}

/**
 * Locks one game platform's payout batch into cashout-pending. The money's
 * GL leg is an FBO debit (cash arrived) against a credit on the platform's
 * cashout-pending account — no vault is minted, no dust ledger row is
 * written, no payee is credited. When the line carries DevEx conversion
 * facts, the durable conversion log writes in the same pass.
 */
export async function postToGamingCashoutPending(
  store: Store,
  input: GamingCashoutPostInput,
  now: Date = new Date(),
): Promise<GamingCashoutPostSuccess | GamingCashoutFailure> {
  if (input.platform.trim() === "") {
    return {
      ok: false,
      status: 422,
      code: "invalid_platform",
      message: "A gaming cashout receipt names its platform.",
    };
  }
  // Integer cents, the house invariant — a float amount is refused, never rounded.
  if (!Number.isSafeInteger(input.amount_cents) || input.amount_cents <= 0) {
    return {
      ok: false,
      status: 422,
      code: "invalid_amount",
      message: "Gaming cashout receipts post integer cents greater than zero.",
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
        code: "gaming_receipt_already_posted",
        message: `A gaming cashout receipt for ${refType} "${sourceRefId}" was already posted (${prior.length} journal(s) ref it).`,
      };
    }
  }

  const createdAt = now.toISOString();
  const credit = await store.insertLedgerTransaction({
    split_run_id: "",
    // For match_queue-sourced posts the quarantined statement line IS the
    // source line — the row-level recovery linkage rides the existing
    // line-item index.
    line_item_id: source.type === "match_queue" ? source.event_id : "",
    payee_id: gamingCashoutPayeeId(input.platform),
    payee_name: gamingCashoutPayeeName(input.platform),
    role: "other",
    share_bps: 0,
    amount_cents: input.amount_cents,
    currency: input.currency,
    status: "virtual_currency_cashout_pending",
    rail: null,
    baas_provider: null,
    baas_transfer_id: null,
    created_at: createdAt,
    settled_at: null,
    kind: "virtual_currency_cashout_pending",
  });

  const posted = await postJournal(
    store,
    {
      kind: "gaming_cashout_post",
      ref_type: refType,
      ref_id: sourceRefId === "" ? credit.id : sourceRefId,
      legs: [
        fboDebit(input.amount_cents),
        gamingCashoutCredit(input.platform, input.amount_cents),
      ],
    },
    now,
  );
  if (!posted.ok) {
    return { ok: false, status: 500, code: posted.code, message: posted.message };
  }

  // The durable conversion log — same pass as the lock, idempotent per
  // funding line. A replayed lock refuses at the journal guard above, so a
  // counted log write here belongs to a fresh lock only.
  let conversionLog: GamingDevexConversionLogRecord | null = null;
  let conversionCounted = false;
  if (input.conversion !== null) {
    const logResult = await ingestGamingDevexConversionLog(store, {
      line_event_id: input.conversion.line_event_id,
      platform: input.platform,
      facts: input.conversion,
      // The conversion's fiat net IS the money that locked — one number,
      // never recomputed.
      fiat_net_cents: input.amount_cents,
      createdAt,
    });
    if (!logResult.ok) {
      return logResult;
    }
    conversionLog = logResult.log;
    conversionCounted = logResult.counted;
  }

  return {
    ok: true,
    value: {
      cashout_credit: credit,
      journal_id: posted.journal.id,
      conversion_log: conversionLog,
      conversion_log_counted: conversionCounted,
    },
  };
}

/**
 * Releases one locked payout batch into the creator-credit routing — ONLY
 * after the cross-reference verification (studio contract + store
 * statements), the batch's conversion-log completeness (all logs exist and
 * all reached fiat_settled), with every credited creator through the SAME
 * fail-closed payout compliance gate as a Lithic dispatch (the gaming
 * vertical's studio/team state reads through the wired vertical-state
 * source), and the CAS flip won BEFORE any money moves.
 */
export async function releaseGamingCashout(
  store: Store,
  input: GamingCashoutReleaseInput,
  now: Date = new Date(),
): Promise<GamingCashoutReleaseSuccess | GamingCashoutFailure> {
  const row = await store.getLedgerTransaction(input.cashout_ledger_id);
  if (row === undefined) {
    return {
      ok: false,
      status: 404,
      code: "cashout_receipt_not_found",
      message: "No ledger transaction matches that id.",
    };
  }
  if (row.kind !== "virtual_currency_cashout_pending") {
    return {
      ok: false,
      status: 422,
      code: "not_a_cashout_receipt",
      message: `Ledger transaction ${row.id} is kind "${row.kind}" — only gaming cashout receipts release here.`,
    };
  }
  if (row.status !== "virtual_currency_cashout_pending") {
    return {
      ok: false,
      status: 409,
      code: "cashout_already_released",
      message: `Cashout receipt ${row.id} is no longer locked (status "${row.status}").`,
    };
  }
  const platform = platformFromCashoutPayeeId(row.payee_id);
  if (platform === undefined) {
    return {
      ok: false,
      status: 500,
      code: "cashout_payee_corrupted",
      message: `Cashout receipt ${row.id} carries payee "${row.payee_id}" — not a gaming cashout payee.`,
    };
  }

  // THE cross-reference gate: no verified studio contract AND store
  // statement evidence, no release. Fail-closed on blank refs and on an
  // empty statement list, not just absent ones.
  if (
    input.verification.studio_contract_ref.trim() === "" ||
    input.verification.store_statement_refs.length === 0 ||
    input.verification.store_statement_refs.some((ref) => ref.trim() === "")
  ) {
    return {
      ok: false,
      status: 422,
      code: "cross_reference_verification_required",
      message:
        "Gaming cashout releases only after the platform payout batch is cross-referenced against the verified studio contracts AND the store statements — both references are required.",
    };
  }
  if (input.batch_ref.trim() === "") {
    return {
      ok: false,
      status: 422,
      code: "cashout_batch_ref_required",
      message: "A gaming cashout release names its payout batch (batch_ref).",
    };
  }

  // THE conversion-log completeness gate: the batch's durable DevEx logs
  // must EXIST (an unlogged batch has no conversion audit trail) and must
  // ALL have reached 'fiat_settled' — one pending log holds the whole batch.
  const batchLogs = await store.listGamingDevexConversionLogsByBatch(input.batch_ref);
  if (batchLogs.length === 0) {
    return {
      ok: false,
      status: 422,
      code: "cashout_conversion_logs_missing",
      message: `Payout batch "${input.batch_ref}" has no DevEx conversion logs — the conversion audit trail is incomplete, release refused.`,
    };
  }
  if (batchLogs.some((log) => log.status !== "fiat_settled")) {
    const pending = batchLogs.filter((log) => log.status !== "fiat_settled").length;
    return {
      ok: false,
      status: 422,
      code: "cashout_fiat_settlement_pending",
      message: `Payout batch "${input.batch_ref}" still holds ${pending} conversion log(s) in 'pending_fiat_settlement' — the platform's fiat settlement has not completed, release refused.`,
    };
  }

  const amount = row.amount_cents;

  // Creator routing validation: integer cents greater than zero, no
  // duplicate payee, and the allocations cannot exceed the locked receipt.
  // The remainder is dust for the company variance payee.
  const seenPayees = new Set<string>();
  for (const allocation of input.creator_allocations) {
    if (!Number.isSafeInteger(allocation.amount_cents) || allocation.amount_cents <= 0) {
      return {
        ok: false,
        status: 422,
        code: "invalid_amount",
        message: "Creator allocations post integer cents greater than zero.",
      };
    }
    if (seenPayees.has(allocation.payee_id)) {
      return {
        ok: false,
        status: 422,
        code: "duplicate_creator_allocation",
        message: `Creator "${allocation.payee_id}" appears more than once — one allocation per payee.`,
      };
    }
    seenPayees.add(allocation.payee_id);
  }
  const allocatedTotal = input.creator_allocations.reduce(
    (total, allocation) => total + allocation.amount_cents,
    0,
  );
  if (allocatedTotal > amount) {
    return {
      ok: false,
      status: 422,
      code: "allocations_exceed_receipt",
      message: `Creator allocations (${allocatedTotal}) exceed the locked receipt (${amount}) — release refused.`,
    };
  }
  const dustCents = amount - allocatedTotal;
  if (
    !zeroBalanceHolds(amount, [...input.creator_allocations], dustCents)
  ) {
    return {
      ok: false,
      status: 500,
      code: "zero_balance_violation",
      message:
        "Creator allocations + dust !== locked receipt — release refused.",
    };
  }

  // Full verification = cross-reference AND every credited creator's
  // identity and vertical state through the SAME fail-closed gate the Lithic
  // dispatch route uses (the company variance payee holds no KYC record by
  // design and is skipped). The gaming vertical's studio/team state — the
  // studio's own verified status plus every named team member's identity
  // check — reads through the wired vertical-state source; an absent studio
  // state refuses (vertical_state_unknown), never assumes verified.
  const verticalStateSource = getVerticalComplianceStateSource();
  for (const allocation of input.creator_allocations) {
    if (allocation.payee_id === COMPANY_VARIANCE_PAYEE_ID) continue;
    const kycStatus = await resolveCreatorKycStatus(store, allocation.payee_id);
    const verticalState = await verticalStateSource({
      payeeId: allocation.payee_id,
      vertical: "gaming",
    });
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
        message: `Gaming cashout release refused for payee "${allocation.payee_id}": ${compliance.message}`,
      };
    }
  }

  // The CAS wins BEFORE any money moves (insert-as-lock): the concurrent
  // release loser reads undefined here and refuses with the same 409 a
  // replayed release gets.
  const settled = await store.settleVirtualCurrencyCashout(row.id, now.toISOString());
  if (settled === undefined) {
    return {
      ok: false,
      status: 409,
      code: "cashout_already_released",
      message: `Cashout receipt ${row.id} is no longer locked — a concurrent release won.`,
    };
  }

  // The routing legs, in order: the creator credits (the clearance-gated
  // creator-credit sequence, the PR 7/PR 9 release loop — withholding,
  // recoupment sweep, guarded vault credits), then the company dust.
  // Every branch conserves its cents.
  const glLegs: GlLegInput[] = [gamingCashoutDebit(platform, amount)];
  const withholding: TaxEscrowRecord[] = [];
  const recoupment: Array<RecoupmentSweepOutcome & { payee_id: string }> = [];
  const dustLedger: CompanyDustRecord[] = [];
  const creatorCredits: GamingCashoutReleaseSuccess["value"]["creator_credits"] = [];

  for (const allocation of input.creator_allocations) {
    let creditAmount = allocation.amount_cents;
    if (allocation.role === "creator" && allocation.amount_cents > 0) {
      const taxed = await applyWithholding(store, {
        creator_id: allocation.payee_id,
        gross_cents: allocation.amount_cents,
        tax_year: now.getUTCFullYear(),
      });
      withholding.push(taxed.value.escrow);
      creditAmount = taxed.value.net_cents;
      if (taxed.value.withheld_cents > 0) {
        await creditVault(
          store,
          allocation.payee_id,
          allocation.payee_name,
          taxed.value.withheld_cents,
          "reserve",
          now,
        );
        glLegs.push(
          vaultCredit(allocation.payee_id, "reserve", taxed.value.withheld_cents),
        );
      }
    }
    // No work context exists on a cashout receipt — the catalog-dispute
    // freeze check runs against the empty work key, which no dispute row
    // occupies (honest not-frozen, not a skipped check).
    const incomingFrozen = await isIncomingFrozen(
      store,
      allocation.payee_id,
      "",
    );
    const excessBucket: VaultCreditTarget = incomingFrozen
      ? "reserve"
      : "available";
    const recouped = await applyRecoupmentSweep(
      store,
      allocation.payee_id,
      allocation.payee_name,
      creditAmount,
      now,
      {
        split_run_id: row.split_run_id,
        excess_target: excessBucket,
      },
    );
    if (recouped.applied) {
      recoupment.push({ ...recouped, payee_id: allocation.payee_id });
      if (recouped.recouped_cents > 0) {
        glLegs.push(
          vaultCredit(COMPANY_VARIANCE_PAYEE_ID, "available", recouped.recouped_cents),
        );
      }
      if (recouped.excess_cents > 0) {
        glLegs.push(
          vaultCredit(allocation.payee_id, excessBucket, recouped.excess_cents),
        );
      }
    } else if (incomingFrozen && creditAmount > 0) {
      await creditVault(
        store,
        allocation.payee_id,
        allocation.payee_name,
        creditAmount,
        "reserve",
        now,
      );
      glLegs.push(vaultCredit(allocation.payee_id, "reserve", creditAmount));
    } else if (creditAmount > 0) {
      await creditVault(
        store,
        allocation.payee_id,
        allocation.payee_name,
        creditAmount,
        "pending",
        now,
      );
      glLegs.push(vaultCredit(allocation.payee_id, "pending", creditAmount));
    }
    creatorCredits.push({
      payee_id: allocation.payee_id,
      payee_name: allocation.payee_name,
      role: allocation.role,
      gross_cents: allocation.amount_cents,
      net_cents: creditAmount,
    });
  }

  if (dustCents > 0) {
    dustLedger.push(
      await store.insertCompanyDust({
        split_run_id: row.split_run_id,
        line_item_id: row.line_item_id,
        amount_cents: dustCents,
        variance_account_id: COMPANY_VARIANCE_PAYEE_ID,
        created_at: now.toISOString(),
      }),
    );
    await creditVault(
      store,
      COMPANY_VARIANCE_PAYEE_ID,
      COMPANY_VARIANCE_PAYEE_NAME,
      dustCents,
      "pending",
      now,
    );
    glLegs.push(vaultCredit(COMPANY_VARIANCE_PAYEE_ID, "pending", dustCents));
  }

  const posted = await postJournal(
    store,
    {
      kind: "gaming_cashout_release",
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
      cashout_credit: settled,
      creator_credits: creatorCredits,
      settled_conversion_logs: batchLogs.length,
      company_dust_cents: dustCents,
      dust_ledger: dustLedger,
      journal_id: posted.journal.id,
    },
  };
}
