"use client"

import * as React from "react"
import dynamic from "next/dynamic"
import { DownloadIcon, Loader2Icon, SaveIcon } from "lucide-react"
import { mediaTypeFor } from "@ucch/protocol/plain"

import { CodeLinesSkeleton } from "@/components/page-skeletons"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { readRemoteText, remoteFileUrl, SshApiError, writeRemoteText } from "@/lib/ssh-api"

const VimEditor = dynamic(() => import("@/components/vim-editor").then((m) => m.VimEditor), {
  ssr: false,
  loading: () => <CodeLinesSkeleton />,
})

type State =
  | { kind: "loading" }
  | { kind: "text"; saved: string; version: string }
  | { kind: "preview" }
  | { kind: "failed"; error: string }

/**
 * A file on a server, open for editing. Saves name the version that was
 * opened, so a change someone made over SSH meanwhile is not overwritten:
 * the save is refused and the editor says so. Pictures and PDFs are shown
 * rather than opened as text; anything else that is not text offers a
 * download.
 */
export function RemoteFileEditor({
  hostId,
  hostName,
  path,
  onClose,
  onSaved,
}: {
  hostId: string
  hostName: string
  path: string
  onClose: () => void
  onSaved?: () => void
}) {
  const [state, setState] = React.useState<State>({ kind: "loading" })
  const [text, setText] = React.useState("")
  const [saving, setSaving] = React.useState(false)
  const [notice, setNotice] = React.useState<string | null>(null)
  // Closing with unsaved edits asks once, in the header: a second close discards them.
  const [discarding, setDiscarding] = React.useState(false)
  const name = path.slice(path.lastIndexOf("/") + 1)
  const previewable = mediaTypeFor(path)?.startsWith("image/") || mediaTypeFor(path) === "application/pdf"

  React.useEffect(() => {
    let cancelled = false
    if (previewable) {
      setState({ kind: "preview" })
      return
    }
    setState({ kind: "loading" })
    readRemoteText(hostId, path).then(
      (file) => {
        if (cancelled) return
        setText(file.content)
        setState({ kind: "text", saved: file.content, version: file.version })
      },
      (error: unknown) => {
        if (!cancelled) setState({ kind: "failed", error: error instanceof Error ? error.message : String(error) })
      },
    )
    return () => {
      cancelled = true
    }
  }, [hostId, path, previewable])

  const dirty = state.kind === "text" && text !== state.saved
  React.useEffect(() => setDiscarding(false), [text])

  const save = React.useCallback(async () => {
    if (state.kind !== "text" || saving) return
    setSaving(true)
    setNotice(null)
    try {
      const result = await writeRemoteText(hostId, path, text, state.version)
      setState({ kind: "text", saved: text, version: result.version })
      setNotice("Saved.")
      onSaved?.()
    } catch (error) {
      if (error instanceof SshApiError && error.status === 409 && "version" in (error.body ?? {})) {
        setNotice("The file changed on the server since it was opened. Copy your edits, close, and open it again.")
      } else {
        setNotice(error instanceof Error ? error.message : String(error))
      }
    } finally {
      setSaving(false)
    }
  }, [state, saving, hostId, path, text, onSaved])

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (open) return
        if (dirty && !discarding) {
          setDiscarding(true)
          setNotice("Unsaved changes. Close again to discard them.")
          return
        }
        onClose()
      }}
    >
      <DialogContent className="flex h-[min(85dvh,720px)] w-[min(96vw,960px)] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none">
        <div className="flex h-11 shrink-0 items-center gap-3 border-b pr-12 pl-4">
          <div className="min-w-0">
            <DialogTitle className="truncate text-sm">
              {name}
              {dirty && <span className="text-muted-foreground"> ·</span>}
            </DialogTitle>
            <DialogDescription className="truncate font-mono text-[11px]">
              {hostName}:{path}
            </DialogDescription>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {notice && <span className="text-muted-foreground hidden max-w-xs truncate text-xs md:inline">{notice}</span>}
            <Button variant="ghost" size="sm" nativeButton={false} render={<a href={remoteFileUrl(hostId, path, true)} download={name} />}>
              <DownloadIcon />
              Download
            </Button>
            {state.kind === "text" && (
              <Button size="sm" disabled={!dirty || saving} onClick={() => void save()}>
                {saving ? <Loader2Icon className="animate-spin" /> : <SaveIcon />}
                Save
              </Button>
            )}
          </div>
        </div>
        {notice && <p className="text-muted-foreground border-b px-4 py-1.5 text-xs md:hidden">{notice}</p>}
        <div className="flex min-h-0 flex-1 flex-col">
          {state.kind === "loading" ? (
            <CodeLinesSkeleton />
          ) : state.kind === "failed" ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-sm">
              <p className="text-muted-foreground max-w-sm">{state.error}</p>
              <Button variant="outline" size="sm" nativeButton={false} render={<a href={remoteFileUrl(hostId, path, true)} download={name} />}>
                <DownloadIcon />
                Download instead
              </Button>
            </div>
          ) : state.kind === "preview" ? (
            mediaTypeFor(path) === "application/pdf" ? (
              <iframe title={name} src={remoteFileUrl(hostId, path)} className="min-h-0 flex-1" sandbox="" />
            ) : (
              <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={remoteFileUrl(hostId, path)} alt={name} className="max-h-full max-w-full object-contain" />
              </div>
            )
          ) : (
            <VimEditor path={path} initialText={state.saved} text={text} onChange={setText} onSave={() => void save()} />
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
