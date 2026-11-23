import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findChromium } from "./executable.js";
import { BrowserManager, type BrowserScope } from "./manager.js";

/**
 * Real Chromium against a local page. Skipped where no Chromium is
 * installed; the image has one (`apt chromium`).
 */
const executable = await findChromium(process.env.BROWSER_EXECUTABLE ?? null);

const PAGE = `<!doctype html><html lang="en"><head><title>Fixture</title>
<meta name="description" content="A test page">
<style>:root{--brand:#3355ff;--gap:12px} body{margin:0;font-family:Georgia,serif;color:#222}
header{display:flex;justify-content:space-between;gap:var(--gap);padding:16px;background:#3355ff;color:#fff}
.card{border-radius:8px;box-shadow:0 1px 2px #0003;padding:24px;margin:16px}
@media (max-width: 600px){header{flex-direction:column}}</style></head>
<body><header><h1>Shop</h1><nav><a href="/about">About</a> <a href="https://example.com/x">Out</a></nav></header>
<main class="card"><h2>Sign in</h2><label>Email <input id="email" name="email"></label>
<button id="go" onclick="document.getElementById('out').textContent='hello '+document.getElementById('email').value;document.cookie='who='+document.getElementById('email').value+';max-age=3600';console.log('signed in')">Go</button>
<p id="out"></p>
<table><tr><th>Item</th><th>Price</th></tr><tr><td>Tea</td><td>3</td></tr></table></main></body></html>`;

let server: Server;
let base: string;
let worktree: string;
let stateDir: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/slow") {
      setTimeout(() => res.end("<title>slow</title>slow"), 300);
      return;
    }
    res.setHeader("content-type", "text/html");
    res.end(req.url === "/about" ? "<title>About</title><h1>About us</h1>" : PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  worktree = await mkdtemp(join(tmpdir(), "ucch-browser-wt-"));
  stateDir = await mkdtemp(join(tmpdir(), "ucch-browser-state-"));
});

afterAll(async () => {
  server?.close();
  await rm(worktree, { recursive: true, force: true });
  await rm(stateDir, { recursive: true, force: true });
});

describe.skipIf(!executable)("BrowserManager", () => {
  const manager = () =>
    new BrowserManager({
      executablePath: executable!,
      stateDir,
      refuse: async (url) => (url.hostname === "blocked.test" || url.hostname === "example.com" ? "a test block" : null),
    });
  const a = (): BrowserScope => ({ projectId: "p1", agentId: "agent-aaaaaaaa", worktree });
  const b = (): BrowserScope => ({ projectId: "p1", agentId: "agent-bbbbbbbb", worktree });

  it("opens a page, acts on refs from the snapshot, and scrapes it", async () => {
    const m = manager();
    try {
      const opened = await m.call(a(), "browser_open", { session: null, url: base, new_tab: null, viewport: null });
      expect(opened.isError).toBeFalsy();
      expect(opened.text).toContain("Opened tab t1");
      const ref = /textbox "Email" \[ref=(\w+)\]/.exec(opened.text)?.[1];
      expect(ref).toBeTruthy();

      const filled = await m.call(a(), "browser_act", { session: null, tab: null, action: "fill", ref, selector: null, text: "ada@x.test", key: null, values: null, target_ref: null, delta_y: null, timeout_ms: null });
      expect(filled.isError).toBeFalsy();
      const button = /button "Go" \[ref=(\w+)\]/.exec(filled.text)?.[1];
      const clicked = await m.call(a(), "browser_act", { session: null, tab: null, action: "click", ref: button, selector: null, text: null, key: null, values: null, target_ref: null, delta_y: null, timeout_ms: null });
      expect(clicked.text).toContain("hello ada@x.test");

      const md = await m.call(a(), "browser_extract", { session: null, tab: null, format: "markdown", selector: null, max_chars: null });
      expect(md.text).toContain("# Shop");
      expect(md.text).toContain("| Item | Price |");
      const links = await m.call(a(), "browser_extract", { session: null, tab: null, format: "links", selector: null, max_chars: null });
      expect(links.text).toContain(`[About](${base}/about)`);
      const meta = await m.call(a(), "browser_extract", { session: null, tab: null, format: "meta", selector: null, max_chars: null });
      expect(meta.text).toContain("A test page");

      const evaluated = await m.call(a(), "browser_eval", { session: null, tab: null, script: "return document.title" });
      expect(evaluated.text).toContain('"Fixture"');
      const logs = await m.call(a(), "browser_logs", { session: null, tab: null, kind: null, since: null });
      expect(logs.text).toContain("signed in");
    } finally {
      await m.close();
    }
  }, 60_000);

  it("screenshots, captures the design, and diffs images", async () => {
    const m = manager();
    try {
      await m.call(a(), "browser_open", { session: null, url: base, new_tab: null, viewport: "desktop" });
      const shot = await m.call(a(), "browser_screenshot", { session: null, tab: null, full_page: false, ref: null, selector: null, viewport: null, name: "home" });
      expect(shot.isError).toBeFalsy();
      expect(shot.images?.[0]?.path).toBe(join(".agent", "browser", "shots", "home.png"));
      expect((await stat(join(worktree, ".agent/browser/shots/home.png"))).size).toBeGreaterThan(1000);

      const design = await m.call(a(), "browser_design", { session: null, tab: null, selector: null, depth: 4, html: true, name: "fixture" });
      expect(design.isError).toBeFalsy();
      expect(design.text).toContain("#3355ff");
      expect(design.text).toContain("--brand: #3355ff");
      expect(design.text).toContain("Georgia");
      expect(design.text).toContain("max 600px");
      expect(design.text).toMatch(/header .*\{flex row.*justify space-between/);
      const html = await readFile(join(worktree, ".agent/browser/designs/fixture.html"), "utf8");
      expect(html).toContain("justify-content:space-between");
      expect(html).not.toContain("onclick");

      const same = await m.call(a(), "browser_compare", { baseline: ".agent/browser/shots/home.png", candidate: null, session: null, tab: null, full_page: false, threshold: null });
      expect(same.text).toContain("0.00% of pixels differ");
      await m.call(a(), "browser_eval", { session: null, tab: null, script: "document.querySelector('header').style.background = '#ff0000'" });
      const changed = await m.call(a(), "browser_compare", { baseline: ".agent/browser/shots/home.png", candidate: null, session: null, tab: null, full_page: false, threshold: null });
      expect(Number(/([\d.]+)% of pixels differ/.exec(changed.text)?.[1])).toBeGreaterThan(1);
      expect(changed.images).toHaveLength(1);

      const outside = await m.call(a(), "browser_compare", { baseline: "../../etc/passwd", candidate: null, session: null, tab: null, full_page: false, threshold: null });
      expect(outside.isError).toBe(true);
    } finally {
      await m.close();
    }
  }, 60_000);

  it("shares a named session between agents and keeps private ones apart", async () => {
    const m = manager();
    try {
      await m.call(a(), "browser_open", { session: "demo", url: base, new_tab: null, viewport: null });
      await m.call(a(), "browser_act", { session: "demo", tab: null, action: "fill", ref: null, selector: "#email", text: "shared", key: null, values: null, target_ref: null, delta_y: null, timeout_ms: null });
      await m.call(a(), "browser_act", { session: "demo", tab: null, action: "click", ref: null, selector: "#go", text: null, key: null, values: null, target_ref: null, delta_y: null, timeout_ms: null });

      // B joins: its own tab, the same cookies.
      const joined = await m.call(b(), "browser_open", { session: "demo", url: base, new_tab: null, viewport: null });
      expect(joined.text).toContain("Opened tab t2");
      const cookie = await m.call(b(), "browser_eval", { session: "demo", tab: null, script: "return document.cookie" });
      expect(cookie.text).toContain("who=shared");
      const listed = await m.call(b(), "browser_tabs", { session: null, action: null, tab: null });
      expect(listed.text).toContain("shared session demo");
      expect(listed.text).toMatch(/t1 .*opened by agent agent-aa/);

      // A's private session is A's alone.
      await m.call(a(), "browser_open", { session: null, url: base, new_tab: null, viewport: null });
      const privateCookie = await m.call(a(), "browser_eval", { session: null, tab: null, script: "return document.cookie" });
      expect(privateCookie.text).not.toContain("who=shared");
      const intrude = await m.call(b(), "browser_open", { session: "private-agent-aa", url: null, new_tab: null, viewport: null });
      expect(intrude.isError).toBe(true);

      // A person takes t1: agents can read it but not act on it.
      m.control("p1", "demo", "t1", "user-1", true);
      const refused = await m.call(b(), "browser_act", { session: "demo", tab: "t1", action: "click", ref: null, selector: "#go", text: null, key: null, values: null, target_ref: null, delta_y: null, timeout_ms: null });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain("A person is controlling tab t1");
      const read = await m.call(b(), "browser_snapshot", { session: "demo", tab: "t1", selector: null });
      expect(read.isError).toBeFalsy();
      await m.input("p1", "demo", "t1", "user-1", { type: "navigate", url: `${base}/about` });
      m.control("p1", "demo", "t1", "user-1", false);
      const after = await m.call(b(), "browser_snapshot", { session: "demo", tab: "t1", selector: null });
      expect(after.text).toContain("About us");
    } finally {
      await m.close();
    }
  }, 60_000);

  it("serialises calls on one tab", async () => {
    const m = manager();
    try {
      await m.call(a(), "browser_open", { session: "lock", url: base, new_tab: null, viewport: null });
      const order: string[] = [];
      await Promise.all([
        m.call(a(), "browser_navigate", { session: "lock", tab: "t1", url: `${base}/slow`, action: null, wait_until: null }).then(() => order.push("nav")),
        new Promise((r) => setTimeout(r, 50)).then(() => m.call(b(), "browser_eval", { session: "lock", tab: "t1", script: "return location.pathname" })).then((r) => order.push(r.text.includes("/slow") ? "eval-after" : "eval-before")),
      ]);
      expect(order).toEqual(["nav", "eval-after"]);
    } finally {
      await m.close();
    }
  }, 60_000);

  it("refuses what the policy blocks and bad schemes", async () => {
    const m = manager();
    try {
      const blocked = await m.call(a(), "browser_open", { session: null, url: "http://blocked.test/", new_tab: null, viewport: null });
      expect(blocked.text).toMatch(/HTTP 403|Blocked by the harness/);
      const file = await m.call(a(), "browser_navigate", { session: null, tab: null, url: "file:///etc/passwd", action: "goto", wait_until: null });
      expect(file.isError).toBe(true);
      const bad = await m.call(a(), "browser_open", { session: "has space", url: null, new_tab: null, viewport: null });
      expect(bad.isError).toBe(true);
    } finally {
      await m.close();
    }
  }, 60_000);

  it("keeps a session's cookies across a restart", async () => {
    const first = manager();
    await first.call(a(), "browser_open", { session: "keep", url: base, new_tab: null, viewport: null });
    await first.call(a(), "browser_eval", { session: "keep", tab: null, script: "document.cookie = 'kept=yes; max-age=3600'" });
    await first.close();
    const second = manager();
    try {
      await second.call(b(), "browser_open", { session: "keep", url: base, new_tab: null, viewport: null });
      const cookie = await second.call(b(), "browser_eval", { session: "keep", tab: null, script: "return document.cookie" });
      expect(cookie.text).toContain("kept=yes");
    } finally {
      await second.close();
    }
  }, 60_000);

  it("streams frames to a watcher", async () => {
    const m = manager();
    try {
      await m.call(a(), "browser_open", { session: "watch", url: base, new_tab: null, viewport: null });
      const frames: number[] = [];
      const stop = await m.watch("p1", "watch", "t1", (frame) => frames.push(frame.width));
      await new Promise((r) => setTimeout(r, 1500));
      stop();
      expect(frames.length).toBeGreaterThan(0);
      expect(frames[0]).toBe(1280);
      expect(m.list("p1")[0]?.tabs[0]?.url).toContain(base);
    } finally {
      await m.close();
    }
  }, 60_000);
});
