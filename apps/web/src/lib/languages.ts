import { css } from "@codemirror/lang-css"
import { html } from "@codemirror/lang-html"
import { javascript } from "@codemirror/lang-javascript"
import { json } from "@codemirror/lang-json"
import { markdown } from "@codemirror/lang-markdown"
import { php } from "@codemirror/lang-php"
import type { LanguageSupport } from "@codemirror/language"

import { mermaid } from "@/lib/mermaid-language"

/**
 * The language mode for a path, or nothing for a file we have no grammar for.
 *
 * Highlighting is a side benefit of moving to CodeMirror rather than the
 * point of it, so an unknown extension renders as plain text instead of being
 * forced through a guess. Shared by the editor and the diff view so a file
 * is coloured the same way wherever it is shown.
 */
export function languageFor(path: string): LanguageSupport | null {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase()
  switch (ext) {
    case "ts":
    case "tsx":
      return javascript({ typescript: true, jsx: ext === "tsx" })
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return javascript({ jsx: ext === "jsx" })
    case "json":
      return json()
    case "md":
    case "mdx":
      return markdown()
    case "php":
      return php()
    case "html":
      return html()
    case "css":
      return css()
    case "mmd":
    case "mermaid":
      return mermaid()
    default:
      return null
  }
}
