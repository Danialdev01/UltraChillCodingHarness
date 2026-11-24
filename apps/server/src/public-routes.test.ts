import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { publicUrl, registerPublicRoutes, rewriteUploadUrls } from "./public-routes.js";
import { isSecretPath, WorkspaceFiles, withoutSecrets } from "./files.js";

const project = { id: "p", hash: "h4cxt545betr", name: "x", slug: "x-abcdef" };

describe("rewriteUploadUrls", () => {
  it("re-addresses every upload URL and leaves the rest alone", () => {
    const json = JSON.stringify({
      cover: "/api/projects/h4cxt545betr/uploads/1/content",
      content: [{ src: "/api/projects/h4cxt545betr/uploads/2/content" }, { href: "https://example.com" }],
    });
    const out = rewriteUploadUrls(json, project);
    expect(out).not.toContain("h4cxt545betr");
    expect(out).toContain("/api/public/x-abcdef/uploads/1/content");
    expect(out).toContain("/api/public/x-abcdef/uploads/2/content");
    expect(out).toContain("https://example.com");
  });

  it("does not touch another project's URL", () => {
    expect(publicUrl("/api/projects/other/uploads/1/content", project)).toBe("/api/projects/other/uploads/1/content");
  });
});

describe("secret files on the public site", () => {
  it("refuses credentials in any folder", () => {
    for (const path of [".env", "apps/web/.env.local", "id_rsa", "certs/server.key", "tls.PEM", ".npmrc", ".agent/env.val", ".env/.", ".env/", "a/../.env", "a\\..\\.env", ".ssh/config", "../../x/.env"]) {
      expect(isSecretPath(path), path).toBe(true);
    }
  });

  it("serves templates and ordinary files", () => {
    for (const path of [".env.example", "env.ts", "src/keys.ts", "README.md", "environment/.gitkeep"]) {
      expect(isSecretPath(path), path).toBe(false);
    }
  });

  it("prunes them from the tree but keeps folders", () => {
    const tree = [{ name: "app", children: [{ name: ".env" }, { name: "main.ts" }] }, { name: ".env" }, { name: ".env.example" }];
    expect(withoutSecrets(tree)).toEqual([{ name: "app", children: [{ name: "main.ts" }] }, { name: ".env.example" }]);
  });
});

describe("the public file route", () => {
  it("serves no secret under any spelling or link, and still serves the rest", async () => {
    const root = await mkdtemp(join(tmpdir(), "ucch-public-"));
    const dir = join(root, "p");
    await mkdir(join(dir, "src"), { recursive: true });
    await mkdir(join(dir, ".ssh"));
    await writeFile(join(dir, ".env"), "DUMMY=1");
    await writeFile(join(dir, ".ssh", "config"), "Host x");
    await writeFile(join(dir, "src", "main.ts"), "export {}");
    await symlink(".env", join(dir, "notes.txt"));
    await symlink("src/main.ts", join(dir, "alias.ts"));
    await symlink(".ssh", join(dir, "docs"));
    const app = Fastify();
    registerPublicRoutes(app, {
      findPublic: async () => ({ ...project, id: "p" }),
      files: new WorkspaceFiles(root),
    } as never);
    const status = async (path: string) =>
      (await app.inject({ url: `/api/public/x-abcdef/file?path=${encodeURIComponent(path)}` })).statusCode;
    try {
      for (const path of [".env", ".env/.", "./.env", "src/../.env", "notes.txt", ".ssh/config", "docs/config"]) {
        expect(await status(path), path).toBe(404);
      }
      for (const path of ["src/main.ts", "./src/./main.ts", "alias.ts"]) expect(await status(path), path).toBe(200);
      expect([400, 404]).toContain(await status("../x"));
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
