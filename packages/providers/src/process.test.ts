import { describe, expect, it } from "vitest";
import { EXIT_SIGTERM, HostProcessHost, splitLines } from "./process.js";

describe("splitLines", () => {
  it("returns only complete lines and keeps the remainder", () => {
    const s = splitLines();
    expect(s.push('{"a":1}\n{"b"')).toEqual(['{"a":1}']);
    expect(s.push(':2}\n')).toEqual(['{"b":2}']);
    expect(s.flush()).toBeNull();
  });

  it("flushes an unterminated tail at the end", () => {
    const s = splitLines();
    expect(s.push("last line")).toEqual([]);
    expect(s.flush()).toBe("last line");
    expect(s.flush()).toBeNull();
  });

  it("strips CRLF", () => {
    const s = splitLines();
    expect(s.push("a\r\nb\r\n")).toEqual(["a", "b"]);
    expect(s.push("c\r")).toEqual([]);
    expect(s.flush()).toBe("c");
  });

  it("handles a chunk that is nothing but a newline", () => {
    const s = splitLines();
    expect(s.push("abc")).toEqual([]);
    expect(s.push("\n")).toEqual(["abc"]);
  });
});

const node = process.execPath;
const env = { PATH: process.env.PATH ?? "" };

describe("HostProcessHost", () => {
  const host = new HostProcessHost();

  it("delivers stdin and streams stdout and stderr as lines", async () => {
    const result = await host.run({
      argv: [
        node,
        "-e",
        "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{process.stdout.write('got '+d+'\\nsecond');process.stderr.write('warn\\n');})",
      ],
      cwd: process.cwd(),
      env,
      stdin: "hello",
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("got hello\nsecond");
    expect(result.stderr).toBe("warn");
  });

  it("reports a missing binary as an error rather than hanging", async () => {
    await expect(
      host.run({ argv: ["/definitely/not/here"], cwd: process.cwd(), env }),
    ).rejects.toThrow(/could not run/);
  });

  it("exits 143 on SIGTERM", async () => {
    const child = host.spawn({
      argv: [node, "-e", "process.stdout.write('up\\n');setInterval(()=>{},1000)"],
      cwd: process.cwd(),
      env,
    });
    for await (const line of child.lines) {
      if (line.line === "up") child.signal("SIGTERM");
    }
    const exit = await child.exited;
    // Node reports the signal rather than a code; a shell would say 143.
    expect(exit.signal === "SIGTERM" || exit.code === EXIT_SIGTERM).toBe(true);
  });

  it("stops a child that will not stop on its own", async () => {
    const child = host.spawn({
      argv: [node, "-e", "process.stdout.write('up\\n');setTimeout(()=>{},60000)"],
      cwd: process.cwd(),
      env,
    });
    for await (const line of child.lines) {
      if (line.line === "up") child.signal("SIGINT");
    }
    const exit = await child.exited;
    expect(exit.signal === "SIGINT" || exit.code === 130).toBe(true);
  });
});
