#!/bin/sh
# fake-omp replaying the last turn of omp-compaction.jsonl, which compacts mid-turn
# and is the compaction the recording's get_messages describes
# (OMP_BIN takes a path, not a command line): for e2e/compaction.spec.ts.
here=$(dirname "$0")
exec node "$here/fake-omp.mjs" --fixture "$here/fixtures/omp-compaction.jsonl" --prompt 4 "$@"
