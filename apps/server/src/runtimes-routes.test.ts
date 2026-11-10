import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProjectRuntimesResponse } from "@ucch/protocol";

import { RuntimeManager } from "./runtimes/manager.js";
import type { RuntimeProvider } from "./runtimes/types.js";
import { registerRuntimeRoutes } from "./runtimes-routes.js";
import type { ProjectSummary } from "./workspaces.js";

const HASH = "abcdefghijkl";
const PROJECT = { id: "11111111-2222-3333-4444-555555555555", hash: HASH } as ProjectSummary;

const provider: RuntimeProvider = {
  id: "php",
  binaries: ["php"],
  listAvailable: async () =>
    ["8.3.30", "8.4.11", "8.4.12"].map((version) => ({ version, url: `https://example.test/${version}` })),
  async install(release, dir) {
    await mkdir(join(dir, "bin"), { recursive: true });
    await writeFile(join(dir, "bin", "php"), "#!/bin/sh\n");
    await chmod(join(dir, "bin", "php"), 0o755);
  },
  versionOf: async () => "8.2.7",
};

let root: string;
let runtimes: RuntimeManager;
const changed = vi.fn();

beforeEach(async () => {
  root = realpathSync(await mkdtemp(join(tmpdir(), "ucch-rt-routes-")));
  await mkdir(join(root, "workspaces", PROJECT.id, ".git"), { recursive: true });
  runtimes = new RuntimeManager({
    root: join(root, "runtimes"),
    workspaceRoot: join(root, "workspaces"),
    providers: { php: provider },
    autoInstall: false,
  });
  changed.mockReset();
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function app() {
  const server = Fastify();
  registerRuntimeRoutes(server, {
    projectFor: async (request) => (request.params.hash === HASH ? PROJECT : null),
    rootOf: (id) => join(root, "workspaces", id),
    runtimes,
    changed,
  });
  return server;
}

describe("runtime routes", () => {
  it("reports latest with nothing installed: the system's PHP, and what latest would install", async () => {
    const response = await app().inject({ method: "GET", url: `/api/projects/${HASH}/runtimes` });
    expect(response.statusCode).toBe(200);
    const body = response.json<ProjectRuntimesResponse>();
    expect(body.runtimes[0]).toMatchObject({
      id: "php",
      selection: "latest",
      resolved: null,
      system: "8.2.7",
      installed: [],
      available: ["8.4.12", "8.4.11", "8.3.30"],
      missing: "8.4.12",
    });
  });

  it("saves the selection to .agent/runtimes.json and installs it", async () => {
    const server = app();
    const response = await server.inject({
      method: "PUT",
      url: `/api/projects/${HASH}/runtimes`,
      payload: { runtimes: { php: "8.3" } },
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(await readFile(join(root, "workspaces", PROJECT.id, ".agent", "runtimes.json"), "utf8"))).toEqual({
      php: { version: "8.3" },
    });
    expect(changed).toHaveBeenCalledWith(PROJECT.id);
    await vi.waitFor(async () => {
      const body = (await server.inject({ method: "GET", url: `/api/projects/${HASH}/runtimes` })).json<ProjectRuntimesResponse>();
      expect(body.runtimes[0]).toMatchObject({ resolved: "8.3.30", installed: ["8.3.30"] });
    });
  });

  it("refuses a selection that is not one", async () => {
    const response = await app().inject({
      method: "PUT",
      url: `/api/projects/${HASH}/runtimes`,
      payload: { runtimes: { php: "8.3; rm -rf /" } },
    });
    expect(response.statusCode).toBe(400);
  });

  it("updates a line to its newest patch, and will not uninstall what is in use", async () => {
    const server = app();
    await runtimes.install("php", "8.4.11");
    await server.inject({ method: "PUT", url: `/api/projects/${HASH}/runtimes`, payload: { runtimes: { php: "8.4" } } });

    const update = await server.inject({ method: "POST", url: `/api/projects/${HASH}/runtimes/php/install`, payload: {} });
    expect(update.statusCode).toBe(202);
    await vi.waitFor(() => expect(runtimes.installed("php")).toEqual(["8.4.12", "8.4.11"]));
    const body = (await server.inject({ method: "GET", url: `/api/projects/${HASH}/runtimes` })).json<ProjectRuntimesResponse>();
    expect(body.runtimes[0]).toMatchObject({ resolved: "8.4.12", update: null });

    const inUse = await server.inject({ method: "DELETE", url: `/api/projects/${HASH}/runtimes/php/8.4.12` });
    expect(inUse.statusCode).toBe(409);
    const old = await server.inject({ method: "DELETE", url: `/api/projects/${HASH}/runtimes/php/8.4.11` });
    expect(old.statusCode).toBe(200);
    expect(runtimes.installed("php")).toEqual(["8.4.12"]);
  });

  it("answers 404 for another project or an unknown runtime", async () => {
    const server = app();
    expect((await server.inject({ method: "GET", url: "/api/projects/zzzzzzzzzzzz/runtimes" })).statusCode).toBe(404);
    expect((await server.inject({ method: "POST", url: `/api/projects/${HASH}/runtimes/cobol/install`, payload: {} })).statusCode).toBe(404);
  });
});
