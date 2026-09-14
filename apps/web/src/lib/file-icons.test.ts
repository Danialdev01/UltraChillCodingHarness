import { describe, expect, it } from "vitest";
import { iconNameFor, type IconManifest } from "./file-icons.js";

const manifest: IconManifest = {
  iconDefinitions: {},
  fileNames: { "package.json": "nodejs", dockerfile: "docker" },
  fileExtensions: { ts: "typescript", "test.ts": "test-ts", gitignore: "git", json: "json" },
  folderNames: { src: "folder-src" },
  folderNamesExpanded: { src: "folder-src-open" },
  file: "file",
  folder: "folder",
  folderExpanded: "folder-open",
};

describe("choosing a file icon", () => {
  it("matches the whole name before the extension", () => {
    expect(iconNameFor(manifest, "file", "package.json")).toBe("nodejs");
    expect(iconNameFor(manifest, "file", "other.json")).toBe("json");
  });

  it("is case-insensitive", () => {
    expect(iconNameFor(manifest, "file", "Dockerfile")).toBe("docker");
    expect(iconNameFor(manifest, "file", "APP.TS")).toBe("typescript");
  });

  it("prefers the longest matching extension", () => {
    expect(iconNameFor(manifest, "file", "app.test.ts")).toBe("test-ts");
    expect(iconNameFor(manifest, "file", "app.ts")).toBe("typescript");
  });

  it("reads a dotfile's name as its extension", () => {
    expect(iconNameFor(manifest, "file", ".gitignore")).toBe("git");
  });

  it("falls back to the default file icon", () => {
    expect(iconNameFor(manifest, "file", "LICENSE")).toBe("file");
    expect(iconNameFor(manifest, "file", "x.unknown")).toBe("file");
  });
});

describe("choosing a folder icon", () => {
  it("knows named folders, open and shut", () => {
    expect(iconNameFor(manifest, "folder", "src")).toBe("folder-src");
    expect(iconNameFor(manifest, "folder-open", "SRC")).toBe("folder-src-open");
  });

  it("falls back to the plain folder", () => {
    expect(iconNameFor(manifest, "folder", "misc")).toBe("folder");
    expect(iconNameFor(manifest, "folder-open", "misc")).toBe("folder-open");
  });
});
