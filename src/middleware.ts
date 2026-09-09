/**
 * Session-refresh middleware — the read-side session keeper.
 *
 * On every navigation it runs supabase.auth.getUser(): a valid session is
 * confirmed against the auth server and an expired access token is
 * refreshed server-side, the rotated cookies riding back on the response.
 * It NEVER gates, redirects, or rewrites a route — there is no auth gate in
 * this product yet — so an unconfigured Supabase (missing URL/anon key) and
 * an absent session are both silent pass-throughs and every page renders
 * exactly as before.
 */

import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

import { readSupabasePublicEnv } from '@/lib/server/supabaseSsr';

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const env = readSupabasePublicEnv();
  if (!env) {
    // Unconfigured Supabase: pass through untouched — middleware must never
    // become a hard dependency of the site.
    return NextResponse.next();
  }

  let supabaseResponse = NextResponse.next({ request });
  const supabase = createServerClient(env.url, env.anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        // The documented @supabase/ssr middleware adapter: mirror the write
        // onto the request for THIS pass, then onto a fresh response so the
        // rotated cookies reach the browser.
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        supabaseResponse = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          supabaseResponse.cookies.set(name, value, options);
        }
      },
    },
  });

  // getUser() (not getSession()): the token is validated against the auth
  // server, and a stale token is refreshed as a side effect — the refresh
  // this middleware exists for. A missing/invalid session is the normal
  // visitor case, not an error to surface.
  await supabase.auth.getUser();

  return supabaseResponse;
}

export const config = {
  // Everything except framework static assets and images — the documented
  // matcher shape from the @supabase/ssr Next.js guide.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
};
