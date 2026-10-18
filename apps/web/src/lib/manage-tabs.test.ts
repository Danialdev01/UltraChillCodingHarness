import { describe, expect, it } from "vitest";
import { manageTabOf } from "./manage-tabs.js";

describe("manageTabOf", () => {
  it("opens on the tab the query names", () => {
    expect(manageTabOf("activity")).toBe("activity");
    expect(manageTabOf(["preferences", "git"])).toBe("preferences");
  });

  it("falls back to Git for anything else", () => {
    expect(manageTabOf(undefined)).toBe("git");
    expect(manageTabOf("nope")).toBe("git");
  });
});
