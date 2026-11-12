import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // The web app's `@/` import root, for its client modules under test.
  resolve: { alias: { "@/": fileURLToPath(new URL("./apps/web/src/", import.meta.url)) } },
  // The web app's components use the automatic JSX runtime, as Next builds them.
  esbuild: { jsx: "automatic" },
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts", "tests/**/*.test.ts"],
    environment: "node",
  },
});
