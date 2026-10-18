#!/bin/sh
# Run once per deploy by the `secrets` service, before anything else starts.
#
# Makes sure every secret the stack needs exists as a file in the `secrets`
# volume, so a first deploy needs nothing but ROOT_DOMAIN. A file is only
# written when missing: redeploys keep the values the databases were first
# initialised with. A variable set in the environment wins, which is how an
# install whose passwords were chosen by hand keeps them.
set -eu
dir=/run/ucch-secrets
umask 077
mkdir -p "$dir"

random_hex() { head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }

ensure() {
  name=$1 value=$2 bytes=$3
  file="$dir/$(echo "$name" | tr 'A-Z' 'a-z')"
  if [ -n "$value" ]; then
    printf '%s' "$value" > "$file"
  elif [ ! -s "$file" ]; then
    random_hex "$bytes" > "$file"
    echo "[secrets] generated $name"
  fi
}

# 32 bytes = the 64 hex characters SECRET_KEY must be.
ensure SECRET_KEY "${SECRET_KEY:-}" 32
ensure POSTGRES_PASSWORD "${POSTGRES_PASSWORD:-}" 24
ensure MYSQL_ROOT_PASSWORD "${MYSQL_ROOT_PASSWORD:-}" 24
ensure DEV_DB_PASSWORD "${DEV_DB_PASSWORD:-}" 24
ensure DEFAULT_USER_PASSWORD "${DEFAULT_USER_PASSWORD:-}" 12
# The research crawler only listens beyond its own loopback with a token.
ensure CRAWL4AI_API_TOKEN "${CRAWL4AI_API_TOKEN:-}" 24

# Each file readable by whoever needs it and nobody else. The server
# container gives every signed-in user a shell as its unprivileged user, so
# anything that user can read, they can read: the server's entrypoint loads
# its secrets as root before dropping privileges.
#   postgres:16-alpine runs as uid 70, mysql:8.4 as uid 999.
#   dev_db_password is in every project's .env anyway; crawl4ai reads its
#   token as its own user.
chmod 755 "$dir"
chown 0:0 "$dir"/* && chmod 400 "$dir"/*
chown 70 "$dir/postgres_password"
chown 999 "$dir/mysql_root_password"
chmod 444 "$dir/dev_db_password" "$dir/crawl4ai_api_token"
