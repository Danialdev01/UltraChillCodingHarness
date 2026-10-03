import { describe, expect, it } from "vitest";
import { classifyEmbedUrl, isBareUrl } from "./embed-url";

describe("classifyEmbedUrl", () => {
  it("reads every YouTube form", () => {
    for (const url of [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://youtu.be/dQw4w9WgXcQ",
      "https://youtube.com/shorts/dQw4w9WgXcQ",
      "https://www.youtube.com/embed/dQw4w9WgXcQ",
      "https://m.youtube.com/watch?v=dQw4w9WgXcQ&list=x",
    ]) {
      expect(classifyEmbedUrl(url)).toMatchObject({
        provider: "youtube",
        src: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
      });
    }
  });
  it("keeps a start time", () => {
    expect(classifyEmbedUrl("https://youtu.be/dQw4w9WgXcQ?t=1m30s")?.src).toMatch(/\?start=90$/);
    expect(classifyEmbedUrl("https://youtu.be/dQw4w9WgXcQ?t=42")?.src).toMatch(/\?start=42$/);
  });
  it("treats a YouTube link without a valid id as any other link", () => {
    expect(classifyEmbedUrl("https://www.youtube.com/watch?v=short")).toMatchObject({
      provider: "generic",
    });
  });
  it("knows Vimeo, Loom, Figma and CodePen", () => {
    expect(classifyEmbedUrl("https://vimeo.com/123456")).toMatchObject({
      provider: "vimeo",
      src: "https://player.vimeo.com/video/123456",
    });
    expect(
      classifyEmbedUrl("https://www.loom.com/share/0123456789abcdef0123456789abcdef"),
    ).toMatchObject({ provider: "loom" });
    expect(classifyEmbedUrl("https://www.figma.com/design/abc/Thing")).toMatchObject({
      provider: "figma",
    });
    expect(classifyEmbedUrl("https://codepen.io/someone/pen/abcdef")).toMatchObject({
      provider: "codepen",
      src: "https://codepen.io/someone/embed/abcdef?default-tab=result",
    });
  });
  it("frames any other https link as it is, and refuses the rest", () => {
    expect(classifyEmbedUrl("https://example.com/page")).toEqual({
      provider: "generic",
      src: "https://example.com/page",
      original: "https://example.com/page",
    });
    expect(classifyEmbedUrl("http://example.com/page")).toBeNull();
    expect(classifyEmbedUrl("javascript:alert(1)")).toBeNull();
    expect(classifyEmbedUrl("not a url")).toBeNull();
  });
});

describe("isBareUrl", () => {
  it("is one link and nothing else", () => {
    expect(isBareUrl(" https://youtu.be/x \n")).toBe(true);
    expect(isBareUrl("see https://youtu.be/x")).toBe(false);
    expect(isBareUrl("hello")).toBe(false);
  });
});
