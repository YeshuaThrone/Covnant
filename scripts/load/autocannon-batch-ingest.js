/**
 * Canon v28 (founder, 2026-10-01) — LOAD-TEST HARNESS: AUTOCANNON BATCH-INGEST.
 *
 * FILED AND DEFERRED, per the founder instruction: use the harness LAST,
 * after the build finishes. DO NOT RUN IT IN THIS PR — it is filed so the
 * deferred action is tracked and ready.
 *
 * Run later (autocannon is an npx-only tool, never shipped as a dependency):
 *
 *   TARGET=http://localhost:3000 npx autocannon -c 100 -d 30 \
 *     -m POST -H content-type=application/json -H "X-Tenant-Id=load_test_tenant" \
 *     -b "$(node scripts/load/autocannon-batch-ingest.js --print-body)" \
 *     --scripts scripts/load/autocannon-batch-ingest.js
 *
 * Canon notes carried verbatim:
 * - POST to the batch-ingest route, 100 connections x 30s,
 *   X-Tenant-Id load_test_tenant, GTIN14 10012345678902 (pattern-clean).
 * - track() renders the progress bar.
 * - Paste repairs applied: restored missing template-literal backticks;
 *   result.2xx -> result['2xx'] (invalid identifier).
 * - The '429 Rate Limited' label reads result.non2xx (ALL non-2xx) — the
 *   founder label is kept; 429-specific figures live in statusCodeStats.
 * - No Authorization header is sent: once v24 authenticateJWT gates the
 *   route, the harness needs a real Bearer token or it measures 401s.
 * - With the v22 sliding-window limiter active, saturation 429s are the
 *   limiter working — the harness doubles as limiter verification.
 * - Confirm the route path against the production handler at run time.
 */

'use strict';

// --print-body emits the batch payload without starting a load test (the
// shell recipe above pipes it into -b).
if (process.argv.includes('--print-body')) {
  process.stdout.write(
    JSON.stringify({
      tenantId: 'load_test_tenant',
      records: [
        {
          entityId: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
          verticalCategory: 'SUPPLY_CHAIN',
          primaryCodeType: 'GTIN14',
          primaryCodeValue: '10012345678902',
        },
      ],
    }) + '\n',
  );
  process.exit(0);
}

const autocannon = require('autocannon'); // eslint-disable-line @typescript-eslint/no-require-imports -- CommonJS lazy require so `node scripts/load/autocannon-batch-ingest.js --print-body` works without autocannon installed (npx-only tool)

const target = process.env.TARGET ?? 'http://localhost:3000';
// Confirm the route path against the production handler at run time.
const routePath = '/api/v1/identifiers/batch-ingest';

const instance = autocannon(
  {
    url: `${target}${routePath}`,
    method: 'POST',
    connections: 100,
    duration: 30, // seconds
    headers: {
      'content-type': 'application/json',
      'X-Tenant-Id': 'load_test_tenant',
    },
    body: JSON.stringify({
      tenantId: 'load_test_tenant',
      records: [
        {
          entityId: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
          verticalCategory: 'SUPPLY_CHAIN',
          primaryCodeType: 'GTIN14',
          primaryCodeValue: '10012345678902',
        },
      ],
    }),
  },
  (err, result) => {
    if (err) {
      console.error('autocannon failed:', err);
      process.exitCode = 1;
      return;
    }
    // Paste repair carried: result['2xx'] (result.2xx is an invalid identifier).
    console.log(`2xx: ${result['2xx']}`);
    // Founder label kept — reads ALL non-2xx; 429-specific via statusCodeStats.
    console.log(`429 Rate Limited (non2xx): ${result.non2xx}`);
    if (result.statusCodeStats) {
      for (const [code, stats] of Object.entries(result.statusCodeStats)) {
        console.log(`  status ${code}: ${stats.count}`);
      }
    }
    console.log(`latency p99: ${result.latency.p99} ms`);
  },
);

// The founder harness tracks progress while the run is in flight.
process.stdout.write('Load test running — track():\n');
autocannon.track(instance, { renderResultsTable: true });
