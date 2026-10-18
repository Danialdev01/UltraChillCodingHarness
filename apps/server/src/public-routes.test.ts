import { describe, expect, it } from "vitest";
import { publicUrl, rewriteUploadUrls } from "./public-routes.js";
import { isSecretPath, withoutSecrets } from "./files.js";

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
    for (const path of [".env", "apps/web/.env.local", "id_rsa", "certs/server.key", "tls.PEM", ".npmrc"]) {
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
