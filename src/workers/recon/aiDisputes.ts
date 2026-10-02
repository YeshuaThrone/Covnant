/**
 * CVT recon worker — the AI lane's dispute-freeze, verified-resolution,
 * and dataset-deprecation engine (PR 25, founder AI directive + the
 * tokenization patch's opt-out mechanics).
 *
 * THE FREEZE: when a rights holder files an IP attribution dispute
 * against a model's training dataset, the model's unclaimed-holding legs
 * freeze into status 'unauthorized_training_hold' (the Don ledger
 * contract's dispute-freeze state) — the money stays on the ledger,
 * visibly, and the release path refuses it. The freeze sweep is keyed on
 * the model's INGEST SCOPE: the posting pass stamps every inference and
 * training-pool leg with split_run_id = `ai:model:{modelId}` (the queryable
 * linkage the freeze sweeps read; the content-derived leg event ids stay
 * the per-row identity). Voice-licensing legs are never model-scoped —
 * the direct-to-actor routing (PR 24) is not training-pool money, so no
 * model-scope sweep can ever touch them.
 *
 * THE THAW: there is exactly one exit from 'unauthorized_training_hold'
 * — the verified resolution path. The dispute's CAS resolution (filed →
 * resolved, one winner) runs FIRST; only when the model has no active
 * dispute left does the thaw sweep flip the frozen legs back to status
 * 'unclaimed_holding', at which point the normal clearance-gated release
 * applies. Nothing else in the codebase can flip the frozen status.
 *
 * THE DEPRECATION (the tokenization patch's opt-out): a rights
 * withdrawal / opt-out / model deprecation writes the dataset version's
 * deprecation of record, HALTS future payout allocations to it (the
 * posting pass reads the deprecation registry before distributing), and
 * ARCHIVES the version's historical posted allocations — archive rows
 * that retire the allocations from active attribution while the ledger
 * rows themselves are never deleted or rewritten (the append-only trail
 * stays intact).
 *
 * FAIL-CLOSED, the locked discipline: an absent or unknown gate state
 * refuses the payout (the resolver maps absent → null, unknown → false);
 * a deprecation halts allocations without inventing a payee; and every
 * CAS sweep reports what it actually flipped — never a silent no-op.
 */

import type { Store } from "@/lib/server/store";
import { isUniqueViolation } from "@/lib/server/uniqueViolation";
import type {
  AiDatasetAllocationArchiveRecord,
  AiDatasetDeprecationRecord,
  AiTrainingDisputeRecord,
} from "@/modules/don/records";
import {
  AI_POOL_SENDER_SPACE,
  aiPoolDustEventId,
  aiPoolLegEventId,
} from "./ai";

/** The ingest-scope prefix stamped on the model's legs (split_run_id). */
const AI_MODEL_LEDGER_SCOPE_PREFIX = "ai:model:";

/** The ingest scope a model's inference + training-pool legs post under. */
export function aiModelLedgerScope(aiModelId: string): string {
  return `${AI_MODEL_LEDGER_SCOPE_PREFIX}${aiModelId}`;
}

/** House failure envelope — the udrSplits / unclaimedHolding shape. */
export type AiDisputeFailure = {
  ok: false;
  status: number;
  code: string;
  message: string;
};

/** The dispute filing's input — the rights holder's attribution claim. */
export interface AiTrainingDisputeFilingInput {
  ai_model_id: string;
  dataset_version: string;
  rights_holder_payee_id: string;
  rights_holder_payee_name: string;
  dispute_basis: string;
}

export type AiTrainingDisputeFilingSuccess = {
  ok: true;
  value: {
    /** The dispute of record (the pre-existing row on a re-filed claim). */
    dispute: AiTrainingDisputeRecord;
    /** True when this call's insert created the row (false = re-filed). */
    filed: boolean;
    /** Held legs this filing's freeze sweep flipped to the hold state. */
    frozen_legs: number;
    /** The model's ingest scope the sweep froze. */
    model_ledger_scope: string;
  };
};

/**
 * Files one IP attribution dispute and runs the FREEZE sweep. Idempotent:
 * a re-filed (model, version, rights holder) claim converges on the
 * existing dispute row and re-runs the freeze sweep as a counted no-op —
 * the CAS flips only legs still held, so the freeze is never applied
 * twice to a leg.
 */
export async function fileAiTrainingDispute(
  store: Store,
  input: AiTrainingDisputeFilingInput,
): Promise<AiTrainingDisputeFilingSuccess | AiDisputeFailure> {
  for (const [field, value] of [
    ["ai_model_id", input.ai_model_id],
    ["dataset_version", input.dataset_version],
    ["rights_holder_payee_id", input.rights_holder_payee_id],
    ["rights_holder_payee_name", input.rights_holder_payee_name],
    ["dispute_basis", input.dispute_basis],
  ] as const) {
    if (typeof value !== "string" || value.trim() === "") {
      return {
        ok: false,
        status: 422,
        code: "invalid_dispute_filing",
        message: `Dispute filing "${field}" must be a non-empty string.`,
      };
    }
  }

  let dispute: AiTrainingDisputeRecord;
  let filed = true;
  try {
    dispute = await store.insertAiTrainingDispute({
      ...input,
      status: "filed",
      resolution_notes: null,
      resolved_at: null,
      resolved_by: null,
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // The re-filed claim — the dispute of record already exists (the
    // quarantine-once precedent). Freeze still runs below: the filing and
    // the freeze are idempotent, and a re-file must never UNfreeze.
    const existing = await store.listAiTrainingDisputes("filed");
    const prior = existing.find(
      (row) =>
        row.ai_model_id === input.ai_model_id &&
        row.dataset_version === input.dataset_version &&
        row.rights_holder_payee_id === input.rights_holder_payee_id,
    );
    if (prior === undefined) throw error;
    dispute = prior;
    filed = false;
  }

  const modelLedgerScope = aiModelLedgerScope(input.ai_model_id);
  const frozenLegs = await store.freezeUnauthorizedTrainingHolds(modelLedgerScope);
  return {
    ok: true,
    value: { dispute, filed, frozen_legs: frozenLegs, model_ledger_scope: modelLedgerScope },
  };
}

export type AiTrainingDisputeResolutionSuccess = {
  ok: true;
  value: {
    /** The resolved dispute — the resolution record of the verified path. */
    dispute: AiTrainingDisputeRecord;
    /** Frozen legs this resolution's thaw sweep returned to holding. */
    thawed_legs: number;
    /** True when the model has no active dispute left (the thaw ran). */
    model_thawed: boolean;
  };
};

/**
 * THE VERIFIED RESOLUTION PATH — the only exit from the freeze. Resolves
 * the dispute through the store's CAS (filed → resolved, one winner),
 * then — ONLY when the model has no other active dispute — runs the thaw
 * sweep, flipping the model's frozen legs back to status
 * 'unclaimed_holding'. A resolution lost to a concurrent resolver (the
 * CAS read undefined) refuses with 409; a resolution that leaves a
 * sibling dispute active thaws nothing (the model stays frozen until its
 * last active dispute resolves).
 */
export async function resolveAiTrainingDisputeVerified(
  store: Store,
  input: {
    dispute_id: string;
    resolution_notes: string | null;
    resolved_by: string;
  },
  now: Date = new Date(),
): Promise<AiTrainingDisputeResolutionSuccess | AiDisputeFailure> {
  if (typeof input.resolved_by !== "string" || input.resolved_by.trim() === "") {
    return {
      ok: false,
      status: 422,
      code: "invalid_dispute_resolution",
      message: "Dispute resolution \"resolved_by\" must be a non-empty string.",
    };
  }

  const dispute = await store.getAiTrainingDispute(input.dispute_id);
  if (dispute === undefined) {
    return {
      ok: false,
      status: 404,
      code: "dispute_not_found",
      message: "No AI training dispute matches that id.",
    };
  }

  const resolved = await store.resolveAiTrainingDispute(input.dispute_id, {
    resolution_notes: input.resolution_notes,
    resolved_by: input.resolved_by,
    resolved_at: now.toISOString(),
  });
  if (resolved === undefined) {
    return {
      ok: false,
      status: 409,
      code: "dispute_already_resolved",
      message: `Dispute ${input.dispute_id} is already resolved — a concurrent resolution won.`,
    };
  }

  // The thaw runs ONLY when the model's last active dispute just resolved —
  // the freeze is model-scoped, so its exit is the model's last exit.
  const stillFiled = (await store.listAiTrainingDisputes("filed")).filter(
    (row) => row.ai_model_id === dispute.ai_model_id,
  );
  let thawedLegs = 0;
  if (stillFiled.length === 0) {
    thawedLegs = await store.thawUnauthorizedTrainingHolds(
      aiModelLedgerScope(dispute.ai_model_id),
    );
  }
  return {
    ok: true,
    value: {
      dispute: resolved,
      thawed_legs: thawedLegs,
      model_thawed: stillFiled.length === 0,
    },
  };
}

/** The deprecation filing's input — the rights withdrawal / opt-out. */
export interface AiDatasetDeprecationInput {
  ai_model_id: string;
  dataset_version: string;
  reason: AiDatasetDeprecationRecord["reason"];
  rights_holder_payee_id: string | null;
  rights_holder_payee_name: string | null;
  notes: string | null;
}

export type AiDatasetDeprecationSuccess = {
  ok: true;
  value: {
    /** The deprecation of record (the pre-existing row on a re-run). */
    deprecation: AiDatasetDeprecationRecord;
    /** True when this call's insert created the row (false = re-run). */
    created: boolean;
    /** The historical allocations this call archived (idempotent). */
    archived: AiDatasetAllocationArchiveRecord[];
  };
};

/**
 * Deprecates one dataset version — the rights withdrawal landing:
 *
 *   1. writes the deprecation of record (UNIQUE per (model, version) — a
 *      re-run converges on the existing row),
 *   2. ARCHIVES the version's historical posted allocations: the
 *      training-pool legs and their dust leg, found through the SAME
 *      content-derived leg identities the posting pass wrote. The
 *      identity key is the pool event id the attribution log declared —
 *      the dataset version of record IS that pool event id (the log's
 *      `poolEventId` cell names the dataset pool/revision; the posting
 *      pass derives each pool leg from it, and the deprecation input
 *      carries the same string). The archive rows retire the allocations
 *      from active attribution; the ledger rows are NOT touched — the
 *      append-only trail stays intact.
 *
 * The HALT of future allocations is the deprecation registry itself: the
 * posting pass reads getAiDatasetDeprecation before distributing a pool
 * and sweeps the halted shares to the visible variance dust.
 */
export async function deprecateAiDatasetVersion(
  store: Store,
  input: AiDatasetDeprecationInput,
  now: Date = new Date(),
): Promise<AiDatasetDeprecationSuccess | AiDisputeFailure> {
  if (typeof input.ai_model_id !== "string" || input.ai_model_id.trim() === "") {
    return {
      ok: false,
      status: 422,
      code: "invalid_deprecation",
      message: "Deprecation \"ai_model_id\" must be a non-empty string.",
    };
  }
  if (
    typeof input.dataset_version !== "string" ||
    input.dataset_version.trim() === ""
  ) {
    return {
      ok: false,
      status: 422,
      code: "invalid_deprecation",
      message: "Deprecation \"dataset_version\" must be a non-empty string.",
    };
  }

  let deprecation: AiDatasetDeprecationRecord;
  let created = true;
  try {
    deprecation = await store.insertAiDatasetDeprecation({
      ai_model_id: input.ai_model_id,
      dataset_version: input.dataset_version,
      reason: input.reason,
      rights_holder_payee_id: input.rights_holder_payee_id,
      rights_holder_payee_name: input.rights_holder_payee_name,
      deprecated_at: now.toISOString(),
      notes: input.notes,
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const existing = await store.getAiDatasetDeprecation(
      input.ai_model_id,
      input.dataset_version,
    );
    if (existing === undefined) throw error;
    deprecation = existing;
    created = false;
  }

  // THE ARCHIVAL SWEEP — idempotent by the (deprecation_id,
  // ledger_transaction_id) UNIQUE: a re-run deprecation converges, never
  // double-archives. The payee inputs are the model's registry (the
  // attribution-log rows upsert exactly these rows), so the recomputed
  // pool-leg identities are the ones the posting pass wrote.
  const archived: AiDatasetAllocationArchiveRecord[] = [];
  const alreadyArchived = new Set(
    (await store.listAiDatasetAllocationArchives(deprecation.id)).map(
      (row) => row.ledger_transaction_id,
    ),
  );
  const contributions = await store.listAiModelContributions(input.ai_model_id);
  // The pool-leg identities to archive: one per registered contributor —
  // the attribution-log rows upsert exactly these registry rows — plus
  // the pool's variance-dust leg (one per pool event).
  const legEventIds: string[] = contributions.map((row) =>
    aiPoolLegEventId(
      AI_POOL_SENDER_SPACE,
      input.dataset_version,
      row.contributor_payee_id,
    ),
  );
  legEventIds.push(
    aiPoolDustEventId(AI_POOL_SENDER_SPACE, input.dataset_version),
  );

  for (const legEventId of legEventIds) {
    const legs = await store.listLedgerTransactionsByLineItem(legEventId);
    for (const leg of legs) {
      if (alreadyArchived.has(leg.id)) {
        continue; // Already archived — the re-run converges.
      }
      alreadyArchived.add(leg.id);
      archived.push(
        await store.insertAiDatasetAllocationArchive({
          deprecation_id: deprecation.id,
          ledger_transaction_id: leg.id,
          contributor_payee_id: leg.payee_id,
          amount_cents: leg.amount_cents,
          currency: leg.currency,
          archived_at: now.toISOString(),
        }),
      );
    }
  }

  return {
    ok: true,
    value: { deprecation, created, archived },
  };
}

/**
 * The model ids with an ACTIVE (filed) training dispute — the posting
 * pass's frozen set: a model on this list posts its new inference and
 * pool legs DIRECTLY into the freeze state (the money lands on the
 * ledger, visibly frozen; the queue rows stay the quarantine record for
 * retry healing).
 */
export async function listFrozenAiModelIds(store: Store): Promise<Set<string>> {
  const filed = await store.listAiTrainingDisputes("filed");
  return new Set(filed.map((row) => row.ai_model_id));
}
