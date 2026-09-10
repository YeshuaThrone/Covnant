/**
 * The public Supabase credential read — the single source both the server
 * session module (src/lib/server/supabaseSsr.ts) and the client-safe browser
 * factory (src/lib/auth/browserClient.ts) share.
 *
 * Client-safe by design: NO next/headers import may enter this module's
 * graph — the browser bundle imports it, and next/headers is server-only.
 */

export type SupabasePublicEnv = {
  url: string;
  anonKey: string;
};

/**
 * Reads the Supabase URL + anon key under the documented names (the same
 * fallback pair readSupabaseEnv accepts). Null when either is missing —
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
