import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Database } from "@ucch/db";
import { registerReviewRoutes, REVIEW_PAGE } from "./review-routes.js";
import type { ProjectSummary } from "./workspaces.js";

const PROJECT = "33333333-3333-3333-3333-333333333333";
const THREAD = "44444444-4444-4444-4444-444444444444";
const OLD_THREAD = "55555555-5555-5555-5555-555555555555";
const SESSION = "s3ss10nhash1";

const row = {
  id: "88888888-8888-4888-8888-888888888888",
  projectId: PROJECT,
  threadId: THREAD,
  scope: "uncommitted",
  ref: null,
  focus: null,
  requestedBy: null,
  status: "completed",
  verdict: { verdict: "incorrect", explanation: "e", confidence: 0.9 },
  findings: [{ priority: "P0", confidence: 0.95, title: "t", body: "b", file: "math.ts", startLine: 2, endLine: 2 }],
  excluded: ["pnpm-lock.yaml"],
  model: "openai/gpt-5",
  costUsd: 0.01,
  error: null,
  createdAt: new Date("2026-11-02T10:00:00Z"),
  completedAt: new Date("2026-11-02T10:01:00Z"),
};

/** The route against a database that records the query and returns `rows`. */
async function server(rows: unknown[] = [row]) {
  const seen: { where?: SQL; limit?: number } = {};
  const chain = {
    from: () => chain,
    where: (where: SQL) => ((seen.where = where), chain),
    orderBy: () => chain,
    limit: async (limit: number) => ((seen.limit = limit), rows),
  };
  const app = Fastify();
  await app.register(cookie);
  registerReviewRoutes(app, {
    db: { select: () => chain } as unknown as Database,
    projectFor: async (request) => (request.cookies.who === "member" && request.params.hash === "pr0jecthash1" ? ({ id: PROJECT } as ProjectSummary) : null),
    threadsOfTree: async (projectId, session) => (projectId === PROJECT && session === SESSION ? [OLD_THREAD, THREAD] : []),
  });
  const get = (url: string, who = "member") => app.inject({ method: "GET", url, cookies: { who } });
  const where = () => new PgDialect().sqlToQuery(seen.where!);
  return { get, where, seen };
}

describe("GET /api/projects/:hash/reviews (OM7.8)", () => {
  it("lists the checkout's reviews, newest first, as records", async () => {
    const { get, where, seen } = await server();
    const response = await get("/api/projects/pr0jecthash1/reviews");
    expect(response.statusCode).toBe(200);
    const { projectId: _project, requestedBy: _by, ...record } = row;
    expect(response.json()).toEqual({
      reviews: [{ ...record, createdAt: "2026-11-02T10:00:00.000Z", completedAt: "2026-11-02T10:01:00.000Z" }],
    });
    expect(where().sql).toContain('"reviews"."thread_id" is null');
    expect(where().params).toEqual([PROJECT]);
    expect(seen.limit).toBe(REVIEW_PAGE);
  });

  it("lists a session's tree: every thread working in it", async () => {
    const { get, where } = await server();
    expect((await get(`/api/projects/pr0jecthash1/reviews?session=${SESSION}`)).statusCode).toBe(200);
    expect(where().sql).toContain('"reviews"."thread_id" in ($2, $3)');
    expect(where().params).toEqual([PROJECT, OLD_THREAD, THREAD]);
  });

  it("is a 404 for someone else's project, another project's session, and a malformed one", async () => {
    const { get } = await server();
    expect((await get("/api/projects/pr0jecthash1/reviews", "stranger")).statusCode).toBe(404);
    expect((await get("/api/projects/pr0jecthash1/reviews?session=0therhash123")).statusCode).toBe(404);
    expect((await get("/api/projects/pr0jecthash1/reviews?session=../x")).statusCode).toBe(404);
  });
});
