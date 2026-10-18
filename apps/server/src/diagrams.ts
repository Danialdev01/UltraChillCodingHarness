/**
 * The diagrams on a project's documentation page, and how the agent draws them.
 *
 * A diagram is a Mermaid file in the project's `.ucch/diagrams/`, so it is
 * versioned with the code it describes, readable in any Markdown viewer, and
 * listed to every agent alongside the rest of the project's `.ucch` knowledge.
 */

import { repairMermaid } from "./mermaid-repair.js";

/** Where each kind of diagram lives in the project's checkout. */
export const DIAGRAM_FILES = {
  database: ".ucch/diagrams/database.mmd",
  architecture: ".ucch/diagrams/architecture.mmd",
  "system-flow": ".ucch/diagrams/system-flow.mmd",
  "user-flow": ".ucch/diagrams/user-flow.mmd",
} as const;

export type DiagramKind = keyof typeof DIAGRAM_FILES;

export function isDiagramKind(kind: string): kind is DiagramKind {
  return Object.hasOwn(DIAGRAM_FILES, kind);
}

/**
 * What each kind of diagram is, for the model: the Mermaid type its reply
 * must start with, what to draw, where to look, and what to say when there
 * is nothing to draw.
 */
const SPECS: Record<
  DiagramKind,
  { header: string; label: string; task: string; explore: string; body: string[]; empty: string }
> = {
  database: {
    header: "erDiagram",
    label: "an entity-relationship",
    task: "Work out this project's database structure from its source code and draw it as a Mermaid entity-relationship diagram.",
    explore:
      "Look for whatever defines the schema: ORM models and schema files (Drizzle, Prisma, TypeORM, Sequelize, SQLAlchemy, Django models, ActiveRecord, Ecto, GORM, ...), migrations, raw SQL (`CREATE TABLE`), and document-database models. Prefer the schema definition over migrations when both exist, since it is the current state.",
    body: [
      "- One entity per table or collection, named as in the database.",
      "- Inside each entity, its columns as `type name` with `PK`, `FK` or `UK` where they apply. Keep types short (`uuid`, `text`, `int`, `timestamp`, `bool`, `json`, ...). Use only letters, digits and underscores in types and names.",
      "- Relationships between entities with the right cardinality (`||--o{`, `||--||`, `}o--o{`, ...) and a short label in quotes.",
    ],
    empty: "If the project has no database at all, still reply with the fenced block: `erDiagram`, then a `%%` comment saying no database schema was found and where you looked.",
  },
  architecture: {
    header: "flowchart",
    label: "a flowchart",
    task: "Work out this project's architecture from its source code and draw it as a Mermaid flowchart.",
    explore:
      "Look at the workspace layout (apps, packages, services), entry points, Dockerfiles and compose files, deployment config, environment variables, and the clients the code creates for datastores, queues and external APIs.",
    body: [
      "- The first line is `flowchart LR`.",
      "- One node per deployable (app, service, worker), shared package, datastore, queue, and external service, labelled with its name as the code calls it.",
      "- A `subgraph` per deployable or runtime boundary where that makes the picture clearer.",
      "- Edges for how they talk, labelled with the protocol or purpose (`HTTP`, `WebSocket`, `SQL`, `imports`, ...).",
      '- Put every node label and every edge label in double quotes -- `login["/login (GET)"] -->|"@auth"| dashboard` -- and never put a double quote inside one; use single quotes there. Unquoted, characters like `@ / ( ) [ ] { } | " :` break the diagram.',
    ],
    empty: "If there is nothing beyond a single program, still reply with the fenced block: `flowchart LR`, a `%%` comment saying so, and that one node.",
  },
  "system-flow": {
    header: "sequenceDiagram",
    label: "a sequence",
    task: "Work out how the main request moves through this system, step by step, from its source code and draw it as a Mermaid sequence diagram.",
    explore:
      "Find the system's central operation -- the request, job or command most of the code exists to serve -- and trace it from where it enters (a route, a handler, a CLI command, a queue consumer) through every component it touches until the response or result.",
    body: [
      "- The first line is `sequenceDiagram`.",
      "- One `participant` per component on the path, named as in the code (the client, the server, a module, the database, an external API).",
      "- Messages in order, each labelled with the call, route or event it is. Use `alt`/`opt`/`loop` where the code branches or repeats in a way that matters.",
      "- Participant names are plain identifiers; give one a readable name with `participant api as API server`. Keep `;` and `#` out of message text.",
    ],
    empty: "If no such flow can be found, still reply with the fenced block: `sequenceDiagram`, a `%%` comment saying what was looked at, and a single participant.",
  },
  "user-flow": {
    header: "flowchart",
    label: "a flowchart",
    task: "Work out the paths a person takes through this product from its source code and draw them as a Mermaid flowchart.",
    explore:
      "Look at the routes and pages (file-based routing directories, router definitions), navigation components, redirects, auth guards, and the forms and buttons that move a person from one screen to the next.",
    body: [
      "- The first line is `flowchart TD`.",
      "- One node per page or screen, labelled with its name and route; decision nodes (`{...}`) for branches like signed in or not.",
      "- Edges for how a person gets from one to the next, labelled with the action (`sign in`, `open project`, ...).",
      '- Put every node label and every edge label in double quotes -- `login["/login (GET)"] -->|"@auth"| dashboard` -- and never put a double quote inside one; use single quotes there. Unquoted, characters like `@ / ( ) [ ] { } | " :` break the diagram.',
    ],
    empty: "If the project has no user interface, still reply with the fenced block: `flowchart TD`, a `%%` comment saying no screens were found and where you looked, and a single node.",
  },
};

/**
 * What the model is asked when a diagram is regenerated.
 *
 * Read-only by its tools, not only by this wording: the run is given the
 * `readonly` preset. The reply is parsed, not shown, so the format rules are
 * strict -- one fence, the kind's Mermaid type, provenance in a comment line.
 */
export function diagramAsk(kind: DiagramKind): string {
  const spec = SPECS[kind];
  return [
    spec.task,
    "",
    `Explore the repository with your tools. ${spec.explore} \`.ucch/INFO.md\` describes the project and may help you orient, but the source code is the truth: the rest of \`.ucch/\` holds notes and earlier drawings, not the system. Do not change any files.`,
    "",
    "Reply with exactly one fenced code block tagged `mermaid` and nothing else. Inside it:",
    ...(kind === "database" ? ["- The first line is `erDiagram`."] : []),
    "- The second line is a `%%` comment naming where this came from (the files or directories you read).",
    ...spec.body,
    "",
    spec.empty,
  ].join("\n");
}

/**
 * The diagram in a model's reply: the last ```mermaid fence, which must be
 * of the kind's Mermaid type, with a flowchart's labels quoted so it parses
 * (see `repairMermaid`). Throws with a message fit to show the person
 * otherwise.
 */
export function extractMermaid(text: string, kind: DiagramKind): string {
  const fences = [...text.matchAll(/```mermaid[^\S\n]*\n([\s\S]*?)```/g)];
  const last = fences.at(-1)?.[1]?.trim();
  if (!last) throw new Error("The model did not reply with a Mermaid diagram. Try again.");
  const { header, label } = SPECS[kind];
  if (!new RegExp(`^${header}\\b`).test(last)) {
    throw new Error(`The model replied with a diagram that is not ${label} diagram. Try again.`);
  }
  return `${repairMermaid(last)}\n`;
}
