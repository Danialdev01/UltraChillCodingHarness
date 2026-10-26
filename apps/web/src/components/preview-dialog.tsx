"use client";

import { useEffect, useState } from "react";
import { CheckIcon, CopyIcon, ExternalLinkIcon, FileCodeIcon, ServerIcon } from "lucide-react";

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
import { fetchPreviewStatus, setPreviewPort, setStaticPreview } from "@/lib/preview-api";
import type { Project } from "@/lib/session";
import { cn } from "@/lib/utils";
import { qk } from "@/lib/query-keys";
import { useProjectEvents } from "@/lib/realtime";
import { useInvalidate } from "@/lib/use-invalidate";

type Mode = "server" | "static";

const MODES: { value: Mode; label: string; icon: typeof ServerIcon }[] = [
  { value: "server", label: "Dev server", icon: ServerIcon },
  { value: "static", label: "Static site", icon: FileCodeIcon },
];

const modeOf = (project: Project): Mode => (project.previewStaticDir != null ? "static" : "server");

/**
 * Where a project's dev server can be reached from the outside.
 *
 * The owner names a port -- or, for plain HTML with nothing to run, a folder
 * of the working tree that the proxy serves itself -- and the server answers
 * with two addresses. The alias
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
  const invalidate = useInvalidate();
  // The saved state, kept locally so the URLs appear the moment the save
  // returns rather than after the layout's project list has refreshed.
  const [saved, setSaved] = useState<Project>(project);
  const [mode, setMode] = useState<Mode>(modeOf(project));
  const [port, setPort] = useState(project.previewPort ? String(project.previewPort) : "");
  const [dir, setDir] = useState(project.previewStaticDir ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [listening, setListening] = useState<boolean | null>(null);

  useEffect(() => {
    if (!open) return;
    setSaved(project);
    setMode(modeOf(project));
    setPort(project.previewPort ? String(project.previewPort) : "");
    setDir(project.previewStaticDir ?? "");
    setError(null);
  }, [open, project]);

  // Whether anything answers on the port, while the dialog is up: asked
  // once, then followed. The server probes the port of every project in
  // view and says when it opens or closes (`port-watcher.ts`), so a dev
  // server started in the terminal shows up here within a few seconds --
  // in every tab, without each one polling.
  useEffect(() => {
    if (!open || !saved.previewPort) {
      setListening(null);
      return;
    }
    let cancelled = false;
    fetchPreviewStatus(saved.hash)
      .then((s) => !cancelled && setListening(s.listening))
      .catch(() => !cancelled && setListening(null));
    return () => {
      cancelled = true;
    };
  }, [open, saved.hash, saved.previewPort, saved.previewStaticDir]);

  useProjectEvents(open ? saved.id : null, (event) => {
    if (event.type !== "port.opened" && event.type !== "port.closed") return;
    if (saved.previewStaticDir != null || event.port !== saved.previewPort) return;
    setListening(event.type === "port.opened");
  });

  const parsed = Number(port);
  const savedStatic = saved.previewStaticDir != null;
  const folder = dir.trim().replace(/^\/+|\/+$/g, "");
  const valid =
    mode === "static" ||
    (port !== "" && Number.isInteger(parsed) && parsed >= 1024 && parsed <= 65535);
  const unchanged =
    mode === "static"
      ? savedStatic && folder === saved.previewStaticDir
      : !savedStatic && parsed === saved.previewPort;

  async function save(next: { port: number } | { dir: string } | null) {
    setPending(true);
    setError(null);
    try {
      const updated =
        next !== null && "dir" in next
          ? await setStaticPreview(saved.hash, next.dir)
          : await setPreviewPort(saved.hash, next?.port ?? null);
      setSaved(updated);
      setPort(
        updated.previewPort && updated.previewStaticDir == null ? String(updated.previewPort) : "",
      );
      setDir(updated.previewStaticDir ?? "");
      invalidate(qk.bootstrap(), qk.sessions.list(updated.hash), qk.project(updated.hash));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the preview.");
    } finally {
      setPending(false);
    }
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!valid) return;
    void save(mode === "static" ? { dir: folder } : { port: parsed });
  }

  const savedFolder = saved.previewStaticDir ? `${saved.previewStaticDir}/` : "the project root";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        {/* `min-w-0`: the form is a grid item, and a grid item's default
            `min-width: auto` lets the nowrap URLs below set its width, which
            pushed the description and the footer out past the dialog. With a
            floor of zero the URL rows shrink and truncate as intended. */}
        <form onSubmit={submit} className="min-w-0">
          <DialogHeader>
            <DialogTitle>Preview</DialogTitle>
            <DialogDescription>
              Open the app in this project from anywhere. Point the preview at the port your dev
              server listens on, or serve a folder of plain HTML straight from the project.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div
              role="radiogroup"
              aria-label="What to preview"
              className="inline-flex rounded-lg border p-0.5"
            >
              {MODES.map(({ value, label, icon: Icon }) => {
                const checked = mode === value;
                return (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={checked}
                    disabled={pending}
                    onClick={() => {
                      setMode(value);
                      setError(null);
                    }}
                    className={cn(
                      "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm",
                      checked
                        ? "bg-accent-soft text-foreground font-medium"
                        : "text-muted-foreground hover:bg-muted",
                    )}
                  >
                    <Icon className="size-4" aria-hidden />
                    {label}
                  </button>
                );
              })}
            </div>

            {mode === "static" ? (
              <Field>
                <FieldLabel htmlFor="preview-dir">Folder</FieldLabel>
                <div className="flex gap-2">
                  <Input
                    id="preview-dir"
                    value={dir}
                    onChange={(e) => setDir(e.target.value)}
                    placeholder="/ (project root)"
                    autoComplete="off"
                    spellCheck={false}
                    autoFocus
                    disabled={pending}
                    className="max-w-56"
                  />
                  <Button type="submit" disabled={pending || unchanged}>
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
                  The folder holding your <code>index.html</code>, for example <code>dist</code> or{" "}
                  <code>public</code>. Leave it empty to serve the project root. Files are served as
                  they are, so changes show on reload.
                </FieldDescription>
              </Field>
            ) : (
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
            )}

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
                      listening === true && "bg-success",
                      listening === false && "bg-warning",
                      listening === null && "bg-muted-foreground/40",
                    )}
                  />
                  <span className="text-muted-foreground">
                    {savedStatic ? (
                      <>
                        {listening === true && `Serving index.html from ${savedFolder}`}
                        {listening === false && `No index.html in ${savedFolder} yet`}
                      </>
                    ) : (
                      <>
                        {listening === true && `Listening on port ${saved.previewPort}`}
                        {listening === false && `Nothing on port ${saved.previewPort} yet`}
                      </>
                    )}
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
