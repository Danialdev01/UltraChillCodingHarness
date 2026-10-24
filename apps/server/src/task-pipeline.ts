import {
  ProviderId,
  type Command,
  type ProjectTask,
  type TaskReference,
  type TaskStage,
} from "@ucch/protocol";
import type { Principal } from "./auth.js";
import type { EventBus } from "./bus.js";
import type { EngineResult } from "./engine.js";
import type { TaskProgress, TasksService } from "./tasks.js";

export interface TaskPipelineDeps {
  tasks: Pick<TasksService, "get" | "progress" | "settings" | "docsDigest">;
  dispatch(principal: Principal, command: Command): Promise<EngineResult>;
  bus: Pick<EventBus, "subscribe">;
  agent: { allowAllFor(threadId: string): void };
  /** The account that owns the project: whose agent runs, and on whose bill. */
  ownerOf(projectId: string): Promise<{ userId: string; defaultProvider: string | null } | null>;
  /** Tells the project's open tabs a card changed. Never throws. */
  announce(projectId: string, task: ProjectTask): Promise<void>;
  onError(error: unknown, context: string): void;
}

/** A run that stopped because someone moved the card, not because it broke. */
class Cancelled extends Error {
  constructor() {
    super("cancelled");
  }
}

interface Running {
  controller: AbortController;
  principal: Principal;
  /** The thread a turn is running in right now, for the stop to reach. */
  threadId: string | null;
}

/**
 * Carries cards from Research to Done.
 *
 * Every phase is a turn in a chat thread of the project, so a person can
 * open it and watch: the research brief and the coding work share one
 * thread -- the coding turn reads the brief as the conversation so far --
 * and the verifier gets a thread of its own, so it judges the work rather
 * than its own reasoning about it. Tool calls in these threads are allowed
 * without asking, since there is nobody waiting to answer.
 *
 * One card at a time per project: two agents in one working tree would edit
 * over each other. Projects run independently.
 */
export class TaskPipeline {
  #queues = new Map<string, Promise<void>>();
  #pending = new Set<string>();
  #running = new Map<string, Running>();

  constructor(private readonly deps: TaskPipelineDeps) {}

  /** Queues a card to be carried from wherever it is now. */
  enqueue(projectId: string, taskId: string): void {
    if (this.#pending.has(taskId) || this.#running.has(taskId)) return;
    this.#pending.add(taskId);
    const previous = this.#queues.get(projectId) ?? Promise.resolve();
    const next = previous
      .then(() => {
        // Dropped while it waited -- moved back to Idea, deleted.
        if (!this.#pending.delete(taskId)) return;
        return this.#carry(projectId, taskId);
      })
      .catch((error) => this.deps.onError(error, "task pipeline"));
    this.#queues.set(projectId, next);
    void next.then(() => {
      if (this.#queues.get(projectId) === next) this.#queues.delete(projectId);
    });
  }

  /** Whether the pipeline holds this card, queued or running. */
  holds(taskId: string): boolean {
    return this.#pending.has(taskId) || this.#running.has(taskId);
  }

  /** Stops whatever is being done with a card; its turn is cancelled too. */
  cancel(taskId: string): void {
    this.#pending.delete(taskId);
    const run = this.#running.get(taskId);
    if (!run) return;
    run.controller.abort();
    if (run.threadId) {
      void this.deps
        .dispatch(run.principal, { type: "thread.cancel", threadId: run.threadId })
        .catch((error) => this.deps.onError(error, "task cancel"));
    }
  }

  /** Resolves once every queued card has been carried as far as it goes. */
  async drain(): Promise<void> {
    while (this.#queues.size > 0) await Promise.all([...this.#queues.values()]);
  }

  async #carry(projectId: string, taskId: string): Promise<void> {
    const owner = await this.deps.ownerOf(projectId);
    if (!owner) return;
    const settings = await this.deps.tasks.settings(projectId);
    if (!settings) return;
    const fallback = ProviderId.safeParse(owner.defaultProvider);
    const provider = settings.provider ?? (fallback.success ? fallback.data : "native");
    const agent = { provider, ...(settings.model ? { model: settings.model } : {}) };

    const run: Running = {
      controller: new AbortController(),
      principal: { userId: owner.userId, sessionId: "task-pipeline", scopes: ["read", "write", "exec"] },
      threadId: null,
    };
    this.#running.set(taskId, run);
    const { signal } = run.controller;

    const write = async (progress: TaskProgress): Promise<ProjectTask | null> => {
      if (signal.aborted) throw new Cancelled();
      const task = await this.deps.tasks.progress(projectId, taskId, progress);
      if (task) await this.deps.announce(projectId, task);
      return task;
    };

    let output = "";
    try {
      for (;;) {
        const task = await this.deps.tasks.get(projectId, taskId);
        if (!task || signal.aborted) return;
        if (task.status === "needs_input") return;

        switch (task.stage as TaskStage) {
          case "research": {
            await write({ status: "running", lastError: null, attempts: task.attempts + 1 });
            const threadId = await this.#thread(run, projectId, `Task: ${task.title}`);
            await write({ threadId });
            const brief = await this.#turn(run, threadId, researchPrompt(task), {
              ...agent,
              // The native loop has a research mode of its own -- search and
              // read tools in place of the editing ones. A CLI researches
              // with whatever it has, told not to change anything yet.
              ...(provider === "native" ? { mode: "research" as const } : {}),
            });
            if (!brief.trim()) throw new Error("the research turn produced no brief");
            await write({ stage: "ongoing", research: brief.trim() });
            break;
          }
          case "ongoing": {
            await write({ status: "running", lastError: null });
            const threadId =
              task.threadId ?? (await this.#thread(run, projectId, `Task: ${task.title}`));
            if (!task.threadId) await write({ threadId });
            const docs = await this.deps.tasks.docsDigest(projectId);
            output = await this.#turn(run, threadId, codingPrompt(task, docs), agent);
            await write({ stage: "verification" });
            break;
          }
          case "verification": {
            await write({ status: "running", lastError: null });
            const threadId = await this.#thread(run, projectId, `Verify: ${task.title}`);
            const reply = await this.#turn(run, threadId, verifyPrompt(task, output), agent);
            const verdict = parseVerdict(reply);
            const verification = { ...verdict, at: new Date().toISOString(), threadId };
            if (verdict.passed) {
              await write({ stage: "done", status: "idle", verification });
            } else {
              await write({ status: "needs_input", verification });
            }
            return;
          }
          default:
            await write({ status: "idle" });
            return;
        }
      }
    } catch (error) {
      if (error instanceof Cancelled || signal.aborted) return;
      this.deps.onError(error, "task pipeline");
      const task = await this.deps.tasks.progress(projectId, taskId, {
        status: "failed",
        lastError: error instanceof Error ? error.message : String(error),
      });
      if (task) await this.deps.announce(projectId, task);
    } finally {
      if (this.#running.get(taskId) === run) this.#running.delete(taskId);
    }
  }

  async #thread(run: Running, projectId: string, title: string): Promise<string> {
    const result = await this.deps.dispatch(run.principal, {
      type: "thread.create",
      projectId,
      title: title.slice(0, 200),
    });
    if (!result.ok) throw new Error(`could not open a thread: ${result.message}`);
    const created = result.events.find((e) => e.event.type === "thread.created");
    if (!created || created.event.type !== "thread.created") throw new Error("no thread was created");
    const threadId = created.event.threadId;
    this.deps.agent.allowAllFor(threadId);
    return threadId;
  }

  /**
   * Sends one message and waits for the turn to end. Resolves with the
   * agent's last reply: the text after its final tool call, which is the
   * answer rather than the narration of getting there.
   */
  async #turn(
    run: Running,
    threadId: string,
    text: string,
    options: { provider: ProviderId; model?: string; mode?: "research" },
  ): Promise<string> {
    const { signal } = run.controller;
    if (signal.aborted) throw new Cancelled();

    let reply = "";
    let settle!: { resolve: (text: string) => void; reject: (error: Error) => void };
    const done = new Promise<string>((resolve, reject) => {
      settle = { resolve, reject };
    });
    const unsubscribe = this.deps.bus.subscribe({ name: "thread", threadId }, ({ event }) => {
      if (event.type === "agent.text_delta") reply += event.text;
      else if (event.type === "agent.tool_use") reply = "";
      else if (event.type === "agent.turn_completed") {
        if (event.stopReason === "cancelled") settle.reject(new Cancelled());
        else settle.resolve(reply);
      } else if (event.type === "agent.turn_failed") settle.reject(new Error(event.error));
      // The message was taken and no turn ever opened for it.
      else if (event.type === "turn.dequeued") {
        settle.reject(event.reason === "cancelled" ? new Cancelled() : new Error("the agent could not start this turn"));
      }
    });
    const onAbort = () => settle.reject(new Cancelled());
    signal.addEventListener("abort", onAbort, { once: true });

    run.threadId = threadId;
    try {
      const sent = await this.deps.dispatch(run.principal, {
        type: "thread.send",
        threadId,
        text,
        provider: options.provider,
        ...(options.model ? { model: options.model } : {}),
        ...(options.mode ? { mode: options.mode } : {}),
      });
      if (!sent.ok) throw new Error(`could not start the agent: ${sent.message}`);
      return await done;
    } finally {
      run.threadId = null;
      unsubscribe();
      signal.removeEventListener("abort", onAbort);
    }
  }
}

// -- Prompts -----------------------------------------------------------------

function describeTask(task: ProjectTask): string {
  const parts = [`# Task: ${task.title}`];
  if (task.description.trim()) parts.push(task.description.trim());
  if (task.references.length > 0) {
    parts.push(`## References\n${task.references.map(describeReference).join("\n")}`);
  }
  if (task.feedback.length > 0) {
    parts.push(
      "## Earlier attempts that did not pass verification\n" +
        task.feedback
          .map((f, i) => `${i + 1}. Verifier: ${f.reason}\n   Person: ${f.answer}`)
          .join("\n"),
    );
  }
  return parts.join("\n\n");
}

function describeReference(ref: TaskReference): string {
  switch (ref.kind) {
    case "url":
      return `- URL: ${ref.url}`;
    case "file":
      return `- Project file: ${ref.path}`;
    case "upload":
      return `- Attached file "${ref.name}" (upload id ${ref.uploadId}; place it in the workspace with the attach_upload tool if you need it)`;
  }
}

export function researchPrompt(task: ProjectTask): string {
  return [
    describeTask(task),
    "---",
    "You are the research step of an automated task pipeline. Investigate what this task needs: read the relevant project files and references, and look things up where that helps.",
    "Do NOT change any files yet. Reply with a concise implementation brief: the goal, the files involved, the approach, risks, and how to tell it is done.",
  ].join("\n\n");
}

export function codingPrompt(task: ProjectTask, docs: string): string {
  return [
    describeTask(task),
    task.research ? `## Research brief\n${task.research}` : "",
    docs ? `## Project documentation\n${docs}` : "",
    "---",
    "Now complete the task in this project, following the brief and the documentation. Make the changes, run whatever checks the project has, and finish with a short summary of what you changed and how you verified it.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function verifyPrompt(task: ProjectTask, output: string): string {
  return [
    describeTask(task),
    task.research ? `## Research brief\n${task.research}` : "",
    output.trim() ? `## What the coding agent reported\n${output.trim()}` : "",
    "---",
    "You are the verification step of an automated task pipeline. Check, independently, whether the task above has really been completed in this project: inspect the changes (for example with `git status` and `git diff`), read the code, and run tests or builds where the project has them. Do not fix anything yourself.",
    'End your reply with a single line of JSON and nothing after it: {"passed": true|false, "reason": "<one or two sentences>"}',
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * The verifier's verdict: the last `{"passed": ...}` object in its reply. A
 * reply without one is a failure -- an unverified task is not done.
 */
export function parseVerdict(reply: string): { passed: boolean; reason: string } {
  const matches = [...reply.matchAll(/\{[^{}]*"passed"[^{}]*\}/g)];
  for (const match of matches.reverse()) {
    try {
      const parsed = JSON.parse(match[0]) as { passed?: unknown; reason?: unknown };
      if (typeof parsed.passed === "boolean") {
        return {
          passed: parsed.passed,
          reason: typeof parsed.reason === "string" && parsed.reason.trim() ? parsed.reason.trim() : "No reason given.",
        };
      }
    } catch {
      // Not JSON after all; try the one before it.
    }
  }
  const tail = reply.trim().slice(-500);
  return {
    passed: false,
    reason: tail ? `The verifier gave no verdict. It said: ${tail}` : "The verifier gave no verdict.",
  };
}
