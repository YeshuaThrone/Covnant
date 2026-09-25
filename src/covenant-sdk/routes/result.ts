export type RouteFailure = {
  ok: false;
  status: number;
  code: string;
  error: string;
};

export type RouteSuccess<T> = {
  ok: true;
  status: number;
  body: T;
};

export type RouteResult<T> = RouteSuccess<T> | RouteFailure;

export function fail(
  status: number,
  code: string,
  error: string,
): RouteFailure {
  return { ok: false, status, code, error };
}

export function ok<T>(body: T, status = 200): RouteSuccess<T> {
  return { ok: true, status, body };
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

export function feedOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export type CwrDsrSweepRequest = {
  cwrRawFeed: string;
  dsrRawFeed: string;
  jobId: string;
};

export function parseCwrDsrRequest(
  body: unknown,
  defaultJobId: string,
): RouteResult<CwrDsrSweepRequest> {
  const row = asRecord(body);
  if (!row) {
    return fail(400, "malformed_body", "Request body must be a JSON object.");
  }
  const cwrRawFeed = feedOf(row.cwrRawFeed);
  const dsrRawFeed = feedOf(row.dsrRawFeed);
  if (cwrRawFeed.trim() === "" && dsrRawFeed.trim() === "") {
    return fail(400, "missing_feed", "Provide cwrRawFeed and/or dsrRawFeed.");
  }
  return ok({
    cwrRawFeed,
    dsrRawFeed,
    jobId: typeof row.jobId === "string" ? row.jobId : defaultJobId,
  });
}
