#!/usr/bin/env node
/**
 * `omp-bridge`: an MCP stdio server that lends OMP's tools to Claude Code and
 * Codex turns (documentation/omp/solution.md §10). The CLI starts it from
 * the MCP config the server writes for the turn, and the environment in that
 * config is all it is told (`config.ts`).
 *
 * Stdout is the protocol; anything for a person goes to stderr.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { HostProcessHost } from "@ucch/providers";
import { readBridgeConfig } from "./config.js";
import { createBridgeServer } from "./server.js";

const server = createBridgeServer(readBridgeConfig(process.env), new HostProcessHost());
await server.connect(new StdioServerTransport());
