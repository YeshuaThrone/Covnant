/**
 * CVT recon worker — vision engine seam (fail-closed).
 *
 * Spec art_7M0snhxc: the vision/computer-use engine exists only for
 * PDF/image statement formats and is env-gated enrichment — it flips on
 * with a key + endpoint, no code change. A job that needs it while the
 * engine is unconfigured fails honestly (`vision engine not configured`);
 * a configured engine whose response is unusable fails the job too — never
 * a partial parse.
 *
 * The worker never links a vendor SDK: the seam is one HTTP POST whose
 * contract is the worker's own normalized-row JSON, so any engine (the
 * directive's "GPT-6 Astra" or otherwise) plugs in by configuration.
 */

import type { ParsedStatementLine } from "./records";

/** The env names the seam reads — all three set means configured. */
export interface VisionEngineConfig {
  url: string;
  apiKey: string;
  model: string;
}

/** Reads RECON_VISION_* from the environment (injectable for tests). */
export function readVisionEngineConfig(env: NodeJS.ProcessEnv = process.env): VisionEngineConfig | null {
  const url = env.RECON_VISION_URL?.trim() ?? "";
  const apiKey = env.RECON_VISION_API_KEY?.trim() ?? "";
  const model = env.RECON_VISION_MODEL?.trim() ?? "";
  if (url === "" || apiKey === "" || model === "") return null;
  return { url, apiKey, model };
}

/** PDF/image content — the deterministic delimited profiles cannot read it. */
export function looksLikePdfOrImage(content: string): boolean {
  const head = content.slice(0, 8).replace(/^\uFEFF/, "");
  return (
    head.startsWith("%PDF-") ||
    // PNG or JPEG bytes riding a text column decode with replacement
    // characters — sniff the damaged signatures too.
    head.startsWith("\uFFFDPNG") ||
    content.slice(0, 4).includes("\uFFFD\uFFFD") ||
    content.includes("\uFFFDJFIF")
  );
}

/** The seam's outcome — a full normalized parse or a named failure. */
export type VisionEngineOutcome =
  | { ok: true; lines: readonly ParsedStatementLine[]; model: string }
  | { ok: false; reason: string };

/**
 * Calls the configured vision engine with the statement's raw content and
 * validates its response. `fetchJson` is injectable for the stub-engine
 * tests; production uses the global fetch.
 */
export async function runVisionEngine(
  content: string,
  fileName: string,
  config: VisionEngineConfig,
  fetchJson: (url: string, init: RequestInit) => Promise<unknown> = defaultFetchJson,
): Promise<VisionEngineOutcome> {
  let response: unknown;
  try {
    response = await fetchJson(config.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({ model: config.model, file_name: fileName, content }),
    });
  } catch (error) {
    return {
      ok: false,
      reason: `vision engine failed: ${error instanceof Error ? error.message : "request error"}`,
    };
  }
  const lines = validateVisionResponse(response);
  if (!lines.ok) return { ok: false, reason: `vision engine failed: ${lines.reason}` };
  return { ok: true, lines: lines.value, model: config.model };
}

async function defaultFetchJson(url: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`engine responded ${response.status}`);
  }
  return response.json() as unknown;
}

/** Strict validation of the engine's normalized-row array. */
function validateVisionResponse(
  response: unknown,
): { ok: true; value: readonly ParsedStatementLine[] } | { ok: false; reason: string } {
  if (!Array.isArray(response)) return { ok: false, reason: "response is not an array" };
  const lines: ParsedStatementLine[] = [];
  const seenLineNumbers = new Set<number>();
  for (const row of response) {
    const line = validateVisionLine(row);
    if (!line.ok) return { ok: false, reason: `invalid engine row: ${line.reason}` };
    // Duplicate row numbers would collapse into one event_id — the second
    // row would then be silently dropped as a replay. The engine failed to
    // disambiguate its rows; fail closed instead of guessing.
    if (seenLineNumbers.has(line.value.lineNumber)) {
      return { ok: false, reason: `duplicate engine row number: ${line.value.lineNumber}` };
    }
    seenLineNumbers.add(line.value.lineNumber);
    lines.push(line.value);
  }
  return { ok: true, value: lines };
}

function validateVisionLine(
  row: unknown,
): { ok: true; value: ParsedStatementLine } | { ok: false; reason: string } {
  if (typeof row !== "object" || row === null) return { ok: false, reason: "row is not an object" };
  const r = row as Record<string, unknown>;
  if (typeof r.gross_micros !== "string" || r.gross_micros === "") {
    return { ok: false, reason: "gross_micros missing" };
  }
  if (!/^-?\d+$/.test(r.gross_micros)) return { ok: false, reason: "gross_micros not integer text" };
  if (typeof r.currency !== "string" || !/^[A-Z]{3}$/.test(r.currency)) {
    return { ok: false, reason: "currency invalid" };
  }
  if (r.statement_source_type !== null && r.statement_source_type !== undefined) {
    return { ok: false, reason: "engine rows cannot classify statement kinds" };
  }
  if (typeof r.line_number !== "number" || !Number.isInteger(r.line_number) || r.line_number < 0) {
    return { ok: false, reason: "line_number missing" };
  }
  const identifiers: ParsedStatementLine["identifiers"] = {};
  for (const kind of ["ISRC", "ISWC", "UPC", "EIDR"] as const) {
    const value = r[kind.toLowerCase()];
    if (typeof value === "string" && value.trim() !== "") {
      identifiers[kind] = value.trim();
    }
  }
  const grossMicros = BigInt(r.gross_micros);
  return {
    ok: true,
    value: {
      lineNumber: r.line_number,
      profile: "film_vod_csv", // provenance tag; engine rows bypass parse profiles
      rightsType: "unknown",
      statementSourceType: null,
      tierLevel: null,
      // Inert on quarantined rows — the split engines never read it for
      // rights_type-'unknown' lines.
      rightsPipeline: "master_digital_performance",
      period: typeof r.period === "string" && r.period !== "" ? r.period : null,
      currency: r.currency,
      grossMicros,
      isAdjustment: grossMicros < 0n,
      identifiers,
      workTitle: typeof r.work_title === "string" && r.work_title !== "" ? r.work_title : null,
      territory: typeof r.territory === "string" && r.territory !== "" ? r.territory : null,
      platform: typeof r.platform === "string" && r.platform !== "" ? r.platform : null,
      usageNote: "vision engine normalized row (PDF/image statement)",
      raw: [],
      guildResidual: null,
      podcastDetail: null,
      gamingDetail: null,
    },
  };
}
