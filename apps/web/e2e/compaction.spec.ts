import { expect, test } from "@playwright/test";

/**
 * A compaction mid-turn draws as a divider in the answer (OMP OM4.1), and
 * the context meter drops with it (OM4.2).
 *
 * The server must run OMP turns on the replay of a compacting turn, with no
 * network: `OMP_ENABLED=true`, `OMP_BIN=scripts/load/fake-omp-compaction.sh`,
 * and an OpenRouter key saved for the dev user (any value: nothing calls
 * OpenRouter). Then:
 *
 *   pnpm --filter @ucch/web e2e compaction
 *
 * It opens a new session in the first project it can see and sends one
 * message on the Custom provider (`native`), which OMP_ENABLED routes to
 * OMP. The message goes over the socket rather than through the composer,
 * so the account's default provider does not decide which engine answers.
 */

const API = process.env.E2E_API ?? "http://127.0.0.1:3001";
const COOKIE = process.env.E2E_SESSION ?? "dev";

type Json = Record<string, any>;

async function api(path: string): Promise<Json> {
  const response = await fetch(`${API}${path}`, { headers: { cookie: `ucch_session=${COOKIE}` } });
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  return response.json() as Promise<Json>;
}

/** Sends one command over the socket as the app does, and returns its ack. */
async function dispatch(origin: string, id: string, command: Json): Promise<Json> {
  const ticket = await fetch(`${API}/api/ws-ticket`, { method: "POST", headers: { cookie: `ucch_session=${COOKIE}`, origin } });
  if (!ticket.ok) throw new Error(`ws-ticket: ${ticket.status}`);
  const socket = new WebSocket(`${API.replace(/^http/, "ws")}/ws?ticket=${(await ticket.json()).ticket}`);
  const ack = await new Promise<Json>((resolve, reject) => {
    socket.addEventListener("error", () => reject(new Error("socket error")), { once: true });
    socket.addEventListener("message", (message) => {
      const frame = JSON.parse(String(message.data)) as Json;
      if (frame.id === id) resolve(frame);
    });
    socket.addEventListener("open", () => socket.send(JSON.stringify({ kind: "dispatch", id, command })), { once: true });
  });
  socket.close();
  if (ack.kind !== "ack") throw new Error(`${command.type}: ${ack.code} ${ack.message}`);
  return ack;
}

/** A new thread in the first project: its id and the page that shows it. */
async function newThread(origin: string): Promise<{ threadId: string; href: string }> {
  const { workspaces } = await api("/api/workspaces");
  let found: { ws: Json; project: Json } | null = null;
  for (const ws of workspaces.filter((w: Json) => w.kind === "project" && !w.archived)) {
    const { projects } = await api(`/api/workspaces/${ws.id}/projects`);
    if (projects.length) {
      found = { ws, project: projects[0] };
      break;
    }
  }
  if (!found) throw new Error("no project to run in: create one first");
  const ack = await dispatch(origin, "compaction-spec-create", {
    type: "thread.create",
    projectId: found.project.id,
    title: `compaction spec ${new Date().toISOString()}`,
  });
  const threadId = ack.events?.find((e: Json) => e.event.type === "thread.created")?.event.threadId as string | undefined;
  if (!threadId) throw new Error("thread.create: no thread.created");
  const { threads } = await api(`/api/projects/${found.project.hash}/threads`);
  const thread = threads.find((t: Json) => t.id === threadId);
  return { threadId, href: `/${found.ws.hash}/p/${found.project.hash}/${thread.hash}` };
}

test("a compaction mid-turn is a divider with its figures", async ({ page, context, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const { threadId, href } = await newThread(origin);
  await context.addCookies([{ name: "ucch_session", value: COOKIE, domain: new URL(baseURL!).hostname, path: "/" }]);
  await page.goto(href);
  // Loaded and listening before the turn starts, so it is drawn live.
  await expect(page.locator("textarea[role=combobox]")).toBeEnabled({ timeout: 30_000 });
  await dispatch(origin, "compaction-spec-send", { type: "thread.send", threadId, text: "Fourth question.", provider: "native" });

  const divider = page.getByTestId("compaction-divider");
  await expect(divider).toBeVisible({ timeout: 60_000 });
  // The recording's own figures: OMP's `soft` method, 7383 -> 7363 tokens.
  await expect(divider).toContainText("Context compacted (soft) · 7k → 7k tokens");
  // Collapsed: the summary is a click away.
  const summary = divider.getByText("Summary: the session so far.", { exact: false });
  await expect(summary).toBeHidden();
  await divider.locator("summary").click();
  await expect(summary).toBeVisible();

  // The meter reads the session's own measure (OMP OM4.2), which the
  // compaction cut: fake-omp's 1280 tokens after the model call, a quarter
  // of that after -- not the turn's usage, and not the catalogue's window.
  await expect(page.locator('button[title^="Context "]')).toHaveAttribute("title", /\(320 \/ 200k tokens\)/, { timeout: 15_000 });

  // And it stays where it was once the page is drawn from the log.
  await page.reload();
  await expect(page.getByTestId("compaction-divider")).toContainText("Context compacted (soft)", { timeout: 30_000 });
});
