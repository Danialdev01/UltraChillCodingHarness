import { eq } from "drizzle-orm";
import { agentDeliberations, projects, type Database } from "@ucch/db";
import {
  COUNCIL_DEFAULT_ROUNDS,
  COUNCIL_DEFAULT_SIZE,
  COUNCIL_MAX,
  COUNCIL_MAX_ROUNDS,
  COUNCIL_MIN,
  type CatalogueModel,
  type Command,
  type DomainEvent,
  type PickHarness,
  type ProviderId,
} from "@ucch/protocol";
import { z } from "zod";
import type { Principal } from "./auth.js";
import { applyProjection, type EngineResult } from "./engine.js";
import type { EventStore } from "./eventstore.js";
import type { SubagentRunner } from "./subagents.js";

/**
 * What `@reviewer` and `@council` have in common: the children they run,
 * what they cost, and how they are stopped. The two themselves are
 * `peer-review.ts` and `council.ts`.
 */

/** What a project uses when a message names nothing (`projects.deliberation`). */
export const DeliberationSettings = z.object({
  /** `auto`, `same`, or a model. */
  reviewerModel: z.string().trim().min(1).max(100).default("auto"),
  councilSize: z.number().int().min(COUNCIL_MIN).max(COUNCIL_MAX).default(COUNCIL_DEFAULT_SIZE),
  councilRounds: z.number().int().min(0).max(COUNCIL_MAX_ROUNDS).default(COUNCIL_DEFAULT_ROUNDS),
});
export type DeliberationSettings = z.infer<typeof DeliberationSettings>;

export async function deliberationSettings(db: Database, projectId: string): Promise<DeliberationSettings> {
  const [row] = await db.select({ stored: projects.deliberation }).from(projects).where(eq(projects.id, projectId)).limit(1);
  const parsed = DeliberationSettings.safeParse(row?.stored ?? {});
  return parsed.success ? parsed.data : DeliberationSettings.parse({});
}

export interface DeliberationDeps {
  store: Pick<EventStore, "append" | "threadHistory">;
  runner: Pick<SubagentRunner, "startManaged">;
  dispatch(principal: Principal, command: Command): Promise<EngineResult>;
  harnesses(subject: string): Promise<PickHarness[]>;
  catalogue(): Promise<CatalogueModel[]>;
  settings(projectId: string): Promise<DeliberationSettings>;
  onError(error: unknown): void;
}

export type CancelledBy = Extract<DomainEvent, { type: "agent.deliberation_cancelled" }>["by"];

/** The thread it is for, and what its answers run on. */
export interface DeliberationParent {
  projectId: string;
  threadId: string;
  /** Whose subscriptions pay. */
  subject: string;
  author: { provider: ProviderId; model: string | null };
}

/** The reviews, or the councils, running in this process. */
export class RunningDeliberations {
  readonly #runs = new Map<string, { threadId: string; controller: AbortController }>();

  open(deliberationId: string, threadId: string): AbortController {
    const controller = new AbortController();
    this.#runs.set(deliberationId, { threadId, controller });
    return controller;
  }
  close(deliberationId: string): void {
    this.#runs.delete(deliberationId);
  }
  cancel(deliberationId: string, by: CancelledBy): boolean {
    const run = this.#runs.get(deliberationId);
    run?.controller.abort(by);
    return run !== undefined;
  }
  cancelThread(threadId: string, by: CancelledBy): void {
    for (const run of this.#runs.values()) if (run.threadId === threadId) run.controller.abort(by);
  }
  shutdown(): void {
    for (const run of this.#runs.values()) run.controller.abort("restart" satisfies CancelledBy);
  }
}

/**
 * What a `@reviewer` asked of a turn gets once the turn is over (plan4
 * §3.1): a review of a completed answer, a failure on the card for one
 * that failed, and nothing for one that was stopped or never opened --
 * a stop is the person's say, not the reviewer's.
 */
export function reviewAfterTurn(report: { turnId?: string; end?: "completed" | "cancelled" | "failed" }):
  | { turnId: string; failed?: string }
  | null {
  if (!report.turnId || !report.end || report.end === "cancelled") return null;
  return report.end === "failed"
    ? { turnId: report.turnId, failed: "the answer did not finish, so there was nothing to review" }
    : { turnId: report.turnId };
}

export function appendTo(store: DeliberationDeps["store"], parent: Pick<DeliberationParent, "projectId" | "threadId">) {
  return (events: DomainEvent[]) =>
    store.append({ projectId: parent.projectId, threadId: parent.threadId }, events, (tx) => applyProjection(tx, events, null));
}

/** Names the session's own model where a pick leaves it to the parent. */
export function pickedModel(pick: { model: string | null }, author: DeliberationParent["author"]): string | undefined {
  // Claude Code and Codex route by name, so a spent quota can move on; the
  // others run what they are, on whatever key they have.
  return pick.model ?? ((author.provider === "claude" || author.provider === "codex") ? author.model ?? undefined : undefined);
}

/** The last fenced block of `tag` in an answer, parsed as JSON. */
export function fencedJson(text: string, tag: string): unknown {
  const blocks = [...text.matchAll(new RegExp("^[ \\t]*(`{3,})" + tag + "[ \\t]*\\n([\\s\\S]*?)\\n[ \\t]*\\1[ \\t]*$", "gm"))];
  const last = blocks.at(-1)?.[2];
  if (last === undefined) return null;
  try {
    return JSON.parse(last) as unknown;
  } catch {
    return null;
  }
}

export function clip(text: string, chars: number): string {
  return text.length > chars ? `${text.slice(0, chars)}\n[… cut]` : text;
}

/** A tag of ours in what we quote would end the quote early. */
export function quoted(tag: string, text: string): string {
  return `<${tag}>\n${text.replaceAll(`</${tag}>`, `<\\/${tag}>`)}\n</${tag}>`;
}

/**
 * Nothing that was running before a restart is running now: each is closed
 * as failed. Its children are closed by `AgentMessaging.recover`, and a
 * council's held turn is released with the other queued threads.
 */
export async function recoverDeliberations(db: Database, store: Pick<EventStore, "append">): Promise<number> {
  const running = await db.select().from(agentDeliberations).where(eq(agentDeliberations.status, "running"));
  for (const row of running) {
    const events: DomainEvent[] = [
      { type: "agent.deliberation_cancelled", threadId: row.threadId, deliberationId: row.id, by: "restart" },
    ];
    await store.append({ projectId: row.projectId, threadId: row.threadId }, events, (tx) => applyProjection(tx, events, null));
  }
  return running.length;
}
