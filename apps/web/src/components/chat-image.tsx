"use client"

import * as React from "react"
import { CopyIcon, DownloadIcon, FolderIcon, RefreshCwIcon } from "lucide-react"
import { chatImageSource } from "@/lib/chat-image"
import type { ProjectTarget } from "@/lib/project-target"

interface ChatImageHost {
  target?: ProjectTarget
  busy?: boolean
  send?: (text: string) => Promise<void>
}

const Context = React.createContext<ChatImageHost>({})
export const ChatImageHostProvider = Context.Provider

/** A local image uses the same session permissions as the file browser. */
export function ChatImage({ src, alt }: { src: string; alt: string }) {
  const host = React.useContext(Context)
  const source = chatImageSource(src, host.target)
  const [status, setStatus] = React.useState("")
  const [pending, setPending] = React.useState(false)
  const [failed, setFailed] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [destination, setDestination] = React.useState(`generated-images/image${source.path?.match(/\.[a-z0-9]+$/i)?.[0] ?? ".png"}`)
  const buttonClass = "hover:bg-muted inline-flex items-center gap-1 rounded px-2 py-1 text-xs disabled:opacity-50"
  const disabled = pending || host.busy

  React.useEffect(() => { setFailed(false); setStatus("") }, [source.src])

  async function request(text: string) {
    if (!host.send || disabled) return
    setPending(true)
    setStatus("")
    try { await host.send(text); setSaving(false) }
    catch { setStatus("Could not send the request. Please try again.") }
    finally { setPending(false) }
  }

  async function copy() {
    setStatus("")
    try {
      if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") throw new Error("unavailable")
      // Start the clipboard write in the click's activation; PNG is supported across browsers.
      const png = (async () => {
        const response = await fetch(source.src)
        if (!response.ok) throw new Error("Image could not be loaded")
        const blob = await response.blob()
        if (blob.type === "image/png") return blob
        const bitmap = await createImageBitmap(blob)
        try {
          const canvas = document.createElement("canvas")
          canvas.width = bitmap.width
          canvas.height = bitmap.height
          const context = canvas.getContext("2d")
          if (!context) throw new Error("Image could not be copied")
          context.drawImage(bitmap, 0, 0)
          return await new Promise<Blob>((resolve, reject) => canvas.toBlob((result) => result ? resolve(result) : reject(new Error("Image could not be copied")), "image/png"))
        } finally { bitmap.close() }
      })()
      await navigator.clipboard.write([new ClipboardItem({ "image/png": png })])
      setStatus("Image copied")
    } catch { setStatus("Could not copy the image. Use HTTPS or localhost and allow clipboard access, or download it.") }
  }

  if (!source.path) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={source.src || undefined} alt={alt} className="my-2 max-w-full rounded" />
  }

  return (
    <span className="my-2 inline-flex w-full max-w-xl flex-col gap-2 rounded-lg border p-2" data-testid="chat-image">
      {failed ? <span role="alert" className="text-muted-foreground p-3 text-sm">This image could not be loaded. You can ask to regenerate it.</span> : (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={source.src} alt={alt || "Generated image"} onError={() => setFailed(true)} className="max-h-[36rem] w-full rounded object-contain" />
      )}
      <span className="flex flex-wrap items-center gap-1">
        <button type="button" onClick={() => void copy()} disabled={failed} className={buttonClass}><CopyIcon className="size-3.5" />Copy image</button>
        <a href={source.src} download={source.path.split("/").at(-1)} className={buttonClass}><DownloadIcon className="size-3.5" />Download</a>
        {host.send && <>
          <button type="button" disabled={disabled} onClick={() => void request(`Generate a new version of the image at ${JSON.stringify(source.path)} using the original image request in this conversation${alt ? ` (${alt})` : ""}. Create a new image, preserve the previous version, and display the result in this chat.`)} className={buttonClass}><RefreshCwIcon className="size-3.5" />Regenerate</button>
          <button type="button" disabled={disabled} onClick={() => setSaving(!saving)} className={buttonClass}><FolderIcon className="size-3.5" />Save to workspace</button>
        </>}
      </span>
      {saving && <span className="flex items-center gap-2">
        <input aria-label="Save image to workspace path" value={destination} onChange={(event) => setDestination(event.target.value)} className="min-w-0 flex-1 rounded border bg-transparent px-2 py-1 text-xs" />
        <button type="button" disabled={disabled || !destination.trim()} onClick={() => void request(`Copy the existing image at ${JSON.stringify(source.path)} to ${JSON.stringify(destination.trim())} inside this session's working directory. Do not generate another image. Do not overwrite an existing file; choose a unique filename if necessary. Confirm the saved relative path.`)} className={buttonClass}>Save</button>
      </span>}
      {status && <span role="status" className="text-muted-foreground text-xs">{status}</span>}
    </span>
  )
}
