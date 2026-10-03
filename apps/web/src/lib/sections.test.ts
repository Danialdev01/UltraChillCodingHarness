import { describe, expect, it } from "vitest";

import {
  noteHref,
  noteIdFromPath,
  projectHashFromPath,
  projectPageFromPath,
  projectPageHref,
  sectionForPath,
  settingsPageFromPath,
  databaseHref,
  databasePathFromPath,
  settingsPageHref,
} from "./sections";

const NOTE = "3f2a9c1e-6b4d-4e8f-9a0b-1c2d3e4f5a6b";

describe("projectHashFromPath", () => {
  it("reads a project page", () => {
    expect(projectHashFromPath("/rdhm15c4hl8o")).toBe("rdhm15c4hl8o");
    expect(projectHashFromPath("/rdhm15c4hl8o/")).toBe("rdhm15c4hl8o");
  });

  it("reads a project's own pages", () => {
    expect(projectHashFromPath("/rdhm15c4hl8o/documentation")).toBe("rdhm15c4hl8o");
  });

  it("is null for a section, the root, and anything that is not a hash", () => {
    expect(projectHashFromPath("/dashboard")).toBeNull();
    expect(projectHashFromPath("/")).toBeNull();
    expect(projectHashFromPath("/rdhm15c4hl8")).toBeNull();
    expect(projectHashFromPath("/rdhm15c4hl8oX")).toBeNull();
    expect(projectHashFromPath("/RDHM15C4HL8O")).toBeNull();
  });
});

describe("sectionForPath", () => {
  it("lights Code for a project page and the pages under it", () => {
    expect(sectionForPath("/rdhm15c4hl8o").id).toBe("code");
    expect(sectionForPath("/rdhm15c4hl8o/keys").id).toBe("code");
  });

  it("matches a section and its subpaths", () => {
    expect(sectionForPath("/setting").id).toBe("setting");
    expect(sectionForPath("/setting/api").id).toBe("setting");
  });
});

describe("projectPageFromPath", () => {
  it("names the page under a project", () => {
    expect(projectPageFromPath("/rdhm15c4hl8o/documentation")).toBe("documentation");
    expect(projectPageFromPath("/rdhm15c4hl8o/timeline/")).toBe("timeline");
    expect(projectPageFromPath(projectPageHref("rdhm15c4hl8o", "keys"))).toBe("keys");
    expect(projectPageFromPath("/rdhm15c4hl8o/activity")).toBe("activity");
  });

  it("stays on the page for routes below it", () => {
    expect(projectPageFromPath(`/rdhm15c4hl8o/documentation/${NOTE}`)).toBe("documentation");
  });

  it("is null for the project itself and for anything it does not have", () => {
    expect(projectPageFromPath("/rdhm15c4hl8o")).toBeNull();
    expect(projectPageFromPath("/rdhm15c4hl8o/settings")).toBeNull();
    expect(projectPageFromPath("/rdhm15c4hl8o/preview/index.html")).toBeNull();
    expect(projectPageFromPath("/setting/notes")).toBeNull();
  });
});

describe("settingsPageFromPath", () => {
  it("names the page of Settings", () => {
    expect(settingsPageFromPath("/setting/api")).toBe("api");
    expect(settingsPageFromPath("/setting/theme/")).toBe("theme");
    expect(settingsPageFromPath(settingsPageHref("usage"))).toBe("usage");
    expect(settingsPageFromPath("/setting/activity")).toBe("activity");
  });

  it("is null at the root and for anything Settings does not have", () => {
    expect(settingsPageFromPath("/setting")).toBeNull();
    expect(settingsPageFromPath("/setting/nope")).toBeNull();
    expect(settingsPageFromPath("/rdhm15c4hl8o/keys")).toBeNull();
  });
});

describe("noteHref / noteIdFromPath", () => {
  it("puts the root at /documentation and every other page below it", () => {
    expect(noteHref("rdhm15c4hl8o", null)).toBe("/rdhm15c4hl8o/documentation");
    expect(noteHref("rdhm15c4hl8o", NOTE, NOTE)).toBe("/rdhm15c4hl8o/documentation");
    expect(noteHref("rdhm15c4hl8o", NOTE)).toBe(`/rdhm15c4hl8o/documentation/${NOTE}`);
  });

  it("round-trips a page id and is null everywhere else", () => {
    expect(noteIdFromPath(noteHref("rdhm15c4hl8o", NOTE))).toBe(NOTE);
    expect(noteIdFromPath("/rdhm15c4hl8o/documentation")).toBeNull();
    expect(noteIdFromPath("/rdhm15c4hl8o/documentation/not-a-uuid")).toBeNull();
    expect(noteIdFromPath(`/rdhm15c4hl8o/timeline/${NOTE}`)).toBeNull();
  });
});

describe("databasePathFromPath", () => {
  it("reads connection, database and table", () => {
    expect(databasePathFromPath("/database/abc/shop")).toEqual({ connectionId: "abc", db: "shop", table: null });
    expect(databasePathFromPath("/database/abc/shop/orders/")).toEqual({ connectionId: "abc", db: "shop", table: "orders" });
    expect(databasePathFromPath(databaseHref("abc", "my db", "a/b"))).toEqual({ connectionId: "abc", db: "my db", table: "a/b" });
  });

  it("is null elsewhere", () => {
    expect(databasePathFromPath("/database")).toBeNull();
    expect(databasePathFromPath("/database/abc")).toBeNull();
    expect(databasePathFromPath("/dashboard")).toBeNull();
  });
});
