/**
 * Stdio MCP server for every Don Engine + Covenant `/api/v1` route.
 * Run: `npm run mcp` (alias: `npm run covenant-mcp`).
 *
 * Does not call live Plaid, Column, Unit, DSP, or PRO HTTP.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { EmeraldValMcpToolHost } from "./host";

const tools = new EmeraldValMcpToolHost();

const server = new Server(
  {
    name: "emeraldval-api-mcp-server",
    version: "2.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [...tools.listTools()],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const args = request.params.arguments;
  const parsedArgs =
    typeof args === "object" && args !== null && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : undefined;

  const result = await tools.callTool(name, parsedArgs);
  return {
    isError: result.isError,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(result.payload, null, 2),
      },
    ],
  };
});

export async function startCovenantMcpServer(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export { startCovenantMcpServer as startEmeraldValMcpServer };

function isDirectRun(): boolean {
  const invoked = process.argv[1];
  return (
    typeof invoked === "string" &&
    (invoked.includes("covenant-mcp-server") || invoked.includes("mcp/server"))
  );
}

if (isDirectRun()) {
  startCovenantMcpServer().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : "unknown_error";
    console.error(message);
    process.exitCode = 1;
  });
}
