/**
 * Minimal PostgREST-compatible stub for the admin e2e spec ONLY.
 *
 * Why: the compliance-edit and allowlist-flip e2e flows need a Supabase
 * REST boundary, but the sandbox/CI has no database. This stub emulates
 * exactly the wire contract the stores exercise (list select+order,
 * id=eq lookups, PATCH returning the updated row via maybeSingle, and
 * admin_action_log inserts returning the id) — every piece of route,
 * validation, and audit logic above it runs for real.
 *
 * NOT a general PostgREST: unknown tables/methods return 404, so a
 * mispointed environment fails loudly instead of silently lying.
 */

import http from 'node:http';
import crypto from 'node:crypto';

const PORT = Number(process.env.PORT ?? 4599);

const now = '2026-09-01T00:00:00.000Z';
const db = {
  creator_profiles: [
    {
      id: 'creator_seeded_a',
      stage_name: 'Nova Reed',
      legal_name: 'Nora Reedman',
      email: 'nova@example.com',
      phone: '+15550000001',
      phone_verified_at: now,
      core_industry: 'Music',
      title: 'Producer',
      udr_terms_accepted_at: now,
      created_at: now,
      kyc_status: 'PENDING_INITIALIZATION',
      tax_form_type: 'W9',
      tax_verified: false,
      bank_account_linked: false,
    },
    {
      id: 'creator_seeded_b',
      stage_name: 'Atlas Vane',
      legal_name: 'Attila Vanek',
      email: 'atlas@example.com',
      phone: null,
      phone_verified_at: null,
      core_industry: 'Film',
      title: null,
      udr_terms_accepted_at: now,
      created_at: '2026-08-01T00:00:00.000Z',
      kyc_status: 'VERIFIED',
      tax_form_type: 'EIN',
      tax_verified: true,
      bank_account_linked: true,
    },
  ],
  platform_allowlists: [
    {
      id: 'allowlist_seeded_a',
      platform: 'youtube',
      target_account_id: 'UC-seed-0001',
      cbt_code: 'CBT-SEED-1',
      creator_incentive_share_pct: 70,
      status: 'ACTIVE',
      created_at: now,
    },
  ],
  admin_action_log: [],
  // MUL Registry (migration 0007) — one clearance row per asset_cbt_code,
  // plus the append-only transition replay. 0003 is the machine's own
  // display case: still cleared, term already ended (expired ≠ cleared).
  mul_clearances: [
    {
      asset_cbt_code: 'CBT-TRK-000000000001',
      state: 'draft',
      licensee: null,
      territory: null,
      term_start: null,
      term_end: null,
      updated_at: '2026-09-20T00:00:00.000Z',
    },
    {
      asset_cbt_code: 'CBT-TRK-000000000002',
      state: 'requested',
      licensee: 'Northwind Films',
      territory: 'US',
      term_start: '2026-09-01T00:00:00.000Z',
      term_end: '2027-09-01T00:00:00.000Z',
      updated_at: '2026-09-21T00:00:00.000Z',
    },
    {
      asset_cbt_code: 'CBT-TRK-000000000003',
      state: 'cleared',
      licensee: 'Meridian Records',
      territory: 'GB',
      term_start: '2026-01-01T00:00:00.000Z',
      term_end: '2026-09-01T00:00:00.000Z',
      updated_at: '2026-09-22T00:00:00.000Z',
    },
    {
      asset_cbt_code: 'CBT-TRK-000000000004',
      state: 'disputed',
      licensee: 'Harbor Games',
      territory: 'CA',
      term_start: '2026-05-01T00:00:00.000Z',
      term_end: '2027-05-01T00:00:00.000Z',
      updated_at: '2026-09-23T00:00:00.000Z',
    },
    {
      asset_cbt_code: 'CBT-TRK-000000000005',
      state: 'revoked',
      licensee: null,
      territory: 'DE',
      term_start: null,
      term_end: null,
      updated_at: '2026-09-24T00:00:00.000Z',
    },
  ],
  mul_clearance_transitions: [
    {
      id: 'tr_0001_a',
      asset_cbt_code: 'CBT-TRK-000000000001',
      from_state: null,
      to_state: 'draft',
      note: 'Draft opened for the demo reel.',
      created_at: '2026-09-20T00:00:00.000Z',
      insertion_order: 0,
    },
    {
      id: 'tr_0003_a',
      asset_cbt_code: 'CBT-TRK-000000000003',
      from_state: null,
      to_state: 'draft',
      note: null,
      created_at: '2026-09-01T00:00:00.000Z',
      insertion_order: 0,
    },
    {
      id: 'tr_0003_b',
      asset_cbt_code: 'CBT-TRK-000000000003',
      from_state: 'draft',
      to_state: 'requested',
      note: 'Licensee signed the term sheet.',
      created_at: '2026-09-02T00:00:00.000Z',
      insertion_order: 1,
    },
    {
      id: 'tr_0003_c',
      asset_cbt_code: 'CBT-TRK-000000000003',
      from_state: 'requested',
      to_state: 'cleared',
      note: 'Rights verified against the signed license.',
      created_at: '2026-09-22T00:00:00.000Z',
      insertion_order: 2,
    },
  ],
  contracts: [
    {
      id: 'contract_seeded_a',
      cbt_code: 'CBT-SEED-C1',
      template_id: 'tmpl_master_license',
      industry: 'Music',
      status: 'FINAL',
      fields: { assetTitle: 'Seeded Agreement', partyA: 'Nova Reed', partyB: 'Covnant' },
      document: '# Seeded Agreement\n\nMaster license terms for the seeded contract row.',
      created_at: '2026-09-02T00:00:00.000Z',
      updated_at: '2026-09-03T00:00:00.000Z',
    },
  ],
};

function send(req, res, status, body) {
  const accept = req.headers.accept ?? '';
  const wantsObject = accept.includes('vnd.pgrst.object');
  res.setHeader('content-type', 'application/json');
  res.statusCode = status;
  if (wantsObject) {
    // maybeSingle(): exactly one row → the row; zero rows → null (data-less).
    const single = Array.isArray(body) ? (body.length === 1 ? body[0] : null) : body;
    res.end(JSON.stringify(single));
  } else {
    res.end(JSON.stringify(body));
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://stub');

  if (url.pathname === '/__captured') {
    return send(req, res, 200, db.admin_action_log);
  }

  const table = url.pathname.match(/^\/rest\/v1\/([a-z_]+)$/)?.[1];
  if (!table || !(table in db)) {
    if (process.env.STUB_VERBOSE) {
      console.error(`[stub] MISS ${req.method} ${url.pathname}${url.search}`);
    }
    res.statusCode = 404;
    return res.end(JSON.stringify({ message: `stub: unknown resource ${url.pathname}` }));
  }

  // PostgREST filters arrive as `col=eq.value` query params (the id=eq. form
  // below is the MUL stores' asset lookup); select/order/on_conflict are
  // not filters.
  const RESERVED_PARAMS = new Set(['select', 'order', 'on_conflict']);
  const eqFilters = [...url.searchParams.entries()]
    .filter(([key, value]) => !RESERVED_PARAMS.has(key) && value.startsWith('eq.'))
    .map(([key, value]) => [key, value.slice(3)]);

  if (req.method === 'GET') {
    if (process.env.STUB_VERBOSE) {
      console.error(`[stub] GET ${url.pathname}${url.search}`);
    }
    let rows = db[table];
    for (const [column, value] of eqFilters) {
      rows = rows.filter((row) => row[column] === value);
    }
    // order=col.dir,col2.dir2 — stable multi-key sort (the transition
    // replay's created_at+insertion_order tie-break).
    const order = url.searchParams.get('order');
    if (order) {
      const keys = order.split(',').map((part) => {
        const [col, dir] = part.split('.');
        return { col, desc: dir === 'desc' };
      });
      rows = [...rows].sort((a, b) => {
        for (const { col, desc } of keys) {
          const cmp = String(a[col]).localeCompare(String(b[col]));
          if (cmp !== 0) return desc ? -cmp : cmp;
        }
        return 0;
      });
    }
    // count=exact pages read the filtered-set total off Content-Range.
    res.setHeader(
      'content-range',
      rows.length === 0 ? '*/0' : `0-${rows.length - 1}/${rows.length}`,
    );
    return send(req, res, 200, rows);
  }

  let raw = '';
  req.on('data', (chunk) => {
    raw += chunk;
  });
  req.on('end', () => {
    const payload = raw ? JSON.parse(raw) : {};

    if (req.method === 'POST') {
      // mul_clearances upsert (onConflict: 'asset_cbt_code'): merge into the
      // existing row when the conflict key already has one, else append.
      const conflictColumn = url.searchParams.get('on_conflict');
      if (conflictColumn) {
        const existing = db[table].findIndex((row) => row[conflictColumn] === payload[conflictColumn]);
        if (existing >= 0) {
          Object.assign(db[table][existing], payload);
          if (process.env.STUB_VERBOSE) {
            console.error(
              `[stub] UPSERT ${table} ${JSON.stringify(payload).slice(0, 160)} -> ${JSON.stringify(db[table][existing]).slice(0, 160)}`,
            );
          }
          return send(req, res, 200, [db[table][existing]]);
        }
        const inserted = { created_at: new Date().toISOString(), ...payload };
        db[table].push(inserted);
        if (process.env.STUB_VERBOSE) {
          console.error(`[stub] INSERT ${table} ${JSON.stringify(inserted).slice(0, 160)}`);
        }
        return send(req, res, 201, [inserted]);
      }
      // Plain insert into the addressed table — the row comes back because
      // .select().single() callers expect it. admin_action_log rows get the
      // act_ id shape when the caller omits one; other tables (the MUL
      // transition append) supply their own or take a uuid.
      const row = {
        id: payload.id ?? (table === 'admin_action_log' ? `act_${crypto.randomUUID()}` : crypto.randomUUID()),
        created_at: payload.created_at ?? new Date().toISOString(),
        ...payload,
      };
      db[table].push(row);
      if (process.env.STUB_VERBOSE) {
        console.error(`[stub] INSERT ${table} ${JSON.stringify(row).slice(0, 160)}`);
      }
      return send(req, res, 201, [row]);
    }

    if (req.method === 'PATCH') {
      const idFilter = eqFilters.find(([column]) => column === 'id');
      if (!idFilter) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ message: 'stub: PATCH requires id=eq.' }));
      }
      const target = db[table].find((row) => row.id === idFilter[1]);
      if (!target) return send(req, res, 200, []);
      Object.assign(target, payload);
      return send(req, res, 200, [target]);
    }

    res.statusCode = 405;
    return res.end(JSON.stringify({ message: `stub: ${req.method} not supported` }));
  });
});

server.on('error', (error) => {
  // Reuse runs may race a lingering stub — a busy port is not an e2e failure.
  if (error.code === 'EADDRINUSE') {
    console.log(`postgrest-stub: port ${PORT} already in use — reusing existing stub`);
    return;
  }
  throw error;
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`postgrest-stub: listening on 127.0.0.1:${PORT}`);
});
