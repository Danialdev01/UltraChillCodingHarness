import { describe, expect, it } from "vitest";
import { PUBLIC_SLUG, publicSlugFor, slugify } from "./workspaces.js";

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

describe("publicSlugFor", () => {
  it("is the name as a slug, then six characters, and matches the address shape", () => {
    const slug = publicSlugFor("My Project!");
    expect(slug).toMatch(/^my-project-[a-z0-9]{6}$/);
    expect(PUBLIC_SLUG.test(slug)).toBe(true);
  });

  it("falls back to a word when the name slugifies to nothing", () => {
    expect(publicSlugFor("!!!")).toMatch(/^(project|workspace)-[a-z0-9]{6}$/);
  });

  it("differs between calls", () => {
    expect(publicSlugFor("x")).not.toBe(publicSlugFor("x"));
  });
});

describe("PUBLIC_SLUG", () => {
  it("refuses a project hash, a section, and a bare name", () => {
    for (const bad of ["h4cxt545betr", "dashboard", "file-icons", "timermimer", "-abcdef", "a--b-abcdef!"]) {
      expect(PUBLIC_SLUG.test(bad)).toBe(false);
    }
    expect(PUBLIC_SLUG.test("timermimer-fk1zf0")).toBe(true);
  });
});
