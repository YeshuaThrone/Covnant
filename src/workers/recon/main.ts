/**
 * CVT recon worker — standalone entry (npm run worker:recon).
 *
 * Wires the loop to the production surfaces: getStore() for the durable
 * queue, the vault adapter's findByIdentifier over the app's pg pool when
 * DATABASE_URL is set (null otherwise — cross-reference is then skipped
 * and rows stay honestly unmatched), and the process environment for the
 * RECON_VISION_* seam. Bounded runs use RECON_WORKER_MAX_JOBS (0 = poll
 * forever); SIGINT/SIGTERM set the stop flag so the current pass finishes
 * cleanly — a hard kill mid-claim is covered by the store's stale-claim
 * recovery.
 */

import { getDb } from "@/lib/db";
import { findByIdentifier, type VaultAssetRecord } from "@/lib/covnant/vault";
import { getStore } from "@/lib/server/store";
import { runWorkerLoop, type ReconWorkerDeps } from "./worker";

function buildDeps(): ReconWorkerDeps {
  const db = getDb();
  const vault =
    db === null
      ? null
      : {
          findByIdentifier(
            kind: Parameters<typeof findByIdentifier>[1],
            value: string,
          ): Promise<VaultAssetRecord | null> {
            return findByIdentifier(db, kind, value);
          },
        };
  return { store: getStore(), vault };
}

async function main(): Promise<void> {
  const raw = process.env.RECON_WORKER_MAX_JOBS ?? "0";
  const parsed = Number.parseInt(raw, 10);
  const maxJobs = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;

  let stopping = false;
  process.on("SIGINT", () => {
    if (stopping) process.exit(0); // second signal: leave now
    stopping = true;
    console.log("[recon-worker] SIGINT — finishing the current pass");
  });
  process.on("SIGTERM", () => {
    if (stopping) process.exit(0);
    stopping = true;
    console.log("[recon-worker] SIGTERM — finishing the current pass");
  });

  await runWorkerLoop(buildDeps(), maxJobs, () => stopping);
  console.log("[recon-worker] run complete");
}

main().catch((error) => {
  console.error("[recon-worker] fatal:", error);
  process.exitCode = 1;
});
