import { CovenantMasterEngineFacade } from "@/covenant-sdk/facade";
import {
  COVENANT_MCP_TOOLS,
  CovenantMcpToolHost,
} from "@/covenant-sdk/mcp-tools";
import { CovenantMcpRegistry } from "@/covenant-sdk/mcp-registry";
import { getCovenantRegistry } from "@/lib/server/covenantRegistry";
import { getStore } from "@/lib/server/store";
import type { Store } from "@/lib/server/store";
import { DON_MCP_TOOLS, DonMcpToolHost, isDonMcpTool } from "./don-tools";
import { type McpToolDescriptor, type McpToolResult, mcpErr } from "./types";

// Landing adaptation (Covenant API integration): the drop constructed the
// Don host eagerly in the constructor, which is safe under EmeraldVal's lazy
// SQLite Store but crashes boot under Covnant's fail-closed getStore() — it
// throws supabase_not_configured when env is unset. The Don host is therefore
// built on first use: the byte-locked stdio server boots (and lists all 26
// tools) without Supabase env, and every Don tool call still fails closed
// before any query.
type HostOptions = {
  store?: Store;
  registry?: CovenantMcpRegistry;
  engine?: CovenantMasterEngineFacade;
};

export class EmeraldValMcpToolHost {
  private readonly options: HostOptions;
  private don: DonMcpToolHost | null = null;
  private readonly covenant: CovenantMcpToolHost;

  constructor(options: HostOptions = {}) {
    this.options = options;
    this.covenant = new CovenantMcpToolHost(
      options.registry ?? getCovenantRegistry(),
      options.engine ?? new CovenantMasterEngineFacade(),
    );
  }

  private donHost(): DonMcpToolHost {
    if (this.don === null) {
      this.don = new DonMcpToolHost(this.options.store ?? getStore());
    }
    return this.don;
  }

  public listTools(): McpToolDescriptor[] {
    return [...DON_MCP_TOOLS, ...COVENANT_MCP_TOOLS] as McpToolDescriptor[];
  }

  public async callTool(
    name: string,
    args: Record<string, unknown> | undefined,
  ): Promise<McpToolResult> {
    try {
      if (isDonMcpTool(name)) {
        return await this.donHost().callTool(name, args);
      }
      return await this.covenant.callTool(name, args);
    } catch (err: unknown) {
      // Covnant's getStore() fails closed (supabase_not_configured) before
      // any query — construction happens here, outside the Don host's own
      // catch, so the boundary owns it: tool errors stay MCP results, never
      // protocol crashes.
      const message = err instanceof Error ? err.message : "unknown_error";
      return mcpErr("store_failure", message);
    }
  }
}
