/**
 * GET /auth/callback — where Supabase email links land.
 *
 * Email-confirmation (and recovery/magic-link) links arrive here in either
 * of the two shapes Supabase sends, and BOTH must establish the cookie
 * session through the @supabase/ssr server client:
 *
 *   - `?code=<authorization-code>` — the PKCE code flow (OAuth/SSO and
 *     magic-link flows that carry a code verifier): supabase.auth.exchangeCodeForSession.
 *   - `?token_hash=<hash>&type=<otp-type>` — the email token links
 *     (confirmation links for accounts created without a browser-side PKCE
 *     verifier — the server-side signup route's shape, plus recovery and
 *     magic links): supabase.auth.verifyOtp. The type is allow-listed to
 *     the email-link OTP types (never SMS/phone).
 *
 * Success redirects to /dashboard — the destination the spec pins. Failure
 * (missing/malformed parameters, a rejected exchange) redirects to / — the
 * landing, which owns the signup surface. No UI is rendered here; this is
 * a pure redirect handler.
 */

import { NextResponse } from 'next/server';
import type { EmailOtpType } from '@supabase/supabase-js';

import { createServerSupabaseClient } from '@/lib/server/supabaseSsr';

export const dynamic = 'force-dynamic';

const DASHBOARD_PATH = '/dashboard';
const LANDING_PATH = '/';

/** Email-link OTP types that may establish a session (never SMS/phone). */
const EMAIL_OTP_TYPES: readonly string[] = [
  'signup',
  'invite',
  'magiclink',
  'recovery',
  'email_change',
  'email',
];

export async function GET(request: Request): Promise<Response> {
  const { searchParams, origin } = new URL(request.url);
  const supabase = await createServerSupabaseClient();
  if (!supabase) {
    return NextResponse.redirect(`${origin}${LANDING_PATH}`);
  }

  const code = searchParams.get('code');
  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}${DASHBOARD_PATH}`);
    }
    return NextResponse.redirect(`${origin}${LANDING_PATH}`);
  }

  const tokenHash = searchParams.get('token_hash');
  const type = searchParams.get('type');
  if (tokenHash && type && EMAIL_OTP_TYPES.includes(type)) {
    const { error } = await supabase.auth.verifyOtp({
      type: type as EmailOtpType,
      token_hash: tokenHash,
    });
    if (!error) {
      return NextResponse.redirect(`${origin}${DASHBOARD_PATH}`);
    }
  }

  return NextResponse.redirect(`${origin}${LANDING_PATH}`);
}
