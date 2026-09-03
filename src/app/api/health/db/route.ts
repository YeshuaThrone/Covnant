/**
 * GET /api/health/db — read-only Supabase schema diagnostic.
 *
 * Per expected table this endpoint runs two probes through the server-only
 * service-role client:
 *
 *   1. Existence/count — a head-only exact count. Proves the relation exists.
 *   2. Store read — the exact select/order shape the application store runs
 *      for that table (listAssets, listLedger, the allowlist lookup, and
 *      listContracts). Proves the table is usable by the app, not merely
 *      present: `create table if not exists` silently skips creation when a
 *      same-named table already exists with a different shape, and bare
 *      existence checks would pass while every store read fails.
 *
 * Read-only by construction (head counts and limit(1) reads, no row payloads
 * in the response) and never exposes the service-role credential. No request
 * authentication exists in v1 by locked spec decision; error strings are
 * limited to Postgres diagnostics, which mirror the public migration files.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  SUPABASE_SERVICE_ROLE_KEY_ENV,
  SUPABASE_URL_ENV,
  resolveDataSourceMode,
} from '@/lib/data-source';

export const dynamic = 'force-dynamic';

interface ProbeResult {
  data: unknown;
  error: { message: string } | null;
}

interface StoreProbe {
  table: string;
  probe: (db: SupabaseClient) => Promise<ProbeResult>;
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
      const { data, error } = await db
        .from('cbt_assets')
        .select('*')
        .order('created_timestamp', { ascending: false })
        .limit(1);
      return { data, error };
    },
  },
  {
    table: 'universal_royalty_ledger',
    probe: async (db) => {
      const { data, error } = await db
        .from('universal_royalty_ledger')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(1);
      return { data, error };
    },
  },
  {
    table: 'platform_allowlists',
    probe: async (db) => {
      const { data, error } = await db
        .from('platform_allowlists')
        .select('cbt_code, platform, target_account_id, status')
        .limit(1);
      return { data, error };
    },
  },
  {
    table: 'contracts',
    probe: async (db) => {
      const { data, error } = await db
        .from('contracts')
        .select('*')
        .order('updated_at', { ascending: false })
        .limit(1);
      return { data, error };
    },
  },
];

interface TableHealth {
  exists: boolean;
  count: number | null;
  storeRead: { ok: boolean; error: string | null };
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

  const db: SupabaseClient = createClient(
    process.env[SUPABASE_URL_ENV] as string,
    process.env[SUPABASE_SERVICE_ROLE_KEY_ENV] as string,
  );

  const entries = await Promise.all(
    STORE_PROBES.map(async ({ table, probe }): Promise<[string, TableHealth]> => {
      const [headCount, storeRead] = await Promise.all([
        db.from(table).select('*', { count: 'exact', head: true }),
        probe(db),
      ]);
      return [
        table,
        {
          exists: !headCount.error,
          count: headCount.error ? null : (headCount.count ?? 0),
          storeRead: {
            ok: !storeRead.error,
            error: storeRead.error ? storeRead.error.message : null,
          },
        },
      ];
    }),
  );

  const tables = Object.fromEntries(entries);
  const ok = entries.every(
    ([, health]) => health.exists && health.storeRead.ok,
  );

  return Response.json(
    {
      ok,
      mode,
      tables,
      note: 'Existence = head-only exact count; storeRead = the exact select/order shape the application store runs.',
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
