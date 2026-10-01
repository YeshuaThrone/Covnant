#!/usr/bin/env bash
#
# Migration 0015 deployment runbook — founder v26 canon, adapted to this
# stack (v13 precedent, flagged not applied upstream):
#   * production-db.internal / embedded registry_admin credentials are the
#     founder's generic shape — this repo deploys PostgreSQL via Supabase
#     with env-supplied connection strings. NEVER embed credentials here.
#   * "npm test -- run <file>" maps to "npx vitest run <file>".
#   * The ORDER and gate structure carry verbatim: set -e aborts the whole
#     run on ANY failure — test-DB migration, then the integration-suite
#     gate, then production. A red suite can never reach production.
#
# Required env:
#   TEST_SUPABASE_DB_URL       postgres://... for the TEST database
#   PROD_SUPABASE_DB_URL       postgres://... for the PRODUCTION database
#
# The integration-suite gate asserts against the LIVE registry count
# (74 distinct types at this writing; the founder's "71/71" reflects the
# pre-v25 count). The suite derives counts dynamically — further founder
# additions stay robust without edits here.

set -e

echo "=================================================="
echo "Starting Migration 0015: Spatial & Web3 Types"
echo "=================================================="

: "${TEST_SUPABASE_DB_URL:?Set TEST_SUPABASE_DB_URL to the test database connection string}"
: "${PROD_SUPABASE_DB_URL:?Set PROD_SUPABASE_DB_URL to the production database connection string}"

# 1. Run migration on Test Database
echo "[1/4] Applying 0015 migration to Test Database..."
psql "$TEST_SUPABASE_DB_URL" -v ON_ERROR_STOP=1 \
  -f ./supabase/migrations/0015_spatial_web3_identifiers.sql
echo "✓ Test database migration successful."

# 2. Run test suite to verify the trigger registry and new validation branches
echo "[2/4] Running integration test suite gate..."
TEST_DATABASE_URL="$TEST_SUPABASE_DB_URL" REDIS_URL="${REDIS_URL:-}" \
  npx vitest run \
  src/app/api/v1/identifiers/batch-ingest/__tests__/route.integration.test.ts
echo "✓ Integration tests passed."

# 3. Run migration on Production Database
echo "[3/4] Applying 0015 migration to Production Database..."
psql "$PROD_SUPABASE_DB_URL" -v ON_ERROR_STOP=1 \
  -f ./supabase/migrations/0015_spatial_web3_identifiers.sql
echo "✓ Production database migration successful."

echo "[4/4] Verification complete. All systems synchronized."
echo "=================================================="
