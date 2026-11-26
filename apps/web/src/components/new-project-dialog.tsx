"use client";

import * as React from "react";
import {
  ChevronsUpDownIcon,
  DatabaseIcon,
  FolderPlusIcon,
  GitBranchIcon,
  LinkIcon,
  LockIcon,
  Loader2Icon,
  PlusIcon,
  SearchIcon,
} from "lucide-react";
import {
  DATABASE_ENGINE_LABELS,
  DEV_DATABASE_NAME,
  GIT_PROVIDERS,
  GIT_PROVIDER_LABELS,
  GITHUB_LOGIN_ACCOUNT,
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

import { GitProviderMark as ProviderMark } from "@/components/git-provider-mark";
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
} from "@/components/form-dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { createProject } from "@/lib/create-project";
import {
  FrameworkOptionsFields,
  FrameworkPicker,
  FrameworkSummary,
  useFrameworkServer,
  type FrameworkPick,
} from "@/components/framework-options";
import { FRAMEWORK_LABELS, type FrameworkOptions } from "@ucch/protocol/plain";
import { setupProjectKey } from "@/lib/env-api";
import { unlockProject } from "@/lib/project-key-store";
import { newKeyProblem } from "@/lib/project-key";
import { GIT_PROVIDER_HREF } from "@/lib/git-accounts";
import {
  createRepo,
  fetchBranches,
  fetchGitAccounts,
  fetchGitRepos,
  fetchOwners,
  isValidRepoName,
  suggestRepoName,
  type GitOwner,
  type GitRepo,
  type GitRepoAccount,
  type GitReposError,
  type HostRepo,
} from "@/lib/git-hosts-api";
import { useToast } from "@/lib/realtime";
import { deriveProjectName, looksLikeRepoUrl } from "@/lib/repo-url";
import { cn } from "@/lib/utils";
import { TransitionLink, useTransitionRouter } from "@/lib/view-transitions";
import { useProjectHref } from "@/lib/workspace-context";
import { PasswordInput } from "@/components/ui/password-input"

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

/** An owner, and the connected account that can create under it. */
type RepoOwner = GitOwner & { accountId: string };

/** Two accounts can reach the same owner, so its login alone does not identify it. */
const ownerKey = (owner: RepoOwner) => `${owner.accountId}:${owner.login}`;

/** With several accounts, the account too: logins can repeat across them. */
function ownerHint(owner: RepoOwner, accounts: GitAccount[]) {
  const kind = owner.kind === "org" ? "Organisation" : "You";
  const account = accounts.length > 1 ? accounts.find((a) => a.id === owner.accountId) : undefined;
  return account ? `${kind} · ${account.name}` : kind;
}

/** The combined list's identity for a repository: two accounts can share a full name. */
const repoKey = (repo: GitRepo) => `${repo.accountId}:${repo.fullName}`;

/**
 * Starting a project, from one of three places.
 *
 * Where its code comes from comes first, then what the project is -- its name,
 * its mode and, for a development project, the database it gets on the shared
 * dev server.
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
  /**
   * The framework profile (plan3 §4.1): "other" -- auto-detect, nothing
   * written -- for a repository, nothing chosen yet for a start from empty.
   */
  const [framework, setFramework] = React.useState<FrameworkPick>("other");
  const [frameworkOptions, setFrameworkOptions] = React.useState<FrameworkOptions>({});
  /** Generate the framework's starter project: on for a start from nothing. */
  const [starter, setStarter] = React.useState(true);
  const { server: frameworkServer } = useFrameworkServer();

  // -- The Git tab: every connected account's repositories ---------------------
  const [gitAccounts, setGitAccounts] = React.useState<GitRepoAccount[]>([]);
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
  /** Every connected account. Null until read. */
  const [hosts, setHosts] = React.useState<GitAccount[] | null>(null);
  const [hostsError, setHostsError] = React.useState<string | null>(null);
  const [host, setHost] = React.useState<GitProvider>("github");
  /** Null until read; the chosen host's accounts and their organisations. */
  const [repoOwners, setRepoOwners] = React.useState<RepoOwner[] | null>(null);
  const [ownerErrors, setOwnerErrors] = React.useState<string[]>([]);
  /** An `ownerKey`; the first owner until one is chosen. */
  const [chosenOwner, setChosenOwner] = React.useState("");
  const [visibility, setVisibility] = React.useState<Visibility>("private");
  /**
   * The repository this dialog already created, so a retry after the clone
   * failed reuses it instead of being refused for a name that is now taken.
   */
  const createdRepo = React.useRef<(HostRepo & { accountId: string }) | null>(null);

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
    setFramework("other");
    setFrameworkOptions({});
    setStarter(true);
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
    setRepoOwners(null);
    setOwnerErrors([]);
    setChosenOwner("");
    setVisibility("private");
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
        const usable = list.find((h) => h.connected);
        if (usable) setHost(usable.provider);
      })
      .catch((e: unknown) => {
        if (!cancelled) setHostsError(e instanceof Error ? e.message : String(e));
      });

    return () => {
      cancelled = true;
    };
  }, [open, source, hosts, hostsError]);

  const hostAccounts = hosts?.filter((h) => h.provider === host) ?? [];
  const connectedAccounts = hostAccounts.filter((h) => h.connected);
  const hostUsable = connectedAccounts.length > 0;
  /** A string so the effect below reruns only when the accounts themselves change. */
  const connectedKey = connectedAccounts.map((h) => h.id).join("\n");
  const repoOwner = repoOwners?.find((o) => ownerKey(o) === chosenOwner) ?? repoOwners?.[0] ?? null;

  /** Reads where a repository can be created: each account itself, then its organisations. */
  React.useEffect(() => {
    if (!open || source !== "create" || !connectedKey) return;

    let cancelled = false;
    // One host's owners are not another's.
    setRepoOwners(null);
    setOwnerErrors([]);
    setChosenOwner("");
    const ids = connectedKey.split("\n");
    void Promise.allSettled(ids.map((id) => fetchOwners(id))).then((results) => {
      if (cancelled) return;
      const found: RepoOwner[] = [];
      const errors: string[] = [];
      results.forEach((result, i) => {
        if (result.status === "fulfilled") {
          found.push(...result.value.map((o) => ({ ...o, accountId: ids[i]! })));
        } else {
          errors.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
        }
      });
      setRepoOwners(found);
      setOwnerErrors(errors);
    });

    return () => {
      cancelled = true;
    };
  }, [open, source, connectedKey]);

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
    setPickedBranchesLoading(true);

    let cancelled = false;
    void fetchBranches(picked.accountId, picked.fullName)
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
        gitAccountId?: string;
        name: string;
        branch?: string;
        mode: ProjectMode;
        database?: ProjectDatabase;
        sessionBranches: boolean;
        framework?: { id: Exclude<FrameworkPick, "other" | null>; options: FrameworkOptions; scaffold?: boolean };
      }
    | null => {
    if (!dbNameValid) return null;
    const chosen =
      mode === "development" && framework && framework !== "other"
        ? {
            framework: {
              id: framework,
              options: frameworkOptions,
              ...(source !== "git" && starter && frameworkServer?.scaffold ? { scaffold: true } : {}),
            },
          }
        : {};
    const what = { mode, sessionBranches, ...(database ? { database } : {}), ...chosen };
    if (source === "git" && gitMode === "list") {
      if (!picked || !name.trim()) return null;
      return { repoUrl: picked.cloneUrl, ...accountOf(picked.accountId), name: name.trim(), branch: pickedBranch || picked.defaultBranch, ...what };
    }
    if (source === "git") {
      const url = repoUrl.trim();
      if (!looksLikeRepoUrl(url) || !name.trim()) return null;
      return { repoUrl: url, name: name.trim(), ...(branch ? { branch } : {}), ...what };
    }
    if (source === "create" && (!hostUsable || !repoOwner)) return null;
    // No `repoUrl` at all: the server reads its absence as "start one".
    if (!isValidRepoName(name)) return null;
    return { name: name.trim(), ...what };
    // `database` is rebuilt each render; its parts are the real dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, gitMode, picked, name, pickedBranch, repoUrl, branch, mode, engine, dbName, dbNameValid, sessionBranches, hostUsable, repoOwner, framework, frameworkOptions, starter, frameworkServer?.scaffold]);

  // Blank is fine: the key is optional. Typed, it must be one that can be set up.
  const projectKeyError = projectKey || projectKeyConfirm ? newKeyProblem(projectKey, projectKeyConfirm) : null;

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !workspaceId || !command || projectKeyError) return;

    setError(null);

    try {
      let toSend = command;
      if (source === "create" && repoOwner) {
        const { accountId, login } = repoOwner;
        setStage("repo");
        // Created with a README so it has a default branch to clone.
        const previous = createdRepo.current;
        const repo =
          previous && previous.accountId === accountId && previous.owner.toLowerCase() === login.toLowerCase() && previous.name === command.name
            ? previous
            : await createRepo(accountId, {
                owner: login,
                name: command.name,
                private: visibility === "private",
                autoInit: true,
              });
        createdRepo.current = { ...repo, accountId };
        toSend = { ...command, repoUrl: repo.cloneUrl, ...accountOf(accountId), branch: repo.defaultBranch };
      }

      const created = await createProject({ workspaceId, ...toSend }, setStage);

      // The project is fine without its database, so it opens either way and
      // the reason travels with it.
      if (created.databaseError) {
        toast({ title: "No development database", description: created.databaseError, tone: "error" });
      }
      if (created.scaffoldError) {
        toast({ title: "No starter project", description: created.scaffoldError, tone: "error" });
      }
      if (created.frameworkWarning) {
        toast({ title: "Check the framework", description: `${created.frameworkWarning} Change it under Manage → Environment.` });
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
      setError(e instanceof Error ? e.message : String(e));
      setStage("idle");
    }
  }

  /** Within the New Repo tab it sits under the host, with the owner; otherwise below the tabs. */
  const nameField = (
    <div className="flex flex-col gap-1.5">
      <label htmlFor="new-project-name" className={LABEL}>
        Project name
      </label>
      <div className="relative flex h-[34px] overflow-hidden rounded-[8px] border border-(--fd-border-field) bg-(--fd-field) transition-[border-color,box-shadow] focus-within:border-(--fd-accent) focus-within:ring-[3px] focus-within:ring-(--fd-ring)">
        {source === "create" && repoOwners === null && ownerErrors.length === 0 && (
          <Skeleton className="h-full w-28 shrink-0 rounded-none" />
        )}
        {source === "create" && repoOwner && repoOwners && repoOwners.length > 1 && (
          <>
            <span id="new-project-owner-label" className="sr-only">
              Repository owner
            </span>
            <PopoverSelect
              value={ownerKey(repoOwner)}
              options={repoOwners.map((o) => ({
                value: ownerKey(o),
                label: o.login,
                hint: ownerHint(o, connectedAccounts),
              }))}
              onChange={setChosenOwner}
              heading="Create the repository under"
              disabled={busy}
              labelledBy="new-project-owner-label"
              searchable={repoOwners.length > 6}
              triggerClassName="fd-mono h-full w-auto max-w-[45%] shrink-0 rounded-none border-0 bg-(--fd-prefix) text-[11.5px]"
            />
          </>
        )}
        {source === "create" && repoOwner && (
          <span className="fd-mono flex max-w-[45%] shrink-0 items-center border-r border-(--fd-prefix-border) bg-(--fd-prefix) px-2.5 text-[11.5px] text-(--fd-icon-dim) select-none">
            {repoOwners && repoOwners.length > 1 ? "/" : <span className="truncate">{repoOwner.login} /</span>}
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
      {source === "create" &&
        ownerErrors.map((message, i) => (
          <p key={i} role="alert" className="text-destructive text-[11.5px]">
            {message}
          </p>
        ))}
    </div>
  );

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
              ? command?.framework?.scaffold
                ? `Generating the ${FRAMEWORK_LABELS[command.framework.id]} starter…`
                : source === "empty"
                  ? "Initialising…"
                  : "Cloning…"
              : stage === "creating"
                ? "Creating…"
                : "Create project"}
        </FormDialogFooter>
      }
    >
            <OptionTabs
              value={source}
              onChange={(value) => {
                setSource(value);
                // A repository is detected by default; a start from nothing asks.
                setFramework((current) => (value === "git" ? (current ?? "other") : current === "other" ? null : current));
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
                              <span key={a.id} title={a.name} className="flex min-w-0 items-center gap-1">
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
                        <p key={e.accountId} role="alert" className="text-destructive text-[11.5px]">
                          {GIT_PROVIDER_LABELS[e.provider]} ({e.name}): {e.error}
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
                        Connect GitHub, GitLab or Gitea to pick from your repositories. A URL from any host the server can reach works without one.
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
                    {hostAccounts[0]
                      ? `${GIT_PROVIDER_LABELS[host]} could not be reached as "${hostAccounts[0].name}". Check its token in Settings.`
                      : `Connect ${GIT_PROVIDER_LABELS[host]} in Settings to create repositories on it.`}{" "}
                    The Empty tab starts a project without a remote.
                  </NoGitAccount>
                ) : (
                  <>
                    {nameField}

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

            <div role="separator" className="h-px bg-(--fd-border-subtle)" />

            {source !== "create" && nameField}

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

            {mode === "development" && (
              <div className="flex flex-col gap-2.5">
                <span id="new-project-framework-label" className={LABEL}>
                  Framework <span className="text-(--fd-text-disabled)">· sets up its runtime, commands and preview</span>
                </span>
                <FrameworkPicker value={framework} onChange={setFramework} disabled={busy} labelledBy="new-project-framework-label" />
                {framework && framework !== "other" && (
                  <>
                    <FrameworkOptionsFields
                      id={framework}
                      values={frameworkOptions}
                      onChange={setFrameworkOptions}
                      source={source === "git" ? "repo" : "empty"}
                      disabled={busy}
                      idPrefix="new-project-framework"
                    />
                    {source !== "git" && frameworkServer?.scaffold && (
                      <div className="flex items-center justify-between gap-3 rounded-[8px] border border-(--fd-border-subtle) bg-(--fd-field-muted) px-2.5 py-2">
                        <span id="new-project-starter-label" className={LABEL}>
                          Generate a starter project
                        </span>
                        <Switch checked={starter} onCheckedChange={setStarter} disabled={busy} aria-labelledby="new-project-starter-label" />
                      </div>
                    )}
                    <FrameworkSummary id={framework} values={frameworkOptions} fromRepo={source === "git"} />
                  </>
                )}
              </div>
            )}

            {mode !== "development" && (
              <Callout className="-mt-2">
                A database on the shared server comes with development projects only; this
                project starts without <Code>DATABASE_URL</Code>.
              </Callout>
            )}

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
                <PasswordInput
                  id="new-project-key"
                  bare
                  revealLabel="key"
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
                <PasswordInput
                  id="new-project-key-confirm"
                  bare
                  revealLabel="key"
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

/** Sent with the project; the sign-in account is the server's own fallback and has no id to send. */
const accountOf = (id: string) => (id === GITHUB_LOGIN_ACCOUNT ? {} : { gitAccountId: id });

/**
 * The hosts a repository can be created on, side by side.
 *
 * Every host is shown; choosing one that is not connected says where to
 * connect it.
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
          <Skeleton key={i} className="h-[34px] rounded-[8px]" />
        ))}
      </div>
    );
  }

  return (
    <div role="radiogroup" aria-labelledby={labelledBy} className="grid grid-cols-3 gap-1.5">
      {GIT_PROVIDERS.map((provider) => {
        const checked = provider === value;
        return (
          <button
            key={provider}
            type="button"
            role="radio"
            aria-checked={checked}
            disabled={disabled}
            onClick={() => onChange(provider)}
            className={cn(
              "flex h-[34px] min-w-0 items-center rounded-[8px] border border-(--fd-border) bg-(--fd-field) px-2.5 text-left transition-[border-color,box-shadow,background-color] disabled:cursor-not-allowed disabled:opacity-60",
              FOCUS,
              checked
                ? "border-(--fd-accent) bg-(--fd-accent-tint) ring-[3px] ring-(--fd-ring-soft)"
                : "enabled:hover:border-(--fd-border-hover)",
            )}
          >
            <span className="flex items-center gap-1.5 text-[12px] font-medium text-(--fd-text)">
              <ProviderMark provider={provider} className="size-3.5 shrink-0" />
              {GIT_PROVIDER_LABELS[provider]}
            </span>
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
        render={<TransitionLink href={GIT_PROVIDER_HREF} />}
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
      ? list.filter((repo) => `${repo.fullName} ${repo.provider} ${repo.accountName}`.toLowerCase().includes(needle))
      : list;
    // Capped for the DOM's sake, not the search's: the filter runs over every
    // repository, and only the rendering is limited.
    return hit.slice(0, 60);
  }, [repos, query]);

  const loading = repos === null && !error;
  /** Providers with several accounts, whose rows say which one. */
  const shared = React.useMemo(() => {
    const ids = new Map<GitProvider, Set<string>>();
    for (const r of repos ?? []) ids.set(r.provider, (ids.get(r.provider) ?? new Set()).add(r.accountId));
    return new Set([...ids].filter(([, set]) => set.size > 1).map(([provider]) => provider));
  }, [repos]);

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
                  {shared.has(repo.provider) && (
                    <span className="text-muted-foreground max-w-[40%] shrink-0 truncate text-xs">{repo.accountName}</span>
                  )}
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
