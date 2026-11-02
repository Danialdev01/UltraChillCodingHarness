import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The guard hook's source (`assets/omp-hooks/ucch-guard.ts`), which the
 * server copies into each subject's OMP directory.
 *
 * Read at runtime rather than imported: OMP loads it as a file of its own,
 * so it must stay a standalone module. From the sources it sits beside this
 * package; in the server bundle, `build.mjs` copies it next to
 * `server.mjs`, which is what `import.meta.url` is there.
 */
export function ompGuardHookSource(): string {
  const candidates = [
    new URL("../assets/omp-hooks/ucch-guard.ts", import.meta.url),
    new URL("./omp-hooks/ucch-guard.ts", import.meta.url),
  ];
  for (const url of candidates) {
    const path = fileURLToPath(url);
    if (existsSync(path)) return readFileSync(path, "utf8");
  }
  throw new Error("the OMP guard hook (ucch-guard.ts) is missing from this build");
}

/**
 * The OMP bridge's usage guide (`assets/omp-bridge-guide.md`, solution
 * §10.4): appended to a Claude Code or Codex turn's instructions when the
 * turn is offered the bridge. Found as the guard hook is: beside this
 * package from the sources, beside `server.mjs` in the bundle.
 */
export function ompBridgeGuide(): string {
  const candidates = [new URL("../assets/omp-bridge-guide.md", import.meta.url), new URL("./omp-bridge-guide.md", import.meta.url)];
  for (const url of candidates) {
    const path = fileURLToPath(url);
    if (existsSync(path)) return readFileSync(path, "utf8").trimEnd();
  }
  throw new Error("the OMP bridge guide (omp-bridge-guide.md) is missing from this build");
}
