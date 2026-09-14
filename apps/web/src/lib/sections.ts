import {
  CodeIcon,
  DatabaseIcon,
  GitBranchIcon,
  HomeIcon,
  ListTodoIcon,
  RocketIcon,
  SettingsIcon,
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
  section(
    "database",
    "Database",
    DatabaseIcon,
    "Migrations, seeders, and a table browser for the project database. Arrives with the container runtime.",
  ),
  section(
    "git",
    "Git",
    GitBranchIcon,
    "Changed files, staged diffs, commits, and branches. Arrives with the git integration.",
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
