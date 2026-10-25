import type { DomainEvent } from "@ucch/protocol";

/**
 * Whether a project's agent is working, as the sidebar shows it.
 *
 * Pure, so the bookkeeping -- several threads in one project, a turn that was
 * already running when the page loaded, a message that never became a turn
 * -- can be tested without a socket.
 */

export type AgentStatus = "idle" | "working" | "done" | "error";

/** How long a project stays marked done after its last turn finishes. */
export const DONE_MS = 10_000;

export interface ProjectActivity {
  /** Threads with a turn in flight. */
  running: readonly string[];
  /** When the done mark lapses, as a Unix time in ms; null when there is none. */
  doneUntil: number | null;
  /**
   * The last turn to end failed or was cut off by a limit. Held until the
   * next turn in the project starts: an error is something to go and look
   * at, so unlike done it does not lapse on a clock.
   */
  failed: boolean;
}

export type ActivityState = Readonly<Record<string, ProjectActivity>>;

/**
 * Folds one event into the state: the server's `project.activity`, sent to
 * the workspace for each turn picked up, started or ended. Anything else
 * comes back as the same object, so a caller can skip the render.
 *
 * `at` is when the event arrived. Activity is live only -- nothing replays
 * it -- so that is when it happened, near enough.
 */
export function reduceActivity(state: ActivityState, event: DomainEvent, at: number): ActivityState {
  if (event.type !== "project.activity") return state;
  const { projectId, threadId } = event;
  const current = state[projectId] ?? { running: [], doneUntil: null, failed: false };
  const listed = current.running.includes(threadId);
  const running = listed ? current.running : [...current.running, threadId];

  switch (event.state) {
    // Picked up but not started: working already, as the session list has
    // it, but an earlier failure stands until the turn really starts -- a
    // message that never becomes a turn changes nothing about it.
    case "queued":
      if (listed) return state;
      return { ...state, [projectId]: { running, doneUntil: null, failed: current.failed } };
    case "running":
      if (listed && !current.failed && current.doneUntil === null) return state;
      return { ...state, [projectId]: { running, doneUntil: null, failed: false } };
    default: {
      const left = current.running.filter((id) => id !== threadId);
      // A turn that failed, ran into a limit or was stopped did not finish
      // its work, so it is not marked done -- green there would say the
      // opposite of what happened. Stopped (and a message that never became
      // a turn) is `idle` and stays quiet; the other two are `failed`.
      return {
        ...state,
        [projectId]: {
          running: left,
          doneUntil: left.length > 0 ? null : event.state === "done" ? at + DONE_MS : null,
          failed: event.state === "failed" || current.failed,
        },
      };
    }
  }
}

/**
 * The status to draw. `serverRunning` and `serverFailed` are what the page
 * was rendered with, and count only until this tab hears about the project
 * itself -- after that the server's snapshot is older than what the socket
 * said.
 *
 * One status for every session in the project, the most pressing first: a
 * session still working, then one that failed, then one just done.
 */
export function agentStatus(
  activity: ProjectActivity | undefined,
  serverRunning: boolean,
  now: number,
  serverFailed = false,
): AgentStatus {
  if (!activity) return serverRunning ? "working" : serverFailed ? "error" : "idle";
  if (activity.running.length > 0) return "working";
  if (activity.failed) return "error";
  if (activity.doneUntil !== null && now < activity.doneUntil) return "done";
  return "idle";
}

/** The next moment a done mark lapses, so a view knows when to look again. */
export function nextExpiry(state: ActivityState, now: number): number | null {
  let next: number | null = null;
  for (const activity of Object.values(state)) {
    const until = activity.doneUntil;
    if (until !== null && until > now && (next === null || until < next)) next = until;
  }
  return next;
}
