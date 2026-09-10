// Sandbox Plaid KYC — Cursor's Phase 2 re-drop (src/lib/server/plaid.ts).
//
// Gap-fill disclosure: the re-drop's handlePlaidKyc calls
// verifySandboxIdentity, but its body appears in no drop. This module authors
// the minimal sandbox counterpart consistent with the drop's own fixtures
// (sandboxKycDecision: /FAIL/i legal_name or ssn_last_4 "0000" fails) and the
// Store's KYC surface (insertKycVerification). Async adaptation only (Store
// PR contract): store calls are awaited.

import { randomUUID } from "node:crypto";
import type { Store } from "@/lib/server/store";
import type {
  CreateLinkTokenInput,
  KycIdentityPayload,
  KycStatus,
  KycVerificationRecord,
  PlaidKycInput,
  VerifyIdentityInput,
} from "@/lib/don/types";

export const PLAID_LINK_TTL_MS = 4 * 60 * 60 * 1000;

export type PlaidKycSuccess =
  | {
      mode: "sandbox";
      action: "create_link_token";
      creator_id: string;
      link_token: string;
      public_token: string;
      expiration: string;
      products: CreateLinkTokenInput["products"];
      request_id: string;
    }
  | {
      mode: "sandbox";
      action: "verify_identity";
      creator_id: string;
      status: KycStatus;
      failure_reason: string | null;
      verification: KycVerificationRecord;
    };

export type PlaidKycHandlerResult =
  | { ok: true; value: PlaidKycSuccess }
  | { ok: false; status: number; code: string; message: string };

export function sandboxKycDecision(identity: KycIdentityPayload): {
  status: "verified" | "failed";
  failure_reason: string | null;
} {
  if (/fail/i.test(identity.legal_name)) {
    return {
      status: "failed",
      failure_reason: "Sandbox fixture: legal_name requested a failed KYC.",
    };
  }
  if (identity.ssn_last_4 === "0000") {
    return {
      status: "failed",
      failure_reason: "Sandbox fixture: ssn_last_4 0000 is a failed identity.",
    };
  }
  return { status: "verified", failure_reason: null };
}

export async function createSandboxLinkToken(
  store: Store,
  input: CreateLinkTokenInput,
  now: Date = new Date(),
): Promise<{ ok: true; value: PlaidKycSuccess }> {
  const expiration = new Date(now.getTime() + PLAID_LINK_TTL_MS).toISOString();
  const record = await store.insertPlaidLinkToken({
    creator_id: input.creator_id,
    link_token: `link-sandbox-${randomUUID()}`,
    public_token: `public-sandbox-${randomUUID()}`,
    access_token: `access-sandbox-${randomUUID()}`,
    expiration,
    products: input.products.join(","),
  });
  return {
    ok: true,
    value: {
      mode: "sandbox",
      action: "create_link_token",
      creator_id: record.creator_id,
      link_token: record.link_token,
      public_token: record.public_token,
      expiration: record.expiration,
      products: input.products,
      request_id: `req_${record.id}`,
    },
  };
}

// Authored gap-fill (see header): persists the sandbox KYC decision the drop's
// fixtures define, via the merged Store's verification ledger.
export async function verifySandboxIdentity(
  store: Store,
  input: VerifyIdentityInput,
  now: Date = new Date(),
): Promise<{ ok: true; value: PlaidKycSuccess }> {
  const decision = sandboxKycDecision(input.identity);
  const verification = await store.insertKycVerification({
    creator_id: input.creator_id,
    plaid_link_token: input.link_token ?? null,
    plaid_public_token: input.public_token ?? null,
    status: decision.status,
    identity_json: JSON.stringify(input.identity),
    failure_reason: decision.failure_reason,
    created_at: now.toISOString(),
    verified_at: decision.status === "verified" ? now.toISOString() : null,
  });
  return {
    ok: true,
    value: {
      mode: "sandbox",
      action: "verify_identity",
      creator_id: input.creator_id,
      status: decision.status,
      failure_reason: decision.failure_reason,
      verification,
    },
  };
}

export async function handlePlaidKyc(
  store: Store,
  input: PlaidKycInput,
  now: Date = new Date(),
): Promise<PlaidKycHandlerResult> {
  if (input.action === "create_link_token") {
    return await createSandboxLinkToken(store, input, now);
  }
  return await verifySandboxIdentity(store, input, now);
}
