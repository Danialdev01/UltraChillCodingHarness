import { DOCUMENTATION_SKILLS } from "@ucch/agent";
import { describe, expect, it } from "vitest";
import { documentationPrompt, documentsBackends } from "./documents.js";
import type { Config } from "./config.js";

const docs = { kitDir: "/opt/kit", python: "/opt/doc-venv/bin/python", visionModel: "v" };

describe("a documentation turn on a CLI provider", () => {
  it("keeps the person's message first and untouched", () => {
    expect(documentationPrompt("  Write the failover runbook as a PDF.\n", docs)).toMatch(
      /^Write the failover runbook as a PDF\.\n\n---\n\n/,
    );
  });

  it("names the scripts with the configured interpreter and every skill by path", () => {
    const prompt = documentationPrompt("x", docs);
    expect(prompt).toContain("/opt/doc-venv/bin/python /opt/kit/scripts/doc_render.py");
    expect(prompt).toContain("/opt/doc-venv/bin/python /opt/kit/scripts/doc_edit.py");
    for (const skill of DOCUMENTATION_SKILLS) {
      expect(prompt).toContain(`/opt/kit/skills/${skill.name}/SKILL.md`);
    }
  });
});

describe("the document backends", () => {
  it("find the kit beside the agent package unless told otherwise", () => {
    const config = { DOC_PYTHON: "python3", DOC_VISION_MODEL: "m" } as Config;
    expect(documentsBackends(config).kitDir).toMatch(/packages\/agent\/doc-kit$/);
    expect(documentsBackends({ ...config, DOC_KIT_DIR: "/srv/kit" }).kitDir).toBe("/srv/kit");
  });
});
