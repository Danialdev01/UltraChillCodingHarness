import { describe, expect, it } from "vitest";
import { isValidRepoName, suggestRepoName } from "./github-api.js";

describe("isValidRepoName", () => {
  it("accepts the names a repository is actually called", () => {
    for (const name of ["app", "my-new-app", "my_app", "app.v2", "App2"]) {
      expect(isValidRepoName(name)).toBe(true);
    }
  });

  it("refuses what would not be a name", () => {
    // A name is not a path, and `.`/`..` are not names.
    for (const name of ["", "   ", "a/b", "a b", "..", ".", "a".repeat(101)]) {
      expect(isValidRepoName(name)).toBe(false);
    }
  });

  it("ignores the whitespace around one", () => {
    expect(isValidRepoName("  app  ")).toBe(true);
  });
});

describe("suggestRepoName", () => {
  it("turns a typed phrase into the name it means", () => {
    expect(suggestRepoName("my new app")).toBe("my-new-app");
  });

  it("drops what a repository name may not hold rather than substituting it", () => {
    expect(suggestRepoName("app/v2!")).toBe("appv2");
  });

  it("collapses a run of spaces into one dash", () => {
    expect(suggestRepoName("a   b")).toBe("a-b");
  });

  it("never leads with a dot, which is not a name", () => {
    expect(suggestRepoName("..hidden")).toBe("hidden");
  });

  it("always produces something the field will accept", () => {
    for (const typed of ["my new app", "app/v2!", "..x", "a".repeat(200)]) {
      expect(isValidRepoName(suggestRepoName(typed))).toBe(true);
    }
  });

  it("leaves a name that is already one alone", () => {
    expect(suggestRepoName("my-app")).toBe("my-app");
  });
});
