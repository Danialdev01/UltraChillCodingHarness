import { describe, expect, it } from "vitest";

import { projectHashFromPath, sectionForPath } from "./sections";

describe("projectHashFromPath", () => {
  it("reads a project page", () => {
    expect(projectHashFromPath("/rdhm15c4hl8o")).toBe("rdhm15c4hl8o");
    expect(projectHashFromPath("/rdhm15c4hl8o/")).toBe("rdhm15c4hl8o");
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
  it("lights Code for a project page", () => {
    expect(sectionForPath("/rdhm15c4hl8o").id).toBe("code");
  });

  it("matches a section and its subpaths", () => {
    expect(sectionForPath("/setting").id).toBe("setting");
    expect(sectionForPath("/setting/api").id).toBe("setting");
  });
});
