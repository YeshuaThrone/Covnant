/**
 * Lithic adapter — programmatic ACH payout dispatch (money OUT of the Gold
 * Board at settlement time) and virtual card issuing.
 *
 * Wire contract grounded from docs.lithic.com this session (2026-09-30):
 *   - Auth: raw API key in the Authorization header ("Authorization:
 *     [api-key]" — no Bearer scheme).
 *   - ACH: POST /v1/payments ("initiates a payment between a financial
 *     account and an external bank account") with type "PAYMENT", method
 *     "ACH_NEXT_DAY", method_attributes.sec_code "CCD", the program's
 *     financial_account_token, the payee's external_bank_account_token,
 *     amount in the currency's smallest unit, and an optional memo.
 *   - Cards: POST /v1/cards with type "VIRTUAL" (+ optional memo/spend
 *     limit). Card creation is one of the two endpoints where Lithic's
 *     Idempotency-Key support is live today.
 *   - Idempotency: "Idempotency-Key: {key}" header, and Lithic requires the
 *     key to be a valid UUID. Idempotency is currently honored on
 *     POST /v1/cards and POST /v1/financial_accounts; support "is being
 *     rolled out to all API endpoints", so the header is sent on payments
 *     too — harmless today, protective the day Lithic honors it there. Our
 *     own replay protection for ACH does NOT depend on it: the settlement
 *     leg (ledgerPosting.postLithicSettlementEntry) keys the GL journal on
 *     the returned Lithic payment token via listGlJournalsByRef.
 *
 * Not-configured canon: LITHIC_API_KEY, LITHIC_ENV, and
 * LITHIC_FINANCIAL_ACCOUNT_TOKEN must ALL be set — with any of them absent
 * every entry point returns the structured 503 lithic_not_configured
 * envelope and the transport is never constructed or called. Never a fake
 * success, never a thrown env error.
 */

import { defaultBankingTransport } from "./transport";
import type {
  BankingFailure,
  BankingResult,
  BankingTransport,
  LithicAdapter,
  LithicAchDispatchInput,
  LithicAchDispatchResult,
  LithicVirtualCardInput,
  LithicVirtualCardResult,
} from "./types";

export const LITHIC_SANDBOX_BASE = "https://sandbox.lithic.com";
export const LITHIC_PRODUCTION_BASE = "https://api.lithic.com";
export const LITHIC_PAYMENTS_PATH = "/v1/payments";
export const LITHIC_CARDS_PATH = "/v1/cards";

/** Lithic requires a UUID-format idempotency key. */
export const LITHIC_IDEMPOTENCY_KEY_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function readLithicEnv(): "sandbox" | "production" {
  return process.env.LITHIC_ENV === "production" ? "production" : "sandbox";
}

export function lithicBaseUrl(): string {
  return readLithicEnv() === "production" ? LITHIC_PRODUCTION_BASE : LITHIC_SANDBOX_BASE;
}

/** All three credentials are required — a partial config is not configured. */
export function isLithicConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(
    env.LITHIC_API_KEY?.trim() &&
      env.LITHIC_ENV?.trim() &&
      env.LITHIC_FINANCIAL_ACCOUNT_TOKEN?.trim(),
  );
}

export function lithicNotConfigured(): BankingFailure {
  return {
    ok: false,
    status: 503,
    code: "lithic_not_configured",
    message:
      "Lithic is not configured: LITHIC_API_KEY, LITHIC_ENV, and LITHIC_FINANCIAL_ACCOUNT_TOKEN must all be set.",
  };
}

export type LithicAdapterDeps = {
  /** The wire seam — tests inject a spy, production uses fetch. */
  transport?: BankingTransport;
};

function parseProviderErrorBody(rawBody: string): { message?: unknown } | null {
  try {
    const parsed: unknown = JSON.parse(rawBody);
    return parsed !== null && typeof parsed === "object" ? (parsed as { message?: unknown }) : null;
  } catch {
    return null;
  }
}

/** Non-2xx from Lithic: a sanitized failure — the response body is never echoed (it may echo memo/destination). */
function dispatchRejected(status: number, rawBody: string): BankingFailure {
  const providerMessage = parseProviderErrorBody(rawBody)?.message;
  const detail =
    typeof providerMessage === "string" && providerMessage.trim() !== ""
      ? `: ${providerMessage}`
      : ` (HTTP ${status}).`;
  console.error(`Lithic request rejected${detail}`);
  return {
    ok: false,
    status: 502,
    code: "lithic_dispatch_failed",
    message: `Lithic rejected the request${detail}`,
  };
}

export function createLithicAdapter(deps: LithicAdapterDeps = {}): LithicAdapter {
  const transport = deps.transport ?? defaultBankingTransport;

  return {
    async dispatchAch(
      input: LithicAchDispatchInput,
    ): Promise<BankingResult<LithicAchDispatchResult>> {
      if (!isLithicConfigured()) return lithicNotConfigured();

      const apiKey = process.env.LITHIC_API_KEY?.trim() ?? "";
      const financialAccountToken =
        process.env.LITHIC_FINANCIAL_ACCOUNT_TOKEN?.trim() ?? "";

      let response: { status: number; body: string };
      try {
        response = await transport(`${lithicBaseUrl()}${LITHIC_PAYMENTS_PATH}`, {
          method: "POST",
          headers: {
            Authorization: apiKey,
            "Content-Type": "application/json",
            "Idempotency-Key": input.idempotencyKey,
          },
          body: JSON.stringify({
            type: "PAYMENT",
            method: "ACH_NEXT_DAY",
            method_attributes: { sec_code: "CCD" },
            financial_account_token: financialAccountToken,
            external_bank_account_token: input.destination,
            amount: input.amountCents,
            ...(input.memo !== undefined ? { memo: input.memo } : {}),
          }),
        });
      } catch (error) {
        console.error("Lithic ACH dispatch request failed:", error);
        return {
          ok: false,
          status: 502,
          code: "lithic_dispatch_failed",
          message: "Lithic ACH dispatch request failed.",
        };
      }
      if (response.status < 200 || response.status >= 300) {
        return dispatchRejected(response.status, response.body);
      }
      let parsed: { token?: unknown; status?: unknown };
      try {
        parsed = JSON.parse(response.body) as { token?: unknown; status?: unknown };
      } catch (error) {
        console.error("Lithic ACH dispatch response was not parseable JSON:", error);
        return {
          ok: false,
          status: 502,
          code: "lithic_dispatch_failed",
          message: "Lithic returned an unparseable dispatch response.",
        };
      }
      if (typeof parsed.token !== "string" || parsed.token === "") {
        return {
          ok: false,
          status: 502,
          code: "lithic_dispatch_failed",
          message: "Lithic dispatch response carried no payment token.",
        };
      }
      return {
        ok: true,
        value: {
          transferId: parsed.token,
          status: typeof parsed.status === "string" ? parsed.status : null,
          raw: parsed,
        },
      };
    },

    async createVirtualCard(
      input: LithicVirtualCardInput,
    ): Promise<BankingResult<LithicVirtualCardResult>> {
      if (!isLithicConfigured()) return lithicNotConfigured();

      const apiKey = process.env.LITHIC_API_KEY?.trim() ?? "";

      let response: { status: number; body: string };
      try {
        response = await transport(`${lithicBaseUrl()}${LITHIC_CARDS_PATH}`, {
          method: "POST",
          headers: {
            Authorization: apiKey,
            "Content-Type": "application/json",
            // Lithic honors idempotency on card creation today (grounded:
            // docs.lithic.com/docs/idempotent-requests).
            "Idempotency-Key": input.idempotencyKey,
          },
          body: JSON.stringify({
            type: "VIRTUAL",
            ...(input.memo !== undefined ? { memo: input.memo } : {}),
            ...(input.spendLimitCents !== undefined
              ? { spend_limit: input.spendLimitCents, spend_limit_duration: "MONTHLY" }
              : {}),
          }),
        });
      } catch (error) {
        console.error("Lithic card creation request failed:", error);
        return {
          ok: false,
          status: 502,
          code: "lithic_dispatch_failed",
          message: "Lithic card creation request failed.",
        };
      }
      if (response.status < 200 || response.status >= 300) {
        return dispatchRejected(response.status, response.body);
      }
      let parsed: { token?: unknown; state?: unknown };
      try {
        parsed = JSON.parse(response.body) as { token?: unknown; state?: unknown };
      } catch (error) {
        console.error("Lithic card creation response was not parseable JSON:", error);
        return {
          ok: false,
          status: 502,
          code: "lithic_dispatch_failed",
          message: "Lithic returned an unparseable card creation response.",
        };
      }
      if (typeof parsed.token !== "string" || parsed.token === "") {
        return {
          ok: false,
          status: 502,
          code: "lithic_dispatch_failed",
          message: "Lithic card creation response carried no card token.",
        };
      }
      return {
        ok: true,
        value: {
          cardToken: parsed.token,
          state: typeof parsed.state === "string" ? parsed.state : null,
          raw: parsed,
        },
      };
    },
  };
}
