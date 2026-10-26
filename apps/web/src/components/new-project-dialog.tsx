"use client";

import * as React from "react";
import {
  ChevronsUpDownIcon,
  DatabaseIcon,
  FolderPlusIcon,
  GitBranchIcon,
  LockIcon,
  Loader2Icon,
  PlusIcon,
  SearchIcon,
} from "lucide-react";
import {
  DATABASE_ENGINE_LABELS,
  DEV_DATABASE_NAME,
  PROJECT_MODE_LABELS,
  PROJECT_MODES,
  suggestDevDatabaseName,
} from "@ucch/protocol/plain";
import type { DevDatabaseName, ProjectMode, DatabaseEngine, ProjectDatabase } from "@ucch/protocol";

import { GithubMark } from "@/components/github-mark";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Callout,
  Code,
  FIELD,
  FormDialog,
  FormDialogFooter,
  HELPER,
  LABEL,
  OptionPanel,
  OptionTabs,
  PopoverSelect,
  Segmented,
} from "@/components/form-dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { createProject } from "@/lib/create-project";
import {
  NoGithubToken,
  fetchBranches,
  fetchRepos,
  isValidRepoName,
  suggestRepoName,
  type GithubAccount,
  type GithubRepo,
} from "@/lib/github-api";
import { useToast } from "@/lib/realtime";
import { deriveProjectName, looksLikeRepoUrl } from "@/lib/repo-url";
import { cn } from "@/lib/utils";
import { TransitionLink, useTransitionRouter } from "@/lib/view-transitions";
import { useProjectHref } from "@/lib/workspace-context";

/** Where the code for a new project comes from. */
type Source = "github" | "custom" | "new";

const SOURCES = [
  { value: "github", title: "GitHub", hint: "Import a repo" },
  { value: "custom", title: "Git URL", hint: "Any remote" },
  { value: "new", title: "Empty", hint: "Start fresh" },
] as const;

/** Short enough for three segments side by side; the full label is the accessible name. */
const MODE_SHORT_LABELS: Record<ProjectMode, string> = {
  research: "Research",
  development: "Development",
  creative_design: "Design",
};

/** No database, then each engine the shared server runs. */
const DATABASE_OPTIONS: { value: DatabaseEngine | ""; label: string }[] = [
  { value: "", label: "No database" },
  ...(Object.keys(DATABASE_ENGINE_LABELS) as DatabaseEngine[]).map((engine) => ({
    value: engine,
    label: DATABASE_ENGINE_LABELS[engine],
  })),
];

/**
 * Starting a project, from one of three places.
 *
 * What the project is comes first -- its name, its mode and, for a development
 * project, the database it gets on the shared dev server -- and where its code
 * comes from below that.
 *
 * The three tabs are three different things the person already has: an account
 * full of repositories, a URL, or nothing at all. They converge on one command
 * -- `project.create` -- and the only difference in what is sent is whether
 * there is a `repoUrl` on it. A project with none is initialised as a git
 * repository on disk instead of cloned, which is what makes it pushable to
 * GitHub (or anywhere else) later.
 *
 * The dialog stays open until the work lands, then goes to the project. A
 * redirect at `project.created` would arrive on an empty file tree and read as
 * a broken project for as long as the clone took.
 */
export function NewProjectDialog({
  workspaceId,
  open,
  onOpenChange,
}: {
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useTransitionRouter();
  const hrefOf = useProjectHref();
  const toast = useToast();
  const [source, setSource] = React.useState<Source>("github");
  const [stage, setStage] = React.useState<"idle" | "creating" | "cloning">("idle");
  const [error, setError] = React.useState<string | null>(null);

  /** The name the project takes, whichever tab its code comes from. */
  const [name, setName] = React.useState("");
  /** True once the name has been edited, so a repository stops overwriting it. */
  const [nameTouched, setNameTouched] = React.useState(false);

  // -- What the project is ----------------------------------------------------
  const [mode, setMode] = React.useState<ProjectMode>("development");
  /** Empty for no database. */
  const [engine, setEngine] = React.useState<DatabaseEngine | "">("");
  const [dbName, setDbName] = React.useState("");
  /** True once the database name has been edited, so the project name stops overwriting it. */
  const [dbNameTouched, setDbNameTouched] = React.useState(false);

  // -- The GitHub tab --------------------------------------------------------
  const [account, setAccount] = React.useState<GithubAccount | null>(null);
  const [repos, setRepos] = React.useState<GithubRepo[] | null>(null);
  const [reposError, setReposError] = React.useState<string | null>(null);
  /** True when the account has no token: a state to act on, not an error. */
  const [needsToken, setNeedsToken] = React.useState(false);
  const [picked, setPicked] = React.useState<GithubRepo | null>(null);
  const [ghBranches, setGhBranches] = React.useState<string[]>([]);
  const [ghBranch, setGhBranch] = React.useState("");
  const [ghBranchesLoading, setGhBranchesLoading] = React.useState(false);

  // -- The custom-repository tab --------------------------------------------
  const [repoUrl, setRepoUrl] = React.useState("");
  const [branch, setBranch] = React.useState("");
  const [branches, setBranches] = React.useState<string[]>([]);
  const [checking, setChecking] = React.useState(false);
  const [refsError, setRefsError] = React.useState<string | null>(null);

  // A fresh dialog every time: a half-filled form from last week is not a
  // head start. The repository list is dropped with it, so a repository
  // created since the last visit is offered on the next one.
  React.useEffect(() => {
    if (open) return;
    setSource("github");
    setStage("idle");
    setError(null);
    setName("");
    setNameTouched(false);
    setMode("development");
    setEngine("");
    setDbName("");
    setDbNameTouched(false);
    setAccount(null);
    setRepos(null);
    setReposError(null);
    setNeedsToken(false);
    setPicked(null);
    setGhBranches([]);
    setGhBranch("");
    setRepoUrl("");
    setBranch("");
    setBranches([]);
    setRefsError(null);
  }, [open]);

  /**
   * Reads the account's repositories, once, when the tab that needs them is
   * first looked at.
   *
   * Lazily rather than on open: it is three API calls to GitHub, and somebody
   * who came here to paste a URL should not pay for them.
   */
  React.useEffect(() => {
    if (!open || source !== "github" || repos !== null || reposError || needsToken) return;

    let cancelled = false;
    void fetchRepos()
      .then(({ account: who, repos: list }) => {
        if (cancelled) return;
        setAccount(who);
        setRepos(list);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        if (e instanceof NoGithubToken) setNeedsToken(true);
        else setReposError(e instanceof Error ? e.message : String(e));
      });

    return () => {
      cancelled = true;
    };
  }, [open, source, repos, reposError, needsToken]);

  /**
   * Reads the chosen repository's branches.
   *
   * The repository already told us its default, so that is shown immediately
   * and the full list replaces it when it arrives -- the common case is
   * choosing the default, and it should not have to wait for a round trip.
   */
  React.useEffect(() => {
    if (!picked) {
      setGhBranches([]);
      setGhBranch("");
      return;
    }

    setGhBranch(picked.defaultBranch);
    setGhBranches([picked.defaultBranch]);
    setGhBranchesLoading(true);

    let cancelled = false;
    void fetchBranches(picked.owner, picked.name)
      .then(({ branches: list, defaultBranch }) => {
        if (cancelled) return;
        setGhBranches(list);
        // The repository's own default wins over the list's first entry.
        setGhBranch(defaultBranch ?? picked.defaultBranch);
      })
      .catch((e: unknown) => {
        // The default from the repository is still selected and still clones,
        // so this is a narrower picker rather than a broken tab.
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setGhBranchesLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [picked]);

  /**
   * Reads the remote's branches, a moment after typing stops.
   *
   * Debounced because this runs a real `git ls-remote` on the server, and a
   * request per keystroke would be one per character of a pasted URL. The
   * ticket makes a slow reply for an old URL unable to overwrite a fast one
   * for the URL now in the box.
   */
  const ticket = React.useRef(0);
  React.useEffect(() => {
    const url = repoUrl.trim();
    setRefsError(null);
    if (!looksLikeRepoUrl(url)) {
      setBranches([]);
      setBranch("");
      return;
    }

    const mine = ++ticket.current;
    const timer = setTimeout(() => {
      setChecking(true);
      void fetch(`/api/git/refs?url=${encodeURIComponent(url)}`, { credentials: "include" })
        .then(async (response) => {
          const body = (await response.json()) as {
            branches?: string[];
            defaultBranch?: string | null;
            error?: string;
          };
          if (mine !== ticket.current) return;
          if (!response.ok) {
            setBranches([]);
            setBranch("");
            setRefsError(body.error ?? "Could not read that repository.");
            return;
          }
          setBranches(body.branches ?? []);
          // The remote's own default, which is what a clone would pick.
          setBranch(body.defaultBranch ?? body.branches?.[0] ?? "");
        })
        .catch(() => {
          if (mine === ticket.current) setRefsError("Could not reach the server.");
        })
        .finally(() => {
          if (mine === ticket.current) setChecking(false);
        });
    }, 400);

    return () => clearTimeout(timer);
  }, [repoUrl]);

  // The name follows whichever repository the current tab names, until it is
  // edited and then it is yours.
  React.useEffect(() => {
    if (nameTouched) return;
    if (source === "github") setName(picked?.name ?? "");
    if (source === "custom") setName(deriveProjectName(repoUrl));
  }, [source, picked, repoUrl, nameTouched]);

  // The database is named after the project until somebody names it.
  React.useEffect(() => {
    if (!dbNameTouched) setDbName(suggestDevDatabaseName(name));
  }, [name, dbNameTouched]);

  /** The database to ask for, or null for none -- also null outside development. */
  const database = mode === "development" && engine ? { engine, name: dbName } : null;
  const dbNameValid = !database || DEV_DATABASE_NAME.test(dbName);

  const busy = stage !== "idle";

  /** What this tab would send, or null when it is not ready to send anything. */
  const command = React.useMemo(():
    | {
        repoUrl?: string;
        name: string;
        branch?: string;
        mode: ProjectMode;
        database?: ProjectDatabase;
      }
    | null => {
    if (!dbNameValid) return null;
    const what = { mode, ...(database ? { database } : {}) };
    if (source === "github") {
      if (!picked || !name.trim()) return null;
      return { repoUrl: picked.cloneUrl, name: name.trim(), branch: ghBranch || picked.defaultBranch, ...what };
    }
    if (source === "custom") {
      const url = repoUrl.trim();
      if (!looksLikeRepoUrl(url) || !name.trim()) return null;
      return { repoUrl: url, name: name.trim(), ...(branch ? { branch } : {}), ...what };
    }
    // No `repoUrl` at all: the server reads its absence as "start one".
    if (!isValidRepoName(name)) return null;
    return { name: name.trim(), ...what };
    // `database` is rebuilt each render; its parts are the real dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, picked, name, ghBranch, repoUrl, branch, mode, engine, dbName, dbNameValid]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !workspaceId || !command) return;

    setError(null);

    try {
      const created = await createProject({ workspaceId, ...command }, setStage);

      // The project is fine without its database, so it opens either way and
      // the reason travels with it.
      if (created.databaseError) {
        toast({ title: "No development database", description: created.databaseError, tone: "error" });
      }

      onOpenChange(false);
      // The sidebar hears of the new project as `resource.changed{projects}`.
      router.push(hrefOf(created.hash));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStage("idle");
    }
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      busy={busy}
      icon={FolderPlusIcon}
      title="Create a new project"
      description="Each project runs in an isolated workspace — the only place the agent can read or write."
      onSubmit={submit}
      footer={
        <FormDialogFooter hint="Isolated workspace" hintIcon={LockIcon} busy={busy} disabled={!command}>
          {stage === "cloning"
            ? source === "new"
              ? "Initialising…"
              : "Cloning…"
            : stage === "creating"
              ? "Creating…"
              : "Create project"}
        </FormDialogFooter>
      }
    >
            <div className="flex flex-col gap-1.5">
              <label htmlFor="new-project-name" className={LABEL}>
                Project name
              </label>
              <div className="flex h-[34px] overflow-hidden rounded-[8px] border border-(--fd-border-field) bg-(--fd-field) transition-[border-color,box-shadow] focus-within:border-(--fd-accent) focus-within:ring-[3px] focus-within:ring-(--fd-ring)">
                {account && (
                  <span className="fd-mono flex shrink-0 items-center border-r border-(--fd-prefix-border) bg-(--fd-prefix) px-2.5 text-[11.5px] text-(--fd-icon-dim) select-none">
                    {account.login} /
                  </span>
                )}
                <input
                  id="new-project-name"
                  value={name}
                  onChange={(e) => {
                    setNameTouched(true);
                    // A started repository's name is its directory's name, so it
                    // is corrected as it is typed, as GitHub does.
                    setName(source === "new" ? suggestRepoName(e.target.value) : e.target.value);
                  }}
                  placeholder="my-project"
                  spellCheck={false}
                  autoComplete="off"
                  maxLength={100}
                  disabled={busy}
                  className="fd-mono min-w-0 grow bg-transparent px-2.5 text-[12.5px] text-(--fd-text) outline-none placeholder:text-(--fd-text-disabled) focus-visible:outline-none"
                />
              </div>
              <p className={HELPER}>
                {source === "new"
                  ? "Letters, numbers, dots, dashes and underscores. It also names the new repository."
                  : "How the project is listed. Follows the repository's name until you edit it."}
              </p>
            </div>

            {/* Mode is the wider column: it has three options to the database's one trigger. */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
              <div className="flex flex-col gap-1.5">
                <span id="new-project-mode-label" className={LABEL}>
                  Mode
                </span>
                <Segmented
                  options={PROJECT_MODES.map((value) => ({
                    value,
                    label: MODE_SHORT_LABELS[value],
                    ariaLabel: PROJECT_MODE_LABELS[value],
                  }))}
                  value={mode}
                  onChange={setMode}
                  disabled={busy}
                  labelledBy="new-project-mode-label"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <span id="new-project-db-engine-label" className={LABEL}>
                  Database
                </span>
                <PopoverSelect
                  value={mode === "development" ? engine : ""}
                  options={DATABASE_OPTIONS}
                  onChange={setEngine}
                  heading="Development database"
                  icon={DatabaseIcon}
                  disabled={busy || mode !== "development"}
                  labelledBy="new-project-db-engine-label"
                />
              </div>
            </div>

            <Callout className="-mt-2">
              {mode === "development" ? (
                <>
                  Created on the shared development server and written to the project&apos;s{" "}
                  <Code>.env</Code> as <Code>DATABASE_URL</Code>.
                </>
              ) : (
                <>
                  A database on the shared server comes with development projects only; this
                  project starts without <Code>DATABASE_URL</Code>.
                </>
              )}
            </Callout>

            {database && (
              <div className="flex flex-col gap-1.5">
                <label htmlFor="new-project-db-name" className={LABEL}>
                  Database name
                </label>
                <input
                  id="new-project-db-name"
                  value={dbName}
                  onChange={(e) => {
                    setDbNameTouched(true);
                    setDbName(
                      e.target.value
                        .toLowerCase()
                        .replace(/[\s-]+/g, "_")
                        .replace(/[^a-z0-9_]/g, "")
                        .slice(0, 63),
                    );
                  }}
                  placeholder="my_project"
                  spellCheck={false}
                  autoComplete="off"
                  maxLength={63}
                  disabled={busy}
                  aria-invalid={!dbNameValid}
                  className={cn(FIELD, "fd-mono placeholder:text-(--fd-text-disabled)")}
                />
                <p className={cn(HELPER, !dbNameValid && dbName && "text-destructive")}>
                  Lower-case letters, digits and underscores, starting with a letter.
                </p>
              </div>
            )}

            <div role="separator" className="h-px bg-(--fd-border-subtle)" />

            <OptionTabs
              value={source}
              onChange={(value) => {
                setSource(value);
                // The name belongs to whichever source produced it, so an
                // untouched one is re-derived by the effect above rather than
                // carried over. A typed one is kept, made fit to name a
                // repository if needed.
                if (value === "new") setName((current) => suggestRepoName(current));
                setError(null);
              }}
              label="Source code"
              aside="Where should the workspace start from?"
              options={SOURCES}
              disabled={busy}
            >

              <OptionPanel value="github">
                {needsToken ? (
                  <NoToken />
                ) : (
                  <>
                    <div className="flex flex-col gap-1.5">
                      <div className="flex items-center justify-between gap-2.5">
                        <span id="new-project-repo-label" className={LABEL}>
                          Repository
                        </span>
                        {account && (
                          <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-(--fd-text-muted)">
                            <GithubMark className="size-3 shrink-0" />
                            <span className="truncate">
                              {account.login} · {repos?.length ?? 0} repos
                            </span>
                          </span>
                        )}
                      </div>
                      <RepoPicker
                        repos={repos}
                        value={picked}
                        onChange={(repo) => setPicked(repo)}
                        disabled={busy}
                        error={reposError}
                        labelledBy="new-project-repo-label"
                      />
                      {reposError && (
                        <p role="alert" className="text-destructive text-[11.5px]">
                          {reposError}
                        </p>
                      )}
                    </div>

                    <div className="flex flex-col gap-1.5">
                      <span
                        id="new-project-gh-branch-label"
                        className={cn(LABEL, !picked && "text-(--fd-text-faint)")}
                      >
                        Branch
                      </span>
                      <BranchPicker
                        branches={ghBranches}
                        value={ghBranch}
                        onChange={setGhBranch}
                        disabled={busy || !picked}
                        loading={ghBranchesLoading}
                        placeholder="Select a repository first"
                        labelledBy="new-project-gh-branch-label"
                      />
                    </div>
                  </>
                )}
              </OptionPanel>

              <OptionPanel value="custom">
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="new-project-url" className={LABEL}>
                    Git URL
                  </label>
                  <input
                    id="new-project-url"
                    value={repoUrl}
                    onChange={(e) => setRepoUrl(e.target.value)}
                    placeholder="https://gitlab.example.com/team/repo.git"
                    spellCheck={false}
                    autoComplete="off"
                    disabled={busy}
                    className={cn(FIELD, "fd-mono text-[11.5px] placeholder:text-(--fd-text-disabled)")}
                  />
                  {checking ? (
                    <p className={cn(HELPER, "flex items-center gap-1.5")}>
                      <Loader2Icon className="size-3 animate-spin" />
                      Reading the repository&apos;s branches…
                    </p>
                  ) : refsError ? (
                    <p role="alert" className="text-destructive text-[11.5px]">
                      {refsError}
                    </p>
                  ) : (
                    <p className={HELPER}>HTTPS or SSH, from any host the server can reach.</p>
                  )}
                </div>

                <div className="flex flex-col gap-1.5">
                  <span
                    id="new-project-branch-label"
                    className={cn(LABEL, branches.length === 0 && "text-(--fd-text-faint)")}
                  >
                    Branch
                  </span>
                  <BranchPicker
                    branches={branches}
                    value={branch}
                    onChange={setBranch}
                    disabled={busy}
                    loading={checking}
                    placeholder="Paste a Git URL first"
                    labelledBy="new-project-branch-label"
                  />
                </div>
              </OptionPanel>

              <OptionPanel value="new">
                <Callout icon={PlusIcon} accent className="p-3">
                  An empty repository named after the project is started in the workspace, on{" "}
                  <Code>main</Code> with one commit. Nothing is created on{" "}
                  <span className="text-(--fd-text-label)">{account?.login ?? "GitHub"}</span> until
                  you add a remote and push.
                </Callout>
              </OptionPanel>
            </OptionTabs>

            {error && (
              <p role="alert" className="text-destructive text-[11.5px]">
                {error}
              </p>
            )}
    </FormDialog>
  );
}

/**
 * What the GitHub tab shows with no token behind it.
 *
 * A route to the fix rather than an error: the tab cannot work, and the thing
 * that would make it work is two clicks away.
 */
function NoToken() {
  return (
    <div className="rounded-lg border border-dashed p-6 text-center">
      <GithubMark className="text-muted-foreground mx-auto size-4" />
      <p className="mt-3 text-sm font-medium">No GitHub token</p>
      <p className="text-muted-foreground mx-auto mt-1 max-w-sm text-sm">
        Add one in Settings to list the repositories you can see and clone the private ones. Until
        then, the other two tabs work without it.
      </p>
      {/* `nativeButton={false}` because this renders an <a>: Base UI assumes a
          native <button> otherwise and the anchor loses button semantics. */}
      <Button
        variant="outline"
        nativeButton={false}
        render={<TransitionLink href="/setting/api" />}
        className="mt-4"
      >
        Open API settings
      </Button>
    </div>
  );
}

/**
 * The repository, chosen from the account's own list.
 *
 * Searchable because an account with two hundred repositories is not navigable
 * any other way, and filtered here rather than at GitHub: the list is already
 * in the browser, and a request per keystroke would be slower than a substring
 * match over three hundred strings.
 */
function RepoPicker({
  repos,
  value,
  onChange,
  disabled,
  error,
  labelledBy,
}: {
  /** Null until the list arrives. */
  repos: GithubRepo[] | null;
  value: GithubRepo | null;
  onChange: (repo: GithubRepo) => void;
  disabled?: boolean;
  error: string | null;
  labelledBy: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");

  const matches = React.useMemo(() => {
    const list = repos ?? [];
    const needle = query.trim().toLowerCase();
    const hit = needle
      ? list.filter((repo) => repo.fullName.toLowerCase().includes(needle))
      : list;
    // Capped for the DOM's sake, not the search's: the filter runs over every
    // repository, and only the rendering is limited.
    return hit.slice(0, 60);
  }, [repos, query]);

  const loading = repos === null && !error;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <PopoverTrigger
        render={
          <button
            type="button"
            role="combobox"
            aria-expanded={open}
            aria-labelledby={labelledBy}
            disabled={disabled || loading || !repos?.length}
            className={cn(FIELD, "disabled:opacity-70")}
          />
        }
      >
        <SearchIcon className="size-3.5 shrink-0 text-(--fd-text-muted)" />
        <span className={cn("min-w-0 grow truncate", !value && "text-(--fd-text-faint)")}>
          {value?.fullName ??
            (loading
              ? <Skeleton className="h-3 w-40" />
              : error
                ? "Could not read your repositories"
                : repos?.length
                  ? "Search repositories…"
                  : "No repositories to choose from")}
        </span>
        {loading ? (
          <Loader2Icon className="size-3.5 shrink-0 animate-spin text-(--fd-icon-dim)" />
        ) : (
          <ChevronsUpDownIcon className="size-3.5 shrink-0 text-(--fd-icon-dim)" />
        )}
      </PopoverTrigger>

      <PopoverContent className="w-(--anchor-width) p-0">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search your repositories…"
            value={query}
            onValueChange={setQuery}
          />
          <CommandList className="max-h-64">
            <CommandEmpty>No repository matches that.</CommandEmpty>
            <CommandGroup>
              {matches.map((repo) => (
                <CommandItem
                  key={repo.fullName}
                  value={repo.fullName}
                  data-checked={repo.fullName === value?.fullName}
                  onSelect={() => {
                    onChange(repo);
                    setOpen(false);
                  }}
                >
                  <span className="min-w-0 flex-1 truncate">{repo.fullName}</span>
                  {repo.private && <LockIcon className="text-muted-foreground size-3 shrink-0" />}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/**
 * The branch, chosen from what the repository reported.
 *
 * The same combobox the model picker uses: a repository with three hundred
 * branches is not navigable any other way. Before a repository has been read
 * there is nothing to choose from, and the field says which of the two reasons
 * it is empty for.
 */
export function BranchPicker({
  branches,
  value,
  onChange,
  disabled,
  loading,
  placeholder,
  labelledBy,
}: {
  branches: string[];
  value: string;
  onChange: (branch: string) => void;
  disabled?: boolean;
  loading?: boolean;
  /** What to say when there is nothing to choose from yet. */
  placeholder: string;
  labelledBy: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");

  const matches = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    const hit = needle ? branches.filter((b) => b.toLowerCase().includes(needle)) : branches;
    return hit.slice(0, 60);
  }, [branches, query]);

  const empty = branches.length === 0;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <PopoverTrigger
        render={
          <button
            type="button"
            role="combobox"
            aria-expanded={open}
            aria-labelledby={labelledBy}
            disabled={disabled || empty}
            className={cn(
              FIELD,
              "group disabled:border-dashed disabled:border-(--fd-border-disabled) disabled:bg-(--fd-field-muted)",
            )}
          />
        }
      >
        <GitBranchIcon className="size-3.5 shrink-0 text-(--fd-text-muted) group-disabled:text-(--fd-icon-disabled)" />
        <span
          className={cn(
            "min-w-0 grow truncate group-disabled:text-(--fd-text-disabled)",
            !value && "text-(--fd-text-faint)",
          )}
        >
          {value || (loading ? <Skeleton className="h-3 w-28" /> : empty ? placeholder : "Choose a branch")}
        </span>
        {loading ? (
          <Loader2Icon className="size-3.5 shrink-0 animate-spin text-(--fd-icon-dim)" />
        ) : (
          <ChevronsUpDownIcon className="size-3.5 shrink-0 text-(--fd-icon-dim) group-disabled:text-(--fd-icon-disabled)" />
        )}
      </PopoverTrigger>

      <PopoverContent className="w-(--anchor-width) p-0">
        <Command shouldFilter={false}>
          <CommandInput placeholder="Search branches…" value={query} onValueChange={setQuery} />
          <CommandList className="max-h-56">
            <CommandEmpty>No branch matches that.</CommandEmpty>
            <CommandGroup>
              {matches.map((name) => (
                <CommandItem
                  key={name}
                  value={name}
                  data-checked={name === value}
                  onSelect={() => {
                    onChange(name);
                    setOpen(false);
                  }}
                >
                  <span className="min-w-0 flex-1 truncate">{name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
