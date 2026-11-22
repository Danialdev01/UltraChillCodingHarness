# Type checking

UCCH type-checks with **tsc-rs** (`tsc-rs`, a Rust port of the TypeScript 7 compiler). Microsoft's
**TypeScript 7** (`typescript@^7`) stays installed as the backup. Next's build-time check,
editors and anything that needs the `typescript` package also use it.

| Command | What it runs |
| --- | --- |
| `pnpm typecheck` | `scripts/typecheck.sh` in every package: tsc-rs, falling back to `tsc` if tsc-rs breaks. |
| `pnpm typecheck:tsc` | `tsc --noEmit` in every package: the backup on its own. CI runs it after `typecheck`. |
| `UCCH_TYPECHECKER=tsc pnpm typecheck` | The normal command, with tsc-rs skipped. |
| `bash scripts/compare-typecheckers.sh [package…]` | `tsc`, `tsc-rs` and `tsc-rs --fast` on each package. Prints median times; fails if their diagnostics differ. |

`apps/web` runs `next typegen` before checking, because the route types it checks against are
generated.

## The fallback (`scripts/typecheck.sh`)

tsc-rs runs first. Its result is final when it is a checker's answer:

- exit 0 (no errors), or
- exit 1 or 2 along with the errors it found (`… error TS2322: …`).

Anything else means tsc-rs itself broke:

- exit 127: not installed
- exit 101: a Rust panic
- exit 128 and up: killed by a signal
- exit 1 or 2 with no error named

In those cases the script prints `tsc-rs failed (exit N); checking with TypeScript tsc instead`
and runs the same check with `tsc`. A broken tsc-rs therefore never blocks a check, and never lets
one pass. `tests/typecheck-fallback.test.ts` covers each case.

The fallback cannot catch an error that tsc-rs misses while exiting normally. CI covers that by
also running `pnpm typecheck:tsc`. Before upgrading tsc-rs, run `scripts/compare-typecheckers.sh`
and make sure every package reports `same`.

To drop tsc-rs entirely:

1. Point each package's `typecheck` back at `tsc --noEmit`.
2. Remove `tsc-rs` from the root `devDependencies` and from `onlyBuiltDependencies` in
   `pnpm-workspace.yaml`.

## Performance

Measured on 2026-11-22: 16 cores, cold (`--incremental false`, web's build info removed), median
of 3 runs.

| Measurement | Before (tsc) | After (tsc-rs) | Speed-up |
| --- | ---: | ---: | ---: |
| `pnpm typecheck`, wall time as CI and agents run it | 4.44 s | 2.16 s | 2.1× |
| All seven packages' checks, one after another | 4.82 s | 1.79 s | 2.7× |
| `apps/server` | 1.25 s | 0.49 s | 2.6× |
| `apps/web` | 1.57 s | 0.55 s | 2.9× |
| Backup path (`UCCH_TYPECHECKER=tsc`) | – | 4.41 s | same as before |
| Automatic fallback (tsc-rs failing at once) | – | 4.55 s | about 0.1 s over plain `tsc` |

The wall time includes about 0.33 s of `next typegen` and about 0.2 s of pnpm start-up, so it
improves less than the checks themselves. Before the TypeScript 7 upgrade (`tsc` 5.9), the
checks took 25.1 s.

`--fast` (more checker threads) is slower here, because the packages are small.

## TypeScript 7 notes

- **`types` defaults to `[]`.** `@types/node` is listed in `tsconfig.base.json`
  (`"types": ["node"]`), and `apps/web` inherits it. A package that needs another global types
  package has to list it there.
- **Side-effect imports are checked.** `import "./x.css"` needs a module declaration. Next 16
  declares `*.css` itself.
- **No JS compiler API.** TS 7 has no `require("typescript").createProgram`, so a tool that needs
  that API cannot use it. Next.js supports TS 7 from 16.3 on: `next build` type-checks by running
  the project's `tsc` CLI. Next 15 refuses to start with TypeScript 7 installed.

## Next.js 16

- `src/proxy.ts` (`export function proxy`) is what was `src/middleware.ts`. It runs in Node only.
  The body limit for requests it proxies is now `experimental.proxyClientMaxBodySize`.
- `next dev` and `next build` run with **`--webpack`**. Next 16 defaults to Turbopack, and a build
  with a `webpack` config fails without the flag. UCCH needs webpack for three things:
  - `resolve.extensionAlias`, which resolves `.js` specifiers to `.ts` in `@ucch/protocol`.
  - `@serwist/next`.
  - `@next/bundle-analyzer`.

  `PRECACHE` in `next.config.ts` and `scripts/bundle-budget.mjs` also match webpack chunk names.
  Moving to Turbopack is separate work.
- Next 16 no longer writes `app-build-manifest.json`. `scripts/bundle-budget.mjs` reads each
  page's chunks from its `page_client-reference-manifest.js` instead. On a Next 15 build, that
  gave the same table as the old manifest, to the kilobyte.
- `next dev` writes an `AGENTS.md` when it detects an AI coding agent. Set `agentRules: false` in
  `next.config.ts` to stop it.
