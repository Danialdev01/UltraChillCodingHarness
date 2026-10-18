import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DomainEvent } from "@ucch/protocol";
import type { Complete } from "../completion.js";
import {
  defaultKitDir,
  DOCUMENTATION_RULES,
  DOCUMENTATION_SKILLS,
  LAYOUT_RUBRIC,
  type DocumentsProvider,
  type LookRequest,
} from "../documents.js";
import { HostExecutor } from "../executors/host.js";
import type { ToolContext } from "../tool.js";
import { openrouterPluginProvider } from "../web.js";
import { docCheck, docEdit, docInspect, docRead, docRender, docSkill } from "./documents.js";

const PROJECT = "33333333-3333-3333-3333-333333333333";

let root: string;
let fakeKit: string;
let emitted: DomainEvent[];

const complete: Complete = async () => {
  throw new Error("no model in these tests");
};

function context(documents: DocumentsProvider | undefined, over: Partial<ToolContext> = {}): ToolContext {
  return {
    projectId: PROJECT,
    threadId: "44444444-4444-4444-4444-444444444444",
    turnId: "55555555-5555-5555-5555-555555555555",
    toolUseId: "call_a",
    executor: new HostExecutor(root),
    signal: new AbortController().signal,
    async emit(event) {
      emitted.push(event);
    },
    apiKey: "key",
    model: "test/model",
    depth: 0,
    complete,
    web: openrouterPluginProvider({ apiKey: "key", model: "m", complete }),
    ...(documents ? { documents } : {}),
    ...over,
  };
}

/**
 * A kit whose "scripts" are shell scripts run by /bin/sh, standing in for
 * Python: the tools only know argv in, JSON or stderr out.
 */
function fakeDocs(look: (request: LookRequest) => Promise<string> = async () => "page 1 | ok"): DocumentsProvider {
  return { kitDir: fakeKit, python: "/bin/sh", visionModel: "test/vision", look };
}

async function fakeScript(name: string, body: string): Promise<void> {
  const path = join(fakeKit, "scripts", name);
  await writeFile(path, body);
  await chmod(path, 0o755);
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "ucch-docs-"));
  fakeKit = await mkdtemp(join(tmpdir(), "ucch-kit-"));
  await mkdir(join(fakeKit, "scripts"), { recursive: true });
  await mkdir(join(fakeKit, "skills", "doc-plan"), { recursive: true });
  await writeFile(join(fakeKit, "skills", "doc-plan", "SKILL.md"), "---\nname: doc-plan\n---\n\n# Planning\nBody.\n");
  await writeFile(join(root, "report.pdf"), "%PDF-fake");
  await writeFile(join(root, "notes.md"), "---\ntitle: T\n---\n# A\n");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(fakeKit, { recursive: true, force: true });
});

describe("the document tools", () => {
  it("refuse on a turn that was not started in documentation mode", async () => {
    emitted = [];
    const result = await docRead.run({ path: "report.pdf", pages: null }, context(undefined));
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/documentation mode/);
  });

  it("refuse a path outside the workspace", async () => {
    const result = await docRead.run({ path: "../etc/passwd", pages: null }, context(fakeDocs()));
    expect(result.isError).toBe(true);
  });

  it("hand the script's stderr back as the error", async () => {
    await fakeScript("doc_read.py", 'echo "report.pdf is encrypted and needs a password." >&2; exit 1\n');
    const result = await docRead.run({ path: "report.pdf", pages: "1-2" }, context(fakeDocs()));
    expect(result).toMatchObject({ isError: true, content: "report.pdf is encrypted and needs a password." });
  });

  it("send page renders to the vision model with the rubric when no question is asked", async () => {
    await fakeScript(
      "doc_images.py",
      `echo '{"mode":"pages","pages":4,"images":[{"page":1,"mime":"image/png","data":"AAA"},{"page":2,"mime":"image/png","data":"BBB"}]}'\n`,
    );
    const seen: LookRequest[] = [];
    const docs = fakeDocs(async (request) => {
      seen.push(request);
      return "page 1 | ok\npage 2 | overflow | high | the table runs past the right margin";
    });

    const result = await docInspect.run(
      { path: "report.pdf", pages: "1-2", question: null, figures: null },
      context(docs),
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Looked at p1, p2 of 4 pages.");
    expect(result.content).toContain("overflow");
    expect(seen[0]!.prompt).toBe(LAYOUT_RUBRIC);
    expect(seen[0]!.images.map((i) => i.label)).toEqual(["Page 1:", "Page 2:"]);
  });

  it("ask the person's question when there is one", async () => {
    let prompt = "";
    const docs = fakeDocs(async (request) => {
      prompt = request.prompt;
      return "EU 120 ms, US 95 ms";
    });
    const result = await docInspect.run(
      { path: "report.pdf", pages: "2", question: "What does the chart show?", figures: null },
      context(docs),
    );
    expect(prompt).toMatch(/^What does the chart show\?/);
    expect(result.content).toContain("EU 120 ms");
  });

  it("count failed renders and stop the repair loop at three", async () => {
    await fakeScript("doc_render.py", 'echo "typst could not compile the document" >&2; exit 1\n');
    const ctx = context(fakeDocs());
    const input = { source: "notes.md", format: "pdf" as const, out: null, fallback: null };

    const first = await docRender.run(input, ctx);
    expect(first.content).toContain("Attempt 1 of 3");
    await docRender.run(input, ctx);
    const third = await docRender.run(input, ctx);
    expect(third.content).toContain("render with fallback: true");
  });

  it("announce what a render wrote, so the file tree picks it up", async () => {
    emitted = [];
    await fakeScript(
      "doc_render.py",
      `echo '{"path":"${root}/notes.pdf","format":"pdf","type":"memo","pages":2,"warnings":["figure 1 (mermaid) has no caption"],"figure_errors":[]}'\n`,
    );
    const result = await docRender.run(
      { source: "notes.md", format: "pdf", out: null, fallback: null },
      context(fakeDocs(), { turnId: "66666666-6666-6666-6666-666666666666" }),
    );
    expect(result.content).toContain("Rendered notes.pdf (2 pages), type memo.");
    expect(result.content).toContain("has no caption");
    expect(emitted).toEqual([{ type: "file.changed", projectId: PROJECT, path: "notes.pdf", change: "modified" }]);
  });

  it("drop null fields before handing edits to the script", async () => {
    // The script keeps its --ops argument for the test to read.
    await fakeScript("doc_edit.py", `printf '%s' "$3" > "${root}/ops.json"; printf '{"path":"%s","applied":["ok"]}' "$1"\n`);
    const op = {
      op: "replace_text" as const,
      anchor: null, position: null, find: "ten", text: "fifteen", all: null, style: null, level: null,
      rows: null, table: null, row: null, col: null, index: null, image: null, width_cm: null,
      fields: null, files: null, pages: null, degrees: null, title: null, author: null, subject: null,
    };
    const result = await docEdit.run({ path: "report.pdf", operations: [op], out: null }, context(fakeDocs()));
    expect(result.content).toBe("Wrote report.pdf:\n- ok");
    expect(await readFile(join(root, "ops.json"), "utf8")).toBe('[{"op":"replace_text","find":"ten","text":"fifteen"}]');
  });

  it("summarise doc_check's issues one per line", async () => {
    await fakeScript(
      "doc_check.py",
      `echo '{"pages":3,"passed":false,"errors":1,"warnings":0,"issues":[{"check":"fonts","severity":"error","page":null,"detail":"font X is not embedded"}]}'\n`,
    );
    const result = await docCheck.run({ pdf: "report.pdf", source: null, page_budget: 5 }, context(fakeDocs()));
    expect(result.content).toBe(
      "report.pdf: 3 pages, failed (1 errors, 0 warnings).\n- [error] fonts: font X is not embedded",
    );
  });

  it("load a skill without its front matter", async () => {
    const result = await docSkill.run({ name: "doc-plan" }, context(fakeDocs()));
    expect(result.content).toBe("# Planning\nBody.");
  });
});

describe("the doc kit", () => {
  // The prompt lists the skills from a constant so it stays in the cached
  // prefix; this is what keeps that list and the files in step.
  it("has a SKILL.md for every listed skill, with the same description", async () => {
    const kit = defaultKitDir();
    const dirs = (await readdir(join(kit, "skills"))).sort();
    expect(dirs).toEqual(DOCUMENTATION_SKILLS.map((s) => s.name).sort());
    for (const skill of DOCUMENTATION_SKILLS) {
      const text = await readFile(join(kit, "skills", skill.name, "SKILL.md"), "utf8");
      const front = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
      expect(front).toContain(`name: ${skill.name}`);
      expect(front).toContain(`description: ${skill.description}`);
    }
  });

  it("names every skill in the documentation rules", () => {
    for (const skill of DOCUMENTATION_SKILLS) expect(DOCUMENTATION_RULES).toContain(`- ${skill.name}: `);
  });
});

/**
 * The real scripts, where the server's Python has their packages. Skipped
 * elsewhere rather than failed: the toolchain is the server image's, and a
 * laptop without python-docx is not a broken build. DOC_PYTHON points at a
 * venv that has them.
 */
const python = process.env.DOC_PYTHON ?? "python3";
const hasToolchain = (() => {
  try {
    execFileSync(python, ["-c", "import docx, pypdf, pdfplumber"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasToolchain)("the doc kit's scripts", () => {
  const real = (): DocumentsProvider => ({
    kitDir: defaultKitDir(),
    python,
    visionModel: "test/vision",
    look: async () => "",
  });

  beforeAll(() => {
    execFileSync(python, [
      "-c",
      [
        "import sys",
        "from docx import Document",
        "d = Document()",
        "d.add_heading('Quarterly report', 0)",
        "d.add_heading('Summary', 1)",
        "p = d.add_paragraph('Revenue grew ')",
        "r = p.add_run('ten percent')",
        "r.bold = True",
        "p.add_run(' this quarter.')",
        "t = d.add_table(rows=2, cols=2)",
        "t.cell(0, 0).text = 'Region'; t.cell(0, 1).text = 'Growth'",
        "t.cell(1, 0).text = 'EU'; t.cell(1, 1).text = '8%'",
        "d.save(sys.argv[1])",
      ].join("\n"),
      join(root, "quarterly.docx"),
    ]);
  });

  it("reads a .docx with its paragraphs, table and headings", async () => {
    const result = await docRead.run({ path: "quarterly.docx", pages: null }, context(real()));
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("# Summary");
    expect(result.content).toContain("| EU | 8% |");
    expect(result.content).toContain("Revenue grew ten percent this quarter.");
  });

  it("edits a .docx across formatting runs and keeps the run's bold", async () => {
    const op = (over: Record<string, unknown>) => ({
      op: "replace_text" as const,
      anchor: null, position: null, find: null, text: null, all: null, style: null, level: null,
      rows: null, table: null, row: null, col: null, index: null, image: null, width_cm: null,
      fields: null, files: null, pages: null, degrees: null, title: null, author: null, subject: null,
      ...over,
    });
    const result = await docEdit.run(
      {
        path: "quarterly.docx",
        operations: [
          // Starts in the bold run and ends in the plain one after it.
          op({ find: "ten percent this", text: "twelve percent this" }),
          op({ op: "set_cell", table: 1, row: 2, col: 2, text: "9%" }),
          op({ op: "insert_heading", anchor: "Revenue grew", text: "Outlook", level: 1 }),
        ],
        out: "quarterly.edited.docx",
      },
      context(real()),
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Wrote quarterly.edited.docx");

    const read = await docRead.run({ path: "quarterly.edited.docx", pages: null }, context(real()));
    expect(read.content).toContain("Revenue grew twelve percent this quarter.");
    expect(read.content).toContain("| EU | 9% |");
    expect(read.content).toContain("# Outlook");

    const bold = execFileSync(python, [
      "-c",
      "import sys; from docx import Document; p = Document(sys.argv[1]).paragraphs[2]; print([r.text for r in p.runs if r.bold])",
      join(root, "quarterly.edited.docx"),
    ]).toString();
    expect(bold).toContain("twelve percent this");
  });
});
