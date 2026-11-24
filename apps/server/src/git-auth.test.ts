import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { accountCovers, gitAuthFor, type GitAuthSource } from "./git-auth.js";
import { CREDENTIAL_HELPER, runGit } from "./git-exec.js";

const source = (over: Partial<GitAuthSource> & { id: string }): GitAuthSource => ({
  provider: "gitea",
  baseUrl: "https://git.example.com",
  login: "ada",
  token: () => `token-${over.id}`,
  ...over,
});

describe("accountCovers", () => {
  it("is for repositories on the same server", () => {
    expect(accountCovers("https://github.com", "https://github.com/ada/engine.git")).toBe(true);
    expect(accountCovers("https://github.com", "https://www.github.com/ada/engine.git")).toBe(true);
    expect(accountCovers("http://localhost:3000", "http://localhost:3000/a/b.git")).toBe(true);
  });

  it("is not offered to a host, port, scheme or path it does not belong to", () => {
    for (const url of [
      "https://git.example.com.evil/a/b.git",
      "https://evil.example.com/a/b.git",
      "https://git.example.com:8443/a/b.git",
      "http://git.example.com/a/b.git",
      "ssh://git@git.example.com/a/b.git",
      "https://someone:else@git.example.com/a/b.git",
      "file:///srv/a",
      "not a url",
    ]) {
      expect(accountCovers("https://git.example.com", url), url).toBe(false);
    }
  });

  it("compares a server's own path by whole segments", () => {
    const base = "https://example.com/gitea";
    expect(accountCovers(base, "https://example.com/gitea/a/b.git")).toBe(true);
    expect(accountCovers(base, "https://example.com/gitea-evil/a/b.git")).toBe(false);
    expect(accountCovers(base, "https://example.com/gitea/../other/b.git")).toBe(false);
  });
});

describe("gitAuthFor", () => {
  const url = "https://git.example.com/a/b.git";

  it("prefers the project's account, and otherwise the first that covers the URL", () => {
    const sources = [source({ id: "1" }), source({ id: "2" })];
    expect(gitAuthFor(url, sources, "2")?.token).toBe("token-2");
    expect(gitAuthFor(url, sources)?.token).toBe("token-1");
    expect(gitAuthFor(url, sources, "gone")?.token).toBe("token-1");
  });

  it("never uses a preferred account for another server", () => {
    const sources = [source({ id: "1" }), source({ id: "2", baseUrl: "https://other.example.com" })];
    expect(gitAuthFor(url, sources, "2")?.token).toBe("token-1");
    expect(gitAuthFor("https://nowhere.example.com/a/b", sources, "2")).toBeNull();
  });

  it("decrypts only the account it uses, and skips one it cannot read", () => {
    let other = 0;
    const sources = [source({ id: "1", token: () => null }), source({ id: "2" }), source({ id: "3", token: () => (other++, "x") })];
    expect(gitAuthFor(url, sources)?.token).toBe("token-2");
    expect(other).toBe(0);
  });

  it("uses each host's own username", () => {
    const name = (provider: GitAuthSource["provider"]) => gitAuthFor(url, [source({ id: "1", provider })])?.username;
    expect(name("github")).toBe("x-access-token");
    expect(name("gitlab")).toBe("oauth2");
    expect(name("gitea")).toBe("ada");
  });
});

describe("the credential helper", () => {
  const fill = (asked: string) =>
    execFileSync("git", ["-c", `credential.https://git.example.com.helper=${CREDENTIAL_HELPER}`, "credential", "fill"], {
      input: `url=${asked}\n\n`,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
      env: {
        PATH: process.env.PATH ?? "",
        HOME: "/tmp",
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        UCCH_GIT_TOKEN: "secret",
        UCCH_GIT_USERNAME: "ada",
      },
    });

  it("answers for its own host and no other", () => {
    expect(fill("https://git.example.com/a/b.git")).toMatch(/username=ada\npassword=secret/);
    expect(() => fill("https://evil.example.com/a/b.git")).toThrow();
    expect(() => fill("http://git.example.com/a/b.git")).toThrow();
  });

  it("is refused for plain http to a public address, before git runs", async () => {
    const auth = { origin: "http://93.184.216.34", username: "a", token: "t" };
    await expect(runGit(["ls-remote", "http://93.184.216.34/a.git"], "/tmp", 5_000, { auth })).rejects.toThrow(/private network/);
  });
});
