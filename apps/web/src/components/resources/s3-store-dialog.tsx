"use client"

import * as React from "react"
import { CloudIcon, LockIcon } from "lucide-react"
import type { ResourceStoreSummary } from "@ucch/protocol"

import { FIELD, FormDialog, FormDialogFooter, FormField, HELPER } from "@/components/form-dialog"
import { Switch } from "@/components/ui/switch"
import { createS3Store, updateS3Store } from "@/lib/resources-api"

interface Draft {
  name: string
  endpoint: string
  region: string
  bucket: string
  prefix: string
  forcePathStyle: boolean
  accessKeyId: string
  secretAccessKey: string
}

function draftOf(store?: ResourceStoreSummary): Draft {
  return {
    name: store?.name ?? "",
    endpoint: store?.s3?.endpoint ?? "",
    region: store?.s3?.region ?? "us-east-1",
    bucket: store?.s3?.bucket ?? "",
    prefix: store?.s3?.prefix ?? "",
    forcePathStyle: store?.s3?.forcePathStyle ?? false,
    accessKeyId: store?.s3?.accessKeyId ?? "",
    secretAccessKey: "",
  }
}

/**
 * Adds an S3 bucket to the workspace's Resources, or changes one.
 *
 * Any S3-compatible service works: leave the endpoint empty for AWS, or give
 * R2's, MinIO's, Wasabi's. The server lists the bucket once before saving,
 * so a typo is caught here rather than when someone opens the folder. The
 * secret is never sent back, so editing leaves it blank to mean "keep it".
 */
export function S3StoreDialog({
  open,
  onOpenChange,
  workspaceId,
  store,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaceId: string
  /** The store being edited; absent to add one. */
  store?: ResourceStoreSummary
  onSaved: (store: ResourceStoreSummary) => void
}) {
  const [draft, setDraft] = React.useState<Draft>(() => draftOf(store))
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (open) {
      setDraft(draftOf(store))
      setError(null)
    }
  }, [open, store])

  const set = <K extends keyof Draft>(key: K) => (value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }))
  const text = (key: keyof Draft) => ({
    value: draft[key] as string,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => set(key)(e.target.value as never),
  })

  const editing = store !== undefined
  const ready =
    draft.name.trim() !== "" &&
    draft.bucket.trim() !== "" &&
    draft.accessKeyId.trim() !== "" &&
    (editing || draft.secretAccessKey !== "")

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!ready || pending) return
    setPending(true)
    setError(null)
    const input = {
      name: draft.name.trim(),
      endpoint: draft.endpoint.trim(),
      region: draft.region.trim() || "us-east-1",
      bucket: draft.bucket.trim(),
      prefix: draft.prefix.trim(),
      forcePathStyle: draft.forcePathStyle,
      accessKeyId: draft.accessKeyId.trim(),
      ...(draft.secretAccessKey ? { secretAccessKey: draft.secretAccessKey } : {}),
    }
    try {
      const saved = editing
        ? await updateS3Store(workspaceId, store.id, input)
        : await createS3Store(workspaceId, { ...input, secretAccessKey: draft.secretAccessKey })
      onSaved(saved)
      onOpenChange(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setPending(false)
    }
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      busy={pending}
      icon={CloudIcon}
      title={editing ? `Edit ${store.name}` : "Add S3 storage"}
      description="A bucket the whole workspace can keep shared files in. Works with AWS S3 and any S3-compatible service."
      onSubmit={submit}
      footer={
        <FormDialogFooter hint="Secret stored encrypted" hintIcon={LockIcon} busy={pending} disabled={!ready}>
          {pending ? "Testing…" : "Test and save"}
        </FormDialogFooter>
      }
    >
      <FormField label="Name" htmlFor="s3-name">
        <input id="s3-name" className={FIELD} placeholder="Design assets" autoFocus {...text("name")} />
      </FormField>
      <FormField label="Endpoint" htmlFor="s3-endpoint" helper="Empty for AWS. For R2, MinIO and others, their URL.">
        <input id="s3-endpoint" className={FIELD} placeholder="https://s3.example.com" {...text("endpoint")} />
      </FormField>
      <div className="grid grid-cols-2 gap-3">
        <FormField label="Bucket" htmlFor="s3-bucket">
          <input id="s3-bucket" className={FIELD} placeholder="team-files" {...text("bucket")} />
        </FormField>
        <FormField label="Region" htmlFor="s3-region">
          <input id="s3-region" className={FIELD} placeholder="us-east-1" {...text("region")} />
        </FormField>
      </div>
      <FormField label="Folder in the bucket" htmlFor="s3-prefix" helper="Optional. Only this folder is shown.">
        <input id="s3-prefix" className={FIELD} placeholder="ucch/" {...text("prefix")} />
      </FormField>
      <div className="grid grid-cols-2 gap-3">
        <FormField label="Access key ID" htmlFor="s3-key">
          <input id="s3-key" className={FIELD} autoComplete="off" {...text("accessKeyId")} />
        </FormField>
        <FormField label="Secret access key" htmlFor="s3-secret">
          <input
            id="s3-secret"
            type="password"
            className={FIELD}
            autoComplete="new-password"
            placeholder={editing ? "Unchanged" : ""}
            {...text("secretAccessKey")}
          />
        </FormField>
      </div>
      <label className="flex items-center justify-between gap-3">
        <span className="flex flex-col">
          <span className="text-[12.5px]">Path-style addressing</span>
          <span className={HELPER}>Needed by MinIO and most self-hosted services.</span>
        </span>
        <Switch checked={draft.forcePathStyle} onCheckedChange={(v: boolean) => set("forcePathStyle")(v)} />
      </label>
      {error && (
        <p role="alert" className="text-destructive text-[12px] leading-normal break-words">
          {error}
        </p>
      )}
    </FormDialog>
  )
}
