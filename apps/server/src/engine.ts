import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  generateHash,
  hasScope,
  REQUIRED_SCOPE,
  type Command,
  type ContainerState,
  type DomainEvent,
  type ProviderId,
  type StoredEvent,
} from "@ucch/protocol";
import {
  previews,
  projects,
  projectStats,
  threads,
  turns,
  workspaceMembers,
  workspaces,
  type Database,
  type Transaction,
} from "@ucch/db";
import type { EventStore } from "./eventstore.js";
import type { Principal } from "./auth.js";
import { decide, type DecisionContext, type DecisionState } from "./decide.js";
import { LATENCY_BUCKETS, registry } from "./metrics.js";
import { turnFailed } from "./project-stats.js";
import { DrainableWorker } from "./worker.js";
import { toMembership, toPolicy } from "./workspaces.js";

export type EngineResult =
  | { ok: true; events: StoredEvent[] }
  | { ok: false; code: "unauthorized" | "forbidden" | "not_found" | "invalid" | "conflict" | "internal"; message: string };

interface QueueItem {
  principal: Principal;
  command: Command;
  resolve: (result: EngineResult) => void;
  /** `performance.now()` at dispatch, for the time spent waiting in the queue. */
  enqueuedAt: number;
}

const waitSeconds = registry.histogram(
  "engine_wait_seconds",
  "Time a command waited in the engine queue before it started",
  LATENCY_BUCKETS,
  ["command"],
);
const processSeconds = registry.histogram(
  "engine_process_seconds",
  "Time the engine spent loading, deciding and appending one command",
  LATENCY_BUCKETS,
  ["command"],
);

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
      const labels = { command: item.command.type };
      const started = performance.now();
      waitSeconds.observe(labels, (started - item.enqueuedAt) / 1000);
      try {
        item.resolve(await this.#process(item));
      } catch (error) {
        this.onError(error, item.command);
        item.resolve({ ok: false, code: "internal", message: describeError(error) });
      } finally {
        processSeconds.observe(labels, (performance.now() - started) / 1000);
      }
    });
  }

  dispatch(principal: Principal, command: Command): Promise<EngineResult> {
    return new Promise((resolve) => {
      this.worker.push({ principal, command, resolve, enqueuedAt: performance.now() });
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
        applyProjection(tx, decision.events, principal),
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
          provider: (row.provider as ProviderId | null) ?? null,
          credentialSource:
            row.credentialSource === "workspace" || row.credentialSource === "member"
              ? row.credentialSource
              : null,
          worktreeState:
            row.worktreeState === "creating" || row.worktreeState === "ready" || row.worktreeState === "error"
              ? row.worktreeState
              : null,
        };
      }
    }

    const projectId = "projectId" in command ? command.projectId : state.thread?.projectId;
    if (projectId) {
      const [row] = await this.db
        .select({ project: projects })
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1);
      if (row) {
        state.project = {
          id: row.project.id,
          hash: row.project.hash,
          workspaceId: row.project.workspaceId,
          containerState: row.project.containerState as ContainerState,
          defaultBranch: row.project.defaultBranch,
        };
      }
    }

    const workspaceId = "workspaceId" in command ? command.workspaceId : state.project?.workspaceId;
    if (workspaceId) {
      // The caller's membership comes with the workspace: it is what every
      // decision about a project or thread in it is checked against.
      const [row] = await this.db
        .select({
          id: workspaces.id,
          credentialPolicy: workspaces.credentialPolicy,
          role: workspaceMembers.role,
          canCreateProject: workspaceMembers.canCreateProject,
          canCreateSession: workspaceMembers.canCreateSession,
        })
        .from(workspaces)
        .leftJoin(
          workspaceMembers,
          and(eq(workspaceMembers.workspaceId, workspaces.id), eq(workspaceMembers.userId, principal.userId)),
        )
        .where(eq(workspaces.id, workspaceId))
        .limit(1);
      if (row) {
        state.workspace = {
          id: row.id,
          credentialPolicy: toPolicy(row.credentialPolicy),
          membership: row.role
            ? toMembership({
                role: row.role,
                canCreateProject: row.canCreateProject,
                canCreateSession: row.canCreateSession,
              })
            : null,
        };
      }
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
 * Whoever the events are being projected on behalf of.
 *
 * Only `project.created` needs one, to own the new row. A reactor appending
 * turn events has no principal to speak of and passes `null` rather than
 * inventing one; a `Principal` satisfies this structurally.
 */
export interface ProjectionActor {
  userId: string;
}

/**
 * Applies events to the read model inside the append transaction, so the
 * projections can never durably disagree with the log.
 *
 * Every writer to the log must run this -- the engine for command events, the
 * agent reactor for turn events. An append with the projection skipped is how
 * the read model silently drifts from the log.
 *
 * Exported for its tests: these rules are the only thing keeping the read
 * model honest, and they are worth asserting statement by statement.
 */
export async function applyProjection(
  tx: Transaction,
  batch: readonly DomainEvent[],
  actor: ProjectionActor | null,
): Promise<void> {
  for (const event of batch) {
    switch (event.type) {
      case "project.created":
        // Only reachable through a command, which always has a principal.
        // Reaching here without one is a wiring mistake, and a loud one beats
        // a project row owned by nobody.
        if (!actor) throw new Error("project.created cannot be projected without an actor");
        await tx.insert(projects).values({
          id: event.projectId,
          hash: event.hash,
          workspaceId: event.workspaceId,
          userId: actor.userId,
          name: event.name,
          repoUrl: event.repoUrl,
          defaultBranch: event.defaultBranch,
        });
        await tx.insert(projectStats).values({ projectId: event.projectId });
        break;

      case "project.cloned":
        await tx
          .update(projects)
          .set({ stack: event.stack, lastActiveAt: new Date() })
          .where(eq(projects.id, event.projectId));
        break;

      case "project.stack_detected":
        await tx.update(projects).set({ stack: event.stack }).where(eq(projects.id, event.projectId));
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

      case "turn.started":
        // The turn's ordinal comes from a sub-select rather than a read
        // followed by a write: one statement, evaluated against the same
        // snapshot that inserts, so there is no window for a concurrent
        // turn to take the same seq. The unique index on
        // (thread_id, seq) is the backstop if one ever tries.
        await tx.insert(turns).values({
          id: event.turnId,
          threadId: event.threadId,
          seq: sql`(select coalesce(max(${turns.seq}) + 1, 0) from ${turns} where ${turns.threadId} = ${event.threadId})`,
          model: event.model ?? null,
        });
        // Until this landed nothing ever set `running`, so `thread.cancel`
        // always failed its guard and `thread.send` never rejected a second
        // concurrent turn. Both guards start working here.
        await tx.update(threads).set({ status: "running" }).where(eq(threads.id, event.threadId));
        // The first turn binds the thread to its backend; later ones cannot
        // move it (see `decide()`), so a set value is left alone.
        if (event.provider) {
          await tx
            .update(threads)
            .set({ provider: sql`coalesce(${threads.provider}, ${event.provider})` })
            .where(eq(threads.id, event.threadId));
        }
        // The project's latest turn now, and not failed (yet).
        await tx
          .update(projectStats)
          .set({ lastTurnId: event.turnId, lastTurnFailed: false, updatedAt: sql`now()` })
          .where(eq(projectStats.projectId, projectOfThread(event.threadId)));
        break;

      case "agent.session_started":
        // The resume token, the moment the CLI names it. A turn killed after
        // this point still has a session to continue from.
        await tx
          .update(threads)
          .set({ provider: event.provider, providerSessionId: event.sessionId })
          .where(eq(threads.id, event.threadId));
        break;

      case "thread.cancel_requested":
        // Not `idle`: the loop is still unwinding, and letting a new message
        // in before it finishes is exactly what the guard exists to stop.
        // `agent.turn_completed` moves it the rest of the way.
        await tx
          .update(threads)
          .set({ status: "cancelling" })
          .where(eq(threads.id, event.threadId));
        break;

      case "thread.created":
        await tx.insert(threads).values({
          id: event.threadId,
          projectId: event.projectId,
          title: event.title,
          createdByUserId: event.createdByUserId ?? null,
          credentialSource: event.credentialSource ?? null,
          // Events from before sessions had addresses replay to one derived
          // from the id, so a rebuilt table still has a unique hash per row.
          hash: event.hash ?? event.threadId.replace(/-/g, "").slice(0, 12),
          baseBranch: event.baseBranch ?? null,
          branch: event.branch ?? null,
          worktreeState: event.branch ? "creating" : null,
        });
        // An upsert, so a project without a row yet still counts.
        await tx
          .insert(projectStats)
          .values({ projectId: event.projectId, threadCount: 1 })
          .onConflictDoUpdate({
            target: projectStats.projectId,
            set: { threadCount: sql`${projectStats.threadCount} + 1`, updatedAt: sql`now()` },
          });
        break;

      case "thread.worktree_ready":
        await tx
          .update(threads)
          .set({ worktreeState: "ready", worktreeError: null })
          .where(eq(threads.id, event.threadId));
        break;

      case "thread.worktree_failed":
        await tx
          .update(threads)
          .set({ worktreeState: "error", worktreeError: event.error })
          .where(eq(threads.id, event.threadId));
        break;

      case "agent.turn_completed": {
        await tx
          .update(turns)
          .set({ usage: event.usage, costUsd: event.costUsd, stopReason: event.stopReason })
          .where(eq(turns.id, event.turnId));
        await tx.update(threads).set({ status: "idle" }).where(eq(threads.id, event.threadId));
        // Added to, never read and written back: the agent reactor appends
        // alongside the engine, and a read-modify-write would lose one.
        const { inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens } = event.usage;
        await tx
          .update(projectStats)
          .set({
            tokens: sql`${projectStats.tokens} + ${inputTokens + outputTokens + cacheReadInputTokens + cacheCreationInputTokens}`,
            costUsd: sql`${projectStats.costUsd} + ${event.costUsd}`,
            updatedAt: sql`now()`,
          })
          .where(eq(projectStats.projectId, projectOfThread(event.threadId)));
        await markLastTurnFailed(tx, event.turnId);
        break;
      }

      case "agent.turn_failed":
        await tx.update(turns).set({ error: event.error }).where(eq(turns.id, event.turnId));
        await tx.update(threads).set({ status: "error" }).where(eq(threads.id, event.threadId));
        await markLastTurnFailed(tx, event.turnId);
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

/** The project a thread belongs to, as a sub-select: turn events carry only the thread. */
function projectOfThread(threadId: string) {
  return sql`(select ${threads.projectId} from ${threads} where ${threads.id} = ${threadId})`;
}

/**
 * Whether the turn that just ended failed, on its project's row -- if it is
 * still the project's latest turn. An older turn ending late leaves the
 * newer one's flag alone. Reads the turns row the same transaction has just
 * updated.
 */
async function markLastTurnFailed(tx: Transaction, turnId: string): Promise<void> {
  await tx
    .update(projectStats)
    .set({
      lastTurnFailed: sql`coalesce((select ${turnFailed("t")} from ${turns} t where t.id = ${turnId}), false)`,
      updatedAt: sql`now()`,
    })
    .where(eq(projectStats.lastTurnId, turnId));
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
