import { mkdtemp, readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UnknownUploadError, UploadConflictError } from "@ucch/agent";
import { PathError, WorkspaceFiles } from "./files.js";
import { UploadStore, contentDisposition, safeName, type UploadChange } from "./uploads.js";

const PROJECT = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

let root: string;
let files: WorkspaceFiles;
let store: UploadStore;
let changes: UploadChange[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ucch-uploads-"));
  files = new WorkspaceFiles(root);
  changes = [];
  store = new UploadStore(root, files, { maxBytes: 1024, ttlMs: 60_000 }, (change) => changes.push(change));
  await files.ensureRoot(PROJECT);
});

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await rm(root, { recursive: true, force: true });
});

const stage = (name: string, type = "text/plain", body = "hello") =>
  store.stage(PROJECT, name, type, Buffer.from(body));

describe("staging a file", () => {
  it("keeps it out of the project workspace until it is attached", async () => {
    const upload = await stage("notes.txt");

    // The whole point: the workspace the agent and the file panel see is
    // still empty, and staging sits beside it rather than inside it.
    expect(await readdir(files.root(PROJECT))).toEqual([]);
    expect(await readdir(resolve(root, ".uploads", PROJECT))).toContain(upload.id);
  });

  it("reports it back with the name, size and type the composer shows", async () => {
    const upload = await stage("cat.png", "image/png", "not really a png");
    expect(upload).toMatchObject({
      name: "cat.png",
      contentType: "image/png",
      size: "not really a png".length,
    });
    expect(upload.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("lists what is waiting for that project, and nothing from another", async () => {
    const first = await stage("a.txt");
    const second = await stage("b.txt");
    await store.stage(OTHER, "elsewhere.txt", "text/plain", Buffer.from("x"));

    expect((await store.list(PROJECT)).map((u) => u.name).sort()).toEqual(["a.txt", "b.txt"]);
    expect((await store.list(OTHER)).map((u) => u.name)).toEqual(["elsewhere.txt"]);
    expect(first.id).not.toBe(second.id);
  });

  it("lists in the same order every time", async () => {
    // Files picked in one gesture share a millisecond, so the timestamp alone
    // cannot order them; the listing must still not shuffle between calls.
    await Promise.all([stage("a.txt"), stage("b.txt"), stage("c.txt")]);
    const once = (await store.list(PROJECT)).map((u) => u.id);
    const twice = (await store.list(PROJECT)).map((u) => u.id);
    expect(once).toEqual(twice);
  });

  it("refuses a file past the size limit, and an empty one", async () => {
    await expect(
      store.stage(PROJECT, "big.bin", "application/octet-stream", Buffer.alloc(2048)),
    ).rejects.toBeInstanceOf(PathError);
    await expect(
      store.stage(PROJECT, "empty.txt", "text/plain", Buffer.alloc(0)),
    ).rejects.toBeInstanceOf(PathError);
  });

  it("never lets the uploader's filename become a path", async () => {
    // The name is metadata inside a JSON file, and the bytes are stored under
    // a generated uuid, so even a traversing name touches nothing outside
    // staging.
    const upload = await store.stage(
      PROJECT,
      "../../../etc/passwd",
      "text/plain",
      Buffer.from("x"),
    );
    expect(upload.name).toBe("passwd");
    expect(await readdir(resolve(root, ".uploads", PROJECT))).toEqual([
      upload.id,
      `${upload.id}.json`,
    ]);
  });
});

describe("attaching a staged file to the project", () => {
  it("moves it into the workspace at the path given", async () => {
    const upload = await stage("logo.png", "image/png", "bytes");
    const attached = await store.attach(PROJECT, upload.id, "public/images/logo.png");

    expect(attached).toEqual({ path: "public/images/logo.png", size: 5 });
    expect(await readFile(join(files.root(PROJECT), "public/images/logo.png"), "utf8")).toBe(
      "bytes",
    );
  });

  it("tells the other tabs where it went", async () => {
    const upload = await stage("logo.png", "image/png", "bytes");
    await store.attach(PROJECT, upload.id, "public/logo.png");
    expect(changes).toEqual([{ projectId: PROJECT, uploadId: upload.id, change: "attached", path: "public/logo.png" }]);
  });

  it("falls back to the file's own name when no path is given", async () => {
    const upload = await stage("notes.txt");
    const attached = await store.attach(PROJECT, upload.id, "");
    expect(attached.path).toBe("notes.txt");
  });

  it("leaves nothing behind in staging", async () => {
    const upload = await stage("notes.txt");
    await store.attach(PROJECT, upload.id, "notes.txt");

    expect(await store.list(PROJECT)).toEqual([]);
    expect(await store.find(PROJECT, upload.id)).toBeNull();
  });

  it("can only be done once", async () => {
    const upload = await stage("notes.txt");
    await store.attach(PROJECT, upload.id, "notes.txt");
    await expect(store.attach(PROJECT, upload.id, "again.txt")).rejects.toBeInstanceOf(
      UnknownUploadError,
    );
  });

  it("refuses to overwrite a file that is already there", async () => {
    await files.write(PROJECT, "notes.txt", "the existing one");
    const upload = await stage("notes.txt");

    await expect(store.attach(PROJECT, upload.id, "notes.txt")).rejects.toBeInstanceOf(
      UploadConflictError,
    );
    // And the refusal costs nothing: the file is still staged, and the one in
    // the workspace is untouched.
    expect(await store.find(PROJECT, upload.id)).not.toBeNull();
    expect(await readFile(join(files.root(PROJECT), "notes.txt"), "utf8")).toBe("the existing one");
  });

  it("refuses a destination outside the workspace", async () => {
    const upload = await stage("notes.txt");
    for (const path of ["../escaped.txt", "/etc/passwd", "a/../../out.txt"]) {
      await expect(store.attach(PROJECT, upload.id, path)).rejects.toBeInstanceOf(PathError);
    }
    expect(await store.find(PROJECT, upload.id)).not.toBeNull();
  });

  it("refuses a bare directory as the destination", async () => {
    const upload = await stage("notes.txt");
    await expect(store.attach(PROJECT, upload.id, ".")).rejects.toBeInstanceOf(PathError);
  });

  it("cannot reach another project's staging", async () => {
    const upload = await store.stage(OTHER, "secret.txt", "text/plain", Buffer.from("x"));
    await expect(store.attach(PROJECT, upload.id, "stolen.txt")).rejects.toBeInstanceOf(
      UnknownUploadError,
    );
  });

  it("refuses an id that is not one", async () => {
    // Ids come from randomUUID, so anything else is a probe rather than a
    // typo -- and a path segment built from it would be the way out.
    for (const id of ["../../etc", "..", "not-a-uuid"]) {
      await expect(store.attach(PROJECT, id, "x.txt")).rejects.toBeInstanceOf(UnknownUploadError);
    }
  });
});

describe("discarding", () => {
  it("forgets one staged file", async () => {
    const upload = await stage("notes.txt");
    expect(await store.discard(PROJECT, upload.id)).toBe(true);
    expect(await store.list(PROJECT)).toEqual([]);
    // A second discard is not an error, but it is not a success either.
    expect(await store.discard(PROJECT, upload.id)).toBe(false);
  });

  it("tells the other tabs once, and only when something was there", async () => {
    const upload = await stage("notes.txt");
    await store.discard(PROJECT, upload.id);
    await store.discard(PROJECT, upload.id);
    expect(changes).toEqual([{ projectId: PROJECT, uploadId: upload.id, change: "deleted" }]);
  });

  it("forgets everything a project had staged", async () => {
    await stage("a.txt");
    await stage("b.txt");
    await store.discardAll(PROJECT);
    expect(await store.list(PROJECT)).toEqual([]);
  });
});

describe("sweeping", () => {
  it("drops staging past its time to live and keeps what is inside it", async () => {
    const old = await stage("old.txt");
    const fresh = await stage("fresh.txt");

    // Rewritten rather than waiting: the record's own timestamp is what the
    // sweep reads.
    const meta = resolve(root, ".uploads", PROJECT, `${old.id}.json`);
    await writeFile(
      meta,
      JSON.stringify({ ...old, stagedAt: new Date(Date.now() - 3600_000).toISOString() }),
      "utf8",
    );

    expect(await store.sweep()).toBe(1);
    expect((await store.list(PROJECT)).map((u) => u.id)).toEqual([fresh.id]);
  });

  it("survives a staging root that does not exist yet", async () => {
    const empty = new UploadStore(join(root, "nowhere"), files, {
      maxBytes: 1024,
      ttlMs: 60_000,
    });
    expect(await empty.sweep()).toBe(0);
  });
});

describe("reading back a damaged record", () => {
  it("treats metadata whose bytes are gone as expired", async () => {
    const upload = await stage("notes.txt");
    const { rm } = await import("node:fs/promises");
    await rm(resolve(root, ".uploads", PROJECT, upload.id));

    // What an interrupted attach leaves behind. Offering the model an id it
    // cannot place would be worse than forgetting it.
    expect(await store.find(PROJECT, upload.id)).toBeNull();
    expect(await store.list(PROJECT)).toEqual([]);
  });

  it("ignores a metadata file that is not readable json", async () => {
    await mkdir(resolve(root, ".uploads", PROJECT), { recursive: true });
    await writeFile(
      resolve(root, ".uploads", PROJECT, "33333333-3333-3333-3333-333333333333.json"),
      "{ not json",
      "utf8",
    );
    expect(await store.list(PROJECT)).toEqual([]);
  });
});

describe("safeName", () => {
  it("keeps the last segment of a path", () => {
    expect(safeName("/home/danial/Pictures/cat.png")).toBe("cat.png");
    expect(safeName("C:\\Users\\d\\cat.png")).toBe("cat.png");
    expect(safeName("../../etc/passwd")).toBe("passwd");
  });

  it("keeps a name a person would recognise", () => {
    // Spaces are ordinary in a filename and nothing here builds a shell
    // string, so they survive.
    expect(safeName("WhatsApp Image 2026-08-24 at 20.57.49.jpeg")).toBe(
      "WhatsApp Image 2026-08-24 at 20.57.49.jpeg",
    );
  });

  it("strips what a filesystem or a URL would choke on", () => {
    expect(safeName('re:port<1>?.txt')).toBe("report1.txt");
  });

  it("never returns a hidden or empty name", () => {
    expect(safeName(".env")).toBe("env");
    expect(safeName("...")).toBe("attachment");
    expect(safeName("")).toBe("attachment");
    expect(safeName("/")).toBe("attachment");
  });

  it("bounds the length but keeps the extension", () => {
    const long = safeName(`${"x".repeat(400)}.jpeg`);
    expect(long.length).toBeLessThanOrEqual(120);
    expect(long.endsWith(".jpeg")).toBe(true);
  });
});

describe("contentDisposition", () => {
  it("names the download in both the forms a browser may read", () => {
    expect(contentDisposition("notes.md")).toBe(
      `attachment; filename="notes.md"; filename*=UTF-8''notes.md`,
    );
  });

  it("keeps a non-ASCII name readable in the form that can carry it", () => {
    // A raw non-ASCII byte is not valid in a header value, so the plain
    // `filename` loses it and `filename*` carries the real name.
    const header = contentDisposition("résumé.pdf");
    expect(header).toContain('filename="r_sum_.pdf"');
    expect(header).toContain("filename*=UTF-8''r%C3%A9sum%C3%A9.pdf");
  });

  it("cannot be made to end the header early", () => {
    // A quote or a semicolon in the quoted form would close it and let the
    // rest of the name be read as another parameter.
    const header = contentDisposition('a";b;c.txt');
    expect(header).toContain('filename="a__b_c.txt"');
  });

  it("replaces a character it cannot put in the header rather than dropping it", () => {
    expect(contentDisposition("a\u0001b.txt")).toContain('filename="a_b.txt"');
  });

  it("falls back to a name rather than an empty one", () => {
    // `safeName` already guarantees a name, so this is the belt to that brace.
    expect(contentDisposition("")).toContain('filename="attachment"');
  });
});
