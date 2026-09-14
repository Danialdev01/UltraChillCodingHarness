"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckIcon, CopyIcon, ExternalLinkIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { fetchPreviewStatus, setPreviewPort } from "@/lib/preview-api";
import type { Project } from "@/lib/session";
import { cn } from "@/lib/utils";

const STATUS_POLL_MS = 3000;

/**
 * Where a project's dev server can be reached from the outside.
 *
 * The owner names a port; the server answers with two addresses. The alias
 * on this app is the one to share -- it is what checks the session and hands
 * the visitor through -- and the subdomain is where they land. Both are
 * shown because the second is what the app itself sees as its origin, which
 * matters when its config asks for one.
 */
export function PreviewDialog({
  project,
  open,
  onOpenChange,
}: {
  project: Project;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  // The saved state, kept locally so the URLs appear the moment the save
  // returns rather than after the layout's project list has refreshed.
  const [saved, setSaved] = useState<Project>(project);
  const [port, setPort] = useState(project.previewPort ? String(project.previewPort) : "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [listening, setListening] = useState<boolean | null>(null);

  useEffect(() => {
    if (!open) return;
    setSaved(project);
    setPort(project.previewPort ? String(project.previewPort) : "");
    setError(null);
  }, [open, project]);

  // Whether anything answers on the port, while the dialog is up. A dev
  // server started in the terminal shows up here within a few seconds.
  useEffect(() => {
    if (!open || !saved.previewPort) {
      setListening(null);
      return;
    }
    let cancelled = false;
    const check = () =>
      fetchPreviewStatus(saved.hash)
        .then((s) => !cancelled && setListening(s.listening))
        .catch(() => !cancelled && setListening(null));
    void check();
    const timer = setInterval(check, STATUS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [open, saved.hash, saved.previewPort]);

  const parsed = Number(port);
  const valid = port !== "" && Number.isInteger(parsed) && parsed >= 1024 && parsed <= 65535;
  const unchanged = valid && parsed === saved.previewPort;

  async function save(next: number | null) {
    setPending(true);
    setError(null);
    try {
      const updated = await setPreviewPort(saved.hash, next);
      setSaved(updated);
      setPort(updated.previewPort ? String(updated.previewPort) : "");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the preview port.");
    } finally {
      setPending(false);
    }
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (valid) void save(parsed);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Preview</DialogTitle>
            <DialogDescription>
              Open the app running in this project from anywhere. Start your dev server in the
              terminal, then tell the preview which port it listens on.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <Field>
              <FieldLabel htmlFor="preview-port">Dev server port</FieldLabel>
              <div className="flex gap-2">
                <Input
                  id="preview-port"
                  type="number"
                  inputMode="numeric"
                  min={1024}
                  max={65535}
                  value={port}
                  onChange={(e) => setPort(e.target.value)}
                  placeholder="8001"
                  autoFocus
                  disabled={pending}
                  className="max-w-40"
                />
                <Button type="submit" disabled={pending || !valid || unchanged}>
                  {pending ? "Saving…" : "Save"}
                </Button>
                {saved.previewPort && (
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={pending}
                    onClick={() => void save(null)}
                  >
                    Clear
                  </Button>
                )}
              </div>
              <FieldDescription>
                For example <code>php artisan serve --port=8001</code>. The server must accept
                connections on loopback (127.0.0.1 or ::1).
              </FieldDescription>
            </Field>

            {error && (
              <p role="alert" className="text-destructive text-sm">
                {error}
              </p>
            )}

            {saved.previewPort && saved.previewUrl && saved.previewAliasUrl && (
              <div className="space-y-3 rounded-lg border p-3">
                <div className="flex items-center gap-2 text-sm">
                  <span
                    aria-hidden
                    className={cn(
                      "size-2 rounded-full",
                      listening === true && "bg-emerald-500",
                      listening === false && "bg-amber-500",
                      listening === null && "bg-muted-foreground/40",
                    )}
                  />
                  <span className="text-muted-foreground">
                    {listening === true && `Listening on port ${saved.previewPort}`}
                    {listening === false && `Nothing on port ${saved.previewPort} yet`}
                    {listening === null && "Checking…"}
                  </span>
                </div>
                <UrlRow label="Share" url={saved.previewAliasUrl} />
                <UrlRow label="App origin" url={saved.previewUrl} />
              </div>
            )}
          </div>

          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>Close</DialogClose>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function UrlRow({ label, url }: { label: string; url: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be refused; the URL is still visible to select.
    }
  }

  return (
    <div className="flex items-center gap-2">
      <span className="text-muted-foreground w-20 shrink-0 text-xs">{label}</span>
      <code className="bg-muted min-w-0 flex-1 truncate rounded px-2 py-1 text-xs" title={url}>
        {url}
      </code>
      <Button type="button" variant="ghost" size="icon-sm" onClick={copy} title="Copy">
        {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
        <span className="sr-only">Copy</span>
      </Button>
      {/* A link styled as a button; `nativeButton` off because Base UI
          otherwise expects the rendered element to be a <button>. */}
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
  );
}
