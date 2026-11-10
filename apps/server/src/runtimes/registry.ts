import type { RuntimeId } from "@ucch/protocol";

import { createPhpProvider } from "./php.js";
import type { RuntimeProvider } from "./types.js";

/**
 * Every runtime the server manages. A new one -- node from nodejs.org's
 * tarballs, dotnet through `dotnet-install.sh --install-dir`, rust through
 * rustup with RUSTUP_HOME and CARGO_HOME under the runtimes root -- is a
 * provider here and an id in `RUNTIME_IDS`; nothing else changes.
 */
export function createRuntimeProviders(): Record<RuntimeId, RuntimeProvider> {
  return { php: createPhpProvider() };
}
