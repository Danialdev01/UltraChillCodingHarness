import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { HostProcessHost, type ProcessHost, type RunResult, type SpawnSpec } from "@ucch/providers";
import { afterEach, describe, expect, it } from "vitest";
import { readBridgeConfig } from "./config.js";
import { createBridgeServer } from "./server.js";

/** fake-omp answers `--version` as 18.14.1 does, with no key and no network. */
const FAKE_OMP = join(import.meta.dirname, "../../../scripts/load/fake-omp.mjs");

const clients: Client[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
});

async function connect(env: NodeJS.ProcessEnv, host: ProcessHost = new HostProcessHost(), parentEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH }) {
  const server = createBridgeServer(readBridgeConfig(env, import.meta.dirname), host, parentEnv);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  clients.push(client);
  return client;
}

/** A host that records what it was asked to run and answers as told. */
function recording(answer: Partial<RunResult> | Error) {
  const seen: SpawnSpec[] = [];
  const host: ProcessHost = {
    spawn: () => {
      throw new Error("not used");
    },
    run: async (spec) => {
      seen.push(spec);
      if (answer instanceof Error) throw answer;
      return { code: 0, signal: null, stdout: "", stderr: "", ...answer };
    },
  };
  return { host, seen };
}

describe("the omp bridge", () => {
  it("offers omp_ping and the §10.2 tools, each with an input schema", async () => {
    const client = await connect({ UCCH_OMP_BIN: FAKE_OMP });
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      "omp_ping",
      "omp_task",
      "omp_review",
      "omp_symbols",
      "omp_rename",
      "omp_codemod",
      "omp_debug",
      "omp_recall",
      "omp_retain",
      "omp_handoff_brief",
    ]);
    const task = tools.find((tool) => tool.name === "omp_task")!;
    expect(task.inputSchema).toMatchObject({
      type: "object",
      properties: { agent: { enum: ["scout", "reviewer", "security-reviewer", "sonic"] } },
      required: ["agent", "assignment"],
    });
    const rename = tools.find((tool) => tool.name === "omp_rename")!;
    expect(rename.inputSchema.required).toEqual(["symbol", "file", "newName", "apply"]);
  });

  it("answers a tool call over MCP with omp's answer and its cost", async () => {
    const client = await connect(
      { UCCH_OMP_BIN: FAKE_OMP },
      new HostProcessHost(),
      { PATH: process.env.PATH, FAKE_OMP_FIXTURE: join(import.meta.dirname, "../../providers/src/fixtures/omp-plain.jsonl") },
    );
    const result = await client.callTool({ name: "omp_handoff_brief", arguments: { transcript: "Did a thing." } });
    expect(result.isError).toBeUndefined();
    expect((result.content as { text: string }[])[0]!.text).toMatch(/^Hello from the scripted model\.\n\nomp: 1\.2k in \/ 80 out · \$0\.0012 · \d+ s$/);
  });

  it("refuses input that does not fit a tool's schema before starting omp", async () => {
    const { host, seen } = recording({});
    const client = await connect({ UCCH_OMP_BIN: FAKE_OMP }, host);
    const result = await client.callTool({ name: "omp_task", arguments: { agent: "evil", assignment: "x" } });
    expect(result.isError).toBe(true);
    expect(seen).toEqual([]);
  });

  it("answers omp_ping with the version omp reports", async () => {
    const client = await connect({ UCCH_OMP_BIN: FAKE_OMP });
    expect(await client.callTool({ name: "omp_ping", arguments: {} })).toEqual({ content: [{ type: "text", text: "omp/18.14.1" }] });
  });

  it("runs omp in the worktree, under the subject's agent dir, with the workspace's key only", async () => {
    const { host, seen } = recording({ stdout: "omp/18.14.1\n" });
    const client = await connect(
      { UCCH_OMP_BIN: "/opt/omp", UCCH_OMP_AGENT_DIR: "/creds/u/omp/agent", UCCH_WORKTREE: "/ws/p", OPENROUTER_API_KEY: "sk-or-ws" },
      host,
      { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-ant-operator", OPENROUTER_API_KEY: "sk-or-ws" },
    );
    await client.callTool({ name: "omp_ping", arguments: {} });
    expect(seen).toEqual([
      {
        argv: ["/opt/omp", "--version"],
        cwd: "/ws/p",
        env: { PATH: "/usr/bin", TERM: "dumb", CI: "1", OMP_SKIP_SETUP: "1", PI_CODING_AGENT_DIR: "/creds/u/omp/agent", OPENROUTER_API_KEY: "sk-or-ws" },
      },
    ]);
  });

  it("reports a failure as a tool error with one line, never a thrown one", async () => {
    const failed = await connect({ UCCH_OMP_BIN: "/opt/omp" }, recording({ code: 1, stderr: "error: broken install\nat …" }).host);
    expect(await failed.callTool({ name: "omp_ping", arguments: {} })).toEqual({
      content: [{ type: "text", text: "omp --version failed: error: broken install" }],
      isError: true,
    });
    const missing = await connect({ UCCH_OMP_BIN: "/nonexistent/omp" });
    const result = await missing.callTool({ name: "omp_ping", arguments: {} });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]!.text).toMatch(/\/nonexistent\/omp/);
  });
});
