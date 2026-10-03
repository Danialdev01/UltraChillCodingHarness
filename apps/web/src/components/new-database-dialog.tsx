"use client";

import * as React from "react";
import { LinkIcon, Loader2Icon, TextCursorInputIcon } from "lucide-react";
import {
  DATABASE_ENGINE_LABELS,
  DEFAULT_DB_PORTS,
  DatabaseEngine,
  type DatabaseConnectionCreate,
} from "@ucch/protocol";

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
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Tabs, TabsIndicator, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import { createConnection } from "@/lib/database-api";
import { parseDatabaseUrl } from "@/lib/database-url";
import { cn } from "@/lib/utils";
import { useTransitionRouter } from "@/lib/view-transitions";

type Mode = "fields" | "url";

const MODES = [
  { value: "fields", label: "Credentials", icon: TextCursorInputIcon },
  { value: "url", label: "Connection URL", icon: LinkIcon },
] as const;

/**
 * Add a MySQL or PostgreSQL server to the workspace.
 *
 * Two ways in, chosen by tab: type the fields, or paste the URL a hosting
 * panel hands out. The tab is the mode -- nothing sniffs the input -- but a
 * pasted URL does pick the engine, since the scheme already says.
 *
 * Saving tests the credentials on the server first; what comes back on
 * failure is the driver's own sentence, which is more useful than any
 * paraphrase.
 */
export function NewDatabaseDialog({
  workspaceId,
  open,
  onOpenChange,
}: {
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useTransitionRouter();
  const [mode, setMode] = React.useState<Mode>("fields");
  const [engine, setEngineState] = React.useState<DatabaseEngine>("mysql");
  const [name, setName] = React.useState("");
  const [host, setHost] = React.useState("");
  const [port, setPort] = React.useState(String(DEFAULT_DB_PORTS.mysql));
  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [database, setDatabase] = React.useState("");
  const [url, setUrl] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // A fresh dialog every time it opens.
  React.useEffect(() => {
    if (open) return;
    setMode("fields");
    setEngineState("mysql");
    setName("");
    setHost("");
    setPort(String(DEFAULT_DB_PORTS.mysql));
    setUsername("");
    setPassword("");
    setDatabase("");
    setUrl("");
    setPending(false);
    setError(null);
  }, [open]);

  // Switching engine moves the port along only while it is still a default:
  // a port the user typed is theirs.
  function setEngine(next: DatabaseEngine) {
    if (port === "" || port === String(DEFAULT_DB_PORTS[engine])) setPort(String(DEFAULT_DB_PORTS[next]));
    setEngineState(next);
  }

  const parsed = React.useMemo(() => (url.trim() ? parseDatabaseUrl(url) : null), [url]);
  React.useEffect(() => {
    if (mode === "url" && parsed && !("error" in parsed)) setEngineState(parsed.engine);
  }, [mode, parsed]);

  const draft = React.useMemo<DatabaseConnectionCreate | null>(() => {
    if (mode === "url") {
      if (!parsed || "error" in parsed) return null;
      return {
        name: name.trim() || parsed.database || parsed.host,
        engine: parsed.engine,
        host: parsed.host,
        port: parsed.port,
        username: parsed.username,
        password: parsed.password,
        database: parsed.database,
      };
    }
    const portNumber = Number(port);
    if (!host.trim() || !username || !Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
      return null;
    }
    return {
      name: name.trim() || database.trim() || host.trim(),
      engine,
      host: host.trim(),
      port: portNumber,
      username,
      password,
      database: database.trim() || undefined,
    };
  }, [mode, parsed, name, engine, host, port, username, password, database]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || pending) return;
    setPending(true);
    setError(null);
    try {
      await createConnection(workspaceId, draft);
      onOpenChange(false);
      router.push("/database");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not reach the server.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>New database connection</DialogTitle>
            <DialogDescription>
              A MySQL or PostgreSQL server this workspace can browse. The password is stored
              encrypted and never shown again.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4 py-4">
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium">Engine</span>
              <div className="grid grid-cols-2 gap-1" role="radiogroup" aria-label="Engine">
                {DatabaseEngine.options.map((option) => (
                  <button
                    key={option}
                    type="button"
                    role="radio"
                    aria-checked={engine === option}
                    disabled={pending || (mode === "url" && Boolean(parsed && !("error" in parsed)))}
                    onClick={() => setEngine(option)}
                    className={cn(
                      "focus-visible:ring-ring h-8 rounded-md border text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none disabled:opacity-60",
                      engine === option
                        ? "bg-accent text-accent-foreground border-foreground/30"
                        : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                    )}
                  >
                    {DATABASE_ENGINE_LABELS[option]}
                  </button>
                ))}
              </div>
            </div>

            <Tabs
              value={mode}
              onValueChange={(value) => {
                if (pending) return;
                setMode(String(value) as Mode);
                setError(null);
              }}
            >
              <TabsList>
                {MODES.map((tab) => (
                  <TabsTab key={tab.value} value={tab.value} disabled={pending}>
                    <tab.icon className="size-3.5" />
                    {tab.label}
                  </TabsTab>
                ))}
                <TabsIndicator />
              </TabsList>

              <TabsPanel value="fields" className="flex flex-col gap-3 pt-3">
                <div className="grid grid-cols-3 gap-3">
                  <Field className="col-span-2">
                    <FieldLabel htmlFor="db-host">Host</FieldLabel>
                    <Input
                      id="db-host"
                      value={host}
                      onChange={(e) => setHost(e.target.value)}
                      placeholder="db.example.com"
                      spellCheck={false}
                      autoComplete="off"
                      autoFocus
                      disabled={pending}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="db-port">Port</FieldLabel>
                    <Input
                      id="db-port"
                      value={port}
                      onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))}
                      inputMode="numeric"
                      autoComplete="off"
                      disabled={pending}
                    />
                  </Field>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <Field>
                    <FieldLabel htmlFor="db-username">Username</FieldLabel>
                    <Input
                      id="db-username"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      spellCheck={false}
                      autoComplete="off"
                      disabled={pending}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="db-password">Password</FieldLabel>
                    <Input
                      id="db-password"
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      autoComplete="off"
                      disabled={pending}
                    />
                  </Field>
                </div>
                <Field>
                  <FieldLabel htmlFor="db-database">
                    Database <span className="text-muted-foreground font-normal">(optional)</span>
                  </FieldLabel>
                  <Input
                    id="db-database"
                    value={database}
                    onChange={(e) => setDatabase(e.target.value)}
                    placeholder={engine === "mysql" ? "mysql" : "postgres"}
                    spellCheck={false}
                    autoComplete="off"
                    disabled={pending}
                  />
                </Field>
              </TabsPanel>

              <TabsPanel value="url" className="flex flex-col gap-3 pt-3">
                <Field>
                  <FieldLabel htmlFor="db-url">Connection URL</FieldLabel>
                  <Input
                    id="db-url"
                    type="password"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder="mysql://user:password@host:3306/database"
                    spellCheck={false}
                    autoComplete="off"
                    autoFocus
                    disabled={pending}
                  />
                  <p
                    role={parsed && "error" in parsed ? "alert" : undefined}
                    className={cn(
                      "min-h-4 text-xs break-all",
                      parsed && "error" in parsed ? "text-destructive" : "text-muted-foreground",
                    )}
                  >
                    {!parsed
                      ? "Paste the URL your host gives you; the password is read from it and hidden here."
                      : "error" in parsed
                        ? parsed.error
                        : `${DATABASE_ENGINE_LABELS[parsed.engine]} · ${parsed.username || "(no user)"}@${parsed.host}:${parsed.port}${parsed.database ? `/${parsed.database}` : ""}`}
                  </p>
                </Field>
              </TabsPanel>
            </Tabs>

            <Field>
              <FieldLabel htmlFor="db-name">
                Name <span className="text-muted-foreground font-normal">(optional)</span>
              </FieldLabel>
              <Input
                id="db-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={draft?.name ?? "Production"}
                maxLength={80}
                autoComplete="off"
                disabled={pending}
              />
            </Field>

            {error && (
              <p role="alert" className="text-destructive text-sm">
                {error}
              </p>
            )}
          </div>

          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" disabled={pending} />}>
              Cancel
            </DialogClose>
            <Button type="submit" disabled={!draft || pending}>
              {pending && <Loader2Icon className="animate-spin" />}
              {pending ? "Testing…" : "Test and save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
