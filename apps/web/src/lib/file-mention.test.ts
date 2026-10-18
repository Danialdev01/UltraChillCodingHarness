import { describe, expect, it } from "vitest";
import { insertMention, mentionAt, rankEntries } from "./file-mention.js";
import type { TreeEntry } from "./file-tree.js";

const file = (path: string): TreeEntry => ({ path, name: path.split("/").pop()!, kind: "file" });
const folder = (path: string): TreeEntry => ({ ...file(path), kind: "folder" });

describe("finding the mention at the caret", () => {
  it("opens on an @ at the start or after a space", () => {
    expect(mentionAt("@ta", 3)).toEqual({ start: 0, query: "ta" });
    expect(mentionAt("look at @tag", 12)).toEqual({ start: 8, query: "tag" });
    expect(mentionAt("look at @", 9)).toEqual({ start: 8, query: "" });
  });

  it("ignores an @ inside a word", () => {
    expect(mentionAt("mail me@host", 12)).toBeNull();
  });

  it("closes once the caret leaves the word", () => {
    expect(mentionAt("@tag done", 9)).toBeNull();
    expect(mentionAt("@tag done", 4)).toEqual({ start: 0, query: "tag" });
  });
});

describe("ranking entries", () => {
  const entries = [
    file("database/migrations/add_stage_to_projects_table.php"),
    file("database/migrations/create_tags_table.php"),
    file("app/Models/Tag.php"),
    file("resources/js/pages/main/tag.tsx"),
    folder("resources/js/routes/main/tag"),
    file("README.md"),
  ];

  it("puts names that start with the query first and drops non-matches", () => {
    const ranked = rankEntries(entries, "tag").map((e) => e.path);
    expect(ranked.slice(0, 3)).toEqual([
      "app/Models/Tag.php",
      "resources/js/routes/main/tag",
      "resources/js/pages/main/tag.tsx",
    ]);
    expect(ranked.indexOf("database/migrations/create_tags_table.php")).toBeLessThan(
      ranked.indexOf("database/migrations/add_stage_to_projects_table.php"),
    );
    expect(ranked).not.toContain("README.md");
  });

  it("matches letters in order across the path", () => {
    expect(rankEntries(entries, "mdtg")[0]?.path).toBe("app/Models/Tag.php");
  });

  it("shows the top of the project when nothing is typed", () => {
    expect(rankEntries(entries, "", 2).map((e) => e.path)).toEqual(["README.md", "app/Models/Tag.php"]);
  });
});

describe("inserting a pick", () => {
  it("replaces the query with the path and puts the caret after it", () => {
    expect(insertMention("see @ta now", { start: 4, query: "ta" }, 7, file("app/Tag.php"))).toEqual({
      text: "see @app/Tag.php now",
      caret: 17,
    });
  });

  it("marks a folder with a slash", () => {
    expect(insertMention("@ro", { start: 0, query: "ro" }, 3, folder("routes"))).toEqual({
      text: "@routes/ ",
      caret: 9,
    });
  });
});
