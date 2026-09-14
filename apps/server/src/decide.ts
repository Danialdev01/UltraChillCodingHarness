import { normalizeWorkspacePath } from "@ucch/protocol";
import type { Command, ContainerState, DomainEvent, ProviderId } from "@ucch/protocol";

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
  /** The owning workspace's owner, resolved by the engine. Never read from
   *  the project row's denormalised copy -- see the note in the db schema. */
  userId: string;
  containerState: ContainerState;
  defaultBranch: string;
}

export interface WorkspaceSnapshot {
  id: string;
  ownerUserId: string;
}

export interface ThreadSnapshot {
  id: string;
  projectId: string;
  status: "idle" | "running" | "cancelling" | "error";
  /** The backend its first turn bound it to; null until one has run. */
  provider: ProviderId | null;
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
      // A project must land in a workspace the caller owns, or the workspace
      // boundary would be advisory rather than enforced.
      if (!state.workspace) return fail("not_found", "workspace not found");
      if (state.workspace.ownerUserId !== ctx.userId) {
        return fail("not_found", "workspace not found");
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
        },
      ]);
    }

    case "project.start": {
      const project = requireProject(state, ctx);
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
      const project = requireProject(state, ctx);
      if ("error" in project) return project.decision;
      if (project.value.containerState === "stopped" || project.value.containerState === "absent") {
        return ok([]);
      }
      return ok([
        { type: "container.state_changed", projectId: project.value.id, state: "stopped" },
      ]);
    }

    case "project.delete": {
      const project = requireProject(state, ctx);
      if ("error" in project) return project.decision;
      return ok([
        { type: "container.state_changed", projectId: project.value.id, state: "absent" },
      ]);
    }

    // -- Threads -------------------------------------------------------------

    case "thread.create": {
      const project = requireProject(state, ctx);
      if ("error" in project) return project.decision;

      return ok([
        {
          type: "thread.created",
          threadId: ctx.newId(),
          projectId: project.value.id,
          title: command.title?.trim() || "Untitled",
        },
      ]);
    }

    case "thread.send": {
      const thread = requireThread(state);
      if ("error" in thread) return thread.decision;
      const project = requireProject(state, ctx);
      if ("error" in project) return project.decision;

      // One turn at a time per thread. Queueing a second would interleave two
      // agents editing the same working tree.
      if (thread.value.status === "running" || thread.value.status === "cancelling") {
        return fail("conflict", "this thread already has a turn in progress");
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
      const thread = requireThread(state);
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

    case "thread.revert": {
      const thread = requireThread(state);
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
      const thread = requireThread(state);
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
      // that can be checked against its owner. The reactor holds the rest:
      // a session remembers who opened it, and refuses input from anyone
      // else.
      const project = requireProject(state, ctx);
      if ("error" in project) return project.decision;
      return passthrough();
    }

    case "terminal.input":
    case "terminal.resize":
    case "terminal.close":
      return passthrough();

    // -- Files, git, previews -------------------------------------------------

    case "file.write": {
      const project = requireProject(state, ctx);
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
      const project = requireProject(state, ctx);
      if ("error" in project) return project.decision;
      if (project.value.containerState !== "running") {
        return fail("conflict", "the project container is not running");
      }
      // The commit sha is not knowable until git has written the object, so
      // `git.committed` is emitted by the reactor, not here.
      return ok([]);
    }

    case "git.push": {
      const project = requireProject(state, ctx);
      if ("error" in project) return project.decision;
      if (project.value.containerState !== "running") {
        return fail("conflict", "the project container is not running");
      }
      return ok([]);
    }

    case "preview.publish": {
      const project = requireProject(state, ctx);
      if ("error" in project) return project.decision;
      return ok([]);
    }

    case "preview.delete":
      return ok([]);
  }
}

// -- Helpers -----------------------------------------------------------------

type Required<T> = { value: T } | { error: true; decision: Decision };

function requireProject(state: DecisionState, ctx: DecisionContext): Required<ProjectSnapshot> {
  if (!state.project) return { error: true, decision: fail("not_found", "project not found") };
  if (state.project.userId !== ctx.userId) {
    // Reported as not_found rather than forbidden: whether a project exists is
    // itself information the caller has no right to.
    return { error: true, decision: fail("not_found", "project not found") };
  }
  return { value: state.project };
}

function requireThread(state: DecisionState): Required<ThreadSnapshot> {
  if (!state.thread) return { error: true, decision: fail("not_found", "thread not found") };
  return { value: state.thread };
}

/** `owner/repo.git` -> `repo`. */
function deriveName(repoUrl: string): string {
  const trimmed = repoUrl.replace(/\.git$/, "").replace(/\/+$/, "");
  const last = trimmed.split("/").pop() ?? "";
  return last.slice(0, 100);
}
