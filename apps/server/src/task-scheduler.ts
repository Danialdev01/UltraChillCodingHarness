import {
  ProviderId,
  TASK_AUTO_RUN_USAGE_LIMIT,
  type ProjectTask,
  type TaskAutoRun,
} from "@ucch/protocol";
import type { SessionQuota } from "./quotas.js";
import type { TasksService } from "./tasks.js";

/** How long after its slot a run still starts: a restart over 02:00 is not a lost night. */
export const AUTO_RUN_GRACE_MINUTES = 30;

export interface TaskSchedulerDeps {
  tasks: Pick<TasksService, "autoRunProjects" | "ideas" | "move" | "recordAutoRun">;
  /** The account's usage of one provider, as the sidebar meters show it. */
  quotaFor(userId: string, provider: ProviderId): Promise<SessionQuota>;
  /** The account's default provider, for a board that names none. */
  defaultProviderOf(userId: string): Promise<string | null>;
  enqueue(projectId: string, taskId: string): void;
  announce(projectId: string, task: ProjectTask): Promise<void>;
  onError(error: unknown): void;
}

/** The calendar day, weekday and minute it is in a zone. */
export function localClock(now: Date, timezone: string): { date: string; weekday: number; minutes: number } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
  } catch {
    // An unknown zone reads as UTC rather than stopping the board.
    return localClock(now, "UTC");
  }
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(part("weekday"));
  return {
    date: `${part("year")}-${part("month")}-${part("day")}`,
    weekday,
    minutes: Number(part("hour")) * 60 + Number(part("minute")),
  };
}

/**
 * Whether today's slot is due: an enabled day, at or after the time (within
 * the grace window), and not already handled today.
 */
export function isDue(now: Date, autoRun: TaskAutoRun): boolean {
  if (!autoRun.enabled) return false;
  const match = /^(\d{1,2}):(\d{2})$/.exec(autoRun.time);
  if (!match) return false;
  const slot = Number(match[1]) * 60 + Number(match[2]);
  const clock = localClock(now, autoRun.timezone);
  if (!autoRun.days.includes(clock.weekday)) return false;
  const since = clock.minutes - slot;
  if (since < 0 || since > AUTO_RUN_GRACE_MINUTES) return false;
  if (autoRun.lastRunAt) {
    const last = localClock(new Date(autoRun.lastRunAt), autoRun.timezone);
    if (last.date === clock.date) return false;
  }
  return true;
}

/**
 * Why a run must wait, or null when usage allows it. Every window of the
 * provider counts -- the five-hour one and the weekly one alike -- and usage
 * that cannot be read is treated as too high: running blind is how a
 * subscription is used up overnight.
 */
export function usageBlock(quota: SessionQuota): string | null {
  if (quota.status === "no_auth") return `skipped: ${quota.provider} is not signed in`;
  if (quota.status === "unavailable") return `skipped: ${quota.provider} usage could not be read`;
  const over = quota.windows.find((w) => w.usedPercent >= TASK_AUTO_RUN_USAGE_LIMIT);
  return over ? `skipped: ${over.label} usage at ${Math.round(over.usedPercent)}%` : null;
}

/** Moves Idea cards to Research on each board's schedule. */
export class TaskScheduler {
  #timer: NodeJS.Timeout | null = null;
  #ticking = false;

  constructor(private readonly deps: TaskSchedulerDeps) {}

  start(intervalMs = 60_000): void {
    this.#timer = setInterval(() => void this.tick(), intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  async tick(now = new Date()): Promise<void> {
    if (this.#ticking) return;
    this.#ticking = true;
    try {
      for (const project of await this.deps.tasks.autoRunProjects()) {
        if (!isDue(now, project.autoRun)) continue;
        await this.#run(project, now).catch((error) => this.deps.onError(error));
      }
    } catch (error) {
      this.deps.onError(error);
    } finally {
      this.#ticking = false;
    }
  }

  async #run(
    project: { projectId: string; userId: string; provider: string | null },
    now: Date,
  ): Promise<void> {
    const at = now.toISOString();
    const named = ProviderId.safeParse(project.provider ?? (await this.deps.defaultProviderOf(project.userId)));
    const provider = named.success ? named.data : "native";

    const blocked = usageBlock(await this.deps.quotaFor(project.userId, provider));
    if (blocked) {
      await this.deps.tasks.recordAutoRun(project.projectId, at, blocked);
      return;
    }

    const ideas = await this.deps.tasks.ideas(project.projectId);
    for (const idea of ideas) {
      const moved = await this.deps.tasks.move(project.projectId, idea.id, "research");
      if (!moved) continue;
      await this.deps.announce(project.projectId, moved);
      this.deps.enqueue(project.projectId, moved.id);
    }
    await this.deps.tasks.recordAutoRun(
      project.projectId,
      at,
      ideas.length === 0 ? "ran: no ideas waiting" : `ran: ${ideas.length} moved to Research`,
    );
  }
}
