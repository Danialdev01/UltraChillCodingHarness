import { describe, expect, it } from "vitest";
import { normalizeWorkspacePath } from "./paths.js";

describe("normalizeWorkspacePath", () => {
  it("normalizes ordinary paths", () => {
    expect(normalizeWorkspacePath("app/Http/Controllers/X.php")).toBe("app/Http/Controllers/X.php");
    expect(normalizeWorkspacePath("/routes/web.php")).toBe("routes/web.php");
    expect(normalizeWorkspacePath("./a//b/./c")).toBe("a/b/c");
    expect(normalizeWorkspacePath("a/b/../c")).toBe("a/c");
  });

  // The boundary that stops a client or an agent tool writing outside the mount.
  it("rejects traversal outside the workspace", () => {
    expect(normalizeWorkspacePath("../etc/passwd")).toBeNull();
    expect(normalizeWorkspacePath("a/../../etc/passwd")).toBeNull();
    expect(normalizeWorkspacePath("/../x")).toBeNull();
  });

  it("rejects empty paths and null bytes", () => {
    expect(normalizeWorkspacePath("")).toBeNull();
    expect(normalizeWorkspacePath("/")).toBeNull();
    expect(normalizeWorkspacePath("a\0b")).toBeNull();
  });

  // Traversal that only cancels out is fine; traversal that nets upward is not.
  it("counts traversal against what has been descended, not against the string", () => {
    expect(normalizeWorkspacePath("a/b/../../c")).toBe("c");
    expect(normalizeWorkspacePath("a/b/../../../c")).toBeNull();
  });
});
