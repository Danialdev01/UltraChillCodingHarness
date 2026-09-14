import { describe, expect, it } from "vitest";
import { extensionOf, isPreviewable, mediaTypeFor, previewKindFor } from "./media.js";

describe("reading an extension", () => {
  it("takes the last one, in lowercase, from the last path segment", () => {
    expect(extensionOf("public/images/Logo.PNG")).toBe("png");
    expect(extensionOf("archive.tar.gz")).toBe("gz");
    expect(extensionOf("a.png/b.txt")).toBe("txt");
  });

  it("gives a dotfile no extension", () => {
    // `.env` is a hidden file, not a file of type "env"; treating it as one
    // is how a dotfile ends up matched against a media list.
    expect(extensionOf(".env")).toBe("");
    expect(extensionOf("config/.gitignore")).toBe("");
    expect(extensionOf("Makefile")).toBe("");
  });
});

describe("what the file view previews", () => {
  it("shows the image formats as images", () => {
    for (const name of ["a.png", "a.jpg", "a.jpeg", "a.webp", "a.gif", "a.avif", "a.svg"]) {
      expect(previewKindFor(name), name).toBe("image");
    }
  });

  it("shows a pdf as a pdf", () => {
    expect(previewKindFor("docs/spec.pdf")).toBe("pdf");
    expect(mediaTypeFor("docs/spec.pdf")).toBe("application/pdf");
  });

  it("is case-insensitive, because a camera is not", () => {
    expect(previewKindFor("DSC_0001.JPG")).toBe("image");
    expect(mediaTypeFor("Scan.PDF")).toBe("application/pdf");
  });

  it("leaves source and text files to the editor", () => {
    for (const name of ["index.ts", "README.md", "styles.css", "data.json", "Makefile"]) {
      expect(previewKindFor(name), name).toBeNull();
      expect(isPreviewable(name), name).toBe(false);
    }
  });
});

describe("what it refuses to serve inline", () => {
  it("will not serve markup, script or anything else executable", () => {
    // The reason the mapping is an allow-list: any of these served inline
    // from this origin is script execution in the app's own context.
    for (const name of ["page.html", "page.htm", "app.js", "app.mjs", "doc.xml", "a.xhtml"]) {
      expect(mediaTypeFor(name), name).toBeNull();
    }
  });

  it("refuses a type it does not know rather than guessing one", () => {
    for (const name of ["clip.mp4", "archive.zip", "font.woff2", "binary", "a.exe"]) {
      expect(mediaTypeFor(name), name).toBeNull();
    }
  });

  it("decides from the extension alone, so a rename cannot change the type", () => {
    // The server sends `nosniff` alongside this, so a file's content never
    // gets a say either.
    expect(mediaTypeFor("actually-a-script.png")).toBe("image/png");
    expect(mediaTypeFor("actually-an-image.html")).toBeNull();
  });

  it("serves svg as svg, which the client renders in an img", () => {
    // Safe only in combination: this type plus the response CSP plus an
    // <img>, none of which runs script in the file.
    expect(mediaTypeFor("icon.svg")).toBe("image/svg+xml");
    expect(previewKindFor("icon.svg")).toBe("image");
  });
});
