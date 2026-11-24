"use client"

import * as React from "react"
import {
  ArrowUpIcon,
  ChevronRightIcon,
  Loader2Icon,
  PlusIcon,
  QuoteIcon,
  ServerIcon,
  SparklesIcon,
  SquareIcon,
  TerminalIcon,
  XIcon,
} from "lucide-react"
import type { DomainEvent, SshHostSummary } from "@ucch/protocol"

import { TranscriptTurn } from "@/components/chat-transcript"
import { PermissionPromptCard } from "@/components/permission-prompt"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { formatDuration, summariseInput, toMessages, type ToolPart } from "@/lib/chat-messages"
import { useRealtime } from "@/lib/realtime"
import { fetchRemoteChat, replyRemoteChat, sendRemoteChat, stopRemoteChat } from "@/lib/ssh-api"
import { cn } from "@/lib/utils"
import type { AskRequest } from "@/components/terminal/remote-terminal-workspace"

const CHATS_KEY = "ucch.terminal.chats"

/** The conversation last open per server, so a reload picks it up while the server still holds it. */
function rememberedChat(hostId: string): string | null {
  try {
    const map = JSON.parse(window.localStorage.getItem(CHATS_KEY) ?? "{}") as Record<string, string>
    return typeof map[hostId] === "string" ? map[hostId] : null
  } catch {
    return null
  }
}

function rememberChat(hostId: string, chatId: string): void {
  try {
    const map = JSON.parse(window.localStorage.getItem(CHATS_KEY) ?? "{}") as Record<string, string>
    map[hostId] = chatId
    window.localStorage.setItem(CHATS_KEY, JSON.stringify(map))
  } catch {
    /* not remembered */
  }
}

/** Shell commands the agent suggested in its last answer, to paste into a terminal. */
function suggestedCommands(text: string): string[] {
  const found: string[] = []
  for (const match of text.matchAll(/```(?:bash|sh|shell|console|zsh)?\n([\s\S]*?)```/g)) {
    const command = match[1]!.replace(/^\$ /gm, "").trim()
    if (command && command.length <= 2000) found.push(command)
  }
  return found.slice(0, 3)
}

/**
 * The agent beside the terminals. It works on one server -- the focused
 * pane's, unless another is picked -- running commands and editing files
 * there, and asks before each one.
 *
 * Its events arrive on the person's own topic and are folded like a
 * thread's, so it draws with the chat's own transcript and approval card.
 */
export function RemoteChatPanel({
  hosts,
  focusedHostId,
  ask,
  onInsert,
  onClose,
}: {
  hosts: SshHostSummary[]
  focusedHostId: string | null
  ask: AskRequest | null
  onInsert: (command: string) => void
  onClose: () => void
}) {
  const { client } = useRealtime()
  const [pickedHostId, setPickedHostId] = React.useState<string | null>(null)
  const hostId = pickedHostId ?? focusedHostId ?? hosts[0]?.id ?? null
  const host = hosts.find((h) => h.id === hostId) ?? null

  const [chatId, setChatId] = React.useState<string | null>(null)
  const [events, setEvents] = React.useState<{ event: DomainEvent; receivedAt: number }[]>([])
  const [loaded, setLoaded] = React.useState(false)
  const [draft, setDraft] = React.useState("")
  const [quote, setQuote] = React.useState<string | null>(null)
  const [sending, setSending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const scroller = React.useRef<HTMLDivElement>(null)
  const input = React.useRef<HTMLTextAreaElement>(null)

  // The conversation for this server: the one this browser had, if the
  // server still holds it, else a fresh one.
  React.useEffect(() => {
    if (!hostId) return
    let cancelled = false
    const remembered = rememberedChat(hostId)
    setLoaded(false)
    setEvents([])
    setError(null)
    if (!remembered) {
      setChatId(crypto.randomUUID())
      setLoaded(true)
      return
    }
    setChatId(remembered)
    fetchRemoteChat(remembered).then(
      (history) => {
        if (cancelled) return
        if (history.hostId === hostId) setEvents(history.events.map((event) => ({ event, receivedAt: Date.now() })))
        else setChatId(crypto.randomUUID())
        setLoaded(true)
      },
      () => {
        // Gone with a restart or after a quiet couple of hours: start again.
        if (cancelled) return
        setChatId(crypto.randomUUID())
        setLoaded(true)
      },
    )
    return () => {
      cancelled = true
    }
  }, [hostId])

  React.useEffect(() => {
    if (!client || !chatId) return
    return client.onEvent(({ event }) => {
      if (event.type !== "remote_chat.event" || event.chatId !== chatId) return
      setEvents((current) => [...current, { event: event.event as unknown as DomainEvent, receivedAt: Date.now() }])
    })
  }, [client, chatId])

  // A selection someone asked about, quoted into the next message.
  React.useEffect(() => {
    if (!ask) return
    if (ask.hostId !== hostId) setPickedHostId(ask.hostId)
    setQuote(ask.text.slice(0, 20_000))
    input.current?.focus()
  }, [ask?.token]) // eslint-disable-line react-hooks/exhaustive-deps

  const state = React.useMemo(() => toMessages(events), [events])
  const lastAnswer = [...state.messages].reverse().find((m) => m.role === "assistant")
  const commands =
    !state.running && lastAnswer
      ? suggestedCommands(lastAnswer.parts.map((p) => (p.kind === "text" ? p.text : "")).join("\n"))
      : []

  React.useEffect(() => {
    const element = scroller.current
    if (element) element.scrollTop = element.scrollHeight
  }, [events.length])

  async function send() {
    const text = draft.trim()
    if (!text || !hostId || !chatId || sending || state.running) return
    setSending(true)
    setError(null)
    try {
      await sendRemoteChat(hostId, { chatId, text, ...(quote ? { selection: quote } : {}) })
      rememberChat(hostId, chatId)
      setDraft("")
      setQuote(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSending(false)
    }
  }

  function startOver() {
    if (state.running && chatId) void stopRemoteChat(chatId).catch(() => {})
    const next = crypto.randomUUID()
    setChatId(next)
    setEvents([])
    setError(null)
    if (hostId) rememberChat(hostId, next)
  }

  return (
    <aside aria-label="Server agent" className="bg-sidebar/40 flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-1 border-b px-2 text-xs">
        <SparklesIcon className="text-ucch-active size-3.5 shrink-0" />
        <span className="font-medium">Agent</span>
        <span className="text-muted-foreground">on</span>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button
                type="button"
                className="hover:bg-muted flex min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5 font-medium"
              />
            }
          >
            <ServerIcon className="text-muted-foreground size-3 shrink-0" />
            <span className="truncate">{host?.name ?? "a server"}</span>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-56" align="start">
            <DropdownMenuLabel>Work on</DropdownMenuLabel>
            {hosts.map((h) => (
              <DropdownMenuItem key={h.id} onClick={() => setPickedHostId(h.id)}>
                <ServerIcon className="text-muted-foreground" />
                <span className="truncate">{h.name}</span>
                {h.id === focusedHostId && <span className="text-muted-foreground ml-auto text-[11px]">focused</span>}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="ml-auto flex shrink-0 items-center">
          <IconButton label="New conversation" onClick={startOver}>
            <PlusIcon />
          </IconButton>
          <IconButton label="Close agent" onClick={onClose}>
            <XIcon />
          </IconButton>
        </div>
      </div>

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {!loaded ? (
          <div className="text-muted-foreground flex items-center gap-2 text-xs">
            <Loader2Icon className="size-3 animate-spin" />
            Opening the conversation…
          </div>
        ) : state.messages.length === 0 ? (
          <div className="text-muted-foreground flex flex-col gap-2 text-sm">
            <p>
              Ask about {host ? <span className="text-foreground font-medium">{host.name}</span> : "this server"}: why a
              service is down, what is filling the disk, how to set something up.
            </p>
            <p className="text-xs">
              Select text in a terminal and choose <span className="text-foreground">Ask the agent</span> to quote it.
              Every command it wants to run, and every file it wants to change, waits for your approval.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {state.messages.map((message, index) =>
              message.role === "user" ? (
                <UserBubble key={index} text={message.text} />
              ) : (
                <div key={index} className="text-sm">
                  <TranscriptTurn
                    message={message}
                    renderCompaction={(_part, key) => <hr key={key} className="my-2" />}
                    caret={<Loader2Icon className="text-muted-foreground size-3 animate-spin" />}
                  />
                  {message.error && (
                    <p role="alert" className="text-destructive mt-2 text-xs break-words">
                      {message.error}
                    </p>
                  )}
                </div>
              ),
            )}
          </div>
        )}
      </div>

      {state.prompts.map((prompt) => (
        <div key={prompt.requestId} className="border-t px-2 py-2">
          <PermissionPromptCard
            prompt={prompt}
            onReply={(requestId, behavior, _message, scope) =>
              chatId ? replyRemoteChat(chatId, { requestId, behavior, scope: scope ?? "once" }) : Promise.resolve()
            }
          />
        </div>
      ))}

      {commands.length > 0 && (
        <div className="flex flex-col gap-1 border-t px-2 py-2">
          {commands.map((command, i) => (
            <button
              key={i}
              type="button"
              onClick={() => onInsert(command)}
              title="Paste into the focused terminal (it does not press Enter)"
              className="hover:border-ucch-active/60 hover:bg-muted/50 flex items-center gap-2 rounded-md border px-2 py-1 text-left"
            >
              <TerminalIcon className="text-muted-foreground size-3.5 shrink-0" />
              <code className="truncate font-mono text-[11px]">{command.split("\n")[0]}</code>
              <span className="text-muted-foreground ml-auto shrink-0 text-[11px]">Paste</span>
            </button>
          ))}
        </div>
      )}

      <form
        className="border-t p-2"
        onSubmit={(event) => {
          event.preventDefault()
          void send()
        }}
      >
        {quote && (
          <div className="bg-muted/60 mb-2 flex items-start gap-2 rounded-md px-2 py-1.5">
            <QuoteIcon className="text-muted-foreground mt-0.5 size-3 shrink-0" />
            <pre className="text-muted-foreground max-h-20 min-w-0 flex-1 overflow-hidden font-mono text-[11px] whitespace-pre-wrap">
              {quote}
            </pre>
            <button type="button" onClick={() => setQuote(null)} className="text-muted-foreground hover:text-foreground">
              <XIcon className="size-3" />
              <span className="sr-only">Remove the quote</span>
            </button>
          </div>
        )}
        {error && (
          <p role="alert" className="text-destructive mb-2 text-xs break-words">
            {error}
          </p>
        )}
        <div className="focus-within:border-ucch-active/60 focus-within:ring-ucch-active/20 focus-within:ring-2 bg-background flex items-end gap-2 rounded-lg border px-2 py-1.5">
          <textarea
            ref={input}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                void send()
              }
            }}
            rows={2}
            placeholder={host ? `Ask about ${host.name}…` : "Pick a server first"}
            disabled={!host || !loaded}
            className="max-h-40 min-h-10 flex-1 resize-none bg-transparent text-sm focus-visible:outline-none"
          />
          {state.running ? (
            <button
              type="button"
              onClick={() => chatId && void stopRemoteChat(chatId)}
              title="Stop"
              className="bg-foreground text-background flex size-7 shrink-0 items-center justify-center rounded-md"
            >
              <SquareIcon className="size-3" />
              <span className="sr-only">Stop</span>
            </button>
          ) : (
            <button
              type="submit"
              disabled={!draft.trim() || sending || !host}
              title="Send"
              className="bg-primary text-primary-foreground flex size-7 shrink-0 items-center justify-center rounded-md disabled:opacity-40"
            >
              {sending ? <Loader2Icon className="size-3.5 animate-spin" /> : <ArrowUpIcon className="size-3.5" />}
              <span className="sr-only">Send</span>
            </button>
          )}
        </div>
      </form>
    </aside>
  )
}

function UserBubble({ text }: { text: string }) {
  // The quote travels inside the message; drawn as a block of its own.
  const at = text.indexOf("\n\nFrom my terminal:\n```\n")
  const said = at >= 0 ? text.slice(0, at) : text
  const quoted = at >= 0 ? text.slice(at).replace("\n\nFrom my terminal:\n```\n", "").replace(/\n```$/, "") : null
  return (
    <div className="bg-muted ml-6 self-end rounded-lg px-3 py-2 text-sm">
      <p className="whitespace-pre-wrap break-words">{said}</p>
      {quoted && (
        <pre className="text-muted-foreground mt-1.5 max-h-32 overflow-hidden border-l-2 pl-2 font-mono text-[11px] whitespace-pre-wrap">
          {quoted}
        </pre>
      )}
    </div>
  )
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      onClick={onClick}
      className="text-muted-foreground hover:bg-muted hover:text-foreground flex size-6 items-center justify-center rounded-md [&_svg]:size-3.5"
    >
      {children}
      <span className="sr-only">{label}</span>
    </button>
  )
}
