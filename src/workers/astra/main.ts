/**
 * CVT Astra extraction agent — standalone entry (npm run worker:astra).
 *
 * Wires the sweep to the production surfaces: getStore() for the vault
 * rows, the statement_ingests inserts, and the recon-job enqueues; the
 * process environment for the session mode and the RECON_VISION_* seam
 * (PR 2's env contract — one definition). Credentials live in memory per
 * traversal only; the log line carries counts and ids, never secrets and
 * never artifact content.
 *
 * Session selection: ASTRA_BASE_URL set → headless Playwright against the
 * live dashboards; unset → the recorded fixture catalog (a dry-run — the
 * same engine, observable without a browser). Bounded runs use
 * ASTRA_SWEEP_MAX_CYCLES (0 = poll forever); SIGINT/SIGTERM set the stop
 * flag so the current sweep finishes cleanly.
 */

import { getStore } from "@/lib/server/store";

import { assertProfilesMatchVaultSources } from "./profiles";
import {
  loadFixtureCatalogFromDisk,
  openFixtureSession,
  openPlaywrightSession,
} from "./session";
import type { DashboardSession } from "./session";
import { runAstraSweep, type AstraWorkerDeps } from "./worker";

const POLL_INTERVAL_MS = Number(process.env.RECON_POLL_INTERVAL_MS ?? 60_000);
const LIVE_BASE_URL = process.env.ASTRA_BASE_URL ?? "";
const FIXTURE_ROOT = process.env.ASTRA_FIXTURE_ROOT ?? "";

function log(message: string): void {
  // Console is the lane's only output — counts and ids, no secrets.
  console.log(`[astra] ${message}`);
}

// The seam hands the sweep's profile to per-driver factories that branch on
// it; today's drivers are catalog-wide, so the factory takes no parameters
// (fewer-params functions satisfy the seam's signature).
async function openSweepSession(): Promise<DashboardSession> {
  if (LIVE_BASE_URL.length > 0) {
    return openPlaywrightSession({ baseUrl: LIVE_BASE_URL });
  }
  if (FIXTURE_ROOT.length > 0) {
    return openFixtureSession(await loadFixtureCatalogFromDisk(FIXTURE_ROOT));
  }
  throw new Error(
    "astra_unconfigured: set ASTRA_BASE_URL for live traversals or ASTRA_FIXTURE_ROOT for a fixture dry-run",
  );
}

function buildDeps(): AstraWorkerDeps {
  return { store: getStore(), openSession: openSweepSession };
}

async function main(): Promise<void> {
  // Boot-time drift guard: the vault vocabulary and the adapter registry
  // must agree before the first sweep (the test pins it too; production
  // fails loudly rather than skipping dashboards).
  assertProfilesMatchVaultSources();

  const raw = process.env.ASTRA_SWEEP_MAX_CYCLES ?? "0";
  const parsed = Number.parseInt(raw, 10);
  const maxCycles = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;

  let stopping = false;
  const requestStop = (): void => {
    stopping = true;
  };
  process.on("SIGINT", requestStop);
  process.on("SIGTERM", requestStop);

  const deps = buildDeps();
  log(`sweep loop started (poll ${POLL_INTERVAL_MS}ms)`);
  for (let cycles = 0; !stopping; cycles += 1) {
    try {
      const { summary } = await runAstraSweep(deps);
      log(
        `sweep: ${summary.traversed} connections — ` +
          `${summary.extracted} extracted, ${summary.noStatements} empty, ` +
          `${summary.failed} failed; ${summary.statementsCaptured} statements, ` +
          `${summary.jobsEnqueued} recon jobs enqueued`,
      );
    } catch (error) {
      // The sweep loop never dies on a cycle failure — the next poll is
      // the recovery. Errors are already redacted upstream.
      log(`sweep cycle failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (maxCycles > 0 && cycles + 1 >= maxCycles) {
      break;
    }
    if (stopping) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  log("sweep loop stopped");
}

main().catch((error: unknown) => {
  console.error("[astra] fatal:", error instanceof Error ? error.message : error);
  process.exit(1);
});
