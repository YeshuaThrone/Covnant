/**
 * The browser session client — the client-side half of the standard
 * @supabase/ssr pair. Client-safe by design: importing this module from a
 * 'use client' component must never pull next/headers into the browser
 * bundle, so the env read comes from the client-safe module and this file
 * has no server-only imports.
 */

import { createBrowserClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * The browser session client. Null when unconfigured — consumers render the
 * honest fallback (the platform's in-memory mode), never a broken client.
 *
 * The literal `process.env.NEXT_PUBLIC_*` member accesses are load-bearing:
 * Next's build inlines ONLY direct `process.env.NEXT_PUBLIC_X` expressions
 * into the browser bundle. The shared readSupabasePublicEnv helper reads
 * through a parameter, which compiles to an empty runtime lookup in the
 * browser — the client factory must read its own literals. The server
 * session module keeps the shared helper (real process.env at runtime).
 */
export function createBrowserSupabaseClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    return null;
  }
  return createBrowserClient(url, anonKey);
}
