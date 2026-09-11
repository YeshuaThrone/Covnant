/**
 * Next.js instrumentation hook — runs once per server process at startup.
 *
 * Two boots:
 * 1. Normalizes NEXT_PUBLIC_SUPABASE_URL in-process so every reader of the
 *    env var (the lib stores and the vendored engine's own 'use server'
 *    actions, which construct clients directly) sees the project base URL
 *    even if the configured value was pasted from the dashboard's REST
 *    endpoint with a `/rest/v1` suffix. supabase-js appends `/rest/v1`
 *    itself; a doubled path makes every request fail with PostgREST
 *    PGRST125 "Invalid path specified in request URL".
 * 2. The Don dev-seed boot — with DON_DEV_SEED=1 the seeded in-memory
 *    dashboard store comes up before the first dashboard/route read, so
 *    local dev, the e2e harness, and preview deployments run the live
 *    resolver against deterministic seeded data. Production never sets the
 *    flag; this boot is a no-op there.
 *
 * This file compiles for BOTH runtimes (nodejs + edge) — the dev-seed
 * module imports the store layer (node:crypto and friends), which does not
 * exist on edge, so it is loaded through a dynamic import inside the
 * nodejs branch only (the documented runtime-split pattern; NEXT_RUNTIME
 * is inlined per runtime bundle and the edge copy dead-code-eliminates the
 * branch).
 */

import { normalizeSupabaseUrl } from '@/lib/supabase';

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

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

  if (process.env.DON_DEV_SEED === '1') {
    const { bootDevSeedStore } = await import('@/lib/server/devSeed');
    await bootDevSeedStore();
  }
}
