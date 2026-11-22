# Type checking

UCCH is checked with **TypeScript 7** (`typescript@^7`, Microsoft's native compiler).
**tsc-rs** (`tsc-rs`, a Rust port of the same compiler) is installed alongside it, so the
two can be compared and the switch to tsc-rs is one line.

| Command | What it runs |
| --- | --- |
| `pnpm typecheck` | `tsc --noEmit` in every package (TypeScript 7). This is what CI runs. |
| `pnpm typecheck:rs` | `tsc-rs --noEmit` in every package. |
| `bash scripts/compare-typecheckers.sh [package…]` | Both checkers, plus `tsc-rs --fast`, on each package. It prints median times and fails if the diagnostics differ. |

`apps/web` runs `next typegen` before either checker, because the route types it checks against
are generated.

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

## Switching the default checker to tsc-rs

1. Run `bash scripts/compare-typecheckers.sh` and make sure it reports `same` for every package.
2. Change `typescript` in the root and `apps/web` `package.json` to
   `"npm:@tsc-rs/typescript@<version>"`. In `pnpm-workspace.yaml`, add `@tsc-rs/typescript` to
   `onlyBuiltDependencies` and add `peerDependencyRules: { allowAny: [typescript] }`. Without the
   peer rule, packages that peer on `typescript` see the tsc-rs npm version, not 7.x.
3. `tsc`, `next build`'s type check, and editors pointed at `node_modules/typescript/lib` now run
   tsc-rs.

To go back, restore `typescript@^7`.

Measured on 2026-11-22 (16 cores, `--noEmit --incremental false`, median of 3 runs, all seven
packages):

| Checker | Total | Relative to TypeScript 5.9 |
| --- | ---: | ---: |
| `tsc` 5.9 (before) | 25.1 s | 1× |
| `tsc` 7.0.2 | 4.84 s | 5.2× |
| `tsc-rs` 0.8.0 | 1.77 s | 14.2× |
| `tsc-rs --fast` | 1.95 s | 12.9× |

The packages are small, so `--fast` (more checker threads) costs more than it saves.
