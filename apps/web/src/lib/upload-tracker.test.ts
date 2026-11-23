import { describe, expect, it } from "vitest";
import { UploadTracker } from "./upload-tracker.js";

function deferred() {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("UploadTracker", () => {
  it("is settled at once when nothing is uploading", async () => {
    const tracker = new UploadTracker();
    expect(tracker.size).toBe(0);
    await tracker.settled();
  });

  it("waits for an upload and forgets it afterwards", async () => {
    const tracker = new UploadTracker();
    const upload = deferred();
    tracker.track(upload.promise);
    expect(tracker.size).toBe(1);
    let done = false;
    const wait = tracker.settled().then(() => (done = true));
    await Promise.resolve();
    expect(done).toBe(false);
    upload.resolve();
    await wait;
    expect(done).toBe(true);
    expect(tracker.size).toBe(0);
  });

  it("also waits for an upload that starts while it is waiting", async () => {
    const tracker = new UploadTracker();
    const first = deferred();
    const second = deferred();
    tracker.track(first.promise);
    let done = false;
    const wait = tracker.settled().then(() => (done = true));
    tracker.track(second.promise);
    first.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(done).toBe(false);
    second.resolve();
    await wait;
    expect(done).toBe(true);
  });

  it("settles when an upload fails", async () => {
    const tracker = new UploadTracker();
    const upload = deferred();
    const tracked = tracker.track(upload.promise);
    upload.reject(new Error("refused"));
    await expect(tracked).rejects.toThrow("refused");
    await tracker.settled();
    expect(tracker.size).toBe(0);
  });
});
