import { describe, expect, it } from "vitest";
import { slugify } from "./workspaces.js";

describe("slugify", () => {
  it("makes URL-safe slugs from ordinary names", () => {
    expect(slugify("Acme Inc")).toBe("acme-inc");
    expect(slugify("  Danial's Studio  ")).toBe("danial-s-studio");
    expect(slugify("R&D / Platform")).toBe("r-d-platform");
  });

  it("strips diacritics rather than dropping the letters", () => {
    expect(slugify("Café Zürich")).toBe("cafe-zurich");
  });

  it("never returns an empty slug", () => {
    // A name of only punctuation or non-Latin script would otherwise slugify
    // to "", which would collide with every other such name.
    expect(slugify("!!!")).toBe("workspace");
    expect(slugify("日本語")).toBe("workspace");
    expect(slugify("")).toBe("workspace");
  });

  it("bounds the length", () => {
    expect(slugify("x".repeat(200)).length).toBeLessThanOrEqual(48);
  });

  it("does not leave leading or trailing separators", () => {
    expect(slugify("--hello--")).toBe("hello");
    expect(slugify(" ... spaced ... ")).toBe("spaced");
  });
});
