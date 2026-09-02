import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  generateHash,
  hasScope,
  REQUIRED_SCOPE,
  type Command,
  type ContainerState,
  type DomainEvent,
  type StoredEvent,
} from "@ucch/protocol";
import { previews, projects, threads, turns, workspaces, type Database, type Transaction } from "@ucch/db";
import type { EventStore } from "./eventstore.js";
import type { Principal } from "./auth.js";
import { decide, type DecisionContext, type DecisionState } from "./decide.js";
import { DrainableWorker } from "./worker.js";

export type EngineResult =
  | { ok: true; events: StoredEvent[] }
  | { ok: false; code: "unauthorized" | "forbidden" | "not_found" | "invalid" | "conflict" | "internal"; message: string };

interface QueueItem {
  principal: Principal;
  command: Command;
  resolve: (result: EngineResult) => void;
}

/**
 * Serializes every state-changing command through a single worker.
 *
 * Loading state, deciding, and appending is not atomic on its own -- between
 * the read and the write, a concurrent command could invalidate the state the
 * decision was made against. Rather than take row locks across the whole
 * decision, commands run one at a time. This trades write throughput for the
 * guarantee that no decision ever runs on stale state, which for a personal
 * harness is unambiguously the right way round.
 */
export class OrchestrationEngine {
  readonly worker: DrainableWorker<QueueItem>;

  constructor(
    private readonly db: Database,
    private readonly store: EventStore,
    private readonly reactors: Reactors,
    private readonly onError: (error: unknown, command: Command) => void = () => {},
  ) {
    this.worker = new DrainableWorker<QueueItem>("orchestration", async (item) => {
      // Every path must settle the caller's promise. An unhandled throw here
      // would leave `dispatch()` pending forever, which surfaces as a silent
      // client hang rather than an error.
      try {
        item.resolve(await this.#process(item));
      } catch (error) {
        this.onError(error, item.command);
        item.resolve({ ok: false, code: "internal", message: describeError(error) });
      }
    });
  }

  dispatch(principal: Principal, command: Command): Promise<EngineResult> {
    return new Promise((resolve) => {
      this.worker.push({ principal, command, resolve });
    });
  }

  async #process(item: QueueItem): Promise<EngineResult> {
    const { principal, command } = item;

    const required = REQUIRED_SCOPE[command.type];
    if (!required) {
      // A command with no scope entry is a programming error, not a request
      // to allow by default.
      return { ok: false, code: "internal", message: `no scope declared for ${command.type}` };
    }
    if (!hasScope(principal.scopes, required)) {
      return { ok: false, code: "forbidden", message: `requires ${required} scope` };
    }

    let state: DecisionState;
    try {
      state = await this.#loadState(command, principal);
    } catch (error) {
      return { ok: false, code: "internal", message: describeError(error) };
    }

    const ctx: DecisionContext = {
      userId: principal.userId,
      now: new Date(),
      newId: () => randomUUID(),
      newHash: () => generateHash(),
    };

    const decision = decide(state, command, ctx);
    if (!decision.ok) return { ok: false, code: decision.error.code, message: decision.error.message };

    let stored: StoredEvent[] = [];
    if (decision.events.length > 0) {
      const target = {
        projectId: resolveProjectId(state, decision.events) ?? state.project?.id ?? "",
        threadId: state.thread?.id ?? resolveThreadId(decision.events),
      };
      if (!target.projectId) {
        return { ok: false, code: "internal", message: "could not resolve the project for this command" };
      }

      stored = await this.store.append(target, decision.events, (tx) =>
        project(tx, decision.events, principal),
      );
    }

    // Reactors run after the transaction commits, so they always observe
    // durable state.
    this.reactors.react(command, decision.events, principal);

    return { ok: true, events: stored };
  }

  async #loadState(command: Command, principal: Principal): Promise<DecisionState> {
    const state: DecisionState = {};

    const threadId = "threadId" in command ? command.threadId : undefined;
    if (threadId) {
      const [row] = await this.db.select().from(threads).where(eq(threads.id, threadId)).limit(1);
      if (row) {
        state.thread = {
          id: row.id,
          projectId: row.projectId,
          status: row.status as "idle" | "running" | "cancelling" | "error",
        };
      }
    }

    const projectId = "projectId" in command ? command.projectId : state.thread?.projectId;
    if (projectId) {
      const [row] = await this.db
        .select({ project: projects, ownerUserId: workspaces.ownerUserId })
        .from(projects)
        .innerJoin(workspaces, eq(projects.workspaceId, workspaces.id))
        .where(eq(projects.id, projectId))
        .limit(1);
      if (row) {
        state.project = {
          id: row.project.id,
          hash: row.project.hash,
          workspaceId: row.project.workspaceId,
          // The workspace owner, not projects.user_id.
          userId: row.ownerUserId,
          containerState: row.project.containerState as ContainerState,
          defaultBranch: row.project.defaultBranch,
        };
      }
    }

    const workspaceId = "workspaceId" in command ? command.workspaceId : state.project?.workspaceId;
    if (workspaceId) {
      const [row] = await this.db
        .select({ id: workspaces.id, ownerUserId: workspaces.ownerUserId })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .limit(1);
      if (row) state.workspace = { id: row.id, ownerUserId: row.ownerUserId };
    }

    const turnId = "turnId" in command ? command.turnId : undefined;
    if (turnId) {
      const [row] = await this.db.select().from(turns).where(eq(turns.id, turnId)).limit(1);
      if (row) {
        state.turn = {
          id: row.id,
          threadId: row.threadId,
          seq: row.seq,
          checkpointBefore: row.checkpointBefore,
          revertedAt: row.revertedAt,
        };
      }
    }

    return state;
  }
}

/**
 * Applies events to the read model inside the append transaction, so the
 * projections can never durably disagree with the log.
 */
async function project(
  tx: Transaction,
  batch: readonly DomainEvent[],
  principal: Principal,
): Promise<void> {
  for (const event of batch) {
    switch (event.type) {
      case "project.created":
        await tx.insert(projects).values({
          id: event.projectId,
          hash: event.hash,
          workspaceId: event.workspaceId,
          userId: principal.userId,
          name: event.name,
          repoUrl: event.repoUrl,
          defaultBranch: event.defaultBranch,
        });
        break;

      case "project.cloned":
        await tx
          .update(projects)
          .set({ stack: event.stack, lastActiveAt: new Date() })
          .where(eq(projects.id, event.projectId));
        break;

      case "container.state_changed":
        await tx
          .update(projects)
          .set({
            containerState: event.state,
            containerError: event.error ?? null,
            lastActiveAt: new Date(),
          })
          .where(eq(projects.id, event.projectId));
        break;

      case "thread.created":
        await tx.insert(threads).values({
          id: event.threadId,
          projectId: event.projectId,
          title: event.title,
        });
        break;

      case "agent.turn_completed":
        await tx
          .update(turns)
          .set({ usage: event.usage, costUsd: event.costUsd, stopReason: event.stopReason })
          .where(eq(turns.id, event.turnId));
        await tx.update(threads).set({ status: "idle" }).where(eq(threads.id, event.threadId));
        break;

      case "agent.turn_failed":
        await tx.update(turns).set({ error: event.error }).where(eq(turns.id, event.turnId));
        await tx.update(threads).set({ status: "error" }).where(eq(threads.id, event.threadId));
        break;

      case "checkpoint.captured":
        await tx
          .update(turns)
          .set(
            event.position === "before"
              ? { checkpointBefore: event.commitSha }
              : { checkpointAfter: event.commitSha },
          )
          .where(eq(turns.id, event.turnId));
        break;

      case "checkpoint.reverted":
        await tx.update(turns).set({ revertedAt: new Date() }).where(eq(turns.id, event.turnId));
        break;

      case "preview.published":
        await tx
          .insert(previews)
          .values({
            hash: event.hash,
            projectId: event.projectId,
            commitSha: event.commitSha,
            port: event.port,
            expiresAt: new Date(event.expiresAt),
          })
          .onConflictDoNothing();
        break;

      default:
        // Most events are pure log entries with no projection. They are
        // rebuilt by replay rather than denormalized into a table.
        break;
    }
  }
}

function resolveProjectId(
  state: DecisionState,
  batch: readonly DomainEvent[],
): string | null {
  if (state.project) return state.project.id;
  for (const event of batch) {
    if ("projectId" in event && event.projectId) return event.projectId;
  }
  return null;
}

function resolveThreadId(batch: readonly DomainEvent[]): string | null {
  for (const event of batch) {
    if ("threadId" in event && event.threadId) return event.threadId;
  }
  return null;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Where side effects are dispatched. Implemented in later phases. */
export interface Reactors {
  react(
    command: Command,
    events: readonly DomainEvent[],
    principal: Principal,
  ): void;
}
