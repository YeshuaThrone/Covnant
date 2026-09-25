export type McpToolResult = {
  isError: boolean;
  payload: unknown;
};

export type McpToolDescriptor = {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: readonly string[];
  };
};

export type McpHttpBinding = {
  method: "GET" | "POST";
  path: string;
};

export function mcpOk(payload: unknown): McpToolResult {
  return { isError: false, payload };
}

export function mcpErr(code: string, message: string): McpToolResult {
  return {
    isError: true,
    payload: { ok: false, code, message },
  };
}

export function mcpFromValidation<T>(parsed: {
  ok: boolean;
  code?: string;
  message?: string;
  value?: T;
}): McpToolResult | { ok: true; value: T } {
  if (!parsed.ok) {
    return mcpErr(parsed.code ?? "invalid_request", parsed.message ?? "Invalid request.");
  }
  return { ok: true, value: parsed.value as T };
}

export function isMcpResult<T>(
  value: McpToolResult | { ok: true; value: T },
): value is McpToolResult {
  return "isError" in value;
}

/**
 * Mirror HTTP JSON bodies: `{ ok: true, value }` unwraps to `value`;
 * `{ ok: false, code, message }` becomes an MCP error; other success
 * objects (webhooks, vaults) are returned as-is.
 */
export function mcpFromEngine(result: {
  ok: boolean;
  code?: string;
  message?: string;
  value?: unknown;
}): McpToolResult {
  if (!result.ok) {
    return mcpErr(result.code ?? "engine_failure", result.message ?? "Request failed.");
  }
  if ("value" in result && result.value !== undefined) {
    return mcpOk(result.value);
  }
  return mcpOk(result);
}

export function asRecord(
  value: unknown,
): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}
