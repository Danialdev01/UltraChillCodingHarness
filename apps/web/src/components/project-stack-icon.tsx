"use client"

import { FolderIcon } from "lucide-react"

import { FileTypeIcon } from "@/components/file-type-icon"
import { stackIconName } from "@/lib/stack-icons"

/**
 * A project's framework or language, as the icon in front of its name. A
 * project whose stack is not known yet -- still cloning, or nothing the
 * detector recognises -- shows a plain folder.
 */
export function ProjectStackIcon({ stack }: { stack: string | null | undefined }) {
  const icon = stackIconName(stack)
  if (!icon) return <FolderIcon aria-hidden />
  return <FileTypeIcon kind="icon" name={icon} />
}
