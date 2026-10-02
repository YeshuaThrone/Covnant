/**
 * CVT recon worker — the AI lane's match_queue writer (PR 24, founder AI
 * directive + tokenization patch).
 *
 * Three row kinds share one writer, in the fail-closed order every lane
 * uses (the queue write first — the quarantine record — then the posting
 * pass reads the outcome, never recomputes):
 *
 *   1. INFERENCE BILLING ROWS — one queue row per (usage event,
 *      contributor): a blended multi-actor event reports one row per
 *      contributor, each carrying its recorded fractional weight; an
 *      unattributed event carries no contributor cells and resolves its
 *      contributor pool through the model's registry at posting. The
 *      addendum 8 columns ride the row (usage_unit, usage_quantity) and
 *      the addendum 9 columns key the attribution (ai_model_id,
 *      dataset_attribution_weight) — wired by the shared builder.
 *
 *   2. VOICE LICENSING ROWS — the synthetic voice stream event's
 *      direct-to-actor licensing fee; the payee cells on the row ARE the
 *      routing (the actor of record — never the fine-tuner, never an
 *      agency).
 *
 *   3. DATASET ATTRIBUTION ROWS — the model registry's facts: each row
 *      upserts the (model, contributor) class + token-weight record
 *      BEFORE the posting pass reads it (an unattributed event's pool
 *      resolves through exactly these rows). A file's optional data pool
 *      royalty posts through the distribution legs, once per pool event.
 *
 * The queue's UNIQUE event_id is the dedup arbiter across ingests — the
 * content-derived `ai:row:*` spaces are per sender row shape; a re-shipped
 * log replays as counted no-ops. No vault cross-reference runs here: AI
 * rows key on the model registry (ai_model_id), not the vault's asset
 * identifiers — the lane's "match" is the registry lookup at posting.
 */

import type { Store } from "@/lib/server/store";
import type { ParsedStatementLine } from "./records";
import { buildMatchQueueRow, isUniqueViolation } from "./matchQueue";
import { aiQueueRowEventId } from "./ai";

/** Per-line AI write outcome — the posting pass's input. */
export interface AiLineOutcome {
  line: ParsedStatementLine;
  /** The queue row's content-derived event id (`ai:row:*`). */
  eventId: string;
  /**
   * False when the UNIQUE arbiter refused the write (the row already
   * exists from an earlier run of the same or another ingest) — money
   * that has ALREADY been counted once; the posting pass never
   * resurrects a refused write.
   */
  written: boolean;
}

/** Aggregate AI write counts — the completion result's AI block. */
export interface AiQueueWriteCounts {
  written: number;
  alreadyPresent: number;
  /** Registry upserts for dataset-attribution rows (idempotent writes). */
  registryUpserts: number;
  lineOutcomes: AiLineOutcome[];
}

/** The content-derived queue row id per AI row kind. */
function aiRowEventId(line: ParsedStatementLine): string {
  const detail = line.aiDetail;
  if (detail === null) {
    // The dispatcher routed the line here by profile; a line without the
    // lane's detail is a routing bug — refuse loudly, never guess.
    throw new Error(
      `ai_detail_missing:profile:${line.profile}:row_${line.lineNumber}`,
    );
  }
  switch (detail.kind) {
    case "inference_billing":
      // One row per (usage event, contributor); the discriminator keeps an
      // event's contributor rows apart from its unattributed row.
      return aiQueueRowEventId(
        line.profile,
        detail.modelId,
        detail.usageEventId,
        detail.contributorPayeeId ?? "unattributed",
      );
    case "voice_licensing":
      // The direct-to-actor leg's row — one per (voice, event).
      return aiQueueRowEventId(
        line.profile,
        detail.voiceId,
        detail.usageEventId,
        "voice",
      );
    case "dataset_attribution":
      // The registry row — one per (model, attribution event, contributor);
      // the payee closes the identity (the duplicate guard at parse).
      return aiQueueRowEventId(
        line.profile,
        detail.modelId,
        detail.attributionEventId,
        detail.contributorPayeeId,
      );
  }
}

/** The idempotent insert — a unique violation is a replay (a counted
 * no-op), anything else throws (never swallowed). */
async function insertOrCountReplay(
  store: Store,
  row: ReturnType<typeof buildMatchQueueRow>,
  counts: AiQueueWriteCounts,
): Promise<boolean> {
  try {
    await store.insertMatchQueueEntry(row);
    counts.written += 1;
    return true;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    counts.alreadyPresent += 1;
    return false;
  }
}

/**
 * Writes one AI ingest's lines to the match queue and upserts the model
 * registry's contribution records. Idempotent end to end: a replayed
 * ingest re-enters here, each write reads the UNIQUE arbiter, and the
 * registry upserts converge on the same records.
 */
export async function writeAiLinesToMatchQueue(
  store: Store,
  lines: readonly ParsedStatementLine[],
): Promise<AiQueueWriteCounts> {
  const counts: AiQueueWriteCounts = {
    written: 0,
    alreadyPresent: 0,
    registryUpserts: 0,
    lineOutcomes: [],
  };

  for (const line of lines) {
    if (line.aiDetail === null) continue; // Not this lane's row — the dispatcher owns routing.

    const eventId = aiRowEventId(line);
    const row = buildMatchQueueRow(
      line,
      eventId,
      `recon:ai:${line.profile}:line:${line.lineNumber}`,
    );
    // matched_cbt_code stays null — AI rows key on the model registry, not
    // the vault's asset identifiers (the identifiers map is empty by
    // construction; the registry lookup happens at posting).
    row.matched_cbt_code = null;

    const written = await insertOrCountReplay(store, row, counts);

    // The registry upserts — the dataset-attribution rows' facts land with
    // the queue write, so an unattributed event's pool can resolve even if
    // a later pass fails and retries (the upserts converge idempotently).
    const detail = line.aiDetail;
    if (detail.kind === "dataset_attribution") {
      await store.upsertAiModelContribution({
        ai_model_id: detail.modelId,
        contributor_payee_id: detail.contributorPayeeId,
        contributor_payee_name: detail.contributorPayeeName,
        contributor_class: detail.contributorClass,
        // The exact decimal text, verbatim from the row — never a
        // recomputation (the recorded attribution log).
        dataset_token_weight: detail.datasetTokenWeight,
      });
      counts.registryUpserts += 1;
    }

    counts.lineOutcomes.push({ line, eventId, written });
  }
  return counts;
}
