/**
 * CVT recon worker — the AI lane's pure attribution engine (PR 24, founder
 * AI directive + tokenization patch). The store-touching passes live in
 * aiQueue.ts / aiPosting.ts; this module is the math and the identity
 * spaces, no store, no clock, no IO — the same discipline as the podcast,
 * gaming, livestream, webtoon, and merch engines.
 *
 * House rules, restated as the module's contract:
 * - DETERMINISTIC BIGINT INTEGER MATH ONLY — the 1e-8 micros fixed-point
 *   discipline; a float anywhere in this file is a bug.
 * - SUB-CENT RESIDUE NEVER ROUNDS UP — every division floors; the ledger
 *   never invents money.
 * - FAIL-CLOSED — any row the lane cannot fully verify is a typed rejection
 *   at parse time (the profiles) or a refused post (the posting pass);
 *   nothing defaults to allowing.
 *
 * The money math the directive pins:
 *
 *   1. METERED USAGE REVENUE — a billing/telemetry row prices its metered
 *      usage exactly: quantity (exact decimal, the 1e-8 space) × the
 *      recorded per-unit rate (the founder's rate-logging rule) = the row's
 *      total API token revenue, in exact bigint micros. Tokens, characters,
 *      and minutes are the addendum 8 unit vocabulary; the math is unit-
 *      agnostic (the unit is identity/audit, never a conversion input).
 *
 *   2. THE NESTED DERIVATIVE SPLIT — LoRA/fine-tune revenue splits nested
 *      and ordered, every level priced off the prior level's remainder:
 *          base provider system fee  = revenue × fee_bps   (off the top)
 *          fine-tuner developer split = remainder × ft_bps
 *          contributor pool           = remainder × pool_bps
 *          model operator margin      = exact complement
 *      Defaults per the directive (2000 / 5000 / 3000 bps), configurable
 *      per contract through the terms of record — never the caller.
 *
 *   3. THE CONTRIBUTOR POOL — data + voice + original-IP contributors
 *      split the pool pro-rata by contributor dataset token weight
 *      (distributeContributorPool): per-leg floor, dust to the platform
 *      variance payee, legs + dust equal to the pool by construction.
 *
 *   4. THE BLENDED ATTRIBUTION — when an output uses a combined multi-actor
 *      dataset or a blended LoRA adapter, the billing log reports one row
 *      per contributor, each carrying that contributor's fractional weight;
 *      the contributor's micro-royalty is TOTAL API token revenue × weight
 *      (blendedAttributionLegs — the tokenization patch verbatim). The
 *      attribution legs can never dilute the provider fee or the developer
 *      split: their sum is fail-closed against the nested split's
 *      contributor pool, and any unattributed pool residue sweeps to the
 *      platform variance payee — conservation holds by construction.
 *
 *   5. VOICE CLONE LICENSING — a synthetic voice stream event's licensing
 *      fee is quantity × the recorded per-character/per-minute rate, and it
 *      routes DIRECTLY to the original voice actor of record: its own leg,
 *      its own event-id space, never pooled through the fine-tuner or an
 *      agency.
 *
 * The event-id spaces, content-derived per row identity (the merch/webtoon
 * fingerprint discipline — identity, never money): `ai:fee:`/`ai:dev:`/
 * `ai:op:` per (model, usage event) legs, `ai:attr:` per (model, event,
 * payee) attribution legs, `ai:voice:` per (voice, event) licensing legs,
 * and `ai:pool:` per (pool event, payee) training-pool legs. A re-shipped
 * log replays as counted no-ops through the queue's UNIQUE event_id.
 */

import { createHash } from "node:crypto";

import { decimalToMicros } from "../../../covnant-sdk/src/parsers/money";
import {
  AI_CONTRIBUTOR_CLASSES,
  AI_USAGE_UNITS,
  AI_VOICE_USAGE_UNITS,
  isAiContributorClass,
  isAiUsageUnit,
  isAiVoiceUsageUnit,
  type AiContributorClass,
  type AiUsageUnit,
  type AiVoiceUsageUnit,
} from "./records";

// The lane vocabularies live in records.ts (the worker's typed vocabulary
// module) — re-exported here so the lane's math API stays one surface.
export {
  AI_CONTRIBUTOR_CLASSES,
  AI_USAGE_UNITS,
  AI_VOICE_USAGE_UNITS,
  isAiContributorClass,
  isAiUsageUnit,
  isAiVoiceUsageUnit,
};
export type { AiContributorClass, AiUsageUnit, AiVoiceUsageUnit };

/** House micro-dollar scale: 1 dollar = 1e8 statement micros (the SDK's 1e-8 space). */
export const MICROS_PER_DOLLAR = 100_000_000n;

/** The AI directive's default nested-split terms, whole basis points. */
export const DEFAULT_BASE_PROVIDER_FEE_BPS = 2000;
export const DEFAULT_FINE_TUNER_SPLIT_BPS = 5000;
export const DEFAULT_CONTRIBUTOR_POOL_BPS = 3000;

/**
 * An exact decimal usage/count cell (tokens, characters, minutes, weights)
 * → 1e-8 micros. Quantities use the SAME fixed-point space as money — the
 * SDK's strict converter, never a float. A negative or malformed quantity
 * is a hostile row (the callers attribute the rejection to the row).
 */
export function parseAiQuantity(value: string): bigint {
  const parsed = decimalToMicros(value);
  if (!parsed.ok) {
    throw new Error(`invalid_ai_quantity:${parsed.reason}:${value}`);
  }
  return parsed.micros;
}

/**
 * Metered usage priced exactly: (quantity micros × rate micros) / 1e8,
 * floored — the same exact bigint product the gaming DevEx and livestream
 * converters run. Negative operands are refused by the profiles upstream;
 * this guard is the math module's own belt.
 */
export function meteredUsageRevenueMicros(
  quantityMicros: bigint,
  rateMicros: bigint,
): bigint {
  if (quantityMicros < 0n || rateMicros < 0n) {
    throw new Error(
      `negative_conversion_operand:${quantityMicros}:${rateMicros}`,
    );
  }
  return (quantityMicros * rateMicros) / MICROS_PER_DOLLAR;
}

/** The nested derivative split's contract terms of record — bps + payees. */
export interface AiNestedSplitTerms {
  readonly baseProviderPayeeId: string;
  readonly baseProviderPayeeName: string;
  readonly baseProviderSystemFeeBps: number;
  readonly fineTunerPayeeId: string;
  readonly fineTunerPayeeName: string;
  readonly fineTunerSplitBps: number;
  readonly contributorPoolBps: number;
  readonly modelOperatorPayeeId: string;
  readonly modelOperatorPayeeName: string;
}

/** The nested split's computed legs — exact bigint micros, conserved. */
export interface AiNestedSplitPlan {
  readonly revenueMicros: bigint;
  readonly baseProviderFeeMicros: bigint;
  readonly remainderAfterFeeMicros: bigint;
  readonly fineTunerSplitMicros: bigint;
  readonly contributorPoolMicros: bigint;
  readonly modelOperatorMarginMicros: bigint;
}

/**
 * A bps cell inside 0-10000 — whole basis points, no fractions (the
 * webtoon percent-cell parser's discipline).
 */
export function validateAiSplitBps(bps: number): number {
  if (!Number.isSafeInteger(bps) || bps < 0 || bps > 10_000) {
    throw new Error(`invalid_ai_split_bps:${bps}`);
  }
  return bps;
}

/**
 * The NESTED DERIVATIVE SPLIT — ordered, each level priced off the prior
 * level's remainder. fee = R × fee_bps off the top; fine-tuner and pool
 * price the post-fee remainder; the operator's margin is the exact
 * complement, so fee + ft + pool + complement === revenue by construction
 * and no rounding can invent or lose a micro.
 */
export function nestedDerivativeSplitPlan(
  revenueMicros: bigint,
  terms: AiNestedSplitTerms,
): AiNestedSplitPlan {
  if (revenueMicros < 0n) {
    throw new Error(`negative_ai_revenue:${revenueMicros}`);
  }
  validateAiSplitBps(terms.baseProviderSystemFeeBps);
  validateAiSplitBps(terms.fineTunerSplitBps);
  validateAiSplitBps(terms.contributorPoolBps);
  if (terms.fineTunerSplitBps + terms.contributorPoolBps > 10_000) {
    throw new Error(
      `invalid_ai_nested_terms:${terms.fineTunerSplitBps}+${terms.contributorPoolBps}`,
    );
  }
  const baseProviderFeeMicros =
    (revenueMicros * BigInt(terms.baseProviderSystemFeeBps)) / 10_000n;
  const remainderAfterFeeMicros = revenueMicros - baseProviderFeeMicros;
  const fineTunerSplitMicros =
    (remainderAfterFeeMicros * BigInt(terms.fineTunerSplitBps)) / 10_000n;
  const contributorPoolMicros =
    (remainderAfterFeeMicros * BigInt(terms.contributorPoolBps)) / 10_000n;
  return {
    revenueMicros,
    baseProviderFeeMicros,
    remainderAfterFeeMicros,
    fineTunerSplitMicros,
    contributorPoolMicros,
    modelOperatorMarginMicros:
      remainderAfterFeeMicros - fineTunerSplitMicros - contributorPoolMicros,
  };
}

/** One contributor's weight as registered (or blended-reported). */
export interface AiContributorWeight {
  readonly payeeId: string;
  readonly payeeName: string;
  /** Exact decimal weight in the 1e-8 space (dataset token weight). */
  readonly weightMicros: bigint;
}

/** One contributor's allocation from a pool — exact bigint micros. */
export interface AiPoolAllocation {
  readonly payeeId: string;
  readonly payeeName: string;
  readonly amountMicros: bigint;
}

/**
 * The PRO-RATA POOL DISTRIBUTION — the pool splits by contributor dataset
 * token weight, per-leg floors, and the floor residue sweeps to the
 * platform variance payee (the esports roster's discipline). Σ legs + dust
 * equals the pool by construction. Zero-weight contributors earn nothing
 * (their weight cannot price a share); a pool with no positive weight
 * sweeps whole to variance — unattributable money never invents a payee.
 */
export function distributeContributorPool(
  poolMicros: bigint,
  contributors: readonly AiContributorWeight[],
): { allocations: AiPoolAllocation[]; varianceDustMicros: bigint } {
  if (poolMicros < 0n) {
    throw new Error(`negative_ai_pool:${poolMicros}`);
  }
  let weightSum = 0n;
  for (const contributor of contributors) {
    if (contributor.weightMicros < 0n) {
      throw new Error(`negative_ai_weight:${contributor.payeeId}`);
    }
    weightSum += contributor.weightMicros;
  }
  const allocations: AiPoolAllocation[] = [];
  let distributed = 0n;
  if (weightSum > 0n) {
    for (const contributor of contributors) {
      const amountMicros = (poolMicros * contributor.weightMicros) / weightSum;
      if (amountMicros <= 0n) continue;
      distributed += amountMicros;
      allocations.push({
        payeeId: contributor.payeeId,
        payeeName: contributor.payeeName,
        amountMicros,
      });
    }
  }
  return { allocations, varianceDustMicros: poolMicros - distributed };
}

/**
 * The BLENDED ATTRIBUTION — the tokenization patch verbatim: each
 * contributor's micro-royalty is TOTAL API token revenue × that
 * contributor's fractional weight, floored. The caller fail-closes the
 * sum against the nested split's contributor pool (attribution legs can
 * never dilute the provider fee or the developer split) and sweeps any
 * pool residue to the platform variance payee.
 */
export function blendedAttributionLegs(
  revenueMicros: bigint,
  contributors: readonly AiContributorWeight[],
): AiPoolAllocation[] {
  if (revenueMicros < 0n) {
    throw new Error(`negative_ai_revenue:${revenueMicros}`);
  }
  const legs: AiPoolAllocation[] = [];
  for (const contributor of contributors) {
    if (contributor.weightMicros < 0n) {
      throw new Error(`negative_ai_weight:${contributor.payeeId}`);
    }
    const amountMicros = (revenueMicros * contributor.weightMicros) / MICROS_PER_DOLLAR;
    if (amountMicros <= 0n) continue;
    legs.push({
      payeeId: contributor.payeeId,
      payeeName: contributor.payeeName,
      amountMicros,
    });
  }
  return legs;
}

/** The sha256 identity fingerprint — identity fields only, never money. */
function aiIdentityHash(fields: readonly string[]): string {
  return createHash("sha256").update(fields.join("|")).digest("hex");
}

/**
 * The sender space — the profile kind — leads every identity so two
 * senders' event ids can never collide (an OpenAI request id and a W&B
 * run id are different namespaces).
 */
export function aiInferenceEventId(
  senderSpace: string,
  modelId: string,
  eventId: string,
): string {
  return `ai:inference:${aiIdentityHash([senderSpace, modelId, eventId])}`;
}

/**
 * The AI queue row's identity — content-derived per sender row (the merch
 * lane's four identity spaces, one per row shape): cross-file stable, so a
 * re-shipped log replays as counted no-ops through the queue's UNIQUE
 * event_id. The discriminator separates the row kinds sharing a sender
 * space (an event's contributor rows from its unattributed row).
 */
export function aiQueueRowEventId(
  senderSpace: string,
  modelId: string,
  eventId: string,
  discriminator: string,
): string {
  return `ai:row:${aiIdentityHash([senderSpace, modelId, eventId, discriminator])}`;
}

export function aiFeeLegEventId(
  senderSpace: string,
  modelId: string,
  eventId: string,
): string {
  return `ai:fee:${aiIdentityHash([senderSpace, modelId, eventId])}`;
}

export function aiDeveloperLegEventId(
  senderSpace: string,
  modelId: string,
  eventId: string,
): string {
  return `ai:dev:${aiIdentityHash([senderSpace, modelId, eventId])}`;
}

export function aiOperatorLegEventId(
  senderSpace: string,
  modelId: string,
  eventId: string,
): string {
  return `ai:op:${aiIdentityHash([senderSpace, modelId, eventId])}`;
}

/** The blended attribution leg's identity — per (sender, model, event, payee). */
export function aiAttributionLegEventId(
  senderSpace: string,
  modelId: string,
  eventId: string,
  payeeId: string,
): string {
  return `ai:attr:${aiIdentityHash([senderSpace, modelId, eventId, payeeId])}`;
}

/** The voice licensing leg's identity — per (sender, voice, event). */
export function aiVoiceLicensingEventId(
  senderSpace: string,
  voiceId: string,
  eventId: string,
): string {
  return `ai:voice:${aiIdentityHash([senderSpace, voiceId, eventId])}`;
}

/** The training pool leg's identity — per (sender, pool event, payee). */
export function aiPoolLegEventId(
  senderSpace: string,
  poolEventId: string,
  payeeId: string,
): string {
  return `ai:pool:${aiIdentityHash([senderSpace, poolEventId, payeeId])}`;
}

/** The training pool variance-dust leg's identity — per (sender, pool event). */
export function aiPoolDustEventId(
  senderSpace: string,
  poolEventId: string,
): string {
  return `ai:pool-dust:${aiIdentityHash([senderSpace, poolEventId])}`;
}

/** The inference registry-fallback variance-dust leg's identity — per
 * (sender, model, event): the pro-rata rounding residue of an unattributed
 * event's contributor pool, swept visibly to the variance account. */
export function aiInferenceDustEventId(
  senderSpace: string,
  modelId: string,
  eventId: string,
): string {
  return `ai:dust:${aiIdentityHash([senderSpace, modelId, eventId])}`;
}
