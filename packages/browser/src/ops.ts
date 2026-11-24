import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Locator, Page } from "playwright-core";
import { BrowserError, type BrowserManager, type BrowserScope, type Session, type Tab } from "./manager.js";
import {
  compareInPage,
  contactSheetInPage,
  designInPage,
  extractInPage,
  inlineHtmlInPage,
  motionPauseInPage,
  motionResumeInPage,
  motionSeekInPage,
  motionStartInPage,
  motionStopInPage,
  scrollJumpInPage,
  scrollRangeInPage,
  scrollSampleInPage,
  type CompareOutcome,
  type DesignNode,
  type MotionAnimation,
  type MotionReport,
} from "./page-scripts.js";
import type { BrowserImage, BrowserInput, BrowserOp, BrowserResult } from "./tools.js";

const VIEWPORTS = {
  mobile: { width: 390, height: 844 },
  tablet: { width: 820, height: 1180 },
  desktop: { width: 1440, height: 900 },
  wide: { width: 1920, height: 1080 },
} as const;

const SNAPSHOT_CHARS = 24_000;
const MAX_SHOT_HEIGHT = 8000;
/** Above this, the picture the model sees is a JPEG; the PNG on disk stays exact. */
const INLINE_PNG_BYTES = 3_000_000;

export async function runOp(manager: BrowserManager, scope: BrowserScope, op: BrowserOp, args: never, signal?: AbortSignal): Promise<BrowserResult> {
  signal?.throwIfAborted();
  switch (op) {
    case "browser_open":
      return open(manager, scope, args);
    case "browser_navigate":
      return navigate(manager, scope, args);
    case "browser_snapshot":
      return withCurrent(manager, scope, args, false, async (s, tab) => ({ text: await snapshot(s, tab, (args as BrowserInput<"browser_snapshot">).selector) }));
    case "browser_act":
      return act(manager, scope, args);
    case "browser_screenshot":
      return screenshot(manager, scope, args);
    case "browser_extract":
      return extract(manager, scope, args);
    case "browser_design":
      return design(manager, scope, args);
    case "browser_compare":
      return compare(manager, scope, args);
    case "browser_eval":
      return evaluate(manager, scope, args);
    case "browser_tabs":
      return tabs(manager, scope, args);
    case "browser_logs":
      return logs(manager, scope, args);
    case "browser_close":
      return close(manager, scope, args);
    case "browser_motion":
      return motion(manager, scope, args);
  }
}

// ---- helpers -----------------------------------------------------------------

/** Runs a page script with a `__name` shim: tsx and vitest compile with esbuild's keepNames, whose helper the page lacks. */
export async function inPage<A, R>(page: Page, fn: (args: A) => R, args: A): Promise<Awaited<R>> {
  return page.evaluate(`(() => { const __name = (f) => f; return (${fn.toString()})(${JSON.stringify(args)}); })()`) as Promise<Awaited<R>>;
}

function header(session: Session, tab: Tab): string {
  return `[session ${session.name} · tab ${tab.id}] ${tab.page.url()}`;
}

async function snapshot(session: Session, tab: Tab, selector: string | null = null): Promise<string> {
  const page = tab.page;
  const title = await page.title().catch(() => "");
  let tree: string;
  try {
    tree = selector ? await page.locator(selector).first().ariaSnapshot({ mode: "ai", timeout: 5000 }) : await page.ariaSnapshot({ mode: "ai", timeout: 10_000 });
  } catch (error) {
    tree = `(no snapshot: ${error instanceof Error ? error.message.split("\n")[0] : String(error)})`;
  }
  if (tree.length > SNAPSHOT_CHARS) tree = `${tree.slice(0, SNAPSHOT_CHARS)}\n… snapshot cut at ${SNAPSHOT_CHARS} characters; pass a selector to see one region.`;
  return `${header(session, tab)}\nTitle: ${title}\n\n${tree}`;
}

function requireUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BrowserError(`${JSON.stringify(raw)} is not an absolute URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new BrowserError(`${url.protocol} is not allowed; only http and https.`);
  return url;
}

async function goto(page: Page, url: string, waitUntil: "load" | "domcontentloaded" | "networkidle" = "load"): Promise<string> {
  const response = await page.goto(requireUrl(url).href, { waitUntil });
  const status = response?.status();
  return status && status >= 400 ? ` (HTTP ${status})` : "";
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(250);
}

/** The session and the agent's current tab, held for `fn`. */
async function withCurrent(
  manager: BrowserManager,
  scope: BrowserScope,
  args: { session: string | null; tab?: string | null },
  act: boolean,
  fn: (session: Session, tab: Tab) => Promise<BrowserResult>,
): Promise<BrowserResult> {
  const session = await manager.open(scope, args.session);
  const tab = manager.tab(session, scope.agentId, args.tab ?? null);
  if (!tab) throw new BrowserError(`No tab is open in ${session.name}. Use browser_open first.`);
  return manager.withTab(session, tab, scope.agentId, act, () => fn(session, tab));
}

function target(page: Page, ref: string | null, selector: string | null): Locator | null {
  if (ref) return page.getByRef(ref.replace(/^ref=/, ""));
  if (selector) return page.locator(selector).first();
  return null;
}

/** A path inside the worktree, or a refusal: uploads and comparisons read only the agent's own files. */
function confined(worktree: string, path: string): string {
  const full = resolve(worktree, path);
  const rel = relative(worktree, full);
  if (rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).includes(".git")) throw new BrowserError(`${path} is outside the workspace.`);
  return full;
}

async function artifact(scope: BrowserScope, folder: string, name: string): Promise<{ full: string; rel: string }> {
  const dir = join(scope.worktree, ".agent", "browser", folder);
  await mkdir(dir, { recursive: true });
  const full = join(dir, name);
  return { full, rel: relative(scope.worktree, full) };
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
}

async function capture(tab: Tab, options: { fullPage: boolean; locator: Locator | null }): Promise<Buffer> {
  if (options.locator) return options.locator.screenshot({ type: "png", animations: "disabled", timeout: 10_000 });
  const page = tab.page;
  if (!options.fullPage) return page.screenshot({ type: "png", animations: "disabled" });
  const size = await inPage(page, () => ({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight }), null);
  const viewport = page.viewportSize() ?? { width: 1280, height: 800 };
  return page.screenshot({
    type: "png",
    fullPage: true,
    animations: "disabled",
    clip: { x: 0, y: 0, width: Math.max(viewport.width, Math.min(size.w, 4000)), height: Math.min(size.h, MAX_SHOT_HEIGHT) },
  });
}

async function image(tab: Tab, png: Buffer, rel: string, fullPage: boolean, locator: Locator | null): Promise<BrowserImage> {
  if (png.length <= INLINE_PNG_BYTES) return { mediaType: "image/png", data: png.toString("base64"), path: rel };
  const jpeg = locator
    ? await locator.screenshot({ type: "jpeg", quality: 70 })
    : await tab.page.screenshot({ type: "jpeg", quality: 70, fullPage, clip: undefined });
  return { mediaType: "image/jpeg", data: jpeg.toString("base64"), path: rel };
}

type Viewport = BrowserInput<"browser_open">["viewport"];

async function applyViewport(tab: Tab, viewport: Viewport): Promise<string> {
  if (!viewport) return "";
  const size = typeof viewport === "string" ? VIEWPORTS[viewport] : viewport;
  await tab.page.setViewportSize({ width: size.width, height: size.height });
  return ` (viewport ${typeof viewport === "string" ? `${viewport} ` : ""}${size.width}x${size.height})`;
}

// ---- ops ---------------------------------------------------------------------

async function open(manager: BrowserManager, scope: BrowserScope, args: BrowserInput<"browser_open">): Promise<BrowserResult> {
  const session = await manager.open(scope, args.session);
  const currentId = session.current.get(scope.agentId);
  const own = (currentId && session.tabs.get(currentId)) ||
    [...session.tabs.values()].find((t) => t.openedBy === scope.agentId) ||
    // Asked for no page in particular: one a person opened for this agent will do.
    (!args.url && session.owner === scope.agentId ? [...session.tabs.values()].at(-1) : undefined);
  const tab = own && !args.new_tab ? own : await manager.newTab(session, scope.agentId);
  return manager.withTab(session, tab, scope.agentId, Boolean(args.url), async () => {
    const sized = await applyViewport(tab, args.viewport);
    const status = args.url ? await goto(tab.page, args.url) : "";
    const others = [...session.tabs.values()].filter((t) => t !== tab);
    const note = session.shared
      ? `Shared session ${session.name}: ${others.length ? `${others.length} other tab(s) (browser_tabs lists them)` : "no other tabs yet"}.`
      : `Your private session${others.length ? `. Other tabs: ${others.map((t) => `${t.id}${t.name ? ` ${JSON.stringify(t.name)}` : ""} ${t.page.url()}`).join("; ")}` : ""}.`;
    return { text: `Opened tab ${tab.id}${status}${sized}. ${note}\n\n${await snapshot(session, tab)}` };
  });
}

async function navigate(manager: BrowserManager, scope: BrowserScope, args: BrowserInput<"browser_navigate">): Promise<BrowserResult> {
  return withCurrent(manager, scope, args, true, async (session, tab) => {
    const page = tab.page;
    const waitUntil = args.wait_until ?? "load";
    let status = "";
    switch (args.action ?? "goto") {
      case "goto":
        if (!args.url) throw new BrowserError("goto needs a url.");
        status = await goto(page, args.url, waitUntil);
        break;
      case "back":
        if (!(await page.goBack({ waitUntil }))) status = " (no previous page)";
        break;
      case "forward":
        if (!(await page.goForward({ waitUntil }))) status = " (no next page)";
        break;
      case "reload":
        await page.reload({ waitUntil });
        break;
    }
    return { text: `${status ? `Navigated${status}.\n` : ""}${await snapshot(session, tab)}` };
  });
}

async function act(manager: BrowserManager, scope: BrowserScope, args: BrowserInput<"browser_act">): Promise<BrowserResult> {
  return withCurrent(manager, scope, args, true, async (session, tab) => {
    const page = tab.page;
    const timeout = args.timeout_ms ?? 10_000;
    const el = target(page, args.ref, args.selector);
    const need = (what: string) => {
      if (!el) throw new BrowserError(`${args.action} needs a ref or selector${what ? ` and ${what}` : ""}.`);
      return el;
    };
    let note = "";
    switch (args.action) {
      case "click":
        await need("").click({ timeout });
        break;
      case "double_click":
        await need("").dblclick({ timeout });
        break;
      case "right_click":
        await need("").click({ button: "right", timeout });
        break;
      case "hover":
        await need("").hover({ timeout });
        break;
      case "check":
        await need("").check({ timeout });
        break;
      case "uncheck":
        await need("").uncheck({ timeout });
        break;
      case "fill":
        if (args.text === null) throw new BrowserError("fill needs text.");
        await need("text").fill(args.text, { timeout });
        break;
      case "type":
        if (args.text === null) throw new BrowserError("type needs text.");
        if (el) await el.pressSequentially(args.text, { delay: 15, timeout });
        else await page.keyboard.type(args.text, { delay: 15 });
        break;
      case "press":
        if (!args.key) throw new BrowserError("press needs a key.");
        if (el) await el.press(args.key, { timeout });
        else await page.keyboard.press(args.key);
        break;
      case "select": {
        if (!args.values?.length) throw new BrowserError("select needs values.");
        const chosen = await need("values").selectOption(args.values.map((v) => ({ value: v })), { timeout }).catch(() =>
          need("values").selectOption(args.values!.map((label) => ({ label })), { timeout }),
        );
        note = `Selected ${chosen.join(", ")}.`;
        break;
      }
      case "scroll":
        if (el) await el.scrollIntoViewIfNeeded({ timeout });
        else await page.mouse.wheel(0, args.delta_y ?? Math.round((page.viewportSize()?.height ?? 800) * 0.8));
        break;
      case "drag": {
        if (!args.target_ref) throw new BrowserError("drag needs a target_ref.");
        await need("a target_ref").dragTo(page.getByRef(args.target_ref), { timeout });
        break;
      }
      case "upload": {
        if (!args.values?.length) throw new BrowserError("upload needs values: workspace-relative file paths.");
        const files = args.values.map((p) => confined(scope.worktree, p));
        await need("values").setInputFiles(files, { timeout });
        note = `Attached ${args.values.join(", ")}.`;
        break;
      }
      case "wait":
        if (args.text) await page.getByText(args.text).first().waitFor({ state: "visible", timeout });
        else if (el) await el.waitFor({ state: "visible", timeout });
        else await page.waitForTimeout(Math.min(timeout, 10_000));
        break;
    }
    await settle(page);
    return { text: `${note ? `${note}\n` : ""}${await snapshot(session, tab)}` };
  });
}

async function screenshot(manager: BrowserManager, scope: BrowserScope, args: BrowserInput<"browser_screenshot">): Promise<BrowserResult> {
  return withCurrent(manager, scope, args, false, async (session, tab) => {
    const sized = await applyViewport(tab, args.viewport);
    const el = target(tab.page, args.ref, args.selector);
    const png = await capture(tab, { fullPage: args.full_page ?? false, locator: el });
    const file = await artifact(scope, "shots", `${args.name ?? stamp()}.png`);
    await writeFile(file.full, png);
    const size = tab.page.viewportSize();
    return {
      text: `${header(session, tab)}\nSaved ${file.rel}${sized}${size ? `, viewport ${size.width}x${size.height}` : ""}${args.full_page ? ", full page" : ""}.`,
      images: [await image(tab, png, file.rel, args.full_page ?? false, el)],
    };
  });
}

async function extract(manager: BrowserManager, scope: BrowserScope, args: BrowserInput<"browser_extract">): Promise<BrowserResult> {
  return withCurrent(manager, scope, args, false, async (session, tab) => {
    const max = args.max_chars ?? 20_000;
    const raw = await inPage(tab.page, extractInPage, { format: args.format, selector: args.selector });
    if (raw && typeof raw === "object" && "error" in raw) throw new BrowserError(String((raw as { error: unknown }).error));
    let body: string;
    if (typeof raw === "string") body = raw;
    else if (args.format === "links") body = (raw as { text: string; href: string }[]).map((l) => `- [${l.text || "(no text)"}](${l.href})`).join("\n");
    else body = JSON.stringify(raw, null, 1);
    const cut = body.length > max ? `${body.slice(0, max)}\n… cut at ${max} of ${body.length} characters; raise max_chars or pass a selector.` : body;
    return { text: `${header(session, tab)}\n\n${cut || "(nothing found)"}` };
  });
}

function outline(node: DesignNode | null, depth = 0, lines: string[] = []): string[] {
  if (!node || lines.length > 400) return lines;
  const name = `${node.tag}${node.id ? `#${node.id}` : ""}${node.cls ? `.${node.cls.split(" ").join(".")}` : ""}${node.role ? `[role=${node.role}]` : ""}`;
  const [x, y, w, h] = node.box;
  lines.push(`${"  ".repeat(depth)}${name} @${x},${y} ${w}x${h}${node.layout ? ` {${node.layout}}` : ""}${node.text ? ` "${node.text}"` : ""}`);
  for (const child of node.children ?? []) outline(child, depth + 1, lines);
  return lines;
}

async function design(manager: BrowserManager, scope: BrowserScope, args: BrowserInput<"browser_design">): Promise<BrowserResult> {
  return withCurrent(manager, scope, args, false, async (session, tab) => {
    const page = tab.page;
    const raw = (await inPage(page, designInPage, { selector: args.selector, depth: args.depth ?? 5 })) as Record<string, unknown> & { error?: string };
    if (raw.error) throw new BrowserError(raw.error);
    const base = args.name ?? `${new URL(page.url()).hostname.replace(/[^A-Za-z0-9.-]/g, "_") || "page"}-${stamp()}`;
    const json = await artifact(scope, "designs", `${base}.json`);
    await writeFile(json.full, JSON.stringify(raw, null, 2));
    const el = args.selector ? page.locator(args.selector).first() : null;
    const png = await capture(tab, { fullPage: !el, locator: el });
    const shot = await artifact(scope, "designs", `${base}.png`);
    await writeFile(shot.full, png);
    let htmlNote = "";
    if (args.html) {
      const html = await inPage(page, inlineHtmlInPage, { selector: args.selector });
      if (typeof html === "string") {
        const file = await artifact(scope, "designs", `${base}.html`);
        await writeFile(file.full, html);
        htmlNote = `\nHTML copy (computed styles inlined): ${file.rel}`;
      }
    }
    type Count = { value: string; count: number };
    const list = (items: unknown, n = 12) => ((items as Count[]) ?? []).slice(0, n).map((c) => `${c.value} (${c.count})`).join(", ") || "none";
    const colors = raw.colors as Record<string, Count[]>;
    const variables = Object.entries((raw.variables as Record<string, string>) ?? {});
    const text = [
      `${header(session, tab)}`,
      `Saved ${json.rel} and ${shot.rel}${htmlNote}`,
      `Viewport ${JSON.stringify(raw.viewport)}, document ${JSON.stringify(raw.document)}`,
      "",
      `Text colours: ${list(colors.text)}`,
      `Backgrounds (by area): ${list(colors.background)}`,
      `Borders: ${list(colors.border, 8)}`,
      colors.gradients?.length ? `Gradients: ${list(colors.gradients, 4)}` : "",
      `Fonts: ${list(raw.fonts, 8)}`,
      `Type scale (size/line-height weight tag): ${list(raw.typeScale, 16)}`,
      `Spacing: ${list(raw.spacing, 16)}`,
      `Radii: ${list(raw.radii, 8)}`,
      `Shadows: ${list(raw.shadows, 6)}`,
      `Breakpoints: ${((raw.breakpoints as string[]) ?? []).join(", ") || "none found"}`,
      variables.length ? `CSS variables (${variables.length}): ${variables.slice(0, 60).map(([k, v]) => `${k}: ${v}`).join("; ")}${variables.length > 60 ? " …" : ""}` : "CSS variables: none readable",
      "",
      "Layout (tag @x,y wxh {layout}):",
      ...outline(raw.layout as DesignNode | null),
    ].filter((line) => line !== "");
    let body = text.join("\n");
    if (body.length > 24_000) body = `${body.slice(0, 24_000)}\n… cut; the full capture is in ${json.rel}.`;
    return { text: body, images: [await image(tab, png, shot.rel, !el, el)] };
  });
}

async function compare(manager: BrowserManager, scope: BrowserScope, args: BrowserInput<"browser_compare">): Promise<BrowserResult> {
  const baseline = await readFile(confined(scope.worktree, args.baseline)).catch(() => {
    throw new BrowserError(`Could not read ${args.baseline}.`);
  });
  let candidate: Buffer;
  let candidateName: string;
  if (args.candidate) {
    candidate = await readFile(confined(scope.worktree, args.candidate)).catch(() => {
      throw new BrowserError(`Could not read ${args.candidate}.`);
    });
    candidateName = args.candidate;
  } else {
    const shot = await withCurrent(manager, scope, args, false, async (_session, tab) => {
      const png = await capture(tab, { fullPage: args.full_page ?? false, locator: null });
      const file = await artifact(scope, "shots", `${stamp()}.png`);
      await writeFile(file.full, png);
      return { text: file.rel, png };
    }) as BrowserResult & { png: Buffer };
    candidate = shot.png;
    candidateName = shot.text;
  }
  const outcome = await manager.scratch((page) =>
    inPage(page, compareInPage, {
      a: `data:image/png;base64,${baseline.toString("base64")}`,
      b: `data:image/png;base64,${candidate.toString("base64")}`,
      threshold: args.threshold ?? 0.1,
    }),
  ) as CompareOutcome;
  const diff = await artifact(scope, "shots", `diff-${stamp()}.png`);
  await writeFile(diff.full, Buffer.from(outcome.diffPng, "base64"));
  const percent = (outcome.ratio * 100).toFixed(2);
  const grid = outcome.grid.map((row) => row.map((v) => `${v.toFixed(1).padStart(5)}%`).join(" ")).join("\n");
  return {
    text: [
      `Compared ${args.baseline} with ${candidateName}: ${percent}% of pixels differ (${outcome.diffPixels} of ${outcome.width * outcome.height}).`,
      outcome.sizeMismatch ? `Size mismatch: ${outcome.sizeMismatch}.` : "",
      outcome.bounds ? `Differences span x ${outcome.bounds[0]}, y ${outcome.bounds[1]}, ${outcome.bounds[2]}x${outcome.bounds[3]}.` : "No differences above the threshold.",
      `Share differing per quarter (rows top to bottom):\n${grid}`,
      `Diff image (red = different): ${diff.rel}`,
    ].filter(Boolean).join("\n"),
    images: [{ mediaType: "image/png", data: outcome.diffPng, path: diff.rel }],
  };
}

async function evaluate(manager: BrowserManager, scope: BrowserScope, args: BrowserInput<"browser_eval">): Promise<BrowserResult> {
  return withCurrent(manager, scope, args, true, async (session, tab) => {
    const value = await tab.page.evaluate(`(async () => {\n${args.script}\n})()`);
    let text: string;
    try {
      text = value === undefined ? "undefined (use return to send a value back)" : JSON.stringify(value, null, 1);
    } catch {
      text = String(value);
    }
    if (text.length > 30_000) text = `${text.slice(0, 30_000)}\n… cut at 30000 characters.`;
    return { text: `${header(session, tab)}\n\n${text}` };
  });
}

async function tabs(manager: BrowserManager, scope: BrowserScope, args: BrowserInput<"browser_tabs">): Promise<BrowserResult> {
  const action = args.action ?? "list";
  if (action !== "list") {
    if (!args.tab) throw new BrowserError(`${action} needs a tab.`);
    const session = await manager.open(scope, args.session);
    const tab = manager.tab(session, scope.agentId, args.tab)!;
    if (action === "switch") {
      session.current.set(scope.agentId, tab.id);
      await tab.page.bringToFront().catch(() => {});
      return { text: `Tab ${tab.id} is now your current tab in ${session.name}.\n\n${await snapshot(session, tab)}` };
    }
    if (tab.controlledBy) throw new BrowserError(`A person is controlling tab ${tab.id}; it stays open.`);
    await tab.page.close();
    return { text: `Closed tab ${tab.id} in ${session.name}.` };
  }
  const sessions = await manager.describe(scope.projectId);
  const visible = sessions.filter((s) => s.shared || s.owner === scope.agentId);
  if (visible.length === 0) return { text: "No browser sessions are open in this project. browser_open starts one." };
  const lines: string[] = [];
  for (const s of visible) {
    const mine = manager.find(scope.projectId, s.name)?.current.get(scope.agentId);
    lines.push(`${s.shared ? "shared" : "private"} session ${s.name}:`);
    if (s.tabs.length === 0) lines.push("  (no tabs)");
    for (const t of s.tabs) {
      const who = t.openedBy === scope.agentId ? "you" : t.openedBy === "human" ? "a person" : `agent ${t.openedBy.slice(0, 8)}`;
      const flags = [t.id === mine ? "current" : "", t.controlledBy ? "a person is controlling it" : "", t.busy && t.busy !== scope.agentId ? "busy" : ""].filter(Boolean);
      lines.push(`  ${t.id}  ${t.name ? `${JSON.stringify(t.name)} ` : ""}${t.title || "(untitled)"} — ${t.url}  [opened by ${who}${flags.length ? `; ${flags.join("; ")}` : ""}]`);
    }
  }
  return { text: lines.join("\n") };
}

async function logs(manager: BrowserManager, scope: BrowserScope, args: BrowserInput<"browser_logs">): Promise<BrowserResult> {
  const session = await manager.open(scope, args.session);
  const tab = manager.tab(session, scope.agentId, args.tab);
  if (!tab) throw new BrowserError(`No tab is open in ${session.name}.`);
  const kind = args.kind ?? "all";
  const entries = tab.logs.filter((e) => e.seq > (args.since ?? 0) && (kind === "all" || e.kind === kind));
  const body = entries.map((e) => `#${e.seq} ${e.at.slice(11, 19)} ${e.kind}/${e.level}: ${e.text}`).join("\n");
  return { text: `${header(session, tab)}\n${entries.length ? body : "(nothing new)"}\n\ncursor: ${tab.seq}` };
}

async function close(manager: BrowserManager, scope: BrowserScope, args: BrowserInput<"browser_close">): Promise<BrowserResult> {
  const name = manager.sessionName(scope, args.session);
  const session = manager.find(scope.projectId, name);
  if (!session) return { text: `${name} is not open.` };
  if (args.tab) {
    const tab = manager.tab(session, scope.agentId, args.tab)!;
    if (tab.controlledBy) throw new BrowserError(`A person is controlling tab ${tab.id}; it stays open.`);
    await tab.page.close();
    return { text: `Closed tab ${tab.id}.` };
  }
  if (!session.shared) {
    await manager.closeSession(session);
    return { text: `Closed your private session (its cookies are kept for next time).` };
  }
  const mine = [...session.tabs.values()].filter((t) => t.openedBy === scope.agentId && !t.controlledBy);
  for (const t of mine) await t.page.close().catch(() => {});
  session.current.delete(scope.agentId);
  if (session.tabs.size === 0) await manager.closeSession(session);
  return { text: `Closed ${mine.length} tab(s) of yours in ${session.name}.` };
}

// ---- motion ------------------------------------------------------------------

/** Wide enough to read a frame, narrow enough not to be downscaled away by the model. */
const MOTION_SHEET_WIDTH = 1800;
const MOTION_TEXT_CHARS = 24_000;

interface Scoped {
  /** A CSS selector for the element, for the in-page scripts (they cannot resolve refs). */
  selector: string | null;
  locator: Locator | null;
  untag(): Promise<void>;
}

/** Tags the element a ref or selector names, so in-page scripts can find it by a plain selector. */
async function scopeOf(page: Page, ref: string | null, selector: string | null): Promise<Scoped> {
  const locator = target(page, ref, selector);
  if (!locator) return { selector: null, locator: null, untag: async () => {} };
  if (!ref && selector) return { selector, locator, untag: async () => {} };
  const mark = `m${Date.now().toString(36)}`;
  await locator.evaluate((el, m) => el.setAttribute("data-ucch-motion", m), mark, { timeout: 10_000 });
  return {
    selector: `[data-ucch-motion="${mark}"]`,
    locator,
    untag: () => locator.evaluate((el) => el.removeAttribute("data-ucch-motion"), null, { timeout: 2000 }).then(() => {}, () => {}),
  };
}

/** Starts the motion a trigger names. A reload loses the tag on a ref'd element, so a reload with a scope needs a selector. */
async function fire(page: Page, trigger: "hover" | "focus" | "reload" | null, scoped: Scoped): Promise<void> {
  if (!trigger) return;
  if (trigger === "reload") {
    await page.reload({ waitUntil: "domcontentloaded" });
    return;
  }
  if (!scoped.locator) throw new BrowserError(`trigger ${trigger} needs a ref or selector.`);
  if (trigger === "hover") {
    // From outside the element, so the hover really starts (a pointer already over it changes nothing).
    await page.mouse.move(0, 0);
    // force: the stability wait would never end on an element that is already moving.
    await scoped.locator.hover({ timeout: 10_000, force: true });
  } else {
    await scoped.locator.focus({ timeout: 10_000 });
  }
}

/** The element's box with room for it to grow (a hover scale, a shadow), clamped to the viewport. */
async function clipFor(page: Page, locator: Locator | null): Promise<{ x: number; y: number; width: number; height: number } | undefined> {
  if (!locator) return undefined;
  const box = await locator.boundingBox({ timeout: 10_000 });
  const view = page.viewportSize();
  if (!box || !view) return undefined;
  const padX = Math.max(8, box.width * 0.12);
  const padY = Math.max(8, box.height * 0.12);
  const x = Math.max(0, Math.floor(box.x - padX));
  const y = Math.max(0, Math.floor(box.y - padY));
  const width = Math.min(view.width - x, Math.ceil(box.width + padX * 2));
  const height = Math.min(view.height - y, Math.ceil(box.height + padY * 2));
  return width > 4 && height > 4 ? { x, y, width, height } : undefined;
}

function describeAnimation(a: MotionAnimation, i: number): string {
  const ms = (v: string | number) => (Number.isFinite(Number(v)) ? `${Math.round(Number(v))}ms` : String(v));
  const lines = [
    `${i + 1}. ${a.kind}${a.name ? ` "${a.name}"` : ""} on ${a.target} — ${a.playState}, ${ms(a.duration)}` +
      `${a.delay ? `, delay ${ms(a.delay)}` : ""}, ×${a.iterations === "Infinity" ? "∞" : a.iterations}` +
      `${a.direction !== "normal" ? ` ${a.direction}` : ""}, ${a.easing}${a.fill !== "auto" && a.fill !== "none" ? `, fill ${a.fill}` : ""}` +
      `${a.timeline !== "document" ? `, timeline ${a.timeline}` : ""}`,
  ];
  for (const k of a.keyframes) {
    const props = Object.entries(k.props).map(([p, v]) => `${p}: ${v}`).join("; ");
    const at = k.offset === null ? "?" : `${Math.round(k.offset * 1000) / 10}%`;
    lines.push(`     ${at.padStart(6)}  ${props || "(no properties)"}${k.easing !== "linear" ? `  [${k.easing}]` : ""}`);
  }
  return lines.join("\n");
}

function describeReport(r: MotionReport): string {
  const out: string[] = [];
  out.push(r.animations.length ? `CSS / Web Animations (${r.animations.length}):` : "CSS / Web Animations: none ran while watching.");
  out.push(...r.animations.map(describeAnimation));
  if (r.styled.length) {
    out.push("", "JS-driven (inline style changed while watching; a library or script is animating these):");
    for (const s of r.styled) out.push(`  - ${s.target} ×${s.changes}: transform ${s.transform}, opacity ${s.opacity}`);
  }
  if (r.classed.length) {
    out.push("", "Class changes (these often start CSS transitions):");
    for (const c of r.classed) out.push(`  - ${c.target} ×${c.changes}`);
  }
  out.push(
    "",
    `requestAnimationFrame: ~${r.rafPerSecond}/s${r.rafPerSecond >= 20 ? " (a JS animation loop is running)" : ""}` +
      " (a library that saved requestAnimationFrame before watching began is not counted)",
  );
  out.push(`Libraries: ${r.libraries.join(", ") || "none recognised"}`);
  if (r.canvases.length) out.push(`Canvases (motion inside them is only visible in frames): ${r.canvases.map((c) => `${c.target} ${c.width}x${c.height}${c.engine ? ` ${c.engine}` : ""}`).join(", ")}`);
  if (r.videos.length) out.push(`Videos: ${r.videos.map((v) => `${v.target} ${v.playing ? "playing" : "paused"}${v.loop ? ", loop" : ""}`).join("; ")}`);
  out.push(
    r.reducedMotionRules
      ? `Reduced motion: ${r.reducedMotionRules} @media (prefers-reduced-motion) rule(s) in readable stylesheets.`
      : "Reduced motion: no @media (prefers-reduced-motion) rules in readable stylesheets.",
  );
  return out.join("\n");
}

async function sheetOf(manager: BrowserManager, scope: BrowserScope, folder: string, frames: { png: Buffer; label: string }[]): Promise<{ text: string; image: BrowserImage }> {
  const paths: string[] = [];
  for (const [i, frame] of frames.entries()) {
    const file = await artifact(scope, folder, `${String(i + 1).padStart(2, "0")}.png`);
    await writeFile(file.full, frame.png);
    paths.push(file.rel);
  }
  const sheet = await manager.scratch((page) =>
    inPage(page, contactSheetInPage, {
      frames: frames.map((f) => ({ src: `data:image/png;base64,${f.png.toString("base64")}`, label: f.label })),
      maxWidth: MOTION_SHEET_WIDTH,
      inlineBytes: INLINE_PNG_BYTES,
    }),
  );
  const file = await artifact(scope, folder, "sheet.png");
  await writeFile(file.full, Buffer.from(sheet.png, "base64"));
  const distinct = new Set(frames.map((f) => createHash("sha1").update(f.png).digest("hex"))).size;
  const text =
    `Contact sheet ${file.rel} (${sheet.cols} per row, read left to right), frames ${paths[0]} … ${paths.at(-1)}.\n` +
    (distinct === 1 ? "All frames are identical: nothing moved in this area over this span." : `${distinct} of ${frames.length} frames differ.`);
  return {
    text,
    image: sheet.jpeg ? { mediaType: "image/jpeg", data: sheet.jpeg, path: file.rel } : { mediaType: "image/png", data: sheet.png, path: file.rel },
  };
}

async function motion(manager: BrowserManager, scope: BrowserScope, args: BrowserInput<"browser_motion">): Promise<BrowserResult> {
  if (args.trigger === "reload" && args.ref) throw new BrowserError("Refs do not survive a reload; with trigger reload, name the element by selector.");
  const changes = args.mode === "scroll" || args.trigger !== null;
  return withCurrent(manager, scope, args, changes, async (session, tab) => {
    const page = tab.page;
    const sized = await applyViewport(tab, args.viewport);
    if (args.reduced_motion) await page.emulateMedia({ reducedMotion: "reduce" });
    let scoped: Scoped = { selector: null, locator: null, untag: async () => {} };
    try {
      const notes = [`${header(session, tab)}${sized}${args.reduced_motion ? " · prefers-reduced-motion: reduce" : ""}${args.trigger ? ` · trigger ${args.trigger}` : ""}`];
      const host = (() => {
        try {
          return new URL(page.url()).hostname.replace(/[^A-Za-z0-9.-]/g, "_") || "page";
        } catch {
          return "page";
        }
      })();
      const folder = `motion/${host}-${args.mode}-${stamp()}`;

      // A reload comes first: it would throw away a watcher or a tag.
      if (args.trigger === "reload") await fire(page, "reload", scoped);
      scoped = await scopeOf(page, args.ref, args.selector);
      // Not scrollIntoViewIfNeeded: it waits for the element to be stable, and an animating one never is.
      if (scoped.locator && args.mode !== "scroll") {
        await scoped.locator.evaluate(
          (el) => {
            const r = el.getBoundingClientRect();
            if (r.top < 0 || r.bottom > innerHeight || r.left < 0 || r.right > innerWidth) el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
          },
          null,
          { timeout: 10_000 },
        );
      }
      const later = args.trigger === "reload" ? null : args.trigger;

      if (args.mode === "inspect") {
        const started = await inPage(page, motionStartInPage, { scope: scoped.selector });
        if ("error" in started) throw new BrowserError(started.error);
        await fire(page, later, scoped);
        await page.waitForTimeout(args.duration_ms ?? 1500);
        const report = await inPage(page, motionStopInPage, null);
        if ("error" in report) throw new BrowserError(report.error);
        notes.push(`Watched ${report.listenedMs}ms${scoped.selector ? " (the element's subtree)" : ""}.`, "", describeReport(report));
        const js = report.styled.length > 0 || report.canvases.length > 0 || report.rafPerSecond >= 20;
        notes.push(
          "",
          `Next: browser_motion frames${js ? " with timing realtime for the JS/canvas motion" : ""}` +
            `${report.animations.some((a) => a.timeline !== "document") || report.libraries.some((l) => /Scroll|Lenis/.test(l)) ? ", or scroll for the scroll-driven effects" : ""}.`,
        );
        let text = notes.join("\n");
        if (text.length > MOTION_TEXT_CHARS) text = `${text.slice(0, MOTION_TEXT_CHARS)}\n… cut; pass a ref or selector to inspect one region.`;
        return { text };
      }

      if (args.mode === "frames") {
        const count = args.count ?? 8;
        let timing = args.timing ?? "auto";
        let why = "";
        if (timing === "auto") {
          // A short look before the trigger: script-driven motion cannot be paused and seeked.
          const started = await inPage(page, motionStartInPage, { scope: scoped.selector });
          if ("error" in started) throw new BrowserError(started.error);
          await page.waitForTimeout(300);
          const probe = await inPage(page, motionStopInPage, null);
          const js = "error" in probe ? false : probe.styled.length > 0 || probe.canvases.length > 0 || probe.videos.some((v) => v.playing);
          timing = js ? "realtime" : "seek";
          why = js ? "script, canvas or video motion was seen" : "CSS / Web Animations";
        }
        await fire(page, later, scoped);
        const clip = await clipFor(page, scoped.locator);
        const shoot = () => page.screenshot({ type: "png", animations: "allow", caret: "initial", ...(clip ? { clip } : {}) });
        const frames: { png: Buffer; label: string }[] = [];
        let span = args.duration_ms ?? 2000;
        if (timing === "seek") {
          const paused = await inPage(page, motionPauseInPage, { scope: scoped.selector });
          if (paused.paused === 0) {
            await inPage(page, motionResumeInPage, null);
            timing = "realtime";
            why = `no CSS / Web Animation was running to seek${paused.scrollDriven ? ` (${paused.scrollDriven} scroll-driven: use mode scroll)` : ""}`;
          } else {
            span = args.duration_ms ?? Math.min(10_000, paused.spanMs || 2000);
            try {
              for (let k = 0; k < count; k++) {
                const t = Math.round((span * k) / (count - 1));
                await inPage(page, motionSeekInPage, { t });
                frames.push({ png: await shoot(), label: `${k + 1}  t=${t}ms` });
              }
            } finally {
              await inPage(page, motionResumeInPage, null).catch(() => {});
            }
            notes.push(`Seeked ${paused.paused} paused animation(s) through 0–${span}ms in ${count} frames (${why || "seek"}).`);
          }
        }
        if (timing === "realtime") {
          const start = Date.now();
          for (let k = 0; k < count; k++) {
            const due = start + (span * k) / (count - 1);
            const wait = due - Date.now();
            if (wait > 0) await page.waitForTimeout(wait);
            const t = Date.now() - start;
            frames.push({ png: await shoot(), label: `${k + 1}  t=${t}ms` });
          }
          const took = Date.now() - start;
          notes.push(
            `Captured ${count} frames in real time over ~${took}ms${why ? ` (${why})` : ""}.` +
              (took > span * 1.25 ? " Capturing was slower than the span asked for, so frames are further apart than planned; the labels give the real times." : ""),
          );
        }
        const sheet = await sheetOf(manager, scope, folder, frames);
        notes.push(sheet.text);
        return { text: notes.join("\n"), images: [sheet.image] };
      }

      // scroll
      const range = await inPage(page, scrollRangeInPage, { scope: scoped.selector });
      if ("error" in range) throw new BrowserError(range.error);
      const from = Math.min(range.max, args.from_y ?? range.from);
      const to = Math.min(range.max, args.to_y ?? range.to);
      if (range.max === 0) notes.push("The page does not scroll at this viewport.");
      const count = args.count ?? 6;
      const smooth = await inPage(page, () => {
        const w = window as unknown as Record<string, unknown>;
        return Boolean(w.Lenis || w.lenis || w.LocomotiveScroll || document.documentElement.classList.contains("lenis"));
      }, null);
      const settle = args.settle_ms ?? (smooth ? 900 : 300);
      await fire(page, later, scoped);
      const view = page.viewportSize() ?? { width: 1280, height: 800 };
      await page.mouse.move(Math.round(view.width / 2), Math.round(view.height / 2));
      let y = await inPage(page, scrollJumpInPage, { y: from });
      await page.waitForTimeout(settle);
      const frames: { png: Buffer; label: string }[] = [];
      const steps: string[] = [];
      for (let k = 0; k < count; k++) {
        const goal = Math.round(from + ((to - from) * k) / Math.max(1, count - 1));
        if (k > 0 && goal !== y) {
          // The wheel, not scrollTo: smooth-scroll libraries and scroll listeners react to wheel input.
          await page.mouse.wheel(0, goal - y);
          await page.waitForTimeout(settle);
        }
        const sample = await inPage(page, scrollSampleInPage, null);
        y = sample.y;
        frames.push({ png: await page.screenshot({ type: "png", animations: "allow", caret: "initial" }), label: `${k + 1}  y=${y}px` });
        steps.push(
          `${k + 1}. y=${y}px${Math.abs(y - goal) > 4 ? ` (aimed at ${goal})` : ""}` +
            (k === 0 ? "" : sample.changed.length ? `\n${sample.changed.map((c) => `     ${c.target}: ${c.what}`).join("\n")}` : "  — no transform/opacity/clip/filter changed"),
        );
      }
      notes.push(
        `Scrolled ${from}→${to}px of ${range.max}px in ${count} wheel steps, ${settle}ms settle${smooth ? " (smooth-scroll library detected)" : ""}. The page is left at y=${y}.`,
        "",
        ...steps,
      );
      const sheet = await sheetOf(manager, scope, folder, frames);
      notes.push("", sheet.text);
      let text = notes.join("\n");
      if (text.length > MOTION_TEXT_CHARS) text = `${text.slice(0, MOTION_TEXT_CHARS)}\n… cut.`;
      return { text, images: [sheet.image] };
    } finally {
      await scoped.untag();
      if (args.reduced_motion) await page.emulateMedia({ reducedMotion: null }).catch(() => {});
    }
  });
}
