import { describe, expect, it } from "vitest";
import { deriveProjectName, looksLikeRepoUrl } from "./repo-url.js";

describe("looksLikeRepoUrl", () => {
  const good = [
    "https://github.com/laravel/laravel.git",
    "https://github.com/laravel/laravel",
    "http://git.example.com/team/app.git",
    "ssh://git@github.com/owner/repo.git",
    "git://github.com/owner/repo.git",
    // The scp-like form git accepts and `new URL` does not.
    "git@github.com:owner/repo.git",
  ];
  it.each(good)("accepts %s", (url) => expect(looksLikeRepoUrl(url)).toBe(true));

  const notYet = [
    "",
    "https://",
    "https://github.com",
    "github.com/owner/repo",
    "not a url at all",
    // Refused by the server's whitelist too, but there is no reason to ask.
    "ext::sh -c whoami",
  ];
  it.each(notYet)("does not ask the server about %j", (url) =>
    expect(looksLikeRepoUrl(url)).toBe(false),
  );

  it("ignores surrounding whitespace, which a paste often carries", () => {
    expect(looksLikeRepoUrl("  https://github.com/owner/repo.git \n")).toBe(true);
  });
});

describe("deriveProjectName", () => {
  it("is the repository's own name", () => {
    expect(deriveProjectName("https://github.com/laravel/laravel.git")).toBe("laravel");
    expect(deriveProjectName("https://github.com/vercel/next.js")).toBe("next.js");
    expect(deriveProjectName("git@github.com:owner/my-app.git")).toBe("my-app");
    expect(deriveProjectName("https://github.com/owner/repo/")).toBe("repo");
  });

  it("drops a query or fragment a copied link brings with it", () => {
    expect(deriveProjectName("https://github.com/owner/repo.git?tab=readme#top")).toBe("repo");
  });

  it("is empty for an empty box, which leaves the field waiting", () => {
    expect(deriveProjectName("")).toBe("");
  });
});
