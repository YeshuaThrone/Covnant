/**
 * Stripe adapter — the funding rail (money IN to the Gold Board).
 *
 * Wire contract (Stripe's documented Payments API, stable for years):
 *   - Auth: "Authorization: Bearer <secret key>".
 *   - Funding: POST /v1/payment_intents, FORM-ENCODED body (Stripe's wire
 *     format), amount in the currency's smallest unit, plus metadata
 *     carrying the Gold Board payee identity the webhook receiver needs to
 *     post the funding through the Don ledger contract.
 *   - Idempotency: "Idempotency-Key" header — documented Stripe behavior
 *     for safe retries.
 *
 * Not-configured canon: STRIPE_SECRET_KEY absent → every entry point
 * returns the structured 503 stripe_not_configured envelope and the
 * transport is never called. The webhook RECEIVER lives at
 * /api/v1/webhooks/stripe with its own signature verifier
 * (modules/webhooks/stripeSignature.ts) — a different scheme from the
 * Standard Webhooks gates, so it is its own module.
 */

import { defaultBankingTransport } from "./transport";
import type {
  BankingFailure,
  BankingResult,
  BankingTransport,
  StripeAdapter,
  StripeFundingChargeInput,
  StripeFundingChargeResult,
} from "./types";

export const STRIPE_API_BASE = "https://api.stripe.com";
export const STRIPE_PAYMENT_INTENTS_PATH = "/v1/payment_intents";

export function isStripeConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.STRIPE_SECRET_KEY?.trim());
}

export function stripeNotConfigured(): BankingFailure {
  return {
    ok: false,
    status: 503,
    code: "stripe_not_configured",
    message: "Stripe funding is not configured: STRIPE_SECRET_KEY is unset.",
  };
}

export type StripeAdapterDeps = {
  transport?: BankingTransport;
};

export function createStripeAdapter(deps: StripeAdapterDeps = {}): StripeAdapter {
  const transport = deps.transport ?? defaultBankingTransport;

  return {
    async createFundingCharge(
      input: StripeFundingChargeInput,
    ): Promise<BankingResult<StripeFundingChargeResult>> {
      if (!isStripeConfigured()) return stripeNotConfigured();

      const apiKey = process.env.STRIPE_SECRET_KEY?.trim() ?? "";
      const currency = (input.currency ?? "usd").toLowerCase();

      // Stripe takes application/x-www-form-urlencoded bodies.
      const form = new URLSearchParams();
      form.set("amount", String(input.amountCents));
      form.set("currency", currency);
      // The payee identity rides in metadata: the webhook receiver's live
      // path reads it to post the funding through the Don ledger contract.
      form.set("metadata[payee_id]", input.payeeId);
      form.set("metadata[payee_name]", input.payeeName);
      form.set("metadata[origin]", "covnant_gold_board_funding");
      if (input.description !== undefined) form.set("description", input.description);

      let response: { status: number; body: string };
      try {
        response = await transport(`${STRIPE_API_BASE}${STRIPE_PAYMENT_INTENTS_PATH}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/x-www-form-urlencoded",
            "Idempotency-Key": input.idempotencyKey,
          },
          body: form.toString(),
        });
      } catch (error) {
        console.error("Stripe funding charge request failed:", error);
        return {
          ok: false,
          status: 502,
          code: "stripe_funding_failed",
          message: "Stripe funding request failed.",
        };
      }
      if (response.status < 200 || response.status >= 300) {
        console.error(`Stripe funding charge rejected (HTTP ${response.status}).`);
        return {
          ok: false,
          status: 502,
          code: "stripe_funding_failed",
          message: `Stripe rejected the funding charge (HTTP ${response.status}).`,
        };
      }
      let parsed: { id?: unknown; client_secret?: unknown; status?: unknown };
      try {
        parsed = JSON.parse(response.body) as {
          id?: unknown;
          client_secret?: unknown;
          status?: unknown;
        };
      } catch (error) {
        console.error("Stripe funding response was not parseable JSON:", error);
        return {
          ok: false,
          status: 502,
          code: "stripe_funding_failed",
          message: "Stripe returned an unparseable funding response.",
        };
      }
      if (typeof parsed.id !== "string" || parsed.id === "") {
        return {
          ok: false,
          status: 502,
          code: "stripe_funding_failed",
          message: "Stripe funding response carried no payment intent id.",
        };
      }
      return {
        ok: true,
        value: {
          paymentIntentId: parsed.id,
          clientSecret: typeof parsed.client_secret === "string" ? parsed.client_secret : null,
          status: typeof parsed.status === "string" ? parsed.status : null,
          raw: parsed,
        },
      };
    },
  };
}
