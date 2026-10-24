import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { LIMIT_STOP_REASONS } from "@ucch/protocol";
import { turnFailed } from "./project-stats.js";

const MIGRATION = new URL("../../../packages/db/migrations/0025_project_stats.sql", import.meta.url);

describe("turnFailed", () => {
  it("is an error, a limit stop reason or an error stop reason, as stoppedShort says", () => {
    const { sql, params } = new PgDialect().sqlToQuery(turnFailed("t"));
    expect(sql).toBe(
      `("t".error is not null or "t".stop_reason in (${[...LIMIT_STOP_REASONS].map((_, i) => `$${i + 1}`).join(", ")}) or "t".stop_reason like 'error%')`,
    );
    expect(params).toEqual([...LIMIT_STOP_REASONS]);
  });

  it("matches the stop reasons the migration's backfill spells out", () => {
    const backfill = readFileSync(MIGRATION, "utf8");
    const listed = /stop_reason IN \(([^)]*)\)/.exec(backfill)?.[1];
    expect(listed?.split(",").map((s) => s.trim().replace(/^'|'$/g, ""))).toEqual([...LIMIT_STOP_REASONS]);
    expect(backfill).toContain("stop_reason LIKE 'error%'");
  });
});
