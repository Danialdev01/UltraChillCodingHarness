import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Locator, Page } from "playwright-core";
import { BrowserError, type BrowserManager, type BrowserScope, type Session, type Tab } from "./manager.js";
import { compareInPage, designInPage, extractInPage, inlineHtmlInPage, type CompareOutcome, type DesignNode } from "./page-scripts.js";
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
  }
}

// ---- helpers -----------------------------------------------------------------

/** Runs a page script with a `__name` shim: tsx and vitest compile with esbuild's keepNames, whose helper the page lacks. */
async function inPage<A, R>(page: Page, fn: (args: A) => R, args: A): Promise<Awaited<R>> {
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

async function applyViewport(tab: Tab, viewport: keyof typeof VIEWPORTS | null): Promise<string> {
  if (!viewport) return "";
  await tab.page.setViewportSize(VIEWPORTS[viewport]);
  return ` (viewport ${viewport} ${VIEWPORTS[viewport].width}x${VIEWPORTS[viewport].height})`;
}

// ---- ops ---------------------------------------------------------------------

async function open(manager: BrowserManager, scope: BrowserScope, args: BrowserInput<"browser_open">): Promise<BrowserResult> {
  const session = await manager.open(scope, args.session);
  const currentId = session.current.get(scope.agentId);
  const own = (currentId && session.tabs.get(currentId)) || [...session.tabs.values()].find((t) => t.openedBy === scope.agentId);
  const tab = own && !args.new_tab ? own : await manager.newTab(session, scope.agentId);
  return manager.withTab(session, tab, scope.agentId, Boolean(args.url), async () => {
    const sized = await applyViewport(tab, args.viewport);
    const status = args.url ? await goto(tab.page, args.url) : "";
    const others = [...session.tabs.values()].filter((t) => t !== tab);
    const note = session.shared
      ? `Shared session ${session.name}: ${others.length ? `${others.length} other tab(s) (browser_tabs lists them)` : "no other tabs yet"}.`
      : "Your private session.";
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
      lines.push(`  ${t.id}  ${t.title || "(untitled)"} — ${t.url}  [opened by ${who}${flags.length ? `; ${flags.join("; ")}` : ""}]`);
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
