import { describe, expect, it } from "vitest";

import {
  WIDGET_MAX_BYTES,
  WIDGET_PROMPT,
  WIDGET_TURN_NUDGE,
  asksForWidget,
  humaniseWidgetTitle,
  isShowWidgetTool,
  isWidgetLanguage,
  parseWidgetFence,
  widgetFileName,
  widgetFromToolUse,
  widgetId,
} from "./widgets.js";

const closed = { closed: true };

describe("parseWidgetFence", () => {
  it("reads metadata before ---", () => {
    const parsed = parseWidgetFence('{"title": "hosting_cost_calculator", "height": 520}\n---\n<div id="app"></div>\n', closed);
    expect(parsed).toEqual({
      status: "ready",
      title: "hosting_cost_calculator",
      height: 520,
      code: '<div id="app"></div>',
      kind: "html",
      loadingMessages: [],
    });
  });

  it("takes the whole body as the widget when there is no metadata", () => {
    const parsed = parseWidgetFence("<div>a</div>\n---\n<div>b</div>", closed);
    expect(parsed).toMatchObject({ status: "ready", title: null, code: "<div>a</div>\n---\n<div>b</div>" });
  });

  it("falls back to no metadata when the JSON is bad", () => {
    const parsed = parseWidgetFence("{not json}\n---\n<p>x</p>", closed);
    expect(parsed).toMatchObject({ status: "ready", title: null, code: "{not json}\n---\n<p>x</p>" });
  });

  it("splits at the first --- only", () => {
    const parsed = parseWidgetFence('{"title":"t"}\n---\n<p>a</p>\n---\n<p>b</p>', closed);
    expect(parsed).toMatchObject({ status: "ready", title: "t", code: "<p>a</p>\n---\n<p>b</p>" });
  });

  it("ignores metadata fields of the wrong type", () => {
    const parsed = parseWidgetFence('{"title": 5, "height": "big"}\n---\n<p>x</p>', closed);
    expect(parsed).toMatchObject({ status: "ready", title: null, height: null });
  });

  it("tells SVG from HTML", () => {
    expect(parseWidgetFence('<svg viewBox="0 0 10 10"></svg>', closed)).toMatchObject({ kind: "svg" });
    expect(parseWidgetFence('{"title":"d"}\n---\n  <svg></svg>', closed)).toMatchObject({ kind: "svg" });
    expect(parseWidgetFence('<?xml version="1.0"?>\n<svg></svg>', closed)).toMatchObject({ kind: "svg" });
    expect(parseWidgetFence("<div><svg></svg></div>", closed)).toMatchObject({ kind: "html" });
    expect(parseWidgetFence("<svgish>", closed)).toMatchObject({ kind: "html" });
  });

  it("does not run an unclosed fence, but reads what metadata there is", () => {
    expect(parseWidgetFence('{"title":"t","loading_messages":["Drawing…"]}\n---\n<div>', { closed: false })).toEqual({
      status: "streaming",
      title: "t",
      loadingMessages: ["Drawing…"],
    });
    expect(parseWidgetFence('{"title":"t"', { closed: false })).toEqual({
      status: "streaming",
      title: null,
      loadingMessages: [],
    });
    expect(parseWidgetFence("", { closed: false }).status).toBe("streaming");
  });

  it("refuses to run a widget over the size limit", () => {
    const parsed = parseWidgetFence(`<p>${"x".repeat(WIDGET_MAX_BYTES)}</p>`, closed);
    expect(parsed.status).toBe("too_large");
  });

  it("counts the limit in UTF-8 bytes", () => {
    // Under the limit in characters, over it in bytes.
    const parsed = parseWidgetFence("é".repeat(WIDGET_MAX_BYTES / 2 + 1), closed);
    expect(parsed.status).toBe("too_large");
  });
});

describe("widgetFromToolUse", () => {
  const input = { title: "flow", widget_code: "<svg></svg>", loading_messages: ["Drawing"] };

  it("reads the tool under every name it is surfaced as", () => {
    for (const name of ["show_widget", "mcp__omp__show_widget", "mcp:omp.show_widget"]) {
      expect(isShowWidgetTool(name)).toBe(true);
      expect(widgetFromToolUse(name, input)).toEqual({
        status: "ready",
        title: "flow",
        height: null,
        code: "<svg></svg>",
        kind: "svg",
        loadingMessages: ["Drawing"],
      });
    }
  });

  it("is null for other tools and not-yet-there input", () => {
    expect(widgetFromToolUse("bash", input)).toBeNull();
    expect(widgetFromToolUse("show_widget", null)).toBeNull();
    expect(widgetFromToolUse("show_widget", { title: "x" })).toMatchObject({ status: "streaming", title: "x" });
  });

  it("lets a metadata line in the code win", () => {
    const parsed = widgetFromToolUse("show_widget", { title: "a", widget_code: '{"title":"b"}\n---\n<p>x</p>' });
    expect(parsed).toMatchObject({ status: "ready", title: "b", code: "<p>x</p>" });
  });
});

describe("helpers", () => {
  it("knows the fence languages", () => {
    expect(isWidgetLanguage("widget")).toBe(true);
    expect(isWidgetLanguage("HTML-Render")).toBe(true);
    expect(isWidgetLanguage("html")).toBe(false);
    expect(isWidgetLanguage(null)).toBe(false);
  });

  it("ids are stable and differ by code", () => {
    expect(widgetId("<p>a</p>")).toBe(widgetId("<p>a</p>"));
    expect(widgetId("<p>a</p>")).not.toBe(widgetId("<p>b</p>"));
    expect(widgetId("x")).toMatch(/^w[0-9a-z]+$/);
  });

  it("humanises titles and names files", () => {
    expect(humaniseWidgetTitle("hosting_cost_calculator")).toBe("Hosting cost calculator");
    expect(humaniseWidgetTitle(null)).toBe("Widget");
    expect(widgetFileName("Hosting cost / calc!")).toBe("hosting_cost_calc.html");
    expect(widgetFileName(null)).toBe("widget.html");
  });

  it("the prompt teaches the fence and the rules", () => {
    expect(WIDGET_PROMPT).toContain("```widget");
    expect(WIDGET_PROMPT).toContain("show_widget");
    expect(WIDGET_PROMPT).toContain("sendPrompt(text)");
    expect(WIDGET_PROMPT).toContain("cdn.jsdelivr.net");
  });
});

describe("asksForWidget", () => {
  it("matches a request for a visual, however it is put", () => {
    for (const text of [
      "how much money do i spend if i use RM 10 per day for hosting. create a visualizer",
      "create the visualizer",
      "re generate the widget and create input box for me to input the days",
      "create a visual application inside this chat section for me to insert my total days",
      "Draw the request flow from browser → Next.js → Laravel API → MySQL",
      "can you visualise the bundle sizes",
      "make me a mortgage calculator",
      "show a chart of monthly signups",
      "an interactive diagram of the auth flow please",
    ]) {
      expect(asksForWidget(text), text).toBe(true);
    }
  });

  it("leaves ordinary coding requests alone", () => {
    for (const text of [
      "fix the failing test in src/api.ts",
      "what does this project do?",
      "rename getUser to fetchUser everywhere",
      "add a column for the user's email",
      "commit and push",
    ]) {
      expect(asksForWidget(text), text).toBe(false);
    }
  });
});

describe("the prompts", () => {
  it("say a widget is the only way to show something in the chat, and teach the format on their own", () => {
    expect(WIDGET_PROMPT).toMatch(/only way to show something in this chat/);
    expect(WIDGET_PROMPT).toMatch(/mods, plugins, skills or artifacts never appear here/);
    // The nudge stands alone: a resumed Codex session may never have seen the standing prompt.
    expect(WIDGET_TURN_NUDGE).toContain("`widget`");
    expect(WIDGET_TURN_NUDGE).toContain("---");
    expect(WIDGET_TURN_NUDGE).toContain("var(--fg)");
  });
});
