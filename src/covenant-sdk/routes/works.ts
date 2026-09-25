import { CovenantDistributionEngine } from "../distribution";
import { parseWorkRegistration } from "../manifest-parse";
import { dispatchCovenantWebhook } from "../outbound-webhook";
import type { UniversalWorkManifest } from "../types";
import { getCovenantRegistry } from "@/lib/server/covenantRegistry";
import { fail, ok, type RouteResult } from "./result";

export type RegisterWorkBody = {
  ok: true;
  work: UniversalWorkManifest;
  codeCount: number;
};

export type ListWorksBody = {
  ok: true;
  works: UniversalWorkManifest[];
};

/**
 * Express `workRoutes` — POST / and GET / under `/api/v1/works`.
 */
export async function registerWork(
  body: unknown,
): Promise<RouteResult<RegisterWorkBody>> {
  const registry = getCovenantRegistry();
  const parsed = parseWorkRegistration(body, registry.occupiedWorkIds());
  if (!parsed.ok) {
    const status = parsed.code === "work_exists" ? 409 : 400;
    return fail(status, parsed.code, parsed.message);
  }

  const registered = await new CovenantDistributionEngine().registerWork(
    parsed.manifest,
  );
  if (!registered.ok) {
    return fail(422, registered.code, registered.message);
  }

  registry.registerWork(parsed.manifest);
  await dispatchCovenantWebhook("work.registered", {
    work: parsed.manifest,
    codeCount: registered.codeCount,
  });
  return ok(
    {
      ok: true,
      work: parsed.manifest,
      codeCount: registered.codeCount,
    },
    201,
  );
}

export function listWorks(): RouteResult<ListWorksBody> {
  return ok({
    ok: true,
    works: getCovenantRegistry().listWorks(),
  });
}

const workRoutes = {
  post: registerWork,
  get: listWorks,
};

export default workRoutes;
