/**
 * Plaid adapter — Link token creation and bank-account verification.
 *
 * Wire contract grounded from plaid.com/docs this session (2026-09-30):
 *   - Base URLs: https://sandbox.plaid.com / https://production.plaid.com
 *     (chosen by PLAID_ENV — only sandbox|production are accepted; any
 *     other value fails closed as not-configured for live calls).
 *   - Endpoints: POST /link/token/create and POST /auth/get (plus
 *     POST /item/public_token/exchange to turn the creator's Link
 *     public_token into an access token).
 *   - Auth: client_id and secret in the JSON body (the docs' primary
 *     pattern; PLAID-CLIENT-ID/PLAID-SECRET headers are the documented
 *     alternative).
 *
 * Not-configured canon: PLAID_CLIENT_ID, PLAID_SECRET, and PLAID_ENV must
 * ALL be set — absent, every entry point returns the structured 503
 * plaid_not_configured envelope and the transport is never called.
 *
 * Disclosure rule: /auth/get responses carry FULL account numbers under
 * `numbers`. This adapter maps ONLY the accounts[] metadata (ids, names,
 * verification status, last-4 mask) — full numbers never leave this module
 * into a response, a log line, or a test snapshot.
 */

import { defaultBankingTransport } from "./transport";
import type {
  BankingFailure,
  BankingResult,
  BankingTransport,
  PlaidAdapter,
  PlaidLinkTokenInput,
  PlaidLinkTokenResult,
  PlaidVerificationResult,
} from "./types";

export const PLAID_SANDBOX_BASE = "https://sandbox.plaid.com";
export const PLAID_PRODUCTION_BASE = "https://production.plaid.com";
export const PLAID_LINK_TOKEN_CREATE_PATH = "/link/token/create";
export const PLAID_PUBLIC_TOKEN_EXCHANGE_PATH = "/item/public_token/exchange";
export const PLAID_AUTH_GET_PATH = "/auth/get";

export function isPlaidConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  const envName = env.PLAID_ENV?.trim();
  return Boolean(
    env.PLAID_CLIENT_ID?.trim() &&
      env.PLAID_SECRET?.trim() &&
      (envName === "sandbox" || envName === "production"),
  );
}

export function plaidBaseUrl(): string | null {
  const envName = process.env.PLAID_ENV?.trim();
  if (envName === "sandbox") return PLAID_SANDBOX_BASE;
  if (envName === "production") return PLAID_PRODUCTION_BASE;
  return null;
}

export function plaidNotConfigured(): BankingFailure {
  return {
    ok: false,
    status: 503,
    code: "plaid_not_configured",
    message:
      "Plaid is not configured: PLAID_CLIENT_ID, PLAID_SECRET, and PLAID_ENV (sandbox|production) must all be set.",
  };
}

export type PlaidAdapterDeps = {
  transport?: BankingTransport;
};

/** The client_id/secret envelope every Plaid call carries. */
function plaidCredentials(): { client_id: string; secret: string } {
  return {
    client_id: process.env.PLAID_CLIENT_ID?.trim() ?? "",
    secret: process.env.PLAID_SECRET?.trim() ?? "",
  };
}

async function postPlaid(
  transport: BankingTransport,
  path: string,
  payload: Record<string, unknown>,
): Promise<{ status: number; body: string }> {
  return transport(`${plaidBaseUrl() ?? PLAID_SANDBOX_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...plaidCredentials(), ...payload }),
  });
}

export function createPlaidAdapter(deps: PlaidAdapterDeps = {}): PlaidAdapter {
  const transport = deps.transport ?? defaultBankingTransport;

  return {
    async createLinkToken(
      input: PlaidLinkTokenInput,
    ): Promise<BankingResult<PlaidLinkTokenResult>> {
      if (!isPlaidConfigured()) return plaidNotConfigured();

      let response: { status: number; body: string };
      try {
        response = await postPlaid(transport, PLAID_LINK_TOKEN_CREATE_PATH, {
          client_name: "Covnant",
          user: { client_user_id: input.userId },
          products: input.products ?? ["auth"],
          country_codes: ["US"],
          language: "en",
        });
      } catch (error) {
        console.error("Plaid link token request failed:", error);
        return {
          ok: false,
          status: 502,
          code: "plaid_link_token_failed",
          message: "Plaid link token request failed.",
        };
      }
      if (response.status < 200 || response.status >= 300) {
        console.error(`Plaid link token rejected (HTTP ${response.status}).`);
        return {
          ok: false,
          status: 502,
          code: "plaid_link_token_failed",
          message: `Plaid rejected the link token request (HTTP ${response.status}).`,
        };
      }
      let parsed: { link_token?: unknown; expiration?: unknown; request_id?: unknown };
      try {
        parsed = JSON.parse(response.body) as {
          link_token?: unknown;
          expiration?: unknown;
          request_id?: unknown;
        };
      } catch (error) {
        console.error("Plaid link token response was not parseable JSON:", error);
        return {
          ok: false,
          status: 502,
          code: "plaid_link_token_failed",
          message: "Plaid returned an unparseable link token response.",
        };
      }
      if (typeof parsed.link_token !== "string" || parsed.link_token === "") {
        return {
          ok: false,
          status: 502,
          code: "plaid_link_token_failed",
          message: "Plaid link token response carried no link_token.",
        };
      }
      return {
        ok: true,
        value: {
          linkToken: parsed.link_token,
          expiration: typeof parsed.expiration === "string" ? parsed.expiration : null,
          requestId: typeof parsed.request_id === "string" ? parsed.request_id : null,
        },
      };
    },

    async getBankAccountVerification(input: {
      publicToken: string;
    }): Promise<BankingResult<PlaidVerificationResult>> {
      if (!isPlaidConfigured()) return plaidNotConfigured();

      // Step 1 — exchange the creator's own Link public_token for an access
      // token (Plaid's documented flow: Link onSuccess → public_token
      // exchange → /auth/get).
      let exchangeResponse: { status: number; body: string };
      try {
        exchangeResponse = await postPlaid(transport, PLAID_PUBLIC_TOKEN_EXCHANGE_PATH, {
          public_token: input.publicToken,
        });
      } catch (error) {
        console.error("Plaid public token exchange failed:", error);
        return {
          ok: false,
          status: 502,
          code: "plaid_verification_failed",
          message: "Plaid public token exchange failed.",
        };
      }
      if (exchangeResponse.status < 200 || exchangeResponse.status >= 300) {
        console.error(
          `Plaid public token exchange rejected (HTTP ${exchangeResponse.status}).`,
        );
        return {
          ok: false,
          status: 502,
          code: "plaid_verification_failed",
          message: `Plaid rejected the public token exchange (HTTP ${exchangeResponse.status}).`,
        };
      }
      let exchanged: { access_token?: unknown };
      try {
        exchanged = JSON.parse(exchangeResponse.body) as { access_token?: unknown };
      } catch (error) {
        console.error("Plaid exchange response was not parseable JSON:", error);
        return {
          ok: false,
          status: 502,
          code: "plaid_verification_failed",
          message: "Plaid returned an unparseable exchange response.",
        };
      }
      if (typeof exchanged.access_token !== "string" || exchanged.access_token === "") {
        return {
          ok: false,
          status: 502,
          code: "plaid_verification_failed",
          message: "Plaid exchange response carried no access token.",
        };
      }

      // Step 2 — read the account verification state. The numbers[] payload
      // is deliberately NOT mapped: full account numbers never leave the
      // adapter (the disclosure rule in the module header).
      let authResponse: { status: number; body: string };
      try {
        authResponse = await postPlaid(transport, PLAID_AUTH_GET_PATH, {
          access_token: exchanged.access_token,
        });
      } catch (error) {
        console.error("Plaid auth/get request failed:", error);
        return {
          ok: false,
          status: 502,
          code: "plaid_verification_failed",
          message: "Plaid auth/get request failed.",
        };
      }
      if (authResponse.status < 200 || authResponse.status >= 300) {
        console.error(`Plaid auth/get rejected (HTTP ${authResponse.status}).`);
        return {
          ok: false,
          status: 502,
          code: "plaid_verification_failed",
          message: `Plaid rejected the auth/get request (HTTP ${authResponse.status}).`,
        };
      }
      let auth: { accounts?: unknown };
      try {
        auth = JSON.parse(authResponse.body) as { accounts?: unknown };
      } catch (error) {
        console.error("Plaid auth/get response was not parseable JSON:", error);
        return {
          ok: false,
          status: 502,
          code: "plaid_verification_failed",
          message: "Plaid returned an unparseable auth/get response.",
        };
      }
      if (!Array.isArray(auth.accounts)) {
        return {
          ok: false,
          status: 502,
          code: "plaid_verification_failed",
          message: "Plaid auth/get response carried no accounts array.",
        };
      }
      const accounts = (auth.accounts as unknown[])
        .filter(
          (entry): entry is Record<string, unknown> =>
            typeof entry === "object" && entry !== null,
        )
        .map((entry) => ({
          accountId: typeof entry.account_id === "string" ? entry.account_id : "",
          name: typeof entry.name === "string" ? entry.name : null,
          officialName: typeof entry.official_name === "string" ? entry.official_name : null,
          verificationStatus:
            typeof entry.verification_status === "string" ? entry.verification_status : null,
          mask: typeof entry.mask === "string" ? entry.mask : null,
        }))
        .filter((account) => account.accountId !== "");
      return { ok: true, value: { accounts } };
    },
  };
}
