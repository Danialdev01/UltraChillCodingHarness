#!/usr/bin/env bash
# /api/bootstrap's server time for a big workspace: 200 projects holding
# 20,000 turns between them (1,000 threads of 20), which is what
# listProjects' per-project sums run over (plan.md, finding 2).
#
#   bash scripts/load/probes/bootstrap-big.sh [requests]   (default 200)
#
# The first run adds the workspace, "Load big", owned by load-000, straight
# into the load-test database: rows only, no repositories, so it is for
# this measurement and nothing else. The requests are made from inside the
# container, one after another, so the time is the server's plus loopback.
# Prints one JSON line: p50, p95, p99 and max in ms.
set -euo pipefail
cd "$(dirname "$0")/../../.."

REQUESTS=${1:-200}
psql=(docker exec -i ucch-pg-load psql -U postgres -d ucch_load -qAt -v ON_ERROR_STOP=1)

"${psql[@]}" >/dev/null <<'SQL'
do $$
declare
  owner uuid := (select id from users where email = 'load-000@load.test');
  ws uuid;
begin
  if exists (select 1 from workspaces where owner_user_id = owner and name = 'Load big') then return; end if;
  insert into workspaces (slug, name, owner_user_id, hash)
    values ('load-big', 'Load big', owner, substr(md5(random()::text), 1, 12)) returning id into ws;
  insert into workspace_members (workspace_id, user_id, role) values (ws, owner, 'owner');
  insert into projects (hash, user_id, name, workspace_id)
    select substr(md5(random()::text), 1, 12), owner, format('big-project-%s', lpad(n::text, 3, '0')), ws
    from generate_series(1, 200) n;
  insert into threads (hash, project_id, title, created_by_user_id)
    select substr(md5(random()::text), 1, 12), p.id, format('big thread %s', t), owner
    from projects p, generate_series(1, 5) t where p.workspace_id = ws;
  insert into turns (thread_id, seq, usage, cost_usd, model, stop_reason, created_at)
    select th.id, s,
      jsonb_build_object('inputTokens', 1200, 'outputTokens', 800, 'cacheReadInputTokens', 4000, 'cacheCreationInputTokens', 0),
      0.012, 'load/mock', 'end_turn', now() - make_interval(mins => s)
    from threads th join projects p on p.id = th.project_id, generate_series(1, 20) s
    where p.workspace_id = ws;
end $$;
-- As a database that has lived with these rows would be.
analyze projects, threads, turns;
SQL

hash=$("${psql[@]}" -c "select w.hash from workspaces w join users u on u.id = w.owner_user_id where u.email = 'load-000@load.test' and w.name = 'Load big'")
cookie=$(node -e 'console.log(require("./load-out/sessions.json").users[0].cookie)')
counts=$("${psql[@]}" -c "select (select count(*) from projects p join workspaces w on w.id = p.workspace_id where w.hash = '$hash') || ' ' || (select count(*) from turns t join threads th on th.id = t.thread_id join projects p on p.id = th.project_id join workspaces w on w.id = p.workspace_id where w.hash = '$hash')")

docker exec ucch-load sh -c "for i in \$(seq 1 $REQUESTS); do curl -s -o /dev/null -w '%{time_total}\n' -H 'cookie: $cookie' 'http://127.0.0.1:3000/api/bootstrap?ws=$hash'; done" |
  node -e '
    const ms = require("fs").readFileSync(0, "utf8").trim().split("\n").map((s) => Number(s) * 1000).sort((a, b) => a - b);
    const at = (q) => Math.round(ms[Math.min(ms.length - 1, Math.floor(q * ms.length))] * 100) / 100;
    const [projects, turns] = process.argv[1].split(" ").map(Number);
    console.log(JSON.stringify({ projects, turns, requests: ms.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: at(1) }));
  ' "$counts"
