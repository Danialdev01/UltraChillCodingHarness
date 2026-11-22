import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

/**
 * scripts/typecheck.sh: tsc-rs answers, and Microsoft's tsc takes over only
 * when tsc-rs itself breaks. A type error is an answer, not a breakage.
 */
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = join(ROOT, "scripts", "typecheck.sh");
const BIN = join(ROOT, "node_modules", ".bin");

let dir: string;
let broken: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ucch-typecheck-"));
  await writeFile(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, types: [] }, include: ["*.ts"] }));
  // A tsc-rs that dies the way a Rust panic does.
  broken = join(dir, "broken-tsc-rs");
  await writeFile(broken, "#!/bin/sh\necho 'thread main panicked' >&2\nexit 101\n");
  await chmod(broken, 0o755);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function check(source: string, env: Record<string, string> = {}) {
  return writeFile(join(dir, "a.ts"), source).then(() => {
    const run = spawnSync("bash", [SCRIPT, "-p", "."], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, PATH: `${BIN}:${process.env.PATH}`, UCCH_TYPECHECKER: "", TSC_RS: "", ...env },
    });
    return { code: run.status, out: run.stdout, err: run.stderr };
  });
}

const CLEAN = "export const a: number = 1;\n";
const WRONG = 'export const a: number = "x";\n';

describe("the typecheck wrapper", () => {
  it("passes clean code through tsc-rs", async () => {
    const run = await check(CLEAN);
    expect(run.code).toBe(0);
    expect(run.err).not.toContain("tsc-rs failed");
  });

  it("reports tsc-rs's errors without falling back", async () => {
    const run = await check(WRONG);
    expect(run.code).not.toBe(0);
    expect(run.out).toContain("error TS2322");
    expect(run.err).not.toContain("checking with TypeScript tsc instead");
  });

  it("checks with tsc when tsc-rs crashes, and still fails on the error", async () => {
    const run = await check(WRONG, { TSC_RS: broken });
    expect(run.err).toContain("tsc-rs failed (exit 101); checking with TypeScript tsc instead");
    expect(run.out).toContain("error TS2322");
    expect(run.code).not.toBe(0);
  });

  it("checks with tsc when tsc-rs fails without naming an error", async () => {
    // Exit 1 is also what a checker returns for errors; with none printed,
    // it is a breakage, not an answer.
    const run = await check(CLEAN, { TSC_RS: "false" });
    expect(run.err).toContain("tsc-rs failed (exit 1)");
    expect(run.code).toBe(0);
  });

  it("checks with tsc when tsc-rs is not installed", async () => {
    const run = await check(CLEAN, { TSC_RS: join(dir, "no-such-binary") });
    expect(run.err).toContain("tsc-rs failed (exit 127)");
    expect(run.code).toBe(0);
  });

  it("uses only tsc when asked to", async () => {
    const run = await check(WRONG, { UCCH_TYPECHECKER: "tsc", TSC_RS: broken });
    expect(run.err).not.toContain("tsc-rs failed");
    expect(run.out).toContain("error TS2322");
    expect(run.code).not.toBe(0);
  });
});
