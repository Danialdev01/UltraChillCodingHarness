import { describe, expect, it } from "vitest";
import { parseDatabaseUrl } from "./database-url";

describe("parseDatabaseUrl", () => {
  it("keeps an unescaped @ in the username", () => {
    expect(
      parseDatabaseUrl("mysql://developersdani@gmail.com:Wgjf7sOKsu6jpZOKm8cn@217.216.74.159:3306/mysql"),
    ).toEqual({
      engine: "mysql",
      host: "217.216.74.159",
      port: 3306,
      username: "developersdani@gmail.com",
      password: "Wgjf7sOKsu6jpZOKm8cn",
      database: "mysql",
    });
  });

  it("reads a postgresql URL with a non-default port", () => {
    expect(
      parseDatabaseUrl("postgresql://developersdani@gmail.com:XTAkHeFMBAs4HubLOQgV@217.216.74.159:5433/postgres"),
    ).toMatchObject({ engine: "postgresql", port: 5433, username: "developersdani@gmail.com", database: "postgres" });
  });

  it("accepts the postgres:// alias and fills in the default port", () => {
    expect(parseDatabaseUrl("postgres://u:p@h/db")).toMatchObject({ engine: "postgresql", port: 5432, host: "h" });
    expect(parseDatabaseUrl("mysql://u:p@h")).toMatchObject({ port: 3306, database: undefined });
  });

  it("decodes percent escapes", () => {
    expect(parseDatabaseUrl("mysql://user%40x.com:p%3Aw@h:1/d")).toMatchObject({
      username: "user@x.com",
      password: "p:w",
      port: 1,
    });
  });

  it("lets a password contain a colon", () => {
    expect(parseDatabaseUrl("mysql://u:a:b@h/d")).toMatchObject({ username: "u", password: "a:b" });
  });

  it("reads a bracketed IPv6 host", () => {
    expect(parseDatabaseUrl("postgresql://u:p@[::1]:5432/d")).toMatchObject({ host: "::1", port: 5432 });
    expect(parseDatabaseUrl("postgresql://u:p@[::1]/d")).toMatchObject({ host: "::1", port: 5432 });
  });

  it("drops query and fragment", () => {
    expect(parseDatabaseUrl("mysql://u:p@h/d?ssl=true#x")).toMatchObject({ database: "d" });
  });

  it("tolerates a URL without credentials", () => {
    expect(parseDatabaseUrl("mysql://h:3306/d")).toMatchObject({ username: "", password: "", host: "h" });
  });

  it("rejects what it cannot use", () => {
    expect(parseDatabaseUrl("redis://x")).toHaveProperty("error");
    expect(parseDatabaseUrl("mysql://u:p@:3306/d")).toHaveProperty("error");
    expect(parseDatabaseUrl("mysql://u:p@h:abc/d")).toHaveProperty("error");
    expect(parseDatabaseUrl("mysql://u:p@h:70000/d")).toHaveProperty("error");
    expect(parseDatabaseUrl("not a url")).toHaveProperty("error");
  });
});
