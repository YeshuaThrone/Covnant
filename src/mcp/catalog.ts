import type { McpHttpBinding } from "./types";

export const DON_MCP_HTTP: readonly McpHttpBinding[] = [
  { method: "POST", path: "/api/v1/auth/plaid-kyc" },
  { method: "POST", path: "/api/v1/auth/plaid-exchange" },
  { method: "POST", path: "/api/v1/splits/calculate" },
  { method: "POST", path: "/api/v1/splits/recoupment" },
  { method: "GET", path: "/api/v1/splits/recoupment" },
  { method: "POST", path: "/api/v1/splits/reverse" },
  { method: "POST", path: "/api/v1/webhooks" },
  { method: "POST", path: "/api/v1/webhooks/baas" },
  { method: "POST", path: "/api/v1/webhooks/dsp" },
  { method: "GET", path: "/api/v1/vaults" },
  { method: "POST", path: "/api/v1/vaults" },
  { method: "POST", path: "/api/v1/vaults/payout" },
  { method: "POST", path: "/api/v1/vaults/dispute/lock" },
  { method: "GET", path: "/api/v1/ledger" },
  { method: "GET", path: "/api/v1/ledger/audit" },
  { method: "POST", path: "/api/v1/baas/ach" },
  { method: "POST", path: "/api/v1/baas/rtp" },
  { method: "POST", path: "/api/v1/compliance/withholding" },
  { method: "GET", path: "/api/v1/compliance/withholding" },
];

export const COVENANT_MCP_HTTP: readonly McpHttpBinding[] = [
  { method: "POST", path: "/api/v1/works" },
  { method: "GET", path: "/api/v1/works" },
  { method: "POST", path: "/api/v1/sweeper" },
  { method: "POST", path: "/api/v1/sweeper/async" },
  { method: "POST", path: "/api/v1/sweeper/luminate" },
];

export const MCP_HTTP_BINDINGS: readonly McpHttpBinding[] = [
  ...DON_MCP_HTTP,
  ...COVENANT_MCP_HTTP,
];
