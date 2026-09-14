import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MAX_SEARCH_MATCHES,
  SearchError,
  parseMatches,
  searchArgv,
  searchWorkspace,
} from "./search.js";

const ROOT = "/srv/workspaces/project";

/** One ripgrep `match` event, as it arrives on stdout. */
function match(over: {
  path?: string;
  line?: number;
  text?: string;
  submatches?: Array<{ start: number; end: number }>;
}) {
  return JSON.stringify({
    type: "match",
    data: {
      path: { text: over.path ?? `${ROOT}/src/app.ts` },
      lines: { text: `${over.text ?? "const token = read()"}\n` },
      line_number: over.line ?? 12,
      submatches: over.submatches ?? [{ start: 6, end: 11 }],
    },
  });
}

describe("searchArgv", () => {
  it("searches for literal text by default", () => {
    // `config.get(` is four metacharacters and nobody typing it meant them.
    const argv = searchArgv({ query: "config.get(" }, ROOT);
    expect(argv).toContain("--fixed-strings");
    expect(argv).toContain("--ignore-case");
  });

  it("takes the flags off when a regular expression was asked for", () => {
    const argv = searchArgv({ query: "to(ken|ver)", regex: true, caseSensitive: true }, ROOT);
    expect(argv).not.toContain("--fixed-strings");
    expect(argv).toContain("--case-sensitive");
  });

  it("puts the query after `--`, so it can never be read as a flag", () => {
    const argv = searchArgv({ query: "--files" }, ROOT);
    const end = argv.indexOf("--");
    expect(end).toBeGreaterThan(0);
    expect(argv.slice(end + 1)).toEqual(["--files", ROOT]);
  });

  it("applies ignore files outside a git repository too", () => {
    // ripgrep reads .gitignore only inside a repository by default, so a
    // project whose clone has not landed would return all of node_modules.
    expect(searchArgv({ query: "x" }, ROOT)).toContain("--no-require-git");
  });

  it("searches dotfiles but not the git directory", () => {
    const argv = searchArgv({ query: "x" }, ROOT);
    expect(argv).toContain("--hidden");
    expect(argv[argv.indexOf("-g") + 1]).toBe("!.git/");
  });

  it("refuses a hostile ripgrep config before anything else", () => {
    // `--no-config` has to come first: a RIPGREP_CONFIG_PATH could otherwise
    // rewrite every flag after it.
    expect(searchArgv({ query: "x" }, ROOT)[1]).toBe("--no-config");
  });

  it("passes a caller's glob as its own argument", () => {
    const argv = searchArgv({ query: "x", glob: "*.ts" }, ROOT);
    expect(argv).toContain("*.ts");
    expect(argv[argv.lastIndexOf("-g") + 1]).toBe("*.ts");
  });

  it("adds no glob of its own beyond the git exclusion", () => {
    expect(searchArgv({ query: "x", glob: null }, ROOT).filter((a) => a === "-g")).toHaveLength(1);
  });
});

describe("parseMatches", () => {
  it("reads a match into a path, a line and where the match sits", () => {
    const { matches, truncated } = parseMatches(match({}), ROOT);
    expect(truncated).toBe(false);
    expect(matches).toEqual([
      { path: "src/app.ts", line: 12, text: "const token = read()", ranges: [[6, 11]] },
    ]);
  });

  it("makes the path relative, because absolute is an artefact of the call", () => {
    const { matches } = parseMatches(match({ path: `${ROOT}/deep/nested/file.php` }), ROOT);
    expect(matches[0]!.path).toBe("deep/nested/file.php");
  });

  it("counts characters where ripgrep counted bytes", () => {
    // ripgrep reports byte offsets and the browser highlights by character, so
    // a match after a non-ASCII character lands in the wrong place otherwise.
    // "héllo token": `token` starts at byte 7 and at character 6.
    const { matches } = parseMatches(
      match({ text: "héllo token", submatches: [{ start: 7, end: 12 }] }),
      ROOT,
    );
    const [start, end] = matches[0]!.ranges[0]!;
    expect("héllo token".slice(start, end)).toBe("token");
  });

  it("keeps every match in a line, not only the first", () => {
    const { matches } = parseMatches(
      match({ text: "token and token", submatches: [{ start: 0, end: 5 }, { start: 10, end: 15 }] }),
      ROOT,
    );
    expect(matches[0]!.ranges).toEqual([
      [0, 5],
      [10, 15],
    ]);
  });

  it("strips the trailing newline ripgrep includes", () => {
    expect(parseMatches(match({}), ROOT).matches[0]!.text).not.toContain("\n");
  });

  it("cuts a very long line rather than dropping the match in it", () => {
    // A minified bundle is one enormous line, and the match in it still counts.
    const long = "x".repeat(5000);
    const { matches } = parseMatches(
      match({ text: long, submatches: [{ start: 0, end: 3 }] }),
      ROOT,
    );
    expect(matches[0]!.text).toHaveLength(400);
    expect(matches[0]!.ranges).toEqual([[0, 3]]);
  });

  it("drops a range that falls past the cut rather than highlighting nothing", () => {
    const long = "x".repeat(5000);
    const { matches } = parseMatches(
      match({ text: long, submatches: [{ start: 4000, end: 4005 }] }),
      ROOT,
    );
    expect(matches[0]!.ranges).toEqual([]);
  });

  it("ignores the events that describe the run rather than the result", () => {
    const stream = [
      JSON.stringify({ type: "begin", data: { path: { text: `${ROOT}/a.ts` } } }),
      match({}),
      JSON.stringify({ type: "end", data: { path: { text: `${ROOT}/a.ts` } } }),
      JSON.stringify({ type: "summary", data: { stats: {} } }),
    ].join("\n");
    expect(parseMatches(stream, ROOT).matches).toHaveLength(1);
  });

  it("skips a line it cannot parse rather than losing the search", () => {
    // The output cap can cut the stream mid-object; losing the last match is
    // better than losing all of them.
    const stream = [match({}), '{"type":"match","data":{"path"'].join("\n");
    expect(parseMatches(stream, ROOT).matches).toHaveLength(1);
  });

  it("says so when the cap stopped it short", () => {
    const stream = Array.from({ length: MAX_SEARCH_MATCHES + 10 }, (_, i) =>
      match({ line: i + 1 }),
    ).join("\n");
    const { matches, truncated } = parseMatches(stream, ROOT);

    expect(matches).toHaveLength(MAX_SEARCH_MATCHES);
    expect(truncated).toBe(true);
  });

  it("finds nothing in nothing", () => {
    expect(parseMatches("", ROOT)).toEqual({ matches: [], truncated: false });
  });
});

/**
 * Against real ripgrep, in a real directory.
 *
 * The tests above assert on ripgrep's output as a string; these assert that the
 * flags actually produce it. They are what would catch a flag renamed in a
 * future ripgrep, or `--json` changing shape -- neither of which a fixture can.
 */
describe("searchWorkspace", () => {
  let workspace: string;

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "ucch-search-"));
    await mkdir(join(workspace, "src"), { recursive: true });
    await mkdir(join(workspace, "node_modules"), { recursive: true });

    await writeFile(join(workspace, "src/app.ts"), "const token = read()\nconst other = 1\n");
    await writeFile(join(workspace, "src/Token.md"), "# TOKEN\nAbout the token.\n");
    await writeFile(join(workspace, "node_modules/dep.js"), "const token = 'vendored'\n");
    await writeFile(join(workspace, ".gitignore"), "node_modules/\n");
  }, 30_000);

  afterAll(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it("finds a keyword across files, with the line and the match located", async () => {
    const { matches } = await searchWorkspace(workspace, { query: "token" });
    const app = matches.find((m) => m.path === "src/app.ts");

    expect(app).toMatchObject({ line: 1, text: "const token = read()" });
    expect(app!.text.slice(...app!.ranges[0]!)).toBe("token");
  }, 30_000);

  it("skips what git ignores, so node_modules is not what you find", async () => {
    const { matches } = await searchWorkspace(workspace, { query: "token" });
    expect(matches.map((m) => m.path)).not.toContain("node_modules/dep.js");
  }, 30_000);

  it("ignores case by default and obeys it when asked", async () => {
    const loose = await searchWorkspace(workspace, { query: "TOKEN" });
    expect(loose.matches.length).toBeGreaterThan(1);

    const strict = await searchWorkspace(workspace, { query: "TOKEN", caseSensitive: true });
    expect(strict.matches.map((m) => m.path)).toEqual(["src/Token.md"]);
  }, 30_000);

  it("treats the query as text, not as a pattern", async () => {
    // `read()` is a regex that matches "read"; as literal text it matches the
    // parentheses too, which is what someone typing it meant.
    const { matches } = await searchWorkspace(workspace, { query: "read()" });
    expect(matches).toHaveLength(1);

    const dotted = await searchWorkspace(workspace, { query: "c.nst" });
    expect(dotted.matches).toEqual([]);
  }, 30_000);

  it("searches as a regular expression when told to", async () => {
    const { matches } = await searchWorkspace(workspace, { query: "c.nst token", regex: true });
    expect(matches.map((m) => m.path)).toEqual(["src/app.ts"]);
  }, 30_000);

  it("narrows to a glob", async () => {
    const { matches } = await searchWorkspace(workspace, { query: "token", glob: "*.md" });
    expect(matches.map((m) => m.path)).toEqual(["src/Token.md", "src/Token.md"]);
  }, 30_000);

  it("reports no matches as an answer rather than a failure", async () => {
    await expect(searchWorkspace(workspace, { query: "nothinghere" })).resolves.toEqual({
      matches: [],
      truncated: false,
    });
  }, 30_000);

  it("blames a bad regular expression on the query", async () => {
    const failure = await searchWorkspace(workspace, { query: "to(ken", regex: true }).catch(
      (e) => e,
    );
    expect(failure).toBeInstanceOf(SearchError);
    expect(failure.fromQuery).toBe(true);
  }, 30_000);

  it("finds nothing in a directory that is not there, without throwing", async () => {
    // A project whose clone has not landed yet: ripgrep exits 2 with "No such
    // file", which is a refusal the panel should show rather than a crash.
    const missing = await searchWorkspace(join(workspace, "absent"), { query: "x" }).catch((e) => e);
    expect(missing).toBeInstanceOf(SearchError);
  }, 30_000);
});
