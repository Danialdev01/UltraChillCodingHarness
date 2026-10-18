import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HostExecutor } from "./executors/host.js";
import { DOCUMENTATION_RULES } from "./documents.js";
import { buildPrompt, renderKnowledge } from "./prompt.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ucch-prompt-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function prompt() {
  const { parts } = await buildPrompt({
    executor: new HostExecutor(root),
    stack: null,
    signal: new AbortController().signal,
  });
  return parts;
}

describe("the .ucch knowledge", () => {
  it("is INFO.md in full and the path of everything else in the folder", async () => {
    await mkdir(join(root, ".ucch", "diagrams"), { recursive: true });
    await writeFile(join(root, ".ucch", "INFO.md"), "# Shop\n\nSells hats.\n");
    await writeFile(join(root, ".ucch", "diagrams", "database.mmd"), "erDiagram\n");
    await writeFile(join(root, "AGENTS.md"), "Use tabs.\n");

    const parts = await prompt();
    const knowledge = parts.find((p) => p.content.includes("--- .ucch/INFO.md ---"));
    expect(knowledge?.source).toBe("project_context");
    expect(knowledge?.content).toContain("Sells hats.");
    expect(knowledge?.content).toContain(".ucch/diagrams/database.mmd");
    // Ahead of the project's own instructions, and the tree stays last.
    const sources = parts.map((p) => p.source);
    expect(sources.indexOf("project_context")).toBeLessThan(sources.indexOf("agents_md"));
    expect(sources.at(-1)).toBe("file_tree");
  });

  it("falls back to the older context.md", async () => {
    await mkdir(join(root, ".ucch"));
    await writeFile(join(root, ".ucch", "context.md"), "Mode: Development\n");
    const parts = await prompt();
    expect(parts.some((p) => p.content.includes("Mode: Development"))).toBe(true);
    expect(parts.filter((p) => p.content.includes("Mode: Development"))).toHaveLength(1);
  });

  it("is left out of a project that has no .ucch", async () => {
    await writeFile(join(root, "index.ts"), "");
    const parts = await prompt();
    expect(parts.some((p) => p.content.includes(".ucch"))).toBe(false);
  });
});

describe("renderKnowledge", () => {
  it("does not list INFO.md twice, and caps the listing", () => {
    const files = [".ucch/INFO.md", ...Array.from({ length: 205 }, (_, i) => `.ucch/n/${String(i).padStart(3, "0")}.md`)];
    const text = renderKnowledge("hello", files)!;
    expect(text.match(/\.ucch\/INFO\.md/g)).toHaveLength(1);
    expect(text).toContain("(5 more)");
  });

  it("says nothing when there is nothing", () => {
    expect(renderKnowledge(null, [])).toBeNull();
  });
});

describe("a documentation turn's prompt", () => {
  const build = (mode?: "documentation") =>
    buildPrompt({
      executor: new HostExecutor(root),
      stack: null,
      ...(mode ? { mode } : {}),
      signal: new AbortController().signal,
    });

  it("adds the document rules straight after the harness's own", async () => {
    const { parts } = await build("documentation");
    expect(parts[1]).toEqual({ source: "system_prompt", content: DOCUMENTATION_RULES });
  });

  it("leaves an ordinary turn's prompt as it was", async () => {
    const { parts } = await build();
    expect(parts.some((part) => part.content === DOCUMENTATION_RULES)).toBe(false);
  });
});
