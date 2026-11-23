import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from "playwright-core";
import type { BrowserOp, BrowserResult, BrowserSessionInfo, BrowserTabInfo } from "./tools.js";
import { browserSpec } from "./tools.js";
import { runOp } from "./ops.js";

/**
 * One headless Chromium for the whole server, shared by every agent.
 *
 * Isolation is a browser *context* per session: its own cookies, storage,
 * cache. A session is keyed by project and name. An agent that names no
 * session gets its private one; a named session is shared by every agent
 * of the project that names it, which is how agents work together on one
 * login or one flow. People see every session live in the Browser view and
 * can take a tab over.
 *
 * A tab has a lock, so two calls never drive one tab at once: a second
 * agent waits its turn rather than interleaving clicks. A tab a person has
 * taken refuses agents' actions until it is handed back; reads still work.
 */

export interface BrowserScope {
  projectId: string;
  /** The calling agent's session (thread id). */
  agentId: string;
  /** The worktree the agent works in: screenshots and captures are written under it, uploads read from it. */
  worktree: string;
}

export interface BrowserManagerOptions {
  executablePath: string;
  /** Where sessions' cookies and storage are kept between runs. */
  stateDir: string;
  headless?: boolean;
  /** Open contexts, across every project, before the least recently used idle one is closed. */
  maxContexts?: number;
  maxTabsPerAgent?: number;
  /** A session nobody used or watched for this long is saved and closed. */
  idleMs?: number;
  /**
   * Why a request to `url` is refused for this project, or null to allow
   * it. Asked for every request a page makes, navigation and subresources.
   */
  refuse?: (url: URL, projectId: string) => Promise<string | null>;
  /** A project's sessions or tabs changed: for the live view. */
  onChange?: (projectId: string) => void;
  log?: { warn(obj: object, msg: string): void };
}

export interface LogEntry {
  seq: number;
  at: string;
  kind: "console" | "network";
  level: string;
  text: string;
}

export interface Tab {
  id: string;
  page: Page;
  openedBy: string;
  busy: string | null;
  controlledBy: string | null;
  logs: LogEntry[];
  seq: number;
  /** The tail of the lock: each call chains onto it. */
  lock: Promise<void>;
  screencast: { cdp: CDPSession; watchers: Set<(frame: BrowserFrame) => void> } | null;
}

export interface Session {
  key: string;
  projectId: string;
  name: string;
  shared: boolean;
  owner: string | null;
  context: BrowserContext;
  tabs: Map<string, Tab>;
  nextTab: number;
  lastUsed: number;
  /** Each agent's current tab in this session. */
  current: Map<string, string>;
  inFlight: number;
  /** Who the page being opened by `newTab` belongs to, so the `page` event credits them. */
  opening: string | null;
}

export interface BrowserFrame {
  /** Base64 JPEG. */
  data: string;
  /** The page's CSS viewport the frame shows: input coordinates are in this space. */
  width: number;
  height: number;
}

export type BrowserInputEvent =
  | { type: "mouse"; action: "move" | "down" | "up" | "click"; x: number; y: number; button?: "left" | "middle" | "right"; clickCount?: number }
  | { type: "wheel"; x: number; y: number; deltaX: number; deltaY: number }
  | { type: "key"; action: "down" | "up" | "press"; key: string }
  | { type: "text"; text: string }
  | { type: "navigate"; url: string }
  | { type: "history"; action: "back" | "forward" | "reload" };

const MAX_LOGS = 300;
const LOCK_WAIT_MS = 60_000;

export const PRIVATE_PREFIX = "private-";

export class BrowserError extends Error {}

export class BrowserManager {
  readonly options: BrowserManagerOptions;
  readonly #sessions = new Map<string, Session>();
  #browser: Promise<Browser> | null = null;
  #sweeper: NodeJS.Timeout | null = null;
  #closed = false;
  #scratches = 0;

  constructor(options: BrowserManagerOptions) {
    this.options = options;
  }

  /** One tool call from one agent: validated, run, and always answered. */
  async call(scope: BrowserScope, op: BrowserOp, args: unknown, signal?: AbortSignal): Promise<BrowserResult> {
    const parsed = browserSpec(op).schema.safeParse(args);
    if (!parsed.success) {
      return { text: `Invalid arguments for ${op}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}`, isError: true };
    }
    if (this.#closed) return { text: "The browser is shutting down.", isError: true };
    try {
      return await runOp(this, scope, op, parsed.data as never, signal);
    } catch (error) {
      if (error instanceof BrowserError) return { text: error.message, isError: true };
      const message = error instanceof Error ? error.message.split("\n").slice(0, 6).join("\n") : String(error);
      return { text: `${op} failed: ${message}`, isError: true };
    }
  }

  // ---- sessions -----------------------------------------------------------

  sessionName(scope: BrowserScope, name: string | null): string {
    return name ?? `${PRIVATE_PREFIX}${scope.agentId.slice(0, 8)}`;
  }

  find(projectId: string, name: string): Session | undefined {
    return this.#sessions.get(`${projectId}\0${name}`);
  }

  /** The session, opened (and its saved state restored) when it is not. */
  async open(scope: BrowserScope, name: string | null): Promise<Session> {
    const resolved = this.sessionName(scope, name);
    const existing = this.find(scope.projectId, resolved);
    if (existing) {
      if (!existing.shared && existing.owner !== scope.agentId) throw new BrowserError(`${resolved} is another agent's private session.`);
      existing.lastUsed = Date.now();
      return existing;
    }
    if (name?.startsWith(PRIVATE_PREFIX)) throw new BrowserError(`Session names starting with ${PRIVATE_PREFIX} are reserved for private sessions.`);
    await this.#makeRoom();
    const browser = await this.#launch();
    const statePath = this.#statePath(scope.projectId, resolved);
    const saved = await readFile(statePath, "utf8").then(JSON.parse, () => undefined);
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
      acceptDownloads: true,
      ...(saved ? { storageState: saved } : {}),
    });
    context.setDefaultTimeout(15_000);
    context.setDefaultNavigationTimeout(30_000);
    const refuse = this.options.refuse;
    if (refuse) {
      const verdicts = new Map<string, { at: number; reason: string | null }>();
      await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.protocol === "data:" || url.protocol === "blob:" || url.protocol === "about:") return route.continue();
        const origin = `${url.protocol}//${url.host}`;
        let verdict = verdicts.get(origin);
        if (!verdict || Date.now() - verdict.at > 60_000) {
          verdict = { at: Date.now(), reason: await refuse(url, scope.projectId).catch((e: unknown) => String(e)) };
          verdicts.set(origin, verdict);
        }
        if (verdict.reason) {
          if (route.request().isNavigationRequest()) {
            return route.fulfill({ status: 403, contentType: "text/plain", body: `Blocked by the harness: ${verdict.reason}` });
          }
          return route.abort("blockedbyclient");
        }
        return route.continue();
      });
    }
    const session: Session = {
      key: `${scope.projectId}\0${resolved}`,
      projectId: scope.projectId,
      name: resolved,
      shared: name !== null,
      owner: name === null ? scope.agentId : null,
      context,
      tabs: new Map(),
      nextTab: 1,
      lastUsed: Date.now(),
      current: new Map(),
      inFlight: 0,
      opening: null,
    };
    context.on("page", (page) => {
      // A popup or target=_blank: tracked like any tab, opened by whoever opened its opener.
      if ([...session.tabs.values()].some((t) => t.page === page)) return;
      const opener = session.opening ?? [...session.tabs.values()].find((t) => t.busy)?.busy ?? session.owner ?? "human";
      this.#track(session, page, opener);
    });
    this.#sessions.set(session.key, session);
    this.#startSweeper();
    this.#changed(scope.projectId);
    return session;
  }

  async newTab(session: Session, openedBy: string): Promise<Tab> {
    const max = this.options.maxTabsPerAgent ?? 6;
    const mine = [...session.tabs.values()].filter((t) => t.openedBy === openedBy).length;
    if (openedBy !== "human" && mine >= max) {
      throw new BrowserError(`You already have ${mine} tabs in ${session.name}; close one (browser_close) or reuse it.`);
    }
    session.opening = openedBy;
    try {
      const page = await session.context.newPage();
      return this.#tabOf(session, page) ?? this.#track(session, page, openedBy);
    } finally {
      session.opening = null;
    }
  }

  #tabOf(session: Session, page: Page): Tab | undefined {
    return [...session.tabs.values()].find((t) => t.page === page);
  }

  #track(session: Session, page: Page, openedBy: string): Tab {
    const tab: Tab = {
      id: `t${session.nextTab++}`,
      page,
      openedBy,
      busy: null,
      controlledBy: null,
      logs: [],
      seq: 0,
      lock: Promise.resolve(),
      screencast: null,
    };
    const log = (kind: LogEntry["kind"], level: string, text: string) => {
      tab.logs.push({ seq: ++tab.seq, at: new Date().toISOString(), kind, level, text: text.slice(0, 2000) });
      if (tab.logs.length > MAX_LOGS) tab.logs.splice(0, tab.logs.length - MAX_LOGS);
    };
    page.on("console", (message) => {
      const where = message.location();
      log("console", message.type(), `${message.text()}${where.url ? ` (${where.url}:${where.lineNumber})` : ""}`);
    });
    page.on("pageerror", (error) => log("console", "pageerror", error.stack ?? error.message));
    page.on("requestfailed", (request) => log("network", "failed", `${request.method()} ${request.url()} ${request.failure()?.errorText ?? ""}`));
    page.on("response", (response) => {
      if (response.status() >= 400) log("network", String(response.status()), `${response.request().method()} ${response.url()}`);
    });
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) this.#changed(session.projectId);
    });
    page.on("close", () => {
      session.tabs.delete(tab.id);
      for (const [agent, id] of session.current) if (id === tab.id) session.current.delete(agent);
      tab.screencast?.cdp.detach().catch(() => {});
      tab.screencast = null;
      this.#changed(session.projectId);
    });
    page.on("dialog", (dialog) => {
      // A dialog blocks the page until answered; nobody headless can.
      log("console", "dialog", `${dialog.type()}: ${dialog.message()} (auto-${dialog.type() === "beforeunload" ? "accepted" : "dismissed"})`);
      void (dialog.type() === "beforeunload" ? dialog.accept() : dialog.dismiss()).catch(() => {});
    });
    session.tabs.set(tab.id, tab);
    this.#changed(session.projectId);
    return tab;
  }

  /** The tab a call names, or the agent's current one; null when it has none. */
  tab(session: Session, agentId: string, id: string | null): Tab | null {
    if (id) {
      const tab = session.tabs.get(id);
      if (!tab) throw new BrowserError(`There is no tab ${id} in ${session.name}. browser_tabs lists them.`);
      return tab;
    }
    const current = session.current.get(agentId);
    if (current && session.tabs.has(current)) return session.tabs.get(current)!;
    // Joining a shared session: the newest tab is a fair default.
    const tabs = [...session.tabs.values()];
    return tabs.find((t) => t.openedBy === agentId) ?? tabs.at(-1) ?? null;
  }

  /**
   * Runs `fn` holding the tab's lock. `act` calls (anything that changes
   * the page) are refused while a person controls the tab.
   */
  async withTab<T>(session: Session, tab: Tab, agentId: string, act: boolean, fn: () => Promise<T>): Promise<T> {
    if (act && tab.controlledBy) {
      throw new BrowserError(`A person is controlling tab ${tab.id} in ${session.name}. Wait for them to hand it back, or use another tab.`);
    }
    const previous = tab.lock;
    let release!: () => void;
    tab.lock = new Promise<void>((resolve) => (release = resolve));
    let timer: NodeJS.Timeout | undefined;
    const waited = await Promise.race([
      previous.then(() => true),
      new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), LOCK_WAIT_MS))),
    ]);
    clearTimeout(timer);
    if (!waited) {
      release();
      throw new BrowserError(`Tab ${tab.id} has been busy (${tab.busy ?? "another call"}) for a minute; try again or use another tab.`);
    }
    session.inFlight++;
    session.lastUsed = Date.now();
    tab.busy = agentId;
    session.current.set(agentId, tab.id);
    try {
      return await fn();
    } finally {
      tab.busy = null;
      session.inFlight--;
      session.lastUsed = Date.now();
      release();
      this.#changed(session.projectId);
    }
  }

  async closeSession(session: Session): Promise<void> {
    this.#sessions.delete(session.key);
    try {
      const statePath = this.#statePath(session.projectId, session.name);
      await mkdir(dirname(statePath), { recursive: true });
      await session.context.storageState({ path: statePath });
    } catch (error) {
      this.options.log?.warn({ err: error, session: session.name }, "could not save a browser session's state");
    }
    await session.context.close().catch(() => {});
    this.#changed(session.projectId);
  }

  /** Forgets a session's saved cookies and storage. */
  async forget(projectId: string, name: string): Promise<void> {
    await rm(this.#statePath(projectId, name), { force: true });
  }

  #statePath(projectId: string, name: string): string {
    return join(this.options.stateDir, projectId.replace(/[^A-Za-z0-9-]/g, "_"), `${name}.json`);
  }

  // ---- live view -----------------------------------------------------------

  /** Every session of a project, for the Browser view. */
  list(projectId: string): BrowserSessionInfo[] {
    return [...this.#sessions.values()]
      .filter((s) => s.projectId === projectId)
      .sort((a, b) => Number(b.shared) - Number(a.shared) || a.name.localeCompare(b.name))
      .map((s) => ({
        name: s.name,
        shared: s.shared,
        owner: s.owner,
        lastUsedAt: new Date(s.lastUsed).toISOString(),
        tabs: [...s.tabs.values()].map((t): BrowserTabInfo => ({
          id: t.id,
          title: "",
          url: t.page.url(),
          openedBy: t.openedBy,
          busy: t.busy,
          controlledBy: t.controlledBy,
          viewport: t.page.viewportSize() ?? { width: 1280, height: 800 },
        })),
      }));
  }

  /** The same, with each tab's title (which needs a round trip to the page). */
  async describe(projectId: string): Promise<BrowserSessionInfo[]> {
    const sessions = this.list(projectId);
    await Promise.all(
      sessions.flatMap((s) =>
        s.tabs.map(async (t) => {
          const tab = this.find(projectId, s.name)?.tabs.get(t.id);
          t.title = (await tab?.page.title().catch(() => "")) ?? "";
        }),
      ),
    );
    return sessions;
  }

  #liveTab(projectId: string, session: string, tabId: string): { session: Session; tab: Tab } {
    const s = this.find(projectId, session);
    const tab = s?.tabs.get(tabId);
    if (!s || !tab) throw new BrowserError(`There is no tab ${tabId} in ${session}.`);
    return { session: s, tab };
  }

  /** Streams a tab's frames to `onFrame` until the returned function is called. */
  async watch(projectId: string, session: string, tabId: string, onFrame: (frame: BrowserFrame) => void, onClose?: () => void): Promise<() => void> {
    const { session: s, tab } = this.#liveTab(projectId, session, tabId);
    if (!tab.screencast) {
      const cdp = await s.context.newCDPSession(tab.page);
      const watchers = new Set<(frame: BrowserFrame) => void>();
      tab.screencast = { cdp, watchers };
      cdp.on("Page.screencastFrame", (frame) => {
        void cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
        const out: BrowserFrame = { data: frame.data, width: frame.metadata.deviceWidth, height: frame.metadata.deviceHeight };
        for (const watcher of watchers) watcher(out);
      });
      await cdp.send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: 1600, maxHeight: 1600, everyNthFrame: 1 });
    }
    const screencast = tab.screencast;
    screencast.watchers.add(onFrame);
    const closed = () => onClose?.();
    tab.page.once("close", closed);
    s.lastUsed = Date.now();
    // A first frame now: a static page sends none until something changes.
    void tab.page
      .screenshot({ type: "jpeg", quality: 60 })
      .then((buffer) => {
        const size = tab.page.viewportSize() ?? { width: 1280, height: 800 };
        onFrame({ data: buffer.toString("base64"), width: size.width, height: size.height });
      })
      .catch(() => {});
    return () => {
      tab.page.off("close", closed);
      screencast.watchers.delete(onFrame);
      if (screencast.watchers.size === 0 && tab.screencast === screencast) {
        tab.screencast = null;
        void screencast.cdp.send("Page.stopScreencast").catch(() => {});
        void screencast.cdp.detach().catch(() => {});
      }
    };
  }

  /** A person takes a tab (agents' actions on it are refused) or hands it back. */
  control(projectId: string, session: string, tabId: string, userId: string, take: boolean): void {
    const { tab } = this.#liveTab(projectId, session, tabId);
    if (take) {
      if (tab.controlledBy && tab.controlledBy !== userId) throw new BrowserError("Someone else is controlling this tab.");
      tab.controlledBy = userId;
    } else if (tab.controlledBy === userId) tab.controlledBy = null;
    this.#changed(projectId);
  }

  /** A person's input on a tab they control. */
  async input(projectId: string, session: string, tabId: string, userId: string, event: BrowserInputEvent): Promise<void> {
    const { session: s, tab } = this.#liveTab(projectId, session, tabId);
    if (tab.controlledBy !== userId) throw new BrowserError("Take control of the tab first.");
    s.lastUsed = Date.now();
    const page = tab.page;
    switch (event.type) {
      case "mouse": {
        const button = event.button ?? "left";
        if (event.action === "move") await page.mouse.move(event.x, event.y);
        else if (event.action === "down") await page.mouse.move(event.x, event.y).then(() => page.mouse.down({ button, clickCount: event.clickCount ?? 1 }));
        else if (event.action === "up") await page.mouse.up({ button, clickCount: event.clickCount ?? 1 });
        else await page.mouse.click(event.x, event.y, { button, clickCount: event.clickCount ?? 1 });
        return;
      }
      case "wheel":
        await page.mouse.move(event.x, event.y);
        await page.mouse.wheel(event.deltaX, event.deltaY);
        return;
      case "key":
        if (event.action === "down") await page.keyboard.down(event.key);
        else if (event.action === "up") await page.keyboard.up(event.key);
        else await page.keyboard.press(event.key);
        return;
      case "text":
        await page.keyboard.insertText(event.text);
        return;
      case "navigate": {
        let url: URL;
        try {
          url = new URL(/^[a-z]+:/i.test(event.url) ? event.url : `https://${event.url}`);
        } catch {
          throw new BrowserError("Not a URL.");
        }
        if (url.protocol !== "http:" && url.protocol !== "https:") throw new BrowserError("Only http and https.");
        await page.goto(url.href, { waitUntil: "commit" });
        return;
      }
      case "history":
        if (event.action === "back") await page.goBack({ waitUntil: "commit" });
        else if (event.action === "forward") await page.goForward({ waitUntil: "commit" });
        else await page.reload({ waitUntil: "commit" });
        return;
    }
  }

  /** A person opens a tab in a session from the Browser view. */
  async humanTab(projectId: string, session: string, userId: string, url: string | null): Promise<string> {
    const s = this.find(projectId, session);
    if (!s) throw new BrowserError(`There is no session ${session}.`);
    const tab = await this.newTab(s, "human");
    tab.controlledBy = userId;
    if (url) await this.input(projectId, session, tab.id, userId, { type: "navigate", url });
    this.#changed(projectId);
    return tab.id;
  }

  async humanClose(projectId: string, session: string, tabId: string | null): Promise<void> {
    const s = this.find(projectId, session);
    if (!s) return;
    if (tabId) await s.tabs.get(tabId)?.page.close().catch(() => {});
    else await this.closeSession(s);
  }

  /** A throwaway page outside every session, for work that needs a canvas (image diffs). */
  async scratch<T>(fn: (page: Page) => Promise<T>): Promise<T> {
    this.#scratches++;
    try {
      const browser = await this.#launch();
      const context = await browser.newContext();
      try {
        return await fn(await context.newPage());
      } finally {
        await context.close().catch(() => {});
      }
    } finally {
      this.#scratches--;
    }
  }

  // ---- lifecycle -------------------------------------------------------------

  async #launch(): Promise<Browser> {
    if (!this.#browser) {
      this.#browser = chromium
        .launch({
          executablePath: this.options.executablePath,
          headless: this.options.headless ?? true,
          args: ["--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--mute-audio", "--hide-scrollbars"],
        })
        .then((browser) => {
          browser.on("disconnected", () => {
            this.#browser = null;
            const projects = new Set([...this.#sessions.values()].map((s) => s.projectId));
            this.#sessions.clear();
            for (const p of projects) this.#changed(p);
          });
          return browser;
        });
      this.#browser.catch(() => (this.#browser = null));
    }
    return this.#browser;
  }

  async #makeRoom(): Promise<void> {
    const max = this.options.maxContexts ?? 8;
    if (this.#sessions.size < max) return;
    const idle = [...this.#sessions.values()]
      .filter((s) => s.inFlight === 0 && ![...s.tabs.values()].some((t) => t.screencast || t.controlledBy))
      .sort((a, b) => a.lastUsed - b.lastUsed)[0];
    if (!idle) throw new BrowserError(`All ${max} browser sessions on this server are in use; try again shortly.`);
    await this.closeSession(idle);
  }

  #startSweeper(): void {
    if (this.#sweeper) return;
    this.#sweeper = setInterval(() => void this.sweep(), 30_000);
    this.#sweeper.unref();
  }

  /** Saves and closes sessions nobody has used or watched for `idleMs`, then the browser if nothing is left. */
  async sweep(now = Date.now()): Promise<void> {
    const idleMs = this.options.idleMs ?? 15 * 60_000;
    for (const s of [...this.#sessions.values()]) {
      const watched = [...s.tabs.values()].some((t) => t.screencast || t.controlledBy);
      if (s.inFlight === 0 && !watched && now - s.lastUsed > idleMs) await this.closeSession(s);
    }
    if (this.#sessions.size === 0 && this.#scratches === 0 && this.#browser) {
      const browser = await this.#browser.catch(() => null);
      this.#browser = null;
      await browser?.close().catch(() => {});
      if (this.#sweeper) clearInterval(this.#sweeper);
      this.#sweeper = null;
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#sweeper) clearInterval(this.#sweeper);
    for (const s of [...this.#sessions.values()]) await this.closeSession(s);
    const browser = await this.#browser?.catch(() => null);
    this.#browser = null;
    await browser?.close().catch(() => {});
  }

  #changed(projectId: string): void {
    try {
      this.options.onChange?.(projectId);
    } catch {
      // A listener's failure is not the browser's.
    }
  }
}
