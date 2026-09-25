import { processSweepJob } from "@/queues/sweepQueue";
import { fail, ok, parseCwrDsrRequest, type RouteResult } from "./result";

export type SweepDirectBody = {
  ok: true;
  jobId: string;
  recoveredRevenueCents: number;
  matchesFound: number;
  disputes: number;
};

/**
 * Express `sweepDirectRoutes` — POST / under `/api/v1/sweeper`.
 */
export async function sweepDirect(
  body: unknown,
): Promise<RouteResult<SweepDirectBody>> {
  const parsed = parseCwrDsrRequest(body, "sweep_direct");
  if (!parsed.ok) {
    return parsed;
  }
  const processed = await processSweepJob({
    jobId: parsed.body.jobId,
    cwrRawFeed: parsed.body.cwrRawFeed,
    dsrRawFeed: parsed.body.dsrRawFeed,
  });
  if (!processed.ok) {
    return fail(500, processed.code, processed.message);
  }
  return ok({
    ok: true,
    jobId: processed.jobId,
    recoveredRevenueCents: processed.recoveredRevenueCents,
    matchesFound: processed.matchesFound,
    disputes: processed.disputes,
  });
}

const sweepDirectRoutes = {
  post: sweepDirect,
};

export default sweepDirectRoutes;
