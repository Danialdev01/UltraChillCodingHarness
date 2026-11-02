import { HostProcessHost, type ProcessHost, type SpawnSpec } from "@ucch/providers";

/** A real host that also keeps each process's argv and the frames written to it. */
export function watched(): { host: ProcessHost; spawned: { spec: SpawnSpec; written: Record<string, unknown>[] }[] } {
  const inner = new HostProcessHost();
  const spawned: { spec: SpawnSpec; written: Record<string, unknown>[] }[] = [];
  const host: ProcessHost = {
    spawn(spec) {
      const child = inner.spawn(spec);
      const seen = { spec, written: [] as Record<string, unknown>[] };
      spawned.push(seen);
      return {
        lines: child.lines,
        exited: child.exited,
        signal: (sig) => child.signal(sig),
        write(line) {
          seen.written.push(JSON.parse(line) as Record<string, unknown>);
          child.write(line);
        },
        endStdin: () => child.endStdin(),
      };
    },
    run: (spec, options) => inner.run(spec, options),
  };
  return { host, spawned };
}
