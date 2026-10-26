"use client";

import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type DragEvent, type ReactNode, type Ref } from "react";
import {
  AlertCircleIcon,
  ArrowDownIcon,
  AsteriskIcon,
  ArrowUpIcon,
  BlocksIcon,
  BotIcon,
  BrainIcon,
  CheckIcon,
  CodeIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  CopyIcon,
  DownloadIcon,
  EraserIcon,
  FileTextIcon,
  GaugeIcon,
  ImageIcon,
  Loader2Icon,
  PaperclipIcon,
  PlusIcon,
  SparklesIcon,
  SquareIcon,
  TelescopeIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
  UploadIcon,
  XIcon,
} from "lucide-react";

import { useFilesPanel } from "@/components/files-panel";
import {
  EffortSelect,
  ModelSelect,
  describeEffort,
  NATIVE_EFFORTS,
  useModels,
  type ModelChoice,
} from "@/components/model-picker";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  clipboardFiles,
  composeMessage,
  describeAttachment,
  excludedReason,
  formatBytes,
  isPlaceable,
  modelImages,
  pasteCarriesText,
  pendingImageCount,
  readAttachment,
  type Attachment,
} from "@/lib/attachments";
import {
  AttachmentPreviewDialog,
  type PreviewableAttachment,
} from "@/components/attachment-preview";
import { discardUpload, stageUpload, uploadContentUrl } from "@/lib/uploads-api";
import { ContextMeter } from "@/components/context-meter";
import { Markdown, StreamingMarkdown } from "@/components/markdown";
import { TurnProgress } from "@/components/turn-progress";
import { PermissionPromptCard } from "@/components/permission-prompt";
import { UcchClient, type ClientEvent } from "@/lib/client";
import { ThreadStore, type LiveTurn } from "@/lib/thread-store";
import {
  readLastModel,
  readLastProvider,
  rememberLastModel,
  rememberLastProvider,
} from "@/lib/model-preference";
import { ProviderSelect, useProviders } from "@/components/provider-picker";
import { billingLabel, providerBlocker, type ProviderId } from "@/lib/providers-api";
import { readCredentialChoice } from "@/lib/credential-choice";
import { composerMaxLines, MIN_COMPOSER_LINES } from "@/lib/composer-size";
import { historyDirection, idleCursor, step, type HistoryCursor } from "@/lib/prompt-history";
import {
  atBottom,
  promptNeighbours,
  visionWarning,
  type PromptNeighbours,
} from "@/lib/thread-position";
import {
  describeSent,
  describeStop,
  describeTiming,
  formatCookTime,
  formatDuration,
  splitThinking,
  overlayLive,
  summariseInput,
  toMessages,
  type ChatMessage,
  type ToolPart,
} from "@/lib/chat-messages";
import { readRatings, writeRating, type Rating } from "@/lib/chat-feedback";
import { copyText } from "@/lib/clipboard";
import { codeChatPrompt, type CodeReference } from "@/lib/code-chat";
import { basename, dirname } from "@/lib/files-api";
import { flattenEntries } from "@/lib/file-tree";
import { insertMention, mentionAt, rankEntries, type Mention } from "@/lib/file-mention";
import { matchCommands, matchOptions, SLASH_COMMANDS, slashAt, type Slash } from "@/lib/slash-commands";
import { ComposerMenu, type MenuRow } from "@/components/composer-menu";
import { FileTypeIcon } from "@/components/file-type-icon";
import { ConversationSkeleton } from "@/components/page-skeletons";
import type { ComposerDraft, MessageImage, MessageMode, ReasoningEffort } from "@ucch/protocol";
import type { Project, ProjectSession } from "@/lib/session";
import { ServerError } from "@/lib/client";
import { createComposerSync, type ComposerSync } from "@/lib/composer-sync";
import { isOwnChange, othersAt, usePresence, usePresenceLocation, useProjectEvents, useRealtime } from "@/lib/realtime";
import { isTaskThreadTitle } from "@/lib/tasks-api";
import { NEW_SESSION_NAME, renameProject, sessionTitleFrom } from "@/lib/create-project";
import { keepSession, removeWhenLeft, startProjectSession } from "@/lib/project-sessions";
import { projectHref } from "@/lib/sections";
import { useTransitionRouter } from "@/lib/view-transitions";
import { qk } from "@/lib/query-keys";
import { useInvalidate } from "@/lib/use-invalidate";
import { afterNextPaint, reportVital } from "@/lib/vitals";
import { useViewerFirstName } from "@/components/viewer";

/** Which menu the composer has open, and the word it was opened by. */
type ComposerMenuState = { kind: "mention"; mention: Mention } | { kind: "slash"; slash: Slash };

/**
 * The conversation view for one project -- or, given `session`, for that one
 * session of it, the conversation `/{ws}/p/{project}/{session}` names.
 *
 * Everything on screen is derived from the event log rather than held
 * separately: a message is what the server recorded, and a reply in progress
 * is the deltas that have arrived so far. Reloading mid-turn therefore shows
 * the same thread, because there is no local state to lose.
 */
export function ProjectChat({ project, session }: { project: Project; session?: ProjectSession }) {
  const sessionId = session?.id ?? null;
  const sessionProvider = session?.provider ?? null;
  const transitionRouter = useTransitionRouter();
  // The tab's one socket (`realtime.tsx`), shared with every other view:
  // the chat holds its thread's subscription on it rather than opening a
  // socket of its own. A ref as well, because the composer needs it without
  // re-rendering when it changes.
  const { client: sharedClient } = useRealtime();
  const clientRef = useRef<UcchClient | null>(sharedClient);
  clientRef.current = sharedClient;
  const [threadId, setThreadId] = useState<string | null>(null);
  // Until the opening thread's history has replayed, an empty `events` means
  // "not here yet" rather than "nothing said", and the list is a skeleton.
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<readonly Attachment[]>([]);
  /**
   * The code the next message is about, from the editor's `:chat`.
   *
   * Shown as a chip and folded into the text on send -- "refer line 12 inside
   * file src/app.ts, ..." -- rather than typed into the draft, so what you
   * write is only the instruction and the location cannot be edited away by
   * accident. One at a time: a second `:chat` replaces it.
   */
  const [reference, setReference] = useState<CodeReference | null>(null);
  const [sending, setSending] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * The attachment being looked at, or null.
   *
   * Held by the chat rather than by each tag: one dialog for the whole
   * conversation, and the composer's chips open the same one, so a preview
   * cannot be opened twice over itself.
   */
  const [previewing, setPreviewing] = useState<PreviewableAttachment | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  /**
   * One element per message, by index, for the arrows that walk between
   * prompts. A map rather than ids in the DOM: two chats for two projects
   * can be mounted in one page, and `getElementById` would find the wrong one.
   */
  const blockRefs = useRef(new Map<number, HTMLDivElement>());
  /**
   * One ref callback per position, the same on every render: a new one
   * each time would draw every memoised message again for nothing.
   */
  const blockRefCallbacks = useRef(new Map<number, (el: HTMLDivElement | null) => void>());
  const blockRef = useCallback((i: number) => {
    let callback = blockRefCallbacks.current.get(i);
    if (!callback) {
      callback = (el) => {
        if (el) blockRefs.current.set(i, el);
        else blockRefs.current.delete(i);
      };
      blockRefCallbacks.current.set(i, callback);
    }
    return callback;
  }, []);
  const draftRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  /**
   * The chat's own height, watched rather than measured once.
   *
   * What the composer's growth is budgeted against. The panel is not the
   * window: the file tree opens beside it and the sidebar collapses, so its
   * height and width both change without the viewport doing anything.
   */
  const [panelHeight, setPanelHeight] = useState(0);
  useEffect(() => {
    const element = panelRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) =>
      setPanelHeight(entry!.contentRect.height),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  /**
   * The file tree, told about every file the agent writes.
   *
   * `file.changed` arrives on this thread's own subscription -- the agent
   * emits it from inside the turn -- so the panel is refreshed from the
   * subscription that is already open (`openThread`), and an open file the
   * model rewrote is reread underneath the editor.
   */
  const { noteChanged, tree } = useFilesPanel();
  const noteChangedRef = useRef(noteChanged);
  noteChangedRef.current = noteChanged;

  const { models, defaultModel } = useModels();
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState<ReasoningEffort>("off");

  /**
   * Which backend the next message goes to.
   *
   * Three sources, narrowest first: the thread's binding once it has run,
   * this project's last choice, then the account's default from Settings.
   * The bound one is the only hard fact -- the server refuses a send that
   * disagrees with it -- so it overrides the others rather than joining them.
   */
  const providers = useProviders();
  const [boundProvider, setBoundProvider] = useState<ProviderId | null>(null);
  const [chosenProvider, setChosenProvider] = useState<ProviderId | null>(null);
  const provider: ProviderId =
    boundProvider ?? chosenProvider ?? providers.defaultProvider ?? "native";
  const cli = provider !== "native";

  /**
   * The mode the next message runs in, or null for an ordinary coding turn.
   * Stays on across sends, like a mode rather than an attachment: a person
   * researching, or working on a document, asks several things in a row.
   * One value rather than a flag per mode, so turning one on turns the
   * other off.
   *
   * Any provider, any thread. Research on the native loop is the turn; on
   * Claude Code or Codex it runs first, on OpenRouter, and the CLI is handed
   * the brief with the message. Documentation on the native loop gets the
   * typed document tools; a CLI is handed the same rules and scripts.
   */
  const [mode, setMode] = useState<MessageMode | null>(null);
  const research = mode === "research";
  const documentation = mode === "documentation";
  const toggleMode = useCallback(
    (next: MessageMode) => setMode((current) => (current === next ? null : next)),
    [],
  );

  const chooseProvider = useCallback(
    (id: ProviderId) => {
      setChosenProvider(id);
      rememberLastProvider(project.id, id);
    },
    [project.id],
  );
  /**
   * The model under a CLI harness. Its own state, remembered under its own
   * key, so switching harnesses and back loses neither choice: the
   * OpenRouter catalogue and a CLI's short list have nothing in common.
   */
  const [cliModel, setCliModel] = useState("");
  const cliKey = `${project.id}:${provider}`;

  /**
   * What the model picker offers: the OpenRouter catalogue, or the chosen
   * harness's own list shaped like it, so one combobox serves both.
   */
  const catalogue: ModelChoice[] = useMemo(() => {
    if (!cli) return models;
    const card = providers.cards?.[provider];
    return (card?.models ?? []).map((m) => ({
      id: m.id,
      name: m.name,
      provider: card?.label ?? provider,
      contextLength: null,
      reasoning: false,
      // The CLIs' short lists are all vision models; the picker has no
      // reason to say otherwise, and no catalogue to read it from.
      images: true,
    }));
  }, [cli, models, providers.cards, provider]);

  // A CLI harness always has a model selected -- the remembered one for this
  // project and harness, else the first it offers -- so every prompt names
  // the model the picker shows rather than leaving it to the CLI's default.
  useEffect(() => {
    if (!cli || catalogue.length === 0) return;
    if (catalogue.some((m) => m.id === cliModel)) return;
    const remembered = readLastModel(cliKey);
    setCliModel(
      remembered && catalogue.some((m) => m.id === remembered) ? remembered : catalogue[0]!.id,
    );
  }, [cli, catalogue, cliModel, cliKey]);

  const activeModel = cli ? cliModel : model;

  /**
   * Which project the current choice belongs to.
   *
   * The composer is not remounted when you move between projects, so without
   * this the model would carry over from the last one -- and an effect that
   * only looked at `model` being empty could never tell "nothing chosen yet"
   * apart from "chosen, for a different project".
   */
  const modelProject = useRef<string | null>(null);

  useEffect(() => {
    if (modelProject.current !== project.id) {
      // A project opens on whichever model it was last talked to with, and
      // falls back to the server's default the first time.
      modelProject.current = project.id;
      setModel(readLastModel(project.id) ?? defaultModel ?? "");
      const remembered = readLastProvider(project.id);
      setChosenProvider(isProviderId(remembered) ? remembered : null);
      return;
    }
    // Same project, and the catalogue arrived after the first render with
    // nothing remembered to show in the meantime.
    if (!model && defaultModel) setModel(defaultModel);
  }, [project.id, defaultModel, model]);

  const chooseModel = useCallback(
    (id: string) => {
      if (cli) {
        setCliModel(id);
        rememberLastModel(cliKey, id);
      } else {
        setModel(id);
        rememberLastModel(project.id, id);
      }
    },
    [cli, cliKey, project.id],
  );

  const reasons = models.find((m) => m.id === model)?.reasoning ?? false;

  /**
   * The effort levels the chosen model takes, or null for none. OpenRouter
   * says per model whether it reasons; a CLI lists its levels per model, and
   * one that lists none (Codex, so far) gets no control at all.
   */
  const effortLevels: readonly ReasoningEffort[] | null = useMemo(() => {
    if (!cli) return reasons ? NATIVE_EFFORTS : null;
    const levels = providers.cards?.[provider]?.models.find((m) => m.id === cliModel)?.efforts;
    return levels?.length ? ["off", ...levels] : null;
  }, [cli, reasons, providers.cards, provider, cliModel]);
  // One choice serves every harness, so a level the current model does not
  // take -- `max`, carried back to OpenRouter -- falls back to the default
  // rather than being sent to be refused.
  const sentEffort: ReasoningEffort =
    effortLevels?.includes(effort) ? effort : "off";

  /**
   * Pictures attached to a model that cannot look at them.
   *
   * Checked here rather than left to the server, which would fail the turn
   * after the message has left the composer. Only the native loop has a
   * catalogue that says; a CLI harness is trusted to see.
   */
  const vision = cli
    ? null
    : visionWarning(pendingImageCount(attachments), models.find((m) => m.id === model));

  /**
   * The thread on screen, and the store its events are kept in
   * (`thread-store.ts`): the conversation and what is streaming into it,
   * apart from the client's capped history of everything.
   *
   * Holds the thread's subscription for as long as it is on screen, and
   * resolves once its history has replayed. The subscription's own events
   * fill the store, the replay included even when another view had the
   * thread open first; the acks to this tab's commands come through
   * `onEvent`, ahead of their push, and only logged events are taken from
   * there -- a token would arrive twice.
   */
  const threadStoreRef = useRef<{ store: ThreadStore; off: () => void } | null>(null);
  const [threadStore, setThreadStore] = useState<ThreadStore | null>(null);
  const openThread = useCallback((client: UcchClient, id: string): Promise<void> => {
    threadStoreRef.current?.off();
    const store = new ThreadStore(id);
    const held = client.hold({ name: "thread", threadId: id }, (row) => {
      store.push(row);
      if (row.event.type === "file.changed") noteChangedRef.current(row.event.path, row.event.change);
    });
    const offEvent = client.onEvent((row) => {
      if (row.seq !== null) store.push(row);
    });
    // Back from a drop: what streamed meanwhile is gone, and the logged
    // message, replayed, replaces it.
    const offReconnect = client.onReconnect(() => store.reset());
    threadStoreRef.current = {
      store,
      off: () => {
        held.release();
        offEvent();
        offReconnect();
        store.dispose();
      },
    };
    setThreadStore(store);
    setThreadId(id);
    return held.ready;
  }, []);

  /**
   * The events of the thread on screen, in two parts: what has settled --
   * the log, and what finished turns streamed -- and each turn still
   * streaming, with its own events and runs. The store is per thread, so
   * after a context clear the old conversation is not in it; `file.changed`,
   * which is project-scoped and carries no thread, reaches the file panel
   * from `events`.
   */
  const durableEvents = useSyncExternalStore(
    threadStore?.subscribe ?? subscribeToNothing,
    () => threadStore?.durable ?? NO_ROWS,
    () => NO_ROWS,
  );
  const liveTurns = useSyncExternalStore(
    threadStore?.subscribe ?? subscribeToNothing,
    () => threadStore?.live ?? NO_TURNS,
    () => NO_TURNS,
  );
  // The sent message's turn waiting for the server to have a slot: how many
  // are ahead of it, or null.
  const queuedAhead = useSyncExternalStore(
    threadStore?.subscribe ?? subscribeToNothing,
    () => threadStore?.queued ?? null,
    () => null,
  );

  useEffect(() => {
    const client = sharedClient;
    if (!client) return;

    let cancelled = false;
    void (async () => {
      // A session's page names its thread. Otherwise -- a session
      // workspace's session, which is a project of its own -- the
      // conversation is the project's newest thread, so a reload continues
      // where it left off; only create when there is none.
      let opened: { id: string; provider?: string | null } | undefined;
      if (sessionId) {
        opened = { id: sessionId, provider: sessionProvider };
      } else {
        const response = await fetch(`/api/projects/${project.hash}/threads`, {
          credentials: "include",
        });
        const listed = response.ok
          ? ((await response.json()) as {
              threads: Array<{ id: string; title?: string; provider?: string | null }>
            }).threads
          : [];
        // The newest conversation, passing over the Tasks board's own
        // threads: those are the pipeline's work, not where the person
        // left off.
        opened = listed.find((t) => !isTaskThreadTitle(t.title));
      }

      if (cancelled) return;
      // Subscribing on a ready socket waits for the ack, which carries the
      // replayed history -- on one still opening it would return at once --
      // and creating a thread needs one too.
      await client.whenReady();
      if (cancelled) return;
      const id = opened?.id ?? (await createThread(client, project));
      if (cancelled || !id) return;

      // A thread that has run is bound to its provider; the picker shows it
      // locked rather than offering a switch the server would refuse.
      setBoundProvider(isProviderId(opened?.provider) ? opened.provider : null);
      await openThread(client, id);
      if (!cancelled) setHistoryLoaded(true);
    })().catch(() => {
      // The socket closing mid-setup is ordinary: unmount, or a drop the
      // client will reconnect from on its own. Either way, stop drawing a
      // skeleton over a conversation that may simply be empty.
      if (!cancelled) setHistoryLoaded(true);
    });

    return () => {
      cancelled = true;
      threadStoreRef.current?.off();
      threadStoreRef.current = null;
    };
    // The session's provider is read once, with its id: it only matters
    // until the thread's own events say otherwise.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sharedClient, project.id, project.hash, sessionId]);

  /**
   * "Clear context" in another window starts a new thread; this one follows
   * it when it was showing the newest conversation -- the one the other
   * window just moved on from. A window deliberately left on an older thread
   * stays there. A project session's page does not follow: it is the
   * conversation its address names, and a new one has an address of its own.
   */
  const threadIdRef = useRef<string | null>(null);
  threadIdRef.current = threadId;
  const newestRef = useRef<string | null>(null);
  useEffect(() => {
    if (threadId && newestRef.current === null) newestRef.current = threadId;
  }, [threadId]);

  useProjectEvents(project.id, (event) => {
    if (sessionId || event.type !== "thread.created" || event.projectId !== project.id) return;
    const followed = threadIdRef.current === newestRef.current;
    newestRef.current = event.threadId;
    if (!followed || threadIdRef.current === event.threadId) return;
    const client = clientRef.current;
    if (!client) return;
    void openThread(client, event.threadId).catch(() => {});
    setBoundProvider(null);
  });

  // Where this window is, and whether anyone else is typing into the same box.
  usePresenceLocation(project.id, threadId ? `thread:${threadId}` : null);
  const viewers = usePresence(project.id);
  const othersHere = threadId ? othersAt(viewers, `thread:${threadId}`) : [];
  const [remoteTypingAt, setRemoteTypingAt] = useState(0);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!remoteTypingAt) return;
    const id = window.setTimeout(() => tick((n) => n + 1), 2500);
    return () => window.clearTimeout(id);
  }, [remoteTypingAt]);
  const remoteTyping = Date.now() - remoteTypingAt < 2500;

  /**
   * The prompt box, shared with every window on this thread.
   *
   * What is typed here goes to the server after a short pause and appears in
   * the others as it lands; theirs appears here the same way. Two windows
   * typing at once is a conflict the server settles: the later one's unsent
   * keystrokes are quietly replaced by what the other wrote.
   */
  const syncRef = useRef<ComposerSync | null>(null);
  useEffect(() => {
    const client = clientRef.current;
    if (!client || !threadId) return;
    const sync = createComposerSync({
      delayMs: 120,
      send: (baseRev, draft) => client.updateComposer(threadId, baseRev, draft),
      isConflict: (error) => error instanceof ServerError && error.code === "conflict",
      apply: (draft) => {
        setDraft(draft.text);
        // Files still uploading here are this window's own; keep them.
        setAttachments((current) => [
          ...draft.attachments,
          ...current.filter((a) => a.status === "uploading"),
        ]);
        setReference(draft.reference);
        const synced = draftMode(draft);
        if (synced !== undefined) setMode(synced);
        if (draft.effort !== undefined) setEffort(draft.effort);
      },
    });
    syncRef.current = sync;
    const off = client.onEvent(({ event }) => {
      if (event.type !== "composer.changed" || event.threadId !== threadId) return;
      const own = isOwnChange(event.origin);
      if (!own && event.origin) setRemoteTypingAt(Date.now());
      sync.remote({ rev: event.rev, draft: event.draft, own, typed: !own && !!event.origin });
    });
    return () => {
      off();
      sync.dispose();
      if (syncRef.current === sync) syncRef.current = null;
    };
  }, [threadId]);

  // Every local change to the box -- typing, a chip, a toggle -- goes out.
  // A change that came in from elsewhere is the synced draft already, and
  // `local` ignores it.
  useEffect(() => {
    syncRef.current?.local(composerDraft(draft, attachments, reference, mode, effort));
  }, [draft, attachments, reference, mode, effort]);

  /**
   * Whether the thread follows the reply as it streams.
   *
   * It does while the reader is at the bottom, and stops the moment they
   * scroll up: a reply that keeps yanking the page down under someone
   * reading an earlier answer is unreadable. `following` is the same fact
   * as state, for the button that offers the way back down.
   */
  const followRef = useRef(true);
  const [following, setFollowing] = useState(true);
  const noteScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    const bottom = atBottom(el);
    followRef.current = bottom;
    setFollowing(bottom);
  }, []);

  const scrollToEnd = useCallback((behavior: ScrollBehavior = "smooth") => {
    followRef.current = true;
    setFollowing(true);
    endRef.current?.scrollIntoView({ behavior });
  }, []);

  useEffect(() => {
    if (followRef.current) endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [durableEvents, liveTurns]);

  /** Scrolls a message to the top of the view, for the prompt arrows. */
  const jumpTo = useCallback((index: number) => {
    blockRefs.current.get(index)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  /**
   * Grows the composer with its content, up to what the panel can spare.
   *
   * Driven by `draft` rather than by the keydown handler, so every way the
   * text can change is covered -- Shift+Enter, typing, pasting, and the reset
   * to one line after a send -- instead of only the keystrokes we thought to
   * intercept. The height is cleared before measuring because `scrollHeight`
   * reports the content's height *or* the box's, whichever is larger: a box
   * already held open at ten lines would otherwise never report shrinking.
   */
  useEffect(() => {
    const el = draftRef.current;
    if (!el) return;

    el.style.height = "auto";

    // Read the real line height rather than assuming one: the font and
    // leading come from Tailwind classes, and hardcoding a pixel count here
    // would silently drift the moment `text-sm` changes.
    const styles = getComputedStyle(el);
    const lineHeight = Number.parseFloat(styles.lineHeight) || 20;
    // `box-sizing: border-box` is set globally, so the height we assign
    // includes padding and borders while `scrollHeight` excludes the borders.
    const chrome =
      Number.parseFloat(styles.paddingTop) +
      Number.parseFloat(styles.paddingBottom) +
      Number.parseFloat(styles.borderTopWidth) +
      Number.parseFloat(styles.borderBottomWidth);
    const min = lineHeight * MIN_COMPOSER_LINES + chrome;
    const max = lineHeight * composerMaxLines(panelHeight, lineHeight) + chrome;

    // The floor keeps an empty composer the size it has always been, rather
    // than collapsing to a single line the moment this effect takes over.
    el.style.height = `${Math.min(Math.max(el.scrollHeight, min), max)}px`;
    // Only scrolls once it has stopped growing, so the caret stays reachable
    // past the tenth line.
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
  }, [draft, panelHeight]);

  /**
   * Where a project session's worktree is. Until git has made it nothing can
   * be sent -- the agent would have no tree to work in -- and if git refused,
   * the session cannot run at all and says why. Null for a conversation in
   * the project's main checkout, which has no worktree to wait for.
   */
  const worktree = useMemo(() => {
    if (!session?.branch) return null;
    let state = session.worktreeState;
    let failure = session.worktreeError;
    for (const row of durableEvents) {
      if (row.event.type === "thread.worktree_ready") {
        state = "ready";
        failure = null;
      } else if (row.event.type === "thread.worktree_failed") {
        state = "error";
        failure = row.event.error;
      }
    }
    return { branch: session.branch, state, failure };
  }, [session, durableEvents]);
  const worktreeBlocked = worktree !== null && worktree.state !== "ready";

  // The settled part is folded when it changes -- a tool call, a turn's end
  // -- and the streaming turn is laid over it on every update: only that
  // turn's message is new, so only it draws again.
  const settled = useMemo(() => toMessages(durableEvents), [durableEvents]);
  const { messages, running: turnRunning, active, prompts, contextTokens } = useMemo(
    () => overlayLive(settled, liveTurns),
    [settled, liveTurns],
  );
  // A turn waiting for a slot is the agent's as much as one running: the
  // composer offers Stop, and the server refuses a second message either way.
  const running = turnRunning || queuedAhead !== null;

  /**
   * frame-to-paint (lib/vitals.ts): a streamed delta's arrival to the paint
   * of the commit that shows it. One delta at a time -- the oldest still
   * waiting -- and at most two a second, so a stream of sixty tokens a second
   * is sampled rather than reported token by token.
   */
  const deltaAt = useRef<number | null>(null);
  const lastDeltaSample = useRef(0);
  useEffect(() => {
    const client = clientRef.current;
    if (!client) return;
    return client.onEvent(({ event }) => {
      if (event.type !== "agent.text_delta" || event.threadId !== threadIdRef.current) return;
      const now = performance.now();
      if (deltaAt.current === null && now - lastDeltaSample.current >= 500) deltaAt.current = now;
    });
  }, [sharedClient]);
  useLayoutEffect(() => {
    const at = deltaAt.current;
    if (at === null) return;
    deltaAt.current = null;
    lastDeltaSample.current = performance.now();
    afterNextPaint(() => reportVital("frame-to-paint", performance.now() - at));
  }, [messages]);

  /**
   * Leaving a project session nothing was said in removes it, so starting
   * one and walking away does not leave it in the list. Only a request: the
   * server removes it only if it is still empty -- no turn, no edit, no
   * commit -- so a session holding any work stays whatever this thinks.
   */
  const leftEmpty = useRef(true);
  leftEmpty.current = messages.length === 0 && draft.trim() === "" && attachments.length === 0;
  const sessionHash = session?.hash ?? null;
  useEffect(() => {
    if (!sessionHash) return;
    keepSession(sessionHash);
    return () => {
      if (leftEmpty.current) removeWhenLeft(project.hash, sessionHash);
    };
  }, [project.hash, sessionHash]);

  // Settled in another window, or from the sidebar: this session is gone,
  // so go to the project, which opens where it was left off.
  useProjectEvents(project.id, (event) => {
    if (event.type !== "thread.removed" || !sessionId || event.threadId !== sessionId) return;
    if (project.workspaceHash) transitionRouter.replace(projectHref(project.workspaceHash, "project", project.hash));
  });

  /**
   * Up / Down (with the caret at the end of the draft, or Alt+Up / Alt+Down
   * anywhere) through what was asked before. The entries are the
   * thread's own user messages, oldest first; the cursor resets whenever the
   * draft is edited by hand so a recalled prompt that was then changed is
   * treated as new typing, not as a position in the walk.
   */
  const history = useRef<HistoryCursor>(idleCursor);
  // From the settled messages: what streams changes no prompt, and these
  // stay the same objects while a turn streams.
  const promptHistory = useMemo(
    () => settled.messages.filter((m) => m.role === "user" && m.text.trim()).map((m) => m.text),
    [settled],
  );
  const neighbours = useMemo(() => promptNeighbours(settled.messages), [settled]);

  const recall = useCallback(
    (direction: "back" | "forward") => {
      const next = step(history.current, direction, promptHistory, draft);
      if (!next) return;
      history.current = next.cursor;
      setDraft(next.text);
      // The caret at the end, once the textarea has the text: the browser
      // otherwise leaves it where it was, mid-sentence of a different prompt.
      requestAnimationFrame(() => {
        const el = draftRef.current;
        if (el) el.setSelectionRange(el.value.length, el.value.length);
      });
    },
    [draft, promptHistory],
  );

  /**
   * The menus the composer opens over itself: `@` lists the project's files
   * and folders, and puts the picked one's path in the draft; `/` at the start
   * lists the app's own commands. Both are read from the caret rather than
   * from keys, so a click or arrow back into an `@word` reopens its menu.
   */
  const menuListId = useId();
  const mentionEntries = useMemo(() => flattenEntries(tree), [tree]);
  const [menu, setMenu] = useState<ComposerMenuState | null>(null);
  const [menuIndex, setMenuIndex] = useState(0);
  const mentionResults = useMemo(
    () => (menu?.kind === "mention" ? rankEntries(mentionEntries, menu.mention.query) : []),
    [menu, mentionEntries],
  );
  // The menu Escape closed. React's `onSelect` fires on keyup too, so without
  // this the caret, still in the `@word`, would open it straight back.
  const dismissedMenu = useRef<string | null>(null);
  const trackMenus = useCallback(() => {
    const el = draftRef.current;
    const caret = el && document.activeElement === el && el.selectionStart === el.selectionEnd
      ? el.selectionStart
      : null;
    let next: ComposerMenuState | null = null;
    if (el && caret !== null) {
      const slash = slashAt(el.value, caret);
      const mention = slash ? null : mentionAt(el.value, caret);
      next = slash ? { kind: "slash", slash } : mention ? { kind: "mention", mention } : null;
    }
    const key = next && JSON.stringify(next);
    if (key && key === dismissedMenu.current) next = null;
    else dismissedMenu.current = null;
    // The same menu is kept as the same object, so the selection survives a
    // caret event that changed nothing.
    setMenu((current) => (current && JSON.stringify(current) === key ? current : next));
  }, []);
  // Every change to the draft -- typed, sent, recalled, or synced from another
  // window -- is a chance the caret has left the menu's word.
  useEffect(trackMenus, [draft, trackMenus]);
  useEffect(() => setMenuIndex(0), [menu]);

  /** The draft as given, the caret at `caret`, and the menu re-read from there. */
  const replaceDraft = useCallback((text: string, caret: number) => {
    history.current = idleCursor;
    setDraft(text);
    setMenu(null);
    requestAnimationFrame(() => draftRef.current?.setSelectionRange(caret, caret));
  }, []);

  // Thumbs, per conversation. Read once the thread is known and written
  // through to storage on every click; see lib/chat-feedback.ts for what
  // they are and are not yet.
  const [ratings, setRatings] = useState<Record<string, Rating>>({});
  useEffect(() => {
    setRatings(threadId ? readRatings(threadId) : {});
  }, [threadId]);
  const rate = useCallback(
    (turnId: string, rating: Rating | null) => {
      if (!threadId) return;
      setRatings(writeRating(threadId, turnId, rating));
    },
    [threadId],
  );

  /**
   * Posts one message to the thread with the current model and provider.
   *
   * The composer's send and the editor's `:chat` box both come through here,
   * so a question asked from the file view goes to the same backend, with the
   * same settings, as one typed below the conversation. Throws on failure:
   * what to do with the text then is the caller's decision.
   */
  const dispatchMessage = useCallback(
    async (text: string, images: MessageImage[] = []) => {
      const client = clientRef.current;
      if (!client || !threadId) throw new Error("The conversation is not connected.");
      await client.dispatch({
        type: "thread.send",
        threadId,
        text,
        ...(images.length ? { images } : {}),
        // A CLI provider names its own models, remembered separately from the
        // OpenRouter one so switching back does not lose either choice.
        ...(cli ? (cliModel ? { model: cliModel } : {}) : model ? { model } : {}),
        // A hidden select sends nothing: an effort left over from the last
        // model would otherwise ride along to one that cannot use it.
        ...(effortLevels ? { effort: sentEffort } : {}),
        provider,
        ...(mode ? { mode } : {}),
      });
      // From here on the thread is bound, whatever the picker said before.
      setBoundProvider(provider);
      // Your own message is the one thing you always want to see land.
      scrollToEnd();
    },
    [cli, cliModel, effortLevels, model, mode, provider, scrollToEnd, sentEffort, threadId],
  );

  /**
   * A session is called "New session" until its first message, and then
   * after that message -- the way a thread list titles a conversation. Once
   * per mount: the prop keeps the old name until the project's query is
   * read again, and a second message in that window must not rename it again.
   */
  const invalidate = useInvalidate();
  const sessionNamed = useRef(false);
  const nameSession = useCallback(
    (message: string) => {
      if (sessionNamed.current || project.name !== NEW_SESSION_NAME) return;
      const title = sessionTitleFrom(message);
      if (!title) return;
      sessionNamed.current = true;
      void renameProject(project.hash, title)
        .then(() => invalidate(qk.bootstrap(), qk.sessions.list(project.hash), qk.project(project.hash)))
        // A failed title is cosmetic: the session still works, and the next
        // message gets another go.
        .catch(() => {
          sessionNamed.current = false;
        });
    },
    [project.hash, project.name, invalidate],
  );

  const send = useCallback(async () => {
    // Attachments alone are a message: "here, look at this" is a real thing
    // to say, and the files carry it. A code reference alone is not: it says
    // where to look but not what to do.
    const text = composeMessage(
      reference ? (draft.trim() ? codeChatPrompt(reference, draft) : "") : draft,
      attachments,
    );
    if (!text || !threadId || sending || vision || worktreeBlocked) return;

    // The manifest in `text` describes every attachment; this names the ones
    // the model is shown as pictures. Sent alongside rather than instead:
    // a screenshot the model can see is still a file it can be asked to place.
    const images = modelImages(attachments);

    const sent = { draft, attachments, reference };
    // The server empties the box for every window once the message is in;
    // nothing typed here should race that.
    syncRef.current?.discard();
    setSending(true);
    setError(null);
    setDraft("");
    setAttachments([]);
    setReference(null);
    // A sent prompt is history now, not a position in it.
    history.current = idleCursor;
    try {
      await dispatchMessage(text, images);
      nameSession(sent.draft);
    } catch (e) {
      // Put the composer back as it was rather than losing it to a failed
      // send -- including the files, which the user would otherwise have to
      // find on disk a second time.
      setDraft(sent.draft);
      setAttachments(sent.attachments);
      setReference(sent.reference);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }, [attachments, dispatchMessage, draft, nameSession, reference, sending, threadId, vision, worktreeBlocked]);

  /**
   * `:chat` from the editor: the lines it was typed over become a chip on the
   * composer, and the composer takes focus for the instruction.
   *
   * Keyed on the token so a second `:chat` over the same lines refocuses; the
   * draft is only overwritten when something was typed after the command,
   * so a half-written question is not lost to a bare `:chat`.
   */
  const { codeChat } = useFilesPanel();
  useEffect(() => {
    if (!codeChat) return;
    setReference({ path: codeChat.path, from: codeChat.from, to: codeChat.to });
    if (codeChat.initial) setDraft(codeChat.initial);
    // After the sidebar has had a frame to slide in and the dock to take
    // the element: focus on a node that is mid-move does not stick.
    const id = requestAnimationFrame(() => draftRef.current?.focus());
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [codeChat?.token]);

  /**
   * Takes whatever the file manager handed back and stages it on the server.
   *
   * The chip appears before the upload finishes rather than after: picking a
   * 20 MB image should show something immediately, and the chip carries its
   * own state so a slow or failed upload is visible on the file it belongs
   * to instead of as one error for the batch.
   *
   * Uploads run in parallel and each settles its own chip, so one refused
   * file does not hold up the rest.
   */
  const addFiles = useCallback(
    async (list: ArrayLike<File> | null) => {
      if (!list?.length) return;
      const picked = Array.from(list);

      const staged = await Promise.all(
        picked.map((file, i) => readAttachment(file, `${Date.now()}-${i}-${file.name}`)),
      );
      setAttachments((current) => [...current, ...staged]);

      await Promise.all(
        staged.map(async (attachment, i) => {
          try {
            const upload = await stageUpload(project.hash, picked[i]!);
            setAttachments((current) =>
              current.map((a) =>
                a.id === attachment.id
                  ? { ...a, uploadId: upload.id, status: "staged" as const }
                  : a,
              ),
            );
          } catch (e) {
            setAttachments((current) =>
              current.map((a) =>
                a.id === attachment.id
                  ? { ...a, status: "failed" as const, error: e instanceof Error ? e.message : String(e) }
                  : a,
              ),
            );
          }
        }),
      );
    },
    [project.hash],
  );

  /**
   * Files dragged in from the desktop, anywhere over the panel.
   *
   * A depth count rather than a flag: dragenter and dragleave fire for every
   * child the pointer crosses, so a flag would flicker the overlay off each
   * time it passed over a message. Only drags carrying files count -- text
   * or a link dragged within the page is left to its usual handling.
   */
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const carriesFiles = (e: DragEvent) => e.dataTransfer.types.includes("Files");

  /**
   * Drops a chip, and the staged file with it.
   *
   * Best-effort on the server side: an orphan in staging expires on its own,
   * and failing the click over it would be worse than leaving it.
   */
  const removeAttachment = useCallback(
    (id: string) => {
      setAttachments((current) => {
        const going = current.find((a) => a.id === id);
        if (going?.uploadId) void discardUpload(project.hash, going.uploadId);
        return current.filter((a) => a.id !== id);
      });
    },
    [project.hash],
  );

  /**
   * Stops the turn in flight.
   *
   * The command is a request, not the end: the loop unwinds between tool
   * calls and closes the turn itself with `stopReason: "cancelled"`, which
   * is what clears `running` here. Nothing is faked locally in the meantime.
   */
  const cancel = useCallback(async () => {
    const client = clientRef.current;
    if (!client || !threadId || cancelling) return;
    setCancelling(true);
    setError(null);
    try {
      await client.dispatch({ type: "thread.cancel", threadId });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCancelling(false);
    }
  }, [cancelling, threadId]);

  /**
   * Answers a CLI's permission prompt.
   *
   * Like `cancel`, a request rather than a local change: the card stays
   * until the stream records `agent.permission_resolved`, which is the CLI
   * confirming it heard the answer. A prompt answered from another tab
   * disappears here the same way.
   */
  const replyPermission = useCallback(
    async (
      requestId: string,
      behavior: "allow" | "deny",
      message?: string,
      scope?: "once" | "session",
    ) => {
      const client = clientRef.current;
      if (!client || !threadId) throw new Error("not connected");
      await client.dispatch({
        type: "thread.permission_reply",
        threadId,
        requestId,
        behavior,
        ...(message ? { message } : {}),
        ...(scope ? { scope } : {}),
      });
    },
    [threadId],
  );

  /**
   * Empties the context window.
   *
   * A new thread rather than a deletion: the model's context *is* the
   * thread's history, so the only honest way to start from nothing is to
   * start somewhere else. The old conversation stays in the log -- it is
   * what the turns and checkpoints hang off -- and simply stops being the
   * one this view is subscribed to.
   *
   * In a project session the new thread is a new session, at an address of
   * its own: forked from this session's branch, so the work on disk carries
   * over while the conversation starts again.
   */
  const clearContext = useCallback(async () => {
    const client = clientRef.current;
    if (!client || clearing || running) return;

    setClearing(true);
    setError(null);
    try {
      if (session && project.workspaceHash) {
        const next = await startProjectSession(client, project, { baseBranch: session.branch });
        transitionRouter.push(projectHref(project.workspaceHash, "project", project.hash, next.hash));
        return;
      }
      const id = await createThread(client, project);
      if (!id) throw new Error("could not start a new conversation");
      await openThread(client, id);
      // A fresh thread is bound to nothing yet, so the picker opens again.
      setBoundProvider(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setClearing(false);
    }
  }, [clearing, openThread, project, running, session, transitionRouter]);

  /**
   * What the open menu lists, each row with what picking it does.
   *
   * A command that takes a value is a step, not an action: picking `/model`
   * types `/model ` and the same menu lists the models. Everything else runs
   * and empties the box -- a command is never sent to the agent.
   */
  const menuItems: { row: MenuRow; pick: () => void }[] = (() => {
    if (!menu) return [];
    if (menu.kind === "mention") {
      const { mention } = menu;
      return mentionResults.map((entry) => ({
        row: {
          key: entry.path,
          icon: <FileTypeIcon name={entry.name} kind={entry.kind} />,
          label: entry.name,
          detail: dirname(entry.path),
          detailRtl: true,
        },
        pick: () => {
          const el = draftRef.current;
          if (!el) return;
          const next = insertMention(draft, mention, el.selectionStart, entry);
          replaceDraft(next.text, next.caret);
        },
      }));
    }

    const { slash } = menu;
    const done = () => replaceDraft("", 0);
    const icon = (Icon: typeof BotIcon) => <Icon className="text-muted-foreground size-4 shrink-0" />;
    if (slash.arg === null) {
      return matchCommands(SLASH_COMMANDS, slash.name)
        .filter((command) => command.takesArg !== "effort" || effortLevels)
        .map((command) => {
          const step = () => replaceDraft(`/${command.name} `, command.name.length + 2);
          const row = { key: command.name, label: `/${command.name}`, detail: command.description };
          switch (command.name) {
            case "clear":
              return { row: { ...row, icon: icon(EraserIcon) }, pick: () => (done(), void clearContext()) };
            case "research":
              return {
                row: { ...row, icon: icon(TelescopeIcon), detail: `Research is ${research ? "on" : "off"}` },
                pick: () => (done(), toggleMode("research")),
              };
            case "documentation":
              return {
                row: {
                  ...row,
                  icon: icon(FileTextIcon),
                  detail: `Documentation is ${documentation ? "on" : "off"}`,
                },
                pick: () => (done(), toggleMode("documentation")),
              };
            case "attach":
              return { row: { ...row, icon: icon(PaperclipIcon) }, pick: () => (done(), fileRef.current?.click()) };
            case "harness":
              return boundProvider
                ? {
                    row: { ...row, icon: icon(BotIcon), disabled: true, detail: "Locked to this thread — /clear to switch" },
                    pick: () => {},
                  }
                : { row: { ...row, icon: icon(BotIcon) }, pick: step };
            case "effort":
              return { row: { ...row, icon: icon(GaugeIcon) }, pick: step };
            default:
              return { row: { ...row, icon: icon(BrainIcon) }, pick: step };
          }
        });
    }

    switch (SLASH_COMMANDS.find((c) => c.name === slash.name)?.takesArg) {
      case "model":
        return matchOptions(catalogue, slash.arg, (m) => `${m.name} ${m.id}`)
          .slice(0, 50)
          .map((m) => ({
            row: { key: m.id, icon: icon(BrainIcon), label: m.name, detail: m.provider, current: m.id === activeModel },
            pick: () => (done(), chooseModel(m.id)),
          }));
      case "effort":
        return matchOptions(effortLevels ?? [], slash.arg, (e) => describeEffort(e, cli).label).map((e) => {
          const { label, hint } = describeEffort(e, cli);
          return {
            row: { key: e, icon: icon(GaugeIcon), label, detail: hint, current: e === sentEffort },
            pick: () => (done(), setEffort(e)),
          };
        });
      case "harness":
        if (boundProvider) return [];
        return matchOptions(Object.values(providers.cards ?? {}), slash.arg, (card) => card.label).map((card) => {
          const blocker = providerBlocker(card);
          return {
            row: {
              key: card.id,
              icon: icon(BotIcon),
              label: card.label,
              detail: blocker ?? undefined,
              disabled: blocker !== null,
              current: card.id === provider,
            },
            pick: () => {
              if (blocker) return;
              done();
              chooseProvider(card.id);
            },
          };
        });
      default:
        return [];
    }
  })();

  /** A conversation with nothing in it yet: the opening screen. */
  const empty = historyLoaded && messages.length === 0 && !active && prompts.length === 0;

  return (
    // `@container`, not viewport breakpoints: the chat is a panel, not the
    // window. The file tree opens beside it and the sidebar collapses, so it
    // can be phone-narrow on a desktop -- and everything inside sizes against
    // this box rather than against a screen it may only have a third of.
    <div
      ref={panelRef}
      className="@container relative flex min-h-0 flex-1 flex-col"
      onDragEnter={(e) => {
        if (!carriesFiles(e)) return;
        e.preventDefault();
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={(e) => {
        if (!carriesFiles(e)) return;
        // Without this the browser opens the file instead of dropping it here.
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(e) => {
        if (!carriesFiles(e)) return;
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }}
      onDrop={(e) => {
        if (!carriesFiles(e)) return;
        e.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        void addFiles(e.dataTransfer.files);
      }}
    >
      {/* Over everything, and deaf to the pointer so the drag events keep
          landing on the panel underneath rather than on the overlay. */}
      {dragging && (
        <div className="bg-background/80 pointer-events-none absolute inset-0 z-50 flex p-3 backdrop-blur-sm @md:p-4">
          <div className="border-primary bg-primary/5 text-primary flex flex-1 flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed">
            <UploadIcon className="size-8" />
            <p className="text-base font-medium">Upload File Here</p>
          </div>
        </div>
      )}
      {/* `relative` for the button below, which floats over the thread's
          floor rather than taking a row of its own. */}
      {/* A conversation not yet begun has nothing to read, so on a wide
          panel the greeting and the box gather in the middle instead of
          leaving the box on the floor under an empty page: auto margins on
          the two of them, since the panel is the container and its own
          `@2xl:` classes would never match. */}
      <div className={cn("relative min-h-0 flex-1", empty && "@2xl:mt-auto @2xl:flex-none")}>
        <div
          ref={listRef}
          onScroll={noteScroll}
          className={cn("h-full overflow-y-auto p-3 @md:p-4", empty && "@2xl:h-auto")}
        >
          <div className="mx-auto flex max-w-3xl flex-col gap-3 @md:gap-4">
            {!historyLoaded && messages.length === 0 ? (
              <ConversationSkeleton />
            ) : messages.length === 0 ? (
              <>
                <p className="text-muted-foreground py-8 text-center text-sm @2xl:hidden">
                  Nothing yet. Ask the agent something about this project.
                </p>
                {empty && (
                  <div className="hidden pt-4 pb-2 @2xl:block">
                    <Greeting />
                  </div>
                )}
              </>
            ) : (
              messages.map((message, i) => (
                <Message
                  key={i}
                  ref={blockRef(i)}
                  message={message}
                  hash={project.hash}
                  onPreview={setPreviewing}
                  rating={message.turnId ? (ratings[message.turnId] ?? null) : null}
                  onRate={rate}
                  neighbours={neighbours.get(i)}
                  onJump={jumpTo}
                />
              ))
            )}

            <div ref={endRef} />
          </div>
        </div>

        {/* The way back down. Only once the reader has left the bottom: on
            the floor it would cover the last line of the reply and say
            nothing. Centred, floating just clear of the composer's edge. */}
        {!following && messages.length > 0 && (
          <Button
            type="button"
            size="icon"
            variant="secondary"
            onClick={() => scrollToEnd()}
            title="Scroll to the latest"
            className="absolute bottom-3 left-1/2 size-8 -translate-x-1/2 rounded-full border shadow-md"
          >
            <ArrowDownIcon />
            <span className="sr-only">Scroll to the latest</span>
          </Button>
        )}
      </div>

      {/* One dialog for the panel, opened by a message tag or a composer chip.
          Mounted here rather than inside either so it is not unmounted by the
          list re-rendering underneath it. */}
      <AttachmentPreviewDialog
        hash={project.hash}
        attachment={previewing}
        onClose={() => setPreviewing(null)}
      />

      {/* shrink-0: the composer keeps its height and the message list gives
          way, so a long conversation can never squeeze the box you type in. */}
      {/* The safe-area inset is what keeps the composer clear of a phone's
          home indicator, which otherwise sits on top of the send button. */}
      <div
        className={cn(
          "shrink-0 border-t p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] @md:p-4 @md:pb-[max(1rem,env(safe-area-inset-bottom))]",
          // Lifted a little above true centre, where a centred block reads as
          // centred rather than as sinking.
          empty && "@2xl:mb-auto @2xl:border-t-0 @2xl:pb-[12vh]",
        )}
      >
        {/* A fifth wider than the thread it sits under: the composer is one
            box you work inside -- text, files and the controls that act on
            them -- and it needs the room the reading column does not. */}
        <div
          className={cn(
            "mx-auto flex w-full max-w-[57.6rem] flex-col gap-2",
            empty && "@2xl:max-w-3xl",
          )}
        >
          {/* Above the box rather than inside it: it is about the turn, not
              about what is being typed, and it must not move the composer
              when it appears and goes. */}
          {/* One at a time, oldest first: the CLI blocks on each in turn,
              so answering the first is what unblocks the rest. */}
          {prompts[0] && (
            <PermissionPromptCard
              key={prompts[0].requestId}
              prompt={prompts[0]}
              onReply={replyPermission}
            />
          )}
          {active && !prompts.length && <TurnProgress active={active} />}
          {/* Same place as the progress line, same reason: it is about what
              the send would do, and it goes away when the cause does --
              another model picked, or the picture removed. */}
          {vision && (
            <p
              role="alert"
              className="border-destructive/40 bg-destructive/5 text-destructive flex items-center gap-2 rounded-lg border px-3 py-2 text-xs"
            >
              <AlertCircleIcon className="size-3.5 shrink-0" />
              {vision}
            </p>
          )}
          {/* The whole box is the input, not just the textarea: the border
              and focus ring live out here so the send button reads as being
              inside the field rather than beside it. `focus-within` puts the
              ring up when the textarea inside takes focus, which is the only
              thing that ever does. */}
          <form
            className={cn(
              "border-border relative bg-background focus-within:ring-ring/50 flex flex-col rounded-2xl border shadow-sm focus-within:ring-2",
              empty && "@2xl:shadow-md",
            )}
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            {menu && (
              <ComposerMenu
                id={menuListId}
                rows={menuItems.map((item) => item.row)}
                selected={menuIndex}
                empty={
                  menu.kind === "mention"
                    ? "No matching files"
                    : "No matching commands — Enter sends this as a message"
                }
                onHover={setMenuIndex}
                onPick={(index) => menuItems[index]?.pick()}
              />
            )}
            {(attachments.length > 0 || reference) && (
              // Inside the box and above the text: what you attached is part
              // of the message you are writing, not a separate tray.
              <div className="flex flex-wrap gap-1.5 px-3 pt-3">
                {reference && (
                  <span
                    title={`The message will refer the agent to ${reference.path}, line${
                      reference.from === reference.to
                        ? ` ${reference.from}`
                        : `s ${reference.from}-${reference.to}`
                    }`}
                    className="bg-ucch-active-bg text-foreground flex max-w-40 items-center gap-1.5 rounded-md py-1 pr-1 pl-2 font-mono text-xs @md:max-w-64"
                  >
                    <CodeIcon className="text-ucch-active size-3 shrink-0" />
                    <span className="truncate">
                      {basename(reference.path)}:{reference.from}
                      {reference.from !== reference.to && `-${reference.to}`}
                    </span>
                    <button
                      type="button"
                      onClick={() => setReference(null)}
                      className="hover:text-foreground text-muted-foreground shrink-0 rounded-sm p-0.5"
                    >
                      <XIcon className="size-3" />
                      <span className="sr-only">Remove code reference</span>
                    </button>
                  </span>
                )}
                {attachments.map((file) => (
                  <span
                    key={file.id}
                    title={
                      file.status === "failed"
                        ? `Upload failed: ${file.error ?? "unknown error"}`
                        : file.status === "uploading"
                          ? "Uploading…"
                          : // What the model will be told about this file:
                            // staged outside the project until it is placed.
                            `Staged — the agent can add it to the project on request${
                              file.text === null ? ` (content ${excludedReason(file)})` : ""
                            }`
                    }
                    className={`flex max-w-40 items-center gap-1.5 rounded-md py-1 pr-1 pl-2 text-xs @md:max-w-64 ${
                      file.status === "failed"
                        ? "border-destructive/40 text-destructive border"
                        : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {file.status === "uploading" ? (
                      <Loader2Icon className="size-3 shrink-0 animate-spin" />
                    ) : file.status === "failed" ? (
                      <AlertCircleIcon className="size-3 shrink-0" />
                    ) : (
                      <CheckIcon className="text-ucch-active size-3 shrink-0" />
                    )}
                    {/* Staged files are worth a second look before sending --
                        a screenshot pasted from the clipboard is the case that
                        needs it, since nothing has shown it yet. One still
                        uploading has nothing on the server to show. */}
                    {isPlaceable(file) ? (
                      <button
                        type="button"
                        onClick={() => setPreviewing(file)}
                        title={`Open ${file.name}`}
                        className="hover:text-foreground min-w-0 truncate text-left"
                      >
                        {describeAttachment(file)}
                      </button>
                    ) : (
                      <span className="truncate">{describeAttachment(file)}</span>
                    )}
                    <button
                      type="button"
                      onClick={() => removeAttachment(file.id)}
                      className="hover:text-foreground shrink-0 rounded-sm p-0.5"
                    >
                      <XIcon className="size-3" />
                      <span className="sr-only">Remove {file.name}</span>
                    </button>
                  </span>
                ))}
              </div>
            )}

            {/* One line to start, growing as it fills; send stays at the
                right end of the last line. */}
            <div className="flex items-end gap-2 py-2 pr-2 pl-4">
              <textarea
                ref={draftRef}
                value={draft}
                onChange={(e) => {
                  // Typing leaves the history walk: the text is yours again.
                  history.current = idleCursor;
                  setDraft(e.target.value);
                }}
                onPaste={(e) => {
                  // A pasted screenshot is the fastest way to show the agent
                  // what you mean, and it arrives here as a file on the
                  // clipboard -- the same thing the file picker hands over, so
                  // it takes the same path: staged on the server, chipped in the
                  // composer, and named in the message as a picture to look at.
                  const files = clipboardFiles(e.clipboardData);
                  if (files.length === 0) return;
                  // Only a paste with nothing to type is swallowed, so pasting
                  // a table that travels with an image of itself still types.
                  if (!pasteCarriesText(e.clipboardData)) e.preventDefault();
                  void addFiles(files);
                }}
                onSelect={trackMenus}
                onBlur={() => setMenu(null)}
                role="combobox"
                aria-expanded={!!menu}
                aria-controls={menu ? menuListId : undefined}
                aria-activedescendant={
                  menu && menuItems.length ? `${menuListId}-${menuIndex}` : undefined
                }
                aria-autocomplete="list"
                onKeyDown={(e) => {
                  // While a menu is open it has the keys that would otherwise
                  // send, recall history, or stop the agent. With nothing in
                  // it, Enter falls through and sends: a `/path` is a message.
                  if (menu) {
                    const count = menuItems.length;
                    if (count && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
                      e.preventDefault();
                      const step = e.key === "ArrowDown" ? 1 : -1;
                      setMenuIndex((i) => (i + step + count) % count);
                      return;
                    }
                    if (count && ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab")) {
                      e.preventDefault();
                      (menuItems[menuIndex] ?? menuItems[0]!).pick();
                      return;
                    }
                    if (e.key === "Escape") {
                      e.preventDefault();
                      dismissedMenu.current = JSON.stringify(menu);
                      setMenu(null);
                      return;
                    }
                  }
                  // Enter sends; Shift+Enter is a newline. A chat composer that
                  // needs the mouse to send is a chat composer nobody uses.
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                  // What the progress line above says it does.
                  if (e.key === "Escape" && running) {
                    e.preventDefault();
                    void cancel();
                  }
                  // Up recalls the previous prompt and Down comes forward, while
                  // the caret is at the end of the draft; Alt+arrows anywhere.
                  const el = e.currentTarget;
                  const direction = historyDirection({
                    key: e.key,
                    altKey: e.altKey,
                    ctrlKey: e.ctrlKey,
                    metaKey: e.metaKey,
                    shiftKey: e.shiftKey,
                    caretAtEnd: el.selectionStart === el.selectionEnd && el.selectionEnd === el.value.length,
                  });
                  if (direction) {
                    e.preventDefault();
                    recall(direction);
                  }
                }}
                rows={MIN_COMPOSER_LINES}
                disabled={!threadId || sending || running}
                placeholder={
                  threadId
                    ? running
                      ? queuedAhead !== null
                        ? `Queued — ${queuedAhead} ahead`
                        : research
                          ? "Researching…"
                          : documentation
                            ? "Documenting…"
                            : "The agent is working…"
                      : research
                        ? "What should the agent find out?"
                        : documentation
                          ? "What document should the agent write, edit or read?"
                          : "Ask Anything, @tag files/folders, $use skills, or / for commands"
                    : "Opening the thread…"
                }
                className={cn(
                  "placeholder:text-muted-foreground min-w-0 flex-1 resize-none border-0 bg-transparent px-0 py-1.5 text-sm focus:outline-none disabled:opacity-60",
                  // Room to start writing before it has to grow.
                  empty && "@2xl:min-h-16",
                )}
                />
              {running ? (
                // The same button position, so the reader does not have to
                // look for it: while a turn runs, Send is Stop. The server
                // refuses a second message on a running thread anyway.
                <Button
                  type="button"
                  size="icon"
                  variant="secondary"
                  className="size-8 shrink-0 rounded-lg"
                  onClick={() => void cancel()}
                  disabled={cancelling}
                  title="Stop the agent"
                >
                  {cancelling ? <Loader2Icon className="animate-spin" /> : <SquareIcon />}
                  <span className="sr-only">Stop</span>
                </Button>
              ) : (
                <Button
                  type="submit"
                  size="icon"
                  // On the opening screen it appears once there is something
                  // to send, rather than sitting greyed out in an empty box.
                  className={cn(
                    "size-8 shrink-0 rounded-lg",
                    empty && !draft.trim() && attachments.length === 0 && "@2xl:hidden",
                  )}
                  // Files on their own are a message too, so an empty
                  // draft with something attached still sends -- but not
                  // while one is still uploading, which would reach the
                  // model as an id it cannot use.
                  disabled={
                    (!draft.trim() && attachments.length === 0) ||
                    // A reference needs an instruction to go with it.
                    (reference !== null && !draft.trim()) ||
                    attachments.some((a) => a.status === "uploading") ||
                    !threadId ||
                    sending ||
                    // The warning above says why; sending anyway would
                    // fail the turn and hand the message back.
                    vision !== null ||
                    // So does the worktree notice.
                    worktreeBlocked
                  }
                >
                  {sending ? <Loader2Icon className="animate-spin" /> : <ArrowUpIcon />}
                  <span className="sr-only">Send</span>
                </Button>
              )}
            </div>
          </form>

          {/* Below the box, plain text rather than more boxes: what you
              type is what the eye goes to, and the settings that qualify it
              sit quietly under it. Add on the left, then the model -- the
              darkest, as the setting that matters most -- with its effort
              beside it; the harness and the context on the right. One line at
              any width: on a phone the names truncate rather than wrap. */}
          <div className="flex min-w-0 items-center gap-x-0.5 px-1">
            <AttachMenu
              disabled={!threadId || sending || running}
              onAddFiles={() => fileRef.current?.click()}
              mode={mode}
              onMode={toggleMode}
              researchNote={
                cli
                  ? `Researches on OpenRouter first, then hands ${provider} the brief with your message`
                  : "Find live information with Perplexity Sonar, read the pages with Crawl4AI, and send a browser agent where the crawler cannot go"
              }
              documentationNote={
                cli
                  ? `Hands ${provider} the document rules, templates and scripts with your message`
                  : "Create, edit and read PDF, DOCX and DOC files: fixed templates, diagrams and charts, then a layout check of every page"
              }
            />
            {/* The mode, shown where it was switched on. A toggle buried
                in a menu needs something visible saying it is still on,
                and this is also the fastest way to turn it off. */}
            {mode && (
              <button
                type="button"
                onClick={() => setMode(null)}
                disabled={sending || running}
                title={
                  research
                    ? cli
                      ? `Research mode: researched on OpenRouter first, then handed to ${provider}. Click to turn off.`
                      : "Research mode: search, read, then browse. Click to turn off."
                    : cli
                      ? `Documentation mode: ${provider} is handed the document rules and scripts. Click to turn off.`
                      : "Documentation mode: plan, write, render, then check the layout. Click to turn off."
                }
                className="bg-ucch-active-bg text-foreground hover:text-muted-foreground flex h-7 items-center gap-1 rounded-full py-1 pr-1.5 pl-2 text-xs transition-colors disabled:opacity-60"
              >
                {(() => {
                  const ModeIcon = MODE_ICON[mode];
                  return <ModeIcon className="size-3.5" />;
                })()}
                {MODE_LABEL[mode]}
                <XIcon className="size-3 opacity-70" />
                <span className="sr-only">Turn {MODE_LABEL[mode].toLowerCase()} off</span>
              </button>
            )}
            {/* Hidden, and clicked by the menu item: the native control is
                the only way to open the file manager, and its own chrome
                has no place in a composer. */}
            <input
              ref={fileRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                void addFiles(e.target.files);
                e.target.value = "";
              }}
            />

            <ModelSelect
              models={catalogue}
              value={activeModel}
              onChange={chooseModel}
              look="inline"
              disabled={sending || running}
            />
            {/* Only where it means something: a model that takes effort,
                under a harness that passes it on. */}
            {effortLevels && (
              <EffortSelect
                value={sentEffort}
                levels={effortLevels}
                offMeansDefault={cli}
                onChange={setEffort}
                look="inline"
                disabled={sending}
              />
            )}
            <div className="ml-auto flex min-w-0 shrink items-center gap-0.5">
              <ProviderSelect
                providers={providers}
                value={provider}
                locked={boundProvider}
                onChange={chooseProvider}
                look="inline"
                disabled={sending || running}
              />
              <ContextMeter
                tokens={contextTokens}
                limit={models.find((m) => m.id === model)?.contextLength ?? null}
                onClear={() => void clearContext()}
                clearing={clearing}
                // Mid-turn the history is still being written; clearing under
                // the running loop would leave it appending to a thread nobody
                // is watching.
                disabled={running || sending || !threadId}
              />
            </div>
          </div>
          {worktree && worktree.state !== "ready" && (
            <span
              className={cn(
                "truncate px-1.5 text-xs",
                worktree.state === "error" ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {worktree.state === "error"
                ? `The worktree for ${worktree.branch} could not be made: ${worktree.failure ?? "unknown error"}. Start a new session to try again.`
                : `Preparing a worktree on ${worktree.branch}…`}
            </span>
          )}
          {error && <span className="text-destructive truncate px-1.5 text-xs">{error}</span>}
          {!error && othersHere.length > 0 && (
            <span
              className={cn(
                "flex items-center gap-1 truncate px-1.5 text-xs",
                remoteTyping ? "text-warning" : "text-muted-foreground",
              )}
              title="This conversation and its prompt are shared live with your other windows."
            >
              <span
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  remoteTyping ? "animate-pulse bg-warning" : "bg-success",
                )}
              />
              {remoteTyping ? "Typing in another window…" : "Open in another window"}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * "Good morning, <first name>" over an empty conversation.
 *
 * The time of day is the browser's, so it is worked out after mount: the
 * server's clock and timezone are not the reader's, and rendering one there
 * would greet them with the wrong part of the day and a hydration mismatch.
 */
function Greeting() {
  const name = useViewerFirstName();
  const [part, setPart] = useState<string | null>(null);
  useEffect(() => {
    const hour = new Date().getHours();
    setPart(hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening");
  }, []);

  return (
    <div className="flex items-center justify-center gap-3">
      <AsteriskIcon aria-hidden className="text-ucch-active size-10 shrink-0" strokeWidth={1.5} />
      <h1 className="font-serif text-3xl tracking-tight @4xl:text-4xl">
        {part ? `Good ${part}` : "Hello"}
        {name && `, ${name}`}
      </h1>
    </div>
  );
}

/**
 * The plus under the composer.
 *
 * Three entries work today -- files, and the Research and Documentation
 * toggles; the rest are
 * named because the menu is the place a user goes looking for them, and a
 * menu that grows an item later teaches nothing about where the first one
 * lives. They are disabled rather than hidden -- "not yet" is information,
 * and an empty menu is not.
 *
 * The modes are checkbox items rather than actions: each is a mode for the
 * messages that follow, not something added to this one. At most one is on.
 */
function AttachMenu({
  disabled,
  onAddFiles,
  mode,
  onMode,
  researchNote,
  documentationNote,
}: {
  disabled: boolean;
  onAddFiles: () => void;
  mode: MessageMode | null;
  /** Flips the named mode, turning any other off. */
  onMode: (mode: MessageMode) => void;
  /** What turning each on does under the current provider. */
  researchNote: string;
  documentationNote: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="text-muted-foreground hover:text-foreground size-8 rounded-full"
            disabled={disabled}
            title="Add to this message"
          />
        }
      >
        <PlusIcon />
        <span className="sr-only">Add to this message</span>
      </DropdownMenuTrigger>
      {/* Opens upward: the composer sits on the floor of the panel, and a
          menu dropping from it would open off-screen. */}
      <DropdownMenuContent side="top" align="start" className="w-56">
        <DropdownMenuItem onClick={onAddFiles}>
          <ImageIcon />
          Add files or photos
        </DropdownMenuItem>
        <DropdownMenuItem disabled>
          <SparklesIcon />
          Skills
        </DropdownMenuItem>
        <DropdownMenuItem disabled>
          <BlocksIcon />
          Connectors
        </DropdownMenuItem>
        <DropdownMenuCheckboxItem
          checked={mode === "research"}
          onCheckedChange={() => onMode("research")}
          title={researchNote}
        >
          <TelescopeIcon />
          Research
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={mode === "documentation"}
          onCheckedChange={() => onMode("documentation")}
          title={documentationNote}
        >
          <FileTextIcon />
          Documentation
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Creates a thread and returns its id, or null if the command was refused.
 * Carries your subscription choice for the workspace; the server ignores it
 * unless the workspace lets members choose.
 */
const NO_ROWS: readonly ClientEvent[] = [];
const NO_TURNS: readonly LiveTurn[] = [];
const subscribeToNothing = () => () => {};

async function createThread(client: UcchClient, project: Project): Promise<string | null> {
  const credentialSource = readCredentialChoice(project.workspaceId);
  const created = await client.dispatch({
    type: "thread.create",
    projectId: project.id,
    ...(credentialSource ? { credentialSource } : {}),
  });
  const event = created[0]?.event;
  return event?.type === "thread.created" ? event.threadId : null;
}


/**
 * One message. Memoised: while an answer streams only its own message is a
 * new object (`overlayLive`), so every other one is skipped.
 */
const Message = memo(function Message({
  ref,
  message,
  hash,
  onPreview,
  rating,
  onRate,
  neighbours,
  onJump,
}: {
  ref: Ref<HTMLDivElement>;
  message: ChatMessage;
  hash: string;
  onPreview: (file: PreviewableAttachment) => void;
  rating: Rating | null;
  onRate: (turnId: string, rating: Rating | null) => void;
  /** The prompts before and after this one; only set on a user message. */
  neighbours: PromptNeighbours | undefined;
  onJump: (index: number) => void;
}) {
  if (message.role === "user") {
    const sent = describeSent(message.startedAt);
    // Clear of the top of the scroll box when jumped to, so the bubble does
    // not land flush against the edge.
    return (
      <div ref={ref} className="flex scroll-mt-3 flex-col items-end gap-1.5">
        {/* Which kind of turn was asked for. Only the one that is not the
            default is labelled: a label on every message says nothing. */}
        {message.mode &&
          (() => {
            const ModeIcon = MODE_ICON[message.mode];
            return (
              <span className="text-muted-foreground flex items-center gap-1 text-[0.7rem] tracking-wide uppercase">
                <ModeIcon className="size-3" />
                {MODE_LABEL[message.mode]}
              </span>
            );
          })()}
        {message.text && (
          <p className="bg-ucch-active-bg text-foreground max-w-[92%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap @md:max-w-[85%]">
            {message.text}
          </p>
        )}

        {/* One tag per file, under the message it came with. What the model
            was told -- ids, staging, any inlined contents -- stays in the
            log and out of the reader's way.
            
            A tag with an upload behind it is two controls: the name opens the
            file, and the arrow saves it. A failed upload is neither -- there
            are no bytes to offer -- so it stays a label. */}
        {message.attachments && (
          <div className="flex max-w-[92%] flex-wrap justify-end gap-1.5 @md:max-w-[85%]">
            {message.attachments.map((file, i) => (
              <span
                key={`${file.name}-${i}`}
                title={`${file.type || "file"} · ${formatBytes(file.size)}${
                  file.uploadId ? "" : " · upload failed"
                }`}
                className={`flex max-w-48 items-center rounded-md text-xs @md:max-w-64 ${
                  file.uploadId
                    ? "bg-muted text-muted-foreground"
                    : "border-destructive/40 text-destructive border px-2 py-1 gap-1.5"
                }`}
              >
                {file.uploadId ? (
                  <>
                    <button
                      type="button"
                      onClick={() => onPreview(file)}
                      title={`Open ${file.name}`}
                      className="hover:text-foreground flex min-w-0 items-center gap-1.5 rounded-l-md py-1 pr-1 pl-2"
                    >
                      <PaperclipIcon className="size-3 shrink-0" />
                      <span className="truncate">{file.name}</span>
                      <span className="text-muted-foreground shrink-0">{formatBytes(file.size)}</span>
                    </button>
                    <a
                      href={uploadContentUrl(hash, file.uploadId, { download: true })}
                      download={file.name}
                      title={`Download ${file.name}`}
                      className="hover:text-foreground shrink-0 rounded-r-md py-1 pr-1.5 pl-1"
                    >
                      <DownloadIcon className="size-3" />
                      <span className="sr-only">Download {file.name}</span>
                    </a>
                  </>
                ) : (
                  <>
                    <PaperclipIcon className="size-3 shrink-0" />
                    <span className="truncate">{file.name}</span>
                    <span className="text-muted-foreground shrink-0">{formatBytes(file.size)}</span>
                  </>
                )}
              </span>
            ))}
          </div>
        )}

        {/* Under every prompt: copy the text as typed, without the
            attachment manifest the model was shown. Right-aligned with the
            bubble it belongs to. */}
        <div className="text-muted-foreground flex items-center gap-1 text-xs">
          {message.text && <CopyButton text={message.text} label="Copy message" />}
          {sent && (
            <span className="tabular-nums" title="When this was sent">
              {sent}
            </span>
          )}
          {/* Up to the previous prompt, down to the next. Muted, so they
              read as a rail beside the conversation rather than part of it;
              disabled rather than hidden at the ends so they stay put. */}
          {neighbours && (
            <span className="text-muted-foreground hover:text-foreground focus-within:text-foreground ml-1 flex items-center">
              <JumpButton
                target={neighbours.previous}
                label="Previous prompt"
                onJump={onJump}
              >
                <ChevronUpIcon className="size-3.5" />
              </JumpButton>
              <JumpButton target={neighbours.next} label="Next prompt" onJump={onJump}>
                <ChevronDownIcon className="size-3.5" />
              </JumpButton>
            </span>
          )}
        </div>
      </div>
    );
  }

  const stop = describeStop(message.stopReason);

  // Everything the model did on the way to the answer -- native reasoning,
  // inline <think> blocks, tool calls -- goes into one dropdown, in the order
  // it happened; only the answer prose stays on the page. The reader asked
  // a question, not for a transcript of the work; the work is a click away.
  const work: WorkItem[] = [];
  const answers: { key: string; text: string; streaming: boolean }[] = [];
  if (message.reasoning) work.push({ kind: "think", key: "reasoning", text: message.reasoning });
  message.parts.forEach((part, i) => {
    if (part.kind === "tool") {
      work.push({ kind: "tool", key: part.id, call: part });
      return;
    }
    splitThinking(part.text).forEach((segment, j) => {
      const key = `${i}-${j}`;
      if (segment.kind === "think") work.push({ kind: "think", key, text: segment.text });
      else answers.push({ key, text: segment.text, streaming: part.streaming });
    });
  });

  // The caret belongs on the last thing on screen, wherever the turn happens
  // to be: after the prose while it writes, in the dropdown while it thinks
  // or a tool runs.
  const lastIsAnswer =
    message.parts.at(-1)?.kind === "text" && answers.length > 0 && answers.at(-1)!.streaming;
  const working = message.streaming && !lastIsAnswer && work.length > 0;

  return (
    <div ref={ref} className="flex flex-col gap-2">
      {work.length > 0 && <WorkDropdown items={work} working={working} message={message} />}

      {answers.map((answer, i) => {
        const caret = message.streaming && lastIsAnswer && i === answers.length - 1;
        // Rendered as Markdown, which is what the model writes whether or
        // not anything draws it: the alternative is the reader picking
        // headings and tables out of their own syntax. The prose still being
        // written parses only its unfinished tail on each update.
        return caret ? (
          <StreamingMarkdown key={answer.key} className="streaming-caret">
            {answer.text}
          </StreamingMarkdown>
        ) : (
          <Markdown key={answer.key}>{answer.text}</Markdown>
        );
      })}

      {/* A turn that has produced nothing yet still shows it is alive. */}
      {message.streaming && work.length === 0 && answers.length === 0 && (
        <p className="text-sm">
          <Caret />
        </p>
      )}

      {stop && (
        // Neither of these is a failure, so neither is dressed as one: a
        // muted note, not the red border a `turn_failed` gets.
        <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
          <SquareIcon className="size-3" />
          {stop}
        </p>
      )}

      {message.error && (
        <p className="border-destructive/40 text-destructive flex items-start gap-2 rounded-lg border px-3 py-2 text-sm">
          <AlertCircleIcon className="mt-0.5 size-4 shrink-0" />
          <span>{message.error}</span>
        </p>
      )}

      {/* Under every finished answer: how long it took, and what the reader
          made of it. Not while the turn is still running -- a rating on an
          unfinished answer would be a rating of the wrong thing. */}
      {!message.streaming && message.turnId && (
        <MessageFooter
          turnId={message.turnId}
          timing={describeTiming(message)}
          billing={message.provider ? billingLabel(message.provider) : null}
          rating={rating}
          onRate={onRate}
          answer={answers.map((answer) => answer.text.trim()).filter(Boolean).join("\n\n")}
        />
      )}
    </div>
  );
});

type WorkItem =
  | { kind: "think"; key: string; text: string }
  | { kind: "tool"; key: string; call: ToolPart };

/**
 * The model's thinking and tool calls, folded into one line.
 *
 * Closed by default, and it stays wherever the reader put it while the turn
 * streams: the element holds its own open state, and the items are keyed, so
 * new ones appending underneath do not reset it. The line itself says what
 * is inside -- how many thoughts, how many calls -- and, while the turn is
 * still working, that it is.
 */
function WorkDropdown({
  items,
  working,
  message,
}: {
  items: WorkItem[];
  working: boolean;
  message: ChatMessage;
}) {
  const thoughts = items.filter((i) => i.kind === "think").length;
  const calls = items.filter((i) => i.kind === "tool").length;
  const failed = items.some((i) => i.kind === "tool" && i.call.isError);
  const what = [
    thoughts ? `${thoughts} ${thoughts === 1 ? "thought" : "thoughts"}` : "",
    calls ? `${calls} ${calls === 1 ? "tool call" : "tool calls"}` : "",
  ]
    .filter(Boolean)
    .join(", ");
  const elapsed =
    !working && message.startedAt !== null && message.completedAt !== null
      ? formatCookTime(message.completedAt - message.startedAt)
      : null;

  return (
    // Named groups: this element and each ToolRow inside it are both
    // <details>, and an unnamed `group-open` on the rows would turn every
    // row's chevron the moment this one opened.
    <details className="group/work text-muted-foreground rounded-md border text-xs">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 select-none [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon className="size-3.5 shrink-0 transition-transform group-open/work:rotate-90" />
        {working ? (
          <Loader2Icon className="size-3.5 shrink-0 animate-spin" />
        ) : (
          <BrainIcon className="size-3.5 shrink-0" />
        )}
        <span className="text-foreground font-medium">{working ? "Working" : "Thought"}</span>
        <span className="truncate">{what}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {failed && <span className="text-destructive">a call failed</span>}
          {elapsed && <span className="tabular-nums">{elapsed}</span>}
        </span>
      </summary>

      <div className="flex flex-col gap-2 border-t px-3 py-2">
        {items.map((item) =>
          item.kind === "think" ? (
            <p key={item.key} className="whitespace-pre-wrap">
              {item.text.trim()}
            </p>
          ) : (
            <ToolRow key={item.key} call={item.call} />
          ),
        )}
        {working && (
          <p className="text-sm">
            <Caret />
          </p>
        )}
      </div>
    </details>
  );
}

/** One of the two arrows under a prompt. Disabled at the ends of the thread. */
function JumpButton({
  target,
  label,
  onJump,
  children,
}: {
  target: number | null;
  label: string;
  onJump: (index: number) => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={() => target !== null && onJump(target)}
      disabled={target === null}
      title={label}
      // `relative` for the label below: `sr-only` positions it absolutely,
      // and without a positioned ancestor inside the scroller it lands
      // against the panel instead, stretching the page past the composer.
      className="hover:text-foreground relative rounded-sm p-0.5 disabled:cursor-default disabled:opacity-40"
    >
      {children}
      <span className="sr-only">{label}</span>
    </button>
  );
}

/**
 * One small copy control, with a tick for a moment after it worked. Used
 * under a prompt for the text as typed, and under an answer for its prose.
 */
function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => {
        void copyText(text).then((ok) => ok && setCopied(true));
      }}
      className="text-muted-foreground hover:text-foreground flex size-7 items-center justify-center rounded-md transition-colors"
    >
      {copied ? (
        <CheckIcon className="text-ucch-active size-3.5" />
      ) : (
        <CopyIcon className="size-3.5" />
      )}
    </button>
  );
}

/**
 * The line under an answer: thumbs, a copy of that answer, and when it was
 * cooked.
 *
 * A thumb pressed again lets go of the rating -- a reaction should be as
 * easy to take back as to give. Copy takes this answer's prose only: not the
 * prompt, not earlier turns, not the thinking or tool calls behind it.
 */
function MessageFooter({
  turnId,
  timing,
  billing,
  rating,
  onRate,
  answer,
}: {
  turnId: string;
  timing: string | null;
  /** What the turn was billed to -- the one thing the chat says about a provider. */
  billing: string | null;
  rating: Rating | null;
  onRate: (turnId: string, rating: Rating | null) => void;
  /** The answer's prose, as the model wrote it. */
  answer: string;
}) {

  const thumb = (value: Rating, Icon: typeof ThumbsUpIcon, label: string) => (
    <button
      type="button"
      aria-label={label}
      aria-pressed={rating === value}
      title={label}
      onClick={() => onRate(turnId, rating === value ? null : value)}
      className={`hover:text-foreground flex size-7 items-center justify-center rounded-md transition-colors ${
        rating === value ? "text-foreground bg-muted" : ""
      }`}
    >
      <Icon className="size-3.5" />
    </button>
  );

  return (
    <div className="text-muted-foreground flex flex-wrap items-center gap-1 text-xs">
      {thumb("up", ThumbsUpIcon, "Good answer")}
      {thumb("down", ThumbsDownIcon, "Bad answer")}
      {answer && <CopyButton text={answer} label="Copy answer" />}
      {timing && <span className="ml-1 tabular-nums">{timing}</span>}
      {billing && (
        <span className="ml-1" title="Which account this turn was billed to">
          · {billing}
        </span>
      )}
    </div>
  );
}

/**
 * One tool call, collapsed to a line and expandable to its input and result
 * -- §6.7's "expandable row with input and result".
 *
 * A `<details>` rather than controlled state: there is one of these per call
 * and a turn can make dozens, and the element already does open, closed, and
 * keyboard exactly right. Collapsed by default -- the calls are how the
 * answer was reached, not the answer.
 */
function ToolRow({ call }: { call: ToolPart }) {
  const running = call.result === null;
  const duration = formatDuration(call.durationMs);
  const summary = summariseInput(call.input);

  return (
    <details
      className={`group/tool rounded-md border text-xs ${call.isError ? "border-destructive/40" : ""}`}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 select-none [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon className="text-muted-foreground size-3.5 shrink-0 transition-transform group-open/tool:rotate-90" />
        <span className="font-mono font-medium">{call.name}</span>
        {summary && <span className="text-muted-foreground truncate font-mono">{summary}</span>}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {running ? (
            call.awaitingApproval ? (
              <span className="text-ucch-active">needs approval</span>
            ) : (
              <Loader2Icon className="text-muted-foreground size-3 animate-spin" />
            )
          ) : (
            <>
              {call.isError && <span className="text-destructive">failed</span>}
              {duration && <span className="text-muted-foreground tabular-nums">{duration}</span>}
            </>
          )}
        </span>
      </summary>

      <div className="flex flex-col gap-2 border-t px-3 py-2">
        <Block label="Input" text={formatInput(call.input)} />
        {call.result !== null && (
          <Block label={call.isError ? "Error" : "Result"} text={call.result} error={call.isError} />
        )}
      </div>
    </details>
  );
}

function Block({ label, text, error }: { label: string; text: string; error?: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-muted-foreground text-[0.7rem] tracking-wide uppercase">{label}</span>
      {/* Capped and scrollable: a `grep` across a repository must not push
          the composer off the bottom of the screen. */}
      <pre
        className={`bg-muted/50 max-h-40 overflow-auto rounded p-2 font-mono text-xs whitespace-pre-wrap @md:max-h-64 ${
          error ? "text-destructive" : ""
        }`}
      >
        {text}
      </pre>
    </div>
  );
}

function Caret() {
  return <span className="bg-ucch-active ml-0.5 inline-block h-4 w-1.5 align-text-bottom" />;
}

/** The arguments as the model sent them, pretty-printed where they are JSON. */
function formatInput(input: unknown): string {
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input, null, 2) ?? String(input);
  } catch {
    // Circular, or something else JSON cannot hold. Showing what it is beats
    // an empty block.
    return String(input);
  }
}

function isProviderId(value: unknown): value is ProviderId {
  return value === "native" || value === "claude" || value === "codex";
}

/** How each mode is named and drawn wherever it is shown. */
const MODE_LABEL: Record<MessageMode, string> = {
  research: "Research",
  documentation: "Documentation",
};
const MODE_ICON: Record<MessageMode, typeof TelescopeIcon> = {
  research: TelescopeIcon,
  documentation: FileTextIcon,
};

/**
 * The mode a shared draft carries: null for none, undefined when the draft
 * says nothing. A draft from before `mode` existed may still carry the old
 * `research` flag.
 */
export function draftMode(draft: ComposerDraft): MessageMode | null | undefined {
  if (draft.mode !== undefined) return draft.mode;
  if (draft.research !== undefined) return draft.research ? "research" : null;
  return undefined;
}

/** What the prompt box holds, as it is shared: only files that have reached the server travel. */
function composerDraft(
  text: string,
  attachments: readonly Attachment[],
  reference: CodeReference | null,
  mode: MessageMode | null,
  effort: ReasoningEffort,
): ComposerDraft {
  return {
    text,
    attachments: attachments
      .filter((a) => a.status === "staged" && a.uploadId)
      .map((a) => ({
        id: a.id,
        name: a.name,
        size: a.size,
        type: a.type,
        text: a.text,
        uploadId: a.uploadId,
        status: a.status,
      })),
    reference,
    // Both, so a window still running the old build keeps its toggle right.
    research: mode === "research",
    ...(mode ? { mode } : {}),
    effort,
  };
}
