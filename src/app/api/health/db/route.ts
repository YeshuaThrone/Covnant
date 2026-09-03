/**
 * GET /api/health/db — read-only Supabase schema diagnostic.
 *
 * Per expected table this endpoint runs one probe through the server-only
 * service-role client: the exact select/order shape the application store
 * runs for that table (listAssets, listLedger, the allowlist lookup, and
 * listContracts), with an exact row count. This proves both that the
 * relation exists and that it is usable by the app — `create table if not
 * exists` silently skips creation when a same-named table already exists
 * with a different shape, and store reads that swallow errors would mask
 * the failure as a healthy empty ledger.
 *
 * Deliberately does NOT use head-only counts for existence: a bodyless HEAD
 * response parses to no error in supabase-js regardless of status, so a
 * 404 reports as a healthy zero-row table. GET with an exact count returns
 * rows and count together, so existence, count, and shape share one probe.
 *
 * Read-only by construction (limit(1) reads, no row payloads in the
 * response) and never exposes the service-role credential. No request
 * authentication exists in v1 by locked spec decision; error strings are
 * limited to Postgres diagnostics, which mirror the public migration files.
 */

import { resolveDataSourceMode } from '@/lib/data-source';
import { supabaseFromEnv } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

interface ProbeResult {
  count: number | null;
  error: { message: string } | null;
}

interface StoreProbe {
  table: string;
  probe: (db: NonNullable<ReturnType<typeof supabaseFromEnv>>) => Promise<ProbeResult>;
}

/**
 * One entry per table, mirroring the store's read shape exactly:
 *   - cbt_assets: listAssets (src/lib/sdk.ts) — select * ordered by created_timestamp
 *   - universal_royalty_ledger: listLedger (src/lib/ledger/store.ts) — select * ordered by created_at
 *   - platform_allowlists: engine allowlist lookup (src/engine/covenant-master-sdk.ts) — column-scoped select
 *   - contracts: listContracts (src/lib/contracts/store.ts) — select * ordered by updated_at
 */
const STORE_PROBES: StoreProbe[] = [
  {
    table: 'cbt_assets',
    probe: async (db) => {
      const { count, error } = await db
        .from('cbt_assets')
        .select('*', { count: 'exact' })
        .order('created_timestamp', { ascending: false })
        .limit(1);
      return { count, error };
    },
  },
  {
    table: 'universal_royalty_ledger',
    probe: async (db) => {
      const { count, error } = await db
        .from('universal_royalty_ledger')
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false })
        .limit(1);
      return { count, error };
    },
  },
  {
    table: 'platform_allowlists',
    probe: async (db) => {
      const { count, error } = await db
        .from('platform_allowlists')
        .select('cbt_code, platform, target_account_id, status', { count: 'exact' })
        .limit(1);
      return { count, error };
    },
  },
  {
    table: 'contracts',
    probe: async (db) => {
      const { count, error } = await db
        .from('contracts')
        .select('*', { count: 'exact' })
        .order('updated_at', { ascending: false })
        .limit(1);
      return { count, error };
    },
  },
];

interface TableHealth {
  ok: boolean;
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

  const db = supabaseFromEnv();
  if (!db) {
    return Response.json(
      { ok: false, mode, tables: null, note: 'Supabase credentials vanished between mode resolution and client creation.' },
      { headers: { 'cache-control': 'no-store' } },
    );
  }

  const entries = await Promise.all(
    STORE_PROBES.map(async ({ table, probe }): Promise<[string, TableHealth]> => {
      const { count, error } = await probe(db);
      return [
        table,
        {
          ok: !error,
          count: error ? null : (count ?? 0),
          error: error ? error.message : null,
        },
      ];
    }),
  );

  const tables = Object.fromEntries(entries);
  const ok = entries.every(([, health]) => health.ok);

  return Response.json(
    {
      ok,
      mode,
      tables,
      note: 'Each probe is the exact select/order shape the application store runs, with an exact count; a GET (not a head-only count) so a 404 can never report as a healthy zero-row table.',
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
