import { z } from "zod/v4";

/**
 * The browser tools, once: the native loop's tools (`@ucch/agent`), the
 * bridge's MCP tools (Claude Code, Codex) and OMP's host tools are all built
 * from these specs, and the server validates every call against the same
 * schema whichever door it came through.
 *
 * No Playwright here (`@ucch/browser/tools` is imported by packages that
 * must not load a browser driver). Every optional input is `.nullable()`,
 * never `.optional()`: the native loop sends these with `strict: true`.
 */

export type BrowserPermission = "read" | "write" | "exec";

export interface BrowserToolSpec<S extends z.ZodType = z.ZodType> {
  name: BrowserOp;
  description: string;
  permission: BrowserPermission;
  schema: S;
}

const session = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/)
  .nullable()
  .describe(
    "Browser session. Null: your own private browser. A name (e.g. \"checkout\") opens or joins a shared session " +
      "of this project: same cookies, logins and tabs for every agent that names it.",
  );
const tab = z.string().max(16).nullable().describe("Tab id from browser_tabs. Null: your current tab in the session.");
const ref = z.string().max(32).nullable().describe("Element ref from the latest snapshot, e.g. \"e12\".");
const selector = z.string().max(500).nullable().describe("CSS or Playwright selector, when no ref fits.");
const viewport = z
  .union([
    z.enum(["mobile", "tablet", "desktop", "wide"]),
    z.strictObject({
      width: z.number().int().min(240).max(3840),
      height: z.number().int().min(240).max(2400),
    }),
  ])
  .nullable()
  .describe(
    "Resize the tab first: mobile 390x844, tablet 820x1180, desktop 1440x900, wide 1920x1080, or an exact " +
      "{width, height} in CSS pixels (e.g. a breakpoint edge such as 767). Kept for later calls.",
  );

export const browserOpen = {
  name: "browser_open",
  description:
    "Open a real browser tab (headless Chromium), optionally at a URL. Use it when you need to SEE or OPERATE a " +
    "rendered page: study a site's visual design or animations to reference or reproduce, read content that only " +
    "renders with JavaScript, check a redesign or the dev server's pages, or test a layout at mobile/tablet/desktop " +
    "widths. For plain docs, APIs or articles, web_search and web_fetch are cheaper; use those instead. Opening a " +
    "tab makes the other browser tools available (navigate, act, screenshot, extract, design, motion, compare, " +
    "eval, tabs, logs, close). Returns the tab id and an accessibility snapshot whose [ref=eN] marks are what " +
    "browser_act operates on. People can watch and take over any tab in the Browser view.",
  permission: "read",
  schema: z.strictObject({
    session,
    url: z.string().max(4000).nullable().describe("Absolute http(s) URL to load. Null: about:blank."),
    new_tab: z.boolean().nullable().describe("Open another tab even if you already have one in this session."),
    viewport,
  }),
} satisfies BrowserToolSpec;

export const browserNavigate = {
  name: "browser_navigate",
  description: "Go to a URL, or back, forward or reload, in a tab. Returns the page's snapshot once it has loaded.",
  permission: "read",
  schema: z.strictObject({
    session,
    tab,
    url: z.string().max(4000).nullable().describe("Absolute http(s) URL. Required for goto."),
    action: z.enum(["goto", "back", "forward", "reload"]).nullable().describe("Default goto."),
    wait_until: z.enum(["load", "domcontentloaded", "networkidle"]).nullable().describe("Default load."),
  }),
} satisfies BrowserToolSpec;

export const browserSnapshot = {
  name: "browser_snapshot",
  description:
    "The page's accessibility tree as text, with a [ref=eN] on every element you can act on. Cheaper and more " +
    "reliable than a screenshot for finding and operating controls.",
  permission: "read",
  schema: z.strictObject({ session, tab, selector: selector.describe("Limit the snapshot to this element.") }),
} satisfies BrowserToolSpec;

export const browserAct = {
  name: "browser_act",
  description:
    "Operate the page: click, type, fill, press a key, select, hover, check, scroll, drag, upload, or wait. " +
    "Target an element by ref (from the last snapshot) or selector. Returns the snapshot after the action.",
  permission: "write",
  schema: z.strictObject({
    session,
    tab,
    action: z.enum([
      "click",
      "double_click",
      "right_click",
      "type",
      "fill",
      "press",
      "select",
      "hover",
      "check",
      "uncheck",
      "scroll",
      "drag",
      "upload",
      "wait",
    ]),
    ref,
    selector,
    text: z.string().max(20_000).nullable().describe("For type and fill: the text. For wait: text to wait for on the page."),
    key: z.string().max(64).nullable().describe("For press: e.g. Enter, Escape, Control+A. Without a target it goes to the page."),
    values: z.array(z.string().max(500)).max(50).nullable().describe("For select: option values or labels. For upload: workspace-relative file paths."),
    target_ref: z.string().max(32).nullable().describe("For drag: the element to drop on."),
    delta_y: z.number().nullable().describe("For scroll: pixels down (negative: up). Default one screen."),
    timeout_ms: z.number().int().min(100).max(60_000).nullable().describe("For wait, or how long to wait for the target. Default 10000."),
  }),
} satisfies BrowserToolSpec;

export const browserScreenshot = {
  name: "browser_screenshot",
  description:
    "Screenshot the tab, the full page, or one element, saved as a PNG under .agent/browser/shots/ and returned " +
    "as an image. Use it to check a layout or to show the person a result.",
  permission: "read",
  schema: z.strictObject({
    session,
    tab,
    full_page: z.boolean().nullable().describe("The whole scrollable page (capped at 8000px tall). Default false."),
    ref,
    selector,
    viewport,
    name: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/).nullable().describe("File name without extension. Default a timestamp."),
  }),
} satisfies BrowserToolSpec;

export const browserExtract = {
  name: "browser_extract",
  description:
    "Scrape the page as data: markdown (readable content), text, links, tables (rows of cells), meta (title, " +
    "description, Open Graph, headings outline), or html (outer HTML).",
  permission: "read",
  schema: z.strictObject({
    session,
    tab,
    format: z.enum(["markdown", "text", "links", "tables", "meta", "html"]),
    selector: selector.describe("Extract from this element only. Default the whole page."),
    max_chars: z.number().int().min(500).max(100_000).nullable().describe("Default 20000."),
  }),
} satisfies BrowserToolSpec;

export const browserDesign = {
  name: "browser_design",
  description:
    "Capture a page's design so you can reproduce or match it: colour palette, fonts and type scale, spacing, radii, " +
    "shadows, CSS custom properties, breakpoints, and the layout tree with boxes and flex/grid settings. Saves " +
    "design.json and a screenshot under .agent/browser/designs/; with html, also a standalone HTML copy of the " +
    "section with its computed styles inlined.",
  permission: "read",
  schema: z.strictObject({
    session,
    tab,
    selector: selector.describe("The section to capture. Default the whole page."),
    depth: z.number().int().min(1).max(12).nullable().describe("Layout tree depth. Default 5."),
    html: z.boolean().nullable().describe("Also write a self-contained HTML/CSS copy of the section."),
    name: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/).nullable().describe("Base file name. Default from the page's host."),
  }),
} satisfies BrowserToolSpec;

export const browserCompare = {
  name: "browser_compare",
  description:
    "Visual diff: compare a baseline PNG against another PNG, or against a fresh screenshot of a tab. Returns the " +
    "share of pixels that differ, where they differ, and a diff image. Use it to check a reproduction or a change.",
  permission: "read",
  schema: z.strictObject({
    baseline: z.string().max(500).describe("Workspace-relative PNG, e.g. a path browser_screenshot returned."),
    candidate: z.string().max(500).nullable().describe("Second PNG. Null: screenshot the tab now (session/tab/full_page)."),
    session,
    tab,
    full_page: z.boolean().nullable(),
    threshold: z.number().min(0).max(1).nullable().describe("Per-pixel colour tolerance, 0 to 1. Default 0.1."),
  }),
} satisfies BrowserToolSpec;

export const browserEval = {
  name: "browser_eval",
  description:
    "Run JavaScript in the page as the body of an async function and return its JSON result (use return). For " +
    "reading state the other tools do not expose.",
  permission: "exec",
  schema: z.strictObject({ session, tab, script: z.string().min(1).max(20_000) }),
} satisfies BrowserToolSpec;

export const browserTabs = {
  name: "browser_tabs",
  description:
    "List this project's browser sessions and their tabs (who opened each, which a person is controlling), switch " +
    "your current tab, or close one.",
  permission: "read",
  schema: z.strictObject({
    session,
    action: z.enum(["list", "switch", "close"]).nullable().describe("Default list."),
    tab: z.string().max(16).nullable().describe("For switch and close."),
  }),
} satisfies BrowserToolSpec;

export const browserLogs = {
  name: "browser_logs",
  description: "The tab's console messages, page errors and failed or erroring network requests, after a cursor.",
  permission: "read",
  schema: z.strictObject({
    session,
    tab,
    kind: z.enum(["console", "network", "all"]).nullable().describe("Default all."),
    since: z.number().int().min(0).nullable().describe("Cursor from the previous call. Default 0 (everything kept)."),
  }),
} satisfies BrowserToolSpec;

export const browserClose = {
  name: "browser_close",
  description: "Close a tab, or every tab you opened in a session (your private session closes entirely).",
  permission: "read",
  schema: z.strictObject({
    session,
    tab: z.string().max(16).nullable().describe("A tab to close. Null: all of yours in the session."),
  }),
} satisfies BrowserToolSpec;

export const browserMotion = {
  name: "browser_motion",
  description:
    "Study motion on a page: animations, transitions, hover effects, entry animations, scroll-driven and JS-driven " +
    "(GSAP, Framer Motion, Lenis, canvas/WebGL) effects, to describe, reference or reproduce them. " +
    "inspect: lists every running CSS animation, transition and Web Animation with its keyframes, duration, delay, " +
    "easing, iterations and timeline, plus JS-driven motion (elements whose inline style keeps changing, rAF " +
    "activity, animation libraries, canvases, videos). frames: a contact sheet of frames over time (CSS/WAAPI " +
    "animations are paused and seeked to exact times; JS/canvas motion is captured in real time). scroll: steps " +
    "the scroll position and captures each step, with what changed (transform, opacity, clip) at each one. " +
    "Frames and the sheet are saved under .agent/browser/motion/. Start with inspect, then frames or scroll.",
  permission: "read",
  schema: z.strictObject({
    session,
    tab,
    mode: z.enum(["inspect", "frames", "scroll"]),
    ref: ref.describe("Limit to this element (from the latest snapshot): inspect its subtree, crop frames to it, or for scroll, the range it passes through the viewport."),
    selector,
    viewport,
    trigger: z
      .enum(["hover", "focus", "reload"])
      .nullable()
      .describe("Start the motion first: hover or focus the element (ref/selector), or reload the page for entry animations. Default none: what is already running."),
    count: z.number().int().min(2).max(16).nullable().describe("frames and scroll: how many frames. Default 8 (scroll: 6)."),
    duration_ms: z
      .number()
      .int()
      .min(100)
      .max(10_000)
      .nullable()
      .describe("inspect: how long to watch (default 1500). frames: the span the frames cover (default: the animations' own length, else 2000)."),
    timing: z.enum(["auto", "seek", "realtime"]).nullable().describe("frames: seek pauses CSS/WAAPI animations and steps them exactly; realtime captures as it plays (needed for JS, canvas, video). Default auto."),
    from_y: z.number().int().min(0).nullable().describe("scroll: start position in px. Default the top (or where the ref enters the viewport)."),
    to_y: z.number().int().min(0).nullable().describe("scroll: end position in px. Default the bottom (or where the ref leaves)."),
    settle_ms: z.number().int().min(0).max(5000).nullable().describe("scroll: wait after each step. Default 300, 900 with smooth-scroll libraries."),
    reduced_motion: z.boolean().nullable().describe("Emulate prefers-reduced-motion: reduce for this call, to see the site's reduced-motion version."),
  }),
} satisfies BrowserToolSpec;

/** In this order everywhere: the native tool block is a cached prefix. */
export const BROWSER_TOOLS = [
  browserOpen,
  browserNavigate,
  browserSnapshot,
  browserAct,
  browserScreenshot,
  browserExtract,
  browserDesign,
  browserCompare,
  browserEval,
  browserTabs,
  browserLogs,
  browserClose,
  browserMotion,
] as const;

export type BrowserOp =
  | "browser_open"
  | "browser_navigate"
  | "browser_snapshot"
  | "browser_act"
  | "browser_screenshot"
  | "browser_extract"
  | "browser_design"
  | "browser_compare"
  | "browser_eval"
  | "browser_tabs"
  | "browser_logs"
  | "browser_close"
  | "browser_motion";

export const BROWSER_TOOL_NAMES: readonly BrowserOp[] = BROWSER_TOOLS.map((spec) => spec.name);

/**
 * The one browser tool offered before a thread has used the browser. Its
 * description says when a browser is the right tool; its first successful
 * call unlocks the rest (`BrowserToolset`), so a turn that never needs a
 * browser does not carry thirteen tool schemas.
 */
export const BROWSER_ENTRY: BrowserOp = "browser_open";

/** Which browser tools a turn is offered: none, the entry tool alone, or all of them. */
export type BrowserToolset = false | "entry" | "full";

export function isBrowserOp(name: string): name is BrowserOp {
  return (BROWSER_TOOL_NAMES as readonly string[]).includes(name);
}

export function browserSpec(name: BrowserOp): (typeof BROWSER_TOOLS)[number] {
  return BROWSER_TOOLS.find((spec) => spec.name === name)!;
}

export type BrowserInput<N extends BrowserOp> = z.infer<Extract<(typeof BROWSER_TOOLS)[number], { name: N }>["schema"]>;

/** A picture a browser call produced: on disk in the worktree, and inline for the model. */
export interface BrowserImage {
  mediaType: "image/png" | "image/jpeg";
  /** Base64, no `data:` prefix. */
  data: string;
  /** Workspace-relative path of the saved file. */
  path: string;
}

/** What every browser call answers, whichever door it came through. */
export interface BrowserResult {
  text: string;
  images?: BrowserImage[];
  isError?: boolean;
}

/**
 * A browser bound to one agent's turn: what the native tools and the OMP
 * host tools call. The server builds it; `@ucch/agent` only knows this shape.
 */
export interface BrowserProvider {
  call(op: BrowserOp, args: unknown, signal: AbortSignal): Promise<BrowserResult>;
}

/** The live-view state of one project, for the Browser panel. */
export interface BrowserTabInfo {
  id: string;
  title: string;
  url: string;
  /** The agent session (thread id) that opened it, or "human". */
  openedBy: string;
  /** Who is acting on it right now: an agent's thread id, a person's user id, or null. */
  busy: string | null;
  /** A person controlling it: agents may read it but not act on it. */
  controlledBy: string | null;
  viewport: { width: number; height: number };
}

export interface BrowserSessionInfo {
  name: string;
  /** Private sessions belong to one agent; shared ones are named. */
  shared: boolean;
  owner: string | null;
  tabs: BrowserTabInfo[];
  lastUsedAt: string;
}
