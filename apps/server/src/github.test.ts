import { describe, expect, it } from "vitest";
import {
  GithubError,
  identify,
  listBranches,
  listRepos,
  redactToken,
  tokenAppliesTo,
} from "./github.js";

/** One repository as GitHub sends it, trimmed to the fields that are read. */
function repo(over: Record<string, unknown> = {}) {
  return {
    full_name: "ada/analytical-engine",
    clone_url: "https://github.com/ada/analytical-engine.git",
    private: false,
    default_branch: "main",
    description: "a machine",
    pushed_at: "2026-09-01T00:00:00Z",
    ...over,
  };
}

/**
 * A `fetch` that answers from a table of paths.
 *
 * The requests are recorded because half of what matters here is what was
 * asked for -- the token in a header rather than the URL, and the paging that
 * stops rather than running to the cap.
 */
function stub(
  answer: (path: string) => { status?: number; body?: unknown; headers?: Record<string, string> },
) {
  const calls: Array<{ path: string; headers: Record<string, string> }> = [];
  const fetch = async (url: string, init?: RequestInit) => {
    const path = url.replace("https://api.github.com", "");
    calls.push({ path, headers: (init?.headers ?? {}) as Record<string, string> });
    const { status = 200, body = {}, headers = {} } = answer(path);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
  };
  return { fetch, calls };
}

describe("listRepos", () => {
  it("reads a repository down to what the dialog needs", async () => {
    const { fetch } = stub(() => ({ body: [repo({ private: true })] }));
    const [only] = await listRepos("ghp_token", { fetch });

    expect(only).toEqual({
      fullName: "ada/analytical-engine",
      owner: "ada",
      name: "analytical-engine",
      private: true,
      defaultBranch: "main",
      cloneUrl: "https://github.com/ada/analytical-engine.git",
      description: "a machine",
      pushedAt: "2026-09-01T00:00:00Z",
    });
  });

  it("sends the token in a header and never in the URL", async () => {
    const { fetch, calls } = stub(() => ({ body: [] }));
    await listRepos("ghp_secret", { fetch });

    expect(calls[0]!.headers.authorization).toBe("Bearer ghp_secret");
    expect(calls[0]!.path).not.toContain("ghp_secret");
  });

  it("stops at the first short page rather than paging to the cap", async () => {
    const { fetch, calls } = stub(() => ({ body: [repo()] }));
    await listRepos("t", { fetch });
    expect(calls).toHaveLength(1);
  });

  it("keeps paging while the pages are full", async () => {
    const full = Array.from({ length: 100 }, (_, i) => repo({ full_name: `ada/r${i}` }));
    const { fetch, calls } = stub((path) => ({ body: path.includes("page=3") ? [] : full }));
    const repos = await listRepos("t", { fetch });

    expect(calls).toHaveLength(3);
    expect(repos).toHaveLength(200);
  });

  it("skips an entry it cannot read rather than failing the list", async () => {
    // A malformed row should cost that row, not every repository behind it.
    const { fetch } = stub(() => ({ body: [{ full_name: "no-slash" }, null, repo()] }));
    const repos = await listRepos("t", { fetch });
    expect(repos.map((r) => r.fullName)).toEqual(["ada/analytical-engine"]);
  });

  it("defaults a missing branch rather than leaving it empty", async () => {
    const { fetch } = stub(() => ({ body: [repo({ default_branch: undefined })] }));
    expect((await listRepos("t", { fetch }))[0]!.defaultBranch).toBe("main");
  });
});

describe("what a GitHub failure says to do about it", () => {
  it("blames the token on a 401, with the status the caller should pass on", async () => {
    const { fetch } = stub(() => ({ status: 401 }));
    await expect(listRepos("stale", { fetch })).rejects.toThrow(/rejected that token/);
    await expect(listRepos("stale", { fetch })).rejects.toMatchObject({ status: 401 });
  });

  it("tells a rate limit from a missing scope, which are both 403", async () => {
    const limited = stub(() => ({ status: 403, headers: { "x-ratelimit-remaining": "0" } }));
    await expect(listRepos("t", { fetch: limited.fetch })).rejects.toMatchObject({ status: 429 });

    const unscoped = stub(() => ({ status: 403, headers: { "x-ratelimit-remaining": "57" } }));
    await expect(listRepos("t", { fetch: unscoped.fetch })).rejects.toThrow(/`repo` scope/);
  });

  it("reads a 404 as either gone or invisible, because it is both", async () => {
    const { fetch } = stub(() => ({ status: 404 }));
    await expect(listBranches("t", "ada", "gone", { fetch })).rejects.toThrow(
      /no such repository, or the token cannot see it/,
    );
  });

  it("turns a network failure into a GithubError rather than leaking it", async () => {
    const fetch = async () => {
      throw new Error("EAI_AGAIN");
    };
    const failure = await listRepos("t", { fetch }).catch((e) => e);
    expect(failure).toBeInstanceOf(GithubError);
    expect(failure.status).toBe(502);
  });
});

describe("listBranches", () => {
  it("reads the branches and which one the repository defaults to", async () => {
    const { fetch } = stub((path) =>
      path.includes("/branches")
        ? { body: path.includes("&page=1") ? [{ name: "main" }, { name: "topic" }] : [] }
        : { body: { default_branch: "main" } },
    );

    expect(await listBranches("t", "ada", "engine", { fetch })).toEqual({
      branches: ["main", "topic"],
      defaultBranch: "main",
    });
  });

  it("offers the default even when it is past the pages that were read", async () => {
    const { fetch } = stub((path) =>
      path.includes("/branches")
        ? { body: [{ name: "topic" }] }
        : { body: { default_branch: "trunk" } },
    );

    // Preselecting a branch that is not in the list would leave the dialog
    // showing a value it cannot offer.
    const { branches, defaultBranch } = await listBranches("t", "ada", "engine", { fetch });
    expect(defaultBranch).toBe("trunk");
    expect(branches[0]).toBe("trunk");
  });

  it("asks for one page when the first one is short", async () => {
    const { fetch, calls } = stub((path) =>
      path.includes("/branches") ? { body: [{ name: "main" }] } : { body: {} },
    );
    await listBranches("t", "ada", "engine", { fetch });
    expect(calls.filter((c) => c.path.includes("/branches"))).toHaveLength(1);
  });

  it("keeps paging while a page comes back full", async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ name: `b${i}` }));
    const { fetch, calls } = stub((path) =>
      path.includes("/branches") ? { body: path.includes("&page=3") ? [] : full } : { body: {} },
    );
    const { branches } = await listBranches("t", "ada", "engine", { fetch });

    expect(calls.filter((c) => c.path.includes("/branches"))).toHaveLength(3);
    expect(branches).toHaveLength(200);
  });

  it("escapes the owner and repository into the path", async () => {
    const { fetch, calls } = stub(() => ({ body: {} }));
    await listBranches("t", "a b", "c/d", { fetch });
    expect(calls[0]!.path).toBe("/repos/a%20b/c%2Fd");
  });

  it("falls back to the first branch when the repository names no default", async () => {
    const { fetch } = stub((path) =>
      path.includes("/branches") ? { body: [{ name: "only" }] } : { body: {} },
    );
    expect(await listBranches("t", "ada", "engine", { fetch })).toMatchObject({
      defaultBranch: "only",
    });
  });
});

describe("identify", () => {
  it("reads the account a token belongs to", async () => {
    const { fetch } = stub(() => ({ body: { login: "ada", name: "Ada Lovelace" } }));
    expect(await identify("t", { fetch })).toEqual({ login: "ada", name: "Ada Lovelace" });
  });

  it("accepts an account with no display name", async () => {
    const { fetch } = stub(() => ({ body: { login: "ada" } }));
    expect(await identify("t", { fetch })).toEqual({ login: "ada", name: null });
  });
});

describe("tokenAppliesTo", () => {
  it("is the credential for a github.com HTTPS repository", () => {
    expect(tokenAppliesTo("https://github.com/ada/engine.git")).toBe(true);
  });

  it("is not offered to a host it does not belong to", () => {
    // git asks its credential helper about whatever host the URL names, so
    // this check is the only thing standing between the token and GitLab.
    for (const url of [
      "https://gitlab.com/ada/engine.git",
      "https://github.com.evil.example/ada/engine.git",
      "https://notgithub.com/ada/engine.git",
      "file:///srv/repos/engine",
      "not a url at all",
    ]) {
      expect(tokenAppliesTo(url)).toBe(false);
    }
  });

  it("is not a password for a transport that does not take one", () => {
    // ssh wants a key, and plain http would put it on the wire in the clear.
    expect(tokenAppliesTo("ssh://git@github.com/ada/engine.git")).toBe(false);
    expect(tokenAppliesTo("http://github.com/ada/engine.git")).toBe(false);
  });

  it("defers to credentials somebody already put in the URL", () => {
    expect(tokenAppliesTo("https://someone:else@github.com/ada/engine.git")).toBe(false);
  });
});

describe("redactToken", () => {
  it("takes the token out of what git said", () => {
    // git quotes the URL it was handed, which is how a credential ends up in
    // an error message, an event, and the dialog.
    const stderr =
      "fatal: could not read from 'https://x-access-token:ghp_x@github.com/ada/engine.git'";
    expect(redactToken(stderr, "ghp_x")).toBe(
      "fatal: could not read from 'https://x-access-token:***@github.com/ada/engine.git'",
    );
  });

  it("removes every occurrence, not the first", () => {
    expect(redactToken("ghp_x and ghp_x", "ghp_x")).toBe("*** and ***");
  });

  it("leaves text alone when there was no token", () => {
    expect(redactToken("fatal: repository not found", null)).toBe("fatal: repository not found");
  });
});
