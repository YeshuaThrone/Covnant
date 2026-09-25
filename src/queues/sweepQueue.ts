import { createHash } from "node:crypto";
/** Import facade directly — the production-sdk barrel must not load HTTP routers. */
import {
  CovenantMasterEngineFacade,
  type SystemSweepResult,
} from "@/covenant-sdk/facade";
import type { CovenantMcpRegistry } from "@/covenant-sdk/mcp-registry";
import type { UnclaimedRoyaltyRecord } from "@/covenant-sdk/universal-blackbox-sweeper";
import { getCovenantRegistry } from "@/lib/server/covenantRegistry";

export type SweepJobData = {
  cwrRawFeed?: string;
  dsrRawFeed?: string;
  extraRecords?: UnclaimedRoyaltyRecord[];
  jobId: string;
};

export type SweepJobOk = {
  ok: true;
  jobId: string;
  recoveredRevenueCents: number;
  matchesFound: number;
  disputes: number;
  result: SystemSweepResult;
};

export type SweepJobErr = {
  ok: false;
  code: "sweep_failed";
  message: string;
  jobId: string;
};

export type SweepJobResult = SweepJobOk | SweepJobErr;

const DEFAULT_ATTEMPTS = 3;

function jobIdOf(data: SweepJobData): string {
  if (data.jobId.trim() !== "") {
    return data.jobId;
  }
  return `sweep_${createHash("sha256")
    .update(
      `${data.cwrRawFeed ?? ""}:${data.dsrRawFeed ?? ""}:${JSON.stringify(data.extraRecords ?? [])}`,
    )
    .digest("hex")
    .slice(0, 16)}`;
}

export type SweepProcessorDeps = {
  registry?: CovenantMcpRegistry;
  engine?: CovenantMasterEngineFacade;
  attempts?: number;
};

/**
 * Runs one black-box sweep against the sandbox registry and persists
 * matches, disputes, payouts, clearance notices, and audit proofs.
 * First-write-wins upserts. No Prisma. No Redis.
 */
export async function processSweepJob(
  data: SweepJobData,
  deps: SweepProcessorDeps = {},
): Promise<SweepJobResult> {
  const jobId = jobIdOf(data);
  const registry = deps.registry ?? getCovenantRegistry();
  const engine = deps.engine ?? new CovenantMasterEngineFacade();
  const attempts = deps.attempts ?? DEFAULT_ATTEMPTS;

  let lastError = "sweep_failed";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await engine.executeSystemSweep(
        data.cwrRawFeed ?? "",
        data.dsrRawFeed ?? "",
        registry.listWorks(),
        data.extraRecords ?? [],
      );
      registry.recordSweep(result);
      return {
        ok: true,
        jobId,
        recoveredRevenueCents: result.sweeperSummary.totalRecoveredRevenueCents,
        matchesFound: result.sweeperSummary.matches.length,
        disputes: result.disputesEncountered.length,
        result,
      };
    } catch (err: unknown) {
      lastError = err instanceof Error ? err.message : "unknown_error";
    }
  }

  return {
    ok: false,
    code: "sweep_failed",
    message: lastError,
    jobId,
  };
}

type JobListener = (jobId: string, err: SweepJobErr) => void;

/**
 * In-memory stand-in for BullMQ `blackbox-sweeps`.
 * Does not connect to Redis on import. Drain with `drain()`.
 */
export class SandboxSweepQueue {
  private readonly pending: SweepJobData[] = [];
  private readonly failedListeners: JobListener[] = [];

  public async add(
    _name: "blackbox-sweeps",
    data: SweepJobData,
  ): Promise<{ id: string }> {
    const jobId = jobIdOf(data);
    this.pending.push({ ...data, jobId });
    return { id: jobId };
  }

  public on(event: "failed", listener: JobListener): void {
    if (event === "failed") {
      this.failedListeners.push(listener);
    }
  }

  public async drain(deps: SweepProcessorDeps = {}): Promise<SweepJobResult[]> {
    const jobs = this.pending.splice(0);
    const results: SweepJobResult[] = [];
    for (const job of jobs) {
      const processed = await processSweepJob(job, deps);
      results.push(processed);
      if (!processed.ok) {
        for (const listener of this.failedListeners) {
          listener(processed.jobId, processed);
        }
      }
    }
    return results;
  }
}

export const sweepQueue = new SandboxSweepQueue();
export const sweepWorker = sweepQueue;
