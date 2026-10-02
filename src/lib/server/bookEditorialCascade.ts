/**
 * CVT book editorial split cascade (PR 26, migration 0030) — the durable
 * ledger operations behind the founder's publishing directive, following
 * the webtoon library-surface precedent: the recon worker computes nets and
 * posts them to holding; THIS module owns sequential advance recoupment
 * and editorial split accruals as ledger-of-record operations.
 *
 * The isolation firewall: a royalty event recoups ONLY its own pool class
 * (e-book / print / audiobook production) — the caller picks the class per
 * event exactly as the webtoon print/coin rule does, and nothing infers or
 * cross-collateralizes. Pools fill in sequence_no order (the co-author /
 * ghostwriter contract's order of record); 100% of the stream's net
 * royalties flow until each clears, and the switchover is exact — the
 * clearing event's remainder becomes the splits' basis the SAME event.
 *
 * Split accruals are designations, not movements: the money moves through
 * the standing release machinery (the payout gates). The append-only
 * accrual row is the gate's verified input.
 */

import { randomUUID } from "node:crypto";
import type { Store } from "@/lib/server/store";
import {
  type BookEditorialContributorSpec,
  type BookEditorialProRataBasis,
  type BookEditorialSplitAccrualRecord,
  type BookEditorialSplitMode,
  type BookEditorialSplitScheduleRecord,
  type BookRecoupmentApplicationRecord,
  type BookRecoupmentPoolClass,
  type BookRecoupmentPoolRecord,
  isBookEditorialContributorRole,
} from "@/modules/don/records";
import {
  anthologyProRataSplits,
  sequentialAdvanceRecoupment,
} from "@/workers/recon/books";
import { isUniqueViolation } from "@/lib/server/uniqueViolation";
import type { BookWriteCounts } from "@/workers/recon/booksQueue";

/** House failure envelope — the VTuber holdback / film escrow shape. */
export type BookCascadeFailure = {
  ok: false;
  status: number;
  code: string;
  message: string;
};

// ---------------------------------------------------------------------------
// Money helpers — exact integer arithmetic only; nothing rounds up into a
// contributor's credit.
// ---------------------------------------------------------------------------

/** 1 cent = 10_000 micros; floor at cent precision (micros are exact). */
function microsToCentsFloor(micros: bigint): number {
  return Number(micros / 10_000n);
}

/**
 * The percentage split — each contributor's share is floor(basis × bps /
 * 10_000), exact. The complement (basis − Σ shares) is the title's
 * retained share, NOT dust: it never enters the accrual, and the schedule
 * registration caps Σ bps at 10_000 so the complement is never negative.
 */
export function bookPercentageSplits(
  basisCents: number,
  contributors: readonly BookEditorialContributorSpec[],
): { allocations: BookEditorialSplitAccrualRecord["allocations"]; dustCents: number } {
  const allocations = contributors
    .filter((contributor) => contributor.mode === "percentage")
    .map((contributor) => {
      const bps = contributor.percentage_bps;
      if (!Number.isInteger(bps) || bps === null || bps < 1 || bps > 10_000) {
        throw new RangeError(`invalid_split_percentage:${contributor.payee_id}:${String(bps)}`);
      }
      return {
        payee_id: contributor.payee_id,
        payee_name: contributor.payee_name,
        share_cents: Number((BigInt(Math.max(0, basisCents)) * BigInt(bps)) / 10_000n),
      };
    })
    .filter((allocation) => allocation.share_cents > 0);
  return { allocations, dustCents: 0 };
}

/**
 * The flat per-issue cuts — the contracted fees themselves (integer cents,
 * once per issue per schedule version). Basis is 0: a flat cut is not
 * revenue-derived.
 */
export function bookFlatCutAllocations(
  contributors: readonly BookEditorialContributorSpec[],
): BookEditorialSplitAccrualRecord["allocations"] {
  return contributors
    .filter((contributor) => contributor.mode === "flat_per_issue")
    .map((contributor) => {
      const flat = contributor.flat_cents;
      if (!Number.isInteger(flat) || flat === null || flat < 1) {
        throw new RangeError(`invalid_split_flat_cut:${contributor.payee_id}:${String(flat)}`);
      }
      return {
        payee_id: contributor.payee_id,
        payee_name: contributor.payee_name,
        share_cents: flat,
      };
    });
}

// ---------------------------------------------------------------------------
// Registration — the pools and schedules of record.
// ---------------------------------------------------------------------------

export interface BookRecoupmentPoolRegistration {
  isbn: string;
  pool_class: BookRecoupmentPoolClass;
  sequence_no: number;
  advance_cents: number;
  currency: string;
  advance_agreement_ref: string;
}

export async function registerBookRecoupmentPool(
  store: Store,
  input: BookRecoupmentPoolRegistration,
  now: Date = new Date(),
): Promise<BookRecoupmentPoolRecord | BookCascadeFailure> {
  if (input.isbn.trim() === "" || input.advance_agreement_ref.trim() === "") {
    return {
      ok: false,
      status: 422,
      code: "invalid_pool_input",
      message: "A recoupment pool names its title's ISBN and its advance agreement of record.",
    };
  }
  if (!Number.isSafeInteger(input.sequence_no) || input.sequence_no < 1) {
    return {
      ok: false,
      status: 422,
      code: "invalid_pool_input",
      message: "A pool's sequence_no is a positive integer — the recoupment order of record.",
    };
  }
  if (!Number.isSafeInteger(input.advance_cents) || input.advance_cents <= 0) {
    return {
      ok: false,
      status: 422,
      code: "invalid_pool_input",
      message: "A pool's advance is integer cents greater than zero.",
    };
  }
  if (!/^[A-Za-z]{3}$/.test(input.currency)) {
    return {
      ok: false,
      status: 422,
      code: "invalid_pool_input",
      message: "A pool's currency is its three-letter alpha code.",
    };
  }
  try {
    return await store.insertBookRecoupmentPool({
      isbn: input.isbn.trim(),
      pool_class: input.pool_class,
      sequence_no: input.sequence_no,
      advance_cents: input.advance_cents,
      recouped_cents: 0,
      currency: input.currency.toUpperCase(),
      status: "active",
      advance_agreement_ref: input.advance_agreement_ref.trim(),
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return {
        ok: false,
        status: 409,
        code: "recoupment_pool_already_registered",
        message: `A ${input.pool_class} pool at sequence ${input.sequence_no} is already registered for ISBN "${input.isbn}".`,
      };
    }
    throw error;
  }
}

export interface BookEditorialScheduleRegistration {
  /** The schedule's key: the title's ISBN, or `magazine:{issueId}`. */
  title_key: string;
  scope: "book" | "magazine_issue";
  mode: BookEditorialSplitMode;
  pro_rata_basis: BookEditorialProRataBasis | null;
  contributors: readonly BookEditorialContributorSpec[];
}

function validateContributorsForScope(
  registration: BookEditorialScheduleRegistration,
): string | null {
  if (registration.contributors.length === 0) {
    return "A split schedule names at least one contributor.";
  }
  for (const contributor of registration.contributors) {
    if (contributor.payee_id.trim() === "" || contributor.payee_name.trim() === "") {
      return "Every contributor names its payee of record.";
    }
    if (!isBookEditorialContributorRole(contributor.role)) {
      return `Unknown contributor role "${contributor.role}".`;
    }
  }
  if (registration.scope === "book" && registration.mode === "percentage") {
    let totalBps = 0;
    for (const contributor of registration.contributors) {
      if (contributor.mode !== "percentage" || contributor.percentage_bps === null) {
        return "A book percentage schedule's contributors are all percentage cuts.";
      }
      if (contributor.percentage_bps < 1 || contributor.percentage_bps > 10_000) {
        return "A percentage cut is 1–10,000 whole basis points.";
      }
      totalBps += contributor.percentage_bps;
    }
    if (totalBps > 10_000) {
      return "A schedule's percentage cuts cannot exceed the whole basis (10,000 bps).";
    }
    return null;
  }
  if (registration.scope === "book" && registration.mode === "pro_rata") {
    if (registration.pro_rata_basis === null) {
      return "A pro-rata schedule names its basis (page_count or word_count).";
    }
    for (const contributor of registration.contributors) {
      if (contributor.mode !== "pro_rata" || contributor.pro_rata_count === null) {
        return "A pro-rata schedule's contributors all carry their page or word count.";
      }
      if (!Number.isInteger(contributor.pro_rata_count) || contributor.pro_rata_count < 1) {
        return "A contributor's pro-rata count is a positive whole number.";
      }
    }
    return null;
  }
  if (registration.scope === "magazine_issue") {
    for (const contributor of registration.contributors) {
      if (contributor.mode === "flat_per_issue") {
        if (contributor.flat_cents === null || !Number.isInteger(contributor.flat_cents) || contributor.flat_cents < 1) {
          return "A flat per-issue cut is integer cents greater than zero.";
        }
      } else if (contributor.mode === "percentage") {
        if (contributor.percentage_bps === null || contributor.percentage_bps < 1 || contributor.percentage_bps > 10_000) {
          return "A magazine percentage cut is 1–10,000 whole basis points.";
        }
      } else {
        return "A magazine roster's cuts are flat-per-issue or percentage modes.";
      }
    }
    return null;
  }
  return "A book schedule is a percentage (standard splits) or pro_rata (anthology) schedule.";
}

export async function registerBookEditorialSplitSchedule(
  store: Store,
  input: BookEditorialScheduleRegistration,
  now: Date = new Date(),
): Promise<BookEditorialSplitScheduleRecord | BookCascadeFailure> {
  if (input.title_key.trim() === "") {
    return {
      ok: false,
      status: 422,
      code: "invalid_schedule_input",
      message: "A split schedule names its title key (ISBN or magazine issue identity).",
    };
  }
  const scopeError = validateContributorsForScope(input);
  if (scopeError !== null) {
    return { ok: false, status: 422, code: "invalid_schedule_input", message: scopeError };
  }
  const existing = await store.getBookEditorialSplitSchedule(input.title_key);
  const record: BookEditorialSplitScheduleRecord = {
    id: existing?.id ?? randomUUID(),
    title_key: input.title_key.trim(),
    scope: input.scope,
    mode: input.mode,
    pro_rata_basis: input.pro_rata_basis,
    contributors: input.contributors.map((contributor) => ({ ...contributor })),
    version: existing === undefined ? 1 : existing.version + 1,
    created_at: existing?.created_at ?? now.toISOString(),
    updated_at: now.toISOString(),
  };
  return store.upsertBookEditorialSplitSchedule(record);
}

// ---------------------------------------------------------------------------
// Sequential advance recoupment — the pools fill in sequence order; the
// switchover point is the first event whose royalty flows past the last
// open pool.
// ---------------------------------------------------------------------------

export interface BookRecoupmentApplicationInput {
  isbn: string;
  /** The pool class this revenue recoups — chosen EXPLICITLY per event
   * (the isolation firewall); nothing infers it. */
  pool_class: BookRecoupmentPoolClass;
  source_event_id: string;
  revenue_cents: number;
  /** The revenue event's currency — a pool only recoups its own currency. */
  currency: string;
}

export interface BookRecoupmentApplySuccess {
  applications: BookRecoupmentApplicationRecord[];
  /** The integer cents applied to pools this event. */
  recouped_cents: number;
  /** The post-clearance remainder — the splits' basis. Zero while any
   * eligible pool remains open (the 100%-to-recoupment rule). */
  excess_cents: number;
  /** True when at least one eligible pool is still open after this event. */
  pools_remaining_open: boolean;
  /** Pools skipped for currency mismatch — visible, never silently pooled. */
  mismatched_pools: { pool_id: string; pool_currency: string }[];
}

export async function applyBookRecoupment(
  store: Store,
  input: BookRecoupmentApplicationInput,
  now: Date = new Date(),
): Promise<{ ok: true; value: BookRecoupmentApplySuccess } | BookCascadeFailure> {
  if (input.isbn.trim() === "" || input.source_event_id.trim() === "") {
    return {
      ok: false,
      status: 422,
      code: "invalid_recoupment_input",
      message: "A recoupment application names its title's ISBN and its revenue event.",
    };
  }
  if (!Number.isSafeInteger(input.revenue_cents) || input.revenue_cents <= 0) {
    return {
      ok: false,
      status: 422,
      code: "invalid_amount",
      message: "Recoupment applies integer cents of revenue greater than zero.",
    };
  }

  for (;;) {
    const pools = await store.listBookRecoupmentPools(input.isbn, input.pool_class);
    if (pools.length === 0) {
      return {
        ok: false,
        status: 404,
        code: "recoupment_pool_not_registered",
        message: `No ${input.pool_class} recoupment pool is registered for ISBN "${input.isbn}" — register the advance before applying revenue.`,
      };
    }

    // The currency firewall: a royalty recoups a pool of its own currency
    // only — a mismatched pool is visible in the result, never pooled.
    const currency = input.currency.toUpperCase();
    const mismatchedPools = pools
      .filter((pool) => pool.currency !== currency)
      .map((pool) => ({ pool_id: pool.id, pool_currency: pool.currency }));
    const eligible = pools.filter((pool) => pool.currency === currency);

    // Replay guard FIRST (cheap, before any position math): the same event
    // already applied anywhere in the sequence → 409, never a double
    // recovery.
    const applicationsByPool = new Map<string, BookRecoupmentApplicationRecord[]>();
    for (const pool of eligible) {
      applicationsByPool.set(pool.id, await store.listBookRecoupmentApplications(pool.id));
    }
    const isReplay = eligible.some((pool) =>
      (applicationsByPool.get(pool.id) ?? []).some(
        (application) => application.source_event_id === input.source_event_id,
      ),
    );
    if (isReplay) {
      return {
        ok: false,
        status: 409,
        code: "recoupment_event_already_applied",
        message: `Recoupment event "${input.source_event_id}" was already applied to the ${input.pool_class} pool sequence for ISBN "${input.isbn}".`,
      };
    }

    // The append-only rows are the truth; the open position is each pool's
    // advance minus their sum. Only ACTIVE pools with a positive open
    // balance participate in the sequence walk.
    const positions = eligible
      .filter((pool) => pool.status === "active")
      .map((pool) => {
        const applied = (applicationsByPool.get(pool.id) ?? []).reduce(
          (sum, application) => sum + application.applied_cents,
          0,
        );
        return { pool, open: Math.max(0, pool.advance_cents - applied) };
      })
      .filter((position) => position.open > 0);

    const plan = sequentialAdvanceRecoupment(
      input.revenue_cents,
      positions.map((position) => ({ poolId: position.pool.id, remainingCents: position.open })),
    );

    if (plan.applications.length === 0) {
      // Every pool is clear (or the sequence's open balances are zero):
      // the whole royalty is post-clearance — the switchover state.
      return {
        ok: true,
        value: {
          applications: [],
          recouped_cents: 0,
          excess_cents: input.revenue_cents,
          pools_remaining_open: false,
          mismatched_pools: mismatchedPools,
        },
      };
    }

    // Insert each application in sequence order under the position lock;
    // losing the lock (a concurrent application of the same pool) restarts
    // the derivation from the append-only truth. Bounded: the pool has
    // finitely many positions.
    const inserted: BookRecoupmentApplicationRecord[] = [];
    let lostPosition = false;
    for (const planned of plan.applications) {
      const pool = positions.find((position) => position.pool.id === planned.poolId)?.pool;
      if (pool === undefined) {
        lostPosition = true;
        break;
      }
      // recouped_before = advance − (applied + remaining-after) — the open
      // balance this application drew from.
      const recoupedBefore =
        pool.advance_cents - (planned.appliedCents + planned.remainingCents);
      try {
        const record = await store.insertBookRecoupmentApplication({
          pool_id: pool.id,
          pool_class: input.pool_class,
          isbn: input.isbn.trim(),
          source_event_id: input.source_event_id,
          recouped_before_cents: recoupedBefore,
          applied_cents: planned.appliedCents,
          remaining_cents: planned.remainingCents,
          created_at: now.toISOString(),
        });
        inserted.push(record);
        // Won the position — the pool's derived counter and status track it
        // (bookkeeping; the append-only row is the commit).
        await store.updateBookRecoupmentPoolProgress(
          pool.id,
          recoupedBefore + planned.appliedCents,
          planned.remainingCents === 0 ? "recouped" : "active",
          now.toISOString(),
        );
      } catch (error) {
        if (isUniqueViolation(error)) {
          lostPosition = true;
          break;
        }
        throw error;
      }
    }
    if (lostPosition) continue;

    // Derive the post-event state from the ledger truth (rows + inserts).
    const appliedAfter = new Map<string, number>();
    for (const pool of eligible) {
      const prior = (applicationsByPool.get(pool.id) ?? []).reduce(
        (sum, application) => sum + application.applied_cents,
        0,
      );
      appliedAfter.set(
        pool.id,
        prior + inserted
          .filter((application) => application.pool_id === pool.id)
          .reduce((sum, application) => sum + application.applied_cents, 0),
      );
    }
    const poolsRemainingOpen = eligible.some((pool) => {
      if (pool.status !== "active") return false;
      return pool.advance_cents - (appliedAfter.get(pool.id) ?? 0) > 0;
    });

    return {
      ok: true,
      value: {
        applications: inserted,
        recouped_cents: plan.recoupedCents,
        excess_cents: plan.excessCents,
        pools_remaining_open: poolsRemainingOpen,
        mismatched_pools: mismatchedPools,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Split accruals — the once-only designations behind the payout gates.
// ---------------------------------------------------------------------------

export interface BookSplitAccrualInput {
  schedule: BookEditorialSplitScheduleRecord;
  /** The funding row's event id, or the flat cut's per-issue identity. */
  source_event_id: string;
  /** The funding base, integer cents (0 for flat cuts). */
  basis_cents: number;
}

export type BookSplitAccrualSuccess = {
  accrual: BookEditorialSplitAccrualRecord | null;
  /** True when the event already accrued (the UNIQUE guard's no-op). */
  replayed: boolean;
};

export async function accrueBookEditorialSplit(
  store: Store,
  input: BookSplitAccrualInput,
  now: Date = new Date(),
): Promise<BookSplitAccrualSuccess | BookCascadeFailure> {
  let allocations: BookEditorialSplitAccrualRecord["allocations"];
  let dustCents = 0;
  try {
    if (input.schedule.mode === "percentage") {
      const splits = bookPercentageSplits(input.basis_cents, input.schedule.contributors);
      allocations = splits.allocations;
      dustCents = splits.dustCents;
    } else if (input.schedule.mode === "pro_rata") {
      if (input.schedule.pro_rata_basis === null) {
        return {
          ok: false,
          status: 422,
          code: "invalid_schedule_input",
          message: `The pro-rata schedule for "${input.schedule.title_key}" names no basis.`,
        };
      }
      const splits = anthologyProRataSplits(
        input.basis_cents,
        input.schedule.pro_rata_basis,
        input.schedule.contributors.map((contributor) => ({
          payeeId: contributor.payee_id,
          payeeName: contributor.payee_name,
          count: contributor.pro_rata_count ?? 0,
        })),
      );
      allocations = splits.allocations.map((allocation) => ({
        payee_id: allocation.payeeId,
        payee_name: allocation.payeeName,
        share_cents: allocation.shareCents,
      }));
      dustCents = splits.dustCents;
    } else {
      allocations = bookFlatCutAllocations(input.schedule.contributors);
    }
  } catch (error) {
    // A malformed schedule of record is an operator data problem — surface
    // it, never fabricate an allocation.
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      status: 422,
      code: "invalid_schedule_input",
      message: `The schedule for "${input.schedule.title_key}" cannot split its basis: ${message}`,
    };
  }

  try {
    const accrual = await store.insertBookEditorialSplitAccrual({
      schedule_id: input.schedule.id,
      title_key: input.schedule.title_key,
      scope: input.schedule.scope,
      source_event_id: input.source_event_id,
      basis_cents: Math.max(0, input.basis_cents),
      allocations,
      dust_cents: dustCents,
      created_at: now.toISOString(),
    });
    return { accrual, replayed: false };
  } catch (error) {
    if (isUniqueViolation(error)) {
      // The event already accrued — the once-only guard's no-op.
      return { accrual: null, replayed: true };
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// The worker pass — recoupment + splits over one ingest's computed nets.
// ---------------------------------------------------------------------------

/** The split pass's honest completion report — the inputs to ReconJobResult. */
export interface BookSplitPassCounts {
  /** Recoupment APPLICATIONS written (and replayed events no-opped). */
  recoupmentsApplied: number;
  recoupmentsReplayed: number;
  recoupmentAppliedCents: number;
  /** Post-clearance royalty seen this pass — the splits' basis. */
  recoupmentExcessCents: number;
  /** Rows with no pool registered — money stays in holding (visible). */
  skippedNoPool: number;
  /** Pool applications skipped for currency mismatch. */
  skippedCurrencyMismatch: number;
  /** Split accruals written (and replayed no-ops). */
  splitAccruals: number;
  splitAccrualsReplayed: number;
  /** Rows with no editorial schedule — visible skips, never silent drops. */
  skippedNoSchedule: number;
}

/** The magazine schedule's title key. */
export function magazineScheduleTitleKey(issueId: string): string {
  return `magazine:${issueId}`;
}

/** The flat per-issue cut's once-only event identity (per schedule version). */
export function magazineFlatCutEventId(issueId: string, scheduleVersion: number): string {
  return `book:magazine_flat:${issueId}:${scheduleVersion}`;
}

export async function runBookEditorialSplitPass(
  store: Store,
  counts: BookWriteCounts,
  now: Date = new Date(),
): Promise<BookSplitPassCounts> {
  const pass: BookSplitPassCounts = {
    recoupmentsApplied: 0,
    recoupmentsReplayed: 0,
    recoupmentAppliedCents: 0,
    recoupmentExcessCents: 0,
    skippedNoPool: 0,
    skippedCurrencyMismatch: 0,
    splitAccruals: 0,
    splitAccrualsReplayed: 0,
    skippedNoSchedule: 0,
  };

  for (const outcome of counts.lineOutcomes) {
    // The pass operates on POSTED money only — matched rows whose net was
    // credited to holding. Quarantined and unattributable rows never
    // recoup and never split.
    if (outcome.disposition !== "money" || outcome.matchedCbtCode === null) continue;

    if (
      outcome.detail.kind === "magazine_issue" ||
      outcome.detail.kind === "magazine_subscription"
    ) {
      const titleKey = magazineScheduleTitleKey(outcome.detail.issueId);
      const schedule = await store.getBookEditorialSplitSchedule(titleKey);
      if (schedule === undefined) {
        pass.skippedNoSchedule += 1;
        continue;
      }
      if (
        outcome.detail.kind === "magazine_issue" &&
        schedule.contributors.some((contributor) => contributor.mode === "flat_per_issue")
      ) {
        // The issue's roster flat cut — once per issue per schedule version,
        // triggered by the issue's first post-schedule sale row.
        const accrual = await accrueBookEditorialSplit(
          store,
          {
            schedule,
            source_event_id: magazineFlatCutEventId(outcome.detail.issueId, schedule.version),
            basis_cents: 0,
          },
          now,
        );
        if ("message" in accrual) {
          throw new Error(`book_split_accrual_failed:${accrual.code}:${accrual.message}`);
        }
        if (accrual.replayed) pass.splitAccrualsReplayed += 1;
        else pass.splitAccruals += 1;
      }
      if (outcome.detail.kind === "magazine_subscription") {
        // The percentage cuts ride each subscription funding event; cuts
        // compute in the row's own micros precision, then floor to cents.
        // The accrual runs in the schedule's PERCENTAGE view: a mixed
        // roster's record mode is the flat roster's trigger, never the
        // subscription math — flat cuts are once-per-issue, never
        // per-funding-event.
        const grossMicros = BigInt(outcome.detail.grossMicros);
        const accrual = await accrueBookEditorialSplit(
          store,
          {
            schedule: { ...schedule, mode: "percentage" },
            source_event_id: outcome.eventId,
            basis_cents: microsToCentsFloor(grossMicros),
          },
          now,
        );
        if ("message" in accrual) {
          throw new Error(`book_split_accrual_failed:${accrual.code}:${accrual.message}`);
        }
        if (accrual.replayed) pass.splitAccrualsReplayed += 1;
        else pass.splitAccruals += 1;
      }
      continue;
    }

    // Book streams — print, e-book, and audiobook recoup their OWN class's
    // pool sequence (the isolation firewall; nothing infers the class).
    const poolClass =
      outcome.detail.kind === "print_sale"
        ? ("print_advance" as const)
        : outcome.detail.kind === "ebook_sale"
          ? ("ebook_advance" as const)
          : ("audiobook_production_unrecouped" as const);
    const applied = await applyBookRecoupment(
      store,
      {
        isbn: outcome.detail.isbn,
        pool_class: poolClass,
        source_event_id: outcome.eventId,
        revenue_cents: outcome.netCents,
        currency: outcome.line.currency,
      },
      now,
    );
    if (!applied.ok) {
      if (applied.status === 404) {
        pass.skippedNoPool += 1;
        continue;
      }
      if (applied.status === 409) {
        pass.recoupmentsReplayed += 1;
        continue;
      }
      throw new Error(`book_recoupment_failed:${applied.code}:${applied.message}`);
    }
    pass.skippedCurrencyMismatch += applied.value.mismatched_pools.length;
    pass.recoupmentsApplied += applied.value.applications.length;
    pass.recoupmentAppliedCents += applied.value.recouped_cents;
    pass.recoupmentExcessCents += applied.value.excess_cents;

    if (applied.value.excess_cents > 0) {
      // The switchover: post-clearance royalty splits per the title's
      // schedule of record (percentage standard splits, or an anthology's
      // pro-rata).
      const schedule = await store.getBookEditorialSplitSchedule(outcome.detail.isbn);
      if (schedule === undefined) {
        pass.skippedNoSchedule += 1;
        continue;
      }
      const accrual = await accrueBookEditorialSplit(
        store,
        {
          schedule,
          source_event_id: outcome.eventId,
          basis_cents: applied.value.excess_cents,
        },
        now,
      );
      if ("message" in accrual) {
        throw new Error(`book_split_accrual_failed:${accrual.code}:${accrual.message}`);
      }
      if (accrual.replayed) pass.splitAccrualsReplayed += 1;
      else pass.splitAccruals += 1;
    }
  }
  return pass;
}

// Re-exported for the worker's report assembly — the pass speaks in the
// records' own vocabulary.
export type { BookRecoupmentPoolRecord, BookEditorialSplitScheduleRecord };
