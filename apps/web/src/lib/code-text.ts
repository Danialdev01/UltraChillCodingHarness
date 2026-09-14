/**
 * Reading a fenced code block back out of the parsed Markdown.
 *
 * The copy button has to put the *source* on the clipboard -- exactly what
 * was between the fences, whitespace and all -- and the rendered React tree
 * is the wrong place to look for it: by the time a component sees its
 * children they have been through the renderer's own overrides, which is
 * where the language class is dropped and where syntax highlighting would
 * later split one string into a hundred coloured spans.
 *
 * The syntax tree does not have that problem. `react-markdown` hands every
 * component the hast node it came from, and these two functions read it
 * directly. Typed structurally rather than against hast so the logic can be
 * tested with plain objects.
 */

export interface SyntaxNode {
  type?: string;
  /** Set on text nodes; the characters themselves. */
  value?: string;
  tagName?: string;
  properties?: { className?: unknown } | null;
  children?: SyntaxNode[] | null;
}

/**
 * Every character under a node, in order.
 *
 * Depth-first and concatenated with nothing between: a code block is one run
 * of text, and anything inserted between nodes would be a character the file
 * does not contain.
 */
export function nodeText(node: SyntaxNode | null | undefined): string {
  if (!node) return "";
  if (typeof node.value === "string") return node.value;
  if (!node.children) return "";
  return node.children.map(nodeText).join("");
}

/**
 * The language a fence declared, or null.
 *
 * remark writes it as a `language-*` class on the `code` element inside the
 * `pre`, which is the only place it survives; an unfenced or unlabelled
 * block simply has none, and the header shows nothing rather than guessing.
 */
export function nodeLanguage(node: SyntaxNode | null | undefined): string | null {
  const code = node?.children?.find(
    (child) => child.type === "element" && child.tagName === "code",
  );

  const className = code?.properties?.className;
  // hast normalises `class` to an array, but a single string is what turns
  // up when the tree was built by hand or by another plugin.
  const classes = Array.isArray(className)
    ? className.map(String)
    : typeof className === "string"
      ? className.split(/\s+/)
      : [];

  for (const name of classes) {
    const match = /^language-(.+)$/.exec(name);
    if (match) return match[1]!.toLowerCase();
  }
  return null;
}
