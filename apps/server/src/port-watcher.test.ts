import { describe, expect, it } from "vitest";
import type { DomainEvent } from "@ucch/protocol";
import { PortWatcher } from "./port-watcher.js";

const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";

function setup(init: { watched?: string[]; ports?: Record<string, number | null> } = {}) {
  const watched = new Set(init.watched ?? [A]);
  const ports: Record<string, number | null> = { [A]: 5173, [B]: 3000, ...init.ports };
  const up = new Set<string>();
  const events: DomainEvent[] = [];
  let probes = 0;
  let portReads = 0;
  let now = 0;
  const watcher = new PortWatcher({
    watched: () => watched,
    portOf: async (id) => {
      portReads++;
      return ports[id] ?? null;
    },
    probe: async (id, port) => {
      probes++;
      return up.has(`${id}:${port}`);
    },
    publish: (_id, event) => events.push(event),
    now: () => now,
  });
  return {
    watcher,
    watched,
    ports,
    up,
    events,
    probes: () => probes,
    portReads: () => portReads,
    advance: (ms: number) => (now += ms),
  };
}

describe("PortWatcher", () => {
  it("announces the first reading, then only changes", async () => {
    const t = setup();
    await t.watcher.tick();
    await t.watcher.tick();
    expect(t.events).toEqual([{ type: "port.closed", projectId: A, port: 5173 }]);

    t.up.add(`${A}:5173`);
    await t.watcher.tick();
    await t.watcher.tick();
    t.up.clear();
    await t.watcher.tick();
    expect(t.events.slice(1)).toEqual([
      { type: "port.opened", projectId: A, port: 5173, reachable: true },
      { type: "port.closed", projectId: A, port: 5173 },
    ]);
  });

  it("probes only the projects somebody is watching", async () => {
    const t = setup({ watched: [] });
    await t.watcher.tick();
    expect(t.probes()).toBe(0);
    t.watched.add(B);
    await t.watcher.tick();
    expect(t.probes()).toBe(1);
    expect(t.events).toEqual([{ type: "port.closed", projectId: B, port: 3000 }]);
  });

  it("skips a project with no port, or a static site", async () => {
    const t = setup({ ports: { [A]: null } });
    await t.watcher.tick();
    expect(t.probes()).toBe(0);
    expect(t.events).toEqual([]);
  });

  it("starts afresh when a project is watched again", async () => {
    const t = setup();
    await t.watcher.tick();
    t.watched.clear();
    await t.watcher.tick();
    t.watched.add(A);
    await t.watcher.tick();
    expect(t.events).toHaveLength(2);
  });

  it("reads the port again once told it changed, and announces the new one", async () => {
    const t = setup();
    await t.watcher.tick();
    await t.watcher.tick();
    expect(t.portReads()).toBe(1);

    t.ports[A] = 8080;
    t.up.add(`${A}:8080`);
    t.watcher.invalidate(A);
    await t.watcher.tick();
    expect(t.portReads()).toBe(2);
    expect(t.events.at(-1)).toEqual({ type: "port.opened", projectId: A, port: 8080, reachable: true });
  });

  it("re-reads a cached port after its time to live", async () => {
    const t = setup();
    await t.watcher.tick();
    t.advance(31_000);
    await t.watcher.tick();
    expect(t.portReads()).toBe(2);
  });
});
