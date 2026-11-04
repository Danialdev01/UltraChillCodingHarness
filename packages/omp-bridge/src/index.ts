#!/usr/bin/env node
/**
 * `omp-bridge`: an MCP stdio server that lends OMP's tools to Claude Code and
 * Codex turns (documentation/spec.md §9, documentation/reference.md "Packages"). The CLI starts it from
 * the MCP config the server writes for the turn, and the environment in that
 * config -- with the file `UCCH_BRIDGE_ENV_FILE` names, for Codex -- is all
 * it is told (`config.ts`).
 *
 * Stdout is the protocol; anything for a person goes to stderr.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { HostProcessHost } from "@ucch/providers";
import { readBridgeConfig, withEnvFile } from "./config.js";
import { createBridgeServer } from "./server.js";

const env = withEnvFile(process.env);
const server = createBridgeServer(readBridgeConfig(env), new HostProcessHost(), env);
await server.connect(new StdioServerTransport());
