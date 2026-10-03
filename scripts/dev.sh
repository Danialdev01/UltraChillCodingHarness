#!/usr/bin/env bash
# One command from a fresh clone to a running dev environment:
#   pnpm dev:up            (or: bash scripts/dev.sh)
#
# Creates .env on first run, installs dependencies, starts Postgres in
# Docker, then runs the API server (:3001) and the web UI (:3000) with hot
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

pnpm install --frozen-lockfile

# Reuse the database container from the old README instructions if this
# machine has one, so existing dev data is kept; it is on the same port.
if docker container inspect ucch-pg-dev >/dev/null 2>&1; then
  docker start ucch-pg-dev >/dev/null
  echo "[dev] using existing ucch-pg-dev container"
  until docker exec ucch-pg-dev pg_isready -U ucch -d ucch >/dev/null 2>&1; do sleep 1; done
else
  docker compose -f docker-compose.dev.yml up -d --wait
fi

echo "[dev] starting server :3001 and web :3000 -> http://localhost:3000"
exec pnpm dev
