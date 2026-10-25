# Load testing

Tools for measuring UCCH under many users without billing anyone or
touching the network. The plan behind them is `documentation/solution.md`
§1; the numbers they produce go in `documentation/perf/`.

| File | What it is |
| --- | --- |
| `mock-openrouter.mjs` | An OpenRouter stand-in: streams answers at a set rate, serves the model catalogue and the key/credits endpoints |
| `fake-claude.mjs` | A `claude` CLI stand-in: answers the harness's probes and plays a turn in stream-json at a set rate, optionally holding the real CLI's memory |
| `fixtures/claude-text.jsonl` | The stream `fake-claude.mjs` replays, copied from `packages/providers/src/fixtures` |
| `up.sh` | Starts a load-test target: its own Postgres, and the app limited like the production VPS with the mocks inside |
| `run.mjs` | The load generator: virtual users on the WebSocket and the edge, measured from outside and from `/metrics` |
| `apps/web/e2e/stream.spec.ts` | What a streaming answer costs the browser: long tasks, INP and frame-to-paint |

## Pointing a container at the mocks

The server reads two variables:

- `OPENROUTER_BASE_URL`: where native turns stream from. Defaults to `https://openrouter.ai/api/v1`.
- `CLAUDE_BIN`: the Claude Code binary. Defaults to `claude` on `PATH`.

Mount this directory into the container, start the mock inside it and point both at it. With `--network none` nothing can reach the internet, so a completed turn proves the mocks answered it:

```bash
docker run -d --name ucch-load --network none \
  -v "$PWD/scripts/load:/load:ro" \
  -e ROOT_DOMAIN=localhost -e PUBLIC_SCHEME=http \
  -e DEFAULT_USER_EMAIL=load@example.com -e DEFAULT_USER_PASSWORD=load-password-123 \
  -e AGENT_ALLOW_HOST_SHELL=true \
  -e OPENROUTER_BASE_URL=http://127.0.0.1:4010/api/v1 \
  -e CLAUDE_BIN=/load/fake-claude.mjs \
  -e FAKE_CLAUDE_LENGTH=1500 -e FAKE_CLAUDE_RATE=60 -e FAKE_CLAUDE_RSS_MB=370 \
  ucch:load

docker exec -d -u node ucch-load node /load/mock-openrouter.mjs --length 1500 --rate 60
```

Each user still needs an OpenRouter key on their account for a native turn to start. Any string will do (`PUT /api/settings/openrouter` with `{"apiKey":"sk-or-v1-mock"}`); the seed script sets one for every user it creates.

## `mock-openrouter.mjs`

```
node scripts/load/mock-openrouter.mjs [--port 4010] [--host 127.0.0.1]
     [--rate 60] [--chunk 1] [--length 1500] [--latency 300]
```

- `--rate`: tokens per second.
- `--chunk`: tokens per SSE event. Real providers send 1–5.
- `--length`: tokens per answer.
- `--latency`: ms before the first token.

A request can override the stream with the `x-mock-rate`, `x-mock-chunk` and `x-mock-length` headers. Every answer is plain text, so a native turn is one model call. `GET /stats` reports requests, completions, active streams, tokens served and aborted streams.

## `fake-claude.mjs`

Options go on its command line or in the environment, because `CLAUDE_BIN` is a path and the harness supplies the rest of the argv:

| Flag | Environment | Default | |
| --- | --- | --- | --- |
| `--rate` | `FAKE_CLAUDE_RATE` | 60 | tokens a second |
| `--chunk` | `FAKE_CLAUDE_CHUNK` | 1 | tokens per text delta |
| `--length` | `FAKE_CLAUDE_LENGTH` | 1500 | tokens in the answer |
| `--rss-mb` | `FAKE_CLAUDE_RSS_MB` | 0 | memory to allocate and hold (the real CLI holds ~370 MB) |
| `--fixture` | `FAKE_CLAUDE_FIXTURE` | `fixtures/claude-text.jsonl` | the stream to replay |

To give flags instead, wrap it:

```bash
#!/bin/sh
exec node /load/fake-claude.mjs --rss-mb 370 "$@"
```

It names its process `claude`, so the resource sampler counts it as one (`resource_processes{group="claude"}` on `/metrics`). The stop button works: SIGINT ends the answer with the aborted result the real CLI prints.

## Seeding: `apps/server/scripts/seed-load.ts`

Load tests run against their own database, never a real one. The seed script refuses to run unless `LOADTEST_ALLOW_SEED=1` is set *and* the database's name ends in `_load`. That means a separate Postgres, which the container reaches through `DATABASE_URL` (so the embedded one stays off):

```bash
docker network create ucch-load
docker run -d --name ucch-pg-load --network ucch-load -p 127.0.0.1:55432:5432 \
  -e POSTGRES_PASSWORD=load -e POSTGRES_DB=ucch_load postgres:16-alpine \
  -c shared_preload_libraries=pg_stat_statements -c pg_stat_statements.track=top -c max_connections=200
SECRET_KEY=$(openssl rand -hex 32)
docker run -d --name ucch-load --network ucch-load -p 127.0.0.1:3397:3000 \
  -v "$PWD/scripts/load:/load:ro" \
  -e DATABASE_URL=postgres://postgres:load@ucch-pg-load:5432/ucch_load -e SECRET_KEY="$SECRET_KEY" \
  -e ROOT_DOMAIN=localhost -e PUBLIC_SCHEME=http -e PUBLIC_WEB_ORIGIN=http://127.0.0.1:3397 \
  -e DEFAULT_USER_EMAIL=admin@load.test -e DEFAULT_USER_PASSWORD=load-password-123 \
  -e AGENT_ALLOW_HOST_SHELL=true \
  -e OPENROUTER_BASE_URL=http://127.0.0.1:4010/api/v1 -e CLAUDE_BIN=/load/fake-claude.mjs \
  ucch:load
```

Then, from the repository, with the server up (it creates the schema on boot):

```bash
LOADTEST_ALLOW_SEED=1 LOAD_OUT="$PWD/load-out" SECRET_KEY="$SECRET_KEY" \
DATABASE_URL=postgres://postgres:load@127.0.0.1:55432/ucch_load \
  pnpm --filter @ucch/server exec tsx scripts/seed-load.ts --users 50 --projects 20 --url http://127.0.0.1:3397
```

It creates:

- `--users` accounts, `load-000@load.test` onwards, with the password `--password` (default `load-password-123`), each with an encrypted dummy OpenRouter key and its own personal workspace;
- one workspace, "Load shared", owned by the first user with every other user as a member;
- a session per user, made directly rather than through the rate-limited sign-in;
- `--projects` empty projects in every one of those workspaces, through the server's WebSocket, so the clone reactor runs. It waits until each is cloned.

It writes `$LOAD_OUT/sessions.json` (mode 600): `{ base, sharedWorkspaceId, password, users: [{ userId, email, cookie, personalWorkspaceId }] }`. Running it again only fills gaps; each run issues fresh sessions. `--users 50 --projects 20` (1,020 projects) takes about 35 s.

`pg-top.sh` reads this database with `PG_TOP_PSQL='docker exec -i ucch-pg-load psql -U postgres -d ucch_load'`.

## A whole run

`up.sh` does the container setup above, limited as the plan's VPS is (`--cpus=4 --memory=8g`, pinned to cores `0-3`). It chooses `SECRET_KEY` and `METRICS_TOKEN` once and keeps them in `load-out/env`. Postgres runs on the app's cores, as the embedded one does in production. Re-running it replaces the app container and keeps the database and the `ucch-load-data` volume (`/data`, the projects' repositories), so a new image needs no new seed; `--fresh` starts all of it over.

```bash
docker build --target app -t ucch:load .
bash scripts/load/up.sh
set -a; . load-out/env; set +a
LOADTEST_ALLOW_SEED=1 LOAD_OUT="$PWD/load-out" DATABASE_URL=postgres://postgres:load@127.0.0.1:55432/ucch_load \
  pnpm --filter @ucch/server exec tsx scripts/seed-load.ts --users 50 --projects 20 --url http://127.0.0.1:3397
taskset -c 8-15 node scripts/load/run.mjs --users 50 --minutes 10 \
  --out documentation/perf/<task>-<date>.json
```

Run the generator on cores the container does not have (`taskset`), so the two do not compete for the CPU being measured.

## `run.mjs`

```
node scripts/load/run.mjs [--sessions load-out/sessions.json] [--base URL]
     [--users 50] [--minutes 10] [--ramp 30] [--out FILE] [--label TEXT]
     [--mix native=0.2,terminal=0.3,git=0.3] [--turn-every 60]
     [--git-every 60] [--poll-every 30] [--type-rate 5] [--type-via frame|dispatch]
     [--sidebar workspace|per-project] [--replay batched|per-event]
     [--scrape-every 5]
     [--metrics-token T]   (default: $METRICS_TOKEN)
```

Users start evenly over `--ramp` seconds and stop together `--minutes` later. Each one, as the browser does:

- takes a ws-ticket and opens `/ws`, subscribing to `user`, the shared workspace (whose `project.activity` is the sidebar), a quiet `project` topic for the project it has open (with `files: true` for the git role, as the Git view asks), and its own thread (`load-vu-N`) with replay. `--sidebar per-project` subscribes to a quiet `project` topic for every project instead, the way the sidebar did before PF1.26. The thread's history comes in `replay` frames, as the browser asks for it (`caps=replay1`); `--replay per-event` takes one push an event, the way it came before PF1.16;
- every `--poll-every` seconds fetches `/api/bootstrap` (with its ETag), the workspace page's document and five RSC prefetches of project pages.

Then by role, spread evenly over the users by `--mix` (the rest only watch):

- **native** sends a native turn every `--turn-every` seconds, which the mock streams;
- **terminal** opens a shell and types `--type-rate` characters a second, a comment line at a time, as `terminal_input` frames the way the browser sends them (`--type-via dispatch`: as acked `terminal.input` commands, the way it did before PF1.10);
- **git** reads status, branches and the first log page every `--git-every` seconds, as the Git view does.

It measures, on the client:

- the ack round trip by command;
- keystroke echo (sent until the `terminal.output` holding that character);
- activity lag: from a native user's own `turn.started` to the workspace's `project.activity` saying its project is running;
- replay frames: how many frames each thread subscription's logged events took (`replay_frames`), next to its ack round trip (`ack_ms:subscribe:thread`);
- frames, bytes, first token and time per turn;
- bootstrap, document time to first byte, RSC prefetch and git latencies;
- errors by kind.

It scrapes `/metrics` every `--scrape-every` seconds. `--out` gets the JSON (client summaries, errors, a server summary and every scrape); a Markdown summary goes beside it with the same name. A turn still streaming when the run ends is left unfinished, not counted as an error.

## `stream.spec.ts`

One person's browser while an answer streams, against the same target:

```bash
E2E_BASE_URL=http://127.0.0.1:3397 E2E_API=http://127.0.0.1:3397 \
E2E_SESSION=<a cookie value from load-out/sessions.json, without "ucch_session="> \
E2E_CHROME=/opt/google/chrome/chrome \
  pnpm --filter @ucch/web exec playwright test stream
```

It opens a new session in the first project it can see, sends one message, presses keys while the answer streams, and writes `apps/web/e2e/results/stream-<E2E_LABEL or "latest">.json`:

- long tasks (count, total, longest);
- INP over those key presses;
- frame-to-paint (a delta's arrival on the socket to the paint of the next frame);
- the gaps between animation frames.

Run it during a `run.mjs` run to see the page under load. Use a user the generator is not driving (`--users` below the seeded count) or the last one.
