#!/usr/bin/env bash
# Starts the load-test target (README.md): a `ucch_load` Postgres and the app
# image beside it, limited like the production VPS, with the mock OpenRouter
# running inside and the fake claude CLI as CLAUDE_BIN. Re-running replaces
# the app container and keeps the database and the `ucch-load-data` volume
# (/data: the projects' repositories), so a new image needs no new seed.
#
#   bash scripts/load/up.sh            # IMAGE=ucch:load, port 3397
#   bash scripts/load/up.sh --fresh    # also drop the database and the volume
#
# Environment: IMAGE, PORT, CPUS (4), MEMORY (8g), CPUSET (0-3: the cores the
# container may use; run the generator on others with `taskset`), and the
# mocks' MOCK_RATE (60), MOCK_LENGTH (1500), FAKE_CLAUDE_RSS_MB (0).
# Writes the secrets it chose to load-out/env, which run.mjs and the seed
# script read through the shell.
set -euo pipefail
cd "$(dirname "$0")/../.."

IMAGE=${IMAGE:-ucch:load}
PORT=${PORT:-3397}
CPUS=${CPUS:-4}
MEMORY=${MEMORY:-8g}
CPUSET=${CPUSET:-0-3}
OUT=${LOAD_OUT:-load-out}
mkdir -p "$OUT"
chmod 700 "$OUT"

if [ "${1:-}" = "--fresh" ]; then
  docker rm -f ucch-load ucch-pg-load >/dev/null 2>&1 || true
  docker volume rm ucch-load-data >/dev/null 2>&1 || true
  rm -f "$OUT/env" "$OUT/sessions.json"
fi

if [ ! -s "$OUT/env" ]; then
  {
    echo "SECRET_KEY=$(openssl rand -hex 32)"
    echo "METRICS_TOKEN=$(openssl rand -hex 24)"
  } >"$OUT/env"
  chmod 600 "$OUT/env"
fi
# shellcheck disable=SC1091
source "$OUT/env"

docker network inspect ucch-load >/dev/null 2>&1 || docker network create ucch-load >/dev/null
if ! docker inspect ucch-pg-load >/dev/null 2>&1; then
  # On the app's cores: in production the embedded Postgres shares the
  # box's four with everything else.
  docker run -d --name ucch-pg-load --network ucch-load -p 127.0.0.1:55432:5432 --cpuset-cpus="$CPUSET" \
    -e POSTGRES_PASSWORD=load -e POSTGRES_DB=ucch_load postgres:16-alpine \
    -c shared_preload_libraries=pg_stat_statements -c pg_stat_statements.track=top \
    -c max_connections=200 -c shared_buffers=256MB >/dev/null
fi
docker start ucch-pg-load >/dev/null
# Over TCP: the image's first-boot initialisation runs a socket-only server
# that answers before the database exists.
until docker exec ucch-pg-load psql -h 127.0.0.1 -U postgres -d ucch_load -qc "select 1" >/dev/null 2>&1; do sleep 0.5; done
docker exec -e PGOPTIONS=--client-min-messages=warning ucch-pg-load \
  psql -h 127.0.0.1 -U postgres -d ucch_load -qc "create extension if not exists pg_stat_statements" >/dev/null

docker rm -f ucch-load >/dev/null 2>&1 || true
docker run -d --name ucch-load --network ucch-load -p "127.0.0.1:$PORT:3000" \
  --cpus="$CPUS" --cpuset-cpus="$CPUSET" --memory="$MEMORY" --memory-swap="$MEMORY" \
  -v ucch-load-data:/data -v "$PWD/scripts/load:/load:ro" \
  -e DATABASE_URL=postgres://postgres:load@ucch-pg-load:5432/ucch_load \
  -e SECRET_KEY="$SECRET_KEY" -e METRICS_TOKEN="$METRICS_TOKEN" \
  -e ROOT_DOMAIN=localhost -e PUBLIC_SCHEME=http -e PUBLIC_WEB_ORIGIN="http://127.0.0.1:$PORT" \
  -e DEFAULT_USER_EMAIL=admin@load.test -e DEFAULT_USER_PASSWORD=load-password-123 \
  -e AGENT_ALLOW_HOST_SHELL=true \
  -e OPENROUTER_BASE_URL=http://127.0.0.1:4010/api/v1 \
  -e CLAUDE_BIN=/load/fake-claude.mjs -e FAKE_CLAUDE_RSS_MB="${FAKE_CLAUDE_RSS_MB:-0}" \
  "$IMAGE" >/dev/null

for _ in $(seq 1 120); do
  curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null || { docker logs --tail 50 ucch-load; exit 1; }
docker exec -d -u node ucch-load node /load/mock-openrouter.mjs \
  --rate "${MOCK_RATE:-60}" --length "${MOCK_LENGTH:-1500}"
echo "up: http://127.0.0.1:$PORT (image $IMAGE, --cpus=$CPUS --memory=$MEMORY on cores $CPUSET)"
echo "secrets in $OUT/env; next: the seed script, then run.mjs (README.md)"
