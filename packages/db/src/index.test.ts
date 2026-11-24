import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { users } from "./index.js";

describe("a failed query", () => {
  it("throws the driver's own error: its code, and none of the parameters", async () => {
    const failure = Object.assign(new Error("duplicate key value"), { code: "23505" });
    // Lazy, like postgres-js: nothing rejects until it is awaited.
    const lazy = { then: (_ok: unknown, no: (e: Error) => void) => no(failure) };
    const rejected = () => ({ ...lazy, values: () => lazy });
    const client = { options: { parsers: {}, serializers: {} }, unsafe: rejected };
    const db = drizzle(client as never);
    for (const run of [
      () => db.update(users).set({ passwordHash: "scrypt$secret" }).where(eq(users.id, "x")),
      () => db.select().from(users),
      () => db.execute("select 1"),
    ]) {
      const error = await run().then(() => null, (e: unknown) => e);
      expect(error).toBe(failure);
    }
  });
});
