#!/usr/bin/env bash
# Founder v14 Docker validation harness (directive addendum 32) for the 0012
# acceptance run: postgres:16-alpine, container universal_registry_db,
# database universal_registry, user registry_admin, port 5432, healthcheck
# pg_isready. init.sql IS the founder v11 migration (our 0012) — initdb.d
# scripts run only on first volume initialization, so the pgdata volume is
# recreated fresh on every run (the DDL changed with canon v11/v15).
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v docker >/dev/null 2>&1; then
  echo "SKIP: docker unavailable on this host — run the suite against scratch Postgres instead:"
  echo "  psql -v ON_ERROR_STOP=1 -f supabase/tests/0012_acceptance.sql"
  exit 2
fi

cleanup() {
  docker rm -f universal_registry_db >/dev/null 2>&1 || true
  docker volume rm universal_registry_pgdata >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker volume rm universal_registry_pgdata >/dev/null 2>&1 || true  # fresh pgdata — the DDL changed

docker run -d --name universal_registry_db \
  -e POSTGRES_USER=registry_admin \
  -e POSTGRES_PASSWORD=registry_admin_local \
  -e POSTGRES_DB=universal_registry \
  -v universal_registry_pgdata:/var/lib/postgresql/data \
  --mount type=bind,source="$(pwd)/0012_docker_roles.sql",target=/docker-entrypoint-initdb.d/00-roles.sql \
  --mount type=bind,source="$(pwd)/../migrations/0012_universal_identity.sql",target=/docker-entrypoint-initdb.d/init.sql \
  --health-cmd="pg_isready -U registry_admin -d universal_registry" \
  postgres:16-alpine >/dev/null

# Bounded readiness wait (2 min cap): if the container dies mid-init (initdb
# failure, pull stall), docker exec would fail forever in an unbounded loop —
# so detect a dead container, dump its logs, and fail loudly instead.
ready=0
for _ in $(seq 1 120); do
  if [ "$(docker inspect -f '{{.State.Running}}' universal_registry_db 2>/dev/null)" != "true" ]; then
    echo "FATAL: universal_registry_db is not running — initdb likely failed. Container logs:" >&2
    docker logs universal_registry_db 2>&1 | tail -40 >&2 || true
    exit 1
  fi
  # Readiness must require a REAL query against the target database, not
  # pg_isready: during initdb Postgres runs a temp server on the unix socket
  # and pg_isready exits 0 ("accepting connections") against ANY server,
  # including one that still lacks the target database — the loop then exits
  # false-ready and the acceptance suite below dies on a missing relation.
  # (pg_isready would also answer for a not-yet-created role, so the probe
  # uses the container's actual superuser — POSTGRES_USER=registry_admin;
  # there is no `postgres` role here.)
  #
  # The probe must also speak TCP (-h 127.0.0.1), not the unix socket: the
  # postgres image's entrypoint runs its init phase against a SOCKET-ONLY
  # temp server (docker_temp_server_start sets -c listen_addresses=''), and
  # initdb has already created the registry_admin role by the time init
  # scripts run — so a socket probe succeeds against the temp server
  # mid-init and the loop exits false-ready right before the entrypoint
  # stops it and starts the real server. The acceptance psql then fires
  # into that gap: "connection to server on socket ... No such file or
  # directory", psql exit 2, set -e kills the suite (observed twice on CI
  # 2026-10-05). The temp server never listens on TCP, and TCP host auth
  # is password-based (pg_setup_hba_conf appends host rules using the
  # configured password), so a TCP probe only succeeds once the REAL
  # server is up with the target database — closing the race.
  if docker exec -e PGPASSWORD=registry_admin_local universal_registry_db \
      psql -h 127.0.0.1 -U registry_admin -d universal_registry -c 'SELECT 1' >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [ "$ready" != 1 ]; then
  echo "FATAL: postgres not ready after 120s. Container logs:" >&2
  docker logs universal_registry_db 2>&1 | tail -40 >&2 || true
  exit 1
fi

# The v12 acceptance suite: 13 valid rows INSERT, 3 malformed rows raise the
# trigger exception, ROLLBACK leaves nothing. Exits non-zero if any expected
# rejection was NOT raised (the nested 'Test Failed' exceptions propagate).
docker exec -i universal_registry_db psql -U registry_admin -d universal_registry \
  -v ON_ERROR_STOP=1 < 0012_acceptance.sql

echo "OK: 0012 acceptance suite passed in the founder Docker harness (postgres:16-alpine)"
