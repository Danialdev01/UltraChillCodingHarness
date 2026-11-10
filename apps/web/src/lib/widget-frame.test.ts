import { describe, expect, it } from "vitest";

import {
  WIDGET_MAX_HEIGHT,
  WIDGET_MIN_HEIGHT,
  WIDGET_PROMPT_MAX,
  WIDGET_SANDBOX,
  buildWidgetDocument,
  documentTitle,
  fixPrompt,
  inlineHeight,
  isFenceClosed,
  readWidgetMessage,
  standaloneWidgetHtml,
  themeCss,
  themeMessage,
  widgetCsp,
  type WidgetTheme,
} from "./widget-frame";

const theme: WidgetTheme = {
  mode: "dark",
  variables: { "--background": "light-dark(#fff, #000)", "--chart-1": "#7ba1fc" },
};

const html = (code: string) => ({ code, kind: "html" as const });

describe("sandbox", () => {
  it("is scripts only, never same-origin or navigation", () => {
    expect(WIDGET_SANDBOX).toBe("allow-scripts");
    for (const flag of ["allow-same-origin", "allow-top-navigation", "allow-popups", "allow-forms"]) {
      expect(WIDGET_SANDBOX).not.toContain(flag);
    }
  });
});

describe("widgetCsp", () => {
  it("allows inline code and the CDN, and no network", () => {
    const csp = widgetCsp();
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'unsafe-inline' https://cdn.jsdelivr.net");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("img-src data: blob:");
    expect(csp).toContain("form-action 'none'");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toMatch(/https:(?!\/\/)/);
  });

  it("takes its script origins from the allowlist and drops anything malformed", () => {
    const csp = widgetCsp(["https://unpkg.com", "http://evil.test", "https://x.test; connect-src *", "'unsafe-eval'"]);
    expect(csp).toContain("script-src 'unsafe-inline' https://unpkg.com;");
    expect(csp).not.toContain("evil");
    expect(csp).not.toContain("connect-src *");
    expect(csp).not.toContain("unsafe-eval");
  });
});

describe("themeCss", () => {
  it("writes the mode, tokens and short aliases onto :root", () => {
    const css = themeCss(theme);
    expect(css).toContain("color-scheme:dark");
    expect(css).toContain("--background:light-dark(#fff, #000);");
    expect(css).toContain("--chart-1:#7ba1fc;");
    expect(css).toContain("--bg:var(--background)");
    expect(css).toContain("--fg:var(--foreground)");
  });

  it("gives --muted and --accent the prompt's meaning, text and highlight, and keeps the app's tones under -bg", () => {
    const css = themeCss({
      mode: "light",
      variables: { "--muted": "#f4f4f5", "--muted-foreground": "#71717a", "--accent": "#f4f4f5", "--accent-foreground": "#18181b", "--primary": "#18181b" },
    });
    expect(css).toContain("--muted-bg:#f4f4f5;");
    expect(css).toContain("--accent-bg:#f4f4f5;");
    expect(css).toContain("--accent-bg-foreground:#18181b;");
    expect(css).toContain("--muted:var(--muted-foreground)");
    expect(css).toContain("--accent:var(--primary)");
    expect(css).toContain("--accent-fg:var(--primary-foreground)");
    expect(css).not.toContain("--muted:#f4f4f5");
    expect(css).not.toContain("--accent:#f4f4f5");
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

describe("buildWidgetDocument", () => {
  it("wraps a fragment with the CSP first, then theme and bootstrap", () => {
    const doc = buildWidgetDocument(html('<canvas id="c"></canvas>'), theme, "w1");
    expect(doc.startsWith("<!doctype html><html><head><meta charset")).toBe(true);
    expect(doc.indexOf("Content-Security-Policy")).toBeLessThan(doc.indexOf("<script>"));
    expect(doc).toContain(`content="${widgetCsp()}"`);
    expect(doc).toContain('<style id="ucch-theme">');
    expect(doc).toContain('<body><canvas id="c"></canvas></body>');
    expect(doc).toContain("window.sendPrompt=");
    expect(doc).toContain('ID="w1"');
    expect(doc).not.toContain("allow-same-origin");
  });

  it("centres raw SVG", () => {
    const doc = buildWidgetDocument({ code: "<svg></svg>", kind: "svg" }, theme, "w1");
    expect(doc).toContain('<body><div class="ucch-svg"><svg></svg></div></body>');
    expect(doc).toContain("Content-Security-Policy");
  });

  it("puts the head markup first inside a full document's head", () => {
    const page = "<!doctype html><html><head><title>T</title></head><body>x</body></html>";
    const doc = buildWidgetDocument(html(page), theme, "w1");
    expect(doc.indexOf("Content-Security-Policy")).toBeLessThan(doc.indexOf("<title>"));
    expect(doc.match(/<head>/g)).toHaveLength(1);
  });

  it("adds a head after <html> or the doctype when there is none", () => {
    expect(buildWidgetDocument(html('<html lang="en"><body>x</body></html>'), theme, "w")).toMatch(
      /^<html lang="en"><head><meta charset/,
    );
    expect(buildWidgetDocument(html("<!DOCTYPE html><p>x</p>"), theme, "w")).toMatch(/^<!DOCTYPE html><head><meta charset/);
  });

  it("ignores a <head> inside the page's own script", () => {
    const doc = buildWidgetDocument(html('<script>const s = "<head>"</script><p>x</p>'), theme, "w");
    expect(doc).toContain('const s = "<head>"');
    expect(doc.startsWith("<!doctype html><html><head>")).toBe(true);
  });

  it("cannot be broken out of through the id", () => {
    const doc = buildWidgetDocument(html("<p>x</p>"), theme, '"</script><script>alert(1)//');
    expect(doc).not.toContain("alert(1)//\"");
    expect(doc.match(/<\/script>/g)).toHaveLength(1);
  });
});

describe("standaloneWidgetHtml", () => {
  it("is a full document with the CSP, a title and an opaque background", () => {
    const doc = standaloneWidgetHtml({ code: "<p>x</p>", kind: "html", title: "cost <calc>" }, theme);
    expect(doc).toContain("Content-Security-Policy");
    expect(doc).toContain("<title>cost calc</title>");
    expect(doc).toContain("html{background:var(--background)}");
  });
});

describe("readWidgetMessage", () => {
  const msg = (type: string, rest: Record<string, unknown>, id = "w1") => ({ type: `ucch-widget:${type}`, id, ...rest });

  it("reads each message type", () => {
    expect(readWidgetMessage(msg("resize", { height: 300.2 }), "w1")).toEqual({ type: "resize", height: 301 });
    expect(readWidgetMessage(msg("error", { message: "x is not defined" }), "w1")).toEqual({
      type: "error",
      message: "x is not defined",
    });
    expect(readWidgetMessage(msg("prompt", { text: " more " }), "w1")).toEqual({ type: "prompt", text: "more" });
    expect(readWidgetMessage(msg("link", { url: "https://example.com/a" }), "w1")).toEqual({
      type: "link",
      url: "https://example.com/a",
    });
  });

  it("ignores another frame's id, unknown types and bad fields", () => {
    expect(readWidgetMessage(msg("resize", { height: 300 }, "w2"), "w1")).toBeUndefined();
    expect(readWidgetMessage(msg("navigate", { url: "https://x.test" }), "w1")).toBeUndefined();
    expect(readWidgetMessage(msg("resize", { height: "300" }), "w1")).toBeUndefined();
    expect(readWidgetMessage(msg("link", { url: "javascript:alert(1)" }), "w1")).toBeUndefined();
    expect(readWidgetMessage(msg("prompt", { text: "x".repeat(WIDGET_PROMPT_MAX + 1) }), "w1")).toBeUndefined();
    expect(readWidgetMessage(msg("prompt", { text: "   " }), "w1")).toBeUndefined();
    expect(readWidgetMessage(null, "w1")).toBeUndefined();
    expect(readWidgetMessage({ type: "ucch-html-render:size", height: 300 }, "w1")).toBeUndefined();
  });

  it("carries the theme css", () => {
    expect(themeMessage(theme)).toEqual({ type: "ucch-widget:theme", css: themeCss(theme) });
  });
});

describe("inlineHeight", () => {
  it("clamps to the inline range", () => {
    expect(inlineHeight(10)).toBe(WIDGET_MIN_HEIGHT);
    expect(inlineHeight(400.5)).toBe(401);
    expect(inlineHeight(5000)).toBe(WIDGET_MAX_HEIGHT);
  });
});

describe("isFenceClosed", () => {
  const span = (text: string) => [text, 0, text.length] as const;

  it("is closed once the matching marker arrives", () => {
    expect(isFenceClosed(...span("```widget\n<p>x</p>\n```"))).toBe(true);
    expect(isFenceClosed(...span("````widget\n```\n````\n"))).toBe(true);
  });

  it("is open while streaming", () => {
    expect(isFenceClosed(...span("```widget\n<p>x</p>"))).toBe(false);
    expect(isFenceClosed(...span("```widget\n<p>x</p>\n``"))).toBe(false);
    expect(isFenceClosed(...span("````widget\n```"))).toBe(false);
    expect(isFenceClosed(...span("```widget"))).toBe(false);
    expect(isFenceClosed("x", undefined, undefined)).toBe(false);
  });
});

describe("helpers", () => {
  it("reads a page title and writes the fix prompt", () => {
    expect(documentTitle("<title>  Build\n times </title>")).toBe("Build times");
    expect(documentTitle("<p>no title</p>")).toBeNull();
    expect(fixPrompt("Cost", "x is not defined")).toBe('The widget "Cost" failed with: x is not defined. Please fix it.');
  });
});
