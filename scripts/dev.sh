#!/usr/bin/env bash
# One command from a fresh clone to a running dev environment:
#   pnpm dev:up            (or: bash scripts/dev.sh)
#
# Creates .env on first run, installs dependencies, starts Postgres and
# MySQL in Docker, then runs the API server (:3001) and the web UI (:3000) with hot
# reload. Migrations apply on server boot. Ctrl-C stops the app; the
# database keeps running (`pnpm dev:down` stops it).
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v pnpm >/dev/null 2>&1; then
  echo "[dev] enabling pnpm through corepack"
  corepack enable
fi

if [ ! -f .env ]; then
  echo "[dev] creating .env from .env.development.example"
  secret=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  sed -e "s|^DATABASE_URL=.*|DATABASE_URL=postgres://ucch:ucch@localhost:55432/ucch|" \
      -e "s|^SECRET_KEY=.*|SECRET_KEY=${secret}|" \
      .env.development.example > .env
fi

# The shared servers that projects' development databases are made on. Added
# to an .env written before they existed, so an old checkout picks them up.
grep -q '^DEV_POSTGRES_URL=' .env || echo 'DEV_POSTGRES_URL=postgres://dev:dev@localhost:55432/dev' >> .env
grep -q '^DEV_MYSQL_URL=' .env || echo 'DEV_MYSQL_URL=mysql://dev:dev@localhost:53306/dev' >> .env

pnpm install --frozen-lockfile

# Reuse the database container from the old README instructions if this
# machine has one, so existing dev data is kept; it is on the same port.
if docker container inspect ucch-pg-dev >/dev/null 2>&1; then
  docker start ucch-pg-dev >/dev/null
  echo "[dev] using existing ucch-pg-dev container"
  until docker exec ucch-pg-dev pg_isready -U ucch -d ucch >/dev/null 2>&1; do sleep 1; done
  pg=ucch-pg-dev
  docker compose -f docker-compose.dev.yml up -d --wait mysql
else
  docker compose -f docker-compose.dev.yml up -d --wait
  pg=$(docker compose -f docker-compose.dev.yml ps -q postgres)
fi

# The `dev` role projects' databases belong to. deploy/postgres-init.sh makes
# it on a fresh volume; this covers volumes initialised before that existed.
docker exec -i "$pg" psql -v ON_ERROR_STOP=1 -q -U ucch -d ucch >/dev/null <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'dev') THEN
    CREATE ROLE dev LOGIN CREATEDB PASSWORD 'dev';
  END IF;
END $$;
SELECT 'CREATE DATABASE dev OWNER dev' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'dev')\gexec
SQL

echo "[dev] starting server :3001 and web :3000 -> http://localhost:3000"
exec pnpm dev
