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

# The shared servers projects' development databases are made on, as `dev`.
from_secret DEV_DB_PASSWORD
if [ -n "${DEV_DB_PASSWORD:-}" ]; then
  export DEV_POSTGRES_URL="${DEV_POSTGRES_URL:-postgres://dev:${DEV_DB_PASSWORD}@postgres:5432/dev}"
  export DEV_MYSQL_URL="${DEV_MYSQL_URL:-mysql://dev:${DEV_DB_PASSWORD}@mysql:3306/dev}"
fi
unset DEV_DB_PASSWORD

export DEFAULT_USER_EMAIL="${DEFAULT_USER_EMAIL:-admin@${ROOT_DOMAIN:-ucch.localhost}}"

# The research crawler is an opt-in compose profile; use it when it is on.
if [ -z "${CRAWL4AI_URL:-}" ] && [[ ",${UCCH_PROFILES:-}," == *,research,* ]]; then
  export CRAWL4AI_URL=http://crawl4ai:11235
  from_secret CRAWL4AI_API_TOKEN
fi

echo "[entrypoint] first sign-in: ${DEFAULT_USER_EMAIL} (password: DEFAULT_USER_PASSWORD, or" \
  "'docker exec <server> cat ${secrets}/default_user_password' if you left it blank)" >&2

# Everything above ran as root so it could read the root-only secret files.
# The server -- and so every terminal, agent and dev server it starts -- runs
# as the unprivileged `node` user, which cannot read them.
if [ "$(id -u)" = 0 ] && [ -n "${UCCH_RUN_AS:-}" ]; then
  # Volumes created by an older, root-run image are root-owned; hand them
  # over once. Checked at the top level so a large workspace is not re-walked
  # on every restart.
  for dir in "${WORKSPACE_ROOT:-/srv/ucch/workspaces}" "${CREDS_ROOT:-/srv/ucch/creds}"; do
    mkdir -p "$dir"
    if [ "$(stat -c %U "$dir")" != "$UCCH_RUN_AS" ]; then
      echo "[entrypoint] giving $dir to $UCCH_RUN_AS" >&2
      chown -R "$UCCH_RUN_AS:$UCCH_RUN_AS" "$dir"
    fi
  done
  export HOME="$(getent passwd "$UCCH_RUN_AS" | cut -d: -f6)"
  exec setpriv --reuid="$UCCH_RUN_AS" --regid="$UCCH_RUN_AS" --init-groups \
    --inh-caps=-all --bounding-set=-all --no-new-privs "$@"
fi

exec "$@"
