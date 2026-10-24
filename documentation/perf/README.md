# Performance measurements

The numbers behind [`plan.md`](../plan.md) and the Definition of Done in [`todo.md`](../todo.md). PF0.9 recorded the baseline here; PF3.1 re-runs the same profile and records the result beside it.

| File | What it is |
| --- | --- |
| `baseline-2026-10-25.json` | The baseline: every Definition of Done figure, plus what the run used by service and statement (`scripts/load/summarise.mjs` output) |
| `baseline-2026-10-25/` | Everything the profile measured, raw (listed in `scripts/load/profile.sh`) |
| `pf0.7-2026-10-24.json`, `.md` | PF0.7's acceptance run of the load generator (50 users, 10 min, no browsers alongside) |

## How the numbers are made

The **target** is the production image (`docker build --target app`), run by `scripts/load/up.sh`:
- the container has `--cpus=4 --memory=8g`, pinned to cores 0–3;
- the mock OpenRouter runs inside it, and `fake-claude.mjs` serves as `CLAUDE_BIN`;
- a separate Postgres 16 (`ucch-pg-load`) runs on the same four cores;
- it is seeded with 50 users, each in their own workspace and in one shared workspace of 20 projects (`seed-load.ts`).

Everything that generates load or drives a browser runs on other cores (`taskset -c 8-15`) of the same machine: a 16-core desktop with headless Chrome.

```bash
bash scripts/load/up.sh --fresh
set -a; . load-out/env; set +a
LOADTEST_ALLOW_SEED=1 LOAD_OUT="$PWD/load-out" DATABASE_URL=postgres://postgres:load@127.0.0.1:55432/ucch_load \
  pnpm --filter @ucch/server exec tsx scripts/seed-load.ts --users 50 --projects 20 --url http://127.0.0.1:3397
bash scripts/load/profile.sh baseline-2026-10-25        # ~25 min; or name phases: bundle idle run long
node scripts/load/summarise.mjs documentation/perf/baseline-2026-10-25
```

The profile has four phases:
1. **bundle:** a production web build and `bundle-budget.mjs`.
2. **idle:** probes on the idle target (`scripts/load/probes/`):
   - a fresh sign-in;
   - a chat tab, while another member saves a project setting;
   - a git burst with 10 viewers;
   - 20 Claude Code turns at once;
   - `/api/bootstrap` on a 200-project workspace;
   - one 2,000-token answer in a browser.
3. **run:** `run.mjs`, 50 users for 10 minutes. Alongside it:
   - `perf.spec.ts` and `stream.spec.ts` loop in their own browsers;
   - three fresh sign-ins happen;
   - `docker stats` and `pg-top.sh` record both containers and Postgres.
4. **long:** a 4,000-token answer under 5 more minutes of load, once at full speed and once with the page's CPU throttled 4×.

### What each figure means

- **RSC requests.** Counted in the tab itself, as requests carrying `rsc: 1`, so other traffic on the server does not count.
  - The sign-in figure covers the 40 s after a fresh sign-in.
  - The settings figure covers the 30 s after another member changed a project's preview port.
- **Sign-in → interactive shell.** From pressing Enter on the login form until all three hold: the page is off `/login`, the boot screen is gone, and `<main>` is on screen.
- **Click → skeleton / content.** `perf.spec.ts` under load, 26 runs of 20 hops each.
  - Skeleton is the paint after the click.
  - Content is the first of two frames with no skeleton left in `<main>`.
  - *Cold* is each page's first visit in a run; *cached* is the return visit.
- **Bootstrap server time.** 200 sequential requests from inside the container against "Load big": 200 projects, 1,000 threads and 20,000 turns, inserted by `bootstrap-big.sh` and analysed. The idle target is used so that only the query is measured.
- **Keystroke echo.** `run.mjs`: the time from sending a key to the first `terminal.output` holding it. 15 users typed 5 keys a second for 10 minutes, 42,863 keys in all.
- **Engine wait.** The `engine_wait_seconds` histogram over the run. Every command waited under 1 ms, the first bucket.
- **Frames per answer.** Every WebSocket frame the chat tab received from send to `agent.turn_completed`, on all of its sockets, for one 2,000-token answer.
- **Long tasks, INP, token-to-paint.** `stream.spec.ts`:
  - long tasks: `PerformanceObserver("longtask")`;
  - INP: Event Timing over key presses made while the answer streams;
  - token-to-paint: a delta's arrival on the socket to the paint of the next frame.
- **Git processes per burst.** The server's own `git_processes_total`, from just before to 5 s after 20 files are written 20 ms apart. Ten viewers have the Git view open, emulated as `use-git-state.ts` behaves.
- **Claude processes.** `procwatch.mjs` inside the container, during 20 `thread.send`s to Claude Code from 10 users at once. The fake CLI held no memory (`FAKE_CLAUDE_RSS_MB=0`): this counts processes, not their 372 MB each.
- **Sockets and subscriptions per tab.** The frames a chat tab sends, 40 s after it opened.
- **Memory and CPU.**
  - `/metrics` scraped every 5 s, by service and child class (`resource-sampler.ts`, private pages);
  - API RSS is the process's own `process_rss_bytes`;
  - Postgres's share comes from `docker stats`, since it runs in its own container.

## Baseline (2026-10-25)

### Definition of Done

| Metric | Baseline | Target |
| --- | --- | --- |
| RSC requests caused by one fresh sign-in | 115 | ≤ 15 |
| RSC requests in other tabs when a member saves settings | 115 per tab | 0 |
| Sign-in submit → interactive shell | 1.99 s under load (1.76–2.30 s over 3; idle 2.03 s) | ≤ 2.0 s |
| Click → skeleton or new page (p95) | 87 ms | ≤ 100 ms under load |
| Click → content, cached data (p95) | 121 ms | ≤ 150 ms under load |
| Click → content, cold data (p95) | 381 ms | ≤ 600 ms under load |
| Bootstrap server time (200 projects / 20k turns, p95) | 74 ms (p50 55 ms) | < 15 ms |
| Terminal keystroke echo (p95 / p99) | 2.7 / 7.3 ms | < 30 ms / < 60 ms |
| Engine wait (p99) | < 1 ms | < 20 ms |
| WebSocket frames per 2,000-token answer | 2,026 | ≤ ⅓ of baseline (≤ 675) |
| Long tasks > 50 ms while streaming a 4,000-token answer | 0 (0 with the CPU throttled 4×) | 0 |
| INP while streaming | 48 ms (worst of 13; median 32 ms) | < 200 ms |
| Git processes per file-change burst, 10 viewers | 80 | ≤ 3 |
| Concurrent `claude` processes during a 20-turn burst | 20 (20 of 20 completed; no global cap) | ≤ `AGENT_MAX_CONCURRENT_TOTAL`, none failed |
| Subscriptions per socket | 22 (user, workspace, 20 projects) + 1 (thread): P + 3 over two sockets | ≈ 4 |
| `/ws` connections per tab | 3 on a chat page (one with no subscriptions); 2 on an earlier run | 1 |
| API RSS under load | 352 MB (mean 312 MB; heap used ≤ 117 MB) | < 1.2 GB |
| Event-loop delay p99 under load | 14 ms worst scrape (median 11.5 ms) | < 50 ms |
| cgroup `oom_kill` during the run | 0 | 0 |
| Builds on the VPS per deploy | 1 (Dokploy builds the Dockerfile on the VPS) | 0 |
| Shell-route first-load JS | 314 kB gz (`/(app)/(home)`, the smallest app route) | ≤ 285 kB |

### What the run used

50 users for 10 minutes: 11 native-agent users (79 turns of 1,500 tokens), 15 typing in terminals, 15 reading git, 9 watching. All 50 polled bootstrap, a page and five prefetches every 30 s. Two browsers looped `perf.spec.ts` and `stream.spec.ts` alongside. There were no errors.

| Where | CPU (cores, mean) | Memory (mean / max) |
| --- | --- | --- |
| Container, all of it (`docker stats`) | 0.43 (max 1.73) | 772 / 1,039 MiB |
| `server`: API, WebSocket, terminals | 0.18 | 223 / 264 MB private; RSS 312 / 352 MB |
| `web`: Next.js | 0.19 | 482 / 702 MB private |
| `shell`: 15–16 terminals | < 0.01 | 9 MB |
| Postgres (its own container) | 0.09 (max 0.42) | 243 MiB |

- **Event loop:** p99 per 5 s scrape had a median of 11.5 ms and a worst of 14 ms; the monitor's resolution is 10 ms. Utilisation averaged 0.16, with a worst of 0.42.
- **Renders:** the Next.js server rendered 12,295 times (1,058 documents, 4,817 RSC, 6,420 RSC prefetches). That cost about 10 ms of CPU each (0.19 cores × 635 s). Server renders called `/api/bootstrap` 7,663 times; browsers called it 1,191 times.
- **Memory growth:** both Node processes kept growing for the whole run.
  - `web` went from 92 MB private at the start to about 700 MB, and was still near its peak at the end.
  - The API went from 219 to 352 MB RSS. Its heap did not grow with it: heap used ranged from 37 to 117 MB (mean 55 MB) and ended at 46 MB.
- **Per turn:** 1,573 frames reached the native user's socket (1,500 deltas), about 506 KB. The first token arrived in 350 ms.
- **Token-to-paint:** p95 of 17 ms (median across 13 streams under load).
- **Nav-skeleton:** p95 of 87 ms (`perf.spec.ts`).
- **Peak concurrent `claude` processes:** 20, in the burst. The 10-minute run used none.

**Postgres's top statements** by total time (`baseline-2026-10-25/pg-top.txt`):

| Calls | Total ms | Mean ms | Statement |
| --- | --- | --- | --- |
| 8,919 | 13,600 | 1.52 | `listProjects`: projects with their per-project subqueries (finding 2) |
| 17,786 | 2,006 | 0.11 | a user's workspaces |
| 13,697 | 763 | 0.06 | one project by hash |
| 1,058 | 498 | 0.47 | the dashboard's usage sums over every turn (one per dashboard render) |
| 1,058 | 303 | 0.29 | the dashboard's project counts |
| 8,921 | 224 | 0.03 | a user's profile |
| 8,906 | 214 | 0.02 | a user's password hash (`hasPassword`, on every bootstrap) |
| 10,297 | 139 | 0.01 | a member's role |
| 1,256 | 86 | 0.07 | `insert into notes … on conflict do nothing`: `NotesService.ensureRoot`, run on every read of a project's notes, writing nothing |
| 2,281 | 72 | 0.03 | a project's threads |

### Caveats

- **Postgres is outside the container.** The production image runs Postgres inside the container; here it is a container of its own. It shares the container's four cores, but not its CPU quota or its 8 GB.
- **The browsers are fast.** They run on the same desktop as the target, and nothing slows them down beyond the 4× throttled run. No long tasks while streaming, even throttled, says the page keeps up on this hardware. It does not say it keeps up on every laptop.
- **CLI memory is not in it.** The fake `claude` held no memory. Twenty real ones would hold about 7.4 GB (372 MB each), most of the 8 GB.
- **Sockets per tab varies.** A chat tab opened 2 sockets on one run and 3 on the next; the third carried no subscriptions.
- **The bootstrap time varied** between 53 and 75 ms (p95) over four timings of the same workspace.
