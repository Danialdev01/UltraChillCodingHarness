import { describe, expect, it } from "vitest";
import { publicUrl, rewriteUploadUrls } from "./public-routes.js";

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
