#!/usr/bin/env bash
# The measurement profile behind documentation/perf/: PF0.9's baseline, and
# what PF3.1 re-runs to compare against it. Against the target up.sh starts,
# seeded (README.md), with nothing else using it.
#
#   bash scripts/load/profile.sh <label> [phase ...]   e.g. baseline-2026-10-25
#
# The phases, in order (all of them by default):
#   bundle   bundle.txt, next-build.txt: first-load JS per route (a fresh web build)
#   idle     on the idle target:
#              signin-idle.json       one fresh sign-in: time to interactive, RSC renders
#              tab.json               a chat tab's sockets and subscriptions, and its
#                                     re-renders when another member saves a setting
#              git-burst.json         git processes for one burst, 10 viewers
#              claude-burst.json      20 Claude Code turns at once
#              bootstrap-big.json     /api/bootstrap on 200 projects / 20,000 turns
#              stream-2000-idle.json  one 2,000-token answer in a browser
#   run      load.json, load.md       the 50-user, 10-minute run (run.mjs), with
#            perf-N.json, stream-N.json  the browser suites looping alongside,
#            signin-load-N.json       three sign-ins during it,
#            pg-top.txt, docker-stats.txt  Postgres's statements and both containers
#   long     load-4000.json, stream-4000.json, stream-4000-cpu4x.json: a
#            4,000-token answer under 5 minutes of load, at full speed and with
#            the page's CPU throttled fourfold
# Everything lands in documentation/perf/<label>/.
#
# Environment: PORT (3397), GEN_CORES (8-15: cores off the container's, for
# everything that generates load or drives a browser), E2E_CHROME.
set -euo pipefail
cd "$(dirname "$0")/../.."

LABEL=${1:?usage: profile.sh <label> [bundle|idle|run|long ...]}
shift
PHASES=${*:-bundle idle run long}
RAW=documentation/perf/$LABEL
mkdir -p "$RAW"
set -a
# shellcheck disable=SC1091
. load-out/env
set +a
export E2E_CHROME=${E2E_CHROME:-/opt/google/chrome/chrome}
export PG_TOP_PSQL='docker exec -i ucch-pg-load psql -U postgres -d ucch_load'
BASE=http://127.0.0.1:${PORT:-3397}
GEN=(taskset -c "${GEN_CORES:-8-15}")
MINUTES=10

say() { echo "[$(date +%H:%M:%S)] $*"; }
ROOT=$PWD
# Absolute: e2e() calls this from inside apps/web.
cookie() { node -e "console.log(require('$ROOT/load-out/sessions.json').users.at($1).cookie.split('=')[1])"; }

# Restarts the mock OpenRouter so its answers are $1 tokens long.
mock() {
  docker exec ucch-load pkill -f "node /load/mock-openrouter.mjs" || true
  sleep 0.5
  docker exec -d -u node ucch-load node /load/mock-openrouter.mjs --rate 60 --length "$1"
  sleep 1
}

# e2e <spec> <result name> <user index>: one run of a browser suite as a
# seeded user, its result copied here. A failed run is said, not fatal.
e2e() {
  local label="$LABEL-$2" file
  if (cd apps/web && E2E_BASE_URL=$BASE E2E_API=$BASE E2E_SESSION=$(cookie "$3") E2E_LABEL=$label \
    "${GEN[@]}" pnpm exec playwright test "$1" >"../../$RAW/$2.log" 2>&1); then
    file=apps/web/e2e/results/$label.json
    [ "$1" = stream ] && file=apps/web/e2e/results/stream-$label.json
    cp "$file" "$RAW/$2.json" && rm "$RAW/$2.log"
  else
    say "  $1 ($2) failed; see $RAW/$2.log"
  fi
}

phase_bundle() {
  say "web build and bundle sizes"
  pnpm --filter @ucch/web build >"$RAW/next-build.txt" 2>&1
  (cd apps/web && node scripts/bundle-budget.mjs) >"$RAW/bundle.txt"
}

phase_idle() {
  say "probes on the idle target"
  mock 1500
  "${GEN[@]}" node scripts/load/probes/signin.mjs --base "$BASE" --email load-047@load.test --settle 40 >"$RAW/signin-idle.json"
  "${GEN[@]}" node scripts/load/probes/tab.mjs >"$RAW/tab.json"
  "${GEN[@]}" node scripts/load/probes/git-burst.mjs >"$RAW/git-burst.json"
  "${GEN[@]}" node scripts/load/probes/claude-burst.mjs >"$RAW/claude-burst.json"
  bash scripts/load/probes/bootstrap-big.sh 200 >"$RAW/bootstrap-big.json"
  mock 2000
  e2e stream stream-2000-idle -1
  mock 1500
}

phase_run() {
  say "the ${MINUTES}-minute run, with the browser suites alongside"
  mock 1500
  bash scripts/pg-top.sh --reset >/dev/null
  (
    while :; do
      echo "# $(date +%s)"
      docker stats --no-stream --format '{{.Name}} {{.CPUPerc}} {{.MemUsage}}' ucch-load ucch-pg-load
      sleep 5
    done
  ) >"$RAW/docker-stats.txt" 2>&1 &
  local stats=$! run perf stream signin ends
  "${GEN[@]}" node scripts/load/run.mjs --users 50 --minutes "$MINUTES" --label "$LABEL" --out "$RAW/load.json" \
    >"$RAW/load.log" 2>&1 &
  run=$!
  # The run ramps for 30 s, then holds; a suite starts only while there is
  # time for it to finish inside the run.
  ends=$(($(date +%s) + 30 + MINUTES * 60))
  (
    sleep 60
    n=0
    while [ $((ends - $(date +%s))) -gt 120 ]; do
      n=$((n + 1))
      e2e perf "perf-$n" -2
    done
  ) &
  perf=$!
  (
    sleep 90
    n=0
    while [ $((ends - $(date +%s))) -gt 90 ]; do
      n=$((n + 1))
      e2e stream "stream-$n" -1
    done
  ) &
  stream=$!
  (
    for n in 1 2 3; do
      sleep 150
      "${GEN[@]}" node scripts/load/probes/signin.mjs --base "$BASE" --email load-047@load.test --settle 20 \
        >"$RAW/signin-load-$n.json" || say "  sign-in $n failed"
    done
  ) &
  signin=$!
  wait "$run" || say "  run.mjs failed; see $RAW/load.log"
  wait "$perf" "$stream" "$signin" || true
  kill "$stats"
  bash scripts/pg-top.sh >"$RAW/pg-top.txt"
}

phase_long() {
  say "a 4,000-token answer under 5 minutes of load, at full speed and throttled"
  mock 4000
  "${GEN[@]}" node scripts/load/run.mjs --users 50 --minutes 5 --label "$LABEL 4000" --out "$RAW/load-4000.json" \
    >"$RAW/load-4000.log" 2>&1 &
  local run=$!
  sleep 60
  e2e stream stream-4000 -1
  E2E_CPU_THROTTLE=4 e2e stream stream-4000-cpu4x -1
  wait "$run" || say "  run.mjs (4000) failed; see $RAW/load-4000.log"
  mock 1500
}

for phase in $PHASES; do
  "phase_$phase"
done
say "done: $RAW"
