import { expect, test, type Page } from "@playwright/test";

/**
 * Two people in one note, typing into the same paragraph at the same time:
 * both editors end on the same text with both people's words in it, each
 * shows the other's caret, and the saved page has the merge.
 *
 * Needs the collab service beside the API (`pnpm dev` runs both; in
 * production s6 does) and `DEV_AUTH_BYPASS=true`, as the other specs do:
 *
 *   pnpm --filter @ucch/web exec playwright test coedit
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
  return response.json() as Promise<Json>;
}

/** A fresh page under the first project's root, holding one paragraph. */
async function newNote(): Promise<{ href: string; hash: string; id: string }> {
  const { workspaces } = await api("GET", "/api/workspaces");
  for (const ws of workspaces.filter((w: Json) => w.kind === "project" && !w.archived)) {
    const { projects } = await api("GET", `/api/workspaces/${ws.id}/projects`);
    const project = projects[0];
    if (!project) continue;
    const tree = await api("GET", `/api/projects/${project.hash}/notes`);
    const root = (tree.notes as Json[]).find((n) => n.parentId === null)!;
    const { note } = await api("POST", `/api/projects/${project.hash}/notes`, {
      parentId: root.id,
      title: `co-edit spec ${new Date().toISOString()}`,
    });
    await api("PATCH", `/api/projects/${project.hash}/notes/${note.id}`, {
      content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "middle" }] }] },
    });
    return {
      href: `/${ws.hash}/p/${project.hash}/documentation/${note.id}`,
      hash: project.hash,
      id: note.id,
    };
  }
  throw new Error("no project to write in: create one first");
}

async function open(page: Page, href: string) {
  await page.goto(href);
  const editor = page.locator(".ucch-note-editor");
  await expect(editor).toContainText("middle", { timeout: 30_000 });
  return editor;
}

/** The first paragraph's words, without the other person's caret and its name tag. */
function words(page: Page): Promise<string> {
  return page.locator(".ucch-note-editor p").first().evaluate((p) => {
    const copy = p.cloneNode(true) as HTMLElement;
    for (const caret of copy.querySelectorAll(".collaboration-carets__caret")) caret.remove();
    return copy.textContent ?? "";
  });
}

test("two people type into one paragraph at once", async ({ browser, baseURL }) => {
  const note = await newNote();
  const host = new URL(baseURL!).hostname;
  const people = await Promise.all(
    [0, 1].map(async () => {
      const context = await browser.newContext();
      await context.addCookies([{ name: "ucch_session", value: COOKIE, domain: host, path: "/" }]);
      const page = await context.newPage();
      return { context, page, editor: await open(page, note.href) };
    }),
  );
  const [a, b] = people as [(typeof people)[0], (typeof people)[0]];

  // One at each end of the same paragraph, typing together, key by key.
  await a.editor.locator("p").first().click();
  await a.page.keyboard.press("End");
  await b.editor.locator("p").first().click();
  await b.page.keyboard.press("Home");
  await Promise.all([
    a.page.keyboard.type(" and after", { delay: 40 }),
    b.page.keyboard.type("before and ", { delay: 40 }),
  ]);

  const merged = "before and middle and after";
  await expect.poll(() => words(a.page), { timeout: 10_000 }).toBe(merged);
  await expect.poll(() => words(b.page), { timeout: 10_000 }).toBe(merged);
  await expect(a.editor.locator(".collaboration-carets__caret")).toHaveCount(1);
  await expect(b.editor.locator(".collaboration-carets__caret")).toHaveCount(1);

  // The collab service saved the merge to the page itself.
  await expect
    .poll(async () => JSON.stringify((await api("GET", `/api/projects/${note.hash}/notes/${note.id}`)).note.content), {
      timeout: 20_000,
    })
    .toContain(merged);

  // And a reload opens on it: nothing typed was reverted.
  await a.page.reload();
  await expect(a.page.locator(".ucch-note-editor")).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => words(a.page), { timeout: 10_000 }).toBe(merged);

  await Promise.all(people.map((p) => p.context.close()));
});
