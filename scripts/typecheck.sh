#!/usr/bin/env bash
# The type check every package's `typecheck` script runs: tsc-rs, with
# Microsoft's TypeScript (`tsc`) as the backup.
#
#   bash ../../scripts/typecheck.sh [tsc options]     from a package directory
#
# tsc-rs runs first. Its result is final when it is a checker's answer: exit
# 0 (no errors), or exit 1 or 2 with the errors it found (`… error TS1234: …`).
# Anything else means tsc-rs itself broke, not the code: 127 (not installed),
# 101 (a Rust panic), 128 and up (killed by a signal), or a failure that names
# no error. Then the same check runs again with `tsc`, so a broken tsc-rs
# never blocks a check and never passes one.
#
#   UCCH_TYPECHECKER=tsc   skip tsc-rs and check with `tsc` only
#   TSC_RS=<path>          run another tsc-rs binary (the fallback test uses it)
#
# See documentation/type-checking.md.
set -u -o pipefail

if [ "${UCCH_TYPECHECKER:-tsc-rs}" != tsc ]; then
  log="$(mktemp)"
  trap 'rm -f "$log"' EXIT
  "${TSC_RS:-tsc-rs}" --noEmit "$@" 2>&1 | tee "$log"
  code=$?
  case "$code" in
    0) exit 0 ;;
    1 | 2) grep -Eq 'error TS[0-9]+' "$log" && exit "$code" ;;
  esac
  rm -f "$log"
  echo "tsc-rs failed (exit $code); checking with TypeScript tsc instead" >&2
fi

exec tsc --noEmit "$@"
