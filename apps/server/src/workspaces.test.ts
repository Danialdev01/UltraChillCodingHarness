import { describe, expect, it } from "vitest";
import type { Database } from "@ucch/db";
import type { WorkspaceRole } from "@ucch/protocol";
import { PUBLIC_SLUG, publicSlugFor, slugify, WorkspaceService, type ProjectSummary } from "./workspaces.js";

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
  it("is the name as a slug, then twelve characters, and matches the address shape", () => {
    const slug = publicSlugFor("My Project!");
    expect(slug).toMatch(/^my-project-[a-z0-9]{12}$/);
    expect(PUBLIC_SLUG.test(slug)).toBe(true);
  });

  it("falls back to a word when the name slugifies to nothing", () => {
    expect(publicSlugFor("!!!")).toMatch(/^(project|workspace)-[a-z0-9]{12}$/);
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
    expect(PUBLIC_SLUG.test("timermimer-fk1zf0a9b2c3")).toBe(true);
    expect(PUBLIC_SLUG.test("timermimer-fk1zf0a9")).toBe(false);
  });
});

describe("a project's OMP trust (OM7.6)", () => {
  /** The project as `findByHash` finds it for a caller of `role`, or not at all; and what was written. */
  function service(role: WorkspaceRole | null, stored = false) {
    const writes: unknown[] = [];
    const chain: Record<string, unknown> = {};
    for (const step of ["from", "where", "set"]) chain[step] = () => chain;
    chain.limit = () => Promise.resolve([{ trusted: stored }]);
    const db = {
      select: () => chain,
      update: () => ({ set: (values: unknown) => ({ where: () => (writes.push(values), Promise.resolve()) }) }),
    } as unknown as Database;
    class Found extends WorkspaceService {
      override async findByHash(): Promise<ProjectSummary | null> {
        if (!role) return null;
        return {
          id: "p1",
          membership: { role, canCreateProject: null, canCreateSession: null },
        } as unknown as ProjectSummary;
      }
    }
    return { svc: new Found(db), writes };
  }

  it("is shown to every member, and says who may change it", async () => {
    expect(await service("viewer", true).svc.ompTrust("h", "u")).toEqual({ trusted: true, canChange: false });
    expect(await service("member").svc.ompTrust("h", "u")).toEqual({ trusted: false, canChange: false });
    expect(await service("admin").svc.ompTrust("h", "u")).toEqual({ trusted: false, canChange: true });
    expect(await service("owner").svc.ompTrust("h", "u")).toEqual({ trusted: false, canChange: true });
    expect(await service(null).svc.ompTrust("h", "u")).toBeNull();
  });

  it("is changed by a workspace admin or owner only", async () => {
    for (const role of ["viewer", "member"] as const) {
      const { svc, writes } = service(role);
      expect(await svc.setOmpTrust("h", "u", true)).toEqual({ error: "forbidden" });
      expect(writes).toEqual([]);
    }
    for (const role of ["admin", "owner"] as const) {
      const { svc, writes } = service(role);
      expect(await svc.setOmpTrust("h", "u", true)).toEqual({ trusted: true, canChange: true });
      expect(writes).toEqual([{ ompTrusted: true }]);
    }
    const missing = service(null);
    expect(await missing.svc.setOmpTrust("h", "u", true)).toBeNull();
    expect(missing.writes).toEqual([]);
  });
});
