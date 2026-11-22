#!/usr/bin/env bash
# TypeScript 7 (`tsc`) against tsc-rs, package by package: the same
# diagnostics, and how long each takes.
#
#   bash scripts/compare-typecheckers.sh            every package, 3 runs each
#   RUNS=5 bash scripts/compare-typecheckers.sh     more runs per checker
#   bash scripts/compare-typecheckers.sh apps/web   only the packages named
#
# Every check is `--noEmit --incremental false`, so no build info is reused.
# Times are the median of RUNS runs. The script exits 1 when any package's
# diagnostics differ between `tsc` and `tsc-rs` (or `tsc-rs --fast`), and
# prints the difference: that is the check to pass before `typescript` is
# aliased to `@tsc-rs/typescript` (documentation/type-checking.md).
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
runs="${RUNS:-3}"
bin="$root/node_modules/.bin"
packages=("$@")
if [ ${#packages[@]} -eq 0 ]; then
  packages=(packages/protocol packages/providers packages/agent packages/db packages/omp-bridge apps/server apps/web)
fi

out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT

# The route types `apps/web` checks against are generated, not committed.
for p in "${packages[@]}"; do
  if [ "$p" = apps/web ]; then (cd "$root/apps/web" && "$root/apps/web/node_modules/.bin/next" typegen >/dev/null); fi
done

now() { date +%s.%N; }

# Median of the arguments.
median() { printf '%s\n' "$@" | sort -n | awk '{ a[NR] = $1 } END { print (NR % 2) ? a[(NR + 1) / 2] : (a[NR / 2] + a[NR / 2 + 1]) / 2 }'; }

# Runs one checker on one package RUNS times. Prints its median seconds and
# leaves its diagnostics, sorted, in $out/<name>.txt.
check() {
  local name="$1" dir="$2"
  shift 2
  local times=()
  for _ in $(seq "$runs"); do
    local start end
    start="$(now)"
    (cd "$dir" && "$@" --noEmit --incremental false -p . >"$out/$name.raw" 2>&1) || true
    end="$(now)"
    times+=("$(echo "$end - $start" | bc)")
  done
  # One diagnostic per line, colour and the summary line dropped, so the
  # comparison is of the diagnostics alone.
  sed -E 's/\x1b\[[0-9;]*m//g' "$out/$name.raw" | grep -E '\(([0-9]+),([0-9]+)\): (error|warning)' | sort >"$out/$name.txt" || true
  median "${times[@]}"
}

printf '%-22s %8s %8s %8s %8s  %s\n' package tsc tsc-rs fast errors diagnostics
status=0
total_tsc=0 total_rs=0 total_fast=0
for p in "${packages[@]}"; do
  dir="$root/$p"
  t_tsc="$(check tsc "$dir" "$bin/tsc")"
  t_rs="$(check rs "$dir" "$bin/tsc-rs")"
  t_fast="$(check fast "$dir" "$bin/tsc-rs" --fast)"
  errors="$(wc -l <"$out/tsc.txt")"
  verdict=same
  if ! diff -q "$out/tsc.txt" "$out/rs.txt" >/dev/null || ! diff -q "$out/tsc.txt" "$out/fast.txt" >/dev/null; then
    verdict=DIFFERENT
    status=1
  fi
  printf '%-22s %7.2fs %7.2fs %7.2fs %8s  %s\n' "$p" "$t_tsc" "$t_rs" "$t_fast" "$errors" "$verdict"
  if [ "$verdict" = DIFFERENT ]; then
    echo "  tsc vs tsc-rs:" && diff "$out/tsc.txt" "$out/rs.txt" | sed 's/^/    /' || true
    echo "  tsc vs tsc-rs --fast:" && diff "$out/tsc.txt" "$out/fast.txt" | sed 's/^/    /' || true
  fi
  total_tsc="$(echo "$total_tsc + $t_tsc" | bc)"
  total_rs="$(echo "$total_rs + $t_rs" | bc)"
  total_fast="$(echo "$total_fast + $t_fast" | bc)"
done
printf '%-22s %7.2fs %7.2fs %7.2fs\n' total "$total_tsc" "$total_rs" "$total_fast"
printf 'tsc-rs is %.1fx and tsc-rs --fast %.1fx the speed of tsc\n' \
  "$(echo "$total_tsc / $total_rs" | bc -l)" "$(echo "$total_tsc / $total_fast" | bc -l)"
exit "$status"
