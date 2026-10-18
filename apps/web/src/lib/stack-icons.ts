/**
 * The Material icon for a project's detected stack.
 *
 * Keys are what `detectStack` in apps/server/src/clone.ts names a stack;
 * values are icon ids from `material-icon-theme`, served by `/file-icons`
 * with `kind=icon`. A stack with no entry -- `unknown` before the clone, or
 * a name this list has not caught up with -- gets no icon, and the row
 * falls back to a plain folder.
 */
const STACK_ICONS: Readonly<Record<string, string>> = {
  laravel: "laravel",
  nextjs: "next",
  nuxt: "nuxt",
  astro: "astro",
  svelte: "svelte",
  angular: "angular",
  react: "react",
  vue: "vue",
  vite: "vite",
  deno: "deno",
  bun: "bun",
  node: "nodejs",
  django: "django",
  python: "python",
  rust: "rust",
  go: "go",
  rails: "ruby",
  ruby: "ruby",
  kotlin: "kotlin",
  java: "java",
  dart: "dart",
  elixir: "elixir",
  swift: "swift",
  dotnet: "csharp",
  php: "php",
  static: "html",
}

export function stackIconName(stack: string | null | undefined): string | null {
  if (!stack) return null
  return Object.hasOwn(STACK_ICONS, stack) ? STACK_ICONS[stack]! : null
}
