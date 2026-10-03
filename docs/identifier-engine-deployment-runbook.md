# Identifier Engine — Migration Deployment Runbook

> Canon v26 (founder, 2026-09-30), adapted to this repo's stack per the v13
> precedent. Normative order, fail-closed by construction (`set -e`):
> **[1] apply to TEST → [2] integration suite as a GATE → [3] apply to
> production → [4] verification complete.** A red suite can never reach
> production.

Stale labels recorded (founder draft → this repo): `Migration 0013` /
`migrate0013.sh` / `0013_add_spatial_web3.sql` land at the **next-free
migration index** on main (0011–0014 were taken; the trigger-expansion
migration is `0015_spatial_web3_identifiers.sql`). The `71/71` suite count
in the draft is the pre-v25 figure — **assert against the live registry
count** (74 distinct registered types; the founder canon's "75" counts
OPTA_PERSON_ID twice across v15 and v23 — see the glossary). `npm test --
run <file>` maps to `npx vitest run <file>`.

Stack adaptation (flagged per v13 precedent): `production-db.internal` and
the embedded `registry_admin` password are the founder's generic shape —
this repo deploys via **Supabase with env-supplied connection strings**
(never embedded credentials). `TEST_DATABASE_URL` and the production
`DATABASE_URL` come from the environment; the production string is pulled
from the Vercel production environment at run time, not stored in this
file.

## [1] Apply the migration to the TEST database

```bash
set -e
# TEST_DATABASE_URL: postgres://… (CI: postgres:16-alpine service)
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/0015_spatial_web3_identifiers.sql
```

The migration must also pass a **full-file syntax dry-run in a psql
transaction that is rolled back** before it is trusted (the PR 46 lesson —
CI once passed a broken migration):

```bash
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -c 'BEGIN;' \
  -f supabase/migrations/0015_spatial_web3_identifiers.sql \
  -c 'ROLLBACK;'
```

## [2] Run the integration suite as a GATE

```bash
TEST_DATABASE_URL="$TEST_DATABASE_URL" REDIS_URL="${REDIS_URL:-redis://localhost:6379}" \
  npx vitest run src/app/api/v1/identifiers/batch-ingest/__tests__/route.integration.test.ts
```

A red suite stops the runbook here. Fix, re-apply on a fresh test volume,
re-run. Never proceed to production with a failing gate.

CI runs this same gate in the `identifier-engine` job (postgres:16-alpine +
redis:7-alpine service containers, migrations applied with
`ON_ERROR_STOP=1`, then the suite).

## [3] Apply to production

```bash
set -e
# Pull the production connection string fresh from the Vercel production
# environment; strip the literal quotes before handing it to psql.
psql "$PRODUCTION_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f supabase/migrations/0015_spatial_web3_identifiers.sql
```

Single transaction, `ON_ERROR_STOP=1`: any error aborts the whole apply.
After the deploy leg, run behavioral probes (trigger reject path on
malformed values and unknown types, pass path on clean values, zero drift
on pre-existing tables) under the standing authorization, then remove all
temporary credential and probe files.

## [4] Verification complete

- Trigger reject path: malformed values and unknown types are rejected by
  name at the database.
- Pass path: clean values ingest; cross-references persist.
- Zero drift: pre-existing tables' definitions unchanged.
- App probes: homepage 200, dashboard 200, agent register 401 fail-closed.
