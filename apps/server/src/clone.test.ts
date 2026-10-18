import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { projects, type Transaction } from "@ucch/db";
import type { Command, DomainEvent } from "@ucch/protocol";
import {
  CREDENTIAL_HELPER,
  CloneReactor,
  detectStack,
  ensureWorkspaceRoot,
  listRemoteBranches,
  parseRemoteRefs,
  type CloneOptions,
} from "./clone.js";
import { applyProjection } from "./engine.js";

const run = promisify(execFile);

const PROJECT = "33333333-3333-3333-3333-333333333333";
const WORKSPACE = "77777777-7777-7777-7777-777777777777";

let scratch: string;
/** A real repository, on disk, with one commit on `main`. */
let origin: string;
let originSha: string;

/** Identity and branch on the command line: the reactor pins away the config. */
const GIT_ID = [
  "-c",
  "user.name=Test",
  "-c",
  "user.email=test@example.com",
  "-c",
  "commit.gpgsign=false",
];

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "ucch-clone-"));
  origin = join(scratch, "origin");

  await run("git", ["init", "-b", "main", origin]);
  await writeFile(join(origin, "package.json"), '{"name":"fixture"}\n');
  await writeFile(join(origin, "next.config.js"), "export default {};\n");
  await writeFile(join(origin, "README.md"), "# fixture\n");
  await run("git", ["-C", origin, ...GIT_ID, "add", "."]);
  await run("git", ["-C", origin, ...GIT_ID, "commit", "-m", "init"]);

  const { stdout } = await run("git", ["-C", origin, "rev-parse", "HEAD"]);
  originSha = stdout.trim();
}, 60_000);

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/** The event a `project.create` command produces, pointing at the fixture. */
function created(overrides: Partial<Extract<DomainEvent, { type: "project.created" }>> = {}) {
  return {
    type: "project.created",
    projectId: PROJECT,
    workspaceId: WORKSPACE,
    hash: "abcdef123456",
    name: "fixture",
    // `file://` rather than a bare path: git only honours `--depth` over a
    // transport, and a local-path clone would hardlink instead.
    repoUrl: `file://${origin}`,
    defaultBranch: "main",
    ...overrides,
  } as Extract<DomainEvent, { type: "project.created" }>;
}

function reactor(root: string, event = created(), options: Partial<CloneOptions> = {}) {
  const emitted: Extract<DomainEvent, { type: "project.cloned" }>[] = [];
  const errors: unknown[] = [];
  const clones = new CloneReactor(
    async (e) => {
      emitted.push(e);
    },
    { workspaceRoot: root, timeoutMs: 60_000, ...options },
    (error) => errors.push(error),
  );
  clones.react({ type: "project.create", workspaceId: WORKSPACE, repoUrl: event.repoUrl } as Command, [
    event,
  ]);
  return { clones, emitted, errors };
}

describe("CloneReactor", () => {
  it("leaves a real working tree on disk and reports what it found", async () => {
    const root = join(scratch, "run-1");
    const { clones, emitted, errors } = reactor(root);
    await clones.drain();

    expect(errors).toEqual([]);

    // The files are actually there -- the whole point of the stage.
    const dest = join(root, PROJECT);
    expect(await readFile(join(dest, "README.md"), "utf8")).toBe("# fixture\n");

    expect(emitted).toEqual([
      { type: "project.cloned", projectId: PROJECT, headSha: originSha, stack: "nextjs" },
    ]);

    // Shallow, as asked for: one commit, not the origin's history.
    const { stdout } = await run("git", ["-C", dest, "rev-list", "--count", "HEAD"]);
    expect(stdout.trim()).toBe("1");
  }, 60_000);

  it("falls back to the remote's default branch when the named one is absent", async () => {
    // A branch the repository does not have: the commonest
    // way a clone fails (`main` asked for, `master` on the remote), and one a
    // working tree should survive.
    const root = join(scratch, "run-2");
    const { clones, emitted, errors } = reactor(root, created({ defaultBranch: "release" }));
    await clones.drain();

    expect(errors).toEqual([]);
    expect(emitted).toMatchObject([{ type: "project.cloned", headSha: originSha }]);
  }, 60_000);

  it("is idempotent: a redelivered event does not fail on the existing tree", async () => {
    const root = join(scratch, "run-3");
    const first = reactor(root);
    await first.clones.drain();

    const second = reactor(root);
    await second.clones.drain();

    expect(second.errors).toEqual([]);
    expect(second.emitted).toEqual(first.emitted);
  }, 60_000);

  it("refuses a URL git would run as a command", async () => {
    // `ext::` parses as a URL and executes as a shell. It never reaches git.
    const root = join(scratch, "run-4");
    const { clones, emitted, errors } = reactor(root, created({ repoUrl: "ext::sh -c whoami" }));
    await clones.drain();

    expect(emitted).toEqual([]);
    expect(String(errors[0])).toContain("unsupported repository transport");
  }, 60_000);

  it("reports a repository that is not there rather than hanging on a prompt", async () => {
    const root = join(scratch, "run-5");
    const { clones, emitted, errors } = reactor(
      root,
      created({ repoUrl: `file://${join(scratch, "nothing-here")}` }),
    );
    await clones.drain();

    expect(emitted).toEqual([]);
    expect(String(errors[0])).toContain("could not clone");
  }, 60_000);
});

describe("detectStack", () => {
  const cases: [string, string[]][] = [
    ["laravel", ["artisan", "composer.json", "package.json"]],
    ["nextjs", ["next.config.mjs", "package.json"]],
    ["vite", ["vite.config.ts", "package.json"]],
    ["node", ["package.json"]],
    ["php", ["index.php"]],
    ["static", ["index.html"]],
    ["nuxt", ["nuxt.config.ts", "package.json"]],
    ["astro", ["astro.config.mjs", "package.json"]],
    ["svelte", ["svelte.config.js", "vite.config.ts", "package.json"]],
    ["angular", ["angular.json", "package.json"]],
    ["deno", ["deno.json"]],
    ["bun", ["bun.lockb", "package.json"]],
    ["django", ["manage.py", "requirements.txt"]],
    ["python", ["pyproject.toml"]],
    ["rust", ["Cargo.toml"]],
    ["go", ["go.mod"]],
    ["ruby", ["Gemfile"]],
    ["java", ["pom.xml"]],
    ["dart", ["pubspec.yaml"]],
    ["elixir", ["mix.exs"]],
    ["swift", ["Package.swift"]],
    ["dotnet", ["App.csproj"]],
  ];

  it.each(cases)("detects %s", async (expected, files) => {
    const dir = await mkdtemp(join(scratch, `stack-${expected}-`));
    for (const file of files) await writeFile(join(dir, file), "");
    expect(await detectStack(dir)).toBe(expected);
  });

  it.each([
    ["react", { dependencies: { react: "^19.0.0" } }],
    ["vue", { devDependencies: { vue: "^3.5.0" } }],
  ] as const)("reads package.json for %s", async (expected, pkg) => {
    const dir = await mkdtemp(join(scratch, `stack-${expected}-`));
    await writeFile(join(dir, "package.json"), JSON.stringify(pkg));
    await writeFile(join(dir, "vite.config.ts"), "");
    expect(await detectStack(dir)).toBe(expected);
  });

  it("tells rails from plain ruby by its application config", async () => {
    const dir = await mkdtemp(join(scratch, "stack-rails-"));
    await writeFile(join(dir, "Gemfile"), "");
    await mkdir(join(dir, "config"));
    await writeFile(join(dir, "config", "application.rb"), "");
    expect(await detectStack(dir)).toBe("rails");
  });

  it("reports unknown for a directory that is not there", async () => {
    expect(await detectStack(join(scratch, "absent"))).toBe("unknown");
  });
});

describe("ensureWorkspaceRoot", () => {
  it("creates the root when it is absent", async () => {
    const root = join(scratch, "made", "up", "path");
    await ensureWorkspaceRoot(root);
    // Idempotent: a second boot must not fail on the directory it made.
    await expect(ensureWorkspaceRoot(root)).resolves.toBeUndefined();
  });

  it("fails loudly when the root cannot be created", async () => {
    // A path whose parent is a file, not a directory.
    const file = join(scratch, "a-file");
    await writeFile(file, "");
    await expect(ensureWorkspaceRoot(join(file, "under"))).rejects.toThrow(/could not be created/);
  });
});

describe("the project.cloned projection", () => {
  it("writes the detected stack onto the project row", async () => {
    const statements: { table: string; values: Record<string, unknown> }[] = [];
    const settled = () => Promise.resolve([]);
    const tx = {
      update: (table: unknown) => ({
        set: (values: Record<string, unknown>) => ({
          where: () => {
            statements.push({ table: table === projects ? "projects" : "other", values });
            return settled();
          },
        }),
      }),
    } as unknown as Transaction;

    await applyProjection(
      tx,
      [{ type: "project.cloned", projectId: PROJECT, headSha: originSha, stack: "nextjs" }],
      null,
    );

    expect(statements).toHaveLength(1);
    expect(statements[0]!.table).toBe("projects");
    expect(statements[0]!.values).toMatchObject({ stack: "nextjs" });
  });
});

describe("parseRemoteRefs", () => {
  it("reads the default branch from the symref line and the heads from the rest", () => {
    // Exactly what `git ls-remote --symref --heads` prints, tabs and all.
    const stdout = [
      "ref: refs/heads/main\tHEAD",
      "9fceb02d0ae598e95dc970b74767f19372d61af8\trefs/heads/main",
      "8cb5db1a1b1bd53a2f1e2d1e3f5c8a9d0e1f2a3b\trefs/heads/develop",
      "7a1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c\trefs/heads/release/2.0",
      "",
    ].join("\n");

    expect(parseRemoteRefs(stdout)).toEqual({
      defaultBranch: "main",
      branches: ["main", "develop", "release/2.0"],
    });
  });

  it("falls back to the first head when the remote names no HEAD", () => {
    const stdout = "9fceb02\trefs/heads/master\n";
    expect(parseRemoteRefs(stdout)).toEqual({ defaultBranch: "master", branches: ["master"] });
  });

  it("keeps a default that is not among the heads rather than losing it", () => {
    const stdout = "ref: refs/heads/trunk\tHEAD\n9fceb02\trefs/heads/main\n";
    expect(parseRemoteRefs(stdout)).toEqual({
      defaultBranch: "trunk",
      branches: ["trunk", "main"],
    });
  });

  it("tolerates spaces where a server does not use tabs, and ignores tags", () => {
    const stdout = "9fceb02 refs/heads/main\n8cb5db1 refs/tags/v1.0\n";
    expect(parseRemoteRefs(stdout)).toEqual({ defaultBranch: "main", branches: ["main"] });
  });

  it("says so when the remote has nothing", () => {
    expect(parseRemoteRefs("")).toEqual({ defaultBranch: null, branches: [] });
  });
});

describe("listRemoteBranches", () => {
  it("reads the branches of a real repository without cloning it", async () => {
    // The fixture from the tests above, over file:// -- a real `ls-remote`
    // against a real remote, with nothing written to disk.
    const { branches, defaultBranch } = await listRemoteBranches(`file://${origin}`);
    expect(defaultBranch).toBe("main");
    expect(branches).toEqual(["main"]);
  }, 30_000);

  it("refuses a URL git would run as a command", async () => {
    await expect(listRemoteBranches("ext::sh -c whoami")).rejects.toThrow(
      /unsupported repository transport/,
    );
  });
});

describe("a project started rather than cloned", () => {
  it("leaves a git repository with one commit and a README", async () => {
    const root = join(scratch, "init-1");
    const { clones, emitted, errors } = reactor(
      root,
      created({ repoUrl: null, name: "fresh-start", defaultBranch: "main" }),
    );
    await clones.drain();

    expect(errors).toEqual([]);
    const dest = join(root, PROJECT);

    // A README, because an initial commit needs something in it -- and
    // because the checkpoint machinery needs a HEAD to be a diff against.
    expect(await readFile(join(dest, "README.md"), "utf8")).toBe("# fresh-start\n");

    const { stdout: count } = await run("git", ["-C", dest, "rev-list", "--count", "HEAD"]);
    expect(count.trim()).toBe("1");

    // The branch the dialog said it would be on, not this git's default.
    const { stdout: branch } = await run("git", ["-C", dest, "rev-parse", "--abbrev-ref", "HEAD"]);
    expect(branch.trim()).toBe("main");

    // Nothing left uncommitted: a project that opens on a dirty tree reads as
    // work somebody else started.
    const { stdout: status } = await run("git", ["-C", dest, "status", "--porcelain"]);
    expect(status.trim()).toBe("");

    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.headSha).toMatch(/^[0-9a-f]{40}$/);
  }, 60_000);

  it("starts it on the branch it was asked for", async () => {
    const root = join(scratch, "init-2");
    const { clones, errors } = reactor(
      root,
      created({ repoUrl: null, name: "trunk", defaultBranch: "develop" }),
    );
    await clones.drain();

    expect(errors).toEqual([]);
    const { stdout } = await run("git", [
      "-C",
      join(root, PROJECT),
      "rev-parse",
      "--abbrev-ref",
      "HEAD",
    ]);
    expect(stdout.trim()).toBe("develop");
  }, 60_000);

  it("commits as the account when one is resolved", async () => {
    const root = join(scratch, "init-3");
    const { clones, errors } = reactor(root, created({ repoUrl: null, name: "attributed" }), {
      credentials: async () => ({ author: { name: "Ada", email: "ada@example.com" } }),
    });
    await clones.drain();

    expect(errors).toEqual([]);
    const { stdout } = await run("git", [
      "-C",
      join(root, PROJECT),
      "log",
      "-1",
      "--format=%an <%ae>",
    ]);
    expect(stdout.trim()).toBe("Ada <ada@example.com>");
  }, 60_000);

  it("keeps files that are already there rather than writing over them", async () => {
    // A retry, or a restore: the directory exists and has work in it, and the
    // README must not land on top of whatever is already written.
    const root = join(scratch, "init-4");
    const dest = join(root, PROJECT);
    await mkdir(dest, { recursive: true });
    await writeFile(join(dest, "README.md"), "# mine\n");

    const { clones, errors } = reactor(root, created({ repoUrl: null, name: "kept" }));
    await clones.drain();

    expect(errors).toEqual([]);
    expect(await readFile(join(dest, "README.md"), "utf8")).toBe("# mine\n");
  }, 60_000);

  it("still resolves a HEAD when the credentials lookup fails", async () => {
    // A database that is momentarily unreachable should cost the commit its
    // attribution, not the project its repository.
    const root = join(scratch, "init-5");
    const { clones, emitted, errors } = reactor(root, created({ repoUrl: null, name: "resilient" }), {
      credentials: async () => {
        throw new Error("database is away");
      },
    });
    await clones.drain();

    expect(errors).toEqual([]);
    expect(emitted).toHaveLength(1);
  }, 60_000);
});

describe("how a private clone is authenticated", () => {
  /**
   * The credential helper, asked for a password the way git asks for one.
   *
   * `git credential fill` is the real consumer of the real snippet, so this
   * verifies the shell quoting, the environment lookup and the output format
   * together -- none of which a string comparison would catch.
   */
  function askGit(token: string | undefined, action = "fill") {
    // Synchronous because the request goes in on stdin, and `execFile` has no
    // way to write it -- a `credential fill` with nothing on stdin hangs.
    return execFileSync("git", ["-c", `credential.helper=${CREDENTIAL_HELPER}`, "credential", action], {
      input: "url=https://github.com/ada/engine.git\n\n",
      encoding: "utf8",
      timeout: 20_000,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: "/tmp",
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        ...(token === undefined ? {} : { UCCH_GIT_TOKEN: token }),
      },
    });
  }

  it("answers git with the token from the environment", () => {
    const filled = askGit("ghp_secret");
    expect(filled).toContain("username=x-access-token");
    expect(filled).toContain("password=ghp_secret");
  });

  it("survives a token full of characters a shell would mangle", () => {
    // Tokens are alphanumeric today, and a helper that breaks on a quote the
    // day that changes would fail as an authentication error nobody can place.
    const awkward = "gh$p'\"x `y` \\z";
    expect(askGit(awkward)).toContain(`password=${awkward}`);
  });

  it("declines to store a credential, which is how it writes nothing", () => {
    // git calls a helper with `store` after a successful authentication. This
    // one does nothing, so the token never reaches a file.
    expect(askGit("ghp_secret", "approve")).toBe("");
  });

  it("leaves no credential behind in the repository it cloned", async () => {
    // The whole reason the token is not put on the URL: `git clone` copies the
    // URL it was given into the new repository's own config, where it would be
    // readable by the agent and by every terminal opened in the project.
    const root = join(scratch, "creds-1");
    const { clones, errors } = reactor(root, created(), {
      credentials: async () => ({ token: "ghp_secret" }),
    });
    await clones.drain();

    expect(errors).toEqual([]);
    const config = await readFile(join(root, PROJECT, ".git", "config"), "utf8");
    expect(config).not.toContain("ghp_secret");
    expect(config).not.toContain("credential");
  }, 60_000);
});

describe("CloneReactor: settings and development database", () => {
  const SERVER = {
    engine: "postgresql" as const,
    host: "db.local",
    port: 5432,
    username: "dev",
    password: "p@ss",
    database: "dev",
  };

  /** An adapter that only knows the two calls the reactor makes. */
  function fakeAdapter(existing: string[] = [], fail?: Error) {
    const made: string[] = [];
    const adapterFor = () =>
      ({
        listDatabases: async () => {
          if (fail) throw fail;
          return [...existing, ...made];
        },
        createDatabase: async (name: string) => {
          made.push(name);
        },
      }) as unknown as import("./db-manager/index.js").DbAdapter;
    return { made, adapterFor };
  }

  it("writes .ucch/INFO.md for every project, and nothing about a database", async () => {
    const root = join(scratch, "ctx-1");
    const { clones, emitted, errors } = reactor(root, created({ mode: "research", database: null }));
    await clones.drain();

    expect(errors).toEqual([]);
    expect(emitted[0]).not.toHaveProperty("databaseError");
    const context = await readFile(join(root, PROJECT, ".ucch", "INFO.md"), "utf8");
    expect(context).toContain("Mode: Research");
    expect(context).not.toContain("database");
    await expect(readFile(join(root, PROJECT, ".env"), "utf8")).rejects.toThrow();
  }, 60_000);

  it("creates the database, points .env at it, and registers it once", async () => {
    const root = join(scratch, "ctx-2");
    const { made, adapterFor } = fakeAdapter();
    const registered: string[] = [];
    const options = {
      devDatabases: { postgresql: SERVER },
      adapterFor,
      registerConnection: async (_e: unknown, _s: unknown, name: string) => {
        registered.push(name);
      },
    };
    const event = created({ database: { engine: "postgresql", name: "app_dev" } });

    const first = reactor(root, event, options);
    await first.clones.drain();
    expect(first.errors).toEqual([]);
    expect(first.emitted[0]).not.toHaveProperty("databaseError");
    expect(made).toEqual(["app_dev"]);

    const dest = join(root, PROJECT);
    expect(await readFile(join(dest, ".env"), "utf8")).toBe(
      "DATABASE_URL=postgres://dev:p%40ss@db.local:5432/app_dev\n",
    );
    expect(await readFile(join(dest, ".gitignore"), "utf8")).toContain(".env\n");
    const context = await readFile(join(dest, ".ucch", "INFO.md"), "utf8");
    expect(context).toContain("`app_dev`");
    expect(context).not.toContain("p@ss");

    // Redelivered: the database already exists, so nothing is made twice.
    const second = reactor(root, event, options);
    await second.clones.drain();
    expect(second.errors).toEqual([]);
    expect(made).toEqual(["app_dev"]);
    expect(await readFile(join(dest, ".env"), "utf8")).toBe(
      "DATABASE_URL=postgres://dev:p%40ss@db.local:5432/app_dev\n",
    );
  }, 60_000);

  it("opens the project anyway when the database cannot be made, and says why", async () => {
    const root = join(scratch, "ctx-3");
    const { adapterFor } = fakeAdapter([], new Error("connection refused"));
    const { clones, emitted, errors } = reactor(
      root,
      created({ database: { engine: "postgresql", name: "app_dev" } }),
      { devDatabases: { postgresql: SERVER }, adapterFor },
    );
    await clones.drain();

    expect(errors).toEqual([]);
    expect(emitted[0]?.databaseError).toContain("connection refused");
    expect(emitted[0]?.headSha).toBe(originSha);
  }, 60_000);

  it("commits a started project's settings but never its .env", async () => {
    const root = join(scratch, "ctx-5");
    const { adapterFor } = fakeAdapter();
    const { clones, errors } = reactor(
      root,
      created({ repoUrl: null, database: { engine: "postgresql", name: "app_dev" } }),
      { devDatabases: { postgresql: SERVER }, adapterFor },
    );
    await clones.drain();
    expect(errors).toEqual([]);

    const dest = join(root, PROJECT);
    const { stdout: tracked } = await run("git", ["-C", dest, "ls-files"]);
    expect(tracked.split("\n").filter(Boolean).sort()).toEqual([".gitignore", ".ucch/INFO.md", "README.md"]);
    const { stdout: status } = await run("git", ["-C", dest, "status", "--porcelain"]);
    expect(status.trim()).toBe("");
    expect(await readFile(join(dest, ".env"), "utf8")).toContain("DATABASE_URL=");
  }, 60_000);

  it("reports an engine with no server configured", async () => {
    const root = join(scratch, "ctx-4");
    const { clones, emitted } = reactor(root, created({ database: { engine: "mysql", name: "app_dev" } }), {
      devDatabases: { postgresql: SERVER },
    });
    await clones.drain();
    expect(emitted[0]?.databaseError).toMatch(/MySQL development server is not configured/);
  }, 60_000);
});
