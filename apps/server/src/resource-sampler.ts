import { readdir, readFile } from "node:fs/promises";
import { basename } from "node:path";
import { registry as defaultRegistry, type Registry } from "./metrics.js";

/**
 * Where the container's CPU and memory go, by service and by kind of child.
 *
 * Every 15 s this reads `/proc/<pid>/stat`, `statm` and `cmdline` for every
 * process it can see (all world-readable, so the unprivileged `node` user
 * can), and the container's cgroup files. `/metrics` then shows, per group,
 * resident memory, live process count and CPU seconds used.
 *
 * Groups are found through the parent chain. The roots are the container's
 * services: this server (its own pid), the web app (`node server.js`), the
 * postmaster and MariaDB. Everything under this server -- terminals, agent
 * CLIs, git, users' dev servers -- is grouped by what the process itself is
 * (`claude`, `shell`, `git`, ...), since that is what decides its cost. Any
 * process under no root (s6, the shell running a service script) is
 * `system`.
 *
 * Memory is each process's private pages: resident minus shared. The
 * shared part is mostly the program and its libraries -- the same `node`
 * binary in the server, the web app and every dev server -- which plain RSS
 * counts once per process, and which is page cache the container's own
 * figure (`docker stats`) leaves out. Postgres adds one thing back: every
 * backend maps `shared_buffers`, so its figure also carries the largest
 * shared size any one backend has -- the buffers once, as the kernel holds
 * them. Added up, the groups land within a few percent of `docker stats`.
 */

/** Seconds between samples. */
const INTERVAL_MS = 15_000;
/** A runaway fork bomb must not turn one sample into a minute of reads. */
const MAX_PIDS = 2_000;
/**
 * `/proc` reports CPU time in clock ticks. `USER_HZ` is 100 on every Linux
 * architecture Node is built for; it is not the kernel's `HZ`.
 */
const TICKS_PER_SECOND = 100;
const PAGE_SIZE = 4096;

export type Service = "server" | "web" | "postgres" | "mysqld";
export type ChildClass = "claude" | "codex" | "shell" | "git" | "rg" | "python" | "soffice" | "chromium" | "other";
export type Group = Service | ChildClass | "system";

export interface ProcStat {
  pid: number;
  ppid: number;
  /** The kernel's short name for the process (`comm`), at most 15 bytes. */
  comm: string;
  /** User plus system CPU time, in clock ticks. */
  cpuTicks: number;
  /** Ticks after boot the process started: with the pid, its identity. */
  startTime: number;
}

export interface ProcMemory {
  /** Resident pages, in bytes. */
  resident: number;
  /** Resident pages shared with other processes (file-backed or shmem), in bytes. */
  shared: number;
}

/**
 * One line of `/proc/<pid>/stat`. The second field is the name in
 * parentheses, which may itself hold spaces and parentheses, so the fields
 * after it are counted from the last `)`.
 */
export function parseStat(text: string): ProcStat | null {
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open < 0 || close < open) return null;
  const pid = Number(text.slice(0, open).trim());
  const rest = text
    .slice(close + 2)
    .trim()
    .split(/\s+/);
  // `rest[0]` is field 3 (state); field n is `rest[n - 3]`.
  const ppid = Number(rest[1]);
  const utime = Number(rest[11]);
  const stime = Number(rest[12]);
  const startTime = Number(rest[19]);
  if (![pid, ppid, utime, stime, startTime].every(Number.isFinite)) return null;
  return { pid, ppid, comm: text.slice(open + 1, close), cpuTicks: utime + stime, startTime };
}

/** `/proc/<pid>/statm`: sizes in pages; the second field is resident, the third shared. */
export function parseStatm(text: string, pageSize = PAGE_SIZE): ProcMemory | null {
  const fields = text.trim().split(/\s+/).map(Number);
  if (fields.length < 3 || !fields.slice(0, 3).every(Number.isFinite)) return null;
  return { resident: fields[1]! * pageSize, shared: fields[2]! * pageSize };
}

/** A NUL-separated `/proc/<pid>/cmdline` as its arguments. */
export function parseCmdline(text: string): string[] {
  return text.split("\0").filter((arg) => arg.length > 0);
}

/** `key value` lines, as `memory.stat` and `memory.events` write them. */
export function parseKeyValues(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of text.split("\n")) {
    const [key, value] = line.trim().split(/\s+/);
    if (key && value !== undefined && Number.isFinite(Number(value))) out.set(key, Number(value));
  }
  return out;
}

/** `memory.max` is a byte count or the word `max` (no limit). */
export function parseMemoryMax(text: string): number | null {
  const value = text.trim();
  if (value === "max" || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const SHELLS = new Set(["bash", "sh", "dash", "zsh", "fish", "ksh", "tcsh", "csh"]);

/**
 * What kind of child a process is, from its kernel name and its first two
 * arguments: a CLI shipped as a Node script runs as `node .../claude`, and
 * one that sets its title shows the title as `comm`.
 */
export function classify(comm: string, argv: readonly string[]): ChildClass {
  const names = [comm, ...argv.slice(0, 2).map((arg) => basename(arg))].map((name) => name.toLowerCase());
  for (const name of names) {
    if (name.startsWith("claude")) return "claude";
    if (name.startsWith("codex")) return "codex";
  }
  const own = names[0]!;
  const program = names[1] ?? own;
  for (const name of [own, program]) {
    if (SHELLS.has(name.replace(/^-/, ""))) return "shell";
    if (name === "git" || name.startsWith("git-")) return "git";
    if (name === "rg") return "rg";
    if (/^python\d*(\.\d+)?$/.test(name)) return "python";
    if (name.startsWith("soffice") || name.startsWith("libreoffice") || name === "oosplash") return "soffice";
    if (name.startsWith("chrom") || name === "headless_shell") return "chromium";
  }
  return "other";
}

/**
 * Which service a process outside the server's tree roots, if any. The
 * server is found by its pid, not here: a user's dev server may well be a
 * `node server.js` too.
 */
export function serviceOf(proc: ProcStat, argv: readonly string[]): Exclude<Service, "server"> | null {
  if (proc.comm === "mysqld" || proc.comm === "mariadbd") return "mysqld";
  if (proc.comm === "postgres") return "postgres";
  if (proc.comm.startsWith("next-server")) return "web";
  if (proc.comm === "node" && argv[1] && basename(argv[1]) === "server.js") return "web";
  return null;
}

export interface ProcSample {
  stat: ProcStat;
  memory: ProcMemory;
  argv: string[];
}

export interface GroupTotals {
  /** Private resident bytes (postgres: plus its shared buffers once). */
  rss: number;
  processes: number;
}

/**
 * Totals per group for one snapshot of the process table, and each
 * process's group (the CPU accounting needs it).
 *
 * A process under this server is labelled by what it is itself, so a shell's
 * `git` is `git` and an agent's `rg` is `rg`. Anything else takes the
 * service at the top of its chain -- the first ancestor that is one, so a
 * postgres backend climbs to the postmaster -- or `system`.
 */
export function aggregate(
  samples: readonly ProcSample[],
  selfPid: number,
): { groups: Map<Group, GroupTotals>; groupOf: Map<number, Group> } {
  const byPid = new Map(samples.map((sample) => [sample.stat.pid, sample]));

  /** The pids from `pid` up to the top of what is visible, nearest first. */
  const ancestry = (pid: number): number[] => {
    // With a seen set: a pid reused between two reads could, in principle,
    // point a process at its own child.
    const chain: number[] = [];
    const seen = new Set<number>();
    for (let current = pid; byPid.has(current) && !seen.has(current); current = byPid.get(current)!.stat.ppid) {
      seen.add(current);
      chain.push(current);
    }
    return chain;
  };

  const groupOf = new Map<number, Group>();
  for (const sample of samples) {
    const { pid } = sample.stat;
    const chain = ancestry(pid);
    let group: Group;
    if (pid === selfPid) group = "server";
    else if (chain.includes(selfPid)) group = classify(sample.stat.comm, sample.argv);
    else {
      // The outermost service wins, so a postgres backend counts as the
      // postmaster's and a child of the web app as the web app's.
      group = "system";
      for (const ancestor of chain) {
        const at = byPid.get(ancestor)!;
        group = serviceOf(at.stat, at.argv) ?? group;
      }
    }
    groupOf.set(pid, group);
  }

  const groups = new Map<Group, GroupTotals>();
  let postgresSharedMax = 0;
  for (const sample of samples) {
    const group = groupOf.get(sample.stat.pid)!;
    const totals = groups.get(group) ?? { rss: 0, processes: 0 };
    totals.processes++;
    totals.rss += Math.max(0, sample.memory.resident - sample.memory.shared);
    if (group === "postgres") postgresSharedMax = Math.max(postgresSharedMax, sample.memory.shared);
    groups.set(group, totals);
  }
  const postgres = groups.get("postgres");
  if (postgres) postgres.rss += postgresSharedMax;
  return { groups, groupOf };
}

const CHILD_CLASSES: readonly ChildClass[] = [
  "claude",
  "codex",
  "shell",
  "git",
  "rg",
  "python",
  "soffice",
  "chromium",
  "other",
];
export const GROUPS: readonly Group[] = ["server", "web", "postgres", "mysqld", ...CHILD_CLASSES, "system"];

export interface CgroupSample {
  current: number | null;
  max: number | null;
  stat: Map<string, number>;
  events: Map<string, number>;
  swap: number | null;
}

export interface ResourceSamplerOptions {
  /** Where `/proc` is; a test points it at fixtures. */
  procRoot?: string;
  cgroupRoot?: string;
  intervalMs?: number;
  selfPid?: number;
  registry?: Registry;
  /** Called with each sample when `LOG_RESOURCE_SAMPLES` is on. */
  log?: (sample: { groups: Record<string, GroupTotals>; cgroup: CgroupSample }) => void;
}

export class ResourceSampler {
  readonly #procRoot: string;
  readonly #cgroupRoot: string;
  readonly #intervalMs: number;
  readonly #selfPid: number;
  readonly #log: ResourceSamplerOptions["log"];
  #timer: NodeJS.Timeout | null = null;
  #running = false;
  /** CPU ticks last seen per process, keyed by pid and start time so a reused pid starts afresh. */
  #lastTicks = new Map<string, number>();
  #lastOomKills: number | null = null;

  readonly #rss;
  readonly #processes;
  readonly #cpu;
  readonly #cgroupMemory;
  readonly #oomKills;

  constructor(options: ResourceSamplerOptions = {}) {
    this.#procRoot = options.procRoot ?? "/proc";
    this.#cgroupRoot = options.cgroupRoot ?? "/sys/fs/cgroup";
    this.#intervalMs = options.intervalMs ?? INTERVAL_MS;
    this.#selfPid = options.selfPid ?? process.pid;
    this.#log = options.log;
    const registry = options.registry ?? defaultRegistry;
    this.#rss = registry.gauge("resource_rss_bytes", "Private resident memory by service or kind of child process; postgres includes its shared buffers once", ["group"]);
    this.#processes = registry.gauge("resource_processes", "Live processes by service or kind of child process", [
      "group",
    ]);
    this.#cpu = registry.counter(
      "resource_cpu_seconds_total",
      "CPU time used by service or kind of child process, sampled every 15 s",
      ["group"],
    );
    this.#cgroupMemory = registry.gauge(
      "cgroup_memory_bytes",
      "The container's memory as its cgroup accounts it: current, max, anon, file, shmem, swap",
      ["type"],
    );
    this.#oomKills = registry.counter("cgroup_oom_kills_total", "Processes the kernel OOM-killed in this cgroup");
  }

  /** Samples now and then every interval. False when there is no `/proc` to read. */
  async start(): Promise<boolean> {
    try {
      await readFile(`${this.#procRoot}/self/stat`, "utf8");
    } catch {
      return false;
    }
    await this.sample();
    this.#timer = setInterval(() => void this.sample(), this.#intervalMs);
    this.#timer.unref();
    return true;
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** One sample into the gauges. Never throws: a missing file is a missing figure. */
  async sample(): Promise<void> {
    // A slow disk must not stack samples on top of each other.
    if (this.#running) return;
    this.#running = true;
    try {
      const procs = await this.#readProcesses();
      const { groups, groupOf } = aggregate(procs, this.#selfPid);

      this.#rss.reset();
      this.#processes.reset();
      for (const group of GROUPS) {
        const totals = groups.get(group);
        this.#rss.set({ group }, totals?.rss ?? 0);
        this.#processes.set({ group }, totals?.processes ?? 0);
      }

      const seen = new Map<string, number>();
      for (const { stat } of procs) {
        const key = `${stat.pid}:${stat.startTime}`;
        const previous = this.#lastTicks.get(key) ?? 0;
        seen.set(key, stat.cpuTicks);
        const delta = stat.cpuTicks - previous;
        if (delta > 0) this.#cpu.inc({ group: groupOf.get(stat.pid) ?? "system" }, delta / TICKS_PER_SECOND);
      }
      this.#lastTicks = seen;

      const cgroup = await this.#readCgroup();
      this.#cgroupMemory.reset();
      if (cgroup.current !== null) this.#cgroupMemory.set({ type: "current" }, cgroup.current);
      if (cgroup.max !== null) this.#cgroupMemory.set({ type: "max" }, cgroup.max);
      for (const type of ["anon", "file", "shmem"]) {
        const value = cgroup.stat.get(type);
        if (value !== undefined) this.#cgroupMemory.set({ type }, value);
      }
      if (cgroup.swap !== null) this.#cgroupMemory.set({ type: "swap" }, cgroup.swap);
      const oomKills = cgroup.events.get("oom_kill");
      if (oomKills !== undefined) {
        // The file's count runs from the cgroup's creation; the counter from
        // the first sample, with that count as its starting point.
        const delta = oomKills - (this.#lastOomKills ?? 0);
        if (delta > 0) this.#oomKills.inc(undefined, delta);
        this.#lastOomKills = oomKills;
      }

      this.#log?.({ groups: Object.fromEntries(groups), cgroup });
    } finally {
      this.#running = false;
    }
  }

  async #readProcesses(): Promise<ProcSample[]> {
    let entries: string[];
    try {
      entries = await readdir(this.#procRoot);
    } catch {
      return [];
    }
    const pids = entries.filter((name) => /^\d+$/.test(name)).slice(0, MAX_PIDS);
    const samples = await Promise.all(
      pids.map(async (pid): Promise<ProcSample | null> => {
        try {
          const [statText, statmText, cmdline] = await Promise.all([
            readFile(`${this.#procRoot}/${pid}/stat`, "utf8"),
            readFile(`${this.#procRoot}/${pid}/statm`, "utf8"),
            readFile(`${this.#procRoot}/${pid}/cmdline`, "utf8"),
          ]);
          const stat = parseStat(statText);
          const memory = parseStatm(statmText);
          if (!stat || !memory) return null;
          return { stat, memory, argv: parseCmdline(cmdline) };
        } catch {
          // Gone between the listing and the read, or not ours to read.
          return null;
        }
      }),
    );
    return samples.filter((sample): sample is ProcSample => sample !== null);
  }

  async #readCgroup(): Promise<CgroupSample> {
    const read = (name: string) => readFile(`${this.#cgroupRoot}/${name}`, "utf8").catch(() => null);
    const [current, max, stat, events, swap] = await Promise.all([
      read("memory.current"),
      read("memory.max"),
      read("memory.stat"),
      read("memory.events"),
      read("memory.swap.current"),
    ]);
    const number = (text: string | null) => {
      const n = text === null ? NaN : Number(text.trim());
      return Number.isFinite(n) ? n : null;
    };
    return {
      current: number(current),
      max: max === null ? null : parseMemoryMax(max),
      stat: stat === null ? new Map() : parseKeyValues(stat),
      events: events === null ? new Map() : parseKeyValues(events),
      swap: number(swap),
    };
  }
}
