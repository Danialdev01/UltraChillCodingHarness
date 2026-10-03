import { Mark, mergeAttributes, type JSONContent } from "@tiptap/core"

export const TEXT_COLORS = [
  "gray",
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
] as const
export type TextColor = (typeof TEXT_COLORS)[number]

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    textColor: {
      setTextColor: (color: TextColor) => ReturnType
      unsetTextColor: () => ReturnType
    }
  }
}

/**
 * Coloured text, from a named palette rather than any hex: the names map
 * to tokens that have a light and a dark value, so "red" reads as red on
 * both themes, and a page's colours stay the app's colours.
 *
 * In Markdown it is a `<span data-color>`; the parser puts that back
 * through `parseHTML`.
 */
export const TextColorMark = Mark.create({
  name: "textColor",

  addAttributes() {
    return {
      color: {
        default: null,
        parseHTML: (element) => {
          const value = element.getAttribute("data-color")
          return TEXT_COLORS.includes(value as TextColor) ? value : null
        },
        renderHTML: (attrs) => ({ "data-color": attrs.color }),
      },
    }
  },

  parseHTML() {
    return [{ tag: "span[data-color]" }]
  },

  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, { class: "ucch-text-color" }), 0]
  },

  renderMarkdown: (node: JSONContent, helpers) =>
    `<span data-color="${node.attrs?.color ?? ""}">${helpers.renderChildren(node)}</span>`,

  addCommands() {
    return {
      setTextColor:
        (color) =>
        ({ commands }) =>
          commands.setMark(this.name, { color }),
      unsetTextColor:
        () =>
        ({ commands }) =>
          commands.unsetMark(this.name),
    }
  },
})
