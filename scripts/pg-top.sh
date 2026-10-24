#!/usr/bin/env bash
# The statements Postgres spends its time on, from pg_stat_statements
# (enabled by deploy/s6/s6-rc.d/postgres/run).
#
#   bash scripts/pg-top.sh                  the running ucch container
#   bash scripts/pg-top.sh <container>      a named one
#   bash scripts/pg-top.sh --reset [c]      zero the statistics first
#
# Prints the top 20 by total execution time and the top 20 by calls. The
# numbers accumulate from the last reset (or the server's start), so reset,
# do the thing being measured, then read.
#
# Against a server that is not the embedded one -- an external DATABASE_URL,
# or the load-test database (scripts/load/README.md) -- set PG_TOP_PSQL to
# the psql command to run, e.g.
#   PG_TOP_PSQL='docker exec -i ucch-pg-load psql -U postgres -d ucch_load' bash scripts/pg-top.sh
set -euo pipefail

reset=
if [ "${1:-}" = "--reset" ]; then
  reset=1
  shift
fi

if [ -n "${PG_TOP_PSQL:-}" ]; then
  read -r -a psql <<<"$PG_TOP_PSQL"
else
  container=${1:-$(docker ps --filter ancestor="${UCCH_IMAGE:-ucch}" --format '{{.Names}}' | head -1)}
  if [ -z "$container" ]; then
    container=$(docker ps --format '{{.Names}}' | grep -m1 ucch || true)
  fi
  [ -n "$container" ] || { echo "no running ucch container; name one" >&2; exit 1; }
  psql=(docker exec -i -u postgres "$container" psql -h /run/postgresql -d ucch)
fi

run() { "${psql[@]}" -X -q -v ON_ERROR_STOP=1 -P pager=off "$@"; }

if [ -n "$reset" ]; then
  run -c "select pg_stat_statements_reset()" >/dev/null
  echo "pg_stat_statements reset"
fi

# Whitespace collapsed and cut to one line, so a 40-line query is readable
# in a terminal; the full text is in pg_stat_statements.
columns="calls,
  round(total_exec_time::numeric, 1) as total_ms,
  round(mean_exec_time::numeric, 2) as mean_ms,
  rows,
  left(regexp_replace(query, '\s+', ' ', 'g'), 110) as query"

echo
echo "== top 20 by total execution time =="
run -c "select $columns from pg_stat_statements order by total_exec_time desc limit 20"

echo "== top 20 by calls =="
run -c "select $columns from pg_stat_statements order by calls desc limit 20"
