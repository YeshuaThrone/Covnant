import { getCovenantRegistry } from "@/lib/server/covenantRegistry";
import { CovenantExternalDataIngestionEngine } from "../external-data-connectors";
import type { LuminateConsumptionPayload } from "../external-data-connectors";
import { CovenantMasterEngineFacade } from "../facade";
import { asRecord, fail, ok, type RouteResult } from "./result";

export type SweepLuminateBody = {
  ok: true;
  recoveredRevenueCents: number;
  matchesFound: number;
  disputes: number;
  recordsIngested: number;
};

function isPayload(value: unknown): value is LuminateConsumptionPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return typeof row.luminateId === "string" && typeof row.songTitle === "string";
}

/**
 * Express `luminateRoutes` — POST /luminate under `/api/v1/sweeper`.
 * Does not call live Luminate HTTP.
 */
export async function sweepLuminate(
  body: unknown,
): Promise<RouteResult<SweepLuminateBody>> {
  const row = asRecord(body);
  if (!row) {
    return fail(400, "malformed_body", "Request body must be a JSON object.");
  }
  if (!Array.isArray(row.payloads)) {
    return fail(400, "malformed_body", "payloads must be an array.");
  }
  const payloads = row.payloads.filter(isPayload);
  if (payloads.length === 0) {
    return fail(
      400,
      "malformed_body",
      "payloads must include luminateId and songTitle.",
    );
  }

  const rate = row.estimatedPerStreamRateMicros;
  if (
    rate !== undefined &&
    (typeof rate !== "number" || !Number.isSafeInteger(rate) || rate < 0)
  ) {
    return fail(
      400,
      "invalid_rate",
      "estimatedPerStreamRateMicros must be a whole number of USD micros.",
    );
  }

  const records = new CovenantExternalDataIngestionEngine().parseLuminateConsumptionData(
    payloads,
    typeof rate === "number" ? rate : undefined,
  );
  const registry = getCovenantRegistry();
  const result = await new CovenantMasterEngineFacade().executeSystemSweep(
    "",
    "",
    registry.listWorks(),
    records,
  );
  registry.recordSweep(result);
  return ok({
    ok: true,
    recoveredRevenueCents: result.sweeperSummary.totalRecoveredRevenueCents,
    matchesFound: result.sweeperSummary.matches.length,
    disputes: result.disputesEncountered.length,
    recordsIngested: records.length,
  });
}

const luminateRoutes = {
  post: sweepLuminate,
};

export default luminateRoutes;
