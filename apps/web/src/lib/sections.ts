import {
  ActivityIcon,
  BotIcon,
  ChartColumnIcon,
  DatabaseIcon,
  HistoryIcon,
  HomeIcon,
  KeyRoundIcon,
  LayersIcon,
  ListTodoIcon,
  PaletteIcon,
  Settings2Icon,
  RocketIcon,
  SettingsIcon,
  SlidersHorizontalIcon,
  SquareKanbanIcon,
  StickyNoteIcon,
  UserRoundIcon,
  UsersRoundIcon,
  Share2Icon,
  type LucideIcon,
} from "lucide-react";

export interface Section {
  id: string;
  title: string;
  /**
   * Whose the section is. A `workspace` section lives under the workspace's
   * own address, and its `href` and `entry` are relative to `/{ws}` -- build
   * the real link with `sectionHref` / `sectionEntry`. A `global` one (Home,
   * the account's Settings) is the same page in every workspace, and its
   * paths are absolute.
   */
  scope: "workspace" | "global";
  /** The section's page: `/{id}` under the workspace, "" for the dashboard. */
  href: string;
  /**
   * Where the rail's link goes, when that is not `href` itself -- a section
   * whose own page only redirects. Linking to the destination saves a round
   * trip to the server on every click.
   */
  entry?: string;
  icon: LucideIcon;
  /**
   * What the section holds, in one sentence. Shown in the sidebar panel and
   * on the page itself, so the two never drift apart.
   */
  blurb: string;
}

// Generic in the id so each section keeps its literal type, which is what
// makes SectionId a union of the real ids rather than plain `string`.
function section<Id extends string>(
  id: Id,
  title: string,
  icon: LucideIcon,
  blurb: string,
  href: string = `/${id}`,
) {
  return { id, title, scope: "workspace" as const, href, icon, blurb } satisfies Section;
}

/** The shape of every hash the API mints: workspaces, projects and sessions alike. */
export const HASH = /^[a-z0-9]{12}$/;

/** A section's page, in workspace `ws` when the section belongs to one. */
export function sectionHref(section: Section, ws: string): string {
  return section.scope === "global" ? section.href : `/${ws}${section.href}`;
}

/** Where the rail's link for a section goes: its entry page, else the page itself. */
export function sectionEntry(section: Section, ws: string): string {
  const path = section.entry ?? section.href;
  return section.scope === "global" ? path : `/${ws}${path}`;
}

/** The pathname without a trailing slash, so `/x/` and `/x` parse alike. */
function trimmed(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

/**
 * The workspace a URL is in, and the rest of the path below it.
 *
 * Every hash-led URL is read as a workspace's, including an old
 * `/{projectHash}` bookmark: that page redirects, and until it does the
 * shell simply does not find a workspace by that hash.
 */
function inWorkspace(pathname: string): { ws: string; rest: string } | null {
  const match = /^\/([a-z0-9]{12})(\/.*)?$/.exec(trimmed(pathname));
  return match ? { ws: match[1]!, rest: match[2] ?? "" } : null;
}

/** The workspace hash a URL names, or null off a workspace's pages. */
export function workspaceHashFromPath(pathname: string): string | null {
  return inWorkspace(pathname)?.ws ?? null;
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
    "The workspace's projects, and an overview of what is running, what changed, and where you left off.",
    // The workspace's own address, `/{ws}`.
    "",
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
 * The account's own settings. Reached from the profile menu rather than the
 * rail: they follow the person across every workspace.
 */
export const SETTINGS = {
  ...section("setting", "Account Setting", UserRoundIcon, "Your account, keys, providers, usage and theme."),
  scope: "global",
  // `/setting` redirects to its first page; links go there directly.
  entry: "/setting/account",
} satisfies Section;

/**
 * Pinned to the foot of the rail rather than listed with the others: it is
 * where you configure the active workspace, not one of the things you do to
 * a project.
 */
export const WORKSPACE_SETTINGS = {
  ...section(
    "workspace-settings",
    "Workspace Settings",
    SettingsIcon,
    "Defaults, members and roles, sharing, and the harness subscription for this workspace.",
  ),
  entry: "/workspace-settings/general",
} satisfies Section;

/**
 * The root URL: every workspace you belong to, listed in the sidebar panel.
 * Reached from the logo rather than the rail, and the one section whose
 * `href` is not `/{id}` -- it is the address a person types.
 */
export const HOME = {
  id: "home",
  title: "Workspaces",
  scope: "global",
  href: "/",
  icon: LayersIcon,
  blurb: "Every workspace you belong to. Pick one to open its dashboard.",
} as const satisfies Section;

export const ALL_SECTIONS = [...SECTIONS, WORKSPACE_SETTINGS, SETTINGS, HOME] as const satisfies readonly Section[];

/**
 * A page of Settings, at `/setting/{id}` -- the account's, so outside any workspace.
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

/** The pages of Workspace Settings, at `/{ws}/workspace-settings/{id}`, in sidebar order. */
export const WORKSPACE_SETTINGS_PAGES = [
  settingsPage("general", "General", SlidersHorizontalIcon),
  settingsPage("members", "Members & Roles", UsersRoundIcon),
  settingsPage("sharing", "Sharing", Share2Icon),
  settingsPage("harness", "Harness Subscription", BotIcon),
] as const satisfies readonly SettingsPage[];

export type WorkspaceSettingsPageId = (typeof WORKSPACE_SETTINGS_PAGES)[number]["id"];

export function isWorkspaceSettingsPageId(id: string): id is WorkspaceSettingsPageId {
  return WORKSPACE_SETTINGS_PAGES.some((p) => p.id === id);
}

export function workspaceSettingsPageById(id: WorkspaceSettingsPageId): SettingsPage {
  return WORKSPACE_SETTINGS_PAGES.find((p) => p.id === id)!;
}

export function workspaceSettingsPageHref(ws: string, id: WorkspaceSettingsPageId): string {
  return `${sectionHref(WORKSPACE_SETTINGS, ws)}/${id}`;
}

/** Which Workspace Settings page a URL is on, or null elsewhere. */
export function workspaceSettingsPageFromPath(pathname: string): WorkspaceSettingsPageId | null {
  const match = /^\/workspace-settings\/([^/]+)$/.exec(inWorkspace(pathname)?.rest ?? "");
  const id = match?.[1];
  return id && isWorkspaceSettingsPageId(id) ? id : null;
}

/** Where a URL under /database points: a connection, its database, maybe a table. */
export interface DatabasePath {
  connectionId: string;
  db: string;
  table: string | null;
}

export function databaseHref(ws: string, connectionId: string, db: string, table?: string | null): string {
  const base = `${connectionHref(ws, connectionId)}/${encodeURIComponent(db)}`;
  return table ? `${base}/${encodeURIComponent(table)}` : base;
}

/** The URL of a connection's own page: every database on the server. */
export function connectionHref(ws: string, connectionId: string): string {
  return `/${ws}/database/${encodeURIComponent(connectionId)}`;
}

/** The connection a URL names when it is on a connection's own page, else null. */
export function connectionIdFromPath(pathname: string): string | null {
  const match = /^\/database\/([^/]+)$/.exec(inWorkspace(pathname)?.rest ?? "");
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
}

/** The connection, database and table a URL names, or null off the database pages. */
export function databasePathFromPath(pathname: string): DatabasePath | null {
  const match = /^\/database\/([^/]+)\/([^/]+)(?:\/([^/]+))?$/.exec(inWorkspace(pathname)?.rest ?? "");
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
  const path = trimmed(pathname);
  // Every path starts with "/", so the root has to be matched exactly.
  if (path === HOME.href) return HOME;
  if (path === SETTINGS.href || path.startsWith(`${SETTINGS.href}/`)) return SETTINGS;

  const rest = inWorkspace(path)?.rest ?? "";
  const match = ALL_SECTIONS.find(
    (s) => s.scope === "workspace" && s.href !== "" && (rest === s.href || rest.startsWith(`${s.href}/`)),
  );
  if (match) return match;

  // Everything else is the dashboard itself or a project or session under
  // it, and the projects are listed there -- so the rail stays lit on the
  // dashboard rather than going blank the moment you open one.
  return SECTIONS[0];
}

/** Looks a section up by id, for the pages that name their own. */
export function sectionById(id: SectionId): Section {
  return ALL_SECTIONS.find((s) => s.id === id)!;
}

/** The shape of a project hash, as the API mints them. */
export const PROJECT_HASH = HASH;

/** What a workspace holds: named projects, or quick sessions. */
export type ProjectKind = "project" | "session";

/**
 * Where a project lives in the app -- the same address the server's
 * `webPathOf` builds. A session workspace's session is a project row,
 * `/{ws}/s/{hash}`; a project is `/{ws}/p/{hash}`, and one of its
 * sessions `/{ws}/p/{hash}/{sessionHash}`.
 */
export function projectHref(ws: string, kind: ProjectKind, projectHash: string, sessionHash?: string | null): string {
  if (kind === "session") return `/${ws}/s/${projectHash}`;
  return sessionHash ? `/${ws}/p/${projectHash}/${sessionHash}` : `/${ws}/p/${projectHash}`;
}

/**
 * The project hash a URL names -- a project's pages, one of its sessions, or
 * a session workspace's session -- or null when it is none of those.
 *
 * The shell is a layout shared by every page, so which project is open --
 * and whether one is -- has to come from the URL rather than from the page
 * that is rendering inside it. Known before the page's own data arrives,
 * which is what lets the rail and the breadcrumb be right during a loading
 * state.
 */
export function projectHashFromPath(pathname: string): string | null {
  const match = /^\/[ps]\/([a-z0-9]{12})(?:\/|$)/.exec(inWorkspace(pathname)?.rest ?? "");
  return match?.[1] ?? null;
}

/** The project session a URL is on, `/{ws}/p/{project}/{session}`, or null. */
export function projectSessionHashFromPath(pathname: string): string | null {
  const match = /^\/p\/[a-z0-9]{12}\/([a-z0-9]{12})$/.exec(inWorkspace(pathname)?.rest ?? "");
  return match?.[1] ?? null;
}

/**
 * A page that belongs to one project, at `/{ws}/p/{projectHash}/{id}`.
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
  projectPage(
    "tasks",
    "Tasks",
    SquareKanbanIcon,
    "A board of todos the AI carries from idea through research, work and verification to done.",
  ),
  // Notes, diagrams and references: the views its page switches between.
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
    "manage",
    "Manage",
    Settings2Icon,
    "What the project has used, and where its repository lives.",
  ),
] as const satisfies readonly ProjectPage[];

export type ProjectPageId = (typeof PROJECT_PAGES)[number]["id"];

/**
 * The pages listed under a project in the sidebar. Documentation is a tab of
 * the project's own view, and Manage the settings button beside its search,
 * so neither needs a row; both keep their routes.
 */
export const SIDEBAR_PROJECT_PAGES = PROJECT_PAGES.filter((p) => p.id !== "documentation" && p.id !== "manage");

export function projectPageById(id: ProjectPageId): ProjectPage {
  return PROJECT_PAGES.find((p) => p.id === id)!;
}

/** The URL of a project's page. */
export function projectPageHref(ws: string, projectHash: string, id: ProjectPageId): string {
  return `${projectHref(ws, "project", projectHash)}/${id}`;
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
  const match = /^\/p\/[a-z0-9]{12}\/([^/]+)(?:\/.*)?$/.exec(inWorkspace(pathname)?.rest ?? "");
  const id = match?.[1];
  return PROJECT_PAGES.some((p) => p.id === id) ? (id as ProjectPageId) : null;
}

/** The shape of a note id: a uuid, as the database mints them. */
export const NOTE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The views of a project's documentation, switched from the tabs across its page. */
export const DOC_VIEWS = [
  { id: "notes", label: "Notes" },
  { id: "diagrams", label: "Diagrams" },
  { id: "references", label: "References" },
  { id: "keys", label: "Keys" },
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
export function noteHref(ws: string, projectHash: string, noteId: string | null, rootId?: string): string {
  const base = projectPageHref(ws, projectHash, "documentation");
  if (noteId === null || noteId === rootId) return base;
  return `${base}/${noteId}`;
}

/** The note a URL names, or null on `/documentation` itself or off its pages. */
export function noteIdFromPath(pathname: string): string | null {
  const match = /^\/p\/[a-z0-9]{12}\/documentation\/([^/]+)$/.exec(inWorkspace(pathname)?.rest ?? "");
  const id = match?.[1];
  return id && NOTE_ID.test(id) ? id : null;
}
