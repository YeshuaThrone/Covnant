/**
 * The ONE JSON error envelope for the Covnant API routes — a single
 * jsonError signature in the drop's named-code shape: (status, code,
 * message).
 *
 * On the wire the envelope stays the live contract's shape — `error` is the
 * sanitized human message, `reason` is the machine-readable code. That one
 * `reason` slot is the code registry shared by the drop's validation codes
 * (malformed_body, missing_*, invalid_*, udr_terms_required, duplicate_email,
 * auth_signup_failed, profile_insert_failed, rate_limited,
 * supabase_not_configured) and the live pipeline reasons (UCT_MINT_FAILED,
 * INCREASE_NOT_CONFIGURED, INCREASE_UNAVAILABLE) — see the signup contract
 * doc for the full table.
 *
 * Every error response is cache-control: no-store.
 */

import { NextResponse } from 'next/server';

export function jsonError(status: number, code: string, message: string): Response {
  return Response.json(
    { ok: false, error: message, reason: code },
    { status, headers: { 'cache-control': 'no-store' } },
  );
}

/**
 * Don Engine wire envelope (Cursor drop): `{ error, code }`. The legacy
 * jsonError envelope above stays byte-for-byte intact — admin login and
 * signup tests assert its exact body — so the Don surface gets its own
 * helper instead of a changed shared envelope. Don routes at intake import
 * this in place of the drop's `jsonError`.
 */
export type DonApiErrorEnvelope = { error: string; code: string };

export function donJsonError(
  status: number,
  code: string,
  message: string,
): NextResponse<DonApiErrorEnvelope> {
  return NextResponse.json({ error: message, code }, { status });
}
