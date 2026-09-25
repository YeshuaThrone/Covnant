import { CovenantMasterEngineFacade } from "./facade";
import { CovenantMcpRegistry } from "./mcp-registry";
import { parseWorkRegistration } from "./manifest-parse";
import { CovenantDistributionEngine } from "./distribution";
import { CovenantExternalDataIngestionEngine } from "./external-data-connectors";
import type { LuminateConsumptionPayload } from "./external-data-connectors";
import { asRecord } from "./routes/result";

export const COVENANT_MCP_TOOLS = [
  {
    name: "register_work_manifest",
    description:
      "POST /api/v1/works — register a sandbox work manifest. Required before a sweep can match.",
    inputSchema: {
      type: "object",
      properties: {
        manifest: { type: "object", description: "UniversalWorkManifest JSON" },
      },
      required: ["manifest"],
    },
  },
  {
    name: "list_work_manifests",
    description: "GET /api/v1/works — list registered sandbox work manifests.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "trigger_blackbox_sweep",
    description:
      "POST /api/v1/sweeper — run the black-box sweeper against raw CWR or DSR feeds.",
    inputSchema: {
      type: "object",
      properties: {
        cwrRawFeed: { type: "string", description: "Raw CWR file string" },
        dsrRawFeed: { type: "string", description: "Raw DDEX DSR file string" },
        jobId: { type: "string" },
      },
    },
  },
  {
    name: "trigger_blackbox_sweep_async",
    description:
      "POST /api/v1/sweeper/async — enqueue then drain a sandbox CWR/DSR sweep.",
    inputSchema: {
      type: "object",
      properties: {
        cwrRawFeed: { type: "string" },
        dsrRawFeed: { type: "string" },
        jobId: { type: "string" },
      },
    },
  },
  {
    name: "trigger_luminate_sweep",
    description:
      "POST /api/v1/sweeper/luminate — normalize Luminate payloads and sweep. No live Luminate HTTP.",
    inputSchema: {
      type: "object",
      properties: {
        payloads: { type: "array" },
        estimatedPerStreamRateMicros: { type: "number" },
      },
      required: ["payloads"],
    },
  },
  {
    name: "query_audit_proof",
    description:
      "Retrieve an immutable audit proof package by work ID (stored after a sweep).",
    inputSchema: {
      type: "object",
      properties: {
        matchedWorkId: {
          type: "string",
          description: "The registered Work ID",
        },
      },
      required: ["matchedWorkId"],
    },
  },
  {
    name: "get_channel_unclaimed_metrics",
    description:
      "Fetch breakdown of unmatched funds sitting across all 6 royalty channels.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
] as const;

export type CovenantMcpToolName = (typeof COVENANT_MCP_TOOLS)[number]["name"];

export type CovenantMcpToolResult = {
  isError: boolean;
  payload: unknown;
};

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isLuminatePayload(value: unknown): value is LuminateConsumptionPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return typeof row.luminateId === "string" && typeof row.songTitle === "string";
}

function sweepSummary(
  recoveredRevenueCents: number,
  matchesFound: number,
  disputes: number,
  extra: Record<string, unknown> = {},
): CovenantMcpToolResult {
  return {
    isError: false,
    payload: {
      ok: true,
      status: "SUCCESS",
      recoveredRevenueCents,
      matchesFound,
      disputes,
      ...extra,
    },
  };
}

export class CovenantMcpToolHost {
  constructor(
    private readonly registry: CovenantMcpRegistry,
    private readonly engine: CovenantMasterEngineFacade,
  ) {}

  public listTools(): typeof COVENANT_MCP_TOOLS {
    return COVENANT_MCP_TOOLS;
  }

  public async callTool(
    name: string,
    args: Record<string, unknown> | undefined,
  ): Promise<CovenantMcpToolResult> {
    if (name === "register_work_manifest") {
      const parsed = parseWorkRegistration(
        args?.manifest,
        this.registry.occupiedWorkIds(),
      );
      if (!parsed.ok) {
        return {
          isError: true,
          payload: {
            ok: false,
            code: parsed.code,
            message: parsed.message,
          },
        };
      }
      const registered = await new CovenantDistributionEngine().registerWork(
        parsed.manifest,
      );
      if (!registered.ok) {
        return {
          isError: true,
          payload: {
            ok: false,
            code: registered.code,
            message: registered.message,
          },
        };
      }
      this.registry.registerWork(parsed.manifest);
      return {
        isError: false,
        payload: {
          ok: true,
          workId: parsed.manifest.workId,
          codeCount: registered.codeCount,
        },
      };
    }

    if (name === "list_work_manifests") {
      return {
        isError: false,
        payload: { ok: true, works: this.registry.listWorks() },
      };
    }

    if (
      name === "trigger_blackbox_sweep" ||
      name === "trigger_blackbox_sweep_async"
    ) {
      const cwrRawFeed = asString(args?.cwrRawFeed) ?? "";
      const dsrRawFeed = asString(args?.dsrRawFeed) ?? "";
      if (cwrRawFeed.trim() === "" && dsrRawFeed.trim() === "") {
        return {
          isError: true,
          payload: {
            ok: false,
            code: "missing_feed",
            message: "Provide cwrRawFeed and/or dsrRawFeed.",
          },
        };
      }
      const results = await this.engine.executeSystemSweep(
        cwrRawFeed,
        dsrRawFeed,
        this.registry.listWorks(),
      );
      this.registry.recordSweep(results);
      const jobId =
        asString(args?.jobId) ??
        (name === "trigger_blackbox_sweep_async" ? "sweep_async" : "sweep_direct");
      return sweepSummary(
        results.sweeperSummary.totalRecoveredRevenueCents,
        results.sweeperSummary.matches.length,
        results.disputesEncountered.length,
        {
          jobId,
          ...(name === "trigger_blackbox_sweep_async"
            ? { status: "drained" }
            : { channelBreakdownCents: results.sweeperSummary.channelBreakdownCents }),
        },
      );
    }

    if (name === "trigger_luminate_sweep") {
      const row = asRecord(args);
      if (!row || !Array.isArray(row.payloads)) {
        return {
          isError: true,
          payload: {
            ok: false,
            code: "malformed_body",
            message: "payloads must be an array.",
          },
        };
      }
      const payloads = row.payloads.filter(isLuminatePayload);
      if (payloads.length === 0) {
        return {
          isError: true,
          payload: {
            ok: false,
            code: "malformed_body",
            message: "payloads must include luminateId and songTitle.",
          },
        };
      }
      const rate = row.estimatedPerStreamRateMicros;
      if (
        rate !== undefined &&
        (typeof rate !== "number" || !Number.isSafeInteger(rate) || rate < 0)
      ) {
        return {
          isError: true,
          payload: {
            ok: false,
            code: "invalid_rate",
            message:
              "estimatedPerStreamRateMicros must be a whole number of USD micros.",
          },
        };
      }
      const records =
        new CovenantExternalDataIngestionEngine().parseLuminateConsumptionData(
          payloads,
          typeof rate === "number" ? rate : undefined,
        );
      const results = await this.engine.executeSystemSweep(
        "",
        "",
        this.registry.listWorks(),
        records,
      );
      this.registry.recordSweep(results);
      return sweepSummary(
        results.sweeperSummary.totalRecoveredRevenueCents,
        results.sweeperSummary.matches.length,
        results.disputesEncountered.length,
        { recordsIngested: records.length },
      );
    }

    if (name === "query_audit_proof") {
      const workId = asString(args?.matchedWorkId);
      if (!workId) {
        return {
          isError: true,
          payload: {
            ok: false,
            code: "invalid_work_id",
            message: "matchedWorkId is required.",
          },
        };
      }
      return {
        isError: false,
        payload: { ok: true, proofs: this.registry.proofsForWork(workId) },
      };
    }

    if (name === "get_channel_unclaimed_metrics") {
      return {
        isError: false,
        payload: { ok: true, metrics: this.registry.channelMetrics() },
      };
    }

    return {
      isError: true,
      payload: {
        ok: false,
        code: "unknown_tool",
        message: `Unknown tool: ${name}`,
      },
    };
  }
}
