#!/usr/bin/env bash
# Runs once, on the postgres volume's first initialisation.
#
# The harness's own data lives in the `ucch` database, owned by the superuser
# the image creates. Projects get a separate, unprivileged `dev` role that
# may create databases of its own but cannot connect to `ucch`: code an agent
# writes and runs should never be one DROP away from the event log.
set -euo pipefail

dev_password=${DEV_DB_PASSWORD:-$(cat "$DEV_DB_PASSWORD_FILE")}

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v dev_password="$dev_password" <<'SQL'
CREATE ROLE dev LOGIN CREATEDB PASSWORD :'dev_password';
CREATE DATABASE dev OWNER dev;
REVOKE CONNECT ON DATABASE ucch FROM PUBLIC;
SQL
