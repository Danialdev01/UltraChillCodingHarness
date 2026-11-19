import type { Client, ClientChannel } from "ssh2";
import type { TerminalProcess } from "./terminals.js";
import { connectSsh, SshHostKeyMismatch, type SshConnection, type SshTarget } from "./ssh-hosts.js";

type ExitEvent = { exitCode: number; signal?: number | string };

/**
 * An interactive shell on an SSH host, shaped like a local pty so the
 * terminal reactor can run it as one.
 *
 * It returns at once and connects in the background. What is typed and any
 * resize while it connects are held and applied once the shell is up, the
 * same promise a local terminal makes about its first keystrokes. A failure
 * to connect is printed into the terminal, then ends it like an exit.
 */
export class SshShellProcess implements TerminalProcess {
  readonly #data = new Set<(data: string) => void>();
  readonly #exit = new Set<(event: ExitEvent) => void>();
  #pending: string[] = [];
  #size: { cols: number; rows: number };
  #client: Client | null = null;
  #stream: ClientChannel | null = null;
  #ended = false;
  #killed = false;

  constructor(
    target: SshTarget,
    cols: number,
    rows: number,
    options: {
      label: string;
      connect?: (target: SshTarget) => Promise<SshConnection>;
      /** The host key the first connection saw, to pin it. */
      onHostKey?: (fingerprint: string) => void;
    },
  ) {
    this.#size = { cols, rows };
    // Deferred a tick so the reactor has its listeners on before anything is said.
    queueMicrotask(() => {
      this.#emit(`\x1b[2mConnecting to ${options.label}…\x1b[0m\r\n`);
      void (options.connect ?? connectSsh)(target).then(
        (connection) => this.#connected(connection, target, options.onHostKey),
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          const colour = error instanceof SshHostKeyMismatch ? "31" : "33";
          this.#emit(`\x1b[${colour}m${message}\x1b[0m\r\n`);
          this.#finish({ exitCode: 255 });
        },
      );
    });
  }

  write(data: string): void {
    if (this.#ended) return;
    if (this.#stream) this.#stream.write(data);
    else this.#pending.push(data);
  }

  resize(cols: number, rows: number): void {
    this.#size = { cols, rows };
    // ssh2 takes rows first.
    this.#stream?.setWindow(rows, cols, 0, 0);
  }

  kill(): void {
    this.#killed = true;
    this.#stream?.close();
    this.#client?.end();
    if (!this.#client) this.#finish({ exitCode: 0, signal: "SIGHUP" });
  }

  onData(listener: (data: string) => void): () => void {
    this.#data.add(listener);
    return () => this.#data.delete(listener);
  }

  onExit(listener: (event: ExitEvent) => void): () => void {
    this.#exit.add(listener);
    return () => this.#exit.delete(listener);
  }

  #connected({ client, hostKeySha256 }: SshConnection, target: SshTarget, onHostKey?: (fp: string) => void): void {
    if (this.#killed) {
      client.end();
      return;
    }
    this.#client = client;
    if (!target.hostKeySha256 && hostKeySha256) onHostKey?.(hostKeySha256);
    client.on("close", () => this.#finish({ exitCode: 0 }));
    client.shell({ term: "xterm-256color", cols: this.#size.cols, rows: this.#size.rows }, (error, stream) => {
      if (error) {
        this.#emit(`\x1b[33mThe server refused a shell: ${error.message}\x1b[0m\r\n`);
        client.end();
        return;
      }
      this.#stream = stream;
      let exitCode = 0;
      let exitSignal: string | undefined;
      // Decoded as a stream so a character split across two packets arrives whole.
      stream.setEncoding("utf8");
      stream.stderr.setEncoding("utf8");
      stream.on("data", (chunk: string) => this.#emit(chunk));
      stream.stderr.on("data", (chunk: string) => this.#emit(chunk));
      stream.on("exit", (code: number | null, signal?: string) => {
        exitCode = code ?? 0;
        exitSignal = signal;
      });
      stream.on("close", () => {
        this.#finish({ exitCode, ...(exitSignal ? { signal: exitSignal } : {}) });
        client.end();
      });
      for (const chunk of this.#pending) stream.write(chunk);
      this.#pending = [];
    });
  }

  #emit(data: string): void {
    for (const listener of [...this.#data]) listener(data);
  }

  #finish(event: ExitEvent): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#pending = [];
    for (const listener of [...this.#exit]) listener(event);
  }
}
