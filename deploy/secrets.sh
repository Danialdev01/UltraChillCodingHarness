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

# postgres and mysql read their files as their own (non-root) users.
chmod 755 "$dir"
chmod 644 "$dir"/*
