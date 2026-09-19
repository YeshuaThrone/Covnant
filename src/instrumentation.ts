/**
 * Next.js instrumentation hook — runs once per server process at startup.
 *
 * Normalizes NEXT_PUBLIC_SUPABASE_URL in-process so every reader of the
 * env var (the lib stores and the vendored engine's own 'use server'
 * actions, which construct clients directly) sees the project base URL
 * even if the configured value was pasted from the dashboard's REST
 * endpoint with a `/rest/v1` suffix. supabase-js appends `/rest/v1`
 * itself; a doubled path makes every request fail with PostgREST
 * PGRST125 "Invalid path specified in request URL".
 *
 * This file compiles for BOTH runtimes (nodejs + edge) and therefore may
 * only import Edge-safe modules. The Don dev-seed boot deliberately does
 * NOT live here: even a runtime-guarded dynamic import drags the dev-seed
 * module graph (which uses node:crypto via the engine SDK) into the edge
 * webpack bundle, where node builtins do not resolve and the build fails.
 * Seeding is lazy instead — getSeededStore() boots the store on the first
 * demo-door read with a shared in-flight promise, so DON_DEV_SEED=1 still
 * yields deterministic seeded data without an eager boot. Production never
 * sets the flag, so it stays a no-op there either way.
 */

import { normalizeSupabaseUrl } from '@/lib/supabase';

export async function register(): Promise<void> {
  const raw = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (raw) {
    const normalized = normalizeSupabaseUrl(raw);
    if (normalized !== raw.trim()) {
      process.env.NEXT_PUBLIC_SUPABASE_URL = normalized;
      console.warn(
        '[covnant] NEXT_PUBLIC_SUPABASE_URL contained a REST path or trailing slash; normalized to the project base for this process.',
      );
    }
  }
}
