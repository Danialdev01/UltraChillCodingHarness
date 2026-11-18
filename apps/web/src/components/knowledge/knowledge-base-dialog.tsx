"use client"

import * as React from "react"
import { useQueryClient } from "@tanstack/react-query"
import { LibraryBigIcon, PencilIcon } from "lucide-react"
import type { KnowledgeBaseSummary } from "@ucch/protocol"

import { FIELD, FormDialog, FormDialogFooter, FormField, Optional, TEXTAREA } from "@/components/form-dialog"
import { createKnowledgeBase, knowledgeKeys, updateKnowledgeBase } from "@/lib/knowledge-api"
import { useTransitionRouter } from "@/lib/view-transitions"
import { knowledgeBaseHref } from "@/lib/sections"
import { useWorkspaceHash } from "@/lib/workspace-context"

/**
 * Creates a knowledge base, or renames one when `base` is given. A new base
 * opens straight away, on its Documents tab, since adding documents is the
 * only thing to do with an empty one.
 */
export function KnowledgeBaseDialog({
  workspaceId,
  base,
  open,
  onOpenChange,
}: {
  workspaceId: string
  base?: KnowledgeBaseSummary
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const router = useTransitionRouter()
  const ws = useWorkspaceHash()
  const [name, setName] = React.useState(base?.name ?? "")
  const [description, setDescription] = React.useState(base?.description ?? "")
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!open) return
    setName(base?.name ?? "")
    setDescription(base?.description ?? "")
    setError(null)
  }, [open, base])

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!name.trim()) return
    setBusy(true)
    setError(null)
    try {
      const saved = base
        ? await updateKnowledgeBase(workspaceId, base.id, { name: name.trim(), description: description.trim() })
        : await createKnowledgeBase(workspaceId, { name: name.trim(), description: description.trim() || undefined })
      queryClient.setQueryData(knowledgeKeys.base(workspaceId, saved.id), saved)
      await queryClient.invalidateQueries({ queryKey: knowledgeKeys.bases(workspaceId) })
      onOpenChange(false)
      if (!base) router.push(knowledgeBaseHref(ws, saved.id))
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not save the knowledge base.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      busy={busy}
      icon={base ? PencilIcon : LibraryBigIcon}
      title={base ? `Edit ${base.name}` : "New knowledge base"}
      description={
        base
          ? "Rename it, or change what it says it holds."
          : "A folder of documents. Each one is read, searched, and added to the base's knowledge graph."
      }
      onSubmit={submit}
      footer={
        <FormDialogFooter busy={busy} disabled={!name.trim()}>
          {base ? "Save" : "Create"}
        </FormDialogFooter>
      }
    >
      <FormField label="Name" htmlFor="kb-name" error={error}>
        <input
          id="kb-name"
          autoFocus
          value={name}
          maxLength={120}
          onChange={(e) => setName(e.target.value)}
          placeholder="Product handbook"
          className={FIELD}
        />
      </FormField>
      <FormField
        label={
          <>
            Description
            <Optional />
          </>
        }
        htmlFor="kb-description"
        helper="Shown to the agent beside the base's name, so say what it is for."
      >
        <textarea
          id="kb-description"
          value={description}
          maxLength={2_000}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Policies, pricing and support answers for the 2026 product line."
          className={TEXTAREA}
        />
      </FormField>
    </FormDialog>
  )
}
