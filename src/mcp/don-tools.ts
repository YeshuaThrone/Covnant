/**
 * Don Engine MCP tools — every `/api/v1` route as an MCP tool.
 *
 * Landing adaptation (Covenant API integration, one-engine law): the drop's
 * synchronous module calls are awaited against Covnant's 72-method async
 * Store and its canonical async modules. The mcpOk/mcpErr contract, tool
 * semantics, and the {ok:false, code, message} shape are unchanged from
 * EmeraldVal PR #41; the reversal engine is Covnant's canonical
 * src/lib/server/splitReversal.ts body (the drop's sync twin never lands).
 */

import {
  validateBaasPayoutPayload,
  validateBaasWebhookPayload,
  validateDisputeLockPayload,
  validateDspWebhookPayload,
  validatePlaidExchangePayload,
  validatePlaidKycPayload,
  validateRecoupmentPayload,
  validateSplitCalculatePayload,
  validateSplitReversePayload,
  validateUnifiedWebhookPayload,
  validateVaultPayoutPayload,
  validateVaultReleasePayload,
  validateWithholdingPayload,
} from "@/lib/don/validation";
import { handlePlaidKyc } from "@/lib/server/plaid";
import { getStore } from "@/lib/server/store";
import type { Store } from "@/lib/server/store";
import { calculateUdrSplits } from "@/lib/server/udrSplits";
import {
  applyWithholding,
  readCreatorCompliance,
} from "@/modules/compliance/engine";
import { auditLedger, immutableLedgerLog } from "@/modules/ledger/audit";
import { reverseSplitRun } from "@/lib/server/splitReversal";
import { exchangePlaidPublicToken } from "@/modules/plaid/exchange";
import { readAdvance, upsertAdvance } from "@/modules/recoupment/engine";
import { applyDisputeLock } from "@/modules/vaults/dispute";
import { payoutFromVault, releaseVaultPending } from "@/modules/vaults/engine";
import { processSandboxRail, readBaasProvider } from "@/services/baas";
import { ingestBaasWebhook } from "@/modules/webhooks/baas";
import { ingestDspWebhook } from "@/modules/webhooks/dsp";
import {
  asString,
  isMcpResult,
  mcpErr,
  mcpFromEngine,
  mcpFromValidation,
  mcpOk,
  type McpToolDescriptor,
  type McpToolResult,
} from "./types";

export const DON_MCP_TOOLS: readonly McpToolDescriptor[] = [
  {
    name: "plaid_kyc",
    description:
      "POST /api/v1/auth/plaid-kyc — sandbox Plaid Link token or identity KYC.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "create_link_token or verify_identity",
        },
        creator_id: { type: "string" },
        products: { type: "array", items: { type: "string" } },
        public_token: { type: "string" },
        link_token: { type: "string" },
        identity: { type: "object" },
      },
      required: ["action", "creator_id"],
    },
  },
  {
    name: "plaid_exchange",
    description:
      "POST /api/v1/auth/plaid-exchange — public_token → encrypted access + processor token.",
    inputSchema: {
      type: "object",
      properties: {
        creator_id: { type: "string" },
        public_token: { type: "string" },
        processor: { type: "string", description: "column or unit" },
      },
      required: ["creator_id", "public_token"],
    },
  },
  {
    name: "splits_calculate",
    description:
      "POST /api/v1/splits/calculate — UDR split engine with company dust sweep.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string" },
        period: { type: "string" },
        currency: { type: "string" },
        settle: { type: "boolean" },
        rail: { type: "string" },
        line_items: { type: "array" },
      },
      required: ["source", "line_items"],
    },
  },
  {
    name: "recoupment_upsert",
    description: "POST /api/v1/splits/recoupment — record an unearned advance.",
    inputSchema: {
      type: "object",
      properties: {
        creator_id: { type: "string" },
        creator_name: { type: "string" },
        recoupment_target_cents: { type: "number" },
        recoupment_bps: { type: "number" },
      },
      required: ["creator_id", "recoupment_target_cents"],
    },
  },
  {
    name: "recoupment_get",
    description: "GET /api/v1/splits/recoupment?creator_id= — advance snapshot.",
    inputSchema: {
      type: "object",
      properties: { creator_id: { type: "string" } },
      required: ["creator_id"],
    },
  },
  {
    name: "splits_reverse",
    description: "POST /api/v1/splits/reverse — invert a posted split run.",
    inputSchema: {
      type: "object",
      properties: { split_run_id: { type: "string" } },
      required: ["split_run_id"],
    },
  },
  {
    name: "webhooks_ingest",
    description:
      "POST /api/v1/webhooks — dispatcher for payout.* and royalty.* events.",
    inputSchema: {
      type: "object",
      properties: {
        event: { type: "string" },
        transfer_id: { type: "string" },
        event_id: { type: "string" },
        split_run_id: { type: "string" },
        source: { type: "string" },
        line_items: { type: "array" },
      },
      required: ["event"],
    },
  },
  {
    name: "webhooks_baas",
    description:
      "POST /api/v1/webhooks/baas — payout.settled | payout.returned | payout.failed.",
    inputSchema: {
      type: "object",
      properties: {
        event: { type: "string" },
        transfer_id: { type: "string" },
        event_id: { type: "string" },
      },
      required: ["event", "transfer_id"],
    },
  },
  {
    name: "webhooks_dsp",
    description:
      "POST /api/v1/webhooks/dsp — royalty.report | royalty.adjusted | royalty.reversed.",
    inputSchema: {
      type: "object",
      properties: {
        event: { type: "string" },
        event_id: { type: "string" },
        source: { type: "string" },
        split_run_id: { type: "string" },
        line_items: { type: "array" },
      },
      required: ["event"],
    },
  },
  {
    name: "vaults_list",
    description: "GET /api/v1/vaults — FBO sub-ledger balances. Optional payee_id.",
    inputSchema: {
      type: "object",
      properties: { payee_id: { type: "string" } },
    },
  },
  {
    name: "vaults_release",
    description: "POST /api/v1/vaults — pending → available (action: release).",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string" },
        payee_id: { type: "string" },
        amount_cents: { type: "number" },
      },
      required: ["payee_id"],
    },
  },
  {
    name: "vaults_payout",
    description: "POST /api/v1/vaults/payout — BaaS settlement from available_balance.",
    inputSchema: {
      type: "object",
      properties: {
        payee_id: { type: "string" },
        amount_cents: { type: "number" },
        rail: { type: "string" },
      },
      required: ["payee_id"],
    },
  },
  {
    name: "vaults_dispute_lock",
    description:
      "POST /api/v1/vaults/dispute/lock — freeze payouts and/or lock a work_id.",
    inputSchema: {
      type: "object",
      properties: {
        payee_id: { type: "string" },
        work_id: { type: "string" },
        locked: { type: "boolean" },
        line_item_id: { type: "string" },
        amount_cents: { type: "number" },
      },
      required: ["locked"],
    },
  },
  {
    name: "ledger_log",
    description: "GET /api/v1/ledger — append-only hash-chained GL log.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "ledger_audit",
    description:
      "GET /api/v1/ledger/audit — double-entry, FBO vs vaults, hash chain.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "baas_ach",
    description: "POST /api/v1/baas/ach — sandbox ACH rail.",
    inputSchema: {
      type: "object",
      properties: {
        payee_id: { type: "string" },
        payee_name: { type: "string" },
        amount_cents: { type: "number" },
        currency: { type: "string" },
        provider: { type: "string" },
        ledger_transaction_id: { type: "string" },
      },
      required: ["payee_id", "payee_name", "amount_cents"],
    },
  },
  {
    name: "baas_rtp",
    description: "POST /api/v1/baas/rtp — sandbox RTP rail.",
    inputSchema: {
      type: "object",
      properties: {
        payee_id: { type: "string" },
        payee_name: { type: "string" },
        amount_cents: { type: "number" },
        currency: { type: "string" },
        provider: { type: "string" },
        ledger_transaction_id: { type: "string" },
      },
      required: ["payee_id", "payee_name", "amount_cents"],
    },
  },
  {
    name: "withholding_apply",
    description:
      "POST /api/v1/compliance/withholding — 24% backup tax when TIN/W-9 is unverified.",
    inputSchema: {
      type: "object",
      properties: {
        creator_id: { type: "string" },
        gross_cents: { type: "number" },
        tax_year: { type: "number" },
        tin_verified: { type: "boolean" },
        w9_on_file: { type: "boolean" },
      },
      required: ["creator_id", "gross_cents"],
    },
  },
  {
    name: "withholding_get",
    description:
      "GET /api/v1/compliance/withholding?creator_id=&tax_year= — YTD tax snapshot.",
    inputSchema: {
      type: "object",
      properties: {
        creator_id: { type: "string" },
        tax_year: { type: "number" },
      },
      required: ["creator_id"],
    },
  },
];

export type DonMcpToolName = (typeof DON_MCP_TOOLS)[number]["name"];

const DON_NAMES = new Set(DON_MCP_TOOLS.map((tool) => tool.name));

export function isDonMcpTool(name: string): name is DonMcpToolName {
  return DON_NAMES.has(name as DonMcpToolName);
}

function parseTaxYear(value: unknown): number | McpToolResult {
  if (value === undefined || value === null || value === "") {
    return new Date().getUTCFullYear();
  }
  const year = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(year) || year < 2000 || year > 2100) {
    return mcpErr("invalid_tax_year", "tax_year must be a four-digit year.");
  }
  return year;
}

export class DonMcpToolHost {
  constructor(private readonly store: Store = getStore()) {}

  public listTools(): readonly McpToolDescriptor[] {
    return DON_MCP_TOOLS;
  }

  public async callTool(
    name: string,
    args: Record<string, unknown> | undefined,
  ): Promise<McpToolResult> {
    const body = args ?? {};
    try {
      switch (name) {
        case "plaid_kyc": {
          const parsed = validatePlaidKycPayload(body);
          const checked = mcpFromValidation(parsed);
          if (isMcpResult(checked)) {
            return checked;
          }
          return mcpFromEngine(
            await handlePlaidKyc(this.store, checked.value),
          );
        }
        case "plaid_exchange": {
          const parsed = validatePlaidExchangePayload(body);
          const checked = mcpFromValidation(parsed);
          if (isMcpResult(checked)) {
            return checked;
          }
          return mcpFromEngine(
            await exchangePlaidPublicToken(this.store, checked.value),
          );
        }
        case "splits_calculate": {
          const parsed = validateSplitCalculatePayload(body);
          const checked = mcpFromValidation(parsed);
          if (isMcpResult(checked)) {
            return checked;
          }
          return mcpFromEngine(
            await calculateUdrSplits(this.store, checked.value),
          );
        }
        case "recoupment_upsert": {
          const parsed = validateRecoupmentPayload(body);
          const checked = mcpFromValidation(parsed);
          if (isMcpResult(checked)) {
            return checked;
          }
          return mcpOk(await upsertAdvance(this.store, checked.value));
        }
        case "recoupment_get": {
          const creatorId = asString(body.creator_id);
          if (!creatorId) {
            return mcpErr("missing_creator_id", "creator_id is required.");
          }
          return mcpOk(await readAdvance(this.store, creatorId));
        }
        case "splits_reverse": {
          const parsed = validateSplitReversePayload(body);
          const checked = mcpFromValidation(parsed);
          if (isMcpResult(checked)) {
            return checked;
          }
          return mcpFromEngine(
            await reverseSplitRun(this.store, checked.value.split_run_id),
          );
        }
        case "webhooks_ingest": {
          const parsed = validateUnifiedWebhookPayload(body);
          const checked = mcpFromValidation(parsed);
          if (isMcpResult(checked)) {
            return checked;
          }
          if (checked.value.kind === "baas") {
            return mcpFromEngine(
              await ingestBaasWebhook(this.store, checked.value.value),
            );
          }
          return mcpFromEngine(
            await ingestDspWebhook(this.store, checked.value.value),
          );
        }
        case "webhooks_baas": {
          const parsed = validateBaasWebhookPayload(body);
          const checked = mcpFromValidation(parsed);
          if (isMcpResult(checked)) {
            return checked;
          }
          return mcpFromEngine(
            await ingestBaasWebhook(this.store, checked.value),
          );
        }
        case "webhooks_dsp": {
          const parsed = validateDspWebhookPayload(body);
          const checked = mcpFromValidation(parsed);
          if (isMcpResult(checked)) {
            return checked;
          }
          return mcpFromEngine(await ingestDspWebhook(this.store, checked.value));
        }
        case "vaults_list": {
          const payeeId = asString(body.payee_id);
          if (payeeId) {
            const vault = await this.store.getVault(payeeId);
            if (vault === undefined) {
              return mcpErr(
                "vault_not_found",
                "No sovereign vault exists for that payee.",
              );
            }
            return mcpOk(vault);
          }
          return mcpOk({ vaults: await this.store.listVaults() });
        }
        case "vaults_release": {
          const parsed = validateVaultReleasePayload(body);
          const checked = mcpFromValidation(parsed);
          if (isMcpResult(checked)) {
            return checked;
          }
          return mcpFromEngine(
            await releaseVaultPending(
              this.store,
              checked.value.payee_id,
              checked.value.amount_cents,
            ),
          );
        }
        case "vaults_payout": {
          const parsed = validateVaultPayoutPayload(body);
          const checked = mcpFromValidation(parsed);
          if (isMcpResult(checked)) {
            return checked;
          }
          const vault = await this.store.getVault(checked.value.payee_id);
          const amountCents =
            checked.value.amount_cents ?? vault?.available_balance ?? 0;
          return mcpFromEngine(
            await payoutFromVault(this.store, {
              payee_id: checked.value.payee_id,
              amount_cents: amountCents,
              rail: checked.value.rail,
            }),
          );
        }
        case "vaults_dispute_lock": {
          const parsed = validateDisputeLockPayload(body);
          const checked = mcpFromValidation(parsed);
          if (isMcpResult(checked)) {
            return checked;
          }
          return mcpFromEngine(
            await applyDisputeLock(this.store, checked.value),
          );
        }
        case "ledger_log":
          return mcpOk(await immutableLedgerLog(this.store));
        case "ledger_audit":
          return mcpOk(await auditLedger(this.store));
        case "baas_ach":
        case "baas_rtp": {
          const parsed = validateBaasPayoutPayload(body);
          const checked = mcpFromValidation(parsed);
          if (isMcpResult(checked)) {
            return checked;
          }
          const rail = name === "baas_ach" ? "ach" : "rtp";
          const result = await processSandboxRail(this.store, {
            ...checked.value,
            provider: checked.value.provider ?? readBaasProvider(),
            rail,
          });
          return mcpOk({
            mode: result.mode,
            rail,
            provider: result.transfer.provider,
            transfer: result.transfer,
          });
        }
        case "withholding_apply": {
          const parsed = validateWithholdingPayload(body);
          const checked = mcpFromValidation(parsed);
          if (isMcpResult(checked)) {
            return checked;
          }
          return mcpFromEngine(
            await applyWithholding(this.store, {
              creator_id: checked.value.creator_id,
              gross_cents: checked.value.gross_cents,
              tax_year: checked.value.tax_year ?? new Date().getUTCFullYear(),
              tin_verified: checked.value.tin_verified,
              w9_on_file: checked.value.w9_on_file,
            }),
          );
        }
        case "withholding_get": {
          const creatorId = asString(body.creator_id);
          if (!creatorId) {
            return mcpErr("missing_creator_id", "creator_id is required.");
          }
          const year = parseTaxYear(body.tax_year);
          if (typeof year !== "number") {
            return year;
          }
          return mcpOk(
            await readCreatorCompliance(this.store, creatorId, year),
          );
        }
        default:
          return mcpErr("unknown_tool", `Unknown tool: ${name}`);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "unknown_error";
      return mcpErr("store_failure", message);
    }
  }
}
