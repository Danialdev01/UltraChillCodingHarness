import { lookup } from "node:dns/promises";
import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
import type { FastifyInstance } from "fastify";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";
import { isBlocked } from "@ucch/agent";
import { BrowserError, type BrowserInputEvent, type BrowserManager } from "@ucch/browser";
import type { DomainEvent } from "@ucch/protocol";
import type { Principal } from "./auth.js";
import { projectRoot } from "./trees.js";
import type { ProjectSummary } from "./workspaces.js";

/**
 * The server's side of the agents' shared browser (`@ucch/browser`): what
 * its pages may reach, the Browser view's routes, and its live socket.
 */

// ---- network policy ----------------------------------------------------------

export interface BrowserPolicy {
  /** Pages may reach private networks beyond loopback (`BROWSER_ALLOW_PRIVATE`). */
  allowPrivate: boolean;
  /** Loopback ports no page may reach: the harness's own API. */
  deniedLocalPorts: readonly number[];
}

function isLoopback(address: string): boolean {
  return address === "::1" || address.startsWith("127.") || address === "::ffff:127.0.0.1" || /^::ffff:127\./.test(address);
}

/**
 * Why a page may not request `url`, or null.
 *
 * Loopback is allowed, so an agent can open the dev server it just started
 * (any port but the harness's own API). Other private and link-local
 * addresses -- the cloud metadata service, the LAN -- are refused unless
 * the operator allows them, by every address a name resolves to, as
 * `web_fetch` refuses them.
 */
export async function browserRefusal(url: URL, policy: BrowserPolicy): Promise<string | null> {
  if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "ws:" && url.protocol !== "wss:") {
    return `${url.protocol} is not allowed`;
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: string[];
  if (isIP(host)) addresses = [host];
  else if (host === "localhost" || host.endsWith(".localhost")) addresses = ["127.0.0.1"];
  else {
    try {
      addresses = (await lookup(host, { all: true })).map((a) => a.address);
    } catch {
      // Unresolvable: the browser will fail on its own, with a better message.
      return null;
    }
  }
  const port = Number(url.port || (url.protocol === "https:" || url.protocol === "wss:" ? 443 : 80));
  for (const address of addresses) {
    if (isLoopback(address)) {
      if (policy.deniedLocalPorts.includes(port)) return `port ${port} on this server is the harness itself`;
      continue;
    }
    if (!policy.allowPrivate && isBlocked(address)) return `${host} is a private or link-local address`;
  }
  return null;
}

// ---- change notices ------------------------------------------------------------

/** `resource.changed browser` for a project, at most every 250 ms. */
export function browserNotifier(publish: (projectId: string, event: DomainEvent) => void): (projectId: string) => void {
  const pending = new Map<string, NodeJS.Timeout>();
  return (projectId) => {
    if (pending.has(projectId)) return;
    pending.set(
      projectId,
      setTimeout(() => {
        pending.delete(projectId);
        publish(projectId, { type: "resource.changed", projectId, resource: "browser" });
      }, 250).unref(),
    );
  };
}

// ---- routes ------------------------------------------------------------------------

export interface BrowserRouteDeps {
  browser: BrowserManager | undefined;
  /** Why there is no browser, for the view to say. */
  unavailable: string | null;
  projectFor(request: { cookies: Record<string, string | undefined>; params: { hash: string } }): Promise<ProjectSummary | null>;
  principalFor(cookies: Record<string, string | undefined>): Promise<Principal | null>;
  /** Whether a chat session is one of the project's. */
  threadInProject(threadId: string, projectId: string): Promise<boolean>;
  workspaceRoot: string;
}

const SessionName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/);
/** A tab for a chat session's agent, or, without one, in a named shared session. */
const OpenTab = z.object({
  thread: z.string().uuid().nullable().default(null),
  session: SessionName.default("shared"),
  url: z.string().trim().min(1).max(4000),
  name: z.string().trim().max(60).nullable().default(null),
});

/**
 * The Browser view's routes under `/api/projects/:hash/browser`: the
 * project's sessions and tabs, and a person opening or closing a tab. A
 * person may look at every session of a project they can see -- private
 * sessions are private between agents, not from the people they work for.
 */
export function registerBrowserRoutes(app: FastifyInstance, deps: BrowserRouteDeps): void {
  type Hash = { hash: string };
  const failure = (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) });

  app.get<{ Params: Hash }>("/api/projects/:hash/browser", async (request, reply) => {
    const project = await deps.projectFor(request);
    if (!project) return reply.code(404).send({ error: "project not found" });
    if (!deps.browser) return { available: false, reason: deps.unavailable, maxTabs: 0, sessions: [] };
    return { available: true, reason: null, maxTabs: await deps.browser.maxTabs(project.id), sessions: await deps.browser.describe(project.id) };
  });

  app.post<{ Params: Hash }>("/api/projects/:hash/browser/tabs", async (request, reply) => {
    const project = await deps.projectFor(request);
    const principal = await deps.principalFor(request.cookies);
    if (!project || !principal) return reply.code(404).send({ error: "project not found" });
    if (!principal.scopes.includes("exec")) return reply.code(403).send({ error: "you cannot drive this project's browser" });
    if (!deps.browser) return reply.code(409).send({ error: deps.unavailable ?? "no browser on this server" });
    const parsed = OpenTab.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "a URL is required, and a name of at most 60 characters" });
    try {
      const { thread, session, url, name } = parsed.data;
      if (thread && !(await deps.threadInProject(thread, project.id))) return reply.code(404).send({ error: "session not found" });
      const scope = { projectId: project.id, agentId: thread ?? "human", worktree: projectRoot(deps.workspaceRoot, project.id) };
      return await deps.browser.humanTab(scope, thread ? null : session, url, name || null);
    } catch (error) {
      return reply.code(error instanceof BrowserError ? 400 : 500).send(failure(error));
    }
  });

  app.post<{ Params: Hash & { session: string; tab: string } }>("/api/projects/:hash/browser/tabs/:session/:tab/capture", async (request, reply) => {
    const project = await deps.projectFor(request);
    if (!project) return reply.code(404).send({ error: "project not found" });
    if (!deps.browser) return reply.code(409).send({ error: deps.unavailable ?? "no browser on this server" });
    try {
      return await deps.browser.annotate(project.id, request.params.session, request.params.tab);
    } catch (error) {
      return reply.code(error instanceof BrowserError ? 400 : 500).send(failure(error));
    }
  });

  app.delete<{ Params: Hash & { session: string; tab: string } }>("/api/projects/:hash/browser/tabs/:session/:tab", async (request, reply) => {
    const project = await deps.projectFor(request);
    const principal = await deps.principalFor(request.cookies);
    if (!project || !principal) return reply.code(404).send({ error: "project not found" });
    if (!principal.scopes.includes("exec")) return reply.code(403).send({ error: "you cannot drive this project's browser" });
    if (!deps.browser) return reply.code(409).send({ error: "no browser on this server" });
    const tab = request.params.tab === "*" ? null : request.params.tab;
    await deps.browser.humanClose(project.id, request.params.session, tab);
    return { ok: true };
  });
}

// ---- live view -------------------------------------------------------------------

const Point = { x: z.number().finite(), y: z.number().finite() };
const InputEvent: z.ZodType<BrowserInputEvent> = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("mouse"),
    action: z.enum(["move", "down", "up", "click"]),
    ...Point,
    button: z.enum(["left", "middle", "right"]).optional(),
    clickCount: z.number().int().min(1).max(3).optional(),
  }),
  z.object({ type: z.literal("wheel"), ...Point, deltaX: z.number().finite(), deltaY: z.number().finite() }),
  z.object({ type: z.literal("key"), action: z.enum(["down", "up", "press"]), key: z.string().min(1).max(40) }),
  z.object({ type: z.literal("text"), text: z.string().min(1).max(4000) }),
  z.object({ type: z.literal("navigate"), url: z.string().min(1).max(4000) }),
  z.object({ type: z.literal("history"), action: z.enum(["back", "forward", "reload"]) }),
]) as z.ZodType<BrowserInputEvent>;

const LiveMessage = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("control"), take: z.boolean() }),
  z.object({ kind: z.literal("resize"), width: z.number().int().min(240).max(3840), height: z.number().int().min(240).max(2400) }),
  z.object({ kind: z.literal("input"), event: InputEvent }),
]);

/** Frames waiting in a slow socket before newer ones are dropped. */
const MAX_BUFFERED = 2 * 1024 * 1024;

export interface BrowserLiveDeps {
  browser: BrowserManager;
  redeemTicket(ticket: string | undefined): Principal | null;
  canAccessProject(userId: string, projectId: string): Promise<boolean>;
}

/**
 * `/browser-ws?ticket=…&project=<id>&session=…&tab=…`: one tab, live.
 *
 * Server to client: binary frames, each a JPEG behind a 4-byte header (the
 * page's CSS width and height, uint16 big-endian), which is the space input
 * coordinates are in; and JSON text: `{"kind":"error","message"}`,
 * `{"kind":"closed"}`. Client to server, JSON text: `{"kind":"control",
 * "take":bool}`, `{"kind":"resize","width","height"}`, and
 * `{"kind":"input","event":…}` while in control.
 *
 * Its own socket rather than the event bus: frames are large, frequent and
 * worthless a second later, and nothing about them belongs in the log.
 */
export class BrowserLive {
  readonly #wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  constructor(private readonly deps: BrowserLiveDeps) {}

  handleUpgrade(request: IncomingMessage, socket: NodeJS.Socket & { destroy(): void }, head: Buffer): void {
    const url = new URL(request.url ?? "/", "http://localhost");
    const principal = this.deps.redeemTicket(url.searchParams.get("ticket") ?? undefined);
    const projectId = url.searchParams.get("project") ?? "";
    const session = url.searchParams.get("session") ?? "";
    const tab = url.searchParams.get("tab") ?? "";
    const deny = (status: string) => {
      socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    if (!principal) return deny("401 Unauthorized");
    if (!z.string().uuid().safeParse(projectId).success || !session || !tab) return deny("400 Bad Request");
    void this.deps.canAccessProject(principal.userId, projectId).then(
      (allowed) => {
        if (!allowed) return deny("404 Not Found");
        this.#wss.handleUpgrade(request, socket as never, head, (ws) => void this.#accept(ws, principal, projectId, session, tab));
      },
      () => deny("500 Internal Server Error"),
    );
  }

  async #accept(ws: WebSocket, principal: Principal, projectId: string, session: string, tab: string): Promise<void> {
    const browser = this.deps.browser;
    const say = (message: Record<string, unknown>) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
    };
    let stop: (() => void) | null = null;
    let controlling = false;
    try {
      stop = await browser.watch(
        projectId,
        session,
        tab,
        (frame) => {
          if (ws.readyState !== ws.OPEN || ws.bufferedAmount > MAX_BUFFERED) return;
          const jpeg = Buffer.from(frame.data, "base64");
          const out = Buffer.allocUnsafe(4 + jpeg.length);
          out.writeUInt16BE(Math.min(65535, Math.round(frame.width)), 0);
          out.writeUInt16BE(Math.min(65535, Math.round(frame.height)), 2);
          jpeg.copy(out, 4);
          ws.send(out, { binary: true });
        },
        () => {
          say({ kind: "closed" });
          ws.close();
        },
      );
    } catch (error) {
      say({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      ws.close();
      return;
    }

    // In order: a click's down and up must not overtake each other.
    let queue = Promise.resolve();
    ws.on("message", (raw, isBinary) => {
      if (isBinary) return;
      let parsed;
      try {
        parsed = LiveMessage.safeParse(JSON.parse(raw.toString()));
      } catch {
        return say({ kind: "error", message: "not JSON" });
      }
      if (!parsed.success) return say({ kind: "error", message: "not a browser message" });
      const message = parsed.data;
      queue = queue.then(async () => {
        try {
          if (!principal.scopes.includes("exec")) throw new BrowserError("You can watch this browser but not drive it.");
          if (message.kind === "control") {
            browser.control(projectId, session, tab, principal.userId, message.take);
            controlling = message.take;
          } else if (message.kind === "resize") await browser.resize(projectId, session, tab, principal.userId, message.width, message.height);
          else await browser.input(projectId, session, tab, principal.userId, message.event);
        } catch (error) {
          say({ kind: "error", message: error instanceof Error ? error.message.split("\n")[0] : String(error) });
        }
      });
    });
    ws.on("close", () => {
      stop?.();
      // A person who leaves hands the tab back.
      if (controlling) {
        try {
          browser.control(projectId, session, tab, principal.userId, false);
        } catch {
          // The tab is gone.
        }
      }
    });
    ws.on("error", () => {});
  }

  close(): void {
    for (const client of this.#wss.clients) client.terminate();
    this.#wss.close();
  }
}
