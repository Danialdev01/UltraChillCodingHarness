"use client"

import * as React from "react"
import { CheckIcon, CopyIcon } from "lucide-react"
import ReactMarkdown, { type Components } from "react-markdown"
import remarkBreaks from "remark-breaks"
import remarkGfm from "remark-gfm"

import { copyText } from "@/lib/clipboard"
import { nodeLanguage, nodeText, type SyntaxNode } from "@/lib/code-text"
import { streamingCut } from "@/lib/streaming-markdown"

/**
 * Model prose, rendered as the Markdown it is written in.
 *
 * Everything a model writes is Markdown whether or not anything renders it,
 * so the choice was never "plain text or Markdown" -- it was whether the
 * reader sees `### Budget` and `| a | b |` or the document those describe.
 *
 * **Raw HTML is not rendered, deliberately.** `react-markdown` ignores it
 * unless `rehype-raw` is added, and it is not added here: this is text from a
 * language model, quoting web pages, files and tool output, and any of those
 * can carry a `<script>` or an `<img onerror>`. Markdown's own syntax is the
 * whole vocabulary, which is enough for a chat and has no way to inject
 * anything. Link URLs go through the default transform as well, so
 * `javascript:` never survives to an `href`.
 *
 * The styles are written out per element rather than pulled from a typography
 * plugin: every one of them has to sit in a chat bubble at 14px and agree
 * with the app's own colour tokens, which a generic prose stylesheet sized
 * for an article does not.
 */
const COMPONENTS: Components = {
  h1: ({ children }) => (
    <h1 className="mt-5 mb-2 border-b pb-1 text-lg font-semibold first:mt-0">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="mt-5 mb-2 border-b pb-1 text-base font-semibold first:mt-0">{children}</h2>
  ),
  h3: ({ children }) => <h3 className="mt-4 mb-1.5 text-sm font-semibold first:mt-0">{children}</h3>,
  h4: ({ children }) => (
    <h4 className="text-muted-foreground mt-3 mb-1 text-sm font-semibold first:mt-0">{children}</h4>
  ),
  h5: ({ children }) => (
    <h5 className="text-muted-foreground mt-3 mb-1 text-xs font-semibold first:mt-0">{children}</h5>
  ),
  h6: ({ children }) => (
    <h6 className="text-muted-foreground mt-3 mb-1 text-xs font-semibold first:mt-0">{children}</h6>
  ),

  p: ({ children }) => <p className="my-2 leading-relaxed first:mt-0 last:mb-0">{children}</p>,

  ul: ({ children }) => (
    <ul className="my-2 ml-5 list-disc space-y-1 first:mt-0 last:mb-0">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="my-2 ml-5 list-decimal space-y-1 first:mt-0 last:mb-0">{children}</ol>
  ),
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,

  a: ({ href, children }) => (
    <a
      href={href}
      // A link in model output points somewhere else by definition, and
      // `noreferrer` keeps this app's URL -- which names the project -- out
      // of the other site's logs.
      target="_blank"
      rel="noreferrer noopener"
      className="text-ucch-active underline underline-offset-2"
    >
      {children}
    </a>
  ),

  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  del: ({ children }) => <del className="text-muted-foreground">{children}</del>,

  hr: () => <hr className="border-border my-4" />,

  blockquote: ({ children }) => (
    <blockquote className="border-border text-muted-foreground my-2 border-l-2 pl-3">
      {children}
    </blockquote>
  ),

  /**
   * Inline code and fenced blocks arrive as the same element.
   *
   * A fenced block is a `<code>` inside a `<pre>`, and remark marks that with
   * a language class; anything without one is inline. Both are styled here
   * because `pre` below renders whatever this returns.
   */
  code: ({ className, children }) => {
    const fenced = /language-(\w+)/.exec(className ?? "")
    if (!fenced) {
      return (
        <code className="bg-muted rounded px-1 py-0.5 font-mono text-[0.85em]">{children}</code>
      )
    }
    return <code className="font-mono text-xs">{children}</code>
  },

  pre: ({ children, node }) => (
    <CodeBlock node={node as SyntaxNode | undefined}>{children}</CodeBlock>
  ),

  // GFM tables. The wrapper is what scrolls, so a wide table stays inside the
  // message rather than widening the column it sits in.
  table: ({ children }) => (
    <div className="my-2 w-full overflow-x-auto">
      <table className="w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="border-b">{children}</thead>,
  th: ({ children }) => (
    <th className="text-muted-foreground px-2 py-1 text-left font-medium whitespace-nowrap">
      {children}
    </th>
  ),
  td: ({ children }) => <td className="border-t px-2 py-1 align-top">{children}</td>,

  // GFM task lists: the boxes are a record of what the model planned, not a
  // control, so they stay disabled rather than pretending to be clickable.
  input: ({ checked, type }) =>
    type === "checkbox" ? (
      <input type="checkbox" checked={checked} readOnly className="mr-1.5 align-middle" />
    ) : null,

  img: ({ src, alt }) => (
    // eslint-disable-next-line @next/next/no-img-element -- an arbitrary URL
    // from model output, which next/image would try to proxy and optimise.
    <img src={typeof src === "string" ? src : undefined} alt={alt ?? ""} className="my-2 max-w-full rounded" />
  ),
}

/**
 * A fenced block, with its language and a way to take it away.
 *
 * The button copies the source read off the syntax tree rather than anything
 * scraped from the DOM -- see `code-text.ts` -- so what lands on the
 * clipboard is exactly what was between the fences, including the trailing
 * newline and any leading whitespace the reader would otherwise have to
 * repair by hand.
 */
function CodeBlock({ children, node }: { children: React.ReactNode; node?: SyntaxNode }) {
  const [copied, setCopied] = React.useState(false)
  const [failed, setFailed] = React.useState(false)

  const language = nodeLanguage(node)
  const source = nodeText(node)

  React.useEffect(() => {
    if (!copied && !failed) return
    const timer = setTimeout(() => {
      setCopied(false)
      setFailed(false)
    }, 2000)
    return () => clearTimeout(timer)
  }, [copied, failed])

  return (
    <div className="group/code bg-muted/60 my-2 overflow-hidden rounded-md border">
      {/* A header bar rather than a button floating over the code: it cannot
          cover the first line, and it gives the language somewhere to sit. */}
      <div className="text-muted-foreground flex h-7 items-center gap-2 border-b px-2 text-[10px]">
        <span className="font-mono">{language ?? "text"}</span>
        <button
          type="button"
          onClick={() => {
            void copyText(source).then((ok) => (ok ? setCopied(true) : setFailed(true)))
          }}
          // Visible on a touch screen, where there is no hover to reveal it,
          // and on keyboard focus. Fades in with the block on a pointer.
          className="hover:text-foreground focus-visible:ring-ring ml-auto flex items-center gap-1 rounded px-1 py-0.5 opacity-100 outline-none focus-visible:ring-1 sm:opacity-0 sm:group-hover/code:opacity-100 sm:focus-visible:opacity-100"
        >
          {copied ? (
            <CheckIcon className="text-ucch-active size-3" />
          ) : (
            <CopyIcon className="size-3" />
          )}
          {copied ? "Copied" : failed ? "Blocked" : "Copy"}
        </button>
      </div>

      {/* Scrolls inside itself: a long line of code must not make the whole
          conversation scroll sideways. */}
      <pre className="max-h-64 overflow-auto p-3 text-xs @md:max-h-96">{children}</pre>
    </div>
  )
}

/**
 * Memoised on the text alone.
 *
 * Prose arrives a delta at a time and the whole message is reparsed on each
 * one; without this, every other message in the thread would reparse too,
 * every time any of them grew.
 */
export const Markdown = React.memo(function Markdown({
  children,
  className,
}: {
  children: string
  className?: string
}) {
  return (
    <div className={`text-sm break-words${className ? ` ${className}` : ""}`}>
      {/* GFM for tables, task lists and strikethrough, which models write
          constantly. Breaks because this is a chat: Markdown proper folds a
          single newline into a space, and a model laying out an address or a
          short list without blank lines between the items means those lines
          to stay where it put them. */}
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={COMPONENTS}>
        {children}
      </ReactMarkdown>
    </div>
  )
})

/**
 * An answer still being written.
 *
 * `Markdown` parses its whole text, and an answer streaming in would be
 * parsed again, from the top, on every update: a long one costs more with
 * each token. Here it is cut where a finished block ends (`streamingCut`):
 * the part before goes through the memoised `Markdown` and is parsed again
 * only when the cut moves on, and only the tail is parsed each time. Once
 * the answer is done the message draws it with `Markdown` whole, as ever.
 */
export function StreamingMarkdown({ children, className }: { children: string; className?: string }) {
  const cut = streamingCut(children)
  // The same two children from the first token, so the tail is never
  // mounted afresh when the first cut appears; an empty prefix draws nothing.
  return (
    <div>
      <Markdown>{children.slice(0, cut)}</Markdown>
      <Markdown className={className}>{children.slice(cut)}</Markdown>
    </div>
  )
}
