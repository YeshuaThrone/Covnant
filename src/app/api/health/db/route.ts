/**
 * GET /api/health/db — read-only Supabase schema diagnostic.
 *
 * Pings every table the stores expect with a head-only count through the
 * server-only service-role client and reports per-table existence, row
 * count, and the raw Postgres error message when a read fails.
 *
 * Exists because some store reads swallow Supabase errors and fall back to
 * the empty in-memory index — a missing table otherwise masquerades as a
 * healthy empty ledger (`mode: "supabase"` reflects credential presence,
 * not read success). This endpoint surfaces the truth.
 *
 * Read-only by construction (head + exact count, no row payloads) and never
 * exposes the service-role credential. No request authentication exists in
 * v1 by locked spec decision; error strings are limited to Postgres table/
 * relation diagnostics, which mirror the public migration files.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  SUPABASE_SERVICE_ROLE_KEY_ENV,
  SUPABASE_URL_ENV,
  resolveDataSourceMode,
} from '@/lib/data-source';

export const dynamic = 'force-dynamic';

const EXPECTED_TABLES = [
  'cbt_assets',
  'universal_royalty_ledger',
  'platform_allowlists',
  'contracts',
] as const;

interface TableHealth {
  exists: boolean;
  count: number | null;
  error: string | null;
}

export async function GET() {
  const mode = resolveDataSourceMode();

  if (mode !== 'supabase') {
    return Response.json(
      {
        ok: true,
        mode,
        tables: null,
        note: 'Supabase credentials not configured; stores run on the in-memory fallback.',
      },
      { headers: { 'cache-control': 'no-store' } },
    );
  }

  const client: SupabaseClient = createClient(
    process.env[SUPABASE_URL_ENV] as string,
    process.env[SUPABASE_SERVICE_ROLE_KEY_ENV] as string,
  );

  const entries = await Promise.all(
    EXPECTED_TABLES.map(async (table): Promise<[string, TableHealth]> => {
      const { count, error } = await client
        .from(table)
        .select('*', { count: 'exact', head: true });
      return [
        table,
        error
          ? { exists: false, count: null, error: error.message }
          : { exists: true, count: count ?? 0, error: null },
      ];
    }),
  );

  const tables = Object.fromEntries(entries);
  const ok = entries.every(([, health]) => health.exists);

  return Response.json(
    {
      ok,
      mode,
      tables,
      note: 'Read-only head-count pings through the service-role credential; RLS deny-all is unaffected.',
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
