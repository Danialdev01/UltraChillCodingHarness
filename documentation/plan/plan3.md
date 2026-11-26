# Plan 3: Framework profiles in the New Project dialog

## Context

**Request:** the New Project dialog asks which framework the project will use: **Laravel, Next.js, React, ASP.NET or Rust**. UCCH then sets up the project's environment for that framework: runtime versions, compiler and toolchain, package manager, dev server, command buttons, preview port, environment defaults and agent hints. Each choice can be changed in the dialog and again later in Project Settings.

**What exists today:**
- **New Project dialog** (`apps/web/src/components/new-project-dialog.tsx`). It asks for the source (Git / New Repo / Empty), name, mode, database, project key and session branches. Everything becomes one `project.create` command (`packages/protocol/src/commands.ts:16`), sent by `createProject` (`apps/web/src/lib/create-project.ts`).
- **Clone reactor** (`apps/server/src/clone.ts`). It clones or runs `git init`, runs `detectStack()` (`clone.ts:417`, which already knows `laravel`, `nextjs`, `react`, `rust` and `dotnet`), and writes `.agent/` context through `renderContext` (`apps/server/src/dev-database.ts:142`).
- **Runtime manager** (`apps/server/src/runtimes/`). It installs per-project versions into `RUNTIMES_ROOT/{id}/{version}` and links them into `projects/{id}/bin`, which is first on PATH for terminals, command buttons and agents (`pathFor`, `manager.ts:360`). The choice lives in the committed file `.agent/runtimes.json`. **PHP is the only provider.** `registry.ts` and `types.ts` already describe Node, .NET (`dotnet-install.sh`) and Rust (rustup) as "one more provider".
- **Command buttons:** `.agent/commands.json` (`apps/server/src/project-commands.ts`, `packages/protocol/src/project-commands.ts`).
- **Runtimes tab** on the manage page (`apps/web/src/components/runtime-settings.tsx`), with one card per runtime.
- **Image toolchain** (`Dockerfile:132`). It has Debian `php-cli` + composer and Node 22. It has no Rust, no .NET and no C compiler/linker.

**Gap:** the only thing the environment gets from the framework is the sidebar icon. Choosing a PHP version is the only toolchain control. A Next.js, ASP.NET or Rust project starts with whatever the image happens to have, no command buttons, no preview port and generic agent instructions.

**Goal:** choosing a framework, at creation or later, gives a project that is ready to run straight away. The right runtime is installed and pinned, sensible commands are one click away, the preview works, and agents use the framework's own test, lint and build commands. All of it lives in committed `.agent/` files, so it travels with the repository and can be edited by hand.

## Design principles

1. **A profile is data, not code paths.** Each framework is one `FrameworkProfile` record: its options, their defaults, and what each choice writes. Nothing outside the profile registry branches on the framework id.
2. **Files are the source of truth.** The choice is stored in `.agent/framework.json`, which is committed alongside `runtimes.json` and `commands.json`. The server derives everything from these files at spawn time, as the runtime manager already does. A `git pull` that changes them takes effect without anyone pressing anything.
3. **The repository wins over the defaults.** When a cloned repo states a requirement (`composer.json` `require.php`, `package.json` `engines` / `packageManager`, `global.json` `sdk.version`, `rust-toolchain.toml`), the profile follows it. Defaults fill only what the repo leaves unsaid.
4. **Additive, never destructive.** Applying or changing a profile only adds missing command buttons, env defaults and runtime selections. It never overwrites a file or a value someone wrote by hand. The one exception is a field the profile itself owns (`.agent/framework.json`).
5. **Install lazily, through the runtime manager.** Toolchains come from the runtime providers into `RUNTIMES_ROOT`. They are never apt packages per framework. Image size stays flat, and a version that no project uses is never downloaded.
6. **Budget the agent hints.** A framework adds at most ~600 bytes to the agent's context. That text goes into `.agent/` context written once, never into the per-turn prefix, as plan2 §2.3 requires. It is covered by the size-budget test (plan2 §2.6).

## The five profiles

Each option shows its **default** in bold. "Runtime" options become `.agent/runtimes.json` selections, so they get the existing `latest | system | X.Y | X.Y.Z` semantics.

### Laravel (`stack: laravel`)
| Option | Choices | Writes |
|---|---|---|
| PHP version | **latest** · 8.4 · 8.3 · 8.2 · system | `runtimes.json` `php` (existing provider) |
| Composer | **2 (latest)** · pinned 2.x | `runtimes.json` `composer` (new, a phar linked as `bin/composer`) |
| Node (Vite assets) | **lts** · 22 · 20 · none | `runtimes.json` `node` |
| JS package manager | **npm** · pnpm · bun | commands, `COREPACK_ENABLE_STRICT=0` |
| Dev server | **`php artisan serve`** · Octane (FrankenPHP) · Octane (Swoole/RoadRunner: system PHP only) | `dev` command, preview port 8000 |
| Queue / scheduler buttons | **on** · off | `queue:work`, `schedule:work` commands |
| Extensions note | the static PHP "common" set has no `intl`, so the dialog warns and suggests `system` when `composer.json` requires `ext-intl` | none (warning only) |

Env defaults (only when absent from `.env`): `APP_ENV=local`, `APP_DEBUG=true`, `APP_URL` = the preview URL. `DB_*` comes from the dev database when one was chosen (it reuses the `DATABASE_URL` flow in `dev-database.ts`).
Commands: Dev, `composer install`, `php artisan migrate`, `php artisan test`, `./vendor/bin/pint`, `npm run dev` / `build`.
Agent hint: use `php artisan make:*` generators, run `php artisan test` and Pint, and never commit `.env`.

### Next.js (`stack: nextjs`)
| Option | Choices | Writes |
|---|---|---|
| JS runtime | **Node lts** · Node 22 · Node 24 · Bun | `runtimes.json` `node` / `bun` |
| Package manager | **pnpm** · npm · yarn · bun (follows `packageManager` when set) | commands, corepack |
| Bundler | **Turbopack** · Webpack | `dev` = `next dev` or `next dev --webpack` |
| Type checker | **tsc (TypeScript 7)** · tsgo/tsc-rs fast path | `typecheck` command (mirrors `documentation/type-checking.md`) |
| Linter / formatter | **ESLint + Prettier** · Biome | `lint` / `format` commands |
| Output | **default** · `standalone` · static export | build command note; static export sets `previewStaticDir=out` |

Env defaults: `NEXT_TELEMETRY_DISABLED=1`, `PORT=3000`. Preview port 3000.
Commands: Dev, Build, Start, Lint, Typecheck, Test (when a runner is detected).
Agent hint: App Router conventions, server vs client components, and run lint + typecheck before finishing.

### React (`stack: react`; means a Vite SPA unless the repo says otherwise)
| Option | Choices | Writes |
|---|---|---|
| JS runtime | **Node lts** · Node 22/24 · Bun | `runtimes.json` |
| Package manager | **pnpm** · npm · yarn · bun | commands |
| Build tool | **Vite** · Rsbuild | commands, scaffold template |
| JSX compiler | **SWC** (`@vitejs/plugin-react-swc`) · Babel (`@vitejs/plugin-react`) · + React Compiler toggle (Babel only) | scaffold, agent hint |
| Type checker | **tsc** · tsgo | `typecheck` command |
| Test runner | **Vitest** · none | `test` command |

Env defaults: none needed. `dev` binds `--host 0.0.0.0` so the preview proxy reaches it. Preview port 5173.

### ASP.NET Core (`stack: dotnet`)
| Option | Choices | Writes |
|---|---|---|
| .NET SDK | **10 (LTS)** · 9 (STS) · 8 (LTS) · exact version · system (follows `global.json`) | `runtimes.json` `dotnet` (new provider, `dotnet-install.sh --channel X --install-dir`) |
| Template (Empty source only) | **webapi** · mvc · razor · blazor · worker | scaffold `dotnet new <t>` |
| Dev loop | **`dotnet watch` (hot reload)** · `dotnet run` | `dev` command |
| Build configuration | **Debug** · Release | `build` / `publish` commands |
| Publish mode | **framework-dependent** · self-contained · Native AOT (needs `clang`, see Phase 0) | `publish` command |
| Globalization | **ICU** (needs `libicu72` in the image) · invariant | `DOTNET_SYSTEM_GLOBALIZATION_INVARIANT` |

Env defaults: `ASPNETCORE_ENVIRONMENT=Development`, `ASPNETCORE_URLS=http://0.0.0.0:5000`, `DOTNET_CLI_TELEMETRY_OPTOUT=1`, `DOTNET_NOLOGO=1`, `NUGET_PACKAGES` = shared cache (Phase 2). Preview port 5000.
Commands: Dev, `dotnet build`, `dotnet test`, `dotnet format`, Publish, EF migrations (when `Microsoft.EntityFrameworkCore.Design` is referenced).

### Rust (`stack: rust`)
| Option | Choices | Writes |
|---|---|---|
| Toolchain | **stable** · beta · nightly · pinned `1.xx` (follows `rust-toolchain.toml`) | `runtimes.json` `rust` (new provider: rustup with `RUSTUP_HOME`/`CARGO_HOME` under `RUNTIMES_ROOT`) |
| Components | **clippy + rustfmt** · + rust-analyzer · + rust-src | provider installs the components |
| Edition (Empty only) | **2024** · 2021 | `cargo new --edition` |
| Linker | **system `cc`** · mold · lld | `.cargo/config.toml` `[target.x86_64-unknown-linux-gnu] linker/rustflags` (only when absent) |
| Compile cache | **off** · sccache | `RUSTC_WRAPPER=sccache` |
| Build profile for Dev | **dev** · release | `dev` command `cargo run [--release]` |
| Watch | **`cargo watch -x run`** · bacon · none | `dev` command; tool installed via `cargo install --locked` into the shared `CARGO_HOME` |
| Web template (Empty only) | **none (bin)** · Axum · Actix · lib | scaffold |
| Extra target | **none** · `wasm32-unknown-unknown` | `rustup target add` |

Env defaults: `CARGO_TERM_COLOR=always`, `RUST_BACKTRACE=1`, `CARGO_TARGET_DIR` stays in the project (it is not shared, so worktrees never race on locks). Preview port 3000 for web templates.
Commands: Dev, `cargo build`, `cargo test`, `cargo clippy -- -D warnings`, `cargo fmt`.

A sixth choice, **"Other / auto-detect"**, is the default for the Git source. It writes no profile at creation. After the clone, if `detectStack` returns one of the five stacks, the project page offers "Optimize for Laravel?", which applies the profile using the repo's own constraints.

## Tasks

### Phase 0: Image prerequisites
- [x] **0.1** Add `build-essential` (cc/ld for Rust build scripts and `cc` crates), `pkg-config`, `libssl-dev`, `libicu72` (.NET globalization) and `clang` (.NET Native AOT, Rust lld) to the `toolchain` stage (`Dockerfile:140`). Measure the image-size change and record it in the PR.
- [x] **0.2** Optional, behind build args: `mold` and `sccache` as release binaries. If they are absent, the dialog greys out their choices ("not on this server") from a server capability list (task 1.4).

### Phase 1: Protocol and profile registry
- [x] **1.1 `packages/protocol/src/frameworks.ts`** (plain, no zod, so the browser can import it from `@ucch/protocol/plain`):
  - `FRAMEWORK_IDS = ["laravel","nextjs","react","aspnet","rust"]`, `FRAMEWORK_LABELS`, `FRAMEWORK_STACK` (id → the `detectStack` name: `aspnet` → `dotnet`).
  - `FrameworkOption = { key, label, kind: "select"|"toggle"|"version", choices, default, emptyOnly?, requires? }`.
  - `FrameworkProfile = { id, options, runtimes(choice) → Partial<Record<RuntimeId,string>>, commands(choice) → ProjectCommand[], env(choice) → Record<string,string>, previewPort(choice), agentHint(choice), scaffold?(choice) → argv[] }`.
  - The derive functions are pure, so the dialog can show a live "this will set up" summary and the server can apply the same thing.
- [x] **1.2 `.agent/framework.json` schema** (`packages/protocol/src/framework-file.ts`, zod): `{ framework: FrameworkId, options: Record<string, string|boolean>, appliedAt }`. Unknown option keys are kept, so the file round-trips, and invalid values fall back to defaults with a reported `error`. This follows `readSelections` in `runtimes/manager.ts:82`: symlink, size and JSON checks.
- [x] **1.3 Command and event.** Add `framework?: { id: FrameworkId; options: Record<string, string|boolean> }` to `ProjectCreate` (`commands.ts:16`) and to `ProjectCreated` (`events.ts:41`), both optional, so old events still read. `decide()` validates option values against the profile and refuses unknown ids.
- [x] **1.4 Capabilities endpoint.** `GET /api/frameworks` returns the profiles' option lists plus server capabilities: which runtime providers are registered, `mold`/`sccache`/`clang` presence, and available version lists (reusing `RuntimeManager.available`, which is cached for 6 h). The dialog greys out what the server can't do.
- [x] **1.5 Unit tests** for every profile's derive functions, snapshotted as `{runtimes, commands, env, previewPort}` per default choice, plus one test that every command id is unique and stays within `PROJECT_COMMAND_*` limits.

### Phase 2: Runtime providers (the "runtime and compiler" half)
Each provider is one file in `apps/server/src/runtimes/` plus one id in `RUNTIME_IDS` (`packages/protocol/src/runtime-names.ts:14`). The manager, routes and settings card already work per runtime.
- [x] **2.1 `node.ts`:** nodejs.org `index.json` + `SHASUMS256.txt` (checksums verified, unlike PHP). It provides `node`, `npm`, `npx` and `corepack`. `lts` is a selection alias. `constraintOf` reads `package.json` `engines.node` and `.nvmrc`.
- [x] **2.2 `bun.ts`:** GitHub release zip for `bun-linux-x64`, checked against the release's `SHASUMS256.txt`.
- [x] **2.3 `dotnet.ts`:** `releases-index.json` → per-channel `releases.json` (it carries sha512 hashes). It installs the SDK tarball into `dir`, and `bin/dotnet` is a link to the root `dotnet`. `constraintOf` reads `global.json` `sdk.version`.
- [x] **2.4 `rust.ts`:** downloads a pinned `rustup-init` (sha256 checked). Versions are toolchain names (`stable`, `beta`, `nightly`, `1.xx.y`). A shared `RUSTUP_HOME` under `RUNTIMES_ROOT/rust/rustup` gets one toolchain dir per install, and `bin/{cargo,rustc,rustup,clippy-driver,rustfmt}` link into it. `constraintOf` reads `rust-toolchain(.toml)`. `version.ts` needs a small extension so channel names count as selections (`RUNTIME_SELECTION_PATTERN` gains `stable|beta|nightly` for rust only).
- [x] **2.5 `composer.ts`:** getcomposer.org `versions` + sha256. `bin/composer` is the phar with `#!/usr/bin/env php`, so it follows the project's PHP.
- [x] **2.6 Per-process environment.** Add `RuntimeManager.envFor(cwd)` next to `pathFor`. It sets cache and home variables: `CARGO_HOME`, `RUSTUP_HOME`, `NUGET_PACKAGES`, `COMPOSER_HOME`, `npm_config_cache`, the pnpm store and `BUN_INSTALL_CACHE_DIR`.
  - **Caches are scoped per workspace** (`RUNTIMES_ROOT/cache/{workspaceId}/…`), not shared across tenants, so one tenant's build can't poison a package cache another tenant uses (see `documentation/security-audit-2026-11-18.md`).
  - Wire it everywhere `pathFor` is passed today: `apps/server/src/index.ts:300`, `:456` and `:620`.
- [x] **2.7 Tests** follow `manager.test.ts` / `php.test.ts`: index parsing, checksum mismatch rejected, `constraintOf` per file format, and the channel selections for rust.

### Phase 3: Applying a profile (server)
- [x] **3.1 `apps/server/src/framework-profile.ts`:** `applyProfile(root, choice, { source, workspaceId, constraints })`.
  1. Read repo constraints through each provider's `constraintOf`. A stated constraint overrides the profile default, and the override is recorded in `framework.json` (`"php": "^8.2 (from composer.json)"`).
  2. `writeSelections(root, runtimes)` (`manager.ts:113`), adding only keys that `runtimes.json` doesn't already have.
  3. Merge commands into `.agent/commands.json` with `writeCommands` (`project-commands.ts:56`), adding only missing ids and respecting `PROJECT_COMMANDS_MAX`.
  4. Env defaults go to `.env` (git-ignored), only for absent keys, through the same writer `dev-database.ts` uses for `DATABASE_URL`. When the project has a project key, they go through the env vault instead (`env-vault.ts`).
  5. Framework-owned config files, only when absent: `.cargo/config.toml` (linker), `global.json` (only when an exact SDK was pinned).
  6. Write `.agent/framework.json`, then `refreshIndexFiles(root)`.
- [x] **3.2 Scaffold (Empty and New Repo sources only).** Runs before the first commit, in the project dir, with `pathFor`/`envFor` applied, as an argv array (no shell). Commands: `composer create-project laravel/laravel .`, `pnpm create next-app@latest . --ts --app --yes`, `pnpm create vite . --template react-swc-ts`, `dotnet new webapi -o .`, `cargo init --edition 2024 [--lib]` (plus `cargo add axum tokio -F tokio/full` for Axum).
  - A 5-minute timeout. On failure, the project still opens: the error travels on `project.cloned.scaffoldError`, as `databaseError` already does, and the dialog shows it as a toast.
  - Gated by a dialog toggle, **"Generate a starter project"**, which is on by default for Empty.
  - It needs network access to registries. Respect the existing outbound policy; if the server has none, the toggle hides.
- [x] **3.3 Clone reactor hook** (`clone.ts:143` `settle`). After clone/init and before `renderContext`: when `event.framework` is set, run the scaffold (Empty only), then `applyProfile`. After that, `detectStack` runs on the result, as it does today, so the icon matches.
  - Stack mismatch (the user chose Next.js for a Laravel repo): still apply, and add `frameworkWarning` to `project.cloned` ("Repository looks like Laravel").
- [x] **3.4 Preview default.** When `previewPort` is null, set it to the profile's port at creation. The creator owns the project, so this is the same grant the Preview dialog would make (`preview.ts` rule: stored port = the grant). For Next static export, set `previewStaticDir`.
- [x] **3.5 Agent context.** `renderContext` (`dev-database.ts:142`) gains a `## Framework` section: framework, resolved runtime versions, the dev/test/lint/build command names, and the profile's `agentHint`. It is written once, outside the per-turn prefix. Add the expected bytes to `agent-context-budget.json` with a test.
- [x] **3.6 Change later: `project.framework_set` command → `project.framework_changed` event.** It re-runs `applyProfile` (additive) and rewrites `framework.json`. Runtime changes take effect on the next spawn through the existing atomic relink. Commands the old profile added and nobody edited (tracked by a content hash stored in `framework.json`) are removed. Edited ones are kept.
- [x] **3.7 Auto-detect offer.** When a project has no `framework.json` and `project.cloned` / `project.stack_detected` reports `laravel | nextjs | react | dotnet | rust`, the project snapshot carries `suggestedFramework`. Dismissing it writes `framework.json` with `{ framework: null, dismissed: true }`.

### Phase 4: Web UI
- [x] **4.1 Framework picker in `new-project-dialog.tsx`**, placed after the Mode/Database row and shown only for `mode === "development"`:
  - A 6-tile radio grid (the same pattern as `HostChoice`, `new-project-dialog.tsx:1033`) with icons from `stackIconName` (`apps/web/src/lib/stack-icons`). The tiles are: Laravel · Next.js · React · ASP.NET · Rust · Other.
  - Default: "Other / auto-detect" for Git, and no preselection for Empty/New Repo. The chosen tile expands a **"Toolchain"** panel.
- [x] **4.2 `components/framework-options.tsx`:** renders a profile's `options` as `PopoverSelect` / `Segmented` / `Switch` from `form-dialog`. Version selects are filled from `/api/frameworks`, with a skeleton while loading (`apps/web/CLAUDE.md` rule: never a spinner or "Loading…").
  - `emptyOnly` options (template, edition, starter toggle) appear only on the Empty / New Repo tabs.
  - Choices the server can't provide are disabled, with a reason.
  - It is the same component the manage page uses, so the two never drift.
- [x] **4.3 "Will set up" summary**, a `Callout` built from the pure derive functions (task 1.1). Example: "PHP 8.4 · Node 22 · 6 command buttons · preview on :8000 · downloads ~40 MB on first use". When there is a Git source, it adds: "the repository's own requirements win".
- [x] **4.4 Send it.** `command` (`new-project-dialog.tsx:449`) includes `framework` when one is chosen. Reset it in the close effect (`:220`). Surface `scaffoldError` / `frameworkWarning` from `createProject` (`create-project.ts`) as toasts, as `databaseError` is today. Show a `"Generating starter…"` stage label in the footer.
- [x] **4.5 Manage page.** Rename the Runtimes tab to **Environment**. It shows the framework tile and `FrameworkOptions` (dispatching `project.framework_set`) above the existing `RuntimeSettings` cards, which now list node/bun/dotnet/rust/composer too. It also has the auto-detect banner (task 3.7) on the project page, and a matching skeleton in `page-skeletons.tsx` for the tab's `loading.tsx`.
- [x] **4.6 Query wiring.** `projectQueries.framework(hash)` in `lib/queries/project-data.ts` (the rule for per-project lists). It refetches on `resource.changed{runtimes}`, which is reused because the framework file sits next to `runtimes.json`.

### Phase 5: Documentation
- [x] **5.1** `documentation/architecture.md`: the profiles, the `.agent/framework.json` file, the new providers, and the per-workspace caches.
- [x] **5.2** `documentation/spec.md`: the dialog's new section and the Environment tab.
- [x] **5.3** `README.md` env table: any new variables (`RUNTIMES_AUTO_INSTALL` already exists; add `FRAMEWORK_SCAFFOLD=on|off`).

## Critical files
- `packages/protocol/src/frameworks.ts` (new), `framework-file.ts` (new), `runtime-names.ts`, `commands.ts`, `events.ts`, `plain.ts` (export)
- `apps/server/src/runtimes/{node,bun,dotnet,rust,composer}.ts` (new), `registry.ts`, `manager.ts` (`envFor`), `version.ts`
- `apps/server/src/framework-profile.ts` (new), `clone.ts`, `dev-database.ts` (`renderContext`), `decide.ts`, `engine.ts` (projection), `index.ts` (wiring `envFor`, `/api/frameworks`)
- `apps/web/src/components/new-project-dialog.tsx`, `framework-options.tsx` (new), `runtime-settings.tsx`, `project-manage.tsx`, `lib/create-project.ts`, `lib/queries/project-data.ts`, `page-skeletons.tsx`
- `Dockerfile` (toolchain stage)

## Reuse, don't rebuild
- `readSelections` / `writeSelections` / `pathFor` / `#autoInstall`: `apps/server/src/runtimes/manager.ts`
- `readCommands` / `writeCommands`: `apps/server/src/project-commands.ts`
- `detectStack`, `packageDependencies`: `apps/server/src/clone.ts:417`
- `agentPath`, `writeIfChanged`: `apps/server/src/agent-sync.ts`; `refreshIndexFiles`: `dev-database.ts`
- `HostChoice` tile pattern, `PopoverSelect`, `Segmented`, `Callout`: `new-project-dialog.tsx`, `components/form-dialog`
- `stackIconName` / `ProjectStackIcon`: `apps/web/src/lib/stack-icons`, `components/project-stack-icon.tsx`

## Verification
1. **Unit:** `pnpm --filter @ucch/protocol test` (profile derive snapshots, file schema) and `pnpm --filter @ucch/server test` for the provider index/checksum parsing, `applyProfile` additivity (pre-existing `commands.json` and `.env` keys are untouched), and the decide() validation. Run one spec at a time with the filter form from the pnpm `--` pitfall memory, not `pnpm test -- X`.
2. **Type check:** `tsc-rs`, with `tsc` as the backup (`documentation/type-checking.md`).
3. **Live, per framework (5×):** in the dev stack, create an **Empty** project with the starter toggle on. Then:
   - Open a terminal and check that `which php|node|dotnet|cargo` points into `RUNTIMES_ROOT/projects/{id}/bin`, and that the reported version matches the dialog.
   - Press **Dev**, then **Test**.
   - Open Preview and see the starter page.
   - Ask the agent to "add a health endpoint and run the tests" and check that it uses the framework's own test command.
4. **Git import:** clone a public Laravel repo whose `composer.json` requires `php ^8.2`. Pick "auto-detect", accept the banner, and check that `framework.json` records the constraint override.
5. **Change later:** switch a Rust project from stable to nightly on the Environment tab. A terminal that's already open runs nightly `rustc --version` on its next command. Edited command buttons survive.
6. **Browser:** check the dialog and Environment tab with Claude in Chrome, or headless CDP if the extension is down (memory: headless-browser-verification): skeletons while loading, no layout jump, and a 375 px width.
7. **Security:** two workspaces building Rust don't share `CARGO_HOME`. A symlinked `.agent/framework.json` is refused.

## Completion notes (2026-11-26)

All tasks are built; the branch is `plans-completion`.

**Verified live in the dev stack.** An Empty project was created per framework with the starter on, over `/ws` as the dialog sends it:
- **React:** Node LTS (26.13.1) was downloaded, checked against `SHASUMS256.txt` and linked. `which node pnpm` resolve into `RUNTIMES_ROOT/projects/{id}/bin`. The Vite starter typechecks.
- **Next.js:** `create-next-app` ran. `tsc`, `eslint` and `next build` pass with the project's Node.
- **Laravel:** PHP 8.5.8, Composer 2.11.3 and Node LTS. `php artisan test` passes (2/2).
- **ASP.NET:** .NET 10.0.404 (LTS, sha512 checked). `dotnet build` gives 0 errors.
- **Rust (Axum):** Rust 1.100.0 via the pinned `rustup-init`. `cargo build`, `test`, `clippy` and `fmt --check` pass. `CARGO_HOME` sits under the workspace's cache.
- **Change later:** `project.framework_set` (Rust + bacon) replaced the Dev button nobody had edited, and rewrote the `## Framework` section.
- **Preview ports:** each profile's port was set (5173, 3000, 8000, 5000).
- **UI:** `e2e/framework-profiles.spec.ts` covers the dialog's picker, options and summary, and the Environment tab, at 1280 and 375 px.

**Found and fixed while testing live:**
- create-vite 8 dropped the SWC and Babel templates, so the React option is now plugin vs. React Compiler (`react-ts` / `react-compiler-ts`).
- create-next-app has no `--webpack`, so that bundler choice applies only to the Dev command.
- create-rsbuild takes `--package-name`, `--no-git` and `--tools react-compiler`.
- Starters name the package after the `{name}-starter` folder. It is renamed to the project.
- Laravel's starter `.env` carries `APP_KEY`, so its new keys are now merged into the profile's `.env` instead of being dropped.
- `cargo init --vcs none` writes no `.gitignore`, so the Rust profile adds `/target`.
- `rustup-init` refuses to run under another file name (it reads its own name), so it now lives in a folder of its own.
- A download cut off by a server restart left `.tmp-*` folders behind. Boot now clears them.
- A version installed without its tags file (an older server) takes its `lts` tag from the cached index.

**Not verified:**
- The Docker image was not rebuilt. The apt packages (`build-essential pkg-config libssl-dev libicu72 clang lld`, and `mold`/`sccache` behind `WITH_MOLD`/`WITH_SCCACHE`) were checked as available in bookworm, but the size change is not measured.
- Pressing Dev/Test in the browser and the Preview page load, and an agent turn using the framework's commands. These need a signed-in harness.
- Verification items 4 (a Git import with a `composer.json` constraint) and 7 (two workspaces' `CARGO_HOME`) are covered by unit tests only.

**Accepted exceptions:**
- `.env` defaults are written in plain text, even when the project has a key. They are dev defaults (`APP_ENV=local`), not secrets.
- Rust toolchains live in one server-wide `RUSTUP_HOME`. Only the caches (`CARGO_HOME`) are per workspace.
- React Compiler support is the starter's own template plus the agent hint. An existing repo isn't rewritten.
- Next's Test button runs the package.json `test` script, because Next ships no test runner.
- npm prints "Unknown env config store-dir" for `npm_config_store_dir`, which pnpm reads. It is harmless.

