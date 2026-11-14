import { z } from "zod";

/**
 * The workspace's Resources: shared files that belong to the whole team rather
 * than to one project -- images several projects use, the workspace's own
 * guidelines, backups.
 *
 * A workspace reads them from one or more *stores*. Its own disk storage is
 * always there, under the fixed id `WORKSPACE_STORE_ID`; S3 buckets (AWS, R2,
 * MinIO, anything that speaks the API) are added beside it. A file is named
 * by its store and its key: a `/`-separated path relative to the store's
 * root, never starting with `/`. A folder's key has no trailing slash.
 */

export const RESOURCE_STORE_KINDS = ["local", "s3"] as const;
export type ResourceStoreKind = (typeof RESOURCE_STORE_KINDS)[number];

/** A store as the panel lists it. Credentials never cross the wire. */
export interface ResourceStoreSummary {
  id: string;
  kind: ResourceStoreKind;
  name: string;
  /** For an S3 store, what it points at -- shown under its name, never the secret. */
  s3?: {
    endpoint: string | null;
    region: string;
    bucket: string;
    prefix: string;
    forcePathStyle: boolean;
    accessKeyId: string;
  };
}

/** One row of a folder listing. */
export interface ResourceEntry {
  /** The full key, relative to the store's root. */
  key: string;
  name: string;
  kind: "file" | "folder";
  /** Bytes, for a file. */
  size?: number;
  /** ISO date, when the store knows it. */
  modifiedAt?: string;
}

const S3Fields = {
  name: z.string().trim().min(1).max(80),
  /** Empty means AWS itself; anything else is an S3-compatible service. */
  endpoint: z.string().trim().max(512).url().or(z.literal("")).optional(),
  region: z.string().trim().min(1).max(64).default("us-east-1"),
  bucket: z.string().trim().min(3).max(63),
  /** A folder inside the bucket to treat as the store's root. */
  prefix: z.string().trim().max(512).optional(),
  /** Path-style addressing, which MinIO and most self-hosted services need. */
  forcePathStyle: z.boolean().default(false),
  accessKeyId: z.string().trim().min(1).max(256),
  secretAccessKey: z.string().min(1).max(512),
};

export const S3StoreCreate = z.object(S3Fields);
export type S3StoreCreate = z.infer<typeof S3StoreCreate>;

/** A change to a saved store. Leaving out the secret keeps the stored one. */
export const S3StoreUpdate = z.object(S3Fields).partial();
export type S3StoreUpdate = z.infer<typeof S3StoreUpdate>;

export const ResourceFolderCreate = z.object({ key: z.string().min(1).max(1024) });
export const ResourceMove = z.object({ from: z.string().min(1).max(1024), to: z.string().min(1).max(1024) });

/** Copying a resource into a project: into the chat's staging, or into its tree. */
export const ResourceCopy = z.object({
  workspaceId: z.string().uuid(),
  storeId: z.string().min(1).max(64),
  key: z.string().min(1).max(1024),
  /** For the tree: the folder to copy into, "" for the root. */
  dir: z.string().max(1024).optional(),
});
export type ResourceCopy = z.infer<typeof ResourceCopy>;

/** What a resource row carries while it is dragged, as `RESOURCE_DRAG_TYPE`. */
export const ResourceDragPayload = z.object({
  workspaceId: z.string().uuid(),
  storeId: z.string().min(1).max(64),
  key: z.string().min(1).max(1024),
  name: z.string().min(1),
  kind: z.enum(["file", "folder"]),
});
export type ResourceDragPayload = z.infer<typeof ResourceDragPayload>;

