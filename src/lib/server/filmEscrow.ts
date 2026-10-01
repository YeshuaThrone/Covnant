// Film waterfall escrow ledger states — PR 9 (founder film directive).
//
// Money received from a film distributor LOCKS in ESCROW_WATERFALL_PENDING:
// ledger rows with kind and status 'escrow_waterfall_pending' that stay out
// of every payee vault, out of the waterfall tiers, and out of the unclaimed
// holding bucket, until the statement line items are cross-referenced against
// the signed deal memo and CAMA agreement. Only the verified release moves —
// First Dollar Gross participant points off the top (bypassing the lower
// waterfall tiers), then the tier legs, with the tier-5 net profit pool split
// into its locked producer/investor halves. The escrow is PER-FILM (payee
// `film_escrow:{filmId}`, GL account `film_waterfall_escrow:{filmId}` — the
// vault-account convention of carrying the business key in the account
// string) because the waterfall, the deal, and the gross-receipts
// accumulation are all per-film.
//
// NO MIGRATION. ledger_transactions.status/kind are free text columns
// (migration 0006 places no check constraint on either), so the state
// extends the existing ledger contract in place — the PR 7 precedent.
//
// THE WORKER SEAM STAYS DORMANT. The recon worker's canonical posting path
// does not call this module yet; its activation is a separately tracked
// follow-up. This module is the state, the lock path, the verified-release
// path, the First Dollar Gross trigger, and the net-points sourcing rule,
// with the locked invariants under test.
//
// THE THREE MOVES:
//
//   postToFilmEscrow    — a film distributor's receipt arrives (recon
//                         match-queue event or manual): integer-cent credit
//                         into the film's escrow, replay-guarded per source
//                         (journal per source id, 409 on re-post), balanced
//                         film_escrow_post journal (FBO debit leg). Nothing
//                         moves after this until cross-reference
//                         verification — the escrow lock is the point.
//
//   releaseFilmEscrow   — the verified release. Fail-closed gates, in order:
//                         the row must be a LOCKED escrow receipt (404 / 422
//                         / 409 otherwise), the cross-reference evidence must
//                         be present (deal memo ref AND CAMA agreement ref —
//                         422 before either exists), every credited FDG
//                         participant must pass the SAME fail-closed payout
//                         compliance gate as a Lithic dispatch (operator
//                         settlement approval, verified KYC, the film
//                         vertical's state: cama_escrow_released AND
//                         guild_residual_holdback_satisfied), and the CAS
//                         flip must win (the concurrent loser gets undefined
//                         and a 409). THEN the routing: FDG participant
//                         points off the top of the releasing receipt when
//                         the deal defines them and the trigger fires, tier
//                         legs 0-4 into the film's waterfall tier accounts,
//                         the tier-5 leg split into the locked 50/50
//                         producer/investor pools, and any integer-cent dust
//                         swept to the platform payee. Insert-as-lock
//                         ordering (the PR 7 precedent): the CAS flips
//                         BEFORE any vault credit, so a crash mid-release
//                         fails toward "nothing moved twice".
//
//   postFilmNetPoints   — backend talent net points. The sourcing rule is
//                         the founder's iron rule: net points draw STRICTLY
//                         from the producer 50 percent pool of tier 5, never
//                         from the investor pool and never from gross. The
//                         pools split in splitTier5Pools (the locked 50/50,
//                         producer side floored so talent can never draw a
//                         cent more than half); the shares allocate in
//                         allocateNetPointShares (integer-cent floors, dust
//                         to the platform payee); the journal debits ONLY
//                         the producer pool account — the investor pool
//                         account is never touched.
//
// THE FIRST DOLLAR GROSS TRIGGER: a film's deal — verified at the
// cross-reference — may define FDG participants (gross-point shares in bps)
// with an optional cumulative-gross activation threshold. The film's
// cumulative gross receipts live in the Don ledger itself: every escrow
// receipt row for the film, held or released (money is RECEIVED when it
// locks, not when it releases), summed by the store's
// sumFilmGrossReceiptCents. A verified release evaluates the trigger
// automatically: no threshold means first-dollar from the film's first
// receipt; a threshold fires once the film's cumulative gross has crossed
// it. FDG points are computed on the RELEASING receipt (money still held in
// escrow pays no one) and their legs precede the tier legs — that precedence
// IS "bypassing the lower waterfall tiers".

import type { Store } from "@/lib/server/store";
import type { LedgerTransactionRecord, SplitPartyInput } from "@/lib/don/types";
import {
  BPS_DENOMINATOR,
  COMPANY_VARIANCE_PAYEE_ID,
  COMPANY_VARIANCE_PAYEE_NAME,
  TIER_5_PRODUCER_POOL_BPS,
  filmEscrowPayeeId,
  filmEscrowPayeeName,
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
  filmEscrowCredit,
  filmEscrowDebit,
  fboDebit,
  tier5InvestorPoolCredit,
  tier5ProducerPoolCredit,
  tier5ProducerPoolDebit,
  vaultCredit,
  waterfallTierCredit,
  type GlLegInput,
} from "@/modules/ledger/journal";
import type { CompanyDustRecord, TaxEscrowRecord } from "@/modules/don/records";
import { creditVault } from "@/modules/vaults/engine";
import { isIncomingFrozen } from "@/modules/vaults/dispute";
import type { VaultCreditTarget } from "@/modules/vaults/balances";

/** House failure envelope — the udrSplits / unclaimedHolding shape. */
export type FilmEscrowFailure = {
  ok: false;
  status: number;
  code: string;
  message: string;
};

/**
 * Where the locked receipt arrived from — the recovery linkage. The GL
 * post-journal carries this as its ref (ref_type/ref_id), and a
 * match_queue-sourced receipt ALSO stamps the quarantined statement line's
 * event_id into line_item_id, so the row is discoverable through the
 * existing listLedgerTransactionsByLineItem without a new index or column.
 */
export type FilmReceiptSource =
  | { type: "match_queue"; event_id: string }
  | { type: "recon_job"; job_id: string }
  | { type: "manual"; note: string };

export interface FilmEscrowPostInput {
  /** The film the receipt belongs to — the escrow, deal, and waterfall key. */
  film_id: string;
  /** The distributor's remittance, integer cents. */
  amount_cents: number;
  currency: string;
  source: FilmReceiptSource;
}

export type FilmEscrowPostSuccess = {
  ok: true;
  value: {
    /** The locked receipt — kind and status both 'escrow_waterfall_pending'. */
    escrow_credit: LedgerTransactionRecord;
    journal_id: string;
  };
};

/** The cross-reference evidence — fail-closed: BOTH refs are required. */
export interface CrossReferenceVerification {
  /** The signed deal memo the statement lines were verified against. */
  deal_memo_ref: string;
  /** The executed CAMA agreement the escrow terms come from. */
  cama_agreement_ref: string;
}

/** One First Dollar Gross participant — gross points, in bps of the receipt. */
export interface FdgParticipant {
  payee_id: string;
  payee_name: string;
  role: SplitPartyInput["role"];
  share_bps: number;
}

/**
 * The deal's First Dollar Gross terms, as verified at the cross-reference.
 * threshold_cents null = first-dollar from the film's first receipt;
 * a threshold fires once the film's cumulative gross receipts have crossed it.
 */
export interface FdgDealTerms {
  participants: FdgParticipant[];
  threshold_cents: number | null;
}

/** One verified waterfall tier routing — migration 0011's tier_level canon. */
export interface WaterfallTierAllocation {
  /** 0 through 5; tier 5 splits into the locked producer/investor pools. */
  tier_level: number;
  amount_cents: number;
}

export interface FilmEscrowReleaseInput {
  /** The locked receipt to release (the ledger row id). */
  escrow_ledger_id: string;
  verification: CrossReferenceVerification;
  /** The deal's FDG terms; null = the deal defines no gross points. */
  fdg: FdgDealTerms | null;
  /** The verified waterfall routing for the post-FDG residue. */
  tier_allocations: WaterfallTierAllocation[];
  /** The clearance gate's first condition — fail-closed on anything but true. */
  operator_settlement_approved: boolean;
}

export type FilmEscrowReleaseSuccess = {
  ok: true;
  value: {
    /** The released row — status 'settled', kind still 'escrow_waterfall_pending'. */
    escrow_credit: LedgerTransactionRecord;
    /** Whether the FDG trigger fired on this release. */
    fdg_triggered: boolean;
    /** Per-participant outcome; net_cents is post-withholding, post-recoupment. */
    fdg_participant_credits: Array<{
      payee_id: string;
      payee_name: string;
      role: SplitPartyInput["role"];
      gross_cents: number;
      net_cents: number;
    }>;
    /** The tier routing as posted (the caller's verified allocations). */
    tier_allocations: WaterfallTierAllocation[];
    company_dust_cents: number;
    dust_ledger: CompanyDustRecord[];
    journal_id: string;
  };
};

/** One backend talent net-points holder — bps of the tier-5 PRODUCER pool. */
export interface NetPointsHolder {
  payee_id: string;
  payee_name: string;
  net_points_bps: number;
}

export interface FilmNetPointsInput {
  film_id: string;
  /** The distribution run's replay key — one net-points post per ref. */
  distribution_ref: string;
  /** The tier-5 amount being distributed this run, integer cents. */
  tier5_distribution_cents: number;
  holders: NetPointsHolder[];
  /** The clearance gate's first condition — fail-closed on anything but true. */
  operator_settlement_approved: boolean;
}

export type FilmNetPointsSuccess = {
  ok: true;
  value: {
    producer_pool_cents: number;
    investor_pool_cents: number;
    holder_credits: Array<{
      payee_id: string;
      payee_name: string;
      amount_cents: number;
    }>;
    company_dust_cents: number;
    dust_ledger: CompanyDustRecord[];
    journal_id: string;
  };
};

/**
 * The locked tier-5 pool split — the founder's 50/50 canon. The producer
 * half FLOORS so backend talent net points can never draw a cent more than
 * half; the odd cent (when the tier-5 amount is odd) stays on the investor
 * side. Pure.
 */
export function splitTier5Pools(tier5Cents: number): {
  producer_pool_cents: number;
  investor_pool_cents: number;
} {
  if (!Number.isSafeInteger(tier5Cents) || tier5Cents < 0) {
    throw new RangeError(`Tier 5 pool: ${tier5Cents} is not a safe non-negative integer.`);
  }
  const producerPoolCents = Math.floor(
    (tier5Cents * TIER_5_PRODUCER_POOL_BPS) / BPS_DENOMINATOR,
  );
  return {
    producer_pool_cents: producerPoolCents,
    investor_pool_cents: tier5Cents - producerPoolCents,
  };
}

/**
 * Allocates talent net-point shares out of the producer pool — the SOURCING
 * rule: every share is a floor of producerPoolCents × the holder's bps, so
 * sum(shares) ≤ producer pool ALWAYS; the integer-cent remainder is dust for
 * the platform payee. The investor pool and gross are not inputs — they
 * cannot leak in. Pure.
 */
export function allocateNetPointShares(
  producerPoolCents: number,
  holders: ReadonlyArray<NetPointsHolder>,
): {
  shares: Array<{ payee_id: string; payee_name: string; amount_cents: number }>;
  dust_cents: number;
} {
  const shares = holders.map((holder) => ({
    payee_id: holder.payee_id,
    payee_name: holder.payee_name,
    amount_cents: Math.floor(
      (producerPoolCents * holder.net_points_bps) / BPS_DENOMINATOR,
    ),
  }));
  const allocated = shares.reduce((total, share) => total + share.amount_cents, 0);
  return { shares, dust_cents: producerPoolCents - allocated };
}

/** Recovers the film id from an escrow row's per-film payee id. */
export function filmIdFromEscrowPayeeId(payeeId: string): string | undefined {
  const prefix = "film_escrow:";
  return payeeId.startsWith(prefix) ? payeeId.slice(prefix.length) : undefined;
}

/**
 * Locks one film distributor's receipt into escrow. The money's GL leg is an
 * FBO debit (cash arrived) against a credit on the film's escrow account —
 * no vault is minted, no dust ledger row is written, no payee is credited,
 * and no waterfall tier sees a cent.
 */
export async function postToFilmEscrow(
  store: Store,
  input: FilmEscrowPostInput,
  now: Date = new Date(),
): Promise<FilmEscrowPostSuccess | FilmEscrowFailure> {
  if (input.film_id.trim() === "") {
    return {
      ok: false,
      status: 422,
      code: "invalid_film_id",
      message: "A film escrow receipt names its film.",
    };
  }
  // Integer cents, the house invariant — a float amount is refused, never rounded.
  if (!Number.isSafeInteger(input.amount_cents) || input.amount_cents <= 0) {
    return {
      ok: false,
      status: 422,
      code: "invalid_amount",
      message: "Film escrow receipts post integer cents greater than zero.",
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
        code: "film_receipt_already_posted",
        message: `A film escrow receipt for ${refType} "${sourceRefId}" was already posted (${prior.length} journal(s) ref it).`,
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
    payee_id: filmEscrowPayeeId(input.film_id),
    payee_name: filmEscrowPayeeName(input.film_id),
    role: "other",
    share_bps: 0,
    amount_cents: input.amount_cents,
    currency: input.currency,
    status: "escrow_waterfall_pending",
    rail: null,
    baas_provider: null,
    baas_transfer_id: null,
    created_at: createdAt,
    settled_at: null,
    kind: "escrow_waterfall_pending",
  });

  const posted = await postJournal(
    store,
    {
      kind: "film_escrow_post",
      ref_type: refType,
      ref_id: sourceRefId === "" ? credit.id : sourceRefId,
      legs: [
        fboDebit(input.amount_cents),
        filmEscrowCredit(input.film_id, input.amount_cents),
      ],
    },
    now,
  );
  if (!posted.ok) {
    return { ok: false, status: 500, code: posted.code, message: posted.message };
  }
  return {
    ok: true,
    value: { escrow_credit: credit, journal_id: posted.journal.id },
  };
}

/**
 * Releases one locked receipt into the waterfall routing — ONLY after the
 * cross-reference verification (deal memo + CAMA), with every credited
 * participant through the SAME fail-closed payout compliance gate as a
 * Lithic dispatch, and the CAS flip won BEFORE any money moves.
 */
export async function releaseFilmEscrow(
  store: Store,
  input: FilmEscrowReleaseInput,
  now: Date = new Date(),
): Promise<FilmEscrowReleaseSuccess | FilmEscrowFailure> {
  const row = await store.getLedgerTransaction(input.escrow_ledger_id);
  if (row === undefined) {
    return {
      ok: false,
      status: 404,
      code: "escrow_receipt_not_found",
      message: "No ledger transaction matches that id.",
    };
  }
  if (row.kind !== "escrow_waterfall_pending") {
    return {
      ok: false,
      status: 422,
      code: "not_an_escrow_receipt",
      message: `Ledger transaction ${row.id} is kind "${row.kind}" — only film escrow receipts release here.`,
    };
  }
  if (row.status !== "escrow_waterfall_pending") {
    return {
      ok: false,
      status: 409,
      code: "escrow_already_released",
      message: `Escrow receipt ${row.id} is no longer locked (status "${row.status}").`,
    };
  }
  const filmId = filmIdFromEscrowPayeeId(row.payee_id);
  if (filmId === undefined) {
    return {
      ok: false,
      status: 500,
      code: "escrow_payee_corrupted",
      message: `Escrow receipt ${row.id} carries payee "${row.payee_id}" — not a film escrow payee.`,
    };
  }

  // THE cross-reference gate: no verified deal memo AND CAMA evidence, no
  // release. Fail-closed on blank refs, not just absent ones.
  if (
    input.verification.deal_memo_ref.trim() === "" ||
    input.verification.cama_agreement_ref.trim() === ""
  ) {
    return {
      ok: false,
      status: 422,
      code: "cross_reference_verification_required",
      message:
        "Film escrow releases only after the statement line items are cross-referenced against the signed deal memo AND the CAMA agreement — both references are required.",
    };
  }

  const amount = row.amount_cents;

  // FDG shares: floors of the releasing receipt (money still held pays no
  // one). Shares in bps of the receipt, summed ≤ 10000 — gross points do not
  // exhaust gross; the residue routes to the tiers.
  let fdgShares: Array<{ participant: FdgParticipant; amount_cents: number }> = [];
  if (input.fdg !== null) {
    const totalBps = input.fdg.participants.reduce(
      (total, participant) => total + participant.share_bps,
      0,
    );
    if (
      input.fdg.participants.some(
        (participant) =>
          !Number.isSafeInteger(participant.share_bps) ||
          participant.share_bps < 0 ||
          participant.share_bps > BPS_DENOMINATOR,
      ) ||
      totalBps > BPS_DENOMINATOR
    ) {
      return {
        ok: false,
        status: 422,
        code: "fdg_shares_exceed_gross",
        message: `First Dollar Gross shares must be non-negative bps summing to at most 10000 (got ${totalBps}).`,
      };
    }
    fdgShares = input.fdg.participants.map((participant) => ({
      participant,
      amount_cents: Math.floor((amount * participant.share_bps) / BPS_DENOMINATOR),
    }));
  }

  // Tier routing validation: tiers 0-5, integer cents, no duplicate tier.
  const seenTiers = new Set<number>();
  for (const allocation of input.tier_allocations) {
    if (
      !Number.isSafeInteger(allocation.tier_level) ||
      allocation.tier_level < 0 ||
      allocation.tier_level > 5
    ) {
      return {
        ok: false,
        status: 422,
        code: "invalid_tier_level",
        message: `Waterfall tiers are 0 through 5 (got ${allocation.tier_level}).`,
      };
    }
    if (!Number.isSafeInteger(allocation.amount_cents) || allocation.amount_cents <= 0) {
      return {
        ok: false,
        status: 422,
        code: "invalid_amount",
        message: "Waterfall tier allocations post integer cents greater than zero.",
      };
    }
    if (seenTiers.has(allocation.tier_level)) {
      return {
        ok: false,
        status: 422,
        code: "duplicate_tier_allocation",
        message: `Tier ${allocation.tier_level} appears more than once — one allocation per tier.`,
      };
    }
    seenTiers.add(allocation.tier_level);
  }

  // THE trigger: the deal's FDG terms fire when the film's cumulative gross
  // receipts — every escrow receipt, held or released — have crossed the
  // contractual threshold (no threshold = first-dollar, always fires).
  let fdgTriggered = false;
  if (input.fdg !== null && input.fdg.participants.length > 0) {
    if (input.fdg.threshold_cents === null) {
      fdgTriggered = true;
    } else {
      if (!Number.isSafeInteger(input.fdg.threshold_cents) || input.fdg.threshold_cents < 0) {
        return {
          ok: false,
          status: 422,
          code: "invalid_fdg_threshold",
          message: "The FDG threshold is an integer-cent amount, or null for first-dollar.",
        };
      }
      const cumulativeGross = await store.sumFilmGrossReceiptCents(filmId);
      fdgTriggered = cumulativeGross >= input.fdg.threshold_cents;
    }
  }
  const creditedFdg = fdgTriggered
    ? fdgShares.filter((share) => share.amount_cents > 0)
    : [];
  const fdgTotal = creditedFdg.reduce((total, share) => total + share.amount_cents, 0);

  const tierTotal = input.tier_allocations.reduce(
    (total, allocation) => total + allocation.amount_cents,
    0,
  );
  if (fdgTotal + tierTotal > amount) {
    return {
      ok: false,
      status: 422,
      code: "allocations_exceed_receipt",
      message: `FDG points (${fdgTotal}) + tier routing (${tierTotal}) exceed the locked receipt (${amount}) — release refused.`,
    };
  }
  // The dust — the integer-cent remainder after FDG floors and the tier
  // routing — sweeps to the platform payee, the unclaimed-holding precedent.
  const dustCents = amount - fdgTotal - tierTotal;
  if (
    !zeroBalanceHolds(
      amount,
      [...creditedFdg.map((share) => ({ amount_cents: share.amount_cents })),
       ...input.tier_allocations],
      dustCents,
    )
  ) {
    return {
      ok: false,
      status: 500,
      code: "zero_balance_violation",
      message:
        "FDG + tier allocations + dust !== locked receipt — release refused.",
    };
  }

  // Full verification = cross-reference AND every credited participant's
  // identity and vertical state through the SAME fail-closed gate the Lithic
  // dispatch route uses (the platform house payee holds no KYC record by
  // design and is skipped).
  const verticalStateSource = getVerticalComplianceStateSource();
  for (const share of creditedFdg) {
    if (share.participant.payee_id === COMPANY_VARIANCE_PAYEE_ID) continue;
    const kycStatus = await resolveCreatorKycStatus(store, share.participant.payee_id);
    const verticalState = await verticalStateSource({
      payeeId: share.participant.payee_id,
      vertical: "film",
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
        message: `Film escrow release refused for payee "${share.participant.payee_id}": ${compliance.message}`,
      };
    }
  }

  // The CAS wins BEFORE any money moves (insert-as-lock): the concurrent
  // release loser reads undefined here and refuses with the same 409 a
  // replayed release gets.
  const settled = await store.settleFilmEscrow(row.id, now.toISOString());
  if (settled === undefined) {
    return {
      ok: false,
      status: 409,
      code: "escrow_already_released",
      message: `Escrow receipt ${row.id} is no longer locked — a concurrent release won.`,
    };
  }

  // The routing legs, in order: FDG participant points OFF THE TOP (the
  // clearance-gated creator-credit sequence, the PR 7 release loop —
  // withholding, recoupment sweep, guarded vault credits), then the tier
  // legs (tier 5 split into the locked 50/50 pools), then the platform dust.
  // Every branch conserves its cents.
  const glLegs: GlLegInput[] = [filmEscrowDebit(filmId, amount)];
  const withholding: TaxEscrowRecord[] = [];
  const recoupment: Array<RecoupmentSweepOutcome & { payee_id: string }> = [];
  const dustLedger: CompanyDustRecord[] = [];
  const participantCredits: FilmEscrowReleaseSuccess["value"]["fdg_participant_credits"] = [];

  for (const share of creditedFdg) {
    let creditAmount = share.amount_cents;
    if (share.participant.role === "creator" && share.amount_cents > 0) {
      const taxed = await applyWithholding(store, {
        creator_id: share.participant.payee_id,
        gross_cents: share.amount_cents,
        tax_year: now.getUTCFullYear(),
      });
      withholding.push(taxed.value.escrow);
      creditAmount = taxed.value.net_cents;
      if (taxed.value.withheld_cents > 0) {
        await creditVault(
          store,
          share.participant.payee_id,
          share.participant.payee_name,
          taxed.value.withheld_cents,
          "reserve",
          now,
        );
        glLegs.push(
          vaultCredit(share.participant.payee_id, "reserve", taxed.value.withheld_cents),
        );
      }
    }
    // No work context exists on an escrow receipt — the catalog-dispute
    // freeze check runs against the empty work key, which no dispute row
    // occupies (honest not-frozen, not a skipped check).
    const incomingFrozen = await isIncomingFrozen(
      store,
      share.participant.payee_id,
      "",
    );
    const excessBucket: VaultCreditTarget = incomingFrozen
      ? "reserve"
      : "available";
    const recouped = await applyRecoupmentSweep(
      store,
      share.participant.payee_id,
      share.participant.payee_name,
      creditAmount,
      now,
      {
        split_run_id: row.split_run_id,
        excess_target: excessBucket,
      },
    );
    if (recouped.applied) {
      recoupment.push({ ...recouped, payee_id: share.participant.payee_id });
      if (recouped.recouped_cents > 0) {
        glLegs.push(
          vaultCredit(COMPANY_VARIANCE_PAYEE_ID, "available", recouped.recouped_cents),
        );
      }
      if (recouped.excess_cents > 0) {
        glLegs.push(
          vaultCredit(share.participant.payee_id, excessBucket, recouped.excess_cents),
        );
      }
    } else if (incomingFrozen && creditAmount > 0) {
      await creditVault(
        store,
        share.participant.payee_id,
        share.participant.payee_name,
        creditAmount,
        "reserve",
        now,
      );
      glLegs.push(vaultCredit(share.participant.payee_id, "reserve", creditAmount));
    } else if (creditAmount > 0) {
      await creditVault(
        store,
        share.participant.payee_id,
        share.participant.payee_name,
        creditAmount,
        "pending",
        now,
      );
      glLegs.push(vaultCredit(share.participant.payee_id, "pending", creditAmount));
    }
    participantCredits.push({
      payee_id: share.participant.payee_id,
      payee_name: share.participant.payee_name,
      role: share.participant.role,
      gross_cents: share.amount_cents,
      net_cents: creditAmount,
    });
  }

  // The tier legs. Tier 5 is NEVER a plain leg: the locked 50/50 splits it
  // into the producer and investor pool accounts (the producer side floored),
  // so net points can later draw ONLY from the producer half.
  for (const allocation of input.tier_allocations) {
    if (allocation.tier_level === 5) {
      const pools = splitTier5Pools(allocation.amount_cents);
      if (pools.producer_pool_cents > 0) {
        glLegs.push(tier5ProducerPoolCredit(filmId, pools.producer_pool_cents));
      }
      if (pools.investor_pool_cents > 0) {
        glLegs.push(tier5InvestorPoolCredit(filmId, pools.investor_pool_cents));
      }
    } else {
      glLegs.push(waterfallTierCredit(filmId, allocation.tier_level, allocation.amount_cents));
    }
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
      kind: "film_escrow_release",
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
      escrow_credit: settled,
      fdg_triggered: fdgTriggered,
      fdg_participant_credits: participantCredits,
      tier_allocations: input.tier_allocations,
      company_dust_cents: dustCents,
      dust_ledger: dustLedger,
      journal_id: posted.journal.id,
    },
  };
}

/**
 * Posts one tier-5 net-points distribution. The journal debits ONLY the
 * film's tier-5 producer pool account — the investor pool account is never
 * touched, and gross never enters the math. Replay-guarded per distribution
 * ref (409); every credited holder rides the fail-closed payout compliance
 * gate; dust sweeps to the platform payee.
 */
export async function postFilmNetPoints(
  store: Store,
  input: FilmNetPointsInput,
  now: Date = new Date(),
): Promise<FilmNetPointsSuccess | FilmEscrowFailure> {
  if (input.film_id.trim() === "") {
    return {
      ok: false,
      status: 422,
      code: "invalid_film_id",
      message: "A net-points distribution names its film.",
    };
  }
  if (input.distribution_ref.trim() === "") {
    return {
      ok: false,
      status: 422,
      code: "invalid_distribution_ref",
      message: "A net-points distribution carries a replay key (distribution_ref).",
    };
  }
  if (
    !Number.isSafeInteger(input.tier5_distribution_cents) ||
    input.tier5_distribution_cents <= 0
  ) {
    return {
      ok: false,
      status: 422,
      code: "invalid_amount",
      message: "Net points distribute integer cents greater than zero.",
    };
  }
  if (input.holders.length === 0) {
    return {
      ok: false,
      status: 422,
      code: "no_net_point_holders",
      message: "A net-points distribution names its holders.",
    };
  }
  const totalBps = input.holders.reduce((total, holder) => total + holder.net_points_bps, 0);
  if (
    input.holders.some(
      (holder) =>
        !Number.isSafeInteger(holder.net_points_bps) ||
        holder.net_points_bps < 0 ||
        holder.net_points_bps > BPS_DENOMINATOR,
    ) ||
    totalBps > BPS_DENOMINATOR
  ) {
    return {
      ok: false,
      status: 422,
      code: "net_points_exceed_producer_pool",
      message: `Net-point shares must be non-negative bps of the producer pool summing to at most 10000 (got ${totalBps}).`,
    };
  }

  // Replay guard: one distribution per ref. The journal ref is the marker.
  const prior = await store.listGlJournalsByRef("film_net_points", input.distribution_ref);
  if (prior.length > 0) {
    return {
      ok: false,
      status: 409,
      code: "net_points_already_distributed",
      message: `A net-points distribution for ref "${input.distribution_ref}" was already posted (${prior.length} journal(s) ref it).`,
    };
  }

  // THE sourcing rule: pools split 50/50 (producer side floored), shares
  // floor out of the PRODUCER pool only. The investor pool and gross are
  // structurally absent from the allocation.
  const pools = splitTier5Pools(input.tier5_distribution_cents);
  const allocation = allocateNetPointShares(pools.producer_pool_cents, input.holders);

  // The clearance gate — the platform house payee holds no KYC record by
  // design and is skipped.
  const verticalStateSource = getVerticalComplianceStateSource();
  for (const share of allocation.shares) {
    if (share.payee_id === COMPANY_VARIANCE_PAYEE_ID) continue;
    const kycStatus = await resolveCreatorKycStatus(store, share.payee_id);
    const verticalState = await verticalStateSource({
      payeeId: share.payee_id,
      vertical: "film",
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
        message: `Net points refused for payee "${share.payee_id}": ${compliance.message}`,
      };
    }
  }

  const glLegs: GlLegInput[] = [
    tier5ProducerPoolDebit(input.film_id, pools.producer_pool_cents),
  ];
  const dustLedger: CompanyDustRecord[] = [];
  for (const share of allocation.shares) {
    if (share.amount_cents > 0) {
      await creditVault(store, share.payee_id, share.payee_name, share.amount_cents, "pending", now);
      glLegs.push(vaultCredit(share.payee_id, "pending", share.amount_cents));
    }
  }
  if (allocation.dust_cents > 0) {
    dustLedger.push(
      await store.insertCompanyDust({
        split_run_id: "",
        line_item_id: "",
        amount_cents: allocation.dust_cents,
        variance_account_id: COMPANY_VARIANCE_PAYEE_ID,
        created_at: now.toISOString(),
      }),
    );
    await creditVault(
      store,
      COMPANY_VARIANCE_PAYEE_ID,
      COMPANY_VARIANCE_PAYEE_NAME,
      allocation.dust_cents,
      "pending",
      now,
    );
    glLegs.push(vaultCredit(COMPANY_VARIANCE_PAYEE_ID, "pending", allocation.dust_cents));
  }

  const posted = await postJournal(
    store,
    {
      kind: "film_net_points",
      ref_type: "film_net_points",
      ref_id: input.distribution_ref,
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
      producer_pool_cents: pools.producer_pool_cents,
      investor_pool_cents: pools.investor_pool_cents,
      holder_credits: allocation.shares,
      company_dust_cents: allocation.dust_cents,
      dust_ledger: dustLedger,
      journal_id: posted.journal.id,
    },
  };
}
