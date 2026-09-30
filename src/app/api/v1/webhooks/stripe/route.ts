import { NextRequest, NextResponse } from "next/server";
import { donJsonError } from "@/lib/server/http";
import { getStore } from "@/lib/server/store";
import { authenticateStripeWebhook } from "@/modules/don/stripeWebhookSignature";
import { postJournal } from "@/modules/ledger/engine";
import { fboDebit, vaultCredit } from "@/modules/ledger/journal";
import { creditVault } from "@/modules/vaults/engine";
import {
  GOLD_BOARD_FUNDING_ORIGIN,
  validateStripeEventEnvelope,
  validateStripeFundingObject,
} from "@/modules/banking/validation";

/**
 * POST /api/v1/webhooks/stripe — the funding webhook (money IN to the Gold
 * Board), following the /api/v1/webhooks/dsp and /baas pattern with STRIPE's
 * signature scheme (authenticateStripeWebhook — t/v1 HMAC over the raw body,
 * 300s replay tolerance, fail-closed on an unset secret).
 *
 * Only payment_intent.succeeded events whose metadata carries
 * origin=covnant_gold_board_funding post funding. The ledger leg is the
 * funding_received kind with a funding journal whose ref is the Stripe event
 * id (ref_type "stripe_event") — the replay dedupe key. Charge CREATION never
 * posts money; only this verified receipt does.
 */
export async function POST(request: NextRequest) {
  const auth = await authenticateStripeWebhook(request, "STRIPE_WEBHOOK_SECRET");
  if (!auth.ok) {
    return auth.response;
  }

  let envelope: unknown;
  try {
    envelope = JSON.parse(auth.rawBody);
  } catch {
    return donJsonError(400, "malformed_body", "Request body must be valid JSON.");
  }
  const event = validateStripeEventEnvelope(envelope);
  if (!event.ok) {
    return donJsonError(422, event.code, event.message);
  }
  if (event.value.type !== "payment_intent.succeeded") {
    return NextResponse.json({ ok: true, handled: false, reason: "event_type_not_funding" });
  }
  const funding = validateStripeFundingObject(event.value.object);
  if (!funding.ok) {
    return donJsonError(422, funding.code, funding.message);
  }
  if (funding.value.origin !== GOLD_BOARD_FUNDING_ORIGIN) {
    return NextResponse.json({ ok: true, handled: false, reason: "origin_not_gold_board" });
  }
  // The Gold Board settles integer USD cents only; a non-USD charge cannot be
  // posted honestly, so refuse and let Stripe retry while the operator looks.
  if (funding.value.currency !== "usd") {
    return donJsonError(
      422,
      "unsupported_currency",
      "The Gold Board settles USD only; this funding charge is not postable.",
    );
  }

  const store = getStore();
  // Replay idempotency: the funding journal's ref IS the Stripe event id.
  // A redelivered event finds the posted journal and acknowledges without
  // re-crediting.
  const posted = await store.listGlJournalsByRef("stripe_event", event.value.id);
  if (posted.length > 0) {
    return NextResponse.json({ ok: true, handled: true, idempotent: true });
  }

  const now = new Date();
  const vault = await creditVault(
    store,
    funding.value.payee_id,
    funding.value.payee_name,
    funding.value.amount_cents,
    "available",
    now,
  );
  const ledger = await store.insertLedgerTransaction({
    split_run_id: "",
    line_item_id: "",
    payee_id: funding.value.payee_id,
    payee_name: funding.value.payee_name,
    role: "other",
    share_bps: 0,
    amount_cents: funding.value.amount_cents,
    currency: "USD",
    status: "settled",
    rail: null,
    baas_provider: null,
    baas_transfer_id: null,
    created_at: now.toISOString(),
    settled_at: now.toISOString(),
    kind: "funding_received",
  });
  const journal = await postJournal(
    store,
    {
      kind: "funding_received",
      ref_type: "stripe_event",
      ref_id: event.value.id,
      legs: [
        fboDebit(funding.value.amount_cents),
        vaultCredit(funding.value.payee_id, "available", funding.value.amount_cents),
      ],
    },
    now,
  );
  if (!journal.ok) {
    return donJsonError(500, journal.code, journal.message);
  }
  return NextResponse.json({
    ok: true,
    handled: true,
    funding: {
      payee_id: funding.value.payee_id,
      amount_cents: funding.value.amount_cents,
      vault_available_balance: vault.available_balance,
      ledger_transaction_id: ledger.id,
      journal_id: journal.journal.id,
    },
  });
}
