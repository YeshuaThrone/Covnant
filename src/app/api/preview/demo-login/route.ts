/**
 * /api/preview/demo-login — the preview-only auto-session door.
 *
 * GET: when VERCEL_ENV is 'preview', signs in the seeded demo creator via
 * the SAME cookie-backed server client every route handler uses (the
 * @supabase/ssr client over the request's cookies() store — session cookies
 * are written by that store and the redirect response carries them), then
 * redirects to /dashboard. The resulting session is a normal authenticated
 * creator session: /api/covnant/me resolves it exactly as any other sign-in,
 * fail-closed, no added disclosures.
 *
 * Outside preview (VERCEL_ENV 'production' or unset) the route is inert:
 * 404 before any credential is touched. Production auth is untouched.
 *
 * Failure path: an unavailable Supabase client or a rejected sign-in
 * redirects to /signin?demo_login_failed=1 — never back to /dashboard, so
 * the page-level hook cannot loop (the failed param renders the visitor
 * state even in preview).
 */

import { NextResponse } from 'next/server';

import {
  isPreviewDemoAccessEnabled,
  PREVIEW_DEMO_CREATOR_EMAIL,
  PREVIEW_DEMO_CREATOR_PASSWORD,
} from '@/lib/server/previewDemoAccess';
import { createServerSupabaseClient } from '@/lib/server/supabaseSsr';

export const dynamic = 'force-dynamic';

/**
 * Relative 307 — legal per RFC 7231 and resolved by the browser against the
 * requesting origin. Building the Location from `request.url` instead leaks
 * the deployment's internal origin (e.g. http://localhost:8123) to clients
 * behind a proxy, which strands them on their own localhost.
 */
function redirectTo(path: string): NextResponse {
  return new NextResponse(null, { status: 307, headers: { Location: path } });
}

export async function GET(): Promise<NextResponse> {
  if (!isPreviewDemoAccessEnabled()) {
    return NextResponse.json({ error: { code: 'not_found' } }, { status: 404 });
  }

  const supabase = await createServerSupabaseClient();
  if (!supabase) {
    // Supabase env not configured on this deployment — fail to the real
    // sign-in page rather than loop.
    return redirectTo('/signin?demo_login_failed=1');
  }

  const { error } = await supabase.auth.signInWithPassword({
    email: PREVIEW_DEMO_CREATOR_EMAIL,
    password: PREVIEW_DEMO_CREATOR_PASSWORD,
  });
  if (error) {
    return redirectTo('/signin?demo_login_failed=1');
  }

  return redirectTo('/dashboard');
}
