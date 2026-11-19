import type { FastifyInstance, FastifyReply } from "fastify";
import type { SshHostRow } from "@ucch/db";
import {
  mediaTypeFor,
  RemoteChatPermissionReply,
  RemoteChatSend,
  RemoteFolderCreate,
  RemoteMove,
  RemoteTextWrite,
  remoteBasename,
  SshHostCreate,
  SshHostUpdate,
  SshTerminalOpen,
  type WorkspacePermission,
} from "@ucch/protocol";
import {
  RemoteBinaryError,
  RemoteConflictError,
  RemoteFiles,
  RemoteMissingError,
  RemotePathError,
  RemoteRefusedError,
  RemoteStaleError,
  RemoteTooLargeError,
} from "./sftp-files.js";
import {
  probeSsh,
  SshConnectError,
  SshHostKeyMismatch,
  SshSecretError,
  summarizeSshHost,
  targetOf,
  type SshHostService,
  type SshPool,
  type SshTarget,
} from "./ssh-hosts.js";
import { SshExecutor } from "./ssh-executor.js";
import { SshShellProcess } from "./ssh-terminal.js";
import type { TerminalReactor } from "./terminals.js";
import { remoteSystemPrompt, RemoteChatBusy, RemoteChatNotFound, type RemoteChatReactor } from "./remote-chat.js";
import { contentDisposition } from "./uploads.js";

type Principal = { userId: string };

export interface SshRouteDeps {
  principalFor(cookies: Record<string, string | undefined>): Promise<Principal | null>;
  /** Whether the workspace exists and this user's role in it allows `permission`. */
  workspaceAllows(workspaceId: string, userId: string, permission: WorkspacePermission): Promise<boolean>;
  hosts: SshHostService;
  pool: SshPool;
  terminals: Pick<TerminalReactor, "openRemote" | "mayWatch" | "has" | "close">;
  /**
   * Whether some socket still watches a terminal's output. A remote shell
   * nobody watches is closed after a short grace (see `REMOTE_UNWATCHED_MS`).
   */
  watched?: (terminalId: string) => boolean;
  chats: RemoteChatReactor;
  /** `SECRET_KEY`; without it no credential can be stored, so no host can be. */
  secretKey: string | undefined;
  maxUploadBytes: number;
  /** Tests stand in for the network. */
  probe?: (target: SshTarget) => Promise<string>;
  /** A shell process; tests stand in for the network. */
  shell?: (target: SshTarget, cols: number, rows: number, label: string, onHostKey: (fp: string) => void) => SshShellProcess;
}

/**
 * How long a remote shell may go unwatched before it is closed.
 *
 * The Terminal page never reattaches to a shell: a reload opens fresh ones
 * in the same panes. So a shell whose page went -- a reload, a closed tab --
 * is nobody's, and holding it for the reactor's idle timeout would leave a
 * reload or two a person short of their terminal limit. The grace covers a
 * socket that drops and resubscribes.
 */
export const REMOTE_UNWATCHED_MS = 30_000;
const WATCH_CHECK_MS = 10_000;

const NO_SECRET_KEY = "SECRET_KEY is not configured, so SSH credentials cannot be stored safely";

function badBody(error: { issues: { path: PropertyKey[]; message: string }[] }) {
  const issue = error.issues[0];
  return { error: issue ? `${issue.path.join(".") || "body"}: ${issue.message}` : "invalid body" };
}

/** Turns a connection's and a file's refusals into status codes; anything else is a server error. */
export function sshFailure(error: unknown, reply: FastifyReply) {
  if (error instanceof SshHostKeyMismatch) {
    return reply.code(409).send({ error: error.message, code: "host_key_changed", presented: error.presented });
  }
  if (error instanceof SshSecretError) return reply.code(409).send({ error: error.message });
  if (error instanceof SshConnectError) return reply.code(502).send({ error: `Could not connect: ${error.message}` });
  if (error instanceof RemotePathError) return reply.code(400).send({ error: error.message });
  if (error instanceof RemoteMissingError) return reply.code(404).send({ error: error.message });
  if (error instanceof RemoteStaleError) {
    return reply.code(409).send({ error: error.message, content: error.content, version: error.version });
  }
  if (error instanceof RemoteConflictError) return reply.code(409).send({ error: error.message });
  if (error instanceof RemoteTooLargeError) return reply.code(413).send({ error: error.message });
  if (error instanceof RemoteBinaryError) return reply.code(415).send({ error: error.message });
  if (error instanceof RemoteRefusedError) return reply.code(422).send({ error: error.message });
  throw error;
}

/**
 * The Terminal section: a workspace's SSH hosts, the shells opened on them,
 * their files over SFTP, and the agent that works on them.
 *
 * Seeing the list needs only `workspace.view`. Anything that reaches the
 * machine -- a shell, its files, the agent -- needs `project.write`: it is a
 * login on someone's server, and a viewer reads only. Adding, changing,
 * re-trusting or forgetting a host needs `workspace.manage`, since it is a
 * stored credential. A host or workspace the caller cannot see is a 404
 * throughout, never a 403 that confirms it is there.
 */
export function registerSshRoutes(app: FastifyInstance, deps: SshRouteDeps): void {
  const probe = deps.probe ?? probeSsh;

  function closeWhenUnwatched(terminalId: string, watched: (terminalId: string) => boolean): void {
    let unwatchedSince: number | null = null;
    const timer = setInterval(() => {
      if (!deps.terminals.has(terminalId)) {
        clearInterval(timer);
        return;
      }
      if (watched(terminalId)) {
        unwatchedSince = null;
        return;
      }
      unwatchedSince ??= Date.now();
      if (Date.now() - unwatchedSince >= REMOTE_UNWATCHED_MS) {
        clearInterval(timer);
        deps.terminals.close(terminalId);
      }
    }, WATCH_CHECK_MS);
    timer.unref();
  }

  /** The caller, when they hold `permission` in the workspace; else the reply is sent. */
  async function allowed(
    request: { cookies: Record<string, string | undefined> },
    reply: FastifyReply,
    workspaceId: string,
    permission: WorkspacePermission,
  ): Promise<Principal | null> {
    const principal = await deps.principalFor(request.cookies);
    if (!principal) {
      void reply.code(401).send({ error: "unauthorized" });
      return null;
    }
    if (!(await deps.workspaceAllows(workspaceId, principal.userId, "workspace.view"))) {
      void reply.code(404).send({ error: "workspace not found" });
      return null;
    }
    if (permission !== "workspace.view" && !(await deps.workspaceAllows(workspaceId, principal.userId, permission))) {
      void reply.code(403).send({ error: "your role in this workspace cannot do that" });
      return null;
    }
    return principal;
  }

  /** The host and the caller, when the caller holds `permission` in its workspace. */
  async function hostFor(
    request: { cookies: Record<string, string | undefined>; params: { id: string } },
    reply: FastifyReply,
    permission: WorkspacePermission,
  ): Promise<{ row: SshHostRow; principal: Principal } | null> {
    const principal = await deps.principalFor(request.cookies);
    if (!principal) {
      void reply.code(401).send({ error: "unauthorized" });
      return null;
    }
    const row = await deps.hosts.get(request.params.id).catch(() => null);
    if (!row || !(await deps.workspaceAllows(row.workspaceId, principal.userId, "workspace.view"))) {
      void reply.code(404).send({ error: "server not found" });
      return null;
    }
    if (permission !== "workspace.view" && !(await deps.workspaceAllows(row.workspaceId, principal.userId, permission))) {
      void reply.code(403).send({ error: "your role in this workspace cannot do that" });
      return null;
    }
    return { row, principal };
  }

  function needSecret(reply: FastifyReply): string | null {
    if (!deps.secretKey) {
      void reply.code(409).send({ error: NO_SECRET_KEY });
      return null;
    }
    return deps.secretKey;
  }

  /** The host's pooled connection, made into file operations. */
  async function filesOf(row: SshHostRow, secretKey: string): Promise<RemoteFiles> {
    const pooled = await deps.pool.get(row, targetOf(row, secretKey));
    return new RemoteFiles(pooled);
  }

  // ---- Hosts -------------------------------------------------------------------

  app.get<{ Params: { id: string } }>("/api/workspaces/:id/ssh-hosts", async (request, reply) => {
    if (!(await allowed(request, reply, request.params.id, "workspace.view"))) return reply;
    return { hosts: await deps.hosts.list(request.params.id) };
  });

  /**
   * Saves a host. The credentials are tried first -- a host that cannot be
   * logged into is a typo, not a record -- and the host key it presents is
   * pinned from then on.
   */
  app.post<{ Params: { id: string } }>("/api/workspaces/:id/ssh-hosts", async (request, reply) => {
    const parsed = SshHostCreate.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(badBody(parsed.error));
    const principal = await allowed(request, reply, request.params.id, "workspace.manage");
    if (!principal) return reply;
    const secretKey = needSecret(reply);
    if (!secretKey) return reply;
    const input = parsed.data;
    let hostKey: string;
    try {
      hostKey = await probe({ ...input, ...(input.passphrase ? { passphrase: input.passphrase } : {}), secret: input.secret, hostKeySha256: null });
    } catch (error) {
      request.log.info({ host: input.host, port: input.port, reason: (error as Error).message }, "ssh connection test failed");
      return sshFailure(error, reply);
    }
    const host = await deps.hosts.create(request.params.id, input, secretKey, principal.userId, hostKey);
    return reply.code(201).send({ host });
  });

  app.get<{ Params: { id: string } }>("/api/ssh-hosts/:id", async (request, reply) => {
    const found = await hostFor(request, reply, "workspace.view");
    if (!found) return reply;
    return { host: summarizeSshHost(found.row) };
  });

  /**
   * Changes a host. The credentials as they will be -- stored ones with the
   * change laid over -- are tried before they are kept. A new address is
   * another machine, so its key is pinned afresh.
   */
  app.patch<{ Params: { id: string } }>("/api/ssh-hosts/:id", async (request, reply) => {
    const parsed = SshHostUpdate.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(badBody(parsed.error));
    const found = await hostFor(request, reply, "workspace.manage");
    if (!found) return reply;
    const secretKey = needSecret(reply);
    if (!secretKey) return reply;
    const { row } = found;
    const input = parsed.data;
    let stored: SshTarget | null = null;
    if (input.secret === undefined) {
      try {
        stored = targetOf(row, secretKey);
      } catch (error) {
        return sshFailure(error, reply);
      }
    }
    const moved =
      (input.host !== undefined && input.host !== row.host) || (input.port !== undefined && input.port !== row.port);
    const passphrase = input.passphrase !== undefined ? input.passphrase || undefined : stored?.passphrase;
    const target: SshTarget = {
      host: input.host ?? row.host,
      port: input.port ?? row.port,
      username: input.username ?? row.username,
      authMethod: input.authMethod ?? (row.authMethod as SshTarget["authMethod"]),
      secret: input.secret ?? stored!.secret,
      ...(passphrase ? { passphrase } : {}),
      hostKeySha256: moved ? null : row.hostKeySha256,
    };
    let hostKey: string;
    try {
      hostKey = await probe(target);
    } catch (error) {
      return sshFailure(error, reply);
    }
    deps.pool.drop(row.id);
    const host = await deps.hosts.update(row, input, secretKey, hostKey);
    return { host };
  });

  /**
   * Forgets the pinned host key and pins whatever the server presents now:
   * for a server that was legitimately rebuilt. A manager's call, because
   * it is exactly what an attacker in the middle would want.
   */
  app.post<{ Params: { id: string } }>("/api/ssh-hosts/:id/retrust", async (request, reply) => {
    const found = await hostFor(request, reply, "workspace.manage");
    if (!found) return reply;
    const secretKey = needSecret(reply);
    if (!secretKey) return reply;
    try {
      const hostKey = await probe({ ...targetOf(found.row, secretKey), hostKeySha256: null });
      deps.pool.drop(found.row.id);
      return { host: await deps.hosts.setHostKey(found.row.id, hostKey) };
    } catch (error) {
      return sshFailure(error, reply);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/ssh-hosts/:id", async (request, reply) => {
    const found = await hostFor(request, reply, "workspace.manage");
    if (!found) return reply;
    deps.pool.drop(found.row.id);
    deps.chats.dropHost(found.row.id);
    await deps.hosts.remove(found.row.id);
    return reply.code(204).send();
  });

  // ---- Terminals ---------------------------------------------------------------

  /**
   * Opens a shell on the host under a terminal id the client minted and is
   * already watching (`terminal:{id}`), the way a project terminal opens.
   * Keystrokes and resizes then travel as the socket's terminal frames,
   * and `terminal.close` ends it. Replies at once; the shell connects in
   * the background and says so in the terminal.
   */
  app.post<{ Params: { id: string } }>("/api/ssh-hosts/:id/terminals", async (request, reply) => {
    const parsed = SshTerminalOpen.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(badBody(parsed.error));
    const found = await hostFor(request, reply, "project.write");
    if (!found) return reply;
    const secretKey = needSecret(reply);
    if (!secretKey) return reply;
    let target: SshTarget;
    try {
      target = targetOf(found.row, secretKey);
    } catch (error) {
      return sshFailure(error, reply);
    }
    const { row, principal } = found;
    const { terminalId, cols, rows } = parsed.data;
    // The watch is the claim: an id someone else holds is not this caller's.
    if (!deps.terminals.mayWatch(terminalId, principal.userId)) {
      return reply.code(409).send({ error: "that terminal id is taken" });
    }
    const label = `${row.username}@${row.host}${row.port === 22 ? "" : `:${row.port}`}`;
    const pin = (fingerprint: string) => {
      void deps.hosts.setHostKey(row.id, fingerprint).catch(() => {});
    };
    const opened = deps.terminals.openRemote(terminalId, principal.userId, cols, rows, (c, r) =>
      deps.shell ? deps.shell(target, c, r, label, pin) : new SshShellProcess(target, c, r, { label, onHostKey: pin }),
    );
    if (!opened) return reply.code(409).send({ error: "that terminal is already open" });
    if (deps.watched) closeWhenUnwatched(terminalId, deps.watched);
    return reply.code(201).send({ terminalId });
  });

  // ---- Files -------------------------------------------------------------------

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>("/api/ssh-hosts/:id/files", async (request, reply) => {
    const found = await hostFor(request, reply, "project.write");
    if (!found) return reply;
    const secretKey = needSecret(reply);
    if (!secretKey) return reply;
    try {
      const files = await filesOf(found.row, secretKey);
      const listing = await files.list(files.path(request.query.path));
      return { ...listing, home: files.home };
    } catch (error) {
      return sshFailure(error, reply);
    }
  });

  /**
   * A file's bytes, inline for a preview or as a download. As with
   * Resources, the type comes from the name's extension allow-list, never
   * from the server, and the response is sandboxed.
   */
  app.get<{ Params: { id: string }; Querystring: { path?: string; download?: string } }>(
    "/api/ssh-hosts/:id/files/content",
    async (request, reply) => {
      const found = await hostFor(request, reply, "project.write");
      if (!found) return reply;
      const secretKey = needSecret(reply);
      if (!secretKey) return reply;
      try {
        const files = await filesOf(found.row, secretKey);
        const path = files.path(request.query.path, false);
        const download = request.query.download === "1";
        const mediaType = mediaTypeFor(path);
        if (!download && !mediaType) return reply.code(415).send({ error: "this file cannot be previewed" });
        const file = await files.read(path);
        return reply
          .header("content-type", download ? "application/octet-stream" : mediaType!)
          .header("x-content-type-options", "nosniff")
          .header("content-security-policy", "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox")
          .header("content-disposition", download ? contentDisposition(remoteBasename(path)) : "inline")
          .header("cache-control", "private, no-store")
          .header("content-length", file.size)
          .send(file.stream);
      } catch (error) {
        return sshFailure(error, reply);
      }
    },
  );

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>("/api/ssh-hosts/:id/files/text", async (request, reply) => {
    const found = await hostFor(request, reply, "project.write");
    if (!found) return reply;
    const secretKey = needSecret(reply);
    if (!secretKey) return reply;
    try {
      const files = await filesOf(found.row, secretKey);
      const path = files.path(request.query.path, false);
      return { path, ...(await files.readText(path)) };
    } catch (error) {
      return sshFailure(error, reply);
    }
  });

  app.put<{ Params: { id: string } }>("/api/ssh-hosts/:id/files/text", { bodyLimit: 8 * 1024 * 1024 }, async (request, reply) => {
    const parsed = RemoteTextWrite.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(badBody(parsed.error));
    const found = await hostFor(request, reply, "project.write");
    if (!found) return reply;
    const secretKey = needSecret(reply);
    if (!secretKey) return reply;
    try {
      const files = await filesOf(found.row, secretKey);
      const path = files.path(parsed.data.path, false);
      return { path, ...(await files.writeText(path, parsed.data.content, parsed.data.ifVersion)) };
    } catch (error) {
      return sshFailure(error, reply);
    }
  });

  /** An upload: the raw bytes as `application/octet-stream`, the path in the query. */
  app.post<{ Params: { id: string }; Querystring: { path?: string; overwrite?: string } }>(
    "/api/ssh-hosts/:id/files",
    { bodyLimit: deps.maxUploadBytes },
    async (request, reply) => {
      if (!Buffer.isBuffer(request.body)) return reply.code(415).send({ error: "send the file as application/octet-stream" });
      const found = await hostFor(request, reply, "project.write");
      if (!found) return reply;
      const secretKey = needSecret(reply);
      if (!secretKey) return reply;
      try {
        const files = await filesOf(found.row, secretKey);
        const path = files.path(request.query.path, false);
        await files.write(path, request.body, request.query.overwrite === "1");
        return reply.code(201).send({ path });
      } catch (error) {
        return sshFailure(error, reply);
      }
    },
  );

  app.post<{ Params: { id: string } }>("/api/ssh-hosts/:id/files/folder", async (request, reply) => {
    const parsed = RemoteFolderCreate.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(badBody(parsed.error));
    const found = await hostFor(request, reply, "project.write");
    if (!found) return reply;
    const secretKey = needSecret(reply);
    if (!secretKey) return reply;
    try {
      const files = await filesOf(found.row, secretKey);
      const path = files.path(parsed.data.path, false);
      await files.mkdir(path);
      return reply.code(201).send({ path });
    } catch (error) {
      return sshFailure(error, reply);
    }
  });

  app.patch<{ Params: { id: string } }>("/api/ssh-hosts/:id/files/move", async (request, reply) => {
    const parsed = RemoteMove.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(badBody(parsed.error));
    const found = await hostFor(request, reply, "project.write");
    if (!found) return reply;
    const secretKey = needSecret(reply);
    if (!secretKey) return reply;
    try {
      const files = await filesOf(found.row, secretKey);
      const from = files.path(parsed.data.from, false);
      const to = files.path(parsed.data.to, false);
      await files.move(from, to);
      return { path: to };
    } catch (error) {
      return sshFailure(error, reply);
    }
  });

  app.delete<{ Params: { id: string }; Querystring: { path?: string } }>("/api/ssh-hosts/:id/files", async (request, reply) => {
    const found = await hostFor(request, reply, "project.write");
    if (!found) return reply;
    const secretKey = needSecret(reply);
    if (!secretKey) return reply;
    try {
      const files = await filesOf(found.row, secretKey);
      const removed = await files.remove(files.path(request.query.path, false));
      if (!removed) return reply.code(404).send({ error: "file not found" });
      return reply.code(204).send();
    } catch (error) {
      return sshFailure(error, reply);
    }
  });

  // ---- The agent ---------------------------------------------------------------

  /**
   * A message to the agent that works on this host. Replies once the turn
   * has started; what it says and asks arrives on the caller's own topic
   * as `remote_chat.event`.
   */
  app.post<{ Params: { id: string } }>("/api/ssh-hosts/:id/chat", async (request, reply) => {
    const parsed = RemoteChatSend.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(badBody(parsed.error));
    const found = await hostFor(request, reply, "project.write");
    if (!found) return reply;
    const secretKey = needSecret(reply);
    if (!secretKey) return reply;
    const { row, principal } = found;
    try {
      deps.chats.send({
        chatId: parsed.data.chatId,
        userId: principal.userId,
        hostId: row.id,
        workspaceId: row.workspaceId,
        text: parsed.data.text,
        ...(parsed.data.selection ? { selection: parsed.data.selection } : {}),
        ...(parsed.data.model ? { model: parsed.data.model } : {}),
        executor: async () => {
          const pooled = await deps.pool.get(row, targetOf(row, secretKey));
          return {
            executor: new SshExecutor(pooled),
            systemPrompt: remoteSystemPrompt({ name: row.name, username: row.username, host: row.host, port: row.port, home: pooled.home }),
          };
        },
      });
    } catch (error) {
      if (error instanceof RemoteChatBusy) return reply.code(409).send({ error: error.message });
      if (error instanceof RemoteChatNotFound) return reply.code(404).send({ error: "conversation not found" });
      throw error;
    }
    return reply.code(202).send({ chatId: parsed.data.chatId });
  });

  app.get<{ Params: { chatId: string } }>("/api/remote-chats/:chatId", async (request, reply) => {
    const principal = await deps.principalFor(request.cookies);
    if (!principal) return reply.code(401).send({ error: "unauthorized" });
    const history = deps.chats.history(request.params.chatId, principal.userId);
    if (!history) return reply.code(404).send({ error: "conversation not found" });
    return history;
  });

  app.post<{ Params: { chatId: string } }>("/api/remote-chats/:chatId/permission", async (request, reply) => {
    const parsed = RemoteChatPermissionReply.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(badBody(parsed.error));
    const principal = await deps.principalFor(request.cookies);
    if (!principal) return reply.code(401).send({ error: "unauthorized" });
    const { requestId, behavior, scope } = parsed.data;
    if (!deps.chats.reply(request.params.chatId, principal.userId, requestId, behavior, scope)) {
      return reply.code(404).send({ error: "that question is no longer open" });
    }
    return { ok: true };
  });

  app.post<{ Params: { chatId: string } }>("/api/remote-chats/:chatId/stop", async (request, reply) => {
    const principal = await deps.principalFor(request.cookies);
    if (!principal) return reply.code(401).send({ error: "unauthorized" });
    deps.chats.stop(request.params.chatId, principal.userId);
    return { ok: true };
  });
}
