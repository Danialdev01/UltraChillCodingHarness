import { describe, expect, it } from "vitest";

import {
  HTML_RENDER_MAX_HEIGHT,
  HTML_RENDER_MIN_HEIGHT,
  buildHtmlRenderDocument,
  htmlRenderTitle,
  isHtmlRenderLanguage,
  readLinkMessage,
  readSizeMessage,
  themeCss,
  themeMessage,
  type HtmlRenderTheme,
} from "./html-render";

const theme: HtmlRenderTheme = {
  mode: "dark",
  variables: { "--background": "light-dark(#fff, #000)", "--chart-1": "#7ba1fc" },
};

describe("isHtmlRenderLanguage", () => {
  it("accepts the render fences and nothing else", () => {
    expect(isHtmlRenderLanguage("html-render")).toBe(true);
    expect(isHtmlRenderLanguage("HTML-Render")).toBe(true);
    expect(isHtmlRenderLanguage("html")).toBe(false);
    expect(isHtmlRenderLanguage(null)).toBe(false);
  });
});

describe("themeCss", () => {
  it("writes the mode and tokens onto :root", () => {
    const css = themeCss(theme);
    expect(css).toContain("color-scheme:dark");
    expect(css).toContain("--background:light-dark(#fff, #000);");
    expect(css).toContain("--chart-1:#7ba1fc;");
  });

  it("cannot be broken out of", () => {
    const css = themeCss({
      mode: "light",
      variables: { "--x": "red}</style><script>alert(1)</script>", "bad name": "x" },
    });
    expect(css).not.toContain("</style>");
    expect(css).not.toContain("}<");
    expect(css).not.toContain("bad name");
  });
});

describe("buildHtmlRenderDocument", () => {
  it("wraps a fragment in a document with the bootstrap", () => {
    const doc = buildHtmlRenderDocument('<canvas id="c"></canvas>', theme);
    expect(doc.startsWith("<!doctype html><html><head>")).toBe(true);
    expect(doc).toContain('<style id="ucch-theme">');
    expect(doc).toContain("Content-Security-Policy");
    expect(doc).toContain("connect-src 'none'");
    expect(doc).toContain('<body><canvas id="c"></canvas></body>');
  });

  it("puts the bootstrap first inside an existing head", () => {
    const page = "<!doctype html><html><head><title>T</title></head><body>x</body></html>";
    const doc = buildHtmlRenderDocument(page, theme);
    expect(doc.indexOf('<style id="ucch-theme">')).toBeLessThan(doc.indexOf("<title>"));
    expect(doc.match(/<head>/g)).toHaveLength(1);
  });

  it("adds a head after <html> or the doctype when there is none", () => {
    expect(buildHtmlRenderDocument('<html lang="en"><body>x</body></html>', theme)).toMatch(
      /^<html lang="en"><head><meta charset/,
    );
    expect(buildHtmlRenderDocument("<!DOCTYPE html><p>x</p>", theme)).toMatch(
      /^<!DOCTYPE html><head><meta charset/,
    );
  });

  it("ignores a <head> inside the page's own script", () => {
    const page = '<script>const s = "<head>"</script><p>x</p>';
    const doc = buildHtmlRenderDocument(page, theme);
    expect(doc).toContain('const s = "<head>"');
    expect(doc.startsWith("<!doctype html><html><head>")).toBe(true);
  });
});

describe("messages", () => {
  it("reads and clamps a size report", () => {
    const size = (height: unknown) => ({ type: "ucch-html-render:size", height });
    expect(readSizeMessage(size(300.2))).toBe(301);
    expect(readSizeMessage(size(1))).toBe(HTML_RENDER_MIN_HEIGHT);
    expect(readSizeMessage(size(1e9))).toBe(HTML_RENDER_MAX_HEIGHT);
    expect(readSizeMessage(size("300"))).toBeUndefined();
    expect(readSizeMessage({ height: 300 })).toBeUndefined();
    expect(readSizeMessage(null)).toBeUndefined();
  });

  it("only passes http(s) links", () => {
    const link = (url: unknown) => ({ type: "ucch-html-render:link", url });
    expect(readLinkMessage(link("https://example.com/a"))).toBe("https://example.com/a");
    expect(readLinkMessage(link("javascript:alert(1)"))).toBeUndefined();
    expect(readLinkMessage(link("not a url"))).toBeUndefined();
    expect(readLinkMessage({ url: "https://example.com" })).toBeUndefined();
  });

  it("carries the theme css", () => {
    expect(themeMessage(theme)).toEqual({ type: "ucch-html-render:theme", css: themeCss(theme) });
  });
});

describe("htmlRenderTitle", () => {
  it("reads the page title", () => {
    expect(htmlRenderTitle("<title>  Build\n times </title>")).toBe("Build times");
    expect(htmlRenderTitle("<p>no title</p>")).toBeNull();
  });
});
