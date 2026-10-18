import { mkdir, mkdtemp, rm, writeFile as write } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { DomainEvent } from "@ucch/protocol";
import type { Complete, CompletionResult } from "../completion.js";
import { HostExecutor } from "../executors/host.js";
import { ALL, toolsFor } from "../registry.js";
import type { AnyTool, ToolContext } from "../tool.js";
import { openrouterPluginProvider } from "../web.js";
import { deleteFile, editFile, listDir, readFile, writeFile } from "./fs.js";
import { glob, grep } from "./search.js";
import { bash } from "./shell.js";
import { currentTime, ping } from "./system.js";
import { attachUpload } from "./uploads.js";
import { UnknownUploadError, UploadConflictError, type UploadStaging } from "../uploads.js";
import { htmlToText, isBlocked, webFetch, webSearch } from "./web.js";
import { researchBrowse, researchRead, researchSearch } from "./research.js";
import type { ResearchProvider } from "../research.js";

const PROJECT = "33333333-3333-3333-3333-333333333333";

let root: string;
let emitted: DomainEvent[] = [];
let completed: Parameters<Complete>[0][] = [];
let completion: CompletionResult;

const blankCompletion = (): CompletionResult => ({
  text: "",
  reasoning: "",
  toolCalls: [],
  annotations: [],
  finishReason: "stop",
  usage: {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  },
  costUsd: 0,
});

completion = blankCompletion();

function context(over: Partial<ToolContext> = {}): ToolContext {
  const complete: Complete =
    over.complete ??
    (async (request) => {
      completed.push(request);
      return completion;
    });

  return {
    projectId: PROJECT,
    threadId: "44444444-4444-4444-4444-444444444444",
    turnId: "55555555-5555-5555-5555-555555555555",
    toolUseId: "call_a",
    executor: new HostExecutor(root),
    signal: new AbortController().signal,
    async emit(event) {
      emitted.push(event);
    },
    apiKey: "key",
    model: "test/model",
    depth: 0,
    complete,
    // The real default provider over whatever `complete` this context ended
    // up with, so a test that scripts a failing sub-call still sees it fail
    // through the seam rather than past it.
    web: openrouterPluginProvider({ apiKey: "key", model: "test/search-model", complete }),
    ...over,
  };
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "ucch-tools-"));
  // ripgrep only applies .gitignore inside a git repository.
  await mkdir(join(root, ".git"), { recursive: true });
  await mkdir(join(root, "src/routes"), { recursive: true });
  await mkdir(join(root, "node_modules/left-pad"), { recursive: true });

  await write(join(root, ".gitignore"), "node_modules\n");
  await write(join(root, "package.json"), '{\n  "name": "fixture"\n}\n');
  await write(join(root, "src/index.ts"), "import { app } from './app';\napp.listen(3000);\n");
  await write(
    join(root, "src/routes/health.ts"),
    "export function health() {\n  return { ok: true };\n}\n",
  );
  await write(join(root, "node_modules/left-pad/index.js"), "module.exports = 1;\n");
  await write(join(root, "empty.txt"), "");
  await write(
    join(root, "long.txt"),
    Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n"),
  );
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

let cleanup: string[] = [];

afterEach(async () => {
  emitted = [];
  completed = [];
  completion = blankCompletion();
  vi.unstubAllGlobals();
  for (const path of cleanup) await rm(join(root, path), { recursive: true, force: true });
  cleanup = [];
});

describe("read_file", () => {
  it("returns the file with line numbers", async () => {
    const result = await readFile.run(
      { path: "src/index.ts", offset: null, limit: null },
      context(),
    );
    expect(result.content).toBe("1\timport { app } from './app';\n2\tapp.listen(3000);");
    expect(result.isError).toBeUndefined();
    expect(result.display).toEqual({ path: "src/index.ts", language: "typescript" });
  });

  it("pages with offset and limit, and says how to continue", async () => {
    const result = await readFile.run({ path: "long.txt", offset: 10, limit: 3 }, context());
    expect(result.content).toContain("10\tline 10");
    expect(result.content).toContain("12\tline 12");
    expect(result.content).not.toContain("line 13");
    expect(result.content).toContain("showing lines 10-12 of 50");
    expect(result.content).toContain("read on from offset 13");
  });

  it("says so rather than returning nothing for an empty file", async () => {
    const result = await readFile.run({ path: "empty.txt", offset: null, limit: null }, context());
    expect(result.content).toBe("empty.txt is empty.");
  });

  it("reports an offset past the end", async () => {
    const result = await readFile.run({ path: "long.txt", offset: 500, limit: null }, context());
    expect(result).toMatchObject({ isError: true });
    expect(result.content).toContain("has 50 lines");
  });
});

describe("list_dir", () => {
  it("lists directories and files, and honours .gitignore", async () => {
    const result = await listDir.run({ path: "" }, context());
    expect(result.content).toContain("src/");
    expect(result.content).toContain("package.json");
    // The whole reason to go through ripgrep rather than readdir.
    expect(result.content).not.toContain("node_modules");
  });

  it("treats an empty path and a dot alike, both meaning the root", async () => {
    const dot = await listDir.run({ path: "." }, context());
    const empty = await listDir.run({ path: "" }, context());
    expect(dot.content).toBe(empty.content);
  });

  it("lists a subdirectory relative to itself", async () => {
    const result = await listDir.run({ path: "src" }, context());
    expect(result.content).toContain("index.ts");
    expect(result.content).toContain("routes/");
    expect(result.content).not.toContain("src/index.ts");
  });
});

describe("write_file", () => {
  it("creates a file, its parents, and an added event", async () => {
    cleanup.push("fresh");
    const result = await writeFile.run(
      { path: "fresh/nested/note.md", content: "# Title\nbody\n" },
      context(),
    );

    expect(result.content).toContain("Created fresh/nested/note.md");
    expect(emitted).toEqual([
      { type: "file.changed", projectId: PROJECT, path: "fresh/nested/note.md", change: "added" },
    ]);
  });

  it("reports a rewrite as modified", async () => {
    cleanup.push("rewritten.txt");
    await writeFile.run({ path: "rewritten.txt", content: "one" }, context());
    emitted = [];
    const result = await writeFile.run({ path: "rewritten.txt", content: "two" }, context());

    expect(result.content).toContain("Updated rewritten.txt");
    expect(emitted[0]).toMatchObject({ change: "modified" });
  });
});

describe("delete_file", () => {
  it("removes the file and says so, with a deleted event", async () => {
    await writeFile.run({ path: "doomed.html", content: "<h1>hi</h1>" }, context())
    emitted = []

    const result = await deleteFile.run({ path: "doomed.html" }, context())

    expect(result.isError).toBeUndefined()
    expect(result.content).toBe("Deleted doomed.html.")
    expect(emitted).toEqual([
      { type: "file.changed", projectId: PROJECT, path: "doomed.html", change: "deleted" },
    ])
  })

  it("reports a file that was already gone without calling it an error", async () => {
    const result = await deleteFile.run({ path: "never-existed.txt" }, context())

    // The asked-for state holds, so there is nothing for the model to retry.
    expect(result.isError).toBeUndefined()
    expect(result.content).toContain("nothing to delete")
    expect(emitted).toEqual([])
  })

  it("refuses a directory", async () => {
    await mkdir(join(root, "keep-me"), { recursive: true })
    cleanup.push("keep-me")

    const result = await deleteFile.run({ path: "keep-me" }, context())

    expect(result).toMatchObject({ isError: true })
    expect(result.content).toContain("directory")
  })

  it("refuses a path outside the workspace", async () => {
    const result = await deleteFile.run({ path: "../escape.txt" }, context())
    expect(result).toMatchObject({ isError: true })
    expect(result.content).toContain("escapes the workspace")
  })

  it("refuses the workspace root itself", async () => {
    for (const path of ["", ".", "./"]) {
      expect(await deleteFile.run({ path }, context())).toMatchObject({ isError: true })
    }
  })
})

describe("edit_file", () => {
  it("replaces a unique string and emits the change", async () => {
    cleanup.push("edit.ts");
    await writeFile.run({ path: "edit.ts", content: "const port = 3000;\n" }, context());
    emitted = [];

    const result = await editFile.run(
      { path: "edit.ts", old_string: "3000", new_string: "8080", replace_all: null },
      context(),
    );

    expect(result.content).toBe("Replaced 1 occurrence in edit.ts.");
    expect(emitted[0]).toMatchObject({ type: "file.changed", change: "modified" });
    const after = await readFile.run({ path: "edit.ts", offset: null, limit: null }, context());
    expect(after.content).toContain("const port = 8080;");
  });

  // Ambiguity is the failure mode that silently edits the wrong line.
  it("refuses a string that appears more than once", async () => {
    cleanup.push("twice.ts");
    await writeFile.run({ path: "twice.ts", content: "a = 1;\nb = 1;\n" }, context());

    const result = await editFile.run(
      { path: "twice.ts", old_string: "1", new_string: "2", replace_all: null },
      context(),
    );
    expect(result).toMatchObject({ isError: true });
    expect(result.content).toContain("appears 2 times");
  });

  it("replaces every occurrence when asked", async () => {
    cleanup.push("all.ts");
    await writeFile.run({ path: "all.ts", content: "a = 1;\nb = 1;\n" }, context());

    const result = await editFile.run(
      { path: "all.ts", old_string: "1", new_string: "2", replace_all: true },
      context(),
    );
    expect(result.content).toBe("Replaced 2 occurrences in all.ts.");
  });

  it("reports a string that is not there", async () => {
    const result = await editFile.run(
      { path: "src/index.ts", old_string: "not present", new_string: "x", replace_all: null },
      context(),
    );
    expect(result).toMatchObject({ isError: true });
    expect(result.content).toContain("was not found");
  });

  // The model's string is literal text, not a pattern.
  it("treats regex metacharacters as literal", async () => {
    cleanup.push("regex.ts");
    await writeFile.run({ path: "regex.ts", content: "cost = $1.00 + x;\n" }, context());

    await editFile.run(
      { path: "regex.ts", old_string: "$1.00", new_string: "$2.00", replace_all: null },
      context(),
    );
    const after = await readFile.run({ path: "regex.ts", offset: null, limit: null }, context());
    expect(after.content).toContain("cost = $2.00 + x;");
  });

  it("refuses a no-op edit", async () => {
    const result = await editFile.run(
      { path: "src/index.ts", old_string: "same", new_string: "same", replace_all: null },
      context(),
    );
    expect(result).toMatchObject({ isError: true });
  });
});

describe("glob", () => {
  it("finds files by pattern, in sorted order, relative to the workspace", async () => {
    const result = await glob.run({ pattern: "**/*.ts", path: null }, context());
    expect(result.content.split("\n")).toEqual(["src/index.ts", "src/routes/health.ts"]);
  });

  it("scopes to a subdirectory", async () => {
    const result = await glob.run({ pattern: "*.ts", path: "src/routes" }, context());
    expect(result.content).toBe("src/routes/health.ts");
  });

  it("answers rather than failing when nothing matches", async () => {
    const result = await glob.run({ pattern: "*.rs", path: null }, context());
    expect(result.content).toBe("No files match *.rs.");
    expect(result.isError).toBeUndefined();
  });
});

describe("grep", () => {
  it("formats matches as path:line: text", async () => {
    const result = await grep.run(
      { pattern: "app.listen", path: null, glob: null, context: null },
      context(),
    );
    expect(result.content).toBe("src/index.ts:2: app.listen(3000);");
  });

  it("marks context lines with a dash, the way grep itself does", async () => {
    const result = await grep.run(
      { pattern: "app.listen", path: null, glob: null, context: 1 },
      context(),
    );
    expect(result.content.split("\n")).toEqual([
      "src/index.ts-1- import { app } from './app';",
      "src/index.ts:2: app.listen(3000);",
    ]);
  });

  it("filters by glob", async () => {
    const result = await grep.run(
      { pattern: "ok", path: null, glob: "*.json", context: null },
      context(),
    );
    expect(result.content).toBe("No matches for ok.");
  });

  it("reports an invalid pattern as an error the model can fix", async () => {
    const result = await grep.run(
      { pattern: "(unclosed", path: null, glob: null, context: null },
      context(),
    );
    expect(result).toMatchObject({ isError: true });
    expect(result.content).toContain("grep failed");
  });

  // A pattern that looks like a flag is data, because of the separator.
  it("does not let a pattern become a flag", async () => {
    const result = await grep.run(
      { pattern: "--files", path: null, glob: null, context: null },
      context(),
    );
    expect(result.content).toBe("No matches for --files.");
  });
});

describe("current_time", () => {
  it("answers without a subprocess, in the requested timezone", async () => {
    const result = await currentTime.run({ timezone: "Asia/Kuala_Lumpur" }, context());
    expect(result.content).toMatch(/ISO 8601 \(UTC\): \d{4}-\d{2}-\d{2}T/);
    expect(result.isError).toBeUndefined();
  });

  it("rejects a timezone that is not real", async () => {
    const result = await currentTime.run({ timezone: "Middle/Earth" }, context());
    expect(result).toMatchObject({ isError: true });
    expect(result.content).toContain("not a recognised IANA timezone");
  });
});

describe("ping", () => {
  // The host is the only model-supplied part of the command line, and this is
  // what stops it becoming a flag or a second command.
  it.each(["-c", "--flood", "google.com; rm -rf /", "a b", "http://x.test", "-"])(
    "refuses %j as a hostname",
    async (host) => {
      const result = await ping.run({ host, count: null }, context());
      expect(result).toMatchObject({ isError: true });
      expect(result.content).toContain("is not a valid hostname");
    },
  );

  it("accepts a hostname and reports what it got back", async () => {
    const result = await ping.run({ host: "127.0.0.1", count: 1 }, context());
    expect(result.content).toContain("127.0.0.1");
  });
});

describe("attach_upload", () => {
  /** Staging that records what it was asked to do. */
  function staging(over: Partial<UploadStaging> = {}): UploadStaging & { calls: unknown[] } {
    const calls: unknown[] = [];
    return {
      calls,
      async list() {
        return [];
      },
      async attach(projectId, uploadId, path) {
        calls.push({ projectId, uploadId, path });
        return { path, size: 2048 };
      },
      async retain(projectId, uploadId) {
        calls.push({ retain: { projectId, uploadId } });
      },
      async readBytes() {
        return null;
      },
      ...over,
    };
  }

  it("places the file and announces it like any other write", async () => {
    const uploads = staging();
    const result = await attachUpload.run(
      { upload_id: "up-1", path: "public/logo.png" },
      context({ uploads }),
    );

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("public/logo.png");
    expect(uploads.calls).toEqual([
      { projectId: PROJECT, uploadId: "up-1", path: "public/logo.png" },
    ]);
    // The same event `write_file` emits, so the file tree and any open
    // editor hear about it by the one path.
    expect(emitted).toContainEqual({
      type: "file.changed",
      projectId: PROJECT,
      path: "public/logo.png",
      change: "added",
    });
  });

  it("reports an id that is no longer staged as something to correct", async () => {
    const uploads = staging({
      async attach() {
        throw new UnknownUploadError("gone");
      },
    });
    const result = await attachUpload.run({ upload_id: "up-x", path: "a.png" }, context({ uploads }));

    expect(result.isError).toBe(true);
    expect(result.content).toContain("up-x");
    expect(emitted).toHaveLength(0);
  });

  it("reports a destination that is taken without claiming to have written it", async () => {
    const uploads = staging({
      async attach() {
        throw new UploadConflictError("exists");
      },
    });
    const result = await attachUpload.run(
      { upload_id: "up-1", path: "README.md" },
      context({ uploads }),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("README.md already exists");
    expect(emitted).toHaveLength(0);
  });

  it("says so plainly when the harness has no staging at all", async () => {
    const result = await attachUpload.run({ upload_id: "up-1", path: "a.png" }, context());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("no attachment staging");
  });
});

describe("bash", () => {
  it("runs a command in the workspace and reports the exit code", async () => {
    const result = await bash.run({ command: "pwd && echo hi", timeout_ms: null }, context());
    expect(result.content).toContain(root);
    expect(result.content).toContain("hi");
    expect(result.content).toContain("exit code: 0");
    expect(result.isError).toBeFalsy();
  });

  it("marks a failure and keeps stderr", async () => {
    const result = await bash.run(
      { command: "echo problem >&2; exit 2", timeout_ms: null },
      context(),
    );
    expect(result).toMatchObject({ isError: true });
    expect(result.content).toContain("problem");
    expect(result.content).toContain("exit code: 2");
  });

  it("never returns an empty string, even for a silent command", async () => {
    const result = await bash.run({ command: "true", timeout_ms: null }, context());
    expect(result.content).toContain("(no output)");
  });

  it("keeps the output a timed-out command managed to print", async () => {
    const result = await bash.run(
      { command: "echo before; sleep 30", timeout_ms: 1_000 },
      context(),
    );
    expect(result).toMatchObject({ isError: true });
    expect(result.content).toContain("timed out after 1000ms");
    expect(result.content).toContain("before");
  });
});

describe("web_search", () => {
  it("sub-calls the model with the web plugin and no tools", async () => {
    completion = { ...blankCompletion(), text: "Next.js 15.5 is current." };
    await webSearch.run({ query: "latest next.js release", max_results: 3 }, context());

    expect(completed).toHaveLength(1);
    expect(completed[0]!.plugins).toEqual([{ id: "web", max_results: 3 }]);
    // No tools, so the sub-call cannot start a nested agent loop.
    expect(completed[0]!.tools).toBeUndefined();
    expect(completed[0]!.messages.at(-1)).toEqual({
      role: "user",
      content: "latest next.js release",
    });
  });

  it("returns the answer with its citations", async () => {
    completion = {
      ...blankCompletion(),
      text: "Next.js 15.5 is current.",
      annotations: [
        { type: "url_citation", url_citation: { url: "https://nextjs.org/blog", title: "Blog" } },
      ],
    };

    const result = await webSearch.run({ query: "next.js", max_results: null }, context());
    expect(result.content).toContain("Next.js 15.5 is current.");
    expect(result.content).toContain("[1] Blog");
    expect(result.content).toContain("https://nextjs.org/blog");
  });

  it("asks the search model, never the turn's own", async () => {
    // A search is a summariser reading result pages. Billing that at the
    // coding model's rate made every search cost about as much as a turn.
    await webSearch.run({ query: "next.js", max_results: null }, context());
    expect(completed).toHaveLength(1);
    expect(completed[0]!.model).toBe("test/search-model");
  });

  it("says exactly how many sources it left out", async () => {
    completion = {
      ...blankCompletion(),
      text: "an answer",
      annotations: Array.from({ length: 5 }, (_, i) => ({
        type: "url_citation",
        url_citation: { url: `https://example.com/${i}`, title: `Result ${i}` },
      })),
    };
    const result = await webSearch.run({ query: "x", max_results: 2 }, context());
    // Exact, not "and more": a model told six were dropped can search again
    // more narrowly, and one told "some" cannot.
    expect(result.content).toContain("[2] Result 1");
    expect(result.content).not.toContain("[3]");
    expect(result.content).toContain("(3 further sources not listed)");
  });

  it("refuses to run inside another tool call", async () => {
    const result = await webSearch.run({ query: "x", max_results: null }, context({ depth: 1 }));
    expect(result).toMatchObject({ isError: true });
    expect(completed).toHaveLength(0);
  });

  it("reports a failed sub-call rather than throwing", async () => {
    const result = await webSearch.run(
      { query: "x", max_results: null },
      context({
        complete: async () => {
          throw new Error("no credit");
        },
      }),
    );
    expect(result).toMatchObject({ isError: true });
    expect(result.content).toContain("no credit");
  });
});

describe("web_fetch address rules", () => {
  it("blocks loopback, private, link-local and reserved addresses", () => {
    for (const address of [
      "127.0.0.1",
      "10.0.0.5",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      // The cloud metadata endpoint, which is the whole reason for this.
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "::1",
      "::",
      "fd00::1",
      "fe80::1",
      "::ffff:127.0.0.1",
    ]) {
      expect(isBlocked(address), address).toBe(true);
    }
  });

  it("allows ordinary public addresses", () => {
    for (const address of ["8.8.8.8", "93.184.216.34", "172.32.0.1", "2606:4700::1111"]) {
      expect(isBlocked(address), address).toBe(false);
    }
  });
});

describe("web_fetch", () => {
  it("refuses a scheme that is not http or https", async () => {
    const result = await webFetch.run({ url: "file:///etc/passwd" }, context());
    expect(result).toMatchObject({ isError: true });
    expect(result.content).toContain("not allowed");
  });

  it("refuses a hostname that resolves to loopback", async () => {
    const result = await webFetch.run({ url: "http://localhost:8080/admin" }, context());
    expect(result).toMatchObject({ isError: true });
    expect(result.content).toMatch(/private or loopback/);
  });

  it("refuses a private address written literally", async () => {
    const result = await webFetch.run(
      { url: "http://169.254.169.254/latest/meta-data" },
      context(),
    );
    expect(result).toMatchObject({ isError: true });
  });

  it("reads a page and returns its text", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          "<html><head><title>Docs</title></head><body><p>Hello</p><p>World</p></body></html>",
          { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
        ),
    );

    const result = await webFetch.run({ url: "http://93.184.216.34/docs" }, context());
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Docs");
    expect(result.content).toContain("Hello");
    expect(result.content).toContain("World");
  });

  // Following redirects automatically would walk straight past the check.
  it("revalidates each redirect hop", async () => {
    vi.stubGlobal("fetch", async (url: URL) =>
      String(url).includes("/start")
        ? new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } })
        : new Response("secret", { status: 200, headers: { "content-type": "text/plain" } }),
    );

    const result = await webFetch.run({ url: "http://93.184.216.34/start" }, context());
    expect(result).toMatchObject({ isError: true });
    expect(result.content).toContain("169.254.169.254");
    expect(result.content).not.toContain("secret");
  });

  it("refuses content that is not text", async () => {
    vi.stubGlobal(
      "fetch",
      async () => new Response(" ", { status: 200, headers: { "content-type": "image/png" } }),
    );

    const result = await webFetch.run({ url: "http://93.184.216.34/logo.png" }, context());
    expect(result).toMatchObject({ isError: true });
    expect(result.content).toContain("not text");
  });

  it("reports a non-200", async () => {
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 404 }));
    const result = await webFetch.run({ url: "http://93.184.216.34/missing" }, context());
    expect(result).toMatchObject({ isError: true });
    expect(result.content).toContain("404");
  });
});

describe("the research tools", () => {
  // A literal public address, like the web_fetch tests: the guard resolves
  // hostnames, and a test must not depend on DNS.
  const PAGE = "http://93.184.216.34/docs";

  const research = (over: Partial<ResearchProvider> = {}): ResearchProvider => ({
    search: async () => ({
      answer: "Found it.",
      sources: [{ url: "https://example.com/a", title: "A" }],
      truncated: false,
      omitted: 0,
    }),
    ...over,
  });

  it("refuse a turn that was not started in research mode", async () => {
    const result = await researchSearch.run({ query: "x", max_results: null }, context());
    expect(result).toMatchObject({ isError: true });
    expect(result.content).toMatch(/research mode/);
  });

  it("research_search lists the answer and the sources", async () => {
    const result = await researchSearch.run(
      { query: "next 15", max_results: null },
      context({ research: research() }),
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Found it.");
    expect(result.content).toContain("[1] A\n    https://example.com/a");
    expect(result.display).toEqual({ title: "next 15" });
  });

  it("research_read returns the crawler's markdown with the page's title", async () => {
    const read = vi.fn(async () => ({
      ok: true as const,
      url: PAGE,
      title: "Docs",
      text: "# Docs\n\nThe content.",
      statusCode: 200,
    }));
    const result = await researchRead.run(
      { url: PAGE, escalate: null },
      context({ research: research({ reader: { read } }) }),
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe(`${PAGE}\n# Docs\n\n# Docs\n\nThe content.`);
    expect(read).toHaveBeenCalledWith(expect.objectContaining({ url: PAGE }));
  });

  it("research_read escalates a gated page to the browser agent and says so", async () => {
    const read = vi.fn(async () => ({
      ok: false as const,
      gated: true,
      reason: "403 Forbidden",
      statusCode: 403,
    }));
    const browse = vi.fn(async () => ({ output: "The real content.", liveUrl: "https://live/1" }));
    const result = await researchRead.run(
      { url: PAGE, escalate: null },
      context({ research: research({ reader: { read }, browser: { browse } }) }),
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toMatch(/could not read this page \(403 Forbidden\), so it was escalated/);
    expect(result.content).toContain("(run: https://live/1)");
    expect(result.content).toContain("The real content.");
    expect(browse).toHaveBeenCalledWith(expect.objectContaining({ url: PAGE }));
  });

  it("research_read does not escalate a page that merely failed", async () => {
    const browse = vi.fn();
    const result = await researchRead.run(
      { url: PAGE, escalate: null },
      context({
        research: research({
          reader: { read: async () => ({ ok: false, gated: false, reason: "404 Not Found", statusCode: 404 }) },
          browser: { browse },
        }),
      }),
    );
    expect(result).toMatchObject({ isError: true });
    expect(result.content).toContain("404 Not Found");
    expect(browse).not.toHaveBeenCalled();
  });

  it("research_read names the missing browser agent on a gated page", async () => {
    const result = await researchRead.run(
      { url: PAGE, escalate: null },
      context({
        research: research({
          reader: { read: async () => ({ ok: false, gated: true, reason: "bot check", statusCode: 200 }) },
        }),
      }),
    );
    expect(result).toMatchObject({ isError: true });
    expect(result.content).toMatch(/no browser agent is configured/);
  });

  it("research_read goes straight to the browser agent when asked to", async () => {
    const read = vi.fn();
    const browse = vi.fn(async () => ({ output: "From the browser." }));
    const result = await researchRead.run(
      { url: PAGE, escalate: true },
      context({ research: research({ reader: { read }, browser: { browse } }) }),
    );
    expect(result.isError).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
    expect(result.content).toContain("From the browser.");
  });

  it("research_read says when there is no crawler", async () => {
    const result = await researchRead.run({ url: PAGE, escalate: null }, context({ research: research() }));
    expect(result).toMatchObject({ isError: true });
    expect(result.content).toMatch(/CRAWL4AI_URL/);
  });

  it("the guard against private addresses applies before anything is sent anywhere", async () => {
    const read = vi.fn();
    const browse = vi.fn();
    const ctx = context({ research: research({ reader: { read }, browser: { browse } }) });
    for (const url of ["http://169.254.169.254/latest/meta-data", "http://localhost:11235/"]) {
      expect(await researchRead.run({ url, escalate: null }, ctx)).toMatchObject({ isError: true });
      expect(await researchRead.run({ url, escalate: true }, ctx)).toMatchObject({ isError: true });
      expect(await researchBrowse.run({ url, task: "read" }, ctx)).toMatchObject({ isError: true });
    }
    expect(read).not.toHaveBeenCalled();
    expect(browse).not.toHaveBeenCalled();
  });

  it("research_browse hands the task to the agent, and reports its failure", async () => {
    const browse = vi.fn(async ({ task }: { task: string }) => ({ output: `did: ${task}` }));
    const ok = await researchBrowse.run(
      { url: PAGE, task: "list the releases" },
      context({ research: research({ browser: { browse } }) }),
    );
    expect(ok.isError).toBeUndefined();
    expect(ok.content).toContain("did: list the releases");

    const failing = await researchBrowse.run(
      { url: PAGE, task: "t" },
      context({
        research: research({
          browser: {
            browse: async () => {
              throw new Error("out of credits");
            },
          },
        }),
      }),
    );
    expect(failing).toMatchObject({ isError: true });
    expect(failing.content).toMatch(/out of credits/);

    const missing = await researchBrowse.run({ url: PAGE, task: "t" }, context({ research: research() }));
    expect(missing).toMatchObject({ isError: true });
    expect(missing.content).toMatch(/BROWSER_USE_API_KEY/);
  });
});

describe("htmlToText", () => {
  it("drops scripts and styles, keeps the words, and decodes entities", () => {
    const text = htmlToText(
      "<html><head><title>T &amp; Co</title><style>p{color:red}</style></head>" +
        "<body><script>alert(1)</script><p>first</p><p>second &#8212; third</p></body></html>",
    );
    expect(text).toBe("T & Co\n\nfirst\nsecond — third");
  });
});

describe("the tool surface", () => {
  it("registers all twenty-four, in the canonical order", () => {
    expect(ALL.map((t) => t.name)).toEqual([
      "read_file",
      "list_dir",
      "write_file",
      "edit_file",
      "glob",
      "grep",
      "bash",
      "current_time",
      "ping",
      "web_search",
      "web_fetch",
      "attach_upload",
      "delete_file",
      "research_search",
      "research_read",
      "research_browse",
      "doc_skill",
      "doc_read",
      "doc_inspect",
      "doc_edit",
      "doc_render",
      "doc_diagram",
      "doc_chart",
      "doc_check",
    ]);
  });

  // The research tools are reads, which is exactly why they need a rule of
  // their own: `readonly` would otherwise hand a browser agent to a turn
  // that never asked for one.
  it("offers the research tools on the research preset alone", () => {
    const research = toolsFor("research").map((t) => t.name);
    expect(research).toEqual([
      "read_file",
      "list_dir",
      "write_file",
      "edit_file",
      "glob",
      "grep",
      "current_time",
      "research_search",
      "research_read",
      "research_browse",
    ]);

    for (const preset of ["standard", "readonly", "minimal", "ptc"] as const) {
      const names = toolsFor(preset).map((t) => t.name);
      expect(names).not.toContain("research_search");
      expect(names).not.toContain("research_read");
      expect(names).not.toContain("research_browse");
    }
    // And the standard preset is exactly what it was before they existed.
    expect(toolsFor("standard").map((t) => t.name)).toEqual(
      ALL.map((t) => t.name).filter((n) => !n.startsWith("research_") && !n.startsWith("doc_")),
    );
  });

  // The same rule for the document pipeline, and no shell on its preset:
  // the scripts behind the tools are the only way it runs anything.
  it("offers the document tools on the documentation preset alone", () => {
    expect(toolsFor("documentation").map((t) => t.name)).toEqual([
      "read_file",
      "list_dir",
      "write_file",
      "edit_file",
      "glob",
      "grep",
      "current_time",
      "web_search",
      "web_fetch",
      "attach_upload",
      "delete_file",
      "doc_skill",
      "doc_read",
      "doc_inspect",
      "doc_edit",
      "doc_render",
      "doc_diagram",
      "doc_chart",
      "doc_check",
    ]);
    for (const preset of ["standard", "readonly", "minimal", "ptc", "research"] as const) {
      expect(toolsFor(preset).some((t) => t.name.startsWith("doc_"))).toBe(false);
    }
  });

  it("withholds the shell when the deployment has not allowed it", () => {
    const names = (allowHostShell: boolean) =>
      toolsFor("standard", { allowHostShell }).map((t) => t.name);

    expect(names(true)).toContain("bash");
    expect(names(false)).not.toContain("bash");
    // Nothing else moves: the gate is orthogonal to the preset.
    expect(names(false)).toEqual(names(true).filter((n) => n !== "bash"));
  });

  it("keeps the readonly preset free of anything that writes or executes", () => {
    for (const tool of toolsFor("readonly")) expect(tool.permission).toBe("read");
  });

  // Several providers reject an empty tool result outright.
  const nonEmpty: [AnyTool, unknown][] = [
    [readFile, { path: "empty.txt", offset: null, limit: null }],
    [listDir, { path: "src" }],
    [glob, { pattern: "*.nothing", path: null }],
    [grep, { pattern: "zzz-no-such-text", path: null, glob: null, context: null }],
    [bash, { command: "true", timeout_ms: null }],
    [currentTime, { timezone: null }],
  ];

  it.each(nonEmpty)(
    "$name returns something even when there is nothing to say",
    async (tool, input) => {
      const result = await tool.run(input, context());
      expect(result.content.trim().length).toBeGreaterThan(0);
    },
  );

  // Every path-taking tool, refused at the same boundary.
  const pathTaking: [AnyTool, unknown][] = [
    [readFile, { path: "../../etc/passwd", offset: null, limit: null }],
    [listDir, { path: "../.." }],
    [writeFile, { path: "../../tmp/pwned", content: "x" }],
    [editFile, { path: "../../etc/passwd", old_string: "root", new_string: "x", replace_all: null }],
    [glob, { pattern: "*", path: "../.." }],
    [grep, { pattern: "root", path: "../../etc", glob: null, context: null }],
  ];

  it.each(pathTaking)("$name refuses a path outside the workspace", async (tool, input) => {
    const refusal = await tool
      .run(input, context())
      .then((result) => (result.isError ? result.content : null))
      .catch((error: unknown) => String(error));

    expect(refusal, "the call was allowed").not.toBeNull();
    expect(refusal).toMatch(/escapes the workspace|must be relative/);
  });
});
