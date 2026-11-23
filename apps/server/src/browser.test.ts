import { describe, expect, it } from "vitest";
import { browserNotifier, browserRefusal } from "./browser.js";

describe("browserRefusal", () => {
  const policy = { allowPrivate: false, deniedLocalPorts: [3001] };

  it("lets pages reach the projects' dev servers on loopback, but not the harness's API", async () => {
    expect(await browserRefusal(new URL("http://localhost:5173/"), policy)).toBeNull();
    expect(await browserRefusal(new URL("http://127.0.0.1:3000/app"), policy)).toBeNull();
    expect(await browserRefusal(new URL("http://[::1]:8080/"), policy)).toBeNull();
    expect(await browserRefusal(new URL("http://127.0.0.1:3001/api/workspaces"), policy)).toMatch(/harness itself/);
  });

  it("refuses private and link-local networks unless allowed", async () => {
    expect(await browserRefusal(new URL("http://169.254.169.254/latest/meta-data"), policy)).toMatch(/private/);
    expect(await browserRefusal(new URL("http://10.0.0.5/"), policy)).toMatch(/private/);
    expect(await browserRefusal(new URL("http://192.168.1.1/"), policy)).toMatch(/private/);
    expect(await browserRefusal(new URL("http://10.0.0.5/"), { ...policy, allowPrivate: true })).toBeNull();
  });

  it("refuses other schemes and allows public addresses", async () => {
    expect(await browserRefusal(new URL("file:///etc/passwd"), policy)).toMatch(/not allowed/);
    expect(await browserRefusal(new URL("ftp://1.1.1.1/"), policy)).toMatch(/not allowed/);
    expect(await browserRefusal(new URL("https://1.1.1.1/"), policy)).toBeNull();
  });
});

describe("browserNotifier", () => {
  it("coalesces a burst of changes into one notice per project", async () => {
    const seen: string[] = [];
    const notify = browserNotifier((projectId, event) => seen.push(`${projectId}:${event.type}`));
    notify("p1");
    notify("p1");
    notify("p2");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(seen.sort()).toEqual(["p1:resource.changed", "p2:resource.changed"]);
  });
});
