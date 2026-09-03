/**
 * Shared Supabase client factory — normalizes the project URL.
 *
 * supabase-js appends `/rest/v1/<resource>` itself. A URL configured as the
 * dashboard's REST endpoint (ending in `/rest/v1` or `/rest/v1/`) doubles the
 * path and every request fails with PostgREST PGRST125 "Invalid path
 * specified in request URL" — observed in production on 2026-09-03, where
 * every store read failed while the credentials themselves appeared healthy.
 * Normalize the configured value to the project base so either form works.
 *
 * The service-role credential is server-only and is never exposed or logged.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_SERVICE_ROLE_KEY_ENV, SUPABASE_URL_ENV } from './data-source';

export function normalizeSupabaseUrl(raw: string): string {
  let url = raw.trim().replace(/\/+$/, '');
  if (url.endsWith('/rest/v1')) {
    url = url.slice(0, -'/rest/v1'.length);
  }
  return url;
}

export function supabaseFromEnv(): SupabaseClient | undefined {
  const url = process.env[SUPABASE_URL_ENV];
  const key = process.env[SUPABASE_SERVICE_ROLE_KEY_ENV];
  return url && key ? createClient(normalizeSupabaseUrl(url), key) : undefined;
}
