import { stoppedShort, type DomainEvent, type ProjectActivityState } from "@ucch/protocol";
import type { EventBus, Publication } from "./bus.js";

/**
 * What a turn's own event says about its project's agent, for the sidebars;
 * null for every event that is not a turn being picked up, started or ended.
 */
export function activityOf(event: DomainEvent): { threadId: string; state: ProjectActivityState } | null {
  switch (event.type) {
    // A send claims the thread (`queued`) before its turn starts.
    case "user.message":
      return { threadId: event.threadId, state: "queued" };
    case "turn.started":
      return { threadId: event.threadId, state: "running" };
    case "agent.turn_completed": {
      // Stopped is the person's own doing, and not marked either way.
      if (event.stopReason === "cancelled") return { threadId: event.threadId, state: "idle" };
      return { threadId: event.threadId, state: stoppedShort(event.stopReason) ? "failed" : "done" };
    }
    case "agent.turn_failed":
      return { threadId: event.threadId, state: "failed" };
    case "turn.dequeued":
      return { threadId: event.threadId, state: "idle" };
    default:
      return null;
  }
}

/**
 * Tells each workspace what its projects' agents are doing, and when a
 * project's stack is detected afresh.
 *
 * A sidebar lists every project in the workspace, and used to subscribe to
 * each one quietly to hear its turns start and end -- one subscription, and
 * one more file watcher, per project per tab. The workspace topic, which
 * every shell holds anyway, now carries just those edges as
 * `project.activity`, and a new stack as `resource.changed` for the
 * project list (its icon).
 *
 * A project never moves between workspaces, so its workspace is looked up
 * once and kept. The lookup is kept as a promise: two events of one project
 * that arrive while it is in flight wait on the same promise and go out in
 * the order they came.
 */
export class ProjectActivityPublisher {
  #workspaces = new Map<string, Promise<string | null>>();

  constructor(
    private readonly bus: EventBus,
    private readonly workspaceOf: (projectId: string) => Promise<string | null>,
    private readonly onError: (error: unknown) => void = () => {},
  ) {}

  /** Starts listening to the bus; returns the function that stops it. */
  start(): () => void {
    return this.bus.tap((publication) => this.#onPublication(publication));
  }

  #onPublication({ projectId, event }: Publication): void {
    const activity = activityOf(event);
    const stack = event.type === "project.stack_detected";
    if (!activity && !stack) return;

    void this.#workspace(projectId).then((workspaceId) => {
      if (!workspaceId) return;
      if (activity) {
        this.bus.publishToWorkspace(workspaceId, { type: "project.activity", projectId, ...activity });
      } else {
        this.bus.publishToWorkspace(workspaceId, { type: "resource.changed", projectId, resource: "projects" });
      }
    });
  }

  #workspace(projectId: string): Promise<string | null> {
    let lookup = this.#workspaces.get(projectId);
    if (!lookup) {
      if (this.#workspaces.size > 10_000) this.#workspaces.clear();
      lookup = this.workspaceOf(projectId).catch((error: unknown) => {
        this.onError(error);
        return null;
      });
      // A miss -- a read that failed, a project not there (yet) -- is asked
      // again next time rather than kept.
      void lookup.then((workspaceId) => {
        if (!workspaceId && this.#workspaces.get(projectId) === lookup) this.#workspaces.delete(projectId);
      });
      this.#workspaces.set(projectId, lookup);
    }
    return lookup;
  }
}
