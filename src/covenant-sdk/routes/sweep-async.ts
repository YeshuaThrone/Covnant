import { sweepQueue } from "@/queues/sweepQueue";
import { fail, ok, parseCwrDsrRequest, type RouteResult } from "./result";

export type SweepAsyncBody = {
  ok: true;
  jobId: string;
  status: "drained";
  recoveredRevenueCents: number;
  matchesFound: number;
  disputes: number;
};

/**
 * Express `sweepAsyncRoutes` — POST /async under `/api/v1/sweeper`.
 * Sandbox queue is in-memory; drain is process-local (no Redis/BullMQ).
 */
export async function sweepAsync(
  body: unknown,
): Promise<RouteResult<SweepAsyncBody>> {
  const parsed = parseCwrDsrRequest(body, "");
  if (!parsed.ok) {
    return parsed;
  }
  const queued = await sweepQueue.add("blackbox-sweeps", {
    jobId: parsed.body.jobId,
    cwrRawFeed: parsed.body.cwrRawFeed,
    dsrRawFeed: parsed.body.dsrRawFeed,
  });
  const drained = await sweepQueue.drain();
  const processed = drained[0];
  if (!processed || !processed.ok) {
    return fail(
      500,
      processed && !processed.ok ? processed.code : "sweep_failed",
      processed && !processed.ok
        ? processed.message
        : "Queue drain returned no job.",
    );
  }
  return ok(
    {
      ok: true,
      jobId: queued.id,
      status: "drained",
      recoveredRevenueCents: processed.recoveredRevenueCents,
      matchesFound: processed.matchesFound,
      disputes: processed.disputes,
    },
    202,
  );
}

const sweepAsyncRoutes = {
  post: sweepAsync,
};

export default sweepAsyncRoutes;
