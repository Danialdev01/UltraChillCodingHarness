import type { DomainEvent } from "@ucch/protocol";

/**
 * Whether each open project's dev server is up, told to its viewers as
 * `port.opened` / `port.closed` when that changes.
 *
 * The preview dialog used to ask every few seconds, from every tab that had
 * it open. Now one probe per project runs here, and only for projects
 * somebody is looking at: those whose project topic has a subscriber. A
 * static preview has no port to wait on, so it is not probed.
 *
 * A project's first reading is announced too, whatever it is: a tab that
 * asked for the status just before the dev server came up would otherwise
 * miss the change, since to this watcher it was never down.
 */
export interface PortWatcherOptions {
  /** The projects with somebody subscribed to them. */
  watched: () => Iterable<string>;
  /** The project's dev-server port, or null when it has none (or serves a folder). */
  portOf: (projectId: string) => Promise<number | null>;
  /** Whether anything accepts a connection on the port. */
  probe: (projectId: string, port: number) => Promise<boolean>;
  publish: (projectId: string, event: DomainEvent) => void;
  intervalMs?: number;
  /** How long a project's port is trusted before it is read again. */
  portTtlMs?: number;
  now?: () => number;
  log?: { warn(obj: object, msg: string): void };
}

const INTERVAL_MS = 3000;
const PORT_TTL_MS = 30_000;

export class PortWatcher {
  /** The last reading per project: which port, and whether it answered. */
  readonly #state = new Map<string, { port: number; open: boolean }>();
  readonly #ports = new Map<string, { port: number | null; at: number }>();
  readonly #now: () => number;
  #timer: ReturnType<typeof setInterval> | undefined;
  #running = false;

  constructor(private readonly options: PortWatcherOptions) {
    this.#now = options.now ?? Date.now;
  }

  start(): void {
    this.#timer ??= setInterval(() => void this.tick(), this.options.intervalMs ?? INTERVAL_MS);
    this.#timer.unref?.();
  }

  stop(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** The project's preview changed: read its port again on the next tick. */
  invalidate(projectId: string): void {
    this.#ports.delete(projectId);
  }

  /** One round of probes. Skipped while the previous one is still going. */
  async tick(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      const watched = new Set(this.options.watched());
      // Nobody is looking: forget it, so a return starts with a fresh reading.
      for (const id of this.#state.keys()) if (!watched.has(id)) this.#state.delete(id);
      for (const id of this.#ports.keys()) if (!watched.has(id)) this.#ports.delete(id);
      await Promise.all([...watched].map((id) => this.#check(id)));
    } finally {
      this.#running = false;
    }
  }

  async #check(projectId: string): Promise<void> {
    try {
      const port = await this.#portOf(projectId);
      const last = this.#state.get(projectId);
      if (port === null) {
        this.#state.delete(projectId);
        return;
      }
      const open = await this.options.probe(projectId, port);
      if (last && last.port === port && last.open === open) return;
      this.#state.set(projectId, { port, open });
      this.options.publish(
        projectId,
        open
          ? // Probed over loopback, where the gateway connects too: what
            // answers here is reachable through the preview.
            { type: "port.opened", projectId, port, reachable: true }
          : { type: "port.closed", projectId, port },
      );
    } catch (error) {
      this.options.log?.warn({ err: error, projectId }, "could not check a preview port");
    }
  }

  async #portOf(projectId: string): Promise<number | null> {
    const cached = this.#ports.get(projectId);
    if (cached && this.#now() - cached.at < (this.options.portTtlMs ?? PORT_TTL_MS)) return cached.port;
    const port = await this.options.portOf(projectId);
    this.#ports.set(projectId, { port, at: this.#now() });
    return port;
  }
}
