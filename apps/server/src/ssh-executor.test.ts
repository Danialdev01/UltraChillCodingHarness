import { describe, expect, it, vi } from "vitest";
import { ExecInterruptedError } from "@ucch/agent";
import { remoteCommandLine, shellQuote, SshExecutor } from "./ssh-executor.js";
import type { PooledSsh } from "./ssh-hosts.js";

describe("remote command lines", () => {
  it("quotes only what needs it", () => {
    expect(shellQuote("ls")).toBe("ls");
    expect(shellQuote("/var/log")).toBe("/var/log");
    expect(shellQuote("a b")).toBe("'a b'");
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(shellQuote("$(rm -rf /)")).toBe("'$(rm -rf /)'");
  });

  it("runs the bash tool's script under bash, or sh where there is none, in the folder asked", () => {
    const line = remoteCommandLine(["bash", "-lc", "df -h | head"], "/home/me");
    expect(line).toBe(
      "cd /home/me && if command -v bash >/dev/null 2>&1; then exec bash -lc 'df -h | head'; else exec sh -lc 'df -h | head'; fi",
    );
    expect(remoteCommandLine(["rg", "--files", "my dir"], null)).toBe("rg --files 'my dir'");
  });
});

function fakeSsh(result: Partial<Awaited<ReturnType<PooledSsh["exec"]>>> = {}): PooledSsh & { exec: ReturnType<typeof vi.fn> } {
  const exec = vi.fn(async () => ({
    stdout: "ok\n",
    stderr: "",
    exitCode: 0,
    signal: null,
    timedOut: false,
    truncated: false,
    ...result,
  }));
  return { client: {} as never, sftp: {} as never, home: "/home/me", exec } as never;
}

describe("SshExecutor", () => {
  it("resolves paths against the remote home, not a local root", () => {
    const executor = new SshExecutor(fakeSsh());
    expect(executor.root()).toBe("/home/me");
    expect(executor.resolve("app/.env")).toBe("/home/me/app/.env");
    expect(executor.resolve("/etc/hosts")).toBe("/etc/hosts");
  });

  it("runs a command in the home folder and returns its output", async () => {
    const ssh = fakeSsh();
    const result = await new SshExecutor(ssh).exec(["bash", "-lc", "uptime"], { timeoutMs: 1000 });
    expect(result).toEqual({ stdout: "ok\n", stderr: "", exitCode: 0, truncated: false });
    expect(ssh.exec.mock.calls[0]![0]).toContain("cd /home/me && ");
  });

  it("reports a command that ran out of time with what it printed", async () => {
    const executor = new SshExecutor(fakeSsh({ timedOut: true, exitCode: null, signal: "KILL", stdout: "partial" }));
    const error = await executor.exec(["bash", "-lc", "sleep 99"], { timeoutMs: 10 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExecInterruptedError);
    expect((error as ExecInterruptedError).reason).toBe("timeout");
    expect((error as ExecInterruptedError).result.stdout).toBe("partial");
  });
});
