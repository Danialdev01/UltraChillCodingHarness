"use client";

import { useEffect, useMemo, useState } from "react";
import { UcchClient, type ClientEvent, type ConnectionState } from "@/lib/client";

/**
 * Phase 1 surface: the live wire contract, in the browser.
 *
 * Connects over the authenticated WebSocket, shows connection state, and
 * streams the event log as it arrives. The editor, chat, terminal, and diff
 * panes land in later phases on top of this same client.
 */
export function HarnessPanel({ workspaceId }: { workspaceId: string }) {
  const client = useMemo(() => new UcchClient(), []);
  const [state, setState] = useState<ConnectionState>("idle");
  const [userId, setUserId] = useState<string | null>(null);
  const [events, setEvents] = useState<readonly ClientEvent[]>([]);
  const [repoUrl, setRepoUrl] = useState("https://github.com/laravel/laravel.git");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const unsubscribe = client.subscribeToChanges(() => {
      setState(client.state);
      setUserId(client.userId);
      setEvents(client.events);
    });
    void client.connect();
    return () => {
      unsubscribe();
      client.close();
    };
  }, [client]);

  async function createProject() {
    setError(null);
    try {
      const created = await client.dispatch({ type: "project.create", workspaceId, repoUrl });
      const event = created[0]?.event;
      if (event?.type === "project.created") {
        await client.subscribe({ name: "project", projectId: event.projectId });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div>
      <ConnectionBadge state={state} userId={userId} />

      <section style={panel}>
        <h2 style={h2}>Clone a repository</h2>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            value={repoUrl}
            onChange={(e) => setRepoUrl(e.target.value)}
            spellCheck={false}
            style={input}
            placeholder="https://github.com/owner/repo.git"
          />
          <button
            onClick={() => void createProject()}
            disabled={state !== "ready" || !workspaceId}
            style={button}
          >
            Create
          </button>
        </div>
        {error && <p style={{ color: "var(--err)", marginBottom: 0 }}>{error}</p>}
      </section>

      <section style={panel}>
        <h2 style={h2}>Event log</h2>
        {events.length === 0 ? (
          <p style={{ color: "var(--muted)", margin: 0 }}>No events yet.</p>
        ) : (
          <ol style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {events.map((e, i) => (
              <li key={i} style={row}>
                <span style={{ color: "var(--muted)", width: 40, flexShrink: 0 }}>
                  {e.seq ?? "—"}
                </span>
                <span style={{ color: "var(--accent)", width: 220, flexShrink: 0 }}>
                  {e.event.type}
                </span>
                <span style={{ color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {summarize(e.event)}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

function ConnectionBadge({ state, userId }: { state: ConnectionState; userId: string | null }) {
  const color =
    state === "ready" ? "var(--ok)" : state === "failed" ? "var(--err)" : "var(--warn)";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 24 }}>
      <span style={{ width: 8, height: 8, borderRadius: 4, background: color }} />
      <span style={{ color: "var(--muted)" }}>
        {state}
        {userId ? ` · ${userId.slice(0, 8)}` : ""}
      </span>
    </div>
  );
}

function summarize(event: ClientEvent["event"]): string {
  const { type, ...rest } = event;
  const entries = Object.entries(rest).filter(([, v]) => typeof v !== "object");
  return entries.map(([k, v]) => `${k}=${String(v)}`).join("  ");
}

const panel: React.CSSProperties = {
  background: "var(--panel)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  padding: 16,
  marginBottom: 16,
};

const h2: React.CSSProperties = { margin: "0 0 12px", fontSize: 13, color: "var(--muted)", fontWeight: 500 };

const input: React.CSSProperties = {
  flex: 1,
  background: "var(--bg)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  color: "var(--text)",
  padding: "8px 10px",
  fontFamily: "ui-monospace, monospace",
  fontSize: 13,
};

const button: React.CSSProperties = {
  background: "var(--accent)",
  border: "none",
  borderRadius: 6,
  color: "#0b0d10",
  padding: "8px 16px",
  fontWeight: 600,
  cursor: "pointer",
};

const row: React.CSSProperties = {
  display: "flex",
  gap: 12,
  padding: "4px 0",
  borderBottom: "1px solid var(--border)",
  fontFamily: "ui-monospace, monospace",
  fontSize: 12,
  whiteSpace: "nowrap",
};
