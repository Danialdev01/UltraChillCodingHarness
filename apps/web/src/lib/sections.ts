import {
  ActivityIcon,
  BotIcon,
  ChartColumnIcon,
  CodeIcon,
  DatabaseIcon,
  HistoryIcon,
  HomeIcon,
  KeyRoundIcon,
  ListTodoIcon,
  PaletteIcon,
  Settings2Icon,
  RocketIcon,
  SettingsIcon,
  SlidersHorizontalIcon,
  StickyNoteIcon,
  UserRoundIcon,
  type LucideIcon,
} from "lucide-react";

export interface Section {
  /** Also the URL: every section lives at `/{id}`. */
  id: string;
  title: string;
  href: string;
  icon: LucideIcon;
  /**
   * What the section holds, in one sentence. Shown in the sidebar panel and
   * on the page itself, so the two never drift apart.
   */
  blurb: string;
}

// Generic in the id so each section keeps its literal type, which is what
// makes SectionId a union of the real ids rather than plain `string`.
function section<Id extends string>(id: Id, title: string, icon: LucideIcon, blurb: string) {
  return { id, title, href: `/${id}`, icon, blurb } satisfies Section;
}

/**
 * The rail's sections, top to bottom. Each is a page, so the icon is a link
 * and the lit one is whichever the current URL is in -- the rail cannot show
 * a selection the address bar disagrees with.
 */
export const SECTIONS = [
  section(
    "dashboard",
    "Dashboard",
    HomeIcon,
    "An overview of this workspace: what is running, what changed, and where you left off.",
  ),
  section(
    "code",
    "Code",
    CodeIcon,
    "The workspace's projects. Open one to talk to the agent, read the diff, and run it.",
  ),
  // Titled for what the column lists -- the servers you have credentials
  // for -- while the URL keeps the older name so nothing linking to
  // `/database` moves.
  section(
    "database",
    "Connections",
    DatabaseIcon,
    "MySQL and PostgreSQL servers this workspace can reach, and the databases behind each one.",
  ),
  section(
    "publish",
    "Publish",
    RocketIcon,
    "Published previews and their shareable URLs, with expiry. Arrives with previews.",
  ),
  section(
    "todo",
    "Todo",
    ListTodoIcon,
    "Tasks the agent has planned or completed across this workspace. Arrives with the agent core.",
  ),
] as const satisfies readonly Section[];

/**
 * Pinned to the foot of the rail rather than listed with the others: it is
 * where you configure the harness, not one of the things you do to a project.
 */
export const SETTINGS = section(
  "setting",
  "Settings",
  SettingsIcon,
  "Account, workspace, and harness configuration.",
);

export const ALL_SECTIONS = [...SECTIONS, SETTINGS] as const satisfies readonly Section[];

/**
 * A page of Settings, at `/setting/{id}`.
 *
 * Listed in the sidebar panel when Settings is the section, the way a
 * project's pages are listed under the project: the row, the page and the
 * crumb all read this one record.
 */
export interface SettingsPage {
  id: string;
  title: string;
  icon: LucideIcon;
}

function settingsPage<Id extends string>(id: Id, title: string, icon: LucideIcon) {
  return { id, title, icon } satisfies SettingsPage;
}

/** The pages of Settings, in the order the sidebar lists them. */
export const SETTINGS_PAGES = [
  settingsPage("account", "Account", UserRoundIcon),
  settingsPage("api", "API Management", KeyRoundIcon),
  settingsPage("providers", "Agent Providers", BotIcon),
  settingsPage("default", "Default", SlidersHorizontalIcon),
  settingsPage("usage", "Usage", ChartColumnIcon),
  settingsPage("activity", "Activity", ActivityIcon),
  settingsPage("theme", "Theme", PaletteIcon),
] as const satisfies readonly SettingsPage[];

export type SettingsPageId = (typeof SETTINGS_PAGES)[number]["id"];

export function isSettingsPageId(id: string): id is SettingsPageId {
  return SETTINGS_PAGES.some((p) => p.id === id);
}

export function settingsPageById(id: SettingsPageId): SettingsPage {
  return SETTINGS_PAGES.find((p) => p.id === id)!;
}

/** The URL of a Settings page. */
export function settingsPageHref(id: SettingsPageId): string {
  return `${SETTINGS.href}/${id}`;
}

/** Which Settings page a URL is on, or null off Settings or at its root. */
export function settingsPageFromPath(pathname: string): SettingsPageId | null {
  const match = /^\/setting\/([^/]+)\/?$/.exec(pathname);
  const id = match?.[1];
  return id && isSettingsPageId(id) ? id : null;
}

/** Where a URL under /database points: a connection, its database, maybe a table. */
export interface DatabasePath {
  connectionId: string;
  db: string;
  table: string | null;
}

export function databaseHref(connectionId: string, db: string, table?: string | null): string {
  const base = `/database/${encodeURIComponent(connectionId)}/${encodeURIComponent(db)}`;
  return table ? `${base}/${encodeURIComponent(table)}` : base;
}

/** The URL of a connection's own page: every database on the server. */
export function connectionHref(connectionId: string): string {
  return `/database/${encodeURIComponent(connectionId)}`;
}

/** The connection a URL names when it is on a connection's own page, else null. */
export function connectionIdFromPath(pathname: string): string | null {
  const match = /^\/database\/([^/]+)\/?$/.exec(pathname);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
}

/** The connection, database and table a URL names, or null off the database pages. */
export function databasePathFromPath(pathname: string): DatabasePath | null {
  const match = /^\/database\/([^/]+)\/([^/]+)(?:\/([^/]+))?\/?$/.exec(pathname);
  if (!match) return null;
  try {
    return {
      connectionId: decodeURIComponent(match[1]!),
      db: decodeURIComponent(match[2]!),
      table: match[3] ? decodeURIComponent(match[3]) : null,
    };
  } catch {
    return null;
  }
}

export type SectionId = (typeof ALL_SECTIONS)[number]["id"];

/** The section a URL belongs to. */
export function sectionForPath(pathname: string): Section {
  const match = ALL_SECTIONS.find(
    (s) => pathname === s.href || pathname.startsWith(`${s.href}/`),
  );
  if (match) return match;

  // Everything else at the root is a project page, `/{projectHash}`, and a
  // project is what Code opens -- so the rail stays lit on Code rather than
  // going blank the moment you open one.
  return SECTIONS[1];
}

/** Looks a section up by id, for the pages that name their own. */
export function sectionById(id: SectionId): Section {
  return ALL_SECTIONS.find((s) => s.id === id)!;
}

/** The shape of a project hash, as the API mints them. */
export const PROJECT_HASH = /^[a-z0-9]{12}$/;

/**
 * The project hash a URL names, or null when it is not a project page.
 *
 * The shell is a layout shared by every page, so which project is open --
 * and whether one is -- has to come from the URL rather than from the page
 * that is rendering inside it. Known before the page's own data arrives,
 * which is what lets the rail and the breadcrumb be right during a loading
 * state.
 */
export function projectHashFromPath(pathname: string): string | null {
  const match = /^\/([a-z0-9]{12})(?:\/|$)/.exec(pathname);
  return match?.[1] ?? null;
}

/**
 * A page that belongs to one project, at `/{projectHash}/{id}`.
 *
 * Listed under the project in the sidebar. The shape mirrors `Section`, and
 * for the same reason: the row, the page and the breadcrumb all read the one
 * record, so none of them can name it differently.
 */
export interface ProjectPage {
  id: string;
  title: string;
  icon: LucideIcon;
  blurb: string;
}

function projectPage<Id extends string>(id: Id, title: string, icon: LucideIcon, blurb: string) {
  return { id, title, icon, blurb } satisfies ProjectPage;
}

/** The pages under a project, in the order the sidebar lists them. */
export const PROJECT_PAGES = [
  // Notes, diagrams and references: the views the header switches between.
  projectPage(
    "documentation",
    "Documentation",
    StickyNoteIcon,
    "Pages kept with this project: decisions, links, diagrams, and things to remember.",
  ),
  projectPage(
    "timeline",
    "Project Timeline",
    HistoryIcon,
    "The project's plan as a Gantt chart: what has to happen, from when to when, and what comes after what.",
  ),
  projectPage(
    "keys",
    "Keys",
    KeyRoundIcon,
    "API keys and env values that cannot be shown again where they were issued, kept encrypted so they can be handed back.",
  ),
  projectPage(
    "activity",
    "Activity",
    ActivityIcon,
    "Who changed what in this project -- chat, notes, files, timeline, git, keys -- live as it happens.",
  ),
  projectPage(
    "manage",
    "Manage",
    Settings2Icon,
    "The project's own settings: its name, repository, and container. Arrives with project settings.",
  ),
] as const satisfies readonly ProjectPage[];

export type ProjectPageId = (typeof PROJECT_PAGES)[number]["id"];

export function projectPageById(id: ProjectPageId): ProjectPage {
  return PROJECT_PAGES.find((p) => p.id === id)!;
}

/** The URL of a project's page. */
export function projectPageHref(projectHash: string, id: ProjectPageId): string {
  return `/${projectHash}/${id}`;
}

/**
 * Which of a project's pages a URL is on, or null for the project itself --
 * or for anything that is not a project page at all.
 *
 * Only the first segment after the hash decides: a page may have its own
 * routes below it (`/documentation/{noteId}`), and the sidebar row and the crumb
 * should stay on the page rather than go blank one level down.
 */
export function projectPageFromPath(pathname: string): ProjectPageId | null {
  const match = /^\/[a-z0-9]{12}\/([^/]+)(?:\/.*)?$/.exec(pathname);
  const id = match?.[1];
  return PROJECT_PAGES.some((p) => p.id === id) ? (id as ProjectPageId) : null;
}

/** The shape of a note id: a uuid, as the database mints them. */
export const NOTE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The three views of a project's documentation, switched from the app header. */
export const DOC_VIEWS = [
  { id: "notes", label: "Notes" },
  { id: "diagrams", label: "Diagrams" },
  { id: "references", label: "References" },
] as const;

export type DocView = (typeof DOC_VIEWS)[number]["id"];

/**
 * Which documentation view a `?view=` value names. Notes when absent or
 * unknown, so every existing notes link keeps landing on the notes.
 */
export function docViewFromParam(value: string | null): DocView {
  return DOC_VIEWS.find((v) => v.id === value)?.id ?? "notes";
}

/** The tabs of the documentation's Diagrams view. */
export const DIAGRAM_KINDS = [
  { id: "database", label: "Database" },
  { id: "architecture", label: "Architecture" },
  { id: "system-flow", label: "System Flow" },
  { id: "user-flow", label: "User Flow" },
] as const;

export type DiagramKindId = (typeof DIAGRAM_KINDS)[number]["id"];

/** Which diagram a `?diagram=` value names; Database when absent or unknown. */
export function diagramKindFromParam(value: string | null): DiagramKindId {
  return DIAGRAM_KINDS.find((k) => k.id === value)?.id ?? "database";
}

/**
 * The URL of one page of a project's notes.
 *
 * The root page is `/documentation` itself rather than `/documentation/{rootId}`: it is the
 * page the sidebar links to, and the one URL a person is likely to type, so
 * it should not depend on an id. Pass null -- or the root's id, when the
 * caller knows it -- to get there.
 */
export function noteHref(projectHash: string, noteId: string | null, rootId?: string): string {
  const base = projectPageHref(projectHash, "documentation");
  if (noteId === null || noteId === rootId) return base;
  return `${base}/${noteId}`;
}

/** The note a URL names, or null on `/documentation` itself or off its pages. */
export function noteIdFromPath(pathname: string): string | null {
  const match = /^\/[a-z0-9]{12}\/documentation\/([^/]+)\/?$/.exec(pathname);
  const id = match?.[1];
  return id && NOTE_ID.test(id) ? id : null;
}
