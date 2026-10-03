#!/usr/bin/env bash
# Applies every migration, the seed and the SQL tests to a throwaway local Postgres.
# Needs PostgreSQL 16+ server binaries and pgvector. Usage: ./scripts/check-migrations.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PG_BIN="${PG_BIN:-$(pg_config --bindir 2>/dev/null || echo /usr/lib/postgresql/16/bin)}"
WORK="$(mktemp -d)"
PORT="${PGPORT_CHECK:-$((20000 + RANDOM % 10000))}"

run_as_pg() {
  if [ "$(id -u)" = "0" ]; then
    runuser -u postgres -- "$@"
  else
    "$@"
  fi
}

cleanup() {
  run_as_pg "$PG_BIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

if [ "$(id -u)" = "0" ]; then chown postgres "$WORK"; fi

run_as_pg "$PG_BIN/initdb" -D "$WORK/data" -U postgres --auth=trust >/dev/null
run_as_pg "$PG_BIN/pg_ctl" -D "$WORK/data" -o "-p $PORT -k $WORK -c listen_addresses=''" -l "$WORK/log" -w start >/dev/null

PSQL=(psql -X -q -v ON_ERROR_STOP=1 -h "$WORK" -p "$PORT" -U postgres)
"${PSQL[@]}" -c "create database throwin" >/dev/null
PSQL+=(-d throwin)

echo "-> shim"
"${PSQL[@]}" -f "$ROOT/supabase/tests/shim.sql"
for f in "$ROOT"/supabase/migrations/*.sql; do
  echo "-> $(basename "$f")"
  "${PSQL[@]}" -f "$f"
done
echo "-> seed"
"${PSQL[@]}" -f "$ROOT/supabase/seed.sql"
for f in "$ROOT"/supabase/tests/*_test.sql; do
  echo "-> $(basename "$f")"
  "${PSQL[@]}" -f "$f"
done
echo "All migration checks passed."
