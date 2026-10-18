"use client"

import * as React from "react"
import { CheckIcon, CopyIcon, ExternalLinkIcon, GlobeIcon, LockIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Skeleton } from "@/components/ui/skeleton"
import { fetchPublicSite, setPublicSite, type PublicSiteState } from "@/lib/public-api"
import { cn } from "@/lib/utils"

/**
 * The notes' settings: for now, one -- whether the project has a public,
 * read-only site.
 *
 * "Public" is the whole project's notes, its history and its files, at an
 * address made of the project's name and six random characters. The address
 * is minted the first time and kept, so switching the site off and on again
 * does not break a link someone was already sent; while it is off the link
 * says nothing at all.
 */
export function NoteSettingsDialog({
  hash,
  open,
  onOpenChange,
}: {
  hash: string
  open: boolean
  onOpenChange(open: boolean): void
}) {
  const [state, setState] = React.useState<PublicSiteState | null>(null)
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!open) return
    setError(null)
    fetchPublicSite(hash).then(setState, (e) => setError(e instanceof Error ? e.message : "Could not load."))
  }, [open, hash])

  const change = async (enabled: boolean) => {
    if (!state || enabled === state.enabled) return
    setPending(true)
    setError(null)
    try {
      setState(await setPublicSite(hash, enabled))
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update the public site.")
    } finally {
      setPending(false)
    }
  }

  const visibility = state?.enabled ? "public" : "private"
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <div className="min-w-0">
          <DialogHeader>
            <DialogTitle>Notes settings</DialogTitle>
            <DialogDescription>
              Who can read this project's notes, timeline and documents.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <Field>
              <FieldLabel htmlFor="notes-visibility">Visibility</FieldLabel>
              {state ? (
                <div className="relative max-w-72">
                  <span className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2">
                    {visibility === "public" ? <GlobeIcon className="size-4" /> : <LockIcon className="size-4" />}
                  </span>
                  <select
                    id="notes-visibility"
                    value={visibility}
                    disabled={pending}
                    onChange={(e) => void change(e.target.value === "public")}
                    className={cn(
                      "border-input bg-background h-8 w-full appearance-none rounded-lg border pr-8 pl-8 text-sm outline-none",
                      "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring disabled:opacity-50",
                      "dark:bg-input/30",
                    )}
                  >
                    <option value="private">Private — only you</option>
                    <option value="public">Public — anyone with the link</option>
                  </select>
                  <span className="text-muted-foreground pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-xs">▾</span>
                </div>
              ) : error ? null : (
                // Not known yet: a bar, rather than "Private" showing before the real answer.
                <Skeleton className="h-8 max-w-72 rounded-lg" />
              )}
              <FieldDescription>
                A public site is read-only: visitors can read every page of the notes, see the
                project's commit history and browse its files, and change nothing.
              </FieldDescription>
            </Field>

            {error && (
              <p role="alert" className="text-destructive text-sm">
                {error}
              </p>
            )}

            {state?.url && (
              <div className="space-y-3 rounded-lg border p-3">
                <div className="flex items-center gap-2 text-sm">
                  <span
                    aria-hidden
                    className={cn("size-2 rounded-full", state.enabled ? "bg-success" : "bg-muted-foreground/40")}
                  />
                  <span className="text-muted-foreground">
                    {state.enabled ? "Live: anyone with this link can read" : "Off: the link shows nothing until turned back on"}
                  </span>
                </div>
                <UrlRow url={state.url} />
              </div>
            )}
          </div>

          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>Close</DialogClose>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function UrlRow({ url }: { url: string }) {
  const [copied, setCopied] = React.useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard access can be refused; the URL is still visible to select.
    }
  }
  return (
    <div className="flex items-center gap-2">
      <code className="bg-muted min-w-0 flex-1 truncate rounded px-2 py-1 text-xs" title={url}>
        {url}
      </code>
      <Button type="button" variant="ghost" size="icon-sm" onClick={copy} title="Copy">
        {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
        <span className="sr-only">Copy</span>
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        title="Open"
        nativeButton={false}
        render={<a href={url} target="_blank" rel="noopener" />}
      >
        <ExternalLinkIcon className="size-3.5" />
        <span className="sr-only">Open</span>
      </Button>
    </div>
  )
}
