#!/bin/sh
# fake-omp replaying omp-review.jsonl: the main agent hands the diff to the
# bundled `reviewer`, which yields a P0 on math.ts line 2 after the
# prompt_result (OMP_BIN takes a path, not a command line): for
# e2e/review.spec.ts.
here=$(dirname "$0")
exec node "$here/fake-omp.mjs" --fixture "$here/fixtures/omp-review.jsonl" "$@"
