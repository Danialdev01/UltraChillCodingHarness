import { describe, expect, it } from "vitest";

import {
  connectionHref,
  connectionIdFromPath,
  docViewFromParam,
  HOME,
  projectHref,
  projectSessionHashFromPath,
  SECTIONS,
  sectionEntry,
  sectionHref,
  workspaceHashFromPath,
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
  SETTINGS,
  WORKSPACE_SETTINGS,
  workspaceSettingsPageFromPath,
  workspaceSettingsPageHref,
} from "./sections";

const NOTE = "3f2a9c1e-6b4d-4e8f-9a0b-1c2d3e4f5a6b";
const WS = "wkspc0hash00";
const P = "rdhm15c4hl8o";
const SESSION = "s3ss10nhash0";

describe("workspaceHashFromPath", () => {
  it("reads the workspace from every page under it", () => {
    expect(workspaceHashFromPath(`/${WS}`)).toBe(WS);
    expect(workspaceHashFromPath(`/${WS}/`)).toBe(WS);
    expect(workspaceHashFromPath(`/${WS}/database`)).toBe(WS);
    expect(workspaceHashFromPath(`/${WS}/p/${P}/${SESSION}`)).toBe(WS);
  });

  it("is null for global pages and anything that is not a hash", () => {
    expect(workspaceHashFromPath("/")).toBeNull();
    expect(workspaceHashFromPath("/setting/account")).toBeNull();
    expect(workspaceHashFromPath("/rdhm15c4hl8")).toBeNull();
    expect(workspaceHashFromPath("/RDHM15C4HL8O")).toBeNull();
  });
});

describe("projectHref", () => {
  it("builds the address the server's webPathOf does", () => {
    expect(projectHref(WS, "session", P)).toBe(`/${WS}/s/${P}`);
    expect(projectHref(WS, "project", P)).toBe(`/${WS}/p/${P}`);
    expect(projectHref(WS, "project", P, SESSION)).toBe(`/${WS}/p/${P}/${SESSION}`);
    // A session workspace's session is the project; there is no thread level.
    expect(projectHref(WS, "session", P, SESSION)).toBe(`/${WS}/s/${P}`);
  });
});

describe("projectHashFromPath", () => {
  it("reads a project, its sessions and its pages", () => {
    expect(projectHashFromPath(`/${WS}/p/${P}`)).toBe(P);
    expect(projectHashFromPath(`/${WS}/p/${P}/`)).toBe(P);
    expect(projectHashFromPath(`/${WS}/p/${P}/${SESSION}`)).toBe(P);
    expect(projectHashFromPath(`/${WS}/p/${P}/documentation`)).toBe(P);
  });

  it("reads a session workspace's session", () => {
    expect(projectHashFromPath(`/${WS}/s/${P}`)).toBe(P);
  });

  it("is null for the workspace's own pages, the root, and anything that is not a hash", () => {
    expect(projectHashFromPath(`/${WS}`)).toBeNull();
    expect(projectHashFromPath(`/${WS}/database`)).toBeNull();
    expect(projectHashFromPath("/")).toBeNull();
    expect(projectHashFromPath(`/${P}`)).toBeNull();
    expect(projectHashFromPath(`/${WS}/p/rdhm15c4hl8`)).toBeNull();
    expect(projectHashFromPath(`/${WS}/x/${P}`)).toBeNull();
  });
});

describe("projectSessionHashFromPath", () => {
  it("names the project session in view", () => {
    expect(projectSessionHashFromPath(`/${WS}/p/${P}/${SESSION}`)).toBe(SESSION);
    expect(projectSessionHashFromPath(`/${WS}/p/${P}/${SESSION}/`)).toBe(SESSION);
  });

  it("is null on the project's pages and in a session workspace", () => {
    expect(projectSessionHashFromPath(`/${WS}/p/${P}`)).toBeNull();
    expect(projectSessionHashFromPath(`/${WS}/p/${P}/tasks`)).toBeNull();
    expect(projectSessionHashFromPath(`/${WS}/s/${P}`)).toBeNull();
  });
});

describe("sectionForPath", () => {
  it("lights the dashboard for the workspace, its projects and sessions", () => {
    expect(sectionForPath(`/${WS}`).id).toBe("dashboard");
    expect(sectionForPath(`/${WS}/p/${P}/${SESSION}`).id).toBe("dashboard");
    expect(sectionForPath(`/${WS}/p/${P}/tasks`).id).toBe("dashboard");
    expect(sectionForPath(`/${WS}/s/${P}`).id).toBe("dashboard");
  });

  it("gives the root its own section rather than the dashboard's", () => {
    expect(sectionForPath("/").id).toBe("home");
  });

  it("matches a workspace section and its subpaths", () => {
    expect(sectionForPath(`/${WS}/database`).id).toBe("database");
    expect(sectionForPath(`/${WS}/database/abc/shop`).id).toBe("database");
    expect(sectionForPath(`/${WS}/workspace-settings/members`).id).toBe("workspace-settings");
  });

  it("matches the account's settings outside any workspace", () => {
    expect(sectionForPath("/setting").id).toBe("setting");
    expect(sectionForPath("/setting/api").id).toBe("setting");
  });
});

describe("sectionHref / sectionEntry", () => {
  it("puts workspace sections under the workspace and leaves global ones alone", () => {
    expect(sectionHref(SECTIONS[0], WS)).toBe(`/${WS}`);
    expect(sectionHref(SECTIONS[1], WS)).toBe(`/${WS}/database`);
    expect(sectionEntry(WORKSPACE_SETTINGS, WS)).toBe(`/${WS}/workspace-settings/general`);
    expect(sectionHref(HOME, WS)).toBe("/");
    expect(sectionEntry(SETTINGS, WS)).toBe("/setting/account");
  });
});

describe("projectPageFromPath", () => {
  it("names the page under a project", () => {
    expect(projectPageFromPath(`/${WS}/p/${P}/documentation`)).toBe("documentation");
    expect(projectPageFromPath(`/${WS}/p/${P}/timeline/`)).toBe("timeline");
    expect(projectPageFromPath(`/${WS}/p/${P}/tasks`)).toBe("tasks");
    expect(projectPageFromPath(projectPageHref(WS, P, "manage"))).toBe("manage");
  });

  it("stays on the page for routes below it", () => {
    expect(projectPageFromPath(`/${WS}/p/${P}/documentation/${NOTE}`)).toBe("documentation");
  });

  it("is null for the project itself, its sessions, and anything it does not have", () => {
    expect(projectPageFromPath(`/${WS}/p/${P}`)).toBeNull();
    expect(projectPageFromPath(`/${WS}/p/${P}/${SESSION}`)).toBeNull();
    // Activity is a tab on Manage now, and Keys one in the Documentation;
    // their old URLs only redirect there.
    expect(projectPageFromPath(`/${WS}/p/${P}/activity`)).toBeNull();
    expect(projectPageFromPath(`/${WS}/p/${P}/keys`)).toBeNull();
    expect(projectPageFromPath(`/${WS}/p/${P}/settings`)).toBeNull();
    expect(projectPageFromPath("/setting/notes")).toBeNull();
  });
});

describe("SETTINGS.entry", () => {
  it("is the page /setting redirects to, so the rail skips the redirect", () => {
    expect(SETTINGS.entry).toBe(settingsPageHref("account"));
    expect(sectionForPath(SETTINGS.entry).id).toBe("setting");
  });
});

describe("WORKSPACE_SETTINGS", () => {
  it("is where the rail's settings icon goes", () => {
    expect(sectionEntry(WORKSPACE_SETTINGS, WS)).toBe(workspaceSettingsPageHref(WS, "general"));
    expect(sectionForPath(sectionEntry(WORKSPACE_SETTINGS, WS)).id).toBe("workspace-settings");
  });

  it("names its pages and nothing else", () => {
    expect(workspaceSettingsPageFromPath(`/${WS}/workspace-settings/members`)).toBe("members");
    expect(workspaceSettingsPageFromPath(`/${WS}/workspace-settings/nope`)).toBeNull();
    expect(workspaceSettingsPageFromPath("/workspace-settings/members")).toBeNull();
    expect(workspaceSettingsPageFromPath("/setting/account")).toBeNull();
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
    expect(settingsPageFromPath(`/${WS}/p/${P}/keys`)).toBeNull();
  });
});

describe("noteHref / noteIdFromPath", () => {
  it("puts the root at /documentation and every other page below it", () => {
    expect(noteHref(WS, P, null)).toBe(`/${WS}/p/${P}/documentation`);
    expect(noteHref(WS, P, NOTE, NOTE)).toBe(`/${WS}/p/${P}/documentation`);
    expect(noteHref(WS, P, NOTE)).toBe(`/${WS}/p/${P}/documentation/${NOTE}`);
  });

  it("round-trips a page id and is null everywhere else", () => {
    expect(noteIdFromPath(noteHref(WS, P, NOTE))).toBe(NOTE);
    expect(noteIdFromPath(`/${WS}/p/${P}/documentation`)).toBeNull();
    expect(noteIdFromPath(`/${WS}/p/${P}/documentation/not-a-uuid`)).toBeNull();
    expect(noteIdFromPath(`/${WS}/p/${P}/timeline/${NOTE}`)).toBeNull();
  });
});

describe("databasePathFromPath", () => {
  it("reads connection, database and table", () => {
    expect(databasePathFromPath(`/${WS}/database/abc/shop`)).toEqual({ connectionId: "abc", db: "shop", table: null });
    expect(databasePathFromPath(`/${WS}/database/abc/shop/orders/`)).toEqual({ connectionId: "abc", db: "shop", table: "orders" });
    expect(databasePathFromPath(databaseHref(WS, "abc", "my db", "a/b"))).toEqual({ connectionId: "abc", db: "my db", table: "a/b" });
  });

  it("is null elsewhere", () => {
    expect(databasePathFromPath(`/${WS}/database`)).toBeNull();
    expect(databasePathFromPath(`/${WS}/database/abc`)).toBeNull();
    expect(databasePathFromPath("/database/abc/shop")).toBeNull();
    expect(databasePathFromPath(`/${WS}`)).toBeNull();
  });

  it("round-trips a connection's own page", () => {
    expect(connectionIdFromPath(connectionHref(WS, "a b"))).toBe("a b");
    expect(connectionIdFromPath(`/${WS}/database/abc/shop`)).toBeNull();
  });
});

describe("docViewFromParam", () => {
  it("names the documentation view, keys included", () => {
    expect(docViewFromParam("keys")).toBe("keys");
    expect(docViewFromParam("diagrams")).toBe("diagrams");
  });

  it("falls back to the notes", () => {
    expect(docViewFromParam(null)).toBe("notes");
    expect(docViewFromParam("nope")).toBe("notes");
  });
});
