import type { DomainEvent } from "@ucch/protocol";

export interface Publication {
  readonly seq: number | null;
  readonly projectId: string;
  readonly threadId: string | null;
  readonly event: DomainEvent;
}

export type Topic =
  | { name: "thread"; threadId: string }
  | { name: "project"; projectId: string }
  | { name: "terminal"; terminalId: string }
  | { name: "user"; userId: string }
  | { name: "workspace"; workspaceId: string };

export function topicKey(topic: Topic): string {
  switch (topic.name) {
    case "thread":
      return `thread:${topic.threadId}`;
    case "project":
      return `project:${topic.projectId}`;
    case "terminal":
      return `terminal:${topic.terminalId}`;
    case "user":
      return `user:${topic.userId}`;
    case "workspace":
      return `workspace:${topic.workspaceId}`;
  }
}

/**
 * In-process fan-out from the command worker to subscribed sockets.
 *
 * Clients subscribe to the topics they are looking at rather than receiving
 * everything, so a busy terminal in one project does not push bytes to a
 * client viewing another.
 *
 * This is deliberately in-process: the server is a single instance holding
 * the Docker socket, so a cross-process broker would add a hop and a failure
 * mode without buying anything. Moving to multiple replicas means replacing
 * this class with a Postgres LISTEN/NOTIFY or Redis implementation behind the
 * same interface.
 */
export class EventBus {
  #subscribers = new Map<string, Set<(p: Publication) => void>>();

  subscribe(topic: Topic, listener: (p: Publication) => void): () => void {
    const key = topicKey(topic);
    let set = this.#subscribers.get(key);
    if (!set) {
      set = new Set();
      this.#subscribers.set(key, set);
    }
    set.add(listener);

    return () => {
      const current = this.#subscribers.get(key);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.#subscribers.delete(key);
    };
  }

  publish(publication: Publication): void {
    // A terminal's bytes go to its own topic and nowhere else. They are one
    // person's shell -- including the device codes a sign-in terminal prints
    // -- and every member of a project watches the project topic.
    if (publication.event.type === "terminal.output") {
      this.#deliver([`terminal:${publication.event.terminalId}`], publication);
      return;
    }

    // A thread event also reaches project subscribers, so a client watching a
    // project sees activity in all of its threads without subscribing to each.
    const keys: string[] = [`project:${publication.projectId}`];
    if (publication.threadId) keys.push(`thread:${publication.threadId}`);

    this.#deliver(keys, publication);
  }

  /**
   * To one account's own topic: what changed belongs to a person rather
   * than a project -- their settings, their list of projects.
   */
  publishToUser(userId: string, event: DomainEvent): void {
    this.#deliver([`user:${userId}`], { seq: null, projectId: "", threadId: null, event });
  }

  /**
   * To every member of a workspace who has it open: a project created or
   * deleted, a member added, a connection changed -- what their sidebars and
   * settings pages show.
   */
  publishToWorkspace(workspaceId: string, event: DomainEvent): void {
    this.#deliver([`workspace:${workspaceId}`], { seq: null, projectId: "", threadId: null, event });
  }

  #deliver(keys: readonly string[], publication: Publication): void {
    for (const key of keys) {
      const listeners = this.#subscribers.get(key);
      if (!listeners) continue;
      // Copy before iterating: a listener may unsubscribe itself on delivery.
      for (const listener of [...listeners]) {
        try {
          listener(publication);
        } catch {
          // A broken socket must never stop delivery to healthy ones.
        }
      }
    }
  }

  get topicCount(): number {
    return this.#subscribers.size;
  }
}
