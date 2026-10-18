"use client";

import * as React from "react";
import { AlertCircleIcon, DatabaseIcon, LockIcon } from "lucide-react";
import {
  DATABASE_ENGINE_LABELS,
  DEFAULT_DB_PORTS,
  DatabaseEngine,
  type DatabaseConnectionCreate,
} from "@ucch/protocol";

import {
  Callout,
  FIELD,
  FormDialog,
  FormDialogFooter,
  FormField,
  OptionPanel,
  OptionTabs,
  Optional,
  Segmented,
} from "@/components/form-dialog";
import { createConnection } from "@/lib/database-api";
import { parseDatabaseUrl } from "@/lib/database-url";
import { cn } from "@/lib/utils";
import { sectionById, sectionHref } from "@/lib/sections";
import { useTransitionRouter } from "@/lib/view-transitions";
import { useWorkspaceHash } from "@/lib/workspace-context";

type Mode = "fields" | "url";

const MODES = [
  { value: "fields", title: "Credentials", hint: "Host, user, password" },
  { value: "url", title: "Connection URL", hint: "Paste one string" },
] as const satisfies readonly { value: Mode; title: string; hint: string }[];

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
  const ws = useWorkspaceHash();
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
      router.push(sectionHref(sectionById("database"), ws));
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not reach the server.");
    } finally {
      setPending(false);
    }
  }

  const urlEngineLocked = mode === "url" && Boolean(parsed && !("error" in parsed));

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      busy={pending}
      icon={DatabaseIcon}
      title="New database connection"
      description="A MySQL or PostgreSQL server this workspace can browse. The password is stored encrypted and never shown again."
      onSubmit={submit}
      footer={
        <FormDialogFooter hint="Password stored encrypted" hintIcon={LockIcon} busy={pending} disabled={!draft}>
          {pending ? "Testing…" : "Test and save"}
        </FormDialogFooter>
      }
    >
      <FormField
        label="Engine"
        labelId="db-engine-label"
        helper={urlEngineLocked ? "Read from the URL's scheme." : undefined}
      >
        <Segmented
          options={DatabaseEngine.options.map((value) => ({
            value,
            label: DATABASE_ENGINE_LABELS[value],
          }))}
          value={engine}
          onChange={setEngine}
          disabled={pending || urlEngineLocked}
          labelledBy="db-engine-label"
        />
      </FormField>

      <div role="separator" className="h-px bg-(--fd-border-subtle)" />

      <OptionTabs
        value={mode}
        onChange={(value) => {
          setMode(value);
          setError(null);
        }}
        label="Connection"
        aside="How do you have the details?"
        options={MODES}
        disabled={pending}
      >
        <OptionPanel value="fields">
          <div className="grid grid-cols-3 gap-3">
            <FormField label="Host" htmlFor="db-host" className="col-span-2">
              <input
                id="db-host"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="db.example.com"
                spellCheck={false}
                autoComplete="off"
                autoFocus
                disabled={pending}
                className={cn(FIELD, "fd-mono")}
              />
            </FormField>
            <FormField label="Port" htmlFor="db-port">
              <input
                id="db-port"
                value={port}
                onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))}
                inputMode="numeric"
                autoComplete="off"
                disabled={pending}
                className={cn(FIELD, "fd-mono")}
              />
            </FormField>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Username" htmlFor="db-username">
              <input
                id="db-username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                spellCheck={false}
                autoComplete="off"
                disabled={pending}
                className={cn(FIELD, "fd-mono")}
              />
            </FormField>
            <FormField label="Password" htmlFor="db-password">
              <input
                id="db-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="off"
                disabled={pending}
                className={FIELD}
              />
            </FormField>
          </div>
          <FormField label={<>Database<Optional /></>} htmlFor="db-database">
            <input
              id="db-database"
              value={database}
              onChange={(e) => setDatabase(e.target.value)}
              placeholder={engine === "mysql" ? "mysql" : "postgres"}
              spellCheck={false}
              autoComplete="off"
              disabled={pending}
              className={cn(FIELD, "fd-mono")}
            />
          </FormField>
        </OptionPanel>

        <OptionPanel value="url">
          <FormField
            label="Connection URL"
            htmlFor="db-url"
            error={parsed && "error" in parsed ? parsed.error : undefined}
            helper={
              !parsed ? (
                "Paste the URL your host gives you; the password is read from it and hidden here."
              ) : "error" in parsed ? undefined : (
                <span className="fd-mono break-all">
                  {DATABASE_ENGINE_LABELS[parsed.engine]} · {parsed.username || "(no user)"}@
                  {parsed.host}:{parsed.port}
                  {parsed.database ? `/${parsed.database}` : ""}
                </span>
              )
            }
          >
            <input
              id="db-url"
              type="password"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="mysql://user:password@host:3306/database"
              spellCheck={false}
              autoComplete="off"
              autoFocus
              disabled={pending}
              className={cn(FIELD, "fd-mono")}
            />
          </FormField>
        </OptionPanel>
      </OptionTabs>

      <FormField label={<>Name<Optional /></>} htmlFor="db-name" helper="How it is listed under Database.">
        <input
          id="db-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={draft?.name ?? "Production"}
          maxLength={80}
          autoComplete="off"
          disabled={pending}
          className={FIELD}
        />
      </FormField>

      {error && (
        <Callout icon={AlertCircleIcon} className="border-destructive/40 [&_svg]:text-destructive">
          <span role="alert" className="text-destructive">
            {error}
          </span>
        </Callout>
      )}
    </FormDialog>
  );
}
