import { describe, expect, it } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { chatImageSource } from "./chat-image"
import { ChatImage, ChatImageHostProvider } from "../components/chat-image"

const target = { hash: "project123", session: "session456" }

describe("chat images", () => {
  it("loads workspace images through the authenticated route for the current session", () => {
    const image = chatImageSource(".ucch/generated-images/dog%20portrait.png", target)
    expect(image.path).toBe(".ucch/generated-images/dog portrait.png")
    const url = new URL(image.src, "https://app.test")
    expect(url.pathname).toBe("/api/projects/project123/file/raw")
    expect(url.searchParams.get("session")).toBe("session456")
    expect(url.searchParams.get("path")).toBe(image.path)
  })

  it("refuses traversal and malformed local image references", () => {
    for (const path of ["../private.png", "%2e%2e/private.png", "x/../private.png", "x\\..\\private.png", "%GG.png", "script.html"]) {
      expect(chatImageSource(path, target)).toEqual({ src: "", path: null })
    }
  })

  it("preserves external images and images outside chat", () => {
    expect(chatImageSource("https://images.test/dog.png", target)).toEqual({ src: "https://images.test/dog.png", path: null })
    expect(chatImageSource("dog.png")).toEqual({ src: "dog.png", path: null })
  })

  it("renders image bytes with Copy, Regenerate and Save actions in chat", () => {
    const html = renderToStaticMarkup(createElement(ChatImageHostProvider, { value: { target, send: async () => {} } }, createElement(ChatImage, { src: "dog.png", alt: "Dog" })))
    expect(html).toContain('data-testid="chat-image"')
    expect(html).toContain("session=session456")
    expect(html).toContain("Copy image")
    expect(html).toContain("Regenerate")
    expect(html).toContain("Save to workspace")
    expect(html).toContain('alt="Dog"')
  })
})
