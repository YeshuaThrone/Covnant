/**
 * CVT recon worker — the AI lane's nested split posting pass (PR 24,
 * founder AI directive + tokenization patch, riding the canonical posting
 * seam).
 *
 * The nested derivative split LEDGER: every leg of the directive's split
 * posts as its OWN quarantined credit against its own content-derived leg
 * identity, so the Don Ledger's holding account holds each leg separately
 * and the clearance-gated settlement releases per leg:
 *
 *   fee leg   `ai:fee:`   — the base foundation model provider's system
 *                           fee (revenue × fee_bps, off the top)
 *   dev leg   `ai:dev:`   — the fine-tuner / LoRA creator's split of the
 *                           post-fee remainder
 *   op leg    `ai:op:`    — the model operator's exact complement
 *   attr legs `ai:attr:`  — per (event, contributor) micro-royalties: a
 *                           blended event's recorded weights × the total
 *                           API token revenue (the tokenization patch
 *                           verbatim), or an unattributed event's pool
 *                           distributed pro-rata through the model
 *                           registry
 *   dust legs `ai:dust:` / `ai:pool-dust:` — the pro-rata floor residue,
 *                           swept visibly (never rounded up into a
 *                           contributor's credit)
 *   voice leg `ai:voice:` — the synthetic voice stream event's licensing
 *                           fee, routed DIRECTLY to the original voice
 *                           actor of record — never pooled through the
 *                           fine-tuner or an agency
 *   pool legs `ai:pool:`  — a training attribution log's declared data
 *                           pool royalty, distributed pro-rata by the
 *                           registered dataset token weights
 *
 * The model's legs (all but voice) stamp split_run_id = `ai:model:{modelId}`
 * — the queryable ingest scope the dispute-freeze sweep reads (PR 25);
 * the content-derived leg event ids stay the per-row identity.
 *
 * FAIL-CLOSED, the locked discipline:
 * - the match_queue rows were written BEFORE this pass (a posting failure
 *   never drops the event — the rows stay open, a retry heals
 *   idempotently);
 * - a billing event whose model has NO contract terms of record posts
 *   NOTHING — the whole event stays held in its queue rows (posting the
 *   fee legs of an unpriced event would misrepresent it as processed);
 * - the same whole-event hold when an unattributed event's model registry
 *   resolves to no contributors (a contract with no registered pool);
 * - a training pool whose dataset version has a deprecation of record
 *   HALTS the deprecated allocations (the withdrawing rights holder's
 *   share — or every contributor's, when the deprecation names no payee)
 *   into the visible variance dust — conservation holds exactly;
 * - blended attribution legs are fail-closed against the nested split's
 *   contributor pool — their sum can never dilute the provider fee or the
 *   developer split; a violating log throws and fails the job;
 * - sub-cent legs never post (integer cents or nothing, never rounded up);
 * - the per-source replay guard (the 409 journal-ref check) makes a
 *   replayed leg a counted no-op;
 * - ANY other posting failure throws CanonicalPostingError — never
 *   silent, never swallowed.
 *
 * This pass inherits the canonical seam's limits verbatim: the standing
 * payout gates are untouched — money reaches a creator payee ONLY through
 * releaseUnclaimedHolding's clearance-gated settlement path.
 */

import type { Store } from "@/lib/server/store";
import {
  postToUnclaimedHolding,
  type UnclaimedHoldingFailure,
  type UnclaimedHoldingPostSuccess,
} from "@/lib/server/unclaimedHolding";
import { CanonicalPostingError, microsToWholeCents } from "./posting";
import type { ParsedStatementLine } from "./records";
import type { AiLineOutcome } from "./aiQueue";
import {
  AI_POOL_SENDER_SPACE,
  aiAttributionLegEventId,
  aiDeveloperLegEventId,
  aiFeeLegEventId,
  aiInferenceDustEventId,
  aiOperatorLegEventId,
  aiPoolDustEventId,
  aiPoolLegEventId,
  aiVoiceLicensingEventId,
  blendedAttributionLegs,
  distributeContributorPool,
  haltDeprecatedAllocations,
  meteredUsageRevenueMicros,
  nestedDerivativeSplitPlan,
  parseAiQuantity,
  type AiNestedSplitTerms,
  type AiPoolAllocation,
} from "./ai";
import { aiModelLedgerScope, listFrozenAiModelIds } from "./aiDisputes";

/** Posting counts for one AI ingest — the completion report's AI block. */
export interface AiPostingCounts {
  /** Legs credited to UNCLAIMED_HOLDING this pass. */
  postedLegs: number;
  /** Legs whose post hit the per-source replay guard (counted no-ops). */
  replayedLegs: number;
  /** Sub-cent legs — recorded in their queue rows, never posted. */
  zeroNetLegs: number;
  /**
   * Inference events held whole: the model has no contract terms of
   * record, or an unattributed event's registry resolves to no
   * contributors. The queue rows stay the quarantine record.
   */
  heldUnattributedEvents: number;
  // The exact leg sums this pass posted (or replayed) — the honest
  // conservation report. fee + developer + operator + attribution + voice
  // + pool + dust is the pass's total AI gross.
  feeMicros: bigint;
  developerMicros: bigint;
  operatorMicros: bigint;
  attributionMicros: bigint;
  voiceLicensingMicros: bigint;
  poolRoyaltyMicros: bigint;
  poolDustMicros: bigint;
}

function zeroedCounts(): AiPostingCounts {
  return {
    postedLegs: 0,
    replayedLegs: 0,
    zeroNetLegs: 0,
    heldUnattributedEvents: 0,
    feeMicros: 0n,
    developerMicros: 0n,
    operatorMicros: 0n,
    attributionMicros: 0n,
    voiceLicensingMicros: 0n,
    poolRoyaltyMicros: 0n,
    poolDustMicros: 0n,
  };
}

/** The store's terms record → the math's terms input — the explicit map. */
function termsOfRecord(record: {
  base_model_provider_fee_bps: number;
  developer_split_bps: number;
  contributor_pool_bps: number;
  base_model_provider_payee_id: string;
  base_model_provider_payee_name: string;
  developer_payee_id: string;
  developer_payee_name: string;
  model_operator_payee_id: string;
  model_operator_payee_name: string;
}): AiNestedSplitTerms {
  return {
    baseProviderSystemFeeBps: record.base_model_provider_fee_bps,
    fineTunerSplitBps: record.developer_split_bps,
    contributorPoolBps: record.contributor_pool_bps,
    baseProviderPayeeId: record.base_model_provider_payee_id,
    baseProviderPayeeName: record.base_model_provider_payee_name,
    fineTunerPayeeId: record.developer_payee_id,
    fineTunerPayeeName: record.developer_payee_name,
    modelOperatorPayeeId: record.model_operator_payee_id,
    modelOperatorPayeeName: record.model_operator_payee_name,
  };
}

/**
 * One leg's post through the canonical seam — the exact replay/guard
 * discipline the other lanes run, parameterized by the leg's own event id
 * (each leg is its own quarantine record; the 409 guard is per source id).
 * `modelScope` stamps the leg's ingest scope (split_run_id) — the
 * queryable linkage the dispute-freeze sweep reads (null for the voice
 * legs, which are never model-scoped money).
 */
async function postLeg(
  store: Store,
  eventId: string,
  amountMicros: bigint,
  currency: string,
  now: Date,
  counts: AiPostingCounts,
  modelScope: string | null,
): Promise<void> {
  let posted: UnclaimedHoldingPostSuccess | UnclaimedHoldingFailure;
  try {
    const amountCents = microsToWholeCents(amountMicros);
    // A leg worth less than a whole cent cannot exist in the integer-cent
    // ledger — it stays honestly recorded in its queue row (never rounded
    // up into invented money, never silently dropped).
    if (amountCents <= 0) {
      counts.zeroNetLegs += 1;
      return;
    }
    posted = await postToUnclaimedHolding(
      store,
      {
        amount_cents: amountCents,
        currency,
        source: { type: "match_queue", event_id: eventId },
        // The model's ingest scope — the dispute-freeze sweep's linkage
        // (ai:model:{modelId}); the per-leg content-derived event id stays
        // the row identity. Voice legs pass null: never model-scoped.
        split_run_id: modelScope,
      },
      now,
    );
  } catch (cause) {
    // A store-level exception throws raw past the seam's guards —
    // classify it with the same leg-scoped job-failing reason, never
    // swallow.
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new CanonicalPostingError(
      eventId,
      "ledger_store_error",
      `unclaimed_holding_post_failed:${eventId}:ledger_store_error:${message}`,
    );
  }
  if (posted.ok) {
    counts.postedLegs += 1;
    return;
  }
  if (
    posted.status === 409 &&
    posted.code === "unclaimed_holding_already_posted"
  ) {
    counts.replayedLegs += 1;
    return;
  }
  throw new CanonicalPostingError(
    eventId,
    posted.code,
    `unclaimed_holding_post_failed:${eventId}:${posted.code}:${posted.message}`,
  );
}

/** One usage event's contributor rows, grouped from a pass's outcomes. */
interface InferenceEventGroup {
  /** The sender space — the profile kind — that reported the event. */
  readonly senderSpace: string;
  readonly modelId: string;
  readonly usageEventId: string;
  readonly currency: string;
  /** The event's total API token revenue — identical across its rows. */
  readonly revenueMicros: bigint;
  readonly rows: readonly Extract<
    NonNullable<ParsedStatementLine["aiDetail"]>,
    { kind: "inference_billing" }
  >[];
}

/**
 * Groups the pass's inference rows into usage events. The sender space
 * leads the group key: an OpenAI request id and a W&B run id are
 * different namespaces, so the same raw id from two senders is two
 * events, never one merged revenue object (the parse pass guarantees
 * per-event consistency within a sender; grouping here is for the split).
 */
function groupInferenceEvents(
  outcomes: readonly AiLineOutcome[],
): Map<string, InferenceEventGroup> {
  const groups = new Map<string, InferenceEventGroup>();
  for (const outcome of outcomes) {
    const detail = outcome.line.aiDetail;
    if (detail?.kind !== "inference_billing") continue;
    const key = `${outcome.line.profile}\u0000${detail.modelId}\u0000${detail.usageEventId}`;
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, {
        senderSpace: outcome.line.profile,
        modelId: detail.modelId,
        usageEventId: detail.usageEventId,
        currency: outcome.line.currency,
        revenueMicros: BigInt(detail.totalRevenueMicros),
        rows: [detail],
      });
    } else {
      groups.set(key, {
        ...existing,
        rows: [...existing.rows, detail],
      });
    }
  }
  return groups;
}

/**
 * Posts one usage event's nested split legs. The whole-event holds are
 * checked BEFORE any leg posts — an event either posts its complete split
 * or holds entirely; a partially posted event would misrepresent its own
 * conservation.
 */
async function postInferenceEvent(
  store: Store,
  group: InferenceEventGroup,
  now: Date,
  counts: AiPostingCounts,
): Promise<void> {
  const senderSpace = group.senderSpace;
  const termsRecord = await store.getAiModelSplitTerms(group.modelId);
  if (termsRecord === undefined) {
    // No contract terms of record — the event's split is unpriceable.
    // The queue rows stay the quarantine record; nothing posts.
    counts.heldUnattributedEvents += 1;
    return;
  }
  const plan = nestedDerivativeSplitPlan(
    group.revenueMicros,
    termsOfRecord(termsRecord),
  );
  const currency = group.currency;

  // The blended event's own attribution rows — the tokenization patch's
  // per-contributor fractional weights, straight off the billing log.
  const blendedRows = group.rows.filter(
    (row) => row.contributorPayeeId !== null,
  );
  const poolFromRegistry = blendedRows.length === 0;

  let poolDistributions: readonly AiPoolAllocation[] = [];
  let poolDustMicros = 0n;

  if (poolFromRegistry) {
    // THE MODEL REGISTRY FALLBACK — an unattributed event's contributor
    // pool resolves through the registered token weights. A contract with
    // an empty registry holds the whole event: a pool with no registered
    // destination is unattributable money (fail-closed, the founder's
    // rule), and posting the fee legs of an event whose pool cannot
    // resolve would misrepresent the event as fully processed.
    const contributions = await store.listAiModelContributions(group.modelId);
    if (contributions.length === 0) {
      counts.heldUnattributedEvents += 1;
      return;
    }
    const distributed = distributeContributorPool(
      plan.contributorPoolMicros,
      contributions.map((row) => ({
        payeeId: row.contributor_payee_id,
        payeeName: row.contributor_payee_name,
        weightMicros: parseAiQuantity(row.dataset_token_weight),
      })),
    );
    poolDistributions = distributed.allocations;
    poolDustMicros = distributed.varianceDustMicros;
  } else {
    // THE BLENDED ATTRIBUTION — each contributor's micro-royalty is the
    // total API token revenue × their recorded fractional weight. The sum
    // is fail-closed against the nested split's contributor pool: a
    // billing log whose weights dilute the provider fee or the developer
    // split is hostile, and the job fails loudly.
    const legs = blendedAttributionLegs(
      group.revenueMicros,
      blendedRows.map((row) => ({
        payeeId: row.contributorPayeeId!,
        payeeName: row.contributorPayeeName!,
        weightMicros: parseAiQuantity(row.datasetAttributionWeight!),
      })),
    );
    const legsSum = legs.reduce((sum, leg) => sum + leg.amountMicros, 0n);
    if (legsSum > plan.contributorPoolMicros) {
      throw new CanonicalPostingError(
        aiFeeLegEventId(senderSpace, group.modelId, group.usageEventId),
        "ai_blended_attribution_exceeds_pool",
        `ai_blended_attribution_exceeds_pool:${group.modelId}:${group.usageEventId}:${legsSum.toString()}:${plan.contributorPoolMicros.toString()}`,
      );
    }
    poolDistributions = legs;
    // The unattributed residue of the pool (weights that do not sum to
    // the whole pool) sweeps visibly — conservation holds by construction.
    poolDustMicros = plan.contributorPoolMicros - legsSum;
  }

  // The nested split's ordered legs — fee off the top, then the
  // developer's and pool's shares of the remainder, then the operator's
  // exact complement. Each posts as its own quarantined credit.
  const modelScope = aiModelLedgerScope(group.modelId);
  await postLeg(
    store,
    aiFeeLegEventId(senderSpace, group.modelId, group.usageEventId),
    plan.baseProviderFeeMicros,
    currency,
    now,
    counts,
    modelScope,
  );
  counts.feeMicros += plan.baseProviderFeeMicros;
  await postLeg(
    store,
    aiDeveloperLegEventId(senderSpace, group.modelId, group.usageEventId),
    plan.fineTunerSplitMicros,
    currency,
    now,
    counts,
    modelScope,
  );
  counts.developerMicros += plan.fineTunerSplitMicros;
  await postLeg(
    store,
    aiOperatorLegEventId(senderSpace, group.modelId, group.usageEventId),
    plan.modelOperatorMarginMicros,
    currency,
    now,
    counts,
    modelScope,
  );
  counts.operatorMicros += plan.modelOperatorMarginMicros;

  // The attribution legs — one per (event, contributor).
  for (const leg of poolDistributions) {
    await postLeg(
      store,
      aiAttributionLegEventId(
        senderSpace,
        group.modelId,
        group.usageEventId,
        leg.payeeId,
      ),
      leg.amountMicros,
      currency,
      now,
      counts,
      modelScope,
    );
    counts.attributionMicros += leg.amountMicros;
  }
  if (poolDustMicros > 0n) {
    await postLeg(
      store,
      aiInferenceDustEventId(senderSpace, group.modelId, group.usageEventId),
      poolDustMicros,
      currency,
      now,
      counts,
      modelScope,
    );
    counts.poolDustMicros += poolDustMicros;
  }
}

/** One training pool's distribution group — the file's declared royalty. */
interface TrainingPoolGroup {
  readonly poolEventId: string;
  /** The model the attribution log reports (all rows share it). */
  readonly modelId: string;
  readonly poolRoyaltyMicros: string;
  readonly currency: string;
  readonly rows: readonly Extract<
    NonNullable<ParsedStatementLine["aiDetail"]>,
    { kind: "dataset_attribution" }
  >[];
}

/**
 * Posts the AI ingest's legs — voice licensing first (the direct-to-actor
 * routing), then the inference events' nested splits, then the training
 * pools' pro-rata distributions. Idempotent per leg: a replayed ingest
 * re-enters here, each post reads the 409 guard, and the pass completes
 * as counted no-ops.
 */
export async function postAiLinesToHolding(
  store: Store,
  outcomes: readonly AiLineOutcome[],
  now: Date,
): Promise<AiPostingCounts> {
  const counts = zeroedCounts();
  // The dispute freeze (PR 25): the models with an ACTIVE training
  // dispute. Their legs still post — the money lands on the ledger,
  // visibly — but every leg of a frozen model's scope re-freezes below,
  // so new accruals during a dispute land in the hold state, never in a
  // releasable one.
  const frozenModels = await listFrozenAiModelIds(store);
  const scopedModels = new Set<string>();

  // The voice legs — each event's licensing fee routes directly to the
  // voice actor of record, its own identity space, never pooled. Every
  // outcome re-attempts (written or not): a retry after a mid-pass
  // failure must heal the missing legs, and the 409 guard makes the
  // already-posted ones counted no-ops — never double-posted.
  for (const outcome of outcomes) {
    const detail = outcome.line.aiDetail;
    if (detail?.kind !== "voice_licensing") continue;

    // The fee re-derives from the row's own recorded cells — the exact
    // bigint product, identical to the parse pass's line gross.
    const feeMicros = meteredUsageRevenueMicros(
      parseAiQuantity(detail.usageQuantity),
      BigInt(detail.ratePerUnitMicros),
    );
    await postLeg(
      store,
      aiVoiceLicensingEventId(
        outcome.line.profile,
        detail.voiceId,
        detail.usageEventId,
      ),
      feeMicros,
      outcome.line.currency,
      now,
      counts,
      null,
    );
    counts.voiceLicensingMicros += feeMicros;
  }

  // The inference events' nested splits — each event's own sender space
  // leads its leg identities (the two billing senders are different
  // namespaces; the same raw id from both is two events). Every outcome
  // re-attempts; the 409 guard is the dedup arbiter (retry healing).
  const events = groupInferenceEvents(outcomes);
  for (const group of events.values()) {
    scopedModels.add(group.modelId);
    await postInferenceEvent(store, group, now, counts);
  }

  // The training pools — one declared data pool royalty per file,
  // distributed pro-rata by the log's own registered token weights.
  // Every outcome re-attempts; the 409 guard is the dedup arbiter.
  const pools = new Map<string, TrainingPoolGroup>();
  for (const outcome of outcomes) {
    const detail = outcome.line.aiDetail;
    if (detail?.kind !== "dataset_attribution") continue;
    if (detail.poolEventId === null || detail.poolRoyaltyMicros === null) {
      continue; // A weights-only registry row — no money moves.
    }
    const key = detail.poolEventId;
    const existing = pools.get(key);
    if (existing === undefined) {
      pools.set(key, {
        poolEventId: detail.poolEventId,
        modelId: detail.modelId,
        poolRoyaltyMicros: detail.poolRoyaltyMicros,
        currency: outcome.line.currency,
        rows: [detail],
      });
    } else {
      pools.set(key, { ...existing, rows: [...existing.rows, detail] });
    }
  }
  for (const pool of pools.values()) {
    scopedModels.add(pool.modelId);
    const distributed = distributeContributorPool(
      BigInt(pool.poolRoyaltyMicros),
      pool.rows.map((row) => ({
        payeeId: row.contributorPayeeId,
        payeeName: row.contributorPayeeName,
        weightMicros: parseAiQuantity(row.datasetTokenWeight),
      })),
    );
    // THE DEPRECATION HALT (PR 25, the tokenization patch) — allocations
    // to a deprecated dataset version halt automatically: when the pool's
    // version (the log's declared pool event id) has a deprecation of
    // record, the withdrawing rights holder's share — every contributor's
    // share when the deprecation names no specific payee — sweeps to the
    // visible variance dust instead of paying out. Conservation holds
    // exactly (halted cents are moved, never lost); the historical legs
    // are archived by the deprecation engine, never deleted.
    const deprecation = await store.getAiDatasetDeprecation(
      pool.modelId,
      pool.poolEventId,
    );
    const halted = haltDeprecatedAllocations(
      distributed,
      deprecation === undefined
        ? new Set<string>()
        : deprecation.rights_holder_payee_id !== null
          ? new Set([deprecation.rights_holder_payee_id])
          : new Set(distributed.allocations.map((leg) => leg.payeeId)),
    );
    const modelScope = aiModelLedgerScope(pool.modelId);
    for (const leg of halted.allocations) {
      await postLeg(
        store,
        aiPoolLegEventId(
          AI_POOL_SENDER_SPACE,
          pool.poolEventId,
          leg.payeeId,
        ),
        leg.amountMicros,
        pool.currency,
        now,
        counts,
        modelScope,
      );
      counts.poolRoyaltyMicros += leg.amountMicros;
    }
    if (halted.varianceDustMicros > 0n) {
      await postLeg(
        store,
        aiPoolDustEventId(AI_POOL_SENDER_SPACE, pool.poolEventId),
        halted.varianceDustMicros,
        pool.currency,
        now,
        counts,
        modelScope,
      );
      counts.poolDustMicros += halted.varianceDustMicros;
    }
  }

  // The re-freeze — a model with an active training dispute re-enters the
  // hold state right after its legs post, so new accruals during a
  // dispute land frozen, never releasable. The CAS flips only still-held
  // legs (the filing-time sweep already froze the older ones), and the
  // dispute's verified resolution re-runs its own thaw for anything filed
  // mid-pass — the two sweeps converge on the dispute's outcome.
  for (const modelId of scopedModels) {
    if (frozenModels.has(modelId)) {
      await store.freezeUnauthorizedTrainingHolds(aiModelLedgerScope(modelId));
    }
  }

  return counts;
}
