/**
 * CVT art market waterfall cascade (PR 28, migration 0032) — the durable
 * ledger operations behind the founder's art directive, following the book
 * editorial cascade precedent: the recon worker computes nets and posts them
 * to holding; THIS module owns sequential fabrication-debt recoupment and
 * art split accruals as ledger-of-record operations.
 *
 * The isolation firewall: a sale event recoups ONLY its own pool class
 * (print_edition_fabrication / sculpture_fabrication) — the caller picks the
 * class per event exactly as the books lane does, and nothing infers or
 * cross-collateralizes. A print shop sale never touches a bronze foundry
 * bill; a sculpture sale never touches a lithographer's debt; museum
 * licensing money and ARR resales touch neither. Pools fill in sequence_no
 * order (the fabrication contract's order of record); 100% of the sale's
 * net flows until each clears, and the switchover is exact — the clearing
 * event's remainder becomes the splits' basis the SAME event.
 *
 * Split accruals are designations, not movements: the money moves through
 * the standing release machinery (the payout gates). The append-only
 * accrual row is the gate's verified input.
 */

import { randomUUID } from "node:crypto";
import type { Store } from "@/lib/server/store";
import {
  type ArtRecoupmentApplicationRecord,
  type ArtRecoupmentPoolClass,
  type ArtRecoupmentPoolRecord,
  type ArtSplitAccrualRecord,
  type ArtSplitContributorSpec,
  type ArtSplitScheduleRecord,
  isArtContributorRole,
} from "@/modules/don/records";
import { sequentialAdvanceRecoupment } from "@/workers/recon/books";
import type { ArtWriteCounts } from "@/workers/recon/artQueue";
import { isUniqueViolation } from "@/lib/server/uniqueViolation";

/** House failure envelope — the book cascade's shape. */
export type ArtCascadeFailure = {
  ok: false;
  status: number;
  code: string;
  message: string;
};

// ---------------------------------------------------------------------------
// Money helpers — exact integer arithmetic only; nothing rounds up into a
// contributor's credit.
// ---------------------------------------------------------------------------

/**
 * The percentage split — each contributor's share is floor(basis × bps /
 * 10_000), exact. The complement (basis − Σ shares) is the schedule's
 * retained share, NOT dust: it never enters the accrual, and the schedule
 * registration caps Σ bps at 10_000 so the complement is never negative.
 */
export function artPercentageSplits(
  basisCents: number,
  contributors: readonly ArtSplitContributorSpec[],
): { allocations: ArtSplitAccrualRecord["allocations"]; dustCents: number } {
  const allocations = contributors
    .map((contributor) => {
      const bps = contributor.percentage_bps;
      if (!Number.isInteger(bps) || bps < 1 || bps > 10_000) {
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

// ---------------------------------------------------------------------------
// Registration — the pools and schedules of record.
// ---------------------------------------------------------------------------

export interface ArtRecoupmentPoolRegistration {
  /** The waterfall scope key — `edition:{editionId}` (print) or
   * `sculpture:{artworkId}` (sculpture fabrication). */
  scope_key: string;
  pool_class: ArtRecoupmentPoolClass;
  sequence_no: number;
  /** The fronted fabrication debt, integer cents. */
  debt_cents: number;
  currency: string;
  creditor_role: ArtRecoupmentPoolRecord["creditor_role"];
  creditor_payee_id: string;
  creditor_payee_name: string;
  agreement_ref: string;
}

export async function registerArtRecoupmentPool(
  store: Store,
  input: ArtRecoupmentPoolRegistration,
  now: Date = new Date(),
): Promise<ArtRecoupmentPoolRecord | ArtCascadeFailure> {
  if (input.scope_key.trim() === "" || input.agreement_ref.trim() === "") {
    return {
      ok: false,
      status: 422,
      code: "invalid_pool_input",
      message: "A fabrication pool names its waterfall scope and its fabrication agreement of record.",
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
  if (!Number.isSafeInteger(input.debt_cents) || input.debt_cents <= 0) {
    return {
      ok: false,
      status: 422,
      code: "invalid_pool_input",
      message: "A pool's fabrication debt is integer cents greater than zero.",
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
  if (input.creditor_payee_id.trim() === "" || input.creditor_payee_name.trim() === "") {
    return {
      ok: false,
      status: 422,
      code: "invalid_pool_input",
      message: "A pool names its creditor of record.",
    };
  }
  try {
    return await store.insertArtRecoupmentPool({
      scope_key: input.scope_key.trim(),
      pool_class: input.pool_class,
      sequence_no: input.sequence_no,
      debt_cents: input.debt_cents,
      recouped_cents: 0,
      currency: input.currency.toUpperCase(),
      status: "active",
      creditor_role: input.creditor_role,
      creditor_payee_id: input.creditor_payee_id.trim(),
      creditor_payee_name: input.creditor_payee_name.trim(),
      agreement_ref: input.agreement_ref.trim(),
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return {
        ok: false,
        status: 409,
        code: "recoupment_pool_already_registered",
        message: `A ${input.pool_class} pool at sequence ${input.sequence_no} is already registered for scope "${input.scope_key}".`,
      };
    }
    throw error;
  }
}

export interface ArtSplitScheduleRegistration {
  scope_key: string;
  scope: ArtSplitScheduleRecord["scope"];
  contributors: readonly ArtSplitContributorSpec[];
}

function validateArtContributors(
  registration: ArtSplitScheduleRegistration,
): string | null {
  if (registration.contributors.length === 0) {
    return "A split schedule names at least one contributor.";
  }
  let totalBps = 0;
  for (const contributor of registration.contributors) {
    if (contributor.payee_id.trim() === "" || contributor.payee_name.trim() === "") {
      return "Every contributor names its payee of record.";
    }
    if (!isArtContributorRole(contributor.role)) {
      return `Unknown contributor role "${contributor.role}".`;
    }
    if (!Number.isInteger(contributor.percentage_bps) || contributor.percentage_bps < 1 || contributor.percentage_bps > 10_000) {
      return "A percentage cut is 1–10,000 whole basis points.";
    }
    totalBps += contributor.percentage_bps;
  }
  if (totalBps > 10_000) {
    return "A schedule's percentage cuts cannot exceed the whole basis (10,000 bps).";
  }
  return null;
}

export async function registerArtSplitSchedule(
  store: Store,
  input: ArtSplitScheduleRegistration,
  now: Date = new Date(),
): Promise<ArtSplitScheduleRecord | ArtCascadeFailure> {
  if (input.scope_key.trim() === "") {
    return {
      ok: false,
      status: 422,
      code: "invalid_schedule_input",
      message: "A split schedule names its scope key (edition or sculpture identity).",
    };
  }
  const scopeError = validateArtContributors(input);
  if (scopeError !== null) {
    return { ok: false, status: 422, code: "invalid_schedule_input", message: scopeError };
  }
  const existing = await store.getArtSplitSchedule(input.scope_key);
  const record: ArtSplitScheduleRecord = {
    id: existing?.id ?? randomUUID(),
    scope_key: input.scope_key.trim(),
    scope: input.scope,
    contributors: input.contributors.map((contributor) => ({
      payee_id: contributor.payee_id.trim(),
      payee_name: contributor.payee_name.trim(),
      role: contributor.role,
      percentage_bps: contributor.percentage_bps,
    })),
    version: existing === undefined ? 1 : existing.version + 1,
    created_at: existing?.created_at ?? now.toISOString(),
    updated_at: now.toISOString(),
  };
  return store.upsertArtSplitSchedule(record);
}

// ---------------------------------------------------------------------------
// Sequential fabrication recoupment — the pools fill in sequence order; the
// switchover point is the first event whose net flows past the last open
// pool.
// ---------------------------------------------------------------------------

export interface ArtRecoupmentApplicationInput {
  scope_key: string;
  /** The pool class this revenue recoups — chosen EXPLICITLY per event
   * (the isolation firewall); nothing infers it. */
  pool_class: ArtRecoupmentPoolClass;
  source_event_id: string;
  revenue_cents: number;
  /** The revenue event's currency — a pool only recoups its own currency. */
  currency: string;
}

export interface ArtRecoupmentApplySuccess {
  applications: ArtRecoupmentApplicationRecord[];
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

export async function applyArtRecoupment(
  store: Store,
  input: ArtRecoupmentApplicationInput,
  now: Date = new Date(),
): Promise<{ ok: true; value: ArtRecoupmentApplySuccess } | ArtCascadeFailure> {
  if (input.scope_key.trim() === "" || input.source_event_id.trim() === "") {
    return {
      ok: false,
      status: 422,
      code: "invalid_recoupment_input",
      message: "A recoupment application names its waterfall scope and its revenue event.",
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
    const pools = await store.listArtRecoupmentPools(input.scope_key, input.pool_class);
    if (pools.length === 0) {
      return {
        ok: false,
        status: 404,
        code: "recoupment_pool_not_registered",
        message: `No ${input.pool_class} recoupment pool is registered for scope "${input.scope_key}" — register the fabrication debt before applying revenue.`,
      };
    }

    // The currency firewall: a sale recoups a pool of its own currency
    // only — a mismatched pool is visible in the result, never pooled.
    const currency = input.currency.toUpperCase();
    const mismatchedPools = pools
      .filter((pool) => pool.currency !== currency)
      .map((pool) => ({ pool_id: pool.id, pool_currency: pool.currency }));
    const eligible = pools.filter((pool) => pool.currency === currency);

    // Replay guard FIRST (cheap, before any position math): the same event
    // already applied anywhere in the sequence → 409, never a double
    // recovery.
    const applicationsByPool = new Map<string, ArtRecoupmentApplicationRecord[]>();
    for (const pool of eligible) {
      applicationsByPool.set(pool.id, await store.listArtRecoupmentApplications(pool.id));
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
        message: `Recoupment event "${input.source_event_id}" was already applied to the ${input.pool_class} pool sequence for scope "${input.scope_key}".`,
      };
    }

    // The append-only rows are the truth; the open position is each pool's
    // debt minus their sum. Only ACTIVE pools with a positive open balance
    // participate in the sequence walk.
    const positions = eligible
      .filter((pool) => pool.status === "active")
      .map((pool) => {
        const applied = (applicationsByPool.get(pool.id) ?? []).reduce(
          (sum, application) => sum + application.applied_cents,
          0,
        );
        return { pool, open: Math.max(0, pool.debt_cents - applied) };
      })
      .filter((position) => position.open > 0);

    const plan = sequentialAdvanceRecoupment(
      input.revenue_cents,
      positions.map((position) => ({ poolId: position.pool.id, remainingCents: position.open })),
    );

    if (plan.applications.length === 0) {
      // Every pool is clear (or the sequence's open balances are zero):
      // the whole net is post-clearance — the switchover state.
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
    const inserted: ArtRecoupmentApplicationRecord[] = [];
    let lostPosition = false;
    for (const planned of plan.applications) {
      const pool = positions.find((position) => position.pool.id === planned.poolId)?.pool;
      if (pool === undefined) {
        lostPosition = true;
        break;
      }
      // recouped_before = debt − (applied + remaining-after) — the open
      // balance this application drew from.
      const recoupedBefore =
        pool.debt_cents - (planned.appliedCents + planned.remainingCents);
      try {
        const record = await store.insertArtRecoupmentApplication({
          pool_id: pool.id,
          pool_class: input.pool_class,
          scope_key: input.scope_key.trim(),
          source_event_id: input.source_event_id,
          recouped_before_cents: recoupedBefore,
          applied_cents: planned.appliedCents,
          remaining_cents: planned.remainingCents,
          created_at: now.toISOString(),
        });
        inserted.push(record);
        // Won the position — the pool's derived counter and status track it
        // (bookkeeping; the append-only row is the commit).
        await store.updateArtRecoupmentPoolProgress(
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
      return pool.debt_cents - (appliedAfter.get(pool.id) ?? 0) > 0;
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

export interface ArtSplitAccrualInput {
  schedule: ArtSplitScheduleRecord;
  /** The funding row's event id. */
  source_event_id: string;
  /** The funding base, integer cents (the post-recoupment excess). */
  basis_cents: number;
}

export type ArtSplitAccrualSuccess = {
  accrual: ArtSplitAccrualRecord | null;
  /** True when the event already accrued (the UNIQUE guard's no-op). */
  replayed: boolean;
};

export async function accrueArtSplit(
  store: Store,
  input: ArtSplitAccrualInput,
  now: Date = new Date(),
): Promise<ArtSplitAccrualSuccess | ArtCascadeFailure> {
  let allocations: ArtSplitAccrualRecord["allocations"];
  let dustCents = 0;
  try {
    const splits = artPercentageSplits(input.basis_cents, input.schedule.contributors);
    allocations = splits.allocations;
    dustCents = splits.dustCents;
  } catch (error) {
    // A malformed schedule of record is an operator data problem — surface
    // it, never fabricate an allocation.
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      status: 422,
      code: "invalid_schedule_input",
      message: `The schedule for "${input.schedule.scope_key}" cannot split its basis: ${message}`,
    };
  }
  try {
    const accrual = await store.insertArtSplitAccrual({
      schedule_id: input.schedule.id,
      scope_key: input.schedule.scope_key,
      scope: input.schedule.scope,
      source_event_id: input.source_event_id,
      basis_cents: input.basis_cents,
      allocations,
      dust_cents: dustCents,
      created_at: now.toISOString(),
    });
    return { accrual, replayed: false };
  } catch (error) {
    if (isUniqueViolation(error)) {
      // The event already accrued — the once-only designation, replayed as
      // a no-op (the books accrual's replay discipline).
      return { accrual: null, replayed: true };
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Copyright agency fee policy registration — the configurable rate of record.
// ---------------------------------------------------------------------------

export interface ArtLicensingAgencyPolicyRegistration {
  agency_code: "ars" | "dacs";
  agency_name: string;
  /** The agency's collection fee, basis points of the license fee — the
   * founder's 15–20% band validates here at registration. */
  collection_fee_bps: number;
}

export async function registerArtLicensingAgencyPolicy(
  store: Store,
  input: ArtLicensingAgencyPolicyRegistration,
  now: Date = new Date(),
): Promise<Record<string, never> | ArtCascadeFailure> {
  if (input.agency_name.trim() === "") {
    return {
      ok: false,
      status: 422,
      code: "invalid_agency_policy_input",
      message: "An agency policy names the agency of record.",
    };
  }
  if (
    !Number.isInteger(input.collection_fee_bps) ||
    input.collection_fee_bps < 1500 ||
    input.collection_fee_bps > 2000
  ) {
    return {
      ok: false,
      status: 422,
      code: "invalid_agency_policy_input",
      message: "A copyright agency's collection fee is 1,500–2,000 basis points (the 15–20% founder band).",
    };
  }
  await store.upsertArtLicensingAgencyPolicy({
    agency_code: input.agency_code,
    agency_name: input.agency_name.trim(),
    collection_fee_bps: input.collection_fee_bps,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  });
  return {};
}

// ---------------------------------------------------------------------------
// The worker pass — fabrication recoupment + splits over one ingest's
// computed nets.
// ---------------------------------------------------------------------------

/** The print edition's waterfall scope key. */
export function printEditionScopeKey(editionId: string): string {
  return `edition:${editionId}`;
}

/** The sculpture fabrication's waterfall scope key. */
export function sculptureScopeKey(artworkId: string): string {
  return `sculpture:${artworkId}`;
}

/** The waterfall pass's honest completion report — the inputs to ReconJobResult. */
export interface ArtWaterfallPassCounts {
  /** Recoupment APPLICATIONS written (and replayed events no-opped). */
  recoupmentsApplied: number;
  recoupmentsReplayed: number;
  recoupmentAppliedCents: number;
  /** Post-clearance net seen this pass — the splits' basis. */
  recoupmentExcessCents: number;
  /** Sales with no fabrication pool registered — money stays in holding
   * (visible, never a silent drop: the sale posted; the waterfall is
   * simply not contracted yet). */
  skippedNoPool: number;
  /** Pool applications skipped for currency mismatch. */
  skippedCurrencyMismatch: number;
  /** Split accruals written (and replayed no-ops). */
  splitAccruals: number;
  splitAccrualsReplayed: number;
  /** Sales with no split schedule — visible skips, never silent drops. */
  skippedNoSchedule: number;
}

export async function runArtWaterfallPass(
  store: Store,
  counts: ArtWriteCounts,
  now: Date = new Date(),
): Promise<ArtWaterfallPassCounts> {
  const pass: ArtWaterfallPassCounts = {
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
    // The pass operates on POSTED money only — sale rows whose net was
    // credited to holding. Quarantined, zero-net, no-ARR, audit, licensing,
    // and resale rows never recoup and never split.
    if (outcome.disposition !== "money") continue;

    // The caller picks the pool class + scope per row EXPLICITLY (the
    // isolation firewall): a print shop sale feeds the edition's
    // print_edition_fabrication pools; a gallery sculpture sale feeds the
    // sculpture's sculpture_fabrication pools; a unique-work gallery sale
    // carries no fabrication pools at all.
    const scope =
      outcome.detail.kind === "print_shop_sale"
        ? { key: printEditionScopeKey(outcome.detail.editionId), poolClass: "print_edition_fabrication" as const }
        : outcome.detail.kind === "gallery_primary_sale" && outcome.detail.pieceKind === "sculpture"
          ? { key: sculptureScopeKey(outcome.detail.artworkId), poolClass: "sculpture_fabrication" as const }
          : null;
    if (scope === null) continue;

    const applied = await applyArtRecoupment(
      store,
      {
        scope_key: scope.key,
        pool_class: scope.poolClass,
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
      throw new Error(`art_recoupment_failed:${applied.code}:${applied.message}`);
    }
    pass.skippedCurrencyMismatch += applied.value.mismatched_pools.length;
    pass.recoupmentsApplied += applied.value.applications.length;
    pass.recoupmentAppliedCents += applied.value.recouped_cents;
    pass.recoupmentExcessCents += applied.value.excess_cents;

    if (applied.value.excess_cents > 0) {
      // The switchover: post-recoupment net splits per the scope's
      // schedule of record (the founder's example cut).
      const schedule = await store.getArtSplitSchedule(scope.key);
      if (schedule === undefined) {
        pass.skippedNoSchedule += 1;
        continue;
      }
      const accrual = await accrueArtSplit(
        store,
        {
          schedule,
          source_event_id: outcome.eventId,
          basis_cents: applied.value.excess_cents,
        },
        now,
      );
      if ("message" in accrual) {
        throw new Error(`art_split_accrual_failed:${accrual.code}:${accrual.message}`);
      }
      if (accrual.replayed) pass.splitAccrualsReplayed += 1;
      else pass.splitAccruals += 1;
    }
  }
  return pass;
}

// Re-exported for the worker's report assembly — the pass speaks in the
// records' own vocabulary.
export type { ArtRecoupmentPoolRecord, ArtSplitScheduleRecord };

