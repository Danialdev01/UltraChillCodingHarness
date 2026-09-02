"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpIcon, TerminalIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { UcchClient, type ClientEvent, type ConnectionState } from "@/lib/client";
import type { Project } from "@/lib/session";
import { cn } from "@/lib/utils";

/**
 * The conversation view for one project.
 *
 * The transport is already real: this opens the authenticated WebSocket,
 * subscribes to the project's topic, and renders the event stream as it
 * arrives. What is not real yet is the agent -- `thread.send` has no reactor
 * behind it until the agent core lands, so the composer is disabled rather
 * than silently accepting messages nothing will answer.
 */
export function ProjectChat({ project }: { project: Project }) {
  const client = useMemo(() => new UcchClient(), []);
  const [state, setState] = useState<ConnectionState>("idle");
  const [events, setEvents] = useState<readonly ClientEvent[]>([]);
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const unsubscribe = client.subscribeToChanges(() => {
      setState(client.state);
      setEvents(client.events);
    });

    let cancelled = false;
    void (async () => {
      await client.connect();
      // Subscribing before the socket reports ready would be dropped, and the
      // client replays from the last seq on reconnect anyway.
      if (!cancelled) await client.subscribe({ name: "project", projectId: project.id });
    })();

    return () => {
      cancelled = true;
      unsubscribe();
      client.close();
    };
  }, [client, project.id]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events.length]);

  return (
    <div className="flex flex-1 flex-col">
      <div className="flex-1 overflow-y-auto p-4">
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
          <div className="rounded-lg border p-4">
            <div className="flex items-center gap-2">
              <TerminalIcon className="size-4" />
              <h2 className="font-medium">{project.name}</h2>
              <span
                className={cn(
                  "ml-auto inline-flex items-center gap-1.5 text-xs",
                  state === "ready" ? "text-muted-foreground" : "text-amber-600",
                )}
              >
                <span
                  className={cn(
                    "size-1.5 rounded-full",
                    state === "ready" ? "bg-emerald-500" : "bg-amber-500",
                  )}
                />
                {state}
              </span>
            </div>
            <p className="text-muted-foreground mt-1 text-sm">
              {project.stack === "unknown" ? "Stack not yet detected" : project.stack} · container{" "}
              {project.containerState}
            </p>
          </div>

          {events.length === 0 ? (
            <p className="text-muted-foreground py-8 text-center text-sm">
              No activity yet. Events for this project appear here as they happen.
            </p>
          ) : (
            <ol className="flex flex-col gap-2">
              {events.map((entry, i) => (
                <li key={i} className="flex gap-3 rounded-md border px-3 py-2 font-mono text-xs">
                  <span className="text-muted-foreground w-8 shrink-0 text-right">
                    {entry.seq ?? "—"}
                  </span>
                  <span className="w-52 shrink-0 font-medium">{entry.event.type}</span>
                  <span className="text-muted-foreground truncate">{summarize(entry.event)}</span>
                </li>
              ))}
            </ol>
          )}
          <div ref={endRef} />
        </div>
      </div>

      <div className="border-t p-4">
        <form
          className="mx-auto flex max-w-3xl items-end gap-2"
          onSubmit={(e) => e.preventDefault()}
        >
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={2}
            disabled
            placeholder="Ask the agent to change this project… (available once the agent core lands)"
            className="border-input bg-background placeholder:text-muted-foreground focus-visible:ring-ring flex-1 resize-none rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:outline-none disabled:opacity-60"
          />
          <Button type="submit" size="icon" disabled aria-label="Send">
            <ArrowUpIcon />
          </Button>
        </form>
      </div>
    </div>
  );
}

function summarize(event: ClientEvent["event"]): string {
  const { type, ...rest } = event;
  return Object.entries(rest)
    .filter(([, v]) => typeof v !== "object")
    .map(([k, v]) => `${k}=${String(v)}`)
    .join("  ");
}
