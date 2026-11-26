/**
 * Framework profiles (plan3): what choosing Laravel, Next.js, React,
 * ASP.NET or Rust sets up for a project.
 *
 * A profile is data. Its options, their defaults, and pure functions from a
 * choice to what it writes: runtime selections (`.agent/runtimes.json`),
 * command buttons (`.agent/commands.json`), `.env` defaults, the
 * environment every process gets, the preview port, and a short hint for
 * the agents. The New Project dialog shows a live summary from these, and
 * the server applies the same thing (`apps/server/src/framework-profile.ts`),
 * so the two never disagree. Nothing outside this file branches on a
 * framework id.
 *
 * No zod: the browser imports it from `@ucch/protocol/plain`.
 */

import type { RuntimeId } from "./runtime-names.js";

export const FRAMEWORK_FILE = ".agent/framework.json";

export const FRAMEWORK_IDS = ["laravel", "nextjs", "react", "aspnet", "rust"] as const;
export type FrameworkId = (typeof FRAMEWORK_IDS)[number];

export const FRAMEWORK_LABELS: Record<FrameworkId, string> = {
  laravel: "Laravel",
  nextjs: "Next.js",
  react: "React",
  aspnet: "ASP.NET Core",
  rust: "Rust",
};

/** The name `detectStack` gives the same thing (the sidebar icon's). */
export const FRAMEWORK_STACK: Record<FrameworkId, string> = {
  laravel: "laravel",
  nextjs: "nextjs",
  react: "react",
  aspnet: "dotnet",
  rust: "rust",
};

/** The profile a detected stack matches, if any. */
export function frameworkForStack(stack: string | null | undefined): FrameworkId | null {
  return FRAMEWORK_IDS.find((id) => FRAMEWORK_STACK[id] === stack) ?? null;
}

export function isFrameworkId(value: unknown): value is FrameworkId {
  return typeof value === "string" && (FRAMEWORK_IDS as readonly string[]).includes(value);
}

/** What a server may lack, which greys a choice out in the dialog. */
export type FrameworkCapability = "mold" | "sccache" | "lld" | "clang" | "scaffold";

export type FrameworkOptionValue = string | boolean;
export type FrameworkOptions = Record<string, FrameworkOptionValue>;

export interface FrameworkChoice {
  value: string;
  label: string;
  /** Offered only when the server has this. */
  requires?: FrameworkCapability;
  /** Shown beside the choice. */
  note?: string;
}

export interface FrameworkOption {
  key: string;
  label: string;
  description?: string;
  kind: "select" | "toggle";
  /** For `select`. */
  choices?: readonly FrameworkChoice[];
  default: FrameworkOptionValue;
  /** Only when the project starts from nothing (Empty, New Repo): templates, editions, the starter. */
  emptyOnly?: boolean;
  /** A version select: the dialog may add the server's installed lines for this runtime. */
  runtime?: RuntimeId;
}

/** A command button a profile adds, the shape of `.agent/commands.json`'s entries. */
export interface FrameworkCommand {
  id: string;
  label: string;
  command: string;
  description?: string;
  icon?: string;
}

/** A file a profile writes, only when the project has none at that path. */
export interface FrameworkWrittenFile {
  path: string;
  content: string;
}

/**
 * Making a starter project. `create` runs in the project's folder with
 * `{dir}` standing for a fresh folder inside it (the starter tools refuse a
 * folder that already holds `.git`), whose contents are then moved up;
 * `write` replaces files the starter made; `after` runs in the project's
 * folder once everything is in place. Argv arrays: no shell.
 */
export interface FrameworkScaffold {
  create: string[][];
  write?: FrameworkWrittenFile[];
  after?: string[][];
}

/** Names a scaffold may use: `{dir}`, `{name}` (a package name), `{Name}` (an identifier). */
export interface ScaffoldNames {
  dir: string;
  name: string;
  Name: string;
}

export interface FrameworkProfile {
  id: FrameworkId;
  label: string;
  /** One line under the tile. */
  blurb: string;
  options: readonly FrameworkOption[];
  runtimes(o: FrameworkOptions): Partial<Record<RuntimeId, string>>;
  commands(o: FrameworkOptions): FrameworkCommand[];
  /** `.env` defaults, written only for keys the file does not have. */
  env(o: FrameworkOptions): Record<string, string>;
  /** Set on every process the project starts (terminals, buttons, agents), read from `framework.json` at spawn. */
  processEnv(o: FrameworkOptions): Record<string, string>;
  previewPort(o: FrameworkOptions): number | null;
  /** A folder the preview serves statically instead of a port. */
  previewStaticDir?(o: FrameworkOptions): string | null;
  /** At most ~600 bytes, written once into `.agent/index.md`. */
  agentHint(o: FrameworkOptions): string;
  files?(o: FrameworkOptions): FrameworkWrittenFile[];
  scaffold?(o: FrameworkOptions): FrameworkScaffold | null;
  /** A rough first-use download, for the summary. */
  downloadMb?(o: FrameworkOptions): number;
}

// --- package managers ----------------------------------------------------------

type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

const PACKAGE_MANAGERS: readonly FrameworkChoice[] = [
  { value: "pnpm", label: "pnpm" },
  { value: "npm", label: "npm" },
  { value: "yarn", label: "Yarn" },
  { value: "bun", label: "Bun" },
];

function pm(o: FrameworkOptions, key = "packageManager"): PackageManager {
  const value = o[key];
  return value === "npm" || value === "yarn" || value === "bun" ? value : "pnpm";
}

function pmRun(manager: PackageManager, script: string): string {
  return manager === "npm" ? `npm run ${script}` : manager === "bun" ? `bun run ${script}` : `${manager} ${script}`;
}

function pmExec(manager: PackageManager, bin: string): string {
  return manager === "npm" ? `npx ${bin}` : manager === "pnpm" ? `pnpm exec ${bin}` : manager === "bun" ? `bunx ${bin}` : `yarn ${bin}`;
}

/** Runs a package's `create` binary without installing it: argv. */
function pmCreate(manager: PackageManager, pkg: string): string[] {
  if (manager === "pnpm") return ["pnpm", "dlx", pkg];
  if (manager === "bun") return ["bunx", pkg];
  return ["npx", "--yes", pkg];
}

function jsRuntimes(o: FrameworkOptions): Partial<Record<RuntimeId, string>> {
  const runtime = String(o.runtime ?? "node-lts");
  if (runtime === "bun") return { bun: "latest", node: "lts" };
  return { node: runtime.replace(/^node-/, "") };
}

const JS_RUNTIME: FrameworkOption = {
  key: "runtime",
  label: "JavaScript runtime",
  kind: "select",
  runtime: "node",
  choices: [
    { value: "node-lts", label: "Node LTS" },
    { value: "node-26", label: "Node 26" },
    { value: "node-24", label: "Node 24" },
    { value: "node-22", label: "Node 22" },
    { value: "bun", label: "Bun", note: "with Node LTS beside it for tools that need it" },
  ],
  default: "node-lts",
};

const COREPACK_ENV = { COREPACK_ENABLE_DOWNLOAD_PROMPT: "0", COREPACK_ENABLE_STRICT: "0" };

// --- the profiles ----------------------------------------------------------------

const laravel: FrameworkProfile = {
  id: "laravel",
  label: "Laravel",
  blurb: "PHP, Composer, Artisan, Vite",
  options: [
    {
      key: "php",
      label: "PHP version",
      kind: "select",
      runtime: "php",
      choices: [
        { value: "latest", label: "Latest" },
        { value: "8.5", label: "8.5" },
        { value: "8.4", label: "8.4" },
        { value: "8.3", label: "8.3" },
        { value: "system", label: "The server's own", note: "has intl" },
      ],
      default: "latest",
      description: "The downloadable PHP has no intl extension; choose the server's own when composer.json needs ext-intl.",
    },
    {
      key: "composer",
      label: "Composer",
      kind: "select",
      runtime: "composer",
      choices: [
        { value: "latest", label: "2 (latest)" },
        { value: "lts", label: "2.2 LTS" },
      ],
      default: "latest",
    },
    {
      key: "node",
      label: "Node (Vite assets)",
      kind: "select",
      runtime: "node",
      choices: [
        { value: "lts", label: "LTS" },
        { value: "24", label: "24" },
        { value: "22", label: "22" },
        { value: "none", label: "None" },
      ],
      default: "lts",
    },
    {
      key: "packageManager",
      label: "JS package manager",
      kind: "select",
      choices: PACKAGE_MANAGERS.filter((c) => c.value !== "yarn"),
      default: "npm",
    },
    {
      key: "devServer",
      label: "Dev server",
      kind: "select",
      choices: [
        { value: "artisan", label: "php artisan serve" },
        { value: "frankenphp", label: "Octane (FrankenPHP)" },
        { value: "swoole", label: "Octane (Swoole)", note: "needs the server's own PHP" },
      ],
      default: "artisan",
    },
    { key: "queue", label: "Queue and scheduler buttons", kind: "toggle", default: true },
  ],
  runtimes(o) {
    const runtimes: Partial<Record<RuntimeId, string>> = { php: String(o.php), composer: String(o.composer) };
    if (o.node !== "none") runtimes.node = String(o.node);
    if (o.packageManager === "bun") runtimes.bun = "latest";
    return runtimes;
  },
  commands(o) {
    const js = pm(o);
    const octane = o.devServer === "frankenphp" || o.devServer === "swoole";
    const commands: FrameworkCommand[] = [
      {
        id: "dev",
        label: "Dev",
        icon: "play",
        command: octane
          ? `php artisan octane:start --server=${o.devServer} --host=0.0.0.0 --port=8000 --watch`
          : "php artisan serve --host=0.0.0.0 --port=8000",
        description: "Runs the app on port 8000",
      },
      { id: "install", label: "Install", icon: "package", command: "composer install" },
      { id: "migrate", label: "Migrate", icon: "database", command: "php artisan migrate" },
      { id: "test", label: "Test", icon: "flask", command: "php artisan test" },
      { id: "lint", label: "Pint", icon: "sparkles", command: "./vendor/bin/pint", description: "Formats the PHP code" },
    ];
    if (octane) {
      commands.push({
        id: "octane-install",
        label: "Install Octane",
        icon: "package",
        command: `composer require laravel/octane && php artisan octane:install --server=${o.devServer}`,
      });
    }
    if (o.node !== "none") {
      commands.push(
        { id: "assets-dev", label: "Vite", icon: "play", command: pmRun(js, "dev") },
        { id: "assets-build", label: "Build assets", icon: "hammer", command: pmRun(js, "build") },
      );
    }
    if (o.queue !== false) {
      commands.push(
        { id: "queue", label: "Queue", icon: "refresh", command: "php artisan queue:work" },
        { id: "schedule", label: "Scheduler", icon: "refresh", command: "php artisan schedule:work" },
      );
    }
    return commands;
  },
  env: () => ({ APP_ENV: "local", APP_DEBUG: "true" }),
  processEnv: () => ({ ...COREPACK_ENV }),
  previewPort: () => 8000,
  agentHint: (o) =>
    [
      "Laravel. Use `php artisan make:*` generators rather than writing classes by hand.",
      "Run `php artisan test` and `./vendor/bin/pint` before finishing.",
      "Never commit `.env`; add new keys to `.env.example`.",
      o.devServer === "artisan" ? "" : `The dev server is Octane (${o.devServer}): restart it after changing service providers.`,
    ]
      .filter(Boolean)
      .join(" "),
  scaffold: () => ({
    create: [["composer", "create-project", "laravel/laravel", "{dir}", "--prefer-dist", "--no-interaction"]],
  }),
  downloadMb: (o) => 15 + (o.node === "none" ? 0 : 30),
};

const nextjs: FrameworkProfile = {
  id: "nextjs",
  label: "Next.js",
  blurb: "React with the App Router",
  options: [
    JS_RUNTIME,
    { key: "packageManager", label: "Package manager", kind: "select", choices: PACKAGE_MANAGERS, default: "pnpm" },
    {
      key: "bundler",
      label: "Bundler",
      kind: "select",
      choices: [
        { value: "turbopack", label: "Turbopack" },
        { value: "webpack", label: "Webpack" },
      ],
      default: "turbopack",
    },
    {
      key: "typecheck",
      label: "Type checker",
      kind: "select",
      choices: [
        { value: "tsc", label: "tsc" },
        { value: "tsgo", label: "tsgo (native preview)" },
      ],
      default: "tsc",
    },
    {
      key: "lint",
      label: "Linter and formatter",
      kind: "select",
      choices: [
        { value: "eslint", label: "ESLint + Prettier" },
        { value: "biome", label: "Biome" },
      ],
      default: "eslint",
    },
    {
      key: "output",
      label: "Output",
      kind: "select",
      choices: [
        { value: "default", label: "Default" },
        { value: "standalone", label: "Standalone" },
        { value: "export", label: "Static export" },
      ],
      default: "default",
    },
  ],
  runtimes: jsRuntimes,
  commands(o) {
    const js = pm(o);
    const commands: FrameworkCommand[] = [
      {
        id: "dev",
        label: "Dev",
        icon: "play",
        command: `${pmExec(js, "next")} dev -H 0.0.0.0 -p 3000${o.bundler === "webpack" ? " --webpack" : ""}`,
      },
      { id: "install", label: "Install", icon: "package", command: `${js} install` },
      { id: "build", label: "Build", icon: "hammer", command: pmRun(js, "build") },
      { id: "start", label: "Start", icon: "rocket", command: `${pmExec(js, "next")} start -H 0.0.0.0 -p 3000` },
      {
        id: "lint",
        label: "Lint",
        icon: "sparkles",
        command: o.lint === "biome" ? pmExec(js, "biome check .") : pmExec(js, "eslint ."),
      },
      {
        id: "typecheck",
        label: "Typecheck",
        icon: "bug",
        command: pmExec(js, o.typecheck === "tsgo" ? "tsgo --noEmit" : "tsc --noEmit"),
      },
      { id: "test", label: "Test", icon: "flask", command: pmRun(js, "test"), description: "package.json's test script" },
    ];
    if (o.lint === "biome") commands.push({ id: "format", label: "Format", icon: "sparkles", command: pmExec(js, "biome format --write .") });
    else commands.push({ id: "format", label: "Format", icon: "sparkles", command: pmExec(js, "prettier --write .") });
    return commands;
  },
  env: () => ({}),
  processEnv: () => ({ NEXT_TELEMETRY_DISABLED: "1", ...COREPACK_ENV }),
  previewPort: (o) => (o.output === "export" ? null : 3000),
  previewStaticDir: (o) => (o.output === "export" ? "out" : null),
  agentHint: (o) =>
    [
      "Next.js with the App Router: components are server components unless the file starts with \"use client\";",
      "keep data fetching on the server and client components small.",
      "Run the Lint and Typecheck commands before finishing.",
      o.output === "export" ? "The site is a static export (`output: \"export\"`): no server-only features." : "",
      o.output === "standalone" ? "Builds use `output: \"standalone\"`." : "",
    ]
      .filter(Boolean)
      .join(" "),
  scaffold: (o) => {
    const js = pm(o);
    return {
      create: [
        [
          ...pmCreate(js, "create-next-app@latest"),
          "{dir}",
          "--ts",
          "--app",
          "--src-dir",
          "--yes",
          o.lint === "biome" ? "--biome" : "--eslint",
          `--use-${js}`,
        ],
      ],
    };
  },
  downloadMb: (o) => (o.runtime === "bun" ? 70 : 30),
};

const react: FrameworkProfile = {
  id: "react",
  label: "React",
  blurb: "A single-page app on Vite",
  options: [
    JS_RUNTIME,
    { key: "packageManager", label: "Package manager", kind: "select", choices: PACKAGE_MANAGERS, default: "pnpm" },
    {
      key: "buildTool",
      label: "Build tool",
      kind: "select",
      choices: [
        { value: "vite", label: "Vite" },
        { value: "rsbuild", label: "Rsbuild" },
      ],
      default: "vite",
    },
    {
      key: "jsx",
      label: "React plugin",
      kind: "select",
      choices: [
        { value: "plugin", label: "@vitejs/plugin-react" },
        { value: "compiler", label: "+ React Compiler" },
      ],
      default: "plugin",
      emptyOnly: true,
    },
    {
      key: "typecheck",
      label: "Type checker",
      kind: "select",
      choices: [
        { value: "tsc", label: "tsc" },
        { value: "tsgo", label: "tsgo (native preview)" },
      ],
      default: "tsc",
    },
    {
      key: "test",
      label: "Test runner",
      kind: "select",
      choices: [
        { value: "vitest", label: "Vitest" },
        { value: "none", label: "None" },
      ],
      default: "vitest",
    },
  ],
  runtimes: jsRuntimes,
  commands(o) {
    const js = pm(o);
    const rsbuild = o.buildTool === "rsbuild";
    const commands: FrameworkCommand[] = [
      {
        id: "dev",
        label: "Dev",
        icon: "play",
        command: rsbuild ? `${pmExec(js, "rsbuild")} dev --host 0.0.0.0 --port 5173` : `${pmExec(js, "vite")} --host 0.0.0.0 --port 5173`,
      },
      { id: "install", label: "Install", icon: "package", command: `${js} install` },
      { id: "build", label: "Build", icon: "hammer", command: pmRun(js, "build") },
      {
        id: "typecheck",
        label: "Typecheck",
        icon: "bug",
        command: pmExec(js, o.typecheck === "tsgo" ? "tsgo -b --noEmit" : "tsc -b --noEmit"),
      },
      { id: "lint", label: "Lint", icon: "sparkles", command: pmRun(js, "lint") },
    ];
    if (o.test !== "none") commands.push({ id: "test", label: "Test", icon: "flask", command: pmExec(js, "vitest run") });
    return commands;
  },
  env: () => ({}),
  processEnv: () => ({ ...COREPACK_ENV }),
  previewPort: () => 5173,
  agentHint: (o) =>
    [
      `A React single-page app built with ${o.buildTool === "rsbuild" ? "Rsbuild" : "Vite"}.`,
      "Keep components small and typed; run Typecheck",
      o.test === "none" ? "before finishing." : "and Test (Vitest, files beside the code as *.test.tsx) before finishing.",
      o.jsx === "compiler" ? "The React Compiler memoizes for you: do not add useMemo or useCallback by hand." : "",
    ]
      .filter(Boolean)
      .join(" "),
  scaffold: (o) => {
    const js = pm(o);
    // create-vite's own templates: SWC and Babel are gone since Vite 8 (Oxc).
    const template = o.jsx === "compiler" ? "react-compiler-ts" : "react-ts";
    const create =
      o.buildTool === "rsbuild"
        ? [
            ...pmCreate(js, "create-rsbuild@latest"),
            "--dir",
            "{dir}",
            "--template",
            "react-ts",
            "--package-name",
            "{name}",
            "--no-git",
            ...(o.jsx === "compiler" ? ["--tools", "react-compiler"] : []),
          ]
        : [...pmCreate(js, "create-vite@latest"), "{dir}", "--template", template, "--no-interactive"];
    const after: string[][] = [[js, "install"]];
    if (o.test !== "none") after.push([js, js === "npm" ? "install" : "add", "-D", "vitest"]);
    return { create: [create], after };
  },
  downloadMb: (o) => (o.runtime === "bun" ? 70 : 30),
};

const aspnet: FrameworkProfile = {
  id: "aspnet",
  label: "ASP.NET Core",
  blurb: "C# web APIs, MVC, Razor and Blazor",
  options: [
    {
      key: "sdk",
      label: ".NET SDK",
      kind: "select",
      runtime: "dotnet",
      choices: [
        { value: "lts", label: "LTS (10)" },
        { value: "11", label: "11 (STS)" },
        { value: "10", label: "10" },
        { value: "system", label: "The server's own", note: "follows global.json" },
      ],
      default: "lts",
    },
    {
      key: "template",
      label: "Template",
      kind: "select",
      choices: [
        { value: "webapi", label: "Web API" },
        { value: "mvc", label: "MVC" },
        { value: "razor", label: "Razor Pages" },
        { value: "blazor", label: "Blazor" },
        { value: "worker", label: "Worker service" },
      ],
      default: "webapi",
      emptyOnly: true,
    },
    {
      key: "devLoop",
      label: "Dev loop",
      kind: "select",
      choices: [
        { value: "watch", label: "dotnet watch (hot reload)" },
        { value: "run", label: "dotnet run" },
      ],
      default: "watch",
    },
    {
      key: "configuration",
      label: "Build configuration",
      kind: "select",
      choices: [
        { value: "Debug", label: "Debug" },
        { value: "Release", label: "Release" },
      ],
      default: "Debug",
    },
    {
      key: "publish",
      label: "Publish mode",
      kind: "select",
      choices: [
        { value: "framework", label: "Framework-dependent" },
        { value: "self-contained", label: "Self-contained" },
        { value: "aot", label: "Native AOT", requires: "clang" },
      ],
      default: "framework",
    },
    {
      key: "globalization",
      label: "Globalization",
      kind: "select",
      choices: [
        { value: "icu", label: "ICU" },
        { value: "invariant", label: "Invariant" },
      ],
      default: "icu",
    },
  ],
  runtimes: (o) => (o.sdk === "system" ? {} : { dotnet: String(o.sdk) }),
  commands(o) {
    const config = o.configuration === "Release" ? "Release" : "Debug";
    const publish =
      o.publish === "aot"
        ? "dotnet publish -c Release -p:PublishAot=true"
        : o.publish === "self-contained"
          ? "dotnet publish -c Release --self-contained"
          : "dotnet publish -c Release";
    return [
      {
        id: "dev",
        label: "Dev",
        icon: "play",
        command: o.devLoop === "run" ? `dotnet run --no-launch-profile -c ${config}` : "dotnet watch run --no-launch-profile",
        description: "Runs the app on port 5000",
      },
      { id: "build", label: "Build", icon: "hammer", command: `dotnet build -c ${config}` },
      { id: "test", label: "Test", icon: "flask", command: "dotnet test" },
      { id: "format", label: "Format", icon: "sparkles", command: "dotnet format" },
      { id: "publish", label: "Publish", icon: "rocket", command: publish },
    ];
  },
  env: () => ({}),
  processEnv: (o) => ({
    ASPNETCORE_ENVIRONMENT: "Development",
    ASPNETCORE_URLS: "http://0.0.0.0:5000",
    DOTNET_CLI_TELEMETRY_OPTOUT: "1",
    DOTNET_NOLOGO: "1",
    ...(o.globalization === "invariant" ? { DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: "1" } : {}),
  }),
  previewPort: (o) => (o.template === "worker" ? null : 5000),
  agentHint: (o) =>
    [
      "ASP.NET Core. Use `dotnet add package` for dependencies and `dotnet new` item templates for new files.",
      "Run `dotnet build` and `dotnet test` before finishing; `dotnet format` keeps the style.",
      "The app listens on ASPNETCORE_URLS (port 5000); run it with --no-launch-profile so launchSettings.json does not change that.",
      o.publish === "aot" ? "Publishing is Native AOT: avoid reflection-heavy code." : "",
    ]
      .filter(Boolean)
      .join(" "),
  scaffold: (o) => ({
    create: [["dotnet", "new", String(o.template ?? "webapi"), "-o", "{dir}", "-n", "{Name}", "--no-restore"]],
  }),
  downloadMb: () => 220,
};

const rust: FrameworkProfile = {
  id: "rust",
  label: "Rust",
  blurb: "Cargo, with Axum or Actix for the web",
  options: [
    {
      key: "toolchain",
      label: "Toolchain",
      kind: "select",
      runtime: "rust",
      choices: [
        { value: "stable", label: "Stable" },
        { value: "beta", label: "Beta" },
        { value: "nightly", label: "Nightly" },
      ],
      default: "stable",
      description: "A rust-toolchain.toml in the repository wins.",
    },
    {
      key: "components",
      label: "Components",
      kind: "select",
      choices: [
        { value: "default", label: "clippy + rustfmt" },
        { value: "analyzer", label: "+ rust-analyzer and rust-src" },
      ],
      default: "default",
    },
    {
      key: "edition",
      label: "Edition",
      kind: "select",
      choices: [
        { value: "2024", label: "2024" },
        { value: "2021", label: "2021" },
      ],
      default: "2024",
      emptyOnly: true,
    },
    {
      key: "template",
      label: "Template",
      kind: "select",
      choices: [
        { value: "bin", label: "Binary" },
        { value: "axum", label: "Axum web server" },
        { value: "actix", label: "Actix web server" },
        { value: "lib", label: "Library" },
      ],
      default: "bin",
      emptyOnly: true,
    },
    {
      key: "linker",
      label: "Linker",
      kind: "select",
      choices: [
        { value: "cc", label: "System cc" },
        { value: "mold", label: "mold", requires: "mold" },
        { value: "lld", label: "lld", requires: "lld" },
      ],
      default: "cc",
    },
    { key: "sccache", label: "Compile cache (sccache)", kind: "toggle", default: false },
    {
      key: "profile",
      label: "Dev build profile",
      kind: "select",
      choices: [
        { value: "dev", label: "dev" },
        { value: "release", label: "release" },
      ],
      default: "dev",
    },
    {
      key: "watch",
      label: "Watch",
      kind: "select",
      choices: [
        { value: "cargo-watch", label: "cargo watch" },
        { value: "bacon", label: "bacon" },
        { value: "none", label: "None" },
      ],
      default: "cargo-watch",
    },
    {
      key: "target",
      label: "Extra target",
      kind: "select",
      choices: [
        { value: "none", label: "None" },
        { value: "wasm32-unknown-unknown", label: "wasm32-unknown-unknown" },
      ],
      default: "none",
    },
  ],
  runtimes: (o) => ({ rust: String(o.toolchain) }),
  commands(o) {
    const release = o.profile === "release" ? " --release" : "";
    const run = `cargo run${release}`;
    const dev =
      o.template === "lib"
        ? "cargo test"
        : o.watch === "cargo-watch"
          ? `(command -v cargo-watch >/dev/null || cargo install --locked cargo-watch) && cargo watch -x 'run${release}'`
          : o.watch === "bacon"
            ? "(command -v bacon >/dev/null || cargo install --locked bacon) && bacon run"
            : run;
    const commands: FrameworkCommand[] = [
      { id: "dev", label: "Dev", icon: "play", command: dev },
      { id: "build", label: "Build", icon: "hammer", command: `cargo build${release}` },
      { id: "test", label: "Test", icon: "flask", command: "cargo test" },
      { id: "lint", label: "Clippy", icon: "bug", command: "cargo clippy -- -D warnings" },
      { id: "format", label: "Format", icon: "sparkles", command: "cargo fmt" },
    ];
    const extras = [
      ...(o.components === "analyzer" ? ["rustup component add rust-analyzer rust-src"] : []),
      ...(o.target !== "none" && o.target ? [`rustup target add ${o.target}`] : []),
    ];
    if (extras.length) commands.push({ id: "toolchain-setup", label: "Toolchain extras", icon: "package", command: extras.join(" && ") });
    return commands;
  },
  env: () => ({}),
  processEnv: (o) => ({
    CARGO_TERM_COLOR: "always",
    RUST_BACKTRACE: "1",
    ...(o.sccache === true ? { RUSTC_WRAPPER: "sccache" } : {}),
  }),
  previewPort: (o) => (o.template === "axum" || o.template === "actix" ? 3000 : null),
  agentHint: (o) =>
    [
      "Rust with Cargo. Add dependencies with `cargo add`, not by editing Cargo.toml versions by hand.",
      "Run `cargo clippy -- -D warnings`, `cargo fmt` and `cargo test` before finishing.",
      o.template === "axum" || o.template === "actix" ? "The server listens on 0.0.0.0:3000." : "",
      o.toolchain === "nightly" ? "The toolchain is nightly: feature gates are allowed but keep them few." : "",
    ]
      .filter(Boolean)
      .join(" "),
  files(o) {
    // `cargo init --vcs none` writes no ignore file, and `target/` is gigabytes.
    const files: FrameworkWrittenFile[] = [{ path: ".gitignore", content: "/target\n" }];
    if (o.linker === "mold" || o.linker === "lld") {
      files.push({
        path: ".cargo/config.toml",
        content: `# Written by UltraChillCodingHarness (Rust profile: ${o.linker} linker).\n[target.'cfg(target_os = "linux")']\nrustflags = ["-C", "link-arg=-fuse-ld=${o.linker}"]\n`,
      });
    }
    return files;
  },
  scaffold(o) {
    const lib = o.template === "lib";
    const create = [["cargo", "init", "{dir}", "--vcs", "none", "--name", "{name}", "--edition", String(o.edition ?? "2024"), ...(lib ? ["--lib"] : [])]];
    if (o.template === "axum") {
      return {
        create,
        after: [
          ["cargo", "add", "axum"],
          ["cargo", "add", "tokio", "-F", "full"],
        ],
        write: [
          {
            path: "src/main.rs",
            content: `use axum::{routing::get, Router};\n\n#[tokio::main]\nasync fn main() {\n    let app = Router::new().route("/", get(|| async { "Hello from Axum" }));\n    let listener = tokio::net::TcpListener::bind("0.0.0.0:3000").await.unwrap();\n    axum::serve(listener, app).await.unwrap();\n}\n`,
          },
        ],
      };
    }
    if (o.template === "actix") {
      return {
        create,
        after: [["cargo", "add", "actix-web"]],
        write: [
          {
            path: "src/main.rs",
            content: `use actix_web::{get, App, HttpServer, Responder};\n\n#[get("/")]\nasync fn index() -> impl Responder {\n    "Hello from Actix"\n}\n\n#[actix_web::main]\nasync fn main() -> std::io::Result<()> {\n    HttpServer::new(|| App::new().service(index)).bind(("0.0.0.0", 3000))?.run().await\n}\n`,
          },
        ],
      };
    }
    return { create };
  },
  downloadMb: (o) => (o.toolchain === "nightly" ? 300 : 260),
};

export const FRAMEWORK_PROFILES: Record<FrameworkId, FrameworkProfile> = { laravel, nextjs, react, aspnet, rust };

// --- choices -----------------------------------------------------------------------

/** Every option at its default, with `given` laid over what it validly sets. */
export function resolveFrameworkOptions(
  id: FrameworkId,
  given: Record<string, unknown> = {},
): { options: FrameworkOptions; errors: string[] } {
  const profile = FRAMEWORK_PROFILES[id];
  const options: FrameworkOptions = {};
  const errors: string[] = [];
  for (const option of profile.options) {
    const value = given[option.key];
    if (value === undefined) {
      options[option.key] = option.default;
      continue;
    }
    const error = optionError(option, value);
    if (error) {
      errors.push(error);
      options[option.key] = option.default;
    } else options[option.key] = value as FrameworkOptionValue;
  }
  return { options, errors };
}

/**
 * Why a value does not fit an option, or null. A version select also takes
 * any runtime selection (`8.4`, `22`, `1.85.0`), so a line the server offers
 * beyond the listed ones is accepted.
 */
function optionError(option: FrameworkOption, value: unknown): string | null {
  if (option.kind === "toggle") return typeof value === "boolean" ? null : `${option.label}: on or off`;
  if (typeof value !== "string") return `${option.label}: not a choice`;
  if (option.choices?.some((c) => c.value === value)) return null;
  if (option.runtime && /^(latest|system|lts|stable|beta|nightly|\d{1,3}(\.\d{1,3}(\.\d{1,3})?)?)$/.test(value)) return null;
  return `${option.label}: ${value.slice(0, 40)} is not one of its choices`;
}

/** Why a chosen framework and its options cannot be used, or null. Unknown keys are refused. */
export function frameworkChoiceError(id: unknown, given: Record<string, unknown>): string | null {
  if (!isFrameworkId(id)) return `${String(id).slice(0, 40)} is not a framework`;
  const known = new Set(FRAMEWORK_PROFILES[id].options.map((o) => o.key));
  const unknown = Object.keys(given).find((key) => !known.has(key));
  if (unknown) return `${FRAMEWORK_LABELS[id]} has no option ${unknown.slice(0, 40)}`;
  return resolveFrameworkOptions(id, given).errors[0] ?? null;
}

/** What a choice sets up, for the dialog's summary and the server alike. */
export interface FrameworkPlan {
  runtimes: Partial<Record<RuntimeId, string>>;
  commands: FrameworkCommand[];
  env: Record<string, string>;
  processEnv: Record<string, string>;
  previewPort: number | null;
  previewStaticDir: string | null;
  agentHint: string;
  files: FrameworkWrittenFile[];
  downloadMb: number;
}

export function planFramework(id: FrameworkId, given: Record<string, unknown> = {}): FrameworkPlan {
  const profile = FRAMEWORK_PROFILES[id];
  const { options } = resolveFrameworkOptions(id, given);
  return {
    runtimes: profile.runtimes(options),
    commands: profile.commands(options),
    env: profile.env(options),
    processEnv: profile.processEnv(options),
    previewPort: profile.previewPort(options),
    previewStaticDir: profile.previewStaticDir?.(options) ?? null,
    agentHint: profile.agentHint(options),
    files: profile.files?.(options) ?? [],
    downloadMb: profile.downloadMb?.(options) ?? 0,
  };
}

/** The starter's names for a project called `projectName`. */
export function scaffoldNames(projectName: string): ScaffoldNames {
  const words = projectName
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const name = (words.join("-").toLowerCase() || "app").replace(/^[^a-z]+/, "") || "app";
  const Name = words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join("").replace(/^[^A-Za-z]+/, "") || "App";
  return { dir: `${name.slice(0, 50)}-starter`, name: name.slice(0, 50), Name: Name.slice(0, 50) };
}

/** `{dir}`, `{name}` and `{Name}` in a scaffold's argv, filled in. */
export function fillScaffold(argv: readonly string[], names: ScaffoldNames): string[] {
  return argv.map((arg) => arg.replaceAll("{dir}", names.dir).replaceAll("{name}", names.name).replaceAll("{Name}", names.Name));
}

/** A one-line summary: "PHP latest · Node lts · 9 command buttons · preview on :8000". */
export function frameworkSummary(plan: FrameworkPlan, labels: Partial<Record<RuntimeId, string>>): string[] {
  const parts: string[] = [];
  for (const [id, selection] of Object.entries(plan.runtimes)) {
    parts.push(`${labels[id as RuntimeId] ?? id} ${selection === "latest" ? "latest" : selection === "lts" ? "LTS" : selection}`);
  }
  parts.push(`${plan.commands.length} command button${plan.commands.length === 1 ? "" : "s"}`);
  if (plan.previewPort) parts.push(`preview on :${plan.previewPort}`);
  else if (plan.previewStaticDir) parts.push(`preview of ${plan.previewStaticDir}/`);
  if (plan.downloadMb) parts.push(`about ${plan.downloadMb} MB to download on first use`);
  return parts;
}

// --- what the API answers ------------------------------------------------------------

/** `GET /api/frameworks`: what this server can do for the dialog. */
export interface FrameworksResponse {
  /** Whether starters may be made (`FRAMEWORK_SCAFFOLD`). */
  scaffold: boolean;
  /** Which optional tools the server has: a choice that needs a missing one is greyed out. */
  tools: Record<Exclude<FrameworkCapability, "scaffold">, boolean>;
  /** Runtimes the server can install. */
  runtimes: RuntimeId[];
  /** Selections a version option may add beyond its fixed choices, newest first: `8.4`, `24`, `10`. */
  lines: Partial<Record<RuntimeId, string[]>>;
}

/** `GET /api/projects/:hash/framework`. */
export interface ProjectFrameworkResponse {
  framework: FrameworkId | null;
  options: FrameworkOptions;
  dismissed: boolean;
  /** Runtime requirements the repository stated, by runtime. */
  overrides: Record<string, string>;
  /** Why framework.json could not be used. */
  error: string | null;
  /** A profile the detected stack matches, offered while there is no framework.json (plan3 §3.7). */
  suggested: FrameworkId | null;
  stack: string;
  /** Whether the viewer may change it. */
  canChange: boolean;
}

/** Whether a choice can be had on a server with these capabilities. */
export function choiceAvailable(choice: FrameworkChoice, server: Pick<FrameworksResponse, "tools" | "scaffold"> | null): boolean {
  if (!choice.requires || !server) return true;
  return choice.requires === "scaffold" ? server.scaffold : server.tools[choice.requires];
}
