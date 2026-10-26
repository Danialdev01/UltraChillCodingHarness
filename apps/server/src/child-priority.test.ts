import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HostExecutor } from "@ucch/agent";
import { HostProcessHost } from "@ucch/providers";
import { prefixFor, probePriorityTools, terminalPriority, which, wrapperFor } from "./child-priority.js";

const tools = { choom: "/usr/bin/choom", nice: "/usr/bin/nice", ionice: "/usr/bin/ionice" };
const children = { oomScoreAdj: 800, nice: 10 };
const probed = probePriorityTools(children);

describe("child priority", () => {
  it("prefixes choom, nice and ionice by absolute path", () => {
    expect(prefixFor(tools, children)).toEqual([
      "/usr/bin/choom", "-n", "800", "--", "/usr/bin/nice", "-n", "10", "/usr/bin/ionice", "-c2", "-n7",
    ]);
  });

  it("wraps a command on the child's PATH, and leaves one that is not to fail as before", () => {
    const wrap = wrapperFor(tools, children);
    expect(wrap(["sh", "-c", "true"], { PATH: "/usr/bin:/bin" })).toEqual([...prefixFor(tools, children), "sh", "-c", "true"]);
    expect(wrap(["no-such-program-ucch"], { PATH: "/usr/bin:/bin" })).toEqual(["no-such-program-ucch"]);
    expect(wrap(["sh"], { PATH: "/nowhere" })).toEqual(["sh"]);
  });

  it("finds a relative command from the child's directory, not the server's", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ucch-prio-"));
    await writeFile(join(dir, "run.sh"), "#!/bin/sh\n");
    await chmod(join(dir, "run.sh"), 0o755);
    expect(which("./run.sh", "", dir)).toBe(join(dir, "run.sh"));
    expect(which("./run.sh", "", tmpdir())).toBeNull();
    expect(wrapperFor(tools, children)(["./run.sh"], {}, dir)[0]).toBe("/usr/bin/choom");
  });

  it("keeps terminals gentler than the background work", () => {
    expect(terminalPriority(children)).toEqual({ oomScoreAdj: 500, nice: 5 });
    expect(terminalPriority({ oomScoreAdj: 300, nice: 2 })).toEqual({ oomScoreAdj: 300, nice: 2 });
  });

  it("runs children bare when the prefix fails at boot", () => {
    const failed = probePriorityTools(children, () => {
      throw new Error("choom: failed to set score adjust value: Permission denied");
    });
    expect(failed).toEqual({ tools: null, reason: "choom: failed to set score adjust value: Permission denied" });
  });

  it.skipIf(!probed.tools)("gives a CLI and an agent tool call the score and priority", async () => {
    const before = execFileSync("cat", [`/proc/${process.pid}/oom_score_adj`], { encoding: "utf8" }).trim();
    const wrap = wrapperFor(probed.tools!, children);
    const script = "cat /proc/self/oom_score_adj; nice; ionice";
    const expected = "800\n10\nbest-effort: prio 7";

    // As a provider CLI.
    const cli = await new HostProcessHost({ wrapArgv: wrap }).run({
      argv: ["sh", "-c", script],
      cwd: tmpdir(),
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    });
    expect(cli.stdout).toBe(expected);

    // As the native loop's tool call.
    const executor = new HostExecutor(await mkdtemp(join(tmpdir(), "ucch-prio-")), { wrapArgv: wrap });
    const result = await executor.exec(["sh", "-c", script], { timeoutMs: 10_000 });
    expect(result.stdout.trim()).toBe(expected);

    // A missing program still fails the way it always did.
    await expect(executor.exec(["no-such-program-ucch"], { timeoutMs: 10_000 })).rejects.toThrow(
      /could not run no-such-program-ucch: spawn no-such-program-ucch ENOENT/,
    );
    // And the server's own score is untouched.
    expect(execFileSync("cat", [`/proc/${process.pid}/oom_score_adj`], { encoding: "utf8" }).trim()).toBe(before);
  });
});
