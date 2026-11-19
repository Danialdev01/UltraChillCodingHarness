"use client";

import * as React from "react";
import {
  ChevronsUpDownIcon,
  DatabaseIcon,
  FolderPlusIcon,
  GitBranchIcon,
  GitForkIcon,
  LinkIcon,
  LockIcon,
  Loader2Icon,
  PlusIcon,
  SearchIcon,
  UsersIcon,
} from "lucide-react";
import {
  DATABASE_ENGINE_LABELS,
  DEV_DATABASE_NAME,
  GIT_PROVIDER_LABELS,
  PROJECT_MODE_LABELS,
  PROJECT_MODES,
  suggestDevDatabaseName,
  PROJECT_KEY_MAX,
  PROJECT_KEY_MIN,
} from "@ucch/protocol/plain";
import type {
  DevDatabaseName,
  GitAccount,
  GitProvider,
  ProjectMode,
  DatabaseEngine,
  ProjectDatabase,
} from "@ucch/protocol";

import { GithubMark } from "@/components/github-mark";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
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
  FOCUS,
  FormDialog,
  FormDialogFooter,
  HELPER,
  LABEL,
  OptionPanel,
  OptionTabs,
  PopoverSelect,
  Segmented,
  TEXTAREA,
} from "@/components/form-dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { createProject } from "@/lib/create-project";
import { setupProjectKey } from "@/lib/env-api";
import { unlockProject } from "@/lib/project-key-store";
import { newKeyProblem } from "@/lib/project-key";
import {
  NoGithubToken,
  createGithubRepo,
  fetchBranches,
  fetchGitAccounts,
  fetchGitRepos,
  fetchGithubOwners,
  isValidRepoName,
  suggestRepoName,
  type GitRepo,
  type GitReposError,
  type GithubOwner,
  type GithubRepo,
} from "@/lib/github-api";
import { useToast } from "@/lib/realtime";
import { deriveProjectName, looksLikeRepoUrl } from "@/lib/repo-url";
import { cn } from "@/lib/utils";
import { TransitionLink, useTransitionRouter } from "@/lib/view-transitions";
import { useProjectHref } from "@/lib/workspace-context";

/** Where the code for a new project comes from. */
type Source = "git" | "create" | "empty";

const SOURCES = [
  { value: "git", title: "Git", hint: "Import a repo" },
  { value: "create", title: "New Repo", hint: "Create on a host" },
  { value: "empty", title: "Empty", hint: "No git remote" },
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

type Visibility = "private" | "public";

const VISIBILITY_OPTIONS = [
  { value: "private", label: "Private" },
  { value: "public", label: "Public" },
] as const;

/** The combined list's identity for a repository: two accounts can share a full name. */
const repoKey = (repo: GitRepo) => `${repo.provider}:${repo.fullName}`;

/**
 * Starting a project, from one of three places.
 *
 * What the project is comes first -- its name, its mode and, for a development
 * project, the database it gets on the shared dev server -- and where its code
 * comes from below that.
 *
 * - **Git** imports an existing repository: chosen from every connected
 *   account's repositories in one list, or pasted as a URL from anywhere.
 * - **New Repo** creates a repository on a connected host first, then clones
 *   it, so the project has a remote to push to from its first session.
 * - **Empty** starts a local repository with no remote at all.
 *
 * All three converge on one command -- `project.create` -- and differ only in
 * whether a `repoUrl` is on it. Whether sessions branch is a project setting
 * sent with it, and changeable later in Project Settings.
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
  const [source, setSource] = React.useState<Source>("git");
  const [stage, setStage] = React.useState<"idle" | "repo" | "creating" | "cloning">("idle");
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
  /** Optional; encrypts the project's environment variables. Set up once the project exists. */
  const [projectKey, setProjectKey] = React.useState("");
  const [projectKeyConfirm, setProjectKeyConfirm] = React.useState("");
  /** Each session on a `ucch/{hash}` branch of its own; off, they commit to the base branch. */
  const [sessionBranches, setSessionBranches] = React.useState(true);

  // -- The Git tab: every connected account's repositories ---------------------
  const [gitAccounts, setGitAccounts] = React.useState<
    { provider: GitProvider; login: string; name: string | null }[]
  >([]);
  /** Null until the list arrives. */
  const [repos, setRepos] = React.useState<GitRepo[] | null>(null);
  /** The whole request failing; one account failing is in `accountErrors`. */
  const [reposError, setReposError] = React.useState<string | null>(null);
  const [accountErrors, setAccountErrors] = React.useState<GitReposError[]>([]);
  /** Choose from the accounts' list, or paste a URL from anywhere. */
  const [gitMode, setGitMode] = React.useState<"list" | "url">("list");
  const [picked, setPicked] = React.useState<GitRepo | null>(null);
  const [pickedBranches, setPickedBranches] = React.useState<string[]>([]);
  const [pickedBranch, setPickedBranch] = React.useState("");
  const [pickedBranchesLoading, setPickedBranchesLoading] = React.useState(false);

  // -- The Git tab, by URL -----------------------------------------------------
  const [repoUrl, setRepoUrl] = React.useState("");
  const [branch, setBranch] = React.useState("");
  const [branches, setBranches] = React.useState<string[]>([]);
  const [checking, setChecking] = React.useState(false);
  const [refsError, setRefsError] = React.useState<string | null>(null);

  // -- The New Repo tab --------------------------------------------------------
  /** Every host, integrated or not, connected or not. Null until read. */
  const [hosts, setHosts] = React.useState<GitAccount[] | null>(null);
  const [hostsError, setHostsError] = React.useState<string | null>(null);
  const [host, setHost] = React.useState<GitProvider>("github");
  const [owners, setOwners] = React.useState<GithubOwner[] | null>(null);
  const [ownersError, setOwnersError] = React.useState<string | null>(null);
  const [owner, setOwner] = React.useState("");
  const [visibility, setVisibility] = React.useState<Visibility>("private");
  const [description, setDescription] = React.useState("");
  /**
   * The repository this dialog already created, so a retry after the clone
   * failed reuses it instead of being refused for a name that is now taken.
   */
  const createdRepo = React.useRef<GithubRepo | null>(null);

  // A fresh dialog every time: a half-filled form from last week is not a
  // head start. The repository lists are dropped with it, so a repository
  // created since the last visit is offered on the next one.
  React.useEffect(() => {
    if (open) return;
    setSource("git");
    setStage("idle");
    setError(null);
    setName("");
    setNameTouched(false);
    setMode("development");
    setEngine("");
    setDbName("");
    setDbNameTouched(false);
    setProjectKey("");
    setProjectKeyConfirm("");
    setSessionBranches(true);
    setGitAccounts([]);
    setRepos(null);
    setReposError(null);
    setAccountErrors([]);
    setGitMode("list");
    setPicked(null);
    setPickedBranches([]);
    setPickedBranch("");
    setRepoUrl("");
    setBranch("");
    setBranches([]);
    setRefsError(null);
    setHosts(null);
    setHostsError(null);
    setHost("github");
    setOwners(null);
    setOwnersError(null);
    setOwner("");
    setVisibility("private");
    setDescription("");
    createdRepo.current = null;
  }, [open]);

  /**
   * Reads every connected account's repositories, once, when the Git tab is
   * first looked at -- it is several calls to each host, and somebody who came
   * to start an empty project should not pay for them.
   */
  React.useEffect(() => {
    if (!open || source !== "git" || repos !== null || reposError) return;

    let cancelled = false;
    void fetchGitRepos()
      .then(({ accounts, repos: list, errors }) => {
        if (cancelled) return;
        setGitAccounts(accounts);
        setRepos(list);
        setAccountErrors(errors);
        // Nothing connected: the list has nothing to offer, the URL does.
        if (accounts.length === 0 && errors.length === 0) setGitMode("url");
      })
      .catch((e: unknown) => {
        if (!cancelled) setReposError(e instanceof Error ? e.message : String(e));
      });

    return () => {
      cancelled = true;
    };
  }, [open, source, repos, reposError]);

  /** Reads which hosts exist and are connected, when the New Repo tab is first looked at. */
  React.useEffect(() => {
    if (!open || source !== "create" || hosts !== null || hostsError) return;

    let cancelled = false;
    void fetchGitAccounts()
      .then((list) => {
        if (cancelled) return;
        setHosts(list);
        // The first host that can actually take a repository.
        const usable = list.find((h) => h.available && h.connected);
        if (usable) setHost(usable.provider);
      })
      .catch((e: unknown) => {
        if (!cancelled) setHostsError(e instanceof Error ? e.message : String(e));
      });

    return () => {
      cancelled = true;
    };
  }, [open, source, hosts, hostsError]);

  const hostAccount = hosts?.find((h) => h.provider === host) ?? null;
  const hostUsable = Boolean(hostAccount?.available && hostAccount.connected);

  /** Reads where the chosen host can create a repository: the account, then its organisations. */
  React.useEffect(() => {
    if (!open || source !== "create" || !hostUsable || host !== "github" || owners !== null || ownersError) return;

    let cancelled = false;
    void fetchGithubOwners()
      .then((list) => {
        if (cancelled) return;
        setOwners(list);
        setOwner((current) => current || list[0]?.login || "");
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setOwnersError(
          e instanceof NoGithubToken ? "No GitHub token is configured." : e instanceof Error ? e.message : String(e),
        );
      });

    return () => {
      cancelled = true;
    };
  }, [open, source, hostUsable, host, owners, ownersError]);

  /**
   * Reads the chosen repository's branches.
   *
   * The repository already told us its default, so that is shown immediately
   * and the full list replaces it when it arrives -- the common case is
   * choosing the default, and it should not have to wait for a round trip.
   */
  React.useEffect(() => {
    if (!picked) {
      setPickedBranches([]);
      setPickedBranch("");
      return;
    }

    setPickedBranch(picked.defaultBranch);
    setPickedBranches([picked.defaultBranch]);
    // GitHub's API is the only branch reader with a token behind it so far.
    if (picked.provider !== "github") return;
    setPickedBranchesLoading(true);

    let cancelled = false;
    void fetchBranches(picked.owner, picked.name)
      .then(({ branches: list, defaultBranch }) => {
        if (cancelled) return;
        setPickedBranches(list);
        // The repository's own default wins over the list's first entry.
        setPickedBranch(defaultBranch ?? picked.defaultBranch);
      })
      .catch((e: unknown) => {
        // The default from the repository is still selected and still clones,
        // so this is a narrower picker rather than a broken tab.
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setPickedBranchesLoading(false);
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

  // The name follows whichever repository the Git tab names, until it is
  // edited and then it is yours.
  React.useEffect(() => {
    if (nameTouched || source !== "git") return;
    setName(gitMode === "list" ? picked?.name ?? "" : deriveProjectName(repoUrl));
  }, [source, gitMode, picked, repoUrl, nameTouched]);

  // The database is named after the project until somebody names it.
  React.useEffect(() => {
    if (!dbNameTouched) setDbName(suggestDevDatabaseName(name));
  }, [name, dbNameTouched]);

  /** The database to ask for, or null for none -- also null outside development. */
  const database = mode === "development" && engine ? { engine, name: dbName } : null;
  const dbNameValid = !database || DEV_DATABASE_NAME.test(dbName);

  const busy = stage !== "idle";
  /** The tabs whose name is also a repository's, and so must be a valid one. */
  const nameIsRepoName = source === "create" || source === "empty";

  /**
   * What this tab would send, or null when it is not ready to send anything.
   * New Repo's `repoUrl` is not known until the repository exists, so it is
   * added at submit.
   */
  const command = React.useMemo(():
    | {
        repoUrl?: string;
        name: string;
        branch?: string;
        mode: ProjectMode;
        database?: ProjectDatabase;
        sessionBranches: boolean;
      }
    | null => {
    if (!dbNameValid) return null;
    const what = { mode, sessionBranches, ...(database ? { database } : {}) };
    if (source === "git" && gitMode === "list") {
      if (!picked || !name.trim()) return null;
      return { repoUrl: picked.cloneUrl, name: name.trim(), branch: pickedBranch || picked.defaultBranch, ...what };
    }
    if (source === "git") {
      const url = repoUrl.trim();
      if (!looksLikeRepoUrl(url) || !name.trim()) return null;
      return { repoUrl: url, name: name.trim(), ...(branch ? { branch } : {}), ...what };
    }
    if (source === "create" && (!hostUsable || !owner)) return null;
    // No `repoUrl` at all: the server reads its absence as "start one".
    if (!isValidRepoName(name)) return null;
    return { name: name.trim(), ...what };
    // `database` is rebuilt each render; its parts are the real dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, gitMode, picked, name, pickedBranch, repoUrl, branch, mode, engine, dbName, dbNameValid, sessionBranches, hostUsable, owner]);

  // Blank is fine: the key is optional. Typed, it must be one that can be set up.
  const projectKeyError = projectKey || projectKeyConfirm ? newKeyProblem(projectKey, projectKeyConfirm) : null;

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !workspaceId || !command || projectKeyError) return;

    setError(null);

    try {
      let toSend = command;
      if (source === "create") {
        setStage("repo");
        // Created with a README so it has a default branch to clone.
        const previous = createdRepo.current;
        const repo =
          previous && previous.owner.toLowerCase() === owner.toLowerCase() && previous.name === command.name
            ? previous
            : await createGithubRepo({
                owner,
                name: command.name,
                private: visibility === "private",
                ...(description.trim() ? { description: description.trim() } : {}),
                autoInit: true,
              });
        createdRepo.current = repo;
        toSend = { ...command, repoUrl: repo.cloneUrl, branch: repo.defaultBranch };
      }

      const created = await createProject({ workspaceId, ...toSend }, setStage);

      // The project is fine without its database, so it opens either way and
      // the reason travels with it.
      if (created.databaseError) {
        toast({ title: "No development database", description: created.databaseError, tone: "error" });
      }
      // Not part of `project.create`: commands are kept as events, and the
      // key must never be written down. Set up once the project's files exist.
      if (projectKey) {
        try {
          await setupProjectKey(created.hash, projectKey);
          unlockProject(created.hash, projectKey);
        } catch (e) {
          toast({
            title: "Project key not set up",
            description: `${e instanceof Error ? e.message : String(e)} Set one up under Manage → Project key.`,
            tone: "error",
          });
        }
      }

      onOpenChange(false);
      // The sidebar hears of the new project as `resource.changed{projects}`.
      router.push(hrefOf(created.hash));
    } catch (e) {
      setError(
        e instanceof NoGithubToken
          ? "No GitHub token is configured. Add one in Settings → API."
          : e instanceof Error
            ? e.message
            : String(e),
      );
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
      onSubmit={submit}
      footer={
        <FormDialogFooter hint="Isolated workspace" hintIcon={LockIcon} busy={busy} disabled={!command || Boolean(projectKeyError)}>
          {stage === "repo"
            ? "Creating repository…"
            : stage === "cloning"
              ? source === "empty"
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
                {source === "create" && owner && (
                  <span className="fd-mono flex shrink-0 items-center border-r border-(--fd-prefix-border) bg-(--fd-prefix) px-2.5 text-[11.5px] text-(--fd-icon-dim) select-none">
                    {owner} /
                  </span>
                )}
                <input
                  id="new-project-name"
                  value={name}
                  onChange={(e) => {
                    setNameTouched(true);
                    // A new repository's name is its directory's name, so it is
                    // corrected as it is typed, as GitHub does.
                    setName(nameIsRepoName ? suggestRepoName(e.target.value) : e.target.value);
                  }}
                  placeholder="my-project"
                  spellCheck={false}
                  autoComplete="off"
                  maxLength={100}
                  disabled={busy}
                  className="fd-mono min-w-0 grow bg-transparent px-2.5 text-[12.5px] text-(--fd-text) outline-none placeholder:text-(--fd-text-disabled) focus-visible:outline-none"
                />
              </div>
              {source !== "git" && (
                <p className={HELPER}>
                  {source === "create"
                    ? "Letters, numbers, dots, dashes and underscores. It also names the repository created for it."
                    : "Letters, numbers, dots, dashes and underscores. It also names the local repository."}
                </p>
              )}
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

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <label htmlFor="new-project-key" className={LABEL}>
                  Project key <span className="text-(--fd-text-disabled)">· optional, recommended</span>
                </label>
                <input
                  id="new-project-key"
                  type="password"
                  value={projectKey}
                  onChange={(e) => setProjectKey(e.target.value)}
                  autoComplete="new-password"
                  data-1p-ignore
                  data-lpignore="true"
                  maxLength={PROJECT_KEY_MAX}
                  disabled={busy}
                  aria-invalid={Boolean(projectKeyError && projectKey.length < PROJECT_KEY_MIN && projectKey)}
                  className={FIELD}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="new-project-key-confirm" className={LABEL}>
                  Confirm the key
                </label>
                <input
                  id="new-project-key-confirm"
                  type="password"
                  value={projectKeyConfirm}
                  onChange={(e) => setProjectKeyConfirm(e.target.value)}
                  autoComplete="new-password"
                  data-1p-ignore
                  data-lpignore="true"
                  maxLength={PROJECT_KEY_MAX}
                  disabled={busy || !projectKey}
                  className={FIELD}
                />
              </div>
              {projectKeyError && projectKeyConfirm && (
                <p className={cn(HELPER, "sm:col-span-2 text-destructive")}>{projectKeyError}</p>
              )}
            </div>

            <div role="separator" className="h-px bg-(--fd-border-subtle)" />

            <OptionTabs
              value={source}
              onChange={(value) => {
                setSource(value);
                // An untouched name is re-derived by the effect above rather
                // than carried over; a typed one is kept, made fit to name a
                // repository where the tab needs one.
                if (value === "create" || value === "empty") {
                  setName((current) => suggestRepoName(current));
                } else if (!nameTouched) {
                  setName("");
                }
                setError(null);
              }}
              label="Source code"
              aside="Where should the workspace start from?"
              options={SOURCES}
              disabled={busy}
            >

              <OptionPanel value="git">
                {gitMode === "list" ? (
                  <>
                    <div className="flex flex-col gap-1.5">
                      <div className="flex items-center justify-between gap-2.5">
                        <span id="new-project-repo-label" className={LABEL}>
                          Repository
                        </span>
                        {gitAccounts.length > 0 && (
                          <span className="flex min-w-0 items-center gap-2 text-[11px] text-(--fd-text-muted)">
                            {gitAccounts.map((a) => (
                              <span key={`${a.provider}:${a.login}`} className="flex min-w-0 items-center gap-1">
                                <ProviderMark provider={a.provider} className="size-3 shrink-0" />
                                <span className="truncate">{a.login}</span>
                              </span>
                            ))}
                            <span className="shrink-0">· {repos?.length ?? 0} repos</span>
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
                      {accountErrors.map((e) => (
                        <p key={e.provider} role="alert" className="text-destructive text-[11.5px]">
                          {GIT_PROVIDER_LABELS[e.provider]}: {e.error}
                        </p>
                      ))}
                    </div>

                    <div className="flex flex-col gap-1.5">
                      <span
                        id="new-project-picked-branch-label"
                        className={cn(LABEL, !picked && "text-(--fd-text-faint)")}
                      >
                        Branch
                      </span>
                      <BranchPicker
                        branches={pickedBranches}
                        value={pickedBranch}
                        onChange={setPickedBranch}
                        disabled={busy || !picked}
                        loading={pickedBranchesLoading}
                        placeholder="Select a repository first"
                        labelledBy="new-project-picked-branch-label"
                      />
                    </div>
                  </>
                ) : (
                  <>
                    {repos !== null && gitAccounts.length === 0 && accountErrors.length === 0 && (
                      <NoGitAccount>
                        Connect GitHub to pick from your repositories (GitLab and Gitea are
                        coming). A URL from any host the server can reach works without one.
                      </NoGitAccount>
                    )}
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
                  </>
                )}

                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setGitMode((m) => (m === "list" ? "url" : "list"));
                    setError(null);
                  }}
                  className={cn(
                    "flex w-fit items-center gap-1.5 rounded-[4px] text-[11.5px] text-(--fd-text-muted) hover:text-(--fd-text) disabled:opacity-60",
                    FOCUS,
                  )}
                >
                  {gitMode === "list" ? (
                    <>
                      <LinkIcon className="size-3" />
                      Use a Git URL instead
                    </>
                  ) : (
                    <>
                      <SearchIcon className="size-3" />
                      Choose from your connected accounts
                    </>
                  )}
                </button>
              </OptionPanel>

              <OptionPanel value="create">
                <div className="flex flex-col gap-1.5">
                  <span id="new-project-host-label" className={LABEL}>
                    Create on
                  </span>
                  <HostChoice
                    hosts={hosts}
                    value={host}
                    onChange={(next) => {
                      setHost(next);
                      setError(null);
                    }}
                    disabled={busy}
                    labelledBy="new-project-host-label"
                  />
                  {hostsError && (
                    <p role="alert" className="text-destructive text-[11.5px]">
                      {hostsError}
                    </p>
                  )}
                </div>

                {hosts !== null && !hostUsable ? (
                  <NoGitAccount>
                    {hostAccount?.available === false
                      ? `${GIT_PROVIDER_LABELS[host]} is not integrated yet.`
                      : `Connect ${GIT_PROVIDER_LABELS[host]} in Settings to create repositories on it.`}{" "}
                    The Empty tab starts a project without a remote.
                  </NoGitAccount>
                ) : (
                  <>
                    <div className="grid gap-3 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
                      <div className="flex flex-col gap-1.5">
                        <span id="new-project-owner-label" className={LABEL}>
                          Owner
                        </span>
                        {owners === null && !ownersError ? (
                          <Skeleton className="h-[34px] w-full rounded-[8px]" />
                        ) : (
                          <PopoverSelect
                            value={owner}
                            options={(owners ?? []).map((o) => ({
                              value: o.login,
                              label: o.login,
                              hint: o.kind === "org" ? "Organisation" : "You",
                            }))}
                            onChange={setOwner}
                            heading="Create the repository under"
                            icon={UsersIcon}
                            placeholder="Choose an owner"
                            disabled={busy || !owners?.length}
                            labelledBy="new-project-owner-label"
                            searchable={(owners?.length ?? 0) > 6}
                          />
                        )}
                        {ownersError && (
                          <p role="alert" className="text-destructive text-[11.5px]">
                            {ownersError}
                          </p>
                        )}
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <span id="new-project-visibility-label" className={LABEL}>
                          Visibility
                        </span>
                        <Segmented
                          options={VISIBILITY_OPTIONS}
                          value={visibility}
                          onChange={setVisibility}
                          disabled={busy}
                          labelledBy="new-project-visibility-label"
                        />
                      </div>
                    </div>

                    <div className="flex flex-col gap-1.5">
                      <label htmlFor="new-project-description" className={LABEL}>
                        Description <span className="text-(--fd-text-disabled)">· optional</span>
                      </label>
                      <textarea
                        id="new-project-description"
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                        maxLength={350}
                        rows={2}
                        disabled={busy}
                        className={cn(TEXTAREA, "min-h-14 placeholder:text-(--fd-text-disabled)")}
                        placeholder="What this repository is for"
                      />
                    </div>

                    <Callout icon={GitForkIcon} accent className="p-3">
                      Created as{" "}
                      <Code>
                        {owner || "owner"}/{name || "name"}
                      </Code>{" "}
                      with a README on {GIT_PROVIDER_LABELS[host]}&apos;s default branch, then
                      cloned into the workspace with its remote already set.
                    </Callout>
                  </>
                )}
              </OptionPanel>

              <OptionPanel value="empty">
                <Callout icon={PlusIcon} accent className="p-3">
                  An empty repository named after the project is started in the workspace, on{" "}
                  <Code>main</Code> with one commit, and no remote. Add one and push whenever
                  you&apos;re ready.
                </Callout>
              </OptionPanel>
            </OptionTabs>

            <div className="flex items-center justify-between gap-4 rounded-[8px] border border-(--fd-border-subtle) bg-(--fd-field-muted) px-3 py-2.5">
              <div className="flex min-w-0 flex-col gap-1">
                <span id="new-project-session-branches-label" className={cn(LABEL, "flex items-center gap-1.5")}>
                  <GitBranchIcon className="size-3.5 text-(--fd-icon-dim)" />
                  New branch for every session
                </span>
                {!sessionBranches && (
                  <p className={HELPER}>
                    Every session commits straight to the base branch in the project&apos;s
                    checkout. Changeable later in Project Settings.
                  </p>
                )}
              </div>
              <Switch
                checked={sessionBranches}
                onCheckedChange={setSessionBranches}
                disabled={busy}
                aria-labelledby="new-project-session-branches-label"
              />
            </div>

            {error && (
              <p role="alert" className="text-destructive text-[11.5px]">
                {error}
              </p>
            )}
    </FormDialog>
  );
}

/** A git host's mark. GitHub has its own glyph; the others a generic one until they are integrated. */
function ProviderMark({ provider, className }: { provider: GitProvider; className?: string }) {
  if (provider === "github") return <GithubMark className={className} />;
  return <GitBranchIcon className={className} />;
}

/**
 * The hosts a repository can be created on, side by side.
 *
 * Every host is shown, so it is clear what is coming: one not integrated yet
 * says so, and one not connected says where to connect it.
 */
function HostChoice({
  hosts,
  value,
  onChange,
  disabled,
  labelledBy,
}: {
  /** Null until read. */
  hosts: GitAccount[] | null;
  value: GitProvider;
  onChange: (provider: GitProvider) => void;
  disabled?: boolean;
  labelledBy: string;
}) {
  if (hosts === null) {
    return (
      <div className="grid grid-cols-3 gap-1.5">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-[46px] rounded-[8px]" />
        ))}
      </div>
    );
  }

  return (
    <div role="radiogroup" aria-labelledby={labelledBy} className="grid grid-cols-3 gap-1.5">
      {hosts.map((h) => {
        const checked = h.provider === value;
        const status = !h.available ? "Coming soon" : h.connected ? h.login ?? "Connected" : "Not connected";
        return (
          <button
            key={h.provider}
            type="button"
            role="radio"
            aria-checked={checked}
            disabled={disabled || !h.available}
            onClick={() => onChange(h.provider)}
            className={cn(
              "flex min-w-0 flex-col items-start gap-[3px] rounded-[8px] border border-(--fd-border) bg-(--fd-field) px-2.5 py-2 text-left transition-[border-color,box-shadow,background-color] disabled:cursor-not-allowed disabled:border-dashed disabled:opacity-60",
              FOCUS,
              checked
                ? "border-(--fd-accent) bg-(--fd-accent-tint) ring-[3px] ring-(--fd-ring-soft)"
                : "enabled:hover:border-(--fd-border-hover)",
            )}
          >
            <span className="flex items-center gap-1.5 text-[12px] font-medium text-(--fd-text)">
              <ProviderMark provider={h.provider} className="size-3.5 shrink-0" />
              {GIT_PROVIDER_LABELS[h.provider]}
            </span>
            <span className="max-w-full truncate text-[11px] text-(--fd-text-muted)">{status}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * What a tab shows when it needs an account that is not connected.
 *
 * A route to the fix rather than an error: the thing that would make it work
 * is two clicks away.
 */
function NoGitAccount({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-[8px] border border-dashed border-(--fd-border) px-3 py-2.5">
      <p className="min-w-0 text-[11.5px] leading-[1.55] text-(--fd-text-muted)">{children}</p>
      {/* `nativeButton={false}` because this renders an <a>: Base UI assumes a
          native <button> otherwise and the anchor loses button semantics. */}
      <Button
        variant="outline"
        size="sm"
        nativeButton={false}
        render={<TransitionLink href="/setting/api" />}
        className="shrink-0"
      >
        Settings
      </Button>
    </div>
  );
}

/**
 * The repository, chosen from every connected account's repositories at once.
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
  repos: GitRepo[] | null;
  value: GitRepo | null;
  onChange: (repo: GitRepo) => void;
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
      ? list.filter((repo) => `${repo.fullName} ${repo.provider}`.toLowerCase().includes(needle))
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
        {value ? (
          <ProviderMark provider={value.provider} className="size-3.5 shrink-0 text-(--fd-text-muted)" />
        ) : (
          <SearchIcon className="size-3.5 shrink-0 text-(--fd-text-muted)" />
        )}
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
            placeholder="Search repositories across your accounts…"
            value={query}
            onValueChange={setQuery}
          />
          <CommandList className="max-h-64">
            <CommandEmpty>No repository matches that.</CommandEmpty>
            <CommandGroup>
              {matches.map((repo) => (
                <CommandItem
                  key={repoKey(repo)}
                  value={repoKey(repo)}
                  data-checked={value ? repoKey(repo) === repoKey(value) : false}
                  onSelect={() => {
                    onChange(repo);
                    setOpen(false);
                  }}
                >
                  <ProviderMark provider={repo.provider} className="text-muted-foreground size-3 shrink-0" />
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
  className,
}: {
  branches: string[];
  value: string;
  onChange: (branch: string) => void;
  disabled?: boolean;
  loading?: boolean;
  /** What to say when there is nothing to choose from yet. */
  placeholder: string;
  labelledBy: string;
  /** Extra trigger classes, e.g. a taller field in a roomier dialog. */
  className?: string;
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
              className,
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
