/**
 * Server-side Supabase client factory for the signup auth core.
 *
 * The URL passes through the SHARED normalizeSupabaseUrl from
 * src/lib/supabase.ts — a URL configured as the dashboard's REST endpoint
 * (ending in /rest/v1) doubles the path and every request fails with
 * PostgREST PGRST125 "Invalid path specified in request URL" (production
 * incident, 2026-09-03). Do not create a second normalization here; do not
 * regress the reuse.
 *
 * The service-role credential is server-only and is never exposed or logged.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { normalizeSupabaseUrl } from '@/lib/supabase';

export type SupabaseEnv = {
  url: string;
  anonKey: string;
  serviceRoleKey: string;
};

/**
 * Reads the Supabase credentials. Accepts the documented public names
 * (NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY) and the drop's
 * non-public server-side fallbacks (SUPABASE_URL / SUPABASE_ANON_KEY) —
 * adds no new required env vars. Null when any credential is missing
 * (fail-closed 503 supabase_not_configured at the route).
 */
export function readSupabaseEnv(
  env: NodeJS.ProcessEnv = process.env,
): SupabaseEnv | null {
  const url = env.SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = env.SUPABASE_ANON_KEY ?? env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !anonKey || !serviceRoleKey) {
    return null;
  }
  return { url, anonKey, serviceRoleKey };
}

const SERVER_AUTH = {
  autoRefreshToken: false,
  persistSession: false,
} as const;

/** Anon-key client — signs users up (and in) under RLS-enforcing policies. */
export function createAuthClient(env: SupabaseEnv): SupabaseClient {
  return createClient(normalizeSupabaseUrl(env.url), env.anonKey, { auth: SERVER_AUTH });
}

/** Service-role client — profile writes + compensation; bypasses RLS. */
export function createAdminClient(env: SupabaseEnv): SupabaseClient {
  return createClient(normalizeSupabaseUrl(env.url), env.serviceRoleKey, {
    auth: SERVER_AUTH,
  });
}
