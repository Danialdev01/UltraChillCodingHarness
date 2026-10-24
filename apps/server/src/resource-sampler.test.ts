import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Registry } from "./metrics.js";
import {
  aggregate,
  classify,
  parseCmdline,
  parseKeyValues,
  parseMemoryMax,
  parseStat,
  parseStatm,
  ResourceSampler,
  type ProcSample,
} from "./resource-sampler.js";

/** A `/proc/<pid>/stat` line with the fields the sampler reads filled in. */
function statLine(pid: number, comm: string, ppid: number, utime = 0, stime = 0, start = 1000): string {
  // Fields 3..22: state ppid pgrp session tty tpgid flags minflt cminflt
  // majflt cmajflt utime stime cutime cstime priority nice threads
  // itrealvalue starttime, then the rest.
  return `${pid} (${comm}) S ${ppid} ${pid} ${pid} 0 -1 4194304 100 0 0 0 ${utime} ${stime} 0 0 20 0 1 0 ${start} 1000000 200 18446744073709551615\n`;
}

describe("/proc parsers", () => {
  it("reads a stat line, including a name with spaces and parentheses", () => {
    expect(parseStat(statLine(42, "node", 1, 150, 50, 777))).toEqual({
      pid: 42,
      ppid: 1,
      comm: "node",
      cpuTicks: 200,
      startTime: 777,
    });
    expect(parseStat(statLine(43, "weird) (name", 42))?.comm).toBe("weird) (name");
    expect(parseStat("garbage")).toBeNull();
  });

  it("reads statm pages as bytes", () => {
    expect(parseStatm("1000 300 100 10 0 200 0\n")).toEqual({ resident: 300 * 4096, shared: 100 * 4096 });
    expect(parseStatm("1 2")).toBeNull();
  });

  it("splits a NUL-separated cmdline", () => {
    expect(parseCmdline("node\0server.js\0")).toEqual(["node", "server.js"]);
    expect(parseCmdline("")).toEqual([]);
  });

  it("reads the cgroup's key/value files and memory.max", () => {
    const stat = parseKeyValues("anon 1048576\nfile 2097152\nshmem 0\n");
    expect(stat.get("anon")).toBe(1048576);
    expect(stat.get("file")).toBe(2097152);
    expect(parseKeyValues("low 0\nhigh 0\nmax 3\noom 1\noom_kill 1\n").get("oom_kill")).toBe(1);
    expect(parseMemoryMax("max\n")).toBeNull();
    expect(parseMemoryMax("8589934592\n")).toBe(8589934592);
  });
});

describe("classify", () => {
  it("names the children that matter by their own name or their script", () => {
    expect(classify("claude", ["claude", "-p"])).toBe("claude");
    expect(classify("node", ["node", "/home/node/.local/bin/claude"])).toBe("claude");
    expect(classify("codex", ["/usr/bin/codex"])).toBe("codex");
    expect(classify("bash", ["-bash"])).toBe("shell");
    expect(classify("zsh", ["zsh", "-l"])).toBe("shell");
    expect(classify("git", ["git", "status"])).toBe("git");
    expect(classify("git-remote-http", ["git-remote-https", "origin"])).toBe("git");
    expect(classify("rg", ["rg", "--json"])).toBe("rg");
    expect(classify("python3", ["/opt/doc-venv/bin/python3", "kit.py"])).toBe("python");
    expect(classify("python3.11", ["python3.11"])).toBe("python");
    expect(classify("soffice.bin", ["/usr/lib/libreoffice/program/soffice.bin"])).toBe("soffice");
    expect(classify("chrome", ["/usr/lib/chromium/chrome", "--headless"])).toBe("chromium");
    expect(classify("node", ["node", "node_modules/.bin/vite"])).toBe("other");
    expect(classify("php", ["php", "artisan", "serve"])).toBe("other");
  });
});

/** A process for `aggregate`, with resident and shared sizes in MB. */
function proc(pid: number, ppid: number, comm: string, argv: string[], residentMb: number, sharedMb = 0): ProcSample {
  return {
    stat: { pid, ppid, comm, cpuTicks: 0, startTime: 0 },
    memory: { resident: residentMb * 1024 * 1024, shared: sharedMb * 1024 * 1024 },
    argv,
  };
}
const MB = 1024 * 1024;

describe("aggregate", () => {
  // s6 (1) supervises postgres (10), the web app (20) and this server (30).
  const table: ProcSample[] = [
    proc(1, 0, "s6-svscan", ["s6-svscan"], 2),
    proc(5, 1, "s6-supervise", ["s6-supervise", "server"], 1),
    proc(10, 1, "postgres", ["/usr/lib/postgresql/16/bin/postgres"], 300, 256),
    proc(11, 10, "postgres", ["postgres: ucch ucch 127.0.0.1"], 280, 250),
    proc(12, 10, "postgres", ["postgres: checkpointer"], 100, 90),
    proc(20, 1, "node", ["node", "server.js"], 200),
    proc(30, 5, "node", ["node", "--enable-source-maps", "/app/server/dist/server.mjs"], 400, 60),
    proc(31, 30, "bash", ["-bash"], 5),
    proc(32, 31, "node", ["node", "server.js"], 150), // a user's own dev server, not the web app
    proc(33, 30, "claude", ["claude", "-p"], 372),
    proc(34, 33, "rg", ["rg", "foo"], 10),
    proc(35, 30, "git", ["git", "status"], 8),
    proc(40, 1, "mariadbd", ["mariadbd"], 120),
  ];

  it("groups services by their root and the server's descendants by kind", () => {
    const { groups, groupOf } = aggregate(table, 30);
    expect(groupOf.get(30)).toBe("server");
    expect(groupOf.get(31)).toBe("shell");
    expect(groupOf.get(32)).toBe("other");
    expect(groupOf.get(33)).toBe("claude");
    expect(groupOf.get(34)).toBe("rg");
    expect(groupOf.get(35)).toBe("git");
    expect(groupOf.get(20)).toBe("web");
    expect(groupOf.get(11)).toBe("postgres");
    expect(groupOf.get(40)).toBe("mysqld");
    expect(groupOf.get(1)).toBe("system");
    expect(groupOf.get(5)).toBe("system");

    expect(groups.get("server")).toEqual({ rss: 340 * MB, processes: 1 });
    expect(groups.get("web")).toEqual({ rss: 200 * MB, processes: 1 });
    expect(groups.get("other")).toEqual({ rss: 150 * MB, processes: 1 });
    expect(groups.get("claude")).toEqual({ rss: 372 * MB, processes: 1 });
    expect(groups.get("system")).toEqual({ rss: 3 * MB, processes: 2 });
  });

  it("counts private pages, and postgres's shared buffers once, not once per backend", () => {
    const { groups } = aggregate(table, 30);
    // Private pages (44 + 30 + 10) plus the largest shared figure (256).
    expect(groups.get("postgres")).toEqual({ rss: (44 + 30 + 10 + 256) * MB, processes: 3 });
  });

  it("survives a parent cycle from a reused pid", () => {
    const { groupOf } = aggregate([proc(7, 8, "a", ["a"], 1), proc(8, 7, "b", ["b"], 1)], 30);
    expect(groupOf.get(7)).toBe("system");
    expect(groupOf.get(8)).toBe("system");
  });
});

describe("ResourceSampler", () => {
  let root: string | null = null;
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = null;
  });

  async function fixture(processes: Array<{ pid: number; stat: string; statm: string; cmdline: string }>) {
    root = await mkdtemp(join(tmpdir(), "sampler-"));
    const proc = join(root, "proc");
    const cgroup = join(root, "cgroup");
    await mkdir(join(proc, "self"), { recursive: true });
    await writeFile(join(proc, "self", "stat"), statLine(1, "self", 0));
    await mkdir(cgroup, { recursive: true });
    for (const p of processes) {
      await mkdir(join(proc, String(p.pid)), { recursive: true });
      await writeFile(join(proc, String(p.pid), "stat"), p.stat);
      await writeFile(join(proc, String(p.pid), "statm"), p.statm);
      await writeFile(join(proc, String(p.pid), "cmdline"), p.cmdline);
    }
    return { proc, cgroup };
  }

  it("exports per-group memory and CPU, and the cgroup's figures", async () => {
    const { proc, cgroup } = await fixture([
      { pid: 30, stat: statLine(30, "node", 1, 100, 50), statm: "0 2560 100", cmdline: "node\0server.mjs\0" },
      { pid: 31, stat: statLine(31, "git", 30, 10, 10), statm: "0 256 10", cmdline: "git\0status\0" },
    ]);
    await writeFile(join(cgroup, "memory.current"), `${64 * MB}\n`);
    await writeFile(join(cgroup, "memory.max"), "max\n");
    await writeFile(join(cgroup, "memory.stat"), `anon ${40 * MB}\nfile ${20 * MB}\nshmem 0\n`);
    await writeFile(join(cgroup, "memory.events"), "low 0\nhigh 0\nmax 0\noom 0\noom_kill 2\n");

    const registry = new Registry();
    const logged: unknown[] = [];
    const sampler = new ResourceSampler({
      procRoot: proc,
      cgroupRoot: cgroup,
      selfPid: 30,
      registry,
      log: (sample) => logged.push(sample),
    });
    await sampler.sample();
    let text = await registry.render();
    expect(text).toContain(`resource_rss_bytes{group="server"} ${(2560 - 100) * 4096}`);
    expect(text).toContain(`resource_rss_bytes{group="git"} ${(256 - 10) * 4096}`);
    expect(text).toContain('resource_rss_bytes{group="claude"} 0');
    expect(text).toContain('resource_processes{group="git"} 1');
    expect(text).toContain('resource_cpu_seconds_total{group="server"} 1.5');
    expect(text).toContain('resource_cpu_seconds_total{group="git"} 0.2');
    expect(text).toContain(`cgroup_memory_bytes{type="current"} ${64 * MB}`);
    expect(text).toContain(`cgroup_memory_bytes{type="anon"} ${40 * MB}`);
    expect(text).not.toContain('cgroup_memory_bytes{type="max"}');
    expect(text).toContain("cgroup_oom_kills_total 2");
    expect(logged).toHaveLength(1);

    // CPU accumulates by the difference; an exited process stops adding, and
    // a new kill is one more on the counter.
    await writeFile(join(proc, "30", "stat"), statLine(30, "node", 1, 200, 50));
    await rm(join(proc, "31"), { recursive: true });
    await writeFile(join(cgroup, "memory.events"), "oom_kill 3\n");
    await sampler.sample();
    text = await registry.render();
    expect(text).toContain('resource_cpu_seconds_total{group="server"} 2.5');
    expect(text).toContain('resource_cpu_seconds_total{group="git"} 0.2');
    expect(text).toContain('resource_rss_bytes{group="git"} 0');
    expect(text).toContain("cgroup_oom_kills_total 3");
  });

  it("does not start without a /proc", async () => {
    const sampler = new ResourceSampler({ procRoot: "/nonexistent-proc", registry: new Registry() });
    expect(await sampler.start()).toBe(false);
  });
});
