import Fastify from "fastify";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerCommandRoutes } from "./commands-routes.js";
import type { ProjectSummary } from "./workspaces.js";

let root: string;
let app: ReturnType<typeof Fastify>;
const changed = vi.fn();
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ucch-command-routes-"));
  await mkdir(join(root, ".agent"));
  app = Fastify();
  changed.mockClear();
  registerCommandRoutes(app, {
    projectFor: async () => ({ id: "project" }) as ProjectSummary,
    rootOf: () => root,
    changed,
  });
});
afterEach(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });

it("returns modal saves and subsequent manual file edits through the same button endpoint", async () => {
  const commands = [{ id: "dev", label: "Dev server", command: "pnpm dev" }];
  const saved = await app.inject({ method: "PUT", url: "/api/projects/test/commands", payload: { commands } });
  expect(saved.statusCode).toBe(200);
  expect(JSON.parse(await readFile(join(root, ".agent/commands.json"), "utf8")).commands).toEqual(commands);
  expect(changed).toHaveBeenCalledWith("project");
  expect((await app.inject("/api/projects/test/commands")).json().commands).toEqual(commands);

  const edited = [{ id: "test", label: "Run tests", command: "pnpm test" }];
  await writeFile(join(root, ".agent/commands.json"), JSON.stringify({ commands: edited }));
  expect((await app.inject("/api/projects/test/commands")).json()).toEqual({ commands: edited, error: null });
});

it("reports a file containing a prompt instead of silently treating it as an empty command list", async () => {
  await writeFile(join(root, ".agent/commands.json"), "Redesign the existing Delete project modal");
  const response = (await app.inject("/api/projects/test/commands")).json();
  expect(response.commands).toEqual([]);
  expect(response.error).toContain("not valid JSON");
});
