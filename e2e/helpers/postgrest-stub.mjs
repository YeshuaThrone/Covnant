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
    res.statusCode = 404;
    return res.end(JSON.stringify({ message: `stub: unknown resource ${url.pathname}` }));
  }

  const idFilter = url.searchParams.get('id'); // "eq.<id>"

  if (req.method === 'GET') {
    let rows = db[table];
    if (idFilter?.startsWith('eq.')) {
      rows = rows.filter((row) => row.id === idFilter.slice(3));
    }
    const order = url.searchParams.get('order');
    if (order) {
      const [col, dir] = order.split('.');
      rows = [...rows].sort((a, b) =>
        dir === 'desc'
          ? String(b[col]).localeCompare(String(a[col]))
          : String(a[col]).localeCompare(String(b[col])),
      );
    }
    return send(req, res, 200, rows);
  }

  let raw = '';
  req.on('data', (chunk) => {
    raw += chunk;
  });
  req.on('end', () => {
    const payload = raw ? JSON.parse(raw) : {};

    if (req.method === 'POST') {
      // admin_action_log insert — select('id').single() expects the row back.
      const row = { id: `act_${crypto.randomUUID()}`, created_at: new Date().toISOString(), ...payload };
      db.admin_action_log.push(row);
      return send(req, res, 201, [row]);
    }

    if (req.method === 'PATCH') {
      if (!idFilter?.startsWith('eq.')) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ message: 'stub: PATCH requires id=eq.' }));
      }
      const target = db[table].find((row) => row.id === idFilter.slice(3));
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
