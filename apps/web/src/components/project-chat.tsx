"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import {
  AlertCircleIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  BlocksIcon,
  BrainIcon,
  CheckIcon,
  CodeIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  CopyIcon,
  DownloadIcon,
  ImageIcon,
  Loader2Icon,
  PaperclipIcon,
  PlusIcon,
  SparklesIcon,
  SquareIcon,
  TelescopeIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
  XIcon,
} from "lucide-react";

import { useFilesPanel } from "@/components/files-panel";
import {
  EffortSelect,
  ModelSelect,
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
import { Markdown } from "@/components/markdown";
import { TurnProgress } from "@/components/turn-progress";
import { PermissionPromptCard } from "@/components/permission-prompt";
import { UcchClient, type ClientEvent } from "@/lib/client";
import {
  readLastModel,
  readLastProvider,
  rememberLastModel,
  rememberLastProvider,
} from "@/lib/model-preference";
import { ProviderSelect, useProviders } from "@/components/provider-picker";
import { billingLabel, type ProviderId } from "@/lib/providers-api";
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
  summariseInput,
  toMessages,
  type ChatMessage,
  type ToolPart,
} from "@/lib/chat-messages";
import { readRatings, transcript, writeRating, type Rating } from "@/lib/chat-feedback";
import { copyText } from "@/lib/clipboard";
import { codeChatPrompt, type CodeReference } from "@/lib/code-chat";
import { basename } from "@/lib/files-api";
import type { ComposerDraft, MessageImage, ReasoningEffort } from "@ucch/protocol";
import type { Project } from "@/lib/session";
import { ServerError } from "@/lib/client";
import { createComposerSync, type ComposerSync } from "@/lib/composer-sync";
import { isOwnChange, othersAt, usePresence, usePresenceLocation, useProjectEvents, useToast } from "@/lib/realtime";

/**
 * The conversation view for one project.
 *
 * Everything on screen is derived from the event log rather than held
 * separately: a message is what the server recorded, and a reply in progress
 * is the deltas that have arrived so far. Reloading mid-turn therefore shows
 * the same thread, because there is no local state to lose.
 */
export function ProjectChat({ project }: { project: Project }) {
  // Owned by the effect below rather than by a memo: the effect is what
  // connects and what closes, so tying the client's lifetime to anything else
  // leaves a socket alive that nothing is reading. A ref, because the
  // composer needs it without re-rendering when it changes.
  const clientRef = useRef<UcchClient | null>(null);
  const [events, setEvents] = useState<readonly ClientEvent[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
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
   * socket that is already open rather than a second one of its own, and an
   * open file the model rewrote is reread underneath the editor.
   */
  const { noteChanged } = useFilesPanel();
  const seenFileEvents = useRef(0);

  useEffect(() => {
    for (let i = seenFileEvents.current; i < events.length; i++) {
      const event = events[i]!.event;
      if (event.type === "file.changed") noteChanged(event.path, event.change);
    }
    seenFileEvents.current = events.length;
  }, [events, noteChanged]);

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
   * Whether the next message runs the research pipeline before anything
   * else. Stays on across sends, like a mode rather than an attachment: a
   * person researching asks several questions in a row.
   *
   * Any provider, any thread. On the native loop the research is the turn;
   * on Claude Code or Codex it runs first, on OpenRouter, and the CLI is
   * handed the brief with the message -- so a thread that has been running
   * under a CLI for an hour can still switch it on for the next question.
   */
  const [research, setResearch] = useState(false);

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
   * Pictures attached to a model that cannot look at them.
   *
   * Checked here rather than left to the server, which would fail the turn
   * after the message has left the composer. Only the native loop has a
   * catalogue that says; a CLI harness is trusted to see.
   */
  const vision = cli
    ? null
    : visionWarning(pendingImageCount(attachments), models.find((m) => m.id === model));

  useEffect(() => {
    const client = new UcchClient();
    clientRef.current = client;

    const unsubscribe = client.subscribeToChanges(() => setEvents(client.events));

    let cancelled = false;
    void (async () => {
      await client.connect();
      if (cancelled) return;

      // A project's conversation lives in a thread. Reuse the newest one so a
      // reload continues where it left off; only create when there is none.
      const response = await fetch(`/api/projects/${project.hash}/threads`, {
        credentials: "include",
      });
      const newest = response.ok
        ? ((await response.json()) as { threads: Array<{ id: string; provider?: string | null }> })
            .threads[0]
        : undefined;

      if (cancelled) return;
      const id = newest?.id ?? (await createThread(client, project.id));
      if (cancelled || !id) return;

      setThreadId(id);
      // A thread that has run is bound to its provider; the picker shows it
      // locked rather than offering a switch the server would refuse.
      setBoundProvider(isProviderId(newest?.provider) ? newest.provider : null);
      await client.subscribe({ name: "thread", threadId: id });
    })().catch(() => {
      // The socket closing mid-setup is ordinary: unmount, or a drop the
      // client will reconnect from on its own.
    });

    return () => {
      cancelled = true;
      unsubscribe();
      client.close();
      clientRef.current = null;
    };
  }, [project.id, project.hash]);

  /**
   * "Clear context" in another window starts a new thread; this one follows
   * it when it was showing the newest conversation -- the one the other
   * window just moved on from. A window deliberately left on an older thread
   * stays there.
   */
  const toast = useToast();
  const threadIdRef = useRef<string | null>(null);
  threadIdRef.current = threadId;
  const newestRef = useRef<string | null>(null);
  useEffect(() => {
    if (threadId && newestRef.current === null) newestRef.current = threadId;
  }, [threadId]);

  useProjectEvents(project.id, (event) => {
    if (event.type !== "thread.created" || event.projectId !== project.id) return;
    const followed = threadIdRef.current === newestRef.current;
    newestRef.current = event.threadId;
    if (!followed || threadIdRef.current === event.threadId) return;
    const client = clientRef.current;
    if (!client) return;
    void client.subscribe({ name: "thread", threadId: event.threadId }).catch(() => {});
    setThreadId(event.threadId);
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
   * typing at once is a conflict the server settles: the later one is told,
   * and its unsent keystrokes are replaced by what the other wrote.
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
        if (draft.research !== undefined) setResearch(draft.research);
        if (draft.effort !== undefined) setEffort(draft.effort);
      },
      onReverted: () =>
        toast({
          tone: "error",
          title: "The prompt was changed in another window",
          description: "You were both typing; your latest keystrokes were reverted to theirs.",
        }),
    });
    syncRef.current = sync;
    const off = client.onEvent(({ event }) => {
      if (event.type !== "composer.changed" || event.threadId !== threadId) return;
      const own = isOwnChange(event.origin);
      if (!own && event.origin) setRemoteTypingAt(Date.now());
      sync.remote({ rev: event.rev, draft: event.draft, own });
    });
    return () => {
      off();
      sync.dispose();
      if (syncRef.current === sync) syncRef.current = null;
    };
  }, [threadId, toast]);

  // Every local change to the box -- typing, a chip, a toggle -- goes out.
  // A change that came in from elsewhere is the synced draft already, and
  // `local` ignores it.
  useEffect(() => {
    syncRef.current?.local(composerDraft(draft, attachments, reference, research, effort));
  }, [draft, attachments, reference, research, effort]);

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
  }, [events.length]);

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
   * The events of the thread on screen.
   *
   * The client's buffer is per connection, not per thread, so after a
   * context clear it holds the old conversation as well as the new one.
   * Filtering here rather than emptying the buffer keeps the client a plain
   * record of what the server said, and keeps `file.changed` -- which is
   * project-scoped and carries no thread -- reaching the file panel below.
   */
  const threadEvents = useMemo(
    () =>
      events.filter(
        (row) => "threadId" in row.event && row.event.threadId === threadId,
      ),
    [events, threadId],
  );

  const { messages, running, active, prompts, contextTokens } = useMemo(
    () => toMessages(threadEvents),
    [threadEvents],
  );

  /**
   * Alt+Up / Alt+Down through what was asked before. The entries are the
   * thread's own user messages, oldest first; the cursor resets whenever the
   * draft is edited by hand so a recalled prompt that was then changed is
   * treated as new typing, not as a position in the walk.
   */
  const history = useRef<HistoryCursor>(idleCursor);
  const promptHistory = useMemo(
    () => messages.filter((m) => m.role === "user" && m.text.trim()).map((m) => m.text),
    [messages],
  );
  const neighbours = useMemo(() => promptNeighbours(messages), [messages]);

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
  const copyConversation = useCallback(() => copyText(transcript(messages)), [messages]);

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
        ...(cli ? {} : { effort }),
        provider,
        ...(research ? { mode: "research" as const } : {}),
      });
      // From here on the thread is bound, whatever the picker said before.
      setBoundProvider(provider);
      // Your own message is the one thing you always want to see land.
      scrollToEnd();
    },
    [cli, cliModel, effort, model, provider, research, scrollToEnd, threadId],
  );

  const send = useCallback(async () => {
    // Attachments alone are a message: "here, look at this" is a real thing
    // to say, and the files carry it. A code reference alone is not: it says
    // where to look but not what to do.
    const text = composeMessage(
      reference ? (draft.trim() ? codeChatPrompt(reference, draft) : "") : draft,
      attachments,
    );
    if (!text || !threadId || sending || vision) return;

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
  }, [attachments, dispatchMessage, draft, reference, sending, threadId, vision]);

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
   */
  const clearContext = useCallback(async () => {
    const client = clientRef.current;
    if (!client || clearing || running) return;

    setClearing(true);
    setError(null);
    try {
      const id = await createThread(client, project.id);
      if (!id) throw new Error("could not start a new conversation");
      await client.subscribe({ name: "thread", threadId: id });
      setThreadId(id);
      // A fresh thread is bound to nothing yet, so the picker opens again.
      setBoundProvider(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setClearing(false);
    }
  }, [clearing, project.id, running]);


  return (
    // `@container`, not viewport breakpoints: the chat is a panel, not the
    // window. The file tree opens beside it and the sidebar collapses, so it
    // can be phone-narrow on a desktop -- and everything inside sizes against
    // this box rather than against a screen it may only have a third of.
    <div ref={panelRef} className="@container flex min-h-0 flex-1 flex-col">
      {/* `relative` for the button below, which floats over the thread's
          floor rather than taking a row of its own. */}
      <div className="relative min-h-0 flex-1">
        <div
          ref={listRef}
          onScroll={noteScroll}
          className="h-full overflow-y-auto p-3 @md:p-4"
        >
          <div className="mx-auto flex max-w-3xl flex-col gap-3 @md:gap-4">
            {messages.length === 0 ? (
              <p className="text-muted-foreground py-8 text-center text-sm">
                Nothing yet. Ask the agent something about this project.
              </p>
            ) : (
              messages.map((message, i) => (
                <Message
                  key={i}
                  ref={(el) => {
                    if (el) blockRefs.current.set(i, el);
                    else blockRefs.current.delete(i);
                  }}
                  message={message}
                  hash={project.hash}
                  onPreview={setPreviewing}
                  rating={message.turnId ? (ratings[message.turnId] ?? null) : null}
                  onRate={rate}
                  onCopyConversation={copyConversation}
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
      <div className="shrink-0 border-t p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] @md:p-4 @md:pb-[max(1rem,env(safe-area-inset-bottom))]">
        {/* A fifth wider than the thread it sits under: the composer is one
            box you work inside -- text, files and the controls that act on
            them -- and it needs the room the reading column does not. */}
        <div className="mx-auto flex w-full max-w-[57.6rem] flex-col gap-2">
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
          {/* The whole box is the input now, not just the textarea: the
              border and focus ring live out here so the plus and the send
              button read as being inside the field rather than beside it.
              `focus-within` puts the ring up when the textarea inside takes
              focus, which is the only thing that ever does. */}
          <form
            className="border-input bg-background focus-within:ring-ring flex flex-col rounded-xl border focus-within:ring-2"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
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
              onKeyDown={(e) => {
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
                // Alt+Up recalls the previous prompt; Alt+Down comes forward.
                const direction = historyDirection(e);
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
                    ? research
                      ? "Researching…"
                      : "The agent is working…"
                    : research
                      ? "What should the agent find out?"
                      : "Ask the agent to change this project…"
                  : "Opening the thread…"
              }
              className="placeholder:text-muted-foreground w-full resize-none border-0 bg-transparent px-3 pt-3 pb-1 text-sm focus:outline-none disabled:opacity-60"
            />

            {/* The controls, on the floor of the box. Plus on the left where
                the eye starts, send on the right where the sentence ends. */}
            <div className="flex items-center gap-1 px-2 pb-2">
              <AttachMenu
                disabled={!threadId || sending || running}
                onAddFiles={() => fileRef.current?.click()}
                research={research}
                onResearch={setResearch}
                researchNote={
                  cli
                    ? `Researches on OpenRouter first, then hands ${provider} the brief with your message`
                    : "Find live information with Perplexity Sonar, read the pages with Crawl4AI, and send a browser agent where the crawler cannot go"
                }
              />
              {/* The mode, shown where it was switched on. A toggle buried
                  in a menu needs something visible saying it is still on,
                  and this is also the fastest way to turn it off. */}
              {research && (
                <button
                  type="button"
                  onClick={() => setResearch(false)}
                  disabled={sending || running}
                  title={
                    cli
                      ? `Research mode: researched on OpenRouter first, then handed to ${provider}. Click to turn off.`
                      : "Research mode: search, read, then browse. Click to turn off."
                  }
                  className="bg-ucch-active-bg text-foreground hover:text-muted-foreground flex h-7 items-center gap-1 rounded-full py-1 pr-1.5 pl-2 text-xs transition-colors disabled:opacity-60"
                >
                  <TelescopeIcon className="size-3.5" />
                  Research
                  <XIcon className="size-3 opacity-70" />
                  <span className="sr-only">Turn research off</span>
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

              <div className="ml-auto flex items-center gap-1">
                {running ? (
                  // The same button position, so the reader does not have to
                  // look for it: while a turn runs, Send is Stop. The server
                  // refuses a second message on a running thread anyway.
                  <Button
                    type="button"
                    size="icon"
                    variant="secondary"
                    className="size-8 rounded-full"
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
                    className="size-8 rounded-full"
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
                      vision !== null
                    }
                  >
                    {sending ? <Loader2Icon className="animate-spin" /> : <ArrowUpIcon />}
                    <span className="sr-only">Send</span>
                  </Button>
                )}
              </div>
            </div>
          </form>

          {/* Below the composer rather than above it: the box you type in is
              what the eye goes to, so the settings that qualify a message sit
              under it instead of pushing it down the panel. */}
          <div className="flex flex-wrap items-center gap-1.5 @md:gap-2">
            {/* The harness first, then its model: which one answers decides
                which models the picker to its right can offer. */}
            <ProviderSelect
              providers={providers}
              value={provider}
              locked={boundProvider}
              onChange={chooseProvider}
              disabled={sending || running}
            />
            <ModelSelect
              models={catalogue}
              value={activeModel}
              onChange={chooseModel}
              disabled={sending || running}
            />
            {!cli && (
              <EffortSelect
                value={effort}
                onChange={setEffort}
                disabled={sending}
                supported={reasons}
              />
            )}
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
            {error && <span className="text-destructive truncate text-xs">{error}</span>}
            {!error && othersHere.length > 0 && (
              <span
                className={cn(
                  "flex items-center gap-1 truncate text-xs",
                  remoteTyping ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground",
                )}
                title="This conversation and its prompt are shared live with your other windows."
              >
                <span
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    remoteTyping ? "animate-pulse bg-amber-500" : "bg-emerald-500",
                  )}
                />
                {remoteTyping ? "Typing in another window…" : "Open in another window"}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The plus inside the composer.
 *
 * Two entries work today -- files, and the Research toggle; the rest are
 * named because the menu is the place a user goes looking for them, and a
 * menu that grows an item later teaches nothing about where the first one
 * lives. They are disabled rather than hidden -- "not yet" is information,
 * and an empty menu is not.
 *
 * Research is a checkbox item rather than an action: it is a mode for the
 * messages that follow, not something added to this one.
 */
function AttachMenu({
  disabled,
  onAddFiles,
  research,
  onResearch,
  researchNote,
}: {
  disabled: boolean;
  onAddFiles: () => void;
  research: boolean;
  onResearch: (on: boolean) => void;
  /** What turning it on does under the current provider. */
  researchNote: string;
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
          checked={research}
          onCheckedChange={(checked) => onResearch(checked)}
          title={researchNote}
        >
          <TelescopeIcon />
          Research
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Creates a thread and returns its id, or null if the command was refused. */
async function createThread(client: UcchClient, projectId: string): Promise<string | null> {
  const created = await client.dispatch({ type: "thread.create", projectId });
  const event = created[0]?.event;
  return event?.type === "thread.created" ? event.threadId : null;
}


function Message({
  ref,
  message,
  hash,
  onPreview,
  rating,
  onRate,
  onCopyConversation,
  neighbours,
  onJump,
}: {
  ref: Ref<HTMLDivElement>;
  message: ChatMessage;
  hash: string;
  onPreview: (file: PreviewableAttachment) => void;
  rating: Rating | null;
  onRate: (turnId: string, rating: Rating | null) => void;
  onCopyConversation: () => Promise<boolean>;
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
        {message.mode === "research" && (
          <span className="text-muted-foreground flex items-center gap-1 text-[0.7rem] tracking-wide uppercase">
            <TelescopeIcon className="size-3" />
            Research
          </span>
        )}
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
                      <span className="shrink-0 opacity-60">{formatBytes(file.size)}</span>
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
                    <span className="shrink-0 opacity-60">{formatBytes(file.size)}</span>
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
          {/* Up to the previous prompt, down to the next. Faded, so they
              read as a rail beside the conversation rather than part of it;
              disabled rather than hidden at the ends so they stay put. */}
          {neighbours && (
            <span className="ml-1 flex items-center opacity-40 transition-opacity hover:opacity-100">
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

      {answers.map((answer, i) => (
        // Rendered as Markdown, which is what the model writes whether or
        // not anything draws it: the alternative is the reader picking
        // headings and tables out of their own syntax.
        <Markdown
          key={answer.key}
          className={
            message.streaming && lastIsAnswer && i === answers.length - 1
              ? "streaming-caret"
              : undefined
          }
        >
          {answer.text}
        </Markdown>
      ))}

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
          onCopyConversation={onCopyConversation}
        />
      )}
    </div>
  );
}

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

/**
 * The line under an answer: thumbs, a copy of the whole conversation, and
 * when it was cooked.
 *
 * A thumb pressed again lets go of the rating -- a reaction should be as
 * easy to take back as to give. Copy takes the conversation rather than the
 * one answer because that is what gets pasted into an issue or a colleague's
 * chat: the question is what makes the answer make sense.
 */
/**
 * One small copy control, with a tick for a moment after it worked. The
 * footer under an answer has its own for the whole conversation; this is
 * the same gesture for one message.
 */
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

function MessageFooter({
  turnId,
  timing,
  billing,
  rating,
  onRate,
  onCopyConversation,
}: {
  turnId: string;
  timing: string | null;
  /** What the turn was billed to -- the one thing the chat says about a provider. */
  billing: string | null;
  rating: Rating | null;
  onRate: (turnId: string, rating: Rating | null) => void;
  onCopyConversation: () => Promise<boolean>;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

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
      <button
        type="button"
        aria-label="Copy conversation"
        title="Copy the whole conversation"
        onClick={() => {
          void onCopyConversation().then((ok) => ok && setCopied(true));
        }}
        className="hover:text-foreground flex size-7 items-center justify-center rounded-md transition-colors"
      >
        {copied ? <CheckIcon className="text-ucch-active size-3.5" /> : <CopyIcon className="size-3.5" />}
      </button>
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

/** What the prompt box holds, as it is shared: only files that have reached the server travel. */
function composerDraft(
  text: string,
  attachments: readonly Attachment[],
  reference: CodeReference | null,
  research: boolean,
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
    research,
    effort,
  };
}
