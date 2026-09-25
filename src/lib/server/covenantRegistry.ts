import { CovenantMcpRegistry } from "@/covenant-sdk/mcp-registry";

let registry: CovenantMcpRegistry | null = null;

/** Process-local work/proof registry shared by HTTP routes and the MCP server. */
export function getCovenantRegistry(): CovenantMcpRegistry {
  if (registry === null) {
    registry = new CovenantMcpRegistry();
  }
  return registry;
}

export function resetCovenantRegistry(): void {
  registry = new CovenantMcpRegistry();
}
