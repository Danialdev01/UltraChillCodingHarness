import type { RuntimeId } from "@ucch/protocol";

import { createBunProvider } from "./bun.js";
import { createComposerProvider } from "./composer.js";
import { createDotnetProvider } from "./dotnet.js";
import { createNodeProvider } from "./node.js";
import { createPhpProvider } from "./php.js";
import { createRustProvider } from "./rust.js";
import type { RuntimeProvider } from "./types.js";

/**
 * Every runtime the server manages. `root` is `RUNTIMES_ROOT`: Rust keeps
 * rustup's own homes under it.
 */
export function createRuntimeProviders(root: string): Record<RuntimeId, RuntimeProvider> {
  return {
    php: createPhpProvider(),
    composer: createComposerProvider(),
    node: createNodeProvider(),
    bun: createBunProvider(),
    dotnet: createDotnetProvider(),
    rust: createRustProvider(root),
  };
}
