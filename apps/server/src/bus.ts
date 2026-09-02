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
  | { name: "terminal"; terminalId: string };

export function topicKey(topic: Topic): string {
  switch (topic.name) {
    case "thread":
      return `thread:${topic.threadId}`;
    case "project":
      return `project:${topic.projectId}`;
    case "terminal":
      return `terminal:${topic.terminalId}`;
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
    // A thread event also reaches project subscribers, so a client watching a
    // project sees activity in all of its threads without subscribing to each.
    const keys: string[] = [`project:${publication.projectId}`];
    if (publication.threadId) keys.push(`thread:${publication.threadId}`);
    if (publication.event.type === "terminal.output") {
      keys.push(`terminal:${publication.event.terminalId}`);
    }

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
