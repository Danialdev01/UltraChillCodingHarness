/**
 * What the OMP specs share: a new thread in the first project, and commands
 * sent over the socket as the app sends them. The server they run against
 * is described in each spec.
 */

export const API = process.env.E2E_API ?? "http://127.0.0.1:3001";
export const COOKIE = process.env.E2E_SESSION ?? "dev";

type Json = Record<string, any>;

export async function api(path: string): Promise<Json> {
  const response = await fetch(`${API}${path}`, { headers: { cookie: `ucch_session=${COOKIE}` } });
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  return response.json() as Promise<Json>;
}

/** Sends one command over the socket as the app does, and returns its ack. */
export async function dispatch(origin: string, id: string, command: Json): Promise<Json> {
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

/**
 * A new thread in the first project: its id and the page that shows it.
 * With `session`, a project session on a worktree of its own, forked from
 * the project's default branch.
 */
export async function newThread(
  origin: string,
  title: string,
  options: { session?: boolean } = {},
): Promise<{ threadId: string; href: string; projectHash: string }> {
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
  const ack = await dispatch(origin, `create-${Date.now()}`, {
    type: "thread.create",
    projectId: found.project.id,
    title: `${title} ${new Date().toISOString()}`,
    ...(options.session ? { baseBranch: found.project.defaultBranch } : {}),
  });
  const threadId = ack.events?.find((e: Json) => e.event.type === "thread.created")?.event.threadId as string | undefined;
  if (!threadId) throw new Error("thread.create: no thread.created");
  const { threads } = await api(`/api/projects/${found.project.hash}/threads`);
  const thread = threads.find((t: Json) => t.id === threadId);
  return { threadId, href: `/${found.ws.hash}/p/${found.project.hash}/${thread.hash}`, projectHash: found.project.hash };
}
