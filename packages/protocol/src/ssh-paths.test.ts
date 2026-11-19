import { describe, expect, it } from "vitest";
import { normalizeRemotePath, remoteBasename, remoteJoin, remoteParent } from "./ssh-paths.js";

describe("remote paths", () => {
  it("makes paths absolute against the home folder", () => {
    expect(normalizeRemotePath("", "/home/deploy")).toBe("/home/deploy");
    expect(normalizeRemotePath("~", "/home/deploy")).toBe("/home/deploy");
    expect(normalizeRemotePath("~/app/logs", "/home/deploy")).toBe("/home/deploy/app/logs");
    expect(normalizeRemotePath("app", "/home/deploy")).toBe("/home/deploy/app");
    expect(normalizeRemotePath("/etc/nginx/", "/home/deploy")).toBe("/etc/nginx");
  });

  it("resolves dot segments without escaping the root", () => {
    expect(normalizeRemotePath("/var/www/../log/./nginx", "/")).toBe("/var/log/nginx");
    expect(normalizeRemotePath("/../../etc", "/")).toBe("/etc");
    expect(normalizeRemotePath("//srv///data", "/")).toBe("/srv/data");
  });

  it("refuses what is not a path", () => {
    expect(normalizeRemotePath("a\0b", "/")).toBeNull();
    expect(normalizeRemotePath("x".repeat(5000), "/")).toBeNull();
  });

  it("splits and joins", () => {
    expect(remoteParent("/etc/nginx/nginx.conf")).toBe("/etc/nginx");
    expect(remoteParent("/etc")).toBe("/");
    expect(remoteParent("/")).toBe("/");
    expect(remoteBasename("/etc/nginx/nginx.conf")).toBe("nginx.conf");
    expect(remoteBasename("/")).toBe("/");
    expect(remoteJoin("/", "etc")).toBe("/etc");
    expect(remoteJoin("/etc", "hosts")).toBe("/etc/hosts");
  });
});
