// Plaid sandbox exchange — Cursor's Phase 2 re-drop
// (exchangePlaidPublicToken). Async adaptation only (Store PR contract):
// store calls are awaited; the session/processor resolution order and the
// encrypt-on-first-exchange behavior are untouched.

import { randomUUID } from "node:crypto";
import type { Store } from "@/lib/server/store";
import type { PlaidExchangePayload } from "@/lib/don/validation";
import { readBaasProvider } from "@/services/baas";
import { encryptAccessToken, isEncryptedAccessToken } from "./crypto";

export async function exchangePlaidPublicToken(
  store: Store,
  input: PlaidExchangePayload,
  now: Date = new Date(),
) {
  const session = await store.getPlaidLinkTokenByPublicToken(input.public_token);
  if (session === undefined) {
    return {
      ok: false as const,
      status: 422,
      code: "unknown_plaid_token",
      message: "public_token does not match a sandbox Link session.",
    };
  }
  if (session.creator_id !== input.creator_id) {
    return {
      ok: false as const,
      status: 422,
      code: "plaid_token_mismatch",
      message: "public_token does not belong to this creator_id.",
    };
  }
  if (new Date(session.expiration).getTime() < now.getTime()) {
    return {
      ok: false as const,
      status: 422,
      code: "plaid_token_expired",
      message: "The Plaid Link token has expired. Create a new one.",
    };
  }
  let accessToken = session.access_token;
  if (!isEncryptedAccessToken(accessToken)) {
    accessToken = encryptAccessToken(accessToken);
    await store.updatePlaidAccessToken(session.public_token, accessToken);
  }
  const processor = input.processor ?? readBaasProvider();
  const existing = await store.getProcessorToken(session.public_token, processor);
  const processorRow =
    existing ??
    (await store.insertProcessorToken({
      creator_id: session.creator_id,
      public_token: session.public_token,
      processor,
      processor_token: `processor-sandbox-${processor}-${randomUUID()}`,
      account_id: `acc-sandbox-${randomUUID()}`,
      created_at: now.toISOString(),
    }));
  return {
    ok: true as const,
    value: {
      mode: "sandbox" as const,
      creator_id: session.creator_id,
      item_id: session.id,
      access_token: accessToken,
      processor,
      processor_token: processorRow.processor_token,
      account_id: processorRow.account_id,
    },
  };
}
