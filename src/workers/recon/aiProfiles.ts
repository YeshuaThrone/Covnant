/**
 * CVT recon worker — AI lane ingestion profiles (PR 24, founder AI
 * directive + tokenization patch).
 *
 * Four strict layouts in the PR #82/#93 house style: exact header (order +
 * columns), required cells, bounded value maps, whole-file rejection on
 * any violation. No industry CSV royalty standard exists for AI billing,
 * telemetry, voice-licensing, or dataset-attribution reports — every
 * sender ships a different layout, so each profile defines ONE strict
 * layout and the profile is the contract, pinned by checked-in fixtures.
 * A permissive guesser is the silent-misparse behavior the recon engine
 * exists to prevent.
 *
 *   openai_llm_billing_log_csv — an OpenAI / custom LLM API token billing
 *     log: metered usage (tokens, characters, or minutes — the addendum 8
 *     unit columns) priced at the RECORDED per-unit rate, with the row's
 *     reported total API token revenue self-reconciled against quantity ×
 *     rate (the consignment discipline — the sender's own arithmetic is
 *     verified, never trusted). One row per (usage event, contributor):
 *     a combined multi-actor dataset or blended LoRA adapter reports one
 *     row per contributor, each carrying that contributor's fractional
 *     weight; an unattributed event carries no contributor cells and its
 *     contributor pool resolves through the model's registry at posting.
 *
 *   wandb_inference_telemetry_csv — the same shape from the Weights &
 *     Biases telemetry sender (Run ID first). Distinct header, same math —
 *     the sender is provenance, not a different revenue object.
 *
 *   elevenlabs_voice_clone_licensing_csv — a synthetic voice stream
 *     event's licensing report: usage priced per CHARACTER or per MINUTE
 *     (never tokens — a token-priced voice row is hostile), routed
 *     DIRECTLY to the original voice actor of record. The payee cells on
 *     the row ARE the routing — the lane never pools voice money through
 *     the fine-tuner or an agency.
 *
 *   huggingface_dataset_attribution_log_csv — a model training attribution
 *     log: one row per (model, contributor) registering the contributor's
 *     class and dataset token weight, and — when the file declares one —
 *     the period's data pool royalty, distributed pro-rata by token
 *     weight. Pool cells are all-or-nothing per file and one pool event
 *     per file: a file whose rows disagree on the pool is hostile whole
 *     (the KENP rate-consistency discipline).
 *
 * Rights separation: AI lines are rights_type 'unknown' — metered
 * inference and dataset royalties are neither recording nor composition
 * royalty, so the split-quarantine rule keeps them out of music split
 * math (the gaming/livestream/webtoon/merch precedent). tier_level is
 * null and statement_source_type is null; rights_pipeline rides inert
 * provenance.
 *
 * Fail-closed row validation (every rejection row-scoped, never silent):
 * the bounded unit/class vocabularies, positive quantities/rates/revenue,
 * the exact revenue self-reconciliation, the per-event row consistency,
 * the voice unit restriction, positive token weights, the all-or-nothing
 * single-pool layout, and the `YYYY-MM` period buckets.
 */

import type { MatchQueueRightsType, MatchQueueStatementSourceType } from "@/modules/sdk/records";
import {
  parseStatementMoney,
  readStrictTable,
  requiredCell,
  sniffHeaderMatches,
} from "./delimited";
import {
  isAiContributorClass,
  isAiUsageUnit,
  isAiVoiceUsageUnit,
  meteredUsageRevenueMicros,
  parseAiQuantity,
} from "./ai";
import { StatementParseError } from "./records";
import type {
  AiContributorClass,
  AiLineDetail,
  AiUsageUnit,
  AiVoiceUsageUnit,
  ParsedStatementLine,
  StatementProfile,
} from "./records";

const CSV = ",";

/** The AI lane's rights family — neither recording nor composition. */
const AI_RIGHTS_TYPE: MatchQueueRightsType = "unknown";

/** The AI lane carries no statement_source_type — the unit and model
 * columns are the discriminator. */
const AI_SOURCE_TYPE: MatchQueueStatementSourceType | null = null;

/** A positive exact-decimal quantity cell (usage or weight) — micros in
 * the 1e-8 space. Zero and negative are hostile rows (usage that never
 * happened cannot price an attribution). */
function positiveQuantityCell(
  values: ReadonlyMap<string, string>,
  column: string,
  rowNumber: number,
): bigint {
  const cell = requiredCell(values, column, rowNumber);
  try {
    const quantity = parseAiQuantity(cell);
    if (quantity <= 0n) {
      throw new Error(`nonpositive:${cell}`);
    }
    return quantity;
  } catch {
    throw new StatementParseError(
      `invalid_quantity:${column}:${cell}:row_${rowNumber}`,
    );
  }
}

/** A positive money cell (rates, revenue, pool royalties) — exact micros. */
function positiveMoneyCell(
  values: ReadonlyMap<string, string>,
  column: string,
  rowNumber: number,
): bigint {
  const cell = requiredCell(values, column, rowNumber);
  let micros: bigint;
  try {
    const money = parseStatementMoney(cell);
    if (money.negative || money.micros <= 0n) {
      throw new Error(`nonpositive:${cell}`);
    }
    micros = money.micros;
  } catch {
    throw new StatementParseError(
      `invalid_money:${column}:${cell}:row_${rowNumber}`,
    );
  }
  return micros;
}

/** An optional exact-decimal weight cell — present or empty, never zero. */
function optionalWeightCell(
  values: ReadonlyMap<string, string>,
  column: string,
  rowNumber: number,
): string | null {
  const cell = values.get(column)?.trim() ?? "";
  if (cell === "") return null;
  try {
    const weight = parseAiQuantity(cell);
    if (weight <= 0n) {
      throw new Error(`nonpositive:${cell}`);
    }
    return cell;
  } catch {
    throw new StatementParseError(
      `invalid_weight:${column}:${cell}:row_${rowNumber}`,
    );
  }
}

/** A non-empty identity cell (model ids, event ids, payees). */
function identityCell(
  values: ReadonlyMap<string, string>,
  column: string,
  rowNumber: number,
): string {
  const cell = requiredCell(values, column, rowNumber);
  if (cell.length === 0) {
    throw new StatementParseError(`empty_identity:${column}:row_${rowNumber}`);
  }
  return cell;
}

/** An optional identity cell — present or empty. */
function optionalIdentityCell(
  values: ReadonlyMap<string, string>,
  column: string,
): string | null {
  const cell = values.get(column)?.trim() ?? "";
  return cell === "" ? null : cell;
}

/** The bounded addendum 8 usage-unit vocabulary. */
function usageUnitCell(
  values: ReadonlyMap<string, string>,
  rowNumber: number,
): AiUsageUnit {
  const cell = requiredCell(values, "Usage Unit", rowNumber).toLowerCase();
  if (!isAiUsageUnit(cell)) {
    throw new StatementParseError(`invalid_usage_unit:${cell}:row_${rowNumber}`);
  }
  return cell;
}

/** The voice lane's unit — per-character or per-minute, never tokens (a
 * token-priced synthetic-voice row is a hostile licensing deal). */
function voiceUsageUnitCell(
  values: ReadonlyMap<string, string>,
  rowNumber: number,
): AiVoiceUsageUnit {
  const cell = requiredCell(values, "Usage Unit", rowNumber).toLowerCase();
  if (!isAiVoiceUsageUnit(cell)) {
    throw new StatementParseError(
      `invalid_voice_usage_unit:${cell}:row_${rowNumber}`,
    );
  }
  return cell;
}

/** The bounded contributor-class vocabulary. */
function contributorClassCell(
  values: ReadonlyMap<string, string>,
  rowNumber: number,
): AiContributorClass {
  const cell = requiredCell(values, "Contributor Class", rowNumber)
    .trim()
    .toLowerCase();
  if (!isAiContributorClass(cell)) {
    throw new StatementParseError(
      `invalid_contributor_class:${cell}:row_${rowNumber}`,
    );
  }
  return cell;
}

/** The report/read date cell — an ISO calendar date; the period bucket is
 * the date's own `YYYY-MM` prefix (the webtoon profiles' parser). */
function periodFromDateCell(
  values: ReadonlyMap<string, string>,
  column: string,
  rowNumber: number,
): string {
  const cell = requiredCell(values, column, rowNumber);
  const parsed = new Date(`${cell}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cell) || Number.isNaN(parsed.getTime())) {
    throw new StatementParseError(`invalid_date:${cell}:row_${rowNumber}`);
  }
  return cell.slice(0, 7);
}

/** The currency cell — required, uppercased. */
function currencyCell(
  values: ReadonlyMap<string, string>,
  rowNumber: number,
): string {
  return requiredCell(values, "Currency", rowNumber).toUpperCase();
}

/**
 * Assembles one AI line. grossMicros is the line's gross FIAT revenue —
 * the total API token revenue on billing/telemetry rows, the quantity ×
 * rate licensing fee on voice rows, and exactly 0 on attribution-log rows
 * (a registry row reports weights, never money; the pool posts through
 * the distribution legs, once per pool event).
 */
function aiLine(
  profile: StatementProfile["kind"],
  rowNumber: number,
  currency: string,
  grossMicros: bigint,
  detail: AiLineDetail,
  usageNote: string,
  raw: readonly string[],
): ParsedStatementLine {
  return {
    lineNumber: rowNumber,
    profile,
    rightsType: AI_RIGHTS_TYPE,
    statementSourceType: AI_SOURCE_TYPE,
    tierLevel: null,
    // Inert on quarantined rows — the film/podcast precedent; the column
    // only carries the four music/DSP pipelines and the split engines never
    // read it for rights_type-'unknown' lines.
    rightsPipeline: "master_digital_performance",
    // The row's own period bucket — the usage event's fingerprint period.
    period: detail.period,
    currency,
    grossMicros,
    isAdjustment: grossMicros < 0n,
    // AI rows key on the model registry, not the vault's asset identifiers
    // — the ai_model_id column is the attribution key.
    identifiers: {},
    workTitle: null,
    territory: null,
    platform: null,
    usageNote,
    raw,
    guildResidual: null,
    podcastDetail: null,
    gamingDetail: null,
    livestreamDetail: null,
    webtoonDetail: null,
    merchDetail: null,
    aiDetail: detail,
  };
}

/** The usage note — provenance naming the row's kind and its audit cells. */
function inferenceUsageNote(detail: Extract<AiLineDetail, { kind: "inference_billing" }>): string {
  const attribution =
    detail.contributorPayeeId === null
      ? "unattributed (registry fallback)"
      : `contributor ${detail.contributorPayeeId} @ weight ${detail.datasetAttributionWeight ?? ""}`;
  return (
    `ai inference — ${detail.modelId} ${detail.usageUnit} ${detail.usageQuantity}` +
    ` @ ${detail.ratePerUnitMicros} micros, revenue ${detail.totalRevenueMicros} micros,` +
    ` ${attribution}`
  );
}

// ---------------------------------------------------------------------------
// OpenAI / custom LLM billing log — metered token/character/minute usage
// priced at the recorded rate, revenue self-reconciled, one row per
// (usage event, contributor).
// ---------------------------------------------------------------------------

const OPENAI_BILLING_HEADER = [
  "Event ID",
  "Model ID",
  "Usage Unit",
  "Usage Quantity",
  "Rate Per Unit",
  "Total Revenue",
  "Contributor Payee ID",
  "Contributor Payee Name",
  "Dataset Attribution Weight",
  "Currency",
  "Date",
] as const;

/** The per-event cells every row of one usage event must agree on — a
 * billing log whose rows disagree about the event's own usage is hostile
 * whole (the KENP rate-consistency discipline). */
interface InferenceEventFacts {
  readonly modelId: string;
  readonly usageUnit: AiUsageUnit;
  readonly usageQuantity: string;
  readonly ratePerUnitMicros: string;
  readonly totalRevenueMicros: string;
  readonly currency: string;
  readonly period: string;
}

function parseInferenceBillingRows(
  profileKind: StatementProfile["kind"],
  header: readonly string[],
  eventIdColumn: string,
  content: string,
): readonly ParsedStatementLine[] {
  const rows = readStrictTable(content, CSV, header);
  const eventFacts = new Map<string, InferenceEventFacts>();
  const eventContributors = new Map<string, Set<string>>();
  const lines: ParsedStatementLine[] = [];

  rows.forEach((values, index) => {
    const rowNumber = index + 1;
    const usageEventId = identityCell(values, eventIdColumn, rowNumber);
    const modelId = identityCell(values, "Model ID", rowNumber);
    const usageUnit = usageUnitCell(values, rowNumber);
    const quantityMicros = positiveQuantityCell(
      values,
      "Usage Quantity",
      rowNumber,
    );
    const rateMicros = positiveMoneyCell(values, "Rate Per Unit", rowNumber);
    const revenueMicros = positiveMoneyCell(values, "Total Revenue", rowNumber);
    const currency = currencyCell(values, rowNumber);
    const period = periodFromDateCell(values, "Date", rowNumber);

    // The self-reconciliation — the sender's reported revenue must equal
    // quantity × rate EXACTLY (the consignment discipline; a reporting
    // error is a hostile row, never a rounding note).
    const computed = meteredUsageRevenueMicros(quantityMicros, rateMicros);
    if (computed !== revenueMicros) {
      throw new StatementParseError(
        `revenue_reconciliation_mismatch:${eventIdColumn}:${usageEventId}` +
          `:${computed.toString()}:${revenueMicros.toString()}:row_${rowNumber}`,
      );
    }

    // The per-event consistency — one event's usage facts are one fact.
    const facts: InferenceEventFacts = {
      modelId,
      usageUnit,
      usageQuantity: requiredCell(values, "Usage Quantity", rowNumber),
      ratePerUnitMicros: rateMicros.toString(),
      totalRevenueMicros: revenueMicros.toString(),
      currency,
      period,
    };
    const existing = eventFacts.get(usageEventId);
    if (existing === undefined) {
      eventFacts.set(usageEventId, facts);
      eventContributors.set(usageEventId, new Set());
    } else {
      const consistent =
        existing.modelId === facts.modelId &&
        existing.usageUnit === facts.usageUnit &&
        existing.usageQuantity === facts.usageQuantity &&
        existing.ratePerUnitMicros === facts.ratePerUnitMicros &&
        existing.totalRevenueMicros === facts.totalRevenueMicros &&
        existing.currency === facts.currency &&
        existing.period === facts.period;
      if (!consistent) {
        throw new StatementParseError(
          `inconsistent_usage_event:${eventIdColumn}:${usageEventId}:row_${rowNumber}`,
        );
      }
    }

    const contributorPayeeId = optionalIdentityCell(
      values,
      "Contributor Payee ID",
    );
    const contributorPayeeName = optionalIdentityCell(
      values,
      "Contributor Payee Name",
    );
    const datasetAttributionWeight = optionalWeightCell(
      values,
      "Dataset Attribution Weight",
      rowNumber,
    );

    // A contributor row carries ALL THREE cells; an unattributed row
    // carries none. An event mixing the two shapes is caught by the
    // whole-file pass below — one event's attribution posture is one fact.
    if (
      contributorPayeeId === null &&
      contributorPayeeName === null &&
      datasetAttributionWeight === null
    ) {
      const detail: AiLineDetail = {
        kind: "inference_billing",
        usageEventId,
        modelId,
        usageUnit,
        usageQuantity: facts.usageQuantity,
        ratePerUnitMicros: facts.ratePerUnitMicros,
        totalRevenueMicros: facts.totalRevenueMicros,
        contributorPayeeId: null,
        contributorPayeeName: null,
        datasetAttributionWeight: null,
        period: facts.period,
      };
      lines.push(
        aiLine(
          profileKind,
          rowNumber,
          facts.currency,
          revenueMicros,
          detail,
          inferenceUsageNote(detail),
          header.map((column) => values.get(column) ?? ""),
        ),
      );
      return;
    }
    if (
      contributorPayeeId === null ||
      contributorPayeeName === null ||
      datasetAttributionWeight === null
    ) {
      throw new StatementParseError(
        `partial_contributor_cells:${eventIdColumn}:${usageEventId}:row_${rowNumber}`,
      );
    }

    // One row per (event, contributor) — a duplicate is a hostile rewrite.
    const eventRows = eventContributors.get(usageEventId)!;
    if (eventRows.has(contributorPayeeId)) {
      throw new StatementParseError(
        `duplicate_event_contributor:${eventIdColumn}:${usageEventId}:${contributorPayeeId}:row_${rowNumber}`,
      );
    }
    eventRows.add(contributorPayeeId);

    const detail: AiLineDetail = {
      kind: "inference_billing",
      usageEventId,
      modelId,
      usageUnit,
      usageQuantity: facts.usageQuantity,
      ratePerUnitMicros: facts.ratePerUnitMicros,
      totalRevenueMicros: facts.totalRevenueMicros,
      contributorPayeeId,
      contributorPayeeName,
      datasetAttributionWeight,
      period: facts.period,
    };
    lines.push(
      aiLine(
        profileKind,
        rowNumber,
        facts.currency,
        revenueMicros,
        detail,
        inferenceUsageNote(detail),
        header.map((column) => values.get(column) ?? ""),
      ),
    );
  });

  // An event mixing an unattributed row with contributor rows is hostile —
  // the unattributed row's presence means the sender claims the event has
  // no attribution; the contributor rows claim otherwise.
  const seenEvents = new Map<string, { unattributed: boolean; attributed: boolean }>();
  for (const line of lines) {
    const detail = line.aiDetail;
    if (detail?.kind !== "inference_billing") continue;
    const state = seenEvents.get(detail.usageEventId) ?? {
      unattributed: false,
      attributed: false,
    };
    if (detail.contributorPayeeId === null) state.unattributed = true;
    else state.attributed = true;
    seenEvents.set(detail.usageEventId, state);
  }
  for (const [usageEventId, state] of seenEvents) {
    if (state.unattributed && state.attributed) {
      throw new StatementParseError(
        `mixed_attribution_shapes:${eventIdColumn}:${usageEventId}`,
      );
    }
  }

  return lines;
}

const openaiBillingProfile: StatementProfile = {
  kind: "openai_llm_billing_log_csv",
  title: "OpenAI / custom LLM billing log CSV (metered token/character/minute usage)",
  laneRightsType: AI_RIGHTS_TYPE,
  statementSourceType: AI_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, OPENAI_BILLING_HEADER),
  parse: (content) =>
    parseInferenceBillingRows(
      "openai_llm_billing_log_csv",
      OPENAI_BILLING_HEADER,
      "Event ID",
      content,
    ),
};

// ---------------------------------------------------------------------------
// Weights & Biases inference telemetry — the same usage facts from the
// telemetry sender, keyed by Run ID.
// ---------------------------------------------------------------------------

const WANDB_TELEMETRY_HEADER = [
  "Run ID",
  "Model ID",
  "Usage Unit",
  "Usage Quantity",
  "Rate Per Unit",
  "Total Revenue",
  "Contributor Payee ID",
  "Contributor Payee Name",
  "Dataset Attribution Weight",
  "Currency",
  "Date",
] as const;

const wandbTelemetryProfile: StatementProfile = {
  kind: "wandb_inference_telemetry_csv",
  title: "Weights & Biases inference telemetry CSV (metered usage by run)",
  laneRightsType: AI_RIGHTS_TYPE,
  statementSourceType: AI_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, WANDB_TELEMETRY_HEADER),
  parse: (content) =>
    parseInferenceBillingRows(
      "wandb_inference_telemetry_csv",
      WANDB_TELEMETRY_HEADER,
      "Run ID",
      content,
    ),
};

// ---------------------------------------------------------------------------
// ElevenLabs voice clone licensing — synthetic voice stream events priced
// per character/minute, routed directly to the voice actor of record.
// ---------------------------------------------------------------------------

const VOICE_LICENSING_HEADER = [
  "Event ID",
  "Voice ID",
  "Model ID",
  "Voice Actor Payee ID",
  "Voice Actor Payee Name",
  "Usage Unit",
  "Usage Quantity",
  "Rate Per Unit",
  "Currency",
  "Date",
] as const;

const voiceLicensingProfile: StatementProfile = {
  kind: "elevenlabs_voice_clone_licensing_csv",
  title: "ElevenLabs voice clone licensing CSV (synthetic voice stream events)",
  laneRightsType: AI_RIGHTS_TYPE,
  statementSourceType: AI_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, VOICE_LICENSING_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, VOICE_LICENSING_HEADER);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      const usageEventId = identityCell(values, "Event ID", rowNumber);
      const voiceId = identityCell(values, "Voice ID", rowNumber);
      const modelId = identityCell(values, "Model ID", rowNumber);
      const voiceActorPayeeId = identityCell(
        values,
        "Voice Actor Payee ID",
        rowNumber,
      );
      const voiceActorPayeeName = identityCell(
        values,
        "Voice Actor Payee Name",
        rowNumber,
      );
      const usageUnit = voiceUsageUnitCell(values, rowNumber);
      const quantityMicros = positiveQuantityCell(
        values,
        "Usage Quantity",
        rowNumber,
      );
      const rateMicros = positiveMoneyCell(values, "Rate Per Unit", rowNumber);
      const currency = currencyCell(values, rowNumber);
      const period = periodFromDateCell(values, "Date", rowNumber);

      // The DIRECT licensing fee — quantity × the recorded rate, exact
      // bigint math; the rate rides the row verbatim (the founder's
      // rate-logging rule: a conversion at an unrecorded rate cannot be
      // audited, so the applied rate IS the row's cell).
      const feeMicros = meteredUsageRevenueMicros(quantityMicros, rateMicros);
      const detail: AiLineDetail = {
        kind: "voice_licensing",
        usageEventId,
        voiceId,
        modelId,
        voiceActorPayeeId,
        voiceActorPayeeName,
        usageUnit,
        usageQuantity: requiredCell(values, "Usage Quantity", rowNumber),
        ratePerUnitMicros: rateMicros.toString(),
        period,
      };
      return aiLine(
        "elevenlabs_voice_clone_licensing_csv",
        rowNumber,
        currency,
        feeMicros,
        detail,
        `ai voice licensing — voice ${voiceId} model ${modelId}` +
          ` ${usageUnit} ${detail.usageQuantity}` +
          ` @ ${detail.ratePerUnitMicros} micros → ${voiceActorPayeeId} (direct)`,
        VOICE_LICENSING_HEADER.map((column) => values.get(column) ?? ""),
      );
    });
  },
};

// ---------------------------------------------------------------------------
// Hugging Face dataset attribution log — one row per (model, contributor)
// registering class + token weight; an optional single data pool royalty
// per file, distributed pro-rata by token weight.
// ---------------------------------------------------------------------------

const DATASET_ATTRIBUTION_HEADER = [
  "Model ID",
  "Attribution Event ID",
  "Contributor Payee ID",
  "Contributor Payee Name",
  "Contributor Class",
  "Dataset Token Weight",
  "Pool Event ID",
  "Data Pool Royalty",
  "Currency",
  "Date",
] as const;

const datasetAttributionProfile: StatementProfile = {
  kind: "huggingface_dataset_attribution_log_csv",
  title: "Hugging Face dataset attribution log CSV (contributor weights + pool royalty)",
  laneRightsType: AI_RIGHTS_TYPE,
  statementSourceType: AI_SOURCE_TYPE,
  tierLevel: null,
  matches: (content) =>
    sniffHeaderMatches(content, CSV, DATASET_ATTRIBUTION_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, DATASET_ATTRIBUTION_HEADER);
    // The pool layout is file-level: either every row declares the same
    // single pool event, or no row declares any. Pool Event ID and Data
    // Pool Royalty are all-or-nothing, jointly.
    let poolEventId: string | null = null;
    let poolRoyaltyMicros: string | null = null;
    const seenContributors = new Set<string>();

    return rows.map((values, index) => {
      const rowNumber = index + 1;
      const modelId = identityCell(values, "Model ID", rowNumber);
      const attributionEventId = identityCell(
        values,
        "Attribution Event ID",
        rowNumber,
      );
      const contributorPayeeId = identityCell(
        values,
        "Contributor Payee ID",
        rowNumber,
      );
      const contributorPayeeName = identityCell(
        values,
        "Contributor Payee Name",
        rowNumber,
      );
      const contributorClass = contributorClassCell(values, rowNumber);
      const datasetTokenWeight = requiredCell(
        values,
        "Dataset Token Weight",
        rowNumber,
      );
      const weightMicros = positiveQuantityCell(
        values,
        "Dataset Token Weight",
        rowNumber,
      );
      const currency = currencyCell(values, rowNumber);
      const period = periodFromDateCell(values, "Date", rowNumber);

      // The registry identity — one row per (model, attribution event); a
      // duplicate is a hostile rewrite of the attribution record.
      const rowIdentity = `${modelId}:${attributionEventId}`;
      if (seenContributors.has(rowIdentity)) {
        throw new StatementParseError(
          `duplicate_attribution_row:${rowIdentity}:row_${rowNumber}`,
        );
      }
      seenContributors.add(rowIdentity);

      const rowPoolEventId = optionalIdentityCell(values, "Pool Event ID");
      const rowPoolRoyaltyCell = values.get("Data Pool Royalty")?.trim() ?? "";
      if ((rowPoolEventId === null) !== (rowPoolRoyaltyCell === "")) {
        throw new StatementParseError(
          `partial_pool_cells:row_${rowNumber}`,
        );
      }
      if (rowPoolEventId !== null) {
        const rowPoolRoyalty = positiveMoneyCell(
          values,
          "Data Pool Royalty",
          rowNumber,
        );
        if (poolEventId === null) {
          poolEventId = rowPoolEventId;
          poolRoyaltyMicros = rowPoolRoyalty.toString();
        } else if (
          poolEventId !== rowPoolEventId ||
          poolRoyaltyMicros !== rowPoolRoyalty.toString()
        ) {
          // One pool event per file, one amount — a file whose rows
          // disagree on the pool is hostile whole (the KENP discipline).
          throw new StatementParseError(
            `inconsistent_pool_event:${rowPoolEventId}:row_${rowNumber}`,
          );
        }
      }

      const detail: AiLineDetail = {
        kind: "dataset_attribution",
        modelId,
        attributionEventId,
        contributorPayeeId,
        contributorPayeeName,
        contributorClass,
        datasetTokenWeight,
        poolEventId,
        poolRoyaltyMicros,
        period,
      };
      return aiLine(
        "huggingface_dataset_attribution_log_csv",
        rowNumber,
        currency,
        // Zero gross — the registry row reports weights, never money; the
        // pool royalty posts through the distribution legs, once per pool
        // event (the reader-log zero-gross precedent).
        0n,
        detail,
        `ai dataset attribution — ${modelId} contributor ${contributorPayeeId}` +
          ` (${contributorClass}, weight ${datasetTokenWeight},` +
          ` ${weightMicros.toString()} micros)` +
          (poolEventId === null
            ? ""
            : `, pool ${poolEventId} @ ${poolRoyaltyMicros ?? ""} micros`),
        DATASET_ATTRIBUTION_HEADER.map((column) => values.get(column) ?? ""),
      );
    });
  },
};

/** The AI lane's dispatch guard — the four strict CSV senders (PR 24).
 * The dispatch ORDER in worker.ts keeps the generic music path unreachable
 * from these kinds: they branch before it. */
export function isAiProfileKind(kind: StatementProfile["kind"]): boolean {
  return (
    kind === "openai_llm_billing_log_csv" ||
    kind === "wandb_inference_telemetry_csv" ||
    kind === "elevenlabs_voice_clone_licensing_csv" ||
    kind === "huggingface_dataset_attribution_log_csv"
  );
}

/** The AI lane's profiles, in dispatch order. */
export const AI_PROFILES: readonly StatementProfile[] = [
  openaiBillingProfile,
  wandbTelemetryProfile,
  voiceLicensingProfile,
  datasetAttributionProfile,
];
