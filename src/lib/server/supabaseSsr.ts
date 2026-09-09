/**
 * Cookie-based Supabase session clients (@supabase/ssr) — the READ side of
 * auth. The signup WRITE path keeps its own factories in
 * src/lib/server/supabase.ts (anon persistSession:false + service role);
 * this module is deliberately separate so the existing signup factories and
 * their normalization reuse stay byte-identical.
 *
 * Credentials come from the SAME documented names readSupabaseEnv accepts
 * (SUPABASE_URL / NEXT_PUBLIC_SUPABASE_URL and SUPABASE_ANON_KEY /
 * NEXT_PUBLIC_SUPABASE_ANON_KEY) — no new env vars. The service-role key is
 * never read here: cookie sessions run under the caller's RLS-enforcing
 * anon-key identity, never the operator's.
 */

import { createBrowserClient, createServerClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';

export type SupabasePublicEnv = {
  url: string;
  anonKey: string;
};

/**
 * Reads the Supabase URL + anon key under the documented names (the same
 * fallback pair readSupabaseEnv applies). Null when either is missing —
 * session consumers fail closed (401/503) and the middleware passes the
 * request through untouched; an unconfigured Supabase must never break the
 * site.
 */
export function readSupabasePublicEnv(
  env: NodeJS.ProcessEnv = process.env,
): SupabasePublicEnv | null {
  const url = env.SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = env.SUPABASE_ANON_KEY ?? env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    return null;
  }
  return { url, anonKey };
}

/**
 * True when the request carries any Supabase auth-token cookie. Storage keys
 * are `sb-<project-ref>-auth-token` (large tokens chunk into `.0`, `.1`, …),
 * so prefix + `-auth-token` matches every shape. This is only the cheap
 * "absent vs present" signal for a 401's named reason — the authoritative
 * validity check is always supabase.auth.getUser().
 */
export async function hasSupabaseSessionCookies(): Promise<boolean> {
  const cookieStore = await cookies();
  return cookieStore
    .getAll()
    .some((cookie) => cookie.name.startsWith('sb-') && cookie.name.includes('-auth-token'));
}

/**
 * The browser session client — the client-side half of the standard
 * @supabase/ssr pair (createBrowserClient). Null when unconfigured.
 */
export function createBrowserSupabaseClient(): SupabaseClient | null {
  const env = readSupabasePublicEnv();
  if (!env) {
    return null;
  }
  return createBrowserClient(env.url, env.anonKey);
}

/**
 * The server session client for route handlers and server components —
 * createServerClient over the request's cookies() store. One client per
 * request; token refreshes write their rotated cookies back through the
 * store (a Server Component store rejects writes — that exact case is the
 * framework contract, and the middleware owns the refresh write there).
 */
export async function createServerSupabaseClient(): Promise<SupabaseClient | null> {
  const env = readSupabasePublicEnv();
  if (!env) {
    return null;
  }
  const cookieStore = await cookies();
  return createServerClient(env.url, env.anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a Server Component: cookie writes are impossible by
          // design (the middleware refresh owns them). Nothing to swallow —
          // this is the documented @supabase/ssr Server Component path.
        }
      },
    },
  });
}
