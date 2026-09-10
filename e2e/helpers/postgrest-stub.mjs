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
      // The me aggregate's profile row — keyed by the stub auth user's id.
      id: 'e2e_creator',
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
  // The me aggregate's registry row — the holder entry carries the PR #26
  // signup shape plus issuance facts, keyed by the creator's session email.
  cbt_assets: [
    {
      cbt_code: 'CBT-SIGNUP-REGISTRY',
      rights_holders: [
        {
          rightsHolderId: 'rh_e2e_creator',
          name: 'nova@example.com',
          role: 'COMPOSER',
          email: 'nova@example.com',
          payoutRouting: {},
          uct: 'UCT-US-2026-9F3A7C21-56',
          uctCreatedAt: '2026-09-09T00:00:00.000Z',
          uctJurisdiction: 'US',
          engine: 'music_recording',
        },
      ],
    },
  ],
  // Display-complete ledger rows — one qualifying settlement (exact BigInt
  // unit strings emerge from grossShare/netShare × 1e8), one other-holder
  // row, one payout debit that must never surface as a royalty.
  universal_royalty_ledger: [
    {
      transaction_id: 'e2e_tx_2',
      cbt_code: 'CBT-MUS-2026-AAAA1111',
      platform: 'Spotify',
      currency: 'USD',
      created_at: '2026-08-01T00:00:00Z',
      disbursements: [
        { rightsHolderId: 'rh_e2e_creator', grossShare: 2.0, netShare: 1.4 },
      ],
    },
    {
      transaction_id: 'e2e_tx_1',
      cbt_code: 'CBT-MUS-2026-AAAA1111',
      platform: 'Bandcamp',
      currency: 'EUR',
      created_at: '2026-07-01T00:00:00Z',
      disbursements: [
        { rightsHolderId: 'rh_e2e_creator', grossShare: 0.5, netShare: 0.35 },
        { rightsHolderId: 'rh_someone_else', grossShare: 99, netShare: 99 },
      ],
    },
    {
      transaction_id: 'e2e_payout',
      cbt_code: 'CBT-MUS-2026-AAAA1111',
      platform: 'Covnant',
      currency: 'USD',
      created_at: '2026-07-15T00:00:00Z',
      disbursements: [
        {
          type: 'DISBURSEMENT',
          rightsHolderId: 'rh_e2e_creator',
          payoutAmount: '25000000',
          amountPaid: '25000000',
          taxWithheld: '0',
          timestamp: 1,
          remainingNetBalance: '0',
        },
      ],
    },
  ],
};

/**
 * The stub's auth user — the identity the session JWT names. The access
 * token is a structurally valid unsigned JWT (far-future exp so no refresh
 * is ever attempted against the stub).
 */
const AUTH_USER = {
  id: 'e2e_creator',
  aud: 'authenticated',
  email: 'nova@example.com',
  email_confirmed_at: '2026-09-09T00:00:00.000Z',
  created_at: '2026-09-09T00:00:00.000Z',
  role: 'authenticated',
};

function unsignedJwt(payload) {
  const encode = (part) => Buffer.from(JSON.stringify(part)).toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.e2e-stub-signature`;
}

const ACCESS_TOKEN = unsignedJwt({
  sub: AUTH_USER.id,
  email: AUTH_USER.email,
  role: 'authenticated',
  exp: 4102444800, // 2100-01-01 — never expires inside an e2e run
});

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

  // The app and the stub run on different origins (random app port vs the
  // fixed stub port), so the BROWSER client's calls are cross-origin —
  // answer preflights and stamp every response CORS-open like a hosted API.
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', '*');
  res.setHeader('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  if (url.pathname === '/__captured') {
    return send(req, res, 200, db.admin_action_log);
  }

  // Supabase Auth boundary: the password grant (the /signin form's browser
  // client) and the session validity check (getUser, server side).
  if (url.pathname === '/auth/v1/token' && req.method === 'POST') {
    return send(req, res, 200, {
      access_token: ACCESS_TOKEN,
      token_type: 'bearer',
      expires_in: 3600 * 24 * 365,
      expires_at: Math.floor(Date.now() / 1000) + 3600 * 24 * 365,
      refresh_token: 'e2e-stub-refresh-token',
      user: AUTH_USER,
    });
  }
  if (url.pathname === '/auth/v1/user' && req.method === 'GET') {
    return send(req, res, 200, AUTH_USER);
  }

  const table = url.pathname.match(/^\/rest\/v1\/([a-z_]+)$/)?.[1];
  if (!table || !(table in db)) {
    res.statusCode = 404;
    return res.end(JSON.stringify({ message: `stub: unknown resource ${url.pathname}` }));
  }

  const idFilter = url.searchParams.get('id'); // "eq.<id>"
  const prefer = req.headers.prefer ?? '';

  // A head:true count=exact read (the contracts count) — supabase-js sends
  // method HEAD with `Prefer: count=exact`; PostgREST answers no body and a
  // content-range total.
  if (req.method === 'HEAD' && prefer.includes('count=exact')) {
    let rows = db[table];
    const inFilter = url.searchParams.get('cbt_code'); // "in.(a,b)"
    if (inFilter?.startsWith('in.(')) {
      const codes = inFilter.slice(4, -1).split(',').map((code) => code.replaceAll('"', ''));
      rows = rows.filter((row) => codes.includes(row.cbt_code));
    }
    res.setHeader('content-range', `*/${rows.length}`);
    res.setHeader('content-type', 'application/json');
    res.statusCode = 200;
    return res.end();
  }

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
