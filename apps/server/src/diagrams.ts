/**
 * The diagrams on a project's documentation page, and how the agent draws them.
 *
 * A diagram is a Mermaid file in the project's own repository, so it is
 * versioned with the code it describes and readable in any Markdown viewer.
 * Only the database diagram exists so far; the other tabs on the page have no
 * file and nothing to generate.
 */

/** Where each kind of diagram lives in the project's checkout. */
export const DIAGRAM_FILES = {
  database: "docs/diagrams/database.mmd",
} as const;

export type DiagramKind = keyof typeof DIAGRAM_FILES;

export function isDiagramKind(kind: string): kind is DiagramKind {
  return Object.hasOwn(DIAGRAM_FILES, kind);
}

/**
 * What the model is asked when the database diagram is regenerated.
 *
 * Read-only by its tools, not only by this wording: the run is given the
 * `readonly` preset. The reply is parsed, not shown, so the format rules are
 * strict -- one fence, an `erDiagram`, provenance in a comment line.
 */
export function databaseDiagramAsk(): string {
  return [
    "Work out this project's database structure from its source code and draw it as a Mermaid entity-relationship diagram.",
    "",
    "Explore the repository with your tools. Look for whatever defines the schema: ORM models and schema files (Drizzle, Prisma, TypeORM, Sequelize, SQLAlchemy, Django models, ActiveRecord, Ecto, GORM, ...), migrations, raw SQL (`CREATE TABLE`), and document-database models. Prefer the schema definition over migrations when both exist, since it is the current state. Ignore `docs/diagrams/`: it holds earlier drawings, not the schema. Do not change any files.",
    "",
    "Reply with exactly one fenced code block tagged `mermaid` and nothing else. Inside it:",
    "- The first line is `erDiagram`.",
    "- The second line is a `%%` comment naming where the schema came from (the files or directories you read).",
    "- One entity per table or collection, named as in the database.",
    "- Inside each entity, its columns as `type name` with `PK`, `FK` or `UK` where they apply. Keep types short (`uuid`, `text`, `int`, `timestamp`, `bool`, `json`, ...). Use only letters, digits and underscores in types and names.",
    "- Relationships between entities with the right cardinality (`||--o{`, `||--||`, `}o--o{`, ...) and a short label in quotes.",
    "",
    "If the project has no database at all, still reply with the fenced block: `erDiagram`, then a `%%` comment saying no database schema was found and where you looked.",
  ].join("\n");
}

/**
 * The diagram in a model's reply: the last ```mermaid fence, which must be
 * an `erDiagram`. Throws with a message fit to show the person otherwise.
 */
export function extractMermaid(text: string): string {
  const fences = [...text.matchAll(/```mermaid[^\S\n]*\n([\s\S]*?)```/g)];
  const last = fences.at(-1)?.[1]?.trim();
  if (!last) throw new Error("The model did not reply with a Mermaid diagram. Try again.");
  if (!/^erDiagram\b/.test(last)) {
    throw new Error("The model replied with a diagram that is not an entity-relationship diagram. Try again.");
  }
  return `${last}\n`;
}
