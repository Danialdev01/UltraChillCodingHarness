"use client";

import * as React from "react";
import {
  CheckIcon,
  ChevronsUpDownIcon,
  FolderPlusIcon,
  LinkIcon,
  LockIcon,
  Loader2Icon,
} from "lucide-react";

import { GithubMark } from "@/components/github-mark";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tabs, TabsIndicator, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import { UcchClient } from "@/lib/client";
import {
  NoGithubToken,
  fetchBranches,
  fetchRepos,
  isValidRepoName,
  suggestRepoName,
  type GithubAccount,
  type GithubRepo,
} from "@/lib/github-api";
import { deriveProjectName, looksLikeRepoUrl } from "@/lib/repo-url";
import { TransitionLink, useTransitionRouter } from "@/lib/view-transitions";

/** Where the code for a new project comes from. */
type Source = "github" | "custom" | "new";

const TABS = [
  { value: "github", label: "GitHub", icon: GithubMark },
  { value: "custom", label: "Custom repository", icon: LinkIcon },
  { value: "new", label: "New repository", icon: FolderPlusIcon },
] as const;

/**
 * Starting a project, from one of three places.
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
  const [source, setSource] = React.useState<Source>("github");
  const [stage, setStage] = React.useState<"idle" | "creating" | "cloning">("idle");
  const [error, setError] = React.useState<string | null>(null);

  /** The name the project takes. Shared by the two tabs that clone something. */
  const [name, setName] = React.useState("");
  /** True once the name has been edited, so a repository stops overwriting it. */
  const [nameTouched, setNameTouched] = React.useState(false);

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

  // -- The new-repository tab -----------------------------------------------
  const [repoName, setRepoName] = React.useState("");

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
    setRepoName("");
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

  const busy = stage !== "idle";

  /** What this tab would send, or null when it is not ready to send anything. */
  const command = React.useMemo((): { repoUrl?: string; name: string; branch?: string } | null => {
    if (source === "github") {
      if (!picked || !name.trim()) return null;
      return { repoUrl: picked.cloneUrl, name: name.trim(), branch: ghBranch || picked.defaultBranch };
    }
    if (source === "custom") {
      const url = repoUrl.trim();
      if (!looksLikeRepoUrl(url) || !name.trim()) return null;
      return { repoUrl: url, name: name.trim(), ...(branch ? { branch } : {}) };
    }
    // No `repoUrl` at all: the server reads its absence as "start one".
    if (!isValidRepoName(repoName)) return null;
    return { name: repoName.trim() };
  }, [source, picked, name, ghBranch, repoUrl, branch, repoName]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !workspaceId || !command) return;

    setError(null);
    setStage("creating");

    // One socket for one command, opened here and closed in `finally`:
    // commands go over the WebSocket, and the sidebar has no reason to hold
    // one open the rest of the time.
    const client = new UcchClient();
    try {
      await client.connect();
      await client.whenReady();

      const created = await client.dispatch({
        type: "project.create",
        workspaceId,
        ...command,
      });

      const event = created[0]?.event;
      if (event?.type !== "project.created") throw new Error("the project was not created");

      // Watching the project's own stream, so the wait ends when the clone
      // reactor says it has finished rather than after a guessed delay.
      setStage("cloning");
      await client.subscribe({ name: "project", projectId: event.projectId });
      await waitForClone(client, event.projectId);

      onOpenChange(false);
      router.push(`/${event.hash}`);
      // The sidebar's project list is rendered on the server.
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStage("idle");
    } finally {
      client.close();
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      {/* Wider than the default: the tab labels and the two comboboxes
          need the room, and at 24rem the tab strip scrolled sideways. */}
      <DialogContent className="sm:max-w-xl">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>New project</DialogTitle>
            <DialogDescription>
              The repository lives in its own workspace, which is the only place the agent can read
              or write.
            </DialogDescription>
          </DialogHeader>

          <Tabs
            value={source}
            onValueChange={(value) => {
              if (busy) return;
              setSource(String(value) as Source);
              // The name belongs to whichever tab produced it, so an untouched
              // one is re-derived by the effect above rather than carried over.
              setError(null);
            }}
            className="py-4"
          >
            <TabsList>
              {TABS.map((tab) => (
                <TabsTab key={tab.value} value={tab.value} disabled={busy}>
                  <tab.icon className="size-3.5" />
                  {tab.label}
                </TabsTab>
              ))}
              <TabsIndicator />
            </TabsList>

            <TabsPanel value="github">
              {needsToken ? (
                <NoToken />
              ) : (
                <>
                  <Field>
                    <FieldLabel>Repository</FieldLabel>
                    <RepoPicker
                      repos={repos}
                      value={picked}
                      onChange={(repo) => setPicked(repo)}
                      disabled={busy}
                      error={reposError}
                    />
                    {account && (
                      <p className="text-muted-foreground text-xs">
                        {repos?.length ?? 0} repositories visible to{" "}
                        <span className="font-medium">{account.login}</span>.
                      </p>
                    )}
                    {reposError && (
                      <p role="alert" className="text-destructive text-xs">
                        {reposError}
                      </p>
                    )}
                  </Field>

                  <Field>
                    <FieldLabel>Branch</FieldLabel>
                    <BranchPicker
                      branches={ghBranches}
                      value={ghBranch}
                      onChange={setGhBranch}
                      disabled={busy || !picked}
                      loading={ghBranchesLoading}
                      placeholder="Choose a repository first"
                    />
                  </Field>

                  <NameField
                    id="new-project-github-name"
                    value={name}
                    onChange={(next) => {
                      setNameTouched(true);
                      setName(next);
                    }}
                    disabled={busy}
                  />
                </>
              )}
            </TabsPanel>

            <TabsPanel value="custom">
              <Field>
                <FieldLabel htmlFor="new-project-url">Repository URL</FieldLabel>
                <Input
                  id="new-project-url"
                  value={repoUrl}
                  onChange={(e) => setRepoUrl(e.target.value)}
                  placeholder="https://github.com/owner/repo.git"
                  spellCheck={false}
                  autoComplete="off"
                  disabled={busy}
                />
                {checking && (
                  <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
                    <Loader2Icon className="size-3 animate-spin" />
                    Reading the repository&apos;s branches…
                  </p>
                )}
                {refsError && (
                  <p role="alert" className="text-destructive text-xs">
                    {refsError}
                  </p>
                )}
              </Field>

              <Field>
                <FieldLabel>Branch</FieldLabel>
                <BranchPicker
                  branches={branches}
                  value={branch}
                  onChange={setBranch}
                  disabled={busy}
                  loading={checking}
                  placeholder="Paste a repository URL first"
                />
              </Field>

              <NameField
                id="new-project-custom-name"
                value={name}
                onChange={(next) => {
                  setNameTouched(true);
                  setName(next);
                }}
                disabled={busy}
              />
            </TabsPanel>

            <TabsPanel value="new">
              <Field>
                <FieldLabel htmlFor="new-project-repo-name">Repository name</FieldLabel>
                <Input
                  id="new-project-repo-name"
                  value={repoName}
                  // Corrected as it is typed rather than refused on submit: a
                  // space is what someone means by a dash, and the rest of
                  // what a repository name may not contain is simply dropped.
                  onChange={(e) => setRepoName(suggestRepoName(e.target.value))}
                  placeholder="my-new-app"
                  spellCheck={false}
                  autoComplete="off"
                  maxLength={100}
                  disabled={busy}
                />
                <p className="text-muted-foreground text-xs">
                  Starts an empty project and initialises it as a git repository on{" "}
                  <span className="font-mono">main</span>, with one commit. Nothing is created on
                  GitHub — add a remote and push it when you are ready.
                </p>
              </Field>
            </TabsPanel>
          </Tabs>

          {error && (
            <p role="alert" className="text-destructive pb-2 text-sm">
              {error}
            </p>
          )}

          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" disabled={busy} />}>
              Cancel
            </DialogClose>
            <Button type="submit" disabled={!command || busy}>
              {busy && <Loader2Icon className="animate-spin" />}
              {stage === "cloning"
                ? source === "new"
                  ? "Initialising…"
                  : "Cloning…"
                : stage === "creating"
                  ? "Creating…"
                  : source === "new"
                    ? "Create repository"
                    : "Create project"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The project's name, which both cloning tabs ask for the same way. */
function NameField({
  id,
  value,
  onChange,
  disabled,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>Project name</FieldLabel>
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="my-project"
        maxLength={100}
        disabled={disabled}
      />
    </Field>
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
      <GithubMark className="text-muted-foreground mx-auto size-5" />
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
        render={<TransitionLink href="/setting#api" />}
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
}: {
  /** Null until the list arrives. */
  repos: GithubRepo[] | null;
  value: GithubRepo | null;
  onChange: (repo: GithubRepo) => void;
  disabled?: boolean;
  error: string | null;
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
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={open}
            disabled={disabled || loading || !repos?.length}
            className="h-8 w-full justify-between px-2 font-normal"
          />
        }
      >
        <span className={value ? "truncate" : "text-muted-foreground truncate"}>
          {value?.fullName ??
            (loading
              ? "Reading your repositories…"
              : error
                ? "Could not read your repositories"
                : repos?.length
                  ? "Choose a repository"
                  : "No repositories to choose from")}
        </span>
        {loading ? (
          <Loader2Icon className="size-3.5 shrink-0 animate-spin opacity-50" />
        ) : (
          <ChevronsUpDownIcon className="size-3.5 shrink-0 opacity-50" />
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
                  onSelect={() => {
                    onChange(repo);
                    setOpen(false);
                  }}
                >
                  <CheckIcon
                    className={
                      repo.fullName === value?.fullName ? "size-4 opacity-100" : "size-4 opacity-0"
                    }
                  />
                  <span className="truncate">{repo.fullName}</span>
                  {repo.private && (
                    <LockIcon className="text-muted-foreground ml-auto size-3 shrink-0" />
                  )}
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
function BranchPicker({
  branches,
  value,
  onChange,
  disabled,
  loading,
  placeholder,
}: {
  branches: string[];
  value: string;
  onChange: (branch: string) => void;
  disabled?: boolean;
  loading?: boolean;
  /** What to say when there is nothing to choose from yet. */
  placeholder: string;
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
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={open}
            disabled={disabled || empty}
            className="h-8 w-full justify-between px-2 font-normal"
          />
        }
      >
        <span className={value ? "truncate" : "text-muted-foreground truncate"}>
          {value || (loading ? "Reading branches…" : empty ? placeholder : "Choose a branch")}
        </span>
        {loading ? (
          <Loader2Icon className="size-3.5 shrink-0 animate-spin opacity-50" />
        ) : (
          <ChevronsUpDownIcon className="size-3.5 shrink-0 opacity-50" />
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
                  onSelect={() => {
                    onChange(name);
                    setOpen(false);
                  }}
                >
                  <CheckIcon
                    className={name === value ? "size-4 opacity-100" : "size-4 opacity-0"}
                  />
                  <span className="truncate">{name}</span>
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
 * Resolves when the clone reactor has finished with this project.
 *
 * A cap rather than an indefinite wait: a very large repository should not
 * hold the dialog open for ever, and the project exists either way -- so the
 * timeout opens it anyway rather than reporting a failure that did not
 * happen.
 */
function waitForClone(client: UcchClient, projectId: string, timeoutMs = 180_000): Promise<void> {
  const cloned = () =>
    client.events.some(
      ({ event }) => event.type === "project.cloned" && event.projectId === projectId,
    );
  if (cloned()) return Promise.resolve();

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      unsubscribe();
      resolve();
    }, timeoutMs);
    const unsubscribe = client.subscribeToChanges(() => {
      if (!cloned()) return;
      clearTimeout(timer);
      unsubscribe();
      resolve();
    });
  });
}
