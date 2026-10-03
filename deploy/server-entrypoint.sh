#!/usr/bin/env bash
# Fills in whatever the environment leaves unset from the `secrets` volume
# (see deploy/secrets.sh) and the compose network, then runs the server.
set -euo pipefail
secrets=/run/ucch-secrets

from_secret() {
  local name=$1 file="$secrets/${1,,}"
  if [ -z "${!name:-}" ] && [ -s "$file" ]; then
    export "$name=$(cat "$file")"
  fi
}

from_secret SECRET_KEY
from_secret DEFAULT_USER_PASSWORD
from_secret POSTGRES_PASSWORD

if [ -z "${DATABASE_URL:-}" ]; then
  export DATABASE_URL="postgres://ucch:${POSTGRES_PASSWORD}@postgres:5432/ucch"
fi
unset POSTGRES_PASSWORD

export DEFAULT_USER_EMAIL="${DEFAULT_USER_EMAIL:-admin@${ROOT_DOMAIN:-ucch.localhost}}"

# The research crawler is an opt-in compose profile; use it when it is on.
if [ -z "${CRAWL4AI_URL:-}" ] && [[ ",${UCCH_PROFILES:-}," == *,research,* ]]; then
  export CRAWL4AI_URL=http://crawl4ai:11235
  from_secret CRAWL4AI_API_TOKEN
fi

echo "[entrypoint] first sign-in: ${DEFAULT_USER_EMAIL} (password: DEFAULT_USER_PASSWORD, or" \
  "'cat ${secrets}/default_user_password' in this container if you left it blank)" >&2

exec "$@"
