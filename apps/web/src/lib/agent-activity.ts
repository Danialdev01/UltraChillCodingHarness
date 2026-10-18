import { stoppedShort, type DomainEvent } from "@ucch/protocol";

/**
 * Whether a project's agent is working, as the sidebar shows it.
 *
 * Pure, so the bookkeeping -- several threads in one project, a turn that was
 * already running when the page loaded, a replayed history -- can be tested
 * without a socket.
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
 * Folds one event into the state. Anything that is not a turn starting or
 * ending comes back as the same object, so a caller can skip the render.
 *
 * `at` is when the event happened by the server's clock, not when it
 * arrived: a thread's history is replayed on every subscribe, and a turn
 * that finished an hour ago must not light the row up again.
 */
export function reduceActivity(
  state: ActivityState,
  projectId: string,
  event: DomainEvent,
  at: number,
): ActivityState {
  const current = state[projectId] ?? { running: [], doneUntil: null, failed: false };

  if (event.type === "turn.started") {
    if (current.running.includes(event.threadId)) return state;
    return {
      ...state,
      [projectId]: { running: [...current.running, event.threadId], doneUntil: null, failed: false },
    };
  }

  if (event.type === "agent.turn_completed" || event.type === "agent.turn_failed") {
    const running = current.running.filter((id) => id !== event.threadId);
    // A turn that failed, ran into a limit or was stopped did not finish its
    // work, so it is not marked done -- green there would say the opposite
    // of what happened. Stopped is the person's own doing and stays quiet;
    // the other two are marked failed.
    const failed =
      event.type === "agent.turn_failed" ||
      (event.type === "agent.turn_completed" && stoppedShort(event.stopReason));
    const succeeded = event.type === "agent.turn_completed" && !failed && event.stopReason !== "cancelled";
    return {
      ...state,
      [projectId]: {
        running,
        doneUntil: running.length > 0 ? null : succeeded ? at + DONE_MS : null,
        failed: failed || current.failed,
      },
    };
  }

  return state;
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
