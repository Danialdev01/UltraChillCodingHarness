import { can, normalizeWorkspacePath, resolveCredentialSource, sessionBranch } from "@ucch/protocol";
import type {
  Command,
  ContainerState,
  CredentialPolicy,
  CredentialSource,
  DomainEvent,
  Membership,
  ProviderId,
  WorkspacePermission,
} from "@ucch/protocol";

/**
 * The decision function: given current state and a command, what actually
 * happened?
 *
 * This is pure. No database, no Docker, no clock, no randomness -- every
 * non-deterministic input arrives through `DecisionContext`. That is what
 * makes the rules here exhaustively testable as a plain table of
 * (state, command) -> events, and it is where every invariant about what the
 * system will and will not do belongs.
 *
 * Side effects are not performed here. A decision emits events that record
 * intent (`container.state_changed: creating`), and a reactor acts on them
 * and emits what resulted. The log therefore distinguishes what was asked for
 * from what happened.
 */

export interface ProjectSnapshot {
  id: string;
  hash: string;
  workspaceId: string;
  containerState: ContainerState;
  defaultBranch: string;
}

export interface WorkspaceSnapshot {
  id: string;
  credentialPolicy: CredentialPolicy;
  /** The caller's membership, resolved by the engine; null when they have none. */
  membership: Membership | null;
}

export interface ThreadSnapshot {
  id: string;
  projectId: string;
  status: "idle" | "running" | "cancelling" | "error";
  /** The backend its first turn bound it to; null until one has run. */
  provider: ProviderId | null;
  /** Whose credentials it was started on; null on threads older than the column. */
  credentialSource: CredentialSource | null;
  /** creating | ready | error for a session with its own worktree; null when it shares the project's. */
  worktreeState?: "creating" | "ready" | "error" | null;
}

export interface TurnSnapshot {
  id: string;
  threadId: string;
  seq: number;
  checkpointBefore: string | null;
  revertedAt: Date | null;
}

export interface DecisionState {
  workspace?: WorkspaceSnapshot;
  project?: ProjectSnapshot;
  thread?: ThreadSnapshot;
  turn?: TurnSnapshot;
}

/** Non-deterministic inputs, injected so decisions stay pure. */
export interface DecisionContext {
  userId: string;
  now: Date;
  newId: () => string;
  newHash: () => string;
}

export type DecisionError = {
  code: "not_found" | "forbidden" | "conflict" | "invalid";
  message: string;
};

export type Decision =
  | { ok: true; events: DomainEvent[] }
  /** Accepted, but produces no durable event -- terminal streams, for example. */
  | { ok: true; events: []; passthrough: true }
  | { ok: false; error: DecisionError };

const ok = (events: DomainEvent[]): Decision => ({ ok: true, events });
const passthrough = (): Decision => ({ ok: true, events: [], passthrough: true });
const fail = (code: DecisionError["code"], message: string): Decision => ({
  ok: false,
  error: { code, message },
});

export function decide(state: DecisionState, command: Command, ctx: DecisionContext): Decision {
  switch (command.type) {
    // -- Projects ------------------------------------------------------------

    case "project.create": {
      // A project must land in a workspace the caller is a member of, or the
      // workspace boundary would be advisory rather than enforced.
      if (!state.workspace?.membership) return fail("not_found", "workspace not found");
      if (!can(state.workspace.membership, "project.create")) {
        return fail("forbidden", "your role in this workspace cannot create projects");
      }

      // A project with no repository has no URL to fall back on, so the name
      // is the only thing that can supply one and the command is refused
      // without it.
      const name = command.name?.trim() || (command.repoUrl ? deriveName(command.repoUrl) : "");
      if (!name) {
        return fail(
          "invalid",
          command.repoUrl
            ? "could not derive a project name from the repository URL"
            : "a project with no repository needs a name",
        );
      }

      const mode = command.mode ?? "development";
      if (command.database && mode !== "development") {
        return fail("invalid", "only a development project can have a database");
      }

      return ok([
        {
          type: "project.created",
          projectId: ctx.newId(),
          workspaceId: state.workspace.id,
          hash: ctx.newHash(),
          name,
          // Null rather than absent: "this project has no remote" is the
          // fact the clone reactor reads to start one instead of fetching it.
          repoUrl: command.repoUrl ?? null,
          defaultBranch: command.branch ?? "main",
          mode,
          database: command.database ?? null,
        },
      ]);
    }

    case "project.start": {
      const project = requireProject(state, ctx, "project.write");
      if ("error" in project) return project.decision;

      // Already where we want to be, or already on the way. Emitting a second
      // `creating` would make the reactor start a duplicate container.
      if (project.value.containerState === "running") return ok([]);
      if (project.value.containerState === "creating") return ok([]);

      return ok([
        { type: "container.state_changed", projectId: project.value.id, state: "creating" },
      ]);
    }

    case "project.stop": {
      const project = requireProject(state, ctx, "project.write");
      if ("error" in project) return project.decision;
      if (project.value.containerState === "stopped" || project.value.containerState === "absent") {
        return ok([]);
      }
      return ok([
        { type: "container.state_changed", projectId: project.value.id, state: "stopped" },
      ]);
    }

    case "project.delete": {
      const project = requireProject(state, ctx, "workspace.manage");
      if ("error" in project) return project.decision;
      return ok([
        { type: "container.state_changed", projectId: project.value.id, state: "absent" },
      ]);
    }

    // -- Threads -------------------------------------------------------------

    case "thread.create": {
      const project = requireProject(state, ctx, "session.create");
      if ("error" in project) return project.decision;

      const hash = ctx.newHash();
      return ok([
        {
          type: "thread.created",
          threadId: ctx.newId(),
          projectId: project.value.id,
          title: command.title?.trim() || "Untitled",
          createdByUserId: ctx.userId,
          credentialSource: resolveCredentialSource(
            state.workspace!.credentialPolicy,
            command.credentialSource,
          ),
          hash,
          // A parallel session: its own worktree, on its own branch, so two
          // sessions forked from the same base never share a checkout.
          ...(command.baseBranch ? { baseBranch: command.baseBranch, branch: sessionBranch(hash) } : {}),
        },
      ]);
    }

    case "thread.send": {
      const thread = requireThread(state, ctx, "project.write");
      if ("error" in thread) return thread.decision;
      const project = requireProject(state, ctx, "project.write");
      if ("error" in project) return project.decision;

      // One turn at a time per thread. Queueing a second would interleave two
      // agents editing the same working tree.
      if (thread.value.status === "running" || thread.value.status === "cancelling") {
        return fail("conflict", "this thread already has a turn in progress");
      }

      // A session's turn runs in its worktree. Until that exists the agent
      // would land in the project's main folder, on somebody else's branch.
      if (thread.value.worktreeState === "creating") {
        return fail("conflict", "this session's worktree is still being created");
      }
      if (thread.value.worktreeState === "error") {
        return fail("conflict", "this session's worktree could not be created; start a new session");
      }

      // A CLI provider's session belongs to that provider: Claude Code cannot
      // resume a Codex rollout, and the native loop cannot see either. A
      // thread that has run is bound, and switching means a new thread.
      if (command.provider && thread.value.provider && command.provider !== thread.value.provider) {
        return fail(
          "conflict",
          `this thread runs on ${thread.value.provider}; start a new thread to switch provider`,
        );
      }

      return ok([
        {
          type: "user.message",
          threadId: thread.value.id,
          text: command.text,
          // Only when there are some: an ordinary message keeps the shape it
          // has always had, and so does the log.
          ...(command.images?.length ? { images: command.images } : {}),
          ...(command.mode ? { mode: command.mode } : {}),
        },
      ]);
    }

    case "thread.cancel": {
      const thread = requireThread(state, ctx, "project.write");
      if ("error" in thread) return thread.decision;
      if (thread.value.status !== "running") {
        return fail("conflict", "no turn is running on this thread");
      }
      // The turn is not over yet -- the reactor aborts the run in flight and
      // the loop closes it with `agent.turn_completed`. This records only
      // that stopping was asked for, which is what moves the thread to
      // `cancelling` and keeps a second message out until the loop unwinds.
      return ok([{ type: "thread.cancel_requested", threadId: thread.value.id }]);
    }

    case "thread.permission_reply": {
      const thread = requireThread(state, ctx, "project.write");
      if ("error" in thread) return thread.decision;
      if (thread.value.status !== "running") {
        return fail("conflict", "no turn is waiting on this thread");
      }
      // Nothing to record here: the CLI's stream carries the resolution as
      // `agent.permission_resolved` once the answer has actually reached
      // it, in order with the tool result that follows. The reactor is
      // handed the command and does the delivering.
      return ok([]);
    }

    case "thread.revert": {
      const thread = requireThread(state, ctx, "project.write");
      if ("error" in thread) return thread.decision;
      if (thread.value.status === "running") {
        return fail("conflict", "cannot revert while a turn is running");
      }

      const turn = state.turn;
      if (!turn || turn.threadId !== thread.value.id) {
        return fail("not_found", "turn not found on this thread");
      }
      if (turn.revertedAt) return fail("conflict", "this turn has already been reverted");
      // Without a `before` checkpoint there is no tree to restore, and
      // reverting the chat alone would leave the files ahead of the thread.
      if (!turn.checkpointBefore) {
        return fail("conflict", "this turn has no checkpoint to revert to");
      }

      return ok([
        {
          type: "checkpoint.reverted",
          threadId: thread.value.id,
          turnId: turn.id,
          commitSha: turn.checkpointBefore,
        },
      ]);
    }

    case "thread.fork": {
      const thread = requireThread(state, ctx, "session.create");
      if ("error" in thread) return thread.decision;
      const turn = state.turn;
      if (!turn || turn.threadId !== thread.value.id) {
        return fail("not_found", "turn not found on this thread");
      }

      return ok([
        {
          type: "thread.created",
          threadId: ctx.newId(),
          projectId: thread.value.projectId,
          title: "Fork",
          hash: ctx.newHash(),
          createdByUserId: ctx.userId,
          // A fork carries on the conversation, so it bills where it came from.
          credentialSource: resolveCredentialSource(
            state.workspace!.credentialPolicy,
            thread.value.credentialSource,
          ),
        },
      ]);
    }

    // -- Terminals -----------------------------------------------------------
    //
    // Terminal traffic is a stream, not a fact worth persisting. These are
    // accepted and routed straight to the runtime; only `terminal.output` is
    // published, and it is transient.

    case "terminal.create": {
      // The only one of the four that names a project, and so the only one
      // that can be checked against its members. The reactor holds the rest:
      // a session remembers who opened it, and refuses input from anyone
      // else.
      const project = requireProject(state, ctx, "project.write");
      if ("error" in project) return project.decision;
      if (command.credentialWorkspaceId) {
        // Signing in the workspace's own subscription writes the login every
        // member's turns may run on, so it is an admin's to do.
        if (command.program === "shell" || !command.program) {
          return fail("invalid", "only a sign-in terminal can target workspace credentials");
        }
        if (command.credentialWorkspaceId !== project.value.workspaceId) {
          return fail("invalid", "workspace credentials can only be signed in from one of its projects");
        }
        if (!can(state.workspace?.membership, "credentials.manage")) {
          return fail("forbidden", "only a workspace admin can sign in its subscription");
        }
      }
      return passthrough();
    }

    case "terminal.input":
    case "terminal.resize":
    case "terminal.close":
      return passthrough();

    // -- Files, git, previews -------------------------------------------------

    case "file.write": {
      const project = requireProject(state, ctx, "project.write");
      if ("error" in project) return project.decision;
      if (project.value.containerState !== "running") {
        return fail("conflict", "the project container is not running");
      }
      const path = normalizeWorkspacePath(command.path);
      if (!path) return fail("invalid", `path escapes the workspace: ${command.path}`);

      return ok([
        { type: "file.changed", projectId: project.value.id, path, change: "modified" },
      ]);
    }

    case "git.commit": {
      const project = requireProject(state, ctx, "project.write");
      if ("error" in project) return project.decision;
      if (project.value.containerState !== "running") {
        return fail("conflict", "the project container is not running");
      }
      // The commit sha is not knowable until git has written the object, so
      // `git.committed` is emitted by the reactor, not here.
      return ok([]);
    }

    case "git.push": {
      const project = requireProject(state, ctx, "project.write");
      if ("error" in project) return project.decision;
      if (project.value.containerState !== "running") {
        return fail("conflict", "the project container is not running");
      }
      return ok([]);
    }

    case "preview.publish": {
      const project = requireProject(state, ctx, "project.write");
      if ("error" in project) return project.decision;
      return ok([]);
    }

    case "preview.delete":
      // Names no project, so there is no owner to check it against, and no
      // reactor deletes anything. Refused until both exist.
      return fail("invalid", "deleting a preview is not supported");
  }
}

// -- Helpers -----------------------------------------------------------------

type Required<T> = { value: T } | { error: true; decision: Decision };

/**
 * The caller's standing in the project's workspace. A non-member is told
 * not_found rather than forbidden: whether a project exists is itself
 * information they have no right to. A member whose role falls short is told
 * forbidden, since they can already see the project.
 */
function membershipFor(
  state: DecisionState,
  permission: WorkspacePermission,
  what: string,
): Decision | null {
  const membership =
    state.workspace && state.project && state.workspace.id === state.project.workspaceId
      ? state.workspace.membership
      : null;
  if (!membership) return fail("not_found", `${what} not found`);
  if (!can(membership, permission)) {
    return fail("forbidden", `your role in this workspace does not allow this (${permission})`);
  }
  return null;
}

function requireProject(
  state: DecisionState,
  _ctx: DecisionContext,
  permission: WorkspacePermission,
): Required<ProjectSnapshot> {
  if (!state.project) return { error: true, decision: fail("not_found", "project not found") };
  const refused = membershipFor(state, permission, "project");
  if (refused) return { error: true, decision: refused };
  return { value: state.project };
}

function requireThread(
  state: DecisionState,
  _ctx: DecisionContext,
  permission: WorkspacePermission,
): Required<ThreadSnapshot> {
  if (!state.thread) return { error: true, decision: fail("not_found", "thread not found") };
  // A thread is only as private as its project: without this, anyone holding
  // a thread id could cancel, revert, fork or answer permission prompts on it.
  if (!state.project || state.project.id !== state.thread.projectId) {
    return { error: true, decision: fail("not_found", "thread not found") };
  }
  const refused = membershipFor(state, permission, "thread");
  if (refused) return { error: true, decision: refused };
  return { value: state.thread };
}

/** `owner/repo.git` -> `repo`. */
function deriveName(repoUrl: string): string {
  const trimmed = repoUrl.replace(/\.git$/, "").replace(/\/+$/, "");
  const last = trimmed.split("/").pop() ?? "";
  return last.slice(0, 100);
}
