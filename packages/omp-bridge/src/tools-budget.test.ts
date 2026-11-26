import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { HostProcessHost } from "@ucch/providers";
import { afterAll, describe, expect, it } from "vitest";
import { readBridgeConfig } from "./config.js";
import { ALWAYS_LOAD, createBridgeServer } from "./server.js";

/**
 * How many bytes of tool definitions the bridge hands Claude Code and Codex
 * (plan2 §2.6, beside `apps/server/src/agent-context-budget.json` for the
 * instructions): each tool's name, description and input schema as the CLI
 * lists them, and of those the ones every Claude Code call carries
 * (`anthropic/alwaysLoad`; the rest wait behind ToolSearch). A fixture that
 * grows past its figure by even a byte fails; a change meant to grow
 * one updates the JSON in the same commit:
 * `UCCH_UPDATE_CONTEXT_BUDGET=1 npx vitest run packages/omp-bridge/src/tools-budget.test.ts`.
 */
const BUDGET_FILE = new URL("./tools-budget.json", import.meta.url);
const FAKE_OMP = join(import.meta.dirname, "../../../scripts/load/fake-omp.mjs");

const FIXTURES: Record<string, NodeJS.ProcessEnv> = {
  subagents: { UCCH_BRIDGE_OMP_TOOLS: "0", UCCH_BRIDGE_SUBAGENTS: "1" },
  coordinated: { UCCH_BRIDGE_OMP_TOOLS: "0", UCCH_BRIDGE_SUBAGENTS: "1", UCCH_BRIDGE_MESSAGING: "1", UCCH_WIDGETS: "1" },
  every_tool: { UCCH_OMP_BIN: FAKE_OMP, UCCH_BRIDGE_SUBAGENTS: "1", UCCH_BRIDGE_MESSAGING: "1", UCCH_WIDGETS: "1" },
};

const clients: Client[] = [];
afterAll(async () => {
  for (const client of clients.splice(0)) await client.close();
});

async function measure(): Promise<Record<string, number>> {
  const figures: Record<string, number> = {};
  for (const [name, env] of Object.entries(FIXTURES)) {
    const server = createBridgeServer(readBridgeConfig(env, import.meta.dirname), new HostProcessHost(), { PATH: process.env.PATH });
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "budget", version: "0" });
    await client.connect(clientSide);
    clients.push(client);
    const { tools } = await client.listTools();
    const size = (list: typeof tools) =>
      list.reduce(
        (sum, tool) => sum + Buffer.byteLength(JSON.stringify({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }), "utf8"),
        0,
      );
    figures[`bridge.${name}`] = size(tools);
    figures[`bridge.${name}.always_loaded`] = size(tools.filter((tool) => tool._meta?.[ALWAYS_LOAD] === true));
  }
  return figures;
}

describe("the tool definitions the bridge hands a CLI", async () => {
  const figures = await measure();
  if (process.env.UCCH_UPDATE_CONTEXT_BUDGET === "1") writeFileSync(BUDGET_FILE, `${JSON.stringify(figures, null, 2)}\n`);
  const budget = JSON.parse(readFileSync(BUDGET_FILE, "utf8")) as Record<string, number>;

  it("has a recorded budget for every fixture, and none for a fixture that is gone", () => {
    expect(Object.keys(budget).sort()).toEqual(Object.keys(figures).sort());
  });

  for (const [name, size] of Object.entries(figures)) {
    it(`${name} stays within its budget`, () => {
      expect(size, `${name} is ${size} bytes; its budget is ${budget[name]}`).toBeLessThanOrEqual(budget[name] ?? 0);
    });
  }
});
