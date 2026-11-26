import { parseDirectives } from "@ucch/protocol/plain";
import { describe, expect, it } from "vitest";
import { agentArgsAt, closeAgentArgs, insertAgentMention, matchAgentMentions, pickAgentModel } from "./composer-mention";
import { mentionAt } from "./file-mention";

describe("matchAgentMentions", () => {
  it("offers both for a bare @, and what a prefix could become", () => {
    expect(matchAgentMentions("").map((m) => m.name)).toEqual(["reviewer", "council"]);
    expect(matchAgentMentions("rev").map((m) => m.name)).toEqual(["reviewer"]);
    expect(matchAgentMentions("Co").map((m) => m.name)).toEqual(["council"]);
  });
  it("offers neither for a path", () => {
    expect(matchAgentMentions("src/app")).toEqual([]);
    expect(matchAgentMentions("reviewers")).toEqual([]);
  });
});

describe("the model step", () => {
  /** Types `text` with the caret at `|`, and returns both. */
  const at = (marked: string) => ({ text: marked.replace("|", ""), caret: marked.indexOf("|") });

  it("inserts the mention closed, with the caret inside its parentheses", () => {
    const { text, caret } = at("fix the bug @rev|");
    const next = insertAgentMention(text, mentionAt(text, caret)!, caret, "reviewer");
    expect(next.text).toBe("fix the bug @reviewer()");
    expect(next.caret).toBe("fix the bug @reviewer(".length);
    expect(agentArgsAt(next.text, next.caret)).toMatchObject({ name: "reviewer", before: [], query: "" });
  });

  it("knows the tokens before the caret and the one being typed", () => {
    const { text, caret } = at("go @council(opus, gp|) now");
    expect(agentArgsAt(text, caret)).toMatchObject({ name: "council", before: ["opus"], query: "gp" });
  });

  it("is not inside parentheses that closed before the caret, or in an email", () => {
    expect(agentArgsAt(...Object.values(at("@reviewer(opus) and |")) as [string, number])).toBeNull();
    expect(agentArgsAt(...Object.values(at("me@reviewer(x|")) as [string, number])).toBeNull();
  });

  it("adds models with room for another, then closes at the limit", () => {
    let { text, caret } = at("check @reviewer(|)");
    for (const model of ["opus", "gpt-5"]) {
      ({ text, caret } = pickAgentModel(text, agentArgsAt(text, caret)!, model));
    }
    expect(text).toBe("check @reviewer(opus, gpt-5, )");
    ({ text, caret } = pickAgentModel(text, agentArgsAt(text, caret)!, "gemini-2.5-pro"));
    // Three is the reviewer's limit: closed, and the caret past it.
    expect(text).toBe("check @reviewer(opus, gpt-5, gemini-2.5-pro) ");
    expect(agentArgsAt(text, caret)).toBeNull();
    expect(parseDirectives(text).reviewer?.models).toEqual(["opus", "gpt-5", "gemini-2.5-pro"]);
  });

  it("keeps options when Auto empties the models", () => {
    const { text, caret } = at("q @council(rounds=2, |)");
    const next = pickAgentModel(text, agentArgsAt(text, caret)!, null);
    expect(next.text).toBe("q @council(rounds=2) ");
    expect(parseDirectives(`${next.text}why?`).errors).toEqual([]);
  });

  it("closes cleanly, dropping a trailing comma", () => {
    const { text, caret } = at("do it @reviewer(opus, |)");
    const next = closeAgentArgs(text, agentArgsAt(text, caret)!);
    expect(next.text).toBe("do it @reviewer(opus) ");
    expect(parseDirectives(next.text).errors).toEqual([]);
  });

  it("puts the session's own model in as `same`", () => {
    const { text, caret } = at("@reviewer(|)");
    expect(pickAgentModel(text, agentArgsAt(text, caret)!, "same").text).toBe("@reviewer(same, )");
  });
});
