"use client"

import * as React from "react"
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  CheckIcon,
  ChevronRightIcon,
  ClipboardPasteIcon,
  CopyIcon,
  ExternalLinkIcon,
  EyeIcon,
  EyeOffIcon,
  Loader2Icon,
  LogInIcon,
  RotateCcwIcon,
  TimerOffIcon,
} from "lucide-react"

import { useLoginTerminal } from "@/components/login-terminal-dialog"
import { Button, buttonVariants } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { XtermPane } from "@/components/xterm-pane"
import {
  checkAuthCode,
  detectOutcome,
  extractOAuthUrl,
  hasCodePrompt,
  sanitizeSecret,
} from "@/lib/claude-login"
import { copyText } from "@/lib/clipboard"
import { cn } from "@/lib/utils"

/** A sign-in left open this long is given up on: the CLI is killed. */
const SIGN_IN_TIMEOUT_MS = 10 * 60_000
/** How long a submitted code may go unanswered before the dialog says so. */
const VERIFY_TIMEOUT_MS = 45_000
/** How long the success state shows before the dialog closes itself. */
const SUCCESS_CLOSE_MS = 1_500
/** Output kept for parsing. The address and prompt come in the first 2 KB. */
const MAX_TRANSCRIPT = 64_000

type Phase =
  /** The CLI is starting; no address yet. */
  | "starting"
  /** The address is up; waiting for a code. */
  | "ready"
  | "verifying"
  | "success"
  /** See `failure`: whether the CLI is still there to take another code. */
  | "error"
  /** Our ten minutes ran out, or the CLI's own did. */
  | "expired"

interface Failure {
  message: string
  /** The CLI has exited: trying again means a new sign-in. */
  dead: boolean
}

/**
 * Sign in to Claude Code, as a guided form over `claude auth login`.
 *
 * The CLI runs on the server in a PTY exactly as it did when this dialog was
 * a bare terminal. What changed is who reads it: `lib/claude-login.ts` pulls
 * the OAuth address and the prompt out of its output, the address becomes a
 * button, the code goes in an ordinary input -- where paste works, and the
 * user can see and edit what they pasted -- and the dialog types it into the
 * PTY itself. The terminal is still there, folded away, for when the CLI
 * says something the parser does not expect.
 *
 * This is the only way in: the server holds no Claude token of its own
 * (Claude Code legal and compliance). The CLI writes its login into its
 * config directory, and the server never reads it.
 *
 * Neither the address nor the code is ever logged: they live in React state
 * and the PTY, nowhere else.
 */
export function ClaudeLoginDialog({
  projectId,
  credentialWorkspaceId,
  profileId,
  open,
  onOpenChange,
  onSignedIn,
}: {
  projectId: string
  /** Sign in this workspace's dedicated subscription instead of your own. */
  credentialWorkspaceId?: string
  /** Which of the subject's subscription accounts to sign in; absent, its Default. */
  profileId?: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Signed in, or the CLI exited: time to look at the provider card again. */
  onSignedIn: () => void
}) {
  // Focus starts on the dialog itself, not its first field: on a phone a
  // focused input opens the keyboard before there is anything to type.
  const popupRef = React.useRef<HTMLDivElement>(null)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        ref={popupRef}
        initialFocus={popupRef}
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl [&>*]:min-w-0"
      >
        <BrowserSignIn
          projectId={projectId}
          credentialWorkspaceId={credentialWorkspaceId}
          profileId={profileId}
          open={open}
          onClose={() => onOpenChange(false)}
          onSignedIn={onSignedIn}
        />
      </DialogContent>
    </Dialog>
  )
}

function BrowserSignIn({
  projectId,
  credentialWorkspaceId,
  profileId,
  open,
  onClose,
  onSignedIn,
}: {
  projectId: string
  credentialWorkspaceId?: string
  /** Which of the subject's subscription accounts to sign in; absent, its Default. */
  profileId?: string
  open: boolean
  onClose: () => void
  onSignedIn: () => void
}) {
  const [generation, setGeneration] = React.useState(0)
  const [phase, setPhaseState] = React.useState<Phase>("starting")
  const [failure, setFailure] = React.useState<Failure | null>(null)
  const [url, setUrl] = React.useState<string | null>(null)
  const [promptReady, setPromptReady] = React.useState(false)
  const [urlOpened, setUrlOpened] = React.useState(false)
  const [copied, setCopied] = React.useState(false)
  const [copyFailed, setCopyFailed] = React.useState(false)
  const [code, setCode] = React.useState("")
  const [showCode, setShowCode] = React.useState(false)
  const [clipboardNote, setClipboardNote] = React.useState<string | null>(null)
  const [detailsOpen, setDetailsOpen] = React.useState(false)

  // The parser runs in the socket handler, ahead of React: these mirror the
  // state it reads so a chunk is judged against the phase it arrived in.
  const phaseRef = React.useRef<Phase>("starting")
  const transcript = React.useRef("")
  const submittedAt = React.useRef<number | null>(null)
  const urlRef = React.useRef<string | null>(null)
  const verifyTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const inputRef = React.useRef<HTMLInputElement>(null)

  const setPhase = React.useCallback((next: Phase) => {
    phaseRef.current = next
    setPhaseState(next)
  }, [])

  const clearVerifyTimer = () => {
    if (verifyTimer.current) clearTimeout(verifyTimer.current)
    verifyTimer.current = null
  }

  const fail = React.useCallback(
    (message: string, dead: boolean) => {
      clearVerifyTimer()
      submittedAt.current = null
      setFailure({ message, dead })
      setPhase("error")
    },
    [setPhase],
  )

  const onData = (data: string) => {
    let text = transcript.current + data
    if (text.length > MAX_TRANSCRIPT) {
      // The address is in hand by then; only what follows a submit matters.
      const keepFrom = Math.max(0, text.length - MAX_TRANSCRIPT)
      text = text.slice(keepFrom)
      if (submittedAt.current !== null) submittedAt.current = Math.max(0, submittedAt.current - keepFrom)
    }
    transcript.current = text

    if (!urlRef.current) {
      const found = extractOAuthUrl(text)
      if (found) {
        urlRef.current = found
        setUrl(found)
        if (phaseRef.current === "starting") setPhase("ready")
      }
    }
    if (hasCodePrompt(text)) setPromptReady(true)

    if (phaseRef.current !== "verifying" || submittedAt.current === null) return
    const outcome = detectOutcome(text.slice(submittedAt.current))
    if (!outcome) return
    if (outcome.kind === "success") {
      clearVerifyTimer()
      submittedAt.current = null
      setPhase("success")
      onSignedIn()
    } else if (outcome.kind === "expired") {
      clearVerifyTimer()
      submittedAt.current = null
      setFailure({ message: outcome.message, dead: true })
      setPhase("expired")
    } else {
      // "failed" ends the CLI; "invalid" leaves it prompting for another.
      fail(friendly(outcome.message), outcome.kind === "failed")
    }
  }

  const onExited = () => {
    const current = phaseRef.current
    if (current === "success" || current === "expired") return
    if (current === "error") {
      setFailure((f) => (f ? { ...f, dead: true } : f))
      return
    }
    fail(
      current === "verifying"
        ? "The sign-in ended before it said whether the code worked. Start again for a new link."
        : "The sign-in process ended unexpectedly. Start again for a new link.",
      true,
    )
    onSignedIn()
  }

  const terminal = useLoginTerminal({
    program: "claude-login",
    projectId,
    credentialWorkspaceId,
    profileId,
    active: open,
    generation,
    onData,
    onExited,
  })

  // Could not even start: the socket refused, or the server has no CLI.
  React.useEffect(() => {
    if (terminal.status === "error") fail(terminal.error ?? "Could not start the sign-in.", true)
  }, [terminal.status, terminal.error, fail])

  // Ten minutes per sign-in. The OAuth state goes stale, and a prompt left
  // running on the server is one nobody will answer.
  const { kill } = terminal
  React.useEffect(() => {
    if (!open) return
    const timer = setTimeout(() => {
      if (phaseRef.current === "success") return
      clearVerifyTimer()
      submittedAt.current = null
      setFailure({ message: "This sign-in was open for ten minutes and has expired.", dead: true })
      setPhase("expired")
      kill()
    }, SIGN_IN_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [open, generation, kill, setPhase])

  // Signed in: let the success state register, then get out of the way.
  React.useEffect(() => {
    if (phase !== "success") return
    const timer = setTimeout(onClose, SUCCESS_CLOSE_MS)
    return () => clearTimeout(timer)
  }, [phase, onClose])

  React.useEffect(() => () => clearVerifyTimer(), [])

  React.useEffect(() => {
    if (urlOpened) inputRef.current?.focus()
  }, [urlOpened])

  React.useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 2_000)
    return () => clearTimeout(timer)
  }, [copied])

  function restart() {
    clearVerifyTimer()
    transcript.current = ""
    submittedAt.current = null
    urlRef.current = null
    setUrl(null)
    setPromptReady(false)
    setUrlOpened(false)
    setCopied(false)
    setCopyFailed(false)
    setFailure(null)
    // A code belongs to the sign-in that issued it; the new one needs its own.
    setCode("")
    setShowCode(false)
    setClipboardNote(null)
    setPhase("starting")
    setGeneration((g) => g + 1)
  }

  function retry() {
    if (!failure || failure.dead) return restart()
    setFailure(null)
    setPhase("ready")
    inputRef.current?.focus()
    inputRef.current?.select()
  }

  async function copyLink() {
    if (!url) return
    if (await copyText(url)) {
      setCopied(true)
      setCopyFailed(false)
      setUrlOpened(true)
    } else {
      // Clipboard blocked: show the address to copy by hand instead.
      setCopyFailed(true)
    }
  }

  async function pasteFromClipboard() {
    setClipboardNote(null)
    try {
      const read = globalThis.navigator?.clipboard?.readText
      if (!read) throw new Error("unavailable")
      const text = await globalThis.navigator.clipboard.readText()
      const clean = sanitizeSecret(text)
      if (!clean) setClipboardNote("The clipboard is empty. Copy the code from the Claude page first.")
      else setCode(clean)
    } catch {
      setClipboardNote("Your browser didn't allow reading the clipboard. Click the field and press Ctrl+V (⌘V on a Mac).")
    }
    inputRef.current?.focus()
  }

  const check = checkAuthCode(code)
  const canSubmit =
    Boolean(url) &&
    promptReady &&
    check.ok &&
    (phase === "ready" || (phase === "error" && failure?.dead === false))

  function submit(event: React.FormEvent) {
    event.preventDefault()
    // The phase flips synchronously, so a second Enter finds it "verifying".
    if (!canSubmit || phaseRef.current === "verifying") return
    setFailure(null)
    setPhase("verifying")
    submittedAt.current = transcript.current.length
    terminal.send(`${code}\r`)
    clearVerifyTimer()
    verifyTimer.current = setTimeout(() => {
      if (phaseRef.current !== "verifying") return
      fail("Claude Code hasn't answered yet. Try again, or look under technical details.", false)
    }, VERIFY_TIMEOUT_MS)
  }

  const step: 1 | 2 | 3 = phase === "verifying" || phase === "success" || phase === "error" ? 3 : urlOpened || code ? 2 : 1
  const formLocked = phase === "verifying" || phase === "success" || phase === "expired"
  const live = liveMessage(phase, url, failure)

  return (
    <>
      <DialogHeader>
        <DialogTitle>Sign in to Claude Code</DialogTitle>
        <DialogDescription>
          Signs the server&apos;s <code className="font-mono">claude</code> CLI in to your Claude subscription. The
          credential stays in your own directory on the server; this page never sees it.
        </DialogDescription>
      </DialogHeader>

      <p role="status" aria-live="polite" className="sr-only">
        {live}
      </p>

      <StepIndicator current={step} done={phase === "success"} />

      {phase === "success" ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border px-4 py-8 text-center">
          <CheckCircle2Icon className="text-ucch-active size-8" aria-hidden />
          <p className="text-base font-medium">Signed in to Claude Code</p>
          <p className="text-muted-foreground text-sm">Closing…</p>
        </div>
      ) : phase === "expired" ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border px-4 py-8 text-center">
          <TimerOffIcon className="text-warning size-8" aria-hidden />
          <p className="text-base font-medium">Sign-in expired</p>
          <p className="text-muted-foreground max-w-sm text-sm">
            {failure?.message ?? "This sign-in has expired."} Start again for a fresh link.
          </p>
          <Button onClick={restart} className="h-11 sm:h-9">
            <RotateCcwIcon />
            Start again
          </Button>
        </div>
      ) : (
        <>
          <section aria-labelledby="claude-login-step1" className="flex flex-col gap-2">
            <h3 id="claude-login-step1" className="text-sm font-medium">
              1. Open the sign-in page
            </h3>
            <p className="text-muted-foreground text-sm">
              Approve access on Claude&apos;s site. It then shows an authorization code to copy.
            </p>
            {url ? (
              <div className="flex flex-col gap-2 sm:flex-row">
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => setUrlOpened(true)}
                  className={cn(buttonVariants({ size: "lg" }), "h-11 px-4 sm:h-9")}
                >
                  <ExternalLinkIcon />
                  Open Claude sign-in
                </a>
                <Button
                  variant="outline"
                  size="lg"
                  className="h-11 px-4 sm:h-9"
                  onClick={() => void copyLink()}
                >
                  {copied ? <CheckIcon /> : <CopyIcon />}
                  {copied ? "Copied ✓" : "Copy link"}
                </Button>
              </div>
            ) : phase === "error" ? null : (
              <div className="flex flex-col gap-2 sm:flex-row" aria-hidden>
                <Skeleton className="h-11 w-full sm:h-9 sm:w-44" />
                <Skeleton className="h-11 w-full sm:h-9 sm:w-28" />
              </div>
            )}
            {url && copyFailed && (
              <div className="flex flex-col gap-1">
                <label htmlFor="claude-login-url" className="text-warning text-xs">
                  Your browser blocked copying. Select the link below and copy it yourself.
                </label>
                <Input
                  id="claude-login-url"
                  readOnly
                  value={url}
                  autoFocus
                  onFocus={(e) => e.currentTarget.select()}
                  onCopy={() => setUrlOpened(true)}
                  className="h-11 font-mono text-base md:text-base"
                />
              </div>
            )}
          </section>

          <form onSubmit={submit} className="flex flex-col gap-2" aria-labelledby="claude-login-step2">
            <h3 id="claude-login-step2" className="text-sm font-medium">
              2. Paste your authorization code
            </h3>
            <label htmlFor="claude-login-code" className="text-muted-foreground text-sm">
              Authorization code
            </label>
            <div className="relative">
              <Input
                ref={inputRef}
                id="claude-login-code"
                name="claude-auth-code"
                type={showCode ? "text" : "password"}
                value={code}
                onChange={(e) => {
                  setCode(sanitizeSecret(e.target.value))
                  setClipboardNote(null)
                }}
                placeholder="Paste the code here"
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint="go"
                data-1p-ignore
                data-lpignore="true"
                aria-describedby="claude-login-code-hint"
                aria-invalid={code && !check.ok ? true : undefined}
                readOnly={formLocked}
                className="h-11 pr-11 font-mono text-base md:text-base"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute top-1/2 right-1.5 size-8 -translate-y-1/2"
                onClick={() => setShowCode((s) => !s)}
                aria-label={showCode ? "Hide code" : "Show code"}
                aria-pressed={showCode}
                aria-controls="claude-login-code"
              >
                {showCode ? <EyeOffIcon /> : <EyeIcon />}
              </Button>
            </div>
            <div id="claude-login-code-hint" className="flex min-h-5 flex-wrap items-center gap-x-3 text-xs">
              {clipboardNote ? (
                <span className="text-warning">{clipboardNote}</span>
              ) : code && check.hint ? (
                <span className="text-warning">{check.hint}</span>
              ) : code ? (
                <span className="text-ucch-active flex items-center gap-1">
                  <CheckIcon className="size-3.5" aria-hidden />
                  Looks like a complete code
                </span>
              ) : (
                <span className="text-muted-foreground">It looks like a long string with a “#” in the middle.</span>
              )}
              {code && <span className="text-muted-foreground tabular-nums">{code.length} characters</span>}
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button type="submit" size="lg" className="h-11 px-4 sm:h-9" disabled={!canSubmit}>
                {phase === "verifying" ? <Loader2Icon className="animate-spin" /> : <LogInIcon />}
                {phase === "verifying" ? "Verifying…" : "Sign in"}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="lg"
                className="h-11 px-4 sm:h-9"
                onClick={() => void pasteFromClipboard()}
                disabled={formLocked}
              >
                <ClipboardPasteIcon />
                Paste from clipboard
              </Button>
            </div>
          </form>

          {(phase === "verifying" || phase === "error") && (
            <section
              aria-labelledby="claude-login-step3"
              className={cn(
                "flex flex-col gap-3 rounded-lg border px-4 py-3",
                phase === "error" && "border-destructive/40",
              )}
            >
              <h3 id="claude-login-step3" className="sr-only">
                3. Verifying
              </h3>
              {phase === "verifying" ? (
                <p className="text-muted-foreground flex items-center gap-2 text-sm">
                  <Loader2Icon className="size-4 animate-spin" aria-hidden />
                  Verifying the code with Claude…
                </p>
              ) : (
                <>
                  <p className="text-destructive flex gap-2 text-sm">
                    <AlertCircleIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
                    <span>{failure?.message}</span>
                  </p>
                  <div>
                    <Button variant="outline" size="lg" className="h-11 px-4 sm:h-9" onClick={retry}>
                      <RotateCcwIcon />
                      {failure?.dead ? "Try again with a new link" : "Try again"}
                    </Button>
                  </div>
                </>
              )}
            </section>
          )}
        </>
      )}

      <div className="flex flex-col gap-3 border-t pt-3">
        <p className="text-muted-foreground text-xs">Closing this window ends the sign-in.</p>
        <Collapsible open={detailsOpen} onOpenChange={setDetailsOpen}>
          <CollapsibleTrigger
            render={<Button variant="ghost" size="sm" className="text-muted-foreground -ml-2" />}
          >
            <ChevronRightIcon className={cn("transition-transform", detailsOpen && "rotate-90")} />
            Show technical details
          </CollapsibleTrigger>
          <CollapsibleContent keepMounted>
            <p className="text-muted-foreground mt-2 text-xs">
              The <code className="font-mono">claude auth login</code> process on the server, as it runs. You can
              type into it directly if the form above gets stuck.
            </p>
            <div className="bg-background mt-2 flex h-64 w-full min-w-0 overflow-hidden rounded-md border">
              <XtermPane
                hidden={!detailsOpen || terminal.status === "connecting"}
                data={terminal.output}
                onInput={terminal.send}
                onResize={terminal.resize}
              />
            </div>
          </CollapsibleContent>
        </Collapsible>
      </div>
    </>
  )
}

const STEPS = ["Open sign-in page", "Paste code", "Verify"] as const

function StepIndicator({ current, done }: { current: 1 | 2 | 3; done: boolean }) {
  return (
    <ol className="flex items-center gap-2 text-xs" aria-label="Sign-in steps">
      {STEPS.map((label, i) => {
        const n = i + 1
        const complete = done || n < current
        const active = !done && n === current
        return (
          <li
            key={label}
            aria-current={active ? "step" : undefined}
            className="flex min-w-0 flex-1 items-center gap-2"
          >
            <span
              className={cn(
                "flex size-6 shrink-0 items-center justify-center rounded-full border text-xs tabular-nums",
                complete && "border-ucch-active/60 text-ucch-active",
                active && "border-primary bg-primary text-primary-foreground",
                !complete && !active && "text-muted-foreground",
              )}
            >
              {complete ? <CheckIcon className="size-3.5" aria-hidden /> : n}
            </span>
            <span className={cn("truncate", active ? "text-foreground font-medium" : "text-muted-foreground")}>
              {label}
              {complete && <span className="sr-only"> (done)</span>}
            </span>
            {n < STEPS.length && <span className="bg-border hidden h-px flex-1 sm:block" aria-hidden />}
          </li>
        )
      })}
    </ol>
  )
}

/** The CLI's refusal, said the way someone holding a code wants to hear it. */
function friendly(message: string): string {
  if (/wasn't accepted|not accepted|invalid_grant/i.test(message)) {
    return "That code wasn't accepted. It may be incomplete, already used, or from an earlier attempt. Start again for a new link and code."
  }
  if (/Invalid code/i.test(message)) {
    return "That doesn't look like a whole code. Copy it again from the Claude page, including the part after the “#”."
  }
  if (/not from this sign-in/i.test(message)) {
    return "That code is from a different sign-in. Use the code shown after opening the link above."
  }
  return message
}

function liveMessage(phase: Phase, url: string | null, failure: Failure | null): string {
  switch (phase) {
    case "starting":
      return "Starting the sign-in…"
    case "ready":
      return url ? "The sign-in link is ready." : ""
    case "verifying":
      return "Verifying the code…"
    case "success":
      return "Signed in to Claude Code."
    case "error":
      return failure?.message ?? "The sign-in failed."
    case "expired":
      return "The sign-in has expired. Start again."
  }
}
