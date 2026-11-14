import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { S3Client } from "@aws-sdk/client-s3";
import { normalizeResourceKey } from "@ucch/protocol";
import { LocalBackend, ResourceConflictError, ResourceKeyError, S3Backend, keyOf, readAll } from "./resource-stores.js";

describe("normalizeResourceKey", () => {
  it("accepts relative keys and trims slashes", () => {
    expect(normalizeResourceKey("a/b.png")).toBe("a/b.png");
    expect(normalizeResourceKey("/a/b/")).toBe("a/b");
    expect(normalizeResourceKey("")).toBe("");
  });
  it("refuses traversal and odd segments", () => {
    for (const bad of ["../x", "a/../b", "a//b", "./a", "a\\b", "a\0b"]) {
      expect(normalizeResourceKey(bad)).toBeNull();
    }
  });
  it("keyOf refuses the root unless a folder is meant", () => {
    expect(() => keyOf("")).toThrow(ResourceKeyError);
    expect(keyOf("", true)).toBe("");
  });
});

describe("LocalBackend", () => {
  let root: string;
  let outside: string;
  let store: LocalBackend;

  beforeEach(async () => {
    const base = await mkdtemp(join(tmpdir(), "ucch-resources-"));
    root = join(base, "store");
    outside = join(base, "outside");
    await mkdir(root, { recursive: true });
    await mkdir(outside, { recursive: true });
    store = new LocalBackend(root);
  });
  afterEach(async () => {
    await rm(join(root, ".."), { recursive: true, force: true });
  });

  it("writes, lists folders first, moves and removes", async () => {
    await store.write("docs/guide.md", Buffer.from("# hi"), "text/markdown");
    await store.write("logo.png", Buffer.from("png"), "image/png");
    await store.mkdir("backups");

    const top = await store.list("");
    expect(top.map((e) => [e.name, e.kind])).toEqual([
      ["backups", "folder"],
      ["docs", "folder"],
      ["logo.png", "file"],
    ]);
    expect(top[2]!.size).toBe(3);

    await store.move("docs", "backups/docs");
    expect((await store.list("backups")).map((e) => e.key)).toEqual(["backups/docs"]);
    const read = await store.read("backups/docs/guide.md");
    expect((await readAll(read!.stream, 1024)).toString()).toBe("# hi");

    expect(await store.remove("backups")).toBe(true);
    expect(await store.remove("backups")).toBe(false);
    expect(await store.walk("", 10)).toEqual([{ key: "logo.png", size: 3 }]);
  });

  it("refuses to overwrite unless asked", async () => {
    await store.write("a.txt", Buffer.from("1"), "text/plain");
    await expect(store.write("a.txt", Buffer.from("2"), "text/plain")).rejects.toBeInstanceOf(ResourceConflictError);
    await store.write("a.txt", Buffer.from("2"), "text/plain", true);
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("2");
  });

  it("refuses a symlink that leads out of the store", async () => {
    await writeFile(join(outside, "secret"), "no");
    await symlink(outside, join(root, "escape"));
    await expect(store.read("escape/secret")).rejects.toBeInstanceOf(ResourceKeyError);
    await expect(store.write("escape/new", Buffer.from("x"), "text/plain")).rejects.toBeInstanceOf(ResourceKeyError);
    // Links are not listed at all.
    expect((await store.list("")).map((e) => e.name)).not.toContain("escape");
  });

  it("refuses to move a folder into itself or delete the root", async () => {
    await store.mkdir("a");
    await expect(store.move("a", "a/b")).rejects.toBeInstanceOf(ResourceKeyError);
    await expect(store.remove("")).rejects.toBeInstanceOf(ResourceKeyError);
  });
});

describe("S3Backend", () => {
  /** A bucket in memory, answering the handful of commands the backend sends. */
  function fakeClient(objects: Map<string, Buffer>) {
    const sent: { name: string; input: Record<string, unknown> }[] = [];
    const client = {
      async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
        const name = command.constructor.name;
        const input = command.input;
        sent.push({ name, input });
        switch (name) {
          case "ListObjectsV2Command": {
            const prefix = (input.Prefix as string) ?? "";
            const delimiter = input.Delimiter as string | undefined;
            const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
            const contents: { Key: string; Size: number }[] = [];
            const prefixes = new Set<string>();
            for (const key of keys) {
              const rest = key.slice(prefix.length);
              const cut = delimiter ? rest.indexOf(delimiter) : -1;
              if (cut >= 0) prefixes.add(prefix + rest.slice(0, cut + 1));
              else contents.push({ Key: key, Size: objects.get(key)!.length });
            }
            return {
              Contents: contents,
              CommonPrefixes: [...prefixes].map((Prefix) => ({ Prefix })),
              KeyCount: contents.length + prefixes.size,
              IsTruncated: false,
            };
          }
          case "HeadObjectCommand":
            if (!objects.has(input.Key as string)) throw Object.assign(new Error("nf"), { name: "NotFound" });
            return {};
          case "PutObjectCommand":
            objects.set(input.Key as string, Buffer.from((input.Body as Buffer | string) ?? ""));
            return {};
          case "CopyObjectCommand": {
            const source = decodeURIComponent((input.CopySource as string).split("/").slice(1).join("/"));
            objects.set(input.Key as string, objects.get(source)!);
            return {};
          }
          case "DeleteObjectsCommand":
            for (const o of (input.Delete as { Objects: { Key: string }[] }).Objects) objects.delete(o.Key);
            return {};
          default:
            throw new Error(`unexpected ${name}`);
        }
      },
    };
    return { client: client as unknown as S3Client, sent };
  }

  const config = {
    endpoint: null,
    region: "us-east-1",
    bucket: "team",
    prefix: "ucch",
    forcePathStyle: true,
    accessKeyId: "id",
    secretAccessKey: "secret",
  };

  it("keeps every key under the configured prefix and lists one level", async () => {
    const objects = new Map<string, Buffer>();
    const { client } = fakeClient(objects);
    const store = new S3Backend(config, client);

    await store.write("images/logo.png", Buffer.from("png"), "image/png");
    await store.mkdir("backups");
    expect([...objects.keys()].sort()).toEqual(["ucch/backups/", "ucch/images/logo.png"]);

    expect((await store.list("")).map((e) => [e.key, e.kind])).toEqual([
      ["backups", "folder"],
      ["images", "folder"],
    ]);
    // A folder's own placeholder is not listed as a file inside it.
    expect(await store.list("backups")).toEqual([]);
    expect((await store.list("images")).map((e) => e.key)).toEqual(["images/logo.png"]);
  });

  it("moves a folder by copying every object, then removes it", async () => {
    const objects = new Map<string, Buffer>([
      ["ucch/a/one.txt", Buffer.from("1")],
      ["ucch/a/sub/two.txt", Buffer.from("2")],
    ]);
    const { client } = fakeClient(objects);
    const store = new S3Backend(config, client);

    await store.move("a", "b");
    expect([...objects.keys()].sort()).toEqual(["ucch/b/one.txt", "ucch/b/sub/two.txt"]);
    expect(await store.walk("b", 10)).toEqual([
      { key: "b/one.txt", size: 1 },
      { key: "b/sub/two.txt", size: 1 },
    ]);
    expect(await store.remove("b")).toBe(true);
    expect(objects.size).toBe(0);
  });

  it("refuses to overwrite an existing key", async () => {
    const objects = new Map([["ucch/a.txt", Buffer.from("1")]]);
    const store = new S3Backend(config, fakeClient(objects).client);
    await expect(store.write("a.txt", Buffer.from("2"), "text/plain")).rejects.toBeInstanceOf(ResourceConflictError);
  });
});
