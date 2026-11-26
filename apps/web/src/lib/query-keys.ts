/**
 * Every client-cache key, in one place.
 *
 * Hooks read with these and the realtime bridge (`realtime-cache.ts`)
 * invalidates with them, so an event and the view it should refresh can
 * never disagree about a key's spelling. Each family starts with its domain,
 * so `invalidateQueries({ queryKey: qk.tasks.all })` reaches every list of
 * tasks however it was filtered.
 */
export const qk = {
  bootstrap: (ws?: string | null) => ["bootstrap", ws ?? null] as const,
  workspaces: { all: ["workspaces"] as const },
  projects: {
    all: ["projects"] as const,
    list: (workspaceId: string) => ["projects", "list", workspaceId] as const,
  },
  /** One project as its pages show it (`lib/queries/project.ts`); `qk.project.all` reaches every one. */
  project: Object.assign((projectHash: string) => ["project", projectHash] as const, { all: ["project"] as const }),
  connections: {
    all: ["connections"] as const,
    list: (workspaceId: string) => ["connections", "list", workspaceId] as const,
  },
  /** The Terminal section: a workspace's SSH hosts, and each host's folders. */
  sshHosts: {
    all: ["ssh-hosts"] as const,
    list: (workspaceId: string) => ["ssh-hosts", "list", workspaceId] as const,
    folder: (hostId: string, path: string) => ["ssh-hosts", "folder", hostId, path] as const,
    host: (hostId: string) => ["ssh-hosts", "folder", hostId] as const,
  },
  database: {
    all: ["database"] as const,
    databases: (connectionId: string) => ["database", "databases", connectionId] as const,
    tables: (connectionId: string, db: string) => ["database", "tables", connectionId, db] as const,
  },
  sessions: {
    all: ["sessions"] as const,
    list: (projectHash: string) => ["sessions", "list", projectHash] as const,
    /** Every session in a workspace, for the sidebar; `sessions.all` reaches it too. */
    workspace: (workspaceId: string, archived = false) => ["sessions", "workspace", workspaceId, archived] as const,
  },
  tasks: {
    all: ["tasks"] as const,
    list: (projectHash: string) => ["tasks", "list", projectHash] as const,
    settings: (projectHash: string) => ["tasks", "settings", projectHash] as const,
  },
  notes: {
    all: ["notes"] as const,
    tree: (projectHash: string) => ["notes", "tree", projectHash] as const,
  },
  keys: {
    all: ["keys"] as const,
    // "env": the list is `{ configured, vars }` now, not the array cached as "list" before.
    list: (projectHash: string) => ["keys", "env", projectHash] as const,
  },
  activity: { all: ["activity"] as const },
  members: {
    all: ["members"] as const,
    list: (workspaceId: string) => ["members", "list", workspaceId] as const,
  },
  git: {
    all: ["git"] as const,
    /** One tree's status, branches or first page of history: a project's checkout, or a session's worktree. */
    read: (read: "status" | "branches" | "log", projectHash: string, session?: string | null) =>
      ["git", read, projectHash, session ?? null] as const,
  },
  /** A tree's code reviews (OM7.8): the checkout's, or a session worktree's. */
  reviews: (projectHash: string, session?: string | null) => ["reviews", projectHash, session ?? null] as const,
  files: {
    all: ["files"] as const,
    tree: (projectHash: string, session?: string | null) => ["files", "tree", projectHash, session ?? null] as const,
  },
  quotas: { all: ["quotas"] as const },
  /** A project's command buttons, from `.agent/commands.json`. */
  commands: {
    all: ["commands"] as const,
    list: (projectHash: string) => ["commands", projectHash] as const,
  },
  /** The caller's terminals in a project (`GET /api/projects/:id/terminals`). */
  terminals: {
    all: ["terminals"] as const,
    list: (projectId: string) => ["terminals", projectId] as const,
  },
  /** A project's shared browser: its sessions and tabs (`GET /api/projects/:hash/browser`). */
  browser: {
    all: ["browser"] as const,
    list: (projectHash: string) => ["browser", projectHash] as const,
  },
  /** A project's runtime versions, from `.agent/runtimes.json` and the server's installs. */
  runtimes: {
    all: ["runtimes"] as const,
    list: (projectHash: string) => ["runtimes", projectHash] as const,
    /** Its framework profile (`.agent/framework.json`), refetched with the runtimes it sits beside. */
    framework: (projectHash: string) => ["runtimes", projectHash, "framework"] as const,
  },
} as const;
