#!/bin/sh
# fake-omp replaying omp-subagent.jsonl: a `task` call whose scout runs in the
# background, reports progress and answers after the prompt_result
# (OMP_BIN takes a path, not a command line): for e2e/subagent.spec.ts.
here=$(dirname "$0")
exec node "$here/fake-omp.mjs" --fixture "$here/fixtures/omp-subagent.jsonl" "$@"
