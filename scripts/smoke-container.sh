#!/usr/bin/env bash
# End-to-end check of the single-container image (documentation/todo.md D9).
#
#   bash scripts/smoke-container.sh            build, then test
#   SKIP_BUILD=1 bash scripts/smoke-container.sh
#
# Runs the image on a throwaway volume and checks, failing on the first miss:
# it becomes healthy; a sign-in works; the UI is served through the edge with
# immutable static assets; a WebSocket opens; the `node` user cannot read the
# databases or the secrets; it stops within the grace period and keeps its
# data across a restart; and with ENABLE_MYSQL=true, MariaDB answers.
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE=${IMAGE:-ucch:smoke}
PORT=${SMOKE_PORT:-3399}
NAME=ucch-smoke-$$
VOLUME=ucch-smoke-$$
EMAIL=smoke@example.com
PASSWORD=smoke-password-123
ORIGIN=http://localhost:$PORT
jar=$(mktemp)

pass() { printf '  \033[32mok\033[0m  %s\n' "$*"; }
fail() {
  printf '  \033[31mFAIL\033[0m %s\n' "$*" >&2
  docker logs --tail 80 "$NAME" >&2 2>&1 || true
  exit 1
}
cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm -f "$VOLUME" >/dev/null 2>&1 || true
  rm -f "$jar"
}
trap cleanup EXIT

if [ -z "${SKIP_BUILD:-}" ]; then
  echo "building $IMAGE"
  docker build --target app -t "$IMAGE" . >/dev/null
fi

start() {
  docker run -d --name "$NAME" -p "$PORT:3000" -v "$VOLUME:/data" \
    -e ROOT_DOMAIN=localhost -e PUBLIC_SCHEME=http -e PUBLIC_WEB_ORIGIN="$ORIGIN" \
    -e DEFAULT_USER_EMAIL="$EMAIL" -e DEFAULT_USER_PASSWORD="$PASSWORD" \
    -e AGENT_ALLOW_HOST_SHELL=true "$@" "$IMAGE" >/dev/null
}

wait_healthy() {
  for _ in $(seq 1 120); do
    if curl -fsS "$ORIGIN/health" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  fail "not healthy after 120s"
}

echo "first boot"
start
wait_healthy
pass "/health is 200: $(curl -fsS "$ORIGIN/health")"

curl -fsS -c "$jar" -H "origin: $ORIGIN" -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" "$ORIGIN/api/auth/login" >/dev/null \
  || fail "sign-in refused"
pass "signed in"

html=$(curl -fsS -b "$jar" "$ORIGIN/") || fail "GET / failed"
grep -q '<html' <<<"$html" || fail "GET / is not HTML"
pass "the UI is served through the edge"

asset=$(grep -o '/_next/static/[^"]*\.js' <<<"$html" | head -1)
[ -n "$asset" ] || fail "no script on the page"
curl -fsS -D - -o /dev/null "$ORIGIN$asset" | grep -qi 'cache-control: public, max-age=31536000, immutable' \
  || fail "$asset is not served as immutable"
pass "static assets are immutable"

ticket=$(curl -fsS -b "$jar" -X POST -H "origin: $ORIGIN" "$ORIGIN/api/ws-ticket" | sed -E 's/.*"ticket":"([^"]+)".*/\1/')
node -e '
  const WebSocket = require("ws");
  const ws = new WebSocket(process.argv[1]);
  const timer = setTimeout(() => { console.error("no ready frame"); process.exit(1); }, 5000);
  ws.on("message", (raw) => { if (JSON.parse(raw).kind === "ready") { clearTimeout(timer); ws.close(); process.exit(0); } });
  ws.on("error", (e) => { console.error(e.message); process.exit(1); });
' "ws://localhost:$PORT/ws?ticket=$ticket" || fail "WebSocket did not open"
pass "the WebSocket opens"

as_node() { docker exec -u node "$NAME" bash -c "$1" >/dev/null 2>&1; }
for target in "cat /data/secrets/secret_key" "ls /data/postgres" "ls /data/mysql" "ls /data/backups"; do
  if as_node "$target"; then fail "node can run: $target"; fi
done
server_pid=$(docker exec "$NAME" pgrep -f 'dist/server.mjs' | head -1)
if docker exec -u node "$NAME" cat "/proc/$server_pid/environ" | tr '\0' '\n' | grep -q '^POSTGRES_PASSWORD='; then
  fail "the server's environment carries POSTGRES_PASSWORD"
fi
if as_node "PGPASSWORD=\$(cat /data/secrets/dev_db_password 2>/dev/null) psql -h 127.0.0.1 -U dev -d ucch -c 'select 1'"; then
  fail "the dev role can open the ucch database"
fi
pass "node cannot read the databases or secrets"

metrics=$(docker exec "$NAME" curl -fsS localhost:3000/metrics) || fail "/metrics refused inside the container"
for family in event_loop_delay_seconds process_rss_bytes gc_pause_seconds http_request_seconds ws_connections \
  engine_queue_depth pg_connections resource_rss_bytes cgroup_memory_bytes web_requests_total bootstrap_requests_total; do
  grep -q "^# TYPE $family " <<<"$metrics" || fail "/metrics has no $family"
done
pass "/metrics answers inside the container"
code=$(curl -s -o /dev/null -w '%{http_code}' "$ORIGIN/metrics")
[ "$code" = 403 ] || fail "/metrics from outside is $code, not 403"
pass "/metrics is refused from outside"

backup=$(docker exec "$NAME" ucch-backup) || fail "ucch-backup failed"
docker exec "$NAME" test -s "$backup/ucch.dump" || fail "backup has no ucch.dump"
pass "ucch-backup wrote $backup"

docker exec "$NAME" ucch-restore "$backup" >/dev/null 2>&1 || fail "ucch-restore failed"
wait_healthy
curl -fsS -c "$jar" -H "origin: $ORIGIN" -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" "$ORIGIN/api/auth/login" >/dev/null \
  || fail "sign-in refused after a restore"
pass "ucch-restore brought the backup back"

started=$(date +%s)
docker stop -t 75 "$NAME" >/dev/null
took=$(( $(date +%s) - started ))
[ "$took" -lt 70 ] || fail "stopping took ${took}s"
pass "stopped cleanly in ${took}s"

docker rm "$NAME" >/dev/null
echo "restart on the same volume, with MariaDB"
start -e ENABLE_MYSQL=true
wait_healthy
curl -fsS -c "$jar" -H "origin: $ORIGIN" -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" "$ORIGIN/api/auth/login" >/dev/null \
  || fail "sign-in refused after restart"
pass "data survived the restart"
top=$(bash scripts/pg-top.sh "$NAME") || fail "pg-top.sh failed"
grep -qi 'from' <<<"$top" || fail "pg-top.sh printed no statements"
pass "pg_stat_statements survives a restart"
docker exec "$NAME" mariadb-admin --socket=/run/mysqld/mysqld.sock ping --silent || fail "MariaDB is not up"
docker exec "$NAME" mariadb -h 127.0.0.1 -u dev -p"$(docker exec "$NAME" cat /data/secrets/dev_db_password)" -e 'select 1' >/dev/null \
  || fail "the dev account cannot reach MariaDB"
pass "MariaDB answers for the dev account"

echo "all checks passed"
