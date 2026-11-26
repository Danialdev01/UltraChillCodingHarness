import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { planFramework } from "@ucch/protocol";

import { writeEnvDefaults } from "./dev-database.js";
import {
  applyProfile,
  dismissFramework,
  frameworkProcessEnv,
  frameworkSection,
  frameworkWarning,
  readFrameworkFile,
  scaffoldProject,
} from "./framework-profile.js";
import { readCommands, writeCommands } from "./project-commands.js";
import { RuntimeManager, readSelections, writeSelections } from "./runtimes/manager.js";
import type { RuntimeProvider } from "./runtimes/types.js";

const PROJECT = "11111111-2222-3333-4444-555555555555";
let dir: string;
let root: string;

function provider(id: RuntimeProvider["id"], constraint: (root: string) => string | null = () => null): RuntimeProvider {
  return {
    id,
    binaries: [id],
    async listAvailable() {
      return [];
    },
    async install() {},
    async versionOf() {
      return null;
    },
    constraintOf: constraint,
    selectionFor: (c) => (/^\d+(\.\d+)*$|^(nightly|beta|stable)$/.test(c) ? c : null),
  };
}

function runtimes() {
  return new RuntimeManager({
    root: join(dir, "runtimes"),
    workspaceRoot: join(dir, "ws"),
    autoInstall: false,
    providers: {
      php: provider("php", (r) => (existsSync(join(r, "composer.json")) ? "^8.2" : null)),
      composer: provider("composer"),
      node: provider("node"),
      rust: provider("rust", (r) => (existsSync(join(r, "rust-toolchain.toml")) ? "nightly" : null)),
    },
  });
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "ucch-fw-")));
  root = join(dir, "ws", PROJECT);
  mkdirSync(join(root, ".agent"), { recursive: true });
  writeFileSync(join(root, ".agent", "index.md"), "# p\n\n## About\n\nx\n");
});

describe("applyProfile (plan3 §3.1)", () => {
  it("adds what is missing and leaves what people wrote", async () => {
    await writeSelections(root, { php: "8.3" });
    await writeCommands(root, [{ id: "test", label: "My tests", command: "make test" }]);
    writeFileSync(join(root, ".env"), "APP_ENV=production\nDATABASE_URL=x\n");

    const result = await applyProfile(root, "laravel", { queue: false }, { runtimes: runtimes() });

    expect(readSelections(root).selections).toEqual({ php: "8.3", composer: "latest", node: "lts" });
    const commands = readCommands(root).commands;
    expect(commands.find((c) => c.id === "test")).toEqual({ id: "test", label: "My tests", command: "make test" });
    expect(commands.map((c) => c.id)).toEqual(["test", "dev", "install", "migrate", "lint", "assets-dev", "assets-build"]);
    // `.env`: APP_ENV kept as written; APP_DEBUG added.
    expect(readFileSync(join(root, ".env"), "utf8")).toBe("APP_ENV=production\nDATABASE_URL=x\nAPP_DEBUG=true\n");
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toContain(".env");
    expect(result.file).toMatchObject({ framework: "laravel", options: { queue: false, php: "latest" } });
    expect(Object.keys(result.file.commands ?? {})).not.toContain("test");
    expect(readFileSync(join(root, ".agent", "index.md"), "utf8")).toContain("## Framework");

    // Twice is once.
    await applyProfile(root, "laravel", { queue: false }, { runtimes: runtimes() });
    expect(readCommands(root).commands).toHaveLength(7);
    expect(readFileSync(join(root, ".agent", "index.md"), "utf8").match(/## Framework/g)).toHaveLength(1);
  });

  it("lets the repository's own requirement win, and records it", async () => {
    writeFileSync(join(root, "rust-toolchain.toml"), '[toolchain]\nchannel = "nightly"\n');
    const { file } = await applyProfile(root, "rust", {}, { runtimes: runtimes() });
    expect(readSelections(root).selections.rust).toBe("nightly");
    expect(file.overrides).toEqual({ rust: "nightly (from rust-toolchain.toml)" });

    writeFileSync(join(root, "composer.json"), "{}");
    const laravel = await applyProfile(root, "laravel", {}, { runtimes: runtimes() });
    // A range is recorded; the profile's selection stays (latest meets ^8.2).
    expect(laravel.file.overrides?.php).toBe("^8.2 (from composer.json)");
    expect(readSelections(root).selections.php).toBe("latest");
  });

  it("on a change, replaces the old profile's unedited buttons and selections, and keeps edited ones (plan3 §3.6)", async () => {
    await applyProfile(root, "rust", { watch: "none" }, { runtimes: runtimes() });
    const edited = readCommands(root).commands.map((c) => (c.id === "lint" ? { ...c, command: "cargo clippy" } : c));
    await writeCommands(root, edited);

    await applyProfile(root, "rust", { watch: "bacon", toolchain: "nightly", components: "analyzer" }, { runtimes: runtimes() });
    const commands = readCommands(root).commands;
    expect(commands.find((c) => c.id === "dev")?.command).toContain("bacon run");
    expect(commands.find((c) => c.id === "lint")?.command).toBe("cargo clippy");
    expect(commands.find((c) => c.id === "toolchain-setup")?.command).toContain("rust-analyzer");
    expect(readSelections(root).selections.rust).toBe("nightly");

    // To another framework: the Rust buttons nobody touched go, the edited one stays.
    await applyProfile(root, "nextjs", {}, { runtimes: runtimes() });
    const ids = readCommands(root).commands.map((c) => c.id);
    expect(ids).toContain("lint");
    expect(ids).not.toContain("toolchain-setup");
    expect(readCommands(root).commands.find((c) => c.id === "dev")?.command).toContain("next dev");
  });

  it("writes a framework's own config only when absent", async () => {
    mkdirSync(join(root, ".cargo"));
    writeFileSync(join(root, ".cargo", "config.toml"), "# mine\n");
    await applyProfile(root, "rust", { linker: "mold" }, { runtimes: runtimes() });
    expect(readFileSync(join(root, ".cargo", "config.toml"), "utf8")).toBe("# mine\n");
  });
});

describe("framework.json", () => {
  it("is refused through a symlink, and drives the process environment", async () => {
    await applyProfile(root, "aspnet", { globalization: "invariant" }, { runtimes: runtimes() });
    expect(frameworkProcessEnv(root)).toMatchObject({ ASPNETCORE_URLS: "http://0.0.0.0:5000", DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: "1" });

    const other = join(dir, "other");
    mkdirSync(join(other, ".agent"), { recursive: true });
    writeFileSync(join(dir, "elsewhere.json"), JSON.stringify({ framework: "rust", options: {} }));
    symlinkSync(join(dir, "elsewhere.json"), join(other, ".agent", "framework.json"));
    expect(readFrameworkFile(other)).toEqual({ file: null, error: "framework.json is a symlink; it is not read" });
    expect(frameworkProcessEnv(other)).toEqual({});
  });

  it("records a dismissal, which a chosen framework is not replaced by", async () => {
    await dismissFramework(root);
    expect(readFrameworkFile(root).file).toMatchObject({ framework: null, dismissed: true });
    await applyProfile(root, "react", {}, { runtimes: runtimes() });
    await dismissFramework(root);
    expect(readFrameworkFile(root).file?.framework).toBe("react");
  });
});

describe("the context section (plan3 §3.5)", () => {
  it("names the runtimes, commands and hint, within its budget", () => {
    for (const id of ["laravel", "nextjs", "react", "aspnet", "rust"] as const) {
      const plan = planFramework(id);
      const section = frameworkSection({ framework: id, options: {} }, plan, plan.runtimes);
      expect(section).toContain("## Framework");
      expect(new TextEncoder().encode(section).length).toBeLessThanOrEqual(1100);
    }
  });
});

describe("writeEnvDefaults", () => {
  it("adds only absent keys, quoting what needs it, and refuses a symlink", async () => {
    writeFileSync(join(root, ".env"), "export A=1");
    expect(await writeEnvDefaults(root, { A: "2", B: "two words", "bad-name": "x" })).toEqual(["B"]);
    expect(readFileSync(join(root, ".env"), "utf8")).toBe('export A=1\nB="two words"\n');
    const linked = join(dir, "linked");
    mkdirSync(linked);
    symlinkSync(join(root, ".env"), join(linked, ".env"));
    await expect(writeEnvDefaults(linked, { C: "3" })).rejects.toThrow(/symlink/);
  });
});

describe("scaffoldProject (plan3 §3.2)", () => {
  it("runs the starter in a fresh folder and moves it up, never over a file there, merging .gitignore", async () => {
    // A stand-in `cargo` on the project's PATH: `cargo init <dir> …` makes a crate.
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "cargo"),
      '#!/bin/sh\nif [ "$1" = init ]; then mkdir -p "$2/src" && printf "[package]\\nname = \\"x\\"\\n" > "$2/Cargo.toml" && echo "fn main() {}" > "$2/src/main.rs" && printf "/target\\n.env\\n" > "$2/.gitignore" && printf "APP_ENV=production\\nAPP_KEY=base64:k\\n" > "$2/.env" && echo "starter" > "$2/README.md"; fi\nif [ "$1" = add ]; then echo "$2" >> deps.txt; fi\n',
    );
    chmodSync(join(bin, "cargo"), 0o755);
    writeFileSync(join(root, "README.md"), "# p\n");
    writeFileSync(join(root, ".gitignore"), ".env\n");
    writeFileSync(join(root, ".env"), "APP_ENV=local\n");
    writeFileSync(join(root, "keep.txt"), "mine");

    await scaffoldProject(root, "rust", { template: "axum" }, "My App", { path: bin, env: {} });

    expect(readFileSync(join(root, "Cargo.toml"), "utf8")).toContain("[package]");
    expect(readFileSync(join(root, "src", "main.rs"), "utf8")).toContain("axum::serve");
    expect(readFileSync(join(root, "README.md"), "utf8")).toBe("starter\n");
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe(".env\n/target\n");
    expect(readFileSync(join(root, "keep.txt"), "utf8")).toBe("mine");
    // `.env`: ours stays, the starter's new keys (Laravel's APP_KEY) join it.
    expect(readFileSync(join(root, ".env"), "utf8")).toBe("APP_ENV=local\nAPP_KEY=base64:k\n");
    expect(readFileSync(join(root, "deps.txt"), "utf8")).toBe("axum\ntokio\n");
    expect(existsSync(join(root, "my-app-starter"))).toBe(false);
  });

  it("reports the step that failed, and leaves no half-made folder", async () => {
    const bin = join(dir, "bin2");
    mkdirSync(bin);
    writeFileSync(join(bin, "cargo"), "#!/bin/sh\necho 'error: registry unreachable' >&2\nexit 101\n");
    chmodSync(join(bin, "cargo"), 0o755);
    await expect(scaffoldProject(root, "rust", {}, "x", { path: bin, env: {} })).rejects.toThrow(/cargo init .*exit 101.*registry unreachable/);
    expect(existsSync(join(root, "x-starter"))).toBe(false);
  });
});

describe("frameworkWarning", () => {
  it("names what the repository looks like", () => {
    expect(frameworkWarning("nextjs", "laravel")).toBe("The repository looks like Laravel, not Next.js.");
    expect(frameworkWarning("aspnet", "dotnet")).toBeUndefined();
    expect(frameworkWarning("rust", "unknown")).toBeUndefined();
  });
});
