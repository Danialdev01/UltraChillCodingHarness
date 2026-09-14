/**
 * The agent core: the execution boundary, the tool registry, and the tools.
 *
 * Kept out of `apps/server` so the boundary in `plan.md` §5.3 is a package
 * edge rather than a convention -- nothing here may reach for the database,
 * the event store, or Fastify.
 */
export * from "./completion.js";
export * from "./context.js";
export * from "./web.js";
export * from "./research.js";
export * from "./executor.js";
export * from "./loop.js";
export * from "./prompt.js";
export * from "./session-log.js";
export * from "./executors/host.js";
export * from "./registry.js";
export * from "./tool.js";
export * from "./uploads.js";
export * from "./schema.js";
export * from "./tools/format.js";
