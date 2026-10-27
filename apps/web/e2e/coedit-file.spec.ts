import { expect, test, type Page } from "@playwright/test";

/**
 * Two people in one file, typing at once in the code editor (vim mode): both
 * editors end on the same text, each shows the other's cursor, and the
 * collab service writes the merge to disk. Then the file is rewritten from
 * outside the editors -- as the agent or a save without collab would -- and
 * the change reaches both without moving either cursor: what each types next
 * lands where they left off.
 *
 * Needs the collab service beside the API, as `coedit.spec.ts` does:
 *
 *   pnpm --filter @ucch/web exec playwright test coedit-file
 */

const API = process.env.E2E_API ?? "http://127.0.0.1:3001";
const COOKIE = process.env.E2E_SESSION ?? "dev";

type Json = Record<string, any>;

async function api(method: string, path: string, body?: unknown): Promise<Json> {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { cookie: `ucch_session=${COOKIE}`, origin: API, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status}`);
  const text = await response.text();
  return (text ? JSON.parse(text) : {}) as Json;
}

const ORIGINAL = "const first = 1;\nconst middle = 2;\nconst last = 3;\n";

/** A fresh file at the root of the first project's checkout. */
async function newFile(): Promise<{ href: string; hash: string; path: string }> {
  const { workspaces } = await api("GET", "/api/workspaces");
  for (const ws of workspaces.filter((w: Json) => w.kind === "project" && !w.archived)) {
    const { projects } = await api("GET", `/api/workspaces/${ws.id}/projects`);
    const project = projects[0];
    if (!project) continue;
    const path = `coedit-spec-${Date.now()}.ts`;
    await api("PUT", `/api/projects/${project.hash}/file`, { path, content: ORIGINAL });
    return { href: `/${ws.hash}/p/${project.hash}`, hash: project.hash, path };
  }
  throw new Error("no project to write in: create one first");
}

async function disk(file: { hash: string; path: string }): Promise<string> {
  return (await api("GET", `/api/projects/${file.hash}/file?path=${encodeURIComponent(file.path)}`)).content;
}

/** The editor's text, without the other person's cursor and its name tag. */
function text(page: Page): Promise<string> {
  return page.locator(".cm-content").evaluate((content) =>
    [...content.querySelectorAll(".cm-line")]
      .map((line) => {
        const copy = line.cloneNode(true) as HTMLElement;
        for (const caret of copy.querySelectorAll(".cm-ySelectionCaret")) caret.remove();
        return copy.textContent ?? "";
      })
      .join("\n"),
  );
}

async function open(page: Page, href: string, path: string) {
  await page.goto(href);
  // Enabled once the page knows its project; the header has it twice, one hidden.
  await page.locator('button[title="Show the file explorer"]:visible').first().click();
  await page.getByRole("button", { name: path }).click();
  // Live: bound to the shared document, and writable.
  await expect(page.getByTitle(/Shared live with everyone/)).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".cm-content")).toHaveAttribute("contenteditable", "true", { timeout: 30_000 });
  await expect.poll(() => text(page)).toContain("const middle = 2;");
}

test("two people type into one file at once, and an outside edit keeps their cursors", async ({
  browser,
  baseURL,
}) => {
  const file = await newFile();
  try {
    const host = new URL(baseURL!).hostname;
    const people = await Promise.all(
      [0, 1].map(async () => {
        const context = await browser.newContext();
        await context.addCookies([{ name: "ucch_session", value: COOKIE, domain: host, path: "/" }]);
        const page = await context.newPage();
        await open(page, file.href, file.path);
        return { context, page };
      }),
    );
    const [a, b] = people as [(typeof people)[0], (typeof people)[0]];

    // A opens a line under the last, B one above the first. The file ends in a
    // newline, so `G` is the empty line after it, and `O` opens one above that.
    await a.page.locator(".cm-content").click();
    await a.page.keyboard.press("Escape");
    await a.page.keyboard.type("GO");
    await b.page.locator(".cm-content").click();
    await b.page.keyboard.press("Escape");
    await b.page.keyboard.type("ggO");
    await Promise.all([
      a.page.keyboard.type("// from A", { delay: 40 }),
      b.page.keyboard.type("// from B", { delay: 40 }),
    ]);

    const typed = `// from B\n${ORIGINAL}// from A\n`;
    await expect.poll(() => text(a.page), { timeout: 10_000 }).toBe(typed);
    await expect.poll(() => text(b.page), { timeout: 10_000 }).toBe(typed);
    await expect(a.page.locator(".cm-ySelectionCaret")).toHaveCount(1);
    await expect(b.page.locator(".cm-ySelectionCaret")).toHaveCount(1);
    // Written back by the collab service, a beat after typing stopped.
    await expect.poll(() => disk(file), { timeout: 10_000 }).toBe(typed);

    // Rewritten from outside: the middle line, between the two cursors.
    const outside = typed.replace("const middle = 2;", "const middle = 200; // agent");
    await api("PUT", `/api/projects/${file.hash}/file`, { path: file.path, content: outside });
    await expect.poll(() => text(a.page), { timeout: 10_000 }).toContain("middle = 200");
    await expect.poll(() => text(b.page), { timeout: 10_000 }).toContain("middle = 200");

    // Both still in insert mode where they stopped: the next keys land there.
    await a.page.keyboard.type("!");
    await b.page.keyboard.type("?");
    const after = outside.replace("// from A", "// from A!").replace("// from B", "// from B?");
    await expect.poll(() => text(a.page), { timeout: 10_000 }).toBe(after);
    await expect.poll(() => text(b.page), { timeout: 10_000 }).toBe(after);
    await expect.poll(() => disk(file), { timeout: 10_000 }).toBe(after);

    await Promise.all(people.map((p) => p.context.close()));
  } finally {
    await api("DELETE", `/api/projects/${file.hash}/file?path=${encodeURIComponent(file.path)}`).catch(() => {});
  }
});

/**
 * A diagram's source is a file too. One not yet written opens on the
 * starter and is saved the old way; once the file exists it is shared live.
 * Vim's `u` then undoes only your own typing, never the other person's.
 */
test("a diagram goes live once written, and undo is per person", async ({ browser, baseURL }) => {
  const { workspaces } = await api("GET", "/api/workspaces");
  const ws = workspaces.find((w: Json) => w.kind === "project" && !w.archived);
  const { projects } = await api("GET", `/api/workspaces/${ws.id}/projects`);
  const project = projects[0];
  const file = { hash: project.hash, path: ".ucch/diagrams/user-flow.mmd" };
  const exists = await fetch(`${API}/api/projects/${file.hash}/file?path=${encodeURIComponent(file.path)}`, {
    headers: { cookie: `ucch_session=${COOKIE}` },
  });
  test.skip(exists.ok, "the project already has a user-flow diagram; this would overwrite it");
  const href = `/${ws.hash}/p/${project.hash}/documentation?view=diagrams&diagram=user-flow`;
  const host = new URL(baseURL!).hostname;
  const person = async () => {
    const context = await browser.newContext();
    await context.addCookies([{ name: "ucch_session", value: COOKIE, domain: host, path: "/" }]);
    const page = await context.newPage();
    await page.goto(href);
    await expect.poll(() => text(page), { timeout: 30_000 }).toContain("flowchart TD");
    return { context, page };
  };
  const live = (page: Page) =>
    expect(page.locator(".cm-content")).toHaveAttribute("contenteditable", "true", { timeout: 30_000 });

  try {
    const a = await person();
    // The starter: typed into and saved over REST, which creates the file.
    await a.page.locator(".cm-content").click();
    await a.page.keyboard.press("Escape");
    await a.page.keyboard.type("ggO%% first");
    await a.page.keyboard.press("Escape");
    await expect.poll(() => disk(file).catch(() => ""), { timeout: 10_000 }).toContain("%% first");

    // Now shared: a second person opens on it, live.
    const b = await person();
    await live(a.page);
    await live(b.page);
    await expect.poll(() => text(b.page)).toContain("%% first");

    await a.page.locator(".cm-content").click();
    await a.page.keyboard.press("Escape");
    await a.page.keyboard.type("GO%% from A");
    await a.page.keyboard.press("Escape");
    await b.page.locator(".cm-content").click();
    await b.page.keyboard.press("Escape");
    await b.page.keyboard.type("ggO%% from B");
    await b.page.keyboard.press("Escape");
    for (const { page } of [a, b]) {
      await expect.poll(() => text(page), { timeout: 10_000 }).toContain("%% from A");
      await expect.poll(() => text(page), { timeout: 10_000 }).toContain("%% from B");
    }

    // A's undo takes back A's line only.
    await a.page.keyboard.type("u");
    for (const { page } of [a, b]) {
      await expect.poll(() => text(page), { timeout: 10_000 }).not.toContain("%% from A");
      await expect.poll(() => text(page)).toContain("%% from B");
    }
    await expect.poll(() => disk(file), { timeout: 10_000 }).not.toContain("%% from A");
    await expect.poll(() => disk(file)).toContain("%% from B");

    await Promise.all([a.context.close(), b.context.close()]);
  } finally {
    await api("DELETE", `/api/projects/${file.hash}/file?path=${encodeURIComponent(file.path)}`).catch(() => {});
  }
});
