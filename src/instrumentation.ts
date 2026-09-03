/**
 * Next.js instrumentation hook — runs once per server process at startup.
 *
 * Normalizes NEXT_PUBLIC_SUPABASE_URL in-process so every reader of the env
 * var (the lib stores and the vendored engine's own 'use server' actions,
 * which construct clients directly) sees the project base URL even if the
 * configured value was pasted from the dashboard's REST endpoint with a
 * `/rest/v1` suffix. supabase-js appends `/rest/v1` itself; a doubled path
 * makes every request fail with PostgREST PGRST125 "Invalid path specified
 * in request URL".
 */

import { normalizeSupabaseUrl } from '@/lib/supabase';

export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const raw = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!raw) return;

  const normalized = normalizeSupabaseUrl(raw);
  if (normalized !== raw.trim()) {
    process.env.NEXT_PUBLIC_SUPABASE_URL = normalized;
    console.warn(
      '[covnant] NEXT_PUBLIC_SUPABASE_URL contained a REST path or trailing slash; normalized to the project base for this process.',
    );
  }
}
